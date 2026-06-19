/**
 * BACKEND SEAL tests (P1 / M4, claude-cli path) — the choke-point that applies the
 * Claude seal: forces settingSources ['project','local'] (drops 'user'), merges the
 * universal channel-deny list, and asserts the env is KEY-FREE (subscription billing).
 * No non-Claude / key-bearing logic exists in P1 — a non-claude-cli backend is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sealBackendOptions,
  inspectClaudeSeal,
  BackendSealError,
  CLAUDE_SEAL_SETTING_SOURCES,
  UNIVERSAL_CHANNEL_DENY,
} from '../backend-seal.js';
import { CostSafetyError } from '../cost-safety.js';
import type { SessionStartOptions } from '../session-driver.js';

const baseOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: async () => ({ behavior: 'deny', message: 'test' }),
  ...over,
});

const KEY_FREE_ENV = { PATH: '/usr/bin', HOME: '/home/u' } as NodeJS.ProcessEnv;

test('★ claude-cli seal asserts a KEY-FREE env (subscription billing) → passes', () => {
  assert.doesNotThrow(() =>
    sealBackendOptions({ backend: 'claude-cli', base: baseOpts(), env: KEY_FREE_ENV }),
  );
});

test('★ claude-cli seal THROWS CostSafetyError when ANTHROPIC_API_KEY is present', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-xxxx' } as NodeJS.ProcessEnv;
  assert.throws(
    () => sealBackendOptions({ backend: 'claude-cli', base: baseOpts(), env }),
    CostSafetyError,
  );
});

test('claude-cli seal THROWS for ANTHROPIC_AUTH_TOKEN too', () => {
  const env = { ANTHROPIC_AUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv;
  assert.throws(() => sealBackendOptions({ backend: 'claude-cli', base: baseOpts(), env }), CostSafetyError);
});

test('★ seal FORCES settingSources = [project, local] and drops user', () => {
  // Even if the caller asks for 'user' (the plugin-hijack source), the seal removes it.
  const sealed = sealBackendOptions({
    backend: 'claude-cli',
    base: baseOpts({ settingSources: ['user', 'project', 'local'] }),
    env: KEY_FREE_ENV,
  });
  assert.deepEqual(sealed.settingSources, [...CLAUDE_SEAL_SETTING_SOURCES]);
  assert.ok(!sealed.settingSources!.includes('user'), 'user source must be dropped (token-hijack seal)');
});

test('★ seal MERGES the universal channel-deny list (channel-mute) with the caller deny-list', () => {
  const sealed = sealBackendOptions({
    backend: 'claude-cli',
    base: baseOpts({ disallowedTools: ['SomeOtherTool'] }),
    env: KEY_FREE_ENV,
  });
  // caller's deny kept
  assert.ok(sealed.disallowedTools!.includes('SomeOtherTool'));
  // universal channel-deny present
  for (const name of UNIVERSAL_CHANNEL_DENY) {
    assert.ok(sealed.disallowedTools!.includes(name), `missing channel-deny ${name}`);
  }
});

test('seal de-dupes the deny-list (no duplicate channel-deny entries)', () => {
  const sealed = sealBackendOptions({
    backend: 'claude-cli',
    base: baseOpts({ disallowedTools: [...UNIVERSAL_CHANNEL_DENY, 'X'] }),
    env: KEY_FREE_ENV,
  });
  const counts = new Map<string, number>();
  for (const n of sealed.disallowedTools!) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [name, c] of counts) assert.equal(c, 1, `${name} appears ${c} times (should be de-duped)`);
});

test('seal does NOT inject any key into the env (claude-cli stays key-free) + carries other fields through', () => {
  const base = baseOpts({ model: 'claude-opus-4-8[1m]', cwd: '/work', bootstrapTurns: ['/orchestrator'] });
  const sealed = sealBackendOptions({ backend: 'claude-cli', base, env: KEY_FREE_ENV });
  // unrelated fields preserved
  assert.equal(sealed.model, 'claude-opus-4-8[1m]');
  assert.equal(sealed.cwd, '/work');
  assert.deepEqual(sealed.bootstrapTurns, ['/orchestrator']);
  // the seal does not add an env with a key (it doesn't manage the child env at all here)
  // — env mutation is explicitly NOT this path's job (claude is key-free).
  assert.equal(sealed.env, undefined);
});

test('★ a NON-claude-cli backend is REFUSED in P1 (no key-bearing/api-adapter seal yet)', () => {
  assert.throws(
    () => sealBackendOptions({ backend: 'api-adapter', base: baseOpts(), env: KEY_FREE_ENV }),
    BackendSealError,
  );
});

test('inspectClaudeSeal: a sealed options object reports sealed=true; an unsealed one reports the reasons', () => {
  const sealed = sealBackendOptions({ backend: 'claude-cli', base: baseOpts(), env: KEY_FREE_ENV });
  assert.deepEqual(inspectClaudeSeal(sealed), { sealed: true, reasons: [] });

  // an options object with 'user' + no channel-deny is NOT sealed
  const unsealed = inspectClaudeSeal(baseOpts({ settingSources: ['user', 'project', 'local'] }));
  assert.equal(unsealed.sealed, false);
  assert.ok(unsealed.reasons.some((r) => r.includes("'user'")));
  assert.ok(unsealed.reasons.some((r) => r.includes('channel-deny')));
});
