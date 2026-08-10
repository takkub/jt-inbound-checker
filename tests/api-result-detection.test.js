'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ENDPOINT = 'https://std-station-api.jtexpress.co.th/site/send-parcel/sendInStorageCheck';
const CHANNEL = 'jt-inbound-checker-v4.4.9';
const SUCCESS = { code: 1, msg: '请求成功', version: null, data: 'SUCCESS', succ: true, fail: false };

class FakeWindow {
  constructor() {
    this.location = {
      href: 'https://home-site.jtexpress.co.th/mailPutIn',
      origin: 'https://home-site.jtexpress.co.th',
    };
    this.messages = [];
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  postMessage(data, targetOrigin) { this.messages.push({ data, targetOrigin }); }
  dispatchMessage(data) {
    const event = { source: this, origin: this.location.origin, data };
    for (const fn of [...(this.listeners.get('message') || [])]) fn(event);
  }
}

function fakeResponse(body) {
  return { clone: () => ({ json: async () => body }) };
}

function installInterceptor() {
  const window = new FakeWindow();
  const fetchCalls = [];
  window.fetch = async (...args) => {
    fetchCalls.push(args);
    return fakeResponse(SUCCESS);
  };
  window.XMLHttpRequest = class FakeXHR {
    constructor() { this.listeners = new Map(); this.responseType = ''; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    open(method, url) { this.nativeMethod = method; this.nativeUrl = url; }
    send(body) {
      this.nativeBody = body;
      this.responseText = JSON.stringify(SUCCESS);
      this.listeners.get('loadend')?.();
    }
  };
  const context = { window, URL, Date, Promise };
  vm.createContext(context);
  const interceptorSource = fs.readFileSync(path.join(__dirname, '..', 'interceptor.js'), 'utf8');
  vm.runInContext(interceptorSource, context);
  return { window, fetchCalls, context, interceptorSource };
}

async function flushAsyncObserver() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test('fetch observes only the exact endpoint and correlates JSON wayBillCode', async () => {
  const { window, fetchCalls } = installInterceptor();
  await window.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ wayBillCode: 'JTTH202211871750' }) });
  await flushAsyncObserver();

  assert.equal(fetchCalls.length, 1);
  assert.equal(window.messages.length, 2);
  const [request, response] = window.messages.map(item => item.data);
  assert.equal(request.type, 'request');
  assert.equal(request.waybill, 'JTTH202211871750');
  assert.equal(response.type, 'response');
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.waybill, request.waybill);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result)), {
    code: 1, msg: '请求成功', data: 'SUCCESS', succ: true, fail: false,
  });

  window.messages.length = 0;
  await window.fetch(`${ENDPOINT}/other`, { method: 'POST', body: JSON.stringify({ wayBillCode: 'JTTH-WRONG' }) });
  await flushAsyncObserver();
  assert.equal(window.messages.length, 0);
});

test('fetch ignores an exact endpoint request without a correlated wayBillCode', async () => {
  const { window } = installInterceptor();
  await window.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ anotherField: 'JTTH202211871750' }) });
  await flushAsyncObserver();
  assert.equal(window.messages.length, 0);
});

test('XHR passively reports the same request-id and business response', () => {
  const { window } = installInterceptor();
  const xhr = new window.XMLHttpRequest();
  xhr.open('POST', ENDPOINT);
  xhr.send(JSON.stringify({ wayBillCode: 'JTTH202420971756' }));

  assert.equal(xhr.nativeUrl, ENDPOINT);
  assert.equal(xhr.nativeBody, JSON.stringify({ wayBillCode: 'JTTH202420971756' }));
  assert.equal(window.messages.length, 2);
  assert.equal(window.messages[0].data.waybill, 'JTTH202420971756');
  assert.equal(window.messages[1].data.requestId, window.messages[0].data.requestId);
  assert.equal(window.messages[1].data.result.data, 'SUCCESS');
});

