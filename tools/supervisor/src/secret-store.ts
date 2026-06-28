/**
 * SECRET STORE — a GITIGNORED, per-provider scoped store for provider API keys supplied
 * IN-CHANNEL via `/setkey` (proposal model-agnostic-agents-2026-06-19, the in-channel
 * secret-intake extension).
 *
 * WHY: the user supplies a provider key over the chat channel. The supervisor intercepts
 * `/setkey <provider> <key>` (it NEVER reaches the orchestrator session — the raw key never
 * enters the orchestrator's context), stores the key here scoped to that provider, and at
 * spawn the launcher/seal injects each stored key into ONLY that provider's agents' env
 * (the existing per-provider key-scoping guard, cost-safety.ts, then rejects every foreign key).
 *
 * STORAGE:
 *   - One JSON file at a configured path that MUST live under a gitignored dir (the supervisor's
 *     `.state/` is gitignored by construction — tools/supervisor/.gitignore). The store does NOT
 *     choose the path (the caller passes it); a default helper {@link defaultSecretStorePath}
 *     points at `.state/provider-secrets.json` for convenience, and {@link assertGitignoredPath}
 *     is a defensive guard the caller may use.
 *   - Shape: `{ "<PROVIDER_SECRET_ENV_VAR>": "<key>" }` — keyed by the provider's SECRET ENV VAR
 *     NAME (e.g. 'DEEPSEEK_API_KEY'), so loading it == "inject this env var into that provider's
 *     agents". Keyed by env-var name (not provider id) so the load path is a direct env projection.
 *   - The file is written with restrictive permissions where the OS honors them (0o600).
 *
 * SECRET HYGIENE (load-bearing):
 *   - NEVER logs or returns a key VALUE except through the explicit read API the launcher/seal uses.
 *   - {@link maskSecret} produces the ONLY display form (e.g. 'gsk_…<last4>'); the confirmation +
 *     any diagnostics use the mask, never the raw value.
 *   - The store performs NO network call and is pure-FS — zero spend.
 *
 * Concern (P2 = one job): durable per-provider key persistence + masked display ONLY. It does
 * NOT parse the `/setkey` command (session-host owns that), does NOT know the provider registry's
 * model/baseUrl (provider-registry owns that — the store only needs the secret env-var NAME), and
 * does NOT inject env (the launcher/seal owns that). DORMANT until activation (P6).
 *
 * Authority (P1): the secret store is the SOLE writer of its JSON file.
 *
 * Traces: proposal CP3/CP4 (containment + per-backend scoped secret), M4 (the scoped-secret guard
 * this feeds), OD-1 (per-backend key scoping); the in-channel `/setkey` intake design.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/** The default store filename under the supervisor state dir (gitignored). */
export const DEFAULT_SECRET_STORE_FILENAME = 'provider-secrets.json';

/**
 * Compute the default store path: `<stateDir>/provider-secrets.json`. The default `stateDir` is
 * `<supervisorRoot>/.state` — gitignored by tools/supervisor/.gitignore. Override via the
 * SUPERVISOR_STATE_DIR env var (also where the rest of the supervisor's local state would live).
 * The caller passes the resolved path to {@link SecretStore}; this is just the conventional default.
 */
export function defaultSecretStorePath(
  supervisorRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = (env.SUPERVISOR_STATE_DIR ?? '').trim() || resolve(supervisorRoot, '.state');
  return resolve(stateDir, DEFAULT_SECRET_STORE_FILENAME);
}

/**
 * Defensive guard: assert a store path lives under a gitignored segment so a key file cannot be
 * committed by accident. Accepts a path whose normalized form contains a `.state` OR `.secrets`
 * segment, or that ends in `.env`/`.env.*` (all gitignored by tools/supervisor/.gitignore). Throws
 * {@link SecretStoreError} otherwise. The caller (launcher) may use this before constructing the store.
 */
export function assertGitignoredPath(filePath: string): void {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  const segments = abs.split(sep);
  const inGitignoredDir = segments.some((s) => s === '.state' || s === '.secrets');
  const base = segments[segments.length - 1] ?? '';
  const isEnvFile = base === '.env' || base.startsWith('.env.');
  if (!inGitignoredDir && !isEnvFile) {
    throw new SecretStoreError(
      `secret store path is not under a gitignored location (${filePath}); ` +
        `place it under a '.state'/'.secrets' dir or name it '.env*' so a key file is never committed`,
    );
  }
}

/**
 * Mask a secret for display/confirmation/logs. Shows a SHORT, non-reversible hint only:
 * the last `tail` characters (default 4), preceded by an ellipsis. An empty/short key masks
 * to just the ellipsis (never reveals the whole value). NEVER returns the full value.
 * Examples: maskSecret('gsk_abcdEFGH1234') → '…1234'; with a known prefix the caller may prepend it.
 */
