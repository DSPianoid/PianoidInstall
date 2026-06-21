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
 *
 * ★ REDESIGN (dev-3e66, control-panel-redesign-2026-06-20): the MAIN menu is now 10 buttons
 * (2 per row): the four heavier/rarer lifecycle actions (`restart`/`flush` + the NEW
 * `parent-restart`) move into an **Advanced** SUBMENU pivot, the channel `reconnect` button
 * and the manual `ping`/`handoff`/`kill` buttons are REMOVED (folded into automatic
 * behaviors — recovery ladder / status live-probe / auto-snapshot / restart hard-kill
 * escalation; PART 2), `clear` is relabelled **New session**, and a NEW **Mode** submenu
 * pivot surfaces the existing `/mode` voice/text/dual switch as panel buttons. The Advanced
 * + Mode submenu actions live in {@link CONTROL_ADVANCED_ACTIONS} / {@link CONTROL_MODE_OPTIONS}
 * (NOT in this main registry), so {@link buildControlMenu} renders exactly the 10 main rows
 * while {@link controlHelpText} still documents every button across both levels.
 */
export const CONTROL_ACTIONS: readonly ControlActionSpec[] = [
  { id: 'status', label: '📊 Status' },
  { id: 'approvals', label: '🔐 Approvals' },
  { id: 'log', label: '📜 Log' },
  { id: 'clear', label: '🧠 New session', submenu: true },
  { id: 'resume', label: '⏪ Resume', submenu: true },
  { id: 'interrupt', label: '✋ Interrupt' },
  { id: 'change-model', label: '🤖 Change model', submenu: true },
  { id: 'mode', label: '🔊 Mode', submenu: true },
  { id: 'advanced', label: '⚙️ Advanced', submenu: true },
  { id: 'help', label: '❓ Help' },
];

/**
 * ★ P-B1 — the `dispatch` MAIN-MENU action (the model-agnostic routed-dispatch surface). NOT in
 * {@link CONTROL_ACTIONS} because it is CONDITIONAL — only OFFERED when the routed-dispatch
 * capability is wired (= `SUPERVISOR_ROLE_ROUTING` ON). {@link buildControlMenu} appends it when
 * told the capability is wired; with routing OFF (the default) the button is not shown at all and
 * the menu is byte-for-byte today (proposal §3 dormant contract). Routed through the SAME
 * `ctl:*` scheme + the SAME router switch as every other action — just a conditionally-rendered button.
 */
export const CONTROL_DISPATCH_ACTION: ControlActionSpec = { id: 'dispatch', label: '🛰️ Dispatch' };

/**
 * ★ REDESIGN — the **Advanced** SUBMENU actions (the heavier, rarer lifecycle controls grouped
 * off the main menu): `restart` (graceful, auto-escalates to a hard kill if the drain stalls —
 * absorbs the old Kill), the NEW `parent-restart` (restart the SUPERVISOR PROCESS itself to load
 * a new build — performed supervisor-side, NOT by the agent firing a shell command), and `flush`
 * (drop unacknowledged inbound). Each is DESTRUCTIVE → it keeps its own CONFIRM sub-menu even
 * inside Advanced (control-panel-redesign §"Advanced submenu"). These ids route through the SAME
 * {@link parseControlCallback} `ctl:*` scheme + the SAME router switch as the main actions — the
 * Advanced menu is just a different render surface, not a different router.
 */
export const CONTROL_ADVANCED_ACTIONS: readonly ControlActionSpec[] = [
  { id: 'restart', label: '🔄 Restart', submenu: true },
  { id: 'parent-restart', label: '♻️ Parent restart', submenu: true },
  { id: 'flush', label: '🧹 Flush', submenu: true },
];

/**
 * ★ REDESIGN — the **Mode** SUBMENU options (the output modality the existing `/mode` command
 * sets, surfaced as panel buttons): Voice, Text, Dual. NON-destructive (no confirm) — a tap
 * sets the modality immediately, exactly like typing `/mode voice|text|dual`. The `value` is
 * the {@link OutputMode} token passed to the same handler the typed command uses; carried as
 * `ctl:mode-set:<value>`. The list is the submenu's source of truth (one row per option + a
 * Back button).
 */
export const CONTROL_MODE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'voice', label: '🎙️ Voice' },
  { value: 'text', label: '💬 Text' },
  { value: 'dual', label: '🔉 Dual' },
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

/**
 * Buttons PER ROW for the `/control` menu + its sub-menus (the layout hint the adapter
 * honors). ★ REDESIGN: the main menu is now 10 actions (was 14); rendered as a single flat
 * row each button is squeezed to ~1/10 width and the label truncates to just the emoji.
 * Chunking at 2/row gives 5 readable rows (and keeps each approvals ask's Allow/Deny pair
 * side-by-side; a 2-button confirm stays one row). The supervisor passes this on every
 * control-menu send (the permission Allow/Deny prompt sets NO per-row hint → it stays a
 * single row, byte-for-byte). 2 = a sensible grid; bump if the labels ever shorten.
 */
export const CONTROL_MENU_BUTTONS_PER_ROW = 2;

