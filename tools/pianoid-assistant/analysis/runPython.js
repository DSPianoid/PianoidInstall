/**
 * analysis.run_python (assistant v2 P5, proposal §4.3 design B): run the model's analysis code in the OS
 * sandbox. This handler runs inside the service process and NEVER evaluates the code: it writes it to a run
 * dir and spawns PianoidSandbox.exe (an AppContainer with zero capabilities inside a Job Object: no network,
 * no child processes, file access only to the run dir + the read-only runtime; sandbox/launcher).
 *
 * Inputs are artefact ids (analysis/store.js), copied into in\<id>\; the code gets ARTIFACTS (id -> meta),
 * artifact_path(id, name=None) and OUT ('out'). Files the code writes to out\ (.png .csv .json .npy .txt .wav)
 * become new artefacts. Returns {ok, exit, stdout (capped), stderr (capped), files: [{artifact_id, name, kind,
 * size}], skipped, limits_hit, elapsed_s, run_id}.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_ID, analysisPaths, createArtifact, kindOf, readArtifact } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAUNCHER = process.env.PIANOID_SANDBOX_LAUNCHER
  || path.resolve(HERE, '..', 'sandbox', 'launcher', 'PianoidSandbox.exe');
export const PROFILE = process.env.PIANOID_SANDBOX_PROFILE || 'pianoid.analysis';
export const LIMITS = {
  codeChars: 65536, inputs: 10, timeoutS: { min: 1, max: 120, default: 60 }, memoryMb: { min: 256, max: 2048, default: 2048 },
  diskMb: 200,
};
const KEEP_RUNS = 50;

/**
 * Prepended by the service (not the model). An audit hook refuses network / process calls as defence in
 * depth; the AppContainer + the Job Object are the boundary.
 */
export const PRELUDE = `# Pianoid analysis run: written by the assistant service; the model's code is user.py.
import json as _json, os as _os, sys as _sys
def _deny(event, args):
    if event in ('socket.connect', 'socket.bind', 'socket.sendto', 'socket.getaddrinfo', 'subprocess.Popen',
                 'os.system', 'os.spawn', 'os.exec', 'os.posix_spawn', 'os.startfile'):
        raise PermissionError('blocked by the Pianoid analysis sandbox: ' + event)
_sys.addaudithook(_deny)
ARTIFACTS = _json.load(open(_os.path.join('in', 'index.json'), encoding='utf-8'))
OUT = 'out'
def artifact_path(artifact_id, name=None):
    meta = ARTIFACTS[artifact_id]
    return _os.path.join('in', artifact_id, name or meta['files'][0]['name'])
_g = {'__name__': '__main__', 'ARTIFACTS': ARTIFACTS, 'OUT': OUT, 'artifact_path': artifact_path}
exec(compile(open('user.py', encoding='utf-8').read(), 'user.py', 'exec'), _g)
`;

const clampInt = (v, { min, max, default: d }) => {
  const n = v === undefined || v === null ? d : Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be an integer in [${min}, ${max}]`);
  return n;
};

/** Validate the tool input (pure). Returns {code, inputs, timeoutS, memoryMb} or throws with the reason. */
export function validateInput(input = {}) {
  const { code, inputs = [], timeout_s: timeout, memory_mb: memory } = input;
  if (typeof code !== 'string' || !code.trim()) throw new Error('code: a non-empty string is required');
  if (code.length > LIMITS.codeChars) throw new Error(`code: at most ${LIMITS.codeChars} characters`);
  if (!Array.isArray(inputs) || inputs.length > LIMITS.inputs) throw new Error(`inputs: at most ${LIMITS.inputs} artefact ids`);
  for (const id of inputs) if (!ARTIFACT_ID.test(String(id))) throw new Error(`inputs: not an artefact id: ${id}`);
  if (new Set(inputs).size !== inputs.length) throw new Error('inputs: duplicate artefact id');
  let timeoutS;
  let memoryMb;
  try { timeoutS = clampInt(timeout, LIMITS.timeoutS); } catch (e) { throw new Error(`timeout_s: ${e.message}`); }
  try { memoryMb = clampInt(memory, LIMITS.memoryMb); } catch (e) { throw new Error(`memory_mb: ${e.message}`); }
  return { code, inputs, timeoutS, memoryMb };
}

function newRunId() {
  return `r-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Create runs\<id>\ with code.py (prelude), user.py, in\<artefact>\ copies + in\index.json. */
export function prepareRun(paths, { code, inputs }) {
  const runId = newRunId();
  const dir = path.join(paths.runs, runId);
  const index = {};
  for (const id of inputs) {
    const meta = readArtifact(paths.artifacts, id);
    if (!meta) throw new Error(`inputs: unknown artefact ${id}`);
    fs.mkdirSync(path.join(dir, 'in', id), { recursive: true });
    for (const f of meta.files) fs.copyFileSync(path.join(paths.artifacts, id, f.name), path.join(dir, 'in', id, f.name));
    index[id] = meta;
  }
  fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'in', 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(dir, 'code.py'), PRELUDE);
  fs.writeFileSync(path.join(dir, 'user.py'), code);
  return { runId, dir };
}

