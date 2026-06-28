/**
 * `/setrole` + `/roles` COMMANDS — the pure parse + message logic for the Tier-2 per-role
 * model-selection controls (proposal model-agnostic-agents-2026-06-19 PART Q.3 — the runtime
 * role-router edit). Siblings of `/setkey` (setkey-command.ts) and `/mode` (session-host.ts):
 * INTERCEPTED AT THE SUPERVISOR and handled there — NEVER forwarded to the orchestrator session.
 *
 *   - `/setrole <role> <provider> [model]` — set the role's provider (+ optional model; absent ⇒
 *     the provider's configurable default). Persists the routing override (RoleRoutingStore) +
 *     replies a confirmation (e.g. "coding → groq (llama-3.3-70b) ✓").
 *   - `/roles` — list the current effective role→provider/model map (override merged over the
 *     in-code default) + per-provider key-presence (BOOLEAN only, never a key value).
 *
 * Unlike `/setkey`, NOTHING here is secret — a role/provider/model are not credentials — so there
 * is NO redaction; the command + its echo are safe in the capture log. The only hygiene rule is
 * `/roles` MUST surface key PRESENCE as a boolean, never the value (enforced by the handler, which
 * calls secretStore.has()).
 *
 * Concern (P2): pure command parsing + message-string building ONLY. NO I/O, NO store, NO channel,
 * NO registry lookups (the handler validates the provider against the registry so it can build a
 * helpful "known providers: …" error). Pure functions → fully unit-testable. DORMANT until
 * activation (P6).
 *
 * Traces: proposal Q.3 (Tier-2 runtime role models), Q.4 D-H; CP2/AP2; M2/M8; the `/setkey` seam (M7).
 */

/**
 * The reserved `/setrole …` matcher. Like SETKEY_CMD_RE, the supervisor intercepts this and never
 * forwards it. Case-insensitive; word-boundary so `/setroles` or `/setrolefoo` does NOT match.
 */
export const SETROLE_CMD_RE = /^\/setrole\b/i;

/**
 * The reserved `/roles` matcher (the listing command). Word-boundary so `/rolesfoo` does NOT match.
 * NOTE: `/roles` is matched FIRST by the handler; `/setrole` is a different word so there is no
 * prefix collision between the two.
 */
export const ROLES_CMD_RE = /^\/roles\b/i;

/** Is this inbound text a `/setrole …` command at all? (Cheap predicate.) */
export function isSetRoleCommand(text: string | undefined): boolean {
  return typeof text === 'string' && SETROLE_CMD_RE.test(text.trim());
}

/** Is this inbound text the `/roles` listing command? (Cheap predicate.) */
export function isRolesCommand(text: string | undefined): boolean {
  return typeof text === 'string' && ROLES_CMD_RE.test(text.trim());
}

/**
 * The parsed result of a `/setrole …` command.
 *   - `set`   — a well-formed `/setrole <role> <provider> [model]` (roleToken + providerToken,
 *               both non-empty; modelToken optional).
 *   - `usage` — a malformed command (bare `/setrole`, or missing the provider) → reply usage.
 * Returns `null` when the text is NOT a `/setrole` command at all (caller falls through).
 *
 * NOTE: this does NOT validate role/provider against their registries (the handler does, so it can
 * produce helpful "known roles / known providers" errors). It only splits the shape.
 */
export type SetRoleCommand =
  | { kind: 'set'; roleToken: string; providerToken: string; modelToken?: string }
  | { kind: 'usage'; reason: 'no_role' | 'no_provider' };

/**
 * Parse a `/setrole …` command into role + provider [+ model] tokens. Tolerates extra whitespace
 * and case in the command word. Tokens beyond the third (model) are joined back into the model (a
 * model id has no spaces, but taking the remainder is robust + mirrors setkey's remainder rule).
 * Returns null for a non-`/setrole` text.
 */
