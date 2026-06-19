/**
 * API-ADAPTER DRIVER (M5) — a {@link SessionDriver} for OpenAI-compatible backends
 * (DeepSeek, Codex/OpenAI). The NON-Claude backend of the model-agnostic agent system.
 *
 * It maps a task turn → an OpenAI-compatible `/chat/completions` request (streamed),
 * and maps the response/stream → the normalized {@link SessionEvent} shape:
 *   - a synthesized `system_init` at start (sessionId synthesized; the pinned model; NO
 *     tools, NO mcpServers — a bare compute turn, OD-5);
 *   - streamed assistant text deltas → `assistant` events (one per delta with text);
 *   - the terminal → exactly ONE `result` event (subtype 'success' with the assembled
 *     text + cost if reported, OR an error subtype carrying a clean message).
 *
 * It REUSES the deepseek-codegen-mcp precedent (tools/deepseek-codegen-mcp/core.py):
 *   - the API key is read from the environment ONLY (`secretEnvVar`, e.g.
 *     'DEEPSEEK_API_KEY'); it is NEVER logged, NEVER returned, NEVER placed in args;
 *   - the model is PINNED (config) — no silent alias drift;
 *   - "thinking" is DISABLED by default for codegen (the dual-mode budget-eating trap);
 *   - any failure (missing key / network / non-2xx / bad body / empty content) becomes a
 *     CLEAN surfaced FAILURE — a terminal `result` event with an error subtype — NOT a
 *     thrown crash and NOT a leaked key. The relay (M6) maps that to `ok:false`.
 *
 * CONTRACT INVARIANT: the stream ALWAYS terminates with exactly one `result` event
 * (success or error). A SessionDriver consumer (result-relay) treats a stream that ends
 * with no `result` as a crash; this driver never does that for a handled error — it
 * converts the error into a surfaced FAILED result. Only a thrown-from-the-client bug
 * outside the catch could end without one (and the catch is total).
 *
 * INJECTABLE HTTP CLIENT: the actual transport is an {@link ApiAdapterHttpClient}
 * dependency. The default uses Node's global `fetch`; TESTS inject a fake client that
 * returns canned SSE/JSON with NO network + NO real (paid) call. Zero spend by design.
 *
 * Capability descriptor: this backend declares supportsTools=false &
 * supportsPermissionRouting=false (backend-kinds.ts BACKEND_CAPABILITIES['api-adapter'])
 * so the permission router (FD4) skips it — there is no gated-tool surface here.
 *
 * Traces: proposal AP1, AP3, CP1, CP2; §M M5; PART P P3.
 */

import { capabilitiesFor } from './backend-kinds.js';
import type { BackendCapabilities } from './session-driver.js';
import type {
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  UserTurn,
} from './session-driver.js';

/** DeepSeek's "thinking disabled" toggle (the deepseek-codegen-mcp precedent, core.py). */
export const THINKING_DISABLED = { type: 'disabled' } as const;

/**
 * The DeepSeek (coding) backend config — the proposal's `coding=DeepSeek` (deepseek-v4-flash).
 * Mirrors the deepseek-codegen-mcp pins (core.py): base-URL https://api.deepseek.com, model
 * deepseek-v4-flash, key from DEEPSEEK_API_KEY, thinking disabled, temperature 0.0. Exported so
 * the registry + the role-router config reference ONE source of truth for the pin.
 */
export const DEEPSEEK_CODING_CONFIG: ApiAdapterConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  secretEnvVar: 'DEEPSEEK_API_KEY',
  temperature: 0.0,
  disableThinking: true,
  label: 'deepseek',
};

/**
 * The Codex/OpenAI (reviewing) backend config — proposal OD-4 (Codex = OpenAI-API, OpenAI-compatible;
 * USER-APPROVED: ONE adapter serves both DeepSeek + Codex by config). P4: this is the SECOND
 * api-adapter backend, the parameterization proof that the SAME {@link ApiAdapterDriver} serves a
 * second vendor purely by config (base-URL/model/key) — ZERO new driver. The reviewing role routes
 * here (role-router DEFAULT_ROLE_ROUTING_CONFIG).
 *
 * MODEL ID IS A CONFIGURABLE DEFAULT, not a hardcoded constant: `gpt-5-codex` is a PLACEHOLDER pin —
 * the exact OpenAI model id is confirmed by the user BEFORE activation (P6). Override it by supplying a
 * different `BackendRegistryOptions.apiAdapterConfigs` entry (or a different role-router model) — the
 * registry keys on the model id, so changing it in ONE place (here, or via the config map) re-points the
 * whole route. `temperature`/`disableThinking` likewise tunable. Thinking is an OpenAI no-op (omitted).
 */
