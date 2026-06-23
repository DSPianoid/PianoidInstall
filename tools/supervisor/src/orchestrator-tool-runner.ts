/**
 * ORCHESTRATOR TOOL RUNNER (model-agnostic-orchestrator Tier-1, piece #4 — the SEALED
 * CHOKE-POINT) — the ONE primitive that executes a non-Claude orchestrator's coordinate
 * tool calls. It is the {@link ToolRunner} injected into the {@link MultiTurnAdapterDriver}'s
 * `runTool` seam (multi-turn-adapter-driver.ts:172,195): the driver NEVER touches a
 * child_process / network / registry directly — it only calls THIS runner, so the
 * unsealed/unrouted exec path is UNREPRESENTABLE (proposal §6.3 — "make the unsealed/unrouted
 * tool path unrepresentable; the driver gets ONLY a runTool callback that always goes through
 * the permission router + policy").
 *
 * THE TWO LOAD-BEARING CONTAINMENT GUARANTEES (asserted by tests):
 *   1. ALLOW-CHECK (§6.2). A tool call whose `name` is NOT one of the four coordinate tools
 *      ({@link isOrchestratorToolName} over `spawn_agent`/`agent_status`/`await_agent`/
 *      `cancel_agent`) is REJECTED — a clean tool-result error string is fed back to the model
 *      and NOTHING is executed. A hallucinated / unknown tool can never reach the registry or
 *      any side-effecting path; it is unrepresentable as an exec.
 *   2. PERMISSION FLOOR (§3.4, D-H). EVERY allow-listed coordinate call is submitted to the
 *      INJECTED {@link PermissionHandler} (in production: `sessionHost.permissionRouter.decide`
 *      — the SAME router, SAME orchestrator policy, SAME `routeWhen=isDestructiveOp` safety
 *      floor that gates the CLAUDE orchestrator's Bash/Edit). On `behavior:'deny'` the call is
 *      NOT executed; the deny message is fed back to the model as the tool result (so it can
 *      react), never thrown. Dangerous ops thus route to the user (block-on-reply, FC-1) for a
 *      non-Claude orchestrator EXACTLY as for Claude — the gate lives in the supervisor's tool
 *      layer, not in Claude Code.
 *
 * THE SEAL. The runner does NOT re-seal here: the registry's executor is the EXACT sealed
 * `dispatchRoleAgentWithFallback` closure index.ts already builds (role-router + backend seal +
 * the AgentConcurrencyGate spend/cost cap — async-dispatch-registry.ts:16-24). So a coordinate
 * call that the policy ALLOWS is dispatched into the SAME sealed + cost-capped + channel-mute
 * spawn path the campaign shipped (AP6). The runner's containment contribution is the
 * allow-check + the permission floor IN FRONT of that already-sealed primitive.
 *
 * CONCERN (P2 = one job): translate ONE OpenAI {@link ParsedToolCall} → (allow-check →
 * permission gate → the matching {@link AsyncDispatchRegistry} method) → a tool-result STRING.
 * It owns NO mutable state (a pure factory over injected deps); it does NOT own agent records
 * (the registry does — P1), decide policy (the router does — P1), seal (the executor does), or
 * touch the channel (the dispatched agents are channel-mute by construction — AP6).
 *
 * EVERYTHING IS A STRING, NEVER A THROW (CP5). The driver feeds whatever this returns back to
 * the model as the `{role:'tool', …}` content; a thrown runner would risk wedging the
 * orchestrator. So a rejected tool, a denied permission, a bad-args call, an unknown agentId,
 * and even an unexpected internal error ALL become a clear tool-result string. The
 * MultiTurnAdapterDriver also defends (it catches a thrown runTool — multi-turn-adapter-driver.ts:
 * 532-538), but this runner upholds the contract itself.
 *
 * SCOPE (T3): this module + its index.ts composition (construct the registry under the role-
 * routing gate; inject it into the Panel; build this runner). It is wired into NOTHING LIVE this
 * round — the driver is NOT constructed here (driver-selection-by-model is T4). T3 ships the
 * runner so T4 can hand it to the driver as `runTool`; the OFF/Claude path stays byte-for-byte.
 *
 * INJECTABLE: the registry + the permission handler are dependencies. TESTS inject a FAKE
 * permission router (a scripted handler — NO real channel round-trip, NO user prompt) and a fake
 * registry (NO real spawn, NO network, NO spend) — the allow-check, the routing, and the
 * deny-path are all testable behind the seam.
 *
 * Traces: proposal model-agnostic-orchestrator-tier1-2026-06-22 §3.1 (the runTool seam), §3.2
 * (the coordinate routing), §3.4 (piece #4 containment), §6.2 (allow-check), §6.3 (unrepresentable
 * unsealed path), D-H (same router/policy); CP3, CP4, CP5, CP6; AP3, AP4, AP6; FD1, FD2.
 */

