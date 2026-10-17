/**
 * The Pianoid MCP tool surface (assistant phase A4): generated from the command registry, never a
 * hand list. Pure builders + the HTTP call of one tool.
 */
import { listedFor } from '../policy.js';
import { toolName } from '../lib/registry.js';

export const BACKEND_URL = process.env.PIANOID_BACKEND_URL || 'http://127.0.0.1:5000';
export const LAUNCHER_URL = process.env.PIANOID_LAUNCHER_URL || 'http://127.0.0.1:3001';

export const SEARCH_DOCS = {
  name: 'search_docs',
  title: 'Search the Pianoid documentation',
  description: 'Keyword search over the Pianoid MkDocs documentation (architecture, modules, guides, REST API, data-model facts). Returns section titles, snippets and http://localhost:8001 links to cite. [tier: read]',
  inputSchema: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "feedin key space pitch"' },
      limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    },
  },
  annotations: { title: 'Search the Pianoid documentation', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

/** MCP tool definition of one registry command. */
export function toolFor(cmd) {
  const ro = cmd.tier === 'read' || cmd.tier === 'ui';
  return {
    name: toolName(cmd.name),
    title: cmd.title,
    description: `${cmd.title}. ${cmd.description} [command: ${cmd.name}; tier: ${cmd.tier}`
      + `${cmd.long_running ? '; long-running: returns jobId, follow with job.get' : ''}]`,
    inputSchema: cmd.args,
    annotations: {
      title: cmd.title,
      readOnlyHint: ro,
      destructiveHint: cmd.tier === 'destructive',
      idempotentHint: cmd.tier === 'read',
      openWorldHint: false,
    },
  };
}

/** Every registry command that may ever run (+ search_docs), sorted. */
export function listTools(commands, settings = {}) {
  return [...commands.filter((c) => listedFor(c, settings)).map(toolFor), SEARCH_DOCS]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Where a command executes: the :5000 executor (backend + modal) or the launcher (launcher + ui). */
export function endpointFor(cmd, { backend = BACKEND_URL, launcher = LAUNCHER_URL } = {}) {
  const base = cmd.target === 'launcher' || cmd.target === 'ui' ? `${launcher}/api/command/` : `${backend}/command/`;
  return base + cmd.name;
}

/**
 * Run one command over HTTP; returns the executor envelope {ok, status, result | error}.
 * `execUrl` = the assistant service's executor (`<execUrl>/<name>`, v2 P2) instead of the backend;
 * `group` = an X-Pianoid-Group (one undo group, REST_API "Undo / redo (SSOT I3)").
 */
export async function callCommand(cmd, args, { source = 'assistant', fetchImpl = fetch, execUrl = null, group = null, urls } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Pianoid-Source': source };
  if (group) headers['X-Pianoid-Group'] = group;
  let res;
  try {
    res = await fetchImpl(execUrl ? `${execUrl}/${cmd.name}` : endpointFor(cmd, urls), { method: 'POST', headers, body: JSON.stringify(args || {}) });
  } catch (e) {
    const where = execUrl ? 'the assistant service' : cmd.target === 'launcher' || cmd.target === 'ui' ? 'the launcher (:3001)' : 'the backend (:5000)';
    return { ok: false, status: 0, error: 'unreachable', message: `${where} is not reachable: ${e.message}` };
  }
  let body;
  try { body = await res.json(); } catch (e) { body = { ok: res.ok, status: res.status, result: null }; }
  return body;
}

/**
 * Peak / RMS of one rendered series (the model cannot listen to samples; it needs the level).
 * The samples are RAW engine units, before the preset's output_scale and the volume (measured
 * dev-0a88: p60 v100 raw peak 1.2e-4 on BaselinePreset1, output_scale 6.1e12; 1.6e-8 on
 * F15_measured_plywood, output_scale 3.6e15), so only renders of the same preset compare.
 */
export function seriesStats(series) {
  let peak = 0;
  let sum = 0;
  for (const v of series) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = series.length ? Math.sqrt(sum / series.length) : 0;
  return { samples: series.length, peak_abs: peak, rms, all_zero: peak === 0, units: 'raw (before output_scale and volume)' };
}

/**
 * Render results carry base64 audio and every sample (a 1 s note = 48k numbers): replace them with
 * per-series stats, so the model reads the level instead of guessing from the first samples
 * (dev-0a88: a silent render, Max 0.000000, was read as "real signal").
 */
export function shapeResult(cmd, res) {
  if (cmd.family !== 'render' || !res?.result || typeof res.result !== 'object') return res;
  const { audio_data: audio, data, ...rest } = res.result;
  const shaped = { ...rest };
  if (audio) shaped.audio_data = `[${[].concat(audio).length} audio clip(s) omitted: the user can play them in the chart pane]`;
  if (Array.isArray(data)) {
    const headers = rest.chart_headers || [];
    shaped.series = data.map((s, i) => (Array.isArray(s) && s.every((v) => typeof v === 'number')
      ? { name: headers[i] ?? `series ${i}`, ...seriesStats(s) } : s));
  }
  return { ...res, result: shaped };
}

/** A long 0/1 row (a mask) as on / off index ranges, e.g. {mask_length: 196, on: "0-1", off: "2-195"}. */
export function maskSummary(row) {
  const runs = { 0: [], 1: [] };
  let start = 0;
  for (let i = 1; i <= row.length; i += 1) {
    if (i === row.length || row[i] !== row[start]) {
      runs[row[start]].push(i - 1 > start ? `${start}-${i - 1}` : `${start}`);
      start = i;
    }
  }
  return { mask_length: row.length, on: runs[1].join(', ') || 'none', off: runs[0].join(', ') || 'none' };
}

/** Keep tool results small: long arrays are summarised (the model can narrow its request). */
export function compact(value, { maxArray = 64, maxString = 4000, depth = 0 } = {}) {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}… [${value.length} chars, truncated]` : value;
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray && value.every((v) => v === 0 || v === 1)) return maskSummary(value);
    const items = value.slice(0, maxArray).map((v) => compact(v, { maxArray, maxString, depth: depth + 1 }));
    if (value.length > maxArray) items.push(`… ${value.length - maxArray} more items (narrow the request)`);
    return items;
  }
  if (value && typeof value === 'object') {
    if (depth > 6) return '[nested]';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v, { maxArray, maxString, depth: depth + 1 })]));
  }
  return value;
}
