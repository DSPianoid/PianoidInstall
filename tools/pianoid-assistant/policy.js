/**
 * The assistant's permission policy: ONE decision function (dev-unif1, user request 2026-10-27: "make it uniform,
 * don't patch each case separately"; earlier rows: D3 / D4 2026-10-15, v2 P2, dev-28f1, dev-free1). Pure.
 *
 *   attributesOf(cmd, input, {ownPreset}) -> {driveLevel?, ownPreset?, overwrite?, why?}   the risky attributes of a call
 *   ruleFor(cmd, attrs, {liveRender})     -> the ONE rule (approvals.js) this call needs
 *   decide({command, title?, tier, family, category, attrs, settings})
 *     -> {action: 'allow' | 'ask' | 'deny', reason, rule?, auto?, watch?, plan?, taintNote?}
 *
 * Called for EVERY tool call by the service (canUseTool and the service's own tools) and by the MCP server.
 * In order (there is no other branch):
 *
 *   deny   not a Pianoid tool; an `excluded` tool; "Block measurement data" on for modal / calibration (D4);
 *          a render inside the live engine other than the stop -> render -> restart ones (R6, a crash risk);
 *          a params / runtime value the engine cannot take (the validity gate, envelope.js)
 *   allow  reads (`view` and the read / ui tiers): never a rule
 *   rule   ruleFor -> its mode in the rule table (`settings.rules`, defaults in approvals.js):
 *            Always allow -> allow (params / runtime: watched by the physical gates, the CFL undo + the clipping
 *            revert, which also apply to a write the user allowed once);
 *            else a plan grant the user approved covers it -> allow (a `command` / `variant` rule only if the
 *            user ticked that command in the plan card);
 *            else ask: the dialog offers Allow once / Always allow (this rule) / Deny.
 *   taint  in a turn that used untrusted content (`settings.tainted`), a rule with `taint` (it can send data out
 *          or is destructive) does not apply, and neither does a plan: the call asks and `taintNote` says why.
 *
 * `settings`: {dataOptOut, liveAudio, tainted, rules (the rule table), envelope: {ok, reject?, reason},
 * plan?: planApproval.js matchGrant}.
 */
import { modeOf, ownRule, ruleDef, usesEnvelope } from './approvals.js';
import { footprint, LEVEL_CAP_DBFS } from './planApproval.js';

const MEASUREMENT_FAMILIES = new Set(['modal', 'calibration']);
const READ_TIERS = new Set(['read', 'ui']);
export const LIVE_RENDER_REASON = 'this render is blocked while live audio is running: only the renders that stop the '
  + 'realtime engine, render offline and restart it are allowed (a calibration render inside the live engine is a '
  + 'backend crash risk). Judge the level from the context (peak, limiter, clipping) or ask the user to listen';
/**
 * The renders whose backend route stops the realtime engine, renders offline and restarts it (R6, dev-947d):
 * /get_chart_test chart functions and /play_keyboard offline. Every other render.* is denied while live audio runs.
 */
export const LIVE_RENDERS = new Set(['render.chart', 'render.note_playback', 'render.keyboard']);
export const TAINT_NOTE = 'this turn used untrusted content (web or a tainted note / saved output): saved rules for '
  + 'actions that send data out or are destructive do not apply in it, so it asks';
const DRIVES = new Set(['modal.rig_capture', 'modal.rig_sine']);

/** The risky attributes of one call (only what changes its rule). `ownPreset` = presetOwnership classify(). */
export function attributesOf(cmd, input = {}, { ownPreset = null } = {}) {
  const name = cmd?.name;
  if (DRIVES.has(name) && input?.dry_run !== true) {
    const { levels, outputs } = footprint(cmd, input);
    const bad = levels.findIndex((l) => typeof l !== 'number' || !Number.isFinite(l) || l > LEVEL_CAP_DBFS);
    if (!levels.length) return { driveLevel: 'unverified', why: 'no drive level stated' };
    if (bad < 0) return { driveLevel: 'ok' };
    return { driveLevel: 'unverified', why: `output ${outputs[bad]}: level ${levels[bad] ?? 'not stated'}` };
  }
  if (name === 'preset.save') {
    return ownPreset?.own === true ? { ownPreset: true }
      : { ownPreset: false, why: `${input?.path ?? 'a preset'}: ${ownPreset?.reason ?? 'ownership unknown'}` };
  }
  if (name === 'preset.create') return { overwrite: input?.overwrite === true };
  return {};
}