/**
 * Build the MAIN control menu inline keyboard from the action registry. Pure.
 *
 * ★ P-B1 — when `opts.includeDispatch` is true (the supervisor passes this only when the routed-
 * dispatch capability is wired = `SUPERVISOR_ROLE_ROUTING` ON), the conditional
 * {@link CONTROL_DISPATCH_ACTION} button is appended. Omitting it (the default) keeps the menu
 * byte-for-byte today (the dispatch surface is dormant when routing is OFF, proposal §3).
 */
export function buildControlMenu(opts: { includeDispatch?: boolean } = {}): InlineButton[] {
  const buttons = CONTROL_ACTIONS.map((a) => ({ text: a.label, callbackData: controlCallbackData(a.id) }));
  if (opts.includeDispatch) {
    buttons.push({ text: CONTROL_DISPATCH_ACTION.label, callbackData: controlCallbackData(CONTROL_DISPATCH_ACTION.id) });
  }
  return buttons;
}

/**
 * ★ REDESIGN — build the **Advanced** SUBMENU inline keyboard: one button per
 * {@link CONTROL_ADVANCED_ACTIONS} entry (`restart` / `parent-restart` / `flush`, each a
 * confirm-gated `ctl:<id>` that opens its own confirm step) plus a Back button (`ctl:menu`).
 * Pure.
 */
export function buildAdvancedSubmenu(): InlineButton[] {
  const buttons: InlineButton[] = CONTROL_ADVANCED_ACTIONS.map((a) => ({
    text: a.label,
    callbackData: controlCallbackData(a.id),
  }));
  buttons.push({ text: '⬅️ Back', callbackData: controlCallbackData('menu') });
  return buttons;
}

/**
 * ★ REDESIGN — build the **Mode** SUBMENU inline keyboard: one button per
 * {@link CONTROL_MODE_OPTIONS} (`ctl:mode-set:<value>`), the currently-active mode marked with a
 * check, plus a Back button (`ctl:menu`). NON-destructive (no confirm step) — a pick sets the
 * modality immediately. Pure.
 */
