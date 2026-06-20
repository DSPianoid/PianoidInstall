/**
 * PROVIDER REGISTRY — the generalization of the per-backend api-adapter config into a
 * pluggable, config-only PROVIDER table (proposal model-agnostic-agents-2026-06-19, the
 * "any OpenAI-compatible provider pluggable by config" extension).
 *
 * The model-agnostic vision: the supervisor is provider-agnostic. ANY OpenAI-compatible
 * provider (DeepSeek, OpenAI/Codex, Groq, Gemini-via-its-OpenAI-compat-endpoint, and more
 * later) is wired by ADDING ONE ENTRY here — no new driver, no new code path. The EXISTING
 * {@link ApiAdapterDriver} (api-adapter-driver.ts) serves every one of them, parameterized
 * by the provider's {baseUrl, model, secretEnvVar}. A provider is pure DATA.
 *
 * A {@link Provider} is the canonical record:
 *   - `id`            — the stable provider key the user names in `/setkey <provider> …`
 *                       and (next batch) `/setrole <role> <provider> …`.
 *   - `baseUrl`       — the OpenAI-compatible base URL (no trailing /chat/completions).
 *   - `defaultModel`  — a CONFIGURABLE PLACEHOLDER model id (the user sets the real one via
 *                       /setrole next batch / before activation — NOT a hardcoded production pin).
 *   - `secretEnvVar`  — the env var NAME this provider's API key is read from (the driver reads
 *                       the VALUE from env at call time; the name only lives in code).
 *   - `openAiCompatible` — always true here (the whole point: one adapter serves all). A future
 *                       non-OpenAI-shape provider would need its own driver + flip this false.
 *   - `rate?`         — an optional per-1M-token USD rate used to COMPUTE spend when the provider
 *                       does not report its own `total_cost_usd` (M-1 metering). Configurable.
 *
 * RELATION TO api-adapter-driver.ts (no duplication):
 *   - This module is the SINGLE SOURCE OF TRUTH for the provider set. `api-adapter-driver.ts`
 *     DERIVES its DEFAULT_API_ADAPTER_CONFIGS from {@link DEFAULT_PROVIDERS} via
 *     {@link apiAdapterConfigForProvider}, so the DeepSeek + Codex configs that already existed
 *     are now produced from these entries (byte-compatible base-URL/model/secret/rate), and Groq
 *     + Gemini come for free.
 *   - `cost-safety.ts` DERIVES the per-provider secret-env-var set (BACKEND_SECRET_ENV_VARS) here
 *     too, so cross-provider key scoping (a Groq agent must reject a DeepSeek/OpenAI/Gemini key,
 *     etc.) is automatic for every provider in this table.
 *
 * SCOPE / SAFETY: pure types + const data + pure helpers. NO I/O, NO network, NO existing
 * runtime path touched. DORMANT until role-routing is activated (P6, default-OFF). Adding a
 * provider here changes NOTHING at runtime until the user both supplies its key (/setkey) and
 * routes a role to it (/setrole, next batch).
 *
 * Traces: proposal CP1 (uniform contract), CP2 (best-model-per-role), AP1/AP2 (the seam +
 * data-driven routing), M5 (the api-adapter driver this feeds), OD-1 (per-backend key scoping),
 * OD-4 (one adapter, many vendors by config).
 */

import type { ApiAdapterConfig, ModelRate } from './api-adapter-driver.js';

/**
 * The stable provider keys. DATA — extend by adding an entry to {@link DEFAULT_PROVIDERS} (and,
 * by construction, here). The user names one of these in `/setkey <providerId> <key>`.
 *
 * - 'deepseek' — DeepSeek (the proposal's coding backend; already existed).
 * - 'openai'   — OpenAI / Codex (the proposal's reviewing backend, OD-4; already existed). The
 *                user-facing alias 'codex' also resolves to this provider (see {@link PROVIDER_ALIASES}).
 * - 'groq'     — Groq's OpenAI-compatible API (NEW; a configurable default model).
 * - 'gemini'   — Google Gemini via its OpenAI-COMPATIBILITY endpoint (NEW; so the SAME
 *                ApiAdapterDriver serves it — Gemini's `/v1beta/openai/` surface speaks the
 *                OpenAI chat/completions shape, so NO new driver).
 */
