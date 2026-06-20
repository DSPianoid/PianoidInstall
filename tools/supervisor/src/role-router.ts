/**
 * ROLE ROUTER (M2) — the PURE resolver of `role → {backend, model, fallback}`.
 *
 * Mirrors the `driver-policy.ts` pattern: a side-effect-free, unit-testable decision
 * separate from the side-effecting composition root. Given a role + a config map (and
 * an optional explicit per-dispatch override), it returns a {@link BackendSelection}.
 *
 * Precedence (proposal M2 / D-B):
 *   1. an explicit per-dispatch OVERRIDE (the dispatcher names the backend directly)
 *   2. the config role→backend MAP
 *   3. the FAIL-SAFE DEFAULT = claude-cli (the proven, key-free backend)
 *
 * An UNRECOGNIZED role is NOT an error — it resolves to the default backend (never
 * throws). No I/O. Dormant until role-routing is activated (P6); the default-OFF
 * switch is checked by the caller (see {@link isRoleRoutingEnabled}), not here — the
 * resolver is pure and always answers.
 *
 * Traces: proposal AP2, CP2; §M M2; PART P P1.
 */

import {
  DEFAULT_BACKEND_KIND,
  isBackendKind,
  type BackendKind,
  type BackendSelection,
  type Role,
} from './backend-kinds.js';
import { isProviderId, type ProviderId } from './provider-registry.js';

/**
 * The default-OFF feature switch (X5 / AP5). Role-routing is DORMANT unless this env
 * var is explicitly turned on. With it unset/empty/'off'/'0'/'false', the supervisor
 * behaves byte-for-byte as today (the live orchestrator path never consults the
 * router). Exported so the composition root + the test harness gate on the SAME rule.
 *
 * NOTE: P1 deliberately does NOT wire this into index.ts — the switch is proven only
 * in the test harness (activation is P6). Pure: reads a passed env map.
 */
export const ROLE_ROUTING_ENV_VAR = 'SUPERVISOR_ROLE_ROUTING';

