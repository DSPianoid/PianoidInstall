/**
 * TG2 + TG3 — the loopback-safety property, unit-tested directly.
 *
 * The single most safety-critical rule: a live grammY poller starts ONLY with
 * `--live` AND a dedicated token; otherwise loopback. And the PRODUCTION token
 * can never reach a transport through this decision (the function never reads it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTransportDecision } from '../transport-policy.js';

test('TG2: no --live → loopback (safe default)', () => {
  const d = resolveTransportDecision({ live: false, dedicatedToken: 'dedicated-tok' });
  assert.equal(d.kind, 'loopback');
  assert.equal(d.refusedLive, false);
});

test('TG2: --live WITHOUT a dedicated token → loopback (refused, never polls prod)', () => {
  const d = resolveTransportDecision({ live: true, dedicatedToken: undefined });
  assert.equal(d.kind, 'loopback');
  assert.equal(d.refusedLive, true);
  assert.match(d.reason, /refusing to poll the production token/i);
});

test('TG2: --live WITH a dedicated token → grammy on that dedicated token', () => {
  const d = resolveTransportDecision({ live: true, dedicatedToken: 'dedicated-tok' });
  assert.equal(d.kind, 'grammy');
  assert.equal(d.token, 'dedicated-tok');
  assert.equal(d.refusedLive, false);
});

test('TG3: the production TELEGRAM_BOT_TOKEN can NEVER reach a grammy transport', () => {
  // Even with the production token set in env, the decision is driven ONLY by
  // the dedicated token argument; with no dedicated token, --live is refused.
  const prevProd = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'PRODUCTION-SECRET-must-not-poll';
    const d = resolveTransportDecision({ live: true, dedicatedToken: undefined });
    assert.equal(d.kind, 'loopback'); // refused — no grammy
    // The production secret never appears in the decision (it isn't read at all).
    assert.ok(!JSON.stringify(d).includes('PRODUCTION-SECRET'));
  } finally {
    if (prevProd === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevProd;
  }
});

test('TG3: a grammy decision only ever carries the DEDICATED token', () => {
  const d = resolveTransportDecision({ live: true, dedicatedToken: 'dedicated-only' });
  assert.equal(d.token, 'dedicated-only');
  // The shape never carries a production-token field.
  assert.ok(!('productionToken' in d));
});
