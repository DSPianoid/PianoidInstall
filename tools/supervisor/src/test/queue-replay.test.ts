/**
 * ACCEPTANCE (b): inbound SURVIVES an adapter restart — queue replay, nothing
 * dropped (the FC-2 delivery guarantee, the inbox-queue patch made first-class).
 *
 * We simulate the crash by having the first adapter's handler THROW (so the item
 * is enqueued but never acked), then construct a SECOND adapter over the SAME
 * queue dir (a restart) and assert it replays the un-acked item on start().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import type { InboundMessage } from '../contract.js';
import { FakeVoiceProvider, rawText, rawVoice, tmpDir } from './helpers.js';

function gate() {
  return new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} } });
}

test('inbound un-acked due to a crash is replayed by a restarted adapter', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const queueDir = join(dir, 'queue');
    const downloadDir = join(dir, 'downloads');

    // --- Run 1: handler throws → item enqueued but NOT acked (simulated crash) ---
    const t1 = new LoopbackTelegramTransport();
    const a1 = new TelegramAdapter({ transport: t1, gate: gate(), queueDir, downloadDir });
    await a1.start(async () => {
      throw new Error('handler crashed before ack');
    });
    await t1.inject(rawText('important message', { fromUserId: '999' }));
    // The item must still be pending (un-acked).
    assert.equal(a1.health().queueDepth, 1, 'item left in queue after crash');
    await a1.stop();

    // --- Run 2: a fresh adapter over the SAME queue dir replays on start() ---
    const t2 = new LoopbackTelegramTransport();
    const a2 = new TelegramAdapter({ transport: t2, gate: gate(), queueDir, downloadDir });
    const replayed: InboundMessage[] = [];
    await a2.start(async (msg) => {
      replayed.push(msg);
    });

    // The previously-un-acked inbound is re-delivered — nothing dropped.
    assert.equal(replayed.length, 1, 'queued item replayed on restart');
    assert.equal(replayed[0]!.text, 'important message');
    assert.equal(a2.health().queueDepth, 0, 'replayed item is now acked');
    await a2.stop();
  } finally {
    cleanup();
  }
});

test('M2: a VOICE inbound is durable across a crash AND STT is memoized (runs once)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const queueDir = join(dir, 'queue');
    const downloadDir = join(dir, 'downloads');
    const voice = new FakeVoiceProvider({ outDir: dir, transcript: 'hello voice' });

    // Seed the loopback "download" for the voice file id.
    const fixture = join(dir, 'in.ogg');
    writeFileSync(fixture, 'OggS');

    // Run 1: voice arrives → enqueued (raw) → STT resolves + memoizes → handler
    // THROWS (crash after the durable write) → item stays queued.
    const t1 = new LoopbackTelegramTransport();
    t1.seedDownload('vf', fixture);
    const a1 = new TelegramAdapter({ transport: t1, gate: gate(), queueDir, downloadDir, voice });
    await a1.start(async () => {
      throw new Error('handler crashed after voice resolved');
    });
    await t1.inject(rawVoice('vf', { fromUserId: '999' }));
    assert.equal(a1.health().queueDepth, 1, 'voice item left queued after crash');
    assert.equal(voice.transcribeCalls.length, 1, 'STT ran once in run 1');
    await a1.stop();

    // Run 2 (restart): replay re-delivers; STT is NOT re-run (memoized transcript).
    const t2 = new LoopbackTelegramTransport();
    t2.seedDownload('vf', fixture);
    const a2 = new TelegramAdapter({ transport: t2, gate: gate(), queueDir, downloadDir, voice });
    const replayed: InboundMessage[] = [];
    await a2.start(async (msg) => {
      replayed.push(msg);
    });
    assert.equal(replayed.length, 1, 'voice item replayed on restart');
    assert.equal(replayed[0]!.text, 'hello voice', 'memoized transcript reused');
    assert.equal(voice.transcribeCalls.length, 1, 'STT NOT re-run on replay (memoized — M2)');
    assert.equal(a2.health().queueDepth, 0, 'replayed + acked');
    await a2.stop();
  } finally {
    cleanup();
  }
});

test('a successfully-handled inbound is NOT replayed after restart', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const queueDir = join(dir, 'queue');
    const downloadDir = join(dir, 'downloads');

    const t1 = new LoopbackTelegramTransport();
    const a1 = new TelegramAdapter({ transport: t1, gate: gate(), queueDir, downloadDir });
    await a1.start(async () => {
      /* handled successfully → acked */
    });
    await t1.inject(rawText('handled ok', { fromUserId: '999' }));
    assert.equal(a1.health().queueDepth, 0, 'acked after successful handling');
    await a1.stop();

    const t2 = new LoopbackTelegramTransport();
    const a2 = new TelegramAdapter({ transport: t2, gate: gate(), queueDir, downloadDir });
    const replayed: InboundMessage[] = [];
    await a2.start(async (msg) => {
      replayed.push(msg);
    });
    assert.equal(replayed.length, 0, 'nothing to replay (already acked)');
    await a2.stop();
  } finally {
    cleanup();
  }
});
