# Pianoid Project Instructions

## Orchestrator Sub-Agent Permission Rule (MANDATORY)

When operating in `/orchestrator` mode (the user is on Telegram, not watching the CLI), **every** `Agent` tool call MUST include `mode: "bypassPermissions"`. This is non-negotiable.

**Why:** Permission prompts from sub-agents are rendered only in the local CLI window. The Telegram user cannot see or approve them. Without `bypassPermissions`, any sub-agent tool call that hits an unallowed tool stalls silently — the agent waits, the orchestrator sees an unresponsive teammate, and the user sees nothing. This has burned multiple sessions (chrome-devtools incident, Skill(test-ui) incident on 2026-04-30, backend-startup incident on 2026-05-01). Pre-allowing tools in `settings.local.json` is whack-a-mole — every new MCP server, every new deferred tool, every new skill becomes a fresh trap.

**How to apply:**
- Every `Agent({...})` dispatch from the orchestrator includes `mode: "bypassPermissions"`. No exceptions, including team agents (`team_name: "pianoid-dev"`).
- This applies to `/dev`, `/analyse`, `/update-docs`, `/test-ui`, `/pianoid-ui`, Explore, general-purpose — all sub-agent types.
- **Transitive — sub-agents that spawn sub-sub-agents must also pass `mode: "bypassPermissions"`.** Example: a `/dev` agent that spawns a `/fn` sub-agent must include `mode: "bypassPermissions"` on the nested `Agent({...})` call. Otherwise the `/fn` sub-agent runs at default permission and any tool call it makes that hits an unallowed gate triggers a CLI prompt the Telegram user cannot see.
- The orchestrator session itself stays under normal permission rules (the user IS at the CLI for orchestrator output, even if they read it via Telegram). Only sub-agents get bypass.
- The `/dev` workflow's own safeguards (Step 0 logs, MODULE_LOCKS.md, branch isolation, mandatory pre-Step-10 stop and report) provide the human-in-the-loop checkpoint — `bypassPermissions` removes the harness gate, not the workflow gate.

**Known gaps in `bypassPermissions` (still trigger CLI prompts even when set):**

- **Team sub-agents are governed by the project allow-list, NOT by the spawn's `bypassPermissions` — THE dominant gap.** For agents spawned with `team_name` (the orchestrator's `pianoid-dev` team), `mode: "bypassPermissions"` on the spawn does NOT fully suppress permission prompts — the `permissions.allow` list in `.claude/settings.local.json` governs. Any tool/command NOT matched there triggers a CLI prompt that renders only in the local terminal (invisible to the Telegram user) → silent stall. **Fix: `permissions.allow` MUST blanket-allow BOTH shells — `Bash(*)` AND `PowerShell(*)` — plus the core tools** (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `Skill`, `SendMessage`, `Monitor`, `ToolSearch`, the `Task*` tools, MCP servers). Adding *specific* command patterns (e.g. `PowerShell(Start-Process ... cfl-build.log ...)`) is whack-a-mole — agents vary the command (log filenames, `$(...)` PID syntax) so each variant misses the exact match and re-prompts. This was the dominant failure of the 2026-05-25 session: PowerShell build commands kept prompting because only `Bash(*)` was blanket-allowed, not `PowerShell(*)`. The orchestrator verifies + repairs this at startup (orchestrator.md Step 0 "Permission allow-list").
- **Long-running process Bash invocations.** Starting the backend (`cmd //c start-pianoid.bat`, `python backendServer.py` via `Bash run_in_background: true`), the npm dev server, or any Bash command that spawns multiple child processes hits the harness's "long-running process" detector which gates regardless of permission mode. Hit by `dev-modal-b3` 2026-05-01 trying to start the backend mid-session.
  - **Workaround:** spawn detached background processes via `PowerShell Start-Process -WindowStyle Hidden` with redirected output. This bypasses the bash tool's process management AND avoids the long-running-process gate. Bonus: PowerShell-spawned background processes also survive longer than `Bash run_in_background: true` ones (which the bash tool's process management has been observed to reap after ~2 minutes).
  - Alternative: pre-allow specific Bash patterns in `settings.local.json` (e.g. `Bash(cmd //c start-pianoid.bat)`) — but this is the whack-a-mole pattern the broader `bypassPermissions` was meant to replace, and it still doesn't help with `Bash run_in_background: true` semantics.
