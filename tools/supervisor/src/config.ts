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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROACTIVE_WATCH_INTERVAL_MS,
  DEFAULT_TURN_WATCHDOG_MS,
  DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS,
} from './control-command.js';
import type { LogLevel } from './logger.js';
import type { PermissionPolicy } from './permission-router.js';
import { isRoleRoutingEnabled } from './role-router.js';

/**
 * The supervisor PACKAGE root (`tools/supervisor`), derived from THIS module's
 * own location so it is independent of the process cwd. At runtime this compiled
 * module lives at `tools/supervisor/dist/config.js`, so the package root is two
 * dirs up. The repo root is one further up from `tools/`. Used to locate the
 * Python voice helpers (`<repo>/tools/*.py`) and the repo venv interpreter —
 * which the running supervisor previously MISSED (it defaulted to `~/.claude`,
 * where the scripts do not live, and bare `python`, which lacks faster-whisper),
 * so STT silently fell back to the "(voice message)" placeholder.
 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // tools/supervisor
const REPO_TOOLS_DIR = dirname(PACKAGE_ROOT); // tools/  (where transcribe_voice.py / tts_voice.py live)
const REPO_ROOT = dirname(REPO_TOOLS_DIR); // the repo root  (PianoidInstall)

/**
 * Resolve the Python interpreter for the voice helpers (STT/TTS). The faster-
 * whisper + edge-tts deps live ONLY in the Pianoid venv, NOT in a bare system
 * `python` — so the running supervisor delivered "(voice message)" because bare
 * `python` threw `ModuleNotFoundError: faster_whisper`. Precedence:
 *   1. `opts.python` (explicit, e.g. a test) ,
 *   2. `SUPERVISOR_PYTHON` env (the launcher pins this) ,
 *   3. the repo venv interpreter IF it exists (`PianoidCore/.venv/Scripts/python.exe`
 *      on win32, `.../bin/python` elsewhere) — the validated STT/TTS environment ,
 *   4. fallback to bare `python`/`python3` (degrades gracefully if neither is set up).
 */
