/**
 * BACKEND REGISTRY + DRIVER FACTORY (M3) — given a {@link BackendSelection}, construct
 * the concrete {@link SessionDriver} for that backend kind.
 *
 * One registry keyed by backend kind. Adding a backend = one registry entry + its
 * driver. For 'claude-cli' it REUSES the existing {@link CliStreamDriver} (which
 * already satisfies the contract — the proposal's "reuse, not reinvent"). For
 * 'api-adapter' (P3) it constructs an {@link ApiAdapterDriver} parameterized by the
 * backend's {@link ApiAdapterConfig} (base-URL/model/secret-name), resolved from the
 * selection's `model` via an injectable config map (default: DeepSeek = coding).
 *
 * The driver factory is INJECTABLE so tests construct a fake driver (no real spawn /
 * no network / no process) and assert the registry routes by kind. The default
 * claude-cli factory builds a real CliStreamDriver, but its OWN spawn is injectable
 * (CliStreamDriverOptions.spawnFn) — so even the real driver never spawns `claude`
 * in a test. Likewise the default api-adapter factory builds a real ApiAdapterDriver,
 * but its HTTP client is injectable (apiAdapterHttpClient) — so it never makes a real
 * (paid) call in a test.
 *
 * Concern (P2 = one job): MAP a selection → a driver instance. It does NOT seal the
 * options (that is M4 / backend-seal) and does NOT run the agent (that is M6 / the
 * relay + the lifecycle). Pure construction.
 *
 * Traces: proposal AP1, AP2, AP4, CP6; §M M3; PART P P1, P3.
 */

import { CliStreamDriver, type CliStreamDriverOptions } from './adapters/cli-stream-driver.js';
import {
  ApiAdapterDriver,
  DEEPSEEK_CODING_CONFIG,
  DEFAULT_API_ADAPTER_CONFIGS,
  type ApiAdapterConfig,
  type ApiAdapterHttpClient,
} from './api-adapter-driver.js';
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
   * The api-adapter config map (model id → {@link ApiAdapterConfig}). The default
   * api-adapter factory resolves a selection's `model` here; an unmapped model falls back
   * to {@link DEEPSEEK_CODING_CONFIG}. DEFAULT = {@link DEFAULT_API_ADAPTER_CONFIGS} —
   * BOTH DeepSeek (coding, P3) AND Codex (reviewing, P4), so `reviewing`→Codex resolves
   * end-to-end with no override. Override to add a backend or to point a model at a test
   * base-URL (tests inject this to avoid the real OpenAI/DeepSeek endpoints).
   */
  apiAdapterConfigs?: Record<string, ApiAdapterConfig>;
  /**
   * The injectable HTTP client for the default api-adapter factory — TESTS inject a fake
   * returning canned SSE/JSON so NO real (paid) call is made. When omitted, the
   * ApiAdapterDriver uses its default global-fetch client (only reached at real activation).
   */
  apiAdapterHttpClient?: ApiAdapterHttpClient;
  /** The env the api-adapter driver reads its API key from (default process.env). */
  apiAdapterEnv?: NodeJS.ProcessEnv;
  /**
   * Override/extend the per-kind factory map. A test can supply a 'claude-cli' (or
   * 'api-adapter') factory that returns a fake driver (so NO real driver is constructed at
   * all). Any kind present here wins over the built-in factory for that kind.
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

    // Built-in api-adapter factory (P3 DeepSeek=coding + P4 Codex=reviewing) — construct an
    // ApiAdapterDriver from the per-model config. DEFAULT map = DEFAULT_API_ADAPTER_CONFIGS (BOTH
    // DeepSeek + Codex), so a `reviewing`→Codex selection resolves with no override. The HTTP client
    // is injectable (tests feed canned responses → NO real paid call). An unmapped model falls back
    // to the DeepSeek config (a safe known shape; the seal still scopes the key by ownSecretName).
    const apiConfigs = opts.apiAdapterConfigs ?? DEFAULT_API_ADAPTER_CONFIGS;
    const apiHttpClient = opts.apiAdapterHttpClient;
    const apiEnv = opts.apiAdapterEnv;
    this.factories.set('api-adapter', (selection: BackendSelection) => {
      const config =
        (selection.model ? apiConfigs[selection.model] : undefined) ?? DEEPSEEK_CODING_CONFIG;
      return new ApiAdapterDriver({
        config,
        ...(apiHttpClient ? { httpClient: apiHttpClient } : {}),
        ...(apiEnv ? { env: apiEnv } : {}),
      });
    });

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
   * (a genuinely-unregistered/unknown kind — claude-cli and api-adapter are both
   * built in by default).
   */
  create(selection: BackendSelection): SessionDriver {
    const factory = this.factories.get(selection.backend);
    if (!factory) {
      throw new BackendRegistryError(selection.backend, 'no driver factory registered for this backend kind');
    }
    return factory(selection);
  }
}
