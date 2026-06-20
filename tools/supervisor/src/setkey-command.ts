/**
 * `/setkey` COMMAND — the pure parse + redaction logic for the in-channel provider-key intake
 * (proposal model-agnostic-agents-2026-06-19, the in-channel secret-intake extension).
 *
 * `/setkey <provider> <key>` lets the user supply an OpenAI-compatible provider's API key OVER
 * the chat channel. It is INTERCEPTED AT THE SUPERVISOR (like `/mode`) and handled there — the
 * raw key is NEVER forwarded to the orchestrator session, so it never enters the orchestrator's
 * context/stream. This module owns ONLY the pure bits (parse + redact); the side effects (store
 * the key, reply masked, delete the user's message) live in the SessionHost handler, and the
 * launcher/seal injects the stored key into that provider's agents.
 *
 * SECRET HYGIENE: {@link redactSetKeyText} produces the masked text that is what gets CAPTURED
 * (the supervisor swaps the raw inbound text for this before publishing to the bus → the capture
 * log / panel never hold the key value). The parse keeps the key in memory only transiently for
 * the store call.
 *
 * Concern (P2): pure command parsing + text redaction. NO I/O, NO store, NO channel. Pure functions
 * → fully unit-testable. DORMANT until activation (P6).
 *
 * Traces: proposal CP3/CP4 (containment + scoped secret), X4 (channel-mute / single-owner), M4
 * (the scoped-secret guard the stored key feeds); the in-channel `/setkey` intake design.
 */

import { maskSecretWithPrefix } from './secret-store.js';

/**
 * The reserved `/setkey …` command matcher. Like {@link MODE_CMD_RE} in session-host, the supervisor
 * intercepts this and never forwards it to the orchestrator. Case-insensitive; word-boundary so
 * `/setkeys` or `/setkeyfoo` does NOT match.
 */
export const SETKEY_CMD_RE = /^\/setkey\b/i;

/** Is this inbound text a `/setkey …` command at all? (Cheap predicate for the supervisor redactor.) */
export function isSetKeyCommand(text: string | undefined): boolean {
  return typeof text === 'string' && SETKEY_CMD_RE.test(text.trim());
}

/**
 * The parsed result of a `/setkey …` command.
 *   - `set`   — a well-formed `/setkey <provider> <key>` (provider token + raw key, both non-empty).
 *   - `usage` — a malformed command (bare `/setkey`, missing provider, or missing key) → reply usage.
 * Returns `null` when the text is NOT a `/setkey` command at all (caller falls through to a normal turn).
 *
 * NOTE: this does NOT validate the provider against the registry (that is the handler's job, so it
 * can produce a helpful "known providers: …" error). It only splits the shape.
 */
export type SetKeyCommand =
  | { kind: 'set'; providerToken: string; key: string }
  | { kind: 'usage'; reason: 'no_provider' | 'no_key' };

/**
 * Parse a `/setkey …` command into its provider token + raw key. The key is "the rest of the line
 * after the provider token", trimmed — so a key with internal characters is taken verbatim (keys
 * have no spaces, but taking the remainder is robust). Tolerates extra whitespace + case in the
 * command word. Returns null for a non-`/setkey` text.
 */
export function parseSetKeyCommand(text: string): SetKeyCommand | null {
  const trimmed = (text ?? '').trim();
  if (!SETKEY_CMD_RE.test(trimmed)) return null;
  // Strip the '/setkey' token, then split off the FIRST whitespace-token as the provider.
  const rest = trimmed.replace(SETKEY_CMD_RE, '').trim();
  if (rest.length === 0) return { kind: 'usage', reason: 'no_provider' };
  const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { kind: 'usage', reason: 'no_key' }; // a provider but no key
  const providerToken = m[1]!.trim();
  const key = m[2]!.trim();
  if (providerToken.length === 0) return { kind: 'usage', reason: 'no_provider' };
  if (key.length === 0) return { kind: 'usage', reason: 'no_key' };
  return { kind: 'set', providerToken, key };
}

/**
 * Redact the raw key out of a `/setkey` inbound text, replacing it with a masked placeholder, so the
 * CAPTURED record (and any log of the inbound) never holds the key value. A well-formed
 * `/setkey <provider> <key>` becomes `/setkey <provider> <masked>`; a malformed `/setkey …` (no key)
 * is returned with any trailing token masked defensively; a non-`/setkey` text is returned UNCHANGED.
 *
 * This is the function the supervisor applies to the inbound BEFORE publishing it to the bus.
 */
export function redactSetKeyText(text: string | undefined): string {
  if (typeof text !== 'string') return '';
  const parsed = parseSetKeyCommand(text);
  if (!parsed) return text; // not a /setkey command — leave it byte-for-byte unchanged
  // Preserve the command word + provider; mask whatever followed.
  const trimmed = text.trim();
  const afterCmd = trimmed.replace(SETKEY_CMD_RE, '').trim();
  if (parsed.kind === 'set') {
    const masked = maskSecretWithPrefix(parsed.key);
    return `/setkey ${parsed.providerToken} ${masked}`;
  }
  // usage form: bare `/setkey` or `/setkey <provider>` — nothing secret to mask, but if there is a
  // stray trailing token (reason no_key with a single token), keep just the provider token.
  if (afterCmd.length === 0) return '/setkey';
  const firstTok = afterCmd.split(/\s+/)[0] ?? '';
  return `/setkey ${firstTok}`.trim();
}

/** The usage/help line listing the command shape + the known providers (handler builds the provider list). */
export function setKeyUsageMessage(knownProviders: readonly string[]): string {
  const list = knownProviders.length ? knownProviders.join(', ') : '(none configured)';
  return `Usage: /setkey <provider> <key>. Known providers: ${list}.`;
}

/** The unknown-provider error line (helpful — lists the known providers). */
export function setKeyUnknownProviderMessage(token: string, knownProviders: readonly string[]): string {
  const list = knownProviders.length ? knownProviders.join(', ') : '(none configured)';
  return `Unknown provider "${token}". Known providers: ${list}.`;
}
