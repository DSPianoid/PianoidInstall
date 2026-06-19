/**
 * AGENT CONCURRENCY + TOKEN-BUDGET GATE tests (P5 / X2) — a pure, deterministic
 * cap the dispatcher consults: N concurrent routed agents respect the limit, leases
 * are idempotent, a queued acquire is admitted FIFO on release, and the (optional)
 * token budget refuses an over-budget acquire. No I/O, no timers, no SDK, no process.
 *
 * Traces: proposal §X X2; PART P P5; CP4/CP7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentConcurrencyGate,
  AgentConcurrencyError,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_TOKEN_BUDGET,
} from '../agent-concurrency.js';

test('defaults: a generous-but-present concurrency cap; token budget untracked (0) by default', () => {
  assert.ok(DEFAULT_MAX_CONCURRENT_AGENTS >= 1);
  assert.equal(DEFAULT_TOKEN_BUDGET, 0);
  const gate = new AgentConcurrencyGate();
  assert.equal(gate.capacity, DEFAULT_MAX_CONCURRENT_AGENTS);
  assert.equal(gate.budget, 0);
  assert.equal(gate.remainingBudget, Number.POSITIVE_INFINITY); // untracked
});

test('the cap is CONFIGURABLE (default cap overridable)', () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 3 });
  assert.equal(gate.capacity, 3);
});

test('a non-positive maxConcurrent is rejected (fail-fast on a nonsense cap)', () => {
  assert.throws(() => new AgentConcurrencyGate({ maxConcurrent: 0 }), /≥ 1/);
  assert.throws(() => new AgentConcurrencyGate({ maxConcurrent: -5 }), /≥ 1/);
});

test('★ N concurrent acquires respect the limit — the (N+1)th tryAcquire is refused at the cap', () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 2 });
  const a = gate.tryAcquire();
  const b = gate.tryAcquire();
  assert.ok(a.ok && b.ok);
  assert.equal(gate.activeCount, 2);
  assert.equal(gate.hasCapacity, false);

  // at the cap → refused (not granted)
  const c = gate.tryAcquire();
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'at-concurrency-cap');
  assert.equal(c.lease, undefined);

  // release one → a slot frees → the next tryAcquire succeeds
  a.lease!.release();
  assert.equal(gate.activeCount, 1);
  const d = gate.tryAcquire();
  assert.ok(d.ok);
  assert.equal(gate.activeCount, 2);
});

test('★ a lease release is IDEMPOTENT — a double release does not under-count the active set', () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 1 });
  const a = gate.tryAcquire();
  assert.ok(a.ok);
  assert.equal(a.lease!.released, false);
  a.lease!.release();
  assert.equal(a.lease!.released, true);
  assert.equal(gate.activeCount, 0);
  // a second release is a no-op (does not drive the count negative / free a phantom slot)
  a.lease!.release();
  assert.equal(gate.activeCount, 0);
});

test('★ acquire() QUEUES at the cap and is admitted FIFO when a slot is released', async () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 1 });
  const first = await gate.acquire(); // takes the only slot
  assert.equal(gate.activeCount, 1);

  // two more acquires queue (the slot is taken)
  let secondAdmitted = false;
  let thirdAdmitted = false;
  const p2 = gate.acquire().then((lease) => {
    secondAdmitted = true;
    return lease;
  });
  const p3 = gate.acquire().then((lease) => {
    thirdAdmitted = true;
    return lease;
  });
  // neither admitted yet — still capped
  await Promise.resolve();
  assert.equal(secondAdmitted, false);
  assert.equal(thirdAdmitted, false);

  // release the first → the SECOND (FIFO) is admitted, not the third
  first.release();
  const second = await p2;
  assert.equal(secondAdmitted, true);
  assert.equal(thirdAdmitted, false, 'FIFO: the third waits until the second releases');
  assert.equal(gate.activeCount, 1);

  // release the second → the third is admitted
  second.release();
  const third = await p3;
  assert.equal(thirdAdmitted, true);
  third.release();
  assert.equal(gate.activeCount, 0);
});

test('★ token budget: an acquire whose estimate would exceed the budget is REFUSED (budget-aware)', () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 10, tokenBudget: 100 });
  // spend 80 via a completed lease
  const a = gate.tryAcquire(0);
  a.lease!.release(80);
  assert.equal(gate.spentTokens, 80);
  assert.equal(gate.remainingBudget, 20);

  // an estimate of 50 would push spend to 130 > 100 → refused
  const over = gate.tryAcquire(50);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'token-budget-exhausted');

  // an estimate within budget is admitted
  const within = gate.tryAcquire(10);
  assert.ok(within.ok);
});

test('acquire() REJECTS (does not queue) when the token budget is exhausted', async () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 5, tokenBudget: 50 });
  const a = gate.tryAcquire(0);
  a.lease!.release(50); // budget now fully spent
  await assert.rejects(() => gate.acquire(1), AgentConcurrencyError);
});

test('resetWindow() clears the spend (a new 5-hr window) without disturbing in-flight leases', () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 2, tokenBudget: 100 });
  const a = gate.tryAcquire(0); // in flight
  const b = gate.tryAcquire(0);
  b.lease!.release(90);
  assert.equal(gate.spentTokens, 90);
  assert.equal(gate.activeCount, 1); // a still in flight

  gate.resetWindow();
  assert.equal(gate.spentTokens, 0); // spend reset
  assert.equal(gate.activeCount, 1); // in-flight lease untouched
  a.lease!.release(0);
  assert.equal(gate.activeCount, 0);
});

test('the gate spans ALL backends (it counts agents, not vendors) — claude + api-adapter share one ceiling', () => {
  // The gate is backend-agnostic by construction (it has no backend concept). Two acquires of
  // "any" agent share the same cap — modelling a claude-cli + an api-adapter agent running together.
  const gate = new AgentConcurrencyGate({ maxConcurrent: 2 });
  const claudeAgent = gate.tryAcquire();
  const apiAgent = gate.tryAcquire();
  assert.ok(claudeAgent.ok && apiAgent.ok);
  assert.equal(gate.tryAcquire().ok, false); // the shared ceiling is hit regardless of backend
  claudeAgent.lease!.release();
  apiAgent.lease!.release();
});
