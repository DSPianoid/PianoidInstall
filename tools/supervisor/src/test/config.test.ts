import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
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
    assert.equal(cfg.hasToken, false);
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
    assert.equal(cfg.hasToken, true);
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
    assert.equal(cfg.hasToken, true);
    assert.ok(!JSON.stringify(cfg).includes('from-env'));
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
    cleanup();
  }
});
