/**
 * Autonomous mode of the assistant (dev-auto1, user approval 2026-10-25). Pure.
 *
 * The user switches it on in the pane (persisted per installation in config.json `autonomous`, written only
 * by the service, until the user switches it off). While it is on, every non-excluded category AND the
 * hard-confirm list run without a confirm (policy.js autonomous row), EXCEPT the residual still-ask list
 * below, which keeps asking (hard: no "Don't ask again"). What stays in force regardless (policy.js rows
 * above / below the autonomous row, and the executor): excluded tools, the data opt-out, the live-render
 * deny, a web-tainted turn, the A2 envelope + level watch with auto-revert for params / runtime, the rig
 * drive cap (-24 dBFS: the registry schemas + the backend; re-checked here), the PreToolUse deny hook, and
 * the sandbox for analysis code. It never uses an SDK bypass permission mode.
 *
 *   residualReason(cmd, input) -> null (may run autonomously) | why it still asks
 *   isOwnWorkingPreset(path)   -> is `path` the assistant's own working preset (presets/<name>_work.json)?
 */
import { footprint, LEVEL_CAP_DBFS } from './planApproval.js';

/** Named residual commands (names that do not exist yet are pinned too). */
export const STILL_ASKS = {
  'preset.promote': 'overwrites the original preset JSON',
  'preset.unload': 'unloads a library entry (unsaved edits are lost)',
  'audio.exciters_config': 'changes the exciter current limits / sensor mapping (hardware protection)',
  'launcher.backend.start': 'process control (launcher)',
  'launcher.modal.start': 'process control (launcher)',
  'launcher.assistant.start': 'process control (launcher)',
};
const DELETE_RE = /(^|[._])(delete|remove|purge|erase|unload|clear_all)/i;
const EXTERNAL_RE = /(^|[._])(github|external|send|email|mail|upload|share|publish)/i;
const DRIVES = new Set(['modal.rig_capture', 'modal.rig_sine']);

/** The still-ask list as the pane and the model see it. */
export const STILL_ASKS_TEXT = [
  'saving over a preset that is not the assistant\'s own working copy (presets/<name>_work.json)',
  'preset.promote (overwrites the original preset)',
  'delete / unload operations',
  'audio.exciters_config (hardware protection)',
  'any external filing or sending',
  'launcher / process control',
  'preset.create with overwrite',
  `a rig drive above ${LEVEL_CAP_DBFS} dBFS or with an unknown level`,
];

/** What stays in force in Autonomous mode, as the pane shows it. */
export const SAFETY_NETS_TEXT = [
  'parameter / volume / feedback edits only inside the safety envelope, with the level watch and auto-revert',
  `rig drives capped at ${LEVEL_CAP_DBFS} dBFS`,
  'a turn that used web content asks for every action',
  '"Block measurement data" still blocks modal / calibration',
  'analysis code runs only in the sandbox',
];

/** presets/<letters, digits, . _ -> _work(.json): the assistant's own working preset (no folders, no `..`). */
export function isOwnWorkingPreset(p) {
  if (typeof p !== 'string') return false;
  const s = p.trim().replace(/\\/g, '/');
  return /^presets\/[A-Za-z0-9._-]+_work(\.json)?$/i.test(s) && !s.includes('..');
}

export function residualReason(cmd, input = {}) {
  const name = cmd?.name || '';
  if (STILL_ASKS[name]) return STILL_ASKS[name];
  if (cmd?.family === 'launcher' || name.startsWith('launcher.')) return 'process control (launcher)';
  if (DELETE_RE.test(name)) return 'a delete / unload operation';
  if (EXTERNAL_RE.test(name)) return 'external filing / sending';
  if (name === 'preset.save' && !isOwnWorkingPreset(input?.path)) {
    return `saves over ${input?.path ?? 'a preset'}, which is not the assistant's own working copy (presets/<name>_work.json)`;
  }
  if (name === 'preset.create' && input?.overwrite === true) return 'overwrites an existing preset (preset.create overwrite)';
  if (DRIVES.has(name) && input?.dry_run !== true) {
    const { levels } = footprint(cmd, input);
    if (!levels.length || levels.some((l) => typeof l !== 'number' || !Number.isFinite(l) || l > LEVEL_CAP_DBFS)) {
      return `a rig drive level above ${LEVEL_CAP_DBFS} dBFS or unknown`;
    }
  }
  return null;
}
