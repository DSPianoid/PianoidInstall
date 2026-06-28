/**
 * INDEX.TS GATED-COMPOSITION tests (model-agnostic-orchestrator Tier-1, T3 — the composition-root
 * wiring of the teams-replacement). T3 makes index.ts (a) construct an {@link AsyncDispatchRegistry}
 * from the SEALED `dispatchRoleAgent` closure UNDER the role-routing gate, (b) inject it into the
 * Panel via the proven conditional-spread, and (c) make the tool-runner choke-point available for a
 * non-Claude orchestrator driver (T4). The live orchestrator still runs cli-stream/Claude — the
 * driver is NOT switched here.
 *
 * THE SACRED INVARIANT (mirrors the P6 activation-wiring test): with SUPERVISOR_ROLE_ROUTING OFF (the
 * default), the constructed system is BYTE-FOR-BYTE today. index.ts can't be imported as a unit (its
 * main() boots the supervisor), so — exactly like p6-activation-wiring + control-activation-wiring —
 * these tests assert the composition DECISION at its observable boundary:
 *   - the conditional-spread index.ts uses produces KEY-ABSENCE when the gate local is undefined
 *     (not `asyncDispatchRegistry: undefined`) → identical Panel ctor-args shape (OFF byte-for-byte);
 *   - ON: the registry is built from the EXACT `dispatchRoleAgent` executor closure, so an async
 *     spawn routes through the sealed closure; and the tool-runner choke-point over the REAL
 *     PermissionRouter routes an approved coordinate call to that same closure.
 *
 * ZERO SPEND: a FAKE executor (a scripted RoleDispatchFn) + a FAKE permission channel — NO real
 * claude spawn, NO network, NO user prompt, NO spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AsyncDispatchRegistry, type AsyncDispatchExecutor } from '../async-dispatch-registry.js';
import { createOrchestratorToolRunner } from '../orchestrator-tool-runner.js';
import { ORCHESTRATOR_TOOL_NAMES } from '../orchestrator-tools.js';
import { PermissionRouter, type PermissionPolicy } from '../permission-router.js';
import { makeOrchestratorPolicy } from '../profiles.js';
import type { ParsedToolCall } from '../multi-turn-adapter-driver.js';
import type { RoleDispatchFn, RoleDispatchResult } from '../session-host.js';

// ── fakes ────────────────────────────────────────────────────────────────────────

function okResult(over: Partial<RoleDispatchResult> = {}): RoleDispatchResult {
  return { ok: true, role: 'coding', backend: 'api-adapter', text: 'report', costUsd: 0.01, fellBack: false, ...over };
}

/** The EXACT shape index.ts's dispatchRoleAgent has (RoleDispatchFn), recording its calls. */
function fakeDispatchRoleAgent(calls: { role: string; task: string }[]): RoleDispatchFn {
  return async (role: string, task: string): Promise<RoleDispatchResult> => {
    calls.push({ role, task });
    return okResult({ role });
  };
}

function call(name: string, args: Record<string, unknown> = {}): ParsedToolCall {
  return { id: 'tc', name, args, rawArguments: JSON.stringify(args) };
}

/**
 * Reproduce index.ts's EXACT conditional-spread for the Panel's async registry. index.ts:
 *   new Panel({ port, supervisor, logger, sessionHost, controllerBridge,
 *               ...(asyncDispatchRegistry ? { asyncDispatchRegistry } : {}) })
 * This helper builds JUST the spread fragment so we can assert key-presence/absence without
 * standing up a whole Panel (the panel-async-dispatch test covers the live Panel behavior).
 */
function panelRegistrySpread(asyncDispatchRegistry: AsyncDispatchRegistry | undefined): Record<string, unknown> {
  return { ...(asyncDispatchRegistry ? { asyncDispatchRegistry } : {}) };
}

// ════════════════════════════════════════════════════════════════════════════════
// OFF path — byte-for-byte (the conditional-spread omits the key when undefined)
// ════════════════════════════════════════════════════════════════════════════════

