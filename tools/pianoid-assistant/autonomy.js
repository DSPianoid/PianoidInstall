/**
 * Autonomous mode = a PRESET of the rule table (dev-unif1; the mode itself: dev-auto1, user approval 2026-10-25). Pure.
 *
 * Switching it on (pane only, WS `settings {autonomous: true}`, after the pane's dialog) sets every rule that is
 * not `dangerous` to Always allow and remembers what each one was before (config.json `autonomous: {on,
 * previous}`); switching it off puts back every rule the preset changed that is still on Always allow. The
 * dangerous rules (approvals.js: the still-asks list) keep their own setting: the user can set them to Always allow
 * in the Permissions list or from their dialog like any other rule. Nothing else changes: the policy has no
 * Autonomous branch (policy.js), and the automatic checks stay in force (SAFETY_NETS_TEXT).
 *
 * Also the config migration of the pre-dev-unif1 settings (`approvals` + `autonomous: true`).
 */
import { catalogue, CATEGORIES, MODES } from './approvals.js';
import { LEVEL_CAP_DBFS } from './planApproval.js';

/** The rule ids the preset sets to Always allow (every rule that is not dangerous). */
export const presetRules = (commands) => catalogue(commands).filter((r) => !r.dangerous).map((r) => r.id);

/** The rules that keep asking after the preset (as the pane and the model see them). */
export const stillAsks = (commands) => catalogue(commands).filter((r) => r.dangerous)
  .map((r) => `${r.label}: ${r.warning || r.covers}`);

/** What stays in force whatever the rules say, as the pane shows it. */
export const SAFETY_NETS_TEXT = [
  'string edits are undone at once when they break the CFL (Courant) stability limit',
  'any parameter / volume / feedback edit is reverted automatically when the output clips',
  `rig drive levels capped at ${LEVEL_CAP_DBFS} dBFS by the registry and the backend`,
  'a preset file is backed up before an automatic save over it',
  'in a turn that used untrusted content, saved rules for actions that send data out or are destructive do not apply',
  '"Block measurement data" still blocks modal / calibration',
  'analysis code runs only in the sandbox',
];

/**
 * {rules, autonomous} -> the new {rules, autonomous} for on / off. On: every preset rule -> 'auto', its
 * previous value kept (null = it had its default). Off: each preset rule still on 'auto' gets its previous value.
 */
export function applyAutonomous({ rules = {}, autonomous }, on, commands) {
  const cur = autonomous?.on ? autonomous : { on: false, previous: {} };
  if (on === cur.on) return { rules, autonomous: cur };
  const next = { ...rules };
  if (on) {
    const previous = {};
    for (const id of presetRules(commands)) {
      previous[id] = MODES.includes(rules[id]) ? rules[id] : null;
      next[id] = 'auto';
    }
    return { rules: next, autonomous: { on: true, previous } };
  }
  for (const [id, was] of Object.entries(cur.previous || {})) {
    if (next[id] !== 'auto') continue;              // the user changed it while on: theirs
    if (was === null) delete next[id];
    else next[id] = was;
  }
  return { rules: next, autonomous: { on: false, previous: {} } };
}

/**
 * Migrate a pre-dev-unif1 config.json: `approvals` (per-category Ask / Auto for this installation) becomes
 * `rules`; `autonomous: true` becomes the preset applied to the table. -> {config, changed}.
 */
export function migrateConfig(config, commands) {
  if (config.rulesVersion === 1) return { config, changed: false };
  const rules = { ...(config.rules || {}) };
  const known = new Set(CATEGORIES.map((c) => c.id));
  for (const [id, mode] of Object.entries(config.approvals || {})) {
    if (known.has(id) && MODES.includes(mode)) rules[id] = mode;
  }
  const wasOn = config.autonomous === true || config.autonomous?.on === true;
  const { approvals, ...rest } = config;
  const applied = applyAutonomous({ rules, autonomous: { on: false, previous: {} } }, wasOn, commands);
  return { config: { ...rest, rulesVersion: 1, ...applied }, changed: true };
}
