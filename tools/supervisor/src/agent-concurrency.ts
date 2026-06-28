/**
 * AGENT CONCURRENCY + TOKEN-BUDGET GATE (X2) — a supervisor-level runtime guardrail
 * that caps the number of CONCURRENT routed agents + tracks a token budget across the
 * sliding window. Spans ALL backends (claude-cli + api-adapter), so it is a CROSS-CUTTING
 * rule, NOT a module of any one component (proposal §M re-homing note → §X X2).
 *
 * WHY a cap at all, given the de-risking found NO seat cap (≥64 concurrent SEALED
 * `claude -p` ran clean)? Because the binding limit is the LOCAL machine (RAM/CPU) + the
 * 5-hour Claude token window under SUSTAINED heavy agents, NOT licensing. So the cap is
 * GENEROUS but PRESENT — a deliberate ceiling that prevents a self-inflicted RAM/rate wall
 * (a runaway fan-out of routed agents), while never throttling normal use. `traces-to:
 * proposal CP4, CP7; §X X2; PART P P5; FD5.`
 *
 * CONCERN (P2 = one job): be the single place that answers "may another routed agent start
 * right now, and how much budget is left?". It owns its OWN state (the active-agent count +
 * the tokens spent this window) — sole writer (P1). It does NOT spawn, does NOT know about
 * backends/seals/drivers, does NOT touch the channel. The dispatcher/composition root
 * CONSULTS it around a dispatch; this object only counts.
 *
 * PURE + DETERMINISTIC + unit-testable: no I/O, no timers of its own (the window is advanced
 * by the caller's clock via {@link AgentConcurrencyGate.resetWindow} or an injected `now`).
 * DORMANT until role-routing is activated (P6) — nothing here is wired into the live path.
 */

/** The generous DEFAULT concurrent-agent ceiling (de-risking: ≥64 ran clean → headroom, but bounded). */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 24;

/**
 * The DEFAULT token budget for the window (advisory; 0 = UNLIMITED/untracked). Left at 0 by
 * default so the cap is concurrency-only unless a budget is explicitly configured (the real
 * 5-hour-window ceiling is set by the operator at activation — OD-3 per-backend monthly/dispatch
 * caps). Pure data; the gate enforces whatever non-zero value is supplied.
 */
export const DEFAULT_TOKEN_BUDGET = 0;

/**
 * ★ P-C1 — the DEFAULT per-dispatch USD cap (0 = UNLIMITED = today). When > 0, an acquire whose
 * ESTIMATE exceeds it is refused before the dispatch starts. Default 0 keeps Part C meter-only
 * (byte-for-byte today) until the operator sets a real ceiling (proposal §4 + §D(d); suggested
 * first real value $0.50). Pure data; the gate enforces whatever non-zero value is supplied.
 */
export const DEFAULT_DISPATCH_COST_CAP_USD = 0;

/**
 * ★ P-C1 — the DEFAULT rolling cumulative USD cap for the window (0 = UNLIMITED = today). When > 0,
 * an acquire is refused once `spentUsd + estCostUsd` would exceed it. Default 0 keeps Part C
 * meter-only (byte-for-byte today) until the operator sets a real ceiling (proposal §4 + §D(d);
 * suggested first real value $5 / 5h). Pure data; the gate enforces whatever non-zero value is supplied.
 */
export const DEFAULT_DISPATCH_COST_WINDOW_USD = 0;

/** Options to construct an {@link AgentConcurrencyGate}. */
export interface AgentConcurrencyOptions {
  /** Max CONCURRENT routed agents (default {@link DEFAULT_MAX_CONCURRENT_AGENTS}). Must be ≥ 1. */
  maxConcurrent?: number;
  /**
   * Max tokens that may be SPENT in the current window (default {@link DEFAULT_TOKEN_BUDGET} = 0 =
   * untracked). When > 0, an acquire is refused once the budget is exhausted (or a per-dispatch
   * estimate would exceed it). Advisory — the caller reports actual usage on release.
   */
  tokenBudget?: number;
  /**
   * ★ P-C1 — the PER-DISPATCH USD cap (default {@link DEFAULT_DISPATCH_COST_CAP_USD} = 0 = unlimited).
   * When > 0, a single acquire whose `estCostUsd` exceeds it is refused (reason `dispatch-cost-cap`)
   * BEFORE the dispatch starts — a SAFETY ceiling on any ONE routed agent. Default 0 = today.
   */
  dispatchCostCapUsd?: number;
  /**
   * ★ P-C1 — the ROLLING CUMULATIVE USD cap over the window (default
   * {@link DEFAULT_DISPATCH_COST_WINDOW_USD} = 0 = unlimited). When > 0, an acquire is refused once
   * `spentUsd + estCostUsd` would exceed it (reason `dispatch-cost-window`). The window is rolled by
   * the caller's clock via {@link AgentConcurrencyGate.resetWindow} (same boundary as the token
   * budget). Default 0 = today. The actual USD is charged on release (the ledger stays truthful).
   */
  dispatchCostWindowUsd?: number;
}

