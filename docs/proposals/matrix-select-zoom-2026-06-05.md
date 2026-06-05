# Proposal — Matrix Select-to-Zoom + Selection-Scoped Edits

- **Author:** dev-mzoom (DESIGN-ONLY session)
- **Date:** 2026-06-05
- **Status:** PLAN — awaiting user review. No source edited.
- **Scope:** PianoidTunner matrix panes (Feedin, Feedback, Sound Channels, Workbench).

---

## 1. User spec (verbatim intent)

1. **Select-to-zoom** — when the user drag-selects an area in the matrix, the matrix
   AUTO-SCALES to the selection: the visible VIEW range becomes the selection bounds,
   so the selected cells enlarge to fill the pane.
2. **Selection-scoped edits** — ALL edits apply to the SELECTED AREA ONLY.
3. **Reset / un-zoom** control to return to the full range.
4. Define the interaction of per-axis view ranges, the selection, and the zone selector.

---

## 2. Current architecture (measured from source)

### 2.1 Two independent range concepts, both owned by `useCurrentValues` (P1 clean)

`src/hooks/useCurrentValues.js` is the **sole writer** of both:

| State | Setter | Meaning | Default |
|---|---|---|---|
| `rangeOfPitches` / `rangeOfModes` | `setRangeOfPitches` / `setRangeOfModes` | **VIEW range** — drives cell size + which cells are drawn (zoom) | `[21,99]` / `[0,63]` |
| `selectedPitches` / `selectedModes` | `setSelectedPitches` / `setSelectedModes` | **SELECTION range** — the highlighted sub-rectangle | `null` |

Because both already live in one owner, the feature does **not** introduce a new
authority — it wires existing setters together. This is the key reason the feature is
small.

### 2.2 How the VIEW range drives zoom

`PitchesModesMatrixCanvas.jsx`:
- Cell size = `containerWidth / (range[1]-range[0]+1)` (lines 68-73). Shrinking the
  range enlarges cells → that IS the zoom.
- The draw loop iterates only `pianoRange[0]..pianoRange[1]` × `modesRange[0]..modesRange[1]`
  (lines 111-116). So the view range is BOTH the zoom factor AND the visible window.

So **"set the view range = the selection bounds"** is literally the entire zoom mechanic.

### 2.3 How drag-select works today

`PitchesModesMatrixCanvas.handleMouseMove` (lines 266-273): while a button is held it
calls `onSelectRect([pitchMin, modeMin, pitchMax, modeMax])`.

`MeasuredMatrix` `onSelectRect` handler (lines 332-336):
```js
onSelectRect={(sel) => {
  setSelectionRect(sel);                                   // local highlight box
  onSelectPitchesRange(sel ? [sel[0], sel[2]] : null);     // → setSelectedPitches
  onSelectModesRange(sel ? [sel[1], sel[3]] : null);       // → setSelectedModes
}}
```
**Drag drives the SELECTION only.** It never touches the view range. The orange
`selectionRect` box is drawn in the canvas (lines 181-196). `MeasuredMatrix`'s effect
(lines 89-110) also derives `selectionRect` from the `selectedPianoRange`/`selectedModesRange`
props, so the highlight survives a re-render.

### 2.4 A zoom-to-selection control ALREADY EXISTS (partially)

`PianoidTuner.renderToolbarControls` (lines 2261-2306) already renders two title-bar buttons:

| Button (icon) | Behaviour today | Note |
|---|---|---|
| `ZoomInIcon` (labelled "ZoomOut") | `setRangeOfPitches(selectedPitches); setRangeOfModes(selectedModes)` — **zoom view to the current selection** | Shown only when selection ≠ current view |
| `ZoomOutIcon` (labelled "ZoomIn") | `setRangeOfPitches([full]); setRangeOfModes([0,63])` — **reset to full** | Shown only when view ≠ full |

So spec items 1 and 3 are **already half-built** — the data plumbing
(selection → view) exists, but: (a) it requires a button click, not the drag itself;
(b) the icons/labels are swapped (confusing); (c) the buttons are gated to
`["Virtual Piano","Workbench","Feedin","Feedback"]` — **Sound Channels is excluded**;
(d) the `[0,63]` reset bound is hardcoded (wrong for presets with ≠64 modes).

### 2.5 How edits are scoped today — the `calcChange` zones

ALL matrix edits flow through `useMatrixHistory.calcChange` (lines 72-154). The
**zone** (from the MatrixTools toggle: `Cell` / `Column` / `Row` / `Matrix`) selects
which cells the operation touches:

