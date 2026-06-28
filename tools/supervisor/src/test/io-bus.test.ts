import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IoBus } from '../io-bus.js';

test('IoBus assigns monotonic seq and a timestamp', () => {
  const bus = new IoBus();
  const e1 = bus.publish({ direction: 'inbound', type: 'x', source: 's', payload: 1 });
  const e2 = bus.publish({ direction: 'inbound', type: 'x', source: 's', payload: 2 });
  assert.equal(e1.seq, 0);
  assert.equal(e2.seq, 1);
  assert.ok(e1.ts && !Number.isNaN(Date.parse(e1.ts)));
  bus.close();
});

test('IoBus fans out to every subscriber', () => {
  const bus = new IoBus();
  const a: number[] = [];
  const b: number[] = [];
  bus.subscribe((e) => a.push(e.payload as number));
  bus.subscribe((e) => b.push(e.payload as number));
  bus.publish({ direction: 'internal', type: 'x', source: 's', payload: 42 });
  assert.deepEqual(a, [42]);
  assert.deepEqual(b, [42]);
  bus.close();
});

test('IoBus isolates a throwing subscriber (fail-soft fan-out)', () => {
  const bus = new IoBus();
  const errors: unknown[] = [];
  bus.onSubscriberError((err) => errors.push(err));
  const good: number[] = [];
  bus.subscribe(() => {
    throw new Error('bad subscriber');
  });
  bus.subscribe((e) => good.push(e.payload as number));
  // Must not throw, and the good subscriber still receives the event.
  bus.publish({ direction: 'internal', type: 'x', source: 's', payload: 7 });
  assert.deepEqual(good, [7]);
  assert.equal(errors.length, 1);
  bus.close();
});

test('IoBus unsubscribe stops delivery', () => {
  const bus = new IoBus();
  const seen: number[] = [];
  const off = bus.subscribe((e) => seen.push(e.payload as number));
  bus.publish({ direction: 'internal', type: 'x', source: 's', payload: 1 });
  off();
  bus.publish({ direction: 'internal', type: 'x', source: 's', payload: 2 });
  assert.deepEqual(seen, [1]);
  bus.close();
});

test('IoBus refuses publish after close', () => {
  const bus = new IoBus();
  bus.close();
  assert.throws(() => bus.publish({ direction: 'internal', type: 'x', source: 's', payload: 1 }));
});
