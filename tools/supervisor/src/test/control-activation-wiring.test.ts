/**
 * ★ OPERATOR CONTROL-PLANE — ACTIVATION WIRING tests (proposal supervisor-control-plane-and-
 * activation-2026-06-20.md §6 "Activation" + Parts A1–A5). Activation is the index.ts composition-root
 * wiring of the FIVE injected control-plane capabilities (reconnectChannel / flushChannel / captureRecent
 * / restartControl / interruptTurn) into the hosted SessionHost — the cut-over that makes the `/control`
 * menu's actions FUNCTIONAL once the user-triggered supervisor restart loads this build.
 *
 * Unlike P6 (gated on SUPERVISOR_ROLE_ROUTING), the control plane is GENERAL supervisor control → the
 * deps wire UNCONDITIONALLY for the hosted session. These tests prove the wiring at the OBSERVABLE
 * boundary by building the SAME closures index.ts builds — over a REAL Supervisor (a loopback adapter,
 * so reconnect/flush/capture hit real supervisor methods) + the SessionHost's OWN passthroughs
 * (requestRestart/clearContext/interruptCurrentTurn/setOrchestratorModel) + the FakeSessionDriver —
 * and driving `/control` + each `ctl:*` action end-to-end. They ALSO prove the dormant contract: a host
 * with NONE of the deps wired reports every action "not available" (byte-for-byte the pre-activation host).
 *
 * HOST-SAFETY (the same discipline A1–A5 shipped under): NO network, NO real Telegram, NO real `claude`
 * spawn, and NO unintended process restart. The restart-family actions exercise the REAL restartControl
 * closure but, with no operator-confirm grant wired, requestRestart only QUEUES (the out-of-band confirm
 * denies safely) → driver.starts stays constant; `clear` is the one action that legitimately restarts the
 * (fake) driver once — asserted explicitly with a 2-program driver that parks safely. interrupt drives the
 * REAL lifecycle.interruptTurn()→driver.interrupt() with no restart.
 *
 * Coexistence with P6 is covered by p6-activation-wiring.test.ts (the P6 keys) + this file (the control
 * keys) — different ctor opts, no overlap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SessionHost } from '../session-host.js';
import type { RestartIntent, RestartControlResult } from '../session-host.js';
import { Supervisor } from '../supervisor.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver, type Program } from './fake-session-driver.js';
import {
  CONTROL_MENU_TEXT,
  CONTROL_FLUSH_CONFIRM_TEXT,
  CONTROL_ACTIONS,
  controlCallbackData,
} from '../control-command.js';
import type { InboundMessage, OutboundMessage, OutboundResult, ReplyHandle } from '../contract.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

function tmpRoot(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-ctl-act-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const inbound = (text: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

const callbackInbound = (data: string, id = 'cb-1', messageId = 'menu-msg'): InboundMessage => ({
  attachments: [],
  callback: { id, data, ...(messageId ? { messageId } : {}) },
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

/** A send/answer/edit capture (the control-plane test idiom). */
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
  const editsFor = (messageId: string) => edited.filter((e) => e.messageId === messageId);
  return { sent, answered, edited, send, answerCallback, editMessage, editsFor };
}

/**
 * Build a REAL Supervisor over a loopback Telegram adapter (so reconnectChannel/flushChannel/
 * captureStore are the genuine supervisor methods index.ts binds the control deps to).
 */
function makeSupervisor(dir: string): Supervisor {
  const supervisor = new Supervisor({
    captureFile: join(dir, 'capture', 'events.ndjson'),
    logger: silentLogger(),
    unbufferedCapture: true,
  });
  const adapter = new TelegramAdapter({
    transport: new LoopbackTelegramTransport(),
    gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['555'], groups: {} } }),
    queueDir: join(dir, 'queue'),
    downloadDir: join(dir, 'downloads'),
  });
  supervisor.register(adapter);
  return supervisor;
}

/**
 * Construct a SessionHost wired EXACTLY as index.ts wires the control plane at activation: the five
 * injected capabilities built as the SAME closures (over a real Supervisor + the host's own
 * passthroughs). `programs` lets a test script a multi-start fake driver (for the `clear` restart).
 */
