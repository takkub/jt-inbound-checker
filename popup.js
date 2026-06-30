'use strict';

const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/takkub/jt-inbound-checker/main/version.json';

// --- State ---
let port = null;
let currentTabId = null;
let scanQueue = [];
let scanResults = {};
let running = false;

const ACTIVE_SCAN_KEY = 'jtInbound.activeScan';

// --- DOM ---
const $waybills      = document.getElementById('waybills');
const $btnStart      = document.getElementById('btn-start');
const $btnStop       = document.getElementById('btn-stop');
const $btnRetry      = document.getElementById('btn-retry');
const $delayInput    = document.getElementById('delay-ms');
const $retryRounds   = document.getElementById('retry-rounds');
const $progressTxt   = document.getElementById('progress-text');
const $progressBar   = document.getElementById('progress-bar');
const $resultsBody   = document.getElementById('results-body');
const $historyBody   = document.getElementById('history-body');
const $search        = document.getElementById('search');
const $historyEmpty  = document.getElementById('history-empty');
const $notJt             = document.getElementById('not-jt');
const $scanUi            = document.getElementById('scan-ui');
const $activeScanBanner  = document.getElementById('active-scan-banner');
const $activeScanInfo    = document.getElementById('active-scan-info');
const $btnGotoJt         = document.getElementById('btn-goto-jt');

// --- Settings persistence ---
const STORAGE_SETTINGS = 'jtInbound.settings';

function getSettings() {
  return {
    delayMs: Math.max(100, parseInt($delayInput.value, 10) || 1000),
    retryRounds: Math.max(0, parseInt($retryRounds.value, 10) || 2),
  };
}

function saveSettings() {
  chrome.storage.local.set({ [STORAGE_SETTINGS]: getSettings() });
}

function loadSettings() {
  chrome.storage.local.get({ [STORAGE_SETTINGS]: { delayMs: 1000, retryRounds: 2 } }, ({ [STORAGE_SETTINGS]: s }) => {
    $delayInput.value = s.delayMs;
    $retryRounds.value = s.retryRounds;
  });
}

$delayInput.addEventListener('change', saveSettings);
$retryRounds.addEventListener('change', saveSettings);

// --- Tabs ---
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = true; });
    btn.classList.add('active');
    const panel = document.getElementById(btn.dataset.tab);
    panel.hidden = false;
    if (btn.dataset.tab === 'history') loadHistory();
  });
});

// --- Connect to content script ---
function connectToContent(tabId, canInject) {
  try {
    port = chrome.tabs.connect(tabId, { name: 'jt-inbound' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      // Must read lastError here to prevent "Unchecked runtime.lastError" warning
      const lastErr = chrome.runtime.lastError;
      port = null;
      setRunning(false);
      if (lastErr && canInject) {
        // Content script not present on this tab — inject then reconnect once
        injectAndConnect(tabId);
      }
    });
  } catch {
    $notJt.hidden = false;
    $scanUi.hidden = true;
  }
}

async function injectAndConnect(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['interceptor.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    connectToContent(tabId, false); // no further injection on second failure
  } catch {
    $notJt.hidden = false;
    $scanUi.hidden = true;
  }
}

async function init() {
  loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('home.jtexpress.co.th')) {
    $notJt.hidden = false;
    $scanUi.hidden = true;
    checkActiveScan();
    return;
  }
  currentTabId = tab.id;
  $notJt.hidden = true;
  $scanUi.hidden = false;
  connectToContent(tab.id, true);
}

// Show banner when active tab is not J&T but a scan is running in another tab
function checkActiveScan() {
  chrome.storage.local.get({ [ACTIVE_SCAN_KEY]: null }, ({ [ACTIVE_SCAN_KEY]: saved }) => {
    if (!saved?.running || !Array.isArray(saved.queue) || !saved.queue.length || !saved.tabId) return;
    chrome.tabs.get(saved.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url?.includes('home.jtexpress.co.th')) {
        // Tab gone or no longer on J&T — clear stale state
        chrome.storage.local.remove(ACTIVE_SCAN_KEY);
        chrome.runtime.sendMessage({ type: 'set-badge', text: '' }).catch(() => {});
        return;
      }
      const done = Object.values(saved.results || {}).filter(r => r.status && r.status !== 'scanning').length;
      const total = saved.queue.length;
      $activeScanInfo.textContent = `มี scan ทำงานอยู่ที่แท็บ J&T (${done}/${total})`;
      $activeScanBanner.hidden = false;
      $btnGotoJt.addEventListener('click', () => {
        chrome.tabs.update(saved.tabId, { active: true });
        window.close();
      });
    });
  });
}

