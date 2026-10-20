/**
 * The assistant's permission policy (user decisions D3 / D4, 2026-10-15; v2 P2 approvals, §9). Pure.
 *
 * One installation = one user (D5: no user management): the owner-level rules below apply.
 *
 * decide({command, tier, family, category, settings}) ->
 *   {action: 'allow' | 'confirm' | 'deny', reason, auto?, watch?, hard?, canAuto?}
 * It is called for EVERY tool call from the service's canUseTool hook (and again by the MCP
 * server for deny) — never left to the prompt. In order:
 *
 *   excluded                                never listed; deny if asked anyway
 *   data opt-out ON (D4, default off)       modal / calibration tools DENY
 *   render.* (act) while live audio runs    the stop -> render -> restart renders (LIVE_RENDERS) ask
 *                                           (live audio pauses for the render); any other render, e.g. an
 *                                           output_scale calibration render, is DENIED (R6). Reads never.
 *   a web-tainted turn (P7)                 every non-read asks, hard (never Auto)
 *   a plan approval (dev-28f1, DORMANT:     `settings.plan` = planApproval.js matchGrant, set by the service
 *     PIANOID_ASSISTANT_PLAN_APPROVAL=1)    only with the flag on: a step inside the user's grant runs
 *                                           (auto). A hard-confirm command only when the user ticked it
 *                                           (`plan.ticked`); params / runtime still need the A2 envelope;
 *                                           never `code`, never reads. After the deny rows and the tainted
 *                                           row, so a plan can never bypass them
 *   the hard-confirm list                   asks, hard: never Auto, no "don't ask again"
 *   category Ask (approvals.js)             asks; the dialog may offer "Don't ask again"
 *   category Auto, params / runtime         allow ONLY inside the A2 envelope (envelope.js): auto +
 *                                           the post-write level watch with auto-revert; outside the
 *                                           envelope it asks, hard (an envelope override)
 *   category `code` (analysis.run_python)   asks: locked Ask in approvals.js (V1); v2 P5
 *   category Auto, other                    allow
 *
 * `settings`: {dataOptOut, liveAudio, tainted, approvals: {installation, session}, envelope: {ok, reason}}.
 */
import { modeOf, switchable, usesEnvelope } from './approvals.js';

const MEASUREMENT_FAMILIES = new Set(['modal', 'calibration']);
const READ_TIERS = new Set(['read', 'ui']);
export const LIVE_RENDER_REASON = 'this render is blocked while live audio is running: only the renders that stop the '
  + 'realtime engine, render offline and restart it are allowed (a calibration render inside the live engine is a '
  + 'backend crash risk). Judge the level from the context (peak, limiter, clipping) or ask the user to listen';
export const LIVE_RENDER_CONFIRM = 'live audio pauses for a few seconds: the engine stops, renders offline and restarts by itself';
/**
 * The renders whose backend route stops the realtime engine, renders offline and restarts it (R6, dev-947d):
 * /get_chart_test chart functions (_stop_online_engine / _restart_online_engine) and /play_keyboard offline
 * (try / finally restart). Every other render.* stays denied while live audio runs (fail closed).
 */
export const LIVE_RENDERS = new Set(['render.chart', 'render.note_playback', 'render.keyboard']);

/**
 * The hard-confirm list (v2 §9, V8): these ask every time and can never be set to Auto. Registry
 * commands carry approval_category 'hard_confirm'; the names below also pin the tools that do not
 * exist yet (audio session / test tone) and are checked by a unit test.
 */
