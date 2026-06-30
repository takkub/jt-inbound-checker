'use strict';

const DEFAULT_DELAY_MS = 1000;
const RESULT_TIMEOUT_MS = 3000;
const ACTIVE_SCAN_KEY = 'jtInbound.activeScan';

// Selectors — all J&T-specific DOM references live here; update once if site changes
const SEL = {
  waybillInput:      'input[placeholder="Waybill"]',
  okButton:          'button',            // filtered by textContent === 'OK' in findOkButton()
  scanListRow:       '.el-table__row',
  formError:         '.el-form-item__error',
  toastError:        '.el-message--error',
  toastSuccess:      '.el-message--success',
  toastWarning:      '.el-message--warning',
  messageBox:        '.el-message-box',
  messageBoxMsg:     '.el-message-box__message',
  messageBoxConfirm: '.el-message-box__btns .el-button--primary',
};

// Keywords that indicate a duplicate/already-scanned condition on J&T side.
// case-insensitive substring match; extend here if J&T changes wording.
const DUPLICATE_KEYWORDS = ['สแกนแล้ว', 'เคยสแกน', 'สแกนซ้ำ', 'ซ้ำ', 'already', 'scanned', 'exist', 'duplicate'];

function isDuplicate(text) {
  const lower = text.toLowerCase();
  return DUPLICATE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

let state = {
  running: false, queue: [], results: {}, port: null,
  delayMs: DEFAULT_DELAY_MS, retryRounds: 2, tabId: null,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function persistState() {
  chrome.storage.local.set({
    [ACTIVE_SCAN_KEY]: {
      running: state.running,
      queue: state.queue,
      results: state.results,
      delayMs: state.delayMs,
      retryRounds: state.retryRounds,
      tabId: state.tabId,
    }
  });
}

function clearPersistedState() {
  chrome.storage.local.remove(ACTIVE_SCAN_KEY);
}

function updateBadge() {
  const done = Object.values(state.results).filter(r => r.status && r.status !== 'scanning').length;
  const total = state.queue.length;
  chrome.runtime.sendMessage({ type: 'set-badge', text: total > 0 ? `${done}/${total}` : '', color: '#1565c0' }).catch(() => {});
}

function clearBadge() {
  chrome.runtime.sendMessage({ type: 'set-badge', text: '' }).catch(() => {});
}

function notify(data) {
  if (state.port) try { state.port.postMessage(data); } catch {}
}

// Re-query every call — SPA may replace DOM nodes on route change
function findWaybillInput() {
  let el = document.querySelector(SEL.waybillInput);
  if (el) return el;
  // Fallback: find label with text 'Waybill' → .el-form-item parent → first input
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent.includes('Waybill')) {
      const item = label.closest('.el-form-item');
      if (item) { el = item.querySelector('input'); if (el) return el; }
    }
  }
  return null;
}

function findOkButton() {
  for (const btn of document.querySelectorAll(SEL.okButton)) {
    if (btn.textContent.trim() === 'OK') return btn;
  }
  return null;
}

// Dismiss visible El-Message toasts and return their texts for staleness detection.
// Element UI toasts linger ~3s — clearing before click prevents cross-round false signals.
function dismissStaleToasts() {
  const staleTexts = new Set();
  for (const el of document.querySelectorAll('.el-message')) {
    if (el.offsetParent !== null) {
      staleTexts.add(el.textContent.trim());
      const closeBtn = el.querySelector('.el-message__closeBtn');
      if (closeBtn) closeBtn.click();
    }
  }
  return staleTexts;
}

// Dismiss the El-MessageBox dialog (modal alert from J&T) by clicking its primary confirm button.
// Scoped strictly to buttons inside .el-message-box — never touches page-level buttons.
function dismissMessageBox() {
  const box = document.querySelector(SEL.messageBox);
  if (!box || box.offsetParent === null) return;
  const confirmBtn = box.querySelector(SEL.messageBoxConfirm)
    || [...box.querySelectorAll('button')].find(b => /ตกลง|OK|确定/i.test(b.textContent.trim()));
  if (confirmBtn) confirmBtn.click();
}

