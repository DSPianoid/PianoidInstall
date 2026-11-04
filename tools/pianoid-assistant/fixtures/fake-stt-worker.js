// The fake speech-to-text worker of test/stt.test.js: speaks stt/worker.py's line protocol.
// FAKE_STT_MODE = ok (default) | crash (exits on the first clip) | hang (never answers) | missing (no faster-whisper)
import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.env.FAKE_STT_MODE || 'ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (mode === 'missing') {
  out({ ready: false, error: 'faster-whisper is not installed in this Python' });
  process.exit(0);
}
out({ ready: true, threads: 1, faster_whisper: 'fake' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (mode === 'crash') process.exit(3);
  if (mode === 'hang') return;
  if (req.warm) return out({ id: req.id, ok: true, load_s: 0, model: req.model, pid: process.pid });
  const bytes = fs.readFileSync(req.path);
  out({
    id: req.id, ok: true, text: `heard ${bytes.length} bytes`, language: req.language === 'auto' ? 'en' : req.language,
    duration_s: 1, elapsed_s: 0.01, load_s: 0, model: req.model, pid: process.pid,
  });
});
