/**
 * TRANSPORT POLICY — the loopback-safety decision, as a PURE, testable function.
 *
 * This is the single most safety-critical rule in the supervisor (review TG2):
 * a real grammY getUpdates poller may start ONLY when BOTH (a) `--live` is
 * requested AND (b) a DEDICATED `SUPERVISOR_TELEGRAM_TOKEN` is provided. In every
 * other case the decision is `loopback` (in-memory, no network), so the running
 * orchestrator's production poller is never 409-severed.
 *
 * Crucially, this function NEVER reads the production `TELEGRAM_BOT_TOKEN` — it
 * takes only `{ live, dedicatedToken }`. The production token therefore cannot
 * reach a transport through this path (review TG3): there is no code here that
 * could pass it to grammY.
 *
 * `index.ts` maps the returned decision to an actual transport instance; keeping
 * the decision pure means the safety property is unit-tested directly, not left
 * to README prose.
 */

/** The transport the supervisor should construct. */
export type TransportKind = 'loopback' | 'grammy';

export interface TransportDecision {
  kind: TransportKind;
  /** The dedicated token to use when kind === 'grammy' (never the production one). */
  token?: string;
  /** Human-readable reason for the decision (logged by the entrypoint). */
  reason: string;
  /** True when a live poller was requested but refused (operator should know). */
  refusedLive: boolean;
}

export interface TransportPolicyInput {
  /** Whether `--live` was passed on the CLI. */
  live: boolean;
  /**
   * The DEDICATED token (`SUPERVISOR_TELEGRAM_TOKEN`). Deliberately NOT the
   * production `TELEGRAM_BOT_TOKEN` — the caller must pass the dedicated one (or
   * undefined). This function never sees the production secret.
   */
  dedicatedToken?: string;
}

/**
 * Decide which transport to use. Pure: same input → same output, no I/O.
 *
 *  - !live                        → loopback (safe default)
 *  - live && !dedicatedToken      → loopback (REFUSED — won't poll the prod token)
 *  - live && dedicatedToken       → grammy (on the dedicated token only)
 */
export function resolveTransportDecision(input: TransportPolicyInput): TransportDecision {
  if (!input.live) {
    return {
      kind: 'loopback',
      reason: 'loopback transport (safe default — no --live, no live poller)',
      refusedLive: false,
    };
  }
  if (!input.dedicatedToken) {
    return {
      kind: 'loopback',
      reason:
        '--live requested but SUPERVISOR_TELEGRAM_TOKEN is unset; refusing to poll the ' +
        'production token. Falling back to loopback.',
      refusedLive: true,
    };
  }
  return {
    kind: 'grammy',
    token: input.dedicatedToken,
    reason: 'live grammY transport on the DEDICATED token',
    refusedLive: false,
  };
}
