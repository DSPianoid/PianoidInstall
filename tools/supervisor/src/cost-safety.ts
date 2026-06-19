/**
 * COST-SAFETY GUARD — the user's hard constraint, made a STRUCTURAL guarantee.
 *
 * The hosted Claude session MUST draw from the user's Claude subscription (Claude
 * Max), NOT the pay-per-token Platform API. Billing is credential-driven: the CLI
 * and the Agent SDK both authenticate via the subscription OAuth login UNLESS an
 * API key is present in the environment — an `ANTHROPIC_API_KEY` (or
 * `ANTHROPIC_AUTH_TOKEN`) is the ONE thing that flips a child to paid API billing.
 *
 * (Confirmed: the architecture review proved `claude -p` reports
 * `apiKeySource:"none"` on this machine, and Anthropic's own support article states
 * the Agent SDK works with a Claude subscription, not API keys. The planned
 * June-2026 SDK/`-p` billing split is PAUSED. So keeping the env key-free keeps the
 * session on the subscription.)
 *
 * The supervisor's own invariant (enforced elsewhere by construction): it never
 * SETS these keys and never injects `apiKey` into `query()` / `--api-key` into
 * `claude -p`. This module is the BELT to that suspenders — it refuses to start a
 * billed child if a key is ALREADY present in the inherited environment (e.g. a
 * developer exported one in their shell), converting a silent surprise-bill into a
 * loud fail-fast.
 *
 * Concern (one job): inspect an env map for billing-flipping keys + report. No SDK,
 * no spawn, no I/O. Pure given the env map → fully unit-testable.
 *
 * SECRET HYGIENE: this module NEVER logs or echoes a key's VALUE — only the fact
 * that a named variable is present.
 */

/**
 * Environment variables whose presence flips Claude usage from the subscription to
 * the pay-per-token Platform API. If ANY is set (to a non-empty value) in the env a
 * Claude child would inherit, that child bills the API.
 */
export const BILLING_FLIPPING_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** The result of inspecting an environment for billing-flipping keys. */
export interface CostSafetyResult {
  /** True when the env is safe (no billing-flipping key present) → subscription billing. */
  ok: boolean;
  /** Names (NOT values) of any billing-flipping vars found set to a non-empty value. */
  offending: string[];
}

/**
 * Inspect an environment map for billing-flipping keys. A variable counts as
 * "present" only if it is set to a NON-EMPTY string (an empty/whitespace value
 * does not authenticate, so it cannot flip billing — and `env.FOO=''` is a common
 * "unset" idiom). Pure.
 */
export function inspectCostSafety(env: NodeJS.ProcessEnv = process.env): CostSafetyResult {
  const offending: string[] = [];
  for (const name of BILLING_FLIPPING_ENV_VARS) {
    const v = env[name];
    if (typeof v === 'string' && v.trim().length > 0) offending.push(name);
  }
  return { ok: offending.length === 0, offending };
}

/**
 * Build the human-facing refusal message for a set of offending var names.
 * Exported so the message is asserted by a test (and identical wherever it surfaces).
 */
export function costSafetyRefusalMessage(offending: string[]): string {
  const names = offending.join(', ');
  return (
    `Refusing to start the hosted Claude session: ${names} ` +
    `${offending.length === 1 ? 'is' : 'are'} set in the environment. ` +
    `An Anthropic API key in the environment would bill Claude usage to the ` +
    `pay-per-token Platform API instead of your Claude subscription. ` +
    `Unset ${offending.length === 1 ? 'it' : 'them'} ` +
    `(e.g. \`unset ${offending.join(' ')}\` / \`Remove-Item Env:${offending.join(',Env:')}\`) ` +
    `to proceed on the subscription.`
  );
}

/**
 * Enforce the cost-safety invariant: THROW if the given env contains a
 * billing-flipping key. Call at supervisor startup BEFORE spawning the Claude
 * child (which inherits this env). Returns the (safe) result on success so callers
 * can log the green path. Never logs/echoes a key value.
 */
export function assertCostSafe(env: NodeJS.ProcessEnv = process.env): CostSafetyResult {
  const result = inspectCostSafety(env);
  if (!result.ok) throw new CostSafetyError(result.offending);
  return result;
}

