/**
 * COST-SAFETY GUARD tests — the user's hard constraint (subscription billing) made
 * a structural assertion: a billing-flipping API key in the inherited env → FAIL
 * FAST; a key-free env → ok. Pure (operates on an injected env map).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCostSafe,
  inspectCostSafety,
  costSafetyRefusalMessage,
  CostSafetyError,
  BILLING_FLIPPING_ENV_VARS,
  assertBackendCostSafe,
  inspectBackendCostSafety,
  backendCostSafetyRefusalMessage,
  BackendCostSafetyError,
  BACKEND_SECRET_ENV_VARS,
  ALL_BACKEND_SECRET_ENV_VARS,
} from '../cost-safety.js';

test('key-ABSENT env → ok (subscription billing preserved)', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/u' } as NodeJS.ProcessEnv;
  const r = inspectCostSafety(env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.offending, []);
  // assertCostSafe does NOT throw and returns the safe result
  assert.doesNotThrow(() => assertCostSafe(env));
  assert.deepEqual(assertCostSafe(env).offending, []);
});

test('★ ANTHROPIC_API_KEY present → REFUSES (throws CostSafetyError)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxx' } as NodeJS.ProcessEnv;
  const r = inspectCostSafety(env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.offending, ['ANTHROPIC_API_KEY']);
  assert.throws(() => assertCostSafe(env), CostSafetyError);
  // the error carries the offending name(s) but NOT the value
  try {
    assertCostSafe(env);
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof CostSafetyError);
    assert.deepEqual((e as CostSafetyError).offending, ['ANTHROPIC_API_KEY']);
    assert.ok(!(e as Error).message.includes('sk-ant-'), 'message must not leak the key value');
    assert.ok((e as Error).message.includes('ANTHROPIC_API_KEY'), 'message names the offending var');
    assert.ok((e as Error).message.toLowerCase().includes('subscription'), 'message explains the billing risk');
  }
});

test('ANTHROPIC_AUTH_TOKEN present → REFUSES', () => {
  const env = { ANTHROPIC_AUTH_TOKEN: 'tok-abc' } as NodeJS.ProcessEnv;
  assert.equal(inspectCostSafety(env).ok, false);
  assert.throws(() => assertCostSafe(env), CostSafetyError);
});

test('BOTH keys present → both reported as offending', () => {
  const env = { ANTHROPIC_API_KEY: 'k1', ANTHROPIC_AUTH_TOKEN: 'k2' } as NodeJS.ProcessEnv;
  const r = inspectCostSafety(env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.offending.sort(), [...BILLING_FLIPPING_ENV_VARS].sort());
});

test('EMPTY / whitespace-only key is treated as unset (cannot flip billing)', () => {
  // `env.FOO=''` is a common "unset" idiom; an empty value does not authenticate.
  assert.equal(inspectCostSafety({ ANTHROPIC_API_KEY: '' } as NodeJS.ProcessEnv).ok, true);
  assert.equal(inspectCostSafety({ ANTHROPIC_API_KEY: '   ' } as NodeJS.ProcessEnv).ok, true);
  assert.doesNotThrow(() => assertCostSafe({ ANTHROPIC_API_KEY: '' } as NodeJS.ProcessEnv));
});

test('refusal message is singular/plural correct and actionable', () => {
  const one = costSafetyRefusalMessage(['ANTHROPIC_API_KEY']);
  assert.ok(one.includes('ANTHROPIC_API_KEY is set'));
  assert.ok(one.includes('unset ANTHROPIC_API_KEY'));
  const two = costSafetyRefusalMessage(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.ok(two.includes('are set'));
  assert.ok(two.includes('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN'));
});

/* ────────────────────────────────────────────────────────────────────────────
 * BACKEND-AWARE cost/secret guard (P2 / M4 full; OD-1 per-backend key scoping).
 * The LIVE assertCostSafe behavior above is UNCHANGED; these exercise the NEW
 * additive backend-aware layer. Pure (injected env maps; no I/O).
 * ──────────────────────────────────────────────────────────────────────────── */

const DEEPSEEK = BACKEND_SECRET_ENV_VARS.deepseek; // 'DEEPSEEK_API_KEY'
const OPENAI = BACKEND_SECRET_ENV_VARS.openai; // 'OPENAI_API_KEY'

test('the secret-name maps are the documented values (now DERIVED from the provider registry — DeepSeek/OpenAI/Groq/Gemini)', () => {
  assert.equal(DEEPSEEK, 'DEEPSEEK_API_KEY');
  assert.equal(OPENAI, 'OPENAI_API_KEY');
  // The map is derived from provider-registry.ts → adding Groq + Gemini extended the scoping set.
  assert.equal(BACKEND_SECRET_ENV_VARS.groq, 'GROQ_API_KEY');
  assert.equal(BACKEND_SECRET_ENV_VARS.gemini, 'GEMINI_API_KEY');
  assert.deepEqual(
    [...ALL_BACKEND_SECRET_ENV_VARS].sort(),
    ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY'],
  );
});

// ── claude-cli env ────────────────────────────────────────────────────────────
test('★ claude-cli env that is KEY-FREE passes (subscription billing; no metered key held)', () => {
  const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('claude-cli', env);
  assert.equal(r.ok, true);
  assert.deepEqual(r.foreign, []);
  assert.equal(r.ownSecretMissing, false); // claude has no own secret
  assert.doesNotThrow(() => assertBackendCostSafe('claude-cli', env));
});

