/**
 * PANEL ASYNC-DISPATCH ROUTE tests (model-agnostic-orchestrator Tier-1, piece #2 — the
 * teams-replacement REST surface). Spins up a REAL Panel over loopback with an injected
 * AsyncDispatchRegistry built on a FAKE executor (a scripted RoleDispatchFn) → NO real
 * claude spawn, NO network beyond loopback, NO spend. Exercises the 4 additive routes
 * (`/api/dispatch/async` · `/status` · `/await` · `/cancel`) end-to-end + the DORMANT
 * (registry-absent) gate + the byte-for-byte sync /api/dispatch coexistence.
 *
 * Coverage (the T2 panel acceptance set):
 *   - DORMANT (no registry wired) → every async route returns {ok:false, enabled:false}; nothing runs;
 *   - WIRED → /async returns an agentId; /status reflects running→done; /await blocks then reports;
 *     /cancel marks cancelled; /status with no id lists agents;
 *   - routing precedence: /api/dispatch/async is NOT swallowed by the bare /api/dispatch branch;
 *   - validation (missing role/task/agentId → 400) + never-throws-to-socket;
 *   - the sync /api/dispatch (no async registry) is unaffected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Supervisor } from '../supervisor.js';
import { Logger } from '../logger.js';
import { Panel } from '../panel.js';
import { TelegramAdapter } from '../adapters/telegram.js';
import { AccessGate } from '../adapters/access-gate.js';
import { LoopbackTelegramTransport } from '../adapters/loopback-transport.js';
import { tmpDir } from './helpers.js';
import { AsyncDispatchRegistry, type AsyncDispatchExecutor } from '../async-dispatch-registry.js';
import type { RoleDispatchResult } from '../session-host.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}

/** A deferred we settle from the test (to hold an agent in `running`). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function okResult(over: Partial<RoleDispatchResult> = {}): RoleDispatchResult {
  return { ok: true, role: 'coding', backend: 'api-adapter', text: 'sub-agent report', costUsd: 0.01, fellBack: false, ...over };
}

/**
 * Spin up a Panel with an OPTIONAL async registry. When `executor` is omitted the registry is NOT
 * wired (the dormant case). Returns the base URL + the registry (if any).
 */
async function withPanel(
  dir: string,
  executor: AsyncDispatchExecutor | undefined,
  fn: (base: string, reg?: AsyncDispatchRegistry) => Promise<void>,
): Promise<void> {
  const supervisor = new Supervisor({
    captureFile: join(dir, 'capture.ndjson'),
    logger: silentLogger(),
    unbufferedCapture: true,
  });
  supervisor.register(
    new TelegramAdapter({
      transport: new LoopbackTelegramTransport(),
      gate: new AccessGate({ staticConfig: { dmPolicy: 'allowlist', allowFrom: [], groups: {} } }),
      queueDir: join(dir, 'q'),
      downloadDir: join(dir, 'd'),
    }),
  );
  await supervisor.start();
  let reg: AsyncDispatchRegistry | undefined;
  if (executor) {
    let n = 0;
    reg = new AsyncDispatchRegistry({ executor, idFn: () => `agt-${++n}` });
  }
  const panel = new Panel({ port: 0, supervisor, logger: silentLogger(), ...(reg ? { asyncDispatchRegistry: reg } : {}) });
  await panel.start();
  const base = `http://127.0.0.1:${panel.boundPort}`;
  try {
    await fn(base, reg);
  } finally {
    await panel.stop();
    await supervisor.stop();
  }
}

const postJson = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ════════════════════════════════════════════════════════════════════════════════
// DORMANT — no registry wired (the default; byte-for-byte today)
// ════════════════════════════════════════════════════════════════════════════════

test('★★ DORMANT: every async route returns {ok:false, enabled:false} when no registry is wired', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, undefined, async (base) => {
      const a = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 't' })).json() as { ok: boolean; enabled: boolean };
      assert.deepEqual(a, { ok: false, enabled: false, error: 'role routing is not enabled (no async dispatch registry wired)' });
      const s = await (await fetch(`${base}/api/dispatch/status?agentId=x`)).json() as { ok: boolean; enabled: boolean };
      assert.equal(s.enabled, false);
      const w = await (await postJson(base, '/api/dispatch/await', { agentId: 'x' })).json() as { enabled: boolean };
      assert.equal(w.enabled, false);
      const c = await (await postJson(base, '/api/dispatch/cancel', { agentId: 'x' })).json() as { enabled: boolean };
      assert.equal(c.enabled, false);
    });
  } finally {
    cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// WIRED — full async lifecycle over loopback
// ════════════════════════════════════════════════════════════════════════════════

test('★★ WIRED: /api/dispatch/async returns an agentId immediately (non-blocking)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const d = deferred<RoleDispatchResult>();
    await withPanel(dir, async () => d.promise, async (base, reg) => {
      const r = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'build X' })).json() as { ok: boolean; enabled: boolean; agentId: string };
      assert.equal(r.ok, true);
      assert.equal(r.enabled, true);
      assert.equal(r.agentId, 'agt-1');
      // still running (the executor hasn't resolved)
      assert.equal(reg!.status('agt-1')!.state, 'running');
      d.resolve(okResult());
      await reg!.awaitAgent('agt-1');
    });
  } finally {
    cleanup();
  }
});

