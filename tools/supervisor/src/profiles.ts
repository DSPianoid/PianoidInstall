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
  /**
   * The DEFAULT I/O driver for this profile (an explicit --driver / SUPERVISOR_DRIVER
   * still overrides). The orchestrator profile defaults to 'cli-stream' (`claude -p`
   * stream-json) because ONLY the CLI exposes agent-teams (SendMessage/Monitor/Task*)
   * — the orchestrator skill REQUIRES them; the SDK query() driver does not surface
   * them (measured 2026-06-18). Demo defaults to 'sdk' (lighter, no teams needed).
   */
  defaultDriver: 'sdk' | 'cli-stream';
  /**
   * Model to pin for this profile (passed to the driver as --model / SDK model). The
   * orchestrator pins Opus 4.8 with the 1M context window. Undefined → the driver's
   * own default (which differs by backend: claude -p → opus-4-8[1m], SDK → older).
   */
  model?: string;
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
    defaultDriver: 'sdk', // demo is lightweight; no agent-teams needed
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
    // ★ CONTAINMENT (token-hijack fix, 2026-06-18): NO 'user' setting source. Claude
    // Code with --setting-sources user LOADS the user's enabled plugins
    // (~/.claude/settings.json enabledPlugins → the PROD telegram plugin), and that
    // plugin's server SIGTERM-kills the user's real orchestrator + SEIZES the single
    // getUpdates token (its own takeover logic) — hijacking the user's prod Telegram
    // inbound every launch. --disallowed-tools only stops the AGENT calling telegram,
    // NOT Claude Code STARTING the plugin server. enabledPlugins is USER-scope ONLY
    // (absent from project/.claude/settings.json + .claude/settings.local.json), so
    // dropping 'user' DETERMINISTICALLY prevents the plugin from ever loading. The
    // generic ~/.claude/CLAUDE.md methodology is folded into the system-prompt append
    // instead (index.ts reads + appends it), so the role survives. project+local still
    // load the project CLAUDE.md + the /orchestrator skill + settings.local.json.
    settingSources: ['project', 'local'],
    agentTeams: true,
    wireProjectMcp: true,
    // DEFAULT driver = cli-stream (`claude -p`): the ONLY backend that exposes
    // agent-teams (SendMessage/Monitor/Task*), which the orchestrator skill REQUIRES.
    defaultDriver: 'cli-stream',
    // Pin Opus 4.8 with the 1M context window (long-running orchestrator → fewer
    // compactions). claude -p accepts this exact variant id (measured, subscription).
    model: 'claude-opus-4-8[1m]',
    // The in-process channel reply tool can NOT be passed to a `claude -p` CHILD
    // process (it's a createSdkMcpServer instance, in-process only). So under the
    // cli-stream driver the orchestrator reaches the user via auto-forwarded
    // assistant text (+ tool_result/error forwarding) rather than a reply tool →
    // auto-out must stay ON. index.ts sets this per-driver: false for cli-stream
    // (auto-forward), true only if a driver that CAN host the in-process reply tool
    // (the SDK driver) is selected. Default here = false (the cli-stream default).
    suppressAutoOutbound: false,
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
      // MCP servers — per-server prefixes. The `claude -p` CLI REJECTS a bare `mcp__*`
      // in an ALLOW rule ("must name the scope it widens"; globs allowed only AFTER a
      // literal mcp__<server>__ prefix) — so we enumerate the wired read/compute servers.
      // The SEND tools inside them are still DENIED below (deny wins); telegram + whatsapp
      // are excluded at the MCP-config source AND denied. (The SDK driver tolerated
      // `mcp__*`; the CLI needs these explicit forms.)
      'mcp__hostinger-email__*',
      'mcp__context7__*',
      'mcp__chrome-devtools__*',
      'mcp__google-workspace__*',
      'mcp__deepseek-codegen__*',
      'mcp__supervisor_channel__*', // the in-process reply tool (SDK-driver path)
    ],
    // OUTWARD-TO-THIRD-PARTY channels can never reach the session (containment): the
    // telegram plugin + whatsapp servers are excluded at the MCP-config source AND
    // denied here; the email SEND tools are denied (email read stays available).
    // deny-rules win over everything in the SDK permission order; in PTY mode these
    // names also feed the spawn's --disallowed-tools seal.
    deny: [
      'mcp__plugin_telegram_telegram__*',
      'mcp__telegram__*',
      'mcp__whatsapp__*',
      'mcp__whatsapp-work__*',
      'mcp__hostinger-email__send_email',
      'mcp__hostinger-email__reply_to_email',
      'mcp__google-workspace__send_gmail_message',
    ],
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
- Simply WRITE YOUR REPLY as normal assistant text — the supervisor forwards it to
  the user's channel. That is the ONLY way to reach the user here. Write your status
  updates, questions, and summaries as ordinary replies.
