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
 *   render.* while live audio runs          DENY (R6: an offline render stops realtime playback and
 *                                           runs inside the live engine - backend crash risk)
 *   a web-tainted turn (P7)                 every non-read asks, hard (never Auto)
 *   the hard-confirm list                   asks, hard: never Auto, no "don't ask again"
 *   category Ask (approvals.js)             asks; the dialog may offer "Don't ask again"
 *   category Auto, params / runtime         allow ONLY inside the A2 envelope (envelope.js): auto +
 *                                           the post-write level watch with auto-revert; outside the
 *                                           envelope it asks, hard (an envelope override)
 *   category Auto, other                    allow
 *
 * `settings`: {dataOptOut, liveAudio, tainted, approvals: {installation, session}, envelope: {ok, reason}}.
 */
import { modeOf, switchable, usesEnvelope } from './approvals.js';

const MEASUREMENT_FAMILIES = new Set(['modal', 'calibration']);
const READ_TIERS = new Set(['read', 'ui']);
export const LIVE_RENDER_REASON = 'offline renders are blocked while live audio is running: a render stops realtime '
  + 'playback and runs inside the live engine (backend crash risk). Judge the level from the context (peak, '
  + 'limiter, clipping) or ask the user to listen';

/**
 * The hard-confirm list (v2 §9, V8): these ask every time and can never be set to Auto. Registry
 * commands carry approval_category 'hard_confirm'; the names below also pin the tools that do not
 * exist yet (audio session / test tone, GitHub filing) and are checked by a unit test.
 */
export const HARD_CONFIRM = {
  'preset.save': 'saves over a preset file',
  'preset.promote': 'overwrites the original preset JSON',
  'preset.unload': 'unloads a library entry (unsaved edits are lost)',
  'preset.load': 'full reload: re-initialises the engine',
  'calibration.synthesis': 'calibration (minutes; rewrites the levels)',
  'calibration.acoustic': 'calibration with the microphone (rewrites hammer_mass)',
  'modal.run_stage': 'modal measurement job',
  'modal.apply_to_preset': 'writes measured modes into the preset',
  'launcher.backend.start': 'process control (launcher)',
  'launcher.modal.start': 'process control (launcher)',
  'launcher.assistant.start': 'process control (launcher)',
  'audio.session': 'plays on the rig outputs',
  'audio.test_tone': 'plays on the rig outputs',
  'bug.file_github': 'files an issue on GitHub',
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
  if (family === 'render' && settings.liveAudio) return { action: 'deny', reason: LIVE_RENDER_REASON };
  if (settings.tainted && !READ_TIERS.has(tier)) {
    return { action: 'confirm', hard: true, reason: 'this turn used web content: every action asks again' };
  }
  if (HARD_CONFIRM[command] || category === 'hard_confirm') {
    return { action: 'confirm', hard: true, reason: HARD_CONFIRM[command] || 'on the hard-confirm list' };
  }
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

/** Is a command listed at all (the MCP server hides what can never run)? */
export function listedFor(cmd, settings = {}) {
  return decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, settings }).action !== 'deny';
}
