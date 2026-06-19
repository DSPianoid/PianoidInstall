/**
 * The SUPERVISOR — the process scaffold + captured I/O-bus structure.
 *
 * Phase-1 scope (the additive, zero-disruption shell): it owns the I/O bus, the
 * channel-adapter registry, and the capture store, and wires them together —
 * inbound from any adapter is published to the bus (and thereby captured), and
 * the supervisor can route an outbound back through the originating adapter.
 *
 * It does NOT yet own the Claude Code subprocess — that is Phase 2 (the
 * lifecycle manager spawns the headless child via the Agent SDK and routes
 * `canUseTool` over the channel). This class is the shell those later phases
 * plug into: the bus, capture, and adapter registry are exactly the seams
 * Phase 2/3 attach the SESSION SUPERVISOR + permission router to.
 *
 * Concern (P2): lifecycle/orchestration of bus + adapters + capture. No
 * transport logic (adapters), no interpretation (M1, hosted in the child later).
 * Authority (P1): the supervisor is the sole owner of the adapter registry map.
 *
 * Traces: proposal PART B.1 (the SUPERVISOR box), PART B.2 (component borders),
 * PART E Phase 1 deliverable 1 ("Supervisor skeleton … the I/O bus abstraction,
 * graceful start/stop") + the note that it does NOT own the subprocess yet.
 */

import type {
  AdapterHealth,
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
  ReplyHandle,
} from './contract.js';
import { CaptureStore } from './capture-store.js';
import { IoBus, type BusEvent } from './io-bus.js';
import { Logger } from './logger.js';

/** A hook the host (Phase 2: the session) registers to react to inbound. */
export type SupervisorInboundHook = (msg: InboundMessage) => void | Promise<void>;

/** Health snapshot across the supervisor and its adapters. */
export interface SupervisorHealth {
  /** True once start() has run and not yet stop()'d. */
  started: boolean;
  /** Count of events the capture store has persisted this session. */
  capturedEvents: number;
  /** Per-adapter health. */
  adapters: AdapterHealth[];
}

export interface SupervisorOptions {
  /** Capture-store NDJSON path. */
  captureFile: string;
  /** Logger (a child is taken per subsystem). */
  logger: Logger;
  /**
   * Retained for API compatibility. The capture store now ALWAYS writes
   * synchronously (so `replay()` is live — review H1), so this flag no longer
   * changes behavior; it is threaded through for callers that still set it.
   */
  unbufferedCapture?: boolean;
}

export class Supervisor {
  readonly bus = new IoBus();
  private readonly capture: CaptureStore;
  private readonly logger: Logger;
  private readonly adapters = new Map<string, ChannelAdapter>();
  private inboundHook: SupervisorInboundHook | null = null;
  private started = false;

  constructor(opts: SupervisorOptions) {
    this.logger = opts.logger.child('supervisor');
    this.capture = new CaptureStore({
      filePath: opts.captureFile,
      buffered: !opts.unbufferedCapture,
    });
    // Surface faulty bus subscribers in the log rather than silently swallowing.
    this.bus.onSubscriberError((err, event) =>
      this.logger.warn('bus subscriber error', { err: String(err), seq: event.seq }),
    );
  }

  /**
   * Register an adapter under its channel name. The supervisor owns the registry
   * (P1) — adapters never self-register elsewhere. Throws on a duplicate channel.
   */
  register(adapter: ChannelAdapter): this {
    if (this.adapters.has(adapter.channel)) {
      throw new Error(`adapter already registered for channel '${adapter.channel}'`);
    }
    this.adapters.set(adapter.channel, adapter);
    this.logger.info('adapter registered', { channel: adapter.channel });
    return this;
  }

  /** Register the host inbound hook (Phase 2: the session consumes this). */
  onInbound(hook: SupervisorInboundHook): this {
    this.inboundHook = hook;
    return this;
  }

  /**
   * Start: attach capture to the bus, then start every adapter wired so its
   * inbound is published to the bus (captured) AND forwarded to the host hook.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.capture.attach(this.bus);
    this.bus.publish({
      direction: 'internal',
      type: 'lifecycle',
      source: 'supervisor',
      payload: { event: 'start', adapters: [...this.adapters.keys()] },
    });

    for (const adapter of this.adapters.values()) {
      await adapter.start((msg) => this.handleInbound(adapter.channel, msg));
      this.logger.info('adapter started', { ...adapter.health() });
    }
    this.started = true;
  }

  /** Publish an inbound to the bus (captured) and forward to the host hook. */
  private async handleInbound(channel: string, msg: InboundMessage): Promise<void> {
    const enriched: InboundMessage = { ...msg, channel: msg.channel ?? channel };
    this.bus.publish({
      direction: 'inbound',
      type: 'channel.inbound',
      source: channel,
      payload: enriched,
    });
    if (this.inboundHook) {
      // Let the hook throw to signal "not handled" — the adapter's queue will
      // then leave the item un-acked for replay (the durable-delivery contract).
      await this.inboundHook(enriched);
    }
  }

