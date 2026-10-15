/**
 * The assistant's permission policy (user decisions D3 / D4 / D5, 2026-10-15). Pure.
 *
 * decide({command, tier, role, settings}) -> {action: 'allow' | 'confirm' | 'deny', reason}
 * It is called for EVERY tool call from the service's canUseTool hook (and the role part again by
 * the MCP server) — never left to the prompt.
 *
 *   read / ui / act (incl. renders, D3)     owner allow     collaborator allow
 *   write (param.set, runtime.set, ...)     confirm until the A2 envelope + auto-revert land
 *   destructive (save, promote, load, unload, calibration, modal jobs)
 *                                           owner confirm   collaborator DENY (D5)
 *   launcher process control                owner confirm   collaborator DENY
 *   data opt-out ON (D4, default off)       modal / calibration tools DENY
 *   excluded                                never listed; deny if asked anyway
 */
export const ROLES = ['owner', 'collaborator'];

const MEASUREMENT_FAMILIES = new Set(['modal', 'calibration']);
const READ_ONLY_LAUNCHER = new Set(['launcher.status', 'launcher.assistant.status']);

export function decide({ command, tier, family, role = 'owner', settings = {} }) {
  if (!ROLES.includes(role)) return { action: 'deny', reason: `unknown role '${role}'` };
  if (!command) return { action: 'deny', reason: 'not a Pianoid tool' };
  if (tier === 'excluded') return { action: 'deny', reason: `${command} is never available to the assistant` };
  if (settings.dataOptOut && MEASUREMENT_FAMILIES.has(family)) {
    return { action: 'deny', reason: 'measurement data is opted out (pane switch "Block measurement data")' };
  }
  if (family === 'launcher' && !READ_ONLY_LAUNCHER.has(command)) {
    return role === 'owner'
      ? { action: 'confirm', reason: 'process control (launcher)' }
      : { action: 'deny', reason: 'process control is owner-only' };
  }
  switch (tier) {
    case 'read':
    case 'ui':
    case 'act':
      return { action: 'allow', reason: tier };
    case 'write':
      return { action: 'confirm', reason: 'parameter / preset write (direct writes within the envelope arrive with A2)' };
    case 'destructive':
      return role === 'owner'
        ? { action: 'confirm', reason: 'destructive or irreversible' }
        : { action: 'deny', reason: 'collaborators cannot run destructive or irreversible actions' };
    default:
      return { action: 'deny', reason: `unknown tier '${tier}'` };
  }
}

/** Is a command listed for a role at all (the MCP server hides what a role can never run)? */
export function listedFor(cmd, role = 'owner', settings = {}) {
  return decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, role, settings }).action !== 'deny';
}
