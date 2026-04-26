# Work in Progress

## Active Dev Sessions

| Agent | Task | Log | Started |
|-------|------|-----|---------|
| dev-vol-sens-default | volume_sensitivity default=10, reset on preset load, no persist | [log](logs/dev-vol-sens-default-2026-04-26-140508.md) | 2026-04-26 |

---

## Cycle Profiling Harness

**Location:** `PianoidCore/tests/system/cycle_profile.py`
**Config:** `PianoidCore/tests/system/configs/cycle_baseline.json`

Measures per-stage cycle timing under configurable iter / mode (idle vs playing) / preset / driver. Captures Stage A (synthesis kernel + device sync), Stage B (regime output: D2H + driver push), and full cycle via `initTimeRecord`/`getTimeRecord` + `getCallbackStats`. Output: JSON with median / p95 / p99 / max per stage plus underrun rate.

Invoke:

    cd PianoidCore
    .venv/Scripts/python tests/system/cycle_profile.py \
        --config tests/system/configs/cycle_baseline.json \
        --output /tmp/cycle.json

Flags: `--iter`, `--mode {idle|playing}`, `--preset`, `--driver`, `--buffer`, `--duration` (override config); `--matrix` (run 2×2 iter×mode); `--downsample-6to5` (opt-in adapter for pre-fac66cb binaries with NUM_BASE_LEVELS=5).

**Findings (2026-04-22):**
- IversPond_128modes iter=8 idle SDL3: Stage A median ~780 μs across ee068dd (Mar 31) through HEAD — no kernel regression post-Volume-Calibration.
- 2×2 matrix reveals mode-count-dependent active-cycle cost: Belarus_196modes shows +444 μs per active cycle vs idle; IversPond_128modes does not.

**Note (2026-04-24):** The 780 μs / +444 μs figures above were captured against PianoidCore post-`5137240` binary AND PianoidBasic post-`83ac75d` `Mode.py`. The `83ac75d` commit (`PianoidBasic/Pianoid/Mode.py` 3-tuple `pack_modes`) was missing from `origin/dev` until 2026-04-24 — clean rebuilds during that window failed with `mode_state.size() = 1120 > 768` because pre-`83ac75d` `Mode.py` emitted 5-tuple SoA. If you cannot reproduce these timing numbers, verify `git -C PianoidBasic cat-file -t 83ac75d` succeeds locally (and that `Pianoid 0.1.13` is reinstalled into `PianoidCore/.venv/` after pulling).

### Test Environment

Cycle profiling timings are sensitive to hardware (GPU model/clock, CPU IPC, memory speed) and software stack state (CUDA toolkit, driver, MSVC, OS build). Every future profiling run **must** record the host environment so cross-machine comparisons are meaningful.

**Required fields for every profiling report:**

| Field | Capture command (Windows) |
|---|---|
| CPU model, cores, threads, base clock | `Get-CimInstance Win32_Processor \| Select Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed` |
| RAM total + speed | `Get-CimInstance Win32_PhysicalMemory \| Select Manufacturer, Capacity, Speed, PartNumber` |
| GPU model, VRAM, driver, compute cap | `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv` |
| NVIDIA driver / CUDA runtime | `nvidia-smi` (header line: `Driver Version: X.Y` / `CUDA Version: A.B`) |
| CUDA toolkit (build-time) | `nvcc --version` |
| OS + build | `Get-CimInstance Win32_OperatingSystem \| Select Caption, Version, BuildNumber` |
| MSVC version | `ls "C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/"` |
| Python version | `<venv>/Scripts/python --version` |
| Disk where venv lives | `Get-Partition -DriveLetter X \| Get-Disk \| Select FriendlyName, BusType, MediaType` |
| Date of measurement | ISO 8601 date |

**Baseline entries:**

| Field | 2026-04-25 baseline (this host) | Apr 22 reference system |
|---|---|---|
| CPU | Intel Core i7-9700F @ 3.0 GHz, 8 cores / 8 threads (no SMT) | not recorded |
| RAM | 32 GB DDR4-2400 (2 × 16 GB Kingston KF3600C16D4/16GX, running 2400 MT/s) | not recorded |
| GPU | NVIDIA GeForce RTX 4070 SUPER, 12 GB GDDR6X | not recorded |
| GPU compute capability | 8.9 (Ada Lovelace) | inferred ∈ {8.0, 8.6, 8.9} (per `build_config.json` `cuda_arch_list`) |
| NVIDIA driver | 560.94 | not recorded |
| CUDA runtime (driver-side) | 12.6 | not recorded |
| CUDA toolkit (build-side) | 12.6.20 (`nvcc` built 2024-06-14) | likely 12.x (`build_config.json` structure) |
| OS | Microsoft Windows 10 Pro 64-bit, build 19045 | Windows (inferred from log usage of `taskkill`, `cmd //c`, `.bat`) |
| MSVC | VS2022 BuildTools, VC Tools 14.44.35207 | not recorded |
| Python | 3.12.0 | 3.12 (inferred from venv layout) |
| Venv disk | tigo SSD 120G (SATA SSD) | not recorded |
| Other disks | Crucial CT240BX500SSD1 (SATA), FIKWOT FN501 Pro 256GB (NVMe) | n/a |
| Measurement date | 2026-04-25 | 2026-04-22 |

**Note:** The Apr 22 reference system's hardware specs are not recorded in any archived agent log (searched `dev-ab-d2h`, `dev-volume-iter-fix`, `dev-perftest`, `dev-f5-stream`, `dev-paramsync`). Future profiling sessions should capture the full required-fields table before reporting timing data, so that absolute numbers (not just relative deltas) become comparable across machines. Without hardware data, a 30–35 % Stage A median delta between two systems cannot be classified as code regression vs hardware difference.

