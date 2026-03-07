# Phased Refactoring of the Pianoid Parameter System

## Context

The parameter system is architecturally sound at the C++ layer (double-buffer swap in `UnifiedGpuMemoryManager`), but the Python middleware has accumulated technical debt: a confirmed bug where hammer parameter changes never reach the GPU, two competing update paths (bulk vs granular), inconsistent REST routing, and ~400 lines of parameter logic scattered across `pianoid.py`. This plan addresses these issues in independently deployable phases, ordered by severity.

---

## Phase 0 — Fix Hammer GPU Transfer Bug

**Severity: Critical (audio-affecting bug)**

The `update_parameter()` handler for `param='hammer'` (pianoid.py:2254-2257) updates the Python model but never uploads to CUDA. Every other parameter type has a GPU transfer call.

### Changes

**pianoid.py:**
1. Add `send_hammer_params_to_CUDA()` method (follows pattern of `send_mode_params_to_CUDA` at line 2086):
   - `self.sm.pack_hammers().ravel().tolist()` → `self.pianoid.setNewHammerParameters(hammer)`
2. Call it after the hammer update loop in `update_parameter()` (line 2257)

**backendServer.py:**
3. Add `pianoid.send_hammer_params_to_CUDA()` call after `sm.update_hammer_shape()` at line 487

**Also fix: dead `set_string_excitation` endpoint** (line 424-461) — it doesn't even update the Python model. Either wire it to `update_parameter('excitation', ...)` or mark it deprecated with a warning log.

### Key existing functions to reuse
- `StringMap.pack_hammers()` — StringMap.py:396-401
- `Pianoid.setNewHammerParameters()` — already exposed via Python binding

### Verify
- POST `/set_parameter/hammer/<pitch>` with changed width → play note → confirm sound changes
- POST `/set_hammer_shape/<pitch>` → same verification
- Regression: play note before/after hammer update, confirm no glitch

---

## Phase 1 — Fix Excitation Bulk Upload Inefficiency

**The `send_updated_params_to_CUDA()` call is inside the per-pitch loop** at line 2252, meaning it repacks ALL 256 strings (~3.15 MB) for EVERY pitch in the request. For an 88-key update, that's 88 full repacks.

### Changes

**pianoid.py:**
1. Move `send_updated_params_to_CUDA()` **outside** the loop in the excitation branch
2. Replace it with an excitation-only upload: `pack_excitations()` → `setNewExcitationParameters()`
   - This mirrors the existing `update_pitch_excitation()` pattern at line 2076-2084
   - Transfer drops from ~3.15 MB x N pitches to ~2.6 MB once

### Key existing functions to reuse
- `StringMap.pack_excitations()` — StringMap.py:413-414
- `Pianoid.setNewExcitationParameters()` — already exposed

### Verify
- Change excitation params via `/set_parameter/gauss/<pitch>` → play note → compare waveform matches previous behavior
- Measure time for bulk 88-key excitation update (should be significantly faster)

---

## Phase 2 — Consolidate REST Routing

Several endpoints bypass the central `update_parameter()` dispatcher, creating parallel code paths.

### Endpoints to consolidate

| Endpoint | Current behavior | Target |
|---|---|---|
| `/set_hammer_shape/<pitch>` | Python-only update (fixed in Phase 0) | Delegate to `update_parameter('hammer', ...)` |
| `/set_string_excitation/<pitch>` | Dead (no model or GPU update) | Delegate to `update_parameter('excitation', ...)` or remove |
| `/set_deck/<matrix>` | Direct `send_deck_params_to_CUDA()` | Delegate to `update_parameter('feedin'/'feedback', ...)` |
| `/set_mode_parameters` | Direct `send_mode_params_to_CUDA()` | Keep as-is (unique format, low risk) |

### Changes

**backendServer.py:**
- Rewrite `/set_hammer_shape` and `/set_string_excitation` to go through the dispatcher
- Rewrite `/set_deck` to go through the dispatcher
- Add deprecation log warnings on old endpoints if needed for backward compat

### Verify
- Test each endpoint with PianoidTunner frontend — all parameter changes must still work
- Compare request/response format to ensure frontend compatibility

---

## Phase 3 — Extract Parameter Manager Module

~400 lines of parameter logic in pianoid.py (6+ methods) should live in a dedicated module.

### Changes

**New file: `PianoidCore/pianoid_middleware/parameter_manager.py`**

Create `ParameterManager` class receiving `pianoid` (C++ binding), `sm` (StringMap), `modes`, `cuda_lock`.

Extract these methods from pianoid.py:
- `update_parameter()` (line 2235) — the dispatcher
- `update_pitch_physical_params_GRANULAR()` (line 1911) — granular physics
- `update_pitch_physical_params()` (line 1862) — old bulk physics (still used by NoteTunner.py + MidiListener)
- `send_updated_params_to_CUDA()` (line 1856) — bulk upload
- `send_hammer_params_to_CUDA()` (Phase 0 addition)
- `send_mode_params_to_CUDA()` (line 2086)
- `send_deck_params_to_CUDA()` (line 2096)

**Module-level constant:**
```python
PYTHON_TO_CUDA_PARAM_MAP = {
    'tension': 'tension', 'rho': 'density', 'jung': 'stiffness',
    'gamma': 'damping', 'r': 'radius', 'disp_decay': 'frequency_damping',
    'damper_string': 'damper_string', 'damper_tail': 'dump_coeff_tail',
    'dx': 'dx', 'volume_coefficient': 'volume_coefficient',
}
```
Currently this is an inline dict at line 1969-1980.

**pianoid.py:** Keep thin delegation methods on `PianoidPython` for backward compat.

### Active callers of `update_pitch_physical_params()` (old bulk) that must keep working:
- `NoteTunner.py:56,85` — tension and volume updates during tuning
- `pianoidMidiListener.py:408-432` — MIDI CC parameter tweaks

### Verify
- All existing pytest tests pass unchanged
- Frontend parameter editing works identically
- NoteTunner and MIDI listener still function

---

## Phase 4 — Clean Up Deprecated Code

### Changes

1. **Delete** `update_params_on_cuda()` (line 2065-2074) — already commented out with `# DEPRECATED:`, no callers
2. **Add deprecation warning** to `update_pitch_physical_params()` — has active callers (NoteTunner, MidiListener) so cannot delete, but should log a warning encouraging migration to granular API
3. **Move** the reverse name map (frontend to Python model names) to the constants in `parameter_manager.py`

### Verify
- Grep for `update_params_on_cuda` — confirm zero active callers before deletion
- Full test suite passes

---

## Summary

| Phase | Scope | Risk | Files |
|---|---|---|---|
| 0 | Fix hammer bug + dead excitation endpoint | LOW | pianoid.py, backendServer.py |
| 1 | Fix excitation bulk upload inefficiency | LOW | pianoid.py |
| 2 | Consolidate REST routing | MEDIUM | backendServer.py |
| 3 | Extract parameter_manager.py module | MEDIUM | NEW parameter_manager.py, pianoid.py |
| 4 | Delete deprecated code, extract constants | LOW | pianoid.py / parameter_manager.py |

Each phase is independently deployable. Phases 0-1 are pure bug fixes. Phases 2-4 are structural improvements.
