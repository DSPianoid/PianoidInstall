// Autonomous mode (dev-auto1, user approval 2026-10-25): the policy row on the REAL registry (hard-confirm commands
// run, the residual still-ask list asks, the deny / tainted rows and the A2 envelope win), the session (persisted
// switch, the preset backup before an autonomous save, the envelope still enforced), and the on-disk audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, HARD_CONFIRM } from '../policy.js';
import { isOwnWorkingPreset, residualReason } from '../autonomy.js';
import { loadCommands } from '../lib/registry.js';
import { loadLimits } from '../lib/paramLimits.js';
import { AssistantSession } from '../service/session.js';
import { AuditLog } from '../service/auditLog.js';
import { backupPreset } from '../service/presetBackup.js';

const COMMANDS = loadCommands();
const byName = new Map(COMMANDS.map((c) => [c.name, c]));
const tmp = (p = 'pianoid-auto1-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ON = (cmd, input = {}) => ({ on: true, residual: residualReason(cmd, input) });
const dec = (name, input = {}, settings = {}) => {
  const c = byName.get(name);
  return decide({ command: c.name, tier: c.tier, family: c.family, category: c.approval_category, settings: { autonomous: ON(c, input), ...settings } });
};
const CAPTURE = { exciters: [{ output: 'Out 9', level_dbfs: -40 }], inputs: [{ input: 'In 1' }], sweep: { duration_s: 5 }, timing: { repeats: 1 } };
const RESIDUAL = [
  ['preset.save', { path: 'presets/BaselinePreset1.json' }],
  ['preset.save', { path: 'presets/../x_work.json' }],
  ['preset.save', { path: 'C:/elsewhere/x_work.json' }],
  ['preset.promote', { name: 'Steinway (working 1)' }],
  ['preset.unload', { name: 'Steinway' }],
  ['audio.exciters_config', { exciters: [] }],
  ['launcher.backend.start', {}],
  ['launcher.modal.start', {}],
  ['launcher.assistant.start', {}],
  ['preset.create', { name: 'B', num_strings: 16, num_channels: 2, array_size: 512, overwrite: true }],
  ['modal.rig_capture', { ...CAPTURE, exciters: [{ output: 'Out 9', level_dbfs: -20 }] }],   // above the cap
  ['modal.rig_capture', { ...CAPTURE, exciters: [] }],                                          // no known level
];

test('the own working preset rule', () => {
  for (const p of ['presets/Board_work.json', 'presets/Board_work', 'presets\\F15.v2_work.json']) assert.ok(isOwnWorkingPreset(p), p);
  for (const p of ['presets/Board.json', 'presets/sub/Board_work.json', '../presets/Board_work.json', 'Board_work.json', 'presets/..x_work.json', null]) {
    assert.ok(!isOwnWorkingPreset(p), String(p));
  }
});

test('policy: Autonomous mode runs every non-residual hard-confirm command and every category without a confirm', () => {
  const ran = [];
  for (const c of COMMANDS) {
    if (['read', 'ui', 'excluded'].includes(c.tier) || c.approval_category === 'excluded') continue;
    const input = c.name === 'preset.save' ? { path: 'presets/Board_work.json' } : c.name.startsWith('modal.rig_') ? CAPTURE : {};
    if (residualReason(c, input)) continue;
    const v = dec(c.name, input, { envelope: { ok: true, reason: 'inside' } });
    assert.equal(v.action, 'allow', c.name);
    assert.equal(v.autonomous, true, c.name);
    ran.push(c.name);
  }
  for (const n of ['preset.save', 'preset.load', 'calibration.synthesis', 'modal.run_stage', 'modal.rig_capture', 'modal.rig_process', 'preset.create', 'param.set', 'runtime.set', 'preset.switch']) {
    assert.ok(ran.includes(n), n);
  }
  // off: the same calls are the pre-feature table (the hard-confirm list asks)
  assert.equal(decide({ command: 'preset.load', tier: 'destructive', family: 'preset', category: 'hard_confirm', settings: {} }).hard, true);
  assert.deepEqual(dec('preset.load', {}, { autonomous: undefined }), { action: 'confirm', hard: true, reason: HARD_CONFIRM['preset.load'] });
});

test('policy: the residual list still asks (hard, no "Don\'t ask again") in Autonomous mode, every item', () => {
  for (const [n, input] of RESIDUAL) {
    const v = dec(n, input, { envelope: { ok: true, reason: 'inside' }, approvals: { installation: { renders: 'auto' } } });
    assert.deepEqual([v.action, v.hard, !!v.canAuto], ['confirm', true, false], `${n} ${JSON.stringify(input)}`);
    assert.match(v.reason, /asks even in Autonomous mode/, n);
  }
  // names that do not exist yet: any delete / remove / external filing / sending, any launcher command
  for (const n of ['preset.delete', 'modal.rig_runs_remove', 'bug.github_file', 'report.send', 'launcher.backend.restart']) {
    const cmd = { name: n, tier: 'act', family: n.split('.')[0], approval_category: 'playback' };
    const v = decide({ command: n, tier: 'act', family: cmd.family, category: 'playback', settings: { autonomous: ON(cmd) } });
    assert.deepEqual([v.action, v.hard], ['confirm', true], n);
  }
  // a plan the user approved (and ticked) may still cover a residual item
  const plan = { ok: true, ticked: true, grantId: 'g', reason: 'plan' };
  assert.deepEqual([dec('preset.save', { path: 'presets/Board.json' }, { plan }).action, dec('preset.save', { path: 'presets/Board.json' }, { plan }).plan], ['allow', 'g']);
});

test('policy: the deny rows, a tainted turn and the A2 envelope win over Autonomous mode', () => {
  assert.equal(dec('launcher.backend.stop').action, 'deny');                                  // excluded
  assert.equal(dec('modal.rig_capture', CAPTURE, { dataOptOut: true }).action, 'deny');       // data opt-out
  assert.equal(decide({ command: 'render.recalibrate_output_level', tier: 'act', family: 'render', category: 'renders',
    settings: { liveAudio: true, autonomous: { on: true, residual: null } } }).action, 'deny');  // R6 live deny
  for (const n of ['modal.rig_capture', 'preset.save', 'param.set', 'play.note']) {
    const v = dec(n, n === 'preset.save' ? { path: 'presets/B_work.json' } : CAPTURE, { tainted: true });
    assert.deepEqual([v.action, v.hard, !!v.canAuto], ['confirm', true, false], n);           // tainted: hard confirm
  }
  assert.equal(dec('param.get', {}, { tainted: true }).action, 'allow');                      // reads run
  // params / runtime: only inside the envelope (+ the level watch); outside = a hard confirm
  const inside = dec('runtime.set', { volume: 66 }, { envelope: { ok: true, reason: 'volume +2' } });
  assert.deepEqual([inside.action, inside.watch, inside.autonomous], ['allow', true, true]);
  const outside = dec('runtime.set', { volume: 120 }, { envelope: { ok: false, reason: 'outside the envelope: volume +56' } });
  assert.deepEqual([outside.action, outside.hard], ['confirm', true]);
  assert.equal(dec('param.set', {}, {}).action, 'confirm');                                   // no envelope verdict = ask
  // a live render runs (renders_live is not needed), analysis code runs
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: { liveAudio: true, autonomous: { on: true, residual: null } } }).action, 'allow');
  assert.equal(decide({ command: 'analysis.run_python', tier: 'act', family: 'analysis', category: 'code', settings: { autonomous: { on: true, residual: null } } }).action, 'allow');
});

