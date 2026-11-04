/**
 * Voice input (dev-voice): the speech-to-text of the pane's mic button. The pane records in the browser and POSTs
 * the clip; this module transcribes it locally with faster-whisper on the CPU (stt/worker.py, a persistent
 * Python child of the service) and returns the text. The text goes back to the pane only: it becomes a turn
 * when the user sends it, exactly like typed text (the model has no tool for the mic or this module).
 *
 * Python: PIANOID_STT_PYTHON > <PIANOID_CORE_DIR | <Install>/PianoidCore>/.venv python (the canonical venv,
 * which carries faster-whisper). Model: the request's `model` (base | small | medium) else PIANOID_STT_MODEL
 * else small. The worker starts on the first request, keeps the model loaded, and ends after IDLE_MS without
 * a request (frees ~0.5-1.5 GB RAM). `warm` (the pane calls it when recording starts) loads the model while the
 * user speaks, so the first clip does not wait for the Python start + model load (~3-4 s for small).
 * One request at a time (a queue); one that takes longer than TIMEOUT_MS kills the worker (the next starts afresh).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER = path.resolve(HERE, '..', 'stt', 'worker.py');
export const MODELS = ['base', 'small', 'medium'];
export const LANGUAGES = ['auto', 'en', 'ru'];
export const MAX_BYTES = 8 * 1024 * 1024;        // ~4 min of 16 kHz PCM16 mono; the pane stops at 60 s
const IDLE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 120 * 1000;

export function sttPython(env = process.env) {
  if (env.PIANOID_STT_PYTHON) return env.PIANOID_STT_PYTHON;
  const core = env.PIANOID_CORE_DIR ? path.resolve(env.PIANOID_CORE_DIR) : path.resolve(HERE, '..', '..', '..', 'PianoidCore');
  return process.platform === 'win32' ? path.join(core, '.venv', 'Scripts', 'python.exe') : path.join(core, '.venv', 'bin', 'python');
}

/** The faster-whisper models already in the Hugging Face cache (a missing one downloads on first use). */
export function cachedModels(env = process.env) {
  const hub = env.HF_HUB_CACHE || path.join(env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub');
  return MODELS.filter((m) => fs.existsSync(path.join(hub, `models--Systran--faster-whisper-${m}`)));
}

export class SttService {
  constructor({ env = process.env, dir, spawnImpl = spawn, idleMs = IDLE_MS, timeoutMs = TIMEOUT_MS } = {}) {
    this.env = env;
    this.dir = dir;
    this.spawnImpl = spawnImpl;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.python = sttPython(env);
    this.defaultModel = MODELS.includes(env.PIANOID_STT_MODEL) ? env.PIANOID_STT_MODEL : 'small';
    this.child = null;
    this.ready = null;          // Promise of the worker's hello
    this.pending = new Map();   // id -> {resolve, timer}
    this.queue = Promise.resolve();
    this.nextId = 1;
    this.lastError = null;
    this.idleTimer = null;
  }

  status() {
    return {
      ok: true, available: fs.existsSync(this.python), python: this.python, running: !!this.child,
      defaultModel: this.defaultModel, models: MODELS, languages: LANGUAGES, cached: cachedModels(this.env),
      lastError: this.lastError,
    };
  }

  /** Transcribe one clip (a Buffer of any format ffmpeg / PyAV decodes; the pane sends 16 kHz WAV). */
  transcribe(audio, { language = 'auto', model } = {}) {
    if (!LANGUAGES.includes(language)) return Promise.resolve({ ok: false, error: `language must be one of ${LANGUAGES.join(', ')}` });
    const name = model || this.defaultModel;
    if (!MODELS.includes(name)) return Promise.resolve({ ok: false, error: `model must be one of ${MODELS.join(', ')}` });
    const run = this.queue.then(() => this.#run(audio, language, name));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Start the worker and load the model ahead of a clip; resolves {ok, load_s} (a no-op when already loaded). */
  warm(model) {
    const name = MODELS.includes(model) ? model : this.defaultModel;
    const run = this.queue.then(async () => {
      try {
        const hello = await this.#start();
        return hello.ready ? await this.#request({ warm: true, model: name }) : this.#fail(hello.error);
      } finally {
        this.#armIdle();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async #run(audio, language, model) {
    const file = path.join(this.dir, `clip-${crypto.randomBytes(6).toString('hex')}.wav`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, audio);
    try {
      const hello = await this.#start();
      if (!hello.ready) return this.#fail(hello.error);
      const reply = await this.#request({ path: file, language, model });
      if (!reply.ok) this.lastError = reply.error;
      return reply;
    } catch (e) {
      return this.#fail(e.message);
    } finally {
      fs.rmSync(file, { force: true });
      this.#armIdle();
    }
  }

  #fail(error) {
    this.lastError = error;
    return { ok: false, error };
  }

  #start() {
    if (this.ready) return this.ready;
    if (!fs.existsSync(this.python)) {
      return Promise.resolve({ ready: false, error: `The speech-to-text Python was not found: ${this.python} (set PIANOID_STT_PYTHON or create the PianoidCore venv)` });
    }
    const child = this.spawnImpl(this.python, ['-u', WORKER], {
      env: { ...this.env, PYTHONIOENCODING: 'utf-8', CUDA_VISIBLE_DEVICES: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child = child;
    child.stdin.on('error', () => {});         // EPIPE after a crash: reported by the exit handler
    let stderr = '';
    let buf = '';
    this.ready = new Promise((resolve) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch (e) { continue; }
          if ('ready' in msg) resolve(msg);
          else this.#settle(msg.id, msg);
        }
      });
      child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
      const gone = (why) => {
        const error = `The speech-to-text worker ${why}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`;
        resolve({ ready: false, error });      // no-op once it said hello
        if (this.child !== child) return;      // stopped on purpose (idle / timeout): stop() settled its requests
        this.child = null;
        this.ready = null;
        for (const id of [...this.pending.keys()]) this.#settle(id, { ok: false, error });
      };
      child.on('error', (e) => gone(`could not start (${e.message})`));
      child.on('exit', (code) => gone(`exited (code ${code})`));
    });
    return this.ready;
  }

  #request(req) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(id, { ok: false, error: `Transcription took longer than ${Math.round(this.timeoutMs / 1000)} s` });
        this.stop();
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
  }

  #settle(id, msg) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  #armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
    this.idleTimer.unref?.();
  }

  stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const id of [...this.pending.keys()]) this.#settle(id, { ok: false, error: 'The speech-to-text worker was stopped' });
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }
}
