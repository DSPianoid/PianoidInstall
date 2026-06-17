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

// ── H2 hang watchdog ────────────────────────────────────────────────────────

test('H2 watchdog (surface): a wedged turn fires onStall + a stall event, no restart', async () => {
  const bus = new IoBus();
  const events = collect(bus);
  // system_init, then idle for the turn, then SILENCE (wedged — emits nothing).
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-w', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'silence' },
    ],
  ]);
  const stalls: { silentMs: number; action: string }[] = [];
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    turnTimeoutMs: 40, // short deadline for the test
    onStallAction: 'surface',
    onStall: (info) => {
      stalls.push({ silentMs: info.silentMs, action: info.action });
    },
  });
  await lm.start();
  await lm.sendUserTurn({ text: 'do something slow' }); // arms the watchdog
  await new Promise((r) => setTimeout(r, 120)); // let the deadline elapse

  assert.equal(stalls.length, 1, 'onStall fired once');
  assert.equal(stalls[0]!.action, 'surface');
  assert.ok(
    events.some((e) => e.type === 'lifecycle' && (e.payload as { event?: string }).event === 'stall'),
    'a stall lifecycle event was published',
  );
  assert.equal(driver.starts, 1, 'surface action does NOT restart');
  await lm.stop();
  bus.close();
});

test('H2 watchdog (restart): a wedged turn interrupts → restart + resume', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    // Run 1: init, await the turn, then wedge (silence). interrupt() ends it.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-wr', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'silence' },
    ],
    // Run 2 (resume): clean result.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-wr', model: 'm' } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-wr', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    turnTimeoutMs: 40,
    onStallAction: 'restart',
    restartBackoffMs: 5,
  });
  await lm.start();
  await lm.sendUserTurn({ text: 'wedge me' });
  await new Promise((r) => setTimeout(r, 150)); // deadline → interrupt → restart → resume

  assert.ok(driver.starts >= 2, 'restart action restarted the session');
  assert.equal(driver.startOpts[1]?.resume, 'sess-wr', 'restart resumed the session id');
  await lm.stop();
  bus.close();
});

test('clearContext: ends the session + starts FRESH (no resume) + re-bootstraps the role', async () => {
  const bus = new IoBus();
  const events = collect(bus);
  const driver = new FakeSessionDriver([
    // Run 1: init then idle (awaiting a turn) — the live session before /clear.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-old', model: 'm' } },
      { do: 'awaitTurn' },
    ],
    // Run 2 (after clearContext): a FRESH session (different id), idle.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-new', model: 'm' } },
      { do: 'awaitTurn' },
    ],
  ]);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    bootstrapTurns: ['/orchestrator'],
  });
  await lm.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lm.health().sessionId, 'sess-old', 'first session live');

  await lm.clearContext();
  await new Promise((r) => setTimeout(r, 30));

  // A fresh session was started (2 starts), NOT a resume, and the role was re-bootstrapped.
  assert.equal(driver.starts, 2, 'a fresh session was started');
  assert.equal(driver.startOpts[1]?.resume, undefined, 'fresh start does NOT resume (clean context)');
  assert.deepEqual(driver.startOpts[1]?.bootstrapTurns, ['/orchestrator'], 'role re-bootstrapped on the fresh session');
  assert.equal(lm.health().sessionId, 'sess-new', 'now on the fresh session');
  assert.ok(
    events.some((e) => e.type === 'lifecycle' && (e.payload as { event?: string }).event === 'context_clean'),
    'a context_clean event was published',
  );
  await lm.stop();
  bus.close();
});

test('bootstrapTurns: passed on the INITIAL start, NOT on a resume', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    // Run 1: init then crash (no result) → restart+resume.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-b', model: 'm' } },
      { do: 'crash' },
    ],
    // Run 2 (resume): clean result.
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-b', model: 'm' } },
      { do: 'emit', event: { kind: 'result', sessionId: 'sess-b', subtype: 'success' } },
      { do: 'endClean' },
    ],
  ]);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    bootstrapTurns: ['/orchestrator'],
    restartBackoffMs: 5,
  });
  await lm.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(driver.startOpts[0]?.bootstrapTurns, ['/orchestrator'], 'initial start bootstrapped');
  assert.equal(driver.startOpts[1]?.bootstrapTurns, undefined, 'resume does NOT re-bootstrap');
  assert.equal(driver.startOpts[1]?.resume, 'sess-b', 'resume carried the session id');
  await lm.stop();
  bus.close();
});

test('H2 watchdog disabled (turnTimeoutMs=0): a silent turn does NOT fire', async () => {
  const bus = new IoBus();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 'sess-off', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'silence' },
    ],
  ]);
  let stalled = false;
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    // turnTimeoutMs omitted → disabled.
    onStall: () => {
      stalled = true;
    },
  });
  await lm.start();
  await lm.sendUserTurn({ text: 'no watchdog' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(stalled, false, 'no stall when the watchdog is disabled');
  await lm.stop();
  bus.close();
});

test('★ #8×#5: a QUEUED 2nd turn still gets heartbeat progress (outstanding-turns COUNTER, not a boolean)', async () => {
  // The cross-fix interaction: with the #5 turn queue, turn 2's sendUserTurn runs BEFORE
  // turn 1's result (turn 2 is held in the driver queue). A boolean progressActive cleared
  // on turn 1's result would lose turn 2's heartbeat entirely. A COUNTER keeps progress
  // active while ANY turn is outstanding → turn 2's mid-turn activity still pings.
  const bus = new IoBus();
  const progress: { kind: string; toolName?: string }[] = [];
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' }, // turn 1
      { do: 'emit', event: { kind: 'assistant', text: '', toolUses: [{ id: 'a', name: 'Bash', input: {} }] } }, // turn1 activity
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'a1' } }, // turn1 done
      { do: 'awaitTurn' }, // turn 2
      { do: 'emit', event: { kind: 'assistant', text: '', toolUses: [{ id: 'b', name: 'Read', input: {} }] } }, // turn2 activity → MUST ping
      { do: 'emit', event: { kind: 'tool_result', toolUseId: 'b', content: 'ok' } }, // turn2 activity → MUST ping
      { do: 'emit', event: { kind: 'result', sessionId: 's1', subtype: 'success', result: 'a2' } },
      { do: 'endClean' },
    ],
  ]);
  const lm = new LifecycleManager({
    driver,
    bus,
    logger: silentLogger(),
    onPermission: allow,
    onProgress: (info) => {
      progress.push(info);
    },
    onResult: () => {},
  });
  await lm.start();
  // BOTH turns injected before turn 1's result is processed (the queued-turn ordering):
  // the counter reaches 2, so turn 1's result decrements to 1 (still active) — turn 2's
  // activity then sees the counter > 0 and pings.
  await lm.sendUserTurn({ text: 'turn one' });
  await lm.sendUserTurn({ text: 'turn two' });
  await new Promise((r) => setTimeout(r, 80));
  await lm.stop();
  // turn 2 produced TWO activity events (Read + tool_result) — both must have pinged.
  const turn2Pings = progress.filter((p) => p.toolName === 'Read' || p.kind === 'tool_result').length;
  assert.ok(turn2Pings >= 2, `the queued turn 2 still got heartbeat pings (got ${turn2Pings}; 0 = the boolean bug)`);
  bus.close();
});