Consolidates prior ad-hoc probes formerly kept under `D:/tmp/test_cycle_*`.

---

## Known Follow-Ups

- **`play_note_offline_chart_function` — missing `get_string_indices`.** The chart function calls `pianoid.get_string_indices(pitch)` (chartFunctions.py ~line 1529), which does not exist on `Pianoid`. The surrounding try/except swallows the `AttributeError` and leaves `string_oscillation_data = (0, 0)`. Effect: String Osc Max/RMS always display 0 in the note_playback chart. Found during dev-63c2 fix; left out of scope by orchestrator. Likely replacement: `pianoid.sm.get_string_indices(pitch)` or a similar StringMap API — needs a brief code audit before fix.

- **Secondary iter-dependence in spectrum/HF/decay** (2026-04-23, post-volume-iter fix). Peak magnitude is iter-invariant after `dev-volume-iter-fix` (coeff_force dt² fix + preset rescale). However HF content increases ~25dB from iter=4 to iter=12, spectral centroid doubles (1340 → 2687 Hz), init/sust decay rates vary. Likely root cause: `coeff_frequency_decay` (Kernels.cu:139) needs iter compensation. Out of scope for the volume-bug fix. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Secondary issue".

- **pip install returns stale pianoidCuda.pyd** (2026-04-23 discovery). `pip install --force-reinstall --no-cache-dir pianoid_cuda/` silently produces cached pyd despite fresh .obj compilation. Workaround: always use `./build_pianoid_cuda.bat --heavy --release` (does full clean + pip cache purge). Structural fix would identify the caching layer in setup.py / pip build isolation. See [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) §"Build pipeline discovery".

### Calibration bisection-path audit (deferred)

The factor-space clamp fix (dev-cal-clamp-fix, 2026-04-26) addresses the direct-correction paths in `synthesis_tuner.py` (`_synthesis_correct_once`) and `acoustic_tuner.py` (`acoustic_tune`). The bisection paths in `calibration_controller.py` (`_direct_correct_to_target` at ~line 1060, plus probe-update sites at ~723, ~1160, ~1186) ALSO clamp probe values in absolute-mean space [0.001, 50]. Likely break for any preset with realistic large coefficients. Audit and fix in a future task.

### Calibration REST observability gaps (deferred)

End-to-end verification of calibration writes via REST is blocked by two pre-existing bugs (discovered during dev-cal-clamp-fix verification, 2026-04-26):

- `/get_parameter/gauss_full/{pitch}` reads from cached `excitation.curves` GaussCurve objects via `to_dict()`; `_apply_single_correction` and `_set_amplitude_scale` mutate `levels_matrix` directly. UI reads stale values post-calibration.
- `/pause_synthesis` transitions state machine to PAUSED but C++ main loop continues spinning. `/synthesis_measure` then fails with "Cannot render offline: Main loop is active".

Either bug should be addressed before live UI verification of calibration is reliable.

---

## WebSocket Migration — Hybrid REST + Socket.IO

**Status:** Complete. Merged and pushed (2026-04-11). All 4 phases shipped.

Flask-SocketIO backend + socket.io-client frontend. Note playback via WebSocket with REST fallback, lifecycle push events (replace health polling), calibration progress push, MIDI playback push, engine error push, **parameter updates via WebSocket** (all 8 debounced write paths: string, mode, excitation, feedin, feedback, sound channel, volume, deck feedback). Debounce reduced from 300ms to 50ms when WS connected. `param_ack` events returned to client. Independent fixes: print() gated behind PIANOID_DEBUG_PLAY env var, deduplication added to unified play path, `_map_feedback_to_coefficient()` helper extracted.

Tests: 30/30 pass (20 unit in `test_websocket.py`, 10 integration in `test_websocket_integration.py`).

See [WEBSOCKET_MIGRATION_ANALYSIS.md](WEBSOCKET_MIGRATION_ANALYSIS.md) for full analysis and implementation details.

---

## Preset System Revision — Per-Preset Runtime State & Complete Switch

**Status:** Planned. Implementation pending.

Volume and feedback are global runtime parameters that persist across preset switches — switching from a loud preset A to quiet B and back loses A's volume/feedback settings. Additionally, available notes are not refreshed after switch (stale keyboard), the frontend MIDI feedback slider position is lost (lossy reverse mapping from coefficient), and rapid `[`/`]` key presses can interleave switch requests.

The fix adds a `runtime` dict to each `_library_models[name]` entry (backend-authoritative), saves/restores `RuntimeParameters` during `switch_preset()`, enriches the `/preset/switch` response with volume/feedback/sensitivity values, and updates the frontend to consume these values and refresh available notes.

**Sound-channel cache silence on preset switch — resolved (2026-04-20, Wave B).** Independent of the planned runtime-state work, preset transitions could silence Strings mode because in-flight debounced `changeSoundChannelValues` / `changeSoundChannelFeedback` writes from the outgoing preset resolved after the refetch and merged stale pitch keys back via `setSoundChannelData(prev => ...)`. Fixed by clearing `soundChannelData` + `soundChannelFeedbackMatrix` to `null` at the top of `loadPreset()` and `switchPreset()` in `usePreset.js`, before the async refetch.

