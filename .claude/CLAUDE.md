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

**`/fn` skill — single-function development:**
- `/fn` is a lightweight skill for implementing a single function with clear requirements and test criteria
- `/dev` agents should **prefer delegating to `/fn` sub-agents** whenever function-level requirements and testing are feasible (see Step 4b in `/dev`)
- `/fn` can also be invoked directly by the user for small, self-contained changes that don't need the full `/dev` workflow
- When `/dev` spawns `/fn`, the dev agent writes tests first and hands them to the sub-agent. The tests persist in the project test suite
- Documentation and commits always stay at the `/dev` (or user) level — `/fn` never commits or updates docs

## UI Interaction Rule

When the user requests any task that involves the Pianoid frontend interface — viewing parameters, editing excitation/string/mode parameters, playing notes, capturing sound, or any browser-based interaction — automatically invoke the `/pianoid-ui` skill unless the user explicitly instructs otherwise.

## Audio Verification Rule

After completing any code change that affects synthesis output — volume, excitation, physical parameters, hammer shape, or any parameter that influences sound — invoke `/test-ui` to verify the change with measured evidence before reporting completion. This applies whether the change is in C++/CUDA, Python middleware, or frontend React code. **Do not claim an audio-affecting feature works without a measured before/after comparison.**

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

**This rule applies equally to documentation tasks.** When auditing, updating, or verifying documentation — start from `docs/index.md`, trace the doc hierarchy to find all pages that reference the topic, then read those pages in order. Do NOT grep across the docs folder to find mentions — that skips the structural understanding of how docs reference each other and leads to inconsistent updates. The doc hierarchy IS the context.

**ESPECIALLY during debugging.** When something doesn't work as expected — wrong output, silent audio, unexpected behavior — do NOT start Grepping source files to trace the issue. Go back to `docs/index.md`, find the relevant module doc, and read the documented architecture first. The docs describe sound channel routing, output paths, and parameter flow. Source-code trawling without doc context leads to hours of wasted investigation.

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

## Startup & Build Failure Rule

When the standard startup procedure fails (`start-pianoid.bat`, `npm run dev`, backend crash, port conflict, build failure, missing dependency, audio driver error) — or when any non-standard installation/build/startup procedure is required — automatically invoke the `/startup` skill. This skill consolidates all installation, build, and startup knowledge including toolchain detection, CUDA compilation, server launch, port conflicts, and audio driver troubleshooting.

**Auto-trigger `/startup` when:**
- `start-pianoid.bat` or `npm run dev` fails
- A build step fails (PianoidBasic, PianoidCuda, frontend npm)
- `import pianoidCuda` or `import Pianoid` fails
- Port 3000/3001/5000 is already in use
- Audio driver fails to initialize
- A fresh installation is needed
- The user asks about installation, build, or startup procedures

## Build & Environment Problems

When encountering import errors, missing modules, wrong Python interpreter, or any build/environment issue — **do NOT probe the filesystem** (listing site-packages, trying different Python paths, checking pyvenv.cfg). Instead, consult these docs immediately:

- `docs/guides/QUICK_START.md` — full installation and startup reference
- `docs/guides/STARTUP_TROUBLESHOOTING.md` — known failure modes and recovery
- `docs/architecture/BUILD_SYSTEM.md` — venv location (`PianoidCore/.venv/`), build pipeline, toolchain setup
- `docs/development/TESTING.md` — correct Python invocation (`cd PianoidCore && .venv/Scripts/python`)

The working venv with all packages (numpy, pianoidCuda, etc.) is always `PianoidCore/.venv/`, **not** the root `.venv/`.

### Build Commands (Quick Reference)

**Before ANY build:** check for locked `.pyd`/`.dll` files. A locked file causes `[WinError 5] Access is denied`, leaves the package uninstalled, and breaks everything.

```bash
# Check for locked files — kill holders BEFORE building
tasklist //M pianoidCuda.cp312-win_amd64.pyd 2>/dev/null | grep python
tasklist //M cudart64_12.dll 2>/dev/null | grep python
```

**Build pianoidCuda** (always clear `VIRTUAL_ENV` to prevent installing into root `.venv/`):

```bash
# Full rebuild (C++/CUDA changes)
unset VIRTUAL_ENV && cmd //c "D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy"

# Incremental (Python middleware only)
unset VIRTUAL_ENV && cmd //c "D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --light"

# Fallback (pip direct — when bat script fails)
cd D:/repos/PianoidInstall/PianoidCore && .venv/Scripts/python -m pip install --force-reinstall --no-deps pianoid_cuda/
```

**Verify** the build installed into the correct venv:
```bash
D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"
# Must show PianoidCore/.venv/..., NOT root .venv/...
```

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
