/**
 * SESSION PROFILES — the configurable shape of a hosted session (Phase 3a).
 *
 * A profile bundles everything that differs between "show off the permission
 * router with a safe demo persona" and "host the REAL orchestrator with broad
 * tool access + a safety floor": the permission policy (allow-list / fallback /
 * the destructive-op route predicate), the system-prompt strategy, whether to
 * load project settings + skills, whether agent-teams are enabled, the MCP server
 * set, and the channel-out de-dup behavior.
 *
 * Two built-ins:
 *  - 'demo'         — narrow allow-list, route-MOST (the FC-1 showcase). No reply
 *                     tool → assistant text is auto-sent to the channel.
 *  - 'orchestrator' — broad allow-list mirroring .claude/settings.local.json, the
 *                     project context loaded, agent-teams on, MCP servers wired,
 *                     a SAFETY FLOOR that still routes genuinely destructive ops.
 *                     Has the reply tool → assistant text is NOT auto-sent (the
 *                     orchestrator messages deliberately via the reply tool).
 *
 * Pure config + pure predicates → fully unit-testable (no SDK / no subprocess).
 *
 * Traces: proposal PART E Phase 3 (the additive orchestrator-hosting subset) +
 * the team-lead's Phase-3a decisions (channel BOTH+de-dup, the safety-floor set).
 */

import type { PermissionPolicy } from './permission-router.js';

export type ProfileName = 'demo' | 'orchestrator';

export interface SessionProfile {
  name: ProfileName;
  /** Permission policy (allow-list + the safety-floor route predicate). */
  policy: PermissionPolicy;
  /**
   * How the session adopts its role on the first turn:
   *  - 'orchestrator-skill' → inject "/orchestrator" as the synthetic first turn
   *    (the skill is loaded via settingSources; confirmed listed by the probe).
   *  - 'none' → no role injection (the demo persona is the systemPrompt append).
   */
  roleBootstrap: 'orchestrator-skill' | 'none';
  /** Append text for the preset 'claude_code' system prompt (the supervisor preamble). */
  systemPromptAppend: string;
  /** settingSources to load (project skills + CLAUDE.md + settings). [] = none. */
  settingSources: ('user' | 'project' | 'local')[];
  /** Enable agent-teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) for sub-agent spawning. */
  agentTeams: boolean;
  /** Wire the project's MCP servers (from ~/.claude.json, minus telegram). */
  wireProjectMcp: boolean;
  /**
   * Channel-out de-dup. If true, the supervisor does NOT auto-send assistant text
   * to the channel (the session messages the user deliberately via the reply
   * tool, so auto-out would double-send). If false (demo), assistant text IS
   * auto-sent (no reply tool present).
   */
  suppressAutoOutbound: boolean;
}

/**
 * The DESTRUCTIVE-OP predicate for the orchestrator profile's safety floor.
 * Returns true (→ route to the user) for genuinely dangerous operations even
 * though the broad allow-list would otherwise auto-allow them. The set is the
 * team-lead's Phase-3a decision; tune via {@link makeOrchestratorPolicy} args.
 *
 * Covers:
 *  - shell (Bash/PowerShell) commands matching: rm -rf, system-PID kill
 *    (taskkill /PID, Stop-Process -Id without an image filter), `git push*`,
 *    `git reset --hard`, disk-format (mkfs/format/diskpart).
 *  - outward THIRD-PARTY-SEND MCP tools: email send, whatsapp send_* (the
 *    orchestrator's own "confirm before third-party send" rule).
 */
export function isDestructiveOp(toolName: string, input: Record<string, unknown>): boolean {
  const name = toolName.toLowerCase();

  // Outward third-party sends (route regardless of input).
  if (
    /(^|_)send(_|$)/.test(name) || // mcp__*__send_message / send_audio_message / etc.
    name.includes('send_email') ||
    name.includes('send_gmail') ||
    (name.startsWith('mcp__hostinger-email__') && name.includes('send')) ||
    (name.startsWith('mcp__whatsapp') && name.includes('send')) ||
    (name.startsWith('mcp__google-workspace__') && (name.includes('send') || name.includes('draft')))
  ) {
    return true;
  }

  // Shell commands — inspect the command string for destructive patterns.
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String((input['command'] ?? input['cmd'] ?? '') as string);
    return isDestructiveShellCommand(cmd);
  }

  return false;
}

