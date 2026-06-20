/**
 * OPERATOR CONTROL PLANE (`/control`) — Phase 1 + A2 + A3 tests.
 *
 * Covers the single supervisor-intercepted `/control` command, the native
 * inline-keyboard MENU, the extensible `ctl:*` callback ROUTER, and the actions:
 * Phase-1 read-only (status / ping / help) + the change-model sub-menu; A2
 * channel↔panel parity (reconnect / flush-confirm / log / approvals allow-deny); and
 * A3 the restart/lifecycle family (restart / kill / clear / handoff / resume + the
 * change-model restart wiring). Proven deterministically with the FakeSessionDriver +
 * a capturing send (the voice-modality / permission-buttons idioms) — no SDK, no
 * network, no real Telegram, and (A3 host-safety) NO real process restart: every
 * restart is REQUESTED via an injected FAKE restartControl that only RECORDS the
 * intent, so `driver.starts` stays constant and the live host is never torn down.
 *
 * Two layers:
 *   1. control-command.ts (PURE) — the command matcher, the `ctl:*` callback
 *      scheme parse, the menu + confirm builders, the action registry, and the
 *      active/stuck/dead classifier + status formatter (faked StatusSnapshots).
 *   2. SessionHost — `/control` is intercepted + ACKed + renders the menu and is
 *      NOT forwarded; each `ctl:*` tap routes to the right result; the destructive
 *      A3 actions REQUIRE a confirm (a bare tap does nothing) and request the restart
 *      with the right params (drain/handoff/model) via the injected restartControl; a
 *      non-control message is a normal turn; a `perm:*` callback still resolves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isControlCommand,
  parseControlCallback,
  controlCallbackData,
  buildControlMenu,
  buildModelSubmenu,
  buildModelSetConfirmMenu,
  buildFlushConfirmMenu,
  buildConfirmMenu,
  buildApprovalsSubmenu,
  approvalsMenuText,
  controlHelpText,
  classifyLiveness,
  formatStatus,
  formatUptime,
  formatControlLog,
  formatProactiveAlert,
  DEFAULT_TURN_WATCHDOG_MS,
  DEFAULT_PROACTIVE_WATCH_INTERVAL_MS,
  CONTROL_ACTIONS,
  CONTROL_ADVANCED_ACTIONS,
  CONTROL_MODE_OPTIONS,
  CONTROL_MODEL_CHOICES,
  CONTROL_MENU_TEXT,
  CONTROL_MENU_BUTTONS_PER_ROW,
  CONTROL_MODEL_MENU_TEXT,
  CONTROL_MODE_MENU_TEXT,
  CONTROL_ADVANCED_MENU_TEXT,
  CONTROL_FLUSH_CONFIRM_TEXT,
  CONTROL_RESTART_CONFIRM_TEXT,
  CONTROL_KILL_CONFIRM_TEXT,
  CONTROL_CLEAR_CONFIRM_TEXT,
  CONTROL_RESUME_CONFIRM_TEXT,
  CONTROL_PARENT_RESTART_CONFIRM_TEXT,
  buildAdvancedSubmenu,
  buildModeSubmenu,
  type StatusSnapshot,
} from '../control-command.js';
import { ChannelPermission } from '../channel-permission.js';
import { SessionHost } from '../session-host.js';
import type { RestartControlFn, RestartIntent, InterruptTurnFn, ParentRestartFn, RestartControlResult } from '../session-host.js';
import { LifecycleManager } from '../lifecycle.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundMessage, OutboundResult, ReplyHandle } from '../contract.js';
import type { PermissionDecision } from '../session-driver.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const baseSnap = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  running: true,
  idle: true,
  restarts: 0,
  uptimeMs: 0,
  pendingApprovals: 0,
  lastStall: null,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1a. control-command.ts — the command matcher (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('isControlCommand: /control (leading token, case/space-insensitive) → true; else false', () => {
  assert.equal(isControlCommand('/control'), true);
  assert.equal(isControlCommand('  /CONTROL  '), true);
  assert.equal(isControlCommand('/control now'), true); // leading token wins
  assert.equal(isControlCommand('hello'), false);
  assert.equal(isControlCommand('please /control'), false); // only a leading /control is the command
  assert.equal(isControlCommand('/controller'), false); // \b boundary — not /control
  assert.equal(isControlCommand('/mode text'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. control-command.ts — the ctl:* callback scheme (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('parseControlCallback: recognizes ctl:<action> + ctl:<action>:<arg>, rejects perm:* + junk', () => {
  assert.deepEqual(parseControlCallback('ctl:status'), { action: 'status' });
  assert.deepEqual(parseControlCallback('ctl:ping'), { action: 'ping' });
  assert.deepEqual(parseControlCallback('ctl:change-model'), { action: 'change-model' });
  assert.deepEqual(parseControlCallback('ctl:model-set:claude-sonnet-4-6'), {
    action: 'model-set',
    arg: 'claude-sonnet-4-6',
  });
  assert.deepEqual(parseControlCallback('CTL:STATUS'), { action: 'status' }); // case-insensitive action
  // Foreign / junk → null (left alone so the permission router still sees perm:*).
  assert.equal(parseControlCallback('perm:allow:ab12'), null);
  assert.equal(parseControlCallback('hello'), null);
  assert.equal(parseControlCallback('ctl:'), null); // empty action
  assert.equal(parseControlCallback('ctl:bad action'), null); // space not allowed in action
});

test('controlCallbackData round-trips through parseControlCallback + stays under 64 bytes', () => {
  for (const m of CONTROL_MODEL_CHOICES) {
    const data = controlCallbackData('model-set', m);
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `${data} under 64 bytes`);
    assert.deepEqual(parseControlCallback(data), { action: 'model-set', arg: m });
  }
  for (const a of CONTROL_ACTIONS) {
    const data = controlCallbackData(a.id);
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
    assert.deepEqual(parseControlCallback(data), { action: a.id });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. control-command.ts — the menu builders (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('buildControlMenu: one button per registry action, each carrying its ctl:<id>', () => {
  const menu = buildControlMenu();
  assert.equal(menu.length, CONTROL_ACTIONS.length);
  for (let i = 0; i < menu.length; i++) {
    const spec = CONTROL_ACTIONS[i]!;
    assert.equal(menu[i]!.text, spec.label);
    assert.deepEqual(parseControlCallback(menu[i]!.callbackData), { action: spec.id });
  }
  // ★ REDESIGN: the main menu is the 10 redesigned actions (status/approvals/log/clear[New session]/
  // resume/interrupt/change-model/mode/advanced/help). ping/reconnect are REMOVED; restart/kill/flush
  // moved to the Advanced submenu.
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  for (const id of ['status', 'approvals', 'log', 'clear', 'resume', 'interrupt', 'change-model', 'mode', 'advanced', 'help']) {
    assert.ok(ids.includes(id), `${id} in main menu`);
  }
  assert.equal(CONTROL_ACTIONS.length, 10, 'exactly 10 main buttons');
  // The removed-from-main top-level buttons are gone.
  for (const id of ['ping', 'reconnect', 'restart', 'kill', 'flush', 'handoff', 'parent-restart']) {
    assert.equal(ids.includes(id), false, `${id} is NOT a main-menu button`);
  }
});

test('A4: the registry includes interrupt as a DIRECT action (no submenu, no scaffold) + help lists it', () => {
  const spec = CONTROL_ACTIONS.find((a) => a.id === 'interrupt');
  assert.ok(spec, 'interrupt is a registry action');
  // NON-destructive → it is a fast ESC: NOT a confirm/submenu pivot, NOT a later-phase scaffold.
  assert.notEqual(spec!.submenu, true, 'interrupt is NOT a submenu pivot (no confirm)');
  assert.notEqual(spec!.scaffold, true, 'interrupt is NOT a scaffold');
  // It renders one menu button carrying ctl:interrupt, and the help lists it (by word — the redesign
  // help is authored spoken text, not label-derived, so it carries no emoji).
  assert.ok(buildControlMenu().some((b) => b.callbackData === controlCallbackData('interrupt')), 'menu has ctl:interrupt');
  assert.ok(controlHelpText().includes('Interrupt'), 'help lists the interrupt action');
});

test('buildModelSubmenu: one button per model choice (ctl:model-set:<m>) + a back button; marks current', () => {
  const sub = buildModelSubmenu('claude-opus-4-8[1m]');
  // model choices + 1 back button
  assert.equal(sub.length, CONTROL_MODEL_CHOICES.length + 1);
  for (let i = 0; i < CONTROL_MODEL_CHOICES.length; i++) {
    assert.deepEqual(parseControlCallback(sub[i]!.callbackData), {
      action: 'model-set',
      arg: CONTROL_MODEL_CHOICES[i]!,
    });
  }
  // The current model is checkmarked.
  assert.match(sub[0]!.text, /✅/);
  // The last button is "back to the main menu".
  assert.deepEqual(parseControlCallback(sub.at(-1)!.callbackData), { action: 'menu' });
});

test('REDESIGN buildAdvancedSubmenu: one button per Advanced action (restart/parent-restart/flush) + back', () => {
  const sub = buildAdvancedSubmenu();
  assert.equal(sub.length, CONTROL_ADVANCED_ACTIONS.length + 1, 'advanced actions + a back button');
  for (let i = 0; i < CONTROL_ADVANCED_ACTIONS.length; i++) {
    assert.deepEqual(parseControlCallback(sub[i]!.callbackData), { action: CONTROL_ADVANCED_ACTIONS[i]!.id });
  }
  // The three Advanced actions are present, in order.
  assert.deepEqual(CONTROL_ADVANCED_ACTIONS.map((a) => a.id), ['restart', 'parent-restart', 'flush']);
  // The last button returns to the main menu.
  assert.deepEqual(parseControlCallback(sub.at(-1)!.callbackData), { action: 'menu' });
  for (const b of sub) assert.ok(Buffer.byteLength(b.callbackData, 'utf8') <= 64, `${b.callbackData} ≤64B`);
});

test('REDESIGN buildModeSubmenu: one button per mode option (ctl:mode-set:<v>) + back; marks current; no confirm', () => {
  const sub = buildModeSubmenu('voice');
  assert.equal(sub.length, CONTROL_MODE_OPTIONS.length + 1, 'mode options + a back button');
  for (let i = 0; i < CONTROL_MODE_OPTIONS.length; i++) {
    assert.deepEqual(parseControlCallback(sub[i]!.callbackData), { action: 'mode-set', arg: CONTROL_MODE_OPTIONS[i]!.value });
  }
  // The three options are voice/text/dual.
  assert.deepEqual(CONTROL_MODE_OPTIONS.map((o) => o.value), ['voice', 'text', 'dual']);
  // The current mode (voice) is checkmarked; a different mode is not.
  assert.match(sub[0]!.text, /✅/);
  assert.equal(/✅/.test(sub[1]!.text), false);
  // The last button returns to the main menu.
  assert.deepEqual(parseControlCallback(sub.at(-1)!.callbackData), { action: 'menu' });
});

test('controlHelpText explains every button (main menu + Advanced) per the redesign spec', () => {
  const help = controlHelpText();
  // Every MAIN-menu button is explained (by its spoken name — the redesign help carries no emoji).
  for (const name of ['Status', 'Approvals', 'Log', 'New session', 'Resume', 'Interrupt', 'Change model', 'Mode', 'Advanced', 'Help']) {
    assert.ok(help.includes(name), `help explains ${name}`);
  }
  // The Advanced submenu buttons are explained too (Restart / Parent restart / Flush).
  for (const name of ['Restart', 'Parent restart', 'Flush']) {
    assert.ok(help.includes(name), `help explains ${name}`);
  }
  // No scaffold/later-phase note remains.
  assert.equal(/later phase/.test(help), false, 'no scaffold note');
  // The Restart help mentions the auto-escalation to a hard kill (absorbs the old Kill button).
  assert.match(help, /escalates to a hard kill/);
  // The Parent restart help mentions reloading the supervisor build.
  assert.match(help, /restart the supervisor itself to load a new build/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1e. control-command.ts — A2 actions: registry rows + sub-menu builders + log fmt
// ─────────────────────────────────────────────────────────────────────────────

test('A2 (post-redesign): log / approvals stay on the MAIN menu; flush moved to Advanced; reconnect removed', () => {
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  for (const id of ['log', 'approvals']) assert.ok(ids.includes(id), `${id} on the main menu`);
  // reconnect is REMOVED (folded into the automatic recovery ladder).
  assert.equal(ids.includes('reconnect'), false, 'reconnect removed from the main menu');
  // flush moved to the Advanced submenu (no longer a main-menu button).
  assert.equal(ids.includes('flush'), false, 'flush is not a main-menu button');
  const advIds = CONTROL_ADVANCED_ACTIONS.map((a) => a.id);
  assert.ok(advIds.includes('flush'), 'flush is in Advanced');
  assert.equal(CONTROL_ADVANCED_ACTIONS.find((a) => a.id === 'flush')!.submenu, true, 'flush stays a confirm pivot in Advanced');
  // clear (relabelled "New session") stays a destructive submenu pivot on the main menu.
  assert.ok(ids.includes('clear'), 'clear (New session) on the main menu');
  assert.equal(CONTROL_ACTIONS.find((a) => a.id === 'clear')!.label, '🧠 New session', 'clear relabelled New session');
  // Every main + Advanced row's callbackData round-trips (≤64 bytes).
  for (const a of [...CONTROL_ACTIONS, ...CONTROL_ADVANCED_ACTIONS]) {
    const data = controlCallbackData(a.id);
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
    assert.deepEqual(parseControlCallback(data), { action: a.id });
  }
});

test('A2 flush confirm sub-menu: a Confirm (ctl:flush-confirm) + a Cancel (ctl:menu)', () => {
  const menu = buildFlushConfirmMenu();
  assert.equal(menu.length, 2);
  assert.deepEqual(parseControlCallback(menu[0]!.callbackData), { action: 'flush-confirm' });
  assert.match(menu[0]!.text, /Confirm/);
  assert.deepEqual(parseControlCallback(menu[1]!.callbackData), { action: 'menu' }); // cancel = back
  // The confirm header warns it is destructive.
  assert.match(CONTROL_FLUSH_CONFIRM_TEXT, /Drop pending inbound/);
});

test('A2 approvals sub-menu: Allow/Deny per pending ask (ctl:appr-allow|deny:<code>) + back; code ≤64B', () => {
  const pending = [
    { code: 'ab12', toolName: 'Bash' },
    { code: 'cd34', toolName: 'Write' },
  ];
  const menu = buildApprovalsSubmenu(pending);
  // 2 buttons per ask + 1 back button.
  assert.equal(menu.length, pending.length * 2 + 1);
  assert.deepEqual(parseControlCallback(menu[0]!.callbackData), { action: 'appr-allow', arg: 'ab12' });
  assert.deepEqual(parseControlCallback(menu[1]!.callbackData), { action: 'appr-deny', arg: 'ab12' });
  assert.deepEqual(parseControlCallback(menu[2]!.callbackData), { action: 'appr-allow', arg: 'cd34' });
  assert.deepEqual(parseControlCallback(menu.at(-1)!.callbackData), { action: 'menu' });
  for (const b of menu) assert.ok(Buffer.byteLength(b.callbackData, 'utf8') <= 64, `${b.callbackData} ≤64B`);
  // The header lists the asks.
  assert.match(approvalsMenuText(pending), /Bash \(ab12\)/);
  // Empty → just a back button + a "none pending" header.
  const empty = buildApprovalsSubmenu([]);
  assert.equal(empty.length, 1);
  assert.deepEqual(parseControlCallback(empty[0]!.callbackData), { action: 'menu' });
  assert.match(approvalsMenuText([]), /none pending/);
});

test('A2 formatControlLog: compact inbound/outbound/delivery lines, newest last, capped', () => {
  const rec = (type: string, payload: unknown, ts = '2026-06-20T11:22:33Z') => ({ event: { ts, type, payload } });
  const records = [
    rec('channel.inbound', { text: 'hello there' }),
    rec('lifecycle', { event: 'start' }), // noise → dropped
    rec('channel.outbound', { msg: { text: 'hi back' }, result: { ok: true, sentIds: ['1'] } }),
    rec('channel.outbound', { msg: { text: 'oops' }, result: { ok: false, error: 'network down' } }),
    rec('stream.assistant', { text: 'internal' }), // noise → dropped
  ];
  const out = formatControlLog(records);
  assert.match(out, /Recent activity/);
  assert.match(out, /11:22:33 ⬇️ hello there/);
  assert.match(out, /11:22:33 ⬆️ hi back/);
  assert.match(out, /11:22:33 ⚠️ send failed: network down/);
  // Noise types are NOT rendered.
  assert.equal(/internal/.test(out), false);
  assert.equal(/start/.test(out), false);
  // Empty / no-channel-events → a friendly "none" line.
  assert.match(formatControlLog([]), /none captured/);
  assert.match(formatControlLog([rec('lifecycle', { event: 'x' })]), /none captured/);
  // The cap keeps only the last N.
  const many = Array.from({ length: 30 }, (_, i) => rec('channel.inbound', { text: `m${i}` }));
  const capped = formatControlLog(many, 5);
  assert.match(capped, /last 5/);
  assert.match(capped, /m29/);
  assert.equal(/m24/.test(capped), false, 'older than the last 5 is dropped');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1f. control-command.ts — A3 restart-family registry rows + confirm builders (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('A3 (post-redesign): clear/resume stay on main (confirm pivots); restart in Advanced; kill/handoff removed', () => {
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  // clear (New session) + resume stay on the main menu as confirm pivots (they reset/restore context).
  for (const id of ['clear', 'resume']) {
    assert.ok(ids.includes(id), `${id} on the main menu`);
    assert.equal(CONTROL_ACTIONS.find((a) => a.id === id)!.submenu, true, `${id} is a confirm pivot`);
  }
  // restart moved to Advanced (a confirm pivot there).
  assert.equal(ids.includes('restart'), false, 'restart not a main-menu button');
  const advIds = CONTROL_ADVANCED_ACTIONS.map((a) => a.id);
  assert.ok(advIds.includes('restart'), 'restart is in Advanced');
  assert.equal(CONTROL_ADVANCED_ACTIONS.find((a) => a.id === 'restart')!.submenu, true, 'restart stays a confirm pivot');
  // kill + handoff are REMOVED (kill folded into Restart auto-escalation; handoff into auto-snapshots).
  for (const id of ['kill', 'handoff']) assert.equal(ids.includes(id), false, `${id} removed`);
  // change-model is no longer a scaffold.
  assert.notEqual(CONTROL_ACTIONS.find((a) => a.id === 'change-model')!.scaffold, true);
});

test('A3 buildConfirmMenu(action): a Confirm (ctl:<action>-confirm) + a Cancel (ctl:menu)', () => {
  for (const action of ['restart', 'kill', 'clear', 'resume']) {
    const menu = buildConfirmMenu(action);
    assert.equal(menu.length, 2);
    assert.deepEqual(parseControlCallback(menu[0]!.callbackData), { action: `${action}-confirm` });
    assert.match(menu[0]!.text, /Confirm/);
    assert.deepEqual(parseControlCallback(menu[1]!.callbackData), { action: 'menu' }); // cancel = back
    assert.ok(Buffer.byteLength(menu[0]!.callbackData, 'utf8') <= 64);
  }
  // The confirm headers each warn (channel/conversation preserved, context reset).
  assert.match(CONTROL_RESTART_CONFIRM_TEXT, /GRACEFULLY/);
  assert.match(CONTROL_KILL_CONFIRM_TEXT, /HARD-restart/);
  assert.match(CONTROL_CLEAR_CONFIRM_TEXT, /FRESH/);
  assert.match(CONTROL_RESUME_CONFIRM_TEXT, /last automatic snapshot/); // ★ REDESIGN: Resume = re-inject the last AUTO snapshot
});

test('A3 buildModelSetConfirmMenu(model): a Confirm carrying the model (ctl:model-set-confirm:<m>) + back to change-model', () => {
  const m = 'claude-sonnet-4-6';
  const menu = buildModelSetConfirmMenu(m);
  assert.equal(menu.length, 2);
  assert.deepEqual(parseControlCallback(menu[0]!.callbackData), { action: 'model-set-confirm', arg: m });
  assert.match(menu[0]!.text, new RegExp(m));
  assert.deepEqual(parseControlCallback(menu[1]!.callbackData), { action: 'change-model' }); // back to the model list
  // The confirm callbackData stays ≤64 bytes for every model choice.
  for (const c of CONTROL_MODEL_CHOICES) {
    assert.ok(Buffer.byteLength(controlCallbackData('model-set-confirm', c), 'utf8') <= 64, `${c} ≤64B`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1d. control-command.ts — classify active/stuck/dead + format status (faked states)
// ─────────────────────────────────────────────────────────────────────────────

test('classifyLiveness: dead when not running, stuck when a stall signal is present, else active', () => {
  assert.equal(classifyLiveness(baseSnap({ running: false })), 'dead');
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: true, lastStall: { silentMs: 200000, action: 'surface' } })), 'stuck');
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: true, lastStall: null })), 'active');
  // ★ A5: a stall signal means STUCK regardless of idle — the in-flight turn-watchdog wedges a
  // turn (not idle) and that IS stuck (proposal §5). A5 clears lastStall on recovery, so a present
  // lastStall always denotes a CURRENT stall (never a stale prior one).
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: false, lastStall: { silentMs: 1, action: 'surface' } })), 'stuck');
  // No stall signal + in flight → ACTIVE (a busy, progressing turn).
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: false, lastStall: null })), 'active');
});

test('formatStatus surfaces the model + badge + uptime + restarts; DEAD/STUCK add a detail line', () => {
  const active = formatStatus(baseSnap({ model: 'claude-opus-4-8[1m]', uptimeMs: 3_661_000, restarts: 2 }));
  assert.match(active, /🟢 ACTIVE/);
  assert.match(active, /model: claude-opus-4-8\[1m\]/);
  assert.match(active, /uptime: 1h 1m 1s/);
  assert.match(active, /restarts: 2/);

  const dead = formatStatus(baseSnap({ running: false, model: 'claude-opus-4-8[1m]' }));
  assert.match(dead, /🔴 DEAD/);
  assert.match(dead, /not running/);

  const stuck = formatStatus(baseSnap({ idle: true, lastStall: { silentMs: 180000, action: 'surface' } }));
  assert.match(stuck, /🟡 STUCK/);
  assert.match(stuck, /stall: silent 180s/);

  // Context % shows n/a when the snapshot has none (today's telemetry).
  assert.match(active, /context: n\/a/);
  assert.match(formatStatus(baseSnap({ contextPercent: 42 })), /context: 42%/);
});

test('formatUptime: h/m/s rollup', () => {
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(45_000), '45s');
  assert.equal(formatUptime(125_000), '2m 5s');
  assert.equal(formatUptime(3_725_000), '1h 2m 5s');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SessionHost — /control interception + ctl:* routing (end-to-end with fakes)
// ─────────────────────────────────────────────────────────────────────────────

const inbound = (text: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

const callbackInbound = (data: string, id = 'cb-1', messageId?: string): InboundMessage => ({
  attachments: [],
  callback: { id, data, ...(messageId ? { messageId } : {}) },
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

/** A send/answer/edit capture (matches the permission-buttons idiom). */
function makeCapture() {
  const sent: { msg: OutboundMessage; messageId: string }[] = [];
  const answered: { callbackId: string; text?: string }[] = [];
  const edited: { messageId: string; text: string }[] = [];
  let seq = 7000;
  const send = async (_h: ReplyHandle, msg: OutboundMessage): Promise<OutboundResult> => {
    const messageId = String(seq++);
    sent.push({ msg, messageId });
    return { ok: true, sentIds: [messageId] };
  };
  const answerCallback = async (callbackId: string, text?: string): Promise<void> => {
    answered.push({ callbackId, ...(text !== undefined ? { text } : {}) });
  };
  const editMessage = async (_h: ReplyHandle, messageId: string, text: string): Promise<void> => {
    edited.push({ messageId, text });
  };
  const lastSent = () => sent.at(-1)!;
  return { sent, answered, edited, send, answerCallback, editMessage, lastSent };
}

