# Pianoid Parameter Flow: Complete System Analysis

**Document Version:** 2.0
**Date:** 2025-10-12
**Purpose:** Comprehensive analysis of parameter flow from frontend to CUDA core via middleware
**Status:** Analysis complete - Ready for refactoring

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Parameter Categories](#parameter-categories)
3. [System Architecture Overview](#system-architecture-overview)
4. [Preset File Structure](#preset-file-structure)
5. [Frontend Layer (backendServer.py)](#frontend-layer-backendserverpy)
6. [Middleware Layer (pianoid.py)](#middleware-layer-pianoidpy)
7. [PianoidBasic Library (StringMap, ModeMap)](#pianoidbasic-library-stringmap-modemap)
8. [CUDA Core Layer (Pianoid.cu)](#cuda-core-layer-pianoidcu)
9. [Complete Parameter Flow Diagrams](#complete-parameter-flow-diagrams)
10. [Issues and Refactoring Opportunities](#issues-and-refactoring-opportunities)
11. [Recommended Refactoring Plan](#recommended-refactoring-plan)

---

## Executive Summary

### System Overview

PianoidCore implements a physical modeling piano synthesizer with **four main parameter categories**:

1. **String/Pitch Parameters** - Physical properties (tension, stiffness, damping, geometry)
2. **Hammer/Excitation Parameters** - Spatial (hammer shape) and temporal (Gaussian excitation curves)
3. **Mode Parameters** - Modal synthesis oscillators (frequency, decrement, mass, state)
4. **Deck Parameters** - String-mode coupling coefficients (feedin/feedback matrices)

### Current State

The parameter flow spans **4 layers**:
- **Frontend**: Flask REST API ([backendServer.py](backendServer.py))
- **Middleware**: Python orchestration ([pianoid.py](pianoid.py))
- **Domain**: PianoidBasic library (StringMap, ModeMap, Pitch classes)
- **CUDA**: GPU-accelerated synthesis ([Pianoid.cu](Pianoid.cu))

### Key Findings

**Strengths:**
- Well-defined separation between string physics and modal synthesis
- Thread-safe CUDA parameter updates with `cuda_lock`
- Comprehensive parameter packing/unpacking system

**Critical Issues:**
1. **Inconsistent parameter update paths** - Multiple methods for similar operations
2. **Redundant data transformations** - Parameters packed/unpacked multiple times
3. **Unclear ownership** - Ambiguous responsibility between StringMap and Pianoid classes
4. **Limited validation** - No systematic parameter range checking
5. **Memory allocation mismatch** - Mode state allocates 6 fields but only uses 4
6. **Missing abstractions** - No unified parameter interface

---

## Parameter Categories

### 1. String/Pitch Parameters

**Purpose:** Define physical properties of each piano string

**Components:**

| Parameter | Type | Source | Description |
|-----------|------|--------|-------------|
| `tension` | float | Preset → Pitch | String tension coefficient |
| `tension_offset` | float | Runtime | Detuning adjustment |
| `stiffness` | float | Preset → Pitch | String stiffness (inharmonicity) |
| `damping` | float | Preset → Pitch | Energy dissipation rate |
| `rho` (density) | float | Preset → Pitch | Linear mass density |
| `length` | int | Preset → Pitch | String length in discrete points |
| `tail` | int | Preset → Pitch | Boundary condition point |
| `tail_ratio` | int | Preset → Pitch | Damping region ratio |
| `volume_coefficient` | float | Preset → Pitch | Output amplitude scaling |

**Storage Locations:**
- **Preset File:** `presets/<name>.json` → `pitches[pitchID]['physics']` and `['geometry']`
- **Python:** `StringMap.pitches[pitchID]` (Pitch objects)
- **CUDA:** `dev_physical_parameters` array (packed format)

### 2. Hammer/Excitation Parameters

**Purpose:** Define how strings are excited when notes are played

**Components:**

| Parameter | Type | Source | Description |
|-----------|------|--------|-------------|
| **Hammer Shape** | array[384] | Preset → Pitch | Spatial force distribution |
| **Gauss Params** | 5 floats × 10 levels | Preset → Pitch.excitation | Temporal excitation curves |
| - `weight` | float | Per Gaussian | Amplitude weight |
| - `center` | float | Per Gaussian | Time position (relative) |
| - `width` | float | Per Gaussian | Duration parameter |
| - `offset` | float | Per Gaussian | Vertical offset |
| - `angle` | float | Per Gaussian | Phase/skew parameter |
| `excitation_cycle_index` | int array | Computed | Timing indices per string |

**Storage Locations:**
- **Preset File:** `pitches[pitchID]['hammer_shape']` and `['excitation']`
- **Python:** `Pitch.hammer_shape`, `Pitch.excitation` (GaussCollection objects)
- **CUDA:** `dev_hammer` (shapes), `dev_gauss_parameters` (temporal curves)

### 3. Mode Parameters

**Purpose:** Modal synthesis oscillators representing resonant behavior

**Components:**

| Parameter | Type | Source | Description |
|-----------|------|--------|-------------|
| `ID` | int | Preset → Piano_mode | Mode identifier |
| `frequency` | float | Preset → Piano_mode | Oscillation frequency (Hz) |
| `decrement` | float | Preset → Piano_mode | Damping rate |
| `mass` | float | Preset → Piano_mode | Modal mass |
| `stiffness` | float | Preset → Piano_mode | Modal stiffness |
| `damping` | float | Preset → Piano_mode | Modal damping |
| `state` | float | Runtime | Current position |
| `state_1` | float | Runtime | Previous position |
| `dec` | float | Computed | Decay coefficient (from decrement) |
| `omega` | float | Computed | Angular frequency coefficient |

**Storage Locations:**
- **Preset File:** `modes[modeID]` dictionary
- **Python:** `ModeMap.modes[modeID]` (Piano_mode objects)
- **CUDA:** `dev_mode_state` array (allocated 6 fields, uses 4)

### 4. Deck Parameters

**Purpose:** Coupling coefficients between strings and modes

**Components:**

| Parameter | Type | Source | Description |
|-----------|------|--------|-------------|
| `feedin` | array[num_modes] | Preset → Pitch.deck | Mode → String coupling |
| `feedback` | array[num_modes] | Preset → Pitch.deck | String → Mode coupling |
| Sound channel coefficients | array[num_pitches] | Runtime | Special output routing |

**Storage Locations:**
- **Preset File:** `pitches[pitchID]['deck']['feedin']` and `['feedback']`
- **Python:** `Pitch.deck` dictionary with numpy arrays
- **CUDA:** `dev_deck_parameters` (interleaved feedin + feedback)

---

## System Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                          FRONTEND LAYER                                │
│                        (backendServer.py)                              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Flask REST API Endpoints:                                            │
│  • POST /load_preset            → Load JSON preset file               │
│  • POST /set_parameter/<type>/<range>  → Update parameters            │
│  • POST /set_hammer_shape       → Update hammer shapes                │
│  • POST /set_string_excitation  → Update excitation curves            │
│  • POST /set_deck               → Update coupling coefficients        │
│  • POST /play                   → Trigger notes                       │
│                                                                        │
│  Parameter Routing:                                                   │
│  • parse_range() - Interpret pitch/mode ranges                        │
│  • Delegates to pianoid.<method>()                                    │
│                                                                        │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ Python Function Calls
                             ↓
┌────────────────────────────────────────────────────────────────────────┐
│                        MIDDLEWARE LAYER                                │
│                          (pianoid.py)                                  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  class Pianoid:                                                        │
│  • sm: StringMap                    # String/pitch parameters         │
│  • modes: ModeMap                   # Mode parameters                 │
│  • mp: ModelParameters              # System configuration            │
│  • pianoid: pianoidCuda.Pianoid     # C++ CUDA wrapper                │
│  • cuda_lock: threading.Lock        # Thread safety                   │
│                                                                        │
│  Initialization Flow:                                                 │
│  1. __init__(preset=<dict>)                                           │
│     ├─ StringMap(preset['pitches']) → Load string/hammer/excitation  │
│     └─ ModeMap(preset['modes'])     → Load mode parameters            │
│  2. init_pianoid()                                                    │
│     ├─ sm.pack_parameters()         → Pack all string data            │
│     ├─ modes.pack_modes()           → Pack mode state                 │
│     ├─ pianoidCuda.Pianoid()        → Create C++ object               │
│     └─ devMemoryInit()              → Allocate GPU memory             │
│                                                                        │
│  Parameter Update Methods:                                            │
│  • update_parameter(param, values, **range)  # Generic dispatcher     │
│  • update_pitch_physical_params()            # String physics         │
│  • update_pitch_excitation()                 # Excitation curves      │
│  • update_mode_params()                      # Mode oscillators       │
│  • send_mode_params_to_CUDA()                # Mode state → GPU       │
│  • send_deck_params_to_CUDA()                # Coupling → GPU         │
│  • update_params_on_cuda()                   # String params → GPU    │
│                                                                        │
│  Packing Methods:                                                     │
│  • pack_cycle_params_for_cuda()    → CycleParameters struct           │
│  • pack_deck_for_cuda()            → Wrapper for StringMap.pack_deck()│
│                                                                        │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ Python API
                             ↓
┌────────────────────────────────────────────────────────────────────────┐
│                      DOMAIN LAYER (PianoidBasic)                       │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  StringMap:                                                            │
│  • pitches: dict[int, Pitch]       # Pitch objects by MIDI number     │
│  • pitch_index: list[int]          # Active pitches                   │
│  • soundChannelModes               # Special output channels          │
│                                                                        │
│  Key Methods:                                                          │
│  • pack_parameters()               # Master packing function          │
│    Returns: (strings_in_pitches, state_0, state_1, gauss_params,     │
│              physical_parameters, hammer, volume_coefficients,        │
│              excitation_cycle_index, dec_open, stringMap)             │
│  • pack_deck(pack_for_cuda=True)   # Pack coupling matrices           │
│    Returns: [feedin_flat] + [feedback_flat]                           │
│  • update_deck(matrix, pitches, values)  # Update coupling            │
│                                                                        │
│  Pitch:                                                                │
│  • ID, frequency                   # Note identification              │
│  • physics: dict                   # tension, stiffness, damping, etc │
│  • geometry: dict                  # length, tail, tail_ratio         │
│  • hammer_shape: np.array[384]     # Spatial excitation               │
│  • excitation: GaussCollection     # Temporal excitation              │
│  • deck: dict['feedin', 'feedback']  # Modal coupling                 │
│                                                                        │
│  ModeMap:                                                              │
│  • modes: dict[int, Piano_mode]    # Mode objects by ID               │
│                                                                        │
│  Key Methods:                                                          │
│  • pack_modes(keep_state, updated_modes, fit)                         │
│    Returns: [state×N, state_1×N, dec×N, omega×N, mass×N]              │
│  • fit_params()                    # Compute dec, omega from physics  │
│                                                                        │
│  Piano_mode:                                                           │
│  • frequency, decrement, mass      # Physical parameters              │
│  • state, state_1                  # Runtime state                    │
│  • dec, omega                      # Computed coefficients            │
│  • fit_params()                    # Recompute dec, omega             │
│  • get_state(keep_state)           # Returns (state, state_1, dec,   │
│                                    #          omega, mass)             │
│                                                                        │
└────────────────────────────┬───────────────────────────────────────────┘
                             │ pybind11 Bindings
                             ↓
┌────────────────────────────────────────────────────────────────────────┐
│                        CUDA CORE LAYER                                 │
│                          (Pianoid.cu)                                  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Pianoid C++ Class:                                                    │
│  • cp_: CycleParameters            # System configuration             │
│  • handlers: vector<GpuDataHandler>  # Managed GPU memory             │
│                                                                        │
│  GPU Memory Buffers:                                                   │
│  • dev_physical_parameters         # String physics                   │
│  • dev_hammer                      # Hammer shapes                    │
│  • dev_gauss_parameters            # Excitation curves                │
│  • dev_mode_state                  # Mode oscillators                 │
│  • dev_deck_parameters             # String-mode coupling             │
│  • dev_volume_coeff                # Volume scaling                   │
│  • dev_a, dev_b                    # String state buffers             │
│                                                                        │
│  Initialization:                                                       │
│  • Pianoid(gauss_params, volume_coeff, strings_in_pitches, cp)        │
│  • devMemoryInit(...)              # Allocate all GPU buffers         │
│    ├─ GpuDataHandler system        # Managed memory allocation        │
│    └─ Named buffer lookups         # getRealPointer(), getIntPointer()│
│                                                                        │
│  Parameter Update Methods:                                            │
│  • setNewPhysicalParameters(physical_params, volume_coeff)            │
│    → loadParameterToPianoid() → parameterKernel (async)               │
│  • setNewHammerParameters(hammer_shapes)                              │
│    → loadParameterToPianoid() → parameterKernel (async)               │
│  • setNewExcitationParameters(gauss_params)                           │
│    → Updates host-side gauss_params vector (used in MIDI processing)  │
│  • setNewModeParameters(mode_state)                                   │
│    → cudaMemcpy to dev_mode_state (4 fields × numModes)               │
│  • setNewDeckParameters(deck_params)                                  │
│    → cudaMemcpy to dev_deck_parameters (2 × numModes × numStrings)    │
│                                                                        │
│  CUDA Kernels:                                                         │
│  • parameterKernel              # Processes physics parameters        │
│  • addArraysKernel              # Main string simulation              │
│  • addModesArrayKernel          # Mode integration                    │
│  • addGaussKernel               # Apply excitation                    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Preset File Structure

### JSON Schema Overview

Preset files are JSON documents with the following top-level structure:

```json
{
  "model_parameters": { ... },
  "pitches": { ... },
  "modes": { ... },
  "mode_sound_channels": { ... },
  "measure": true/false
}
```

### 1. Model Parameters Section

**Location:** `preset['model_parameters']`

```json
{
  "sample_rate": 48000,
  "array_size": 384,
  "mode_iteration": 48,
  "num_strings": 256,
  "num_modes": 64,
  "sound_step": 1,
  "listen_to_modes": true
}
```

**Flow:**
```
Preset JSON → Pianoid.__init__() → ModelParameters.update_params()
→ mp (instance variable) → pack_as_dict_for_cuda()
→ CycleParameters struct → Pianoid C++ constructor
```

### 2. Pitches Section

**Location:** `preset['pitches'][pitchID]`

Each pitch contains multiple parameter groups:

#### A. Physics Parameters
```json
"physics": {
  "tension": 1.0,
  "stiffness": 0.001,
  "damping": 0.1,
  "rho": 0.0001,
  "volume_coefficient": 1.0
}
```

**Flow:**
```
Preset → StringMap.__init__() → Pitch objects
→ Pitch.physics dict → pack_parameters()
→ physical_parameters list → devMemoryInit()
→ dev_physical_parameters (GPU)
```

#### B. Geometry Parameters
```json
"geometry": {
  "length": 384,
  "tail": 10,
  "tail_ratio": 4
}
```

**Flow:** Same as physics, packed together in `physical_parameters`

#### C. Hammer Shape
```json
"hammer_shape": [0.0, 0.1, ..., 0.0]  // 384 floats
```

**Flow:**
```
Preset → Pitch.hammer_shape (np.array)
→ pack_parameters() → hammer list
→ devMemoryInit() → dev_hammer (GPU)
```

#### D. Excitation Parameters
```json
"excitation": {
  "num_gauss": 5,
  "level_0": {
    "gauss_0": {"weight": 1.0, "center": 0.5, "width": 0.1, "offset": 0.0, "angle": 0.0},
    "gauss_1": { ... },
    ...
  },
  "level_1": { ... },
  ...
  "level_9": { ... }
}
```

**Flow:**
```
Preset → GaussCollection objects → Pitch.excitation
→ pack_gauss_params() → gauss_params list (5 params × 5 gaussians × 10 levels)
→ devMemoryInit() → dev_gauss_parameters (GPU)
```

#### E. Deck Parameters
```json
"deck": {
  "feedin": [0.1, 0.2, ..., 0.0],    // num_modes floats
  "feedback": [0.3, 0.4, ..., 0.0]   // num_modes floats
}
```

**Flow:**
```
Preset → Pitch.deck dict (numpy arrays)
→ StringMap.pack_deck() → [feedin_flat] + [feedback_flat]
→ devMemoryInit() → dev_deck_parameters (GPU)
```

### 3. Modes Section

**Location:** `preset['modes'][modeID]`

```json
"modes": {
  "0": {
    "frequency": 440.0,
    "decrement": 0.1,
    "mass": 1.0,
    "stiffness": 100.0,
    "damping": 0.5
  },
  "1": { ... },
  ...
}
```

**Flow:**
```
Preset → ModeMap.__init__() → Piano_mode objects
→ fit_params() computes dec, omega
→ pack_modes() → [state×N, state_1×N, dec×N, omega×N, mass×N]
→ devMemoryInit() → dev_mode_state (GPU)
```

### 4. Mode Sound Channels Section

**Location:** `preset['mode_sound_channels']`

```json
"mode_sound_channels": {
  "num_channels": 4,
  "60": 0.5,  // MIDI pitch 60 → coefficient 0.5
  "62": 0.3,
  ...
}
```

**Flow:**
```
Preset → ModeMap.set_sound_channels()
→ soundChannelModes.read_from_preset()
→ Integrated into feedin during pack_pitch_feedin()
```

---

## Frontend Layer (backendServer.py)

### Role and Responsibilities

- **HTTP Request Handling**: REST API endpoints for parameter manipulation
- **Range Parsing**: Convert string ranges ("60", "from60to72", "all") to pitch/mode lists
- **Request Validation**: Basic type checking and error handling
- **Response Formatting**: JSON responses with status codes

### Key Endpoints

#### 1. Load Preset

```python
@app.route('/load_preset', methods=['POST'])
def load_preset_route():
    data = request.get_json()
    path = data['path']

    # Initialize pianoid with preset
    pianoid = initialize(path, ...)

    # Start synthesis loop
    thread = threading.Thread(target=long_running_procedure, args=(pianoid, listen))
    thread.start()
```

**Flow:**
```
POST /load_preset {path: "presets/Preset_test5.json"}
→ initialize() function
→ Pianoid(preset=<loaded_json>)
→ pianoid.init_pianoid()
→ Background thread starts synthesis
```

#### 2. Set Parameter

```python
@app.route('/set_parameter/<parameter>/<key_no>', methods=['POST'])
def set_parameter_route(parameter, key_no):
    data = request.get_json()

    # Parse range (e.g., "60", "from60to72", "all")
    pitches, modes, status = parse_range(pianoid, parameter, key_no)

    # Update parameters
    result, message = pianoid.update_parameter(
        parameter,
        data['values'],
        pitches=pitches,
        modes=modes
    )
```

**Parameter Types:**
- `string` → Physical parameters (tension, stiffness, damping)
- `gauss` / `gauss_flat` / `gauss_full` → Excitation curves
- `hammer` → Hammer shapes
- `feedin` / `feedback` → Deck coupling
- `mode` → Mode parameters

**Flow:**
```
POST /set_parameter/string/60 {values: {tension: 1.2, stiffness: 0.002}}
→ parse_range() → pitches=[60], modes=[0..63]
→ pianoid.update_parameter('string', {tension: 1.2, ...}, pitches=[60], modes=...)
→ StringMap.update_pitch_params()
→ pianoid.update_params_on_cuda()
→ setNewPhysicalParameters() (CUDA)
```

#### 3. Range Parsing Logic

```python
def parse_range(pianoid, parameter, key_no):
    all_pitches = pianoid.get_all_pitches_in_preset(key_pitches=True)
    all_modes = list(range(pianoid.mp.num_modes))

    if key_no.startswith("from"):
        # "from60to72" → [60, 61, ..., 72]
        match = re.match(r"^from(\d+)to(\d+)$", key_no)
        start, end = int(match.group(1)), int(match.group(2))
    elif key_no.isdigit():
        # "60" → [60]
        start = end = int(key_no)
    elif key_no == "all":
        # "all" → all pitches, all modes
        return all_pitches, all_modes, "OK"

    # Validate ranges based on parameter type
    if parameter in ['string', 'gauss', 'hammer', ...]:
        # Pitch-based parameters
        pitches = list(range(start, end+1))
        modes = all_modes
    elif parameter in ['mode', 'output']:
        # Mode-based parameters
        pitches = all_pitches
        modes = list(range(start, end+1))

    return pitches, modes, 'OK'
```

---

## Middleware Layer (pianoid.py)

### Role and Responsibilities

- **Parameter Orchestration**: Coordinate updates between Python objects and CUDA
- **Thread Safety**: Manage concurrent parameter updates with `cuda_lock`
- **Data Transformation**: Pack/unpack parameters for CUDA transfer
- **Business Logic**: Implement parameter validation and derived computations

### Initialization Flow

```python
class Pianoid:
    def __init__(self, preset=False, **model_parameters):
        # 1. Create model parameters
        self.mp = ModelParameters()
        self.mp.update_params(**preset['model_parameters'])

        # 2. Create string map from preset
        self.sm = StringMap(model_params=self.mp, **preset)

        # 3. Create mode map from preset
        self.modes = ModeMap(self.mp, preset['modes'], num_modes='define')

        # 4. Thread safety
        self.cuda_lock = threading.Lock()

        # 5. CUDA object (created later in init_pianoid)
        self.pianoid = None
```

```python
def init_pianoid(self, save_params=False, feedbackOFF=True,
                 firFilterLength=0, main_volume=16, use_placeholder=False):

    # 1. Pack all string parameters
    (strings_in_pitches, state_0, state_1, gauss_params, physical_parameters,
     hammer, volume_coefficients, excitation_cycle_index, dec_open,
     stringMap) = self.sm.pack_parameters()

    # 2. Create CUDA Pianoid object
    import pianoidCuda
    cp = self.pack_cycle_params_for_cuda()
    self.pianoid = pianoidCuda.Pianoid(
        gauss_params,
        volume_coefficients,
        strings_in_pitches,
        cp
    )

    # 3. Pack mode and deck parameters
    mode_coefficients = self.pack_deck_for_cuda()  # Coupling matrices
    mode_state = self.modes.pack_modes(keep_state=False)

    # 4. Initialize GPU memory
    self.pianoid.devMemoryInit(
        state_0,                 # String initial state
        state_1,                 # String previous state
        mode_state,              # Mode parameters
        hammer,                  # Hammer shapes
        mode_coefficients,       # Deck parameters
        volume_coefficients,     # Volume scaling
        physical_parameters,     # String physics
        excitation_cycle_index,  # Timing indices
        fir_filters,             # FIR filter coefficients
        stringMap,               # String-to-pitch mapping
        dec_open,                # Damper state
        10000,                   # Main volume
        self.sustain             # Sustain pedal
    )

    # 5. Initialize parameters and send updates
    self.pianoid.initParameters()
    self.set_volume(64)
    self.send_updated_params_to_CUDA()
```

### Parameter Update Methods

#### 1. Generic Update Dispatcher

```python
def update_parameter(self, param, values, **param_range):
    pitches = param_range.get('pitches', self.sm.all_pitches(piano=True))
    modes = param_range.get('modes', list(range(self.mp.num_modes)))

    if param in ('feedin', 'feedback'):
        # Deck parameters
        pitch_values = {pn: np.array(fa) for pn, fa in values.items()}
        self.sm.update_deck(matrix=param, pitches=pitches, values=pitch_values)
        self.send_deck_params_to_CUDA()

    elif param == 'mode':
        # Mode parameters
        self.update_mode_params(values)

    elif param == 'string':
        # String physics
        for pitchID in pitches:
            self.update_pitch_physical_params(pitchID, **values)

    elif param in ['gauss', 'gauss_flat', 'gauss_full']:
        # Excitation parameters
        for pitchID in pitches:
            self.update_pitch_excitation(pitchID, **values)
```

#### 2. String Physics Update

```python
def update_pitch_physical_params(self, pitchID, send_to_cuda=True, **params):
    pitch = self.sm.pitches[pitchID]

    # Handle special parameters
    if 'detuning' in params:
        params['tension_offset'] = params['detuning']
        params.pop('detuning')

    if 'tension_offset' in params:
        pitch.tension_offset = params['tension_offset']
        params.pop('tension_offset')
        pitch.recompute_physics()  # Recalculate derived values

    # Update physics dictionary
    pitch.update_physics(**params)

    # Send to CUDA if requested
    if send_to_cuda:
        self.update_params_on_cuda(physics=True, hammer_shape=False, excitation=False)
```

```python
def update_params_on_cuda(self, physics=True, hammer_shape=True, excitation=True):
    with self.cuda_lock:
        # Pack all parameters
        (strings_in_pitches, state_0, state_1, gauss_params, physical_parameters,
         hammer, volume_coefficients, excitation_cycle_index, dec_open, feedin,
         feedback, stringMap) = self.sm.pack_parameters()

        # Selective updates
        if physics:
            self.pianoid.setNewPhysicalParameters(physical_parameters, volume_coefficients)
        if hammer_shape:
            self.pianoid.setNewHammerParameters(hammer)
        if excitation:
            self.pianoid.setNewExcitationParameters(gauss_params)
```

#### 3. Excitation Update

```python
def update_pitch_excitation(self, pitchID, **params):
    pitch = self.sm.pitches[pitchID]
    pitch.set_excitation(**params)

    with self.cuda_lock:
        excitations = self.sm.pack_excitations()
        self.pianoid.setNewExcitationParameters(excitations)
        time.sleep(0.01)  # Allow CUDA to complete
```

#### 4. Mode Parameters Update

```python
def send_mode_params_to_CUDA(self, updated_modes={}, keep_state=True):
    with self.cuda_lock:
        mode_state = self.modes.pack_modes(updated_modes=updated_modes)
        self.pianoid.setNewModeParameters(mode_state)
        time.sleep(0.01)

def update_mode_params(self, mode_params):
    self.send_mode_params_to_CUDA(updated_modes=mode_params)
```

#### 5. Deck Parameters Update

```python
def send_deck_params_to_CUDA(self, feedin_coeff=1, feedback_coeff=1, feedbackOFF=False):
    with self.cuda_lock:
        deck = self.sm.pack_deck()
        print(f"Setting deck parameters to CUDA with data length {len(deck)}")
        self.pianoid.setNewDeckParameters(deck)
        time.sleep(0.01)
```

### Thread Safety Mechanism

```python
# All CUDA parameter updates are protected by a lock
with self.cuda_lock:
    # 1. Pack parameters from Python objects
    params = self.sm.pack_parameters()

    # 2. Send to CUDA
    self.pianoid.setNew...Parameters(params)

    # 3. Sleep to allow CUDA kernel to complete
    time.sleep(0.01)
```

**Rationale:**
- CUDA operations are asynchronous
- Multiple REST API requests could arrive concurrently
- Lock prevents race conditions during parameter updates
- Sleep ensures CUDA kernels complete before lock release

---

## PianoidBasic Library (StringMap, ModeMap)

### StringMap Class

**Purpose:** Container for all pitch/string parameters

#### Key Attributes

```python
class StringMap:
    pitches: dict[int, Pitch]           # Pitch objects by MIDI number
    pitch_index: list[int]              # Active pitch IDs
    soundChannelModes: ModeSoundChannels  # Special output routing
    mp: ModelParameters                 # System configuration
```

#### Master Packing Method

```python
def pack_parameters(self):
    """
    Pack all string-related parameters for CUDA transfer.

    Returns tuple of:
    - strings_in_pitches: list[int] - String-to-pitch mapping
    - state_0: list[float] - Initial string states
    - state_1: list[float] - Previous string states
    - gauss_params: list[float] - Excitation curves (5×5×10 per string)
    - physical_parameters: list[float] - Physics (9 params per string)
    - hammer: list[float] - Hammer shapes (384 per string)
    - volume_coefficients: list[float] - Volume scaling
    - excitation_cycle_index: list[int] - Timing indices
    - dec_open: list[int] - Damper states
    - stringMap: list[int] - String-to-block mapping
    """

    strings_in_pitches = []
    state_0 = []
    state_1 = []
    gauss_params = []
    physical_parameters = []
    hammer = []
    volume_coefficients = []
    excitation_cycle_index = []
    dec_open = []
    stringMap = []

    for pitchID in self.pitch_index:
        pitch = self.pitches[pitchID]

        # Pack string indices (3 strings per pitch, padded with 0)
        strings = pitch.get_strings_in_pitch()
        strings_in_pitches.extend([s if s else 0 for s in strings[:3]])

        for string in pitch.strings:
            # Initial states (zeros for fresh start)
            state_0.extend([0.0] * self.mp.array_size)
            state_1.extend([0.0] * self.mp.array_size)

            # Physics parameters (9 floats per string)
            physical_parameters.extend(string.pack_physical_params())

            # Hammer shape (384 floats)
            hammer.extend(string.hammer_shape)

            # Excitation curves (5 params × 5 gaussians × 10 levels = 250 floats)
            gauss_params.extend(string.excitation.pack_gauss_params())

            # Volume coefficient
            volume_coefficients.append(string.physical_parameters['volume_coefficient'])

            # Timing index
            excitation_cycle_index.append(string.excitation_cycle_index)

            # Damper state
            dec_open.append(1 if pitch.damper_open else 0)

            # String-to-block mapping
            stringMap.append(pitch.block_index)

    return (strings_in_pitches, state_0, state_1, gauss_params,
            physical_parameters, hammer, volume_coefficients,
            excitation_cycle_index, dec_open, stringMap)
```

#### Deck Packing Method

```python
def pack_deck(self, pack_for_cuda=True):
    """
    Pack feedin/feedback coupling matrices.

    Returns flat list: [feedin_data] + [feedback_data]
    Size: 2 × num_strings × num_modes floats
    """
    feedin = np.stack([
        self.pack_pitch_feedin(pitchID)
        for pitchID in self.pitch_index
    ])

    feedback = np.stack([
        ext_to_the_right(
            self.pitches[pitchID].deck['feedback'],
            self.mp.num_modes_for_model
        )
        for pitchID in self.pitch_index
    ])

    if pack_for_cuda:
        return feedin.ravel().tolist() + feedback.ravel().tolist()
    else:
        return feedin, feedback

def pack_pitch_feedin(self, pitchID):
    """
    Pack feedin for one pitch, including sound channel mode coupling.
    """
    feedin = ext_to_the_right(
        self.pitches[pitchID].deck['feedin'],
        self.mp.num_strings
    )

    # Add sound channel mode coupling if enabled
    if self.mp.listen_to_modes:
        feedin[self.soundChannelModes.get_index()] = \
            self.soundChannelModes.get_coeff(pitchID)

    return feedin
```

#### Deck Update Method

```python
def update_deck(self, matrix, pitches, values, verbose=False):
    """
    Update coupling matrices for specified pitches.

    Args:
        matrix: 'feedin' or 'feedback'
        pitches: list of pitch IDs
        values: dict[pitchID] = np.array of coefficients
        verbose: print debug info
    """
    for pitchID in pitches:
        if pitchID in values:
            self.pitches[pitchID].deck[matrix] = values[pitchID]
            if verbose:
                print(f"Updated {matrix} for pitch {pitchID}")
```

### Pitch Class

**Purpose:** Represents a single piano note with all associated parameters

#### Key Attributes

```python
class Pitch:
    ID: int                            # MIDI number
    frequency: float                   # Note frequency (Hz)

    # Physics
    physics: dict = {
        'tension': float,
        'stiffness': float,
        'damping': float,
        'rho': float,
        'volume_coefficient': float
    }

    # Geometry
    geometry: dict = {
        'length': int,
        'tail': int,
        'tail_ratio': int
    }

    # Excitation
    hammer_shape: np.array[384]        # Spatial force distribution
    excitation: GaussCollection        # Temporal excitation curves

    # Coupling
    deck: dict = {
        'feedin': np.array,            # Mode → String
        'feedback': np.array           # String → Mode
    }

    # Runtime
    tension_offset: float              # Detuning
    damper_open: bool                  # Sustain pedal state
```

#### Key Methods

```python
def update_physics(self, **params):
    """Update physics dictionary and recompute derived values."""
    for key, value in params.items():
        if key in self.physics:
            self.physics[key] = value
    self.recompute_physics()

def recompute_physics(self):
    """Recompute tension from frequency and tension_offset."""
    self.physics['tension'] = (
        (self.frequency * (1 + self.tension_offset)) ** 2 *
        self.physics['rho'] * self.geometry['length'] ** 2
    )

def pack_physical_params(self):
    """
    Pack physics for CUDA transfer.

    Returns list of 9 floats:
    [tension, stiffness, damping, rho, length, tail, tail_ratio,
     volume_coefficient, frequency]
    """
    return [
        self.physics['tension'],
        self.physics['stiffness'],
        self.physics['damping'],
        self.physics['rho'],
        float(self.geometry['length']),
        float(self.geometry['tail']),
        float(self.geometry['tail_ratio']),
        self.physics['volume_coefficient'],
        self.frequency
    ]

def set_excitation(self, **params):
    """Update excitation curves."""
    self.excitation.update_params(**params)
```

### ModeMap Class

**Purpose:** Container for modal synthesis oscillators

#### Key Attributes

```python
class ModeMap:
    modes: dict[int, Piano_mode]       # Mode objects by ID
    mp: ModelParameters                # System configuration
```

#### Packing Method

```python
def pack_modes(self, keep_state=True, updated_modes={}, fit=True):
    """
    Pack all mode parameters for CUDA transfer.

    Args:
        keep_state: If False, reset state to zero
        updated_modes: dict[modeID] = (state, state_1, dec, omega, mass)
                      Use 'keep' to preserve existing value
        fit: If True, recompute dec/omega from physical parameters

    Returns flat list:
    [state_0, state_1, ..., state_N,
     state_1_0, state_1_1, ..., state_1_N,
     dec_0, dec_1, ..., dec_N,
     omega_0, omega_1, ..., omega_N,
     mass_0, mass_1, ..., mass_N]

    Size: 5 × num_modes floats (but CUDA only uses first 4 fields)
    """
    mode_state = []

    for i, mode in self.modes.items():
        if fit:
            mode.fit_params()  # Recompute dec, omega

        ms = mode.get_state(keep_state)

        # Handle selective updates
        if i in updated_modes:
            msn = [
                updated_modes[i][j] if updated_modes[i][j] != 'keep' else ms[j]
                for j in range(len(ms))
            ]
            mode_state.append(msn)
        else:
            mode_state.append(ms)

    # Append dummy modes if needed
    for i in range(self.modes_to_append()):
        mode = Piano_mode(-1, self.mp, dummy=True)
        mode_state.append(mode.get_state(True))

    # Transpose: convert list of tuples to tuple of lists
    # From: [(s0, s1_0, d0, o0, m0), (s1, s1_1, d1, o1, m1), ...]
    # To: [s0, s1, ..., s1_0, s1_1, ..., d0, d1, ..., o0, o1, ..., m0, m1, ...]
    mode_state = (
        [a for a, b, c, d, m in mode_state] +  # All state
        [b for a, b, c, d, m in mode_state] +  # All state_1
        [c for a, b, c, d, m in mode_state] +  # All dec
        [d for a, b, c, d, m in mode_state] +  # All omega
        [m for a, b, c, d, m in mode_state]    # All mass
    )

    return mode_state
```

### Piano_mode Class

**Purpose:** Individual modal oscillator

#### Key Attributes

```python
class Piano_mode:
    ID: int                    # Mode identifier

    # Physical parameters (from preset)
    frequency: float           # Oscillation frequency (Hz)
    decrement: float           # Damping rate
    mass: float                # Modal mass
    stiffness: float           # Modal stiffness
    damping: float             # Modal damping

    # Runtime state
    state: float               # Current position
    state_1: float             # Previous position

    # Computed coefficients
    dec: float                 # Decay coefficient
    omega: float               # Angular frequency coefficient
```

#### Key Methods

```python
def fit_params(self):
    """
    Compute dec and omega from physical parameters.

    Used before packing modes for CUDA transfer.
    """
    dt = 1 / self.mp.sample_rate()

    # Angular frequency coefficient
    # K_OMEGA is a constant from Pianoid.constants
    self.omega = dt ** 2 * self.frequency ** 2 * K_OMEGA

    # Decay coefficient
    self.dec = dt * self.decrement * self.frequency

def get_state(self, keep_state=False):
    """
    Return mode state tuple for packing.

    Returns: (state, state_1, dec, omega, mass)
    """
    if keep_state:
        return (self.state, self.state_1, self.dec, self.omega, self.mass)
    else:
        # Reset state to zero
        return (0.0, 0.0, self.dec, self.omega, self.mass)

def update_params(self, params, verbose=False):
    """Update physical parameters and refit."""
    for key, value in params.items():
        if hasattr(self, key):
            setattr(self, key, value)
    self.fit_params()
```

---

## CUDA Core Layer (Pianoid.cu)

### Pianoid C++ Class

#### Constructor

```cpp
Pianoid::Pianoid(std::vector<real>& gauss_params,
                 const std::vector<real>& volume_coeff,
                 std::vector<int>& strings_in_pitches,
                 const CycleParameters& cp)
    : cp_(cp)  // Store cycle parameters
{
    // Pack cycle parameters for kernels
    cycle_parameters[0] = cp_.array_size;
    cycle_parameters[1] = cp_.num_strings;
    cycle_parameters[2] = cp_.num_modes;
    cycle_parameters[3] = cp_.mode_iteration;
    cycle_parameters[4] = cp_.sound_step;
    cycle_parameters[5] = cp_.num_strings_in_array;
    cycle_parameters[6] = cp_.fir_filter_length;
    cycle_parameters[7] = cp_.sample_rate;
    cycle_parameters[8] = cp_.num_channels;
    cycle_parameters[9] = cp_.listen_to_modes;
    cycle_parameters[10] = cp_.mode_channel_index;

    // Store configuration
    arraySize = cp_.array_size;
    numStrings = cp_.num_strings;
    numModes = cp_.num_modes;
    numChannels = cp_.num_channels;
    samplesInCycle = cp_.mode_iteration;
    sampleRate = cp_.sample_rate;
    soundStep = cp_.sound_step;
    numStringsInArray = cp_.num_strings_in_array;
    firFilterLength = cp_.fir_filter_length;

    // Store host-side copies
    this->gauss_params = gauss_params;
    this->volume_coeff = volume_coeff;
    this->strings_in_pitch = strings_in_pitches;

    // Initialize audio driver
    audioDriver = AudioDriverFactory::createDefaultDriver(
        cp_.sample_rate,
        cp_.buffer_size,
        cp_.num_channels,
        cp_.mode_iteration,
        this
    );
}
```

#### GPU Memory Initialization

```cpp
void Pianoid::devMemoryInit(
    const std::vector<real>& a,                    // String state_0
    const std::vector<real>& b,                    // String state_1
    const std::vector<real>& mode_state,           // Mode parameters
    const std::vector<real>& force,                // Hammer shapes
    const std::vector<real>& mode_coefficients,    // Deck parameters
    const std::vector<real>& volume_coeff,         // Volume coefficients
    const std::vector<real>& physical_parameters,  // String physics
    const std::vector<int>& excitation_cycle_index, // Timing indices
    const std::vector<float>& fir_filters,         // FIR coefficients
    const std::vector<int>& stringMap,             // String-to-block mapping
    const std::vector<int>& init_dec_open,         // Damper states
    const real main_volume_coeff,                  // Main volume
    const int sustain_value                        // Sustain pedal
)
{
    cudaDeviceReset();

    // Allocate mode state (6 fields per mode)
    handlers.emplace_back("dev_mode_state",
        mode_state.data(),
        cp_.num_modes * 6,
        cp_.num_modes * 6,
        sizeof(real), true, (void**)&dev_mode_state);

    // Allocate deck parameters (2 matrices × num_strings × num_modes)
    handlers.emplace_back("dev_deck_parameters",
        mode_coefficients.data(),
        cp_.num_modes * cp_.num_strings * 2,
        cp_.num_modes * cp_.num_strings * 2,
        sizeof(real), true, (void**)&dev_deck_parameters);

    // Allocate volume coefficients
    handlers.emplace_back("dev_volume_coeff",
        volume_coeff.data(),
        cp_.num_strings,
        cp_.num_strings,
        sizeof(real), true, (void**)&dev_volume_coeff);

    // Allocate physical parameters (9 params × num_strings)
    handlers.emplace_back("dev_physical_parameters",
        physical_parameters.data(),
        cp_.num_strings * PARAMS_PER_STRING,
        cp_.num_strings * PARAMS_PER_STRING,
        sizeof(real), true, (void**)&dev_physical_parameters);

    // Allocate hammer shapes (array_size × num_strings)
    handlers.emplace_back("dev_hammer",
        force.data(),
        cp_.array_size * cp_.num_strings,
        cp_.array_size * cp_.num_strings,
        sizeof(real), true, (void**)&dev_hammer);

    // Allocate string states (array_size × num_strings)
    handlers.emplace_back("dev_a",
        a.data(),
        cp_.array_size * cp_.num_strings,
        cp_.array_size * cp_.num_strings,
        sizeof(real), true, (void**)&dev_a);

    handlers.emplace_back("dev_b",
        b.data(),
        cp_.array_size * cp_.num_strings,
        cp_.array_size * cp_.num_strings,
        sizeof(real), true, (void**)&dev_b);

    // Allocate gauss parameters
    // (LEN_LEVEL_GP params × num_strings, host-side copy used)
    handlers.emplace_back("dev_gauss_parameters",
        gauss_params.data(),
        cp_.num_strings * LEN_LEVEL_GP,
        cp_.num_strings * LEN_LEVEL_GP,
        sizeof(real), true, (void**)&dev_gauss_parameters);

    // ... (additional buffers: excitation indices, FIR filters, output buffers, etc.)

    printf("GPU memory initialized successfully\n");
}
```

### Parameter Update Methods

#### 1. Physical Parameters

```cpp
void Pianoid::setNewPhysicalParameters(
    const std::vector<real>& physical_parameters,
    const std::vector<real>& volume_coeff)
{
    // Check if another update is in progress
    bool expected = false;
    if (!parameterUpdateInProgress.compare_exchange_strong(expected, true)) {
        printf("WARNING: Parameter update already in progress, skipping\n");
        return;
    }

    // Load parameters to GPU
    loadParameterToPianoid("dev_physical_parameters", physical_parameters);
    loadParameterToPianoid("dev_volume_coeff", volume_coeff);

    // Launch parameter processing kernel (async)
    int numIterations = get_iterations_number();
    CUDA_LAUNCH_ASYNC(parameterKernel, numBlocks, arraySize,
        getRealPointer("dev_physical_parameters"),
        getIntPointer("dev_dec_open"),
        getRealPointer("dev_hammer"),
        getIntPointer("dev_cycle_params"),
        getRealPointer("dev_parameters"),
        getIntPointer("dev_sustain_value"));

    // Release flag after sync completes
    parameterUpdateInProgress.store(false);
}
```

**Helper Method:**
```cpp
void Pianoid::loadParameterToPianoid(const std::string& name,
                                     const std::vector<real>& data)
{
    cudaError_t cudaStatus = cudaMemcpy(
        getRealPointer(name),
        data.data(),
        data.size() * sizeof(real),
        cudaMemcpyHostToDevice
    );

    if (cudaStatus != cudaSuccess) {
        printf("cudaMemcpy failed! %s: %s\n",
               name.c_str(), cudaGetErrorString(cudaStatus));
    }
}
```

#### 2. Hammer Parameters

```cpp
void Pianoid::setNewHammerParameters(const std::vector<real>& force)
{
    bool expected = false;
    if (!parameterUpdateInProgress.compare_exchange_strong(expected, true)) {
        printf("WARNING: Parameter update already in progress, skipping\n");
        return;
    }

    loadParameterToPianoid("dev_hammer", force);

    int numIterations = get_iterations_number();
    CUDA_LAUNCH_ASYNC(parameterKernel, numBlocks, arraySize,
        getRealPointer("dev_physical_parameters"),
        getIntPointer("dev_dec_open"),
        getRealPointer("dev_hammer"),
        getIntPointer("dev_cycle_params"),
        getRealPointer("dev_parameters"),
        getIntPointer("dev_sustain_value"));

    parameterUpdateInProgress.store(false);
}
```

#### 3. Excitation Parameters

```cpp
void Pianoid::setNewExcitationParameters(const std::vector<real>& new_gauss_params)
{
    // Only update host-side copy
    // Gauss parameters are read from host during MIDI processing
    gauss_params = new_gauss_params;
}
```

**Note:** Excitation parameters are **not** transferred to GPU immediately. They are copied to GPU during `processMidiPoints()` when a note is triggered.

#### 4. Mode Parameters

```cpp
void Pianoid::setNewModeParameters(const std::vector<real>& mode_state)
{
    cudaError_t cudaStatus = cudaMemcpy(
        getRealPointer("dev_mode_state"),
        mode_state.data(),
        (numModes * 4) * sizeof(real),  // Only 4 fields copied!
        cudaMemcpyHostToDevice
    );

    if (cudaStatus != cudaSuccess) {
        printf("cudaMemcpy failed! mode_state %s\n",
               cudaGetErrorString(cudaStatus));
    }

    printf("Mode state updated\n");
}
```

**Critical Issue:** Allocated `numModes * 6` floats in `devMemoryInit()`, but only copies `numModes * 4` floats here. The `mass` field (5th element) is **not transferred**.

#### 5. Deck Parameters

```cpp
void Pianoid::setNewDeckParameters(const std::vector<real>& deck_parameters)
{
    cudaError_t cudaStatus = cudaMemcpy(
        getRealPointer("dev_deck_parameters"),
        deck_parameters.data(),
        (numModes * numStrings * 2) * sizeof(real),
        cudaMemcpyHostToDevice
    );

    if (cudaStatus != cudaSuccess) {
        printf("cudaMemcpy failed! deck parameters %s\n",
               cudaGetErrorString(cudaStatus));
    }

    printf("Deck parameters updated\n");
}
```

**Memory Layout:**
```
dev_deck_parameters:
[feedin[0][0..N], feedin[1][0..N], ..., feedin[M][0..N],
 feedback[0][0..N], feedback[1][0..N], ..., feedback[M][0..N]]

Where M = num_strings, N = num_modes
```

### GPU Memory Buffers Summary

| Buffer Name | Size | Content | Updated Via |
|-------------|------|---------|-------------|
| `dev_physical_parameters` | `num_strings × 9` floats | String physics | `setNewPhysicalParameters()` |
| `dev_hammer` | `array_size × num_strings` floats | Hammer shapes | `setNewHammerParameters()` |
| `dev_gauss_parameters` | `num_strings × 250` floats | Excitation curves | Host-side only (used in MIDI) |
| `dev_mode_state` | `num_modes × 6` floats | Mode oscillators | `setNewModeParameters()` (uses 4) |
| `dev_deck_parameters` | `num_strings × num_modes × 2` floats | Coupling matrices | `setNewDeckParameters()` |
| `dev_volume_coeff` | `num_strings` floats | Volume scaling | `setNewPhysicalParameters()` |
| `dev_a`, `dev_b` | `array_size × num_strings` floats | String states | Runtime (synthesis kernels) |

---

## Complete Parameter Flow Diagrams

### 1. Preset Loading Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PRESET LOADING FLOW                           │
└──────────────────────────────────────────────────────────────────────┘

User Action: POST /load_preset {path: "presets/Preset_test5.json"}
     ↓
┌────────────────────────────────────────────────────────────────────┐
│ FRONTEND: backendServer.py                                         │
├────────────────────────────────────────────────────────────────────┤
│ load_preset_route()                                                │
│   ↓                                                                │
│ Read JSON file                                                     │
│   ↓                                                                │
│ preset = json.load(file)                                           │
│   ↓                                                                │
│ initialize(path, ...)                                              │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ MIDDLEWARE: pianoid.py                                             │
├────────────────────────────────────────────────────────────────────┤
│ Pianoid(preset=preset_dict)                                        │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 1. Model Parameters                                          │   │
│ │    mp = ModelParameters()                                    │   │
│ │    mp.update_params(**preset['model_parameters'])            │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 2. String Map                                                │   │
│ │    sm = StringMap(model_params=mp, **preset)                 │   │
│ │      ↓                                                        │   │
│ │    For each preset['pitches'][pitchID]:                      │   │
│ │      pitch = Pitch(pitchID, preset_data)                     │   │
│ │        • physics = preset['physics']                         │   │
│ │        • geometry = preset['geometry']                       │   │
│ │        • hammer_shape = preset['hammer_shape']               │   │
│ │        • excitation = GaussCollection(preset['excitation'])  │   │
│ │        • deck = preset['deck']                               │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 3. Mode Map                                                  │   │
│ │    modes = ModeMap(mp, preset['modes'])                      │   │
│ │      ↓                                                        │   │
│ │    For each preset['modes'][modeID]:                         │   │
│ │      mode = Piano_mode(modeID, preset_data)                  │   │
│ │        • frequency, decrement, mass, stiffness, damping      │   │
│ │        • fit_params() → compute dec, omega                   │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ init_pianoid()                                                     │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 4. Pack Parameters                                           │   │
│ │    sm.pack_parameters()                                      │   │
│ │      → (strings_in_pitches, state_0, state_1, gauss_params,  │   │
│ │         physical_parameters, hammer, volume_coefficients,    │   │
│ │         excitation_cycle_index, dec_open, stringMap)         │   │
│ │                                                              │   │
│ │    modes.pack_modes(keep_state=False)                        │   │
│ │      → [state×N, state_1×N, dec×N, omega×N, mass×N]          │   │
│ │                                                              │   │
│ │    sm.pack_deck()                                            │   │
│ │      → [feedin_flat] + [feedback_flat]                       │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 5. Create CUDA Object                                        │   │
│ │    cp = pack_cycle_params_for_cuda()                         │   │
│ │    pianoid = pianoidCuda.Pianoid(gauss_params, volume_coeff, │   │
│ │                                  strings_in_pitches, cp)     │   │
│ └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ pybind11
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ CUDA CORE: Pianoid.cu                                              │
├────────────────────────────────────────────────────────────────────┤
│ Pianoid::Pianoid(gauss_params, volume_coeff, strings_in_pitches, cp)│
│   ↓                                                                │
│ Store configuration (cp_)                                          │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 6. Initialize GPU Memory                                     │   │
│ │    devMemoryInit(state_0, state_1, mode_state, hammer,       │   │
│ │                  mode_coefficients, volume_coeff,            │   │
│ │                  physical_parameters, ...)                   │   │
│ │      ↓                                                        │   │
│ │    GpuDataHandler system allocates:                          │   │
│ │      • dev_mode_state (num_modes × 6 floats)                 │   │
│ │      • dev_deck_parameters (num_strings × num_modes × 2)     │   │
│ │      • dev_physical_parameters (num_strings × 9)             │   │
│ │      • dev_hammer (array_size × num_strings)                 │   │
│ │      • dev_gauss_parameters (num_strings × 250)              │   │
│ │      • dev_volume_coeff (num_strings)                        │   │
│ │      • dev_a, dev_b (array_size × num_strings)               │   │
│ │      • ... (additional buffers)                              │   │
│ │      ↓                                                        │   │
│ │    cudaMemcpy host → device for all buffers                  │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 7. Initialize Audio Device                                   │   │
│ │    audioDriver->initAudioDevice()                            │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ Ready for synthesis                                                │
└────────────────────────────────────────────────────────────────────┘
```

### 2. String Parameter Update Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    STRING PARAMETER UPDATE FLOW                      │
└──────────────────────────────────────────────────────────────────────┘

User Action: POST /set_parameter/string/60
             {values: {tension: 1.2, stiffness: 0.002}}
     ↓
┌────────────────────────────────────────────────────────────────────┐
│ FRONTEND: backendServer.py                                         │
├────────────────────────────────────────────────────────────────────┤
│ set_parameter_route('string', '60')                                │
│   ↓                                                                │
│ parse_range(pianoid, 'string', '60')                               │
│   → pitches=[60], modes=[0..63]                                    │
│   ↓                                                                │
│ pianoid.update_parameter('string', {tension: 1.2, stiffness: 0.002},│
│                          pitches=[60], modes=[0..63])              │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ MIDDLEWARE: pianoid.py                                             │
├────────────────────────────────────────────────────────────────────┤
│ update_parameter('string', values, pitches=[60], modes=[0..63])    │
│   ↓                                                                │
│ For each pitch in pitches:                                         │
│   update_pitch_physical_params(60, **values)                       │
│     ↓                                                              │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ 1. Update Pitch Object                                     │   │
│   │    pitch = sm.pitches[60]                                  │   │
│   │    pitch.physics['tension'] = 1.2                          │   │
│   │    pitch.physics['stiffness'] = 0.002                      │   │
│   │    pitch.recompute_physics()  # Recalc derived values      │   │
│   └────────────────────────────────────────────────────────────┘   │
│     ↓                                                              │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ 2. Send to CUDA                                            │   │
│   │    update_params_on_cuda(physics=True,                     │   │
│   │                          hammer_shape=False,               │   │
│   │                          excitation=False)                 │   │
│   │      ↓                                                      │   │
│   │    with cuda_lock:                                         │   │
│   │      (strings_in_pitches, state_0, state_1, gauss_params,  │   │
│   │       physical_parameters, hammer, volume_coefficients,    │   │
│   │       ...) = sm.pack_parameters()                          │   │
│   │        ↓                                                    │   │
│   │      pianoid.setNewPhysicalParameters(physical_parameters, │   │
│   │                                        volume_coefficients) │   │
│   └────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ pybind11
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ CUDA CORE: Pianoid.cu                                              │
├────────────────────────────────────────────────────────────────────┤
│ setNewPhysicalParameters(physical_parameters, volume_coefficients) │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 1. Check Update Lock                                         │   │
│ │    if (parameterUpdateInProgress) { skip; return; }          │   │
│ │    parameterUpdateInProgress = true                          │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 2. Load to GPU                                               │   │
│ │    loadParameterToPianoid("dev_physical_parameters",         │   │
│ │                           physical_parameters)               │   │
│ │      ↓                                                        │   │
│ │    cudaMemcpy(dev_physical_parameters, physical_parameters,  │   │
│ │               num_strings × 9 × sizeof(real),                │   │
│ │               cudaMemcpyHostToDevice)                        │   │
│ │      ↓                                                        │   │
│ │    loadParameterToPianoid("dev_volume_coeff",                │   │
│ │                           volume_coefficients)               │   │
│ │      ↓                                                        │   │
│ │    cudaMemcpy(dev_volume_coeff, volume_coefficients,         │   │
│ │               num_strings × sizeof(real),                    │   │
│ │               cudaMemcpyHostToDevice)                        │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 3. Launch Parameter Kernel                                   │   │
│ │    CUDA_LAUNCH_ASYNC(parameterKernel, numBlocks, arraySize,  │   │
│ │        dev_physical_parameters, dev_dec_open, dev_hammer,    │   │
│ │        dev_cycle_params, dev_parameters, dev_sustain_value)  │   │
│ │      ↓                                                        │   │
│ │    Kernel processes parameters and stores in dev_parameters  │   │
│ │      ↓                                                        │   │
│ │    cudaDeviceSynchronize()                                   │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ parameterUpdateInProgress = false                                  │
│   ↓                                                                │
│ Parameters ready for synthesis kernels                             │
└────────────────────────────────────────────────────────────────────┘
```

### 3. Mode Parameter Update Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                     MODE PARAMETER UPDATE FLOW                       │
└──────────────────────────────────────────────────────────────────────┘

User Action: POST /set_parameter/mode/0
             {values: {frequency: 450.0, decrement: 0.15}}
     ↓
┌────────────────────────────────────────────────────────────────────┐
│ FRONTEND: backendServer.py                                         │
├────────────────────────────────────────────────────────────────────┤
│ set_parameter_route('mode', '0')                                   │
│   ↓                                                                │
│ parse_range(pianoid, 'mode', '0')                                  │
│   → pitches=[all], modes=[0]                                       │
│   ↓                                                                │
│ pianoid.update_parameter('mode', {frequency: 450.0, decrement: 0.15},│
│                          pitches=[all], modes=[0])                 │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ MIDDLEWARE: pianoid.py                                             │
├────────────────────────────────────────────────────────────────────┤
│ update_parameter('mode', values, pitches=[all], modes=[0])         │
│   ↓                                                                │
│ update_mode_params({0: {frequency: 450.0, decrement: 0.15}})       │
│   ↓                                                                │
│ send_mode_params_to_CUDA(updated_modes={0: ...})                   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 1. Pack Modes                                                │   │
│ │    with cuda_lock:                                           │   │
│ │      mode_state = modes.pack_modes(updated_modes={0: ...})   │   │
│ │        ↓                                                      │   │
│ │      For mode 0:                                             │   │
│ │        mode.frequency = 450.0                                │   │
│ │        mode.decrement = 0.15                                 │   │
│ │        mode.fit_params()  # Recompute dec, omega             │   │
│ │        state = mode.get_state()                              │   │
│ │          → (state, state_1, dec, omega, mass)                │   │
│ │        ↓                                                      │   │
│ │      For other modes:                                        │   │
│ │        Use existing values                                   │   │
│ │        ↓                                                      │   │
│ │      Transpose to: [state×N, state_1×N, dec×N, omega×N, mass×N]│  │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 2. Send to CUDA                                              │   │
│ │    pianoid.setNewModeParameters(mode_state)                  │   │
│ │      ↓                                                        │   │
│ │    time.sleep(0.01)  # Allow CUDA to complete                │   │
│ └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ pybind11
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ CUDA CORE: Pianoid.cu                                              │
├────────────────────────────────────────────────────────────────────┤
│ setNewModeParameters(mode_state)                                   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ Direct Memory Copy (No Kernel)                               │   │
│ │    cudaMemcpy(dev_mode_state, mode_state.data(),             │   │
│ │               numModes × 4 × sizeof(real),  ← Only 4 fields! │   │
│ │               cudaMemcpyHostToDevice)                        │   │
│ │      ↓                                                        │   │
│ │    Copies: [state×N, state_1×N, dec×N, omega×N]              │   │
│ │    Skips: [mass×N]  ← NOT COPIED!                            │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ Mode parameters ready for synthesis kernels                        │
└────────────────────────────────────────────────────────────────────┘
```

### 4. Deck Parameter Update Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                     DECK PARAMETER UPDATE FLOW                       │
└──────────────────────────────────────────────────────────────────────┘

User Action: POST /set_parameter/feedin/60
             {values: {60: [0.1, 0.2, 0.3, ...]}}  # num_modes values
     ↓
┌────────────────────────────────────────────────────────────────────┐
│ FRONTEND: backendServer.py                                         │
├────────────────────────────────────────────────────────────────────┤
│ set_parameter_route('feedin', '60')                                │
│   ↓                                                                │
│ parse_range(pianoid, 'feedin', '60')                               │
│   → pitches=[60], modes=[all]                                      │
│   ↓                                                                │
│ pianoid.update_parameter('feedin', {60: [0.1, 0.2, ...]},          │
│                          pitches=[60], modes=[all])                │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ MIDDLEWARE: pianoid.py                                             │
├────────────────────────────────────────────────────────────────────┤
│ update_parameter('feedin', values, pitches=[60], modes=[all])      │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 1. Update StringMap                                          │   │
│ │    pitch_values = {60: np.array([0.1, 0.2, ...])}            │   │
│ │    sm.update_deck(matrix='feedin', pitches=[60],             │   │
│ │                   values=pitch_values)                       │   │
│ │      ↓                                                        │   │
│ │    sm.pitches[60].deck['feedin'] = np.array([0.1, 0.2, ...]) │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ 2. Pack and Send to CUDA                                     │   │
│ │    send_deck_params_to_CUDA()                                │   │
│ │      ↓                                                        │   │
│ │    with cuda_lock:                                           │   │
│ │      deck = sm.pack_deck()                                   │   │
│ │        ↓                                                      │   │
│ │      For each pitch in pitch_index:                          │   │
│ │        feedin[pitch] = pack_pitch_feedin(pitch)              │   │
│ │          • Get pitch.deck['feedin']                          │   │
│ │          • Pad to num_strings length                         │   │
│ │          • Add sound channel mode coupling if enabled        │   │
│ │        feedback[pitch] = pitch.deck['feedback']              │   │
│ │          • Pad to num_modes_for_model length                 │   │
│ │        ↓                                                      │   │
│ │      Flatten: [feedin.ravel()] + [feedback.ravel()]          │   │
│ │        ↓                                                      │   │
│ │      pianoid.setNewDeckParameters(deck)                      │   │
│ │        ↓                                                      │   │
│ │      time.sleep(0.01)                                        │   │
│ └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ pybind11
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ CUDA CORE: Pianoid.cu                                              │
├────────────────────────────────────────────────────────────────────┤
│ setNewDeckParameters(deck_parameters)                              │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ Direct Memory Copy (No Kernel)                               │   │
│ │    cudaMemcpy(dev_deck_parameters, deck_parameters.data(),   │   │
│ │               numModes × numStrings × 2 × sizeof(real),      │   │
│ │               cudaMemcpyHostToDevice)                        │   │
│ │      ↓                                                        │   │
│ │    Layout: [feedin_flat] + [feedback_flat]                   │   │
│ │      • feedin: num_strings × num_modes floats                │   │
│ │      • feedback: num_strings × num_modes floats              │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ Deck parameters ready for mode integration kernels                 │
└────────────────────────────────────────────────────────────────────┘
```

### 5. Excitation Parameter Update Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                  EXCITATION PARAMETER UPDATE FLOW                    │
└──────────────────────────────────────────────────────────────────────┘

User Action: POST /set_parameter/gauss/60
             {values: {level_0: {gauss_0: {weight: 1.2, ...}}}}
     ↓
┌────────────────────────────────────────────────────────────────────┐
│ FRONTEND: backendServer.py                                         │
├────────────────────────────────────────────────────────────────────┤
│ set_parameter_route('gauss', '60')                                 │
│   ↓                                                                │
│ pianoid.update_parameter('gauss', values, pitches=[60], modes=[all])│
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ MIDDLEWARE: pianoid.py                                             │
├────────────────────────────────────────────────────────────────────┤
│ update_parameter('gauss', values, pitches=[60], modes=[all])       │
│   ↓                                                                │
│ For each pitch in pitches:                                         │
│   update_pitch_excitation(60, **values)                            │
│     ↓                                                              │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ 1. Update Excitation Object                                │   │
│   │    pitch = sm.pitches[60]                                  │   │
│   │    pitch.set_excitation(**values)                          │   │
│   │      ↓                                                      │   │
│   │    pitch.excitation.update_params(**values)                │   │
│   │      • Update GaussCollection (10 levels × 5 gaussians)    │   │
│   └────────────────────────────────────────────────────────────┘   │
│     ↓                                                              │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │ 2. Pack and Send to CUDA                                   │   │
│   │    with cuda_lock:                                         │   │
│   │      excitations = sm.pack_excitations()                   │   │
│   │        ↓                                                    │   │
│   │      For each string:                                      │   │
│   │        excitation_params = string.excitation.pack_gauss_params()│
│   │          → [w0, c0, wid0, o0, a0, w1, c1, wid1, o1, a1, ...] × 10│
│   │          → 250 floats per string                           │   │
│   │        ↓                                                    │   │
│   │      pianoid.setNewExcitationParameters(excitations)       │   │
│   │        ↓                                                    │   │
│   │      time.sleep(0.01)                                      │   │
│   └────────────────────────────────────────────────────────────┘   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ pybind11
                             ↓
┌────────────────────────────────────────────────────────────────────┐
│ CUDA CORE: Pianoid.cu                                              │
├────────────────────────────────────────────────────────────────────┤
│ setNewExcitationParameters(new_gauss_params)                       │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ Host-Side Update Only!                                       │   │
│ │    gauss_params = new_gauss_params  // Update host vector    │   │
│ │      ↓                                                        │   │
│ │    NO cudaMemcpy performed                                   │   │
│ │      ↓                                                        │   │
│ │    GPU buffer (dev_gauss_parameters) NOT updated here        │   │
│ └──────────────────────────────────────────────────────────────┘   │
│   ↓                                                                │
│ ┌──────────────────────────────────────────────────────────────┐   │
│ │ GPU Update Deferred Until Note Trigger                      │   │
│ │    When processMidiPoints() is called:                       │   │
│ │      ↓                                                        │   │
│ │    For each triggered note:                                  │   │
│ │      Copy gauss_params for this string to GPU                │   │
│ │      cudaMemcpy(dev_gauss_parameters + offset,               │   │
│ │                 gauss_params.data() + string_offset,         │   │
│ │                 LEN_LEVEL_GP × sizeof(real),                 │   │
│ │                 cudaMemcpyHostToDevice)                      │   │
│ └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

**Important Note:** Excitation parameters are **not immediately** transferred to GPU. They are stored host-side and copied during MIDI note processing when a note is triggered.

---

## Issues and Refactoring Opportunities

### Critical Issues

#### 1. Inconsistent Parameter Update Paths

**Problem:**
- Multiple methods for updating similar parameters
- Unclear which method to use in different scenarios
- Example: `update_params_on_cuda()` vs `send_updated_params_to_CUDA()` vs specific `update_pitch_*()` methods

**Impact:**
- Code duplication
- Maintenance burden
- Potential for bugs when one path is updated but others aren't

**Evidence:**
```python
# Method 1: Generic dispatcher
pianoid.update_parameter('string', values, pitches=[60])

# Method 2: Direct update
pianoid.update_pitch_physical_params(60, **values)

# Method 3: Bulk update
pianoid.update_params_on_cuda(physics=True)

# Method 4: Complete refresh
pianoid.send_updated_params_to_CUDA()
```

All four methods ultimately update string physics, but follow different code paths.

#### 2. Redundant Data Transformations

**Problem:**
- Parameters are packed and unpacked multiple times
- Entire parameter arrays repacked even when only one pitch changes
- Example: Updating pitch 60's tension repacks **all** physical parameters for **all** strings

**Impact:**
- Unnecessary CPU overhead
- Memory allocations/copies
- Slower parameter updates

**Evidence:**
```python
# User updates one parameter for one pitch
update_pitch_physical_params(60, tension=1.2)
  ↓
# But we repack ALL parameters for ALL strings
update_params_on_cuda(physics=True)
  ↓
(strings_in_pitches, state_0, state_1, gauss_params,
 physical_parameters, hammer, volume_coefficients, ...) = sm.pack_parameters()
  # ↑ Packs 256 strings × 9 params = 2304 floats
  ↓
setNewPhysicalParameters(physical_parameters, volume_coefficients)
  # ↑ Copies 2304 floats to GPU, even though only 9 changed
```

#### 3. Memory Allocation Mismatch

**Problem:**
- Mode state allocates 6 fields but only uses 4
- `mass` field is packed but never transferred to GPU

**Impact:**
- Wasted GPU memory
- Confusion about what data is actually used
- Potential bugs if `mass` is later needed

**Evidence:**
```cpp
// In devMemoryInit()
handlers.emplace_back("dev_mode_state",
    mode_state.data(),
    cp_.num_modes * 6,  // ← Allocates 6 fields
    cp_.num_modes * 6,
    sizeof(real), true, (void**)&dev_mode_state);

// In setNewModeParameters()
cudaMemcpy(getRealPointer("dev_mode_state"), mode_state.data(),
    (numModes * 4) * sizeof(real),  // ← Only copies 4 fields!
    cudaMemcpyHostToDevice);
```

**Questions:**
- Is `mass` used in CUDA kernels? (Need to check kernel code)
- Should we allocate only 4 fields?
- Or should we copy all 5 packed fields?

#### 4. Unclear Ownership

**Problem:**
- Ambiguous responsibility between `StringMap` and `Pianoid` classes
- Both classes have methods that manipulate the same data
- Example: Deck updates can be done via `StringMap.update_deck()` or `Pianoid.send_deck_params_to_CUDA()`

**Impact:**
- Code duplication
- Inconsistent state management
- Difficult to reason about data flow

**Evidence:**
```python
# Option 1: Update through StringMap
sm.update_deck(matrix='feedin', pitches=[60], values={60: array})

# Option 2: Update through Pianoid
pianoid.update_parameter('feedin', {60: array}, pitches=[60])

# Both ultimately call:
pianoid.send_deck_params_to_CUDA()
  ↓
deck = sm.pack_deck()  # StringMap packs data
  ↓
pianoid.pianoid.setNewDeckParameters(deck)  # Pianoid sends to CUDA
```

Who owns the deck data? StringMap or Pianoid?

#### 5. Limited Validation

**Problem:**
- No systematic parameter range checking
- No validation of array sizes
- Errors only detected at CUDA level (if at all)

**Impact:**
- Silent failures
- Difficult debugging
- Potential for crashes or undefined behavior

**Examples:**
- No check if `tension` is positive
- No validation that `hammer_shape` has exactly 384 elements
- No verification that `feedin` array length matches `num_modes`

#### 6. Excitation Parameter Deferred Update

**Problem:**
- Excitation parameters are **not** immediately sent to GPU
- Updated host-side, then copied during MIDI processing
- Different pattern from other parameter types

**Impact:**
- Inconsistent API behavior
- Users expect immediate update after `setNewExcitationParameters()`
- Potential for stale data if parameters change between calls

**Evidence:**
```cpp
void Pianoid::setNewExcitationParameters(const std::vector<real>& new_gauss_params) {
    // Only update host-side copy
    gauss_params = new_gauss_params;
    // NO cudaMemcpy here!
}
```

GPU buffer `dev_gauss_parameters` is only updated in `processMidiPoints()` when a note is triggered.

#### 7. Thread Safety Over-Synchronization

**Problem:**
- `cuda_lock` protects entire parameter update sequence
- Includes packing (CPU work) + CUDA transfer + sleep
- Unnecessarily blocks concurrent API requests

**Impact:**
- Poor concurrency
- Slow response time when multiple parameter updates arrive
- Lock held longer than necessary

**Evidence:**
```python
def update_params_on_cuda(self, physics=True, hammer_shape=True, excitation=True):
    with self.cuda_lock:  # Lock acquired
        # CPU work (doesn't need lock)
        params = sm.pack_parameters()

        # CUDA transfer (needs lock)
        if physics:
            self.pianoid.setNewPhysicalParameters(physical_parameters, volume_coefficients)
        if hammer_shape:
            self.pianoid.setNewHammerParameters(hammer)
        if excitation:
            self.pianoid.setNewExcitationParameters(gauss_params)
        # Lock held entire time, even during packing
```

**Better approach:** Pack parameters outside lock, then acquire lock only for CUDA operations.

### Minor Issues

#### 8. Inconsistent Naming Conventions

**Problem:**
- `setNewPhysicalParameters()` vs `send_mode_params_to_CUDA()`
- `pack_parameters()` vs `pack_deck_for_cuda()` vs `pack_modes()`
- Mixing camelCase and snake_case

**Impact:**
- Reduced code readability
- Harder to discover related methods

#### 9. Large Methods

**Problem:**
- `pack_parameters()` returns 10-tuple
- `devMemoryInit()` takes 14 parameters
- Difficult to understand and maintain

**Impact:**
- High cognitive load
- Hard to test individual components
- Error-prone when adding new parameters

#### 10. Hard-Coded Constants

**Problem:**
- Magic numbers scattered throughout code
- `LEN_LEVEL_GP = 250` (5 params × 5 gaussians × 10 levels)
- `PARAMS_PER_STRING = 9`
- No central definition or documentation

**Impact:**
- Difficult to change array sizes
- Unclear meaning of numbers in code
- Risk of inconsistency

#### 11. No Parameter Versioning

**Problem:**
- Preset files have no version number
- No migration path when parameter structure changes
- Breaking changes require manual preset updates

**Impact:**
- Old presets break when system evolves
- Users lose work
- No backward compatibility

---

## Recommended Refactoring Plan

### Phase 1: Immediate Fixes (Critical Issues)

#### 1.1 Fix Memory Allocation Mismatch

**Goal:** Resolve mode state allocation inconsistency

**Steps:**
1. Investigate if `mass` is used in CUDA kernels
2. If **not used**:
   - Change `devMemoryInit()` to allocate `num_modes * 5` (not 6)
   - Copy all 5 fields in `setNewModeParameters()`
3. If **used in kernels**:
   - Fix `setNewModeParameters()` to copy 5 fields (not 4)

**Code Changes:**
```cpp
// Option A: mass not used → allocate 5 fields
handlers.emplace_back("dev_mode_state",
    mode_state.data(),
    cp_.num_modes * 5,  // Changed from 6 to 5
    cp_.num_modes * 5,
    sizeof(real), true, (void**)&dev_mode_state);

cudaMemcpy(getRealPointer("dev_mode_state"), mode_state.data(),
    (numModes * 5) * sizeof(real),  // Changed from 4 to 5
    cudaMemcpyHostToDevice);

// Option B: mass used → copy 5 fields
cudaMemcpy(getRealPointer("dev_mode_state"), mode_state.data(),
    (numModes * 5) * sizeof(real),  // Changed from 4 to 5
    cudaMemcpyHostToDevice);
```

#### 1.2 Fix Excitation Parameter Update

**Goal:** Make excitation updates immediate like other parameters

**Steps:**
1. Add `cudaMemcpy` to `setNewExcitationParameters()`
2. Keep host-side copy for MIDI processing (still needed)
3. Update both host and device simultaneously

**Code Changes:**
```cpp
void Pianoid::setNewExcitationParameters(const std::vector<real>& new_gauss_params) {
    // Update host-side copy
    gauss_params = new_gauss_params;

    // ADDED: Immediately update GPU buffer
    cudaError_t cudaStatus = cudaMemcpy(
        getRealPointer("dev_gauss_parameters"),
        gauss_params.data(),
        cp_.num_strings * LEN_LEVEL_GP * sizeof(real),
        cudaMemcpyHostToDevice
    );

    if (cudaStatus != cudaSuccess) {
        printf("cudaMemcpy failed! gauss_parameters %s\n",
               cudaGetErrorString(cudaStatus));
    }

    printf("Excitation parameters updated\n");
}
```

### Phase 2: Structural Improvements

#### 2.1 Introduce Parameter Manager

**Goal:** Centralize parameter management logic

**Design:**
```python
class ParameterManager:
    """
    Centralized parameter management with validation and efficient updates.
    """

    def __init__(self, string_map, mode_map, cuda_pianoid):
        self.sm = string_map
        self.modes = mode_map
        self.cuda = cuda_pianoid
        self.cuda_lock = threading.Lock()

    def update_string_physics(self, pitches: list[int], params: dict):
        """
        Update string physics for specified pitches.
        Only packs and transfers affected strings (not all strings).
        """
        # 1. Validate parameters
        self._validate_physics_params(params)

        # 2. Update Python objects
        for pitchID in pitches:
            self.sm.pitches[pitchID].update_physics(**params)

        # 3. Pack only affected strings
        affected_strings = self._get_strings_for_pitches(pitches)
        physical_params = self._pack_physics_for_strings(affected_strings)

        # 4. Send to GPU (only affected strings)
        with self.cuda_lock:
            self.cuda.setPhysicsParamsPartial(affected_strings, physical_params)

    def update_mode_params(self, modes: list[int], params: dict):
        """Update mode parameters for specified modes."""
        # Similar structure
        pass

    def update_deck_params(self, pitches: list[int], matrix: str, values: dict):
        """Update coupling matrices for specified pitches."""
        # Similar structure
        pass

    def _validate_physics_params(self, params: dict):
        """Validate physics parameter ranges."""
        if 'tension' in params and params['tension'] <= 0:
            raise ValueError("Tension must be positive")
        if 'stiffness' in params and params['stiffness'] < 0:
            raise ValueError("Stiffness must be non-negative")
        # ... more validation

    def _get_strings_for_pitches(self, pitches: list[int]) -> list[int]:
        """Get string indices for given pitches."""
        strings = []
        for pitchID in pitches:
            strings.extend(self.sm.pitches[pitchID].get_strings_in_pitch())
        return strings

    def _pack_physics_for_strings(self, strings: list[int]) -> list[float]:
        """Pack physics parameters for specified strings only."""
        params = []
        for stringID in strings:
            # Pack this string's physics
            pass
        return params
```

**Benefits:**
- Single entry point for all parameter updates
- Validation in one place
- Efficient partial updates
- Clear ownership (ParameterManager owns the update logic)

#### 2.2 Implement Partial Parameter Updates

**Goal:** Only transfer changed parameters to GPU

**CUDA Changes:**
```cpp
// New method: update specific strings only
void Pianoid::setPhysicsParamsPartial(
    const std::vector<int>& string_indices,
    const std::vector<real>& physical_parameters)
{
    // For each string index
    for (size_t i = 0; i < string_indices.size(); ++i) {
        int stringID = string_indices[i];
        const real* params = physical_parameters.data() + i * PARAMS_PER_STRING;

        // Copy to specific offset in GPU buffer
        cudaMemcpy(
            getRealPointer("dev_physical_parameters") + stringID * PARAMS_PER_STRING,
            params,
            PARAMS_PER_STRING * sizeof(real),
            cudaMemcpyHostToDevice
        );
    }

    // Launch parameter kernel for affected strings only
    // (requires kernel modification to process specific indices)
}
```

**Benefits:**
- Much faster updates for single pitch changes
- Less memory bandwidth usage
- Scales better with larger systems

#### 2.3 Reduce Lock Scope

**Goal:** Hold `cuda_lock` only during CUDA operations

**Python Changes:**
```python
def update_string_physics(self, pitches, params):
    # 1. Update Python objects (NO LOCK NEEDED)
    for pitchID in pitches:
        self.sm.pitches[pitchID].update_physics(**params)

    # 2. Pack parameters (NO LOCK NEEDED)
    affected_strings = self._get_strings_for_pitches(pitches)
    physical_params = self._pack_physics_for_strings(affected_strings)

    # 3. CUDA transfer (LOCK NEEDED)
    with self.cuda_lock:
        self.cuda.setPhysicsParamsPartial(affected_strings, physical_params)
        # No sleep needed with proper CUDA synchronization
```

**Benefits:**
- Better concurrency
- Faster API response times
- Reduced lock contention

### Phase 3: API Redesign

#### 3.1 Unified Parameter Interface

**Goal:** Consistent, typed API for all parameter operations

**Design:**
```python
from dataclasses import dataclass
from typing import Union, List, Dict
from enum import Enum

class ParameterType(Enum):
    STRING_PHYSICS = "string_physics"
    HAMMER_SHAPE = "hammer_shape"
    EXCITATION = "excitation"
    MODE = "mode"
    DECK_FEEDIN = "deck_feedin"
    DECK_FEEDBACK = "deck_feedback"

@dataclass
class ParameterUpdate:
    """Type-safe parameter update request."""
    param_type: ParameterType
    targets: Union[List[int], str]  # Pitch/mode IDs or "all"
    values: Dict[str, Union[float, List[float]]]

    def validate(self):
        """Validate parameter ranges and types."""
        # Type checking, range validation
        pass

class PianoidAPI:
    """
    High-level API for Pianoid control.
    Replaces direct calls to pianoid.update_parameter().
    """

    def __init__(self, pianoid):
        self.pianoid = pianoid
        self.param_manager = ParameterManager(
            pianoid.sm, pianoid.modes, pianoid.pianoid
        )

    def update_parameters(self, update: ParameterUpdate):
        """
        Update parameters with full validation.

        Example:
            api.update_parameters(ParameterUpdate(
                param_type=ParameterType.STRING_PHYSICS,
                targets=[60, 62, 64],
                values={'tension': 1.2, 'stiffness': 0.002}
            ))
        """
        # Validate
        update.validate()

        # Dispatch to appropriate handler
        if update.param_type == ParameterType.STRING_PHYSICS:
            self.param_manager.update_string_physics(
                update.targets, update.values
            )
        elif update.param_type == ParameterType.MODE:
            self.param_manager.update_mode_params(
                update.targets, update.values
            )
        # ... etc
```

**Benefits:**
- Type safety
- Clear API surface
- Easy to document
- Consistent validation

#### 3.2 Parameter Change Events

**Goal:** Notify system components when parameters change

**Design:**
```python
from typing import Callable, List

class ParameterChangeEvent:
    def __init__(self, param_type: ParameterType, targets: List[int], values: dict):
        self.param_type = param_type
        self.targets = targets
        self.values = values
        self.timestamp = time.time()

class ParameterManager:
    def __init__(self, ...):
        # ...
        self.listeners: List[Callable[[ParameterChangeEvent], None]] = []

    def add_listener(self, callback: Callable):
        """Register callback for parameter changes."""
        self.listeners.append(callback)

    def _notify_change(self, event: ParameterChangeEvent):
        """Notify all listeners of parameter change."""
        for callback in self.listeners:
            try:
                callback(event)
            except Exception as e:
                print(f"Listener error: {e}")

    def update_string_physics(self, pitches, params):
        # ... update logic ...

        # Notify listeners
        self._notify_change(ParameterChangeEvent(
            ParameterType.STRING_PHYSICS,
            pitches,
            params
        ))
```

**Use Cases:**
- Logging parameter changes
- Invalidating caches
- Triggering preset auto-save
- Sending parameter updates to frontend

### Phase 4: Preset System Improvements

#### 4.1 Add Preset Versioning

**Goal:** Support backward compatibility and migrations

**Design:**
```json
{
  "version": "2.0",
  "created": "2025-10-12T10:30:00Z",
  "model_parameters": { ... },
  "pitches": { ... },
  "modes": { ... }
}
```

```python
class PresetLoader:
    CURRENT_VERSION = "2.0"

    def load_preset(self, path: str) -> dict:
        with open(path) as f:
            preset = json.load(f)

        version = preset.get('version', '1.0')

        if version != self.CURRENT_VERSION:
            preset = self.migrate_preset(preset, version)

        return preset

    def migrate_preset(self, preset: dict, from_version: str) -> dict:
        """Migrate preset from old version to current."""
        if from_version == "1.0":
            preset = self._migrate_1_0_to_2_0(preset)
        # ... more migrations
        return preset

    def _migrate_1_0_to_2_0(self, preset: dict) -> dict:
        """Migrate v1.0 preset to v2.0."""
        # Add new fields with defaults
        # Rename old fields
        # ... migration logic
        preset['version'] = '2.0'
        return preset
```

#### 4.2 Parameter Schemas

**Goal:** Validate preset structure and parameter ranges

**Design:**
```python
from jsonschema import validate, ValidationError

PRESET_SCHEMA = {
    "type": "object",
    "required": ["version", "model_parameters", "pitches", "modes"],
    "properties": {
        "version": {"type": "string"},
        "model_parameters": {
            "type": "object",
            "properties": {
                "sample_rate": {"type": "integer", "minimum": 8000, "maximum": 192000},
                "array_size": {"type": "integer", "enum": [128, 256, 384, 512]},
                "num_strings": {"type": "integer", "minimum": 1, "maximum": 512},
                "num_modes": {"type": "integer", "minimum": 1, "maximum": 128},
                # ... more fields
            }
        },
        "pitches": {
            "type": "object",
            "patternProperties": {
                "^[0-9]+$": {  # Pitch ID (string number)
                    "type": "object",
                    "required": ["physics", "geometry", "hammer_shape", "excitation", "deck"],
                    "properties": {
                        "physics": {
                            "type": "object",
                            "properties": {
                                "tension": {"type": "number", "minimum": 0},
                                "stiffness": {"type": "number", "minimum": 0},
                                "damping": {"type": "number", "minimum": 0},
                                # ... more fields
                            }
                        },
                        # ... more sections
                    }
                }
            }
        },
        # ... more sections
    }
}

class PresetLoader:
    def load_preset(self, path: str) -> dict:
        with open(path) as f:
            preset = json.load(f)

        # Validate against schema
        try:
            validate(instance=preset, schema=PRESET_SCHEMA)
        except ValidationError as e:
            raise ValueError(f"Invalid preset file: {e.message}")

        return preset
```

### Phase 5: Documentation and Testing

#### 5.1 Document Parameter Flow

**Goals:**
- Complete API documentation
- Parameter range specifications
- Update this document as code changes

**Deliverables:**
- API reference (Sphinx or similar)
- Parameter catalog (all parameters with ranges, units, defaults)
- Flow diagrams (updated from this document)

#### 5.2 Add Parameter Validation Tests

**Goals:**
- Verify parameter range validation
- Test error handling
- Ensure thread safety

**Test Examples:**
```python
def test_physics_param_validation():
    """Test that invalid physics parameters are rejected."""
    api = PianoidAPI(pianoid)

    # Negative tension should fail
    with pytest.raises(ValueError):
        api.update_parameters(ParameterUpdate(
            param_type=ParameterType.STRING_PHYSICS,
            targets=[60],
            values={'tension': -1.0}
        ))

    # Valid parameters should succeed
    api.update_parameters(ParameterUpdate(
        param_type=ParameterType.STRING_PHYSICS,
        targets=[60],
        values={'tension': 1.2, 'stiffness': 0.002}
    ))

def test_partial_update_efficiency():
    """Test that updating one pitch doesn't repack all parameters."""
    api = PianoidAPI(pianoid)

    with mock.patch.object(api.param_manager.sm, 'pack_parameters') as mock_pack:
        api.update_parameters(ParameterUpdate(
            param_type=ParameterType.STRING_PHYSICS,
            targets=[60],
            values={'tension': 1.2}
        ))

        # Should NOT call full pack_parameters
        mock_pack.assert_not_called()

def test_concurrent_parameter_updates():
    """Test thread safety of concurrent parameter updates."""
    api = PianoidAPI(pianoid)

    def update_pitch(pitch_id):
        api.update_parameters(ParameterUpdate(
            param_type=ParameterType.STRING_PHYSICS,
            targets=[pitch_id],
            values={'tension': 1.0 + pitch_id * 0.01}
        ))

    # Launch 10 concurrent updates
    threads = [threading.Thread(target=update_pitch, args=(i,)) for i in range(60, 70)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Verify all updates succeeded
    for i in range(60, 70):
        assert pianoid.sm.pitches[i].physics['tension'] == pytest.approx(1.0 + i * 0.01)
```

### Implementation Timeline

**Week 1-2: Phase 1 (Critical Fixes)**
- Fix mode state allocation mismatch
- Fix excitation parameter update
- Test thoroughly

**Week 3-4: Phase 2 (Structural Improvements)**
- Implement ParameterManager
- Add partial parameter updates
- Reduce lock scope

**Week 5-6: Phase 3 (API Redesign)**
- Design and implement unified API
- Add parameter change events
- Update backendServer.py to use new API

**Week 7-8: Phase 4 (Preset System)**
- Add versioning
- Implement schema validation
- Create migration system

**Week 9-10: Phase 5 (Documentation and Testing)**
- Write comprehensive tests
- Generate API documentation
- Update this document

### Success Metrics

**Performance:**
- Single-pitch update time < 1ms (currently ~10ms due to full repack)
- API response time < 5ms (currently ~20ms due to locks)

**Code Quality:**
- Test coverage > 80%
- Zero threading issues in stress tests
- All parameters validated with schemas

**User Experience:**
- Clear error messages for invalid parameters
- Backward-compatible preset loading
- Consistent API behavior

---

## Conclusion

This document provides a comprehensive analysis of parameter flow in PianoidCore, covering:

1. **Four parameter categories**: String/pitch, hammer/excitation, mode, deck
2. **Four system layers**: Frontend (Flask), Middleware (Python), Domain (PianoidBasic), CUDA
3. **Complete flow diagrams**: Preset loading, string updates, mode updates, deck updates, excitation updates
4. **Critical issues**: Inconsistent update paths, redundant transformations, memory mismatches, unclear ownership
5. **Refactoring plan**: 5 phases from critical fixes to documentation

### Key Takeaways

**Current System:**
- ✅ Well-separated concerns (string physics vs modal synthesis)
- ✅ Thread-safe CUDA updates
- ✅ Comprehensive parameter coverage
- ❌ Inefficient (full repacking for partial updates)
- ❌ Inconsistent API
- ❌ Limited validation

**After Refactoring:**
- ✅ Fast partial updates
- ✅ Unified, type-safe API
- ✅ Comprehensive validation
- ✅ Better concurrency
- ✅ Backward-compatible presets
- ✅ Clear ownership and responsibility

### Next Steps

1. **Review** this document with the team
2. **Prioritize** which phases to implement first
3. **Prototype** ParameterManager to validate design
4. **Measure** current performance to establish baselines
5. **Implement** Phase 1 critical fixes immediately

---

**Document Status:** Complete - Ready for Review
**Last Updated:** 2025-10-12
**Next Review:** After Phase 1 implementation
