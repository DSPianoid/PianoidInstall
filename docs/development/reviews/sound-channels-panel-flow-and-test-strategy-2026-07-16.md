# Sound Channels Panel — USER FLOW (goals → actions → outcomes) + Test Strategy (READ-ONLY)

**Date:** 2026-07-16 (reframed from the implementation-map draft of the same date)
**Author:** analyse skill (READ-ONLY: no edits, no build, no render, no capture)
**Scope:** `listen_to_modes = 0` (**strings mode**) ONLY — the regime for all current SC work and testing.
`listen_to_modes = 1` (**modes mode**) exists but is a disabled placeholder in this panel and is **out of
scope** here (mentioned once, in Goal 1, then not mapped). Everything below is source-grounded (file:line
cited on every "what the system ACTUALLY does" claim). Live acoustic behaviour is BENCH-GATED and flagged.

**What this document is:** the panel modelled from the **user's intent side**. Each section is a GOAL a
person brings to the Sound Channels panel, and for that goal: how they get in, the actions they take, the
outcome they EXPECT, what the system ACTUALLY does (cited), and every branch/fallback in human terms. A
faithful component/state map of the same panel is preserved as **Appendix A (Code reference)** so nothing
verified in the prior pass is lost.

**Prior signals this builds on (not re-derived):**
- **Operator ground truth (2026-07-16, authoritative): the presets in normal use run `listen_to_modes = 0`
  (strings mode).** Strings mode is therefore the **normal, shipped, in-scope regime** — the state the user
  lands in — and this whole document is scoped to it. Modes mode (`listen_to_modes = 1`) merely *exists* as a
  deferred, out-of-scope state (a disabled placeholder in this pane), not the default.
- `sound-channel-calibration-grounding-2026-07-10.md` — coefficients are real scalars, so a **sign (±)** is
  representable but continuous phase is not (this document relies on the *sign* finding). ⚠️ Its claim that
  "every shipped preset ships `listen_to_modes: True` (modes mode)" is **contradicted by the operator's
  current usage above and is NOT relied on here** — do not treat shipped presets as modes-mode.
- `sound-channel-mute-logic-rca-2026-07-12.md` — MEASURED + FIXED: the strings-axis mute path was rejected
  `HTTP 416` before the model; fixed in PianoidCore 2026-07-12. The operator runs `listen_to_modes=0` for SC work.
- Structural reviews of the shared matrix-editor stack (`feedin-feedback-soundchannels-review-2026-06-04.md`,
  `matrix-workbench-avgsc-review-2026-06-10.md`, `parameter-editing-system-review-2026-07-07.md`).

---

## The user goals (this document's spine)

Inferred from the panel's actual capabilities (strings mode):

| # | Goal — *in the user's words* | Supported? |
|---|---|---|
| **G1** | "Let me actually edit sound channels." (get the editor to appear and work) | Yes, but gated — see G1 |
| **G2** | "Make the overall tonal balance across all my output channels brighter/quieter, per mode." (aggregate curve) | Yes |
| **G3** | "Channel 2 is too hot on these modes — fix just that channel." (per-channel editing) | Yes |
| **G3′** | "Apply the same change across a scope — a cell / a channel / a mode / a selected block / the whole matrix — either SET it or MULTIPLY (scale) it." | Partly — see G3′: SET+MULTIPLY on the matrix surface; SET-only, sign-floored on the aggregate surface |
| **G4** | "Silence this channel / this band of modes." (mute & isolate) | Yes |
| **G4′** | "Solo — hear only this channel (or this band of modes), everything else silent." | Yes — **emergent** from mute+scope (no dedicated Solo button); see G4′ |
| **G5** | "Undo that — put it back the way it was." | Yes |
| **G6** | "Apply it / hear the result." | Yes, but **implicit** — no Save, live optimistic emit — see G6 |
| **G7** | "Let the system measure and solve the right balance for a mode for me." (Calibrate) | Yes (separate panel) |

Capabilities a user might *expect* but that DO NOT exist, so no goal is built on them (stated rather
than invented):
- **An explicit Save / dirty-state / batch-apply** — every edit is live-emitted at the action site (G6).
- **A MULTIPLY (scale) on the aggregate curve** — the averaged view offers only a SET-style draw (+ Flat /
  Smooth), all floored at 0; there is no Coefficient/scale affordance there (G3′). The fan-out engine *can*
  express a scale op (`matrixAggregate.js:134-135`) but **no aggregate UI ever emits one**.
- **An arbitrary / non-contiguous multi-cell selection** — the only block scope is a **rectangular**
  drag-select (`onSelectRect` → mode-column × channel-row bounds); you cannot lasso scattered cells (G3′).

---

## Goal 1 — "Let me actually edit sound channels"

**What the user wants:** to open the panel and have a usable editor for their output-channel gains.

**Preconditions / entry.** The panel is a react-mosaic tile titled "Sound Channels"; its gear opens the
Sound Channels settings (`PianoidTuner.js:2651-2697`). Opening it is discoverable. **Usability is gated on
the engine's listen-mode, and the operator's normal presets run `listen_to_modes = 0` (strings mode), so
the pane is LIVE in the regime the user actually lands in.** The pane reads the regime from `/health` when
the backend is healthy, else from localStorage `presetLoadSettings.listen_to_modes` (`PianoidTuner.js:691-695`).

**Happy path (once in strings mode).** With `listen_to_modes=0` and a loaded preset that has output
channels, the pane renders the per-channel matrix by default (rows = OUTPUT CHANNELS 0..N-1, cols = modes),
or the aggregate curve if the averaged view is toggled on (`SoundChannelsPane.jsx:150-317`). **Expected:**
"I open Sound Channels, I see my channels, I can edit." **Actual (strings mode):** matches.

**Branches & fallbacks (in user terms):**
- **"I happened to be in modes mode and it says unavailable."** In the *deferred, out-of-scope* modes
  regime (`listen_to_modes=1`) the pane early-returns a placeholder: a HeadsetOff icon + *"Sound Channels
  editor unavailable in listen-to-modes"* + *"Switch the preset to listen-to-strings to edit sound
  channels."* (`SoundChannelsPane.jsx:121-148`). This is NOT the default the user lands in (the operator's
  presets are strings mode). **Recovery:** set `listen_to_modes=0` in the preset-load settings and re-APPLY
  (reload the preset); the pane then reads the new mode back from `/health`. **The placeholder tells them
  *why* but there is no control in the pane to *do* it** — the switch lives in a different surface. A minor
  edge for someone who deliberately entered the deferred modes regime, not a blocker on the main flow (H5).
- **"It's just blank."** In strings mode but with no loaded matrix or zero output channels, the pane renders
  a bare `<div/>` — no "load a preset" hint (`SoundChannelsPane.jsx:150`). **Recovery:** load a preset with
  output channels; the history re-inits on the `presetVersion` bump (`useSoundChannels.js:261-268`).
