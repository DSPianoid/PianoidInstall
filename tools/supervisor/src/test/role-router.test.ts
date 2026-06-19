/**
 * ROLE ROUTER tests (P1 / M2) — the PURE role→backend resolver + its precedence
 * (explicit override > config map > fail-safe default claude-cli) + the default-OFF
 * routing switch. No I/O, no SDK, no subprocess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRoleBackend,
  isRoleRoutingEnabled,
  ROLE_ROUTING_ENV_VAR,
  DEFAULT_ROLE_ROUTING_CONFIG,
  type RoleRouterConfig,
} from '../role-router.js';

test('★ DEFAULT_ROLE_ROUTING_CONFIG routes planning→claude-cli, coding→DeepSeek, reviewing→Codex', () => {
  const planning = resolveRoleBackend('planning', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(planning.backend, 'claude-cli');

  const coding = resolveRoleBackend('coding', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(coding.backend, 'api-adapter');
  assert.equal(coding.model, 'deepseek-v4-flash');
  assert.equal(coding.fallbackBackend, 'claude-cli'); // FD6 (executed at P5)

  const reviewing = resolveRoleBackend('reviewing', DEFAULT_ROLE_ROUTING_CONFIG);
  assert.equal(reviewing.backend, 'api-adapter');
  assert.equal(reviewing.model, 'gpt-5-codex');
  assert.equal(reviewing.fallbackBackend, 'claude-cli');

  // an unmapped role still falls through to the fail-safe default
  assert.equal(resolveRoleBackend('mystery', DEFAULT_ROLE_ROUTING_CONFIG).backend, 'claude-cli');
});

test('★ unmapped role resolves to the fail-safe default (claude-cli), never throws', () => {
  // empty config, unknown role
  assert.doesNotThrow(() => resolveRoleBackend('totally-unknown-role'));
  const sel = resolveRoleBackend('totally-unknown-role');
  assert.equal(sel.backend, 'claude-cli');
  assert.equal(sel.role, 'totally-unknown-role');
  // a KNOWN role with no config entry also falls through to the default
  assert.equal(resolveRoleBackend('coding').backend, 'claude-cli');
});

test('★ config map resolves a role to its configured backend + model', () => {
  const config: RoleRouterConfig = {
    roles: {
      planning: { backend: 'claude-cli', model: 'claude-opus-4-8[1m]' },
      coding: { backend: 'api-adapter', model: 'deepseek-v4-flash', fallbackBackend: 'claude-cli' },
    },
  };
  const planning = resolveRoleBackend('planning', config);
  assert.equal(planning.backend, 'claude-cli');
  assert.equal(planning.model, 'claude-opus-4-8[1m]');

  const coding = resolveRoleBackend('coding', config);
  assert.equal(coding.backend, 'api-adapter');
  assert.equal(coding.model, 'deepseek-v4-flash');
  assert.equal(coding.fallbackBackend, 'claude-cli');
});

test('★ precedence: explicit per-dispatch override beats the config map', () => {
  const config: RoleRouterConfig = { roles: { planning: { backend: 'api-adapter', model: 'x' } } };
  // override forces claude-cli even though config says api-adapter for planning
  const sel = resolveRoleBackend('planning', config, { backend: 'claude-cli', model: 'override-model' });
  assert.equal(sel.backend, 'claude-cli');
  assert.equal(sel.model, 'override-model');
});

test('override is per-field: a model-only override keeps the mapped backend', () => {
  const config: RoleRouterConfig = { roles: { planning: { backend: 'claude-cli', model: 'cfg-model' } } };
  const sel = resolveRoleBackend('planning', config, { model: 'just-the-model' });
  assert.equal(sel.backend, 'claude-cli'); // backend from config (override had no backend)
  assert.equal(sel.model, 'just-the-model'); // model from override
});

test('a bogus override backend is ignored → falls through to config/default', () => {
  const config: RoleRouterConfig = { roles: { planning: { backend: 'claude-cli' } } };
  // @ts-expect-error — feeding a non-BackendKind to assert runtime guard
  const sel = resolveRoleBackend('planning', config, { backend: 'pty' });
  assert.equal(sel.backend, 'claude-cli');
});

test('config.defaultBackend overrides the fail-safe default (when a known kind)', () => {
  const sel = resolveRoleBackend('unmapped', { defaultBackend: 'api-adapter' });
  assert.equal(sel.backend, 'api-adapter');
  // a bogus defaultBackend is ignored → stays claude-cli
  // @ts-expect-error — non-BackendKind
  const sel2 = resolveRoleBackend('unmapped', { defaultBackend: 'nonsense' });
  assert.equal(sel2.backend, 'claude-cli');
});

test('resolution carries no model/fallback when none supplied (clean shape)', () => {
  const sel = resolveRoleBackend('planning');
  assert.equal(sel.model, undefined);
  assert.equal(sel.fallbackBackend, undefined);
  assert.deepEqual(Object.keys(sel).sort(), ['backend', 'role']);
});

// ── default-OFF switch (X5 / AP5) ───────────────────────────────────────────────
test('★ role-routing switch is OFF by default (unset / empty / off / 0 / false)', () => {
  assert.equal(isRoleRoutingEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: '' } as NodeJS.ProcessEnv), false);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'false' } as NodeJS.ProcessEnv), false);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'no' } as NodeJS.ProcessEnv), false);
});

test('role-routing switch is ON only for 1/true/on (case-insensitive)', () => {
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'ON' } as NodeJS.ProcessEnv), true);
  assert.equal(isRoleRoutingEnabled({ [ROLE_ROUTING_ENV_VAR]: 'True' } as NodeJS.ProcessEnv), true);
});
