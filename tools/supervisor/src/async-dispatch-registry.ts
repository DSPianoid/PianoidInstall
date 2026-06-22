/**
 * ASYNC DISPATCH REGISTRY (model-agnostic-orchestrator Tier-1, piece #2 — the
 * teams-replacement) — track each ASYNC-spawned routed agent so a non-Claude
 * orchestrator can run SEVERAL sealed sub-agents concurrently and observe them via
 * TOOL CALLS (spawn / status / await / cancel), instead of Claude-Code's in-process
 * `SendMessage`/`Monitor`/`Task*`.
 *
 * It is the small generalization the proposal calls for (§3.2): the live
 * `POST /api/dispatch` → `SessionHost.dispatchRole` is BLOCKING + fire-and-await-one;
 * this registry turns that SAME executor into a non-blocking "run several and observe"
 * surface. The ONLY net-new state is a `Map<agentId, AgentRecord>` — this object is its
 * SOLE owner (P1: every mutation goes through a method here; nothing else writes a record).
 *
 * CONCERN (P2 = one job): own the async-agent lifecycle bookkeeping — assign an id,
 * record running/done/failed/cancelled + the result/error + timestamps, and answer
 * status/await/cancel. It does NOT:
 *   - spawn or seal an agent itself (it calls the INJECTED executor — the EXACT
 *     `RoleDispatchFn` closure index.ts already builds for the sync surface, which carries
 *     the role-router + seal + the AgentConcurrencyGate spend/cost cap);
 *   - own the spend ledger (the gate does — already wired into the executor; this registry
 *     adds NO new authority over spend);
 *   - touch the channel (the dispatched agents are channel-mute by construction — AP6; the
 *     registry has no channel/`send` reference at all, like result-relay);
 *   - decide routing policy (the executor + role-router do).
 *
 * DORMANT-BY-DEFAULT (the campaign's additive/default-OFF discipline, CP5): this registry is
 * constructed + wired ONLY when role-routing is activated — the SAME gate as the sync
 * `dispatchRole` capability (index.ts builds the executor only under `SUPERVISOR_ROLE_ROUTING`).
 * When it is not wired, the async panel routes report `{ok:false, enabled:false}` and nothing
 * here runs (the live path is byte-for-byte today).
 *
 * CONTAINMENT — the executor NEVER throws for an agent-level failure (it returns `ok:false`);
 * the registry treats a thrown executor as a contained failure too (records `failed` with the
 * error text), so a misbehaving executor can never wedge the orchestrator (CP5). `cancel` is
 * COOPERATIVE in T2: the live executor (`dispatchRoleAgentWithFallback`) runs to completion
 * with no external abort handle, so cancel marks the record `cancelled` + DETACHES its result
 * (status/await then report `cancelled`); a true mid-flight `driver.stop()` kill is supplied at
 * wiring time via the OPTIONAL injected `cancelFn` seam (a T3/activation concern — NOT faked here).
 *
 * INJECTABLE: the executor + the id/clock generators are dependencies. TESTS inject a FAKE
 * executor (a scripted `RoleDispatchFn` — NO real claude spawn, NO network, NO spend) and pin
 * the id/clock deterministically — the whole async lifecycle is testable behind the seam.
 *
 * Traces: proposal model-agnostic-orchestrator-tier1-2026-06-22 §3.2 (piece #2), §4 T3, D-D,
 * D-E; CP1, CP3, CP5, CP6; AP2, AP6; FD1, FD6. Extends the live `POST /api/dispatch` /
 * `SessionHost.dispatchRole` (P-B1) into async coordinate/monitor/await/cancel.
 */

import type { RoleDispatchResult } from './session-host.js';

/** The lifecycle state of one async-spawned agent. */
export type AgentRunState = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The injected executor — the ONE primitive the registry calls to actually run a routed agent.
 * This is the EXACT {@link RoleDispatchFn} shape `SessionHost`/index.ts already use for the sync
 * surface (`(role, task) => Promise<RoleDispatchResult>`), so an async dispatch goes through the
 * IDENTICAL role-router + seal + AgentConcurrencyGate (spend/cost cap) path — no second mechanism.
 * NEVER expected to throw for an agent-level failure (it returns `ok:false`); a thrown executor is
 * still contained by the registry (recorded as `failed`).
 */
