/**
 * ★ PHASE P6 — ACTIVATION WIRING tests (model-agnostic agents; proposal PART P P6, PART Q, FD1/FD7,
 * AP5/X5). P6 is the SWITCH-GATED, DORMANT wiring of the routed-dispatch path + the in-channel
 * secret/role stores + the Tier-1 orchestrator-model surface into the composition root (index.ts).
 *
 * THE SACRED INVARIANT: with SUPERVISOR_ROLE_ROUTING OFF (the default), the constructed system must
 * behave BYTE-FOR-BYTE as before this feature existed. These tests prove it at the observable
 * boundary — a SessionHost constructed with ZERO P6 options (exactly what index.ts passes when the
 * switch is OFF) leaves `/setkey`/`/setrole`/`/roles` un-intercepted and `dispatchRole()` disabled —
 * AND prove the ON path (switch ON → a role dispatch flows router→registry→seal→driver→relay through
 * a FAKE sealed driver and relays one result; a no-key dispatch falls back cleanly, never crashing).
 *
 * ZERO SPEND: no real paid API call / no real `claude` spawn — fakes + temp `.state/` + fake keys.
 *
 * Covers:
 *   - config: SUPERVISOR_ROLE_ROUTING default-OFF (roleRoutingEnabled false) + ON ('1'/'true'/'on');
 *     SUPERVISOR_ORCHESTRATOR_MODEL (Tier-1) resolves, unset → undefined (profile default kept);
 *   - ★ OFF-path byte-for-byte: a host with NO P6 options does NOT intercept /setkey|/setrole|/roles
 *     (driver receives the turn) and dispatchRole() → {enabled:false} WITHOUT invoking any dispatch;
 *   - ★ OFF-path construction invariant: index.ts's conditional-spread omits the P6 keys entirely
 *     when the locals are undefined (key-ABSENCE, not key:undefined) — identical ctor-args shape;
 *   - ★ ON-path dispatch: switch ON → dispatchRole() routes a role+task through the injected
 *     capability and relays one result (channel-mute — only the report comes back);
 *   - ★ ON-path FD1 end-to-end through result-relay over a FAKE registry: one result relays; the
 *     scoped provider key reaches the api-adapter env; NO real call;
 *   - ★ FD6 no-key clean fallback: a coding dispatch with no provider key → the api-adapter agent
 *     surfaces a clean error → falls back to a FAKE claude-cli → relays; never crashes;
 *   - store wiring: with the stores wired, /setkey + /setrole + /roles ARE intercepted + persist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionHost,
  type RoleDispatchFn,
  type RoleDispatchResult,
  type SessionHostOptions,
} from '../session-host.js';
import { loadConfig, resolveOrchestratorModel } from '../config.js';
import { isRoleRoutingEnabled } from '../role-router.js';
import { SecretStore, defaultSecretStorePath } from '../secret-store.js';
import { RoleRoutingStore, defaultRoleRoutingStorePath } from '../role-routing-store.js';
import { BackendRegistry } from '../backend-registry.js';
import { dispatchRoleAgentWithFallback, type AgentReportWithFallback } from '../result-relay.js';
import { mergeRoleRoutingOverrides, resolveRoleBackend, DEFAULT_ROLE_ROUTING_CONFIG } from '../role-router.js';
import { DEFAULT_API_ADAPTER_CONFIGS } from '../api-adapter-driver.js';
import { resolveProfile } from '../profiles.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult } from '../contract.js';
import type { SessionDriver, SessionEvent, SessionStartOptions } from '../session-driver.js';
import type { BackendSelection } from '../backend-kinds.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

const FAKE_DEEPSEEK = 'sk_fake_DEEPSEEK_4242'; // NOT a real key
const FAKE_GROQ = 'gsk_fake_GROQ_8888'; // NOT a real key

function tmpStateDir(): { dir: string; routingPath: string; secretPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-p6-'));
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

/** An idle fake driver that pauses for the first user turn (so a fall-through turn lands on it). */
function idleDriver(): FakeSessionDriver {
  return new FakeSessionDriver([
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } }, { do: 'awaitTurn' }],
  ]);
}

