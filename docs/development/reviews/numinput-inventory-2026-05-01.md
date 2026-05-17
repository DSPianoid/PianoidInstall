# NumInput Inventory & Audit — 2026-05-01

> **RESOLVED 2026-05-02 by dev-f259.** Section 5 items 1, 2, and 5 (the ObjectInspector → NumInput migration + legacy-component cleanup) shipped on PianoidTunner `feature/objectinspector-numinput-cleanup` and merged to `dev`. Actual deletion scope expanded to **6 files** (the original 3 cited here — `NumericInput.jsx`, `PropertyInput.jsx`, `PitchTools.jsx` — plus the companion `PropertyInput.css`, the dev-sandbox `NumInputTest.jsx`, and `Hammers.jsx`). The audit missed `Hammers.jsx` as a dead-but-tracked component: Section 4.4 reported PropertyInput was "only referenced by NumInputTest.jsx", but `Hammers.jsx` also imported it (and was itself orphaned, with zero external imports — `git show dev:src/components/Hammers.jsx` confirmed it predated this session). Removing Hammers transitively freed the cited PropertyInput + PitchTools deletions. Items 3 (consolidate `ExcitationProperties.jsx` + `HammerSpatialProperties.jsx`) and 4 (split `NumInput.js` to ~600 LOC) remain open. This report stays as the historical reference for the inventory itself.

Read-only audit of `<NumInput>` (PianoidTunner standard numeric editor) versus all other numerical input patterns in the frontend.

Source file under review: `PianoidTunner/src/components/NumInput/NumInput.js` (1565 LOC + ~80 LOC `.styles.js`).

---

## Section 1 — NumInput functionality review

### Public API (props)

| Prop | Default | Meaning |
|------|---------|---------|
| `value` | — | Current numeric value (controlled) |
| `onChange` | — | Callback `(newValue: number) => void`; called only on Enter / Apply / arrow / wheel — NOT during typing |
| `min` (initial) | `-Infinity` | Lower clamp; copied to internal state, editable in-place via right-click on down arrow |
| `max` (initial) | `+Infinity` | Upper clamp; right-click on up arrow to edit |
| `step` (initial) | `1` | Fallback fixed step; cursor-position step overrides unless toggled off |
| `decPlaces` (initial) | `2` | Decimal places for `toFixed()` / `toExponential()`; editable in-place |
| `size` | `"standard"` | One of `"small"` / `"standard"` / `"big"` (purely cosmetic) |
| `width` | `"120px"` | Container width when `autoWidth=false` |
| `autoWidth` | `false` | If true, recompute width from content length on every keystroke |
| `onParamsChange` | — | Notified `{min, max, decPlaces}` whenever any of the three internal state values change |
| `showExpToggle` | `true` | Show the exponent-toggle button when focused |
| `showDecPlacesButton` | `true` | Show the decimal-places button when focused |
| `autoFocus` | `false` | Mount focus only — no re-focus on prop change |

### Distinguishing behaviors vs. plain `<input type="number">`

