// dev-tuneskill: the sample-library / tuning-record tools: the gate (reads run, writes take the `library` rule, lint
// before the dialog, one permit per allowed call), the CLI argument contract, taint propagation, and the real CLI
// when the canonical venv is present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifact } from '../analysis/store.js';
import { CLI, DEFAULT_ROOT, LIBRARY_CMDS, lintRecord, runCli, TOOLS, TuningLibrary } from '../service/tuningLibrary.js';
import { SdkDriver } from '../drivers/sdk.js';
import { decide } from '../policy.js';
import { CATEGORIES, modeOf } from '../approvals.js';
import { sttPython } from '../service/stt.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-tuneskill-'));
const unwrap = (s) => JSON.parse(/^<library untrusted="true">\n([\s\S]*)\n<\/library>$/.exec(s)[1]);

/** A stand-in for the AssistantSession: the policy verdict, a scripted dialog, activity / audit / taint recording. */
function fakeSession({ rules = {}, answer = true, tainted = false } = {}) {
  const s = {
    tainted, backendUrl: 'http://backend', activity: [], audits: [], asked: [], taints: [],
    verdict: (cmd, input) => decide({ command: cmd.name, title: cmd.title, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, attrs: {}, settings: { rules, tainted: s.tainted } }),
    logActivity: (f) => { const e = { id: `a${s.activity.length + 1}`, ...f }; s.activity.push(e); return e; },
    ask: async (entry, cmd, shown) => { s.asked.push({ cmd: cmd.name, shown }); return answer; },
    audit: { write: (ev, data) => s.audits.push({ ev, ...data }) },
    taintTurn: (why) => { s.tainted = true; s.taints.push(why); },
  };
  return s;
}

const wav = () => ({ name: 'audio_0.wav', data: Buffer.from('RIFF') });

test('category: library is a rule of the catalogue (ask by default, taint), and both writes map to it', () => {
  const c = CATEGORIES.find((x) => x.id === 'library');
  assert.ok(c && c.default === 'ask' && c.taint === true);
  assert.equal(modeOf({}, 'library'), 'ask');
  for (const cmd of Object.values(LIBRARY_CMDS)) assert.equal(cmd.approval_category, 'library');
  assert.equal(Object.keys(LIBRARY_CMDS).length, 2);
});

test('gate: reads run without asking; samples_add asks under rule library, Always allow runs it; a decline denies', async () => {
  const dir = tmp();
  const art = createArtifact(dir, { kind: 'wav', source: 'analysis.run_python', meta: { command: 'analysis.run_python' }, files: [wav()] });
  const calls = [];
  const run = async (py, args) => { calls.push(args); return { ok: true, record: { id: 'kb', tainted: false } }; };
  const lib = new TuningLibrary(fakeSession(), { artifactsDir: dir, root: 'R', python: 'py', run });
  assert.equal((await lib.canUse(TOOLS.list, {})).behavior, 'allow');
  const input = { artifact_id: art.id, source: 'render', pitch: 60, velocity: 95, preset: 'P', settings: { order: 2 }, tags: ['a', 'b'], id: 'kb' };
  const r = await lib.canUse(TOOLS.add, input);
  assert.equal(r.behavior, 'allow');
  assert.equal(lib.session.asked[0].cmd, 'library.samples_add');
  assert.deepEqual(lib.session.activity.map((e) => [e.command, e.decision, e.rule]), [['library.samples_add', 'ask', 'library']]);
  const out = JSON.parse(await lib.call(TOOLS.add, input));
  assert.equal(out.ok, true);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 3), ['--root', 'R', 'add']);
  assert.equal(args[args.indexOf('--file') + 1], path.join(dir, art.id, 'audio_0.wav'));
  assert.equal(args[args.indexOf('--origin') + 1], `${art.id}/audio_0.wav`);
  assert.equal(args[args.indexOf('--settings') + 1], '{"order":2}');
  assert.equal(args[args.indexOf('--tags') + 1], 'a,b');
  assert.equal(args[args.indexOf('--pitch') + 1], '60');
  assert.ok(!args.includes('--tainted'));
  // the permit is spent: the same call again is refused by the handler until the gate allows it again
  assert.equal(JSON.parse(await lib.call(TOOLS.add, input)).error, 'not_permitted');
  // Always allow: no dialog
  const auto = new TuningLibrary(fakeSession({ rules: { library: 'auto' } }), { artifactsDir: dir, root: 'R', python: 'py', run });
  assert.equal((await auto.canUse(TOOLS.add, input)).behavior, 'allow');
  assert.equal(auto.session.asked.length, 0);
  assert.equal(auto.session.activity[0].decision, 'auto');
  // a decline
  const no = new TuningLibrary(fakeSession({ answer: false }), { artifactsDir: dir, root: 'R', python: 'py', run });
  assert.equal((await no.canUse(TOOLS.add, input)).behavior, 'deny');
});

