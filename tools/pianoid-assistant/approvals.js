/**
 * The assistant's approval RULES (dev-unif1, user request 2026-10-27: "make it uniform"). Pure.
 *
 * One model for every prompt. Each tool call maps to exactly ONE rule (policy.js `ruleFor`); a rule is
 * Ask (the pane shows the dialog: Allow once / Always allow / Deny) or Auto ("Always allow": runs without one).
 * The rule table is ONE persisted map in the service's config.json (`rules: {<rule id>: 'ask' | 'auto'}`,
 * written only by the service on a pane message); a rule not in the map has its default. Autonomous mode is a
 * preset of this table (autonomy.js). There is no other approval store and no rule that cannot be set.
 *
 * Rule kinds (the catalogue the pane lists):
 *   category   the registry `approval_category` of most commands (params, renders, code, ...);
 *   command    a command with category `per_command` (rig drives, preset writes, calibration, launcher, ...)
 *              or a risky command name (delete / unload / external filing): the rule is the command itself;
 *   variant    a risky attribute of a call: a rig drive at an unverified level, a save over a preset the
 *              assistant does not own, preset.create with overwrite.
 * `dangerous` rules (the old still-asks list) default to Ask and the dialog shows a warning, but they can be set
 * to Always allow like any other. `taint` rules (actions that can send data out or are destructive) do not
 * apply in a turn that used untrusted content (policy.js): that turn asks and says why.
 *
 * Not rules (no prompt at all): reads (`view`, always run), `excluded` tools (never run), and the automatic
 * checks (the physical gates: an invalid value is denied, a CFL break / clipping is undone; the preset backup).
 */
export const PER_COMMAND = 'per_command';

export const CATEGORIES = [
  { id: 'playback', label: 'Playback', covers: 'play notes / chords / modes / MIDI files, reset, cancel a job', default: 'auto' },
  { id: 'renders', label: 'Offline renders', covers: 'render.* (with live audio see Renders with live audio)', default: 'auto' },
  { id: 'renders_live', label: 'Renders with live audio', covers: 'render.note_playback / chart / keyboard while live audio plays: the engine stops, renders offline and restarts (live audio pauses a few seconds)', default: 'ask' },
  { id: 'params', label: 'Parameter edits', covers: 'param.set, mode / channel mutes (free; CFL and clipping undo automatically)', default: 'ask', envelope: true },
  { id: 'runtime', label: 'Volume and feedback', covers: 'runtime.set (volume, feedback slider; clipping undoes automatically)', default: 'ask', envelope: true },
  { id: 'preset_nav', label: 'Preset navigation', covers: 'switch preset, spawn a working copy, load into the library', default: 'ask' },
  { id: 'history', label: 'Undo / redo', covers: 'history.undo / history.redo', default: 'ask' },
  { id: 'layout_save', label: 'Save a named layout', covers: 'saving a named layout (command arrives with the runbook, P3)', default: 'ask' },
  { id: 'code', label: 'Analysis code', covers: 'analysis.run_python: runs analysis code in the sandbox (P5)', default: 'ask', taint: true },
  { id: 'web', label: 'Web research', covers: 'searches and fetches by the researcher (arrives in P7)', default: 'auto' },
  { id: 'bug_local', label: 'Local bug reports', covers: 'bug.report: files a report to the local collector (POST /bug_report)', default: 'ask', taint: true },
  { id: 'memory', label: 'Assistant notes', covers: 'save_note / update_note: the assistant writes its own notes (hand-off memory); the dialog shows the full text', default: 'ask', taint: true },
];

/** The risky attributes of a call (policy.js attributesOf decides when one applies). */
export const VARIANTS = [
  { id: 'rig.drive.any_level', label: 'rig drives at any level', covers: 'modal.rig_capture / modal.rig_sine with a level above -24 dBFS or not stated (e.g. a loopback marker output)' },
  { id: 'preset.save.not_own', label: 'saving over presets the assistant did not create', covers: 'preset.save to your files, files changed since the assistant wrote them, or unknown files' },
  { id: 'preset.create.overwrite', label: 'preset.create overwriting an existing preset', covers: 'preset.create with overwrite: true' },
].map((v) => ({ ...v, kind: 'variant', default: 'ask', dangerous: true, taint: true, warning: v.covers }));