- **"I edited while the backend was down."** With `:5000` not healthy, the regime is sourced from
  localStorage — the user's *requested* config, which may differ from what the engine last actually ran
  (`PianoidTuner.js:681-695`). The editor can render over a surface the engine is not using (a "phantom
  matrix"); the code comment documents this as exactly why `/health` is preferred. **Hazard, not recovery.**

---

## Goal 2 — "Make the overall balance brighter/quieter, per mode" (aggregate curve)

**What the user wants:** one gesture that lifts or lowers the average level across ALL output channels at a
given mode, without touching each channel individually.

**Preconditions / entry.** Strings mode (G1). Toggle the averaged view on via the **Layers** icon
(per-pane-persisted `soundChannelSettings.aggregateMode`); the pane swaps the matrix for a single averaged
curve, x = MODE index, y = average-across-channels coefficient (`SoundChannelsPane.jsx:152-204`,
`SoundChannelsAggregateChart.jsx:449-471`). Discoverable (toolbar icon, highlighted when active).

**Happy-path actions → expected → actual.**
- **Drag-paint the curve up at some modes.** Expected: those modes get louder on average; each channel
  keeps its relative proportion. Actual: the painted average fans out to every channel proportionally
  (`useSoundChannels.js:498-532` → `matrixAggregate.js:44-49` `scaleMembersProportional`), preserving
  per-channel ratios and hitting the new average. Emitted live per affected row (`useSoundChannels.js:522-529`).
- **Flat / Smooth toolbar buttons, and the ruler to select a mode range.** Expected: set a flat level or
  smooth the curve over the selection. Actual: as expected (`SoundChannelsAggregateChart.jsx:373-383`
  toolbar; ruler drag drives global `selectedModes`).

**INTENDED sign semantics for the averaged view (operator, authoritative, 2026-07-16).** The
**average-across-channels for a mode is ALWAYS POSITIVE**, by design. Signs live in the individual cells
(edited in the matrix view, G3) — that is how a mode gets a shaped, mixed-sign channel pattern. If per-cell
edits drive a mode's average-across-channels negative, the system should **flip the sign of that mode's
WHOLE channel vector** (negate every channel's coefficient at that mode) so the displayed/edited average is
positive again — **sign-canonicalization, NOT flooring/clamping individual values at 0**. This is physically
free: a mode's GLOBAL sign is unobservable (07-10 calibration finding — a whole-mode polarity flip changes
nothing audible), so flipping the entire mode column to keep the average positive is a no-op physically while
preserving the intra-mode relative signs. Only the AVERAGE is constrained positive; individual cells stay
signed.

**Branches & fallbacks (in user terms) — where expected ≠ actual:**
- **⚠️ "I edited cells so a mode's average went negative — the aggregate should have flipped the mode's sign;
  instead the drawn value snapped to zero."** INTENDED (per above): keep the average positive by flipping the
  whole mode column's polarity, preserving each channel's relative sign. ACTUAL (**BUG**): the aggregate draw
  is **floored at 0** (`DRAG_CLAMP_MIN=0.0`, `SoundChannelsAggregateChart.jsx:45-46,366-374,482-488`), so the
  user **cannot draw a negative average**, and a floored draw drives the proportional fan-out factor toward 0
  — **zeroing the mode column and destroying its intra-mode sign shape**, a Flat-to-0 likewise. This is the
  wrong enforcement mechanism (clamp) for the decided constraint (mode-level sign flip). **Interim recovery:**
  edit signs in the per-channel matrix (G3, negatives allowed) or run Calibrate (G7). This is the sharpest
  surprise in the panel and the top fix target (Hazard H1 — now a decided bug, not an open question).
- **"I zoomed to a mode range, then painted."** The curve is sliced to the visible window and the painted
  slice is re-expanded to the full vector before emit (`SoundChannelsAggregateChart.jsx:74-90,212-224`) —
  behaves as expected; the off-screen modes are untouched.

---

## Goal 3 — "Fix just one channel" (per-channel matrix editing)

**What the user wants:** to raise/lower one specific output channel's coefficients on specific modes,
leaving the other channels alone.

**Preconditions / entry.** Strings mode (G1), aggregate view OFF (the default). The pane shows the
MeasuredMatrix: rows = output channels drawn as flat bars (tooltip "Channel"), cols = modes
(`SoundChannelsPane.jsx:222-317`). Clicking a channel row opens its per-mode RowEditor bar chart.

**Happy-path actions → expected → actual.**
- **Click a channel row, drag-paint its per-mode bars.** Expected: only that channel changes; I can go
  negative to flip polarity. Actual: the matrix path passes **no `clampMin`**, so DrawableChart's default
  `clampMin=-Infinity` applies → **negatives ARE paintable** here (`SoundChannelsPane.jsx:222-317` — no
  clampMin; `DrawableChart.jsx:81`). Edits emit live per row (`useSoundChannels.js:334-361,364-370`).
- **Select a sub-range of channels to scope an edit.** Expected: edit only the selected channels. Actual:
  the channel-row range is captured **pane-locally** (`selectedChannelRange`), never pushed into global
  pitch state (`SoundChannelsPane.jsx:111,252,290`), and MeasuredMatrix derives the row-axis edit bound
  from it.

**Branches & fallbacks (in user terms):**
- **✅ "Clicking a channel didn't break the spacebar this time."** A channel row is an output-channel index
  (0..N-1), NOT a piano pitch; routing it into the global `selectedPitch` used to swallow `pitch===0` in the
  play hotkey (the repeatedly-reported "spacebar stops after SC click" bug). Selection is now owned locally
  (`SoundChannelsPane.jsx:23-33,102,277,290`). Works as the user expects; no action needed.
- **⚠️ "The same negative edit behaves differently depending on which view I'm in."** Matrix allows negative
  cells (INTENDED — that is where the shaped, mixed-sign pattern comes from). The aggregate's INTENDED rule is
  "average always positive via a whole-mode sign flip, cells stay signed" — but the CURRENT code floors the
  draw at 0 (G2/H1 bug), so a user who shaped signs in the matrix sees the aggregate zero them. Decided
  target: matrix negatives + aggregate average-positive-by-sign-flip; the floor is the bug to remove.
- **⚠️ "I was editing here while Calibrate wrote underneath."** See G7 / Hazard H2 — the open matrix goes
  stale silently.

---

## Goal 3′ — "Apply the same change across a scope — SET it or MULTIPLY it" (scope × operation)

**What the user wants:** to pick *how much* of the matrix an edit touches — one **cell**, one **channel**
(row), one **mode** (column), a selected **block**, or the **whole matrix** — and *what the edit does* —
**SET** the value to a number, or **MULTIPLY** (scale) the existing value — and have both work everywhere.

**Where the controls live.** The per-channel matrix view (G3, aggregate OFF) always shows `MatrixTools`
(`MeasuredMatrix.jsx:267-268` `showMatrixTools={true}`) with **two exclusive toggle groups + a number box**:
- **SCOPE toggle** (`zoneKind`): **Matrix / Column / Row / Cell** (`MatrixTools.jsx:236-272`).
- **OPERATION toggle** (`operationKind`): **Navigate / Mute / Value / Coefficient** (`MatrixTools.jsx:295-330`).
  **Value = SET** (`change.operation:"Value"` → `calcChange` writes `change.newValue`, `useMatrixHistory.jsx:168`).
  **Coefficient = MULTIPLY** (`operation:"Coefficient"` → non-Value branch multiplies `cell * change.newValue`,
  `useMatrixHistory.jsx:169-170`); selecting it defaults the number box to **1** (`MatrixTools.jsx:110-112`).
- **NumInput** — the SET target / MULTIPLY factor; shown only for Value/Coefficient (`MatrixTools.jsx:334-348`).

**The gesture.** Pick a scope + Value/Coefficient + a number, then **click a cell** in the matrix canvas.
A non-Navigate click routes to `handleMatrixValuesChange` (`MeasuredMatrix.jsx:397-419`), which builds the
zone-bearing change and calls `applyImperativeChange`. The clicked cell supplies the target pitch/mode. The
UI zone maps to a storage zone by orientation (`matrixRowIsPiano`, flipped by the **Rotate** button):
- On the SC strings axis `matrixRowIsPiano=false` (the matrix feeds one channel's mode-vector to the row
  editor — `MeasuredMatrix.jsx:106`), so **Row → `modesVector`** (one output channel across all its modes)
  and **Column → `pitchesVector`** (one mode across all output channels) (`MeasuredMatrix.jsx:405-412`).
  Rotate swaps that mapping; the grid below is stated for the default (un-rotated) orientation.

### The VERIFIED scope × operation capability grid (strings mode, file:line)

| User scope | Affordance / gesture | Storage zone | SET (Value) | MULTIPLY (Coefficient) | Clamp / sign |
|---|---|---|---|---|---|
| **Cell** | Cell scope + op + click a cell | `Cell` | ✅ `newMatrix[p][m]=newValue` (`useMatrixHistory.jsx:166-168`) | ✅ `* newValue` (`:169-170`) | **No clamp; sign-capable** — SET a negative works; MULTIPLY by <0 flips sign, by >0 preserves it |
| **Row = one channel across modes** | Row scope + op + click | `modesVector` | ✅ (`:171-178`) | ✅ (`:177`) | No clamp; sign-capable |
| **Column = one mode across channels** | Column scope + op + click | `pitchesVector` | ✅ (`:179-187`) | ✅ (`:185-186`) | No clamp; sign-capable |
| **Whole matrix** | Matrix scope + op + click | `Matrix` | ✅ (`:188-199`) | ✅ (`:196-197`) | No clamp; sign-capable |
| **Selection (rectangular block)** | drag a rectangle on the canvas (`onSelectRectCommit` `MeasuredMatrix.jsx:428-435`), then a Matrix/Row/Column op → `bounds` attached (`MeasuredMatrix.jsx:215-240`) | any of the above, `change.bounds` | ✅ bounded (`useMatrixHistory.jsx:98-109,118-199`) | ✅ bounded | No clamp; sign-capable. **Cell + *Drawn IGNORE bounds** (`MeasuredMatrix.jsx:194-196`); a **Mute** op drops the mode-bound (`MeasuredMatrix.jsx:216-227`) |
| **Per-channel draw** (bottom bar editor) | click a channel row → drag-paint its per-mode bars | `modesVectorDrawn` | ✅ SET the row vector (`MeasuredMatrix.jsx:490-500`; `useMatrixHistory.jsx:207-209`) | ❌ **no draw-MULTIPLY** — draw is hardwired `operation:"Value"` | `clampMin=-Infinity` → negatives paintable (`DrawableChart.jsx:81`, RowEditor passes no clampMin) |
| **Aggregate curve** (averaged per-mode, fans to channels — G2) | AVG view → drag-paint / Flat / Smooth | `modesVectorDrawn` (`pitch:"averaged"`) | ✅ SET, fanned proportionally (`SoundChannelsAggregateChart.jsx:312-323`) | ❌ **no MULTIPLY affordance at all** (see below) | INTENDED: average kept **positive by flipping the whole mode column's sign** (cells stay signed). ACTUAL (**BUG**): `clampMin=0.0` → floored at 0, zeroing the column & destroying intra-mode sign (`SoundChannelsAggregateChart.jsx:45,366,482`) — **H1** |

**Reading the grid (answers to "is the 5×2 symmetric?"): NO.**
- **On the matrix surface the 5×2 IS complete** — {Cell, Row, Column, Selection-block, whole-Matrix} ×
  {SET, MULTIPLY} all exist, all **unclamped and sign-capable**. MULTIPLY is faithful arithmetic: multiplying
  a negative coefficient keeps it negative (or flips it if the factor is negative). Nothing floors a matrix
  edit.
- **MULTIPLY exists ONLY as the toolbar `Coefficient` op on the matrix surface.** Neither draw surface (the
  per-channel bottom bars *nor* the aggregate curve) offers a multiply — drawing is always SET.
- **The aggregate surface is not part of that grid.** It exposes ONE scope (the whole averaged curve, per-mode
  buckets, fanned to channels), **SET-only**. Its INTENDED sign rule is "average always positive, enforced by
  a whole-mode sign flip, cells stay signed" (G2); the CURRENT code instead **floors the draw at 0** (a bug,
  H1) which zeroes the mode and discards its intra-mode sign. A user who learned "Coefficient scales my
  matrix" cannot scale the average — they must leave AVG view and use the matrix `Coefficient` op.

