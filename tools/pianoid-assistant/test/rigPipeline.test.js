// dev-8a9e: the rig measurement pipeline in the assistant — the registry commands (modal.rig_*, preset.create),
// their policy (hard confirm, data opt-out), `export: true` on modal.rig_files (run files -> one analysis artefact,
// names flattened, size cap) through the real MCP server, and the sandbox disk budget for large inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { attributesOf, decide } from '../policy.js';
import { loadCommands } from '../lib/registry.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { listTools } from '../mcp/tools.js';
import { createArtifact, readArtifact } from '../analysis/store.js';
import { artifactFromResult, flatName, RIG_EXPORT_MAX_BYTES } from '../analysis/export.js';
import { launcherArgs, LIMITS, prepareRun } from '../analysis/runPython.js';

const COMMANDS = loadCommands();
const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-rig-test-'));
const DRIVES = ['modal.rig_capture', 'modal.rig_sine', 'modal.rig_record', 'modal.rig_process', 'preset.create', 'preset.add_thump'];
const verdict = (name, settings = {}) => {
  const c = byName[name];
  return decide({ command: c.name, tier: c.tier, family: c.family, category: c.approval_category, settings });
};

test('registry: the rig commands exist, typed, long-running in the rig job family', () => {
  for (const n of DRIVES) {
    const c = byName[n];
    assert.ok(c, n);
    assert.equal(c.approval_category, 'per_command', n);
    assert.equal(c.long_running, true, n);
    assert.equal(c.job_family, 'rig', n);
  }
  for (const n of ['modal.rig_runs', 'modal.rig_files']) assert.equal(byName[n].tier, 'read', n);
  const lv = byName['modal.rig_capture'].args.properties.exciters.items.properties.level_dbfs;
  assert.equal(lv.maximum, -24);
  assert.equal(byName['modal.rig_sine'].args.properties.outputs.items.properties.level_dbfs.maximum, -24);
  assert.deepEqual(byName['modal.rig_process'].args.properties.step.enum, ['frf', 'polymax', 'coefficients', 'build_preset']);
  for (const k of ['num_strings', 'num_channels', 'array_size', 'name']) assert.ok(byName['preset.create'].args.required.includes(k), k);
});

test('registry: preset.add_thump takes typed options only, no overwrite and no free-form argument', () => {
  const a = byName['preset.add_thump'].args;
  assert.deepEqual(a.required, ['source', 'name']);
  assert.equal(a.additionalProperties, false);
  assert.equal(a.properties.overwrite, undefined);
});

test('policy: every rig drive / write has its own rule (category Always allow does not cover it; its rule does); reads run; opt-out denies', () => {
  const allAuto = { rules: Object.fromEntries(['playback', 'renders', 'params', 'runtime', 'preset_nav'].map((c) => [c, 'auto'])) };
  for (const n of DRIVES) {
    const v = verdict(n, allAuto);
    assert.deepEqual([v.action, v.rule.id], ['ask', n], n);
    assert.equal(verdict(n, { rules: { [n]: 'auto' } }).action, 'allow', n);
  }
  // the loopback marker has no level (the 2026-10-27 prompt): rule rig.drive.any_level, not modal.rig_capture
  const cap = byName['modal.rig_capture'];
  const input = { exciters: [{ output: 'Out 1', level_dbfs: -24 }], inputs: [{ input: 'In 1' }], loopback: { output: 'Out 9', input: 'In 8' } };
  const attrs = attributesOf(cap, input);
  assert.deepEqual(attrs, { driveLevel: 'unverified', why: 'output Out 9: level not stated' });
  const d = (rules) => decide({ command: cap.name, tier: cap.tier, family: cap.family, category: cap.approval_category, attrs, settings: { rules } });
  assert.deepEqual([d({ 'modal.rig_capture': 'auto' }).action, d({}).rule.id, d({}).rule.dangerous], ['ask', 'rig.drive.any_level', true]);
  assert.equal(d({ 'rig.drive.any_level': 'auto' }).action, 'allow');
  assert.deepEqual(attributesOf(cap, { ...input, loopback: null }), { driveLevel: 'ok' });
  assert.deepEqual(attributesOf(cap, { ...input, dry_run: true }), {});
  assert.equal(verdict('modal.rig_runs').action, 'allow');
  assert.equal(verdict('modal.rig_files').action, 'allow');
  for (const n of ['modal.rig_capture', 'modal.rig_record', 'modal.rig_files']) assert.equal(verdict(n, { dataOptOut: true }).action, 'deny', n);
  const names = listTools(COMMANDS).map((t) => t.name);
  for (const n of [...DRIVES, 'modal.rig_runs', 'modal.rig_files', 'modal.rig_cancel']) assert.ok(names.includes(n.replace(/\./g, '__')), n);
});

