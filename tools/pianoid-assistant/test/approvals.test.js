// Assistant v2 P2 (dev-4324): per-category approvals, the hard-confirm list, the A2 envelope, the
// level watch with auto-revert and grouped undo — the policy table on the REAL registry + limits,
// and the service end to end (fake driver -> real MCP server -> the service executor -> fake :5000).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { decide, HARD_CONFIRM } from '../policy.js';
import { applyChange, CATEGORIES, describe, modeOf } from '../approvals.js';
import { check, levelBreach, revertPlan } from '../envelope.js';
import { loadCommands } from '../lib/registry.js';
import { loadLimits } from '../lib/paramLimits.js';
import { canonical } from '../service/autoWrite.js';
import { createAssistantService } from '../service/server.js';
import { FakeDriver } from '../drivers/fake.js';

const COMMANDS = loadCommands();
const LIMITS = loadLimits();
const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
const ALL_AUTO = Object.fromEntries([...CATEGORIES.map((c) => c.id), 'hard_confirm', 'excluded'].map((id) => [id, 'auto']));
const dec = (name, settings = {}) => {
  const c = byName[name];
  return decide({ command: c.name, tier: c.tier, family: c.family, category: c.approval_category, settings });
};

test('every registry command has a category; the §9 defaults on the real registry', () => {
  for (const c of COMMANDS) assert.ok(c.approval_category, c.name);
  for (const n of ['ui.pane.open', 'param.get', 'system.snapshot', 'play.note', 'render.note_playback', 'job.cancel']) {
    assert.equal(dec(n).action, 'allow', n);
  }
  for (const n of ['param.set', 'param.mute_modes', 'runtime.set', 'preset.switch', 'history.undo']) {
    const v = dec(n);
    assert.equal(v.action, 'confirm', n);
    assert.equal(v.canAuto, true, n);                  // the dialog may offer "Don't ask again"
  }
  assert.equal(dec('launcher.backend.stop').action, 'deny');
});

test('the hard-confirm list can NEVER be Auto (every scope set to auto, envelope ok)', () => {
  const settings = { approvals: { installation: ALL_AUTO, session: ALL_AUTO }, envelope: { ok: true, reason: 'x' } };
  const hard = COMMANDS.filter((c) => c.approval_category === 'hard_confirm').map((c) => c.name);
  assert.deepEqual(hard.sort(), Object.keys(HARD_CONFIRM).filter((n) => byName[n]).sort());
  for (const n of ['preset.save', 'preset.promote', 'preset.unload', 'preset.load', 'calibration.synthesis',
    'calibration.acoustic', 'modal.run_stage', 'modal.apply_to_preset', 'launcher.backend.start', 'launcher.modal.start']) {
    const v = dec(n, settings);
    assert.equal(v.action, 'confirm', n);
    assert.equal(v.hard, true, n);
    assert.ok(!v.canAuto, n);
  }
  // tools that do not exist yet are pinned by name, whatever category they arrive with
  for (const n of ['audio.session', 'audio.test_tone']) {
    assert.equal(decide({ command: n, tier: 'write', family: 'x', category: 'params', settings }).action, 'confirm', n);
  }
  // a web-tainted turn: every non-read asks hard, reads still run
  assert.equal(dec('param.mute_modes', { ...settings, tainted: true }).hard, true);
  assert.equal(dec('play.note', { ...settings, tainted: true }).action, 'confirm');
  assert.equal(dec('param.get', { ...settings, tainted: true }).action, 'allow');
});

test('Auto params / runtime need the envelope: inside -> allow + watch; outside -> hard confirm', () => {
  const approvals = { installation: { params: 'auto', runtime: 'auto' }, session: {} };
  const inside = dec('param.mute_modes', { approvals, envelope: { ok: true, reason: 'mask switch' } });
  assert.deepEqual([inside.action, inside.auto, inside.watch], ['allow', true, true]);
  const outside = dec('runtime.set', { approvals, envelope: { ok: false, reason: 'outside the envelope: volume +10' } });
  assert.deepEqual([outside.action, outside.hard], ['confirm', true]);
  assert.equal(dec('param.set', { approvals }).action, 'confirm');                 // no envelope verdict = ask
  assert.equal(dec('preset.switch', { approvals: { installation: { preset_nav: 'auto' } } }).action, 'allow');
});

