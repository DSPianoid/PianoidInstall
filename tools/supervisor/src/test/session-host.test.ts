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

// ── Phase 3a: profile wiring (de-dup + bootstrap turns) ──────────────────────

const REPLY_TOOL = 'mcp__supervisor_channel__reply';

test('per-turn de-dup: a turn that CALLS the reply tool → final text NOT auto-out (one out, no double)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      // The session calls the reply tool (its deliberate channel-out)…
      { do: 'emit', event: { kind: 'assistant', text: '', toolUses: [{ id: 't1', name: REPLY_TOOL, input: {} }] } },
      // …then a final result with text. With the reply tool fired this turn, the
      // result text must be SUPPRESSED (the reply tool already sent the message).
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'duplicate of the reply' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    replyToolName: REPLY_TOOL, // orchestrator profile
  });
  await host.start();
  await host.handleInbound(inbound('go'));
  await new Promise((r) => setTimeout(r, 30));
  // The reply tool's own send happens via the tool handler (not captured here);
  // the key assertion is the supervisor did NOT auto-out the result text (no double).
  assert.ok(!cap.sent.some((s) => s.text === 'duplicate of the reply'), 'result text NOT auto-sent when reply tool fired');
  await host.stop();
  bus.close();
});

test('per-turn de-dup: a turn that only PRODUCES TEXT (no reply tool) → that text auto-outs', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      // The session answers in PLAIN text — no reply-tool call this turn.
      { do: 'emit', event: { kind: 'assistant', text: 'here is my direct answer', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'here is my direct answer' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    replyToolName: REPLY_TOOL, // orchestrator profile — but the tool wasn't used this turn
  });
  await host.start();
  await host.handleInbound(inbound('describe your environment'));
  await new Promise((r) => setTimeout(r, 30));
  // The answer reached the user via auto-out (the live bug: this was silenced).
  assert.ok(cap.sent.some((s) => s.text === 'here is my direct answer'), 'plain-text answer auto-out when no reply tool');
  await host.stop();
  bus.close();
});

test('demo (no replyToolName): assistant text IS auto-sent each turn', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'assistant', text: 'hi there', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: '' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    // replyToolName omitted → demo behavior: assistant text auto-sent.
  });
  await host.start();
  await host.handleInbound(inbound('go'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(cap.sent.some((s) => s.text === 'hi there'), 'assistant text auto-sent in demo mode');
  await host.stop();
  bus.close();
});

test('★ send-side idempotency: a SAME-TURN byte-identical duplicate outbound is suppressed (the stale-resend / doubling bug)', async () => {
  // THE seq-221 self-diagnosis #1 fix. The PTY render race could emit the prior turn's
  // answer a SECOND time (a duplicate result event, or currentAnswerText() re-grabbing
  // the stale scrollback block) → the user saw a DOUBLE / a stale resend. The send-side
  // guard suppresses an outbound byte-identical to the one already delivered THIS turn —
  // independent of any render-side fix. Modeled here as two identical `result` events in
  // ONE turn (no intervening user inbound): exactly ONE reaches the channel.
  const bus = new IoBus();
  const cap = makeSendCapture();
  const dup = 'Here is the full environment description (2807 chars worth).';
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      // First result for this turn → forwarded.
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: dup } },
      // A SECOND, byte-identical result for the SAME turn (the duplicate/stale-resend) →
      // must be SUPPRESSED by the send-side guard (no intervening user turn reset it).
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: dup } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    replyToolName: REPLY_TOOL, // orchestrator profile → onResult auto-outs the final text
  });
  await host.start();
  await host.handleInbound(inbound('describe your environment'));
  await new Promise((r) => setTimeout(r, 40));
  const copies = cap.sent.filter((s) => s.text === dup);
  assert.equal(copies.length, 1, `the duplicate outbound was suppressed — exactly ONE copy reached the channel (got ${copies.length})`);
  await host.stop();
  bus.close();
});

test('★ send-side idempotency: a LEGITIMATELY-identical answer to a DIFFERENT user turn STILL goes through (guard is per-turn)', async () => {
  // The guard must NOT swallow a real repeat: if the user asks the same thing twice (two
  // DISTINCT user turns), each identical answer is delivered. handleInbound resets the
  // last-sent baseline on every new turn, so only a SAME-TURN duplicate is dropped.
  const bus = new IoBus();
  const cap = makeSendCapture();
  const same = 'Yes.';
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: same } },
      { do: 'awaitTurn' }, // a SECOND, distinct user turn
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: same } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    replyToolName: REPLY_TOOL,
  });
  await host.start();
  await host.handleInbound(inbound('are you there?'));
  await new Promise((r) => setTimeout(r, 30));
  await host.handleInbound(inbound('are you there?')); // same question again → same answer
  await new Promise((r) => setTimeout(r, 30));
  const copies = cap.sent.filter((s) => s.text === same);
  assert.equal(copies.length, 2, `both identical answers to two DISTINCT turns were delivered (got ${copies.length})`);
  await host.stop();
  bus.close();
});

test('roleTurnPrefix is applied to the FIRST user turn, not a pre-user bootstrap (live fix)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'awaitTurn' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    roleTurnPrefix: '/orchestrator',
  });
  await host.start();
  await new Promise((r) => setTimeout(r, 20));
  // CRITICAL: no pre-user bootstrap turn was injected (the bug we fixed). The
  // driver has NOT been sent anything until the user messages.
  assert.equal(driver.sentTurns.length, 0, 'no pre-user role turn');
  assert.equal(driver.startOpts[0]?.bootstrapTurns, undefined, 'no lifecycle bootstrap turns');

  // The FIRST real user turn carries the role prefix prepended.
  await host.handleInbound(inbound('please do task X'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns.length, 1);
  assert.match(driver.sentTurns[0]!.text, /^\/orchestrator\n\nplease do task X$/);

  // A SECOND user turn does NOT get the prefix again (one-shot).
  await host.handleInbound(inbound('and task Y'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns[1]!.text, 'and task Y', 'prefix applied only once');
  await host.stop();
  bus.close();
});