**Happy-path actions → expected → actual.**
- **"Scale channel 2 down 20%: Row scope + Coefficient 0.8 + click channel 2."** Expected: that channel's
  whole mode-row is multiplied by 0.8, signs kept. Actual: matches — `modesVector` × 0.8, no clamp
  (`useMatrixHistory.jsx:171-178`); one per-row POST emitted (`useSoundChannels.js:349-357`, key = that pitch).
- **"Invert a cell's polarity: Cell + Coefficient −1 + click."** Expected: sign flips, magnitude kept.
  Actual: matches — `cell * -1` (`useMatrixHistory.jsx:169-170`), no floor.
- **"Halve a selected block: drag a rectangle, Matrix scope + Coefficient 0.5."** Expected: only the block
  scales. Actual: matches — `bounds` restricts the Matrix op to the rectangle (`useMatrixHistory.jsx:118-199`).

**Branches & hazards this dimension creates (expected ≠ actual):**
- **⚠️ MULTIPLY is unclamped AND unguarded on the matrix (H6).** `Coefficient` with a **negative factor**
  silently flips polarity across the whole chosen scope; a factor of **0** zeroes every cell in scope — and
  because `0 × anything = 0`, a later multiply can never restore the sign/magnitude (it is a destructive
  SET-to-0 routed through the scale path). No confirmation, no floor, no undo prompt (undo still works — one
  step). Faithful math, but a whole-matrix `Coefficient 0` or `−1` is a big silent action.
