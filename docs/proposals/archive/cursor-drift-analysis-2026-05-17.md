# Cursor-Position Drift in NumInput — Deep Analysis (2026-05-17)

**Type:** Investigation / analysis (read-only — no code changed).
**Scope:** `PianoidTunner/src/components/NumInput/NumInput.js` cursor/selection handling, the
debounce/optimistic-update path that re-renders it, and the staleness of
`docs/development/DIGITAL_INPUT_ANALYSIS.md`.
**Trigger:** User asked for the *true current state* of "Cursor Position Drift" — the open issue
in `DIGITAL_INPUT_ANALYSIS.md` — warning the doc may not reflect the code.

---

## TL;DR Verdict

Cursor drift is **partially mitigated, still a live bug** — but the root cause and the mitigation
set differ from what `DIGITAL_INPUT_ANALYSIS.md` describes. The doc is **stale** (written
2026-03-25; NumInput was reworked 2026-04-22 by a commit the doc never mentions). The
decimal-field two-render case the doc blames is now actually handled correctly. The genuine
remaining drift is narrower: (1) a redundant `requestAnimationFrame` restore that can fire a
*stale* caret position, (2) the legacy `setTimeout`-based `preserveCursorPosition` path still
co-existing with the modern path (three competing restore mechanisms), and (3) the
exponential-field constraint/reformat path that changes string length so a saved numeric caret
index lands on the wrong character.

---

## 1. Timeline — what actually happened (ground truth from git)

`PianoidTunner` is a **separate git repo** (`origin` = `DSPianoid/PianoidTunner`); `git log` from
the `PianoidInstall` root does not see it. The real history of `NumInput.js`:

| Commit | Date | Author | Relevance |
|--------|------|--------|-----------|
| `c1679ac` | 2026-03-16 | Leonid Astrin | `feat: default NumInput to cursor-position step mode` |
| `c6701a4` | 2026-03-25 | DSPianoid | `fix: stabilize NumInput bidirectional data flow and exponential stepping` — **this is the state `DIGITAL_INPUT_ANALYSIS.md` documents** |
| `d27770a` | **2026-04-22** | **Boris Zelikman** | `fix: improve numinput editing and excitation controls` — **post-doc rework, NOT mentioned anywhere in the doc** |

- `DIGITAL_INPUT_ANALYSIS.md` itself was committed `a7abcaa` on **2026-03-25** in `PianoidInstall`.
  It describes `NumInput.js` exactly as of `c6701a4`.
- The only NumInput-touching commit *after* the doc is `d27770a` (2026-04-22). This is the
  "internal work" the user referred to. It is on `dev` (`git merge-base --is-ancestor` confirms)
  and the working tree is clean — so the file read today **is** post-`d27770a`.
- The `origin/numinput` remote branch is **fully merged** — `dev..origin/numinput` is empty for
  NumInput; it is not a source of newer work.
- **No "external" change:** `react`/`react-dom` are `^18.3.1` and `react-scripts` is `5.0.1` in
  *both* `c6701a4` and HEAD `package.json`. No dependency bump, no React version change. The only
  post-doc dep-related commit (`feat: add WebSocket client`, 2026-04-11) did not touch React.
- **dev-2706 did NOT touch cursor handling.** The dev-2706 log
  (`docs/development/logs/archive/dev-2706-2026-05-03-211643.md`) states verbatim *"NumInput.js
  NOT changed"* — it only stripped `min`/`max` clamp metadata from the *consumers*
  (`Strings.jsx`, `Mode.jsx`, etc.). Its test `numinput-no-clamps.test.jsx` covers clamping only,
  never caret position.

So the *entire* delta between the doc and reality is one commit: `d27770a`.

---

## 2. What `d27770a` actually changed (cursor-relevant only)

Diff `c6701a4..HEAD` on `NumInput.js`:

