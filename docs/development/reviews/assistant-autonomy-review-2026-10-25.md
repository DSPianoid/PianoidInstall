# Assistant autonomy — module review (dev-auto1, 2026-10-25)

Scope: PianoidInstall `feature/dev-auto1-assistant-autonomy` (`master..HEAD`, `tools/pianoid-assistant`) and
PianoidTunner `feature/dev-auto1-assistant-autonomy` (`dev..HEAD`, `src/components/Assistant`, `src/hooks/useAssistant.js`).
Change: `code` Auto (persisted), `renders_live` category, Autonomous mode (policy row, residual list, preset backup,
audit log), Undo turn in the pane. Level: module (/review), by the implementing agent.

### Top 5 Files in Scope by LOC
| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | tools/pianoid-assistant/service/session.js | 778 (was 713) | YELLOW |
| 2 | PianoidTunner/src/components/Assistant/AssistantPane.jsx | 244 | — |
| 3 | tools/pianoid-assistant/test/autonomy.test.js | 259 (test) | — |
| 4 | tools/pianoid-assistant/policy.js | 165 | — |
| 5 | tools/pianoid-assistant/service/prompt.js | 106 | — |

### Architectural Consistency
Layer audit: PASS — decisions stay in pure modules (policy.js, approvals.js, autonomy.js, planApproval.js); the session
wires them; the pane only shows the service's state and sends WS messages (no policy logic in the frontend; the
still-asks list and safety-net texts come from the service).
Server audit: PASS — assistant service only (127.0.0.1:3002); no backend / modal-adapter change.

### Authority Violations (P1)
| # | State | Owner | Violating Writer | Severity |
|---|-------|-------|------------------|----------|
None. `config.json` `autonomous` / `approvals`: written only by `AssistantSession` on a pane WS message; the model has no
tool for it. Audit log + preset backups: written only by the session.

### Concern Violations (P2)
| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|---------------|----------------------|----------|
| 1 | service/session.js | one assistant session: gate, confirms, activity, model, turns | +65 LOC of Autonomous wiring (view, settings, backup call); the rules themselves live in autonomy.js / presetBackup.js / auditLog.js | Medium (YELLOW growth; watch) |

### Patch / Workaround Findings
TODO/FIXME/HACK count in scope: 0
| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
| 1 | silent catch | service/auditLog.js `write` | Low (by design) | a write failure must not block a tool call; it is counted and surfaced (`auditError` -> pane chip) — FIXED to be visible |

### Module findings
| # | Principle | Severity | File | Description | Status |
|---|-----------|----------|------|-------------|--------|
| 1 | security / P1 | High | service/server.js `/ws` | the WS accepted any Origin: a web page in the user's browser could answer confirms, change approvals and (new) switch Autonomous mode on | FIXED: `verifyClient` = no Origin or a localhost Origin (test) |
| 2 | policy invariant | Medium | service/session.js canUseTool | `tainted: false` was hard-coded for registry tools (analysis / bug passed `this.tainted`): the tainted row could never win there once P7 sets it | FIXED: passes `!!this.tainted` |
| 3 | 2.2 visibility | Low | auditLog.js / pane | an audit write error was only kept in memory | FIXED: `autonomous.auditError` + "Audit log error" chip (shown on the next state message) |
| 4 | 2.1 SSOT | Low | AutonomousMode.jsx | the safety-net list was hard-coded in the pane (with the −24 dBFS number) | FIXED before review close: `SAFETY_NETS_TEXT` in autonomy.js, the cap from `LEVEL_CAP_DBFS` |
| 5 | design note | Info | autonomy.js | "own working copy" = the naming convention `presets/<name>_work.json` (no folders, no `..`); a user file with that name could be overwritten, but only after a backup | documented (README, prompt) |
| 6 | design note | Info | policy.js | a residual item still takes a user-ticked plan verdict (explicit user consent), else a hard confirm | intended, tested |

### Recent Changes Assessment
Coherent — A (code Auto) and B (renders_live) reuse the existing category machinery; C adds one policy row after the deny and
tainted rows, the plan row and the A2 envelope path are unchanged; the plan kill-switch proof still holds (state keys +
`autonomous`, a separate feature).

### Summary
3 findings fixed (1 High, 1 Medium, 1 Low), 1 Medium watch (session.js YELLOW). Overall: healthy.

---

## Addendum — local review of the provenance "own working copy" change (dev-auto1, 2026-10-25)

Scope: `tools/pianoid-assistant/service/presetOwnership.js` (NEW), `autonomy.js`, `service/session.js`,
`service/autoWrite.js`, tests, README / prompt; Tunner `AutonomousMode.jsx` text. Replaces finding 5 above (the
`presets/<name>_work.json` name rule): a path is own only when the assistant CREATED the file and its sha256 still
matches what it last wrote (manifest `~/.pianoid-assistant/owned-presets.json`).

### Top 5 Files in Scope by LOC
| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | service/session.js | 788 (was 779) | YELLOW |
| 2 | test/autonomy.test.js | 354 (test) | — |
| 3 | service/autoWrite.js | 178 | — |
| 4 | service/presetOwnership.js | 188 (NEW) | — |
| 5 | autonomy.js | 71 | — |

### Architectural Consistency
Layer audit: PASS — the decision input (ownership) is computed by one I/O module; autonomy.js stays pure (it takes the
fact); the pane only shows text. Server audit: N/A (assistant service only; reads the backend's `/save_preset`
`result.path`).

### Authority Violations (P1)
None. The manifest has one writer (`PresetOwnership.write`, atomic temp + rename); the session only calls it.

### Concern Violations (P2)
| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|---------------|----------------------|----------|
| 1 | service/autoWrite.js | permits + execution + undo of assistant writes | generic `guard` / `onOk` permit hooks (no preset knowledge in it) | none (within concern) |

### Patch / Workaround Findings
TODO/FIXME/HACK count in scope: 0. Two intentional catches in presetOwnership.js (`read`: corrupt JSON -> the corrupt
branch; `recordAfterSave`: an unresolvable reported path -> the mismatch branch, fail closed).

### Local findings
| # | Principle | Severity | Description | Status |
|---|-----------|----------|-------------|--------|
| 1 | P1 / fail-fast | Medium | the service resolves pianoid_middleware itself (`PIANOID_CORE_DIR` / `<Install>/PianoidCore`); if that ever differed from the backend's cwd, a path "new" here could be an existing file there, and it would be recorded as owned | FIXED: `recordAfterSave` compares the backend's reported absolute `result.path` with the checked real path; a mismatch (or no path) records nothing and turns ownership off (every later check `error`, audited `path_mismatch`) |
| 2 | TOCTOU | Low | the check runs in canUseTool, the save later (a confirm can take minutes) | FIXED: permit `guard` re-checks right before the executor runs (a creation must still be new, an owned file unchanged) -> 409 `changed` |
| 3 | 2.4 | Low | a missing manifest first classified a pre-existing file as `error` | FIXED: missing = owning nothing (`not_owned`), still audited; corrupt = `error` |
| 4 | watch | Medium | session.js YELLOW 788 (+9 wiring lines) | watch (as before) |
| 5 | design note | Info | a save the user approves over a not-own file runs but is not adopted (its stale entry is dropped; `not_adopted` audited) | intended, tested |

### Summary
Pass — 3 findings fixed (1 Medium, 2 Low), 1 Medium watch (session.js YELLOW). assistant `npm test` 128 / 127 pass /
1 skip; Tunner Assistant Jest 5 suites / 31 pass.
