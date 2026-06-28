/**
 * ROLE-ROUTING STORE (M8) — a GITIGNORED, durable per-role override store for the Tier-2
 * model selection (proposal model-agnostic-agents-2026-06-19 PART Q.3 / Q.4 D-H — the
 * `/setrole` runtime control). The user selects the model for EACH role IN-CHANNEL; the
 * supervisor persists that choice here so the next dispatch of that role uses it (runtime,
 * no restart) AND it survives a restart.
 *
 * WHY (Tier-2): the role-router (M2) resolves a role to {backend, model} from its config map.
 * The DEFAULT_ROLE_ROUTING_CONFIG is the in-CODE default; this store is the RUNTIME OVERRIDE
 * layer on top of it. The router's resolution precedence becomes:
 *     persisted override (this store)  >  DEFAULT_ROLE_ROUTING_CONFIG  >  fail-safe claude-cli.
 * (See {@link mergeRoleRoutingConfig} / {@link resolveRoleBackendWithOverrides} in role-router.ts.)
 *
 * STORAGE (mirrors secret-store.ts exactly):
 *   - One JSON file at a configured path that MUST live under a gitignored dir (the supervisor's
 *     `.state/` is gitignored by construction — tools/supervisor/.gitignore line `.state/`). The
 *     store does NOT choose the path (the caller passes it); {@link defaultRoleRoutingStorePath}
 *     points at `.state/role-routing.json` for convenience; {@link assertGitignoredPath} (reused
 *     from secret-store) is the defensive guard the caller may use.
 *   - Shape: `{ "<role>": { "provider": "<providerId>", "model": "<modelId>" } }` — keyed by ROLE.
 *     The `model` is optional (absent ⇒ the provider's default model resolves downstream).
 *   - Written with restrictive perms where the OS honors them (0o600). NO secret lives here — a
 *     routing override is role→provider/model, NOT a key — but the same hygiene is cheap + uniform.
 *
 * Concern (P2 = one job): durable per-role override persistence + the override→config projection
 * ONLY. It does NOT parse `/setrole` (setrole-command.ts owns that), does NOT know the provider
 * registry's baseUrl/secret (provider-registry owns that — the store only records the chosen
 * providerId + model strings), and does NOT resolve a role (role-router owns that). DORMANT until
 * activation (P6): nothing constructs this until index.ts wires it (Batch 4, separate).
 *
 * Authority (P1): the role-routing store is the SOLE writer of its JSON file. The SUPERVISOR
 * (SessionHost) is the SOLE caller of its writer — both the typed `/setrole` command and the
 * orchestrator-invokable `setRoleRouting()` funnel through ONE supervisor writer.
 *
 * SCOPE / SAFETY: pure types + const data + a thin synchronous-FS class. NO network, NO existing
 * runtime path touched. Adding/removing an override changes NOTHING at runtime until role-routing
 * is activated (default-OFF SUPERVISOR_ROLE_ROUTING gates whether the composition root dispatches).
 *
 * Traces: proposal Q.3 (two-tier — Tier-2 runtime role models), Q.4 D-H / OD-6; CP2/AP2/AP5; M2/M8.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isRole, type Role } from './backend-kinds.js';
import {
  isRoleRoutingOverride,
  type RoleRoutingOverride,
  type RoleRoutingOverrideMap,
} from './role-router.js';
import { isProviderId, type ProviderId } from './provider-registry.js';

// Re-export the override DATA MODEL (it is owned by role-router.ts — the resolution concern) so
// callers that only touch the store can import the type from here too.
export type { RoleRoutingOverride, RoleRoutingOverrideMap } from './role-router.js';

/** The default store filename under the supervisor state dir (gitignored). */
export const DEFAULT_ROLE_ROUTING_STORE_FILENAME = 'role-routing.json';

/**
 * Compute the default store path: `<stateDir>/role-routing.json`. The default `stateDir` is
 * `<supervisorRoot>/.state` — gitignored by tools/supervisor/.gitignore. Override via the
 * SUPERVISOR_STATE_DIR env var (the same dir the secret store uses, so BOTH live under one
 * gitignored `.state/`). The caller passes the resolved path to {@link RoleRoutingStore}.
 */
export function defaultRoleRoutingStorePath(
  supervisorRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = (env.SUPERVISOR_STATE_DIR ?? '').trim() || resolve(supervisorRoot, '.state');
  return resolve(stateDir, DEFAULT_ROLE_ROUTING_STORE_FILENAME);
}

/** Thrown on a role-routing-store I/O / validation problem. */
export class RoleRoutingStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRoutingStoreError';
  }
}