function resolvePythonInterpreter(optsPython?: string): string {
  if (optsPython) return optsPython;
  if (process.env.SUPERVISOR_PYTHON) return process.env.SUPERVISOR_PYTHON;
  const venvPython =
    process.platform === 'win32'
      ? join(REPO_ROOT, 'PianoidCore', '.venv', 'Scripts', 'python.exe')
      : join(REPO_ROOT, 'PianoidCore', '.venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * The switchable OUTPUT modality for the orchestrator's replies (the user's
 * "output channel"): 'text' (text only), 'voice' (a TTS voice note only), or
 * 'dual' (both text and a voice note). Held in-memory by the SessionHost and
 * flipped on-the-fly via the intercepted `/mode` command — this is only the
 * STARTUP DEFAULT (it resets to this on a supervisor restart). The user chose
 * 'text' as the default.
 */
export type OutputMode = 'text' | 'voice' | 'dual';

/** The startup default output modality (the user's choice). */
export const DEFAULT_OUTPUT_MODE: OutputMode = 'text';

/**
 * The DEFAULT role-adoption skill the hosted orchestrator session boots into.
 * The supervisor prepends this to the session's FIRST turn so the session starts
 * AS the orchestrator (the user's "by default initiate /orchestrator on startup").
 * It is applied to the first turn — NOT fired as a standalone pre-user bootstrap
 * turn — because a pre-user bootstrap self-executes before an operator is bound
 * (the channel reply tool then fails + tokens burn pre-user; live-surfaced). The
 * value is env-overridable (`SUPERVISOR_ROLE_TURN_PREFIX`) and can be turned OFF
 * with an empty string / `none` / `off`. Default ON.
 */
export const DEFAULT_ROLE_TURN_PREFIX = '/orchestrator';

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
  /**
   * Python interpreter for the voice helpers (STT/TTS). Defaults to the repo
   * venv (`PianoidCore/.venv/.../python`) when present — the validated faster-
   * whisper/edge-tts environment — else bare `python`/`python3`. Override with
   * `SUPERVISOR_PYTHON` (the launcher pins it). A bare system python that lacks
   * faster-whisper makes inbound STT silently degrade to "(voice message)".
   */
  python: string;
  /**
   * Absolute path to transcribe_voice.py. Lives under the repo `tools/`
   * (the toolsDir); the prior `~/.claude` default did NOT exist, so
   * `isSttAvailable()` was false and inbound voice fell back to a placeholder.
   */
  sttScript: string;
  /** Absolute path to tts_voice.py (under the repo `tools/`). */
  ttsScript: string;
  /** Web panel port (read-only panel; 0 disables). */
  panelPort: number;
  /**
   * Permission policy for the hosted session (review M2: policy is config, not a
   * literal in the entrypoint). Defaults to {@link DEFAULT_PERMISSION_POLICY};
   * the allow-list extends via `SUPERVISOR_PERMISSION_ALLOW` (comma-separated).
   */
  permissionPolicy: PermissionPolicy;
  /**
   * The STARTUP default output modality for the orchestrator's replies
   * ({@link OutputMode}). Defaults to {@link DEFAULT_OUTPUT_MODE} ('text'); the
   * env `SUPERVISOR_OUTPUT_MODE` overrides it (text|voice|dual, invalid → default).
   * The SessionHost flips it at runtime via `/mode`; this is only the boot value.
   */
  outputModeDefault: OutputMode;
  /**
   * The role-adoption skill prepended to the orchestrator session's FIRST turn so
   * it boots AS the orchestrator (FIX: "auto-initiate /orchestrator on startup").
   * Defaults to {@link DEFAULT_ROLE_TURN_PREFIX} ('/orchestrator') — DEFAULT ON;
   * env `SUPERVISOR_ROLE_TURN_PREFIX` overrides; empty / `none` / `off` → undefined
   * (no auto-role). Applied to the first turn (NOT a pre-user bootstrap; see the
   * const doc). index.ts uses this for the orchestrator profile.
   */
  roleTurnPrefix?: string;
  /**
   * ★ STARTUP CONTEXT-PICKUP (parent-restart handoff): a one-shot context note injected
   * into the FRESH session's first turn so a supervisor PARENT/`dist` restart (the external
   * `restart-supervisor.ps1` relaunch — which boots a brand-new supervisor process + a COLD
   * orchestrator) auto-resumes the prior session instead of coming up blank (today the human
   * had to re-send "Hi" before the orchestrator engaged). Resolved by {@link resolveStartupHandoff}
   * from `SUPERVISOR_STARTUP_HANDOFF_FILE` (a file path the parent-restart STAGES before relaunch;
   * the launcher passes the env): if the file exists + is non-empty, its trimmed contents become
   * this note; otherwise undefined. UNSET/empty ⇒ undefined ⇒ the first turn is the bare role
   * prefix = byte-for-byte today. Consumed ONCE (the SessionHost appends it to the first real
   * user turn, AFTER {@link roleTurnPrefix}, exactly like the child restart-handoff injection).
   */
  startupHandoff?: string;
  /**
   * The resolved PATH of the staged startup-handoff file (or undefined). Kept alongside
   * {@link startupHandoff} so the entrypoint can CLEAR the one-shot file after consumption
   * (a stale handoff must not be re-injected on the NEXT plain restart). Resolved from
   * `SUPERVISOR_STARTUP_HANDOFF_FILE`; undefined when the env is unset.
   */
  startupHandoffFile?: string;
  /**
   * ★ P6 ACTIVATION SWITCH (model-agnostic agent routing — X5/AP5). Whether the
   * model-agnostic ROLE-ROUTING layer is ACTIVE. Resolved from `SUPERVISOR_ROLE_ROUTING`
   * (the SAME env var the pure {@link isRoleRoutingEnabled} reads — single switch), ON
   * only for '1'/'true'/'on'. DEFAULT OFF. When false (the default), index.ts wires NONE
   * of the routing path (no stores, no registry, no dispatch capability) → the constructed
   * supervisor behaves BYTE-FOR-BYTE as before this feature existed. When true, index.ts
   * wires the in-channel `/setkey`/`/setrole`/`/roles` stores + the routed-dispatch
   * capability (still nothing runs until the orchestrator dispatches a role / the user
   * sets a key). A change requires a supervisor RESTART (it is read at construction).
   */
  roleRoutingEnabled: boolean;
  /**
   * ★ TIER-1 — the hosted ORCHESTRATOR session's OWN model (proposal Q.3 Tier-1). The model
   * the orchestrator itself runs on (NOT the per-role dispatch models — those are Tier-2).
   * Resolved from `SUPERVISOR_ORCHESTRATOR_MODEL`; when unset, undefined → index.ts keeps the
   * profile's default model (orchestrator → 'claude-opus-4-8[1m]'), UNCHANGED. Read at
   * construction → changing it requires a supervisor RESTART (it is the session's model). This
   * surface is ALWAYS available (not gated by the routing switch — it tunes the existing
   * orchestrator session, independent of role-routing); the default keeps today's behavior.
   */
  orchestratorModel?: string;
  /**
   * ★ A5 ACTIVATION SWITCH (proactive stuck/dead PUSH + in-flight turn-watchdog). Whether the
   * supervisor PROACTIVELY pushes a (debounced, one-per-event) channel alert when it detects the
   * orchestrator is STUCK (idle + a missed liveness ping / a surfaced stall) or DEAD (child not
   * running), and ENABLES the latent in-flight turn-watchdog in ALERT-ONLY mode (a turn running
   * past {@link turnWatchdogMs} → alert, NEVER kill). Resolved from `SUPERVISOR_PROACTIVE_ALERTS`,
   * ON only for '1'/'true'/'on'. DEFAULT OFF. When false (the default), the SessionHost does NOT
   * enable the watchdog (its timers do not arm), does NOT start the proactive-watch scheduler, and
   * NEVER pushes an alert → the running supervisor behaves BYTE-FOR-BYTE as before this feature. A
   * change requires a supervisor RESTART (it is read at construction). The watchdog is ALERT-ONLY:
   * it adds NO auto-kill/restart path (it composes with the EXISTING auto-restart-on-unresponsive).
   */
  proactiveAlerts: boolean;
  /**
   * ★ A5 — the in-flight turn-watchdog deadline (ms): a turn running longer than this with no
   * completion is flagged STUCK → an ALERT is pushed (the watchdog action is fixed to 'surface' —
   * it NEVER kills/restarts; a legitimately long /dev build must not be murdered). Resolved from
   * `SUPERVISOR_TURN_WATCHDOG_MS`; default {@link DEFAULT_TURN_WATCHDOG_MS} (180s, decision (c)).
   * Only consulted when {@link proactiveAlerts} is ON (else the watchdog stays disabled).
   */
  turnWatchdogMs: number;
  /**
   * ★ A5 — the proactive-watch re-check cadence (ms): how often the supervisor re-evaluates
   * liveness to catch a DEAD child (which emits no events to react to). Resolved from
   * `SUPERVISOR_PROACTIVE_WATCH_INTERVAL_MS`; default {@link DEFAULT_PROACTIVE_WATCH_INTERVAL_MS}
   * (20s). Only armed when {@link proactiveAlerts} is ON (the timer is `.unref()`'d so it never
   * keeps the process alive on its own).
   */
  proactiveWatchIntervalMs: number;
  /**
   * ★ D4 — the ALWAYS-ON liveness-ping response deadline (ms). A turn result (the pong, or any real
   * turn) within this window proves the orchestrator responsive (tier-a); else the always-on tier-b
   * restart fires. Default {@link DEFAULT_PING_RESPONSE_TIMEOUT_MS} (180s), env
   * `SUPERVISOR_PING_RESPONSE_TIMEOUT_MS`. index.ts applies it ONLY to the orchestrator profile (other
   * profiles pass undefined → ping disabled). This is the always-on D4 ping — DISTINCT from the gated
   * A5 in-flight watchdog ({@link turnWatchdogMs}); raising it fixes the FALSE-POSITIVE restarts a too-tight
   * 60s deadline caused on a legitimately long Opus turn.
   */
  pingResponseTimeoutMs: number;
  /**
   * ★ D4 — the ALWAYS-ON liveness-ping scheduler cadence (ms): how often the IDLE-AWARE ping fires
   * (a no-op while a turn is in flight). Default {@link DEFAULT_PING_INTERVAL_MS} (120s), env
   * `SUPERVISOR_PING_INTERVAL_MS`. index.ts applies it ONLY to the orchestrator profile.
   */
  pingIntervalMs: number;
  /**
   * ★ REDESIGN (control-panel-redesign-2026-06-20) — RECOVERY LADDER switch. When ON, an
   * unresponsive orchestrator is recovered in two steps — first AUTO-RECONNECT the channel, and only
   * if it is STILL unresponsive, RESET (restart) — instead of restarting directly. Resolved from
   * `SUPERVISOR_RECOVERY_LADDER`, ON only for '1'/'true'/'on'. DEFAULT OFF → the existing direct
   * tier-b restart-on-unresponsive is used UNCHANGED (byte-for-byte today). Read at construction;
   * a change needs a supervisor restart. Replaces the manual Reconnect button.
   */
  recoveryLadder: boolean;
  /**
   * ★ REDESIGN — AUTO-SNAPSHOT switch. When ON, the supervisor periodically snapshots the agent
   * context AND snapshots before EVERY restart — including an unexpected/cold watchdog restart — so
   * any restart re-injects context into the fresh session (closing the cold-watchdog-restart gap).
   * Resolved from `SUPERVISOR_AUTO_SNAPSHOT`, ON only for '1'/'true'/'on'. DEFAULT OFF → no periodic
   * snapshot timer arms and the involuntary restart path is byte-for-byte today. Replaces the manual
   * Handoff button. Read at construction.
   */
  autoSnapshot: boolean;
  /**
   * ★ REDESIGN — AUTO-SNAPSHOT cadence (ms): how often the periodic snapshot runs when
   * {@link autoSnapshot} is ON. Resolved from `SUPERVISOR_AUTO_SNAPSHOT_INTERVAL_MS`; default
   * {@link DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS} (120s). Only armed when {@link autoSnapshot} is ON (the
   * timer is `.unref()`'d so it never keeps the process alive on its own).
   */
  autoSnapshotIntervalMs: number;
  /**
   * ★ REDESIGN — RESTART DRAIN deadline (ms) for the hard-kill ESCALATION. When > 0, a GRACEFUL
   * restart first waits up to this long for the in-flight turn to drain (the agent goes idle), then
   * escalates to a hard restart regardless (so a stalled drain can never wedge the restart). Resolved
   * from `SUPERVISOR_RESTART_DRAIN_MS`; DEFAULT 0 = NO drain wait = the existing immediate restart
   * (byte-for-byte today — the graceful path already hard-kills via restartFresh). Absorbs the manual
   * Kill button (escalation). Read at construction.
   */
  restartDrainMs: number;
  /**
   * ★ REDESIGN — STATUS LIVE-PROBE deadline (ms): the bound on the live responsiveness ping the
   * `status` action fires (reporting latency + last-turn time). When > 0, `status` injects a probe
   * turn and waits up to this long for a reply; the status snapshot ALWAYS returns even if the probe
   * times out. Resolved from `SUPERVISOR_STATUS_PROBE_MS`; DEFAULT 0 = NO live probe = `status`
   * reports the cheap snapshot only (byte-for-byte today). Absorbs the manual Ping button. Read at
   * construction.
   */
  statusProbeMs: number;
  /**
   * ★ P-C1 — the PER-DISPATCH USD spend cap: a single routed-agent dispatch whose ESTIMATE exceeds
   * this is REFUSED before it starts (fail-closed). Resolved from `SUPERVISOR_DISPATCH_COST_CAP_USD`;
   * DEFAULT 0 = UNLIMITED = meter-only = today (byte-for-byte). Suggested first real value $0.50
   * (proposal §4 + §D(d)). Read at construction; a change needs a supervisor restart.
   */
  dispatchCostCapUsd: number;
  /**
   * ★ P-C1 — the ROLLING CUMULATIVE USD spend cap over {@link dispatchCostWindowMs}: an admission is
   * refused once the window's spend + the dispatch estimate would exceed this. Resolved from
   * `SUPERVISOR_DISPATCH_COST_WINDOW_USD`; DEFAULT 0 = UNLIMITED = today. Suggested first real value
   * $5 / 5h (proposal §4 + §D(d)). The window rolls on the caller's clock (gate.resetWindow).
   */
  dispatchCostWindowUsd: number;
  /**
   * ★ P-C1 — the rolling cost-window length (ms): the period over which {@link dispatchCostWindowUsd}
   * is enforced before the spend ledger rolls. Resolved from `SUPERVISOR_DISPATCH_COST_WINDOW_MS`;
   * DEFAULT {@link DEFAULT_DISPATCH_COST_WINDOW_MS} (5h — the Claude budget boundary). Only meaningful
   * when the window cap is non-zero; the caller drives the actual roll via the gate's resetWindow.
   */
  dispatchCostWindowMs: number;
}

export interface LoadConfigOptions {
  /** Override the supervisor state dir (default ~/.claude/supervisor). */
  stateDir?: string;
  /**
   * Override the repo's tools dir (to locate the Python voice helpers). Defaults
   * to the repo `tools/` derived from this module's location; `SUPERVISOR_TOOLS_DIR`
   * env also overrides it (opts wins over env).
   */
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
  // Default the tools dir to the REPO `tools/` (derived from this module's own
  // location — where transcribe_voice.py / tts_voice.py actually live), NOT
  // `~/.claude` (the prior default, where they do NOT exist → STT silently fell
  // back to "(voice message)"). Precedence: opts.toolsDir > SUPERVISOR_TOOLS_DIR
  // env (the launcher pins it) > the derived repo tools/.
  const toolsDir = resolve(opts.toolsDir ?? process.env.SUPERVISOR_TOOLS_DIR ?? REPO_TOOLS_DIR);

  return {
    stateDir,
    captureFile: join(stateDir, 'capture', 'events.ndjson'),
    telegramQueueDir: join(stateDir, 'queue', 'telegram'),
    downloadDir: join(stateDir, 'downloads'),
    logFile: join(stateDir, 'supervisor.log'),
    logLevel: opts.logLevel ?? 'info',
    accessFile: join(channelDir, 'access.json'),
    productionTokenFilePresent: resolveToken(channelDir) !== undefined,
    python: resolvePythonInterpreter(opts.python),
    sttScript: join(toolsDir, 'transcribe_voice.py'),
    ttsScript: join(toolsDir, 'tts_voice.py'),
    panelPort: opts.panelPort ?? 0,
    permissionPolicy: resolvePermissionPolicy(),
    outputModeDefault: resolveOutputMode(),
    roleTurnPrefix: resolveRoleTurnPrefix(),
    // ★ STARTUP CONTEXT-PICKUP: the one-shot parent-restart handoff note (+ its file path so the
    // entrypoint can clear it after use). Unset env → both undefined → byte-for-byte today.
    startupHandoff: resolveStartupHandoff(),
    startupHandoffFile: resolveStartupHandoffFile(),
    // ★ P6: the model-agnostic role-routing activation switch (default OFF). Reads the SAME
    // env var the pure isRoleRoutingEnabled gates on, so the config flag + the resolver agree.
    roleRoutingEnabled: isRoleRoutingEnabled(process.env),
    // ★ Tier-1: the orchestrator's own model override (undefined → keep the profile default).
    orchestratorModel: resolveOrchestratorModel(),
    // ★ A5: the proactive stuck/dead-alert activation switch (default OFF → byte-for-byte today)
    // + the watchdog/re-check thresholds (consulted only when the switch is ON).
    proactiveAlerts: resolveProactiveAlerts(),
    turnWatchdogMs: resolveTurnWatchdogMs(),
    proactiveWatchIntervalMs: resolveProactiveWatchIntervalMs(),
    // ★ D4: the ALWAYS-ON liveness-ping deadline + scheduler cadence (orchestrator profile; index.ts
    // gates on the profile name). Deadline RAISED to 180s (was a hardcoded 60s → false-positive tier-b
    // restarts on a legitimately long Opus turn); cadence unchanged at 120s. Both env-overridable.
    pingResponseTimeoutMs: resolvePingResponseTimeoutMs(),
    pingIntervalMs: resolvePingIntervalMs(),
    // ★ REDESIGN — the 4 control-panel automatic behaviors (ALL default-OFF / no-op → byte-for-byte
    // today): the recovery ladder, auto-snapshot (+ its cadence), the restart drain deadline (0 =
    // no escalation wait), and the status live-probe deadline (0 = no live probe).
    recoveryLadder: resolveRecoveryLadder(),
    autoSnapshot: resolveAutoSnapshot(),
    autoSnapshotIntervalMs: resolveAutoSnapshotIntervalMs(),
    restartDrainMs: resolveRestartDrainMs(),
    statusProbeMs: resolveStatusProbeMs(),
    // ★ P-C1 — the enforced spend caps over the routed-dispatch path. BOTH USD caps default 0 =
    // UNLIMITED = meter-only = today (byte-for-byte). The window length defaults to the 5-hour
    // Claude budget boundary. Enforced fail-closed (refuse the dispatch) only when non-zero.
    dispatchCostCapUsd: resolveDispatchCostCapUsd(),
    dispatchCostWindowUsd: resolveDispatchCostWindowUsd(),
    dispatchCostWindowMs: resolveDispatchCostWindowMs(),
  };
}

/**
 * ★ A5 — resolve the proactive-alert activation switch from `SUPERVISOR_PROACTIVE_ALERTS`.
 * ON only for '1'/'true'/'on' (case/space-insensitive); anything else (incl. unset) → false
 * (DEFAULT OFF → the supervisor pushes no proactive alerts + the in-flight watchdog stays
 * disabled = byte-for-byte today). Read at construction → a change needs a restart. Pure; exported
 * for the test.
 */
export function resolveProactiveAlerts(raw = process.env.SUPERVISOR_PROACTIVE_ALERTS): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * ★ A5 — resolve the in-flight turn-watchdog deadline (ms) from `SUPERVISOR_TURN_WATCHDOG_MS`.
 * A positive integer is used verbatim; an unset/blank/non-positive/non-numeric value →
 * {@link DEFAULT_TURN_WATCHDOG_MS} (180s). Pure; exported for the test.
 */
export function resolveTurnWatchdogMs(raw = process.env.SUPERVISOR_TURN_WATCHDOG_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TURN_WATCHDOG_MS;
}

/**
 * ★ A5 — resolve the proactive-watch re-check cadence (ms) from
 * `SUPERVISOR_PROACTIVE_WATCH_INTERVAL_MS`. A positive integer is used verbatim; an
 * unset/blank/non-positive/non-numeric value → {@link DEFAULT_PROACTIVE_WATCH_INTERVAL_MS} (20s).
 * Pure; exported for the test.
 */
export function resolveProactiveWatchIntervalMs(raw = process.env.SUPERVISOR_PROACTIVE_WATCH_INTERVAL_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PROACTIVE_WATCH_INTERVAL_MS;
}

/**
 * ★ D4 — the ALWAYS-ON liveness-ping response deadline default (ms). A turn result (the
 * pong, or any real turn) within this window proves the orchestrator responsive (tier-a);
 * else the always-on tier-b restart fires. RAISED to 180s (matching {@link DEFAULT_TURN_WATCHDOG_MS})
 * from the original hardcoded 60s, which was too tight for a legitimately long (>60s) turn on
 * the 1M-context Opus session and produced FALSE-POSITIVE restarts (4× on 2026-06-20). This is the
 * always-on D4 ping — DISTINCT from the gated A5 in-flight watchdog ({@link DEFAULT_TURN_WATCHDOG_MS}).
 */
export const DEFAULT_PING_RESPONSE_TIMEOUT_MS = 180_000; // 180s — false-positive fix (was 60s)
/**
 * ★ D4 — the ALWAYS-ON liveness-ping scheduler cadence default (ms): the supervisor fires an
 * IDLE-AWARE ping every interval (a no-op while a turn is in flight). Unchanged at 120s.
 */
export const DEFAULT_PING_INTERVAL_MS = 120_000; // 120s scheduler cadence (unchanged)

/**
 * ★ D4 — resolve the ALWAYS-ON liveness-ping response deadline (ms) from
 * `SUPERVISOR_PING_RESPONSE_TIMEOUT_MS`. A positive integer is used verbatim; an
 * unset/blank/non-positive/non-numeric value → {@link DEFAULT_PING_RESPONSE_TIMEOUT_MS} (180s).
 * This deadline is applied ONLY to the orchestrator profile (index.ts gates it on the profile name);
 * the resolver itself is profile-agnostic. Pure; exported for the test. Mirrors
 * {@link resolveTurnWatchdogMs}.
 */
export function resolvePingResponseTimeoutMs(raw = process.env.SUPERVISOR_PING_RESPONSE_TIMEOUT_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PING_RESPONSE_TIMEOUT_MS;
}

/**
 * ★ D4 — resolve the ALWAYS-ON liveness-ping scheduler cadence (ms) from `SUPERVISOR_PING_INTERVAL_MS`.
 * A positive integer is used verbatim; an unset/blank/non-positive/non-numeric value →
 * {@link DEFAULT_PING_INTERVAL_MS} (120s). Pure; exported for the test. Mirrors {@link resolveTurnWatchdogMs}.
 */
export function resolvePingIntervalMs(raw = process.env.SUPERVISOR_PING_INTERVAL_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PING_INTERVAL_MS;
}

/** ★ P-C1 — the DEFAULT rolling cost-window length (ms): 5 hours = the Claude budget boundary. */
export const DEFAULT_DISPATCH_COST_WINDOW_MS = 5 * 60 * 60 * 1000; // 18_000_000

/**
 * ★ P-C1 — resolve the PER-DISPATCH USD spend cap from `SUPERVISOR_DISPATCH_COST_CAP_USD`. A finite
 * positive value (FRACTIONAL allowed, e.g. 0.50) is the per-dispatch ceiling; an unset/blank/
 * non-positive/non-numeric value → 0 (= UNLIMITED = meter-only = today). NOT floored (USD is
 * fractional). Pure; exported for the test.
 */
export function resolveDispatchCostCapUsd(raw = process.env.SUPERVISOR_DISPATCH_COST_CAP_USD): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * ★ P-C1 — resolve the ROLLING CUMULATIVE USD spend cap from `SUPERVISOR_DISPATCH_COST_WINDOW_USD`.
 * A finite positive value (FRACTIONAL allowed, e.g. 5.00) is the window ceiling; an unset/blank/
 * non-positive/non-numeric value → 0 (= UNLIMITED = today). NOT floored (USD is fractional). Pure;
 * exported for the test.
 */
export function resolveDispatchCostWindowUsd(raw = process.env.SUPERVISOR_DISPATCH_COST_WINDOW_USD): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * ★ P-C1 — resolve the rolling cost-window length (ms) from `SUPERVISOR_DISPATCH_COST_WINDOW_MS`.
 * A positive integer is used verbatim; an unset/blank/non-positive/non-numeric value →
 * {@link DEFAULT_DISPATCH_COST_WINDOW_MS} (5h). Pure; exported for the test. Mirrors {@link resolvePingIntervalMs}.
 */
export function resolveDispatchCostWindowMs(raw = process.env.SUPERVISOR_DISPATCH_COST_WINDOW_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DISPATCH_COST_WINDOW_MS;
}

/**
 * ★ REDESIGN — resolve the RECOVERY-LADDER switch from `SUPERVISOR_RECOVERY_LADDER`. ON only for
 * '1'/'true'/'on'; anything else (incl. unset) → false (DEFAULT OFF → the existing direct restart-
 * on-unresponsive is used unchanged = byte-for-byte today). Pure; exported for the test.
 */
export function resolveRecoveryLadder(raw = process.env.SUPERVISOR_RECOVERY_LADDER): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * ★ REDESIGN — resolve the AUTO-SNAPSHOT switch from `SUPERVISOR_AUTO_SNAPSHOT`. ON only for
 * '1'/'true'/'on'; anything else (incl. unset) → false (DEFAULT OFF → no periodic snapshot + the
 * involuntary restart path stays byte-for-byte today). Pure; exported for the test.
 */
export function resolveAutoSnapshot(raw = process.env.SUPERVISOR_AUTO_SNAPSHOT): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * ★ REDESIGN — resolve the AUTO-SNAPSHOT cadence (ms) from `SUPERVISOR_AUTO_SNAPSHOT_INTERVAL_MS`.
 * A positive integer is used verbatim; an unset/blank/non-positive/non-numeric value →
 * {@link DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS} (120s). Pure; exported for the test.
 */
export function resolveAutoSnapshotIntervalMs(raw = process.env.SUPERVISOR_AUTO_SNAPSHOT_INTERVAL_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS;
}

/**
 * ★ REDESIGN — resolve the RESTART DRAIN deadline (ms) for the hard-kill escalation from
 * `SUPERVISOR_RESTART_DRAIN_MS`. A positive integer is used verbatim (a graceful restart waits up to
 * this long for the in-flight turn to drain, then hard-restarts regardless); an
 * unset/blank/non-positive/non-numeric value → 0 (DEFAULT — NO drain wait = the existing immediate
 * restart, byte-for-byte today). Pure; exported for the test.
 */
export function resolveRestartDrainMs(raw = process.env.SUPERVISOR_RESTART_DRAIN_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * ★ REDESIGN — resolve the STATUS LIVE-PROBE deadline (ms) from `SUPERVISOR_STATUS_PROBE_MS`. A
 * positive integer is used verbatim (the `status` action fires a live ping bounded by this); an
 * unset/blank/non-positive/non-numeric value → 0 (DEFAULT — NO live probe = `status` reports the
 * cheap snapshot only, byte-for-byte today). Pure; exported for the test.
 */
export function resolveStatusProbeMs(raw = process.env.SUPERVISOR_STATUS_PROBE_MS): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Resolve the Tier-1 orchestrator model override from `SUPERVISOR_ORCHESTRATOR_MODEL`
 * (proposal Q.3 Tier-1 — the hosted orchestrator session's OWN model). An unset/blank
 * value → undefined, so the composition root keeps the profile's default model
 * (orchestrator → 'claude-opus-4-8[1m]') UNCHANGED. A non-blank value is used verbatim
 * (trimmed) as the session's `--model`. Read at construction → a change needs a restart.
 * Pure; exported for the test.
 */
export function resolveOrchestratorModel(raw = process.env.SUPERVISOR_ORCHESTRATOR_MODEL): string | undefined {
  const v = (raw ?? '').trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Resolve the startup role-adoption prefix. DEFAULT ON →
 * {@link DEFAULT_ROLE_TURN_PREFIX} ('/orchestrator'). `SUPERVISOR_ROLE_TURN_PREFIX`
 * overrides; an empty string / `none` / `off` (case-insensitive) disables it
 * (returns undefined → no auto-role). Any other value is used verbatim (trimmed),
 * so a project can boot a different skill.
 */
export function resolveRoleTurnPrefix(raw = process.env.SUPERVISOR_ROLE_TURN_PREFIX): string | undefined {
  if (raw === undefined) return DEFAULT_ROLE_TURN_PREFIX; // unset → default ON
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'none' || v.toLowerCase() === 'off') return undefined; // explicit OFF
  return v;
}

/**
 * ★ STARTUP CONTEXT-PICKUP — resolve the PATH of the staged parent-restart handoff file from
 * `SUPERVISOR_STARTUP_HANDOFF_FILE`. Unset/blank → undefined (no pickup; byte-for-byte today).
 * A set path is returned trimmed (whether or not the file exists yet — the existence/content
 * check is {@link resolveStartupHandoff}'s job; this is the path the entrypoint clears after use).
 * Pure (no I/O); exported for the test.
 */
export function resolveStartupHandoffFile(raw = process.env.SUPERVISOR_STARTUP_HANDOFF_FILE): string | undefined {
  const v = (raw ?? '').trim();
  return v === '' ? undefined : v;
}

/**
 * ★ STARTUP CONTEXT-PICKUP — resolve the parent-restart HANDOFF NOTE injected into the fresh
 * session's first turn. Reads the file named by `SUPERVISOR_STARTUP_HANDOFF_FILE`
 * ({@link resolveStartupHandoffFile}); returns its TRIMMED contents iff the file exists and is
 * non-empty, else undefined (the file may legitimately be absent on a normal boot → no pickup →
 * byte-for-byte today). NEVER throws — a read error (race / permissions) degrades to undefined
 * (the fresh session just starts cold, exactly as before this feature). The file is consumed
 * ONCE: the entrypoint clears it after construction so the next plain restart doesn't re-inject
 * a stale note. The file path is logged but its CONTENTS are project handoff text (not a secret).
 * `readFileFn` is injectable for the test (default: a fail-soft fs read).
 */
export function resolveStartupHandoff(
  filePath = resolveStartupHandoffFile(),
  readFileFn: (p: string) => string | undefined = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
): string | undefined {
  if (!filePath) return undefined;
  let body: string | undefined;
  try {
    body = readFileFn(filePath);
  } catch {
    return undefined; // fail-soft: a missing/locked file (or a throwing reader) → no pickup, never a boot crash
  }
  if (body === undefined) return undefined;
  const trimmed = body.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the startup output modality from `SUPERVISOR_OUTPUT_MODE` (text|voice|
 * dual, case/space-insensitive). Anything else (unset or invalid) falls back to
 * {@link DEFAULT_OUTPUT_MODE} ('text') — the user's chosen default.
 */
export function resolveOutputMode(raw = process.env.SUPERVISOR_OUTPUT_MODE): OutputMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'text' || v === 'voice' || v === 'dual') return v;
  return DEFAULT_OUTPUT_MODE;
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
