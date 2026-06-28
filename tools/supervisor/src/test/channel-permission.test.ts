/**
 * ChannelPermission tests — the route-out + block-on-reply round-trip + the
 * permission-reply parser. (The fail-safe timeout path is covered via the router
 * + session-host tests; here we use a short timeout to exercise it directly.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelPermission } from '../channel-permission.js';
import type { ReplyHandle } from '../contract.js';
import type { PermissionRequest } from '../session-driver.js';

const operator: ReplyHandle = { to: '555' };
const req: PermissionRequest = { toolName: 'Bash', input: { command: 'ls' } };

test('askUser sends a prompt and resolves when submitReply matches the code', async () => {
  const sent: string[] = [];
  const cp = new ChannelPermission({
    send: async (_h, text) => {
      sent.push(text);
      return undefined;
    },
    operator,
    timeoutMs: 5000,
  });
  const p = cp.askUser(req);
  // Give the async send a tick.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1, 'a prompt was sent');
  // Extract the code the prompt minted (4 hex).
  const m = /allow ([0-9a-f]{4})/.exec(sent[0]!);
  assert.ok(m, 'prompt contains an allow <code>');
  assert.equal(cp.pendingCount, 1);
  const ok = cp.submitReply(m![1]!, 'allow');
  assert.equal(ok, true);
  assert.equal(await p, 'allow');
  assert.equal(cp.pendingCount, 0);
});

/**
 * The permission timeout timer is `unref()`'d in production (a pending ask must
 * not keep the process alive). In a test that means an idle loop would exit
 * before the unref'd timer fires — so we keep a REF'd keep-alive timer running
 * a bit longer than the permission timeout, letting the unref'd timer fire and
 * settle the promise. Returns the awaited result.
 */
async function awaitWithKeepAlive<T>(p: Promise<T>, keepAliveMs: number): Promise<T> {
  const [res] = await Promise.all([p, new Promise((r) => setTimeout(r, keepAliveMs))]);
  return res;
}

test('submitReply with a wrong code does not resolve (returns false)', async () => {
  const cp = new ChannelPermission({ send: async () => undefined, operator, timeoutMs: 30 });
  const p = cp.askUser(req);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cp.submitReply('zzzz', 'allow'), false);
  assert.equal(cp.pendingCount, 1, 'still pending after a non-matching reply');
  // Let it time out (keep the loop alive so the unref'd timer fires).
  assert.equal(await awaitWithKeepAlive(p, 60), 'timeout');
});

test('no reply within timeout → resolves "timeout"', async () => {
  const cp = new ChannelPermission({ send: async () => undefined, operator, timeoutMs: 30 });
  const verdict = await awaitWithKeepAlive(cp.askUser(req), 60);
  assert.equal(verdict, 'timeout');
  assert.equal(cp.pendingCount, 0);
});

test('a failing send → resolves "timeout" (fail-safe; cannot ask)', async () => {
  const cp = new ChannelPermission({
    send: async () => {
      throw new Error('channel down');
    },
    operator,
    timeoutMs: 5000,
  });
  const verdict = await cp.askUser(req);
  assert.equal(verdict, 'timeout');
});

test('parseReply recognizes allow/deny/y/n + 4-hex code, rejects junk', () => {
  assert.deepEqual(ChannelPermission.parseReply('allow ab12'), { code: 'ab12', verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseReply('deny ab12'), { code: 'ab12', verdict: 'deny' });
  assert.deepEqual(ChannelPermission.parseReply('y abcd'), { code: 'abcd', verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseReply('  N  0f0f '), { code: '0f0f', verdict: 'deny' });
  assert.equal(ChannelPermission.parseReply('hello there'), null);
  assert.equal(ChannelPermission.parseReply('allow xyz'), null); // not 4 hex
  assert.equal(ChannelPermission.parseReply('allow abc'), null); // too short
});

// H1 / demo finding — a BARE verdict (no code).
test('parseBareReply recognizes a bare allow/deny/y/n/yes/no, rejects junk + coded', () => {
  assert.deepEqual(ChannelPermission.parseBareReply('allow'), { verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseBareReply('Deny'), { verdict: 'deny' }); // case-insensitive (the exact demo input)
  assert.deepEqual(ChannelPermission.parseBareReply('  yes '), { verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseBareReply('n'), { verdict: 'deny' });
  assert.equal(ChannelPermission.parseBareReply('allow ab12'), null); // coded form is NOT a bare reply
  assert.equal(ChannelPermission.parseBareReply('please deny it'), null);
  assert.equal(ChannelPermission.parseBareReply('hello'), null);
});

test('submitBareReply resolves the SINGLE pending ask (no code needed)', async () => {
  const cp = new ChannelPermission({ send: async () => undefined, operator, timeoutMs: 5000 });
  const p = cp.askUser(req);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cp.pendingCount, 1);
  assert.equal(cp.submitBareReply('deny'), true, 'bare reply resolved the single pending ask');
  assert.equal(await p, 'deny');
  assert.equal(cp.pendingCount, 0);
});

test('submitBareReply does NOT resolve when 0 or >1 asks are pending (ambiguous)', async () => {
  const cp = new ChannelPermission({ send: async () => undefined, operator, timeoutMs: 40 });
  // 0 pending → false.
  assert.equal(cp.submitBareReply('allow'), false, 'nothing to answer');
  // 2 pending → ambiguous → false (the coded form is required to disambiguate).
  const p1 = cp.askUser({ toolName: 'Bash', input: {} });
  const p2 = cp.askUser({ toolName: 'Write', input: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cp.pendingCount, 2);
  assert.equal(cp.submitBareReply('deny'), false, 'ambiguous with >1 pending');
  assert.equal(cp.pendingCount, 2, 'both still pending');
  // Let them time out (keep the loop alive for the unref'd timers).
  assert.deepEqual(await awaitWithKeepAlive(Promise.all([p1, p2]), 70), ['timeout', 'timeout']);
});

// FIX 1 — native inline-keyboard BUTTONS (callback_data scheme + send + resolution).
test('parseCallbackData recognizes the perm:allow/deny:<code> button scheme, rejects junk', () => {
  assert.deepEqual(ChannelPermission.parseCallbackData('perm:allow:ab12'), { code: 'ab12', verdict: 'allow' });
  assert.deepEqual(ChannelPermission.parseCallbackData('perm:deny:0f0f'), { code: '0f0f', verdict: 'deny' });
  assert.equal(ChannelPermission.parseCallbackData('other:allow:ab12'), null, 'foreign callback_data left alone');
  assert.equal(ChannelPermission.parseCallbackData('perm:allow:zz'), null, 'bad code rejected');
});

test('askUser attaches the ✅/❌ buttons; submitReplyDetailed returns the prompt message id', async () => {
  let buttons: { text: string; callbackData: string }[] | undefined;
  const cp = new ChannelPermission({
    send: async (_h, _text, b) => {
      buttons = b;
      return { messageId: 'm-42' };
    },
    operator,
    timeoutMs: 5000,
  });
  const p = cp.askUser(req);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(buttons && buttons.length === 2, 'two inline buttons attached');
  const cb = ChannelPermission.parseCallbackData(buttons![0]!.callbackData)!;
  const res = cp.submitReplyDetailed(cb.code, 'allow');
  assert.equal(res.resolved, true);
  assert.equal(res.messageId, 'm-42', 'the prompt message id is returned so it can be edited');
  assert.equal(res.toolName, 'Bash');
  assert.equal(await p, 'allow');
});