export const CODEX_REVIEWING_CONFIG: ApiAdapterConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5-codex',
  secretEnvVar: 'OPENAI_API_KEY',
  temperature: 0.0,
  disableThinking: false,
  label: 'codex',
};

/**
 * The DEFAULT api-adapter config map (model id → {@link ApiAdapterConfig}) — the SINGLE source of
 * truth the {@link BackendRegistry} keys on, so DeepSeek (coding, P3) AND Codex (reviewing, P4) both
 * resolve end-to-end with NO per-call override. Keyed by the PINNED model id (the same id the
 * role-router's DEFAULT_ROLE_ROUTING_CONFIG carries for each role), so a selection's `model` looks up
 * its full backend config here. Add a backend = one entry (e.g. a future local model). Override the
 * whole map via BackendRegistryOptions.apiAdapterConfigs (tests point a model at a fake base-URL).
 */
export const DEFAULT_API_ADAPTER_CONFIGS: Readonly<Record<string, ApiAdapterConfig>> = {
  [DEEPSEEK_CODING_CONFIG.model]: DEEPSEEK_CODING_CONFIG,
  [CODEX_REVIEWING_CONFIG.model]: CODEX_REVIEWING_CONFIG,
};

/** Static configuration for one api-adapter backend (parameterized per backend — DeepSeek/Codex). */
export interface ApiAdapterConfig {
  /** The backend's base URL, e.g. 'https://api.deepseek.com' (no trailing /chat/completions). */
  baseUrl: string;
  /** The PINNED model id, e.g. 'deepseek-v4-flash'. */
  model: string;
  /** The env var NAME this backend's API key is read from, e.g. 'DEEPSEEK_API_KEY'. (Name only — the VALUE is read from env at call time.) */
  secretEnvVar: string;
  /** Sampling temperature. Default 0.0 (DeepSeek's coding recommendation). */
  temperature?: number;
  /** Output-token cap. Default 32768 (the deepseek-codegen-mcp default). */
  maxTokens?: number;
  /** Whether to send the "thinking disabled" toggle (DeepSeek dual-mode). Default true. */
  disableThinking?: boolean;
  /** Per-call timeout in ms (advisory — passed to the client). Default 90000. */
  timeoutMs?: number;
  /** A human label for the backend (diagnostics / health detail). Default = the model id. */
  label?: string;
}

/** The request the driver builds (OpenAI-compatible chat/completions). Pure data — asserted by tests. */
export interface ChatCompletionRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature: number;
  max_tokens: number;
  /** Streamed by default (the driver maps deltas → assistant events). */
  stream: boolean;
  /** DeepSeek dual-mode toggle; present only when disableThinking (omitted otherwise). */
  thinking?: { type: 'disabled' };
}

/**
 * The arguments the driver hands the injectable HTTP client. It carries the assembled
 * request, the resolved auth header value (the driver reads the key from env — the client
 * NEVER sees the env var name, only the ready Authorization value), the full URL, and a
 * timeout. The client's only job is the transport.
 */
export interface ApiAdapterHttpRequest {
  url: string;
  /** Ready-made headers incl. Authorization: Bearer <key>. (The key VALUE lives only here, transiently.) */
  headers: Record<string, string>;
  body: ChatCompletionRequest;
  timeoutMs: number;
}

/**
 * The injectable HTTP client. Returns a STREAM of raw response-body chunks (the OpenAI
 * SSE convention: `data: {json}\n\n` lines, terminated by `data: [DONE]`). The driver
 * parses the SSE into deltas. A non-2xx or transport failure → the client THROWS an
 * {@link ApiAdapterHttpError} (status + a SHORT body excerpt, never the key); the driver
 * catches it and surfaces a clean FAILED result.
 *
 * The default client uses global fetch; tests inject a fake returning canned chunks.
 */
