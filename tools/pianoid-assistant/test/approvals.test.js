// Assistant v2 P2 (dev-4324): per-category approvals, the hard-confirm list, the physical gates (dev-free1: free
// edits, value validity, the CFL check after a string write), the level watch with auto-revert and grouped undo — the policy table on the REAL registry + limits,
// and the service end to end (fake driver -> real MCP server -> the service executor -> fake :5000).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { decide, ruleFor } from '../policy.js';
import { applyChange, catalogue, CATEGORIES, describe, modeOf, ruleDef, VARIANTS } from '../approvals.js';
import { applyAutonomous, migrateConfig, presetRules } from '../autonomy.js';
import { ANALYSIS_CMD } from '../service/session.js';
import { BUG_CMD } from '../service/bugReport.js';
import { MEMORY_CMDS } from '../service/memory.js';
import { cflBreach, cflGated, check, levelBreach, revertPlan } from '../envelope.js';
import { loadCommands } from '../lib/registry.js';
import { loadLimits } from '../lib/paramLimits.js';
import { canonical } from '../service/autoWrite.js';
import { createAssistantService } from '../service/server.js';
import { FakeDriver } from '../drivers/fake.js';

const COMMANDS = loadCommands();
const LIMITS = loadLimits();
const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
const RULE_COMMANDS = new Map([...COMMANDS, ANALYSIS_CMD, BUG_CMD, ...Object.values(MEMORY_CMDS)].map((c) => [c.name, c]));
const dec = (name, settings = {}, attrs = {}) => {
  const c = RULE_COMMANDS.get(name);
  return decide({ command: c.name, title: c.title, tier: c.tier, family: c.family, category: c.approval_category, attrs, settings });
};
// The attribute variants a call can have (every one the policy distinguishes), per command.
const ATTRS = {
  'modal.rig_capture': [{ driveLevel: 'ok' }, { driveLevel: 'unverified' }],
  'modal.rig_sine': [{ driveLevel: 'ok' }, { driveLevel: 'unverified' }],
  'preset.save': [{ ownPreset: true }, { ownPreset: false }],
  'preset.create': [{ overwrite: false }, { overwrite: true }],
};

test('REGISTRY WALK (dev-unif1): every command x every attribute variant x {live audio, tainted}: every ask offers a persistable rule, and setting that rule to Always allow makes the same call run (outside a tainted turn)', () => {
  let asks = 0;
  for (const [name] of RULE_COMMANDS) {
    for (const attrs of ATTRS[name] || [{}]) {
      for (const liveAudio of [false, true]) {
        for (const tainted of [false, true]) {
          const envelope = { ok: true, reason: 'gates ok' };
          const v = dec(name, { liveAudio, tainted, envelope }, attrs);
          if (v.action !== 'ask') continue;
          asks += 1;
          const where = `${name} ${JSON.stringify(attrs)} live=${liveAudio} tainted=${tainted}`;
          assert.ok(v.rule?.id, `${where}: no rule offered`);
          assert.ok(v.rule.label, where);
          assert.ok(ruleDef(v.rule.id, RULE_COMMANDS), `${where}: rule ${v.rule.id} not in the catalogue`);
          const rules = applyChange({}, { rule: v.rule.id, mode: 'auto' }, RULE_COMMANDS);   // "Always allow": accepted
          const after = dec(name, { liveAudio, tainted, envelope, rules }, attrs);
          if (tainted && v.taintNote) assert.equal(after.action, 'ask', `${where}: a taint rule must not apply in a tainted turn`);
          else assert.equal(after.action, 'allow', `${where}: Always allow ${v.rule.id} did not allow it`);
          assert.equal('hard' in v || 'canAuto' in v, false, `${where}: no second dialog type`);
        }
      }
    }
  }
  assert.ok(asks > 50, `walked ${asks} asks`);
  // the pane lists every rule a call can name
  const ids = new Set(catalogue(RULE_COMMANDS).map((r) => r.id));
  for (const [name, cmd] of RULE_COMMANDS) {
    for (const attrs of ATTRS[name] || [{}]) {
      const id = ruleFor({ command: name, category: cmd.approval_category, family: cmd.family }, attrs);
      if (!['view', 'excluded'].includes(cmd.approval_category)) assert.ok(ids.has(id), `${name}: ${id} not listed`);
    }
  }
});

