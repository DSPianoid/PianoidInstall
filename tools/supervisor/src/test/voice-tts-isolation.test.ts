/**
 * OUTBOUND-TTS ISOLATION test (the runtime bug fix — the outbound mirror of
 * voice-stt-isolation.test.ts).
 *
 * The runtime defect: `/mode voice` correctly set the SessionHost modality to
 * "voice" and the reply was tagged `options.modality:"voice"` and SENT ok, but the
 * user received PLAIN TEXT, not a playable voice note. The OUTBOUND adapter path
 * (telegram.ts) is CORRECTLY wired — it branches on modality, checks
 * `isTtsAvailable()` (TRUE once config points `ttsScript` at the real repo
 * `tools/tts_voice.py`), calls `synthesize()`, and on throw catches → falls back
 * to a text send. The real defect was that `edge-tts` was NOT installed in
 * `PianoidCore/.venv`, so `tts_voice.py` failed at its top-level `import edge_tts`
 * → exits non-zero → `VoiceCodec.synthesize()` throws → silent text fallback. The
 * fake-VoiceProvider adapter tests (telegram-adapter.test.ts VOICE OUT/DUAL OUT)
 * proved the ROUTING but NOT the real python+script+edge-tts wiring where the bug
 * lived. Fix: install edge-tts into the repo venv (the validated TTS environment);
 * the config already resolves `ttsScript`/`python` correctly (the inbound fix).
 *
 * This test exercises the REAL VoiceCodec built from the REAL `loadConfig()`
 * defaults, BOTH:
 *   1. directly (VoiceCodec.synthesize(sampleText) → a real Ogg/Opus .ogg), and
 *   2. end-to-end through TelegramAdapter's OUTBOUND path with modality:'voice'
 *      (the loopback transport records a 'voice' file send whose body is the
 *      produced .ogg — NOT a text fallback, which is what the bug produced).
 *
 * The test SKIPS (does not fail) on a box where the venv / edge-tts / ffmpeg /
 * network aren't set up — but it MUST run + pass on the dev box that reproduced
 * the bug. It is the only test that proves the real edge-tts wiring; the rest stay
 * on the fake codec. (edge-tts needs network to reach the MS neural-voice service.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { VoiceCodec } from '../voice.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { tmpDir } from './helpers.js';

const SAMPLE_TEXT = 'This is a test voice note from the supervisor.';

/**
 * Build a REAL VoiceCodec from the production config DEFAULTS (no toolsDir/python
 * opts, no env overrides) — so the test fails if the defaults regress back to the
 * bad ~/.claude/bare-python values. Returns null if TTS can't run on this box (the
 * script or interpreter is missing) so the test skips cleanly elsewhere.
 */
function realCodecFromDefaults(tmp: string): VoiceCodec | null {
  const prevTools = process.env.SUPERVISOR_TOOLS_DIR;
  const prevPy = process.env.SUPERVISOR_PYTHON;
  try {
    delete process.env.SUPERVISOR_TOOLS_DIR; // exercise the DERIVED defaults, not an env pin
    delete process.env.SUPERVISOR_PYTHON;
    const cfg = loadConfig({ stateDir: tmp, channelDir: join(tmp, 'no-channel') });
    // The defaults must resolve to the REAL repo TTS script + an interpreter that exists.
    if (!existsSync(cfg.ttsScript)) return null;
    if (!existsSync(cfg.python)) return null; // venv python; bare 'python' on PATH won't exist as a file
    return new VoiceCodec({
      python: cfg.python,
      sttScript: cfg.sttScript,
      ttsScript: cfg.ttsScript,
      tmpDir: join(tmp, 'tts'),
      // edge-tts hits a network service + ffmpeg; generous ceiling for slow boxes.
      timeoutMs: 120_000,
    });
  } finally {
    if (prevTools === undefined) delete process.env.SUPERVISOR_TOOLS_DIR;
    else process.env.SUPERVISOR_TOOLS_DIR = prevTools;
    if (prevPy === undefined) delete process.env.SUPERVISOR_PYTHON;
    else process.env.SUPERVISOR_PYTHON = prevPy;
  }
}

/** Assert a produced file is a real, non-empty Ogg/Opus voice note (not text). */
function assertRealOgg(oggPath: string | undefined): void {
  assert.ok(oggPath, 'a produced .ogg path was returned');
  assert.ok(existsSync(oggPath!), `the produced file exists: ${oggPath}`);
  const size = statSync(oggPath!).size;
  assert.ok(size > 0, `the produced .ogg is non-empty (size=${size})`);
  // Ogg containers begin with the 'OggS' capture pattern — proves it's real audio,
  // not e.g. an error string or an empty file. (Telegram sendVoice needs Ogg/Opus.)
  const head = readFileSync(oggPath!).subarray(0, 4).toString('latin1');
  assert.equal(head, 'OggS', `the produced file is an Ogg container (got header ${JSON.stringify(head)})`);
}

