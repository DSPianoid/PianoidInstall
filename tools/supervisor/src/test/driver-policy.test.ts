/**
 * DRIVER SELECTION POLICY tests — the SDK driver is the DEFAULT; the `claude -p`
 * stream-json driver is SELECTABLE; the retired PTY scraper is NOT selectable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDriverSelection,
  isDriverName,
  DEFAULT_DRIVER,
  SELECTABLE_DRIVERS,
} from '../driver-policy.js';

test('★ default driver is SDK (no argv, no env)', () => {
  assert.equal(DEFAULT_DRIVER, 'sdk');
  assert.equal(resolveDriverSelection({}), 'sdk');
  assert.equal(resolveDriverSelection({ argvDriver: undefined, envDriver: undefined }), 'sdk');
});

test('★ the cli-stream (claude -p) HEDGE is selectable via argv', () => {
  assert.equal(resolveDriverSelection({ argvDriver: 'cli-stream' }), 'cli-stream');
});

test('cli-stream is selectable via SUPERVISOR_DRIVER env', () => {
  assert.equal(resolveDriverSelection({ envDriver: 'cli-stream' }), 'cli-stream');
});

test('argv wins over env', () => {
  assert.equal(resolveDriverSelection({ argvDriver: 'sdk', envDriver: 'cli-stream' }), 'sdk');
  assert.equal(resolveDriverSelection({ argvDriver: 'cli-stream', envDriver: 'sdk' }), 'cli-stream');
});

test('★ the retired PTY driver is NOT selectable → falls back to the SDK default', () => {
  assert.equal(isDriverName('pty'), false);
  assert.equal(resolveDriverSelection({ argvDriver: 'pty' }), 'sdk');
  assert.equal(resolveDriverSelection({ envDriver: 'pty' }), 'sdk');
});

test('unknown/garbage values fall back to the SDK default (never an unknown driver)', () => {
  assert.equal(resolveDriverSelection({ argvDriver: 'bogus' }), 'sdk');
  assert.equal(resolveDriverSelection({ argvDriver: '' }), 'sdk');
  assert.deepEqual([...SELECTABLE_DRIVERS], ['sdk', 'cli-stream']);
});

test('★ profileDefault applies when no explicit argv/env (orchestrator → cli-stream)', () => {
  // the orchestrator profile passes profileDefault:'cli-stream' → that wins over the global 'sdk' default
  assert.equal(resolveDriverSelection({ profileDefault: 'cli-stream' }), 'cli-stream');
  assert.equal(resolveDriverSelection({ profileDefault: 'sdk' }), 'sdk');
});

test('explicit argv/env OVERRIDE the profile default (operator can force a driver)', () => {
  assert.equal(resolveDriverSelection({ argvDriver: 'sdk', profileDefault: 'cli-stream' }), 'sdk', 'argv beats profile');
  assert.equal(resolveDriverSelection({ envDriver: 'sdk', profileDefault: 'cli-stream' }), 'sdk', 'env beats profile');
  // a bogus explicit value is ignored → profile default still applies
  assert.equal(resolveDriverSelection({ argvDriver: 'bogus', profileDefault: 'cli-stream' }), 'cli-stream');
});
