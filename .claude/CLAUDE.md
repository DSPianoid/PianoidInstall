# Pianoid Project Instructions

## Auto-Trigger Rules

When the user requests a development task on the Pianoid codebase — bug fix, feature, refactor, optimization, or any code change — automatically invoke the `/dev` skill without waiting for the user to ask for it explicitly. This applies to tasks targeting PianoidCore, PianoidBasic, or PianoidTunner.

**Do NOT auto-trigger `/dev` for:**
- Documentation-only updates (use `/update-docs` instead)
- Package updates / git pull (use `/update-pianoid` instead)
- Questions, exploration, or research tasks
- Trivial one-line fixes where the full workflow would be overkill

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| MkDocs config | `D:\repos\PianoidInstall\mkdocs.yml` |