export type AsyncDispatchExecutor = (role: string, task: string) => Promise<RoleDispatchResult>;

/**
 * OPTIONAL cancel seam (supplied at wiring time — T3/activation). When provided, {@link AsyncDispatchRegistry.cancel}
 * calls it to request a true mid-flight stop of the agent's driver (the proposal's "reuse `driver.stop()`").
 * Best-effort + must not throw to matter; the registry marks the record `cancelled` regardless. T2 ships
 * the cooperative mark-and-detach behavior; this is where the real kill plugs in without changing the registry.
 */
export type AsyncDispatchCanceller = (agentId: string) => void | Promise<void>;

/** A snapshot of one async agent's record (what `status`/`list` return — a copy, never the live record). */
export interface AgentStatus {
  /** The opaque handle the spawn returned. */
  agentId: string;
  /** The role that was dispatched. */
  role: string;
  /** The task text the agent runs (echoed for the orchestrator's own bookkeeping). */
  task: string;
  /** running | done | failed | cancelled. */
  state: AgentRunState;
  /** The backend that ran it ('claude-cli' | 'api-adapter' | …), once known from the report. */
  backend?: string;
  /** The agent's final report text — present when done OR when a failed agent returned a failure message. */
  report?: string;
  /** A failure summary — present when state==='failed'. */
  error?: string;
  /** Total cost in USD, if the backend reported/computed it. */
  costUsd?: number;
  /** True iff a configured fallback backend actually ran (FD6). */
  fellBack?: boolean;
  /** ms-epoch when the agent was spawned. */
  createdAt: number;
  /** ms-epoch when the agent settled (done/failed/cancelled); absent while running. */
  finishedAt?: number;
}

/** The outcome of {@link AsyncDispatchRegistry.spawn}. */
export interface SpawnResult {
  /** True iff a handle was issued (a valid role+task). */
  ok: boolean;
  /** The new agent's handle (present iff ok). */
  agentId?: string;
  /** A short failure reason when !ok (an empty role/task) — surfaced to the caller, never thrown. */
  error?: string;
}

/** The outcome of {@link AsyncDispatchRegistry.awaitAgent}. */
export interface AwaitResult {
  /** The agent's state at the moment await returned ('timeout' when the deadline elapsed first). */
  state: AgentRunState | 'timeout' | 'unknown';
  /** The full status snapshot when the agent is known (absent for 'unknown'). */
  status?: AgentStatus;
}

/** Options to construct an {@link AsyncDispatchRegistry}. */
export interface AsyncDispatchRegistryOptions {
  /** The executor (the RoleDispatchFn closure index.ts builds at activation). Required. */
  executor: AsyncDispatchExecutor;
  /** OPTIONAL real mid-flight canceller (T3/activation). Absent ⇒ cooperative mark-and-detach only. */
  cancelFn?: AsyncDispatchCanceller;
  /** Injectable id generator (tests pin it). Default = a time+random handle. */
  idFn?: () => string;
  /** Injectable clock (tests pin it). Default = Date.now. */
  nowFn?: () => number;
  /**
   * Default await timeout in ms when a caller omits one (bounds a "wait for the team" tool call).
   * Default 60_000. A caller may pass any positive value per-await.
   */
  defaultAwaitTimeoutMs?: number;
}

/** The live (internal) record — a superset of {@link AgentStatus} with the settle gate the awaiters race. */
interface InternalRecord {
  status: AgentStatus;
  /**
   * Resolves (never rejects) the FIRST time the agent reaches a terminal state — done/failed/cancelled.
   * Awaiters race this. Resolved by {@link AsyncDispatchRegistry.toTerminal}, driven by BOTH the
   * executor's resolution ({@link AsyncDispatchRegistry.onSettle}) AND the cooperative cancel path — so
   * a cancel settles awaiters even though the executor keeps running with no abort handle (T2).
   */
  settled: Promise<void>;
  /** The resolver for {@link InternalRecord.settled} (called once by toTerminal). */
  resolveSettled: () => void;
  /** True once the record has reached a terminal state (so a late settle/cancel is a no-op — idempotent). */
  terminal: boolean;
}

