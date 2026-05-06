# dev-cp01 Session Log — Streamlined Create Project flow

**Agent ID:** dev-cp01
**Started:** 2026-05-05 (orchestrator dispatch)
**Branch (planned):** `feature/dev-cp01-create-project-streamline` on PianoidCore + PianoidTunner
**Status:** Step 0 → Step 1 (docs research)

## Task (verbatim from user)

> "Let's streamline. When project is created from measurements folder or zip,
> user is always prompted with pop up dialog, where file name, averaging
> mode (keep/overwrite) and signal length is set. Averaging should be done
> with quality control (random split -> two curves comparison -> Effective
> signal length detection). Quality control results should be accessible
> from the UI. If in any channel/measurement is shorter than requested,
> user has to be prompted with an option to rerun averaging with shorter
> signal."

## Subsumes

- **Bug B**: project name = `tmpXXX` instead of zip stem (route never forwards
  `request.files['file'].filename` so the adapter falls back to the
  Werkzeug temp filename).
- **Bug C**: `IR(ms)` ignored due to averaging idempotency short-circuit when
  the project already has `averaged_responses/` with the wrong length.

## Foundations Already in Place

- **dev-07b4** (PianoidCore tip `77614cf` via merges): per-band `skip_start_ms`.
- **dev-d773**: default `tracking_method = nuclei_merge`.
- **dev-qc01**: Effective Signal Length QC backend
  (`scenario_averager.compute_effective_signal_length` + per-scenario
  `effective_signal_length.json` + `GET/POST /modal/projects/<n>/effective_signal_length`).
- **dev-c807**: tracking results UI batch + grid mismatch chip on
  `ProjectInfoCard`.

## Workflow

- Step 0: agent ID `dev-cp01`, session log + WIP entry — DONE
- Step 1: docs-first per CLAUDE.md
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests pass
- Step 3: feature branches, then **MANDATORY PAUSE** — planning report to user
- Steps 4–7: implement → test → debug → verify
- Step 8: docs
- Step 9: feature branch merge (`--no-ff`), no skip-hooks, NO push
- STOP at Step 10 — uncommitted state report (no push)

## Constraints

- DO NOT touch live modal adapter (PID 24420) / frontend (PID 22136) — user is iterating
- DO NOT spawn sub-agents
- DO NOT use Skill tool (causes silent CLI permission prompts)
- DO NOT push to origin
- DO NOT regress existing 88 mode-tracking + 28 averager + 55 frontend tests
- STAY ALIVE through entire workflow

## Lock Conflict Watch (sibling agents alive)

Per orchestrator note, MODULE_LOCKS.md table is empty as of dispatch — sibling
agents have released. Files I will need:

- Backend: `routes.py`, `modal_adapter.py`, `scenario_averager.py`
- Frontend: `ModalAdapter.jsx`, `useModalAdapter.js`, `ProjectInfoCard.jsx`,
  NEW `CreateProjectDialog.jsx`, NEW `EffSigLenRerunPrompt.jsx` (or inline)
- Tests: backend integration + frontend component
- Docs: `MODAL_ADAPTER_GUIDE.md`

## Initial Bug B / Bug C Diagnosis (read-only research)

### Bug B (project name = tmpXXX)

Source of bug: `routes.create_project_from_zip` writes the upload to a Werkzeug
temp file via `tempfile.NamedTemporaryFile(suffix='.zip')` — the temp file's
basename is `tmpXXXXXX.zip`. Then it calls `adapter.create_project_from_zip(
tmp.name, name=name, ...)` with `name = request.form.get('name') or None`.
When the form `name` is omitted (the frontend currently always omits it),
the adapter falls through to `os.path.splitext(os.path.basename(zip_path))[0]`
which yields the temp stem.

**Fix surface:** in `routes.py`, when `name` is None and `f.filename` is non-
empty, derive `name` from the upload's original filename
(`os.path.splitext(secure_filename(f.filename))[0]`), THEN pass to adapter.
Alternatively: the new Create dialog will always supply an explicit `name`,
so the route fix becomes a defence-in-depth.

### Bug C (IR(ms) ignored)

Source of bug: `scenario_averager.ensure_averaged_responses` short-circuits at
the start when `_scenario_already_averaged(scenario_dir)` is True and `force`
is False. The route DOES forward `force_reaverage`, BUT the frontend's import
`onChange` handler does not currently send it; so a re-import of the SAME
zip with a longer `ir_working_length_ms` silently keeps the prior averages.

**Fix surface:** the new dialog's "Averaging mode = Overwrite" radio maps
straight to `force_reaverage=True`. Even on "Keep", we can detect at the
backend that an existing average is shorter than the requested length and
either auto-promote to force OR (better — matches the spec's "user prompted")
return a 409-style payload that the frontend converts into the EffSigLen
rerun-prompt dialog. Decision deferred to the planning report.

## Notes

- The QC backend already runs unconditionally inside
  `ensure_averaged_responses` whenever the canonical averager runs (no gate).
  This means the rerun prompt has all the data it needs after the first
  create call returns.
- ProjectInfoCard currently has chips for: scenarios, channels, layout,
  signal length, grid-mismatch (dev-c807). It does NOT show Eff sig — that's
  the deferred dev-qc01 follow-up I will pick up here.
