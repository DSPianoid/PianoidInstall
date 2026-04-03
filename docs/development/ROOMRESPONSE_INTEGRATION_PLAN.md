# RoomResponse-Pianoid Integration Plan

Bridge RoomResponse modal extraction (ESPRIT) with Pianoid synthesis engine — feed measured soundboard modes into the physical model.

---

## Architecture

```mermaid
graph TD
    subgraph RoomResponse
        IR[Multi-channel IRs<br/>.npy files] --> ESPRIT[ESPRIT Pipeline]
        ESPRIT --> MP[ModalParameters<br/>poles, freq, damping, shapes]
    end

    subgraph Adapter ["ModalAdapter (NEW)"]
        MP --> CONV[Parameter Converter<br/>freq/damping → Pianoid format]
        MP --> DECK[Deck Matrix Builder<br/>mode shapes → coupling weights]
        CONV --> PRESET[Preset Generator<br/>JSON assembly]
        DECK --> PRESET
        PRESET --> VALID[Validator<br/>range checks, consistency]
    end

    subgraph Pianoid
        VALID --> JSON[Preset JSON]
        JSON --> LOAD[/load_preset]
        VALID --> REST[REST API<br/>/set_mode_parameters<br/>/set_parameter/feedin]
        LOAD --> GPU[GPU Synthesis<br/>256 modes × 256 strings]
        REST --> GPU
    end

    subgraph Validation
        GPU --> RECORD[Record synthetic IR]
        RECORD --> REANALYZE[Re-run ESPRIT]
        REANALYZE --> COMPARE[MAC, spectral error]
        COMPARE -.-> CONV
    end
```

---

## Parameter Mapping

### Mode Parameters

| ESPRIT Output | Pianoid Input | Conversion |
|---|---|---|
| `frequencies[k]` (Hz) | `Piano_mode.frequency` (Hz) | Direct — no conversion |
| `damping_ratios[k]` (zeta) | `Piano_mode.decrement` | `decrement = 2π·ζ / √(1 - ζ²)` |
| `poles[k]` (continuous s-plane) | Not used directly | Intermediate — freq and damping derived from poles |
| (not extracted) | `Piano_mode.mass` | Default: `stiffness / (2πf)²` where `stiffness=0.1` |

### Deck Coupling Matrix

| ESPRIT Output | Pianoid Input | Conversion |
|---|---|---|
| `mode_shapes[k, ch]` — complex, (K, n_channels) | `Pitch.deck['feedin']` — real, (num_modes,) per string | Spatial interpolation from measurement grid to bridge positions; take Re(φ) |
| Same | `Pitch.deck['feedback']` — real, (num_modes,) per string | Same matrix (scalar feedback coefficient scales globally) |

### Model Order Handling

| Scenario | Action |
|----------|--------|
| ESPRIT modes < Pianoid capacity | Pad with dummy modes (high freq, high damping — effectively silent) |
| ESPRIT modes > Pianoid capacity (256) | Prioritize by: frequency overlap with strings → coupling strength → low damping |

---

## Conversion Logic

### Damping Ratio → Decrement

```python
def zeta_to_decrement(zeta: float) -> float:
    return 2 * np.pi * zeta / np.sqrt(1 - zeta**2)
```

Validation: zeta=0.01 at 100 Hz → decrement=0.0628 → T60 ≈ 11s (physically reasonable for soundboard).

### Mode Shape → Deck Coupling

1. Define bridge geometry: map each string's bridge pin to (x, y) on soundboard
2. Interpolate mode shapes from measurement grid (n_channels points) to bridge positions via RBF
3. Take real part after phase normalization (imaginary part is small for lightly-damped modes)
4. Normalize to Pianoid's expected magnitude range
5. Encode via `bytestream_encoding.encode_for_json()` as base64 in preset JSON

---

## Preset JSON Structure (Target)

```json
{
  "modes": [
    {"ID": 0, "frequency": 43.94, "decrement": 0.138},
    {"ID": 1, "frequency": 60.30, "decrement": 0.132}
  ],
  "pitches": {
    "21": {
      "deck": {"data": "<base64>", "shape": [2, 128], "type": "float64"}
    }
  },
  "model_parameters": {"num_modes": 128}
}
```

Deck shape `(2, num_modes)`: row 0 = feedin, row 1 = feedback.

---

## Phased Implementation

### Phase 1: Minimal Viable Integration (1-2 weeks)

**Goal**: Get ESPRIT modes into Pianoid and hear the result.

