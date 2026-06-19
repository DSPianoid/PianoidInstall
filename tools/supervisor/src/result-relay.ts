/**
 * AGENT DISPATCH RESULT-RELAY (M6) — return a finished routed agent's structured
 * result to the ORCHESTRATOR (never the channel — AP6).
 *
 * This is the glue that proves the contract END-TO-END (P1): it ties the router (M2)
 * + registry (M3) + seal (M4) together, drives the resulting {@link SessionDriver}
 * with the SEALED start options, consumes the normalized {@link SessionEvent} stream,
 * and maps the terminal `result` event into an {@link AgentReport} — the SAME
 * onResult-shaped text the orchestrator already relays for an in-process sub-agent's
 * final report (session-host.ts onResult). The agent is CHANNEL-MUTE by construction:
 * this module has NO channel/`send` reference at all — it returns a report to its
 * caller (the orchestrator), which decides what (if anything) the user sees.
 *
 * Concern (P2 = one job): run ONE sealed agent to completion + map its terminal
 * result → a structured report. It owns no policy, no channel, no permission routing
 * (the driver's onPermission handles gated tools), no lifecycle restart (a routed
 * agent is one-shot here; restart/fallback is X1/FD6, a later phase).
 *
 * Traces: proposal AP6, CP1, CP3; §M M6; PART P P1.
 */

import { resolveRoleBackend, type RoleDispatchOverride, type RoleRouterConfig } from './role-router.js';
import { sealBackendOptions } from './backend-seal.js';
import { BackendRegistry } from './backend-registry.js';
import type { BackendSelection, Role } from './backend-kinds.js';
import type { SessionEvent, SessionStartOptions } from './session-driver.js';

/** The structured report a routed agent returns to the orchestrator (NOT to the channel). */
export interface AgentReport {
  /** The role that was dispatched. */
  role: Role | string;
  /** The backend that ran it. */
  backend: BackendSelection['backend'];
  /** Terminal outcome subtype from the `result` event ('success' or an error subtype). */
  subtype: string;
  /** True when subtype === 'success'. */
  ok: boolean;
  /** The agent's final report text (the `result.result` field), if any. */
  text?: string;
  /** Total cost in USD, if the backend reported it. */
  costUsd?: number;
  /** The session id (for resume/attribution). */
  sessionId?: string;
}

/**
 * Map a terminal `result` {@link SessionEvent} → an {@link AgentReport}. Pure. This is
 * the SAME field mapping the orchestrator's onResult uses (result.result → the relayed
 * text). Exported so the mapping is unit-tested without driving a stream.
 */
export function mapResultEventToReport(
  selection: BackendSelection,
  ev: Extract<SessionEvent, { kind: 'result' }>,
): AgentReport {
  const report: AgentReport = {
    role: selection.role,
    backend: selection.backend,
    subtype: ev.subtype,
    ok: ev.subtype === 'success',
  };
  if (ev.result !== undefined) report.text = ev.result;
  if (ev.costUsd !== undefined) report.costUsd = ev.costUsd;
  if (ev.sessionId) report.sessionId = ev.sessionId;
  return report;
}

/** Thrown when a routed agent's stream ended with NO terminal `result` event (a crash). */
export class AgentDispatchError extends Error {
  readonly selection: BackendSelection;
  constructor(selection: BackendSelection, detail: string) {
    super(`agent-dispatch: ${detail} (role=${String(selection.role)}, backend=${selection.backend})`);
    this.name = 'AgentDispatchError';
    this.selection = selection;
  }
}