import type { AsyncDispatchRegistry } from './async-dispatch-registry.js';
import type { ToolRunner, ParsedToolCall } from './multi-turn-adapter-driver.js';
import { ORCHESTRATOR_TOOL_NAMES, isOrchestratorToolName } from './orchestrator-tools.js';
import type { PermissionHandler } from './session-driver.js';

/** Options to build the orchestrator tool runner (the choke-point). */
export interface OrchestratorToolRunnerOptions {
  /** The async dispatch registry — the SOLE owner of agent records; the runner only reads/commands it. */
  registry: AsyncDispatchRegistry;
  /**
   * The permission handler — in production `sessionHost.permissionRouter.decide` (the SAME router +
   * orchestrator policy + safety floor that gates the Claude orchestrator). EVERY allow-listed
   * coordinate call is submitted here; a `deny` is fed back as a tool result, not executed.
   */
  permissionHandler: PermissionHandler;
  /** The session id (for permission-request correlation/logging). Optional. */
  sessionId?: string;
  /** Optional diagnostics sink (NEVER receives a secret). */
  onNote?: (line: string, fields?: Record<string, unknown>) => void;
}

/**
 * Build the {@link ToolRunner} the multi-turn driver calls for each tool the orchestrator
 * requests. The returned function applies the allow-check, the permission gate, then routes an
 * approved call to the registry — always returning a tool-result string (never throwing).
 */
