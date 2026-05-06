# dev-cp02 Session Log — Followup #3 (preserve full Create state on Go Back)

**Agent ID:** dev-cp02 (continued)
**Started:** 2026-05-06 (orchestrator dispatch — third followup)
**Branch (planned):** `feature/dev-cp02-goback-full-state` on PianoidTunner only
**Status:** Step 0 → implementation

## Task (verbatim from user)

> "when I go back, I expect file path and Project name to be populated
> (unchanged)"

Followup #2 only preserved signal length. The user wants the ENTIRE
Create dialog state preserved on Go Back: file selection, project name,
averaging mode, qc_threshold; signal length pre-populated to the
EffSigLen-suggested value (`floor(median_failing/50)*50`).

## Approach

Single `lastCreateAttempt` object on `ModalAdapter` state, captured
when EffSigLen prompt opens. CreateProjectDialog accepts a richer
"initial state" prop (rename `initialSignalLengthMs` → `initialState`)
that lets the caller pre-populate every editable field.

`File` objects are JS-side opaque blobs — they can't be re-set into an
`<input type="file">` for security reasons, but they CAN be carried
in component state and passed straight to `importProject(file, ...)`
without ever touching the DOM input again. So:

- File selection persists by carrying the `File` object in state.
- The dialog renders the file name in the "selected file" label
  (already does this via `file?.name`).
- If the user picks a different file via the picker, the state-held
  File is replaced (existing onChange handler).

## Workflow

- Step 0: agent ID + session log + WIP entry — DONE
- Step 1: docs-first (re-read CreateProjectDialog from followup #2)
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests (212/212 from followup #2 commit)
- Step 3: feature branch
- Skip planning pause per orchestrator (mechanical)
- Steps 4-7: implement → test → debug
- Step 8: docs (small update to MODAL_ADAPTER_GUIDE.md Go Back paragraph)
- Step 9: feature branch merge `--no-ff`, NO push
- STOP at Step 10

## Constraints

- DO NOT touch live frontend / modal adapter
- DO NOT spawn sub-agents
- DO NOT use Skill tool
- DO NOT push to origin
- DO NOT regress existing 212 frontend tests
- STAY ALIVE through entire workflow
