// dev-tinylin: chrome-devtools navigate_page `initScript` that makes an agent tab on the USER's live
// :3000 READ-ONLY towards the user's stack (:5000 backend, :5001 modal, :3001 launcher, :3002 assistant).
// - fetch / XHR: GET passes; every other method is answered locally (200 {"ok":true}; a preset load
//   answers {"ok":true,"reinit":"full"} so the FE hydrates through GETs) and logged in window.__guardDropped.
// - socket.io (polling + websocket) to those ports is refused, so no WS emit can reach the backend.
// - navigator.sendBeacon to those ports is dropped.
// Covers ONE navigation: re-enter only through navigate_page with this script (UI_TESTING.md).
(() => {
  const LIVE = /(127\.0\.0\.1|localhost):(5000|5001|3001|3002)\b/;
  const dropped = (window.__guardDropped = []);
  const fake = (url) => {
    const body = /load_preset|preset\.load/.test(url) ? { ok: true, reinit: "full" } : { ok: true };
    return JSON.stringify(body);
  };
  const isSock = (u) => /\/socket\.io\//.test(u);
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = ((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (LIVE.test(url) && (isSock(url) || method !== "GET")) {
      dropped.push({ via: "fetch", method, url, t: Date.now() });
      if (isSock(url)) return Promise.reject(new TypeError("guard: socket blocked"));
      return Promise.resolve(new Response(fake(url), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return of.call(this, input, init);
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__g = { method: String(m).toUpperCase(), url: String(u) };
    return oo.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const g = this.__g || {};
    if (LIVE.test(g.url) && (isSock(g.url) || g.method !== "GET")) {
      dropped.push({ via: "xhr", method: g.method, url: g.url, t: Date.now() });
      const xhr = this;
      const blockSock = isSock(g.url);
      const text = blockSock ? "" : fake(g.url);
      Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
      Object.defineProperty(xhr, "status", { value: blockSock ? 0 : 200, configurable: true });
      Object.defineProperty(xhr, "responseText", { value: text, configurable: true });
      Object.defineProperty(xhr, "response", { value: xhr.responseType === "json" ? (text ? JSON.parse(text) : null) : text, configurable: true });
      xhr.getAllResponseHeaders = () => "content-type: application/json\r\n";
      xhr.getResponseHeader = (h) => (/content-type/i.test(h) ? "application/json" : null);
      setTimeout(() => {
        try { xhr.onreadystatechange && xhr.onreadystatechange(); } catch (e) { /* ignore */ }
        if (blockSock) { try { xhr.onerror && xhr.onerror(new ProgressEvent("error")); } catch (e) { /* ignore */ } xhr.dispatchEvent(new ProgressEvent("error")); }
        else { try { xhr.onload && xhr.onload(new ProgressEvent("load")); } catch (e) { /* ignore */ } xhr.dispatchEvent(new ProgressEvent("load")); }
        try { xhr.onloadend && xhr.onloadend(new ProgressEvent("loadend")); } catch (e) { /* ignore */ }
      }, 0);
      return undefined;
    }
    return os.call(this, body);
  };
  const OW = window.WebSocket;
  function WS(u, p) {
    if (LIVE.test(String(u))) {
      dropped.push({ via: "ws", url: String(u), t: Date.now() });
      return new OW("ws://127.0.0.1:9/guard-blocked"); // never opens (discard port): the app sees a failed socket, not a throw
    }
    return p === undefined ? new OW(u) : new OW(u, p);
  }
  WS.prototype = OW.prototype;
  Object.assign(WS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = WS;
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => (LIVE.test(String(u)) ? (dropped.push({ via: "beacon", url: String(u) }), true) : ob(u, d));
  }
  window.__guardActive = true;
})();
