/**
 * FIX-1 — Telegram native inline-keyboard buttons for permission / confirmation
 * prompts (+ the callback_query inbound path). Covers three layers:
 *
 *   1. ChannelPermission — askUser attaches ✅ Allow / ❌ Deny buttons whose
 *      callback_data is `perm:allow:<code>` / `perm:deny:<code>`; parseCallbackData
 *      recognizes the scheme; submitReplyDetailed resolves the matching pending ask
 *      (and ignores a wrong/stale code) returning the prompt's messageId + toolName.
 *   2. TelegramAdapter — a raw callback_query (loopback injectCallback) is routed
 *      straight to the inbound handler as an InboundMessage carrying `callback`
 *      (NOT through the durable queue); answerCallback + editMessage reach the wire.
 *   3. SessionHost — an inbound button tap resolves the pending permission decision
 *      (allow→allow, deny→deny), a wrong/stale token is ignored, the text fallback
 *      still works, and the lifecycle restart-confirmation also carries buttons.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { ChannelPermission } from '../channel-permission.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { AccessGate } from '../adapters/access-gate.js';
import { SessionHost } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, InlineButton, OutboundMessage, OutboundResult, ReplyHandle } from '../contract.js';
import type { PermissionDecision, PermissionRequest } from '../session-driver.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const operator: ReplyHandle = { to: '555' };
const req: PermissionRequest = { toolName: 'Bash', input: { command: 'ls' } };

// ── 1. ChannelPermission — callback_data scheme + button send + resolution ──────

test('parseCallbackData recognizes perm:allow/deny:<code>, rejects junk + foreign callbacks', () => {
  assert.deepEqual(ChannelPermission.parseCallbackData('perm:allow:ab12'), { code: 'ab12', verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseCallbackData('perm:deny:0f0f'), { code: '0f0f', verdict: 'deny' });
  assert.deepEqual(ChannelPermission.parseCallbackData('PERM:ALLOW:ABCD'), { code: 'abcd', verdict: 'allow' });
  assert.equal(ChannelPermission.parseCallbackData('perm:allow:xyz'), null); // not 4 hex
  assert.equal(ChannelPermission.parseCallbackData('perm:maybe:ab12'), null); // bad verdict
  assert.equal(ChannelPermission.parseCallbackData('other:allow:ab12'), null); // foreign prefix (left alone)
  assert.equal(ChannelPermission.parseCallbackData('hello'), null);
});

test('the callback_data stays well under Telegram’s 64-byte cap', () => {
  // perm:allow:ffff = 15 bytes.
  const data = 'perm:allow:ffff';
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
  assert.equal(Buffer.byteLength(data, 'utf8'), 15);
});

test('askUser attaches ✅ Allow / ❌ Deny buttons carrying the minted code', async () => {
  const buttonsSeen: InlineButton[][] = [];
  const cp = new ChannelPermission({
    send: async (_h, _text, buttons) => {
      if (buttons) buttonsSeen.push(buttons);
      return { messageId: 'm-100' };
    },
    operator,
    timeoutMs: 5000,
  });
  const p = cp.askUser(req);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(buttonsSeen.length, 1, 'a keyboard was attached to the prompt');
  const buttons = buttonsSeen[0]!;
  assert.equal(buttons.length, 2);
  assert.match(buttons[0]!.text, /Allow/);
  assert.match(buttons[1]!.text, /Deny/);
  const allowCb = ChannelPermission.parseCallbackData(buttons[0]!.callbackData);
  const denyCb = ChannelPermission.parseCallbackData(buttons[1]!.callbackData);
  assert.ok(allowCb && allowCb.verdict === 'allow');
  assert.ok(denyCb && denyCb.verdict === 'deny');
  assert.equal(allowCb!.code, denyCb!.code, 'both buttons carry the SAME pending code');
  // Resolve via the button code so the awaited promise settles.
  assert.equal(cp.submitReply(allowCb!.code, 'allow'), true);
  assert.equal(await p, 'allow');
});

test('submitReplyDetailed resolves a MATCHING code → returns messageId + toolName', async () => {
  let code = '';
  const cp = new ChannelPermission({
    send: async (_h, _text, buttons) => {
      code = ChannelPermission.parseCallbackData(buttons![0]!.callbackData)!.code;
      return { messageId: 'm-777' };
    },
    operator,
    timeoutMs: 5000,
  });
  const p = cp.askUser({ toolName: 'PowerShell', input: {} });
  await new Promise((r) => setTimeout(r, 5));
  const res = cp.submitReplyDetailed(code, 'allow');
  assert.equal(res.resolved, true);
  assert.equal(res.messageId, 'm-777', 'returns the prompt message id to edit');
  assert.equal(res.toolName, 'PowerShell');
  assert.equal(await p, 'allow');
});

test('submitReplyDetailed with a WRONG/stale code does not resolve', async () => {
  const cp = new ChannelPermission({ send: async () => ({ messageId: 'm-1' }), operator, timeoutMs: 40 });
  const p = cp.askUser(req);
  await new Promise((r) => setTimeout(r, 5));
  const res = cp.submitReplyDetailed('zzzz', 'allow');
  assert.equal(res.resolved, false, 'non-matching code → not resolved');
  assert.equal(res.messageId, undefined);
  assert.equal(cp.pendingCount, 1, 'still pending');
  // Let it time out to settle the promise (keep the loop alive for the unref'd timer).
  const [verdict] = await Promise.all([p, new Promise((r) => setTimeout(r, 60))]);
  assert.equal(verdict, 'timeout');
});

// ── 2. TelegramAdapter — callback_query inbound + answer + edit ──────────────────

function makeAdapter(): { adapter: TelegramAdapter; transport: LoopbackTelegramTransport } {
  const transport = new LoopbackTelegramTransport();
  const dir = mkdtempSync(join(tmpdir(), 'perm-btn-'));
  const adapter = new TelegramAdapter({
    transport,
    // Allow the loopback default sender (private DM from u-tester).
    gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['u-tester'], groups: {} } }),
    queueDir: join(dir, 'queue'),
    downloadDir: join(dir, 'dl'),
  });
  return { adapter, transport };
}

test('a callback_query inbound is delivered as an InboundMessage with `callback` (NOT queued)', async () => {
  const { adapter, transport } = makeAdapter();
  const got: InboundMessage[] = [];
  await adapter.start(async (msg) => {
    got.push(msg);
  });
  await transport.injectCallback('perm:allow:ab12', { id: 'cb-1', messageId: '900' });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.callback, { id: 'cb-1', data: 'perm:allow:ab12', messageId: '900' });
  assert.equal(got[0]!.text, undefined, 'a tap carries no text body');
  // It is transient — nothing should be left in the durable inbox queue.
  assert.equal(adapter.health().queueDepth, 0, 'callback taps are not persisted to the queue');
  await adapter.stop();
});

test('adapter answerCallback + editMessage reach the transport', async () => {
  const { adapter, transport } = makeAdapter();
  await adapter.start(async () => undefined);
  await adapter.answerCallback('cb-9', 'Allowed ✅');
  await adapter.editMessage({ to: '555' }, '900', '✅ Allowed');
  assert.deepEqual(transport.answered, [{ callbackId: 'cb-9', text: 'Allowed ✅' }]);
  assert.deepEqual(transport.edited, [{ chatId: '555', messageId: '900', text: '✅ Allowed' }]);
  await adapter.stop();
});

test('outbound msg.options.buttons threads through to the transport send (inlineButtons)', async () => {
  const { adapter, transport } = makeAdapter();
  await adapter.start(async () => undefined);
  await adapter.outbound(
    { to: '555' },
    { text: '🔐 approve?', options: { buttons: [{ text: '✅ Allow', callbackData: 'perm:allow:ab12' }] } },
  );
  const sent = transport.sent.find((s) => s.kind === 'text');
  assert.ok(sent, 'a text message was sent');
  assert.deepEqual(sent!.opts?.inlineButtons, [{ text: '✅ Allow', callbackData: 'perm:allow:ab12' }]);
  await adapter.stop();
});

// ── 3. SessionHost — end-to-end button-tap decision + fallback + restart ─────────

/** A richer send capture that records buttons + answer/edit and returns a stable id. */
function makeHostCapture() {
  const sent: { handle: ReplyHandle; msg: OutboundMessage; messageId: string }[] = [];
  const answered: { callbackId: string; text?: string }[] = [];
  const edited: { handle: ReplyHandle; messageId: string; text: string }[] = [];
  let seq = 9000;
  const waiters: ((s: { handle: ReplyHandle; msg: OutboundMessage; messageId: string }) => void)[] = [];
  const send = async (handle: ReplyHandle, msg: OutboundMessage): Promise<OutboundResult> => {
    const messageId = String(seq++);
    const rec = { handle, msg, messageId };
    sent.push(rec);
    const w = waiters.shift();
    if (w) w(rec);
    return { ok: true, sentIds: [messageId] };
  };
  const answerCallback = async (callbackId: string, text?: string): Promise<void> => {
    answered.push({ callbackId, ...(text !== undefined ? { text } : {}) });
  };
  const editMessage = async (handle: ReplyHandle, messageId: string, text: string): Promise<void> => {
    edited.push({ handle, messageId, text });
  };
  const nextSend = (): Promise<{ handle: ReplyHandle; msg: OutboundMessage; messageId: string }> =>
    new Promise((resolve) => {
      const existing = sent.find((s) => !(s as { _seen?: boolean })._seen);
      if (existing) {
        (existing as { _seen?: boolean })._seen = true;
        resolve(existing);
      } else {
        waiters.push((s) => {
          (s as { _seen?: boolean })._seen = true;
          resolve(s);
        });
      }
    });
  return { sent, answered, edited, send, answerCallback, editMessage, nextSend };
}