| Zone | calcChange behaviour | Range-bounded? |
|---|---|---|
| `Cell` | one `[pitch][mode]` | n/a |
| `modesVector` (Row) | `newMatrix[pitch].fill(value)` — **the WHOLE pitch row, all modes** | **NO** |
| `pitchesVector` (Column) | every pitch's `[mode]` — **ALL pitches** | **NO** |
| `Matrix` | every cell | **NO** |

**No zone is bounded by any sub-range.** "Row" fills the entire mode axis; "Column"
touches every pitch; "Matrix" is the whole thing. This is the gap for spec item 2 —
selection-scoped edits require teaching `calcChange` to honour a bound.

The network emit after an edit is per-pitch (`changeFeedInValues(muted, selectedPitch)`)
or whole-matrix (`changeTouchesWholeMatrix(change) ? null : selectedPitch`,
PianoidTuner:1161).

### 2.6 Sound Channels is a special case

`SoundChannelsPane.jsx`:
- Passes `pianoRange={[displayNotes[0], displayNotes[last]]}` and
  `modesRange={[0, displayTotalCols-1]}` — **hardcoded FULL range, ignoring the shared
  `rangeOfPitches`/`rangeOfModes`.** → SC is **not zoomable at all** today.
- Passes `selectedPianoRange={null}` / `selectedModesRange={null}` → the
  `MeasuredMatrix` selection-highlight effect (lines 89-110) never fires for SC, so even
  the orange selection box is **dead** in SC right now.
- It DOES pass `onPianoRangeChange={setRangeOfPitches}` / `onModesRangeChange={setRangeOfModes}`
  but then ignores those values for its own `pianoRange` prop.
- Strings-axis rows are OUTPUT CHANNELS, not pitches; row selection is owned locally by
  `selectedChannel` (dev-snmtxleak-7e3d) and deliberately NOT propagated to the global
  `selectedPitch`. Any SC zoom/scoped-edit design must respect this local-channel split.

---

## 3. Design

### 3.1 Spec item 1 — select-to-zoom (drag auto-scales)

**Decision point (OPEN QUESTION Q1):** make zoom happen automatically on drag-release,
or keep it a button after drag? Two options:

- **Option A (recommended) — drag-release auto-zooms.** On `mouseup` after a drag that
  produced a multi-cell selection, set the view range = selection bounds. This is the
  literal user spec ("when the user drag-selects … the matrix AUTO-SCALES").
- **Option B — drag selects; an explicit "Zoom to selection" button applies.** This is
  today's behaviour minus the icon/gating bugs. Lower surprise; a stray drag does not
  reflow the whole pane.

The user spec text favours **A**. The risk with A: today a drag-select is ALSO the
gesture used to pick a bulk-edit region (zone=Row/Column highlight). If drag both
zooms AND scopes the edit, the two are coupled (see 3.4 — that coupling is arguably
desirable). Recommend A, with the reset control (3.3) as the escape hatch.

**Mechanism (either option):** the wiring already exists —
`setRangeOfPitches(selectedPitches)` + `setRangeOfModes(selectedModes)`. For Option A,
add a `onMouseUp` (or a "commit selection" callback) in `PitchesModesMatrixCanvas` that,
when a drag selection exists, calls a new `onZoomToSelection` prop →
`MeasuredMatrix` → parent sets view range = selection.

To make the canvas iterate the new (smaller) range, nothing else changes — the existing
view-range deps (canvas redraw effect line 214-224, cell-size effect line 91) already
recompute on `pianoRange`/`modesRange` change.

**Guard:** ignore single-cell "drags" (selection where min==max on both axes) so a plain
click still navigates/edits one cell instead of zooming to a 1×1 view.

### 3.2 Selection persistence after zoom

Once the view range == the selection, should the orange selection box stay (now filling
the whole pane) or clear? Recommend: **keep `selectedPitches`/`selectedModes` as-is**
(do not clear) so the selection-scoped edit (3.4) still has a scope after zoom, and the
"reset" control (3.3) can distinguish "zoomed" from "fresh". The orange box filling the
pane is acceptable (it equals the viewport). OPEN QUESTION Q2 — confirm with user.

### 3.3 Spec item 3 — reset / un-zoom

Reuse the existing reset button (PianoidTuner:2267-2281) but fix it:
- Relabel/reicon correctly ("Reset zoom" / fit-to-content icon).
- Replace the hardcoded `[0,63]` modes reset with `[0, totalModes-1]`.
- Extend the gating list to include `"Sound Channels"`.
- On reset: set view range = full available range AND (recommend) clear
  `selectedPitches`/`selectedModes` so the next edit is unscoped again. OPEN QUESTION Q3:
  should reset also clear the selection, or only un-zoom? (I recommend: reset clears both.)

