/**
 * OUTPUT-MODALITY + INPUT-CHANNEL tests (the user's "input and output channels"
 * feature): the switchable output mode (text/voice/dual), the supervisor-
 * intercepted `/mode` switch command, and the config default — all proven
 * deterministically (FakeSessionDriver + a capturing send; loopback transport
 * for the adapter end). No SDK, no Python, no network, no real Telegram.
 *
 * Inbound auto-STT (the input channel) is exercised at the adapter layer in
 * telegram-adapter.test.ts ("VOICE IN: …"); here we cover the supervisor-level
 * modality state + the `/mode` interception + the wiring that carries the
 * modality from the SessionHost down to the adapter on a substantive reply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHost, parseModeCommand } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import { resolveOutputMode, DEFAULT_OUTPUT_MODE } from '../config.js';
import type { InboundMessage, OutboundMessage, OutboundResult, ReplyHandle } from '../contract.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const inbound = (text: string, who?: { userId?: string; to?: string }): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: who?.userId ?? 'u-tester',
  ts: '2026-06-19T00:00:00Z',
  replyHandle: { to: who?.to ?? '555' },
  channel: 'telegram',
});

/** Capture outbound sends WITH their options (so we can assert the modality). */
function makeSendCapture() {
  const sent: { handle: ReplyHandle; text: string; modality?: string }[] = [];
  const send = async (handle: ReplyHandle, msg: OutboundMessage): Promise<OutboundResult> => {
    sent.push({ handle, text: msg.text ?? '', modality: msg.options?.modality });
    return { ok: true, sentIds: ['1'] };
  };
  return { sent, send };
}

/** A host idling after system_init, waiting for the first user turn. */
function makeHost(send: ReturnType<typeof makeSendCapture>['send'], outputMode?: 'text' | 'voice' | 'dual') {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const host = new SessionHost({ driver, bus, logger: silentLogger(), send, policy: { allow: ['Read'] }, outputMode });
  return { bus, driver, host };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseModeCommand (pure)
// ─────────────────────────────────────────────────────────────────────────────

test('parseModeCommand: valid set commands (case/space-insensitive)', async () => {
  assert.deepEqual(parseModeCommand('/mode text'), { kind: 'set', mode: 'text' });
  assert.deepEqual(parseModeCommand('/mode voice'), { kind: 'set', mode: 'voice' });
  assert.deepEqual(parseModeCommand('/mode dual'), { kind: 'set', mode: 'dual' });
  assert.deepEqual(parseModeCommand('  /MODE   Voice  '), { kind: 'set', mode: 'voice' });
  assert.deepEqual(parseModeCommand('/mode DUAL'), { kind: 'set', mode: 'dual' });
});

test('parseModeCommand: bare or invalid arg → query', async () => {
  assert.deepEqual(parseModeCommand('/mode'), { kind: 'query' });
  assert.deepEqual(parseModeCommand('/mode   '), { kind: 'query' });
  assert.deepEqual(parseModeCommand('/mode loud'), { kind: 'query' });
  assert.deepEqual(parseModeCommand('/mode text please'), { kind: 'set', mode: 'text' }); // first token wins
});

test('parseModeCommand: not a /mode command → null (falls through to a turn)', async () => {
  assert.equal(parseModeCommand('hello'), null);
  assert.equal(parseModeCommand('what is the mode'), null);
  assert.equal(parseModeCommand('/model text'), null); // not the /mode token
  assert.equal(parseModeCommand('please /mode text'), null); // only leading /mode is a command
});

// ─────────────────────────────────────────────────────────────────────────────
// config default
// ─────────────────────────────────────────────────────────────────────────────

test('resolveOutputMode: default is text; env overrides; invalid → default', async () => {
  assert.equal(DEFAULT_OUTPUT_MODE, 'text');
  assert.equal(resolveOutputMode(undefined), 'text');
  assert.equal(resolveOutputMode(''), 'text');
  assert.equal(resolveOutputMode('voice'), 'voice');
  assert.equal(resolveOutputMode('DUAL'), 'dual');
  assert.equal(resolveOutputMode(' text '), 'text');
  assert.equal(resolveOutputMode('garbage'), 'text');
});

// ─────────────────────────────────────────────────────────────────────────────
// /mode interception in the SessionHost
// ─────────────────────────────────────────────────────────────────────────────

test('default output mode is text (no option given)', async () => {
  const cap = makeSendCapture();
  const { bus, host } = makeHost(cap.send);
  // The default is set in the constructor — assert WITHOUT starting the session
  // (a started-but-unprompted host parks its generator on a bare promise with no
  // ref'd handle, which node:test misreads as a resolved event loop).
  assert.equal(host.outputModeState(), 'text');
  bus.close();
});

test('configured output mode is honored as the startup default', async () => {
  const cap = makeSendCapture();
  const { bus, host } = makeHost(cap.send, 'dual');
  assert.equal(host.outputModeState(), 'dual');
  bus.close();
});

test('/mode voice → INTERCEPTED: state switches, ACK sent, NOT forwarded to the session', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send);
  await host.start();
  // First inbound binds the operator; a /mode is intercepted (no turn injected).
  await host.handleInbound(inbound('/mode voice'));
  // State flipped.
  assert.equal(host.outputModeState(), 'voice');
  // ACK delivered (as plain text — no modality on a control message).
  const ack = cap.sent.find((s) => /Output mode → voice/.test(s.text));
  assert.ok(ack, 'an ACK was sent back to the user');
  assert.equal(ack!.modality, undefined, 'ACK is a control message — sent without modality');
  // NOT forwarded to the orchestrator session.
  assert.equal(driver.sentTurns.length, 0, 'no user turn injected for a /mode command');
  await host.stop();
  bus.close();
});

