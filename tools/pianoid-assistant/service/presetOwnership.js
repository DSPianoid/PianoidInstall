/**
 * Which preset files are the assistant's OWN working copies (dev-auto1, provenance rule; replaces the earlier
 * `presets/<name>_work.json` name rule, which let a user file with that name be overwritten and let the model
 * "claim" any file by naming it so).
 *
 * A path is OWN only when BOTH hold:
 *   (a) the assistant itself CREATED the file: it did not exist when the assistant's first save of it was checked,
 *       and that save succeeded (then the file is recorded in the manifest), and
 *   (b) the file on disk still hashes (sha256) to what the assistant last wrote (nobody changed it since).
 * A save to a path that does not exist yet (inside presets/) is a CREATION: it may run, and is recorded after it
 * succeeds. Everything else (a pre-existing file, a file changed since, a file not in the manifest, a path outside
 * <pianoid_middleware>/presets after resolving `..`, symlinks and junctions) is NOT own. A save the user approved
 * over a not-own file does NOT adopt it (its stale entry, if any, is dropped): it stays the user's.
 *
 *   <root>\owned-presets.json   {version: 1, entries: {<key>: {path, sha256, created_at, updated_at, session}}}
 *                               key = the resolved real path (lower-cased on Windows). Written only here,
 *                               atomically (temp file + rename). Missing or corrupt = owning nothing (fail
 *                               closed), recorded in the audit log; a corrupt file is kept aside on the next write.
 *
 *   classify(presetPath) -> {status: 'new' | 'owned' | 'not_owned' | 'modified' | 'outside' | 'error', own, target, key, reason}
 *                           own = the assistant may save it as its own (a creation, or a file it owns)
 *   unchanged(pre)       -> null | why the file changed between the check and the save (the executor refuses then)
 *   recordAfterSave(pre, savedPath) -> after a successful save: record / refresh a creation or an owned file; never
 *                           adopt. `savedPath` = the absolute path the backend reports it wrote: when it is not the
 *                           checked file (the service resolved another pianoid_middleware than the backend's),
 *                           nothing is recorded and every later check fails closed (`mismatch`).
 * The save path is the backend's: relative to pianoid_middleware, `.json` appended when missing (REST_API.md
 * POST /save_preset).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'owned-presets.json';
const WIN = process.platform === 'win32';
const keyOf = (p) => (WIN ? p.toLowerCase() : p);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });

/** The real path of `p`: the deepest existing ancestor through realpath (symlinks / junctions, true case), + the rest. */
export function realResolve(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!lstat(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync.native(head), ...tail);       // a dangling link throws: the caller says not own
}