/** The launcher argv of one run (no shell). */
export function launcherArgs(paths, dir, { timeoutS, memoryMb }) {
  return ['run', '--profile', PROFILE, '--python', path.join(paths.runtime, 'python.exe'), '--run-dir', dir,
    '--script', 'code.py', '--wall-s', String(timeoutS), '--cpu-s', String(Math.max(1, Math.floor(timeoutS / 2))),
    '--mem-mb', String(memoryMb), '--disk-mb', String(LIMITS.diskMb)];
}

const execLauncher = (file, args, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
    resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

/** Turn the launcher's out\ listing into artefacts (over-cap and unknown kinds are skipped). */
export function collectOutputs(paths, dir, runId, launcherFiles, inputs) {
  const files = [];
  const skipped = [];
  for (const f of launcherFiles || []) {
    const kind = kindOf(f.name);
    if (f.over_cap || !kind || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(f.name)) {
      skipped.push({ name: f.name, reason: f.over_cap ? 'over the output caps (20 files, 5 MB each, 20 MB total)' : 'not a png / csv / json / npy / txt / wav file' });
      continue;
    }
    const rec = createArtifact(paths.artifacts, {
      kind, source: 'analysis.run_python', meta: { run_id: runId, inputs },
      files: [{ name: f.name, data: fs.readFileSync(path.join(dir, 'out', f.name)) }],
    });
    files.push({ artifact_id: rec.id, name: f.name, kind, size: f.size });
  }
  return { files, skipped };
}

function pruneRuns(runsDir, keep = KEEP_RUNS) {
  const runs = fs.readdirSync(runsDir).filter((n) => /^r-\d{14}-[0-9a-f]{6}$/.test(n)).sort();
  for (const r of runs.slice(0, Math.max(0, runs.length - keep))) fs.rmSync(path.join(runsDir, r), { recursive: true, force: true });
}

/** The tool handler. `exec` is injectable for tests. */
export async function runPython(input, { paths = analysisPaths(), launcher = LAUNCHER, exec = execLauncher } = {}) {
  let v;
  try { v = validateInput(input); } catch (e) { return { ok: false, error: e.message }; }
  if (!fs.existsSync(launcher)) return { ok: false, error: `the sandbox launcher is not built: ${launcher} (run: node analysis/setup.js)` };
  if (!fs.existsSync(path.join(paths.runtime, 'python.exe'))) return { ok: false, error: `the analysis runtime is missing: ${paths.runtime} (see the README "Analysis sandbox")` };
  fs.mkdirSync(paths.runs, { recursive: true });
  let run;
  try { run = prepareRun(paths, v); } catch (e) { return { ok: false, error: e.message }; }
  const t0 = Date.now();
  const r = await exec(launcher, launcherArgs(paths, run.dir, v), (v.timeoutS + 30) * 1000);
  let j;
  try { j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch (e) {
    return { ok: false, run_id: run.runId, error: `sandbox launcher failed: ${(r.stderr || r.error?.message || r.stdout).slice(-600)}` };
  }
  if (!j.ok) return { ok: false, run_id: run.runId, error: j.error };
  const out = collectOutputs(paths, run.dir, run.runId, j.files, v.inputs);
  pruneRuns(paths.runs);
  return {
    ok: j.exit === 0 && !j.limits_hit.some((l) => ['wall', 'cpu', 'memory', 'disk'].includes(l)),
    exit: j.exit, exit_hex: j.exit_hex, run_id: run.runId,
    stdout: j.stdout, stderr: j.stderr, files: out.files, skipped: out.skipped,
    limits_hit: j.limits_hit, limits: j.limits, elapsed_s: Math.round((Date.now() - t0) / 100) / 10,
  };
}
