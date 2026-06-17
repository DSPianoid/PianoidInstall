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

import type { InboundMessage, OutboundResult, ReplyHandle } from './contract.js';
import { ChannelPermission, type SendPrompt } from './channel-permission.js';
import { LifecycleManager } from './lifecycle.js';
import { PermissionRouter, type PermissionPolicy } from './permission-router.js';
import type { Logger } from './logger.js';
import type { IoBus } from './io-bus.js';
import type { SessionDriver } from './session-driver.js';

export interface SessionHostOptions {
  driver: SessionDriver;
  bus: IoBus;
  logger: Logger;
  /** Send an outbound over a channel (bound supervisor.sendOutbound for a channel). */
  send: (handle: ReplyHandle, msg: { text?: string }) => Promise<OutboundResult>;
  /** Permission policy (allow-list / deny-list / fallback / safety-floor predicate). */
  policy: PermissionPolicy;
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
   * #8 HEARTBEAT. When set (> 0), a long turn that stays silent for this many ms emits a
   * throttled "still working…" ping to the channel (driven by mid-turn activity), so the
   * user can tell working-from-hung during a heavy startup. At most one ping per interval;
   * none after the turn's result. 0 / omit = disabled (e.g. demo). Default disabled.
   */
  progressPingMs?: number;
  /** The "still working…" ping text (default a generic one). */
  progressPingText?: string;
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
  /** #8 heartbeat: wall-clock (ms) of the last progress ping (or turn start) — throttle anchor. */
  private lastProgressAt = 0;

  constructor(opts: SessionHostOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('session-host');
    this.rolePrefixPending = !!opts.roleTurnPrefix;

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
      onResult: (text) => (text ? this.sendToOperator(text) : Promise.resolve()),
      // #8 heartbeat: throttle mid-turn activity into an occasional "still working…" ping.
      onProgress: () => this.maybeProgressPing(),
    });
  }

  /** Start the hosted session (spawns/owns the subprocess via the lifecycle). */
  async start(): Promise<void> {
    if (this.started) return;
    await this.lifecycle.start();
    this.started = true;
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
        send: ((handle, text) => this.opts.send(handle, { text })) as SendPrompt,
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
    // #8 heartbeat: anchor the throttle at the turn start so the FIRST progress ping waits
    // a full interval (a fast turn finishes before then → no ping; the answer is enough).
    this.lastProgressAt = Date.now();
    await this.lifecycle.sendUserTurn({ text: turnText });
  };

  /** The currently-bound operator reply handle (null until the first inbound). */
  currentOperator(): ReplyHandle | null {
    return this.operator;
  }

  /** Self-context-clean: end the hosted session + start a fresh one (the `/clear` equivalent). */
  async clearContext(): Promise<void> {
    await this.lifecycle.clearContext();
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
   * #8 HEARTBEAT. Called on each mid-turn activity (via the lifecycle's onProgress). If
   * progress pings are enabled AND at least progressPingMs has elapsed since the last
   * ping (or the turn start), send ONE "still working…" ping to the operator. Throttled,
   * so a fast turn (finishes before the interval) never pings — only a genuinely long turn
   * shows life. NOT sent after the result (the lifecycle stops calling onProgress then).
   * Goes through opts.send DIRECTLY (not sendToOperator) so it's never deduped as a
   * "duplicate answer" and never becomes the lastSentText baseline.
   */
  private async maybeProgressPing(): Promise<void> {
    const interval = this.opts.progressPingMs ?? 0;
    if (interval <= 0 || !this.operator) return; // disabled / no operator
    const now = Date.now();
    if (now - this.lastProgressAt < interval) return; // throttled
    this.lastProgressAt = now;
    const text = this.opts.progressPingText ?? '⏳ still working…';
    const r = await this.opts.send(this.operator, { text });
    if (r.ok) this.logger.info('progress ping sent', { sentIds: r.sentIds });
    else this.logger.warn('progress ping send failed', { error: r.error });
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
    const r = await this.opts.send(this.operator, { text });
    if (r.ok) {
      // Record as last-sent ONLY on success — a failed send must not poison the guard
      // (a legitimate retry of the same text would otherwise be suppressed).
      if (text) this.lastSentText = text;
      this.logger.info('outbound delivered to operator', { sentIds: r.sentIds, chars: text.length });
    } else {
      this.logger.error('outbound send FAILED', { error: r.error, chars: text.length });
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
    await this.lifecycle.stop();
    this.started = false;
  }

  /** Expose the router (for tests / status). */
  get permissionRouter(): PermissionRouter {
    return this.router;
  }
}
