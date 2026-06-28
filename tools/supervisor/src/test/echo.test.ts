/**
 * Echo connectivity-test mode — deterministic loopback wiring test.
 *
 * Proves the dev/test echo host-hook round-trips an inbound back through the
 * adapter's outbound() — text AND voice — over the loopback transport (no
 * network, no live poller). This is the wiring the live `--live --echo`
 * connectivity test exercises against a dedicated test bot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../supervisor.js';
import { Logger } from '../logger.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { makeEchoHook } from '../echo.js';
import type { OutboundResult, ReplyHandle } from '../contract.js';
import { FakeVoiceProvider, rawText, rawVoice, tmpDir } from './helpers.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

test('echo hook (pure): text inbound → outbound text with prefix', async () => {
  const sends: { handle: ReplyHandle; msg: { text?: string; voiceOggPath?: string } }[] = [];
  const hook = makeEchoHook(async (_c, handle, msg): Promise<OutboundResult> => {
    sends.push({ handle, msg });
    return { ok: true, sentIds: ['1'] };
  });
  await hook({ text: 'hi there', attachments: [], user: 'u', ts: '', replyHandle: { to: '5' }, channel: 'telegram' });
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.msg.text, 'Echo: hi there');
});

test('echo hook (pure): voice inbound → outbound voiceOggPath (round-trips a voice note)', async () => {
  const sends: { msg: { text?: string; voiceOggPath?: string } }[] = [];
  const hook = makeEchoHook(async (_c, _h, msg): Promise<OutboundResult> => {
    sends.push({ msg });
    return { ok: true, sentIds: ['1'] };
  });
  await hook({
    text: 'transcript',
    voicePath: '/tmp/in.ogg',
    attachments: [],
    user: 'u',
    ts: '',
    replyHandle: { to: '5' },
    channel: 'telegram',
  });
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.msg.voiceOggPath, '/tmp/in.ogg', 'voice echoed back as a voice note');
  assert.equal(sends[0]!.msg.text, undefined, 'voice echo does not also send text');
});

test('echo end-to-end over the supervisor + loopback: TEXT round-trips as "Echo: …"', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const supervisor = new Supervisor({
      captureFile: join(dir, 'cap.ndjson'),
      logger: silentLogger(),
      unbufferedCapture: true,
    });
    const transport = new LoopbackTelegramTransport();
    supervisor.register(
      new TelegramAdapter({
        transport,
        gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} } }),
        queueDir: join(dir, 'q'),
        downloadDir: join(dir, 'd'),
      }),
    );
    supervisor.onInbound(makeEchoHook((c, h, m) => supervisor.sendOutbound(c, h, m)));
    await supervisor.start();

    await transport.inject(rawText('ping', { fromUserId: '999' }));

    const reply = transport.sent.find((s) => s.kind === 'text');
    assert.ok(reply, 'an echo text reply went out');
    assert.equal(reply!.body, 'Echo: ping');
    await supervisor.stop();
  } finally {
    cleanup();
  }
});

test('echo end-to-end: VOICE round-trips as a voice bubble (sendVoice)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const supervisor = new Supervisor({
      captureFile: join(dir, 'cap.ndjson'),
      logger: silentLogger(),
      unbufferedCapture: true,
    });
    const transport = new LoopbackTelegramTransport();
    const fixture = join(dir, 'in.ogg');
    writeFileSync(fixture, 'OggS');
    transport.seedDownload('vf', fixture);
    supervisor.register(
      new TelegramAdapter({
        transport,
        gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} } }),
        queueDir: join(dir, 'q'),
        downloadDir: join(dir, 'd'),
        voice: new FakeVoiceProvider({ outDir: dir, transcript: 'hello' }),
      }),
    );
    supervisor.onInbound(makeEchoHook((c, h, m) => supervisor.sendOutbound(c, h, m)));
    await supervisor.start();

    await transport.inject(rawVoice('vf', { fromUserId: '999' }));

    const voiceOut = transport.sent.find((s) => s.kind === 'file' && s.fileKind === 'voice');
    assert.ok(voiceOut, 'an echo VOICE note went back out (sendVoice)');
    await supervisor.stop();
  } finally {
    cleanup();
  }
});
