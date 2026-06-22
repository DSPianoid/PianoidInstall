/**
 * DEEPSEEK KEY BRIDGE — resolve the DeepSeek API key from the EXISTING `deepseek-codegen` MCP
 * server's configuration as a FALLBACK for a routed DeepSeek dispatch, so a coding-role dispatch
 * can authenticate to DeepSeek WITHOUT the operator running `/setkey` (the sealed store still wins
 * when it has the key — this is a fallback only).
 *
 * ★ CONTAINMENT (read this): the deepseek-codegen MCP stores its key ONLY in the user-scope
 * `~/.claude.json` (no project-local `.env` exists — verified). The supervisor DELIBERATELY excludes
 * the 'user' setting source (index.ts) to avoid loading `~/.claude.json` — that is the token-hijack
 * containment (a hosted child loading `~/.claude.json`'s `mcpServers`/`enabledPlugins` is the recurring
 * hijack vector). This module therefore does the SMALLEST possible thing: a NARROW single-key read —
 * it parses `~/.claude.json` and returns ONLY `mcpServers["deepseek-codegen"].env.DEEPSEEK_API_KEY`.
 * It NEVER reads/returns enabledPlugins, any other server, or any other field; it NEVER spawns or
 * loads anything; it is a pure JSON field-extract. It is GATED OFF by default (the caller only invokes
 * it when `SUPERVISOR_DEEPSEEK_KEY_BRIDGE` is ON) so it does not touch `~/.claude.json` unless the
 * operator explicitly enables the bridge. The key VALUE is never logged (callers pass only masked
 * diagnostics through `onNote`).
 *
 * Concern (P2 = one job): read the one DeepSeek key from the deepseek-codegen MCP config. It owns no
 * state, performs ONE bounded file read, and returns a string|undefined. Fail-soft: a missing/unreadable/
 * malformed file, a missing entry, or an empty key → undefined (the dispatch then stays key-free, exactly
 * as today — the bridge is best-effort, never fatal).
 *
 * Authority (P1): writes nothing; the sealed SecretStore remains the authoritative key source (the
 * caller checks it FIRST and only falls back here when it has no DeepSeek key).
 *
 * Traces: docs/proposals/supervisor-control-plane-and-activation-2026-06-20.md (Part B/§D(e) OD-1
 * per-backend key scoping); memory reference_hosted_claude_plugin_token_hijack (the user-scope read
 * boundary this module is careful about).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The env-var name the deepseek-codegen MCP uses for its key (== the supervisor's deepseek backend secretEnvVar). */
export const DEEPSEEK_SECRET_ENV_VAR = 'DEEPSEEK_API_KEY';

/** The MCP server id whose `env` block carries the bridged key in `~/.claude.json`. */
export const DEEPSEEK_CODEGEN_MCP_ID = 'deepseek-codegen';

/** Options for {@link resolveDeepseekKeyFromMcpConfig} (path injectable for tests; onNote is masked-only). */
export interface DeepseekKeyBridgeOptions {
  /** Override the `~/.claude.json` path (tests pass a temp file). Default = `<homedir>/.claude.json`. */
  claudeJsonPath?: string;
  /** Masked-only diagnostics sink (NEVER receives the key value). */
  onNote?: (line: string) => void;
}

/** The default user-scope `~/.claude.json` path (the file the supervisor otherwise avoids — see header). */
export function defaultClaudeJsonPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Read the deepseek-codegen MCP's DeepSeek key from `~/.claude.json` via a NARROW single-key extract:
 * returns `mcpServers["deepseek-codegen"].env.DEEPSEEK_API_KEY` (also tolerating a per-project
 * `projects[*].mcpServers` placement) when present + non-empty, else `undefined`. FAIL-SOFT on every
 * error (missing/unreadable/malformed file, missing entry, empty key). NEVER logs the value — only a
 * masked note that a key was/was not found. Does NOT read any other field of the file.
 *
 * ★ The caller MUST gate this behind the default-OFF `SUPERVISOR_DEEPSEEK_KEY_BRIDGE` flag — this
 * function performs the user-scope `~/.claude.json` read the supervisor otherwise avoids (containment).
 */
export function resolveDeepseekKeyFromMcpConfig(opts: DeepseekKeyBridgeOptions = {}): string | undefined {
  const path = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const note = (line: string): void => opts.onNote?.(`[deepseek-key-bridge] ${line}`);
  if (!existsSync(path)) {
    note('~/.claude.json not found — no bridged DeepSeek key (dispatch stays key-free).');
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    note('~/.claude.json is unreadable/malformed — no bridged DeepSeek key.');
    return undefined;
  }
  const key = extractDeepseekKey(parsed);
  if (typeof key === 'string' && key.trim().length > 0) {
    note(`bridged DeepSeek key found in ${DEEPSEEK_CODEGEN_MCP_ID} MCP config (length ${key.length}).`);
    return key;
  }
  note(`no ${DEEPSEEK_CODEGEN_MCP_ID} DeepSeek key in ~/.claude.json — dispatch stays key-free.`);
  return undefined;
}

/**
 * Pure NARROW extractor: pull ONLY `mcpServers["deepseek-codegen"].env.DEEPSEEK_API_KEY` out of a
 * parsed `~/.claude.json` object. Checks the top-level `mcpServers` first, then any per-project
 * `projects[*].mcpServers` (the CLI sometimes scopes MCP servers per project). Returns the string or
 * undefined. Reads NOTHING else (never enabledPlugins, never other servers/fields). Exported for the test.
 */
export function extractDeepseekKey(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;

  const fromServers = (servers: unknown): string | undefined => {
    if (!servers || typeof servers !== 'object') return undefined;
    const entry = (servers as Record<string, unknown>)[DEEPSEEK_CODEGEN_MCP_ID];
    if (!entry || typeof entry !== 'object') return undefined;
    const env = (entry as Record<string, unknown>).env;
    if (!env || typeof env !== 'object') return undefined;
    const v = (env as Record<string, unknown>)[DEEPSEEK_SECRET_ENV_VAR];
    return typeof v === 'string' ? v : undefined;
  };

  // 1) top-level mcpServers
  const top = fromServers(root.mcpServers);
  if (top !== undefined) return top;

  // 2) per-project projects[*].mcpServers
  const projects = root.projects;
  if (projects && typeof projects === 'object') {
    for (const proj of Object.values(projects as Record<string, unknown>)) {
      if (proj && typeof proj === 'object') {
        const v = fromServers((proj as Record<string, unknown>).mcpServers);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}
