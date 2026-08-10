'use strict';

(() => {
if (globalThis.__jtInboundContentV449Loaded) return;
globalThis.__jtInboundContentV449Loaded = true;

const DEFAULT_DELAY_MS = 1000;
const RESULT_TIMEOUT_MS = 3000;
const ACTIVE_SCAN_KEY = 'jtInbound.activeScan';
const API_EVENT_CHANNEL = 'jt-inbound-checker-v4.4.9';

// Selectors for both the legacy Element UI page and the new home-site UI.
const SEL = {
  exactWaybillInput: [
    'input[placeholder="Please enter the waybill no."]',
    'input[placeholder="Waybill"]',
  ].join(','),
  scanListRow: [
    '.el-table__body-wrapper .el-table__row',
    '.ant-table-tbody > tr.ant-table-row',
    '.ant-table-tbody > tr',
    'table tbody > tr',
  ].join(','),
  formError: [
    '.el-form-item__error',
    '.ant-form-explain',
    '.ant-form-item-explain-error',
    '.ant-form-item-explain [role="alert"]',
    '.ant-form-item-has-error .ant-form-item-explain',
  ].join(','),
  toastError: [
    '.el-message--error',
    '.ant-message-error',
    '.ant-notification-notice-error',
    '.ant-alert-error',
  ].join(','),
  toastSuccess: [
    '.el-message--success',
    '.ant-message-success',
    '.ant-notification-notice-success',
    '.ant-alert-success',
  ].join(','),
  toastWarning: [
    '.el-message--warning',
    '.ant-message-warning',
    '.ant-notification-notice-warning',
    '.ant-alert-warning',
  ].join(','),
  allToasts: [
    '.el-message',
    '.ant-message-notice',
    '.ant-notification-notice',
    '.ant-alert',
  ].join(','),
  messageBox: '.el-message-box, .ant-modal',
  messageBoxMsg: '.el-message-box__message, .ant-modal-body',
};

// Reject negative/not-found messages before looking for an explicit duplicate phrase.
const NOT_DUPLICATE_PATTERNS = [
  /\bdoes\s+not\s+exist\b/i,
  /\bdo\s+not\s+exist\b/i,
  /\bnot\s+exist(?:s|ed|ing)?\b/i,
  /\bnon[ -]?existent\b/i,
  /\bnot\s+found\b/i,
  /ไม่พบ/,
  /ไม่มี(?:ข้อมูล|เลข|พัสดุ|รายการ)?/,
];

const DUPLICATE_PATTERNS = [
  /\balready\s+exists?\b/i,
  /\balready\s+(?:been\s+)?scanned\b/i,
  /\bhas\s+(?:already\s+)?been\s+scanned\b/i,
  /\bduplicate\b/i,
  /สแกนแล้ว/,
  /เคยสแกน/,
  /สแกนซ้ำ/,
  /(?:เลข|รายการ|พัสดุ)(?:นี้)?ซ้ำ/,
];

function isDuplicate(text) {
  if (NOT_DUPLICATE_PATTERNS.some(pattern => pattern.test(text))) return false;
  return DUPLICATE_PATTERNS.some(pattern => pattern.test(text));
}

function containsExactWaybill(text, waybill) {
  if (!text || !waybill) return false;
  const escaped = waybill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(text);
}

function isUploadAllText(text) {
  return /\bupload\s*all\b|อัปโหลดทั้งหมด|อัพโหลดทั้งหมด|上传全部/i.test(text);
}

let state = {
  running: false, queue: [], results: {}, port: null,
  delayMs: DEFAULT_DELAY_MS, retryRounds: 2, tabId: null,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isInboundLocation(loc = window.location) {
  if (loc.protocol !== 'https:') return false;
  if (loc.hostname === 'home-site.jtexpress.co.th') {
    return loc.pathname === '/mailPutIn' || loc.pathname.startsWith('/mailPutIn/');
  }
  if (loc.hostname === 'home.jtexpress.co.th') {
    return loc.hash === '#/mailPutIn'
      || loc.hash.startsWith('#/mailPutIn?')
      || loc.hash.startsWith('#/mailPutIn/');
  }
  return false;
}

function isNewSiteLocation(loc = window.location) {
  return loc.protocol === 'https:'
    && loc.hostname === 'home-site.jtexpress.co.th'
    && (loc.pathname === '/mailPutIn' || loc.pathname.startsWith('/mailPutIn/'));
}

function isVisible(el) {
  return !!el && !el.hidden && getComputedStyle(el).visibility !== 'hidden'
    && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}

function visibleElements(selector) {
  return [...document.querySelectorAll(selector)].filter(isVisible);
}

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
  let el = visibleElements(SEL.exactWaybillInput).find(input => !input.disabled && !input.readOnly);
  if (el) return el;

  // Attribute fallback for small copy changes in either site.
  el = [...document.querySelectorAll('input:not([type="hidden"]):not([type="file"])')].find(input => {
    if (!isVisible(input) || input.disabled || input.readOnly) return false;
    const hint = [input.placeholder, input.name, input.id, input.getAttribute('aria-label')]
      .filter(Boolean).join(' ').toLowerCase();
    return /way\s*bill/.test(hint);
  });
  if (el) return el;

  // Label fallback: find a Waybill label and stay inside that form item.
  for (const label of document.querySelectorAll('label')) {
    if (/way\s*bill/i.test(label.textContent)) {
      const labelled = label.htmlFor && document.getElementById(label.htmlFor);
      if (labelled instanceof HTMLInputElement && isVisible(labelled)) return labelled;
      const item = label.closest('.el-form-item, .ant-form-item, form, [class*="form-item"]');
      if (item) {
        el = [...item.querySelectorAll('input:not([type="hidden"]):not([type="file"])')].find(isVisible);
        if (el) return el;
      }
    }
  }
  return null;
}

function isSafeOkButton(btn) {
  const text = btn.textContent.trim();
  return /^OK$/i.test(text)
    && !/upload\s*all/i.test(text)
    && !btn.disabled
    && btn.getAttribute('aria-disabled') !== 'true'
    && !btn.closest(SEL.messageBox)
    && isVisible(btn);
}

function isStrictlyNearWaybillInput(input, button) {
  const inputRect = input.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (!inputRect.width || !inputRect.height || !buttonRect.width || !buttonRect.height) return false;

  const verticalOverlap = Math.min(inputRect.bottom, buttonRect.bottom)
    - Math.max(inputRect.top, buttonRect.top);
  const centerDistance = Math.abs(
    (inputRect.top + inputRect.bottom) / 2 - (buttonRect.top + buttonRect.bottom) / 2
  );
  const sameRow = verticalOverlap > 0
    || centerDistance <= Math.max(inputRect.height, buttonRect.height);
  const horizontalGap = buttonRect.left >= inputRect.right
    ? buttonRect.left - inputRect.right
    : inputRect.left >= buttonRect.right
      ? inputRect.left - buttonRect.right
      : 0;

  return sameRow && horizontalGap <= 240;
}

function findOkButton(input) {
  // Inspect each shared ancestor from nearest to farthest, including the form.
  // This supports the new page where the input and OK live in sibling wrappers.
  // Every candidate must also have strict same-row geometry, so an unrelated
  // page/form OK cannot become eligible even when the page omits a <form>.
  let scope = input?.parentElement;
  for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
    const isForm = scope.matches('form');
    if (scope.matches('main, body, [role="main"]')) break;

    const buttons = [...scope.querySelectorAll('button, [role="button"]')]
      .filter(isSafeOkButton)
      .filter(button => isStrictlyNearWaybillInput(input, button));
    if (buttons.length === 1) return buttons[0];
    if (buttons.length > 1) return null;
    if (isForm) break;
  }
  return null;
}

function fillWaybillInput(input, waybill) {
  // Use the native setter so Vue/Element-UI reactivity sees the new value.
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, waybill);
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Dismiss visible Element/Ant toasts and retain their nodes for staleness detection.
// Toasts can linger across rounds, so they must not become the next scan's result.
function dismissStaleToasts() {
  const staleNodes = new Set();
  for (const el of visibleElements(SEL.allToasts)) {
      staleNodes.add(el);
      const closeBtn = el.querySelector('.el-message__closeBtn, .ant-message-notice-close, .ant-notification-notice-close, .ant-alert-close-icon');
      if (closeBtn) closeBtn.click();
  }
  return staleNodes;
}

function isFreshToast(el, staleToastNodes) {
  return ![...staleToastNodes].some(
    stale => stale === el || stale.contains(el) || el.contains(stale)
  );
}

function getDialogText(box) {
  const msgEl = box.querySelector(SEL.messageBoxMsg);
  return (msgEl ? msgEl.textContent : box.textContent).trim();
}

function findRequestResultDialog(waybill, dialogsBefore) {
  return visibleElements(SEL.messageBox).find(box => {
    const text = getDialogText(box);
    return !dialogsBefore.has(box) && !isUploadAllText(text) && containsExactWaybill(text, waybill);
  }) || null;
}

// Dismiss only the newly-created, request-correlated result dialog returned by
// waitForDomResult. A dialog that existed before the click is never confirmed.
function dismissResultDialog(box, dialogsBefore) {
  if (!box || dialogsBefore.has(box) || !isVisible(box)) return;
  if (isUploadAllText(box.textContent)) return;
  const confirmBtn = [...box.querySelectorAll('button, [role="button"]')].find(
    b => /^(ตกลง|OK|Confirm|确定)$/i.test(b.textContent.trim()) && isVisible(b)
  );
  if (confirmBtn) confirmBtn.click();
}

// The new site is authoritative through its exact, request-correlated business
// response. A matching request event must arrive after this listener is armed,
// so a late response from an earlier scan cannot settle the current waybill.
function waitForNewSiteApiResult(waybill) {
  return new Promise(resolve => {
    const requestIds = new Set();
    let settled = false;
    let timeoutId = null;

    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      resolve({ result, resultDialog: null });
    };

    const onMessage = event => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const detail = event.data;
      if (!detail || detail.channel !== API_EVENT_CHANNEL || detail.waybill !== waybill) return;

      if (detail.type === 'request' && typeof detail.requestId === 'string') {
        requestIds.add(detail.requestId);
        return;
      }
      if (detail.type !== 'response' || !requestIds.has(detail.requestId)) return;

      const response = detail.result;
      if (!response || typeof response !== 'object') return;
      const responseMsg = typeof response.msg === 'string' ? response.msg.trim() : '';
      if (responseMsg && isDuplicate(responseMsg)) {
        settle({ status: 'pass', msg: 'ยิงซ้ำ (เลขนี้เคยยิงเข้าระบบแล้ว)' });
      } else if (response.succ === true && response.fail === false && response.data === 'SUCCESS') {
        settle({ status: 'pass' });
      } else {
        settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${responseMsg || 'API ตอบกลับว่าไม่สำเร็จ'}` });
      }
    };

    window.addEventListener('message', onMessage);
    timeoutId = setTimeout(
      () => settle({ status: 'timeout', msg: 'Timeout — ไม่ได้รับผล sendInStorageCheck จากหน้า J&T' }),
      RESULT_TIMEOUT_MS
    );
  });
}

// MutationObserver + polling — resolves on first PASS or FAIL signal.
// Snapshots let us distinguish a fresh signal from stale DOM left by a prior scan.
function waitForDomResult(waybill, rowsBefore, errorsBefore, staleToastNodes, dialogsBefore) {
  return new Promise(resolve => {
    let settled = false;
    let observer = null;
    let intervalId = null;

    const settle = (result, resultDialog = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      clearInterval(intervalId);
      if (observer) observer.disconnect();
      resolve({ result, resultDialog });
    };

    const tid = setTimeout(
      () => settle({ status: 'timeout', msg: 'Timeout — ไม่มีการตอบสนองจากหน้า J&T' }),
      RESULT_TIMEOUT_MS
    );

    const check = () => {
      // PASS (authoritative): a new/changed scan-list row contains this exact waybill.
      const rows = [...document.querySelectorAll(SEL.scanListRow)];
      for (const row of rows) {
        const text = row.textContent.trim();
        const changed = !rowsBefore.has(row) || rowsBefore.get(row) !== text;
        if (changed && containsExactWaybill(text, waybill)) return settle({ status: 'pass' });
      }

      // Only a new dialog containing this exact waybill can belong to this request.
      // Existing dialogs are ignored even if their text changes and are never confirmed.
      const box = findRequestResultDialog(waybill, dialogsBefore);
      if (box) {
        const text = getDialogText(box);
        if (isDuplicate(text)) {
          return settle({ status: 'pass', msg: 'ยิงซ้ำ (เลขนี้เคยยิงเข้าระบบแล้ว)' }, box);
        }
        return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${text || 'แจ้งเตือนไม่ทราบสาเหตุ'}` }, box);
      }

      // Warning/error toasts from either UI framework.
      for (const warnToast of visibleElements(SEL.toastWarning)) {
        const text = warnToast.textContent.trim();
        if (isFreshToast(warnToast, staleToastNodes) && containsExactWaybill(text, waybill)) {
          if (isDuplicate(text)) return settle({ status: 'pass', msg: 'ยิงซ้ำ (เลขนี้เคยยิงเข้าระบบแล้ว)' });
          return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${text || 'คำเตือนไม่ทราบสาเหตุ'}` });
        }
      }

      for (const errEl of visibleElements(SEL.formError)) {
        const errText = errEl.textContent.trim();
        if (errText && (!errorsBefore.has(errEl) || errorsBefore.get(errEl) !== errText)) {
          return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${errText}` });
        }
      }

      for (const errToast of visibleElements(SEL.toastError)) {
        const toastText = errToast.textContent.trim();
        if (isFreshToast(errToast, staleToastNodes) && containsExactWaybill(toastText, waybill)) {
          return settle({ status: 'fail', msg: `ปัญหาจากระบบ J&T: ${toastText || 'Error'}` });
        }
      }

      // Toast-only PASS is allowed only when the fresh signal names this exact waybill.
      for (const successToast of visibleElements(SEL.toastSuccess)) {
        const text = successToast.textContent.trim();
        if (isFreshToast(successToast, staleToastNodes) && containsExactWaybill(text, waybill)) {
          return settle({ status: 'pass' });
        }
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

  if (!isInboundLocation()) {
    const result = { status: 'fail', msg: 'กรุณาเปิดหน้า Shipping Inbound: /mailPutIn (เว็บใหม่) หรือ #/mailPutIn (เว็บเดิม)' };
    state.results[waybill] = result;
    notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
    await sleep(delayMs);
    return result;
  }

  const input = findWaybillInput();
  if (!input) {
    const result = { status: 'fail', msg: 'ไม่พบช่อง Waybill — ตรวจสอบหน้า /mailPutIn (เว็บใหม่) หรือ #/mailPutIn (เว็บเดิม)' };
    state.results[waybill] = result;
    notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
    await sleep(delayMs);
    return result;
  }

  const useNewSiteApi = isNewSiteLocation();
  const rowsBefore = useNewSiteApi ? null : new Map(
    [...document.querySelectorAll(SEL.scanListRow)].map(row => [row, row.textContent.trim()])
  );

  fillWaybillInput(input, waybill);

  await sleep(80); // let Vue propagate binding before click

  const okBtn = findOkButton(input);
  if (!okBtn) {
    const result = { status: 'fail', msg: 'ไม่พบปุ่ม OK ที่อยู่ข้างช่อง Waybill — ระบบจะไม่กด Upload All' };
    state.results[waybill] = result;
    notify({ type: 'progress', i: displayI, total: displayTotal, waybill, ...result });
    await sleep(delayMs);
    return result;
  }

  // Legacy site retains v4.4.8 DOM snapshots. The new site arms its exact API
  // listener before click and does not use rows, dialogs, or toasts as success.
  const errorsBefore = useNewSiteApi ? null
    : new Map(visibleElements(SEL.formError).map(el => [el, el.textContent.trim()]));
  const staleToastNodes = useNewSiteApi ? null : dismissStaleToasts();
  const dialogsBefore = useNewSiteApi ? null : new Map(
    visibleElements(SEL.messageBox).map(box => [box, getDialogText(box)])
  );
  const newSiteResultPromise = useNewSiteApi ? waitForNewSiteApiResult(waybill) : null;

  okBtn.click(); // stage into Scan list only — does NOT trigger upload-all / submit batch

  const { result, resultDialog } = useNewSiteApi
    ? await newSiteResultPromise
    : await waitForDomResult(waybill, rowsBefore, errorsBefore, staleToastNodes, dialogsBefore);

  if (!useNewSiteApi) {
    dismissResultDialog(resultDialog || findRequestResultDialog(waybill, dialogsBefore), dialogsBefore);
  }
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
  if (!isInboundLocation()) {
    clearPersistedState();
    clearBadge();
    return;
  }
  state.tabId = saved.tabId ?? null;
  runScan(saved.queue, saved.delayMs ?? DEFAULT_DELAY_MS, saved.retryRounds ?? 2, saved.results ?? null);
});

})();
