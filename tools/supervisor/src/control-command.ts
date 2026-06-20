/**
 * CONTROL-PLANE COMMAND — the pure parse + menu + action-registry half of the
 * supervisor's OUT-OF-BAND operator control command (`/control`).
 *
 * The operator types ONE reserved command — `/control` — which the supervisor
 * INTERCEPTS in {@link SessionHost.handleInbound} (the SAME seam as `/mode` /
 * `/setrole`, BEFORE any hand-off to the orchestrator child) and answers with a
 * native Telegram inline-keyboard MENU. Each menu button carries a `ctl:<action>`
 * `callback_data`; a tap comes back as an inbound `callback_query` the supervisor
 * routes through the SAME callback infrastructure the permission buttons use
 * ({@link parseControlCallback}) → runs the action → ACKs + edits the message with
 * the result. Because both the command and every callback are handled in the
 * supervisor process, the whole control plane works precisely when the
 * orchestrator child is dead or wedged (proposal CP1 — out-of-band survivability).
 *
 * Concern (P2): this module is PURE — the command matcher, the `ctl:*` callback
 * scheme parse, the ACTION REGISTRY (the extensible list later phases plug
 * `restart`/`resume`/`interrupt`/… into), the inline-keyboard MENU builders, and
 * the read-only result formatters (`help`, `status`). It owns NO state, performs
 * NO I/O, and reads NO live telemetry — the SessionHost gathers a
 * {@link StatusSnapshot} from its own lifecycle/liveness and hands it here to
 * format. This mirrors setkey-command.ts / setrole-command.ts (parse + message
 * logic OUT of the host; the host is a thin wirer).
 *
 * Authority (P1): this module writes nothing. Every Phase-1 action
 * (`status`/`ping`/`help`) is read-only; `change-model` is a navigation scaffold
 * whose restart-on-model wiring lands in a later phase. No piece of state changes
 * owner.
 *
 * Traces: docs/proposals/supervisor-control-plane-and-activation-2026-06-20.md
 * (PART A — the out-of-band control plane; §2 command inventory `status`/`ping`/
 * `help`; §5 active/stuck/dead definitions; the `/control`-menu interface
 * override). Reuses the InlineButton/callback contract (contract.ts) + the
 * permission-button callback path (channel-permission.ts / session-host.ts).
 */

import type { InlineButton } from './contract.js';

/**
 * The reserved CONTROL command — `/control` (case-insensitive, leading token
 * only). INTERCEPTED by the supervisor (handled in {@link SessionHost.handleInbound})
 * and NEVER forwarded to the orchestrator, exactly like `/mode`. A bare `/control`
 * renders the main menu; there are no typed sub-arguments (the menu drives
 * everything via button taps). Anchored at the start so a `/control` mid-sentence
 * is a normal turn.
 */
export const CONTROL_CMD_RE = /^\/control\b/i;

/** True iff `text` is the reserved `/control` command (leading token). Pure. */
export function isControlCommand(text: string): boolean {
  return CONTROL_CMD_RE.test(text.trim());
}

/**
 * Prefix for the control-plane inline-button `callback_data` scheme:
 * `ctl:<action>` (optionally `ctl:<action>:<arg>`). Distinct from the permission
 * scheme (`perm:<verdict>:<code>`) so the two callback routers never collide —
 * the supervisor checks the `ctl:` prefix FIRST and falls through to the
 * permission path otherwise. Kept short to stay well under Telegram's 64-byte
 * `callback_data` cap.
 */
export const CTL_CALLBACK_PREFIX = 'ctl';

/**
 * A parsed control-plane button tap. `action` is the registry action id (or a
 * navigation/scaffold token like `menu` / `model` / `model-set`); `arg` is the
 * optional third segment (e.g. the chosen model id for `ctl:model-set:<model>`).
 */
export interface ControlCallback {
  action: string;
  arg?: string;
}