export function parseSetRoleCommand(text: string): SetRoleCommand | null {
  const trimmed = (text ?? '').trim();
  if (!SETROLE_CMD_RE.test(trimmed)) return null;
  const rest = trimmed.replace(SETROLE_CMD_RE, '').trim();
  if (rest.length === 0) return { kind: 'usage', reason: 'no_role' };
  const tokens = rest.split(/\s+/);
  const roleToken = (tokens[0] ?? '').trim();
  if (roleToken.length === 0) return { kind: 'usage', reason: 'no_role' };
  const providerToken = (tokens[1] ?? '').trim();
  if (providerToken.length === 0) return { kind: 'usage', reason: 'no_provider' };
  const modelToken = tokens.slice(2).join(' ').trim();
  return modelToken.length > 0
    ? { kind: 'set', roleToken, providerToken, modelToken }
    : { kind: 'set', roleToken, providerToken };
}

/** The `/setrole` usage/help line (lists the command shape + known roles + known providers). */
export function setRoleUsageMessage(
  knownRoles: readonly string[],
  knownProviders: readonly string[],
): string {
  const roles = knownRoles.length ? knownRoles.join(', ') : '(none)';
  const providers = knownProviders.length ? knownProviders.join(', ') : '(none configured)';
  return `Usage: /setrole <role> <provider> [model]. Roles: ${roles}. Providers: ${providers}.`;
}

/** The unknown-role error line (helpful — lists the known roles). */
export function setRoleUnknownRoleMessage(token: string, knownRoles: readonly string[]): string {
  const list = knownRoles.length ? knownRoles.join(', ') : '(none)';
  return `Unknown role "${token}". Known roles: ${list}.`;
}

/** The unknown-provider error line (helpful — lists the known providers). */
export function setRoleUnknownProviderMessage(
  token: string,
  knownProviders: readonly string[],
): string {
  const list = knownProviders.length ? knownProviders.join(', ') : '(none configured)';
  return `Unknown provider "${token}". Known providers: ${list}.`;
}

/**
 * The "key not set yet" WARNING appended to a `/setrole` confirmation when the chosen provider has
 * no stored key yet. The selection is STILL recorded (the user may set the key after); this just
 * tells them the role won't run until the key is supplied. Mentions the exact `/setkey` to run.
 * NEVER contains a key value (there is none).
 */
export function setRoleNoKeyWarning(provider: string, secretEnvVar: string): string {
  return `⚠️ no ${secretEnvVar} set yet — set it with /setkey ${provider} <key> before this role can run`;
}

/**
 * Build the `/setrole` success confirmation, e.g. "coding → groq (llama-3.3-70b) ✓" (model shown
 * whether explicit or the provider default). An optional trailing warning (no-key) is appended on
 * its own line. Pure string assembly. NEVER contains a key value.
 */
export function setRoleConfirmMessage(
  role: string,
  provider: string,
  model: string,
  warning?: string,
): string {
  const head = `${role} → ${provider} (${model}) ✓`;
  return warning ? `${head}\n${warning}` : head;
}

/** One row of the `/roles` listing — a resolved role + its effective provider/model + key presence. */
export interface RolesListRow {
  role: string;
  /** 'claude' for the claude-cli backend, else the provider id (e.g. 'groq'). */
  provider: string;
  /** The effective model id (explicit override, provider default, or a configured-default placeholder). */
  model: string;
  /** Whether the role is an overridden (user-selected) entry vs the in-code default. */
  overridden: boolean;
  /**
   * Whether a key is present for this provider — BOOLEAN ONLY (never a value). `null` when the
   * backend needs no key (claude-cli) — rendered as "n/a".
   */
  keyPresent: boolean | null;
}

/**
 * Render the `/roles` listing from already-resolved rows (the handler builds the rows from the
 * merged config + the secret store's `has()` booleans). Pure string assembly — receives ONLY
 * booleans for key state, so a key value can NEVER reach this function. Example line:
 *   "coding → groq (llama-3.3-70b)  [override]  key: yes"
 */
export function rolesListMessage(rows: readonly RolesListRow[]): string {
  if (rows.length === 0) return 'No roles configured.';
  const lines = rows.map((r) => {
    const tag = r.overridden ? '  [override]' : '  [default]';
    const key = r.keyPresent === null ? 'key: n/a' : `key: ${r.keyPresent ? 'yes' : 'no'}`;
    return `${r.role} → ${r.provider} (${r.model})${tag}  ${key}`;
  });
  return `Effective role routing:\n${lines.join('\n')}`;
}
