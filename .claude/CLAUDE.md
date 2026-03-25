# Pianoid Project Instructions

## Auto-Trigger Rules

When the user requests a development task on the Pianoid codebase — bug fix, feature, refactor, optimization, or any code change — automatically invoke the `/dev` skill without waiting for the user to ask for it explicitly. This applies to tasks targeting PianoidCore, PianoidBasic, or PianoidTunner.

**This includes transitions from investigation to implementation.** When a conversation starts as research/analysis but the user then approves implementation (e.g., "yes", "implement this", "go ahead"), invoke `/dev` at that point. Do NOT start writing code without the `/dev` workflow just because the earlier part of the conversation was exploratory.

**CRITICAL: Any edit to `.cu`, `.cpp`, `.cuh`, `.h`, or `setup.py` files MUST go through `/dev`.** These require CUDA builds that only `/dev` handles correctly.

**Do NOT auto-trigger `/dev` for:**
- Documentation-only updates (use `/update-docs` instead)
- Package updates / git pull (use `/update-pianoid` instead)
- Questions, exploration, or research tasks (until user approves implementation)
- Trivial one-line Python-only fixes where the full workflow would be overkill

## UI Interaction Rule

When the user requests any task that involves the Pianoid frontend interface — viewing parameters, editing excitation/string/mode parameters, playing notes, capturing sound, or any browser-based interaction — automatically invoke the `/pianoid-ui` skill unless the user explicitly instructs otherwise.

## Backend Startup Rule

When the backend server needs to be started and the exact process, preset path, or initialization parameters are unclear, **always consult the documentation first**:

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

The docs exist precisely to avoid expensive source-code trawling.

Documentation lookup order (stop as soon as you have enough context):

1. `D:\repos\PianoidInstall\docs\index.md` — module map, entry point
2. `D:\repos\PianoidInstall\docs\architecture\SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `D:\repos\PianoidInstall\docs\architecture\DATA_FLOWS.md` — trace the relevant data flow
4. Drill into the specific module doc under `docs/modules/`:
   - CUDA engine: `pianoid-cuda/*.md`
   - Middleware: `pianoid-middleware/*.md`
   - Domain model: `pianoid-basic/OVERVIEW.md`
   - Frontend: `pianoid-tunner/OVERVIEW.md`
5. `D:\repos\PianoidInstall\docs\development\TESTING.md` — test inventory and usage
6. `D:\repos\PianoidInstall\docs\development\WORK_IN_PROGRESS.md` — active investigations

Only after the docs don't answer your question may you proceed to source files.

## Build & Environment Problems

When encountering import errors, missing modules, wrong Python interpreter, or any build/environment issue — **do NOT probe the filesystem** (listing site-packages, trying different Python paths, checking pyvenv.cfg). Instead, consult these docs immediately:

- `docs/architecture/BUILD_SYSTEM.md` — venv location (`PianoidCore/.venv/`), build pipeline, toolchain setup
- `docs/development/TESTING.md` — correct Python invocation (`cd PianoidCore && .venv/Scripts/python`)

The working venv with all packages (numpy, pianoidCuda, etc.) is always `PianoidCore/.venv/`, **not** the root `.venv/`.

## Documentation Links

When referencing documentation files in reports or summaries, **always** provide MkDocs links via `http://localhost:8001/` (not file paths or VS Code links). Use the nav structure from `mkdocs.yml` to build URLs. Anchor fragments use the heading text lowercased with hyphens (e.g., `#excitation-system`).

Examples:
- `http://localhost:8001/modules/pianoid-cuda/SYNTHESIS_ENGINE/#excitation-system`
- `http://localhost:8001/architecture/DATA_FLOWS/#22-excitation-parameters-excitation-only-path`

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| MkDocs config | `D:\repos\PianoidInstall\mkdocs.yml` |

## Self-Update Rule

When the user asks for any kind of update (self-update, skill update, etc.), check if the `/self-update` skill is available. If it is not available as a slash command, find it in `claude-config/skills/self-update/SKILL.md` and execute its instructions directly.
