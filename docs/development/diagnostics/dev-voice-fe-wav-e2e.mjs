// dev-voice: the pane's encoding path end to end without a browser. Each EN / RU fixture is decoded to 48 kHz float
// (what the browser's AudioContext captures), run through the Tunner's OWN wavEncoder (resample -> 16 kHz PCM16
// WAV), POSTed to a real assistant service (fake chat driver, ephemeral port) and transcribed by the real
// faster-whisper worker. Run from the assistant package dir:
//   PIANOID_STT_PYTHON=<venv python> node <this file> <PianoidTunner checkout> [model]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [tunner, model = 'small'] = process.argv.slice(2);
const pkg = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-voice-e2e-'));
fs.copyFileSync(path.join(tunner, 'src', 'utils', 'wavEncoder.js'), path.join(tmp, 'wavEncoder.mjs'));
const { encodeWav, resample } = await import(pathToFileURL(path.join(tmp, 'wavEncoder.mjs')));
const { createAssistantService } = await import(pathToFileURL(path.join(pkg, 'service', 'server.js')));

const fixtures = path.join(pkg, 'fixtures', 'stt');
const phrases = JSON.parse(fs.readFileSync(path.join(fixtures, 'phrases.json'), 'utf8'));
const svc = createAssistantService({ env: { ...process.env, PIANOID_ASSISTANT_HOME: tmp }, port: 0, driver: 'fake' });
const base = `http://127.0.0.1:${await svc.listen()}`;
try {
  for (const p of phrases) {
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path.join(fixtures, `${p.id}.ogg`), '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'],
      { maxBuffer: 64 << 20 });
    const captured = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    const wav = Buffer.from(encodeWav(resample(captured, 48000)));
    for (const language of ['auto', p.lang]) {
      const t0 = Date.now();
      const r = await (await fetch(`${base}/stt?language=${language}&model=${model}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', Origin: 'http://localhost:3000' }, body: wav,
      })).json();
      console.log(`${p.id} ${language.padEnd(4)} -> ${r.language} wav=${wav.length}B worker=${r.elapsed_s}s load=${r.load_s}s round-trip=${((Date.now() - t0) / 1000).toFixed(2)}s | ${r.ok ? r.text : r.error}`);
    }
  }
} finally {
  await svc.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
