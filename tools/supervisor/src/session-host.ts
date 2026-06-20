/**
 * The SESSION HOST — composes the Phase-2 pieces into the supervisor's host
 * inbound hook, REPLACING the Phase-1 log/echo hook with the real hosted session.
 *
 * Wires together:
 *   - LifecycleManager (owns the SessionDriver subprocess; publishes stream-json
 *     events to the bus; restarts+resumes on crash),
 *   - PermissionRouter (allow-list + route-over-channel + block-on-reply),
 *   - ChannelPermission (sends the permission prompt out + awaits the reply),
 *   - inbound routing: a recognized permission reply (`allow <code>`) is consumed
 *     by ChannelPermission; everything else is injected into the session as a
 *     user turn. Session assistant/result text is sent back over the channel.
 *
 * The "operator" reply handle (where permission prompts go, and where session
 * replies go) is the handle of the user currently driving the session — captured
 * from the latest inbound. This keeps Phase 2 single-operator (matches the
 * plugin's single-user model); multi-operator is a later concern.
 *
 * Concern (P2): compose lifecycle + router + channel into the host hook +
 * inbound/outbound routing. It owns no transport and no policy itself.
 *
 * Traces: proposal PART E Phase 2 deliverable 6 (replace the host hook with the
 * real session) + 2 (route permissions) + 3 (stream-json on the bus).
 */

import type { InboundMessage, OutboundMessage, OutboundResult, ReplyHandle } from './contract.js';
import type { OutputMode } from './config.js';
import { ChannelPermission, type SendPrompt } from './channel-permission.js';
import { LifecycleManager } from './lifecycle.js';
import { PermissionRouter, type PermissionPolicy } from './permission-router.js';
import type { Logger } from './logger.js';
import type { IoBus } from './io-bus.js';
import type { SessionDriver } from './session-driver.js';
import type { SecretStore } from './secret-store.js';
import {
  parseSetKeyCommand,
  setKeyUsageMessage,
  setKeyUnknownProviderMessage,
  type SetKeyCommand,
} from './setkey-command.js';
import {
  DEFAULT_PROVIDERS,
  resolveProviderId,
  getProvider,
  PROVIDER_IDS,
  type Provider,
  type ProviderId,
} from './provider-registry.js';
import { RoleRoutingStore } from './role-routing-store.js';
import {
  DEFAULT_ROLE_ROUTING_CONFIG,
  resolveRoleBackendWithOverrides,
  type RoleRoutingOverride,
} from './role-router.js';
import { ROLES, isRole, type Role } from './backend-kinds.js';
import {
  parseSetRoleCommand,
  isRolesCommand,
  setRoleUsageMessage,
  setRoleUnknownRoleMessage,
  setRoleUnknownProviderMessage,
  setRoleNoKeyWarning,
  setRoleConfirmMessage,
  rolesListMessage,
  type SetRoleCommand,
  type RolesListRow,
} from './setrole-command.js';

/** D1: the reserved channel-diagnostic command (handled, not typed to the AI). */
export const CHANNEL_CHECK_RE = /^\/channel-check\b/i;

/**
 * The reserved OUTPUT-MODALITY switch command (the user's "switchable output
 * channel"). `/mode text|voice|dual` (case/space-insensitive) is INTERCEPTED by
 * the supervisor — applied to the in-memory modality state, ACK'd to the user,
 * and NOT forwarded to the orchestrator. `/mode` with no/invalid arg → the
 * current mode + the valid options. See {@link parseModeCommand}.
 */
export const MODE_CMD_RE = /^\/mode\b/i;

/** The parsed result of a `/mode …` channel command (see {@link parseModeCommand}). */
export type ModeCommand =
  | { kind: 'set'; mode: OutputMode } // a valid `/mode text|voice|dual`
  | { kind: 'query' }; // `/mode` with no arg, or an invalid/unknown arg

/**
 * Parse a `/mode …` channel command. Returns `null` when the text is NOT a
 * `/mode` command at all (so the caller falls through to a normal turn). A
 * recognized command yields `{kind:'set', mode}` for a valid text|voice|dual
 * argument, else `{kind:'query'}` (bare `/mode` or an unknown arg → report the
 * current mode + options). Tolerates surrounding/extra whitespace and case.
 */
export function parseModeCommand(text: string): ModeCommand | null {
  const trimmed = text.trim();
  if (!MODE_CMD_RE.test(trimmed)) return null;
  // Everything after the '/mode' token, lower-cased, first whitespace-token only.
  const arg = trimmed.replace(MODE_CMD_RE, '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (arg === 'text' || arg === 'voice' || arg === 'dual') return { kind: 'set', mode: arg };
  return { kind: 'query' };
}

/**
 * The reserved IN-CHANNEL PROVIDER-KEY intake command — `/setkey <provider> <key>` (the
 * model-agnostic agent system's secret-intake). Like `/mode`, it is INTERCEPTED by the supervisor
 * (handled in {@link SessionHost.handleInbound}) and NEVER forwarded to the orchestrator, so the raw
 * key never enters the orchestrator's context/stream. The parse + redaction live in setkey-command.ts
 * ({@link parseSetKeyCommand} / redactSetKeyText); this re-export keeps the command discoverable here
 * alongside `/mode`. The interception is gated on a wired {@link SessionHostOptions.secretStore} —
 * absent (the current default), `/setkey` falls through to a normal turn unchanged.
 */
export { SETKEY_CMD_RE, parseSetKeyCommand, redactSetKeyText } from './setkey-command.js';

/**
 * The reserved TIER-2 PER-ROLE MODEL-SELECTION commands — `/setrole <role> <provider> [model]` and
 * `/roles` (the model-agnostic agent system's runtime role-router edit, PART Q.3). Like `/setkey`,
 * both are INTERCEPTED by the supervisor (handled in {@link SessionHost.handleInbound}) and NEVER
 * forwarded to the orchestrator. The parse + message logic lives in setrole-command.ts; these
 * re-exports keep the commands discoverable here alongside `/mode` + `/setkey`. The interception is
 * gated on a wired {@link SessionHostOptions.roleRoutingStore} — absent (the current default),
 * `/setrole` + `/roles` fall through to a normal turn unchanged. NOTHING here is secret (a role /
 * provider / model are not credentials), so — unlike `/setkey` — there is NO redaction.
 */
export { SETROLE_CMD_RE, ROLES_CMD_RE, parseSetRoleCommand, isRolesCommand } from './setrole-command.js';

/** M3: at most one delivery-failure notice per this window (outage cooldown). */
export const DELIVERY_FAILURE_COOLDOWN_MS = 60_000;

/** Lifecycle-restart guardrail: max agent-initiated restart REQUESTS per window (kills loops). */
export const RESTART_RATE_LIMIT = 3;
export const RESTART_RATE_WINDOW_MS = 30 * 60_000; // 30 minutes

/** The outcome of an agent restart request (returned by requestRestart). */
export type RestartRequestOutcome =
  | { status: 'queued' } // accepted; confirm + teardown happen out-of-band
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'busy' }; // a restart confirm is already in flight

