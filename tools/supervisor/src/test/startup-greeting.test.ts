/**
 * STARTUP GREETING tests — the proactive "I'm back" on a fresh (re)started session.
 *
 * Prior behavior: a freshly-restarted orchestrator sat MUTE until the user sent a message to
 * "nudge" the cold session awake (the human had to re-send "Hi"). The fix: the SessionHost
 * PERSISTS the bound operator's channel address, and on a fresh start() with `startupGreeting` ON
 * it RESTORES that operator and fires a synthetic, NON-NUDGY greeting turn (role prefix + an
 * "I'm back" instruction, no pending-work prompts). No persisted operator (first-ever cold boot)
 * ⇒ stays silent (nobody to greet). Disabled ⇒ byte-for-byte the prior deferred behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SessionHost } from '../session-host.js';
import { IoBus } from '../io-bus.js';
import { Logger } from '../logger.js';
import { FakeSessionDriver } from './fake-session-driver.js';
import type { InboundMessage, OutboundResult, ReplyHandle } from '../contract.js';
import { resolveStartupGreeting } from '../config.js';
import { tmpDir } from './helpers.js';

function silentLogger(): Logger {
  return new Logger({ level: 'error', stderr: false });
}
const inbound = (text: string): InboundMessage => ({
  text,
  attachments: [],
  user: 'tester',
  userId: 'u-tester',
  ts: '2026-06-21T00:00:00Z',
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
function makeHost(opts: {
  startupGreeting?: boolean;
  operatorStateFile?: string;
  roleTurnPrefix?: string;
  startupHandoff?: string;
}) {
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
    roleTurnPrefix: opts.roleTurnPrefix ?? '/orchestrator',
    ...(opts.startupGreeting !== undefined ? { startupGreeting: opts.startupGreeting } : {}),
    ...(opts.operatorStateFile ? { operatorStateFile: opts.operatorStateFile } : {}),
    ...(opts.startupHandoff ? { startupHandoff: opts.startupHandoff } : {}),
  });
  return { bus, cap, driver, host };
}

// ── config resolution ───────────────────────────────────────────────────────────

test('resolveStartupGreeting: DEFAULT ON (unset → on); explicit off-words disable', () => {
  assert.equal(resolveStartupGreeting(undefined), true, 'unset → ON (default)');
  assert.equal(resolveStartupGreeting(''), true, 'blank → ON (default)');
  assert.equal(resolveStartupGreeting('on'), true);
  for (const off of ['0', 'false', 'off', 'none', 'OFF', 'False']) {
    assert.equal(resolveStartupGreeting(off), false, `'${off}' → OFF`);
  }
});

// ── SessionHost behavior ──────────────────────────────────────────────────────────

test('persists the operator on first inbound (so a later restart knows who to greet)', async () => {
  const { dir, cleanup } = tmpDir('startup-greeting-');
  try {
    const file = join(dir, 'operator.json');
    const { bus, driver, host } = makeHost({ startupGreeting: false, operatorStateFile: file });
    await host.start();
    await new Promise((r) => setTimeout(r, 20));
    // Greeting disabled + no prior file → NO proactive turn on boot.
    assert.equal(driver.sentTurns.length, 0, 'no proactive greeting when disabled');
    assert.equal(existsSync(file), false, 'no operator file before any inbound');

    await host.handleInbound(inbound('Hi'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(file), true, 'operator persisted after first inbound');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { to?: string };
    assert.equal(saved.to, '555', 'persisted the operator chat address');
    await host.stop();
    bus.close();
  } finally {
    cleanup();
  }
});

test('fresh start with a persisted operator → fires a NON-NUDGY greeting turn (no inbound needed)', async () => {
  const { dir, cleanup } = tmpDir('startup-greeting-');
  try {
    const file = join(dir, 'operator.json');
    writeFileSync(file, JSON.stringify({ operatorId: 'u-tester', to: '555' }), 'utf8');
    const { bus, cap, driver, host } = makeHost({ startupGreeting: true, operatorStateFile: file });
    await host.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(driver.sentTurns.length, 1, 'a proactive greeting turn fired on boot (no inbound)');
    const g = driver.sentTurns[0]!.text;
    assert.match(g, /^\/orchestrator\n\n/, 'role prefix leads the greeting turn');
    assert.match(g, /\[SUPERVISOR startup greeting\]/, 'carries the startup-greeting marker');
    assert.match(g, /Do NOT nudge/, 'instructs a non-nudgy greeting');
    // The operator is now bound (the restored address), so a subsequent inbound from the SAME
    // user is accepted rather than treated as a fresh bind.
    assert.equal(cap.sent.length, 0, 'the greeting is a TURN, not a direct supervisor send');
    await host.stop();
    bus.close();
  } finally {
    cleanup();
  }
});

test('fresh start with NO persisted operator → stays silent (nobody to greet)', async () => {
  const { dir, cleanup } = tmpDir('startup-greeting-');
  try {
    const file = join(dir, 'operator.json'); // does NOT exist yet
    const { bus, driver, host } = makeHost({ startupGreeting: true, operatorStateFile: file });
    await host.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(driver.sentTurns.length, 0, 'no greeting when there is no prior operator');
    // Drain the parked turn-waiter for a clean teardown (mirrors the startup-handoff tests).
    await host.handleInbound(inbound('ping'));
    await new Promise((r) => setTimeout(r, 20));
    await host.stop();
    bus.close();
  } finally {
    cleanup();
  }
});

test('greeting OFF + a persisted operator → byte-for-byte: no proactive turn (deferred behavior)', async () => {
  const { dir, cleanup } = tmpDir('startup-greeting-');
  try {
    const file = join(dir, 'operator.json');
    writeFileSync(file, JSON.stringify({ operatorId: 'u-tester', to: '555' }), 'utf8');
    const { bus, driver, host } = makeHost({ startupGreeting: false, operatorStateFile: file });
    await host.start();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(driver.sentTurns.length, 0, 'disabled → no proactive greeting even with a persisted operator');
    // Drain the parked turn-waiter for a clean teardown (mirrors the startup-handoff tests).
    await host.handleInbound(inbound('ping'));
    await new Promise((r) => setTimeout(r, 20));
    await host.stop();
    bus.close();
  } finally {
    cleanup();
  }
});

test('greeting splices the startup-handoff brief in (for context) but stays one-shot', async () => {
  const { dir, cleanup } = tmpDir('startup-greeting-');
  try {
    const file = join(dir, 'operator.json');
    writeFileSync(file, JSON.stringify({ operatorId: 'u-tester', to: '555' }), 'utf8');
    const { bus, driver, host } = makeHost({
      startupGreeting: true,
      operatorStateFile: file,
      startupHandoff: 'Prior session: removed the relaunch guard on branch B.',
    });
    await host.start();
    await new Promise((r) => setTimeout(r, 20));
    const g = driver.sentTurns[0]!.text;
    assert.match(g, /removed the relaunch guard on branch B/, 'carries the prior-session brief for context');
    assert.match(g, /do NOT act on it unsolicited/, 'but instructs not to act on it unsolicited');
    await host.stop();
    bus.close();
  } finally {
    cleanup();
  }
});
