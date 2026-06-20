/**
 * RESULT-RELAY + END-TO-END DISPATCH tests (P1 / M6) — the glue that PROVES the
 * contract end-to-end: route 'planning' → seal → construct driver → run → map the
 * terminal `result` event back as ONE structured report (channel-mute; never the
 * channel). The integration test injects a FAKE driver via the registry (no real
 * network/process) and asserts exactly one result returns. Also exercises the
 * default-OFF routing switch: OFF = nothing dispatches; ON = a sealed standalone
 * claude agent runs and returns one report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchRoleAgent,
  planRoleDispatch,
  mapResultEventToReport,
  reportTokensUsed,
  AgentDispatchError,
  type AgentReport,
} from '../result-relay.js';
import { BackendRegistry } from '../backend-registry.js';
import { AgentConcurrencyGate } from '../agent-concurrency.js';
import type { GitWorktreeRunner } from '../agent-worktree.js';
import {
  isRoleRoutingEnabled,
  ROLE_ROUTING_ENV_VAR,
  DEFAULT_ROLE_ROUTING_CONFIG,
  type RoleRouterConfig,
} from '../role-router.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { ApiAdapterHttpClient, ApiAdapterHttpRequest } from '../api-adapter-driver.js';
import type { BackendSelection, Role } from '../backend-kinds.js';
import type { SessionEvent } from '../session-driver.js';

const KEY_FREE_ENV = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
const PLANNING_CONFIG: RoleRouterConfig = {
  roles: { planning: { backend: 'claude-cli', model: 'claude-opus-4-8[1m]' } },
};

/** A fake program that emits one success result then ends cleanly. */
function successProgram(text: string, sessionId = 'sess-1', costUsd = 0.01): FakeSessionDriver {
  return new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId } },
      { do: 'emit', event: { kind: 'assistant', text: 'thinking…', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId, subtype: 'success', result: text, costUsd } },
      { do: 'endClean' },
    ],
  ]);
}

// ── M6 pure mapping ──────────────────────────────────────────────────────────────
test('mapResultEventToReport maps the result event fields → AgentReport', () => {
  const sel: BackendSelection = { role: 'planning', backend: 'claude-cli' };
  const ev: Extract<SessionEvent, { kind: 'result' }> = {
    kind: 'result',
    sessionId: 's9',
    subtype: 'success',
    result: 'the plan',
    costUsd: 0.02,
  };
  const report = mapResultEventToReport(sel, ev);
  assert.deepEqual(report, {
    role: 'planning',
    backend: 'claude-cli',
    subtype: 'success',
    ok: true,
    text: 'the plan',
    costUsd: 0.02,
    sessionId: 's9',
  } satisfies AgentReport);
});

test('mapResultEventToReport marks ok=false for a non-success subtype', () => {
  const sel: BackendSelection = { role: 'coding', backend: 'claude-cli' };
  const report = mapResultEventToReport(sel, { kind: 'result', sessionId: 's', subtype: 'error_max_turns' });
  assert.equal(report.ok, false);
  assert.equal(report.subtype, 'error_max_turns');
  assert.equal(report.text, undefined);
});

// ── planRoleDispatch: resolve + seal WITHOUT running ──────────────────────────────
test('★ planRoleDispatch resolves planning→claude-cli and SEALS the options (project,local + channel-deny)', () => {
  const { selection, sealed } = planRoleDispatch({
    role: 'planning',
    task: 'design the thing',
    config: PLANNING_CONFIG,
    env: KEY_FREE_ENV,
  });
  assert.equal(selection.backend, 'claude-cli');
  assert.equal(selection.model, 'claude-opus-4-8[1m]');
  // sealed
  assert.deepEqual(sealed.settingSources, ['project', 'local']);
  assert.ok(!sealed.settingSources!.includes('user'));
  assert.ok((sealed.disallowedTools ?? []).some((d) => d.includes('telegram')));
  // the task became the bootstrap turn; the model came from the selection
  assert.deepEqual(sealed.bootstrapTurns, ['design the thing']);
  assert.equal(sealed.model, 'claude-opus-4-8[1m]');
});

