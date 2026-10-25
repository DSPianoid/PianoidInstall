/**
 * Per-category Ask / Auto approvals of the assistant (v2 proposal §9, user decision V7). Pure.
 *
 * Every registry command carries an `approval_category` (schemas/commands); the v2 tools to come
 * (analysis code, web research, bug filing, named layouts) get theirs when they land. A category is
 * Ask (a confirm dialog in the pane) or Auto (runs without one). Auto for `params` / `runtime` is
 * the A2 envelope (parent proposal §4.3, D3): only writes inside the envelope run directly, and they
 * are level-watched with auto-revert; outside it the policy asks anyway (policy.js, envelope.js).
 *
 * Scopes: the per-installation default lives in the service's config.json (`approvals`, written
 * only by the service); a session override (the confirm dialog's "Don't ask again", which defaults
 * to this session) lives in memory and ends with the service. Effective = session ?? installation
 * ?? default. The browser's localStorage is never used.
 *
 * Fixed categories cannot be switched: `view` (always Auto), `hard_confirm` (always asks: the
 * hard-confirm list, see HARD_CONFIRM in policy.js) and `excluded` (never runs). `code`
 * (analysis.run_python) is Ask by default and switchable to Auto (per session or installation):
 * decision V1 / V8, unlocked by dev-auto1 2026-10-25 after the SAFE sandbox escape suite passed
 * (spike doc §10, dev-11f8 2026-10-17). A web-tainted turn still asks, hard, whatever the mode
 * (policy.js), and every run stays inside the AppContainer sandbox (analysis/runPython.js).
 * `memory` (dev-mem1): the assistant's note writes (save_note / update_note, service/memory.js), Ask by default;
 * the note reads and the saved-output reads run under `view`.
 */
export const CATEGORIES = [
  { id: 'view', label: 'View and reads', covers: 'UI commands (panes, selection, zoom) and every read', default: 'auto', locked: 'reads and view changes always run' },
  { id: 'playback', label: 'Playback', covers: 'play notes / chords / modes / MIDI files, reset, cancel a job', default: 'auto' },
  { id: 'renders', label: 'Offline renders', covers: 'render.* (with live audio see Renders with live audio)', default: 'auto' },
  { id: 'renders_live', label: 'Renders with live audio', covers: 'render.note_playback / chart / keyboard while live audio plays: the engine stops, renders offline and restarts (live audio pauses a few seconds)', default: 'ask' },
  { id: 'params', label: 'Parameter edits', covers: 'param.set, mode / channel mutes', default: 'ask', envelope: true },
  { id: 'runtime', label: 'Volume and feedback', covers: 'runtime.set (volume, feedback slider)', default: 'ask', envelope: true },
  { id: 'preset_nav', label: 'Preset navigation', covers: 'switch preset, spawn a working copy, load into the library', default: 'ask' },
  { id: 'history', label: 'Undo / redo', covers: 'history.undo / history.redo', default: 'ask' },
  { id: 'layout_save', label: 'Save a named layout', covers: 'saving a named layout (command arrives with the runbook, P3)', default: 'ask' },
  { id: 'code', label: 'Analysis code', covers: 'analysis.run_python: runs analysis code in the sandbox (P5)', default: 'ask' },
  { id: 'web', label: 'Web research', covers: 'searches and fetches by the researcher (arrives in P7)', default: 'auto' },
  { id: 'bug_local', label: 'Local bug reports', covers: 'bug.report: files a report to the local collector (POST /bug_report)', default: 'ask' },
  { id: 'memory', label: 'Assistant notes', covers: 'save_note / update_note: the assistant writes its own notes (hand-off memory, dev-mem1); the dialog shows the full text', default: 'ask' },
];

/** Categories that are never switchable and are not shown as rows (they have their own section). */
export const FIXED = {
  hard_confirm: { mode: 'ask', reason: 'on the hard-confirm list: always asks' },
  excluded: { mode: 'deny', reason: 'never available to the assistant' },
};

export const MODES = ['ask', 'auto'];
export const SCOPES = ['session', 'installation'];
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const isCategory = (id) => BY_ID.has(id) || id in FIXED;
export const usesEnvelope = (id) => !!BY_ID.get(id)?.envelope;

/** The effective mode of one category ('ask' | 'auto' | 'deny'). */
export function modeOf(id, { installation = {}, session = {} } = {}) {
  if (id in FIXED) return FIXED[id].mode;
  const c = BY_ID.get(id);
  if (!c) return 'ask';                                  // unknown category: fail safe
  if (c.locked) return c.default;
  const m = session[id] ?? installation[id] ?? c.default;
  return MODES.includes(m) ? m : c.default;
}

/** Can a category be switched (offered in the popover and by "Don't ask again")? */
export const switchable = (id) => BY_ID.has(id) && !BY_ID.get(id).locked;

/**
 * Apply one change: {category, mode, scope} -> the new {installation, session} maps (new objects).
 * An installation change also drops the category's session override (the newer, deliberate choice wins).
 * Throws on a locked / unknown category, a bad mode or scope (the service answers with an error).
 */
export function applyChange({ installation = {}, session = {} }, { category, mode, scope = 'session' }) {
  if (!switchable(category)) throw new Error(`approval category '${category}' cannot be changed`);
  if (!MODES.includes(mode)) throw new Error(`approval mode must be one of ${MODES.join(', ')}`);
  if (!SCOPES.includes(scope)) throw new Error(`approval scope must be one of ${SCOPES.join(', ')}`);
  const next = { installation: { ...installation }, session: { ...session } };
  if (scope === 'installation') {
    next.installation[category] = mode;
    delete next.session[category];
  } else {
    next.session[category] = mode;
  }
  return next;
}

/** The pane's view of the approvals: one row per category + whether any Ask-default category is Auto. */
export function describe(state, hardConfirm = []) {
  const rows = CATEGORIES.map((c) => {
    const mode = modeOf(c.id, state);
    const scope = state.session?.[c.id] ? 'session' : state.installation?.[c.id] ? 'installation' : 'default';
    return {
      id: c.id, label: c.label, covers: c.covers, mode, default: c.default, scope: c.locked ? 'fixed' : scope,
      locked: c.locked || null, envelope: !!c.envelope,
    };
  });
  const autoActive = rows.filter((r) => r.default === 'ask' && r.mode === 'auto').map((r) => r.id);
  return { categories: rows, autoActive, hardConfirm };
}
