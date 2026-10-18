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

/** The exact one-time login command for the user (PowerShell / Git Bash). */
export function loginCommand(paths) {
  return {
    powershell: `$env:CLAUDE_CONFIG_DIR="${paths.claudeHome}"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`,
    bash: `CLAUDE_CONFIG_DIR="${paths.claudeHome.replace(/\\/g, '/')}" claude auth login --claudeai`,
  };
}

/** The Claude Code CLI as [command, ...args]: `claude` on PATH (override PIANOID_ASSISTANT_CLAUDE_CLI, a JSON array). */
export function claudeCli(env = process.env) {
  return env.PIANOID_ASSISTANT_CLAUDE_CLI ? JSON.parse(env.PIANOID_ASSISTANT_CLAUDE_CLI) : ['claude'];
}

/** spawn options for the CLI: a bare name needs the shell on Windows (claude.cmd via PATHEXT). */
export function cliSpawnOptions(cli) {
  return { shell: process.platform === 'win32' && !path.isAbsolute(cli[0]), windowsHide: true };
}

/** `claude auth status --json` inside the isolated home (null when the CLI is not on PATH). Never a token. */
export function authStatus(paths, { spawn = spawnSync, env = process.env, cli = claudeCli(env) } = {}) {
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
