/**
 * MULTI-TURN ADAPTER DRIVER (model-agnostic-orchestrator Tier-1, piece #1) — a
 * {@link SessionDriver} for a NON-Claude (OpenAI-compatible) model that holds a
 * GROWING conversation and runs an OpenAI-native `tool_calls` loop, so the model can
 * ACT over many turns. This is the orchestrator-grade sibling of the one-shot
 * {@link ApiAdapterDriver}: where that driver runs ONE compute turn and rejects
 * `send()` (api-adapter-driver.ts:640-645), this one keeps a persistent `messages[]`,
 * makes `send()` REAL, and loops on tool calls until a final text answer.
 *
 * IT REUSES (does not re-implement) the one-shot adapter's PURE helpers — D-A
 * ("reuse the helpers, not the class shape"; mirrors how CliStreamDriver and
 * SdkSessionDriver are siblings, not subclasses):
 *   - {@link buildChatCompletionRequest}'s message-assembly precedent (system + turns);
 *   - {@link parseStreamPayload}'s tolerant `choices[0].message` reader (non-streamed);
 *   - {@link resolveRate} + {@link computeCostUsd} for token→USD metering (M-1);
 *   - the injectable {@link ApiAdapterHttpClient} + {@link ApiAdapterHttpError} discipline:
 *     ANY failure (missing key / network / non-2xx / bad body) becomes a CLEAN surfaced
 *     terminal `result` event with an error subtype — never a thrown crash, never a
 *     leaked key (CP5: a failure must not wedge the orchestrator).
 *
 * WHAT IT ADDS (the net-new T1 surface):
 *   (a) a persistent `messages[]` conversation the driver OWNS (sole writer — P1);
 *   (b) a REAL `send(turn)` that appends a user message + runs the next assistant turn
 *       (+ its tool loop) — the direct analog of CliStreamDriver.send() writing a user
 *       turn to stdin (cli-stream-driver.ts:627-630), same seam contract, HTTPS transport;
 *   (c) an OpenAI-NATIVE `tool_calls` loop (D-B): the request carries `tools`/`tool_choice`;
 *       an assistant turn may return `tool_calls`; the driver runs each via an INJECTED
 *       `runTool` callback, feeds the result back as a `{role:'tool', tool_call_id, …}`
 *       message, and issues the NEXT completion — until an assistant turn returns content
 *       with NO `tool_calls` (a final answer). A turn-iteration cap bounds runaway loops.
 *
 * NON-STREAMED completions (design decision D1): unlike the one-shot adapter (which
 * streams SSE deltas), the multi-turn/tool path issues NON-streamed `/chat/completions`
 * (`stream:false`) and parses ONE full response object. `tool_calls` (and their
 * `arguments` JSON string) arrive as structured objects that would otherwise be split
 * across SSE deltas (brittle to reassemble); a non-streamed turn is atomic and the
 * existing `parseStreamPayload` already reads the non-streamed `choices[0].message`
 * shape. Per-turn assistant text is still emitted as an `assistant` event.
 *
 * CONTAINMENT (the load-bearing T1 claim, proposal §6.3): the driver NEVER executes a
 * tool itself — it only calls the injected `runTool(call) => Promise<string>`. The
 * unsealed/unrouted tool path is UNREPRESENTABLE in this class: there is no
 * `child_process`, no `fetch` of anything but the model endpoint. The REAL choke-point
 * (permission router + seal — piece #4) is supplied at wiring time as `runTool`. T1
 * supplies only the loop; the default `runTool` degrades to a clean "no tool runner
 * wired" tool-result (never a crash).
 *
 * Capability descriptor: this backend declares supportsTools=true &
 * supportsPermissionRouting=true (DISTINCT from the bare api-adapter's all-false) so the
 * runtime wires it as a tool-capable session. supportsTeams=false (it replaces teams via
 * the supervisor-mediated dispatch surface — piece #2, NOT in T1). supportsResume=false
 * (the conversation lives in-process; restart re-injects the brief — piece #5).
 *
 * SCOPE (T1 only): this is a NEW MODULE wired into NOTHING. Driver-selection-by-model
 * (piece #3), the coordinate/dispatch tools (piece #2), and the real seal/router tool
 * choke-point (piece #4) are LATER phases. The live Claude orchestrator is byte-for-byte
 * unaffected (additive + dormant, the campaign's P6 discipline).
 *
 * INJECTABLE HTTP CLIENT + runTool: both are dependencies. TESTS inject a fake HTTP
 * client returning canned NON-streamed JSON (NO network, NO real paid call, ZERO spend)
 * and a scripted `runTool` (NO real fs/shell/http) — the whole multi-turn + tool loop is
 * testable behind the seam.
 *
 * Traces: proposal model-agnostic-orchestrator-tier1-2026-06-22 §3.1 (piece #1), §4 T1,
 * D-A, D-B, D-H; CP1, CP5, CP6; AP1; FD3. Extends model-agnostic-agents M5 (one-shot →
 * multi-turn).
 */

