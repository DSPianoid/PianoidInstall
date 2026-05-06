# dev-cp02 Session Log — Follow-up #2 (Snackbar + Proceed/Go Back buttons)

**Agent ID:** dev-cp02 (continued)
**Started:** 2026-05-06 (orchestrator dispatch — second follow-up to dev-cp01/cp02)
**Branch (planned):** `feature/dev-cp02-snackbar-and-goback` on PianoidTunner only
**Status:** Step 0 → Step 1 (investigation done)

## Tasks (verbatim from user)

> 1) "I'm getting system notification 'Confirm action on localhost:3000
>     Project <name> created Format: roomresponse…' Where does it come
>     from? Can it be avoided?"
> 2) "Instead of Keep Current and ReRun With options should be Proceed
>     and Go Back which leads back to the dialog and lets user to change
>     parameters manually (populating signal length with the value set by
>     default)"

## Task A — root cause (already identified)

`PianoidTunner/src/modules/ModalAdapter.jsx:1220` and `:1223` —
`window.alert(...)` calls in the post-create handler I wrote in dev-cp01.
The "Confirm action on localhost:3000" framing is Chrome's native styling
when a script (not a user-action handler) triggers `window.alert()`.
My own dev-cp01 commit comment claimed it was "kept for backward
compatibility with users used to seeing it" — the user is now telling
us the opposite. **Fix: remove + replace with MUI Snackbar.**

The codebase already has a Snackbar pattern in `PianoidTuner.js` (`notification` state + `Alert` content). For the ModalAdapter pane, I'll add a local Snackbar — same pattern, scoped to this module — to avoid prop-drilling notification state up to the parent.

## Task B — refactor plan

Current EffectiveSignalLengthRerunDialog buttons:
- `Keep current N ms` — closes the dialog, leaves project as-is
- `Show details` — toggles the per-scenario / per-channel breakdown
- `Re-run with M ms` — calls `reaverageProject(name, M)` to recompute
  averaging at the suggested length

New design per user spec:
- `Proceed` — same behaviour as old "Keep current": close dialog,
  leave project at current N ms
- `Show details` — unchanged
- `Go Back` — close EffSigLen dialog AND reopen CreateProjectDialog
  with the signal length field PRE-POPULATED to `suggestedRerunMs`
  (i.e. the value that "Re-run with M ms" used to send). User can
  then edit the value and click Create again.

### Implementation sketch

1. `EffectiveSignalLengthRerunDialog`:
   - Rename `onRerun(suggestedMs)` callback to `onGoBack(suggestedMs)`
     to communicate the new semantics. Caller does the navigation.
   - Update button labels.

2. `ModalAdapter.jsx`:
   - Add new state: `createDialogInitialSignalLength` (number | null).
     When set, `CreateProjectDialog` reads it as the initial signal
     length value instead of the hardcoded 1000 default.
   - On `EffSigLenRerunDialog.onGoBack(suggestedMs)`:
     - Close the EffSigLen dialog
     - Set `createDialogInitialSignalLength = suggestedMs`
     - Reopen `createDialogOpen = true`
   - When `createDialogOpen` toggles to false (user closes it), clear
     `createDialogInitialSignalLength` so the next fresh open uses
     the 1000 default again.

3. `CreateProjectDialog`:
   - New optional prop `initialSignalLengthMs: number | null`.
   - The `useEffect` that resets state on `open=true` reads this
     prop and uses it as the signal length instead of the
     `DEFAULT_SIGNAL_LENGTH_MS = 1000` constant when set.
   - Other fields (qc_threshold, name, averaging mode) keep their
     defaults — the user wanted ONLY signal length pre-populated.

### State of the project on Go Back

The first create call DID successfully create the project. The Go Back
flow does NOT delete it — it just lets the user re-create at a different
length. The second Create call will hit the project-name auto-suffix
(backend renames to `Foo_1`). This is the documented backend behavior
already (dev-cp01 docs note "conflicts auto-resolved with `_1`, `_2`, ...").

If the user wanted a different name they'd type it; if they wanted to
delete the first project they can do so via the project browser. Don't
add hidden cleanup magic — the explicit name field gives them control.

(Could surface this in helper text on the reopened dialog, e.g. "Note:
your previous attempt is still in your project list as 'Foo'" — TBD,
flagged in planning notes.)

## Workflow

- Step 0: agent ID + session log + WIP entry — DONE
- Step 1: docs-first + Task A investigation — DONE (root cause confirmed)
- Step 1b: lock acquisition in MODULE_LOCKS.md
- Step 2: baseline tests pass — DONE (48/48 on impacted suites)
- Step 3: feature branch
- (skip planning pause per orchestrator clarification — both tasks
  are mechanical, no significant architectural decisions)
- Steps 4-7: implement → test → debug → verify
- Step 8: docs (update MODAL_ADAPTER_GUIDE.md EffSigLen prompt copy)
- Step 9: feature branch merge (`--no-ff`), no skip-hooks, NO push
- STOP at Step 10 — uncommitted state report

## Constraints

- DO NOT touch live modal adapter / frontend
- DO NOT spawn sub-agents
- DO NOT use Skill tool
- DO NOT push to origin
- DO NOT regress existing tests
- STAY ALIVE through entire workflow
