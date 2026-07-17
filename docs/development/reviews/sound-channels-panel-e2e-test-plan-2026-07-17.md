# Sound Channels Panel — Browser-Driven, Sound-Observing E2E Test PLAN (test DESIGN, READ-ONLY)

**Date:** 2026-07-17
**Author:** analyse skill (READ-ONLY: no code edits, no build, no commit — this is a test-DESIGN document for operator review BEFORE any test is implemented)
**Scope:** `listen_to_modes = 0` (**strings mode**), the normal shipped regime — same scope as the flow doc.
**Companion / authoritative flow doc (READ FIRST, not duplicated here):**
[`sound-channels-panel-flow-and-test-strategy-2026-07-16.md`](sound-channels-panel-flow-and-test-strategy-2026-07-16.md)
— goals G1–G7, G3′ scope×op grid, G4′ solo, hazards, sign semantics, and the code map.

> **⚠️ AUTHORITATIVE SIGN-SEMANTICS RULING (operator, 2026-07-17) — supersedes the flow doc's H1.**
> The earlier "keep the aggregate average positive by flipping the whole mode column's sign" decision is
> **REVERSED**. The corrected, intended semantics this plan is written to:
> - **Aggregate / averaged view: flooring the curve at 0 is CORRECT and INTENDED.** A user *cannot* draw a
>   negative average; the value floors at 0, meaning **that mode is fully attenuated / silent**. This is a
>   **PASS condition, not a bug.** There is **nothing to flip**.
> - **Negative values live ONLY in the matrix (per-channel) view**, where a negative cell is a real signed,
>   **phase-inverted** contribution. Matrix cells and matrix toolbar ops stay **unclamped and sign-capable**.
> - Consequently the flow doc's "H1 is a bug / expected-FAIL / whole-mode sign-flip fix" framing is **dropped
>   from this plan.** The aggregate 0-clamp is asserted as correct; de-clamp / sign-preservation is asserted
>   **only in the matrix view.** See the **Consistency Note (§6.1)** for how the two views interact.

---

## 0. What this plan is (and the one honesty caveat up front)

This plan expresses **every** Sound Channels user goal / sub-flow / hazard / scope×operation combination as a
**real user action performed through the browser** (Chrome DevTools MCP driving the live PianoidTunner UI —
[`UI_TESTING.md`](../../guides/UI_TESTING.md)), and pins **two** expected outcomes for each: (a) the **UI
state change** the user sees, and (b) the **effect on the SOUND**, stated with a concrete per-channel /
per-string-partial expected ratio/direction, the exact gesture/value that CONTROLS it, and measured by the
**one standard recipe (§1.5)** every sound-observing test references.

