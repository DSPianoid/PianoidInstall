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
}

/** The outcome of a (non-blocking) {@link AgentConcurrencyGate.tryAcquire}. */
export interface AcquireResult {
  /** True iff a slot was granted (the caller MUST later call the returned lease's release). */
  ok: boolean;
  /** When !ok, a short machine-readable reason. */
  reason?: 'at-concurrency-cap' | 'token-budget-exhausted';
  /** When ok, the lease to release exactly once when the agent finishes. */
  lease?: AgentLease;
}

/**
 * A one-shot lease for a granted concurrency slot. Releasing returns the slot AND records the
 * tokens the agent actually used (added to the window spend). Idempotent: a double-release is a
 * no-op (so a finally-block release after an error path can't under-count the active set).
 */
export interface AgentLease {
  /** Release the slot exactly once. `tokensUsed` (default 0) is added to the window spend. */
  release(tokensUsed?: number): void;
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
  private active = 0;
  private spent = 0;

  constructor(opts: AgentConcurrencyOptions = {}) {
    const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AGENTS;
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`AgentConcurrencyGate: maxConcurrent must be a finite number ≥ 1 (got ${max})`);
    }
    this.maxConcurrent = Math.floor(max);
    const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.tokenBudget = Number.isFinite(budget) && budget > 0 ? budget : 0;
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
   * Try to acquire a slot WITHOUT blocking. Returns {ok:true, lease} when admitted, else
   * {ok:false, reason}. `estTokens` (default 0) is an OPTIONAL up-front estimate checked against
   * the remaining budget (so a dispatch that would blow the budget is refused before it starts);
   * the ACTUAL usage is recorded on release. Pure aside from mutating this gate's own counters.
   */
  tryAcquire(estTokens = 0): AcquireResult {
    if (this.active >= this.maxConcurrent) {
      return { ok: false, reason: 'at-concurrency-cap' };
    }
    if (this.budgetExhausted(estTokens)) {
      return { ok: false, reason: 'token-budget-exhausted' };
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
  acquire(estTokens = 0): Promise<AgentLease> {
    if (this.budgetExhausted(estTokens)) {
      return Promise.reject(
        new AgentConcurrencyError('token-budget-exhausted', this.spent, this.tokenBudget),
      );
    }
    const immediate = this.tryAcquire(estTokens);
    if (immediate.ok) return Promise.resolve(immediate.lease!);
    // At the concurrency cap → queue until a release frees a slot.
    return new Promise<AgentLease>((resolve, reject) => {
      this.waiters.push({ estTokens, resolve, reject });
    });
  }

  private readonly waiters: {
    estTokens: number;
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
      release(tokensUsed = 0): void {
        if (released) return; // idempotent — a double release does not under-count
        released = true;
        gate.active -= 1;
        if (gate.active < 0) gate.active = 0; // defensive
        if (Number.isFinite(tokensUsed) && tokensUsed > 0) gate.spent += tokensUsed;
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
      this.waiters.shift();
      this.active += 1;
      next.resolve(this.makeLease());
    }
  }

  /**
   * Reset the token-spend window (e.g. at the top of a new 5-hour Claude window or a monthly cap
   * boundary — the CALLER owns the clock; this gate has no timer). Does NOT touch the active set
   * (in-flight agents keep their leases). Pure state reset of the spend counter.
   */
  resetWindow(): void {
    this.spent = 0;
  }
}

/** Thrown by {@link AgentConcurrencyGate.acquire} when the token budget is exhausted (not a queue-able condition). */
export class AgentConcurrencyError extends Error {
  readonly reason: 'token-budget-exhausted';
  readonly spent: number;
  readonly budget: number;
  constructor(reason: 'token-budget-exhausted', spent: number, budget: number) {
    super(`agent-concurrency: ${reason} (spent=${spent}, budget=${budget})`);
    this.name = 'AgentConcurrencyError';
    this.reason = reason;
    this.spent = spent;
    this.budget = budget;
  }
}