- **Cursor-position-based step (default).** Wheel scroll, ArrowUp/ArrowDown, and ▲/▼ buttons compute `step = 10^k` from the cursor position relative to the decimal point — so e.g. caret on the tens digit steps by 10, on the hundredths digit steps by 0.01. Implemented at `NumInput.js:389-538` (`getStepFromCursorPosition`).
- **Exponential-aware stepping.** When the displayed value contains `e`/`E`, cursor in the exponent part edits the exponent itself by a power of 10, with sign-flip handling (`NumInput.js:264-325`, `795-854`).
- **Forced exponential threshold.** `formatNumber` auto-switches to exponential when `|num| >= 1e6` or `0 < |num| < 1e-6` (`NumInput.js:99`), regardless of `isExponential` prop.
- **Wheel scroll while focused.** Global `window` wheel listener gated by `isFocused` (`NumInput.js:242-386`). Calls `e.preventDefault()` AND `e.stopPropagation()` to suppress page scroll.
- **Right-click context menu hijack.** Up arrow → max-edit mode, down arrow → min-edit mode, exponent button → fixed-step mode, decPlaces button → cursor-step mode. (`NumInput.js:1148-1160`, `1254-1273`, `1410-1429`).
- **In-place mode editing.** Same StyledInput edits min/max/decPlaces/step depending on `mode` state (`value` / `min` / `max` / `decPlaces` / `step`). Cancel + Apply icon buttons appear in non-`value` modes.
- **Optimistic-edit semantics.** Typing only updates `displayValue`; `onChange` fires on Enter / Apply button / Escape (revert). Blur reverts uncommitted edits (`NumInput.js:940-964`) — explicit non-commit-on-blur to prevent cross-parameter contamination when the parent's `selectedParameter` changes.
- **Cursor-position preservation across re-renders.** `pendingCursorRef` + `useLayoutEffect` synchronously restore caret after every render (`NumInput.js:184-189`, `565-589`); a `requestAnimationFrame` fallback handles rapid changes.
- **Per-instance `instanceId`.** Logged into `data-instance-id` attribute (`NumInput.js:14-16`, `1087`). Used historically for debugging multi-instance wheel routing.
- **Unique title tooltip per mode.** Tells the user what's being edited (`NumInput.js:1229-1243`).

### Optimistic update + debounce

The component is **fully synchronous** internally — no debounce. Edits commit on Enter, Apply, arrow click, or wheel scroll. The 300 ms debounce called out in CLAUDE.md is owned by `usePreset`, not NumInput; NumInput simply emits `onChange(value)` and downstream code (`usePreset.updateParameter`) does its own debouncing. So *typing* into NumInput is uncommitted-until-Enter, and the parent's debounce coalesces rapid wheel/arrow-driven `onChange` calls.

### Known issues / TODOs / dead code

- `NumInput.js:60-62`, `176-178`, `1102-1104`: empty `useEffect`s left as placeholders ("No logs needed", "intentionally empty"). Cosmetic noise.
- ~~Dual cursor-restoration paths: `pendingCursorRef` + `useLayoutEffect` (modern, lines 184-189) co-exists with `setTimeout(..., 0)` based `preserveCursorPosition` (legacy, lines 541-562, 622-627). One should probably be removed once the modern path is verified safe.~~ **RESOLVED 2026-05-17 (dev-cursor-drift):** the legacy `setTimeout` `preserveCursorPosition` path and the `requestAnimationFrame` path added later by `d27770a` were both removed; the single `useLayoutEffect` is now the sole caret-restore mechanism. See `DIGITAL_INPUT_ANALYSIS.md` "Cursor Position Drift — RESOLVED".
- The Apply-button branch (`handleApplyClick`, lines 997-1032) builds a synthetic Enter event — works, but a shared `commitValue()` helper would dedupe the Enter handler.
- The sign-flip case for exponent step at "right after sign" returns `0` (lines 451-453, 477-479) — special-cased and not obvious.

### LOC & bloat assessment

**1565 LOC** in a single component — RED on the C4 audit's threshold. Justified breadth: the feature surface (cursor-position step, exponential mode, in-place min/max/decPlaces editing, wheel + arrow + button + keyboard input paths, cursor-position preservation across rapid programmatic re-renders) genuinely is large. Bloat candidates: ~3× near-duplicated exponent-step logic in wheel handler, ArrowUp/Down handler, ▲ button, ▼ button (lines 264-324, 795-853, 1287-1369, 1443-1525). Extracting an `applyExponentDelta(direction, cursorPos)` helper would cut ~250 LOC.

---

## Section 2 — Inventory of NumInput call sites

**Total: 19 call sites in 12 production files** (excluding `NumInputTest.jsx` — a dev sandbox, 4 sites; and the self-reference in `NumInput.js`).

### By file (production)