test('approvals: scopes, precedence, locked categories, the pane view', () => {
  let st = { installation: {}, session: {} };
  assert.equal(modeOf('params', st), 'ask');
  st = applyChange(st, { category: 'params', mode: 'auto', scope: 'session' });
  assert.equal(modeOf('params', st), 'auto');
  assert.deepEqual(st.installation, {});
  st = applyChange(st, { category: 'params', mode: 'ask', scope: 'installation' });
  assert.equal(modeOf('params', st), 'ask');                // the installation change drops the session override
  assert.deepEqual(st.session, {});
  for (const c of ['view', 'code', 'hard_confirm', 'excluded', 'nope']) {
    assert.throws(() => applyChange(st, { category: c, mode: 'auto' }), /cannot be changed/, c);
  }
  assert.throws(() => applyChange(st, { category: 'params', mode: 'always' }), /mode/);
  assert.equal(modeOf('code', { installation: { code: 'auto' } }), 'ask');       // V1: no sandbox yet
  assert.equal(modeOf('view', { installation: { view: 'ask' } }), 'auto');
  const view = describe({ installation: { runtime: 'auto' }, session: { params: 'auto' } });
  assert.deepEqual(view.autoActive, ['params', 'runtime']);
  assert.equal(view.categories.find((r) => r.id === 'params').scope, 'session');
  assert.equal(view.categories.find((r) => r.id === 'runtime').scope, 'installation');
  assert.equal(view.categories.length, 11);
});

test('envelope limits come from schemas/params; UNKNOWN limits stay outside', () => {
  assert.deepEqual(Object.keys(LIMITS.fields).sort(), ['mode.decrement', 'runtime.feedback_coeff', 'runtime.volume']);
  assert.deepEqual([...LIMITS.masks].sort(), ['param.mute_channels', 'param.mute_modes']);
  assert.equal(LIMITS.global.max_keys_per_command, 128);
  const rt = { '/get_runtime_parameters': { volume_level: 64, deck_feedback_coefficient: 1.0 }, '/health': { stored_feedback_coeff: 1.0 } };
  const rs = (input, before = rt, autoWrites = 0) => check({ cmd: byName['runtime.set'], input, before, limits: LIMITS, autoWrites });
  assert.equal(rs({ volume: 70 }).ok, true);
  assert.match(rs({ volume: 71 }).reason, /\+7; at most \+6/);
  assert.equal(rs({ volume: 10 }).ok, true);                                    // down is free
  assert.equal(rs({ volume: 128 }).ok, false);
  assert.equal(rs({ feedback_coeff: 1.5 }).ok, true);
  assert.equal(rs({ feedback_coeff: 1.6 }).ok, false);
  assert.equal(rs({ feedback_coeff: 0.6 }).ok, false);                          // lower = louder: bounded too
  assert.match(rs({ feedback_coeff: 2.1 }, { ...rt, '/get_runtime_parameters': { volume_level: 64, deck_feedback_coefficient: 1.5 } }).reason, /of the stored/);
  assert.match(rs({ feedback: 70 }).reason, /feedback has no documented limit/);
  assert.match(rs({ volume_center: 2 }).reason, /no documented limit/);
  assert.match(rs({ volume: 60 }, rt, 20).reason, /20 automatic writes/);
  const mode = (values, now) => check({ cmd: byName['param.set'], input: { parameter: 'mode', key_no: '5', values }, before: { '/get_parameter/mode/5': now }, limits: LIMITS });
  assert.equal(mode({ 5: { decrement: 0.6 } }, { 5: { decrement: 1.0, frequency: 100 } }).ok, true);
  assert.match(mode({ 5: { decrement: 0.4 } }, { 5: { decrement: 1.0 } }).reason, /x0.40/);
  assert.match(mode({ 5: { frequency: 90 } }, { 5: { decrement: 1.0 } }).reason, /frequency has no documented limit/);
  assert.equal(mode({ 5: { decrement: 0.5 } }, { 5: { decrement: 0 } }).ok, false);
  for (const parameter of ['string', 'hammer', 'feedin', 'feedback_mask', 'gauss']) {
    assert.equal(check({ cmd: byName['param.set'], input: { parameter, key_no: '60', values: {} }, limits: LIMITS }).ok, false, parameter);
  }
  assert.equal(check({ cmd: byName['param.mute_modes'], input: { modes: [0, 1], action: 'solo' }, limits: LIMITS }).ok, true);
  assert.equal(check({ cmd: byName['param.mute_modes'], input: { modes: Array.from({ length: 129 }, (_, i) => i) }, limits: LIMITS }).ok, false);
  assert.deepEqual(revertPlan(byName['runtime.set'], { volume: 70 }, rt), { kind: 'runtime', values: { volume: 64 } });
  assert.deepEqual(revertPlan(byName['param.mute_modes'], {}, {}), { kind: 'history' });
});