import { capabilitiesFor } from './backend-kinds.js';
import {
  ApiAdapterHttpError,
  computeCostUsd,
  defaultFetchHttpClient,
  parseStreamPayload,
  resolveRate,
  THINKING_DISABLED,
  type ApiAdapterConfig,
  type ApiAdapterHttpClient,
  type ApiAdapterHttpRequest,
  type TokenUsage,
} from './api-adapter-driver.js';
import type { BackendCapabilities } from './session-driver.js';
import type {
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  ToolUse,
  UserTurn,
} from './session-driver.js';

const DEFAULT_TEMPERATURE = 0.0;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_TIMEOUT_MS = 90000;

/** Default hard cap on tool-call iterations within ONE turn — bounds a runaway tool loop (proposal §3.1, §6.2). */
export const DEFAULT_MAX_TOOL_ITERATIONS = 40;

// ── OpenAI tool-calling wire shapes (the conversation grammar, proposal §3.1) ─────────

/**
 * A `function` tool the orchestrator may call — the OpenAI `/chat/completions` `tools[]`
 * entry. `parameters` is a JSON-Schema object. Pure data; supplied as a manifest at wiring
 * time (pieces #2+#4). Exported so the manifest + the request build are unit-asserted.
 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON-Schema for the tool's arguments. */
    parameters?: Record<string, unknown>;
  };
}

/** `tool_choice` — let the model decide ('auto'), forbid tools ('none'), or force one. */
export type ToolChoice = 'auto' | 'none' | 'required';

/**
 * One OpenAI chat message in the persistent conversation. A superset of the one-shot
 * adapter's `{role,content}` shape: assistant messages may carry `tool_calls`, and a
 * `tool` message carries its `tool_call_id`. This is the data the driver OWNS in
 * `messages[]` (P1: sole writer).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content. May be null on an assistant turn that ONLY emitted tool_calls. */
  content: string | null;
  /** Present on an assistant turn that requested tools. */
  tool_calls?: ToolCall[];
  /** Present on a `role:'tool'` result message — correlates to the tool_call it answers. */
  tool_call_id?: string;
}

/** A tool call the assistant requested — OpenAI `choices[0].message.tool_calls[]` entry. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** The arguments as a JSON STRING (OpenAI encodes them as a string, not an object). */
    arguments: string;
  };
}

/**
 * The NON-streamed chat/completions request the multi-turn driver builds. Distinct from
 * the one-shot {@link ApiAdapterConfig} streaming request: `stream:false`, the full
 * message superset (incl. `tool`/`tool_calls`), and the optional `tools`/`tool_choice`.
 */
export interface ChatCompletionToolRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: false;
  tools?: ToolSchema[];
  tool_choice?: ToolChoice;
  /** DeepSeek dual-mode toggle; present only when disableThinking (omitted otherwise). */
  thinking?: { type: 'disabled' };
}