| File | Line | Semantic field | Notes |
|------|------|----------------|-------|
| `components/CollectPanel.jsx` | 204 | Scenario number (0-87, integer) | `showExpToggle=false`, `showDecPlacesButton=false` (integer-only) |
| `components/CollectPanel.jsx` | 258 | `sample_rate` (Hz, 8000-192000) | Same integer flags |
| `components/CollectPanel.jsx` | 275 | `num_pulses` (1-500) | Integer |
| `components/CollectPanel.jsx` | 292 | `volume` (0-1) | Float, `step=0.05`, `decPlaces=2` |
| `components/CollectPanel.jsx` | 312 | `num_measurements` (1-64) | Integer |
| `components/DrawableChart/DrawableChart.jsx` | 394 | "Flat value" — the y-value applied across all selected pitches | Bound by `flatMin/flatMax/flatStep/flatDecPlaces` from props |
| `components/GaussCell.jsx` | 116 | One Gauss-curve coefficient cell (per pitch × level) | Canonical pattern; `autoFocus={isSelected}` |
| `components/MatrixTools.jsx` | 288 | "Coefficient" input for batch matrix ops | Inline with toggle-button group |
| `components/Mode.jsx` | 235 | One mode parameter per pitch (frequency, decay, level, …) | Canonical settings-driven pattern (settings.decimalPlaces / showExpToggle) |
| `components/ParameterEditor.jsx` | 71 | Generic single-parameter editor (used by Excitation, hammer, etc.) | Canonical settings-driven |
| `components/PerceptionCurveEditor.jsx` | 365 | Selected-pitch coefficient (perception curve) | `min=0, max=50, step=0.01, decPlaces=4` |
| `components/Strings.jsx` | 133 | One string parameter per pitch (mass, mu, length, …) | Canonical, mirror of `Mode.jsx` |
| `components/TimingBandEditor.jsx` | 108 | Per-band timing field (start, duration, etc.) — table cell | `width="80px"` |
| `components/ToolBar.jsx` | 511 | The "selected parameter" toolbar editor (one of the two consoles for editing the active matrix cell) | `min=0, max=1000` (HARDCODED; no per-parameter range) |

### Dev / sandbox

| File | Line | Notes |
|------|------|-------|
| `components/NumInputTest.jsx` | 59, 76, 91, 106 | Manual demo / test harness for the four size/width permutations |
| `PianoidTuner.js` | 1400 | Renders `<NumInputTest />` as a mosaic pane (window registry) |

**Canonical prop set** (per `Mode.jsx:235`, `Strings.jsx:133`, `ParameterEditor.jsx:71`, `GaussCell.jsx:116`):

```jsx
<NumInput
  value={obj.value}
  onChange={...}
  min={obj.min} max={obj.max}
  step={obj.step || (obj.max - obj.min) / 200}
  decPlaces={settings?.decimalPlaces || 4}
  size="small" autoWidth={false} width="100%"
  showExpToggle={settings?.showExpToggle !== false}
  showDecPlacesButton={settings?.showDecPlacesButton !== false}
/>
```

`CollectPanel`, `MatrixTools`, `ToolBar` deviate (hardcoded ranges, integer-only flags, `autoWidth=true`). These are deliberate per-call-site choices — not bugs.

---

## Section 3 — Inventory of non-NumInput numerical inputs

**Total: 22 production sites across 13 files** (raw counts: 26 `type="number"` minus 3 in `ModalAdapter.jsx` that accept already-counted `<TextField type="number">` — these are the *same* components, MUI `TextField` simply emits a native `<input type="number">` underneath; I have NOT double-counted). Plus 9 `type="range"` and 4 MUI `<Slider>` — many paired.

### Pattern 3.1 — MUI `<TextField type="number">` (13 sites, 7 files)