**Sound Channels strings-axis tooltip null + bulk-edit no-op — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing bug surfaced after Wave D manual testing. In strings axis, the matrix from `/get_parameter/feedback/output` uses backend output-pitch keys (`"128".."128+N-1"`) while `availableOutputChanels` exposes the shifted `[0..N-1]`. All downstream consumers (canvas hover lookup, `useMatrixHistory.calcChange`, Workbench) indexed by the shifted frontend channel, producing undefined lookups → tooltip rendered `Value: null`, and the pitch-key guard in `calcChange` silently no-op'd Cell/modesVector/modesVectorDrawn edits. Row and column bulk edits in strings axis never reached the backend. Fixed in `useSoundChannels.js` by normalizing strings-axis keys on init (strip 128) and denormalizing on emit (restore 128), so the canvas/history/workbench stay axis-agnostic while the network payload preserves the backend convention. Verified end-to-end: tooltip now shows real values, row/col bulk edit mutates the matrix, modes axis unchanged.

**useMatrixHistory undo crash on rapid edits — resolved (2026-04-21, dev-sc-tooltip-rowcol).** Pre-existing P1-violation latent since the hook was written. `recordChange` used a stale closure for `currentStep` when slicing the history array — in a burst of clicks within one React batch, every call saw the same captured `currentStep`, so `setHistory(prev => [...prev.slice(0, currentStep), change])` produced only one entry (last-write-wins), while `setCurrentStep(prev => prev + 1)` correctly advanced per-call via its functional updater. `currentStep > history.length` left holes; `restoreMatrixAtStep(step-1)` walked past the end → `entry.operation` on undefined → crash. Surfaced only after the strings-axis fix enabled edits that previously no-op'd silently. Fixed by adding `stepRef = useRef(0)` as the synchronous slice-boundary source of truth — read and bumped inside `recordChange` before the setState calls, so per-call boundaries are correct even without rerender. `init`, `restoreMatrixAtStep`, `undo`, `redo` all synchronized via the ref. Defensive clamp in `restoreMatrixAtStep` (`Math.min(step, history.length)` + skip undefined entries) so a future desync cannot crash. Verified: 5-click burst now produces step=len=6 (was step=6/len=2 before), undo/redo cycle through all steps without error, truncation-after-undo works. Applies to all matrix-history consumers (strings/modes SC, feedin, feedback, strings params, modes params, excitation).

See [PRESET_SYSTEM_REVISION_PLAN.md](PRESET_SYSTEM_REVISION_PLAN.md) for full analysis, architecture decision, implementation steps, data flow, edge cases, and verification checklist.

**Files to modify:**
- `PianoidCore/pianoid_middleware/pianoid.py` — `switch_preset()`, `load_preset_to_library()`, `init_pianoid()`, new helpers
- `PianoidCore/pianoid_middleware/backendServer.py` — `/preset/switch` response, `/set_runtime_parameters` sync
- `PianoidTunner/src/hooks/usePreset.js` — `switchPreset()` consume runtime state, add `getAvailableNotes()`, concurrency guard

---

## NumInput Bidirectional Data Flow — Cursor Drift on Rapid Stepping

**Status:** Partially fixed. Core bidirectional issues resolved; cursor drift during rapid arrow/wheel remains.

Seven issues were fixed in `NumInput.js`, `PropertyInput.jsx`, and `usePreset.js` to stabilize the digital input components when connected to the live backend. The remaining open issue is cursor position drift during rapid arrow key or scroll wheel stepping — caused by React's controlled input pattern resetting the cursor on each render cycle.

See [DIGITAL_INPUT_ANALYSIS.md](DIGITAL_INPUT_ANALYSIS.md) for full root cause analysis, fixes applied, and potential solutions for the cursor drift.

**Branch:** `feature/fix-bidirectional-input` in PianoidTunner

---

## C++ Logging Migration

**Status:** Session 1 complete. Remaining files pending.

Replaced all `printf`/`cout`/`cerr` in hot-path and core C++ files with `PianoidLogger` file-based logging. Three hot-path statements fixed (cycle-level `std::cout` in `Pianoid.cu`, per-callback `printf` in `SDL3AudioDriver.cpp`, warmup `cout` in `CycleTimeEstimator.cu`).

See [LOGGING.md](../modules/pianoid-cuda/LOGGING.md) for full details and migration status.

| Scope | Status |
|-------|--------|
| PianoidLogger infrastructure | Done |
| Hot-path fixes (3 locations) | Done |
| Core C++ files (~175 statements in 8 files) | Done |
| pybind11 bindings + Python lifecycle | Done |
| Remaining C++ files (~75 statements) | Pending |
| Python print migration (578 statements) | Planned |
| `backendServer.py:475` hot-path `print` → `logger.debug` | Done (dev-bprint, 2026-04-20) |
| `backendServer.py` other request-handler prints (~80 calls across `/set_parameter`, volume, feedback, play, MIDI) | Pending — latent: same break mode if stdout pipe fails, now shielded by global errorhandler (returns JSON 500 with CORS) but still produce empty responses; best migrated to `logger` in the planned sweep |

---

## Parameter Update Sleep Removal

**Status:** Future refactoring.

`parameter_manager.py` has `time.sleep(0.01)` after every bulk `setNew*Parameters()` call (hammer, mode, deck, excitation). The sleeps are a crude workaround for the `DROP_IF_BUSY` async policy — without them, consecutive updates can be silently dropped because `cudaMemcpyAsync` returns before the double-buffer swap completes.

**Refactoring options:**
- Replace sleeps with `waitForParameterUpdate()` calls
- Migrate all paths to the granular API
- Remove bulk methods if no longer needed

---

## Buffer Underrun Investigation

