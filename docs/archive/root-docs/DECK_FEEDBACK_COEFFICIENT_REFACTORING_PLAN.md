# Deck Feedback Coefficient: Runtime Parameter Refactoring

**Created:** November 12, 2025
**Status:** 📋 Ready for Implementation
**Pattern:** Following Volume System Refactoring architecture (RuntimeParameters)
**Backward Compatibility:** 100% via dual-mode with compile-time selection
**Memory Savings:** 256 KB (float) / 512 KB (double)

---

## Executive Summary

**Goal:** Eliminate redundant feedback matrix by adding `deck_feedback_coefficient` as a **runtime parameter** alongside `volume_level`.

**Key Insight:** The feedback coefficient should follow the **exact same pattern** as the volume system refactoring:
- Add to existing `RuntimeParameters` structure
- Expose via `/set_runtime_parameters` endpoint (already exists!)
- MIDI integration via unused CC (e.g., CC 74 - Brightness/Filter Cutoff)
- Full backward compatibility via compile-time flag

**Memory Savings:** 256 KB (float) / 512 KB (double)

---

## Architecture Alignment with Volume System

### Current Volume System (Reference)

```cpp
// pianoid_cuda/Pianoid.cuh
struct RuntimeParameters {
    int volume_level = 64;     // 0-127, adjustable during playback
    // Future runtime parameters here
};
```

**REST API:**
```bash
POST /set_runtime_parameters
{"volume": 80}
```

**MIDI:** CC 7 → `volume_level`

### New Deck Coefficient (Same Pattern!)

```cpp
// pianoid_cuda/Pianoid.cuh
struct RuntimeParameters {
    int volume_level = 64;                    // Existing
    real deck_feedback_coefficient = 1.0;     // NEW!
};
```

**REST API** (same endpoint!):
```bash
POST /set_runtime_parameters
{"volume": 80, "feedback": 1.5}
```

**MIDI:** CC 74 (Brightness) → `deck_feedback_coefficient`

---

## Implementation Plan

### Phase 1: Core Parameter Addition (2-3 hours)

Following volume system exactly:

#### Step 1.1: Add to RuntimeParameters Structure

**File:** `pianoid_cuda/Pianoid.cuh`

```cpp
struct RuntimeParameters {
    int volume_level = 64;

    // NEW: Deck feedback coefficient
    // Relates feedback matrix to feedin matrix: feedback = feedin × coefficient
    // Default: 1.0 (unity coupling)
    // Range: typically 0.01 to 100.0 (will be determined from preset analysis)
    real deck_feedback_coefficient = 1.0;
};
```

#### Step 1.2: Update Python Bindings

**File:** `pianoid_cuda/AddArraysWithCUDA.cpp`

```cpp
py::class_<RuntimeParameters>(m, "RuntimeParameters")
    .def(py::init<>())
    .def(py::init<int>(), py::arg("volume_level"))
    .def(py::init<int, real>(),  // NEW constructor
         py::arg("volume_level"),
         py::arg("deck_feedback_coefficient"))
    .def_readwrite("volume_level", &RuntimeParameters::volume_level)
    .def_readwrite("deck_feedback_coefficient",  // NEW binding
                   &RuntimeParameters::deck_feedback_coefficient);
```

#### Step 1.3: Update setRuntimeParameters Validation

**File:** `pianoid_cuda/Pianoid.cu`

```cpp
bool Pianoid::setRuntimeParameters(const RuntimeParameters& params) {
    // Existing volume validation
    if (params.volume_level < 0 || params.volume_level > 127) {
        printf("ERROR: Invalid volume_level %d (must be 0-127)\n",
               params.volume_level);
        return false;
    }

    // NEW: Deck coefficient validation
    if (params.deck_feedback_coefficient <= 0.0 ||
        params.deck_feedback_coefficient > 1000.0) {
        printf("ERROR: Invalid deck_feedback_coefficient %f (must be 0 < coeff <= 1000)\n",
               params.deck_feedback_coefficient);
        return false;
    }

    runtime_params_ = params;

    // Calculate and update volume coefficient (existing)
    real volume_coefficient = calculateVolumeCoefficient();
    setNewVolume(volume_coefficient);

    // NEW: Update deck coefficient in cycle parameters
    cp_.deck_feedback_coefficient = params.deck_feedback_coefficient;

    return true;
}
```

