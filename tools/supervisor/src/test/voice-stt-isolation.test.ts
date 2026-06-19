/**
 * INBOUND-STT ISOLATION test (the runtime bug fix).
 *
 * The runtime defect: the supervisor delivered the literal placeholder
 * "(voice message)" to the agent INSTEAD of the faster-whisper transcript, even
 * though `tools/transcribe_voice.py` transcribes the captured .oga correctly when
 * run by hand. The fake-VoiceCodec adapter tests (telegram-adapter.test.ts VOICE
 * IN) proved the SUBSTITUTION logic but NOT the real config/python/script wiring
 * where the bug lived: production `loadConfig` defaulted `sttScript` to
 * `~/.claude/transcribe_voice.py` (does not exist → isSttAvailable() false →
 * silent placeholder) and `python` to a bare `python` that lacks faster-whisper
 * (transcribe() throws → placeholder). Fix: config defaults the tools dir to the
 * repo `tools/` and python to the repo venv (both env-overridable).
 *
 * This test exercises the REAL VoiceCodec built from the REAL `loadConfig()`
 * defaults against the REAL captured sample .oga, BOTH:
 *   1. directly (VoiceCodec.transcribe → real transcript), and
 *   2. end-to-end through TelegramAdapter's inbound path (loopback transport
 *      "downloads" the seeded sample, the codec transcribes it, and the delivered
 *      InboundMessage.text is the real transcript — NOT the "(voice message)"
 *      placeholder the bug produced).
 *
 * The test SKIPS (does not fail) on a box where the venv / STT model isn't set up
 * — but it MUST run + pass on the dev box that reproduced the bug. It is the only
 * test that proves the real python+script wiring; the rest stay on the fake codec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { VoiceCodec } from '../voice.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import type { InboundMessage } from '../contract.js';
import { rawVoice, tmpDir } from './helpers.js';

const PLACEHOLDER = '(voice message)';

/** The captured sample voice note (downloaded by the running supervisor). */
const SAMPLE_OGA = join(
  homedir(),
  '.claude',
  'supervisor',
  'downloads',
  '1781873498004-AgADdJ8AAvH7qEk.oga',
);

/**
 * Build a REAL VoiceCodec from the production config DEFAULTS (no toolsDir/python
 * opts, no env overrides) — so the test fails if the defaults regress back to the
 * bad ~/.claude/bare-python values. Returns null if STT can't run on this box
 * (the script or interpreter is missing) so the test can skip cleanly elsewhere.
 */
function realCodecFromDefaults(tmp: string): VoiceCodec | null {
  const prevTools = process.env.SUPERVISOR_TOOLS_DIR;
  const prevPy = process.env.SUPERVISOR_PYTHON;
  try {
    delete process.env.SUPERVISOR_TOOLS_DIR; // exercise the DERIVED defaults, not an env pin
    delete process.env.SUPERVISOR_PYTHON;
    const cfg = loadConfig({ stateDir: tmp, channelDir: join(tmp, 'no-channel') });
    // The defaults must resolve to the REAL repo script + an interpreter that exists.
    if (!existsSync(cfg.sttScript)) return null;
    if (!existsSync(cfg.python)) return null; // venv python; bare 'python' on PATH won't exist as a file
    return new VoiceCodec({
      python: cfg.python,
      sttScript: cfg.sttScript,
      ttsScript: cfg.ttsScript,
      tmpDir: join(tmp, 'tts'),
      // STT model can be slow (cold start / CPU). Generous ceiling for CI-ish boxes.
      timeoutMs: 120_000,
    });
  } finally {
    if (prevTools === undefined) delete process.env.SUPERVISOR_TOOLS_DIR;
    else process.env.SUPERVISOR_TOOLS_DIR = prevTools;
    if (prevPy === undefined) delete process.env.SUPERVISOR_PYTHON;
    else process.env.SUPERVISOR_PYTHON = prevPy;
  }
}

/** Assert a delivered transcript is the REAL content (not the bug's placeholder). */
function assertRealTranscript(text: string | undefined): void {
  assert.ok(text, 'a transcript was delivered');
  assert.notEqual(text, PLACEHOLDER, `must NOT be the "${PLACEHOLDER}" placeholder (the bug)`);
  assert.ok(text!.trim().length > 0, 'transcript is non-empty');
  // The sample says "This is a test voice note" — assert stable content words
  // (case-insensitive) so minor STT casing/punctuation variance does not flake.
  const low = text!.toLowerCase();
  assert.ok(low.includes('test'), `transcript should contain "test" (got: ${JSON.stringify(text)})`);
  assert.ok(low.includes('voice'), `transcript should contain "voice" (got: ${JSON.stringify(text)})`);
}