test('defaults: reads run, the categories as before, every command rule and variant asks; the risky ones carry a warning', () => {
  for (const n of ['ui.pane.open', 'param.get', 'system.snapshot', 'play.note', 'render.note_playback', 'job.cancel']) {
    assert.equal(dec(n).action, 'allow', n);
  }
  for (const n of ['param.set', 'param.mute_modes', 'runtime.set', 'preset.switch', 'history.undo']) {
    assert.equal(dec(n, { envelope: { ok: true, reason: 'x' } }).action, 'ask', n);
  }
  assert.equal(dec('launcher.backend.stop').action, 'deny');                                 // excluded: never a rule
  const risky = catalogue(RULE_COMMANDS).filter((r) => r.dangerous).map((r) => r.id).sort();
  assert.deepEqual(risky, ['audio.exciters_config', 'env.set', 'launcher.assistant.start', 'launcher.backend.start', 'launcher.modal.start',
    'preset.create.overwrite', 'preset.promote', 'preset.save.not_own', 'preset.unload', 'rig.drive.any_level']);
  for (const id of risky) {
    const d = ruleDef(id, RULE_COMMANDS);
    assert.deepEqual([d.default, d.taint, !!d.warning], ['ask', true, true], id);
  }
  const v = dec('preset.promote');
  assert.deepEqual([v.action, v.rule.dangerous, v.rule.id], ['ask', true, 'preset.promote']);
  // a future command is covered by its name, without a code change
  const ext = decide({ command: 'bug.send_github', tier: 'act', family: 'bug', category: 'bug_local' });
  assert.deepEqual([ext.action, ext.rule.id, ext.rule.dangerous], ['ask', 'bug.send_github', true]);
  // the obuf1 bug triage commands are covered generically: bug.list (view) runs, bug.set_status = rule bug_local
  assert.equal(decide({ command: 'bug.list', tier: 'read', family: 'bug', category: 'view' }).action, 'allow');
  assert.equal(decide({ command: 'bug.set_status', tier: 'act', family: 'bug', category: 'bug_local' }).rule.id, 'bug_local');
});

test('Always allow params / runtime run free under the gates: ok -> allow + watch; rejected value -> deny; no verdict -> ask', () => {
  const rules = { params: 'auto', runtime: 'auto' };
  const ok = dec('runtime.set', { rules, envelope: { ok: true, reason: 'free edit' } });
  assert.deepEqual([ok.action, ok.auto, ok.watch], ['allow', true, true]);
  const bad = { ok: false, reject: true, reason: 'rejected: volume 128 is above 127' };
  const denied = dec('runtime.set', { rules, envelope: bad });
  assert.deepEqual([denied.action, denied.reason], ['deny', bad.reason]);
  assert.equal(dec('runtime.set', { envelope: bad }).action, 'deny');               // even on Ask: never a prompt
  const nov = dec('param.set', { rules });
  assert.deepEqual([nov.action, nov.rule.id], ['ask', 'params']);                  // no verdict = asks (fail closed)
  assert.equal(dec('preset.switch', { rules: { preset_nav: 'auto' } }).action, 'allow');
});

test('rule table: one map, changes, defaults stored as removal, unknown rules refused, the pane view', () => {
  let r = {};
  assert.equal(modeOf('params', r), 'ask');
  r = applyChange(r, { rule: 'params', mode: 'auto' });
  assert.deepEqual(r, { params: 'auto' });
  r = applyChange(r, { rule: 'params', mode: 'ask' });
  assert.deepEqual(r, {});                                                          // back to the default
  for (const id of ['view', 'excluded', 'nope', 'play.note']) {
    assert.throws(() => applyChange({}, { rule: id, mode: 'auto' }, RULE_COMMANDS), /unknown approval rule/, id);
  }
  assert.throws(() => applyChange({}, { rule: 'params', mode: 'always' }), /mode/);
  for (const id of ['modal.rig_capture', 'preset.promote', 'rig.drive.any_level', 'code']) {
    assert.equal(modeOf(id, applyChange({}, { rule: id, mode: 'auto' }, RULE_COMMANDS), RULE_COMMANDS), 'auto', id);
  }
  const view = describe({ runtime: 'auto', 'modal.rig_capture': 'auto' }, RULE_COMMANDS);
  assert.deepEqual(view.autoActive, ['runtime', 'modal.rig_capture']);
  assert.deepEqual([...new Set(view.rules.map((x) => x.kind))], ['category', 'command', 'variant']);
  assert.equal(view.rules.filter((x) => x.kind === 'category').length, CATEGORIES.length);
  assert.equal(view.rules.filter((x) => x.kind === 'variant').length, VARIANTS.length);
});