---

### Phase 2: CUDA Kernel Updates (3-4 hours)

#### Step 2.1: Add Compile-Time Flag

**File:** `pianoid_cuda/constants.h`

```cpp
// ==================== DECK MATRIX MODE ====================
// 0 = Legacy dual-matrix mode (feedin + feedback separate)
// 1 = New single-matrix mode (feedin + runtime coefficient)
#ifndef USE_SINGLE_DECK_MATRIX
#define USE_SINGLE_DECK_MATRIX 0
#endif

#if USE_SINGLE_DECK_MATRIX
    #pragma message("Compiling with SINGLE deck matrix + runtime coefficient")
#else
    #pragma message("Compiling with DUAL deck matrices (legacy)")
#endif
```

#### Step 2.2: Update PresetParameters

**File:** `pianoid_cuda/PresetParameters.h`

```cpp
struct PianoidPresetParameters {
    // ... existing parameters ...

#if USE_SINGLE_DECK_MATRIX
    // NEW MODE: Single feedin matrix (feedback computed at runtime)
    real deck_coupling_parameters[NUM_STRINGS * NUM_MODES];
#else
    // LEGACY MODE: Dual matrices
    real deck_coupling_parameters[NUM_STRINGS * NUM_MODES * 2];
#endif

    // ... rest of parameters ...
};

// Update offsets
struct PresetParameterOffsets {
    // ... existing offsets ...

#if USE_SINGLE_DECK_MATRIX
    static constexpr size_t DECK_SIZE = NUM_STRINGS * NUM_MODES;  // Half size!
#else
    static constexpr size_t DECK_SIZE = NUM_STRINGS * NUM_MODES * 2;
#endif

    // ... rest remains same ...
};
```

#### Step 2.3: Update CycleParameters

**File:** `pianoid_cuda/CycleParameters.h`

```cpp
struct CycleParameters {
    // ... existing parameters ...

#if USE_SINGLE_DECK_MATRIX
    // NEW: Runtime feedback coefficient (transferred from RuntimeParameters)
    real deck_feedback_coefficient = 1.0;
#endif

    // ... rest of parameters ...
};
```

#### Step 2.4: Update MainKernel

**File:** `pianoid_cuda/MainKernel.cu` (lines 221-239)

