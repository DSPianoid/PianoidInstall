// Voice input (dev-voice): the /stt routes and the worker lifecycle over the fake worker (zero cost), plus an
// opt-in end-to-end run of the real faster-whisper worker on the EN / RU fixtures (PIANOID_STT_E2E=1; ~30 s CPU).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantService } from '../service/server.js';
import { SttService, sttPython } from '../service/stt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'fixtures', 'fake-stt-worker.js');
const FIXTURES = path.join(HERE, '..', 'fixtures', 'stt');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-stt-test-'));
const fakeSpawn = (mode) => (cmd, args, opts) => spawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_STT_MODE: mode } });
const fakeEnv = (home) => ({ PIANOID_ASSISTANT_HOME: home, PIANOID_STT_PYTHON: process.execPath, PATH: process.env.PATH });

async function withService(sttOptions, fn) {
  const home = tmp();
  const svc = createAssistantService({ env: fakeEnv(home), port: 0, driver: 'fake', sttOptions });
  const port = await svc.listen();
  try {
    await fn(`http://127.0.0.1:${port}`, svc, home);
  } finally {
    await svc.close();
  }
}

const post = (base, query, body, headers = {}) => fetch(`${base}/stt${query}`, {
  method: 'POST', headers: { 'Content-Type': 'audio/wav', ...headers }, body,
});

test('stt route: a localhost page gets the text, the clip file is removed, the model stays loaded', async () => {
  await withService({ spawnImpl: fakeSpawn('ok') }, async (base, svc, home) => {
    const r = await post(base, '?language=ru&model=base', Buffer.alloc(1234), { Origin: 'http://localhost:3000' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const j = await r.json();
    assert.deepEqual([j.ok, j.text, j.language, j.model], [true, 'heard 1234 bytes', 'ru', 'base']);
    const again = await (await post(base, '', Buffer.alloc(10))).json();
    assert.equal(again.pid, j.pid, 'one persistent worker');
    assert.equal(again.model, 'medium', 'default model');
    assert.deepEqual(fs.readdirSync(path.join(home, 'stt')), [], 'clips are deleted after transcription');
    const warm = await (await fetch(`${base}/stt/warm?model=medium`, { method: 'POST', headers: { Origin: 'http://localhost:3000' } })).json();
    assert.deepEqual([warm.ok, warm.model, warm.pid], [true, 'medium', j.pid], 'warm loads ahead in the same worker');
    assert.equal((await fetch(`${base}/stt/warm`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    const s = await (await fetch(`${base}/stt/status`)).json();
    assert.equal(s.available, true);
    assert.equal(s.running, true);
    assert.deepEqual(s.models, ['base', 'small', 'medium']);
  });
});

test('stt route: refuses a foreign page, non-audio bodies, empty clips and bad options', async () => {
  await withService({ spawnImpl: fakeSpawn('ok') }, async (base) => {
    assert.equal((await post(base, '', Buffer.alloc(8), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(base, '', 'x', { 'Content-Type': 'text/plain' })).status, 405);
    assert.equal((await fetch(`${base}/stt`)).status, 405);
    assert.equal((await post(base, '', Buffer.alloc(0))).status, 400);
    const bad = await post(base, '?language=de', Buffer.alloc(8));
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /language must be one of auto, en, ru/);
    assert.match((await (await post(base, '?model=large', Buffer.alloc(8))).json()).error, /model must be one of/);
    const pre = await fetch(`${base}/stt`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3000' } });
    assert.equal(pre.status, 204);
  });
});

test('stt worker: a crash is reported and the next clip starts a fresh worker', async () => {
  const dir = tmp();
  let mode = 'crash';
  const stt = new SttService({ env: fakeEnv(dir), dir, spawnImpl: (c, a, o) => fakeSpawn(mode)(c, a, o) });
  const r = await stt.transcribe(Buffer.alloc(4));
  assert.equal(r.ok, false);
  assert.match(r.error, /worker exited \(code 3\)/);
  mode = 'ok';
  const r2 = await stt.transcribe(Buffer.alloc(4));
  assert.equal(r2.ok, true);
  stt.stop();
});

test('stt worker: a hung clip times out and kills the worker; missing faster-whisper / Python is reported', async () => {
  const dir = tmp();
  const hung = new SttService({ env: fakeEnv(dir), dir, spawnImpl: fakeSpawn('hang'), timeoutMs: 300 });
  assert.match((await hung.transcribe(Buffer.alloc(4))).error, /longer than 0 s/);
  assert.equal(hung.status().running, false);
  const missing = new SttService({ env: fakeEnv(dir), dir, spawnImpl: fakeSpawn('missing') });
  assert.match((await missing.transcribe(Buffer.alloc(4))).error, /faster-whisper is not installed/);
  missing.stop();
  const noPython = new SttService({ env: { PIANOID_STT_PYTHON: path.join(dir, 'nope.exe') }, dir });
  assert.match((await noPython.transcribe(Buffer.alloc(4))).error, /Python was not found/);
  assert.equal(noPython.status().available, false);
});

test('stt worker: the idle timer ends the worker', async () => {
  const dir = tmp();
  const stt = new SttService({ env: fakeEnv(dir), dir, spawnImpl: fakeSpawn('ok'), idleMs: 100 });
  assert.equal((await stt.transcribe(Buffer.alloc(4))).ok, true);
  assert.equal(stt.status().running, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(stt.status().running, false);
});

test('stt python: PIANOID_STT_PYTHON, else the PianoidCore venv', () => {
  assert.equal(sttPython({ PIANOID_STT_PYTHON: 'X:\\py.exe' }), 'X:\\py.exe');
  assert.match(sttPython({ PIANOID_CORE_DIR: 'X:\\Core' }), /Core[\\/]\.venv[\\/](Scripts[\\/]python\.exe|bin[\\/]python)$/);
});

// The real worker on the committed EN / RU fixtures (Windows SAPI voices, 16 kHz, 8-11 s each, Opus).
const e2e = process.env.PIANOID_STT_E2E === '1' && fs.existsSync(sttPython());
test('stt e2e: real faster-whisper (CPU, int8) transcribes the EN / RU fixtures', { skip: !e2e && 'set PIANOID_STT_E2E=1', timeout: 600000 }, async () => {
  const phrases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'phrases.json'), 'utf8'));
  const words = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean);
  const home = tmp();
  const svc = createAssistantService({ env: { ...process.env, PIANOID_ASSISTANT_HOME: home }, port: 0, driver: 'fake' });
  const base = `http://127.0.0.1:${await svc.listen()}`;
  try {
    for (const p of phrases) {
      const r = await (await fetch(`${base}/stt?language=auto`, {
        method: 'POST', headers: { 'Content-Type': 'audio/ogg', Origin: 'http://localhost:3000' },
        body: fs.readFileSync(path.join(FIXTURES, `${p.id}.ogg`)),
      })).json();
      const ref = new Set(words(p.text));
      const hit = [...new Set(words(r.text))].filter((w) => ref.has(w)).length / ref.size;
      console.log(`${p.id} ${r.language} ${r.elapsed_s}s (load ${r.load_s}s) hit=${hit.toFixed(2)} | ${r.text}`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.language, p.lang);
      assert.ok(hit >= 0.6, `${p.id}: ${r.text}`);
    }
  } finally {
    await svc.close();
  }
});