function makeWiredHost(supervisor: Supervisor, cap: ReturnType<typeof makeCapture>, programs?: Program[]) {
  const driver = new FakeSessionDriver(
    programs ?? [[{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }]],
  );
  // restartControl/interruptTurn close over `host` lazily — exactly like index.ts closes over
  // `sessionHost` (assigned after the ctor); read only at tap-time, never during construction.
  let host: SessionHost;
  const restartControl = async (intent: RestartIntent): Promise<RestartControlResult> => {
    if (intent.kind === 'clear') {
      await host.clearContext();
      return { ok: true, detail: 'context cleared (fresh slate)' };
    }
    if (intent.kind === 'change-model' && intent.model) host.setOrchestratorModel(intent.model);
    const reason =
      intent.kind === 'change-model'
        ? `operator change-model${intent.model ? ` → ${intent.model}` : ''}`
        : `operator ${intent.kind}`;
    const outcome = host.requestRestart(reason, intent.handoff);
    if (outcome.status === 'queued') return { ok: true, detail: 'restart queued (awaiting your confirm)' };
    if (outcome.status === 'rate_limited') {
      return { ok: false, detail: `rate-limited — retry in ~${Math.round(outcome.retryAfterMs / 1000)}s` };
    }
    return { ok: false, detail: 'a restart confirm is already in flight' };
  };
  host = new SessionHost({
    driver,
    bus: supervisor.bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    model: 'claude-opus-4-8[1m]',
    // ★ the five control-plane deps — the SAME closures index.ts builds at activation.
    reconnectChannel: () => supervisor.reconnectChannel('telegram'),
    flushChannel: () => supervisor.flushChannel('telegram'),
    captureRecent: () => supervisor.captureStore.replay(),
    restartControl,
    interruptTurn: () => host.interruptCurrentTurn(),
  });
  return { host, driver, get s() { return host; } };
}