/**
 * Parse a control-plane button tap's `callback_data`. Recognizes
 * `ctl:<action>` and `ctl:<action>:<arg>` where `<action>` is `[a-z0-9-]+` and
 * `<arg>` is any non-empty token without a colon. Returns the action (+ optional
 * arg), or `null` if it is NOT a control callback (so a sibling feature's
 * callback_data — e.g. `perm:*` — is left alone). Pure.
 */
export function parseControlCallback(data: string): ControlCallback | null {
  const m = /^ctl:([a-z0-9-]+)(?::([^:]+))?$/i.exec(data.trim());
  if (!m) return null;
  const action = m[1]!.toLowerCase();
  const arg = m[2];
  return arg !== undefined ? { action, arg } : { action };
}

/** Build a `ctl:<action>` (or `ctl:<action>:<arg>`) callback_data string. Pure. */
export function controlCallbackData(action: string, arg?: string): string {
  return arg !== undefined ? `${CTL_CALLBACK_PREFIX}:${action}:${arg}` : `${CTL_CALLBACK_PREFIX}:${action}`;
}

/**
 * One entry in the control-plane ACTION REGISTRY — the extensible list that drives
 * BOTH the menu render (the button `label` + `callbackData`) AND the callback
 * router (the `id` the router dispatches on). Later phases ADD entries here
 * (`restart`/`resume`/`interrupt`/`reconnect`/`flush`/`log`/`clear`/`approvals`/
 * `dispatch`/`spend-cap`); the menu + router pick them up automatically. The
 * HANDLER lives on the SessionHost (it needs live telemetry / lifecycle), so a
 * registry entry only declares the id + label + whether it is a submenu pivot.
 */
export interface ControlActionSpec {
  /** Action id — the `ctl:<id>` callback token + the router dispatch key. */
  id: string;
  /** Button label shown in the menu (keep short — single-row keyboard). */
  label: string;
  /**
   * When true, tapping this button does NOT run a terminal action — it opens a
   * SUB-MENU (the router renders the submenu's buttons instead). v1 uses this for
   * `change-model` only.
   */
  submenu?: boolean;
  /**
   * v1 SCAFFOLD flag — the action's full wiring lands in a later phase; tapping it
   * reports "wired in a later phase". Used by `change-model` (restart-on-model =
   * phase A3). The menu still shows it so the surface is discoverable.
   */
  scaffold?: boolean;
}

/**
 * The control-plane action registry (the menu, in display order). This list is the
 * single source of truth the menu builder + the callback router both read, so a
 * later phase adds a row here + a handler branch and the button appears with no
 * other menu change.
 *
 * Phase-1 ACTIONS (read-only core): `status`, `ping`, `help`, + the `change-model`
 * submenu pivot (a scaffold — restart-on-model wiring is phase A3).
 *
 * Phase-A2 ACTIONS (channel↔panel parity — each wraps an existing supervisor-side
 * method behind the loopback panel, so it works out-of-band when the orchestrator
 * child is dead/stuck): `reconnect` (re-establish the channel transport), `flush`
 * (DESTRUCTIVE → a confirm sub-menu pivot; only the confirm drops pending inbound),
 * `log` (recent capture-buffer activity), `approvals` (list pending permission asks
 * with per-ask Allow/Deny buttons resolving via the SAME permission path as the
 * `perm:*` buttons).
 *
 * Phase-A3 ACTIONS (the restart/lifecycle family — each performs (or arms) an
 * orchestrator-child restart through the supervisor's EXISTING lifecycle restart
 * machinery, so they work out-of-band when the child is wedged): `restart`
 * (GRACEFUL — drain + handoff snapshot + relaunch preserving the channel), `kill`
 * (HARD — no drain, for a wedged child), `clear`/`new` (fresh orchestrator context,
 * channel preserved, NO handoff), `handoff` (capture a state snapshot NOW — the note
 * a future restart re-injects), `resume` (re-inject the last snapshot via a restart).
 * `restart`/`kill`/`clear`/`resume` are ALL DESTRUCTIVE (they reset the orchestrator
 * context) → each is a confirm sub-menu pivot (CP7); `handoff` is non-destructive
 * (it only records a snapshot) → it runs directly. `change-model` is now a REAL
 * action (A3 finishes its A1 scaffold): the model sub-menu's pick (`model-set`)
 * confirms, then sets the Tier-1 model + restarts on it.
 *
 * Phase-A4 ACTION (the ESC): `interrupt` (alias `cancel`) — STOP the orchestrator's
 * current turn WITHOUT killing it (`lifecycle.interruptTurn()` → `driver.interrupt()`).
 * It is NON-destructive (only the in-flight turn is abandoned; the process + context stay
 * alive), so — UNLIKE the restart family — it runs DIRECTLY with NO confirm sub-menu (a
 * fast ESC). The handler routes through an injected interrupt dep (dormant when unwired).
 */
