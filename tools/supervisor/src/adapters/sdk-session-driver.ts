/**
 * The REAL SessionDriver — wraps the official `@anthropic-ai/claude-agent-sdk`
 * `query()`. This is the ONE file coupled to the SDK's API; all the doc-FLAGGED
 * uncertainties (exact `canUseTool` return shape, streaming-input pump,
 * partial-message options) are confined here, behind the SessionDriver seam.
 *
 * Mapping (SDK stream-json message → normalized SessionEvent):
 *   {type:'system', subtype:'init', session_id, model, tools}  → system_init
 *   {type:'assistant', message:{content:[…]}}                  → assistant (text + tool_use[])
 *   tool_result blocks (in assistant content)                  → tool_result
 *   {type:'result', subtype, session_id, result, total_cost_usd} → result
 *
 * Multi-turn input: `query({ prompt })` accepts `string | AsyncIterable<...>`. To
 * inject user turns over time we pass an async-iterable backed by an internal
 * queue; `send()` pushes onto it.
 *
 * Permissions: the SDK `canUseTool` option is adapted to our PermissionHandler.
 * The exact SDK return shape is FLAGGED, so we normalize both the call and the
 * return defensively.
 *
 * ⚠️ Constructing + starting this spawns a real Claude Code subprocess. The
 * supervisor only does so for its OWN driven session (additive). It is NEVER the
 * production orchestrator (Phase-3 cut-over is separate).
 *
 * Traces: proposal PART E Phase 2 deliverable 1 + Appendix SDK ledger.
 */

import type {
  PermissionDecision,
  PermissionHandler,
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  ToolUse,
  UserTurn,
} from '../session-driver.js';

/**
 * Minimal structural view of the SDK surface we use. We deliberately keep these
 * loose (the exact SDK types are doc-FLAGGED) and validate fields at runtime. The
 * real `query` is injected (default = dynamic import of the package) so this file
 * is import-safe even when the SDK isn't installed (tests use the fake driver).
 */
export interface SdkQueryFn {
  (args: { prompt: unknown; options?: Record<string, unknown> }): AsyncIterable<unknown> & {
    interrupt?: () => void;
    close?: () => void;
  };
}

export interface SdkSessionDriverOptions {
  /**
   * Inject the SDK `query` (for tests/alternate wiring). If omitted, the driver
   * dynamically imports `@anthropic-ai/claude-agent-sdk` on first start().
   */
  queryFn?: SdkQueryFn;
}

/**
 * One streaming-input item fed to `query({ prompt })`.
 *
 * ✔ VERIFIED against the installed SDK's own types (the live demo crash measured
 * this): each item MUST be an `SDKUserMessageContent` —
 *   `node_modules/@anthropic-ai/claude-agent-sdk/.../sdk/coreTypes.d.ts:396`
 *   `{ type:'user'; message: APIUserMessage; parent_tool_use_id: string|null }`
 * where `APIUserMessage = MessageParam` = `{ role:'user'; content: string|… }`.
 *
 * The earlier shape `{ type:'user', content }` (no `message`, no
 * `parent_tool_use_id`) was rejected by the SDK's stream-json input pump → the
 * `query()` generator threw on the first injected turn → the lifecycle treated it
 * as a crash and restarted, dropping the turn (no reply). `session_id` is declared
 * `string` on `SDKUserMessage` but is assigned by the SDK for streaming input — we
 * send `''` (the SDK fills the real id from the active session).
 */
export interface SdkUserTurn {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

/**
 * Build the correct streaming-input envelope for a plain-text user turn.
 *
 * Exported so the FakeSessionDriver can assert the driver's contract on the turn
 * shape (the FIDELITY guard — the original `{type,content}` bug escaped precisely
 * because the Fake never validated the envelope the real SDK requires).
 */
export function makeUserTurn(content: string): SdkUserTurn {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
}

/**
 * Runtime contract check on a streaming-input turn — throws if the envelope is
 * not the SDK-required shape. Used by `push()` (defensive) AND re-exported for the
 * Fake to enforce the same contract its production counterpart must satisfy.
 */
export function assertValidUserTurn(item: unknown): asserts item is SdkUserTurn {
  const t = item as Record<string, unknown>;
  const msg = t?.['message'] as Record<string, unknown> | undefined;
  if (
    !t ||
    t['type'] !== 'user' ||
    typeof msg !== 'object' ||
    msg === null ||
    msg['role'] !== 'user' ||
    typeof msg['content'] !== 'string' ||
    !('parent_tool_use_id' in t)
  ) {
    throw new Error(
      `sdk session driver: malformed user turn envelope (need { type:'user', message:{ role:'user', content:string }, parent_tool_use_id }); got ${JSON.stringify(item)}`,
    );
  }
}

/**
 * An async queue that yields pushed items; used as the streaming `prompt` input.
 * If the SDK ever wants a different envelope, ONLY `makeUserTurn` + this class +
 * `send()` change — the seam keeps the blast radius to this file.
 */
class TurnQueue implements AsyncIterable<SdkUserTurn> {
  private readonly buffer: SdkUserTurn[] = [];
  private resolveNext: ((v: IteratorResult<SdkUserTurn>) => void) | null = null;
  private done = false;