**Status:** F5 landed (2026-04-22, dev-f5-stream) but measured **no effect** on underrun rate. Investigation continues — compute-bound, not serialization-bound.

Two concerns were identified pre-F5:

1. **Lock-scope window (pre-existing, latent).** `produce()` releases its mutex before the D→H copy, creating a ~0.5–1.3 ms window where `consume()` can see a stale `write_position`. Not addressed by F5.

2. **Default-stream serialization (F5 hypothesis, refuted by data).** `produce()` used default-stream `cudaMemcpy` + `cudaDeviceSynchronize`. Hypothesis: this implicitly serialised the D→H copy against the synthesis kernel (also on default stream), doubling pipeline depth and turning jitter into underruns. F5 moved produce() to a dedicated `cudaStream_t produce_stream` with `cudaMemcpyAsync` + `cudaStreamSynchronize`. **The A/B data below show this had no observable effect.**

**F5 A/B measurement** (silent-engine probe, SDL3, Preset_test5, `buffer_size=4`, 30 s). Same-harness: revert F5 → rebuild → measure → restore F5 → rebuild → measure.

| Config | Pre-F5 | Post-F5 | Δ |
|--------|--------|---------|---|
| `string_iteration=8` | 33.3% underrun, 13 975 µs max | 33.4–35.0% underrun, 16 311–18 123 µs max | within noise |
| `string_iteration=12` | 110.9% underrun, 18 501 µs max | 110.3% underrun, 21 031 µs max | within noise |

The initial report of "~100% → 33.4%" was a cross-load comparison error — the ~100% came from an analyse-distortion A1 run whose `string_iterations` kwarg (plural) silently dropped and ran at default iter=12, not iter=8. After correction, same-harness A/B shows **no F5 effect** at either load level.

F5 is **kept** on correctness grounds (producer copy should not implicitly block on unrelated default-stream GPU work), but is **not the fix** for distortion. The real lever is synthesis kernel cost (iter=12: 110% = kernel over budget; iter=8: 33% = kernel near budget, OS scheduling tips it over).

See [logs/dev-f5-stream-2026-04-22-163903.md](logs/dev-f5-stream-2026-04-22-163903.md) for the full A/B and [probe_f5_silent_engine.py](../../PianoidCore/tests/system/probe_f5_silent_engine.py) for reproduction (env vars `F5_STRING_ITER`, `F5_DURATION_S`).