test('Autonomous = a preset of the table; off puts back what it set; migration of approvals + autonomous: true', () => {
  const on = applyAutonomous({ rules: { code: 'ask', runtime: 'auto' }, autonomous: { on: false, previous: {} } }, true, RULE_COMMANDS);
  assert.equal(on.autonomous.on, true);
  for (const id of presetRules(RULE_COMMANDS)) assert.equal(on.rules[id], 'auto', id);
  for (const id of ['preset.promote', 'rig.drive.any_level', 'preset.save.not_own']) assert.equal(on.rules[id], undefined, id);   // risky: untouched
  const tweaked = { ...on.rules, history: 'ask', 'rig.drive.any_level': 'auto' };                                              // the user's own changes while on
  const off = applyAutonomous({ rules: tweaked, autonomous: on.autonomous }, false, RULE_COMMANDS);
  assert.deepEqual(off.rules, { code: 'ask', runtime: 'auto', history: 'ask', 'rig.drive.any_level': 'auto' });
  const m = migrateConfig({ model: 'auto', approvals: { params: 'auto', bogus: 'auto' }, autonomous: true }, RULE_COMMANDS);
  assert.equal(m.changed, true);
  assert.equal('approvals' in m.config, false);
  assert.equal(m.config.rulesVersion, 1);
  assert.equal(m.config.autonomous.on, true);
  assert.equal(m.config.autonomous.previous.params, 'auto');
  assert.equal(m.config.rules['modal.rig_capture'], 'auto');
  assert.equal(m.config.rules['rig.drive.any_level'], undefined);
  assert.equal(migrateConfig(m.config, RULE_COMMANDS).changed, false);
  const plain = migrateConfig({ approvals: { code: 'auto' }, autonomous: false }, RULE_COMMANDS).config;
  assert.deepEqual([plain.rules, plain.autonomous.on], [{ code: 'auto' }, false]);
});

