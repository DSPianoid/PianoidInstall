# System-Wide Selection + Per-Chart Zoom — Design Proposal

- **Author:** dev-mzoom
- **Date:** 2026-06-06
- **Status:** PROPOSAL (design-first; NO implementation until user approves)
- **Origin:** User request (Telegram msg 3281), relayed via team-lead.
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

## 3. Proposed model

### 3.1 Two orthogonal axes of state

| Concept | Scope | Rationale |
|---|---|---|
| **Selection range** (`selectedPitchRange`, `selectedModeRange`) | **GLOBAL** (system-wide) | "applies universally; controlled from any relevant editor." Drives edit-scoping (already does) + cross-chart highlight. |
| **View/zoom range** (per-chart) | **PER-CHART** | "each chart editor has zoom applied INDIVIDUALLY." |

Rename for clarity in the proposal (final names TBD with user): keep `selectedPitches`/
`selectedModes` as the GLOBAL selection (they already are), and MOVE the view range
OUT of the single global `rangeOfPitches`/`rangeOfModes` into a per-chart store.

### 3.2 Global selection range (system-wide)

- `selectedPitches` and `selectedModes` STAY in `useCurrentValues` (already global).
- ANY pitch-based editor's drag-select writes `setSelectedPitches`; ANY mode-based
  editor's drag-select writes `setSelectedModes`. (Mostly wired already — gap: Strings
  currently writes `setSelectedPitches` via `onSelectRange`; confirm Modes writes
  `setSelectedModes`; Excitation has no range.)
- **★SC channel axis NEVER writes `selectedPitches`** — stays SC-LOCAL
  (`selectedChannelRange`), exactly as today. The SC MODE axis writes the global
  `selectedModes`. (Unchanged from current; the design must preserve it verbatim.)

### 3.3 AXIS → RANGE mapping per editor (the contract)

| Editor | Axis | Controls GLOBAL selection? | Per-chart zoom axis |
|---|---|---|---|
| Strings | pitch | YES → `selectedPitches` | pitch |
| Modes | mode | YES → `selectedModes` | mode |
| Feedin | pitch (row) + mode (col) | YES both | pitch + mode |
| Feedback | pitch (row) + mode (col) | YES both | pitch + mode |
| Excitation | pitch (single `selectedPitch`) | single-select only (no range today) | pitch (optional) |
| Sound Channels | **channel (row)** | **NO — SC-LOCAL only** | channel (LOCAL) |
| Sound Channels | **mode (col)** | YES → `selectedModes` | mode |
| Workbench (piano param) | pitch | YES → `selectedPitches` | pitch |
| Workbench (mode param) | mode | YES → `selectedModes` | mode |

"Pitch-based charts control pitch range; mode-based charts control mode range" maps
cleanly EXCEPT the SC channel row, which is its own axis and stays local.

### 3.4 Per-chart zoom (view range)

**Proposed:** each pane owns its OWN view range, keyed by pane id, NOT the shared
global `rangeOfPitches`/`rangeOfModes`. Options for where it lives:

- **Option Z1 (recommended): a per-pane `viewRange` map in `useCurrentValues`** —
  `{ [paneId]: { pitch: [lo,hi], mode: [lo,hi] } }`. The toolbar zoom buttons read/write
  `viewRange[id]` for the pane whose toolbar was clicked (the `id` is already passed to
  `renderToolbarControls`). Default per axis = full extent (un-zoomed) OR the global
  selection (see 3.5). Dynamic workbenches get an entry on open.
- **Option Z2: per-pane-persisted in settings buckets** (like `visualization`/`autoScale`
  from the toggle work). Survives reload. Heavier; view range is more ephemeral than a
  setting, so Z1 (in-memory selection context) is the better fit — but flag for user.

**Relationship between global selection and per-chart zoom (resolved):**

- They are **independent dimensions**. Selection = "what region is chosen" (drives
  edits + highlight, global). Zoom = "what region is visible in THIS chart" (per-chart).
- **Zoom does NOT update the global selection**, and selecting does NOT auto-zoom —
  EXCEPT the explicit, user-driven "zoom to selection" action (the existing Unzoom/
  zoom-out button already does `setRangeOf*(selectedPitches||full)`). Proposal: keep a
  per-chart "zoom to current selection" affordance (the existing button, now scoped to
  the one chart) so the user can opt INTO aligning a chart's view with the global
  selection, but it's a one-shot action, not a binding.
- This resolves coherently: editing scope (selection) is universal; visibility (zoom)
  is local; the two meet only via the explicit zoom-to-selection button.

### 3.5 "New chart opens zoomed-in by default" — semantics to define

A "new chart" = a newly-opened **dynamic Workbench** (`openWorkbench`) primarily; also
applies to a freshly-mounted editor pane. "Zoomed-in by default" needs a target:

- **Option D1 (recommended): zoom the new chart to the current GLOBAL selection** — if
  a `selectedPitches`/`selectedModes` is active, the new chart opens with `viewRange =
  that selection`; if no selection, opens at full extent (or a sensible default
  sub-range). This makes "open a workbench for the region I'm working on" the default —
  matches the workflow the request implies.
- **Option D2: zoom to a fixed default sub-range** (e.g. an octave around `selectedPitch`,
  or modes `[0, 31]`). Predictable but ignores the user's current focus.
- **Option D3: zoom to the parent chart's current view** (the chart the workbench was
  spawned from). Contextual but requires threading the spawning pane's view range.

