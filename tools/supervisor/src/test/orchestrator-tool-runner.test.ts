/**
 * ORCHESTRATOR TOOL RUNNER tests (model-agnostic-orchestrator Tier-1, T3 — the SEALED
 * CHOKE-POINT, piece #4). The runner is the {@link ToolRunner} a non-Claude orchestrator's
 * MultiTurnAdapterDriver calls for each coordinate tool. These tests assert the TWO
 * load-bearing containment guarantees + the routing, all with FAKES — NO real claude spawn,
 * NO real permission-channel round-trip / user prompt, NO network, NO spend:
 *
 *   1. ROUTING — each allow-listed coordinate tool (spawn_agent / agent_status / await_agent /
 *      cancel_agent) routes to its matching {@link AsyncDispatchRegistry} method, with the args
 *      threaded through, and the outcome comes back as a tool-result string.
 *   2. ALLOW-CHECK (§6.2) — an unknown / hallucinated tool name is REJECTED: a clean tool-result
 *      error is returned AND nothing is executed (the registry executor is never called, the
 *      permission handler is never even consulted).
 *   3. PERMISSION-DENY (§3.4, D-H) — a coordinate tool the (fake) router DENIES is NOT executed:
 *      a clean tool-result error carrying the deny reason is fed back, and the registry executor
 *      is never called. This is the proof that a non-Claude orchestrator's tool calls go through
 *      the SAME permission floor as Claude's.
 *
 * The runner uses a REAL {@link AsyncDispatchRegistry} (with a FAKE executor) so the routing is
 * exercised end-to-end into the real registry methods — only the executor + the permission
 * handler are faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorToolRunner } from '../orchestrator-tool-runner.js';
import { AsyncDispatchRegistry, type AsyncDispatchExecutor } from '../async-dispatch-registry.js';
import { ORCHESTRATOR_TOOL_NAMES } from '../orchestrator-tools.js';
import type { ParsedToolCall } from '../multi-turn-adapter-driver.js';
import type { PermissionHandler, PermissionRequest } from '../session-driver.js';
import type { RoleDispatchResult } from '../session-host.js';

// ── fakes ────────────────────────────────────────────────────────────────────────

/** A successful RoleDispatchResult the fake executor resolves with. */
function okResult(over: Partial<RoleDispatchResult> = {}): RoleDispatchResult {
  return { ok: true, role: 'coding', backend: 'api-adapter', text: 'done: built X', costUsd: 0.02, fellBack: false, ...over };
}

/** An executor that resolves immediately, recording each (role,task) it was actually called with (the spy). */
function spyExecutor(result: RoleDispatchResult, calls: { role: string; task: string }[]): AsyncDispatchExecutor {
  return async (role, task) => {
    calls.push({ role, task });
    return result;
  };
}

/** A registry with deterministic ids (agt-1, agt-2, …) + a pinned clock. */
function makeRegistry(executor: AsyncDispatchExecutor): AsyncDispatchRegistry {
  let n = 0;
  let clock = 1000;
  return new AsyncDispatchRegistry({ executor, idFn: () => `agt-${++n}`, nowFn: () => clock++ });
}

/** A permission handler that ALLOWS everything, recording each request it saw. */
function allowAll(seen: PermissionRequest[]): PermissionHandler {
  return async (req) => {
    seen.push(req);
    return { behavior: 'allow' };
  };
}

/** A permission handler that DENIES everything, recording each request it saw. */
function denyAll(seen: PermissionRequest[], message = 'operator denied'): PermissionHandler {
  return async (req) => {
    seen.push(req);
    return { behavior: 'deny', message };
  };
}

/** A permission handler that should NEVER be called (fails the test if it is). */
const handlerMustNotBeCalled: PermissionHandler = async (req) => {
  assert.fail(`permission handler must not be called, but was for tool "${req.toolName}"`);
};

/** Build a ParsedToolCall (the shape the driver hands the runner). */
function call(name: string, args: Record<string, unknown> = {}, id = 'tc-1'): ParsedToolCall {
  return { id, name, args, rawArguments: JSON.stringify(args) };
}