test('★ claude-cli env WITH an Anthropic key FAILS (backend-aware guard)', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-xxxx' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('claude-cli', env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.foreign, ['ANTHROPIC_API_KEY']);
  assert.throws(() => assertBackendCostSafe('claude-cli', env), BackendCostSafetyError);
});

test('claude-cli env carrying a metered (DeepSeek/OpenAI) key FAILS (a claude agent must hold NO metered key)', () => {
  const env = { [DEEPSEEK]: 'ds-key', [OPENAI]: 'oa-key' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('claude-cli', env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.foreign.sort(), [DEEPSEEK, OPENAI].sort());
  assert.throws(() => assertBackendCostSafe('claude-cli', env), BackendCostSafetyError);
});

// ── api-adapter (DeepSeek) env ──────────────────────────────────────────────────
test('★ deepseek env with ONLY DEEPSEEK_API_KEY passes (own key present, no foreign key)', () => {
  const env = { [DEEPSEEK]: 'ds-secret', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('api-adapter', env, DEEPSEEK);
  assert.equal(r.ok, true);
  assert.deepEqual(r.foreign, []);
  assert.equal(r.ownSecretMissing, false);
  assert.equal(r.ownSecretName, DEEPSEEK);
  assert.doesNotThrow(() => assertBackendCostSafe('api-adapter', env, DEEPSEEK));
});

test('★ deepseek env with a stray ANTHROPIC_API_KEY FAILS (no foreign billing key)', () => {
  const env = { [DEEPSEEK]: 'ds-secret', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('api-adapter', env, DEEPSEEK);
  assert.equal(r.ok, false);
  assert.deepEqual(r.foreign, ['ANTHROPIC_API_KEY']);
  assert.throws(() => assertBackendCostSafe('api-adapter', env, DEEPSEEK), BackendCostSafetyError);
});

test('★ deepseek env with a stray OPENAI_API_KEY FAILS (another backend’s key must not leak in)', () => {
  const env = { [DEEPSEEK]: 'ds-secret', [OPENAI]: 'oa-key' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('api-adapter', env, DEEPSEEK);
  assert.equal(r.ok, false);
  assert.deepEqual(r.foreign, [OPENAI]);
  assert.throws(() => assertBackendCostSafe('api-adapter', env, DEEPSEEK), BackendCostSafetyError);
});

test('deepseek env MISSING its own key is NOT a failure (ownSecretMissing flag; driver surfaces clean error)', () => {
  const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv; // no DEEPSEEK_API_KEY
  const r = inspectBackendCostSafety('api-adapter', env, DEEPSEEK);
  assert.equal(r.ok, true, 'a missing own key is not a billing-safety breach');
  assert.equal(r.ownSecretMissing, true);
  assert.deepEqual(r.foreign, []);
  assert.doesNotThrow(() => assertBackendCostSafe('api-adapter', env, DEEPSEEK));
});

test('an empty/whitespace DEEPSEEK_API_KEY counts as MISSING (unset idiom), not as a present key', () => {
  const env = { [DEEPSEEK]: '   ' } as NodeJS.ProcessEnv;
  const r = inspectBackendCostSafety('api-adapter', env, DEEPSEEK);
  assert.equal(r.ownSecretMissing, true);
  assert.equal(r.ok, true);
});

test('api-adapter (Codex/OpenAI) env with ONLY OPENAI_API_KEY passes; a stray DEEPSEEK_API_KEY is foreign', () => {
  // forward-looking: the SAME guard serves the Codex backend by passing OPENAI as ownSecretName.
  const ok = inspectBackendCostSafety('api-adapter', { [OPENAI]: 'oa' } as NodeJS.ProcessEnv, OPENAI);
  assert.equal(ok.ok, true);
  const bad = inspectBackendCostSafety(
    'api-adapter',
    { [OPENAI]: 'oa', [DEEPSEEK]: 'ds' } as NodeJS.ProcessEnv,
    OPENAI,
  );
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.foreign, [DEEPSEEK]);
});

test('backend refusal message names the foreign vars (NOT values) and the backend', () => {
  const msg = backendCostSafetyRefusalMessage('api-adapter', ['ANTHROPIC_API_KEY']);
  assert.ok(msg.includes('api-adapter'));
  assert.ok(msg.includes('ANTHROPIC_API_KEY'));
  assert.ok(!msg.includes('sk-ant'), 'never leaks a value');
  // the thrown error carries the names but not values
  try {
    assertBackendCostSafe('api-adapter', { ANTHROPIC_API_KEY: 'sk-ant-leak' } as NodeJS.ProcessEnv, DEEPSEEK);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof BackendCostSafetyError);
    assert.deepEqual((e as BackendCostSafetyError).foreign, ['ANTHROPIC_API_KEY']);
    assert.equal((e as BackendCostSafetyError).backend, 'api-adapter');
    assert.ok(!(e as Error).message.includes('sk-ant-leak'), 'message must not leak the key value');
  }
});

test('the LIVE assertCostSafe is UNCHANGED by P2 (still strict key-free; additive layer is separate)', () => {
  // belt-and-suspenders: the live path’s guard still behaves exactly as before P2.
  assert.doesNotThrow(() => assertCostSafe({ PATH: '/x' } as NodeJS.ProcessEnv));
  assert.throws(() => assertCostSafe({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv), CostSafetyError);
});