```cpp
real mode_feedin[NUM_FOLDS_IN_QUARTER] = {0};
real mode_feedback[NUM_FOLDS_IN_QUARTER] = {0};
int foldedIndexInQuarter[NUM_FOLDS_IN_QUARTER] = {0};
int modeIndexInQuarter[NUM_FOLDS_IN_QUARTER] = {0};

#if USE_SINGLE_DECK_MATRIX
// ==================== NEW SINGLE-MATRIX MODE ====================
// Load runtime coefficient from cycle parameters
real feedback_coeff = cp.deck_feedback_coefficient;

for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    mode_feedback[i] = 0;
    mode_feedin[i] = 0;
    foldedIndexInQuarter[i] = indexInQuarter + quarterSize * i;
    int numBlockForTheFold = foldedIndexInQuarter[i] / numStringsInArray;

    if (numBlockForTheFold < numArrays) {
        modeIndexInQuarter[i] =
            (foldedIndexInQuarter[i] % numStringsInArray) * numArrays + numBlockForTheFold;
    }

    // Load FEEDIN coefficient
    if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numModes) {
        mode_feedin[i] = mode_coefficients[stringNoForQuarter * numModes + modeIndexInQuarter[i]];
    }

    // Compute FEEDBACK from feedin using runtime coefficient
    if (foldedIndexInQuarter[i] < numStrings && modeNo < numModes) {
        // Transpose access: feedback for string s from mode k uses feedin[s,k]
        real feedin_value = mode_coefficients[foldedIndexInQuarter[i] * numModes + modeNo];
        mode_feedback[i] = feedin_value * feedback_coeff;
    }
}

#else
// ==================== LEGACY DUAL-MATRIX MODE ====================
for (int i = 0; i < NUM_FOLDS_IN_QUARTER; i++) {
    mode_feedback[i] = 0;
    mode_feedin[i] = 0;
    foldedIndexInQuarter[i] = indexInQuarter + quarterSize * i;
    int numBlockForTheFold = foldedIndexInQuarter[i] / numStringsInArray;

    if (numBlockForTheFold < numArrays) {
        modeIndexInQuarter[i] =
            (foldedIndexInQuarter[i] % numStringsInArray) * numArrays + numBlockForTheFold;
    }

    // Load FEEDIN coefficient
    if (modeIndexInQuarter[i] < numModes && foldedIndexInQuarter[i] < numModes) {
        mode_feedin[i] = mode_coefficients[stringNoForQuarter * numModes + modeIndexInQuarter[i]];
    }

    // Load FEEDBACK coefficient from separate matrix
    if (foldedIndexInQuarter[i] < numStrings && modeNo < numModes) {
        mode_feedback[i] = mode_coefficients[
            numStrings * numModes +  // Offset to feedback matrix
            foldedIndexInQuarter[i] * numModes +
            modeNo  // FIXED: was hardcoded +5 (bug)
        ];
    }
}
#endif  // USE_SINGLE_DECK_MATRIX
```

---

### Phase 3: Python Middleware (2-3 hours)

#### Step 3.1: Add Wrapper Methods

**File:** `pianoid_middleware/pianoid.py`

Following volume system pattern exactly:

```python
def set_deck_feedback_coefficient(self, coefficient):
    """
    Set the deck feedback coefficient (runtime parameter).

    Args:
        coefficient (float): Feedback scaling factor (> 0, typically 0.01-100)

    Returns:
        bool: True if successful, False otherwise
    """
    with self.cuda_lock:  # Thread safety (learned from volume system!)
        runtime_params = self.pianoid.getRuntimeParameters()
        runtime_params.deck_feedback_coefficient = coefficient
        success = self.pianoid.setRuntimeParameters(runtime_params)

    if success:
        print(f"Deck feedback coefficient set to {coefficient}")
    else:
        print(f"ERROR: Failed to set deck feedback coefficient to {coefficient}")

    return success


def get_deck_feedback_coefficient(self):
    """
    Get current deck feedback coefficient.

    Returns:
        float: Current feedback coefficient
    """
    with self.cuda_lock:
        runtime_params = self.pianoid.getRuntimeParameters()
    return runtime_params.deck_feedback_coefficient
```

#### Step 3.2: Update pack_deck()

**File:** `.venv/Lib/site-packages/Pianoid/StringMap.py`