test('★ WIRED: /status reflects running → done with the mapped report; /status (no id) lists agents', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const d = deferred<RoleDispatchResult>();
    await withPanel(dir, async () => d.promise, async (base, reg) => {
      await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'build X' });
      // running
      type StatusResp = { ok: boolean; status: { state: string; report?: string; backend?: string } };
      let s = await (await fetch(`${base}/api/dispatch/status?agentId=agt-1`)).json() as StatusResp;
      assert.equal(s.status.state, 'running');
      // list (no id) shows it
      const list = await (await fetch(`${base}/api/dispatch/status`)).json() as { ok: boolean; agents: { agentId: string }[] };
      assert.equal(list.agents.length, 1);
      assert.equal(list.agents[0]!.agentId, 'agt-1');
      // settle → done with the report
      d.resolve(okResult({ text: 'built it', backend: 'api-adapter' }));
      await reg!.awaitAgent('agt-1');
      s = await (await fetch(`${base}/api/dispatch/status?agentId=agt-1`)).json() as StatusResp;
      assert.equal(s.status.state, 'done');
      assert.equal(s.status.report, 'built it');
      assert.equal(s.status.backend, 'api-adapter');
    });
  } finally {
    cleanup();
  }
});

test('★ WIRED: /status for an unknown agentId → {ok:false}', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async () => okResult(), async (base) => {
      const s = await (await fetch(`${base}/api/dispatch/status?agentId=nope`)).json() as { ok: boolean; enabled: boolean; error: string };
      assert.equal(s.ok, false);
      assert.equal(s.enabled, true);
      assert.match(s.error, /unknown agentId/);
    });
  } finally {
    cleanup();
  }
});

test('★★ WIRED: /await blocks until the agent finishes, then returns its terminal state + report', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const d = deferred<RoleDispatchResult>();
    await withPanel(dir, async () => d.promise, async (base) => {
      const r = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'x' })).json() as { agentId: string };
      // Issue the await FIRST (a generous deadline), THEN settle the agent — so the await provably
      // BLOCKS on the running agent and returns only once it settles (no tight wall-clock race).
      const awaiting = postJson(base, '/api/dispatch/await', { agentId: r.agentId, timeoutMs: 10_000 });
      d.resolve(okResult({ text: 'await-done' }));
      const w = await (await awaiting).json() as { ok: boolean; state: string; status: { report: string } };
      assert.equal(w.ok, true);
      assert.equal(w.state, 'done');
      assert.equal(w.status.report, 'await-done');
    });
  } finally {
    cleanup();
  }
});

test('★ WIRED: /await times out (agent still running) → {state:timeout}; the agent keeps running', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const d = deferred<RoleDispatchResult>();
    await withPanel(dir, async () => d.promise, async (base, reg) => {
      const r = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'x' })).json() as { agentId: string };
      const w = await (await postJson(base, '/api/dispatch/await', { agentId: r.agentId, timeoutMs: 20 })).json() as { ok: boolean; state: string };
      assert.equal(w.state, 'timeout');
      assert.equal(reg!.status(r.agentId)!.state, 'running');
      d.resolve(okResult());
      await reg!.awaitAgent(r.agentId);
    });
  } finally {
    cleanup();
  }
});

test('★★ WIRED: /cancel marks a running agent cancelled', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const d = deferred<RoleDispatchResult>();
    await withPanel(dir, async () => d.promise, async (base, reg) => {
      const r = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'x' })).json() as { agentId: string };
      const c = await (await postJson(base, '/api/dispatch/cancel', { agentId: r.agentId })).json() as { ok: boolean; enabled: boolean; state: string };
      assert.equal(c.ok, true);
      assert.equal(c.enabled, true);
      assert.equal(c.state, 'cancelled');
      assert.equal(reg!.status(r.agentId)!.state, 'cancelled');
      d.resolve(okResult()); // late result must not un-cancel
    });
  } finally {
    cleanup();
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// routing precedence + validation + sync coexistence
// ════════════════════════════════════════════════════════════════════════════════

test('★ /api/dispatch/async is NOT swallowed by the bare /api/dispatch branch (route precedence)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const calls: { role: string; task: string }[] = [];
    await withPanel(dir, async (role, task) => { calls.push({ role, task }); return okResult(); }, async (base, reg) => {
      const r = await (await postJson(base, '/api/dispatch/async', { role: 'coding', task: 'precedence' })).json() as { ok: boolean; agentId: string };
      // It hit the ASYNC handler (returned an agentId) — NOT the sync handler (which would 409 with no sessionHost).
      assert.equal(r.ok, true);
      assert.ok(r.agentId);
      await reg!.awaitAgent(r.agentId);
      assert.deepEqual(calls, [{ role: 'coding', task: 'precedence' }]);
    });
  } finally {
    cleanup();
  }
});

test('validation: /async missing role/task → 400; /await + /cancel missing agentId → 400 (never throws to socket)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    await withPanel(dir, async () => okResult(), async (base) => {
      const a = await postJson(base, '/api/dispatch/async', { role: 'coding' });
      assert.equal(a.status, 400);
      const w = await postJson(base, '/api/dispatch/await', {});
      assert.equal(w.status, 400);
      const c = await postJson(base, '/api/dispatch/cancel', {});
      assert.equal(c.status, 400);
    });
  } finally {
    cleanup();
  }
});

test('the SYNC /api/dispatch is unaffected by T2 (still 409 when no session is hosted)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    // registry wired, but NO sessionHost → the sync dispatch route still reports "no hosted session".
    await withPanel(dir, async () => okResult(), async (base) => {
      const res = await postJson(base, '/api/dispatch', { role: 'coding', task: 'x' });
      assert.equal(res.status, 409);
      const body = await res.json() as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /no hosted session/);
    });
  } finally {
    cleanup();
  }
});