/** The outcome of a (non-blocking) {@link AgentConcurrencyGate.tryAcquire}. */
export interface AcquireResult {
  /** True iff a slot was granted (the caller MUST later call the returned lease's release). */
  ok: boolean;
  /**
   * When !ok, a short machine-readable reason. ★ P-C1 adds the two spend-cap refusals
   * (`dispatch-cost-cap` = the per-dispatch USD estimate exceeded the per-dispatch cap;
   * `dispatch-cost-window` = admitting this estimate would exceed the rolling cumulative USD cap).
   */
  reason?:
    | 'at-concurrency-cap'
    | 'token-budget-exhausted'
    | 'dispatch-cost-cap'
    | 'dispatch-cost-window';
  /** When ok, the lease to release exactly once when the agent finishes. */
  lease?: AgentLease;
}

/**
 * A one-shot lease for a granted concurrency slot. Releasing returns the slot AND records the
 * tokens (and ★ P-C1 the USD cost) the agent actually used (added to the window spend). Idempotent:
 * a double-release is a no-op (so a finally-block release after an error path can't under-count the
 * active set).
 */
export interface AgentLease {
  /**
   * Release the slot exactly once. `tokensUsed` (default 0) is added to the window token-spend; ★
   * P-C1 `costUsd` (default 0) is added to the window USD-spend (the rolling spend ledger). Both are
   * the REAL amounts the caller reports from the agent's report (0 on a crash where nothing ran).
   */
  release(tokensUsed?: number, costUsd?: number): void;
  /** True once released (so the caller/test can assert lease hygiene). */
  readonly released: boolean;
}

/**
 * The concurrency + token-budget gate. Single owner of the active-count + window-spend state.
 *
 * Usage (the dispatcher consults it):
 *   const r = gate.tryAcquire(estTokens);
 *   if (!r.ok) { surface "busy: <reason>"; return; }
 *   try { ...run the agent... } finally { r.lease!.release(actualTokensUsed); }
 */
export class AgentConcurrencyGate {
  private readonly maxConcurrent: number;
  private readonly tokenBudget: number;
  /** ★ P-C1 — the per-dispatch USD cap (0 = unlimited). */
  private readonly dispatchCostCapUsd: number;
  /** ★ P-C1 — the rolling cumulative USD cap for the window (0 = unlimited). */
  private readonly dispatchCostWindowUsd: number;
  private active = 0;
  private spent = 0;
  /** ★ P-C1 — the rolling spend ledger: USD spent in the current window (sole owner: this gate, P1). */
  private spentUsd = 0;

