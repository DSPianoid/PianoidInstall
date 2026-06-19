/**
 * BACKEND KINDS + ROLES — the routing taxonomy for the model-agnostic agent system
 * (proposal model-agnostic-agents-2026-06-19, §C Classification + M1).
 *
 * Pure types + const descriptors. NO runtime behavior, NO I/O, NO existing path
 * touched. This is the P0 "lock the contract" deliverable: it names the backend
 * kinds an agent can resolve to, the role keys the router maps from, and each
 * backend's default {@link BackendCapabilities}. Everything downstream (the router,
 * the registry, the seal) keys off these.
 *
 * SCOPE NOTE (P0+P1 only): the `claude-cli` backend is the only one wired in P1
 * (it REUSES the existing CliStreamDriver). The `api-adapter` kind is declared here
 * for the taxonomy + its capability descriptor, but NO api-adapter driver/seal is
 * built in P0/P1 (that is P3/P4 — DeepSeek/Codex, awaiting paid-spend + per-backend
 * key decisions). Declaring the kind now keeps the type space complete without
 * adding any key-bearing or non-Claude runtime.
 *
 * Traces: proposal §C (Backend-kind taxonomy, Role taxonomy), M1; AP1/AP2; CP1/CP2/CP6.
 */

import type { BackendCapabilities } from './session-driver.js';

/**
 * The execution shape an agent's backing model resolves to.
 *   - 'claude-cli'  — Claude via `claude -p` stream-json (REUSEs CliStreamDriver).
 *   - 'api-adapter' — an OpenAI-compatible HTTPS backend (DeepSeek, Codex/OpenAI).
 *                     DECLARED here for the taxonomy; NOT constructed until P3/P4.
 */
export type BackendKind = 'claude-cli' | 'api-adapter';

/** All backend kinds in the taxonomy (declaration order). */
export const BACKEND_KINDS: readonly BackendKind[] = ['claude-cli', 'api-adapter'];

/** Is `v` a known backend kind? */
export function isBackendKind(v: unknown): v is BackendKind {
  return typeof v === 'string' && (BACKEND_KINDS as readonly string[]).includes(v);
}

/**
 * The routing keys — the ROLE an orchestrator names when it dispatches work. DATA,
 * hot-swappable via config (the initial map lives in {@link DEFAULT_ROLE_BACKENDS}).
 * 'planning' is the only role exercised end-to-end in P1 (→ claude-cli).
 */
export type Role = 'planning' | 'coding' | 'reviewing';

/** All roles in the taxonomy (declaration order). */
export const ROLES: readonly Role[] = ['planning', 'coding', 'reviewing'];

/** Is `v` a known role? */
export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/**
 * The FAIL-SAFE default backend kind — any unmapped/unknown role resolves here
 * (proposal D-B: "fail-safe default = claude-cli"; the proven, key-free backend).
 */
export const DEFAULT_BACKEND_KIND: BackendKind = 'claude-cli';

/**
 * Per-backend DEFAULT capability descriptors (M1). A descriptor declares what a
 * backend can do so the runtime wires it correctly (e.g. FD4 skips permission
 * routing for a backend that has no tool surface).
 *
 * - claude-cli: a full Claude Code session — tools, permission routing, resume, AND
 *   agent-teams (the reason the orchestrator profile defaults to cli-stream).
 * - api-adapter (P3/P4, dormant): a bare compute-in/text-out turn — NO tools, NO
 *   permission surface, NO teams (proposal OD-5 "pure compute-in/text-out for v1").
 *   Resume is backend-specific; default false (a stateless chat/completions call).
 */
export const BACKEND_CAPABILITIES: Readonly<Record<BackendKind, BackendCapabilities>> = {
  'claude-cli': {
    supportsTools: true,
    supportsPermissionRouting: true,
    supportsResume: true,
    supportsTeams: true,
  },
  'api-adapter': {
    supportsTools: false,
    supportsPermissionRouting: false,
    supportsResume: false,
    supportsTeams: false,
  },
};

/** Look up a backend kind's default capability descriptor. */
export function capabilitiesFor(kind: BackendKind): BackendCapabilities {
  return BACKEND_CAPABILITIES[kind];
}

/**
 * A resolved routing decision: which backend kind + (optional) model a role maps to,
 * plus an optional fallback backend (FD6, used from P3 on). Produced by the
 * role-router (M2), consumed by the backend-registry (M3). Pure data.
 */
export interface BackendSelection {
  /** The role that was resolved (echoed for logging/attribution). */
  role: Role | string;
  /** The backend kind to construct a driver for. */
  backend: BackendKind;
  /** Optional model id to pin (driver-specific; claude-cli → e.g. 'claude-opus-4-8[1m]'). */
  model?: string;
  /**
   * Optional fallback backend if this one fails (FD6). Declared for the taxonomy;
   * the fallback EXECUTION is a later phase (P5). Not used by P1.
   */
  fallbackBackend?: BackendKind;
}
