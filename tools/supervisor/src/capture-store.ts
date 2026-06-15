/**
 * The CAPTURE STORE.
 *
 * A durable, append-only, replayable event store — the seed of §2c
 * observability and the FC-3 "captured byte-stream". It subscribes to the
 * I/O bus and persists every event as one NDJSON line. Because the bus carries
 * the channel I/O now (and the stream-json session events in Phase 2), the
 * capture store holds a complete, replayable record of a session's events.
 *
 * **Synchronous append (H1 fix).** Writes go through a held, append-mode file
 * descriptor with `fs.writeSync`, so every recorded event is on disk the instant
 * `record()` returns. This is what lets the read-only panel's `/api/capture`
 * (which calls `replay()` → `readFileSync`) reflect events LIVE — an async
 * `createWriteStream` buffered the writes and the panel under-reported until
 * `close()`. The held fd keeps this efficient (no per-call open/close) while
 * remaining immediately readable; Phase-1 capture volume (lifecycle + channel
 * I/O) is well within sync-append headroom, and the Phase-3 operator panel can
 * add an in-memory ring if the stream-json firehose ever needs it.
 *
 * Concern (P2): durable append + query/replay ONLY. It never interprets or
 * mutates events; it never deletes (append-only).
 *
 * Authority (P1): the CaptureStore is the sole writer of its log file. It only
 * ever appends; it never rewrites in place.
 *
 * Traces: proposal PART E Phase 1 deliverable 3 ("Transcript capture … into a
 * durable, queryable capture store") + acceptance "The capture store holds a
 * complete, replayable record of a session's events."
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { BusEvent, IoBus } from './io-bus.js';

/** A stored capture record = a bus event plus the capture's own ingest time. */
export interface CaptureRecord {
  /** When the capture store persisted it (ISO-8601). */
  capturedAt: string;
  /** The original bus event. */
  event: BusEvent;
}

export interface CaptureStoreOptions {
  /** Absolute path to the NDJSON capture log. Parent dirs are created. */
  filePath: string;
  /**
   * Retained for API compatibility. Writes are now ALWAYS synchronous-append
   * (so `replay()` is always live, fixing the buffered-lag defect H1); this flag
   * no longer changes durability/readback semantics. Defaults to true.
   */
  buffered?: boolean;
}

export class CaptureStore {
  private readonly filePath: string;
  /** Held append-mode file descriptor; null until first write / after close. */
  private fd: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private count = 0;

  constructor(opts: CaptureStoreOptions) {
    this.filePath = opts.filePath;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Subscribe to the bus so every event is captured. Returns this. */
  attach(bus: IoBus): this {
    if (this.unsubscribe) return this;
    this.unsubscribe = bus.subscribe((event) => this.record(event));
    return this;
  }

  /**
   * Persist a single bus event as one NDJSON line — synchronously, so it is
   * immediately readable by `replay()` (the H1 fix). Opens the append-mode fd
   * lazily on first write.
   */
  record(event: BusEvent): void {
    const rec: CaptureRecord = {
      capturedAt: new Date().toISOString(),
      event,
    };
    const line = JSON.stringify(rec) + '\n';
    if (this.fd === null) {
      // 'a' = append; survives process restarts, preserving prior records.
      this.fd = openSync(this.filePath, 'a');
    }
    writeSync(this.fd, line);
    this.count++;
  }

  /**
   * Replay the full event stream from disk, in append order. Because writes are
   * synchronous, this always reflects every event recorded so far (live). It is
   * tolerant of a torn final line (a crash mid-write) — a trailing unparseable
   * line is skipped rather than throwing, so recovery never loses prior records.
   */
  replay(): CaptureRecord[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf8');
    const out: CaptureRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as CaptureRecord);
      } catch {
        // Torn/partial final line from an abrupt termination — skip it.
      }
    }
    return out;
  }

  /**
   * Replay only events matching a predicate (e.g. by type or direction) — the
   * queryable seed of §2c.
   */
  query(predicate: (rec: CaptureRecord) => boolean): CaptureRecord[] {
    return this.replay().filter(predicate);
  }

  /** Records written by THIS instance since construction. */
  get writtenCount(): number {
    return this.count;
  }

  /** Detach from the bus and close the append fd. */
  async close(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