// ---- the session -----------------------------------------------------------------------------

function mkSession({ autonomous = true, presetDir, fetchBody = {} } = {}) {
  const root = tmp();
  const paths = { root, config: path.join(root, 'config.json') };
  const sent = [];
  const runtime = { volume_level: 64, deck_feedback_coefficient: 1.0, stored_feedback_coeff: 1.0, pianoid_loaded: false, ...fetchBody };
  const s = new AssistantSession({
    paths, config: { model: 'sonnet', autonomous }, commands: COMMANDS, driverFactory: () => null, broadcast: (m) => sent.push(m),
    fetchImpl: async () => ({ json: async () => runtime }), limits: loadLimits(), planApproval: false, presetDir,
  });
  return { s, sent, root, paths };
}
const tool = (n) => `mcp__pianoid__${n.replace(/\./g, '__')}`;
const answerNext = (s, sent, allow) => new Promise((resolve) => {
  const tick = () => { const c = sent.filter((m) => m.type === 'confirm').at(-1); if (c && s.pending.has(c.id)) { s.confirm(c.id, allow); resolve(c); } else setImmediate(tick); };
  tick();
});

test('session: the switch persists per installation, shows in the state + context, and is logged', async () => {
  const { s, paths } = mkSession({ autonomous: false });
  assert.equal(s.state().autonomous.on, false);
  await s.updateSettings({ autonomous: true });
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).autonomous, true);
  assert.equal(s.state().autonomous.on, true);
  assert.ok(s.state().autonomous.stillAsks.length >= 6);
  assert.equal((await s.context()).autonomous_mode, true);
  assert.equal(s.activity.at(-1).command, 'autonomous mode');
  await s.updateSettings({ autonomous: false });
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).autonomous, false);
  await s.updateSettings({ autonomous: 'yes' });                                  // only a boolean switches it
  assert.equal(s.config.autonomous, false);
});