### 3.4 Spec item 2 — selection-scoped edits (the real new logic)

This is the only part that needs genuinely new code. Two layers:

**(a) Teach `calcChange` to honour a bound.** Add an optional `bounds` field on the
change object: `{ pitchMin, pitchMax, modeMin, modeMax }` (absolute pitch ids + mode
indices). When present, every zone clamps its writes to the bound:
- `Cell` — unaffected (already a point).
- `modesVector` (Row) — instead of `.fill(value)` over the whole row, write only
  `mode ∈ [modeMin..modeMax]`.
- `pitchesVector` (Column) — write only pitches `∈ [pitchMin..pitchMax]`.
- `Matrix` — write only the cells inside the rectangle.

This keeps `calcChange` the single scoping primitive (P2: matrix-mutation concern stays
in one function). All existing call-sites that pass no `bounds` are byte-identical.

**(b) Decide what "the selection" means for scoping. OPEN QUESTION Q4 (the central design
question).** Three candidate models — the user must pick one:

| Model | "Edit scope" = | Pros | Cons |
|---|---|---|---|
| **M1 — zoom IS the scope** | the current VIEW range (`rangeOfPitches`/`rangeOfModes`) | "what you see is what you edit"; matches spec ("edits apply to the selected area" where the selected area became the view); no extra UI | after a reset the scope is the whole matrix again (maybe surprising); can't edit a sub-region without zooming into it |
| **M2 — selection IS the scope** | the SELECTION range (`selectedPitches`/`selectedModes`), independent of zoom | edit a sub-region without changing zoom; selection box visibly marks the edit area | needs the selection to persist & be visible; what if no selection? (fall back to whole matrix or to the zone) |
| **M3 — zone selector unchanged; selection only sets default extent** | keep Cell/Row/Column/Matrix semantics; selection just narrows Row→sub-row etc. | least behavioural change; backward compatible | most complex mental model (three concepts interacting) |