const within = (dir, p) => {
  const rel = path.relative(keyOf(dir), keyOf(p));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export class PresetOwnership {
  /** `file` null = no assistant home: nothing is ever own. `audit` = an AuditLog (write(event, fields)). */
  constructor({ file, middleware, audit = null, now = () => new Date(), session = null }) {
    Object.assign(this, { file, middleware, audit, now });
    this.session = session || `${now().toISOString()}-pid${process.pid}`;
    this.lastProblem = null;
    this.mismatch = null;
  }

  log(fields) { this.audit?.write('ownership', fields); }

  /** A manifest problem is audited once until it changes (each check re-reads the file). */
  problem(reason) {
    if (reason !== this.lastProblem) this.log({ action: 'manifest_problem', reason, manifest: this.file });
    this.lastProblem = reason;
  }

  /** -> {ok: true, entries} | {ok: false, missing?, corrupt?, reason}. */
  read() {
    if (!this.file) return { ok: false, reason: 'no assistant home (no ownership manifest)' };
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      return e.code === 'ENOENT' ? { ok: false, missing: true, reason: 'the ownership manifest is missing' }
        : { ok: false, reason: `the ownership manifest is unreadable: ${e.message}` };
    }
    try {
      const m = JSON.parse(raw);
      const entries = m?.entries;
      const valid = m?.version === 1 && entries && typeof entries === 'object' && !Array.isArray(entries)
        && Object.values(entries).every((e) => typeof e?.path === 'string' && /^[0-9a-f]{64}$/.test(e?.sha256 || ''));
      if (valid) {
        this.lastProblem = null;
        return { ok: true, entries };
      }
    } catch { /* corrupt below */ }
    return { ok: false, corrupt: true, reason: 'the ownership manifest is corrupt' };
  }

  classify(presetPath) {
    const no = (status, reason, extra = {}) => ({ status, own: false, reason, ...extra });
    if (this.mismatch) return no('error', this.mismatch);
    if (typeof presetPath !== 'string' || !presetPath.trim()) return no('error', 'no preset path');
    let presets;
    let target;
    if (!this.middleware) return no('error', 'no pianoid_middleware folder');
    try {
      presets = realResolve(path.join(this.middleware, 'presets'));
      if (!lstat(presets)?.isDirectory()) return no('error', `the preset folder was not found (${presets})`);
      const rel = presetPath.trim().replace(/\\/g, '/');
      target = realResolve(path.resolve(this.middleware, /\.json$/i.test(rel) ? rel : `${rel}.json`));
    } catch (e) {
      return no('error', `the path could not be resolved (${e.message})`);
    }
    const key = keyOf(target);
    if (!within(presets, target)) return no('outside', `${target} is outside the presets folder`, { target, key });
    const st = lstat(target);
    if (!st) return { status: 'new', own: true, target, key, reason: 'a new file the assistant creates (recorded as its own after the save)' };
    if (!st.isFile()) return no('error', `${target} is not a regular file`, { target, key });
    const m = this.read();
    if (!m.ok) this.problem(m.reason);
    if (!m.ok && !m.missing) return no('error', `${m.reason}: the assistant owns nothing (fail closed)`, { target, key });
    const e = m.ok ? m.entries[key] : null;           // no manifest yet = owning nothing
    if (!e) return no('not_owned', 'an existing file the assistant did not create', { target, key });
    let hash;
    try { hash = sha256(target); } catch (err) { return no('error', `the file could not be read (${err.message})`, { target, key }); }
    if (hash !== e.sha256) return no('modified', 'a file the assistant created, but changed since it last wrote it', { target, key });
    return { status: 'owned', own: true, target, key, reason: 'the assistant\'s own working copy (created by it, unchanged since)' };
  }

  /** Between the check and the save: a creation must still be new, an owned file still unchanged. */
  unchanged(pre) {
    if (!pre?.own) return null;
    const now = this.classify(pre.target);
    return now.status === pre.status && now.key === pre.key ? null : `${pre.target} changed after the check (${now.reason}); not saved`;
  }

  recordAfterSave(pre, savedPath) {
    if (!pre?.key || !this.file) return;
    let saved = null;
    try { saved = typeof savedPath === 'string' && savedPath ? keyOf(realResolve(savedPath)) : null; } catch { /* below */ }
    if (saved !== pre.key) {
      this.mismatch = `the backend saved ${savedPath ?? '(no path reported)'}, not the checked ${pre.target}: ownership is off until the service restarts`;
      this.log({ action: 'path_mismatch', reason: this.mismatch });
      return;
    }
    const m = this.read();
    const entries = m.ok ? { ...m.entries } : {};
    if (!pre.own) {                                   // an approved save over a not-own file: it stays the user's
      if (m.ok && entries[pre.key]) {
        delete entries[pre.key];
        this.write(entries);
      }
      this.log({ action: 'not_adopted', path: pre.target, reason: pre.reason });
      return;
    }
    let hash;
    try { hash = sha256(pre.target); } catch (e) {
      this.log({ action: 'record_failed', path: pre.target, reason: e.message });
      return;
    }
    if (m.corrupt) this.keepAside();
    const t = this.now().toISOString();
    const created = pre.status === 'owned' ? entries[pre.key]?.created_at || t : t;
    entries[pre.key] = { path: pre.target, sha256: hash, created_at: created, updated_at: t, session: this.session };
    if (this.write(entries)) this.log({ action: pre.status === 'new' ? 'created' : 'updated', path: pre.target, sha256: hash });
  }

  keepAside() {
    const aside = `${this.file}.corrupt-${this.now().toISOString().replace(/[-:.]/g, '')}`;
    try { fs.renameSync(this.file, aside); this.log({ action: 'manifest_kept_aside', file: aside }); } catch (e) {
      this.log({ action: 'manifest_kept_aside_failed', reason: e.message });
    }
  }

  /** Atomic: a temp file in the same folder, then rename over the manifest. */
  write(entries) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      this.log({ action: 'manifest_write_failed', reason: e.message });
      return false;
    }
  }
}
