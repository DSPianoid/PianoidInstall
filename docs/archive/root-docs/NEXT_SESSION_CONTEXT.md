# Next Session Context - Pianoid Parameter System

**Date Created:** November 9, 2025
**Purpose:** Onboarding context for future development sessions
**Status:** Ready for next steps implementation

---

## 🎯 Quick Start

### What is Pianoid?

**Pianoid** is a **real-time GPU-accelerated modal synthesis engine** for physically-modeled string instruments (piano, harpsichord, etc.). It combines **finite difference time-domain (FDTD) string simulation** with **modal acoustic resonator modeling** to create highly realistic instrument sounds.

**System Architecture:**
- **256 concurrent strings** simulated in parallel on CUDA GPU
- **64 acoustic modes** representing soundboard/body resonances
- **4-layer parameter system** (REST API → Python Middleware → PianoidBasic Processing → CUDA Kernels)
- **~180 MB unified GPU memory** managed by UnifiedGpuMemoryManager
- **Real-time performance:** <5ms parameter update latency, 48 kHz audio output
- **Hybrid playback:** Online real-time MIDI + offline rendering with EventQueue architecture

**Core Technologies:**
- **CUDA/C++** - GPU computation (Pianoid.cu ~4000 lines)
- **Python/Flask** - REST API middleware (pianoid.py ~2000 lines)
- **PianoidBasic** - Parameter processing package (StringMap, Pitch, Mode classes)
- **Modal synthesis** - Acoustic modeling via coupled oscillators
- **Physical modeling** - Wave equation discretization for string dynamics

**Purpose:** Provide a complete synthesis engine that bridges high-level musical parameters (pitch, velocity, timbre) with low-level physics simulation, enabling expressive digital string instruments with realistic sound and behavior.

---

### Current Work: Parameter System Refactoring

You're working on the **Pianoid parameter system** - the subsystem responsible for managing and updating the ~50+ parameters that control string physics, hammer characteristics, excitation profiles, and acoustic modes. The parameter system has been refactored through **Phases 0-6C** and documentation has been fully consolidated.

### Current Status: **90% Complete - Production Ready**

**What's working:**
- ✅ UnifiedGpuMemoryManager (180 MB unified GPU memory)
- ✅ Double-buffering with async updates (<5ms latency)
- ✅ Granular API for string/physics parameters (85x bandwidth improvement)
- ✅ 40x note triggering bandwidth reduction (Phase 0)

**What needs fixing:**
- ❌ **CRITICAL BUG:** Hammer updates don't reach CUDA (missing one line)
- ⚠️ Excitation, mode, deck parameters still use bulk uploads (inefficient)

---

## 📚 Essential Documentation

### Primary References (Read These First)

1. **[PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md)** - **v6.0** ⭐ START HERE
   - Single comprehensive entry point (1,600 lines)
   - Four-layer architecture explained
   - Phase 0-6C implementation history
   - Complete API reference and function inventory
   - **Critical bug documentation** (hammer update bug at line 438-468)
   - Migration roadmap with priorities (lines 715-1024)

2. **[PIANOIDBASIC_PARAMETER_MANAGEMENT_DOCUMENTATION.md](PIANOIDBASIC_PARAMETER_MANAGEMENT_DOCUMENTATION.md)**
   - Technical deep dive (3,200 lines)
   - Layer 3 (PianoidBasic) processing details
   - Mathematical formulas (wave equation, detuning, Gaussian curves)
   - Complete class hierarchy

3. **[DOCUMENTATION_INDEX.md](DOCUMENTATION_INDEX.md)**
   - Navigation guide for all documentation
   - Recently updated (Nov 9, 2025)

### Quick Reference Documents

4. **[PARAMETER_SYSTEM_CONSOLIDATION_SUMMARY.md](PARAMETER_SYSTEM_CONSOLIDATION_SUMMARY.md)**
   - Summary of Nov 9, 2025 documentation consolidation
   - Document structure overview
   - Version history

5. **[PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md)**
   - Application-level documentation
   - REST API reference
   - Deployment guide

---

