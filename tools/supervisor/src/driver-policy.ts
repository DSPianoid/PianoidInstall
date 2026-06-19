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