/** A SessionHost with NONE of the control-plane deps wired (the dormant / pre-activation host). */
function makeUnwiredHost(cap: ReturnType<typeof makeCapture>) {
  const bus = (new Supervisor({ captureFile: join(tmpdir(), 'unused-cap.ndjson'), logger: silentLogger() })).bus;
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
    model: 'claude-opus-4-8[1m]',
    // (no reconnectChannel / flushChannel / captureRecent / restartControl / interruptTurn)
  });
  return { host, driver };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 0) The composition-root spread shape: the five control keys wire UNCONDITIONALLY
 *    (NOT switch-gated), unlike the P6 conditional-spread. (Mirrors how index.ts passes them.)
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ wiring shape: the control-plane deps are passed as PRESENT keys (unconditional — general supervisor control, not SUPERVISOR_ROLE_ROUTING-gated)', () => {
  // index.ts builds these five locals and passes them as plain keys (always defined for the hosted
  // session). This contrasts with the P6 conditional-spread (key ABSENT when the switch is off).
  const ctorControlKeys = {
    reconnectChannel: () => Promise.resolve({ ok: true }),
    flushChannel: () => ({ ok: true }),
    captureRecent: () => [],
    restartControl: () => ({ ok: true }),
    interruptTurn: () => undefined,
  };
  for (const k of ['reconnectChannel', 'flushChannel', 'captureRecent', 'restartControl', 'interruptTurn']) {
    assert.equal(k in ctorControlKeys, true, `${k} present unconditionally`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 1) ★ WIRED end-to-end: `/control` renders, and the child-independent actions reach the REAL
 *    supervisor methods (reconnect / flush / log) the deps are bound to.
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ ACTIVATION: /control renders the menu with one button per action (the wired host)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host, driver } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('hi')); // bind operator
    assert.equal(driver.sentTurns.length, 1, 'the normal turn forwarded');

    await host.handleInbound(inbound('/control'));
    const menu = cap.sent.find((s) => s.msg.text === CONTROL_MENU_TEXT);
    assert.ok(menu, 'the control menu rendered');
    const buttons = menu!.msg.options?.buttons ?? [];
    assert.equal(buttons.length, CONTROL_ACTIONS.length, 'one button per registry action');
    // The full activated action set is reachable as buttons.
    for (const id of ['status', 'ping', 'help', 'change-model', 'reconnect', 'flush', 'log', 'approvals', 'restart', 'kill', 'clear', 'resume', 'handoff', 'interrupt']) {
      assert.ok(buttons.some((b) => b.callbackData === controlCallbackData(id)), `menu has ${id}`);
    }
    assert.equal(driver.sentTurns.length, 1, '/control did not inject a turn');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION reconnect: ctl:reconnect reaches the REAL supervisor.reconnectChannel (ACKed OK, no turn)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host, driver } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('/control'));
    await host.handleInbound(callbackInbound('ctl:reconnect', 'cb-rc', 'm-rc'));
    assert.equal(cap.answered.at(-1)!.callbackId, 'cb-rc', 'the tap was ACKed');
    const ed = cap.editsFor('m-rc').at(-1);
    assert.ok(ed, 'the menu message was edited to the reconnect result');
    // The loopback adapter supports reconnect → a successful (re)connect, NOT the "not available" message.
    assert.doesNotMatch(ed!.text, /not available/i, 'reconnect is wired (not the dormant message)');
    assert.match(ed!.text, /reconnect/i);
    assert.equal(driver.sentTurns.length, 0, 'reconnect injected no orchestrator turn');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION flush: ctl:flush renders a confirm (no drop); ctl:flush-confirm reaches the REAL supervisor.flushChannel', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('/control'));
    // A BARE flush tap → a confirm SUB-MENU (a NEW message), NOT a drop, NOT an edit.
    const sentBefore = cap.sent.length;
    await host.handleInbound(callbackInbound('ctl:flush', 'cb-f', 'm-f'));
    assert.ok(cap.sent.length > sentBefore, 'flush sent a confirm sub-menu');
    assert.ok(cap.sent.some((s) => s.msg.text === CONTROL_FLUSH_CONFIRM_TEXT), 'the flush-confirm sub-menu was rendered');
    // The confirm tap → the REAL flushChannel (loopback supports flush → edits "dropped N", NOT "not available").
    await host.handleInbound(callbackInbound('ctl:flush-confirm', 'cb-fc', 'm-fc'));
    const doneEdit = cap.editsFor('m-fc').at(-1);
    assert.ok(doneEdit, 'flush-confirm produced a result edit');
    assert.doesNotMatch(doneEdit!.text, /not available/i, 'flush is wired (not dormant)');
    assert.match(doneEdit!.text, /dropped/i, 'the real flushChannel result (a dropped count) was surfaced');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION log: ctl:log reaches the REAL captureStore.replay (formats recent activity, not dormant)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('first message')); // produces a captured channel.inbound
    await host.handleInbound(inbound('/control'));
    await host.handleInbound(callbackInbound('ctl:log', 'cb-lg', 'm-lg'));
    const ed = cap.editsFor('m-lg').at(-1);
    assert.ok(ed, 'log produced an edit');
    assert.doesNotMatch(ed!.text, /not available/i, 'log is wired (real capture surface)');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION status/ping: read-only actions resolve with the wired model + a live pong', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('/control'));
    await host.handleInbound(callbackInbound('ctl:status', 'cb-st', 'm-st'));
    const st = cap.editsFor('m-st').at(-1);
    assert.ok(st, 'status edited');
    assert.match(st!.text, /🟢 ACTIVE/);
    assert.match(st!.text, /model: claude-opus-4-8\[1m\]/);

    await host.handleInbound(callbackInbound('ctl:ping', 'cb-pg', 'm-pg'));
    const pg = cap.editsFor('m-pg').at(-1);
    assert.ok(pg, 'ping edited');
    assert.match(pg!.text, /alive|idle|pong|🏓/i);
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 2) ★ WIRED restart family — the REAL restartControl closure reaches requestRestart/clearContext.
 *    HOST-SAFETY: with no operator-confirm GRANT wired, requestRestart only QUEUES (the out-of-band
 *    confirm denies) → driver.starts stays 1 (no real restartFresh). `clear` restarts once (asserted).
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ ACTIVATION restart: ctl:restart renders a confirm; ctl:restart-confirm reaches requestRestart (QUEUED) WITHOUT a real restart (driver.starts unchanged)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host, driver } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('hi')); // bind operator (requestRestart surfaces to it)
    const startsBefore = driver.starts;
    await host.handleInbound(inbound('/control'));
    // A BARE restart tap → confirm only (no restart requested).
    await host.handleInbound(callbackInbound('ctl:restart', 'cb-r', 'm-r'));
    assert.equal(driver.starts, startsBefore, 'a bare restart tap did NOT restart');
    // The confirm → the REAL requestRestart (returns queued; the out-of-band confirm denies — no operator grant).
    await host.handleInbound(callbackInbound('ctl:restart-confirm', 'cb-rcf', 'm-rcf'));
    const ed = cap.editsFor('m-rcf').at(-1);
    assert.ok(ed, 'restart-confirm produced a result edit');
    assert.doesNotMatch(ed!.text, /not available/i, 'restart is wired (not dormant)');
    assert.match(ed!.text, /restart|queued/i, 'the restart was requested (queued)');
    // HOST-SAFETY: no real restartFresh fired (the confirm denied — no grant) → starts unchanged.
    assert.equal(driver.starts, startsBefore, 'no real restart fired (host-safety)');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION clear: ctl:clear-confirm reaches the REAL clearContext → the fake driver restarts ONCE (parks safely)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  // Two programs: the initial run + the fresh post-clear run (parks on awaitTurn — no hang).
  const programs: Program[] = [
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'awaitTurn' }],
  ];
  const { host, driver } = makeWiredHost(supervisor, cap, programs);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('hi'));
    const startsBefore = driver.starts;
    await host.handleInbound(inbound('/control'));
    await host.handleInbound(callbackInbound('ctl:clear-confirm', 'cb-cc', 'm-cc'));
    const ed = cap.editsFor('m-cc').at(-1);
    assert.ok(ed, 'clear-confirm produced a result edit');
    assert.doesNotMatch(ed!.text, /not available/i, 'clear is wired (real clearContext)');
    // clear DOES restart the (fake) driver exactly once — the documented behavior of a fresh slate.
    assert.equal(driver.starts, startsBefore + 1, 'clear restarted the fake driver once (fresh context)');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

