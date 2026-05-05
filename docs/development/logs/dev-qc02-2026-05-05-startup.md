# dev-qc02 Session Log — Scenario Averager QC Algorithm Fix (Correct Sequence)

**Agent ID:** dev-qc02
**Started:** 2026-05-05 14:10 UTC
**Branch (planned):** `feature/dev-qc02-qc-correct-sequence` on PianoidCore + PianoidTunner
**Status:** Step 0–1 (docs/source research)

## Task

Fix algorithmic bug in dev-qc01's split-half QC: the current implementation
splits raw measurements first then runs canonical preprocessing on each
subset independently. This introduces artificial variance from
per-subset alignment + normalization differences.

Correct sequence per user:
1. Run full preprocessing (extract → validate → align → normalize)
   on ALL N raw measurements together with a SINGLE common reference
2. Split the resulting aligned-normalized cycle stack into two random
   subsets (cycle-level, not measurement-level)
3. Average each subset separately
4. Compute envelopes and find T_eff

## Context

Bug surfaced by user's review of dev-qc01's QC output on PlyWoodTake1_1:
- Per-scenario T_eff values 0-200 ms, but user expects 300-600 ms
- 2/30 scenarios produce T_eff = 0 ms (collapse global min via aggregation)
- Median scenario rms_diff_pct = 8.13% — very close to 10% threshold
- Best-case scenario T_eff = 200-280 ms — still below user expectation

Hypothesis: per-subset alignment/normalization is contributing
significant artificial variance to env_diff. Removing it should:
- Reduce baseline rms_diff_pct (subsets share alignment+norm reference)
- Push T_eff later in time (less noise = later threshold crossing)
- Bring median into user-expected range

## Workflow

- Step 0: agent ID `dev-qc02`, session log + WIP entry — IN PROGRESS
- Step 1: docs-first per CLAUDE.md
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests pass
- Step 3: feature branches, then **MANDATORY PAUSE** — planning report to user
- Steps 4–7: implement → test → debug → verify
- Step 8: docs
- Step 9: local merge only (`--no-ff`), no push (user directive)
- STOP at Step 10 — uncommitted state report

## Constraints

- DO NOT touch live modal adapter / frontend dev server
- DO NOT spawn sub-agents
- DO NOT use Skill tool
- DO NOT push to origin
- READ ONLY in RoomResponse sibling repo (`signal_processor.py`)
- STAY ALIVE through entire workflow

## Notes

