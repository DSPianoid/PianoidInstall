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
import { IoBus, type BusEvent } from '../io-bus.js';
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
  // ★ MODE-AWARENESS (dev-6ca1): the FIRST turn carries the user message FIRST, then a
  // one-shot current-output-mode notice appended (so a restarted orchestrator knows the mode).
  assert.ok(driver.sentTurns[0]!.text.startsWith('hello session'), 'the user message leads the first turn');
  assert.match(driver.sentTurns[0]!.text, /\[SUPERVISOR output-mode\] The current output mode is: text/);
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

// ── FIX A (2026-06-18): the user-facing "still working…" heartbeat is REMOVED ──
test('★ FIX A: a LONG turn with mid-turn activity emits NO "still working…" message (heartbeat removed)', async () => {
  // Previously a long turn drove a throttled "still working…" ping. That flooded the channel
  // (and fired while idle) → removed. Mid-turn activity is now ONLY the internal liveness belt.
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'assistant', text: '', toolUses: [{ id: 't1', name: 'Bash', input: {} }] } },
      { do: 'delay', ms: 60 },
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 't1', content: 'ok' } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'final answer' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read', 'Bash'] },
    replyToolName: REPLY_TOOL, // orchestrator profile
    pingResponseTimeoutMs: 60, // liveness on — but the belt must not emit a user message
  });
  await host.start();
  await host.handleInbound(inbound('do a long task'));
  await new Promise((r) => setTimeout(r, 140));
  // ★ NO "still working" message to the channel — at all.
  assert.ok(!cap.sent.some((s) => /still working/i.test(s.text)), 'no "still working…" heartbeat sent');
  // the substantive answer still arrives.
  assert.ok(cap.sent.some((s) => s.text === 'final answer'), 'the final answer still arrived');
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
  // role prefix THEN the user message lead the first turn (the ★ MODE-AWARENESS one-shot
  // mode notice is appended after, dev-6ca1 — assert the lead + the notice, not a $ anchor).
  assert.match(driver.sentTurns[0]!.text, /^\/orchestrator\n\nplease do task X/);
  assert.match(driver.sentTurns[0]!.text, /\[SUPERVISOR output-mode\] The current output mode is: text/);

  // A SECOND user turn does NOT get the prefix again (one-shot).
  await host.handleInbound(inbound('and task Y'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns[1]!.text, 'and task Y', 'prefix applied only once');
  await host.stop();
  bus.close();
});

// ── FORWARD ALL OUTPUT (item iii — the user's "catch every error/output" objective) ──
test('★ forwardToolActivity: tool CALLS (incl. Agent/SendMessage) + tool ERRORS reach the channel; non-error results do NOT (default)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      // the orchestrator spawns a sub-agent + messages a teammate (the coordination the user wants to SEE)
      { do: 'emit', event: { kind: 'assistant', text: '', toolUses: [
        { id: 'a1', name: 'Agent', input: { description: 'fix the bug', subagent_type: 'dev' } },
        { id: 's1', name: 'SendMessage', input: { message: 'start on task 1' } },
      ] } },
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 'a1', content: 'spawned', isError: false } }, // non-error → NOT forwarded by default
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 's1', content: 'connection refused', isError: true } }, // error → ALWAYS forwarded
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Agent', 'SendMessage'] },
    forwardToolActivity: true, // orchestrator profile
  });
  await host.start();
  await host.handleInbound(inbound('do the work'));
  await new Promise((r) => setTimeout(r, 40));
  const texts = cap.sent.map((s) => s.text).join('\n');
  assert.ok(texts.includes('Agent'), 'sub-agent spawn forwarded');
  assert.ok(texts.includes('fix the bug'), 'spawn hint forwarded');
  assert.ok(texts.includes('SendMessage'), 'teammate message forwarded');
  assert.ok(/tool error/i.test(texts) && texts.includes('connection refused'), 'tool ERROR forwarded');
  assert.ok(!texts.includes('spawned'), 'non-error tool result NOT forwarded by default');
  await host.stop();
  bus.close();
});

