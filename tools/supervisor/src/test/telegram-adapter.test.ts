/**
 * ACCEPTANCE (a) + the inbox-queue/voice subsumption: the Telegram adapter
 * round-trips a message through the M10 contract — including a VOICE NOTE BOTH
 * DIRECTIONS — over the LOOPBACK transport (no plugin patch, no live poller).
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

function makeAdapter(dir: string, voiceOpts?: { stt?: boolean; tts?: boolean; transcript?: string }) {
  const transport = new LoopbackTelegramTransport();
  const gate = new AccessGate({
    staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} },
  });
  const voice = new FakeVoiceProvider({ outDir: dir, ...voiceOpts });
  const adapter = new TelegramAdapter({
    transport,
    gate,
    queueDir: join(dir, 'queue'),
    voice,
    downloadDir: join(dir, 'downloads'),
  });
  return { transport, adapter, voice };
}

test('TEXT round-trip: inbound delivered via contract → outbound text sent', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir);
    const received: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
      // Reply over the contract using the inbound's reply handle.
      await adapter.outbound(msg.replyHandle, { text: 'pong' });
    });

    await transport.inject(rawText('ping', { fromUserId: '999' }));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.text, 'ping');
    assert.equal(received[0]!.channel, 'telegram');
    assert.equal(received[0]!.replyHandle.to, '555');

    const out = transport.sent.find((s) => s.kind === 'text');
    assert.ok(out, 'a text reply was sent');
    assert.equal(out!.body, 'pong');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('non-allowlisted inbound is dropped (gate preserved, nothing delivered)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir);
    const received: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await transport.inject(rawText('intruder', { fromUserId: '000' }));
    assert.equal(received.length, 0);
    assert.equal(adapter.health().queueDepth, 0); // never even queued
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('VOICE IN: inbound voice note → downloaded → STT → text delivered', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter, voice } = makeAdapter(dir, { transcript: 'hello from voice' });
    // Seed a fake OGG the loopback "download" will copy.
    const fixture = join(dir, 'inbound-voice.ogg');
    writeFileSync(fixture, 'OggS fake-inbound');
    transport.seedDownload('voice-file-1', fixture);

    const received: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await transport.inject(rawVoice('voice-file-1', { fromUserId: '999' }));

    assert.equal(received.length, 1);
    // STT transcript becomes the text content (voice patch + transcribe, native).
    assert.equal(received[0]!.text, 'hello from voice');
    assert.ok(received[0]!.voicePath, 'voicePath is set on the inbound');
    assert.equal(voice.transcribeCalls.length, 1);
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('VOICE IN degrades gracefully when STT is unavailable', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir, { stt: false });
    const fixture = join(dir, 'v.ogg');
    writeFileSync(fixture, 'OggS');
    transport.seedDownload('vf', fixture);
    const received: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await transport.inject(rawVoice('vf', { fromUserId: '999' }));
    assert.equal(received.length, 1);
    assert.equal(received[0]!.text, '(voice message)'); // placeholder, not dropped
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('VOICE OUT: outbound modality=voice → TTS → sendVoice bubble', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter, voice } = makeAdapter(dir);
    await adapter.start(async () => {});
    const res = await adapter.outbound(
      { to: '555' },
      { text: 'speak this', options: { modality: 'voice' } },
    );
    assert.ok(res.ok);
    assert.equal(voice.synthesizeCalls.length, 1);
    const sent = transport.sent.find((s) => s.kind === 'file');
    assert.ok(sent, 'a file was sent');
    assert.equal(sent!.fileKind, 'voice', 'sent as a voice bubble (sendVoice)');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('VOICE OUT falls back to text when TTS is unavailable', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir, { tts: false });
    await adapter.start(async () => {});
    const res = await adapter.outbound(
      { to: '555' },
      { text: 'no tts here', options: { modality: 'voice' } },
    );
    assert.ok(res.ok);
    const txt = transport.sent.find((s) => s.kind === 'text');
    assert.ok(txt, 'fell back to a text reply');
    assert.equal(txt!.body, 'no tts here');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('DUAL OUT: modality=dual → BOTH a text message AND a TTS voice bubble', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter, voice } = makeAdapter(dir);
    await adapter.start(async () => {});
    const res = await adapter.outbound(
      { to: '555' },
      { text: 'both ways', options: { modality: 'dual' } },
    );
    assert.ok(res.ok);
    // TTS ran once.
    assert.equal(voice.synthesizeCalls.length, 1);
    // A text record AND a voice-file record are both present.
    const txt = transport.sent.find((s) => s.kind === 'text');
    const vox = transport.sent.find((s) => s.kind === 'file' && s.fileKind === 'voice');
    assert.ok(txt, 'a text message was sent');
    assert.equal(txt!.body, 'both ways');
    assert.ok(vox, 'a voice bubble was also sent');
    // Exactly one of each (no double-text).
    assert.equal(transport.sent.filter((s) => s.kind === 'text').length, 1);
    assert.equal(transport.sent.filter((s) => s.kind === 'file' && s.fileKind === 'voice').length, 1);
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('DUAL OUT with TTS unavailable: text still sent, NO double-text, no voice', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir, { tts: false });
    await adapter.start(async () => {});
    const res = await adapter.outbound(
      { to: '555' },
      { text: 'text survives', options: { modality: 'dual' } },
    );
    assert.ok(res.ok);
    const textSends = transport.sent.filter((s) => s.kind === 'text');
    const voiceSends = transport.sent.filter((s) => s.kind === 'file' && s.fileKind === 'voice');
    assert.equal(textSends.length, 1, 'exactly one text send (no fallback double-text)');
    assert.equal(textSends[0]!.body, 'text survives');
    assert.equal(voiceSends.length, 0, 'no voice bubble when TTS is unavailable');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('DUAL OUT with empty text: nothing synthesized, nothing sent', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter, voice } = makeAdapter(dir);
    await adapter.start(async () => {});
    const res = await adapter.outbound({ to: '555' }, { text: '   ', options: { modality: 'dual' } });
    assert.ok(res.ok);
    // Whitespace-only text: TTS is skipped; the empty text send is a no-op chunk.
    assert.equal(voice.synthesizeCalls.length, 0, 'TTS skipped for empty/whitespace text');
    assert.equal(transport.sent.filter((s) => s.kind === 'file').length, 0, 'no voice bubble');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('MODALITY ROUTING: voice→sendVoice(generated audio), text→sendMessage, dual→both (regression guard for the outbound-voice fix)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter, voice } = makeAdapter(dir);
    await adapter.start(async () => {});

    // (1) voice → exactly one voice bubble, NO text; the bubble carries the
    // GENERATED audio (the .ogg the codec.synthesize produced for THIS text).
    const rVoice = await adapter.outbound(
      { to: '555' },
      { text: 'speak only', options: { modality: 'voice' } },
    );
    assert.ok(rVoice.ok);
    assert.deepEqual(voice.synthesizeCalls, ['speak only'], 'TTS rendered the exact reply text');
    const voiceFiles = transport.sent.filter((s) => s.kind === 'file' && s.fileKind === 'voice');
    assert.equal(voiceFiles.length, 1, 'voice mode → one sendVoice');
    assert.equal(transport.sent.filter((s) => s.kind === 'text').length, 0, 'voice mode → no sendMessage');
    // The bubble body is a real file path under the fake codec's out dir (the
    // generated audio), not arbitrary text — proves the GENERATED audio is sent.
    assert.ok(
      voiceFiles[0]!.body.startsWith(dir) && voiceFiles[0]!.body.endsWith('.ogg'),
      `voice bubble sends the generated .ogg (got ${voiceFiles[0]!.body})`,
    );

    // (2) text → exactly one sendMessage, NO voice bubble, NO further TTS.
    const before = voice.synthesizeCalls.length;
    const rText = await adapter.outbound(
      { to: '555' },
      { text: 'type only', options: { modality: 'text' } },
    );
    assert.ok(rText.ok);
    assert.equal(voice.synthesizeCalls.length, before, 'text mode → no TTS');
    const textOnly = transport.sent.filter((s) => s.kind === 'text' && s.body === 'type only');
    assert.equal(textOnly.length, 1, 'text mode → one sendMessage');
    assert.equal(
      transport.sent.filter((s) => s.kind === 'file' && s.body.includes('type only')).length,
      0,
      'text mode → no voice bubble',
    );

    // (3) dual → BOTH one sendMessage AND one sendVoice for the same text.
    const rDual = await adapter.outbound(
      { to: '555' },
      { text: 'both now', options: { modality: 'dual' } },
    );
    assert.ok(rDual.ok);
    assert.ok(voice.synthesizeCalls.includes('both now'), 'dual mode → TTS rendered the text');
    assert.equal(
      transport.sent.filter((s) => s.kind === 'text' && s.body === 'both now').length,
      1,
      'dual mode → one sendMessage',
    );
    // One NEW voice bubble appeared for the dual send (total voice bubbles now 2).
    assert.equal(
      transport.sent.filter((s) => s.kind === 'file' && s.fileKind === 'voice').length,
      2,
      'dual mode → one more sendVoice (2 total across voice+dual sends)',
    );

    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('a pre-rendered voiceOggPath sends as a voice bubble', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir);
    const ogg = join(dir, 'pre.ogg');
    writeFileSync(ogg, 'OggS');
    await adapter.start(async () => {});
    const res = await adapter.outbound({ to: '555' }, { voiceOggPath: ogg });
    assert.ok(res.ok);
    const sent = transport.sent.find((s) => s.kind === 'file');
    assert.equal(sent!.fileKind, 'voice');
    await adapter.stop();
  } finally {
    cleanup();
  }
});

test('long text is chunked into <=4096-char messages', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const { transport, adapter } = makeAdapter(dir);
    await adapter.start(async () => {});
    const long = 'x'.repeat(4096 * 2 + 10);
    const res = await adapter.outbound({ to: '555' }, { text: long });
    assert.ok(res.ok);
    const textSends = transport.sent.filter((s) => s.kind === 'text');
    assert.equal(textSends.length, 3); // 4096 + 4096 + 10
    assert.ok(textSends.every((s) => s.body.length <= 4096));
    await adapter.stop();
  } finally {
    cleanup();
  }
});
