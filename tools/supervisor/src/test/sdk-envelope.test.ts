/**
 * Streaming-input ENVELOPE contract tests for SdkSessionDriver.
 *
 * REGRESSION GUARD for the live-demo crash: the driver was feeding the SDK's
 * stream-json input pump a malformed user-turn envelope (`{ type:'user', content }`),
 * which the real SDK rejects → the query() generator threw on the first injected
 * turn → the lifecycle treated it as a crash and restarted, dropping the turn (the
 * user got NO reply). The shape is now VERIFIED against the installed SDK's own
 * types (coreTypes.d.ts:396, SDKUserMessageContent). These tests pin that contract
 * so the envelope can't silently regress again — and would have FAILED against the
 * pre-fix `{type,content}` shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUserTurn, assertValidUserTurn } from '../adapters/sdk-session-driver.js';

test('makeUserTurn produces the SDK-required SDKUserMessageContent envelope', () => {
  const turn = makeUserTurn('Hi');
  // The exact shape the SDK streaming-input pump requires.
  assert.equal(turn.type, 'user');
  assert.deepEqual(turn.message, { role: 'user', content: 'Hi' });
  assert.equal(turn.parent_tool_use_id, null);
  // session_id is declared on SDKUserMessage; the SDK fills the real one for
  // streaming input, so we send an empty placeholder.
  assert.equal(turn.session_id, '');
});

test('assertValidUserTurn ACCEPTS the correct envelope', () => {
  assert.doesNotThrow(() => assertValidUserTurn(makeUserTurn('hello')));
});

test('assertValidUserTurn REJECTS the old malformed {type,content} shape (the live-demo bug)', () => {
  // This is EXACTLY what crashed the live session: no `message`, no
  // `parent_tool_use_id`, content at the wrong level.
  const malformed = { type: 'user', content: 'Hi' };
  assert.throws(() => assertValidUserTurn(malformed), /malformed user turn envelope/);
});

test('assertValidUserTurn REJECTS other malformations', () => {
  // message present but content is not a string
  assert.throws(() => assertValidUserTurn({ type: 'user', message: { role: 'user', content: 123 }, parent_tool_use_id: null }));
  // wrong role
  assert.throws(() => assertValidUserTurn({ type: 'user', message: { role: 'assistant', content: 'x' }, parent_tool_use_id: null }));
  // missing parent_tool_use_id
  assert.throws(() => assertValidUserTurn({ type: 'user', message: { role: 'user', content: 'x' } }));
  // wrong top-level type
  assert.throws(() => assertValidUserTurn({ type: 'tool_result', message: { role: 'user', content: 'x' }, parent_tool_use_id: null }));
  // null / non-object
  assert.throws(() => assertValidUserTurn(null));
  assert.throws(() => assertValidUserTurn('Hi'));
});
