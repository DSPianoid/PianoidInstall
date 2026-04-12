# Modal Adapter Redesign

**Status:** Phase 1 + Phase 2 + Phase 3 implementation complete. Browser testing pending.  
**Date:** 2026-04-06 (Phase 1 code complete), 2026-04-09 (Phase 2 + code audit + Phase 3 toolbar UI)

## Phase 1: Independent Stages + Full Pipeline

### Context

The Modal Adapter panel enforced sequential execution — each stage disabled until the previous completed in the same session. Saved intermediate data existed on disk but couldn't drive downstream stages without re-running everything.

### Goals

1. Any stage runnable independently using saved data from any session
2. A "Run Full Pipeline" that executes everything from raw data to saved preset file

### Architecture Change

Replace `AdapterState` enum with data-availability checks. Each stage asks "do I have my inputs?" not "was the previous stage run in this session?"

### Files & Changes

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

### Implementation Order (6 Waves)

1. ~~State machine removal + data checks + ModeChain reconstruction~~ — `b4c7238` (PianoidCore)
2. ~~Measurement persistence + ESPRIT refactor + pipeline method~~ — `e3378ca` (PianoidCore)
3. ~~Offline preset builder~~ — `607a11c` (PianoidCore)
4. ~~New API endpoints~~ — `8e6d4a5` (PianoidCore)
5. ~~Frontend hook~~ — `273b494` (PianoidTunner)
6. ~~Frontend UI~~ — `3f4ea58` (PianoidTunner)

### Verification

**Code audit (2026-04-09):** All backend and frontend implementations confirmed present:

| Layer | File | Verified |
|-------|------|----------|
| Backend | `modal_adapter.py` — `data_status()`, `run_full_pipeline()` | Yes |
| Backend | `preset_injector.py` — `build_preset_to_file()` | Yes |
| Backend | `routes.py` — `GET /modal/data_status`, `POST /modal/run_pipeline` | Yes |
| Frontend | `useModalAdapter.js` — `dataStatus`, `canRun*` flags, `runPipeline`, `loadIntermediate` | Yes |
| Frontend | `ModalAdapter.jsx` — data-driven section enablement, pipeline UI | Yes |

**Browser verification pending:**

1. **Independent stages:** load intermediate → run downstream (no sequential run)
2. **Full pipeline:** configure → click Run → verify preset file
3. **Backward compat:** existing workflow unchanged
4. **ModeChain reconstruction:** load tracking from disk → feedin matches fresh run

---

## Phase 2: Server Separation, Project Management & UI Overhaul

**Status:** Implementation complete (2026-04-08/09). Browser testing pending.  
**Commits:** `2e55e80` (FolderBrowser), `8fd1226` (server separation + projects + backend), `020dbd7` (frontend + launcher)

### Motivation

Phase 1 kept the modal adapter as a Flask blueprint inside `backendServer.py`. CuPy GPU operations (ESPRIT) deadlocked when executed in Flask's background threads. A project management system was needed to organize multiple piano measurements and extraction runs.

### Changes

#### 1. Separate Modal Adapter Server (port 5001) — `8fd1226`

| Aspect | Detail |
|--------|--------|
| File | `pianoid_middleware/modal_adapter_server.py` |
| Port | 5001 |
| Threading | `threaded=False` — ESPRIT runs on main thread |
| Reason | CuPy GPU deadlocks in background threads |
| Effect | Removed `modal_bp` blueprint from `backendServer.py` |

#### 2. Project Management System — `8fd1226`

Backend methods in `modal_adapter.py`:

| Method | Purpose |
|--------|---------|
| `set_projects_base()` | Set root directory for all projects |
| `list_projects()` | List available projects |
| `create_project()` | Create project with optional measurement source |
| `open_project()` | Open and restore project state |
| `add_measurements_to_project()` | Add scenarios to current project |
| `copy_project()` | Clone project with measurements |
| `delete_project()` | Remove project and data |

7 REST endpoints on port 5001: `POST /projects/{list,create,open,add_measurements,copy,delete,set_base}`.

Storage layout:
```
{projects_base}/modal_projects/{name}/
├── project.json
├── measurements/scenario_*.npy
└── modal_adapter/{esprit,tracking,feedin,mapping,output}/
```

#### 3. Synthesis Pause/Resume — `8fd1226`

| Endpoint | Purpose |
|----------|---------|
| `POST /pause_synthesis` | Pause synthesis cycle (keeps GPU allocated) |
| `POST /resume_synthesis` | Resume from pause |

Frontend pauses main synth before GPU-intensive ESPRIT, resumes after completion.

#### 4. ESPRIT & Serialization Fixes — `8fd1226`

- Fixed `_resolve_bands()` — empty bands fallback, preset key priority
- Fixed `window_length` null handling in band config
- Added summary stats to ESPRIT results
- JSON serialization for numpy arrays and complex numbers

#### 5. FolderBrowser Component — `2e55e80`

| File | `src/components/FolderBrowser.jsx` (59 lines) |
|------|----------------------------------------------|
| API | `POST /open_folder_dialog` on port 5001 |
| Impl | Native OS folder picker via tkinter subprocess |

#### 6. Frontend Tab-Based UI Overhaul — `020dbd7`

`ModalAdapter.jsx` completely rewritten (+550 net lines):

| Old | New |
|-----|-----|
| Accordion sections | 4 tabs: **Project**, **ESPRIT**, **Tracking**, **Apply** |
| No project UI | Project chip list, click-to-open, clone/delete buttons |
| Sequential workflow | Independent tab navigation |

#### 7. Per-Scenario ESPRIT with Selection UI — `020dbd7`