- **⚠️ SET/MULTIPLY behave DIFFERENTLY on the two surfaces (extends H1).** The **matrix** never floors and is
  sign-capable for both ops (INTENDED — keep). The **aggregate** is SET-only; its INTENDED rule keeps the
  average positive by a **whole-mode sign flip** (cells stay signed), but the CURRENT code **floors the draw
  at 0** (H1 bug) — same data, two rule-sets, the sharpest expectation gap. The floor is a **draw-path** clamp
  (`DrawableChart` `clampMin`), *not* in the fan-out math: `scaleMembersProportional` /
  `fanOutColumnAggregateChange` are sign-preserving and unclamped (`matrixAggregate.js:44-49,116-130`), so the
  intended sign-canonicalization can be implemented there without touching per-cell values. The stale comment
  `matrixAggregate.js:98` "Each fanned cell is clamped >= 0" mis-describes even the current code (H1).
- **Optimistic-emit granularity of a scope edit (ties H3).** A scope edit is **one undo step** but **N POSTs**:
  Cell/Row → 1 per-row POST (`affectedKeysFor` returns the single pitch, `useSoundChannels.js:310-314`);
  **Column/Matrix/Selection-block → one POST for EVERY channel row** (`:316-318` returns all keys), each the
  full row, each optimistic and independently silently-failable (H3). A whole-matrix multiply = N separate
  fire-and-forget writes with no batch/confirm. Undo re-emits every row (`useSoundChannels.js:377-408`).
- **Muting is orthogonal to SET/MULTIPLY.** Mute/MuteSet write the `*_mask` KIND, not the raw value
  (`useSoundChannels.js:349-357,487-493`); a Coefficient/Value edit writes the raw row. So scaling a **muted**
  channel changes its stored coefficient but it stays muted (mask untouched) — expected, and consistent.

---

## Goal 4 — "Silence this channel / this band of modes" (mute & isolate)

**What the user wants:** to mute one or more channels, or a band of modes across channels, and to unmute.

**Preconditions / entry.** Strings mode (G1). Two mute surfaces:
- **Per-channel matrix mute** — a Mute affordance on the matrix; flows through the zone-bearing "Mute"
  change on `onMatrixValuesChange` (`SoundChannelsPane.jsx:309`; hook mask-emit `useSoundChannels.js:347-357`).
- **Aggregate tri-state mute** — the **VolumeOff** button in the averaged view; **disabled until a mode
  range/element is selected** (`SoundChannelsAggregateChart.jsx:414-430`).

**Happy-path actions → expected → actual.**
- **Aggregate: select a mode range on the ruler, click mute repeatedly.** Expected: a clear mute/solo-ish
  cycle. Actual: tri-state cycle — click 1 = mute the selection; click 2 = mute the *complement* (selection
  plays, i.e. a solo); click 3 = unmute everything; then repeats (`SoundChannelsAggregateChart.jsx:266-271`,
  hook `applyAggregateMuteCycle` `useSoundChannels.js:435-496`). The button's tooltip narrates the current
  step (`SoundChannelsAggregateChart.jsx:332-338`). Muted buckets are grey-painted. **Mute changes emit on
  the `*_mask` KIND** (`feedback_mask`), not the raw value kind (`useSoundChannels.js:351-352,487-493`).

**Branches & fallbacks (in user terms):**
- **"The mute button is greyed out."** No selection → disabled, tooltip *"Click one element or drag a range
  to mute it"* (`SoundChannelsAggregateChart.jsx:332,420`). Advisory and correct; recovery = make a selection.
- **⚠️ (HISTORICAL) "I muted and nothing went quiet."** Pre-2026-07-12, every strings-mode mute died with
  `HTTP 416` at the backend range-parser before reaching the model (RCA doc). **FIXED 2026-07-12** in
  PianoidCore (`feedback_mask` added to the output-pitch hatch). Must remain a permanent regression gate
  (see Test Strategy). This is the worst realized instance of the silent-emit-failure class (H4).

---

## Goal 4′ — "Solo — hear only this channel/mode" (emergent from mute + scope)

**What the user wants:** to isolate one channel (or one band of modes) so everything else falls silent —
the classic mixer "solo".

**Is it supported? YES — but as an EMERGENT capability, not a dedicated Solo button.** There is no `Solo`
affordance in the toolbar (the operation toggle is Navigate/Mute/Value/Coefficient — `MatrixTools.jsx:295-330`;
grep finds no solo control). Solo is reached by **applying MUTE to a scope such that only the target
plays** — i.e. mute the *complement* of a selection, or mute-all-then-unmute-the-target. Two verified paths:

**Path A — Channel/role solo, via the per-channel matrix Mute op (two toggles).** The toolbar **Mute** op
applied to a scope by clicking a cell (`MeasuredMatrix.jsx:403-419` → `handleMatrixValuesChange` builds a
zone-bearing `operation:"Mute"` change → `applyImperativeChange`). The matrix Mute is a per-scope **toggle**
(`useMatrixHistory.jsx:128-161`: if any cell in scope is unmuted → mute the whole scope, else unmute it), and
for a Mute op the mode-bound is dropped but the **channel/row bound is kept** (`MeasuredMatrix.jsx:216-227`),
so it targets whole channel rows across all modes. It emits on the **mask KIND** (`isMuteChange` true →
`emitOneStringsRowMask` → `feedback_mask`, `matrixEmit.js:41-44`, `useSoundChannels.js:346-357`).
- **Actions → expected → actual.** (1) Matrix scope + Mute + click (no channel selection) → the whole table
  toggles to muted (`useMatrixHistory.jsx:148-160`). (2) Row scope + Mute + click the target channel row →
  that row (currently all-muted) toggles back to **unmuted** (`:132-139`). Net: only that channel plays =
  **solo**. Expected: matches. Emits the target row's mask on `feedback_mask`.
- **Branch / limit (verify, cited):** the matrix selection is a **rectangular contiguous** row range
  (`MeasuredMatrix.jsx:428-435`), so "mute everyone EXCEPT channel *k*" is not a single complement gesture
  unless *k* is at an edge — the general channel-solo path is therefore **mute-all → unmute-the-target**
  (two toggles), exactly the operator-described mechanism. There is **no single "mute complement" gesture on
  the matrix surface** (that one-click complement exists only on the aggregate tri-state, Path B).

**Path B — Mode-band solo, via the aggregate tri-state "mute complement" (one gesture).** Already documented
in Goal 4: with a mode range selected, **click 2 = mute the complement → the selected modes play alone**
(`SoundChannelsAggregateChart.jsx:266-271`; `applyAggregateMuteCycle` state 2 = `MuteSet(all,false)` +
`MuteSet(complement,true)`, `useSoundChannels.js:435-496`). ★Important nuance (cited): on the strings
aggregate axis the selection is a **MODE-column span** — channel is the collapsed fan-out axis and the
selection **never names a channel** (`useSoundChannels.js:429-434`, `columnComplementBounds`
`matrixAggregate.js:174-181`). So Path B solos a **band of modes** (those modes play across all channels;
other modes muted), **not** a single channel. Emits on the `*_mask` KIND (`useSoundChannels.js:487-493`).

