# Pianoid Code Quality Principles

Project-wide quality criteria for the Pianoid real-time piano synthesis system. These principles apply across all 4 layers (CUDA engine, domain model, middleware, frontend) and all 4 repositories (PianoidCore, PianoidBasic, PianoidTunner, PianoidInstall).

**Note on backend servers:** Pianoid runs two independent backend servers:
- **Main Pianoid server** (port 5000) — synthesis orchestration, preset management, playback, calibration
- **Modal Adapter server** (port 5001) — modal analysis pipeline (ESPRIT, tracking, feedin, preset building)

When this document says "backend," it refers to both unless explicitly qualified.

**Note on entity lists:** This document contains lists of modules, threads, data owners, and other entities. These lists reflect a **snapshot of the current codebase** at time of writing — they are examples illustrating the principles, not exhaustive or fixed inventories. The codebase evolves; the principles are durable. When the codebase changes, update the examples but preserve the principles.

---

## The Two Primary Principles

Every design decision in this codebase is evaluated first against these two principles. All other rules in this document exist to support them. When they conflict with anything else (convenience, shorter code, faster to ship), they win.

### P1. Separation of Authority — Every piece of state has exactly ONE owner

For every piece of state — a parameter value, a config setting, a piece of runtime status, a cached derivation — there is **exactly one module, class, or process that owns it**. The owner is the only code that creates, modifies, or deletes that state. Everything else reads it **through the owner's interface** (function call, API request, event subscription) and holds at most a short-lived, derived copy.

Authority is **not about storage** (where the bytes live) but about **write authority** (who is allowed to change them). Two modules can both read a value from disk; only one is allowed to write it.

**Why this matters in Pianoid:** Parameter updates flow across four layers (frontend → main server → pybind11 → CUDA). If authority is unclear — e.g., the frontend keeps a "local copy" that it edits without waiting for the server, and the server also keeps its own copy, and both are persisted separately — the two will drift within seconds of real use. The user sees stale values, the engine receives values the user didn't mean to send, and bug reports become unreproducible. Every multi-source-of-truth violation in this codebase has eventually produced such a bug.

**Authority table (current):**

| Data | Owner | Everyone else does |
|------|-------|--------------------|
| Preset parameters (runtime) | Main Pianoid server (port 5000) | Frontend reads via REST/WS; engine receives via pybind11 |
| GPU state (buffers, kernels, stream tokens) | CUDA engine | Main server writes via pybind11; nobody else touches |
| Modal analysis project config (channels, ESPRIT, tracking) | Modal Adapter server (port 5001) | Frontend reads via `GET /modal/project_state` |
| UI layout, selection, transient state | Frontend React state | Nobody else — this is not persisted on the backend |
| Physical model definitions (strings, modes, excitation) | PianoidBasic classes | Middleware packs into flat arrays for the engine |
| Parameter file persistence | Main server writer path | Frontend never writes preset JSON directly |

**Dual-implementation note:** Preset parameters and domain model logic are currently owned by the Python layer (PianoidBasic + middleware). For real-performance playback, these may be re-implemented in C++ within the CUDA engine to eliminate Python overhead and achieve minimum latency. When a C++ implementation exists, it becomes the runtime authority for that parameter path. The Python implementation remains the reference for offline computation, testing, and preset building.

**What a violation looks like:**
- The frontend stores a "pending volume" in a React ref and also sends it to the backend — but the ref is never cleared on a successful ack, so a later preset switch reads the stale pending value and overwrites the freshly loaded preset's volume.
- Both `backendServer.py` and `modal_adapter_server.py` cache the list of available channels, derived from different sources; a hardware change updates one and not the other.
- `pianoid.py` writes a preset to disk, and `preset_manager.py` independently writes the same preset from a different code path; concurrent edits produce a file whose content matches neither.

**What the fix looks like:**
- Pick one owner. Route all writes through it. Every other holder of the value must be marked as "cache of <owner>" and refreshed on the owner's change events, never written to independently.

### P2. Separation of Concerns — Every module, class, and function has ONE job

Each module has **one reason to change**. A "manager" class that handles parameter packing AND logging AND GPU lifecycle AND preset loading has four reasons to change — four different feature directions can each require rewriting it, and edits in one direction routinely break unrelated tests.

This is not academic. In Pianoid, grab-bag classes are the largest source of regressions: the same file touched by three different feature branches in a month produces merge conflicts, lock conflicts, and subtle integration bugs where one concern's invariant is silently violated by an edit made for a different concern.