// MutationObserver + polling — resolves on first PASS or FAIL signal.
// errBefore: form-error text captured before click (ignore stale error that pre-existed).
// staleToastTexts: Set of toast texts visible before click (ignore them as signals).
// msgBoxBefore: whether a .el-message-box was already present before click (skip stale box).
function waitForDomResult(waybill, rowsBefore, errBefore, staleToastTexts, msgBoxBefore) {
  return new Promise(resolve => {
    let settled = false;
    let observer = null;
    let intervalId = null;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      clearInterval(intervalId);
      if (observer) observer.disconnect();
      resolve(result);
    };

    const tid = setTimeout(
      () => settle({ status: 'timeout', msg: 'Timeout — ไม่มีการตอบสนองจากหน้า J&T' }),
      RESULT_TIMEOUT_MS
    );

    const check = () => {
      // PASS (authoritative): new row added AND row contains this exact waybill.
      // Success toast is NOT a standalone pass signal — it lingers across rounds and
      // can fire on the previous waybill's success while the new one is still pending.
      const rows = document.querySelectorAll(SEL.scanListRow);
      if (rows.length > rowsBefore) {
        for (const row of rows) {
          if (row.textContent.includes(waybill)) return settle({ status: 'pass' });
        }
      }

      // MessageBox dialog — appeared AFTER click (not stale from before).
      // J&T uses this for "already scanned" and other confirmations.
      if (!msgBoxBefore) {
        const box = document.querySelector(SEL.messageBox);
        if (box && box.offsetParent !== null) {
          const msgEl = box.querySelector(SEL.messageBoxMsg);
          const text = (msgEl ? msgEl.textContent : box.textContent).trim();
          if (isDuplicate(text)) return settle({ status: 'pass', msg: 'ยิงซ้ำ (เลขนี้เคยยิงเข้าระบบแล้ว)' });
          return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${text || 'แจ้งเตือนไม่ทราบสาเหตุ'}` });
        }
      }

      // Warning toast — new (not stale). J&T shows warning for duplicate in some flows.
      const warnToast = document.querySelector(SEL.toastWarning);
      if (warnToast && warnToast.offsetParent !== null) {
        const text = warnToast.textContent.trim();
        if (!staleToastTexts.has(text)) {
          if (isDuplicate(text)) return settle({ status: 'pass', msg: 'ยิงซ้ำ (เลขนี้เคยยิงเข้าระบบแล้ว)' });
          return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${text || 'คำเตือนไม่ทราบสาเหตุ'}` });
        }
      }

      // FAIL: inline form error that is NEW (text changed vs. what was there before click).
      // Ignoring errBefore prevents a stale "Please enter the waybill no." from triggering
      // a false fail on the very next waybill.
      const errEl = document.querySelector(SEL.formError);
      const errText = errEl ? errEl.textContent.trim() : '';
      if (errText && errText !== errBefore) return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${errText}` });

      // FAIL: error toast that is genuinely new (not a stale toast from the previous round).
      const errToast = document.querySelector(SEL.toastError);
      if (errToast && errToast.offsetParent !== null) {
        const toastText = errToast.textContent.trim();
        if (!staleToastTexts.has(toastText)) return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${toastText || 'Error'}` });
      }
    };

    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    intervalId = setInterval(check, 150);
    check(); // run once immediately before first mutation fires
  });
}

// DOM automation: fill Waybill input → click OK → wait for result
async function submitOne(waybill, displayI, displayTotal, delayMs) {
  notify({ type: 'progress', i: displayI, total: displayTotal, waybill, status: 'scanning' });

  const input = findWaybillInput();
  if (!input) {
    const result = { status: 'fail', msg: 'ไม่พบช่อง Waybill input — ตรวจสอบว่าอยู่ที่หน้า #/mailPutIn' };
    state.results[waybill] = result;
    notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
    await sleep(delayMs);
    return result;
  }

  // Snapshot row count before clicking OK
  const rowsBefore = document.querySelectorAll(SEL.scanListRow).length;

  // Use native setter so Vue/Element-UI reactivity sees the new value
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, waybill);
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(80); // let Vue propagate binding before click

  const okBtn = findOkButton();
  if (!okBtn) {
    const result = { status: 'fail', msg: 'ไม่พบปุ่ม OK — ตรวจสอบว่าอยู่ที่หน้า #/mailPutIn' };
    state.results[waybill] = result;
    notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
    await sleep(delayMs);
    return result;
  }

  // Snapshot pre-click state so waitForDomResult can distinguish stale vs. new signals.
  const errBefore = document.querySelector(SEL.formError)?.textContent.trim() ?? '';
  const staleToastTexts = dismissStaleToasts();
  const msgBoxBefore = !!document.querySelector(SEL.messageBox);

  okBtn.click(); // stage into Scan list only — does NOT trigger upload-all / submit batch

  const result = await waitForDomResult(waybill, rowsBefore, errBefore, staleToastTexts, msgBoxBefore);

  // Dismiss any MessageBox that J&T opened (e.g. duplicate alert) so it doesn't block next waybill.
  // Scoped to .el-message-box buttons only — never touches page-level submit/upload buttons.
  dismissMessageBox();
  state.results[waybill] = result;
  notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
  await sleep(delayMs);
  return result;
}