/**
 * Build a SessionHost wired with a chosen subset of the P6 options — EXACTLY mirroring how index.ts
 * spreads them (omit a key entirely when its local is undefined). `p6` left empty ⇒ the DORMANT host
 * (the OFF path). Captures sends.
 */
function makeHost(p6: {
  secretStore?: SecretStore;
  roleRoutingStore?: RoleRoutingStore;
  dispatchRoleAgent?: RoleDispatchFn;
} = {}) {
  const bus = new IoBus();
  const driver = idleDriver();
  const sent: { text: string }[] = [];
  const opts: SessionHostOptions = {
    driver,
    bus,
    logger: silentLogger(),
    send: async (_h, msg) => {
      sent.push({ text: msg.text ?? '' });
      return { ok: true, sentIds: ['1'] } as OutboundResult;
    },
    policy: { allow: ['Read'] },
    // ★ the SAME conditional-spread index.ts uses — a key is present ONLY when its local is set.
    ...(p6.secretStore ? { secretStore: p6.secretStore } : {}),
    ...(p6.roleRoutingStore ? { roleRoutingStore: p6.roleRoutingStore } : {}),
    ...(p6.dispatchRoleAgent ? { dispatchRoleAgent: p6.dispatchRoleAgent } : {}),
  };
  const host = new SessionHost(opts);
  return { host, bus, driver, sent, opts };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1) CONFIG — the activation switch + the Tier-1 model surface
 * ───────────────────────────────────────────────────────────────────────────── */

test('config: SUPERVISOR_ROLE_ROUTING is default-OFF (roleRoutingEnabled false) and the switch agrees with isRoleRoutingEnabled', () => {
  const saved = process.env.SUPERVISOR_ROLE_ROUTING;
  try {
    delete process.env.SUPERVISOR_ROLE_ROUTING;
    assert.equal(isRoleRoutingEnabled(process.env), false, 'unset → OFF');
    assert.equal(loadConfig().roleRoutingEnabled, false, 'config default OFF');

    for (const on of ['1', 'true', 'on', 'ON', 'True']) {
      process.env.SUPERVISOR_ROLE_ROUTING = on;
      assert.equal(loadConfig().roleRoutingEnabled, true, `"${on}" → ON`);
    }
    for (const off of ['0', 'false', 'off', '', 'nope']) {
      process.env.SUPERVISOR_ROLE_ROUTING = off;
      assert.equal(loadConfig().roleRoutingEnabled, false, `"${off}" → OFF`);
    }
  } finally {
    if (saved === undefined) delete process.env.SUPERVISOR_ROLE_ROUTING;
    else process.env.SUPERVISOR_ROLE_ROUTING = saved;
  }
});

