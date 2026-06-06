# System-Wide Selection + Per-Chart Zoom — Design Proposal

- **Author:** dev-mzoom
- **Date:** 2026-06-06
- **Status:** FINALIZED DESIGN (tie/untie model per user msg 3285) + phased plan; NO implementation until the user's FINAL go.
- **Origin:** User request (Telegram msg 3281); model decided by user (msg 3285), relayed via team-lead.
- **Mode:** Read-only audit + design. No source edits, no branch.

## 1. User request (verbatim intent)

> Extend the selected-area concept from the matrices editors to a SYSTEM-WIDE
> state. Selected pitch range and selected mode range should apply universally to
> any relevant chart/editor, controlled from any relevant editor (pitch-based
> charts control pitch range, mode-based charts control mode range). Each chart
> editor should have zoom in/zoom out applied to the chart INDIVIDUALLY. When a new
> chart is opened, it should be zoomed in by default.

Two distinct concepts are bundled here, and the audit shows they pull in **opposite
directions** from today's code:

1. **Selection range** → make it **system-wide / global** (settable from any editor).
2. **Zoom (view range)** → make it **per-chart / individual**.

The key finding (Section 2) is that today the code has these BACKWARDS: the **view
range is already global** (shared by every pane), and the **selection range is also
global but only partially wired**. So the work is largely an *ownership inversion*
for the view range, plus completing the selection-range plumbing.

## 2. Current state-model audit (read-only)

All selection/range state lives in **`useCurrentValues`** (`src/hooks/useCurrentValues.js`),
instantiated ONCE in `PianoidTuner.js` and threaded into every pane. There is no
per-pane copy — every pane reads and writes the *same* state objects.

### 2.1 State inventory (`useCurrentValues`)

| State | Default | Semantics | Owner / writers today |
|---|---|---|---|
| `selectedPitch` | `null` | single selected pitch (keyboard cursor) | global; set by every pitch editor's `onPitchSelect`/`onSelectNote` |
| `rangeOfPitches` | `[21, 99]` | **VIEW/zoom range** on the pitch axis | **GLOBAL**; written by `setRangeOfPitches` from EVERY pane's `onPianoRangeChange`/`onRangeChange` |
| `selectedPitches` | `null` | **SELECTION range** on the pitch axis (drag-select) | **GLOBAL**; written by `setSelectedPitches` from pitch editors' `onSelectPitchesRange`/`onSelectRange` |
| `selectedMode` | `null` | single selected mode | global |
| `selectedModes` | `null` | **SELECTION range** on the mode axis | **GLOBAL**; `setSelectedModes` |
| `rangeOfModes` | `[0, 63]` | **VIEW/zoom range** on the mode axis | **GLOBAL**; `setRangeOfModes` |
| `selectedModeFeedIn` / `selectedModeFeedback` | `null` | per-matrix selected mode (Feedin/Feedback column highlight) | global, matrix-specific |
| `selectedParameter` / `selectedValues` | `null` | currently-activated parameter row (drives Workbench) | global |
| `matrixRowIsPiano` | `true` | row-axis orientation toggle | global |
| `workbenches` | `{}` | dynamic-workbench registry `{id: {parameter, matrixRowIsPiano}}` | global |

### 2.2 SC-LOCAL state (NOT in `useCurrentValues`) — ★the hard constraint

`SoundChannelsPane.jsx` owns two pieces of LOCAL state that must NEVER enter the
global pitch space:

- `selectedChannel` (single output-channel index)
- `selectedChannelRange` (channel-row drag range)

**Why this is load-bearing:** SC strings-axis ROWS are OUTPUT CHANNELS `0..N-1`,
NOT piano pitches `21..108`. Routing a channel index into the global
`rangeOfPitches`/`selectedPitches` (piano space) caused the **fa3c64b crash**
(`matrix[-22]` — a channel index used as a piano-pitch offset poisoned the shared
state) and is the **dev-snmtxleak-7e3d** invariant. The SC pane therefore passes
`onPianoRangeChange={NOOP_RANGE}` / `selectedPianoRange={selectedChannelRange}`
(LOCAL) on the channel axis, and only wires the shared `rangeOfModes`/`selectedModes`
on the SC mode-COLUMN axis. **This decouple is non-negotiable in any global design.**

### 2.3 How each editor wires range/selection today (`PianoidTuner.js`)

