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
  /** The M1 system prompt (orchestrator role). */
  systemPrompt?: string;
  /** The permission router's decide fn. */
  onPermission: PermissionHandler;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  /** Max automatic restart attempts on unexpected stream end. Default 5. */
  maxRestarts?: number;
  /** Base backoff between restarts, ms. Default 1000 (capped at 15s). */
  restartBackoffMs?: number;
  /** Called after a result event with the final text (supervisor → outbound). */
  onResult?: (text: string, sessionId: string) => void | Promise<void>;
  /** Called for each assistant turn's text (supervisor → outbound). */
  onAssistant?: (text: string) => void | Promise<void>;
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
    const startOpts: SessionStartOptions = {
      systemPrompt: this.opts.systemPrompt,
      onPermission: this.opts.onPermission,
      cwd: this.opts.cwd,
      model: this.opts.model,
      allowedTools: this.opts.allowedTools,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
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
    switch (ev.kind) {
      case 'system_init':
        this.sessionId = ev.sessionId;
        this.publish('stream.system_init', { sessionId: ev.sessionId, model: ev.model, tools: ev.tools });
        this.logger.info('session init', { sessionId: ev.sessionId, model: ev.model });
        break;
      case 'assistant':
        this.publish('stream.assistant', { text: ev.text, toolUses: ev.toolUses });
        if (ev.text && this.opts.onAssistant) await this.opts.onAssistant(ev.text);
        break;
      case 'tool_result':
        this.publish('stream.tool_result', { toolUseId: ev.toolUseId, isError: ev.isError });
        break;
      case 'result':
        this.publish('stream.result', { sessionId: ev.sessionId, subtype: ev.subtype, costUsd: ev.costUsd });
        this.logger.info('session result', { subtype: ev.subtype, costUsd: ev.costUsd });
        if (this.opts.onResult) await this.opts.onResult(ev.result ?? '', ev.sessionId);
        break;
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
    await this.opts.driver.send(turn);
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
    await this.opts.driver.stop();
    if (this.runLoop) {
      await this.runLoop.catch(() => {});
      this.runLoop = null;
    }
    this.logger.info('lifecycle stopped', { sessionId: this.sessionId });
  }
}
