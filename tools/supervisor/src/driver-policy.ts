/**
 * DRIVER SELECTION POLICY — the pure decision of which structured SessionDriver
 * backs the hosted session, mirroring the transport-policy pattern (a pure,
 * unit-tested decision separate from the side-effecting composition root).
 *
 * Both choices are STRUCTURED and run on the user's Claude SUBSCRIPTION (the
 * cost-safety guard enforces a key-free env):
 *   - 'sdk' (DEFAULT)  — the in-process Agent SDK `query()` driver. Gives the
 *                        orchestrator its in-process channel reply tool + the
 *                        in-process `canUseTool` permission router. The recommended
 *                        primary per the 2026-06-17 architecture review.
 *   - 'cli-stream'     — the `claude -p --output-format stream-json` HEDGE: the same
 *                        structured schema via the CLI. A billing-mode/mechanism
 *                        hedge, selectable behind the same seam.
 *
 * The PTY/TUI screen-scrape driver was RETIRED by that review (it recovered machine
 * state from a human render → an unbounded edge-case stack). It is NOT selectable.
 *
 * Precedence: an explicit `--driver <x>` argv value wins; else `SUPERVISOR_DRIVER`;
 * else the default 'sdk'. Any unrecognized value falls back to 'sdk' (fail-safe to
 * the recommended driver, never to the retired scraper).
 */

export type DriverName = 'sdk' | 'cli-stream';

export const DEFAULT_DRIVER: DriverName = 'sdk';
export const SELECTABLE_DRIVERS: readonly DriverName[] = ['sdk', 'cli-stream'];

/** Is `v` a selectable driver name? */
export function isDriverName(v: unknown): v is DriverName {
  return typeof v === 'string' && (SELECTABLE_DRIVERS as readonly string[]).includes(v);
}

/**
 * Resolve the driver from an explicit argv value and/or the SUPERVISOR_DRIVER env,
 * defaulting to 'sdk'. Unrecognized inputs fall back to the default (never to a
 * retired/unknown driver). Pure.
 */
export function resolveDriverSelection(opts: {
  argvDriver?: string;
  envDriver?: string;
  profileDefault?: DriverName;
}): DriverName {
  if (isDriverName(opts.argvDriver)) return opts.argvDriver;
  if (isDriverName(opts.envDriver)) return opts.envDriver;
  if (isDriverName(opts.profileDefault)) return opts.profileDefault;
  return DEFAULT_DRIVER;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR DRIVER SELECTION BY MODEL (model-agnostic-orchestrator Tier-1, piece #3)
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Which structured driver backs the HOSTED ORCHESTRATOR, decided by the orchestrator's OWN
 * model (proposal model-agnostic-orchestrator-tier1-2026-06-22 §3.3, piece #3):
 *   - 'cli-stream'         — a CLAUDE model id → today's proven default (`claude -p` stream-json,
 *                            the ONLY backend exposing agent-teams the orchestrator skill needs).
 *   - 'multi-turn-adapter' — a NON-Claude (OpenAI-compatible) provider model id → the
 *                            {@link MultiTurnAdapterDriver} (multi-turn + tool-call loop +
 *                            the supervisor-mediated coordinate tools that REPLACE teams).
 *
 * This is DISTINCT from {@link DriverName} (the Claude-tier sdk/cli-stream I/O selector): it
 * decides whether the orchestrator runs on Claude-Code-via-CLI at all, or on the non-Claude
 * adapter. The two compose — when this resolves to 'cli-stream', the {@link DriverName} machinery
 * (argv/env/profile) still picks sdk-vs-cli-stream as today (in practice the orchestrator profile
 * pins cli-stream for teams).
 */
export type OrchestratorDriverKind = 'cli-stream' | 'multi-turn-adapter';

/** Today's default orchestrator driver — the proven Claude `claude -p` path (CP5: Claude stays the default). */
export const DEFAULT_ORCHESTRATOR_DRIVER: OrchestratorDriverKind = 'cli-stream';

/**
 * Is `model` a CLAUDE model id? The orchestrator's Claude models are the `claude-*` family
 * (e.g. `claude-opus-4-8[1m]`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Case-insensitive,
 * tolerant of surrounding whitespace. Pure. An empty/undefined model is NOT Claude here (the
 * caller decides the default separately — see {@link resolveOrchestratorDriver}).
 */
export function isClaudeModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('claude');
}

/**
 * Resolve the orchestrator driver from the orchestrator's model id. PURE — a side-effect-free
 * decision, mirroring {@link resolveDriverSelection} and the role-router's model→backend map.
 *
 * The decision (FAIL-SAFE to the proven Claude default, CP5):
 *   - A CLAUDE model id ({@link isClaudeModel}) → 'cli-stream' (today's default — byte-for-byte).
 *   - A NON-Claude model id that `isNonClaudeModel` recognizes as a wired provider model →
 *     'multi-turn-adapter' (the only path that can drive a non-Claude orchestrator).
 *   - ANYTHING ELSE (undefined / empty / an unrecognized string) → the Claude default
 *     'cli-stream'. This is deliberate: an unknown/typo'd id falls back to the SAFE, proven
 *     path — the untested non-Claude adapter is NEVER reached by accident. The non-Claude path
 *     is selected ONLY for a model the registry actually knows (so its baseUrl/key are resolvable).
 *
 * `isNonClaudeModel` is injected (default = membership in the provider registry's known model
 * ids) so this module stays free of a direct provider-registry import and tests can pin it.
 */
export function resolveOrchestratorDriver(
  model: string | undefined,
  isNonClaudeModel: (model: string) => boolean = () => false,
): OrchestratorDriverKind {
  if (isClaudeModel(model)) return 'cli-stream';
  if (typeof model === 'string' && model.trim().length > 0 && isNonClaudeModel(model.trim())) {
    return 'multi-turn-adapter';
  }
  // Unknown / empty / unrecognized → the proven Claude default (never an untested non-Claude path).
  return DEFAULT_ORCHESTRATOR_DRIVER;
}