test('forwardToolActivity OFF (demo) → no tool activity reaches the channel', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'assistant', text: 'hi', toolUses: [{ id: 'b1', name: 'Bash', input: { command: 'ls' } }] } },
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 'b1', content: 'boom', isError: true } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: '' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Bash'] },
    // forwardToolActivity omitted → off
  });
  await host.start();
  await host.handleInbound(inbound('go'));
  await new Promise((r) => setTimeout(r, 40));
  const texts = cap.sent.map((s) => s.text).join('\n');
  assert.ok(!/tool error/i.test(texts) && !texts.includes('⚙️'), 'no tool activity forwarded when off');
  assert.ok(texts.includes('hi'), 'assistant text still auto-sent (demo)');
  await host.stop();
  bus.close();
});

// ── D1: /channel-check interceptor ──
test('★ D1: /channel-check is INTERCEPTED (not typed) → injects a diagnostic turn referencing the panel', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // the first turn (binds operator) — a real one
      { do: 'awaitTurn' }, // the /channel-check diagnostic turn
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Bash'] },
    panelUrl: 'http://127.0.0.1:8790',
  });
  await host.start();
  await host.handleInbound(inbound('hello')); // turn 1 (binds operator)
  await new Promise((r) => setTimeout(r, 15));
  await host.handleInbound(inbound('/channel-check')); // should be intercepted
  await new Promise((r) => setTimeout(r, 15));
  // the LITERAL '/channel-check' was NOT sent as a turn; a crafted diagnostic was
  assert.ok(!driver.sentTurns.some((t) => t.text.trim() === '/channel-check'), 'literal /channel-check not typed');
  const diag = driver.sentTurns.find((t) => /\[SUPERVISOR \/channel-check\]/.test(t.text));
  assert.ok(diag, 'diagnostic turn injected');
  assert.ok(diag!.text.includes('http://127.0.0.1:8790/api/channel/state'), 'panel state endpoint referenced');
  assert.ok(diag!.text.includes('/api/channel/reconnect'), 'repair endpoint referenced');
  await host.stop();
  bus.close();
});

// ── F1: delivery-failure feedback ──
test('★ F1: a FAILED outbound feeds a [SUPERVISOR delivery-status] note back into the session', async () => {
  const bus = new IoBus();
  // a send that FAILS
  const sentTexts: string[] = [];
  const send = async (_h: ReplyHandle, msg: { text?: string }): Promise<OutboundResult> => {
    sentTexts.push(msg.text ?? '');
    return { ok: false, sentIds: [], error: 'bot blocked' };
  };
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'assistant', text: 'my answer', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'my answer' } },
      { do: 'awaitTurn' }, // the F1 feedback note injected as a follow-up turn
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send,
    policy: { allow: ['Read'] },
    panelUrl: 'http://127.0.0.1:8790',
  });
  await host.start();
  await host.handleInbound(inbound('question'));
  await new Promise((r) => setTimeout(r, 30));
  // the orchestrator's answer failed to send → a delivery-status note was injected
  const note = driver.sentTurns.find((t) => /\[SUPERVISOR delivery-status\]/.test(t.text));
  assert.ok(note, 'delivery-status feedback turn injected');
  assert.ok(note!.text.includes('did NOT reach the user'), 'note states non-delivery');
  assert.ok(note!.text.includes('bot blocked'), 'note carries the error');
  await host.stop();
  bus.close();
});

test('★★ M3: a SUSTAINED outage (multiple failed turns) yields ONE delivery-status notice, not one per turn', async () => {
  const bus = new IoBus();
  let failCount = 0;
  const send = async (_h: ReplyHandle, msg: { text?: string }): Promise<OutboundResult> => {
    failCount++;
    return { ok: false, sentIds: [], error: 'outage' };
  };
  // Two user turns, each producing an answer that FAILS to send → without the cooldown
  // each would inject its own delivery-status note (the per-turn cascade).
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'assistant', text: 'answer 1', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'answer 1' } },
      { do: 'awaitTurn' }, // the (sole) delivery-status note's turn
      { do: 'awaitTurn' }, // user turn 2
      { do: 'emit', event: { kind: 'assistant', text: 'answer 2', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'answer 2' } },
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send,
    policy: { allow: ['Read'] },
    panelUrl: 'http://127.0.0.1:8790',
  });
  await host.start();
  await host.handleInbound(inbound('q1'));
  await new Promise((r) => setTimeout(r, 30));
  await host.handleInbound(inbound('q2'));
  await new Promise((r) => setTimeout(r, 30));
  // Both answers failed to send, but only ONE delivery-status note was injected (cooldown).
  const notes = driver.sentTurns.filter((t) => /\[SUPERVISOR delivery-status\]/.test(t.text));
  assert.equal(notes.length, 1, 'exactly one outage notice despite multiple failed turns');
  await host.stop();
  bus.close();
});

