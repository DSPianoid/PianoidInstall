# Module Locks

Active file locks held by dev agents. A locked file must not be edited by another agent until released.

Locks are released after: commit (wrap-up), revert (reset), or commit/stash (pause). Never edit another agent's lock entries.

| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-07b4 | `PianoidCore/pianoid_middleware/modal_adapter/esprit/band_processing.py`, `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py` (get_band_presets only — 1-line additive field), `PianoidTunner/src/components/EspritConfig.jsx` (additive column on top of qc01's committed warning-UI version), `PianoidTunner/src/components/__tests__/EspritConfig.skipStart.test.jsx` (NEW — separate file from qc01's tests to avoid collision), `PianoidCore/tests/unit/test_band_processing_skip.py` (NEW), `docs/guides/MODAL_ADAPTER_GUIDE.md` (band-config section additive on top of qc01's QC commit), `docs/development/SKIP_START_MS_RATIONALE.md` (NEW), `docs/development/WORK_IN_PROGRESS.md` + `docs/development/MODULE_LOCKS.md` (status updates). | 2026-05-05T07:10:00Z | Per-band `skip_start_ms` for ESPRIT pipeline — additive `Optional[float]` field on `FrequencyBand` dataclass; trims forcing-transient + Butterworth `sosfiltfilt` settling region from start of each band's signal AFTER bandpass + decimation + preemphasis. Per-band defaults on EXTENDED_BANDS only (50/30/15/5/0/0/0/0 ms); STANDARD_BANDS untouched. 15 backend + 7 frontend tests pass; 107 existing tests pass (no regression). Phase-1/2 stash coordination with dev-qc01 successful — no merge conflicts. |
