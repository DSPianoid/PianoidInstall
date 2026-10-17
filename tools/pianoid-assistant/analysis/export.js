/**
 * `export: true` on the render / parameter-read tools (assistant v2 P5): the Pianoid MCP server turns the
 * result it already receives into an artefact (analysis/store.js) instead of dropping the samples, and tells
 * the model the artefact id. The id is what `analysis.run_python` takes as input.
 *
 *   render.*      audio_data (base64 WAV, as the backend wrote it) -> audio_<i>.wav;
 *                 data (numeric series, RAW engine units before output_scale and volume) -> series_<i>.npy
 *   param.get / preset.summary   the result -> result.json
 *
 * R6 is untouched: render tools are refused while live audio runs, so there is no render to export then.
 */
import { createArtifact, npyFloat64, wavInfo } from './store.js';

export const EXPORTABLE = new Set(['render.note_playback', 'render.chart', 'render.keyboard', 'param.get', 'preset.summary']);
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

/** The files + meta of one command result (pure). Null when there is nothing to export. */
export function artifactFromResult(cmd, args, result, context = {}) {
  if (!result || typeof result !== 'object' || result.jobId) return null;
  const base = { command: cmd.name, args, ...context };
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