export interface SessionHostOptions {
  driver: SessionDriver;
  bus: IoBus;
  logger: Logger;
  /**
   * Send an outbound over a channel (bound supervisor.sendOutbound for a channel).
   * `msg.options` carries the modality (text/voice/dual) — the supervisor sets it
   * on the orchestrator's substantive replies from the current output mode; the
   * adapter renders TTS / sends the bubble accordingly. Control messages
   * (permission prompts, ACKs, system notices) omit it and go as plain text.
   */
  send: (handle: ReplyHandle, msg: OutboundMessage) => Promise<OutboundResult>;
  /**
   * INLINE-BUTTON ACK (optional) — acknowledge a button tap (dismiss the client
   * spinner; optional toast). Bound to supervisor.answerCallback for a channel.
   * When absent, button-tap decisions still resolve (the ACK is best-effort UX).
   */
  answerCallback?: (callbackId: string, text?: string) => Promise<void>;
  /**
   * INLINE-BUTTON FOLLOW-UP (optional) — replace a prompt message's text + drop its
   * keyboard (so a decided prompt shows its outcome). Bound to supervisor.editMessage
   * for a channel. Best-effort.
   */
  editMessage?: (handle: ReplyHandle, messageId: string, text: string) => Promise<void>;
  /**
   * MESSAGE DELETE (optional) — remove a message from the chat (Telegram deleteMessage). Bound to
   * supervisor.deleteMessage for a channel. Used by the `/setkey` path to delete the user's
   * plaintext-key message after the key is stored, so it does not linger in chat history.
   * Best-effort; absent → the key is still redacted from capture + never echoed.
   */
  deleteMessage?: (handle: ReplyHandle, messageId: string) => Promise<void>;
  /**
   * `/setkey` IN-CHANNEL SECRET STORE (optional). When supplied, the SessionHost INTERCEPTS
   * `/setkey <provider> <key>` (like `/mode`): it stores the key SCOPED to that provider, replies a
   * MASKED confirmation, deletes the user's message (via {@link deleteMessage}), and does NOT forward
   * the command to the orchestrator (the raw key never enters the orchestrator's context). When ABSENT
   * (the current/dormant default — index.ts does not wire it), `/setkey` is NOT intercepted and falls
   * through to a normal turn EXACTLY as today (byte-for-byte unchanged). The store's PRESENCE is the
   * activation signal (P6). The store path is gitignored (secret-store.ts under `.state/`).
   */
  secretStore?: SecretStore;
  /**
   * `/setkey` provider table (optional; default {@link DEFAULT_PROVIDERS}). The set of providers a
   * `/setkey <provider>` token may name; an unknown token gets a helpful error listing these. Only
   * consulted when {@link secretStore} is wired. Shared by the `/setrole` path (same registry).
   */
  providers?: Readonly<Record<ProviderId, Provider>>;
  /**
   * TIER-2 ROLE-ROUTING STORE (optional). When supplied, the SessionHost INTERCEPTS `/setrole
   * <role> <provider> [model]` + `/roles` (like `/setkey`): `/setrole` persists the role→{provider,
   * model} override (so the NEXT dispatch of that role uses it — runtime, no restart) and replies a
   * confirmation; `/roles` lists the effective role→provider/model map merged over the in-code
   * default plus per-provider key-PRESENCE booleans (NEVER a key value). Neither is forwarded to the
   * orchestrator. The supervisor is the SOLE WRITER of this store — both the typed `/setrole` AND the
   * orchestrator-invokable {@link SessionHost.setRoleRouting} route through ONE private writer. When
   * ABSENT (the current/dormant default — index.ts does not wire it), `/setrole` + `/roles` are NOT
   * intercepted and fall through to a normal turn EXACTLY as today (byte-for-byte unchanged). The
   * store's PRESENCE is the activation signal (P6). The store path is gitignored (under `.state/`).
   */
  roleRoutingStore?: RoleRoutingStore;
  /** Permission policy (allow-list / deny-list / fallback / safety-floor predicate). */
  policy: PermissionPolicy;
  /**
   * The STARTUP output modality for the orchestrator's substantive replies
   * (text/voice/dual). The SessionHost holds this as switchable in-memory state
   * and flips it via the intercepted `/mode` command; this is just the boot value
   * (resets here on a restart). From config ({@link OutputMode}). Default 'text'.
   */
  outputMode?: OutputMode;
  /** The system prompt — plain string (demo persona) or preset+append (orchestrator). */
  systemPrompt?: string | { preset: 'claude_code'; append?: string };
  cwd?: string;
  model?: string;
  /** Tools to pass to the SDK allow-list (router still gates the rest). */
  allowedTools?: string[];
  /** Tools always denied at the SDK level (e.g. the telegram plugin). */
  disallowedTools?: string[];
  /** Settings sources to load (project skills + CLAUDE.md + settings). */
  settingSources?: ('user' | 'project' | 'local')[];
  /** MCP servers (Record<name, config>) wired into the session (telegram excluded). */
  mcpServers?: Record<string, unknown>;
  /** Env for the spawned subprocess (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1). */
  env?: Record<string, string | undefined>;
  /** SDK permission mode (default 'default'). */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /**
   * Role-adoption prefix (e.g. '/orchestrator'). Prepended to the FIRST real user
   * turn — NOT fired as a standalone bootstrap turn at launch. Rationale (live-
   * surfaced): a standalone bootstrap turn self-executes the whole orchestrator
   * startup BEFORE any user is bound — so the channel reply tool fails
   * (currentOperator() is null) and tokens burn pre-user. Prefixing the first user
   * turn loads the role exactly when the user engages: operator bound, reply works,
   * no pre-user execution.
   */
  roleTurnPrefix?: string;
  /**
   * Per-turn de-dup: the channel reply tool name (e.g.
   * 'mcp__supervisor_channel__reply'). When set (orchestrator profile), the final
   * answer auto-outs UNLESS the reply tool fired this turn. When unset (demo),
   * assistant text auto-outs each turn. (Live fix: a blanket suppress silenced
   * plain-text answers the orchestrator gives for direct questions.)
   */
  replyToolName?: string;
  /** Permission reply window, ms. */
  permissionTimeoutMs?: number;
  /**
   * FORWARD ALL OUTPUT (the user's core objective). When true (orchestrator profile),
   * the supervisor mirrors the session's TOOL ACTIVITY to the channel — not just the
   * final assistant text: tool calls (incl. Agent/Task/SendMessage = sub-agent spawns
   * + teammate messages) and tool RESULTS, with errors always surfaced. So the remote
   * user SEES the orchestrator coordinating its sub-agents and any error it hits, which
   * is the whole point of the supervisor. Off (demo) = only assistant text is sent.
   */
  forwardToolActivity?: boolean;
  /**
   * When forwarding tool activity, also forward NON-error tool RESULTS (verbose). Most
   * tool results are noise on a phone; default false = forward tool CALLS + tool ERRORS
   * only (the actionable signal). Errors are always forwarded regardless.
   */
  forwardToolResultsVerbose?: boolean;
  /**
   * D1/D2: the loopback Panel base URL (e.g. 'http://127.0.0.1:8790'). When set, the
   * '/channel-check' diagnostic turn (and the orchestrator preamble) reference it so
   * the orchestrator can curl the read + repair endpoints. Undefined → /channel-check
   * still injects a diagnostic turn but without a concrete URL.
   */
  panelUrl?: string;
  /**
   * D4: supervisor→orchestrator liveness. When set (> 0), after a ping is injected the
   * orchestrator must produce a turn result within this many ms or it is treated as
   * HUNG → tier-b (restart+resume + notify the user). 0/omit = liveness ping disabled.
   */
  pingResponseTimeoutMs?: number;
  /**
   * D4: how often the periodic scheduler fires an IDLE-AWARE liveness ping (ms). The
   * ping is a no-op while a turn is in flight (a busy orchestrator is never restarted),
   * so this is the cadence at which a genuinely-IDLE-but-unresponsive orchestrator is
   * detected. Should be comfortably larger than pingResponseTimeoutMs. 0/omit = no
   * scheduler (the ping can still be triggered manually). Default off.
   */
  pingIntervalMs?: number;
  /**
   * D4 tier-b: called when the orchestrator fails to answer a liveness ping in time —
   * the supervisor restarts it (LifecycleManager restart+resume) and notifies the user.
   * Injected by index.ts (it owns the relaunch decision). Receives a reason string.
   */
  onUnresponsive?: (reason: string) => void | Promise<void>;
}