export function buildModeSubmenu(currentMode?: string): InlineButton[] {
  const buttons: InlineButton[] = CONTROL_MODE_OPTIONS.map((o) => ({
    text: o.value === currentMode ? `✅ ${o.label}` : o.label,
    callbackData: controlCallbackData('mode-set', o.value),
  }));
  buttons.push({ text: '⬅️ Back', callbackData: controlCallbackData('menu') });
  return buttons;
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
  '⏪ Resume from the last automatic snapshot? Restarts the orchestrator and re-injects the ' +
  'last saved context (the conversation/channel is preserved). Mainly an undo after a New session.';

/**
 * ★ REDESIGN — the `parent-restart` CONFIRM sub-menu header text. Parent restart relaunches the
 * SUPERVISOR PROCESS ITSELF (not the orchestrator child) to load a new build — a heavier action
 * than a child restart, so it is confirm-gated. Performed supervisor-side (operator-tapped), NOT
 * by the agent firing a shell command.
 */
export const CONTROL_PARENT_RESTART_CONFIRM_TEXT =
  '♻️ Restart the SUPERVISOR ITSELF to load a new build? This relaunches the whole supervisor ' +
  'process (not just the agent). The conversation/channel is preserved and the fresh agent ' +
  'auto-resumes from the last snapshot. Use this after a code update.';

/** ★ REDESIGN — the **Advanced** SUB-MENU header text (rendered with {@link buildAdvancedSubmenu}). */
export const CONTROL_ADVANCED_MENU_TEXT =
  '⚙️ Advanced — heavier, less common actions:';

/** ★ REDESIGN — the **Mode** SUB-MENU header text (rendered with {@link buildModeSubmenu}). */
export const CONTROL_MODE_MENU_TEXT =
  '🔊 Output mode — how replies arrive (voice, text, or both):';

/** The control-plane MENU header text (rendered with {@link buildControlMenu}). */
export const CONTROL_MENU_TEXT =
  '🛠️ Supervisor control plane — choose an action:\n' +
  '(handled by the supervisor out-of-band — works even if the orchestrator is stuck or dead)';

/** The `change-model` SUB-MENU header text (rendered with {@link buildModelSubmenu}). */
export const CONTROL_MODEL_MENU_TEXT = '🤖 Change orchestrator model — pick one:';

/** The `flush` CONFIRM sub-menu header text (rendered with {@link buildFlushConfirmMenu}). */
export const CONTROL_FLUSH_CONFIRM_TEXT =
  '⚠️ Drop pending inbound? This discards un-acked inbound messages from the channel queue.';

/**
 * The static `help` text — explains EVERY button (main menu + the Advanced and Mode submenus).
 * ★ REDESIGN (control-panel-redesign-2026-06-20 §"Per-button spec + help text"): the help lines
 * are authored verbatim from the spec (plain/spoken — no symbols beyond the leading bullet —
 * because the output may be read aloud via voice mode), so they no longer derive from the button
 * labels. Pure.
 */
export function controlHelpText(): string {
  return [
    '🛠️ Supervisor control plane',
    'Type /control to open the menu, then tap a button. Every action is handled by the ' +
      'supervisor itself (out-of-band), so it works even when the agent is stuck or dead.',
    '',
    'Main menu:',
    '• Status — health at a glance plus a live responsiveness check: connected bot, queue depth, ' +
      'session and restart count, pending approvals, cost, and whether the agent answered and how fast.',
    '• Approvals — resolve permission requests the agent is waiting on, like restart, force-push, ' +
      'or outward sends. Allow or deny each, or deny all to clear a stuck queue.',
    '• Log — recent channel activity: messages in, replies out, and delivery results.',
    '• New session — restart the agent with a clean slate, dropping the current context. Use it ' +
      'when the conversation is bloated or tangled.',
    '• Resume — restore the last saved context snapshot. Handy as an undo after a New session.',
    '• Interrupt — stop whatever the agent is doing right now, without restarting it or losing context.',
    '• Change model — switch the model the agent runs on. It restarts on the new model and keeps your context.',
    '• Mode — choose how replies arrive: voice, text, or both.',
    '• Advanced — less common, heavier actions: Restart, Parent restart, and Flush.',
    '• Help — what each button does.',
    '',
    'Advanced:',
    '• Restart — cleanly restart the agent, keeping your context. If it is too wedged to drain, ' +
      'it escalates to a hard kill on its own.',
    '• Parent restart — restart the supervisor itself to load a new build. Use this after a code update.',
    '• Flush — discard stuck pending messages. A last resort for a message that keeps crashing the ' +
      'agent on every restart.',
  ].join('\n');
}

/**
 * ★ P-B1 — the structured fields of one routed-dispatch result, as the SessionHost reads them off a
 * {@link RoleDispatchResult} to format the relay turn. A subset (no methods) so this formatter stays
 * pure + testable with hand-built results.
 */
export interface DispatchResultFields {
  ok: boolean;
  role?: string;
  backend?: string;
  text?: string;
  costUsd?: number;
  fellBack?: boolean;
}

/**
 * ★ P-B1 — format the routed-dispatch result as the ORCHESTRATOR TURN the supervisor injects back via
 * `lifecycle.sendUserTurn` (proposal §3 / CF6 — the routed agent is channel-mute; only this report
 * returns, into the ORCHESTRATOR's context so it can act on the code/review). The shape mirrors the
 * `[SUPERVISOR …]` out-of-band turns (`runRestartConfirm` et al.): a header line with
 * role/backend/ok/cost (+ a fell-back note when a fallback ran) followed by the agent's report text.
 * Pure.
 */
export function formatDispatchResultTurn(r: DispatchResultFields): string {
  const cost = typeof r.costUsd === 'number' ? `$${r.costUsd.toFixed(4)}` : 'n/a';
  const header =
    `[SUPERVISOR dispatch-result] role=${r.role ?? '(unknown)'} backend=${r.backend ?? '(unknown)'} ` +
    `ok=${r.ok} cost=${cost}${r.fellBack ? ' fell-back=true' : ''}`;
  const body = (r.text ?? '').trim();
  return body ? `${header}\n${body}` : header;
}

/**
 * ★ P-B1 — the operator-facing CONFIRMATION shown (edited into the tapped menu message) after a
 * `dispatch` action relays its result to the orchestrator. A short status — the FULL agent report
 * goes to the orchestrator turn (the decision-maker), not the channel. Pure.
 */
export function formatDispatchAck(r: DispatchResultFields): string {
  const cost = typeof r.costUsd === 'number' ? ` ($${r.costUsd.toFixed(4)})` : '';
  const verb = r.ok ? 'completed' : 'failed';
  return (
    `🛰️ Dispatch ${verb} — role=${r.role ?? '(unknown)'} backend=${r.backend ?? '(unknown)'}${cost}` +
    `${r.fellBack ? ' (fell back)' : ''}. The agent's full report was relayed to the orchestrator.`
  );
}

/** ★ P-B1 — the message shown when the `dispatch` action is tapped but routed dispatch is NOT wired. */
export const CONTROL_DISPATCH_UNAVAILABLE_TEXT =
  '🛰️ Dispatch is not available — model-agnostic role routing is OFF (set SUPERVISOR_ROLE_ROUTING to enable it).';

/** ★ P-B1 — the message shown for a bare `ctl:dispatch` tap (role+task are supplied via the panel route). */
export const CONTROL_DISPATCH_INFO_TEXT =
  '🛰️ Dispatch is ACTIVE — routed-agent dispatch is enabled. Supply a role + task via the loopback ' +
  'panel (POST /api/dispatch {role, task}); the agent runs sealed and its report is relayed to the orchestrator.';

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
 * ★ REDESIGN — DEFAULT cadence for the AUTO-SNAPSHOT periodic timer (control-panel-redesign
 * §"Auto-snapshot"). Snapshots context every this-many ms when `SUPERVISOR_AUTO_SNAPSHOT` is ON, so
 * any restart (incl. an unexpected watchdog restart) re-injects a recent context snapshot. Exported
 * so config.ts + the tests share one source of truth.
 */
export const DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS = 120_000; // 120s periodic snapshot cadence

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