test('★★ OFF (gate off): asyncDispatchRegistry undefined ⇒ the Panel spread has NO asyncDispatchRegistry key', () => {
  const spread = panelRegistrySpread(undefined);
  // key-ABSENCE, not key:undefined — the Panel ctor-args are byte-for-byte today.
  assert.equal('asyncDispatchRegistry' in spread, false);
  assert.deepEqual(spread, {});
  assert.deepEqual(Object.keys(spread), []);
});

test('★ OFF path mirrors the existing dispatchRoleAgent gate: both stay undefined together', () => {
  // index.ts assigns BOTH dispatchRoleAgent and asyncDispatchRegistry only inside `if(roleRoutingEnabled)`.
  // With the gate OFF both are undefined → neither key is spread into the SessionHost/Panel ctor.
  let dispatchRoleAgent: RoleDispatchFn | undefined;
  let asyncDispatchRegistry: AsyncDispatchRegistry | undefined;
  const hostSpread = { ...(dispatchRoleAgent ? { dispatchRoleAgent } : {}) };
  const panelSpread = { ...(asyncDispatchRegistry ? { asyncDispatchRegistry } : {}) };
  assert.deepEqual(hostSpread, {});
  assert.deepEqual(panelSpread, {});
});

// ════════════════════════════════════════════════════════════════════════════════
// ON path — registry built from the sealed closure; key present in the spread
// ════════════════════════════════════════════════════════════════════════════════

test('★★ ON (gate on): the registry is built from dispatchRoleAgent ⇒ the spread carries the key', () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  // EXACTLY what index.ts does inside `if(config.roleRoutingEnabled)`:
  const asyncDispatchRegistry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor });

  const spread = panelRegistrySpread(asyncDispatchRegistry);
  assert.equal('asyncDispatchRegistry' in spread, true);
  assert.equal(spread.asyncDispatchRegistry, asyncDispatchRegistry);
});

test('★ ON: an async spawn through the index-built registry routes to the SEALED dispatchRoleAgent closure', async () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor, idFn: () => 'agt-1' });

  const spawn = registry.spawn('analysis', 'study the module');
  assert.equal(spawn.ok, true);
  await registry.awaitAgent(spawn.agentId!, 1000);
  // The registry drove the EXACT closure index.ts passes (the role-router + seal + spend-gate path).
  assert.deepEqual(calls, [{ role: 'analysis', task: 'study the module' }]);
  assert.equal(registry.status(spawn.agentId!)!.state, 'done');
});

// ════════════════════════════════════════════════════════════════════════════════
// ON path — the tool-runner choke-point over the REAL PermissionRouter (the safety claim)
// ════════════════════════════════════════════════════════════════════════════════

/** Build the real PermissionRouter with the REAL orchestrator policy, plus a scripted channel verdict. */
function realRouterWith(
  verdict: 'allow' | 'deny' | 'timeout',
  seenTools: string[],
  policyOver?: Partial<PermissionPolicy>,
): PermissionRouter {
  const policy: PermissionPolicy = { ...makeOrchestratorPolicy(), ...policyOver };
  return new PermissionRouter({
    policy,
    channel: {
      askUser: async (req) => {
        seenTools.push(req.toolName);
        return verdict;
      },
    },
  });
}

test('★★ ON end-to-end: runTool over the REAL router (coordinate tool ALLOW-listed) → routes to the sealed closure', async () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor, idFn: () => 'agt-1' });

  // The coordinate tools are explicitly allow-listed in the orchestrator policy at activation so they
  // don't spuriously route every time (T4 policy wiring). Model that here: allow the 4 tool names.
  const seenTools: string[] = [];
  const router = realRouterWith('allow', seenTools, { allow: [...Object.values(ORCHESTRATOR_TOOL_NAMES)] });
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: router.decide });

  const out = JSON.parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 'build X' })));
  assert.equal(out.ok, true);
  assert.equal(out.agentId, 'agt-1');
  await registry.awaitAgent('agt-1', 1000);
  assert.deepEqual(calls, [{ role: 'coding', task: 'build X' }]);
  // Allow-listed → the router did NOT need to ask the user.
  assert.deepEqual(seenTools, []);
});

