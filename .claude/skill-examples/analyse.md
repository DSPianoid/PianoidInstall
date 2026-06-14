# /analyse — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/analyse`
skill body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors;
this companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Canonical rebuild (when an analysis must reproduce/verify by rebuilding)
Authoritative procedure: [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) · [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) · [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). The concrete Pianoid command:

```
cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both
```
- In agent context use the **detached `Start-Process`** form with the **absolute** bat path, and **stop the `.pyd` holder first** (launcher REST `POST /api/stop-backend`).
- NEVER `cmd //c … --heavy` (gate-stalls destructively → bricks the venv); NEVER `pip install --force-reinstall … pianoid_cuda/` (returns a stale `.pyd`).
- **Verify-landed:** `grep -a "<marker>" …\pianoidCuda.cp312-win_amd64.pyd` — if the marker is absent, the rebuild didn't land and any conclusion drawn from it is void.
- On build/server failure → invoke `/startup`.

## Phase-1 module-doc drill (the 4-layer Pianoid stack)
1. `docs/index.md` — locate the system in the module map
2. `docs/architecture/SYSTEM_OVERVIEW.md` — the 4-layer stack (CUDA engine → middleware → domain model → frontend)
3. `docs/architecture/DATA_FLOWS.md` — data-flow traces
4. Module docs: `pianoid-cuda/*.md` (engine) · `pianoid-middleware/*.md` (server) · `pianoid-basic/OVERVIEW.md` (domain model) · `pianoid-tunner/OVERVIEW.md` (frontend)
5. `docs/development/TESTING.md` — test coverage
6. `docs/development/WORK_IN_PROGRESS.md` — active investigations

## Example subsystem arguments (Pianoid's actual systems)
`excitation system` (Gaussian excitation: Python model → GPU kernel) · `playback engine` (online/offline playback, event dispatch, audio out) · `parameter routing` (REST → Python → CUDA) · `deck coupling` (feedin/feedback matrices, string-mode coupling) · `mode simulation` (harmonic oscillator modes) · `string simulation` (FDTD wave solver) · `midi system` · `chart system` · `preset system` · `memory management` (GPU alloc, double-buffer swap) · `audio drivers` (ASIO/SDL3).

## Restart the docs server (MkDocs) after doc updates
```bash
# Kill existing mkdocs process
tasklist | grep -i mkdocs | awk '{print $2}' | xargs -r kill 2>/dev/null
# Start fresh (background)
cd . && mkdocs serve -a 0.0.0.0:8001
```
Updated-section links: `http://localhost:8001/...` (docs-server address per [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)).

## Test tiers (Pianoid convention)
- `tests/unit/` — pure Python, no GPU
- `tests/integration/` — GPU, no audio driver
- `tests/system/` — full stack including audio

## Performance-criteria framing (real-time audio pipeline)
Derive criteria from the system's role in the real-time audio pipeline: must complete within one synthesis cycle, must not block the audio thread, must fit within the GPU memory budget.