**Net mapping (precise, no overclaim):**
- **Solo one channel/role** → Path A (matrix Mute-over-scope: mute-all, then unmute the target row). Reachable.
- **Solo one band of modes** → Path B (aggregate tri-state complement, single click). Reachable.
- Neither is a dedicated button; both are **emergent from mute + scope**, but solo **is a real, reachable
  capability** — not a gap. Unsolo = continue the tri-state to "unmute all" (Path B) or re-toggle the muted
  scope (Path A). Both write the mask KIND, so solo is non-destructive to the raw coefficients (H4 gate applies).

---

## Goal 5 — "Undo that"

**What the user wants:** to step an edit back (or forward) and have the engine reflect it.

**Preconditions / entry.** Strings mode; any edit made. Undo/Redo buttons live on both the matrix RowEditor
toolbar and the aggregate toolbar.

**Happy-path actions → expected → actual.** Click Undo/Redo. Expected: the visible edit reverts AND the
engine follows. Actual: the hook steps history and **re-emits the whole matrix at the target step**
(`useSoundChannels.js:377-408`) — both raw rows and mask rows. Correct; today it emits every row (a noted
future optimization, not a bug).

**Branches:** at the ends of history the buttons disable (`canUndo = step>1`, `canRedo = len>step`,
`SoundChannelsAggregateChart.jsx:355-356`). No surprising branch here.

---

## Goal 6 — "Apply it / hear the result"

**What the user wants:** to commit their edits and hear them.

**Preconditions / entry.** Strings mode; edits made.

**The core expectation gap (H3).** A user coming from most editors expects an explicit **Save/Apply**, a
dirty indicator, and a chance to review before committing. **There is none.** Every edit is emitted
**imperatively, granularly, and optimistically** at the action site: the local history is mutated first,
then a per-row POST is fired to `:5000` (`useSoundChannels.js:181-201` discipline note, `329-361` emit,
`364-370` apply-then-emit). So:
- **Expected:** "I'll tweak, then Save." **Actual:** every drag is already live — there is no batch, no
  confirm, no dirty state. Hearing the result = the engine is already playing it.
- **⚠️ "My edit didn't take, and nothing told me."** If a per-row POST to `:5000` fails mid-edit, the UI has
  **already** applied the change locally; the failed emit is **not surfaced** (no toast wired on this path,
  `useSoundChannels.js:334-361`). Result: **silent divergence** — the UI shows the edit, the engine never
  got it, no retry, no error. **Recovery:** none automatic; the user only notices by ear or by reloading.
  (This class is exactly what the 2026-07-12 mute-416 bug was.)

---

## Goal 7 — "Let the system solve the balance for a mode for me" (Calibrate)

**What the user wants:** instead of hand-painting, drive the actuators + mic and let the system compute the
optimal inter-channel gains **and signs** for a mode, then persist them.

**Preconditions / entry.** This is a **separate feature** — NOT in the Sound Channels pane. It lives in the
Modal Adapter panel → Calibrate section → `CalibrationSubpanel` (`ModalAdapter.jsx:1750-1753`). It writes
the SAME strings feedback/output matrix that the SC pane edits, on `:5000`.

**Happy-path actions → expected → actual.**
1. **Pick a mode #, click Run.** Drives actuators + measures (~5s at N=4 … ~20s at N=16); a running state
   shows (`CalibrationSubpanel.jsx:113-129,217-238`).
2. **Review the solved row.** Signed, max-normalized per-channel coefficients rendered as **signed bars with
   explicit +/- values** (`CalibrationSubpanel.jsx:56-97,362-373`), plus residuals (superposition,
   phase-tie, SNR/noise-floor, observability).
3. **Confirm & write.** Explicit persist via `POST /modal/calibrate_sound_channel/confirm`
   (`CalibrationSubpanel.jsx:131-153`). **Nothing is written until the user confirms** (review-before-persist).

**Branches & fallbacks (in user terms):**
- **"Mode is at the noise floor."** Error alert; **Confirm is DISABLED** (`disabled={… || !!review.noise_level}`,
  `CalibrationSubpanel.jsx:411-417,440`) — correctly blocks an unreliable write.
- **"Degenerate / antisymmetric mode."** Confirm returns "degenerate", a warning shows, **nothing is
  persisted** (`CalibrationSubpanel.jsx:143-146,338-342`).
- **"Phase tie (cosΔθ≈0)."** Warning that gain-and-sign may be insufficient; the row is **still usable and
  Confirm is still allowed** (`CalibrationSubpanel.jsx:418-424`) — the user can persist a flagged row.
- **"Backend down during Run/Confirm."** Error alert with the server/axios message; recoverable by re-run
  (`CalibrationSubpanel.jsx:124-128,148-152`).
- **⚠️ "Batch sweep wrote a whole range without letting me review each mode."** The Batch path calibrates
  and **auto-writes every mode** in the range (noise/degenerate skipped), polling `/batch/status` every
  1200ms — **no per-mode review/confirm**, unlike the single-mode review-then-confirm
  (`CalibrationSubpanel.jsx:155-192,242-283`). A user who trusts the single-mode "nothing writes until you
  confirm" contract may not expect batch to persist autonomously.
- **⚠️ H2 — "I ran Calibrate and my open Sound Channels pane still shows the old numbers."** Calibrate's
  confirm writes via a **disjoint** axios path that does **not** bump `presetVersion`
  (`CalibrationSubpanel.jsx:139-142`). `useSoundChannels` only re-inits its local history on a
  `presetVersion` bump (`useSoundChannels.js:253-268`). So an already-open SC pane shows **stale**
  coefficients until some unrelated bump. Two editors, one matrix, **no cross-invalidation**. **Recovery:**
  reload the preset (or trigger any presetVersion bump). Silent until then.

---

## Expectation gaps / hazards (the sharpest, in user terms)

