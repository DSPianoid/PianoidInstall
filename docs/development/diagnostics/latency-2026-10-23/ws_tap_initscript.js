// lat-3636: page-side WebSocket/fetch tap (instrumentation only, no app change).
// Records every socket.io frame sent/received and every fetch/XHR to :5000 with an
// epoch-ms timestamp (performance.timeOrigin + performance.now(), same system clock
// as Python time.time()). Read back with window.__latTap.
(() => {
  const now = () => performance.timeOrigin + performance.now();
  const tap = (window.__latTap = { frames: [], marks: [], max: 20000 });
  const push = (o) => { if (tap.frames.length < tap.max) tap.frames.push(o); };
  tap.mark = (label, extra) => { const t = now(); tap.marks.push({ t, label, ...(extra || {}) }); return t; };
  tap.clear = () => { tap.frames.length = 0; tap.marks.length = 0; };
  const NativeWS = window.WebSocket;
  function TapWS(url, protocols) {
    const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
    const send = ws.send.bind(ws);
    ws.send = (data) => {
      push({ t: now(), dir: 'out', url: String(url).slice(0, 60),
             data: typeof data === 'string' ? data.slice(0, 4000) : '[binary ' + (data.byteLength || data.size) + ']' });
      return send(data);
    };
    ws.addEventListener('message', (ev) => {
      const d = ev.data;
      push({ t: now(), dir: 'in', url: String(url).slice(0, 60),
             data: typeof d === 'string' ? d.slice(0, 600) : '[binary]' });
    });
    return ws;
  }
  TapWS.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { TapWS[k] = NativeWS[k]; });
  window.WebSocket = TapWS;
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const t0 = now();
    const p = nativeFetch.apply(this, arguments);
    if (/:5000|:3001/.test(url)) {
      p.then((r) => push({ t: t0, t_done: now(), dir: 'fetch', url: url.slice(0, 120),
                           method: (init && init.method) || 'GET', status: r.status,
                           body: init && typeof init.body === 'string' ? init.body.slice(0, 2000) : undefined }),
             () => {});
    }
    return p;
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__lat = { m, u: String(u) }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__lat || {};
    if (/:5000|:3001/.test(info.u || '')) {
      const t0 = now();
      this.addEventListener('loadend', () => push({ t: t0, t_done: now(), dir: 'xhr', url: (info.u || '').slice(0, 120),
        method: info.m, status: this.status, body: typeof body === 'string' ? body.slice(0, 2000) : undefined }));
    }
    return XS.apply(this, arguments);
  };
})();
