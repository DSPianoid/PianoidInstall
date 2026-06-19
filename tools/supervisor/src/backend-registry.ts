/**
 * BACKEND REGISTRY + DRIVER FACTORY (M3) — given a {@link BackendSelection}, construct
 * the concrete {@link SessionDriver} for that backend kind.
 *
 * One registry keyed by backend kind. Adding a backend = one registry entry + its
 * driver. For 'claude-cli' it REUSES the existing {@link CliStreamDriver} (which
 * already satisfies the contract — the proposal's "reuse, not reinvent"). The
 * 'api-adapter' slot is DECLARED for the taxonomy but UNIMPLEMENTED in P1 (it throws
 * a clear error if selected) — its driver is P3/P4.
 *
 * The driver factory is INJECTABLE so tests construct a fake driver (no real spawn /
 * no network / no process) and assert the registry routes by kind. The default
 * claude-cli factory builds a real CliStreamDriver, but its OWN spawn is injectable
 * (CliStreamDriverOptions.spawnFn) — so even the real driver never spawns `claude`
 * in a test.
 *
 * Concern (P2 = one job): MAP a selection → a driver instance. It does NOT seal the
 * options (that is M4 / backend-seal) and does NOT run the agent (that is M6 / the
 * relay + the lifecycle). Pure construction.
 *
 * Traces: proposal AP1, AP2, AP4, CP6; §M M3; PART P P1.
 */

import { CliStreamDriver, type CliStreamDriverOptions } from './adapters/cli-stream-driver.js';
import type { BackendKind, BackendSelection } from './backend-kinds.js';
import type { SessionDriver } from './session-driver.js';

/** A factory that builds a {@link SessionDriver} for a resolved selection. */
export type BackendDriverFactory = (selection: BackendSelection) => SessionDriver;

/** Thrown when a backend kind has no registered (implemented) driver factory. */
export class BackendRegistryError extends Error {
  readonly backend: BackendKind;
  constructor(backend: BackendKind, detail: string) {
    super(`backend-registry: ${detail} (backend=${backend})`);
    this.name = 'BackendRegistryError';
    this.backend = backend;
  }
}

/** Options to build the default registry. */
export interface BackendRegistryOptions {
  /**
   * Options forwarded to the default {@link CliStreamDriver} (esp. `spawnFn` so tests
   * inject a fake child, and `onStderr` for diagnostics). The claude-cli factory builds
   * `new CliStreamDriver(cliStreamOptions)`.
   */
  cliStreamOptions?: CliStreamDriverOptions;
  /**
   * Override/extend the per-kind factory map. A test can supply a 'claude-cli' factory
   * that returns a fake driver (so NO CliStreamDriver / NO spawn is constructed at all).
   * Any kind present here wins over the built-in factory for that kind.
   */
  factories?: Partial<Record<BackendKind, BackendDriverFactory>>;
}

/**
 * The backend registry: keyed by backend kind, constructs a SessionDriver for a
 * resolved selection. Built-in: 'claude-cli' → a real CliStreamDriver (spawn
 * injectable). 'api-adapter' → unimplemented in P1 (throws) unless a factory is
 * injected. Inject `factories['claude-cli']` to substitute a fake driver in tests.
 */
export class BackendRegistry {
  private readonly factories: Map<BackendKind, BackendDriverFactory> = new Map();

  constructor(opts: BackendRegistryOptions = {}) {
    // Built-in claude-cli factory — REUSE CliStreamDriver (its spawn is injectable).
    const cliStreamOptions = opts.cliStreamOptions;
    this.factories.set('claude-cli', () => new CliStreamDriver(cliStreamOptions ?? {}));
    // 'api-adapter' is intentionally NOT registered in P1 (no non-Claude backend yet);
    // selecting it throws a clear BackendRegistryError unless a factory is injected.

    // Caller/test overrides win (e.g. a fake claude-cli driver for the integration test).
    for (const [kind, factory] of Object.entries(opts.factories ?? {})) {
      if (factory) this.factories.set(kind as BackendKind, factory);
    }
  }

  /** Is there an (implemented) driver factory for this backend kind? */
  has(kind: BackendKind): boolean {
    return this.factories.has(kind);
  }

  /**
   * Construct the concrete SessionDriver for a resolved selection. Throws a
   * {@link BackendRegistryError} if the selection's backend kind has no factory
   * (e.g. 'api-adapter' in P1).
   */
  create(selection: BackendSelection): SessionDriver {
    const factory = this.factories.get(selection.backend);
    if (!factory) {
      throw new BackendRegistryError(
        selection.backend,
        selection.backend === 'api-adapter'
          ? "the 'api-adapter' driver is not implemented in P1 (DeepSeek/Codex are P3/P4)"
          : 'no driver factory registered for this backend kind',
      );
    }
    return factory(selection);
  }
}
