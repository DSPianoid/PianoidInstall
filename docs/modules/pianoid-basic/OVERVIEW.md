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
        Mode.py              # Piano_mode, ModeMap
        StringMap.py         # StringMap
        PianoMeasure.py      # PianoMeasure
        PianoidSimulation.py # PianoidSimulation
        HarmonicSimulator.py # HarmonicSimulation
        SoundChannels.py     # ModeSoundChannels
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
| `excitation_factor` | 8 | Duration of a hammer excitation in milliseconds |
| `level_indices` | [0,31,63,95,127] | MIDI velocity breakpoints for Gauss interpolation |
| `num_modes` | 0 | Actual resonator modes in preset |
| `num_modes_for_model` | 0 | Modes padded to a multiple of `num_blocks()` |
| `buffer_size` | 2 | Audio output circular buffer depth |
| `listen_to_modes` | False | Whether sound channels receive mode output |

Key methods:

- `dt()` — time step per string sub-iteration: `1 / (sr * string_iteration)`
- `cycle_duration()` — duration in microseconds of one full mode+string cycle
- `num_iterations()` — total sub-steps per cycle: `string_iteration * mode_iteration`
- `excitation_length()` — length of the excitation array in sub-steps
- `set_num_modes(n)` — sets `num_modes` and rounds `num_modes_for_model` up to the next multiple of `num_blocks()`
- `pack_as_dict_for_cuda()` — serialises all parameters for the CUDA kernel call
- `pack()` — serialises the named parameter set for JSON preset files

---

### StringGeometry

File: `StringBlock.py`

Describes the spatial discretisation of one piano string. A string has three sections: **main** (speaking length), **tail** (beyond the bridge), and a 2-point **stem** (`STEM_LENGTH = 2`).

| Attribute | Meaning |
|---|---|
| `length` | Physical length of the main section (metres) |
| `main` | Number of spatial points in main section |
| `tail` | Number of spatial points in tail section |

Key methods:

- `dx()` — spatial step: `length / main`
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
| `volume_coefficient` | 1 | Output scaling |
| `damper_string` | 0.5 | Damper stiffness on string |
| `damper_tail` | 127 | MIDI velocity below which damper is active |

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
| `position` | Strike position along main string (metres) |
| `width` | Contact width (metres) |
| `sharpness` | Curvature parameter in [0, 1] |
| `hammer_shape` | Numpy array of length `p_full()` — computed spatial envelope |

The circular profile computes a circular-arc cross-section: `sqrt(R^2 - (x-center)^2) - R + m` where R is the arc radius derived from `width` and `sharpness`. Width is clamped to a minimum of 3*dx to avoid numerical aliasing. The `pack()` method converts position, width, sharpness, and radius to dimensionless ratios for the CUDA kernel.

---

### Pitch

File: `Pitch.py`

The central aggregate for one piano key. Owns geometry, physical parameters, excitation, the deck matrices, and the set of string IDs.

| Attribute | Meaning |
|---|---|
| `pitch` | MIDI note number 0–127; 128–139 are sound output channels |
| `geometry` | `StringGeometry` instance |
| `physics` | `PhysicalParameters` instance |
| `excitation` | `ExcitationParameters` instance |
| `stringIDs` | List of integer string IDs assigned to this pitch |
| `deck['feedin']` | Length-`num_modes` array: string-to-mode coupling weights |
| `deck['feedback']` | Length-`num_modes` array: mode-to-string coupling weights |
| `tension_offset` | Per-string detuning step (fractional) for chorus effect |

Key methods:

- `get_coefficients(damper)` — computes c0,c1,c2,cb,cf,c2dec from physics
- `pack_params_for_string(stringId)` — returns flat dict for one string (passed to CUDA)
- `calculate_force()` — accumulates bridge force across all strings, weighted by `deck['feedin']`
- `set_feedback(mode_positions)` — applies `deck['feedback']` dot `mode_positions` to all strings

---

### GaussCurve and ExcitationCurve

File: `StringExcitation.py`

Model the velocity-dependent hammer force waveform as a sum of Gaussian pulses.

**GaussCurve** — one Gaussian component:

| Parameter | Meaning |
|---|---|
| `mu` | Peak time in milliseconds (within the excitation window) |
| `sigma` | Width (spread) of the Gaussian |
| `volume` | Peak amplitude |
| `shift` | Vertical offset as a fraction of volume (shifts baseline) |

**ExcitationCurve** — a sum of `NUM_GAUSS = 5` GaussCurves for one velocity level.

**ExcitationParameters** — manages the full excitation model for one pitch:

- `levels_matrix` — shape `(128, 4, 5)` — axes: [velocity_level, param_index, gauss_component]. Param indices: 0=mu, 1=sigma, 2=volume, 3=shift
- Five base velocity levels (`LEVEL_INDICES = [0, 31, 63, 95, 127]`) are stored directly; `recalculate_excitation_matrix()` extracts these 5 rows and calls `extrapolate()` to linearly interpolate between breakpoints, producing all 128 levels
- `calculate(velocity)` — returns shape `(excitation_factor, num_iterations())` — the excitation time series reshaped for the CUDA kernel indexing. Applies `cut_negative=True` which clips the **total sum** of all 5 Gaussians (post-summation ReLU). Note: the GPU `gaussKernel` applies ReLU per-component before summation — the GPU formula is the one used in actual synthesis
- `pack_gauss_params()` — flattens the entire 128-level matrix via `levels_matrix.ravel().tolist()`. GPU layout per velocity level: `[mu×5, sigma×5, volume×5, shift×5]` (20 reals). Total per pitch: 128 × 20 = 2,560 reals
- `volume_coefficients` — shape `(5,)` — per-base-level volume scaling. Applied to the volume row when `pack_gauss_params(volume_coefficients=True)` is called (multiplied before extrapolation)

The extrapolation scheme: 5 base curves × 5 Gauss components = 25 parameter sets; these are linearly interpolated to produce 128 complete curves covering the full MIDI velocity range.

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
- `pack_deck()` — assembles `feedin` and `feedback` matrices (shape: `num_strings × num_modes`) for CUDA
- `pack_excitations()` — flattens all 128-level Gauss parameter matrices in string-index order
- `update_hammer_shapes()` — recomputes all hammer spatial profiles after a geometry change

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
| `LEVEL_INDICES` | [0,31,63,95,127] | Base MIDI velocity breakpoints |
| `K_OMEGA` | 4*pi^2 | Factor in mode omega calculation |
| `MIN_INTERSTRING_INTERVAL` | 2 | Guard points between strings in a block |
| `STRING_PARAMS_NO` | 16 | Number of physical parameters per string for CUDA |
| `CLOSED` | 127 | Damper-open sentinel value |