| Pane | Pitch-axis view range | Mode-axis view range | Selection wiring | Notes |
|---|---|---|---|---|
| **Feedin** | `pianoRange={rangeOfPitches}` → `setRangeOfPitches` | `modesRange={rangeOfModes}` → `setRangeOfModes` | `selectedPianoRange={selectedPitches}`, `selectedModesRange={selectedModes}` | both axes global |
| **Feedback** | same as Feedin | same | same | both axes global |
| **Strings** | `range={rangeOfPitches}` → `setRangeOfPitches` | — | pitch only | pitch editor |
| **Modes** (`ModesRule`) | — | `range={rangeOfModes}` → `setRangeOfModes` | mode only | mode editor |
| **Excitation** | uses `selectedPitch` (single, not range) | — | per-pitch | range-zoom largely N/A |
| **Sound Channels** | channel-ROW axis FULL (`pianoRange=[notes[0..last]]`, `selectedPianoRange=null`); channel selection SC-LOCAL | `modesRange={rangeOfModes}` → `setRangeOfModes`; `selectedModesRange={selectedModes}` | mode-axis global; channel-axis LOCAL | ★the decouple |
| **Workbench (default)** | `range={isPiano ? rangeOfPitches : rangeOfModes}` → `setRangeOfPitches`/`setRangeOfModes` | (same range, axis-dependent) | `selectedRange={isPiano ? selectedPitches : selectedModes}` | inherits global |
| **Workbench (dynamic clone)** | same as default | same | same | inherits global |

**The toolbar zoom buttons** (`renderToolbarControls`, shared) operate on the GLOBAL
`rangeOfPitches`/`rangeOfModes` — so clicking ZoomIn/Unzoom on *any* pane changes the
view of *every* pane simultaneously. This is the behavior the user wants to make
per-chart.

### 2.4 The just-built matrices-zoom (dev-mzoom, must reconcile)

The recently-landed SC mode-axis zoom + selection-scoped edits (commits ba38453…97f98b3)
deliberately REUSED the shared `rangeOfModes`/`selectedModes` so SC columns zoom
"exactly like Feedin/Feedback." Selection-scoped edits (`useMatrixHistory` `bounds`)
derive the edit rectangle from the **SELECTION** range per axis (`selectedPitches`/
`selectedModes`, or SC-LOCAL `selectedChannelRange`), NOT the view range. **This means
the selection→bounds edit-scoping is already decoupled from the view/zoom range** — a
favorable starting point: making zoom per-chart will NOT disturb selection-scoped
editing, because that keys off the selection, which we keep global.

## 3. FINALIZED MODEL — tie/untie auto-zoom (user decision, msg 3285)

The user gave a decisive model. This section is now the authoritative design; the
earlier "independent dimensions" framing (and the Z/D/Q options) is SUPERSEDED by the
tie/untie model below.

### 3.1 The model

- **GLOBAL selection** — `selectedPitches` (pitch range) + `selectedModes` (mode range),
  settable from ANY relevant editor. Already global in `useCurrentValues` today.
- **Per-chart `tied` flag — DEFAULT `true`** — the ONLY new per-chart state. A chart's
  view range is **DERIVED**, not stored:

  ```
  chartView(axis) = tied ? (globalSelection(axis) ?? fullRange(axis))
                         : fullRange(axis)
  ```

  - **Tied (default):** the chart AUTO-ZOOMS its view to follow the global selection.
    Nothing selected → full view. When a selection is made (from any editor), ALL tied
    charts auto-zoom to it.
  - **Untied:** the chart shows the FULL range, with the selected area drawn as a
    HIGHLIGHT band.
- **ZOOM-OUT button = UNTIE** that chart (`tied=false`) → full range + highlight band.
- **ZOOM-IN button = RE-TIE** that chart (`tied=true`) → auto-zoom back to the selection.
- **NEW chart opens TIED** (default) → auto-zoomed to the current selection (full if none).

