// Assistant v2 P5 (dev-11f8): the analysis sandbox tool — artefact store, `export: true`, the run_python
// handler (launcher faked), the policy category `code`, the PreToolUse re-check, and (when the production
// sandbox is set up on this machine) one real sandboxed run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decide } from '../policy.js';
import { loadCommands } from '../lib/registry.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { listTools } from '../mcp/tools.js';
import { analysisPaths, artifactFile, createArtifact, npyFloat64, readArtifact, wavInfo } from '../analysis/store.js';
import { artifactFromResult, splitExport } from '../analysis/export.js';
import { LAUNCHER, PRELUDE, launcherArgs, runPython, validateInput } from '../analysis/runPython.js';
import { AssistantSession, ANALYSIS_CMD } from '../service/session.js';

const COMMANDS = loadCommands();
const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-analysis-test-'));

/** A 16-bit mono PCM WAV of a sine (what the backend's audio_data decodes to). */
function wav(freq, sr = 48000, n = 4800) {
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / sr)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('store: create / read / file lookup; ids and file names are validated (no traversal)', () => {
  const dir = tmp();
  const rec = createArtifact(dir, { kind: 'json', source: 't', meta: { x: 1 }, files: [{ name: 'result.json', data: '{}' }] });
  assert.match(rec.id, /^a-\d{14}-[0-9a-f]{6}$/);
  assert.equal(readArtifact(dir, rec.id).x, 1);
  assert.equal(artifactFile(dir, rec.id, 'result.json'), path.join(dir, rec.id, 'result.json'));
  assert.equal(artifactFile(dir, rec.id, 'meta.json'), null);                // only listed data files
  assert.equal(artifactFile(dir, rec.id, '..\\..\\x.json'), null);
  assert.equal(readArtifact(dir, '../etc'), null);
  assert.throws(() => createArtifact(dir, { kind: 'x', source: 't', files: [{ name: '../evil.png', data: 'x' }] }), /bad artefact file name/);
  assert.throws(() => createArtifact(dir, { kind: 'x', source: 't', files: [{ name: 'run.exe', data: 'x' }] }), /bad artefact file name/);
});

test('store: .npy encoder (NumPy format 1.0, 64-aligned header) and WAV fmt parsing', () => {
  const b = npyFloat64([1.5, -2, 3]);
  assert.equal(b.toString('latin1', 0, 6), '\x93NUMPY');
  const hlen = b.readUInt16LE(8);
  assert.equal((10 + hlen) % 64, 0);
  assert.match(b.toString('latin1', 10, 10 + hlen), /'descr': '<f8'.*'shape': \(3,\)/);
  assert.equal(b.readDoubleLE(10 + hlen), 1.5);
  assert.equal(b.readDoubleLE(10 + hlen + 16), 3);
  assert.deepEqual(wavInfo(wav(440)), { channels: 1, sample_rate: 48000, bits: 16 });
  assert.equal(wavInfo(Buffer.from('nope')), null);
});

test('export: render results -> WAV + .npy series with units; reads -> result.json; jobs not exported', () => {
  const cmd = byName['render.note_playback'];
  const spec = artifactFromResult(cmd, { pitch: 60 }, {
    audio_data: [wav(262).toString('base64')], data: [[0, 0.5, -0.5]], chart_headers: ['p60'], general_header: 'Note',
  }, { load_settings: { array_size: 384 } });
  assert.deepEqual(spec.files.map((f) => f.name), ['audio_0.wav', 'series_0.npy']);
  assert.equal(spec.meta.sample_rate, 48000);
  assert.equal(spec.meta.series[0].name, 'p60');
  assert.match(spec.meta.series_units, /raw engine units/);
  assert.equal(spec.meta.load_settings.array_size, 384);
  const read = artifactFromResult(byName['param.get'], { parameter: 'mode', key_no: '0' }, { value: [1, 2] });
  assert.deepEqual(read.files.map((f) => f.name), ['result.json']);
  assert.equal(artifactFromResult(cmd, {}, { jobId: 'j1' }), null);
  assert.equal(artifactFromResult(cmd, {}, { data: [] }), null);
});