/** Parse the runner's tool-result string back to an object for assertions. */
function parse(result: string): { ok: boolean; error?: string; [k: string]: unknown } {
  return JSON.parse(result);
}

// ════════════════════════════════════════════════════════════════════════════════
// 1) ROUTING — each allow-listed tool → its registry method
// ════════════════════════════════════════════════════════════════════════════════

test('spawn_agent → registry.spawn: executor called with (role,task); returns ok + agentId', async () => {
  const calls: { role: string; task: string }[] = [];
  const seen: PermissionRequest[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll(seen) });

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 'build the widget' })));

  assert.equal(out.ok, true);
  assert.equal(out.agentId, 'agt-1'); // the registry issued the handle
  // The permission floor was consulted with the tool name + the args as the input.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolName, ORCHESTRATOR_TOOL_NAMES.spawn);
  assert.deepEqual(seen[0]!.input, { role: 'coding', task: 'build the widget' });
  // The executor (the SEALED dispatch path) actually ran with the threaded role+task.
  assert.deepEqual(calls, [{ role: 'coding', task: 'build the widget' }]);
});

test('agent_status → registry.status: returns the agent snapshot', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult({ text: 'report body' }), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  // Spawn first (through the runner) to get a real handle, then status it.
  const spawn = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  const agentId = spawn.agentId as string;
  // Let the (instant) executor settle the record.
  await new Promise((r) => setImmediate(r));

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.status, { agentId })));
  assert.equal(out.ok, true);
  assert.equal(out.agentId, agentId);
  assert.equal(out.state, 'done');
  assert.equal(out.report, 'report body');
});

test('await_agent → registry.awaitAgent: blocks to terminal, returns state + agent snapshot', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult({ text: 'final' }), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  const spawn = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  const agentId = spawn.agentId as string;

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.await, { agentId, timeoutMs: 5000 })));
  assert.equal(out.ok, true);
  assert.equal(out.state, 'done');
  assert.equal((out.agent as { report?: string }).report, 'final');
});

test('await_agent timeout → tool-result ok with state:timeout (agent keeps running)', async () => {
  // A never-settling executor → await must time out cleanly (not hang, not error).
  const registry = makeRegistry(async () => new Promise<RoleDispatchResult>(() => undefined));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  const spawn = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  const agentId = spawn.agentId as string;

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.await, { agentId, timeoutMs: 10 })));
  assert.equal(out.ok, true);
  assert.equal(out.state, 'timeout');
  // The agent is still tracked + running (await didn't kill it).
  assert.equal(registry.runningCount(), 1);
});

test('cancel_agent → registry.cancel: marks cancelled', async () => {
  // A never-settling executor so the agent is still running when we cancel it.
  const registry = makeRegistry(async () => new Promise<RoleDispatchResult>(() => undefined));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  const spawn = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  const agentId = spawn.agentId as string;

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.cancel, { agentId })));
  assert.equal(out.ok, true);
  assert.equal(out.state, 'cancelled');
  assert.equal(registry.status(agentId)!.state, 'cancelled');
});

// ── routing edge cases (clean tool-result errors, never a throw) ─────────────────

test('spawn_agent with a missing task → clean tool-result error (registry validation), not executed', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding' }))); // no task
  assert.equal(out.ok, false);
  assert.match(String(out.error), /task is required|spawn_agent failed/i);
  assert.equal(calls.length, 0); // the executor never ran (the registry rejected the bad request)
});

test('agent_status / await_agent / cancel_agent with an unknown agentId → clean tool-result error', async () => {
  const registry = makeRegistry(spyExecutor(okResult(), []));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });

  const s = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.status, { agentId: 'nope' })));
  assert.equal(s.ok, false);
  assert.match(String(s.error), /unknown agentId/i);

  const a = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.await, { agentId: 'nope' })));
  assert.equal(a.ok, false);
  assert.match(String(a.error), /unknown agentId/i);

  const c = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.cancel, { agentId: 'nope' })));
  assert.equal(c.ok, false);
  assert.match(String(c.error), /unknown agentId/i);
});

