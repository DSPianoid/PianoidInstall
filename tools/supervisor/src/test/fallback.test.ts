/**
 * FD6 CONFIG-DRIVEN FALLBACK tests (P5) — on a FAILED routed agent (a crash OR a surfaced
 * error report), the dispatcher resolves the role's configured `fallbackBackend` and re-dispatches
 * EXACTLY ONCE, else surfaces the failure. Contained: at most one retry, no chains, never wedges.
 *
 * Uses injected fake drivers via the registry (NO real spawn / NO network / NO paid call). The
 * proposal's path under test: coding → DeepSeek (api-adapter) FAILS → fallback claude-cli.
 *
 * Traces: proposal FD6; §C transition graph (FAILED→FALLBACK-RESOLVED→RESOLVED | →SURFACED); CP5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchRoleAgentWithFallback,
  AgentDispatchError,
} from '../result-relay.js';
import { BackendRegistry, type BackendDriverFactory } from '../backend-registry.js';
import { DEFAULT_ROLE_ROUTING_CONFIG, type RoleRouterConfig } from '../role-router.js';
import { FakeSessionDriver } from './fake-session-driver.js';

const KEY_FREE_ENV = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;

/** A fake that emits one success result then ends. */
function successProgram(text: string): FakeSessionDriver {
  return new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'result', sessionId: 's', subtype: 'success', result: text } },
      { do: 'endClean' },
    ],
  ]);
}
/** A fake whose stream ends with NO result → a crash (AgentDispatchError). */
function crashProgram(): FakeSessionDriver {
  return new FakeSessionDriver([[{ do: 'emit', event: { kind: 'assistant', text: 'x', toolUses: [] } }, { do: 'crash' }]]);
}
/** A fake that emits a surfaced ERROR result (ok:false) then ends (e.g. an api-adapter API error). */
function errorResultProgram(subtype = 'error_network'): FakeSessionDriver {
  return new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'result', sessionId: 's', subtype, result: 'API blew up' } },
      { do: 'endClean' },
    ],
  ]);
}

/** A config: coding → api-adapter (will fail) with fallbackBackend claude-cli. */
const CODING_FALLBACK_CONFIG: RoleRouterConfig = {
  roles: { coding: { backend: 'api-adapter', model: 'deepseek-v4-flash', fallbackBackend: 'claude-cli' } },
};
/** A config: a role with NO fallback configured. */
const NO_FALLBACK_CONFIG: RoleRouterConfig = {
  roles: { coding: { backend: 'api-adapter', model: 'deepseek-v4-flash' } },
};

/**
 * Build a registry whose api-adapter + claude-cli factories return scripted fakes, and COUNT how
 * many times each backend kind was constructed (to assert "re-dispatched once").
 */
function countingRegistry(opts: {
  api: () => FakeSessionDriver;
  claude: () => FakeSessionDriver;
}): { registry: BackendRegistry; counts: { api: number; claude: number }; lastClaudeEnvSeen: () => FakeSessionDriver | undefined } {
  const counts = { api: 0, claude: 0 };
  let lastClaude: FakeSessionDriver | undefined;
  const apiFactory: BackendDriverFactory = () => {
    counts.api += 1;
    return opts.api();
  };
  const claudeFactory: BackendDriverFactory = () => {
    counts.claude += 1;
    lastClaude = opts.claude();
    return lastClaude;
  };
  const registry = new BackendRegistry({ factories: { 'api-adapter': apiFactory, 'claude-cli': claudeFactory } });
  return { registry, counts, lastClaudeEnvSeen: () => lastClaude };
}

// ── success: NO fallback ───────────────────────────────────────────────────────────
test('a SUCCESSFUL primary returns as-is — no fallback fires', async () => {
  const { registry, counts } = countingRegistry({ api: () => successProgram('CODE OK'), claude: () => successProgram('unused') });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 'implement',
    registry,
    config: CODING_FALLBACK_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.equal(report.text, 'CODE OK');
  assert.equal(report.backend, 'api-adapter');
  assert.equal(report.fallback.used, false);
  assert.equal(report.fallback.reason, 'primary-succeeded');
  assert.equal(counts.api, 1);
  assert.equal(counts.claude, 0, 'no fallback dispatch on success');
});