```python
def pack_deck(self, pack_for_cuda=True):
    """
    Pack deck coupling parameters.

    Returns:
        If pack_for_cuda=True:
            - New mode (USE_SINGLE_DECK_MATRIX=1): feedin only
            - Legacy mode (USE_SINGLE_DECK_MATRIX=0): feedin + feedback
        If pack_for_cuda=False:
            - Tuple: (feedin, feedback, computed_coefficient)
    """
    import pianoidCuda

    feedin = np.stack([self.pack_pitch_feedin(pitchID)
                       for pitchID in self.pitch_index])
    feedback = np.stack([ext_to_the_right(self.pitches[pitchID].deck['feedback'],
                        self.mp.num_modes_for_model)
                        for pitchID in self.pitch_index])

    if pack_for_cuda:
        # Check compile-time mode
        use_single_matrix = getattr(pianoidCuda, 'USE_SINGLE_DECK_MATRIX', 0)

        if use_single_matrix:
            # NEW MODE: Pack only feedin (coefficient set via RuntimeParameters)
            return feedin.ravel().tolist()
        else:
            # LEGACY MODE: Pack both matrices
            return feedin.ravel().tolist() + feedback.ravel().tolist()
    else:
        # For analysis/charts: return all, including computed coefficient
        coefficient = self.compute_deck_feedback_coefficient(feedin, feedback)
        return feedin, feedback, coefficient


def compute_deck_feedback_coefficient(self, feedin, feedback):
    """
    Compute the coefficient relating feedin to feedback.
    Used for preset analysis and validation.

    Returns: median(feedback[s,k] / feedin[s,k]) for non-zero feedin
    """
    ratios = []
    for s in range(feedin.shape[0]):
        for k in range(feedin.shape[1]):
            if abs(feedin[s, k]) > 1e-6:
                ratios.append(feedback[s, k] / feedin[s, k])

    if len(ratios) == 0:
        print("WARNING: No valid feedin values to compute coefficient!")
        return 1.0

    coefficient = float(np.median(ratios))
    std_dev = float(np.std(ratios))

    print(f"Computed deck feedback coefficient: {coefficient:.6f} (std: {std_dev:.6f})")

    if std_dev > 0.1 * abs(coefficient):
        print(f"WARNING: Large variation in feedback/feedin ratio (CV = {std_dev/abs(coefficient)*100:.1f}%)")

    return coefficient
```

---

### Phase 4: REST API Integration (1 hour)

#### Step 4.1: Update Existing Endpoint

**File:** `pianoid_middleware/backendServer.py`

The `/set_runtime_parameters` endpoint **already exists** from volume system! Just extend it:

```python
@app.route('/set_runtime_parameters', methods=['POST'])
def set_runtime_parameters():
    """
    Set runtime parameters that can be adjusted during playback.

    Supported parameters:
    - volume: MIDI volume level (0-127)
    - feedback: Feedback scaling factor (> 0, typically 0.01-100)

    Example:
        POST /set_runtime_parameters
        {"volume": 80, "feedback": 1.5}
    """
    if not request.is_json:
        return jsonify({'error': 'Content-Type must be application/json'}), 400

    data = request.get_json()
    updated = {}
    errors = []

    # Existing: Volume parameter
    if 'volume' in data:
        try:
            volume = int(data['volume'])
            if 0 <= volume <= 127:
                success = pianoid.set_volume_level(volume)
                if success:
                    updated['volume'] = volume
                else:
                    errors.append(f"Failed to set volume to {volume}")
            else:
                errors.append(f"Volume must be 0-127, got {volume}")
        except (ValueError, TypeError) as e:
            errors.append(f"Invalid volume value: {e}")

    # NEW: Deck feedback coefficient
    if 'feedback' in data:
        try:
            coeff = float(data['feedback'])
            if coeff > 0 and coeff <= 1000:
                success = pianoid.set_deck_feedback_coefficient(coeff)
                if success:
                    updated['feedback'] = coeff
                else:
                    errors.append(f"Failed to set feedback coefficient to {coeff}")
            else:
                errors.append(f"feedback must be 0 < coeff <= 1000, got {coeff}")
        except (ValueError, TypeError) as e:
            errors.append(f"Invalid feedback value: {e}")

    if errors:
        return jsonify({'message': 'Partial success' if updated else 'Failed',
                       'updated': updated,
                       'errors': errors}), 400 if not updated else 200

    return jsonify({'message': 'OK', 'updated': updated}), 200
```

**No new endpoint needed!** This is the beauty of following the volume system pattern.

---

### Phase 5: MIDI Integration (1 hour)

