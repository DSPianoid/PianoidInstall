// Autonomous mode (dev-auto1, user approval 2026-10-25): the policy row on the REAL registry (hard-confirm commands
// run, the residual still-ask list asks, the deny / tainted rows and the A2 envelope win), the session (persisted
// switch, the preset backup before an autonomous save, the envelope still enforced), and the on-disk audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, HARD_CONFIRM } from '../policy.js';
import { residualReason } from '../autonomy.js';
import { loadCommands } from '../lib/registry.js';
import { loadLimits } from '../lib/paramLimits.js';
import { AssistantSession } from '../service/session.js';
import { AuditLog } from '../service/auditLog.js';
import { backupPreset } from '../service/presetBackup.js';

const COMMANDS = loadCommands();
const byName = new Map(COMMANDS.map((c) => [c.name, c]));
const tmp = (p = 'pianoid-auto1-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const OWN = { status: 'owned', own: true, reason: 'own' };                 // presetOwnership.classify of an owned file
const ON = (cmd, input = {}, ownPreset = null) => ({ on: true, residual: residualReason(cmd, input, { ownPreset }) });
const dec = (name, input = {}, { own = null, ...settings } = {}) => {
  const c = byName.get(name);
  return decide({ command: c.name, tier: c.tier, family: c.family, category: c.approval_category, settings: { autonomous: ON(c, input, own), ...settings } });
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

test('the own working copy is provenance, not a name: preset.save runs only for an own (created / owned) file', () => {
  const save = byName.get('preset.save');
  for (const own of [OWN, { status: 'new', own: true, reason: 'a new file' }]) assert.equal(residualReason(save, { path: 'presets/X' }, { ownPreset: own }), null);
  for (const own of [null, { status: 'not_owned', own: false, reason: 'an existing file the assistant did not create' },
    { status: 'modified', own: false, reason: 'changed' }, { status: 'error', own: false, reason: 'the ownership manifest is corrupt' }]) {
    assert.match(residualReason(save, { path: 'presets/Board_work.json' }, { ownPreset: own }), /not the assistant's own working copy/);
  }
});

test('policy: Autonomous mode runs every non-residual hard-confirm command and every category without a confirm', () => {
  const ran = [];
  for (const c of COMMANDS) {
    if (['read', 'ui', 'excluded'].includes(c.tier) || c.approval_category === 'excluded') continue;
    const input = c.name === 'preset.save' ? { path: 'presets/Board_work.json' } : c.name.startsWith('modal.rig_') ? CAPTURE : {};
    if (residualReason(c, input, { ownPreset: OWN })) continue;
    const v = dec(c.name, input, { own: OWN, envelope: { ok: true, reason: 'inside' } });
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

test('policy: the deny rows, a tainted turn and the physical gates win over Autonomous mode', () => {
  assert.equal(dec('launcher.backend.stop').action, 'deny');                                  // excluded
  assert.equal(dec('modal.rig_capture', CAPTURE, { dataOptOut: true }).action, 'deny');       // data opt-out
  assert.equal(decide({ command: 'render.recalibrate_output_level', tier: 'act', family: 'render', category: 'renders',
    settings: { liveAudio: true, autonomous: { on: true, residual: null } } }).action, 'deny');  // R6 live deny
  for (const n of ['modal.rig_capture', 'preset.save', 'param.set', 'play.note']) {
    const v = dec(n, n === 'preset.save' ? { path: 'presets/B_work.json' } : CAPTURE, { tainted: true });
    assert.deepEqual([v.action, v.hard, !!v.canAuto], ['confirm', true, false], n);           // tainted: hard confirm
  }
  assert.equal(dec('param.get', {}, { tainted: true }).action, 'allow');                      // reads run
  // params / runtime (dev-free1): free under the physical gates (+ the level watch); an invalid value = deny, never a prompt
  const big = dec('runtime.set', { volume: 120 }, { envelope: { ok: true, reason: 'free edit; level watched' } });
  assert.deepEqual([big.action, big.watch, big.autonomous], ['allow', true, true]);
  const bad = dec('runtime.set', { volume: 128 }, { envelope: { ok: false, reject: true, reason: 'rejected: volume 128 is above 127' } });
  assert.deepEqual([bad.action, bad.reason], ['deny', 'rejected: volume 128 is above 127']);
  assert.deepEqual([dec('param.set', {}, {}).action, dec('param.set', {}, {}).hard], ['confirm', true]);   // no verdict = fail closed
  // a live render runs (renders_live is not needed), analysis code runs
  assert.equal(decide({ command: 'render.note_playback', tier: 'act', family: 'render', category: 'renders', settings: { liveAudio: true, autonomous: { on: true, residual: null } } }).action, 'allow');
  assert.equal(decide({ command: 'analysis.run_python', tier: 'act', family: 'analysis', category: 'code', settings: { autonomous: { on: true, residual: null } } }).action, 'allow');
});

// ---- the session -----------------------------------------------------------------------------

function mkSession({ autonomous = true, presetDir, fetchBody = {} } = {}) {
  const root = tmp();
  const paths = { root, config: path.join(root, 'config.json') };
  const sent = [];
  const saves = { n: 0 };
  const runtime = { volume_level: 64, deck_feedback_coefficient: 1.0, stored_feedback_coeff: 1.0, pianoid_loaded: false, ...fetchBody };
  const s = new AssistantSession({
    paths, config: { model: 'sonnet', autonomous }, commands: COMMANDS, driverFactory: () => null, broadcast: (m) => sent.push(m),
    fetchImpl: async (url, init) => {
      // the fake backend: POST /command/preset.save writes the file (relative to pianoid_middleware, .json appended)
      if (presetDir && String(url).endsWith('/command/preset.save')) {
        const rel = JSON.parse(init.body).path;
        fs.writeFileSync(path.resolve(presetDir, /\.json$/i.test(rel) ? rel : `${rel}.json`), `{"saved": ${++saves.n}}`);
        return { json: async () => ({ ok: true, status: 200, result: { message: 'Preset saved successfully', path: path.resolve(presetDir, /\.json$/i.test(rel) ? rel : `${rel}.json`) } }) };
      }
      return { json: async () => runtime };
    }, limits: loadLimits(), planApproval: false, presetDir,
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

const mkPresets = (files = {}) => {
  const mw = tmp('pianoid-mw-');
  fs.mkdirSync(path.join(mw, 'presets'));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(mw, f), body);
  return mw;
};
// canUseTool, then (when allowed) the executor runs the permit like the MCP server would
async function save(s, sent, p, { answer = null } = {}) {
  const pending = s.canUseTool(tool('preset.save'), { path: p }, { toolUseID: `save-${p}` });
  const c = answer === null ? null : await answerNext(s, sent, answer);
  const r = await pending;
  const out = r.behavior === 'allow' ? await s.auto.exec('preset.save', { path: p }) : null;
  return { r, c, out, entry: s.activity.findLast((a) => a.command === 'preset.save') };
}
const manifest = (root) => JSON.parse(fs.readFileSync(path.join(root, 'owned-presets.json'), 'utf8')).entries;
const auditLines = (root) => fs.readFileSync(path.join(root, 'audit', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('session: a preset the assistant CREATED saves without asking (recorded with its hash); later saves back it up first', async () => {
  const mw = mkPresets();
  const { s, sent, root } = mkSession({ presetDir: mw });
  const first = await save(s, sent, 'presets/Board');                         // a new file: a creation
  assert.deepEqual([first.r.behavior, first.entry.decision, first.entry.ownership, first.entry.backup], ['allow', 'autonomous', 'new', undefined]);
  assert.equal(first.out.body.ok, true);
  const target = fs.realpathSync.native(path.join(mw, 'presets', 'Board.json'));
  const [entry] = Object.values(manifest(root));
  assert.equal(entry.path, target);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
  assert.ok(entry.created_at && entry.session);
  const again = await save(s, sent, 'presets/Board.json');                    // owned + unchanged: no confirm, a backup
  assert.deepEqual([again.r.behavior, again.entry.ownership], ['allow', 'owned']);
  assert.ok(again.entry.backup && fs.readFileSync(again.entry.backup, 'utf8') === '{"saved": 1}', 'backed up before the save');
  assert.equal(Object.values(manifest(root))[0].created_at, entry.created_at);
  assert.notEqual(Object.values(manifest(root))[0].sha256, entry.sha256);    // refreshed to the new content
  assert.ok(!sent.some((m) => m.type === 'confirm'));
  assert.ok(auditLines(root).some((l) => l.event === 'ownership' && l.action === 'created' && l.path === target));
  // preset.load / calibration / a rig drive inside the cap: no confirm
  for (const [n, input] of [['preset.load', { path: 'presets/Board.json' }], ['calibration.synthesis', {}], ['modal.rig_capture', CAPTURE]]) {
    assert.equal((await s.canUseTool(tool(n), input, { toolUseID: n })).behavior, 'allow', n);
  }
  assert.ok(!sent.some((m) => m.type === 'confirm'));
});

test('session: a pre-existing file asks even with a _work name; an owned file edited since asks; a change after the check is refused', async () => {
  const mw = mkPresets({ 'presets/Board_work.json': '{"user": true}' });
  const { s, sent, root } = mkSession({ presetDir: mw });
  const pre = await save(s, sent, 'presets/Board_work.json', { answer: false });
  assert.deepEqual([pre.r.behavior, pre.c.hard, pre.c.canAuto, pre.entry.ownership], ['deny', true, false, 'not_owned']);
  assert.match(pre.c.reason, /did not create/);
  assert.equal(fs.readFileSync(path.join(mw, 'presets', 'Board_work.json'), 'utf8'), '{"user": true}');
  await save(s, sent, 'presets/Mine');                                        // created + owned
  fs.writeFileSync(path.join(mw, 'presets', 'Mine.json'), '{"edited by the user": 1}');
  const edited = await save(s, sent, 'presets/Mine', { answer: false });
  assert.deepEqual([edited.r.behavior, edited.entry.ownership], ['deny', 'modified']);
  assert.match(edited.c.reason, /changed since it last wrote it/);
  // owned at the check, edited before the executor runs: refused (409), the user's edit kept
  fs.rmSync(path.join(mw, 'presets', 'Mine.json'));
  fs.rmSync(path.join(root, 'owned-presets.json'));
  await save(s, sent, 'presets/Mine');
  assert.equal((await s.canUseTool(tool('preset.save'), { path: 'presets/Mine' }, { toolUseID: 'race' })).behavior, 'allow');
  fs.writeFileSync(path.join(mw, 'presets', 'Mine.json'), '{"edited": 2}');
  const raced = await s.auto.exec('preset.save', { path: 'presets/Mine' });
  assert.deepEqual([raced.status, raced.body.error], [409, 'changed']);
  assert.equal(fs.readFileSync(path.join(mw, 'presets', 'Mine.json'), 'utf8'), '{"edited": 2}');
});

test('session: a corrupt or missing manifest owns nothing (asks) and is audited; the next creation keeps the corrupt file aside', async () => {
  const mw = mkPresets();
  const { s, sent, root } = mkSession({ presetDir: mw });
  await save(s, sent, 'presets/Mine');
  fs.writeFileSync(path.join(root, 'owned-presets.json'), '{ not json');
  const r = await save(s, sent, 'presets/Mine', { answer: false });
  assert.deepEqual([r.r.behavior, r.entry.ownership], ['deny', 'error']);
  assert.match(r.c.reason, /corrupt.*owns nothing/);
  assert.ok(auditLines(root).some((l) => l.event === 'ownership' && l.action === 'manifest_problem' && /corrupt/.test(l.reason)));
  fs.rmSync(path.join(root, 'owned-presets.json'));                         // missing = owning nothing too
  assert.equal((await save(s, sent, 'presets/Mine', { answer: false })).entry.ownership, 'not_owned');
  assert.ok(auditLines(root).some((l) => l.action === 'manifest_problem' && /missing/.test(l.reason)));
  fs.writeFileSync(path.join(root, 'owned-presets.json'), '[]');
  assert.equal((await save(s, sent, 'presets/Fresh')).r.behavior, 'allow');   // a creation needs no ownership
  assert.ok(fs.readdirSync(root).some((f) => f.startsWith('owned-presets.json.corrupt-')));
  assert.equal(Object.keys(manifest(root)).length, 1);
});

test('session: traversal, a case variant of a user file and a junction to a non-owned folder ask; an approved overwrite is not adopted', async () => {
  const mw = mkPresets({ 'User.json': '{"root": 1}', 'presets/User.json': '{"user": 1}' });
  const elsewhere = tmp('pianoid-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'theirs.json'), '{"theirs": 1}');
  fs.symlinkSync(elsewhere, path.join(mw, 'presets', 'j'), 'junction');
  const { s, sent, root } = mkSession({ presetDir: mw });
  const cases = [['presets/../User.json', 'outside'], ['presets/sub/../../User', 'outside'], ['presets/j/theirs.json', 'outside'], ['presets/j/new.json', 'outside']];
  if (process.platform === 'win32') cases.push(['presets/USER.JSON', 'not_owned']);   // the same file on Windows
  for (const [p, status] of cases) {
    const r = await save(s, sent, p, { answer: false });
    assert.deepEqual([r.r.behavior, r.entry.ownership], ['deny', status], p);
  }
  assert.equal(fs.readFileSync(path.join(elsewhere, 'theirs.json'), 'utf8'), '{"theirs": 1}');
  if (process.platform === 'win32') {                                         // the SAME owned file in another case
    await save(s, sent, 'presets/Mine');
    assert.equal((await save(s, sent, 'presets/MINE.json')).entry.ownership, 'owned');
  }
  // the user approves a save over their file: it runs, but the file stays theirs (the next save asks again)
  const ok = await save(s, sent, 'presets/User.json', { answer: true });
  assert.deepEqual([ok.r.behavior, ok.out.body.ok], ['allow', true]);
  assert.ok(!Object.values(manifest(root)).some((e) => /user\.json$/i.test(e.path)));
  assert.ok(auditLines(root).some((l) => l.action === 'not_adopted'));
  assert.equal((await save(s, sent, 'presets/User.json', { answer: false })).entry.ownership, 'not_owned');
});

test('session: every residual item still asks (no backup for a refused save); a failed backup asks', async () => {
  const mw = mkPresets({ 'presets/BaselinePreset1.json': '{}' });
  const { s, sent, root } = mkSession({ presetDir: mw });
  for (const [n, input] of RESIDUAL) {
    const p = s.canUseTool(tool(n), input, { toolUseID: n });
    const c = await answerNext(s, sent, false);
    assert.equal(c.hard, true, n);
    assert.equal(c.canAuto, false, n);
    assert.equal((await p).behavior, 'deny', n);
  }
  assert.ok(!fs.existsSync(path.join(root, 'preset-backups')), 'no backup for a save that asked');
  // an owned file whose backup cannot be made (the backup folder is a file): the autonomous save asks (fail closed)
  await save(s, sent, 'presets/Mine');
  fs.writeFileSync(path.join(root, 'preset-backups'), 'not a folder');
  const r = await save(s, sent, 'presets/Mine', { answer: false });
  assert.match(r.c.reason, /could not back up the preset first/);
  assert.equal(r.r.behavior, 'deny');
});

test('session: Autonomous mode runs any parameter / volume step (watched); an invalid value is denied, never asked', async () => {
  const { s, sent } = mkSession();
  for (const [input, id] of [[{ volume: 120 }, 'v1'], [{ feedback_coeff: 0.1 }, 'v2']]) {
    assert.equal((await s.canUseTool(tool('runtime.set'), input, { toolUseID: id })).behavior, 'allow', JSON.stringify(input));
  }
  const string = { parameter: 'string', key_no: 'from21to108', values: { 60: { tension: 1e5 } } };
  assert.equal((await s.canUseTool(tool('param.set'), string, { toolUseID: 's1' })).behavior, 'allow');
  const permits = s.auto.permits.filter((p) => ['runtime.set', 'param.set'].includes(p.cmd.name));
  assert.deepEqual(permits.map((p) => [p.auto, p.watch]), [[true, true], [true, true], [true, true]]);   // the gates follow
  const r = await s.canUseTool(tool('runtime.set'), { volume: 300 }, { toolUseID: 'v3' });
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /volume 300 is above 127/);
  assert.equal(sent.filter((m) => m.type === 'confirm').length, 0);          // no prompt at all
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