test('export: the flag is added to exportable tools only and stripped before the backend call', () => {
  const tools = Object.fromEntries(listTools(COMMANDS).map((t) => [t.name, t]));
  for (const n of ['render__note_playback', 'render__chart', 'render__keyboard', 'param__get', 'preset__summary']) {
    assert.equal(tools[n].inputSchema.properties.export.type, 'boolean', n);
  }
  assert.equal(tools.play__note.inputSchema.properties.export, undefined);
  assert.deepEqual(splitExport(byName['render.note_playback'], { pitch: 60, export: true }), { args: { pitch: 60 }, exportRequested: true });
  assert.deepEqual(splitExport(byName['play.note'], { pitch: 60, export: true }), { args: { pitch: 60, export: true }, exportRequested: false });
});

test('MCP server: render with export:true -> the backend gets the args without export; the artefact is on disk', async () => {
  const dir = tmp();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/load_settings')) return { json: async () => ({ settings: { array_size: 384 } }) };
    return { json: async () => ({ ok: true, status: 200, result: { audio_data: [wav(523).toString('base64')], data: [[0, 1, 0, -1]], chart_headers: ['p72'] } }) };
  };
  const server = createPianoidMcpServer({ fetchImpl, artifactsDir: dir, commands: COMMANDS });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const r = await client.callTool({ name: 'render__note_playback', arguments: { pitch: 72, export: true } });
  const body = JSON.parse(r.content[0].text);
  assert.deepEqual(calls[0].body, { pitch: 72 });
  assert.equal(body.result.series[0].peak_abs, 1);                       // the model still sees the stats only
  assert.equal(body.artifact.files.length, 2);
  const meta = readArtifact(dir, body.artifact.id);
  assert.equal(meta.command, 'render.note_playback');
  assert.deepEqual(meta.args, { pitch: 72 });
  assert.equal(meta.load_settings.array_size, 384);
  const plain = JSON.parse((await client.callTool({ name: 'render__note_playback', arguments: { pitch: 60 } })).content[0].text);
  assert.equal(plain.artifact, undefined);
});

test('run_python input validation and the launcher argv (wall = timeout, cpu = timeout/2, disk 200 MB)', () => {
  assert.throws(() => validateInput({}), /code/);
  assert.throws(() => validateInput({ code: 'x'.repeat(70000) }), /at most/);
  assert.throws(() => validateInput({ code: 'p', inputs: ['../x'] }), /not an artefact id/);
  assert.throws(() => validateInput({ code: 'p', inputs: Array(11).fill('a-20261017000000-abcdef') }), /at most 10/);
  assert.throws(() => validateInput({ code: 'p', timeout_s: 500 }), /timeout_s/);
  assert.throws(() => validateInput({ code: 'p', memory_mb: 9000 }), /memory_mb/);
  const v = validateInput({ code: 'print(1)', timeout_s: 30 });
  assert.deepEqual([v.timeoutS, v.memoryMb], [30, 2048]);
  const args = launcherArgs({ runtime: 'R' }, 'D', v);
  const at = (k) => args[args.indexOf(k) + 1];
  assert.deepEqual([at('--profile'), at('--wall-s'), at('--cpu-s'), at('--mem-mb'), at('--disk-mb'), at('--script')],
    ['pianoid.analysis', '30', '15', '2048', '200', 'code.py']);
  assert.match(PRELUDE, /addaudithook/);
  assert.match(PRELUDE, /'user\.py', 'exec'/);
});