/**
 * Injectable supervisor-side surfaces for the control-plane host — the A2 loopback
 * `reconnect`/`flush`/`log` deps + the A3 `restartControl` restart capability. All
 * optional — omitting one keeps the corresponding action UNWIRED (so the
 * dormant-default path is testable too).
 */
interface ControlDeps {
  reconnectChannel?: () => Promise<{ ok: boolean; error?: string }>;
  flushChannel?: () => { ok: boolean; dropped?: number; error?: string };
  captureRecent?: () => readonly { event?: { ts?: string; type?: string; payload?: unknown } }[];
  restartControl?: RestartControlFn;
  interruptTurn?: InterruptTurnFn;
  parentRestart?: ParentRestartFn;
}

/** A host idling after system_init, awaiting the first user turn. `model` sets opts.model. */
function makeHost(cap: ReturnType<typeof makeCapture>, model?: string, deps: ControlDeps = {}) {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    ...(model ? { model } : {}),
    ...(deps.reconnectChannel ? { reconnectChannel: deps.reconnectChannel } : {}),
    ...(deps.flushChannel ? { flushChannel: deps.flushChannel } : {}),
    ...(deps.captureRecent ? { captureRecent: deps.captureRecent } : {}),
    ...(deps.restartControl ? { restartControl: deps.restartControl } : {}),
    ...(deps.interruptTurn ? { interruptTurn: deps.interruptTurn } : {}),
    ...(deps.parentRestart ? { parentRestart: deps.parentRestart } : {}),
  });
  return { bus, driver, host };
}