## 🏗️ System Architecture (4 Layers)

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: REST API (Flask - backendServer.py)                  │
│  Routes: /set_parameter/<type>/<key>                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Middleware (Python - pianoid.py)                     │
│  • update_parameter() - Routes by type                         │
│  • update_pitch_physical_params_GRANULAR() - ✅ NEW           │
│  • send_updated_params_to_CUDA() - ⚠️ LEGACY BULK            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Domain (PianoidBasic package)                        │
│  Location: ../PianoidBasic/Pianoid/                            │
│  Import: from Pianoid import StringMap, ModeMap, Pitch         │
│  • Parameter packing/unpacking                                 │
│  • Mathematical processing (finite differences, interpolation) │
│  • Physical modeling (wave equation, mode oscillators)         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: CUDA Core (C++/CUDA - Pianoid.cu)                   │
│  • updateMultiStringParameter_NEW() - ✅ GRANULAR API         │
│  • setNew*Parameters() - ⚠️ TRANSITIONAL BULK APIs           │
│  • UnifiedGpuMemoryManager - Memory management                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Files:**
- **Layer 1:** `pianoid_middleware/backendServer.py` (Flask REST API)
- **Layer 2:** `pianoid_middleware/pianoid.py` (Middleware orchestrator)
- **Layer 3:** `../PianoidBasic/Pianoid/` (Python package with StringMap, Pitch, Mode classes)
- **Layer 4:** `pianoid_cuda/Pianoid.cu` (CUDA implementation)
- **Memory Manager:** `pianoid_cuda/UnifiedGpuMemoryManager.h/.cu`

---

## 🔴 Critical Bug (Fix First - 15 minutes)

### Hammer Update Bug

**Location:** `pianoid_middleware/pianoid.py:1830-1833`

**Problem:** Hammer parameter updates only modify Python-side data but never transfer to GPU.

**Current broken code:**
```python
elif param == 'hammer':
    for pitchID in pitches:
        pitch = self.sm.pitches[pitchID]
        self.sm.update_hammer_shape(pitchID, values[str(pitchID)])
    # ❌ MISSING: GPU transfer!
```

**Fix (add one line):**
```python
elif param == 'hammer':
    for pitchID in pitches:
        pitch = self.sm.pitches[pitchID]
        self.sm.update_hammer_shape(pitchID, values[str(pitchID)])
    # ✅ ADD THIS LINE:
    self.send_updated_params_to_CUDA()
```

**Impact:** CRITICAL - Hammer shape changes currently don't take effect

**Reference:** PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md lines 438-468, 718-743

---

## 📋 Next Steps (Prioritized)

### Priority 1: Critical Fixes (Est: 1.25 hours)

#### 1. Fix Hammer Bug ❌ **15 minutes**
- **File:** `pianoid_middleware/pianoid.py:1830-1833`
- **Action:** Add `self.send_updated_params_to_CUDA()` after line 1833
- **Test:** Change hammer parameters via REST API and verify audio output changes
- **Reference:** Unified doc lines 718-743

#### 2. Add Deprecation Markers ❌ **1 hour**
- **Files:** `pianoid_cuda/Pianoid.cu`, `pianoid_cuda/Pianoid.cuh`
- **Functions to mark:**
  - `setNewVolume()` (line 955) - Bypasses memory manager
  - `setNewCycleParameters()` (lines 959, 990) - Direct cudaMemcpy
- **Template:**
  ```cpp
  // DEPRECATED: Bypasses UnifiedGpuMemoryManager, may cause async conflicts.
  // Use memory_manager_.updateTunableParameter() instead.
  // TODO: Remove after all call sites migrated.
  ```
- **Reference:** Unified doc lines 747-764

### Priority 2: Performance Optimizations (Est: 14 hours)

#### 3. Migrate Excitation to Granular API ⚡ **8 hours** - **260x bandwidth reduction!**
- **Current:** 2.6 MB uploaded per pitch update (all 256 pitches)
- **Target:** 10 KB per pitch update (only changed pitch)
- **Location:** `pianoid_middleware/pianoid.py:1824-1828`
- **Approach:**
  - Option A: Extend existing granular API to excitation parameters
  - Option B: Create specialized `updateExcitationParametersForPitch()` method
- **Reference:** Unified doc lines 800-849

#### 4. Convert Void Functions to Return Bool ❌ **2 hours**
- **Functions to update:**
  - `setNewVolume()` → add error handling, return bool
  - `setNewCycleParameters()` → add error handling, return bool
  - `loadPresetToLibrary()` → add error handling, return bool
- **Benefit:** Enable error detection and propagation
- **Reference:** Unified doc lines 851-877