  constructor(opts: AgentConcurrencyOptions = {}) {
    const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`AgentConcurrencyGate: maxConcurrent must be a finite number ≥ 1 (got ${max})`);
    }
    this.maxConcurrent = Math.floor(max);
    const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.tokenBudget = Number.isFinite(budget) && budget > 0 ? budget : 0;
    // ★ P-C1 — both USD caps: a finite positive number is the ceiling; anything else (incl. the
    // default 0) means UNLIMITED (= meter-only = today). A negative/NaN cap is treated as 0.
    const perDispatch = opts.dispatchCostCapUsd ?? DEFAULT_DISPATCH_COST_CAP_USD;
    this.dispatchCostCapUsd = Number.isFinite(perDispatch) && perDispatch > 0 ? perDispatch : 0;
    const window = opts.dispatchCostWindowUsd ?? DEFAULT_DISPATCH_COST_WINDOW_USD;
    this.dispatchCostWindowUsd = Number.isFinite(window) && window > 0 ? window : 0;
  }

  /** Current number of active (leased-but-not-released) agents. */
  get activeCount(): number {
    return this.active;
  }

  /** Tokens spent in the current window (sum of released leases' reported usage). */
  get spentTokens(): number {
    return this.spent;
  }

  /** The configured concurrency ceiling. */
  get capacity(): number {
    return this.maxConcurrent;
  }

  /** The configured token budget (0 = untracked). */
  get budget(): number {
    return this.tokenBudget;
  }

  /** ★ P-C1 — USD spent in the current window (sum of released leases' reported cost). */
  get spentCostUsd(): number {
    return this.spentUsd;
  }

  /** ★ P-C1 — the configured per-dispatch USD cap (0 = unlimited). */
  get perDispatchCostCapUsd(): number {
    return this.dispatchCostCapUsd;
  }

  /** ★ P-C1 — the configured rolling cumulative USD cap (0 = unlimited). */
  get windowCostCapUsd(): number {
    return this.dispatchCostWindowUsd;
  }

  /** ★ P-C1 — USD remaining in the rolling window (Infinity when the window cap is unlimited). */
  get remainingCostUsd(): number {
    return this.dispatchCostWindowUsd === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.dispatchCostWindowUsd - this.spentUsd);
  }

  /** True iff another agent could be admitted right now (slot free AND budget not exhausted). */
  get hasCapacity(): boolean {
    return this.active < this.maxConcurrent && !this.budgetExhausted(0);
  }

  /** Tokens remaining in the window (Infinity when untracked). */
  get remainingBudget(): number {
    return this.tokenBudget === 0 ? Number.POSITIVE_INFINITY : Math.max(0, this.tokenBudget - this.spent);
  }

  private budgetExhausted(estTokens: number): boolean {
    if (this.tokenBudget === 0) return false; // untracked
    return this.spent + Math.max(0, estTokens) > this.tokenBudget;
  }

  /**
   * ★ P-C1 — would admitting a dispatch with this USD estimate BREACH a spend cap? Returns the
   * breaching reason (`dispatch-cost-cap` = the per-dispatch estimate exceeds the per-dispatch cap;
   * `dispatch-cost-window` = `spentUsd + estCostUsd` would exceed the rolling cumulative cap), else
   * null (admitted). Both caps default 0 = unlimited → ALWAYS returns null = byte-for-byte today.
   * Pure; reads only this gate's own ledger.
   */
  private spendCapBreach(estCostUsd: number): 'dispatch-cost-cap' | 'dispatch-cost-window' | null {
    const est = Math.max(0, estCostUsd);
    if (this.dispatchCostCapUsd > 0 && est > this.dispatchCostCapUsd) return 'dispatch-cost-cap';
    if (this.dispatchCostWindowUsd > 0 && this.spentUsd + est > this.dispatchCostWindowUsd) {
      return 'dispatch-cost-window';
    }
    return null;
  }

  /**
   * Try to acquire a slot WITHOUT blocking. Returns {ok:true, lease} when admitted, else
   * {ok:false, reason}. `estTokens` (default 0) is an OPTIONAL up-front estimate checked against
   * the remaining budget (so a dispatch that would blow the budget is refused before it starts);
   * ★ P-C1 `estCostUsd` (default 0) is the OPTIONAL up-front USD estimate checked against the
   * per-dispatch + rolling cumulative spend caps (fail-closed: a breach REFUSES the dispatch
   * before it starts — never a crash/wedge). The ACTUAL usage (tokens + cost) is recorded on
   * release. With both spend caps 0 (the default) the spend check is a no-op (byte-for-byte today).
   * Pure aside from mutating this gate's own counters.
   */
  tryAcquire(estTokens = 0, estCostUsd = 0): AcquireResult {
    if (this.active >= this.maxConcurrent) {
      return { ok: false, reason: 'at-concurrency-cap' };
    }
    if (this.budgetExhausted(estTokens)) {
      return { ok: false, reason: 'token-budget-exhausted' };
    }
    const spendBreach = this.spendCapBreach(estCostUsd);
    if (spendBreach) {
      return { ok: false, reason: spendBreach };
    }
    this.active += 1;
    const lease = this.makeLease();
    return { ok: true, lease };
  }

  /**
   * Acquire a slot, AWAITING a free slot if at the cap (a cooperative queue). Resolves with a
   * lease once admitted. REJECTS immediately (does not queue) when the token budget is exhausted —
   * a budget wall is not relieved by waiting for a concurrency slot. Polls the internal waiter
   * queue on each release; FIFO. (No timers — wakeups are driven purely by `release`.)
   */
  acquire(estTokens = 0, estCostUsd = 0): Promise<AgentLease> {
    if (this.budgetExhausted(estTokens)) {
      return Promise.reject(
        new AgentConcurrencyError('token-budget-exhausted', this.spent, this.tokenBudget),
      );
    }
    // ★ P-C1 — a spend-cap breach is NOT relieved by waiting for a slot (a USD wall stands until the
    // window rolls), so reject immediately rather than queue (fail-closed, mirrors the budget wall).
    const spendBreach = this.spendCapBreach(estCostUsd);
    if (spendBreach) {
      return Promise.reject(new AgentConcurrencyError(spendBreach, this.spentUsd, this.spendCapForReason(spendBreach)));
    }
    const immediate = this.tryAcquire(estTokens, estCostUsd);
    if (immediate.ok) return Promise.resolve(immediate.lease!);
    // At the concurrency cap → queue until a release frees a slot.
    return new Promise<AgentLease>((resolve, reject) => {
      this.waiters.push({ estTokens, estCostUsd, resolve, reject });
    });
  }

  /** ★ P-C1 — the cap value relevant to a spend-cap refusal reason (for the error's `budget` field). */
  private spendCapForReason(reason: 'dispatch-cost-cap' | 'dispatch-cost-window'): number {
    return reason === 'dispatch-cost-cap' ? this.dispatchCostCapUsd : this.dispatchCostWindowUsd;
  }

  private readonly waiters: {
    estTokens: number;
    estCostUsd: number;
    resolve: (lease: AgentLease) => void;
    reject: (err: Error) => void;
  }[] = [];

  private makeLease(): AgentLease {
    let released = false;
    const gate = this;
    const lease: AgentLease = {
      get released() {
        return released;
      },
      release(tokensUsed = 0, costUsd = 0): void {
        if (released) return; // idempotent — a double release does not under-count
        released = true;
        gate.active -= 1;
        if (gate.active < 0) gate.active = 0; // defensive
        if (Number.isFinite(tokensUsed) && tokensUsed > 0) gate.spent += tokensUsed;
        // ★ P-C1 — charge the ACTUAL USD into the rolling spend ledger (keeps it truthful for the
        // next admission's window check, even when the up-front estimate was imperfect).
        if (Number.isFinite(costUsd) && costUsd > 0) gate.spentUsd += costUsd;
        gate.pump();
      },
    };
    return lease;
  }

  /** After a release, admit the next FIFO waiter if there is capacity (concurrency + budget). */
  private pump(): void {
    while (this.waiters.length > 0 && this.active < this.maxConcurrent) {
      const next = this.waiters[0]!;
      if (this.budgetExhausted(next.estTokens)) {
        // The budget was exhausted while this waiter was queued → reject it (don't wedge the queue).
        this.waiters.shift();
        next.reject(new AgentConcurrencyError('token-budget-exhausted', this.spent, this.tokenBudget));
        continue;
      }
      // ★ P-C1 — a spend cap may have been breached while this waiter was queued (a prior release
      // charged the ledger) → reject it (fail-closed; don't wedge the queue).
      const spendBreach = this.spendCapBreach(next.estCostUsd);
      if (spendBreach) {
        this.waiters.shift();
        next.reject(new AgentConcurrencyError(spendBreach, this.spentUsd, this.spendCapForReason(spendBreach)));
        continue;
      }
      this.waiters.shift();
      this.active += 1;
      next.resolve(this.makeLease());
    }
  }

  /**
   * Reset the spend window (e.g. at the top of a new 5-hour Claude window or a monthly cap
   * boundary — the CALLER owns the clock; this gate has no timer). Does NOT touch the active set
   * (in-flight agents keep their leases). Pure state reset of BOTH spend counters (token + ★ P-C1 USD).
   */
  resetWindow(): void {
    this.spent = 0;
    this.spentUsd = 0; // ★ P-C1 — roll the USD ledger with the same window boundary
  }
}

/**
 * Thrown by {@link AgentConcurrencyGate.acquire} when admission is refused by a non-queue-able wall:
 * the token budget is exhausted OR ★ P-C1 a spend cap (per-dispatch / rolling cumulative USD) is
 * breached. `spent` + `budget` carry the relevant ledger value + cap for the breaching dimension.
 */
export class AgentConcurrencyError extends Error {
  readonly reason: 'token-budget-exhausted' | 'dispatch-cost-cap' | 'dispatch-cost-window';
  readonly spent: number;
  readonly budget: number;
  constructor(
    reason: 'token-budget-exhausted' | 'dispatch-cost-cap' | 'dispatch-cost-window',
    spent: number,
    budget: number,
  ) {
    super(`agent-concurrency: ${reason} (spent=${spent}, budget=${budget})`);
    this.name = 'AgentConcurrencyError';
    this.reason = reason;
    this.spent = spent;
    this.budget = budget;
  }
}