Recommend D1 (selection-driven), with full-extent fallback when nothing is selected.
Needs user confirmation.

## 4. Reconciliation with the just-built matrices-zoom per-pane view ranges

The matrices-zoom work (dev-mzoom) currently uses the SHARED global `rangeOfModes`/
`rangeOfPitches` as the view range. Under this proposal:

- **The view range moves from global → per-chart (Section 3.4).** The matrices-zoom
  feature is REPLACED-IN-PLACE, not layered: SC/Feedin/Feedback read `viewRange[id]`
  instead of the shared `rangeOfModes`/`rangeOfPitches`. Behavior for a single pane is
  identical; the only change is that zooming one pane no longer zooms the others.
- **Selection-scoped edits are UNAFFECTED** — they already key off the SELECTION
  (`selectedPitches`/`selectedModes`/SC-LOCAL `selectedChannelRange`), which stays
  global. So `useMatrixHistory` `bounds` logic needs NO change.
- **The SC channel-axis decouple is preserved** — channel view range (if zoomable
  later) stays SC-LOCAL alongside `selectedChannelRange`; never enters the per-chart
  pitch view either, since SC rows aren't pitches.
- **The bar-chart auto-scale toggle (just landed)** is orthogonal (y-axis), no interaction.

Net: this is an in-place ownership change of the view range + completion of the global
selection wiring. Lower-risk than it sounds because the highest-stakes path (edit
scoping + SC decouple) is already selection-keyed and stays as-is.

## 5. Open design questions (for the user — team-lead to relay)

1. **Q-selection-default:** today `selectedPitches`/`selectedModes` default to `null`
   (no selection → edits hit whole matrix). Keep null-default (explicit drag to select),
   or default the global selection to the full extent? (Affects "new chart zoomed-in"
   when nothing has been selected yet.)
2. **Q-new-chart-zoom (D1/D2/D3):** new chart zooms to the current global selection
   (D1, recommended), a fixed default sub-range (D2), or the spawning chart's view (D3)?
   And when NO selection is active, does a new chart open full-extent or at some default
   sub-range?
3. **Q-zoom-store (Z1/Z2):** per-chart view range in-memory (Z1, recommended) or
   persisted across reloads in settings buckets (Z2)?
4. **Q-zoom-to-selection binding:** should per-chart zoom be PURELY independent (zoom is
   never auto-driven by selection; only the explicit button aligns them, recommended),
   or should changing the global selection AUTO-zoom every chart to it (tighter coupling,
   closer to today's shared-range behavior but per-chart)?
5. **Q-scope-of-"any relevant editor":** does "controlled from any relevant editor"
   include the single-select editors (Excitation uses `selectedPitch`, not a range) — do
   we add range-select to Excitation, or is it out of scope (pitch range read-only there)?
6. **Q-SC-channel-zoom:** the SC channel ROW axis is currently NOT zoomable (full extent).
   Does "each chart zoomed individually" include adding per-chart channel-row zoom to SC
   (SC-LOCAL), or is the SC channel axis explicitly out of scope (mode-axis zoom only)?
7. **Q-cross-pane highlight:** should the global selection render as a visible highlight
   band in EVERY relevant chart (so you see "the selected region" everywhere), or only
   drive edit-scoping silently? (The request says selection "applies universally" — likely
   wants the visible band, but confirm.)

## 6. Risks / constraints (hard)

- ★**SC channel-axis decouple (dev-snmtxleak / fa3c64b)** — channel indices MUST NOT
  enter global pitch selection or per-chart pitch view. Any global-selection wiring must
  exempt the SC channel axis. This is the single highest-stakes constraint.
- **P1 sole-writer** — the global selection ranges keep a single owner
  (`useCurrentValues`); per-chart view ranges get a single owner too (the per-pane map).
  No non-owner writes.
- **Backward-compat for selection-scoped edits** — must stay selection-keyed; do not
  re-point `bounds` at the (now per-chart) view range.
- **Dynamic workbench lifecycle** — per-chart view entries must be created on
  `openWorkbench` and cleaned on `closeWorkbench` (mirror the existing `workbenches`
  registry lifecycle) to avoid a leak.

## 7. Recommendation summary

- Selection range: **keep global** (already is); complete the per-editor wiring; EXEMPT
  the SC channel axis (verbatim preserve the decouple).
- View/zoom range: **invert global → per-chart** (Option Z1, per-pane map in
  `useCurrentValues`, keyed by pane id; toolbar zoom buttons scope to the clicked pane).
- New chart: **zoom to current global selection** (Option D1), full-extent fallback.
- Selection ↔ zoom: **independent**, meeting only via the explicit per-chart
  zoom-to-selection button.
- Reconcile matrices-zoom: **replace-in-place** (view range source swaps global → per-chart;
  edit-scoping untouched).

---

### Investigation history
- State-model audit: `src/hooks/useCurrentValues.js`, `src/PianoidTuner.js`
  (`renderToolbarControls` + per-pane range wiring), `src/components/SoundChannelsPane.jsx`
  (SC-LOCAL channel decouple), `docs/modules/pianoid-tunner/OVERVIEW.md` (`useCurrentValues`,
  `useMatrixHistory` selection-scoped-edits section).
- Prior art: dev-mzoom matrices-zoom commits (ba38453…97f98b3), dev-snmtxleak-7e3d
  (channel→pitch decouple), fa3c64b (the crash this design must not reintroduce).
