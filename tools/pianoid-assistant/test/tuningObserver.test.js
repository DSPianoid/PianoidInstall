// dev-tuneskill observe mode: the observer turns a recorded broadcast into steps (edits grouped by renders, before
// -> after from the seed and the stream, the assistant's own writes ignored, merged / contaminated / preset_changed
// flags, the render plan per step), the read-only socket.io client (handshake, ping, hello replay, dedupe,
// reconnect), and the tools on the library gate (observe = view; observe_describe = rule library, only for a
// rendered step; tuning_record attaches the observed steps; lexicon_get taints on tainted evidence).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TuningObserver, diffLabel, valueOf } from '../service/tuningObserver.js';
import { JournalStream, socketUrl } from '../service/journalStream.js';
import { LIBRARY_CMDS, TOOLS, TuningLibrary } from '../service/tuningLibrary.js';
import { decide } from '../policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'journal', 'observe-session.json'), 'utf8'));

/** An observer on a fake clock + a fake stream; `play(until)` feeds the recorded events up to `until` ms. */
async function recorded({ pitches = [60], velocities = [95, 60] } = {}) {
  let t = 0;
  let onEvent = null;
  const closed = [];
  const fetchImpl = async (url) => {
    const key = url.replace('http://backend/get_parameter/', '');
    return FIX.seed[key] ? { ok: true, status: 200, json: async () => FIX.seed[key] } : { ok: false, status: 404, json: async () => ({}) };
  };
  const obs = new TuningObserver({ backendUrl: 'http://backend', fetchImpl, now: () => t,
    streamFactory: (opts) => { onEvent = opts.onEvent; return { close: () => closed.push(true) }; } });
  const started = await obs.start({ operator: 'leonid', pitches, velocities, duration_ms: 3000, gap_s: 6 });
  let i = 0;
  const play = (until) => {
    for (; i < FIX.events.length && FIX.events[i].at_ms <= until; i += 1) {
      t = FIX.events[i].at_ms;
      onEvent(FIX.events[i].event, FIX.events[i].payload);
    }
    t = until;
  };
  return { obs, started, play, closed, setTime: (v) => { t = v; } };
}

test('helpers: the value of a key in an `after` (flat and per-field), and the before -> after label', () => {
  assert.deepEqual(valueOf({ 60: { a: 1 } }, '60'), { a: 1 });
  assert.deepEqual(valueOf({ hammer_mass: { 60: 0.01 }, hammer_speeds: { 61: [1] } }, '60'), { hammer_mass: 0.01 });
  assert.equal(valueOf(null, '60'), undefined);
  assert.equal(diffLabel({ tension: 812.4, length: 0.62 }, { tension: 815, length: 0.62 }), 'tension 812.4 -> 815');
  assert.equal(diffLabel([1, 2, 3], [1, 5, 3]), '[1] 2 -> 5');
  assert.match(diffLabel(undefined, { x: 1 }), /before not observed/);
  assert.match(diffLabel({ x: 1 }, undefined), /more than 16 keys/);
});

test('start: seeds the focus pitches, baseline step 0 awaits its render, the todo says so', async () => {
  const { started } = await recorded();
  assert.equal(started.ok, true);
  assert.match(started.id, /^obs\d{8}[0-9a-f]{4}$/);
  assert.equal(started.steps[0].status, 'awaiting_render');
  assert.deepEqual(started.steps[0].render.tags, [`obs-${started.id}`, 'step-0']);
  assert.match(started.todo[0], /render the baseline now/);
  assert.deepEqual(started.seed_errors, []);
  assert.deepEqual(started.render_settings, { duration_ms: 3000, observe: started.id });
});