export function createOrchestratorToolRunner(opts: OrchestratorToolRunnerOptions): ToolRunner {
  const { registry, permissionHandler, sessionId, onNote } = opts;

  return async function runTool(call: ParsedToolCall): Promise<string> {
    try {
      // 1) ALLOW-CHECK (containment §6.2): a non-coordinate / hallucinated tool name is REJECTED —
      //    fed back as a tool-result error, NEVER executed. This is the structural guarantee that an
      //    unknown tool cannot reach any side-effecting path.
      if (!isOrchestratorToolName(call.name)) {
        onNote?.('orchestrator tool runner: rejected unknown tool (allow-check)', { tool: call.name });
        return toolError(
          `unknown tool "${call.name}" — not one of the available coordinate tools ` +
            `(${Object.values(ORCHESTRATOR_TOOL_NAMES).join(', ')}). It was NOT executed.`,
        );
      }

      // 2) PERMISSION FLOOR (containment §3.4 / D-H): submit EVERY allow-listed call to the injected
      //    handler (the real router routes a dangerous op to the user and BLOCKS on reply). A deny →
      //    the call is NOT executed; the deny message is fed back so the model can react (never thrown).
      const decision = await permissionHandler({ toolName: call.name, input: call.args, ...(sessionId ? { sessionId } : {}) });
      if (decision.behavior === 'deny') {
        onNote?.('orchestrator tool runner: permission DENIED — not executed', { tool: call.name });
        return toolError(`permission denied for "${call.name}": ${decision.message} The action was NOT performed.`);
      }
      // A permission router may rewrite the input on allow (updatedInput) — honor it if present.
      const input = decision.updatedInput ?? call.args;

      // 3) ROUTE the approved call to the matching registry method → a tool-result string.
      return await dispatchToRegistry(registry, call.name, input, onNote);
    } catch (e) {
      // TOTAL backstop (CP5): any unexpected internal error becomes a clean tool-result string, never a throw.
      onNote?.('orchestrator tool runner: unexpected error (contained)', { tool: call.name, err: String(e) });
      return toolError(`tool "${call.name}" failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** Route an APPROVED coordinate call to its {@link AsyncDispatchRegistry} method + stringify the outcome. */
async function dispatchToRegistry(
  registry: AsyncDispatchRegistry,
  name: string,
  input: Record<string, unknown>,
  onNote?: (line: string, fields?: Record<string, unknown>) => void,
): Promise<string> {
  switch (name) {
    case ORCHESTRATOR_TOOL_NAMES.spawn: {
      const role = readString(input, 'role');
      const task = readString(input, 'task');
      const r = registry.spawn(role, task);
      onNote?.('orchestrator tool runner: spawn_agent', { role, ok: r.ok, agentId: r.agentId });
      if (!r.ok) return toolError(`spawn_agent failed: ${r.error ?? 'invalid request'}`);
      return toolOk({ agentId: r.agentId, state: 'running', note: 'sub-agent started; use await_agent or agent_status to collect its report.' });
    }

    case ORCHESTRATOR_TOOL_NAMES.status: {
      const agentId = readString(input, 'agentId');
      if (agentId.length === 0) return toolError('agent_status requires an agentId.');
      const status = registry.status(agentId);
      onNote?.('orchestrator tool runner: agent_status', { agentId, found: !!status });
      if (!status) return toolError(`agent_status: unknown agentId "${agentId}".`);
      return toolOk(status);
    }

    case ORCHESTRATOR_TOOL_NAMES.await: {
      const agentId = readString(input, 'agentId');
      if (agentId.length === 0) return toolError('await_agent requires an agentId.');
      const timeoutMs = readPositiveInt(input, 'timeoutMs');
      const r = await registry.awaitAgent(agentId, timeoutMs);
      onNote?.('orchestrator tool runner: await_agent', { agentId, state: r.state });
      if (r.state === 'unknown') return toolError(`await_agent: unknown agentId "${agentId}".`);
      if (r.state === 'timeout') {
        return toolOk({ state: 'timeout', agentId, note: 'the sub-agent is still running; await or poll it again.' });
      }
      return toolOk({ state: r.state, ...(r.status ? { agent: r.status } : {}) });
    }

    case ORCHESTRATOR_TOOL_NAMES.cancel: {
      const agentId = readString(input, 'agentId');
      if (agentId.length === 0) return toolError('cancel_agent requires an agentId.');
      const r = registry.cancel(agentId);
      onNote?.('orchestrator tool runner: cancel_agent', { agentId, ok: r.ok, state: r.state });
      if (!r.ok) return toolError(`cancel_agent: ${r.error ?? 'could not cancel'}${r.state ? ` (state: ${r.state})` : ''}.`);
      return toolOk({ state: r.state ?? 'cancelled', agentId, note: 'cancellation requested; the agent is marked cancelled.' });
    }

    default:
      // Unreachable: the allow-check already rejected every non-coordinate name. Defensive only.
      return toolError(`tool "${name}" is not routable.`);
  }
}

// ── helpers (pure) ─────────────────────────────────────────────────────────────────────

/** Read a string field defensively (`''` when absent / non-string). */
function readString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** Read a positive-integer field (e.g. timeoutMs); `undefined` when absent / non-positive / non-finite. */
function readPositiveInt(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return undefined;
}

/** A successful tool result — a compact JSON string the model reads as the tool's output. (Accepts any
 *  object payload — an interface like AgentStatus lacks an index signature, so `object` not Record.) */
function toolOk(payload: object): string {
  return JSON.stringify({ ok: true, ...payload });
}

/** A failed tool result — a compact JSON string (the model sees `ok:false` + a reason, and can react). */
function toolError(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}
