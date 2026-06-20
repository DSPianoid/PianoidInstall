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
 * The Phase-1 control-plane action registry (the menu, in display order). v1
 * ACTIONS implemented now: `status`, `ping`, `help`. Plus the `change-model`
 * submenu pivot (a scaffold — its restart-on-model wiring is phase A3). This list
 * is the single source of truth the menu builder + the callback router both read,
 * so a later phase adds a row here + a handler branch and the button appears with
 * no other menu change.
 */
export const CONTROL_ACTIONS: readonly ControlActionSpec[] = [
  { id: 'status', label: '📊 Status' },
  { id: 'ping', label: '📡 Ping' },
  { id: 'change-model', label: '🤖 Change model', submenu: true, scaffold: true },
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
 * selection. Pure.
 */
export function buildModelSubmenu(currentModel?: string): InlineButton[] {
  const buttons: InlineButton[] = CONTROL_MODEL_CHOICES.map((m) => ({
    text: m === currentModel ? `✅ ${m}` : m,
    callbackData: controlCallbackData('model-set', m),
  }));
  buttons.push({ text: '⬅️ Back', callbackData: controlCallbackData('menu') });
  return buttons;
}

/** The control-plane MENU header text (rendered with {@link buildControlMenu}). */
export const CONTROL_MENU_TEXT =
  '🛠️ Supervisor control plane — choose an action:\n' +
  '(handled by the supervisor out-of-band — works even if the orchestrator is stuck or dead)';

/** The `change-model` SUB-MENU header text (rendered with {@link buildModelSubmenu}). */
export const CONTROL_MODEL_MENU_TEXT = '🤖 Change orchestrator model — pick one:';

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
 * {@link StatusSnapshot} (proposal §5, Phase-1 read-only form):
 *  - **dead**   — the child is not running (`running === false`).
 *  - **stuck**  — running but IDLE and a stall signal was observed (a turn went
 *    silent past the watchdog without completing). The proactive ping/watchdog
 *    that PRODUCES the stall signal is wired in a later phase; this classifier
 *    reads whatever signal is present.
 *  - **active** — running and not classified stuck (a turn is in flight, or it is
 *    idle and healthy).
 * Pure.
 */
export function classifyLiveness(s: StatusSnapshot): Liveness {
  if (!s.running) return 'dead';
  if (s.idle && s.lastStall != null) return 'stuck';
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