test('recorded session: steps delimited by renders, seed + stream before values, own writes ignored, flags, plans', async () => {
  const { obs, play, closed } = await recorded();
  play(12500);
  let v = obs.view();
  assert.equal(v.steps[0].status, 'rendered');
  assert.equal(v.steps[0].renders_seen, 2);
  assert.equal(v.assistant_edits_ignored, 1);
  const s1 = v.steps[1];
  assert.equal(s1.status, 'open');
  assert.deepEqual(s1.edits.map((e) => e.label), ['string [60] tension 812.4 -> 815', 'string [60] dispersion_damping 8e-15 -> 4e-15']);
  assert.deepEqual(s1.edits.map((e) => e.source), ['fe', 'fe']);
  play(18000);
  v = obs.view();
  assert.equal(v.steps[1].status, 'ready_to_render');
  assert.deepEqual(v.steps[1].render.pitches, [60]);
  assert.deepEqual(v.steps[1].render.tags.slice(1), ['step-1']);
  assert.ok(v.todo.some((t) => t.startsWith('render step 1: pitches 60 x velocities 95, 60')));
  play(29000);
  v = obs.view();
  assert.equal(v.steps[1].status, 'rendered');
  assert.deepEqual(v.steps[1].flags, []);
  assert.ok(v.todo.includes("observe_describe step 1 with the operator's words"));
  play(60000);
  v = obs.view();
  const [, , s2, s3] = v.steps;
  // an edit after the quiet gap but before any render joins the step (merged); the per-field `after` resolves
  assert.deepEqual(s2.flags, ['merged', 'contaminated']);
  assert.match(s2.edits[0].label, /^hammer \[60\] hammer_width 0\.03 -> 0\.038, hammer_width_effective 0\.03 -> 0\.038, hammer_radius 0\.015 -> 0\.019$/);
  assert.equal(s2.edits[1].label, 'excitation_energy [60] -> {"hammer_mass":0.0105} (before not observed)');
  assert.equal(s2.edits[1].source, 'midi_cc');
  // the mode edit landed after only 1 of step 2's 2 renders: both steps are contaminated; a shared domain renders the focus
  assert.deepEqual(s3.flags, ['contaminated']);
  assert.equal(s3.render.shared, true);
  assert.deepEqual(s3.render.pitches, [60]);
  assert.match(v.todo.find((t) => t.startsWith('step 2')), /contaminated: its delta is not trusted/);
  play(90000);
  v = obs.view();
  const s4 = v.steps[4];
  assert.equal(s4.edits.length, 17);
  assert.match(s4.edits[0].label, /values not in the event/);
  assert.deepEqual(s4.flags, ['contaminated', 'preset_changed']);
  assert.deepEqual(s4.render.pitches, [40, 41, 42, 43, 44, 45, 46, 47, 60]);
  assert.deepEqual(s4.render.no_before, [40, 41, 42, 43, 44, 45, 46, 47]);
  const stopped = obs.stop();
  assert.equal(stopped.ok, true);
  assert.deepEqual(stopped.undescribed, [1, 2, 3, 4]);
  assert.equal(closed.length, 1);
  assert.equal(obs.view().observing, false);
  assert.equal(obs.recordSteps(stopped.id).length, 4);
  assert.equal(obs.find(stopped.id).id, stopped.id);
});

test('an edit before the baseline render is flagged; one session at a time; the 4 h limit stops it', async () => {
  const { obs, setTime } = await recorded();
  // a level-only change (the volume slider) is not a step: a peak-normalised render cannot hear it
  obs.ingest('state_changed', { entry: null, domain: 'runtime', keys: ['volume'], after: { volume: 80 }, source: { kind: 'midi_cc' } });
  assert.equal(obs.view().steps.length, 1);
  assert.equal(obs.view().level_only_ignored, 1);
  obs.ingest('state_changed', { domain: 'string', keys: [60], after: { 60: { tension: 820 } }, source: { kind: 'fe' } });
  // the hammer / bow switch of a key arrives as session state and is an edit of that key
  obs.ingest('session_changed', { domain: 'excitation_mode', keys: [60], after: { 60: 1 }, source: { kind: 'fe' } });
  obs.ingest('session_changed', { domain: 'mic', keys: null, after: null, source: { kind: 'fe' } });
  assert.deepEqual(obs.view().steps[1].flags, ['no_baseline_render']);
  assert.deepEqual(obs.view().steps[1].edits.map((e) => e.domain), ['string', 'excitation_mode']);
  assert.deepEqual(obs.plan(obs.session, obs.session.steps[1]).pitches, [60]);
  assert.match((await obs.start({ operator: 'x', pitches: [60] })).error, /already observing/);
  setTime(4 * 3600 * 1000 + 1);
  const v = obs.view();
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'the 4 h limit');
  assert.equal(obs.session, null);
});

