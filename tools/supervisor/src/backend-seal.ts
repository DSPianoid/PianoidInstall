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
 * SCOPE (now P2+P3): BOTH seal paths are implemented.
 *   - claude-cli (P1): forces settingSources ['project','local'], merges the channel-deny,
 *     asserts the env is KEY-FREE (subscription billing). UNCHANGED from P1 — byte-for-byte.
 *   - api-adapter (P3, dormant): NOT Claude Code → NO settingSources/plugin surface. The seal =
 *     channel-mute (merge the universal channel-deny, defensive) + the BACKEND-AWARE foreign-key
 *     guard (P2 / M4 full): the env must carry ONLY this backend's own metered key (e.g.
 *     DEEPSEEK_API_KEY) and NO foreign billing key. The key is NOT injected into the options here
 *     (the api-adapter driver reads it from the env, like deepseek-codegen-mcp); the seal only
 *     ASSERTS the scoping. An api-adapter agent has no FS/git tool surface by default (OD-5).
 *
 * Pure given the inputs (the only effect is the cost-safety THROW on an unsafe env —
 * the same fail-fast the live path already performs). Dormant until activation (P6).
 *
 * Traces: proposal AP3, AP4, CP3, CP4; §C; §M M4; PART P P1, P2, P3.
 */

import { assertCostSafe, assertBackendCostSafe } from './cost-safety.js';
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
  /** The backend kind being sealed. 'claude-cli' (key-free) or 'api-adapter' (own-key-scoped). */
  backend: BackendKind;
  /** The agent's requested start options (the seal overrides the seal-relevant fields). */
  base: SessionStartOptions;
  /**
   * The env the child/turn would use. Default process.env. NOT mutated by the seal:
   *   - claude-cli: asserted key-free (subscription); nothing injected.
   *   - api-adapter: asserted to carry ONLY this backend's own key (no foreign billing key).
   * The assertion THROWS (CostSafetyError / BackendCostSafetyError) on an unsafe env (fail-fast).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * For an 'api-adapter' backend ONLY: the env var name of this backend's OWN metered key
   * (e.g. 'DEEPSEEK_API_KEY'). Used by the backend-aware guard to treat that one key as
   * legitimate while every Anthropic key + every OTHER api-adapter key is foreign (must be
   * absent). Ignored for claude-cli (it is subscription-billed — no own secret).
   */
  ownSecretName?: string;
}

/**
 * Apply the backend's seal to a set of start options + assert the env is billing/secret-safe.
 * Returns the SEALED options (a new object; `base` is not mutated). Dispatches by backend kind:
 *   - 'claude-cli' → {@link sealClaudeOptions} (UNCHANGED from P1).
 *   - 'api-adapter' → {@link sealApiAdapterOptions} (P3).
 * Any other (future) kind is REFUSED with a {@link BackendSealError} (fail-fast, never mis-sealed).
 */
export function sealBackendOptions(opts: SealBackendOptions): SessionStartOptions {
  if (opts.backend === 'claude-cli') return sealClaudeOptions(opts);
  if (opts.backend === 'api-adapter') return sealApiAdapterOptions(opts);
  throw new BackendSealError(opts.backend, 'no seal implemented for this backend kind');
}

/**
 * The Claude (claude-cli) seal — UNCHANGED from P1 (byte-for-byte behavior):
 * - forces settingSources = ['project','local'] (never 'user');
 * - merges the universal channel-deny names into disallowedTools (de-duped);
 * - asserts the env is key-free (REUSES assertCostSafe — throws on a billing key);
 * - leaves env key-free (NO key injected — claude-cli is subscription-billed).
 */
export function sealClaudeOptions(opts: SealBackendOptions): SessionStartOptions {
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
 * The api-adapter seal (P3, dormant) — NOT Claude Code, so NO settingSources/plugin surface:
 * - merges the universal channel-deny names into disallowedTools (defensive channel-mute — an
 *   api-adapter has no tools by default (OD-5), but the deny keeps the seal uniform and prevents
 *   a future tool-granted api-adapter from reaching the channel);
 * - asserts BACKEND-AWARE cost/secret safety (P2 / M4 full): the env must carry ONLY this
 *   backend's own metered key (`ownSecretName`) and NO foreign billing key — REUSES
 *   {@link assertBackendCostSafe} (throws {@link BackendCostSafetyError} on a foreign key);
 * - does NOT force settingSources (leaves them as the caller set, typically undefined — a bare
 *   API turn loads no project skills/CLAUDE.md/plugins);
 * - does NOT inject the key into options.env — the api-adapter driver reads `ownSecretName` from
 *   the process env (the deepseek-codegen-mcp precedent: key from env only, never in args).
 *
 * NOTE: a MISSING own key is NOT a seal failure (assertBackendCostSafe does not throw on it) —
 * the driver surfaces a clean "key not set" error at call time. The seal only blocks FOREIGN keys.
 */
export function sealApiAdapterOptions(opts: SealBackendOptions): SessionStartOptions {
  const env = opts.env ?? process.env;
  // BACKEND-AWARE scoping assertion (P2). Throws on any foreign billing/credential key.
  assertBackendCostSafe('api-adapter', env, opts.ownSecretName);

  // Channel-mute (defensive): merge the universal channel-deny names, de-duped.
  const mergedDeny = Array.from(new Set([...(opts.base.disallowedTools ?? []), ...UNIVERSAL_CHANNEL_DENY]));

  // Return SEALED options: the merged deny-list; settingSources left as-is (NOT forced — not Claude
  // Code). Everything else carried through unchanged. NO env mutation (key read from env by driver).
  return {
    ...opts.base,
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
