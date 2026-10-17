/**
 * The analysis artefact store (assistant v2 P5, proposal §4.3 "How code gets signals"). The model never
 * passes paths: it passes artefact ids, and only the service side creates artefacts — the Pianoid MCP server
 * (render / param exports, `export: true`) and the analysis tool (a run's output files).
 *
 * Layout under %USERPROFILE%\.pianoid-assistant\analysis (override the root with PIANOID_ASSISTANT_HOME,
 * or the artefact dir alone with PIANOID_ANALYSIS_ARTIFACTS — the session passes it to the MCP server):
 *   runtime\                   the private Python runtime the sandbox runs (read-only to a run; setup.js)
 *   runs\<run_id>\             one sandboxed run: code.py, user.py, in\, out\, tmp\ (pruned to KEEP_RUNS)
 *   artifacts\<id>\meta.json   {id, kind, source, created_at, files: [{name, kind, size}], ...source meta}
 *   artifacts\<id>\<files>     data: .wav / .npy / .json / .png / .csv / .txt
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ARTIFACT_ID = /^a-\d{14}-[0-9a-f]{6}$/;
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const KINDS = { '.png': 'png', '.csv': 'csv', '.json': 'json', '.npy': 'npy', '.wav': 'wav', '.txt': 'txt' };
export const CONTENT_TYPES = {
  png: 'image/png', csv: 'text/csv', json: 'application/json', npy: 'application/octet-stream', wav: 'audio/wav', txt: 'text/plain',
};
const KEEP_ARTIFACTS = 500;

export function analysisPaths(env = process.env) {
  const home = env.PIANOID_ASSISTANT_HOME || path.join(env.USERPROFILE || os.homedir(), '.pianoid-assistant');
  const root = path.join(home, 'analysis');
  return {
    root,
    runtime: path.join(root, 'runtime'),
    runs: path.join(root, 'runs'),
    artifacts: env.PIANOID_ANALYSIS_ARTIFACTS || path.join(root, 'artifacts'),
  };
}

export const kindOf = (name) => KINDS[path.extname(name).toLowerCase()] || null;

function newId(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `a-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Create one artefact. files: [{name, data: Buffer | string}] (names must match FILE_NAME and a known
 * kind); meta: anything JSON. Returns the stored meta (with id).
 */
export function createArtifact(dir, { kind, source, meta = {}, files }) {
  if (!files?.length) throw new Error('an artefact needs at least one file');
  const id = newId();
  const out = path.join(dir, id);
  fs.mkdirSync(out, { recursive: true });
  const listed = files.map(({ name, data }) => {
    if (!FILE_NAME.test(name) || !kindOf(name)) throw new Error(`bad artefact file name: ${name}`);
    fs.writeFileSync(path.join(out, name), data);
    return { name, kind: kindOf(name), size: Buffer.byteLength(data) };
  });
  const record = { id, kind, source, created_at: new Date().toISOString(), ...meta, files: listed };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(record, null, 1));
  prune(dir);
  return record;
}

/** The meta of an artefact, or null (unknown / malformed id). */
export function readArtifact(dir, id) {
  if (!ARTIFACT_ID.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** Absolute path of one artefact file, or null when the id / name is not a listed file of it. */
export function artifactFile(dir, id, name) {
  const meta = readArtifact(dir, id);
  if (!meta || !meta.files.some((f) => f.name === name)) return null;
  return path.join(dir, id, name);
}

function prune(dir, keep = KEEP_ARTIFACTS) {
  const ids = fs.readdirSync(dir).filter((n) => ARTIFACT_ID.test(n)).sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) fs.rmSync(path.join(dir, id), { recursive: true, force: true });
}

// ---- encoders --------------------------------------------------------------------------------

/** A float64 vector as a NumPy .npy (format 1.0, little-endian '<f8', C order). */
export function npyFloat64(values) {
  const header = `{'descr': '<f8', 'fortran_order': False, 'shape': (${values.length},), }`;
  const pad = (64 - ((10 + header.length + 1) % 64)) % 64;   // magic + version + length + header aligned to 64
  const h = Buffer.from(`${header}${' '.repeat(pad)}\n`, 'latin1');
  const pre = Buffer.alloc(10);
  pre.write('\x93NUMPY', 0, 'latin1');
  pre[6] = 1; pre[7] = 0;
  pre.writeUInt16LE(h.length, 8);
  const body = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => body.writeDoubleLE(Number(v), i * 8));
  return Buffer.concat([pre, h, body]);
}

/** {sample_rate, channels, bits} of a RIFF/WAVE buffer (the fmt chunk), or null. */
export function wavInfo(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 24 <= buf.length) {
      return { channels: buf.readUInt16LE(p + 10), sample_rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    }
    p += 8 + size + (size % 2);
  }
  return null;
}