export interface ApiAdapterHttpClient {
  stream(req: ApiAdapterHttpRequest): Promise<AsyncIterable<string | Uint8Array>>;
}

/** Thrown by an {@link ApiAdapterHttpClient} on a non-2xx response or transport failure. Carries NO key. */
export class ApiAdapterHttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiAdapterHttpError';
    this.status = status;
  }
}

/** Options to construct an {@link ApiAdapterDriver}. */
export interface ApiAdapterDriverOptions {
  config: ApiAdapterConfig;
  /** The injectable HTTP client (default = global-fetch client). Tests inject a fake (no network). */
  httpClient?: ApiAdapterHttpClient;
  /** The env to read the API key from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Optional diagnostics sink (NEVER receives a key). */
  onStderr?: (line: string) => void;
  /** Injectable session-id generator (tests pin it deterministically). Default = a random id. */
  sessionIdFn?: () => string;
}

const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_TIMEOUT_MS = 90000;

/**
 * Build the OpenAI-compatible chat/completions request body from the start options + config.
 * Pure + exported so the request contract (model pin, thinking-disabled, message assembly) is
 * unit-asserted. The system prompt (if a plain string) → a system message; each bootstrap turn
 * → a user message (the task). An empty message list is still a valid (if useless) request — the
 * driver guards the empty-task case before calling this.
 */
export function buildChatCompletionRequest(
  config: ApiAdapterConfig,
  opts: SessionStartOptions,
): ChatCompletionRequest {
  const messages: ChatCompletionRequest['messages'] = [];
  // A plain-string systemPrompt becomes the system message (the {preset:'claude_code'} form is a
  // Claude-Code concept with no meaning for a bare API turn → ignored here, OD-5).
  if (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim().length > 0) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }
  // Each bootstrap turn is a user message (the task text the relay injected as bootstrapTurns).
  for (const turn of opts.bootstrapTurns ?? []) {
    if (typeof turn === 'string' && turn.length > 0) messages.push({ role: 'user', content: turn });
  }
  const req: ChatCompletionRequest = {
    model: config.model,
    messages,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (config.disableThinking ?? true) req.thinking = THINKING_DISABLED;
  return req;
}

/** A parsed streamed delta: incremental assistant text and/or a usage/cost report on the final chunk. */
export interface ParsedStreamChunk {
  /** Incremental assistant text from `choices[0].delta.content`, if any. */
  textDelta?: string;
  /** A finish_reason on this chunk (e.g. 'stop', 'length'), if present. */
  finishReason?: string;
  /** total_cost_usd if the backend reports it on a (usually final) chunk. */
  costUsd?: number;
  /** usage.total_tokens if reported (diagnostics). */
  totalTokens?: number;
}

/**
 * Parse ONE OpenAI-compatible SSE `data:` payload object → a {@link ParsedStreamChunk}. Defensive:
 * never throws on a missing field. Handles both the streamed delta shape
 * (`choices[0].delta.content`) and a non-streamed message shape (`choices[0].message.content`),
 * so a backend that ignores `stream:true` and returns one full object still maps. Exported + pure.
 */
export function parseStreamPayload(obj: unknown): ParsedStreamChunk {
  const m = (obj ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(m['choices']) ? (m['choices'] as Record<string, unknown>[]) : [];
  const c0 = (choices[0] ?? {}) as Record<string, unknown>;
  const delta = (c0['delta'] ?? {}) as Record<string, unknown>;
  const message = (c0['message'] ?? {}) as Record<string, unknown>;
  const out: ParsedStreamChunk = {};
  const deltaText = typeof delta['content'] === 'string' ? (delta['content'] as string) : undefined;
  const msgText = typeof message['content'] === 'string' ? (message['content'] as string) : undefined;
  const text = deltaText ?? msgText;
  if (text) out.textDelta = text;
  if (typeof c0['finish_reason'] === 'string') out.finishReason = c0['finish_reason'] as string;
  if (typeof m['total_cost_usd'] === 'number') out.costUsd = m['total_cost_usd'] as number;
  const usage = (m['usage'] ?? {}) as Record<string, unknown>;
  if (typeof usage['total_tokens'] === 'number') out.totalTokens = usage['total_tokens'] as number;
  return out;
}

/**
 * Yield each SSE `data:` JSON PAYLOAD object from a raw streamed body. Handles chunk boundaries
 * (a `data:` line split across chunks), skips blank lines + the `[DONE]` sentinel + non-`data:`
 * lines, and skips a payload that isn't valid JSON (defensive). Exported for the test.
 */
export async function* iterateSsePayloads(
  body: AsyncIterable<string | Uint8Array>,
): AsyncGenerator<unknown> {
  let buf = '';
  const decode = (chunk: string | Uint8Array): string =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  for await (const chunk of body) {
    buf += decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (!line.startsWith('data:')) continue; // SSE comment / event: line → ignore
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]' || payload === '') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // a non-JSON data payload (rare) → skip
      }
    }
  }
  // Flush a trailing buffered line (a final `data:` with no closing newline).
  const last = buf.replace(/\r$/, '').trim();
  if (last.startsWith('data:')) {
    const payload = last.slice('data:'.length).trim();
    if (payload && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload);
      } catch {
        /* skip */
      }
    }
  }
}