- **Bash that opens a TTY/interactive prompt** — anything that expects keyboard input (e.g. `git rebase -i`, `python` REPL, `gcloud auth login`) gates regardless of mode. Avoid; route through the user via the `! <command>` prompt prefix if truly needed.
- **Some `taskkill` patterns on system PIDs** — observed inconsistently. If `taskkill //F //PID <pid>` prompts, try `//T` (kill tree) or scope by image name (`taskkill //F //IM <name>`).

## Repository Roots & Path Convention

The Pianoid repo lives at different absolute paths on different machines:

| OS | Repo root |
|----|-----------|
| Windows | `D:\repos\PianoidInstall` |
| Linux   | `/media/leonid-astrin/New Volume/repos/PianoidInstall` |

**Convention used throughout these instructions and the docs:**

1. **Use paths relative to the repo root** wherever possible (e.g. `docs/index.md`, `PianoidCore/.venv/`). The reader applies the absolute prefix for their OS.
2. **Use absolute paths only** when the working directory is unknown or the command is run outside any cwd (background services, MCP server entries, registry-style references).
3. **OS-specific binaries and scripts** (`.bat`, `.exe`, `tasklist`, `taskkill`, `cmd //c`) are flagged inline and given Linux equivalents wherever a Linux port exists. Build infrastructure that has not been ported to Linux is marked **(Windows only)**.
4. **Shell snippets assume cwd is the repo root** unless the snippet itself contains a `cd`. When in doubt, prepend `cd <repo-root>` (use the OS-specific value from the table above) before running. Compound commands like `cd PianoidCore/foo && ../.venv/Scripts/python …` chain relative paths from the new cwd, not from the repo root.

**Venv interpreter** — the path differs between OSes:

- Windows: `PianoidCore/.venv/Scripts/python.exe`
- Linux:   `PianoidCore/.venv/bin/python`

When invoking the venv Python in commands, use the form for the current OS.

## Auto-Trigger Rules

When the user requests a development task on the Pianoid codebase — bug fix, feature, refactor, optimization, or any code change — automatically invoke the `/dev` skill without waiting for the user to ask for it explicitly. This applies to tasks targeting PianoidCore, PianoidBasic, or PianoidTunner.

**This includes transitions from investigation to implementation.** When a conversation starts as research/analysis but the user then approves implementation (e.g., "yes", "implement this", "go ahead"), invoke `/dev` at that point. Do NOT start writing code without the `/dev` workflow just because the earlier part of the conversation was exploratory.

**Investigation → Implementation handoff inside `/dev` (MANDATORY).** Once a `/dev` agent has been spawned, silently switching from "I asked the user a question" or "I formed a hypothesis" to "I built it on my best guess without an answer" is forbidden. If the agent posed a clarifying question (to the orchestrator, to the user, or in its own scratch notes) and a code edit depends on the answer, the agent MUST pause and wait for the answer — not proceed on assumption. The same rule applies to hypotheses generated during diagnosis: a hypothesis is allowed to drive *more measurement*, never to drive *a code edit*, until it has been confirmed by measurement against the docs. Drift from "researching" to "implementing" without an explicit decision point is the failure mode that produced two wrong fixes in dev-833f Phase A/B (SoundChannels silence bug, 2026-04-30) before the third measurement-based diagnosis succeeded.

**CRITICAL: Any edit to `.cu`, `.cpp`, `.cuh`, `.h`, or `setup.py` files MUST go through `/dev`.** These require CUDA builds that only `/dev` handles correctly.

**Do NOT auto-trigger `/dev` for:**
- Documentation-only updates (use `/update-docs` instead)
- Package updates / git pull (use `/update-pianoid` instead)
- Questions, exploration, or research tasks (until user approves implementation)
- Trivial one-line Python-only fixes where the full workflow would be overkill

**`/fn` skill — single-function development:**
- `/fn` is a lightweight skill for implementing a single function with clear requirements and test criteria
- `/dev` agents should **prefer delegating to `/fn` sub-agents** whenever function-level requirements and testing are feasible (see Step 4b in `/dev`)
- `/fn` can also be invoked directly by the user for small, self-contained changes that don't need the full `/dev` workflow
- When `/dev` spawns `/fn`, the dev agent writes tests first and hands them to the sub-agent. The tests persist in the project test suite
- Documentation and commits always stay at the `/dev` (or user) level — `/fn` never commits or updates docs

