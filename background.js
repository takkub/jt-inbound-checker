'use strict';

const ACTIVE_SCAN_KEY = 'jtInbound.activeScan';

// Restore badge on service worker restart (badge is cleared when SW wakes cold)
chrome.storage.local.get({ [ACTIVE_SCAN_KEY]: null }, ({ [ACTIVE_SCAN_KEY]: saved }) => {
  if (!saved?.running || !Array.isArray(saved.queue) || !saved.queue.length) return;
  const done = Object.values(saved.results || {}).filter(r => r.status && r.status !== 'scanning').length;
  const total = saved.queue.length;
  chrome.action.setBadgeText({ text: `${done}/${total}` });
  chrome.action.setBadgeBackgroundColor({ color: '#1565c0' });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'set-badge') {
    chrome.action.setBadgeText({ text: msg.text || '' });
    if (msg.text) chrome.action.setBadgeBackgroundColor({ color: msg.color || '#1565c0' });
    return;
  }
  if (msg.type !== 'start-pdf-decode') return;
  handleDecode(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handleDecode(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: 'offscreen-decode', pdfBase64: msg.pdfBase64 });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Render PDF pages on canvas and decode barcodes/QR codes locally',
  });
}
