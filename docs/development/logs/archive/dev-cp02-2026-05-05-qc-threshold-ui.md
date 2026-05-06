# dev-cp02 Session Log — Quality Threshold UI + Enhanced Rerun Prompt

**Agent ID:** dev-cp02
**Started:** 2026-05-05 (orchestrator dispatch, follow-up to dev-cp01)
**Branch (planned):** `feature/dev-cp02-qc-threshold-ui` on PianoidTunner only
**Status:** Step 0 → Step 1 (docs + qc02-diff research)

## Task (verbatim from user)

> A. Add Quality threshold field to CreateProjectDialog.jsx
>    (numeric, default 0.1, range 0.05-0.5, step 0.01, tooltip).
>    Pass as ``qc_threshold`` form field on importProject call.
>
> B. Enhance EffectiveSignalLengthRerunDialog.jsx text:
>    "X of Y scenarios fell below your requested length"
>    + median T_eff and min T_eff (with scenario name) for failing scenarios.

## Foundations (from dev-qc02, just landed)

PianoidCore dev tip: `43cf005`. Backend now accepts `qc_threshold` on:
- `POST /modal/projects/create_from_zip` (form field, validated 0 < x < 1)
- `POST /modal/projects/<n>/reaverage` (JSON body)
- `POST /modal/projects/<n>/effective_signal_length` (JSON body)

JSON schema v2 fields per scenario (`effective_signal_length.json`):
- `qc_threshold` (explicit alias for `threshold` — both present)
- `n_cycles_per_channel`, `n_cycles_per_half_a/b` (replace v1's
  `n_measurements_per_half_a/b`)
- Pre-existing fields preserved: `per_channel_t_eff_ms`,
  `scenario_min_t_eff_ms`

Project-level summary (returned by `_load_effective_signal_length_summary`,
fetched by both `useEffectiveSignalLength` hook in `EspritConfig.jsx` AND
`useProjectEffSigLen` hook in `ProjectInfoCard.jsx`):
- `per_scenario_min_t_eff_ms: {scenario_name: t_eff_ms_or_null}`
- `n_scenarios_with_qc`, `n_scenarios_without_qc`, `n_scenarios_total`
- `global_min_t_eff_ms`, `per_channel_min_t_eff_ms`
- `threshold`, `envelope_method`

**All data needed for Task B is already in the QC summary** — no
additional backend computation needed. Substandard count, median T_eff
of failing scenarios, and min T_eff with scenario name are all
client-computable from `per_scenario_min_t_eff_ms`.

## Workflow

- Step 0: agent ID `dev-cp02`, session log + WIP entry — DONE
- Step 1: docs-first per CLAUDE.md (qc02 commit + dev-cp01 docs)
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests pass
- Step 3: feature branches, then **MANDATORY PAUSE** — planning report
- Steps 4–7: implement → test → debug → verify
- Step 8: docs (update MODAL_ADAPTER_GUIDE.md create-flow Quality threshold field + EffSigLen prompt copy)
- Step 9: feature branch merge (`--no-ff`), no skip-hooks, NO push
- STOP at Step 10 — uncommitted state report (no push)

## Constraints

- DO NOT touch live modal adapter (PID 24420) / frontend (PID 22136)
- DO NOT spawn sub-agents
- DO NOT use Skill tool (causes silent CLI permission prompts)
- DO NOT push to origin
- DO NOT regress existing 89 frontend tests
- STAY ALIVE through entire workflow

## Empirical context (from user message)

Post-fix median scenario T_eff is 135.6 ms (was 56.8). On typical
1000 ms requests, ~25-28 of 30 scenarios will be flagged "fell short."
Format the prompt text so this is informative not alarming —
the user should understand the situation, not feel the project is broken.

## Open question for planning report

**Suggested rerun length** — keep `floor(global_min_t_eff_ms / 50) * 50`
(pessimistic, current; e.g. min=0 → 50 ms, very short) OR switch to
`floor(median_failing / 50) * 50` (less pessimistic; e.g. failing
median 180 → 150 ms)?

Empirically, with the new dev-qc02 numbers, min T_eff can be 0 ms (Sc 5
residual zero), which would suggest a useless 50 ms re-run. Median
of failing is much more useful as a target. **My recommendation:
switch to median_failing.** Will surface in planning.

## Notes

- The `useProjectEffSigLen` hook in ProjectInfoCard already fetches
  the same QC summary the rerun dialog needs — but the rerun dialog
  receives `qcSummary` as a prop from ModalAdapter.jsx, populated
  via `fetchEffectiveSignalLength(projectName)` returned data's
  `summary` field. That fetch already includes `per_scenario_min_t_eff_ms`.
- Quality threshold field fits cleanly between Signal Length (ms) and
  Averaging mode in CreateProjectDialog. Hide for `.pianoid-project`
  archives like the other QC-related fields.
