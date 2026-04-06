# Modal Adapter Pipeline: Implementation Plan

**Date:** 2026-04-06
**Status:** Planned

---

## Context

The Modal Adapter has a working skeleton (6-state machine, 9 REST endpoints, React panel) but produces unusable presets. Root causes:

1. **No measured feedin** — ESPRIT runs but feedin coefficients end up uniform 1.0. The pipeline never extracts per-pitch string-mode coupling from measurements.
2. **Sound output bug** — `preset_injector.py` zeroes `mode_sound_channels` for pitches 128-131, silencing mode-based audio output.
3. **Naive band merging** — `esprit_runner.py` uses frequency-proximity deduplication instead of proven MAC-based merging from `band_merging.py`.
4. **No mode tracking** — The spatial `track_modes_along_bridge()` (which produced excellent Belarus results via `run_full_belarus.py`) is not wired into the pipeline.
5. **No persistence** — Long ESPRIT runs are lost on crash.
6. **Channel mapping not configurable** — Force/reference/response channel roles are hardcoded.
7. **No per-mode visualization** — No mode shape along bridge, no decaying sinewave preview.

The proven pipeline lives in `run_full_belarus.py` (RoomResponse): EXTENDED_BANDS + MAC merging + spatial mode tracking. The proven feedin extraction lives in `create_measured_preset.py`: FFT at mode frequencies from averaged IRs.

### User Requirements

- **No wizard** — expose all settings as a panel with independent controls. User can run the full chain or each stage independently using stored intermediate results.
- **Channel mapping is late-stage** — it maps response channels to Pianoid sound channels, placed after tracking (before preset application), not at the beginning.
- **Config presets + advanced** — named presets (Standard 4-band, Extended 8-band) with Advanced toggle for per-band parameters.
- **Auto-persist** — all intermediate results saved to project folder automatically.
- **Per-mode visualization** — individual mode shape along both bridges, individual mode decaying sinewave (using existing `pure_mode_test_function` / `exciteMode()` logic).
- **Fully configurable channel roles** — user specifies force, reference, and response channels per dataset.

---

## Pipeline Architecture

Six independent stages, each with stored intermediate results. No wizard — the panel exposes all stages with independent Run buttons. Later stages require earlier results (loaded from persistence or computed in-session).

```
Stage 1: Load Measurements
  Input: folder path
  Output: measurements dict, scenario metadata
  Persisted: source path + metadata only (raw data stays in source folder)

Stage 2: ESPRIT Extraction
  Input: measurements + ESPRIT config (band preset, model orders, MAC threshold)
  Process: Per-scenario merge_multiband_results() with EXTENDED_BANDS
  Output: per_scenario_results {scenario_idx: {frequencies, damping_ratios, n_raw, n_merged}}
  Persisted: esprit/scenario_*.json + esprit/metadata.json

Stage 3: Mode Tracking
  Input: per_scenario_results + bridge_boundary + tracking params
  Process: track_modes_along_bridge() separately for bass (<=boundary) and treble (>boundary)
  Output: List[ModeChain] with stability classification (stable/semi-stable/weak/spurious)
  Persisted: tracking/chains.json

Stage 4: Feedin Extraction
  Input: measurements + tracked mode chains + response channel indices
  Process: FFT at chain frequencies per response channel, mean across channels
  Output: per_pitch_feedin, per_pitch_sound_coeffs, interpolation info
  Persisted: feedin/feedin_data.json

Stage 5: Channel Mapping & Sound Routing
  Input: feedin data + channel-to-sound-output mapping
  Process: Map response channels to Pianoid sound output channels (0-3)
  Output: final per-pitch sound_channel_coefficients for preset
  Persisted: mapping/channel_mapping.json

Stage 6: Apply to Preset
  Input: tracked chains (selected) + feedin data + channel mapping
  Process: Build preset with ESPRIT freq/damping + measured feedin + sound coefficients
  Output: preset JSON loaded into Pianoid
  Persisted: output/preset.json
```

---

## Wave 1: Backend Core (no frontend dependency)

### 1.1 Create `feedin_extractor.py` (NEW)

**File**: `PianoidCore/pianoid_middleware/modal_adapter/feedin_extractor.py`

Extracts the FFT feedin pattern from `create_measured_preset.py` (lines 48-68) into a reusable module.