test('export: modal.rig_files copies the resolved run files into one artefact with flattened names', () => {
  const run = tmp();
  fs.mkdirSync(path.join(run, 'sessions', 'E1_m42_r1'), { recursive: true });
  const data = path.join(run, 'sessions', 'E1_m42_r1', 'data.npy');
  fs.writeFileSync(data, Buffer.alloc(1000, 7));
  const table = path.join(run, 'measured_table.json');
  fs.writeFileSync(table, '{"modes": []}');
  const result = { run: 'r', area: 'rig_runs', files: [{ name: 'sessions/E1_m42_r1/data.npy', path: data, size: 1000 },
    { name: 'coefficients/measured_table.json', path: table, size: 13 }] };
  const spec = artifactFromResult(byName['modal.rig_files'], { run: 'r', files: [] }, result);
  assert.deepEqual(spec.files.map((f) => f.name), ['sessions__E1_m42_r1__data.npy', 'coefficients__measured_table.json']);
  const dir = tmp();
  const rec = createArtifact(dir, spec);
  assert.equal(readArtifact(dir, rec.id).files[0].size, 1000);
  assert.equal(readArtifact(dir, rec.id).original_names['sessions__E1_m42_r1__data.npy'], 'sessions/E1_m42_r1/data.npy');
  assert.deepEqual(fs.readFileSync(path.join(dir, rec.id, 'sessions__E1_m42_r1__data.npy')), fs.readFileSync(data));
  assert.equal(flatName('a\\b/c.npy'), 'a__b__c.npy');
  assert.throws(() => artifactFromResult(byName['modal.rig_files'], {}, { files: [{ name: 'x.exe', path: data }] }), /cannot export/);
  assert.ok(RIG_EXPORT_MAX_BYTES >= 400 * 1e6);
});

test('MCP: modal.rig_files with export: true -> artefact id the analysis tool can take', async () => {
  const run = tmp();
  const f = path.join(run, 'data.npy');
  fs.writeFileSync(f, Buffer.alloc(64, 1));
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (!init) return { json: async () => ({ settings: { array_size: 512 } }) };          // /load_settings
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 200, result: { run: 'r', area: 'rig_runs', files: [{ name: 'sessions/record/data.npy', path: f, size: 64 }] } }) };
  };
  const artifactsDir = tmp();
  const server = createPianoidMcpServer({ fetchImpl, artifactsDir });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tool = (await client.listTools()).tools.find((t) => t.name === 'modal__rig_files');
  assert.ok(tool.inputSchema.properties.export);
  const r = await client.callTool({ name: 'modal__rig_files', arguments: { run: 'r', files: ['sessions/record/data.npy'], export: true } });
  const out = JSON.parse(r.content[0].text);
  assert.equal(calls[0].url, 'http://127.0.0.1:5000/command/modal.rig_files');
  assert.equal(calls[0].body.export, undefined);
  assert.match(out.artifact.id, /^a-\d{14}-[0-9a-f]{6}$/);
  assert.equal(readArtifact(artifactsDir, out.artifact.id).files[0].name, 'sessions__record__data.npy');
});

test('sandbox: the disk budget grows by the copied input size (rig recordings), and the copies are counted', () => {
  const paths = { runs: tmp(), artifacts: tmp(), runtime: 'C:/rt' };
  const rec = createArtifact(paths.artifacts, { kind: 'rig', source: 't', files: [{ name: 'big.npy', data: Buffer.alloc(3 * 1024 * 1024) }] });
  const run = prepareRun(paths, { code: 'print(1)', inputs: [rec.id] });
  assert.equal(run.inputBytes, 3 * 1024 * 1024);
  const argv = launcherArgs(paths, run.dir, { timeoutS: 60, memoryMb: 2048, inputBytes: run.inputBytes });
  assert.equal(argv[argv.indexOf('--disk-mb') + 1], String(LIMITS.diskMb + 3));
  const plain = launcherArgs(paths, run.dir, { timeoutS: 60, memoryMb: 2048 });
  assert.equal(plain[plain.indexOf('--disk-mb') + 1], String(LIMITS.diskMb));
});