/**
 * A FAKE restartControl that RECORDS each {@link RestartIntent} WITHOUT touching any real
 * lifecycle (the host-safety contract: in tests the restart is asserted as REQUESTED with
 * the right params; nothing actually restarts/kills/relaunches — `driver.starts` stays
 * constant). Returns `{ok:true}` by default; override `result` to simulate a refusal.
 */
function makeFakeRestartControl(result: { ok: boolean; detail?: string } = { ok: true }) {
  const calls: RestartIntent[] = [];
  const fn: RestartControlFn = (intent: RestartIntent) => {
    calls.push(intent);
    return result;
  };
  return { calls, fn };
}

/**
 * A4 — a FAKE interruptTurn that COUNTS each call WITHOUT touching any real lifecycle/driver
 * (the host-safety contract: the action is asserted as REQUESTED; nothing is actually interrupted
 * or restarted — `driver.starts` stays constant). Pass `throws` to simulate a driver-level failure.
 */
function makeFakeInterrupt(opts: { throws?: Error } = {}) {
  let calls = 0;
  const fn: InterruptTurnFn = () => {
    calls += 1;
    if (opts.throws) throw opts.throws;
  };
  return { fn, get calls() { return calls; } };
}

/**
 * ★ REDESIGN — a FAKE parentRestart that COUNTS each call WITHOUT spawning any real process (the
 * host-safety contract: in tests the supervisor relaunch is asserted as REQUESTED; NOTHING is
 * actually relaunched — no process spawn, `driver.starts` stays constant). Returns `{ok:true}` by
 * default; pass `result` to simulate a refusal, or `throws` for a dispatch failure.
 */
function makeFakeParentRestart(opts: { result?: RestartControlResult; throws?: Error } = {}) {
  let calls = 0;
  const fn: ParentRestartFn = () => {
    calls += 1;
    if (opts.throws) throw opts.throws;
    return opts.result ?? { ok: true, detail: 'relaunching via prod launcher' };
  };
  return { fn, get calls() { return calls; } };
}

test('/control is INTERCEPTED: renders the menu, NOT forwarded to the orchestrator', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('hi')); // bind operator + a normal turn
  assert.equal(driver.sentTurns.length, 1, 'the normal turn was forwarded');

  await host.handleInbound(inbound('/control'));
  // A menu message was sent with the expected buttons.
  const menu = cap.sent.find((s) => s.msg.text === CONTROL_MENU_TEXT);
  assert.ok(menu, 'the control menu was rendered');
  const buttons = menu!.msg.options?.buttons;
  assert.ok(buttons && buttons.length === CONTROL_ACTIONS.length, 'menu has one button per action');
  assert.equal(buttons!.length, 10, 'the redesigned main menu is 10 buttons');
  for (const id of ['status', 'help', 'change-model', 'interrupt', 'mode', 'advanced']) {
    assert.ok(buttons!.some((b) => b.callbackData === controlCallbackData(id)), `menu has ${id}`);
  }
  // NOT forwarded: still only the one earlier 'hi' turn.
  assert.equal(driver.sentTurns.length, 1, '/control did not inject a turn');
  await host.stop();
  bus.close();
});

test('the /control menu carries a buttonsPerRow layout hint (so the 10 buttons wrap into a readable grid)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('hi'));
  await host.handleInbound(inbound('/control'));
  const menu = cap.sent.find((s) => s.msg.text === CONTROL_MENU_TEXT);
  assert.ok(menu, 'the control menu was rendered');
  // The menu has 10 actions → a SINGLE flat row would squeeze every label to ~1/10 width.
  // It must request a per-row layout (2) so the adapter wraps it into a grid.
  assert.equal(menu!.msg.options?.buttonsPerRow, CONTROL_MENU_BUTTONS_PER_ROW, 'menu sets buttonsPerRow=2');
  assert.equal(CONTROL_MENU_BUTTONS_PER_ROW, 2);
  // A sub-menu (change-model) carries the SAME layout hint (it routes through sendControlMenu too).
  await host.handleInbound(callbackInbound('ctl:change-model', 'cb-cm', 'menu-msg-1'));
  const sub = cap.sent.find((s) => s.msg.text === CONTROL_MODEL_MENU_TEXT);
  assert.ok(sub, 'the change-model sub-menu was rendered');
  assert.equal(sub!.msg.options?.buttonsPerRow, CONTROL_MENU_BUTTONS_PER_ROW, 'sub-menu sets buttonsPerRow=2');
  await host.stop();
  bus.close();
});

test('ctl:status → ACKed + edits the tapped message to an ACTIVE status report incl. the model', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap, 'claude-opus-4-8[1m]');
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:status', 'cb-st', 'menu-msg-1'));
  // The tap was ACKed (spinner cleared).
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-st');
  // The tapped message was edited to the status report.
  const ed = cap.edited.find((e) => e.messageId === 'menu-msg-1');
  assert.ok(ed, 'the menu message was edited to the status');
  assert.match(ed!.text, /🟢 ACTIVE/);
  assert.match(ed!.text, /model: claude-opus-4-8\[1m\]/);
  assert.match(ed!.text, /restarts: 0/);
  // A status tap injects NO orchestrator turn.
  assert.equal(driver.sentTurns.length, 0);
  await host.stop();
  bus.close();
});

test('ctl:status reports DEAD when the child is not running (faked lifecycle state)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap, 'claude-opus-4-8[1m]');
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.stop(); // child no longer running → DEAD
  await host.handleInbound(callbackInbound('ctl:status', 'cb-dead', 'm-dead'));
  const ed = cap.edited.find((e) => e.messageId === 'm-dead');
  assert.ok(ed, 'status edited');
  assert.match(ed!.text, /🔴 DEAD/);
  assert.match(ed!.text, /not running/);
  bus.close();
});

test('ctl:ping → ACKed + edits to a pong with a round-trip; no turn injected', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:ping', 'cb-pg', 'm-pg'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-pg');
  const ed = cap.edited.find((e) => e.messageId === 'm-pg');
  assert.ok(ed, 'ping result edited in');
  assert.match(ed!.text, /pong/);
  assert.match(ed!.text, /round-trip \d+ms/);
  assert.equal(driver.sentTurns.length, 0, 'ping does not inject a turn');
  await host.stop();
  bus.close();
});

test('ctl:help → ACKed + edits to the help text listing the actions', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:help', 'cb-hp', 'm-hp'));
  const ed = cap.edited.find((e) => e.messageId === 'm-hp');
  assert.ok(ed, 'help edited in');
  assert.match(ed!.text, /Supervisor control plane/);
  assert.match(ed!.text, /Status/);
  // ★ REDESIGN: the help explains the redesigned buttons (Mode/Advanced/Parent restart), not Ping.
  assert.match(ed!.text, /Mode/);
  assert.match(ed!.text, /Advanced/);
  assert.match(ed!.text, /Parent restart/);
  assert.equal(/Ping/.test(ed!.text), false, 'Ping was removed');
  await host.stop();
  bus.close();
});

test('ctl:change-model → renders the model SUB-MENU (new message), marking the current model', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap, 'claude-opus-4-8[1m]');
  await host.start();
  await host.handleInbound(inbound('/control'));
  const before = cap.sent.length;
  await host.handleInbound(callbackInbound('ctl:change-model', 'cb-cm', 'm-cm'));
  // A NEW message (the sub-menu) was sent (an edit can't carry a fresh keyboard).
  assert.ok(cap.sent.length > before, 'a sub-menu message was sent');
  const sub = cap.sent.find((s) => s.msg.text === CONTROL_MODEL_MENU_TEXT);
  assert.ok(sub, 'the model sub-menu was rendered');
  const buttons = sub!.msg.options?.buttons;
  assert.ok(buttons && buttons.length === CONTROL_MODEL_CHOICES.length + 1, 'a button per model + back');
  assert.ok(buttons!.some((b) => /✅/.test(b.text)), 'the current model is checkmarked');
  assert.ok(buttons!.some((b) => b.callbackData === controlCallbackData('menu')), 'a back button');
  await host.stop();
  bus.close();
});

test('ctl:model-set:<m> (a model pick) → opens the model-set CONFIRM (no restart on the bare pick)', async () => {
  // A3 finished the change-model wiring: a model PICK now opens a confirm step (it no longer
  // reports a "later phase" scaffold). The bare pick still does NOT restart — the confirm does.
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap, 'claude-opus-4-8[1m]');
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:model-set:claude-sonnet-4-6', 'cb-ms', 'm-ms'));
  // A confirm sub-menu (a NEW message) carrying the chosen model was sent.
  const confirm = cap.sent.find((s) => /Switch the orchestrator to "claude-sonnet-4-6"/.test(s.msg.text ?? ''));
  assert.ok(confirm, 'a model-set confirm sub-menu was sent');
  assert.ok(confirm!.msg.options?.buttons?.some((b) => b.callbackData === 'ctl:model-set-confirm:claude-sonnet-4-6'), 'a Confirm carrying the model');
  // Crucially: the live session was NOT restarted by a bare model pick (no extra start, no turn).
  assert.equal(driver.starts, 1, 'the orchestrator was NOT restarted by a bare model pick');
  assert.equal(driver.sentTurns.length, 0, 'no turn injected by a bare model pick');
  await host.stop();
  bus.close();
});

test('ctl:menu (sub-menu back) → re-renders the main menu', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:menu', 'cb-bk'));
  // The main menu was rendered again.
  const menus = cap.sent.filter((s) => s.msg.text === CONTROL_MENU_TEXT);
  assert.ok(menus.length >= 2, 'the main menu was re-rendered on back');
  await host.stop();
  bus.close();
});