test('level breach rule (REST_API /health): new clip, clip now, gate trip, peak above target + 3 dB', () => {
  const base = { clipping: false, peak_level: 0.1, gate_trip_count: 0, output_scale: { target_dbfs: -20 } };
  assert.equal(levelBreach(base, { ...base }, LIMITS), null);
  assert.match(levelBreach(base, { ...base, clipping: true }, LIMITS), /clipped/);
  assert.match(levelBreach(base, { ...base, clipping_now: true }, LIMITS), /clipping now/);
  assert.match(levelBreach(base, { ...base, gate_trip_count: 2 }, LIMITS), /guard tripped \(2/);
  assert.match(levelBreach(base, { ...base, peak_level: 0.2 }, LIMITS), /above the target -20 dBFS \+ 3 dB/);   // -14 dBFS > -17
  assert.equal(levelBreach(base, { ...base, peak_level: 0.13 }, LIMITS), null);                                // -17.7 dBFS
  assert.equal(levelBreach({ ...base, clipping: true }, { ...base, clipping: true }, LIMITS), null);         // already latched
  assert.equal(levelBreach(base, { unreachable: true }, LIMITS), null);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 0 }] }), canonical({ a: [2, { c: 0, d: 1 }], b: 1 }));
});

// ---- the service end to end ------------------------------------------------------------------

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-assistant-p2-'));

function fakeBackend() {
  const calls = [];
  const state = { volume: 64, clipAfterWrite: false, wrote: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, group: req.headers['x-pianoid-group'], body });
      res.setHeader('Content-Type', 'application/json');
      const send = (o, status = 200) => { res.statusCode = status; res.end(JSON.stringify(o)); };
      if (req.url === '/health') {
        return send({ status: 'healthy', pianoid_loaded: true, clipping: state.clipAfterWrite && state.wrote, peak_level: 0.1, gate_trip_count: 0, stored_feedback_coeff: 1.0, output_scale: { target_dbfs: -20 } });
      }
      if (req.url === '/get_runtime_parameters') return send({ volume_level: state.volume, deck_feedback_coefficient: 1.0 });
      if (req.url === '/history/undo') return send({ entry: 'P', label: 'feedin_mask (assistant)', steps: 1 });
      if (req.url === '/command/runtime.set') {
        state.volume = JSON.parse(body).volume ?? state.volume;
        state.wrote = true;
        return send({ ok: true, status: 200, result: { updated: JSON.parse(body) } });
      }
      if (req.url.startsWith('/command/param.')) {
        state.wrote = true;
        return send({ ok: true, status: 200, result: { done: req.url } });
      }
      if (req.url.endsWith('/ui.snapshot')) return send({ ok: true, status: 200, result: { panes: [] } });
      return send({ ok: true, status: 200, result: {} });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const SCRIPT = [
  { match: 'solo', steps: [{ tool: 'mcp__pianoid__param__mute_modes', input: { modes: [0, 1], action: 'solo' } }, { say: 'Soloed.' }] },
  { match: 'louder a lot', steps: [{ tool: 'mcp__pianoid__runtime__set', input: { volume: 80 } }, { say: 'Done.' }] },
  { match: 'louder', steps: [{ tool: 'mcp__pianoid__runtime__set', input: { volume: 68 } }, { say: 'Done.' }] },
  { match: 'save', steps: [{ tool: 'mcp__pianoid__preset__save', input: { path: 'presets/x.json' } }, { say: 'Saved.' }] },
];