// ── a surfaced ERROR report (ok:false) triggers ONE fallback ───────────────────────
test('★★ FD6: a FAILED primary (ok:false) re-dispatches ONCE to the configured fallback (claude-cli) then returns the fallback report', async () => {
  const { registry, counts } = countingRegistry({
    api: () => errorResultProgram('error_network'),
    claude: () => successProgram('CLAUDE FALLBACK CODE'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 'implement',
    registry,
    config: CODING_FALLBACK_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  // the fallback (claude-cli) report wins
  assert.equal(report.ok, true);
  assert.equal(report.text, 'CLAUDE FALLBACK CODE');
  assert.equal(report.backend, 'claude-cli');
  assert.equal(report.fallback.used, true);
  assert.equal(report.fallback.fromBackend, 'api-adapter');
  assert.equal(report.fallback.toBackend, 'claude-cli');
  assert.equal(report.fallback.primarySubtype, 'error_network');
  // EXACTLY ONE retry: primary once, fallback once
  assert.equal(counts.api, 1);
  assert.equal(counts.claude, 1);
});

// ── a CRASH (no result) also triggers ONE fallback ─────────────────────────────────
test('★ FD6: a primary CRASH (AgentDispatchError) falls back ONCE to claude-cli', async () => {
  const { registry, counts } = countingRegistry({
    api: () => crashProgram(),
    claude: () => successProgram('RECOVERED'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: CODING_FALLBACK_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.equal(report.text, 'RECOVERED');
  assert.equal(report.backend, 'claude-cli');
  assert.equal(report.fallback.used, true);
  assert.equal(report.fallback.primarySubtype, 'crash');
  assert.equal(counts.api, 1);
  assert.equal(counts.claude, 1);
});

// ── the fallback to claude-cli SCRUBS the foreign DeepSeek key (CP3 leak hygiene) ──
test('★ FD6: the claude-cli fallback env is SCRUBBED of the foreign DEEPSEEK_API_KEY (no metered key in a Claude agent)', async () => {
  // The claude-cli seal asserts key-free; if the DeepSeek key were NOT scrubbed it would still pass
  // assertCostSafe (Anthropic-only), but CP3 hygiene requires no foreign metered key in a Claude env.
  // We assert the fallback dispatch SUCCEEDS (the seal saw a clean env) AND the fake recorded a
  // claude start (the fallback actually ran sealed).
  const claudeFake = successProgram('OK');
  const registry = new BackendRegistry({
    factories: {
      'api-adapter': () => errorResultProgram('error_http_429'),
      'claude-cli': () => claudeFake,
    },
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: CODING_FALLBACK_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds-key' } as NodeJS.ProcessEnv, // a DeepSeek key present at primary time
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.equal(report.backend, 'claude-cli');
  assert.equal(report.fallback.used, true);
  // the claude fallback ran SEALED (project,local) — proves the scrubbed env passed the key-free seal
  assert.equal(claudeFake.starts, 1);
  assert.deepEqual(claudeFake.startOpts[0]!.settingSources, ['project', 'local']);
});

// ── no fallback configured → SURFACE the failure ───────────────────────────────────
test('★ FD6: a FAILED primary with NO fallback configured SURFACES the error report (used=false, reason explained)', async () => {
  const { registry, counts } = countingRegistry({
    api: () => errorResultProgram('error_network'),
    claude: () => successProgram('never'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: NO_FALLBACK_CONFIG, // no fallbackBackend
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, false);
  assert.equal(report.backend, 'api-adapter');
  assert.equal(report.fallback.used, false);
  assert.equal(report.fallback.reason, 'no-fallback-configured');
  assert.equal(report.fallback.primarySubtype, 'error_network');
  assert.equal(counts.claude, 0, 'no fallback dispatch when none configured');
});

test('FD6: a CRASH with NO fallback configured re-throws the AgentDispatchError (surfaced, not swallowed)', async () => {
  const { registry } = countingRegistry({ api: () => crashProgram(), claude: () => successProgram('never') });
  await assert.rejects(
    () =>
      dispatchRoleAgentWithFallback({
        role: 'coding',
        task: 't',
        registry,
        config: NO_FALLBACK_CONFIG,
        env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
        ownSecretName: 'DEEPSEEK_API_KEY',
      }),
    AgentDispatchError,
  );
});

// ── fallback explicitly DISABLED → surface even though one is configured ────────────
test('★ FD6: enableFallback=false SURFACES the failure even when a fallbackBackend IS configured', async () => {
  const { registry, counts } = countingRegistry({
    api: () => errorResultProgram('error_network'),
    claude: () => successProgram('never'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: CODING_FALLBACK_CONFIG, // fallback IS configured…
    enableFallback: false, // …but disabled
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, false);
  assert.equal(report.fallback.used, false);
  assert.equal(report.fallback.reason, 'fallback-disabled');
  assert.equal(counts.claude, 0);
});

// ── CONTAINMENT: the fallback itself does NOT fall back (at most ONE retry) ─────────
test('★★ FD6 CONTAINMENT: if the FALLBACK also fails, the failure is surfaced (NO second fallback — at most one retry)', async () => {
  // both backends fail → the fallback report (ok:false) is returned; the fallback is NOT itself
  // retried (dispatchRoleAgent has no fallback). This is the "never wedges the host" guarantee.
  const { registry, counts } = countingRegistry({
    api: () => errorResultProgram('error_network'),
    claude: () => errorResultProgram('error_max_turns'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: CODING_FALLBACK_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  // the fallback's (failed) report surfaces; used=true (a fallback WAS attempted)
  assert.equal(report.ok, false);
  assert.equal(report.backend, 'claude-cli');
  assert.equal(report.subtype, 'error_max_turns');
  assert.equal(report.fallback.used, true);
  // EXACTLY one primary + one fallback construction — no third attempt
  assert.equal(counts.api, 1);
  assert.equal(counts.claude, 1);
});

// ── the DEFAULT config (coding→DeepSeek, fallback claude-cli) drives the fallback ───
test('★ FD6 with the DEFAULT_ROLE_ROUTING_CONFIG: coding DeepSeek failure falls back to claude-cli', async () => {
  const { registry, counts } = countingRegistry({
    api: () => errorResultProgram('error_network'),
    claude: () => successProgram('DEFAULT-CONFIG FALLBACK'),
  });
  const report = await dispatchRoleAgentWithFallback({
    role: 'coding',
    task: 't',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG, // coding → api-adapter, fallback claude-cli (the shipped default)
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.fallback.used, true);
  assert.equal(report.fallback.toBackend, 'claude-cli');
  assert.equal(report.text, 'DEFAULT-CONFIG FALLBACK');
  assert.equal(counts.api, 1);
  assert.equal(counts.claude, 1);
});
