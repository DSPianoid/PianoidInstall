import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_TURN_PREFIX,
  DEFAULT_PING_RESPONSE_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  loadConfig,
  resolveRoleTurnPrefix,
  resolveRecoveryLadder,
  resolveAutoSnapshot,
  resolveAutoSnapshotIntervalMs,
  resolveRestartDrainMs,
  resolveStatusProbeMs,
  resolvePingResponseTimeoutMs,
  resolvePingIntervalMs,
} from '../config.js';
import { DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS } from '../control-command.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// ★ REDESIGN (dev-3e66) — control-panel automatic-behavior resolvers (all default OFF/0)
// ─────────────────────────────────────────────────────────────────────────────

test('REDESIGN resolveRecoveryLadder / resolveAutoSnapshot: default OFF; on for 1/true/on', () => {
  for (const off of [undefined, '', '0', 'false', 'no', 'off']) {
    assert.equal(resolveRecoveryLadder(off), false, `recoveryLadder OFF for ${JSON.stringify(off)}`);
    assert.equal(resolveAutoSnapshot(off), false, `autoSnapshot OFF for ${JSON.stringify(off)}`);
  }
  for (const on of ['1', 'true', 'on', 'TRUE', ' On ']) {
    assert.equal(resolveRecoveryLadder(on), true, `recoveryLadder ON for ${JSON.stringify(on)}`);
    assert.equal(resolveAutoSnapshot(on), true, `autoSnapshot ON for ${JSON.stringify(on)}`);
  }
});

test('REDESIGN resolveAutoSnapshotIntervalMs: default 120s; positive int verbatim; junk → default', () => {
  assert.equal(resolveAutoSnapshotIntervalMs(undefined), DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS);
  assert.equal(resolveAutoSnapshotIntervalMs(''), DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS);
  assert.equal(resolveAutoSnapshotIntervalMs('0'), DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS, '0 → default (not 0)');
  assert.equal(resolveAutoSnapshotIntervalMs('-5'), DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS);
  assert.equal(resolveAutoSnapshotIntervalMs('abc'), DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS);
  assert.equal(resolveAutoSnapshotIntervalMs('30000'), 30000);
});

test('REDESIGN resolveRestartDrainMs / resolveStatusProbeMs: default 0 (disabled); positive int verbatim', () => {
  for (const fn of [resolveRestartDrainMs, resolveStatusProbeMs]) {
    assert.equal(fn(undefined), 0, 'default 0 = disabled');
    assert.equal(fn(''), 0);
    assert.equal(fn('0'), 0);
    assert.equal(fn('-1'), 0);
    assert.equal(fn('abc'), 0);
    assert.equal(fn('5000'), 5000, 'positive int used verbatim');
  }
});

test('REDESIGN loadConfig: the 4 automatic behaviors default OFF/0 (byte-for-byte today)', () => {
  const { dir, cleanup } = tmpDir('cfg-redesign');
  const saved: Record<string, string | undefined> = {};
  for (const k of [
    'SUPERVISOR_RECOVERY_LADDER',
    'SUPERVISOR_AUTO_SNAPSHOT',
    'SUPERVISOR_AUTO_SNAPSHOT_INTERVAL_MS',
    'SUPERVISOR_RESTART_DRAIN_MS',
    'SUPERVISOR_STATUS_PROBE_MS',
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const c = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(c.recoveryLadder, false, 'recoveryLadder default OFF');
    assert.equal(c.autoSnapshot, false, 'autoSnapshot default OFF');
    assert.equal(c.autoSnapshotIntervalMs, DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS);
    assert.equal(c.restartDrainMs, 0, 'restartDrainMs default 0 = no escalation wait');
    assert.equal(c.statusProbeMs, 0, 'statusProbeMs default 0 = no live probe');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  }
});

// ── ★ D4 — the ALWAYS-ON liveness-ping deadline + cadence (false-positive-restart fix) ──
test('D4 resolvePingResponseTimeoutMs: default 180s; positive int verbatim; junk → default', () => {
  assert.equal(resolvePingResponseTimeoutMs(undefined), DEFAULT_PING_RESPONSE_TIMEOUT_MS);
  assert.equal(DEFAULT_PING_RESPONSE_TIMEOUT_MS, 180_000, 'default raised to 180s (was a hardcoded 60s)');
  assert.equal(resolvePingResponseTimeoutMs(''), DEFAULT_PING_RESPONSE_TIMEOUT_MS);
  assert.equal(resolvePingResponseTimeoutMs('0'), DEFAULT_PING_RESPONSE_TIMEOUT_MS, '0 → default (not 0)');
  assert.equal(resolvePingResponseTimeoutMs('-5'), DEFAULT_PING_RESPONSE_TIMEOUT_MS);
  assert.equal(resolvePingResponseTimeoutMs('abc'), DEFAULT_PING_RESPONSE_TIMEOUT_MS);
  assert.equal(resolvePingResponseTimeoutMs('240000'), 240000, 'positive int used verbatim');
  assert.equal(resolvePingResponseTimeoutMs('90000.7'), 90000, 'floored');
});

test('D4 resolvePingIntervalMs: default 120s; positive int verbatim; junk → default', () => {
  assert.equal(resolvePingIntervalMs(undefined), DEFAULT_PING_INTERVAL_MS);
  assert.equal(DEFAULT_PING_INTERVAL_MS, 120_000, 'cadence default unchanged at 120s');
  assert.equal(resolvePingIntervalMs(''), DEFAULT_PING_INTERVAL_MS);
  assert.equal(resolvePingIntervalMs('0'), DEFAULT_PING_INTERVAL_MS);
  assert.equal(resolvePingIntervalMs('-1'), DEFAULT_PING_INTERVAL_MS);
  assert.equal(resolvePingIntervalMs('abc'), DEFAULT_PING_INTERVAL_MS);
  assert.equal(resolvePingIntervalMs('60000'), 60000, 'positive int used verbatim');
});

test('D4 loadConfig: pingResponseTimeoutMs defaults 180s + pingIntervalMs 120s; env overrides', () => {
  const { dir, cleanup } = tmpDir('cfg-ping');
  const saved: Record<string, string | undefined> = {};
  for (const k of ['SUPERVISOR_PING_RESPONSE_TIMEOUT_MS', 'SUPERVISOR_PING_INTERVAL_MS']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const dflt = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(dflt.pingResponseTimeoutMs, DEFAULT_PING_RESPONSE_TIMEOUT_MS, 'deadline default 180s');
    assert.equal(dflt.pingIntervalMs, DEFAULT_PING_INTERVAL_MS, 'cadence default 120s');
    process.env.SUPERVISOR_PING_RESPONSE_TIMEOUT_MS = '300000';
    process.env.SUPERVISOR_PING_INTERVAL_MS = '90000';
    const over = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(over.pingResponseTimeoutMs, 300000, 'env override for the deadline');
    assert.equal(over.pingIntervalMs, 90000, 'env override for the cadence');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  }
});
