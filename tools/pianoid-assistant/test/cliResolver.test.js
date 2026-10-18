// The Claude CLI resolver (dev-5293): override > the SDK-bundled native binary > `claude` on PATH, so
// "Connect Claude subscription" works without a global CLI. Fakes for the order; one real check of the
// bundled binary on a THROWAWAY home (status = logged out, login prints a URL, then cancel; never completes OAuth).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assistantPaths, bundledClaudeCli, claudeCli, CLI_MISSING, ensureHome, loginCommand } from '../service/home.js';
import { AuthManager } from '../service/auth.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
const tmpPaths = () => ensureHome(assistantPaths({ PIANOID_ASSISTANT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-cli-test-')) }));
const never = () => { throw new Error('must not be consulted'); };

test('claudeCli: the override wins, then the bundled binary, then claude on PATH, else null', () => {
  assert.deepEqual(claudeCli({ PIANOID_ASSISTANT_CLAUDE_CLI: '["node","x.js"]' }, { bundled: never, onPath: never }), ['node', 'x.js']);
  assert.deepEqual(claudeCli({}, { bundled: () => 'C:\\sdk\\claude.exe', onPath: never }), ['C:\\sdk\\claude.exe']);
  assert.deepEqual(claudeCli({}, { bundled: () => null, onPath: () => true }), ['claude']);
  assert.equal(claudeCli({}, { bundled: () => null, onPath: () => false }), null);
});

test('bundledClaudeCli: the SDK platform package, as the SDK resolves it (linux: glibc / musl order)', () => {
  const asked = [];
  const resolve = (id) => { asked.push(id); return `/nm/${id}`; };
  assert.equal(bundledClaudeCli({ platform: 'win32', arch: 'x64', resolve, exists: () => true }), `/nm/${SDK}-win32-x64/claude.exe`);
  assert.equal(bundledClaudeCli({ platform: 'darwin', arch: 'arm64', resolve, exists: () => true }), `/nm/${SDK}-darwin-arm64/claude`);
  assert.equal(bundledClaudeCli({ platform: 'linux', arch: 'x64', musl: false, resolve, exists: (p) => p.endsWith('-musl/claude') }),
    `/nm/${SDK}-linux-x64-musl/claude`);
  asked.length = 0;
  bundledClaudeCli({ platform: 'linux', arch: 'x64', musl: true, resolve, exists: () => true });
  assert.deepEqual(asked, [`${SDK}-linux-x64-musl/claude`]);
  const missing = () => { throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' }); };
  assert.equal(bundledClaudeCli({ platform: 'win32', arch: 'x64', resolve: missing }), null);
  assert.equal(bundledClaudeCli({ platform: 'win32', arch: 'x64', resolve, exists: () => false }), null);
});

test('no CLI at all: status / login fail with the exact npm install fix; found later without a restart', () => {
  const paths = tmpPaths();
  let found = null;
  const a = new AuthManager({ paths, env: process.env, resolveCli: () => found });
  assert.equal(a.cli, null);
  assert.throws(() => a.status(), (e) => e.message === CLI_MISSING);
  assert.throws(() => a.login(), (e) => e.message === CLI_MISSING);
  assert.match(CLI_MISSING, /cd ".*pianoid-assistant"`? then `npm install`/);
  assert.equal(a.flowState().state, 'idle');
  found = [process.execPath, '-e', 'process.stdout.write(JSON.stringify({loggedIn:false,authMethod:"none"}))'];
  assert.equal(a.status().loggedIn, false);
  assert.equal(a.cli, found);
});

test('loginCommand: the terminal fallback names the resolved CLI', () => {
  const paths = assistantPaths({ PIANOID_ASSISTANT_HOME: 'X:\\iso' });
  assert.match(loginCommand(paths, ['claude']).powershell, /; claude auth login --claudeai;/);
  assert.match(loginCommand(paths, ['C:\\nm\\claude.exe']).powershell, /; & 'C:\\nm\\claude\.exe' auth login --claudeai;/);
  assert.match(loginCommand(paths, ['C:\\nm\\claude.exe']).bash, / "C:\/nm\/claude\.exe" auth login --claudeai$/);
});

const BUNDLED = bundledClaudeCli();
test('real: the SDK-bundled CLI in a throwaway home (logged out; login prints a URL; cancel)', { skip: !BUNDLED && 'SDK binary not installed' }, async () => {
  const paths = tmpPaths();
  assert.notEqual(path.resolve(paths.claudeHome), path.resolve(os.homedir(), '.claude'));
  const a = new AuthManager({ paths, env: process.env });
  assert.deepEqual(a.cli, [BUNDLED]);
  const s = a.status();
  assert.equal(s.loggedIn, false);
  assert.equal(path.resolve(s.configDirectory), path.resolve(paths.claudeHome));
  try {
    a.login();
    const t0 = Date.now();
    while (!a.flowState().manualUrl && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
    const f = a.flowState();
    assert.equal(f.state, 'waiting');
    assert.match(f.manualUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  } finally {
    assert.equal(a.cancel().state, 'cancelled');
  }
  assert.equal(a.status().loggedIn, false);
});
