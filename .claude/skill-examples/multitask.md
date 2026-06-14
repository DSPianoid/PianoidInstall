# /multitask — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/multitask`
skill body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors;
this companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

The orchestrator runs `/multitask` across PianoidCore, PianoidBasic, and PianoidTunner.

## Docs-first rebuild in every wave (body §"Docs-first (MANDATORY) for every rebuild")
Authoritative procedure: [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) · [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). The concrete Pianoid command each rebuilding sub-agent uses:

```
cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both
```
- In agent context use the **detached `Start-Process`** form (absolute bat path, **stop the `.pyd` holder first** via launcher REST `POST /api/stop-backend`).
- **Reject** any sub-agent that uses `cmd //c … --heavy` in agent context (removes the `.pyd` before reinstall → **bricks the venv**) or `pip install --force-reinstall … pianoid_cuda/` (reinstalls a **stale `.pyd`**). Full procedure: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).
- **Verify each rebuild landed** before that wave's tests: `grep -a "<marker>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`. If missing, mark the wave's tests INVALID and re-run.
- On unexpected build/startup failure in a wave → halt the wave, spawn a `/startup` sub-agent, resume after green.
- Cost note: 2026-04-23 lost ~3h to a single stale `.pyd` contaminating a post-wave suite.

## Phase 1.1 — Pianoid layer → repo → indicator map (the 4-layer stack)
| Layer | Repo | Indicators |
|-------|------|-----------|
| `CUDA` | PianoidCore | `.cu`, `.cpp`, `.cuh`, `.h` files, GPU kernels, pybind11 bindings |
| `MIDDLEWARE` | PianoidCore | `pianoid_middleware/*.py`, Flask routes, parameter routing |
| `DOMAIN` | PianoidBasic | `Pianoid/*.py`, preset model, pitch/string/mode classes |
| `FRONTEND` | PianoidTunner | `*.tsx`, `*.ts`, React components, npm |
| `BUILD` | PianoidCore | `setup.py`, `detect_paths.py`, `build_config.json`, `*.bat` |
| `DOCS` | PianoidInstall | `docs/**/*.md`, `mkdocs.yml` |
| `TESTS` | PianoidCore | `tests/**/*.py`, `conftest.py` |

Classification-table example rows:

| # | Task | Layers | Repos | Estimated Files | Build Required |
|---|------|--------|-------|-----------------|----------------|
| 1 | ... | CUDA, MIDDLEWARE | PianoidCore | `CircularBuffer.cu`, `pianoid.py` | `--heavy` |
| 2 | ... | MIDDLEWARE | PianoidCore | `chartFunctions.py` | `--light` |
| 3 | ... | FRONTEND | PianoidTunner | `ExcitationPanel.tsx` | `npm run build` |
| 4 | ... | DOCS | PianoidInstall | `docs/modules/...` | none |

## Phase 1.1 doc-read order (Pianoid)
`docs/index.md` → `docs/architecture/SYSTEM_OVERVIEW.md` → relevant module docs.

## Phase 2.3 — wave-plan conflict rationale (Pianoid)
- #1 and #2: both touch PianoidCore CUDA build → wave 1 then wave 2
- #3 and #4: no conflicts → parallel within their waves

## Phase 3.1 — Pre-execution baseline (Pianoid command)
```bash
cd PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/multitask_baseline.log
```
(venv interpreter per [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters); performance-test path per [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) = `PianoidCore/tests/system/test_performance_audio_off.py`.)

## Phase 3.3a — Pianoid parallel-execution safety constraints
- Only ONE task may run `build_pianoid_cuda.bat` at a time — if violated (shouldn't happen per conflict rules), serialize their build steps.
- Only ONE Pianoid instance may be active for testing (GPU memory exclusive).
- Frontend (`npm`) builds are independent and can overlap with backend builds.

## Phase 3.4 — Post-wave testing (Pianoid commands)
| Wave Content | Test Suite | Command |
|-------------|-----------|---------|
| Any CUDA changes | Integration tests | `.venv/Scripts/python -m pytest tests/integration/ -v` |
| Any Python changes | Unit tests | `.venv/Scripts/python -m pytest tests/unit/ -v` |
| Frontend changes | npm test | `cd PianoidTunner && npm test` |
| Mixed backend | Integration + unit | Both commands above |

## Phase 3.5 — Post-wave merge (Pianoid repo paths)
**Worktree tasks:**
```bash
cd <repo-path>   # e.g. PianoidCore / PianoidBasic / PianoidTunner
git merge feature/mt-<wave>-<task#>-<name> --no-ff -m "Merge multitask #<N>: <short description>"
```
**Direct-branch tasks:**
```bash
cd <repo-path>
git merge feature/mt-<task#>-<name> --no-ff -m "Merge multitask #<N>: <short description>"
```

## Phase 4.1 — Full test suite (Pianoid commands)
```bash
cd PianoidCore

# Unit tests
.venv/Scripts/python -m pytest tests/unit/ -v

# Integration tests (GPU, no audio)
.venv/Scripts/python -m pytest tests/integration/ -v

# System tests (GPU + audio — exclusive access)
.venv/Scripts/python -m pytest tests/system/ -v -s 2>&1 | tee /tmp/multitask_final.log
```

## Phase 4.2 — Performance metrics + regression criteria (Pianoid)
| Metric | Baseline | Final | Delta | Status |
|--------|----------|-------|-------|--------|
| GPU mean (ms) | — | — | — | OK/WARN/FAIL |
| GPU p99 (ms) | — | — | — | OK/WARN/FAIL |
| Total cycle mean (ms) | — | — | — | OK/WARN/FAIL |
| Underrun count | — | — | — | OK/WARN/FAIL |
| Sound correlation | — | — | — | OK/WARN/FAIL |

Regression criteria (same as `/dev` Step 5):
- **Hard fail:** GPU mean increase > 10%, sound correlation < 0.95, any new test failure
- **Warning:** GPU p99 increase > 20%, underrun count increase > 50%

## Phase 5 — Final report example rows (Pianoid)
| # | Task | Wave | Status | Branch | Build | Tests | Time |
|---|------|------|--------|--------|-------|-------|------|
| 1 | Fix buffer underrun | 1 | PASSED | merged | --heavy | 12/12 | 8m |
| 2 | Add FIR bypass mode | 2 | PASSED | merged | --light | 12/12 | 3m |
| 3 | Update tooltip | 1 | PASSED | merged | npm | 5/5 | 2m |
| 4 | Update CUDA docs | 1 | PASSED | direct | none | n/a | 1m |

## Phase 5.1 — Cleanup (Pianoid)
Port-scoped env sweep before declaring the env clean (per [`PROJECT_CONFIG.md#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep) — kills ONLY listeners on ports 3000/3001/5000/5001, never by image name):
```bash
python tools/dev-pipeline/env_sweep.py            # port-scoped kill + verify free + per-repo git status
python tools/dev-pipeline/env_sweep.py --no-kill  # inspect only
```

Delete merged branches + per-repo push (the four Pianoid repos):
```bash
git -C <repo> branch -d feature/mt-<N>-<name>

git -C "PianoidCore" push origin <branch>
git -C "PianoidBasic" push origin <branch>
git -C "PianoidTunner" push origin <branch>
git -C "." push origin <branch>
```
(Repo-relative paths + integration branches per [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos): PianoidInstall `.`→`master`; PianoidCore/PianoidBasic/PianoidTunner→`dev`.)

## Pianoid example invocation
```
/multitask Fix buffer underrun in CircularBuffer.cu | Add FIR bypass mode for debugging | Update excitation chart tooltip in React
```
