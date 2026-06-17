/**
 * The LIFECYCLE MANAGER — spawns and OWNS the headless Claude Code session, and
 * is the FI recovery owner (restart + resume) wired to the FO wait→wake.
 *
 * Responsibilities (proposal PART E Phase 2 deliverables 1, 3, 4):
 *  - Start the session via the SessionDriver with M1 as the system prompt;
 *    capture the session id from the first `system_init` event (for resume).
 *  - Consume the driver's normalized event stream and PUBLISH each event onto the
 *    I/O bus (→ capture + channel outbound) — the stream-json half of FC-3.
 *  - Inject user turns into the session (inbound → session).
 *  - Health/restart: if the event stream ends WITHOUT a clean stop (a crash /
 *    unexpected end), restart the driver with `resume: <sessionId>` so the
 *    session continues — the FI guarantee. A bounded backoff prevents a crash-
 *    loop; the FO "wake" is the next restart attempt.
 *
 * Concern (P2): own the session lifecycle + pump events to the bus. It does NOT
 * decide permissions (the router does) and does NOT format channel messages (the
 * supervisor maps result/assistant events to outbound).
 *
 * Authority (P1): the lifecycle manager is the sole owner of the SessionDriver
 * instance and the captured session id.
 *
 * It does NOT touch the production orchestrator — it owns its OWN driven session
 * (additive; the Phase-3 cut-over is separate).
 */

import type { IoBus } from './io-bus.js';
import type { Logger } from './logger.js';
import type {
  PermissionHandler,
  SessionDriver,
  SessionEvent,
  SessionStartOptions,
  UserTurn,
} from './session-driver.js';

export interface LifecycleOptions {
  driver: SessionDriver;
  bus: IoBus;
  logger: Logger;
  /** The system prompt — plain string (demo) or preset+append (orchestrator). */
  systemPrompt?: string | { preset: 'claude_code'; append?: string };
  /** The permission router's decide fn. */
  onPermission: PermissionHandler;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  /** Tools always denied at the SDK level (e.g. the telegram plugin). */
  disallowedTools?: string[];
  /** Settings sources (project skills + CLAUDE.md + settings). */
  settingSources?: ('user' | 'project' | 'local')[];
  /** MCP servers wired into the session. */
  mcpServers?: Record<string, unknown>;
  /** Env for the spawned subprocess. */
  env?: Record<string, string | undefined>;
  /** SDK permission mode. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Synthetic first turns (e.g. ['/orchestrator']) — injected once on the initial start. */
  bootstrapTurns?: string[];
  /** Max automatic restart attempts on unexpected stream end. Default 5. */
  maxRestarts?: number;
  /** Base backoff between restarts, ms. Default 1000 (capped at 15s). */
  restartBackoffMs?: number;
  /** Called with the final answer text to auto-send to the channel (supervisor → outbound). */
  onResult?: (text: string, sessionId: string) => void | Promise<void>;
  /** Called for each assistant turn's text (supervisor → outbound). Used by the DEMO profile. */
  onAssistant?: (text: string) => void | Promise<void>;
  /**
   * MID-TURN PROGRESS (#8 heartbeat). Called on each assistant/tool activity event WHILE
   * a turn is in flight (between sendUserTurn and the turn's result). The SessionHost
   * THROTTLES these into an occasional "still working…" ping to the channel, so a long
   * silent turn (e.g. the 3-4min heavy /orchestrator startup) shows life instead of
   * looking hung. NOT called after the result fires (the answer is the signal then).
   */
  onProgress?: (info: { kind: 'assistant' | 'tool_result'; toolName?: string }) => void | Promise<void>;
  /**
   * PER-TURN DE-DUP (orchestrator profile). When set to the channel reply tool
   * name (e.g. 'mcp__supervisor_channel__reply'), the lifecycle tracks whether
   * that tool fired during the current turn:
   *  - reply tool FIRED this turn → its output is the channel-out → SUPPRESS the
   *    auto-out of the final result text (avoid a double-send).
   *  - reply tool NOT fired → the session answered in plain text → AUTO-OUT the
   *    final result text via onResult (so the answer reaches the user).
   * When unset (demo profile), onAssistant auto-outs each assistant text as before.
   * (Live fix: a blanket suppress silenced plain-text answers; this gates per-turn.)
   */
  replyToolName?: string;
  /**
   * H2 HANG WATCHDOG. A per-turn deadline (ms): armed when a user turn is injected,
   * reset on any session activity (assistant/tool/result), fired if the session
   * goes silent for this long with a turn outstanding. 0 / omit = disabled.
   * Closes the Phase-2 H2 ticket (interrupt() now has a caller).
   */
  turnTimeoutMs?: number;
  /**
   * What to do when the watchdog fires:
   *  - 'surface' (default): publish a stall event + call onStall; leave the
   *    session alone (the operator decides). Least disruptive.
   *  - 'restart': interrupt() the wedged turn and let the run loop restart+resume
   *    (the FI path) — for an unattended deployment.
   */
  onStallAction?: 'surface' | 'restart';
  /** Called when the watchdog fires (operator surface; never receives secrets). */
  onStall?: (info: { sessionId?: string; silentMs: number; action: 'surface' | 'restart' }) => void | Promise<void>;
}