export const HARD_CONFIRM = {
  'preset.save': 'saves over a preset file',
  'preset.promote': 'overwrites the original preset JSON',
  'preset.unload': 'unloads a library entry (unsaved edits are lost)',
  'preset.load': 'full reload: re-initialises the engine',
  'calibration.synthesis': 'calibration (minutes; rewrites the levels)',
  'calibration.acoustic': 'calibration with the microphone (rewrites hammer_mass)',
  'calibration.attack_equalize': 'calibration (minutes; rewrites hammer_mass of every key)',
  'modal.run_stage': 'modal measurement job',
  'modal.apply_to_preset': 'writes measured modes into the preset',
  'launcher.backend.start': 'process control (launcher)',
  'launcher.modal.start': 'process control (launcher)',
  'launcher.assistant.start': 'process control (launcher)',
  'modal.rig_capture': 'plays sweeps on the rig exciters and records the inputs',
  'modal.rig_sine': 'plays a sine on the rig exciters',
  'modal.rig_record': 'records the rig inputs (synthesis pauses)',
  'modal.rig_process': 'runs a measurement-pipeline step (FRF / PolyMAX / coefficients / preset build); writes files',
  'modal.set_measurements_dir': 'moves the measurements folder every rig command uses (data is not moved)',
  'preset.create': 'writes a new preset file (structure change)',
  'audio.session': 'plays on the rig outputs',
  'audio.test_tone': 'plays on the rig outputs',
};
export const HARD_CONFIRM_EXTRA = [
  'an envelope override (an Auto write outside the limits)',
  'any action in a turn that used web content',
];

export function decide({ command, tier, family, category, settings = {} }) {
  if (!command) return { action: 'deny', reason: 'not a Pianoid tool' };
  if (tier === 'excluded' || category === 'excluded') return { action: 'deny', reason: `${command} is never available to the assistant` };
  if (settings.dataOptOut && MEASUREMENT_FAMILIES.has(family)) {
    return { action: 'deny', reason: 'measurement data is opted out (pane switch "Block measurement data")' };
  }
  const liveRender = family === 'render' && settings.liveAudio && !READ_TIERS.has(tier);
  if (liveRender && !LIVE_RENDERS.has(command)) return { action: 'deny', reason: LIVE_RENDER_REASON };
  if (settings.tainted && !READ_TIERS.has(tier)) {
    return { action: 'confirm', hard: true, reason: 'this turn used web content: every action asks again' };
  }
  const planVerdict = planStep({ command, tier, category, settings });
  if (planVerdict) return planVerdict;
  if (HARD_CONFIRM[command] || category === 'hard_confirm') {
    return { action: 'confirm', hard: true, reason: HARD_CONFIRM[command] || 'on the hard-confirm list' };
  }
  if (liveRender) return { action: 'confirm', reason: LIVE_RENDER_CONFIRM };
  const mode = modeOf(category, settings.approvals);
  if (mode === 'ask') {
    return { action: 'confirm', canAuto: switchable(category), reason: `${category}: Ask` };
  }
  if (usesEnvelope(category)) {
    const env = settings.envelope;
    if (!env?.ok) return { action: 'confirm', hard: true, reason: env?.reason || 'outside the envelope' };
    return { action: 'allow', auto: true, watch: true, reason: `${category}: Auto, ${env.reason}` };
  }
  return READ_TIERS.has(tier) ? { action: 'allow', reason: tier } : { action: 'allow', auto: true, reason: `${category}: Auto` };
}

/**
 * The plan-approval row (null = no plan verdict, the rows below decide). `settings.plan` is absent unless
 * the flag is on and a grant matched, so with the flag off this returns null for every call.
 */
function planStep({ command, tier, category, settings }) {
  const plan = settings.plan;
  if (!plan?.ok || READ_TIERS.has(tier) || category === 'code') return null;
  if ((HARD_CONFIRM[command] || category === 'hard_confirm') && plan.ticked !== true) return null;
  if (usesEnvelope(category)) {
    if (!settings.envelope?.ok) return null;
    return { action: 'allow', auto: true, watch: true, plan: plan.grantId, reason: `${plan.reason}; ${settings.envelope.reason}` };
  }
  return { action: 'allow', auto: true, plan: plan.grantId, reason: plan.reason };
}

/** Is a command listed at all (the MCP server hides what can never run)? */
export function listedFor(cmd, settings = {}) {
  return decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, settings }).action !== 'deny';
}
