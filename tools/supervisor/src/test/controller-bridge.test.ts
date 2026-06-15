/**
 * ControllerBridge tests — bus event → controller signal mapping (M6-on-bus,
 * additive). Pure toSignal() + a live subscription against a real IoBus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControllerBridge } from '../controller-bridge.js';
import { IoBus } from '../io-bus.js';

const ev = (type: string, payload: Record<string, unknown>) => ({
  seq: 1,
  ts: '2026-06-15T00:00:00Z',
  direction: 'internal' as const,
  type,
  source: 'session',
  payload,
});

test('toSignal maps lifecycle + stream events to controller signals', () => {
  assert.equal(ControllerBridge.toSignal(ev('lifecycle', { event: 'stall', silentMs: 5000, action: 'surface' }))?.kind, 'stall');
  assert.equal(ControllerBridge.toSignal(ev('lifecycle', { event: 'restarting', attempt: 2 }))?.kind, 'restart');
  assert.equal(
    ControllerBridge.toSignal(ev('lifecycle', { event: 'restart_exhausted', restarts: 5 }))?.kind,
    'restart_exhausted',
  );
  assert.equal(ControllerBridge.toSignal(ev('lifecycle', { event: 'context_clean' }))?.kind, 'context_clean');
  assert.equal(ControllerBridge.toSignal(ev('stream.system_init', { sessionId: 's1' }))?.kind, 'session_init');
  assert.equal(ControllerBridge.toSignal(ev('stream.result', { subtype: 'success', costUsd: 0.1 }))?.kind, 'session_result');
});

test('toSignal ignores non-controller events (returns null)', () => {
  assert.equal(ControllerBridge.toSignal(ev('channel.inbound', { text: 'hi' })), null);
  assert.equal(ControllerBridge.toSignal(ev('stream.assistant', { text: 'x' })), null);
  assert.equal(ControllerBridge.toSignal(ev('lifecycle', { event: 'start' })), null); // 'start' is not a controller signal
});

test('controller signal detail carries the relevant fields (no secrets)', () => {
  const sig = ControllerBridge.toSignal(ev('lifecycle', { event: 'stall', silentMs: 9000, action: 'restart' }));
  assert.deepEqual(sig?.detail, { silentMs: 9000, action: 'restart' });
});

test('live: bridge buffers signals from the bus + fires onSignal', () => {
  const bus = new IoBus();
  const got: string[] = [];
  const bridge = new ControllerBridge({ bus, onSignal: (s) => got.push(s.kind) });
  bridge.start();
  bus.publish({ direction: 'internal', type: 'lifecycle', source: 'session', payload: { event: 'stall', silentMs: 1 } });
  bus.publish({ direction: 'inbound', type: 'channel.inbound', source: 'telegram', payload: { text: 'ignored' } });
  bus.publish({ direction: 'internal', type: 'stream.system_init', source: 'session', payload: { sessionId: 's' } });
  assert.deepEqual(got, ['stall', 'session_init'], 'only controller-relevant events buffered');
  assert.equal(bridge.signals().length, 2);
  bridge.stop();
  // After stop, further publishes are ignored.
  bus.publish({ direction: 'internal', type: 'lifecycle', source: 'session', payload: { event: 'context_clean' } });
  assert.equal(bridge.signals().length, 2, 'stopped bridge ignores new events');
  bus.close();
});

test('bridge buffer is bounded', () => {
  const bus = new IoBus();
  const bridge = new ControllerBridge({ bus, bufferLimit: 3 });
  bridge.start();
  for (let i = 0; i < 10; i++) {
    bus.publish({ direction: 'internal', type: 'lifecycle', source: 'session', payload: { event: 'restarting', attempt: i } });
  }
  assert.equal(bridge.signals().length, 3, 'buffer capped at limit');
  bridge.stop();
  bus.close();
});
