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
