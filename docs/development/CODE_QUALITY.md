# Pianoid Code Quality Principles

Project-wide quality criteria for the Pianoid real-time piano synthesis system. These principles apply across all 4 layers (CUDA engine, domain model, middleware, frontend) and all 4 repositories (PianoidCore, PianoidBasic, PianoidTunner, PianoidInstall).

---

## 1. Architecture & Separation

### 1.1 Clear Layer Boundaries

Each layer has a defined responsibility. No layer reaches into another's internals. Communication only through defined interfaces:

| Interface | Protocol | Direction |
|-----------|----------|-----------|
| Engine ↔ Middleware | pybind11 C function calls | Bidirectional |
| Middleware ↔ Frontend | REST + Socket.IO WebSocket | Bidirectional |
| Domain Model → Middleware | Python wheel import | One-way |
| Engine → Audio Driver | Callback ring buffer | One-way |

### 1.2 Separation of Concerns

- **CUDA engine:** Real-time synthesis, audio output, GPU memory management
- **Domain model (PianoidBasic):** Physical parameters, string geometry, serialization — pure Python, no I/O, no side effects
- **Middleware:** Orchestration, HTTP/WS API, persistence, modal analysis (ESPRIT), calibration
- **Frontend:** Visualization, user interaction, parameter editing — no business logic, no authoritative state

### 1.3 Separation of Authority

Every piece of data has exactly ONE owner. The owner is the only code that creates, modifies, or deletes it. Others read through the owner's interface.

| Data | Owner | Others |
|------|-------|--------|
| Preset parameters | Middleware (Pianoid orchestrator) | Frontend reads via API |
| GPU state (buffers, kernels) | CUDA engine | Middleware writes via pybind11 |
| Project config (channels, ESPRIT, tracking) | Backend ModalAdapter | Frontend reads via `GET /modal/project_state` |
| UI layout, selection, transient state | Frontend React state | Nobody else |
| Physical model (strings, modes, excitation) | PianoidBasic classes | Middleware packs into flat arrays |

### 1.4 Modularity

Each module is independently testable, replaceable, and understandable. Computation modules are stateless pure functions — they take inputs and return outputs with no side effects:

- `EspritRunner` — ESPRIT extraction orchestration
- `FeedinExtractor` — feedin coefficient computation
- `PresetInjector` — preset building from modal data
- `mode_tracking` — chain tracking across scenarios
- `band_merging` — multi-band deduplication

State lives only in orchestrators (`Pianoid`, `ModalAdapter`), never in computation helpers.

---

## 2. State & Data Management

### 2.1 Single Source of Truth

Every configurable setting, parameter, and status has ONE authoritative storage location. No redundant copies that can diverge.

- Backend is authoritative for all persistent project state
- Frontend state is always derived from backend responses, never independently authoritative
- CUDA engine is authoritative for runtime GPU state (buffer positions, kernel parameters)
- Domain model is authoritative for physical parameter definitions and packing formats

### 2.2 Explicit Persistence

If a user configures something and expects it to survive a restart, it must be saved to disk. Every persistent value has:

