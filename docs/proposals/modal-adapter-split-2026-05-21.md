# Proposal: Split the `modal_adapter.py` God-Object

**Date:** 2026-05-21
**Status:** Proposed (6 architectural decisions locked by user; awaiting Wave-1 dispatch).
**Author tag:** `[dev-maimport]` (round 15 wrap-up + round 16 prep).
**Scope:** `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` (5,599 LOC, 103 methods).
**Related docs:**
- `docs/development/CODE_QUALITY.md` §C4 (the RED-flag rule this proposal triggers)
- `docs/proposals/pianoid-cu-split-proposal-2026-05-19.md` (precedent — same shape, CUDA layer)
- `docs/proposals/modal-adapter-measurement-entity-2026-05-10.md` (Phase 1+2 refactor that grew the file to its current size)

---

## 0. Problem Statement

`modal_adapter.py` is the single largest file in `PianoidCore/pianoid_middleware/` and the largest non-CUDA file in the Pianoid codebase. It is the implementation of the `ModalAdapter` class, the sole Python-side orchestrator for the Modal Adapter REST surface on port 5001.

```
File:         pianoid_middleware/modal_adapter/modal_adapter.py
Size:         5,599 LOC      (RED per CODE_QUALITY §C4 — over 1,000 threshold by 5.6x)
Class:        ModalAdapter   (single class)
Methods:      103            (95 instance + 8 static / property)
Init state:   ~25 instance-state fields (measurement data, ESPRIT results,
                              tracking chains, undo/redo stacks, persistence
                              fields, run-thread control, …)
```

The file accreted 11 distinct concerns over 9 months of development:

1. **Project lifecycle** — create, open, close, copy, branch, delete, rename, export, import (v1 + v2 schemas)
2. **Measurement-source loading** — RoomResponse scenarios, flat-npy folders, v2 parent-Measurement fallback
3. **ESPRIT pipeline** — config persistence, threaded run loop, per-scenario result aggregation, cancellation
4. **Mode tracking** — bridge-boundary split, nuclei_merge / sliding_window / sequential methods
5. **Chain editing** — create / merge / split / delete / undo / redo (with in-memory state machine)
6. **Feedin extraction** — per-mode feedin data computation
7. **Apply to preset** — write extracted modes back to the live `Pianoid` synthesis engine
8. **Visualization data** — stabilization diagram, grid heatmap, mode shape, mode preview
9. **QC** — effective signal length roll-up, per-scenario curves, threshold recompute, reaverage
10. **Channel mapping** — per-channel role assignment, layout (linear / grid), excitation_to_pitch
11. **Persistence layer** — read/write of `project.json`, `esprit/`, `tracking/`, `feedin/`, `mapping/`, `output/` JSON files; legacy schema migrations

Each concern is a candidate seam for splitting.

### Growth trajectory

| Date | LOC | Delta | Notable changes |
|---|---|---|---|
| 2026-04-19 | ~1,400 | — | Pre-measurement-entity baseline |
| 2026-04-30 | ~2,100 | +700 | dev-md06 (chain undo/redo + heatmap controls) |
| 2026-05-04 | ~3,000 | +900 | dev-0239 (create_from_zip + canonical averaging) |
| 2026-05-11 | ~3,600 | +600 | dev-msmt Phase 1 (measurement entity, v2 schema) |
| 2026-05-19 | ~5,300 | +1,700 | dev-maimport rounds 1-13 |
| 2026-05-20 | **5,599** | +299 | dev-maimport rounds 14+15 (browse/delete/rename) |

**Doubled in 4 weeks.** Every round of dev-maimport added methods; the round-15 rename added 110 LOC. The file is the path of least resistance for new modal-adapter functionality, which guarantees continued growth without an architectural change.

---

## 1. Why Split

| Pressure | Current state | After split |
|---|---|---|
| **Testability** | One ~5,600 LOC class. Tests instantiate the whole `ModalAdapter` even to exercise a single concern (e.g. chain editing tests construct a full project loader stack). | Each module is independently constructible with its slice of `ProjectContext`. Tests target one module at a time. |
| **Parallel development** | Any concurrent change to `modal_adapter.py` is a merge conflict. Round 11 + round 13 + round 14 + round 15 all touched the file. | Each module is its own file → conflicts only when two changes touch the same module. |
| **Cognitive load** | A reader looking for ESPRIT logic must scroll past project-create, QC, mapping migrations, copy_project, etc. — 4,000 lines of "not this". | A reader looking for ESPRIT opens `esprit_orchestrator.py`. |
| **Prevent further growth** | CODE_QUALITY §C4 says no new code in RED-flagged files except pure bug fixes — but every recent round added code anyway. The rule needs structural enforcement. | The thin-facade policy (§5) makes "new methods land in facade" structurally awkward; the next reviewer asks "which module owns this?" |
| **Onboarding** | New contributors must read the entire file to know which concerns exist. | The module list IS the concern map; each module's docstring states its responsibility in one line. |

---

## 2. The Six Locked Decisions