/** Options to dispatch one routed agent. */
export interface DispatchRoleAgentOptions {
  /** The role to dispatch. */
  role: Role | string;
  /** The task text the agent runs (becomes its first user turn / bootstrap). */
  task: string;
  /** The backend registry (M3) that constructs the driver. */
  registry: BackendRegistry;
  /** The role-routing config (M2) — role→backend map + optional default override. */
  config?: RoleRouterConfig;
  /** An explicit per-dispatch backend override (highest routing precedence). */
  override?: RoleDispatchOverride;
  /**
   * EXTRA start options merged into the SEALED options (e.g. cwd, model, onPermission).
   * The seal-relevant fields (settingSources, disallowedTools) are OVERRIDDEN by the
   * seal regardless of what is passed here — the seal always wins (CP3). `onPermission`
   * is required by the contract; a default deny-all is supplied if absent.
   */
  startOptions?: Partial<SessionStartOptions>;
  /** The env asserted key-free (claude-cli) / own-key-scoped (api-adapter) by the seal (default process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * For an api-adapter selection ONLY: the env var name of the backend's own metered key
   * (e.g. 'DEEPSEEK_API_KEY'), threaded to the seal so it scopes the foreign-key assertion
   * correctly. Ignored for claude-cli (subscription-billed — no own secret). Optional; when
   * omitted for an api-adapter, the seal treats EVERY known backend key as foreign.
   */
  ownSecretName?: string;
}

/**
 * Resolve + seal the start options for a dispatch WITHOUT running it. Pure-ish (the
 * seal asserts the env is key-free → throws on a billing key). Exposed so a test can
 * assert the SEALED options (settingSources, deny-list) independently of the stream.
 * Returns the selection + the sealed options.
 */
export function planRoleDispatch(
  opts: Pick<
    DispatchRoleAgentOptions,
    'role' | 'task' | 'config' | 'override' | 'startOptions' | 'env' | 'ownSecretName'
  >,
): { selection: BackendSelection; sealed: SessionStartOptions } {
  const selection = resolveRoleBackend(opts.role, opts.config, opts.override);
  // The base options: the caller's extras + the task as a bootstrap turn + the model
  // from the selection. onPermission defaults to deny-all (a routed agent has no human
  // at this layer; the orchestrator-level routing is wired by the caller when needed).
  const base: SessionStartOptions = {
    onPermission: opts.startOptions?.onPermission ?? (async () => ({ behavior: 'deny', message: 'routed agent: no permission handler' })),
    ...opts.startOptions,
    // The task is injected as the agent's first turn (bootstrap), unless the caller
    // already supplied bootstrapTurns.
    bootstrapTurns: opts.startOptions?.bootstrapTurns ?? [opts.task],
    // The selection's model wins unless the caller pinned one explicitly.
    ...(selection.model !== undefined && opts.startOptions?.model === undefined ? { model: selection.model } : {}),
  };
  const sealed = sealBackendOptions({
    backend: selection.backend,
    base,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.ownSecretName ? { ownSecretName: opts.ownSecretName } : {}),
  });
  return { selection, sealed };
}

/**
 * Dispatch ONE routed agent end-to-end and RETURN its structured {@link AgentReport}
 * to the caller (the orchestrator) — never to the channel (AP6 / channel-mute).
 *
 * Flow: resolve role→backend (M2) → seal the options (M4) → construct the driver (M3)
 * → drive it with the sealed options → consume the SessionEvent stream → on the
 * terminal `result` event, map it to a report and STOP the driver → return the report.
 * If the stream ends with no `result` (a crash), throws {@link AgentDispatchError}.
 *
 * This is the P1 proof: planning resolves to a sealed standalone claude agent that
 * runs and returns exactly one report.
 */
export async function dispatchRoleAgent(opts: DispatchRoleAgentOptions): Promise<AgentReport> {
  const { selection, sealed } = planRoleDispatch(opts);
  const driver = opts.registry.create(selection);

  let report: AgentReport | undefined;
  try {
    for await (const ev of driver.start(sealed)) {
      if (ev.kind === 'result') {
        report = mapResultEventToReport(selection, ev);
        break; // one result is the terminal event — done
      }
      // assistant/tool_result/system_init events are the agent's internal narration.
      // CHANNEL-MUTE: we do NOT forward them anywhere — only the terminal result is
      // relayed (as the report), exactly like an in-process sub-agent's final report.
    }
  } finally {
    // Always tear the driver down (kills the child + its tree for CliStreamDriver).
    await driver.stop().catch(() => undefined);
  }

  if (!report) throw new AgentDispatchError(selection, 'agent stream ended with no result event (crash)');
  return report;
}
