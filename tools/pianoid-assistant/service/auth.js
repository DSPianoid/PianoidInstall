/**
 * The in-app "Connect Claude subscription" flow (dev-dc2a): login / logout of the assistant's ISOLATED
 * Claude home only (D1), driven by the pane over GET /auth/status, POST /auth/login | /auth/login/code |
 * /auth/login/cancel | /auth/logout (service/server.js).
 *
 * What `claude auth login --claudeai` does without a TTY (CLI 2.1.302, measured on a throwaway home):
 *   - prints `If the browser didn't open, visit: <manual URL>` (redirect to platform.claude.com, which shows
 *     a code) and `Paste code here if prompted > `, then reads the code from stdin;
 *   - and at the same time opens a browser itself with the automatic URL (redirect to its own
 *     http://localhost:<port>/callback listener) through `$BROWSER <url>` (else rundll32).
 * The service sets BROWSER to captureUrl.cmd / .sh, so no tab opens behind the user's back: the pane's
 * "Open Claude login" opens the automatic URL in the user's browser (it completes on its own), and the
 * manual URL + code field is the fallback. Either way the CLI writes the credentials into the isolated home.
 * Never returns or logs a token: the CLI output parsed here holds only URLs and status lines.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { CLI_MISSING, authStatus, childEnv, claudeCli, cliSpawnOptions } from './home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(claude\.com|claude\.ai|anthropic\.com)(\/|$)/i;
const CODE_RE = /^[\w\-#.~]{1,1024}$/;
const ACTIVE = new Set(['starting', 'waiting', 'verifying']);

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Throw unless `paths` is the service's own isolated home: claude-home inside the root, never ~/.claude. */
export function assertOwnHome(paths, env = process.env) {
  const home = norm(paths.claudeHome);
  const forbidden = [os.homedir(), env.USERPROFILE, env.HOME].filter(Boolean).map((h) => norm(path.join(h, '.claude')));
  const profiles = [os.homedir(), env.USERPROFILE, env.HOME].filter(Boolean).map(norm);
  if (home !== norm(path.join(paths.root, 'claude-home')) || forbidden.includes(home) || profiles.includes(norm(paths.root))) {
    throw new Error(`Refusing to touch ${paths.claudeHome}: not the assistant's isolated Claude home`);
  }
}

/** Only https links to Claude / Anthropic reach the pane (it renders them as links). */
export const safeUrl = (u) => (typeof u === 'string' && URL_HOSTS.test(u) ? u : null);

/** The account fields the pane shows (never a token). */
export const publicLogin = (s) => (s && {
  loggedIn: s.loggedIn, authMethod: s.authMethod, subscription: s.authMethod === 'claude.ai',
  subscriptionType: s.subscriptionType, email: s.email, orgName: s.orgName,
});

export class AuthManager {
  constructor({
    paths, env = process.env, cli = null, resolveCli = claudeCli, spawn = spawnAsync, spawnSyncImpl = spawnSync,
    timeoutMs = LOGIN_TIMEOUT_MS, onChange = () => {}, pollMs = 200,
  }) {
    assertOwnHome(paths, env);
    Object.assign(this, { paths, env, cli: cli || resolveCli(env), resolveCli, spawn, spawnSyncImpl, timeoutMs, onChange, pollMs });
    this.urlFile = path.join(paths.root, 'auth-url.txt');
    this.flow = { state: 'idle' };
    this.child = null;
  }

  /** The CLI to run (re-resolved while none was found, so an `npm install` needs no service restart). */
  requireCli() {
    this.cli ||= this.resolveCli(this.env);
    if (!this.cli) throw new Error(CLI_MISSING);
    return this.cli;
  }

  status() {
    assertOwnHome(this.paths, this.env);
    this.requireCli();
    const s = authStatus(this.paths, { spawn: this.spawnSyncImpl, env: this.env, cli: this.cli });
    if (s?.configDirectory && norm(s.configDirectory) !== norm(this.paths.claudeHome)) {
      throw new Error(`The CLI reported another home (${s.configDirectory}); refusing`);
    }
    return s;
  }

  flowState() {
    const { state, url, manualUrl, needsCode, error, expiresAt } = this.flow;
    return { state, url: url || null, manualUrl: manualUrl || null, needsCode: !!needsCode, error: error || null, expiresAt: expiresAt || null };
  }