| File | Line | Semantic field | Why not NumInput? |
|------|------|----------------|-------------------|
| `modules/ModalAdapter.jsx` | 604 | Freq Tolerance % (0-0.1) | ESPRIT modal fitter — TextField idiomatic in modal-form workflow |
| `modules/ModalAdapter.jsx` | 614 | Max Gap (0-10, integer) | Same surface |
| `modules/ModalAdapter.jsx` | 638 | Channel→Sound mapping (0-15, integer) | Bulk row-form |
| `components/CalibrationPanel.jsx` | 347 | Reference dB (manual override) | One-off form field; precision via `inputProps step:1` |
| `components/CalibrationPanel.jsx` | 444 | Manual precision (dB) | Same |
| `components/ChartSelector.jsx` | 301 | Generic chart-parameter input (custom-defined param of `type:"number"`) | Generic schema-driven; converting would force NumInput everywhere chart authors use numbers |
| `components/EspritConfig.jsx` | 173 | Per-band parameter (model_order, window_length, freq_min/max, …) | Schema-driven (`f.type` = `"number"` or `"text"`); same reason as ChartSelector |
| `components/MappingEditor.jsx` | 61 | Bridge Boundary (0-87, integer) | Setup form; wide labelled field |
| `components/MappingEditor.jsx` | 72 | Pitch Offset (0-127, integer) | Same |
| `components/ModalResultsView.jsx` | 223 | Freq Min filter | Filter row, paired with Freq Max |
| `components/ModalResultsView.jsx` | 231 | Freq Max filter | Same |
| `components/ChartSelector.jsx` (`type="text"` defaultValue) | 583 | Default value of a custom param | Coerced text — schema definition |

### Pattern 3.2 — Native `<input type="number">` paired with `<input type="range">` (slider+number combo) (8 paired sites, 3 files)

These deliberately render a slider + numeric box side by side for continuous-scrub-with-precision UX.

| File | Lines | Semantic field |
|------|-------|----------------|
| `components/ExcitationProperties.jsx` | 199-219 | `hammer_width` (0.1-13 mm) range + number |
| `components/ExcitationProperties.jsx` | 237-255 | `hammer_sharpness` (0-100 %) range + number |
| `components/ExcitationProperties.jsx` | 272-290 | `hammer_position` (0-100 %) range + number |
| `components/HammerSpatialProperties.jsx` | 162-181 | "Size, mm" (0.1-13) range + number |
| `components/HammerSpatialProperties.jsx` | 193-211 | "Sharpness, %" (1-100) range + number |
| `components/HammerSpatialProperties.jsx` | 222-242 | "Position, %" (0-100) range + number |
| `components/PropertyInput.jsx` | 44-61 | Generic property; renders ANY parameter as range+number combo. Used by `NumInputTest.jsx` (and previously elsewhere — likely legacy) |
| `components/VelocitySelector.jsx` | 41-59 | MIDI velocity (1-127) range + number |

### Pattern 3.3 — Standalone native `<input type="number">` (4 sites, 4 files)

| File | Line | Semantic field | Why not NumInput? |
|------|------|----------------|-------------------|
| `components/GaussianParameterGrid.jsx` | 261 | Per-cell coefficient in a (rowTitles × cols) grid (e.g. transfer-function matrix) | Predates NumInput; bulk grid where NumInput overhead × rows would be heavy |
| `components/PitchTools.jsx` | 19 | "Pitch:" 0-127 selector (legacy panel) | Tiny floating widget; legacy/duplicate of ToolBar pitch input |
| `components/ToolBar.jsx` | 383 | Pitch (`id="pitch"`) | Top toolbar, dense layout |
| `components/ToolBar.jsx` | 413 | Mode (`id="mode"`) | Same |
| `components/newWindowChart.jsx` | 364 | FPS for animated chart playback (1-120) | Pop-out window utility — kept light |
| `components/Excitation.jsx` | 353 | "Target dB" for `tuneNote` button | Tuning surface, paired with the Tune button |
| `components/ToolBar.jsx` | 81 | Volume sensitivity range × | Inline editor inside double-click expand-panel |
| `components/ToolBar.jsx` | 161 | Feedback sensitivity range × | Same |

### Pattern 3.4 — Standalone `<input type="range">` (1 unpaired site)

| File | Line | Semantic field |
|------|------|----------------|
| `components/newWindowChart.jsx` | 351 | Frame slider (0 to numFrames-1) for chart playback |

### Pattern 3.5 — MUI `<Slider>` (4 sites, 3 files)

