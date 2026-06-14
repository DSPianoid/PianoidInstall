# /fn — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/fn` skill
body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors; this
companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Audio/Verification mode contract
The caller's `--test <command>` determines whether `audio_on` / `audio_off` markers + fixtures apply (strict-A1 binary contract). Routing + contract: `docs/development/TESTING.md` ([`PROJECT_CONFIG.md#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces)). When spawned by `/test-ui` → `audio_off`; by `/diagnose` → `audio_on`.

## Docs-first compile + run (concrete commands)
Authoritative procedure: [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) · [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) · [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). The skip-this-and-burn-3h lesson: 2026-04-23, a stale `.pyd` masqueraded as a working rebuild.

- **Canonical rebuild:** `cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both`
- In agent context use the **detached `Start-Process`** form (absolute bat path, stop the `.pyd` holder first via launcher REST `POST /api/stop-backend`).
- NEVER `cmd //c … --heavy` (bricks the venv); NEVER `pip install --force-reinstall … pianoid_cuda/` (returns a stale `.pyd`).
- Full procedure: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).
- **Verify-landed:** `grep -a "<marker>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd` — if the marker is absent, the rebuild didn't land and any conclusion is void.
- On build/startup failure → invoke `/startup`.

## Input Contract — concrete field examples
| Field | Example |
|-------|---------|
| **target_file** | `D:/repos/PianoidInstall/PianoidCore/pianoid_middleware/pianoid.py` |
| **function_spec** | "Add `clamp_velocity(v, min, max)` that returns clamped int" |
| **requirements** | "Returns min when v < min, max when v > max, v otherwise" |
| **test_command** | `.venv/Scripts/python -m pytest tests/unit/test_clamp.py -v` |
| **context_files** | `pianoid.py`, `DATA_FLOWS.md` |
| **parent_agent** | `dev-a3f1` |
| **held_locks** | `pianoid.py, backendServer.py` |

## Step 0 — session log location
`LOG_FILE="docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"` (logs dir per [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)).

## Context Hygiene — cost model reference
Cost model + measurements (the ~65% context-re-read figure, the 4×-incremental-pytest waste pattern): `docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md`.

## Step 2a — DeepSeek codegen delegation (the concrete backend)
The configured codegen backend is the `deepseek-codegen` MCP server (Claude still owns the test, review, build, run, debug loop, and commit).

- **MCP call:** `mcp__deepseek-codegen__delegate_codegen(function_spec=<sig+behaviour>, test_or_signature=<the test source>, constraints=<requirements>, context_snippets=<adjacent patterns from Step 1>)`
- **Marker:** `[MCP-CALL] {ts} server=deepseek-codegen tool=delegate_codegen args_summary=<fn name>`
- **Language matrix:** Python (`.py`, pytest) OR JS/TS/React (`.js/.jsx/.ts/.tsx`, Jest) → pass the matching `language`. **HARD-EXCLUDED (HC-1): `.cu/.cpp/.cuh/.h/setup.py`** (CUDA/C++ — need the heavy build).
- **HC-2:** never delegate without the test already existing.
- **Batch pipeline (several interdependent fns at once):** `tools/deepseek-codegen-mcp/batch_pipeline.py` — declares dependencies, builds leaf helpers first, exposes them automatically (a lone Step-2a delegation has no sibling context → it WILL re-implement an undeclared helper).
- Validated by the 2026-06-06/06-07 A/B runs (the `signal + numpy_noise` numpy-only blind spot the dual-backend gate caught).

## Step 3 — Build decision table (Pianoid file types)
| File type | Build action |
|-----------|-------------|
| `*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py` | Heavy CUDA build (`--both`) |
| `pianoid_middleware/*.py` | Light build or no build |
| `tests/**` | No build |
| `PianoidBasic/*.py` | PianoidBasic build (`build_pianoid_basic.bat`) |

Full matrix: [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix).

### Pre-build holder check (MANDATORY)
```bash
locked_pids=$(tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python | awk '{print $2}')
if [ -n "$locked_pids" ]; then
  echo "WARNING: pianoidCuda.pyd locked by PIDs: $locked_pids"
fi
```
Stop the holder first: launcher REST `POST /api/stop-backend`, else a PID-targeted kill — never `//IM python.exe`. Holders + find-commands: [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders) · [`#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep).

### Build commands (agent context — DETACHED)
```powershell
# Heavy (C++/CUDA) — default --both (release + debug; --release alone leaves the debug .pyd stale)
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList `
  '/c','set "VIRTUAL_ENV=D:\repos\PianoidInstall\PianoidCore\.venv" && cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy --both > D:\tmp\build.log 2>&1' -PassThru

# Light (Python middleware) — swap --heavy for --light
# PianoidBasic — swap build_pianoid_cuda.bat --heavy --both  for  build_pianoid_basic.bat
# Poll D:\tmp\build.log; done at "[SUCCESS] Build completed."  (Or use tools/dev-pipeline/build_pianoid.py.)
```

### Post-build verification (import-verify)
```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```
Then the verify-landed grep from the docs-first section above.

## Step 4 — Test (concrete form)
```bash
cd PianoidCore
<test_command> 2>&1 | tee /tmp/${AGENT_ID}_test.log
```
venv runner: `PianoidCore/.venv/Scripts/python` (Win) · `PianoidCore/.venv/bin/python` (Linux) — [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters).

## Step 5 — module-locks file
Standalone-lock release target: `docs/development/MODULE_LOCKS.md` ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)).

## Example Usage

### Standalone (user invokes directly)
```
/fn PianoidCore/pianoid_middleware/pianoid.py clamp_velocity --test ".venv/Scripts/python -m pytest tests/unit/test_utils.py::test_clamp -v"
```

### Spawned by /dev agent (via Agent tool)
```
Agent({
  description: "Implement clamp_velocity",
  prompt: "Execute the /fn skill with these parameters:\n- target_file: D:/repos/.../pianoid.py\n- function_spec: Add clamp_velocity(v, min_v, max_v) -> int ...\n- requirements: Returns clamped value...\n- test_command: .venv/Scripts/python -m pytest tests/unit/test_utils.py::test_clamp -v\n- context_files: docs/modules/pianoid-middleware/OVERVIEW.md, pianoid.py\n- parent_agent: dev-a3f1\n- held_locks: pianoid.py"
})
```
