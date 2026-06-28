/**
 * `/setrole` + `/roles` SessionHost-interception tests (PART Q.3) — the supervisor-intercepted
 * Tier-2 per-role model-selection commands + the orchestrator-invokable setRoleRouting().
 *
 * Mock send via a fake; temp `.state/` store dir; NO real key (only a fake to prove key-presence
 * booleans), NO network, zero spend. Covers:
 *   - ★ `/setrole <role> <provider> [model]` persists the override SCOPED, replies a confirmation,
 *     and is NOT forwarded to the orchestrator (the fake driver receives ZERO turns);
 *   - ★ the override takes effect on the NEXT resolve (read back via the store / `/roles`);
 *   - validation: unknown role → helpful error; unregistered provider → helpful error (known list);
 *   - ★ NO-KEY WARN: choosing a provider with no key still records the selection + warns;
 *   - ★ `/roles` shows the merged map + per-provider key-presence BOOLEANS, never a key value;
 *   - ★ the orchestrator-invokable setRoleRouting() routes through the SAME sole writer;
 *   - ★ DORMANT default-OFF: with NO routingStore wired, `/setrole` + `/roles` fall through to a
 *     normal turn (the driver DOES receive the turn) — byte-for-byte unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost } from '../session-host.js';
import { SecretStore } from '../secret-store.js';
import { RoleRoutingStore } from '../role-routing-store.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult } from '../contract.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const FAKE_GROQ = 'gsk_fake_SECRET_8888'; // NOT a real key

function tmpStateDir(): { dir: string; routingPath: string; secretPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-setrole-'));
  return {
    dir,
    routingPath: join(dir, '.state', 'role-routing.json'),
    secretPath: join(dir, '.state', 'provider-secrets.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

/**
 * A SessionHost wired with a temp routing store (+ optional secret store, to prove key-presence
 * booleans). Captures sends. `withSecret` pre-seeds a Groq key so key-presence is true for it.
 */
function makeHost(opts: { routingPath: string; secretPath?: string; seedGroqKey?: boolean }) {
  const bus = new IoBus();
  const sent: { text: string }[] = [];
  const driver = new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
  const roleRoutingStore = new RoleRoutingStore({ filePath: opts.routingPath });
  let secretStore: SecretStore | undefined;
  if (opts.secretPath) {
    secretStore = new SecretStore({ filePath: opts.secretPath });
    if (opts.seedGroqKey) secretStore.setKey('GROQ_API_KEY', FAKE_GROQ);
  }
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: async (_h, msg) => {
      sent.push({ text: msg.text ?? '' });
      return { ok: true, sentIds: ['1'] } as OutboundResult;
    },
    roleRoutingStore,
    ...(secretStore ? { secretStore } : {}),
    policy: { allow: ['Read'] },
  });
  return { host, bus, driver, sent, roleRoutingStore, secretStore };
}

/* ── 1) /setrole intercepted, persisted, NOT forwarded ───────────────────────────────── */

