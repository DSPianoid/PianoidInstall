// The in-app subscription connect (dev-dc2a): service/auth.js + the /auth/* routes, against the fake CLI
// fixtures/fake-claude.js (never the real CLI, never a real home).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { assistantPaths, ensureHome } from '../service/home.js';
import { AuthManager, assertOwnHome, safeUrl } from '../service/auth.js';
import { createAssistantService } from '../service/server.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-claude.js');
const CLI = [process.execPath, FAKE];
const tmpPaths = () => ensureHome(assistantPaths({ PIANOID_ASSISTANT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-auth-test-')) }));
const ENV = { ...process.env, ANTHROPIC_API_KEY: 'sk-must-not-leak', ANTHROPIC_AUTH_TOKEN: 'tok' };
const until = async (pred, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};
const calls = (paths) => fs.readFileSync(path.join(paths.claudeHome, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

test('assertOwnHome: only the isolated claude-home, never ~/.claude or a home equal to the user profile', () => {
  const h = os.homedir();
  assert.throws(() => assertOwnHome({ root: h, claudeHome: path.join(h, 'claude-home') }), /isolated/);
  assert.throws(() => assertOwnHome({ root: path.join(h, 'x'), claudeHome: path.join(h, '.claude') }), /isolated/);
  assert.throws(() => assertOwnHome({ root: 'X:\\iso', claudeHome: 'X:\\other\\claude-home' }), /isolated/);
  assert.throws(() => new AuthManager({ paths: { root: h, claudeHome: path.join(h, 'claude-home') }, cli: CLI }), /isolated/);
  assert.doesNotThrow(() => assertOwnHome(tmpPaths()));
  assert.equal(safeUrl('https://claude.com/cai/oauth/authorize?x=1'), 'https://claude.com/cai/oauth/authorize?x=1');
  assert.equal(safeUrl('https://evil.example/claude.com'), null);
  assert.equal(safeUrl('http://claude.com/'), null);
});

test('status: the fake CLI in the isolated home; a CLI that reports another home is refused', () => {
  const paths = tmpPaths();
  const a = new AuthManager({ paths, env: ENV, cli: CLI });
  assert.equal(a.status().loggedIn, false);
  const c = calls(paths)[0];
  assert.equal(path.resolve(c.CLAUDE_CONFIG_DIR), path.resolve(paths.claudeHome));
  assert.ok(!c.env.some((k) => k.startsWith('ANTHROPIC_')), c.env.join(','));
  fs.writeFileSync(path.join(paths.claudeHome, 'fake-report-home.txt'), path.join(os.homedir(), '.claude'));
  assert.throws(() => a.status(), /another home/);
  assert.throws(() => a.logout(), /another home/);
  assert.ok(!calls(paths).some((x) => x.argv.includes('logout')));
});

test('login: URLs captured (BROWSER shim, no tab), the code goes to stdin, connected; logout', async () => {
  const paths = tmpPaths();
  const changes = [];
  const a = new AuthManager({ paths, env: ENV, cli: CLI, onChange: (s) => changes.push(s) });
  a.login();
  const f = await until(() => { const s = a.flowState(); return s.url && s.manualUrl && s.needsCode && s; });
  assert.equal(f.state, 'waiting');
  assert.match(f.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*localhost%3A1234/);
  assert.match(f.manualUrl, /platform\.claude\.com/);
  const login = calls(paths).find((c) => c.argv.includes('login'));
  assert.deepEqual(login.argv, ['auth', 'login', '--claudeai']);
  assert.match(login.BROWSER, /captureUrl\.(cmd|sh)$/);
  assert.ok(!login.env.some((k) => k.startsWith('ANTHROPIC_')));
  assert.throws(() => a.submitCode('bad code with spaces'), /code/);
  assert.equal(a.submitCode('good#S').state, 'verifying');
  await until(() => a.flowState().state === 'connected');
  assert.equal(changes.at(-1).loggedIn, true);
  assert.equal(a.status().email, 'user@example.com');
  assert.ok(!fs.existsSync(a.urlFile));
  const out = a.logout();
  assert.equal(out.before.loggedIn, true);
  assert.equal(out.after.loggedIn, false);
  assert.equal(changes.at(-1).loggedIn, false);
});

test('login: the browser callback completes it without a code; a wrong code fails with the CLI message', async () => {
  const paths = tmpPaths();
  const a = new AuthManager({ paths, env: ENV, cli: CLI });
  a.login();
  await until(() => a.flowState().state === 'waiting');
  fs.writeFileSync(path.join(paths.claudeHome, 'fake-callback'), '');
  await until(() => a.flowState().state === 'connected');
  a.logout();
  fs.rmSync(path.join(paths.claudeHome, 'fake-callback'));
  a.login();
  await until(() => a.flowState().state === 'waiting');
  a.submitCode('wrong#S');
  const f = await until(() => a.flowState().state === 'failed' && a.flowState());
  assert.match(f.error, /status code 400/);
});

test('login: cancel kills the CLI; timeout ends it; a second login while active is the same flow', async () => {
  const paths = tmpPaths();
  const a = new AuthManager({ paths, env: ENV, cli: CLI, timeoutMs: 600 });
  a.login();
  const pid = a.child.pid;
  await until(() => a.flowState().state === 'waiting');
  assert.equal(a.login().state, 'waiting');
  assert.equal(a.child.pid, pid);
  assert.equal(a.cancel().state, 'cancelled');
  await until(() => !alive(pid));
  a.login();
  const pid2 = a.child.pid;
  await until(() => a.flowState().state === 'timeout', 5000);
  await until(() => !alive(pid2));
  assert.throws(() => a.submitCode('good#S'), /No sign-in/);
});

test('HTTP /auth/*: status, login, cancel, logout confirm; JSON + localhost origins only; WS login broadcast', async () => {
  const paths = tmpPaths();
  const svc = createAssistantService({ env: { ...process.env, ANTHROPIC_API_KEY: '', PIANOID_ASSISTANT_HOME: paths.root }, port: 0, driver: 'fake', authOptions: { cli: CLI } });
  const port = await svc.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body = {}, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  try {
    const st = await (await fetch(`${base}/auth/status?recheck=1`)).json();
    assert.equal(st.login.loggedIn, false);
    assert.equal(st.flow.state, 'idle');
    assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', body: '{}' })).status, 405);           // not JSON
    assert.equal((await post('/auth/login', {}, { Origin: 'https://evil.example' })).status, 403);
    const pre = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const r = await post('/auth/login', {}, { Origin: 'http://localhost:3000' });
    assert.equal(r.status, 200);
    let flow;
    for (let i = 0; i < 300 && !(flow?.url); i++) {
      flow = (await (await fetch(`${base}/auth/status`)).json()).flow;
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(flow.state, 'waiting');
    assert.match(flow.url, /^https:\/\/claude\.com\//);
    assert.equal((await (await post('/auth/login/cancel')).json()).flow.state, 'cancelled');
    assert.equal((await post('/auth/login/code', { code: 'good#S' })).status, 409);                         // nothing waiting
    await post('/auth/login');
    for (let i = 0; i < 300 && (await (await fetch(`${base}/auth/status`)).json()).flow.state !== 'waiting'; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal((await (await post('/auth/login/code', { code: 'good#S' })).json()).flow.state, 'verifying');
    await until(() => msgs.some((m) => m.type === 'login' && m.login?.loggedIn));
    const on = (await (await fetch(`${base}/auth/status`)).json()).login;
    assert.deepEqual([on.email, on.subscriptionType, on.subscription], ['user@example.com', 'max', true]);
    assert.ok(!JSON.stringify(on).match(/token|secret/i));
    assert.equal((await post('/auth/logout', {})).status, 400);                                               // no confirm
    const out = await (await post('/auth/logout', { confirm: true })).json();
    assert.equal(out.after.loggedIn, false);
    assert.equal(out.login.loggedIn, false);
  } finally {
    ws.close();
    await svc.close();
  }
});