#### 5. Create Granular Mode API ❌ **4 hours**
- **Current:** Uploads entire mode state buffer (5 KB)
- **Target:** Update single mode parameters
- **New API:**
  ```cpp
  bool updateSingleModeParameter(
      int mode_index,
      const std::string& param_name,
      real value
  );
  ```
- **Reference:** Unified doc lines 879-901

### Priority 3: Architecture Improvements (Est: 22 hours)

#### 6. Phase Out send_updated_params_to_CUDA() ❌ **2 hours**
- **Condition:** After all parameter types use granular API
- **Action:** Mark as deprecated, add warning
- **Reference:** Unified doc lines 905-918

#### 7. Consolidate Initialization Flow ❌ **4 hours**
- **Problem:** Dual path in `setUpdatedParameters()` (init vs runtime)
- **Solution:** Make preset loading mandatory, remove init fallback
- **Reference:** Unified doc lines 920-946

#### 8. Phase 6D-G Enhancements ❌ **16 hours**
- **6D:** Multi-parameter batch updates (4 hours)
- **6E:** Detuning enhancements (2 hours)
- **6F:** Full integration and old API deprecation (4 hours)
- **6G:** Partial buffer optimization (6 hours)
- **Reference:** Unified doc lines 948-973

---

## 🎓 Key Concepts to Understand

### 1. Two-Stage Update Pattern

**Critical Pattern:** PianoidBasic API calls operate in two stages:

```python
# Stage 1: Update host-side (PianoidBasic modifies Python data)
self.sm.update_hammer_shape(pitchID, params)  # Python-only

# Stage 2: Transfer to GPU (Middleware must explicitly call CUDA update)
self.send_updated_params_to_CUDA()  # Packs and uploads to GPU
```

**The hammer bug occurs because Stage 2 is missing!**

### 2. Granular vs Bulk APIs

**Bulk API (Legacy - Inefficient):**
```python
# Updates ALL 256 strings (2.7 MB transfer)
self.send_updated_params_to_CUDA()
```

**Granular API (New - Efficient):**
```python
# Updates only 3 strings for one pitch (~85x faster)
self.pianoid.updateMultiStringParameter_NEW(
    param_name="tension",
    string_indices=[120, 121, 122],  # Only these strings
    new_values=[350.0, 350.6, 351.2]  # With detuning applied
)
```

### 3. UnifiedGpuMemoryManager

**Manages ~180 MB GPU memory in 5 categories:**
- **TUNABLE** (~6.3 MB double-buffered): Parameters that change at runtime
  - physical_parameters, hammer, gauss_params, mode_state, deck_parameters
- **STATIC_INPUT** (~3 MB): Initialized once, never changes
- **WORKING** (~45 MB): Scratch buffers for computation
- **OUTPUT** (~120 MB): Audio output buffers
- **FILTER_SYSTEM** (~10 MB): FIR filter buffers

**Key features:**
- Async double-buffering for TUNABLE parameters
- Background polling thread
- Atomic buffer swapping
- <5ms update latency

### 4. Parameter Flow Example (String/Physics)

```
1. REST API: POST /set_parameter/string/60 {"tension": 350}
   ↓
2. backendServer.py:319 → set_parameter()
   ↓
3. pianoid.py:1811 → update_parameter()
   ↓
4. pianoid.py:1842-1846 → Branch to granular API
   ↓
5. pianoid.py:1494 → update_pitch_physical_params_GRANULAR()
   • Gets string_cuda_indices [120, 121, 122]
   • Applies detuning: tension *= (1 + i * 0.002)
   ↓
6. Pianoid.cu:901 → updateMultiStringParameter_NEW()
   • Reads buffer ONCE
   • Modifies 3 string elements
   • Uploads buffer ONCE
   ↓
7. UnifiedGpuMemoryManager → async double-buffered update
   ↓
8. GPU Memory: dev_physical_parameters updated
```

---

## 📊 Current System State

### Migration Status by Parameter Type

| Parameter Type | REST Route | API Used | Transfer Size | Status |
|---------------|-----------|----------|---------------|--------|
| **String/Physics** | `/set_parameter/string/<pitch>` | ✅ Granular | Only changed pitch | ✅ Production |
| **Excitation** | `/set_parameter/gauss/<pitch>` | ⚠️ Bulk | 2.6 MB (all) | ⚠️ Inefficient |
| **Hammer** | `/set_parameter/hammer/<pitch>` | ❌ No CUDA update | N/A | ❌ Bug |
| **Mode** | `/set_parameter/mode/<mode>` | ⚠️ Bulk | 5 KB (all) | ⚠️ Acceptable |
| **Feedin/Feedback** | `/set_parameter/feedin/<range>` | ⚠️ Bulk | 524 KB (all) | ⚠️ Large |