test('JournalStream: socket.io handshake, ping, events, hello replay after a reconnect, dedupe, gap on resync', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise((r) => wss.on('listening', () => r(wss.address().port)));
  const hellos = [];
  let conn = 0;
  wss.on('connection', (ws) => {
    conn += 1;
    const n = conn;
    ws.on('message', (raw) => {
      const m = String(raw);
      if (m === '40') ws.send('40{"sid":"s"}');
      if (m === '3') ws.send(`42${JSON.stringify(['state_changed', { seq: 7, domain: 'string', keys: [60] }])}`);
      const hello = /^42(\d+)(\[.*\])$/.exec(m);
      if (!hello) return;
      hellos.push(JSON.parse(hello[2])[1]);
      if (n === 1) {
        ws.send(`43${hello[1]}${JSON.stringify([{ ok: true, boot: 'b1', seq: 5, resync: true }])}`);
        ws.send(`42${JSON.stringify(['state_changed', { seq: 6, domain: 'mode', keys: [5] }])}`);
        ws.send('2');
      } else if (n === 2) {
        ws.send(`43${hello[1]}${JSON.stringify([{ ok: true, boot: 'b1', seq: 9, events: [{ event: 'state_changed', payload: { seq: 7 } }, { event: 'engine_busy', payload: { seq: 8, phase: 'start' } }] }])}`);
      } else {
        ws.send(`43${hello[1]}${JSON.stringify([{ ok: true, boot: 'b2', seq: 0, resync: true }])}`);
      }
    });
    ws.send('0{"sid":"e","pingInterval":25000}');
  });
  const got = [];
  const states = [];
  const st = new JournalStream({ url: `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, onEvent: (n, p) => got.push([n, p.seq]), onState: (s) => states.push(s), retryMs: 20 }).start();
  const until = async (fn) => { for (let k = 0; k < 200 && !fn(); k += 1) await new Promise((r) => setTimeout(r, 10)); assert.ok(fn()); };
  await until(() => got.length === 2);
  assert.deepEqual(got, [['state_changed', 6], ['state_changed', 7]]);
  assert.deepEqual(hellos[0], { clientId: hellos[0].clientId, boot: null, lastSeq: null });
  for (const c of wss.clients) c.terminate();
  await until(() => got.length === 3);
  assert.deepEqual(hellos[1].boot, 'b1');
  assert.equal(hellos[1].lastSeq, 7);
  assert.deepEqual(got[2], ['engine_busy', 8]);        // seq 7 replayed again is dropped
  for (const c of wss.clients) c.terminate();
  await until(() => states.includes('gap'));
  st.close();
  wss.close();
  assert.equal(socketUrl('http://127.0.0.1:5000'), 'ws://127.0.0.1:5000/socket.io/?EIO=4&transport=websocket');
});

/** The library on a recorded observer: the gate, the CLI calls, the attached steps. */
function fakeSession({ rules = {}, answer = true, tainted = false } = {}) {
  const s = {
    tainted, backendUrl: 'http://backend', activity: [], audits: [], asked: [], taints: [],
    verdict: (cmd) => decide({ command: cmd.name, title: cmd.title, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, attrs: {}, settings: { rules, tainted: s.tainted } }),
    logActivity: (f) => { const e = { id: `a${s.activity.length + 1}`, ...f }; s.activity.push(e); return e; },
    ask: async (entry, cmd) => { s.asked.push(cmd.name); return answer; },
    audit: { write: (ev, data) => s.audits.push({ ev, ...data }) },
    taintTurn: (why) => { s.tainted = true; s.taints.push(why); },
  };
  return s;
}

test('tools: observe is a read; observe_describe asks under rule library, only for a rendered step, and passes the step', async () => {
  assert.equal(LIBRARY_CMDS[TOOLS.describe].approval_category, 'library');
  const { obs, play } = await recorded();
  const calls = [];
  const run = async (py, args) => {
    calls.push(args);
    if (args[2] === 'observe') {
      return { ok: true, observation: { id: 'o-1', phrases: ['warmer'], traits: { centroid_body_pct: -14 }, flags: [], pairs: [{ pitch: 60, velocity: 95, before: 'b', after: 'a', traits: {} }] },
        comparable_pairs: 1, lexicon: { warmer: { summary: 'spectral centroid 100-400 ms -14 % (1/1) [1 observation, single observation]' } } };
    }
    return { ok: true, id: 't-1', draft: 'd', verdict: 'kept' };
  };
  const lib = new TuningLibrary(fakeSession(), { artifactsDir: 'A', root: 'R', python: 'py', run, observer: obs, fetchImpl: async () => ({ json: async () => ({ undo: ['x (fe)'], entry: 'E' }) }) });
  assert.equal((await lib.canUse(TOOLS.observe, { action: 'status' })).behavior, 'allow');
  const st = JSON.parse(await lib.call(TOOLS.observe, { action: 'status' }));
  assert.equal(st.observing, true);
  play(12500);
  const input = { step: 1, description: 'warmer, but a bit too woody', verdict: 'kept' };
  const early = await lib.canUse(TOOLS.describe, input);
  assert.equal(early.behavior, 'deny');
  assert.match(early.message, /step 1 is not rendered yet/);
  assert.equal(lib.session.asked.length, 0);
  play(29000);
  assert.equal((await lib.canUse(TOOLS.describe, input)).behavior, 'allow');
  assert.deepEqual(lib.session.asked, ['library.observe_describe']);
  const out = JSON.parse(await lib.call(TOOLS.describe, input));
  assert.equal(out.ok, true);
  assert.equal(out.lexicon.warmer, 'spectral centroid 100-400 ms -14 % (1/1) [1 observation, single observation]');
  const sent = JSON.parse(calls[0][calls[0].indexOf('--json') + 1]);
  assert.equal(sent.operator, 'leonid');
  assert.equal(sent.step, 1);
  assert.equal(sent.observe_id, obs.session.id);
  assert.equal(sent.description, 'warmer, but a bit too woody');
  assert.deepEqual(sent.edits.map((e) => e.label), ['string [60] tension 812.4 -> 815', 'string [60] dispersion_damping 8e-15 -> 4e-15']);
  assert.equal(JSON.parse(await lib.call(TOOLS.describe, input)).error, 'not_permitted');
  assert.equal(obs.view().todo.some((t) => t.includes('observe_describe step 1')), false);
  // no session / unknown step / bad verdict are denied before any dialog
  assert.match((await lib.canUse(TOOLS.describe, { step: 9, description: 'x' })).message, /has no step 9/);
  assert.match((await lib.canUse(TOOLS.describe, { step: 1, description: 'x', verdict: 'great' })).message, /verdict/);
  // tuning_record of the session: the host attaches the operator, the steps and the described observations
  const id = obs.session.id;
  JSON.parse(await lib.call(TOOLS.observe, { action: 'stop' }));
  const rec = { description: 'Leonid voiced C4 by hand', observe_id: id, verdict: 'kept' };
  assert.equal((await lib.canUse(TOOLS.record, rec)).behavior, 'allow');
  await lib.call(TOOLS.record, rec);
  const recorded2 = JSON.parse(calls.at(-1)[calls.at(-1).indexOf('--json') + 1]);
  assert.equal(recorded2.operator, 'leonid');
  assert.deepEqual(recorded2.observations, ['o-1']);
  assert.equal(recorded2.observed_steps[0].edits.length, 2);
  assert.deepEqual(recorded2.user_edits, ['x (fe)']);
  assert.match((await lib.canUse(TOOLS.record, { description: 'x', observe_id: 'obs-nope' })).message, /no observe session/);
});

test('tools: observe start validates the operator and pitches; lexicon_get wraps as data and taints on tainted evidence', async () => {
  const obs = new TuningObserver({ backendUrl: 'http://backend', fetchImpl: async () => ({ ok: false, status: 404 }), streamFactory: () => ({ close() {} }) });
  const calls = [];
  const run = async (py, args) => { calls.push(args); return { ok: true, operator: 'leonid', observations: 3, versioned: 2, local_only: 1, phrases: 1, tainted: true, query: ['warmer'], exact: { warmer: { summary: 's', n: 3, confidence: 'low', contradictions: [], pitches: [60], verdicts: { kept: 3 } } }, near: {} }; };
  const lib = new TuningLibrary(fakeSession(), { artifactsDir: 'A', root: 'R', python: 'py', run, observer: obs });
  assert.match(JSON.parse(await lib.call(TOOLS.observe, { action: 'start', operator: '!!', pitches: [60] })).error, /operator/);
  assert.match(JSON.parse(await lib.call(TOOLS.observe, { action: 'start', operator: 'Leonid', pitches: [] })).error, /pitches/);
  const ok = JSON.parse(await lib.call(TOOLS.observe, { action: 'start', operator: 'Leonid', pitches: [60, 67] }));
  assert.equal(ok.operator, 'leonid');
  assert.equal(ok.seed_errors.length, 6);                 // a backend without the route: noted, not fatal
  assert.equal(lib.session.audits[0].op, 'start');
  const text = await lib.call(TOOLS.lexicon, { operator: 'leonid', phrase: 'a bit warmer' });
  assert.match(text, /^<library untrusted="true">/);
  assert.deepEqual(calls[0].slice(2), ['lexicon', '--operator', 'leonid', '--phrase', 'a bit warmer']);
  assert.equal(lib.session.tainted, true);
  assert.equal((await lib.canUse(TOOLS.lexicon, { operator: 'leonid' })).behavior, 'allow');
});
