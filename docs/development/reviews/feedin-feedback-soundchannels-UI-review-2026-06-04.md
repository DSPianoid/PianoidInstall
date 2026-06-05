# UI Functionality Review: feedin / feedback / sound-channels matrix editors

- **Status:** REVIEW / read-only — for user + orchestrator. NO source edited, NO locks, NO build.
- **Agent:** ana-uimtx, 2026-06-04. /analyse (read-only).
- **Scope (user's exact request):** "I need review of the UI functionality of the feedin/feedback/sound
  channels matrices." This is the **frontend UI-behaviour** review — distinct from the backend interface
  review delivered the same day by dev-d52b
  ([review doc](feedin-feedback-soundchannels-review-2026-06-04.md)), which I read first and use as the
  data-model ground truth (F1 slider / F2 deck matrix / F3 SC strings gain; sound channels = output
  pitches 128–139; `sound_channel`/`string_sound_channel` = `[num_channels]` axis).
- **Method:** docs-first (`pianoid-tunner/OVERVIEW.md`), then source read of the live-mounted editor
  components, then **live verification** — full 3-process stack up (launcher 3001 / frontend 3000 /
  backend 5000), Belarus_8band_196modes preset loaded (88 notes, 196 modes, 4 output channels, strings
  mode), driven via chrome-devtools MCP. Every behavioural claim below is backed by a live observation
  (screenshot / network read-back / DOM measurement) or a cited source line.
- **Environment note:** on arrival the stack was unexpectedly UP (sibling dev-d52b was supposed to be
  paused-DOWN). I reported to the orchestrator, swept ports per my clearance, and ran a fresh stack.
  Stack is DOWN and ports clear at close.

## Components in scope (what actually renders)

| Editor | Pane case in `PianoidTuner.js` | Renders | Write hook |
|---|---|---|---|
| **Feedin** | `case "Feedin"` (:1726) | `MeasuredMatrix` fed by `feedinHistory` (`useMatrixHistory`) | `changeFeedInValues` → `/set_parameter/feedin/<pitch>` |
| **Feedback** | `case "Feedback"` (:1785) | `MeasuredMatrix` fed by `feedbackHistory` | `changeFeedbackValues` → `/set_parameter/feedback/<pitch>` |
| **Sound Channels** | `case "Sound Channels"` (:1882) | `SoundChannelsPane` → `MeasuredMatrix` (per-channel) or `SoundChannelsAggregateChart` (AVG) | `useSoundChannels` imperative emit → `/set_parameter/sound_channel/<pitch>` (modes axis) or `/set_parameter/feedback/<128+ch>` (strings axis) |

All three share **`MeasuredMatrix`** as the matrix surface (`PitchesModesMatrixCanvas` + `MatrixTools` +
`RowEditor`), so most findings apply to all three. `PitchesModesMatrix.jsx` (the raw `<td>`/CSS grid
version) is NOT mounted — `PitchesModesMatrixCanvas.jsx` (canvas) is the live one.

---

## TL;DR — prioritized

| # | Sev | Finding | Surface |
|---|---|---|---|
| **C1** | **Critical (UX)** | **Matrix canvas gets only ~10 % of pane width**; the axis ruler (ModesRule/VirtualPiano) gets 90 %. The primary editing surface is an unusable ~76–114 px strip on the far right. Affects ALL THREE editors. | `MeasuredMatrix.jsx:201,256` |
| **H1** | High | **SC strings-axis tooltip mislabels a CHANNEL as "Pitch"** — hover reads `Pitch: 1` for output channel 1. Axis-semantics labeling bug (the high-stakes trap). | `PitchesModesMatrixCanvas.jsx:308` |
| **H2** | High | **SC axis (modes vs strings) is NOT switchable in the SC pane** and is derived from a *frontend-only localStorage* value (`presetLoadSettings.listen_to_modes`), which can silently diverge from the backend's real `listen_mode`. | `PianoidTuner.js:481-483` |
| **H3** | High | **Feedin/Feedback editors still use the speculative-emit `useEffect`-on-`mutedMatrix` pattern** — the exact H3 anti-pattern the SC editor was refactored away from (dev-833f C2). Documented as deferred tech debt but still live. | `PianoidTuner.js:1140-1154,1179-1194` |
| **M1** | Medium | **MatrixTools toolbar is light-themed** (`#eeeeee`/`#00aaff` hardcoded hex, `matrix.png` raster icons) against the app's dark professional theme — violates the Frontend UI Standards. | `MatrixTools.jsx:194,233-238` |
| **M2** | Medium | **No keyboard / a11y on the matrix canvas** — selection & editing are mouse-only (`onMouseDown`/`onMouseMove`); the canvas has no `role`, `tabIndex`, `aria-label`, or key handlers. | `PitchesModesMatrixCanvas.jsx:270-279` |
| **M3** | Medium | **Tooltip "Value:" prints full float precision** (`Value: 248.48086494377415`) — no rounding/units; inconsistent with the dark-theme tabular-nums convention. | `PitchesModesMatrixCanvas.jsx:316` |
| **M4** | Medium | **"Change Whole Matrix / Column / Row" Value op writes a uniform scalar to every targeted cell** — destructive bulk overwrite with no confirm; combined with no-min/max input this is the silence-bug class (now mitigated server-side, but the affordance is unguarded). | `useMatrixHistory.js:121-141` |
| **L1** | Low | Resizable panel handles surface as bare ARIA `separator`s with no label; `width: "!00%"` typo in dead `PitchesModesMatrix.jsx`; `Object.values` ordering assumption couples row order to JS key-insertion order. | various |

No **data-corrupting** UI bug found in the live write paths: the dev-snmtxleak channel→pitch leak fix is
confirmed working (see V4), and SC strings/modes edits write to the correct backend endpoints (V3).

---

## Live verification log (evidence)

### V0 — Data model confirmed live (Belarus preset)
`GET` read-backs at load (frontend `evaluate_script`):
- `feedin/all`, `feedback/all`: 84 pitch keys **23–106**, each row **196 modes**. Frontend then
  display-filters to 21–108 (`usePreset.js:519-521,654-656`) — all 84 survive.
- `sound_channel/all` (modes axis): keys 23–106, rowLen **4** = `num_channels`, `_meta.mode_channel_index=196`.
- `feedback/output` (strings axis): keys **`["128","129","130","131"]`** (4 output channels), each row **196 modes**.
- `available_notes`: 23–131; over-127 = `[128,129,130,131]` = the 4 sound channels.

This matches dev-d52b's data model exactly: SC strings axis = output pitches 128+, written through the
feedback matrix (F3).

### V1 — The 90/10 layout defect (C1) — DOM-measured
Canvas bounding rects (maximized SC pane, then 4-pane layout):

| Editor | Ruler canvas width | **Matrix canvas width** | Ratio |
|---|---|---|---|
| SC (maximized) | 1717 px | **191 px** | ~10 % |
| Feedin (4-pane) | 1028 px | **114 px** | ~10 % |
| Feedback (4-pane) | 1028 px | **114 px** | ~10 % |

Screenshots: `ana-uimtx-sc-strings-maximized.png` (matrix is the thin green strip on the far right;
the vast white area is the near-empty ModesRule), `ana-uimtx-feedin-feedback-sc-readonly.png` (all three
editors side by side, each with the same narrow-matrix strip), `ana-uimtx-feedin-narrow-matrix.png`.

**Root cause (source):** `MeasuredMatrix.jsx` lays out a horizontal `PanelGroup` with
`<Panel defaultSize={90}>` on the LEFT holding the ModesRule/VirtualPiano ruler (:201) and
`<Panel defaultSize={10}>` on the RIGHT holding the matrix canvas + RowEditor (:256). The ruler — which
only needs a thin strip — gets 90 %; the heatmap the user edits gets 10 %. The panels are
user-draggable (react-resizable-panels), but the *default* is inverted and there is no auto-save of a
sane split for these panes (the `autoSaveId` is shared `"hGroupe"` across panes). This is the dominant
usability problem and is identical across all three editors.

### V2 — Heatmap encoding & axis (rendering)
`PitchesModesMatrixCanvas.getCellColor` (:30-39): positive → green `rgba(0,128,0, value/maxPositive)`,
negative → red `rgba(255,0,0, |value/minNegative|)`, zero → transparent; **muted cells render `#222`**
(:98). So color encodes *magnitude as opacity* and *sign as hue*, normalized per-matrix to the current
max/min. No legend, no numeric scale, no units shown on the canvas. For feedin (0–1 normalized) and SC
(large raw coefficients up to ~430) the same green ramp is reused with different effective scales — a
user cannot compare magnitudes across editors by color.

Default orientation `matrixRowIsPiano=true`: rows = piano pitches down the page, columns = modes; the
"Rotate matrix" button (`onRotateMatrix`) flips to rows=modes. Confirmed in source (:213-240, :104-120).

### V3 — Write paths confirmed live (strings axis)
Real UI Cell edit on the SC strings matrix (Value mode, clicked a cell): backend read-back **after** the
edit showed `feedback/output["129"][137]` changed to **430** (was 74.9). So an SC strings-axis cell edit
at on-screen row "channel 1", mode 137 wrote to backend **output pitch 129** (= 128 + channel 1) via the
feedback matrix — exactly the F3 path dev-d52b documented (`useSoundChannels.emitOneStringsRow` →
`changeSoundChannelFeedback({"129": row})` → `/set_parameter/feedback/129`,
`useSoundChannels.js:273-279`, `usePreset.js:500-503`). The optimistic-update + debounced-write pattern
holds (SC uses the imperative-emit hook; WS `set_parameter` when socket connected, else REST).

### V4 — dev-snmtxleak channel→pitch leak fix CONFIRMED working
After the same strings-axis cell click: the top-bar **"Pitch:" spinbutton stayed at 0** while **"Mode:"
updated to 137**. So the strings-axis row click routed to the pane-local `selectedChannel`
(`SoundChannelsPane.jsx:82,145`) and did NOT corrupt the global `selectedPitch` — the spacebar-stops-
working bug fix is live and effective. (Mode propagation to global `selectedMode` is by design — mode is
a genuinely shared axis.)

### V5 — Tooltip axis-mislabel (H1) confirmed live
Hovering the matrix canvas renders an absolute-positioned tooltip `Pitch: <n> / Mode: <n> / Value: <f>`
(`PitchesModesMatrixCanvas.jsx:308-316`). Live:
- **SC strings axis:** tooltip read **`Pitch: 1, Mode: 97, Value: 248.48…`** — but row 1 on the strings
  axis is **output channel 1**, NOT a piano pitch. The label "Pitch" is wrong here.
- **Feedin:** tooltip read **`Pitch: 64, Mode: 137, Value: 0.5948`** — correct (feedin rows ARE piano
  pitches; value is a 0–1 normalized feedin coefficient).

The component hard-codes the label "Pitch" regardless of axis. Correct for Feedin / Feedback / SC-modes;
wrong for SC-strings (channel) — the same axis-semantics trap CLAUDE.md flags.

### V6 — Read-only overlay (correct behaviour, noted)
On a fresh APPLY of the *original* (non-working) preset, all three editor panes show a
**"Read-only original — spawn a working copy to edit"** banner + pointer-events overlay
(`PaneWithSettings readOnly`, OVERVIEW :114). Editing only becomes possible after a working copy is the
active entry. This is correct and consistent across the three editors (screenshot
`ana-uimtx-feedin-feedback-sc-readonly.png`).

---

## Findings — detail & proposed fixes (NOT implemented)

### C1 (Critical UX) — Matrix gets 10 % of the pane
**Evidence:** V1 (DOM widths + 3 screenshots). **Files:** `MeasuredMatrix.jsx:199-365`.
**Why it matters:** the matrix is the entire point of these panes; 76–114 px is unusable for a 84×196
heatmap. A reviewer/user must manually drag the splitter every session (and the shared `autoSaveId` means
the drag may not persist per-pane).
**Proposed fix (frontend, HMR, no build):** swap the default split so the matrix Panel is the large one
(e.g. matrix `defaultSize={75}`, ruler `defaultSize={25}`), OR restructure so the ModesRule is a thin
fixed-width gutter beside a flex-grow matrix rather than a 90 % Panel. Give each editor a distinct
`autoSaveId` so per-pane splits persist independently. Verify rotate (`matrixRowIsPiano`) still lays out
correctly in both orientations.

### H1 (High) — SC strings tooltip says "Pitch" for a channel
**Evidence:** V5. **File:** `PitchesModesMatrixCanvas.jsx:308-316`.
**Proposed fix:** thread an axis/row-label prop (e.g. `rowLabel="Channel"` vs `"Pitch"`) from
`SoundChannelsPane` (it already knows `listenToModes`) down through `MeasuredMatrix` to the canvas, and
use it in the tooltip and any axis caption. On the SC strings axis show `Channel: <ch>`; on modes axis and
Feedin/Feedback keep `Pitch:`. Low-risk, display-only.

### H2 (High) — SC axis is frontend-derived and can diverge from the engine
**Evidence:** `PianoidTuner.js:481-483` derives `scListenToModes` from
`presetLoadSettings.listen_to_modes` (a localStorage bucket), not from the backend's reported
`listen_mode`. Live: localStorage `listen_to_modes=0` → SC pane showed strings axis, which happened to
match backend `listen_mode:false` — but only because they were set consistently. If a preset is APPLYed
with a different listen mode than the stored setting, or the setting is edited without re-APPLY, the SC
editor would show/edit the **wrong axis** (modes coefficients while the engine is in strings mode, or
vice-versa) with no visible indication. There is also **no in-pane control** to switch the SC axis — the
user must edit the preset-init `listen_to_modes` field and re-APPLY.
**Proposed fix:** (a) source `scListenToModes` from the backend health/`listen_mode` (single source of
truth, P1) rather than localStorage, OR reconcile the two and surface a mismatch banner; (b) consider an
in-pane axis toggle (modes/strings) with a caption stating which axis + what the rows mean, so the SC
editor is self-describing. Needs a small design decision (is axis a view toggle or an engine setting?).

### H3 (High) — Feedin/Feedback still use the speculative-emit anti-pattern
**Evidence:** `PianoidTuner.js:1140-1154` (feedin) and `:1179-1194` (feedback): a
`useEffect([feedinHistory.mutedMatrix])` POSTs the matrix whenever `mutedMatrix` changes, gated only by a
`skip*SyncRef` on the re-init render. This is the **exact H3 silence-bug pattern** that the SC editor was
refactored away from in dev-833f Phase C2 (imperative-emit-at-handler). The OVERVIEW
(`pianoid-tunner/OVERVIEW.md:249`) explicitly flags this as "deferred tech debt." Risk: a `mutedMatrix`
change that survives an APPLY (or fires on a re-init the skip-ref misses) re-emits stale state — the same
class of bug that dropped audio to ~50 % on Belarus. It also emits the **whole matrix** (or the selected
pitch) on every change rather than granular per-pitch.
**Proposed fix:** port the SC editor's three-principle pattern (presetVersion-driven re-init already
partly present at :1129/:1171; add imperative granular emit at the `MeasuredMatrix` change handler;
delete the `mutedMatrix` useEffects). Frontend-only, HMR. This is the natural follow-up to the dev-833f
SC refactor and should reuse `useSoundChannels`'s emit helpers' shape.

