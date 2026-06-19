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