const inbound = (text: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-19T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

const callbackInbound = (data: string, id = 'cb-1', messageId?: string): InboundMessage => ({
  attachments: [],
  callback: { id, data, ...(messageId ? { messageId } : {}) },
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-19T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});

/** A program that idles, asks for a gated tool, then ends after the decision. */
function permissionProgram(toolName: string, record: (d: PermissionDecision) => void): FakeSessionDriver {
  return new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName, input: { command: 'ls' }, record },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
}

test('SessionHost: a button tap "allow" resolves the pending decision + ACKs + edits the prompt', async () => {
  const bus = new IoBus();
  const cap = makeHostCapture();
  let decision: PermissionDecision | undefined;
  const driver = permissionProgram('Bash', (d) => (decision = d));
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('please run ls'));

  // The prompt arrives WITH buttons; grab its message id + the button code.
  const prompt = await cap.nextSend();
  assert.match(prompt.msg.text!, /Approve tool 'Bash'/);
  const buttons = prompt.msg.options?.buttons;
  assert.ok(buttons && buttons.length === 2, 'prompt carries the two inline buttons');
  const allowCb = ChannelPermission.parseCallbackData(buttons![0]!.callbackData)!;
  assert.ok(!decision, 'blocked until the tap');

  // The user TAPS ✅ Allow → arrives as a callback inbound.
  await host.handleInbound(callbackInbound(`perm:allow:${allowCb.code}`, 'cb-tap', prompt.messageId));
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(decision, 'decision resolved by the tap');
  assert.equal((decision as PermissionDecision).behavior, 'allow');
  // The tap was ACK'd (spinner dismissed) with an outcome toast.
  assert.equal(cap.answered.length, 1);
  assert.equal(cap.answered[0]!.callbackId, 'cb-tap');
  assert.match(cap.answered[0]!.text!, /Allowed/);
  // The prompt message was edited to its outcome (buttons gone).
  assert.equal(cap.edited.length, 1);
  assert.equal(cap.edited[0]!.messageId, prompt.messageId);
  assert.match(cap.edited[0]!.text, /Allowed/);
  await host.stop();
  bus.close();
});