const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;

/**
 * The async dispatch registry. One instance per hosted orchestrator session (wired only when
 * role-routing is active). Sole owner of the `Map<agentId, InternalRecord>` (P1).
 */
export class AsyncDispatchRegistry {
  private readonly executor: AsyncDispatchExecutor;
  private readonly cancelFn?: AsyncDispatchCanceller;
  private readonly idFn: () => string;
  private readonly nowFn: () => number;
  private readonly defaultAwaitTimeoutMs: number;

  /** The registry's sole-owned state (P1: every write is a method on this class). */
  private readonly agents = new Map<string, InternalRecord>();
  /** Monotonic counter to make ids unique even if the clock/random collide. */
  private seq = 0;

  constructor(opts: AsyncDispatchRegistryOptions) {
    this.executor = opts.executor;
    if (opts.cancelFn) this.cancelFn = opts.cancelFn;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.idFn =
      opts.idFn ?? (() => `agt-${this.nowFn().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.defaultAwaitTimeoutMs = opts.defaultAwaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  }

  /**
   * Spawn a routed agent ASYNCHRONOUSLY: validate, record it `running`, FIRE the executor without
   * awaiting, and return a handle IMMEDIATELY (non-blocking — replaces the in-process Task/Agent
   * spawn). The agent runs under the SAME sealed executor (role-router + seal + spend/cost gate).
   * A bad role/task is reported as `{ok:false}` (never thrown). The executor's settle (success,
   * `ok:false` failure, OR a thrown executor) updates the record exactly once.
   */
  spawn(role: string, task: string): SpawnResult {
    const roleNorm = (role ?? '').trim();
    if (roleNorm.length === 0) return { ok: false, error: 'a role is required' };
    if ((task ?? '').trim().length === 0) return { ok: false, error: 'a task is required' };

    const agentId = this.nextId();
    const createdAt = this.nowFn();
    const status: AgentStatus = { agentId, role: roleNorm, task, state: 'running', createdAt };

    // The settle GATE the awaiters race — resolved exactly once by toTerminal (driven by EITHER the
    // executor's resolution OR the cooperative cancel path; P1: only those writers mutate the record).
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.agents.set(agentId, { status, settled, resolveSettled, terminal: false });

    // Fire the executor WITHOUT awaiting (non-blocking spawn). Its resolution updates the record via
    // onSettle. A thrown executor is contained (recorded as `failed`); a rejection never escapes.
    void this.executor(roleNorm, task).then(
      (result) => this.onSettle(agentId, result, undefined),
      (err) => this.onSettle(agentId, undefined, err),
    );

    return { ok: true, agentId };
  }

  /** A snapshot of one agent's status (a COPY — the live record is never handed out). `undefined` if unknown. */
  status(agentId: string): AgentStatus | undefined {
    const rec = this.agents.get(agentId);
    return rec ? { ...rec.status } : undefined;
  }

  /** A snapshot of EVERY tracked agent (copies), most-recently-created first. */
  list(): AgentStatus[] {
    return [...this.agents.values()].map((r) => ({ ...r.status })).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Block up to `timeoutMs` for the agent to settle (the model's "wait for the team" tool). Returns
   * the agent's terminal state + a status snapshot, OR `{state:'timeout'}` if the deadline elapsed
   * first (the agent keeps running — a later await/status still sees it), OR `{state:'unknown'}` for
   * an unknown id. Already-terminal agents return immediately. The timeout timer is cleared the instant
   * either the settle or the deadline wins, so it never leaks past the await.
   */
  async awaitAgent(agentId: string, timeoutMs?: number): Promise<AwaitResult> {
    const rec = this.agents.get(agentId);
    if (!rec) return { state: 'unknown' };
    if (rec.terminal) return { state: rec.status.state, status: { ...rec.status } };

    const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : this.defaultAwaitTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      // NOT unref'd: while a caller is awaiting this, the timer is the thing that resolves the await on a
      // timeout — unref'ing it would let the process exit before it fires (the await would never settle).
      // It is always cleared the instant EITHER racer wins (below), so it never leaks past the await.
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    const settledOutcome = rec.settled.then(() => 'settled' as const);

    const winner = await Promise.race([settledOutcome, timeout]);
    if (timer) clearTimeout(timer);
    if (winner === 'timeout') return { state: 'timeout' };
    // settled — read the (now terminal) snapshot.
    return { state: rec.status.state, status: { ...rec.status } };
  }

  /**
   * Request cancellation of a running agent (replaces `TaskStop`). COOPERATIVE in T2: marks the
   * record `cancelled` (only if still running), settles its awaiters, and DETACHES the executor's
   * eventual result (a late onSettle for a cancelled record is a no-op). When a real `cancelFn` is
   * wired (T3/activation), it is also invoked to stop the agent's driver (best-effort; the mark
   * happens regardless). A no-op for an unknown or already-terminal agent. Never throws.
   */
  cancel(agentId: string): { ok: boolean; state?: AgentRunState; error?: string } {
    const rec = this.agents.get(agentId);
    if (!rec) return { ok: false, error: 'unknown agentId' };
    if (rec.terminal) return { ok: false, state: rec.status.state, error: `agent already ${rec.status.state}` };

    // Best-effort real kill (T3/activation). Swallow any throw/rejection — the cooperative mark stands.
    if (this.cancelFn) {
      try {
        const maybe = this.cancelFn(agentId);
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') (maybe as Promise<void>).catch(() => undefined);
      } catch {
        /* a throwing canceller must not break cancel — the mark below is the contract */
      }
    }

    this.toTerminal(rec, 'cancelled');
    return { ok: true, state: 'cancelled' };
  }

  /** True iff the id is tracked (running or terminal). */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Count of agents currently in the `running` state (cheap gauge for an operator/status view). */
  runningCount(): number {
    let n = 0;
    for (const r of this.agents.values()) if (r.status.state === 'running') n++;
    return n;
  }

  // ── internals (the ONLY writers of a record — P1) ─────────────────────────────────────

  private nextId(): string {
    this.seq += 1;
    // Mix the monotonic seq in so two same-tick spawns never collide even with a pinned idFn.
    const base = this.idFn();
    return this.agents.has(base) ? `${base}-${this.seq}` : base;
  }

  /**
   * Settle a record from the executor's resolution. Idempotent: a cancelled (already-terminal) record
   * ignores a late result (the cancel detached it). Maps the {@link RoleDispatchResult} → the public
   * fields. A thrown executor (the `err` branch) is recorded as `failed` (CP5 containment).
   */
  private onSettle(agentId: string, result: RoleDispatchResult | undefined, err: unknown): void {
    const rec = this.agents.get(agentId);
    if (!rec || rec.terminal) return; // unknown or already terminal (e.g. cancelled) → drop (idempotent)

    if (err !== undefined) {
      rec.status.error = err instanceof Error ? err.message : String(err);
      this.toTerminal(rec, 'failed');
      return;
    }
    const r = result as RoleDispatchResult;
    if (r.backend !== undefined) rec.status.backend = r.backend;
    if (r.text !== undefined) rec.status.report = r.text;
    if (r.costUsd !== undefined) rec.status.costUsd = r.costUsd;
    if (r.fellBack !== undefined) rec.status.fellBack = r.fellBack;
    if (!r.ok) {
      // A clean agent-level failure: keep the report text AND surface it as the error summary.
      rec.status.error = r.text ?? 'agent reported a failure';
      this.toTerminal(rec, 'failed');
      return;
    }
    this.toTerminal(rec, 'done');
  }

  /** Move a record to a terminal state + stamp finishedAt + resolve its settle gate. The sole terminal-writer. */
  private toTerminal(rec: InternalRecord, state: AgentRunState): void {
    rec.status.state = state;
    rec.status.finishedAt = this.nowFn();
    rec.terminal = true;
    // Resolve the settle gate so any awaiter racing it returns now. Both the executor-resolution path
    // (onSettle) and the cooperative cancel path funnel through here → a cancel settles awaiters even
    // though the executor keeps running with no abort handle (T2).
    rec.resolveSettled();
  }
}
