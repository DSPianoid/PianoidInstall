# Modal Adapter Redesign: Independent Stages + Full Pipeline

**Status:** Wave 1 complete  
**Date:** 2026-04-07

## Context

Currently the Modal Adapter panel enforces sequential execution — each stage is disabled until the previous completes in the same session. Saved intermediate data exists on disk but can't drive downstream stages without re-running everything.

## Goals

1. Any stage runnable independently using saved data from any session
2. A "Run Full Pipeline" that executes everything from raw data to saved preset file

## Architecture Change

Replace `AdapterState` enum with data-availability checks. Each stage asks "do I have my inputs?" not "was the previous stage run in this session?"

## Files & Changes

### 1. `modal_adapter.py`
- Remove `AdapterState` enum, add `data_status()`
- Data-based precondition checks instead of state enum
- `ModeChain` reconstruction from serialized dicts (unblocks feedin from loaded tracking)
- Persist measurement source (folder path, sample_rate, indices)
- Refactor `run_esprit()` — extract `_run_esprit_sync()` for reuse
- Add `run_full_pipeline(config)` — background thread running all stages

### 2. `preset_injector.py`
- Add `build_preset_to_file()` — offline preset generation (no running engine needed)
- Reads baseline JSON, modifies, writes to output path

### 3. `routes.py`
- `GET /modal/data_status` → availability flags
- `POST /modal/run_pipeline` → full pipeline

### 4. `useModalAdapter.js` (frontend hook)
- Fetch `dataStatus` on mount/changes
- Derive `canRunEsprit`/`canRunTracking`/`canRunFeedin`/`canApply` flags
- `runPipeline(config)` action + `pipelineStage` tracking

### 5. `ModalAdapter.jsx` (frontend UI)
- Section enablement from availability flags
- Per-section "Load Saved" buttons
- "Run Full Pipeline" button with Stepper progress

## Implementation Order (6 Waves)

1. State machine removal + data checks + ModeChain reconstruction
2. Measurement persistence + ESPRIT refactor + pipeline method
3. Offline preset builder
4. New API endpoints
5. Frontend hook
6. Frontend UI

## Verification

1. **Independent stages:** load intermediate → run downstream (no sequential run)
2. **Full pipeline:** configure → click Run → verify preset file
3. **Backward compat:** existing workflow unchanged
4. **ModeChain reconstruction:** load tracking from disk → feedin matches fresh run