export const CONTROL_ACTIONS: readonly ControlActionSpec[] = [
  { id: 'status', label: '📊 Status' },
  { id: 'ping', label: '📡 Ping' },
  { id: 'approvals', label: '🔐 Approvals' },
  { id: 'log', label: '📜 Log' },
  { id: 'reconnect', label: '🔌 Reconnect' },
  { id: 'flush', label: '🧹 Flush', submenu: true },
  { id: 'restart', label: '🔄 Restart', submenu: true },
  { id: 'kill', label: '💥 Kill (hard)', submenu: true },
  { id: 'clear', label: '🧠 Clear / New', submenu: true },
  { id: 'handoff', label: '📌 Handoff (snapshot)' },
  { id: 'resume', label: '⏪ Resume (last snapshot)', submenu: true },
  { id: 'interrupt', label: '✋ Interrupt (stop turn)' },
  { id: 'change-model', label: '🤖 Change model', submenu: true },
  { id: 'help', label: '❓ Help' },
];

/**
 * The Tier-1 orchestrator-model candidates offered by the `change-model` submenu.
 * These are the supported orchestrator session models (proposal Q.3 Tier-1); the
 * value is what would be passed to {@link SupervisorConfig.orchestratorModel} on a
 * (later-phase) restart. The list is the menu's source of truth — add a model here
 * and the submenu shows it.
 */