/** Risky command names (named, or by the name pattern so a future command is covered without a code change). */
export const DANGEROUS_COMMANDS = {
  'preset.promote': 'overwrites the original preset JSON',
  'preset.unload': 'unloads a library entry (unsaved edits are lost)',
  'audio.exciters_config': 'changes the exciter current limits / sensor mapping (hardware protection)',
};
const DANGEROUS_RE = /(^|[._])(delete|remove|purge|erase|unload|clear_all|github|external|send|email|mail|upload|share|publish)/i;
export function dangerWhy(cmd) {
  const name = cmd?.name || '';
  if (DANGEROUS_COMMANDS[name]) return DANGEROUS_COMMANDS[name];
  if (cmd?.family === 'launcher' || name.startsWith('launcher.')) return 'process control (launcher)';
  if (DANGEROUS_RE.test(name)) return 'deletes, unloads or sends data outside Pianoid';
  return null;
}

export const MODES = ['ask', 'auto'];
const BY_CATEGORY = new Map(CATEGORIES.map((c) => [c.id, c]));
const BY_VARIANT = new Map(VARIANTS.map((v) => [v.id, v]));
/** Registry categories that are not rules: reads always run, excluded tools never run. */
export const NOT_RULES = { view: 'auto', excluded: 'deny' };

export const isCategory = (id) => BY_CATEGORY.has(id) || id === PER_COMMAND || id in NOT_RULES;
export const usesEnvelope = (id) => !!BY_CATEGORY.get(id)?.envelope;

/** Does this command get its own rule (instead of its category's)? */
export const ownRule = (cmd) => !!cmd && !(cmd.approval_category in NOT_RULES)
  && (cmd.approval_category === PER_COMMAND || !!dangerWhy(cmd));

function commandRule(cmd) {
  const why = dangerWhy(cmd);
  return {
    id: cmd.name, kind: 'command', label: cmd.name, covers: cmd.title || cmd.name, default: 'ask',
    dangerous: !!why, taint: true, ...(why ? { warning: why } : {}),
  };
}

/**
 * The definition of one rule id: a category, a variant, or a command (`commands` = the name -> command map of
 * the registry plus the service's own tools). null = no such rule.
 */
export function ruleDef(id, commands = new Map()) {
  const c = BY_CATEGORY.get(id);
  if (c) return { ...c, kind: 'category', dangerous: false, taint: !!c.taint };
  const v = BY_VARIANT.get(id);
  if (v) return v;
  const cmd = commands.get(id);
  return ownRule(cmd) ? commandRule(cmd) : null;
}

/** Every rule the pane lists, in order: categories, commands, variants. */
export function catalogue(commands = new Map()) {
  const own = [...commands.values()].filter(ownRule).sort((a, b) => a.name.localeCompare(b.name)).map(commandRule);
  return [...CATEGORIES.map((c) => ruleDef(c.id)), ...own, ...VARIANTS];
}

/** The effective mode of one rule ('ask' | 'auto'); an unknown rule asks (fail safe). */
export function modeOf(id, rules = {}, commands = new Map()) {
  const def = ruleDef(id, commands);
  if (!def) return 'ask';
  return MODES.includes(rules[id]) ? rules[id] : def.default;
}

/** One change {rule, mode} -> the new rule map (a new object; the default value is stored as a removal). */
export function applyChange(rules = {}, { rule, mode }, commands = new Map()) {
  const def = ruleDef(rule, commands);
  if (!def) throw new Error(`unknown approval rule '${rule}'`);
  if (!MODES.includes(mode)) throw new Error(`approval mode must be one of ${MODES.join(', ')}`);
  const next = { ...rules };
  if (mode === def.default) delete next[rule];
  else next[rule] = mode;
  return next;
}

/** The pane's view: one row per rule + the Ask-by-default rules now on Always allow. */
export function describe(rules = {}, commands = new Map()) {
  const rows = catalogue(commands).map((d) => ({
    id: d.id, kind: d.kind, label: d.label, covers: d.covers, default: d.default, mode: modeOf(d.id, rules, commands),
    dangerous: d.dangerous, taint: d.taint, ...(d.warning ? { warning: d.warning } : {}),
  }));
  const autoActive = rows.filter((r) => r.default === 'ask' && r.mode === 'auto').map((r) => r.id);
  return { rules: rows, autoActive };
}