This REPLACES today's single shared `rangeOfPitches`/`rangeOfModes` as the source of a
chart's view: the view is now derived from `(tied, globalSelection, fullRange)`. The
per-chart `tied` boolean is the only new per-chart state — there is NO stored per-chart
view range (it's always derived), which is simpler than the earlier per-pane viewRange
map and removes a whole class of stale-range bugs.

### 3.2 Confirmed defaults (user did not override)

- **Selection null-default** — nothing selected = whole-matrix edits, exactly as today
  (`selectedPitches`/`selectedModes` stay `null` until a drag-select). A tied chart with
  no selection shows the full range.
- **`tied` flag in-memory** — per-chart React state, NOT persisted, unless persistence is
  trivial (it is per-session UI state; in-memory is the right default).
- **Excitation OUT of scope** — single-pitch editor (`selectedPitch`, no range); not part
  of the tie/untie range model.
- **SC channel-ROW zoom OUT of scope** — SC mode-axis only (see §3.4).

### 3.3 AXIS → RANGE mapping per editor (the contract)

| Editor | Axis | Sets GLOBAL selection? | Tie/untie view axis |
|---|---|---|---|
| Strings | pitch | YES → `selectedPitches` | pitch |
| Modes | mode | YES → `selectedModes` | mode |
| Feedin | pitch (row) + mode (col) | YES both | pitch + mode |
| Feedback | pitch (row) + mode (col) | YES both | pitch + mode |
| Excitation | pitch (single `selectedPitch`) | OUT OF SCOPE (single-select) | — |
| Sound Channels | **channel (row)** | **NO — SC-LOCAL only; NEVER global pitch** | **none (always full; OUT OF SCOPE)** |
| Sound Channels | **mode (col)** | YES → `selectedModes` | mode (tie/untie follows global mode selection) |
| Workbench (piano param) | pitch | YES → `selectedPitches` | pitch |
| Workbench (mode param) | mode | YES → `selectedModes` | mode |

### 3.4 ★(a) CONFIRMED — SC channel-axis exemption holds in the tie/untie model

A **tied SC chart auto-zooms its MODE axis** to the global mode selection
(`selectedModes`). Its **CHANNEL (row) axis stays FULL and SC-LOCAL** — it is NEVER
driven by the global pitch selection, NEVER reads/writes `selectedPitches`, and is NOT
zoomable in this scope. Concretely, in the derived-view formula the SC pane evaluates
ONLY the mode axis against `tied`:

```
SC chart mode axis  = tied ? (selectedModes ?? fullModes) : fullModes
SC chart channel axis = ALWAYS fullChannels   // SC-LOCAL, never global pitch
```

This preserves the dev-snmtxleak-7e3d decouple and cannot reintroduce the fa3c64b crash
(`matrix[-22]`): a channel index `0..N-1` can never flow into `selectedPitches` (piano
space `21..108`) because the SC channel axis is simply not wired to the global pitch
selection at all — neither as a setter (drag-select stays SC-LOCAL) nor as a reader
(view always full). The SC channel selection for EDIT-scoping continues to use the
SC-LOCAL `selectedChannelRange` (unchanged). **This is the hard constraint and it holds.**

### 3.5 ★(b) HIGHLIGHT band — when shown

- **UNTIED chart:** YES — the chart shows the FULL range with the selected sub-range
  drawn as a highlight band (an ECharts `markArea` over the selected pitch/mode span).
  This is the band's primary purpose: "see the whole thing, with the selected region
  marked."
- **TIED chart:** the band is **MOOT / effectively the whole view** — a tied chart is
  already zoomed exactly to the selection, so a highlight over `[selectionLo, selectionHi]`
  would cover the entire visible area. **Proposal: do NOT render the band when tied**
  (it adds visual noise covering 100% of the chart for no information). Exception worth
  noting: if a tied chart has NO selection (full view), there is no band to show anyway.
  - Alternative (flagged, not recommended): always render the band, even tied. Rejected
    because a full-coverage band is noise. If the user prefers an always-on faint band
    for consistency, it's a one-line `markArea` opacity tweak — easy to add later.
- **Band semantics:** the band reflects the GLOBAL selection (same span every untied
  chart highlights), so the user sees the one selected region consistently across all
  untied charts. SC: the band is on the MODE axis only (channel axis has no global
  selection to show).

### 3.6 Cross-pane behavior summary (the coherent picture)

1. User drag-selects a pitch range in Strings → `setSelectedPitches`.
2. Every TIED pitch-aware chart (Feedin/Feedback rows, Workbench-piano, Strings itself)
   auto-zooms its pitch axis to that range. Mode-aware charts are unaffected (no mode
   selection changed).
3. User clicks ZOOM-OUT on Feedback → Feedback unties → shows full pitch range with the
   selection as a highlight band. Other charts stay tied/zoomed.
4. User clicks ZOOM-IN on Feedback → re-ties → auto-zooms back to the selection.
5. User opens a new Workbench → opens tied → auto-zoomed to the current selection.

## 4. Reconciliation with the just-built matrices-zoom per-pane view ranges

The matrices-zoom work (dev-mzoom, ba38453…97f98b3) currently uses the SHARED global
`rangeOfModes`/`rangeOfPitches` as the view range, and its toolbar ZoomIn/ZoomOut write
that shared range. Under the tie/untie model:

- **REPLACE-IN-PLACE.** The shared `rangeOfPitches`/`rangeOfModes` view-range plumbing is
  replaced by the derived-view formula (§3.1). The toolbar ZoomIn/ZoomOut buttons change
  meaning from "set the shared view range" to "re-tie / untie THIS chart." Single-chart
  behavior is similar (zoom in = see the selection; zoom out = see everything) but now
  per-chart instead of global.
- **`selectedModes`/`selectedPitches` are KEPT** (they're the global selection that
  drives both edit-scoping AND the tied view) — only the `rangeOf*` VIEW state is
  retired/derived.
- **Selection-scoped edits UNAFFECTED** — `useMatrixHistory` `bounds` already key off the
  SELECTION (`selectedPitches`/`selectedModes`/SC-LOCAL `selectedChannelRange`). NO change
  to bounds logic. (This is why the tie/untie model is lower-risk than it looks: the
  dangerous path — edit scoping + SC decouple — is already selection-keyed and untouched.)
- **Bar-chart auto-scale toggle (ebea866)** is orthogonal (y-axis); no interaction with
  the x-axis tie/untie view.
- **The SC mode-axis zoom built in 97f98b3** becomes the tied-mode-axis behavior for SC;
  the SC channel-row "stays full" decision from that work is preserved verbatim.

## 5. PHASED IMPLEMENTATION PLAN

Phased so each lands + HMR-tests independently — NOT one giant commit. All frontend-only,
no CUDA build. Each phase is a separate commit on a feature branch (proposed
`feature/system-wide-selection`, off `dev` after the matrices-zoom + autoscale branches
merge — sequencing is team-lead's call). Default `tied=true` keeps each phase
behaviorally close to today until the untie path is wired.

**Phase 0 — derived-view core (no UI change yet).**
- Files: `src/hooks/useCurrentValues.js` (add per-chart `tied` map `{ [paneId]: bool }`
  defaulting true + `setTied(paneId, bool)`; keep `selectedPitches`/`selectedModes`);
  a small pure helper `deriveChartView(tied, selection, fullRange)` (new
  `src/utils/chartView.js`, unit-tested).
- Independently testable: Jest unit tests on `deriveChartView` (tied+selection → selection;
  tied+no-selection → full; untied → full) + `tied` map get/set/default. No visible change.

**Phase 1 — wire ONE pitch editor end-to-end (Strings) as the reference.**
- Files: `src/PianoidTuner.js` (Strings pane: view = `deriveChartView(tied["Strings"], …)`;
  ZoomIn/ZoomOut buttons in `renderToolbarControls` call `setTied("Strings", true/false)`
  instead of `setRangeOfPitches`).
- Independently testable: live HMR — select a pitch range in Strings, it auto-zooms (tied);
  ZoomOut → full + highlight band; ZoomIn → re-zoom. Jest: toolbar button → setTied.

**Phase 2 — the highlight band (DrawableChart/RowEditor markArea).**
- Files: `src/components/DrawableChart/DrawableChart.jsx` (add an optional
  `highlightRange` prop → ECharts `markArea` over `[lo,hi]`, shown only when untied +
  selection present); thread from RowEditor/BarChart. ★Coordinate with feature/mzoom-sc-zoom
  (DrawableChart) — flag the region to team-lead for merge sequencing.
- Independently testable: untied chart shows the band; tied chart shows none; Jest on the
  markArea option.

**Phase 3 — roll out to the remaining pitch + mode editors.**
- Files: `src/PianoidTuner.js` (Feedin, Feedback, Modes, Workbench default + dynamic) +
  `src/components/SoundChannelsPane.jsx` (SC MODE axis only — ★channel axis untouched,
  stays full/SC-LOCAL).
- Independently testable per editor: each pane ties/unties on its own; selecting in one
  pitch editor zooms all tied pitch editors; SC mode-axis ties to `selectedModes`; SC
  channel axis verified STILL full + SC-LOCAL (regression test for the decouple).

**Phase 4 — new-chart-opens-tied + dynamic-workbench lifecycle.**
- Files: `src/hooks/useCurrentValues.js` (`openWorkbench` seeds `tied[id]=true`;
  `closeWorkbench` deletes `tied[id]` — mirror the `workbenches` registry lifecycle).
- Independently testable: open a workbench while a selection is active → it opens
  auto-zoomed to the selection; close → no leaked `tied` entry.

**Phase 5 — retire the dead shared view-range plumbing + docs.**
- Files: `src/hooks/useCurrentValues.js` (remove `rangeOfPitches`/`rangeOfModes` if fully
  superseded, OR keep as `fullRange` source — decide during impl), `PianoidTuner.js`
  cleanup of now-dead `setRangeOf*` wiring; `docs/modules/pianoid-tunner/OVERVIEW.md`
  (`useCurrentValues` + matrices-zoom sections rewritten to the tie/untie model).
- Independently testable: full Jest green; live HMR full regression of all editors.

**Regression guard across all phases:** the SC channel→pitch decouple
(`SoundChannelsPane.localChannel.test.jsx` + a new tie/untie-specific assertion that SC
channel axis never reads `selectedPitches` and its view is always full). The fa3c64b
crash must remain impossible.

## 6. Risks / constraints (hard)

- ★**SC channel-axis decouple (dev-snmtxleak / fa3c64b)** — channel indices MUST NOT
  enter global pitch selection or any pitch view. The tie/untie model exempts the SC
  channel axis entirely (§3.4): it is neither a global-selection setter nor a tied-view
  reader. Single highest-stakes constraint; confirmed to hold (§3.4).
- **P1 sole-writer** — global selection (`selectedPitches`/`selectedModes`) and the new
  per-chart `tied` map both live in `useCurrentValues` (single owner). No non-owner writes.
- **Backward-compat for selection-scoped edits** — `useMatrixHistory` `bounds` stays
  selection-keyed; the retired `rangeOf*` view state must NOT be wired back into bounds.
- **Dynamic workbench lifecycle** — `tied[id]` created on `openWorkbench`, deleted on
  `closeWorkbench` (Phase 4) to avoid a map leak.
- **Cross-branch DrawableChart (Phase 2)** — the highlight-band `markArea` touches
  DrawableChart, which also has the autoscale (ebea866) + paintDisabled (97f98b3) edits;
  sequence the merge / flag the region to team-lead.

## 7. Recommendation summary (finalized)

- **Model:** tie/untie auto-zoom (§3.1) — global selection + per-chart `tied` flag
  (default true); view DERIVED, no stored per-chart view range.
- **ZoomOut = untie** (full + highlight band); **ZoomIn = re-tie** (auto-zoom to selection).
- **New chart opens tied** → auto-zoomed to current selection (full if none).
- **★SC channel axis exempt** — mode-axis ties to global modes; channel axis always full,
  SC-LOCAL, never global pitch (§3.4, confirmed).
- **Highlight band:** shown when UNTIED; not rendered when tied (full-coverage = noise) (§3.5).
- **Reconcile matrices-zoom:** replace-in-place (retire shared `rangeOf*`; keep selection;
  edit-scoping untouched).
- **Phased rollout (§5):** Phase 0 core → 1 Strings reference → 2 highlight band → 3 all
  editors → 4 new-chart + lifecycle → 5 cleanup + docs. Each independently HMR-testable.

---

### Investigation history
- State-model audit: `src/hooks/useCurrentValues.js`, `src/PianoidTuner.js`
  (`renderToolbarControls` + per-pane range wiring), `src/components/SoundChannelsPane.jsx`
  (SC-LOCAL channel decouple), `docs/modules/pianoid-tunner/OVERVIEW.md` (`useCurrentValues`,
  `useMatrixHistory` selection-scoped-edits section).
- Prior art: dev-mzoom matrices-zoom commits (ba38453…97f98b3), dev-snmtxleak-7e3d
  (channel→pitch decouple), fa3c64b (the crash this design must not reintroduce).