## UI Interaction Rule

When the user requests any task that involves the Pianoid frontend interface — viewing parameters, editing excitation/string/mode parameters, playing notes, capturing sound, or any browser-based interaction — automatically invoke the `/pianoid-ui` skill unless the user explicitly instructs otherwise.

## Audio Verification Rule

After completing any code change that affects synthesis output — volume, excitation, physical parameters, hammer shape, or any parameter that influences sound — verify the change with measured evidence before reporting completion. **Do not claim an audio-affecting feature works without a measured before/after comparison.**

**Strict A1 mode routing (see `docs/development/TESTING.md` for the binary contract):**

- **Synthesis-output code change** (volume, excitation, physical params, hammer, kernel coefficients, anything that changes the offline-rendered waveform) — invoke `/test-ui` (audio_off mode). Verification surface is the `note_playback` deterministic offline render. The audio driver is irrelevant to the comparison; only the synthesised buffer matters.
- **Mic-engaging code change** (calibration, `measurement_engine`, `MicAnalyzer`, mic capture path, `assert_synth_reaches_mic`, `/calibrate_volume` family, anything where the test artefact is a mic recording compared against synth) — invoke `/diagnose` with mic Phase 7 enabled (audio_on mode). Requires `_MIC_LOOPBACK_CONFIGURED=True` in `tests/system/conftest.py` and a working speaker→mic loopback.

Follow the canonical live-UI procedure in `docs/guides/UI_TESTING.md` — three-process startup, `note_playback` deterministic sound measurement, reverse-order shutdown. Do not improvise.

## Backend Startup Rule

When the backend server needs to be started and the exact process, preset path, or initialization parameters are unclear, **always consult the documentation first**:

- `docs/guides/UI_TESTING.md` — canonical live-UI startup for tests (launcher + frontend + backend); the launcher-backend-frontend coupling is non-obvious and improvisation causes silent backend kills on APPLY
- `docs/guides/STARTUP_TROUBLESHOOTING.md` — three-process architecture, zombie-socket diagnosis, port-targeted kills, shutdown sequence
- `docs/modules/pianoid-middleware/REST_API.md` — `POST /load_preset` payload, `audio_driver_type` values, parameter details
- `docs/modules/pianoid-middleware/OVERVIEW.md` — startup sequence, component dependencies

Default preset: `presets/BaselinePreset1.json`. Default initialization settings and audio driver selection rules are documented in `docs/modules/pianoid-middleware/REST_API.md`.

## Documentation-First Rule (MANDATORY)

**Every time** you need to understand something about the Pianoid codebase — whether at the start of a task, mid-implementation, during debugging, or when a new question arises — you MUST consult documentation before searching or reading source code. This applies at every stage of work, not just the beginning.

**NEVER use Grep, Glob, or Read on source files to answer a question without checking docs first.** This includes:
- "How does X work?" — architecture, data flow, threading
- "What shape/format is X?" — buffer layouts, data structures, API signatures
- "How do I run/start/test X?" — server startup, build commands, test invocation
- "Where is X configured?" — env vars, config files, runtime selection

**This rule applies equally to documentation tasks.** When auditing, updating, or verifying documentation — start from `docs/index.md`, trace the doc hierarchy to find all pages that reference the topic, then read those pages in order. Do NOT grep across the docs folder to find mentions — that skips the structural understanding of how docs reference each other and leads to inconsistent updates. The doc hierarchy IS the context.

**ESPECIALLY during debugging.** When something doesn't work as expected — wrong output, silent audio, unexpected behavior — do NOT start Grepping source files to trace the issue. Go back to `docs/index.md`, find the relevant module doc, and read the documented architecture first. The docs describe sound channel routing, output paths, and parameter flow. Source-code trawling without doc context leads to hours of wasted investigation.

The docs exist precisely to avoid expensive source-code trawling.

Documentation lookup order (paths are relative to the repo root — stop as soon as you have enough context):

