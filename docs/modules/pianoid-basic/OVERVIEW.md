# PianoidBasic — Module Overview

## Package Purpose

`PianoidBasic` is a Python library that provides the **domain model for piano physical parameters and simulation**. It defines the data structures, physical equations, and simulation logic for a piano string synthesiser driven by real acoustic physics. The package is consumed by PianoidCore's CUDA engine and Flask middleware: the Python objects are packed into flat arrays that are passed to GPU kernels for real-time signal synthesis.

---

## Version and Package Structure

- **Package name:** `Pianoid`
- **Version:** `0.1.13` (from `setup.py`)
- **Author:** Pianoid Ltd (`astrinleonid@digitalstringspiano.com`)
- **Python requirement:** >=3.6
- **Core dependencies:** numpy, pandas, librosa, matplotlib, tqdm, PyYAML, simpleaudio

Directory layout:

```
PianoidBasic/
    setup.py                 # Build script with import-rewrite mechanism
    pyproject.toml           # Build backend declaration
    Pianoid/
        __init__.py          # Public API surface
        constants.py         # Shared numeric constants
        ModelParams.py       # ModelParameters
        StringBlock.py       # StringGeometry, StringBlock
        StringState.py       # StringState (wave equation solver)
        PhysicalParameters.py# PhysicalParameters
        Hammer.py            # PianoHammer
        Pitch.py             # Pitch
        StringExcitation.py  # GaussCurve, ExcitationCurve, ExcitationParameters
        excitation_retime.py # R3: re-time a preset's excitation curves per pitch (contact / period law)
        Mode.py              # Piano_mode, ModeMap
        StringMap.py         # StringMap
        PianoMeasure.py      # PianoMeasure
        PianoidSimulation.py # PianoidSimulation
        HarmonicSimulator.py # HarmonicSimulation
        SoundChannels.py     # StringSoundChannels, ModeSoundChannels
        fpga_tables.py       # FPGA preset tables + host send-all formulas (FPGA-side semantics)
        fpga_string_layout.py # FPGA string layout + string physics on the GPU grid
        fpga_preset_converter.py # FPGA folder + Pitch.txt -> GPU preset JSON (the FPGA import path + CLI)
        fpga_conversion_metadata.py # conversion metadata (UNCONFIRMED inputs, dropped fields) + report
        mode_extension.py    # synthetic N-mode extension of a preset (4000-modes T2): fit + synthesis + flat-tier embedding
        mode_extension_report.py # its validation (hold-out, seam, validity) + sidecar report (JSON + PNG)
        synthetic_modes.py   # CLI: python -m Pianoid.synthetic_modes --source S --n N --seed K --out O
        bytestream_encoding.py
        chart_animation.py
        utilities.py
        sound_measurements.py
        quick_start.py
```

---

## Import Rewrite Mechanism

Each module contains a guarded block:

```python
# Package imports
from ModelParams import ModelParameters
# End of package imports
```

`setup.py` scans all `.py` files at build time. Before calling `setup()`, it converts every bare `from X import Y` inside the guarded block to `from .X import Y` (relative), then restores bare imports after the build finishes via a `CustomBuildCommand` context manager. This lets developers run individual files directly with `python Mode.py` while still producing a correctly-importable installed package.

---

## Public API (`__init__.py`)

```python
from .bytestream_encoding import *
from .chart_animation import *
from .constants import *
from .utilities import *

from .Hammer import PianoHammer
from .Mode import Piano_mode, ModeMap
from .ModelParams import ModelParameters
from .PhysicalParameters import PhysicalParameters
from .PianoidSimulation import PianoidSimulation
from .PianoMeasure import PianoMeasure
from .Pitch import Pitch
from .StringBlock import StringGeometry, StringBlock
from .StringExcitation import ExcitationParameters
from .StringMap import StringMap
from .StringState import StringState
```

---

## Class Reference

### ModelParameters

File: `ModelParams.py`

Global simulation configuration. Holds the parameters that determine how the CUDA kernel is sized and how the time-stepping is structured.

