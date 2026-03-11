# Pianoid Project Instructions

## Auto-Trigger Rules

When the user requests a development task on the Pianoid codebase — bug fix, feature, refactor, optimization, or any code change — automatically invoke the `/dev` skill without waiting for the user to ask for it explicitly. This applies to tasks targeting PianoidCore, PianoidBasic, or PianoidTunner.

**Do NOT auto-trigger `/dev` for:**
- Documentation-only updates (use `/update-docs` instead)
- Package updates / git pull (use `/update-pianoid` instead)
- Questions, exploration, or research tasks
- Trivial one-line fixes where the full workflow would be overkill

## Documentation-First Rule (MANDATORY)

**Every time** you need to understand something about the Pianoid codebase — whether at the start of a task, mid-implementation, during debugging, or when a new question arises — you MUST consult documentation before searching or reading source code. This applies at every stage of work, not just the beginning.

**NEVER use Grep, Glob, or Read on source files to answer a "how does X work?" question without checking docs first.** The docs exist precisely to avoid expensive source-code trawling.

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
