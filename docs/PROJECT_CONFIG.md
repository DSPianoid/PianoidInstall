# Pianoid Project Configuration — Single Point of Truth

**Status:** Operational-facts SSOT (created 2026-06-11, P0 Stage 2).
**Purpose:** The ONE canonical home for project-specific operational facts that were previously copy-pasted across the `.claude/commands/*.md` skills (and drifted — the `--heavy --release` build-command divergence across 11 skills). Skills and `CLAUDE.md` **reference the stable anchors below** instead of inlining these facts. A change here changes every consumer; there is no second copy to forget.

> **What lives where (the SSOT layering):**
> - **The build** is authoritative in [`docs/architecture/BUILD_SYSTEM.md` → Canonical Install / Rebuild](architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first). This page *summarizes + links* it; it never restates the full procedure.
> - **These operational facts** (ports, interpreters, repos, preset, endpoints, rebuild matrix, doc-hierarchy, verification routing, the docs-first bullets) are authoritative **here**.
> - **The port-scoped kill** is authoritative as an executable: `tools/dev-pipeline/env_sweep.py`.
> - **Rules** that reference these facts live in `.claude/CLAUDE.md`.
>
> A drift-guard lint (`tools/dev-pipeline/lint_skills.py`) fails CI if a skill re-inlines the forbidden build form or duplicates a block this page owns.

---

## Ports {#ports}

