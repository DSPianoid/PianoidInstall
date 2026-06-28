/**
 * BACKEND REGISTRY tests (P1 / M3) — the registry constructs the concrete
 * SessionDriver for a backend kind: claude-cli → a real CliStreamDriver (REUSE);
 * api-adapter → unimplemented (throws) in P1; an injected factory wins (so tests
 * substitute a fake driver — no real spawn). No network, no process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendRegistry, BackendRegistryError } from '../backend-registry.js';
import { CliStreamDriver } from '../adapters/cli-stream-driver.js';
import { ApiAdapterDriver } from '../api-adapter-driver.js';
import type { BackendSelection } from '../backend-kinds.js';
import { FakeSessionDriver } from './fake-session-driver.js';

const claudeSel: BackendSelection = { role: 'planning', backend: 'claude-cli', model: 'claude-opus-4-8[1m]' };
const apiSel: BackendSelection = { role: 'coding', backend: 'api-adapter', model: 'deepseek-v4-flash' };
/** An HTTP client that never makes a real call (and is never invoked by mere construction). */
const NOOP_HTTP = { stream: async () => (async function* () {})() };

test('★ claude-cli selection constructs a CliStreamDriver (reuse, not reinvent)', () => {
  const registry = new BackendRegistry();
  assert.equal(registry.has('claude-cli'), true);
  const driver = registry.create(claudeSel);
  assert.ok(driver instanceof CliStreamDriver, 'claude-cli must construct a CliStreamDriver');
  // the constructed driver satisfies the contract surface
  assert.equal(typeof driver.start, 'function');
  assert.equal(typeof driver.send, 'function');
  assert.equal(typeof driver.stop, 'function');
  assert.equal(typeof driver.health, 'function');
});

test('the default claude-cli factory forwards CliStreamDriver options (injectable spawn) — no real claude spawned', () => {
  let spawnCalls = 0;
  const registry = new BackendRegistry({
    cliStreamOptions: {
      // an injected spawnFn means even the REAL CliStreamDriver never spawns `claude`
      spawnFn: () => {
        spawnCalls++;
        return {
          stdout: (async function* () {})(),
          stdin: { write() {}, end() {} },
          kill() {},
        };
      },
    },
  });
  const driver = registry.create(claudeSel) as CliStreamDriver;
  assert.ok(driver instanceof CliStreamDriver);
  // construction alone does not spawn; the injected spawn is only used on start()
  assert.equal(spawnCalls, 0);
});

test('★ api-adapter selection NOW constructs an ApiAdapterDriver (P3 — DeepSeek=coding)', () => {
  // injected HTTP client → NO real (paid) call is possible; construction alone never calls it.
  const registry = new BackendRegistry({ apiAdapterHttpClient: NOOP_HTTP });
  assert.equal(registry.has('api-adapter'), true);
  const driver = registry.create(apiSel);
  assert.ok(driver instanceof ApiAdapterDriver, 'api-adapter must construct an ApiAdapterDriver');
  assert.equal(typeof driver.start, 'function');
  assert.equal(driver.health().detail, 'api-adapter-driver:deepseek');
});

test('api-adapter falls back to the DeepSeek config when the model is unmapped', () => {
  const registry = new BackendRegistry({ apiAdapterHttpClient: NOOP_HTTP });
  const driver = registry.create({ role: 'coding', backend: 'api-adapter', model: 'some-unknown-model' });
  assert.ok(driver instanceof ApiAdapterDriver);
  assert.equal(driver.health().detail, 'api-adapter-driver:deepseek');
});

test('api-adapter config map can be overridden (forward-compat for Codex at P4)', () => {
  const registry = new BackendRegistry({
    apiAdapterHttpClient: NOOP_HTTP,
    apiAdapterConfigs: {
      'gpt-5-codex': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-codex', secretEnvVar: 'OPENAI_API_KEY', label: 'codex' },
    },
  });
  const driver = registry.create({ role: 'reviewing', backend: 'api-adapter', model: 'gpt-5-codex' });
  assert.ok(driver instanceof ApiAdapterDriver);
  assert.equal(driver.health().detail, 'api-adapter-driver:codex');
});

test('an UNKNOWN backend kind throws BackendRegistryError', () => {
  const registry = new BackendRegistry();
  // cast through unknown to construct a deliberately invalid selection (a future/unregistered kind).
  const bad = { role: 'x', backend: 'mystery-backend' } as unknown as BackendSelection;
  assert.throws(() => registry.create(bad), BackendRegistryError);
});

test('★ an injected factory WINS over the built-in (tests substitute a fake driver)', () => {
  const fake = new FakeSessionDriver([[{ do: 'endClean' }]]);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });
  const driver = registry.create(claudeSel);
  assert.strictEqual(driver, fake, 'the injected factory must be used');
  assert.ok(!(driver instanceof CliStreamDriver));
});

test('an injected api-adapter factory makes that kind constructible (forward-compat for P3)', () => {
  const fake = new FakeSessionDriver([[{ do: 'endClean' }]]);
  const registry = new BackendRegistry({ factories: { 'api-adapter': () => fake } });
  assert.equal(registry.has('api-adapter'), true);
  assert.strictEqual(registry.create(apiSel), fake);
});
