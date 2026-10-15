/**
 * The assistant's permission policy (user decisions D3 / D4, 2026-10-15). Pure.
 *
 * One installation = one user (D5: no user management): the owner-level rules below apply.
 *
 * decide({command, tier, family, settings}) -> {action: 'allow' | 'confirm' | 'deny', reason}
 * It is called for EVERY tool call from the service's canUseTool hook (and again by the MCP
 * server for deny) — never left to the prompt.
 *
 *   read / ui / act (incl. renders, D3)     allow
 *   write (param.set, runtime.set, ...)     confirm until the A2 envelope + auto-revert land
 *   destructive (save, promote, load, unload, calibration, modal jobs)   confirm
 *   launcher process control                confirm
 *   data opt-out ON (D4, default off)       modal / calibration tools DENY
 *   excluded                                never listed; deny if asked anyway
 */
const MEASUREMENT_FAMILIES = new Set(['modal', 'calibration']);
const READ_ONLY_LAUNCHER = new Set(['launcher.status', 'launcher.assistant.status']);

export function decide({ command, tier, family, settings = {} }) {
  if (!command) return { action: 'deny', reason: 'not a Pianoid tool' };
  if (tier === 'excluded') return { action: 'deny', reason: `${command} is never available to the assistant` };
  if (settings.dataOptOut && MEASUREMENT_FAMILIES.has(family)) {
    return { action: 'deny', reason: 'measurement data is opted out (pane switch "Block measurement data")' };
  }
  if (family === 'launcher' && !READ_ONLY_LAUNCHER.has(command)) {
    return { action: 'confirm', reason: 'process control (launcher)' };
  }
  switch (tier) {
    case 'read':
    case 'ui':
    case 'act':
      return { action: 'allow', reason: tier };
    case 'write':
      return { action: 'confirm', reason: 'parameter / preset write (direct writes within the envelope arrive with A2)' };
    case 'destructive':
      return { action: 'confirm', reason: 'destructive or irreversible' };
    default:
      return { action: 'deny', reason: `unknown tier '${tier}'` };
  }
}

/** Is a command listed at all (the MCP server hides what can never run)? */
export function listedFor(cmd, settings = {}) {
  return decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, settings }).action !== 'deny';
}
