/**
 * The VOICE CODEC — STT (voice→text) and TTS (text→voice note), behind the
 * adapter contract.
 *
 * Re-homes the two Python helpers as out-of-process steps on the bus (spec PART
 * B.4 "call as helper processes or port them"):
 *   - STT: `tools/transcribe_voice.py <ogg>` (faster-whisper small, CUDA-or-CPU)
 *     prints the transcript to stdout.
 *   - TTS: `tools/tts_voice.py [--voice V] [--out P] <text>` (edge-tts→ffmpeg→OGG)
 *     prints the produced .ogg ABSOLUTE path as the LAST stdout line.
 *
 * Keeping these as helper processes preserves the *validated* pipelines (the
 * faster-whisper transcribe + edge-tts/ffmpeg render) instead of re-porting ML
 * code — the boundary the proposal recommends (PART C.1 trade-offs: leaf
 * utilities stay Python; only the supervisor shell is TS).
 *
 * Concern (P2): voice↔text conversion ONLY. It owns no transport, no queue.
 * Authority (P1): it writes only into its configured `tmpDir` (TTS output).
 *
 * Both operations are OPTIONAL capabilities — `isSttAvailable()` /
 * `isTtsAvailable()` report whether the helper script + interpreter are present
 * so the adapter can degrade gracefully (deliver "(voice message)" text when
 * STT is unavailable; fall back to a text reply when TTS is unavailable).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VoiceCodecOptions {
  /** Path to the python interpreter to run the helpers (e.g. 'python', 'py'). */
  python: string;
  /** Absolute path to transcribe_voice.py. */
  sttScript: string;
  /** Absolute path to tts_voice.py. */
  ttsScript: string;
  /** Directory for TTS output OGGs. Defaults to the OS temp dir. */
  tmpDir?: string;
  /** edge-tts voice name for TTS. Defaults to the script's own default. */
  ttsVoice?: string;
  /** Per-call timeout in ms (STT can be slow on CPU). Default 120000. */
  timeoutMs?: number;
}

/** Result of a child-process run. */
interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The voice capability the adapter depends on (P2 boundary): voice↔text only.
 * `VoiceCodec` is the production implementation (shells to the Python helpers);
 * tests inject a deterministic fake without spawning Python.
 */
export interface VoiceProvider {
  isSttAvailable(): boolean;
  isTtsAvailable(): boolean;
  transcribe(oggPath: string): Promise<string>;
  synthesize(text: string, outPath?: string): Promise<string>;
}

export class VoiceCodec implements VoiceProvider {
  private readonly opts: Required<Omit<VoiceCodecOptions, 'ttsVoice'>> &
    Pick<VoiceCodecOptions, 'ttsVoice'>;

  constructor(opts: VoiceCodecOptions) {
    this.opts = {
      python: opts.python,
      sttScript: opts.sttScript,
      ttsScript: opts.ttsScript,
      tmpDir: opts.tmpDir ?? tmpdir(),
      timeoutMs: opts.timeoutMs ?? 120_000,
      ttsVoice: opts.ttsVoice,
    };
    mkdirSync(this.opts.tmpDir, { recursive: true });
  }

  /** True if the STT helper script exists (the interpreter is assumed present). */
  isSttAvailable(): boolean {
    return existsSync(this.opts.sttScript);
  }

  /** True if the TTS helper script exists. */
  isTtsAvailable(): boolean {
    return existsSync(this.opts.ttsScript);
  }

  /**
   * Transcribe an OGG/OPUS voice note to text. Returns the transcript (trimmed).
   * Throws on a non-zero exit or timeout — the caller decides the fallback.
   */
  async transcribe(oggPath: string): Promise<string> {
    if (!existsSync(oggPath)) {
      throw new Error(`voice file not found: ${oggPath}`);
    }
    const res = await this.run(this.opts.python, [this.opts.sttScript, oggPath]);
    if (res.timedOut) throw new Error(`STT timed out after ${this.opts.timeoutMs}ms`);
    if (res.code !== 0) {
      throw new Error(`STT failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
    // The helper prints the transcript on stdout (diagnostics go to stderr).
    return res.stdout.trim();
  }

  /**
   * Render text to an OGG/Opus voice note. Returns the absolute path of the
   * produced .ogg. The helper prints that path as the LAST stdout line, so we
   * take the last non-empty line.
   */
  async synthesize(text: string, outPath?: string): Promise<string> {
    const out =
      outPath ?? join(this.opts.tmpDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ogg`);
    const args = [this.opts.ttsScript];
    if (this.opts.ttsVoice) args.push('--voice', this.opts.ttsVoice);
    args.push('--out', out, text);
    const res = await this.run(this.opts.python, args);
    if (res.timedOut) throw new Error(`TTS timed out after ${this.opts.timeoutMs}ms`);
    if (res.code !== 0) {
      throw new Error(`TTS failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
    const lines = res.stdout.trim().split('\n').filter((l) => l.trim() !== '');
    const produced = lines.length > 0 ? lines[lines.length - 1]!.trim() : out;
    if (!existsSync(produced)) {
      throw new Error(`TTS reported ${produced} but the file is missing`);
    }
    return produced;
  }

  /** Run a child process to completion, capturing stdout/stderr with a timeout. */
  private run(cmd: string, args: string[]): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const child = spawn(cmd, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.opts.timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }
}
