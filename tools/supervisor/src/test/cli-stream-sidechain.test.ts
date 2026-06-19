/**
 * FLOOD FIX (2026-06-19) — sub-agent (sidechain) suppression in the cli-stream mapper.
 *
 * When the orchestrator spawns a sub-agent (Agent/Task tool), the sub-agent's assistant
 * narration + tool_result messages ride the SAME `claude -p` stream-json stdout, tagged
 * with a NON-NULL `parent_tool_use_id`. mapCliMessage MUST drop them — otherwise every
 * line a background agent "thinks out loud" is mapped to an assistant event → onAssistant
 * → forwarded to the channel (the observed flood: ~16 sub-agent narration messages reached
 * the user in one /dev run). The orchestrator's OWN messages (parent null/absent) — incl.
 * the Agent/Task tool_use that SPAWNS the sub-agent — MUST pass through unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCliMessage } from '../adapters/cli-stream-driver.js';

test('mapCliMessage DROPS a sub-agent (sidechain) assistant message', () => {
  const sidechain = {
    type: 'assistant',
    parent_tool_use_id: 'toolu_abc123', // non-null → produced inside an Agent/Task sub-agent
    message: { content: [{ type: 'text', text: 'I will start by reading the context files.' }] },
  };
  assert.equal(mapCliMessage(sidechain), null);
});

test('mapCliMessage DROPS a sub-agent (sidechain) tool_result (user) message', () => {
  const sidechain = {
    type: 'user',
    parent_tool_use_id: 'toolu_abc123',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  };
  assert.equal(mapCliMessage(sidechain), null);
});

test("mapCliMessage KEEPS the orchestrator's OWN assistant text (parent_tool_use_id null)", () => {
  const own = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: 'On it — dispatching the fix.' }] },
  };
  const ev = mapCliMessage(own);
  assert.equal(ev?.kind, 'assistant');
  assert.equal((ev as { text: string }).text, 'On it — dispatching the fix.');
});

test("mapCliMessage KEEPS the orchestrator's OWN Agent/Task tool_use that SPAWNS a sub-agent", () => {
  // The spawn is on the MAIN agent's turn (parent null) → the user still sees the
  // orchestrator spawning an agent via tool-activity forwarding; only the sub-agent's
  // INTERNAL narration (parent != null) is suppressed.
  const spawn = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'toolu_abc123', name: 'Agent', input: { description: 'fix x' } }] },
  };
  const ev = mapCliMessage(spawn);
  assert.equal(ev?.kind, 'assistant');
  assert.deepEqual((ev as { toolUses: { name: string }[] }).toolUses.map((t) => t.name), ['Agent']);
});

test('mapCliMessage KEEPS a message with NO parent_tool_use_id field (absent ≠ sidechain)', () => {
  // Absent (undefined) must be treated as main-agent (kept): `undefined != null` is false.
  // Guards against silently swallowing the orchestrator's own output if the field is omitted.
  const own = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
  assert.equal(mapCliMessage(own)?.kind, 'assistant');
});

test('mapCliMessage KEEPS session-level system_init + result (parent always null)', () => {
  assert.equal(mapCliMessage({ type: 'system', subtype: 'init', session_id: 's1' })?.kind, 'system_init');
  assert.equal(
    mapCliMessage({ type: 'result', subtype: 'success', session_id: 's1', result: 'done' })?.kind,
    'result',
  );
});
