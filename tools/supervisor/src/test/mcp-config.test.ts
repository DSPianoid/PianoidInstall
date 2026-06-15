/**
 * MCP-config builder tests: exclude telegram, resolve ${VAR}, tolerate junk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServers, isExcludedServer, resolveEnvPlaceholders } from '../mcp-config.js';

test('isExcludedServer excludes telegram (only)', () => {
  assert.equal(isExcludedServer('plugin_telegram_telegram'), true);
  assert.equal(isExcludedServer('telegram'), true);
  assert.equal(isExcludedServer('hostinger-email'), false);
  assert.equal(isExcludedServer('whatsapp'), false);
  assert.equal(isExcludedServer('context7'), false);
});

test('resolveEnvPlaceholders substitutes ${VAR}, leaves unknown as-is', () => {
  const env = { FOO: 'bar', TOKEN: 'secret123' } as NodeJS.ProcessEnv;
  assert.equal(resolveEnvPlaceholders('x-${FOO}-y', env), 'x-bar-y');
  assert.equal(resolveEnvPlaceholders('${TOKEN}', env), 'secret123');
  assert.equal(resolveEnvPlaceholders('${MISSING}', env), '${MISSING}'); // unknown untouched
  assert.equal(resolveEnvPlaceholders('no-vars', env), 'no-vars');
});

test('buildMcpServers excludes telegram + resolves ${VAR} in nested env', () => {
  const claudeJson = {
    mcpServers: {
      'plugin_telegram_telegram': { command: 'node', args: ['tg.js'] }, // EXCLUDED
      'hostinger-email': { command: 'npx', args: ['mcp-mail-server'], env: { PASS: '${MAIL_PASS}' } },
      'context7': { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
    },
  };
  const env = { MAIL_PASS: 'hunter2' } as NodeJS.ProcessEnv;
  const out = buildMcpServers(claudeJson, env);
  assert.equal('plugin_telegram_telegram' in out, false, 'telegram excluded');
  assert.ok('hostinger-email' in out, 'email included');
  assert.ok('context7' in out, 'context7 included');
  assert.equal((out['hostinger-email'] as { env: { PASS: string } }).env.PASS, 'hunter2', '${VAR} resolved');
});

test('buildMcpServers tolerates missing/garbage input', () => {
  assert.deepEqual(buildMcpServers(null), {});
  assert.deepEqual(buildMcpServers({}), {});
  assert.deepEqual(buildMcpServers({ mcpServers: { bad: null } }), {});
  assert.deepEqual(buildMcpServers({ mcpServers: { s: 'not-an-object' } }), {});
});
