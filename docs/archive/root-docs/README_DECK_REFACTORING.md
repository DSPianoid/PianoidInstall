# Deck Feedback Coefficient Refactoring - Quick Start

**Status:** 📋 Planning Complete, Ready for Implementation
**Created:** November 12, 2025

---

## What This Refactoring Does

Eliminates the redundant **feedback matrix** by adding a single runtime coefficient, saving **256 KB (float) / 512 KB (double)** of GPU memory.

### Current Architecture
```
Feedin Matrix:   256 strings × 256 modes = 65,536 reals
Feedback Matrix: 256 strings × 256 modes = 65,536 reals  ← REDUNDANT!
Total: 131,072 reals (512 KB float / 1 MB double)
```

### New Architecture
```
Feedin Matrix: 256 strings × 256 modes = 65,536 reals
Coefficient: feedback = feedin × deck_feedback_coefficient  ← Runtime parameter!
Total: 65,536 reals (256 KB float / 512 KB double)

Memory Savings: 50% of deck parameters
```

---

## Key Design Decisions

### 1. Runtime Parameter (Like Volume!)

Follows the **exact same pattern** as the recently completed Volume System Refactoring:

```cpp
struct RuntimeParameters {
    int volume_level = 64;                    // Existing
    real deck_feedback_coefficient = 1.0;     // NEW!
};
```

### 2. Same REST Endpoint

```bash
POST /set_runtime_parameters
{
  "volume": 80,      # Existing
  "feedback": 1.5    # NEW!
}
```

### 3. MIDI Integration

- **CC 74 (Brightness)** → controls coefficient
- Exponential mapping: MIDI 0-127 → coefficient 0.01 to 100
- Default (MIDI 64) → coefficient 1.0

### 4. Dual-Mode Implementation

Compile-time flag for gradual transition:

```cpp
#define USE_SINGLE_DECK_MATRIX 0  // 0=legacy (dual), 1=new (single+coeff)
```

---

## Documentation Structure

### Planning Documents

1. **[DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md](DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md)** (Main Plan)
   - Complete implementation guide
   - 6 phases over 2-3 weeks
   - Code examples for all layers (C++, Python, REST, MIDI)
   - Testing strategy
   - Timeline and success criteria

2. **[FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md](FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md)** (Technical Analysis)
   - Deep dive into current architecture
   - Physical model explanation
   - Memory layout details
   - Mathematical foundations
   - Bug identified: MainKernel.cu:237

3. **[docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md](docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md)** (Reference)
   - Template for this refactoring
   - Shows the pattern we're following
   - Lessons learned (thread safety, etc.)

---

## Implementation Timeline

### Week 1: Core Implementation
- **Days 1-2:** CUDA core (add to RuntimeParameters, update kernel)
- **Day 3:** Python middleware (wrapper methods, pack_deck updates)
- **Day 4:** REST & MIDI integration
- **Day 5:** Initial testing

### Week 2: Validation
- **Days 6-8:** Audio comparison, performance benchmarks
- **Days 9-10:** Documentation updates

### Week 3: Transition
- **Day 11:** Switch default to new mode
- **Days 12-14:** Monitoring

### Week 4-5: Cleanup
- Remove `#ifdef` blocks
- Clean up legacy code
- Final documentation

---

## Quick Reference: What to Modify

### C++ Core (`pianoid_cuda/`)
- `Pianoid.cuh` - Add to RuntimeParameters (1 line!)
- `Pianoid.cu` - Update setRuntimeParameters validation
- `constants.h` - Add USE_SINGLE_DECK_MATRIX flag
- `PresetParameters.h` - Add #ifdef for dual-mode
- `CycleParameters.h` - Add coefficient field
- `MainKernel.cu` - Update coefficient loading (fix bug on line 237)
- `AddArraysWithCUDA.cpp` - Add Python binding

### Python Middleware (`pianoid_middleware/`)
- `pianoid.py` - Add set/get methods (copy volume pattern)
- `backendServer.py` - Extend /set_runtime_parameters endpoint
- `pianoidMidiListener.py` - Add CC 74 handler

### Pianoid Package (`.venv/Lib/site-packages/Pianoid/`)
- `StringMap.py` - Update pack_deck() for dual-mode
- `Pitch.py` - No changes needed (backward compatible)

### Build System
- `build.py` - Add --single-deck / --dual-deck flags
- `build_config.json` - Add deck_matrix_mode option

---

## Before You Start

### Step 1: Run Coefficient Analysis

Verify that the single coefficient approach is valid:

```bash
python tools/analyze_deck_coefficient.py
```

**Expected:** Coefficient of Variation (CV) < 10%

### Step 2: Review Volume System

Study the volume refactoring as a template:

```bash
# Look at these commits:
git show 98b4380  # Stage 1: Add structures
git show fbdac4d  # Stage 2: Structure-level API
git show 74053de  # Stage 3: Python wrappers
git show c7b1fc7  # Stage 4: Backend API
git show 30f9f46  # Stage 5: MIDI integration
```

### Step 3: Create Branch

```bash
git checkout -b feature/deck-feedback-coefficient
```

---

## Success Criteria

### Phase 1-5 Complete When:
- [ ] Both modes compile and run
- [ ] Coefficient adjustable via Python/REST/MIDI
- [ ] All tests pass
- [ ] No thread safety issues

### Validation Complete When:
- [ ] Audio output identical (<0.01% error)
- [ ] Performance comparable (within 5%)
- [ ] Memory reduced by 256 KB
- [ ] No audio glitches

### Cleanup Complete When:
- [ ] Legacy code removed
- [ ] Single-matrix mode is default
- [ ] Documentation updated
- [ ] Changes merged to dev

---

## API Summary

### C++ API
```cpp
// Extend existing structure
struct RuntimeParameters {
    int volume_level;
    real deck_feedback_coefficient;  // NEW
};

// Use existing method
bool setRuntimeParameters(const RuntimeParameters& params);
```

### Python API
```python
# New methods (following volume pattern)
pianoid.set_deck_feedback_coefficient(1.5)
coeff = pianoid.get_deck_feedback_coefficient()
```

### REST API
```bash
POST /set_runtime_parameters
{"volume": 80, "feedback": 1.5}
```

### MIDI API
- **CC 74 (Brightness):** 0-127 → 0.01 to 100 (exponential)

---

## Questions?

- **Main Plan:** [DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md](DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md)
- **Technical Analysis:** [FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md](FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md)
- **Volume System Reference:** [docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md](docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md)
- **Contact:** astrinleonid@digitalstringspiano.com

---

**Ready to start?** Begin with Phase 1 in the main plan!