**The honesty caveat (read before trusting any "sound" assertion).** PROJECT_CONFIG
[`#verification-surfaces`](../../PROJECT_CONFIG.md#verification-surfaces) says a **synthesis-output** change
(a sound-channel gain/mute changes the offline-rendered waveform) is verified on the deterministic **offline
render** (`audio_off`), and a **mic-engaging** change (Calibrate) on the `audio_on` mic path (BENCH-GATED).
The mandate wants "the observation is what the user hears," driven through the browser and **not** by asserting
on REST parameter state. These reconcile as follows:

- **The assertion-driving actions are pure UI** — open the tile, toggle views, click scope/op toggles, type
  into NumInput, click/drag cells, drag-select rectangles, drag-paint the curve, click Flat/Smooth/mute/undo.
  No REST call drives any edit. ✅ "browser-driven, replicate the user experience."
- **The SOUND is observed by the standard recipe (§1.5): render a FIXED multi-register chord offline, before
  and after the edit, and compare energy ratios on the ratified axes — per-CHANNEL `Kernel ch{n}` energy and
  per-string-PARTIAL bands (strings-mode sound is string-partial-dominated, ratified).** This captures the
  **acoustic output** — the surface that observes the sound — **not** a coefficient read. It is the sanctioned
  `audio_off` read (UI_TESTING.md:121). Deterministic → those tests are **offline-deterministic**.
- **Mic-measured sound (Calibrate Run) is `audio_on` → BENCH-GATED** (speaker→mic loopback rig). Marked ⏱BENCH.
- **Where an effect cannot be observed through UI + rendered sound**, that is called out as an explicit
  **GAP / needs-network-outcome**, never silently swapped to a REST parameter assertion. See §6.

**Two acoustic assertion shapes — the distinction is itself the test.** Most edits MUST change a mode band's
energy (gain, mute, scale). A per-cell negative is a **phase inversion** (a sign/phase change in that band, not
necessarily an energy drop). A few edits MUST be **null-change** (undo to baseline; a whole-mode uniform sign
flip) → band ratios **≈ 1.0 within numerical noise / bit-identical**. Each test states which shape applies.

---

## 1. Preconditions / environment

### 1.1 Fixture preset (the one indispensable fixture)

| Requirement | Value | Why |
|---|---|---|
| `listen_to_modes` | **0** (strings mode) | The only regime where the SC editor is live (flow-doc G1). `1` → placeholder. |
| `num_channels` (output channels) | **≥ 3** | Matrix rows; need ≥3 for per-channel, column-fan, and solo-complement. |
| `num_modes` | **≥ 8** | Columns; need enough for range-select, zoom-window, Flat/Smooth-over-subrange. |
| A **signed** calibration row available | ≥1 mode solved to signed coefficients | G7 signed-bar review + matrix sign round-trip. |
| `listen_to_midi` | **0** | Avoid the listener-cascade silent-drop (PROJECT_CONFIG [#midi-flag](../../PROJECT_CONFIG.md#midi-flag)). |

A **second** preset with `listen_to_modes = 1` is needed ONLY for the G1 modes-placeholder edge.

### 1.2 Launch + reach the panel (browser)

Follow [`UI_TESTING.md`](../../guides/UI_TESTING.md) verbatim (React 3000, launcher 3001, Flask 5000; +5001
for Calibrate). Reproduce regime states via the **preset-load `listen_to_modes` param + APPLY** (the pane
trusts `/health` when healthy — `PianoidTuner.js:691-695`), NOT by editing localStorage. Use the
**icon-launcher restart** so server + JS bundle are fresh (PROJECT_CONFIG
[#process-sweep](../../PROJECT_CONFIG.md#process-sweep)). Reach the editor: open the **"Sound Channels"**
react-mosaic tile; gear opens SC settings (`PianoidTuner.js:2651-2697`). Default = per-channel matrix.

### 1.3 Browser-side offline-render triggers (the raw material for §1.5)

Three UI-native ways to trigger an offline `audio_off` render **from the browser page**, all confirmed in
source. §1.5 chooses among them; here is what each actually renders:

| # | Browser-native trigger | Source | Renders | Notes |
|---|---|---|---|---|
| **S-CHORD** *(the §1.5 excitation)* | Page-context `fetch('/get_chart_test', {chartType:"sound_test", mode:"offline", play_kind:"chord", pitches:"…", velocity:127})` | `chartFunctions.py:3043-3059,3919`; `chart_config.json:900-928` | a **TRUE SIMULTANEOUS CHORD** — all NOTE_ONs at `cycle_index=0`, deterministic `runOfflinePlayback` (measured: 12 fundamentals coincident) | the fixed multi-register excitation; peak-normalized WAV + raw `peak`/`peak_normalized_scale` **[CONFIRM the response fields]** |
| **S-A** | Page-context `evaluate_script` → `fetch('/get_chart_test', {chartType:'note_playback', pitch, velocity, duration_ms, display_length_ms})` | UI_TESTING.md:123-135; `newWindowChart.jsx:488`; `pianoid.py:898-903` | a **SINGLE note** (one NOTE_ON) + numeric `data[0]` samples | clean single-mode excitation; normalization of its `data`/`audio_data` **[CONFIRM]** |
| **S-C** | In-app **Play All (offline)** toolbar (`playbackMode="offline"`) — `/play_keyboard {mode:"offline"}`, plays the WAV audibly | `PianoidTuner.js:810-855`; `backendServer.py:2837-2931` | an audible **sequential sweep** of the given pitches | in-UI audible sanity variant (staggered, not a chord) |

> ✅ **Source finding (verified by a /dev investigation, measured) — a TRUE SIMULTANEOUS CHORD offline render
> already ships; no backend change needed.** The coincident-chord render is the `sound_test` chart with
> `play_kind="chord"`, `mode="offline"`: all NOTE_ONs are placed at `cycle_index=0` and rendered through
> `runOfflinePlayback` (`chartFunctions.py:3043-3059,3919`; `chart_config.json:900-928` documents *"chord = N
> simultaneous pitches, offline: deterministic runOfflinePlayback"*). Measured: a 12-note chord renders with
> all 12 fundamentals present coincidently. **This supersedes the earlier "sweep is the closest supported"
> caveat** — §1.5 excites with a true multi-register chord (S-CHORD). This is what removes the need for a
> per-mode single-note map. (The `/play_keyboard` sweep path still exists as the audible Play-All sanity, S-C,
> but is not the measurement excitation.)

### 1.4 Verified vs to-confirm selectors

Verified (read from source): toolbar toggles + NumInput (`MatrixTools.jsx:216-348`), aggregate Layers/mute
buttons (`SoundChannelsAggregateChart.jsx:401-430`), placeholder text (`SoundChannelsPane.jsx:121-148`),
matrix cell-click apply + rect-drag commit (`MeasuredMatrix.jsx:389-435`), DrawableChart clamp default
(`DrawableChart.jsx:81`). **[CONFIRM]** = described by label/role, resolve to a concrete `uid`/`aria` via
`take_snapshot` at implementation — do not invent.

| Control | How to find it (verified) |
|---|---|
| Enter aggregate (AVG) | `ToggleButton value="aggregate"` labelled **"AVG"** + Layers icon, tooltip "Enable aggregate editing" (`MatrixTools.jsx:178-207`) |
| Leave aggregate | IconButton `aria-label="Toggle averaged view"` (Layers), tooltip "Disable averaged view" (`SoundChannelsAggregateChart.jsx:401-413`) |
| SCOPE toggle group | `ToggleButtonGroup aria-label="zone selection"`; `value` ∈ `Matrix / Column / Row / Cell` (`MatrixTools.jsx:216-273`) |
| OPERATION toggle group | `ToggleButtonGroup aria-label="operation selection"`; `value` ∈ `Navigate / Mute / Value / Coefficient` (`MatrixTools.jsx:275-331`) |
| NumInput (SET target / MULTIPLY factor) | shown only when op ∉ {Navigate,Mute} (`MatrixTools.jsx:334-348`); Coefficient defaults it to **1** (`:110-112`) |
| Matrix Undo / Redo | IconButtons, tooltips "Undo" / "Redo" (`MatrixTools.jsx:159-177`) |
| Rotate | IconButton tooltip "Rotate matrix" (`MatrixTools.jsx:210-214`) |
| Aggregate tri-state mute | IconButton `aria-label="Cycle mute of selection"` (VolumeOff); disabled w/o selection (`SoundChannelsAggregateChart.jsx:414-430`) |
| Matrix cell (apply target) | `PitchesModesMatrixCanvas`; non-Navigate `onMouseDown` on a cell applies (`MeasuredMatrix.jsx:389-420`) **[CONFIRM cell hit-target]** |
| Rect drag-select | drag on the matrix canvas → `onSelectRectCommit` (`MeasuredMatrix.jsx:428-435`) **[CONFIRM coords]** |
| Per-channel row draw | click a channel row on the FlatBar axis → RowEditor bar chart → drag-paint (`MeasuredMatrix.jsx:317-329`) **[CONFIRM]** |
| Aggregate Flat / Smooth | DrawableChart toolbar (`toolbar="full"`) **[CONFIRM]** |

### 1.5 STANDARD SOUND-MEASUREMENT RECIPE — "fixed multi-register CHORD + FFT energy ratio on per-CHANNEL + per-string-PARTIAL axes"

**Every sound-observing test uses this one method.** It is DETERMINISTIC and OFFLINE (`audio_off`), so the
before-render and after-render are directly comparable. (The mic path, `audio_on`, is the exception — used
only by Calibrate G7 and always flagged ⏱BENCH.)

> ✅ **RATIFIED measurement axes (operator, authoritative) — strings-mode sound is STRING-PARTIAL-dominated,
> and that is CORRECT.** In strings mode (`listen_to_modes=0`, the whole scope of this plan) the rendered sound
> is dominated by the **string partials**, not by soundboard modes — expected, not a defect. So the two
> ratified measurement axes for every strings-mode sound test are:
> 1. **PER-CHANNEL energy** — the offline render exposes a per-channel `Kernel ch{n}` series that is **RAW /
>    un-normalized**, directly giving each output channel's energy. This is the primary axis for channel-scoped
>    edits (Row/Cell/mute/solo) and is what the validated harness ratios (below).
> 2. **Per-string-PITCH partial band energy** — center each "band" on the **string partials that actually
>    appear in the FFT for the edited column's pitch(es)**, NOT on derived soundboard-mode frequencies. (Only
>    ~10–11 of the derived soundboard-mode frequencies coincide with real FFT peaks in strings mode — expected,
>    because the string partials dominate.)
>
> **Measurement foundation is IMPLEMENTED + VALIDATED** — the harness lives under
> `PianoidCore/tests/system/sc_panel_e2e` (branch `feature/sc-panel-e2e-harness`); validated per-channel
> ratios: **channel ×0.8 → 0.640**, **mute → 0.0**, **null-change → 1.000**. The wording below reflects that
> reality; "per-mode band" throughout the tests means **per-string-partial band** on this axis.

**Step 1 — Excitation (fixed, reused before AND after).** Excite the engine with a **FIXED multi-register
CHORD (true simultaneous onset)** spanning low / mid / high registers (e.g. pitches `{36, 48, 60, 72, 84}` —
confirm the fixture's playable set) rendered offline via the shipping **`sound_test` chart with
`play_kind="chord"`, `mode="offline"`**, reachable browser-side (S-A style) via page-context
`fetch('/get_chart_test', {chartType:"sound_test", mode:"offline", play_kind:"chord", pitches:"…", velocity:127})`.
All NOTE_ONs are placed at `cycle_index=0` and rendered deterministically through `runOfflinePlayback`
(`chartFunctions.py:3043-3059,3919`; `chart_config.json:900-928` documents *"chord = N simultaneous pitches,
offline: deterministic runOfflinePlayback"*). This is a **true coincident chord** — measured: a 12-note chord
renders with all 12 fundamentals present coincidently — **not** a staggered sweep, and needs **no backend
change**. It is deterministic and offline (`audio_off`). *Rationale:* a multi-register chord lights up the
**string partials** across the register, so we do NOT need a per-mode single-note map — the chord **blankets**
the pitch space and the union of the notes' string-partial spectra covers the pitches we assert on (in strings
mode the string partials dominate the render — the ratified axis, see the box above). **Use the identical
excitation (same pitches, velocity) for the before AND after render of a given test.** Where a single pitch's
partials must be excited in isolation, use **S-A** (single note, `note_playback`) instead.

**Step 2 — Transform (measure the SUSTAIN window, not the attack onset).** Take the **sustain portion** of
each rendered chord (skip the attack transient) and compute its **FFT**: `spectrum_before`, `spectrum_after`.
- ⚠️ **Onset-timing is unreliable — use sustain-window band energy (measured note, from the /dev investigation).**
  A per-fundamental **onset-timing** metric proved untrustworthy for this preset: weak / inharmonic fundamentals
  plus attack-transient broadband leakage smear the onset. The trustworthy signal is a **whole-render,
  RMS-relative FFT band-energy comparison over the SUSTAIN window** — measure sustained band energy, not
  attack-onset timing. (This is also why the fixed-chord's simultaneous onset is fine to measure: we read the
  sustained resonances, not who started when.)
- ✅ **No de-normalization on the ratified path (harness uses RAW per-channel `Kernel ch{n}` data).** The
  per-channel `Kernel ch{n}` series the harness reads is **RAW / un-normalized**, so **no peak-normalization
  de-bias is needed** on this path. *One-line caveat:* the **WAV** path IS peak-normalized per render
  (`scale = 32767/peak`, `backendServer.py:2899-2902`, returns `peak_normalized_scale`) — so **IF** a WAV-path
  measurement is ever used instead of the kernel data, de-normalize (multiply by `peak/32767`, i.e. divide by
  `peak_normalized_scale`) before ratioing. The ratified harness does not use the WAV path.

**Step 3 — Measure (two ratified axes).**
- **(1) Per-CHANNEL energy** — read each output channel's RAW `Kernel ch{n}` series and integrate its energy →
  `E_before[ch]`, `E_after[ch]`. Primary axis for channel-scoped edits (Row/Cell/mute/solo). This is the axis
  the validated harness ratios (channel ×0.8 → 0.640, mute → 0.0, null → 1.000).
- **(2) Per-string-PITCH partial band energy** — center each "band" on the **string partials that actually
  appear in the FFT for the edited column's pitch(es)** (NOT soundboard-mode frequencies); integrate the
  sustain-window power in a narrow ± window around each real partial peak → `E_before[p]`, `E_after[p]`. Use
  this for mode-/column-scoped edits. (Expected: only ~10–11 derived soundboard-mode frequencies coincide with
  real FFT peaks — the string partials dominate, by design.)

**Step 4 — Result = the ENERGY RATIO `R = E_after / E_before`** on the relevant ratified axis (per-CHANNEL
`R[ch]` for channel-scoped edits; per-string-partial `R[p]` for mode-/column-scoped edits), compared against
the edit's EXPECTED factor with a stated tolerance. The four canonical patterns (used verbatim by the tests;
"band" = per-channel or per-string-partial per the axes above, never a soundboard-mode band):

| Edit pattern | Expected result (ratified axis) | Validated |
|---|---|---|
| **Scale a channel/pitch by k** (Row/Cell/Column/Matrix op, aggregate paint/Flat) | that channel `R[ch] ≈ k²` (energy = amplitude²; e.g. k=0.8 → `R≈0.64`, k=0.5 → `R≈0.25`, k=1.5 → `R≈2.25`) / its string-partial bands likewise; untouched channels/partials `R≈1.0 ± tol` | **channel ×0.8 → 0.640** ✅ |
| **Mute a channel / band** | the channel (or the partials it dominates) drops → `R→~0`; others `R≈1.0` | **mute → 0.0** ✅ |
| **Negative matrix cell** (phase inversion) | a **sign/phase check** in that channel's contribution (its phasor flips), **NOT** necessarily an energy drop — assert the phase sign flips vs before, not `R<1` | — |
| **True null-change** (undo→baseline; whole-mode uniform sign flip; a non-emitting toggle) | **all channels/partials `R≈1.0`**, ideally bit-identical | **null → 1.000** ✅ |

**Tolerance:** state a per-test tolerance (e.g. `R` within ±15% of the predicted factor for touched
channels/partials, `R = 1.0 ± 5%` for untouched); the validated harness numbers above show the per-channel
axis is tight. Directions/signs are firm now; per-string-partial magnitudes are within the confirmed tolerance
once the edited column's real partial peaks are pinned (§6.2).

---

## 2. Test catalogue (by goal). ⏱BENCH = mic rig required; else offline-deterministic (`audio_off`).

Format per test: **ID · story · browser actions · Expected UI change · Expected SOUND (Control gesture+value →
which mode band(s) move → expected ratio/direction, measured by the §1.5 recipe) · covers · PASS/FAIL.**

### G1 — "Let me actually edit sound channels" (enter / editor live)

**G1-01 — Strings-mode editor renders and is editable**
- *Actions:* load the strings fixture + APPLY; open the "Sound Channels" tile.
- *UI:* per-channel matrix — rows = output channels 0..N-1 drawn as **flat bars** (row tooltip "Channel",
  `SoundChannelsPane.jsx:229`), cols = modes; `MatrixTools` toolbar present.
- *Sound:* **Control:** none (render precondition). Establish the §1.5 **baseline excitation render** and assert
  it is **non-silent** (integrated band energy across the mode set well above noise floor) — this baseline is
  the "before" for later tests. **Expected:** most mode bands have `E_before[m] > 0` (the fixture sounds).
- *Covers:* G1 happy path. *PASS:* matrix + toolbar in DOM, no console error, baseline non-silent.

**G1-02 — Aggregate view toggles to the averaged curve**
- *Actions:* click **AVG** (`MatrixTools.jsx:180`).
- *UI:* matrix → single averaged curve, x=mode index, y=avg-across-channels; Layers highlighted; caption
  "Averaged per mode (drag to edit — fans across output channels)" (`SoundChannelsAggregateChart.jsx:434`).
- *Sound:* **Control:** the toggle emits nothing (view switch only) → **true null-change**. **Expected (§1.5):**
  all mode bands `R[m] ≈ 1.0` within numerical noise (ideally bit-identical) — proves the toggle is
  non-emitting. *Covers:* G2 entry. *PASS:* curve present + all `R≈1.0`.

**G1-03 — Modes-regime placeholder (edge)** ⏳edge
- *Actions:* load `listen_to_modes=1` fixture + APPLY; open the tile.
- *UI:* HeadsetOff + **"Sound Channels editor unavailable in listen-to-modes"** + "Switch the preset to
  listen-to-strings…" (`SoundChannelsPane.jsx:137-145`); no editor DOM. Then APPLY `listen_to_modes=0` →
  `/health` flips → matrix renders.
- *Sound:* n/a (no strings-output surface in modes mode). *Covers:* placeholder edge. *PASS:* placeholder text
  present, no editor DOM; recovery renders matrix.

**G1-04 — Blank empty-state does not crash**
- *Actions:* strings mode, preset with **no matrix / zero output channels**.
- *UI:* bare `<div/>`, no throw (`SoundChannelsPane.jsx:150`). *Sound:* n/a. *PASS:* renders empty, no error.

**G1-05 — Backend-down regime fallback / phantom-matrix**
- *Actions:* stop `:5000` (graceful, launcher); open/refresh the SC pane.
- *UI:* regime from localStorage `presetLoadSettings.listen_to_modes` (`PianoidTuner.js:681-695`); editor may
  render over a surface the engine is not running ("phantom matrix").
- *Sound:* **cannot be observed** — no engine → the §1.5 render cannot run. **Explicit GAP:** acoustic axis N/A;
  assert the phantom-matrix risk is surfaced/documented. *PASS:* no crash; risk state visible.

### G2 — "Overall balance brighter/quieter per mode" (aggregate curve)

**G2-01 — Drag-paint the curve up → louder average, proportions kept**
- *Actions:* AVG on; drag-paint the curve **up** at modes {a,b} to **≈1.5×** their current height.
- *UI:* buckets a,b rise; per-channel proportions preserved by the fan-out (`useSoundChannels.js:498-532` →
  `matrixAggregate.js:44-49`); one optimistic POST per affected channel row.
- *Sound:* **Control:** paint modes a,b to ~1.5× the average → **whole-mode-average scale, k≈1.5**.
  **Expected (§1.5, "scale a mode's average" pattern):** bands **a,b** `R ≈ k² ≈ 2.25` (**+3.5 dB**); all other
  bands `R ≈ 1.0 ± tol`; intra-mode channel ratio preserved (no cross-channel timbral shift within a,b).
- *Covers:* G2 happy path. *PASS:* buckets up in UI AND `R[a],R[b] ≈ 2.25`; off-target bands `R≈1.0`.

**G2-02 — Flat over a selected mode range**
- *Actions:* ruler-drag select modes [m1..m2]; click **Flat**; set flat level L.
- *UI:* selected buckets snap to L; off-selection untouched (`SoundChannelsAggregateChart.jsx:373-383`).
- *Sound:* **Control:** Flat sets each selected mode's target average to L → per-mode scale
  `k[m] = L / avg_before[m]`. **Expected (§1.5):** each band in [m1..m2] `R[m] ≈ (L/avg_before[m])²` → the
  selected bands' energies **converge toward a common level** (variance across them drops); unselected bands
  `R≈1.0`. *Covers:* G2 Flat. *PASS:* flat plateau in UI + selected-band energies converge, others `R≈1.0`.

**G2-03 — Smooth over the selection**
- *Actions:* select [m1..m2]; click **Smooth**.
- *UI:* jagged curve smoothed within the selection only.
- *Sound:* **Control:** Smooth low-passes the selected averages (each mode's k moves toward its neighbours').
  **Expected (§1.5):** across [m1..m2] the **band-to-band energy variance decreases** (each `R[m]` nudges its
  band toward the local mean); no global level target so the selected bands' summed energy `≈` unchanged;
  unselected bands `R≈1.0`. *Covers:* G2 Smooth. *PASS:* curve smoothed + reduced inter-band variance.

**G2-04 — Zoom to a mode range, then paint (off-screen modes untouched)**
- *Actions:* zoom the mode axis to window [w1..w2]; drag-paint inside it.
- *UI:* only visible buckets change; on zoom-out, off-window modes at prior values
  (`SoundChannelsAggregateChart.jsx:74-90,212-224`).
- *Sound:* **Control:** paint only within [w1..w2]; re-expansion writes only those cells. **Expected (§1.5):**
  bands in [w1..w2] move by the painted k² ; **off-window bands `R≈1.0`** (untouched). *Covers:* G2 zoom.
  *PASS:* off-window bands `R≈1.0` in the render; in-window bands move.

**G2-05 — Aggregate draw floors at 0 = mode fully attenuated (CORRECT behavior, normal PASS)** ✅not-a-bug
- *Story:* In the averaged view I drag a mode's average down; it **cannot** go below 0 — at 0 that mode is
  silent. This is the intended clamp.
- *Actions:* AVG on; drag-paint (or Flat=0 over a 1-mode selection) mode m's bucket **down to/through 0**.
- *UI:* the bucket **floors at 0** — you cannot draw a negative average (`DRAG_CLAMP_MIN=0.0`,
  `SoundChannelsAggregateChart.jsx:45,366,482`; axis `yMin=0`). **Correct**, not a bug; no sign-flip, no
  negative bar in this view.
- *Sound:* **Control:** drag mode m's bucket to 0 → `targetAvg=0` → fan factor `= 0/oldAvg = 0` →
  `scaleMembersProportional` zeroes every channel's cell at mode m (`matrixAggregate.js:44-49,116-130`) →
  **"mute a band" pattern**. **Expected (§1.5):** band **m** `R → ~0` (noise floor — fully attenuated/silent);
  all other bands `R≈1.0`. *Covers:* aggregate-floor-is-correct (replaces the retired H1-bug framing).
  *PASS:* bucket floors at 0 AND `R[m] → ~0`. **A normal passing test.**
- *Note (coexistence — §6.1):* drawing mode m to 0 zeroes that mode's per-cell values **including any negative
  signs** set in the matrix (factor 0 → mode m silent) — the intended "fully attenuated" outcome. Unpainted
  modes keep their matrix cells/signs.

### G3 — "Fix just one channel" (per-channel matrix)

**G3-01 — Paint one channel's per-mode bars; negatives paintable (matrix is the signed surface)**
- *Actions:* click channel k's row (opens its RowEditor); drag-paint its bars, including **below zero**.
- *UI:* only channel k's row changes; negatives render as **signed bars** (matrix path passes no `clampMin` →
  `DrawableChart.jsx:81` default `-Infinity`); one POST per edited row.
- *Sound:* **Control:** the drawn per-mode vector becomes channel k's coefficients; a bar to +x scales k's
  amplitude at that mode, a bar to −x **phase-inverts** k at that mode. **Expected (§1.5):** at the painted
  modes, the bands **channel k dominates** move by the drawn ratio² (energy pattern); at any mode where k was
  drawn **negative**, a **phase check** shows k's contribution flips sign (the summed band's phasor shifts).
  Other channels' bands `R≈1.0`. **Confirm** the render granularity (§6.2) to attribute per-channel.
- *Covers:* G3, matrix-is-the-negative-surface. *PASS:* single-row UI change + band moves at painted modes;
  negatives produce a phase flip, not a silent zero.

**G3-02 — Matrix negative-cell SET = real phase-inverted contribution (audible, signed)**
- *Actions:* Cell + Value + NumInput = **−0.5** + click cell (channel k, mode m).
- *UI:* that cell goes to −0.5 (signed bar); no floor (`useMatrixHistory.jsx:166-168`).
- *Sound:* **Control:** SET (channel k, mode m) = −0.5. **Expected (§1.5, "negative matrix cell" pattern):** in
  band **m**, channel k's contribution is **phase-inverted** at magnitude 0.5 — assert a **sign/phase flip** in
  band m vs before (cross-correlation sign or the band phasor rotates ~180° for k's part), **not** merely
  `R<1`; the summed band m energy changes by a mix-dependent amount (may rise or fall). This is the matrix-only
  sign capability the aggregate view cannot express. *Covers:* matrix signed capability. *PASS:* band m shows a
  phase inversion consistent with a k-cell sign flip; cell stays −0.5.

**G3-03 — Channel selection stays pane-local (spacebar guard)**
- *Actions:* click channel k's row; press **Space** to play.
- *UI/behaviour:* click routes to `setSelectedChannel`, never global `setSelectedPitch`
  (`SoundChannelsPane.jsx:277`); Space still plays (no `pitch===0` swallow).
- *Sound:* **Control:** Space after a channel-row click. **Expected:** a note **plays** — the play path is NOT
  broken. **Measure:** assert the play call fires / a note sounds (S-B/S-C audible, or the play-note
  network/console event) — no §1.5 band diff needed. *Covers:* the "spacebar stops after SC click" bug.
  *PASS:* play works after a channel-row click.

**G3-04 — Channel sub-range scopes an edit**
- *Actions:* drag-select channel **row** range [k1..k2] on the FlatBar axis; apply Row/Matrix op, value v.
- *UI:* op scopes to selected channels only (`selectedChannelRange` pane-local; bound derived
  `MeasuredMatrix.jsx:215-240`); unselected channels untouched.
- *Sound:* **Control:** the bound restricts the write to rows k1..k2. **Expected (§1.5):** bands dominated by
  channels **k1..k2** move per the op; bands dominated by out-of-range channels `R≈1.0`. (Attribution needs the
  render granularity, §6.2 — else assert the **net** change magnitude matches k1..k2-only.) *Covers:* G3
  scoping. *PASS:* only k1..k2's bands move.

### G3′ — scope × operation grid (Cell/Row/Column/Selection/Matrix × SET/MULTIPLY) + draw + aggregate

Matrix ops: pick SCOPE + OP + NumInput, then **click a cell** (`MeasuredMatrix.jsx:397-419`); the clicked cell
supplies pitch/mode. Strings axis `matrixRowIsPiano=false` → **Row→`modesVector`** (one channel across modes),
**Column→`pitchesVector`** (one mode across channels) (`MeasuredMatrix.jsx:405-412`). No clamp on any
Value/Coefficient branch (`useMatrixHistory.jsx:164-210`).

**G3′-01 — Cell × SET (Value)**
- *Actions:* Cell + Value + NumInput = v + click a cell (k, m).
- *UI:* that one cell = v (`useMatrixHistory.jsx:166-168`).
- *Sound:* **Control:** SET (k,m)=v. **Expected (§1.5):** in band m, channel k's contribution amplitude → |v|
  (from the prior cell value) → the band-m energy moves by a mix-dependent, directional amount (up if
  |v|>|prev|, down if smaller, **phase-flipped** if v<0); other bands `R≈1.0`. *PASS:* one cell in UI; band m
  moves in the expected direction (sign/phase if v<0).

**G3′-02 — Cell × MULTIPLY (Coefficient): ×0.8, ×−1, ×0 (footgun)**
- *Actions:* Cell + Coefficient; factors **0.8**, **−1**, **0**.
- *UI:* `cell × factor` (`useMatrixHistory.jsx:169-170`), no floor. ×0 zeroes with **no confirm/guard**.
- *Sound:* **Control:** scale cell (k,m). **Expected (§1.5):** **×0.8** → channel k's amplitude at mode m ×0.8
  → its contribution's energy ×0.64 (band-m net change mix-dependent, directional **down**); **×−1** →
  **phase-inversion** of k at m (sign/phase-flip check, |k's energy| unchanged); **×0** → k contributes
  **nothing** at m → if k dominates band m, `R[m]→~0`, else a partial mix-dependent drop. *Covers:* G3′
  Cell/MULTIPLY, **footgun (H6)**. *PASS:* 0.8 energy-down, −1 phase-flip, 0 removes k's contribution AND ×0 is
  unguarded (assert the missing confirm).

**G3′-03 — Row × SET** — Row + Value + v + click channel k → `modesVector` k = v across all modes (`:171-178`).
*Sound:* **Control:** set channel k flat to v across all modes. **Expected (§1.5):** every band k dominates
moves toward the |v|-implied energy (k's spectral shape flattened); bands k doesn't dominate `R≈1.0`.
**Measure:** §1.5 recipe over the mode set.

**G3′-04 — Row × MULTIPLY (0.8)** — "scale channel 2 down 20%": `modesVector × 0.8`, signs kept; one per-row
POST (`useSoundChannels.js:349-357`). *Sound:* **Control:** Row + Coefficient 0.8 + click channel k.
**Expected (§1.5, "mute/scale a channel" pattern):** the bands **channel k dominates** drop to `R ≈ 0.64`
(0.8² energy) — a uniform ~−20% amplitude across k's modes; signs preserved; other channels' bands `R≈1.0`.
*Covers:* G3′ Row. *PASS:* k-dominated bands `R≈0.64`, others `R≈1.0`.

**G3′-05 — Column × SET** — Column + Value + v + click mode m → `pitchesVector` m = v across all channels
(`:179-187`). *Sound:* **Control:** set mode m to v for every channel → **whole-mode set**. **Expected (§1.5):**
band **m** `R ≈ (v / avg_before[m])²`; other bands `R≈1.0`. **Measure:** §1.5 on band m.

**G3′-06 — Column × MULTIPLY** — `pitchesVector × factor` (`:185-186`). *Sound:* **Control:** Column +
Coefficient f + click mode m → **whole-mode scale**. **Expected (§1.5):** **f=0.5** → band **m** `R ≈ 0.25`
(**−6 dB**), others `R≈1.0`; **f=−1** → **whole-mode uniform sign flip = true null-change** → **all bands
`R≈1.0` / bit-identical** (a uniform mode-wide polarity flip is unobservable, 07-10 calibration finding).
*Covers:* G3′ Column; note the f=−1 null-change lives here in the matrix path. *PASS:* f=0.5 → `R[m]≈0.25`;
f=−1 → all `R≈1.0` bit-identical.

**G3′-07 — Whole-matrix × SET** — Matrix + Value + v + click → every cell = v (`:188-199`). *Sound:* **Control:**
flatten the entire matrix to v. **Expected (§1.5):** every band moves toward the v-implied energy (overall
spectral shape flattened toward v). **Measure:** §1.5 across all bands.

**G3′-08 — Whole-matrix × MULTIPLY (0.5): N emits, one undo**
- *Actions:* Matrix + Coefficient 0.5 + click.
- *UI:* every cell ×0.5; **N optimistic POSTs** (one per channel row, `affectedKeysFor` all keys); **single
  Undo reverts all** (`useSoundChannels.js:377-408`).
- *Sound:* **Control:** scale the whole matrix by 0.5. **Expected (§1.5):** **every** band `R ≈ 0.25`
  (0.5² energy, **−6 dB** uniformly) → overall RMS ~×0.5. Also observe **N POSTs** (DevTools network) and a
  **one-step Undo** restoring all bands to `R≈1.0`. *Covers:* G3′ Matrix, **H3 granularity**. *PASS:* all
  bands `R≈0.25`, N POSTs, one-step undo → `R≈1.0`.

**G3′-09 — Selection block × SET / G3′-10 × MULTIPLY (rectangular)**
- *Actions:* **drag a rectangle** on the canvas (`onSelectRectCommit`, `MeasuredMatrix.jsx:428-435`); then
  Matrix/Row/Column op with value/factor → `bounds` attach; only the rectangle changes
  (`useMatrixHistory.jsx:118-199`).
- *UI:* only cells in `{pitchMin,pitchMax,modeMin,modeMax}` change. **Cell + *Drawn ignore bounds**; a **Mute**
  op drops the mode-bound (`MeasuredMatrix.jsx:216-227`).
- *Sound:* **Control:** the bounded op writes only the block's channels×modes. **Expected (§1.5):** **SET** →
  the block's modes move to the v level for the block's channels; **MULTIPLY 0.5** → the block's modes' bands
  `R ≈ 0.25` **only where the block's channels dominate**; **off-block modes `R≈1.0`**. *Covers:* G3′ Selection
  (SET+MULTIPLY). *PASS:* off-rectangle bands `R≈1.0`; in-block bands move as predicted.

**G3′-11 — Per-channel DRAW is SET-only (no multiply)**
- *Actions:* in channel k's RowEditor, drag-paint.
- *UI:* draw hardwired `operation:"Value"` (`MeasuredMatrix.jsx:490-500`); no draw-MULTIPLY; negatives
  paintable.
- *Sound:* **Control:** the drawn vector SETs channel k's per-mode coefficients (never a multiply). **Expected
  (§1.5):** channel k's bands follow the drawn shape (as G3-01). **Also:** assert the emitted op is `Value`
  (payload) — no Coefficient path on draw. *Covers:* draw-asymmetry (H7). *PASS:* Value-only emit; k's bands
  match the drawn shape.

**G3′-12 — Aggregate has NO multiply affordance (H7)**
- *Actions:* AVG on; inspect toolbar; drag / Flat.
- *UI:* only Flat/Smooth/mute/undo/redo; **no Coefficient control**; draw/Flat emit `operation:"Value"` only
  (`SoundChannelsAggregateChart.jsx:233-245,312-323`).
- *Sound:* **Control:** aggregate can only SET (fanned), never scale. **Expected:** a SET produces the G2-01
  band pattern; assert **no multiply is silently applied**. **Measure:** DOM (no Coefficient toggle) +
  emitted-payload (`Value` only) — no §1.5 diff required beyond confirming a SET behaves as SET. *Covers:*
  **H7**. *PASS:* no scale control; only Value emits.

**G3′-13 — Destructive-multiply footgun (whole-matrix ×0 / ×−1) (H6)**
- *Actions:* Matrix + Coefficient **0** (then attempt a later ×2), and separately **×−1**.
- *UI:* ×0 zeroes every cell, no confirm; a later multiply **cannot restore** (0×anything=0); ×−1 flips all
  polarity silently; Undo (one step) is the only recovery.
- *Sound:* **Control:** Matrix Coefficient 0 (or −1). **Expected (§1.5):** **×0** → **all bands `R→~0`**
  (silence); a subsequent **×2** leaves **all bands still `R≈0`** (proves 0 is destructive); **×−1** →
  whole-matrix **uniform polarity flip = true null-change → all bands `R≈1.0` / bit-identical** (globally
  inaudible). So ×−1 is the *safe* footgun, ×0 the *destructive* one. *Covers:* **H6**. *PASS:* ×0 →`R≈0` and
  ×2 keeps `R≈0`; ×−1 → all `R≈1.0` bit-identical; missing guard documented.

### G4 — "Silence this channel / band of modes" (mute)

**G4-01 — Aggregate tri-state: click 1 = mute selection**
- *Actions:* AVG on; ruler-select modes [m1..m2]; click mute **once**.
- *UI:* selected buckets **grey-painted**; button warning-highlighted; tooltip "Selection muted — click to
  mute the rest instead" (`SoundChannelsAggregateChart.jsx:266-271,332-338`). Emits on **`*_mask` KIND**
  (`feedback_mask`), not the raw value.
- *Sound:* **Control:** mute-set modes [m1..m2] across all channels → **"mute a band" pattern**. **Expected
  (§1.5):** bands **m1..m2** `R → ~0` (silent); other bands `R≈1.0`; raw coefficients untouched (mask-only).
  *Covers:* G4. *PASS:* grey buckets + `R[m1..m2] → ~0`, others `R≈1.0`.

**G4-02 — Per-channel matrix mute op**
- *Actions:* OP=Mute; click channel k's row (Row scope).
- *UI:* channel k's row toggles muted/greyed (`useMatrixHistory.jsx:128-161`); mask KIND emit; **raw
  coefficients untouched**.
- *Sound:* **Control:** mute channel k. **Expected (§1.5, "mute a channel" pattern):** the bands **channel k
  dominates** drop `R→~0`; other bands `R≈1.0`; unmuting restores exactly (raw preserved) → `R≈1.0` vs the
  pre-mute baseline. *Covers:* G4 matrix mute. *PASS:* k-dominated bands → ~0, reversible, raw matrix intact.

**G4-03 — Mute button disabled without a selection**
- *Actions:* AVG on, no selection.
- *UI:* mute button **disabled**; tooltip "Click one element or drag a range to mute it"
  (`SoundChannelsAggregateChart.jsx:332,420`). *Sound:* n/a (no action possible). *PASS:* disabled + tooltip.

**G4-04 — Mute-416 regression GATE — KEEP PERMANENTLY**
- *Story:* muting a strings channel must actually go quiet (pre-2026-07-12 it died HTTP 416 before the engine).
- *Actions:* mute all channels via the UI (matrix Mute-all, or aggregate mute of the full mode range).
- *UI:* channels greyed/muted; **network: the `feedback_mask` write returns 200, NOT 416** (observe the UI's
  own request outcome in DevTools).
- *Sound:* **Control:** mute-all. **Expected (§1.5):** **every** band `R → ~0` (render → ~silence). Also assert
  **200 on the mask write** (not 416). *Covers:* **H4 gate**. *PASS:* 200 + all bands `R→~0`. *FAIL:* any 416,
  or any band with `R≈1.0` after mute-all.

### G4′ — Solo (emergent from mute + scope)

**G4′-01 — Mode-band solo via aggregate complement (one gesture)**
- *Actions:* AVG on; select modes [m1..m2]; click mute **twice** (state 2 = mute complement).
- *UI:* the **complement** greys out; selected modes play; tooltip "Rest muted — click to unmute everything"
  (`applyAggregateMuteCycle` state 2 = `MuteSet(all,false)+MuteSet(complement,true)`,
  `useSoundChannels.js:435-496`). Emits on `*_mask`.
- *Sound:* **Control:** mute every mode except m1..m2. **Expected (§1.5):** bands **m1..m2** `R≈1.0` (they play);
  **all other bands `R→~0`** (muted). *Covers:* G4′ mode-band solo. *PASS:* selected bands `R≈1.0`, rest `→~0`;
  raw coefficients unchanged (non-destructive).

**G4′-02 — Channel solo via matrix mute-all → unmute target (two toggles)**
- *Actions:* Matrix scope + Mute + click (mute-all → whole table muted); then Row scope + Mute + click channel
  k's row (toggles it back to unmuted, `useMatrixHistory.jsx:132-160`).
- *UI:* all rows grey except channel k; both steps emit on `feedback_mask` (`isMuteChange`).
- *Sound:* **Control:** mute-all, then unmute channel k. **Expected (§1.5):** only the bands **channel k
  contributes to** survive (`R` reflecting k-only); bands dominated solely by other channels `R→~0`. Then a
  full unmute → **all bands `R≈1.0`** vs baseline (proves non-destructive). Raw `feedback/output` coefficients
  unchanged (mask-only). *Covers:* G4′ channel solo. *PASS:* only channel k audible; full-unmute restores
  baseline; raw matrix intact.
- *Note:* no single-click "mute complement" on the matrix (rect selection is contiguous) → channel-solo is the
  two-toggle path by design (flow-doc G4′ Path A).

**G4′-03 — Unsolo restores full mix**
- *Actions:* continue the aggregate tri-state to state 3 (unmute all), or re-toggle the muted matrix scope.
- *UI:* all buckets/rows return to normal color.
- *Sound:* **Control:** unmute all. **Expected (§1.5, null-change vs pre-solo):** **all bands `R≈1.0`** — the
  full-mix render returns to the pre-solo baseline. *Covers:* G4′ recovery. *PASS:* all bands `R≈1.0`.

### G5 — "Undo that"

**G5-01 — Undo reverts the visible edit AND the engine follows**
- *Actions:* make an edit (any G2/G3/G3′); click **Undo**.
- *UI:* the edit reverts; the hook re-emits the whole matrix at the target step
  (`useSoundChannels.js:377-408`).
- *Sound:* **Control:** Undo re-emits the prior matrix → **true null-change vs baseline**. **Expected (§1.5),
  three-point:** render **baseline**, **after-edit**, **after-undo**; assert **after-undo bands `R≈1.0` vs
  baseline** (bit-identical / within noise) AND **after-edit ≠ baseline** (the edit's bands moved). *Covers:*
  G5. *PASS:* both UI and all bands revert to baseline.

**G5-02 — Redo re-applies** — after G5-01 click **Redo**. *Sound:* **Expected (§1.5):** after-redo bands
`R≈1.0` vs the **after-edit** render (the edit's bands re-move). *PASS:* both re-apply.

**G5-03 — Buttons disable at history ends** — at step 1 Undo disabled; at head Redo disabled
(`canUndo=step>1`, `canRedo=len>step`, `SoundChannelsAggregateChart.jsx:355-356`; matrix
`MatrixTools.jsx:163,172`). *Sound:* n/a. *PASS:* correct disabled states.

### G6 — "Apply it / hear the result"

**G6-01 — No Save; every edit is live**
- *Actions:* make an edit; do NOT look for a Save button.
- *UI:* no Save/dirty/apply — the edit is emitted at the action site (`useSoundChannels.js:181-201,334-370`).
- *Sound:* **Control:** any single edit gesture, then run §1.5 **immediately** (no intervening Save). **Expected:**
  the touched bands have **already** moved (`R≠1.0` at the edited modes) with no commit step. *Covers:* G6/H3
  model. *PASS:* bands moved without any Save.

**G6-02 — Silent emit-failure surfacing (H3)** — GAP-bearing, expected-FAIL-today
- *Actions:* inject a `:5000` write failure mid-edit (force a 500 on the per-row POST); make an edit.
- *UI:* the UI **still shows the edit** (optimistic); **no toast/error** surfaced
  (`useSoundChannels.js:334-361`).
- *Sound:* **Control:** the same edit gesture, but the POST is rejected. **Expected (§1.5):** the render is
  **unchanged** (engine never got it) → **all bands `R≈1.0` despite the UI showing the edit** → UI vs render
  **DIVERGE** (the acoustic surface reveals the silent failure). **GAP:** "engine rejected" vs "accepted but
  render-config wrong" needs the **network POST status** (DevTools) — flagged, not a REST parameter assertion.
  *Covers:* **H3**. *PASS (characterization):* UI-changed + all bands `R≈1.0` + no error surfaced. Becomes the
  gate if error-surfacing is added.

### G7 — "Let the system solve the balance" (Calibrate) — separate panel (:5001 + :5000)

Calibrate lives in Modal Adapter → Calibrate → `CalibrationSubpanel` (`ModalAdapter.jsx:1750-1753`), writing
the SAME strings matrix. Its measurement is **mic-engaging** → `audio_on` → **⏱BENCH-GATED** (the §1.5 offline
recipe does NOT apply to the mic solve; §1.5 CAN be used post-confirm to verify the written column changed the
render).

**G7-01 ⏱BENCH — Run → signed-bar review** — pick a mode, click **Run**; running state shows
(`CalibrationSubpanel.jsx:113-129`); review renders **signed bars with +/- values** + residuals (`:56-97,
362-373`). *Sound:* **Control:** Run drives actuators + mic. **Acoustic (audio_on, bench):** the mic-measured
per-channel gains/signs ARE the observation. *PASS:* signed bars + residuals render for a real solve.

**G7-02 ⏱BENCH — Confirm disabled at the noise floor** — noise-floor mode → error alert, **Confirm disabled**
(`:411-417,440`). *Sound:* n/a (write blocked). *PASS:* Confirm disabled, nothing persists.

**G7-03 ⏱BENCH — Degenerate mode → nothing persisted** — Confirm returns "degenerate", warning, no write
(`:143-146,338-342`). *PASS:* no persist, warning shown.

**G7-04 ⏱BENCH — Phase-tie → Confirm still allowed** — warning that gain+sign may be insufficient, but Confirm
allowed (`:418-424`). *Sound:* on Confirm the row IS written → verify via §1.5 offline render **after** confirm
that the solved mode's band moved. *PASS:* warning + Confirm enabled + persist + band moved post-confirm.

**G7-05 ⏱BENCH — Batch sweep auto-writes without per-mode review** — Batch calibrates and **auto-writes every
mode** in range (noise/degenerate skipped), polling `/batch/status` (`:155-192,242-283`). *Sound:* **Expected
(§1.5 post-batch):** the swept modes' bands moved vs pre-batch. *PASS:* batch persists autonomously (documents
the contract diff).

**G7-06 ⏱BENCH — Calibrate writes underneath an open SC pane (stale, H2)** — expected-FAIL-today
- *Actions:* open the SC pane (strings); in Calibrate, Run+Confirm a mode; look at the open SC pane **without
  reloading**.
- *UI:* the SC pane still shows the **old** column — Calibrate's confirm uses a disjoint axios path that does
  **not** bump `presetVersion` (`CalibrationSubpanel.jsx:139-142`); `useSoundChannels` re-inits only on a
  `presetVersion` bump (`useSoundChannels.js:253-268`).
- *Sound:* **Control:** Calibrate confirm writes the new column. **Expected (§1.5):** the offline render **DOES
  change** at the solved mode's band (engine got the new column) while the **SC pane UI does not** — the
  render-vs-UI mismatch is the H2 signature. *Covers:* **H2 (MAJOR)**. *PASS (characterization):* pane stale +
  band moved. Becomes the regression test once cross-invalidation is added.

---

## 3. Coverage matrix (auditable completeness)

### 3.1 Goals / sub-flows → tests

| Goal / sub-flow | Tests |
|---|---|
| G1 enter / editor live | G1-01, G1-02, G1-03(edge), G1-04, G1-05 |
| G2 aggregate curve | G2-01, G2-02, G2-03, G2-04, G2-05(floor=correct) |
| G3 per-channel | G3-01, G3-02, G3-03, G3-04 |
| G3′ Cell×{SET,MUL} | G3′-01, G3′-02 |
| G3′ Row×{SET,MUL} | G3′-03, G3′-04 |
| G3′ Column×{SET,MUL} | G3′-05, G3′-06 (incl. f=−1 null-change) |
| G3′ Matrix×{SET,MUL} | G3′-07, G3′-08, G3′-13 |
| G3′ Selection-block×{SET,MUL} | G3′-09, G3′-10 |
| G3′ per-channel draw (SET-only) | G3′-11 |
| G3′ aggregate (SET-only, no MUL) | G3′-12 |
| G4 mute | G4-01, G4-02, G4-03, G4-04(gate) |
| G4′ solo | G4′-01 (mode-band), G4′-02 (channel), G4′-03 (unsolo) |
| G5 undo/redo | G5-01, G5-02, G5-03 |
| G6 apply/hear | G6-01, G6-02(H3) |
| G7 Calibrate | G7-01..G7-06 (all ⏱BENCH) |

### 3.2 Hazards → tests

| Hazard | Tests | Note |
|---|---|---|
| H2 Calibrate↔SC stale | G7-06 | expected-FAIL |
| H3 no-Save / silent emit-failure | G6-01, G6-02, G3′-08 | G6-02 expected-FAIL |
| H4 mute-416 gate | G4-04 | KEEP permanently |
| H6 destructive multiply | G3′-02 (×0/×−1), G3′-13 | footgun characterization |
| H7 scope×op asymmetry | G3′-11, G3′-12 | |
| ~~H1 aggregate sign-flip~~ | **REMOVED** | Reversed by the 2026-07-17 ruling: the aggregate **floor at 0 is correct** and is now asserted as a normal PASS (G2-05). No sign-flip target anywhere; negatives live only in the matrix (G3-01/-02, G3′). |

### 3.3 scope × operation grid → tests

| Scope \ Op | SET (Value) | MULTIPLY (Coefficient) |
|---|---|---|
| Cell | G3′-01 | G3′-02 |
| Row (one channel) | G3′-03 | G3′-04 |
| Column (one mode) | G3′-05 | G3′-06 (f=−1 null-change) |
| Selection (rect block) | G3′-09 | G3′-10 |
| Whole matrix | G3′-07 | G3′-08 / G3′-13 |
| Per-channel draw | G3′-11 | **N/A — none exists** (asserted absent) |
| Aggregate curve | G2-01/02/03/05 (fanned, floored ≥0 = correct) | **N/A — none exists** (asserted absent, G3′-12) |

All 10 matrix combos covered. The two "N/A" cells are **not gaps** — MULTIPLY does not exist on either draw
surface; G3′-11/-12 assert that absence. The aggregate cells are **SET-only and floor at 0 (correct)**.

### 3.4 Combos NOT browser-observable (flagged)

| Item | Why | Handling |
|---|---|---|
| G1-05 backend-down render | no engine → no §1.5 render | UI-only; acoustic axis N/A |
| G6-02 rejected-vs-accepted | UI optimistic; only network outcome disambiguates | DevTools POST status + band divergence; flagged GAP |
| Per-channel attribution | **RESOLVED** — the offline render exposes a RAW per-channel `Kernel ch{n}` series, so channel energy is directly observable (validated: ×0.8→0.640, mute→0.0, null→1.000) | measure on the per-channel axis (§1.5 Step 3.1); per-string-partial band placement still pinned per edited column at impl (§6.2) |
| G7 acoustic solve | mic-engaging (`audio_on`) | ⏱BENCH-GATED |

---

## 4. Offline-deterministic vs bench-gated

| Class | Count | Tests |
|---|---|---|
| **Offline-deterministic** (§1.5 recipe, or UI-only) | **39** | all G1, G2, G3, G3′, G4, G4′, G5, G6 |
| **BENCH-GATED** (`audio_on` mic rig) | **6** | G7-01 … G7-06 |
| **Total** | **45** | |

---

## 5. Priority / sequencing

1. **Guardrails first:** G4-04 (mute-416 gate — KEEP), G3-02 + G3′-01..-10 sign/scale round-trips (matrix must
   stay signed & unclamped), **G2-05 (aggregate floor=0 = silent, now a normal passing guard)**, G6-01.
2. **Core goals:** G1-01/02, G2-01..-04, G3-01/03/04, G4-01/02/03, G4′-01/02/03, G5-01/02/03.
3. **Expected-FAIL drivers (unfixed bugs — pin, flip green when fixed):** G6-02 (H3), G7-06 (H2). *(The
   former H1 driver is retired — the aggregate floor is correct, not a bug.)*
4. **Footgun characterization:** G3′-02 (×0), G3′-13 (destructive ×0 vs safe ×−1).
5. **Edges:** G1-03, G1-04, G1-05.
6. **Bench-gated last:** G7-01..G7-06.

Reproduce regime states via the preset-load `listen_to_modes` param + APPLY; icon-launcher restart for fresh
server + bundle (PROJECT_CONFIG [#process-sweep](../../PROJECT_CONFIG.md#process-sweep)).

---

## 6. Explicit gaps, design decisions, and the aggregate↔matrix consistency finding

### 6.1 Consistency finding — does flooring the aggregate at 0 destroy matrix negatives? (verified against source)

**Verified in `matrixAggregate.js` (44-49, 99-169) + the aggregate draw clamp
(`SoundChannelsAggregateChart.jsx:45,366,482`). Three precise behaviours:**

1. **The two views COEXIST by default.** The aggregate view is a *derived* display: `computeColumnAggregate`
   (`matrixAggregate.js:53-66`) shows the **true average across channels** per mode (it does NOT clamp the
   computed display — `yMin:0` is only a render-axis floor). Merely opening the aggregate view, or the
   draw-clamp existing, does **NOT** touch matrix cells. **Per-cell negative signs set in the matrix persist
   untouched** and simply collapse into the displayed average. The floor is a **draw-path input clamp**
   (`DrawableChart clampMin=0.0`) — it constrains what the user can *draw*, not the stored cells.

2. **BUT actively drawing a mode's aggregate to 0 DOES zero that mode's cells — including negatives — and that
   is the intended "fully attenuated" outcome.** When the user paints (or Flat-sets) mode m's aggregate to 0,
   the emit carries `targetAvg=0`; the fan-out computes `factor = targetAvg / oldAvg = 0`, and
   `scaleMembersProportional` returns **all-zero** members at mode m (`matrixAggregate.js:44-49,116-130`). So
   every channel's cell at mode m — **including any previously-set negative signs** — becomes 0, i.e. mode m
   goes **silent**. This is exactly what the corrected ruling requires ("floors at 0 → that mode fully
   attenuated"). It is **not a bug**; it is the intended semantics. Only modes the user actually draws to 0
   are affected; unpainted modes keep their matrix signs.

3. **Non-zero aggregate draws are proportional and preserve intra-mode ratios** (`factor = targetAvg/oldAvg`,
   applied to every member) — magnitudes rescale, relative proportions preserved. **Sign-preservation caveat
   (precise, not overclaimed):** because the aggregate target is floored ≥ 0, if a mode's *current* average
   `oldAvg` is **negative** (possible only if matrix edits made that mode net-negative), then
   `factor = (≥0)/(<0)` is **negative**, and the fan **flips every channel's sign at that mode** while
   rescaling — a whole-mode *uniform* sign flip (physically the inaudible case; it also keeps the displayed
   average non-negative). This is an **emergent arithmetic consequence**, NOT an explicitly-specified rule —
   **flag it for operator confirmation** rather than assert it as intended or as a bug. Test it as a §1.5
   null-change characterization on the aggregate path (all bands `R≈1.0`; analogue of G3′-06's matrix f=−1).

**Net:** the aggregate 0-clamp and the matrix signed cells **coexist cleanly for display**; the only place the
aggregate touches matrix signs is when the user **deliberately draws a mode to (or through) 0**, which zeroes
that mode by design (silent) — consistent with the corrected ruling. Stale-comment note:
`matrixAggregate.js:98` "Each fanned cell is clamped >= 0" **mis-describes the mechanism** (the fan math does
NOT clamp; the ≥0 constraint is on the *drawn input average*, and the all-zero result at target 0 comes from
`factor=0`, not a per-cell clamp) — worth a comment fix, but the **net behaviour is correct**.

### 6.2 Other gaps / decisions for operator ratification

1. **Sound observation = the §1.5 standard recipe, on the RATIFIED axes** (fixed multi-register chord offline
   excitation + FFT energy ratio on **per-CHANNEL** `Kernel ch{n}` energy and **per-string-PARTIAL** bands) —
   the sanctioned `audio_off` surface, observing the acoustic output, never a REST parameter assertion.
   **RATIFIED** (operator, authoritative): strings-mode sound is string-partial-dominated and that is correct;
   measure per-channel + per-string-partial, NOT per-soundboard-mode. **Foundation implemented + validated** —
   `PianoidCore/tests/system/sc_panel_e2e` (branch `feature/sc-panel-e2e-harness`); channel ×0.8→0.640,
   mute→0.0, null→1.000.
2. **A TRUE SIMULTANEOUS CHORD offline render ships — no backend change (verified /dev, measured; supersedes
   the earlier sweep caveat).** The `sound_test` chart with `play_kind="chord"`, `mode="offline"` places all
   NOTE_ONs at `cycle_index=0` and renders via `runOfflinePlayback` (`chartFunctions.py:3043-3059,3919`;
   `chart_config.json:900-928`); measured with 12 coincident fundamentals. §1.5 excites with this fixed
   multi-register chord — which **resolves the earlier "which single note hits which mode" gap** (the chord
   blankets the modes, no per-mode note map needed). The prior "chord would need a backend change" note was
   **wrong** and is removed.
3. **Measurement caveats — mostly RESOLVED on the ratified path; the rest pinned at impl:** (a) **peak-
   normalization does NOT apply** to the ratified path — the harness reads the **RAW per-channel `Kernel ch{n}`**
   data, no de-normalization needed; it applies ONLY if a **WAV-path** measurement is ever used
   (`scale=32767/peak`, `backendServer.py:2899-2902` → divide by `peak_normalized_scale`). (b) **Per-channel
   attribution is RESOLVED** — the `Kernel ch{n}` series gives each channel's energy directly (validated
   ×0.8→0.640, mute→0.0, null→1.000); what remains is placing each **string-partial band** on the edited
   column's *real* FFT peaks (not soundboard-mode frequencies), pinned per column at implementation. (c)
   **per-fundamental ONSET-timing is unreliable** for this preset (weak/inharmonic fundamentals + attack-
   transient broadband leakage) — measure **sustain-window** RMS-relative band energy, not onset timing (§1.5
   step 2). Directions/signs firm now; per-string-partial magnitudes within tolerance once the column's peaks
   are pinned.
4. **Two genuine non-acoustic points** (G1-05 backend-down, G6-02 rejected-vs-accepted) rely on the UI's own
   **network outcome** (DevTools request status), not a backend parameter read — closest browser-side surface.
5. **`[CONFIRM]` selectors** (matrix cell hit-target, rect-drag coords, RowEditor draw, Flat/Smooth) resolve
   to concrete uids via `take_snapshot` at implementation — not invented here.
6. **Expected-FAIL tests are now only G6-02 (H3) and G7-06 (H2)** — genuine unfixed bugs. **The former H1
   expected-FAIL is removed:** the aggregate floor at 0 is correct behaviour and G2-05 is a normal passing
   test.

---

*Cross-reference, do not duplicate:* goal/hazard semantics + code map in
[`sound-channels-panel-flow-and-test-strategy-2026-07-16.md`](sound-channels-panel-flow-and-test-strategy-2026-07-16.md)
(note: its **H1 framing is superseded** by the 2026-07-17 ruling — the aggregate floor is correct, not a bug);
launch/observe in [`UI_TESTING.md`](../../guides/UI_TESTING.md); verification-surface routing in
[`PROJECT_CONFIG.md#verification-surfaces`](../../PROJECT_CONFIG.md#verification-surfaces).