export type ProviderId = 'deepseek' | 'openai' | 'groq' | 'gemini';

/**
 * A pluggable provider record — the canonical config for ONE OpenAI-compatible backend provider.
 * Adding a provider = one of these. Pure data.
 */
export interface Provider {
  /** Stable provider key (the `/setkey <id>` token). */
  id: ProviderId;
  /** OpenAI-compatible base URL (no trailing /chat/completions). */
  baseUrl: string;
  /**
   * A CONFIGURABLE PLACEHOLDER default model id. NOT a hardcoded production pin — the user sets
   * the real model per role via /setrole (next batch) / before activation (P6). Present so a
   * provider resolves to a complete driver config out of the box (for tests + the dormant path).
   */
  defaultModel: string;
  /** The env var NAME this provider's API key is read from (value read from env at call time). */
  secretEnvVar: string;
  /**
   * Always true here — every provider in this registry is OpenAI-compatible, so the ONE existing
   * {@link ApiAdapterDriver} serves it (the model-agnostic invariant). A future non-OpenAI-shape
   * provider would set this false and require its own driver (out of scope).
   */
  openAiCompatible: true;
  /**
   * Optional per-1M-token USD rate (M-1) — used to COMPUTE spend when the provider does not report
   * its own `total_cost_usd`. CONFIGURABLE placeholder; the operator confirms real prices before
   * real spend (OD-3). Omit → cost stays unknown (token counts still forwarded).
   */
  rate?: ModelRate;
  /** A human label for diagnostics (default = the id). */
  label?: string;
}

/**
 * The DEFAULT provider table — the SINGLE SOURCE OF TRUTH for the wired providers. Keyed by id.
 * DeepSeek + OpenAI/Codex reproduce the pins that already lived in api-adapter-driver.ts (so
 * DEFAULT_API_ADAPTER_CONFIGS, derived from these, is byte-compatible); Groq + Gemini are NEW.
 *
 * EVERY model id is a CONFIGURABLE PLACEHOLDER — set the real one via /setrole (next batch) or by
 * editing this table in ONE place before activation. The registry keys downstream config on these.
 */
export const DEFAULT_PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  // DeepSeek — the proposal's coding backend. Pins reproduced from the prior DEEPSEEK_CODING_CONFIG.
  deepseek: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    secretEnvVar: 'DEEPSEEK_API_KEY',
    openAiCompatible: true,
    rate: { inputPerMTok: 0.27, outputPerMTok: 1.1 },
    label: 'deepseek',
  },
  // OpenAI / Codex — the proposal's reviewing backend (OD-4). Pins reproduced from CODEX_REVIEWING_CONFIG.
  openai: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-codex',
    secretEnvVar: 'OPENAI_API_KEY',
    openAiCompatible: true,
    rate: { inputPerMTok: 1.25, outputPerMTok: 10.0 },
    label: 'codex',
  },
  // Groq — OpenAI-compatible API. baseUrl + secret per the spec; model is a CONFIGURABLE PLACEHOLDER.
  groq: {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    secretEnvVar: 'GROQ_API_KEY',
    openAiCompatible: true,
    // No default rate placeholder — Groq pricing varies per model; the operator sets it before spend.
    label: 'groq',
  },
  // Gemini via its OpenAI-COMPATIBILITY endpoint (so the EXISTING ApiAdapterDriver serves it — NO new
  // driver). baseUrl + secret per the spec; model is a CONFIGURABLE PLACEHOLDER.
  gemini: {
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.5-flash',
    secretEnvVar: 'GEMINI_API_KEY',
    openAiCompatible: true,
    label: 'gemini',
  },
};

/** All provider ids in declaration order. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(DEFAULT_PROVIDERS) as ProviderId[];

/**
 * User-facing ALIASES → canonical provider id. The proposal speaks of "Codex" as the user-facing
 * name for the OpenAI provider (OD-4: Codex = OpenAI-API). So `/setkey codex <key>` resolves to the
 * `openai` provider (and stores OPENAI_API_KEY). Aliases are resolved by {@link resolveProviderId}.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  codex: 'openai',
  google: 'gemini',
};

/** Is `v` a canonical provider id present in the registry? */
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_PROVIDERS, v);
}

