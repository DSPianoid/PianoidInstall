/**
 * ORCHESTRATOR TOOL MANIFEST tests (model-agnostic-orchestrator Tier-1, piece #2). Pure
 * data assertions on the OpenAI tool definitions the teams-replacement exposes — the
 * shapes T3 wires into the MultiTurnAdapterDriver's `tools` + the choke-point validates
 * against. NO I/O.
 *
 * Coverage: the 4 tools (spawn/status/await/cancel) are valid OpenAI `ToolSchema`s with the
 * right names, required params, and JSON-Schema parameter objects; the bundle is in a stable
 * order with no dupes; the names match the canonical name map; isOrchestratorToolName gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATOR_COORDINATE_TOOLS,
  ORCHESTRATOR_TOOL_NAMES,
  SPAWN_AGENT_TOOL,
  AGENT_STATUS_TOOL,
  AWAIT_AGENT_TOOL,
  CANCEL_AGENT_TOOL,
  isOrchestratorToolName,
} from '../orchestrator-tools.js';
import { buildToolCompletionRequest, type ToolSchema } from '../multi-turn-adapter-driver.js';
import { DEEPSEEK_CODING_CONFIG } from '../api-adapter-driver.js';

/** Assert a value is a well-formed OpenAI function-tool schema. */
function assertValidToolSchema(t: ToolSchema, name: string): void {
  assert.equal(t.type, 'function');
  assert.equal(t.function.name, name);
  assert.equal(typeof t.function.description, 'string');
  assert.ok((t.function.description ?? '').length > 0, `${name} must have a non-empty description`);
  const params = t.function.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  assert.equal(params.type, 'object', `${name}.parameters must be a JSON-Schema object`);
  assert.equal(typeof params.properties, 'object');
}

test('★ the 4 coordinate tools are valid OpenAI function schemas with the canonical names', () => {
  assertValidToolSchema(SPAWN_AGENT_TOOL, 'spawn_agent');
  assertValidToolSchema(AGENT_STATUS_TOOL, 'agent_status');
  assertValidToolSchema(AWAIT_AGENT_TOOL, 'await_agent');
  assertValidToolSchema(CANCEL_AGENT_TOOL, 'cancel_agent');
});

test('the canonical name map matches the tool function names', () => {
  assert.equal(ORCHESTRATOR_TOOL_NAMES.spawn, SPAWN_AGENT_TOOL.function.name);
  assert.equal(ORCHESTRATOR_TOOL_NAMES.status, AGENT_STATUS_TOOL.function.name);
  assert.equal(ORCHESTRATOR_TOOL_NAMES.await, AWAIT_AGENT_TOOL.function.name);
  assert.equal(ORCHESTRATOR_TOOL_NAMES.cancel, CANCEL_AGENT_TOOL.function.name);
});

test('★ spawn_agent requires role + task', () => {
  const p = SPAWN_AGENT_TOOL.function.parameters as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual([...p.required].sort(), ['role', 'task']);
  assert.ok('role' in p.properties && 'task' in p.properties);
});

test('★ status/await/cancel each require agentId; await has an optional integer timeoutMs', () => {
  for (const t of [AGENT_STATUS_TOOL, AWAIT_AGENT_TOOL, CANCEL_AGENT_TOOL]) {
    const p = t.function.parameters as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(p.required, ['agentId'], `${t.function.name} must require agentId`);
    assert.ok('agentId' in p.properties);
  }
  const awaitParams = AWAIT_AGENT_TOOL.function.parameters as { properties: { timeoutMs: { type: string }; required?: string[] }; required: string[] };
  assert.equal(awaitParams.properties.timeoutMs.type, 'integer');
  assert.ok(!awaitParams.required.includes('timeoutMs'), 'timeoutMs is optional');
});

test('★ ORCHESTRATOR_COORDINATE_TOOLS bundles all 4 in a stable order with no duplicate names', () => {
  const names = ORCHESTRATOR_COORDINATE_TOOLS.map((t) => t.function.name);
  assert.deepEqual(names, ['spawn_agent', 'agent_status', 'await_agent', 'cancel_agent']);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
});

test('isOrchestratorToolName gates exactly the 4 coordinate tools (the choke-point allow-check)', () => {
  assert.equal(isOrchestratorToolName('spawn_agent'), true);
  assert.equal(isOrchestratorToolName('agent_status'), true);
  assert.equal(isOrchestratorToolName('await_agent'), true);
  assert.equal(isOrchestratorToolName('cancel_agent'), true);
  assert.equal(isOrchestratorToolName('read_file'), false);
  assert.equal(isOrchestratorToolName('git_push'), false);
  assert.equal(isOrchestratorToolName(''), false);
});

test('★ the manifest plugs into the T1 driver request builder (tools wired, tool_choice auto)', () => {
  // The whole point of piece #2: this manifest IS the MultiTurnAdapterDriver's `tools` (T3 wiring).
  const req = buildToolCompletionRequest(DEEPSEEK_CODING_CONFIG, [{ role: 'user', content: 'coordinate' }], ORCHESTRATOR_COORDINATE_TOOLS, 'auto');
  assert.equal(req.tools!.length, 4);
  assert.deepEqual(req.tools!.map((t) => t.function.name), ['spawn_agent', 'agent_status', 'await_agent', 'cancel_agent']);
  assert.equal(req.tool_choice, 'auto');
});
