/**
 * The assistant's ISOLATED Claude home (user decision D1, 2026-10-15) and its runtime options.
 *
 * Root: %USERPROFILE%\.pianoid-assistant (override PIANOID_ASSISTANT_HOME)
 *   claude-home\   CLAUDE_CONFIG_DIR of the assistant: its own subscription login, .claude.json,
 *                  sessions, settings — never the user's ~/.claude
 *   workspace\     the session cwd: empty, outside every repo (no CLAUDE.md on it or its ancestors)
 *   config.json    service settings (model choice, data opt-out, the per-installation approvals)
 * One installation = one user (D5): whoever runs Pianoid logs the assistant in with THEIR OWN
 * subscription; %USERPROFILE% resolves per OS user, so users on a shared system stay separate.
 * The child process gets an ALLOW-LISTED env (never process.env): no ANTHROPIC_* key, and HOME /
 * USERPROFILE / APPDATA / LOCALAPPDATA pointing inside the root, so even a "~" path stays isolated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BILLING_FLIPPING_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const PASS_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ', 'CLAUDE_CODE_GIT_BASH_PATH'];

export function assistantPaths(env = process.env) {
  const root = env.PIANOID_ASSISTANT_HOME || path.join(env.USERPROFILE || os.homedir(), '.pianoid-assistant');
  return {
    root,
    claudeHome: path.join(root, 'claude-home'),
    workspace: path.join(root, 'workspace'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
    config: path.join(root, 'config.json'),
  };
}

export function ensureHome(paths) {
  for (const dir of [paths.root, paths.claudeHome, paths.workspace, paths.appData, paths.localAppData]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Names (never values) of billing-flipping keys present in an env. */
export function billingKeysIn(env = process.env) {
  return BILLING_FLIPPING_ENV_VARS.filter((k) => typeof env[k] === 'string' && env[k].trim());
}

/** Throw (fail fast) if the service itself was started with an API key in its environment. */
export function assertSubscriptionOnly(env = process.env) {
  const keys = billingKeysIn(env);
  if (keys.length) {
    throw new Error(`Refusing to start the assistant: ${keys.join(', ')} set in the environment would bill the `
      + 'paid API instead of the Claude subscription. Unset it and restart.');
  }
}

/** The child (Claude Code) environment: allow-listed + the isolated home. */
export function childEnv(paths, env = process.env) {
  const out = {};
  for (const k of PASS_THROUGH) if (env[k] !== undefined) out[k] = env[k];
  Object.assign(out, {
    CLAUDE_CONFIG_DIR: paths.claudeHome,
    HOME: paths.root,
    USERPROFILE: paths.root,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'pianoid-assistant/0.1.0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',   // no auto-memory, even inside the isolated home
  });
  return out;
}

/** The exact one-time login command for the user (PowerShell / Git Bash), with the CLI the service resolved. */
export function loginCommand(paths, cli = null) {
  const bare = !cli || (cli.length === 1 && cli[0] === 'claude');
  const ps = bare ? 'claude' : `& ${cli.map((a) => `'${a}'`).join(' ')}`;
  const sh = bare ? 'claude' : cli.map((a) => `"${a.replace(/\\/g, '/')}"`).join(' ');
  return {
    powershell: `$env:CLAUDE_CONFIG_DIR="${paths.claudeHome}"; ${ps} auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`,
    bash: `CLAUDE_CONFIG_DIR="${paths.claudeHome.replace(/\\/g, '/')}" ${sh} auth login --claudeai`,
  };
}

const ASSISTANT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_MISSING = 'The Claude Code CLI was not found. Fix: in a terminal run '
  + `\`cd "${ASSISTANT_DIR}"\` then \`npm install\` (it installs the CLI that ships with the Agent SDK), then restart the assistant.`;

const SDK = '@anthropic-ai/claude-agent-sdk';
const sdkResolve = (id) => createRequire(import.meta.resolve(SDK)).resolve(id);
const isMusl = () => process.platform === 'linux' && process.report?.getReport?.()?.header?.glibcVersionRuntime === undefined;

/**
 * The SDK's own native Claude Code binary (the one it runs the sessions with), resolved the way the SDK does:
 * its per-platform optional dependency `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude[.exe]`,
 * looked up from the SDK's location. null when `npm install` has not installed it.
 */
export function bundledClaudeCli({ platform = process.platform, arch = process.arch, musl = isMusl(), resolve = sdkResolve,
  exists = fs.existsSync } = {}) {
  const linux = [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`];
  const pkgs = platform === 'linux' ? (musl ? linux.reverse() : linux) : [`${SDK}-${platform}-${arch}`];
  for (const pkg of pkgs) {
    try {
      const p = resolve(`${pkg}/claude${platform === 'win32' ? '.exe' : ''}`);
      if (exists(p)) return p;
    } catch (e) { /* not installed: try the next */ }
  }
  return null;
}

/** Is a bare `claude` on PATH (claude.cmd / .exe via PATHEXT on Windows)? */
export function claudeOnPath({ spawn = spawnSync } = {}) {
  const r = spawn(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0;
}

/**
 * The Claude Code CLI as [command, ...args], or null when there is none:
 * PIANOID_ASSISTANT_CLAUDE_CLI (a JSON array) > the SDK-bundled binary > `claude` on PATH. No global install needed.
 */
export function claudeCli(env = process.env, { bundled = bundledClaudeCli, onPath = claudeOnPath } = {}) {
  if (env.PIANOID_ASSISTANT_CLAUDE_CLI) return JSON.parse(env.PIANOID_ASSISTANT_CLAUDE_CLI);
  const exe = bundled();
  if (exe) return [exe];
  return onPath() ? ['claude'] : null;
}

/** spawn options for the CLI: a bare name needs the shell on Windows (claude.cmd via PATHEXT). */
export function cliSpawnOptions(cli) {
  return { shell: process.platform === 'win32' && !path.isAbsolute(cli[0]), windowsHide: true };
}

/** `claude auth status --json` inside the isolated home (null when there is no CLI or it fails). Never a token. */
export function authStatus(paths, { spawn = spawnSync, env = process.env, cli = claudeCli(env) } = {}) {
  if (!cli) return null;
  const r = spawn(cli[0], [...cli.slice(1), 'auth', 'status', '--json'], {
    env: childEnv(paths, env), cwd: paths.workspace, encoding: 'utf8', timeout: 20000, ...cliSpawnOptions(cli),
  });
  if (r.error || r.status === null) return null;
  try {
    const s = JSON.parse(r.stdout);
    return {
      loggedIn: !!s.loggedIn, authMethod: s.authMethod, subscriptionType: s.subscriptionType ?? null, email: s.email ?? null,
      orgName: s.orgName ?? null, configDirectory: s.configDirectory ?? null,
    };
  } catch (e) {
    return null;
  }
}

export const DEFAULT_CONFIG = {
  model: 'auto',           // auto (Sonnet, may escalate) | sonnet | opus  (D2)
  dataOptOut: false,       // D4: default off
  approvals: {},           // v2 P2: {category: 'ask' | 'auto'} set "for this installation" (approvals.js defaults otherwise)
};

export function loadConfig(paths) {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(paths.config, 'utf8')) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(paths, config) {
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2));
}
