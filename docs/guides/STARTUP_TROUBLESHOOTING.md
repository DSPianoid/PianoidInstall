# Startup & Installation Troubleshooting

This guide covers common failures during installation, building, and startup of the Pianoid system.

For **live UI tests** (agents launching the stack to verify features), use the canonical procedure in [UI Testing](UI_TESTING.md). The sections below cover general startup, build, and port issues.

---

## Three-Process Architecture

The live stack uses **three cooperating processes**. Starting or killing the wrong one produces confusing symptoms (backend resurrection, zombie sockets, preset apply silently killing the backend).

| Process | Port | Role | Parent |
|---|---|---|---|
| Node.js launcher | 3001 | Spawns/kills backend (5000) and modal adapter (5001); WebSocket console | `npm run dev` (concurrently) |
| React dev server | 3000 | Frontend UI | `npm run dev` (concurrently) |
| Flask backend | 5000 | REST API, CUDA engine, audio playback | Launcher (on APPLY) or manual |
| Modal adapter | 5001 | Offline modal analysis pipeline | Launcher (on demand) or manual |

**Key coupling**: the frontend's `ensureBackendAndLoadPreset` (PianoidTuner.js:297) runs this guard on every APPLY:

1. Probe `GET http://127.0.0.1:5000/health`.
2. If the backend responds **but the launcher does not own it** (the frontend's WebSocket to :3001 reports `processRunning=false`) → the frontend calls `/api/kill-stale` on the launcher, which kills the backend by PID on port 5000.
3. Only then does the frontend call `/api/start-backend` to spawn a fresh backend under launcher supervision.

**Consequence**: if the launcher (port 3001) is down, every APPLY click first kills the backend and then fails because the launcher can't restart it. A backend started manually outside the launcher will be killed on the next APPLY click.

**Rule**: for UI testing, always start the full `npm run dev` (launcher + frontend together) and let the launcher own the backend. Do not start the backend directly via `python backendserver.py` unless you are also willing to bypass the UI (curl-only interaction).

---

## Port Conflicts

### Symptom: "Address already in use" or backend won't start

Another process is occupying port 5000 (backend), 3000 (frontend), 3001 (launcher), or 5001 (modal adapter).

**Diagnosis:**

```bash
netstat -ano | grep ":5000 "
netstat -ano | grep ":3000 "
netstat -ano | grep ":3001 "
netstat -ano | grep ":5001 "
```

**Fix — kill by PID (safe):**

```bash
# Find the PID from netstat output, then:
taskkill //F //PID <PID>
```

**Fix — use the launcher's kill-stale endpoint (backend + modal only):**

```bash
curl -X POST http://localhost:3001/api/kill-stale
```

Note: `/api/kill-stale` walks both `netstat -ano` (any TCP state) and `wmic process where CommandLine like '%backendserver.py%'` to also catch orphaned Python processes not yet bound to the port.

!!! warning "Never blanket-kill processes"
    Do **not** use `taskkill //F //IM python.exe` or `taskkill //F //IM node.exe` — this kills MCP servers, Claude Code, and other unrelated processes. Always kill by specific PID on a specific port.

### Zombie socket diagnosis

This is almost never a kernel-level TCP leak. The usual root cause:

- The port is held by a **launcher child process** that you didn't kill. Killing only the Flask PID leaves the Node launcher parent alive; the launcher immediately respawns the backend (on `/api/start-backend` or on the next APPLY click). Your `taskkill` succeeded but the launcher created a new backend bound to the same port microseconds later.
- Or the orphan is an un-reaped Python process whose parent Node.js died mid-spawn.

**Diagnosis — find the actual holder:**

```bash
# Get the PID on the port
netstat -ano | grep ":5000 "
# Look up its command line and parent PID
wmic process where "ProcessId=<PID>" get CommandLine,ParentProcessId /format:list
# Is the parent the launcher?
wmic process where "ProcessId=<PARENT>" get CommandLine,Name /format:list
```

If `ParentProcessId` resolves to a `node.exe` running `server/launcher.js`, that is the launcher — you must kill the launcher (port 3001) before or alongside the backend, otherwise it will keep respawning.

**Fix — kill launcher and backend together (reverse dependency order):**

```bash
# Order: frontend (3000) → launcher (3001) → modal (5001) → backend (5000)
for port in 3000 3001 5001 5000; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    echo "Killing PID $pid on port $port"
    taskkill //F //PID "$pid"
  fi
done
sleep 2
netstat -ano | grep -E ":(3000|3001|5000|5001) " && echo "Still in use" || echo "All clear"
```

Do **not** reboot, and do **not** reach for `netsh interface` resets, until the above has been tried. In practice a kernel TCP-leak never shows up here — the symptom is always a still-alive parent process.

---

## CUDA / GPU Failures

### Symptom: `import pianoidCuda` fails with DLL error

The `.pyd` extension module cannot find its runtime DLLs.

**Check:**

```bat
cd PianoidInstall\PianoidCore
.venv\Scripts\python -c "import pianoidCuda; print(pianoidCuda.__file__)"
```

**Diagnosis:** Look for `SDL3.dll` (or `SDL2.dll`) and `cudart64_*.dll` next to the `.pyd` file in `site-packages/`. If missing, the build's DLL deployment step failed.

**Fix:** Rebuild with `--heavy`:

```bat
cd PianoidCore
build_pianoid_cuda.bat --heavy --both
```

### Symptom: GPU initialization fails at runtime

The CUDA engine cannot access the GPU after preset load.

**Check:**

```bat
:: Verify CUDA is accessible
.venv\Scripts\python -c "import pianoidCuda; print('CUDA OK')"

:: Check NVIDIA driver
nvidia-smi
```

**Common causes:**

- NVIDIA driver not installed or outdated — update to latest Game/Studio driver
- GPU compute capability < 7.5 (pre-Turing) — not supported
- Another process holding exclusive GPU access — check Task Manager for GPU usage
- CUDA toolkit version mismatch — the build was compiled against a different CUDA version than installed

### Symptom: `nvidia-smi` reports "NVML not found" — GPU visible but CUDA fails

The GPU is present and visible (Device Manager / Windows shows the card), but
`nvidia-smi` fails with **"NVML library not found"** / **"Failed to initialize NVML"**,
and the backend then crashes on APPLY with **"no CUDA-capable device is detected"**.
Re-running the CUDA toolkit installer (`setup-packages.bat`) does **not** fix it.

**Run the diagnostic first** — it pinpoints exactly which layer is broken and prints a verdict + fix:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File diagnose-cuda.ps1
```

**Root cause.** `nvml.dll` (the NVIDIA Management Library) and `nvidia-smi.exe` are
**driver components**, not CUDA-toolkit components. `nvml.dll` lives in
`C:\Windows\System32` (and the DriverStore `FileRepository`), **version-locked to the
installed display driver**. "NVML not found" means `nvml.dll` is missing from a
loadable location (or is the wrong version for the driver). Because it is a *driver*
file, the **CUDA toolkit installer does not ship or repair it** — which is why a
`setup-packages` re-install leaves the error in place.

**Layers (the diagnostic separates these):**

| Layer | Components | "NVML not found" relevance |
|---|---|---|
| **Display driver** | `nvml.dll`, `nvidia-smi.exe`, `nvlddmkm` kernel driver | **This is the broken layer.** Fix here. |
| CUDA toolkit | `nvcc`, `CUDA_PATH`, `cudart64_*.dll` (in CUDA bin) | Needed only to *build*; re-installing it does not fix NVML. |
| Pianoid engine runtime | `cudart64_12.dll` next to the `.pyd` in the venv | The engine's own bundled runtime; unrelated to NVML. |

**Fix (in order):**

1. **Reinstall / repair the NVIDIA DISPLAY DRIVER** — a clean install via the official
   NVIDIA installer (or DDU + reinstall). This restores a matching `nvml.dll` into
   `System32`. *(Not the CUDA toolkit.)*
2. If the diagnostic shows `nvml.dll` only in the DriverStore but missing from
   `System32`, a driver reinstall is still the correct fix — copying the DLL by hand
   is a last-resort hack and can version-mismatch.
3. Reboot, then re-run `diagnose-cuda.ps1` — the `nvidia-smi` section should pass.

**Launcher behaviour.** `start-pianoid.bat`'s pre-launch `check-cuda.ps1` now detects
this broken-but-present state (a thrown cupy device query, or an NVML error from
`nvidia-smi`) and shows an explicit **"CUDA is installed but NOT working"** warning
before launch, letting you proceed (the UI loads) or cancel — instead of launching
straight into the backend crash. See
[`QUICK_START.md` § Pre-launch safety checks](QUICK_START.md#no-prompt-launch-desktop-shortcut--update-check).

### Symptom: `nvcc` not found during build

**Check:**

```bat
where nvcc
echo %CUDA_PATH%
```

**Fix:**

1. Install CUDA Toolkit 12.6 from NVIDIA (or run `setup-packages.bat`)
2. Ensure `CUDA_PATH` points to the installation root (e.g. `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6`)
3. Add `%CUDA_PATH%\bin` to system PATH

Run `detect_paths.py` to see all search strategies and what was found:

```bat
cd PianoidCore
.venv\Scripts\python detect_paths.py --project-root pianoid_cuda --out NUL
```

---

## Build Failures

**Build / rebuild:** follow the canonical procedure in [`docs/architecture/BUILD_SYSTEM.md` → Canonical Install / Rebuild](../architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first) — stop the .pyd holder first (launcher REST or PID), cwd `PianoidCore`, bat by **absolute path** (cd-safe), `unset VIRTUAL_ENV`, default `--both`, detached `Start-Process` in agent contexts, verify import **and** `/load_preset` 200. After any merge/pull touching compiled code, the [post-merge rebuild gate](../architecture/BUILD_SYSTEM.md#post-merge--post-pull-rebuild-gate) is mandatory before push/handoff. The sections below diagnose specific build-failure symptoms.

### Symptom: MSVC / Visual Studio not found

`detect_paths.py` cannot locate the C++ compiler.

**Fix:**

1. Install Visual Studio 2022 Build Tools with the "Desktop development with C++" workload
2. If installed but not detected, set `VCToolsInstallDir` environment variable
3. Or ensure `cl.exe` is on PATH (run from "Developer Command Prompt for VS 2022")

### Symptom: SDL library not found (`LNK1181: cannot open input file 'SDL3.lib'`)

**Fix (in order of preference):**

1. Install SDL3 to a standard location: `C:\SDL3-<version>\` with `include\` and `lib\x64\` subdirectories
2. Set `SDL3_DIR` (or `SDL2_DIR`) environment variable to the SDL root
3. Pass `--sdl3` hint to `detect_paths.py`

At least one of SDL2 or SDL3 must be present. SDL3 is preferred when both are found.

### Symptom: Build exits with code `3221225794` (0xC0000142 STATUS_DLL_INIT_FAILED)

Pip's PEP 517 build-isolation subprocess failed to initialize. `build_pianoid_cuda.bat`
now detects this specific exit code and prints a recovery hint inline.

**Root cause:** corrupted state in `%TEMP%\pip-build-env-*` or residual env pollution
from a `vcvars64.bat` wrapper.

**Recovery and detailed troubleshooting:** see
[BUILD_SYSTEM.md — 0xC0000142 Recovery](../architecture/BUILD_SYSTEM.md#0xc0000142-recovery-status_dll_init_failed)
and [vcvars wrapper trap](../architecture/BUILD_SYSTEM.md#vcvars-wrapper-trap-do-not-wrap-this-script).

### Symptom: "File in use" error (`[WinError 5] Access is denied`) during CUDA build

The `.pyd` file is locked by a running Python process (usually the backend server).
The uninstall step cannot delete the file and the package ends up uninstalled.

**Diagnosis:**

```bash
tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python
tasklist //M cudart64_12.dll 2>/dev/null | grep python
```

**Fix:** Kill the specific PID, then rebuild. Never use `taskkill //F //IM python.exe` —
that kills MCP servers and Claude Code:

```bash
taskkill //F //PID <pid>
```

If a launcher is running, `curl -X POST http://localhost:3001/api/stop-backend` is a
safer alternative. Retry via `.\build_pianoid_cuda.bat --heavy --both`.

### Symptom: Code changes appear to have no effect after rebuild

You edit a `.cu` / `.cpp` file, rebuild with direct `pip install`, but runtime behavior
is unchanged. Sabotage tests that should produce silence or distortion produce identical
output to the baseline.

**Root cause:** `pip install --force-reinstall --no-cache-dir pianoid_cuda/` sometimes
silently returns a cached stale `.pyd` from setuptools build isolation, even though `.obj`
files regenerate and `nvcc` runs.

**Fix:** always rebuild via the batch script:

```bash
cd PianoidCore && .\build_pianoid_cuda.bat --heavy --both
```

**Verify** a known new string from your edit is in the installed binary:

```bash
grep -a "<some-new-string-from-your-edit>" \
  PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd
```

Zero matches means a stale pyd was installed. See
[BUILD_SYSTEM.md — Canonical Install / Rebuild](../architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).

### Symptom: Debug variant fails to import / release loads instead

You run with `PIANOID_USE_DEBUG=1` or `"debug_mode": 1`, but log output shows
`pianoidCuda` (release) was loaded — or you get `ImportError: DLL load failed while
importing pianoidCuda_debug`.

**Root cause:** `PIANOID_BUILD_VARIANT=debug` rebuild **skips DLL copy**. Without
`cudart64_12.dll` and `SDL3.dll` next to `pianoidCuda_debug.pyd`, the debug module
cannot load. The middleware's `select_cuda_variant` catches the ImportError silently
and falls back to release, so code edits that live only in the debug build appear to
have zero effect.

**Fix:** always rebuild release before debug, so the DLLs are present:

```bash
./build_pianoid_cuda.bat --heavy --release   # copies DLLs
./build_pianoid_cuda.bat --heavy --debug     # reuses DLLs
# or in one call:
./build_pianoid_cuda.bat --heavy --both
```

Verify both variants load:

```bash
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; import pianoidCuda_debug; print('OK')"
```

See [BUILD_SYSTEM.md — Debug variant DLL trap](../architecture/BUILD_SYSTEM.md#debug-variant-dll-trap).

### Symptom: Build succeeds but wrong variant loaded (normal case)

The middleware loads `pianoidCuda` (release) by default. To use the debug build:

```bat
set PIANOID_USE_DEBUG=1
python backendserver.py
```

Or pass `"debug_mode": 1` in the `/load_preset` request body. Both variants must
already be built and importable (see the previous symptom).

---

## Backend Startup Failures

### Symptom: Flask server starts but `/load_preset` fails

**Check the backend console output** for Python tracebacks. Common causes:

- **Preset file not found** — the path is relative to `pianoid_middleware/`. Default: `presets/BaselinePreset1.json`
- **Missing Python package** — run `pip list` in the venv to verify `Pianoid` (PianoidBasic) and `pianoidCuda` are installed
- **Wrong Python interpreter** — always use `PianoidCore\.venv\Scripts\python`, never system Python

### Symptom: Backend listener shows `C:\Python312\python.exe` instead of venv — DO NOT diagnose as a spawn bug

When the launcher spawns the backend on Windows, you see **two Python processes**:

| Role | PID example | `wmic ExecutablePath` | Cmdline format |
|---|---|---|---|
| Launcher shim (parent) | 58276 | `D:\...\PianoidCore\.venv\Scripts\python.exe` | unquoted `<path> -u backendServer.py` |
| Actual interpreter (child) | 73984 | `C:\Python312\python.exe` | quoted `"<path>" -u backendServer.py` |

`netstat -ano` shows the **child** holds port 5000, and `ExecutablePath` shows the base Python path. **This is normal Python 3.12 Windows venv behavior, NOT a venv→system-Python spawn bug.** Do not "fix" it.

**Why:** Python 3.12 on Windows ships `venv/Scripts/python.exe` as a 274 KB `venvlauncher.exe`-derived **launcher stub** (compare against `C:\Python312\python.exe` at 103 KB — different sizes prove they're not the same binary). The stub locates the base Python from `pyvenv.cfg` and `CreateProcess`es it as a child, passing through argv + env. The stub parent stays alive as a wrapper for stdio relay. The child IS the actual CPython interpreter; its `sys.prefix` correctly resolves to the venv via `pyvenv.cfg` discovery, and it imports from the venv's `site-packages`.

**The misleading signals** (each one matches the pathology pattern but means nothing on its own):

- Child's `ExecutablePath` = `C:\Python312\python.exe` (just the binary location, not the active interpreter prefix)
- Child has `WERKZEUG_SERVER_FD=<n>` in its env (set by werkzeug `run_simple` during normal non-reloader startup; not a reloader spawn signature)
- Parent and child have nearly identical command lines
- `tasklist /M pianoidCuda.cp312-win_amd64.pyd` shows the child PID with a `C:\Python312\...` style entry

**The decisive signals** (use these, not `ExecutablePath`):

```bash
# Probe the running interpreter's sys.prefix — this is what determines site-packages
PianoidCore/.venv/Scripts/python -c "import sys; print(sys.prefix)"
# Expected: D:\repos\PianoidInstall\PianoidCore\.venv  (or your repo's venv path)
# NOT: C:\Python312
```

```bash
# Probe the actually-loaded pianoidCuda — this is what determines whether the fresh pyd is used
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
# Expected: D:\repos\PianoidInstall\PianoidCore\.venv\Lib\site-packages\pianoidCuda.cp312-win_amd64.pyd
# NOT:      C:\Python312\Lib\site-packages\pianoidCuda.cp312-win_amd64.pyd
```

If both probes return the venv path, the backend is correctly venv-resolved. The shim's `ExecutablePath` is irrelevant.

**When it IS a real wrong-Python problem.** The two-PID pattern under the launcher is normal. A genuine wrong-interpreter situation requires:

- A backend started **outside the launcher** by typing `python backendserver.py` in a shell, where `python` from `PATH` resolves to `C:\Python312\python.exe` directly (no venv shim). The `sys.prefix` probe then returns `C:\Python312` — *that* is the real bug, and the `os.execv` venv guard at the top of `backendServer.py` re-execs into the venv to recover.
- OR the user installed a stale `pianoidCuda.cp312-win_amd64.pyd` into `C:\Python312\Lib\site-packages\` historically (e.g. a March-17 build), AND is bypassing the venv. The fresh venv pyd lives at `PianoidCore/.venv/Lib/site-packages/` and is loaded correctly under the launcher.

**Common misdiagnosis pattern.** When a method (e.g. `getRawSoundRecordInt`) is missing from the running backend's `pianoidCuda.Pianoid` object after a `--heavy --release` rebuild, the cause is almost always one of:

1. **The backend was started before the rebuild finished.** The in-memory module is the pre-rebuild one. Solution: `curl -X POST http://127.0.0.1:3001/api/stop-backend && curl -X POST http://127.0.0.1:3001/api/start-backend` to pick up the fresh pyd. NO interpreter / spawn fix is needed.
2. **A Python middleware file (`PanoidResult.py`, `chartFunctions.py`) was edited but the backend wasn't restarted.** Same fix as (1) — Python source isn't hot-reloaded.
3. **A second backend is running outside the launcher.** Check `netstat -ano | grep :5000` and `wmic process where "Name='python.exe'" get ProcessId,ParentProcessId,ExecutablePath` — there should be exactly two Python PIDs (shim + interpreter) and the interpreter's parent should be the shim, whose parent should be the launcher (`node.exe ... server/launcher.js`).

**Worked diagnostic probes** demonstrating the shim pattern + the `sys.prefix`/`pianoidCuda.__file__` checks:

- `docs/development/diagnostics/dev-pyspawn-8b3a-venv-shim-probe.py` — captures the 2-PID structure and confirms the child's `sys.prefix` resolves to the venv
- `docs/development/diagnostics/dev-pyspawn-8b3a-sysprefix-probe.py` — replays the launcher's exact spawn (cwd=`pianoid_middleware`, `.venv/Scripts/python.exe -u <script>`) and verifies the fresh pyd is loaded with the expected methods
- `docs/development/diagnostics/dev-pyspawn-8b3a-execv-probe.py` — documents Windows `os.execv` semantics (spawn-and-exit, NOT in-place replace) for understanding the venv guard at the top of `backendServer.py`

**History.** This pattern was misdiagnosed twice in the same week — first by `dev-stest-4a7c` (2026-05-31, session log line 406: "Backend was on SYSTEM Python ... loading the stale March pyd from C:\Python312\Lib\site-packages\"), then by the dispatch that spawned `dev-pyspawn-8b3a` (the brief asked for a Werkzeug-reloader / `sys._base_executable` fix). Both misreads followed the same template: `ExecutablePath=C:\Python312\python.exe` interpreted as "running with system Python" rather than "actual CPython binary launched via venv shim." The fifth distinct stale-pyd surface to be aware of, joining: cross-venv copy, `pip install --force-reinstall` cache hit, debug-variant DLL skip, and 0xC0000142 build failure (the other four are about actual stale pyds; this one is about misdiagnosed normal venv behavior).

### Symptom: Audio driver fails to initialize

Pianoid supports four driver codes (passed as `audio_driver_type` to `/load_preset`):

| Code | Driver | Typical use |
|---|---|---|
| `4` | ASIO Callback | Lowest latency; requires ASIO device or ASIO4ALL |
| `3` | SDL3 | Preferred general-purpose driver (if SDL3 was present at build time) |
| `2` | SDL2 | Universal fallback, works on any system |
| `1` | ASIO (legacy polling) | Older ASIO path; prefer `4` |

**Automatic ASIO → SDL3 fallback (dev-asioload, 2026-06-02).** When `audio_driver_type: 4`
(ASIO_CALLBACK) is requested but ASIO cannot initialize (the common "no ASIO driver
installed" case), the engine now **automatically falls back to SDL3** instead of leaving
`audio_driver_active: false` (silent no-sound). The fallback is **surfaced to the user**:
`GET /health` reports `audio_driver_fallback: {occurred: true, requested: "ASIO_CALLBACK",
active: "SDL3", message: "ASIO_CALLBACK unavailable - using SDL3", reason: ...}`, and the
same dict is pushed on the WebSocket `lifecycle` event so the frontend shows a warning.
You no longer need to manually switch to SDL just to get audio — but to get *native ASIO*
(lowest latency) you must install an ASIO driver (below). Engine mechanics:
[AUDIO_DRIVERS.md — ASIO → SDL3 Runtime Fallback](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asio--sdl3-runtime-fallback).

**Recommended fallback chain** when the current driver fails to initialize:

1. **ASIO Callback (4) fails** → the engine now auto-falls-back to SDL3 (3) and warns;
   to switch manually anyway, set `audio_driver_type: 3`
2. **SDL3 (3) fails** → try SDL2 (2)
3. **SDL2 (2) fails** → the build likely lacks both SDL variants; rebuild with
   `build_pianoid_cuda.bat --heavy` after ensuring at least one of SDL2/SDL3 is
   installed (see [BUILD_SYSTEM.md — Toolchain Requirements](../architecture/BUILD_SYSTEM.md#toolchain-requirements))

**ASIO-specific issues:**

- No ASIO driver installed (`HKLM\SOFTWARE\ASIO` empty/absent → "No working ASIO driver
  found!") — install ASIO4ALL or your audio interface's native ASIO driver. Until then the
  engine auto-falls-back to SDL3 (above), so you still have audio; native ASIO requires the
  driver. Verify with PowerShell `Test-Path 'HKLM:\SOFTWARE\ASIO'` (`$false` = none installed).
- ASIO device in use by another application (DAW, etc.) — close the other application
- ASIO sample rate mismatch with the backend — set `"sample_rate": 48` in `/load_preset`
  to match 48 kHz (the default for most interfaces)
- **Second `/load_preset` fails with "No working ASIO driver found"** — historically the
  second consecutive `/load_preset` with `audio_driver_type: 4` would fail enumeration
  of every ASIO driver. Root cause was a missing COM apartment on the playback worker
  thread; the Steinberg ASIO host SDK uses `IASIO` COM interfaces and the calling thread
  must have COM initialized as STA (`COINIT_APARTMENTTHREADED`) before the first ASIO
  call. Fixed in dev-asiocrash-b20f (2026-05-27) — the `run_online` worker in
  `pianoid_middleware/pianoid.py` now calls `pythoncom.CoInitializeEx(COINIT_APARTMENTTHREADED)`
  at thread start and `CoUninitialize` on cleanup. If the symptom reappears, confirm
  via `PianoidCore/logs/backend_stdout.log` (captured by the launcher since this fix)
  that `ASIO: Failed to initialize driver '<name>'` appears for every enumerated driver
  on the second load — that signature points back to a COM-apartment regression.

**SDL-specific issues:**

- `SDL3.dll` or `SDL2.dll` missing next to the installed `.pyd` — the build's DLL deploy
  step failed or you rebuilt the debug variant without the release DLLs. Rebuild with
  `.\build_pianoid_cuda.bat --heavy --both`. See
  [Debug variant fails to import](#symptom-debug-variant-fails-to-import-release-loads-instead).
- SDL version mismatch — ensure the installed SDL version matches what was used during
  build (check `build_config.json` in `PianoidCore/pianoid_cuda/`)

### Symptom: Backend starts but no audio output

1. Check audio driver selection: query `GET /health` — the `lifecycle.audio_driver_active` field should be `true`
2. Verify volume is non-zero: `curl http://localhost:5000/get_parameter/runtime/volume`
3. Check Windows audio output device — ensure the correct playback device is selected in Windows Sound settings
4. Try playing a note: `curl -X POST http://localhost:5000/play -H "Content-Type: application/json" -d '{"pitch": 60, "velocity": 100}'`

### Symptom: Pianoid loads preset but audio is silent / distorted right after running a Modal Adapter measurement

The Modal Adapter (port 5001) opens the SDL3 audio device during a
measurement scenario. If the user starts a Pianoid preset load while MA
still owns the device, both backends fight for exclusive ownership and
the result is silent or distorted output.

**Auto-fix in place (dev-mastop, 2026-05-07):** the frontend's
`ensureBackendAndLoadPreset` (PianoidTuner.js) checks
`useBackendProcess.modalRunning` on every preset load. When MA is up, it
POSTs `/api/stop-modal-adapter` on the launcher and `await`s before
opening the Pianoid audio driver. The launcher's `gracefulShutdown` calls
MA's `/shutdown`, which calls `MeasurementSession.cancel_and_wait()` to
release the recorder's audio handle BEFORE process exit. See
[SYSTEM_OVERVIEW.md — Audio-driver coordination](../architecture/SYSTEM_OVERVIEW.md#audio-driver-coordination--preset-load-vs-modal-adapter-measurement-dev-mastop-2026-05-07).

**Manual recovery if the auto-fix fails** (e.g. launcher down, frontend
not reachable):

```bash
# Stop MA via the launcher (preferred — cleanest audio-device release)
curl -X POST http://127.0.0.1:3001/api/stop-modal-adapter

# Or kill MA directly by port (if launcher is unreachable)
pid=$(netstat -ano 2>/dev/null | grep ':5001 .*LISTENING' | awk '{print $NF}' | head -1)
[ -n "$pid" ] && [ "$pid" != "0" ] && taskkill //F //PID "$pid"

# Then re-load the preset (or restart the backend)
curl -X POST http://127.0.0.1:3001/api/stop-backend
curl -X POST http://127.0.0.1:3001/api/start-backend
```

---

## Frontend Startup Failures

### Symptom: `npm run dev` fails

**Check:**

```bat
node --version    :: Requires 20.x
npm --version
```

**Fix:**

```bat
cd PianoidTunner
rm -rf node_modules
npm install
npm run dev
```

### Symptom: `npm run dev` / `npm run build` fails with "Plugin react was conflicted between ..."

The full error reads something like *"Plugin "react" was conflicted between
`package.json » eslint-config-react-app » .../base.js` and
`.eslintrc » eslint-config-react-app » .../base.js`."*

**Cause:** `react-scripts 5.0.1` resolves `eslint-config-react-app` twice — once
project-side (`package.json` `eslintConfig.extends: ["react-app"]`) and once
react-scripts-side (its webpack config with `resolvePluginsRelativeTo: __dirname`).
`@rushstack/eslint-patch` de-dups plugins by absolute path **case-sensitively**, but
Windows' case-insensitive filesystem lets the same `base.js` resolve under different
casings (e.g. `C:\dima\…` vs `C:\Dima\…`) depending on the CWD casing you launched from.
The patch then sees "two different" copies of the `react` plugin and aborts. This is why
it can bite a manual `npm run dev` from a mis-cased CWD even when `start-pianoid.bat` works.

**Fix (already shipped):** `PianoidTunner/.env` contains `DISABLE_ESLINT_PLUGIN=true`, which
makes `react-scripts` skip the build-time `ESLintWebpackPlugin` entirely, removing the
double-resolution at its source — both launch methods build regardless of CWD casing. The
file is committed (not gitignored), so collaborators get it automatically. If you ever
deleted it, recreate it with that one line. Lint is still runnable on demand via
`npm run lint` (the `react-app` rules stay configured in `package.json`).

### Symptom: Frontend loads but shows "Backend not connected"

The launcher (port 3001) or the backend (port 5000) is not running.

- If using `start-pianoid.bat` / `npm run dev`: the backend starts only after clicking APPLY in the UI
- If using `npm start` (no launcher): start the backend manually in a separate terminal

### Symptom: Browser shows blank page or React errors

1. Clear browser cache or try incognito mode
2. Check the browser console (F12) for JavaScript errors
3. Verify `npm run dev` is still running in the terminal (check for crash output)

---

## First-Run Checklist

Use this checklist to verify a fresh installation:

- [ ] All prerequisites installed: `setup-packages.bat` completed without errors
- [ ] Build completed: `setup-pianoid.bat` all 4 steps passed
- [ ] CUDA import works: `.venv\Scripts\python -c "import pianoidCuda; print('OK')"`
- [ ] PianoidBasic import works: `.venv\Scripts\python -c "import Pianoid; print('OK')"`
- [ ] Frontend deps installed: `PianoidTunner\node_modules` exists
- [ ] Frontend starts: `npm run dev` in PianoidTunner starts without errors
- [ ] Browser opens: http://localhost:3000 shows the Pianoid UI
- [ ] Backend starts: click APPLY — status indicator turns green
- [ ] Audio works: press a virtual piano key — sound plays
- [ ] MIDI works (optional): connect MIDI device — keys trigger sound

---

## Log File Locations

| Log | Location | Contents |
|---|---|---|
| CUDA build log | `PianoidCore\build.log` | Full nvcc/MSVC compiler output |
| Backend console | Terminal running `backendserver.py` | Flask requests, CUDA init, errors |
| Launcher console | Terminal running `npm run dev` | Backend spawn/kill events |
| WebSocket console | `ws://localhost:3001/ws/console` | Real-time backend log stream (from UI) |
| PianoidLogger | `PianoidCore\pianoid_middleware\logs\` | File-based engine logs (if enabled) |

---

## Live UI Test Startup (agents)

The canonical procedure for agents running `/test-ui` or verifying features in the browser lives in [UI Testing](UI_TESTING.md). Summary:

1. Kill any stale processes on 3000, 3001, 5000, 5001 (port-targeted, never blanket `taskkill //IM`).
2. `cd PianoidTunner && npm run dev` — starts launcher (3001) + React dev server (3000) together via `concurrently`.
3. Open `http://localhost:3000`. Click **APPLY** (or POST `/api/start-backend` to :3001). The launcher spawns the backend (5000).
4. Do **not** start the backend directly with `python backendserver.py` — the frontend will kill it on the next APPLY (see [Three-Process Architecture](#three-process-architecture)).

## Shutdown Sequence

Correct shutdown order is **frontend → launcher → modal → backend** (reverse of startup dependency). The launcher already handles this for its children; you only need manual cleanup if the launcher itself dies.

```bash
# Graceful backend shutdown (launcher still running)
curl -X POST http://127.0.0.1:3001/api/stop-backend

# Full teardown (no launcher — port-targeted kills)
for port in 3000 3001 5001 5000; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  [ -n "$pid" ] && [ "$pid" != "0" ] && taskkill //F //PID "$pid"
done
```

The launcher has `SIGINT` / `SIGTERM` handlers that `taskkill /T /F` both children on exit (launcher.js:346). Closing the terminal where `npm run dev` runs also triggers cleanup.

---

## Recovery Procedures

### Full clean rebuild

When the build state is corrupted or multiple issues compound:

```bat
cd PianoidInstall\PianoidCore

:: Clean and rebuild PianoidBasic
build_pianoid_basic.bat

:: Full clean CUDA rebuild (both variants)
build_pianoid_cuda.bat --heavy --both

:: Reinstall frontend deps
cd ..\PianoidTunner
rd /s /q node_modules
npm install
```

### Reset to known-good state

```bat
cd PianoidInstall

:: Pull latest code
git pull
cd PianoidCore && git pull && cd ..
cd PianoidBasic && git pull && cd ..
cd PianoidTunner && git pull && cd ..

:: Full rebuild
setup-pianoid.bat
```
