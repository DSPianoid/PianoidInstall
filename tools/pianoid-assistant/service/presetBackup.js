/**
 * The automatic preset backup before an Autonomous-mode preset.save (dev-auto1).
 *
 * preset.save {path} writes the active entry to `path` relative to pianoid_middleware (`.json` appended when
 * missing; REST_API.md POST /save_preset). Before the service permits an AUTONOMOUS save it copies the file that
 * would be overwritten to <assistant root>\preset-backups\<UTC stamp>__<path with / -> _>; a path that does not
 * exist yet is a new file (nothing to back up). Fail closed: no preset folder, a path outside pianoid_middleware,
 * or a failed copy -> {ok: false}, and the save asks the user instead. The newest KEEP backups are kept.
 * pianoid_middleware = PIANOID_CORE_DIR (the launcher's env, inherited by the assistant) else <Install>/PianoidCore.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = 200;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function middlewareDir(env = process.env) {
  const core = env.PIANOID_CORE_DIR ? path.resolve(env.PIANOID_CORE_DIR) : path.resolve(HERE, '..', '..', '..', 'PianoidCore');
  return path.join(core, 'pianoid_middleware');
}

const stamp = (d) => d.toISOString().replace(/[-:.]/g, '');           // 20261025T053000123Z (ms: no clash)

/** -> {ok, backup: file | null, target, reason}. */
export function backupPreset({ presetPath, middleware, backupDir, now = new Date(), keep = KEEP }) {
  if (!backupDir) return { ok: false, reason: 'no backup folder (the assistant home is not set)' };
  if (typeof presetPath !== 'string' || !presetPath.trim()) return { ok: false, reason: 'no preset path' };
  if (!middleware || !fs.existsSync(middleware)) return { ok: false, reason: `the preset folder was not found (${middleware})` };
  const rel = presetPath.trim().replace(/\\/g, '/');
  const target = path.resolve(middleware, /\.json$/i.test(rel) ? rel : `${rel}.json`);
  const inside = path.relative(middleware, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, reason: `${presetPath} is outside pianoid_middleware` };
  if (!fs.existsSync(target)) return { ok: true, backup: null, target, reason: 'a new file: nothing to back up' };
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${stamp(now)}__${inside.replace(/[\\/]/g, '_')}`);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    prune(backupDir, keep);
    return { ok: true, backup, target, reason: `backed up to ${backup}` };
  } catch (e) {
    return { ok: false, reason: `the backup failed: ${e.message}` };
  }
}

function prune(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();     // the stamp sorts by time
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
}
