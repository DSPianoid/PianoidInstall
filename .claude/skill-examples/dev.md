# /dev — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/dev` skill
body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors; this
companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Verification routing (strict A1)
The Pianoid change-class → surface → mode → skill map (`PROJECT_CONFIG.md#verification-surfaces`):
- **Synthesis-output change** (volume, excitation, physical params, hammer shape, kernel coefficients) → invoke `/test-ui` (`audio_off`). Comparison via `note_playback` offline buffer. Most code changes route here.
- **Mic-engaging change** (calibration, `MicAnalyzer`, `measurement_engine`, mic capture path, `/calibrate_volume` family, `assert_synth_reaches_mic`) → invoke `/diagnose` with mic Phase 7 (`audio_on`). Comparison via mic-vs-synth Goertzel transferRatio. Requires `_MIC_LOOPBACK_CONFIGURED=True` in `tests/system/conftest.py`.

Binary contract: `docs/development/TESTING.md`. Code principles doc: `docs/development/CODE_QUALITY.md` (P1/P2, S1–S5, C4 file-size).

## Docs-first compile + run (concrete commands)
Authoritative procedure: [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run) · [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) · [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). The skip-this-and-burn-3h lesson: 2026-04-23, a stale `.pyd` masqueraded as a working rebuild.

- **Canonical rebuild:** `cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both`
- In agent context use the **detached `Start-Process`** form (absolute bat path, stop the `.pyd` holder first via launcher REST `POST /api/stop-backend`).
- NEVER `cmd //c … --heavy` (bricks the venv); NEVER `pip install --force-reinstall … pianoid_cuda/` (returns a stale `.pyd`).
- Full procedure: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).
- **Verify-landed:** `grep -a "<marker>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd` — if the marker is absent, the rebuild didn't land and any conclusion is void.
- On build/startup failure → invoke `/startup`.

## Step 0 — session log + WIP scaffold (concrete)
- Log location: `LOG_FILE="docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md"` (logs dir per [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)).
- **Session-init helper:** `python tools/dev-pipeline/dev_init.py "<task>" [--agent-id dev-xxxx] [--branch feature/x --repo PianoidCore] [--plan docs/proposals/x.md]` — generates the agent ID, writes the byte-faithful log header (`[STEP-0-COMPLETE]` as the first `## Actions` line), adds the WIP `## Active Dev Sessions` row, optionally creates the branch, prints agent ID + log path. Opus still decides branch-vs-dev + locks. See `tools/dev-pipeline/README.md`.

