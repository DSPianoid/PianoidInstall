/**
 * STARTUP CONTEXT-PICKUP tests (the parent-restart auto-resume mechanism).
 *
 * After a supervisor PARENT/`dist` restart (restart-supervisor.ps1 → a brand-new supervisor
 * process + a COLD orchestrator) the fresh session used to boot blank — the human had to
 * re-send "Hi" before the orchestrator engaged. The fix: a supervisor-STARTUP parameter
 * `SUPERVISOR_STARTUP_HANDOFF_FILE` (a file the parent-restart STAGES; the launcher passes the
 * env) whose contents are injected into the fresh session's FIRST real user turn (AFTER the
 * `/orchestrator` role prefix). One-shot. Unset/absent ⇒ byte-for-byte today.
 *
 * Two layers tested here:
 *   1. config resolution — resolveStartupHandoffFile / resolveStartupHandoff (pure + fail-soft).
 *   2. SessionHost first-turn injection — the staged note splices BETWEEN the role prefix and the
 *      user's message; consumed once; absent → the prior behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionHost } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult, ReplyHandle } from '../contract.js';
import { resolveStartupHandoff, resolveStartupHandoffFile } from '../config.js';
import { tmpDir } from './helpers.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}
const inbound = (text: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-20T00:00:00Z',
  replyHandle: { to: '555' },
  channel: 'telegram',
});
function makeSendCapture() {
  const sent: { text: string }[] = [];
  const send = async (_h: ReplyHandle, msg: { text?: string }): Promise<OutboundResult> => {
    sent.push({ text: msg.text ?? '' });
    return { ok: true, sentIds: ['1'] };
  };
  return { sent, send };
}

// ── 1. config resolution ───────────────────────────────────────────────────────

test('resolveStartupHandoffFile: unset/blank → undefined; a set path is used (trimmed)', () => {
  assert.equal(resolveStartupHandoffFile(undefined), undefined, 'unset → no pickup');
  assert.equal(resolveStartupHandoffFile(''), undefined, 'blank → no pickup');
  assert.equal(resolveStartupHandoffFile('   '), undefined, 'whitespace → no pickup');
  assert.equal(resolveStartupHandoffFile('  D:\\tmp\\h.txt  '), 'D:\\tmp\\h.txt', 'set → trimmed path');
});

test('resolveStartupHandoff: reads a staged non-empty file → trimmed note; absent/empty → undefined', () => {
  const { dir, cleanup } = tmpDir('startup-handoff-');
  try {
    const file = join(dir, 'handoff.txt');
    writeFileSync(file, '  Resume: branch X, live-test Y.\n', 'utf8');
    assert.equal(resolveStartupHandoff(file), 'Resume: branch X, live-test Y.', 'non-empty file → trimmed contents');

    // Empty / whitespace-only file → undefined (no pickup).
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '   \n', 'utf8');
    assert.equal(resolveStartupHandoff(empty), undefined, 'empty file → no pickup');

    // Missing file → undefined (fail-soft, the common normal-boot case).
    assert.equal(resolveStartupHandoff(join(dir, 'nope.txt')), undefined, 'missing file → no pickup');
    // No path at all → undefined.
    assert.equal(resolveStartupHandoff(undefined), undefined, 'no path → no pickup');
  } finally {
    cleanup();
  }
});

test('resolveStartupHandoff is FAIL-SOFT: a read error degrades to undefined (never throws at boot)', () => {
  const thrower = () => {
    throw new Error('EACCES');
  };
  assert.equal(resolveStartupHandoff('D:\\tmp\\locked.txt', thrower), undefined, 'read error → undefined, no crash');
});

// ── 2. SessionHost first-turn injection ─────────────────────────────────────────

function makeHost(opts: { roleTurnPrefix?: string; startupHandoff?: string }) {
  const bus = new IoBus();
  const cap = makeSendCapture();
  const driver = new FakeSessionDriver([
    [
      { do: 'emit', event: { kind: 'system_init', sessionId: 's1', model: 'm' } },
      { do: 'awaitTurn' },
      { do: 'awaitTurn' },
    ],
  ]);
  const host = new SessionHost({
    driver,
    bus,
    logger: silentLogger(),
    send: cap.send,
    policy: { allow: ['Read'] },
    ...(opts.roleTurnPrefix ? { roleTurnPrefix: opts.roleTurnPrefix } : {}),
    ...(opts.startupHandoff ? { startupHandoff: opts.startupHandoff } : {}),
  });
  return { bus, cap, driver, host };
}

test('startupHandoff is spliced into the FIRST turn (after the role prefix), ONE-shot', async () => {
  const { bus, driver, host } = makeHost({
    roleTurnPrefix: '/orchestrator',
    startupHandoff: 'Prior session: control-plane fixes on branch B; live-test /control.',
  });
  await host.start();
  await new Promise((r) => setTimeout(r, 20));
  // No pre-user bootstrap (same anti-pattern guard as roleTurnPrefix).
  assert.equal(driver.sentTurns.length, 0, 'no pre-user turn');

  await host.handleInbound(inbound('Hi'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns.length, 1);
  const first = driver.sentTurns[0]!.text;
  // Order: role prefix FIRST, then the user's message, then the staged handoff brief.
  assert.match(first, /^\/orchestrator\n\n/, 'role prefix leads');
  assert.match(first, /\bHi\b/, "carries the user's first message");
  assert.match(first, /\[SUPERVISOR startup handoff\]/, 'carries the startup handoff marker');
  assert.match(first, /control-plane fixes on branch B/, 'carries the staged brief text');

  // ONE-shot: the second turn is the bare user text (no handoff, no prefix).
  await host.handleInbound(inbound('next task'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns[1]!.text, 'next task', 'handoff applied only once');
  await host.stop();
  bus.close();
});

test('startupHandoff WITHOUT a role prefix still injects on the first turn (after the user text)', async () => {
  const { bus, driver, host } = makeHost({ startupHandoff: 'resume note Z' });
  await host.start();
  await new Promise((r) => setTimeout(r, 20));
  await host.handleInbound(inbound('hello'));
  await new Promise((r) => setTimeout(r, 20));
  const first = driver.sentTurns[0]!.text;
  assert.doesNotMatch(first, /\/orchestrator/, 'no role prefix when none set');
  assert.match(first, /^hello\n\n\[SUPERVISOR startup handoff\]/, 'user text then the handoff');
  assert.match(first, /resume note Z/);
  await host.stop();
  bus.close();
});

test('NO startupHandoff → byte-for-byte: the first turn is exactly the role prefix + user text', async () => {
  const { bus, driver, host } = makeHost({ roleTurnPrefix: '/orchestrator' }); // no startupHandoff
  await host.start();
  await new Promise((r) => setTimeout(r, 20));
  await host.handleInbound(inbound('please do task X'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(driver.sentTurns.length, 1);
  // EXACTLY the pre-feature shape (the roleTurnPrefix test's invariant) — no handoff spliced in.
  assert.match(driver.sentTurns[0]!.text, /^\/orchestrator\n\nplease do task X$/);
  await host.stop();
  bus.close();
});
