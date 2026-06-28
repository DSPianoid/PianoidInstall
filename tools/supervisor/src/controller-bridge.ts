/**
 * CONTROLLER BRIDGE — route the Controller (M6) through the captured I/O bus.
 *
 * The Controller is the read-only compliance monitor that today detects stalled
 * agents by SCRAPING session-log markers ([BASH-CALL]/[MCP-CALL]/[PROGRESS] etc.).
 * Under the supervisor, every session + lifecycle event already rides the captured
 * bus (FC-3), so the controller can observe the SAME signals from a structured
 * event feed instead of tailing `.jsonl` logs — no scraping, no races.
 *
 * This is ADDITIVE (the Phase-3a mandate): it does NOT replace the existing
 * log-scraping controller — it adds a bus-backed signal feed the controller (or a
 * future supervisor-native controller) can consume. It subscribes to the bus,
 * derives controller-relevant SIGNALS (stall, restart, permission-route, session
 * lifecycle), keeps a bounded recent buffer, and optionally invokes a callback.
 *
 * Concern (P2): translate bus events → controller signals + buffer them. It takes
 * no action (the controller decides); it owns no session.
 *
 * Traces: proposal PART E Phase 3 deliverable 3 ("switch M6 to the captured bus")
 * + the Campaign's P4 (supervisor-based controller) — additive precursor.
 */

import type { BusEvent, IoBus } from './io-bus.js';

/** A controller-relevant signal derived from a bus event. */
export interface ControllerSignal {
  /** Signal kind the controller cares about. */
  kind: 'stall' | 'restart' | 'restart_exhausted' | 'permission_routed' | 'context_clean' | 'session_init' | 'session_result';
  /** When the source event was published. */
  ts: string;
  /** The bus sequence number of the source event. */
  seq: number;
  /** Small, secret-free detail (e.g. { tool, silentMs, attempt }). */
  detail: Record<string, unknown>;
}

export interface ControllerBridgeOptions {
  bus: IoBus;
  /** Max signals retained in the recent buffer. Default 200. */
  bufferLimit?: number;
  /** Optional callback for each derived signal (the controller's hook). */
  onSignal?: (sig: ControllerSignal) => void;
}

export class ControllerBridge {
  private readonly opts: ControllerBridgeOptions;
  private readonly bufferLimit: number;
  private readonly buffer: ControllerSignal[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(opts: ControllerBridgeOptions) {
    this.opts = opts;
    this.bufferLimit = opts.bufferLimit ?? 200;
  }

  /** Start observing the bus (idempotent). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.bus.subscribe((e) => this.onEvent(e));
  }

  /** Stop observing. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** The recent controller signals (newest last). */
  signals(): ControllerSignal[] {
    return [...this.buffer];
  }

  /** Derive a controller signal from a bus event (or null if not relevant). */
  private onEvent(e: BusEvent): void {
    const sig = ControllerBridge.toSignal(e);
    if (!sig) return;
    this.buffer.push(sig);
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    try {
      this.opts.onSignal?.(sig);
    } catch {
      /* a controller callback must never break the bridge */
    }
  }

  /** Pure mapping: bus event → controller signal (exported-testable). */
  static toSignal(e: BusEvent): ControllerSignal | null {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const base = { ts: e.ts, seq: e.seq };
    if (e.type === 'lifecycle') {
      const ev = p['event'];
      if (ev === 'stall') return { kind: 'stall', ...base, detail: { silentMs: p['silentMs'], action: p['action'] } };
      if (ev === 'restarting') return { kind: 'restart', ...base, detail: { attempt: p['attempt'] } };
      if (ev === 'restart_exhausted') return { kind: 'restart_exhausted', ...base, detail: { restarts: p['restarts'] } };
      if (ev === 'context_clean') return { kind: 'context_clean', ...base, detail: {} };
      return null;
    }
    if (e.type === 'stream.system_init') return { kind: 'session_init', ...base, detail: { sessionId: p['sessionId'] } };
    if (e.type === 'stream.result')
      return { kind: 'session_result', ...base, detail: { subtype: p['subtype'], costUsd: p['costUsd'] } };
    // A permission prompt routed to the user shows up as an outbound to the channel
    // with the 🔐 marker; the router also logs it, but on the bus the cleanest
    // controller signal is the assistant tool_use that triggered the route. We
    // surface tool-use bearing assistant turns as a routed-candidate is noisy, so
    // we rely on the lifecycle/stream signals above; permission routing is observed
    // via the channel.outbound 🔐 prompt at the supervisor layer (kept out of here
    // to avoid coupling the bridge to prompt text).
    return null;
  }
}
