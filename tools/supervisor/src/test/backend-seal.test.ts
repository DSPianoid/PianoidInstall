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
  sealClaudeOptions,
  sealApiAdapterOptions,
  inspectClaudeSeal,
  CLAUDE_SEAL_SETTING_SOURCES,
  UNIVERSAL_CHANNEL_DENY,
} from '../backend-seal.js';
import { CostSafetyError, BackendCostSafetyError } from '../cost-safety.js';
import type { SessionStartOptions } from '../session-driver.js';

const baseOpts = (over: Partial<SessionStartOptions> = {}): SessionStartOptions => ({
  onPermission: async () => ({ behavior: 'deny', message: 'test' }),
  ...over,
});

const KEY_FREE_ENV = { PATH: '/usr/bin', HOME: '/home/u' } as NodeJS.ProcessEnv;

test('★ (criterion e) UNIVERSAL_CHANNEL_DENY is TELEGRAM-ONLY now — whatsapp is NOT universally denied', () => {
  // Telegram (both name forms) stays in the universal deny — the channel the supervisor owns.
  assert.ok(UNIVERSAL_CHANNEL_DENY.includes('mcp__plugin_telegram_telegram__*'), 'telegram plugin universally denied');
  assert.ok(UNIVERSAL_CHANNEL_DENY.includes('mcp__telegram__*'), 'telegram universally denied');
  // WhatsApp is NO LONGER universally denied (it's read-allowed/send-gated by the orchestrator policy).
  assert.ok(!UNIVERSAL_CHANNEL_DENY.some((n) => n.includes('whatsapp')), 'whatsapp NOT in the universal channel-deny');
  // Exactly the two telegram names, nothing else.
  assert.deepEqual([...UNIVERSAL_CHANNEL_DENY], ['mcp__plugin_telegram_telegram__*', 'mcp__telegram__*']);
});

test('★ sealed options carry the telegram deny but NOT a whatsapp deny (the seal no longer mutes whatsapp)', () => {
  const sealed = sealBackendOptions({ backend: 'claude-cli', base: baseOpts(), env: KEY_FREE_ENV });
  assert.ok(sealed.disallowedTools!.includes('mcp__telegram__*'), 'telegram denied by the seal');
  assert.ok(sealed.disallowedTools!.includes('mcp__plugin_telegram_telegram__*'), 'telegram plugin denied by the seal');
  assert.ok(!sealed.disallowedTools!.some((n) => n.includes('whatsapp')), 'seal does NOT add a whatsapp deny');
});

test('★ inspectClaudeSeal no longer requires a whatsapp deny — telegram-only deny is sealed', () => {
  // A claude options object with project+local + ONLY the telegram denies is fully sealed now.
  const o = baseOpts({ settingSources: ['project', 'local'], disallowedTools: ['mcp__plugin_telegram_telegram__*', 'mcp__telegram__*'] });
  assert.deepEqual(inspectClaudeSeal(o), { sealed: true, reasons: [] }, 'telegram-only deny is sealed (no whatsapp required)');
});

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

/* ────────────────────────────────────────────────────────────────────────────
 * api-adapter SEAL (P3 / M4 full) — NOT Claude Code: NO settingSources forced;
 * channel-mute deny merged; BACKEND-AWARE foreign-key assertion (own key only).
 * ──────────────────────────────────────────────────────────────────────────── */
const DEEPSEEK_ENV = { DEEPSEEK_API_KEY: 'ds-secret', PATH: '/usr/bin' } as NodeJS.ProcessEnv;

test('★ api-adapter seal PASSES with only its own key (DEEPSEEK_API_KEY) and does NOT force settingSources', () => {
  const sealed = sealBackendOptions({
    backend: 'api-adapter',
    base: baseOpts({ settingSources: ['user', 'project'] }), // caller value — NOT forced/altered
    env: DEEPSEEK_ENV,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  // settingSources left exactly as the caller set them (api-adapter is not Claude Code → no plugin surface)
  assert.deepEqual(sealed.settingSources, ['user', 'project']);
  // channel-mute deny merged (defensive)
  for (const name of UNIVERSAL_CHANNEL_DENY) assert.ok(sealed.disallowedTools!.includes(name));
});

test('★ api-adapter seal merges the universal channel-deny (channel-mute) with the caller deny-list', () => {
  const sealed = sealApiAdapterOptions({
    backend: 'api-adapter',
    base: baseOpts({ disallowedTools: ['CustomTool'] }),
    env: DEEPSEEK_ENV,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.ok(sealed.disallowedTools!.includes('CustomTool'));
  for (const name of UNIVERSAL_CHANNEL_DENY) assert.ok(sealed.disallowedTools!.includes(name));
});

test('★ api-adapter seal THROWS BackendCostSafetyError on a foreign key (stray ANTHROPIC_API_KEY)', () => {
  const env = { DEEPSEEK_API_KEY: 'ds', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv;
  assert.throws(
    () => sealBackendOptions({ backend: 'api-adapter', base: baseOpts(), env, ownSecretName: 'DEEPSEEK_API_KEY' }),
    BackendCostSafetyError,
  );
});

test('★ api-adapter seal THROWS on another backend’s key (stray OPENAI_API_KEY in a DeepSeek agent)', () => {
  const env = { DEEPSEEK_API_KEY: 'ds', OPENAI_API_KEY: 'oa' } as NodeJS.ProcessEnv;
  assert.throws(
    () => sealApiAdapterOptions({ backend: 'api-adapter', base: baseOpts(), env, ownSecretName: 'DEEPSEEK_API_KEY' }),
    BackendCostSafetyError,
  );
});

test('api-adapter seal does NOT throw when its OWN key is merely absent (driver surfaces a clean error later)', () => {
  const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv; // no DEEPSEEK_API_KEY
  assert.doesNotThrow(() =>
    sealApiAdapterOptions({ backend: 'api-adapter', base: baseOpts(), env, ownSecretName: 'DEEPSEEK_API_KEY' }),
  );
});

test('api-adapter seal does NOT inject the key into options.env (driver reads it from the process env)', () => {
  const sealed = sealApiAdapterOptions({
    backend: 'api-adapter',
    base: baseOpts(),
    env: DEEPSEEK_ENV,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(sealed.env, undefined);
});

test('sealClaudeOptions still behaves exactly as the P1 claude seal (byte-for-byte path preserved)', () => {
  const sealed = sealClaudeOptions({ backend: 'claude-cli', base: baseOpts(), env: KEY_FREE_ENV });
  assert.deepEqual(sealed.settingSources, [...CLAUDE_SEAL_SETTING_SOURCES]);
  for (const name of UNIVERSAL_CHANNEL_DENY) assert.ok(sealed.disallowedTools!.includes(name));
  assert.throws(
    () => sealClaudeOptions({ backend: 'claude-cli', base: baseOpts(), env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv }),
    CostSafetyError,
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
