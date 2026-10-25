# Local review — assistant notes / hand-off memory + saved-output reader (dev-mem1, 2026-10-25)

Scope: `feature/dev-mem1-assistant-notes` in PianoidInstall (`tools/pianoid-assistant`: analysis/{store,artifactTools,export,runPython}.js,
service/{notesStore,memory,session,autoWrite,server,prompt,home}.js, drivers/{sdk,fake}.js, mcp/server.js, approvals.js) and
PianoidTunner (`src/components/Assistant/{NotesPanel,AssistantPane}.jsx`, `src/hooks/useAssistant.js`). Level: local.

### Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | tools/pianoid-assistant/service/session.js | 812 | YELLOW (was 788; +24 wiring only) |
| 2 | PianoidTunner/src/components/Assistant/AssistantPane.jsx | 261 | — |
| 3 | tools/pianoid-assistant/drivers/sdk.js | 231 | — |
| 4 | tools/pianoid-assistant/service/notesStore.js | 204 | — (NEW) |
| 5 | tools/pianoid-assistant/service/memory.js | 185 | — (NEW) |

### Architectural Consistency

Layer audit: PASS — storage, policy and taint live in the assistant service; the pane only renders the service's `notes`
and sends `note_update` / `note_delete`; the sandbox never sees the notes folder.
Server audit: N/A (the assistant service on :3002; no backend route added).

### Authority Violations (P1)

None. Turn / session taint: `AssistantSession` (`taintTurn`, `sessionTainted`) is the only writer; memory.js calls it. Notes
files + index: `NotesStore` only (the model through the permit-gated handler, the user through the WS pane ops, both via
the store). Artefact `tainted`: written once by `createArtifact`; the MCP export takes it from the executor permit (the
session's value at permit time), not from its own guess. The `memory` approval mode: approvals.js / config.json like every
category; no note text can reach it.

### Concern Violations (P2)

None. store.js gained the read side of its own store (list, title, taint rule); artifactTools.js = the two tools' shaping;
notesStore.js = storage + caps + lint; memory.js = the gate / handlers / start blocks of the memory tools; session.js only wires.

### Patch / Workaround Findings

TODO/FIXME/HACK count in scope: 0. Empty catches: all are documented skip / rebuild paths (a corrupt note or meta is skipped
and counted, a corrupt index is rebuilt, an unreadable path is refused); none hides an error the caller needs.

| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| — | — | — | — | none |

## Local Review: findings

| # | Principle | Severity | Description | Status |
|---|-----------|----------|-------------|--------|
| 1 | 2.4 / fail-closed | Medium | `TAINT_TRACKED_SINCE` = 2026-10-25T13:00Z: artefacts that the user's CURRENT (pre-merge) service writes after that time have no `tainted` field and will read as tainted after the merge (reading one then makes the turn ask for every action). Fail-closed by design (brief: "unknown = not tainted only if written before this change"); no taint source existed before this change, so they are in fact clean. | Open — decision: set the constant to the merge time at Step 10 (one line) or accept |
| 2 | lean / safety | Low | A note permit allowed by the policy but never executed (turn stopped) stayed in the map. | Fixed: `stop()` clears it (+ test) |
| 3 | UI consistency | Low | The memory confirm showed the body twice (the note box + the raw JSON args). | Fixed: the JSON omits title / body for `memory` |
| 4 | C4 | Medium (watch) | session.js 812 LOC (YELLOW). The new feature added only wiring (+24); the next assistant feature should move the turn / context block (`turn`, `context`, `environment`) out first. | Watch |
| 5 | security | Low (likely) | `read_artifact` returns the whole meta (without files) uncapped; a rig-files export meta lists every original name (a few KB). Inside the 64 KB tool budget in practice. | Accept |
| 6 | design | Info | A tainted note in the session-start memory taints every turn of that session (brief). A pinned tainted hand-off therefore taints every new session until the user edits it (pane: "Save (mark reviewed)") or deletes it — documented in the README and the chip tooltip. | By design |

Checked and fine: traversal (id regex, listed name only, real path inside the artefact folder AND the folder inside the store —
a junctioned artefact folder is refused; mutation-checked), closing-tag injection in the untrusted wrapper, permit = exact
canonical input once, no `delete_note` tool (canUseTool + PreToolUse deny it), lint on the gate and in the store, atomic
writes (rename failure leaves the old note, no temp files), pruning never touches the pinned hand-off, MCP export strips
`turn_tainted` and fails closed without it.

### Summary

Pass after fixes — 6 findings (0 critical, 0 high, 2 medium: #1 open for a decision, #4 watch; 3 low: 2 fixed, 1 accepted; 1 info).