test('session: hard-confirm commands run for its own working preset; a backup is made BEFORE an autonomous preset.save', async () => {
  const mw = tmp('pianoid-mw-');
  fs.mkdirSync(path.join(mw, 'presets'));
  fs.writeFileSync(path.join(mw, 'presets', 'Board_work.json'), '{"v": 1}');
  const { s, sent, root } = mkSession({ presetDir: mw });
  const r = await s.canUseTool(tool('preset.save'), { path: 'presets/Board_work.json' }, { toolUseID: 's1' });
  assert.equal(r.behavior, 'allow');
  assert.ok(!sent.some((m) => m.type === 'confirm'));
  const e = s.activity.findLast((a) => a.command === 'preset.save');
  assert.equal(e.decision, 'autonomous');
  assert.ok(e.backup && fs.existsSync(e.backup), 'the backup file exists');
  assert.equal(path.dirname(e.backup), path.join(root, 'preset-backups'));
  assert.equal(fs.readFileSync(e.backup, 'utf8'), '{"v": 1}');                 // the content before the save
  assert.ok(s.auto.permits.some((p) => p.cmd.name === 'preset.save'));        // permitted only after the backup
  // a new working file: nothing to back up, still runs
  assert.equal((await s.canUseTool(tool('preset.save'), { path: 'presets/New_work' }, { toolUseID: 's2' })).behavior, 'allow');
  assert.equal(s.activity.findLast((a) => a.command === 'preset.save').backup, undefined);
  // preset.load / calibration / a rig drive inside the cap: no confirm
  for (const [n, input] of [['preset.load', { path: 'presets/Board_work.json' }], ['calibration.synthesis', {}], ['modal.rig_capture', CAPTURE]]) {
    assert.equal((await s.canUseTool(tool(n), input, { toolUseID: n })).behavior, 'allow', n);
  }
  assert.ok(!sent.some((m) => m.type === 'confirm'));
});

test('session: every residual item still asks (no backup for a refused save); a failed backup asks', async () => {
  const mw = tmp('pianoid-mw-');
  fs.mkdirSync(path.join(mw, 'presets'));
  fs.writeFileSync(path.join(mw, 'presets', 'BaselinePreset1.json'), '{}');
  const { s, sent, root } = mkSession({ presetDir: mw });
  for (const [n, input] of RESIDUAL) {
    const p = s.canUseTool(tool(n), input, { toolUseID: n });
    const c = await answerNext(s, sent, false);
    assert.equal(c.hard, true, n);
    assert.equal(c.canAuto, false, n);
    assert.equal((await p).behavior, 'deny', n);
  }
  assert.ok(!fs.existsSync(path.join(root, 'preset-backups')), 'no backup for a save that asked');
  // the backup cannot be made (no preset folder): the autonomous save asks instead (fail closed)
  const { s: s2, sent: sent2 } = mkSession({ presetDir: path.join(mw, 'missing') });
  const p = s2.canUseTool(tool('preset.save'), { path: 'presets/Board_work.json' }, { toolUseID: 'x' });
  const c = await answerNext(s2, sent2, false);
  assert.match(c.reason, /could not back up the preset first/);
  assert.equal((await p).behavior, 'deny');
});