- Do NOT attempt to use mcp__plugin_telegram_telegram__* or any telegram plugin tool
  — it is NOT available in this sealed session, and must never be used (it would
  reach a PRODUCTION channel). Just write your reply as text.

Your tool use is governed by the supervisor's permission router: routine tools run
freely, but genuinely destructive operations (rm -rf, killing processes by system
PID, git push / git reset --hard, disk formatting, and outward third-party sends
like email/WhatsApp) are routed to the user for approval over the channel and will
BLOCK until they reply allow/deny. This is expected — narrate what you're doing.

CHANNEL SELF-CHECK & REPAIR (you own this): the supervisor exposes a LOOPBACK control
panel — base URL given below as SUPERVISOR_PANEL_URL (curl it via Bash/PowerShell). You
have FULL channel access:
- READ:  GET <panel>/api/channel/state  (adapters, recent delivery results, sender PID),
         GET <panel>/api/capture  (raw inbound+outbound+delivery events),
         GET <panel>/api/health,  GET <panel>/api/session.
- REPAIR (use at your discretion + coordinate with the user):
    POST <panel>/api/channel/reconnect — re-establish the transport / re-acquire the poller
      (on reconnect the adapter REPLAYS any un-acked inbound, so pending inbound is re-delivered).
    POST <panel>/api/channel/flush — ⚠️ DROPS all un-acked INBOUND messages from the durable
      inbox queue (NOT an outbound backlog — there is none). Only use to clear a WEDGED inbound
      replay (e.g. a poison message); it discards real pending user messages, so use sparingly.
    POST <panel>/api/channel/kill-stale-sender — reconnect to re-acquire the single poller +
      report the current sender PID (kill any DIFFERENT stale sender process yourself via Bash).
When the user says the channel is broken / messages aren't arriving — or you receive a
"[SUPERVISOR /channel-check]" turn — inspect the state, tell the user what you find, and
repair as appropriate.

DELIVERY STATUS: if one of YOUR replies fails to reach the user, the supervisor injects a
"[SUPERVISOR delivery-status]" note telling you it did NOT land. Treat that seriously:
check the channel state and resend.

LIVENESS: the supervisor may inject a "[SUPERVISOR ping]" turn. Answer it promptly with a
short line. This exchange is INTERNAL — neither the ping nor your reply is shown to the
user. If you don't answer in time while idle, the supervisor restarts you.

SELF-RESTART (use when your context is bloated/corrupt and a fresh start would help): POST
<panel>/api/lifecycle/restart-request { "reason": "...", "handoffNote": "..." }. The supervisor
CONFIRMS with the user, then (if approved) tears you down + brings up a FRESH session (context
reset; the Telegram conversation is preserved). It returns "queued" immediately — the restart
is OUT-OF-BAND, so do NOT assume it happens synchronously; finish your current thought. The
optional handoffNote is injected into your fresh session's first turn so you can resume the
thread. Don't spam it — repeated requests are rate-limited and surfaced to the user as a loop.

IMPORTANT — you are running INSIDE the supervisor's own development repository
(tools/supervisor and its parent). There may be an ACTIVE /dev session (its own
log + WORK_IN_PROGRESS entry + file locks) building the very supervisor that hosts
you. Do NOT recover, archive, close out, or modify any dev session log, WIP entry,
or lock that you did not create, and do NOT edit files under tools/supervisor —
that is another agent's live work. If the user asks you to act on such a session,
explain this hosting context and ask them to confirm before touching anything.
--- END SUPERVISOR HOSTING CONTEXT ---
`.trim();

/** Resolve a profile by name (default 'demo' — the safe Phase-2 behavior). */
export function resolveProfile(name: ProfileName | undefined): SessionProfile {
  return name === 'orchestrator' ? makeOrchestratorProfile() : makeDemoProfile();
}
