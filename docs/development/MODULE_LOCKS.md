# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-3b60 | `setup-pianoid.bat`, `setup-pianoid.sh`, `start-pianoid.bat`, `start-pianoid.sh`, `PianoidCore/build_pianoid_cuda.bat`, `PianoidCore/build_pianoid_cuda.sh`, `PianoidCore/build_pianoid_basic.bat`, `PianoidCore/build_pianoid_basic.sh`, `PianoidCore/.gitattributes` (new), `PianoidBasic/.gitattributes` (new), `PianoidTunner/.gitattributes` (new), `docs/architecture/BUILD_SYSTEM.md`, `docs/guides/LINUX_BUILD.md` | 2026-05-05T12:35:00Z | Implement F2 PIANOID_VENV_DIR + R1 .gitattributes + R2 backendServer case |