1. `docs/index.md` — module map, entry point
2. `docs/architecture/SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `docs/architecture/DATA_FLOWS.md` — trace the relevant data flow
4. Drill into the specific module doc under `docs/modules/`:
   - CUDA engine: `pianoid-cuda/*.md`
   - Middleware: `pianoid-middleware/*.md`
   - Domain model: `pianoid-basic/OVERVIEW.md`
   - Frontend: `pianoid-tunner/OVERVIEW.md`
5. `docs/development/TESTING.md` — test inventory and usage
6. `docs/guides/UI_TESTING.md` — when the task involves live UI verification, launcher/backend/frontend startup, or `/test-ui`
7. `docs/guides/STARTUP_TROUBLESHOOTING.md` — when startup, ports, or shutdown sequencing is involved
8. `docs/development/WORK_IN_PROGRESS.md` — active investigations

**High-stakes inference categories (silent inference forbidden).** When a fix or diagnosis depends on any of the following data-model facts, source-code inference alone is NEVER sufficient — the fact MUST have explicit doc support, or the agent MUST measure it against the live engine and write the result to docs *before* using it:

- **Axis semantics** — which dimension is "pitch", "channel", "mode", "string", "block"; transposed views (Python row-major vs CUDA column-major; frontend axis-shifted views like the strings-axis 128 offset).
- **Dimension ordering** — `[pitch][channel]` vs `[channel][pitch]`, `[mode][pitch]` vs `[pitch][mode]`. Reading C++ array syntax `arr[i][j]` is not enough; the *semantic* axes need a doc.
- **Index conventions** — 0-based vs 1-based; piano pitches `0–127` vs output pitches `128–139`; channel offsets; sentinel values like `-1` for dummy modes or `127` for damper-open.
- **Stored vs effective entries** — a struct may store N rows but the kernel only consumes K of them (e.g. `string_coefficients[p][c]` is a 140-pitch × num-channels array but only the output-pitch rows 128–N are actually read). The agent must know K, not N.
- **Unit ranges** — 0–1 normalised vs raw FFT magnitudes (~1e-4); ms vs samples; MIDI velocity 0–127 vs 0.0–1.0; volume_coefficient 0–1 vs decibels; tension N vs N/m².
- **"Same name, different thing" pairs** — `deck`-the-Python-attribute (per-pitch coupling array) vs `deck`-the-CUDA-buffer (the packed `dev_deck_parameters` matrix); `sound_channel`-the-modes-coupling vs `string_sound_channel`-the-strings-gain; `feedin`/`feedback` between the modes path and the strings path.

If any of these is unclear after reading the docs, the agent measures against the live engine (probes the buffer shape, reads the value back, checks `pack_*` outputs) AND updates the relevant doc — *before* writing the fix code. Skipping this step is what produced the dev-833f Phase A wrong endpoint diagnosis (axis semantics inferred wrong) and the Phase B value-scale wrong diagnosis (unit range inferred wrong). Both were locally coherent reads of the source, both were wrong.

Only after the docs don't answer your question may you proceed to source files.

## Startup & Build Failure Rule

When the standard startup procedure fails (`start-pianoid.bat` on Windows / `start-pianoid.sh` on Linux, `npm run dev`, backend crash, port conflict, build failure, missing dependency, audio driver error) — or when any non-standard installation/build/startup procedure is required — automatically invoke the `/startup` skill. This skill consolidates all installation, build, and startup knowledge including toolchain detection, CUDA compilation, server launch, port conflicts, and audio driver troubleshooting.

**Auto-trigger `/startup` when:**
- The platform launcher (`start-pianoid.bat` / `start-pianoid.sh`) or `npm run dev` fails
- A build step fails (PianoidBasic, PianoidCuda, frontend npm)
- `import pianoidCuda` or `import Pianoid` fails
- Port 3000 / 3001 / 5000 is already in use
- Audio driver fails to initialize
- A fresh installation is needed
- The user asks about installation, build, or startup procedures

## Build & Environment Problems

When encountering import errors, missing modules, wrong Python interpreter, or any build/environment issue — **do NOT probe the filesystem** (listing site-packages, trying different Python paths, checking pyvenv.cfg). Instead, consult these docs immediately:

- `docs/guides/QUICK_START.md` — full installation and startup reference
- `docs/guides/STARTUP_TROUBLESHOOTING.md` — known failure modes and recovery
- `docs/architecture/BUILD_SYSTEM.md` — venv location (`PianoidCore/.venv/`), build pipeline, toolchain setup
- `docs/development/TESTING.md` — correct Python invocation

The working venv with all packages (numpy, pianoidCuda, etc.) is always `PianoidCore/.venv/`, **not** the root `.venv/`. Any other venv that appears in the workspace is legacy and must be deleted, never consulted.

**Cross-venv binary fetching is forbidden.** If `pianoidCuda` or `pianoidCuda_debug.cp312-win_amd64.pyd` is missing from `PianoidCore/.venv/Lib/site-packages/`, the ONLY acceptable response is to rebuild via `build_pianoid_cuda.bat --heavy --release` (or `--both`). Do NOT copy `.pyd` / `.dll` / wheel files from any other venv into `PianoidCore/.venv/` as a workaround. Cross-fetched binaries are silently stale at the C++ API level and produce attribute-lookup errors at runtime (e.g. `'pianoidCuda_debug.Pianoid' object has no attribute 'runSynthesisKernel'`).

**MCP server stdio fragility (long sessions).** `~/.claude.json` `mcpServers` entries that use `npx -y X@latest` (chrome-devtools, context7, google-drive) can lose their stdio pipe mid-session in long-running orchestrator runs and do NOT auto-reconnect. Symptom: those MCP tool calls start failing or hanging while Telegram and Bash stay healthy. The only recovery is a VS Code reload (orchestrator must then be restarted). To reduce surprise reloads, pin specific versions in `~/.claude.json` (e.g. `npx -y chrome-devtools-mcp@1.4.7`) instead of `@latest` -- `@latest` lets `npx` re-resolve to a different binary mid-session and break the pipe.

### Build Commands (Quick Reference)

**Before ANY build:** check for processes that hold native binaries open. A locked file causes the install to fail and leaves the package in a broken state.

```bash
# Windows — kill holders BEFORE building
tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python
tasklist //M cudart64_12.dll 2>/dev/null | grep python

# Linux — find processes that have the .so / .pyd loaded
lsof PianoidCore/.venv/lib/python3.12/site-packages/pianoidCuda*.so 2>/dev/null
```

**Build pianoidCuda** — always use the canonical build script. Details
and troubleshooting live in **[`docs/architecture/BUILD_SYSTEM.md`](../docs/architecture/BUILD_SYSTEM.md)**;
do not maintain a competing copy of build commands here. Clear `VIRTUAL_ENV` first so the
install lands in `PianoidCore/.venv/`, not the root `.venv/`.

**Windows** (canonical, tested):

```bash
# Full rebuild (C++/CUDA changes — release only)
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --release"

# Incremental (Python middleware only)
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --light --release"

# Both variants (release + debug) when the debug build is needed
unset VIRTUAL_ENV && cmd //c "PianoidCore\build_pianoid_cuda.bat --heavy --both"
```

**Linux** (parallel set, ported 2026-05-01):

```bash
# Full rebuild (C++/CUDA changes — release only)
PianoidCore/build_pianoid_cuda.sh --heavy --release

# Incremental (Python middleware only)
PianoidCore/build_pianoid_cuda.sh --light --release

# Both variants (release + debug) when the debug build is needed
PianoidCore/build_pianoid_cuda.sh --heavy --both
```

Linux differences vs Windows: ASIO is excluded from the build (Windows-only),
the produced extension is `pianoidCuda*.so` (not `.pyd`), CUDA libdir is
`lib64` (not `lib/x64`), and the host compiler is g++ (not MSVC). See
[`docs/guides/LINUX_BUILD.md`](../docs/guides/LINUX_BUILD.md) for the full
walkthrough including system-package install.

**If the Windows build exits with `3221225794` (0xC0000142 STATUS_DLL_INIT_FAILED):** do NOT
substitute a manual `pip install` — it silently reinstalls the stale `.pyd`. Follow the
recovery steps in
[`docs/architecture/BUILD_SYSTEM.md` — 0xC0000142 Recovery](../docs/architecture/BUILD_SYSTEM.md#0xc0000142-recovery-status_dll_init_failed).

**Verify** the build installed into the correct venv (use the OS-specific interpreter path):

```bash
# Windows
PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"

# Linux
PianoidCore/.venv/bin/python -c "import pianoidCuda; print(pianoidCuda.__file__)"

# Output must point inside PianoidCore/.venv/, NOT the repo-root .venv/
```

## Documentation Links

When referencing documentation files in reports or summaries, **always** provide MkDocs links via `http://localhost:8001/` (not file paths or VS Code links). Use the nav structure from `mkdocs.yml` to build URLs. Anchor fragments use the heading text lowercased with hyphens (e.g., `#excitation-system`).

Examples:
- `http://localhost:8001/modules/pianoid-cuda/SYNTHESIS_ENGINE/#excitation-system`
- `http://localhost:8001/architecture/DATA_FLOWS/#22-excitation-parameters-excitation-only-path`

## Key Paths

All entries are repo-root-relative. Apply the OS-specific repo root from the table at the top of this file.

| Resource | Repo-relative path |
|----------|--------------------|
| PianoidCore | `PianoidCore/` |
| PianoidBasic | `PianoidBasic/` |
| PianoidTunner | `PianoidTunner/` |
| Documentation | `docs/` |
| MkDocs config | `mkdocs.yml` |

## Frontend UI Standards

Adapted from the [Claude Code Frontend Design Toolkit](https://github.com/wilwaldon/Claude-Code-Frontend-Design-Toolkit) for Pianoid's stack.

### Stack

- **React 18** + **MUI v6** (Material UI) — all UI components use MUI, not Tailwind/shadcn
- **Emotion** (`@emotion/react`, `@emotion/styled`) — MUI's styling engine
- **ECharts 5** (`echarts-for-react`) — all data visualization (stabilization diagrams, charts, heatmaps)
- **Socket.IO** — real-time WebSocket communication with Flask backend
- **react-mosaic-component** — tiling window manager for dockable panes
- **CRA** (`react-scripts 5.0.1`) — build toolchain

### Theme Direction

<always_use_dark_professional_theme>
Always design with Pianoid's dark professional aesthetic:
- MUI dark theme (`mode: 'dark'`) as the base — never light mode
- Dense, information-rich layouts appropriate for audio engineering tools
- Muted accent colors (blues, teals) against dark backgrounds — no neon, no gradients
- Compact spacing (MUI `dense` prop, `size="small"`) — screen real estate is precious in mosaic panes
- Monospace or tabular-nums for numeric parameter displays
- High contrast for interactive controls (sliders, inputs) against dark panels
- No decorative elements — every pixel serves a function
</always_use_dark_professional_theme>

### Component Conventions

- **Always use MUI components** (`Button`, `TextField`, `Slider`, `Select`, `ToggleButtonGroup`, `Chip`, `Tooltip`, etc.) — never raw HTML or custom CSS equivalents
- **Use `sx` prop** for one-off styles, `styled()` for reusable styled components — never inline `style` objects
- **Use MUI `useTheme()` and `theme.palette`** for colors — never hardcode hex values
- **Use `context7` MCP** to fetch current MUI v6 docs before using any MUI API — MUI v6 has breaking changes from v5 (e.g., `Grid2` replaces `Grid`, `pigment-css` changes)
- **ECharts options** must respect the dark theme: `backgroundColor: 'transparent'`, axis/label colors from MUI palette, tooltip with dark background
- **Numeric inputs** use the existing `NumInput` component (`src/components/NumInput/NumInput.js`) — do not create new numeric input components
- **Parameter editors** follow the existing pattern: optimistic UI update + 300ms debounced API call via `usePreset`
- **Mosaic panes** must have a `MosaicWindow` wrapper with a proper title — panes without titles break the window management

### Accessibility Baseline

- All interactive elements must be keyboard-navigable (MUI handles this by default — do not break it with custom click handlers that skip `onKeyDown`)
- Slider labels must include units and current value (use MUI `Slider` `valueLabelDisplay="auto"`)
- Color is never the only indicator — pair with icons or text labels (especially in matrix heatmaps and stabilization diagrams)
- Use `aria-label` on icon-only buttons (MUI `IconButton`)

### What NOT to Do

- Do not install or use Tailwind CSS, shadcn/ui, or any CSS utility framework — MUI is the design system
- Do not add new charting libraries — use ECharts for all visualization
- Do not create standalone CSS/SCSS files — use Emotion via MUI's `sx` or `styled()`
- Do not use `React.createElement` — use JSX
- Do not add animation libraries (GSAP, Framer Motion) — Pianoid is a performance-critical audio tool, not a marketing site

## Self-Update Rule

When the user asks for any kind of update (self-update, skill update, etc.), check if the `/self-update` skill is available. If it is not available as a slash command, find it in `claude-config/skills/self-update/SKILL.md` and execute its instructions directly.