| Task | Status |
|------|--------|
| Diagnostic tests | Done |
| Root cause analysis | In progress — serialization refuted, compute-bound hypothesis remains |
| F5 — dedicated CUDA stream for produce() | Merged, no underrun effect (dev-f5-stream) |
| Fix `produce()` lock scope | Pending (distinct concern; F5 null result suggests it's also not load-bearing) |
| Reduce synthesis kernel cost at high `string_iteration` | Pending — now the primary lever |
| Investigate SDL3 callback jitter (300 µs stddev, 18 ms max on 10 ms cadence) | Pending — OS-scheduling hypothesis |

See [Testing](TESTING.md) for the test inventory.

---

## Interactive Stabilization Diagram — Chain Editing & Visualization

**Status:** All phases complete (Phase 1–5) + UI refactoring (2026-04-11).

See [INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md](INTERACTIVE_STABILIZATION_DIAGRAM_PLAN.md) for full architecture decisions, 5-phase implementation plan, and risk analysis.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Zoom/pan, brush selection, chain paths, bidirectional sync, visual encoding, damping toggle | Done |
| 2 | `save_edited_chains()` + `POST /modal/chains/save` | Done |
| 3 | `useChainEditor` hook + `StabilizationToolbar` + `StabilizationDiagram` extraction + `saveEditedChains` in useModalAdapter | Done |
| 4 | Interactive chart editing (mode-dependent handlers) | Done |
| 5 | Polish: unassigned detections, keyboard shortcuts, validation, performance, feedin guard | Done |
| Refactor | ESPRIT-only view, chain toggle fix, selection highlighting, rectangle zoom, damping/amplitude viz | Done |

**Refactoring changes (2026-04-11):**
- Diagram shows ESPRIT extraction data (unassigned dots) even before tracking runs
- Chain path toggle (showPaths) fixed — no longer sticks in "on" state
- Chain selection: default no selection; selected chains have white border + blue glow + larger size; unselect clears all visual emphasis
- Rectangle zoom: brush selection in select mode zooms to area; "Reset Zoom" button restores full view
- Damping overlay removed. Replaced with: (1) heatmap mode (D/A buttons) color-codes points by damping or amplitude, (2) sub-chart below main chart (Damp/Amp/Both) showing line charts for selected chains sharing X-axis

**Sub-chart data fix (2026-04-12):**
- Amplitude/shape/MAC sub-charts showed empty when loading existing projects (chains.json lacked amplitude/shape data saved before the feature was added)
- Fix: `_enrich_chains_from_esprit()` in `modal_adapter.py` back-fills amplitude and shape from ESPRIT per_scenario_results into chain detections on load, then persists enriched chains to disk

**Reference projection sub-chart (2026-04-12):**
- New "Proj" toggle button alongside Damp/Amp/MAC/Shape
- Computes signed reference projection from complex mode shapes in frontend: mean shape as reference, Re(dot(shape, conj(ref))) per detection
- X=scenario (zoom-synced with main diagram), Y=signed scalar (+in-phase / -anti-phase)
- Zero reference line marks nodal boundary, area fill highlights positive/negative regions

**Selected chain properties display (2026-04-14):**
- When chains are selected, MUI Chips appear above the main chart showing per-chain: ID, mean frequency (Hz), mean damping ratio, scenario count
- Chips bordered by stability color (green/yellow/orange/grey) for quick identification
- Compact and non-intrusive — wraps across multiple rows when many chains selected

**Visualization enhancements (2026-04-14):**
- Bridge boundary: replaced inaccurate graphic percentage line with ECharts markLine at exact scenario index, tracks zoom/pan, "Bass | Treble" label
- Chain visibility filter: ToggleButtonGroup (Stable / +Semi / All / Unasgn) filters chains by stability class; "Unasgn" hides all chains and shows only orphan detections (larger, orange)
- Chain paths visible by default (`showPaths` initialized to `true`)
- Chain selection fix: brush tool was intercepting clicks before scatter handler; tiny brush areas now detected and converted to click-select via `findNearestChain`
- Full-bridge chains (`bridge="full"`): path lines split at `bridgeBoundary` to show natural gap between bass/treble sections
- Interactive shape sub-chart: clicking selects ALL lines crossing the click area (5% Y-range tolerance), not just the single clicked line; all corresponding points highlighted on main chart (white diamond, orange glow); non-matching shape lines dim; toggleable
- Zoom fixes: brush rectangle artifact cleared via brush tool toggle off/on; reset zoom also dispatches `dataZoom` reset to 0-100% on both axes
- Shape phase alignment: scenario shapes normalized to consistent phase before display — dot product with reference shape determines sign flip, so shapes from different scenarios are visually comparable

**Zoom system refactoring (2026-04-14):**
- Unified dual-state zoom: removed ECharts `dataZoom` (type "inside") components; all zoom now flows through single `viewBounds` React state
- Manual scroll-wheel zoom: cursor-centered, log-aware for Y axis (frequency), replaces ECharts internal scroll/pinch zoom
- Reset Zoom button visible whenever any zoom source is active (not just brush zoom)
- Centralized brush lifecycle: single effect manages brush arm/disarm via `brushGeneration` counter, replacing 3 competing paths (handleBrushSelected cleanup, useEffect on option change, handleChartReady)
- Sub-charts sync with unified zoom state via `viewBounds`
- All chart animations disabled (`animation: false`) — ECharts axis interpolation caused visible intermediate state on zoom reset

**Bug 4 — interactive shape anchor for phase + magnitude alignment (2026-04-19, dev-190d):**
- Shape sub-chart ("shape across channels" mode) displayed unphased, unscaled curves. Existing `alignShape` helper phased scenarios within a SINGLE chain against that chain's own first detection, but different chains referenced different anchors and magnitudes varied wildly — so overlaid curves had no common visual reference and were not indicative.
- First attempt (auto-minimax): picked anchor channel automatically as argmax over channels of min |value| across curves. Rejected by user on redesign — the "best" channel in a noise sense may not be the one the user wants to compare at, and aggressive normalization without consent hides the raw spatial pattern when it's the useful view.
- Final implementation (user-driven anchor):
  - New local state `shapeAnchor: null | channel_index` (null = raw unphased, integer = normalize to +1 at that channel). Default null.
  - `useEffect` resets `shapeAnchor` to null whenever Shape sub-chart is toggled off, so re-enable always starts in raw mode.
  - In the `subChartData` useMemo: scenario-level `alignShape` runs unconditionally as before (no regression of prior fix); cross-curve normalization is applied ONLY when `effectiveShapeAnchor != null` (clamped to valid channel range). For each curve, multiplier = `1 / curve[anchor]` so curve passes through +1 at the anchor. Guard: curves with `|curve[anchor]| < 1e-12` are left untouched (no division by zero).
  - UI: above the Shape sub-chart, a compact `ToggleButtonGroup` lists channel numbers (0..nCh-1) plus an "OFF" button. Clicking a channel number sets the anchor; clicking another re-anchors instantly (re-triggers the useMemo via the `shapeAnchor` dep); clicking OFF clears back to raw view. OFF is disabled when no anchor is active.
  - `makeShapeSubOption` gates the dashed vertical markLine and the `"Shape (norm @ Ch<N>)"` Y-axis label behind `anchorChannel != null` — both disappear in raw mode.
  - Click-to-highlight handler on the sub-chart is unchanged: it operates on whatever `shapeSeries` it receives, so it works in both raw and normalized modes (tolerance scales with actual Y range).
- UI verified end-to-end on Belarus8D_clean (5 response channels):
  1. Default view = raw unphased curves (Y ~ -1..1). Pass.
  2. Anchor Ch 1 / Ch 2 / Ch 3 / Ch 4 → dashed markLine appears, Y-axis label updates, curves converge at the anchor. Pass.
  3. OFF → raw view restored, markLine gone, Y-axis back to "Shape". Pass.
  4. Toggle Shape sub-chart OFF → ON → state reset to null, raw view. Pass.
  5. Single chain selected + anchor set → single curve passes through +1 at anchor. Pass.

- **Extension (same batch) — percentile-based Y clipping when anchor is active:** user reported that outlier chains (chains with near-zero at the anchor) stretched the Y range to ±thousands, jamming the readable curve body near 0.
  - Added Y clip inside `makeShapeSubOption`: collect all y-values from `shapeSeries`, sort, take 5th/95th percentile, pad by 10% of the clipped range, then round to nice tick boundaries (`niceRound` helper — 0.5*10^mag steps). Always keep +1 inside the visible range so the anchor markLine remains meaningful.
  - Min-samples guard: `< 20` total values → fall back to auto-range (small sample percentile is unreliable).
  - Explicit `min: null, max: null` when anchor is off — ECharts merges yAxis options rather than replacing them, so without explicit nulls the previous clip bounds would persist after clearing the anchor (caught during UI test).
  - Raw mode (anchor null) keeps ECharts auto-range. Tooltips still show real numeric values (ECharts axis-trigger uses series data, not clipped pixels).
  - Verified visually on Belarus8D_clean (5 chains, Ch 0 anchor): before fix Y range was roughly -12000..3000 (curves invisible); after fix Y range is -4..4 (curves clearly readable, outliers run off-chart). Same Ch 0 anchor on single chain gives Y range -3..1.5. All other channels (Ch 1/2/3/4) behave similarly — readable curve body, outlier curves clip off.
  - Console: 0 new errors. Pre-existing ModalAdapter "Invalid prop children" warning and WebSocket reconnect errors on :5000 are unrelated.

**Bug 2 — brush rectangle persistence fix (2026-04-19, dev-9d5c):**
- Blue brush rectangle sometimes persisted on screen after zoom. Root cause: the clear-brush dispatch in `handleBrushSelected` lived inside the outer try and AFTER the data-path `return` statements, so any early return (unrecognized coordRange shape, pixel-conversion failure) or exception in processing (chainEditor race, NaN in geometric mean) swallowed the clear and left the rectangle visible.
- Fix (first pass): wrapped `handleBrushSelected` body in try/finally so `dispatchAction({type:"brush", areas:[]})` + `setBrushGeneration++` run on every exit path. Also added defensive `dispatchAction({type:"brush", areas:[]})` at the top of the centralized brush lifecycle effect.
- Regression (same day): first-pass fix caused a 300ms-period infinite feedback loop. `dispatchAction({type:"brush", areas:[]})` triggers the ECharts `brushVisual` pipeline which queues a throttled `brushselected` event via `visualEncoding.js:189`. The finally block's clear dispatch AND the lifecycle effect's defensive clear both produced echoes; the echo entered `handleBrushSelected` with empty areas; the inner empty-areas `return` was inside the try so the finally ran anyway, bumping generation and re-dispatching — continuous redraw of the chart region. Measured before fix: 7 brushselected fires in 2s idle.
- Fix (second pass, Option C — echo guard + single-owner clear):
  1. Added an echo guard at the very top of `handleBrushSelected`: if `params.batch[0].areas` is empty, return BEFORE the try/finally. Real user brush events always carry non-empty areas; empty-areas events are ECharts echoes or legitimate no-op clears with nothing to act on.
  2. Removed the defensive `dispatchAction({type:"brush", areas:[]})` from the lifecycle effect. The finally block in `handleBrushSelected` is the single owner of the brush clear — removing the second path eliminates a second feedback source.
- Second regression (same day, worse than first pass): user reported "rectangle persists more than before." DOM-level instrumentation (60 Hz sampler on zrender display list + `BrushController._covers / _creatingCover / _dragging`) with a real mouse-drag repro revealed a new failure mode: during a drag with a mid-drag pause (>300ms), `brushselected` fires DURING the drag. Our handler runs, dispatches `brush areas:[]`. ECharts `BrushController.updateCovers([])` at BrushController.js:189-225 empties `_covers` immediately (line 198: `this._covers = []`), but the DataDiffer `remove(oldIndex)` callback guards at line 221: `if (oldCovers[oldIndex] !== creatingCover) group.remove(...)`. When `_creatingCover` is still set (drag ongoing), `group.remove` is SKIPPED — the zrender cover element is ORPHANED (not in `_covers`, but still in `group.children()`, still rendered). After mouseup, no subsequent dispatch reaches `group.remove` for the orphan: `handleDragEnd`'s internal `brush` dispatch has `$from: modelId` which is rejected by `BrushView._updateController`'s anti-echo guard, and our echo-guard brushselected returns without dispatching. Orphan persists indefinitely.
- Fix (third pass, Option D — direct group reconciliation): added `forceRemoveOrphanedCovers()` helper that walks `inst._componentsViews -> brush view -> _brushController`, computes `Set(_covers)`, and directly removes any `group.children()` entry not tracked in `_covers`, then calls `zr.refresh()`. This bypasses DataDiffer's `_creatingCover` guard. Called from three sites: (a) echo path at top of `handleBrushSelected` (post-drag cleanup), (b) finally block after the clear dispatch (happy path belt-and-suspenders), (c) end of the lifecycle effect (safety net after mode/generation change). Feedback-loop safety unchanged — echo guard still prevents infinite re-entry.
- Verification post-third-pass: 0 brushselected fires in 5s idle. All scenarios pass with DOM-level confirmation (`groupChildren: 0, ctrlCovers: 0, visibleCovers: 0`): happy path smooth drag, tiny-click isSmall path, mid-drag-pause (the exact user repro), 4 rapid successive drags, mode toggle off->on.

---

## Modal Adapter Redesign — Phase 1 + Phase 2 + Phase 3

**Status:** All implementation complete (2026-04-06 to 2026-04-09). Browser verification pending.

See [MODAL_ADAPTER_REDESIGN_PLAN.md](MODAL_ADAPTER_REDESIGN_PLAN.md) for full plan, commit references, and architecture details.

### Phase 1: Independent Stages + Full Pipeline (6 waves)

Replaces sequential `AdapterState` enum with data-availability checks, per-section "Load Saved" buttons, "Run Full Pipeline" with Stepper progress.

| Wave | Scope | Status |
|------|-------|--------|
| 1 | State machine removal + data checks + ModeChain reconstruction | Done |
| 2 | Measurement persistence + ESPRIT refactor + pipeline method | Done |
| 3 | Offline preset builder (`build_preset_to_file`) | Done |
| 4 | New API endpoints (`GET /modal/data_status`, `POST /modal/run_pipeline`) | Done |
| 5 | Frontend hook (`useModalAdapter` — `dataStatus`, `canRun*` flags, `runPipeline`, `loadIntermediate`) | Done |
| 6 | Frontend UI (`ModalAdapter.jsx` — data-driven enablement, pipeline controls) | Done |

### Phase 2: Server Separation, Projects & UI Overhaul (2026-04-08/09)

| Feature | Commits | Status |
|---------|---------|--------|
| Separate modal adapter server (port 5001, `threaded=False`) | `8fd1226` | Done |
| Project management system (7 CRUD endpoints, project.json storage) | `8fd1226` | Done |
| Synthesis pause/resume (`/pause_synthesis`, `/resume_synthesis`) | `8fd1226` | Done |
| ESPRIT fixes (`_resolve_bands`, null `window_length`, numpy serialization) | `8fd1226` | Done |
| FolderBrowser component (native OS folder picker via tkinter) | `2e55e80` | Done |
| Frontend tab UI (Project/ESPRIT/Tracking/Apply replacing accordions) | `020dbd7` | Done (superseded by Phase 3 toolbar) |
| Per-scenario ESPRIT with checkbox selection + shift-click | `020dbd7` | Done |
| EspritConfig simplification (GPU checkbox + advanced toggle) | `020dbd7` | Done |
| Dual-process launcher (port 5000 + 5001 management) | `020dbd7` | Done |

### Phase 3: Toolbar UI (2026-04-09)

Replaced tab navigation with a compact single-row toolbar: server status chip, project button, pipeline ButtonGroup (ESPRIT/Tracking/Apply with checkmark/spinner status), gear icon for collapsible context-sensitive settings, and play/skip-next buttons (with stop when running). Settings and run buttons removed from section bodies.

| Feature | Status |
|---------|--------|
| Toolbar with pipeline ButtonGroup | Done |
| Server status chip (On/Off, clickable) | Done |
| Project button with name + checkmark | Done (merged into Setup button) |
| Context-sensitive settings panel (gear toggle) | Done |
| Play (run step) + SkipNext (run to end) buttons | Done |
| Stop button overlay when running | Done |

### Phase 4: Merged Setup Panel + Settings Freeze (2026-04-12)

Merged Project and ESPRIT into a unified "Setup" section. Channel roles and ESPRIT config moved to settings/gear panel. All settings freeze (disabled + lock icon) once ESPRIT processing starts.

| Feature | Status |
|---------|--------|
| Merge Project + ESPRIT into unified Setup section | Done |
| Channel roles in settings/gear panel (not section body) | Done |
| ESPRIT config in settings/gear panel alongside channel roles | Done |
| Settings freeze when ESPRIT starts (running or done) | Done |
| Lock icon replaces gear icon when frozen | Done |
| Project creation/import/copy/delete hidden when frozen | Done |
| Setup button shows project name | Done |

### State Management Rewrite (2026-04-13)

Phased elimination of split-brain state between frontend and backend.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Backend `GET /modal/project_state` endpoint | Done |
| 2 | Backend `DEFAULT_CONFIG.preset` → `extended_8band` | Done |
| 3 | Frontend `mappingDirty` tracking for explicit save | Done |
| 4 | Frontend `syncFromBackend()` — single state sync function | Done |
| 5 | Frontend cleanup — dead code, state consolidation, log path fix | Done |

Phase 4 replaced ~200 lines of ad-hoc state restoration across `openProject`, `createProject`, `copyProject`, mount effect, and `addMeasurementsToProject` with a single `syncFromBackend()` function. Every mutation now calls `syncFromBackend()` after success. Removed dead `applyConfig`/`setConfigPreset` (endpoint deleted in Phase 1).

Phase 5 cleanup: removed `onPresetSelect` dead prop from EspritConfig, removed band-preset retry-polling (fetch once on mount instead), consolidated 4 project-related useState calls into grouped `project` state object, removed unused `pct` variable in importProject upload handler, fixed hardcoded log path in modal_adapter `__init__.py` to use system temp directory.

### Bug 3 — Settings relocation to native MosaicWindow toolbar (2026-04-19, dev-aeb0)

The custom inline gear IconButton in the ModalAdapter toolbar row was redundant with the native MosaicWindow title-bar toolbarControls slot. Fix relocates the settings gear/lock to the title bar via `ReactDOM.createPortal` into `.mosaic-window-controls`. A `useLayoutEffect` hook also hides the generic `button[title="Settings"]` that `PianoidTuner.renderToolbarControls` injects for all panes (it was pointing at an empty PropertyManager since "Modal Adapter" has no `settingsMap` entry). Net result: exactly one settings gear in the title bar, wired to ModalAdapter's real settings panel. Freeze/lock behavior preserved; all context-sensitive content (MappingEditor + EspritConfig for Setup, freq tolerance + max gap for Tracking, merge toggle + sound channel mapping for Apply) unchanged. Fully contained in `ModalAdapter.jsx` — no edit to `PianoidTuner.js` required.

### Remaining

- Browser verification of all Phase 1 + Phase 2 + Phase 3 + Phase 4 features
- Browser verification of state management rewrite (project open/create/copy, ESPRIT run, state persistence)
- Independent-stage loading, full pipeline execution, backward compatibility
- Project CRUD workflow, toolbar navigation, per-scenario ESPRIT UI

---

## Extended 8-Band Pipeline Run (2026-04-07/08)

**Status:** ESPRIT + tracking + feedin complete. Preset built, not yet volume-matched.

The `extended_8band_medium` pipeline completed all stages on Belarus piano data:
- **ESPRIT:** 78/78 scenarios, 8210 raw modes, ~56 sec/scenario, ~72 min total
- **Tracking:** 441 chains (210 stable, 133 semi-stable, 64 weak, 34 spurious)
- **Feedin:** 88 pitches (78 measured + 10 interpolated), 441 mode frequencies

A 196-mode preset (`Belarus_8band_196modes.json`) was built from the top 196 stable modes with per-mode normalized feedin (0–1 range) and per-channel output pitch feedback. The preset produces sound but is quieter than BaselineBelorus1 at higher pitches — likely due to different modal content between 4-band and 8-band extractions.

Data: `D:/tmp/belarus_78_extended_8band_medium/`

See [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) and [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) for run details.

Reference presets:
- `presets/BaselineBelorus1.json` (196 modes, 4-band, per-mode normalised feedin)
- `presets/Belarus_8band_196modes.json` (196 modes, 8-band medium, per-mode normalised feedin)
- `presets/Belarus_ESPRIT_v2.json` (100 modes, uniform feedin — legacy)

---

## note_playback Chart Auto-Normalization

**Status:** Pending fix.

`ChartData.create_audio()` in `ChartRegistry.py` normalises the WAV audio to 0.8× peak before sending to the frontend, masking silent-output bugs. The chart statistics (max, RMS) are from the raw buffer before normalisation, but the WAV IS normalised. During Belarus preset development, this masked a silent-output bug.

**Fix options:**
1. Report `synthesis_peak` (actual kernel output magnitude) alongside chart stats
2. Add a warning when synthesis_peak is below a threshold
3. Optionally disable auto-normalisation

---

## ASIO Driver Re-initialization Failure

**Status:** Pending fix.

After ASIO callback driver is stopped, re-initialization fails with "no working ASIO device found". Root cause: `AsioAudioOutput::Close()` in `AsioAudioInterface.cpp` doesn't reset global state variables (`asioDriverInfo`, `directOutputFn`, `asioCallbacks`, `queueToPlay`) and the `AsioDrivers` COM singleton is never destroyed/recreated.

**Workaround:** Restart the backend server between ASIO sessions.

---

## Completed Items (archived)

| Item | Status | Notes |
|------|--------|-------|
| Excitation API Mismatch | Fixed | `StringMap.pack_base_excitations()` added to PianoidBasic |
| Parameter Routing Unification | Complete | All routes through `ParameterManager` |
| Playback System Fixes | Complete | 11/14 findings fixed (see tracker below) |
| Microphone-Based Volume Equalization | Implemented | 4-phase calibration across all 3 repos |
| RoomResponse Modal Adapter Integration | Complete | All 4 waves, 6 critical bugs fixed |
| Sound Channel useEffect Feedback Loop | Fixed | Restored init-once guards with `scDataRefresh` flag |
| Second Derivative Sound Output | Resolved | Kernel-level 2nd derivative implemented |

### Playback System — Improvement Tracker

| # | Finding | Status |
|---|---------|--------|
| 1 | Three overlapping stop methods | **Done** |
| 2 | `stop_pianoid()` sleep race condition | **Done** |
| 3 | `long_running_procedure()` dead reference | **Done** |
| 4 | MIDI→EventType mapping duplicated 3× | **Done** |
| 5 | No CUDA error check in online engine | **Done** |
| 6 | `play_mode()` blocking sleep | **Done** |
| 7-10 | Dead code cleanup | **Done** |
| 11 | Double mutex in `RealTimeEventBuffer` | **Done** |
| 14 | No playback integration tests | Pending |

---

## Recently archived

Moved to [archive/](archive/) on 2026-04-25 (`archive-dev-docs`):

| File | Reason |
|---|---|
| [archive/VOLUME_ITER_BUG_INVESTIGATION.md](archive/VOLUME_ITER_BUG_INVESTIGATION.md) | Primary bug fixed (Kernels.cu:155 dt² fix + preset rescale, 2026-04-23). Secondary follow-ups still tracked above under Known Follow-Ups. |
| [archive/PLAYBACK_ARCHITECTURE_REVIEW.md](archive/PLAYBACK_ARCHITECTURE_REVIEW.md) | Research snapshot (2026-04-20). Subsequent cycle orchestration tranches (C1/C2/C3/C8/C10/C11/C12/C13) committed. |
| [archive/CYCLE_ORCHESTRATION_REFINEMENT.md](archive/CYCLE_ORCHESTRATION_REFINEMENT.md) | All proposed tranches (A/B/C2/C3/F5) committed. |
| [archive/DISTORTION_INVESTIGATION_CONTEXT.md](archive/DISTORTION_INVESTIGATION_CONTEXT.md) | Briefing snapshot (2026-04-20), precursor to volume-iter — closed. Live distortion concerns now tracked under Buffer Underrun Investigation. |
| [archive/BELARUS_PIPELINE_RUN_REPORT.md](archive/BELARUS_PIPELINE_RUN_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/EXTENDED_8BAND_PIPELINE_REPORT.md](archive/EXTENDED_8BAND_PIPELINE_REPORT.md) | One-shot run report (2026-04-07). |
| [archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md](archive/ACOUSTIC_MEASUREMENT_ANALYSIS.md) | System analysis snapshot (2026-04-06) of mic calibration; implementation listed under Completed Items. |