/** True only when SUPERVISOR_ROLE_ROUTING is explicitly ON ('1'/'true'/'on', case-insensitive). */
export function isRoleRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[ROLE_ROUTING_ENV_VAR] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * A per-role config entry — the data the map carries for a role. `backend` is
 * required; `model`/`fallbackBackend` optional. (A future config loader produces this
 * shape; here it is just the resolver's input type.)
 */
export interface RoleBackendEntry {
  backend: BackendKind;
  model?: string;
  fallbackBackend?: BackendKind;
}

/** The role-routing config: a role→entry map + an optional explicit default override. */
export interface RoleRouterConfig {
  /** Role → backend entry. A role absent here falls through to the default backend. */
  roles?: Partial<Record<Role | string, RoleBackendEntry>>;
  /**
   * Override the fail-safe default backend kind (still claude-cli unless set). Must be
   * a known backend kind; an unknown value is ignored (stays claude-cli). For P1 this
   * is rarely used — the proven default IS claude-cli.
   */
  defaultBackend?: BackendKind;
}

/** An explicit per-dispatch override — the dispatcher names the backend directly (highest precedence). */
export interface RoleDispatchOverride {
  backend?: BackendKind;
  model?: string;
  fallbackBackend?: BackendKind;
}

/**
 * The DEFAULT role→backend routing config (the proposal's initial map — DATA, hot-swappable):
 *   - planning  → claude-cli (judgment/architecture; premium reasoning; has teams) — P1.
 *   - coding    → api-adapter, model 'deepseek-v4-flash' (routine codegen, cheap tier) — P3,
 *     with fallbackBackend claude-cli (FD6, EXECUTED at P5; declared here for the taxonomy).
 *   - reviewing → api-adapter, model 'gpt-5-codex' (second-opinion; OD-4 Codex=OpenAI-API, USER-APPROVED) — P4.
 *     The model id is a CONFIGURABLE DEFAULT (placeholder confirmed before activation — see
 *     CODEX_REVIEWING_CONFIG); the registry resolves it to the Codex backend config (OPENAI_API_KEY).
 *
 * DORMANT: this map is consumed ONLY when role-routing is activated (P6); the default-OFF switch
 * (SUPERVISOR_ROLE_ROUTING) gates whether the composition root EVER dispatches. The router itself
 * is pure and always resolves; this constant is the data it resolves against. Models pin to the
 * same ids the backend-registry's DEFAULT_API_ADAPTER_CONFIGS map keys on (DeepSeek coding +
 * Codex reviewing), so coding→DeepSeek and reviewing→Codex both resolve end-to-end.
 */
export const DEFAULT_ROLE_ROUTING_CONFIG: RoleRouterConfig = {
  roles: {
    planning: { backend: 'claude-cli' },
    coding: { backend: 'api-adapter', model: 'deepseek-v4-flash', fallbackBackend: 'claude-cli' },
    reviewing: { backend: 'api-adapter', model: 'gpt-5-codex', fallbackBackend: 'claude-cli' },
  },
};

/**
 * Resolve a role to a {@link BackendSelection}. Pure. Precedence: explicit override >
 * config map > fail-safe default (claude-cli). An unrecognized role → the default
 * backend (never throws). `model`/`fallbackBackend` are carried through from whichever
 * source supplied the backend, with the override winning field-by-field when present.
 */
export function resolveRoleBackend(
  role: Role | string,
  config: RoleRouterConfig = {},
  override?: RoleDispatchOverride,
): BackendSelection {
  // The fail-safe default backend (claude-cli unless config overrides it to another KNOWN kind).
  const defaultBackend: BackendKind = isBackendKind(config.defaultBackend)
    ? config.defaultBackend
    : DEFAULT_BACKEND_KIND;

  // (2) the config map entry for this role, if any (an unknown role → undefined → default).
  const mapped = config.roles?.[role];

  // (1) explicit override wins per-field; else the mapped entry; else the default backend.
  const backend: BackendKind =
    (override && isBackendKind(override.backend) ? override.backend : undefined) ??
    mapped?.backend ??
    defaultBackend;

  const model = override?.model ?? mapped?.model;
  const fallbackBackend =
    (override && isBackendKind(override.fallbackBackend) ? override.fallbackBackend : undefined) ??
    mapped?.fallbackBackend;

  const selection: BackendSelection = { role, backend };
  if (model !== undefined) selection.model = model;
  if (fallbackBackend !== undefined) selection.fallbackBackend = fallbackBackend;
  return selection;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * TIER-2 PERSISTED-OVERRIDE LAYER (PART Q.3 — the `/setrole` runtime control).
 *
 * The user selects the model for EACH role in-channel; the supervisor persists that choice (in the
 * RoleRoutingStore, role-routing-store.ts — the FS owner) and the router layers it OVER the in-code
 * DEFAULT_ROLE_ROUTING_CONFIG. The resolution precedence the task requires —
 *     persisted override  >  DEFAULT_ROLE_ROUTING_CONFIG  >  fail-safe default (claude-cli)
 * — is realized by MERGING the override map into the base config, then reusing the EXISTING pure
 * resolveRoleBackend (no new resolution logic). The override DATA MODEL + merge live HERE (the
 * resolution concern, P2); the store owns ONLY the persistence of this map (so router↔store is a
 * clean one-way dependency: store imports these types, the router imports nothing from the store).
 *
 * Pure: no I/O. The persisted layer is INJECTABLE — tests (and the store) pass a plain map.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One persisted per-role override — the {provider, model?} the user selected for a role via
 * `/setrole`. `provider` is a registry provider id; `model` is optional (absent ⇒ the provider's
 * configurable default resolves downstream). Pure data; the RoleRoutingStore persists this shape.
 */
export interface RoleRoutingOverride {
  provider: ProviderId;
  model?: string;
}

/** The persisted override map: role → override. (The injectable Tier-2 layer.) */
export type RoleRoutingOverrideMap = Partial<Record<Role, RoleRoutingOverride>>;

/**
 * Project one persisted override → a {@link RoleBackendEntry}. The provider id maps to its backend
 * KIND: claude-cli has no provider entry, so EVERY registry provider here is an `api-adapter`
 * backend (the Q.1/OD-4 invariant — one ApiAdapterDriver serves all OpenAI-compatible providers).
 * The chosen `model` is carried through (absent ⇒ left undefined so the provider's default model
 * resolves downstream). A `fallbackBackend` of claude-cli is attached (FD6 — the proven key-free
 * backend) so a Tier-2 override keeps the same safety net the DEFAULT map gives coding/reviewing.
 * Pure. (A bogus provider id is ignored by callers via {@link isRoleRoutingOverride}.)
 */
export function routingOverrideToBackendEntry(ov: RoleRoutingOverride): RoleBackendEntry {
  const entry: RoleBackendEntry = { backend: 'api-adapter', fallbackBackend: 'claude-cli' };
  if (ov.model !== undefined) entry.model = ov.model;
  return entry;
}

/** Runtime guard: is `v` a well-formed {@link RoleRoutingOverride} (known provider id; model optional string)? */
export function isRoleRoutingOverride(v: unknown): v is RoleRoutingOverride {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!isProviderId(o.provider)) return false;
  return o.model === undefined || typeof o.model === 'string';
}

/**
 * Merge a persisted override map ON TOP OF a base role-router config (default
 * DEFAULT_ROLE_ROUTING_CONFIG), producing a NEW {@link RoleRouterConfig} whose `roles` map has each
 * overridden role replaced by the projection of its override. Roles with no override keep the base
 * entry; an invalid override entry is skipped (defensive). Pure — does NOT mutate either input.
 * This is the bridge so the EXISTING pure {@link resolveRoleBackend} yields override > default >
 * fail-safe with no new resolution logic.
 */
export function mergeRoleRoutingOverrides(
  overrides: RoleRoutingOverrideMap | undefined,
  base: RoleRouterConfig = DEFAULT_ROLE_ROUTING_CONFIG,
): RoleRouterConfig {
  const mergedRoles: Partial<Record<Role | string, RoleBackendEntry>> = { ...(base.roles ?? {}) };
  for (const [role, ov] of Object.entries(overrides ?? {})) {
    if (isRoleRoutingOverride(ov)) mergedRoles[role as Role] = routingOverrideToBackendEntry(ov);
  }
  const out: RoleRouterConfig = { roles: mergedRoles };
  if (base.defaultBackend !== undefined) out.defaultBackend = base.defaultBackend;
  return out;
}

/**
 * Resolve a role to a {@link BackendSelection} WITH the Tier-2 persisted-override layer applied:
 *     persisted override  >  base config (default DEFAULT_ROLE_ROUTING_CONFIG)  >  fail-safe claude-cli.
 * Convenience wrapper = {@link mergeRoleRoutingOverrides} then {@link resolveRoleBackend}. Pure; the
 * override map is injected by the caller (the supervisor loads it from the RoleRoutingStore; tests
 * pass a literal). A per-dispatch `override` (highest precedence, unchanged) is still honored.
 */
export function resolveRoleBackendWithOverrides(
  role: Role | string,
  overrides: RoleRoutingOverrideMap | undefined,
  base: RoleRouterConfig = DEFAULT_ROLE_ROUTING_CONFIG,
  override?: RoleDispatchOverride,
): BackendSelection {
  return resolveRoleBackend(role, mergeRoleRoutingOverrides(overrides, base), override);
}