async function start(home, fake) {
  const svc = createAssistantService({
    env: { ...process.env, ANTHROPIC_API_KEY: '', PIANOID_ASSISTANT_HOME: home, PIANOID_BACKEND_URL: fake.url, PIANOID_LAUNCHER_URL: fake.url },
    port: 0, driver: 'fake', driverFactory: () => new FakeDriver({ script: SCRIPT }), settleMs: 10,
  });
  const port = await svc.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));
  const waitFor = async (pred, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout; got ${msgs.map((x) => x.type).join(',')}`);
  };
  const turn = async (text) => {
    msgs.length = 0;
    send({ type: 'turn', text });
  };
  const idle = () => waitFor((m) => m.type === 'busy' && m.busy === false);
  const close = async () => { ws.close(); await svc.close(); };
  return { svc, port, msgs, send, waitFor, turn, idle, close };
}

const activity = (t, command) => t.msgs.filter((m) => m.type === 'activity' && m.entry.command === command).map((m) => m.entry).pop();

test('service: Auto params run without a dialog under their own undo group; settings persist across a restart', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  let t = await start(home, fake);
  try {
    await t.turn('solo modes 0 and 1');
    const c = await t.waitFor((m) => m.type === 'confirm');                    // Ask by default
    assert.equal(c.category, 'params');
    assert.equal(c.canAuto, true);
    t.send({ type: 'confirm', id: c.id, allow: true, remember: 'session' });  // "Don't ask again" (this session)
    await t.idle();
    assert.equal(activity(t, 'approvals').reason, 'params -> auto (this session)');
    const cfg = path.join(home, 'config.json');
    assert.ok(!fs.existsSync(cfg) || !JSON.parse(fs.readFileSync(cfg, 'utf8')).approvals?.params);   // session only: not persisted
    await t.turn('solo again');
    await t.idle();
    assert.ok(!t.msgs.some((m) => m.type === 'confirm'));
    const call = fake.calls.filter((x) => x.url === '/command/param.mute_modes').pop();
    assert.match(call.group, /^assistant-[0-9a-f]{4}-t2-w1$/);
    const e = activity(t, 'param.mute_modes');
    assert.equal(e.decision, 'auto');
    assert.equal(e.groupId, call.group);
    assert.equal(e.undoable, true);
    // installation scope: written to config.json, survives a service restart
    t.send({ type: 'approvals', category: 'runtime', mode: 'auto', scope: 'installation' });
    await t.waitFor((m) => m.type === 'approvals');
    await t.close();
    t = await start(home, fake);
    t.send({ type: 'hello' });
    const st = await t.waitFor((m) => m.type === 'state');
    const rows = Object.fromEntries(st.approvals.categories.map((r) => [r.id, r]));
    assert.deepEqual([rows.runtime.mode, rows.runtime.scope], ['auto', 'installation']);
    assert.equal(rows.params.mode, 'ask');                                    // the session override ended
    assert.deepEqual(st.approvals.autoActive, ['runtime']);
  } finally { await t.close(); fake.server.close(); }
});

test('service: outside the envelope asks (hard); a hard-confirm command asks even with every category Auto', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { params: 'auto', runtime: 'auto', preset_nav: 'auto' } }));
  const t = await start(home, fake);
  try {
    await t.turn('louder a lot');                                             // 64 -> 80 = +16 > +6
    const c = await t.waitFor((m) => m.type === 'confirm');
    assert.equal(c.hard, true);
    assert.equal(c.canAuto, false);
    assert.match(c.reason, /\+16; at most \+6/);
    t.send({ type: 'confirm', id: c.id, allow: false });
    await t.idle();
    assert.ok(!fake.calls.some((x) => x.url === '/command/runtime.set'));
    await t.turn('save it');
    const s = await t.waitFor((m) => m.type === 'confirm');
    assert.deepEqual([s.command, s.hard], ['preset.save', true]);
    t.send({ type: 'confirm', id: s.id, allow: false });
    await t.idle();
  } finally { await t.close(); fake.server.close(); }
});

test('service: a level breach after an Auto write auto-reverts (history group; runtime before-values)', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { params: 'auto', runtime: 'auto' } }));
  fake.state.clipAfterWrite = true;
  const t = await start(home, fake);
  try {
    await t.turn('solo modes 0 and 1');
    await t.idle();
    const write = fake.calls.find((x) => x.url === '/command/param.mute_modes');
    const undo = fake.calls.find((x) => x.url === '/history/undo');
    assert.ok(undo, JSON.stringify(fake.calls.map((x) => x.url)));
    assert.deepEqual(JSON.parse(undo.body), { group: write.group });
    const rev = activity(t, 'revert');
    assert.equal(rev.decision, 'reverted');
    assert.match(rev.reason, /level breach: the output clipped/);
    const res = t.msgs.filter((m) => m.type === 'activity' && m.entry.command === 'param.mute_modes').pop().entry;
    assert.match(res.result || '', /auto_reverted/);
    // runtime: no backend history -> the service re-sets the value it read before
    fake.state.wrote = false;
    await t.turn('louder please');                                            // 64 -> 68 inside the envelope
    await t.waitFor((m) => m.type === 'activity' && m.entry.command === 'revert' && /runtime.set/.test(m.entry.reason));
    const sets = fake.calls.filter((x) => x.url === '/command/runtime.set').map((x) => JSON.parse(x.body));
    assert.deepEqual(sets, [{ volume: 68 }, { volume: 64 }]);
    assert.equal(fake.state.volume, 64);
  } finally { await t.close(); fake.server.close(); }
});

test('service: the executor refuses a call without a permit; the pane Undo reverts one group', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { params: 'auto' } }));
  const t = await start(home, fake);
  try {
    const post = (headers) => fetch(`http://127.0.0.1:${t.port}/internal/command/param.mute_modes`, { method: 'POST', headers, body: JSON.stringify({ modes: 'all' }) });
    assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 403);
    assert.ok(!fake.calls.some((x) => x.url === '/command/param.mute_modes'));
    await t.turn('solo modes 0 and 1');
    await t.idle();
    const e = activity(t, 'param.mute_modes');
    t.send({ type: 'undo', groupId: e.groupId });
    await t.waitFor((m) => m.type === 'activity' && m.entry.command === 'revert');
    assert.deepEqual(JSON.parse(fake.calls.find((x) => x.url === '/history/undo').body), { group: e.groupId });
  } finally { await t.close(); fake.server.close(); }
});
