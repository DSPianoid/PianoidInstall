# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| docs-sc-overview | docs/modules/pianoid-tunner/OVERVIEW.md, docs/architecture/DATA_FLOWS.md, docs/development/WORK_IN_PROGRESS.md | 2026-04-20 | Wave C — mt-sound-channels docs update |