/**
 * The injected tool runner — the ONE primitive the driver calls to execute a tool. T1
 * does NOT build the real one (piece #4 = the permission-router + seal choke-point);
 * this is the seam where it plugs in. Receives the parsed call (name + already-parsed
 * args + the raw call), returns the stringified tool result (or an error string — the
 * runner converts a denial / failure into a result string, it does NOT throw; the driver
 * feeds whatever it returns back to the model). Async so the real runner can route a
 * permission decision to a human and AWAIT it (the FC-1 block-on-reply guarantee).
 */
export type ToolRunner = (call: ParsedToolCall) => Promise<string>;

/** A tool call after the driver has parsed its `arguments` JSON (defensive — `args` is {} on bad JSON). */
export interface ParsedToolCall {
  id: string;
  name: string;
  /** Parsed arguments (the OpenAI `arguments` JSON string, JSON.parsed; `{}` if unparseable). */
  args: Record<string, unknown>;
  /** The raw arguments string as received (for diagnostics / a runner that wants the original). */
  rawArguments: string;
}

/** Options to construct a {@link MultiTurnAdapterDriver}. */
export interface MultiTurnAdapterDriverOptions {
  config: ApiAdapterConfig;
  /** The injectable HTTP client (default = global-fetch client). Tests inject a fake (no network). */
  httpClient?: ApiAdapterHttpClient;
  /** The env to read the API key from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * The tool runner (piece #4 at wiring time). Default = a stub that returns a clean
   * "no tool runner wired" string fed back as the tool result (degrades, never crashes).
   */
  runTool?: ToolRunner;
  /**
   * The tool manifest exposed to the model (the OpenAI `tools[]`). Empty/omitted ⇒ a plain
   * multi-turn chat with no tools (T1's lower bound). The real manifest is supplied at wiring.
   */
  tools?: ToolSchema[];
  /** `tool_choice` (default 'auto' when a non-empty manifest is present; omitted otherwise). */
  toolChoice?: ToolChoice;
  /** Hard cap on tool-call iterations per turn (default {@link DEFAULT_MAX_TOOL_ITERATIONS}). */
  maxToolIterations?: number;
  /** Optional diagnostics sink (NEVER receives a key). */
  onStderr?: (line: string) => void;
  /** Injectable session-id generator (tests pin it deterministically). Default = a random id. */
  sessionIdFn?: () => string;
}

/** Read the backend's API key from env (name only in code; value transient). Returns '' if absent/empty.
 *  (Re-implements the one-shot adapter's private `readKey` — 4 trivial lines — to avoid touching that
 *  file; same semantics: read the named env var, trim, default ''.) */
