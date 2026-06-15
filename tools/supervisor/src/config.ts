/**
 * Config load + resolution.
 *
 * Resolves: the supervisor's OWN state dir (its queue + capture live here, NOT
 * in the live plugin's state dir — so it never contends with the running bot),
 * the Telegram token source, the Python interpreter + STT/TTS helper script
 * paths, and the read-only path to the live plugin's access.json (for the gate).
 *
 * SECRET HYGIENE: the production token is read from `TELEGRAM_BOT_TOKEN` (real
 * env wins), else from the channel `.env` file, ONLY to compute the `hasToken`
 * boolean. The raw secret is NEVER logged, printed, or exposed via an accessor
 * (review M1) — `loadConfig` returns only `hasToken`. The live transport uses
 * the DEDICATED `SUPERVISOR_TELEGRAM_TOKEN` (resolved in the entrypoint), never
 * the production token.
 *
 * Concern (P2): produce a resolved config object. No I/O beyond reading the
 * optional `.env` for the token.
 *
 * Traces: plugin server.ts env load (lines 31-42) + orchestrator brief "Secret
 * hygiene" + "the supervisor uses its OWN state dir".
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LogLevel } from './logger.js';
import type { PermissionPolicy } from './permission-router.js';

/**
 * The conservative DEFAULT permission policy for the hosted session (review M2:
 * lifted out of the entrypoint so policy is config, not a literal buried in
 * index.ts). Read-only + channel tools auto-allow; everything else ROUTES to the
 * user (the FC-1 path). The allow-list can be extended via the
 * `SUPERVISOR_PERMISSION_ALLOW` env var (comma-separated); the fallback stays
 * 'route' (never auto-allow) unless a future project config overrides it.
 */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  allow: ['Read', 'Glob', 'Grep', 'mcp__telegram__*'],
  fallback: 'route',
};

export interface SupervisorConfig {
  /** The supervisor's own state dir (queue + capture + logs live under here). */
  stateDir: string;
  /** Capture-store NDJSON file path. */
  captureFile: string;
  /** Telegram adapter's durable delivery-queue dir. */
  telegramQueueDir: string;
  /** Dir for downloaded inbound files (voice notes). */
  downloadDir: string;
  /** Log file path (NDJSON), if file logging is enabled. */
  logFile: string;
  /** Minimum log level. */
  logLevel: LogLevel;
  /** Read-only path to the live plugin's access.json (for the gate). */
  accessFile: string;
  /**
   * Whether the PRODUCTION Telegram token FILE is present (env var or the
   * channel `.env`) — a file-presence boolean ONLY (review M12-P1 cleanup: was
   * the misleadingly-named `hasToken`). It does NOT mean a production token was
   * read into a value or reached a transport; the live `--live` path uses the
   * DEDICATED `SUPERVISOR_TELEGRAM_TOKEN`, never this one.
   */
  productionTokenFilePresent: boolean;
  /** Python interpreter for the voice helpers. */
  python: string;
  /** Absolute path to transcribe_voice.py. */
  sttScript: string;
  /** Absolute path to tts_voice.py. */
  ttsScript: string;
  /** Web panel port (read-only panel; 0 disables). */
  panelPort: number;
  /**
   * Permission policy for the hosted session (review M2: policy is config, not a
   * literal in the entrypoint). Defaults to {@link DEFAULT_PERMISSION_POLICY};
   * the allow-list extends via `SUPERVISOR_PERMISSION_ALLOW` (comma-separated).
   */
  permissionPolicy: PermissionPolicy;
}

export interface LoadConfigOptions {
  /** Override the supervisor state dir (default ~/.claude/supervisor). */
  stateDir?: string;
  /** Override the repo's tools dir (to locate the Python helpers). */
  toolsDir?: string;
  /** Override the channel state dir (where the live plugin's .env/access.json live). */
  channelDir?: string;
  /** Explicit log level. */
  logLevel?: LogLevel;
  /** Panel port. Default 0 (disabled) — read-only panel is opt-in for Phase 1. */
  panelPort?: number;
  /** Override the python interpreter. */
  python?: string;
}

/** Read a token from env, else from the channel `.env` file. Never logs it. */
function resolveToken(channelDir: string): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  const envFile = join(channelDir, '.env');
  if (!existsSync(envFile)) return undefined;
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/);
      if (m) return m[1]!.trim();
    }
  } catch {
    // unreadable .env — treat as no token
  }
  return undefined;
}

export function loadConfig(opts: LoadConfigOptions = {}): SupervisorConfig {
  const stateDir = resolve(opts.stateDir ?? join(homedir(), '.claude', 'supervisor'));
  const channelDir = resolve(opts.channelDir ?? join(homedir(), '.claude', 'channels', 'telegram'));
  // Default the tools dir to this package's repo siblings (tools/).
  const toolsDir = resolve(opts.toolsDir ?? join(homedir(), '.claude'));

  return {
    stateDir,
    captureFile: join(stateDir, 'capture', 'events.ndjson'),
    telegramQueueDir: join(stateDir, 'queue', 'telegram'),
    downloadDir: join(stateDir, 'downloads'),
    logFile: join(stateDir, 'supervisor.log'),
    logLevel: opts.logLevel ?? 'info',
    accessFile: join(channelDir, 'access.json'),
    productionTokenFilePresent: resolveToken(channelDir) !== undefined,
    python: opts.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
    sttScript: join(toolsDir, 'transcribe_voice.py'),
    ttsScript: join(toolsDir, 'tts_voice.py'),
    panelPort: opts.panelPort ?? 0,
    permissionPolicy: resolvePermissionPolicy(),
  };
}

/**
 * Resolve the hosted-session permission policy (review M2). Starts from
 * {@link DEFAULT_PERMISSION_POLICY}; if `SUPERVISOR_PERMISSION_ALLOW` is set
 * (comma-separated tool names/patterns), those entries are ADDED to the allow-
 * list. The fallback is NOT env-overridable to 'allow' here (M1: auto-allow is a
 * footgun) — a locked-down 'deny' or a future project config can change it, but
 * the env can only widen the explicit allow-list, never disable the safety floor.
 */
function resolvePermissionPolicy(): PermissionPolicy {
  const extra = (process.env.SUPERVISOR_PERMISSION_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = [...DEFAULT_PERMISSION_POLICY.allow];
  for (const e of extra) if (!allow.includes(e)) allow.push(e);
  return { ...DEFAULT_PERMISSION_POLICY, allow };
}

// NOTE (review M1): there is deliberately NO exported accessor for the raw
// PRODUCTION token. Phase 1 needs only `hasToken` (a boolean), and the live
// transport uses the DEDICATED `SUPERVISOR_TELEGRAM_TOKEN` (resolved in the
// entrypoint), never the production `TELEGRAM_BOT_TOKEN`. Exporting a
// `getToken()` that returns the production secret would be a footgun: a future
// Phase-2 author could wire it into a poller in one line and undo the
// loopback-safety architecture. The production-token cut-over is a Phase-3
// step and will add its own explicitly-named, guarded accessor then.