```python
class FeedinExtractor:
    @staticmethod
    def extract_modal_coefficients(signal, mode_freqs, fs):
        """FFT magnitude at each mode frequency.
        Reused from create_measured_preset.py: rfft -> nearest bin -> magnitude."""

    def extract_for_scenario(self, signals, mode_freqs, fs, response_channels):
        """Per-channel FFT at mode frequencies.
        Returns: {feedin: ndarray(n_modes),
                  per_channel: ndarray(n_response_ch, n_modes),
                  sound_coeffs: ndarray(n_response_ch)}"""

    def extract_all(self, measurements, mode_chains, response_channels, fs,
                    bridge_boundary, pitch_offset):
        """Extract feedin for all measured pitches + interpolate unmeasured.
        Uses chain.frequency_mean as FFT target (or chain.detections[sc].frequency
        when scenario-specific detection exists).
        Returns: {per_pitch_feedin: Dict[int, ndarray],
                  per_pitch_sound_coeffs: Dict[int, ndarray],
                  measured_pitches: List[int],
                  interpolated_pitches: List[int]}"""

    def interpolate_unmeasured(self, measured_feedin, all_pitches, bridge_boundary):
        """Linear interpolation within same bridge only.
        No interpolation across bridge_boundary (scenario 28/29 split).
        Bass pitches without neighbors: fallback to uniform 1.0.
        Treble pitches without neighbors: fallback to nearest measured."""
```

**Data flow**: For each tracked chain → FFT at chain frequency → magnitude at each response channel → mean = feedin coefficient for that mode at that pitch. Per-channel magnitude sums → sound channel weights.

### 1.2 Rewrite `esprit_runner.py` — Use proven pipeline

**File**: `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`

**Replace** `run_single_point()`:
- Current: manual band iteration via `process_multiband()` + per-band `esprit_modal_identification()` + `_deduplicate_modes()` (frequency-only, loses mode shapes)
- New: single call to `merge_multiband_results(signals, fs, bands, esprit_function, esprit_params, mac_threshold, freq_tol_pct)` from `band_merging.py` — handles filter, preemphasis, decimation, per-band ESPRIT, MAC deduplication, band-center weighting

**Add** band config presets:
```python
BAND_PRESETS = {
    "standard_4band": STANDARD_BANDS,   # from band_processing.py
    "extended_8band": EXTENDED_BANDS,    # from band_processing.py
}
```

**Add** `run_tracking()` method:
```python
def run_tracking(self, per_scenario_results, bridge_boundary=28,
                 freq_tol_pct=0.02, max_gap=3):
    """Run track_modes_along_bridge() separately for bass and treble.
    Returns: {bass_chains: List[ModeChain], treble_chains: List[ModeChain],
              all_chains: List[ModeChain]}"""
```

**Delete**: `_deduplicate_modes()`, `_cluster_modes_across_points()` — replaced by library calls.

**Add**: CuPy memory cleanup after each scenario (pattern from `run_full_belarus.py`).

**Imports** from RoomResponse (via `ROOMRESPONSE_PATH` env var):
- `band_processing.STANDARD_BANDS, EXTENDED_BANDS, merge_multiband_results`
- `band_merging.merge_multiband_modes`
- `mode_tracking.track_modes_along_bridge, ModeChain`
- `esprit_core.esprit_modal_identification, ModalParameters`

### 1.3 Expand `mapping.py` — Channel roles + bridge config

**File**: `PianoidCore/pianoid_middleware/modal_adapter/mapping.py`

**Add** to `MappingConfig`:
```python
channel_roles: Dict[int, str] = field(default_factory=dict)  # "force"/"reference"/"response"
bridge_boundary: int = 28          # scenario index for bass/treble split
pitch_offset: int = 21             # pitch = scenario + offset
```

**Add properties**: `force_channels`, `reference_channels`, `response_channels` (derived from `channel_roles`).

**Add validation**: at least one force channel, at least one response channel, roles cover all non-skipped channels.

---

## Wave 2: State Machine + Injector Fix (depends on Wave 1)

### 2.1 Expand `modal_adapter.py` — Independent stages + persistence

**File**: `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`

**Replace wizard-style linear state machine** with stage-based architecture. Each stage can be triggered independently if its prerequisite data exists (either from a prior run in this session or loaded from persistence).

**New instance vars**:
```python
self._per_scenario_results: Dict[int, Dict] = {}
self._tracked_chains: List = []
self._feedin_data: Dict = None
self._project_dir: Optional[str] = None
self._channel_mapping: Dict = None  # channel → sound output mapping
```