test('planRoleDispatch THROWS on a billing-key env (seal asserts key-free)', () => {
  assert.throws(
    () =>
      planRoleDispatch({
        role: 'planning',
        task: 't',
        config: PLANNING_CONFIG,
        env: { ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv,
      }),
    /Refusing to start|ANTHROPIC_API_KEY/,
  );
});

// ── END-TO-END (the P1 proof) ─────────────────────────────────────────────────────
test('★★ END-TO-END: dispatch planning → sealed standalone (fake) claude agent runs + returns EXACTLY ONE report', async () => {
  const fake = successProgram('PLAN: do A then B', 'sess-planning', 0.05);
  // Inject the fake as the claude-cli driver → NO real spawn / NO network.
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });

  const report = await dispatchRoleAgent({
    role: 'planning',
    task: '/orchestrator\n\nplan the migration',
    registry,
    config: PLANNING_CONFIG,
    env: KEY_FREE_ENV,
  });

  // exactly one report, mapped from the terminal result
  assert.equal(report.ok, true);
  assert.equal(report.backend, 'claude-cli');
  assert.equal(report.role, 'planning');
  assert.equal(report.text, 'PLAN: do A then B');
  assert.equal(report.costUsd, 0.05);
  assert.equal(report.sessionId, 'sess-planning');

  // the agent ran SEALED: the fake recorded the start opts the dispatcher passed
  assert.equal(fake.starts, 1, 'the agent was started exactly once');
  const startOpts = fake.startOpts[0]!;
  assert.deepEqual(startOpts.settingSources, ['project', 'local'], 'sealed: project,local (no user)');
  assert.ok((startOpts.disallowedTools ?? []).some((d) => d.includes('telegram')), 'sealed: channel-deny present');
  assert.deepEqual(startOpts.bootstrapTurns, ['/orchestrator\n\nplan the migration'], 'the task was the agent task');
});

test('END-TO-END: an agent stream that ends with NO result → AgentDispatchError (crash surfaced, not wedged)', async () => {
  const crashing = new FakeSessionDriver([[{ do: 'emit', event: { kind: 'assistant', text: 'x', toolUses: [] } }, { do: 'crash' }]]);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => crashing } });
  await assert.rejects(
    () => dispatchRoleAgent({ role: 'planning', task: 't', registry, config: PLANNING_CONFIG, env: KEY_FREE_ENV }),
    AgentDispatchError,
  );
});

test('END-TO-END: dispatch returns ONE report even if the agent emits multiple events before result', async () => {
  // many narration events then exactly one result → still one report (channel-mute: narration not relayed)
  const noisy = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's' } },
      { do: 'emit', event: { kind: 'assistant', text: 'a', toolUses: [] } },
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 't1', content: 'r' } },
      { do: 'emit', event: { kind: 'assistant', text: 'b', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 's', subtype: 'success', result: 'final only' } },
      { do: 'endClean' },
    ],
  ]);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => noisy } });
  const report = await dispatchRoleAgent({ role: 'planning', task: 't', registry, config: PLANNING_CONFIG, env: KEY_FREE_ENV });
  assert.equal(report.text, 'final only');
  assert.equal(report.ok, true);
});

// ── default-OFF switch harness (X5) ───────────────────────────────────────────────
test('★ default-OFF: with SUPERVISOR_ROLE_ROUTING unset, the caller does NOT dispatch (switch gates entry)', async () => {
  // This models the composition-root gate: dispatch only when the switch is ON.
  const env = {} as NodeJS.ProcessEnv; // unset → OFF
  let dispatched = false;
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => successProgram('x') } });

  async function maybeDispatch(role: Role): Promise<AgentReport | null> {
    if (!isRoleRoutingEnabled(env)) return null; // OFF → nothing happens (live path unchanged)
    dispatched = true;
    return dispatchRoleAgent({ role, task: 't', registry, config: PLANNING_CONFIG, env: KEY_FREE_ENV });
  }

  const result = await maybeDispatch('planning');
  assert.equal(result, null, 'OFF → no dispatch');
  assert.equal(dispatched, false);
});

test('★★ switch ON (in the harness): planning dispatches to a sealed standalone claude agent + one report', async () => {
  const env = { [ROLE_ROUTING_ENV_VAR]: '1' } as NodeJS.ProcessEnv; // ON (test-only)
  const fake = successProgram('ROUTED PLAN', 'sess-on', 0.03);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });

  async function maybeDispatch(role: Role): Promise<AgentReport | null> {
    if (!isRoleRoutingEnabled(env)) return null;
    return dispatchRoleAgent({ role, task: 'do it', registry, config: PLANNING_CONFIG, env: KEY_FREE_ENV });
  }

  const report = await maybeDispatch('planning');
  assert.ok(report, 'ON → a report returns');
  assert.equal(report!.text, 'ROUTED PLAN');
  assert.equal(report!.backend, 'claude-cli');
  assert.equal(fake.starts, 1);
  assert.deepEqual(fake.startOpts[0]!.settingSources, ['project', 'local']); // sealed
});