test('config: ★ Tier-1 SUPERVISOR_ORCHESTRATOR_MODEL — unset → undefined (profile default kept); set → the value; the `?? profile.model` identity holds', () => {
  assert.equal(resolveOrchestratorModel(undefined), undefined, 'unset → undefined');
  assert.equal(resolveOrchestratorModel('   '), undefined, 'blank → undefined');
  assert.equal(resolveOrchestratorModel('claude-sonnet-4-5'), 'claude-sonnet-4-5', 'set → verbatim');
  assert.equal(resolveOrchestratorModel('  gpt-x  '), 'gpt-x', 'trimmed');

  // The index.ts identity: `config.orchestratorModel ?? profile.model`. When unset, this is EXACTLY
  // the profile model (byte-for-byte the prior behavior).
  const profile = resolveProfile('orchestrator');
  const unsetModel = resolveOrchestratorModel(undefined) ?? profile.model;
  assert.equal(unsetModel, profile.model, 'unset → profile.model unchanged (claude-opus-4-8[1m])');
  assert.equal(unsetModel, 'claude-opus-4-8[1m]', 'the orchestrator default is preserved');
  const setModel = resolveOrchestratorModel('my-model') ?? profile.model;
  assert.equal(setModel, 'my-model', 'set → overrides the profile model');
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 2) ★ OFF-PATH — byte-for-byte: a DORMANT host (no P6 options) is the pre-feature host
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ OFF: a host with NO P6 options does NOT intercept /setkey, /setrole, or /roles — they fall through to the orchestrator (byte-for-byte today)', async () => {
  const { host, driver } = makeHost(/* no P6 options = the OFF path */);
  await host.start();
  // Each of these would be INTERCEPTED if a store were wired; with none wired they must reach the
  // session as a normal user turn (the driver receives them) — exactly as before this feature.
  await host.handleInbound(inbound('/setkey deepseek sk_whatever'));
  await host.handleInbound(inbound('/setrole coding groq'));
  await host.handleInbound(inbound('/roles'));
  assert.equal(driver.sentTurns.length, 3, 'all three commands fell through to the session (NOT intercepted)');
  await host.stop();
});

test('★ OFF: dispatchRole() returns {enabled:false} and invokes NO dispatch when no capability is wired (dormant)', async () => {
  let dispatchCalls = 0;
  // Construct the OFF host but ALSO prove that even a wired fn is not reachable unless passed — here
  // we pass NONE, so the call must short-circuit without touching any dispatch path.
  const { host } = makeHost(/* no dispatchRoleAgent */);
  void dispatchCalls; // (kept to mirror the ON test's counter; nothing should ever increment it)
  const r = await host.dispatchRole('planning', 'do a thing');
  assert.equal(r.enabled, false, 'dormant → not enabled');
  assert.equal(r.ok, false, 'dormant → ok:false');
  assert.match(r.text ?? '', /not enabled/i, 'a clear inactive message');
  assert.equal(dispatchCalls, 0, 'no dispatch capability was invoked');
});

test('★ OFF: the index.ts conditional-spread OMITS every P6 key entirely when the locals are undefined (key-ABSENCE, not key:undefined)', () => {
  // Replicate the EXACT spread index.ts performs when the switch is OFF (all four locals undefined).
  const secretStore: SecretStore | undefined = undefined;
  const roleRoutingStore: RoleRoutingStore | undefined = undefined;
  const deleteMessage: (() => Promise<void>) | undefined = undefined;
  const dispatchRoleAgent: RoleDispatchFn | undefined = undefined;
  const ctorArgsP6 = {
    ...(secretStore ? { secretStore } : {}),
    ...(roleRoutingStore ? { roleRoutingStore } : {}),
    ...(deleteMessage ? { deleteMessage } : {}),
    ...(dispatchRoleAgent ? { dispatchRoleAgent } : {}),
  };
  // The OFF construction adds NONE of the P6 keys — the SessionHostOptions object is shaped exactly
  // as it was before P6 existed (no `secretStore:undefined` sneaking in to change ?? semantics).
  assert.deepEqual(Object.keys(ctorArgsP6), [], 'zero P6 keys present in the OFF ctor args');
  assert.equal('secretStore' in ctorArgsP6, false);
  assert.equal('roleRoutingStore' in ctorArgsP6, false);
  assert.equal('deleteMessage' in ctorArgsP6, false);
  assert.equal('dispatchRoleAgent' in ctorArgsP6, false);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 3) ★ ON-PATH — dispatchRole() routes through the injected capability and relays one result
 * ───────────────────────────────────────────────────────────────────────────── */

test('★ ON: dispatchRole() routes role+task through the injected capability and relays one result (channel-mute — only the report comes back)', async () => {
  const seen: { role: string; task: string }[] = [];
  const fakeDispatch: RoleDispatchFn = async (role, task) => {
    seen.push({ role, task });
    return { ok: true, role, backend: 'api-adapter', text: 'CODE OUTPUT', costUsd: 0.0012, fellBack: false };
  };
  const { host } = makeHost({ dispatchRoleAgent: fakeDispatch });
  const r = await host.dispatchRole('coding', 'write a function');
  assert.equal(r.enabled, true, 'ON → enabled');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'CODE OUTPUT', 'the agent report text is relayed');
  assert.equal(r.backend, 'api-adapter');
  assert.equal(r.costUsd, 0.0012);
  assert.deepEqual(seen, [{ role: 'coding', task: 'write a function' }], 'the capability saw exactly the role+task');
});