test('physical gates: no step limits, validity bounds from schemas/params, the CFL flag (dev-free1)', () => {
  assert.deepEqual(Object.keys(LIMITS.fields).sort(), ['mode.decrement', 'runtime.volume']);
  assert.deepEqual([...LIMITS.masks].sort(), ['param.mute_channels', 'param.mute_modes']);
  assert.equal(LIMITS.global.max_keys_per_command, undefined);
  assert.equal(LIMITS.global.max_auto_writes_per_turn, undefined);
  const rs = (input) => check({ cmd: byName['runtime.set'], input, limits: LIMITS });
  for (const input of [{ volume: 71 }, { volume: 127 }, { volume: 0 }, { feedback_coeff: 0.2 }, { feedback_coeff: 5 }, { feedback: 70 },
    { volume_center: 2 }, { volume_range: 3 }, { store_feedback_coeff: 2 }]) {
    assert.equal(rs(input).ok, true, JSON.stringify(input));                       // any size: the limit is clipping
  }
  for (const [input, re] of [[{ volume: 128 }, /above 127/], [{ volume: -1 }, /below 0/], [{ volume: 70.5 }, /integer/], [{ volume: 'x' }, /not a number/]]) {
    const v = rs(input);
    assert.deepEqual([v.ok, v.reject], [false, true]);
    assert.match(v.reason, re);
  }
  const mode = (values) => check({ cmd: byName['param.set'], input: { parameter: 'mode', key_no: '5', values }, limits: LIMITS });
  assert.equal(mode({ 5: { decrement: 0.01 } }).ok, true);                       // a 99% cut: free
  assert.equal(mode({ 5: { decrement: 40, frequency: 90, mass_inv: 3 } }).ok, true);
  assert.match(mode({ 5: { decrement: -0.1 } }).reason, /mode 5 decrement -0.1 is below 0/);
  for (const parameter of ['string', 'hammer', 'feedin', 'feedback_mask', 'gauss', 'excitation']) {
    assert.equal(check({ cmd: byName['param.set'], input: { parameter, key_no: '60', values: {} }, limits: LIMITS }).ok, true, parameter);
  }
  assert.match(check({ cmd: byName['param.set'], input: { parameter: 'string', key_no: '60', values: {} }, limits: LIMITS }).reason, /CFL/);
  assert.equal(check({ cmd: byName['param.mute_modes'], input: { modes: Array.from({ length: 300 }, (_, i) => i) }, limits: LIMITS }).ok, true);
  assert.equal(check({ cmd: byName['runtime.set'], input: {}, limits: null }).reject, true);
  // CFL: only string physics is gated; the engine flag decides; an unreadable flag fails closed
  assert.equal(cflGated(byName['param.set'], { parameter: 'string' }), true);
  for (const parameter of ['hammer', 'mode', 'feedin']) assert.equal(cflGated(byName['param.set'], { parameter }), false);
  assert.equal(cflGated(byName['runtime.set'], {}), false);
  assert.equal(cflBreach({ cfl_redline: false, cfl_redline_info: null }), null);
  assert.match(cflBreach({ cfl_redline: true, cfl_redline_info: { pitch: 60, string: 194, amplification: 1.0, courant: 0.912 } }),
    /CFL violation at pitch 60 \(string 194\): Courant 0\.912, \|g\| 1\.0000/);
  assert.match(cflBreach({ unreachable: true }), /could not be read/);
  assert.match(cflBreach({ status: 'healthy' }), /could not be read/);
  // the revert plan: every runtime field from the value read before
  const rt = { '/get_runtime_parameters': { volume_level: 64, deck_feedback_coefficient: 1.0, volume_center: 0.5, volume_range: 2 }, '/health': { stored_feedback_coeff: 1.2 } };
  assert.deepEqual(revertPlan(byName['runtime.set'], { volume: 120 }, rt), { kind: 'runtime', values: { volume: 64 } });
  assert.deepEqual(revertPlan(byName['runtime.set'], { feedback: 30, volume_center: 9, volume_range: 1, store_feedback_coeff: 3 }, rt),
    { kind: 'runtime', values: { feedback_coeff: 1.0, volume_center: 0.5, volume_range: 2, store_feedback_coeff: 1.2 } });
  assert.deepEqual(revertPlan(byName['runtime.set'], { volume: 70 }, {}), { kind: 'runtime', values: {} });
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
  const state = { volume: 64, clipAfterWrite: false, wrote: false, cflAfterString: false, cfl: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, group: req.headers['x-pianoid-group'], body });
      res.setHeader('Content-Type', 'application/json');
      const send = (o, status = 200) => { res.statusCode = status; res.end(JSON.stringify(o)); };
      if (req.url === '/health') {
        return send({ status: 'healthy', pianoid_loaded: true, clipping: state.clipAfterWrite && state.wrote, peak_level: 0.1, gate_trip_count: 0, stored_feedback_coeff: 1.0, output_scale: { target_dbfs: -20 },
          cfl_redline: state.cfl, cfl_redline_info: state.cfl ? { pitch: 60, string: 194, amplification: 1.0, courant: 0.93 } : null });
      }
      if (req.url === '/get_runtime_parameters') return send({ volume_level: state.volume, deck_feedback_coefficient: 1.0 });
      if (req.url === '/history/undo') { state.cfl = false; return send({ entry: 'P', label: 'feedin_mask (assistant)', steps: 1 }); }
      if (req.url === '/command/runtime.set') {
        state.volume = JSON.parse(body).volume ?? state.volume;
        state.wrote = true;
        return send({ ok: true, status: 200, result: { updated: JSON.parse(body) } });
      }
      if (req.url.startsWith('/command/param.')) {
        state.wrote = true;
        if (req.url === '/command/param.set' && JSON.parse(body).parameter === 'string') state.cfl = state.cflAfterString;
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
  { match: 'tension', steps: [{ tool: 'mcp__pianoid__param__set', input: { parameter: 'string', key_no: '60', values: { 60: { tension: 9000 } } } }, { say: 'Set.' }] },
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
    assert.deepEqual([c.category, c.rule.id], ['params', 'params']);
    t.send({ type: 'confirm', id: c.id, allow: true, always: true });        // "Always allow"
    await t.idle();
    assert.equal(activity(t, 'approvals').reason, 'params -> Always allow');
    const cfg = path.join(home, 'config.json');
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).rules.params, 'auto');   // persisted
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
    t.send({ type: 'approvals', rule: 'runtime', mode: 'auto' });
    await t.waitFor((m) => m.type === 'approvals');
    await t.close();
    t = await start(home, fake);
    t.send({ type: 'hello' });
    const st = await t.waitFor((m) => m.type === 'state');
    const rows = Object.fromEntries(st.approvals.rules.map((r) => [r.id, r]));
    assert.deepEqual([rows.runtime.mode, rows.params.mode], ['auto', 'auto']);   // both persisted across the restart
    assert.deepEqual(st.approvals.autoActive, ['params', 'runtime']);
    t.send({ type: 'approvals', rule: 'params', mode: 'ask' });               // revoke in Permissions
    await t.waitFor((m) => m.type === 'approvals');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).rules.params, undefined);
  } finally { await t.close(); fake.server.close(); }
});

