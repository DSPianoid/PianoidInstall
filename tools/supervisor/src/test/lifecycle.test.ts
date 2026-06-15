/**
 * LifecycleManager tests (via FakeSessionDriver) — session-id capture,
 * stream-json events published to the bus, and the FI restart+resume on an
 * unexpected (crash) stream end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleManager } from '../lifecycle.js';
import { IoBus, type BusEvent } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { PermissionDecision } from '../session-driver.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}
const allow = async (): Promise<PermissionDecision> => ({ behavior: 'allow' });

function collect(bus: IoBus): BusEvent[] {
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

test('captures session id and publishes stream-json events to the bus', async () => {
  const bus = new IoBus();
  const events = collect(bus);
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-1', model: 'claude-opus' } },
      { do: 'emit', event: { kind: 'assistant', text: 'hi', toolUses: [] } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-1', subtype: 'success', result: 'done' } },
      { do: 'endClean' },
    ],
  ]);
  const results: string[] = [];
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    onResult: (text) => {
      results.push(text);
    },
  });
  await lm.start();
  // Let the event stream drain.
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(lm.health().sessionId, 'sess-1', 'session id captured');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('stream.system_init'));
  assert.ok(types.includes('stream.assistant'));
  assert.ok(types.includes('stream.result'));
  assert.deepEqual(results, ['done'], 'onResult fired with the final text');
  await lm.stop();
  bus.close();
});

test('start() does NOT block on the first system_init (deferred-init fidelity — the live start-ordering bug)', async () => {
  // FIDELITY REGRESSION GUARD. The real SDK session is IDLE until the first user
  // turn: with a streaming-prompt input it emits NOTHING (no system/init) until a
  // turn is injected. The Fake originally always emitted system_init immediately,
  // which MASKED a bug where LifecycleManager.start() blocked on that first event
  // → the panel (sequenced after the session in index.ts) never came up live.
  //
  // This test reproduces the real ordering: the program AWAITS A TURN *before* any
  // system_init. It asserts (1) start() returns promptly without blocking, (2) the
  // session is "owned" (running) but has no session id yet, and (3) the first
  // injected user turn unblocks the stream → system_init arrives → id is captured
  // and stream.system_init is published.
  const bus = new IoBus();
  const events = collect(bus);
  const driver = new FakeSessionDriver([
    [
      { do: 'awaitTurn' }, // IDLE first — nothing is emitted until the user's first turn
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-lazy', model: 'm' } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-lazy', subtype: 'success', result: 'ok' } },
      { do: 'endClean' },
    ],
  ]);
  const lm = new LifecycleManager({ driver, bus, logger: silentLogger(), onPermission: allow });

  // (1) start() must resolve promptly even though no system_init is forthcoming yet.
  const t0 = Date.now();
  await lm.start();
  const startMs = Date.now() - t0;
  assert.ok(startMs < 500, `start() returned promptly (did not block on system_init): ${startMs}ms`);

  // (2) The session is owned/running, but no system_init has arrived → no session id,
  // and nothing has been published to the bus yet.
  assert.equal(lm.health().running, true, 'session owned immediately after start()');
  assert.equal(lm.health().sessionId, undefined, 'no session id before the first turn');
  assert.equal(
    events.some((e) => e.type === 'stream.system_init'),
    false,
    'no system_init published before the first turn',
  );

  // (3) The first user turn unblocks the idle stream → system_init now arrives.
  await driver.send({ text: 'first turn' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lm.health().sessionId, 'sess-lazy', 'session id captured after the first turn');
  assert.ok(
    events.some((e) => e.type === 'stream.system_init'),
    'system_init published once the first turn unblocked the session',
  );

  await lm.stop();
  bus.close();
});

test('FI: an unexpected (crash) stream end → restart + RESUME the session id', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    // Run 1: init then CRASH (no result) → lifecycle should restart+resume.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-A', model: 'm' } },
      { do: 'crash' },
    ],
    // Run 2 (resume): init (same id) then a clean result.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-A', model: 'm' } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-A', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    restartBackoffMs: 5, // fast restart for the test
  });
  await lm.start();
  // Wait for the crash → restart → resume cycle.
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(driver.starts >= 2, 'driver was started at least twice (initial + resume)');
  // The SECOND start() must have carried resume = the captured session id.
  assert.equal(driver.startOpts[1]?.resume, 'sess-A', 'restart resumed the session id');
  assert.equal(lm.health().restarts, 1);
  await lm.stop();
  bus.close();
});

test('clean stop does NOT restart', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-X', model: 'm' } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-X', subtype: 'success' } },
      { do: 'endClean' },
    ],
    // A second program exists but must NOT be consumed (no restart after clean end).
    [{ do: 'emit', event: { kind: 'system_init', sessionId: 'sess-Y', model: 'm' } }, { do: 'endClean' }],
  ]);
  const lm = new LifecycleManager({ driver, bus, logger: silentLogger(), onPermission: allow });
  await lm.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(driver.starts, 1, 'no restart after a clean result');
  assert.equal(lm.health().restarts, 0);
  await lm.stop();
  bus.close();
});

test('restart is bounded by maxRestarts (no infinite crash-loop)', async () => {
  const bus = new IoBus();
  // Every program crashes → lifecycle should give up after maxRestarts.
  const crashing = Array.from({ length: 10 }, () => [
    { do: 'emit' as const, event: { kind: 'system_init' as const, sessionId: 's', model: 'm' } },
    { do: 'crash' as const },
  ]);
  const driver = new FakeSessionDriver(crashing);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    maxRestarts: 2,
    restartBackoffMs: 2,
  });
  await lm.start();
  await new Promise((r) => setTimeout(r, 100));
  // initial + 2 restarts = 3 starts, then give up.
  assert.equal(driver.starts, 3, 'bounded at initial + maxRestarts');
  assert.equal(lm.health().running, false, 'stopped after exhausting restarts');
  await lm.stop();
  bus.close();
});