**New methods**:
```python
def set_project_dir(self, path):
    """Create persistence subdirs: esprit/, tracking/, feedin/, mapping/, output/"""

def run_tracking(self, bridge_boundary=28, freq_tol_pct=0.02, max_gap=3):
    """Requires _per_scenario_results. Runs mode tracking, persists chains."""

def run_feedin_extraction(self, response_channels):
    """Requires _measurements + _tracked_chains. FFT feedin, persists results."""

def set_channel_mapping(self, channel_to_sound):
    """Maps response channels to Pianoid sound output indices (0-3). Persists."""

def load_intermediate(self, stage):
    """Load persisted results for a stage (esprit/tracking/feedin/mapping)."""

def get_stabilization_data(self):
    """Return chain data formatted for stabilization diagram visualization."""

def get_mode_shape_data(self, chain_id):
    """Return feedin magnitude along bridge for a single mode chain."""

def get_mode_preview_params(self, chain_id):
    """Return frequency + damping for rendering decaying sinewave via existing
    pure_mode_test_function / exciteMode() + offline playback."""
```

**Auto-persistence**: after each stage writes JSON to `{project_dir}/modal_adapter/{stage}/`.

### 2.2 Fix `preset_injector.py` — Sound output + FFT feedin path

**File**: `PianoidCore/pianoid_middleware/modal_adapter/preset_injector.py`

**Bug fix 1**: `_build_deck_in_preset()` — remove `if pitch >= 128: continue`. Explicitly set feedin=zeros, feedback=zeros for pitches 128-131 (sound output pitches are output-only, not excited).

**Bug fix 2**: `_build_sound_channels_in_preset()` — for pitches 128-131, set coefficients to the average of all measured pitches' sound coefficients (not zero). These represent aggregate output behavior.

**New method**: `apply_with_feedin(pianoid, mode_chains, feedin_data, channel_mapping, selected_chains)` — takes FFT feedin data + channel mapping directly, builds preset without going through the broken mode-shape-derived path.

### 2.3 Expand `routes.py` — New endpoints

**File**: `PianoidCore/pianoid_middleware/modal_adapter/routes.py`

**New endpoints**:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/modal/config` | POST | Set ESPRIT config with preset name + advanced params |
| `/modal/run_tracking` | POST | Run mode tracking (params: bridge_boundary, freq_tol_pct, max_gap) |
| `/modal/tracking_results` | GET | Return tracked chains with stability classification |
| `/modal/run_feedin` | POST | Run FFT feedin extraction (params: response_channels) |
| `/modal/feedin_results` | GET | Return per-pitch feedin + sound coefficients |
| `/modal/channel_mapping` | POST | Set response channel → sound output mapping |
| `/modal/stabilization_diagram` | GET | Return chain data for scatter plot visualization |
| `/modal/mode_shape/{chain_id}` | GET | Return feedin magnitude along bridge for one mode |
| `/modal/mode_preview/{chain_id}` | GET | Return decaying sinewave audio (uses `pure_mode_test_function` pattern: `exciteMode()` + offline playback) |
| `/modal/set_project_dir` | POST | Set persistence directory |
| `/modal/load_intermediate/{stage}` | GET | Load saved intermediate results |
| `/modal/band_presets` | GET | Return available band preset configs |

---

## Wave 3: Frontend — Panel Layout (depends on Wave 2)

### 3.1 Update `useModalAdapter.js` — Independent stages

**File**: `PianoidTunner/src/hooks/useModalAdapter.js`

Replace wizard step model with independent stage state. Each stage has: loaded (bool), running (bool), results (data), error (string).

```javascript
// Stage state model (repeated for each stage)
stages: {
    load:     { done: false, data: null },
    esprit:   { done: false, running: false, progress: null, data: null },
    tracking: { done: false, running: false, data: null },
    feedin:   { done: false, running: false, data: null },
    mapping:  { done: false, data: null },
}
```

**New actions**: `runTracking()`, `runFeedin()`, `setChannelMapping()`, `loadIntermediate(stage)`, `getModeShape(chainId)`, `getModePreview(chainId)`, `setConfigPreset(name)`.

**Band presets**: fetch from `/modal/band_presets` on mount.

### 3.2 Redesign `ModalAdapter.jsx` — Panel with sections (not wizard)

**File**: `PianoidTunner/src/modules/ModalAdapter.jsx`

Replace 6-step Stepper with a single-page panel containing collapsible sections:

```
[Load Measurements]
  Path input, Load button, measurement summary (N scenarios, N channels, sample rate)
  Channel role assignment: per-channel dropdown (Force/Reference/Response)
  Bridge boundary input, pitch offset input