## Step 1 — doc-hierarchy drill (the 4-layer Pianoid stack)
1. `docs/index.md` — big picture, module map
2. `docs/architecture/SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `docs/architecture/DATA_FLOWS.md` — trace the relevant data flow
4. Module docs: `docs/modules/pianoid-cuda/*.md` (CUDA engine) · `docs/modules/pianoid-middleware/*.md` (middleware) · `docs/modules/pianoid-basic/OVERVIEW.md` (domain model) · `docs/modules/pianoid-tunner/OVERVIEW.md` (frontend)
5. The actual source files identified from the docs
6. `docs/development/WORK_IN_PROGRESS.md` — related ongoing work

## Step 1b — Environment Control (concrete)

### Kill stale processes — port-scoped kill loop (3000=frontend, 3001=launcher, 5000=backend, 5001=modal adapter)
**Canonical, structurally-safe form** (per [`PROJECT_CONFIG.md#process-sweep`](../../docs/PROJECT_CONFIG.md#process-sweep)):
```bash
python tools/dev-pipeline/env_sweep.py            # port-scoped kill (3000/3001/5000/5001) + verify free + per-repo git status
python tools/dev-pipeline/env_sweep.py --no-kill  # inspect only
```
`env_sweep.py` can ONLY kill PIDs discovered as listeners on those four ports (safety invariant encoded in code — no path to kill by name). Equivalent hand-pasted loop (emit `[STEP-1B-KILL] port=<N> pid=<N>` per kill):
```bash
# Kill ONLY processes on Pianoid ports — NEVER taskkill //F //IM python.exe / node.exe (kills MCP servers, Chrome DevTools, Claude Code itself)
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
sleep 2
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000|5001) " && echo "WARNING: ports still in use" || echo "Ports clear"
```
Distorted sound is the #1 symptom of skipping this. **Absence of `[STEP-1B-KILL]` markers around a `taskkill` is the controller's smoking gun for blanket-kill (Tier-3 halt).**

### Start servers with the correct venv
Before the first venv invocation emit `[STEP-1B-VENV-CHECK] interpreter=D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe`. venv runner: `PianoidCore/.venv/Scripts/python` (Win) · `PianoidCore/.venv/bin/python` (Linux) — [`PROJECT_CONFIG.md#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters).

LAST-RESORT `Bash run_in_background: true` form (CWD must be `pianoid_middleware` for relative preset paths):
```bash
# Backend server (port 5000)
cd PianoidCore/pianoid_middleware && ../.venv/Scripts/python -u backendserver.py > /tmp/backend.log 2>&1
```
Pass `run_in_background: true` to the Bash tool. Do NOT use shell `&` (Bash tool reports immediate exit). Then verify in a separate call:
```bash
sleep 2 && netstat -ano 2>/dev/null | grep ":5000 .*LISTENING" && curl -s http://127.0.0.1:5000/health | head -3
```
Diagnose on failure: `cat /tmp/backend.log`.

**Modal adapter server (port 5001)** — same pattern:
```bash
cd PianoidCore/pianoid_middleware && ../.venv/Scripts/python -u modal_adapter/modal_adapter_server.py > /tmp/modal_adapter.log 2>&1
```
After a successful start emit `[SERVER-START] role=<backend|frontend|adapter> port=<N> pid=<N>`; at shutdown emit `[SERVER-STOP] port=<N> pid=<N>`.

### Startup hierarchy (no-prompt methods)
1. **PREFERRED — launcher REST** (no harness gate, no Flask-reloader-orphan trap):
   ```bash
   curl -X POST http://127.0.0.1:3001/api/start-backend
   ```
   The launcher spawns the backend as ITS child (the pattern the React "APPLY" button uses). Emit `[PERM-RISK] method=launcher-rest` even here.
2. **FALLBACK — PowerShell `Start-Process -WindowStyle Hidden`** (detaches; can trip the long-running-process gate once per session):
   ```powershell
   Start-Process -WindowStyle Hidden -FilePath "D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe" -ArgumentList "-u","backendserver.py" -WorkingDirectory "D:/repos/PianoidInstall/PianoidCore/pianoid_middleware" -RedirectStandardOutput "D:/tmp/backend.log" -RedirectStandardError "D:/tmp/backend.err"
   ```
3. **LAST RESORT — Bash `run_in_background: true`** (above). Vulnerable to Flask-reloader child-takeover after ~2 min; if the backend dies mid-session use option 1.

**Known Pianoid failure modes:** Flask debug-reloader child-takeover (`backendServer.py` runs `socketio.run(debug=True)` → reloader spawns a child, parent exits, bash-tool reaps the orphan after ~2 min; port 5000 stops responding; proper fix is gating `debug=True` behind `PIANOID_FLASK_DEBUG=1`, tracked in `WORK_IN_PROGRESS.md`). Long-running-process harness gate trips even under bypassPermissions — don't retry, escalate via SendMessage.

### Clean up — full clearance sweep
```bash
# Graceful shutdown of servers started by this agent (or run env_sweep.py)
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Cleaning up: killing PID $pid on port $port"
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
```
All four Pianoid ports come down at handoff (unless the orchestrator flagged a concurrent agent). If chrome-devtools opened a browser, close the page before exiting.

## Step 2 — baseline perf test (concrete)
```bash
cd PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py -v -s 2>&1 | tee /tmp/baseline_perf.log
```
Metrics to record: GPU mean (ms), GPU p99 (ms), Total cycle mean (ms), Underrun count, Sound correlation. Marker: `[BASELINE-TEST] {ts} result=<pass|fail> perf_log=/tmp/baseline_perf.log gpu_mean_ms=<N> sound_corr=<N>`. Suite path: [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths).

## Step 3 — branch (concrete)
```bash
git -C "PianoidCore" checkout dev
git -C "PianoidCore" pull origin dev
git -C "PianoidCore" checkout -b feature/<short-description>
```
Small fixes work directly on `dev`. Repo integration branches: `PianoidCore`/`PianoidBasic`/`PianoidTunner` → `dev`; root `PianoidInstall` → `master` ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)).

## Step 4 — locks, edit, build

### Lock-row example
```markdown
| dev-a3f1 | `PianoidCore/pianoid_middleware/pianoid.py`, `PianoidCore/pianoid_middleware/backendServer.py` | 2026-04-10T14:30:22Z | Fix preset switch silence |
```

### Existing utilities to grep before writing
- `PianoidCore/pianoid_middleware/pianoid.py` — initialization, orchestration
- `PianoidCore/pianoid_middleware/chartFunctions.py` — analysis helpers
- `PianoidCore/tests/conftest.py` — test constants, helpers
- `PianoidCore/pianoid_cuda/Pianoid.cuh` — C++ API surface

### Pre-build holder check (MANDATORY)
```bash
locked_pids=$(tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python | awk '{print $2}')
if [ -n "$locked_pids" ]; then
  echo "WARNING: pianoidCuda.pyd is locked by PIDs: $locked_pids"
  for pid in $locked_pids; do
    wmic process where "ProcessId=$pid" get CommandLine 2>/dev/null | head -2
  done
fi
# Also check cudart DLL
tasklist //M cudart64_12.dll 2>/dev/null | grep python && echo "WARNING: cudart64_12.dll locked — kill holder first"
```
Stop the holder first: launcher REST `POST /api/stop-backend`, else a PID-targeted kill — never `//IM python.exe`. Holders + find-commands: [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders). Emit `[BUILD-PRECHECK] holders=<pids|none>`.

### Build decision table (Pianoid file types)
| Changed Files | Build Command |
|--------------|---------------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh`, `setup.py` | heavy (see below) |
| `pianoid_middleware/*.py` only | light (`--light --both`) |
| PianoidBasic `*.py` | `cd /d PianoidCore && .\build_pianoid_basic.bat` (detached `Start-Process` in agent ctx) |
| `tests/**` only | No rebuild |

Full matrix: [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix).

### CUDA build — agent context (DETACHED + `--both`; `cmd //c` gate-stalls DESTRUCTIVELY here)
Stop the `.pyd` holder first, then:
```powershell
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList `
  '/c','set "VIRTUAL_ENV=D:\repos\PianoidInstall\PianoidCore\.venv" && cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy --both > D:\tmp\build.log 2>&1' -PassThru
# --light --both for middleware-only. ABSOLUTE bat path after cd /d (a bare name fails "not recognized", L-2).
# Poll D:\tmp\build.log; done at "[SUCCESS] Build completed". Full procedure: BUILD_SYSTEM.md → Canonical Install / Rebuild.
```
Clear `VIRTUAL_ENV` first so the script installs into `PianoidCore/.venv` not the wrong venv (the script uses `%REPO_ROOT%.venv`).

**Build helper (the whole procedure in one call):** `python tools/dev-pipeline/build_pianoid.py --heavy --both [--marker "<string from your edit>"]` — precheck `.pyd` holders → stop holder FIRST (launcher REST, else PID-targeted, never `//IM`) → detached build (absolute bat path) → poll log for `[SUCCESS]` → grep-verify the `.pyd` for your marker → emit `[BUILD STARTED]`/`[BUILD OK]`/`[BUILD FAIL]`. NEVER pip-installs; ABORTS rather than build against a held `.pyd`. Build-failure diagnosis stays Opus. See `tools/dev-pipeline/README.md`.

### 0xC0000142 recovery
If the build fails with exit code `3221225794` (0xC0000142 STATUS_DLL_INIT_FAILED): do NOT fall back to `pip install --force-reinstall ... pianoid_cuda/` (returns a stale cached `.pyd`). Follow [`BUILD_SYSTEM.md` — 0xC0000142 Recovery](../../docs/architecture/BUILD_SYSTEM.md#0xc0000142-recovery-status_dll_init_failed): delete `%TEMP%\pip-build-env-*`, `pip cache purge`, then re-run `build_pianoid_cuda.bat`.

### Post-build verification (import-verify)
```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```
Verify the path is inside `PianoidCore/.venv/` (not root `.venv/`), then the verify-landed grep above. Markers: `[BUILD STARTED]` / `[BUILD OK] … verified=yes` / `[BUILD FAILED] code=<exit-code>`.

## Step 4b — DeepSeek codegen delegation (the concrete backend)
The configured codegen backend is the `deepseek-codegen` MCP server + its batch pipeline (Claude still owns the test, review, build, run, debug loop, and commit).

- **Batch pipeline (uniform — even for ONE function):** `PianoidCore/.venv/Scripts/python tools/deepseek-codegen-mcp/batch_pipeline.py --manifest <dir> --out <outdir> --review-ds on --expose bodies --concurrency 4` → shipped bodies land in `<outdir>/impl_<name>.py` (or `<name>.escalated` on a gate failure). Full reference: `tools/deepseek-codegen-mcp/README.md` → "Batch pipeline".
- **Manifest layout** — one directory, per function `<name>`: `<name>.spec.md` (signature + behaviour) · `<name>.test.py` (the gate — imports the candidate as `import impl_<name>`) · `<name>.meta.json` (`{target_module, language, xp_agnostic, deps:[<sibling helpers>]}`) · shared `conftest.py`/`pytest.ini` if needed.
- **Language matrix:** Python (`.py`, pytest) OR JS/TS/React (`.js/.jsx/.ts/.tsx`, Jest — PianoidTunner included) → pass the matching `language`. **HARD-EXCLUDED: `.cu/.cpp/.cuh/.h/setup.py`** (CUDA/C++ — need the heavy build) and any cross-cutting / multi-file refactor → stays on Claude /dev.
- **Single-unit `/fn` Step-2a MCP call** (judgment-heavy or debug path): `mcp__deepseek-codegen__delegate_codegen(function_spec=…, test_or_signature=…, constraints=…, context_snippets=…)`; marker `[MCP-CALL] {ts} server=deepseek-codegen tool=delegate_codegen args_summary=<fn>`.
- Validated by the 2026-06-06/06-07 A/B runs (the `signal + numpy_noise` numpy-only blind spot the dual-backend gate caught; `compute_mac` re-implemented in two functions when `deps` weren't declared).

## Step 4b — Context hygiene cost model
Cost model + measurements (the ~65% context-re-read figure, the 4×-incremental-pytest waste, the ~$0.15 Opus spawn tax, +38%@N=3 / +60%@N=10 fan-out loss): `docs/proposals/minimize-opus-calls-dev-pipeline-2026-06-06.md`.

## Step 4b — test tiers (Pianoid)
| Test type | Location | When |
|-----------|----------|------|
| Pure logic, no GPU | `PianoidCore/tests/unit/` | utility fns, data transforms, formatters |
| GPU required, no audio | `PianoidCore/tests/integration/` | buffer ops, CUDA kernel wrappers |
| Full stack (GPU + audio) | `PianoidCore/tests/system/` | audio pipeline, preset loading, API endpoints |

Follow `test_performance_audio_off.py` patterns (`conftest.py` fixtures, markers, assertions).

## Step 4b — Example: dev agent prepares test, then spawns /fn sub-agent
Task: "Add velocity clamping to the MIDI input handler"

**Dev agent writes the test first:**
```python
# PianoidCore/tests/unit/test_velocity_clamp.py
import pytest
from pianoid_middleware.midi_utils import clamp_velocity

class TestClampVelocity:
    def test_within_range(self):
        assert clamp_velocity(64, 1, 127) == 64
    def test_below_min(self):
        assert clamp_velocity(0, 1, 127) == 1
    def test_above_max(self):
        assert clamp_velocity(200, 1, 127) == 127
    def test_at_boundaries(self):
        assert clamp_velocity(1, 1, 127) == 1
        assert clamp_velocity(127, 1, 127) == 127
```

**Dev agent spawns the sub-agent (judgment/debug path only):**
```
Agent({
  description: "Implement clamp_velocity",
  prompt: "Execute the /fn skill:\n\
    - target_file: D:/.../pianoid_middleware/midi_utils.py\n\
    - function_spec: clamp_velocity(v: int, min_v: int, max_v: int) -> int\n\
    - requirements: Clamp v to [min_v, max_v]. Return min_v if v < min_v, max_v if v > max_v, v otherwise.\n\
    - test_command: .venv/Scripts/python -m pytest tests/unit/test_velocity_clamp.py -v\n\
    - context_files: docs/modules/pianoid-middleware/OVERVIEW.md\n\
    - parent_agent: dev-a3f1\n\
    - held_locks: midi_utils.py"
})
```
Collect: `ls docs/development/logs/fn-*.md`; archive: `mv docs/development/logs/fn-*.md docs/development/logs/archive/`.

## Step 5 — post-change perf test (concrete)
```bash
cd PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py -v -s 2>&1 | tee /tmp/postchange_perf.log
```
Metrics + thresholds: GPU mean increase > 10% (hard fail), Sound correlation < 0.95 (hard fail), any new test failure (hard fail); GPU p99 > 20% / underrun +50% (warn). Marker: `[REGRESSION-CHECK] {ts} gpu_mean_delta_pct=<N> sound_corr=<N> verdict=<pass|warn|fail>`.

**Perf helper:** `python tools/dev-pipeline/run_perf.py --baseline [--out baseline.json]` at Step 3, then `--compare baseline.json` here (prints Baseline/After/Delta + emits `[REGRESSION-CHECK]`/`[REGRESSION-DETECTED]` with a `verdict_hint`; `--audio-on` for the mic variant). Verdict stays Opus. See `tools/dev-pipeline/README.md`.

## Step 6 — debug (concrete)
Build failures → `docs/architecture/BUILD_SYSTEM.md` Troubleshooting (SDL3.lib not found, import failures, `--heavy` vs `--light`). Re-run failing test only:
```bash
.venv/Scripts/python -m pytest tests/system/test_performance_audio_off.py::<TestClass>::<test_name> -v -s
```

## Step 7 — verification skill (concrete)
Audio-affecting change:
```
/test-ui <description of what to verify>
```
Launches the full stack, applies the change via UI, measures sound via `note_playback` chart (deterministic offline render), reports pass/fail with amplitude numbers. Changes requiring `/test-ui`: volume formula/sensitivity, excitation params (sliders, curves), physical string params (tension, damping), hammer shape, any new UI control feeding the synthesis engine. Mic-engaging → `/diagnose` (Phase 7, `audio_on`). Marker: `[VERIFY-INVOKE] skill=<test-ui|diagnose> mode=<audio_off|audio_on>`.

## Step 8 — doc-update map (Pianoid source → doc)
| Changed source | Doc to update |
|---------------|---------------|
| `pianoid_cuda/*.cu/cpp/h` | `docs/modules/pianoid-cuda/*.md` |
| `pianoid_middleware/*.py` | `docs/modules/pianoid-middleware/*.md` |
| `tests/**` | `docs/development/TESTING.md` |
| Architecture/flow changes | `docs/architecture/DATA_FLOWS.md` |
| New WIP items | `docs/development/WORK_IN_PROGRESS.md` |

Principles + God-objects list: `docs/development/CODE_QUALITY.md` (P1/P2, A1–A5, C1–C6, S1–S5; C4 = 500/1000 LOC thresholds). Infographics: `docs/images/` (SVGs) / inline Mermaid.

## Step 9 — merge feature branch → dev (concrete)
```bash
# PianoidCore
cd PianoidCore
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev
# PianoidBasic (if changed) — same pattern
```
Cleanup: `git branch -d feature/<name>` + `git push origin --delete feature/<name>`.

## Step 10a — Phase-1 process hygiene + Phase-2 helpers (concrete)
Phase-1 pre-handoff sweep:
```bash
for port in 5000 5001 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
sleep 2
netstat -ano 2>/dev/null | grep -E ":(3000|3001|5000|5001) " && echo "WARN: ports still in use" || echo "All Pianoid ports clear"
```
Kill-but-don't-restart is the default (2026-05-07 incident: dev-bandui restarts caused browser-tab/bundle ambiguity, repeated "Same" reports). Restart on explicit user request only — via `Start-Process -WindowStyle Hidden` (run `start-pianoid.bat` / `npm run dev`).

- **Commit helper:** `python tools/dev-pipeline/dev_commit.py <agent-id> <type> "<subject>" <files...> [--repo PianoidCore] [--body "..."]` — `git add -- <exactly those files>` (never `-A`) + `git commit -m "[<agent-id>] <type>: <subject>"`; refuses bad agent-id / empty message / no files. You write the wording. See `tools/dev-pipeline/README.md`.
- **Phase-2 wrap helper:** `python tools/dev-pipeline/dev_wrap_phase2.py <agent-id> [--proposal docs/proposals/<name>.md --status "IMPLEMENTED <evidence>"]` — `git mv` log → `logs/archive/`, remove WIP row, (when a proposal is named) `git mv` it → `docs/proposals/archive/` + prepend `**Status:**`. WIP-debt note: the 2026-06-10 sweep cleared 6 rows whose Phase-2 commits said "mark MERGED" instead of deleting the row. The ~17 stale "draft/awaiting" proposals before the 2026-06-06 triage are why a shipped proposal must be archived in the wrap.

## Repo paths
| OS | Repo root |
|----|-----------|
| Windows | `D:\repos\PianoidInstall` |
| Linux | `/media/leonid-astrin/New Volume/repos/PianoidInstall` |

Use repo-relative paths; apply the OS prefix only when an absolute path is unavoidable ([`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)).

## Example usage
```
/dev Fix buffer underrun race condition in CircularBuffer.cu produce()
/dev Add FIR filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
