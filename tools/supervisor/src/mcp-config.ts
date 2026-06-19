/**
 * MCP SERVER CONFIG — build the SDK `mcpServers` option from the user's
 * `~/.claude.json`, EXCLUDING the telegram plugin (the supervisor owns the
 * channel) and RESOLVING `${VAR}` env placeholders to literal values.
 *
 * The probe established (P2) that `options.mcpServers` is authoritative for what
 * the hosted session sees (config-file servers don't auto-load under
 * settingSources:['project']) — so we pass an explicit, curated map. The telegram
 * plugin is simply never included (natural exclusion); a deny-rule on its tools is
 * kept as belt-and-suspenders in the orchestrator policy.
 *
 * Concern (P2 = one job): parse + filter + resolve the MCP map. No SDK, no spawn.
 * Pure given the file contents (the file read is injectable for tests).
 *
 * SECRET HYGIENE: `${VAR}` values are resolved from `process.env` into the SDK
 * option object IN MEMORY only — never logged or printed (the caller passes the
 * object straight to query()).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A resolved MCP server entry (loose — matches the SDK's Record<name,cfg> shape). */
export type McpServerEntry = Record<string, unknown>;
export type McpServerMap = Record<string, McpServerEntry>;

/** Default exclusion: the telegram plugin (the supervisor owns the channel). */
export const DEFAULT_EXCLUDE_SUBSTRINGS = ['telegram'];
/**
 * STRICTER test-seal exclusion: telegram + BOTH whatsapp servers. A hosted test
 * orchestrator sending real WhatsApp is a worse breach than telegram (a third
 * party, not the user). Email is NOT excluded at the server level (its read tools
 * are useful) — its send tools are denied via --disallowed-tools instead.
 */
export const OUTWARD_SEND_EXCLUDE_SUBSTRINGS = ['telegram', 'whatsapp'];

/** Is this server name excluded by the given substring list (case-insensitive)? */
export function isExcludedServer(name: string, excludeSubstrings: string[] = DEFAULT_EXCLUDE_SUBSTRINGS): boolean {
  const n = name.toLowerCase();
  return excludeSubstrings.some((s) => n.includes(s.toLowerCase()));
}

/** Resolve `${VAR}` placeholders in a string from an env map (unknown → left as-is). */
export function resolveEnvPlaceholders(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (whole, varName: string) => {
    const v = env[varName];
    return v === undefined ? whole : v;
  });
}

/** Deep-resolve `${VAR}` in all string leaves of an MCP server entry. */
function resolveEntry(entry: McpServerEntry, env: NodeJS.ProcessEnv): McpServerEntry {
  const out: McpServerEntry = {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string') out[k] = resolveEnvPlaceholders(v, env);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? resolveEnvPlaceholders(x, env) : x));
    else if (v && typeof v === 'object') out[k] = resolveEntry(v as McpServerEntry, env);
    else out[k] = v;
  }
  return out;
}

/**
 * Build the curated SDK mcpServers map from a parsed `~/.claude.json` object.
 * Excludes servers whose name matches `excludeSubstrings` (default: telegram),
 * resolves `${VAR}` from `env`. Pure.
 */
export function buildMcpServers(
  claudeJson: unknown,
  env: NodeJS.ProcessEnv = process.env,
  excludeSubstrings: string[] = DEFAULT_EXCLUDE_SUBSTRINGS,
): McpServerMap {
  const root = (claudeJson ?? {}) as { mcpServers?: Record<string, McpServerEntry> };
  const src = root.mcpServers ?? {};
  const out: McpServerMap = {};
  for (const [name, entry] of Object.entries(src)) {
    if (isExcludedServer(name, excludeSubstrings)) continue;
    if (!entry || typeof entry !== 'object') continue;
    out[name] = resolveEntry(entry, env);
  }
  return out;
}

/** Load + build the mcpServers map from `~/.claude.json` (best-effort; {} on any error). */
export function loadMcpServers(
  opts: { claudeJsonPath?: string; env?: NodeJS.ProcessEnv; excludeSubstrings?: string[] } = {},
): McpServerMap {
  const path = opts.claudeJsonPath ?? join(homedir(), '.claude.json');
  try {
    const raw = readFileSync(path, 'utf8');
    return buildMcpServers(JSON.parse(raw), opts.env ?? process.env, opts.excludeSubstrings ?? DEFAULT_EXCLUDE_SUBSTRINGS);
  } catch {
    return {}; // no file / unparseable → no MCP servers (the session still works)
  }
}