export class SessionHost {
  private readonly opts: SessionHostOptions;
  private readonly logger: Logger;
  private readonly lifecycle: LifecycleManager;
  private readonly router: PermissionRouter;
  /** Set once we have an operator (the latest inbound user). */
  private channelPermission: ChannelPermission | null = null;
  private operator: ReplyHandle | null = null;
  /** Stable id of the bound operator (H1: reject replies/turns from a DIFFERENT user). */
  private operatorId: string | null = null;
  /** True until the role-adoption prefix has been applied to the first user turn. */
  private rolePrefixPending: boolean;
  private started = false;
  /**
   * SEND-SIDE IDEMPOTENCY GUARD (the seq-221 self-diagnosis #1 fix). The text last
   * delivered to the operator for the CURRENT turn. A second outbound byte-identical
   * to it — without an intervening user turn — is a DUPLICATE (a duplicate `result`
   * event, the PTY render race that re-grabs the prior turn's stale answer, or any
   * double-emit) and is SUPPRESSED. Reset to null on each new user turn, so two
   * legitimately-identical answers to two DIFFERENT user messages both go through;
   * only a same-turn duplicate is dropped. Independent of the render-side guard —
   * belt-and-suspenders against doubling AND byte-identical stale resends.
   */
  private lastSentText: string | null = null;
  /** F1: re-entrancy guard so a delivery-failure note's OWN failed send doesn't loop. */
  private feedingDeliveryFailure = false;
  /** M3: wall-clock (ms) of the last delivery-failure notice — outage-cooldown anchor. */
  private lastDeliveryFailureNotifiedAt = 0;
  /** D4: pending liveness-ping deadline timer (cleared when the orchestrator answers). */
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  /** D4: the periodic liveness scheduler (fires an idle-aware ping every pingIntervalMs). */
  private pingScheduler: ReturnType<typeof setInterval> | null = null;
  /** Lifecycle-restart: wall-clock (ms) timestamps of recent agent restart REQUESTS (rate-limit). */
  private restartRequestTimes: number[] = [];
  /** Lifecycle-restart: a restart confirm is already in flight (don't open a second dialog). */
  private restartConfirmInFlight = false;
  /**
   * OUTPUT MODALITY (the user's switchable "output channel"). SOLE OWNER of this
   * state (P1): the `/mode` command (intercepted in handleInbound) is the only
   * writer; `sendToOperator` reads it to set the outbound modality. In-memory
   * (resets to the configured default on restart, per v1 scope).
   */
  private outputMode: OutputMode;
  /**
   * `/setkey` IN-CHANNEL SECRET STORE (null when not wired — the dormant default). When set, the
   * host intercepts `/setkey` and stores keys here scoped per provider; when null, `/setkey` is NOT
   * intercepted (falls through to a normal turn, byte-for-byte unchanged). SOLE READER here.
   */
  private readonly secretStore: SecretStore | null;
  /** The provider table the `/setkey` + `/setrole` tokens resolve against (DEFAULT_PROVIDERS unless overridden). */
  private readonly providers: Readonly<Record<ProviderId, Provider>>;
  /**
   * TIER-2 ROLE-ROUTING STORE (null when not wired — the dormant default). When set, the host
   * intercepts `/setrole` + `/roles` and is the SOLE WRITER of the persisted role-routing override.
   * Both the typed `/setrole` and the orchestrator-invokable {@link setRoleRouting} funnel through
   * the ONE private writer {@link applyRoleRouting}. When null, `/setrole` + `/roles` fall through to
   * a normal turn, byte-for-byte unchanged.
   */
  private readonly roleRoutingStore: RoleRoutingStore | null;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('session-host');
    this.rolePrefixPending = !!opts.roleTurnPrefix;
    this.outputMode = opts.outputMode ?? 'text';
    this.secretStore = opts.secretStore ?? null;
    this.providers = opts.providers ?? DEFAULT_PROVIDERS;
    this.roleRoutingStore = opts.roleRoutingStore ?? null;

    // The router needs a PermissionChannel; we give it one that defers to the
    // operator-bound ChannelPermission (created lazily once an operator exists).
    this.router = new PermissionRouter({
      policy: opts.policy,
      channel: {
        askUser: async (req) => {
          if (!this.channelPermission) {
            // No operator yet → can't ask → fail-safe deny (return timeout).
            this.logger.warn('permission asked with no operator — denying', { tool: req.toolName });
            return 'timeout';
          }
          return this.channelPermission.askUser(req);
        },
      },
      onDecision: (note, fields) => this.logger.info(note, fields),
    });