#### Step 5.1: Map to MIDI CC

**File:** `pianoid_middleware/pianoidMidiListener.py`

Choose unused CC (recommendation: CC 74 - Brightness):

```python
def process_cc(self, pitch, controller, value):
    """Process MIDI Control Change messages"""

    # Existing CCs
    if controller == 7:    # Volume
        self.main_volume(pitch, value)
    elif controller == 64:  # Sustain
        self.sustain(pitch, value)
    elif controller == 74:  # Brightness (NEW: Deck feedback coefficient)
        self.deck_feedback(pitch, value)
    # ... other CCs ...


def deck_feedback(self, pitch, value):
    """
    MIDI CC 74 (Brightness) controls deck feedback coefficient.

    Maps MIDI value (0-127) to coefficient range.
    - MIDI 0   → coefficient 0.01 (minimal feedback)
    - MIDI 64  → coefficient 1.0  (unity feedback)
    - MIDI 127 → coefficient 100.0 (maximum feedback)

    Uses exponential mapping for intuitive control.
    """
    # Exponential mapping: 0.01 to 100 over 0-127 range
    # coefficient = 0.01 × 10^(4 × value/127)
    import math

    min_coeff = 0.01
    max_coeff = 100.0
    normalized = value / 127.0  # 0.0 to 1.0

    # Exponential interpolation
    log_min = math.log10(min_coeff)  # -2
    log_max = math.log10(max_coeff)  # 2
    log_coeff = log_min + normalized * (log_max - log_min)
    coefficient = 10 ** log_coeff

    print(f"MIDI CC 74: value={value} → deck_feedback_coefficient={coefficient:.3f}")
    self.p.set_deck_feedback_coefficient(coefficient)
```

**MIDI Mapping Table:**

| MIDI Value | Coefficient | Description |
|------------|-------------|-------------|
| 0 | 0.01 | Minimal feedback |
| 32 | 0.1 | Reduced feedback |
| 64 | 1.0 | **Unity (default)** |
| 96 | 10.0 | Enhanced feedback |
| 127 | 100.0 | Maximum feedback |

---

### Phase 6: Testing (2-3 hours)

#### Test 6.1: Coefficient Analysis

**Create tool:** `tools/analyze_deck_coefficient.py`

```python
"""Analyze feedback/feedin relationship in existing presets."""
import numpy as np
import json
from pathlib import Path

def analyze_preset(preset_path):
    with open(preset_path) as f:
        preset = json.load(f)

    feedin = np.array(preset['deck_parameters']['feedin'])
    feedback = np.array(preset['deck_parameters']['feedback'])

    # Compute ratios
    ratios = []
    for s in range(feedin.shape[0]):
        for k in range(feedin.shape[1]):
            if abs(feedin[s, k]) > 1e-6:
                ratios.append(feedback[s, k] / feedin[s, k])

    if len(ratios) == 0:
        return None

    ratios = np.array(ratios)
    return {
        'file': preset_path.name,
        'median': np.median(ratios),
        'mean': np.mean(ratios),
        'std': np.std(ratios),
        'cv': np.std(ratios) / abs(np.mean(ratios)) * 100  # Coefficient of variation
    }

# Run on all presets
for preset_file in Path('presets').glob('*.json'):
    result = analyze_preset(preset_file)
    if result:
        print(f"{result['file']}: coeff={result['median']:.6f}, CV={result['cv']:.1f}%")
```

**Expected Result:** CV < 10% means single coefficient is valid.

#### Test 6.2: Runtime Adjustment Test

