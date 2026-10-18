// dev-6b34: ops_status (read-only installation status) and read_docs (one docs section), zero spend. The
// ops_status fixture is a throw-away install root with REAL git repos (dated commits = dated reflog entries),
// a fake venv (empty .pyd files with set mtimes) and fake node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INSTALL_ROOT, loadCommands } from '../lib/registry.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { buildIndex, pageKey, readSection, search } from '../mcp/docsIndex.js';
import { LOCAL_READ_TOOLS, listTools } from '../mcp/tools.js';
import { AssistantSession } from '../service/session.js';
import { hints, opsStatus, PRIMER_URL } from '../mcp/opsStatus.js';

const T = (h) => Date.parse(`2026-01-01T${String(h).padStart(2, "0")}:00:00Z`);
const git = (dir, args, at) => execFileSync('git', ['-C', dir, ...args], {
  env: { ...process.env, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() },
  stdio: 'pipe',
}).toString();
const write = (file, text, at) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (at) fs.utimesSync(file, new Date(at), new Date(at));
};
const commit = (dir, files, msg, at) => {
  for (const [f, text] of Object.entries(files)) write(path.join(dir, f), text);
  git(dir, ['add', '-A'], at);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], at);
};
const initRepo = (dir, branch, files, at) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', branch], at);
  git(dir, ['config', 'core.autocrlf', 'false'], at);
  commit(dir, files, 'init', at);
};