test('an unknown ctl:* action is ACKed and ignored (no crash, no turn)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  const editsBefore = cap.edited.length;
  await host.handleInbound(callbackInbound('ctl:nonesuch', 'cb-x', 'm-x'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-x', 'unknown action is still ACKed');
  assert.equal(cap.edited.length, editsBefore, 'no result edited for an unknown action');
  assert.equal(driver.sentTurns.length, 0, 'no turn injected');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. SessionHost — A2 actions (reconnect / flush+confirm / log / approvals)
// ─────────────────────────────────────────────────────────────────────────────

test('ctl:reconnect → ACKed + edits to the reconnect result (calls the injected supervisor reconnect)', async () => {
  const cap = makeCapture();
  let reconnected = 0;
  const { bus, driver, host } = makeHost(cap, undefined, {
    reconnectChannel: async () => {
      reconnected++;
      return { ok: true };
    },
  });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:reconnect', 'cb-rc', 'm-rc'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-rc', 'reconnect tap ACKed');
  assert.equal(reconnected, 1, 'the supervisor-side reconnect was called once');
  const ed = cap.edited.find((e) => e.messageId === 'm-rc');
  assert.ok(ed, 'reconnect result edited in');
  assert.match(ed!.text, /reconnected/i);
  assert.equal(driver.sentTurns.length, 0, 'reconnect injects no turn');
  await host.stop();
  bus.close();
});

test('ctl:reconnect when UNWIRED → reports unavailable (dormant default, no crash)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap); // no reconnectChannel wired
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:reconnect', 'cb-rc0', 'm-rc0'));
  const ed = cap.edited.find((e) => e.messageId === 'm-rc0');
  assert.ok(ed, 'reconnect result edited in');
  assert.match(ed!.text, /not available/i);
  await host.stop();
  bus.close();
});

test('ctl:flush → renders the CONFIRM sub-menu and does NOT drop anything (destructive-gated)', async () => {
  const cap = makeCapture();
  let flushed = 0;
  const { bus, host } = makeHost(cap, undefined, {
    flushChannel: () => {
      flushed++;
      return { ok: true, dropped: 3 };
    },
  });
  await host.start();
  await host.handleInbound(inbound('/control'));
  const before = cap.sent.length;
  await host.handleInbound(callbackInbound('ctl:flush', 'cb-fl', 'm-fl'));
  // A confirm sub-menu (a NEW message) was sent.
  assert.ok(cap.sent.length > before, 'a confirm sub-menu was sent');
  const confirm = cap.sent.find((s) => s.msg.text === CONTROL_FLUSH_CONFIRM_TEXT);
  assert.ok(confirm, 'the flush-confirm sub-menu was rendered');
  const buttons = confirm!.msg.options?.buttons;
  assert.ok(buttons!.some((b) => b.callbackData === 'ctl:flush-confirm'), 'a Confirm button');
  assert.ok(buttons!.some((b) => b.callbackData === 'ctl:menu'), 'a Cancel/back button');
  // CRUCIAL: a bare flush did NOT drop anything.
  assert.equal(flushed, 0, 'a bare flush tap does NOT call flushChannel');
  await host.stop();
  bus.close();
});

test('ctl:flush-confirm → actually flushes (calls the injected flush) + edits the dropped count', async () => {
  const cap = makeCapture();
  let flushed = 0;
  const { bus, host } = makeHost(cap, undefined, {
    flushChannel: () => {
      flushed++;
      return { ok: true, dropped: 3 };
    },
  });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:flush', 'cb-fl', 'm-fl')); // open confirm
  await host.handleInbound(callbackInbound('ctl:flush-confirm', 'cb-flc', 'm-flc')); // confirm
  assert.equal(flushed, 1, 'the confirm called flushChannel exactly once');
  const ed = cap.edited.find((e) => e.messageId === 'm-flc');
  assert.ok(ed, 'flush result edited in');
  assert.match(ed!.text, /dropped 3/);
  await host.stop();
  bus.close();
});

test('ctl:log → ACKed + edits to the formatted recent activity (from the injected capture tail)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap, undefined, {
    captureRecent: () => [
      { event: { ts: '2026-06-20T11:22:33Z', type: 'channel.inbound', payload: { text: 'play C4' } } },
      { event: { ts: '2026-06-20T11:22:34Z', type: 'channel.outbound', payload: { msg: { text: 'done' }, result: { ok: true } } } },
    ],
  });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:log', 'cb-lg', 'm-lg'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-lg', 'log tap ACKed');
  const ed = cap.edited.find((e) => e.messageId === 'm-lg');
  assert.ok(ed, 'log result edited in');
  assert.match(ed!.text, /Recent activity/);
  assert.match(ed!.text, /play C4/);
  assert.match(ed!.text, /done/);
  await host.stop();
  bus.close();
});

test('ctl:approvals with none pending → renders a sub-menu saying none pending (back only)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:approvals', 'cb-ap', 'm-ap'));
  const sub = cap.sent.find((s) => /none pending/.test(s.msg.text ?? ''));
  assert.ok(sub, 'an approvals sub-menu saying "none pending" was sent');
  const buttons = sub!.msg.options?.buttons;
  assert.ok(buttons!.some((b) => b.callbackData === 'ctl:menu'), 'a back button');
  await host.stop();
  bus.close();
});

test('ctl:approvals lists a pending ask; ctl:appr-allow:<code> resolves it via the permission path', async () => {
  const cap = makeCapture();
  const bus = new IoBus();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Bash', input: { command: 'ls' }, record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: [], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('run ls'));
  await new Promise((r) => setTimeout(r, 10));
  // A permission prompt is now pending — the approvals sub-menu lists it with the right code.
  const prompt = cap.sent.find((s) => /Approve tool 'Bash'/.test(s.msg.text ?? ''));
  assert.ok(prompt, 'a permission prompt was sent');
  const code = ChannelPermission.parseCallbackData(prompt!.msg.options!.buttons![0]!.callbackData)!.code;
  await host.handleInbound(callbackInbound('ctl:approvals', 'cb-ap2', 'm-ap2'));
  const sub = cap.sent.find((s) => s.msg.options?.buttons?.some((b) => b.callbackData === `ctl:appr-allow:${code}`));
  assert.ok(sub, 'the approvals sub-menu lists the pending ask with an allow button carrying its code');
  // Tap the control-plane ALLOW → resolves the SAME ask via operatorDecide (the perm path).
  await host.handleInbound(callbackInbound(`ctl:appr-allow:${code}`, 'cb-aa', 'm-aa'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((decision as PermissionDecision).behavior, 'allow', 'the approval was resolved via the permission path');
  const ed = cap.edited.find((e) => e.messageId === 'm-aa');
  assert.ok(ed, 'the approval result was edited in');
  assert.match(ed!.text, /Allowed/);
  await host.stop();
  bus.close();
});

test('ctl:appr-deny:<code> resolves a pending ask as DENY via the permission path', async () => {
  const cap = makeCapture();
  const bus = new IoBus();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Bash', input: { command: 'rm -rf /' }, record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: [], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('run rm'));
  await new Promise((r) => setTimeout(r, 10));
  const prompt = cap.sent.find((s) => /Approve tool 'Bash'/.test(s.msg.text ?? ''));
  const code = ChannelPermission.parseCallbackData(prompt!.msg.options!.buttons![0]!.callbackData)!.code;
  await host.handleInbound(callbackInbound(`ctl:appr-deny:${code}`, 'cb-ad', 'm-ad'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((decision as PermissionDecision).behavior, 'deny', 'the approval was DENIED via the permission path');
  const ed = cap.edited.find((e) => e.messageId === 'm-ad');
  assert.ok(ed, 'the deny result was edited in');
  assert.match(ed!.text, /Denied/);
  await host.stop();
  bus.close();
});

test('ctl:appr-allow with a stale/unknown code → reports no match (no crash, no turn)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:appr-allow:zz99', 'cb-az', 'm-az'));
  const ed = cap.edited.find((e) => e.messageId === 'm-az');
  assert.ok(ed, 'a result was edited in');
  assert.match(ed!.text, /No pending approval matched/);
  assert.equal(driver.sentTurns.length, 0, 'no turn injected');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2c. SessionHost — A3 restart/lifecycle family (restart/kill/clear/resume/handoff
//     + change-model restart wiring). HOST-SAFETY: every restart is REQUESTED via the
//     injected FAKE restartControl — the real lifecycle is NEVER torn down; `driver.starts`
//     stays 1 throughout (no relaunch), and a BARE tap (no confirm) does nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('ctl:restart (bare) → renders the GRACEFUL confirm sub-menu and does NOT restart', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  const before = cap.sent.length;
  await host.handleInbound(callbackInbound('ctl:restart', 'cb-r', 'm-r'));
  // A confirm sub-menu (a NEW message) was sent — Confirm + Cancel.
  assert.ok(cap.sent.length > before, 'a restart-confirm sub-menu was sent');
  const confirm = cap.sent.find((s) => s.msg.text === CONTROL_RESTART_CONFIRM_TEXT);
  assert.ok(confirm, 'the restart-confirm sub-menu was rendered');
  const buttons = confirm!.msg.options?.buttons;
  assert.ok(buttons!.some((b) => b.callbackData === 'ctl:restart-confirm'), 'a Confirm button');
  assert.ok(buttons!.some((b) => b.callbackData === 'ctl:menu'), 'a Cancel/back button');
  // CRUCIAL host-safety: a bare restart tap did NOT request a restart and did NOT relaunch.
  assert.equal(rc.calls.length, 0, 'a bare restart tap does NOT request a restart');
  assert.equal(driver.starts, 1, 'the orchestrator was NOT restarted by a bare restart tap');
  await host.stop();
  bus.close();
});

test('ctl:restart-confirm → requests a GRACEFUL restart (drain=true) via restartControl; live driver untouched', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:restart', 'cb-r', 'm-r')); // open confirm
  await host.handleInbound(callbackInbound('ctl:restart-confirm', 'cb-rc', 'm-rc')); // confirm
  // The restart was REQUESTED exactly once with the graceful params.
  assert.equal(rc.calls.length, 1, 'restartControl called once');
  assert.equal(rc.calls[0]!.kind, 'restart');
  assert.equal(rc.calls[0]!.drain, true, 'graceful restart drains');
  const ed = cap.edited.find((e) => e.messageId === 'm-rc');
  assert.ok(ed, 'restart result edited in');
  assert.match(ed!.text, /Graceful restart requested/);
  // HOST-SAFETY: the fake only RECORDED the intent — the real driver never restarted.
  assert.equal(driver.starts, 1, 'no real relaunch (driver.starts unchanged)');
  assert.equal(driver.sentTurns.length, 0, 'no turn injected by the restart request');
  await host.stop();
  bus.close();
});

test('ctl:kill-confirm → requests a HARD restart (drain=false) via restartControl', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:kill', 'cb-k', 'm-k')); // open confirm
  // A bare kill does not act.
  assert.equal(rc.calls.length, 0, 'a bare kill tap does NOT request a restart');
  const confirm = cap.sent.find((s) => s.msg.text === CONTROL_KILL_CONFIRM_TEXT);
  assert.ok(confirm, 'the kill-confirm sub-menu was rendered');
  assert.ok(confirm!.msg.options?.buttons?.some((b) => b.callbackData === 'ctl:kill-confirm'), 'a Confirm button');
  await host.handleInbound(callbackInbound('ctl:kill-confirm', 'cb-kc', 'm-kc')); // confirm
  assert.equal(rc.calls.length, 1, 'restartControl called once');
  assert.equal(rc.calls[0]!.kind, 'kill');
  assert.equal(rc.calls[0]!.drain, false, 'a hard restart does NOT drain');
  const ed = cap.edited.find((e) => e.messageId === 'm-kc');
  assert.match(ed!.text, /Hard restart requested/);
  assert.equal(driver.starts, 1, 'no real relaunch');
  await host.stop();
  bus.close();
});

test('ctl:clear-confirm → requests a fresh context (kind=clear, NO handoff) via restartControl', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:clear', 'cb-c', 'm-c')); // open confirm
  const confirm = cap.sent.find((s) => s.msg.text === CONTROL_CLEAR_CONFIRM_TEXT);
  assert.ok(confirm, 'the clear-confirm sub-menu was rendered');
  await host.handleInbound(callbackInbound('ctl:clear-confirm', 'cb-cc', 'm-cc')); // confirm
  assert.equal(rc.calls.length, 1, 'restartControl called once');
  assert.equal(rc.calls[0]!.kind, 'clear');
  assert.equal(rc.calls[0]!.handoff, undefined, 'clear carries NO handoff (clean slate)');
  const ed = cap.edited.find((e) => e.messageId === 'm-cc');
  assert.match(ed!.text, /Fresh context requested/);
  assert.equal(driver.starts, 1, 'no real relaunch');
  await host.stop();
  bus.close();
});

test('ctl:handoff (non-destructive) → captures a snapshot WITHOUT restarting; a later restart carries it', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, 'claude-opus-4-8[1m]', { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:handoff', 'cb-h', 'm-h'));
  // handoff is direct (no confirm) — it edits a confirmation and does NOT restart.
  const ed = cap.edited.find((e) => e.messageId === 'm-h');
  assert.ok(ed, 'handoff confirmation edited in');
  assert.match(ed!.text, /Handoff snapshot captured/);
  assert.equal(rc.calls.length, 0, 'handoff does NOT restart');
  assert.equal(driver.starts, 1, 'handoff does NOT relaunch');
  // Now a GRACEFUL restart re-injects the captured snapshot as its handoff note.
  await host.handleInbound(callbackInbound('ctl:restart', 'cb-r2', 'm-r2'));
  await host.handleInbound(callbackInbound('ctl:restart-confirm', 'cb-rc2', 'm-rc2'));
  assert.equal(rc.calls.length, 1, 'restart requested after handoff');
  assert.ok(rc.calls[0]!.handoff, 'the restart carries the captured handoff note');
  assert.match(rc.calls[0]!.handoff!, /Operator-captured handoff/);
  await host.stop();
  bus.close();
});

test('ctl:resume-confirm with NO snapshot → reports nothing to resume; does NOT restart', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:resume', 'cb-rs', 'm-rs')); // open confirm
  await host.handleInbound(callbackInbound('ctl:resume-confirm', 'cb-rsc', 'm-rsc')); // confirm w/o snapshot
  const ed = cap.edited.find((e) => e.messageId === 'm-rsc');
  assert.ok(ed, 'resume result edited in');
  assert.match(ed!.text, /No handoff snapshot to resume/);
  assert.equal(rc.calls.length, 0, 'resume with no snapshot does NOT request a restart');
  assert.equal(driver.starts, 1, 'no real relaunch');
  await host.stop();
  bus.close();
});