```python
def test_runtime_deck_coefficient():
    """Test adjusting feedback coefficient during playback."""
    import pianoidCuda

    # Initialize
    pianoid.init_pianoid(max_volume=10000.0)

    # Start playback
    pianoid.start_realtime_playback()

    # Test coefficient changes
    for coeff in [0.1, 0.5, 1.0, 2.0, 10.0]:
        print(f"Testing coefficient: {coeff}")
        success = pianoid.set_deck_feedback_coefficient(coeff)
        assert success

        # Verify
        current = pianoid.get_deck_feedback_coefficient()
        assert abs(current - coeff) < 1e-6

        # Play note and listen
        time.sleep(2)

    pianoid.pause_playback()
    print("✓ Runtime deck coefficient test passed")
```

#### Test 6.3: REST API Test

```bash
# Test endpoint
curl -X POST http://localhost:5000/set_runtime_parameters \
  -H "Content-Type: application/json" \
  -d '{"volume": 80, "feedback": 1.5}'

# Expected response
{"message": "OK", "updated": {"volume": 80, "feedback": 1.5}}
```

#### Test 6.4: MIDI Test

```python
def test_midi_deck_coefficient():
    """Test MIDI CC 74 controls deck feedback coefficient."""
    import rtmidi

    # Send MIDI CC 74
    midi_values = [0, 32, 64, 96, 127]
    expected_coeffs = [0.01, 0.1, 1.0, 10.0, 100.0]

    for midi_val, expected_coeff in zip(midi_values, expected_coeffs):
        # Send MIDI CC 74 (Brightness) with value
        send_midi_cc(channel=0, controller=74, value=midi_val)
        time.sleep(0.1)

        # Verify coefficient changed
        actual_coeff = pianoid.get_deck_feedback_coefficient()
        assert abs(actual_coeff - expected_coeff) / expected_coeff < 0.01  # 1% tolerance

        print(f"✓ MIDI {midi_val} → coefficient {actual_coeff:.3f} (expected {expected_coeff:.3f})")
```

---

## Build System Integration

### Build Configuration

**File:** `pianoid_cuda/build_config.json`

```json
{
  "default_audio_driver": "SDL3",
  "deck_matrix_mode": "dual",
  "compiler_flags": []
}
```

**File:** `build.py`

```python
# Add build argument
parser.add_argument('--single-deck', action='store_true',
                   help='Use single deck matrix mode (NEW)')
parser.add_argument('--dual-deck', action='store_true',
                   help='Use legacy dual deck matrix mode (default)')

# Set compile flag
if args.single_deck:
    defines.append('-DUSE_SINGLE_DECK_MATRIX=1')
elif args.dual_deck:
    defines.append('-DUSE_SINGLE_DECK_MATRIX=0')
else:
    # Read from config
    config = load_build_config()
    mode = config.get('deck_matrix_mode', 'dual')
    defines.append(f'-DUSE_SINGLE_DECK_MATRIX={1 if mode == "single" else 0}')
```

**Usage:**

```bash
# Build with legacy dual-matrix mode (default)
python build.py

# Build with new single-matrix mode
python build.py --single-deck

# Change default in config
# Edit build_config.json: "deck_matrix_mode": "single"
```

---

## Timeline

### Week 1: Core Implementation
- **Day 1-2:** CUDA core (Phases 1-2)
  - Add to RuntimeParameters
  - Update PresetParameters with #ifdef
  - Update MainKernel coefficient loading
  - Fix bug on line 237

- **Day 3:** Python middleware (Phase 3)
  - Add wrapper methods
  - Update pack_deck()
  - Test both modes compile

- **Day 4:** API integration (Phases 4-5)
  - Extend /set_runtime_parameters
  - Add MIDI CC 74 handler
  - Build and test

- **Day 5:** Initial testing
  - Run coefficient analysis on presets
  - Runtime adjustment tests
  - REST API tests
  - MIDI tests

### Week 2: Validation
- **Days 6-8:** Extensive testing
  - Audio comparison (dual vs single mode)
  - Performance benchmarks
  - Memory validation
  - Edge cases

- **Days 9-10:** Documentation
  - Update technical docs
  - Create usage guide
  - API documentation

