/**
 * ASYNC DISPATCH REGISTRY tests (model-agnostic-orchestrator Tier-1, piece #2 — the
 * teams-replacement). ALL tests inject a FAKE executor (a scripted `RoleDispatchFn`) +
 * a pinned id/clock → NO real claude spawn, NO network, NO spend. The whole async
 * lifecycle (spawn / status / await / cancel / list) is exercised behind the seam.
 *
 * Coverage (the T2 acceptance set):
 *   - spawn returns a handle IMMEDIATELY (non-blocking) + records `running`;
 *   - a settled success → status `done` + report/backend/cost/fellBack mapped from the report;
 *   - a clean agent failure (ok:false) → `failed` with the failure text as both report + error;
 *   - a THROWN executor → contained as `failed` (never escapes — CP5);
 *   - await: blocks until settle → terminal state+status; a timeout → {state:'timeout'} (agent runs on);
 *     an already-terminal agent returns immediately; an unknown id → {state:'unknown'};
 *   - cancel: marks `cancelled` + detaches a LATE executor result (idempotent); unknown/terminal → ok:false;
 *     an injected real cancelFn is invoked (best-effort; a throwing cancelFn doesn't break cancel);
 *   - validation: empty role/task → {ok:false} (never thrown);
 *   - list/has/runningCount gauges; concurrent spawns get distinct ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncDispatchRegistry, type AsyncDispatchExecutor } from '../async-dispatch-registry.js';
import type { RoleDispatchResult } from '../session-host.js';

// ── fakes ────────────────────────────────────────────────────────────────────────

/** A deferred promise we can settle from the test (to control exactly when an executor resolves). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A successful RoleDispatchResult. */
function okResult(over: Partial<RoleDispatchResult> = {}): RoleDispatchResult {
  return { ok: true, role: 'coding', backend: 'api-adapter', text: 'done: built X', costUsd: 0.01, fellBack: false, ...over };
}

/** A clean agent-level FAILED RoleDispatchResult (the executor returns this — it does NOT throw). */
function failResult(over: Partial<RoleDispatchResult> = {}): RoleDispatchResult {
  return { ok: false, role: 'coding', backend: 'api-adapter', text: 'the agent crashed: boom', fellBack: false, ...over };
}

/** An executor that resolves IMMEDIATELY with the given result, recording each (role,task) it was called with. */
function instantExecutor(result: RoleDispatchResult, calls?: { role: string; task: string }[]): AsyncDispatchExecutor {
  return async (role, task) => {
    calls?.push({ role, task });
    return result;
  };
}

/** A registry with a pinned clock + deterministic ids (agt-1, agt-2, …). */
function makeRegistry(executor: AsyncDispatchExecutor, over: Partial<ConstructorParameters<typeof AsyncDispatchRegistry>[0]> = {}) {
  let n = 0;
  let clock = 1000;
  return new AsyncDispatchRegistry({
    executor,
    idFn: () => `agt-${++n}`,
    nowFn: () => clock++,
    ...over,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// spawn — non-blocking handle + running record
// ════════════════════════════════════════════════════════════════════════════════

test('★★ spawn returns a handle IMMEDIATELY (non-blocking) and records the agent as running', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise); // never settles until we resolve d
  const r = reg.spawn('coding', 'build feature X');
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'agt-1');
  // status is available SYNCHRONOUSLY right after spawn — the call did not block on the executor
  const s = reg.status('agt-1')!;
  assert.equal(s.state, 'running');
  assert.equal(s.role, 'coding');
  assert.equal(s.task, 'build feature X');
  assert.equal(s.finishedAt, undefined);
  assert.equal(reg.runningCount(), 1);
  // clean up the dangling executor
  d.resolve(okResult());
  await reg.awaitAgent('agt-1');
});

test('spawn validates: empty role or task → {ok:false}, never thrown, no record created', () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  assert.deepEqual(reg.spawn('', 'task'), { ok: false, error: 'a role is required' });
  assert.deepEqual(reg.spawn('  ', 'task'), { ok: false, error: 'a role is required' });
  assert.deepEqual(reg.spawn('coding', ''), { ok: false, error: 'a task is required' });
  assert.deepEqual(reg.spawn('coding', '   '), { ok: false, error: 'a task is required' });
  assert.equal(reg.list().length, 0);
});

test('the executor is called with the (trimmed role, task) exactly once per spawn', async () => {
  const calls: { role: string; task: string }[] = [];
  const reg = makeRegistry(instantExecutor(okResult(), calls));
  reg.spawn('  coding  ', 'do the thing');
  await reg.awaitAgent('agt-1');
  assert.deepEqual(calls, [{ role: 'coding', task: 'do the thing' }]);
});