| Attribute | Default | Meaning |
|---|---|---|
| `mode_iteration` | 48 | Number of mode solver steps per audio cycle |
| `string_iteration` | 12 | Number of string wave-equation steps per audio sample |
| `sr` | 48000 | Audio sample rate (Hz) |
| `array_size` | 384 | Max number of spatial points per string block |
| `num_strings_in_array` | 2 | Strings packed side-by-side in one block |
| `excitation_factor` | 8 | Excitation window in segments of one cycle (`mode_iteration/sr`: 1.333 ms at 64/48 kHz, so 10.7 ms; the GPU writes the first 7) — not milliseconds |
| `level_indices` | [0,5,31,63,95,127] | MIDI velocity breakpoints for Gauss interpolation (6 levels) |
| `num_modes` | 0 | Actual resonator modes in preset |
| `num_modes_for_model` | 0 | Modes padded to a multiple of `num_blocks()` |
| `buffer_size` | 2 | Audio output circular buffer depth |
| `listen_to_modes` | False | Whether sound channels receive mode output |
| `string_gain_model` | `"physical"` | Excitation-coefficient string gain (see [string_gain](#string_gain-physical-string-gain)): `"physical"` (also for presets without the field) or `"legacy"` (the pre-2026-10 coefficients, bit-identical). Persisted |
| `unison_split_exponent` | 1.0 | `k` of the unison split `(n_ref/n)^k` in physical mode: 1 = physics (momentum shared), 0.5 = FPGA legacy `shape_256` ÷√n, 0 = no split. Range [0, 1], fail-fast. Persisted |
| `string_gain_reference` | `None` | `R` = ρ·dx² [kg·m] of pitch 60, frozen at the first physical-mode build and persisted; `None` = derive on build |

Key methods:

- `dt()` — time step per string sub-iteration: `1 / (sr * string_iteration)`
- `cycle_duration()` — duration in microseconds of one full mode+string cycle
- `num_iterations()` — total sub-steps per cycle: `string_iteration * mode_iteration`
- `excitation_length()` — length of the excitation array in sub-steps
- `set_num_modes(n, num_modes_for_model=None)` — sets `num_modes` and rounds `num_modes_for_model` up to the next multiple of `num_blocks()`; an explicit `num_modes_for_model` (the engine passes `num_strings`) smaller than `n` raises `ValueError` ("this engine cannot load it", dev-675e) instead of the former `NoneType`/`IndexError` deep in `pack_deck`
- `pack_as_dict_for_cuda()` — serialises all parameters for the CUDA kernel call
- `pack()` — serialises the named parameter set for JSON preset files

---

### StringGeometry

File: `StringState.py`

Describes the spatial discretisation of one piano string. A string has three sections: **main** (speaking length), **tail** (beyond the bridge), and a 2-point **stem** (`STEM_LENGTH = 2`).

| Attribute | Meaning |
|---|---|
| `length` | Physical length of the main section (metres) |
| `main` | Number of spatial points in main section |
| `tail` | Number of spatial points in tail section |

Key methods:

- `dx()` — spatial step: `length / main`; returns the sentinel `0.001` when `tail == 0` (the dummy output strings), so a real string needs `tail ≥ 1`. Measured (dev-a480): a string vibrates over `main − 1` points
- `p_full()` — total points: `main + tail + STEM_LENGTH`
- `l_main()`, `l_tail()`, `l_full()` — physical lengths of each section
- `bridge(i)` — index of bridge point `i` (0 or 1)
- `bridge_range()` — `[bridge(0), bridge(1)+1]`
- `bridge_coupling(part)` — coupling index for main or tail side

---

### StringState

File: `StringState.py`

The wave-equation time-stepper for a single string. Maintains a triple-buffer (`array` of shape `(3, length)`) for previous, current, and next displacement values, plus a second triple-buffer for the dispersive-decay second-derivative term.

**Wave equation coefficients** stored on each instance:

| Coefficient | Physical meaning |
|---|---|
| `c0` | Central-time coefficient: `2(1 - c_tension + 6*c_bending) * dec_inv` |
| `c1` | Nearest-neighbour spatial coefficient: `(c_tension - 8*c_bending) * dec_inv` |
| `c2` | Next-nearest-neighbour (bending stiffness): `2 * c_bending * dec_inv` |
| `cb` | Previous-time coefficient (decay): `(gamma*dt - 1) * dec_inv` |
| `cf` | Force coupling coefficient: `dt^2 * dec_inv` |
| `c2dec` | Dispersive-decay second-difference coefficient |

Where:
- `c_tension = (tension/rho) * dt^2 / dx^2`
- `c_bending = jung * (r^4 * pi / 4 / rho) * dt^2 / dx^4`
- `dec_inv = 1 / (1 + gamma*dt)` (viscous damping normalisation)

The `iteration()` method advances the wave equation `string_iteration` times per call. Each sub-step implements:

```
u_next = c0*u_cur + cb*u_prev
       + c1*(u_cur[i-1] + u_cur[i+1])
       + c2*(u_cur[i-2] + u_cur[i+2])
       + cf * excitation[t] * hammer_shape
       + dispersive_decay_term
```

The bridge points are then overwritten with the soundboard feedback value, and the bridge-coupling force is accumulated.

Key state attributes:

| Attribute | Meaning |
|---|---|
| `array` | Shape `(3, length)` — triple-buffer for displacement |
| `pointer` | `CircularPointer(3)` indexing prev/cur/next |
| `_2der` | Triple-buffer for second-derivative (dispersive decay) |
| `excitation` | 1-D array of length `excitation_length()` |
| `hammer_shape` | Spatial envelope of hammer contact |
| `feedback` | Scalar soundboard displacement fed back at bridge |
| `sound` | List of bridge samples collected each cycle |

---

### PhysicalParameters

File: `PhysicalParameters.py`

Holds the physical material constants for a pitch and manages the associated `PianoHammer`.

| Attribute | Default | Meaning |
|---|---|---|
| `tension` | 300 | String tension (N) |
| `rho` | 0.007 | Linear mass density (kg/m) |
| `r` | 0.0005 | String radius (m) |
| `jung` | 19000 | Young's modulus coefficient |
| `gamma` | 0.1 | Viscous damping coefficient |
| `disp_decay` | 0 | Dispersive-decay amplitude |
| `volume_coefficient` | *(removed)* | Removed from `set_params()`. Volume characteristics are embedded in excitation curves via `volume_coefficients` |
| `damper_string` | 0.5 | Damper stiffness on string |
| `damper_tail` | 127 | Tail damper: real multiplier on `damper_string` on the string tail (tail decrement = `damper_string · damper_tail`); see SYNTHESIS_ENGINE "Damper multiplier" |

Key methods:

- `pack(offset)` — flattens all parameters for CUDA, applying a tension detuning offset
- `pack_for_saving()` — produces a JSON-serialisable dict including hammer state
- `set_hammer(**params)` — delegates to `PianoHammer.set_params()`

---

### PianoHammer

File: `Hammer.py`

Computes the spatial envelope of a hammer strike on the string grid.

| Attribute | Meaning |
|---|---|
| `shape` | Profile function: `'circular'` (default) or `'parabolic'` |
| `position` | Strike position along main string (metres, in memory). **Preset JSON / `pack()` store `hammer_position` as a RATIO of `l_main`** (`unpack` multiplies by `l_main`) |
| `width` | Contact width (metres, also in the preset JSON) |
| `sharpness` | Curvature parameter in [0, 1] |
| `hammer_shape` | Numpy array of length `p_full()` — computed spatial envelope |

The circular profile computes a circular-arc cross-section: `sqrt(R^2 - (x-center)^2) - R + m` where R is the arc radius derived from `width` and `sharpness`. Width is clamped to a minimum of 3*dx to avoid numerical aliasing. The `pack()` method converts position, width, sharpness, and radius to dimensionless ratios for the CUDA kernel.

---

### Pitch

File: `Pitch.py`

The central aggregate for one piano key. Owns geometry, physical parameters, excitation, the deck matrices, and the set of string IDs.

| Attribute | Meaning |
|---|---|
| `pitch` | MIDI note number 0–127 (piano keys); 128–139 are output pitches (soundboard receiver points) |
| `geometry` | `StringGeometry` instance |
| `physics` | `PhysicalParameters` instance |
| `excitation` | `ExcitationParameters` instance |
| `stringIDs` | List of integer string IDs assigned to this pitch |
| `deck['feedin']` | Length-`num_modes` array: spatial coupling coefficients (string → mode). See [Coupling Coefficients](#coupling-coefficients) |
| `deck['feedback']` | Length-`num_modes` array: spatial coupling coefficients (mode → string). Equal to feedin by reciprocity |
| `tension_offset` | Per-string detuning step (fractional) for chorus effect |

Key methods:

- `get_coefficients(damper)` — computes c0,c1,c2,cb,cf,c2dec from physics
- `pack_params_for_string(stringId)` — returns flat dict for one string (passed to CUDA)
- `calculate_force()` — sums bridge force across all strings, multiplies element-wise by
  `deck['feedin']` → returns shape `(num_modes,)` force vector
- `set_feedback(mode_positions)` — computes `dot(deck['feedback'], mode_positions)` → scalar
  feedback, broadcasts to all strings via `string.set_feedback()`
- `update_deck(deck_params=None, values=None)` — sets feedin/feedback arrays from dict or
  per-mode value updates

Deck arrays are padded to `num_modes_for_model` with `ext_to_the_right()` (edge-padding)
during `pack_deck()` if shorter than the CUDA grid requires.

#### Coupling Coefficients

Each deck coefficient `deck[mode]` is a **normalised spatial coupling** value representing the
mode shape amplitude at that pitch's bridge position. Values range from 0 to 1, where 1 is the
spatial maximum for that mode across all bridge positions. This per-mode normalisation preserves
the spatial pattern (where on the bridge each mode couples most strongly) while keeping all modes
on the same scale. The mode's absolute amplitude is determined by its frequency, damping, and
mass parameters — the deck coefficient describes only the spatial shape.

By physical reciprocity (the coupling between a bridge point and a mode is the same in both
directions), `deck['feedback']` equals `deck['feedin']` for both regular and output pitches.

**Per-mode normalisation is mandatory.** When building a preset from measured data (FFT
magnitudes, ESPRIT coefficients, etc.), raw values must be normalised per mode before
injection. The algorithm:

```
coupling_matrix[pitch, mode] = raw FFT magnitude or ESPRIT coefficient
for each mode m:
    coupling_matrix[:, m] /= max(coupling_matrix[:, m])
```

Include **all** pitches in the normalisation pass — both excited (0–127) and output (128+) —
because a mode's spatial maximum may occur at a receiver point. Without this step, raw
magnitudes (typically 1e-4 to 1e-2 from FFT extraction) produce silent or near-silent output
because the synthesis engine expects 0–1 range coefficients.

#### Output Pitches (Receiver Points)

Pitches 128–139 are **output pitches** — virtual soundboard strings that represent physical
receiver/measurement points (accelerometers, microphones) on the soundboard. They do not
correspond to piano keys and are never excited by a hammer.

| Property | Regular Pitches (0–127) | Output Pitches (128–139) |
|----------|------------------------|--------------------------|
| Physical role | Piano keys (excitation points) | Soundboard receivers (observation points) |
| `deck['feedin']` | Spatial coupling: string bridge → modes | **Zero** (receivers don't excite modes) |
| `deck['feedback']` | Spatial coupling: modes → string bridge | Mode shape at receiver location |
| `outerSound` | 0 (no direct audio output) | `pitch - 127` (audio output channel index) |
| Excitation | Hammer force function | None |

In `listen_to_modes=0` (strings mode), audio output comes exclusively from output pitches.
Each output pitch's bridge displacement is driven by the sum of mode displacements weighted
by its feedback coefficients — this reproduces what a physical receiver at that location would
measure. The `string_sound_channels` coefficients scale the output per channel.

Each output pitch corresponds to one response channel from the measurement setup. The channel
mapping (`channel_to_sound`) assigns each measurement response channel to a specific output
pitch. For example, with 4 response channels, output pitches 128–131 each receive the feedback
pattern for one receiver location.

---

### GaussCurve and ExcitationCurve

File: `StringExcitation.py`

Model the velocity-dependent hammer force waveform as a sum of Gaussian pulses.

**GaussCurve** — one Gaussian component:

| Parameter | Meaning |
|---|---|
| `mu` | Peak time in x-units = segments of `mode_iteration/sr` (1.333 ms at 64 samples/cycle, 48 kHz; measured dev-da62) |
| `sigma` | Width (spread) of the Gaussian, same x-units as `mu` |
| `volume` | Peak amplitude |
| `shift` | Vertical offset as a fraction of volume (shifts baseline) |

**ExcitationCurve** — a sum of `NUM_GAUSS = 5` GaussCurves for one velocity level.

**ExcitationParameters** — manages the full excitation model for one pitch:

- `levels_matrix` — shape `(128, 4, 5)` — axes: [velocity_level, param_index, gauss_component]. Param indices: 0=mu, 1=sigma, 2=volume, 3=shift
- Six base velocity levels (`LEVEL_INDICES = [0, 5, 31, 63, 95, 127]`) are stored directly; `recalculate_excitation_matrix()` extracts these 6 rows and calls `extrapolate()` to linearly interpolate between breakpoints, producing all 128 levels. Legacy presets with 5 levels (`[0, 31, 63, 95, 127]`) are migrated automatically on load
- `calculate(velocity)` — returns shape `(excitation_factor, num_iterations())` — the excitation time series reshaped for the CUDA kernel indexing. Applies `cut_negative=True` which clips the **total sum** of all 5 Gaussians (post-summation ReLU). Note: the GPU `gaussKernel` applies ReLU per-component before summation — the GPU formula is the one used in actual synthesis
- `pack_gauss_params()` — flattens the entire 128-level matrix via `levels_matrix.ravel().tolist()`. GPU layout per velocity level: `[mu×5, sigma×5, volume×5, shift×5]` (20 reals). Total per pitch: 128 × 20 = 2,560 reals
- `volume_coefficients` — shape `(6,)` — per-base-level volume scaling. Applied to the volume row when `pack_gauss_params(volume_coefficients=True)` is called (multiplied before extrapolation)

The extrapolation scheme: 6 base curves x 5 Gauss components = 30 parameter sets; these are linearly interpolated to produce 128 complete curves covering the full MIDI velocity range.

---

### Piano_mode and ModeMap

File: `Mode.py`

**Piano_mode** — a damped harmonic oscillator representing one resonator mode of the piano soundboard.

Discrete-time state variables:

| Variable | Meaning |
|---|---|
| `state` | Current displacement of the oscillator |
| `state_1` | Previous displacement (one sample ago) |
| `dec` | Damping coefficient: `dt * decrement * frequency` |
| `omega` | Restoring force coefficient: `dt^2 * frequency^2 * 4*pi^2` |

**`frequency` is a small-angle parameter, not exactly the played Hz.** The recurrence below rotates by
`acos(1 − omega/2)` per sample (the roots are `(1 − dec)·e^(±iθ)`, `cos θ = 1 − omega/2`; `dec` does not shift θ),
so a mode plays `acos(1 − omega/2)·sr/(2π)` Hz — equal to `frequency` at low f, sharp by ≈ `(π f/sr)²/6`
(+1 c at 1 kHz, +100 c at 8.9 kHz, 48 kHz). To make a mode play `f_run` exactly, store
`frequency = (sr/π)·sin(π f_run/sr)` (`fpga_preset_converter.gpu_mode_frequency`, dev-f27f).

The `iteration(force)` recurrence:

```
result = (2*state - state_1 + state_1*dec - state*omega + force) * (1 - dec)
state_1 = state
state = result
```

Physical parameters (`mass`, `stiffness`, `damping`) are converted to `frequency` and `decrement` by `fit_params()`. Either set may be provided at construction.

**ModeMap** — ordered dictionary of `Piano_mode` objects indexed by integer ID.

- `load(mode_params, num_modes)` — creates modes from a list of parameter dicts
- `pack_modes(keep_state)` — serialises all mode states (state, state_1, dec, omega, mass) as flat lists for CUDA upload
- `modes_to_append()` — number of dummy padding modes needed to reach `num_modes_for_model`
- Dummy modes (ID = -1) are appended at pack time so the CUDA array is a fixed size
- `set_sound_channels(n)` — places the `n` sound-channel slots right after the modes (`mode_channel_index = num_modes`, `SoundChannels.get_index`); raises `ValueError` if they do not fit in `num_modes_for_model` slots. **Current-engine mode ceiling: `num_modes + num_channels ≤ num_strings`** (Belarus 220, F15 228; measured, dev-675e)

---

### StringBlock

File: `StringBlock.py`

Groups 2–4 `StringState` objects into one flat array of length `array_size` (default 384) that maps directly to a CUDA thread block.

| Attribute | Meaning |
|---|---|
| `ID` | Block index |
| `strings` | Dict mapping string ID to `StringState` |
| `state` | Shape `(2, array_size)` — packed prev and cur displacement arrays |
| `max_num_points` | Maximum spatial points per block (= `array_size`) |
| `max_num_strings` | Maximum strings per block (= `num_strings_in_array`) |
| `interval` | Gap of `MIN_INTERSTRING_INTERVAL = 2` guard points between strings |

Each string occupies a contiguous slice `[start, end)` within the block array. `pack_arrays()` copies individual string arrays into the block state before a CUDA call; `unpack_arrays()` writes results back.

---

### PianoMeasure

File: `PianoMeasure.py`

Defines the mapping from MIDI pitch number to string geometry parameters across the whole keyboard. Stored as a pandas DataFrame indexed by pitch, with columns: `length`, `dx`, `tail_ratio`, `tail`, `main`, `chore` (number of strings per note).

The default measure is generated by `form_default_measure()` which applies an exponential scaling law: string length decreases by factor `exponent` per semitone, with `tail_ratio` halving at specified pitch steps and the number of strings per note increasing from 1 to 3 at defined thresholds.

---

### StringMap

File: `StringMap.py`

Top-level container that owns all `Pitch` objects, all `StringState` objects, and all `StringBlock` objects for one loaded preset.

Key responsibilities:

- Assigns integer `stringID` values and places each `StringState` into the correct `StringBlock`
- Maintains `string_index` (ordered list of string IDs matching CUDA thread order) and `pitch_index`
- `generate_chores()` — builds the `chores` array: shape `(140, 3)`, mapping each MIDI pitch to up to 3 string numbers in the CUDA thread index
- `pack_parameters()` — returns all data needed for one CUDA kernel call: chores, block states, excitations, physics, hammers, volume, excitation cycle indices, damper open flags, string map
- `pack_output_mask()` — returns a flat per-string `[1.0/0.0]` list over `string_index`: `1.0` for strings of output/sound-channel pitches (`pitch >= 128`, the audio-output tap rows), `0.0` for piano-key strings (`0–127` resonance-coupling rows). Uploaded once at init (`pianoid.py:init_pianoid` → `devMemoryInit`) as the kernel's `dev_feedback_output_mask`, so the runtime feedback coefficient (`deck_feedback_coeff`) scales only piano-resonance feedback rows and leaves the output-tap rows unscaled (note audio survives `feedback=0`). Added with dev-d52b's proportional piano-only feedback coefficient. The classification is static per preset. **Build note:** this method is consumed by `init_pianoid` AND its result is passed as a new positional arg to the C++ `devMemoryInit`, so a tree updated to dev-d52b requires BOTH a fresh PianoidBasic wheel (for the method) AND a fresh `pianoidCuda` `.pyd` (for the matching `devMemoryInit` signature) — see [BUILD_SYSTEM.md — Post-Merge / Post-Pull Rebuild Gate](../../architecture/BUILD_SYSTEM.md#post-merge--post-pull-rebuild-gate).
- `pack_deck()` — assembles `feedin` and `feedback` matrices (shape: `num_strings × num_modes`) for CUDA
- `pack_excitations()` — flattens all 128-level Gauss parameter matrices in string-index order
- `update_hammer_shapes()` — recomputes all hammer spatial profiles after a geometry change
- `pack_excitation_factors()` / `compose_from_factors()` — the per-pitch excitation-coefficient factors
  `c · m · v · G / (temporal · spatial)`; `G = string_gain(pitch)` is the 6th (multiplying) factor
- `string_gain(pitchID)` — `G(p)` of a key pitch (1.0 in legacy mode); `ensure_string_gain_reference()` — called at the
  end of the constructor, freezes `mp.string_gain_reference` from pitch 60 in physical mode (no-op if the preset carries it)

---

### string_gain (physical string gain)

File: `string_gain.py` (dev-029c, 2026-10-04; [loudness-physics analysis](../../proposals/loudness-physics-deviation-analysis-2026-10-04.md) R1 + R2).
The engine integrates the string as `Δy = f·h·dt²` (no `1/(ρ·dx)`) and reads the bridge force as `T·Δy` (no `/dx`),
so its bridge force per unit hammer impulse carries a spurious per-pitch `ρ·dx²` (D1: 29–32 dB bass-over-treble), and
every unison string gets the full `c·m·v` with the bridge forces summed (D2: +9.5 dB for 3 strings). In
`"physical"` mode the host cancels both exactly (no kernel change, string dynamics untouched):

```
G(p) = R / (ρ(p)·dx(p)²) · (n_ref / n(p))^k        R = ρ·dx² of pitch 60 (frozen), n = len(pitch.stringIDs)
```

`ρ` is the pitch's `physics.rho`, `dx = geometry.dx()` (the GPU `dx` at the runtime grid, after the load-time
`array_size` rescale), `n` the struck strings. Pitch 60 is bit-identical to legacy at load, so `c` and the
p60-calibrated `output_scale` keep their meaning (the analytic output_scale re-derivation factor is exactly 1). `R` is
persisted, so a later ρ/length edit — even of pitch 60 — moves only the edited pitch (the granular physics path
recomposes that pitch's `string_gain`, PARAMETER_SYSTEM.md). The factor is a pitch constant, independent of curve
and hammer shape, so the impulse-conservation invariant holds: delivered impulse per string = `c·m·v·G`.
Reference pitch: 60, or the key pitch nearest to it in partial presets.

---

### excitation_retime (per-pitch pulse duration, R3)

File: `excitation_retime.py` (dev-da62, 2026-10-04; [loudness-physics analysis](../../proposals/loudness-physics-deviation-analysis-2026-10-04.md) D3 / R3).
The engine conserves the strike's impulse, but loudness at constant impulse follows the pulse duration τ relative to
the string period (`E ≈ J²/(2Z·τ)`, much less once reflections return during the contact), so τ(p) is per-pitch
**loudness data**. `retime_excitation(preset, law, k, tau_min_ms, tau_max_ms, pitches, reference_level, force)` is an
explicit, reproducible **preset-data operation** (src JSON → new JSON; never in place; no engine change):

```
s(p) = τ_target(p) / τ_now(p)        mu, sigma × s ;  volume × 1/s ;  shift unchanged   (all 128 levels)
```

| Item | Definition |
|---|---|
| τ | equivalent width (area / peak) of the GPU curve (`StringExcitation.gpu_force_curve`, written segments 0–6) at level 95, in ms; 1 x-unit = `mode_iteration/sr` (1.333 ms at 64/48 kHz) |
| `"contact"` (default) | grand-piano hammer–string contact duration, log-linear 4 ms (A0) → 0.7 ms (C8) (Askenfelt & Jansson, JASA 88(1) 1990 / 90(5) 1991; Fletcher & Rossing ch. 12), as a half-sine: `τ = (2/π)·τ_contact` |
| `"period"` | `clip(k·T0(p), tau_min_ms, tau_max_ms)`, T0 = 12-TET period (default k 0.4, 0.4–4 ms) |
| invariants | shape kept (time axis only); each curve's integral kept (`volume × 1/s`), so the delivered impulse `c·m·v·G` is unchanged (verified bit-level through the coefficient build); pitch and per-partial decay unchanged |
| guards | FPGA presets refused unless `force` (`preset["fpga_conversion"]`, or `excitation_provenance.converter` = the FPGA converter — the user requires exact FPGA parameters); scale-up capped so ≥ 1 − 10⁻³ of the curve stays in the 7-segment window; scale-down floored at 2 sub-steps per weighted Gaussian σ |
| output | `preset["excitation_retime"]` (law, parameters, per-pitch scale / limit, source), `output_scale_calibrated = false` (the level changed). Bake `output_scale` OFFLINE before a live load (`docs/development/diagnostics/dev-da62-bake-output-scale.py`) — never let the live backend render |

CLI: `python -m Pianoid.excitation_retime SRC.json DST.json [--law contact|period] [--k 0.4] [--pitches 21-108] [--force]`.
Demo: `PianoidCore/pianoid_middleware/presets/BaselinePreset1_retimed.json` (contact law, `output_scale` baked).

**Measured on BaselinePreset1** (equal 10 g masses, physical string gain, 384/si 4, v95, level rel. p60; evidence
`docs/development/diagnostics/dev-da62-renders/`): before, every curve is 3.28 ms wide → spread 31.9 dB (p95–p5 21.4), top
octave median −18.2 dB. `contact`: 26.3 dB (p95–p5 22.1), top octave −6.6 dB, bass (≤ p35) −18.3 dB; the merged dev-168c
equalizer + rescale then gives 0.97 / 2.36 / 20 g (min/median/max), **bass-heavy** (bass median 11.5 g vs treble 2.7 g;
before R3: 0.51 / 1.02 / 20 g, bass 1.5 g vs treble 2.5 g). `period` tilts the keyboard by ~+6…+8 dB/octave (at a
fixed τ/T0 the uptake still grows as 1/T0): k = 0.3/0.4/0.5 → 41.1/39.4/37.0 dB, so it is not the default. The
remaining spread is the bass (p21–35, already in the impulsive regime: τ ×0.73 → only +3.6 dB), i.e. not D3.
Timbre: shorter pulses brighten the attack (0–30 ms centroid +0.3…+0.6 oct) and the top octave (+0.25…+0.9 oct), but
DARKEN the mid sustain (−0.6…−1.3 oct, p48–84): the old 3.28 ms pulse (≈ T0 at middle C) suppressed the fundamental.

---

### SoundChannels

File: `SoundChannels.py`

Two classes manage the coupling between modes/strings and audio output channels.

**`ModeSoundChannels`** — per-pitch coefficients for the mode-based sound output path. Owned by `StringMap.soundChannelModes`. **Despite the class name, both coefficient stores are keyed by pitch — not channel — and only a subset of rows is consumed by the GPU kernel.** See "Stored vs effective entries" below.

| Attribute | Stored shape | Description |
|-----------|--------------|-------------|
| `coefficients` | `{pitchID: ndarray[num_channels]}` for **all** pitches `0..139` | Modes path: per-pitch mode-coupling coefficients injected into the feedin slots at `mode_channel_index`. Only consulted when `listen_to_modes=1` (modes mode); zeroed in strings mode |
| `string_coefficients` | `{pitchID: ndarray[num_channels]}` for **all** pitches `0..139` | Strings path: per-pitch gain that scales the mode→string feedback. Only consulted when `listen_to_modes=0` (strings mode) |

#### Stored vs effective entries (high-stakes data-model fact)

The two dicts above are **stored** for every pitch ID `0..139` (legacy Python convenience — `add_pitch` is called for every pitch as the StringMap builds), but the **effective** entries — the ones the CUDA kernel actually consumes — are a strict subset that depends on listen mode.

| Listen mode | Source store | Effective rows | Effective columns |
|---|---|---|---|
| `listen_to_modes=1` (modes) | `coefficients` | piano-pitch rows `0..127` (the rows that have non-zero `deck.feedin` and a hammer) | `[0..num_channels)` |
| `listen_to_modes=0` (strings) | `string_coefficients` | output-pitch rows `128..127+num_output_channels` (the soundboard receivers) | `[0..num_channels)` |

In strings mode the kernel-effective entries are **only** the output-pitch rows. Storing rows for piano pitches 0–127 in `string_coefficients` is harmless but inert — those rows do not influence the synthesised signal because piano pitches have no `outerSound` channel set (see `Pitch.outerSound` and `MainKernel.cu`'s `outerSoundChannel && isStem` guard, documented at `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "Audio Output").

**Practical consequence for fix authors and frontend editors.** The frontend strings-axis editor exposes a row per *output channel* (frontend index `0..N-1` after stripping the 128 offset), not a row per piano pitch. Each backend POST writes the row at backend pitch index `128 + channel_index`, which is the *only* row the kernel reads in strings mode. Editing piano-pitch rows of `string_coefficients` is a no-op at the audio level. Editing piano-pitch rows of `coefficients` (modes mode) is **not** a no-op — those rows feed the modes via the deck. Confusing the two cost dev-833f Phase A a wrong endpoint diagnosis (the agent thought `string_coefficients[60]` would influence pitch-60 output; it would not, because pitch 60 in strings mode has no output channel).

#### "Sound channel" vs "deck" — disambiguation

These two concepts are easy to confuse because both are per-pitch, both are length-`num_modes`-or-`num_channels` arrays, and both end up packed into the GPU `dev_deck_parameters` matrix. They are **not** the same thing:

| Concept | What it is | Where it lives | Per-pitch shape |
|---|---|---|---|
| `deck['feedin']` | Spatial mode-shape sample at this pitch's bridge position (string→mode coupling) | `Pitch.deck['feedin']` | `[num_modes]` |
| `deck['feedback']` | Spatial mode-shape sample at this pitch's bridge position (mode→string coupling, equal to feedin by reciprocity) | `Pitch.deck['feedback']` | `[num_modes]` |
| `mode_sound_channels` (a.k.a. `coefficients`) | Per-pitch coupling injected into the feedin slots reserved for mode channels — used to mix modes into output channels in modes-listen mode | `StringMap.soundChannelModes.coefficients[pitch]` | `[num_channels]` |
| `string_sound_channels` (a.k.a. `string_coefficients`) | Per-output-pitch gain scaling the strings-path feedback into each audio channel | `StringMap.soundChannelModes.string_coefficients[pitch]` | `[num_channels]` |

When the kernel reads `dev_deck_parameters`, it sees a single matrix that combines all four. Edit `Pitch.deck` and you change which modes a piano key excites; edit `mode_sound_channels` and you change which output channel hears those modes; edit `string_sound_channels` and you change the per-channel gain on the strings-path output. Mixing these up produces the kind of "no audible change" silence symptom seen in dev-833f.

Key methods:

| Method | Purpose |
|--------|---------|
| `add_pitch(pitchID)` | Initialise zero coefficients for both stores (called for every pitch 0..139) |
| `update_coefficients(pitches, target)` | Batch update; `target='mode'` or `'string'` selects which store |
| `read_from_preset(data)` | Load mode coefficients from preset JSON `mode_sound_channels` section |
| `read_string_coefficients_from_preset(data)` | Load string coefficients from preset JSON `string_sound_channels` section |
| `get_coeff(pitch)` / `get_string_coeff(pitch)` | Read coefficients for a single pitch |

**`StringSoundChannels`** — `num_channels × num_modes` matrix (not currently used in the GPU path; reserved for future string-level channel routing).

Preset JSON sections:
- `mode_sound_channels`: `{pitchID: [ch0, ch1, ...], ...}` — mode coupling coefficients (modes-listen path)
- `string_sound_channels`: `{pitchID: [ch0, ch1, ...], ...}` — string gain coefficients (strings-listen path; old presets default to `40.0` per channel). Only the output-pitch rows `128..127+num_output_channels` are kernel-effective

---

### PianoidSimulation

File: `PianoidSimulation.py`

Python-level (non-GPU) simulation driver. Loads a preset JSON, constructs `ModeMap` and `StringMap`, and runs the coupled string-mode iteration in pure Python for development and testing.

| Method | Purpose |
|---|---|
| `add_pitch(pitchID, volume)` | Activates a pitch and its strings for the next simulation run |
| `iterate(dur)` | Runs the simulation for `dur` seconds at sample rate |
| `iteration()` | Advances all strings one cycle, computes mode forces, updates modes, distributes feedback |
| `get_sound()` | Returns the soundboard feedback record as a numpy array |
| `animate(pitchID)` | Live matplotlib animation of string displacement |
| `play()` | Plays the synthesised sound via `simpleaudio` |

The coupling loop per cycle:
1. Advance all `StringState` objects (`string.iteration()`)
2. Sum per-pitch bridge forces weighted by `deck['feedin']` to produce mode force vector
3. Step each `Piano_mode` oscillator with its force component
4. Apply mode displacement vector back to each pitch via `deck['feedback']`

---

### HarmonicSimulation

File: `HarmonicSimulator.py`

A separate additive synthesis engine for testing. Generates sound as a sum of `Harmonic` objects, each defined by `frequency`, `amplitude`, `phase`, `decay`, and `delay`. Does not use the wave-equation model. Used via `PianoidSimulation.load_params_harmonics()` and `PianoidSimulation.generate_with_harmonics()`.

---

### FPGA preset converter

Files: `fpga_tables.py`, `fpga_string_layout.py`, `fpga_preset_converter.py`, `fpga_conversion_metadata.py`
(dev-a480, 2026-10-01). The **single FPGA import path** (the middleware's `load_excitation_from_fpga_preset`
delegates here; the legacy readers `read_excitations_from_txt`, `Mode.load_modes_from_txt` and
`Pianoid.load_deck_from_txt` were removed). Spec: [FPGA → GPU port proposal §11–§12](../../proposals/fpga-to-gpu-preset-port-2026-09-30.md).

| Module | Concern |
|---|---|
| `fpga_tables` | Read the FPGA `.txt` tables; the host program's send-all formulas (forwarded verbatim by the stm32), each a pure function citing its `Pianoid_QM.c` / `pianoid.c` line |
| `fpga_string_layout` | F_15's strings on the GPU grid: points per string, blocks = the FPGA arrays, and physics whose kernel coefficients equal the FPGA string update term by term |
| `fpga_preset_converter` | Excitation, modes, deck/output mapping and the CLI `python -m Pianoid.fpga_preset_converter FPGA_DIR PITCH_TXT --template T --out O` |
| `fpga_conversion_metadata` | Describe a conversion: `preset["fpga_conversion"]` (DERIVED / UNCONFIRMED / OVERRIDDEN inputs, load params, template fallbacks used, dropped fields) and the `<out>.conversion_report.md` |

**Strings (F_15's own).** Each GPU block is one FPGA 512-point array (57 arrays × 4 strings + 1 output
block = 232 strings), so the preset is loaded with **`array_size=512`** (a runtime `/load_preset` parameter,
384–512; `MAX_ARRAY_SIZE = 512` is compile-time, no rebuild) and **`string_iteration=16`** (48 kHz × 16 = the FPGA
string step exactly). Per key:
`N_eff = N − (int)shteg − 21.1` (speaking offset fitted to F_15 with the exact clamped FPGA scheme), GPU
`main = round(N_eff + 1)` (the engine vibrates `main − 1` points — measured), `tail = max((int)shteg, 1)`
(`StringGeometry.dx()` treats `tail == 0` as a dummy string). Tension, Young's modulus (negative: the kernel
adds `+2·cb·fd`, the FPGA `−Disp·fd`), `gamma`, `disp_decay`, `damper_string` and the `damper_tail` multiplier
are solved from the `Kernels.cu parameterKernel` formulas so that `coeff_tension = Tn`,
`coeff_bending = −Disp/2`, `coeff_frequency_decay = Disp_decr`, `dec = Do` (main), `Damper` (tail) and `Dc`
(released, `int(127^0.6) = 18` damper steps), each rate-scaled from the 512-clock FPGA step to the GPU
sub-step and grid-rescaled by `(main − 1)/N_eff`. Since dev-f2b8 (PianoidCore cc4b540) the kernel itself
multiplies the HF-damping and damper terms by `dt/dt_ref` (`dt_ref = 1/(48000·4)`), so `disp_decay` and
`damper_string` are written at that reference grid (factor `k_ref = dt_ref/dt_fpga = 4`, independent of the
sub-step count); `damper_tail` is the tail multiplier (rounded to an integer ≥ 1 so F15_Elyashev_array512 regenerates
identically; since dev-f27f the engine reads it as a real, so rounding is no longer required). Converted presets are written with `output_scale_calibrated = false` so the engine
re-derives `output_scale` on load. Unison: base `ttn − dt` with `tension_offset = dt/base`
gives exactly the FPGA set {ttn−dt, ttn, ttn+dt}. String length / rho / r stay template choices (only the
kernel products matter; for the LEVEL too only with the physical string gain). **String gain (dev-029c):** the converter
declares `string_gain_model = "physical"` (DERIVED: the FPGA reads the bridge force in its own words, `ff = Tn·sd`,
`Tn = T·dt²/(ρ·dx²)`, and injects the hammer force in displacement units — the physically scaled chain; the GPU's
`T·Δy` is `ρ·dx²/dt²` × that) and `unison_split_exponent = 0` (DERIVED: `send_all`'s `construct_molot` gives every
unison string the same peak-normalised cap shape, no division; the ÷√n exists only on the legacy `shape_256` path,
QM:15627–15637), and resets `string_gain_reference` to `None` (re-derived from the converted p60 on load). 16 sub-steps needs the summed-form float32 FDTD loop (PianoidCore 682a535,
dev-1e95; see SYNTHESIS_ENGINE "Numerical precision: float32 and string_iteration"): on the fixed engine
N = 4/8/12/16 are all stable on F_15 and 16 costs ~1.0 ms per 64-sample cycle offline (budget 1.333).

**Other mapping (exact since dev-f27f, "use all parameters exactly as in the FPGA preset").** Modes
`frequency` = the GPU field (`gpu_mode_frequency`, see Piano_mode above) of the frequency the FPGA oscillator
RUNS at, `acos(1 − W/2)/(2π·dt_mode)` with `W = int(4f²·omega_ratio)/2³¹` (`omega_coef` × the `omega_ratio` trim:
F_15 −38 c); before dev-f27f the converter stored `omega_coef` Hz, so the GPU played F_15's modes +42…+151 c
sharp of the FPGA. `mass_inv` ← `Mass/f²` (stm32 verbatim) × `n_m²`, `n_m = max_k |Ci_coef_cos[k, m]|` — the deck
rows are per-mode normalised, and with the GPU mode state `q_g = |FB|·n_m·q_fpga` the FPGA loop
`FB·Ci_str·Ci_cos·M` (F_15: `Ci_str = −Ci_cos` exactly) is reproduced iff `mass_inv ∝ n_m²·M` and the output rows
`∝ w/n_m` (F_15 `n_m²` spans 54 dB; before dev-f27f it was dropped). Absolute mass scale UNCONFIRMED
(`--mode-mass host_max`: strongest mode = template coupling, stable). Decrement `--mode-q host_q` (DERIVED:
exact FPGA decay rate `γ = −ln(1−D)/dt_mode`, `decrement = (1−e^(−γ/sr))·sr/frequency`). Deck: `Ci_coef_cos`
per-mode normalised, signed, feedback = feedin. Output pitches: FPGA outputs `decka × out_vol × Ci_str_1_out / n_m`.
Tail damper: `damper_tail` = the real ratio `(Damper − Do)·k_ref/damper_string` (no rounding; tail decrement
exact to 2e-16). Excitation: `mu ← d`, `sigma ← e`,
96-clock exciter step, Gaussians 0–3, the 6 engine anchors (stored == effective); the FPGA timing is decoded
in ms and stored in curve x-units `ms / x_unit_ms` (`x_unit_ms = 1000·mode_iteration/sr` of the template, 1.333 ms at
64/48 kHz; `StringExcitation.curve_x_unit_ms`; `fpga_conversion.excitation.x_unit_ms`, `load_params.samples_in_cycle`)
— before dev-da62 (2026-10-05) the ms were stored 1:1 and every FPGA pulse played ×1.333 long (GPU readback, F15 p21:
centres 8.12/2.17/0.84/4.79 ms → now the FPGA 6.09/1.63/0.63/3.59 ms; window 7 segments = 9.33 ms, truncation 9e-11); loudness
`ind_vol × Strength_graph × ∫force` → rank-1 `hammer_mass × hammer_speeds`.

**Verified (offline, `array_size=512`, 16 sub-steps, engine 682a535):** 16 keys (all A, all C) vs
`Notes_freqs` median −1.1 c, IQR −7.0…+3.3 c; vs the FPGA scheme's own prediction median −1.0 c, max 7.8 c
(A1, comb detector). Re-verified after the dev-f27f exactness changes (regenerated F15_Elyashev_array512):
pitch vs the FPGA prediction A1 −7.9 / C4 −1.0 / C7 −0.8 c (unchanged), 0 non-finite; bare synthesis level
62–83 dB below the Belarus template (was 14–39 dB; the exact relative loop gains leave most modes far below the
capped strongest one) — the per-preset `output_scale`, re-derived on load, restores the playback level.
Evidence: `docs/development/diagnostics/dev-a480-renders/summary.md`, `dev-f27f-renders/summary.md` §7.


---

### Synthetic mode extension (4000-modes campaign T2)

Files: `mode_extension.py` (generator), `mode_extension_report.py` (validation + report), `synthetic_modes.py` (CLI)
— dev-675e, spec [proposal §R.4](../../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md).

```
python -m Pianoid.synthetic_modes --source Belarus_8band_196modes.json --n 560 --seed 0 --out OUT.json
    [--f-max HZ] [--fit-from 10] [--keep-real K] [--report-dir DIR] [--no-report]
```

Keeps the source's real modes and extends to N (source untouched; same inputs + seed → byte-identical file):

| Modes (sorted by played Hz) | Content | Deck columns |
|---|---|---|
| `[0, 56)` shaped (decision Q3) | source mode dicts verbatim (+ `tier`, `synthetic: false`) | verbatim |
| `[56, n_real)` real flat | real `frequency` / `decrement`; `mass` = `a(m)² · mass_inv`, `flat_gain` = `a(m)` | piano rows 1.0 (feedin = feedback); output rows: feedin 0, feedback `w_c` |
| `[n_real, N)` synthetic flat (`synthetic: true`) | drawn from the fitted laws | as real flat |

- **Flat tier (proposal R.2):** `a(m)` = least-squares uniform fit of the column over the kernel's piano rows (one row
  per string) = the column mean; with feedin = feedback the loop gain `a²` folds into `mass_inv`. Output readout
  `w_c` per output pitch = LSQ fit of the real flat readout row (`Σ out·a / Σ a²`) — **provisional** (R.2 open item;
  stored in `mode_extension.flat.output_readout_weights`). This embedding is exact for the flat model, so a preset with
  N ≤ the current ceiling renders the 56-shaped / rest-flat instrument on today's engine (the T3 exactness test).
- **Laws (fit band = real modes ≥ `fit_from`, played Hz):** density `N(f) ∝ f^α` (mid-rank count, anchored at the
  last real mode); `ln Q` and `ln mass_inv'` linear in `ln f` with log-normal residuals (σ from the fit, draws clipped
  at ±3σ), level anchored at the seam (`seam_offset` = median residual of the top 15 band modes). Synthetic
  frequencies `N⁻¹(k + 0.5 + u)`, `|u| < 0.35` (≥ 0.3 count apart); `decrement` from Q via the converter's decay law;
  `frequency` = `gpu_mode_frequency(f_played)`; synthetic `mass` capped at the strongest real flat mode.
- **Infeasible N fails loudly** (`ModeExtensionError`, CLI exit 2, prints the achievable N) — spacing is never compressed.
  **Measured 2026-10-09:** Belarus_8band_196modes reaches only **N = 560** below 20 kHz (α = 0.78), F15_Elyashev_array512
  **N = 321** (α = 0.60) — N = 4000 is not reachable from either source under this rule.
- `mode_extension` block in the preset: source name + sha256 (+ `mode_order` if the source was unsorted — F15 has 54
  exact duplicate frequencies on the FPGA grid, kept), seed, f_max, index ranges, fitted laws, achievable N, flat
  gains/readout, `current_engine.{ceiling_num_modes, loadable}`. `output_scale` is inherited, not re-derived (T4).
- Sidecar report `<out-stem>.mode_extension_report.{json,png}`: hold-out (fit on the lower half of the real flat
  band, predict the upper half: count error at the held-out f_max, KS / quantile errors of the Q and mass residuals),
  seam continuity (detrended rolling-window step vs the real scatter), physical validity; thresholds recorded in the
  report. Results (hold-out / seam numbers): [proposal §R.4.5](../../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md#r45-implementation-status-2026-10-09-dev-675e); report files + plots in `docs/development/diagnostics/dev-675e-synthetic-modes/`.

---

## ASCII Class Hierarchy

```
ModelParameters
    |
    +-- used by --> Piano_mode
    |                   |
    |               ModeMap (collection of Piano_mode)
    |
    +-- used by --> StringState
    |                   |
    |               StringBlock (packs 2-4 StringStates)
    |
    +-- used by --> ExcitationParameters
                        |
                        +-- ExcitationCurve (5 per level)
                                |
                                +-- GaussCurve (5 per curve)

StringGeometry
    |
    +-- used by --> PhysicalParameters
    |                   |
    |               PianoHammer
    |
    +-- used by --> StringState

Pitch
    owns --> StringGeometry
    owns --> PhysicalParameters (+ PianoHammer)
    owns --> ExcitationParameters
    owns --> deck { feedin[], feedback[] }
    references --> StringState objects (by ID)

StringMap
    owns --> { pitchID: Pitch }
    owns --> { stringID: StringState }
    owns --> [ StringBlock ]
    reads --> PianoMeasure

PianoidSimulation
    owns --> ModelParameters
    owns --> ModeMap
    owns --> StringMap
```

---

## Key Constants (constants.py)

| Constant | Value | Meaning |
|---|---|---|
| `STEM_LENGTH` | 2 | Guard points added to each end of string array |
| `NUM_GAUSS` | 5 | Gaussian components per excitation curve |
| `NUM_PARAMS_GAUSS` | 4 | Parameters per Gaussian: mu, sigma, volume, shift |
| `LEVEL_INDICES` | [0,5,31,63,95,127] | Base MIDI velocity breakpoints (6 levels) |
| `K_OMEGA` | 4*pi^2 | Factor in mode omega calculation |
| `MIN_INTERSTRING_INTERVAL` | 2 | Guard points between strings in a block |
| `STRING_PARAMS_NO` | 16 | Number of physical parameters per string for CUDA |
| `CLOSED` | 127 | Damper-open sentinel value |