  push(content: string): void {
    const item = makeUserTurn(content);
    assertValidUserTurn(item); // defensive: never feed the SDK a malformed envelope
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.done = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserTurn> {
    return {
      next: (): Promise<IteratorResult<SdkUserTurn>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => (this.resolveNext = resolve));
      },
    };
  }
}

export class SdkSessionDriver implements SessionDriver {
  private readonly queryFnOverride?: SdkQueryFn;
  private queue: TurnQueue | null = null;
  private activeQuery: (AsyncIterable<unknown> & { interrupt?: () => void; close?: () => void }) | null = null;
  private running = false;
  private sessionId: string | undefined;

  constructor(opts: SdkSessionDriverOptions = {}) {
    this.queryFnOverride = opts.queryFn;
  }

  private async resolveQueryFn(): Promise<SdkQueryFn> {
    if (this.queryFnOverride) return this.queryFnOverride;
    // Dynamic import via an indirect specifier so the optional SDK dep does not
    // have to be installed for this file to TYPE-CHECK or load (tests inject a
    // fake driver; the SDK is resolved only at real runtime). The package is an
    // optionalDependency in package.json.
    const pkg = '@anthropic-ai/claude-agent-sdk';
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod = (await dynamicImport(pkg)) as { query?: SdkQueryFn };
    if (typeof mod.query !== 'function') {
      throw new Error(`${pkg}: query() not found (is the optional dependency installed?)`);
    }
    return mod.query;
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    const self = this;
    this.queue = new TurnQueue();
    this.running = true;

    async function* gen(): AsyncGenerator<SessionEvent> {
      const queryFn = await self.resolveQueryFn();
      const options: Record<string, unknown> = {
        canUseTool: self.adaptPermission(opts.onPermission),
        ...(opts.systemPrompt ? { systemPrompt: self.mapSystemPrompt(opts.systemPrompt) } : {}),
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
        ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
        ...(opts.settingSources ? { settingSources: opts.settingSources } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      };
      // Inject any bootstrap turns (e.g. '/orchestrator') BEFORE the run starts so
      // the session adopts its role on the first turn, ahead of real user input.
      for (const t of opts.bootstrapTurns ?? []) self.queue!.push(t);
      self.activeQuery = queryFn({ prompt: self.queue, options });
      try {
        for await (const raw of self.activeQuery) {
          const ev = self.mapMessage(raw);
          if (ev) {
            if (ev.kind === 'system_init') self.sessionId = ev.sessionId;
            if (ev.kind === 'result') self.sessionId = ev.sessionId;
            yield ev;
          }
        }
      } finally {
        self.running = false;
      }
    }
    return gen();
  }

  /**
   * Map our systemPrompt union to the SDK shape. A plain string passes through;
   * the `{ preset:'claude_code', append }` form becomes the SDK's preset object
   * (keep Claude Code's own prompt + append the supervisor/orchestrator preamble).
   */
  private mapSystemPrompt(sp: string | { preset: 'claude_code'; append?: string }): unknown {
    if (typeof sp === 'string') return sp;
    return { type: 'preset', preset: sp.preset, ...(sp.append ? { append: sp.append } : {}) };
  }

  /**
   * Adapt our PermissionHandler to the SDK `canUseTool` callback.
   *
   * ⚠️ FLAGGED ASSUMPTION (canUseTool signature + return shape). The docs confirm
   * `canUseTool` is an async callback returning allow/deny, but do NOT pin its
   * exact argument list or return object. We assume:
   *   - args: `(toolName: string, input: object)` — if the SDK actually passes a
   *     single `{ toolName, input, … }` object or extra args, ONLY this adapter
   *     changes (the router + everything else are insulated).
   *   - return: `{ behavior: 'allow', updatedInput }` / `{ behavior: 'deny',
   *     message }` — the documented form. We always echo `updatedInput` on allow
   *     (defaults to the original input) since some SDK versions require it.
   * Verify against the live SDK in the Phase-2/3 shakedown; adjust here only.
   */
  private adaptPermission(handler: PermissionHandler) {
    return async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
      const decision: PermissionDecision = await handler({
        toolName,
        input: input ?? {},
        sessionId: this.sessionId,
      });
      if (decision.behavior === 'allow') {
        return decision.updatedInput
          ? { behavior: 'allow', updatedInput: decision.updatedInput }
          : { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: decision.message };
    };
  }

  /**
   * Map an SDK stream-json message (structural) to a normalized SessionEvent.
   *
   * ⚠️ FLAGGED ASSUMPTION (message field names). Based on the documented
   * stream-json shapes: `system`/`subtype:'init'` carries `session_id`/`model`/
   * `tools`; `assistant` embeds `message.content[]` with `text`/`tool_use` blocks;
   * `result` carries `subtype`/`session_id`/`result`/`total_cost_usd`. We read
   * defensively (missing fields → undefined, never throw) and IGNORE message
   * types we don't model (user echoes, partials, unknown). `includePartialMessages`
   * (token deltas) is NOT consumed — a deferred Phase-2 follow-up. If a field is
   * named differently in the installed SDK, fix it HERE only.
   */
  private mapMessage(raw: unknown): SessionEvent | null {
    const m = raw as Record<string, unknown>;
    const type = m['type'];
    // ★ FLOOD FIX (2026-06-19) — parity with cli-stream-driver.mapCliMessage: DROP
    // SUB-AGENT (sidechain) content. A sub-agent's (Agent/Task) assistant narration rides
    // the same stream tagged with a non-null `parent_tool_use_id`; without this guard each
    // line a background agent narrates is forwarded to the channel (the flood). The
    // orchestrator's OWN messages (parent null/absent) — incl. the spawning Agent tool_use —
    // pass through. (This is the HEDGE driver, not active; fixed for parity so a future
    // --driver sdk flip doesn't reintroduce the flood.)
    if (m['parent_tool_use_id'] != null) return null;
    if (type === 'system' && m['subtype'] === 'init') {
      const slashRaw = m['slash_commands'] ?? m['slashCommands'] ?? m['commands'];
      const mcpRaw = m['mcp_servers'] ?? m['mcpServers'];
      return {
        kind: 'system_init',
        sessionId: String(m['session_id'] ?? ''),
        model: m['model'] != null ? String(m['model']) : undefined,
        tools: Array.isArray(m['tools']) ? (m['tools'] as unknown[]).map(String) : undefined,
        slashCommands: Array.isArray(slashRaw)
          ? (slashRaw as unknown[]).map((c) => String((c as { name?: string })?.name ?? c))
          : undefined,
        mcpServers: Array.isArray(mcpRaw)
          ? (mcpRaw as unknown[]).map((s) => String((s as { name?: string })?.name ?? s)).filter(Boolean)
          : undefined,
      };
    }
    if (type === 'assistant') {
      const msg = (m['message'] ?? {}) as Record<string, unknown>;
      const content = Array.isArray(msg['content']) ? (msg['content'] as Record<string, unknown>[]) : [];
      let text = '';
      const toolUses: ToolUse[] = [];
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') text += block['text'];
        else if (block['type'] === 'tool_use') {
          toolUses.push({
            id: String(block['id'] ?? ''),
            name: String(block['name'] ?? ''),
            input: (block['input'] as Record<string, unknown>) ?? {},
          });
        }
      }
      return { kind: 'assistant', text, toolUses };
    }
    if (type === 'result') {
      return {
        kind: 'result',
        sessionId: String(m['session_id'] ?? this.sessionId ?? ''),
        subtype: String(m['subtype'] ?? 'success'),
        result: typeof m['result'] === 'string' ? (m['result'] as string) : undefined,
        costUsd: typeof m['total_cost_usd'] === 'number' ? (m['total_cost_usd'] as number) : undefined,
      };
    }
    // user/tool_result/partial/unknown → ignored at this layer (kept minimal).
    return null;
  }

  async send(turn: UserTurn): Promise<void> {
    if (!this.queue) throw new Error('sdk session driver: not started');
    this.queue.push(turn.text);
  }

  async interrupt(): Promise<void> {
    this.activeQuery?.interrupt?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue?.close();
    this.activeQuery?.close?.();
    this.activeQuery = null;
  }

  health(): SessionDriverHealth {
    return { running: this.running, sessionId: this.sessionId, detail: 'sdk-session-driver' };
  }
}
