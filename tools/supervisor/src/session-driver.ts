/**
 * The SESSION DRIVER seam — the boundary between the supervisor's Phase-2 logic
 * and the Claude Code subprocess (driven via the Agent SDK `query()`).
 *
 * Why a seam (mirrors the Phase-1 transport seam): the `@anthropic-ai/claude-agent-sdk`
 * API has several doc-FLAGGED uncertainties (exact `canUseTool` return shape, the
 * streaming-input live-pump semantics, partial-message options, in-process MCP
 * config). Coding the lifecycle manager + permission router + stream-json→bus
 * mapping directly against `query()` would (a) couple all of Phase 2 to that
 * uncertain surface and (b) make it untestable without spawning a real subprocess.
 *
 * Instead, every component depends on this NORMALIZED `SessionDriver` interface.
 * Two implementations exist:
 *   - `SdkSessionDriver` (adapters/sdk-session-driver.ts): wraps the real
 *     `query()`, maps SDK messages → `SessionEvent`, adapts the SDK permission
 *     callback → our `PermissionHandler`. ALL the FLAGGED SDK API lives here.
 *   - `FakeSessionDriver` (test/helpers): deterministic + scriptable — emits
 *     scripted events, fires scripted permission requests, simulates kill/resume.
 *
 * Phase-2 logic (lifecycle, router, stream-json mapping, resume/health) is built
 * + tested against the FAKE; the SDK plugs in at this boundary.
 *
 * Traces: proposal PART E Phase 2 deliverables 1-4 + the Appendix SDK ledger.
 */

/** A tool the hosted session wants to use (subject of a permission decision). */
export interface ToolUse {
  /** Tool id (correlates a tool_use with its later tool_result). */
  id: string;
  /** Tool name (e.g. 'Bash', 'Edit', 'mcp__telegram__reply'). */
  name: string;
  /** The tool's input arguments. */
  input: Record<string, unknown>;
}

/**
 * A normalized event from the hosted session, mapped from the SDK's stream-json
 * message types. The lifecycle manager publishes these onto the I/O bus (→ capture
 * + channel outbound). Discriminated by `kind`.
 */
export type SessionEvent =
  | {
      kind: 'system_init';
      /** The session id the SDK assigned (for resume). */
      sessionId: string;
      model?: string;
      /** Tool names available to the session. */
      tools?: string[];
    }
  | {
      kind: 'assistant';
      /** Assembled assistant text (may be empty if the turn was only tool-use). */
      text: string;
      /** Tool uses the assistant requested in this turn. */
      toolUses: ToolUse[];
    }
  | {
      kind: 'tool_result';
      /** The tool_use id this result corresponds to. */
      toolUseId: string;
      /** Result content (stringified). */
      content: string;
      isError?: boolean;
    }
  | {
      kind: 'result';
      /** The session id (also carried here). */
      sessionId: string;
      /** Outcome: 'success' or an error subtype from the SDK. */
      subtype: string;
      /** The final assistant result text, on success. */
      result?: string;
      /** Total cost in USD, if reported. */
      costUsd?: number;
    };

/** A normalized inbound user turn injected into the session. */
export interface UserTurn {
  /** The user's text (already STT-transcribed for voice). */
  text: string;
}

/**
 * A permission request surfaced by the session before a gated tool runs. The
 * router decides allow/deny (and may route to a human first). This is the
 * normalized form of the SDK's `canUseTool` invocation.
 */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Session id, for correlation/logging. */
  sessionId?: string;
}

/** The router's decision for a permission request. */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * The callback the driver invokes for each gated tool. Async so the router can
 * route the decision to a human over a channel and AWAIT their reply (the FC-1
 * "block on the user's reply" guarantee).
 */
export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

/** Options to start a session. */
export interface SessionStartOptions {
  /** The system prompt = the M1 orchestrator role (string or undefined for SDK default). */
  systemPrompt?: string;
  /** Resume a prior session by id (FI restart). */
  resume?: string;
  /** The permission handler (the router). */
  onPermission: PermissionHandler;
  /** Working directory for the session. */
  cwd?: string;
  /** Model override. */
  model?: string;
  /** Allow-list fast-path tools passed to the SDK (router still gates the rest). */
  allowedTools?: string[];
}

/** Liveness of a driven session. */
export interface SessionDriverHealth {
  /** True while a session is running (between start() and the result/stop). */
  running: boolean;
  /** The captured session id (once system_init arrived), for resume. */
  sessionId?: string;
  /** Free-form detail. */
  detail?: string;
}

/**
 * The driver contract. The lifecycle manager owns ONE driver and re-`start()`s it
 * (with `resume`) on a crash. `start()` returns an async iterable of normalized
 * events; the manager consumes it and publishes to the bus.
 */
export interface SessionDriver {
  /**
   * Start (or resume) a session. Returns an async iterable of normalized events.
   * The iterable completes when the session ends (a `result` event) or stop() is
   * called. Throws if the underlying subprocess fails to start.
   */
  start(opts: SessionStartOptions): AsyncIterable<SessionEvent>;

  /** Inject a user turn into the running session. */
  send(turn: UserTurn): Promise<void>;

  /**
   * Interrupt the current turn (cooperative). The SdkSessionDriver forwards this
   * to the live `query().interrupt()`.
   *
   * TODO(H2 / m12-phase3): no caller wires this to a HANG WATCHDOG yet — nothing
   * currently detects a turn that runs too long and calls interrupt()/restart. A
   * stuck turn today is only bounded by the SDK's own maxTurns/budget and the
   * permission-reply timeout, not by a host-side watchdog. Wire a per-turn
   * deadline → interrupt() (then the FI restart path) in the Phase-3 cut-over,
   * where the supervisor owns the live channel and a wedged turn is user-visible.
   */
  interrupt(): Promise<void>;

  /** Stop + dispose the session/subprocess. Safe to call when not running. */
  stop(): Promise<void>;

  /** Current health snapshot. */
  health(): SessionDriverHealth;
}
