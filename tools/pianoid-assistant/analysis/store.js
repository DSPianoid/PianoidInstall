/**
 * The analysis artefact store (assistant v2 P5, proposal §4.3 "How code gets signals"). The model never
 * passes paths: it passes artefact ids, and only the service side creates artefacts — the Pianoid MCP server
 * (render / param exports, `export: true`) and the analysis tool (a run's output files).
 *
 * Layout under %USERPROFILE%\.pianoid-assistant\analysis (override the root with PIANOID_ASSISTANT_HOME,
 * or the artefact dir alone with PIANOID_ANALYSIS_ARTIFACTS — the session passes it to the MCP server):
 *   runtime\                   the private Python runtime the sandbox runs (read-only to a run; setup.js)
 *   runs\<run_id>\             one sandboxed run: code.py, user.py, in\, out\, tmp\ (pruned to KEEP_RUNS)
 *   artifacts\<id>\meta.json   {id, kind, source, created_at, tainted, files: [{name, kind, size}], ...source meta}
 *   artifacts\<id>\<files>     data: .wav / .npy / .json / .png / .csv / .txt / .md
 * `tainted` (dev-mem1): written at creation, true when the turn that produced it was tainted (web content, a
 * tainted note or artefact read). An artefact without the field counts as untainted only when it was created
 * before TAINT_TRACKED_SINCE (written before the field existed); otherwise it counts as tainted (fail closed).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ARTIFACT_ID = /^a-\d{14}-[0-9a-f]{6}$/;
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const KINDS = { '.png': 'png', '.csv': 'csv', '.json': 'json', '.npy': 'npy', '.npz': 'npz', '.wav': 'wav', '.txt': 'txt', '.md': 'md' };
export const CONTENT_TYPES = {
  png: 'image/png', csv: 'text/csv', json: 'application/json', npy: 'application/octet-stream', npz: 'application/octet-stream',
  wav: 'audio/wav', txt: 'text/plain', md: 'text/plain',
};
export const TAINT_TRACKED_SINCE = '2026-10-25T13:00:00.000Z';   // dev-mem1: artefacts from then on carry `tainted`
const KEEP_ARTIFACTS = 500;
export const KEEP_BYTES = 4 * 1024 ** 3;     // dev-8a9e: rig-file exports are large; the oldest go beyond 4 GB

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

/** `<prefix>-<local yyyymmddhhmmss>-<hex6>`: the id format of artefacts (a-) and runs (r-). */
export function newId(prefix, now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Create one artefact. files: [{name, data: Buffer | string} | {name, from: absolute path to copy}] (names must
 * match FILE_NAME and a known kind); meta: anything JSON. Returns the stored meta (with id).
 */
export function createArtifact(dir, { kind, source, meta = {}, files, tainted = false }) {
  if (!files?.length) throw new Error('an artefact needs at least one file');
  const id = newId('a');
  const out = path.join(dir, id);
  fs.mkdirSync(out, { recursive: true });
  const listed = files.map(({ name, data, from }) => {
    if (!FILE_NAME.test(name) || !kindOf(name)) throw new Error(`bad artefact file name: ${name}`);
    if (from) {
      fs.copyFileSync(from, path.join(out, name));
      return { name, kind: kindOf(name), size: fs.statSync(path.join(out, name)).size };
    }
    fs.writeFileSync(path.join(out, name), data);
    return { name, kind: kindOf(name), size: Buffer.byteLength(data) };
  });
  const record = { id, kind, source, created_at: new Date().toISOString(), ...meta, tainted: tainted === true, files: listed };
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

/** Did this artefact come from a tainted turn? A missing flag is untainted only before TAINT_TRACKED_SINCE. */
export function isTainted(meta) {
  if (typeof meta?.tainted === 'boolean') return meta.tainted;
  return !(typeof meta?.created_at === 'string' && meta.created_at < TAINT_TRACKED_SINCE);
}

const shortArgs = (args) => {
  const s = args && typeof args === 'object' ? JSON.stringify(args) : '';
  return s && s !== '{}' ? ` ${s.length > 80 ? `${s.slice(0, 80)}…` : s}` : '';
};

/** A one-line title of an artefact (derived from its meta, so artefacts written before dev-mem1 get one too). */
export function titleOf(meta) {
  if (meta.source === 'analysis.run_python') return `run_python ${meta.run_id || ''} output ${meta.files?.[0]?.name || ''}`.replace(/\s+/g, ' ').trim();
  if (meta.source === 'modal.rig_files') return `modal.rig_files ${meta.area || ''} ${meta.run || ''}`.replace(/\s+/g, ' ').trim();
  return `${meta.command || meta.source || meta.kind}${shortArgs(meta.args)}`;
}

const validMeta = (m, id) => m && typeof m === 'object' && m.id === id && Array.isArray(m.files) && typeof m.created_at === 'string';

/**
 * Newest-first listing (meta only; a missing / corrupt meta.json is skipped and counted). `kind` matches the
 * artefact kind or its source command; `since` = an ISO time; `query` = case-insensitive text over the title,
 * command / source, kind and file names. Returns {items: [meta + title], total, skipped}.
 */
export function listArtifacts(dir, { kind, since, query, limit = 20 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => ARTIFACT_ID.test(n)); } catch (e) { return { items: [], total: 0, skipped: 0 }; }
  const q = query ? String(query).toLowerCase() : null;
  let skipped = 0;
  const all = [];
  for (const id of names) {
    const meta = readArtifact(dir, id);
    if (!validMeta(meta, id)) { skipped += 1; continue; }
    const title = titleOf(meta);
    if (kind && meta.kind !== kind && meta.source !== kind && meta.command !== kind) continue;
    if (since && !(meta.created_at >= since)) continue;
    if (q && ![title, meta.command, meta.source, meta.kind, ...meta.files.map((f) => f.name)].some((t) => String(t || '').toLowerCase().includes(q))) continue;
    all.push({ ...meta, title });
  }
  all.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));
  return { items: all.slice(0, limit), total: all.length, skipped };
}

export function prune(dir, keep = KEEP_ARTIFACTS, keepBytes = KEEP_BYTES) {
  let ids = fs.readdirSync(dir).filter((n) => ARTIFACT_ID.test(n)).sort();
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) fs.rmSync(path.join(dir, id), { recursive: true, force: true });
  ids = ids.slice(Math.max(0, ids.length - keep));
  const size = (id) => (readArtifact(dir, id)?.files || []).reduce((n, f) => n + (f.size || 0), 0);
  let total = 0;
  for (let i = ids.length - 1; i >= 0; i -= 1) {           // newest first; never the newest one
    total += size(ids[i]);
    if (total > keepBytes && i < ids.length - 1) fs.rmSync(path.join(dir, ids[i]), { recursive: true, force: true });
  }
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