// ── D4: IDLE-AWARE ping/pong liveness ──
test('★ D4: IDLE + ping ANSWERED in time → alive (onUnresponsive NOT called)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1 (binds operator)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // turn 1 COMPLETES → IDLE
      { do: 'awaitTurn' }, // the ping turn
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'alive' } }, // the PONG
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 80,
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // turn 1 completes → idle
  const armed = await host.pingLiveness();
  assert.equal(armed, true, 'ping armed (orchestrator was idle)');
  assert.ok(driver.sentTurns.some((t) => /\[SUPERVISOR ping\]/.test(t.text)), 'ping turn injected');
  await new Promise((r) => setTimeout(r, 130)); // > timeout; but the PONG result cleared it
  assert.equal(unresponsive, false, 'answered in time → not unresponsive');
  await host.stop();
  bus.close();
});

test('★ D4: IDLE but UNRESPONSIVE (no pong) → tier-b (onUnresponsive called)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let reason = '';
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1 (binds operator)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // turn 1 COMPLETES → IDLE
      { do: 'awaitTurn' }, // the ping turn — but NO result emitted (hung while idle)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 50,
    onUnresponsive: (r) => { reason = r; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // idle
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 90)); // past the 50ms deadline, no pong
  assert.ok(/no turn result within 50ms/.test(reason) && /idle but unresponsive/.test(reason), 'onUnresponsive fired (idle but unresponsive)');
  await host.stop();
  bus.close();
});

test('★★ D4 SAFETY: a turn IN FLIGHT (long turn / sub-agent wait) → ping SKIPPED, NO restart', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1 — STAYS in flight (no result; e.g. a long turn blocked on a sub-agent)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read', 'Agent'] },
    pingResponseTimeoutMs: 40,
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('do a long thing')); // turn in flight, never completes here
  await new Promise((r) => setTimeout(r, 10));
  const armed = await host.pingLiveness(); // a turn is in flight → MUST skip
  assert.equal(armed, false, 'ping SKIPPED while a turn is in flight');
  assert.ok(!driver.sentTurns.some((t) => /\[SUPERVISOR ping\]/.test(t.text)), 'no ping turn injected mid-work');
  await new Promise((r) => setTimeout(r, 80)); // well past the 40ms deadline
  assert.equal(unresponsive, false, '★ a busy/long turn is NEVER false-restarted');
  await host.stop();
  bus.close();
});

test('★★ D4 SAFETY: mid-turn PROGRESS clears an armed deadline (no false restart if a turn starts after a ping)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  // idle first (turn 1 completes), arm a ping, THEN a turn produces progress → clears the deadline.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // → idle
      { do: 'awaitTurn' }, // the ping turn
      { do: 'emit', event: { kind: 'assistant', text: 'working on it', toolUses: [{ id: 't1', name: 'Bash', input: {} }] } }, // PROGRESS (no result yet)
      // deliberately NO result — only progress; the progress must clear the deadline
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read', 'Bash'] },
    pingResponseTimeoutMs: 60,
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // idle
  await host.pingLiveness(); // arms the 60ms deadline + injects the ping turn
  await new Promise((r) => setTimeout(r, 100)); // > 60ms, but the assistant PROGRESS event cleared it
  assert.equal(unresponsive, false, 'mid-turn progress cleared the deadline → no false restart');
  await host.stop();
  bus.close();
});

