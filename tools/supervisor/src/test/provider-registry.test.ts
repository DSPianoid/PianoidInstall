/**
 * PROVIDER REGISTRY tests — the model-agnostic "any OpenAI-compatible provider pluggable by
 * config" foundation. Asserts:
 *   - the 4 wired providers (deepseek, openai/codex, groq, gemini) carry the documented
 *     base-URL / secret-env-var / openAiCompatible, with model ids as CONFIGURABLE placeholders;
 *   - each provider PROJECTS to a correctly-parameterized {@link ApiAdapterConfig} the EXISTING
 *     ApiAdapterDriver consumes (base-URL/model/secret) — proving "one adapter serves all";
 *   - the derived default config map keys on each provider's default model;
 *   - the derived per-provider secret map drives cross-provider key scoping — a foreign key for
 *     EVERY (agent-provider, foreign-provider) pair is rejected (via assertBackendCostSafe);
 *   - alias resolution (codex→openai, google→gemini) and unknown-token handling.
 *
 * Pure — no I/O, no network, NO real key, zero spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_ALIASES,
  isProviderId,
  resolveProviderId,
  getProvider,
  apiAdapterConfigForProvider,
  buildDefaultApiAdapterConfigs,
  buildProviderSecretEnvVars,
  type ProviderId,
} from '../provider-registry.js';
import { ApiAdapterDriver, DEFAULT_API_ADAPTER_CONFIGS } from '../api-adapter-driver.js';
import {
  assertBackendCostSafe,
  inspectBackendCostSafety,
  BackendCostSafetyError,
  BACKEND_SECRET_ENV_VARS,
  ALL_BACKEND_SECRET_ENV_VARS,
} from '../cost-safety.js';

/* ── 1) the wired provider set ──────────────────────────────────────────────── */

test('the registry wires exactly the four providers (deepseek, openai, groq, gemini)', () => {
  assert.deepEqual([...PROVIDER_IDS].sort(), ['deepseek', 'gemini', 'groq', 'openai']);
});