**Migration Progress:** 1 out of 5 parameter types fully migrated to granular API

### Performance Improvements Achieved

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Note triggering bandwidth | 160 bytes | 4 bytes | **40x reduction** ✅ |
| String parameter update (1 pitch) | 4,096 reals (all) | 3 strings only | **~85x reduction** ✅ |
| Excitation update (1 pitch) | 655,360 reals (2.6 MB) | **Still bulk** | ⚠️ Not migrated |

### Performance Opportunities

| Optimization | Current | Potential | Improvement | Effort |
|-------------|---------|-----------|-------------|--------|
| **Excitation granular API** | 2.6 MB | 10 KB | **260x** | 8 hours |
| Mode granular API | 5 KB | Per-mode | Medium | 4 hours |
| Deck granular API | 524 KB | Per-pitch | Large | TBD |

---

## 🔍 Code Locations Reference

### Key Files and Line Numbers (Verified Nov 9, 2025)

**CUDA Core (Layer 4):**
- `Pianoid.cu:801` - `updateSingleStringParameter_NEW()` ✅ NEW
- `Pianoid.cu:873` - `updateMultiStringParameter_NEW()` ✅ NEW
- `Pianoid.cu:744` - `setNewPhysicalParameters()` ⚠️ TRANSITIONAL
- `Pianoid.cu:762` - `setNewHammerParameters()` ⚠️ TRANSITIONAL
- `Pianoid.cu:775` - `setNewModeParameters()` ⚠️ TRANSITIONAL
- `Pianoid.cu:783` - `setNewDeckParameters()` ⚠️ TRANSITIONAL
- `Pianoid.cu:791` - `setNewExcitationParameters()` ⚠️ TRANSITIONAL
- `Pianoid.cu:955` - `setNewVolume()` ❌ LEGACY (bypasses memory manager)
- `Pianoid.cu:690-741` - `setUpdatedParameters()` 🔄 DUAL (init vs runtime)

**Middleware (Layer 2):**
- `pianoid.py:1811` - `update_parameter()` (main router)
- `pianoid.py:1494` - `update_pitch_physical_params_GRANULAR()` ✅ NEW
- `pianoid.py:1439` - `send_updated_params_to_CUDA()` ⚠️ LEGACY BULK
- `pianoid.py:1824-1828` - Excitation update flow (⚠️ uses bulk)
- `pianoid.py:1830-1833` - **HAMMER BUG LOCATION** ❌
- `pianoid.py:1835-1840` - Mode update flow (⚠️ uses bulk)
- `pianoid.py:1817-1822` - Deck update flow (⚠️ uses bulk)
- `pianoid.py:1842-1846` - String/physics update flow (✅ uses granular)

**PianoidBasic (Layer 3):**
- `StringMap.py:442` - `pack_parameters()` (bulk packing)
- `StringMap.py:384` - `update_hammer_shape()` (host-side only)
- `StringMap.py:320` - `update_deck()` (host-side update)
- `Mode.py:264` - `pack_modes()` (bulk packing)
- `Pitch.py:158` - `update_deck()` (host-side update)
- `PhysicalParameters.py:22-85` - String physics class
- `Hammer.py:8-231` - Hammer shape calculation
- `StringExcitation.py:224-582` - Excitation parameters

**Memory Management:**
- `UnifiedGpuMemoryManager.h` - Memory manager interface
- `UnifiedGpuMemoryManager.cu` - Memory manager implementation
- `ParameterInfo.h` - Parameter metadata registry

---

## 🧪 Testing Checklist

### After Fixing Hammer Bug

1. **Functional Test:**
   ```bash
   # Change hammer parameters via REST API
   curl -X POST http://localhost:5000/set_parameter/hammer/60 \
     -H "Content-Type: application/json" \
     -d '{"width": 0.002, "sharpness": 0.8}'

   # Trigger note and verify hammer shape affects sound
   curl -X POST http://localhost:5000/trigger_note \
     -d '{"pitch": 60, "velocity": 80}'
   ```