1. **Added `scheduleCursorRestore(position)`** + `cursorRestoreFrameRef`. Every place that
   previously did a bare `pendingCursorRef.current = pos` now calls `scheduleCursorRestore(pos)`,
   which does *both*: sets `pendingCursorRef.current = pos` synchronously **and** schedules a
   `requestAnimationFrame` that calls `inputRef.current.focus()` + `setSelectionRange`.
   *This is literally one of the doc's "Potential Full Solutions (not yet implemented)" — the
   "requestAnimationFrame loop" row — now partially implemented.*
2. **Added `rememberCursorPosition(position)`** — replaced the `cursorPosition` *state* variable
   with a `cursorPositionRef` *ref*. (`preserveCursorPosition` / the legacy `setTimeout` path
   still exist, now reading the ref.)
3. **Added `clearPendingCursorRestore()`** — clears both `pendingCursorRef` and cancels the
   pending rAF. Wired into typing, click, blur, Enter/Escape, and Arrow-Left/Right/Home/End.
4. **Added `getLiveNumericValue()`** — arrow/wheel stepping now reads the *displayed* value
   (`Number(displayValue)`) instead of the stale `value` prop. Previously
   `const newValue = value + direction * stepValue;` (arrow path) used the prop; now it uses the
   live display. This is a behavioural fix for rapid stepping (the prop lags the display by one
   render) but is unrelated to caret position.
5. **Added selection-tracking handlers** — `handleInputSelectionChange` on `onSelect`/`onMouseUp`,
   `handleInputKeyUp` on `onKeyUp`. These record the user's manual caret moves into
   `cursorPositionRef` so the *next* step uses the right position. They no-op while
   `pendingCursorRef` is set (so programmatic `setSelectionRange` does not feed back).

`Strings.jsx` in `d27770a` also **deleted its `ranges` clamp object** — but that is the dev-2706
precursor work, irrelevant to caret position.

---

## 3. True current-code drift mechanics

### 3.1 Decimal field, Arrow / wheel — the doc's headline case is now FIXED

The doc's root cause: *"Each arrow press triggers two render cycles … the second render resets the
cursor after any restoration from the first."* Trace the current code for an `ArrowUp` on a
decimal field (`NumInput.js:856-874`):

1. `handleValueChange(newValue)` → `onChange` → `Strings.handleValueChange` → `usePreset`
   `changeParametersOfStrings` → `setParametersOfStrings(...)` (`usePreset.js:711`, a synchronous
   optimistic `setState`) → schedules **Render 2** with a new `value` prop.
2. `setDisplayValue(formattedValue)` → schedules **Render 1**.
3. `scheduleCursorRestore(pos)` → sets `pendingCursorRef.current = pos` *now*.

- **Render 1** commits → `useLayoutEffect` (`NumInput.js:184-189`) fires synchronously, sees
  `pendingCursorRef` set, calls `setSelectionRange(pos)`. Caret correct.
- **Render 2** (parent prop change) commits → the value-sync `useEffect` (`NumInput.js:124-166`)
  runs. `isEditing` is `false` (arrows never set it), so it does **not** early-return; it computes
  the formatted string and calls `updateDisplayValue(...)`. `updateDisplayValue`
  (`NumInput.js:565-571`) checks `pendingCursorRef.current !== null` → **true** → it just does
  `setDisplayValue` and returns, *deliberately skipping* the legacy `setTimeout` restore. Then
  `useLayoutEffect` fires again and re-applies `pos`.

So the modern `pendingCursorRef` + `useLayoutEffect` pair **does** survive the two-render
sequence. The doc's stated root cause ("the second render resets the cursor") **no longer holds**
for decimal fields — `useLayoutEffect` runs after *every* commit, including Render 2, and the
`updateDisplayValue` guard stops the competing path. This is the doc's "Mitigation 2" working as
intended; the doc rates it as insufficient, but post-`d27770a` it is sufficient *for this case*.

### 3.2 Residual drift sources that ARE still live