test('★★ FIX A: the liveness ping turn + its pong are INTERNAL — NEITHER reaches the user channel', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1 (binds operator)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'hi back' } }, // → idle (forwarded)
      { do: 'awaitTurn' }, // the INTERNAL ping turn
      { do: 'emit', event: { kind: 'assistant', text: 'Alive ✓', toolUses: [] } }, // the pong assistant text — MUST NOT forward
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'Alive ✓' } }, // the pong result — MUST NOT forward
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 80,
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // turn 1 done → idle
  await host.pingLiveness();
  await new Promise((r) => setTimeout(r, 40)); // the pong arrives
  // The user saw turn 1's answer, but NOTHING from the liveness exchange.
  assert.ok(cap.sent.some((s) => s.text === 'hi back'), 'turn 1 answer reached the user');
  assert.ok(!cap.sent.some((s) => /Alive/.test(s.text)), 'the pong was NOT forwarded');
  assert.ok(!cap.sent.some((s) => /SUPERVISOR ping/.test(s.text)), 'the ping prompt was NOT forwarded');
  await host.stop();
  bus.close();
});

// ── ★ D4 FALSE-POSITIVE FIX: a real, in-progress turn must NEVER trigger tier-b ──
// (regression guard for the always-on liveness path that false-restarted the hosted
//  orchestrator 4× on 2026-06-20 — a legitimately long / just-started real turn was
//  misread as "unresponsive". The deadline default is now 180s + the in-flight race is closed.)

test('★ D4 FALSE-POSITIVE: a real turn running PAST the deadline is NOT restarted (the long-Opus-turn case)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  // turn 1 completes → idle; arm a ping; then a SECOND real turn starts and STAYS in flight
  // (a long >deadline turn). The ping deadline elapses while that real turn is running → must NOT tier-b.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1 (binds operator)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // → idle
      { do: 'awaitTurn' }, // the ping turn (injected by pingLiveness)
      { do: 'awaitTurn' }, // turn 2 — a long real turn; STAYS in flight (no result here)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 40, // short, for the test (stands in for 60–180s on the live host)
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // turn 1 completes → idle
  await host.pingLiveness(); // arms the 40ms deadline + injects the ping turn (idle)
  // BEFORE the deadline elapses, a real long turn begins (the "just-started / legitimately long" case):
  await host.handleInbound(inbound('do a long /dev build'));
  await new Promise((r) => setTimeout(r, 90)); // well past the 40ms ping deadline; turn 2 still running
  assert.equal(unresponsive, false, '★ a real in-progress turn is NEVER false-restarted by the ping deadline');
  await host.stop();
  bus.close();
});

test('★ D4 FALSE-POSITIVE: a real turn STARTING clears the armed ping deadline (onRealTurnStarted)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  // idle → arm a ping → a real turn arrives. The armed deadline is gone (cleared at the inbound→inject
  // seam by onRealTurnStarted), so no tier-b fires even though the ping itself is never answered.
  // Sequence the results so the FIFO internal-turn queue stays aligned: the PING result (internal,
  // not forwarded) is emitted first, THEN turn 2's result (real, forwarded) — proving the orchestrator
  // kept working (was not restarted).
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // → idle
      { do: 'awaitTurn' }, // the ping turn (internal) — injected by pingLiveness
      { do: 'awaitTurn' }, // turn 2 (the real turn that clears the deadline)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'pong' } }, // ping pong (internal, FIFO head)
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'turn2 done' } }, // turn 2 (forwarded)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 50,
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 20)); // idle
  await host.pingLiveness(); // arms the 50ms deadline
  await host.handleInbound(inbound('real work')); // → onRealTurnStarted clears the armed deadline
  await new Promise((r) => setTimeout(r, 90)); // past the 50ms deadline
  assert.equal(unresponsive, false, 'the armed deadline was cleared when the real turn started → no false restart');
  assert.ok(cap.sent.some((s) => s.text === 'turn2 done'), 'the real turn ran to completion (orchestrator not restarted)');
  assert.ok(!cap.sent.some((s) => s.text === 'pong'), 'the internal ping pong was NOT forwarded');
  await host.stop();
  bus.close();
});