export const CONTROL_MODEL_CHOICES: readonly string[] = [
  'claude-opus-4-8[1m]',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

/** Build the MAIN control menu inline keyboard from the action registry. Pure. */
export function buildControlMenu(): InlineButton[] {
  return CONTROL_ACTIONS.map((a) => ({ text: a.label, callbackData: controlCallbackData(a.id) }));
}

/**
 * Build the `change-model` SUB-MENU inline keyboard: one button per Tier-1 model
 * choice (`ctl:model-set:<model>`) plus a back button (`ctl:menu`). The currently-
 * active model (if known) is marked with a check so the operator sees the current
 * selection. A pick opens the model-set CONFIRM step ({@link buildModelSetConfirmMenu})
 * — applying a model restarts the orchestrator (A3), so it is confirmed first. Pure.
 */
export function buildModelSubmenu(currentModel?: string): InlineButton[] {
  const buttons: InlineButton[] = CONTROL_MODEL_CHOICES.map((m) => ({
    text: m === currentModel ? `✅ ${m}` : m,
    callbackData: controlCallbackData('model-set', m),
  }));
  buttons.push({ text: '⬅️ Back', callbackData: controlCallbackData('menu') });
  return buttons;
}

/**
 * Build the `flush` CONFIRM sub-menu inline keyboard (A2). `flush` is DESTRUCTIVE —
 * it drops un-acked INBOUND messages — so tapping it opens this confirm step
 * instead of acting (proposal CP7: destructive actions are confirmed, mirroring the
 * change-model sub-menu). Only `ctl:flush-confirm` actually flushes; `ctl:menu`
 * cancels back to the main menu. Pure.
 */
export function buildFlushConfirmMenu(): InlineButton[] {
  return [
    { text: '✅ Confirm flush', callbackData: controlCallbackData('flush-confirm') },
    { text: '⬅️ Cancel', callbackData: controlCallbackData('menu') },
  ];
}

/**
 * Build the `approvals` sub-menu inline keyboard (A2): two buttons (✅ Allow / ❌
 * Deny) PER pending permission ask, each carrying the ask's `code` so the tap
 * resolves exactly that ask via the SAME permission path the `perm:*` buttons use
 * (`ctl:appr-allow:<code>` / `ctl:appr-deny:<code>`). The 4-hex code fits the
 * `ctl:<action>:<arg>` scheme well under the 64-byte cap. A trailing back button
 * returns to the main menu. With no pending asks the keyboard is just the back
 * button (the header text says "none pending"). Pure.
 */
export function buildApprovalsSubmenu(pending: readonly { code: string; toolName: string }[]): InlineButton[] {
  const buttons: InlineButton[] = [];
  for (const p of pending) {
    buttons.push({ text: `✅ Allow ${p.toolName} (${p.code})`, callbackData: controlCallbackData('appr-allow', p.code) });
    buttons.push({ text: `❌ Deny ${p.toolName} (${p.code})`, callbackData: controlCallbackData('appr-deny', p.code) });
  }
  buttons.push({ text: '⬅️ Back', callbackData: controlCallbackData('menu') });
  return buttons;
}

/**
 * The header text for the `approvals` sub-menu: lists the pending asks (or says
 * none are pending). Rendered with {@link buildApprovalsSubmenu}. Pure.
 */
export function approvalsMenuText(pending: readonly { code: string; toolName: string }[]): string {
  if (pending.length === 0) return '🔐 Pending approvals — none pending.';
  const lines = pending.map((p) => `• ${p.toolName} (${p.code})`);
  return `🔐 Pending approvals (${pending.length}) — tap Allow/Deny:\n${lines.join('\n')}`;
}

/**
 * Build a generic DESTRUCTIVE-CONFIRM sub-menu inline keyboard (A3) for a lifecycle
 * action: a Confirm button (`ctl:<action>-confirm`) + a Cancel/back button
 * (`ctl:menu`). Used by `restart` / `kill` / `clear` / `resume` — each resets the
 * orchestrator context, so a bare tap opens this confirm step and only the
 * `<action>-confirm` tap actually performs it (CP7 — destructive actions confirmed,
 * mirroring the flush + change-model confirms). Pure.
 */
export function buildConfirmMenu(action: string): InlineButton[] {
  return [
    { text: '✅ Confirm', callbackData: controlCallbackData(`${action}-confirm`) },
    { text: '⬅️ Cancel', callbackData: controlCallbackData('menu') },
  ];
}

/**
 * Build the `model-set` CONFIRM sub-menu inline keyboard (A3): a Confirm button that
 * carries the chosen model (`ctl:model-set-confirm:<model>`) + a back button to the
 * model sub-menu (`ctl:change-model`). Applying a model RESTARTS the orchestrator, so
 * the pick is confirmed before it acts (CP7). Pure.
 */
export function buildModelSetConfirmMenu(model: string): InlineButton[] {
  return [
    { text: `✅ Restart on ${model}`, callbackData: controlCallbackData('model-set-confirm', model) },
    { text: '⬅️ Back', callbackData: controlCallbackData('change-model') },
  ];
}

/** The `restart` (graceful) CONFIRM sub-menu header text. */
export const CONTROL_RESTART_CONFIRM_TEXT =
  '🔄 Restart the orchestrator GRACEFULLY? It drains the current turn, captures a handoff ' +
  'snapshot, then relaunches with a fresh context (the conversation/channel is preserved).';

/** The `kill` (hard) CONFIRM sub-menu header text. */
export const CONTROL_KILL_CONFIRM_TEXT =
  '💥 HARD-restart the orchestrator NOW? No drain (for a wedged child) — the in-flight turn ' +
  'is abandoned and the context is reset (the conversation/channel is preserved).';

/** The `clear`/`new` CONFIRM sub-menu header text. */
export const CONTROL_CLEAR_CONFIRM_TEXT =
  '🧠 Start a FRESH orchestrator context? Clears the current context with NO handoff note ' +
  '(a clean slate); the conversation/channel is preserved.';

/** The `resume` CONFIRM sub-menu header text. */
export const CONTROL_RESUME_CONFIRM_TEXT =
  '⏪ Resume from the last handoff snapshot? Restarts the orchestrator and re-injects the ' +
  'snapshot you captured (the conversation/channel is preserved).';

/** The control-plane MENU header text (rendered with {@link buildControlMenu}). */
export const CONTROL_MENU_TEXT =
  '🛠️ Supervisor control plane — choose an action:\n' +
  '(handled by the supervisor out-of-band — works even if the orchestrator is stuck or dead)';

/** The `change-model` SUB-MENU header text (rendered with {@link buildModelSubmenu}). */
export const CONTROL_MODEL_MENU_TEXT = '🤖 Change orchestrator model — pick one:';

/** The `flush` CONFIRM sub-menu header text (rendered with {@link buildFlushConfirmMenu}). */
export const CONTROL_FLUSH_CONFIRM_TEXT =
  '⚠️ Drop pending inbound? This discards un-acked inbound messages from the channel queue.';

/** The static `help` text — lists every control action + how the menu works. Pure. */
export function controlHelpText(): string {
  const lines = CONTROL_ACTIONS.map((a) => {
    const note = a.scaffold ? ' (wired in a later phase)' : '';
    return `• ${a.label}${note}`;
  });
  return (
    '🛠️ Supervisor control plane\n' +
    'Type /control to open the menu, then tap a button. Every action is handled by ' +
    'the supervisor itself (out-of-band), so it works even when the orchestrator is ' +
    'stuck or dead.\n\n' +
    'Actions:\n' +
    lines.join('\n')
  );
}

/**
 * The live-telemetry SNAPSHOT the SessionHost gathers (from its lifecycle +
 * liveness + config) and hands to {@link formatStatus} / {@link classifyLiveness}.
 * Pure data — no methods — so the formatter stays testable with hand-built
 * snapshots (proposal §5 inputs).
 */
export interface StatusSnapshot {
  /** lifecycle.health().running — false ⇒ the child process is not up (DEAD). */
  running: boolean;
  /** lifecycle.isIdle() — true ⇒ no turn in flight (between turns). */
  idle: boolean;
  /** The captured session id, if any (lifecycle.health().sessionId). */
  sessionId?: string;
  /** lifecycle.health().restarts — how many times the child has been restarted. */
  restarts: number;
  /** The orchestrator session's resolved model (opts.model = orchestratorModel ?? profile.model). */
  model?: string;
  /** Supervisor uptime in ms (now − startedAt). */
  uptimeMs: number;
  /** Count of pending permission approvals awaiting the operator. */
  pendingApprovals: number;
  /**
   * The last stall signal observed (lifecycle 'stall' event payload), if any — a
   * turn went silent past the watchdog. Its PRESENCE (with the child running +
   * idle) is the Phase-1 STUCK signal.
   */
  lastStall?: { silentMs?: number; action?: string } | null;
  /**
   * Context-window usage %, if the driver/telemetry exposes it. NOT available
   * today (no field on lifecycle/driver health) → undefined ⇒ reported as n/a.
   */
  contextPercent?: number;
}

/** The three liveness states the control plane reports (proposal §5). */
export type Liveness = 'active' | 'stuck' | 'dead';

/**
 * Classify the orchestrator child as active / stuck / dead from a
 * {@link StatusSnapshot} (proposal §5):
 *  - **dead**   — the child is not running (`running === false`).
 *  - **stuck**  — running but a stall signal is present (`lastStall != null`).
 *    A5 produces this signal from EITHER the idle-missed-ping path (idle + an
 *    unanswered liveness ping) OR the in-flight turn-watchdog (a turn outstanding
 *    past the watchdog deadline — `!idle`). Because A5 CLEARS `lastStall` on any
 *    recovery (a result / pong / mid-turn activity, via the SessionHost's
 *    onProactiveRecovery), a present `lastStall` always denotes a CURRENT stall —
 *    NOT a stale prior one — so the classifier no longer gates on `idle` (the
 *    in-flight-wedged case is genuinely STUCK; proposal §5 includes it). When the
 *    proactive switch is OFF the watchdog/ping never set `lastStall`, so it stays
 *    null and this still reports ACTIVE — byte-for-byte today.
 *  - **active** — running and no stall signal present.
 * Pure.
 */
export function classifyLiveness(s: StatusSnapshot): Liveness {
  if (!s.running) return 'dead';
  if (s.lastStall != null) return 'stuck';
  return 'active';
}

/** Render a ms duration as a short `Hh Mm Ss` / `Mm Ss` / `Ss` string. Pure. */
export function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Format the `status` reply from a {@link StatusSnapshot}: the active/stuck/dead
 * classification + current orchestrator model + uptime + context-window % (or n/a)
 * + pending approvals + restarts (+ a STUCK detail line when applicable). Pure.
 */
export function formatStatus(s: StatusSnapshot): string {
  const live = classifyLiveness(s);
  const badge = live === 'active' ? '🟢 ACTIVE' : live === 'stuck' ? '🟡 STUCK' : '🔴 DEAD';
  const ctx = s.contextPercent != null ? `${s.contextPercent.toFixed(0)}%` : 'n/a';
  const lines = [
    `${badge} — orchestrator`,
    `model: ${s.model ?? '(default)'}`,
    `uptime: ${formatUptime(s.uptimeMs)}`,
    `context: ${ctx}`,
    `pending approvals: ${s.pendingApprovals}`,
    `restarts: ${s.restarts}`,
  ];
  if (live === 'stuck' && s.lastStall) {
    const silent = s.lastStall.silentMs != null ? `${Math.round(s.lastStall.silentMs / 1000)}s` : '?';
    lines.push(`stall: silent ${silent} (action: ${s.lastStall.action ?? '?'})`);
  }
  if (live === 'dead') {
    lines.push('the orchestrator child is not running — use the menu to restart it (wired in a later phase).');
  }
  return lines.join('\n');
}

/**
 * ★ A5 — DEFAULT thresholds for the proactive stuck/dead watch (proposal §5 +
 * decision (c)). All overridable via {@link SupervisorConfig} (resolved in config.ts);
 * exported here so the pure layer + the tests share one source of truth.
 *  - {@link DEFAULT_TURN_WATCHDOG_MS} — a turn in flight longer than this is flagged
 *    STUCK by the in-flight watchdog → ALERT (never kill).
 *  - {@link DEFAULT_PROACTIVE_WATCH_INTERVAL_MS} — how often the proactive-watch
 *    re-checks liveness (to catch a DEAD child, which emits no events).
 */
export const DEFAULT_TURN_WATCHDOG_MS = 180_000; // 180s — alert-not-kill (decision (c))
export const DEFAULT_PROACTIVE_WATCH_INTERVAL_MS = 20_000; // 20s re-check cadence

/**
 * ★ A5 — format the PROACTIVE alert text the supervisor PUSHES to the channel when it
 * detects the orchestrator is STUCK or DEAD (proposal §2 "PROACTIVE push", CF5). States
 * WHAT is detected + WHAT to do, and (for STUCK) the silent duration. ONLY STUCK/DEAD
 * produce an alert ('active' returns null — never alert on a healthy transition). Pure, so
 * the message strings are unit-testable. The SessionHost pushes the returned text once per
 * event (debounced) via its operator-send path.
 */
export function formatProactiveAlert(live: Liveness, ctx: { silentMs?: number } = {}): string | null {
  if (live === 'stuck') {
    const secs = ctx.silentMs != null ? `~${Math.round(ctx.silentMs / 1000)}s` : 'a while';
    return (
      `⚠️ Orchestrator unresponsive (${secs}) — it stopped answering. ` +
      `Tap /control → Restart (or Kill) to recover, or it keeps retrying on its own.`
    );
  }
  if (live === 'dead') {
    return (
      `🔴 Orchestrator DIED (the child process is not running) — restarting it now. ` +
      `Tap /control → Status to check, or Resume to re-inject the last handoff.`
    );
  }
  return null; // active → no alert
}

/**
 * One captured bus event as the `log` action sees it — a STRUCTURAL subset of the
 * capture store's `CaptureRecord.event` (kept local so control-command.ts stays
 * pure + decoupled from capture-store.ts; the SessionHost passes the real records,
 * which are shape-compatible). Only the fields the log formatter reads are named.
 */
export interface ControlLogEvent {
  ts?: string;
  type?: string;
  source?: string;
  direction?: string;
  payload?: unknown;
}

/** A captured record (`{event}`) as `formatControlLog` consumes it. */
export interface ControlLogRecord {
  event?: ControlLogEvent;
}

/** Default number of recent activity events the `log` action renders. */
export const CONTROL_LOG_DEFAULT_N = 12;

/** Short HH:MM:SS from an ISO timestamp (or '--:--:--' if absent/unparseable). Pure. */
function shortTime(ts?: string): string {
  if (!ts) return '--:--:--';
  const t = ts.length >= 19 && ts[10] === 'T' ? ts.slice(11, 19) : ts;
  return t;
}

/** Collapse + clip a message body to a compact one-liner. Pure. */
function clip(text: unknown, max = 60): string {
  const s = typeof text === 'string' ? text : '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Format the `log` (alias tail) action: the last `n` SUBSTANTIVE channel-activity
 * events from the capture buffer — inbound user messages, outbound replies, and
 * their delivery outcome — as a compact, newest-last list. Reads the capture
 * records the SessionHost supplies (proposal §2 `tail`/`log`: `/api/capture` data),
 * filtering to the channel.inbound / channel.outbound events (the actionable
 * signal; lifecycle/stream noise is dropped). Each line:
 *   `HH:MM:SS ⬇️ <user-text>`            (channel.inbound)
 *   `HH:MM:SS ⬆️ <reply-text>`           (channel.outbound, delivered)
 *   `HH:MM:SS ⚠️ send failed: <error>`   (channel.outbound, result.ok=false)
 * Pure (no I/O — the host did the replay).
 */
export function formatControlLog(records: readonly ControlLogRecord[], n = CONTROL_LOG_DEFAULT_N): string {
  const lines: string[] = [];
  for (const r of records) {
    const e = r.event;
    if (!e) continue;
    const t = shortTime(e.ts);
    if (e.type === 'channel.inbound') {
      const p = e.payload as { text?: string } | undefined;
      lines.push(`${t} ⬇️ ${clip(p?.text) || '(no text)'}`);
    } else if (e.type === 'channel.outbound') {
      const p = e.payload as { msg?: { text?: string }; result?: { ok?: boolean; error?: string } } | undefined;
      if (p?.result && p.result.ok === false) {
        lines.push(`${t} ⚠️ send failed: ${clip(p.result.error, 60) || '(unknown error)'}`);
      } else {
        lines.push(`${t} ⬆️ ${clip(p?.msg?.text) || '(no text)'}`);
      }
    }
    // Other event types (lifecycle, stream.*) are noise on a phone — skipped.
  }
  if (lines.length === 0) return '📜 Recent activity — none captured yet.';
  const tail = lines.slice(-n);
  return `📜 Recent activity (last ${tail.length}):\n${tail.join('\n')}`;
}