test('SessionHost: a button tap "deny" denies the tool', async () => {
  const bus = new IoBus();
  const cap = makeHostCapture();
  let decision: PermissionDecision | undefined;
  const driver = permissionProgram('Write', (d) => (decision = d));
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
  await host.handleInbound(inbound('write a file'));
  const prompt = await cap.nextSend();
  const code = ChannelPermission.parseCallbackData(prompt.msg.options!.buttons![0]!.callbackData)!.code;
  await host.handleInbound(callbackInbound(`perm:deny:${code}`, 'cb-d', prompt.messageId));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((decision as PermissionDecision).behavior, 'deny');
  assert.match(cap.answered[0]!.text!, /Denied/);
  await host.stop();
  bus.close();
});

test('SessionHost: a WRONG/stale button code is ignored (decision stays pending) but is ACK’d', async () => {
  const bus = new IoBus();
  const cap = makeHostCapture();
  // Use an ARRAY (not a single mutable var) so a `decisions.length` check doesn't
  // assertion-narrow a captured variable to never (node:test assert.ok is a TS
  // assertion fn → it would narrow a `let decision` for the rest of the scope).
  const decisions: PermissionDecision[] = [];
  const driver = permissionProgram('Bash', (d) => decisions.push(d));
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
  const realPrompt = await cap.nextSend(); // the real prompt (with the real code)
  const realCode = ChannelPermission.parseCallbackData(realPrompt.msg.options!.buttons![0]!.callbackData)!.code;

  // Tap a button carrying a code that does NOT match any pending ask.
  await host.handleInbound(callbackInbound('perm:allow:dead', 'cb-stale'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decisions.length, 0, 'a stale code must NOT resolve the pending decision');
  // It is still ACK'd (so the client spinner clears) — with a "no longer pending" toast.
  assert.equal(cap.answered.length, 1);
  assert.equal(cap.answered[0]!.callbackId, 'cb-stale');
  assert.equal(cap.edited.length, 0, 'no prompt edited for a stale tap');

  // Resolve the REAL pending ask so the driver completes (no hung promise at teardown).
  await host.handleInbound(callbackInbound(`perm:allow:${realCode}`, 'cb-real', realPrompt.messageId));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decisions[0]?.behavior, 'allow', 'the real code then resolves it');
  await host.stop();
  bus.close();
});

