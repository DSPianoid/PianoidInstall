/**
 * `/setkey` IN-CHANNEL SECRET-INTAKE tests — the supervisor-intercepted provider-key command.
 *
 * Covers (mock Telegram via the fake send/deleteMessage; temp store dir; NO real key, NO real
 * deletion of a real chat, NO network, zero spend):
 *   - PURE parse + redaction (parseSetKeyCommand / redactSetKeyText) — the key never appears in
 *     the redacted text;
 *   - SessionHost interception: `/setkey <provider> <key>` stores the key SCOPED under the right
 *     env var, replies a MASKED confirmation (no full value), invokes deleteMessage, and is NOT
 *     forwarded to the orchestrator (the fake driver receives ZERO turns); unknown-provider errors
 *     cleanly; the stored key reads back scoped (deepseek→DEEPSEEK_API_KEY);
 *   - the key value NEVER appears in the confirmation / the captured bus events / any log;
 *   - GATING: with NO secretStore wired (dormant default), `/setkey` falls through to a normal turn
 *     (byte-for-byte unchanged) — the driver DOES receive the turn;
 *   - SUPERVISOR redaction: the captured `channel.inbound` record for a `/setkey` message carries the
 *     MASKED text (not the key), while the host hook still receives the raw key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost } from '../session-host.js';
import { parseSetKeyCommand, redactSetKeyText, SETKEY_CMD_RE } from '../setkey-command.js';
import { SecretStore } from '../secret-store.js';
import { Supervisor } from '../supervisor.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult, ReplyHandle, ChannelAdapter, InboundHandler, AdapterHealth } from '../contract.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const FAKE_DEEPSEEK = 'ds_fake_SECRETvalue_9999'; // NOT a real key
const FAKE_GROQ = 'gsk_fake_live_SECRETmiddle_4321'; // NOT a real key

function tmpStorePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-setkey-'));
  return { path: join(dir, '.state', 'provider-secrets.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const inbound = (text: string, msgId?: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555', ...(msgId ? { replyToMessageId: msgId } : {}) },
  channel: 'telegram',
});

/** A SessionHost wired with a temp secret store + capture of sends + deleteMessage calls. */
function makeHost(storePath: string) {
  const bus = new IoBus();
  const sent: { text: string }[] = [];
  const deleted: { handle: ReplyHandle; messageId: string }[] = [];
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const store = new SecretStore({ filePath: storePath });
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: async (_h, msg) => {
      sent.push({ text: msg.text ?? '' });
      return { ok: true, sentIds: ['1'] } as OutboundResult;
    },
    deleteMessage: async (handle, messageId) => {
      deleted.push({ handle, messageId });
    },
    secretStore: store,
    policy: { allow: ['Read'] },
  });
  return { host, bus, driver, sent, deleted, store };
}

/* ── 1) PURE parse + redaction ──────────────────────────────────────────────────── */

test('parseSetKeyCommand splits provider + key; usage forms for bare/partial; null for non-command', () => {
  assert.deepEqual(parseSetKeyCommand('/setkey groq gsk_abc123'), { kind: 'set', providerToken: 'groq', key: 'gsk_abc123' });
  assert.deepEqual(parseSetKeyCommand('  /SetKey   deepseek   ds_xyz  '), { kind: 'set', providerToken: 'deepseek', key: 'ds_xyz' });
  assert.deepEqual(parseSetKeyCommand('/setkey'), { kind: 'usage', reason: 'no_provider' });
  assert.deepEqual(parseSetKeyCommand('/setkey groq'), { kind: 'usage', reason: 'no_key' });
  assert.equal(parseSetKeyCommand('hello there'), null);
  assert.equal(parseSetKeyCommand('/setkeys foo bar'), null, 'word-boundary: /setkeys is not /setkey');
});

test('★ redactSetKeyText masks the key (never contains the value); non-command text is unchanged', () => {
  const red = redactSetKeyText(`/setkey groq ${FAKE_GROQ}`);
  assert.ok(!red.includes(FAKE_GROQ), 'redacted text must not contain the key');
  assert.ok(red.startsWith('/setkey groq '), 'keeps the command + provider');
  assert.ok(red.includes('4321'), 'shows the masked last-4 hint');
  // a normal message is returned byte-for-byte
  assert.equal(redactSetKeyText('just a normal message'), 'just a normal message');
  // bare / partial forms carry nothing secret
  assert.equal(redactSetKeyText('/setkey'), '/setkey');
  assert.equal(redactSetKeyText('/setkey groq'), '/setkey groq');
  assert.ok(SETKEY_CMD_RE.test('/setkey x y'));
});

