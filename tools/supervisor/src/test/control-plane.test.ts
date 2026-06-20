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
  CONTROL_ACTIONS,
  CONTROL_MODEL_CHOICES,
  CONTROL_MENU_TEXT,
  CONTROL_MODEL_MENU_TEXT,
  CONTROL_FLUSH_CONFIRM_TEXT,
  CONTROL_RESTART_CONFIRM_TEXT,
  CONTROL_KILL_CONFIRM_TEXT,
  CONTROL_CLEAR_CONFIRM_TEXT,
  CONTROL_RESUME_CONFIRM_TEXT,
  type StatusSnapshot,
} from '../control-command.js';
import { ChannelPermission } from '../channel-permission.js';
import { SessionHost } from '../session-host.js';
import type { RestartControlFn, RestartIntent, InterruptTurnFn } from '../session-host.js';
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
  // The v1 actions are present.
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  for (const id of ['status', 'ping', 'help', 'change-model']) assert.ok(ids.includes(id), `${id} in menu`);
});

test('A4: the registry includes interrupt as a DIRECT action (no submenu, no scaffold) + help lists it', () => {
  const spec = CONTROL_ACTIONS.find((a) => a.id === 'interrupt');
  assert.ok(spec, 'interrupt is a registry action');
  // NON-destructive → it is a fast ESC: NOT a confirm/submenu pivot, NOT a later-phase scaffold.
  assert.notEqual(spec!.submenu, true, 'interrupt is NOT a submenu pivot (no confirm)');
  assert.notEqual(spec!.scaffold, true, 'interrupt is NOT a scaffold');
  // It renders one menu button carrying ctl:interrupt, and the help lists it.
  assert.ok(buildControlMenu().some((b) => b.callbackData === controlCallbackData('interrupt')), 'menu has ctl:interrupt');
  assert.ok(controlHelpText().includes(spec!.label), 'help lists the interrupt action');
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

test('controlHelpText lists every action (no scaffold remains after A3)', () => {
  const help = controlHelpText();
  for (const a of CONTROL_ACTIONS) assert.ok(help.includes(a.label), `help lists ${a.label}`);
  // A3 finished change-model's wiring → NO action is a "later phase" scaffold anymore.
  assert.equal(/later phase/.test(help), false, 'no scaffold note after A3');
  // The A3 restart-family actions are listed.
  for (const label of ['Restart', 'Kill', 'Clear', 'Handoff', 'Resume']) {
    assert.ok(help.includes(label), `help lists ${label}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1e. control-command.ts — A2 actions: registry rows + sub-menu builders + log fmt
// ─────────────────────────────────────────────────────────────────────────────

test('A2: the registry includes reconnect / flush / log / approvals; flush is a submenu pivot', () => {
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  for (const id of ['reconnect', 'flush', 'log', 'approvals']) assert.ok(ids.includes(id), `${id} in registry`);
  // flush is DESTRUCTIVE → a submenu pivot (so a tap opens the confirm, not the action).
  assert.equal(CONTROL_ACTIONS.find((a) => a.id === 'flush')!.submenu, true);
  // clear LANDED in A3 (it was deferred from A2) — now a destructive submenu pivot.
  assert.ok(ids.includes('clear'), 'clear landed in A3');
  // Every registry row's callbackData round-trips (incl. the new ones, ≤64 bytes).
  for (const a of CONTROL_ACTIONS) {
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

test('A3: the registry includes restart / kill / clear / handoff / resume; the destructive ones are submenu pivots', () => {
  const ids = CONTROL_ACTIONS.map((a) => a.id);
  for (const id of ['restart', 'kill', 'clear', 'handoff', 'resume']) assert.ok(ids.includes(id), `${id} in registry`);
  // restart/kill/clear/resume RESET the orchestrator context → submenu pivots (a tap opens the confirm).
  for (const id of ['restart', 'kill', 'clear', 'resume']) {
    assert.equal(CONTROL_ACTIONS.find((a) => a.id === id)!.submenu, true, `${id} is a confirm pivot`);
  }
  // handoff is NON-destructive (it only snapshots) → NOT a submenu pivot (it runs directly).
  assert.notEqual(CONTROL_ACTIONS.find((a) => a.id === 'handoff')!.submenu, true);
  // change-model is no longer a scaffold (A3 finished its wiring).
  assert.notEqual(CONTROL_ACTIONS.find((a) => a.id === 'change-model')!.scaffold, true);
  // Every row's callbackData still round-trips ≤64 bytes.
  for (const a of CONTROL_ACTIONS) {
    const data = controlCallbackData(a.id);
    assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
    assert.deepEqual(parseControlCallback(data), { action: a.id });
  }
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
  assert.match(CONTROL_RESUME_CONFIRM_TEXT, /last handoff snapshot/);
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

test('classifyLiveness: dead when not running, stuck when idle+stall, else active', () => {
  assert.equal(classifyLiveness(baseSnap({ running: false })), 'dead');
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: true, lastStall: { silentMs: 200000, action: 'surface' } })), 'stuck');
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: true, lastStall: null })), 'active');
  // A turn in flight (not idle) is ACTIVE even if a prior stall was recorded.
  assert.equal(classifyLiveness(baseSnap({ running: true, idle: false, lastStall: { silentMs: 1, action: 'surface' } })), 'active');
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
  for (const id of ['status', 'ping', 'help', 'change-model', 'interrupt']) {
    assert.ok(buttons!.some((b) => b.callbackData === controlCallbackData(id)), `menu has ${id}`);
  }
  // NOT forwarded: still only the one earlier 'hi' turn.
  assert.equal(driver.sentTurns.length, 1, '/control did not inject a turn');
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
  assert.match(ed!.text, /Ping/);
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