| Q | Decision | Justification |
|---|---|---|
| **Q1: granularity** | **7 modules** (medium) | Coarser (3-4) leaves YELLOW-zone files; finer (10+) re-creates the "bag of wrappers" anti-pattern the CUDA split rejected. 7 matches the natural concern boundaries (§4). |
| **Q2: facade shape** | **Thin facade** + **"no new methods land in facade" policy** | Preserves the REST surface (every route's `adapter.foo()` call still works) without inviting fresh accretion. Policy enforced via CODE_QUALITY addendum (§9). |
| **Q3: state architecture** | **`ProjectContext` shared-state holder** + **stateless service modules** | Centralises the ~25 instance-state fields into one object. Modules take a `ProjectContext` argument and read/write specified fields per their charter. Avoids hidden coupling via shared `self`. |
| **Q4: migration cadence** | **Staged in 3 waves** | Each wave merges to `dev` independently. Bisectable; each wave's risk surface is bounded. Rough sizing: Wave 1 = low risk (~500 LOC moved), Wave 2 = medium (~1,500 LOC), Wave 3 = highest (~2,000 LOC + facade rewrite). |
| **Q5: persistence** | **Hybrid** — `ProjectStore` owns project-level metadata (project.json), each module owns its stage results (esprit/, tracking/, feedin/, output/) | Project-level lifecycle (create/open/rename/delete) is genuinely cross-cutting → one owner. Stage results are concern-local → owned by the concern. Matches the on-disk directory structure (each stage is its own subfolder). |
| **Q6: inter-module data** | **ProjectContext (in-memory)** | Modules don't read each other's JSON files. A module that needs ESPRIT results gets them from `ProjectContext.esprit_results` (populated by `EspritOrchestrator`). Avoids two modules racing to be the next reader of disk state. |

---

## 3. Current State Inventory

### 3.1 Instance state (current `ModalAdapter.__init__`)

| Field | Concern | Migrates to |
|---|---|---|
| `_run_state`, `_run_thread`, `_cancel_event`, `_progress` | ESPRIT thread control | `EspritOrchestrator` |
| `_measurements`, `_sample_rate`, `_file_list`, `_scenario_indices`, `_scenario_loading_gap`, `_source_folder` | Measurement data | `ScenarioLoader` (read), `ProjectContext` (held) |
| `_mapping` | Mapping config | `ProjectContext` (held) |
| `_per_scenario_results` | ESPRIT results | `EspritOrchestrator` (owns) → `ProjectContext` (held) |
| `_tracked_chains`, `_nuclei_stage_chains`, `_tracked_chains_version` | Tracking results | `TrackingOrchestrator` (owns) → `ProjectContext` (held) |
| `_chain_undo_stack`, `_chain_redo_stack` | Chain edit history | `ChainEditor` (owns) |
| `_feedin_data` | Feedin results | `TrackingOrchestrator` (owns) → `ProjectContext` (held) |
| `_project_dir`, `_projects_base`, `_current_project` | Project lifecycle | `ProjectStore` (owns) → `ProjectContext` (held) |
| `_tracking_params` | Tracking config | `TrackingOrchestrator` (owns) |
| `_applied` | Apply state | `ApplyService` (owns) → `ProjectContext` (held) |

### 3.2 Method clustering (103 methods → 7 modules)

The full method-to-module assignment is in §4. Method names retained verbatim from current source.

---

## 4. Final 7-Module Layout

All modules live under `PianoidCore/pianoid_middleware/modal_adapter/`. The facade `ModalAdapter` class stays in `modal_adapter.py`. New modules use snake_case file names matching their class name.

### 4.1 `ProjectStore` — `project_store.py`

**Responsibility:** Project lifecycle (create / open / close / copy / branch / delete / rename / export / import). Owns project.json read/write. Manages the v1 ↔ v2 schema fork.

**Methods migrated:**
- `create_project`
- `open_project`
- `add_measurements_to_project`
- `_import_measurements`
- `_load_v2_scenarios_from_parent_measurement` (calls `ScenarioLoader` for the actual load)
- `copy_project`
- `create_project_from_measurement` (round 11+13)
- `branch_project`
- `delete_project`
- `export_project`, `export_info`
- `import_project`, `create_project_from_zip` (round 11)
- `_auto_average_scenarios` (delegates to `scenario_averager.py` — that's already external)
- `_detect_measurement_source`
- `list_projects` (round 12 + 14: enriched with signal_length_ms + linked_projects_count)
- `_resolve_project_scenarios_path` (round 5 helper)
- `_dir_has_roomresponse_scenarios` (round 7)
- `_scenario_folders_for_project`
- `rename_project`
- `set_project_dir`, `set_projects_base`
- `_persist_measurement_source`
- `_migrate_channel_mapping_to_mapping_config` (legacy migration)
- `reset` (project-side reset; module-side resets delegated per concern)

**LOC estimate:** ~1,800 LOC. Largest single module. Could be sub-split in a future Wave 4 (e.g. `ProjectStore` + `ProjectImporter` + `ProjectExporter`) if it grows further.

**Reads from ProjectContext:** all fields (it manages the lifecycle).
**Writes to ProjectContext:** all fields on open/reset; clears all on close.

### 4.2 `ScenarioLoader` — `scenario_loader.py`

**Responsibility:** Load measurement-source data (RoomResponse averaged_responses + flat-npy + v2 parent-Measurement fallback). Owns the `_discover_*` helpers + per-scenario filtering. Stateless service — takes path + scenario filter → returns `{measurements, file_list, scenario_indices, gap}`.

**Methods migrated:**
- `load_folder`
- `load_roomresponse_scenarios`
- `load_arrays`
- `add_folder`
- `_load_npy_raw`, `_load_roomresponse_raw`
- `_discover_roomresponse_scenarios` (round 11 averaged-only filter)
- `_discover_npy_scenarios`
- `_is_roomresponse_folder`
- `_extract_scenario_index`
- `set_sample_rate`
- `measurement_info`
- `scenario_info`

**LOC estimate:** ~700 LOC.

**Reads from ProjectContext:** `project_dir`, `current_project`.
**Writes to ProjectContext:** `measurements`, `sample_rate`, `file_list`, `scenario_indices`, `scenario_loading_gap`, `source_folder`.

### 4.3 `EspritOrchestrator` — `esprit_orchestrator.py`

**Responsibility:** ESPRIT config persistence, threaded run loop, per-scenario aggregation, cancellation, mapping integration. Owns `_per_scenario_results`. Wraps the `pianoid_middleware/modal_adapter/esprit/` package (which contains the actual numerical kernels — already factored, just not orchestrated separately).

**Methods migrated:**
- `_run_esprit_sync`
- `run_esprit`
- `_persist_esprit_results`
- `_load_esprit_results`
- `get_status`
- `get_results`
- `cancel`
- `set_mapping`
- `set_channel_mapping`
- `save_esprit_config`
- `get_esprit_config`
- `run_full_pipeline` (orchestrates ESPRIT + tracking + apply — see §10 risk note about ownership)
- `_update_pipeline_progress`

**LOC estimate:** ~750 LOC.

**Reads from ProjectContext:** `measurements`, `sample_rate`, `mapping`.
**Writes to ProjectContext:** `per_scenario_results`, `run_state`, `progress`.

**Round-9 deferred bug:** `_run_esprit_sync` ignores `esprit/config.json` — REST callers must put bands in the request body. See §10 risk #3.

### 4.4 `TrackingOrchestrator` — `tracking_orchestrator.py`

**Responsibility:** Mode tracking (bridge-boundary split, nuclei_merge / sliding_window / sequential methods), feedin extraction, persistence. Owns `_tracked_chains`, `_nuclei_stage_chains`, `_tracking_params`, `_feedin_data`. Wraps the `pianoid_middleware/modal_adapter/tracking/` package + `feedin/` package.

**Methods migrated:**
- `run_tracking`
- `run_feedin_extraction`
- `_load_tracking_results`
- `_load_feedin_results`
- `_enrich_chains_from_esprit`
- `has_tracking`, `has_feedin`
- `get_tracked_chains`
- `get_feedin_data`

**LOC estimate:** ~600 LOC.

**Reads from ProjectContext:** `per_scenario_results`, `mapping`.
**Writes to ProjectContext:** `tracked_chains`, `nuclei_stage_chains`, `tracked_chains_version`, `feedin_data`, `tracking_params`.

### 4.5 `ChainEditor` — `chain_editor.py`

**Responsibility:** Chain create / merge / split / delete / undo / redo. Owns the undo/redo stacks. Pure in-memory state machine — persists via `TrackingOrchestrator` on commit (see §6 for the commit handshake).

**Methods migrated:**
- `save_edited_chains`
- `merge_chains`
- `add_point_to_chain`, `remove_point_from_chain`
- `create_chain`, `break_chain`, `dissolve_in_range`, `delete_chains`
- `chains_undo`, `chains_redo`
- `_push_undo_snapshot`
- `_lookup_chain`
- `_reindex_chain_ids`
- `_recompute_chain_stats`
- `_persist_chains_after_edit`
- `_Chain`, `_ChainPoint` helper classes (lines 5535-5599 of current file)

**LOC estimate:** ~600 LOC (incl. helper classes).

**Reads from ProjectContext:** `tracked_chains` (mutates in place via shared reference).
**Writes to ProjectContext:** `tracked_chains_version` (increments on every commit).

### 4.6 `VisualizationService` — `visualization_service.py`

**Responsibility:** Read-only views derived from tracking + ESPRIT results — stabilization diagram, grid heatmap, mode shape, mode preview. Stateless. Each method takes `ProjectContext` + view params → returns the view dict.

**Methods migrated:**
- `get_stabilization_data`
- `get_mode_shape_data`
- `get_mode_preview_params`
- `get_grid_heatmap_data`

**LOC estimate:** ~500 LOC.

**Reads from ProjectContext:** `tracked_chains`, `per_scenario_results`, `mapping`, `nuclei_stage_chains`.
**Writes to ProjectContext:** nothing (pure read view).

### 4.7 `ApplyService` — `apply_service.py`

**Responsibility:** Apply extracted modes back to the live `Pianoid` synthesis engine. Owns `_applied`. QC roll-up + reaverage live here too (they conceptually belong to "result-export to live engine + post-acquisition refinement").

**Methods migrated:**
- `apply_to_preset`
- `_load_effective_signal_length_summary`
- `get_effective_signal_length`
- `_qc_curves_cache` (property)
- `get_qc_curves`
- `invalidate_qc_curves_cache`
- `recompute_effective_signal_length`
- `reaverage_project`
- `export_to_text_files`
- `load_intermediate` (delegates per stage to the right module)
- `_load_mapping_results`
- `_persist` (low-level json-write helper)

**LOC estimate:** ~700 LOC.

**Reads from ProjectContext:** all stage results (it's downstream of every concern).
**Writes to ProjectContext:** `applied`.

### 4.8 Summary table

| Module | File | LOC est. | Owns state | Reads | Writes |
|---|---|---|---|---|---|
| `ProjectStore` | `project_store.py` | 1,800 | project.json | all | all |
| `ScenarioLoader` | `scenario_loader.py` | 700 | — (stateless) | project_dir | measurements, sample_rate, file_list, scenario_indices, gap |
| `EspritOrchestrator` | `esprit_orchestrator.py` | 750 | per_scenario_results, run_state | measurements, mapping | per_scenario_results, run_state, progress |
| `TrackingOrchestrator` | `tracking_orchestrator.py` | 600 | tracked_chains, feedin_data, tracking_params | per_scenario_results, mapping | tracked_chains, version, feedin_data |
| `ChainEditor` | `chain_editor.py` | 600 | undo/redo stacks | tracked_chains | version |
| `VisualizationService` | `visualization_service.py` | 500 | — (stateless) | all results | nothing |
| `ApplyService` | `apply_service.py` | 700 | applied flag | all | applied |
| **`ModalAdapter` (facade)** | `modal_adapter.py` | ~400 | composition + ProjectContext lifecycle | — | — |

**Total: ~6,050 LOC across 8 files** vs current 5,599 LOC in 1 file. The +450 net comes from per-module docstrings, explicit `ProjectContext` parameter passing, and the facade's delegation glue. Each new file lands under the YELLOW threshold (1,800 for ProjectStore is the only one above YELLOW — see §10 risk #1 for sub-split contingency).

---

## 5. ProjectContext Design

`ProjectContext` is a `@dataclass` holding all current `ModalAdapter` instance state. It is instantiated by the facade at project-open time and disposed on project-close (or replaced on project-switch). Modules receive a reference and read/write specified fields per their charter.

### 5.1 Field set

```python
@dataclass
class ProjectContext:
    # --- Lifecycle ---
    project_dir: Optional[str] = None
    projects_base: str = ""
    current_project: Optional[str] = None

    # --- Measurement data (owned by ScenarioLoader writes) ---
    measurements: Dict[int, np.ndarray] = field(default_factory=dict)
    sample_rate: float = 0.0
    file_list: List[str] = field(default_factory=list)
    scenario_indices: List[int] = field(default_factory=list)
    scenario_loading_gap: Optional[Dict[str, Any]] = None
    source_folder: Optional[str] = None

    # --- Mapping (owned by ProjectStore.open_project) ---
    mapping: Optional[MappingConfig] = None

    # --- ESPRIT (owned by EspritOrchestrator) ---
    per_scenario_results: Dict[int, Dict] = field(default_factory=dict)
    run_state: str = "idle"
    progress: Dict[str, Any] = field(default_factory=lambda: {
        "current_point": 0, "total_points": 0, "message": ""})

    # --- Tracking (owned by TrackingOrchestrator) ---
    tracked_chains: List = field(default_factory=list)
    nuclei_stage_chains: List = field(default_factory=list)
    tracked_chains_version: int = 0
    tracking_params: Optional[Dict[str, Any]] = None

    # --- Feedin (owned by TrackingOrchestrator) ---
    feedin_data: Optional[Dict] = None

    # --- Apply (owned by ApplyService) ---
    applied: bool = False
```

### 5.2 Mutability rules

Each field has exactly one writer (the module marked "owns" in §4.8). All other modules read-only. Enforcement is convention initially; could be tightened later with explicit getter/setter methods if drift becomes a problem.

**Exception:** `ProjectStore.open_project` and `ProjectStore.reset` get write access to every field — they manage the full lifecycle.

### 5.3 Construction + lifecycle

```python
class ModalAdapter:
    def __init__(self):
        self._ctx = ProjectContext(
            projects_base=os.environ.get("PIANOID_PROJECTS_DIR",
                                         r"D:\modal_projects"))
        self._store = ProjectStore(self._ctx)
        self._loader = ScenarioLoader(self._ctx)
        self._esprit = EspritOrchestrator(self._ctx)
        self._tracking = TrackingOrchestrator(self._ctx)
        self._chains = ChainEditor(self._ctx)
        self._viz = VisualizationService(self._ctx)
        self._apply = ApplyService(self._ctx)
```

**One context, shared by reference.** When `open_project` mutates `_ctx.current_project`, every module sees it immediately. No event bus, no callbacks.

**Project switch:** `ProjectStore.open_project(name)` calls `reset()` which clears every `_ctx` field, then loads the new project. Modules don't need to be notified — their next read of `_ctx` reflects the new state.

### 5.4 Thread safety

Current `ModalAdapter` runs ESPRIT in a background thread and protects `_cancel_event` + `_progress` with mutexes/Event. The new `ProjectContext` does NOT add thread-safety guarantees — `EspritOrchestrator` keeps its own threading primitives (cancel event, progress lock) for the cross-thread fields it owns. Other modules are single-threaded (REST handlers run synchronously on the Flask worker).

---

## 6. Thin Facade Contract

### 6.1 What `ModalAdapter` retains

After all three waves, `ModalAdapter` contains ONLY:

1. **Composition** — instantiates `ProjectContext` + all 7 service modules in `__init__`.
2. **REST-shape delegation methods** — every method that's called from `routes/*.py` keeps its current signature and delegates to the appropriate service. Example:
   ```python
   def create_project(self, name, measurement_source=None):
       return self._store.create_project(name, measurement_source)
   ```
3. **Properties** that REST consumers depend on (`state`, `num_excitation_points`, `num_channels`, `sample_rate`, `current_project_name`, `projects_base`, `data_status`, `get_project_state`) — these read from `ProjectContext` (1-line implementations).

**Target size: ~400 LOC.** All single-purpose delegation; no business logic.

### 6.2 What migrates out

Every method listed in §4 — 103 methods migrate to their owning module. The facade's instance fields disappear (replaced by `ProjectContext`); only `self._ctx` and the 7 service references remain.

### 6.3 The "no new methods" policy

**Wording for CODE_QUALITY.md addendum:**

> #### C4.1. Thin-Facade Policy (modal_adapter.py)
>
> After the 3-wave split (proposal: `docs/proposals/modal-adapter-split-2026-05-21.md`),
> `ModalAdapter` is a thin façade over 7 service modules. **No new method may
> land in `ModalAdapter` itself.** All new functionality lands in the
> appropriate service module; if the new functionality doesn't fit any existing
> service, propose a new service in a follow-up to the split proposal.
>
> The only exception is **REST-shape delegation methods** — when a new REST
> route needs a new entry point, `ModalAdapter.foo()` may be added IF its
> body is a single delegation call to a service method (`return
> self._service.foo(...)`). A REST-delegation method that contains business
> logic is a violation.
>
> Enforcement: any PR that adds an instance method to `ModalAdapter` with a
> body longer than 3 lines (excluding docstring) must justify why the logic
> belongs in the facade vs a service. The reviewer applies §C4 even though
> the facade itself is below 1,000 LOC — the file's RED status persists
> until the policy is formally relaxed.

### 6.4 Why this works without enforcement tooling

The thin-facade shape makes accretion visually awkward. A reader who tries to add a 50-line method to the facade sees 400 LOC of 3-line delegations and a service-module pattern next to them — the obvious thing to do is add the method to a service. The structural friction does the work.

If a future contributor ignores this and the facade grows back, the next CODE_QUALITY review triggers C4 again, this proposal is re-opened, and Wave 4 ships.

---

## 7. Three-Wave Migration Sequence

### 7.1 Wave 1 — Low risk (~500 LOC moved, ~30 new LOC)

**Modules:** `ProjectContext` + `ScenarioLoader` + `VisualizationService`.

**Why these first:**
- `ProjectContext` is the foundational data structure — must land first so subsequent waves have a target.
- `ScenarioLoader` is the cleanest seam: clear input (path + filter) → clear output (measurements + indices). No threading, no cross-module reads beyond `project_dir`.
- `VisualizationService` is pure-read; no writes. Lowest blast radius.

**Methods migrated:** §4.2 (ScenarioLoader, 12 methods) + §4.6 (VisualizationService, 4 methods).

**Facade after Wave 1:** still ~4,800 LOC. The facade `__init__` gains `self._ctx = ProjectContext(...)`, `self._loader = ScenarioLoader(self._ctx)`, `self._viz = VisualizationService(self._ctx)`. The 16 migrated methods become 16 one-line delegations.

**Acceptance criteria:**
- All 728 tests pass (backend 147 + frontend 581 at time of round 15 wrap-up).
- `wc -l pianoid_middleware/modal_adapter/modal_adapter.py` drops by ≥500.
- `ProjectContext` field set matches §5.1 exactly (no fields added by Wave 2/3 that should have been in Wave 1's skeleton).
- New files: `project_context.py`, `scenario_loader.py`, `visualization_service.py`, `tests/integration/modal_adapter/test_scenario_loader.py`, `tests/integration/modal_adapter/test_visualization_service.py`.

**PR sizing:** ~1,200 LOC delta (500 moved + ~700 in new files including tests). Single PR.

### 7.2 Wave 2 — Medium risk (~1,500 LOC moved)

**Modules:** `EspritOrchestrator` + `TrackingOrchestrator` + `ApplyService`.

**Why second:**
- These are the orchestrators — bigger surface, more cross-state reads. Need `ProjectContext` (from Wave 1) to be solid.
- `EspritOrchestrator` carries thread-safety logic (cancel event, progress lock) — non-trivial migration.
- `ApplyService` depends on QC roll-up which depends on `ScenarioLoader` (Wave 1 already lands).

**Methods migrated:** §4.3 (EspritOrchestrator, 13) + §4.4 (TrackingOrchestrator, 8) + §4.7 (ApplyService, 12) = 33 methods.

**Pre-Wave-2 prerequisite (round 16):** the deferred `_run_esprit_sync` bug from round 9 (ignores `esprit/config.json`) ships as a standalone fix BEFORE Wave 2. Reason in §10 risk #3.

**Facade after Wave 2:** ~2,500 LOC. Down significantly; the remaining bulk is `ProjectStore` methods (Wave 3) + `ChainEditor`.

**Acceptance criteria:**
- All tests pass.
- ESPRIT background-thread tests still pass (cancellation, progress reporting).
- `wc -l modal_adapter.py` drops by ≥1,500 more.
- New files: `esprit_orchestrator.py`, `tracking_orchestrator.py`, `apply_service.py`, plus tests under `tests/integration/modal_adapter/`.

**PR sizing:** ~2,800 LOC delta. Single PR but larger; consider sub-splitting if review burden is high (e.g. EspritOrchestrator alone, then TrackingOrchestrator + ApplyService).

### 7.3 Wave 3 — Highest risk (~2,000 LOC moved + facade rewrite)

**Modules:** `ProjectStore` + `ChainEditor`.

**Why last:**
- `ProjectStore` is the biggest (~1,800 LOC) and most cross-cutting. It calls into every other service during open_project. Needs all of them in place.
- `ChainEditor` has the trickiest state (in-memory undo/redo) and needs `TrackingOrchestrator` (Wave 2) to be the canonical owner of `tracked_chains`.
- Final facade rewrite happens here — the residual `ModalAdapter` collapses from ~2,500 LOC to ~400 LOC of delegations.

**Methods migrated:** §4.1 (ProjectStore, 23 methods) + §4.5 (ChainEditor, 13 methods + 2 helper classes) = 36 methods.

**Facade after Wave 3:** ~400 LOC. Composition + delegation only. RED → YELLOW (if even YELLOW — likely closer to "fine but watch").

**Acceptance criteria:**
- All tests pass.
- `wc -l modal_adapter.py` ≤ 500 (target: 400).
- CODE_QUALITY.md addendum (§6.3) shipped in same PR.
- Every method on `ModalAdapter` has a body ≤ 3 lines (excluding docstring) — the thin-facade contract is enforced from day one.
- New files: `project_store.py`, `chain_editor.py`, plus tests under `tests/integration/modal_adapter/`.

**PR sizing:** ~3,500 LOC delta. Largest PR. Sub-split contingency: ship `ChainEditor` first (smaller, isolated), then `ProjectStore` in a follow-up.

---

## 8. Test Reorganization

### 8.1 Proposed structure

```
tests/integration/modal_adapter/         # NEW directory
  test_project_store.py                  # ex-test_project_v2_branch, ex-rename
  test_scenario_loader.py                # NEW (extracted from test_modal_adapter)
  test_esprit_orchestrator.py            # NEW
  test_tracking_orchestrator.py          # NEW
  test_chain_editor.py                   # ex-chain-related tests
  test_visualization_service.py          # NEW
  test_apply_service.py                  # ex-apply-related tests
  test_facade.py                         # tests that the facade correctly delegates
```

### 8.2 Migration policy for existing tests

- **Keep test file names stable across waves** to preserve `git log --follow` history per concern.
- **Move tests alongside their module's wave** — don't pre-move tests in Wave 1 to a structure that Wave 3 will reshape. Tests for `ProjectStore` move in Wave 3.
- **Existing test_modal_adapter.py** (if it exists — currently most tests are concern-specific) splits per migration wave; the residual file holds only facade-shape tests.
- **`test_project_v2_branch.py`** (24 tests including the round-15 rename suite) becomes `test_project_store.py` in Wave 3. Old name preserved via `git mv` so blame history follows.
- **`test_measurement_rename.py`** (11 round-15 tests) merges into `test_project_store.py` in Wave 3.

### 8.3 Test fixture continuity

The existing `isolated_app` fixture (Flask test client + tmp_path bases + MeasurementCatalog) works unchanged because the REST surface is preserved. Module-level tests (e.g. `test_scenario_loader.py`) can additionally construct just the module:

```python
def test_loader_discovers_v2_scenarios(tmp_path):
    ctx = ProjectContext(projects_base=str(tmp_path))
    loader = ScenarioLoader(ctx)
    result = loader.load_roomresponse_scenarios(...)
```

This is faster than the full Flask test client + simpler to assert against.

---

## 9. Backward Compatibility

### 9.1 REST API

**Preserved.** Every route in `routes/*.py` calls `adapter.foo()`; the facade's `foo()` continues to exist as a 1-line delegation. No route changes; no body-shape changes; no status-code changes.

### 9.2 Existing tests importing `ModalAdapter`

**Preserved.** `from modal_adapter import ModalAdapter` continues to work. Test fixtures `ModalAdapter()` constructor signature unchanged.

### 9.3 Frontend

**No change.** Frontend only talks to REST; doesn't import Python. Bundle freshness unaffected.

### 9.4 Documentation cross-references

`docs/modules/pianoid-middleware/MODAL_ADAPTER.md` (if it exists — verify in Wave 1 planning) gets a "(after split: see <module>)" note for each section that moved. The doc itself isn't moved; the module docs link back to it.

### 9.5 Merge to dev between waves

Each wave is independently mergeable. After Wave 1, `dev` has a working `ModalAdapter` + new `ProjectContext` + `ScenarioLoader` + `VisualizationService`. Wave 2 builds on that. If Wave 2 is delayed for any reason, Wave 1 is still useful (the moved methods are tested + the facade is smaller).

---

## 10. Risk Areas + Mitigations

### Risk 1: ProjectContext shape becomes an external contract

Once `ProjectContext` lands in Wave 1, every subsequent module reads/writes its fields. Adding a new field is cheap; renaming or removing one cascades to every module that touches it.

**Mitigation:**
- Design the FULL `ProjectContext` field set in Wave 1 (§5.1 above), even though only ScenarioLoader + VisualizationService write to it initially.
- Treat field renames as a separate PR (no other change in the same commit).
- Annotate each field with its single writer in the `@dataclass` definition (`# owner: EspritOrchestrator`).

### Risk 2: Wave 2 inter-module data flow

`EspritOrchestrator` needs `ScenarioLoader`'s output (`measurements`, `sample_rate`); `TrackingOrchestrator` needs `EspritOrchestrator`'s output (`per_scenario_results`). If Wave 1's `ProjectContext` shape is wrong, Wave 2 either changes it (breaking Wave 1's tests) or works around it (introducing the coupling the proposal exists to eliminate).

**Mitigation:**
- Wave 1's `ProjectContext` MUST be the full §5.1 — not a Wave-1-subset.
- Wave 1 includes a "dummy" stub for `EspritOrchestrator` that only constructs (doesn't run) — proves the wire-up works before Wave 2 commits to it.

### Risk 3: Round-9 deferred bug should ship before Wave 2

`_run_esprit_sync` currently ignores `esprit/config.json` (REST callers must put bands in body). Fixing it during Wave 2 entangles the bug fix with the refactor — bisection becomes harder if the fix introduces a regression.

**Mitigation:**
- ~~Ship the fix as **round 16** (standalone PR on `feature/dev-maimport-import` → merge to dev) BEFORE Wave 1 dispatches.~~ **Shipped 2026-05-21 — see WORK_IN_PROGRESS.md "Round-9 deferred defect" entry.** `_run_esprit_sync` now merges saved `esprit/config.json` into `esprit_params` when `bands` key absent (caller fields win over disk). 6 new tests in `tests/integration/test_esprit_config_sot.py`, 203 backend tests passing. Wave 1 may dispatch.

### Risk 4: Other modules touching modal_adapter.py mid-refactor

Test fixtures, `calibration_validator.py`, future dev-* sessions may touch `modal_adapter.py` between waves. A concurrent edit collides with the wave's mass-move.

**Mitigation:**
- Add a `MODULE_LOCKS.md` entry per wave with the file paths touched, locked from wave-PR-open until wave-PR-merge.
- For the user's parallel work surface (Telegram orchestrator + other dev sessions), the lock is the canonical signal. Cross-team contributors must coordinate via the lock.
- Waves are bounded (1-2 days each); the lock window is short.

### Risk 5: Test instability during waves

Migrating methods between classes can break tests in subtle ways (e.g. monkey-patching the wrong path, mock targets shifting).

**Mitigation:**
- Each wave's PR must include: (a) the migration, (b) the test moves/renames, (c) no behavior changes. If a behavior change is needed (e.g. round-16 bug fix), it ships in a separate commit within the same PR.
- Pre-merge gate: full test suite (728 tests at round 15) passes on the wave branch before merge.

### Risk 6: Documentation drift

Round 11's `create_project_from_measurement` docstring references "Phase 1 — N5"; after Wave 3 the method lives in `ProjectStore` but the docstring still says "Phase 1". Module-doc cross-references need an audit.

**Mitigation:**
- Each wave's PR includes a "docs sweep" commit updating any cross-reference that mentions the moved methods.
- Use `grep` for the moved method names across `docs/` to find stale references.

---

## 11. CODE_QUALITY.md Addendum

**Proposed location:** new section §C4.1 "Thin-Facade Policy (modal_adapter.py)" immediately after §C4 "File-Size Red Flags".

**Wording:** see §6.3 above.

**Why §C4.1 and not §C7:** the policy is a specialisation of §C4's RED-flag handling. Modal Adapter is the second instance of a god-object split (after `Pianoid.cu`); the precedent is clear that future RED files get their own facade policies. Keeping the policy adjacent to the rule it specialises makes the relationship obvious to readers.

**Future ports:** if the `Pianoid.cu` split (per `docs/proposals/pianoid-cu-split-proposal-2026-05-19.md`) also adopts a thin-facade pattern, its policy lands as §C4.2.

---

## 12. Acceptance Criteria Summary

Per wave, ALL of these must pass before merge to `dev`:

### Wave 1

- [ ] All backend tests pass (147 at round-15 baseline; may grow with new module-tests)
- [ ] All frontend tests pass (581 at round-15 baseline)
- [ ] `wc -l pianoid_middleware/modal_adapter/modal_adapter.py` drops by ≥500
- [ ] `project_context.py` exists with the full §5.1 field set
- [ ] `scenario_loader.py` exists with all §4.2 methods
- [ ] `visualization_service.py` exists with all §4.6 methods
- [ ] REST surface unchanged (manual smoke test of 5 representative endpoints)
- [ ] `tests/integration/modal_adapter/` directory created with at least 2 new module tests

### Wave 2

- [ ] All tests pass
- [ ] `wc -l modal_adapter.py` drops by ≥1,500 more (cumulative ≥2,000 since pre-Wave-1 baseline)
- [ ] ESPRIT background-thread tests pass (cancellation, progress reporting unchanged)
- [ ] Round-16 fix landed on `dev` BEFORE Wave 2 PR opens
- [ ] `esprit_orchestrator.py`, `tracking_orchestrator.py`, `apply_service.py` exist with all listed methods

### Wave 3

- [ ] All tests pass
- [ ] `wc -l modal_adapter.py` ≤ 500 (target: 400)
- [ ] Every method in `ModalAdapter` has body ≤ 3 lines excluding docstring
- [ ] CODE_QUALITY.md §C4.1 addendum landed in same PR
- [ ] `project_store.py`, `chain_editor.py` exist with all listed methods
- [ ] Module-doc cross-references updated (sweep of `docs/`)

---

## 13. Open Questions (need user input before Wave 1 dispatches)

| # | Question | Default if no answer |
|---|---|---|
| OQ1 | **Module file naming:** snake_case as proposed (`project_store.py`, `scenario_loader.py`) or PascalCase (`ProjectStore.py`)? Python convention is snake_case but the codebase has some PascalCase elsewhere. | snake_case (Python idiom + matches existing `scenario_averager.py`, `measurement_catalog.py`, etc.) |
| OQ2 | **Test reorganization:** new `tests/integration/modal_adapter/` subdirectory as proposed, or flat under `tests/integration/`? | New subdirectory (matches the source-side directory; easier for `pytest tests/integration/modal_adapter/`) |
| OQ3 | **Wave 1 sub-ordering:** ship `ScenarioLoader` + `VisualizationService` in the same PR (proposed), or split into Wave 1a + Wave 1b? | Same PR (both are low-risk; combined PR is ~1,200 LOC delta — well within review capacity) |
| OQ4 | **Round 16 ship cadence:** before Wave 1 dispatches (proposal default), or interleaved with Wave 2 prep? | Before Wave 1 (fewer in-flight changes; bisection cleaner) |
| OQ5 | **CODE_QUALITY.md §C4.1 wording:** is the proposed wording (§6.3) acceptable, or does it need user revision before Wave 3 ships it? | Ship as proposed; revise in-PR if reviewer objects |
| OQ6 | **ProjectStore sub-split:** is the 1,800 LOC `ProjectStore` acceptable as one file (still YELLOW per CODE_QUALITY), or should it be pre-split into `ProjectStore` + `ProjectImporter` + `ProjectExporter` in Wave 3? | One file in Wave 3; revisit in a hypothetical Wave 4 if growth continues |
| OQ7 | **Lock duration:** §10 risk 4 proposes "lock from wave-PR-open until wave-PR-merge". Acceptable, or is a more lenient policy preferred (e.g. lock only during the final merge window)? | Full-PR-lifetime lock — short windows but firm |

---

## 14. Implementation Log

Populated as each wave ships. Empty at proposal time.

| Wave | Status | Branch | PR / Merge SHA | LOC moved | LOC remaining in modal_adapter.py | Tests post-wave | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| Pre-wave: round 16 (run_esprit `esprit/config.json` SoT bug) | **Shipped** | `feature/dev-maimport-import` | commit `9ef3ffe` / merge `09ca972` | +50 (pure bug fix; SoT fallback block in `_run_esprit_sync`) | 5,649 (+50 from fallback block + comments) | +6 new (`test_esprit_config_sot.py`); 203 backend pass | 2026-05-21 | Closes round-9 deferred per §10 risk #3; cleared the way for Wave 2 |
| Wave 1: ProjectContext + ScenarioLoader + VisualizationService | **Shipped** | `feature/dev-maimport-import` | commit `71ddf22` / merge `f591603` | -867 (5,649 → 4,782); 23 methods + 25 state fields extracted | **4,782** (RED, but -15% in one PR) | 371/372 pass (1 pre-existing failure documented in WIP); zero new regressions; live-verified against user's PlyWoodLGtemp1_p1 | 2026-05-21 | CODE_QUALITY §C4.1 facade policy + LOC table landed in same PianoidInstall commit |
| Round 17: create-project dialog refresh + 409 surface + health-check timeout | **Shipped** | `feature/dev-maimport-import` (PianoidTunner) | commit `502afc7` / merge `4d15597` | +0 (frontend-only) | 4,782 (no change) | +6 new (3 dialog + 4 lifecycle); zero new regressions; 587/587 frontend tests pass across 50 suites | 2026-05-21 | Frontend UX fixes for the "fires very shortly + blink + Modal Adapter not running" symptoms reported after Wave 1. Backend untouched. |
| Round 18: remove per-cycle validation from project-creation averaging | **Shipped** | `feature/dev-maimport-import` (PianoidCore) | commit `070d836` / merge `3c07c8b` | +287 / -32 (validator import + setup + per-cycle loop removed; synthesized all-valid validation_results added) | 4,782 (no change — change in `scenario_averager.py`, not `modal_adapter.py`) | +3 new (TestRound18NoValidationInAveraging) + 1 inverted (round-7 guard re-purposed); 374/375 pass; zero new regressions; **live-verified on user's PlyWoodLGtemp1: 91 computed, 0 errors, 92 scenarios loaded vs round-17 pre-fix 0/91/5** | 2026-05-21 | Resolves round-15 validation-rejection blocker. Validation now lives only at recording stage (collection_engine). |
| Wave 2: EspritOrchestrator + TrackingOrchestrator + ApplyService | Pending | TBD | TBD | ~1,500 | ~3,300 | TBD | TBD | — |
| Wave 3: ProjectStore + ChainEditor + facade rewrite + CODE_QUALITY §C4.1 | Pending | TBD | TBD | ~3,200 | ~450 | TBD | TBD | Final facade collapse |

---

## 15. Appendix — Method-to-Module Cross Reference

Full sorted index of all 103 methods + their target module (for reviewer cross-check).

| Current line | Method | Target module |
|---|---|---|
| 34 | `__init__` | facade (composition only after split) |
| 120 | `state` | facade (property; reads `_ctx.run_state`) |
| 135 | `data_status` | facade (property; reads `_ctx`) |
| 169 | `has_tracking` | TrackingOrchestrator |
| 177 | `has_feedin` | TrackingOrchestrator |
| 185 | `get_tracked_chains` | TrackingOrchestrator |
| 195 | `get_feedin_data` | TrackingOrchestrator |
| 203 | `save_esprit_config` | EspritOrchestrator |
| 221 | `get_esprit_config` | EspritOrchestrator |
| 236 | `get_project_state` | facade (composition of all module states) |
| 337 | `num_excitation_points` | facade (property) |
| 341 | `num_channels` | facade (property) |
| 348 | `sample_rate` | facade (property) |
| 355 | `set_project_dir` | ProjectStore |
| 372 | `set_projects_base` | ProjectStore |
| 378 | `list_projects` | ProjectStore |
| 495 | `_resolve_project_scenarios_path` | ProjectStore |
| 561 | `_dir_has_roomresponse_scenarios` | ProjectStore |
| 600 | `_scenario_folders_for_project` | ProjectStore |
| 641 | `_load_effective_signal_length_summary` | ApplyService |
| 725 | `get_effective_signal_length` | ApplyService |
| 782 | `_qc_curves_cache` | ApplyService |
| 790 | `get_qc_curves` | ApplyService |
| 936 | `invalidate_qc_curves_cache` | ApplyService |
| 961 | `recompute_effective_signal_length` | ApplyService |
| 1026 | `reaverage_project` | ApplyService |
| 1178 | `rename_project` | ProjectStore |
| 1261 | `create_project` | ProjectStore |
| 1317 | `open_project` | ProjectStore |
| 1442 | `add_measurements_to_project` | ProjectStore |
| 1461 | `_import_measurements` | ProjectStore |
| 1519 | `_load_v2_scenarios_from_parent_measurement` | ProjectStore (calls ScenarioLoader) |
| 1676 | `copy_project` | ProjectStore |
| 1803 | `create_project_from_measurement` | ProjectStore |
| 2017 | `branch_project` | ProjectStore |
| 2082 | `delete_project` | ProjectStore |
| 2216 | `export_project` | ProjectStore |
| 2286 | `export_info` | ProjectStore |
| 2323 | `import_project` | ProjectStore |
| 2394 | `create_project_from_zip` | ProjectStore |
| 2625 | `_auto_average_scenarios` | ProjectStore |
| 2687 | `_detect_measurement_source` | ProjectStore |
| 2722 | `current_project_name` | facade (property) |
| 2726 | `projects_base` | facade (property) |
| 2729 | `_persist` | ApplyService (low-level JSON write helper) |
| 2738 | `load_intermediate` | ApplyService (dispatcher; delegates per stage) |
| 2765 | `_load_esprit_results` | EspritOrchestrator |
| 2855 | `_load_tracking_results` | TrackingOrchestrator |
| 2899 | `_enrich_chains_from_esprit` | TrackingOrchestrator |
| 2980 | `_load_feedin_results` | TrackingOrchestrator |
| 2994 | `_load_mapping_results` | ApplyService |
| 3018 | `_migrate_channel_mapping_to_mapping_config` | ProjectStore |
| 3115 | `_persist_measurement_source` | ProjectStore |
| 3139 | `load_folder` | ScenarioLoader |
| 3181 | `_is_roomresponse_folder` | ScenarioLoader |
| 3192 | `_extract_scenario_index` | ScenarioLoader |
| 3197 | `_discover_roomresponse_scenarios` | ScenarioLoader |
| 3301 | `_discover_npy_scenarios` | ScenarioLoader |
| 3354 | `load_roomresponse_scenarios` | ScenarioLoader |
| 3379 | `load_arrays` | ScenarioLoader |
| 3406 | `add_folder` | ScenarioLoader |
| 3453 | `_load_npy_raw` | ScenarioLoader |
| 3463 | `_load_roomresponse_raw` | ScenarioLoader |
| 3473 | `set_sample_rate` | ScenarioLoader |
| 3477 | `measurement_info` | ScenarioLoader |
| 3493 | `scenario_info` | ScenarioLoader |
| 3543 | `set_mapping` | EspritOrchestrator |
| 3608 | `_run_esprit_sync` | EspritOrchestrator |
| 3717 | `run_esprit` | EspritOrchestrator |
| 3762 | `_persist_esprit_results` | EspritOrchestrator |
| 3835 | `get_status` | EspritOrchestrator |
| 3846 | `get_results` | EspritOrchestrator |
| 3887 | `cancel` | EspritOrchestrator |
| 3896 | `run_full_pipeline` | EspritOrchestrator |
| 4052 | `_update_pipeline_progress` | EspritOrchestrator |
| 4069 | `run_tracking` | TrackingOrchestrator |
| 4262 | `run_feedin_extraction` | TrackingOrchestrator |
| 4388 | `set_channel_mapping` | EspritOrchestrator |
| 4441 | `apply_to_preset` | ApplyService |
| 4504 | `get_stabilization_data` | VisualizationService |
| 4573 | `get_mode_shape_data` | VisualizationService |
| 4615 | `get_mode_preview_params` | VisualizationService |
| 4636 | `get_grid_heatmap_data` | VisualizationService |
| 4875 | `save_edited_chains` | ChainEditor |
| 4910 | `merge_chains` | ChainEditor |
| 4968 | `add_point_to_chain` | ChainEditor |
| 4997 | `remove_point_from_chain` | ChainEditor |
| 5032 | `create_chain` | ChainEditor |
| 5072 | `break_chain` | ChainEditor |
| 5121 | `dissolve_in_range` | ChainEditor |
| 5172 | `delete_chains` | ChainEditor |
| 5211 | `chains_undo` | ChainEditor |
| 5234 | `chains_redo` | ChainEditor |
| 5259 | `_push_undo_snapshot` | ChainEditor |
| 5278 | `_lookup_chain` | ChainEditor |
| 5292 | `_reindex_chain_ids` | ChainEditor |
| 5297 | `_recompute_chain_stats` | ChainEditor |
| 5352 | `_persist_chains_after_edit` | ChainEditor |
| 5430 | `reset` | facade (composes per-module resets) |
| 5463 | `export_to_text_files` | ApplyService |
| 5535 | `_Chain.__init__` (class) | ChainEditor |
| 5546 | `_ChainPoint.__init__` (class) | ChainEditor |
| 5553 | `_Chain.from_dict` (classmethod) | ChainEditor |

---

**End of proposal. Awaiting orchestrator confirmation + open-question answers before Wave 1 dispatches.**