export class LifecycleManager {
  private readonly opts: LifecycleOptions;
  private readonly logger: Logger;
  private sessionId: string | undefined;
  private running = false;
  /** Set true by stop() so the consume loop knows the end was intentional. */
  private stopping = false;
  private restarts = 0;
  /** Resolves when the current run() loop has fully exited. */
  private runLoop: Promise<void> | null = null;
  /** H2 watchdog: the active per-turn deadline timer (null = disarmed). */
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** True while a user turn is outstanding (awaiting a result) — gates re-arming. */
  private turnInFlight = false;
  /** Per-turn de-dup: set when the channel reply tool fires this turn (→ suppress auto-out). */
  private replyToolFiredThisTurn = false;
  /**
   * #8 heartbeat: count of user turns INJECTED but not yet resolved (a result seen).
   * Gates onProgress so mid-turn activity drives a "still working…" ping but post-result
   * activity does not. A COUNTER (not a boolean) because turns can be QUEUED (#5): if
   * turn 2's sendUserTurn runs before turn 1's result, a boolean cleared on turn 1's
   * result would lose turn 2's heartbeat. With a counter, progress stays active while ANY
   * turn is outstanding (t1 send=1, t2 send=2, t1 result=1 [still active], t2 result=0).
   * (Independent of the watchdog's turnInFlight, which only tracks when the watchdog is on.)
   */
  private outstandingTurns = 0;

  constructor(opts: LifecycleOptions) {
    this.opts = opts;
    this.logger = opts.logger.child('lifecycle');
  }