test('★ /setrole persists the override, replies a confirmation, and does NOT forward to the orchestrator', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, driver, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole coding groq llama-3.3-70b-versatile'));

    // NOT forwarded: the orchestrator driver got ZERO user turns.
    assert.equal(driver.sentTurns.length, 0, 'a /setrole must never reach the orchestrator session');

    // persisted override (reads back).
    assert.deepEqual(roleRoutingStore.get('coding'), { provider: 'groq', model: 'llama-3.3-70b-versatile' });

    // confirmation reply (role → provider (model) ✓). No key store wired → a no-key warning is appended.
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.text.startsWith('coding → groq (llama-3.3-70b-versatile) ✓'), sent[0]!.text);

    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('/setrole with NO model uses the provider default (shown in the confirmation + readable)', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole reviewing gemini'));
    assert.deepEqual(roleRoutingStore.get('reviewing'), { provider: 'gemini' });
    // provider default model surfaces in the confirmation.
    assert.ok(sent[0]!.text.startsWith('reviewing → gemini (gemini-2.5-flash) ✓'), sent[0]!.text);
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('the `codex` provider alias resolves to openai on /setrole', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole reviewing codex'));
    assert.deepEqual(roleRoutingStore.get('reviewing'), { provider: 'openai' });
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

/* ── 2) validation ───────────────────────────────────────────────────────────────────── */

test('unknown role → helpful error (lists known roles), nothing stored, not forwarded', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, driver, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole deploying groq'));
    assert.equal(driver.sentTurns.length, 0, 'not forwarded');
    assert.deepEqual(roleRoutingStore.loadAll(), {}, 'nothing stored for an unknown role');
    assert.ok(sent[0]!.text.includes('Unknown role'), sent[0]!.text);
    assert.ok(/planning/.test(sent[0]!.text) && /coding/.test(sent[0]!.text), 'lists known roles');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('unregistered provider → helpful error (lists known providers), nothing stored', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole coding mistral'));
    assert.deepEqual(roleRoutingStore.loadAll(), {});
    assert.ok(sent[0]!.text.includes('Unknown provider'), sent[0]!.text);
    assert.ok(/deepseek/.test(sent[0]!.text) && /groq/.test(sent[0]!.text) && /gemini/.test(sent[0]!.text));
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('bare `/setrole` (usage) → usage reply, nothing stored, not forwarded', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, driver, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/setrole'));
    assert.equal(driver.sentTurns.length, 0);
    assert.deepEqual(roleRoutingStore.loadAll(), {});
    assert.ok(/Usage: \/setrole/.test(sent[0]!.text));
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

/* ── 3) ★ no-key warn ────────────────────────────────────────────────────────────────── */

test('★ /setrole to a provider with NO key set warns but STILL records the selection', async () => {
  const t = tmpStateDir();
  try {
    // secret store wired but EMPTY (no Groq key) → expect a warning + the override is still stored.
    const { host, bus, sent, roleRoutingStore } = makeHost({ routingPath: t.routingPath, secretPath: t.secretPath });
    await host.start();
    await host.handleInbound(inbound('/setrole coding groq'));
    assert.deepEqual(roleRoutingStore.get('coding'), { provider: 'groq' }, 'selection recorded despite no key');
    assert.ok(sent[0]!.text.includes('coding → groq'), sent[0]!.text);
    assert.ok(sent[0]!.text.includes('no GROQ_API_KEY set yet'), 'warns about the missing key');
    assert.ok(sent[0]!.text.includes('/setkey groq'), 'tells the user how to set it');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('★ /setrole to a provider WITH a key present → NO warning', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, sent } = makeHost({ routingPath: t.routingPath, secretPath: t.secretPath, seedGroqKey: true });
    await host.start();
    await host.handleInbound(inbound('/setrole coding groq'));
    assert.ok(sent[0]!.text.startsWith('coding → groq'), sent[0]!.text);
    assert.ok(!sent[0]!.text.includes('no GROQ_API_KEY set yet'), 'key present → no warning');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

/* ── 4) ★ /roles merged map + key booleans (never a value) ─────────────────────────────── */

test('★ /roles lists the merged map + per-provider key PRESENCE booleans; NEVER a key value', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, driver, sent } = makeHost({ routingPath: t.routingPath, secretPath: t.secretPath, seedGroqKey: true });
    await host.start();
    // override coding → groq (key present); leave reviewing default (openai, no key); planning is claude (n/a).
    await host.handleInbound(inbound('/setrole coding groq llama-3.3-70b'));
    sent.length = 0; // drop the /setrole confirmation; assert only the /roles output
    await host.handleInbound(inbound('/roles'));

    assert.equal(driver.sentTurns.length, 0, '/roles is not forwarded');
    assert.equal(sent.length, 1);
    const out = sent[0]!.text;
    // merged map: the override for coding, the defaults for planning + reviewing.
    assert.ok(out.includes('coding → groq (llama-3.3-70b)') && out.includes('[override]'), out);
    assert.ok(out.includes('planning → claude') && out.includes('key: n/a'), out);
    assert.ok(out.includes('reviewing → openai') && out.includes('[default]'), out);
    // key presence: groq has a key → yes; openai has none → no.
    assert.ok(/coding → groq[^\n]*key: yes/.test(out), 'groq key present → yes');
    assert.ok(/reviewing → openai[^\n]*key: no/.test(out), 'openai key absent → no');
    // ★ the actual key value NEVER appears.
    assert.ok(!out.includes(FAKE_GROQ), 'the key VALUE must never appear in /roles');
    assert.ok(!out.includes('8888'), 'not even the masked tail — only a boolean');

    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

test('/roles with NO overrides shows all defaults', async () => {
  const t = tmpStateDir();
  try {
    const { host, bus, sent } = makeHost({ routingPath: t.routingPath });
    await host.start();
    await host.handleInbound(inbound('/roles'));
    const out = sent[0]!.text;
    assert.ok(out.includes('planning → claude'));
    assert.ok(out.includes('coding → deepseek (deepseek-v4-flash)'));
    assert.ok(out.includes('reviewing → openai (gpt-5-codex)'));
    assert.ok(!out.includes('[override]'), 'no overrides → all [default]');
    await host.stop();
    bus.close();
  } finally {
    t.cleanup();
  }
});

/* ── 5) ★ orchestrator-invokable setRoleRouting() through the SAME sole writer ──────────── */

test('★ setRoleRouting() (orchestrator-on-user-request) writes the SAME store as the typed command', async () => {
  const t = tmpStateDir();
  try {
    // setRoleRouting is a pure store-writer (no session turn) — it does not require a started
    // lifecycle, so we do NOT start()/stop() here (keeps the test free of the async session pump).
    const { host, bus, roleRoutingStore } = makeHost({ routingPath: t.routingPath, secretPath: t.secretPath });

    // "use Gemini for coding" → the orchestrator calls this method.
    const r = host.setRoleRouting('coding', 'gemini', 'gemini-2.5-flash');
    assert.ok(r.ok, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.role, 'coding');
      assert.equal(r.provider, 'gemini');
      assert.equal(r.model, 'gemini-2.5-flash');
      assert.equal(r.keyPresent, false, 'no Gemini key seeded');
    }
    // the SAME persisted store reflects it (one writer).
    assert.deepEqual(roleRoutingStore.get('coding'), { provider: 'gemini', model: 'gemini-2.5-flash' });

    // alias resolution + validation through the method too.
    assert.ok(host.setRoleRouting('reviewing', 'codex').ok, 'alias resolves');
    const bad = host.setRoleRouting('coding', 'mistral');
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.enabled && bad.error.includes('unknown provider'));
    const badRole = host.setRoleRouting('deploying', 'groq');
    assert.equal(badRole.ok, false);
    if (!badRole.ok) assert.ok(badRole.error.includes('unknown role'));

    bus.close();
  } finally {
    t.cleanup();
  }
});

test('setRoleRouting() reports enabled:false when no routing store is wired', async () => {
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
    // NO roleRoutingStore wired. setRoleRouting is a pure check here — no start() needed.
  });
  const r = host.setRoleRouting('coding', 'groq');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.enabled, false);
  bus.close();
});

/* ── 6) ★ DORMANT default-OFF: no routingStore → /setrole + /roles are normal turns ─────── */

test('★ with NO routingStore wired (dormant default), /setrole + /roles are normal turns (forwarded)', async () => {
  const bus = new IoBus();
  // Two awaitTurn steps so BOTH forwarded turns are cleanly consumed by the session pump.
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
    send: async () => ({ ok: true, sentIds: ['1'] }) as OutboundResult,
    policy: { allow: ['Read'] },
    // NO roleRoutingStore → byte-for-byte the current behavior.
  });
  await host.start();
  await host.handleInbound(inbound('/setrole coding groq'));
  await host.handleInbound(inbound('/roles'));
  // Both were forwarded as normal user turns (the dormant default — no interception).
  assert.equal(driver.sentTurns.length, 2);
  // ★ MODE-AWARENESS (dev-6ca1): the FIRST turn leads with the user text + a one-shot mode
  // notice appended; the second turn is exact (the notice is one-shot).
  assert.ok(driver.sentTurns[0]!.text.startsWith('/setrole coding groq'), 'first turn forwarded (leads)');
  assert.equal(driver.sentTurns[1]!.text, '/roles');
  await host.stop();
  bus.close();
});
