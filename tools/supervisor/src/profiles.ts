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
    /\b(shutdown|reboot)\b/.test(c) ||
    isSupervisorRelaunchCommand(c) // PARENT/dist supervisor restart — tears down the live host (this session)
  );
}

/**
 * True if a (lower-cased) shell command is a SUPERVISOR PARENT-RESTART / relaunch — the
 * orchestrator cycling its OWN host process. This is the most destructive op a hosted
 * orchestrator can run: it TEARS DOWN the live supervisor that hosts this very session
 * (and a fresh one boots), so it MUST be confirmation-gated just like the in-channel
 * `ctl:restart` / `POST /api/lifecycle/restart-request` paths (which DO confirm).
 *
 * REGRESSION FIX (2026-06-20): the parent-restart capability (`restart-supervisor.ps1`,
 * commit 1bad4d9) was added with an ADVISORY orchestrator-skill instruction ("user-gated,
 * say go") but NO structural floor entry — so the orchestrator firing
 * `powershell -File restart-supervisor.ps1 -Launcher prod` ran UN-gated (the existing
 * floor patterns don't match it: the script's own `taskkill /PID` is INSIDE the script,
 * not on the orchestrator's command line) and silently severed the live channel. Routing
 * it restores the confirm round-trip the user expects.
 *
 * Matches the EXECUTION of: the canonical relaunch script (`restart-supervisor.ps1`),
 * either supervisor launcher (`launch-prod-orch.mjs` / `launch-pty-orch.mjs`), or a direct
 * host launch (`node … dist/index.js … --session` — booting a second hosted supervisor).
 *
 * It distinguishes INVOKING from merely READING/inspecting: a relaunch script runs via
 * `powershell … -File …restart-supervisor.ps1` (or a `&`/`.` call), and a launcher/host runs
 * via `node …` — so the predicate requires an EXECUTION marker near the token and explicitly
 * does NOT fire for a read verb (`cat`/`type`/`more`/`less`/`head`/`tail`/`grep`/`rg`/`ls`/`dir`/
 * `Get-Content`/`gc`). False-positives here are only mildly annoying (an extra confirm) while a
 * false-negative would silently sever the live host — but we still avoid flagging an obvious read.
 */
export function isSupervisorRelaunchCommand(c: string): boolean {
  // A leading read/inspect verb ⇒ NOT a relaunch (reading the script/launcher source, listing dirs).
  if (/^\s*(cat|type|more|less|head|tail|grep|rg|findstr|ls|dir|get-content|gc)\b/.test(c)) return false;
  // ★ HARDENING (2026-06-20): test BOTH the raw command AND a SEPARATOR-STRIPPED copy. A shell
  // can mangle path separators before we ever see the string — most notably Git-Bash strips
  // backslashes, so `node dist\index.js --session` arrives as `node distindex.js --session` and
  // `powershell -File D:\tmp\restart-supervisor.ps1` as `…d:tmprestart-supervisor.ps1`. A pattern
  // anchored on `dist[\\/]index.js` or a `\b` before `launch-…` would then MISS. Stripping ALL
  // path separators (\ and /) collapses every separator variant (`dist\`, `dist/`, `dist`) to one
  // canonical form we can match filename-anchored. We OR the two tests so a normal `dist/index.js`
  // still matches via the raw pass, and the mangled `distindex.js` matches via the stripped pass.
  const stripped = c.replace(/[\\/]+/g, '');
  return matchesRelaunch(c) || matchesRelaunch(stripped);
}

/**
 * Core relaunch matcher, run against BOTH the raw and the separator-stripped command (see
 * {@link isSupervisorRelaunchCommand}). Filename tokens are matched WITHOUT requiring a path
 * separator (or word boundary) immediately before them, so a separator-stripped run like
 * `toolssupervisorlaunch-prod-orch.mjs` (no boundary before `launch-`) still matches.
 */