// ── P3: dispatch coding → api-adapter (DeepSeek) end-to-end via the registry ───────
/** An SSE body (text chunks) for a canned DeepSeek completion. */
function dsSseBody(text: string, costUsd = 0.0002): AsyncIterable<string> {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], total_cost_usd: costUsd })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

test('★★ P3 END-TO-END: dispatch coding → SEALED api-adapter (DeepSeek) agent returns code as ONE report', async () => {
  let captured: ApiAdapterHttpRequest | undefined;
  const httpClient: ApiAdapterHttpClient = {
    async stream(req) {
      captured = req;
      return dsSseBody('def add(a, b):\n    return a + b', 0.0002);
    },
  };
  // The registry constructs a REAL ApiAdapterDriver but with the injected (fake) HTTP client →
  // NO network, NO real paid call. The key is read from the injected env.
  const registry = new BackendRegistry({
    apiAdapterHttpClient: httpClient,
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds-key' } as NodeJS.ProcessEnv,
  });

  const report = await dispatchRoleAgent({
    role: 'coding',
    task: 'implement add(a,b)',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG, // coding → api-adapter deepseek-v4-flash
    env: { DEEPSEEK_API_KEY: 'ds-key' } as NodeJS.ProcessEnv, // the seal asserts own-key-only
    ownSecretName: 'DEEPSEEK_API_KEY',
  });

  assert.equal(report.backend, 'api-adapter');
  assert.equal(report.role, 'coding');
  assert.equal(report.ok, true);
  assert.equal(report.subtype, 'success');
  assert.equal(report.text, 'def add(a, b):\n    return a + b');
  assert.equal(report.costUsd, 0.0002);
  // the request was the pinned DeepSeek model
  assert.ok(captured);
  assert.equal(captured!.body.model, 'deepseek-v4-flash');
});

test('★ P3 END-TO-END: a foreign key (stray ANTHROPIC_API_KEY) in a DeepSeek dispatch is REFUSED by the seal', async () => {
  const registry = new BackendRegistry({ apiAdapterHttpClient: { async stream() { return dsSseBody('x'); } } });
  await assert.rejects(
    () =>
      dispatchRoleAgent({
        role: 'coding',
        task: 't',
        registry,
        config: DEFAULT_ROLE_ROUTING_CONFIG,
        env: { DEEPSEEK_API_KEY: 'ds', ANTHROPIC_API_KEY: 'sk-ant-x' } as NodeJS.ProcessEnv,
        ownSecretName: 'DEEPSEEK_API_KEY',
      }),
    /Refusing to spawn|foreign|ANTHROPIC_API_KEY/,
  );
});

test('P3 END-TO-END: a forced DeepSeek API error surfaces as a report with ok=false (FD6 fallback is P5)', async () => {
  // The api-adapter driver converts an API error into a terminal error result → relay maps ok=false
  // (it does NOT throw AgentDispatchError; the stream DID produce a terminal result). FD6 fallback
  // to claude-cli is a later phase (P5) — here we assert the clean surfaced failure.
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { throw new Error('boom'); } },
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds-key' } as NodeJS.ProcessEnv,
  });
  const report = await dispatchRoleAgent({
    role: 'coding',
    task: 't',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds-key' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, false);
  assert.equal(report.backend, 'api-adapter');
  assert.equal(report.subtype, 'error_network');
});

// ════════════════════════════════════════════════════════════════════════════════
// H-1 — REAL per-agent worktree create+teardown at the CHOKE-POINT (mocked git)
// ════════════════════════════════════════════════════════════════════════════════

/** A recording git runner — NO real worktree is created/removed in this repo. */
function recordingRunner(): GitWorktreeRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    add: (p, ref) => void calls.push(`add ${p} ${ref}`),
    remove: (p) => void calls.push(`remove ${p}`),
    prune: () => void calls.push('prune'),
  };
}

test('★★ H-1 dispatch (manageWorktree ON): an FS-writing claude agent CREATES a worktree, threads its cwd, TEARS it down', async () => {
  const fake = successProgram('PLAN', 'sess', 0.01);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });
  const runner = recordingRunner();

  const report = await dispatchRoleAgent({
    role: 'planning',
    task: 'plan it',
    registry,
    config: PLANNING_CONFIG,
    env: KEY_FREE_ENV, // no SUPERVISOR_SESSION_CWD → the dispatcher creates one
    manageWorktree: true,
    worktreeRunner: runner,
  });

  assert.equal(report.ok, true);
  // a worktree was created (add) AND torn down (remove + prune) — even though the agent succeeded
  assert.equal(runner.calls.filter((c) => c.startsWith('add ')).length, 1, 'exactly one worktree created');
  assert.ok(runner.calls.includes('prune'), 'worktree torn down (prune ran)');
  assert.ok(runner.calls.some((c) => c.startsWith('remove ')), 'worktree torn down (remove ran)');
  // the agent ran IN the created worktree (its cwd was threaded into the start options)
  const startCwd = fake.startOpts[0]!.cwd;
  assert.ok(typeof startCwd === 'string' && startCwd.length > 0, 'the agent cwd = the created worktree path');
  const added = runner.calls.find((c) => c.startsWith('add '))!;
  assert.ok(added.includes(startCwd!), 'the created worktree path is the agent cwd');
});

