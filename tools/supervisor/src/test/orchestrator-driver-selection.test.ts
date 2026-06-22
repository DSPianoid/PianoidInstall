/**
 * ORCHESTRATOR DRIVER-SELECTION-BY-MODEL tests (model-agnostic-orchestrator Tier-1, T4 — piece #3).
 *
 * Two surfaces:
 *   1. resolveOrchestratorDriver(model) — the PURE decision: a Claude model id → 'cli-stream'
 *      (today's default); a registry-KNOWN non-Claude provider model id → 'multi-turn-adapter';
 *      anything unrecognized → the proven Claude default (FAIL-SAFE — never an untested non-Claude
 *      path by accident).
 *   2. The GATED driver CONSTRUCTION index.ts performs from that decision: when the orchestrator
 *      model is non-Claude, build a {@link MultiTurnAdapterDriver} with the coordinate tools + the
 *      injected runTool; when it is Claude, the existing cli-stream/sdk ternary — BYTE-FOR-BYTE.
 *
 * index.ts can't be imported as a unit (its main() boots the supervisor), so — exactly like
 * index-async-dispatch-wiring + p6-activation-wiring — these tests REPRODUCE index.ts's construction
 * DECISION at its observable boundary and assert the class/shape that results. ZERO SPEND: the
 * MultiTurnAdapterDriver is constructed but never STARTED (no network, no key read, no paid call);
 * the only assertions are on its type + capability descriptor + that the gate built it at all.
 *
 * Traces: proposal model-agnostic-orchestrator-tier1-2026-06-22 §3.3 (piece #3), §4 T4, §6.4
 * (OFF-path byte-for-byte); CP2, CP5; AP2, AP5; FD7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOrchestratorDriver,
  isClaudeModel,
  DEFAULT_ORCHESTRATOR_DRIVER,
  type OrchestratorDriverKind,
} from '../driver-policy.js';
import { buildDefaultApiAdapterConfigs } from '../provider-registry.js';
import { MultiTurnAdapterDriver, type ParsedToolCall } from '../multi-turn-adapter-driver.js';
import { CliStreamDriver } from '../adapters/cli-stream-driver.js';
import { SdkSessionDriver } from '../adapters/sdk-session-driver.js';
import { ORCHESTRATOR_COORDINATE_TOOLS } from '../orchestrator-tools.js';
import type { SessionDriver } from '../session-driver.js';

// The registry's known non-Claude model ids (the same map index.ts builds for the resolver).
const CONFIG_BY_MODEL = buildDefaultApiAdapterConfigs();
const knows = (m: string) => Object.prototype.hasOwnProperty.call(CONFIG_BY_MODEL, m);

// ════════════════════════════════════════════════════════════════════════════════
// 1. resolveOrchestratorDriver — the pure decision
// ════════════════════════════════════════════════════════════════════════════════

test('★★ Claude orchestrator model → cli-stream (today\'s default, byte-for-byte)', () => {
  assert.equal(DEFAULT_ORCHESTRATOR_DRIVER, 'cli-stream');
  // Every CONTROL_MODEL_CHOICES Claude id + the profile pin resolve to cli-stream.
  for (const m of ['claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
    assert.equal(resolveOrchestratorDriver(m, knows), 'cli-stream', `${m} → cli-stream`);
  }
});

test('★★ each wired NON-Claude provider model id → multi-turn-adapter', () => {
  // The provider-registry default model ids (deepseek / openai-codex / groq / gemini).
  for (const m of Object.keys(CONFIG_BY_MODEL)) {
    assert.equal(resolveOrchestratorDriver(m, knows), 'multi-turn-adapter', `${m} → multi-turn-adapter`);
  }
  // Spot-check the three the change-model menu offers (deepseek/codex/gemini).
  assert.equal(resolveOrchestratorDriver('deepseek-v4-flash', knows), 'multi-turn-adapter');
  assert.equal(resolveOrchestratorDriver('gpt-5-codex', knows), 'multi-turn-adapter');
  assert.equal(resolveOrchestratorDriver('gemini-2.5-flash', knows), 'multi-turn-adapter');
});

test('★★ FAIL-SAFE: undefined / empty / unrecognized model → cli-stream (never an untested non-Claude path)', () => {
  assert.equal(resolveOrchestratorDriver(undefined, knows), 'cli-stream');
  assert.equal(resolveOrchestratorDriver('', knows), 'cli-stream');
  assert.equal(resolveOrchestratorDriver('   ', knows), 'cli-stream');
  // A non-Claude-LOOKING id the registry does NOT know falls back to the SAFE default — it is NOT
  // routed to the non-Claude adapter (no resolvable baseUrl/key → never reach it by accident).
  assert.equal(resolveOrchestratorDriver('deepseek-some-unwired-model', knows), 'cli-stream');
  assert.equal(resolveOrchestratorDriver('gpt-9-imaginary', knows), 'cli-stream');
});

test('★ the default isNonClaudeModel predicate is () => false → only Claude/cli-stream without the registry', () => {
  // Called WITHOUT the registry predicate, NO non-Claude id is recognized → everything non-Claude
  // falls back to cli-stream. (Proves the module is registry-free; the caller injects the knowledge.)
  assert.equal(resolveOrchestratorDriver('deepseek-v4-flash'), 'cli-stream');
  assert.equal(resolveOrchestratorDriver('claude-opus-4-8[1m]'), 'cli-stream');
});

test('isClaudeModel: claude-* (case/space tolerant) is Claude; provider ids + junk are not', () => {
  assert.equal(isClaudeModel('claude-opus-4-8[1m]'), true);
  assert.equal(isClaudeModel('  CLAUDE-sonnet-4-6  '), true);
  assert.equal(isClaudeModel('deepseek-v4-flash'), false);
  assert.equal(isClaudeModel('gpt-5-codex'), false);
  assert.equal(isClaudeModel(''), false);
  assert.equal(isClaudeModel(undefined), false);
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. The GATED driver construction (reproduce index.ts's decision at its boundary)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Reproduce index.ts's T4 construction EXACTLY (the relevant fragment):
 *   const orchestratorModel = config.orchestratorModel ?? profile.model;
 *   const apiAdapterConfigByModel = buildDefaultApiAdapterConfigs();
 *   const kind = profileName === 'orchestrator'
 *     ? resolveOrchestratorDriver(orchestratorModel, m => m in apiAdapterConfigByModel) : 'cli-stream';
 *   if (kind === 'multi-turn-adapter' && orchestratorModel) → MultiTurnAdapterDriver({config, tools, runTool})
 *   else → driver==='cli-stream' ? CliStreamDriver : SdkSessionDriver
 * Returns the constructed driver + the resolved kind so tests assert BOTH.
 */