test('SessionHost: the TEXT fallback ("allow <code>") still resolves (buttons are additive)', async () => {
  const bus = new IoBus();
  const cap = makeHostCapture();
  let decision: PermissionDecision | undefined;
  const driver = permissionProgram('Bash', (d) => (decision = d));
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
  const prompt = await cap.nextSend();
  // The prompt TEXT still spells out the typed fallback.
  const m = /allow ([0-9a-f]{4})/.exec(prompt.msg.text!);
  assert.ok(m, 'prompt text still carries the allow <code> fallback');
  // Reply by TYPING (not tapping).
  await host.handleInbound(inbound(`allow ${m![1]}`));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((decision as PermissionDecision).behavior, 'allow', 'typed fallback resolves');
  assert.equal(cap.answered.length, 0, 'no callback ACK for a typed reply');
  await host.stop();
  bus.close();
});

test('SessionHost: the lifecycle restart-confirmation prompt ALSO carries inline buttons', async () => {
  const bus = new IoBus();
  const cap = makeHostCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } },
      { do: 'silence' },
    ],
    // a fresh program for the restartFresh() the approval triggers
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } }, { do: 'silence' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    answerCallback: cap.answerCallback,
    editMessage: cap.editMessage,
    policy: { allow: ['Read'], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  // Bind an operator first (a restart needs one to confirm with).
  await host.handleInbound(inbound('hello'));
  await cap.nextSend(); // the turn result 'ok'

  // The hosted agent requests a restart → the supervisor confirms with the user.
  const outcome = host.requestRestart('context bloated');
  assert.equal(outcome.status, 'queued');

  // The confirm flow sends a context line then the approve/deny PROMPT — find the
  // one carrying inline buttons (the askUser prompt). Drain sends until we see it.
  let buttonsPrompt: { msg: OutboundMessage; messageId: string } | undefined;
  for (let i = 0; i < 5 && !buttonsPrompt; i++) {
    const s = await cap.nextSend();
    if (s.msg.options?.buttons && s.msg.options.buttons.length === 2) buttonsPrompt = s;
  }
  assert.ok(buttonsPrompt, 'the restart confirmation prompt carries ✅/❌ buttons');
  const cb = ChannelPermission.parseCallbackData(buttonsPrompt!.msg.options!.buttons![0]!.callbackData);
  assert.ok(cb && cb.verdict === 'allow', 'restart buttons use the same perm: callback scheme');
  // Tap ✅ to approve → the restart proceeds (a second program starts).
  await host.handleInbound(callbackInbound(`perm:allow:${cb!.code}`, 'cb-restart', buttonsPrompt!.messageId));
  await new Promise((r) => setTimeout(r, 30));
  assert.match(cap.answered.at(-1)!.text!, /Allowed/);
  await host.stop();
  bus.close();
});
