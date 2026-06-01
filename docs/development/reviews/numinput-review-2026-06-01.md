# Local Review — NumInput Component — 2026-06-01

**Scope:** `PianoidTunner/src/components/NumInput/NumInput.js` (+ `.styles.js`, `index.js`,
the two Jest suites, and a sampling of call sites). Level: **LOCAL** (single-component
review). **Read-only** — no source was modified.

**Trigger:** User request (Telegram) — "Review the code and the functionality of the
numinput element." NumInput is the canonical numeric editor per the CLAUDE.md frontend
standard ("Numeric inputs use the existing NumInput component … do not create new numeric
input components").

**Relationship to prior work:** Builds on
[`numinput-inventory-2026-05-01.md`](numinput-inventory-2026-05-01.md) (the call-site
inventory + cross-component numeric-input census). That report's open rec #4 — "Split
NumInput.js (RED at 1565 LOC)" — remains the dominant structural finding and is restated
here against the C4 rubric. This review adds the **architectural (P1/P2) audit** and a set
of **functionality defects found by reading the component fresh** that the inventory did
not cover.

---

## Summary Verdict

**FAIL to approve as-is on structural grounds (one High: C4 god-object), but no Critical
and no functional regression in the live path.** The component is functionally solid for
its current callers — the cursor-step / exponential / in-place-edit feature surface works
and is now Jest-covered for the two behaviours that historically broke (clamp omission and
caret drift). The findings are: (1) the file is RED on C4 and has been for a year; (2) a
cluster of latent functionality defects — **non-reactive `min`/`max`/`step` props**, a
**silently-ignored `isExponential` prop**, **blur silently discards typed edits**, and a
**`NaN` step footgun** — that don't bite today's callers only because of how those callers
happen to be wired. None lose data in the current product, but each is a sharp edge for the
next caller. Recommend: schedule the C4 split (rec #4, still open) and fix the prop-reactivity
+ dead-`isExponential` defects in a small `/dev` pass.

---

## Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | `PianoidTunner/src/components/NumInput/NumInput.js` | 1555 | **RED** |
| 2 | `PianoidTunner/src/components/NumInput/NumInput.styles.js` | 296 | — |
| 3 | `PianoidTunner/src/components/NumInput/index.js` | 1 | — |

`NumInput.js` is **RED (>1000 LOC)** → automatic **High**-severity C4 finding. It is a
**known god-object** (CODE_QUALITY.md baseline, rank 7) — present in the table, so this is
**not a new regression**: it was 1565 LOC, trimmed to 1537 by the 2026-05-17 cursor fix, and
grew +18 to 1555 at dev-bbcb (the `integer` prop). It has **not crossed a threshold in
either direction** this period. No new RED file is introduced. See Finding C-1.

---

## Architectural Consistency

**Layer audit: PASS.** NumInput is a pure Layer-4 (frontend) presentational/interaction
component. It holds only UI-local state (display string, caret, mode, focus), emits
`onChange(number)` upward, and contains **no business logic** — no HTTP, no WebSocket, no
debounce, no preset/engine knowledge. The 300 ms debounce + optimistic-update machinery
lives in `usePreset` (the parent), exactly where CODE_QUALITY.md C1 puts it. The component
correctly does **not** know it edits synthesis parameters.

**Server audit: N/A** (frontend-only component, touches neither port 5000 nor 5001).

**One concern-bleed nuance (see P2 table):** the component bundles *value editing* with
*in-place editing of its own min/max/step/decPlaces config* (the right-click-arrow → edit-bound
modes). That is a second, orthogonal concern living inside the same 1555-LOC body — the
structural root of the C4 size. Flagged Medium, folded into the split plan.

---

## Authority Violations (P1)

| # | State | Owner | Violating Reader/Writer | Severity |
|---|-------|-------|-------------------------|----------|
| P1-1 | `min` / `max` bounds | The **parent** (passes `min`/`max` props as the intended source of truth) | NumInput copies them into `minValue`/`maxValue` `useState` **once at mount** (`NumInput.js:66-67`) and never re-syncs when the props change. The clamp at `:93` then uses a **stale fork** of the parent's bounds. | **Medium** |
| P1-2 | `step` | Parent (`step` prop) | Same pattern — `internalStep` seeded once at `:59`, never re-synced when the `step` prop changes. | **Low** |
| P1-3 | `decPlaces` | Parent (`decPlaces`/`integer` props) | Same — `internalDecPlaces` seeded once at `:60`. (Mitigated: the value-sync `useEffect` at `:141-183` lists `internalDecPlaces` in deps, so display re-formats, but a *prop* change to `decPlaces` after mount still won't update the internal copy.) | **Low** |

**Reasoning (P1-1).** The component creates a *second source of truth* for a value the
parent owns, with no refresh path — the textbook A1 "redundant copy that can diverge"
violation. It does not bite the current product because the dev-2706 directive (S5b) made
every engine-bound caller **omit** `min`/`max` (so both forks are `±Infinity` forever, and
the in-place-edit mutators are the only writers — which is internally consistent). The hard-
bound callers (MIDI velocity 0-127, sample_rate, etc.) pass **constant** literals, so their
mount-time copy is also never stale. The latent bug fires only for a future caller that
varies `min`/`max` reactively (e.g. "max depends on another field"). Confidence 90 that the
non-reactivity exists; confidence ~60 that any current caller is harmed → reported at
Medium, not High.

---

## Concern Violations (P2)

| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|----------------|-----------------------|----------|
| P2-1 | `NumInput.js` | "Edit one numeric value (cursor-step, wheel, keyboard, exponential)." | Also implements **in-place editing of its own configuration** — min, max, step, and decimal-places are edited *through the same input* via right-click-arrow mode switches (`mode` ∈ value/min/max/step/decPlaces). Two unrelated reasons to change (value-entry UX vs config-entry UX) live in one 1555-LOC body. | **Medium** |

This is the structural cause of the C4 size and the ~4× duplicated exponent-step blocks.
Folded into the split recommendation (rec R-1).

---

## Patch / Workaround Findings

**TODO/FIXME/HACK/XXX count in scope: 0.** Clean — no marker rot.

| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| S5-1 | Swallowed error (empty catch) | `NumInput.js:126-128` | Low | `formatNumber` `catch (error) { return num.toString(); }` — swallows silently. Benign (the only throw path is an invalid `places` arg to `toFixed`/`toExponential`), but it is an un-logged catch per S5. |
| S5-2 | Swallowed error (empty catch) | `NumInput.js:165-167`, `411-413`, `1394-1396`, `1546-1548` | Low | Four more `catch {}` / comment-only catches around `Number()` parsing and decPlaces stepping. All benign (parsing guarded by `isNaN` checks immediately after), but uniformly silent. |
| S5-3 | Dead placeholder effects | `NumInput.js:70-72`, `193-195` | Low | Two `useEffect`s with empty/comment-only bodies ("No logs needed", "intentionally empty to avoid focusing"). The `:193-195` one carries a `[value]` dep and does nothing — pure noise. Carried over from the inventory's known-issues list. |
| S5-4 | Sleep/timeout sync | `GaussCell.jsx:35` (caller, not NumInput) | Low | Caller focuses NumInput's `<input>` via `setTimeout(…, 0)` after select. Not in NumInput itself; noted because it interacts with NumInput's focus/caret path. NumInput's *own* caret restore correctly uses a single `useLayoutEffect` with **no** setTimeout/rAF (the legacy timeout path was removed at dev-cursor-drift — verified absent). |

No fallback-masks-error, no legacy migration shims, no compatibility-for-removed-feature
branches found inside NumInput.

---

## Functionality Findings (Level 1 — fresh read of behaviour)

Severity-ranked. Each verified by reading the code path; confidence noted where < 80.

### High

**F-1 — `isExponential` prop is silently ignored (broken contract at a live call site).**
`GaussCell.jsx:130` passes `isExponential={config.isExponential}` to `<NumInput>`, but
**NumInput does not accept an `isExponential` prop** — `isExponential` is internal `useState`
(`NumInput.js:56`, initial `false`). The prop is destructured-away into nothing. So a
GaussCell configured with `inputConfig.isExponential = true` does **not** start in
exponential display; the field silently ignores the request. This is a real
prop-contract break (caller believes it sets initial exponential mode; component never reads
it). The 2026-05-01 inventory documented the *accepted* prop list and did not flag this dead
prop. **Confidence 95.** *(Repro: render a GaussCell whose `inputConfig.isExponential` is
true → the NumInput shows fixed notation until the value crosses the 1e6 auto-exp threshold
or the user clicks the `e` toggle.)*

### Medium

**F-2 — Blur silently discards an uncommitted typed edit (no commit-on-blur).**
`handleBlur` (`NumInput.js:945-969`): if the user types a new value and then clicks away
(blur) **without** pressing Enter, the edit is **reverted to the prop value** and `isEditing`
is cleared — the typed number is lost with no commit and no warning. This is a *deliberate*
design choice (the inline comment at `:960-962` explains it prevents cross-parameter
contamination when the parent's `selectedParameter` changes on the click that caused the
blur). It is the safer default for this app's matrix-cell editing model, **but it is a
genuine UX footgun**: "type a value, click elsewhere, value silently doesn't take" is a
classic data-loss-of-intent complaint. Worth an explicit decision: keep (and document in the
component header) vs. commit-on-blur-when-safe. **Confidence 95** that the behaviour exists;
it is intentional, so reported as a footgun to confirm, not a bug to fix blindly.

**F-3 — `step = NaN` footgun via the canonical caller idiom.** The canonical prop set
(`ParameterEditor.jsx:76`, mirrored in the inventory) is
`step={settings?.step || (settings?.max - settings?.min) / 200}`. When `settings.min`/`max`
are **undefined** (which is exactly the dev-2706 engine-bound case — those callers omit
min/max), `(undefined - undefined)/200` → **`NaN`**, and `NaN` is truthy-falsy-safe only
because `0 || NaN` → `NaN` (the `||` does **not** rescue it — `NaN` is falsy, so
`settings?.step || NaN` yields `NaN` when `settings.step` is also absent). `NaN` is then
stored in `internalStep` (`:59`). **Masked today** because the default mode is
cursor-position step (`useCursorStep=true`), so `getStepValue()` calls
`getStepFromCursorPosition()` and never reads `internalStep` — *unless* the user right-clicks
the `e`/decimal button to switch to **fixed-step** mode, at which point arrow/wheel steps
become `currentValue + NaN` = `NaN`, which fails the `isFinite` guard at `:387`/`:877` and
silently does nothing (arrows/wheel dead). **Confidence 80.** Low-frequency (requires the
fixed-step toggle on an unbounded field) but a real dead-control path. Fix belongs at the
caller idiom (guard the divisor) and/or a `Number.isFinite(step) ? step : 1` clamp on
`internalStep` init in NumInput.

**F-4 — `previousValue` (Escape-revert anchor) can be stale across rapid prop updates.**
`previousValue` is set in several places (`:142` on every value-sync effect run, `:913`
on mode change, `:941` on focus-when-not-editing). Because the value-sync effect at `:141`
runs `setPreviousValue(value)` on **every** incoming prop change *even while focused but not
editing*, the "revert target" for Escape tracks the latest backend echo rather than the
value at focus-time. In the optimistic-update model (parent pushes echoes via WS), a debounced
echo arriving mid-focus moves the Escape anchor. Effect is subtle (Escape reverts to "last
echoed" not "value when I focused"); unlikely to be user-visible given the commit model, but
it's a correctness smell in the revert semantics. **Confidence 60** → reported as "likely",
Low–Medium boundary, listed here for completeness.

### Low

**F-5 — Empty-string / partial-input (`""`, `"-"`, `"."`, `"1e"`) handling is implicit, not
explicit.** Typing only updates `displayValue` (`handleInputChange`), so partial input is
fine *during* editing. On commit (Enter), `parseFloat("")`/`parseFloat("-")`/`Number("1e")`
→ `NaN`, caught by the `!isNaN && isFinite` guard at `:673`, which reverts to the formatted
prop value (`:744-746`). So partial/empty input **reverts** rather than committing garbage —
correct, but entirely by the NaN-guard's grace; there is no explicit "empty means X" branch.
Acceptable; noting that the safety is emergent.

**F-6 — `generateUniqueId` uses deprecated `String.prototype.substr`.** `NumInput.js:15-16`
uses `.substr(2, 9)` (deprecated, though universally supported). The `instanceId` it produces
feeds only `data-instance-id` debug attributes (`:1085`, `:1226`) — the `instanceId.current`
is also (needlessly) in the wheel effect's dependency array at `:435` (a ref's `.current` in
a dep array is a no-op for re-running the effect — harmless but misleading). Low.

**F-7 — Accessibility gaps (frontend standard).** Against the CLAUDE.md a11y baseline:
- The control is a raw `<input type="text">` with **no `aria-label`** and no associated
  `<label>` — the consuming components (Mode, Strings, ParameterEditor) supply a visual label
  *beside* it but do not wire `htmlFor`/`id` or `aria-labelledby`. A screen reader announces
  an unlabelled text box.
- The ▲/▼/`e`/`.`/✓/✕ controls are `<button>`s with **icon-only `::before` glyphs** and **no
  `aria-label`** — they announce as empty buttons. (They do have `title` tooltips in some
  cases, but the arrows/cancel/apply rely on the CSS glyph alone.)
- It is a **text** input emitting numbers, so it exposes no `role="spinbutton"` /
  `aria-valuenow`/`valuemin`/`valuemax` semantics that a native number spinner would.
This is a pre-existing baseline gap, not a regression; flagged because the user asked about
the component's functionality and a11y is part of the frontend standard. Low (no current
keyboard-operability break for sighted mouse/keyboard users — arrows and Enter work).

---

## Test-Coverage Assessment

**Two dedicated Jest suites exist** (the inventory predated them; they landed at
dev-2706 and dev-cursor-drift):

| Suite | Covers | Path |
|---|---|---|
| `numinput-no-clamps.test.jsx` | Unbounded commit when min/max omitted (4 cases) + opt-in clamp still works (1 case) | `PianoidTunner/src/components/__tests__/numinput-no-clamps.test.jsx` |
| `numinput-cursor.test.jsx` | Caret stays on digit across ArrowUp (decimal + exponential, incl. 9→10 rollover) + no-drift on debounced parent re-render (5 cases) | `PianoidTunner/src/components/__tests__/numinput-cursor.test.jsx` |

Plus indirect coverage via `ObjectInspector.test.jsx` / `PaneSettingsDialog.test.jsx` (the
widget-type mapping, including the `integer` pass-through).

**Coverage gaps (no test exists for):**
1. **The `integer` prop** (dev-bbcb) — round-on-commit (type "48.7" + Enter → 49), forced
   0 decimals, hidden decPlaces button. The component's newest feature has **zero direct
   tests**. (Asserted only indirectly via ObjectInspector's config mapping, not the
   round-on-commit behaviour itself.) **Highest-value gap.**
2. **Blur-revert (F-2)** — no test pins the deliberate "blur discards uncommitted edit"
   contract. Given it's an intentional, surprising behaviour, it should be locked by a test
   so a future "add commit-on-blur" change is a conscious decision, not an accident.
3. **Min/max in-place editing** — the right-click-arrow → edit-bound mode (`mode` =
   min/max/step/decPlaces) is a major feature surface (P2-1) with no test.
4. **NaN/partial-input commit (F-3, F-5)** — no test for `step=NaN`, `""`, `"-"`, `"1e"`.
5. **Wheel stepping** — the global wheel handler (cursor-position-aware exponent stepping) is
   untested; only Arrow keys are exercised.

---

## Level-1 Findings Table (consolidated, severity-ranked)

| # | Principle | Severity | Confidence | File:Line | Description |
|---|-----------|----------|-----------|-----------|-------------|
| C-1 | C4 | **High** | 100 | `NumInput.js` (whole file) | RED god-object, 1555 LOC. Known baseline debt (rank 7). Split plan required before further growth (rec R-1). |
| F-1 | C5 / contract | **High** | 95 | `NumInput.js:18-33` vs `GaussCell.jsx:130` | `isExponential` prop passed by a caller but never accepted/read → silently ignored dead prop. |
| P1-1 | P1 / A1 | Medium | 90/60 | `NumInput.js:66-67`, `:93` | `min`/`max` copied to state once at mount; non-reactive to prop changes (stale clamp). |
| P2-1 | P2 | Medium | 90 | `NumInput.js` (modes) | Value-edit + self-config-edit are two concerns in one file (root of C4 size). |
| F-2 | A5 / UX | Medium | 95 | `NumInput.js:945-969` | Blur silently discards an uncommitted typed edit (intentional — confirm + document). |
| F-3 | S5 / robustness | Medium | 80 | `NumInput.js:59`; `ParameterEditor.jsx:76` | `step=NaN` via `(max-min)/200` when bounds undefined → dead arrows/wheel in fixed-step mode. |
| F-4 | correctness | Low | 60 | `NumInput.js:142` | Escape-revert anchor (`previousValue`) tracks latest echo, not focus-time value. |
| P1-2/3 | P1 | Low | 90 | `NumInput.js:59-60` | `step`/`decPlaces` also non-reactive to prop changes after mount. |
| S5-1..3 | S5 | Low | 95 | `:126`,`:165`,`:411`,`:70`,`:193` | Silent catches + dead placeholder effects (un-logged, benign). |
| F-5 | robustness | Low | 90 | `NumInput.js:673`,`:744` | Empty/partial input safety is emergent from the NaN guard, not explicit. |
| F-6 | N1 / hygiene | Low | 95 | `NumInput.js:15`,`:435` | Deprecated `substr`; ref `.current` in a dep array (no-op). |
| F-7 | a11y baseline | Low | 85 | input + buttons | No `aria-label`/label wiring on the input or icon-only buttons; not a spinbutton role. |

---

## Recommendations (concrete)

**R-1 (High, structural) — Schedule the C4 split of `NumInput.js` (still-open inventory rec
#4).** This is a *named work item*, not part of any in-flight change, so per the C4 rule it
needs its own `/dev` pass with a split plan; do **not** bundle it with a bug fix. Suggested
split by concern (addresses P2-1 + the ~4× exponent-step duplication):
  - `useNumInputCaret` hook — the `pendingCursorRef` + `useLayoutEffect` + `anchorExponentCaret`
    machinery (~120 LOC).
  - `applyExponentDelta(direction, cursorPos)` shared helper — collapses the four
    near-identical exponent-step blocks in the wheel handler, ArrowUp/Down, ▲ button, ▼
    button (~250 LOC saved; the single biggest reduction).
  - `useNumInputModes` (or a small `NumInputConfigEditor`) — the in-place min/max/step/decPlaces
    editing concern, lifting P2-1 out of the value-editor.
  - Target ~600 LOC for the value-editor core, per the inventory.

**R-2 (High, quick) — Fix the `isExponential` dead prop (F-1).** Either (a) accept an
`isExponential` prop and seed the `useState` from it (one-line: `useState(isExponential)`),
or (b) remove the prop from `GaussCell.jsx:130` if initial-exponential is not actually wanted.
Decide with the user which is intended. Small `/dev` change.

**R-3 (Medium) — Make `min`/`max`/`step` reactive (P1-1/2/3).** Add a `useEffect` that
re-syncs `minValue`/`maxValue`/`internalStep` when the corresponding props change (and the
user is not mid-edit of that bound), OR — cleaner — drop the `minValue`/`maxValue` state
entirely and clamp directly against the props, keeping in-place-edit as a separate explicit
override channel. This removes the A1 redundant-copy violation at its root. Pairs naturally
with R-1's config-editor extraction.

**R-4 (Medium) — Guard the `NaN` step (F-3).** Clamp at init: `useState(Number.isFinite(step)
? step : 1)`, and fix the caller idiom `(max - min) / 200` to guard undefined bounds. Cheap,
removes a dead-control path.

**R-5 (Medium) — Decide + document the blur-discard contract (F-2)**, and **lock the
`integer` prop + blur behaviour with Jest tests** (coverage gaps #1, #2). The `integer`
round-on-commit is the newest, least-tested feature — highest test ROI.

**R-6 (Low) — Hygiene sweep** (do opportunistically inside R-1, not standalone): remove the
two dead `useEffect`s (S5-3), add `aria-label`s to the input + icon buttons (F-7), replace
`substr` (F-6), drop `instanceId.current` from the wheel dep array (F-6).

---

## Notes for the maintainer

- **No Critical, no functional regression in the shipping product.** Every Medium/High
  functionality finding is a *latent* sharp edge that the current callers happen to avoid
  (engine-bound callers omit min/max; hard-bound callers pass constants; nobody relies on the
  ignored `isExponential` today). The risk is to the *next* caller.
- The CODE_QUALITY.md baseline entry for this file (rank 7) is **accurate** and current
  (1555 LOC, dev-bbcb +18). No baseline-table update needed.
- The 2026-05-01 inventory's "Known issues" bullet about a `requestAnimationFrame` fallback
  is **stale** — that path was removed at dev-cursor-drift; the live code has a single
  `useLayoutEffect` restore mechanism (verified). The inventory already struck that line
  through; noting it so the two reviews are not read as contradictory.

Doc references (MkDocs):
[PianoidTunner OVERVIEW — NumInput](http://localhost:8001/modules/pianoid-tunner/OVERVIEW/) ·
[CODE_QUALITY — C4 god-object rule](http://localhost:8001/development/CODE_QUALITY/#c4-file-size-red-flags-the-god-object-rule) ·
[CODE_QUALITY — S5b UI does not pre-clamp](http://localhost:8001/development/CODE_QUALITY/#s5b-ui-does-not-pre-clamp-engine-bound-parameters)