test('service: a big volume step runs without a dialog (no step limit); a command with its own rule still asks', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { params: 'auto', runtime: 'auto', preset_nav: 'auto' } }));
  // pin the preset folder: an existing presets/x.json the assistant did not create (else the ownership verdict
  // depends on whether a real PianoidCore sits next to this checkout: a missing file there is 'new' = own)
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-core-'));
  fs.mkdirSync(path.join(core, 'pianoid_middleware', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(core, 'pianoid_middleware', 'presets', 'x.json'), '{}');
  const prevCore = process.env.PIANOID_CORE_DIR;
  process.env.PIANOID_CORE_DIR = core;
  const t = await start(home, fake);
  try {
    await t.turn('louder a lot');                                             // 64 -> 80 (+16): was a hard confirm before dev-free1
    await t.idle();
    assert.ok(!t.msgs.some((m) => m.type === 'confirm'));
    assert.equal(fake.state.volume, 80);
    assert.equal(activity(t, 'runtime.set').decision, 'auto');
    await t.turn('save it');
    const s = await t.waitFor((m) => m.type === 'confirm');
    assert.deepEqual([s.command, s.rule.id], ['preset.save', 'preset.save.not_own']);   // not created by the assistant
    t.send({ type: 'confirm', id: s.id, allow: false });
    await t.idle();
  } finally {
    await t.close(); fake.server.close();
    if (prevCore === undefined) delete process.env.PIANOID_CORE_DIR; else process.env.PIANOID_CORE_DIR = prevCore;
  }
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

test('service: the CFL gate undoes a string write that breaks the Courant limit and tells the model (Auto, and confirmed)', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { params: 'auto' } }));
  fake.state.cflAfterString = true;
  let t = await start(home, fake);
  try {
    await t.turn('raise the tension');
    await t.idle();
    assert.ok(!t.msgs.some((m) => m.type === 'confirm'));                     // never a prompt
    const write = fake.calls.find((x) => x.url === '/command/param.set');
    const undo = fake.calls.find((x) => x.url === '/history/undo');
    assert.ok(undo, JSON.stringify(fake.calls.map((x) => x.url)));
    assert.deepEqual(JSON.parse(undo.body), { group: write.group });
    assert.equal(fake.state.cfl, false);                                       // the engine is back on stable values
    const rev = activity(t, 'revert');
    assert.match(rev.reason, /CFL gate: CFL violation at pitch 60 \(string 194\): Courant 0\.930/);
    const res = activity(t, 'param.set');
    assert.match(res.result || '', /cfl_violation/);
    // stable: the write stays, no undo
    fake.state.cflAfterString = false;
    fake.calls.length = 0;
    await t.turn('raise the tension again');
    await t.idle();
    assert.ok(fake.calls.some((x) => x.url === '/command/param.set'));
    assert.ok(!fake.calls.some((x) => x.url === '/history/undo'));
    await t.close();
    // Ask mode: the user confirms, the gate still undoes a violation
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({}));
    fake.state.cflAfterString = true;
    fake.calls.length = 0;
    t = await start(home, fake);
    await t.turn('tension up');
    const c = await t.waitFor((m) => m.type === 'confirm');
    assert.equal(c.rule.id, 'params');
    t.send({ type: 'confirm', id: c.id, allow: true });
    await t.idle();
    assert.ok(fake.calls.some((x) => x.url === '/history/undo'));
  } finally { await t.close(); fake.server.close(); }
});

test('service: volume is limited by clipping, not by step: a +16 jump that clips is reverted to the value before (Auto and confirmed)', async () => {
  const fake = await fakeBackend();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ approvals: { runtime: 'auto' } }));
  fake.state.clipAfterWrite = true;
  let t = await start(home, fake);
  try {
    await t.turn('louder a lot');                                             // 64 -> 80
    await t.waitFor((m) => m.type === 'activity' && m.entry.command === 'revert');
    await t.idle();
    assert.ok(!t.msgs.some((m) => m.type === 'confirm'));
    assert.deepEqual(fake.calls.filter((x) => x.url === '/command/runtime.set').map((x) => JSON.parse(x.body)), [{ volume: 80 }, { volume: 64 }]);
    assert.equal(fake.state.volume, 64);
    assert.match(activity(t, 'runtime.set').result || '', /auto_reverted/);
    await t.close();
    // Ask mode: the user confirms the jump; the clipping guard still reverts it
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({}));
    fake.state.wrote = false;
    fake.calls.length = 0;
    t = await start(home, fake);
    await t.turn('louder a lot');
    const c = await t.waitFor((m) => m.type === 'confirm');
    t.send({ type: 'confirm', id: c.id, allow: true });
    await t.waitFor((m) => m.type === 'activity' && m.entry.command === 'revert');
    assert.equal(fake.state.volume, 64);
  } finally { await t.close(); fake.server.close(); }
});
