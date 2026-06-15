import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CaptureStore } from '../capture-store.js';
import { IoBus } from '../io-bus.js';
import { tmpDir } from './helpers.js';

test('TG1/H1: buffered DEFAULT path is live-readable — replay() sees events BEFORE close()', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = join(dir, 'events.ndjson');
    // buffered:true is the production default (index.ts builds without
    // unbufferedCapture). Before the H1 fix this under-reported until close().
    const store = new CaptureStore({ filePath: file, buffered: true });
    store.record({ seq: 0, ts: new Date().toISOString(), direction: 'inbound', type: 'live', source: 's', payload: { n: 1 } });
    store.record({ seq: 1, ts: new Date().toISOString(), direction: 'outbound', type: 'live2', source: 's', payload: { n: 2 } });
    // The panel calls replay() WHILE running (no close()) — it must see both.
    const records = store.replay();
    assert.equal(records.length, 2, 'buffered capture is readable live, not just after close()');
    assert.equal(records[0]!.event.type, 'live');
    assert.equal(records[1]!.event.type, 'live2');
    await store.close();
  } finally {
    cleanup();
  }
});

test('CaptureStore persists bus events and replays them in order', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = join(dir, 'cap', 'events.ndjson');
    const bus = new IoBus();
    const store = new CaptureStore({ filePath: file, buffered: false }).attach(bus);

    bus.publish({ direction: 'inbound', type: 'a', source: 's', payload: { n: 1 } });
    bus.publish({ direction: 'outbound', type: 'b', source: 's', payload: { n: 2 } });

    const records = store.replay();
    assert.equal(records.length, 2);
    assert.equal(records[0]!.event.type, 'a');
    assert.equal(records[1]!.event.type, 'b');
    assert.equal((records[1]!.event.payload as { n: number }).n, 2);
    assert.ok(records[0]!.capturedAt);
    await store.close();
    bus.close();
  } finally {
    cleanup();
  }
});

test('CaptureStore replay survives a torn final line', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = join(dir, 'events.ndjson');
    const store = new CaptureStore({ filePath: file, buffered: false });
    store.record({ seq: 0, ts: new Date().toISOString(), direction: 'inbound', type: 'ok', source: 's', payload: {} });
    // Simulate a crash mid-write: a partial JSON line with no newline.
    appendFileSync(file, '{"capturedAt":"2026', { encoding: 'utf8' });
    const records = store.replay();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.event.type, 'ok');
    await store.close();
  } finally {
    cleanup();
  }
});

test('CaptureStore append survives a restart (new instance sees prior records)', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = join(dir, 'events.ndjson');
    const s1 = new CaptureStore({ filePath: file, buffered: false });
    s1.record({ seq: 0, ts: new Date().toISOString(), direction: 'inbound', type: 'before', source: 's', payload: {} });
    await s1.close();

    // A fresh instance (post-restart) must append, not truncate.
    const s2 = new CaptureStore({ filePath: file, buffered: false });
    s2.record({ seq: 1, ts: new Date().toISOString(), direction: 'inbound', type: 'after', source: 's', payload: {} });
    const records = s2.replay();
    assert.deepEqual(records.map((r) => r.event.type), ['before', 'after']);
    await s2.close();
  } finally {
    cleanup();
  }
});

test('CaptureStore.query filters records', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = join(dir, 'events.ndjson');
    const store = new CaptureStore({ filePath: file, buffered: false });
    store.record({ seq: 0, ts: '', direction: 'inbound', type: 'keep', source: 's', payload: {} });
    store.record({ seq: 1, ts: '', direction: 'outbound', type: 'drop', source: 's', payload: {} });
    const kept = store.query((r) => r.event.direction === 'inbound');
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.event.type, 'keep');
    await store.close();
  } finally {
    cleanup();
  }
});