`useModalAdapter.js` expanded (+400 net lines):

- Checkbox multi-select with range input and shift-click
- Color-coded processed/unprocessed indicators per scenario
- Progress display: "X/Y scenarios, N modes found"
- "Add More Scenarios" folder input
- Frontend drives per-scenario loop (one `POST /modal/run_esprit` per scenario)

#### 8. EspritConfig Simplification — `020dbd7`

- Removed verbose per-parameter UI
- GPU checkbox only, "Show Advanced" toggle for band table
- Band table: `name`, `window_length` fields
- ~100 line reduction

#### 9. Dual-Process Launcher — `020dbd7`

`server/launcher.js` expanded (+110 net lines):

| Feature | Detail |
|---------|--------|
| Port management | Manages both port 5000 (Pianoid) and port 5001 (modal adapter) |
| Health check | `ensureModalServer()` polls `GET /health` on port 5001 |
| Lifecycle | Starts/stops modal adapter server alongside main backend |

### Verification Status

| Feature | Code Verified | Browser Tested |
|---------|--------------|----------------|
| Separate server (port 5001) | Yes | Pending |
| Project CRUD | Yes | Pending |
| Tab UI | Yes (superseded by Phase 3 toolbar) | Pending |
| Per-scenario ESPRIT | Yes | Pending |
| FolderBrowser | Yes | Pending |
| Dual-process launcher | Yes | Pending |
| Pause/resume synthesis | Yes | Pending |
| EspritConfig simplification | Yes | Pending |

### Bug Fixes (2026-04-10)

| Fix | Files |
|-----|-------|
| `modal_adapter/__init__.py` log dir missing → `os.makedirs` | `__init__.py` |
| `load_folder` auto-descend into child subfolder for RoomResponse | `modal_adapter.py` |
| Faulty scenarios (channel mismatch) skipped with warning instead of aborting | `modal_adapter.py` (`load_roomresponse_scenarios`, `_load_roomresponse_raw`) |
| `create_project` re-opens existing project instead of erroring | `modal_adapter.py` |
| Incomplete project (no `project.json`) re-created instead of failing open | `modal_adapter.py` |
| `data_status()` returns `mapping_config` for channel role restoration | `modal_adapter.py` |
| `openProject`/`createProject` restore saved channel roles from backend | `useModalAdapter.js` |
| Server start/stop button on Modal Adapter panel | `useModalAdapter.js`, `ModalAdapter.jsx` |
| `EXTENDED_BANDS` defined locally (missing from RoomResponse library) | `esprit_runner.py` |
| **ESPRIT band merging:** ~~`merge_multiband_results` not in RoomResponse library~~ — **Resolved.** Function inlined in `esprit/band_merging.py`. | `esprit_runner.py` |

### Documentation Cross-References

Module docs already updated for Phase 2:

- [REST API — Modal Adapter Endpoints](../modules/pianoid-middleware/REST_API.md#modal-adapter-endpoints-port-5001)
- [System Overview — Server Architecture](../architecture/SYSTEM_OVERVIEW.md#server-architecture)
- [Middleware Overview — Modal Adapter](../modules/pianoid-middleware/OVERVIEW.md#modal-adapter-modal_adapter)
- [Tunner Overview — ModalAdapter component](../modules/pianoid-tunner/OVERVIEW.md)
- [Tunner Overview — useModalAdapter hook](../modules/pianoid-tunner/OVERVIEW.md#useModalAdapter)

---

## Phase 3: Toolbar UI (2026-04-09)

**Status:** Implementation complete. Docs updated.

Replaced the Tab navigation and server status bar in `ModalAdapter.jsx` with a compact single-row toolbar.

### Changes

| Old (Phase 2) | New (Phase 3) |
|----------------|---------------|
| 4 MUI Tabs (Project, ESPRIT, Tracking, Apply) | Toolbar with pipeline ButtonGroup (ESPRIT, Tracking, Apply) |
| Server status bar below tabs | Server status chip ("On"/"Off") in toolbar, clickable to start |
| Project as a tab | Project button in toolbar showing current project name |
| Per-section Run/Apply buttons in section bodies | Two toolbar play buttons: Play (run current step), SkipNext (run from here to end) |
| Settings visible in section bodies | Gear icon toggles collapsible settings panel with context-sensitive content |
| Tab-based status indicators | ButtonGroup buttons show checkmark (done) or spinner (running) |

### Toolbar Layout (Left to Right)

1. **Server status chip** — "On"/"Off", clickable to start modal server
2. **Project button** — shows `currentProject` name or "Select Project", checkmark when project is open
3. **Pipeline section ButtonGroup** — ESPRIT, Tracking, Apply; status indicators (checkmark/spinner)
4. **Settings gear icon** — toggles collapsible panel:
   - ESPRIT selected → EspritConfig
   - Tracking selected → freq tolerance, max gap
   - Apply selected → merge mode, sound output mapping
5. **Play buttons** (right-aligned):
   - Play icon (▶) → run current step
   - SkipNext icon (⏭) → run from here to end of pipeline
   - Both show Stop icon (■) when running

### Files Modified

| File | Change |
|------|--------|
| `PianoidTunner/src/modules/ModalAdapter.jsx` | Complete toolbar rewrite — removed Tabs, added toolbar with ButtonGroup, gear icon, play/stop buttons |

### Documentation Updated

- [Tunner Overview — ModalAdapter component](../modules/pianoid-tunner/OVERVIEW.md)
- [Modal Adapter Pipeline Guide — UI Sections](../guides/MODAL_ADAPTER_GUIDE.md#toolbar-layout)
- [Work in Progress](WORK_IN_PROGRESS.md)