**Recommendation: M1 (zoom = scope).** It is the simplest, matches the spec phrasing
most directly ("the matrix auto-scales to the selected area" + "all edits apply to the
selected area only" → the selected area becomes both the view and the edit scope), and
makes the zone selector's meaning intuitive: a "Matrix" op fills the *visible* matrix,
"Row" fills the visible part of a row, etc. With M1, `bounds` in 3.4(a) is simply the
current view range, passed automatically by `MeasuredMatrix` into every change it emits.

**Interaction with the zone selector under M1:** the zone selector keeps choosing the
*shape* (cell / row / column / whole), and the view range bounds the *extent*. e.g.
zone=Matrix + zoomed view → "set every visible cell to V". zone=Row + zoomed view →
"set the visible span of the clicked pitch's row". This is coherent and needs no new UI.

### 3.5 Network-emit scoping

Selection/zoom-scoped edits still emit per-pitch POSTs. Today `changeTouchesWholeMatrix`
decides one-pitch vs whole-matrix emit. Under M1, a scoped "Matrix" op touches multiple
pitches but not all → it must emit the affected pitch rows (a small batch of per-pitch
POSTs), not a single whole-matrix call and not a single-pitch call. The emit helpers
(`applyFeedinChange` etc.) need to compute the affected-pitch set from the bound. This is
the one place the granular-write principle requires care — design the emit to iterate
`pitchMin..pitchMax` and POST each, matching the per-pitch contract already used by the
SC refactor.

---

## 4. Files to touch (for the eventual implementation — NOT this session)

| File | Change | Risk |
|---|---|---|
| `src/components/PitchesModesMatrixCanvas.jsx` | add `onMouseUp`/commit-selection → `onZoomToSelection` (Option A); ignore 1×1 drags | low |
| `src/components/MeasuredMatrix.jsx` | thread `onZoomToSelection`; pass `bounds`(=view range under M1) into every `handleMatrixValuesChange` | **OVERLAP — see §6** |
| `src/hooks/useMatrixHistory.js` | `calcChange`: optional `change.bounds` clamps every zone | medium (core mutation logic — needs the existing Jest/regression coverage) |
| `src/PianoidTuner.js` | fix reset button (label/icon, `[0,totalModes-1]`, add "Sound Channels"); auto-zoom wiring; scoped emit in `applyFeedinChange`/`applyFeedbackChange` | medium |
| `src/components/SoundChannelsPane.jsx` | stop hardcoding full `pianoRange`/`modesRange` — consume shared `rangeOfPitches`/`rangeOfModes`; pass real `selectedPianoRange`/`selectedModesRange` (with the local-channel caveat); scoped emit in `applyImperativeChange` path | **OVERLAP — see §6** |
| `src/hooks/useSoundChannels.js` | scoped emit (`applyImperativeChange` → bound-aware) | medium |

No backend change. No CUDA. Pure frontend.

---

## 5. Data flow (Option A + M1)

```
drag in canvas
  → onSelectRect (per move)         → setSelectedPitches/Modes  (live highlight)
  → onMouseUp (drag end, >1 cell)   → onZoomToSelection
        → setRangeOfPitches(selectedPitches)
        → setRangeOfModes(selectedModes)
              → canvas redraws: cell size grows, only selected window iterated  [ZOOM]

edit (zone + op + value, click a cell)
  → handleMatrixValuesChange(zone, op, value, mode, pitch, bounds=viewRange)
        → applyFeedinChange / applyImperativeChange
              → useMatrixHistory.calcChange(…, change{ …, bounds })   [SCOPED MUTATION]
              → emit per-pitch POSTs for pitches ∈ bounds              [SCOPED WIRE]

reset button (title bar)
  → setRangeOfPitches(full); setRangeOfModes([0, totalModes-1])
  → setSelectedPitches(null); setSelectedModes(null)                   [UN-ZOOM + clear scope]
```

---

## 6. Concurrency flag — overlap with dev-fbsl (feedback slider)

★ dev-fbsl is concurrently IMPLEMENTING the feedback coefficient slider. Per the
team-lead brief it edits `usePreset.js`, `ToolBar.jsx`, `PianoidTuner.js`, and
**MeasuredMatrix matrix-edit-disable**.

**Overlapping files this proposal also needs:**
- **`MeasuredMatrix.jsx`** — dev-fbsl adds a matrix-edit-disable path; this proposal adds
  `bounds` threading + `onZoomToSelection`. Both touch the same component. **Sequence
  dev-fbsl FIRST, then this**, or coordinate a single combined edit.
- **`PianoidTuner.js`** — both touch it (dev-fbsl: slider wiring; this: reset button +
  scoped emit). Large file; conflicts likely if parallel. **Sequence, do not parallelize.**
- `SoundChannelsPane.jsx` — dev-fbsl's brief mentions "single-matrix mode" disabling the
  Feedback matrix; the SC pane already shows a single-matrix Alert for Feedback. Confirm
  whether dev-fbsl also touches SC; if so, SC is a third overlap.

**Recommendation to team-lead:** schedule this feature's implementation AFTER dev-fbsl
merges, on a fresh branch off the post-fbsl `dev`. No file-level parallelism on
`MeasuredMatrix.jsx` / `PianoidTuner.js`.

---

## 7. Open questions for the user (must answer before implementation)

- **Q1.** Auto-zoom on drag-release (Option A, matches spec) or keep an explicit
  "Zoom to selection" button (Option B)? *Recommend A.*
- **Q2.** After zooming, keep the selection highlight (fills the pane) or clear it?
  *Recommend keep (so scoped edits still have a scope).*
- **Q3.** Does "reset" un-zoom only, or also clear the selection? *Recommend clear both.*
- **Q4 (central).** Edit-scope model — **M1 (zoom = scope, recommended)**, M2 (selection
  independent of zoom = scope), or M3 (zone-selector + selection narrows extent)?
- **Q5.** Sound Channels: should SC become zoomable too (it is hardcoded full-range
  today)? The strings axis rows are output channels — zoom on the channel axis is
  unusual but consistent. *Recommend yes for symmetry, but confirm.*
- **Q6.** Should the zone selector (Cell/Row/Column/Matrix) stay, or does select-to-zoom +
  scoped edits make it redundant (e.g. "Matrix op on the zoomed view" replaces "Row")?
  *Recommend keep — zone = shape, scope = extent; they are orthogonal under M1.*

---

## 8. Effort estimate (post-decision)

Small-to-medium frontend-only change. The zoom plumbing is ~80% present; the genuinely
new work is (a) bound-aware `calcChange` + its Jest coverage, and (b) bound-aware
per-pitch emit. One `/dev` session, no CUDA, with `/test-ui` audio_off verification only
if any edit path changes the emitted matrix (it does — scoped edits change what reaches
the engine, so a measured before/after on a scoped Row edit is warranted).
