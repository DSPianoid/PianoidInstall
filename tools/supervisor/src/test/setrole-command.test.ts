/**
 * `/setrole` + `/roles` PURE COMMAND tests (PART Q.3) — parse + message builders only. No I/O.
 * Asserts the shape split (role/provider/[model]), usage forms, the word-boundary matchers, and
 * that the message helpers build the expected human strings (and a `/roles` render NEVER receives
 * a key value — it takes booleans only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETROLE_CMD_RE,
  ROLES_CMD_RE,
  isSetRoleCommand,
  isRolesCommand,
  parseSetRoleCommand,
  setRoleUsageMessage,
  setRoleUnknownRoleMessage,
  setRoleUnknownProviderMessage,
  setRoleNoKeyWarning,
  setRoleConfirmMessage,
  rolesListMessage,
  type RolesListRow,
} from '../setrole-command.js';

/* ── matchers ─────────────────────────────────────────────────────────────────────── */

test('SETROLE/ROLES matchers honor a word boundary', () => {
  assert.ok(SETROLE_CMD_RE.test('/setrole coding groq'));
  assert.ok(!SETROLE_CMD_RE.test('/setroles coding groq'), '/setroles is not /setrole');
  assert.ok(ROLES_CMD_RE.test('/roles'));
  assert.ok(!ROLES_CMD_RE.test('/rolesfoo'), '/rolesfoo is not /roles');
  assert.ok(isSetRoleCommand('  /SetRole x y '));
  assert.ok(isRolesCommand('  /ROLES '));
  assert.ok(!isRolesCommand('please list roles'));
});

/* ── parse ────────────────────────────────────────────────────────────────────────── */

test('parseSetRoleCommand splits role + provider (+ optional model); null for non-command', () => {
  assert.deepEqual(parseSetRoleCommand('/setrole coding groq'), {
    kind: 'set',
    roleToken: 'coding',
    providerToken: 'groq',
  });
  assert.deepEqual(parseSetRoleCommand('  /SetRole   coding   groq   llama-3.3-70b  '), {
    kind: 'set',
    roleToken: 'coding',
    providerToken: 'groq',
    modelToken: 'llama-3.3-70b',
  });
  assert.equal(parseSetRoleCommand('hello'), null);
});

test('parseSetRoleCommand usage forms: bare /setrole → no_role; role only → no_provider', () => {
  assert.deepEqual(parseSetRoleCommand('/setrole'), { kind: 'usage', reason: 'no_role' });
  assert.deepEqual(parseSetRoleCommand('/setrole coding'), { kind: 'usage', reason: 'no_provider' });
});

/* ── message builders ───────────────────────────────────────────────────────────────── */

test('setRoleUsageMessage lists roles + providers', () => {
  const m = setRoleUsageMessage(['planning', 'coding', 'reviewing'], ['deepseek', 'groq']);
  assert.ok(m.includes('/setrole <role> <provider> [model]'));
  assert.ok(m.includes('coding') && m.includes('groq'));
});

test('unknown-role / unknown-provider messages list the known set', () => {
  assert.ok(setRoleUnknownRoleMessage('xyz', ['planning', 'coding']).includes('Known roles: planning, coding'));
  assert.ok(
    setRoleUnknownProviderMessage('mistral', ['deepseek', 'groq']).includes('Known providers: deepseek, groq'),
  );
});

test('setRoleConfirmMessage renders "role → provider (model) ✓" with an optional warning line', () => {
  assert.equal(setRoleConfirmMessage('coding', 'groq', 'llama-3.3-70b'), 'coding → groq (llama-3.3-70b) ✓');
  const warned = setRoleConfirmMessage('coding', 'groq', 'llama-3.3-70b', setRoleNoKeyWarning('groq', 'GROQ_API_KEY'));
  assert.ok(warned.startsWith('coding → groq (llama-3.3-70b) ✓\n'));
  assert.ok(warned.includes('no GROQ_API_KEY set yet'));
  assert.ok(warned.includes('/setkey groq'));
});

test('★ rolesListMessage renders the merged map + key booleans (never a value); n/a for claude', () => {
  const rows: RolesListRow[] = [
    { role: 'planning', provider: 'claude', model: '(default)', overridden: false, keyPresent: null },
    { role: 'coding', provider: 'groq', model: 'llama-3.3-70b', overridden: true, keyPresent: true },
    { role: 'reviewing', provider: 'openai', model: 'gpt-5-codex', overridden: false, keyPresent: false },
  ];
  const m = rolesListMessage(rows);
  assert.ok(m.includes('planning → claude'));
  assert.ok(m.includes('key: n/a'), 'claude-cli needs no key → n/a');
  assert.ok(m.includes('coding → groq (llama-3.3-70b)'));
  assert.ok(m.includes('[override]'));
  assert.ok(m.includes('key: yes'));
  assert.ok(m.includes('reviewing → openai'));
  assert.ok(m.includes('key: no'));
  // The function only ever receives booleans — no place a key value could appear.
  assert.equal(rolesListMessage([]), 'No roles configured.');
});
