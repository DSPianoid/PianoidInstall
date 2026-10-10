// dev-2d06: chrome-devtools navigate_page `initScript` for an ISOLATED agent stack.
// Rewrites the FE's hard-coded :5000 (backend) / :3001 (launcher) URLs to the agent's
// spare ports so the agent tabs (origin localhost:3013) never talk to the user's stack,
// and seeds the fresh origin's localStorage so the startup auto-load has a preset.
(() => {
  const MAP = [[/(127\.0\.0\.1|localhost):5000/g, '$1:5012'], [/(127\.0\.0\.1|localhost):3001/g, '$1:3012']];
  const rw = (u) => { let s = String(u); for (const [re, to] of MAP) s = s.replace(re, to); return s; };
  const of = window.fetch;
  window.fetch = function (input, init) {
    if (input instanceof Request) input = new Request(rw(input.url), input);
    else input = rw(input);
    return of.call(this, input, init);
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { return oo.call(this, m, rw(u), ...rest); };
  const OW = window.WebSocket;
  function WS(u, p) { return p === undefined ? new OW(rw(u)) : new OW(rw(u), p); }
  WS.prototype = OW.prototype;
  Object.assign(WS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = WS;
  try {
    if (!localStorage.getItem('presetLoadSettings')) {
      localStorage.setItem('presetLoadSettings', JSON.stringify({
        path: 'presets/BaselinePreset1.json', volume: 100, sample_rate: 48, string_iterations: 4,
        number_of_modes: 64, use_simulation: 0, debug_mode: 0, cycle_iterations: 64,
        start_right_away: 1, audio_on: 1, listen_to_midi: 0, use_cuda: 1, audio_driver_type: 4,
        audio_buffer_size: 4, array_size: 384, listen_to_modes: 1, sound_derivative_order: 1,
      }));
      localStorage.setItem('lastPresetFileName', 'BaselinePreset1.json');
    }
  } catch (e) { /* ignore */ }
})();