### Week 3: Transition
- **Day 11:** Switch default to single-matrix mode
- **Days 12-14:** Monitoring and bug fixes

### Week 4-5: Cleanup (After Validation)
- Remove #ifdef blocks
- Clean up legacy code
- Final documentation
- Create refactoring summary

---

## Success Criteria

### Phase 1-5 Complete When:
- [ ] Coefficient analysis shows CV < 10% (validates approach)
- [ ] Both modes compile and run
- [ ] Runtime coefficient adjustable via Python API
- [ ] REST endpoint works: `POST /set_runtime_parameters {"deck_feedback_coefficient": 1.5}`
- [ ] MIDI CC 74 controls coefficient
- [ ] All tests pass

### Validation Complete When:
- [ ] Audio output identical between modes (<0.01% error)
- [ ] Performance comparable (within 5%)
- [ ] Memory usage reduced by 256 KB in single mode
- [ ] No thread safety issues
- [ ] No audio glitches during coefficient changes

### Cleanup Complete When:
- [ ] Legacy code removed (#ifdef blocks gone)
- [ ] Single-matrix mode is default
- [ ] Documentation updated
- [ ] Refactoring summary written
- [ ] Changes merged to dev

---

## API Summary

### C++ API

```cpp
// Add to existing RuntimeParameters structure
struct RuntimeParameters {
    int volume_level = 64;
    real deck_feedback_coefficient = 1.0;  // NEW
};

// Existing method (no changes needed!)
bool setRuntimeParameters(const RuntimeParameters& params);
RuntimeParameters getRuntimeParameters() const;
```

### Python API

```python
# New methods (following volume pattern)
pianoid.set_deck_feedback_coefficient(1.5)
coeff = pianoid.get_deck_feedback_coefficient()

# Or direct structure access
import pianoidCuda
runtime_params = pianoidCuda.RuntimeParameters(volume_level=80,
                                                deck_feedback_coefficient=1.5)
pianoid.pianoid.setRuntimeParameters(runtime_params)
```

### REST API

```bash
# Extends existing endpoint (clean and simple!)
POST /set_runtime_parameters
{
  "volume": 80,
  "feedback": 1.5
}
```

### MIDI API

- **CC 74 (Brightness):** Controls deck_feedback_coefficient
  - 0-127 → 0.01 to 100 (exponential)
  - Default (64) → 1.0 (unity)

---

## Advantages of This Approach

### 1. Follows Proven Pattern
- Volume system refactoring already validated this architecture
- Same structure, same endpoint, same MIDI approach
- Reduces risk and implementation time

### 2. Runtime Adjustable
- Can tweak feedback coefficient during playback
- MIDI control for live performance
- No need to reload presets

### 3. Minimal Code Changes
- Extends existing RuntimeParameters (1 line!)
- Reuses existing /set_runtime_parameters endpoint
- No new API surface area

### 4. Thread Safe
- Inherits cuda_lock protection from volume system
- Learned from volume system bugs

### 5. Unified Parameter System
- Volume, deck coefficient, (future: sustain, expression, etc.)
- All runtime parameters in one place
- Consistent API across all parameters

---

## Next Steps

1. **Run coefficient analysis:**
   ```bash
   python tools/analyze_deck_coefficient.py
   ```
   Verify CV < 10% to confirm single coefficient approach is valid.

2. **Create git branch:**
   ```bash
   git checkout -b feature/deck-feedback-coefficient
   ```

3. **Start Phase 1:** Add `deck_feedback_coefficient` to `RuntimeParameters`

4. **Follow volume system commits as template:**
   - Look at commits `98b4380`, `fbdac4d`, `74053de`, etc.
   - Apply same pattern to deck coefficient

---

**Document Version:** 3.0 (Final)
**Pattern:** Following Volume System Refactoring
**Status:** 📋 Ready for Implementation
**Next Action:** Run coefficient analysis script

**Questions?** Contact: astrinleonid@digitalstringspiano.com