test('handoff → resume re-injects the captured snapshot (kind=resume + the note) via restartControl', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:handoff', 'cb-h', 'm-h')); // capture a snapshot
  await host.handleInbound(callbackInbound('ctl:resume', 'cb-rs', 'm-rs')); // open confirm
  await host.handleInbound(callbackInbound('ctl:resume-confirm', 'cb-rsc', 'm-rsc')); // confirm
  assert.equal(rc.calls.length, 1, 'resume requested once');
  assert.equal(rc.calls[0]!.kind, 'resume');
  assert.ok(rc.calls[0]!.handoff, 'resume re-injects the captured snapshot');
  const ed = cap.edited.find((e) => e.messageId === 'm-rsc');
  assert.match(ed!.text, /Resume requested/);
  assert.equal(driver.starts, 1, 'no real relaunch');
  await host.stop();
  bus.close();
});

test('ctl:model-set:<m> → opens the model-set CONFIRM (no restart); model-set-confirm → restarts with the model + handoff', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl();
  const { bus, driver, host } = makeHost(cap, 'claude-opus-4-8[1m]', { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  // A model PICK opens a confirm (a NEW message) — it does NOT restart yet.
  await host.handleInbound(callbackInbound('ctl:model-set:claude-sonnet-4-6', 'cb-ms', 'm-ms'));
  const confirm = cap.sent.find((s) => /Switch the orchestrator to "claude-sonnet-4-6"/.test(s.msg.text ?? ''));
  assert.ok(confirm, 'a model-set confirm sub-menu was sent');
  assert.ok(confirm!.msg.options?.buttons?.some((b) => b.callbackData === 'ctl:model-set-confirm:claude-sonnet-4-6'), 'a Confirm carrying the model');
  assert.equal(rc.calls.length, 0, 'a bare model pick does NOT restart');
  assert.equal(driver.starts, 1, 'no relaunch on a bare model pick');
  // The CONFIRM sets the model + restarts (drain + handoff so context carries across the switch).
  await host.handleInbound(callbackInbound('ctl:model-set-confirm:claude-sonnet-4-6', 'cb-msc', 'm-msc'));
  assert.equal(rc.calls.length, 1, 'change-model requested once');
  assert.equal(rc.calls[0]!.kind, 'change-model');
  assert.equal(rc.calls[0]!.model, 'claude-sonnet-4-6', 'the chosen model is passed through');
  assert.equal(rc.calls[0]!.drain, true, 'change-model drains');
  assert.ok(rc.calls[0]!.handoff, 'change-model carries a handoff so context survives the switch');
  const ed = cap.edited.find((e) => e.messageId === 'm-msc');
  assert.match(ed!.text, /Switching to "claude-sonnet-4-6"/);
  assert.equal(driver.starts, 1, 'the live driver was NOT restarted (fake restartControl only recorded the intent)');
  await host.stop();
  bus.close();
});

test('A3 restart actions when restartControl is UNWIRED → report unavailable; NOTHING restarts (dormant default)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap, 'claude-opus-4-8[1m]'); // no restartControl wired
  await host.start();
  await host.handleInbound(inbound('/control'));
  // Each destructive action still renders its confirm, but the CONFIRM reports unavailable.
  for (const [action, msgId] of [
    ['restart', 'm-u1'],
    ['kill', 'm-u2'],
    ['clear', 'm-u3'],
  ] as const) {
    await host.handleInbound(callbackInbound(`ctl:${action}-confirm`, `cb-${action}`, msgId));
    const ed = cap.edited.find((e) => e.messageId === msgId);
    assert.ok(ed, `${action} result edited in`);
    assert.match(ed!.text, /not available/i, `${action} reports unavailable when unwired`);
  }
  // change-model confirm also reports unavailable.
  await host.handleInbound(callbackInbound('ctl:model-set-confirm:claude-sonnet-4-6', 'cb-mu', 'm-u4'));
  assert.match(cap.edited.find((e) => e.messageId === 'm-u4')!.text, /not available/i);
  // HOST-SAFETY: nothing restarted across all of them.
  assert.equal(driver.starts, 1, 'the orchestrator was NEVER restarted (dormant default)');
  assert.equal(driver.sentTurns.length, 0, 'no turn injected');
  await host.stop();
  bus.close();
});

test('A3 restartControl refusal (e.g. rate-limited) is surfaced cleanly; no crash', async () => {
  const cap = makeCapture();
  const rc = makeFakeRestartControl({ ok: false, detail: 'rate-limited (retry in 12m)' });
  const { bus, driver, host } = makeHost(cap, undefined, { restartControl: rc.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:restart-confirm', 'cb-rc', 'm-rc'));
  assert.equal(rc.calls.length, 1, 'the restart was requested');
  const ed = cap.edited.find((e) => e.messageId === 'm-rc');
  assert.ok(ed, 'a refusal result edited in');
  assert.match(ed!.text, /refused/i);
  assert.match(ed!.text, /rate-limited/);
  assert.equal(driver.starts, 1, 'no relaunch on a refusal');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2d. SessionHost / LifecycleManager — A4 interrupt (the ESC). HOST-SAFETY: the
//     action is REQUESTED via the injected FAKE interruptTurn (no real driver/lifecycle
//     teardown); the lifecycle.interruptTurn() → driver.interrupt() wire is proven on a
//     fake driver where `driver.starts` stays constant (interrupt does NOT restart).
// ─────────────────────────────────────────────────────────────────────────────

test('LifecycleManager.interruptTurn() → driver.interrupt() (process stays up; NO restart)', async () => {
  // The wire index.ts binds at activation: lifecycle.interruptTurn → driver.interrupt.
  // The session is parked on `awaitTurn` (idle, never ending), so the cooperative
  // interrupt() does NOT end the stream → no crash → no restart (a real ESC keeps the
  // process alive). (interrupt() only releases a `silence` wedge; there is none here.)
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const lifecycle = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: async () => ({ behavior: 'deny', message: 'x', interrupt: false } as PermissionDecision),
  });
  await lifecycle.start();
  assert.equal(driver.interrupts, 0, 'no interrupt before the call');
  await lifecycle.interruptTurn();
  // Propagated to the driver exactly once — and it is NOT a restart.
  assert.equal(driver.interrupts, 1, 'interruptTurn() forwarded to driver.interrupt()');
  assert.equal(driver.starts, 1, 'interrupt does NOT restart the session (driver.starts unchanged)');
  await lifecycle.stop();
  bus.close();
});

/** A host whose orchestrator turn is IN FLIGHT (a `silence` step keeps the turn outstanding). */
function makeInFlightHost(cap: ReturnType<typeof makeCapture>, deps: ControlDeps = {}) {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    ...(deps.interruptTurn ? { interruptTurn: deps.interruptTurn } : {}),
  });
  return { bus, driver, host };
}

test('ctl:interrupt (a turn in flight) → routes to interruptTurn, ACKs "interrupt sent"; NO confirm, NO restart', async () => {
  const cap = makeCapture();
  const it = makeFakeInterrupt();
  const { bus, driver, host } = makeInFlightHost(cap, { interruptTurn: it.fn });
  await host.start();
  await host.handleInbound(inbound('do a long thing')); // a turn is now in flight (silence step)
  assert.equal(driver.sentTurns.length, 1, 'the turn was injected');
  const sentBefore = cap.sent.length;
  await host.handleInbound(callbackInbound('ctl:interrupt', 'cb-int', 'm-int'));
  // The tap was ACKed.
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-int');
  // Routed to the injected interrupt exactly once.
  assert.equal(it.calls, 1, 'interruptTurn requested once');
  // IMMEDIATE / no-confirm: the result is edited straight in — NO confirm sub-menu was sent.
  assert.equal(cap.sent.length, sentBefore, 'no confirm sub-menu message — interrupt is a fast ESC');
  const ed = cap.edited.find((e) => e.messageId === 'm-int');
  assert.ok(ed, 'interrupt result edited in');
  assert.match(ed!.text, /Interrupt sent/i);
  // HOST-SAFETY: no restart, no extra turn.
  assert.equal(driver.starts, 1, 'interrupt does NOT restart (driver.starts unchanged)');
  assert.equal(driver.sentTurns.length, 1, 'interrupt injects no new turn');
  await host.stop();
  bus.close();
});

test('ctl:cancel (the alias) → also routes to interruptTurn', async () => {
  const cap = makeCapture();
  const it = makeFakeInterrupt();
  const { bus, driver, host } = makeInFlightHost(cap, { interruptTurn: it.fn });
  await host.start();
  await host.handleInbound(inbound('do a long thing'));
  await host.handleInbound(callbackInbound('ctl:cancel', 'cb-can', 'm-can'));
  assert.equal(it.calls, 1, 'cancel alias requested the interrupt');
  const ed = cap.edited.find((e) => e.messageId === 'm-can');
  assert.ok(ed, 'cancel result edited in');
  assert.match(ed!.text, /Interrupt sent/i);
  assert.equal(driver.starts, 1, 'no restart');
  await host.stop();
  bus.close();
});

test('ctl:interrupt when IDLE → still calls interruptTurn but reports "nothing in flight"; no restart', async () => {
  const cap = makeCapture();
  const it = makeFakeInterrupt();
  const { bus, driver, host } = makeHost(cap, undefined, { interruptTurn: it.fn }); // idle (no turn sent)
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:interrupt', 'cb-idle', 'm-idle'));
  const ed = cap.edited.find((e) => e.messageId === 'm-idle');
  assert.ok(ed, 'interrupt result edited in');
  assert.match(ed!.text, /Nothing in flight/i);
  assert.equal(it.calls, 1, 'the interrupt is still requested (a no-op driver-side when idle)');
  assert.equal(driver.starts, 1, 'no restart');
  await host.stop();
  bus.close();
});

test('ctl:interrupt when interruptTurn is UNWIRED → reports "not available"; NOTHING is interrupted (dormant default)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeInFlightHost(cap); // no interruptTurn wired
  await host.start();
  await host.handleInbound(inbound('do a long thing')); // a turn in flight
  await host.handleInbound(callbackInbound('ctl:interrupt', 'cb-u', 'm-u'));
  const ed = cap.edited.find((e) => e.messageId === 'm-u');
  assert.ok(ed, 'interrupt result edited in');
  assert.match(ed!.text, /not available/i, 'reports unavailable when unwired');
  // HOST-SAFETY: the live driver was NEVER interrupted (the dep was absent) and never restarted.
  assert.equal(driver.interrupts, 0, 'the driver was NEVER interrupted (dormant default)');
  assert.equal(driver.starts, 1, 'no restart');
  await host.stop();
  bus.close();
});

test('A4 interrupt failure (driver-level) is surfaced cleanly; no crash, no restart', async () => {
  const cap = makeCapture();
  const it = makeFakeInterrupt({ throws: new Error('driver gone') });
  const { bus, driver, host } = makeInFlightHost(cap, { interruptTurn: it.fn });
  await host.start();
  await host.handleInbound(inbound('do a long thing'));
  await host.handleInbound(callbackInbound('ctl:interrupt', 'cb-f', 'm-f'));
  assert.equal(it.calls, 1, 'the interrupt was requested');
  const ed = cap.edited.find((e) => e.messageId === 'm-f');
  assert.ok(ed, 'a failure result edited in');
  assert.match(ed!.text, /Interrupt failed/i);
  assert.match(ed!.text, /driver gone/);
  assert.equal(driver.starts, 1, 'no restart on a failure');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Non-regression — the control path does not disturb anything else
// ─────────────────────────────────────────────────────────────────────────────

test('a non-/control message is a normal turn (forwarded) — control path is additive', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('what is the status of the build?')); // contains "status" but is NOT /control
  assert.equal(driver.sentTurns.length, 1, 'a normal message is forwarded as a turn');
  assert.equal(driver.sentTurns[0]!.text, 'what is the status of the build?');
  // No control menu was rendered.
  assert.equal(cap.sent.some((s) => s.msg.text === CONTROL_MENU_TEXT), false);
  await host.stop();
  bus.close();
});

