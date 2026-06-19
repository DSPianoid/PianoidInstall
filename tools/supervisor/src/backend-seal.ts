/**
 * BACKEND SEAL (M4) — the ONE choke-point a Claude agent spawn goes through.
 *
 * Generalizes the EXISTING Claude seal (today scattered across profiles.ts'
 * `settingSources: ['project','local']`, cost-safety.ts' key-free assertion, and
 * buildCliArgs' deliberate "no --api-key") into a single primitive: given an agent's
 * requested {@link SessionStartOptions}, it returns the SEALED options + asserts the
 * env is billing-safe — so an UNSEALED Claude spawn is unrepresentable.
 *
 * The Claude (claude-cli) seal, faithfully reproduced (proposal §C "Seal specifics"):
 *   - settingSources forced to ['project','local'] — NEVER 'user' (the 'user' source
 *     loads the prod telegram PLUGIN, which seizes the getUpdates token; the recurring
 *     "messages don't reach me" hijack — reference_hosted_claude_plugin_token_hijack).
 *   - the env is asserted KEY-FREE (no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) via the
 *     existing {@link assertCostSafe} — REUSED, not re-implemented — so billing stays
 *     on the user's subscription.
 *   - the env is NOT mutated to add any key (Claude is key-free; the buildCliArgs path
 *     already never passes --api-key).
 *   - the channel-mute / deny-list seal: the agent never reaches the user channel; any
 *     outward-send tool is denied. The caller supplies the deny-list (the orchestrator
 *     policy's deny set); the seal MERGES the universal channel-deny names so they are
 *     always present even if the caller forgot.
 *
 * SCOPE (P1, claude-cli ONLY): this module implements ONLY the Claude (key-free) path.
 * It does NOT inject any backend key and has NO non-Claude logic — that is P2 (the
 * backend-aware foreign-key guard) and P3 (the api-adapter seal). A non-claude-cli
 * kind is REFUSED here (fail-fast) rather than silently mis-sealed.
 *
 * Pure given the inputs (the only effect is the cost-safety THROW on an unsafe env —
 * the same fail-fast the live path already performs). Dormant until activation (P6).
 *
 * Traces: proposal AP3, AP4, CP3, CP4; §C; §M M4; PART P P1.
 */

import { assertCostSafe } from './cost-safety.js';
import type { BackendKind } from './backend-kinds.js';
import type { SessionStartOptions } from './session-driver.js';

/**
 * The settingSources the Claude seal ALWAYS forces — project + local, never 'user'.
 * (Dropping 'user' deterministically prevents the prod telegram plugin from loading;
 * the user-scope methodology is folded into the system prompt by the composition root,
 * outside this seal's concern.)
 */
export const CLAUDE_SEAL_SETTING_SOURCES: ('user' | 'project' | 'local')[] = ['project', 'local'];

/**
 * The UNIVERSAL channel-mute deny-list (X4) — outward-to-third-party tool names that
 * must NEVER be reachable from a sealed agent (the supervisor owns the channel; agents
 * are channel-mute and reach the user only via the orchestrator relay). Merged into
 * whatever deny-list the caller supplies, so the channel seal can't be forgotten.
 * (Same names the orchestrator profile denies — telegram plugin + both whatsapp.)
 */
export const UNIVERSAL_CHANNEL_DENY: readonly string[] = [
  'mcp__plugin_telegram_telegram__*',
  'mcp__telegram__*',
  'mcp__whatsapp__*',
  'mcp__whatsapp-work__*',
];

/** Thrown when the seal is asked to handle a backend kind it does not implement (P1 = claude-cli only). */
export class BackendSealError extends Error {
  readonly backend: BackendKind;
  constructor(backend: BackendKind, detail: string) {
    super(`backend-seal: ${detail} (backend=${backend})`);
    this.name = 'BackendSealError';
    this.backend = backend;
  }
}

/** Options for {@link sealBackendOptions}. */
export interface SealBackendOptions {
  /** The backend kind being sealed. P1 supports ONLY 'claude-cli'. */
  backend: BackendKind;
  /** The agent's requested start options (the seal overrides the seal-relevant fields). */
  base: SessionStartOptions;
  /**
   * The env the child would inherit (asserted key-free for claude-cli). Default
   * process.env. NOT mutated — Claude is key-free, so nothing is injected. The
   * assertion THROWS (CostSafetyError) on a billing-flipping key (fail-fast).
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Apply the Claude (claude-cli) seal to a set of start options + assert the env is
 * billing-safe. Returns the SEALED options (a new object; `base` is not mutated).
 *
 * - forces settingSources = ['project','local'] (never 'user');
 * - merges the universal channel-deny names into disallowedTools (de-duped);
 * - asserts the env is key-free (REUSES assertCostSafe — throws on a billing key);
 * - leaves env key-free (NO key injected — claude-cli is subscription-billed).
 *
 * REFUSES any non-'claude-cli' backend with a {@link BackendSealError} (P1 scope:
 * the key-bearing / api-adapter paths are P2/P3, deliberately not here).
 */
export function sealBackendOptions(opts: SealBackendOptions): SessionStartOptions {
  if (opts.backend !== 'claude-cli') {
    throw new BackendSealError(
      opts.backend,
      "only the 'claude-cli' (key-free) seal is implemented in P1; key-bearing/api-adapter seals are P2/P3",
    );
  }
  const env = opts.env ?? process.env;
  // KEY-FREE ASSERTION (reuse — do not re-implement cost-safety). Throws on a billing key.
  assertCostSafe(env);

  // Merge the universal channel-deny names with any caller-supplied deny-list, de-duped.
  const mergedDeny = Array.from(new Set([...(opts.base.disallowedTools ?? []), ...UNIVERSAL_CHANNEL_DENY]));

  // Return SEALED options: force the setting sources + the merged deny-list. Everything
  // else (model, cwd, allowedTools, bootstrapTurns, onPermission, systemPrompt …) is
  // carried through unchanged. NO env mutation (Claude stays key-free).
  return {
    ...opts.base,
    settingSources: [...CLAUDE_SEAL_SETTING_SOURCES],
    disallowedTools: mergedDeny,
  };
}

/**
 * Assert a set of start options is SEALED for claude-cli (the seal invariants hold).
 * A cheap structural re-check the registry/launcher can call defensively after
 * sealing (and tests assert against). Returns the offending reasons (empty = sealed).
 * Does NOT inspect the env (that is {@link sealBackendOptions}'s assertCostSafe).
 */
export function inspectClaudeSeal(o: SessionStartOptions): { sealed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const sources = o.settingSources ?? [];
  if (sources.includes('user')) reasons.push("settingSources includes 'user' (the plugin-hijack source)");
  if (!sources.includes('project') || !sources.includes('local')) {
    reasons.push("settingSources must be exactly ['project','local']");
  }
  const deny = o.disallowedTools ?? [];
  for (const name of UNIVERSAL_CHANNEL_DENY) {
    if (!deny.includes(name)) reasons.push(`disallowedTools missing universal channel-deny: ${name}`);
  }
  return { sealed: reasons.length === 0, reasons };
}
