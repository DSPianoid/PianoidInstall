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
export function endpointFor(cmd) {
  const base = cmd.target === 'launcher' || cmd.target === 'ui' ? `${LAUNCHER_URL}/api/command/` : `${BACKEND_URL}/command/`;
  return base + cmd.name;
}

/** Run one command over HTTP; returns the executor envelope {ok, status, result | error}. */
export async function callCommand(cmd, args, { source = 'assistant', fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Pianoid-Source': source };
  let res;
  try {
    res = await fetchImpl(endpointFor(cmd), { method: 'POST', headers, body: JSON.stringify(args || {}) });
  } catch (e) {
    const where = cmd.target === 'launcher' || cmd.target === 'ui' ? 'the launcher (:3001)' : 'the backend (:5000)';
    return { ok: false, status: 0, error: 'unreachable', message: `${where} is not reachable: ${e.message}` };
  }
  let body;
  try { body = await res.json(); } catch (e) { body = { ok: res.ok, status: res.status, result: null }; }
  return body;
}

/** Keep tool results small: long arrays are summarised (the model can narrow its request). */
export function compact(value, { maxArray = 64, maxString = 4000, depth = 0 } = {}) {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}… [${value.length} chars, truncated]` : value;
  }
  if (Array.isArray(value)) {
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