test('lint before the dialog: unknown artefact, no WAV, ambiguous file, bad source / id are denied without asking', async () => {
  const dir = tmp();
  const two = createArtifact(dir, { kind: 'wav', source: 'x', meta: {}, files: [wav(), { name: 'audio_1.wav', data: Buffer.from('RIFF') }] });
  const none = createArtifact(dir, { kind: 'json', source: 'x', meta: {}, files: [{ name: 'r.json', data: '{}' }] });
  const lib = new TuningLibrary(fakeSession(), { artifactsDir: dir, root: 'R', python: 'py', run: async () => ({ ok: true }) });
  for (const [input, re] of [
    [{ artifact_id: 'a-00000000000000-000000', source: 'render' }, /unknown artefact/],
    [{ artifact_id: two.id, source: 'render' }, /has 2 WAV files/],
    [{ artifact_id: two.id, file: 'nope.wav', source: 'render' }, /no WAV file nope.wav/],
    [{ artifact_id: none.id, source: 'render' }, /has 0 WAV files/],
    [{ artifact_id: two.id, file: 'audio_1.wav', source: 'mp3' }, /source: render, mic or reference/],
    [{ artifact_id: two.id, file: 'audio_1.wav', source: 'mic', id: 'bad id!' }, /id: letters/],
  ]) {
    const r = await lib.canUse(TOOLS.add, input);
    assert.equal(r.behavior, 'deny');
    assert.match(r.message, re);
  }
  assert.equal(lib.session.asked.length, 0);
  assert.equal((await lib.canUse(TOOLS.add, { artifact_id: two.id, file: 'audio_1.wav', source: 'mic' })).behavior, 'allow');
  assert.match(lintRecord({}), /description/);
  assert.match(lintRecord({ description: 'x', id: 'a b' }), /id/);
  assert.match(lintRecord({ description: 'x', changes: ['y'.repeat(20000)] }), /16 KB/);
  assert.equal(lintRecord({ description: 'make it warmer' }), null);
});

test('taint: a tainted artefact or turn marks the sample; reading a tainted sample taints the turn; reads are wrapped as data', async () => {
  const dir = tmp();
  const art = createArtifact(dir, { kind: 'wav', source: 'x', meta: {}, files: [wav()], tainted: true });
  const calls = [];
  const run = async (py, args) => {
    calls.push(args);
    if (args[2] === 'get') return { ok: true, record: { id: 'kb', tainted: true } };
    if (args[2] === 'compare') return { ok: true, a: { id: 'x', tainted: false }, b: { id: 'y', tainted: false }, b_minus_a: {} };
    if (args[2] === 'list') return { ok: true, total: 1, samples: [{ id: 'kb' }] };
    return { ok: true, record: { id: 'kb', tainted: true } };
  };
  const lib = new TuningLibrary(fakeSession({ rules: { library: 'auto' } }), { artifactsDir: dir, root: 'R', python: 'py', run });
  const input = { artifact_id: art.id, source: 'render' };
  await lib.canUse(TOOLS.add, input);
  await lib.call(TOOLS.add, input);
  assert.ok(calls[0].includes('--tainted'));
  assert.equal(lib.session.tainted, false);
  const got = unwrap(await lib.call(TOOLS.get, { id: 'kb' }));
  assert.equal(got.record.id, 'kb');
  assert.equal(lib.session.tainted, true);
  assert.match(lib.session.taints[0], /sample kb/);
  const cmp = unwrap(await lib.call(TOOLS.compare, { a: 'x', b: 'y' }));
  assert.ok(cmp.notice && cmp.b_minus_a);
  const lst = unwrap(await lib.call(TOOLS.list, { pitch: 60, preset: 'Bel' }));
  assert.equal(lst.total, 1);
  assert.deepEqual(calls.at(-1).slice(2), ['list', '--preset', 'Bel', '--pitch', '60']);
  assert.ok(lib.session.audits.some((a) => a.ev === 'library_read' && a.tainted[0] === 'kb'));
});

