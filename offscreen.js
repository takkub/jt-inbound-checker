import { getDocument, GlobalWorkerOptions } from './vendor/pdf.min.mjs';

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

const {
  MultiFormatReader, BinaryBitmap, HybridBinarizer,
  HTMLCanvasElementLuminanceSource, DecodeHintType, BarcodeFormat,
} = globalThis.ZXing;

const FORMATS = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC,
];

const fastHints = new Map();
fastHints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
const fastReader = new MultiFormatReader();
fastReader.setHints(fastHints);

const hardHints = new Map();
hardHints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
hardHints.set(DecodeHintType.TRY_HARDER, true);
const hardReader = new MultiFormatReader();
hardReader.setHints(hardHints);

const PAGE_TIMEOUT_MS = 15_000;

const canvas = document.getElementById('decode-canvas');
const ctx = canvas.getContext('2d');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-decode') return;
  processPDF(msg.pdfBase64)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// Extract waybill from a page's text-layer tokens.
// J&T labels repeat the waybill code ~6 times for the barcode text elements.
// This is format-agnostic: works for JTTH*, 79*, or any future prefix.
function extractWaybillFromText(tokens) {
  const counts = {};
  for (const t of tokens) {
    const s = t.trim();
    if (!/^[A-Z0-9]{10,}$/i.test(s)) continue; // alnum only, ≥10 chars
    counts[s] = (counts[s] || 0) + 1;
  }
  // Waybill appears ≥6 times; Order IDs appear once; SKUs are short → safe floor = 4
  const candidates = Object.entries(counts).filter(([, n]) => n >= 4);
  if (!candidates.length) return null;
  // Highest count wins; tie → longer string
  candidates.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return candidates[0][0];
}

async function processPDF(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const pdf = await getDocument({ data: bytes }).promise;
  const codes = new Set();
  const failedPages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const code = await decodePageWithTimeout(pdf, p);
    if (code) {
      codes.add(code);
    } else {
      failedPages.push(p);
    }

    chrome.runtime.sendMessage({
      type: 'decode-progress',
      page: p,
      total: pdf.numPages,
      codesCount: codes.size,
    }).catch(() => {});
  }

  return { codes: [...codes], totalPages: pdf.numPages, failedPages, conflicts: [] };
}

async function decodePageWithTimeout(pdf, pageNum) {
  let cancelFn = null;

  const decodePromise = (async () => {
    const page = await pdf.getPage(pageNum);

    // Primary: text layer (fast, format-agnostic)
    const textContent = await page.getTextContent();
    const tokens = textContent.items.map(i => i.str);
    const fromText = extractWaybillFromText(tokens);
    if (fromText) return fromText;

    // Fallback: barcode decode (ZXing, 2-pass)
    const viewport25 = page.getViewport({ scale: 2.5 });
    canvas.width = viewport25.width;
    canvas.height = viewport25.height;
    const render1 = page.render({ canvasContext: ctx, viewport: viewport25 });
    if (!cancelFn) cancelFn = () => render1.cancel();
    try { await render1.promise; } catch { return null; }
    cancelFn = null;

    const fast = tryZXing(fastReader, false);
    if (fast) return fast;

    const viewport4 = page.getViewport({ scale: 4 });
    canvas.width = viewport4.width;
    canvas.height = viewport4.height;
    const render2 = page.render({ canvasContext: ctx, viewport: viewport4 });
    cancelFn = () => render2.cancel();
    try { await render2.promise; } catch { return null; }
    cancelFn = null;

    return tryZXing(hardReader, true);
  })();

  const timeoutPromise = new Promise(resolve => setTimeout(() => {
    if (cancelFn) cancelFn();
    resolve(null);
  }, PAGE_TIMEOUT_MS));

  return Promise.race([decodePromise, timeoutPromise]);
}

function tryZXing(reader, grayscale) {
  if (grayscale) {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(imgData, 0, 0);
  }
  try {
    const luminance = new HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new BinaryBitmap(new HybridBinarizer(luminance));
    return reader.decode(bitmap).getText();
  } catch {
    return null;
  }
}
