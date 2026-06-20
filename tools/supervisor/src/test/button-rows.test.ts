/**
 * Inline-keyboard ROW LAYOUT tests (the /control-menu "14 buttons in one row" fix).
 *
 * The grammY transport's `buildInlineKeyboard` is the single point where the flat
 * `InlineButton[]` becomes Telegram's `inline_keyboard` (a Button[][]). Before the fix
 * it put EVERY button in one row → a 14-action menu squeezed each label to ~1/14 width
 * (only the emoji showed). The fix adds a `buttonsPerRow` hint: omitted/≤0 → a single row
 * (the 2-button permission Allow/Deny prompt is byte-for-byte), N>0 → wrap into rows of N.
 *
 * These assert directly on the REAL keyboard the transport builds (grammY exposes
 * `.inline_keyboard`), plus the control menu's end-to-end hint (buildControlMenu →
 * CONTROL_MENU_BUTTONS_PER_ROW). No network: InlineKeyboard is a pure builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInlineKeyboard } from '../adapters/grammy-transport.js';
import {
  buildControlMenu,
  buildModelSubmenu,
  CONTROL_ACTIONS,
  CONTROL_MENU_BUTTONS_PER_ROW,
} from '../control-command.js';

/** The (text-only) row shape of a built keyboard, for compact assertions. */
function rows(kb: { inline_keyboard: { text: string }[][] }): string[][] {
  return kb.inline_keyboard.map((r) => r.map((b) => b.text));
}

const btns = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `b${i}`, callbackData: `c${i}` }));

test('buildInlineKeyboard: NO perRow → a SINGLE row (the permission Allow/Deny prompt is unchanged)', () => {
  // The exact perm-prompt keyboard (2 buttons, no hint) → one row of two (today's UX).
  const kb = buildInlineKeyboard([
    { text: '✅ Allow', callbackData: 'perm:allow:ab12' },
    { text: '❌ Deny', callbackData: 'perm:deny:ab12' },
  ]);
  assert.deepEqual(rows(kb), [['✅ Allow', '❌ Deny']], 'perm prompt stays a single 2-button row');
  // A longer list with no hint also stays one row (prior behavior preserved).
  assert.equal(buildInlineKeyboard(btns(5)).inline_keyboard.length, 1, '5 buttons, no hint → 1 row');
});

test('buildInlineKeyboard: perRow=2 wraps into rows of at most 2 (the readable grid)', () => {
  assert.deepEqual(rows(buildInlineKeyboard(btns(4), 2)), [['b0', 'b1'], ['b2', 'b3']], '4 → 2 rows of 2');
  // Odd count → the last row holds the remainder.
  assert.deepEqual(rows(buildInlineKeyboard(btns(5), 2)), [['b0', 'b1'], ['b2', 'b3'], ['b4']], '5 → 2,2,1');
});

test('buildInlineKeyboard: perRow ≤ 0 or non-finite is treated as a single row (defensive)', () => {
  assert.equal(buildInlineKeyboard(btns(6), 0).inline_keyboard.length, 1, 'perRow 0 → single row');
  assert.equal(buildInlineKeyboard(btns(6), -3).inline_keyboard.length, 1, 'negative perRow → single row');
});

test('buildInlineKeyboard: an empty button list yields a keyboard with no buttons (no crash)', () => {
  // grammY seeds an empty row; the meaningful invariant is that NO buttons are present.
  assert.equal(rows(buildInlineKeyboard([], 2)).flat().length, 0, 'no buttons for an empty list');
});

test('the /control menu (14 actions) at CONTROL_MENU_BUTTONS_PER_ROW wraps into a multi-row grid', () => {
  const menu = buildControlMenu();
  assert.equal(menu.length, CONTROL_ACTIONS.length, 'one button per action');
  assert.ok(menu.length >= 14, '14 actions today (the flat-row problem case)');
  const kb = buildInlineKeyboard(menu, CONTROL_MENU_BUTTONS_PER_ROW);
  const r = rows(kb);
  // Multiple rows (the fix) — NOT a single 14-wide row.
  assert.ok(r.length > 1, 'the menu renders as multiple rows, not one');
  assert.equal(r.length, Math.ceil(menu.length / CONTROL_MENU_BUTTONS_PER_ROW), '⌈14/2⌉ = 7 rows');
  for (const row of r) {
    assert.ok(row.length <= CONTROL_MENU_BUTTONS_PER_ROW, `each row ≤ ${CONTROL_MENU_BUTTONS_PER_ROW} buttons`);
  }
  // Every action label survives the layout (nothing dropped).
  const flat = r.flat();
  assert.equal(flat.length, menu.length, 'no button lost in the layout');
  for (const a of CONTROL_ACTIONS) assert.ok(flat.includes(a.label), `kept ${a.label}`);
});

test('the change-model sub-menu also wraps cleanly at the same per-row count', () => {
  const sub = buildModelSubmenu('claude-opus-4-8[1m]');
  const r = rows(buildInlineKeyboard(sub, CONTROL_MENU_BUTTONS_PER_ROW));
  assert.equal(r.flat().length, sub.length, 'all model choices + Back kept');
  for (const row of r) assert.ok(row.length <= CONTROL_MENU_BUTTONS_PER_ROW);
});