test('concurrent spawns get distinct ids + are all tracked', async () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  const a = reg.spawn('coding', 't1');
  const b = reg.spawn('reviewing', 't2');
  const c = reg.spawn('analysis', 't3');
  assert.deepEqual([a.agentId, b.agentId, c.agentId], ['agt-1', 'agt-2', 'agt-3']);
  await Promise.all([reg.awaitAgent('agt-1'), reg.awaitAgent('agt-2'), reg.awaitAgent('agt-3')]);
  assert.equal(reg.list().length, 3);
});

// ════════════════════════════════════════════════════════════════════════════════
// settle: success / failure / thrown
// ════════════════════════════════════════════════════════════════════════════════

test('★★ a settled SUCCESS → state done + report/backend/cost/fellBack mapped from the report', async () => {
  const reg = makeRegistry(instantExecutor(okResult({ text: 'built X', backend: 'api-adapter', costUsd: 0.02, fellBack: true })));
  reg.spawn('coding', 'build X');
  const res = await reg.awaitAgent('agt-1');
  assert.equal(res.state, 'done');
  const s = res.status!;
  assert.equal(s.state, 'done');
  assert.equal(s.report, 'built X');
  assert.equal(s.backend, 'api-adapter');
  assert.equal(s.costUsd, 0.02);
  assert.equal(s.fellBack, true);
  assert.ok(typeof s.finishedAt === 'number');
  assert.equal(s.error, undefined);
  assert.equal(reg.runningCount(), 0);
});

test('★ a clean agent FAILURE (ok:false) → state failed; the failure text is BOTH report and error (no throw)', async () => {
  const reg = makeRegistry(instantExecutor(failResult({ text: 'the agent crashed: boom' })));
  reg.spawn('coding', 'build X');
  const res = await reg.awaitAgent('agt-1');
  assert.equal(res.state, 'failed');
  assert.equal(res.status!.report, 'the agent crashed: boom');
  assert.equal(res.status!.error, 'the agent crashed: boom');
});

test('★ a THROWN executor is CONTAINED as failed (the rejection never escapes — CP5)', async () => {
  const reg = makeRegistry(async () => {
    throw new Error('executor blew up');
  });
  reg.spawn('coding', 'build X');
  const res = await reg.awaitAgent('agt-1');
  assert.equal(res.state, 'failed');
  assert.equal(res.status!.error, 'executor blew up');
});

test('a failure with no text still records a failed state with a default error summary', async () => {
  const reg = makeRegistry(instantExecutor({ ok: false, role: 'coding' }));
  reg.spawn('coding', 'x');
  const res = await reg.awaitAgent('agt-1');
  assert.equal(res.state, 'failed');
  assert.equal(res.status!.error, 'agent reported a failure');
});

// ════════════════════════════════════════════════════════════════════════════════
// await — block, timeout, already-terminal, unknown
// ════════════════════════════════════════════════════════════════════════════════

test('★★ await BLOCKS until the agent settles, then returns the terminal state + status', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise);
  reg.spawn('coding', 'x');
  let settled = false;
  const p = reg.awaitAgent('agt-1', 5000).then((r) => {
    settled = true;
    return r;
  });
  // not settled yet (the executor hasn't resolved)
  await Promise.resolve();
  assert.equal(settled, false);
  d.resolve(okResult({ text: 'finally done' }));
  const res = await p;
  assert.equal(res.state, 'done');
  assert.equal(res.status!.report, 'finally done');
});

test('★ await TIMES OUT when the agent is still running → {state:timeout}; the agent keeps running', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise);
  reg.spawn('coding', 'x');
  const res = await reg.awaitAgent('agt-1', 20); // 20ms deadline, agent never settles in time
  assert.equal(res.state, 'timeout');
  assert.equal(res.status, undefined);
  // the agent is still running and observable
  assert.equal(reg.status('agt-1')!.state, 'running');
  // it can still settle + be awaited again afterwards
  d.resolve(okResult());
  const res2 = await reg.awaitAgent('agt-1', 5000);
  assert.equal(res2.state, 'done');
});

test('await on an ALREADY-terminal agent returns immediately with its state', async () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  reg.spawn('coding', 'x');
  await reg.awaitAgent('agt-1'); // settle it
  const res = await reg.awaitAgent('agt-1', 1); // already done → returns immediately regardless of timeout
  assert.equal(res.state, 'done');
  assert.ok(res.status);
});