test('a missing agentId arg → clean tool-result error (no throw)', async () => {
  const registry = makeRegistry(spyExecutor(okResult(), []));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll([]) });
  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.status, {}))); // no agentId
  assert.equal(out.ok, false);
  assert.match(String(out.error), /requires an agentId/i);
});

// ════════════════════════════════════════════════════════════════════════════════
// 2) ALLOW-CHECK — unknown tool REJECTED, never executed, handler never consulted
// ════════════════════════════════════════════════════════════════════════════════

test('an UNKNOWN tool name is REJECTED: clean tool-error, executor NEVER called, handler NEVER consulted', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  // The permission handler must NOT even be reached for a non-coordinate tool — the allow-check is first.
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: handlerMustNotBeCalled });

  const out = parse(await runTool(call('Bash', { command: 'rm -rf /' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /unknown tool "Bash"/);
  assert.match(String(out.error), /NOT executed/);
  assert.equal(calls.length, 0); // nothing dispatched
});

test('a tool whose name SHADOWS a real tool but is not a coordinate tool is rejected (allow-check is exact)', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: handlerMustNotBeCalled });

  for (const bad of ['spawn', 'spawn_agent_x', 'SPAWN_AGENT', 'await', 'mcp__telegram__send_message', '']) {
    const out = parse(await runTool(call(bad)));
    assert.equal(out.ok, false, `expected ${bad} rejected`);
    assert.match(String(out.error), /unknown tool/);
  }
  assert.equal(calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════
// 3) PERMISSION-DENY — a routed coordinate tool the router denies is NOT executed
// ════════════════════════════════════════════════════════════════════════════════

test('a DENIED coordinate tool → clean tool-error with the deny reason; executor NEVER called', async () => {
  const calls: { role: string; task: string }[] = [];
  const seen: PermissionRequest[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: denyAll(seen, 'user said no') });

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 'do a dangerous thing' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /permission denied/i);
  assert.match(String(out.error), /user said no/);
  assert.match(String(out.error), /NOT performed/);
  // The handler WAS consulted (it's a coordinate tool) ...
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.toolName, ORCHESTRATOR_TOOL_NAMES.spawn);
  // ... but because it denied, the SEALED executor never ran.
  assert.equal(calls.length, 0);
});

test('deny applies to EVERY coordinate tool (spawn/status/await/cancel), none execute', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: denyAll([]) });

  for (const name of Object.values(ORCHESTRATOR_TOOL_NAMES)) {
    const out = parse(await runTool(call(name, { role: 'r', task: 't', agentId: 'x' })));
    assert.equal(out.ok, false, `${name} should be denied`);
    assert.match(String(out.error), /permission denied/i);
  }
  assert.equal(calls.length, 0); // no executor invocation at all
});

test('the permission request carries the sessionId when one is configured', async () => {
  const seen: PermissionRequest[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), []));
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: allowAll(seen), sessionId: 'sess-42' });

  await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.sessionId, 'sess-42');
});

test('a router that ALLOWS with updatedInput → the rewritten input is dispatched', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const handler: PermissionHandler = async () => ({ behavior: 'allow', updatedInput: { role: 'reviewing', task: 'rewritten' } });
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: handler });

  await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 'original' }));
  assert.deepEqual(calls, [{ role: 'reviewing', task: 'rewritten' }]);
});

// ════════════════════════════════════════════════════════════════════════════════
// containment backstop — a THROWING handler / executor is contained as a tool-result, never thrown
// ════════════════════════════════════════════════════════════════════════════════

test('a THROWING permission handler is contained: a clean tool-result error, never a throw', async () => {
  const calls: { role: string; task: string }[] = [];
  const registry = makeRegistry(spyExecutor(okResult(), calls));
  const handler: PermissionHandler = async () => {
    throw new Error('router blew up');
  };
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: handler });

  const out = parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /failed unexpectedly|router blew up/i);
  assert.equal(calls.length, 0); // a thrown gate → nothing dispatched (fail-safe)
});