test('interceptor install is idempotent when popup injects it again', async () => {
  const { window, context, interceptorSource } = installInterceptor();
  const installedFetch = window.fetch;
  vm.runInContext(interceptorSource, context);
  assert.equal(window.fetch, installedFetch);
  await window.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ wayBillCode: 'JTTH202642871756' }) });
  await flushAsyncObserver();
  assert.equal(window.messages.length, 2);
});

test('manifest loads the passive observer at document_start in MAIN world on the new host only', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const observerEntry = manifest.content_scripts.find(entry => entry.js?.includes('interceptor.js'));
  assert.deepEqual(observerEntry, {
    matches: [
      'https://home-site.jtexpress.co.th/mailPutIn',
      'https://home-site.jtexpress.co.th/mailPutIn/*',
    ],
    js: ['interceptor.js'],
    run_at: 'document_start',
    world: 'MAIN',
  });
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const contentSource = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function createApiWaiterContext() {
  const window = new FakeWindow();
  const context = {
    window,
    RESULT_TIMEOUT_MS: 3000,
    API_EVENT_CHANNEL: CHANNEL,
    isDuplicate: text => /already|duplicate|สแกนซ้ำ/i.test(text),
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(contentSource, 'waitForNewSiteApiResult'), context);
  return { window, waitForNewSiteApiResult: context.waitForNewSiteApiResult };
}

function emit(window, type, waybill, requestId, result) {
  window.dispatchMessage({ channel: CHANNEL, type, waybill, requestId, result });
}

test('observed success schema passes for the exact armed request', async () => {
  const { window, waitForNewSiteApiResult } = createApiWaiterContext();
  const pending = waitForNewSiteApiResult('JTTH202211871750');
  emit(window, 'request', 'JTTH202211871750', 'req-1');
  emit(window, 'response', 'JTTH202211871750', 'req-1', SUCCESS);
  assert.equal((await pending).result.status, 'pass');
});

test('matched explicit business failure fails using its API message', async () => {
  const { window, waitForNewSiteApiResult } = createApiWaiterContext();
  const pending = waitForNewSiteApiResult('JTTH202420971756');
  emit(window, 'request', 'JTTH202420971756', 'req-fail');
  emit(window, 'response', 'JTTH202420971756', 'req-fail', {
    code: 0, msg: 'waybill rejected', data: null, succ: false, fail: true,
  });
  const { result } = await pending;
  assert.equal(result.status, 'fail');
  assert.match(result.msg, /waybill rejected/);
});

test('wrong waybill and stale previous response are ignored', async () => {
  const { window, waitForNewSiteApiResult } = createApiWaiterContext();
  const pending = waitForNewSiteApiResult('JTTH202642871756');
  let settled = false;
  pending.then(() => { settled = true; });

  emit(window, 'response', 'JTTH202642871756', 'old-request', SUCCESS);
  emit(window, 'request', 'JTTH-WRONG', 'wrong-request');
  emit(window, 'response', 'JTTH-WRONG', 'wrong-request', SUCCESS);
  await Promise.resolve();
  assert.equal(settled, false);

  emit(window, 'request', 'JTTH202642871756', 'current-request');
  emit(window, 'response', 'JTTH202642871756', 'current-request', SUCCESS);
  assert.equal((await pending).result.status, 'pass');
});

test('new-site listener is armed before OK click and has no DOM success fallback', () => {
  const submitSource = extractFunction(contentSource, 'submitOne');
  assert.ok(submitSource.indexOf('waitForNewSiteApiResult(waybill)') < submitSource.indexOf('okBtn.click()'));
  assert.match(submitSource, /useNewSiteApi\s*\?\s*await newSiteResultPromise/);
  assert.match(submitSource, /:\s*await waitForDomResult/);
  assert.doesNotMatch(extractFunction(contentSource, 'waitForNewSiteApiResult'), /querySelector|MutationObserver|toast|scanListRow/);
});
