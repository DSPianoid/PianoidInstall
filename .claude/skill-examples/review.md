# /review — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/review`
skill body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors;
this companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Step 2.1 — Layer audit: the 4-layer Pianoid stack
The change belongs to exactly one of the four layers; flag any leak across them:

**CUDA engine → domain model → middleware → frontend**

(`PianoidCore/pianoid_cuda/` engine → `PianoidBasic/Pianoid/` domain model → `PianoidCore/pianoid_middleware/` server → `PianoidTunner/src/` frontend.) Resolve the authoritative layer model from `docs/architecture/SYSTEM_OVERVIEW.md` ([`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). Example leaks: frontend business logic, backend UI concerns, a domain-model module making HTTP calls.

## Step 2.2 — Server audit: the two Pianoid backend servers
For middleware changes, verify the change lands on the correct server and respects the cross-server import isolation ([`PROJECT_CONFIG.md#ports`](../../docs/PROJECT_CONFIG.md#ports)):

| Port | Server | Import rule |
|------|--------|-------------|
| **5000** | Flask main backend (`pianoid_middleware` + CUDA engine) | must **not** `import modal_adapter_server` |
| **5001** | Modal adapter backend (`modal_adapter/modal_adapter_server.py`) | routes on 5001 must **not** `import backendServer` |

Each server keeps its own import surface; a cross-server import is a **Critical** P1 authority leak.

## Level 1 — 4.1-4.2 Naming: Pianoid domain terms
Domain terms must match the canonical terminology table (`docs/development/CODE_QUALITY.md`). Pianoid examples: `frequency`, `damping_ratio`, `decrement` — and watch the "same name, different thing" pairs from [`PROJECT_CONFIG.md#data-model-facts`](../../docs/PROJECT_CONFIG.md#data-model-facts) (`deck`, `sound_channel`/`string_sound_channel`, `feedin`/`feedback`). No new synonyms for an existing term.

## Level 1 — 1.2-1.3 Layer Boundaries: which server owns it
The correct server owns the new functionality — **port 5000 (Flask main)** vs **port 5001 (modal adapter)** ([`PROJECT_CONFIG.md#ports`](../../docs/PROJECT_CONFIG.md#ports)).

## Level 1 — 5.1-5.2 Real-Time
For Pianoid the latency-critical thread is the **audio callback thread**; the compute budget is the **GPU budget** (must fit one synthesis cycle). No blocking calls on the audio thread.

## Level 2 — Module identification: Pianoid module→path map
The module + the files that import from / interface with it:

| Module argument | Module path(s) | Consumers / interface |
|-----------------|----------------|-----------------------|
| `modal_adapter` | `PianoidCore/pianoid_middleware/modal_adapter/` | frontend `useModalAdapter.js` + `ModalAdapter.jsx` |
| `parameter_manager` | `PianoidCore/pianoid_middleware/parameter_manager.py` | its callers (grep the codebase) |
| `pianoid_cuda` | `PianoidCore/pianoid_cuda/` | pybind11 bindings + middleware callers |
| `domain_model` | `PianoidBasic/Pianoid/` | middleware consumers |
| `frontend` | `PianoidTunner/src/` | all hooks, components, modules |
| any other name | search for it in the codebase | — |

## Level 2 — Phase 3 Recent Changes Impact: Pianoid integration branch
The non-default integration branch for the compiled repos is `dev` ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):

```bash
git log --oneline -20 -- <module_path>
git diff dev..HEAD -- <module_path>
```

Example output File:Line citation: `modal_adapter.py:245`.

## Level 3 — Phase 2 State Management Audit: Pianoid server module dir
Inventory persistent state written by each backend server (`<server-module-dir>` = `PianoidCore/pianoid_middleware/`):

```bash
grep -rn "open(" --include="*.py" PianoidCore/pianoid_middleware/ | grep "'w'"
grep -rn "json.dump\|np.save\|pickle" --include="*.py" PianoidCore/pianoid_middleware/
```

State-management output table rows for Pianoid's two servers:

| Server | Persistent Items | Load Paths | Gaps |
|--------|-----------------|------------|------|
| Main (5000) | N | N | ... |
| Modal (5001) | N | N | ... |

## Level 3 — Phase 3 Naming Audit: Pianoid synonym pairs
Concrete known-synonym grep for the terminology violation pass:

```bash
grep -rn "dump_ratio\|damp_ratio" --include="*.py" --include="*.js" --include="*.jsx"
```

(`dump_ratio` / `damp_ratio` are wrong spellings of the canonical `damping_ratio`.)

## Level 3 — Phase 4 Thread/Process Safety: Pianoid specifics
- The engine/compute lock is `cuda_lock` — every pybind11 call must be inside it.
- No shared mutable state between the two backend servers (5000 / 5001).
- The audio callback thread path must be lock-free.

## Level 3 — Phase 5 Dead Code: Pianoid endpoint + frontend dirs
Find dead endpoints (`<server-module-dir>` = `PianoidCore/pianoid_middleware/`; route decorators include the modal blueprint `@modal_bp`) and cross-reference frontend callers (`<frontend-source-dir>` = `PianoidTunner/src/`):

```bash
grep -rn "@.*route\|@modal_bp" --include="*.py" PianoidCore/pianoid_middleware/
grep -rn "axios\.\|fetch(" --include="*.js" --include="*.jsx" PianoidTunner/src/
```

## Level 3 — Phase 6 Documentation Accuracy: Pianoid doc paths
The system-overview doc is `docs/architecture/SYSTEM_OVERVIEW.md` ([`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)).

## Example usage
```
/review local mode_tracking.py
/review module modal_adapter
/review system
```
