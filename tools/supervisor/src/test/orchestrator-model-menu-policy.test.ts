/**
 * T4 — CHANGE-MODEL MENU + ORCHESTRATOR POLICY ALLOW-LIST tests (model-agnostic-orchestrator
 * Tier-1, pieces #2/#3/#4).
 *
 * Two additive surfaces:
 *   1. CONTROL_MODEL_CHOICES now OFFERS the non-Claude orchestrator model ids (deepseek / openai-codex
 *      / gemini) so the operator can pick one in `/control → Change model`; the menu builders still
 *      render every choice + a back button (the change-model→restart→handoff flow is unchanged and
 *      model-agnostic). The Claude default stays first.
 *   2. makeOrchestratorPolicy().allow now ADMITS the four coordinate tool names
 *      (spawn_agent/agent_status/await_agent/cancel_agent) so a non-Claude orchestrator's coordinate
 *      calls AUTO-ALLOW instead of routing to the operator on every spawn (T3's deferred policy item).
 *
 * Pure data / pure builders — no host, no spend.
 *
 * Traces: proposal §3.3 (the menu ids), §3.4 / D-H (the policy floor), §4 T4; the T3 readiness note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_MODEL_CHOICES,
  buildModelSubmenu,
  buildModelSetConfirmMenu,
  controlCallbackData,
  parseControlCallback,
} from '../control-command.js';
import { makeOrchestratorPolicy, isDestructiveOp } from '../profiles.js';
import { ORCHESTRATOR_TOOL_NAMES, ORCHESTRATOR_COORDINATE_TOOLS } from '../orchestrator-tools.js';

const NON_CLAUDE_MENU_IDS = ['deepseek-v4-flash', 'gpt-5-codex', 'gemini-2.5-flash'] as const;

// ════════════════════════════════════════════════════════════════════════════════
// 1. CONTROL_MODEL_CHOICES — the change-model menu offers the non-Claude ids
// ════════════════════════════════════════════════════════════════════════════════

test('★★ CONTROL_MODEL_CHOICES contains the non-Claude orchestrator model ids (deepseek / codex / gemini)', () => {
  for (const id of NON_CLAUDE_MENU_IDS) {
    assert.ok(CONTROL_MODEL_CHOICES.includes(id), `${id} is offered in the change-model menu`);
  }
});

test('★ the Claude default stays FIRST (the change-model header marks it current; the default is unchanged)', () => {
  assert.equal(CONTROL_MODEL_CHOICES[0], 'claude-opus-4-8[1m]', 'Claude Opus 4.8[1m] is still the first/default choice');
  // The three original Claude choices are all still present (additive, not a replacement).
  for (const id of ['claude-opus-4-8[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
    assert.ok(CONTROL_MODEL_CHOICES.includes(id), `${id} retained`);
  }
});

test('★★ buildModelSubmenu still renders: one button per choice (incl. the non-Claude ids) + a back button', () => {
  const sub = buildModelSubmenu('claude-opus-4-8[1m]');
  // one button per model choice + 1 back button
  assert.equal(sub.length, CONTROL_MODEL_CHOICES.length + 1);
  for (let i = 0; i < CONTROL_MODEL_CHOICES.length; i++) {
    assert.deepEqual(parseControlCallback(sub[i]!.callbackData), { action: 'model-set', arg: CONTROL_MODEL_CHOICES[i]! });
  }
  // The non-Claude ids each have a real, parseable model-set button.
  for (const id of NON_CLAUDE_MENU_IDS) {
    const btn = sub.find((b) => parseControlCallback(b.callbackData)?.arg === id);
    assert.ok(btn, `a change-model button exists for ${id}`);
    assert.deepEqual(parseControlCallback(btn!.callbackData), { action: 'model-set', arg: id });
  }
  // The last entry is the back button (the model sub-menu's back returns to the MAIN menu).
  assert.deepEqual(parseControlCallback(sub[sub.length - 1]!.callbackData), { action: 'menu' });
});

test('★ every non-Claude model-set + model-set-confirm callback stays ≤64 bytes (Telegram callback limit)', () => {
  for (const id of NON_CLAUDE_MENU_IDS) {
    assert.ok(Buffer.byteLength(controlCallbackData('model-set', id), 'utf8') <= 64, `model-set:${id} ≤64B`);
    assert.ok(Buffer.byteLength(controlCallbackData('model-set-confirm', id), 'utf8') <= 64, `model-set-confirm:${id} ≤64B`);
  }
});

test('★ buildModelSetConfirmMenu renders the restart-confirm for a non-Claude pick (carries the model id)', () => {
  for (const id of NON_CLAUDE_MENU_IDS) {
    const menu = buildModelSetConfirmMenu(id);
    assert.equal(menu.length, 2);
    assert.deepEqual(parseControlCallback(menu[0]!.callbackData), { action: 'model-set-confirm', arg: id });
    assert.match(menu[0]!.text, new RegExp(id.replace(/[.[\]]/g, '\\$&'))); // the label names the chosen model
    assert.deepEqual(parseControlCallback(menu[1]!.callbackData), { action: 'change-model' }); // back to the list
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// 2. makeOrchestratorPolicy().allow — the coordinate tools auto-allow
// ════════════════════════════════════════════════════════════════════════════════

test('★★ the orchestrator policy ALLOW-LIST admits the four coordinate tools (auto-allow, no route)', () => {
  const policy = makeOrchestratorPolicy();
  for (const name of Object.values(ORCHESTRATOR_TOOL_NAMES)) {
    assert.ok(policy.allow.includes(name), `${name} is allow-listed`);
  }
  // All four manifest tools (the actual driver-exposed names) are covered.
  for (const t of ORCHESTRATOR_COORDINATE_TOOLS) {
    assert.ok(policy.allow.includes(t.function.name), `the manifest tool ${t.function.name} is allow-listed`);
  }
});

test('★★ the coordinate tools are NOT destructive → the safety floor does NOT re-route them', () => {
  // The allow-list only auto-allows when routeWhen (the destructive floor) doesn't catch the tool.
  // The coordinate tools must be NON-destructive so being allow-listed actually means auto-allow.
  for (const name of Object.values(ORCHESTRATOR_TOOL_NAMES)) {
    assert.equal(isDestructiveOp(name, { role: 'coding', task: 'x' }), false, `${name} is not a destructive op`);
    assert.equal(isDestructiveOp(name, { agentId: 'a1' }), false, `${name} (poll/await/cancel shape) is not destructive`);
  }
});

test('★ the policy still ROUTES a genuinely destructive op (the floor is intact — coordinate allow did not weaken it)', () => {
  // Adding the coordinate tools must not have relaxed the floor: a git push / rm -rf still routes.
  assert.equal(isDestructiveOp('Bash', { command: 'git push origin main' }), true);
  assert.equal(isDestructiveOp('Bash', { command: 'rm -rf /tmp/x' }), true);
  // An outward third-party send still routes.
  assert.equal(isDestructiveOp('mcp__whatsapp__send_message', { to: 'x', body: 'y' }), true);
});

test('★ the policy still hard-DENIES telegram + email-send (containment unchanged by the coordinate additions)', () => {
  const policy = makeOrchestratorPolicy();
  const deny = policy.deny ?? [];
  assert.ok(deny.includes('mcp__telegram__*'));
  assert.ok(deny.includes('mcp__plugin_telegram_telegram__*'));
  assert.ok(deny.includes('mcp__hostinger-email__send_email'));
  // The fallback is still 'route' (an unlisted tool stays reachable through canUseTool).
  assert.equal(policy.fallback, 'route');
});