test('a perm:* callback is NOT eaten by the control router — the permission decision still resolves', async () => {
  const cap = makeCapture();
  const bus = new IoBus();
  let decision: PermissionDecision | undefined;
  // A program that idles, asks for a gated tool, then ends after the decision.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Bash', input: { command: 'ls' }, record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: [], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('run ls'));
  // The permission prompt arrives WITH perm: buttons.
  await new Promise((r) => setTimeout(r, 10));
  const prompt = cap.sent.find((s) => /Approve tool 'Bash'/.test(s.msg.text ?? ''));
  assert.ok(prompt, 'a permission prompt was sent');
  const code = ChannelPermission.parseCallbackData(prompt!.msg.options!.buttons![0]!.callbackData)!.code;
  // Tap the perm:allow button — the control router must NOT intercept it.
  await host.handleInbound(callbackInbound(`perm:allow:${code}`, 'cb-perm', prompt!.messageId));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((decision as PermissionDecision).behavior, 'allow', 'perm:* still resolves the permission');
  assert.match(cap.answered.at(-1)!.text!, /Allowed/);
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A5 — PROACTIVE stuck/dead PUSH + in-flight turn-watchdog (ALERT-not-kill).
//    HOST-SAFETY: detection NEVER kills/restarts (the watchdog action is fixed to
//    'surface'); every assertion checks `driver.starts` stays 1. The proactive-watch
//    timer is driven by an INJECTED fake clock (a captured tick callback fired
//    synchronously) — NO real 180s wait, the test process never hangs. The push goes
//    to the FAKE capture transport, never real Telegram.
// ─────────────────────────────────────────────────────────────────────────────

// 4a. control-command.ts — the proactive-alert text (pure)

test('A5 formatProactiveAlert: stuck/dead produce a directive alert; active → null', () => {
  const stuck = formatProactiveAlert('stuck', { silentMs: 47_000 });
  assert.ok(stuck, 'stuck produces an alert');
  assert.match(stuck!, /unresponsive/i);
  assert.match(stuck!, /~47s/);
  assert.match(stuck!, /\/control/); // tells the user what to do
  assert.match(stuck!, /Restart/);
  // stuck with no silentMs → a graceful "a while".
  assert.match(formatProactiveAlert('stuck')!, /a while/);
  const dead = formatProactiveAlert('dead');
  assert.ok(dead, 'dead produces an alert');
  assert.match(dead!, /DIED/);
  assert.match(dead!, /\/control/);
  // active is NEVER alerted.
  assert.equal(formatProactiveAlert('active'), null);
  // The default thresholds are the decision-(c) values.
  assert.equal(DEFAULT_TURN_WATCHDOG_MS, 180_000);
  assert.equal(DEFAULT_PROACTIVE_WATCH_INTERVAL_MS, 20_000);
});

// 4b. SessionHost — host builders with the A5 proactive switch + a fake-clock watch

/** A captured fake interval: records the callback so a test can fire ticks synchronously. */
function makeFakeWatchTimers() {
  let cb: (() => void) | null = null;
  const intervals: number[] = [];
  let cleared = 0;
  return {
    timers: {
      setInterval: (fn: () => void, ms: number) => {
        cb = fn;
        intervals.push(ms);
        return { id: 1 } as unknown;
      },
      clearInterval: (_h: unknown) => {
        cleared += 1;
      },
    },
    /** Fire one proactive-watch tick (what the real interval would do). */
    tick: async () => {
      cb?.();
      await new Promise((r) => setTimeout(r, 0)); // let the async push settle
    },
    get intervals() {
      return intervals;
    },
    get cleared() {
      return cleared;
    },
    get armed() {
      return cb !== null;
    },
  };
}

/** A5 host: an idle session + the proactive switch on + a fake-clock watch + the given watchdog/ping ms. */
function makeProactiveHost(
  cap: ReturnType<typeof makeCapture>,
  opts: {
    proactiveAlerts?: boolean;
    turnWatchdogMs?: number;
    pingResponseTimeoutMs?: number;
    fakeWatch?: ReturnType<typeof makeFakeWatchTimers>;
    program?: ConstructorParameters<typeof FakeSessionDriver>[0];
  } = {},
) {
  const bus = new IoBus();
  const driver = new FakeSessionDriver(
    opts.program ?? [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }]],
  );
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    ...(opts.proactiveAlerts ? { proactiveAlerts: true } : {}),
    ...(opts.turnWatchdogMs != null ? { turnWatchdogMs: opts.turnWatchdogMs } : {}),
    ...(opts.pingResponseTimeoutMs != null ? { pingResponseTimeoutMs: opts.pingResponseTimeoutMs } : {}),
    ...(opts.fakeWatch ? { proactiveWatchTimers: opts.fakeWatch.timers } : {}),
  });
  return { bus, driver, host };
}

/** Count the alert pushes the supervisor made (stuck OR dead), by their leading emoji/word. */
function alertPushes(cap: ReturnType<typeof makeCapture>): { msg: OutboundMessage }[] {
  return cap.sent.filter((s) => /Orchestrator (unresponsive|DIED)/.test(s.msg.text ?? ''));
}

test('A5 in-flight watchdog (proactive ON): a wedged turn past the deadline PUSHES one alert, does NOT kill', async () => {
  const cap = makeCapture();
  // A turn that wedges (silence) after injection; a SHORT watchdog so the deadline elapses fast (no 180s wait).
  const { bus, driver, host } = makeProactiveHost(cap, {
    proactiveAlerts: true,
    turnWatchdogMs: 30,
    program: [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }]],
  });
  await host.start();
  await host.handleInbound(inbound('do a very long thing')); // binds operator + arms the watchdog
  assert.equal(driver.sentTurns.length, 1, 'the turn was injected');
  await new Promise((r) => setTimeout(r, 120)); // let the watchdog deadline elapse + the push settle
  // Exactly ONE proactive alert was pushed (the in-flight STUCK case), and it is directive.
  const pushes = alertPushes(cap);
  assert.equal(pushes.length, 1, 'one stuck alert pushed by the in-flight watchdog');
  assert.match(pushes[0]!.msg.text!, /unresponsive/i);
  // ★ HOST-SAFETY: ALERT-not-kill — the watchdog did NOT restart/kill the session.
  assert.equal(driver.starts, 1, 'the watchdog NEVER restarted the orchestrator (alert-only)');
  assert.equal(driver.interrupts, 0, 'the watchdog NEVER interrupted the turn (surface, not restart)');
  await host.stop();
  bus.close();
});

test('A5 in-flight watchdog (proactive ON): the alert is DEBOUNCED — one per event, not per tick', async () => {
  const cap = makeCapture();
  const fakeWatch = makeFakeWatchTimers();
  const { bus, driver, host } = makeProactiveHost(cap, {
    proactiveAlerts: true,
    turnWatchdogMs: 30,
    fakeWatch,
    program: [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }]],
  });
  await host.start();
  await host.handleInbound(inbound('do a very long thing'));
  await new Promise((r) => setTimeout(r, 120)); // watchdog fires once → one push
  assert.equal(alertPushes(cap).length, 1, 'one push from the watchdog');
  // Now fire SEVERAL proactive-watch ticks while STILL stuck — NO additional pushes (debounced).
  await fakeWatch.tick();
  await fakeWatch.tick();
  await fakeWatch.tick();
  assert.equal(alertPushes(cap).length, 1, 'repeated ticks in the same stuck state do NOT re-push (flood-safe)');
  assert.equal(driver.starts, 1, 'still no restart');
  await host.stop();
  bus.close();
});

test('A5 missed liveness ping (proactive ON): STUCK classified end-to-end + one alert pushed (no kill)', async () => {
  const cap = makeCapture();
  // pingResponseTimeoutMs short → the ping deadline fires fast. No onUnresponsive is wired here, so
  // there is NO restart path at all in this test — A5 adds none. The program keeps the session ALIVE
  // after the ping (a trailing `silence` → the stream stays open, the ping is never answered, no
  // crash → no restart) so driver.starts stays 1.
  const { bus, driver, host } = makeProactiveHost(cap, {
    proactiveAlerts: true,
    pingResponseTimeoutMs: 30,
    program: [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }]],
  });
  await host.start();
  await host.handleInbound(inbound('/control')); // bind the operator (idle session)
  // Manually fire an idle-aware liveness ping; the orchestrator never answers (it idles) → deadline.
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 80)); // let the ping deadline elapse + the push settle
  // The missed ping pushed exactly one STUCK alert.
  const pushes = alertPushes(cap);
  assert.equal(pushes.length, 1, 'one stuck alert pushed on the missed ping');
  assert.match(pushes[0]!.msg.text!, /unresponsive/i);
  // ★ status now classifies STUCK end-to-end (the A1 "stuck needs the watchdog" gap is closed).
  await host.handleInbound(callbackInbound('ctl:status', 'cb-stk', 'm-stk'));
  const ed = cap.edited.find((e) => e.messageId === 'm-stk');
  assert.ok(ed, 'status edited');
  assert.match(ed!.text, /🟡 STUCK/, 'status reports STUCK after the missed ping');
  // ★ HOST-SAFETY: nothing was killed/restarted by detection.
  assert.equal(driver.starts, 1, 'the missed ping did NOT restart the orchestrator (A5 adds no kill path)');
  await host.stop();
  bus.close();
});

test('A5 DEAD detection (proactive ON, fake clock): a watch tick on a dead child PUSHES one alert; no kill', async () => {
  const cap = makeCapture();
  const fakeWatch = makeFakeWatchTimers();
  const { bus, driver, host } = makeProactiveHost(cap, { proactiveAlerts: true, fakeWatch });
  await host.start();
  await host.handleInbound(inbound('/control')); // bind the operator
  // The proactive-watch timer was armed via the INJECTED factory (no real timer).
  assert.equal(fakeWatch.armed, true, 'the proactive-watch was armed via the injected timer factory');
  assert.ok(fakeWatch.intervals.includes(DEFAULT_PROACTIVE_WATCH_INTERVAL_MS), 'armed at the default 20s cadence');
  // Make the child DEAD (lifecycle no longer running), then fire a watch tick (the fake clock).
  await host.stop(); // child not running → DEAD; the captured tick callback still reads live health
  await fakeWatch.tick();
  const pushes = alertPushes(cap);
  assert.equal(pushes.length, 1, 'one DEAD alert pushed by the watch tick');
  assert.match(pushes[0]!.msg.text!, /DIED/);
  // Firing more ticks while still dead does NOT re-push (debounced one-per-event).
  await fakeWatch.tick();
  await fakeWatch.tick();
  assert.equal(alertPushes(cap).length, 1, 'repeated dead ticks do NOT re-push');
  // ★ HOST-SAFETY: detection never restarted the child (driver.starts stays 1).
  assert.equal(driver.starts, 1, 'DEAD detection did NOT restart the orchestrator');
  bus.close();
});

test('A5 re-arm: after RECOVERY (a late pong), a fresh stuck event alerts AGAIN (one-per-event holds across events)', async () => {
  const cap = makeCapture();
  // The program: park for ping1 → DELAY past the deadline (so ping1 times out = STUCK) → then emit a
  // (late) result that RESOLVES ping1 = recovery (back to idle) → park for ping2 → silence (keep the
  // stream open after ping2 so there is no crash/restart).
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // ping1 consumes this
      { do: 'delay', ms: 60 }, // > the 30ms deadline → ping1 times out (STUCK) before the late pong
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'late pong' } }, // recovery
      { do: 'awaitTurn' }, // ping2 consumes this
      { do: 'silence' }, // keep the stream open after ping2 (no crash → no restart)
    ],
  ]);
  const bus = new IoBus();
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    proactiveAlerts: true,
    pingResponseTimeoutMs: 30,
  });
  await host.start();
  await host.handleInbound(inbound('/control')); // bind operator (idle)
  // EVENT 1: missed ping → STUCK push #1.
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 45)); // past the 30ms deadline, before the 60ms late pong
  assert.equal(alertPushes(cap).length, 1, 'first stuck event alerts');
  // RECOVERY: the late result resolves ping1 → onInternalResult → onProactiveRecovery clears lastStall + re-arms.
  await new Promise((r) => setTimeout(r, 40)); // let the 60ms delay + the result settle
  await host.handleInbound(callbackInbound('ctl:status', 'cb-rec', 'm-rec'));
  assert.match(cap.edited.find((e) => e.messageId === 'm-rec')!.text, /🟢 ACTIVE/, 'recovered → ACTIVE (sticky stall cleared)');
  // EVENT 2: another missed ping (now idle again) → STUCK push #2 (re-armed).
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(alertPushes(cap).length, 2, 'a NEW stuck event after recovery alerts AGAIN (re-armed)');
  assert.equal(driver.starts, 1, 'no restart across the whole sequence (alert-only)');
  await host.stop();
  bus.close();
});

// 4c. SACRED INVARIANT — switch OFF ⇒ byte-for-byte (timers never arm, no push, no behavior change)