[ESPRIT Configuration]
  Preset selector: "Standard 4-band" | "Extended 8-band" | "Custom"
  [Advanced] Per-band: model_order, window_length, decimation, exp_factor
  MAC threshold, freq tolerance, max damping, use GPU toggle
  [Run Extraction] button + progress bar + per-scenario status

[Mode Tracking]
  Bridge boundary (pre-filled), freq tolerance, max gap
  [Run Tracking] button
  Summary: N chains (N stable, N semi-stable, N weak)
  
[Mode Selection & Visualization]
  Stabilization diagram (ECharts scatter: scenario × frequency, colored by stability)
  Mode table: frequency, damping, stability, detection count, coverage%, drift
  Filters: stability dropdown, frequency range, damping range, min coverage
  Checkboxes for selection
  Per-mode detail (expandable):
    - Mode shape along bridge (ECharts line: pitch × feedin magnitude, bass/treble separate)
    - Decaying sinewave preview (audio player, uses existing exciteMode() + offline render)

[Feedin Extraction]
  Response channel selection (checkboxes, pre-filled from channel roles)
  [Run Feedin] button
  Feedin heatmap (ECharts: pitch × mode, color = magnitude)
  Visual divider at bridge boundary
  Summary: N measured, N interpolated

[Sound Channel Mapping]
  Response channel → Pianoid sound output (0-3) mapping table
  Preview of sound_channel_coefficients for a few test pitches

[Apply to Preset]
  Summary of what will be applied: N modes, N pitches with measured feedin, N interpolated
  Merge/Replace toggle
  [Apply] button
  [Save Preset] button
