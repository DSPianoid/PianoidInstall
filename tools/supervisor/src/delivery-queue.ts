/**
 * The DELIVERY QUEUE — durable, ack'd, replayable inbound persistence.
 *
 * This is the inbox-queue monkey-patch (`apply_telegram_patch.py`) promoted to
 * a first-class adapter responsibility. Every gate-approved inbound is written
 * to a queue file BEFORE the handler runs; the file is acked (removed/archived)
 * only AFTER the handler returns normally. A crash between enqueue and ack
 * leaves the file in the queue, so `replayPending()` re-delivers it on the next
 * start — nothing is dropped (the FC-2 delivery guarantee).
 *
 * On-disk layout mirrors the plugin's `inbox/` + `inbox/archive/`:
 *   <dir>/msg-<ts>-<seq>.json     ← pending (un-acked) item = {content, meta}
 *   <dir>/archive/msg-…json       ← acked item (kept for audit unless deleteOnAck)
 *
 * Concern (P2): durable persist + ack + replay of inbound items ONLY.
 * Authority (P1): the DeliveryQueue is the sole writer of its queue dir.
 *
 * Traces: proposal PART B.2 contract "Queued + recoverable" + PART D row
 * "apply_telegram_patch.py → adapter contract's queued+recoverable delivery" +
 * PART E Phase-1 acceptance "Inbound survives a simulated restart of the
 * adapter (queue replay; nothing dropped)".
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** A persisted queue item: the normalized payload plus bookkeeping. */
export interface QueuedItem<T = unknown> {
  /** Queue-assigned id (also the filename stem). */
  id: string;
  /** ISO-8601 enqueue time. */
  enqueuedAt: string;
  /** The opaque payload the producer enqueued (e.g. {content, meta}). */
  payload: T;
}

export interface DeliveryQueueOptions {
  /** Absolute path to the queue directory. Created if missing. */
  dir: string;
  /**
   * If true, acked items are deleted; if false (default), they are moved to
   * `<dir>/archive/` for audit (matching the plugin's inbox/archive pattern).
   */
  deleteOnAck?: boolean;
}

export class DeliveryQueue<T = unknown> {
  private readonly dir: string;
  private readonly archiveDir: string;
  private readonly deleteOnAck: boolean;
  private seq = 0;

  constructor(opts: DeliveryQueueOptions) {
    this.dir = opts.dir;
    this.archiveDir = join(this.dir, 'archive');
    this.deleteOnAck = opts.deleteOnAck ?? false;
    mkdirSync(this.dir, { recursive: true });
    if (!this.deleteOnAck) mkdirSync(this.archiveDir, { recursive: true });
    // Seed seq from the existing pending count so the counter does NOT reset to
    // 0 across a restart (review M3) — combined with the random suffix below this
    // makes a same-millisecond id collision after a fast crash-loop effectively
    // impossible (the old in-process-only seq could overwrite a prior file).
    this.seq = this.pending().length;
  }

  /**
   * Persist a payload to the queue and return its handle. The id is
   * `msg-<ms>-<seq>-<rand>`: wall-clock ms for ordering, a restart-seeded
   * counter, AND a per-call random token so two items enqueued in the same
   * millisecond (even across process lifetimes) never collide / overwrite
   * (review M3 — protects the never-drop invariant). Write is atomic (write to
   * `.tmp` then rename) so a torn write never leaves a half-file that
   * `replayPending` would choke on.
   */
  enqueue(payload: T): QueuedItem<T> {
    const rand = randomBytes(3).toString('hex');
    const id = `msg-${Date.now()}-${String(this.seq++).padStart(4, '0')}-${rand}`;
    const item: QueuedItem<T> = {
      id,
      enqueuedAt: new Date().toISOString(),
      payload,
    };
    this.writeAtomic(item);
    return item;
  }

  /**
   * Replace a pending item's payload in place (atomic). Used to persist an
   * enriched payload back — e.g. memoizing a voice transcript after STT so a
   * replay does NOT re-run STT (review M2). No-op if the item is no longer
   * pending (already acked).
   */
  update(id: string, payload: T): void {
    if (!existsSync(join(this.dir, `${id}.json`))) return;
    // Preserve the original enqueue time if we can read it; else stamp now.
    let enqueuedAt = new Date().toISOString();
    try {
      const prev = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as QueuedItem<T>;
      enqueuedAt = prev.enqueuedAt;
    } catch {
      // unreadable — keep the fresh stamp
    }
    this.writeAtomic({ id, enqueuedAt, payload });
  }

  /** Atomic write: to `<id>.json.tmp` then rename, so no torn final file. */
  private writeAtomic(item: QueuedItem<T>): void {
    const finalPath = join(this.dir, `${item.id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(item) + '\n');
    renameSync(tmpPath, finalPath);
  }

  /**
   * Acknowledge an item by id — removing it from the pending set. Called only
   * after the handler succeeds. Archives (or deletes) the file. Idempotent: a
   * missing file is a no-op (already acked).
   */
  ack(id: string): void {
    const finalPath = join(this.dir, `${id}.json`);
    if (!existsSync(finalPath)) return;
    if (this.deleteOnAck) {
      rmSync(finalPath, { force: true });
    } else {
      renameSync(finalPath, join(this.archiveDir, `${id}.json`));
    }
  }

  /** All pending (un-acked) items, in enqueue order (id is time-ordered). */
  pending(): QueuedItem<T>[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => f.startsWith('msg-') && f.endsWith('.json'))
      .sort();
    const out: QueuedItem<T>[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(this.dir, f), 'utf8');
        out.push(JSON.parse(raw) as QueuedItem<T>);
      } catch {
        // Skip an unreadable/partial file rather than aborting the whole replay.
      }
    }
    return out;
  }

  /** Count of pending items (for health()). */
  depth(): number {
    return this.pending().length;
  }

  /**
   * CHANNEL REPAIR (D2): drop ALL pending items (ack each) and return the count
   * dropped — clears a backlog. Best-effort per item (an unremovable file is skipped).
   */
  clear(): number {
    const items = this.pending();
    let dropped = 0;
    for (const it of items) {
      try {
        this.ack(it.id);
        dropped++;
      } catch {
        /* skip an unremovable item */
      }
    }
    return dropped;
  }

  /**
   * Replay every pending item through `deliver`, acking each that the handler
   * accepts (returns normally). An item whose handler throws is LEFT in the
   * queue for a future replay — fail-safe, never drop. Returns the count
   * delivered+acked.
   */
  async replayPending(
    deliver: (payload: T, item: QueuedItem<T>) => void | Promise<void>,
  ): Promise<number> {
    let delivered = 0;
    for (const item of this.pending()) {
      try {
        await deliver(item.payload, item);
        this.ack(item.id);
        delivered++;
      } catch {
        // Leave it queued; the next replay (or a later ack) handles it.
      }
    }
    return delivered;
  }
}