test('★ D4 FALSE-POSITIVE: a real turn arriving AFTER a ping is armed but BEFORE its deadline → no tier-b (the 4×-on-2026-06-20 race)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  let unresponsive = false;
  // This is the exact shape of the production false-positive: the orchestrator was briefly idle, a ping
  // armed its deadline, then a real (long) turn started and was still running when the deadline elapsed.
  // The fix closes it two ways — onRealTurnStarted clears the armed deadline at the inject seam, AND the
  // timeout callback re-validates against lastRealTurnStartedAt >= pingScheduledAt — so either way the
  // in-progress real turn is never restarted. The ping itself is left unanswered to prove the deadline
  // path is the one under test.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'ok' } }, // → idle
      { do: 'awaitTurn' }, // the ping turn (unanswered)
      { do: 'awaitTurn' }, // turn 2 — a real turn, in flight when the deadline fires
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    pingResponseTimeoutMs: 30,
    onUnresponsive: () => { unresponsive = true; },
  });
  await host.start();
  await host.handleInbound(inbound('hi'));
  await new Promise((r) => setTimeout(r, 15)); // idle
  await host.pingLiveness(); // stamps pingScheduledAt + arms the 30ms deadline
  await host.handleInbound(inbound('a real turn after the ping')); // starts after the ping was scheduled
  await new Promise((r) => setTimeout(r, 80)); // past the 30ms deadline; ping never answered
  assert.equal(unresponsive, false, '★ a real turn that started after the ping was scheduled → NEVER a tier-b restart');
  await host.stop();
  bus.close();
});

// ── FIX B: hosted-agent lifecycle restart control (request → user-confirm → execute) ──
function collectEvents(bus: IoBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}
const lifecycleEvents = (events: BusEvent[]): string[] =>
  events.filter((e) => e.type === 'lifecycle').map((e) => (e.payload as { event?: string }).event ?? '');

/** Poll the capture until a sent message matches `re` (the restart confirm prompt
 * arrives out-of-band after the context line — so a fixed nextSend() ordering is
 * brittle). Returns the matching code, or throws after the budget. */
async function waitForRestartCode(cap: { sent: { text: string }[] }): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const prompt = cap.sent.find((s) => /Approve tool 'lifecycle\.restart'/.test(s.text));
    const m = prompt && /allow ([0-9a-f]{4})/.exec(prompt.text);
    if (m) return m[1]!;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('restart approval prompt never arrived');
}

test('★★ FIX B: agent requests a restart → user APPROVES → FRESH session (restarts:1, new id, channel preserved, handoff injected)', async () => {
  const bus = new IoBus();
  const events = collectEvents(bus);
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    // Run 1 — the live session before the restart (binds operator, then idle).
    // (Two awaitTurns: the establishing inbound consumes the first; the second PARKS the
    //  session idle so it is still live when restartFresh tears it down — a single trailing
    //  awaitTurn would let the generator END after the inbound = a spurious crash-resume.)
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // establishing inbound (binds operator + channelPermission)
      { do: 'awaitTurn' }, // park idle (released only by restartFresh's driver.stop())
    ],
    // Run 2 — the FRESH session after restartFresh (different id), accepts the handoff turn
    // then parks idle (same reason as run 1).
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } },
      { do: 'awaitTurn' }, // the injected handoff first-turn
      { do: 'awaitTurn' }, // park idle
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    permissionTimeoutMs: 5000,
    roleTurnPrefix: '/orchestrator',
  });
  await host.start();
  await host.handleInbound(inbound('hello')); // binds the operator
  await new Promise((r) => setTimeout(r, 20));

  // The agent asks to restart (the loopback the panel exposes).
  const outcome = host.requestRestart('context is bloated', 'we were mid-way through task 42');
  assert.equal(outcome.status, 'queued', 'request accepted (queued; confirm is out-of-band)');

  // A context line + the approve/deny prompt are sent to the user (out-of-band).
  const code = await waitForRestartCode(cap);
  assert.ok(cap.sent.some((s) => /requests a FULL RESTART/.test(s.text)), 'user got the restart context line');

  // The user approves.
  await host.handleInbound(inbound(`allow ${code}`));
  await new Promise((r) => setTimeout(r, 40)); // let the restart + handoff run

  // A FRESH session is now live: NEW id, restarts incremented (NOT zeroed like /clear).
  assert.equal(driver.starts, 2, 'a fresh session was started');
  assert.equal(host.health().lifecycle.sessionId, 's2', 'now on the fresh session id');
  assert.equal(host.health().lifecycle.restarts, 1, 'restarts incremented to 1 (distinguishes from /clear which zeroes)');
  assert.equal(driver.startOpts[1]?.resume, undefined, 'fresh start does NOT resume (true context reset)');

  // The handoff first-turn carries the role prefix + the restart context + the note.
  const handoff = driver.sentTurns.find((t) => /\[SUPERVISOR lifecycle\] You restarted at your own request/.test(t.text));
  assert.ok(handoff, 'a handoff first-turn was injected into the fresh session');
  assert.ok(handoff!.text.startsWith('/orchestrator'), 'the role is re-bootstrapped on the fresh session');
  assert.ok(handoff!.text.includes('we were mid-way through task 42'), 'the handoff note was carried over');

  // Audit signals + the user-facing "restarted" notice.
  const evs = lifecycleEvents(events);
  assert.ok(evs.includes('lifecycle_restart_requested'), 'requested signal published');
  assert.ok(evs.includes('lifecycle_restart_approved'), 'approved signal published');
  assert.ok(evs.includes('lifecycle_restart_completed'), 'completed signal published');
  assert.ok(cap.sent.some((s) => /has been restarted/.test(s.text)), 'user told the restart happened');
  await host.stop();
  bus.close();
});

