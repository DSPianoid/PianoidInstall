/**
 * ACCEPTANCE (c) + the full Phase-1 shell: drive the SUPERVISOR end-to-end over
 * the loopback Telegram adapter and assert the CAPTURE STORE holds a complete,
 * replayable record of the session's events (lifecycle + inbound + outbound).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Supervisor } from '../supervisor.js';
import { Logger } from '../logger.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { FakeVoiceProvider, rawText, tmpDir } from './helpers.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

test('supervisor end-to-end: inbound + outbound captured + replayable', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const captureFile = join(dir, 'capture', 'events.ndjson');
    const supervisor = new Supervisor({
      captureFile,
      logger: silentLogger(),
      unbufferedCapture: true, // synchronous capture for deterministic replay
    });

    const transport = new LoopbackTelegramTransport();
    const adapter = new TelegramAdapter({
      transport,
      gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} } }),
      queueDir: join(dir, 'queue'),
      voice: new FakeVoiceProvider({ outDir: dir }),
      downloadDir: join(dir, 'downloads'),
    });
    supervisor.register(adapter);

    // The host hook (Phase 2 = the session) replies via the supervisor.
    supervisor.onInbound(async (msg) => {
      await supervisor.sendOutbound('telegram', msg.replyHandle, { text: `echo: ${msg.text}` });
    });

    await supervisor.start();
    await transport.inject(rawText('hello supervisor', { fromUserId: '999' }));

    // The outbound reply went out on the loopback transport.
    const reply = transport.sent.find((s) => s.kind === 'text');
    assert.ok(reply);
    assert.equal(reply!.body, 'echo: hello supervisor');

    // The capture store holds the full event stream, replayable from disk.
    const records = supervisor.captureStore.replay();
    const types = records.map((r) => r.event.type);
    assert.ok(types.includes('lifecycle'), 'lifecycle start captured');
    assert.ok(types.includes('channel.inbound'), 'inbound captured');
    assert.ok(types.includes('channel.outbound'), 'outbound captured');

    // Replay preserves payloads (the inbound text + outbound result).
    const inbound = records.find((r) => r.event.type === 'channel.inbound');
    assert.equal((inbound!.event.payload as { text: string }).text, 'hello supervisor');
    const outbound = records.find((r) => r.event.type === 'channel.outbound');
    assert.ok((outbound!.event.payload as { result: { ok: boolean } }).result.ok);

    // Seq is monotonic across the captured stream (ordering guarantee).
    const seqs = records.map((r) => r.event.seq);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!, 'seq strictly increases');
    }

    await supervisor.stop();

    // After stop(), a FRESH read of the file still yields the full stream
    // (durable, not in-memory) — the replayable-record guarantee.
    const reread = supervisor.captureStore.replay();
    assert.ok(reread.length >= records.length);
    assert.ok(reread.some((r) => r.event.type === 'lifecycle' && (r.event.payload as { event: string }).event === 'stop'));
  } finally {
    cleanup();
  }
});

test('supervisor health reports adapters and captured count', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const supervisor = new Supervisor({
      captureFile: join(dir, 'capture.ndjson'),
      logger: silentLogger(),
      unbufferedCapture: true,
    });
    const transport = new LoopbackTelegramTransport();
    supervisor.register(
      new TelegramAdapter({
        transport,
        gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} } }),
        queueDir: join(dir, 'queue'),
        downloadDir: join(dir, 'downloads'),
      }),
    );
    await supervisor.start();
    const h = supervisor.health();
    assert.equal(h.started, true);
    assert.equal(h.adapters.length, 1);
    assert.equal(h.adapters[0]!.channel, 'telegram');
    assert.equal(h.adapters[0]!.running, true);
    assert.ok(h.capturedEvents >= 1); // at least the lifecycle start event
    await supervisor.stop();
  } finally {
    cleanup();
  }
});

test('duplicate adapter registration is rejected', async () => {
  const { dir, cleanup } = tmpDir();
  // unbufferedCapture: true → no open write stream to race the dir cleanup.
  const supervisor = new Supervisor({
    captureFile: join(dir, 'c.ndjson'),
    logger: silentLogger(),
    unbufferedCapture: true,
  });
  try {
    const mk = () =>
      new TelegramAdapter({
        transport: new LoopbackTelegramTransport(),
        gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: [], groups: {} } }),
        queueDir: join(dir, 'q'),
        downloadDir: join(dir, 'd'),
      });
    supervisor.register(mk());
    assert.throws(() => supervisor.register(mk()), /already registered/);
  } finally {
    await supervisor.stop(); // closes the capture store cleanly
    cleanup();
  }
});
