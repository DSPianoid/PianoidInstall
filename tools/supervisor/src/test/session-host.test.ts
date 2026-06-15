/**
 * SessionHost end-to-end tests (FakeSessionDriver + a fake channel send) — the
 * FC-1 acceptance: a gated tool the session wants to run is ROUTED to the user
 * over the channel and BLOCKS until the user's reply; plus inbound→user-turn and
 * assistant/result→outbound.
 *
 * No SDK, no subprocess, no network — the whole Phase-2 path proven deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHost } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { ChannelPermission } from '../channel-permission.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult, ReplyHandle } from '../contract.js';
import type { PermissionDecision } from '../session-driver.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const inbound = (text: string, who?: { user?: string; userId?: string; to?: string }): InboundMessage => ({
  text,
  attachments: [],
  user: who?.user ?? 'tester',
  userId: who?.userId ?? 'u-tester',
  ts: '2026-06-15T00:00:00Z',
  replyHandle: { to: who?.to ?? '555' },
  channel: 'telegram',
});

/** Captures outbound sends; lets the test await the next one. */
function makeSendCapture() {
  const sent: { handle: ReplyHandle; text: string }[] = [];
  const waiters: ((s: { handle: ReplyHandle; text: string }) => void)[] = [];
  const send = async (handle: ReplyHandle, msg: { text?: string }): Promise<OutboundResult> => {
    const rec = { handle, text: msg.text ?? '' };
    sent.push(rec);
    const w = waiters.shift();
    if (w) w(rec);
    return { ok: true, sentIds: ['1'] };
  };
  const nextSend = (): Promise<{ handle: ReplyHandle; text: string }> =>
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
  return { sent, send, nextSend };
}

test('inbound text → injected as a session user turn', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
  });
  await host.start();
  await host.handleInbound(inbound('hello session'));
  assert.equal(driver.sentTurns.length, 1);
  assert.equal(driver.sentTurns[0]!.text, 'hello session');
  await host.stop();
  bus.close();
});

test('FC-1: a gated tool is ROUTED to the user and the session BLOCKS until the reply', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let decision: PermissionDecision | undefined;
  // The session asks to use 'Bash' (NOT on the allow-list → must route to user).
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // idle until the user's first inbound
      {
        do: 'permission',
        toolName: 'Bash',
        input: { command: 'ls' },
        record: (d) => {
          decision = d;
        },
      },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'listed' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();

  // First inbound establishes the operator AND kicks the session (which then asks
  // for Bash permission → a prompt is sent out).
  await host.handleInbound(inbound('please run ls'));

  // The permission prompt should arrive over the channel.
  const prompt = await cap.nextSend();
  assert.match(prompt.text, /Approve tool 'Bash'/);
  const m = /allow ([0-9a-f]{4})/.exec(prompt.text);
  assert.ok(m, 'prompt carries an allow <code>');

  // Until we reply, the decision is unresolved (the session is blocked on us).
  assert.equal(decision === undefined, true, 'session blocked awaiting the user reply');

  // The user replies "allow <code>" — delivered as a normal inbound.
  await host.handleInbound(inbound(`allow ${m![1]}`));
  // Give the driver generator a tick to resume past the await.
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(decision, 'decision resolved after the reply');
  assert.equal((decision as PermissionDecision).behavior, 'allow', 'user-approved → allow');
  // The session result text was sent back to the operator.
  const texts = cap.sent.map((s) => s.text);
  assert.ok(texts.includes('listed'), 'session result echoed back to the operator');
  await host.stop();
  bus.close();
});

test('FC-1: user DENY → the tool is denied', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Bash', record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({ driver, bus, logger: silentLogger(), send: cap.send, policy: { allow: [] } });
  await host.start();
  await host.handleInbound(inbound('run something'));
  const prompt = await cap.nextSend();
  const code = /allow ([0-9a-f]{4})/.exec(prompt.text)![1]!;
  await host.handleInbound(inbound(`deny ${code}`));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decision!.behavior, 'deny');
  await host.stop();
  bus.close();
});

test('an allow-listed tool is NOT routed (no prompt sent)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Read', record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({ driver, bus, logger: silentLogger(), send: cap.send, policy: { allow: ['Read'] } });
  await host.start();
  await host.handleInbound(inbound('read a file'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decision!.behavior, 'allow', 'allow-listed → allowed');
  // No permission prompt should have been sent (only possibly the result text).
  assert.ok(!cap.sent.some((s) => /Approve tool/.test(s.text)), 'no permission prompt for an allow-listed tool');
  await host.stop();
  bus.close();
});

// ── H1 ────────────────────────────────────────────────────────────────────────

test('H1: a BARE "deny" (no code) resolves the single pending prompt (the demo UX gap)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Write', record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: [], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('write a file')); // kicks the session → Write prompt routed
  const prompt = await cap.nextSend();
  assert.match(prompt.text, /Approve tool 'Write'/);
  assert.equal(decision === undefined, true, 'blocked awaiting reply');

  // The exact demo input: a bare "Deny" with NO code.
  await host.handleInbound(inbound('Deny'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(decision, 'bare reply resolved the pending prompt');
  assert.equal((decision as PermissionDecision).behavior, 'deny', 'bare "Deny" → deny');
  await host.stop();
  bus.close();
});

test('H1: a reply from a DIFFERENT user is ignored (not consumed, not injected)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let decision: PermissionDecision | undefined;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'permission', toolName: 'Write', record: (d) => (decision = d) },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: [], fallback: 'route' },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  // Operator = the first user (u-tester). They trigger the Write prompt.
  await host.handleInbound(inbound('write a file', { user: 'op', userId: 'u-tester' }));
  const prompt = await cap.nextSend();
  const code = /allow ([0-9a-f]{4})/.exec(prompt.text)![1]!;

  // A DIFFERENT user tries to answer (both bare and coded) — must be IGNORED.
  await host.handleInbound(inbound('allow', { user: 'intruder', userId: 'u-evil' }));
  await host.handleInbound(inbound(`allow ${code}`, { user: 'intruder', userId: 'u-evil' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decision === undefined, true, 'a non-operator cannot resolve the operator’s prompt');
  assert.equal(driver.sentTurns.length, 1, 'the intruder’s messages were NOT injected as turns either');

  // The real operator’s bare deny resolves it.
  await host.handleInbound(inbound('deny', { user: 'op', userId: 'u-tester' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decision!.behavior, 'deny', 'the bound operator can answer');
  await host.stop();
  bus.close();
});