test('★★ FIX B: user DENIES the restart → NO teardown (same session), agent told to continue', async () => {
  const bus = new IoBus();
  const events = collectEvents(bus);
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // establishing inbound
      { do: 'awaitTurn' }, // the "denied — continue" follow-up turn
      { do: 'awaitTurn' }, // park idle (NO restart on denial → session must stay live, no crash-resume)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    permissionTimeoutMs: 5000,
    roleTurnPrefix: '/orchestrator',
  });
  await host.start();
  await host.handleInbound(inbound('hello'));
  await new Promise((r) => setTimeout(r, 20));

  host.requestRestart('I feel like a reset');
  const code = await waitForRestartCode(cap);

  // The user DENIES.
  await host.handleInbound(inbound(`deny ${code}`));
  await new Promise((r) => setTimeout(r, 30));

  // NO restart happened: same session id, restarts still 0, only one start.
  assert.equal(driver.starts, 1, 'no fresh session started on denial');
  assert.equal(host.health().lifecycle.sessionId, 's1', 'still on the original session');
  assert.equal(host.health().lifecycle.restarts, 0, 'restarts unchanged on denial');

  // The agent was told it was denied and to continue.
  const note = driver.sentTurns.find((t) => /\[SUPERVISOR lifecycle\] Your restart request was DENIED/.test(t.text));
  assert.ok(note, 'agent notified of the denial');
  assert.ok(/Continue as normal/.test(note!.text), 'agent told to continue');

  const evs = lifecycleEvents(events);
  assert.ok(evs.includes('lifecycle_restart_denied'), 'denied signal published');
  assert.ok(!evs.includes('lifecycle_restart_completed'), 'NO completed signal on denial');
  await host.stop();
  bus.close();
});

test('★★ FIX B: rapid repeated requests are RATE-LIMITED (loop guardrail) → surfaced to the user, not executed', async () => {
  const bus = new IoBus();
  const events = collectEvents(bus);
  const cap = makeSendCapture();
  // Each request is DENIED so the confirm completes (clears restartConfirmInFlight),
  // letting the next request through — the timestamps accumulate to the rate limit.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // establishing inbound
      { do: 'awaitTurn' }, // denial notice 1
      { do: 'awaitTurn' }, // denial notice 2
      { do: 'awaitTurn' }, // denial notice 3
      { do: 'awaitTurn' }, // park idle (no restart ever executes → no crash-resume)
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    permissionTimeoutMs: 5000,
  });
  await host.start();
  await host.handleInbound(inbound('hello'));
  await new Promise((r) => setTimeout(r, 20));

  // Drive 3 request→deny cycles (the in-window allowance is 3).
  for (let i = 0; i < 3; i++) {
    const out = host.requestRestart(`reset attempt ${i}`);
    assert.equal(out.status, 'queued', `request ${i} accepted`);
    // answer the confirm with a DENY (resolves the single pending ask via bare reply)
    await new Promise((r) => setTimeout(r, 10));
    await host.handleInbound(inbound('deny'));
    await new Promise((r) => setTimeout(r, 15));
  }

  // The 4th request within the window is REFUSED outright (loop guardrail).
  const refused = host.requestRestart('reset attempt 4 (the loop)');
  assert.equal(refused.status, 'rate_limited', '4th in-window request is rate-limited');
  assert.ok(typeof (refused as { retryAfterMs?: number }).retryAfterMs === 'number', 'reports a retry-after window');

  // It was NOT executed; the user was warned about the loop.
  assert.equal(driver.starts, 1, 'no restart executed for the rate-limited request');
  assert.ok(cap.sent.some((s) => /requesting restarts too frequently/.test(s.text)), 'user warned about the restart loop');
  const evs = lifecycleEvents(events);
  assert.ok(evs.filter((e) => e === 'lifecycle_restart_denied').length >= 1, 'a denied(rate_limited) signal published');
  await host.stop();
  bus.close();
});

