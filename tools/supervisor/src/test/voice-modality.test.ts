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
import {
  SessionHost,
  parseModeCommand,
  applyForceText,
  buildOutputModeNotice,
  FORCE_TEXT_MARKER,
} from '../session-host.js';
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

/** A Mode-submenu button tap (ctl:mode-set:<value>) as a callback inbound (no text). */
const modeSetTap = (value: string, id = 'cb-mode'): InboundMessage => ({
  attachments: [],
  callback: { id, data: `ctl:mode-set:${value}`, messageId: `m-${value}` },
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-19T00:00:00Z',
  replyHandle: { to: '555' },
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

test('/mode voice → INTERCEPTED: state switches, ACK sent, raw command NOT forwarded (only a mode notice)', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send);
  await host.start();
  // First inbound binds the operator; the /mode COMMAND TEXT is intercepted (never forwarded).
  await host.handleInbound(inbound('/mode voice'));
  // State flipped.
  assert.equal(host.outputModeState(), 'voice');
  // ACK delivered (as plain text — no modality on a control message).
  const ack = cap.sent.find((s) => /Output mode → voice/.test(s.text));
  assert.ok(ack, 'an ACK was sent back to the user');
  assert.equal(ack!.modality, undefined, 'ACK is a control message — sent without modality');
  // The raw `/mode voice` command text is NEVER forwarded to the orchestrator.
  assert.ok(!driver.sentTurns.some((t) => t.text.includes('/mode')), 'the raw /mode command is not forwarded');
  // ★ MODE-AWARENESS: a running session DOES get an out-of-band change notice (so the
  // orchestrator can adapt). It names the new mode + the force-text escape hatch.
  const notice = driver.sentTurns.find((t) => /\[SUPERVISOR output-mode\]/.test(t.text));
  assert.ok(notice, 'a mode-change notice was injected into the orchestrator turn');
  assert.match(notice!.text, /is now: voice/);
  assert.ok(notice!.text.includes(FORCE_TEXT_MARKER), 'the voice notice mentions the force-text marker');
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
  // ★ MODE-AWARENESS: the FIRST real user turn carries the user's message FIRST, then the
  // one-shot current-mode notice appended after it (so a restarted orchestrator knows the mode).
  assert.ok(driver.sentTurns[0]!.text.startsWith('hello orchestrator'), 'the user message leads the turn');
  assert.match(driver.sentTurns[0]!.text, /\[SUPERVISOR output-mode\] The current output mode is: dual/);
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

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2 — force-text marker (deliver a reply as TEXT even in voice/dual)
// ─────────────────────────────────────────────────────────────────────────────

/** Drive one user turn whose orchestrator reply is `reply`, under output mode `mode`. */
async function replyUnderMode(
  reply: string,
  mode: 'text' | 'voice' | 'dual',
): Promise<{ sent: ReturnType<typeof makeSendCapture>['sent'] }> {
  const cap = makeSendCapture();
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: reply } },
      { do: 'endClean' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    outputMode: mode,
  });
  await host.start();
  await host.handleInbound(inbound('do the thing'));
  await new Promise((r) => setTimeout(r, 20));
  await host.stop();
  bus.close();
  return { sent: cap.sent };
}

test('applyForceText (pure): detects + strips the marker (start/mid/end/repeat/only/absent)', async () => {
  assert.deepEqual(applyForceText('hello world'), { forced: false, text: 'hello world' });
  // Leading marker.
  assert.deepEqual(applyForceText(`${FORCE_TEXT_MARKER} https://x.io/qr`), {
    forced: true,
    text: 'https://x.io/qr',
  });
  // Trailing + mid.
  assert.deepEqual(applyForceText(`scan ${FORCE_TEXT_MARKER} this code`), { forced: true, text: 'scan this code' });
  assert.deepEqual(applyForceText(`path: C:\\a\\b ${FORCE_TEXT_MARKER}`), { forced: true, text: 'path: C:\\a\\b' });
  // Repeated occurrences all removed.
  assert.deepEqual(applyForceText(`${FORCE_TEXT_MARKER}a${FORCE_TEXT_MARKER}b`), { forced: true, text: 'a b' });
  // Only the marker → empty.
  assert.deepEqual(applyForceText(FORCE_TEXT_MARKER), { forced: true, text: '' });
  // Case-insensitive.
  assert.equal(applyForceText('[[force_text]] x').forced, true);
});