**Rules of thumb:**
- If you struggle to give a module a short noun-phrase name, its concern is not clear.
- If a class method list looks like a list of unrelated verbs (`save_preset`, `detect_hardware`, `render_chart`, `update_parameters`), the class is a grab bag.
- If a function is longer than ~50 lines, it is probably doing more than one thing. Split.
- If two cohesive halves of a file edit for different reasons over time, the file should be two files.

**What a violation looks like:**
- A `Pianoid` orchestrator that also implements parameter packing (should delegate to `ParameterManager`), MIDI handling (should delegate to `MidiListener`), **and** preset JSON persistence (should delegate to `PresetStore`) — all because "it's easier to put it here, we already have a reference to all the pieces."
- A React hook called `usePreset` that also manages WebSocket connection state, optimistic UI debouncing, and toast notifications. When the debounce policy changes, the WebSocket state machine breaks.
- A CUDA kernel file that contains both the audio synthesis kernel and the diagnostic probe kernel. Changing the diagnostic output recompiles the audio kernel and changes its timing profile.

**What the fix looks like:**
- Name the concerns. Put each concern in its own module. Draw the interface between them as data flowing one direction, not as shared mutable state.

### How the two principles interact

- **Authority** answers *who writes what state*.
- **Concern** answers *what a module does*.

They are independent — a module can have one concern and still share authority over its state with another module (bad), or have clean authority over its state but also handle three unrelated concerns (also bad). A healthy module scores well on both: it has one concern, and the state that concern requires has exactly one owner (usually the module itself, or a clearly-named collaborator whose interface it consumes).

**Every non-trivial change must be evaluated against both.** Reviewers ask two questions before anything else:
1. What state is being changed, and who owns it?
2. What concern does this module have, and does this change add a second concern?

---

## Supporting Principles

The following principles are organized under the two primary principles. Each is a concrete, codified form of one or both. When a conflict arises between a supporting principle and P1/P2, the primary principles prevail.

### Under P1 (Authority) — state & data management

#### A1. Single Source of Truth

Every configurable setting, parameter, and status has ONE authoritative storage location. No redundant copies that can diverge.

- Backend is authoritative for all persistent project state
- Frontend state is always derived from backend responses, never independently authoritative
- CUDA engine is authoritative for runtime GPU state (buffer positions, kernel parameters)
- Domain model is authoritative for physical parameter definitions and packing formats

#### A2. Explicit Persistence

If a user configures something and expects it to survive a restart, it must be saved to disk. Every persistent value has:

