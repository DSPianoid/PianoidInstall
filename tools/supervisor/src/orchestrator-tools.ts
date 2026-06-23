/**
 * ORCHESTRATOR TOOL MANIFEST (model-agnostic-orchestrator Tier-1, piece #2) — the
 * OpenAI `tools[]` definitions a NON-Claude orchestrator is given so it can COORDINATE
 * work via TOOL CALLS instead of Claude-Code's in-process `SendMessage`/`Monitor`/`Task*`.
 *
 * This is the "teams" the proposal decomposes into three capabilities (§2.3):
 *   1. spawn a sub-agent       → {@link SPAWN_AGENT_TOOL}   (async, non-blocking)
 *   2. coordinate / monitor    → {@link AGENT_STATUS_TOOL} + {@link AWAIT_AGENT_TOOL}
 *   3. stop a sub-agent        → {@link CANCEL_AGENT_TOOL}
 * Each maps 1:1 to an async panel route ({@link AsyncDispatchRegistry} behind
 * `POST /api/dispatch/async` · `GET /api/dispatch/status` · `POST /api/dispatch/await` ·
 * `POST /api/dispatch/cancel`) — so the orchestrator's `runTool(name, args)` choke-point
 * (piece #4, wired at activation) routes a coordinate tool call to the matching loopback
 * REST endpoint, and the sealed sub-agents are the SAME channel-mute backends the campaign
 * already builds (AP6).
 *
 * SCOPE (T2): this file ships ONLY the tool DEFINITIONS — pure data, the `ToolSchema` shapes
 * the {@link MultiTurnAdapterDriver} accepts as its injected `tools` manifest. The WIRING (the
 * `runTool` that actually calls the panel routes, + handing this manifest to the orchestrator
 * driver) is T3. Defining the shapes now lets T3 wire a stable, unit-asserted contract; and it
 * lets a non-Claude orchestrator's tool calls be validated against a fixed schema in the
 * choke-point (an unknown tool / bad args → a tool-result error fed back, never executed — §6.2).
 *
 * The "ACT" tools (read/edit/shell/curl — proposal §3.1) are a SEPARATE manifest wired at T2/T4
 * of the driver build (they route through the SAME permission router + seal). This file is the
 * COORDINATE manifest only — the teams-replacement surface (piece #2).
 *
 * Traces: proposal model-agnostic-orchestrator-tier1-2026-06-22 §2.3, §3.1 (the manifest the
 * driver consumes), §3.2 (the new-tools table), D-B (OpenAI-native tool_calls); CP1, CP2; AP2,
 * AP6; FD1.
 */

import type { ToolSchema } from './multi-turn-adapter-driver.js';

/** The canonical tool names (single source of truth — the choke-point validates an incoming call against these). */
export const ORCHESTRATOR_TOOL_NAMES = {
  spawn: 'spawn_agent',
  status: 'agent_status',
  await: 'await_agent',
  cancel: 'cancel_agent',
} as const;

/**
 * spawn_agent — start a sealed sub-agent on a ROLE + TASK, NON-BLOCKING, and get a handle back
 * immediately (the `Task`/`Agent` spawn replacement). The agent runs under the supervisor's
 * role-router + seal + spend/cost gate; it is channel-mute (its report comes back via
 * await_agent/agent_status, never to the user directly). Routes to `POST /api/dispatch/async`.
 */
export const SPAWN_AGENT_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: ORCHESTRATOR_TOOL_NAMES.spawn,
    description:
      'Start a sub-agent to do a focused unit of work, asynchronously (non-blocking). Returns an ' +
      'agentId immediately; the sub-agent runs in the background under its routed backend. Use ' +
      'agent_status to poll it or await_agent to wait for its report. The sub-agent cannot talk to ' +
      'the user — only its final report comes back to you. Prefer dispatching heavy work (coding, ' +
      'analysis) to a sub-agent rather than doing it yourself.',
    parameters: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description:
            "The role to dispatch (e.g. 'coding', 'reviewing', 'analysis', 'planning'). The supervisor " +
            'routes the role to its configured backend (which may be Claude or a non-Claude model).',
        },
        task: {
          type: 'string',
          description:
            'The full task brief for the sub-agent — a self-contained instruction with all the context ' +
            'it needs, since it does not share your conversation.',
        },
      },
      required: ['role', 'task'],
    },
  },
};

/**
 * agent_status — poll one sub-agent's state (running | done | failed | cancelled) + its report when
 * settled (the `Monitor` replacement, non-blocking). Routes to `GET /api/dispatch/status?agentId=`.
 */
export const AGENT_STATUS_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: ORCHESTRATOR_TOOL_NAMES.status,
    description:
      "Check a sub-agent's current state (running, done, failed, or cancelled) and read its report " +
      'if it has finished. Non-blocking — returns immediately with whatever is known right now. Call ' +
      'spawn_agent first to get an agentId.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The handle returned by spawn_agent.' },
      },
      required: ['agentId'],
    },
  },
};

/**
 * await_agent — block up to a timeout for a sub-agent to finish, then return its report (the
 * blocking `Monitor` / "wait for the team" replacement). Routes to `POST /api/dispatch/await`.
 */
export const AWAIT_AGENT_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: ORCHESTRATOR_TOOL_NAMES.await,
    description:
      'Wait for a sub-agent to finish (up to an optional timeout in milliseconds) and return its ' +
      'final report. If the timeout elapses first, returns a "timeout" state and the sub-agent keeps ' +
      'running (you can await or poll it again). Use this to coordinate: dispatch one or more agents ' +
      'with spawn_agent, then await each to collect their reports.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The handle returned by spawn_agent.' },
        timeoutMs: {
          type: 'integer',
          description:
            'Maximum time to wait, in milliseconds. Omit for the server default. On timeout the agent is ' +
            'not stopped — it continues running.',
          minimum: 1,
        },
      },
      required: ['agentId'],
    },
  },
};

/**
 * cancel_agent — request a running sub-agent be stopped (the `TaskStop` replacement). Routes to
 * `POST /api/dispatch/cancel`. T2 is cooperative (marks the agent cancelled + detaches its result);
 * a true mid-flight kill is wired at activation.
 */
export const CANCEL_AGENT_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: ORCHESTRATOR_TOOL_NAMES.cancel,
    description:
      'Stop a running sub-agent you no longer need. Marks it cancelled; its result is discarded. A ' +
      'no-op if the agent has already finished. Call spawn_agent first to get an agentId.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The handle returned by spawn_agent.' },
      },
      required: ['agentId'],
    },
  },
};

/**
 * The full COORDINATE manifest — the teams-replacement tool set handed to a non-Claude orchestrator
 * as its `tools[]` (the {@link MultiTurnAdapterDriver}'s injected `tools`). Stable order (spawn,
 * status, await, cancel). T3 wires `runTool` to dispatch each to its panel route.
 */
export const ORCHESTRATOR_COORDINATE_TOOLS: ToolSchema[] = [
  SPAWN_AGENT_TOOL,
  AGENT_STATUS_TOOL,
  AWAIT_AGENT_TOOL,
  CANCEL_AGENT_TOOL,
];

/** True iff `name` is one of the coordinate tool names (the choke-point's allow-check — §6.2). */
export function isOrchestratorToolName(name: string): boolean {
  return (Object.values(ORCHESTRATOR_TOOL_NAMES) as string[]).includes(name);
}