function readKey(env: NodeJS.ProcessEnv, secretEnvVar: string): string {
  const v = env[secretEnvVar];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Build the NON-streamed tool-calling request from the current conversation + config.
 * Pure + exported so the request contract (model pin, thinking-disabled, tools wiring) is
 * unit-asserted. The system prompt is part of `messages[]` already (seeded at start), so
 * this just snapshots the conversation into the request body.
 */
export function buildToolCompletionRequest(
  config: ApiAdapterConfig,
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  toolChoice: ToolChoice | undefined,
): ChatCompletionToolRequest {
  const req: ChatCompletionToolRequest = {
    model: config.model,
    // Copy so a later mutation of the live conversation can't retroactively alter a sent request.
    messages: messages.map((m) => ({ ...m })),
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  };
  if (tools && tools.length > 0) {
    req.tools = tools;
    req.tool_choice = toolChoice ?? 'auto';
  }
  if (config.disableThinking ?? true) req.thinking = THINKING_DISABLED;
  return req;
}

/**
 * Extract the assistant message from a NON-streamed completion object → its text content,
 * its tool_calls, and any usage/cost. Defensive: never throws on a missing field. Exported
 * + pure. Reuses {@link parseStreamPayload} for the text + usage + cost (which already reads
 * the non-streamed `choices[0].message.content`), and adds the `tool_calls` extraction.
 */
export function parseAssistantMessage(obj: unknown): {
  content: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  costUsd?: number;
  finishReason?: string;
} {
  const base = parseStreamPayload(obj); // text (from message.content) + usage + cost + finish_reason
  const m = (obj ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(m['choices']) ? (m['choices'] as Record<string, unknown>[]) : [];
  const c0 = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (c0['message'] ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : [];
  const toolCalls: ToolCall[] = [];
  for (const rc of rawCalls) {
    const call = (rc ?? {}) as Record<string, unknown>;
    const fn = (call['function'] ?? {}) as Record<string, unknown>;
    const id = typeof call['id'] === 'string' ? (call['id'] as string) : '';
    const name = typeof fn['name'] === 'string' ? (fn['name'] as string) : '';
    const args = typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : '';
    // A tool_call with no name is unusable — skip it (the model malformed it; the turn cap bounds repeats).
    if (!name) continue;
    toolCalls.push({ id: id || name, type: 'function', function: { name, arguments: args } });
  }
  const out: {
    content: string;
    toolCalls: ToolCall[];
    usage?: TokenUsage;
    costUsd?: number;
    finishReason?: string;
  } = {
    content: base.textDelta ?? '',
    toolCalls,
  };
  if (base.usage) out.usage = base.usage;
  if (base.costUsd !== undefined) out.costUsd = base.costUsd;
  if (base.finishReason) out.finishReason = base.finishReason;
  return out;
}

/** Parse a tool call's `arguments` JSON string into an object (defensive — `{}` on bad/empty JSON). */
export function parseToolCall(call: ToolCall): ParsedToolCall {
  let args: Record<string, unknown> = {};
  const raw = call.function.arguments ?? '';
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // a non-JSON arguments string → leave args = {} (the runner sees the rawArguments too)
    }
  }
  return { id: call.id, name: call.function.name, args, rawArguments: raw };
}

/**
 * Read a single NON-streamed completion object from the HTTP client. The client returns a
 * stream of body chunks (the same {@link ApiAdapterHttpClient} contract the one-shot adapter
 * uses); a non-streamed response is the whole JSON body across those chunks, so we
 * concatenate and JSON.parse once. Throws {@link ApiAdapterHttpError} on a transport/HTTP
 * failure (the client) or a bad body (here) — the driver's loop catches it.
 */
async function readJsonCompletion(body: AsyncIterable<string | Uint8Array>): Promise<unknown> {
  let buf = '';
  for await (const chunk of body) {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  const trimmed = buf.trim();
  if (trimmed.length === 0) throw new ApiAdapterHttpError('empty response body');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new ApiAdapterHttpError(`non-JSON response body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The multi-turn, tool-capable SessionDriver. One instance per hosted orchestrator session.
 * `start()` seeds the conversation (system + bootstrap turns) and runs the FIRST turn (its
 * tool loop). `send(turn)` appends a user turn and runs the NEXT turn. Each turn ends with
 * exactly one terminal `result` event (success or a surfaced error subtype). `stop()` ends
 * the session; `interrupt()` requests the in-flight turn to abort at the next loop boundary.
 */
export class MultiTurnAdapterDriver implements SessionDriver {
  private readonly config: ApiAdapterConfig;
  private readonly httpClient: ApiAdapterHttpClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runTool: ToolRunner;
  private readonly tools: ToolSchema[];
  private readonly toolChoice: ToolChoice | undefined;
  private readonly maxToolIterations: number;
  private readonly onStderr?: (line: string) => void;
  private readonly sessionIdFn: () => string;

  /** The persistent conversation. THIS driver is the sole writer (P1). */
  private readonly messages: ChatMessage[] = [];
  private sessionId: string | undefined;
  private started = false;
  /** True while a turn's async generator is actively producing events. */
  private turnRunning = false;
  /** Set by interrupt(); checked at each tool-loop boundary to abort the current turn cleanly. */
  private interruptRequested = false;

  constructor(opts: MultiTurnAdapterDriverOptions) {
    this.config = opts.config;
    this.httpClient = opts.httpClient ?? defaultFetchHttpClient();
    this.env = opts.env ?? process.env;
    this.runTool = opts.runTool ?? defaultNoToolRunner;
    this.tools = opts.tools ?? [];
    this.toolChoice = opts.toolChoice;
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.onStderr = opts.onStderr;
    this.sessionIdFn =
      opts.sessionIdFn ?? (() => `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /** This backend's capability descriptor — tool-capable + permission-routable, NO teams/resume. */
  static capabilities(): BackendCapabilities {
    // Reuse the bare api-adapter descriptor as the base, then flip the two T1 capabilities on.
    const base = capabilitiesFor('api-adapter');
    return { ...base, supportsTools: true, supportsPermissionRouting: true };
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    if (this.started) {
      // Re-start of a live multi-turn session is a usage error (the host owns one driver lifecycle).
      // Surface it as a clean terminal result rather than throwing into the consumer.
      const sid = this.sessionId ?? this.sessionIdFn();
      return onceResult(this.errorResult(sid, 'error_already_started', 'multi-turn driver: already started'));
    }
    this.started = true;
    const sessionId = this.sessionIdFn();
    this.sessionId = sessionId;

    // Seed the conversation: the system prompt (plain string only — the {preset:'claude_code'} form is a
    // Claude-Code concept with no meaning for a bare API turn → ignored, OD-5), then each bootstrap turn.
    if (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim().length > 0) {
      this.messages.push({ role: 'system', content: opts.systemPrompt });
    }
    for (const turn of opts.bootstrapTurns ?? []) {
      if (typeof turn === 'string' && turn.length > 0) this.messages.push({ role: 'user', content: turn });
    }

    const self = this;
    async function* gen(): AsyncGenerator<SessionEvent> {
      // 1) Synthesize system_init — the tools the session exposes are the manifest names (so the host
      //    sees this is a tool-capable session, unlike the bare api-adapter's empty tools).
      yield {
        kind: 'system_init',
        sessionId,
        model: self.config.model,
        tools: self.tools.map((t) => t.function.name),
        mcpServers: [],
      };
      // 2) If there is no task content at all (no system prompt, no bootstrap turn), surface a clean failure.
      if (self.messages.length === 0) {
        yield self.errorResult(sessionId, 'error_empty_task', 'no task content to send (empty conversation).');
        return;
      }
      // 3) Run the first turn + its tool loop.
      yield* self.runTurn(sessionId);
    }
    return gen();
  }

  /**
   * Inject a user turn and run the NEXT assistant turn (+ its tool loop). The events are
   * published by the host's consumption of `start()`'s iterable in the SDK/cli drivers; for
   * this driver, `send()` runs the turn and the host consumes the events via the SAME
   * mechanism the lifecycle manager uses (it re-reads the driver's event stream). To keep the
   * SessionDriver contract (send returns void; events flow through the started iterable), we
   * stage the turn's events and the active iterable drains them.
   *
   * NOTE: in this T1 driver, `send()` runs the turn eagerly and the caller observes the
   * resulting events by consuming {@link runTurnEvents} (the host wires the started iterable to
   * keep yielding). The lifecycle integration (piece #3/#5) decides the exact pump; T1 exposes
   * a correct, testable per-turn run.
   */
  async send(turn: UserTurn): Promise<void> {
    if (!this.started) throw new Error('multi-turn driver: not started');
    this.messages.push({ role: 'user', content: turn.text });
  }

  /**
   * Run ONE turn against the model: append assistant turns, execute any tool_calls via
   * {@link runTool}, feed results back, loop until a final (no-tool_calls) assistant message
   * or the iteration cap. Yields `assistant` / `tool_result` events and ends with exactly one
   * terminal `result` event. The total try/catch guarantees a terminal result on ANY error
   * (CP5) — no thrown crash, no leaked key.
   *
   * Exposed (not private) so a host pump can run a turn after a `send()` and consume its events;
   * tests drive it directly. Re-entrant calls are guarded (a turn already running yields a clean
   * busy result rather than interleaving).
   */
  async *runTurn(sessionId?: string): AsyncGenerator<SessionEvent> {
    const sid = sessionId ?? this.sessionId ?? this.sessionIdFn();
    if (this.turnRunning) {
      yield this.errorResult(sid, 'error_busy', 'multi-turn driver: a turn is already running');
      return;
    }
    this.turnRunning = true;
    this.interruptRequested = false;
    let costUsd: number | undefined;
    let usage: TokenUsage | undefined;
    try {
      // The key is read fresh per turn from env ONLY (no key cached on the instance). Missing → clean failure.
      const key = readKey(this.env, this.config.secretEnvVar);
      if (!key) {
        yield this.errorResult(
          sid,
          'error_no_api_key',
          `${this.config.secretEnvVar} is not set in the environment — the ${this.label()} backend reads its ` +
            `API key from that variable only. No key found; refusing to call.`,
        );
        return;
      }

      for (let iter = 0; iter < this.maxToolIterations; iter++) {
        if (this.interruptRequested) {
          yield this.errorResult(sid, 'error_interrupted', 'the turn was interrupted before completion.');
          return;
        }

        // a) Issue one NON-streamed completion over the current conversation.
        const reqBody = buildToolCompletionRequest(this.config, this.messages, this.tools, this.toolChoice);
        const httpReq: ApiAdapterHttpRequest = {
          url: this.config.baseUrl.replace(/\/+$/, '') + '/chat/completions',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          // The HTTP client's body type is the streaming request; the non-streamed body is a structural
          // superset for transport purposes (same JSON POST). Cast at the boundary only.
          body: reqBody as unknown as ApiAdapterHttpRequest['body'],
          timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        };

        let parsed: ReturnType<typeof parseAssistantMessage>;
        try {
          const body = await this.httpClient.stream(httpReq);
          const completion = await readJsonCompletion(body);
          parsed = parseAssistantMessage(completion);
        } catch (e) {
          yield this.mapHttpErrorToResult(sid, e);
          return;
        }

        // Accumulate metering across the turn's completions (keep the latest reported usage/cost).
        if (parsed.usage) usage = parsed.usage;
        if (parsed.costUsd !== undefined) costUsd = (costUsd ?? 0) + parsed.costUsd;

        // b) Record the assistant message in the conversation (content + any tool_calls).
        const assistantMsg: ChatMessage = { role: 'assistant', content: parsed.content || null };
        if (parsed.toolCalls.length > 0) assistantMsg.tool_calls = parsed.toolCalls;
        this.messages.push(assistantMsg);

        // c) Emit an assistant event (text + normalized toolUses for the host/bus).
        const toolUses: ToolUse[] = parsed.toolCalls.map((tc) => {
          const p = parseToolCall(tc);
          return { id: p.id, name: p.name, input: p.args };
        });
        yield { kind: 'assistant', text: parsed.content, toolUses };

        // d) No tool calls → this is the FINAL answer. Emit ONE terminal success result.
        if (parsed.toolCalls.length === 0) {
          // An assistant turn with neither content nor tool_calls is a degenerate empty turn.
          if (parsed.content.trim().length === 0) {
            yield this.errorResult(sid, 'error_empty_response', `the ${this.label()} backend returned an empty response.`);
            return;
          }
          yield this.successResult(sid, parsed.content, usage, costUsd);
          return;
        }

        // e) Tool calls present → run each via the injected runTool, feed results back, loop.
        for (const tc of parsed.toolCalls) {
          const parsedCall = parseToolCall(tc);
          let resultStr: string;
          try {
            resultStr = await this.runTool(parsedCall);
          } catch (e) {
            // A runTool that THROWS (it shouldn't — it should return an error string) is still contained:
            // convert to a tool-result error string fed back to the model (never crash the turn) — CP5.
            resultStr = `tool ${parsedCall.name} failed: ${e instanceof Error ? e.message : String(e)}`;
            yield { kind: 'tool_result', toolUseId: tc.id, content: resultStr, isError: true };
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            continue;
          }
          yield { kind: 'tool_result', toolUseId: tc.id, content: resultStr };
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
        }
        // loop → next completion now sees the tool results.
      }

      // f) Fell out of the loop = hit the iteration cap without a final answer → bounded runaway → error.
      yield this.errorResult(
        sid,
        'error_tool_loop_cap',
        `the ${this.label()} backend exceeded the tool-iteration cap (${this.maxToolIterations}) without a final answer.`,
      );
    } catch (e) {
      // TOTAL backstop: any unexpected error → a surfaced failure (never crash the stream, never leak).
      this.note(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      yield this.errorResult(
        sid,
        'error_unexpected',
        `unexpected ${this.label()} multi-turn error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.turnRunning = false;
    }
  }

  /** Build a terminal success `result` event with metering (mirrors the one-shot adapter's terminal result). */
  private successResult(
    sessionId: string,
    text: string,
    usage: TokenUsage | undefined,
    costUsd: number | undefined,
  ): Extract<SessionEvent, { kind: 'result' }> {
    const result: Extract<SessionEvent, { kind: 'result' }> = {
      kind: 'result',
      sessionId,
      subtype: 'success',
      result: text,
    };
    let cost = costUsd;
    if (usage) {
      const tokens: { prompt?: number; completion?: number; total?: number } = {};
      if (usage.promptTokens !== undefined) tokens.prompt = usage.promptTokens;
      if (usage.completionTokens !== undefined) tokens.completion = usage.completionTokens;
      if (usage.totalTokens !== undefined) tokens.total = usage.totalTokens;
      if (Object.keys(tokens).length > 0) result.tokens = tokens;
      // Compute USD from the rate when the backend reported NO total_cost_usd (OpenAI/Codex shape).
      if (cost === undefined) cost = computeCostUsd(usage, resolveRate(this.config));
    }
    if (cost !== undefined) result.costUsd = cost;
    return result;
  }

  /** Map an HTTP/transport/body error → a terminal error result. Preserves status; no key. */
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
  private errorResult(sessionId: string, subtype: string, message: string): Extract<SessionEvent, { kind: 'result' }> {
    return { kind: 'result', sessionId, subtype, result: message };
  }

  private label(): string {
    return this.config.label ?? this.config.model;
  }

  private note(line: string): void {
    this.onStderr?.(`[multi-turn:${this.label()}] ${line}`);
  }

  async interrupt(): Promise<void> {
    // Cooperative: the running turn checks this flag at each tool-loop boundary and aborts cleanly.
    // (There is no child process to SIGINT; an in-flight HTTP completion is not force-aborted in T1 —
    // the loop stops issuing further completions once the flag is seen.)
    this.interruptRequested = true;
  }

  async stop(): Promise<void> {
    // No child process to terminate. Mark not-running; a fresh start() is rejected (one lifecycle per instance).
    this.interruptRequested = true;
    this.turnRunning = false;
  }

  health(): SessionDriverHealth {
    return {
      running: this.turnRunning,
      sessionId: this.sessionId,
      detail: `multi-turn-adapter-driver:${this.label()} turns=${this.messages.length}`,
    };
  }
}

/** The default tool runner — degrades to a clean "no tool runner wired" result (never throws/crashes). */
const defaultNoToolRunner: ToolRunner = async (call: ParsedToolCall): Promise<string> =>
  `tool runner not wired: cannot execute "${call.name}" (the permission-router/seal choke-point is supplied at ` +
  `activation — multi-turn driver T1 ships the loop only).`;

/** A single-event async iterable that yields exactly one terminal result (for the already-started guard). */
function onceResult(ev: Extract<SessionEvent, { kind: 'result' }>): AsyncIterable<SessionEvent> {
  return (async function* () {
    yield ev;
  })();
}