/**
 * Resolve a user-typed provider token (case-insensitive; canonical id OR a known alias) to a
 * canonical {@link ProviderId}, or undefined when it is neither. Pure.
 */
export function resolveProviderId(
  token: string,
  providers: Readonly<Record<string, Provider>> = DEFAULT_PROVIDERS,
): ProviderId | undefined {
  const key = token.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(providers, key)) return key as ProviderId;
  const alias = PROVIDER_ALIASES[key];
  if (alias && Object.prototype.hasOwnProperty.call(providers, alias)) return alias;
  return undefined;
}

/** Look up a provider record by id (canonical only — alias-resolve first via {@link resolveProviderId}). */
export function getProvider(
  id: ProviderId,
  providers: Readonly<Record<ProviderId, Provider>> = DEFAULT_PROVIDERS,
): Provider {
  return providers[id];
}

/**
 * Build the {@link ApiAdapterConfig} the existing {@link ApiAdapterDriver} consumes, from a provider
 * + an OPTIONAL model override (else the provider's configurable `defaultModel`). This is the bridge
 * that lets "one provider entry" produce a fully-parameterized driver config (base-URL/model/secret/
 * rate) with NO per-provider driver. Pure.
 *
 * `temperature`/`disableThinking` use the codegen-safe defaults the driver already applies
 * (temperature 0.0; thinking-disabled toggle is a DeepSeek-only no-op elsewhere) — left to the
 * driver's own defaults here so this stays a pure projection of provider DATA.
 */
export function apiAdapterConfigForProvider(provider: Provider, model?: string): ApiAdapterConfig {
  const cfg: ApiAdapterConfig = {
    baseUrl: provider.baseUrl,
    model: model ?? provider.defaultModel,
    secretEnvVar: provider.secretEnvVar,
    label: provider.label ?? provider.id,
  };
  if (provider.rate !== undefined) cfg.rate = provider.rate;
  return cfg;
}

/**
 * The DEFAULT api-adapter config map (model id → {@link ApiAdapterConfig}) DERIVED from the provider
 * table — one entry per provider, keyed by the provider's default (placeholder) model id. This is the
 * map the backend-registry keys on; `api-adapter-driver.ts` re-exports it AS DEFAULT_API_ADAPTER_CONFIGS
 * so there is ONE source of truth. Adding a provider above adds an entry here automatically.
 *
 * NOTE: keyed by `defaultModel`. If two providers ever shared a default model id (they don't), the
 * later one would win — fine for the dormant default map; real per-role model selection (which carries
 * the provider explicitly) is the /setrole batch.
 */
export function buildDefaultApiAdapterConfigs(
  providers: Readonly<Record<ProviderId, Provider>> = DEFAULT_PROVIDERS,
): Record<string, ApiAdapterConfig> {
  const out: Record<string, ApiAdapterConfig> = {};
  for (const id of Object.keys(providers) as ProviderId[]) {
    const p = providers[id];
    out[p.defaultModel] = apiAdapterConfigForProvider(p);
  }
  return out;
}

/**
 * The per-provider secret-env-var map (provider id → secret env var name) DERIVED from the table.
 * `cost-safety.ts` re-exports this AS BACKEND_SECRET_ENV_VARS so the cross-provider key-scoping guard
 * (assertBackendCostSafe) knows EVERY provider's key — a Groq agent then rejects DeepSeek/OpenAI/Gemini
 * keys, a Gemini agent rejects the others, etc., for every pair, automatically.
 */
export function buildProviderSecretEnvVars(
  providers: Readonly<Record<ProviderId, Provider>> = DEFAULT_PROVIDERS,
): Record<ProviderId, string> {
  const out = {} as Record<ProviderId, string>;
  for (const id of Object.keys(providers) as ProviderId[]) {
    out[id] = providers[id].secretEnvVar;
  }
  return out;
}