function matchesRelaunch(c: string): boolean {
  // PowerShell relaunch script: the script name in an EXECUTION context (-file / a powershell|pwsh
  // invocation / a `&`|`.` call operator) — NOT a bare mention. The filename is matched without a
  // leading boundary (a preceding path run may have been collapsed onto it).
  const relaunchScript =
    /restart-supervisor\.ps1\b/.test(c) &&
    (/(^|\s)(powershell|pwsh)(\.exe)?\b/.test(c) || /-file\b/.test(c) || /(^|\s)[&.]\s/.test(c));
  // Either supervisor launcher, run via node (the relaunch entrypoint the script itself calls).
  // No `\b` before `launch-` — a stripped path (`…supervisorlaunch-prod-orch.mjs`) has none.
  const launcher = /\bnode\b[^|]*launch-(prod|pty)-orch\.mjs\b/.test(c);
  // A direct host launch: node … dist[/ or \]index.js … --session (booting another hosted supervisor).
  // The separator between `dist` and `index.js` is OPTIONAL so the backslash-stripped
  // `distindex.js` still matches (`dist[\\/]?index\.js`).
  const directHost = /\bnode\b[^|]*\bdist[\\/]?index\.js\b[^|]*--session\b/.test(c);
  return relaunchScript || launcher || directHost;
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
      // The SEND tools inside them are still DENIED below (deny wins); telegram is excluded
      // at the MCP-config source AND denied. (The SDK driver tolerated `mcp__*`; the CLI
      // needs these explicit forms.)
      'mcp__hostinger-email__*', // email READ allowed (send tools denied below); whole-server glob
      'mcp__context7__*',
      'mcp__chrome-devtools__*',
      'mcp__google-workspace__*',
      'mcp__deepseek-codegen__*',
      'mcp__supervisor_channel__*', // the in-process reply tool (SDK-driver path)
      // ★ WHATSAPP READ-ALLOWED / SEND-GATED (2026-06-20, user-chosen). WhatsApp is no longer
      // excluded at the server level (it's a sanctioned capability for the live host) — so we
      // ALLOW its READ tools by NAME here (auto-allow, no prompt). The SEND tools
      // (send_message/send_file/send_audio_message) are DELIBERATELY NOT listed — an unlisted
      // tool falls through to fallback:'route' AND the safety floor (routeWhen=isDestructiveOp
      // catches `mcp__whatsapp*…send…`), so sending ROUTES to the user for approval. We do NOT
      // use a whole-server `mcp__whatsapp__*` glob (it would auto-allow sends too — and the CLI
      // rejects a too-broad allow anyway). download_media is a READ (fetch to a local path, not a
      // third-party send) → allowed. Both the personal + work accounts get the same read tools.
      'mcp__whatsapp__search_contacts',
      'mcp__whatsapp__list_messages',
      'mcp__whatsapp__list_chats',
      'mcp__whatsapp__get_chat',
      'mcp__whatsapp__get_direct_chat_by_contact',
      'mcp__whatsapp__get_contact_chats',
      'mcp__whatsapp__get_last_interaction',
      'mcp__whatsapp__get_message_context',
      'mcp__whatsapp__download_media',
      'mcp__whatsapp-work__search_contacts',
      'mcp__whatsapp-work__list_messages',
      'mcp__whatsapp-work__list_chats',
      'mcp__whatsapp-work__get_chat',
      'mcp__whatsapp-work__get_direct_chat_by_contact',
      'mcp__whatsapp-work__get_contact_chats',
      'mcp__whatsapp-work__get_last_interaction',
      'mcp__whatsapp-work__get_message_context',
      'mcp__whatsapp-work__download_media',
    ],
    // OUTWARD-TO-THIRD-PARTY hard denies (containment): TELEGRAM can NEVER reach the
    // session — it is excluded at the MCP-config source AND hard-denied here (it is the
    // channel-hijack vector; the prod plugin would seize the getUpdates token). The email
    // + gmail SEND tools are hard-denied (their READ stays available). deny-rules win over
    // everything in the permission order; in PTY mode these names also feed the spawn's
    // --disallowed-tools seal.
    // ★ WHATSAPP IS NOT HARD-DENIED HERE (2026-06-20): the user chose "reading allowed,
    // sending approval-gated". A blanket `mcp__whatsapp__*` deny would block the READ tools
    // too. Instead, whatsapp READ tools are allow-listed above, and whatsapp SEND tools are
    // left UN-listed so the safety floor (routeWhen=isDestructiveOp) ROUTES them to the user
    // for an allow/deny — NOT a silent hard-deny and NOT an auto-allow. (Hard-denying send
    // would make sending impossible; allow-listing send would skip the approval prompt.)
    deny: [
      'mcp__plugin_telegram_telegram__*',
      'mcp__telegram__*',
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