function constructAsIndex(opts: {
  profileName: 'orchestrator' | 'demo';
  orchestratorModel: string | undefined;
  driver: 'cli-stream' | 'sdk';
  runTool?: (call: ParsedToolCall) => Promise<string>;
}): { driver: SessionDriver; kind: OrchestratorDriverKind } {
  const apiAdapterConfigByModel = buildDefaultApiAdapterConfigs();
  const kind: OrchestratorDriverKind =
    opts.profileName === 'orchestrator'
      ? resolveOrchestratorDriver(opts.orchestratorModel, (m) => Object.prototype.hasOwnProperty.call(apiAdapterConfigByModel, m))
      : 'cli-stream';
  let driver: SessionDriver;
  if (kind === 'multi-turn-adapter' && opts.orchestratorModel) {
    const config = apiAdapterConfigByModel[opts.orchestratorModel]!;
    driver = new MultiTurnAdapterDriver({
      config,
      tools: ORCHESTRATOR_COORDINATE_TOOLS,
      ...(opts.runTool ? { runTool: opts.runTool } : {}),
    });
  } else {
    driver = opts.driver === 'cli-stream' ? new CliStreamDriver({}) : new SdkSessionDriver();
  }
  return { driver, kind };
}

test('★★ NON-Claude orchestrator model → the gate builds a MultiTurnAdapterDriver (tools + runTool)', () => {
  const seen: ParsedToolCall[] = [];
  const runTool = async (c: ParsedToolCall): Promise<string> => {
    seen.push(c);
    return '{"ok":true}';
  };
  const { driver, kind } = constructAsIndex({
    profileName: 'orchestrator',
    orchestratorModel: 'deepseek-v4-flash',
    driver: 'cli-stream',
    runTool,
  });
  assert.equal(kind, 'multi-turn-adapter');
  assert.ok(driver instanceof MultiTurnAdapterDriver, 'a MultiTurnAdapterDriver was constructed');
  assert.ok(!(driver instanceof CliStreamDriver), 'NOT a CliStreamDriver');
  // Its capability descriptor advertises tool-capable + permission-routable (NOT teams) — so the
  // host wires it as a tool-using non-Claude session, distinct from the bare api-adapter.
  const caps = MultiTurnAdapterDriver.capabilities();
  assert.equal(caps.supportsTools, true);
  assert.equal(caps.supportsPermissionRouting, true);
  assert.equal(caps.supportsTeams, false);
  // The driver health detail confirms it is the multi-turn adapter pinned to the chosen model.
  assert.match(driver.health().detail ?? '', /multi-turn-adapter-driver/);
});