/** Thrown by {@link assertCostSafe} when a billing-flipping key is present. */
export class CostSafetyError extends Error {
  readonly offending: string[];
  constructor(offending: string[]) {
    super(costSafetyRefusalMessage(offending));
    this.name = 'CostSafetyError';
    this.offending = offending;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * BACKEND-AWARE cost/secret guard (model-agnostic agents — proposal P2 / M4 full,
 * OD-1 USER-APPROVED per-backend key scoping). FD5: at spawn, assert the env carries
 * the agent's OWN backend key (if any) and NO OTHER backend's billing key.
 *
 * ADDITIVE — does NOT change anything above. The live cli-stream orchestrator path
 * keeps calling {@link assertCostSafe} (the strict "no Anthropic key, ever" guard),
 * which is byte-for-byte unchanged. This new layer is consumed ONLY by the (dormant,
 * default-OFF) backend-seal choke-point for routed agents.
 *
 * The model:
 *   - claude-cli is SUBSCRIPTION-billed → its env must be Anthropic-key-free (the same
 *     invariant assertCostSafe enforces) AND must not carry a FOREIGN backend's key
 *     (a stray DEEPSEEK_API_KEY/OPENAI_API_KEY does not flip Claude billing, but it is
 *     a credential the claude agent has no business holding — leak hygiene, CP3/CP4).
 *   - an api-adapter backend (DeepSeek/Codex) is METERED on its OWN key → its env MUST
 *     carry ONLY that one key (so the call authenticates) and NO foreign billing key:
 *     no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN (would never bill the api-adapter, but
 *     a Claude key must never ride in a non-Claude agent's env), and no OTHER
 *     api-adapter backend's key (DeepSeek's env must not carry OPENAI_API_KEY, etc.).
 *
 * Pure given the env map → fully unit-testable. NEVER logs/echoes a key VALUE.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A backend kind for the purposes of the cost guard (kept local to avoid a cycle with backend-kinds). */
export type CostBackendKind = 'claude-cli' | 'api-adapter';

/**
 * The complete set of metered/billing-flipping API-key env var names this guard knows
 * about, keyed by the backend that LEGITIMATELY owns each. Used to compute, for any
 * given backend, which keys are FOREIGN (must be absent). Anthropic keys are owned by
 * NO api-adapter — they are the subscription-flipping keys (always foreign to a routed
 * agent's env unless that agent IS the subscription-billed claude-cli, which still must
 * stay key-free). Extend this map when a new api-adapter backend is added (e.g. a future
 * Anthropic-API adapter), NOT the claude-cli subscription path.
 */
export const BACKEND_SECRET_ENV_VARS = {
  /** DeepSeek (api-adapter) — the coding backend (proposal coding=DeepSeek). */
  deepseek: 'DEEPSEEK_API_KEY',
  /** OpenAI / Codex (api-adapter) — the reviewing backend (proposal OD-4 Codex=OpenAI-API). */
  openai: 'OPENAI_API_KEY',
} as const;

/** Every known api-adapter secret env var name (the values of {@link BACKEND_SECRET_ENV_VARS}). */
export const ALL_BACKEND_SECRET_ENV_VARS: readonly string[] = Object.values(BACKEND_SECRET_ENV_VARS);

/** True iff `name` is set to a NON-EMPTY (non-whitespace) value in `env` (the same "present" test as inspectCostSafety). */
function isEnvVarPresent(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

/** The result of inspecting an env for backend-aware cost/secret safety. */
export interface BackendCostSafetyResult {
  /** True when the env is safe for this backend (own key present if required; NO foreign key). */
  ok: boolean;
  /**
   * Foreign billing/credential key NAMES (NOT values) found present that this backend must NOT carry
   * (an Anthropic key in any routed agent's env, or another backend's metered key).
   */
  foreign: string[];
  /**
   * For an api-adapter backend with a required own-secret: true iff that own secret is ABSENT.
   * (A missing own key is NOT a cost-safety FAILURE — the call will simply fail to authenticate and
   * surface a clean error — so it does NOT set ok=false here; it is reported so the seal/driver can
   * decide. claude-cli has no own secret, so this is always false for it.)
   */
  ownSecretMissing: boolean;
  /** The own-secret env var name for this backend, if it has one (api-adapter), else undefined. */
  ownSecretName?: string;
}

/**
 * Inspect an env map for BACKEND-AWARE cost/secret safety. Pure.
 *
 * @param backend     the backend kind the env is being prepared for.
 * @param env         the env the child would inherit (default process.env).
 * @param ownSecretName for an api-adapter, the env var name of its OWN metered key (e.g.
 *                    'DEEPSEEK_API_KEY'). Required to know which api-adapter key is legitimate;
 *                    every OTHER known api-adapter key + every Anthropic key is then foreign.
 *                    Ignored for claude-cli (it has no own secret — subscription-billed).
 *
 * Rules:
 *   - claude-cli: foreign = ALL Anthropic billing keys ({@link BILLING_FLIPPING_ENV_VARS}) present
 *     + ALL known api-adapter secrets present (a claude agent must hold no metered key at all).
 *   - api-adapter: foreign = ALL Anthropic billing keys present + every known api-adapter secret
 *     present EXCEPT `ownSecretName`. ownSecretMissing = (ownSecretName given && that key absent).
 */
export function inspectBackendCostSafety(
  backend: CostBackendKind,
  env: NodeJS.ProcessEnv = process.env,
  ownSecretName?: string,
): BackendCostSafetyResult {
  const foreign: string[] = [];

  // Anthropic billing keys are foreign to EVERY routed agent's env (claude-cli stays key-free on the
  // subscription; a non-Claude agent must never carry a Claude key).
  for (const name of BILLING_FLIPPING_ENV_VARS) {
    if (isEnvVarPresent(env, name)) foreign.push(name);
  }

  // Every known api-adapter secret is foreign UNLESS it is THIS backend's own secret.
  for (const name of ALL_BACKEND_SECRET_ENV_VARS) {
    if (name === ownSecretName) continue; // the backend's legitimate own key
    if (isEnvVarPresent(env, name)) foreign.push(name);
  }

  const ownSecretMissing =
    backend === 'api-adapter' && !!ownSecretName ? !isEnvVarPresent(env, ownSecretName) : false;

  const result: BackendCostSafetyResult = {
    ok: foreign.length === 0,
    foreign,
    ownSecretMissing,
  };
  if (ownSecretName !== undefined) result.ownSecretName = ownSecretName;
  return result;
}

/** Build the human-facing refusal message for a backend that carries a FOREIGN billing/credential key. Names only, never values. */
export function backendCostSafetyRefusalMessage(backend: CostBackendKind, foreign: string[]): string {
  const names = foreign.join(', ');
  return (
    `Refusing to spawn a '${backend}' agent: ${names} ` +
    `${foreign.length === 1 ? 'is' : 'are'} present in the agent's environment. ` +
    `A '${backend}' agent must carry ONLY its own backend credential and NO foreign billing key ` +
    `(an Anthropic key would bill the Claude subscription path, and another backend's metered key ` +
    `must never leak into this agent's env). ` +
    `Unset ${foreign.length === 1 ? 'it' : 'them'} before spawning this backend.`
  );
}

/** Thrown by {@link assertBackendCostSafe} when a FOREIGN billing/credential key is present in a backend's env. */
export class BackendCostSafetyError extends Error {
  readonly backend: CostBackendKind;
  readonly foreign: string[];
  constructor(backend: CostBackendKind, foreign: string[]) {
    super(backendCostSafetyRefusalMessage(backend, foreign));
    this.name = 'BackendCostSafetyError';
    this.backend = backend;
    this.foreign = foreign;
  }
}

/**
 * Enforce the BACKEND-AWARE cost/secret invariant: THROW {@link BackendCostSafetyError} if the env
 * carries any FOREIGN billing/credential key for this backend. Returns the (safe) inspection result
 * on success so callers can log the green path + see ownSecretMissing. Never logs/echoes a key value.
 *
 * NOTE on a missing own key: this does NOT throw when an api-adapter's own secret is absent — that is
 * not a billing-safety breach (the call just fails to authenticate, surfacing a clean error from the
 * driver). The result's `ownSecretMissing` flag reports it for the caller to handle.
 *
 * This is ADDITIVE: the live cli-stream path uses {@link assertCostSafe} (unchanged), not this.
 */
export function assertBackendCostSafe(
  backend: CostBackendKind,
  env: NodeJS.ProcessEnv = process.env,
  ownSecretName?: string,
): BackendCostSafetyResult {
  const result = inspectBackendCostSafety(backend, env, ownSecretName);
  if (!result.ok) throw new BackendCostSafetyError(backend, result.foreign);
  return result;
}