The Pianoid stack uses four ports. Kill **only** processes bound to these (PID-targeted, never blanket `//IM python.exe`/`//IM node.exe` — see [Process sweep](#process-sweep)).

| Port | Role | Started by |
|------|------|-----------|
| **3000** | React frontend (PianoidTunner dev server) | `npm run dev` / `npm start` |
| **3001** | Node.js launcher (backend process manager; REST on `/api/*`) | `npm run dev` only |
| **5000** | Flask backend (pianoid_middleware + CUDA engine) | launcher APPLY / `python backendserver.py` |
| **5001** | Modal adapter backend | `modal_adapter/modal_adapter_server.py` |

The full clearance sweep targets exactly `3000 3001 5000 5001`.

## Interpreters (per-OS) {#interpreters}

The project's **only** venv is `PianoidCore/.venv/` (never the repo-root `.venv/`, never system Python). A stray binary from any other venv is silently stale at the C++ API level → runtime `AttributeError`; rebuild rather than cross-fetch.

| OS | Venv Python |
|----|-------------|
| Windows | `PianoidCore/.venv/Scripts/python.exe` |
| Linux | `PianoidCore/.venv/bin/python` |

## Repository roots + branches {#repos}

The repo lives at different absolute paths per machine — use **repo-relative paths**; apply the OS prefix below only when an absolute path is unavoidable.

| Repo | Repo-relative path | Integration branch |
|------|--------------------|--------------------|
| PianoidInstall (root: docs, skills, config) | `.` | `master` |
| PianoidCore (Flask + CUDA engine) | `PianoidCore` | `dev` |
| PianoidBasic (domain model) | `PianoidBasic` | `dev` |
| PianoidTunner (React frontend) | `PianoidTunner` | `dev` |

| OS | Repo root |
|----|-----------|
| Windows | `D:\repos\PianoidInstall` |
| Linux | `/media/leonid-astrin/New Volume/repos/PianoidInstall` |

## Defaults {#defaults}

| Setting | Default | Notes |
|---------|---------|-------|
| Preset | `presets/BaselinePreset1.json` | path relative to `pianoid_middleware/` |
| `audio_driver_type` | `4` (ASIO Callback) | `0` default · `1` ASIO · `2` SDL2 · `3` SDL3 · `4` ASIO Callback. ASIO→SDL3 auto-fallback exists on `dev`. |
| `start_right_away` | `1` (start in bg thread) | `0`/`3` = init only |

Full `POST /load_preset` parameter table: [`REST_API.md`](modules/pianoid-middleware/REST_API.md).

## Key REST endpoints {#rest-endpoints}

The full surface is documented in [`docs/modules/pianoid-middleware/REST_API.md`](modules/pianoid-middleware/REST_API.md) (and the `/pianoid-ui` skill carries the interaction-level map). The load-bearing few:

| Endpoint | Port | Purpose |
|---|---|---|
| `POST /api/start-backend` | 3001 | launcher spawns the Flask backend (no harness gate — preferred startup) |
| `POST /api/stop-backend` | 3001 | graceful shutdown + force kill (use BEFORE a `--heavy` build to release the `.pyd`) |
| `POST /api/kill-stale` | 3001 | kill anything on port 5000 |
| `GET /health` | 5000 | engine lifecycle status |
| `POST /load_preset` | 5000 | initialize engine from a preset (the post-rebuild **L2 smoke-test**: expect 200, no traceback) |
| `POST /get_chart_test` | 5000 | render a chart (e.g. `note_playback` deterministic offline render — the audio_off verification surface) |
| `POST /capture` | 5000 | force extraction of the current result buffer |

## Rebuild decision matrix {#rebuild-matrix}

Which build to run for a given change (the canonical *procedure* — detached `Start-Process`, stop-holder-first, `--both` — is [`BUILD_SYSTEM.md`](architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first); see also [Docs-first for build + run](#docs-first-build--run)).

| Changed files | Build |
|---|---|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py`, `detect_paths.py`, `build_config.json` | **HEAVY** CUDA `--both` |
| any `PianoidBasic/**` | PianoidBasic build (`build_pianoid_basic.bat`) (+ HEAVY CUDA if a `.cu/.cpp` also changed) |
| `pianoid_middleware/*.py` only | **LIGHT** CUDA `--both` |
| `PianoidTunner` `package.json` / `package-lock.json` | `npm install` |
| `tests/**` or `docs/**` only | no rebuild |

**Post-merge / post-pull rebuild gate (BLOCKING):** if a merge/pull brought in any compiled diff above, REBUILD `--both` and run the `/load_preset` **200** smoke-test BEFORE pushing or declaring ready — import-verify alone passes even when the Python↔C++ API diverged.

## Doc-hierarchy entry points (Documentation-First) {#doc-hierarchy}

Read docs **top-down before source**, stopping when you have enough context (the Documentation-First rule; the doc hierarchy IS the context):

1. `docs/index.md` — module map, entry point
2. `docs/architecture/SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `docs/architecture/DATA_FLOWS.md` — trace the relevant data flow
4. the specific module doc under `docs/modules/` (`pianoid-cuda/` · `pianoid-middleware/` · `pianoid-basic/OVERVIEW.md` · `pianoid-tunner/OVERVIEW.md`)
5. `docs/development/TESTING.md` — test inventory
6. `docs/guides/UI_TESTING.md` / `docs/guides/STARTUP_TROUBLESHOOTING.md` — when live UI / startup is involved
7. `docs/development/WORK_IN_PROGRESS.md` — active investigations

## Verification-surface routing {#verification-surfaces}

A change to output X is verified on the surface that *observes* X, with measured before/after evidence (the Audio Verification Rule, generalized).

| Change class | Surface | Mode | Skill |
|---|---|---|---|
| **Synthesis-output** (volume, excitation, physical params, hammer, kernel coefficients — anything that changes the offline-rendered waveform) | `note_playback` deterministic offline render (buffer-vs-buffer) | `audio_off` | `/test-ui` |
| **Mic-engaging** (calibration, `MicAnalyzer`, `measurement_engine`, mic capture path, `/calibrate_volume` family) | mic recording vs synth (Goertzel transferRatio) | `audio_on` | `/diagnose` (Phase 7; requires `_MIC_LOOPBACK_CONFIGURED=True` + speaker→mic loopback) |

Binary contract details: [`docs/development/TESTING.md`](development/TESTING.md).

## Process sweep {#process-sweep}

Kill **only** processes that are LISTENING on the four Pianoid ports — never by image name (`taskkill //IM python.exe` / `node.exe` kills MCP servers, Chrome DevTools, and Claude Code itself). The canonical, structurally-safe form is the executable:

```bash
python tools/dev-pipeline/env_sweep.py            # port-scoped kill (3000/3001/5000/5001) + verify free + per-repo git status
python tools/dev-pipeline/env_sweep.py --no-kill  # inspect only
```

`env_sweep.py` can ONLY kill PIDs discovered as listeners on those four ports (the safety invariant is encoded in code — there is no path to kill by name). Use it instead of hand-pasting a `for port in … taskkill` loop. (Cross-platform: Windows `Get-NetTCPConnection`→`Stop-Process`; Linux `lsof`/`ss`→`kill`.)

## Docs-first for build + run (MANDATORY) {#docs-first-build--run}

**The single canonical copy of the docs-first build/run discipline.** Every rebuild, install, or server restart starts by reading the canonical docs — NOT by typing `pip install`. Skipping this burned ~3h on 2026-04-23 when a stale `.pyd` masqueraded as a working rebuild. The 5 load-bearing facts:

1. **Read the docs first.** Before any CUDA build: [`docs/architecture/BUILD_SYSTEM.md`](architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first) + `docs/guides/QUICK_START.md`. Before starting the backend: `docs/guides/QUICK_START.md` + [`docs/modules/pianoid-middleware/REST_API.md`](modules/pianoid-middleware/REST_API.md). On any startup/build failure: `docs/guides/STARTUP_TROUBLESHOOTING.md`.
2. **Canonical rebuild = `--heavy --both`** (default `--both`; release-only leaves the debug `.pyd` stale → silent symbol error). `cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both`. **In agent context use the detached `Start-Process` form** (absolute bat path after `cd /d`, and **stop the `.pyd` holder first** via launcher REST `POST /api/stop-backend`) — `cmd //c … --heavy` in agent context removes the `.pyd` before reinstall and **bricks the venv**. Full procedure: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first). **NEVER substitute** `pip install --force-reinstall --no-cache-dir pianoid_cuda/` — it silently reinstalls the STALE `.pyd` and your edit never lands.
3. **Debug-variant trap.** `PIANOID_BUILD_VARIANT=debug` alone does NOT copy the CUDA DLLs; run release first (or `--both`). Missing DLLs surface as import errors that look like build failures.
4. **Verify the rebuild landed.** `grep -a "<a string you just added>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`. If your marker is absent, nothing changed — do NOT run tests. (L1: `import pianoidCuda` resolves inside `PianoidCore/.venv/`. L2: `POST /load_preset` → 200, no traceback — the API-divergence check that import-verify misses.)
5. **On unexpected build or startup failure → invoke `/startup`** rather than ad-hoc troubleshooting. `/startup` is the authoritative install/build/startup reference.

> Skills reference this section (`PROJECT_CONFIG.md#docs-first-build--run`) instead of restating it — that is what prevents the build-command drift from recurring.

## Key Paths {#key-paths}

All repo-relative (apply the OS prefix from [Repos](#repos) when an absolute path is unavoidable). This is the consolidated path table the skills reference instead of each carrying their own `## Key Paths`.

| Resource | Path |
|----------|------|
| PianoidCore (Flask + CUDA engine) | `PianoidCore` |
| PianoidBasic (domain model) | `PianoidBasic` |
| PianoidTunner (React frontend) | `PianoidTunner` |
| Documentation | `docs/` |
| MkDocs config | `mkdocs.yml` |
| MkDocs preview | `http://localhost:8001/` |
| Session logs | `docs/development/logs/` |
| Log archive | `docs/development/logs/archive/` |
| Module locks | `docs/development/MODULE_LOCKS.md` |
| Work-in-progress | `docs/development/WORK_IN_PROGRESS.md` |
| Code-quality / God-objects | `docs/development/CODE_QUALITY.md` |
| Performance tests | `PianoidCore/tests/system/test_performance_audio_off.py` |
| Audio-driver tests | `PianoidCore/tests/system/test_audio_drivers.py` |
| venv Python | `PianoidCore/.venv/Scripts/python` (Win) · `PianoidCore/.venv/bin/python` (Linux) — see [Interpreters](#interpreters) |
| Build script (CUDA) | `PianoidCore/build_pianoid_cuda.bat` (Win) · `build_pianoid_cuda.sh` (Linux) |
| Build script (Basic) | `PianoidCore/build_pianoid_basic.bat` |
| Default preset | `presets/BaselinePreset1.json` (relative to `pianoid_middleware/`) — see [Defaults](#defaults) |

## Frontend stack {#frontend-stack}

The frontend (PianoidTunner) design system + conventions. Skills/`CLAUDE.md` reference this instead of restating it.

- **React 18 + MUI v6** (Material UI) — ALL UI uses MUI, never Tailwind/shadcn/CSS-utility frameworks.
- **Emotion** (`@emotion/react`, `@emotion/styled`) — MUI's styling engine; `sx` for one-offs, `styled()` for reusables; never inline `style` objects; never standalone CSS/SCSS.
- **ECharts 5** (`echarts-for-react`) — ALL data viz (stabilization diagrams, charts, heatmaps); no other charting libs. Respect the dark theme (`backgroundColor: 'transparent'`, palette colors).
- **Socket.IO** — real-time WS to the Flask backend. **react-mosaic-component** — tiling window manager (panes need a `MosaicWindow` wrapper + title). **CRA** (`react-scripts 5.0.1`) — build toolchain.
- **Theme:** MUI **dark** (`mode: 'dark'`) always — dense, information-rich, muted blues/teals, compact (`dense`, `size="small"`), tabular-nums for numerics, high-contrast controls, no decorative elements / gradients / neon / animation libs.
- **Conventions:** use `useTheme()`/`theme.palette` (never hardcode hex); use `context7` MCP to fetch current MUI v6 docs before any MUI API (v6 has v5 breaking changes — `Grid2`, pigment-css); numeric inputs use the existing `NumInput` (`src/components/NumInput/NumInput.js`) — don't create new ones; parameter editors = optimistic update + 300ms-debounced API via `usePreset`; icon-only buttons need `aria-label`; sliders need units+value (`valueLabelDisplay="auto"`); color is never the only indicator.

## Team {#team}

| Item | Value |
|---|---|
| Agent-team name | `pianoid-dev` (the orchestrator's `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` team) |

## Channel {#channel}

The orchestrator's control + I/O channel(s).

| Item | Value |
|---|---|
| Primary channel | Telegram (`mcp__plugin_telegram_telegram__*`) — inbox queue under `~/.claude/channels/telegram/inbox/` |
| Inbox patch | `python tools/apply_telegram_patch.py` (file-queue; the plugin drops inbound msgs without it) |
| Voice in (STT) | `PianoidCore/.venv/Scripts/python tools/transcribe_voice.py <audio>` (faster-whisper) |
| Voice out (TTS) | `py -3 tools/tts_voice.py "<text>"` (edge-tts → `.ogg`); voice patch `python tools/apply_telegram_voice_patch.py` |
| Optional channels | Email (`hostinger-email` MCP), WhatsApp (`whatsapp` / `whatsapp-work` MCP) — activate on request |
| CLI keystroke control | `tools/cli_control.ps1` (drives the orchestrator's own VS Code/CLI window; transcripts under `~/.claude/projects/D--repos-PianoidInstall/`) |

## Build holders {#build-holders}

Native binaries that, when held open by a process, block a rebuild (`[WinError 5] Access is denied` → failed uninstall → broken venv). Stop the holder FIRST (launcher REST `POST /api/stop-backend`, else a PID-targeted kill — never `//IM python.exe`).

| Holder | Find holders (Windows) | Find holders (Linux) |
|---|---|---|
| `pianoidCuda.cp312-win_amd64.pyd` (release) / `pianoidCuda_debug.cp312-win_amd64.pyd` (debug) | `tasklist //M pianoidCuda.cp312-win_amd64.pyd` | `lsof PianoidCore/.venv/lib/python3.12/site-packages/pianoidCuda*.so` |
| `cudart64_12.dll` (CUDA runtime) | `tasklist //M cudart64_12.dll` | — |

## MIDI listener flag {#midi-flag}

| Item | Value |
|---|---|
| `listen_to_midi` | `POST /load_preset` param; `0` = no MIDI listener (default for tests), `1` = start the MIDI listener on load |
| Cascade caveat | Pre-2026-05-10 baselines have a listener-cascade bug (a crashed listener thread leaves `self.listen=True`, silently dropping all `play` click frames). On current dev this is fixed; if a stack shows "no sound + no log entry", APPLY with `listen_to_midi=0`. |

## Data-model facts — high-stakes inference categories {#data-model-facts}

When a fix/diagnosis depends on any of these data-model facts, source-code inference alone is NEVER sufficient — the fact MUST have explicit doc support, or be measured against the live engine and written to docs BEFORE use (the Data Model Card gate). The categories (Pianoid-specific instances of the generic "high-stakes inference" rule):

- **Axis semantics** — which dimension is pitch / channel / mode / string / block; transposed views (Python row-major vs CUDA column-major; the frontend strings-axis 128 offset).
- **Dimension ordering** — `[pitch][channel]` vs `[channel][pitch]`, `[mode][pitch]` vs `[pitch][mode]`. C++ `arr[i][j]` syntax is not enough; the *semantic* axes need a doc.
- **Index conventions** — 0- vs 1-based; piano pitches `0–127` vs output pitches `128–139`; channel offsets; sentinels (`-1` dummy mode, `127` damper-open).
- **Stored vs effective entries** — a struct may store N rows but the kernel consumes only K (e.g. `string_coefficients[p][c]` is 140-pitch × num-channels but only output-pitch rows 128–N are read). Know K, not N.
- **Unit ranges** — 0–1 normalised vs raw FFT magnitudes (~1e-4); ms vs samples; MIDI velocity 0–127 vs 0.0–1.0; volume_coefficient 0–1 vs dB; tension N vs N/m².
- **"Same name, different thing" pairs** — `deck` (Python per-pitch coupling array) vs `deck` (CUDA `dev_deck_parameters` matrix); `sound_channel` (modes-coupling) vs `string_sound_channel` (strings gain); `feedin`/`feedback` (modes path vs strings path).

Authoritative module docs for these: `docs/modules/pianoid-cuda/*.md`, `docs/architecture/DATA_FLOWS.md`.

---

> **This page is the COMPLETE project-config SSOT.** Every project-specific fact a skill needs has an anchor here. The generic (project-agnostic) skills resolve `<active-project>/docs/PROJECT_CONFIG.md` and reference these anchors — they inline none of these facts. New project facts that >1 skill needs get a new anchor here, never a second inline copy. The drift-guard lint (`tools/dev-pipeline/lint_skills.py`) enforces it.