  /**
   * Send an outbound through the adapter for `channel`, publishing the send to
   * the bus (captured) for observability.
   */
  async sendOutbound(
    channel: string,
    handle: ReplyHandle,
    msg: OutboundMessage,
  ): Promise<OutboundResult> {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      return { ok: false, sentIds: [], error: `no adapter for channel '${channel}'` };
    }
    const result = await adapter.outbound(handle, msg);
    this.bus.publish({
      direction: 'outbound',
      type: 'channel.outbound',
      source: channel,
      payload: { handle, msg, result },
    });
    return result;
  }

  /** Health snapshot across all adapters. */
  health(): SupervisorHealth {
    return {
      started: this.started,
      capturedEvents: this.capture.writtenCount,
      adapters: [...this.adapters.values()].map((a) => a.health()),
    };
  }

  /** Access the capture store (for the panel / replay). */
  get captureStore(): CaptureStore {
    return this.capture;
  }

  /** Registered adapters (read-only view). */
  get registeredChannels(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * CHANNEL STATE (D2) — a focused snapshot for the orchestrator's self-check:
   * per-adapter health + the recent outbound delivery results from the capture stream
   * + the supervisor PID. Read-only; the orchestrator curls this via the panel.
   */
  channelState(recentN = 20): {
    pid: number;
    adapters: AdapterHealth[];
    recentDeliveries: { ts?: string; channel: string; ok: boolean; sentIds?: string[]; error?: string }[];
  } {
    const recentDeliveries: { ts?: string; channel: string; ok: boolean; sentIds?: string[]; error?: string }[] = [];
    for (const r of this.capture.replay()) {
      const e = ((r as { event?: BusEvent }).event ?? r) as BusEvent;
      if (e && e.type === 'channel.outbound') {
        const p = e.payload as { result?: OutboundResult };
        if (p.result) {
          recentDeliveries.push({
            ts: e.ts,
            channel: e.source,
            ok: p.result.ok,
            sentIds: p.result.sentIds,
            error: p.result.error,
          });
        }
      }
    }
    return {
      pid: process.pid,
      adapters: [...this.adapters.values()].map((a) => a.health()),
      recentDeliveries: recentDeliveries.slice(-recentN),
    };
  }

  /**
   * CHANNEL REPAIR (D2) — reconnect an adapter's transport (re-acquire the poller).
   * Re-supplies the SAME inbound publish+hook path. Returns ok/error.
   */
  async reconnectChannel(channel: string): Promise<{ ok: boolean; error?: string }> {
    const adapter = this.adapters.get(channel);
    if (!adapter) return { ok: false, error: `no adapter for channel '${channel}'` };
    if (!adapter.reconnect) return { ok: false, error: `adapter '${channel}' does not support reconnect` };
    try {
      await adapter.reconnect((msg) => this.handleInbound(adapter.channel, msg));
      this.logger.info('channel reconnected', { ...adapter.health() });
      return { ok: true };
    } catch (err) {
      this.logger.error('channel reconnect failed', { channel, err: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  /**
   * CHANNEL REPAIR (D2) — drop an adapter's un-acked INBOUND inbox-queue items (NOT an
   * outbound backlog — outbound sends directly). ⚠️ Discards pending inbound user
   * messages; use to clear a wedged inbound replay.
   */
  flushChannel(channel: string): { ok: boolean; dropped?: number; error?: string } {
    const adapter = this.adapters.get(channel);
    if (!adapter) return { ok: false, error: `no adapter for channel '${channel}'` };
    if (!adapter.flush) return { ok: false, error: `adapter '${channel}' does not support flush` };
    const dropped = adapter.flush();
    this.logger.info('channel flushed', { channel, dropped });
    return { ok: true, dropped };
  }

  /** Graceful stop: stop adapters, detach + flush capture, close the bus. */
  async stop(): Promise<void> {
    if (!this.started) {
      await this.capture.close();
      return;
    }
    this.bus.publish({
      direction: 'internal',
      type: 'lifecycle',
      source: 'supervisor',
      payload: { event: 'stop' },
    });
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch (err) {
        this.logger.warn('adapter stop error', { channel: adapter.channel, err: String(err) });
      }
    }
    await this.capture.close();
    this.bus.close();
    this.started = false;
    this.logger.info('supervisor stopped');
  }
}
