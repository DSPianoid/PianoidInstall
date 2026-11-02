/**
 * save_file (dev-9cff): copies analysis artefact files (WAV / PNG / CSV / NPY / JSON / TXT) out of the private store
 * into a folder the user can open: <measurements folder>\assistant_exports. The measurements folder is owned by the
 * backend (GET /measurements/dir, PianoidCore measurements_location.py); this module never resolves it itself.
 * The model passes an artefact id, a listed file name and optionally a plain target name, never a path; an existing
 * file is never overwritten (name-1.ext, name-2.ext, ...).
 */
import fs from 'node:fs';
import path from 'node:path';
import { FILE_NAME, readArtifact } from './store.js';

export const EXPORT_SUBDIR = 'assistant_exports';

/** <measurements folder>\assistant_exports, from the backend; throws when the backend does not answer. */
export async function exportFolder(backendUrl, fetchImpl = fetch) {
  let state;
  try {
    state = await (await fetchImpl(`${backendUrl}/measurements/dir`)).json();
  } catch (e) {
    throw new Error(`the backend did not answer GET /measurements/dir (${e.message}): the export folder is inside `
      + 'the measurements folder, so the backend must be running');
  }
  if (!state?.measurements_dir) throw new Error('GET /measurements/dir returned no measurements_dir');
  return path.join(state.measurements_dir, EXPORT_SUBDIR);
}

/** `folder\name` if free, else the first free name-<n>.ext. */
function freePath(folder, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n += 1) {
    const p = path.join(folder, n ? `${stem}-${n}${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
}

/**
 * Copy the files of artefact `artifact_id` (all, or the one named `file`) into `folder`; `name` renames a single
 * file (plain file name; the source's extension is kept). Returns [{file, path, size}]. Validates everything
 * before writing anything.
 */
export function saveArtifactFiles(artifactsDir, folder, { artifact_id: id, file, name } = {}) {
  const meta = readArtifact(artifactsDir, id);
  if (!meta) throw new Error(`unknown artefact ${id}`);
  const picked = file ? meta.files.filter((f) => f.name === file) : meta.files;
  if (!picked.length) throw new Error(`artefact ${id} has no file ${file} (files: ${meta.files.map((f) => f.name).join(', ')})`);
  if (name !== undefined && name !== null) {
    if (picked.length !== 1) throw new Error('name renames one file: pass file too');
    if (!FILE_NAME.test(String(name))) throw new Error(`name ${JSON.stringify(name)} must be a plain file name (letters, digits, . _ -)`);
  }
  fs.mkdirSync(folder, { recursive: true });
  return picked.map((f) => {
    const ext = path.extname(f.name);
    const target = name ? `${path.basename(String(name), path.extname(String(name)))}${ext}` : f.name;
    const dest = freePath(folder, target);
    fs.copyFileSync(path.join(artifactsDir, meta.id, f.name), dest, fs.constants.COPYFILE_EXCL);
    return { file: f.name, path: dest, size: fs.statSync(dest).size };
  });
}