// --- Message handler ---
function onMessage(msg) {
  if (msg.type === 'state') {
    // Restore state when popup reopens mid-scan
    scanQueue = msg.queue || [];
    scanResults = msg.results || {};
    setRunning(msg.running);
    renderResults();
    if (msg.running) $progressTxt.textContent = 'กำลังสแกน...';

  } else if (msg.type === 'progress') {
    if (msg.status === 'scanning') {
      if (!scanResults[msg.waybill]) scanResults[msg.waybill] = { status: 'scanning' };
    } else {
      scanResults[msg.waybill] = { status: msg.status, msg: msg.msg };
    }
    renderResults();
    updateProgress(msg.i + 1, msg.total);

  } else if (msg.type === 'retrying') {
    $progressTxt.textContent = `↺ Retry ${msg.round}/${msg.totalRounds} — ${msg.count} รายการ`;

  } else if (msg.type === 'done') {
    scanResults = msg.results || scanResults;
    renderResults();
    setRunning(false);
    const total = Object.keys(scanResults).length;
    const failed = Object.values(scanResults).filter(r => r.status !== 'pass').length;
    $progressTxt.textContent = `เสร็จ ${total} รายการ${failed ? ` (ไม่ผ่าน ${failed})` : ' ✓'}`;

  } else if (msg.type === 'error') {
    $progressTxt.textContent = '⚠ ' + msg.msg;
    setRunning(false);
  }
}

function setRunning(r) {
  running = r;
  $btnStart.disabled = r;
  $btnStop.disabled = !r;
  updateRetryButton();
}

function updateProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $progressBar.style.width = pct + '%';
  $progressTxt.textContent = `${done}/${total} (${pct}%)`;
}

function updateRetryButton() {
  const hasFails = Object.values(scanResults).some(
    r => r.status !== 'pass' && r.status !== 'pending' && r.status !== 'scanning'
  );
  $btnRetry.disabled = running || !hasFails;
}

const STATUS_LABEL = {
  pass: '✓ ผ่าน',
  fail: '✗ ไม่ผ่าน',
  scanning: '⟳ กำลังเช็ค',
  timeout: '⚠ Timeout',
  pending: '— รอ',
};

function renderResults() {
  $resultsBody.innerHTML = '';
  for (const waybill of scanQueue) {
    const r = scanResults[waybill];
    const status = r?.status || 'pending';
    const tr = document.createElement('tr');
    tr.className = status;
    tr.innerHTML = `<td>${waybill}</td><td>${STATUS_LABEL[status] || status}</td><td>${r?.msg || ''}</td>`;
    $resultsBody.appendChild(tr);
  }
  updateRetryButton();
}

// --- Start / Stop / Retry ---
$btnStart.addEventListener('click', () => {
  if (!port) return;
  const queue = [...new Set(
    $waybills.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
  )];
  if (!queue.length) return;

  const { delayMs, retryRounds } = getSettings();
  scanQueue = queue;
  scanResults = {};
  renderResults();
  $progressBar.style.width = '0%';
  $progressTxt.textContent = '';
  port.postMessage({ type: 'start', queue, delayMs, retryRounds, tabId: currentTabId });
  setRunning(true);
});

$btnStop.addEventListener('click', () => {
  if (port) port.postMessage({ type: 'stop' });
  setRunning(false);
  $progressTxt.textContent = 'หยุดแล้ว';
});

$btnRetry.addEventListener('click', () => {
  if (!port || running) return;
  const { delayMs, retryRounds } = getSettings();
  port.postMessage({ type: 'retry-failed', delayMs, retryRounds });
  setRunning(true);
  $progressTxt.textContent = 'เริ่ม retry...';
});

// --- History tab ---
function loadHistory(filter = '') {
  chrome.storage.local.get({ 'jtInbound.failures': [] }, ({ 'jtInbound.failures': arr }) => {
    const rows = filter
      ? arr.filter(f => f.wayBillCode.includes(filter))
      : arr;

    $historyBody.innerHTML = '';
    $historyEmpty.hidden = rows.length > 0;

    // Show newest first
    [...rows].reverse().forEach(({ wayBillCode, msg, ts }) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${wayBillCode}</td><td>${msg}</td><td>${new Date(ts).toLocaleString('th-TH')}</td>`;
      $historyBody.appendChild(tr);
    });
  });
}

$search.addEventListener('input', () => loadHistory($search.value.trim()));

document.getElementById('btn-export').addEventListener('click', () => {
  chrome.storage.local.get({ 'jtInbound.failures': [] }, ({ 'jtInbound.failures': arr }) => {
    const rows = ['wayBillCode,msg,ts', ...arr.map(f =>
      `${f.wayBillCode},"${(f.msg || '').replace(/"/g, '""')}",${new Date(f.ts).toISOString()}`
    )];
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,﻿' + encodeURIComponent(rows.join('\n'));
    a.download = `jt-failures-${Date.now()}.csv`;
    a.click();
  });
});

document.getElementById('btn-clear').addEventListener('click', () => {
  // eslint-disable-next-line no-alert
  if (!confirm('ลบข้อมูล failure ทั้งหมดออกจาก History?')) return;
  chrome.storage.local.remove('jtInbound.failures', () => loadHistory());
});

// --- PDF upload → decode barcode/QR ---
const $btnPdf   = document.getElementById('btn-pdf');
const $pdfInput = document.getElementById('pdf-input');
const $pdfStatus = document.getElementById('pdf-status');

