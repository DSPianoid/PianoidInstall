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
 *   - reviewing → api-adapter, model 'gpt-5-codex' (second-opinion; OD-4 Codex=OpenAI-API) — P4.
 *
 * DORMANT: this map is consumed ONLY when role-routing is activated (P6); the default-OFF switch
 * (SUPERVISOR_ROLE_ROUTING) gates whether the composition root EVER dispatches. The router itself
 * is pure and always resolves; this constant is the data it resolves against. Models pin to the
 * same ids the backend-registry's api-adapter config map keys on (DeepSeek=coding config).
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