test('tuning_record: the backend history is read and attached as the user\'s edits; an unreachable backend is a note, not a failure', async () => {
  const calls = [];
  const run = async (py, args) => { calls.push(args); return { ok: true, id: 't-1', draft: 'R/sessions/t-1.md', verdict: 'kept' }; };
  const history = { entry: 'working 1', undo: [{ label: 'Set string gamma p60' }, 'Set hammer p60'] };
  const fetchImpl = async () => ({ json: async () => history });
  const lib = new TuningLibrary(fakeSession({ rules: { library: 'auto' } }), { artifactsDir: tmp(), root: 'R', python: 'py', run, fetchImpl });
  const input = { description: 'C4 too harsh', interpretation: 'centroid down', options_offered: ['width up'], chosen: 'width up', verdict: 'kept',
    before: { centroid_body_hz: 900 }, after: { centroid_body_hz: 700 } };
  assert.equal((await lib.canUse(TOOLS.record, input)).behavior, 'allow');
  const out = JSON.parse(await lib.call(TOOLS.record, input));
  assert.equal(out.ok, true);
  assert.deepEqual(out.user_edits, ['Set string gamma p60', 'Set hammer p60']);
  const sent = JSON.parse(calls[0][calls[0].indexOf('--json') + 1]);
  assert.equal(sent.history_entry, 'working 1');
  assert.deepEqual(sent.user_edits, ['Set string gamma p60', 'Set hammer p60']);
  assert.equal(sent.tainted, false);
  const down = new TuningLibrary(fakeSession({ rules: { library: 'auto' } }), { artifactsDir: tmp(), root: 'R', python: 'py', run, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await down.canUse(TOOLS.record, input);
  const out2 = JSON.parse(await down.call(TOOLS.record, input));
  assert.equal(out2.ok, true);
  assert.match(out2.history_note, /not readable/);
  // not permitted without the gate
  assert.equal(JSON.parse(await down.call(TOOLS.record, { description: 'other' })).error, 'not_permitted');
});

test('SDK: the five tools sit on the assistant server only when a library handler is given', () => {
  const names = (srv) => srv.instance?._registeredTools ? Object.keys(srv.instance._registeredTools) : (srv.tools || []).map((t) => t.name);
  const without = names(SdkDriver.assistantTools(async () => '', async () => ({}), null, async () => ''));
  const withLib = names(SdkDriver.assistantTools(async () => '', async () => ({}), null, async () => '', async () => ''));
  for (const t of ['samples_list', 'samples_get', 'samples_compare', 'samples_add', 'tuning_record']) {
    assert.ok(!without.includes(t), t);
    assert.ok(withLib.includes(t), t);
  }
});

test('runCli: a missing python is a tool error, not a throw; the CLI path is inside the repo', async () => {
  const r = await runCli(path.join(os.tmpdir(), 'no-such-python.exe'), ['stats']);
  assert.equal(r.ok, false);
  assert.match(r.error, /Python was not found/);
  assert.ok(fs.existsSync(CLI));
  assert.equal(path.basename(DEFAULT_ROOT), 'samples');
});

test('real CLI (skipped without the canonical venv): stats / record / sessions on a temporary root', { skip: !fs.existsSync(sttPython()) }, async () => {
  const root = tmp();
  const stats = await runCli(sttPython(), ['--root', root, 'stats']);
  assert.equal(stats.ok, true);
  assert.equal(stats.samples, 0);
  const rec = await runCli(sttPython(), ['--root', root, 'record', '--json', JSON.stringify({ description: 'test record', verdict: 'open' })]);
  assert.equal(rec.ok, true);
  assert.ok(fs.existsSync(rec.draft));
  const bad = await runCli(sttPython(), ['--root', root, 'get', '--id', 'nope']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /no sample/);
});
