/**
 * ROLE-ROUTING STORE tests (M8 / PART Q.3) — the gitignored, per-role persisted Tier-2 override
 * store behind `/setrole`, plus the router-side merge that layers it OVER the in-code default.
 * Uses a TEMP dir (os.tmpdir) — NO real key, NO network, zero spend. Asserts:
 *   - a stored role override reads back; an absent role → undefined; loadAll() projects the map;
 *   - validation: unknown role / unknown provider rejected; a torn/garbage file → empty (no throw);
 *     a persisted entry with a bad provider id is dropped on load;
 *   - ★ the persisted override BEATS the default (resolveRoleBackendWithOverrides);
 *   - ★ a runtime mutation (setRole then re-load) takes effect on the NEXT resolve (no restart);
 *   - persistence ACROSS a fresh store instance (survives "restart");
 *   - the store path is under a gitignored `.state/` dir (assertGitignoredPath accepts it);
 *   - clearRole reverts a role to the in-code default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import {
  RoleRoutingStore,
  RoleRoutingStoreError,
  defaultRoleRoutingStorePath,
  DEFAULT_ROLE_ROUTING_STORE_FILENAME,
} from '../role-routing-store.js';
import {
  resolveRoleBackend,
  resolveRoleBackendWithOverrides,
  mergeRoleRoutingOverrides,
  DEFAULT_ROLE_ROUTING_CONFIG,
} from '../role-router.js';
import { assertGitignoredPath } from '../secret-store.js';

/** A fresh temp store path under a '.state' dir (so it satisfies the gitignored-path guard too). */
function tmpStore(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pianoid-role-routing-'));
  const path = join(dir, '.state', 'role-routing.json');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* ── default path + gitignore guard ──────────────────────────────────────────────── */

test('defaultRoleRoutingStorePath points under <root>/.state and is gitignore-safe', () => {
  const p1 = defaultRoleRoutingStorePath('/sup/root', {} as NodeJS.ProcessEnv);
  assert.ok(p1.endsWith(`${sep}.state${sep}${DEFAULT_ROLE_ROUTING_STORE_FILENAME}`), p1);
  // The default path is under a gitignored '.state' dir (same guard the secret store uses).
  assert.doesNotThrow(() => assertGitignoredPath(p1));
  const p2 = defaultRoleRoutingStorePath('/sup/root', { SUPERVISOR_STATE_DIR: '/var/run/.state' } as NodeJS.ProcessEnv);
  assert.ok(p2.includes('.state'), p2);
});

test('★ the persisted store file lives at the configured (.state, gitignored) path', () => {
  const t = tmpStore();
  try {
    const store = new RoleRoutingStore({ filePath: t.path });
    store.setRole('coding', 'groq', 'llama-3.3-70b-versatile');
    assert.ok(existsSync(t.path), 'store file created at the configured path');
    assert.ok(t.path.includes(`${sep}.state${sep}`), 'path is under a gitignored .state dir');
  } finally {
    t.cleanup();
  }
});

/* ── store/read scoped, validate ──────────────────────────────────────────────────── */

test('★ a stored role override reads back; absent role → undefined; loadAll projects the map', () => {
  const t = tmpStore();
  try {
    const store = new RoleRoutingStore({ filePath: t.path });
    store.setRole('coding', 'groq', 'llama-3.3-70b-versatile');
    assert.deepEqual(store.get('coding'), { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    assert.equal(store.get('reviewing'), undefined, 'a non-overridden role has no entry');
    store.setRole('reviewing', 'gemini'); // no explicit model
    assert.deepEqual(store.get('reviewing'), { provider: 'gemini' });
    assert.deepEqual(store.loadAll(), {
      coding: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
      reviewing: { provider: 'gemini' },
    });
  } finally {
    t.cleanup();
  }
});

test('setRole rejects an unknown role and an unknown provider (defensive backstop)', () => {
  const t = tmpStore();
  try {
    const store = new RoleRoutingStore({ filePath: t.path });
    // @ts-expect-error — feeding a non-Role
    assert.throws(() => store.setRole('nonsense-role', 'groq'), RoleRoutingStoreError);
    // @ts-expect-error — feeding a non-ProviderId
    assert.throws(() => store.setRole('coding', 'mistral'), RoleRoutingStoreError);
    assert.deepEqual(store.loadAll(), {}, 'nothing stored on a rejected write');
  } finally {
    t.cleanup();
  }
});

test('a torn/garbage store file loads as EMPTY (no throw); a bad-provider entry is dropped', () => {
  const t = tmpStore();
  try {
    mkdirSync(dirname(t.path), { recursive: true });
    // torn JSON
    writeFileSync(t.path, '{ this is not json ', 'utf8');
    const store = new RoleRoutingStore({ filePath: t.path });
    assert.deepEqual(store.loadAll(), {}, 'torn file → empty');
    // valid JSON but a bad provider id on one entry + a good one → only the good one survives.
    writeFileSync(
      t.path,
      JSON.stringify({ coding: { provider: 'groq' }, reviewing: { provider: 'not-a-provider' } }),
      'utf8',
    );
    assert.deepEqual(store.loadAll(), { coding: { provider: 'groq' } });
  } finally {
    t.cleanup();
  }
});

test('clearRole reverts a role to the in-code default (no-op if absent)', () => {
  const t = tmpStore();
  try {
    const store = new RoleRoutingStore({ filePath: t.path });
    store.setRole('coding', 'groq');
    assert.deepEqual(store.get('coding'), { provider: 'groq' });
    store.clearRole('coding');
    assert.equal(store.get('coding'), undefined);
    assert.doesNotThrow(() => store.clearRole('coding')); // no-op when already absent
  } finally {
    t.cleanup();
  }
});

/* ── ★ override BEATS default + runtime mutation + persistence across restart ───────── */

test('★ a persisted override BEATS DEFAULT_ROLE_ROUTING_CONFIG (resolveRoleBackendWithOverrides)', () => {
  // Default: coding → api-adapter/deepseek-v4-flash. Override it to groq with a model.
  const overrides = { coding: { provider: 'groq' as const, model: 'llama-3.3-70b-versatile' } };

  // baseline (no overrides) resolves to the default
  const base = resolveRoleBackend('coding', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(base.model, 'deepseek-v4-flash');

  // with the override, the SAME role resolves to the chosen model (api-adapter backend, claude-cli fallback)
  const sel = resolveRoleBackendWithOverrides('coding', overrides, DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(sel.backend, 'api-adapter');
  assert.equal(sel.model, 'llama-3.3-70b-versatile');
  assert.equal(sel.fallbackBackend, 'claude-cli');

  // a NON-overridden role still resolves to its default
  const reviewing = resolveRoleBackendWithOverrides('reviewing', overrides, DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(reviewing.model, 'gpt-5-codex');

  // planning (claude-cli default) is unaffected
  const planning = resolveRoleBackendWithOverrides('planning', overrides, DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(planning.backend, 'claude-cli');
});

test('★ a runtime mutation takes effect on the NEXT resolve (no restart); persists across a fresh store', () => {
  const t = tmpStore();
  try {
    const store = new RoleRoutingStore({ filePath: t.path });

    // before any override: coding resolves to the default deepseek model
    let sel = resolveRoleBackendWithOverrides('coding', store.loadAll(), DEFAULT_ROLE_ROUTING_CONFIG);
    assert.equal(sel.model, 'deepseek-v4-flash');

    // RUNTIME mutation
    store.setRole('coding', 'gemini', 'gemini-2.5-flash');

    // the NEXT resolve (re-reading the store) reflects it immediately — no restart
    sel = resolveRoleBackendWithOverrides('coding', store.loadAll(), DEFAULT_ROLE_ROUTING_CONFIG);
    assert.equal(sel.model, 'gemini-2.5-flash');

    // PERSISTS across a fresh store instance (== survives a supervisor restart)
    const store2 = new RoleRoutingStore({ filePath: t.path });
    const sel2 = resolveRoleBackendWithOverrides('coding', store2.loadAll(), DEFAULT_ROLE_ROUTING_CONFIG);
    assert.equal(sel2.model, 'gemini-2.5-flash');
  } finally {
    t.cleanup();
  }
});

test('mergeRoleRoutingOverrides is pure (does not mutate the base) + skips invalid entries', () => {
  const base = DEFAULT_ROLE_ROUTING_CONFIG;
  const baseCodingModelBefore = base.roles?.coding?.model;
  const merged = mergeRoleRoutingOverrides(
    {
      coding: { provider: 'groq', model: 'llama-x' },
      // @ts-expect-error — an invalid override (bad provider) is skipped, not merged
      reviewing: { provider: 'bogus' },
    },
    base,
  );
  assert.equal(merged.roles?.coding?.model, 'llama-x');
  assert.equal(merged.roles?.coding?.backend, 'api-adapter');
  // reviewing kept its DEFAULT (the bogus override was skipped)
  assert.equal(merged.roles?.reviewing?.model, 'gpt-5-codex');
  // the base was not mutated
  assert.equal(base.roles?.coding?.model, baseCodingModelBefore);
  assert.equal(base.roles?.coding?.model, 'deepseek-v4-flash');
});

test('empty overrides → resolution is identical to the plain default', () => {
  const a = resolveRoleBackendWithOverrides('coding', {}, DEFAULT_ROLE_ROUTING_CONFIG);
  const b = resolveRoleBackend('coding', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.deepEqual(a, b);
  // undefined overrides behaves the same
  const c = resolveRoleBackendWithOverrides('coding', undefined, DEFAULT_ROLE_ROUTING_CONFIG);
  assert.deepEqual(c, b);
});