/** Options to construct a {@link RoleRoutingStore}. */
export interface RoleRoutingStoreOptions {
  /** Absolute path to the JSON store file (MUST be under a gitignored dir — see assertGitignoredPath). */
  filePath: string;
  /** Optional diagnostics sink (receives non-secret messages only). Default: silent. */
  onNote?: (line: string) => void;
}

/**
 * The role-routing override store. Reads/writes a JSON map of `{ <role>: {provider, model?} }`.
 * Synchronous FS, pure-local — no network, zero spend. SOLE writer (P1) of its file.
 */
export class RoleRoutingStore {
  private readonly filePath: string;
  private readonly onNote?: (line: string) => void;

  constructor(opts: RoleRoutingStoreOptions) {
    this.filePath = opts.filePath;
    this.onNote = opts.onNote;
  }

  /** The store's file path (for diagnostics — it is a path, not a secret). */
  get path(): string {
    return this.filePath;
  }

  /** Load the validated `{ role: override }` map from disk (empty object if absent/torn/invalid). */
  load(): RoleRoutingOverrideMap {
    if (!existsSync(this.filePath)) return {};
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (e) {
      throw new RoleRoutingStoreError(
        `failed to read the role-routing store: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (raw.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A torn/corrupt file → treat as empty rather than throwing (the user can re-/setrole).
      this.note('role-routing store file was unparseable — treating as empty (re-run /setrole)');
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: RoleRoutingOverrideMap = {};
    for (const [role, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isRole(role)) continue; // ignore unknown roles defensively
      const entry = this.coerceOverride(val);
      if (entry) out[role] = entry;
    }
    return out;
  }

  /**
   * Validate + coerce one on-disk value to a {@link RoleRoutingOverride}, or null if invalid. Reuses
   * the router's {@link isRoleRoutingOverride} guard (single source of truth for the override shape),
   * then normalizes the optional model (trims; drops an empty string).
   */
  private coerceOverride(val: unknown): RoleRoutingOverride | null {
    if (!isRoleRoutingOverride(val)) return null; // unknown provider id / bad shape → drop the entry
    const entry: RoleRoutingOverride = { provider: val.provider };
    if (typeof val.model === 'string' && val.model.trim().length > 0) entry.model = val.model.trim();
    return entry;
  }

  /** Persist a validated `{ role: override }` map (mkdir + write + restrictive perms). Sole writer (P1). */
  private persist(map: RoleRoutingOverrideMap): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body = JSON.stringify(map, null, 2) + '\n';
    writeFileSync(this.filePath, body, { encoding: 'utf8' });
    // Best-effort restrictive perms (no-op on filesystems that don't honor it, e.g. Windows).
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* perms not honored here — fine; the dir is gitignored regardless */
    }
  }

  /**
   * Set (or replace) a role's override. Validates the role is a known {@link Role} and the provider
   * is a known {@link ProviderId} (callers should pre-validate for a friendly message; this is the
   * defensive backstop). `model` is optional. Returns the stored override. SOLE writer.
   */
  setRole(role: Role, provider: ProviderId, model?: string): RoleRoutingOverride {
    if (!isRole(role)) throw new RoleRoutingStoreError(`unknown role "${role}"`);
    if (!isProviderId(provider)) throw new RoleRoutingStoreError(`unknown provider "${provider}"`);
    const map = this.load();
    const entry: RoleRoutingOverride = { provider };
    const m = (model ?? '').trim();
    if (m.length > 0) entry.model = m;
    map[role] = entry;
    this.persist(map);
    this.note(`set role override ${role} → ${provider}${entry.model ? ` (${entry.model})` : ''}`);
    return entry;
  }

  /** Remove a role's override (reverting it to the in-code default). No-op if absent. SOLE writer. */
  clearRole(role: Role): void {
    const map = this.load();
    if (map[role] === undefined) return;
    delete map[role];
    this.persist(map);
    this.note(`cleared role override ${role}`);
  }

  /** Read a single role's override, or undefined if none stored. */
  get(role: Role): RoleRoutingOverride | undefined {
    return this.load()[role];
  }

  /** The full validated override map (role → {provider, model?}). */
  loadAll(): RoleRoutingOverrideMap {
    return this.load();
  }

  private note(line: string): void {
    this.onNote?.(`[role-routing-store] ${line}`);
  }
}

// The override → config MERGE (mergeRoleRoutingOverrides) and the per-entry projection
// (routingOverrideToBackendEntry) live in role-router.ts (the resolution concern, P2). The store
// owns ONLY the persistence of the override map; callers merge via the router's pure helpers.
