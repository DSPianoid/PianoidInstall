// lat-3636 page-side UI trial driver (evaluated in the agent page; needs ws_tap_initscript.js).
// window.__lat.trial(spec) -> {t_cap_req, wav, marks, frames} with epoch-ms timestamps.
// spec: {length_ms, anchor: {t, pitch, vel} | null, actions: [{t, kind, ...}], strikes: [{t, pitch, vel}]}
// action kinds: numinput {index, value} (native setter + input + Enter keydown, the NumInput commit),
//               slider_drag {label, from, to, dur_ms, hz} (mouse down/move/up on the MUI slider rail),
//               slider_key {label, key, n, gap_ms} (keyboard steps on the focused slider thumb)
(() => {
  const now = () => performance.timeOrigin + performance.now();
  const sleepUntil = async (t) => { while (now() < t - 4) await new Promise(r => setTimeout(r, Math.min(20, t - now() - 2))); while (now() < t) {} };
  const sio = () => {
    const s = window.__latTap.sockets.filter(x => /:5000\/socket\.io/.test(x.url) && x.ws.readyState === 1);
    return s.length ? s[s.length - 1].ws : null;
  };
  const rawEmit = (ev, payload) => { const ws = sio(); const t = now(); ws.send('42' + JSON.stringify([ev, payload])); return t; };
  const play = (pitch, vel, cmd) => rawEmit('play', { pitch, velocity: vel, command: cmd || 144 });
  const inputs = () => [...document.querySelectorAll('input')];
  const setNative = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const doNumInput = (a) => {
    const el = a.match ? inputs().filter(e => e.value === a.match)[0] : inputs()[a.index];
    el.focus();
    setNative(el, a.value);
    const t = now();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return t;
  };
  const sliderEl = (label) => [...document.querySelectorAll('[role=slider], input[type=range]')]
    .find(e => (e.getAttribute('aria-label') || '').startsWith(label) || (e.closest('.MuiSlider-root') && (e.getAttribute('aria-label') || '').startsWith(label)));
  const doSliderDrag = async (a) => {
    const thumbInput = sliderEl(a.label);
    const root = thumbInput.closest('.MuiSlider-root');
    const r = root.getBoundingClientRect();
    const xOf = (v) => r.left + r.width * (v - a.min) / (a.max - a.min);
    const y = r.top + r.height / 2;
    const opts = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    const t0 = now();
    root.dispatchEvent(new PointerEvent('pointerdown', opts(xOf(a.from))));
    root.dispatchEvent(new MouseEvent('mousedown', opts(xOf(a.from))));
    const steps = Math.max(1, Math.round(a.dur_ms * a.hz / 1000));
    const marks = [];
    for (let i = 1; i <= steps; i++) {
      await sleepUntil(t0 + i * 1000 / a.hz);
      const x = xOf(a.from + (a.to - a.from) * i / steps);
      document.dispatchEvent(new PointerEvent('pointermove', opts(x)));
      document.dispatchEvent(new MouseEvent('mousemove', opts(x)));
      marks.push(now());
    }
    const tUp = now();
    document.dispatchEvent(new PointerEvent('pointerup', { ...opts(xOf(a.to)), buttons: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { ...opts(xOf(a.to)), buttons: 0 }));
    return { t_down: t0, t_up: tUp, n_moves: marks.length, t_first_move: marks[0], t_last_move: marks[marks.length - 1] };
  };
  const doSliderKey = async (a) => {
    const el = sliderEl(a.label);
    el.focus();
    const ts = [];
    for (let i = 0; i < a.n; i++) {
      ts.push(now());
      el.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, code: a.key, bubbles: true }));
      if (a.gap_ms) await new Promise(r => setTimeout(r, a.gap_ms));
    }
    return { t_keys: ts };
  };
  async function trial(spec) {
    if (spec.reset !== false) {
      await fetch('http://127.0.0.1:5000/reset');
      await new Promise(r => setTimeout(r, spec.settle_ms || 1000));
    }
    window.__latTap.clear();
    const t_cap_req = now();
    const body = { mode: 'online', pitches: [127], velocity: 1, speed_ms_per_note: 2000, capture_mic: true,
                   tail_ms: Math.max(0, spec.length_ms - 2000) };
    const capP = fetch('http://127.0.0.1:5000/play_keyboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const ev = [];
    const plan = [];
    if (spec.anchor) plan.push({ t: spec.anchor.t, run: () => ({ kind: 'anchor', t_send: play(spec.anchor.pitch, spec.anchor.vel) }) });
    (spec.strikes || []).forEach(s => plan.push({ t: s.t, run: () => ({ kind: 'strike', t_send: play(s.pitch, s.vel) }) }));
    (spec.actions || []).forEach(a => plan.push({ t: a.t, run: async () => {
      if (a.kind === 'numinput') return { kind: 'numinput', t_action: doNumInput(a) };
      if (a.kind === 'slider_drag') return { kind: 'slider_drag', ...(await doSliderDrag(a)) };
      if (a.kind === 'slider_key') return { kind: 'slider_key', ...(await doSliderKey(a)) };
      return { kind: 'unknown' };
    } }));
    plan.sort((x, y) => x.t - y.t);
    for (const p of plan) { await sleepUntil(t_cap_req + p.t); ev.push(await p.run()); }
    const cap = await capP;
    if (spec.anchor) play(spec.anchor.pitch, 0, 128);
    (spec.strikes || []).forEach(s => play(s.pitch, 0, 128));
    const frames = window.__latTap.frames.filter(f => f.t >= t_cap_req - 50 && (f.dir !== 'in' || /^43|^42\["(state_changed|param_ack|error)/.test(f.data)))
      .map(f => ({ t: f.t, t_done: f.t_done, dir: f.dir, url: f.url, d: (f.data || f.body || '').slice(0, 300) }));
    return { t_cap_req, wav: cap.mic_wav_path, n: cap.mic_samples, ev, frames };
  }
  window.__lat = { trial, play, rawEmit, inputs, now };
  return 'ok';
})();

// batch helper: excitation-style trials (UI edit at 300 ms, strike at 300+d), undo after each.
(() => {
  window.__lat.excBatch = async (cfg) => {
    const out = [];
    for (const d of cfg.delays) {
      const spec = { length_ms: cfg.length_ms || 2500, anchor: null,
        actions: cfg.noAction ? [] : [{ t: 300, kind: 'numinput', index: cfg.index, value: cfg.value }],
        strikes: [{ t: 300 + d, pitch: cfg.pitch || 60, vel: cfg.vel || 127 }] };
      const r = await window.__lat.trial(spec);
      r.d = d;
      if (!cfg.noAction) {
        const u = await fetch('http://127.0.0.1:5000/history/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: cfg.undoDomains || ['excitation'] }) });
        r.undo_status = u.status;
        await new Promise(res => setTimeout(res, 400));
        r.value_after_undo = window.__lat.inputs()[cfg.index].value;
      }
      out.push(r);
    }
    return out;
  };
  return 'ok2';
})();

// emit-only measurement (no audio): action -> first outgoing write frame -> ack; long tasks via PerformanceObserver.
(() => {
  const L = window.__lat;
  if (!window.__latLong) {
    window.__latLong = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach(e => window.__latLong.push({ t: performance.timeOrigin + e.startTime, dur: e.duration }))).observe({ type: 'longtask', buffered: false }); } catch (e) {}
  }
  L.emitOnly = async (action, waitMs, undoDomains) => {
    window.__latTap.clear(); window.__latLong.length = 0;
    let a;
    if (action.kind === 'numinput') {
      const cands = L.inputs().filter(e => e.value === action.match);
      if (cands.length !== 1) return { error: 'match ' + action.match + ' -> ' + cands.length };
      const el = cands[0]; el.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(action.value)); el.dispatchEvent(new Event('input', { bubbles: true }));
      const t = L.now(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      a = { t_action: t, before: action.before };
    } else if (action.kind === 'wheel') {
      const el = L.inputs()[action.index]; el.focus();
      const t = L.now(); el.dispatchEvent(new WheelEvent('wheel', { deltaY: action.deltaY || -100, bubbles: true, cancelable: true }));
      a = { t_action: t };
    } else if (action.kind === 'click') {
      const el = document.querySelector(action.selector); const t = L.now(); el.click(); a = { t_action: t };
    }
    await new Promise(r => setTimeout(r, waitMs || 1500));
    const fr = window.__latTap.frames.map(f => ({ dt: +(f.t - a.t_action).toFixed(1), dir: f.dir, url: (f.url || '').slice(-30), d: (f.data || f.body || '').slice(0, 160), done: f.t_done ? +(f.t_done - a.t_action).toFixed(1) : undefined }))
      .filter(f => !(f.dir === 'in' && /"type":"log"/.test(f.d)));
    const lt = window.__latLong.map(e => ({ dt: +(e.t - a.t_action).toFixed(1), dur: +e.dur.toFixed(1) }));
    let undo;
    if (undoDomains) { const u = await fetch('http://127.0.0.1:5000/history/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: undoDomains }) }); undo = u.status; await new Promise(r => setTimeout(r, 600)); }
    const logs = window.__latTap.frames.filter(f => f.dir === 'in' && /"type":"log"/.test(f.data)).length;
    return { a, frames: fr, longtasks: lt, undo, console_log_frames: logs };
  };
  return 'ok3';
})();

// long capture around REAL (CDP) input: startLong() -> do click/fill/Enter via tools -> finishLong()
(() => {
  const L = window.__lat;
  L.startLong = async (length_ms, anchor) => {
    await fetch('http://127.0.0.1:5000/reset'); await new Promise(r => setTimeout(r, 1000));
    window.__latTap.clear();
    const t_cap_req = L.now();
    const body = { mode: 'online', pitches: [127], velocity: 1, speed_ms_per_note: 2000, capture_mic: true, tail_ms: length_ms - 2000 };
    L._long = { t_cap_req, p: fetch('http://127.0.0.1:5000/play_keyboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()), ev: [] };
    await new Promise(r => setTimeout(r, 300));
    L._long.ev.push({ kind: 'anchor', t_send: L.play(anchor.pitch, anchor.vel) });
    return 'started';
  };
  L.finishLong = async () => {
    const cap = await L._long.p;
    const T = window.__latTap;
    L.play(60, 0, 128);
    const ev = L._long.ev.concat(T.marks.filter(m => m.label === 'enter' && m.trusted).map(m => ({ kind: 'numinput', t_action: m.t, val: m.val })));
    const frames = T.frames.filter(f => f.dir === 'out' || (f.dir === 'in' && /^43|state_changed/.test(f.data))).map(f => ({ t: f.t, dir: f.dir, url: f.url, d: (f.data || '').slice(0, 300) }));
    T.clear();
    return { t_cap_req: L._long.t_cap_req, wav: cap.mic_wav_path, n: cap.mic_samples, ev, frames };
  };
  return 'ok4';
})();