test('force-text in VOICE mode → delivered as TEXT (no TTS) with the marker stripped', async () => {
  const { sent } = await replyUnderMode(`${FORCE_TEXT_MARKER} https://example.com/qr.png`, 'voice');
  const out = sent.find((s) => /example\.com/.test(s.text));
  assert.ok(out, 'the reply was sent');
  assert.equal(out!.modality, 'text', 'voice mode is overridden to text for a force-text reply');
  assert.equal(out!.text, 'https://example.com/qr.png', 'the marker is stripped before sending');
  assert.ok(!out!.text.includes(FORCE_TEXT_MARKER), 'no marker leaks to the user');
});

test('force-text in TEXT mode → no-op on modality, marker still stripped', async () => {
  const { sent } = await replyUnderMode(`${FORCE_TEXT_MARKER} see /tmp/log.txt`, 'text');
  const out = sent.find((s) => /log\.txt/.test(s.text));
  assert.ok(out, 'the reply was sent');
  assert.equal(out!.modality, 'text', 'text mode stays text');
  assert.equal(out!.text, 'see /tmp/log.txt', 'the marker is stripped even in text mode');
});

test('force-text in DUAL mode → TEXT-only (no voice copy) for that message, marker stripped', async () => {
  const { sent } = await replyUnderMode(`${FORCE_TEXT_MARKER} run: npm test`, 'dual');
  const out = sent.find((s) => /npm test/.test(s.text));
  assert.ok(out, 'the reply was sent');
  assert.equal(out!.modality, 'text', 'dual is overridden to text-only for a force-text reply (no voice copy)');
  assert.equal(out!.text, 'run: npm test');
});

test('NO marker in voice mode → still voiced (force-text does not change unmarked replies)', async () => {
  const { sent } = await replyUnderMode('just a normal spoken answer', 'voice');
  const out = sent.find((s) => /normal spoken/.test(s.text));
  assert.ok(out, 'the reply was sent');
  assert.equal(out!.modality, 'voice', 'an unmarked reply keeps the current voice modality');
});

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1 — mode-awareness (notice on change + on first turn) + the pure builder
// ─────────────────────────────────────────────────────────────────────────────

test('buildOutputModeNotice (pure): names the mode + (voice/dual) the force-text marker', async () => {
  const v = buildOutputModeNotice('voice', true);
  assert.match(v, /\[SUPERVISOR output-mode\]/);
  assert.match(v, /is now: voice/);
  assert.ok(v.includes(FORCE_TEXT_MARKER));
  const d = buildOutputModeNotice('dual', false);
  assert.match(d, /current output mode is: dual/);
  assert.ok(d.includes(FORCE_TEXT_MARKER));
  const t = buildOutputModeNotice('text', true);
  assert.match(t, /is now: text/);
  // text mentions the marker only as a no-op note (no harm), but never voices content.
  assert.match(t, /plain text/);
});

test('mode-change notice reaches the orchestrator (panel/menu path: ctl:mode-set)', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'text');
  await host.start();
  // Bind the operator, then tap the Mode submenu: /control → ctl:mode-set:voice (public path).
  await host.handleInbound(inbound('/control'));
  await host.handleInbound(modeSetTap('voice'));
  // controlSetMode injects best-effort (fire-and-forget) → allow the microtask to run.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.outputModeState(), 'voice', 'the panel submenu switched the mode');
  const notice = driver.sentTurns.find((t) => /\[SUPERVISOR output-mode\].*is now: voice/.test(t.text));
  assert.ok(notice, 'the menu-driven mode change also notifies the orchestrator');
  await host.stop();
  bus.close();
});

test('NO mode-change notice when the mode does not actually change', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'text');
  await host.start();
  await host.handleInbound(inbound('/mode text')); // already text → no real change
  assert.equal(host.outputModeState(), 'text');
  assert.ok(
    !driver.sentTurns.some((t) => /\[SUPERVISOR output-mode\]/.test(t.text)),
    'no notice injected when prev === next',
  );
  await host.stop();
  bus.close();
});

test('current mode is delivered on the FIRST turn (voice) — restarted orchestrator learns it', async () => {
  const cap = makeSendCapture();
  const { bus, driver, host } = makeHost(cap.send, 'voice');
  await host.start();
  await host.handleInbound(inbound('first message'));
  const first = driver.sentTurns[0];
  assert.ok(first, 'the first turn was injected');
  assert.ok(first!.text.startsWith('first message'), 'the user message leads');
  assert.match(first!.text, /\[SUPERVISOR output-mode\] The current output mode is: voice/);
  assert.ok(first!.text.includes(FORCE_TEXT_MARKER), 'the first-turn voice notice mentions the marker');
  // One-shot: a SECOND turn does NOT repeat the first-turn notice.
  await host.handleInbound(inbound('second message'));
  const second = driver.sentTurns[1];
  assert.ok(second, 'the second turn was injected');
  assert.ok(!/The current output mode is/.test(second!.text), 'the first-turn notice is one-shot');
  await host.stop();
  bus.close();
});