test('★★ H-1 dispatch: a COMPUTE api-adapter agent gets NO worktree (no git at all)', async () => {
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { return dsSseBody('code'); } },
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
  });
  const runner = recordingRunner();

  const report = await dispatchRoleAgent({
    role: 'coding',
    task: 'do it',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
    manageWorktree: true, // ON, but the backend is compute-only → still NO worktree
    worktreeRunner: runner,
  });

  assert.equal(report.backend, 'api-adapter');
  assert.deepEqual(runner.calls, [], 'a compute api-adapter agent runs NO git (no worktree)');
});

test('★★ H-1 dispatch: the worktree is TORN DOWN even when the agent CRASHES (no leaked worktree)', async () => {
  const crashing = new FakeSessionDriver([[{ do: 'emit', event: { kind: 'assistant', text: 'x', toolUses: [] } }, { do: 'crash' }]]);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => crashing } });
  const runner = recordingRunner();

  await assert.rejects(
    () =>
      dispatchRoleAgent({
        role: 'planning',
        task: 't',
        registry,
        config: PLANNING_CONFIG,
        env: KEY_FREE_ENV,
        manageWorktree: true,
        worktreeRunner: runner,
      }),
    AgentDispatchError,
  );
  // created, then reaped despite the crash (the finally ran)
  assert.ok(runner.calls.some((c) => c.startsWith('add ')), 'worktree was created');
  assert.ok(runner.calls.includes('prune'), 'worktree was reaped on the crash path (no leak)');
});

test('★ H-1 dispatch: an ALREADY-isolated agent (SUPERVISOR_SESSION_CWD set) REUSES it — creates NO worktree', async () => {
  const fake = successProgram('PLAN');
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });
  const runner = recordingRunner();

  await dispatchRoleAgent({
    role: 'planning',
    task: 't',
    registry,
    config: PLANNING_CONFIG,
    env: { ...KEY_FREE_ENV, SUPERVISOR_SESSION_CWD: '/repos/wt/already' } as NodeJS.ProcessEnv,
    manageWorktree: true,
    worktreeRunner: runner,
  });
  assert.deepEqual(runner.calls, [], 'an already-isolated agent creates NO new worktree');
});

test('★ H-1 dispatch: manageWorktree DEFAULT-OFF → no git, byte-for-byte the existing primitive', async () => {
  const fake = successProgram('PLAN');
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => fake } });
  const runner = recordingRunner();
  await dispatchRoleAgent({
    role: 'planning',
    task: 't',
    registry,
    config: PLANNING_CONFIG,
    env: KEY_FREE_ENV,
    // manageWorktree omitted → OFF
    worktreeRunner: runner,
  });
  assert.deepEqual(runner.calls, [], 'OFF → no worktree management at all');
  assert.equal(fake.startOpts[0]!.cwd, undefined, 'no cwd injected when worktree mgmt is OFF');
});

// ════════════════════════════════════════════════════════════════════════════════
// M-1 — token/cost forwarded into the report AND the X2 budget gate
// ════════════════════════════════════════════════════════════════════════════════