| File | Line | Semantic field | Justified slider use? |
|------|------|----------------|-----------------------|
| `components/Zoomer.jsx` | 32 | Two-thumb range zoom on chart axis | Yes — range slider, NumInput cannot render this |
| `components/ToolBar.jsx` | 61 | Volume (0-127) | Continuous live-scrub — slider is the natural affordance |
| `components/ToolBar.jsx` | 141 | Feedback (0-127) | Same |
| `components/ModalResultsView.jsx` | 240 | "Min Coverage" filter (0-1) | Yes — continuous filter |

### Pattern 3.6 — Custom standalone `<NumericInput>` component (legacy, possibly dead)

| File | Line | Notes |
|------|------|-------|
| `components/NumericInput.jsx` | 1-115 | A separate, much-smaller custom numeric input (114 LOC) with double-click sci-mode toggle + right-click delta + wheel-scroll. **Has a `type="number"` editor inside.** Imported by zero production callers — `Grep` shows no `import NumericInput`. Likely an early prototype superseded by `NumInput`. |

### Pattern 3.7 — ObjectInspector "number" rendering (CRITICAL: NOT a number input)

`components/ObjectInspector.jsx:140-147` renders ALL non-select fields as `<input type="text">` (NOT `type="number"`). The numeric-vs-text discrimination happens only on commit, via the regex `/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(newValue) ? parseFloat(newValue) : newValue` (line 97). No min/max/step enforcement, no spin buttons, no wheel, no cursor-step.

**This affects every numeric field flowing through `<PaneSettingsDialog>` (which wraps `ObjectInspector`):**

| Pane that opens this dialog | Numeric fields rendered as text-input |
|------------------------------|---------------------------------------|
| **PresetPanel** init-params dialog | `volume` (0-127), `sample_rate`, `string_iterations`, `number_of_modes`, `cycle_iterations`, `audio_buffer_size`*, `array_size`*, `start_right_away`, `audio_on`, `listen_to_midi`, `use_cuda`, `use_simulation`, `debug_mode`*, `audio_driver_type`*, `listen_to_modes`*, `sound_derivative_order`* (≈12 numeric fields, of which 6 starred are MUI `<Select>` overrides — the rest are plain `<input type="text">`) |
| Modes Settings (`PaneWithSettings`) | `decimalPlaces` |
| Strings Settings | `decimalPlaces` |
| Virtual Piano Settings | `showKeyNumbers`, `showRange`, `minRange`, `fixedVelocity`, `velocity`, `playbackSpeedMs` |
| Feedin / Feedback / Sound Channels Settings | `pianoHeight`, `modesWidth` (each) |
| Excitation Settings | `stretchStep` |
| Workbench Settings | (no numeric fields currently) |

That's ~14 distinct numeric fields routed through `<input type="text">` via ObjectInspector — the largest single deviation from the project standard.

---

## Section 4 — Inconsistencies + design observations

### 4.1 Inconsistency clusters

- **Pitch input rendered three different ways.** `ToolBar.jsx:383` (native `<input type="number">`), `PitchTools.jsx:19` (native `<input type="number">`, looks like legacy duplicate), `MappingEditor.jsx:72` (`<TextField type="number">`). All three edit the same conceptual range 0-127. None use NumInput.
- **Velocity range 0-127 rendered three ways.** `ToolBar.jsx:61` MUI `<Slider>`, `VelocitySelector.jsx:41-59` `<input type="range">`+`<input type="number">` combo, `ToolBar.jsx:511` `<NumInput>` (when "selected parameter" is the value). The Volume/Feedback toolbar sliders ARE justified (live continuous scrub) — but VelocitySelector duplicates that pattern locally instead of reusing the toolbar widget.
- **Hammer width / sharpness / position rendered TWICE in two files.** `ExcitationProperties.jsx:199-289` and `HammerSpatialProperties.jsx:162-242` are nearly identical pairs of range+number for the same semantic fields. Likely a forked-and-not-deleted refactor artifact.
- **ObjectInspector text-typed numeric fields vs `<TextField type="number">` elsewhere.** Same conceptual quantity (e.g. `decimalPlaces`) is constrained-typed (`type="number"`) in some forms and free-typed (`type="text"` with regex coercion) in ObjectInspector-driven settings dialogs.

