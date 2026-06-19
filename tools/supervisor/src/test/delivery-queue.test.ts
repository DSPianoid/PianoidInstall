import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeliveryQueue } from '../delivery-queue.js';
import { tmpDir } from './helpers.js';

test('enqueue persists an item that pending() returns', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ msg: string }>({ dir });
    const item = q.enqueue({ msg: 'hi' });
    const pend = q.pending();
    assert.equal(pend.length, 1);
    assert.equal(pend[0]!.id, item.id);
    assert.equal(pend[0]!.payload.msg, 'hi');
    assert.equal(q.depth(), 1);
  } finally {
    cleanup();
  }
});

test('ack removes an item from pending and archives it', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ msg: string }>({ dir });
    const item = q.enqueue({ msg: 'x' });
    q.ack(item.id);
    assert.equal(q.depth(), 0);
    // Archived (deleteOnAck=false default).
    assert.ok(existsSync(join(dir, 'archive', `${item.id}.json`)));
  } finally {
    cleanup();
  }
});

test('ack is idempotent (missing file is a no-op)', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue({ dir });
    const item = q.enqueue({ n: 1 });
    q.ack(item.id);
    assert.doesNotThrow(() => q.ack(item.id));
    assert.equal(q.depth(), 0);
  } finally {
    cleanup();
  }
});

test('replayPending delivers each pending item and acks it', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ n: number }>({ dir });
    q.enqueue({ n: 1 });
    q.enqueue({ n: 2 });
    q.enqueue({ n: 3 });
    const delivered: number[] = [];
    const count = await q.replayPending((p) => {
      delivered.push(p.n);
    });
    assert.equal(count, 3);
    assert.deepEqual(delivered.sort(), [1, 2, 3]);
    assert.equal(q.depth(), 0);
  } finally {
    cleanup();
  }
});

test('replayPending LEAVES an item queued when the handler throws (never drop)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ n: number }>({ dir });
    q.enqueue({ n: 1 });
    q.enqueue({ n: 2 });
    // Throw on n===2 — it must remain in the queue for a later replay.
    const count = await q.replayPending((p) => {
      if (p.n === 2) throw new Error('handler failed');
    });
    assert.equal(count, 1); // only n===1 acked
    assert.equal(q.depth(), 1); // n===2 still pending
    assert.equal(q.pending()[0]!.payload.n, 2);
  } finally {
    cleanup();
  }
});

test('a second queue instance (post-restart) sees prior un-acked items', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q1 = new DeliveryQueue<{ n: number }>({ dir });
    q1.enqueue({ n: 7 });
    // New instance over the SAME dir = simulated restart.
    const q2 = new DeliveryQueue<{ n: number }>({ dir });
    assert.equal(q2.depth(), 1);
    assert.equal(q2.pending()[0]!.payload.n, 7);
  } finally {
    cleanup();
  }
});

test('deleteOnAck removes the file instead of archiving', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ n: number }>({ dir, deleteOnAck: true });
    const item = q.enqueue({ n: 1 });
    q.ack(item.id);
    assert.ok(!existsSync(join(dir, 'archive', `${item.id}.json`)));
    assert.equal(q.depth(), 0);
  } finally {
    cleanup();
  }
});

test('TG4: pending() skips a torn/half-written queue file (never aborts the replay)', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ n: number }>({ dir });
    q.enqueue({ n: 1 }); // a valid item
    // Drop a corrupt msg-*.json (e.g. a crash mid-write that left half JSON).
    writeFileSync(join(dir, 'msg-9999999999-0000-deadbe.json'), '{"id":"msg-x","payl');
    const pend = q.pending();
    // The valid item is returned; the torn file is skipped (not thrown on).
    assert.equal(pend.length, 1);
    assert.equal(pend[0]!.payload.n, 1);
  } finally {
    cleanup();
  }
});

test('M3: ids are unique even for same-millisecond enqueues after a restart', () => {
  const { dir, cleanup } = tmpDir();
  try {
    // Enqueue one item, then simulate a restart (new instance, seq reset risk).
    const q1 = new DeliveryQueue<{ n: number }>({ dir });
    const first = q1.enqueue({ n: 1 });
    // New instance over the same dir: seq is seeded from the pending count (=1),
    // AND every id carries a random suffix — so a same-ms enqueue can't collide.
    const q2 = new DeliveryQueue<{ n: number }>({ dir });
    const ids = new Set<string>([first.id]);
    for (let i = 0; i < 50; i++) ids.add(q2.enqueue({ n: i }).id);
    // 1 (pre-restart) + 50 = 51 distinct ids, no file overwritten.
    assert.equal(ids.size, 51);
    const files = readdirSync(dir).filter((f) => f.startsWith('msg-') && f.endsWith('.json'));
    assert.equal(files.length, 51, 'no queue file was overwritten by an id collision');
  } finally {
    cleanup();
  }
});

test('M2: update() rewrites a pending item in place, preserving its enqueue time', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ content: string }>({ dir });
    const item = q.enqueue({ content: '' });
    q.update(item.id, { content: 'transcribed' });
    const pend = q.pending();
    assert.equal(pend.length, 1);
    assert.equal(pend[0]!.payload.content, 'transcribed');
    assert.equal(pend[0]!.enqueuedAt, item.enqueuedAt, 'enqueue time preserved');
    // And it is persisted to disk (a replay would see the enriched payload).
    const onDisk = JSON.parse(readFileSync(join(dir, `${item.id}.json`), 'utf8')) as {
      payload: { content: string };
    };
    assert.equal(onDisk.payload.content, 'transcribed');
  } finally {
    cleanup();
  }
});

test('M2: update() on an acked (no longer pending) item is a no-op', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ content: string }>({ dir });
    const item = q.enqueue({ content: 'x' });
    q.ack(item.id);
    assert.doesNotThrow(() => q.update(item.id, { content: 'late' }));
    assert.equal(q.depth(), 0);
  } finally {
    cleanup();
  }
});

test('★ D2: clear() drops all pending items and returns the count', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const q = new DeliveryQueue<{ msg: string }>({ dir });
    q.enqueue({ msg: 'a' });
    q.enqueue({ msg: 'b' });
    q.enqueue({ msg: 'c' });
    assert.equal(q.depth(), 3);
    const dropped = q.clear();
    assert.equal(dropped, 3);
    assert.equal(q.depth(), 0);
    assert.equal(q.clear(), 0, 'clearing an empty queue drops 0');
  } finally {
    cleanup();
  }
});