**(A) The `requestAnimationFrame` in `scheduleCursorRestore` can fire stale.**
`scheduleCursorRestore` (`NumInput.js:225-238`) captures `position` in a closure and schedules an
rAF. Under sustained key-repeat, several arrow presses can land within one animation frame
(~16 ms; key-repeat is typically ~30 ms but bursts faster, and React 18 batching compresses them).
Each call does `cancelAnimationFrame` on the prior handle, so only the *last* rAF survives — and
that one re-applies the *last* `position`. That is usually fine. But the rAF also calls
`inputRef.current.focus()` and `setSelectionRange` **outside** React's render cycle, *after*
`useLayoutEffect` already placed the caret correctly. If a parent re-render (e.g. a 50 ms-debounced
WebSocket echo, see §3.3) commits *between* the layout effect and the rAF and shifts the string
length, the rAF's stale numeric `position` is clamped to the new length and can land one digit
off. The rAF is **redundant** with `useLayoutEffect` for the common path and is a *liability* for
the racing-render path. The doc never mentions the rAF because the doc predates it.

**(B) Three competing restore mechanisms co-exist.** This is independently flagged in
`docs/development/reviews/numinput-inventory-2026-05-01.md` line 51 (*"Dual cursor-restoration
paths … One should probably be removed"*) — and that review counted only two; `d27770a` added the
rAF as a third:
  1. `useLayoutEffect` + `pendingCursorRef` (modern, synchronous, post-DOM-pre-paint) — lines 184-189.
  2. `preserveCursorPosition` via `setTimeout(…, 0)` (legacy, async, post-paint) — lines 541-562,
     and the separate inline `setTimeout` in `handleInputChange` lines 622-627.
  3. `requestAnimationFrame` inside `scheduleCursorRestore` (added by `d27770a`) — lines 225-238.
  Mechanisms 2 and 3 fire at different times relative to React commit and to each other; whichever
  runs last wins. `updateDisplayValue` guards *path 2* when `pendingCursorRef` is set, but nothing
  coordinates path 2 vs path 3 when both are armed (e.g. a wheel step followed immediately by a
  typed character). This is the structural fragility behind "drift under rapid input."

**(C) Exponential field — caret index is a character index, not a digit index.** The doc's
specific complaint ("cursor lands in the exponent part, subsequent steps change the exponent") is
real and *unfixed*. In the exponent-step branches (`NumInput.js:800-852` arrow, `264-324` wheel,
plus the two ▲/▼ button copies) the new display string is rebuilt as
`` `${mantissa}e` `` + sign + `newExponentValue`. When the exponent rolls over a digit
(`9 → 10`, or `+9 → +10`, or a sign flip `+1 → -1` ... actually `-1 → 0` drops to `+0`) the
string **changes length**. The saved caret is a raw character offset
(`inputRef.current.selectionStart`); re-applying that same integer offset after the length change
puts the caret on a *different logical position*. `useLayoutEffect` clamps to
`Math.min(pos, value.length)` — which prevents an out-of-range throw but does **not** keep the
caret on the same digit. The next arrow press then reads `getStepFromCursorPosition()` at the
drifted offset and steps the wrong power. The constraint path
(`constrainedValue !== newValue` → `formatNumber(...)` → potentially a *different* mantissa digit
count) makes this worse. Fixing this needs digit-anchored caret math, not raw offsets — no
mechanism in the current code does that.

### 3.3 New aggravating factor the doc could not know about

The doc's analysis assumes the **300 ms** REST debounce. The post-doc WebSocket migration
(`usePreset.js`, commit on 2026-04-11) introduced `DEBOUNCE_WS = 50` ms vs `DEBOUNCE_REST = 300`.
When the WebSocket transport is connected, the backend echo / state-sync round-trip that triggers
the *external* prop mutation arrives ~6× sooner. That compresses the window in which a parent
re-render can interleave with the `useLayoutEffect` → rAF sequence of an in-progress key-repeat
burst — i.e. it makes source (A) above *more* likely to bite, not less. The doc's "why sandbox
works but connected fails" section is still directionally correct but its timing numbers are
obsolete.

---

## 4. Doc-vs-code discrepancy list (`DIGITAL_INPUT_ANALYSIS.md`)

Every place the doc is now wrong or stale:

| # | Doc claim | Reality in current code | Severity |
|---|-----------|------------------------|----------|
| D1 | Doc presents 7 fixes + 1 open issue as the *current* state. | Doc is undated in-body; it describes commit `c6701a4` (2026-03-25). A whole rework commit `d27770a` (2026-04-22) landed after and is unmentioned. The doc must be marked stale. | Major |
| D2 | "Mitigation 1: `pendingCursorRef` … set by arrow/wheel handlers." | Handlers no longer set `pendingCursorRef` directly — they call `scheduleCursorRestore()`, which sets the ref **and** schedules an rAF. The mitigation list is incomplete: a third restore path (rAF) now exists and is undocumented. | Major |
| D3 | "Potential Full Solutions (not yet implemented)" lists "requestAnimationFrame loop" as a future option. | The rAF restore **is implemented** (`scheduleCursorRestore`, `cursorRestoreFrameRef`, since `d27770a`). The "not yet implemented" table row is factually wrong. | Major |
| D4 | Root cause: "the second render resets the cursor after any restoration from the first." | For **decimal** fields this is no longer true — `useLayoutEffect` runs after Render 2 as well, and the `updateDisplayValue` guard suppresses the competing legacy path. The decimal two-render case is effectively handled. The doc over-states the live bug surface. | Major |
| D5 | The doc's data-flow / debounce reasoning implicitly assumes the 300 ms REST debounce. | Post-doc WebSocket migration added `DEBOUNCE_WS = 50` ms. When WS is connected the external-prop round-trip is ~6× faster, changing the race timing the doc describes. | Minor |
| D6 | Doc lists arrow stepping using the `value` prop implicitly (Fix-era code did `value + direction*stepValue`). | `d27770a` changed arrow/wheel stepping to `getLiveNumericValue()` (reads `displayValue`). The "Data Flow: User → Engine" section and any reasoning about stale-prop stepping is outdated. | Minor |
| D7 | Fix 3 ("onBlur — kept as discard") describes the blur behaviour and the `Strings.handleValueChange` drops-the-key race as a *pre-existing* blocker. | Still accurate in code (`handleBlur` lines 940-964 still discards; `Strings.handleValueChange` line 57-58 still drops the key). **Not stale** — noted for completeness. | Info (still valid) |
| D8 | Doc says NumInput is "~1500 lines". | Current file is 1565 lines (HEAD). Minor numeric drift; also `numinput-inventory-2026-05-01.md` already rates it RED at 1565 LOC. | Info |
| D9 | The doc lives in `docs/development/` (session-doc area) and `WORK_IN_PROGRESS.md` still points to it as the live tracker with branch `feature/fix-bidirectional-input`. | That branch's work is long-since merged to `dev`; the post-doc rework came on a *different* unmentioned change. The WIP row at `WORK_IN_PROGRESS.md:986-994` is stale. | Minor |

---

## 5. Which of the doc's 7 "fixes" survive in current code

| Fix | In current code? | Notes |
|-----|------------------|-------|
| 1 — merged duplicate `useEffect` | **Yes.** Single value-sync effect at `NumInput.js:124-166`, guarded by `isEditing`. | Intact. |
| 2 — `isUpdating*` flags → `useRef` | **Yes.** `usePreset.js:57-81` — all `isUpdating*` are `useRef`. | Intact; `d27770a` added more refs in the same style. |
| 3 — onBlur discard | **Yes.** `handleBlur` discards uncommitted edits (`NumInput.js:958-963`). | Intact. |
| 4 — `PropertyInput` local buffer | **Not verified here** (PropertyInput.jsx out of NumInput scope; doc-listed, presumed intact — flag for follow-up). | Unverified. |
| 5 — read-back after POST | **Likely changed.** `changeParametersOfStrings` was rewritten by `d27770a` (`usePreset.js` diff). Whether the read-back log survived is unverified. | Possibly superseded. |
| 6 — exponential step via display-string "e" check | **Yes.** `getStepFromCursorPosition` checks `valueString.includes("e")` (`NumInput.js:397`). | Intact. |
| 7 — relative-magnitude equivalence (not `Number.EPSILON`) | **Yes.** `absDiff / magnitude < 1e-10` at `NumInput.js:84-86` and `141-143`. | Intact. |

No fix was *reverted*; Fix 5 may have been *reworked* by `d27770a` and needs a spot-check before
relying on the doc's description of it.

---

## 6. Recommended fix approach (NOT implemented — for a `/dev` decision)

Drift is narrow now. A focused fix, smallest-first:

1. **Collapse to one restore mechanism (S).** Delete the legacy `setTimeout`-based
   `preserveCursorPosition` path and the inline `setTimeout` in `handleInputChange`; delete the
   `requestAnimationFrame` half of `scheduleCursorRestore`. Keep **only** `useLayoutEffect` +
   `pendingCursorRef` — it already runs after every commit (including the parent re-render) and is
   the only restore that is correctly ordered w.r.t. React. `scheduleCursorRestore` becomes a
   one-liner that just sets `pendingCursorRef.current = pos`. This removes sources (A) and (B)
   wholesale. Effort: **S** (deletions + one-line simplification).

2. **Digit-anchored caret for exponential fields (M).** Source (C) needs the caret to track a
   *logical* position (e.g. "k-th digit of the exponent", or "before/after the decimal in the
   mantissa"), not a raw character offset. On an exponent step, compute the new caret offset from
   the *rebuilt* string: locate the `e`, re-derive the offset that keeps the same digit under the
   caret. Store the logical anchor (which part: mantissa-int / mantissa-frac / exponent; which
   index) at keydown, recompute the character offset after reformat. Effort: **M** — touches the
   four near-duplicated exponent-step blocks (arrow/wheel/▲/▼), so pairs naturally with the
   `numinput-inventory` recommendation #4 to extract one `applyExponentDelta(direction, cursorPos)`
   helper. Do the extraction first, then fix once.

3. **Add a regression test (S).** There is currently **no** test for caret position anywhere in
   `PianoidTunner` (`numinput-no-clamps.test.jsx` covers clamping only). Add a
   `numinput-cursor.test.jsx` under `src/components/__tests__/` using `@testing-library/react`:
   focus → set `selectionStart` mid-string → fire repeated `keyDown ArrowUp` → assert
   `selectionStart` is unchanged for a decimal field, and assert the caret stays on the same
   *digit* for an exponential field across a `9→10` exponent rollover.

Option 1 alone resolves the "drift under rapid input" the doc complains about for decimal fields
with near-zero risk. Option 2 is what actually closes the doc's stated open issue (exponent-part
drift). Do them as one `/dev` task since both live in the same hot code.

---

## 7. Investigation history

- Source of the open issue: `docs/development/DIGITAL_INPUT_ANALYSIS.md` (committed 2026-03-25,
  `PianoidInstall@a7abcaa`) — confirmed stale by this analysis (see §4).
- Prior NumInput audit: `docs/development/reviews/numinput-inventory-2026-05-01.md` (dev-f259) —
  independently flagged the dual/triple restore-path fragility (line 51) and the 1565-LOC bloat;
  this analysis confirms and extends it.
- Post-doc code change: `PianoidTunner@d27770a` (2026-04-22) — the single unmentioned rework.
- dev-2706 log (`docs/development/logs/archive/dev-2706-2026-05-03-211643.md`) — confirms
  *"NumInput.js NOT changed"* by the clamp-removal work; cursor drift untouched by dev-2706.
