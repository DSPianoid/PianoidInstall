/**
 * `export: true` on the render / parameter-read tools (assistant v2 P5): the Pianoid MCP server turns the
 * result it already receives into an artefact (analysis/store.js) instead of dropping the samples, and tells
 * the model the artefact id. The id is what `analysis.run_python` takes as input.
 *
 *   render.*      audio_data (base64 WAV, as the backend wrote it) -> audio_<i>.wav;
 *                 data (numeric series, RAW engine units before output_scale and volume) -> series_<i>.npy
 *   param.get / preset.summary   the result -> result.json
 *   modal.rig_files (dev-8a9e)   the rig run files the backend resolved (GET /rig/files: absolute paths inside the
 *                 measurement dir) are COPIED into one artefact, names flattened (sessions/E1_m42_r1/data.npy ->
 *                 sessions__E1_m42_r1__data.npy); at most RIG_EXPORT_MAX_BYTES. The model still passes no path.
 *
 * R6 is untouched: render tools are refused while live audio runs, so there is no render to export then.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createArtifact, FILE_NAME, kindOf, npyFloat64, wavInfo } from './store.js';

export const EXPORTABLE = new Set(['render.note_playback', 'render.chart', 'render.keyboard', 'param.get', 'preset.summary',
  'modal.rig_files']);
export const RIG_EXPORT_MAX_BYTES = 400 * 1024 * 1024;
export const SERIES_UNITS = 'raw engine units (before output_scale and volume)';

export const EXPORT_ARG = {
  type: 'boolean',
  default: false,
  description: 'Also save the full result (WAV, every sample, the full data) as an analysis artefact and return its '
    + 'artefact id, for analysis.run_python. Default false.',
};

/** The MCP input schema of an exportable command: the registry args + `export`. */
export function withExportArg(cmd, schema) {
  if (!EXPORTABLE.has(cmd.name)) return schema;
  return { ...schema, properties: { ...(schema?.properties || {}), export: EXPORT_ARG } };
}

/** Split the MCP arguments into the command's own args and the export flag. */
export function splitExport(cmd, args = {}) {
  const { export: exp, ...rest } = args;
  return { args: EXPORTABLE.has(cmd.name) ? rest : args, exportRequested: EXPORTABLE.has(cmd.name) && exp === true };
}

const isSeries = (s) => Array.isArray(s) && s.length > 0 && s.every((v) => typeof v === 'number');

/** A run-relative name as one artefact file name (sessions/E1_m42_r1/data.npy -> sessions__E1_m42_r1__data.npy). */
export const flatName = (name) => String(name).replace(/[\\/]+/g, '__');

/** modal.rig_files: copy the files the backend resolved into one artefact (throws on a bad / oversize listing). */
function rigFilesArtifact(base, result) {
  const listed = Array.isArray(result.files) ? result.files : [];
  if (!listed.length) return null;
  let total = 0;
  const files = listed.map((f) => {
    const name = flatName(f.name);
    if (!FILE_NAME.test(name) || !kindOf(name)) throw new Error(`cannot export ${f.name}: not a .npy / .npz / .json / .wav / .csv / .txt / .png file`);
    if (!path.isAbsolute(String(f.path)) || !fs.statSync(f.path).isFile()) throw new Error(`cannot export ${f.name}: no file`);
    total += fs.statSync(f.path).size;
    return { name, from: f.path };
  });
  if (total > RIG_EXPORT_MAX_BYTES) throw new Error(`the files are ${Math.round(total / 1e6)} MB; at most ${RIG_EXPORT_MAX_BYTES / 1048576} MB per export`);
  return {
    kind: 'rig', source: 'modal.rig_files',
    meta: { ...base, run: result.run, area: result.area, original_names: Object.fromEntries(files.map((f, i) => [f.name, listed[i].name])) },
    files,
  };
}

/** The files + meta of one command result (pure, except modal.rig_files which copies files). Null when there is nothing to export. */
export function artifactFromResult(cmd, args, result, context = {}) {
  if (!result || typeof result !== 'object' || result.jobId) return null;
  const base = { command: cmd.name, args, ...context };
  if (cmd.name === 'modal.rig_files') return rigFilesArtifact(base, result);
  if (cmd.family !== 'render') {
    return { kind: 'json', source: cmd.name, meta: base, files: [{ name: 'result.json', data: JSON.stringify(result) }] };
  }
  const files = [];
  const audio = [].concat(result.audio_data || []).filter((a) => typeof a === 'string' && a.length);
  const wavs = audio.map((b64, i) => {
    const data = Buffer.from(b64, 'base64');
    files.push({ name: `audio_${i}.wav`, data });
    return { file: `audio_${i}.wav`, ...wavInfo(data) };
  });
  const headers = result.chart_headers || [];
  const series = [];
  (Array.isArray(result.data) ? result.data : []).forEach((s, i) => {
    if (!isSeries(s)) return;
    files.push({ name: `series_${i}.npy`, data: npyFloat64(s) });
    series.push({ file: `series_${i}.npy`, name: headers[i] ?? `series ${i}`, samples: s.length });
  });
  if (!files.length) return null;
  return {
    kind: 'render',
    source: cmd.name,
    meta: {
      ...base,
      general_header: result.general_header ?? null,
      text_fields: result.text_fields ?? null,
      audio: wavs,
      series,
      series_units: SERIES_UNITS,
      sample_rate: wavs[0]?.sample_rate ?? null,
    },
    files,
  };
}

/** Export one successful command envelope; returns {id, kind, files} for the model, or null. */
export function exportResult(dir, cmd, args, res, context = {}) {
  if (!res?.ok) return null;
  const spec = artifactFromResult(cmd, args, res.result, context);
  if (!spec) return null;
  const rec = createArtifact(dir, spec);
  return { id: rec.id, kind: rec.kind, files: rec.files, sample_rate: rec.sample_rate ?? undefined };
}
