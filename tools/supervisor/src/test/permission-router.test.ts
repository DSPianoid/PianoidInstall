/**
 * PermissionRouter tests — the FC-1 decision logic: allow-list fast-path,
 * deny-list, route-over-channel (allow/deny/timeout), and fallback modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionRouter, type PermissionChannel } from '../permission-router.js';
import type { PermissionRequest } from '../session-driver.js';

function fakeChannel(verdict: 'allow' | 'deny' | 'timeout'): PermissionChannel & { asks: PermissionRequest[] } {
  const asks: PermissionRequest[] = [];
  return {
    asks,
    askUser: async (req) => {
      asks.push(req);
      return verdict;
    },
  };
}

const req = (toolName: string): PermissionRequest => ({ toolName, input: {} });

test('allow-list fast-path → allow, no channel ask', async () => {
  const ch = fakeChannel('deny');
  const r = new PermissionRouter({ policy: { allow: ['Read', 'mcp__telegram__*'] }, channel: ch });
  assert.deepEqual(await r.decide(req('Read')), { behavior: 'allow' });
  assert.deepEqual(await r.decide(req('mcp__telegram__reply')), { behavior: 'allow' });
  assert.equal(ch.asks.length, 0, 'allow-list never asks the user');
});

test('deny-list → deny (takes precedence over allow)', async () => {
  const ch = fakeChannel('allow');
  const r = new PermissionRouter({ policy: { allow: ['Bash'], deny: ['Bash'] }, channel: ch });
  const d = await r.decide(req('Bash'));
  assert.equal(d.behavior, 'deny');
  assert.equal(ch.asks.length, 0);
});

test('safety floor → routes to user → ALLOW', async () => {
  const ch = fakeChannel('allow');
  const r = new PermissionRouter({ policy: { allow: ['Read'] }, channel: ch });
  const d = await r.decide(req('Bash'));
  assert.deepEqual(d, { behavior: 'allow' });
  assert.equal(ch.asks.length, 1, 'routed to the user');
  assert.equal(ch.asks[0]!.toolName, 'Bash');
});

test('safety floor → routes to user → DENY', async () => {
  const ch = fakeChannel('deny');
  const r = new PermissionRouter({ policy: { allow: ['Read'] }, channel: ch });
  const d = await r.decide(req('Write'));
  assert.equal(d.behavior, 'deny');
});

test('safety floor → user TIMEOUT → fail-safe DENY', async () => {
  const ch = fakeChannel('timeout');
  const r = new PermissionRouter({ policy: { allow: [] }, channel: ch });
  const d = await r.decide(req('Bash'));
  assert.equal(d.behavior, 'deny');
  assert.match((d as { message: string }).message, /No approval received/i);
  assert.equal(r.getStats().timedOut, 1);
});

test("fallback 'deny' denies unmatched without asking", async () => {
  const ch = fakeChannel('allow');
  const r = new PermissionRouter({ policy: { allow: ['Read'], fallback: 'deny' }, channel: ch });
  const d = await r.decide(req('Bash'));
  assert.equal(d.behavior, 'deny');
  assert.equal(ch.asks.length, 0, 'fallback=deny does not ask');
});

test("fallback 'allow' allows unmatched without asking", async () => {
  const ch = fakeChannel('deny');
  const r = new PermissionRouter({ policy: { allow: [], fallback: 'allow' }, channel: ch });
  const d = await r.decide(req('Bash'));
  assert.equal(d.behavior, 'allow');
  assert.equal(ch.asks.length, 0);
});

test('stats track allowed/denied/routed/timedOut', async () => {
  const r = new PermissionRouter({ policy: { allow: ['Read'] }, channel: fakeChannel('allow') });
  await r.decide(req('Read')); // allowed (list)
  await r.decide(req('Bash')); // routed → allowed
  const s = r.getStats();
  assert.equal(s.allowed, 2);
  assert.equal(s.routed, 1);
});

test('wildcard matching: prefix* matches, non-prefix does not', async () => {
  const ch = fakeChannel('deny');
  const r = new PermissionRouter({ policy: { allow: ['mcp__telegram__*'] }, channel: ch });
  assert.equal((await r.decide(req('mcp__telegram__reply'))).behavior, 'allow');
  assert.equal((await r.decide(req('mcp__github__issue'))).behavior, 'deny'); // routed→deny
});

// ── Safety-floor predicate (routeWhen) — the orchestrator profile ────────────

const reqWith = (toolName: string, input: Record<string, unknown>): PermissionRequest => ({ toolName, input });

test('routeWhen ROUTES a destructive op even when the tool is allow-listed', async () => {
  const ch = fakeChannel('deny'); // user denies the routed destructive op
  const r = new PermissionRouter({
    policy: {
      allow: ['Bash'], // Bash is broadly allowed …
      routeWhen: (name, input) => name === 'Bash' && String(input['command'] ?? '').includes('rm -rf'),
    },
    channel: ch,
  });
  // A safe Bash command is allowed WITHOUT asking (allow-list).
  assert.equal((await r.decide(reqWith('Bash', { command: 'ls' }))).behavior, 'allow');
  assert.equal(ch.asks.length, 0, 'safe command not routed');
  // A destructive Bash command is ROUTED (the predicate wins over the allow-list).
  const d = await r.decide(reqWith('Bash', { command: 'rm -rf /' }));
  assert.equal(ch.asks.length, 1, 'destructive command routed to the user');
  assert.equal(d.behavior, 'deny', 'user denied → denied');
});

test('routeWhen does NOT fire for non-matching ops (allow-list still fast-paths)', async () => {
  const ch = fakeChannel('deny');
  const r = new PermissionRouter({
    policy: { allow: ['Read', 'Bash'], routeWhen: () => false },
    channel: ch,
  });
  assert.equal((await r.decide(reqWith('Read', {}))).behavior, 'allow');
  assert.equal((await r.decide(reqWith('Bash', { command: 'git status' }))).behavior, 'allow');
  assert.equal(ch.asks.length, 0);
});

test('deny-list still wins over routeWhen', async () => {
  const ch = fakeChannel('allow');
  const r = new PermissionRouter({
    policy: { allow: ['Bash'], deny: ['Bash'], routeWhen: () => true },
    channel: ch,
  });
  const d = await r.decide(reqWith('Bash', { command: 'rm -rf x' }));
  assert.equal(d.behavior, 'deny', 'deny-list beats the safety-floor route');
  assert.equal(ch.asks.length, 0, 'denied outright, never asked');
});