  login() {
    if (ACTIVE.has(this.flow.state)) return this.flowState();
    assertOwnHome(this.paths, this.env);
    this.requireCli();
    fs.rmSync(this.urlFile, { force: true });
    const env = {
      ...childEnv(this.paths, this.env),
      BROWSER: path.join(HERE, process.platform === 'win32' ? 'captureUrl.cmd' : 'captureUrl.sh'),
      PIANOID_AUTH_URL_FILE: this.urlFile,
    };
    const child = this.spawn(this.cli[0], [...this.cli.slice(1), 'auth', 'login', '--claudeai'], {
      env, cwd: this.paths.workspace, stdio: ['pipe', 'pipe', 'pipe'], ...cliSpawnOptions(this.cli),
    });
    this.child = child;
    this.flow = { state: 'starting', out: '', expiresAt: Date.now() + this.timeoutMs };
    const onData = (d) => this.#parse(String(d));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => this.#finish(child, 'failed', `Could not run the Claude CLI: ${e.message}`));
    child.on('close', (code) => this.#exited(child, code));
    this.poll = setInterval(() => this.#readUrlFile(), this.pollMs);
    this.timer = setTimeout(() => this.#finish(child, 'timeout', 'The sign-in timed out; start it again'), this.timeoutMs);
    return this.flowState();
  }

  submitCode(code) {
    if (this.flow.state !== 'waiting') throw new Error('No sign-in is waiting for a code');
    const c = String(code || '').trim();
    if (!CODE_RE.test(c)) throw new Error('That does not look like a sign-in code');
    this.child.stdin.write(`${c}\n`);
    this.flow.state = 'verifying';
    return this.flowState();
  }

  cancel() {
    if (ACTIVE.has(this.flow.state)) this.#finish(this.child, 'cancelled', null);
    return this.flowState();
  }

  logout() {
    this.cancel();
    const s = this.status();      // asserts the home and that the CLI really reads it
    const r = this.spawnSyncImpl(this.cli[0], [...this.cli.slice(1), 'auth', 'logout'], {
      env: childEnv(this.paths, this.env), cwd: this.paths.workspace, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
      ...cliSpawnOptions(this.cli),
    });
    if (r.error || r.status !== 0) throw new Error(`claude auth logout failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
    this.flow = { state: 'idle' };
    const after = this.status();
    this.onChange(after);
    return { before: publicLogin(s), after: publicLogin(after) };
  }

  #parse(text) {
    this.flow.out = (this.flow.out + text).slice(-8000);
    const manual = /visit:\s*(https:\/\/\S+)/.exec(this.flow.out);
    if (manual && !this.flow.manualUrl) this.flow.manualUrl = safeUrl(manual[1]);
    if (/Paste code here/i.test(this.flow.out)) this.flow.needsCode = true;
    if (this.flow.state === 'starting' && (this.flow.manualUrl || this.flow.url)) this.flow.state = 'waiting';
  }

  #readUrlFile() {
    if (this.flow.url || !ACTIVE.has(this.flow.state)) return;
    let raw;
    try { raw = fs.readFileSync(this.urlFile, 'utf8'); } catch (e) { return; }
    const url = safeUrl(raw.trim().replace(/^"|"$/g, ''));
    if (!url) return;
    this.flow.url = url;
    if (this.flow.state === 'starting') this.flow.state = 'waiting';
  }

  #exited(child, code) {
    if (child !== this.child || !ACTIVE.has(this.flow.state)) return;
    if (code === 0) {
      const s = this.status();
      if (s?.loggedIn) return this.#finish(child, 'connected', null, s);
    }
    const failed = /Login failed:\s*(.*)/.exec(this.flow.out || '');
    this.#finish(child, 'failed', failed ? failed[1].trim() : `The Claude CLI exited (${code})`);
  }

  #finish(child, state, error, login = null) {
    if (child !== this.child) return;
    clearInterval(this.poll);
    clearTimeout(this.timer);
    this.child = null;
    if (child.exitCode === null && !child.killed) killTree(child);
    fs.rmSync(this.urlFile, { force: true });
    this.flow = { ...this.flow, state, error, out: undefined };
    if (login) this.onChange(login);
  }
}

/** The login child runs through cmd.exe on Windows: kill the whole tree (the CLI and its callback listener). */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}