test('run_python handler (launcher faked): inputs copied, out\\ files become artefacts, over-cap skipped', async () => {
  const root = tmp();
  const paths = { root, runtime: path.join(root, 'runtime'), runs: path.join(root, 'runs'), artifacts: path.join(root, 'artifacts') };
  fs.mkdirSync(paths.runtime, { recursive: true });
  fs.writeFileSync(path.join(paths.runtime, 'python.exe'), '');
  const launcher = path.join(root, 'PianoidSandbox.exe');
  fs.writeFileSync(launcher, '');
  const input = createArtifact(paths.artifacts, { kind: 'render', source: 't', files: [{ name: 'audio_0.wav', data: wav(440) }] });
  let seen;
  const exec = async (file, args) => {
    const dir = args[args.indexOf('--run-dir') + 1];
    seen = { file, dir, user: fs.readFileSync(path.join(dir, 'user.py'), 'utf8'), index: JSON.parse(fs.readFileSync(path.join(dir, 'in', 'index.json'), 'utf8')) };
    assert.ok(fs.existsSync(path.join(dir, 'in', input.id, 'audio_0.wav')));
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out', 'cmp.png'), 'PNG');
    const j = {
      ok: true, exit: 0, exit_hex: '0x00000000', limits_hit: [], limits: { wall_s: 60 }, stdout: 'centroid 1234\n', stderr: '',
      files: [{ name: 'cmp.png', size: 3, over_cap: false }, { name: 'big.png', size: 9e6, over_cap: true }, { name: 'x.exe', size: 1, over_cap: false }],
    };
    return { stdout: `${JSON.stringify(j)}\n`, stderr: '' };
  };
  const r = await runPython({ code: 'print(1)', inputs: [input.id] }, { paths, launcher, exec });
  assert.equal(seen.file, launcher);
  assert.equal(seen.user, 'print(1)');
  assert.ok(seen.index[input.id]);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'centroid 1234\n');
  assert.equal(r.files.length, 1);
  assert.equal(readArtifact(paths.artifacts, r.files[0].artifact_id).source, 'analysis.run_python');
  assert.deepEqual(r.skipped.map((s) => s.name), ['big.png', 'x.exe']);
  assert.equal((await runPython({ code: 'p', inputs: ['a-20991231000000-abcdef'] }, { paths, launcher, exec })).error, 'inputs: unknown artefact a-20991231000000-abcdef');
  const killed = async () => ({ stdout: JSON.stringify({ ok: true, exit: 3235774465, exit_hex: '0xC0DE0001', limits_hit: ['wall'], stdout: '', stderr: '', files: [] }) });
  const k = await runPython({ code: 'p' }, { paths, launcher, exec: killed });
  assert.equal(k.ok, false);
  assert.deepEqual(k.limits_hit, ['wall']);
  assert.match((await runPython({ code: 'p' }, { paths, launcher: path.join(root, 'none.exe'), exec })).error, /not built/);
});

test('policy: rule code is Ask by default, may be Always allow; in a tainted turn the saved rule does not apply (still the same dialog); other tiers unchanged', () => {
  const v = decide({ ...ANALYSIS_CMD, command: ANALYSIS_CMD.name, settings: {} });
  assert.equal(v.action, 'ask');
  assert.equal(v.rule.id, 'code');                                     // "Always allow" sets the rule `code`
  const auto = { rules: { code: 'auto' } };
  const a = decide({ ...ANALYSIS_CMD, command: ANALYSIS_CMD.name, settings: auto });
  assert.deepEqual([a.action, a.auto, a.rule.id], ['allow', true, 'code']);
  const t = decide({ ...ANALYSIS_CMD, command: ANALYSIS_CMD.name, settings: { ...auto, tainted: true } });
  assert.equal(t.action, 'ask');
  assert.equal(t.rule.id, 'code');                                     // the same dialog, the same rule offered
  assert.match(t.taintNote, /untrusted content/);
  assert.equal(decide({ command: 'play.note', tier: 'act', family: 'playback', category: 'playback' }).action, 'allow');
  assert.equal(decide({ command: 'x', tier: 'excluded', category: 'code' }).action, 'deny');
});

test('PreToolUse hook: shells and unknown tools denied, analysis re-checked, never an allow of its own', () => {
  const s = new AssistantSession({ paths: {}, config: { model: 'auto' }, commands: COMMANDS, driverFactory: () => null });
  const decision = (name, input) => s.preToolUse({ tool_name: name, tool_input: input })?.hookSpecificOutput?.permissionDecision ?? 'continue';
  assert.equal(decision('Bash', { command: 'dir' }), 'deny');
  assert.equal(decision('PowerShell', { command: 'gci' }), 'deny');
  assert.equal(decision('Read', { file_path: 'C:/x' }), 'deny');
  assert.equal(decision('mcp__other__x', {}), 'deny');
  assert.equal(decision('mcp__pianoid__play__note', { pitch: 60 }), 'continue');
  assert.equal(decision('mcp__analysis__run_python', { code: '' }), 'deny');
  assert.equal(decision('mcp__analysis__run_python', { code: 'print(1)' }), 'continue');     // canUseTool asks next
});

