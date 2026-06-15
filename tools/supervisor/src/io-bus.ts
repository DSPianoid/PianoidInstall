/**
 * The I/O BUS.
 *
 * Marshals events in/out and fans them out to subscribers (channel + panel +
 * capture log). It is the spine of FC-3 ("every byte on a captured bus"): in
 * Phase 1 it carries the channel I/O and the (read-only) capture; in Phase 2
 * the stream-json events to/from the owned Claude Code subprocess ride the same
 * bus.
 *
 * Concern (P2): marshal + fan-out ONLY. It does not interpret meaning (that is
 * M1, hosted inside the child) and holds no durable state (a pure in-memory
 * broker — durability lives in CaptureStore / DeliveryQueue).
 *
 * Authority (P1): the bus owns its subscriber set; producers publish, the bus
 * fans out; it never mutates an event's payload.
 *
 * Traces: proposal PART B.1 (the I/O BUS row of the diagram) + B.2 (the I/O bus
 * border row).
 */

import { EventEmitter } from 'node:events';

/** Direction of an event relative to the hosted session. */
export type BusDirection = 'inbound' | 'outbound' | 'internal';

/**
 * A bus event. Generic on purpose: in Phase 1 we carry channel messages and
 * lifecycle/system notes; in Phase 2 stream-json events (system/init,
 * assistant, tool_*, result) map onto the same envelope via `type`/`payload`.
 */
export interface BusEvent<T = unknown> {
  /** Monotonic per-bus sequence number (assigned on publish). */
  seq: number;
  /** ISO-8601 publish time. */
  ts: string;
  /** Coarse direction relative to the hosted session. */
  direction: BusDirection;
  /**
   * Event type discriminator. Phase-1 examples:
   *   'channel.inbound' | 'channel.outbound' | 'system' | 'lifecycle'.
   * Phase-2 will add 'stream.system_init' | 'stream.assistant' | 'stream.tool'
   * | 'stream.result' etc.
   */
  type: string;
  /** Originating component/channel name ('telegram', 'supervisor', …). */
  source: string;
  /** Arbitrary structured payload. */
  payload: T;
}

/** A subscriber callback. Receives every published event after assignment. */
export type BusSubscriber = (event: BusEvent) => void;

/** What a producer supplies to `publish` (seq + ts are assigned by the bus). */
export type BusEventInput = Omit<BusEvent, 'seq' | 'ts'> &
  Partial<Pick<BusEvent, 'ts'>>;

export class IoBus {
  private readonly emitter = new EventEmitter();
  private seqCounter = 0;
  private closed = false;

  constructor() {
    // Many subscribers (channel, panel, capture, future controller) are normal.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publish an event. The bus assigns `seq` (monotonic) and `ts` (if absent),
   * then fans out to every subscriber. A throwing subscriber is isolated so one
   * bad consumer can never starve the others (fail-soft fan-out).
   *
   * Returns the fully-populated event (so the caller can correlate by seq).
   */
  publish(input: BusEventInput): BusEvent {
    if (this.closed) {
      throw new Error('IoBus is closed');
    }
    const event: BusEvent = {
      ...input,
      seq: this.seqCounter++,
      ts: input.ts ?? new Date().toISOString(),
    };
    this.emitter.emit('event', event);
    return event;
  }

  /**
   * Subscribe to all events. Returns an unsubscribe function.
   *
   * Subscribers are wrapped so a throw is caught and reported on the bus's
   * 'subscriber_error' channel rather than propagating into `publish`.
   */
  subscribe(subscriber: BusSubscriber): () => void {
    const wrapped = (event: BusEvent): void => {
      try {
        subscriber(event);
      } catch (err) {
        // Isolate the faulty subscriber. Surface via a dedicated channel so a
        // logger can pick it up without re-entering the main 'event' fan-out.
        this.emitter.emit('subscriber_error', err, event);
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /** Register a handler for subscriber faults (for structured logging). */
  onSubscriberError(handler: (err: unknown, event: BusEvent) => void): void {
    this.emitter.on('subscriber_error', handler);
  }

  /** Number of currently-registered event subscribers. */
  get subscriberCount(): number {
    return this.emitter.listenerCount('event');
  }

  /** Highest seq assigned so far (i.e. count of events published). */
  get published(): number {
    return this.seqCounter;
  }

  /** Stop accepting new publishes and drop all subscribers. */
  close(): void {
    this.closed = true;
    this.emitter.removeAllListeners();
  }
}