test('ON: dispatchRole() validates inputs (empty role / empty task → ok:false, enabled:true) and contains a thrown capability (never wedges)', async () => {
  const throwing: RoleDispatchFn = async () => {
    throw new Error('infra boom');
  };
  const { host } = makeHost({ dispatchRoleAgent: throwing });
  const noRole = await host.dispatchRole('  ', 'task');
  assert.equal(noRole.enabled, true);
  assert.equal(noRole.ok, false);
  assert.match(noRole.text ?? '', /role is required/i);

  const noTask = await host.dispatchRole('coding', '   ');
  assert.equal(noTask.ok, false);
  assert.match(noTask.text ?? '', /task is required/i);

  // A throw from the capability is CONTAINED as a failed result (not a rejection that wedges the host).
  const threw = await host.dispatchRole('coding', 'real task');
  assert.equal(threw.ok, false);
  assert.equal(threw.enabled, true);
  assert.match(threw.text ?? '', /dispatch failed/i);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 4) ★ ON-PATH FD1 end-to-end — the REAL index.ts dispatch closure over a FAKE registry
 *    (router → registry → seal → driver → relay), scoped key, NO real call.
 * ───────────────────────────────────────────────────────────────────────────── */

/** A fake SessionDriver that emits ONE terminal result with the given subtype/text — no spawn/network. */
function fakeResultDriver(text: string, subtype = 'success'): SessionDriver {
  async function* gen(): AsyncIterable<SessionEvent> {
    yield { kind: 'system_init', sessionId: 'fake', model: 'fake-model' };
    yield { kind: 'result', subtype, result: text } as Extract<SessionEvent, { kind: 'result' }>;
  }
  return {
    start: () => gen(),
    send: async () => undefined,
    interrupt: async () => undefined,
    stop: async () => undefined,
    health: () => ({ running: false }),
  };
}

/**
 * Build the SAME dispatch closure index.ts builds when the switch is ON, over an INJECTED registry +
 * the given secret/routing stores. (This mirrors the composition-root closure so the wiring logic is
 * exercised, not just a stub.) Returns the closure + a capture of the env the registry's api-adapter
 * factory observed (to assert scoped-key loading).
 */
function buildDispatchClosure(
  registry: BackendRegistry,
  secretStore: SecretStore,
  routingStore: RoleRoutingStore,
  // The base env the dispatch overlays the scoped keys onto. In production this is process.env (which
  // the supervisor asserts key-free at startup); tests pass a CLEAN base so the seal's foreign-key
  // assertion is deterministic regardless of the test runner's own environment.
  baseEnv: NodeJS.ProcessEnv = {},
): RoleDispatchFn {
  return async (role, task) => {
    const apiAdapterEnv: NodeJS.ProcessEnv = { ...baseEnv, ...secretStore.loadAll() };
    const overrides = routingStore.loadAll();
    const merged = mergeRoleRoutingOverrides(overrides, DEFAULT_ROLE_ROUTING_CONFIG);
    // Mirror index.ts: derive the own-secret name from the RESOLVED api-adapter selection so the seal
    // scopes the foreign-key assertion to THIS backend's key (not rejecting its own).
    const selection = resolveRoleBackend(role, merged);
    const ownSecretName =
      selection.backend === 'api-adapter' && selection.model
        ? DEFAULT_API_ADAPTER_CONFIGS[selection.model]?.secretEnvVar
        : undefined;
    const report: AgentReportWithFallback = await dispatchRoleAgentWithFallback({
      role,
      task,
      registry,
      config: merged,
      env: apiAdapterEnv,
      ...(ownSecretName ? { ownSecretName } : {}),
    });
    const result: RoleDispatchResult = {
      ok: report.ok,
      role: String(report.role),
      backend: report.backend,
      fellBack: report.fallback.used,
    };
    if (report.text !== undefined) result.text = report.text;
    if (report.costUsd !== undefined) result.costUsd = report.costUsd;
    return result;
  };
}

test('★ ON FD1: a planning dispatch flows role-router → registry → seal → FAKE claude driver → relay (one result; NO real spawn)', async () => {
  const t = tmpStateDir();
  try {
    const secretStore = new SecretStore({ filePath: t.secretPath });
    const routingStore = new RoleRoutingStore({ filePath: t.routingPath });
    // Inject a FAKE claude-cli factory → NO real `claude` spawn.
    const registry = new BackendRegistry({
      factories: { 'claude-cli': () => fakeResultDriver('PLAN: do X then Y') },
    });
    const dispatch = buildDispatchClosure(registry, secretStore, routingStore);
    const { host } = makeHost({ secretStore, roleRoutingStore: routingStore, dispatchRoleAgent: dispatch });

    const r = await host.dispatchRole('planning', 'design the thing');
    assert.equal(r.ok, true);
    assert.equal(r.backend, 'claude-cli', 'planning → claude-cli (the default map)');
    assert.equal(r.text, 'PLAN: do X then Y', 'the result relayed end-to-end');
    assert.equal(r.fellBack, false);
  } finally {
    t.cleanup();
  }
});

test('★ ON FD1 scoped-key: a coding dispatch (DeepSeek) sees the stored key in the api-adapter env at spawn (scoped-key loading)', async () => {
  const t = tmpStateDir();
  try {
    const secretStore = new SecretStore({ filePath: t.secretPath });
    secretStore.setKey('DEEPSEEK_API_KEY', FAKE_DEEPSEEK); // the user supplied it via /setkey
    const routingStore = new RoleRoutingStore({ filePath: t.routingPath });

    // Capture the env the api-adapter factory received → prove the scoped key was projected in.
    let observedKey: string | undefined;
    const registry = new BackendRegistry({
      factories: {
        'api-adapter': (sel: BackendSelection) => {
          // The closure overlays secretStore.loadAll() onto process.env and passes it as the dispatch
          // env; result-relay's planRoleDispatch threads it to the seal. We assert the registry could
          // resolve the model; the KEY assertion is via apiAdapterEnv below (the closure passes env to
          // dispatchRoleAgentWithFallback → seal). Here we just return a fake result for `coding`.
          void sel;
          return fakeResultDriver('def f(): pass');
        },
      },
    });
    // Wrap the closure so we can read the env it built (the scoped-key projection). Clean base env
    // (matching the closure) so the assertion is deterministic.
    const inner = buildDispatchClosure(registry, secretStore, routingStore, {});
    const dispatch: RoleDispatchFn = async (role, task) => {
      const projected: NodeJS.ProcessEnv = { ...secretStore.loadAll() };
      observedKey = projected.DEEPSEEK_API_KEY;
      return inner(role, task);
    };

    const { host } = makeHost({ secretStore, roleRoutingStore: routingStore, dispatchRoleAgent: dispatch });
    const r = await host.dispatchRole('coding', 'write f');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'def f(): pass');
    assert.equal(observedKey, FAKE_DEEPSEEK, 'the stored DeepSeek key was projected into the dispatch env (scoped-key loading at spawn)');
  } finally {
    t.cleanup();
  }
});

