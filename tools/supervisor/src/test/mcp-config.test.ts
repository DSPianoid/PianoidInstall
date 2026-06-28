/**
 * MCP-config builder tests: exclude telegram, resolve ${VAR}, tolerate junk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMcpServers,
  isExcludedServer,
  resolveEnvPlaceholders,
  OUTWARD_SEND_EXCLUDE_SUBSTRINGS,
  HOSTED_MCP_EXCLUDE_SUBSTRINGS,
} from '../mcp-config.js';

test('isExcludedServer excludes telegram (only) by default', () => {
  assert.equal(isExcludedServer('plugin_telegram_telegram'), true);
  assert.equal(isExcludedServer('telegram'), true);
  assert.equal(isExcludedServer('hostinger-email'), false);
  assert.equal(isExcludedServer('whatsapp'), false);
  assert.equal(isExcludedServer('context7'), false);
});

test('★ OUTWARD_SEND_EXCLUDE drops telegram AND whatsapp, keeps email/compute (test seal)', () => {
  const ex = OUTWARD_SEND_EXCLUDE_SUBSTRINGS;
  assert.equal(isExcludedServer('telegram', ex), true);
  assert.equal(isExcludedServer('whatsapp', ex), true);
  assert.equal(isExcludedServer('whatsapp-work', ex), true);
  // email kept (read tools useful; SEND tools denied via the policy deny-list)
  assert.equal(isExcludedServer('hostinger-email', ex), false);
  assert.equal(isExcludedServer('context7', ex), false);
  assert.equal(isExcludedServer('deepseek-codegen', ex), false);
  assert.equal(isExcludedServer('google-workspace', ex), false);
  const out = buildMcpServers(
    { mcpServers: { telegram: { command: 't' }, whatsapp: { command: 'w' }, 'whatsapp-work': { command: 'ww' }, 'hostinger-email': { command: 'e' }, context7: { command: 'c' } } },
    process.env,
    ex,
  );
  assert.deepEqual(Object.keys(out).sort(), ['context7', 'hostinger-email']);
});

test('★ (criterion b) HOSTED_MCP_EXCLUDE drops ONLY telegram — keeps whatsapp + deepseek + hostinger (the hosted curated map)', () => {
  const ex = HOSTED_MCP_EXCLUDE_SUBSTRINGS;
  assert.deepEqual(ex, ['telegram'], 'hosted map excludes ONLY telegram (the hijack vector)');
  // telegram (both forms) excluded
  assert.equal(isExcludedServer('telegram', ex), true);
  assert.equal(isExcludedServer('plugin_telegram_telegram', ex), true);
  // the three sanctioned servers + the rest are KEPT
  assert.equal(isExcludedServer('whatsapp', ex), false, 'whatsapp KEPT (read-allowed/send-gated)');
  assert.equal(isExcludedServer('whatsapp-work', ex), false, 'whatsapp-work KEPT');
  assert.equal(isExcludedServer('deepseek-codegen', ex), false, 'deepseek-codegen KEPT');
  assert.equal(isExcludedServer('hostinger-email', ex), false, 'hostinger-email KEPT');
  assert.equal(isExcludedServer('context7', ex), false);
  assert.equal(isExcludedServer('chrome-devtools', ex), false);
  assert.equal(isExcludedServer('google-workspace', ex), false);
  // The full curated map over the user's real server set: telegram OUT, everything else IN.
  const out = buildMcpServers(
    {
      mcpServers: {
        'plugin_telegram_telegram': { command: 'tg' },
        whatsapp: { command: 'w' },
        'whatsapp-work': { command: 'ww' },
        'deepseek-codegen': { command: 'd', env: { DEEPSEEK_API_KEY: 'k' } },
        'hostinger-email': { command: 'e', env: { EMAIL_PASS: 'p' } },
        context7: { command: 'c' },
        'chrome-devtools': { command: 'cd' },
        'google-workspace': { command: 'g' },
      },
    },
    process.env,
    ex,
  );
  assert.deepEqual(
    Object.keys(out).sort(),
    ['chrome-devtools', 'context7', 'deepseek-codegen', 'google-workspace', 'hostinger-email', 'whatsapp', 'whatsapp-work'],
    'telegram EXCLUDED; whatsapp+deepseek+hostinger (and the rest) INCLUDED',
  );
  assert.equal('plugin_telegram_telegram' in out, false, 'telegram never in the hosted map');
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