| # | Hazard — *what surprises the user* | Confirmed cause (file:line) | Severity |
|---|---|---|---|
| **H1** | **Aggregate average is kept positive by CLAMPING at 0 (bug) instead of by a whole-mode SIGN FLIP (intended).** **DECIDED semantics (operator 2026-07-16):** matrix cells may be negative (keep); the averaged view's average-across-channels for a mode is ALWAYS positive, enforced by **flipping the sign of that mode's whole channel vector** when the true average is negative — NOT by flooring individual values. This is physically free (a mode's global sign is unobservable, 07-10 calibration finding) and preserves intra-mode relative signs. **ACTUAL (wrong):** the aggregate draw floors at 0, so a negative-average intent zeroes the mode column and destroys its intra-mode sign shape. **FIX:** let the underlying cells keep their signs, compute the true average, and if negative flip the whole mode column's polarity so the shown/edited average is positive; drop the 0-clamp. | Aggregate `DRAG_CLAMP_MIN=0.0` (`SoundChannelsAggregateChart.jsx:45-46,366-374,482-488`) vs matrix no-clampMin → `DrawableChart.jsx:81` default `-Infinity`, `calcChange` never clamps (`useMatrixHistory.jsx:164-210`). Fan math is already sign-preserving/unclamped (`scaleMembersProportional` `matrixAggregate.js:44-49`) — the sign-flip belongs there. **Stale comment** `matrixAggregate.js:98` "Each fanned cell is clamped >= 0" contradicts the code. | CRITICAL (known bug, approved target) |
| **H2** | **Calibrate writes underneath an open SC pane; the pane silently shows stale numbers.** | Calibrate confirm does not bump `presetVersion` (`CalibrationSubpanel.jsx:139-142`); SC re-inits only on that bump (`useSoundChannels.js:253-268`). | MAJOR |
| **H3** | **No Save — every edit is live; a failed emit is silent.** User expects to review-then-apply; instead each drag optimistically emits, and a rejected POST diverges local from engine with no error surfaced. | Optimistic imperative emit (`useSoundChannels.js:181-201,334-370`). | MAJOR |
| **H4** | **(Historical, now a regression gate) Mute did nothing** — strings-mode mute died `HTTP 416` before the engine. | Backend range-parser; FIXED 2026-07-12 (`sound-channel-mute-logic-rca-2026-07-12.md`). | Gate |
| **H5** | **In the deferred modes regime, the placeholder has no in-pane path out.** If the user is in `listen_to_modes=1` (NOT the default — the operator's presets are strings mode) the pane shows an "unavailable in listen-to-modes" placeholder and the fix (switch to strings + APPLY) is not reachable from the pane. Strings mode — the normal shipped regime — is fully live, so this is only an edge for someone who deliberately entered the out-of-scope modes state. | `SoundChannelsPane.jsx:121-148`; regime source `PianoidTuner.js:691-695`. | MINOR (edge, out-of-scope regime) |
| **H6** | **MULTIPLY (Coefficient) is unclamped and unguarded on the matrix.** A `Coefficient` with a negative factor silently flips polarity across the whole chosen scope; a factor of 0 destructively zeroes it (unrecoverable by later multiply). Faithful arithmetic, but a big silent action with no confirm. | `useMatrixHistory.jsx:169-170,177,185-186,196-197` (no clamp on the `* newValue` branches). | MINOR (footgun) |
| **H7** | **The scope×operation grid is asymmetric across surfaces.** SET+MULTIPLY exist for every scope on the matrix; the aggregate curve is SET-only + 0-floored with NO multiply, and both draw surfaces are SET-only. A user who learned "Coefficient scales" cannot scale the average. | Aggregate emits only `operation:"Value"` (`SoundChannelsAggregateChart.jsx:233-245,312-323`); draw is hardwired Value (`MeasuredMatrix.jsx:490-500`); MULTIPLY only via the `Coefficient` toggle (`MatrixTools.jsx:322-330`). | MINOR (consistency) |

Cross-cutting structural note (substrate for H1/H2/H7): the strings SC matrix has **four write surfaces with
divergent sign/operation policies** — Calibrate (signed SET, `CalibrationSubpanel.jsx:56-97,139-142`), the
matrix **toolbar ops** (Cell/Row/Column/Matrix/rect-selection × SET *and* MULTIPLY, unclamped + sign-capable,
`useMatrixHistory.jsx:164-210`), the per-channel matrix **draw** (SET-only, sign-capable), and the aggregate
**draw** (SET-only, floored ≥0) — and **Calibrate↔SC do not reconcile** within the single
`:5000` backend. Separately, channel *mapping* lives on `:5001` while channel *coefficients* live on `:5000`
(a cross-backend split), so "editing sound channels" can touch two backends depending on the panel — but
mapping is outside the strings-mode coefficient-editing flow scoped here.

---

## Test Strategy — aligned to the user goals

Layered per PROJECT_CONFIG `#verification-surfaces`: any change to a **synthesis-output** value (a
coefficient/mute that changes the rendered waveform) is verified on the `note_playback` deterministic
offline render (`audio_off`, `POST /get_chart_test`); **mic-engaging** calibration output is `audio_on`,
BENCH-GATED. Unit/component tiers run offline (Jest/RTL, the repo convention). **Every E2E case assumes a
strings-mode fixture preset (`listen_to_modes=0`, `num_channels≥3`, `num_modes≥8`)** — without it every SC
editing goal is unreachable.

Each test names the GOAL it proves and the EXPECTED OUTCOME it pins.

### Tier 1 — Unit (pure logic, Jest, cheapest) — proves the math behind G2/G3/G4

| Proves (goal/outcome) | Test | Fixture |
|---|---|---|
| G2/G3 fan math is sign-preserving (**H1 substrate**) | `scaleMembersProportional`: mixed-sign members `[+0.8,-0.4,+0.2]`, positive target → signs preserved, avg exact; **assert a negative input is NOT zeroed** — fails if a `Math.max(0,…)` clamp ever returns (`matrixAggregate.js:44-49`) | inline arrays |
| **G2/H1 average kept positive by whole-mode SIGN FLIP (intended-behavior spec)** | The intended aggregate rule (once implemented): given a mode column whose true average-across-channels is **negative** (e.g. `[-0.6,-0.2,+0.1]`), the canonicalization **negates the whole column** → `[+0.6,+0.2,-0.1]`: average now positive, **each channel's relative sign preserved, and NO value floored to 0**. Assert the flip happens only when the average is negative, and is a no-op when already positive. **This is the H1 target; it FAILS against today's clamp-at-0 code** (drives the fix). | signed mode columns, +ve & −ve average |
| G2 zero-average edge | `|currentAvg| ≤ 1e-9` → every member set to target, target sign preserved | all-zero + signed target |
| G2/G3 fan-out preserves proportions & average | `fanOutColumnAggregateChange` / modes-axis `fanPitch`: Value vs scale ops across Cell/Matrix/pitchesVector zones | 4-channel × N-mode matrix |
| **G3′ SET vs MULTIPLY across ALL matrix zones** (**H6/H7**) | `calcChange` (`useMatrixHistory`): for zone ∈ {Cell, modesVector, pitchesVector, Matrix} — `operation:"Value"` writes `newValue`; `operation:"Coefficient"` writes `cell*newValue`. Assert **no clamp on any zone** (a negative result is NOT floored). | signed 4×N matrix |
| **G3′ MULTIPLY preserves / flips sign** (**H6 regression**) | `calcChange` Coefficient: factor `+0.8` on a negative cell keeps it negative; factor `−1` flips sign; factor `0` zeroes. **Fails if a `Math.max(0,…)` clamp is ever introduced on the multiply branch.** | cell = `−0.5`, factors {0.8, −1, 0} |
| **G3′ selection bounds gate a scope op** | `calcChange` with `change.bounds`: a Matrix/Row/Column SET or MULTIPLY writes ONLY cells inside `{pitchMin,pitchMax,modeMin,modeMax}`; Cell + *Drawn ignore bounds; a Mute op ignores the mode-bound | bounded rectangle vs full |
| G4 tri-state complement bounds | `columnComplementBounds`: low+high spans, empty-span skip, edge & middle selections | selections at edges + middle |

### Tier 2 — Component / interaction (RTL, mocked hook/emit) — proves the per-goal UI contract

| Proves (goal/outcome) | Branch | Assertion |
|---|---|---|
| **G1** editor live in strings mode (the normal regime); placeholder only in deferred modes | H5 | `listenToModes=false` (the shipped default) → matrix renders + is editable; `true` (deferred edge) → placeholder text present, NO matrix/aggregate/mute in DOM (extends `SoundChannelsPane.localChannel.test.jsx`) |
| **G1** blank empty-state doesn't crash | B-EMPTY | strings mode + null matrix → renders empty, no throw |
| **G3′ gesture → scope → op payload** | H6/H7 | with scope=Row + op=Coefficient + NumInput=0.8, a matrix-cell click calls `onMatrixValuesChange` with `{operation:"Coefficient", zone:"modesVector", pitch, newValue:0.8}`; scope=Cell + op=Value → `{operation:"Value", zone:"Cell", pitch, mode, newValue}`; selecting Coefficient defaults NumInput to 1 (`MatrixTools.jsx:110-112`) |
| **G3′ aggregate has NO multiply affordance** | H7 | render the aggregate view → assert the DrawableChart draw/Flat emit `operation:"Value"` only; there is no Coefficient control on the aggregate surface (guards against a silently-broken scale op) |
| **G3′ scope-edit emit granularity** | H3 | mock the emit; a Row/Cell edit fires ONE per-row POST (the target key); a Column/Matrix edit fires a POST for EVERY channel row (`affectedKeysFor` all-keys, `useSoundChannels.js:316-318`) |
| **G2/H1** aggregate: current-behavior vs intended-target | H1 | (a) **Characterization (today):** drag toward a negative average → emitted value floored at 0, per-cell shape lost; matrix path (draw AND Coefficient) keeps the negative. (b) **Target (expected-fail today):** the same edit should flip the whole mode column's sign so the average is positive with **per-cell relative signs preserved and no cell zeroed** — this pins the intended fix and flips to passing once H1 is fixed. |
| **G3** channel selection stays pane-local | G3 | a channel-row click calls `setSelectedChannel`, NEVER `setSelectedPitch`; a range → `setSelectedChannelRange`, never global `setSelectedPitches` (guards the spacebar/`pitch===0` bug) — keep + extend `localChannel.test.jsx` |
| **G4** tri-state mute cycle + gating | G4 | button disabled w/o selection; with selection, clicks emit MuteSet 1→2→3 with correct bounds (extends `useSoundChannels.muteCycle.test.jsx`) |
| **G4′ SOLO via aggregate complement (mask level)** | G4′/H4 | with a mode range selected, the 2nd tri-state click applies `MuteSet(all,false)+MuteSet(complement,true)` → the resulting muteMap has the **selected modes = 1 (play) and all other modes = 0 (muted)** across every channel row = the selection plays alone; emitted on `*_mask` (extends `useSoundChannels.muteCycle.test.jsx`) |
| **G4′ SOLO via matrix Mute-over-scope (channel solo)** | G4′ | mute-all (Matrix scope Mute, no selection) then Mute the target channel row (Row scope) → muteMap has the **target channel row = all 1 (play), every other row = all 0 (muted)**; both steps emit on `feedback_mask` (`isMuteChange`); assert the raw matrix is untouched (mask-only) |
| **G4/H4** mute emits on the mask KIND | H4 (FE half) | a mute emits on `feedback_mask`/`sound_channel_mask`, not the raw value kind (extends `useSoundChannels.maskEmit.test.jsx`) |
| **G7** Calibrate review/confirm guards | G7 | Run→Review renders signed bars; Confirm disabled on `noise_level`; degenerate → warning, nothing persisted (extends `CalibrationSubpanel.test.jsx`) |

### Tier 3 — E2E (running stack — the branches lower tiers can't reach)

Drive the live UI (`/test-ui`, Chrome DevTools MCP) against a running `:5000` (+ `:5001` for Calibrate).
Fixtures: (a) the **strings-mode** preset above (the normal shipped regime, the one indispensable fixture);
(b) a **deferred modes-mode** preset to assert the G1 placeholder as an edge (not the default); (c) a preset
carrying a **signed** calibration row.

| Proves (goal/outcome) | Branch | Surface / assertion |
|---|---|---|
| **G1** live in strings (normal), placeholder only in deferred modes | H5 | load strings-mode preset (the default the operator uses) → matrix renders channel rows + editable; separately load a modes-mode preset → placeholder shown; APPLY `listen_to_modes=0` → `/health` `listenMode` flips → matrix renders |
| **G3 sign round-trip** | H1 | matrix-paint a negative into a cell → `GET /get_parameter/feedback/output` shows the negative preserved; `note_playback` (`audio_off`) render before/after → waveform changes (sign must not be silently zeroed) |
| **G3′ MULTIPLY sign/scale round-trip** | H1/H6 | on a signed row, apply Row scope + Coefficient `−1` (or `0.5`) via the toolbar → `GET feedback/output` shows every coefficient in scope multiplied (sign flipped / halved), NOT floored at 0; `note_playback` (`audio_off`) before/after confirms the scaled render. Contrast the aggregate view where the same negative intent floors (documents H1/H7). |
| **G3′ whole-matrix multiply = N emits, one undo** | H3 | Matrix scope + Coefficient `0.5` + click → assert one per-channel `POST /set_parameter/feedback/<pitch>` per row (all rows), a single Undo reverts all rows |
| **G2/H1 aggregate average-positive-by-sign-flip** | H1 | edit matrix cells so a mode's average-across-channels is negative, then open AVG view. **Target (expected-FAIL today, documents H1):** the shown average is positive because the whole mode column was sign-flipped — `GET feedback/output` shows every cell at that mode negated, **per-cell relative signs preserved, no cell zeroed**; `note_playback` (`audio_off`) render is unchanged vs the pre-flip matrix (global mode-sign is inaudible). Today instead the aggregate draw floors at 0 / zeroes the column — assert that as the current bug. |
| **G4′ SOLO round-trip (mode-band)** | G4′/H4 | strings AVG view: select a mode range, 2nd tri-state click → `GET feedback_mask/output` shows the selected modes = play, all other modes = muted across channels; `note_playback` render → only the selected-mode energy survives (the selection plays alone). Continue the cycle → unmute-all restores. |
| **G4′ SOLO round-trip (channel)** | G4′ | matrix view: Mute-all then unmute the target channel row → `GET feedback_mask/output` shows the target channel row all-play, others muted; `note_playback` render → only that channel's output survives; raw `feedback/output` coefficients unchanged (mask-only, non-destructive). |
| **G4 mute regression gate** | H4 | strings-mode mute all channels → `POST /set_parameter/feedback_mask/<128..>` returns **200** (not 416); `GET feedback_mask/output` shows zeros; `note_playback` render → output attenuated to ~0. Pins the 2026-07-12 fix at the FE→BE boundary. **KEEP permanently.** |
| **G6/H3 emit-failure surfacing** | H3 | inject a `:5000` write failure mid-edit (e.g. 500) → assert current silent-divergence behaviour; becomes the gate if error-surfacing is added |
| **G7/H2 Calibrate↔SC reconciliation** | H2 | open SC pane (strings) → Run+Confirm Calibrate for a mode → assert whether the open pane reflects the new column WITHOUT reload — **expected to FAIL today** (documents H2; becomes the regression test once fixed) |
| **G1 server-down regime fallback** | B-REGIME-SOURCE | stop `:5000`; open SC pane → regime sourced from localStorage; assert the phantom-matrix risk is handled or documented |

**Priority order:** (1) Tier-1 fan-math sign-preservation **+ the new Tier-1 average-positive-by-sign-flip
(H1 target), SET-vs-MULTIPLY-across-zones and MULTIPLY-preserves-sign tests** + Tier-2 mask-kind emit —
cheapest, guard/drive H1/H6 + the 07-12 fix; (2) Tier-2 G3′ gesture→scope→op mapping + aggregate-no-multiply
(H7) + **G4′ solo (aggregate-complement + matrix mute-over-scope, mask level)** + G1 strings-live/modes-edge
+ H1 current-vs-target; (3) Tier-3 G4 mute-regression gate + **G4′ solo round-trips** + G3/G3′ sign & scale
round-trip on the offline render; (4) Tier-3 H1 average-positive-by-sign-flip + G7/H2 Calibrate↔SC
reconciliation (both expected-fail — drive their fixes). Reproduce regime states via the preset-load
`listen_to_modes` param + APPLY (the pane trusts `/health` when healthy), not by editing localStorage; use the
icon-launcher restart so server + JS bundle are fresh (PROJECT_CONFIG `#process-sweep`).

---

## Appendix A — Code reference (implementation/state map, preserved)

The panel from the component/state side, so nothing verified is lost. All file:line re-verified 2026-07-16.

**Resolved key files.**

| Role | Path |
|---|---|
| SC pane host (dispatch + regime gate) | `PianoidTunner/src/components/SoundChannelsPane.jsx` (318 LOC) |
| SC state/edit hook (sole writer) | `PianoidTunner/src/hooks/useSoundChannels.js` (558 LOC) |
| Aggregate (averaged) chart | `PianoidTunner/src/components/SoundChannelsAggregateChart.jsx` |
| Per-channel matrix editor | `MeasuredMatrix.jsx` → `RowEditor.js` → `BarChart.jsx` → `DrawableChart/DrawableChart.jsx` |
| Aggregate math (shared w/ Feed-in) | `PianoidTunner/src/utils/matrixAggregate.js` (`scaleMembersProportional` 44-49) |
| Pane mount + regime derivation | `PianoidTunner/src/PianoidTuner.js` (mount 2651-2697; `scListenToModes` 691-695; hook wiring 702-716) |
| Calibrate subpanel (writes the SAME matrix) | `PianoidTunner/src/modules/panels/CalibrationSubpanel.jsx` |
| Existing tests | `hooks/__tests__/useSoundChannels.{muteCycle,maskEmit}.test.jsx`, `components/__tests__/SoundChannelsPane.localChannel.test.jsx`, `components/__tests__/SoundChannelsAggregateChart.{rulerAlign,fanOutDecouple}.test.jsx`, `utils/__tests__/matrixAggregate.test.js`, `modules/panels/__tests__/CalibrationSubpanel.test.jsx` |

**Backend seams:** engine (main role) `:5000`; modal-adapter server `:5001` (PROJECT_CONFIG `#ports`).

**State-diagram outline (strings mode).**

```
ENTER "Sound Channels" tile (PianoidTuner.js:2651) — regime = scListenToModes (691-695)
  = /health listenMode when backend healthy, else localStorage presetLoadSettings.listen_to_modes
  │
  ├─ listenToModes=FALSE (strings — NORMAL SHIPPED REGIME, IN SCOPE)   ← the operator's presets
  │    │ guard: no matrix / empty notes → blank <div/> (150)
  │    ├─ aggregateMode OFF → MeasuredMatrix (222-317): rows=OUTPUT CHANNELS, cols=MODES.
  │    │    │  MatrixTools (showMatrixTools=true): SCOPE {Matrix,Column,Row,Cell} × OP {Navigate,Mute,
  │    │    │     Value=SET, Coefficient=MULTIPLY} + NumInput; click a cell to apply (SIGN-CAPABLE, NO clamp)
  │    │    ├─ rect drag-select → bounds → scope op restricted to the rectangle (Cell/Drawn ignore bounds)
  │    │    └─ per-channel RowEditor draw → modesVectorDrawn SET (SIGN-CAPABLE, clampMin=-Infinity)
  │    └─ aggregateMode ON  → SoundChannelsAggregateChart (152-204): drag-paint avg (SET-only; INTENDED avg
  │                            kept +ve by whole-mode SIGN-FLIP, cells stay signed — ACTUAL clamps ≥0, H1 bug),
  │                            Flat/Smooth, Undo/Redo, tri-state Mute (needs selection) → SOLO via complement, ruler select. NO MULTIPLY.
  │
  └─ listenToModes=TRUE  → placeholder (SoundChannelsPane.jsx:121-148)  [DEFERRED, OUT OF SCOPE — not the default]
```

**Sign / operation policy across the write surfaces of the SAME strings matrix (root of H1/H6/H7):**
- Calibrate → signed SET rows (`CalibrationSubpanel.jsx:56-97,139-142`).
- Matrix TOOLBAR ops (Cell/Row/Column/Matrix/rect-selection) → SET *and* MULTIPLY, unclamped, sign-capable
  (`useMatrixHistory.jsx:164-210`; no `Math.max` on any Value/Coefficient branch).
- Per-channel matrix DRAW → SET-only; negatives allowed (no clampMin → `DrawableChart.jsx:81` `-Infinity`).
- Aggregate DRAW → SET-only; NO multiply affordance (`:233-245,312-323` emit only `operation:"Value"`).
  INTENDED: average kept positive by a **whole-mode sign flip** (cells stay signed); ACTUAL: floored at 0
  (`SoundChannelsAggregateChart.jsx:45-46,482-488`) — H1 bug.
- Stale contradicting comment: `matrixAggregate.js:98` "Each fanned cell is clamped >= 0" vs de-clamped
  `scaleMembersProportional` (`matrixAggregate.js:44-49`) — the fan math never clamps (the intended sign-flip
  canonicalization belongs here).

**Emit discipline:** optimistic imperative, granular per-row POST at the action site; state changes alone
never emit (`useSoundChannels.js:181-201,334-370`). Mute changes emit on `*_mask` KINDs (351-352,487-493).
**Solo is emergent** from mute-over-scope (channel solo = matrix mute-all→unmute-target; mode-band solo =
aggregate tri-state complement) — no dedicated Solo control (G4′). Calibrate confirm is a disjoint axios path
that does not bump `presetVersion` (H2).