/** An SSE body carrying a usage block on the final chunk (include_usage). */
function sseWithUsage(text: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, costUsd?: number): AsyncIterable<string> {
  const final: Record<string, unknown> = { choices: [{ delta: {}, finish_reason: 'stop' }], usage };
  if (costUsd !== undefined) final['total_cost_usd'] = costUsd;
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify(final)}\n\n`,
    'data: [DONE]\n\n',
  ];
  return (async function* () { for (const c of chunks) yield c; })();
}

test('★ M-1 reportTokensUsed prefers total, else prompt+completion, else 0', () => {
  assert.equal(reportTokensUsed({ tokens: { total: 100 } }), 100);
  assert.equal(reportTokensUsed({ tokens: { prompt: 30, completion: 70 } }), 100);
  assert.equal(reportTokensUsed({ tokens: {} }), 0);
  assert.equal(reportTokensUsed({}), 0);
});

test('★★ M-1 mapResultEventToReport forwards token usage from the result event', () => {
  const report = mapResultEventToReport(
    { role: 'coding', backend: 'api-adapter' },
    { kind: 'result', sessionId: 's', subtype: 'success', result: 'x', costUsd: 0.001, tokens: { prompt: 12, completion: 8, total: 20 } },
  );
  assert.deepEqual(report.tokens, { prompt: 12, completion: 8, total: 20 });
  assert.equal(report.costUsd, 0.001);
});

test('★★ M-1 END-TO-END: a DeepSeek dispatch populates report.tokens + report.costUsd (not undefined)', async () => {
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { return sseWithUsage('def f(): pass', { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 }, 0.0003); } },
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
  });
  const report = await dispatchRoleAgent({
    role: 'coding',
    task: 'impl f',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.tokens, { prompt: 50, completion: 25, total: 75 });
  assert.equal(report.costUsd, 0.0003); // backend-reported cost preserved
  assert.notEqual(report.tokens, undefined);
});

test('★★ M-1 END-TO-END: an OpenAI/Codex-shape response (NO total_cost_usd) → cost COMPUTED from the rate', async () => {
  // Point the 'reviewing' Codex model at the fake client (no real OpenAI call); no total_cost_usd → priced from usage.
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { return sseWithUsage('LGTM', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }); } },
    apiAdapterEnv: { OPENAI_API_KEY: 'oa' } as NodeJS.ProcessEnv,
  });
  const report = await dispatchRoleAgent({
    role: 'reviewing',
    task: 'review',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG, // reviewing → Codex gpt-5-codex
    env: { OPENAI_API_KEY: 'oa' } as NodeJS.ProcessEnv,
    ownSecretName: 'OPENAI_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.tokens, { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 });
  // 1M input @ $1.25/M + 1M output @ $10/M = $11.25 (the DEFAULT_MODEL_RATES gpt-5-codex placeholder)
  assert.equal(report.costUsd, 11.25);
});

test('★ M-1 a response with NO usage block degrades gracefully (tokens/cost undefined, NO crash)', async () => {
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { return dsSseBody('code', 0); } }, // dsSseBody carries NO usage
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
  });
  const report = await dispatchRoleAgent({
    role: 'coding',
    task: 't',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
  });
  assert.equal(report.ok, true);
  assert.equal(report.tokens, undefined, 'no usage block → tokens undefined (graceful)');
  // dsSseBody reports total_cost_usd:0 → costUsd is 0 (backend-reported), not computed; the point is no crash
});

test('★★ M-1 the X2 budget gate RECEIVES the real token count via the dispatch lease (release(actualTokens))', async () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 4, tokenBudget: 1000 });
  const registry = new BackendRegistry({
    apiAdapterHttpClient: { async stream() { return sseWithUsage('ok', { prompt_tokens: 40, completion_tokens: 60, total_tokens: 100 }, 0.0002); } },
    apiAdapterEnv: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
  });

  const acq = gate.tryAcquire();
  assert.equal(acq.ok, true);
  assert.equal(gate.activeCount, 1);

  await dispatchRoleAgent({
    role: 'coding',
    task: 't',
    registry,
    config: DEFAULT_ROLE_ROUTING_CONFIG,
    env: { DEEPSEEK_API_KEY: 'ds' } as NodeJS.ProcessEnv,
    ownSecretName: 'DEEPSEEK_API_KEY',
    lease: acq.lease, // the dispatcher releases it with the REAL token count
  });

  assert.equal(gate.activeCount, 0, 'the lease was released (slot returned)');
  assert.equal(gate.spentTokens, 100, 'the gate window-spend reflects the REAL tokens used (not an estimate)');
  assert.equal(acq.lease!.released, true);
});

test('★ M-1 the dispatch lease is released (charging 0) even when the agent CRASHES — no slot leak', async () => {
  const gate = new AgentConcurrencyGate({ maxConcurrent: 2, tokenBudget: 500 });
  const crashing = new FakeSessionDriver([[{ do: 'crash' }]]);
  const registry = new BackendRegistry({ factories: { 'claude-cli': () => crashing } });

  const acq = gate.tryAcquire();
  assert.equal(gate.activeCount, 1);
  await assert.rejects(
    () =>
      dispatchRoleAgent({
        role: 'planning',
        task: 't',
        registry,
        config: PLANNING_CONFIG,
        env: KEY_FREE_ENV,
        lease: acq.lease,
      }),
    AgentDispatchError,
  );
  assert.equal(gate.activeCount, 0, 'the lease was released on the crash path (no leaked slot)');
  assert.equal(gate.spentTokens, 0, 'a crash with no usage charges 0 tokens');
});