test('await on an UNKNOWN id → {state:unknown}', async () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  const res = await reg.awaitAgent('nope');
  assert.equal(res.state, 'unknown');
  assert.equal(res.status, undefined);
});

// ════════════════════════════════════════════════════════════════════════════════
// cancel — cooperative mark + detach, real cancelFn, idempotency
// ════════════════════════════════════════════════════════════════════════════════

test('★★ cancel marks a running agent cancelled + DETACHES a late executor result (idempotent)', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise);
  reg.spawn('coding', 'x');
  const c = reg.cancel('agt-1');
  assert.deepEqual(c, { ok: true, state: 'cancelled' });
  assert.equal(reg.status('agt-1')!.state, 'cancelled');
  // an awaiter sees the cancel immediately (settled by the cooperative path, not the executor)
  const res = await reg.awaitAgent('agt-1', 5000);
  assert.equal(res.state, 'cancelled');
  // NOW the executor finally resolves — it must NOT flip the record back to done (detached)
  d.resolve(okResult({ text: 'too late' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reg.status('agt-1')!.state, 'cancelled');
  assert.equal(reg.status('agt-1')!.report, undefined);
});

test('cancel of an UNKNOWN or ALREADY-terminal agent → ok:false (a no-op, not an error)', async () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  assert.deepEqual(reg.cancel('nope'), { ok: false, error: 'unknown agentId' });
  reg.spawn('coding', 'x');
  await reg.awaitAgent('agt-1'); // now done
  const c = reg.cancel('agt-1');
  assert.equal(c.ok, false);
  assert.equal(c.state, 'done');
});

test('★ an injected real cancelFn is invoked on cancel (the T3/activation kill seam)', async () => {
  const d = deferred<RoleDispatchResult>();
  const cancelled: string[] = [];
  const reg = makeRegistry(async () => d.promise, { cancelFn: (id) => { cancelled.push(id); } });
  reg.spawn('coding', 'x');
  reg.cancel('agt-1');
  assert.deepEqual(cancelled, ['agt-1']);
  d.resolve(okResult());
});

test('a THROWING cancelFn does not break cancel — the cooperative mark still stands', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise, {
    cancelFn: () => {
      throw new Error('kill failed');
    },
  });
  reg.spawn('coding', 'x');
  const c = reg.cancel('agt-1'); // must not throw
  assert.deepEqual(c, { ok: true, state: 'cancelled' });
  assert.equal(reg.status('agt-1')!.state, 'cancelled');
  d.resolve(okResult());
});

test('a rejecting async cancelFn is swallowed (no unhandled rejection); the mark stands', async () => {
  const d = deferred<RoleDispatchResult>();
  const reg = makeRegistry(async () => d.promise, {
    cancelFn: async () => {
      throw new Error('async kill failed');
    },
  });
  reg.spawn('coding', 'x');
  const c = reg.cancel('agt-1');
  assert.deepEqual(c, { ok: true, state: 'cancelled' });
  await Promise.resolve();
  d.resolve(okResult());
});

// ════════════════════════════════════════════════════════════════════════════════
// list / has / snapshots are copies
// ════════════════════════════════════════════════════════════════════════════════

test('list() returns snapshots most-recently-created first; has() reflects tracking', async () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  reg.spawn('coding', 't1');
  reg.spawn('reviewing', 't2');
  await Promise.all([reg.awaitAgent('agt-1'), reg.awaitAgent('agt-2')]);
  const ls = reg.list();
  assert.equal(ls.length, 2);
  // agt-2 created after agt-1 (clock advanced) → first
  assert.equal(ls[0]!.agentId, 'agt-2');
  assert.equal(ls[1]!.agentId, 'agt-1');
  assert.equal(reg.has('agt-1'), true);
  assert.equal(reg.has('nope'), false);
});

test('status()/list() hand out COPIES — mutating the returned snapshot does not corrupt the registry', async () => {
  const reg = makeRegistry(instantExecutor(okResult({ text: 'orig' })));
  reg.spawn('coding', 'x');
  await reg.awaitAgent('agt-1');
  const s = reg.status('agt-1')!;
  s.report = 'TAMPERED';
  s.state = 'running';
  // the registry's own copy is unchanged
  assert.equal(reg.status('agt-1')!.report, 'orig');
  assert.equal(reg.status('agt-1')!.state, 'done');
});

test('status() on an unknown id → undefined', () => {
  const reg = makeRegistry(instantExecutor(okResult()));
  assert.equal(reg.status('nope'), undefined);
});
