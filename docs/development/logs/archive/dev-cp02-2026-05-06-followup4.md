# dev-cp02 Session Log — Followup #4 (Go Back retry uses reaverage, not full Create)

**Agent ID:** dev-cp02 (continued)
**Started:** 2026-05-06 (orchestrator dispatch — fourth followup)
**Branch (planned):** `feature/dev-cp02-goback-reaverage` on PianoidTunner only
**Status:** Step 0 → implementation

## Task (verbatim from user)

> "do I understand correctly that when I go back, unzipping/file
> copying starts anew? Correct logic would be to redo averaging only."

User correctly identifies that followup #3's Go Back flow re-uploads
the file, re-extracts the zip, and creates a NEW project (auto-suffix
`_1`). Wasteful — the project already exists; only re-averaging needs
to run with the new signal length.

## Approach

Resurrect the `POST /modal/projects/<n>/reaverage` endpoint
(dev-cp01 backend, exposed via `useModalAdapter.reaverageProject` —
unused since followup #2 removed the in-place rerun). Branch on
submit-time at the ModalAdapter Create handler.

**2026-05-06 mid-session refinement (4 cases per coordinator):**

1. **File+name unchanged** → call `reaverageProject(name,
   signalLength, { qc_threshold })`. Skip upload+extract+create.
2. **Name changed only, file unchanged** → call `renameProject(
   priorCreatedName, newName)` then `reaverageProject(newName,
   signalLength, { qc_threshold })`. On-disk artifacts (raw_recordings,
   averaged_responses) stay; just relabel and re-run averaging.
3. **File changed (different File reference)** → call `deleteProject(
   priorCreatedName, /* delete_measurements */ true)` to clean up the
   orphan project + extracted measurement folder, then run the full
   `importProject` flow with the new file (which creates a new
   project, possibly auto-suffixed).
4. **Cancel from EffSigLen dialog** (user closes via X / Escape /
   "Proceed without retry" — i.e. the dialog's `onClose` fires while
   `priorAttempt.createdProjectName` is set) → call `deleteProject(
   priorCreatedName, true)` to clean up the orphan. The user
   speculatively created a project, then rejected it.

Both `deleteProject(name, true)` and `renameProject` already exist in
the hook + backend (dev-cp01 + dev-8b5f respectively). `Proceed`
button on the EffSigLen dialog deliberately does NOT trigger cleanup
— the user explicitly chose to keep the project at the requested
length.

State changes:
- Extend `lastCreateAttempt` with `createdProjectName: string | null`
  (the actual backend-assigned name, including any auto-suffix from
  Bug B fix or prior collisions). Captured from `result.name` after
  the successful Create.
- Pass `lastCreateAttempt` (now including createdProjectName) into
  CreateProjectDialog as `initialState` so the dialog's submit handler
  can detect the same-file-and-name-as-prior case.

The detection logic: in the ModalAdapter onCreate handler, compare
the submitted `(file, name)` against the stashed
`(lastCreateAttempt.file, lastCreateAttempt.name)`. If both match
identity-wise (file is the SAME File reference; name string equality)
AND `createdProjectName` is set, call `reaverageProject` instead of
`importProject`. Otherwise full Create.

`File` reference identity is the right comparison: the dialog's
restored-state path passes the SAME File object back through. If the
user picks a different file via the picker, the new File is a fresh
object (different reference) → full Create path triggers correctly.

## Workflow

- Step 0: agent ID + session log + WIP entry — DONE
- Step 1: re-confirm `reaverageProject` signature in useModalAdapter
  (still exists, just dead from frontend POV)
- Step 1b: lock acquisition in MODULE_LOCKS.md — DONE
- Step 2: baseline tests pass (221/221 from merged dev tip)
- Step 3: feature branch
- Skip planning pause per orchestrator
- Steps 4-7: implement → test
- Step 8: docs (small update to MODAL_ADAPTER_GUIDE.md Go Back para)
- Step 9: feature branch merge `--no-ff`, NO push
- STOP at Step 10

## Constraints

- DO NOT touch live frontend / modal adapter
- DO NOT spawn sub-agents
- DO NOT use Skill tool
- DO NOT push to origin
- DO NOT regress existing 221 frontend tests
- STAY ALIVE through entire workflow