### M1 (Medium) — Light-themed toolbar in a dark app
**Evidence:** `MatrixTools.jsx` hardcodes `backgroundColor:"#eeeeee"`, selected `#00aaff`, AVG button
`#ff9800`/`#eeeeee` (:194,233-238,409-421); the zone icons are raster PNGs (`matrix.png`,
`matrix_row.png`, etc., :243-276). Against the MUI dark theme this is a jarring light strip and violates
the CLAUDE.md Frontend UI Standards ("MUI dark theme as base; use `theme.palette`, never hardcode hex; no
raw assets where MUI icons exist").
**Proposed fix:** drive colors from `useTheme().palette`; replace the PNG zone icons with MUI icons
(e.g. `GridOnIcon`/`ViewColumnIcon`/`TableRowsIcon`/`CropFreeIcon`). Frontend-only.

### M2 (Medium) — Matrix canvas is mouse-only (no keyboard/a11y)
**Evidence:** `PitchesModesMatrixCanvas.jsx` — the `<canvas>` has only `onMouseMove`/`onMouseDown`/
`onContextMenu`, no `tabIndex`, `role`, `aria-label`, or keyboard navigation (:270-279). Cell selection,
range-select (drag), and edit are unreachable by keyboard. Violates the CLAUDE.md accessibility baseline
("all interactive elements keyboard-navigable").
**Proposed fix:** add `role="grid"`/`aria-label`, a focusable wrapper, and arrow-key cell navigation +
Enter-to-edit. Non-trivial (canvas a11y); could be scoped as a separate task. At minimum add an
`aria-label` describing the matrix and current selection.

### M3 (Medium) — Tooltip prints raw float, no units
**Evidence:** V5 (`Value: 248.48086494377415`). **File:** `PitchesModesMatrixCanvas.jsx:316`.
**Proposed fix:** round to a sensible precision (the panel `decPlaces` setting exists) and, with the H1
fix, label the axis. Tabular-nums per dark-theme convention.

### M4 (Medium) — Unguarded destructive bulk writes
**Evidence:** `useMatrixHistory.calcChange` (:121-141): "Change Whole Matrix"/"Column"/"Row" with the
"Value" operation overwrites every targeted cell with the single scalar; the NumInput deliberately has
no min/max (dev-2706). A "Change Whole Matrix, Value=0" zeroes the entire coupling matrix in one click.
This is undoable (history) and the engine is the gate, but there is no confirm and the affordance sits one
click away from the per-cell mode. This is the affordance that produced the original SC silence reports.
**Proposed fix:** consider a confirm for Matrix/Column/Row Value ops, or a visual "you are about to
overwrite N cells" hint. Design decision — flag, not a clear bug.

### L1 (Low) — assorted
- Resizable panel handles render as bare ARIA `separator` (snapshot uids 1_84–1_87) with no accessible
  name — minor a11y.
- Dead `PitchesModesMatrix.jsx:43` has `width: "!00%"` (typo for `100%`) — harmless (component unmounted)
  but should be deleted with the dead component.
- Row order in the canvas relies on `Object.values(matrixObject)` insertion order
  (`PitchesModesMatrixCanvas.jsx:24`, `MeasuredMatrix.jsx:62`) — works because backend returns sorted
  string keys, but is an implicit coupling worth a comment or an explicit sort.

---

## Consistency across the three editors

The three are **architecturally consistent at the render layer** — all use `MeasuredMatrix` +
`PitchesModesMatrixCanvas` + `MatrixTools` + `RowEditor`, so the toolbar, heatmap, rotate, zone/operation
model, and the 90/10 layout defect (C1) are identical. They **diverge at the write layer**:
- SC uses the modern imperative-emit hook (`useSoundChannels`, granular per-pitch, presetVersion re-init).
- Feedin/Feedback use the legacy speculative-emit `useEffect`-on-`mutedMatrix` (H3).
This split is the main inconsistency and the H3 fix would unify them. The SC pane additionally has the AVG
(aggregate) mode and the strings/modes axis dispatch that Feedin/Feedback lack (correctly — those are
single-axis editors).

---

## Live re-confirmation pass (2026-06-04, second clean stack)

After the orchestrator greenlit the live phase, I brought up a fresh clean stack (launcher 3001 /
frontend 3000 / backend pid 32376 / Belarus_8band_196modes, 88 notes, strings mode) and re-confirmed the
findings with genuine UI interaction (real chrome-devtools toolbar clicks; canvas via coordinate dispatch
— the canvas is non-addressable, which is finding M2 itself):

- **C1 reproduced exactly** on the fresh stack: SC matrix canvas 76 px vs ruler 684 px; Feedin 114 px vs
  1028 px; Feedback 114 px vs 1028 px (DOM `getBoundingClientRect`). Screenshot
  `ana-uimtx-live-4pane-confirm.png`.
- **Feedin write path (F2) confirmed live:** entered Value mode via the real toolbar "Value" button,
  clicked a Feedin cell (tooltip `Pitch: 64 / Mode: 97`) → backend `feedin/all["64"][97]` changed from
  baseline ~0.87 to the written value. The write went over **WebSocket** (`set_parameter feedin`) — the
  REST request list showed NO `/set_parameter/feedin/` POST, matching `usePreset.changeFeedInValues`'
  WS-first emit with REST fallback. (Note: my programmatic NumInput fill of "0.777" did not commit through
  the synthetic Enter — the cell wrote the prior inputValue 0 — a test-harness artifact of scripted input,
  NOT a UI bug; a real user typing + Enter commits normally.)
- **H1 tooltip mislabel confirmed both axes:** SC strings hover = `Pitch: 1` (actually channel 1);
  Feedin hover = `Pitch: 64` (correct). Same hard-coded "Pitch" label across axes.
- **Feedin pane "Refresh" button** observed (manual matrix re-fetch, `feedinRefresh`) — SC and Feedback
  panes have no equivalent; minor inconsistency (folds into the cross-matrix consistency note).
- No data corruption: the working copy is ephemeral (discarded at teardown/backend restart); the one
  feedin cell I touched is not persisted to disk.

All headline findings (C1/H1/H2/H3) are now **live-verified on two independent fresh stacks**.

## Status at close
- Read-only review. No source edited, no locks held, no build run.
- Stack DOWN; ports 3000/3001/5000/5001 swept and confirmed clear.
- Additions to tree: this review doc + 4 screenshots under `docs/development/screenshots/ana-uimtx-*.png`.
- All UI bugs above are PROPOSED fixes only — implementation is a follow-up `/dev` the user approves
  separately. The headline actionable items are **C1 (layout), H1 (tooltip mislabel), H2 (axis source),
  H3 (port the SC anti-pattern fix to Feedin/Feedback)**.