/** True if a shell command string is a genuinely destructive op (the safety floor). */
export function isDestructiveShellCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+-rf|\brm\s+-fr/.test(c) || // rm -rf / -fr / -Rf …
    /\bgit\s+push\b/.test(c) || // any git push (project gates pushes)
    /\bgit\s+reset\s+--hard\b/.test(c) ||
    /\bgit\s+clean\s+-[a-z]*f/.test(c) || // git clean -fd
    /\b(taskkill)\b[^|]*\/pid\b/.test(c) || // taskkill /PID <n> (system PID)
    /\bstop-process\b[^|]*-id\b/.test(c) || // Stop-Process -Id <n>
    /\b(mkfs|format|diskpart|fdisk)\b/.test(c) || // disk format
    /\b(shutdown|reboot)\b/.test(c)
  );
}

/** The DEMO profile (Phase-2 behavior): narrow allow-list, route-most, auto-out. */
export function makeDemoProfile(): SessionProfile {
  return {
    name: 'demo',
    policy: {
      allow: ['Read', 'Glob', 'Grep', 'mcp__supervisor_channel__*'],
      fallback: 'route',
    },
    roleBootstrap: 'none',
    systemPromptAppend: '', // the demo persona is supplied separately (SUPERVISOR_SYSTEM_PROMPT)
    settingSources: [], // demo doesn't need project skills
    agentTeams: false,
    wireProjectMcp: false,
    suppressAutoOutbound: false, // no reply tool → auto-send assistant text
  };
}

/**
 * The ORCHESTRATOR profile: broad allow-list mirroring .claude/settings.local.json
 * + the safety-floor route predicate, project context loaded, teams on, MCP wired,
 * reply-tool-driven channel (auto-out suppressed).
 *
 * @param routeWhen override the destructive-op predicate (default {@link isDestructiveOp}).
 */
export function makeOrchestratorProfile(
  routeWhen: (toolName: string, input: Record<string, unknown>) => boolean = isDestructiveOp,
): SessionProfile {
  return {
    name: 'orchestrator',
    policy: makeOrchestratorPolicy(routeWhen),
    roleBootstrap: 'orchestrator-skill',
    systemPromptAppend: ORCHESTRATOR_PREAMBLE,
    settingSources: ['user', 'project', 'local'],
    agentTeams: true,
    wireProjectMcp: true,
    suppressAutoOutbound: true, // reply tool is the deliberate channel-out (de-dup)
  };
}

/** The broad orchestrator permission policy (mirrors .claude/settings.local.json + the floor). */
export function makeOrchestratorPolicy(
  routeWhen: (toolName: string, input: Record<string, unknown>) => boolean = isDestructiveOp,
): PermissionPolicy {
  return {
    allow: [
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash',
      'PowerShell',
      'Agent',
      'Skill',
      'SendMessage',
      'Monitor',
      'ToolSearch',
      'Task',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'TaskGet',
      'TaskStop',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'mcp__*', // all wired MCP servers (telegram excluded at the source + via disallow)
    ],
    // The telegram plugin can never reach the session (the supervisor owns the
    // channel); deny-rules win over everything in the SDK permission order.
    deny: ['mcp__plugin_telegram_telegram__*', 'mcp__telegram__*'],
    fallback: 'route', // an UNlisted tool still routes (keeps canUseTool reachable)
    routeWhen, // the safety floor: destructive ops route even when allow-listed
  };
}

/** The supervisor preamble appended to the preset system prompt (orchestrator profile). */
export const ORCHESTRATOR_PREAMBLE = `
--- SUPERVISOR HOSTING CONTEXT (read carefully) ---
You are running as a managed subprocess of the Pianoid Supervisor, reached over a
channel (currently a dedicated test Telegram bot). The supervisor owns the channel
— the production Telegram plugin is NOT available to you.

To message the user:
- Simply writing your reply as normal assistant text reaches the user (the
  supervisor forwards it), OR
- call the tool mcp__supervisor_channel__reply({ text }) to send a deliberate
  message. Prefer the reply tool for status updates, questions, and summaries.
- Do NOT attempt to use mcp__plugin_telegram_telegram__* or any telegram plugin
  tool — it does not exist here; the reply tool replaces it.

Your tool use is governed by the supervisor's permission router: routine tools run
freely, but genuinely destructive operations (rm -rf, killing processes by system
PID, git push / git reset --hard, disk formatting, and outward third-party sends
like email/WhatsApp) are routed to the user for approval over the channel and will
BLOCK until they reply allow/deny. This is expected — narrate what you're doing.
--- END SUPERVISOR HOSTING CONTEXT ---
`.trim();

/** Resolve a profile by name (default 'demo' — the safe Phase-2 behavior). */
export function resolveProfile(name: ProfileName | undefined): SessionProfile {
  return name === 'orchestrator' ? makeOrchestratorProfile() : makeDemoProfile();
}