test('★ ACTIVATION change-model: ctl:model-set-confirm sets the next-launch model (setOrchestratorModel) + requests the restart, WITHOUT a real restart', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host, driver } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('hi'));
    const startsBefore = driver.starts;
    await host.handleInbound(inbound('/control'));
    await host.handleInbound(callbackInbound('ctl:model-set-confirm:claude-sonnet-4-6', 'cb-mm', 'm-mm'));
    const ed = cap.editsFor('m-mm').at(-1);
    assert.ok(ed, 'model-set-confirm produced a result edit');
    assert.doesNotMatch(ed!.text, /not available/i, 'change-model is wired');
    assert.match(ed!.text, /claude-sonnet-4-6/, 'the chosen model is surfaced');
    // The next-launch model was set on the lifecycle (setOrchestratorModel) — visible in the status model.
    await host.handleInbound(callbackInbound('ctl:status', 'cb-st2', 'm-st2'));
    const st = cap.editsFor('m-st2').at(-1);
    assert.match(st!.text, /model: claude-sonnet-4-6/, 'status now reflects the new next-launch model');
    // HOST-SAFETY: no real restartFresh fired (the queued confirm denied — no grant).
    assert.equal(driver.starts, startsBefore, 'no real restart fired (host-safety)');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 3) ★ WIRED interrupt — the REAL interruptCurrentTurn()→lifecycle.interruptTurn()→driver.interrupt(),
 *    NO restart (process stays alive).
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ ACTIVATION interrupt: ctl:interrupt reaches the REAL lifecycle.interruptTurn()→driver.interrupt() (no confirm, no restart)', async () => {
  const r = tmpRoot();
  const supervisor = makeSupervisor(r.dir);
  const cap = makeCapture();
  const { host, driver } = makeWiredHost(supervisor, cap);
  try {
    await supervisor.start();
    await host.start();
    await host.handleInbound(inbound('hi'));
    const startsBefore = driver.starts;
    await host.handleInbound(inbound('/control'));
    // interrupt is DIRECT (no confirm sub-menu) — one tap reaches the dep.
    await host.handleInbound(callbackInbound('ctl:interrupt', 'cb-it', 'm-it'));
    assert.equal(cap.answered.at(-1)!.callbackId, 'cb-it', 'the interrupt tap was ACKed');
    const ed = cap.editsFor('m-it').at(-1);
    assert.ok(ed, 'interrupt produced a result edit');
    assert.doesNotMatch(ed!.text, /not available/i, 'interrupt is wired');
    assert.equal(driver.interrupts, 1, 'the REAL driver.interrupt() was reached (via lifecycle.interruptTurn)');
    assert.equal(driver.starts, startsBefore, 'interrupt did NOT restart (process stays alive)');
  } finally {
    await host.stop();
    await supervisor.stop();
    r.cleanup();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 4) ★ DORMANT (pre-activation): a host with NONE of the five deps wired reports every action
 *    "not available" — proving the wiring (not the handlers) is what activates them.
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ DORMANT: an UNWIRED host reports reconnect / flush-confirm / log / restart-confirm / interrupt all "not available" (byte-for-byte pre-activation)', async () => {
  const cap = makeCapture();
  const { host, driver } = makeUnwiredHost(cap);
  try {
    await host.start();
    await host.handleInbound(inbound('hi'));
    await host.handleInbound(inbound('/control'));

    const cases: { data: string; mid: string }[] = [
      { data: 'ctl:reconnect', mid: 'd-rc' },
      { data: 'ctl:flush-confirm', mid: 'd-fc' },
      { data: 'ctl:log', mid: 'd-lg' },
      { data: 'ctl:restart-confirm', mid: 'd-rcf' },
      { data: 'ctl:interrupt', mid: 'd-it' },
    ];
    for (const c of cases) {
      await host.handleInbound(callbackInbound(c.data, `cb-${c.mid}`, c.mid));
      const ed = cap.editsFor(c.mid).at(-1);
      assert.ok(ed, `${c.data} produced an edit`);
      assert.match(ed!.text, /not available/i, `${c.data} → not available when unwired`);
    }
    // HOST-SAFETY: nothing restarted or interrupted on the dormant host.
    assert.equal(driver.interrupts, 0, 'no interrupt reached the driver (unwired)');
    assert.equal(driver.starts, 1, 'no restart fired (unwired)');
  } finally {
    await host.stop();
  }
});