| Deliverable | Description |
|-------------|-------------|
| `converter.py` | `convert_modes(ModalParameters, sr)` → list of `{frequency, decrement}` dicts |
| `preset_generator.py` | `inject_modes_into_preset(base_preset, modes)` → new preset JSON |
| CLI script | `python -m modal_adapter.generate_preset --esprit-results X --base-preset Y --output Z` |
| Uniform deck | feedin=1.0, feedback=1.0 for all strings (spatial coupling deferred) |

**New files**:
```
PianoidCore/modal_adapter/__init__.py
PianoidCore/modal_adapter/converter.py
PianoidCore/modal_adapter/preset_generator.py
PianoidCore/modal_adapter/generate_preset_cli.py
```

**Validation**: Load generated preset, play notes, compare spectral content against measurement.

### Phase 2: Spatial Deck Coupling (2-3 weeks)

**Goal**: Use ESPRIT mode shapes for spatially-resolved string-mode coupling.

| Deliverable | Description |
|-------------|-------------|
| `deck_builder.py` | `build_deck_from_shapes(mode_shapes, bridge_geometry, measurement_grid)` → deck matrices per pitch |
| `config.py` | `BridgeGeometry` and `MeasurementGrid` classes (piano-specific geometry) |
| A/B comparison | Render same MIDI with uniform vs spatial deck, compute spectral difference |

### Phase 3: Live REST API Updates (1-2 weeks)

**Goal**: Push ESPRIT results to running Pianoid without restart.

| Deliverable | Description |
|-------------|-------------|
| `live_updater.py` | `PianoidLiveUpdater` class — POST to `/set_mode_parameters`, `/set_parameter/feedin/all` |
| Incremental updates | Change specific modes without full preset reload |

### Phase 4: Validation Loop (2-4 weeks)

**Goal**: Closed-loop: measure → extract → synthesize → re-measure → compare.

| Deliverable | Description |
|-------------|-------------|
| `validator.py` | MAC (Modal Assurance Criterion), spectral envelope error, T60 comparison |
| `validation_pipeline.py` | Automated: ESPRIT on measurement → preset → Pianoid offline render → ESPRIT on synthetic → metrics |
| Calibration | Iterative deck magnitude adjustment to minimize spectral error |

### Phase 5: Robust Extraction (2-3 weeks)

**Goal**: Automatic model order selection, multi-band integration.

| Deliverable | Description |
|-------------|-------------|
| Stabilization integration | Use existing stabilization diagrams for automatic mode selection |
| Multi-band pipeline | Per-band ESPRIT with result merging |
| Batch processing | Process multiple measurement points consistently |

---

## Technical Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Damping round-trip drift | Medium | Validate zeta → decrement → discrete → synthesized T60 → re-extracted zeta |
| Sparse mode shape interpolation (6-20 points → 224 strings) | High | Phase 1 uses uniform coupling; Phase 2 uses smooth RBF interpolation |
| Model order uncertainty | Medium | Stabilization diagrams + pole clustering across multiple orders |
| Complex → real mode shapes | Low-Medium | Take Re(φ) after phase normalization; flag high-imaginary modes |
| Effective modal mass unknown | Medium | Use default mass; tune via `deck_feedback_coeff` (CC 74) as global scaler |
| Frequency range coverage | Low | ESPRIT multi-band covers 40-5000 Hz; Pianoid supports 256 modes |

---

## Data Flow Paths

### Offline (Preset Generation)

```
ESPRIT .npz → converter.convert_modes() → preset_generator.inject_into_preset() → JSON → /load_preset
```

### Online (Live Update)

```
ESPRIT ModalParameters → converter → live_updater.push_modes() → POST /set_mode_parameters
                       → deck_builder → live_updater.push_deck() → POST /set_parameter/feedin/all
```

### Validation

```
Measurement IR → ESPRIT → ModalParams_measured
Pianoid offline render → ESPRIT → ModalParams_synthetic
validator.compute_mac(measured, synthetic) → MAC matrix
validator.spectral_error(measured_ir, synthetic_ir) → dB error curve
```

---

## Key Reference Files

| File | Role |
|------|------|
| `RoomResponse/ESPRIT/esprit_core.py` | `ModalParameters` dataclass (source of truth) |
| `PianoidBasic/Pianoid/Mode.py` | `Piano_mode`, `fit_params()` — frequency/decrement/mass |
| `PianoidBasic/Pianoid/Pitch.py` | Deck coupling matrices, `pack_deck()` |
| `PianoidBasic/Pianoid/bytestream_encoding.py` | `encode_for_json()` / `decode_from_json()` for preset serialization |
| `PianoidCore/presets/IversPond_ESPRIT_128modes.json` | Reference preset with ESPRIT-derived modes |