test('canRunAnalysis (dev-auto1): "Don\'t ask again" for this installation persists Auto; Auto runs without a confirm via the sandbox runner; a tainted turn still asks; full code logged', async () => {
  const root = tmp();
  const paths = { root, config: path.join(root, 'config.json') };
  const sent = [];
  const runs = [];
  const runPythonImpl = async (args) => { runs.push(args); return { ok: true, exit: 0, files: [] }; };
  const mk = (config) => new AssistantSession({ paths, config, commands: COMMANDS, driverFactory: () => null, broadcast: (m) => sent.push(m), runPythonImpl });
  const s = mk({ model: 'auto' });
  const code = 'import numpy as np\n' + 'x = 1\n'.repeat(200);                  // longer than the activity summary
  const confirms = () => sent.filter((m) => m.type === 'confirm');

  const ask = s.canRunAnalysis({ code }, { toolUseID: 't1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(confirms().length, 1);                                  // default Ask
  assert.equal(confirms()[0].rule.id, 'code');
  s.confirm(confirms()[0].id, true, true);                             // Always allow
  assert.equal((await ask).behavior, 'allow');
  assert.equal(JSON.parse(fs.readFileSync(paths.config, 'utf8')).rules.code, 'auto');   // persisted
  const row = s.approvalsView().rules.find((r) => r.id === 'code');
  assert.deepEqual([row.mode, row.kind], ['auto', 'category']);

  // a restarted service over the same config.json: Auto, no confirm; the run still goes through the sandbox runner
  const s2 = mk(JSON.parse(fs.readFileSync(paths.config, 'utf8')));
  assert.equal((await s2.canRunAnalysis({ code }, { toolUseID: 't2' })).behavior, 'allow');
  assert.equal(confirms().length, 1);                                  // Auto: no new confirm
  await s2.runAnalysis({ code });
  assert.equal(runs.length, 1);
  const entry = s2.activity.findLast((a) => a.command === 'analysis.run_python');
  assert.equal(entry.decision, 'auto');
  assert.equal(entry.code, code);                                      // the full code, not the summary

  s2.tainted = true;
  const tainted = s2.canRunAnalysis({ code }, { toolUseID: 't3' });
  await new Promise((r) => setImmediate(r));
  assert.equal(confirms().length, 2);                                  // a tainted turn asks even on Always allow
  assert.deepEqual([confirms()[1].rule.id, !!confirms()[1].taintNote], ['code', true]);
  s2.confirm(confirms()[1].id, false);
  assert.equal((await tainted).behavior, 'deny');
  s2.tainted = false;
  assert.equal((await s2.canRunAnalysis({ code: '' }, {})).behavior, 'deny');   // invalid input: denied whatever the mode
});

// One real run in the production sandbox (skipped unless `node analysis/setup.js` was run on this machine).
const real = analysisPaths();
const realReady = process.platform === 'win32' && fs.existsSync(LAUNCHER) && fs.existsSync(path.join(real.runtime, 'python.exe'))
  && fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Packages', 'pianoid.analysis'));
test('real sandbox: two WAV artefacts -> spectra, peaks printed, a PNG artefact', { skip: !realReady && 'production sandbox not set up' }, async () => {
  const root = tmp();
  const paths = { ...real, runs: path.join(root, 'runs'), artifacts: path.join(root, 'artifacts') };
  const ids = [262, 523].map((f) => createArtifact(paths.artifacts, {
    kind: 'render', source: 'test', files: [{ name: 'audio_0.wav', data: wav(f, 48000, 48000) }, { name: 'series_0.npy', data: npyFloat64([1, 2, 3.5]) }],
  }).id);
  const code = `import numpy as np, soundfile as sf, matplotlib.pyplot as plt
peaks = []
fig, ax = plt.subplots()
for i in ${JSON.stringify(ids)}:
    y, sr = sf.read(artifact_path(i))
    s = np.abs(np.fft.rfft(y * np.hanning(len(y)))); f = np.fft.rfftfreq(len(y), 1 / sr)
    peaks.append(round(float(f[np.argmax(s)])))
    ax.semilogy(f[:3000], s[:3000])
fig.savefig(OUT + '/spectra.png', dpi=60)
print(peaks, float(np.load(artifact_path(${JSON.stringify(ids[0])}, 'series_0.npy')).sum()))
import socket
try:
    socket.create_connection(('127.0.0.1', 9), timeout=1); print('NET OPEN')
except PermissionError as e:
    print('audit hook:', 'blocked' in str(e))`;
  const r = await runPython({ code, inputs: ids, timeout_s: 60 }, { paths });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 800));
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ['[262, 523] 6.5', 'audit hook: True']);
  assert.equal(r.files[0].name, 'spectra.png');
  assert.equal(fs.readFileSync(artifactFile(paths.artifacts, r.files[0].artifact_id, 'spectra.png')).toString('latin1', 1, 4), 'PNG');
});
