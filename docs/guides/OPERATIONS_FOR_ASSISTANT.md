# Operations Primer (install, update, rebuild, start)

**Audience:** the in-UI Pianoid assistant (and anyone who needs the procedures in one place). **Owner:** dev-6b34,
2026-10-18. Every statement below is taken from a doc or a script; the source is linked in the row or the paragraph.
Where a doc and a script disagree, the disagreement is listed in [Doc / script disagreements](#conflicts) and is
**not** silently resolved here.

The assistant has **no shell**: it explains these procedures and hands the commands to the user. It never claims to
have pulled, built, installed, killed or restarted anything. It can read the state first (`ops_status`,
`system.snapshot`, `launcher.status`) and pick the procedure that applies.

## What the assistant can do itself {#assistant-can-do}

| Action | Who | Source |
|---|---|---|
| `ops_status`: per repo branch, ahead / behind its integration branch as of the last `git fetch`, local changes; installed engine and Basic package vs the checkout (rebuild needed?); npm dependencies vs the lock files; the assistant's own setup | assistant, read-only, no confirm | `tools/pianoid-assistant/mcp/opsStatus.js` |
| `system.snapshot` / `system.environment` / `system.health` (needs the backend on :5000) | assistant, read-only | `schemas/commands/system.json` |
| `launcher.status`, `launcher.assistant.status` (needs the launcher on :3001) | assistant, read-only | `schemas/commands/launcher.json` |
| `read_docs` / `search_docs` on this page and the rest of the docs | assistant, read-only | `tools/pianoid-assistant/mcp/server.js` |
| Start the backend / the modal adapter / the assistant service (`launcher.backend.start`, `launcher.modal.start`, `launcher.assistant.start`) | assistant, **asks the user every time** (hard-confirm, never Auto) | `launcher.json` `approval_category: hard_confirm`; `tools/pianoid-assistant/README.md` (Policy) |
| Stop the backend / modal adapter / assistant | **never** the assistant (`excluded`) | `launcher.json` |
| Everything else on this page: git, builds, `npm`, setup scripts, kill scripts, GPU clock, drivers | **the user** | the scripts themselves |
| Soundboard measurement → preset over ASIO (dev-8a9e): `modal.rig_capture` (sweeps per exciter, recorded inputs), `modal.rig_sine` (a tone, optional recording), `modal.rig_record` (inputs only), `modal.rig_process` (`frf` → `polymax` → `coefficients` → `build_preset`), `preset.create` (a NEW preset with other strings / channels / array_size) | assistant, **hard-confirm every run** (never Auto; denied when "Block measurement data" is on). `modal.rig_runs` / `modal.rig_files` (run listing, file export for `analysis.run_python`) run without a confirm; `modal.rig_cancel` (category playback) stops a rig job | `schemas/commands/modal.json`, `preset.json`; `tools/pianoid-assistant/policy.js` `HARD_CONFIRM` |
| Where the measurement data lives | `modal.measurements_dir` (read, no confirm): the folder and its source (runtime setting > `PIANOID_MEASUREMENTS_DIR` > `<PianoidInstall>/measurements`). `modal.set_measurements_dir {path}` moves it (absolute, creatable, writable; persists across restarts; data is NOT moved): assistant, **hard-confirm every time** | [REST_API → Measurements folder](../modules/pianoid-middleware/REST_API.md#measurements-folder); [Mode Discovery → the measurements folder](MODE_DISCOVERY_FOR_ASSISTANT.md#cmd-measurements-dir) |
| Safe levels of every rig drive | every `level_dbfs` is capped at **−24 dBFS** (registry maximum = `rig_pipeline.spec.SAFE_MAX_LEVEL_DBFS`, checked again in the step); the engine's own sweep ceiling is −12 dBFS. Documented working levels −30 … −48 dBFS: [Mode Discovery → levels](MODE_DISCOVERY_FOR_ASSISTANT.md#rig-levels) | `schemas/commands/modal.json` |
| What the rig commands need | the backend on :5000 with a preset loaded on the **ASIO callback driver** (`audio_driver_type 4`); synthesis pauses for each session. For the measured / exciter presets also `PIANOID_AUDIO_OUTPUT_MAP` (the user sets it; the rig sessions address physical outputs by name and do not use the map) | [REST_API → Rig measurement pipeline](../modules/pianoid-middleware/REST_API.md#rig-pipeline) |
| The whole procedure, every parameter, the worked example for a 7-exciter / 8-piezo rig | [Mode Discovery Guide](MODE_DISCOVERY_FOR_ASSISTANT.md#rig-commands) (`read_docs` on that page) | the measurement reports |

**Shells.** "cmd" = Command Prompt (a `.bat` can also be double-clicked in Explorer). "PowerShell" = Windows
PowerShell. "Admin" = started with *Run as administrator*. In cmd, `tasklist /M …` takes ONE slash; the docs'
`tasklist //M …` / `taskkill //F //PID …` forms are for Git Bash. In Windows PowerShell 5.1 `curl` is an alias of
`Invoke-WebRequest`; use `curl.exe` there, or cmd. `<PianoidInstall>` = the install root (`ops_status` reports the
real path; on the main machine `D:\repos\PianoidInstall`).

## Repos and branches {#repos}

| Repo | Path | Integration branch | Holds |
|---|---|---|---|
| PianoidInstall | `<PianoidInstall>` | `master` | docs, setup / start / update scripts, `schemas/`, `tools/` (incl. the assistant `tools/pianoid-assistant`) |
| PianoidCore | `<PianoidInstall>\PianoidCore` | `dev` | Flask backend (`pianoid_middleware`), CUDA engine (`pianoid_cuda`), the build scripts, the venv `.venv` |
| PianoidBasic | `<PianoidInstall>\PianoidBasic` | `dev` | domain model, installed into the venv as the `Pianoid` wheel |
| PianoidTunner | `<PianoidInstall>\PianoidTunner` | `dev` | React UI + the Node launcher (`server/launcher.js`) |

Sources: [PROJECT_CONFIG → Repos](../PROJECT_CONFIG.md#repos), `clone-packages.bat` (clones the three sub-repos with
`-b dev`), `check-updates.ps1` (`$Repos`: the three sub-repos against `origin/dev`, PianoidInstall against
`origin/master`). The only Python environment is `PianoidCore\.venv` (never system Python, never a root `.venv`):
[PROJECT_CONFIG → Interpreters](../PROJECT_CONFIG.md#interpreters).

## New machine install {#new-machine}

Source: [QUICK_START](QUICK_START.md), the root `README.md` (Installation),
`setup-packages.bat` / `setup-dev.ps1`, `setup-pianoid.bat`, `tools/pianoid-assistant/README.md`.

| Step | Command (shell, folder) | What it does / notes |
|---|---|---|
| 0. Requirements | — | Windows 10+ 64-bit; NVIDIA GPU, compute capability 7.5+ (RTX 2060 or newer); Git (`install-git.bat`, Admin, if missing). The NVIDIA display driver and an ASIO driver are NOT installed by the setup scripts. |
| 1. Clone | cmd, any parent folder: `git clone https://github.com/DSPianoid/PianoidInstall`, then `cd PianoidInstall`, then `clone-packages.bat` | clones PianoidTunner, PianoidCore, PianoidBasic (branch `dev`) inside PianoidInstall |
| 2. System packages | `setup-packages.bat`, **Admin**, in PianoidInstall; choose **1** (normal install) | via `setup-dev.ps1`: Python 3.12, VS 2022 Build Tools (C++), CUDA Toolkit 12.6, SDL2 2.30.8 to `C:\SDL2-2.30.8`, SDL3 3.1.6 to `C:\SDL3-3.1.6`, Node.js 20. Versions: `setup-config.json`. Options 2-5 force-reinstall Python / CUDA / Node / all; 6 writes a sample config; 7 reinstalls the NVIDIA **display driver** (separate, prompts on the risks, reboots). A restart may be needed after VS or CUDA. |
| 3. Build everything | `setup-pianoid.bat`, cmd (not Admin), in PianoidInstall | (1) creates `PianoidCore\.venv` (python, else `py -3.12` / `py -3`) and installs `PianoidCore\requirements.txt`; (2) `build_pianoid_basic.bat`; (3) `build_pianoid_cuda.bat --heavy --both`; (4) `npm ci` in PianoidTunner. 5-15 min; compiler output in `PianoidCore\build.log`. |
| 4. Assistant dependencies | cmd: `cd <PianoidInstall>\tools\pianoid-assistant` then `npm install` | `setup-pianoid.bat` / `.sh` run `npm ci` there at the end of step 4 (a failure only warns: Pianoid runs without the assistant). It also installs the Claude Code CLI bundled with the Agent SDK, so no global `claude` is needed. Without it the launcher refuses to start the assistant ("assistant dependencies missing: run npm install in …", `launcher.js`). Then the one-time login, see [Assistant setup](#assistant-setup). |
| 5. Desktop shortcut (optional) | double-click `make-shortcut.bat` | a Desktop **Pianoid** icon running `start-pianoid.bat /auto` |
| 6. Docs server (optional) | cmd in PianoidInstall: `pip install mkdocs mkdocs-material`, then `mkdocs serve -a localhost:8001` | serves these docs at http://localhost:8001 (root README "Documentation") |
| 7. Check | [First-Run Checklist](STARTUP_TROUBLESHOOTING.md#first-run-checklist) | `PianoidCore\.venv\Scripts\python -c "import pianoidCuda; print('OK')"` and `… -c "import Pianoid; print('OK')"` (cmd in PianoidCore); `npm run dev` starts; APPLY turns the status green; a key plays. |

Linux has sibling `.sh` scripts for each step: [LINUX_BUILD](LINUX_BUILD.md) and
[BUILD_SYSTEM → Cross-Platform Shell Wrappers](../architecture/BUILD_SYSTEM.md#cross-platform-shell-wrappers).

## Start and stop {#start}

**Normal start = the desktop icon** (`start-pianoid.bat /auto`), or `start-pianoid.bat` in cmd. Source:
`start-pianoid.bat`, [QUICK_START → No-prompt launch](QUICK_START.md#no-prompt-launch-desktop-shortcut-update-check),
[PROJECT_CONFIG → Clean stack](../PROJECT_CONFIG.md#clean-stack).

The script runs these steps in this order before anything starts:

| # | Step | What the user sees | How long / default |
|---|---|---|---|
| 1 | Prerequisite check (folders, `PianoidCore\.venv`, `PianoidTunner\node_modules`) | on failure "STARTUP FAILED … run setup-pianoid.bat"; the window waits for a key (also under `/auto`) | — |
| 2 | `check-running-servers.ps1`: is a stack already listening on 3000 / 3001 / 5000 / 5001? | pop-up **Kill & restart / Cancel** (kills only the owners of those ports) | `/auto`: timed, 30 s, timeout = Cancel = no launch. Bare run: waits for a click |
| 3 | `check-updates.ps1`: `git fetch` each repo, count commits on its integration branch missing from `HEAD` | if any repo is behind: Yes / No pop-up; **Yes runs `update-repos.bat` in the same window** (see [Update](#update)); if that pull changed `start-pianoid.bat`, the window says "start-pianoid.bat was updated - restarting it" and the new version continues | fetch timeout 8 s per repo; skipped with `/auto-noupdate` |
| 4 | `check-cuda.ps1`: CUDA device + SM count | warning pop-up for no device / broken CUDA (`/auto`: timed 30 s, then continue); the < 60 SM warning only on bare runs | Cancel aborts the launch |
| 5 | `check-gpu-clock.ps1`: GPU clocks locked? | if not: an explanation, then **one UAC prompt** (once per boot); declining launches anyway | the apply waits at most 20 s, then launches anyway; skip with `PIANOID_SKIP_GPU_CLOCK_CHECK=1` |
| 6 | `start "Pianoid" … npm run dev` in PianoidTunner | a new window **Pianoid**: launcher (:3001) + React UI (:3000); the browser opens http://localhost:3000 | the CRA compile takes a while on first start |
| 7 | the user clicks **APPLY** | the launcher spawns the backend (:5000), loads the preset; the status turns green | — |

The assistant service (127.0.0.1:3002) is a child of the launcher, started by the pane's **Start assistant** button
(`launcher.assistant.start`); see [Assistant setup](#assistant-setup).

**Flags:** `start-pianoid.bat /auto` (or `--no-prompt`) skips the key presses; `/auto-noupdate` (or
`/no-update-check`) also skips the update check. **Manual start:** cmd in `PianoidTunner`: `npm run dev`.

**Stop:** close the **Pianoid** window (or Ctrl+C in it): the launcher kills its children on exit
([STARTUP_TROUBLESHOOTING → Shutdown Sequence](STARTUP_TROUBLESHOOTING.md#shutdown-sequence)). Anything left over
(a stray backend, a port still busy): PowerShell in PianoidInstall,
`powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1 -DryRun` (preview), then without `-DryRun` (kills
only Pianoid processes: the `concurrently` tree, the four ports' owners, marker-matched orphans). Clean + start in
one go, in the foreground: `powershell -ExecutionPolicy Bypass -File tools\clean_and_start.ps1`. Never
`taskkill /IM python.exe` or `/IM node.exe` (kills unrelated programs).

## Update from git {#update}

**Is an update available?** `ops_status` reports `behind` per repo **as of the last fetch** (`last_fetch`; the
startup check fetches at every launch). The launch pop-up (step 3 above) fetches first. Dry run without the pop-up:
PowerShell in PianoidInstall, `powershell -ExecutionPolicy Bypass -File check-updates.ps1 -WhatIf`.

**Before updating:** each repo on its integration branch and without local changes (`ops_status` `branch`, `dirty`).
`update-repos.bat` pulls each repo's integration branch (`origin/master` for PianoidInstall, `origin/dev` for the
others) with `--ff-only`. It **skips** (warns, never switches) a repo checked out on another branch, and skips
PianoidInstall while it has changes to tracked files; it stops on a diverged branch or a conflict. A PianoidBasic checkout left dirty by its own build (line endings only, see
[Gotchas](#gotchas)) is restored with `git -C <PianoidInstall>\PianoidBasic checkout -- Pianoid/`; only do that when
`git -C <PianoidInstall>\PianoidBasic diff --ignore-all-space --stat` is empty (no real edits).

**Steps** (source: `update-repos.bat`,
[BUILD_SYSTEM → update-repos](../architecture/BUILD_SYSTEM.md#update-reposbatsh-automated-pull-post-pull-rebuild)):

1. Everything in one go: cmd in PianoidInstall, `update-repos.bat` (or Yes in the launch pop-up; default CUDA
   variant `--both`, `--release` / `--debug` for one variant; `--dry-run` fetches and prints what it would pull and
   rebuild, changing nothing). It pulls **PianoidInstall first** (docs, scripts, assistant, the command registry
   Core needs), then Core, Basic, Tunner, and rebuilds only what changed: Core
   `.cu/.cpp/.cuh/.h/setup.py/detect_paths.py/build_config.json` -> CUDA heavy build; any Basic change -> Basic build;
   Tunner `package.json` / `package-lock.json` (or no `node_modules`) -> `npm install`; the same for
   `tools\pianoid-assistant` (then restart the assistant with the Start assistant button if it was running).
   Before a CUDA build it stops the backend itself (`POST :3001/api/stop-backend`, else the PID listening on :5000).
   When the pull changed `update-repos.bat` or `start-pianoid.bat`, the new version takes over by itself (the window
   says so). Run it in a foreground window; a CUDA build takes 5-15 min.
2. **Once per machine** whose `update-repos.bat` predates this (dev-a22b, 2026-10-19; the old script never pulls
   PianoidInstall, so the pop-up alone cannot fix it): cmd, `git -C <PianoidInstall> pull --ff-only origin master`,
   then step 1.
3. Check: the script prints the import check and asks for the `/load_preset` smoke test: start Pianoid, click
   **APPLY**, the status turns green and the backend log has no traceback. The assistant can confirm it afterwards
   with `system.health` / `system.environment` (the engine `build_time` is the new build).

Plain `git pull` per repo followed by `setup-pianoid.bat` is the documented "reset to known-good state"
([STARTUP_TROUBLESHOOTING → Reset to known-good state](STARTUP_TROUBLESHOOTING.md#reset-to-known-good-state)); it
rebuilds everything (slow) instead of what changed.

## Rebuild {#rebuild}

**Which build** ([PROJECT_CONFIG → Rebuild decision matrix](../PROJECT_CONFIG.md#rebuild-matrix),
[BUILD_SYSTEM → Post-Merge / Post-Pull Rebuild Gate](../architecture/BUILD_SYSTEM.md#post-merge-post-pull-rebuild-gate)):

| Changed files | Build |
|---|---|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py`, `detect_paths.py`, `build_config.json` | CUDA **heavy** `--both` |
| any `PianoidBasic/**` | `build_pianoid_basic.bat` (+ CUDA heavy if a `.cu/.cpp` also changed) |
| `pianoid_middleware/*.py` only | CUDA **light** `--both` (docs); `update-repos.bat` does no build here, see [conflicts](#conflicts) C2 |
| PianoidTunner `package.json` / `package-lock.json` | `npm install` (`setup-pianoid.bat` uses `npm ci`) |
| tests or docs only | none |

After a pull or merge that brought any of the above, the rebuild + the `/load_preset` 200 check are **blocking**
before declaring it ready (the gate).

**Commands** (cmd; source: [BUILD_SYSTEM → Canonical Install / Rebuild](../architecture/BUILD_SYSTEM.md#canonical-install-rebuild-read-this-first)):

1. Stop whatever holds the engine binary: close the **Pianoid** window, or with the launcher still up
   `curl -X POST http://127.0.0.1:3001/api/stop-backend`. Check nothing holds it:
   `tasklist /M pianoidCuda.cp312-win_amd64.pyd` (and `pianoidCuda_debug.cp312-win_amd64.pyd`) lists no python.
   A held `.pyd` makes the heavy build's uninstall fail (`[WinError 5] Access is denied`) and leaves the venv
   without the package.
2. CUDA: `cd /d <PianoidInstall>\PianoidCore` then `build_pianoid_cuda.bat --heavy --both` (light:
   `--light --both`). Always pass `--both` explicitly: the script's own default is release only, which leaves the
   debug build stale. Make sure `VIRTUAL_ENV` is unset or points to `PianoidCore\.venv` (never another venv, never
   empty-but-defined).
3. PianoidBasic: `cd /d <PianoidInstall>\PianoidCore` then `build_pianoid_basic.bat` (before the CUDA build when
   both are needed).
4. Done when the window shows `[SUCCESS] Build completed.` (log: `PianoidCore\build.log`).
5. Verify, in `PianoidCore`: `.venv\Scripts\python -c "import pianoidCuda; print(pianoidCuda.__file__)"` (the path
   must be inside `PianoidCore\.venv`); with `--both` also `.venv\Scripts\python -c "import pianoidCuda_debug"` in
   its own command (both cannot load in one process); then start Pianoid and APPLY (= `POST /load_preset` 200, no
   traceback). Import alone passes even when Python and the engine disagree.

**Never:** `pip install --force-reinstall pianoid_cuda/` (reinstalls a stale cached `.pyd`); the repo-root
`build_pianoid_cuda.bat` / `build_pianoid_basic.bat` or `copy_installation_to_core.bat` (old copies, see
[conflicts](#conflicts)); wrapping the build in `vcvars64.bat` (causes `0xC0000142`).

**Build failures** ([BUILD_SYSTEM → Troubleshooting](../architecture/BUILD_SYSTEM.md#troubleshooting),
[STARTUP_TROUBLESHOOTING → Build Failures](STARTUP_TROUBLESHOOTING.md#build-failures)):

| Symptom | Fix (user) |
|---|---|
| `[ERROR] File is locked` / `[WinError 5] Access is denied` | stop the holder (step 1), rerun the heavy build |
| exit `3221225794` (0xC0000142) | delete `%TEMP%\pip-build-env-*`, `PianoidCore\.venv\Scripts\python -m pip cache purge`, rerun; no `vcvars64.bat` in the shell |
| `LNK1181: cannot open input file 'SDL3.lib'` | SDL3 at `C:\SDL3-<version>\` with `include\` + `lib\x64\`, or set `SDL3_DIR`; diagnose with `.venv\Scripts\python detect_paths.py --project-root pianoid_cuda --out NUL` in PianoidCore |
| `nvcc` not found / MSVC not found | install CUDA 12.6 / VS 2022 Build Tools C++ (`setup-packages.bat` options 1 or 3), or set `CUDA_PATH` |
| `PTXAS BUDGET EXCEEDED` | a kernel exceeds its register budget: a code problem, report it (do not work around) |
| `import pianoidCuda_debug` fails, or a debug-only fix "has no effect" | debug-variant DLL trap: build release first or `--both` |
| a code change has no effect after a rebuild | stale `.pyd` (a `pip install` instead of the script) or the debug trap; heavy `--both` |

## Symptoms -> procedure {#symptoms}

Read first, then name the procedure. If the user is chatting with the assistant, the launcher and the UI are
already running (the assistant service is the launcher's child), so "stuck at start" is either the start window
before the UI appeared (the user describes it) or the backend start after APPLY (readable).

| Symptom | Read first | Procedure |
|---|---|---|
| start window seems stuck **before the UI** | ask what the window shows last | "Checking for updates": up to 8 s per repo. A pop-up hidden behind other windows (already running stack: 30 s then cancels; CUDA warning: 30 s then continues). The GPU clock **UAC prompt** waiting on the taskbar (accept it; declined = launch anyway). "Updates accepted - running update-repos.bat": a build runs, 5-15 min. "Press any key": bare run or the error path (read the text above it). See [Start](#start). |
| APPLY does nothing / backend does not come up | `launcher.status`, `system.health` | backend log `PianoidCore\logs\backend_stdout.log` (a `[launcher …] killed PID(s)` line = a kill, not a crash); [Backend Startup Failures](STARTUP_TROUBLESHOOTING.md#backend-startup-failures). "Address already in use" on :5000: with the UI up, cmd `curl -X POST http://127.0.0.1:3001/api/kill-stale` (kills only what is on :5000 / :5001), then APPLY; a non-Pianoid program on the port: `netstat -ano` shows the PID listening on `:5000` ([Port Conflicts](STARTUP_TROUBLESHOOTING.md#port-conflicts)). `tools\kill_pianoid.ps1` stops the WHOLE stack (launcher, UI and the assistant too): use it only to start over, then relaunch with the icon |
| backend error / traceback / `AttributeError` right after an update | `ops_status` (`cuda_rebuild_needed`, `basic_rebuild_needed`) | the rebuild gate: [Rebuild](#rebuild), then APPLY |
| "updates available" pop-up, or `ops_status` `behind` > 0 | `ops_status` | [Update](#update) |
| dropouts / latency return after every reboot | `system.environment` (GPU) | GPU clock lock: accept the UAC prompt at the next launch, or PowerShell `tools\gpu_rt_config.ps1 -Status` (no Admin) / `-Apply` (Admin); [GPU clock lock](STARTUP_TROUBLESHOOTING.md#gpu-clock-lock) |
| "no CUDA device" / "NVML not found" / CUDA broken | `system.environment` if the backend is up | PowerShell in PianoidInstall `powershell -NoProfile -ExecutionPolicy Bypass -File diagnose-cuda.ps1` (verdict + fix); display driver: `install-gpu-driver.bat` (Admin, reboots); [NVML not found](STARTUP_TROUBLESHOOTING.md#symptom-nvidia-smi-reports-nvml-not-found-gpu-visible-but-cuda-fails) |
| "< 60 SMs" warning | — | full-keyboard 58-block presets may not launch; use a `*_56SM` preset ([QUICK_START](QUICK_START.md#no-prompt-launch-desktop-shortcut-update-check)) |
| `npm run dev` fails | `ops_status` (`npm_ci_needed`) | `node --version` must be 20.x; in PianoidTunner remove `node_modules`, `npm ci` (or `npm install`); "Plugin react was conflicted": `PianoidTunner\.env` must contain `DISABLE_ESLINT_PLUGIN=true` |
| the Assistant pane cannot start the service, or says "not connected" | `launcher.assistant.status` (`lastError`) | "assistant dependencies missing": `npm install` in `tools\pianoid-assistant`; not connected: the **Connect Claude subscription** button ([Assistant setup](#assistant-setup)) |
| the Connect panel says "The Claude Code CLI was not found" (older builds: "… not found on PATH") | the pane's own message (it names the fix) | cmd: `cd <PianoidInstall>\tools\pianoid-assistant`, `npm install`, then restart the assistant (**Start assistant**). The service runs the CLI bundled with the Agent SDK (`node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`), so no global `claude` is needed. Builds before dev-5293 required `claude` on PATH: pull PianoidInstall first. |
| a change "has no effect" after a rebuild | `ops_status` (engine build times) | [Rebuild](#rebuild) failure table, last two rows |
| first install on a new machine | — | [New machine install](#new-machine) |

## Gotchas {#gotchas}

| Gotcha | What happens | Source |
|---|---|---|
| `pip install --force-reinstall pianoid_cuda/` | "Successfully installed" but the `.pyd` can be a stale cached one; the edit never lands | [BUILD_SYSTEM → Why pip install directly is not safe](../architecture/BUILD_SYSTEM.md#why-pip-install-directly-is-not-safe) |
| a running backend holds the `.pyd` | the heavy build's uninstall fails, the venv is left without `pianoidCuda` | [BUILD_SYSTEM → Before any rebuild](../architecture/BUILD_SYSTEM.md#before-any-rebuild-check-for-locked-files), [PROJECT_CONFIG → Build holders](../PROJECT_CONFIG.md#build-holders) |
| `VIRTUAL_ENV` set to another venv (or empty but defined) | the build installs into the wrong Python | [BUILD_SYSTEM → Venv Location](../architecture/BUILD_SYSTEM.md#venv-location-always-pianoidcorevenv) and the canonical block |
| `--debug` alone / `PIANOID_BUILD_VARIANT=debug` | skips the DLL copy; the debug import fails and the middleware silently falls back to release | [BUILD_SYSTEM → Debug variant DLL trap](../architecture/BUILD_SYSTEM.md#debug-variant-dll-trap) |
| release-only builds | `build_pianoid_cuda.bat` without `--both` leaves `pianoidCuda_debug` stale | `build_pianoid_cuda.bat` (`BUILD_VARIANT=release` default) + the canonical block |
| a header edit with `--light` | incremental mode does not track `.cuh` / `.h`: the change is not compiled | [BUILD_SYSTEM → CUDA Compilation](../architecture/BUILD_SYSTEM.md#cuda-compilation-nvcc) |
| the PianoidBasic build rewrites its own sources | `setup.py` rewrites the `# Package imports` block of every `Pianoid/*.py` (relative for the wheel, then back), writing Windows line endings and dropping trailing blank lines: the checkout shows changes after a build, which can block the next `git pull`. A `from` import that spans lines or sits outside the block breaks the installed wheel | `PianoidBasic/setup.py` (`CustomBuildCommand`); session logs dev-029c / dev-5bf7 (archive) |
| the wrong Python | `ImportError: No module named pianoidCuda` / `Pianoid` | [PROJECT_CONFIG → Interpreters](../PROJECT_CONFIG.md#interpreters) |
| `~`-prefixed folders in `site-packages` (`~ianoidcuda-0.1.0.dist-info`, `~andas`) | left by an earlier pip uninstall that did not finish; pip skips them with "Ignoring invalid distribution". Not a rebuild reason on their own (measured 2026-10-18: present next to a working `pianoidCuda`); what counts is whether the imports and APPLY work | `ops_status` `leftovers`; measured on the main machine |
| the GPU clock lock | lost at every Windows restart; re-applied at launch (one UAC per boot) | [GPU clock lock](STARTUP_TROUBLESHOOTING.md#gpu-clock-lock) |
| blanket kills | `taskkill /IM python.exe` / `node.exe` kill unrelated programs | [STARTUP_TROUBLESHOOTING → Port Conflicts](STARTUP_TROUBLESHOOTING.md#port-conflicts) |
| a backend started by hand on :5000 | an open UI tab kills it on its next APPLY / reconnect (`/api/kill-stale`) | [Three-Process Architecture](STARTUP_TROUBLESHOOTING.md#three-process-architecture) |

## Assistant setup {#assistant-setup}

Source: `tools/pianoid-assistant/README.md` (Setup, First-time setup, Analysis sandbox, Isolation), `PianoidTunner/server/launcher.js`.

1. **Dependencies:** cmd, `cd <PianoidInstall>\tools\pianoid-assistant`, `npm install` (Node 20+; `setup-pianoid.bat`
   does it on a new machine). Again after a PianoidInstall pull that changed its `package.json` / `package-lock.json`.
2. **Connect the Claude subscription (once):** the assistant runs on the user's Claude subscription in its OWN Claude
   home (`%USERPROFILE%\.pianoid-assistant\claude-home`, never `~/.claude`). While that home is not logged in, the
   Assistant pane shows "Claude subscription not connected" with a **Connect Claude subscription** button (the chat
   input is disabled). Click it, then **Open Claude login**: sign in with the Claude account in the new browser tab;
   the pane switches to connected by itself (the header chip shows email · plan; its menu has **Disconnect**, which
   logs out the isolated home only). If the sign-in page shows a code instead, use "The sign-in page shows a code
   instead?" and paste it. No global `claude` CLI needed: the service runs the CLI bundled with the Agent SDK
   (installed by step 1), else `claude` on PATH (override `PIANOID_ASSISTANT_CLAUDE_CLI`). With neither, the pane says
   "The Claude Code CLI was not found" and names the fix (step 1, then restart the assistant). Terminal fallback ("Or
   sign in from a terminal" in the pane, which shows the command with the CLI the service found), PowerShell:
   `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.pianoid-assistant\claude-home"; & "<PianoidInstall>\tools\pianoid-assistant\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe" auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`.
   Source: `tools/pianoid-assistant/README.md` "First-time setup: connect the Claude subscription" (dev-dc2a). The
   service refuses to start while `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set (it would bill the paid API).
3. **Start:** the pane's **Start assistant** button (`launcher.assistant.start`, asks); the service listens on
   127.0.0.1:3002.
4. **Analysis sandbox (once, optional, for analysis code):** `node analysis\setup.js` in `tools\pianoid-assistant`
   (builds `sandbox\launcher\PianoidSandbox.exe`, creates the AppContainer profile, grants access to the private
   runtime); the private Python runtime under `%USERPROFILE%\.pianoid-assistant\analysis\runtime` is created with the
   README's PowerShell block. No Admin.

## Doc / script disagreements {#conflicts}

Found 2026-10-18 (dev-6b34) against PianoidInstall master `e3e1f0e` / PianoidCore dev `269efbd`. Unless marked
RESOLVED: tell the user which behaviour they will actually get (the script's) and that the doc differs.

| # | Topic | Doc says | Script does |
|---|---|---|---|
| C1 | updating PianoidInstall | the launch check (`check-updates.ps1`) counts PianoidInstall against `origin/master` and offers `update-repos.bat` | RESOLVED 2026-10-19 (dev-a22b): `update-repos.bat` / `.sh` pull PianoidInstall first and hand over to their own new version. A machine still on the old script needs one manual pull ([Update](#update) step 2) |
| C2 | middleware-only pull | matrix: LIGHT CUDA `--both` | `update-repos.bat` classifies `pianoid_middleware/*.py` as no rebuild. Measured 2026-10-19 (dev-a22b): the middleware runs from the source tree (not in `.venv` site-packages) and `build_pianoid_cuda.bat` builds only `pianoid_cuda/` + `sdl_audio_core/`, so the script is right and the matrix row is over-cautious (light build = no effect on the middleware) |
| C3 | PianoidBasic change | matrix / gate table: Basic build, + CUDA only if `.cu/.cpp` changed | RESOLVED 2026-10-19 (dev-a22b): `update-repos.bat` / `.sh` follow the matrix (Basic build only; the CUDA build does not read PianoidBasic) |
| C4 | Tunner dependency change | matrix and STARTUP_TROUBLESHOOTING: `npm install` | `setup-pianoid.bat`: `npm ci`. `update-repos.bat` / `.sh`: `npm install` since 2026-10-19 (dev-a22b) |
| C5 | which branch is pulled | `check-updates.ps1` compares `HEAD` with the integration branch | RESOLVED 2026-10-19 (dev-a22b): `update-repos.bat` / `.sh` pull `origin/<integration>` and skip, with a warning, a repo on another branch |
| C6 | default build variant | canonical block: "default variant = `--both`" | `build_pianoid_cuda.bat` defaults to `--heavy` + **release** only (its usage text says so); BUILD_SYSTEM "Building variants" agrees with the script |
| ~~C7~~ | `sdl_audio_core` | RESOLVED 2026-10-19 (dev-db3c): dev-4284 is merged (Core dev 68615df); `sdl_audio_core/` is gone and the HEAVY build only uninstalls a stale copy (`[CLEANUP]`) | matches |
| C8 | root `build_pianoid_cuda.bat` / `build_pianoid_basic.bat` | BUILD_SYSTEM: "thin launcher wrappers" | full old copies that expect `pianoid_cuda\` and `.venv` in the repo root; `copy_installation_to_core.bat` copies them over the canonical PianoidCore scripts (and a missing `build_pianoid_complete.bat`) |
| C9 | SDL install folder | QUICK_START: `C:\SDL2` and `C:\SDL3` | `setup-dev.ps1`: `C:\SDL2-<version>` / `C:\SDL3-<version>` (what `detect_paths.py` searches for) |
| C10 | `/auto` and an already-running stack | the comment in `start-pianoid.bat`: warns and proceeds | `check-running-servers.ps1` (and QUICK_START): a timed 30 s pop-up; timeout = Cancel = no launch |
| C11 | what `/api/kill-stale` kills | STARTUP_TROUBLESHOOTING Port Conflicts: also any process whose command line has `backendserver.py` (wmic) | the dev-7bb0 note in the same guide: only its own ports and its own absolute script path |
| C12 | VIRTUAL_ENV | BUILD_SYSTEM Venv section: `unset VIRTUAL_ENV && … --heavy --release` | the canonical block and `update-repos.bat`: set it explicitly to `PianoidCore\.venv`, and `--both` (both forms avoid the empty-but-defined trap) |
| C13 | port 3002 | PROJECT_CONFIG: 3002-3020 are agent spare ports | the assistant service listens on 3002 by default (`PIANOID_ASSISTANT_PORT`) |
| C14 | `setup-config.json` | QUICK_START example: patch versions (`3.12.0`, `12.6.0`, `20.18.0`) | the committed file uses `3.12`, `12.6`, `20` (BUILD_SYSTEM explains why) |

## Sources

Docs: [QUICK_START](QUICK_START.md), [STARTUP_TROUBLESHOOTING](STARTUP_TROUBLESHOOTING.md),
[BUILD_SYSTEM](../architecture/BUILD_SYSTEM.md), [PROJECT_CONFIG](../PROJECT_CONFIG.md), [LINUX_BUILD](LINUX_BUILD.md).
Scripts (PianoidInstall root): `start-pianoid.bat`, `check-running-servers.ps1`, `check-updates.ps1`,
`check-cuda.ps1`, `check-gpu-clock.ps1`, `update-repos.bat`, `setup-packages.bat`, `setup-dev.ps1`,
`setup-pianoid.bat`, `clone-packages.bat`, `make-shortcut.bat`, `diagnose-cuda.ps1`, `install-gpu-driver.bat`,
`install-git.bat`, `copy_installation_to_core.bat`, `tools\kill_pianoid.ps1`, `tools\clean_and_start.ps1`,
`tools\gpu_rt_config.ps1`. PianoidCore: `build_pianoid_cuda.bat`, `build_pianoid_basic.bat`. PianoidBasic:
`setup.py`. Tunner: `server/launcher.js`, `package.json`. Assistant: `tools/pianoid-assistant/README.md`,
`schemas/commands/launcher.json`.