test('each provider carries the documented base-URL + secret env var + openAiCompatible', () => {
  assert.equal(DEFAULT_PROVIDERS.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(DEFAULT_PROVIDERS.deepseek.secretEnvVar, 'DEEPSEEK_API_KEY');

  assert.equal(DEFAULT_PROVIDERS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(DEFAULT_PROVIDERS.openai.secretEnvVar, 'OPENAI_API_KEY');

  // Groq — OpenAI-compatible API per the spec.
  assert.equal(DEFAULT_PROVIDERS.groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(DEFAULT_PROVIDERS.groq.secretEnvVar, 'GROQ_API_KEY');

  // Gemini — via its OpenAI-COMPATIBILITY endpoint per the spec (so the SAME adapter serves it).
  assert.equal(DEFAULT_PROVIDERS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  assert.equal(DEFAULT_PROVIDERS.gemini.secretEnvVar, 'GEMINI_API_KEY');

  for (const id of PROVIDER_IDS) {
    assert.equal(DEFAULT_PROVIDERS[id].openAiCompatible, true, `${id} must be OpenAI-compatible`);
    // model ids are configurable PLACEHOLDERS — present + non-empty (the real one is set before P6).
    assert.equal(typeof DEFAULT_PROVIDERS[id].defaultModel, 'string');
    assert.ok(DEFAULT_PROVIDERS[id].defaultModel.length > 0, `${id} needs a placeholder default model`);
  }
});

/* ── 2) each provider → a correctly-parameterized driver config (one adapter serves all) ── */

test('★ each provider resolves to a correctly-parameterized ApiAdapterConfig (base-URL/model/secret)', () => {
  for (const id of PROVIDER_IDS) {
    const p = getProvider(id);
    const cfg = apiAdapterConfigForProvider(p);
    assert.equal(cfg.baseUrl, p.baseUrl, `${id} base-URL`);
    assert.equal(cfg.model, p.defaultModel, `${id} model defaults to the provider placeholder`);
    assert.equal(cfg.secretEnvVar, p.secretEnvVar, `${id} secret env var`);
  }
});

test('a model OVERRIDE wins over the provider default (the /setrole-supplied model)', () => {
  const cfg = apiAdapterConfigForProvider(getProvider('groq'), 'some-future-groq-model');
  assert.equal(cfg.model, 'some-future-groq-model');
  assert.equal(cfg.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(cfg.secretEnvVar, 'GROQ_API_KEY');
});

test('★ the EXISTING ApiAdapterDriver serves every provider (no new driver) — constructs + reports its model', () => {
  // Construct the one driver per provider from the projected config; assert its pinned model.
  // No network: we never call start() here — construction + the pinned model id is what proves
  // "one adapter, parameterized by config" (Gemini included, via its OpenAI-compat endpoint).
  for (const id of PROVIDER_IDS) {
    const cfg = apiAdapterConfigForProvider(getProvider(id));
    const driver = new ApiAdapterDriver({ config: cfg, env: {} as NodeJS.ProcessEnv });
    const h = driver.health();
    assert.equal(h.running, false);
    assert.ok(h.detail?.includes(cfg.label ?? cfg.model), `${id} driver labels itself`);
  }
});

test('the derived DEFAULT_API_ADAPTER_CONFIGS contains an entry for every provider default model (Groq + Gemini included)', () => {
  for (const id of PROVIDER_IDS) {
    const model = DEFAULT_PROVIDERS[id].defaultModel;
    assert.ok(DEFAULT_API_ADAPTER_CONFIGS[model], `missing default config for ${id} model ${model}`);
    assert.equal(DEFAULT_API_ADAPTER_CONFIGS[model]!.secretEnvVar, DEFAULT_PROVIDERS[id].secretEnvVar);
  }
});

test('DeepSeek + Codex default entries stay byte-identical to the explicit pins (overridden in the map)', () => {
  // The explicit DEEPSEEK_CODING_CONFIG / CODEX_REVIEWING_CONFIG win in the merged map; assert the
  // base-URL/secret match the registry (so the merge did not change the coding/reviewing backends).
  assert.equal(DEFAULT_API_ADAPTER_CONFIGS['deepseek-v4-flash']!.baseUrl, 'https://api.deepseek.com');
  assert.equal(DEFAULT_API_ADAPTER_CONFIGS['deepseek-v4-flash']!.secretEnvVar, 'DEEPSEEK_API_KEY');
  assert.equal(DEFAULT_API_ADAPTER_CONFIGS['gpt-5-codex']!.secretEnvVar, 'OPENAI_API_KEY');
});

/* ── 3) cross-provider key scoping for EVERY pair ──────────────────────────────── */

test('the per-provider secret map is derived from the registry (drives cross-provider scoping)', () => {
  const m = buildProviderSecretEnvVars();
  assert.deepEqual(m, BACKEND_SECRET_ENV_VARS as Record<ProviderId, string>);
  assert.deepEqual(
    [...ALL_BACKEND_SECRET_ENV_VARS].sort(),
    ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY'],
  );
});

test('★ an agent for provider X with ONLY its own key passes; with ANY foreign provider key it is REJECTED (all pairs)', () => {
  const secretFor = (id: ProviderId): string => DEFAULT_PROVIDERS[id].secretEnvVar;
  for (const own of PROVIDER_IDS) {
    const ownSecret = secretFor(own);
    // own key only → safe
    const okEnv = { [ownSecret]: 'k-own', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    const okRes = inspectBackendCostSafety('api-adapter', okEnv, ownSecret);
    assert.equal(okRes.ok, true, `${own}: own key only must pass`);
    assert.deepEqual(okRes.foreign, []);
    assert.doesNotThrow(() => assertBackendCostSafe('api-adapter', okEnv, ownSecret));

    // every OTHER provider's key is FOREIGN for this agent → reject
    for (const foreign of PROVIDER_IDS) {
      if (foreign === own) continue;
      const foreignSecret = secretFor(foreign);
      const badEnv = { [ownSecret]: 'k-own', [foreignSecret]: 'k-foreign' } as NodeJS.ProcessEnv;
      const badRes = inspectBackendCostSafety('api-adapter', badEnv, ownSecret);
      assert.equal(badRes.ok, false, `${own} agent must reject a stray ${foreign} key`);
      assert.deepEqual(badRes.foreign, [foreignSecret], `${own} agent: ${foreign} key is the foreign one`);
      assert.throws(
        () => assertBackendCostSafe('api-adapter', badEnv, ownSecret),
        BackendCostSafetyError,
        `${own} agent must THROW on a stray ${foreign} key`,
      );
    }

    // an Anthropic key is foreign to every provider agent
    const antEnv = { [ownSecret]: 'k-own', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv;
    assert.throws(() => assertBackendCostSafe('api-adapter', antEnv, ownSecret), BackendCostSafetyError);
  }
});

/* ── 4) alias + unknown-token resolution (the /setkey provider token) ───────────── */

test('canonical ids resolve to themselves; aliases resolve (codex→openai, google→gemini); case-insensitive', () => {
  assert.equal(resolveProviderId('deepseek'), 'deepseek');
  assert.equal(resolveProviderId('GROQ'), 'groq');
  assert.equal(resolveProviderId('  Gemini '), 'gemini');
  assert.equal(resolveProviderId('codex'), 'openai', PROVIDER_ALIASES.codex);
  assert.equal(resolveProviderId('google'), 'gemini');
});

test('an unknown provider token resolves to undefined (the /setkey unknown-provider error path)', () => {
  assert.equal(resolveProviderId('mistral'), undefined);
  assert.equal(resolveProviderId(''), undefined);
  assert.equal(isProviderId('mistral'), false);
  assert.equal(isProviderId('deepseek'), true);
});
