/**
 * Channel-tool handler tests (SDK-agnostic — the reply handler maps to the
 * injected replyFn and returns a CallToolResult). The SDK glue (createSdkMcpServer)
 * is not exercised here (it's dynamic-imported at runtime); the handler IS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReplyHandler } from '../channel-tool.js';

test('reply handler sends text via replyFn and returns sent', async () => {
  const sent: string[] = [];
  const handler = makeReplyHandler(async (text) => {
    sent.push(text);
    return { ok: true };
  });
  const res = await handler({ text: 'hello user' });
  assert.deepEqual(sent, ['hello user']);
  assert.ok(!res.isError, 'success → not an error');
  assert.equal(res.content[0]!.text, 'sent');
});

test('reply handler rejects empty text', async () => {
  const handler = makeReplyHandler(async () => ({ ok: true }));
  const res = await handler({ text: '   ' });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /empty/);
});

test('reply handler surfaces a send failure', async () => {
  const handler = makeReplyHandler(async () => ({ ok: false }));
  const res = await handler({ text: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /send failed/);
});

test('reply handler catches a throwing replyFn', async () => {
  const handler = makeReplyHandler(async () => {
    throw new Error('channel down');
  });
  const res = await handler({ text: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /send error/);
});
