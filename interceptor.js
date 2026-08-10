'use strict';

// Passive MAIN-world observer for the authenticated new-site inbound check.
// It never changes request/response data and ignores every other endpoint.
(function installInboundCheckObserver() {
  if (window.location.origin !== 'https://home-site.jtexpress.co.th') return;
  const INSTALL_KEY = '__jtInboundCheckObserverV449';
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  const ENDPOINT = 'https://std-station-api.jtexpress.co.th/site/send-parcel/sendInStorageCheck';
  const CHANNEL = 'jt-inbound-checker-v4.4.9';
  let requestSequence = 0;

  function isExactEndpoint(rawUrl) {
    try { return new URL(rawUrl, window.location.href).href === ENDPOINT; }
    catch { return false; }
  }

  function parseWaybill(body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return typeof parsed?.wayBillCode === 'string' && parsed.wayBillCode.trim()
        ? parsed.wayBillCode.trim()
        : null;
    } catch { return null; }
  }

  function post(type, detail) {
    window.postMessage({ channel: CHANNEL, type, ...detail }, window.location.origin);
  }

  function beginRequest(waybill) {
    if (!waybill) return null;
    const requestId = `${Date.now()}-${++requestSequence}`;
    post('request', { requestId, waybill });
    return { requestId, waybill };
  }

  function postResponse(request, body) {
    if (!request || !body || typeof body !== 'object') return;
    post('response', {
      requestId: request.requestId,
      waybill: request.waybill,
      result: {
        code: body.code,
        msg: typeof body.msg === 'string' ? body.msg : '',
        data: body.data,
        succ: body.succ,
        fail: body.fail,
      },
    });
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function observedFetch(input, init) {
      const rawUrl = typeof input === 'string' || input instanceof URL ? input : input?.url;
      if (!isExactEndpoint(rawUrl)) return nativeFetch.apply(this, arguments);

      let requestPromise;
      if (init?.body != null) {
        requestPromise = Promise.resolve(beginRequest(parseWaybill(init.body)));
      } else if (input && typeof input.clone === 'function') {
        requestPromise = input.clone().text().then(body => beginRequest(parseWaybill(body))).catch(() => null);
      } else {
        requestPromise = Promise.resolve(null);
      }

      const responsePromise = nativeFetch.apply(this, arguments);
      responsePromise.then(response => {
        Promise.all([requestPromise, response.clone().json()])
          .then(([request, body]) => postResponse(request, body))
          .catch(() => {});
      }).catch(() => {});
      return responsePromise;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR?.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function observedOpen(method, url) {
      this.__jtInboundObservedUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    NativeXHR.prototype.send = function observedSend(body) {
      if (!isExactEndpoint(this.__jtInboundObservedUrl)) return nativeSend.apply(this, arguments);
      const request = beginRequest(parseWaybill(body));
      if (request) {
        this.addEventListener('loadend', () => {
          try {
            const responseBody = this.responseType === 'json'
              ? this.response
              : JSON.parse(this.responseText);
            postResponse(request, responseBody);
          } catch {}
        }, { once: true });
      }
      return nativeSend.apply(this, arguments);
    };
  }
})();
