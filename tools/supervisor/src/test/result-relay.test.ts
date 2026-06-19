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
  AgentDispatchError,
  type AgentReport,
} from '../result-relay.js';
import { BackendRegistry } from '../backend-registry.js';
import { isRoleRoutingEnabled, ROLE_ROUTING_ENV_VAR, type RoleRouterConfig } from '../role-router.js';
import { FakeSessionDriver } from './fake-session-driver.js';
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