test('★★ Claude orchestrator model → the gate builds the ORIGINAL cli-stream driver (byte-for-byte)', () => {
  const { driver, kind } = constructAsIndex({
    profileName: 'orchestrator',
    orchestratorModel: 'claude-opus-4-8[1m]',
    driver: 'cli-stream',
  });
  assert.equal(kind, 'cli-stream');
  assert.ok(driver instanceof CliStreamDriver, 'the proven cli-stream driver (Claude default)');
  assert.ok(!(driver instanceof MultiTurnAdapterDriver), 'NOT the multi-turn adapter');
});

test('★ Claude orchestrator on the SDK driver still builds the SDK driver (the ternary is preserved)', () => {
  const { driver, kind } = constructAsIndex({
    profileName: 'orchestrator',
    orchestratorModel: 'claude-opus-4-8[1m]',
    driver: 'sdk',
  });
  assert.equal(kind, 'cli-stream'); // the model is Claude → not the non-Claude path
  assert.ok(driver instanceof SdkSessionDriver, 'the sdk branch of the original ternary is unchanged');
});

test('★ the DEMO profile NEVER takes the non-Claude path (even with a non-Claude model string)', () => {
  // Defense-in-depth: the non-Claude orchestrator is gated to the orchestrator profile; a demo
  // session with a non-Claude model string still resolves to cli-stream (its own ternary runs).
  const { driver, kind } = constructAsIndex({
    profileName: 'demo',
    orchestratorModel: 'deepseek-v4-flash',
    driver: 'sdk',
  });
  assert.equal(kind, 'cli-stream');
  assert.ok(driver instanceof SdkSessionDriver);
  assert.ok(!(driver instanceof MultiTurnAdapterDriver));
});

test('★ the constructed non-Claude driver carries the COORDINATE tools as its manifest (system_init lists them)', async () => {
  // start() (with a plain system prompt, NO key needed to reach system_init) emits a system_init whose
  // `tools` are the manifest names — proving the gate handed ORCHESTRATOR_COORDINATE_TOOLS to the driver.
  // We read ONLY the first event (system_init) then stop — no completion is issued (no network/spend).
  const { driver } = constructAsIndex({
    profileName: 'orchestrator',
    orchestratorModel: 'deepseek-v4-flash',
    driver: 'cli-stream',
    runTool: async () => '{"ok":true}',
  });
  const it = driver
    .start({ systemPrompt: 'be an orchestrator', bootstrapTurns: [], onPermission: async () => ({ behavior: 'allow' }) })
    [Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value?.kind, 'system_init');
  const tools = (first.value as { tools?: string[] }).tools ?? [];
  for (const t of ORCHESTRATOR_COORDINATE_TOOLS) {
    assert.ok(tools.includes(t.function.name), `system_init advertises ${t.function.name}`);
  }
  await driver.stop();
});