- A defined file and location
- A save trigger (explicit user action or processing completion)
- A load path (on project open or server start)
- A default value (when the file doesn't exist)

No "memory-only" state for user-visible settings.

#### A3. Round-Trip Consistency

`save → close → reopen` produces identical state. Every persistence path has a corresponding load path. This is testable and must be tested.

#### A4. No Silent Defaults

Default values are defined ONCE and shared across layers. If frontend and backend have different defaults for the same concept, that is a bug. When a default is applied (because saved config is missing), it should be distinguishable from an explicitly chosen value.

#### A5. Explicit User Actions

State mutations that persist require explicit user actions (Save, Apply, Run). No debounced auto-submit effects that race with initialization or restore logic. The pattern is:

1. User edits in UI (local state only)
2. User clicks Save (sends to backend, persists)
3. Backend confirms, frontend refreshes from backend response

### Under P2 (Concern) — architecture, modularity & structure

#### C1. Clear Layer Boundaries (4-layer architecture)

Each of the four layers has a defined responsibility. No layer reaches into another's internals. Communication only through defined interfaces:

| Interface | Protocol | Direction |
|-----------|----------|-----------|
| Engine ↔ Middleware | pybind11 C function calls | Bidirectional |
| Middleware ↔ Frontend | REST + Socket.IO WebSocket | Bidirectional |
| Domain Model → Middleware | Python wheel import | One-way |
| Engine → Audio Driver | Callback ring buffer | One-way |

**Layer responsibilities:**

- **CUDA engine:** Real-time synthesis, audio output, GPU memory management
- **Domain model (PianoidBasic):** Physical parameters, string geometry, serialization — pure Python, no I/O, no side effects. Reference implementation; the CUDA engine may duplicate logic in C++ for real-time paths.
- **Main Pianoid middleware (port 5000):** Synthesis orchestration, preset management, parameter routing, playback control, calibration, MIDI handling, HTTP/WS API
- **Modal Adapter middleware (port 5001):** Modal analysis pipeline — ESPRIT extraction, mode tracking, feedin computation, preset building from measurement data
- **Frontend:** Visualization, user interaction, parameter editing — no business logic, no authoritative state

#### C2. Dual-Server Separation (5000 vs 5001)

The main server and the modal adapter run in **separate processes**. This is deliberate: they hold independent GPU contexts and have independent lifecycles. A layer violation here is a process-crossing violation and is severe.

Rules:
- Main server code (anything rooted at `backendServer.py` + `pianoid.py`) must not import from `modal_adapter/*`
- Modal adapter code (anything under `pianoid_middleware/modal_adapter/`) must not import from the main server module (`backendServer`, `pianoid`, `parameter_manager`, `calibration_controller`)
- Shared utilities (e.g. logging) live at the middleware root and are imported by both, never the reverse
- Frontend code calls each server at its own port — no "the main server proxies to the modal server" shortcut, because that creates an authority crossing (P1 violation) on top of the concern crossing

#### C3. Modularity (orchestrators vs computation)

**Principle:** Computation modules are stateless pure functions — they take inputs and return outputs with no side effects. State lives only in orchestrator objects, never in computation helpers.

**Orchestrators** (stateful, manage lifecycle):
- `Pianoid` — main synthesis orchestrator (preset loading, parameter routing, playback)
- `ModalAdapter` — modal analysis project orchestrator (ESPRIT pipeline, persistence)

**Computation modules** (stateless, pure):
- Domain model: `StringMap`, `ModeMap`, `ExcitationParameters`, `SoundChannels`, `Mode`, `Piano_string`
- Modal analysis: `EspritRunner`, `FeedinExtractor`, `PresetInjector`, `mode_tracking`, `band_merging`, `esprit_core`
- Middleware: `ParameterManager`, `ChartRegistry`, `CalibrationController`
- CUDA engine: `OnlinePlaybackEngine`, `OfflinePlaybackEngine`, `CircularBuffer`, audio drivers

**Rule:** When adding new functionality, determine whether it is computation (stateless) or orchestration (stateful). New computation does not get its own state — it receives inputs and returns outputs. New orchestration is rare and requires architectural justification.

#### C4. File-Size Red Flags — The God-Object Rule

Large files are a proxy for mixed concerns. A file that keeps growing is almost always absorbing multiple responsibilities that should be siblings, not members of the same object. This is the most visible, measurable P2 violation.

**Thresholds:**

| LOC | Flag | Severity | Action |
|-----|------|----------|--------|
| > 1000 | RED | **High** (automatic) | Reviewer must produce a refactor plan — split by concern. Do not add new code to a red-flagged file without first splitting, unless the change is a pure bug fix. |
| 500–1000 | YELLOW | **Medium** | Reviewer must discuss in the review: is this file still cohesive? If growing toward 1000, flag for refactor soon. |
| < 500 | — | — | No size finding. |

These thresholds apply to the source file's total LOC as measured by `wc -l` on the file itself (including blanks and comments). They are heuristics, not laws — a 1200-line table of constants is not the same as a 1200-line grab-bag class — but every instance must be justified in the review.

**Why measure LOC and not complexity?** LOC is a cheap, unambiguous signal that any reviewer can compute in seconds. Complexity metrics (cyclomatic, cognitive) are more accurate but require tooling and argument. LOC lets the red flag raise itself.

**Applying the rule:**
- A RED flag is an automatic High-severity finding in any review whose scope includes the file. It triggers a module-level review.
- A YELLOW flag is a Medium finding. It must be discussed, even if the conclusion is "keep it as-is for now because X."
- A new file that starts over 500 lines is a red flag on arrival — it was already two files before it was written.

#### C5. Structural Consistency

- Every REST endpoint follows the same pattern: validate → process → respond with consistent JSON structure
- Every React hook follows the same pattern: state → callbacks → effects → return object
- Every CUDA kernel parameter follows the same packing convention (flat arrays, same ordering)
- Config files use consistent JSON structure within each domain

#### C6. Directory Structure Reflects Functional Hierarchy

Directory structure must reflect the functional hierarchy of the system. Each directory groups related functionality, and nesting reflects containment relationships. When adding new modules, place them where they functionally belong — not where it's convenient.

```
PianoidCore/
  pianoid_cuda/              # Layer 4: CUDA synthesis engine
    *.cu, *.cuh, *.cpp, *.h  #   Kernels, drivers, playback engines, buffers
  pianoid_middleware/         # Layer 2: Python backend (both servers)
    backendServer.py          #   Main Pianoid server (port 5000)
    pianoid.py                #   Main orchestrator
    parameter_manager.py      #   Parameter packing/routing
    chartFunctions.py         #   Chart generation
    modal_adapter/            #   Modal analysis subsystem (port 5001)
      modal_adapter.py        #     Modal orchestrator
      modal_adapter_server.py #     Modal server entry point
      routes.py               #     Modal API endpoints
      mapping.py              #     Channel/mapping config
      esprit/                 #     ESPRIT extraction library
      feedin_extractor.py     #     Feedin computation
      preset_injector.py      #     Preset building
  tests/                      # Mirrors source structure
    unit/                     #   Isolated component tests
    integration/              #   Cross-component tests
    system/                   #   Full-stack tests (GPU required)

PianoidBasic/
  Pianoid/                    # Layer 3: Domain model package
    Mode.py, Piano_string.py  #   Physical entities
    StringMap.py, ModeMap.py  #   Collection managers
    Excitation.py             #   Excitation model
    SoundChannels.py          #   Output coupling

PianoidTunner/
  src/
    components/               # Reusable UI components (PascalCase.jsx)
    hooks/                    # React hooks — state + logic (useXxx.js)
    modules/                  # Page-level components (PascalCase.jsx)
  server/                     # Node.js launcher (manages both backend servers)

PianoidInstall/
  docs/                       # All documentation (MkDocs)
    architecture/             #   System-level docs
    modules/                  #   Per-module reference
    guides/                   #   How-to guides
    development/              #   Dev processes, testing, quality
  presets/                    # Preset JSON files
  tools/                      # Utility scripts
```

**Principle:** If the directory structure doesn't reflect the functional hierarchy, that's a structural debt to be addressed — not a convention to follow. New code goes where it functionally belongs, and existing misplacements should be corrected when the module is next modified.

### Under both primaries — code style & discipline

#### S1. Lean Code

No speculative features, unused parameters, or dead endpoints. Every function, endpoint, and state variable has an active consumer. Code that was needed once but is no longer used is removed, not commented out or left "for later."

#### S2. No Redundancy

One concept, one implementation. No duplicate storage files for the same data. No parallel code paths that do the same thing differently. If two endpoints serve the same purpose, one is removed.

#### S3. No Code Duplication

Shared logic is extracted into utilities or base classes. If three files perform the same validation, extract it. But don't prematurely abstract — three similar lines of code are better than a premature abstraction that obscures intent.

#### S4. Stateless Where Possible

Computation functions take inputs and return outputs with no side effects. State is concentrated in orchestrator objects, not scattered across helpers. This makes functions testable, composable, and predictable. (This is the implementation-level form of C3.)

#### S5. Fail Fast — No Patches, No Workarounds, No Swallowed Errors

Invalid state, missing dependencies, wrong environment — detect at startup, not during processing. **Fix root causes, not symptoms.** If a call is failing, diagnose why the caller's expectation is wrong, don't wrap it in `try: ... except: pass`. If a timing-dependent sequence fails, replace the sleep with an event or ack, don't make the sleep longer.

**Anti-patterns to refuse on review:**

- `try: ...` followed by `except: pass` or `except Exception: pass` — every exception-swallowing clause must log and either re-raise or return a well-defined sentinel that the caller handles. "Silently eat it" is never the right choice.
- `if <condition>: return default_value` as a fallback that hides a bug — the default should be explicitly declared at the call site, not as a desperate last resort inside the function.
- `time.sleep(X)` used for synchronization when an event, ack, or condition variable exists.
- `TODO`/`FIXME`/`HACK`/`XXX` comments that persist across commits — either fix it now or record it in `WORK_IN_PROGRESS.md` as a named, owned item.
- Compatibility shims for old paths that were supposed to be removed after migration.
- "Just in case" dead branches — code that handles a condition the rest of the system provably cannot produce.

Examples of the principle followed well:
- Venv guard: server validates Python interpreter before importing dependencies
- Port guard: server checks for stale processes before binding
- Dependency check: CuPy availability detected at startup with clear fallback notification
- Config validation: invalid channel roles rejected immediately, not during ESPRIT processing

#### S5b. UI Does Not Pre-Clamp Engine-Bound Parameters

The frontend is not the authority on parameter validity for the synthesis engine. **Engine-bound parameter editors must not impose UI-layer min/max clamps that silently destroy user input.** Per dev-c5fd / dev-2706 (2026-05-03): a `volume.max=20` clamp in `GaussEditor.jsx` made every typed value collapse to 20 when real preset volumes are 1e7–1e9. Any value the user typed was silently lost — no error, no feedback, just a wrong value committed to the engine.

The fix is two-layered:

1. **UI layer** — engine-bound NumInput callers (Gauss, Mode, String, Hammer, Deck/Sound-Channel coefficients via ToolBar/MatrixTools) omit `min`/`max`. NumInput defaults to `±Infinity`, making its internal clamp paths no-ops. Hard system bounds (MIDI velocity 0–127, sample_rate, audio_buffer_size, calibration timing windows in TimingBandEditor) keep their explicit `min`/`max` because the value range is a protocol/algorithmic constraint, not a UX guess.
2. **Backend layer (S5 fail-fast)** — `parameter_manager` rejects catastrophic inputs (mass_inv ≤ 0, sigma ≤ 0, frequency < 0, decrement < 0, plus a universal NaN/Inf guard) with HTTP 400 so the user gets a clear error rather than a silently-NaN engine. Implemented by dev-9a47 (2026-05-03) — see `parameter_manager.py` `validate_engine_param` / `ParameterRangeError` and REST_API.md "Engine safety net (catastrophic-input rejection)". Regression test: `tests/integration/test_parameter_safety_net.py` (43 cases).

The anti-pattern this prevents: "the UI knows better than the user what range is reasonable" — replaces user agency with developer guesses, often based on a single preset's data and stale by the next preset.

---

## Naming & Consistency

### N1. Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Python functions/variables | `snake_case` | `run_tracking`, `damping_ratio` |
| Python classes | `PascalCase` | `ModeDetection`, `EspritRunner` |
| Python constants | `UPPER_SNAKE` | `MAX_OUTPUT_CHANNELS`, `VALID_ROLES` |
| JavaScript functions/variables | `camelCase` | `syncFromBackend`, `channelRoles` |
| React components | `PascalCase` | `StabilizationDiagram`, `MappingEditor` |
| JavaScript constants | `UPPER_SNAKE` | `DEFAULT_CONFIG`, `INITIAL_STAGES` |
| React hooks | `camelCase` with `use` prefix | `useModalAdapter`, `usePreset` |
| C++/CUDA methods | `camelCase` | `mainKernel`, `setNewModeParameters` |
| C++/CUDA classes | `PascalCase` | `OnlinePlaybackEngine`, `CircularBuffer` |
| API endpoints | lowercase with underscores | `/modal/run_esprit`, `/set_runtime_parameters` |
| Files (Python) | `snake_case.py` | `esprit_runner.py`, `mode_tracking.py` |
| Files (React components) | `PascalCase.jsx` | `StabilizationDiagram.jsx`, `MappingEditor.jsx` |
| Files (React hooks) | `camelCase.js` with `use` prefix | `useModalAdapter.js`, `usePreset.js` |
| Files (C++/CUDA) | `PascalCase` | `Pianoid.cu`, `CircularBuffer.cu` |

### N2. Terminology Consistency

Physical and domain terms use the same name across ALL layers — Python, JavaScript, C++, JSON, documentation:

| Term | Meaning | Used In |
|------|---------|---------|
| `frequency` | Natural frequency in Hz | All layers |
| `damping_ratio` | Dimensionless zeta (ratio to critical damping) | ESPRIT, tracking, preset |
| `decrement` | Logarithmic decrement: `2π·ζ/√(1-ζ²)` | Domain model, preset JSON |
| `mode_shape` | Complex spatial pattern per mode per channel | ESPRIT, tracking, feedin |
| `amplitude` | RMS mode shape amplitude: `√mean(|shape|²)` | Tracking, visualization |
| `feedin` | Coupling coefficient: string → soundboard mode | Feedin, preset, CUDA deck matrix |

No synonyms. `dump_ratio` vs `damping_ratio` is a bug, not a style preference.

---

## Real-Time & Performance

### RT1. Audio Thread Inviolability

The audio callback thread (C++) never blocks on Python, network, disk, or contested locks. Parameter updates use lock-free double buffering. The audio thread only reads from the read buffer and writes PCM samples to the ring buffer.

### RT2. GPU Budget Awareness

Every operation in the CUDA kernel synthesis loop must fit within the per-cycle GPU budget. The budget is not a fixed value — it equals `cycle_iterations / sample_rate` (e.g., 64 samples / 48000 Hz = 1.33ms). Both `cycle_iterations` (buffer size) and `sample_rate` are configurable. New features that touch the hot path require timing verification with the performance test suite across representative configurations.

### RT3. No Silent Drops

If a parameter update is dropped (`DROP_IF_BUSY` policy), it is logged. If a buffer underrun occurs, it is reported. The user can always diagnose "why didn't my change take effect." (This is the real-time form of S5.)

### RT4. Graceful Degradation

The system produces output even when components are degraded:

| Failure | Degradation | User Notification |
|---------|-------------|-------------------|
| GPU unavailable | CPU fallback (slower) | GPU status indicator in modal-adapter ESPRIT panel ("GPU: not available" / "unreachable" / "checking…"); dev-3st1 fixed the previously-broken one-shot fetch. |
| CuPy not installed | NumPy ESPRIT (CPU only) | Same GPU status indicator as above |
| ASIO driver fails | SDL fallback (higher latency) | Audio driver status |
| WebSocket disconnected | REST fallback (higher debounce) | Connection indicator |

Graceful degradation is **not** a fallback that hides bugs (S5) — every degradation path is explicit, user-visible, and instrumented.

### RT5. Thread Management

The system has multiple concurrent threads with strict interaction rules:

| Thread | Owner | Constraints |
|--------|-------|-------------|
| Audio callback (C++) | Audio driver (ASIO/SDL) | Never blocks. No Python, no locks, no allocation. Reads from ring buffer only. |
| CUDA synthesis loop (C++) | `OnlinePlaybackEngine` | Runs `mainKernel` per cycle. Writes to `CircularBuffer`. Holds GPU context. |
| Flask request handlers (Python) | Main Pianoid server (port 5000) | Acquires `cuda_lock` before any pybind11 call. Sequential via lock. |
| Modal adapter main thread (Python) | Modal Adapter server (port 5001) | `threaded=False` — all requests sequential. Holds its own CUDA context (CuPy). |
| MIDI listener (Python/C++) | `RtMidi` callback thread | Writes to `RealTimeEventBuffer` (thread-safe). No Python GIL dependency. |
| WebSocket event handlers (Python) | Flask-SocketIO | Share `cuda_lock` with REST handlers. Must not hold lock during I/O waits. |

**Rules:**
- Never create new threads without documenting their interaction with existing threads
- The CUDA engine's GPU context and the Modal Adapter's CuPy GPU context run in separate processes to avoid GPU deadlock — do not merge them into one process
- `cuda_lock` serializes all Python→C++ calls on the main Pianoid server. Every pybind11 call must be inside the lock. No nested locking.
- The audio callback thread must never be blocked by any other thread. If it starves, the user hears glitches.

---

## Testing & Verification

### T1. Persistence Round-Trip Tests

Every configurable setting has an automated test: `set value → persist → reload → verify identical`. This catches the most common class of bugs (settings lost on restart, defaults overwriting saved values).

### T2. Cross-Layer Integration Tests

Frontend sends config → backend processes → result matches config. These tests catch default-override bugs, serialization mismatches, and silent type coercions.

### T3. Audio Verification

Changes affecting synthesis output require measured before/after comparison via `note_playback` chart — not subjective listening. The chart provides deterministic peak amplitude, RMS, and spectral data.

### T4. GPU/CPU Parity

ESPRIT results from GPU (CuPy) and CPU (NumPy) paths produce equivalent outputs within numerical tolerance. This ensures the CPU fallback path is trustworthy.

### T5. UI Feature Verification

Frontend changes are verified by launching the stack and interacting via browser. Type checking and test suites verify code correctness, not feature correctness.

---

## Documentation

### D1. Code Matches Docs

Parameter names, data formats, API signatures, and architectural descriptions in docs match current code. Stale documentation references are bugs with the same priority as code bugs.

### D2. Docs-First Development

Before modifying code, consult the documentation to understand the existing architecture. When behavior changes, update docs in the same commit. The documentation hierarchy (`docs/index.md` → architecture → modules → guides) is the entry point for understanding any subsystem.

---

## Applying These Principles

### For Every Change (Code Review Priority Order)

1. **P1 — Authority.** Does the change introduce a second source of truth, or does every piece of state still have exactly one owner?
2. **P2 — Concern.** Does the change keep the modified module's concern narrow, or does it widen the module's responsibility?
3. **C4 — God-object.** Does the change push the file over 500 or 1000 LOC? If so, split first, edit second.
4. **S5 — Patches & workarounds.** Does the change fix the root cause, or does it paper over symptoms with sleeps, fallbacks, swallowed exceptions, or TODO notes?
5. **A1 — Single source of truth in new state.** Any new config, parameter, or status — where does it live and who writes it?
6. **A2 — Persistence.** Will this setting survive a restart, and is that the intended behavior?
7. **A4 — Default consistency.** Are defaults defined in exactly one place and consistent across layers?
8. **N1/N2 — Naming and terminology.** Does it match conventions? Any new synonyms for existing terms?

### For New Features

Before implementing, verify:

1. Which layer owns this feature's state? (P1, C1)
2. Which concern does it belong to — existing module or a new one? (P2, C3)
3. Where is it persisted? (A2)
4. How is it restored on restart/reopen? (A3)
5. What are the defaults and are they consistent? (A4)
6. Will it push any file past 500 or 1000 lines? (C4)
7. How is it tested (round-trip, integration, UI)? (T1, T2, T5)

---

## Current Known God Objects (Baseline Debt)

Snapshot taken 2026-04-19. These files are currently above the C4 thresholds and represent known structural debt to be reduced over time. They are listed here so the debt is visible and reviewers know where new code must NOT land without splitting first.

**Do not refactor these in the course of an unrelated change** — refactoring a god object is its own work item, requires its own plan, and must not be bundled with a bug fix or feature. The goal of this list is to raise awareness and to force a refactor plan the next time a substantive change lands in one of these files.

### RED flags (> 1000 LOC — High-severity structural findings)

| Rank | File | LOC | Notes |
|------|------|-----|-------|
| 1 | `PianoidCore/pianoid_middleware/backendServer.py` | 3553 | Main server routes + lifecycle; several concerns (REST, WS, calibration proxy, MIDI). +112 at dev-bfe2 (preset working-copy endpoints, 2026-05-18) |
| 2 | `PianoidCore/pianoid_middleware/pianoid.py` | 3177 | Main synthesis orchestrator; preset loading + parameter routing + playback + more. +182 at dev-bfe2 (working-copy spawn/promote/guard methods, 2026-05-18) — the `PresetLibrary` registry data structure was carved out to `preset_library.py`, but the orchestration methods correctly stay here; the file remains RED and a deeper preset-IO carve-out is still open (WIP §4.3) |
| 3 | `PianoidCore/pianoid_cuda/Pianoid.cu` | 2952 | CUDA synthesis hub; multiple concerns (kernel orchestration, parameter packing, lifecycle) |
| 4 | `PianoidTunner/src/PianoidTuner.js` | 2793 | Top-level frontend orchestrator; mixes layout, routing, pane config, top-level state |
| 5 | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` | 2725 | Modal adapter orchestrator; pipeline stages + persistence + config |
| 6 | `PianoidCore/pianoid_middleware/chartFunctions.py` | 2589 | Chart generation for many chart types; natural split by chart family |
| 7 | `PianoidTunner/src/components/StabilizationDiagram.jsx` | 2231 | Stabilization diagram — data prep + ECharts config + interaction + sub-panels |
| 8 | `PianoidTunner/src/components/NumInput/NumInput.js` | 1537 | Numeric input — should not be this large; likely mixes edit, step, scroll, display concerns. (2026-05-17 cursor-drift fix trimmed it 1565→1537; still RED — full split is the open numinput-inventory rec #4.) |
| 9 | `PianoidTunner/src/hooks/usePreset.js` | 1514 | Preset hook — WS + REST + debounce + optimistic UI + available notes + library records / spawn / promote (dev-bfe2, 2026-05-18) |
| 10 | `PianoidTunner/src/hooks/useModalAdapter.js` | 1356 | Modal adapter hook — REST + WS + project state + ESPRIT triggers |
| 11 | `PianoidCore/pianoid_middleware/calibration_controller.py` | 1324 | Calibration — direct correction + bisection + sequence + I/O |
| 12 | `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py` | 1215 | Mode tracking — proposals + assignment + lifecycle + scoring |
| 13 | `PianoidCore/pianoid_cuda/UnifiedGpuMemoryManager.cu` | 1122 | GPU memory manager — allocation + pooling + tracking |
| 14 | `PianoidTunner/src/modules/ModalAdapter.jsx` | 1077 | Modal adapter page — layout + multi-pane config + top-level state |
| 15 | `PianoidCore/pianoid_cuda/asio.h` | 1070 | Vendor header — third-party; excluded from refactor unless re-homed |

### YELLOW flags (500–1000 LOC — Medium-severity structural findings)

| File | LOC |
|------|-----|
| `PianoidCore/pianoid_middleware/modal_adapter/routes.py` | 880 |
| `PianoidCore/pianoid_cuda/AddArraysWithCUDA.cpp` | 831 |
| `PianoidCore/pianoid_middleware/modal_adapter/preset_injector.py` | 827 |
| `PianoidCore/pianoid_middleware/modal_adapter/measurement_routes.py` | 975 | (dev-maimport, 2026-05-19 — was 807 YELLOW; +168 LOC adding probe/import_folder/unzip_helper endpoints — still YELLOW, P2-split candidate is "carve import endpoints into measurement_import_routes.py"). |
| `PianoidCore/pianoid_middleware/modal_adapter/measurement_import.py` | 644 | (dev-maimport, 2026-05-19 — new module; shared by REST + future CLI use. P1/P2 clean — single concern, single owner.) |
| `PianoidCore/pianoid_cuda/MainKernel.cu` | 762 |
| `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py` | 759 |
| `PianoidCore/pianoid_cuda/Pianoid.cuh` | 742 |
| `PianoidBasic/Pianoid/StringMap.py` | 686 |
| `PianoidCore/pianoid_middleware/test_backendserver_audio.py` | 664 |
| `PianoidCore/pianoid_cuda/AsioAudioInterface.cpp` | 656 |
| `PianoidTunner/src/components/CurveEditor.jsx` | 655 |
| `PianoidTunner/src/components/ChartSelector.jsx` | 634 |
| `PianoidCore/pianoid_middleware/auto_tuner.py` | 607 |
| `PianoidBasic/Pianoid/StringExcitation.py` | 589 |
| `PianoidCore/pianoid_middleware/modal_adapter/esprit/esprit_core.py` | 586 |
| `PianoidBasic/Pianoid/Pitch.py` | 570 |
| `PianoidTunner/src/components/newWindowChart.jsx` | 557 |
| `PianoidCore/pianoid_middleware/pianoidMidiListener.py` | 541 |
| `PianoidCore/pianoid_middleware/synthesis_tuner.py` | 538 |
| `PianoidTunner/src/components/ToolBar.jsx` | 532 |
| `PianoidTunner/src/components/Excitation.jsx` | 532 |
| `PianoidTunner/src/components/CalibrationPanel.jsx` | 518 |
| `PianoidCore/pianoid_cuda/setup.py` | 516 |
| `PianoidCore/pianoid_middleware/test_audio_driver.py` | 514 |
| `PianoidTunner/src/hooks/useSettings.js` | 514 |
| `PianoidCore/pianoid_middleware/parameter_manager.py` | 509 |
| `PianoidCore/pianoid_middleware/ChartRegistry.py` | 507 |
| `PianoidCore/pianoid_cuda/SDL3AudioDriver.cpp` | 506 |

### Recent deletions

- 2026-04-27 (dev-ghost-ui-b8bb, review Phase 1.1) — `PianoidTunner/src/modules/Deck.jsx` (772 LOC YELLOW) and `PianoidTunner/src/modules/Excitation.jsx` (545 LOC YELLOW) deleted as part of the App.js ghost-UI dead-code closure (~2677 LOC across 15 files). The closure was reachable only from `src/App.js`, which `src/index.js` never mounted; the live entry is `<PianoidTuner />`. Two YELLOW entries removed from the table above.

### Maintenance rule for this list

Regenerate this list whenever a `system`-level review is run, or whenever a file transitions between flag tiers. The list is a **snapshot** — do not cite it to argue that a file "is supposed to be this big." Every entry here is a debt item; its presence is neutral historical fact, not an endorsement.
