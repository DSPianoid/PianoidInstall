/**
 * FLOOD FIX (2026-06-19) — sub-agent suppression in the cli-stream mapper.
 *
 * When the orchestrator spawns a sub-agent (Agent/Task tool), the sub-agent's assistant
 * narration + tool_result messages ride the SAME `claude -p` stream-json stdout. mapCliMessage
 * MUST drop them — otherwise every line a sub-agent "thinks out loud" is mapped to an assistant
 * event → onAssistant → forwarded to the channel (the observed flood). The orchestrator's OWN
 * messages MUST pass through unchanged.
 *
 * TWO sub-agent markers (measured against raw `claude -p` stream-json,
 * docs/development/diagnostics/dev-f982-raw-envelope-probe.mjs):
 *   1. FOREGROUND sidechain (Agent/Task run inline) → a non-null `parent_tool_use_id`.
 *   2. BACKGROUND task (Agent run_in_background:true) → a top-level `subagent_type` (e.g.
 *      "general-purpose") + `task_description`. A background sub-agent message is NOT reliably
 *      tagged with parent_tool_use_id (it leaked to the user with parent_tool_use_id==null —
 *      exactly what the original 2224ed4 guard missed), but it ALWAYS carries `subagent_type`.
 * The orchestrator's OWN messages carry NEITHER marker → kept.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCliMessage } from '../adapters/cli-stream-driver.js';

// The EXACT shape of a BACKGROUND sub-agent's assistant narration, copied faithfully from
// the raw `claude -p` stream-json probe (dev-f982-raw-envelope-probe.mjs, line 8): top-level
// `subagent_type` + `task_description`, message.content carries the leaked narration text.
const BACKGROUND_SUBAGENT_ASSISTANT = {
  type: 'assistant',
  parent_tool_use_id: null, // ★ the background case leaks with NULL parent — subagent_type is the marker
  session_id: 'eaa16f81-e5fd-4798-b58c-75c3c5fe4d1b',
  uuid: 'f645df25-33a8-484e-813e-157cf9098a91',
  request_id: 'req_011CcCwCx3XFZ5TBemzhS3YL',
  subagent_type: 'general-purpose',
  task_description: 'probe bg',
  message: { role: 'assistant', content: [{ type: 'text', text: 'I now have a strong grasp of the architecture.' }] },
};

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

// ── BACKGROUND-task sub-agent suppression (the 2224ed4 gap this fix closes) ──────────────

test('mapCliMessage DROPS a BACKGROUND-task assistant message (subagent_type set, parent_tool_use_id NULL)', () => {
  // The real leak: a run_in_background sub-agent's narration arrives with parent_tool_use_id
  // == null, so the original parent-only guard let it through to the channel. The top-level
  // `subagent_type` marker catches it. (Shape copied from the raw stream-json probe.)
  assert.equal(mapCliMessage(BACKGROUND_SUBAGENT_ASSISTANT), null);
});

test('mapCliMessage DROPS a background sub-agent assistant even with NO parent_tool_use_id FIELD at all', () => {
  // Defensive: same as above but the field is entirely absent (not just null) — subagent_type
  // alone must still trigger the drop.
  const bg = {
    type: 'assistant',
    subagent_type: 'general-purpose',
    task_description: 'research the thing',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Confirmed: no prior same-topic proposal exists.' }] },
  };
  assert.equal(mapCliMessage(bg), null);
});

test('mapCliMessage DROPS a background sub-agent TOOL_USE narration (subagent_type set)', () => {
  // A background agent also emits tool_use blocks; those must be dropped too (they would
  // otherwise forward as "⚙️ Read" etc. tool-activity lines).
  const bg = {
    type: 'assistant',
    parent_tool_use_id: null,
    subagent_type: 'general-purpose',
    task_description: 'probe bg',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: '/x' } }] },
  };
  assert.equal(mapCliMessage(bg), null);
});

test("mapCliMessage KEEPS the orchestrator's OWN assistant text when subagent_type is ABSENT (no over-drop)", () => {
  // The CRUX: the orchestrator's own main-session message has neither parent_tool_use_id nor
  // subagent_type → it MUST still reach the user (over-dropping would silence the orchestrator).
  const own = {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'eaa16f81-e5fd-4798-b58c-75c3c5fe4d1b',
    request_id: 'req_own',
    message: { role: 'assistant', content: [{ type: 'text', text: "I've launched the background agent. Waiting for it." }] },
  };
  const ev = mapCliMessage(own);
  assert.equal(ev?.kind, 'assistant');
  assert.equal((ev as { text: string }).text, "I've launched the background agent. Waiting for it.");
});

test('mapCliMessage KEEPS a result event even though task_notification/task_started carry subagent_type', () => {
  // subagent_type also tags type:'system' subtype:'task_started'/'task_notification' events, but
  // those are already dropped (the mapper only models system+subtype=='init'). The session-level
  // `result` (no subagent_type) must still pass — guard never touches it.
  assert.equal(
    mapCliMessage({ type: 'result', subtype: 'success', session_id: 's1', result: 'done' })?.kind,
    'result',
  );
});
