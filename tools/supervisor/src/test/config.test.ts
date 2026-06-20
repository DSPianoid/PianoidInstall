import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ROLE_TURN_PREFIX, loadConfig, resolveRoleTurnPrefix } from '../config.js';
import { tmpDir } from './helpers.js';

function mkChannel(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('loadConfig points capture + queue under the supervisor state dir', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.ok(cfg.captureFile.startsWith(dir));
    assert.ok(cfg.telegramQueueDir.startsWith(dir));
    assert.ok(cfg.downloadDir.startsWith(dir));
    // No token present → hasToken false, and the config object carries no secret.
    assert.equal(cfg.productionTokenFilePresent, false);
    assert.ok(!JSON.stringify(cfg).includes('TELEGRAM_BOT_TOKEN='));
  } finally {
    cleanup();
  }
});

test('loadConfig.hasToken reflects the channel .env WITHOUT leaking the secret', () => {
  const { dir, cleanup } = tmpDir();
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN; // exercise the .env file path
    const channelDir = join(dir, 'channel');
    writeFileSync(join(mkChannel(channelDir), '.env'), 'TELEGRAM_BOT_TOKEN=secret123:ABC\n');
    const cfg = loadConfig({ stateDir: dir, channelDir });
    assert.equal(cfg.productionTokenFilePresent, true);
    // The secret must NOT appear anywhere in the serialized config (M1: no accessor).
    assert.ok(!JSON.stringify(cfg).includes('secret123'));
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
    cleanup();
  }
});

test('loadConfig.hasToken is true when TELEGRAM_BOT_TOKEN is set in env (no leak)', () => {
  const { dir, cleanup } = tmpDir();
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'from-env';
    const cfg = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(cfg.productionTokenFilePresent, true);
    assert.ok(!JSON.stringify(cfg).includes('from-env'));
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
    cleanup();
  }
});

// M2 — permission policy is config (not a literal in index.ts).
test('loadConfig.permissionPolicy defaults conservative; env widens the allow-list only', () => {
  const { dir, cleanup } = tmpDir();
  const prev = process.env.SUPERVISOR_PERMISSION_ALLOW;
  try {
    delete process.env.SUPERVISOR_PERMISSION_ALLOW;
    const def = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') }).permissionPolicy;
    assert.deepEqual(def.allow, ['Read', 'Glob', 'Grep', 'mcp__telegram__*']);
    assert.equal(def.fallback, 'route', 'fallback stays route (safety floor) by default');

    process.env.SUPERVISOR_PERMISSION_ALLOW = 'Bash, mcp__foo__*, Read';
    const ext = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') }).permissionPolicy;
    assert.deepEqual(ext.allow, ['Read', 'Glob', 'Grep', 'mcp__telegram__*', 'Bash', 'mcp__foo__*'], 'env entries appended, deduped');
    assert.equal(ext.fallback, 'route', 'env can widen allow-list but never disable the safety floor');
  } finally {
    if (prev === undefined) delete process.env.SUPERVISOR_PERMISSION_ALLOW;
    else process.env.SUPERVISOR_PERMISSION_ALLOW = prev;
    cleanup();
  }
});

// FIX 2 — auto-initiate the /orchestrator skill on startup (DEFAULT ON, env-overridable).
test('resolveRoleTurnPrefix DEFAULTS to /orchestrator (auto-start ON) when unset', () => {
  assert.equal(DEFAULT_ROLE_TURN_PREFIX, '/orchestrator');
  assert.equal(resolveRoleTurnPrefix(undefined), '/orchestrator', 'unset → default ON');
});

test('resolveRoleTurnPrefix: env overrides, and empty/none/off disable it', () => {
  assert.equal(resolveRoleTurnPrefix('/orchestrator'), '/orchestrator');
  assert.equal(resolveRoleTurnPrefix('/some-other-skill'), '/some-other-skill', 'custom skill used verbatim');
  assert.equal(resolveRoleTurnPrefix('  /orchestrator  '), '/orchestrator', 'trimmed');
  assert.equal(resolveRoleTurnPrefix(''), undefined, 'empty → OFF');
  assert.equal(resolveRoleTurnPrefix('none'), undefined, 'none → OFF');
  assert.equal(resolveRoleTurnPrefix('OFF'), undefined, 'off (case-insensitive) → OFF');
});

test('loadConfig.roleTurnPrefix defaults ON to /orchestrator; env disables it', () => {
  const { dir, cleanup } = tmpDir();
  const prev = process.env.SUPERVISOR_ROLE_TURN_PREFIX;
  try {
    delete process.env.SUPERVISOR_ROLE_TURN_PREFIX;
    const def = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(def.roleTurnPrefix, '/orchestrator', 'startup input carries the orchestrator invocation by default');

    process.env.SUPERVISOR_ROLE_TURN_PREFIX = 'none';
    const off = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(off.roleTurnPrefix, undefined, 'env none → no auto-role');
  } finally {
    if (prev === undefined) delete process.env.SUPERVISOR_ROLE_TURN_PREFIX;
    else process.env.SUPERVISOR_ROLE_TURN_PREFIX = prev;
    cleanup();
  }
});
