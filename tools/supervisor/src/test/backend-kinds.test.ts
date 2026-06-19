/**
 * BACKEND KINDS + CAPABILITY DESCRIPTOR tests (P0 — model-agnostic agents).
 *
 * Asserts the taxonomy types + the per-backend default capability descriptors (M1).
 * Pure type-level + const checks; no runtime path, no SDK, no subprocess.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_KINDS,
  ROLES,
  isBackendKind,
  isRole,
  DEFAULT_BACKEND_KIND,
  BACKEND_CAPABILITIES,
  capabilitiesFor,
  type BackendSelection,
} from '../backend-kinds.js';
import type { BackendCapabilities } from '../session-driver.js';

test('backend kinds taxonomy = claude-cli + api-adapter', () => {
  assert.deepEqual([...BACKEND_KINDS], ['claude-cli', 'api-adapter']);
  assert.equal(isBackendKind('claude-cli'), true);
  assert.equal(isBackendKind('api-adapter'), true);
  assert.equal(isBackendKind('pty'), false);
  assert.equal(isBackendKind(undefined), false);
  assert.equal(isBackendKind(''), false);
});

test('roles taxonomy = planning, coding, reviewing', () => {
  assert.deepEqual([...ROLES], ['planning', 'coding', 'reviewing']);
  assert.equal(isRole('planning'), true);
  assert.equal(isRole('coding'), true);
  assert.equal(isRole('reviewing'), true);
  assert.equal(isRole('deployment'), false);
  assert.equal(isRole(42), false);
});

test('★ the fail-safe default backend kind is claude-cli (the proven key-free backend)', () => {
  assert.equal(DEFAULT_BACKEND_KIND, 'claude-cli');
  assert.equal(isBackendKind(DEFAULT_BACKEND_KIND), true);
});

test('★ claude-cli capability descriptor: full Claude Code session (tools + perms + resume + teams)', () => {
  const caps = capabilitiesFor('claude-cli');
  const expected: BackendCapabilities = {
    supportsTools: true,
    supportsPermissionRouting: true,
    supportsResume: true,
    supportsTeams: true,
  };
  assert.deepEqual(caps, expected);
  // capabilitiesFor reads the same const map
  assert.deepEqual(caps, BACKEND_CAPABILITIES['claude-cli']);
});

test('api-adapter capability descriptor (dormant, P3/P4): bare compute — no tools/perms/resume/teams', () => {
  const caps = capabilitiesFor('api-adapter');
  assert.equal(caps.supportsTools, false);
  assert.equal(caps.supportsPermissionRouting, false);
  assert.equal(caps.supportsResume, false);
  assert.equal(caps.supportsTeams, false);
});

test('every backend kind has a capability descriptor (no missing entries)', () => {
  for (const kind of BACKEND_KINDS) {
    const caps = BACKEND_CAPABILITIES[kind];
    assert.ok(caps, `missing descriptor for ${kind}`);
    // all four flags are present + boolean
    assert.equal(typeof caps.supportsTools, 'boolean');
    assert.equal(typeof caps.supportsPermissionRouting, 'boolean');
    assert.equal(typeof caps.supportsResume, 'boolean');
    assert.equal(typeof caps.supportsTeams, 'boolean');
  }
});

test('BackendSelection is a pure data shape (type-level smoke)', () => {
  const sel: BackendSelection = { role: 'planning', backend: 'claude-cli', model: 'claude-opus-4-8[1m]' };
  assert.equal(sel.backend, 'claude-cli');
  assert.equal(sel.role, 'planning');
  // fallbackBackend is optional
  const sel2: BackendSelection = { role: 'coding', backend: 'api-adapter', fallbackBackend: 'claude-cli' };
  assert.equal(sel2.fallbackBackend, 'claude-cli');
});