test('★★ ON safety floor: a coordinate call that ROUTES + a deny is NOT executed', async () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor, idFn: () => 'agt-1' });

  // ★ T4 NOTE: the production orchestrator policy now AUTO-ALLOWS the four coordinate tools (so a
  // non-Claude orchestrator's spawn/poll/await/cancel don't ask the user every time). To exercise the
  // runner's PERMISSION-FLOOR fail-safe here, override the policy so the coordinate tool is NOT
  // allow-listed → it hits fallback:'route' → the user is asked → the user DENIES → the runner returns
  // a clean tool-error and the sealed closure never runs. (The auto-allow path is asserted by the
  // ALLOW test above + orchestrator-model-menu-policy.test.ts.)
  const seenTools: string[] = [];
  const router = realRouterWith('deny', seenTools, { allow: ['Read'] }); // coordinate tools NOT allow-listed → routes
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: router.decide });

  const out = JSON.parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /permission denied/i);
  // It WAS routed to the user (the safety floor), and the deny blocked the dispatch.
  assert.deepEqual(seenTools, [ORCHESTRATOR_TOOL_NAMES.spawn]);
  assert.equal(calls.length, 0);
});

test('★★ ON safety floor: a no-reply (timeout) DENIES fail-safe; the sealed closure never runs', async () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor });

  // As above, force the coordinate tool to ROUTE (not the T4 auto-allow) so the timeout fail-safe is
  // exercised: no user reply → the router maps to deny (fail-safe) → the closure never runs.
  const router = realRouterWith('timeout', [], { allow: ['Read'] }); // routes; no reply → deny
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: router.decide });

  const out = JSON.parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 't' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /permission denied/i);
  assert.equal(calls.length, 0);
});

test('★★ T4: under the PRODUCTION orchestrator policy the coordinate tools AUTO-ALLOW (no user prompt)', async () => {
  // The T4 policy change: spawn/status/await/cancel are allow-listed, so the runner dispatches WITHOUT
  // routing to the user. This is the behavior the prior "NOT allow-listed → routes" test asserted before
  // T4; now the DEFAULT (un-overridden) policy auto-allows. (The deny/timeout fail-safe above still holds
  // when a tool is NOT allow-listed — defense for any future un-listed coordinate tool.)
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor, idFn: () => 'agt-1' });

  const seenTools: string[] = [];
  const router = realRouterWith('deny', seenTools); // even with the user set to DENY, an allow-listed tool never asks
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: router.decide });

  const out = JSON.parse(await runTool(call(ORCHESTRATOR_TOOL_NAMES.spawn, { role: 'coding', task: 'build X' })));
  assert.equal(out.ok, true, 'auto-allowed → the spawn ran');
  assert.equal(out.agentId, 'agt-1');
  await registry.awaitAgent('agt-1', 1000);
  assert.deepEqual(calls, [{ role: 'coding', task: 'build X' }]);
  assert.deepEqual(seenTools, [], 'the allow-listed coordinate tool did NOT route to the user');
});

test('★ the same router instance gates an UNKNOWN tool via the runner allow-check FIRST (never reaches the router)', async () => {
  const calls: { role: string; task: string }[] = [];
  const dispatchRoleAgent: RoleDispatchFn = fakeDispatchRoleAgent(calls);
  const registry = new AsyncDispatchRegistry({ executor: dispatchRoleAgent as AsyncDispatchExecutor });

  const seenTools: string[] = [];
  const router = realRouterWith('allow', seenTools); // even an allow-all router must not see an unknown tool
  const runTool = createOrchestratorToolRunner({ registry, permissionHandler: router.decide });

  const out = JSON.parse(await runTool(call('Bash', { command: 'git push --force' })));
  assert.equal(out.ok, false);
  assert.match(String(out.error), /unknown tool "Bash"/);
  assert.deepEqual(seenTools, []); // the allow-check short-circuited before the router
  assert.equal(calls.length, 0);
});