function saveFailures(waybills) {
  if (!waybills.length) return;
  const entries = waybills.map(w => ({
    wayBillCode: w,
    msg: state.results[w]?.msg || state.results[w]?.status,
    ts: Date.now(),
  }));
  chrome.storage.local.get({ 'jtInbound.failures': [] }, ({ 'jtInbound.failures': arr }) => {
    const existingCodes = new Set(arr.map(a => a.wayBillCode));
    const newEntries = entries.filter(e => !existingCodes.has(e.wayBillCode));
    chrome.storage.local.set({ 'jtInbound.failures': [...arr, ...newEntries] });
  });
}

async function runScan(queue, delayMs, retryRounds, resumeResults = null) {
  state.running = true;
  state.queue = [...queue];
  state.results = resumeResults ? { ...resumeResults } : {};
  state.delayMs = delayMs;
  state.retryRounds = retryRounds;
  persistState();

  for (let i = 0; i < queue.length; i++) {
    if (!state.running) break;
    if (state.results[queue[i]]?.status === 'pass') continue;
    await submitOne(queue[i], i, queue.length, delayMs);
    persistState();
    updateBadge();
  }

  for (let round = 0; round < retryRounds && state.running; round++) {
    const failed = queue.filter(w => state.results[w]?.status !== 'pass');
    if (!failed.length) break;
    notify({ type: 'retrying', round: round + 1, totalRounds: retryRounds, count: failed.length });
    for (let i = 0; i < failed.length; i++) {
      if (!state.running) break;
      await submitOne(failed[i], i, failed.length, delayMs);
      persistState();
      updateBadge();
    }
  }

  saveFailures(queue.filter(w => state.results[w]?.status !== 'pass'));
  state.running = false;
  clearPersistedState();
  clearBadge();
  notify({ type: 'done', results: state.results });
}

async function retryFailed(delayMs, retryRounds) {
  if (state.running) return;
  state.running = true;
  state.delayMs = delayMs;
  state.retryRounds = retryRounds;
  persistState();

  for (let round = 0; round < retryRounds && state.running; round++) {
    const failed = state.queue.filter(w => state.results[w]?.status !== 'pass');
    if (!failed.length) break;
    notify({ type: 'retrying', round: round + 1, totalRounds: retryRounds, count: failed.length });
    for (let i = 0; i < failed.length; i++) {
      if (!state.running) break;
      await submitOne(failed[i], i, failed.length, delayMs);
      persistState();
      updateBadge();
    }
  }

  saveFailures(state.queue.filter(w => state.results[w]?.status !== 'pass'));
  state.running = false;
  clearPersistedState();
  clearBadge();
  notify({ type: 'done', results: state.results });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'jt-inbound') return;
  state.port = port;

  port.postMessage({ type: 'state', running: state.running, queue: state.queue, results: state.results });

  port.onMessage.addListener(msg => {
    if (msg.type === 'start' && !state.running) {
      state.tabId = msg.tabId ?? null;
      runScan(msg.queue, msg.delayMs ?? DEFAULT_DELAY_MS, msg.retryRounds ?? 2);
    } else if (msg.type === 'stop') {
      state.running = false;
      clearPersistedState();
      clearBadge();
    } else if (msg.type === 'retry-failed' && !state.running) {
      retryFailed(msg.delayMs ?? DEFAULT_DELAY_MS, msg.retryRounds ?? 2);
    }
  });

  port.onDisconnect.addListener(() => { state.port = null; });
});

// Version badge — fixed bottom-right corner, pointer-events:none so it never blocks clicks
(function injectVersionBadge() {
  if (document.getElementById('jt-checker-version-badge')) return;
  const el = document.createElement('div');
  el.id = 'jt-checker-version-badge';
  el.textContent = 'J&T Checker v' + chrome.runtime.getManifest().version;
  Object.assign(el.style, {
    position: 'fixed', bottom: '8px', right: '8px',
    zIndex: '2147483600', background: 'rgba(0,0,0,.55)', color: '#fff',
    font: '11px/1.4 sans-serif', padding: '2px 6px', borderRadius: '4px',
    opacity: '.7', pointerEvents: 'none',
  });
  document.body.appendChild(el);
})();

// Auto-resume after tab reload — pick up interrupted scan from storage
chrome.storage.local.get({ [ACTIVE_SCAN_KEY]: null }, ({ [ACTIVE_SCAN_KEY]: saved }) => {
  if (!saved?.running || !Array.isArray(saved.queue) || !saved.queue.length) return;
  state.tabId = saved.tabId ?? null;
  runScan(saved.queue, saved.delayMs ?? DEFAULT_DELAY_MS, saved.retryRounds ?? 2, saved.results ?? null);
});