// Receive per-page progress streamed from offscreen document during decode
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'decode-progress' && $btnPdf.disabled) {
    $pdfStatus.textContent = `อ่านหน้า ${msg.page}/${msg.total} · เจอ ${msg.codesCount} เลข`;
  }
});

$btnPdf.addEventListener('click', () => $pdfInput.click());
$pdfInput.addEventListener('change', () => {
  if ($pdfInput.files.length) handlePDFFiles($pdfInput.files);
});

async function handlePDFFiles(files) {
  $btnPdf.disabled = true;
  $pdfStatus.style.color = '#555';
  $pdfStatus.textContent = `กำลังประมวลผล ${files.length} ไฟล์...`;

  const allCodes = new Set();
  const fileResults = [];

  for (const file of files) {
    $pdfStatus.textContent = `กำลังอ่าน: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    try {
      const b64 = await fileToBase64(file);
      const result = await chrome.runtime.sendMessage({ type: 'start-pdf-decode', pdfBase64: b64 });
      if (!result || !result.ok) throw new Error(result?.error || 'decode failed');

      const newCodes = result.codes.filter(c => !allCodes.has(c));
      result.codes.forEach(c => allCodes.add(c));

      fileResults.push({
        name: file.name,
        count: result.codes.length,
        newCount: newCodes.length,
        totalPages: result.totalPages,
        failedPages: result.failedPages || [],
        conflicts: result.conflicts || [],
      });
    } catch (e) {
      fileResults.push({ name: file.name, error: e.message });
    }
  }

  // Merge into textarea (dedup with already-existing entries)
  const existing = new Set($waybills.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean));
  const fresh = [...allCodes].filter(c => !existing.has(c));
  if (fresh.length) {
    $waybills.value = [...existing, ...fresh].join('\n');
  }

  // Collect all problem page numbers across files for the warning banner
  const problemPageNums = [];
  for (const r of fileResults) {
    if (r.error) continue;
    r.failedPages.forEach(p => problemPageNums.push(String(p)));
    r.conflicts.forEach(c => problemPageNums.push(`${c.page}(ขัดแย้ง)`));
  }

  // Build per-file status summary
  const perFile = fileResults.map(r => {
    if (r.error) return `${r.name}: Error — ${r.error}`;
    const issues = [
      ...(r.failedPages.length ? [`อ่านไม่ออก ${r.failedPages.length} หน้า`] : []),
      ...(r.conflicts.length ? [`ขัดแย้ง ${r.conflicts.length} หน้า`] : []),
    ];
    const issueNote = issues.length ? ` | ⚠ ${issues.join(', ')}` : '';
    return `${r.name}: ${r.count} เลข / ${r.totalPages} หน้า${issueNote}`;
  });

  const dupWithBox = [...allCodes].length - fresh.length;
  const dupNote = dupWithBox ? ` (ซ้ำกับในช่อง ${dupWithBox})` : '';
  const summary = `ได้ ${fresh.length} เลขใหม่${dupNote} | ${perFile.join(' · ')}`;

  if (problemPageNums.length > 0) {
    $pdfStatus.textContent = `${summary} | ⚠ ${problemPageNums.length} หน้าต้องตรวจเอง: หน้า ${problemPageNums.join(', ')}`;
    $pdfStatus.style.color = '#c62828';
  } else {
    $pdfStatus.textContent = summary;
    $pdfStatus.style.color = fresh.length > 0 ? '#2e7d32' : '#888';
  }

  $pdfInput.value = ''; // allow re-select same file
  $btnPdf.disabled = false;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

// --- Version badge + update check ---
const DISMISSED_UPDATE_KEY = 'jtInbound.dismissedUpdate';

(function initVersionAndUpdate() {
  const manifest = chrome.runtime.getManifest();
  document.getElementById('version-badge').textContent = 'v' + manifest.version;

  function semverGt(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }

  fetch(UPDATE_MANIFEST_URL, { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : Promise.reject('not-ok'))
    .then(data => {
      if (!data || typeof data.version !== 'string' || !semverGt(data.version, manifest.version)) return;
      chrome.storage.local.get({ [DISMISSED_UPDATE_KEY]: '' }, ({ [DISMISSED_UPDATE_KEY]: dismissed }) => {
        // Skip banner if user already dismissed this version (or newer)
        if (dismissed && !semverGt(data.version, dismissed)) return;
        document.getElementById('update-version').textContent = data.version;
        const link = document.getElementById('update-link');
        if (data.url) link.href = data.url;
        const notes = document.getElementById('update-notes');
        if (data.notes) notes.textContent = '· ' + data.notes;
        document.getElementById('update-banner').hidden = false;

        link.addEventListener('click', () => {
          document.getElementById('update-banner').hidden = true;
          chrome.storage.local.set({ [DISMISSED_UPDATE_KEY]: data.version });
        });
      });
    })
    .catch(() => {}); // graceful fail — network/CORS ไม่รบกวน user
})();

// --- Init ---
init();