export function maskSecret(value: string, tail = 4): string {
  const v = (value ?? '').trim();
  if (v.length === 0) return '∅';
  if (v.length <= tail) return '…' + v.slice(-Math.min(tail, v.length)); // very short — still only a tail
  return '…' + v.slice(-tail);
}

/**
 * A richer masked label that also surfaces a known token PREFIX (the part before the first '_' or
 * '-', capped) when present — so 'gsk_live_abcd1234' → 'gsk…1234'. The prefix is a NON-secret
 * vendor marker (e.g. 'gsk' for Groq, 'sk' for OpenAI), not a secret part. Falls back to {@link maskSecret}.
 */
export function maskSecretWithPrefix(value: string, tail = 4): string {
  const v = (value ?? '').trim();
  if (v.length === 0) return '∅';
  const m = v.match(/^([A-Za-z]{2,6})[_-]/);
  const prefix = m ? m[1] : '';
  const masked = maskSecret(v, tail);
  return prefix ? `${prefix}${masked}` : masked;
}

/** Thrown on a secret-store I/O / validation problem. NEVER carries a key value. */
export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/** Options to construct a {@link SecretStore}. */
export interface SecretStoreOptions {
  /** Absolute path to the JSON store file (MUST be under a gitignored dir — see {@link assertGitignoredPath}). */
  filePath: string;
  /**
   * Optional diagnostics sink — receives messages that NEVER contain a key value (only masked
   * forms / counts / env-var names). Default: silent.
   */
  onNote?: (line: string) => void;
}

/**
 * The secret store. Reads/writes a JSON map of `{ <SECRET_ENV_VAR_NAME>: <key> }`. Per-provider
 * scoping is by env-var name (the caller passes the provider's secretEnvVar). Synchronous FS,
 * pure-local — no network, zero spend.
 */
export class SecretStore {
  private readonly filePath: string;
  private readonly onNote?: (line: string) => void;

  constructor(opts: SecretStoreOptions) {
    this.filePath = opts.filePath;
    this.onNote = opts.onNote;
  }

  /** The store's file path (for diagnostics — it is a path, not a secret). */
  get path(): string {
    return this.filePath;
  }

  /** Load the raw `{ envVarName: key }` map from disk (empty object if the file is absent/torn). Internal. */
  private load(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (e) {
      throw new SecretStoreError(`failed to read the secret store: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (raw.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A torn/corrupt file → treat as empty rather than throwing (the user can re-/setkey).
      this.note('secret store file was unparseable — treating as empty (re-run /setkey)');
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
    }
    return out;
  }

  /** Persist a raw `{ envVarName: key }` map atomically-ish (write + restrictive perms). Sole writer (P1). */
  private persist(map: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body = JSON.stringify(map, null, 2) + '\n';
    writeFileSync(this.filePath, body, { encoding: 'utf8' });
    // Best-effort restrictive perms (no-op / ignored on filesystems that don't honor it, e.g. Windows).
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* perms not honored here — fine; the dir is gitignored regardless */
    }
  }

  /**
   * Store (or replace) a provider's key, scoped under its SECRET ENV VAR NAME. Validates the key is
   * non-empty/non-whitespace. Returns the MASKED form for the confirmation (never the raw value).
   * NEVER logs the value.
   */
  setKey(secretEnvVar: string, key: string): { masked: string } {
    const envName = (secretEnvVar ?? '').trim();
    if (envName.length === 0) throw new SecretStoreError('a secret env var name is required');
    const value = (key ?? '').trim();
    if (value.length === 0) throw new SecretStoreError('refusing to store an empty key');
    const map = this.load();
    map[envName] = value;
    this.persist(map);
    const masked = maskSecretWithPrefix(value);
    this.note(`stored key for ${envName} (${masked})`); // masked only — never the value
    return { masked };
  }

  /** Read a single provider's key by its secret env var name, or undefined if not stored. (The launcher/seal read API.) */
  getKey(secretEnvVar: string): string | undefined {
    const map = this.load();
    return map[(secretEnvVar ?? '').trim()];
  }

  /** True iff a non-empty key is stored for this secret env var name. */
  has(secretEnvVar: string): boolean {
    return typeof this.getKey(secretEnvVar) === 'string';
  }

  /**
   * Load the full `{ envVarName: key }` map — the LAUNCHER/SEAL projection: each entry is exactly the
   * env var to inject into that provider's agents. (Caller scopes per provider; this returns all stored.)
   */
  loadAll(): Record<string, string> {
    return this.load();
  }

  /** The set of secret env-var NAMES that currently have a stored key (names only — never values). */
  storedEnvVarNames(): string[] {
    return Object.keys(this.load());
  }

  private note(line: string): void {
    this.onNote?.(`[secret-store] ${line}`);
  }
}
