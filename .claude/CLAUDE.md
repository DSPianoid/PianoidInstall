# Pianoid Project Instructions

## Auto-Trigger Rules

When the user requests a development task on the Pianoid codebase — bug fix, feature, refactor, optimization, or any code change — automatically invoke the `/dev` skill without waiting for the user to ask for it explicitly. This applies to tasks targeting PianoidCore, PianoidBasic, or PianoidTunner.

**Do NOT auto-trigger `/dev` for:**
- Documentation-only updates (use `/update-docs` instead)
- Package updates / git pull (use `/update-pianoid` instead)
- Questions, exploration, or research tasks
- Trivial one-line fixes where the full workflow would be overkill

## Context Lookup

When handling any request where the context is not fully clear — questions about how something works, running tests on a specific module, investigating behaviour, or any task that requires understanding project structure — **always consult the documentation first**, in this order:

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

Stop reading as soon as you have enough context. Only then proceed to source files if needed.

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| MkDocs config | `D:\repos\PianoidInstall\mkdocs.yml` |