  /** Start owning the session. Returns once the first start has been kicked off. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.restarts = 0;
    // Kick off the supervised run loop and return immediately. We do NOT block on
    // the first event: a real SDK session with a streaming-prompt input is IDLE
    // until the first user turn, so it emits no `system_init` until then — blocking
    // here would hang start() (and any sequenced startup after it, e.g. the panel).
    // `running` is set true synchronously above, so the session is "owned" the
    // instant start() returns; the sessionId arrives later via the event stream.
    this.runLoop = this.runWithRestarts();
  }

  /** The supervised run loop: consume events; restart+resume on unexpected end. */
  private async runWithRestarts(): Promise<void> {
    while (this.running && !this.stopping) {
      let endedCleanly = false;
      try {
        endedCleanly = await this.consumeOnce();
      } catch (err) {
        this.logger.warn('session stream errored', { err: String(err), sessionId: this.sessionId });
      }
      if (this.stopping || endedCleanly) break;

      // Unexpected end → restart + resume (FI).
      if (this.restarts >= (this.opts.maxRestarts ?? 5)) {
        this.logger.error('max restarts reached — giving up', { restarts: this.restarts });
        this.publish('lifecycle', { event: 'restart_exhausted', restarts: this.restarts });
        this.running = false;
        break;
      }
      this.restarts++;
      const delay = Math.min((this.opts.restartBackoffMs ?? 1000) * this.restarts, 15_000);
      this.publish('lifecycle', { event: 'restarting', attempt: this.restarts, resume: this.sessionId });
      this.logger.warn('restarting session (resume)', { attempt: this.restarts, sessionId: this.sessionId, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
      // loop → consumeOnce() will resume via this.sessionId
    }
    this.running = false;
  }

  /**
   * Start the driver once and consume its event stream to completion. Returns
   * true if the stream ended with a `result` (clean), false if it ran out
   * without a result (treated as a crash → caller restarts).
   */
  private async consumeOnce(): Promise<boolean> {
    const resuming = !!this.sessionId;
    const startOpts: SessionStartOptions = {
      systemPrompt: this.opts.systemPrompt,
      onPermission: this.opts.onPermission,
      cwd: this.opts.cwd,
      model: this.opts.model,
      allowedTools: this.opts.allowedTools,
      disallowedTools: this.opts.disallowedTools,
      settingSources: this.opts.settingSources,
      mcpServers: this.opts.mcpServers,
      env: this.opts.env,
      permissionMode: this.opts.permissionMode,
      // Inject role-bootstrap turns ONLY on the initial start — a resumed session
      // already adopted its role (re-injecting /orchestrator would double-run it).
      ...(resuming ? { resume: this.sessionId } : { bootstrapTurns: this.opts.bootstrapTurns }),
    };
    let sawResult = false;
    for await (const ev of this.opts.driver.start(startOpts)) {
      await this.handleEvent(ev);
      if (ev.kind === 'result') sawResult = true;
    }
    return sawResult;
  }

  /** Map a normalized session event to a bus event (+ supervisor callbacks). */
  private async handleEvent(ev: SessionEvent): Promise<void> {
    // H2 watchdog: ANY event proves the session is alive → reset the deadline.
    // 'result' ends the turn (disarm); other events re-arm while in flight.
    if (ev.kind === 'result') this.watchdogDisarm();
    else this.watchdogReset();
    switch (ev.kind) {
      case 'system_init':
        this.sessionId = ev.sessionId;
        this.publish('stream.system_init', {
          sessionId: ev.sessionId,
          model: ev.model,
          tools: ev.tools,
          slashCommands: ev.slashCommands,
          mcpServers: ev.mcpServers,
        });
        this.logger.info('session init', {
          sessionId: ev.sessionId,
          model: ev.model,
          toolCount: ev.tools?.length,
          mcpServers: ev.mcpServers,
          hasOrchestrator: ev.slashCommands?.some((c) => c.toLowerCase().includes('orchestrator')),
        });
        break;
      case 'assistant':
        this.publish('stream.assistant', { text: ev.text, toolUses: ev.toolUses });
        // Per-turn de-dup: note if the channel reply tool fired this turn.
        if (this.opts.replyToolName && ev.toolUses?.some((t) => t.name === this.opts.replyToolName)) {
          this.replyToolFiredThisTurn = true;
        }
        // #8 heartbeat: mid-turn activity → throttled progress ping (host decides cadence).
        if (this.outstandingTurns > 0 && this.opts.onProgress) {
          await this.opts.onProgress({ kind: 'assistant', toolName: ev.toolUses?.[0]?.name });
        }
        // DEMO profile (no replyToolName): auto-out each assistant text as before.
        if (!this.opts.replyToolName && ev.text && this.opts.onAssistant) await this.opts.onAssistant(ev.text);
        break;
      case 'tool_result':
        this.publish('stream.tool_result', { toolUseId: ev.toolUseId, isError: ev.isError });
        // #8 heartbeat: a tool finishing is mid-turn activity too.
        if (this.outstandingTurns > 0 && this.opts.onProgress) await this.opts.onProgress({ kind: 'tool_result' });
        break;
      case 'result':
        if (this.outstandingTurns > 0) this.outstandingTurns -= 1; // #8: one turn resolved (others may still be outstanding)
        this.publish('stream.result', { sessionId: ev.sessionId, subtype: ev.subtype, costUsd: ev.costUsd });
        this.logger.info('session result', { subtype: ev.subtype, costUsd: ev.costUsd });
        // ORCHESTRATOR profile (replyToolName set): auto-out the final answer text
        // UNLESS the reply tool already sent it this turn (per-turn de-dup — the
        // live fix for plain-text answers being silenced by a blanket suppress).
        // DEMO profile (no replyToolName): onResult auto-outs the final text too.
        if (this.opts.onResult) {
          const suppress = !!this.opts.replyToolName && this.replyToolFiredThisTurn;
          if (!suppress) await this.opts.onResult(ev.result ?? '', ev.sessionId);
        }
        break;
    }
  }

  // ── H2 hang watchdog ──────────────────────────────────────────────────────
  /** Arm the per-turn deadline (called when a user turn is injected). */
  private watchdogArm(): void {
    const ms = this.opts.turnTimeoutMs ?? 0;
    if (ms <= 0) return; // disabled
    this.turnInFlight = true;
    this.watchdogClear();
    this.watchdog = setTimeout(() => void this.watchdogFire(ms), ms);
    if (typeof this.watchdog === 'object' && 'unref' in this.watchdog) {
      (this.watchdog as { unref: () => void }).unref(); // never keep the process alive on its own
    }
  }

  /** Reset the deadline on session activity (re-arm only while a turn is in flight). */
  private watchdogReset(): void {
    if (!this.turnInFlight) return;
    this.watchdogArm();
  }

  /** Disarm at end of turn (a `result` arrived) or on stop. */
  private watchdogDisarm(): void {
    this.turnInFlight = false;
    this.watchdogClear();
  }

  private watchdogClear(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  /** The deadline elapsed with a turn outstanding → the session is wedged. */
  private async watchdogFire(silentMs: number): Promise<void> {
    if (!this.turnInFlight || this.stopping) return;
    const action = this.opts.onStallAction ?? 'surface';
    this.turnInFlight = false; // one-shot; don't loop on the same wedge
    this.publish('lifecycle', { event: 'stall', silentMs, action, sessionId: this.sessionId });
    this.logger.warn('hang watchdog fired — session silent with a turn outstanding', { silentMs, action, sessionId: this.sessionId });
    try {
      if (this.opts.onStall) await this.opts.onStall({ sessionId: this.sessionId, silentMs, action });
    } catch (err) {
      this.logger.warn('onStall callback threw', { err: String(err) });
    }
    if (action === 'restart') {
      // Interrupt the wedged turn; the stream then ends without a clean result →
      // runWithRestarts() restarts + resumes (the FI path). This is the first
      // caller of interrupt() (closes the H2 ticket).
      try {
        await this.opts.driver.interrupt();
      } catch (err) {
        this.logger.warn('interrupt() during stall failed', { err: String(err) });
      }
    }
  }

  /** Publish a stream/lifecycle event onto the bus (captured + observable). */
  private publish(type: string, payload: unknown): void {
    this.opts.bus.publish({
      // M3 — direction is relative to the hosted session. Session OUTPUT
      // (assistant text, tool results, the final result) flows OUT toward the
      // channel = 'outbound'. system_init and lifecycle events are session/
      // supervisor bookkeeping, not user-facing content = 'internal'. (Previously
      // every stream.* was mislabeled 'inbound', i.e. as if the session were
      // RECEIVING its own output — which inverted the capture's direction column.)
      direction: this.directionFor(type),
      type,
      source: 'session',
      payload,
    });
  }

  /** Map a published event type to its bus direction (relative to the session). */
  private directionFor(type: string): 'inbound' | 'outbound' | 'internal' {
    switch (type) {
      case 'stream.assistant':
      case 'stream.tool_result':
      case 'stream.result':
        return 'outbound'; // session-produced content heading to the channel
      case 'stream.system_init':
      case 'lifecycle':
      default:
        return 'internal'; // session/supervisor bookkeeping
    }
  }

  /** Inject a user turn into the running session (inbound → session). */
  async sendUserTurn(turn: UserTurn): Promise<void> {
    if (!this.running) throw new Error('lifecycle: no running session to send to');
    this.replyToolFiredThisTurn = false; // per-turn de-dup: reset for the new turn
    this.outstandingTurns += 1; // #8: a turn is now outstanding → mid-turn activity pings (counter handles queued turns)
    await this.opts.driver.send(turn);
    this.watchdogArm(); // H2: start the per-turn deadline (no-op if disabled)
  }

  /**
   * SELF-CONTEXT-CLEAN (the supervisor's `/clear` equivalent). The SDK has no
   * in-session compact API, so the documented pattern is END the current session
   * and START A FRESH one. We tear down the current run (no resume → a brand-new
   * context), DROP the captured session id, then re-start: the new run goes
   * through `consumeOnce()` with NO resume, so it re-injects the role bootstrap
   * (e.g. /orchestrator). Returns once the fresh run loop is kicked off.
   *
   * No keystroke synthesis (the Phase-3 mandate) — a programmatic stop+restart.
   */
  async clearContext(): Promise<void> {
    if (!this.running && !this.runLoop) return;
    this.publish('lifecycle', { event: 'context_clean', priorSessionId: this.sessionId });
    this.logger.info('self-context-clean: ending session + starting fresh', { priorSessionId: this.sessionId });
    // Tear down the current run loop (intentional stop — no restart).
    this.stopping = true;
    this.running = false;
    this.watchdogDisarm();
    await this.opts.driver.stop();
    if (this.runLoop) {
      await this.runLoop.catch(() => {});
      this.runLoop = null;
    }
    // Forget the session id so the next run starts FRESH (no resume → clean context).
    this.sessionId = undefined;
    this.restarts = 0;
    this.outstandingTurns = 0; // #8: fresh context → no turns outstanding
    // Re-start: running set synchronously; the fresh run re-bootstraps the role.
    this.running = true;
    this.stopping = false;
    this.runLoop = this.runWithRestarts();
  }

  /** Health snapshot (merges manager + driver state). */
  health(): { running: boolean; sessionId?: string; restarts: number; driver: ReturnType<SessionDriver['health']> } {
    return {
      running: this.running,
      sessionId: this.sessionId,
      restarts: this.restarts,
      driver: this.opts.driver.health(),
    };
  }

  /** Stop owning the session (clean shutdown — no restart). */
  async stop(): Promise<void> {
    if (!this.running && !this.runLoop) return;
    this.stopping = true;
    this.running = false;
    this.outstandingTurns = 0; // #8: stopping → no turns outstanding
    this.watchdogDisarm(); // H2: cancel any pending deadline
    await this.opts.driver.stop();
    if (this.runLoop) {
      await this.runLoop.catch(() => {});
      this.runLoop = null;
    }
    this.logger.info('lifecycle stopped', { sessionId: this.sessionId });
  }
}