### 4.2 Pre-existing migration in flight

- No explicit "TODO: use NumInput" comments found. The convention exists in CLAUDE.md but has not been propagated to existing components.
- `NumericInput.jsx` (the unimported 114-LOC variant) is dead code that survives in the tree.

### 4.3 Justifiable exceptions

- **MUI `<Slider>` for Volume / Feedback / Zoomer / Min-Coverage.** Continuous live-scrub UX where NumInput's discrete cursor-step semantics would be the wrong affordance. Keep.
- **ECharts-adjacent inputs (newWindowChart frame slider, FPS field).** Pop-out animation utility; minimal styling acceptable. NumInput would still be a small win (cursor-step on FPS), low priority.
- **EspritConfig + ChartSelector schema-driven inputs.** Generic field renderers driven by user-defined param schemas; refactoring them needs schema-level NumInput-vs-text discrimination, more invasive.
- **ModalAdapter / CalibrationPanel modal-form fields.** One-off setup forms inside Dialogs; MUI `<TextField type="number">` is idiomatic and visually consistent with sibling string fields. Acceptable deviation.

### 4.4 Wrappers / extensions of NumInput

None found — every NumInput call site invokes `<NumInput>` directly. No wrapper components add behavior on top.

The closest things to "extensions" are:
- `ParameterEditor.jsx` — wraps NumInput with a label and a Panel/PanelResizeHandle layout. Pure layout, no behavior change. Used as a building block by Mode/Strings.
- `GaussCell.jsx` — wraps NumInput inside an `onClick` activator div. Pure framing.
- `PropertyInput.jsx` — does NOT wrap NumInput; it's the alternative range+number combo, possibly legacy.

---

## Section 5 — Suggested follow-up actions

1. **Migrate ObjectInspector numeric fields to NumInput.** Touches ~14 init-param fields (sample_rate, volume, string_iterations, number_of_modes, …) plus ~10 settings-bucket numeric fields. Single change site (`ObjectInspector.renderInput`); needs schema for min/max/step (could come from extending `PARAMETER_CONFIG`).
2. **Delete or finally adopt `NumericInput.jsx` and re-evaluate `PropertyInput.jsx`.** Both predate NumInput; `NumericInput.jsx` is dead, `PropertyInput.jsx` is only referenced by `NumInputTest.jsx`. Delete or fold into NumInput as an `?showRangeSlider` prop.
3. **Consolidate the duplicated hammer-properties forms.** `ExcitationProperties.jsx` and `HammerSpatialProperties.jsx` render the same three fields with the same range+number pattern — collapse into one component, optionally migrate the number-input half to NumInput.
4. **Split NumInput.js (RED at 1565 LOC).** Extract the four near-duplicate exponent-step blocks into a `applyExponentDelta(direction, cursorPos)` helper; move styles out (already done — `.styles.js`); consider extracting `useNumInputState` hook + `<NumInputView>` presentational. Target: ~600 LOC.
5. **Pitch / Mode toolbar inputs to NumInput.** Three locations (`ToolBar.jsx:383/413`, `PitchTools.jsx:19`) with identical 0-127 integer semantics. Easy migration; deletes `PitchTools.jsx` entirely if it's truly a legacy duplicate.

---

## Counts summary

- NumInput call sites: **19** production + 4 test sandbox = **23 total**, across **13 files** (12 production + 1 sandbox)
- Non-NumInput numerical inputs (production):
  - `<TextField type="number">`: **13** sites in 7 files
  - Native `<input type="number">` paired with `<input type="range">`: **8 paired** sites in 3 files
  - Standalone native `<input type="number">`: **8** sites in 6 files
  - Standalone `<input type="range">`: **1** site in 1 file
  - MUI `<Slider>`: **4** sites in 3 files
  - Legacy `<NumericInput>`: **1** dead component
  - ObjectInspector text-typed numeric fields: **~14 distinct fields** flowing through 1 renderer (`ObjectInspector.jsx:140-147`) consumed by **8** `<PaneSettingsDialog>` instances
- Unique files affected by non-NumInput numeric input: **17** files