```

### 3.3 Enhance `ModalResultsView.jsx` — Stabilization diagram + mode shape

**File**: `PianoidTunner/src/components/ModalResultsView.jsx`

**Add Stabilization Diagram** (ECharts scatter):
- X-axis: scenario index (bridge position, 0-87)
- Y-axis: frequency (Hz), log scale
- Each dot: one mode detection at one scenario
- Color: green=stable, yellow=semi-stable, orange=weak, gray=spurious
- Connected lines for chains (showing frequency drift along bridge)
- Click chain to select/deselect
- Vertical line at bridge boundary

**Add Mode Shape Plot** (ECharts line, per-mode):
- X-axis: MIDI pitch (21-108)
- Y-axis: feedin magnitude
- Two series: bass bridge, treble bridge (gap at boundary)
- Measured points as circles, interpolated as dashed line

**Add Mode Preview** (audio):
- Uses existing `pure_mode_test_function` pattern from chart system
- `exciteMode(modeNo, displacement, velocity)` + offline playback → WAV
- Audio player widget with play/stop
- Waveform visualization (optional, reuse ChartPanel if available)

**Add Feedin Heatmap** (ECharts heatmap):
- X-axis: MIDI pitch
- Y-axis: mode index (sorted by frequency)
- Color: feedin magnitude
- Visual divider at bridge boundary

**Add Mode Table enhancements**:
- Columns: frequency, damping, Q-factor, stability, detection count, coverage%, frequency drift
- Sortable columns
- Filter bar: stability multi-select, frequency range slider, damping range slider, min coverage

---

## Wave 4: Integration Test

End-to-end test with Belarus data:

1. Load `D:/repos/RoomResponse/piano/exported_responses/` (78 scenarios, 6 channels)
2. Configure: ch2=force, ch5=reference, [0,1,3,4]=response, bridge boundary=28, offset=21
3. Run ESPRIT: Extended 8-band, MAC threshold 0.9
4. Run tracking: freq_tol=2%, max_gap=3
5. Verify stabilization diagram shows ~100+ stable chains matching `belarus_tracked_modes_v2.json`
6. Select stable + semi-stable chains
7. Run feedin extraction on response channels
8. Verify feedin heatmap shows non-uniform coupling varying by pitch and mode
9. Map channels: [0→0, 1→1, 3→2, 4→3]
10. Apply to preset
11. Play notes — verify non-uniform feedin and working sound output on all 4 channels
12. Compare sound character with uniform-feedin Belarus_ESPRIT_v2 preset

---

## Bug Fix Summary

| Bug | File | Root Cause | Fix |
|-----|------|------------|-----|
| Uniform feedin | `esprit_runner.py` | Mode shapes lost in naive concat + no FFT extraction | Replace with `merge_multiband_results()` + new `FeedinExtractor` |
| Sound output zeroed | `preset_injector.py:238` | `if pitch >= 128: continue` + zero coefficients | Remove continue, explicitly zero deck, set non-zero sound coefficients |
| No MAC merging | `esprit_runner.py` | Uses `_deduplicate_modes()` frequency-only | Replace with `merge_multiband_results()` |
| No spatial tracking | `esprit_runner.py` | Uses `_cluster_modes_across_points()` global clustering | Wire in `track_modes_along_bridge()` with bridge boundary |
| STANDARD_BANDS only | `esprit_runner.py:29` | Only imports STANDARD_BANDS | Import EXTENDED_BANDS, add preset selection |

---

## Existing Code Reuse

| Component | Source | Purpose |
|-----------|--------|---------|
| `merge_multiband_results()` | `RoomResponse/ESPRIT/band_merging.py` | MAC-based cross-band dedup (replaces broken `_deduplicate_modes`) |
| `track_modes_along_bridge()` | `RoomResponse/ESPRIT/mode_tracking.py` | Spatial mode tracking with continuity |
| `EXTENDED_BANDS` | `RoomResponse/ESPRIT/band_processing.py` | 8-band config with per-band model orders |
| `extract_modal_coefficients()` | `create_measured_preset.py:48-68` | FFT feedin extraction pattern |
| `pure_mode_test_function` | `pianoid_middleware/chartFunctions.py` | Single mode excitation + offline render for preview |
| `exciteMode()` | `pianoidCuda` C++ via pybind11 | Direct mode excitation for decaying sinewave |
| `encode_for_json()` | `PianoidBasic/Pianoid/bytestream_encoding.py` | Base64 preset encoding |

---

## File Summary

| File | Action | Wave |
|------|--------|------|
| `modal_adapter/feedin_extractor.py` | **Create** | 1 |
| `modal_adapter/esprit_runner.py` | Rewrite core methods, add tracking + presets | 1 |
| `modal_adapter/mapping.py` | Add channel roles, bridge boundary, pitch offset | 1 |
| `modal_adapter/modal_adapter.py` | Independent stages + persistence (replace wizard states) | 2 |
| `modal_adapter/preset_injector.py` | Fix sound output bug + FFT feedin path | 2 |
| `modal_adapter/routes.py` | Add ~12 new endpoints | 2 |
| `hooks/useModalAdapter.js` | Independent stage state + new actions | 3 |
| `modules/ModalAdapter.jsx` | Panel with collapsible sections (replace wizard) | 3 |
| `components/ModalResultsView.jsx` | Stabilization diagram, mode shape, feedin heatmap, audio preview | 3 |

---

## Data Format Reference

### Per-scenario ESPRIT result (persisted)
```json
{
  "scenario_index": 10,
  "pitch": 31,
  "frequencies": [47.3, 62.1, ...],
  "damping_ratios": [0.024, 0.019, ...],
  "n_raw": 142,
  "n_merged": 118,
  "band_names": ["30-200Hz", "150-500Hz", ...],
  "params": {"mac_threshold": 0.9, "preset": "extended_8band"}
}
```

### Tracked mode chain (persisted)
```json
{
  "chain_id": 0,
  "frequency_mean": 47.38,
  "frequency_range": [46.1, 49.4],
  "frequency_drift": 3.3,
  "damping_mean": 0.024,
  "detection_count": 65,
  "coverage": 0.833,
  "stability": "stable",
  "bridge": "bass",
  "detections": {"3": {"frequency": 47.2, "damping_ratio": 0.023}, ...}
}
```

### Feedin extraction result (persisted)
```json
{
  "mode_frequencies": [47.38, 62.1, ...],
  "per_pitch_feedin": {
    "24": [0.0012, 0.0089, ...],
    "25": [0.0015, 0.0072, ...]
  },
  "per_pitch_sound_coeffs": {
    "24": [0.45, 0.32, 0.18, 0.05],
    "25": [0.41, 0.35, 0.19, 0.05]
  },
  "measured_pitches": [24, 25, 26, ...],
  "interpolated_pitches": [21, 22, 23, ...],
  "response_channels_used": [0, 1, 3, 4]
}
```

### Measurement metadata
- 78 scenarios (3-87), 6 channels, 28800 samples @ 48 kHz
- Ch2 = force/exciter (skip), Ch5 = reference, Ch[0,1,3,4] = response
- Scenario N → pitch N+21. Bass bridge: scenarios 0-28. Treble: 29+
- Available in `D:/repos/RoomResponse/piano/exported_responses/` and per-scenario `.npy` in `piano/Belarus-Scenario*/averaged_responses/`