test('★ M-2: an INVOLUNTARY tier-b restart (restartUnresponsive) INCREMENTS restarts (visible in /api/session), unlike clearContext', async () => {
  const bus = new IoBus();
  const events = collectEvents(bus);
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    // Run 1 — live session (binds operator), then parks idle.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // establishing inbound
      { do: 'awaitTurn' }, // park idle until restartUnresponsive tears it down
    ],
    // Run 2 — the FRESH session after the tier-b restart (the role re-bootstraps via the
    // lifecycle's non-resume start; here we just confirm a new id + the counter). ONE
    // awaitTurn: restartUnresponsive injects NO turn, so run 2 parks at this awaitTurn —
    // host.stop() then releases it cleanly (no crash-resume; stop() sets `stopping`).
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's2', model: 'm' } },
      { do: 'awaitTurn' },
    ],
  ]);
  const host = new SessionHost({
    driver, bus, logger: silentLogger(), send: cap.send,
    policy: { allow: ['Read'] },
    roleTurnPrefix: '/orchestrator',
  });
  await host.start();
  await host.handleInbound(inbound('hello'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.health().lifecycle.restarts, 0, 'starts at 0');

  // D4 tier-b fires (the orchestrator went unresponsive).
  await host.restartUnresponsive();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(driver.starts, 2, 'a fresh session was started');
  assert.equal(host.health().lifecycle.sessionId, 's2', 'now on the fresh session');
  assert.equal(host.health().lifecycle.restarts, 1, '★ the involuntary restart is COUNTED (not zeroed like clearContext)');
  const evs = lifecycleEvents(events);
  assert.ok(evs.includes('lifecycle_restart_unresponsive'), 'an unresponsive-restart audit signal was published');
  await host.stop();
  bus.close();
});

// ── FIX 2: auto-initiate the /orchestrator skill on startup (roleTurnPrefix) ─────

test('FIX2: the startup input carries the /orchestrator invocation (prepended to the first turn)', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    roleTurnPrefix: '/orchestrator', // DEFAULT ON (config.roleTurnPrefix); auto-start the orchestrator
  });
  await host.start();
  await host.handleInbound(inbound('do the thing'));
  assert.equal(driver.sentTurns.length, 1);
  // The first turn boots the session AS the orchestrator: /orchestrator prefixes the user text.
  assert.match(driver.sentTurns[0]!.text, /^\/orchestrator\b/, 'first turn starts with /orchestrator');
  assert.match(driver.sentTurns[0]!.text, /do the thing/, 'the user text still follows');
  // It is consumed ONCE — a second turn is plain (no double-invoke).
  await host.handleInbound(inbound('second message'));
  assert.equal(driver.sentTurns[1]!.text, 'second message', 'role prefix applied only to the first turn');
  await host.stop();
  bus.close();
});

test('FIX2: roleTurnPrefix undefined (auto-start OFF) → the first turn is the raw user text', async () => {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }, { do: 'silence' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    // roleTurnPrefix omitted → OFF (env SUPERVISOR_ROLE_TURN_PREFIX=none / demo profile)
  });
  await host.start();
  await host.handleInbound(inbound('hello'));
  // No role prefix when auto-start is OFF → the user text LEADS (the ★ MODE-AWARENESS one-shot
  // mode notice is appended after it, dev-6ca1; assert no prefix precedes the message).
  assert.ok(driver.sentTurns[0]!.text.startsWith('hello'), 'no role prefix when auto-start is OFF');
  assert.ok(!driver.sentTurns[0]!.text.startsWith('/orchestrator'), 'no role prefix prepended');
  await host.stop();
  bus.close();
});
