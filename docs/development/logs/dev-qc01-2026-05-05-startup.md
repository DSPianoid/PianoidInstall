# dev-qc01 Session Log — Scenario Averager Quality Control (Effective Signal Length)

**Agent ID:** dev-qc01
**Started:** 2026-05-05 (orchestrator dispatch)
**Branch (planned):** `feature/dev-qc01-scenario-qc-effective-length` on PianoidCore + PianoidTunner
**Status:** Step 0–1 (docs research)

## Task

Add per-scenario per-channel quality-control feature to the Modal Adapter scenario
averager: split N raw measurements into two halves, average each separately, compute
envelope of the difference between the two half-averages, find the time at which the
difference envelope crosses a threshold fraction of the full-average envelope. Call
this point Effective Signal Length (T_eff). Warn the user when the configured per-band
`ir_length_ms` exceeds the per-channel/per-scenario T_eff.

## Workflow

- Step 0: agent ID `dev-qc01`, session log + WIP entry — DONE
- Step 1: docs-first per CLAUDE.md
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests pass
- Step 3: feature branches, then **MANDATORY PAUSE** — planning report to user
- Steps 4–7: implement → test → debug → verify
- Step 8: docs
- Step 9: feature branch merge (`--no-ff`), no skip-hooks
- STOP at Step 10 — uncommitted state report (no push)

## Constraints

- DO NOT touch live modal adapter / frontend dev server (PID 24420 / 22136)
- DO NOT spawn sub-agents
- DO NOT use Skill tool (causes silent CLI permission prompts)
- DO NOT regress existing scenario_averager tests
- STAY ALIVE through entire workflow

## Lock Conflict Watch

dev-c807 currently holds:
- `PianoidTunner/src/components/ProjectInfoCard.jsx`
- `PianoidTunner/src/hooks/useModalAdapter.js`
- `PianoidTunner/src/modules/ModalAdapter.jsx`

These overlap with my likely frontend touch-points for the warning UI surface.
Strategy: defer those frontend edits, or scope warning to a NEW component
(e.g., `EffectiveSignalLengthWarning.jsx`) and only edit `EspritConfig.jsx`
(not currently locked) plus a small additive read in `useModalAdapter.js`
(must wait for dev-c807 release) or expose via REST so a new component can
fetch independently.

dev-d773 holds backend `mode_tracking.py` + tests + docs — no overlap with my work.

## Notes