test('config defaults resolve the REAL repo STT script + venv python (not ~/.claude / bare python)', () => {
  const { dir, cleanup } = tmpDir();
  const prevTools = process.env.SUPERVISOR_TOOLS_DIR;
  const prevPy = process.env.SUPERVISOR_PYTHON;
  try {
    delete process.env.SUPERVISOR_TOOLS_DIR;
    delete process.env.SUPERVISOR_PYTHON;
    const cfg = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    // The script must live under the repo tools/, NOT ~/.claude (the prior default).
    assert.ok(
      cfg.sttScript.endsWith(join('tools', 'transcribe_voice.py')),
      `sttScript should be under repo tools/ (got ${cfg.sttScript})`,
    );
    assert.ok(
      !cfg.sttScript.startsWith(join(homedir(), '.claude', 'transcribe')),
      'sttScript must NOT be the broken ~/.claude default',
    );
    assert.equal(cfg.ttsScript, join(cfg.sttScript.replace(/transcribe_voice\.py$/, 'tts_voice.py')));
  } finally {
    if (prevTools === undefined) delete process.env.SUPERVISOR_TOOLS_DIR;
    else process.env.SUPERVISOR_TOOLS_DIR = prevTools;
    if (prevPy === undefined) delete process.env.SUPERVISOR_PYTHON;
    else process.env.SUPERVISOR_PYTHON = prevPy;
    cleanup();
  }
});

test('SUPERVISOR_PYTHON / SUPERVISOR_TOOLS_DIR env override the resolved python + script paths', () => {
  const { dir, cleanup } = tmpDir();
  const prevTools = process.env.SUPERVISOR_TOOLS_DIR;
  const prevPy = process.env.SUPERVISOR_PYTHON;
  try {
    process.env.SUPERVISOR_PYTHON = join('Z:', 'pin', 'python.exe');
    process.env.SUPERVISOR_TOOLS_DIR = join('Z:', 'pin', 'tools');
    const cfg = loadConfig({ stateDir: dir, channelDir: join(dir, 'no-channel') });
    assert.equal(cfg.python, join('Z:', 'pin', 'python.exe'));
    assert.equal(cfg.sttScript, join('Z:', 'pin', 'tools', 'transcribe_voice.py'));
    assert.equal(cfg.ttsScript, join('Z:', 'pin', 'tools', 'tts_voice.py'));
    // Explicit opts still win over env.
    const cfg2 = loadConfig({
      stateDir: dir,
      channelDir: join(dir, 'no-channel'),
      toolsDir: join('Y:', 'opt'),
      python: join('Y:', 'opt', 'py'),
    });
    assert.equal(cfg2.python, join('Y:', 'opt', 'py'));
    assert.equal(cfg2.sttScript, join('Y:', 'opt', 'transcribe_voice.py'));
  } finally {
    if (prevTools === undefined) delete process.env.SUPERVISOR_TOOLS_DIR;
    else process.env.SUPERVISOR_TOOLS_DIR = prevTools;
    if (prevPy === undefined) delete process.env.SUPERVISOR_PYTHON;
    else process.env.SUPERVISOR_PYTHON = prevPy;
    cleanup();
  }
});

test('REAL VoiceCodec (config defaults) isStt available + transcribes the sample .oga to real text', { timeout: 180_000 }, async (t) => {
  if (!existsSync(SAMPLE_OGA)) {
    t.skip(`sample .oga not present (${SAMPLE_OGA}) — real-STT test skipped on this box`);
    return;
  }
  const { dir, cleanup } = tmpDir();
  try {
    const codec = realCodecFromDefaults(dir);
    if (!codec) {
      t.skip('repo STT script or venv python not present — real-STT test skipped on this box');
      return;
    }
    assert.equal(codec.isSttAvailable(), true, 'isSttAvailable() must be true with the real repo script');
    const transcript = await codec.transcribe(SAMPLE_OGA);
    assertRealTranscript(transcript);
  } finally {
    cleanup();
  }
});

test('END-TO-END inbound: voice note → TelegramAdapter + REAL codec delivers the transcript, not "(voice message)"', { timeout: 180_000 }, async (t) => {
  if (!existsSync(SAMPLE_OGA)) {
    t.skip(`sample .oga not present (${SAMPLE_OGA}) — real-STT e2e skipped on this box`);
    return;
  }
  const { dir, cleanup } = tmpDir();
  try {
    const codec = realCodecFromDefaults(dir);
    if (!codec) {
      t.skip('repo STT script or venv python not present — real-STT e2e skipped on this box');
      return;
    }

    // Seed the loopback transport's "download" with a COPY of the real sample .oga,
    // so the adapter's inbound path downloads → REAL STT → substitutes.
    const fixtureDir = join(dir, 'fixture');
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = join(fixtureDir, 'sample.oga');
    copyFileSync(SAMPLE_OGA, fixture);

    const transport = new LoopbackTelegramTransport();
    transport.seedDownload('voice-file-real', fixture);
    const gate = new AccessGate({
      staticConfig: { dmPolicy: 'allowlist', allowFrom: ['999'], groups: {} },
    });
    const adapter = new TelegramAdapter({
      transport,
      gate,
      queueDir: join(dir, 'queue'),
      voice: codec, // ★ the REAL VoiceCodec (venv python + repo script)
      downloadDir: join(dir, 'downloads'),
    });

    const received: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      received.push(msg);
    });
    await transport.inject(rawVoice('voice-file-real', { fromUserId: '999' }));

    assert.equal(received.length, 1, 'one inbound delivered');
    // THE BUG FIX: the delivered text is the real transcript, not the placeholder.
    assertRealTranscript(received[0]!.text);
    assert.ok(received[0]!.voicePath, 'voicePath is preserved on the inbound');
    await adapter.stop();
  } finally {
    cleanup();
  }
});