2. **Verification:**
   - Listen to audio output - tone should change
   - Check CUDA memory with debug print
   - Verify no dropped updates in logs

### After Excitation Migration

1. **Performance Test:**
   - Measure transfer size before/after
   - Verify 260x bandwidth reduction
   - Check update latency (<5ms target)

2. **Functional Test:**
   - Update excitation for single pitch
   - Verify only that pitch's parameters uploaded
   - Verify other pitches unchanged

---

## 💡 Development Tips

### Working with PianoidBasic

**Remember:** PianoidBasic is imported as `Pianoid`, not `PianoidBasic`:
```python
from Pianoid import StringMap, ModeMap, Pitch  # Correct
from PianoidBasic import StringMap  # Wrong - won't work
```

**Location:** `../PianoidBasic/Pianoid/` (relative to PianoidCore)

### Debugging Parameter Updates

**Add debug prints to trace updates:**
```python
# In pianoid.py
print(f"DEBUG: Updating {param} for pitch {pitchID}")
print(f"DEBUG: String indices: {string_indices}")
print(f"DEBUG: Transfer size: {len(data)} bytes")
```

**Check CUDA side:**
```cpp
// In Pianoid.cu
printf("CUDA: Received update for parameter %s\n", param_name.c_str());
printf("CUDA: String indices: [%d, %d, %d]\n", indices[0], indices[1], indices[2]);
```

### Common Pitfalls

1. **Forgetting Stage 2:** PianoidBasic updates are Python-only until you call CUDA transfer
2. **Bulk vs Granular:** Don't mix bulk and granular APIs for same parameter type
3. **Async Safety:** Use DROP_IF_BUSY policy to avoid blocking main thread
4. **Buffer Sizes:** Verify buffer sizes match expected dimensions before upload

---

## 📞 Getting Help

### Documentation Structure

```
PianoidCore/
├── PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md  ← 📖 START HERE (v6.0)
├── PIANOIDBASIC_PARAMETER_MANAGEMENT_DOCUMENTATION.md  ← 📚 Deep dive
├── DOCUMENTATION_INDEX.md  ← Navigation guide
├── PARAMETER_SYSTEM_CONSOLIDATION_SUMMARY.md  ← What changed Nov 9
└── docs/historical/parameter-system/  ← Historical archive
```

### Quick Navigation

- **Architecture overview:** Unified doc lines 59-116
- **Phase 0-6 history:** Unified doc lines 119-265
- **API reference:** Unified doc lines 267-343
- **REST→CUDA flows:** Unified doc lines 345-558
- **Function inventory:** Unified doc lines 560-631
- **Migration roadmap:** Unified doc lines 712-1024
- **PianoidBasic overview:** Unified doc lines 1029-1529

### Verification Commands

```bash
# Check documentation consistency
wc -l PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md  # Should be ~1600 lines

# List parameter-related files
find . -name "*parameter*" -o -name "*PARAMETER*" | grep -v ".git"

# Check for hammer bug
grep -n "elif param == 'hammer'" pianoid_middleware/pianoid.py
```

---

## ✅ Success Criteria

### For This Session

- [ ] Hammer bug fixed (15 min)
- [ ] Hammer updates verified working
- [ ] Tests pass for hammer parameter changes
- [ ] Code committed with proper message

### For Complete Migration (Future)

- [ ] All 5 parameter types use granular API
- [ ] Bulk upload functions deprecated and removed
- [ ] 260x excitation bandwidth improvement achieved
- [ ] All void functions return bool with error handling
- [ ] Documentation updated to reflect completion

---

## 🚀 Session Startup Command

**To get started quickly, paste this into your prompt:**

```
I'm continuing work on the Pianoid parameter system. I've read NEXT_SESSION_CONTEXT.md.

Current priority: Fix the hammer update bug (15 min task).

The bug is at pianoid_middleware/pianoid.py:1830-1833. The hammer updates are missing
the CUDA transfer call. I need to add self.send_updated_params_to_CUDA() after line 1833.

Please help me:
1. Confirm the exact location of the bug
2. Show me the current code
3. Implement the fix
4. Help me test it

Ready to proceed!
```

---

**Document Status:** ✅ Ready for next session
**Created:** November 9, 2025
**Last Verified:** November 9, 2025
**Estimated Work Remaining:** ~38 hours for complete migration
**Immediate Next Step:** Fix hammer bug (15 minutes) 🔴