test('A5 switch OFF (default): the in-flight watchdog NEVER arms — a wedged turn does NOT push, NOT kill', async () => {
  const cap = makeCapture();
  // proactiveAlerts OMITTED (the default). Even with a (would-be) tiny watchdog value passed, it is
  // NOT wired into the lifecycle when the switch is off → the watchdog timer never arms.
  const { bus, driver, host } = makeProactiveHost(cap, {
    turnWatchdogMs: 30, // ignored while the switch is off
    program: [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }]],
  });
  await host.start();
  await host.handleInbound(inbound('do a very long thing'));
  await new Promise((r) => setTimeout(r, 120)); // a generous window — nothing should fire
  assert.equal(alertPushes(cap).length, 0, 'OFF: no proactive alert pushed (watchdog never armed)');
  assert.equal(driver.starts, 1, 'OFF: no restart');
  assert.equal(driver.interrupts, 0, 'OFF: no interrupt');
  await host.stop();
  bus.close();
});

test('A5 switch OFF (default): the proactive-watch timer never arms; a missed ping does NOT push', async () => {
  const cap = makeCapture();
  const fakeWatch = makeFakeWatchTimers();
  // proactiveAlerts OFF + a short ping timeout. The ping path still does its EXISTING tier-b behavior
  // (here onUnresponsive is unwired → nothing), but A5 adds NO latch + NO push when the switch is off.
  const { bus, driver, host } = makeProactiveHost(cap, { pingResponseTimeoutMs: 30, fakeWatch });
  await host.start();
  await host.handleInbound(inbound('/control'));
  // The proactive-watch was NOT armed (the injected factory was never called).
  assert.equal(fakeWatch.armed, false, 'OFF: the proactive-watch timer never armed');
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(alertPushes(cap).length, 0, 'OFF: a missed ping pushes no proactive alert');
  // status does NOT report STUCK from the missed ping (A5 latched nothing) — byte-for-byte the A1/A4 behavior.
  await host.handleInbound(callbackInbound('ctl:status', 'cb-off', 'm-off'));
  const ed = cap.edited.find((e) => e.messageId === 'm-off');
  assert.ok(ed, 'status edited');
  assert.equal(/🟡 STUCK/.test(ed!.text), false, 'OFF: status does not show STUCK from a missed ping (no A5 latch)');
  assert.equal(driver.starts, 1, 'OFF: no restart');
  await host.stop();
  bus.close();
});

test('A5 switch OFF: a non-/control message is still a normal turn (additive — A5 changes nothing off-path)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeProactiveHost(cap); // all A5 off
  await host.start();
  await host.handleInbound(inbound('please render the build'));
  assert.equal(driver.sentTurns.length, 1, 'a normal message is forwarded as a turn');
  assert.equal(driver.sentTurns[0]!.text, 'please render the build');
  assert.equal(alertPushes(cap).length, 0, 'no proactive alert on a normal turn');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// REDESIGN (dev-3e66) — Mode submenu, Advanced submenu, supervisor-side Parent restart
// ─────────────────────────────────────────────────────────────────────────────

test('REDESIGN ctl:mode → renders the Mode sub-menu (voice/text/dual) marking the current mode; no confirm, no turn', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap); // default outputMode = 'text'
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:mode', 'cb-mode', 'm-mode'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-mode', 'the Mode tap was ACKed');
  const sub = cap.sent.find((s) => s.msg.text === CONTROL_MODE_MENU_TEXT);
  assert.ok(sub, 'the Mode sub-menu was rendered');
  const buttons = sub!.msg.options?.buttons ?? [];
  // voice/text/dual + back.
  assert.equal(buttons.length, CONTROL_MODE_OPTIONS.length + 1);
  for (const o of CONTROL_MODE_OPTIONS) {
    assert.ok(buttons.some((b) => b.callbackData === controlCallbackData('mode-set', o.value)), `Mode has ${o.value}`);
  }
  // The current mode (text) is checkmarked.
  const textBtn = buttons.find((b) => b.callbackData === controlCallbackData('mode-set', 'text'));
  assert.match(textBtn!.text, /✅/, 'the current mode text is checkmarked');
  assert.equal(driver.sentTurns.length, 0, 'opening the Mode sub-menu injected no turn');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:mode-set:<v> → sets the output modality IMMEDIATELY (no confirm), reusing the /mode state', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap); // starts text
  await host.start();
  await host.handleInbound(inbound('/control'));
  // Pick voice — applied directly (no confirm step), edits the tapped message to the outcome.
  await host.handleInbound(callbackInbound('ctl:mode-set:voice', 'cb-mv', 'm-mv'));
  const ed = cap.edited.find((e) => e.messageId === 'm-mv');
  assert.ok(ed, 'mode-set produced a result edit');
  assert.match(ed!.text, /Output mode → voice/);
  // The state actually flipped (the SAME state the typed /mode command sets).
  assert.equal(host.outputModeState(), 'voice', 'outputMode is now voice');
  // Re-opening the Mode sub-menu shows voice checkmarked now.
  await host.handleInbound(callbackInbound('ctl:mode', 'cb-m2', 'm-m2'));
  const sub2 = cap.sent.filter((s) => s.msg.text === CONTROL_MODE_MENU_TEXT).at(-1);
  const voiceBtn = sub2!.msg.options?.buttons?.find((b) => b.callbackData === controlCallbackData('mode-set', 'voice'));
  assert.match(voiceBtn!.text, /✅/, 'voice is now the checkmarked current mode');
  // Dual works too; an unknown value is rejected cleanly (defensive).
  await host.handleInbound(callbackInbound('ctl:mode-set:dual', 'cb-md', 'm-md'));
  assert.equal(host.outputModeState(), 'dual');
  await host.handleInbound(callbackInbound('ctl:mode-set:bogus', 'cb-mb', 'm-mb'));
  assert.match(cap.edited.find((e) => e.messageId === 'm-mb')!.text, /Unknown mode/);
  assert.equal(host.outputModeState(), 'dual', 'an unknown value did NOT change the mode');
  assert.equal(driver.sentTurns.length, 0, 'mode-set never injects a turn');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:advanced → renders the Advanced sub-menu (restart/parent-restart/flush + back); no turn', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap);
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:advanced', 'cb-adv', 'm-adv'));
  assert.equal(cap.answered.at(-1)!.callbackId, 'cb-adv', 'the Advanced tap was ACKed');
  const sub = cap.sent.find((s) => s.msg.text === CONTROL_ADVANCED_MENU_TEXT);
  assert.ok(sub, 'the Advanced sub-menu was rendered');
  const buttons = sub!.msg.options?.buttons ?? [];
  for (const id of ['restart', 'parent-restart', 'flush']) {
    assert.ok(buttons.some((b) => b.callbackData === controlCallbackData(id)), `Advanced has ${id}`);
  }
  assert.ok(buttons.some((b) => b.callbackData === controlCallbackData('menu')), 'Advanced has a Back button');
  assert.equal(driver.sentTurns.length, 0, 'opening Advanced injected no turn');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:parent-restart (bare) → renders the CONFIRM sub-menu and does NOT relaunch', async () => {
  const cap = makeCapture();
  const pr = makeFakeParentRestart();
  const { bus, driver, host } = makeHost(cap, undefined, { parentRestart: pr.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:parent-restart', 'cb-pr', 'm-pr'));
  // A confirm sub-menu was sent (a NEW message), with a Confirm carrying ctl:parent-restart-confirm.
  const confirm = cap.sent.find((s) => s.msg.text === CONTROL_PARENT_RESTART_CONFIRM_TEXT);
  assert.ok(confirm, 'the parent-restart confirm sub-menu was rendered');
  const buttons = confirm!.msg.options?.buttons ?? [];
  assert.ok(buttons.some((b) => b.callbackData === 'ctl:parent-restart-confirm'), 'a Confirm button');
  assert.ok(buttons.some((b) => b.callbackData === 'ctl:menu'), 'a Cancel/back button');
  // HOST-SAFETY: a bare tap did NOT relaunch anything.
  assert.equal(pr.calls, 0, 'a bare parent-restart did NOT relaunch');
  assert.equal(driver.starts, 1, 'no orchestrator-child restart either');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:parent-restart-confirm → dispatches the supervisor relaunch via the injected dep (supervisor-side); child untouched', async () => {
  const cap = makeCapture();
  const pr = makeFakeParentRestart();
  const { bus, driver, host } = makeHost(cap, undefined, { parentRestart: pr.fn });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:parent-restart', 'cb-pr', 'm-pr')); // open confirm
  await host.handleInbound(callbackInbound('ctl:parent-restart-confirm', 'cb-prc', 'm-prc')); // confirm
  assert.equal(pr.calls, 1, 'the parent-restart was dispatched once on confirm');
  const ed = cap.edited.find((e) => e.messageId === 'm-prc');
  assert.ok(ed, 'parent-restart-confirm produced a result edit');
  assert.match(ed!.text, /Parent restart dispatched/);
  // HOST-SAFETY: the orchestrator CHILD was not cycled (parent restart relaunches the supervisor itself),
  // and no orchestrator turn was injected (the relaunch is supervisor-side, not an agent shell command).
  assert.equal(driver.starts, 1, 'parent-restart did NOT cycle the orchestrator child');
  assert.equal(driver.sentTurns.length, 1, 'parent-restart injected no orchestrator turn (only the earlier hi)');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:parent-restart-confirm when UNWIRED → reports unavailable; NOTHING relaunches (dormant default)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeHost(cap); // no parentRestart wired
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:parent-restart-confirm', 'cb-pr0', 'm-pr0'));
  const ed = cap.edited.find((e) => e.messageId === 'm-pr0');
  assert.ok(ed, 'edited');
  assert.match(ed!.text, /not available/i, 'reports unavailable when unwired');
  assert.equal(driver.starts, 1, 'nothing relaunched (dormant default)');
  await host.stop();
  bus.close();
});

test('REDESIGN ctl:parent-restart-confirm refusal/throw is surfaced cleanly; no crash', async () => {
  const cap = makeCapture();
  const prRefuse = makeFakeParentRestart({ result: { ok: false, detail: 'relaunch script not found: X' } });
  const { bus, host } = makeHost(cap, undefined, { parentRestart: prRefuse.fn });
  await host.start();
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:parent-restart-confirm', 'cb-prr', 'm-prr'));
  assert.match(cap.edited.find((e) => e.messageId === 'm-prr')!.text, /refused/i);
  // A thrown dispatch error is caught + surfaced (not a crash).
  const prThrow = makeFakeParentRestart({ throws: new Error('spawn EACCES') });
  const cap2 = makeCapture();
  const { bus: bus2, host: host2 } = makeHost(cap2, undefined, { parentRestart: prThrow.fn });
  await host2.start();
  await host2.handleInbound(inbound('/control'));
  await host2.handleInbound(callbackInbound('ctl:parent-restart-confirm', 'cb-prt', 'm-prt'));
  assert.match(cap2.edited.find((e) => e.messageId === 'm-prt')!.text, /failed/i);
  await host.stop();
  await host2.stop();
  bus.close();
  bus2.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// ★ REDESIGN (dev-3e66) — PART 2 automatic behaviors: recovery ladder, auto-snapshot
//   (incl. the cold watchdog path), restart hard-kill escalation, status live-probe.
//   ALL host-safe: fake driver + capturing send + an injectable `delay` that resolves
//   immediately (NO real wait) — nothing real is restarted; driver.starts is asserted.
// ─────────────────────────────────────────────────────────────────────────────

/** A host with the PART-2 automatic behaviors configurable + an immediate (fake) delay. */
function makeAutoHost(
  cap: ReturnType<typeof makeCapture>,
  opts: {
    program?: ConstructorParameters<typeof FakeSessionDriver>[0];
    recoveryLadder?: boolean;
    autoSnapshot?: boolean;
    restartDrainMs?: number;
    statusProbeMs?: number;
    pingResponseTimeoutMs?: number;
    reconnectChannel?: () => Promise<{ ok: boolean; error?: string }>;
    autoSnapshotTimers?: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void };
  } = {},
) {
  const bus = new IoBus();
  const driver = new FakeSessionDriver(
    opts.program ?? [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }]],
  );
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    model: 'claude-opus-4-8[1m]',
    // A near-instant delay that YIELDS a macrotask each poll iteration (setTimeout 0) — so the fake
    // driver's generator can run its pending emit between polls — WITHOUT a real wait (each step is
    // sub-ms; the loops are iteration-bounded so they finish in a few ms, never the real deadline).
    delay: () => new Promise<void>((r) => setTimeout(r, 0)),
    ...(opts.recoveryLadder ? { recoveryLadder: true } : {}),
    ...(opts.autoSnapshot ? { autoSnapshot: true } : {}),
    ...(opts.restartDrainMs != null ? { restartDrainMs: opts.restartDrainMs } : {}),
    ...(opts.statusProbeMs != null ? { statusProbeMs: opts.statusProbeMs } : {}),
    ...(opts.pingResponseTimeoutMs != null ? { pingResponseTimeoutMs: opts.pingResponseTimeoutMs } : {}),
    ...(opts.reconnectChannel ? { reconnectChannel: opts.reconnectChannel } : {}),
    ...(opts.autoSnapshotTimers ? { autoSnapshotTimers: opts.autoSnapshotTimers } : {}),
  });
  return { bus, driver, host };
}