    this.lifecycle = new LifecycleManager({
      driver: opts.driver,
      bus: opts.bus,
      logger: opts.logger,
      systemPrompt: opts.systemPrompt,
      onPermission: this.router.decide,
      cwd: opts.cwd,
      model: opts.model,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      settingSources: opts.settingSources,
      mcpServers: opts.mcpServers,
      env: opts.env,
      permissionMode: opts.permissionMode,
      // NOTE: no lifecycle bootstrapTurns — the role-adoption prefix is applied to
      // the FIRST real user turn in handleInbound (so it runs WITH a bound operator,
      // not pre-user). See SessionHostOptions.roleTurnPrefix.
      //
      // PER-TURN DE-DUP (orchestrator profile): pass the reply-tool name so the
      // lifecycle auto-outs the final answer text UNLESS the reply tool fired this
      // turn (then the reply-tool output is the channel-out). The DEMO profile (no
      // replyToolName) keeps the assistant-text auto-out. Both onAssistant/onResult
      // are wired UNCONDITIONALLY; the lifecycle decides per-turn whether to call
      // them. (Live fix: a blanket suppress silenced the orchestrator's plain-text
      // answers — turns where it answered directly instead of via the reply tool.)
      replyToolName: opts.replyToolName,
      onAssistant: (text) => this.sendToOperator(text),
      onResult: (text) => {
        // D4: ANY real turn result proves the orchestrator is responsive → clear the
        // liveness-ping deadline (it answered, whether the ping or another turn).
        this.clearPingTimer();
        return text ? this.sendToOperator(text) : Promise.resolve();
      },
      // D4: an INTERNAL turn (the liveness ping) → confirm responsiveness WITHOUT
      // forwarding the pong to the user. Just clears the deadline (= alive, tier-a).
      onInternalResult: () => {
        this.clearPingTimer();
        this.logger.info('liveness pong received (internal) — orchestrator responsive');
      },
      // D4 BELT: mid-turn activity is the INTERNAL liveness signal (clears the ping
      // deadline — proves the orchestrator is alive). No user-facing message (the
      // "still working…" heartbeat was removed).
      onProgress: () => this.onMidTurnProgress(),
      // FORWARD ALL OUTPUT (orchestrator profile): mirror tool activity to the channel.
      onToolActivity: opts.forwardToolActivity ? (info) => this.forwardToolActivity(info) : undefined,
    });
  }

  /**
   * FORWARD ALL OUTPUT (the user's core objective): mirror the session's tool activity
   * to the channel — sub-agent spawns / teammate messages (Agent/Task/SendMessage) and
   * tool errors are the signal the remote user must see (the supervisor exists to make
   * the orchestrator's coordination + failures visible). Goes via opts.send DIRECTLY
   * (like the heartbeat) so it's never deduped by the final-answer guard and never
   * pollutes the lastSentText turn-baseline. Best-effort: a forward failure never breaks
   * the turn. Non-error tool RESULTS are forwarded only when forwardToolResultsVerbose
   * (default off — most are phone-noise); tool CALLS and ERRORS always go.
   */
  private async forwardToolActivity(
    info:
      | { kind: 'tool_use'; tools: { name: string; hint?: string }[] }
      | { kind: 'tool_result'; isError?: boolean; content?: string },
  ): Promise<void> {
    if (!this.operator) return; // no user bound yet → nothing to forward to
    let text: string | undefined;
    if (info.kind === 'tool_use') {
      const lines = info.tools.map((t) => `⚙️ ${t.name}${t.hint ? `(${t.hint})` : ''}`);
      text = lines.join('\n');
    } else if (info.isError) {
      const body = (info.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      text = `❌ tool error${body ? `: ${body}` : ''}`;
    } else if (this.opts.forwardToolResultsVerbose) {
      const body = (info.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (body) text = `✓ ${body}`;
    }
    if (!text) return;
    try {
      await this.opts.send(this.operator, { text });
    } catch (err) {
      this.logger.warn('tool-activity forward failed (non-fatal)', { err: String(err) });
    }
  }

  /**
   * D1 — inject the '/channel-check' DIAGNOSTIC turn. The supervisor grants the
   * orchestrator the self-check/repair surface (the loopback panel) and asks it to
   * inspect the channel, report to the user, and repair at its own discretion. This is
   * a SUPERVISOR-CRAFTED turn (not the user's literal text) so the orchestrator gets a
   * precise instruction + the endpoint list, every time.
   */
  private async injectChannelCheckTurn(): Promise<void> {
    const base = this.opts.panelUrl ?? 'http://127.0.0.1:<panel-port>';
    const turn =
      `[SUPERVISOR /channel-check] The user asked you to check the messaging channel. ` +
      `You have FULL channel-control access via the supervisor's loopback panel (use Bash/PowerShell + curl):\n` +
      `READ: GET ${base}/api/channel/state (adapters, recent delivery results, pending sends, sender PIDs), ` +
      `GET ${base}/api/capture (raw inbound+outbound+delivery events), GET ${base}/api/health, GET ${base}/api/session.\n` +
      `REPAIR (use at your discretion, coordinate with the user): POST ${base}/api/channel/reconnect, ` +
      `POST ${base}/api/channel/flush, POST ${base}/api/channel/kill-stale-sender.\n` +
      `Inspect the channel state, tell the user what you find (delivery failures? a stale double-sender? a backlog?), ` +
      `take any repair action you judge appropriate, and confirm the outcome.`;
    // A diagnostic turn is a real turn — reset the per-turn guard like any inbound.
    this.lastSentText = null;
    await this.lifecycle.sendUserTurn({ text: turn });
  }

  /** Start the hosted session (spawns/owns the subprocess via the lifecycle). */
  async start(): Promise<void> {
    if (this.started) return;
    await this.lifecycle.start();
    this.started = true;
    // D4: arm the periodic idle-aware liveness scheduler (no-op if disabled).
    this.startLivenessScheduler();
    this.logger.info('session host started', this.lifecycle.health());
  }

  /**
   * The supervisor's inbound hook. Bind this via `supervisor.onInbound(host.handleInbound)`.
   * Captures the operator, intercepts permission replies, else injects a user turn.
   */
  handleInbound = async (msg: InboundMessage): Promise<void> => {
    const incomingId = msg.userId ?? msg.user;

    // H1 — operator binding. BIND the operator on the FIRST inbound and KEEP it;
    // do NOT overwrite it on every message (the prior behavior let any later
    // sender hijack where permission prompts + session replies go, and let a
    // different user answer a prompt that wasn't theirs). Once bound, reject
    // inbound from a DIFFERENT user (single-operator model, matching the plugin).
    if (!this.operator) {
      this.operator = msg.replyHandle;
      this.operatorId = incomingId;
      this.channelPermission = new ChannelPermission({
        // Send the prompt (optionally WITH inline buttons) and surface the sent
        // message id back so a tapped-decision can edit the prompt to its outcome.
        send: (async (handle, text, buttons) => {
          const r = await this.opts.send(handle, { text, ...(buttons ? { options: { buttons } } : {}) });
          return { ...(r.sentIds[0] ? { messageId: r.sentIds[0] } : {}) };
        }) as SendPrompt,
        operator: this.operator,
        timeoutMs: this.opts.permissionTimeoutMs,
        onAsk: (note, fields) => this.logger.info(note, fields),
      });
      this.logger.info('operator bound', { operatorId: this.operatorId });
    } else if (incomingId !== this.operatorId) {
      // A different user — ignore (do not let them drive the session or answer
      // a permission prompt routed to the bound operator).
      this.logger.warn('ignoring inbound from non-operator', { incomingId, operatorId: this.operatorId });
      return;
    }

    const cp = this.channelPermission!;
    const text = msg.text ?? '';

    // ★ BUTTON TAP (callback_query) — the PRIMARY permission UX. If the inbound is a
    // tap on a `perm:allow:<code>` / `perm:deny:<code>` button, resolve the matching
    // pending ask, ACK the tap (dismiss the spinner), and edit the prompt to show the
    // outcome (buttons disappear). A non-permission callback, or a stale/unknown code,
    // is ACK'd quietly and dropped (never typed to the AI).
    if (msg.callback) {
      await this.handlePermissionCallback(msg.callback);
      return;
    }

    // Intercept a CODED permission reply (allow/deny <code>) first.
    const coded = ChannelPermission.parseReply(text);
    if (coded && cp.submitReply(coded.code, coded.verdict)) {
      this.logger.info('inbound consumed as permission reply', { verdict: coded.verdict, coded: true });
      return;
    }

    // Then a BARE verdict (allow/deny/y/n) — bound to the SINGLE pending prompt.
    // This is the UX gap the live demo hit (user replied "Deny" with no code).
    // Only consumes when exactly one ask is pending; otherwise falls through to a
    // normal turn (so a literal "deny"/"yes" chat message isn't eaten when there
    // is nothing — or more than one thing — to answer).
    const bare = ChannelPermission.parseBareReply(text);
    if (bare && cp.submitBareReply(bare.verdict)) {
      this.logger.info('inbound consumed as bare permission reply', { verdict: bare.verdict, coded: false });
      return;
    }

    // ★ D1 — reserved '/channel-check' command. HANDLED here (NOT typed verbatim to
    // the AI): the supervisor crafts a DIAGNOSTIC turn that grants the orchestrator the
    // self-check/repair surface (the loopback panel) + asks it to inspect + report +
    // repair at its discretion. Same seam as the permission-reply interception above.
    if (CHANNEL_CHECK_RE.test(text.trim())) {
      this.logger.info('inbound consumed as /channel-check (diagnostic turn injected)');
      await this.injectChannelCheckTurn();
      return;
    }

    // ★ OUTPUT-MODALITY SWITCH — reserved '/mode text|voice|dual'. INTERCEPTED here
    // (same seam): applied to the in-memory modality state + ACK'd to the user, and
    // NOT forwarded to the orchestrator. Bare/invalid `/mode` → report current + options.
    const modeCmd = parseModeCommand(text);
    if (modeCmd) {
      await this.handleModeCommand(modeCmd);
      return;
    }

    // ★ IN-CHANNEL PROVIDER-KEY INTAKE — reserved '/setkey <provider> <key>'. INTERCEPTED here
    // (same seam) so the RAW KEY NEVER reaches the orchestrator: store it scoped per provider,
    // reply a MASKED confirmation, delete the user's message, and return WITHOUT forwarding.
    // GATED on a wired secretStore — when absent (the dormant default), `/setkey` is NOT
    // intercepted and falls through to a normal turn exactly as today (byte-for-byte unchanged).
    if (this.secretStore) {
      const setKeyCmd = parseSetKeyCommand(text);
      if (setKeyCmd) {
        await this.handleSetKeyCommand(setKeyCmd, msg);
        return;
      }
    }

    // ★ TIER-2 PER-ROLE MODEL SELECTION — reserved '/setrole <role> <provider> [model]' + '/roles'.
    // INTERCEPTED here (same seam) and NOT forwarded to the orchestrator. `/setrole` persists the
    // role→{provider,model} override (next dispatch uses it — runtime, no restart); `/roles` lists
    // the effective merged map + per-provider key-PRESENCE booleans (never values). GATED on a wired
    // roleRoutingStore — when absent (the dormant default), both fall through to a normal turn exactly
    // as today (byte-for-byte unchanged). `/roles` is matched first (a distinct word from /setrole).
    if (this.roleRoutingStore) {
      if (isRolesCommand(text)) {
        await this.handleRolesCommand();
        return;
      }
      const setRoleCmd = parseSetRoleCommand(text);
      if (setRoleCmd) {
        await this.handleSetRoleCommand(setRoleCmd);
        return;
      }
    }

    // Otherwise inject as a user turn into the session. On the FIRST real user
    // turn, prepend the role-adoption prefix (e.g. '/orchestrator') so the role
    // loads WITH a bound operator — not as a pre-user bootstrap turn (live fix).
    let turnText = text;
    if (this.rolePrefixPending && this.opts.roleTurnPrefix) {
      this.rolePrefixPending = false;
      turnText = `${this.opts.roleTurnPrefix}\n\n${text}`;
      this.logger.info('applied role-adoption prefix to the first user turn', { prefix: this.opts.roleTurnPrefix });
    }
    // New user turn → reset the send-side idempotency guard so this turn's (possibly
    // legitimately-identical) answer is NOT suppressed as a duplicate of the prior turn's.
    // The guard only catches same-turn duplicates (a double-emit / the stale-resend race).
    this.lastSentText = null;
    await this.lifecycle.sendUserTurn({ text: turnText });
  };

  /**
   * Handle an inbound BUTTON TAP (callback_query). Parses the `perm:<verdict>:<code>`
   * scheme, resolves the matching pending permission ask, ACKs the tap (dismiss the
   * spinner with a brief toast), and edits the prompt message to show the outcome
   * (so the buttons disappear and a record remains). Covers BOTH the permission-gate
   * prompts AND the lifecycle restart-confirmation (both route through ChannelPermission).
   * A non-permission or stale/unknown callback is ACK'd quietly (no error to the user).
   */
  private async handlePermissionCallback(cb: { id: string; data: string; messageId?: string }): Promise<void> {
    const parsed = ChannelPermission.parseCallbackData(cb.data);
    if (!parsed) {
      // Not our scheme (or malformed) — ACK so the client spinner clears, then ignore.
      await this.answerCallbackSafe(cb.id);
      this.logger.info('ignoring non-permission callback', { data: cb.data.slice(0, 32) });
      return;
    }
    const cp = this.channelPermission!;
    const res = cp.submitReplyDetailed(parsed.code, parsed.verdict);
    if (!res.resolved) {
      // A stale/expired/already-answered code — ACK with a toast so the user sees why.
      await this.answerCallbackSafe(cb.id, 'This request is no longer pending.');
      this.logger.info('button tap for a non-pending permission code (ignored)', { verdict: parsed.verdict });
      return;
    }
    this.logger.info('inbound consumed as permission button tap', { verdict: parsed.verdict });
    const allowed = parsed.verdict === 'allow';
    // 1) ACK the tap (dismiss the spinner) with a short toast.
    await this.answerCallbackSafe(cb.id, allowed ? 'Allowed ✅' : 'Denied ❌');
    // 2) Edit the prompt message so the buttons disappear + the outcome is on record.
    const messageId = res.messageId ?? cb.messageId;
    if (messageId && this.opts.editMessage && this.operator) {
      const tool = res.toolName ? ` '${res.toolName}'` : '';
      const outcome = allowed ? `✅ Allowed${tool}` : `❌ Denied${tool}`;
      try {
        await this.opts.editMessage(this.operator, messageId, outcome);
      } catch (err) {
        this.logger.warn('permission prompt edit failed (non-fatal)', { err: String(err) });
      }
    }
  }

  /** Best-effort callback ACK (never throws — the decision already resolved). */
  private async answerCallbackSafe(callbackId: string, text?: string): Promise<void> {
    if (!this.opts.answerCallback) return;
    try {
      await this.opts.answerCallback(callbackId, text);
    } catch (err) {
      this.logger.warn('answerCallback failed (non-fatal)', { err: String(err) });
    }
  }

  /** The currently-bound operator reply handle (null until the first inbound). */
  currentOperator(): ReplyHandle | null {
    return this.operator;
  }

  /** The current output modality (text/voice/dual) — for the panel / tests. */
  outputModeState(): OutputMode {
    return this.outputMode;
  }

  /**
   * Apply an intercepted `/mode` command: `set` flips the modality state + ACKs
   * the new mode; `query` (bare/invalid `/mode`) replies with the current mode +
   * the valid options. The ACK is a CONTROL message — plain text (no modality), so
   * a "/mode voice" ACK is not itself voiced. NOT forwarded to the orchestrator.
   */
  private async handleModeCommand(cmd: ModeCommand): Promise<void> {
    if (cmd.kind === 'set') {
      const prev = this.outputMode;
      this.outputMode = cmd.mode;
      this.logger.info('output modality switched via /mode', { from: prev, to: cmd.mode });
      this.publishLifecycle('output_mode_changed', { from: prev, to: cmd.mode });
      await this.ackToOperator(`Output mode → ${cmd.mode}`);
    } else {
      this.logger.info('output modality queried via /mode', { current: this.outputMode });
      await this.ackToOperator(
        `Output mode is "${this.outputMode}". Set it with: /mode text | /mode voice | /mode dual.`,
      );
    }
  }

  /**
   * Send a CONTROL/ACK line to the operator as PLAIN TEXT (bypasses the modality —
   * a `/mode` ack / system notice is never voiced — and the lastSentText dedup
   * baseline, like the other direct control sends). Best-effort: a failure is logged,
   * not thrown (a `/mode` switch still took effect even if its ack didn't deliver).
   */
  private async ackToOperator(text: string): Promise<void> {
    if (!this.operator) return;
    try {
      await this.opts.send(this.operator, { text });
    } catch (err) {
      this.logger.warn('mode-ack send failed (non-fatal)', { err: String(err) });
    }
  }

  /**
   * Apply an intercepted `/setkey <provider> <key>` command (only reached when a secretStore is
   * wired). The RAW KEY IS NEVER FORWARDED to the orchestrator (we return without injecting a turn)
   * and is NEVER echoed/logged in full. Steps:
   *   1. validate the shape (usage form → reply usage, no key stored);
   *   2. resolve the provider token against the registry (unknown → helpful error listing providers;
   *      a provider with no secretEnvVar → warn — should not happen for the wired set);
   *   3. store the key SCOPED under the provider's secretEnvVar (the store returns a MASKED form);
   *   4. reply a MASKED confirmation only (e.g. "GROQ_API_KEY set: gsk…1234 ✓") — plain text, never voiced;
   *   5. DELETE the user's original message (best-effort) so the plaintext key does not linger in chat.
   * Every reply is a CONTROL message (ackToOperator → plain text, bypasses modality + dedup).
   */
  private async handleSetKeyCommand(cmd: SetKeyCommand, msg: InboundMessage): Promise<void> {
    const store = this.secretStore;
    if (!store) return; // defensive — only called when wired
    const knownProviders = [...PROVIDER_IDS];

    if (cmd.kind === 'usage') {
      this.logger.info('/setkey usage form (no key stored)', { reason: cmd.reason });
      await this.ackToOperator(setKeyUsageMessage(knownProviders));
      // Still delete the message if it somehow carried a stray token (defensive; usually nothing secret).
      await this.deleteOperatorMessage(msg);
      return;
    }

    // Resolve the provider token (canonical id or alias; case-insensitive).
    const providerId = resolveProviderId(cmd.providerToken, this.providers);
    if (!providerId) {
      this.logger.info('/setkey unknown provider', { token: cmd.providerToken });
      await this.ackToOperator(setKeyUnknownProviderMessage(cmd.providerToken, knownProviders));
      // The message DID carry a key value (unknown provider, but a key was typed) → delete it.
      await this.deleteOperatorMessage(msg);
      return;
    }

    const provider = getProvider(providerId, this.providers);
    const secretEnvVar = provider.secretEnvVar;
    if (!secretEnvVar) {
      // A registered provider with no secret env var (shouldn't happen for the wired set) → warn,
      // do NOT store, still delete the message (it carried a key).
      this.logger.warn('/setkey provider has no secretEnvVar — not storing', { providerId });
      await this.ackToOperator(`Provider "${providerId}" has no configured secret variable — key NOT stored.`);
      await this.deleteOperatorMessage(msg);
      return;
    }

    // Store the key SCOPED under the provider's secret env var. NEVER log the value; the store
    // returns the masked form for the confirmation.
    let masked: string;
    try {
      const r = store.setKey(secretEnvVar, cmd.key);
      masked = r.masked;
    } catch (err) {
      // e.g. empty key rejected by the store. Reply a generic failure (NO key value), delete the msg.
      this.logger.warn('/setkey store rejected the key', { providerId, err: String(err) });
      await this.ackToOperator(`Could not store the ${secretEnvVar} key (rejected as invalid/empty).`);
      await this.deleteOperatorMessage(msg);
      return;
    }

    this.logger.info('/setkey stored a provider key (masked)', { providerId, secretEnvVar, masked });
    // MASKED confirmation only — never the full value. Plain text (ackToOperator → not voiced).
    await this.ackToOperator(`${secretEnvVar} set: ${masked} ✓`);
    // DELETE the user's plaintext-key message so it does not linger in chat history (best-effort).
    await this.deleteOperatorMessage(msg);
  }

  /**
   * Best-effort delete of an inbound message from the chat (used by `/setkey` to remove the
   * plaintext-key message). Resolves the message id from the inbound (the adapter's replyHandle
   * carries the originating message id) and calls the wired {@link SessionHostOptions.deleteMessage}.
   * Never throws (a failed delete is logged; the key is already redacted from capture + never echoed).
   */
  private async deleteOperatorMessage(msg: InboundMessage): Promise<void> {
    if (!this.opts.deleteMessage || !this.operator) return;
    // The originating message id: Telegram's replyHandle carries replyToMessageId (the inbound msg id);
    // some adapters also surface a top-level messageId. Try both; if neither, skip (nothing to delete).
    const handleAny = msg.replyHandle as { replyToMessageId?: string | number; messageId?: string | number };
    const rawId = handleAny.replyToMessageId ?? handleAny.messageId;
    if (rawId === undefined || rawId === null || `${rawId}`.length === 0) {
      this.logger.info('/setkey: no message id on the inbound — cannot delete (key still redacted)');
      return;
    }
    try {
      await this.opts.deleteMessage(this.operator, `${rawId}`);
      this.logger.info('/setkey: deleted the user plaintext-key message from chat');
    } catch (err) {
      this.logger.warn('/setkey: deleteMessage failed (non-fatal; key already redacted)', { err: String(err) });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────────────────────
   * TIER-2 PER-ROLE MODEL SELECTION (PART Q.3 — `/setrole` + `/roles`). Only reached when a
   * roleRoutingStore is wired. The supervisor is the SOLE WRITER of the routing store; both the
   * typed `/setrole` and the orchestrator-invokable {@link setRoleRouting} funnel through ONE
   * private writer ({@link applyRoleRouting}). Nothing here is secret → no redaction, no delete.
   * ────────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Apply an intercepted `/setrole <role> <provider> [model]` command. Validates the role + provider
   * against their registries (helpful errors listing the known set), records the override via the
   * SOLE writer, then replies a confirmation (e.g. "coding → groq (llama-3.3-70b) ✓"), WARNING if the
   * chosen provider has no key set yet (the selection is still recorded). NOT forwarded to the
   * orchestrator. Every reply is a CONTROL message (ackToOperator → plain text).
   */
  private async handleSetRoleCommand(cmd: SetRoleCommand): Promise<void> {
    const knownRoles = [...ROLES];
    const knownProviders = [...PROVIDER_IDS];

    if (cmd.kind === 'usage') {
      this.logger.info('/setrole usage form (nothing set)', { reason: cmd.reason });
      await this.ackToOperator(setRoleUsageMessage(knownRoles, knownProviders));
      return;
    }

    // Validate the role (case-insensitive — normalize to lower for the known-role check).
    const roleNorm = cmd.roleToken.trim().toLowerCase();
    if (!isRole(roleNorm)) {
      this.logger.info('/setrole unknown role', { token: cmd.roleToken });
      await this.ackToOperator(setRoleUnknownRoleMessage(cmd.roleToken, knownRoles));
      return;
    }

    // Resolve the provider token (canonical id or alias; case-insensitive).
    const providerId = resolveProviderId(cmd.providerToken, this.providers);
    if (!providerId) {
      this.logger.info('/setrole unknown provider', { token: cmd.providerToken });
      await this.ackToOperator(setRoleUnknownProviderMessage(cmd.providerToken, knownProviders));
      return;
    }

    // Record via the SOLE writer (the typed-command path → the same writer the orchestrator uses).
    const result = this.applyRoleRouting(roleNorm, providerId, cmd.modelToken);
    if (!result.ok) {
      await this.ackToOperator(`Could not set role "${roleNorm}" → ${providerId}: ${result.error}.`);
      return;
    }

    const warning =
      result.keyPresent === false
        ? setRoleNoKeyWarning(providerId, getProvider(providerId, this.providers).secretEnvVar)
        : undefined;
    await this.ackToOperator(setRoleConfirmMessage(roleNorm, providerId, result.model, warning));
  }

  /**
   * Apply an intercepted `/roles` command — list the EFFECTIVE role→provider/model map (the merged
   * persisted-override-over-default config) plus, per row, whether a key is present for that
   * provider (BOOLEAN ONLY — never a key value; claude-cli rows show key n/a). NOT forwarded.
   */
  private async handleRolesCommand(): Promise<void> {
    this.logger.info('/roles listing requested');
    await this.ackToOperator(rolesListMessage(this.effectiveRoleRows()));
  }

  /**
   * THE SOLE WRITER of the role-routing store (P1). Validates + records `role → {provider, model?}`
   * and returns the effective model + the provider's key-presence boolean. Called by BOTH the typed
   * `/setrole` handler AND the public {@link setRoleRouting} (the orchestrator-on-user-request path),
   * so every routing write goes through ONE place. Pure-local (FS only); never throws (errors are
   * returned). When no store is wired this is a no-op error (defensive — callers gate on the store).
   */
  private applyRoleRouting(
    role: Role,
    provider: ProviderId,
    model?: string,
  ): { ok: true; model: string; keyPresent: boolean } | { ok: false; error: string } {
    const store = this.roleRoutingStore;
    if (!store) return { ok: false, error: 'role routing is not enabled' };
    try {
      const stored = store.setRole(role, provider, model);
      // The effective model shown to the user: the explicit one, else the provider's default.
      const effModel = stored.model ?? getProvider(provider, this.providers).defaultModel;
      const secretEnvVar = getProvider(provider, this.providers).secretEnvVar;
      const keyPresent = this.secretStore ? this.secretStore.has(secretEnvVar) : false;
      this.logger.info('role routing override written', { role, provider, model: effModel, keyPresent });
      this.publishLifecycle('role_routing_changed', { role, provider, model: effModel });
      return { ok: true, model: effModel, keyPresent };
    } catch (err) {
      this.logger.warn('role routing write failed', { role, provider, err: String(err) });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * ORCHESTRATOR-INVOKABLE Tier-2 control: set a role's provider/model on the user's natural-language
   * request ("use Gemini for coding"). Routes through the SAME sole writer ({@link applyRoleRouting})
   * as the typed `/setrole`, so the supervisor stays the SOLE WRITER of the routing store. Accepts a
   * provider token (canonical id OR alias, case-insensitive) + a role token; validates both and
   * returns a structured result the orchestrator can relay (no throw). Returns `enabled:false` when
   * no routing store is wired (dormant default) so the orchestrator can tell the user it's inactive.
   */
  setRoleRouting(
    roleToken: string,
    providerToken: string,
    model?: string,
  ):
    | { ok: true; role: Role; provider: ProviderId; model: string; keyPresent: boolean }
    | { ok: false; enabled: boolean; error: string } {
    if (!this.roleRoutingStore) {
      return { ok: false, enabled: false, error: 'role routing is not enabled (no routing store wired)' };
    }
    const roleNorm = (roleToken ?? '').trim().toLowerCase();
    if (!isRole(roleNorm)) {
      return { ok: false, enabled: true, error: `unknown role "${roleToken}" (known: ${ROLES.join(', ')})` };
    }
    const providerId = resolveProviderId(providerToken ?? '', this.providers);
    if (!providerId) {
      return {
        ok: false,
        enabled: true,
        error: `unknown provider "${providerToken}" (known: ${PROVIDER_IDS.join(', ')})`,
      };
    }
    const result = this.applyRoleRouting(roleNorm, providerId, model);
    if (!result.ok) return { ok: false, enabled: true, error: result.error };
    return { ok: true, role: roleNorm, provider: providerId, model: result.model, keyPresent: result.keyPresent };
  }

  /**
   * Build the `/roles` rows: the EFFECTIVE role routing = the persisted overrides merged over the
   * in-code DEFAULT_ROLE_ROUTING_CONFIG, resolved per role via the router's pure
   * {@link resolveRoleBackendWithOverrides}. For each role: the effective provider label ('claude'
   * for claude-cli, else the provider id), the effective model, whether it is an override vs the
   * default, and whether a key is present for that provider (boolean; null for claude-cli). NEVER
   * surfaces a key value — only `secretStore.has()` booleans. Also used by the panel.
   */
  effectiveRoleRows(): RolesListRow[] {
    const overrides = this.roleRoutingStore ? this.roleRoutingStore.loadAll() : {};
    const rows: RolesListRow[] = [];
    for (const role of ROLES) {
      const sel = resolveRoleBackendWithOverrides(role, overrides, DEFAULT_ROLE_ROUTING_CONFIG);
      const overridden = overrides[role] !== undefined;
      if (sel.backend === 'claude-cli') {
        rows.push({
          role,
          provider: 'claude',
          model: sel.model ?? '(default)',
          overridden,
          keyPresent: null, // claude-cli needs no provider key
        });
        continue;
      }
      // api-adapter backend → the chosen provider. Prefer the override's provider id (exact), else
      // map the selection's model back to a provider via the default config's provider for the role.
      const ov: RoleRoutingOverride | undefined = overrides[role];
      const providerId: ProviderId | undefined = ov?.provider ?? this.defaultProviderForRole(role);
      const provider = providerId ? getProvider(providerId, this.providers) : undefined;
      const effModel = sel.model ?? provider?.defaultModel ?? '(default)';
      const keyPresent =
        provider && this.secretStore ? this.secretStore.has(provider.secretEnvVar) : false;
      rows.push({
        role,
        provider: providerId ?? 'api-adapter',
        model: effModel,
        overridden,
        keyPresent,
      });
    }
    return rows;
  }

  /**
   * The default provider id for a role per the in-code DEFAULT_ROLE_ROUTING_CONFIG, mapped from the
   * default entry's model id back to the registry provider whose defaultModel matches it (coding→
   * deepseek, reviewing→openai). Returns undefined for a role whose default is claude-cli / has no
   * matching provider. Pure helper for {@link effectiveRoleRows}'s non-override rows.
   */
  private defaultProviderForRole(role: Role): ProviderId | undefined {
    const entry = DEFAULT_ROLE_ROUTING_CONFIG.roles?.[role];
    if (!entry || entry.backend !== 'api-adapter') return undefined;
    const model = entry.model;
    for (const id of PROVIDER_IDS) {
      if (getProvider(id, this.providers).defaultModel === model) return id;
    }
    return undefined;
  }

  /** Self-context-clean: end the hosted session + start a fresh one (the `/clear` equivalent). */
  async clearContext(): Promise<void> {
    await this.lifecycle.clearContext();
  }

  /**
   * ★M-2 — INVOLUNTARY restart (D4 tier-b: the orchestrator went unresponsive). Same
   * end→fresh-start as clearContext BUT routes through restartFresh() so the `restarts`
   * counter INCREMENTS — an involuntary restart must be visible in /api/session, exactly
   * like an agent-requested one (clearContext zeroes the counter, hiding it). The fresh
   * session re-bootstraps the role via the lifecycle's bootstrapTurns (non-resume start);
   * we also re-arm the role prefix for the first inbound for parity with the other paths.
   */
  async restartUnresponsive(): Promise<void> {
    this.rolePrefixPending = !!this.opts.roleTurnPrefix;
    this.clearPingTimer(); // drop any armed liveness deadline; the fresh session re-arms via the scheduler
    await this.lifecycle.restartFresh();
    this.publishLifecycle('lifecycle_restart_unresponsive', { restarts: this.lifecycle.health().restarts });
  }

  /** Pending permission asks awaiting a decision (for the operator panel). */
  pendingPermissions(): { code: string; toolName: string }[] {
    return this.channelPermission?.pendingAsks() ?? [];
  }

  /**
   * OPERATOR-GRADE PANEL: approve/deny a pending permission by CLICK (in addition
   * to the Telegram reply). Returns true if it resolved a pending ask. With no
   * `code` and exactly one pending, the single one is resolved (bare).
   */
  operatorDecide(verdict: 'allow' | 'deny', code?: string): boolean {
    if (!this.channelPermission) return false;
    if (code) return this.channelPermission.submitReply(code, verdict);
    return this.channelPermission.submitBareReply(verdict);
  }

  /**
   * D4 LIVENESS BELT. Called on each mid-turn activity (via the lifecycle's onProgress).
   * Its ONLY job now is to clear any pending liveness-ping deadline — mid-turn activity
   * proves the orchestrator is alive (covers the race where a ping armed an instant before
   * a real turn began producing output). The user-facing "still working…" heartbeat that
   * used to live here was REMOVED (2026-06-18 — it flooded the channel + fired while idle).
   */
  private async onMidTurnProgress(): Promise<void> {
    // ★ The user-facing "⏳ still working…" heartbeat was REMOVED (2026-06-18): it flooded
    // the channel + fired even while idle (misleading). This handler is now PURELY the D4
    // liveness BELT: mid-turn activity PROVES the orchestrator is alive → clear any pending
    // liveness-ping deadline (covers the race where a ping armed an instant before a real
    // turn began producing output). No message is sent to the user.
    this.clearPingTimer();
  }

  /**
   * D4 — LIVENESS PING (IDLE-AWARE). Inject a reserved supervisor→orchestrator ping turn
   * and ARM a response deadline — but ONLY when the orchestrator is IDLE (no turn in
   * flight). A busy/long turn or a turn blocked on a sub-agent has a turn in flight →
   * we SKIP the ping (it's demonstrably working), so a progressing orchestrator is NEVER
   * false-restarted. When idle: the ping queues, the orchestrator answers, and ANY turn
   * result clears the deadline (onResult) → alive (tier-a). Mid-turn PROGRESS also clears
   * it (maybeProgressPing) as a belt. If the deadline fires first → HUNG → tier-b
   * (onUnresponsive). The "wedged mid-turn" case (a turn that never completes) is covered
   * by the passive turn-timeout watchdog, NOT by this ping. Returns true if a ping was
   * armed; false if disabled / no operator / a turn is in flight (skipped).
   */
  async pingLiveness(): Promise<boolean> {
    const timeout = this.opts.pingResponseTimeoutMs ?? 0;
    if (timeout <= 0) return false; // disabled
    if (!this.operator) return false; // no one to be responsive to yet
    if (!this.lifecycle.isIdle()) {
      // A turn is in flight → the orchestrator is provably working. Do NOT ping (and
      // do NOT arm a deadline) — that is exactly the false-restart we must avoid.
      this.logger.info('liveness ping SKIPPED — a turn is in flight (orchestrator is working)');
      return false;
    }
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      this.logger.error('liveness ping TIMED OUT — orchestrator unresponsive (tier-b)', { timeoutMs: timeout });
      void this.opts.onUnresponsive?.(`no turn result within ${timeout}ms of the liveness ping (orchestrator idle but unresponsive)`);
    }, timeout);
    if (typeof this.pingTimer === 'object' && 'unref' in this.pingTimer) {
      (this.pingTimer as { unref: () => void }).unref();
    }
    // The ping turn is HANDLED (not user text) + INTERNAL — the ping AND the orchestrator's
    // pong are NOT forwarded to the user (no liveness chatter on the channel); the
    // supervisor only reads the pong (onInternalResult → clearPingTimer) for hung-detection.
    this.logger.info('liveness ping injected (internal)', { timeoutMs: timeout });
    try {
      await this.lifecycle.sendUserTurn(
        {
          text: '[SUPERVISOR ping] Internal liveness check — reply with a single short line (e.g. "alive"). This exchange is NOT shown to the user; just confirm you are responsive.',
        },
        { internal: true },
      );
    } catch (err) {
      // ★ M2 — sendUserTurn THROWS if the session isn't running (e.g. the transient
      // clearContext/restart window). The ping never reached the orchestrator, so the
      // armed deadline would FALSE-fire tier-b. Clear it and bail — the next scheduler
      // tick re-pings once the session is back. (Not a hang; a normal restart race.)
      this.clearPingTimer();
      this.logger.warn('liveness ping send failed (session restarting?) — deadline cleared, will retry', { err: String(err) });
      return false;
    }
    return true;
  }

  /**
   * D4 — start the periodic liveness scheduler. Every `pingIntervalMs`, fire an
   * idle-aware `pingLiveness()` (a no-op while a turn is in flight). Off if the interval
   * or the response-timeout is unset. Idempotent. Started by `start()`.
   */
  startLivenessScheduler(): void {
    const interval = this.opts.pingIntervalMs ?? 0;
    if (interval <= 0 || (this.opts.pingResponseTimeoutMs ?? 0) <= 0) return; // disabled
    if (this.pingScheduler) return; // already running
    this.pingScheduler = setInterval(() => void this.pingLiveness().catch(() => undefined), interval);
    if (typeof this.pingScheduler === 'object' && 'unref' in this.pingScheduler) {
      (this.pingScheduler as { unref: () => void }).unref();
    }
    this.logger.info('liveness scheduler started', { intervalMs: interval, responseTimeoutMs: this.opts.pingResponseTimeoutMs });
  }

  /** D4 — stop the periodic liveness scheduler + any pending ping deadline. */
  private stopLivenessScheduler(): void {
    if (this.pingScheduler) {
      clearInterval(this.pingScheduler);
      this.pingScheduler = null;
    }
    this.clearPingTimer();
  }

  /** D4: clear the pending liveness-ping deadline (the orchestrator answered / teardown). */
  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * LIFECYCLE-RESTART CONTROL (the hosted agent requests its OWN full restart; the
   * supervisor confirms with the user + executes — authority split). Returns IMMEDIATELY
   * with the queued/refused outcome; the confirm + teardown happen OUT-OF-BAND (the agent
   * may be mid-turn and must NOT assume a synchronous restart). On the user's approval the
   * agent context is fully reset (new sessionId, no resume, restarts++), the CHANNEL is
   * preserved (the conversation survives), and an optional handoff note is injected into the
   * fresh session's first turn. Guardrails: rate-limit (loop killer) + user-confirm ALWAYS.
   */
  requestRestart(reason: string, handoffNote?: string): RestartRequestOutcome {
    const now = Date.now();
    // Rate-limit: drop expired timestamps, then enforce the window cap.
    this.restartRequestTimes = this.restartRequestTimes.filter((t) => now - t < RESTART_RATE_WINDOW_MS);
    if (this.restartRequestTimes.length >= RESTART_RATE_LIMIT) {
      const oldest = this.restartRequestTimes[0]!;
      const retryAfterMs = RESTART_RATE_WINDOW_MS - (now - oldest);
      this.logger.warn('lifecycle restart REFUSED — rate limit', { reason, count: this.restartRequestTimes.length, retryAfterMs });
      this.publishLifecycle('lifecycle_restart_denied', { reason, cause: 'rate_limited', retryAfterMs });
      // Surface the loop to the user (the agent is misbehaving).
      if (this.operator) {
        void this.opts
          .send(this.operator, {
            text: `⚠️ The hosted agent is requesting restarts too frequently (≥${RESTART_RATE_LIMIT} in ${Math.round(RESTART_RATE_WINDOW_MS / 60000)} min) — refusing (possible loop). Reason given: "${reason}".`,
          })
          .catch(() => undefined);
      }
      return { status: 'rate_limited', retryAfterMs };
    }
    if (this.restartConfirmInFlight) {
      this.logger.info('lifecycle restart request ignored — a confirm is already in flight');
      return { status: 'busy' };
    }
    this.restartRequestTimes.push(now);
    this.publishLifecycle('lifecycle_restart_requested', { reason, hasHandoff: !!handoffNote });
    this.logger.info('lifecycle restart REQUESTED by the agent', { reason, hasHandoff: !!handoffNote });
    // Run the confirm + teardown OUT-OF-BAND (don't block the caller / the agent's turn).
    void this.runRestartConfirm(reason, handoffNote);
    return { status: 'queued' };
  }

  /** Out-of-band: confirm the restart with the user, then execute (or notify the agent of denial). */
  private async runRestartConfirm(reason: string, handoffNote?: string): Promise<void> {
    this.restartConfirmInFlight = true;
    try {
      if (!this.channelPermission || !this.operator) {
        this.logger.warn('lifecycle restart: no operator to confirm with — denying (safe)');
        this.publishLifecycle('lifecycle_restart_denied', { reason, cause: 'no_operator' });
        return;
      }
      // Context line so the user understands the prompt that follows (the approve/deny prompt
      // reuses the familiar destructive-op routing — action 'lifecycle.restart').
      await this.opts
        .send(this.operator, {
          text: `🔄 The hosted agent requests a FULL RESTART (this RESETS its context — conversation continues, but it forgets the current session). Reason: "${reason}".`,
        })
        .catch(() => undefined);
      const verdict = await this.channelPermission.askUser({ toolName: 'lifecycle.restart', input: { reason } });
      if (verdict !== 'allow') {
        this.logger.info('lifecycle restart DENIED', { reason, verdict });
        this.publishLifecycle('lifecycle_restart_denied', { reason, cause: verdict });
        // Notify the AGENT it was denied (a follow-up turn — it continues unchanged).
        await this.lifecycle
          .sendUserTurn({
            text: `[SUPERVISOR lifecycle] Your restart request was ${verdict === 'timeout' ? 'NOT approved in time (default deny)' : 'DENIED by the user'}. Continue as normal.`,
          })
          .catch(() => undefined);
        return;
      }
      // APPROVED → execute the restart.
      this.publishLifecycle('lifecycle_restart_approved', { reason });
      this.logger.info('lifecycle restart APPROVED — executing', { reason });
      this.clearPingTimer(); // teardown any pending liveness deadline
      // Re-arm the role bootstrap so the fresh session re-loads /orchestrator on its first turn.
      this.rolePrefixPending = !!this.opts.roleTurnPrefix;
      await this.lifecycle.restartFresh();
      // Handoff: inject the fresh session's FIRST turn (role prefix + the restart context + note).
      // (Done here, not waiting for a user message, so the agent re-establishes itself immediately.)
      const prefix = this.rolePrefixPending && this.opts.roleTurnPrefix ? `${this.opts.roleTurnPrefix}\n\n` : '';
      this.rolePrefixPending = false; // consumed by this synthetic first turn
      const handoff =
        `[SUPERVISOR lifecycle] You restarted at your own request (context reset; the channel is preserved). Reason: "${reason}".` +
        (handoffNote ? `\nPrior context / handoff note:\n${handoffNote}` : '\nNo handoff note was provided — start clean.');
      this.lastSentText = null;
      await this.lifecycle.sendUserTurn({ text: prefix + handoff }).catch((err) => {
        this.logger.warn('lifecycle restart: handoff-turn injection failed (non-fatal)', { err: String(err) });
      });
      this.publishLifecycle('lifecycle_restart_completed', { reason, sessionId: this.lifecycle.health().sessionId, restarts: this.lifecycle.health().restarts });
      this.logger.info('lifecycle restart COMPLETED', { restarts: this.lifecycle.health().restarts });
      // Tell the user the restart happened (a meaningful, non-routine notice).
      if (this.operator) {
        await this.opts.send(this.operator, { text: '✅ The hosted agent has been restarted (context reset). The conversation continues.' }).catch(() => undefined);
      }
    } finally {
      this.restartConfirmInFlight = false;
    }
  }

  /** Publish a lifecycle-restart audit signal onto the bus (captured + controller-bridged). */
  private publishLifecycle(event: string, fields: Record<string, unknown>): void {
    this.opts.bus.publish({ direction: 'internal', type: 'lifecycle', source: 'supervisor', payload: { event, ...fields } });
  }

  /** Send text back to the current operator over the channel. */
  private async sendToOperator(text: string): Promise<void> {
    if (!this.operator) {
      this.logger.warn('session produced output but no operator to send to', {});
      return;
    }
    // SEND-SIDE IDEMPOTENCY GUARD (seq-221 #1): suppress a same-turn duplicate — text
    // byte-identical to what we last delivered for THIS turn (reset on each new user
    // turn). Catches a duplicate result event, the PTY render race re-grabbing the prior
    // turn's stale answer, and any other double-emit — independent of the render-side
    // fix. A legitimately-identical answer to a DIFFERENT user turn still goes through
    // (the guard was reset by handleInbound). Empty text is a no-op anyway (onResult
    // already skips it), so don't treat "" as a meaningful last-sent.
    if (text && text === this.lastSentText) {
      this.logger.warn('suppressed duplicate outbound (same-turn, byte-identical)', { chars: text.length });
      return;
    }
    // Log the outbound RESULT (ok + sentIds) so a forward to the channel is observable —
    // delivery confirmation, not just an attempt. (Without this, a successful send was
    // silent in the log, so we couldn't tell "delivered to the bot" from "never sent".)
    // ★ OUTPUT MODALITY: the orchestrator's substantive reply carries the current mode
    // (text/voice/dual) — the adapter renders TTS / sends the voice bubble accordingly.
    // (Control sends — prompts, acks, system notices — go via opts.send WITHOUT options,
    // so they stay text.) Empty text would be a no-op; the guard above already returned.
    const r = await this.opts.send(this.operator, { text, options: { modality: this.outputMode } });
    if (r.ok) {
      // Record as last-sent ONLY on success — a failed send must not poison the guard
      // (a legitimate retry of the same text would otherwise be suppressed).
      if (text) this.lastSentText = text;
      this.logger.info('outbound delivered to operator', { sentIds: r.sentIds, chars: text.length });
    } else {
      this.logger.error('outbound send FAILED', { error: r.error, chars: text.length });
      // ★ F1 — feed the DELIVERY FAILURE back into the session so the orchestrator KNOWS
      // its own message did not reach the user (it is otherwise blind to its outbound).
      // Inject as a follow-up turn (the driver queues it after the current turn). Success
      // is implicit (no note); only failures are surfaced, to avoid chatter.
      await this.feedDeliveryFailureToSession(r, text);
    }
  }

  /**
   * F1 — inject an out-of-band note telling the orchestrator its last reply did NOT
   * reach the user (with the error + a hint to /channel-check). Best-effort, guarded
   * two ways: (1) re-entrancy (the note's OWN send failure doesn't re-trigger), and
   * (2) ★M3 — an OUTAGE COOLDOWN: at most one notice per DELIVERY_FAILURE_COOLDOWN_MS,
   * so a sustained outage (note → orchestrator answers → answer-send fails → new note → …)
   * yields ONE notice, not one per turn. After the cooldown a fresh failure re-notifies.
   */
  private async feedDeliveryFailureToSession(result: OutboundResult, failedText: string): Promise<void> {
    if (this.feedingDeliveryFailure) return; // guard 1: don't loop on the note's own send
    const now = Date.now();
    if (now - this.lastDeliveryFailureNotifiedAt < DELIVERY_FAILURE_COOLDOWN_MS) {
      // guard 2 (M3): still inside the outage cooldown — log but do NOT inject another
      // note (avoids the per-turn cascade during a sustained channel outage).
      this.logger.warn('delivery failure within outage cooldown — note suppressed', { error: result.error });
      return;
    }
    this.lastDeliveryFailureNotifiedAt = now;
    this.feedingDeliveryFailure = true;
    try {
      const preview = failedText.replace(/\s+/g, ' ').trim().slice(0, 80);
      const note =
        `[SUPERVISOR delivery-status] Your last reply did NOT reach the user ` +
        `(error: ${result.error ?? 'unknown'}). Preview: "${preview}". ` +
        `The user did NOT see it. Run /channel-check semantics — inspect the panel ` +
        `(GET ${this.opts.panelUrl ?? 'the loopback panel'}/api/channel/state) and repair, ` +
        `then resend if appropriate.`;
      await this.lifecycle.sendUserTurn({ text: note });
    } catch (err) {
      this.logger.warn('delivery-failure feedback injection failed (non-fatal)', { err: String(err) });
    } finally {
      this.feedingDeliveryFailure = false;
    }
  }

  /** Health across lifecycle + router + pending permission asks. */
  health(): {
    started: boolean;
    lifecycle: ReturnType<LifecycleManager['health']>;
    permissions: ReturnType<PermissionRouter['getStats']>;
    pendingPermissionAsks: number;
  } {
    return {
      started: this.started,
      lifecycle: this.lifecycle.health(),
      permissions: this.router.getStats(),
      pendingPermissionAsks: this.channelPermission?.pendingCount ?? 0,
    };
  }

  /** Stop the hosted session. */
  async stop(): Promise<void> {
    this.stopLivenessScheduler();
    await this.lifecycle.stop();
    this.started = false;
  }

  /** Expose the router (for tests / status). */
  get permissionRouter(): PermissionRouter {
    return this.router;
  }
}