/** Read the backend's API key from env (name only in code; value transient). Returns '' if absent/empty. */
function readKey(env: NodeJS.ProcessEnv, secretEnvVar: string): string {
  const v = env[secretEnvVar];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The default HTTP client — uses the global `fetch` (Node ≥ 18). Streams the response body as
 * UTF-8 text chunks. NEVER reached in tests (they inject a fake). Throws {@link ApiAdapterHttpError}
 * on a non-2xx (with a SHORT body excerpt) or a transport failure. Carries no key in its errors.
 */
export function defaultFetchHttpClient(fetchImpl: typeof fetch = fetch): ApiAdapterHttpClient {
  return {
    async stream(req: ApiAdapterHttpRequest): Promise<AsyncIterable<string | Uint8Array>> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        throw new ApiAdapterHttpError(`network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!resp.ok) {
        let excerpt = '';
        try {
          excerpt = (await resp.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        clearTimeout(timer);
        throw new ApiAdapterHttpError(`HTTP ${resp.status}. ${excerpt}`.trim(), resp.status);
      }
      const body = resp.body;
      if (!body) {
        clearTimeout(timer);
        // No streaming body — return an empty stream (the driver then surfaces "empty").
        return (async function* () {})();
      }
      // Adapt the web ReadableStream to an async-iterable of text chunks.
      return (async function* () {
        try {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) yield value;
          }
        } finally {
          clearTimeout(timer);
        }
      })();
    },
  };
}

/**
 * The api-adapter SessionDriver. One instance per dispatched agent. `start()` runs ONE turn
 * (the task), maps the response to events, and ends with exactly one terminal `result` event.
 * `send()` is rejected (a bare api-adapter turn is one-shot in v1 — OD-5; multi-turn is a later
 * phase). `interrupt()`/`stop()` are best-effort no-ops (no child process to kill).
 */
export class ApiAdapterDriver implements SessionDriver {
  private readonly config: ApiAdapterConfig;
  private readonly httpClient: ApiAdapterHttpClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onStderr?: (line: string) => void;
  private readonly sessionIdFn: () => string;
  private running = false;
  private sessionId: string | undefined;

  constructor(opts: ApiAdapterDriverOptions) {
    this.config = opts.config;
    this.httpClient = opts.httpClient ?? defaultFetchHttpClient();
    this.env = opts.env ?? process.env;
    this.onStderr = opts.onStderr;
    this.sessionIdFn =
      opts.sessionIdFn ?? (() => `api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /** This backend's capability descriptor (M1) — no tools, no permission routing (OD-5). */
  static capabilities(): BackendCapabilities {
    return capabilitiesFor('api-adapter');
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    this.running = true;
    const sessionId = this.sessionIdFn();
    this.sessionId = sessionId;
    const self = this;

    async function* gen(): AsyncGenerator<SessionEvent> {
      try {
        // 1) Synthesize system_init (a bare compute turn — no tools, no mcpServers).
        yield {
          kind: 'system_init',
          sessionId,
          model: self.config.model,
          tools: [],
          mcpServers: [],
        };

        // 2) Read the key from env ONLY. A missing key is a CLEAN surfaced failure (no crash, no leak).
        const key = readKey(self.env, self.config.secretEnvVar);
        if (!key) {
          yield self.errorResult(
            sessionId,
            'error_no_api_key',
            `${self.config.secretEnvVar} is not set in the environment — the ${self.label()} backend reads ` +
              `its API key from that variable only. No key found; refusing to call (would fail to authenticate).`,
          );
          return;
        }

        // 3) Build the request + the ready auth header (the key VALUE lives only in this local header).
        const reqBody = buildChatCompletionRequest(self.config, opts);
        if (reqBody.messages.length === 0) {
          yield self.errorResult(sessionId, 'error_empty_task', 'no task content to send (empty messages).');
          return;
        }
        const httpReq: ApiAdapterHttpRequest = {
          url: self.config.baseUrl.replace(/\/+$/, '') + '/chat/completions',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: reqBody,
          timeoutMs: self.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        };

        // 4) Stream the response; accumulate assistant text; emit a delta event per non-empty delta.
        let assembled = '';
        let costUsd: number | undefined;
        let body: AsyncIterable<string | Uint8Array>;
        try {
          body = await self.httpClient.stream(httpReq);
        } catch (e) {
          yield self.mapHttpErrorToResult(sessionId, e);
          return;
        }
        try {
          for await (const payload of iterateSsePayloads(body)) {
            const parsed = parseStreamPayload(payload);
            if (parsed.costUsd !== undefined) costUsd = parsed.costUsd;
            if (parsed.textDelta) {
              assembled += parsed.textDelta;
              yield { kind: 'assistant', text: parsed.textDelta, toolUses: [] };
            }
          }
        } catch (e) {
          // A failure WHILE streaming (a transport drop mid-stream) → surfaced failure.
          yield self.mapHttpErrorToResult(sessionId, e);
          return;
        }

        // 5) Terminal result. Empty assembled text → a clean failure (the deepseek "empty implementation").
        if (assembled.trim().length === 0) {
          yield self.errorResult(
            sessionId,
            'error_empty_response',
            `the ${self.label()} backend returned an empty response.`,
          );
          return;
        }
        const result: Extract<SessionEvent, { kind: 'result' }> = {
          kind: 'result',
          sessionId,
          subtype: 'success',
          result: assembled,
        };
        if (costUsd !== undefined) result.costUsd = costUsd;
        yield result;
      } catch (e) {
        // TOTAL backstop: any unexpected error → a surfaced failure (never crash the stream, never leak).
        self.note(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        yield self.errorResult(
          sessionId,
          'error_unexpected',
          `unexpected ${self.label()} adapter error: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        self.running = false;
      }
    }
    return gen();
  }

  /** Map an HTTP/transport error → a terminal error result. Preserves an ApiAdapterHttpError's status; no key. */
  private mapHttpErrorToResult(sessionId: string, e: unknown): Extract<SessionEvent, { kind: 'result' }> {
    if (e instanceof ApiAdapterHttpError) {
      const subtype = e.status ? `error_http_${e.status}` : 'error_network';
      return this.errorResult(sessionId, subtype, `${this.label()} API call failed: ${e.message}`);
    }
    return this.errorResult(
      sessionId,
      'error_network',
      `${this.label()} API call failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  /** Build a terminal error `result` event (a surfaced FAILED — relay maps to ok:false). */
  private errorResult(
    sessionId: string,
    subtype: string,
    message: string,
  ): Extract<SessionEvent, { kind: 'result' }> {
    return { kind: 'result', sessionId, subtype, result: message };
  }

  private label(): string {
    return this.config.label ?? this.config.model;
  }

  private note(line: string): void {
    this.onStderr?.(`[api-adapter:${this.label()}] ${line}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async send(_turn: UserTurn): Promise<void> {
    // A bare api-adapter agent is one-shot in v1 (OD-5: pure compute-in/text-out). Multi-turn
    // resume is backend-specific + a later phase; reject rather than silently drop a turn.
    throw new Error('api-adapter driver: send() is not supported (one-shot compute turn in v1)');
  }

  async interrupt(): Promise<void> {
    // No child process / no live cooperative interrupt for a one-shot HTTP turn. Best-effort no-op.
    this.running = false;
  }

  async stop(): Promise<void> {
    // No child process to terminate. Mark not-running. Safe to call when not running.
    this.running = false;
  }

  health(): SessionDriverHealth {
    return { running: this.running, sessionId: this.sessionId, detail: `api-adapter-driver:${this.label()}` };
  }
}
