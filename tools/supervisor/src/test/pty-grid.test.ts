/**
 * GridScreen unit tests — the @xterm/headless 2D grid reader (Option-A core).
 * Uses the REAL @xterm/headless (it's a runtime dep). Drives verbatim probe frames
 * and asserts the grid SEPARATES the message region (assistant content) from the
 * fixed footer block (chrome) — the thing the line-flatten parser could not do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridScreen } from '../adapters/pty-grid.js';

const CRLF = '\r\n';
const lines = (...ls: string[]): string => ls.join(CRLF) + CRLF;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// the option-A geometry: reply on its own row, footer hint bar on different rows below
const REPLY_FRAME = lines(
  '❯ Reply with exactly: GRID-OK-7',
  '● GRID-OK-7',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  gh auth login · ← for agents          ⧉ In analyse.md',
);

test('grid: readNewEvents extracts the CLEAN assistant reply, NOT the footer chrome', async () => {
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  g.write(REPLY_FRAME);
  await settle();
  const evs = g.readNewEvents();
  const texts = evs.filter((e) => e.kind === 'assistant').map((e) => (e as { text: string }).text);
  assert.ok(texts.some((t) => t.includes('GRID-OK-7')), `assistant reply extracted (got ${JSON.stringify(texts)})`);
  assert.ok(!texts.some((t) => /gh auth login|for agents|⧉ In/.test(t)), `no footer chrome in content (got ${JSON.stringify(texts)})`);
  assert.ok(!texts.some((t) => /^Reply with exactly/.test(t)), 'input echo not surfaced as content');
  g.dispose();
});

test('grid: readNewEvents de-dups across reads (no re-emit of already-surfaced rows)', async () => {
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  g.write(lines('● first line', '❯ '));
  await settle();
  const first = g.readNewEvents();
  assert.ok(first.some((e) => e.kind === 'assistant' && (e as { text: string }).text.includes('first line')));
  // a repaint with the SAME content + a NEW row
  g.write(lines('● first line', '● second line', '❯ '));
  await settle();
  const second = g.readNewEvents();
  // only the NEW row should surface (first line already surfaced)
  assert.ok(second.some((e) => e.kind === 'assistant' && (e as { text: string }).text.includes('second line')), 'new row surfaced');
  assert.ok(!second.some((e) => e.kind === 'assistant' && (e as { text: string }).text === 'first line'), 'old row NOT re-surfaced');
  g.dispose();
});

test('grid: spinner/status frames are NOT surfaced as assistant content', async () => {
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  // a real reply line interleaved with the live spinner/status frames
  g.write(lines('✽ Dilly-dallying…', '● the real answer', '✻ Sautéed for 1s', '↑ 231 tokens', '❯ '));
  await settle();
  const texts = g.readNewEvents().filter((e) => e.kind === 'assistant').map((e) => (e as { text: string }).text);
  assert.ok(texts.some((t) => t.includes('the real answer')), `real reply surfaced (got ${JSON.stringify(texts)})`);
  assert.ok(!texts.some((t) => /Dilly-dallying|Sautéed|tokens/.test(t)), `spinner/status filtered (got ${JSON.stringify(texts)})`);
  g.dispose();
});

test('grid: GERUND spinner WITHOUT a leading rune is rejected (the live "Orchestrating…" leak)', async () => {
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  // the live bug: the working-spinner gerund renders with NO leading rune
  g.write(lines('● the real answer', 'Orchestrating…', 'Orchestrating… (3s · ↑ 12 tokens)', 'esc to interrupt', '❯ '));
  await settle();
  const texts = g.readNewEvents().filter((e) => e.kind === 'assistant').map((e) => (e as { text: string }).text);
  assert.ok(texts.some((t) => t.includes('the real answer')), `real reply surfaced (got ${JSON.stringify(texts)})`);
  assert.ok(!texts.some((t) => /Orchestrating|esc to interrupt|tokens/.test(t)), `bare gerund spinner rejected (got ${JSON.stringify(texts)})`);
  g.dispose();
});

test('grid: ★ HEAVY multi-row answer (● head + continuations + blank paragraphs + trailing spinner) → ONE clean block + currentAnswerText', async () => {
  const g = new GridScreen({ cols: 120, rows: 40 });
  await g.init();
  // the exact structure from the heavy-turn repro: a "●" head, a list, a blank
  // paragraph break, a sub-section, the final token on its own line, THEN a trailing
  // spinner + footer (the live failure shape that leaked the spinner + dropped this).
  g.write(
    lines(
      '● Files in tools/supervisor/src:',
      '  - capture-store.ts',
      '  - index.ts',
      '',
      '  package.json:',
      '  Version 0.2.0-phase2 — supervisor.',
      '  Dependencies: @xterm/headless, grammy, node-pty.',
      '',
      '  HEAVYDONE-42',
      '✻ Baked for 6s',
      '────────────────────────────────────────',
      '❯ ',
      '  gh auth login · ← for agents          ⧉ In analyse.md',
    ),
  );
  await settle();
  const texts = g
    .readNewEvents()
    .filter((e) => e.kind === 'assistant' && (e as { text: string }).text)
    .map((e) => (e as { text: string }).text);
  assert.equal(texts.length, 1, `one assistant block (got ${texts.length}: ${JSON.stringify(texts)})`);
  assert.ok(texts[0]!.includes('Files in tools/supervisor/src'), 'block has the head');
  assert.ok(texts[0]!.includes('HEAVYDONE-42'), 'block has the final token (continuation rows kept across blank lines)');
  assert.ok(!/Baked for|gh auth|for agents|esc to interrupt/.test(texts[0]!), 'no spinner/chrome in the block');
  const ans = g.currentAnswerText();
  assert.ok(ans && ans.includes('HEAVYDONE-42'), `currentAnswerText has the final token (got ${JSON.stringify(ans)})`);
  assert.ok(ans && !/Baked for|gh auth|for agents/.test(ans), 'currentAnswerText is clean (no spinner/chrome)');
  g.dispose();
});

test('grid: detectPermission reads the prompt header from the grid (tool + arg)', async () => {
  const g = new GridScreen({ cols: 80, rows: 24 });
  await g.init();
  g.write(
    lines(
      ' Create file',
      ' probe_marker.txt',
      '  1 PROBE-OK-98765',
      ' Do you want to create probe_marker.txt?',
      ' ❯ 1. Yes',
      '   3. No',
    ),
  );
  await settle();
  const perm = g.detectPermission();
  assert.ok(perm, 'permission detected');
  assert.equal(perm!.toolName, 'Write');
  assert.equal(perm!.input['file_path'], 'probe_marker.txt'); // NOT the diff line "1 PROBE-OK-98765"
  g.dispose();
});

test('grid: detectTrustGate + isInputReady', async () => {
  const g = new GridScreen({ cols: 80, rows: 20 });
  await g.init();
  g.write(lines(' Quick safety check: Is this a project you created or one you trust?', ' ❯ 1. Yes, I trust this folder'));
  await settle();
  assert.equal(g.detectTrustGate(), true);
  g.dispose();

  const g2 = new GridScreen({ cols: 80, rows: 20 });
  await g2.init();
  g2.write(lines('● done', '────────────', '❯ Try "refactor"', '  ? for shortcuts'));
  await settle();
  assert.equal(g2.isInputReady(), true, 'input box idle → ready');
  g2.dispose();
});