test('session: the A2 envelope is still enforced in Autonomous mode (inside runs + watched, outside asks hard)', async () => {
  const { s, sent } = mkSession();
  assert.equal((await s.canUseTool(tool('runtime.set'), { volume: 66 }, { toolUseID: 'v1' })).behavior, 'allow');
  const permit = s.auto.permits.find((p) => p.cmd.name === 'runtime.set');
  assert.deepEqual([permit.auto, permit.watch], [true, true]);               // the level watch with auto-revert follows
  const p = s.canUseTool(tool('runtime.set'), { volume: 120 }, { toolUseID: 'v2' });
  const c = await answerNext(s, sent, false);
  assert.equal(c.hard, true);
  assert.match(c.reason, /at most \+6/);
  assert.equal((await p).behavior, 'deny');
});

test('audit log: every activity entry and update is appended to <root>/audit/audit.jsonl, the code in full; rotation', async () => {
  const { s, root } = mkSession();
  await s.canUseTool(tool('play.note'), { pitch: 60 }, { toolUseID: 'n1' });
  await s.canRunAnalysis({ code: 'print(42)\n'.repeat(100) }, { toolUseID: 'c1' });
  const file = path.join(root, 'audit', 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => l.ts && l.event));
  assert.ok(lines.some((l) => l.event === 'activity' && l.command === 'play.note' && l.decision === 'autonomous'));
  assert.equal(lines.find((l) => l.command === 'analysis.run_python').code, 'print(42)\n'.repeat(100));
  s.updateActivity(s.activity.at(-1), { status: 'ok', result: 'done' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)).event, 'update');
  assert.equal(s.state().autonomous.auditFile, file);

  const dir = tmp('pianoid-audit-');
  const log = new AuditLog({ dir, maxBytes: 300, keep: 2 });
  for (let i = 0; i < 20; i += 1) assert.ok(log.write('activity', { i, pad: 'x'.repeat(60) }));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit.1.jsonl', 'audit.2.jsonl', 'audit.jsonl']);
  for (const f of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 300, f);
  const last = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).i);
  assert.equal(last.at(-1), 19);                                              // newest in the current file
  assert.equal(new AuditLog({ dir: null }).write('x'), false);                // no home: disabled
});

test('presetBackup: outside pianoid_middleware refused; a new file needs no backup; pruning keeps the newest', () => {
  const mw = tmp('pianoid-mw-');
  const backupDir = path.join(tmp(), 'b');
  assert.equal(backupPreset({ presetPath: '../../etc/x.json', middleware: mw, backupDir }).ok, false);
  assert.deepEqual(backupPreset({ presetPath: 'presets/none_work', middleware: mw, backupDir }).backup, null);
  fs.mkdirSync(path.join(mw, 'presets'));
  fs.writeFileSync(path.join(mw, 'presets', 'a_work.json'), '1');
  for (let i = 0; i < 4; i += 1) {
    assert.ok(backupPreset({ presetPath: 'presets/a_work.json', middleware: mw, backupDir, now: new Date(Date.UTC(2026, 9, 25, 5, 0, i)), keep: 3 }).ok);
  }
  const kept = fs.readdirSync(backupDir).sort();
  assert.equal(kept.length, 3);
  assert.match(kept[0], /^20261025T050001000Z__presets_a_work\.json$/);
});

test('WS (review fix): a foreign web origin is refused; the pane (localhost) and non-browser clients connect and can switch Autonomous mode', async () => {
  const { createAssistantService } = await import('../service/server.js');
  const WebSocket = (await import('ws')).default;
  const home = tmp('pianoid-auto1-ws-');
  const svc = createAssistantService({ env: { ...process.env, ANTHROPIC_API_KEY: '', PIANOID_ASSISTANT_HOME: home, PIANOID_BACKEND_URL: 'http://127.0.0.1:1' }, port: 0, driver: 'fake' });
  const port = await svc.listen();
  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    ws.on('open', () => resolve(ws));
    ws.on('error', () => resolve(null));
    ws.on('unexpected-response', () => resolve(null));
  });
  try {
    assert.equal(await open('https://evil.example'), null);
    const pane = await open('http://localhost:3000');
    assert.ok(pane, 'the pane origin connects');
    pane.close();
    const ws = await open(null);
    ws.send(JSON.stringify({ type: 'settings', autonomous: true }));
    for (let i = 0; i < 100 && !svc.session.config.autonomous; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).autonomous, true);
    ws.close();
  } finally {
    await svc.close();
  }
});