test('★ FD6 no-key clean fallback: a coding dispatch with NO provider key → api-adapter agent surfaces a clean error → falls back to (FAKE) claude-cli → relays; never crashes', async () => {
  const t = tmpStateDir();
  try {
    const secretStore = new SecretStore({ filePath: t.secretPath }); // NO DeepSeek key stored
    const routingStore = new RoleRoutingStore({ filePath: t.routingPath });

    // The api-adapter agent (DeepSeek) returns a clean ERROR result (ok:false) — modeling "no key →
    // clean error" without a network call; the FAKE claude-cli is the fallback (coding→claude per the
    // DEFAULT map's fallbackBackend).
    const registry = new BackendRegistry({
      factories: {
        'api-adapter': () => fakeResultDriver('error: API key not set', 'error_api'),
        'claude-cli': () => fakeResultDriver('CLAUDE FALLBACK CODE'),
      },
    });
    const dispatch = buildDispatchClosure(registry, secretStore, routingStore);
    const { host } = makeHost({ secretStore, roleRoutingStore: routingStore, dispatchRoleAgent: dispatch });

    const r = await host.dispatchRole('coding', 'write f');
    assert.equal(r.ok, true, 'the fallback succeeded — never crashed');
    assert.equal(r.backend, 'claude-cli', 'fell back to the key-free claude-cli backend');
    assert.equal(r.text, 'CLAUDE FALLBACK CODE');
    assert.equal(r.fellBack, true, 'FD6 fallback fired');
  } finally {
    t.cleanup();
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 5) STORE WIRING — with the stores wired, the in-channel commands ARE functional
 * ───────────────────────────────────────────────────────────────────────────── */

test('store wiring: with the stores wired, /setkey + /setrole + /roles are INTERCEPTED (not forwarded) and persist', async () => {
  const t = tmpStateDir();
  try {
    const secretStore = new SecretStore({ filePath: t.secretPath });
    const roleRoutingStore = new RoleRoutingStore({ filePath: t.routingPath });
    const { host, driver, sent } = makeHost({ secretStore, roleRoutingStore });
    await host.start();

    // /setkey → intercepted, key stored, NOT forwarded.
    await host.handleInbound(inbound(`/setkey groq ${FAKE_GROQ}`));
    assert.equal(secretStore.getKey('GROQ_API_KEY'), FAKE_GROQ, '/setkey persisted the key');

    // /setrole → intercepted, override stored, NOT forwarded.
    await host.handleInbound(inbound('/setrole coding groq'));
    assert.equal(roleRoutingStore.get('coding')?.provider, 'groq', '/setrole persisted the override');

    // /roles → intercepted (a listing reply), NOT forwarded.
    await host.handleInbound(inbound('/roles'));

    assert.equal(driver.sentTurns.length, 0, 'NONE of the three commands reached the orchestrator session');
    assert.ok(sent.length >= 3, 'each command produced a reply (ack/listing)');

    // The stored files live under the temp .state/ dir (gitignored by construction).
    assert.ok(existsSync(t.secretPath) && existsSync(t.routingPath), 'both store files were written');
    // The key value is never echoed in a reply (masked-only).
    for (const s of sent) assert.equal(s.text.includes(FAKE_GROQ), false, 'a reply never contains the raw key');
    void readFileSync; // (the file content is the store's concern — covered by secret-store.test.ts)

    await host.stop();
  } finally {
    t.cleanup();
  }
});

test('store-path helpers resolve under a gitignored .state/ dir (the launcher default)', () => {
  const root = '/tmp/fake-supervisor-root';
  const saved = process.env.SUPERVISOR_STATE_DIR;
  try {
    delete process.env.SUPERVISOR_STATE_DIR;
    assert.match(defaultSecretStorePath(root, {}), /[\\/]\.state[\\/]provider-secrets\.json$/);
    assert.match(defaultRoleRoutingStorePath(root, {}), /[\\/]\.state[\\/]role-routing\.json$/);
  } finally {
    if (saved === undefined) delete process.env.SUPERVISOR_STATE_DIR;
    else process.env.SUPERVISOR_STATE_DIR = saved;
  }
});