test('/mode dual then /mode text → state tracks each switch', async () => {
  const cap = makeSendCapture();
  const { bus, host } = makeHost(cap.send);
  await host.start();
  await host.handleInbound(inbound('/mode dual'));
  assert.equal(host.outputModeState(), 'dual');
  await host.handleInbound(inbound('/mode text'));
  assert.equal(host.outputModeState(), 'text');
  await host.stop();
  bus.close();
});

test('/mode (bare) → query: replies with current mode + options, no switch, not forwarded', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'voice');
  await host.start();
  await host.handleInbound(inbound('/mode'));
  // Mode unchanged.
  assert.equal(host.outputModeState(), 'voice');
  const reply = cap.sent.find((s) => /Output mode is "voice"/.test(s.text) && /\/mode text/.test(s.text));
  assert.ok(reply, 'the query reply names the current mode + the valid options');
  assert.equal(driver.sentTurns.length, 0, 'a query is not forwarded to the session');
  await host.stop();
  bus.close();
});

test('/mode with an invalid arg → query (no state change), not forwarded', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'text');
  await host.start();
  await host.handleInbound(inbound('/mode loud'));
  assert.equal(host.outputModeState(), 'text', 'invalid arg does not change the mode');
  assert.ok(cap.sent.some((s) => /Output mode is "text"/.test(s.text)));
  assert.equal(driver.sentTurns.length, 0);
  await host.stop();
  bus.close();
});

test('a non-/mode message is a normal turn (forwarded), mode unchanged', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'dual');
  await host.start();
  await host.handleInbound(inbound('hello orchestrator'));
  assert.equal(driver.sentTurns.length, 1, 'a normal message is injected as a turn');
  assert.equal(driver.sentTurns[0]!.text, 'hello orchestrator');
  assert.equal(host.outputModeState(), 'dual', 'mode is unchanged by a normal message');
  await host.stop();
  bus.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// modality carried onto the orchestrator's substantive reply
// ─────────────────────────────────────────────────────────────────────────────

test('substantive reply carries the current modality (text/voice/dual) onto opts.send', async () => {
  const cap = makeSendCapture();
  const bus = new IoBus();
  // Program: idle until the first turn, then emit a result (the orchestrator's answer)
  // → SessionHost.sendToOperator forwards it with the current modality.
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'the answer' } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({ driver, bus, logger: silentLogger(), send: cap.send, policy: { allow: ['Read'] }, outputMode: 'dual' });
  await host.start();
  // First, switch to voice via /mode (also proves the switch affects later replies).
  await host.handleInbound(inbound('/mode voice'));
  // Then a real user turn → the orchestrator answers ('the answer') → it goes out voiced.
  await host.handleInbound(inbound('do the thing'));
  // Give the generator a tick to emit the result + run the onResult send.
  await new Promise((r) => setTimeout(r, 20));
  const answer = cap.sent.find((s) => s.text === 'the answer');
  assert.ok(answer, 'the orchestrator answer was sent to the operator');
  assert.equal(answer!.modality, 'voice', 'the reply carries the current output modality');
  await host.stop();
  bus.close();
});