- A defined file and location
- A save trigger (explicit user action or processing completion)
- A load path (on project open or server start)
- A default value (when the file doesn't exist)

No "memory-only" state for user-visible settings.

### 2.3 Round-Trip Consistency

`save → close → reopen` produces identical state. Every persistence path has a corresponding load path. This is testable and must be tested.

### 2.4 No Silent Defaults

Default values are defined ONCE and shared across layers. If frontend and backend have different defaults for the same concept, that is a bug. When a default is applied (because saved config is missing), it should be distinguishable from an explicitly chosen value.

### 2.5 Explicit User Actions

State mutations that persist require explicit user actions (Save, Apply, Run). No debounced auto-submit effects that race with initialization or restore logic. The pattern is:

1. User edits in UI (local state only)
2. User clicks Save (sends to backend, persists)
3. Backend confirms, frontend refreshes from backend response

---

## 3. Code Structure & Style

### 3.1 Lean Code

No speculative features, unused parameters, or dead endpoints. Every function, endpoint, and state variable has an active consumer. Code that was needed once but is no longer used is removed, not commented out or left "for later."

### 3.2 No Redundancy

One concept, one implementation. No duplicate storage files for the same data. No parallel code paths that do the same thing differently. If two endpoints serve the same purpose, one is removed.

### 3.3 No Code Duplication

Shared logic is extracted into utilities or base classes. If three files perform the same validation, extract it. But don't prematurely abstract — three similar lines of code are better than a premature abstraction that obscures intent.

### 3.4 Stateless Where Possible

Computation functions take inputs and return outputs with no side effects. State is concentrated in orchestrator objects, not scattered across helpers. This makes functions testable, composable, and predictable.

### 3.5 Fail Fast

Invalid state, missing dependencies, wrong environment — detect at startup, not during processing. Examples:

- Venv guard: server validates Python interpreter before importing dependencies
- Port guard: server checks for stale processes before binding
- Dependency check: CuPy availability detected at startup with clear fallback notification
- Config validation: invalid channel roles rejected immediately, not during ESPRIT processing

---

## 4. Naming & Consistency

### 4.1 Naming Conventions

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

### 4.2 Terminology Consistency

Physical and domain terms use the same name across ALL layers — Python, JavaScript, C++, JSON, documentation:

| Term | Meaning | Used In |
|------|---------|---------|
| `frequency` | Natural frequency in Hz | All layers |
| `damping_ratio` | Dimensionless zeta (ratio to critical damping) | ESPRIT, tracking, preset |
| `decrement` | Logarithmic decrement: `2π·ζ/√(1-ζ²)` | Domain model, preset JSON |
| `mode_shape` | Complex spatial pattern per mode per channel | ESPRIT, tracking, feedin |
| `amplitude` | RMS mode shape amplitude: `√mean(\|shape\|²)` | Tracking, visualization |
| `feedin` | Coupling coefficient: string → soundboard mode | Feedin, preset, CUDA deck matrix |

No synonyms. `dump_ratio` vs `damping_ratio` is a bug, not a style preference.

### 4.3 Structural Consistency

- Every REST endpoint follows the same pattern: validate → process → respond with consistent JSON structure
- Every React hook follows the same pattern: state → callbacks → effects → return object
- Every CUDA kernel parameter follows the same packing convention (flat arrays, same ordering)
- Config files use consistent JSON structure within each domain

### 4.4 Directory Structure Consistency

Each repo follows its established layout:

```
PianoidCore/
  pianoid_cuda/          # C++/CUDA source
  pianoid_middleware/     # Python backend
    modal_adapter/       # Modal analysis subsystem
      esprit/            # ESPRIT library
  tests/                 # Mirrors source structure
    unit/
    integration/
    system/

PianoidBasic/
  Pianoid/               # Domain model package

PianoidTunner/
  src/
    components/          # Reusable UI components
    hooks/               # React hooks (state + logic)
    modules/             # Page-level components
  server/                # Node.js launcher

PianoidInstall/
  docs/                  # All documentation (MkDocs)
    architecture/
    modules/
    guides/
    development/
```

New modules go in the correct directory. Tests mirror source structure.

---

## 5. Real-Time & Performance

### 5.1 Audio Thread Inviolability

The audio callback thread (C++) never blocks on Python, network, disk, or contested locks. Parameter updates use lock-free double buffering. The audio thread only reads from the read buffer and writes PCM samples to the ring buffer.

### 5.2 GPU Budget Awareness

Every operation in the CUDA kernel synthesis loop must fit within the 1.33ms cycle budget (64 samples @ 48 kHz). New features that touch the hot path require timing verification with the performance test suite.

### 5.3 No Silent Drops

If a parameter update is dropped (`DROP_IF_BUSY` policy), it is logged. If a buffer underrun occurs, it is reported. The user can always diagnose "why didn't my change take effect."

### 5.4 Graceful Degradation

The system produces output even when components are degraded:

| Failure | Degradation | User Notification |
|---------|-------------|-------------------|
| GPU unavailable | CPU fallback (slower) | Warning in UI |
| CuPy not installed | NumPy ESPRIT (CPU only) | GPU status indicator |
| ASIO driver fails | SDL fallback (higher latency) | Audio driver status |
| WebSocket disconnected | REST fallback (higher debounce) | Connection indicator |

---

## 6. Testing & Verification

### 6.1 Persistence Round-Trip Tests

Every configurable setting has an automated test: `set value → persist → reload → verify identical`. This catches the most common class of bugs (settings lost on restart, defaults overwriting saved values).

### 6.2 Cross-Layer Integration Tests

Frontend sends config → backend processes → result matches config. These tests catch default-override bugs, serialization mismatches, and silent type coercions.

### 6.3 Audio Verification

Changes affecting synthesis output require measured before/after comparison via `note_playback` chart — not subjective listening. The chart provides deterministic peak amplitude, RMS, and spectral data.

### 6.4 GPU/CPU Parity

ESPRIT results from GPU (CuPy) and CPU (NumPy) paths produce equivalent outputs within numerical tolerance. This ensures the CPU fallback path is trustworthy.

### 6.5 UI Feature Verification

Frontend changes are verified by launching the stack and interacting via browser. Type checking and test suites verify code correctness, not feature correctness.

---

## 7. Documentation

### 7.1 Code Matches Docs

Parameter names, data formats, API signatures, and architectural descriptions in docs match current code. Stale documentation references are bugs with the same priority as code bugs.

### 7.2 Docs-First Development

Before modifying code, consult the documentation to understand the existing architecture. When behavior changes, update docs in the same commit. The documentation hierarchy (`docs/index.md` → architecture → modules → guides) is the entry point for understanding any subsystem.

---

## Applying These Principles

### For Code Review

Every code change should be evaluated against these principles. The most impactful checks:

1. **Does the change introduce a second source of truth?** (Principle 2.1)
2. **Will this setting survive a restart?** (Principle 2.2)
3. **Are defaults consistent across layers?** (Principle 2.4)
4. **Is there an active consumer for every new function/endpoint?** (Principle 3.1)
5. **Does the naming match existing conventions?** (Principle 4.1, 4.2)

### For New Features

Before implementing, verify:

1. Which layer owns this feature's state?
2. Where is it persisted?
3. How is it restored on restart/reopen?
4. What are the defaults and are they consistent?
5. How is it tested (round-trip, integration, UI)?