/** Install root: Install (master), Core / Basic / Tunner (dev); engine built at 11:00, Basic installed at 11:00. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-ops-'));
  initRepo(root, 'master', { '.gitignore': 'PianoidCore/\nPianoidBasic/\nPianoidTunner/\ntools/pianoid-assistant/node_modules/\n', 'tools/pianoid-assistant/package.json': '{}', 'tools/pianoid-assistant/package-lock.json': '{}' }, T(10));
  const core = path.join(root, 'PianoidCore');
  initRepo(core, 'dev', { 'pianoid_cuda/Main.cu': 'a', 'pianoid_cuda/setup.py': 's', 'pianoid_middleware/app.py': 'm', '.gitignore': '.venv/\n' }, T(10));
  const basic = path.join(root, 'PianoidBasic');
  initRepo(basic, 'dev', { 'Pianoid/model.py': 'x = 1\n', 'setup.py': 's' }, T(10));
  const tunner = path.join(root, 'PianoidTunner');
  initRepo(tunner, 'dev', { 'package.json': '{}', 'package-lock.json': '{}', 'src/App.js': 'a', '.gitignore': 'node_modules/\n' }, T(10));
  const site = path.join(core, '.venv', 'Lib', 'site-packages');
  write(path.join(site, 'pianoidCuda.cp312-win_amd64.pyd'), '', T(11));
  write(path.join(site, 'pianoidCuda_debug.cp312-win_amd64.pyd'), '', T(11));
  write(path.join(site, 'pianoid-0.1.15.dist-info', 'RECORD'), '', T(11));
  write(path.join(tunner, 'node_modules', '.package-lock.json'), '{}', T(11));
  write(path.join(root, 'tools', 'pianoid-assistant', 'node_modules', '.package-lock.json'), '{}', T(11));
  for (const dir of [root, core, basic, tunner]) {
    const branch = dir === root ? 'master' : 'dev';
    git(dir, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], T(10));
    write(path.join(dir, '.git', 'FETCH_HEAD'), '', T(10));
  }
  return { root, core, basic, tunner, site };
}
const sandbox = { launcher: 'X:/none.exe', paths: { runtime: 'X:/none' } };

test('ops_status: a clean, freshly built installation has no hints', async () => {
  const f = fixture();
  const r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.deepEqual(r.repos.map((x) => [x.name, x.branch, x.ahead, x.behind, x.dirty]),
    [['PianoidInstall', 'master', 0, 0, false], ['PianoidCore', 'dev', 0, 0, false], ['PianoidBasic', 'dev', 0, 0, false], ['PianoidTunner', 'dev', 0, 0, false]]);
  assert.equal(r.repos[1].last_fetch, '2026-01-01T10:00:00Z');
  assert.equal(r.engine.release.rebuild_needed, false);
  assert.equal(r.engine.debug.rebuild_needed, false);
  assert.equal(r.basic.version, '0.1.15');
  assert.equal(r.basic.rebuild_needed, false);
  assert.equal(r.tunner.needed, false);
  assert.equal(r.assistant.npm.needed, false);
  assert.deepEqual(r.hints, []);
  assert.equal(r.primer, PRIMER_URL);
});

test('ops_status: a pull after the build -> rebuild needed (committed diff since the build time); middleware-only -> not', async () => {
  const f = fixture();
  commit(f.core, { 'pianoid_middleware/app.py': 'm2' }, 'middleware', T(12));
  let r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.engine.release.rebuild_needed, false);
  commit(f.core, { 'pianoid_cuda/Main.cu': 'b' }, 'kernel', T(13));
  commit(f.basic, { 'Pianoid/model.py': 'x = 2\n' }, 'model', T(13));
  commit(f.tunner, { 'package-lock.json': '{"v":2}' }, 'deps', T(13));
  r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.engine.release.rebuild_needed, true);
  assert.deepEqual(r.engine.release.changed_since, ['PianoidCore/pianoid_cuda/Main.cu']);
  assert.equal(r.basic.rebuild_needed, true);
  assert.equal(r.tunner.needed, true);
  assert.deepEqual(r.hints.map((h) => h.code).sort(), ['basic_rebuild_needed', 'cuda_rebuild_needed', 'npm_ci_needed']);
  assert.ok(r.hints.every((h) => h.procedure.startsWith(PRIMER_URL)));
});

test('ops_status: a touched-but-unchanged file is not a rebuild; an uncommitted edit after the build is', async () => {
  const f = fixture();
  const model = path.join(f.basic, 'Pianoid', 'model.py');
  fs.utimesSync(model, new Date(T(14)), new Date(T(14)));       // e.g. `git checkout -- Pianoid/` after a build
  let r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.basic.rebuild_needed, false);
  write(path.join(f.core, 'pianoid_cuda', 'Main.cu'), 'edited', T(14));
  write(model, 'x = 3\n', T(10));                               // rewritten BY the build (before the install)
  r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.deepEqual(r.engine.release.changed_since, ['PianoidCore/pianoid_cuda/Main.cu']);
  assert.equal(r.basic.rebuild_needed, false);
  assert.ok(r.repos[1].dirty);
  assert.ok(r.hints.some((h) => h.code === 'local_changes' && h.repo === 'PianoidCore'));
});

test('ops_status: behind origin, a feature branch, a stale debug build, missing node_modules, pip leftovers', async () => {
  const f = fixture();
  git(f.core, ['checkout', '-q', '-b', 'feature/x'], T(10));
  commit(f.basic, { 'README.md': 'r' }, 'readme', T(10));   // a non-package file, before the install
  git(f.basic, ['update-ref', 'refs/remotes/origin/dev', 'HEAD'], T(10));
  git(f.basic, ['reset', '-q', '--hard', 'HEAD~1'], T(10));
  fs.utimesSync(path.join(f.site, 'pianoidCuda_debug.cp312-win_amd64.pyd'), new Date(T(9)), new Date(T(9)));
  fs.rmSync(path.join(f.tunner, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(f.site, '~ianoidcuda-0.1.0.dist-info'));
  const r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.repos[2].behind, 1);
  assert.equal(r.repos[1].branch, 'feature/x');
  const codes = r.hints.map((h) => h.code);
  for (const c of ['update_available', 'not_on_integration_branch', 'npm_ci_needed', 'pip_leftovers']) assert.ok(codes.includes(c), c);
  assert.equal(r.engine.debug.rebuild_needed, null);          // no reflog entry that old: unknown, not "fine"
  assert.match(r.engine.debug.unknown, /history of PianoidCore does not reach/);
});

test('ops_status: a build older than the reflog falls back to the input mtimes (not written since = fine)', async () => {
  const f = fixture();
  const debug = path.join(f.site, 'pianoidCuda_debug.cp312-win_amd64.pyd');
  fs.utimesSync(debug, new Date(T(9)), new Date(T(9)));
  for (const rel of ['pianoid_cuda/Main.cu', 'pianoid_cuda/setup.py']) fs.utimesSync(path.join(f.core, rel), new Date(T(8)), new Date(T(8)));
  let r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.engine.debug.rebuild_needed, false);
  assert.equal(r.engine.debug.unknown, undefined);
  fs.utimesSync(path.join(f.core, 'pianoid_cuda/Main.cu'), new Date(T(12)), new Date(T(12)));
  r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.engine.debug.rebuild_needed, null);
  assert.match(r.engine.debug.unknown, /history of PianoidCore does not reach/);
});

test('ops_status: missing pieces (no venv, no clone) and the never-write guarantee', async () => {
  const f = fixture();
  const index = path.join(f.core, '.git', 'index');
  const before = fs.statSync(index).mtimeMs;
  fs.rmSync(path.join(f.core, '.venv'), { recursive: true });
  fs.rmSync(f.tunner, { recursive: true, force: true });
  const r = await opsStatus({ root: f.root, env: {}, sandbox });
  assert.equal(r.venv.present, false);
  assert.equal(r.repos[3].present, false);
  const codes = r.hints.map((h) => h.code);
  assert.ok(codes.includes('engine_missing') && codes.includes('basic_rebuild_needed') && codes.includes('repo_missing'));
  assert.equal(fs.statSync(index).mtimeMs, before);           // GIT_OPTIONAL_LOCKS=0: status did not rewrite the index
  assert.equal(r.venv.path, path.join(f.core, '.venv'));
  assert.equal((await opsStatus({ root: f.root, env: { PIANOID_VENV_DIR: 'X:/v' }, sandbox })).venv.path, 'X:/v');
});

test('hints are pure and name the primer anchors', () => {
  const h = hints({
    repos: [{ name: 'PianoidCore', present: true, branch: 'dev', integration: 'dev', behind: 3, last_fetch: 't', dirty: false, changed: [] }],
    engine: { release: { built: 't', rebuild_needed: false }, debug: { built: 't', rebuild_needed: true } },
    basic: { built: 't', rebuild_needed: false }, tunner: { present: true, needed: false },
    assistant: { npm: { present: true, needed: true } }, leftovers: [],
  });
  assert.deepEqual(h.map((x) => [x.code, x.procedure.split('#')[1]]),
    [['update_available', 'update'], ['debug_variant_stale', 'rebuild'], ['assistant_npm_install_needed', 'assistant-setup']]);
});

test('read_docs: whole sections of the operations primer, outlines, links and errors', () => {
  const idx = buildIndex(path.join(INSTALL_ROOT, 'docs'));
  const outline = readSection(idx, { page: 'guides/OPERATIONS_FOR_ASSISTANT.md' }).outline.map((o) => o.anchor);
  for (const a of ['assistant-can-do', 'new-machine', 'start', 'update', 'rebuild', 'symptoms', 'gotchas', 'assistant-setup', 'conflicts']) {
    assert.ok(outline.includes(a), a);
  }
  const upd = readSection(idx, { page: 'http://localhost:8001/guides/OPERATIONS_FOR_ASSISTANT/#update' });
  assert.equal(upd.url, 'http://localhost:8001/guides/OPERATIONS_FOR_ASSISTANT/#update');
  assert.match(upd.text, /^## Update from git/);
  assert.match(upd.text, /update-repos\.bat/);
  assert.doesNotMatch(upd.text, /## Rebuild/);                   // stops at the next section of the same level
  const parent = readSection(idx, { page: 'guides/STARTUP_TROUBLESHOOTING.md', anchor: 'cuda-gpu-failures' });
  assert.match(parent.text, /### Symptom: `import pianoidCuda` fails/);   // a parent section carries its subsections
  assert.equal(readSection(idx, { page: 'PROJECT_CONFIG', anchor: 'ports' }).title, 'Ports');
  assert.equal(readSection(idx, { page: 'guides/NOPE.md' }).error, 'unknown_page');
  assert.equal(readSection(idx, { page: 'guides/QUICK_START.md', anchor: 'nope' }).error, 'unknown_anchor');
  assert.deepEqual(pageKey('docs\\guides\\QUICK_START.md'), { key: 'guides/quick_start', anchor: null });
  assert.ok(search(idx, 'update repos pull rebuild', 10).length > 0);
  const big = readSection(idx, { page: 'architecture/BUILD_SYSTEM.md', anchor: 'canonical-install-rebuild-read-this-first' });
  assert.ok(big.text.length <= 24000 + 200);
});

test('read_docs + ops_status: listed read-only, served by the MCP server, allowed by the session without a confirm', async () => {
  const commands = loadCommands();
  const tools = new Map(listTools(commands).map((t) => [t.name, t]));
  for (const name of ['read_docs', 'ops_status', 'search_docs']) {
    assert.equal(tools.get(name).annotations.readOnlyHint, true, name);
    assert.ok(LOCAL_READ_TOOLS.has(name), name);
  }
  const server = createPianoidMcpServer({ commands, fetchImpl: async () => { throw new Error('no backend'); }, readOps: async () => ({ hints: [], primer: PRIMER_URL }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const ops = await client.callTool({ name: 'ops_status', arguments: {} });
  assert.equal(JSON.parse(ops.content[0].text).primer, PRIMER_URL);
  const doc = await client.callTool({ name: 'read_docs', arguments: { page: 'guides/OPERATIONS_FOR_ASSISTANT.md', anchor: 'rebuild' } });
  assert.match(JSON.parse(doc.content[0].text).text, /--heavy --both/);
  const bad = await client.callTool({ name: 'read_docs', arguments: { page: 'nope' } });
  assert.equal(bad.isError, true);
  await client.close();
  const session = new AssistantSession({ paths: {}, config: {}, commands, driverFactory: () => null });
  for (const name of ['read_docs', 'ops_status']) {
    const v = await session.canUseTool(`mcp__pianoid__${name}`, { page: 'x' }, {});
    assert.equal(v.behavior, 'allow', name);
  }
  assert.equal(session.pending.size, 0);
});