// ── Recovery ladder (reconnect → reset) ──────────────────────────────────────

test('REDESIGN recovery ladder: a reconnect that brings the agent back → reconnected (NO restart)', async () => {
  const cap = makeCapture();
  let reconnected = 0;
  // After reconnect, the agent answers the probe ping → probeResponsive true → no reset. The 'hi'
  // turn AND the probe ping turn each get a result so the agent is responsive throughout.
  const { bus, driver, host } = makeAutoHost(cap, {
    recoveryLadder: true,
    statusProbeMs: 1000,
    pingResponseTimeoutMs: 1000,
    reconnectChannel: async () => {
      reconnected += 1;
      return { ok: true };
    },
    program: [
      [
        { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
        { do: 'awaitTurn' },
        { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'hi-ack' } }, // the 'hi' turn
        { do: 'awaitTurn' },
        { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'pong' } }, // the probe ping
        { do: 'awaitTurn' },
      ],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi')); // bind operator + a turn that gets a result
  await new Promise((r) => setTimeout(r, 0)); // let the 'hi' result settle (idle)
  const startsBefore = driver.starts;
  const action = await host.handleUnresponsiveRecovery('liveness timeout');
  assert.equal(reconnected, 1, 'the channel reconnect was attempted FIRST');
  assert.equal(action, 'reconnected', 'the agent answered after reconnect → recovered without a reset');
  assert.equal(driver.starts, startsBefore, 'NO restart happened (the ladder stopped at reconnect)');
  assert.ok(cap.sent.some((s) => /reconnected/i.test(s.msg.text ?? '')), 'the user was told it reconnected');
  await host.stop();
  bus.close();
});

test('REDESIGN recovery ladder: still unresponsive after reconnect → RESET (restart), snapshot carried', async () => {
  const cap = makeCapture();
  let reconnected = 0;
  // The probe never gets a result (the agent stays wedged) → probeResponsive false → escalate to reset.
  const { bus, driver, host } = makeAutoHost(cap, {
    recoveryLadder: true,
    autoSnapshot: true, // so the reset carries a snapshot
    statusProbeMs: 1000,
    pingResponseTimeoutMs: 1000,
    reconnectChannel: async () => {
      reconnected += 1;
      return { ok: true };
    },
    program: [
      // 1st run: init, then wedge (no result to the probe ping)
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }],
      // 2nd run after restartFresh: a fresh init (the reset relaunched)
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  const startsBefore = driver.starts;
  const action = await host.handleUnresponsiveRecovery('liveness timeout');
  assert.equal(reconnected, 1, 'reconnect was tried first');
  assert.equal(action, 'reset', 'still unresponsive → reset');
  assert.equal(driver.starts, startsBefore + 1, 'exactly one restart (restartFresh) happened');
  // The reset injected a snapshot into the fresh first turn (auto-recovery handoff).
  assert.ok(driver.sentTurns.some((t) => /auto-recovery|auto-captured snapshot/i.test(t.text)), 'the fresh session got the snapshot');
  await host.stop();
  bus.close();
});

test('REDESIGN recovery ladder UNWIRED reconnect → falls straight through to a RESET', async () => {
  const cap = makeCapture();
  // No reconnectChannel wired → step 1 is skipped → straight to reset.
  const { bus, driver, host } = makeAutoHost(cap, {
    recoveryLadder: true,
    statusProbeMs: 1000,
    program: [
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  const startsBefore = driver.starts;
  const action = await host.handleUnresponsiveRecovery('liveness timeout');
  assert.equal(action, 'reset', 'no reconnect dep → reset directly');
  assert.equal(driver.starts, startsBefore + 1, 'one restart');
  await host.stop();
  bus.close();
});

// ── Auto-snapshot (periodic + pre-EVERY-restart incl. the cold watchdog path) ──

test('REDESIGN auto-snapshot: the involuntary (watchdog) restart re-injects context — closes the cold gap', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeAutoHost(cap, {
    autoSnapshot: true,
    program: [
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  const startsBefore = driver.starts;
  // Directly exercise the involuntary path (what the tier-b watchdog calls).
  await host.restartUnresponsive();
  assert.equal(driver.starts, startsBefore + 1, 'the involuntary restart happened');
  // ★ the fresh session came up WITH context (the cold-watchdog gap is closed).
  assert.ok(
    driver.sentTurns.some((t) => /auto-recovery|auto-captured snapshot/i.test(t.text)),
    'the cold restart re-injected the auto-snapshot into the fresh first turn',
  );
  await host.stop();
  bus.close();
});

test('REDESIGN auto-snapshot OFF: the involuntary restart is byte-for-byte today (NO injected first turn)', async () => {
  const cap = makeCapture();
  const { bus, driver, host } = makeAutoHost(cap, {
    autoSnapshot: false, // default
    program: [
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await host.restartUnresponsive();
  // OFF → no snapshot-recovery turn injected into the fresh session (it boots blank, as before).
  assert.equal(
    driver.sentTurns.some((t) => /auto-recovery|auto-captured snapshot/i.test(t.text)),
    false,
    'no auto-recovery turn injected when auto-snapshot is OFF',
  );
  // Drain run 2's awaitTurn with a normal turn so the fake-driver generator completes cleanly
  // (no dangling paused promise after the test) — this is harness hygiene, not the assertion.
  await host.handleInbound(inbound('ok'));
  await host.stop();
  bus.close();
});

test('REDESIGN auto-snapshot periodic timer: arms only when ON; a tick captures a snapshot a later restart carries', async () => {
  const cap = makeCapture();
  const snap: { cb: (() => void) | null } = { cb: null };
  const fakeTimers = {
    setInterval: (cb: () => void, _ms: number) => {
      snap.cb = cb;
      return { id: 9 } as unknown;
    },
    clearInterval: (_h: unknown) => undefined,
  };
  const { bus, driver, host } = makeAutoHost(cap, {
    autoSnapshot: true,
    autoSnapshotTimers: fakeTimers,
    program: [
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  assert.ok(snap.cb, 'the periodic auto-snapshot timer armed (ON)');
  snap.cb!(); // fire one periodic snapshot tick (what the real interval would do)
  // A subsequent involuntary restart carries the (now-present) snapshot into the fresh first turn.
  await host.restartUnresponsive();
  assert.ok(driver.sentTurns.some((t) => /auto-recovery|auto-captured snapshot/i.test(t.text)), 'the periodic snapshot was carried into the restart');
  await host.stop();
  bus.close();
});

test('REDESIGN auto-snapshot timer does NOT arm when OFF (byte-for-byte today)', async () => {
  const cap = makeCapture();
  let armed = false;
  const fakeTimers = {
    setInterval: (_cb: () => void, _ms: number) => {
      armed = true;
      return { id: 9 } as unknown;
    },
    clearInterval: (_h: unknown) => undefined,
  };
  const { bus, host } = makeAutoHost(cap, { autoSnapshot: false, autoSnapshotTimers: fakeTimers });
  await host.start();
  await host.handleInbound(inbound('hi'));
  assert.equal(armed, false, 'no auto-snapshot timer arms when the switch is OFF');
  await host.stop();
  bus.close();
});

// ── Restart hard-kill escalation ─────────────────────────────────────────────

test('REDESIGN restart escalation: a STALLED drain escalates to a hard restart (drainMs>0)', async () => {
  const cap = makeCapture();
  // A turn is left in flight (silence after the user turn) → isIdle() stays false → the drain stalls.
  const { bus, driver, host } = makeAutoHost(cap, {
    restartDrainMs: 500,
    program: [
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }],
      [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('do a long thing')); // a turn now in flight (wedged) → isIdle() false
  let restarted = 0;
  const outcome = await host.gracefulRestartWithEscalation(async () => {
    restarted += 1;
  });
  assert.equal(outcome, 'escalated', 'the stalled drain escalated to a hard restart');
  assert.equal(restarted, 1, 'the restart was performed despite the stalled drain');
  await host.stop();
  bus.close();
});

test('REDESIGN restart escalation: an IDLE agent drains cleanly (no escalation needed)', async () => {
  const cap = makeCapture();
  // The 'hi' turn gets a result → the agent returns to idle (outstandingTurns back to 0).
  const { bus, host } = makeAutoHost(cap, {
    restartDrainMs: 500,
    program: [
      [
        { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
        { do: 'awaitTurn' },
        { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
        { do: 'awaitTurn' },
      ],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 0)); // let the result settle → idle
  let restarted = 0;
  const outcome = await host.gracefulRestartWithEscalation(async () => {
    restarted += 1;
  });
  assert.equal(outcome, 'drained', 'an idle agent drains cleanly');
  assert.equal(restarted, 1, 'the restart still happened');
  await host.stop();
  bus.close();
});

test('REDESIGN restart escalation OFF (drainMs=0): immediate restart, byte-for-byte today', async () => {
  const cap = makeCapture();
  const { bus, host } = makeAutoHost(cap, { restartDrainMs: 0 });
  await host.start();
  await host.handleInbound(inbound('hi'));
  let restarted = 0;
  const outcome = await host.gracefulRestartWithEscalation(async () => {
    restarted += 1;
  });
  assert.equal(outcome, 'immediate', 'drainMs=0 → no drain wait, immediate restart');
  assert.equal(restarted, 1);
  await host.stop();
  bus.close();
});

// ── Status live-probe ────────────────────────────────────────────────────────

test('REDESIGN status live-probe: reports latency + last-turn time when the agent answers', async () => {
  const cap = makeCapture();
  const { bus, host } = makeAutoHost(cap, {
    statusProbeMs: 1000,
    pingResponseTimeoutMs: 1000,
    program: [
      [
        { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
        { do: 'awaitTurn' },
        // the 'hi' turn → a result (sets lastTurnAt + returns to idle)
        { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'earlier' } },
        { do: 'awaitTurn' },
        // the probe ping turn → a result (answered → probeResponsive true)
        { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'pong' } },
        { do: 'awaitTurn' },
      ],
    ],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 0)); // let the 'hi' result settle (lastTurnAt set, idle)
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:status', 'cb-st', 'm-st'));
  const ed = cap.edited.find((e) => e.messageId === 'm-st');
  assert.ok(ed, 'status edited');
  assert.match(ed!.text, /🟢 ACTIVE/, 'the snapshot is present');
  assert.match(ed!.text, /probe:/, 'a live-probe line is appended');
  assert.match(ed!.text, /last turn:/, 'the last-turn time is reported');
  await host.stop();
  bus.close();
});

test('REDESIGN status live-probe: the snapshot STILL returns even if the probe times out', async () => {
  const cap = makeCapture();
  // The probe ping never gets a result (wedged) → probe times out, but status must still report.
  const { bus, host } = makeAutoHost(cap, {
    statusProbeMs: 1000,
    pingResponseTimeoutMs: 1000,
    program: [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }]],
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:status', 'cb-st', 'm-st'));
  const ed = cap.edited.find((e) => e.messageId === 'm-st');
  assert.ok(ed, 'status STILL returned despite the probe');
  assert.match(ed!.text, /🟢 ACTIVE|🟡 STUCK|🔴 DEAD/, 'the snapshot badge is present (snapshot never lost)');
  assert.match(ed!.text, /probe: timed out/, 'the probe timeout is reported, not swallowed');
  await host.stop();
  bus.close();
});

test('REDESIGN status live-probe OFF (probeMs=0): status is the cheap snapshot only (byte-for-byte)', async () => {
  const cap = makeCapture();
  const { bus, host } = makeAutoHost(cap, { statusProbeMs: 0 });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(callbackInbound('ctl:status', 'cb-st', 'm-st'));
  const ed = cap.edited.find((e) => e.messageId === 'm-st');
  assert.ok(ed, 'status edited');
  assert.match(ed!.text, /🟢 ACTIVE/);
  assert.equal(/probe:/.test(ed!.text), false, 'no live-probe line when probeMs=0');
  await host.stop();
  bus.close();
});