/** The ONE rule id a call needs. */
export function ruleFor({ command, category, family }, attrs = {}, { liveRender = false } = {}) {
  if (liveRender) return 'renders_live';
  if (attrs.driveLevel === 'unverified') return 'rig.drive.any_level';
  if (command === 'preset.save' && attrs.ownPreset === false) return 'preset.save.not_own';
  if (command === 'preset.create' && attrs.overwrite) return 'preset.create.overwrite';
  if (ownRule({ name: command, approval_category: category, family })) return command;
  return category;
}

/** The rule as the confirm dialog shows it. */
const shown = (def) => ({
  id: def.id, kind: def.kind, label: def.kind === 'command' ? `${def.id} (this command)` : def.label,
  dangerous: !!def.dangerous, ...(def.warning ? { warning: def.warning } : {}),
});

export function decide({ command, title, tier, family, category, attrs = {}, settings = {} }) {
  if (!command) return { action: 'deny', reason: 'not a Pianoid tool' };
  if (tier === 'excluded' || category === 'excluded') return { action: 'deny', reason: `${command} is never available to the assistant` };
  if (settings.dataOptOut && MEASUREMENT_FAMILIES.has(family)) {
    return { action: 'deny', reason: 'measurement data is opted out (pane switch "Block measurement data")' };
  }
  const liveRender = family === 'render' && !!settings.liveAudio && !READ_TIERS.has(tier);
  if (liveRender && !LIVE_RENDERS.has(command)) return { action: 'deny', reason: LIVE_RENDER_REASON };
  const gated = usesEnvelope(category);                     // params / runtime: the physical gates (envelope.js)
  const env = gated ? settings.envelope : null;
  if (env?.reject) return { action: 'deny', reason: env.reason };
  if (READ_TIERS.has(tier) || category === 'view') return { action: 'allow', reason: tier };

  // the rule lookup needs only this command (a command rule is derived from it; the catalogue is the pane's)
  const commands = new Map([[command, { name: command, approval_category: category, family, title }]]);
  const id = ruleFor({ command, category, family }, attrs, { liveRender });
  const def = ruleDef(id, commands) || { id, kind: 'unknown', label: id, default: 'ask', taint: true };   // unknown: asks
  const rule = shown(def);
  const blocked = !!settings.tainted && def.taint;
  const watched = (v) => (gated ? { ...v, watch: true, reason: `${v.reason}; ${env.reason}` } : v);
  const gatesOk = !gated || env?.ok === true;              // no gate verdict = not runnable without a dialog (fail closed)
  if (!blocked && gatesOk && modeOf(id, settings.rules, commands) === 'auto') {
    return watched({ action: 'allow', auto: true, rule, reason: `${rule.label}: Always allow` });
  }
  const plan = settings.plan;
  const planCovers = plan?.ok && (def.kind === 'category' || plan.ticked === true);
  if (!blocked && gatesOk && planCovers) return watched({ action: 'allow', auto: true, rule, plan: plan.grantId, reason: plan.reason });
  const why = [attrs.why, def.warning || def.covers || def.label, gatesOk ? null : (env?.reason || 'the physical gates could not be checked')]
    .filter(Boolean).join('; ');
  return { action: 'ask', rule, reason: why, ...(blocked ? { taintNote: TAINT_NOTE } : {}) };
}

/** Is a command listed at all (the MCP server hides what can never run)? */
export function listedFor(cmd, settings = {}) {
  return decide({ command: cmd.name, title: cmd.title, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, settings }).action !== 'deny';
}