/* ── 2) SessionHost interception ─────────────────────────────────────────────────── */

test('★ /setkey stores the key scoped, replies MASKED, deletes the message, and does NOT forward to the orchestrator', async () => {
  const t = tmpStorePath();
  try {
    const { host, bus, driver, sent, deleted, store } = makeHost(t.path);
    await host.start();
    await host.handleInbound(inbound(`/setkey deepseek ${FAKE_DEEPSEEK}`, 'mid-100'));

    // NOT forwarded: the fake orchestrator driver received ZERO user turns.
    assert.equal(driver.sentTurns.length, 0, 'the raw key must never reach the orchestrator session');

    // stored SCOPED under DEEPSEEK_API_KEY (and readable back).
    assert.equal(store.getKey('DEEPSEEK_API_KEY'), FAKE_DEEPSEEK);
    assert.equal(store.getKey('GROQ_API_KEY'), undefined, 'scoped — only deepseek stored');

    // MASKED confirmation only (names the env var; never the full value).
    assert.equal(sent.length, 1);
    const confirm = sent[0]!.text;
    assert.ok(confirm.includes('DEEPSEEK_API_KEY set'), confirm);
    assert.ok(!confirm.includes(FAKE_DEEPSEEK), 'confirmation must not leak the key value');
    assert.ok(confirm.includes('9999'), 'confirmation shows the masked tail');

    // deleteMessage invoked with the inbound message id.
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0]!.messageId, 'mid-100');

    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('★ the key value NEVER appears in the captured bus events (no inbound capture of the key at the host)', async () => {
  // The host publishes NOTHING that contains the key (it returns before injecting a turn). Assert no
  // captured/published bus event payload contains the key string.
  const t = tmpStorePath();
  try {
    const { host, bus, driver } = makeHost(t.path);
    const seenPayloads: string[] = [];
    bus.subscribe((e) => seenPayloads.push(JSON.stringify(e.payload)));
    await host.start();
    await host.handleInbound(inbound(`/setkey deepseek ${FAKE_DEEPSEEK}`, 'mid-1'));
    for (const p of seenPayloads) assert.ok(!p.includes(FAKE_DEEPSEEK), 'no bus event may carry the key');
    assert.equal(driver.sentTurns.length, 0);
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('unknown provider → helpful error (lists known providers), key NOT stored, message still deleted', async () => {
  const t = tmpStorePath();
  try {
    const { host, bus, sent, deleted, store, driver } = makeHost(t.path);
    await host.start();
    await host.handleInbound(inbound('/setkey mistral some_key_value', 'mid-2'));
    assert.equal(driver.sentTurns.length, 0, 'not forwarded');
    assert.equal(store.storedEnvVarNames().length, 0, 'nothing stored for an unknown provider');
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.text.includes('Unknown provider'), sent[0]!.text);
    assert.ok(/deepseek/.test(sent[0]!.text) && /groq/.test(sent[0]!.text), 'lists known providers');
    assert.ok(!sent[0]!.text.includes('some_key_value'), 'never echoes the typed key');
    assert.equal(deleted.length, 1, 'the message (with a key) is deleted');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('the `codex` alias stores under OPENAI_API_KEY (alias resolution)', async () => {
  const t = tmpStorePath();
  try {
    const { host, bus, store } = makeHost(t.path);
    await host.start();
    await host.handleInbound(inbound('/setkey codex sk_fake_openai_5555', 'mid-3'));
    assert.equal(store.getKey('OPENAI_API_KEY'), 'sk_fake_openai_5555');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('bare `/setkey` (usage) → usage reply, nothing stored, not forwarded', async () => {
  const t = tmpStorePath();
  try {
    const { host, bus, sent, store, driver } = makeHost(t.path);
    await host.start();
    await host.handleInbound(inbound('/setkey'));
    assert.equal(driver.sentTurns.length, 0);
    assert.equal(store.storedEnvVarNames().length, 0);
    assert.equal(sent.length, 1);
    assert.ok(/Usage: \/setkey/.test(sent[0]!.text));
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('a Groq key reads back scoped for a groq agent (and not for a deepseek agent)', async () => {
  const t = tmpStorePath();
  try {
    const { host, bus, store } = makeHost(t.path);
    await host.start();
    await host.handleInbound(inbound(`/setkey groq ${FAKE_GROQ}`, 'mid-4'));
    assert.equal(store.getKey('GROQ_API_KEY'), FAKE_GROQ);
    assert.equal(store.getKey('DEEPSEEK_API_KEY'), undefined);
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

/* ── 3) GATING: no store wired → falls through unchanged ───────────────────────────── */

test('★ with NO secretStore wired (dormant default), /setkey is NOT intercepted — it is a normal turn', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: async () => ({ ok: true, sentIds: ['1'] }) as OutboundResult,
    policy: { allow: ['Read'] },
    // NO secretStore → byte-for-byte the current behavior.
  });
  await host.start();
  await host.handleInbound(inbound('/setkey deepseek some_key', 'mid-x'));
  // It WAS forwarded as a normal user turn (the dormant default — no interception).
  assert.equal(driver.sentTurns.length, 1);
  assert.equal(driver.sentTurns[0]!.text, '/setkey deepseek some_key');
  await host.stop();
  bus.close();
});

/* ── 4) SUPERVISOR redaction: capture holds the MASKED text ────────────────────────── */

/** A minimal in-memory adapter that lets the test push an inbound through the Supervisor. */
class FakeAdapter implements ChannelAdapter {
  readonly channel = 'telegram';
  private handler: InboundHandler | null = null;
  async start(onInbound: InboundHandler): Promise<void> {
    this.handler = onInbound;
  }
  async outbound(): Promise<OutboundResult> {
    return { ok: true, sentIds: ['1'] };
  }
  async stop(): Promise<void> {}
  health(): AdapterHealth {
    return { channel: this.channel, running: true, queueDepth: 0 };
  }
  /** Test helper: simulate an inbound arriving from the channel. */
  async push(msg: InboundMessage): Promise<void> {
    await this.handler!(msg);
  }
}

test('★ SUPERVISOR redactInbound masks the key in the CAPTURED inbound record; the host hook still gets the raw key', async () => {
  const t = tmpStorePath();
  const capFile = join(t.path, '..', 'capture.ndjson');
  try {
    const sup = new Supervisor({
      captureFile: capFile,
      logger: silentLogger(),
      redactInbound: (m) => ({ ...m, text: redactSetKeyText(m.text) }),
    });
    const adapter = new FakeAdapter();
    sup.register(adapter);

    // The host hook records what it actually received (must be the RAW key — the host needs it to store).
    let hookText: string | undefined;
    sup.onInbound((m) => {
      hookText = m.text;
    });
    await sup.start();

    await adapter.push(inbound(`/setkey groq ${FAKE_GROQ}`, 'mid-7'));

    // The capture store must NOT contain the raw key anywhere.
    const records = sup.captureStore.replay();
    const dump = JSON.stringify(records);
    assert.ok(!dump.includes(FAKE_GROQ), 'the captured inbound must NOT contain the key value');
    // …and the captured inbound text IS the masked form.
    const inb = records.find((r) => r.event.type === 'channel.inbound');
    assert.ok(inb, 'an inbound was captured');
    const capturedText = (inb!.event.payload as InboundMessage).text ?? '';
    assert.ok(capturedText.startsWith('/setkey groq '), capturedText);
    assert.ok(!capturedText.includes(FAKE_GROQ));

    // The host hook DID receive the raw key (it needs it to store the secret).
    assert.equal(hookText, `/setkey groq ${FAKE_GROQ}`);

    await sup.stop();
  } finally {
    t.cleanup();
  }
});

test('SUPERVISOR redaction leaves a NORMAL inbound byte-for-byte unchanged in capture', async () => {
  const t = tmpStorePath();
  const capFile = join(t.path, '..', 'capture-normal.ndjson');
  try {
    const sup = new Supervisor({
      captureFile: capFile,
      logger: silentLogger(),
      redactInbound: (m) => ({ ...m, text: redactSetKeyText(m.text) }),
    });
    const adapter = new FakeAdapter();
    sup.register(adapter);
    sup.onInbound(() => {});
    await sup.start();
    await adapter.push(inbound('please render a chart'));
    const inb = sup.captureStore.replay().find((r) => r.event.type === 'channel.inbound');
    assert.equal((inb!.event.payload as InboundMessage).text, 'please render a chart');
    await sup.stop();
  } finally {
    t.cleanup();
  }
});