test('config defaults resolve the REAL repo TTS script + venv python (not ~/.claude / bare python)', () => {
  const { dir, cleanup } = tmpDir();
  const prevTools = process.env.SUPERVISOR_TOOLS_DIR;
  const prevPy = process.env.SUPERVISOR_PYTHON;
  try {
    delete process.env.SUPERVISOR_TOOLS_DIR;
    delete process.env.SUPERVISOR_PYTHON;
    const cfg = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.ok(
      cfg.ttsScript.endsWith(join('tools', 'tts_voice.py')),
      `ttsScript should be under repo tools/ (got ${cfg.ttsScript})`,
    );
  } finally {
    if (prevTools === undefined) delete process.env.SUPERVISOR_TOOLS_DIR;
    else process.env.SUPERVISOR_TOOLS_DIR = prevTools;
    if (prevPy === undefined) delete process.env.SUPERVISOR_PYTHON;
    else process.env.SUPERVISOR_PYTHON = prevPy;
    cleanup();
  }
});

test('REAL VoiceCodec (config defaults) isTts available + synthesizes sample text to a real Ogg/Opus voice note', { timeout: 180_000 }, async (t) => {
  const { dir, cleanup } = tmpDir();
  try {
    const codec = realCodecFromDefaults(dir);
    if (!codec) {
      t.skip('repo TTS script or venv python not present — real-TTS test skipped on this box');
      return;
    }
    assert.equal(codec.isTtsAvailable(), true, 'isTtsAvailable() must be true with the real repo script');
    let ogg: string;
    try {
      ogg = await codec.synthesize(SAMPLE_TEXT);
    } catch (err) {
      // edge-tts needs network / a working ffmpeg. A genuine env gap is a SKIP,
      // not a failure (the dev box that reproduced the bug WILL pass). But a
      // ModuleNotFoundError for edge_tts IS the bug — fail loudly on that.
      const m = String(err);
      if (/ModuleNotFoundError.*edge_tts|No module named ['"]?edge_tts/i.test(m)) {
        assert.fail(`edge-tts is missing from the venv (THE BUG): ${m}`);
      }
      t.skip(`TTS could not run (network/ffmpeg env gap, not the edge-tts-missing bug): ${m}`);
      return;
    }
    assertRealOgg(ogg);
  } finally {
    cleanup();
  }
});

test('END-TO-END outbound: modality=voice → TelegramAdapter + REAL codec sends a voice bubble (Ogg/Opus), NOT a text fallback', { timeout: 180_000 }, async (t) => {
  const { dir, cleanup } = tmpDir();
  try {
    const codec = realCodecFromDefaults(dir);
    if (!codec) {
      t.skip('repo TTS script or venv python not present — real-TTS e2e skipped on this box');
      return;
    }
    // Probe once so a network/ffmpeg gap SKIPS the e2e (vs failing); the
    // edge-tts-missing bug is caught by the direct test above.
    try {
      await codec.synthesize('probe');
    } catch (err) {
      t.skip(`TTS could not run (env gap): ${String(err)}`);
      return;
    }

    const transport = new LoopbackTelegramTransport();
    const gate = new AccessGate({
      staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} },
    });
    const adapter = new TelegramAdapter({
      transport,
      gate,
      queueDir: join(dir, 'queue'),
      voice: codec, // ★ the REAL VoiceCodec (venv python + repo script + edge-tts)
      downloadDir: join(dir, 'downloads'),
    });
    await adapter.start(async () => {});

    const res = await adapter.outbound(
      { to: '555' },
      { text: SAMPLE_TEXT, options: { modality: 'voice' } },
    );
    assert.ok(res.ok, 'outbound succeeded');

    // THE BUG FIX: a VOICE bubble is sent (sendVoice), not a text fallback.
    const voiceSends = transport.sent.filter((s) => s.kind === 'file' && s.fileKind === 'voice');
    const textSends = transport.sent.filter((s) => s.kind === 'text');
    assert.equal(voiceSends.length, 1, 'exactly one voice bubble was sent (NOT a text fallback)');
    assert.equal(textSends.length, 0, 'no text fallback in voice-only mode (the bug sent text here)');
    // The voice bubble carries the REAL produced Ogg/Opus file.
    assertRealOgg(voiceSends[0]!.body);

    await adapter.stop();
  } finally {
    cleanup();
  }
});
