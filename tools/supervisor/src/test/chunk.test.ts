/** M4 — safe-boundary text chunking (no surrogate split, prefer whitespace). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../adapters/telegram.js';

test('short text is a single chunk', () => {
  assert.deepEqual(chunkText('hello', 4096), ['hello']);
});

test('every chunk is within the limit and they reassemble to the original', () => {
  const text = 'x'.repeat(4096 * 2 + 10);
  const chunks = chunkText(text, 4096);
  assert.ok(chunks.every((c) => c.length <= 4096));
  assert.equal(chunks.join(''), text);
});

test('prefers a newline boundary in the back half of the window', () => {
  // limit 10; a newline at index 7 → first chunk should end after the newline.
  const text = 'abcdefg\nhijklmnop';
  const chunks = chunkText(text, 10);
  assert.equal(chunks[0], 'abcdefg\n');
  assert.equal(chunks.join(''), text);
});

test('prefers a space boundary when no newline is in range', () => {
  const text = 'aaaaaa bbbbbbcccccc';
  const chunks = chunkText(text, 10);
  assert.equal(chunks[0], 'aaaaaa '); // breaks at the space
  assert.equal(chunks.join(''), text);
});

test('does not split a surrogate pair at the hard boundary', () => {
  // '😀' is a surrogate pair (2 UTF-16 units). Build a string whose limit lands
  // exactly between the high and low surrogate, and assert no chunk ends on a
  // lone high surrogate.
  const emoji = '😀';
  const text = 'a'.repeat(9) + emoji + 'b'.repeat(9); // limit 10 lands mid-emoji
  const chunks = chunkText(text, 10);
  for (const c of chunks) {
    const last = c.charCodeAt(c.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no chunk ends on a lone high surrogate');
  }
  assert.equal(chunks.join(''), text);
});

test('hard-cuts when no whitespace boundary exists in range', () => {
  const text = 'x'.repeat(25);
  const chunks = chunkText(text, 10);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [10, 10, 5],
  );
});
