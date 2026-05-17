# Controller Agent Role Proposal

**Status:** Draft for review (2026-05-05, in response to Telegram msg 1682)
**Driver request:** "Review orchestrator + dev working pipeline. There is the controller role which is not defined clearly and never actually used. Controller should be involved in all significant development processes, especially when more then one dev agent involved. Propose and clarify the role"
**Scope:** Skill definitions in `.claude/commands/` — `orchestrator.md`, `dev.md`, `multitask.md`, `fn.md`. No source-code or runtime impact.

---

## TL;DR — Recommendation

Promote the controller from a stub mention to a first-class **read-only compliance monitor**, spawned **once per orchestrator session at orchestrator startup** and kept alive for the full session lifetime. The controller never edits source, never spawns or kills agents, never messages the user — it watches `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/`, and `git status` and sends graduated alerts (warn → escalate → halt) to the orchestrator. The orchestrator retains all authority for user communication and dispatch.

The controller has **three complementary monitoring paths**:

1. **Per-event invariant checks** (Sections 5a–5d, 5e, 8a–8c): catches workflow violations the moment a watched log file is updated. Examples: late Step 0, unlocked dirty file, premature Phase 2, missing build verification.
2. **Periodic 30-min sweep** (Section 8d, supported by failure-mode catalogue Section 12): catches agents that **stopped advancing** — the dominant stall pattern is a tool call that triggered a CLI permission prompt invisible to the Telegram user (per CLAUDE.md "Known gaps in `bypassPermissions`"). The sweep reads each agent's session log for unmatched `[BASH-CALL]` / `[MCP-CALL]` markers and classifies the stall by the catalogue.
3. **Continuous sliding-window scan** (Section 8e): catches agents that **investigate in the wrong order** — specifically, dev agents who skip the CLAUDE.md "Documentation-First Rule (MANDATORY)" by grepping/reading source code without consulting `docs/` first. The scan slides over each agent's `[READ]`/`[GREP]` marker stream and flags windows where N=3 source-reads occurred with no preceding doc consultation.

Together the three paths close the gap: every category of agent failure either produces a log event (per-event), produces silence (periodic), or produces a *sequence* of events that violates an investigative-order rule (sliding-window). The controller catches all three.

The only existing references in `orchestrator.md` (`:455` and `:782`) are forward-pointers to a "Controller Agent" section that does not exist. This proposal fills that gap.

**Lifecycle rationale (permanent-for-session vs bounded-by-dev-agents).** Both models work; the proposal chooses permanent-for-session because (1) the bounded model creates a race window between "last dev agent CLOSED" exit and the next dispatch, during which orchestrator-initiated edits (e.g., `/update-docs` triggered after a `/review` finding) would be unwatched and the lock-invariant can drift; (2) avoiding that race forces the orchestrator to track controller-state on every dispatch, adding complexity to the very decision the user said is currently unclear; (3) the controller is event-driven (Monitor-subscriptions on agent log files), so its idle context cost is one slot, not active tokens — the efficiency advantage of the bounded model is mostly theoretical. Simpler invariant beats marginal savings when the goal is clarity.

---

## 1. Current State — Where "Controller" Already Appears

Two references in `orchestrator.md`, neither implemented:

| File:Line | Quote |
|---|---|
| `.claude/commands/orchestrator.md:455` | `5. **Controller agent.** The team should include a permanent controller agent whose job is to monitor /dev workflow compliance. See "Controller Agent" section below.` |
| `.claude/commands/orchestrator.md:782` | `\| Not verifying agent created session log + acquired locks \| The controller agent handles this. If no controller, check within ~2 min that docs/development/logs/dev-*.md exists and MODULE_LOCKS.md has the agent's entry. Kill and respawn if not. SEVERE VIOLATION. \|` |

There is no "Controller Agent" section in `orchestrator.md`, no controller block in `dev.md`, no controller mention in `multitask.md` or `fn.md`. The 2026-04-21 stalled sessions `dev-7a2b-...-STALLED-AFTER-STEP0.md` and `dev-e6b9-...-STALLED-ON-PHASE-E.md` are exactly the failure mode line :782 says the controller would catch — but the controller does not exist, and the orchestrator-side fallback ("check within ~2 min") is itself unimplemented because the orchestrator has no `Monitor` loop after dispatch.

This is a documentation hole AND an operational hole.

---

## 2. Evidence From Dev Session Logs

Sampled 7 sessions covering solo, paused-by-conflict, multi-agent-overlap, and stalled-pre-edit. In each, a controller would have caught a real issue early.

| Log (in `logs/archive/`) | What happened | What a controller would have caught |
|---|---|---|
| `dev-7a2b-2026-04-21-123010-STALLED-AFTER-STEP0.md` | Agent registered Step 0, then never logged Step 1. No locks acquired, no edits, but WIP entry persisted. | **Tier-1 warn at +2 min:** "dev-7a2b registered in WIP, no Step-1 entry in log, no locks acquired. Heartbeat stale." Orchestrator could have respawned or marked orphaned before user noticed. |
| `dev-e6b9-2026-04-21-143819-STALLED-ON-PHASE-E.md` | Same pattern — Step 0 done, then silence. Filename baked the diagnosis in. | Same as above. |
| `dev-833f-2026-04-30-193055.md` | Phase A produced two consecutive wrong fixes (axis semantics + value scale) before measurement-based diagnosis succeeded on a recovery instance with `bypassPermissions`. | **Tier-2 escalate** when the agent edited code paths whose Data Model Card had inferred-only rows. The CLAUDE.md "High-stakes inference categories" rule postdates this incident; controller could enforce it going forward by gating Step 4 on a non-empty Data Model Card. |
| `dev-0d64-2026-04-18-184348.md` (W4-B refactor) | Coexisted with dev-c59a doing W4-A on the same file (`modal_adapter.py`) — disjoint regions but same file. dev-0d64 noted dev-c59a's "unstaged routes.py error-classification changes" leaked into post-change tests. | **Tier-1 warn:** "dev-c59a has unstaged changes in `routes.py` that fall outside its declared lock list — file in repo is dirty without lock match." Would have surfaced the leak before dev-0d64's Step 5 picked it up. |
| `dev-md01-2026-05-03-234854.md` (MIDI dedup) | Parallel safety-net agent dev-9a47 dispatched simultaneously. dev-md01 needed `backendServer.py`; dev-9a47 had it. dev-md01 waited until dev-9a47 wrapped before locking. | **Tier-1 informational pulse** when both agents are on the same file (one held lock, the other queued). Would let the orchestrator schedule the queued one's first edit immediately after lock release without manual polling. |
| `dev-3st1-2026-05-04-184115.md` (nuclei-merge tracking) | Wanted to wire a 1-line dispatcher edit in `esprit_runner.py`, which dev-ir01 held the lock on for an unrelated band-config change. dev-3st1 chose to defer rather than block. | **Tier-1 warn:** "Cross-agent file proximity — dev-3st1's plan touches `esprit_runner.py` held by dev-ir01. Different sections, but same file." Orchestrator could surface this to the user as a coordination decision instead of dev-3st1 deciding alone. |
| `dev-tm-8d62-2026-04-28-171541.md` (test-mode contract) | Phase-A investigation, no locks, no edits — by design. Agent ran 4+ hours, surfacing decisions to orchestrator only at phase boundaries. | **Tier-1 informational:** "dev-tm-8d62 in WIP, no locks acquired, log advancing — confirmed investigation mode." This is the *quiet* case the controller should NOT flag as stale. The pulse logic must distinguish "investigating without locks" (OK, log advancing) from "stalled at Step 0" (alert, log frozen). |

---

## 3. Anti-Pattern Coverage (from `orchestrator.md` table at `:765–:795`)

Of the 22 rows in that table, **9 are directly controller-monitorable**:

| Row | Controller check |
|---|---|
| Reading source files to "quickly check" something | Periodic `git log` on the orchestrator's session-since-start; if the orchestrator's process touches `Read` on PianoidCore / PianoidBasic / PianoidTunner source files, controller reports. (Detection is heuristic — see Section 9 limitations.) |
| Editing code directly because "it's just one line" | Controller diff on `git status` between dispatches: if any source file becomes dirty without a corresponding agent's lock, **Tier-3 halt**. |
| Making a "quick fix" directly after noticing a problem | Same Tier-3 — unlocked dirty file is the unconditional invariant break. |
| Reporting task complete before user confirms | Controller reads dev-agent log; if `Status: Complete` and Phase 2 actions ran (log archived, WIP cleaned) without an orchestrator-recorded approval message, **Tier-2 escalate**. |
| Not verifying agent created session log + acquired locks | The `:782` row already attributes this to the controller. **Tier-1 warn at +2 min, Tier-2 escalate at +5 min.** |
| Skipping post-completion verification | Controller checks the four post-completion invariants from `orchestrator.md` "What to Verify After Agent Reports": commit prefix, locks released, log not archived yet, WIP entry present. |
| Skipping post-kill cleanup | If TaskStop fires on a dev agent and the agent's locks/WIP/log are still present 30s later, **Tier-2 escalate**. |
| Generating new agent ID for recovered/restarted agent | Controller knows all agent IDs in the session; if a new ID appears with task description matching a paused agent's, **Tier-1 warn**. |
| Ignoring stale locks/WIP on startup | Already in orchestrator Step 1.5; controller re-runs the same scan periodically (every 5 min) and pulses results, so a session-long drift is caught even though Step 1.5 only runs at start. |

The remaining 13 rows are about orchestrator dispatch decisions (skill choice, team-vs-non-team, ID persistence, kill scope) — not the controller's domain.

---

## 4. Role Definition

The **controller** is a permanent, read-only sub-agent of the orchestrator. It exists for one purpose: enforce the workflow invariants documented in `orchestrator.md`, `dev.md`, `multitask.md`, and `fn.md` while dev agents run in parallel or in sequence. It watches the four authoritative state files (`MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, `docs/development/logs/*`, repo `git status`) and reports compliance pulses + violation alerts to the orchestrator. It has no authority to edit, dispatch, kill, or message the user. All actions on its findings are taken by the orchestrator.

**One controller per orchestrator session, lifetime equal to the orchestrator session itself.** Spawned alongside the orchestrator at session start (not lazily on first `/dev`); exits when the orchestrator session ends (`/orchestrator stop`, VS Code reload, or controller kill). It is always present even between dev-agent dispatches — this catches the cases where the orchestrator itself, an `/update-docs` agent, or a `/review`-triggered ad-hoc fix mutates files outside a `/dev` session. See TL;DR for the "bounded vs permanent" trade-off.

---

## 5. Responsibilities — Concrete Checks

The controller enforces invariants along **four functional axes**:

| Axis | Section | Catches | Detection mode |
|---|---|---|---|
| Per-agent lifecycle | 5a | Step-0 SLA, locks, commit prefix, premature Phase 2 | event-driven (Monitor on log file) |
| Cross-agent | 5b | overlapping locks, sequential nvcc, untracked dirty files | event-driven + file-update of `MODULE_LOCKS.md` / `git status` |
| Workflow-specific | 5c | multitask wave honesty, fn parent-lock inheritance, auto-trigger compliance | event-driven |
| Dev anti-patterns | 5d | the 24 dev-discipline checks | event-driven |
| **Stale-agent + permission-stall** | **Section 8d (mechanism) + Section 12 (failure-mode catalogue)** | **agents that stopped advancing — long-running bash, TTY-blocking, system-PID taskkill, MCP OAuth gates** | **periodic 30-min sweep** |
| **Documentation-First rule** | **Section 8e (algorithm) + Section 5d "Documentation-First skipped" row** | **agents grepping/reading source code without first consulting `docs/` — per CLAUDE.md "Documentation-First Rule (MANDATORY)"** | **continuous, event-driven (sliding window over `[READ]`/`[GREP]` markers)** |

Axes 5a–5d catch *what the agent did wrong* (substantive workflow violations) on the **event-driven** path. The stale-agent axis catches *what the agent stopped doing* — silence with no violation produced — on a **periodic-sweep** path. The Documentation-First axis catches *how the agent investigates* — the order in which it consults docs vs. source — on a **continuous sliding-window** path over the `[READ]`/`[GREP]` marker stream. The three paths are complementary:

- The event-driven path can never detect "agent has been silent for 30 minutes" because there is no event.
- The periodic path can never detect a same-second invariant break because it only fires every 30 min.
- The continuous sliding-window path is event-driven but evaluates over a *sequence* of recent events, not a single one — distinct from the per-event invariant checks in 5a–5d.

Together they close the coverage: every category of agent failure either produces a log event (caught in 5a–5d), produces silence (caught by Section 8d's periodic sweep classifying patterns from the Section 12 catalogue), or produces a *sequence* of events that violates an investigative-order rule (caught by Section 8e's sliding-window scan).

**Two rule sources feed 5a–5d:** **(1) the orchestrator's own anti-patterns table at `orchestrator.md:765-795`** (covered in Section 3 above; mapped here in 5a–5c), and **(2) the `/dev` skill's own discipline rules** (covered in Section 5d below; many of these are not in the orchestrator table because they govern the dev agent's internal workflow rather than the orchestrator's dispatch decisions). Section 5d cites `dev.md` line numbers for traceability.

### 5a. Per-agent lifecycle invariants

For each dev agent the orchestrator dispatches, the controller verifies:

- **Step 0 within 120 seconds.** Within 2 minutes of spawn, a log file matching `docs/development/logs/<agent-id>-*.md` must exist with at least the header block and "Step 0: Initialize Session" entry. *Tier-1 warn at +120s, Tier-2 escalate at +300s.*
- **WIP registration within 120 seconds.** `docs/development/WORK_IN_PROGRESS.md` `## Active Dev Sessions` table must contain a row for the agent ID. *Same tiers as above.*
- **Lock acquisition before Step 4 edits.** Before any source file modified by the agent appears in `git status`, `MODULE_LOCKS.md` must contain a row for the agent ID listing that file. Detection: snapshot `git status --short` on each repo; cross-reference dirty files against the locks table. *Tier-3 halt if an unlocked dirty file is found.*
- **Commit prefix discipline.** All commits made during the session must start with `[<agent-id>]`. *Tier-1 warn on any commit by an active agent that violates this.*
- **No premature Phase 2.** If the agent's log shows Step 10a Phase 2 actions (log archived to `logs/archive/`, WIP row removed) and the orchestrator has not relayed user approval since the corresponding Phase 1 stop, *Tier-2 escalate.*
- **Cleanup on exit.** When the agent transitions to CLOSED, KILLED, or RESET: locks released, WIP row removed (or paused-marked), log appropriately archived/preserved. *Tier-2 escalate on residue.*

### 5b. Cross-agent invariants (active when ≥2 dev agents are alive)

- **No overlapping locks.** No two agents may have the same file in their `MODULE_LOCKS.md` rows. *Tier-3 halt — repo invariant.*
- **No file-proximity surprise.** When two agents lock different files in the same module (same directory, same `.cu` file family, same Python class graph), informational pulse to orchestrator so it can flag the coordination need. *Tier-1 informational, not a violation.*
- **No untracked dirty files.** A dirty file in `git status` whose path is in *no* active agent's lock list is a repo-invariant break. *Tier-3 halt.*
- **Sequential nvcc.** If two active agents both classified as needing `--heavy` CUDA build, the multitask conflict rules should have prevented parallelism — if it slipped through, *Tier-3 halt* before either runs `build_pianoid_cuda.bat`.

### 5c. Workflow-specific invariants

- **`/multitask` wave honesty.** When `/multitask` is the dispatcher, controller verifies wave-N agents are CLOSED before wave-N+1 spawns. *Tier-2 escalate.*
- **`/fn` parent-lock inheritance.** When a `/fn` sub-agent edits a file, the file must be in the *parent dev agent's* lock list (not the fn agent's own — fn does not acquire locks per `fn.md`). *Tier-2 escalate.*
- **Auto-trigger compliance.** If a non-`/dev` skill (e.g., `/update-docs`) edits `.cu`, `.cpp`, `.cuh`, `.h`, or `setup.py`, *Tier-2 escalate* — that is the explicit violation called out in `.claude/CLAUDE.md` "Auto-Trigger Rules".

### 5d. Dev anti-patterns the controller catches

These are violations of `/dev`-specific discipline. They are NOT in the orchestrator's `:765-795` table because they govern the dev agent's internal workflow. The controller enforces them by reading dev-agent session logs (live, via `Monitor`) and cross-referencing with `git status`, `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, and `git log`.

**Step 0 — Initialize Session (`dev.md:40-114`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Session log file MUST be created within 120s of spawn | `dev.md:54-71` ("Create Session Log") + the Logging rule at `:104-114` | **Tier-1** at +120s, **Tier-2** at +300s | `Glob docs/development/logs/<agent-id>-*.md` after dispatch timer expires |
| WIP entry MUST be added to `## Active Dev Sessions` table | `dev.md:75-89` ("Register in WIP") | **Tier-1** at +120s, **Tier-2** at +300s | Read `WORK_IN_PROGRESS.md`, grep for agent-id |
| Each step MUST be logged BEFORE starting (not after) | `dev.md:73` ("Logging rule: Log each step to your session log as you start it") | **Tier-1** if a `git status` change appears under the agent's name with no corresponding step entry in its log | Diff log entries vs git activity |
| Recovered/restarted agents MUST reuse the original ID | `dev.md:50-50` (Agent ID persistence) + `:921` ("MUST reuse the original agent's ID") | **Tier-1 warn** when a fresh agent ID appears with task description matching a Paused entry | Cross-ref WIP "Paused" entries vs new dev-* IDs |

**Step 1 — Understand Context (`dev.md:188-237`) — and the cross-cutting Documentation-First Rule**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| **Documentation-First skipped** — every investigation phase must consult `docs/` BEFORE grepping or reading source files | `.claude/CLAUDE.md` "Documentation-First Rule (MANDATORY)" + `dev.md:188-201` (Step 1 docs-first lookup order) | **Tier-1** first occurrence per session (warn — agent may have missed it). **Tier-2** if it recurs in the same session (escalate — pattern of skipping docs). The check is intentionally lenient because the agent may consult its own training/memory without a fresh read; the goal is to catch the *pattern* of grep-first behaviour, not isolated cases | Sliding-window scan over `[READ]` / `[GREP]` markers. See **Section 8e** for the full algorithm, exemptions, and windowing parameters. Detection requires checks 39 + 40 (READ/GREP marker discipline) to be in place |

**Step 1b — Environment Control (`dev.md:239-344`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| NEVER blanket-kill `python.exe` / `node.exe` | `dev.md:247` ("CRITICAL: Only kill processes bound to Pianoid ports") | **Tier-3 halt** if `tasklist`/log shows blanket kill (heuristic — see limitations) | Grep dev-agent log for `taskkill //F //IM python.exe` or `node.exe` |
| MUST use `PianoidCore/.venv/Scripts/python`, never system Python | `dev.md:293` ("Always use PianoidCore/.venv/Scripts/python, NEVER system Python") | **Tier-2** if log shows `C:\Python312\python.exe` invocation | Grep log |
| Servers MUST be cleaned up before exit | `dev.md:325-344` ("Clean Up After Yourself MANDATORY") | **Tier-2 escalate** if agent transitions to CLOSED but ports 5000/5001/3000/3001 still LISTENING with no other agent owning them | `netstat -ano` post-close |
| Backend startup must NOT retry blindly past 3 attempts | `dev.md:299` ("If startup fails 3 times, report the log contents and stop — do not loop indefinitely") | **Tier-1 warn** if log shows >3 backend-start retries in <5min | Count log entries |

**Step 4 — Acquire Module Locks and Edit Code (`dev.md:380-503`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| **Lock-before-edit invariant** — never edit an unlocked file | `dev.md:421` ("Before writing to ANY file not already in your lock list, you MUST first add it to MODULE_LOCKS.md ... never edit an unlocked file") | **Tier-3 halt** | Snapshot `git status --short` per repo; cross-ref against `MODULE_LOCKS.md` |
| Pre-implementation Data Model Card MUST exist before fix code | `dev.md:391-398` ("Before writing the first line of fix code, produce a Data Model Card in your session log") | **Tier-2 escalate** if log shows source-file edit without a Data Model Card section | Grep agent's log for "Data Model Card" before first non-doc edit |
| File-size watch (C4): no significant additions to RED files (>1000 LOC) without split plan | `dev.md:402` + CLAUDE.md C4 threshold | **Tier-1 warn** when an edit raises a file's LOC across 500/1000 boundary | Run `wc -l` on touched files post-edit, compare to pre-edit baseline |
| Pre-build hygiene: kill `.pyd`/DLL holders before building | `dev.md:451-467` (Pre-build check MANDATORY) | **Tier-2 escalate** if log shows `--heavy` / `--light` invocation without a preceding `tasklist //M pianoidCuda...` check | Grep log sequence |
| Use canonical `build_pianoid_cuda.bat`, NEVER `pip install --force-reinstall` | `dev.md:33-33`, `:492-496` ("Do NOT fall back to a manual pip install") | **Tier-2 escalate** if log shows `pip install ... pianoid_cuda/` after a `--heavy` build failure | Grep log |
| Verify the rebuild landed (`grep -a` marker check) | `dev.md:35` ("Verify the rebuild landed") | **Tier-1 warn** if Step 5 starts without a Step 4 verify entry | Read log step boundaries |
| Multi-stage: commit intermediate work; release locks on completed files | `dev.md:425-430` (Multi-Stage Session Management) | **Tier-1 informational** when a single agent has held 5+ files in lock list for >30 min without intermediate commits | Snapshot lock-row size + git log |

**Step 4b — `/fn` Sub-Agent Delegation (`dev.md:504-637`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Tests MUST be written FIRST by the dev agent (not the fn sub-agent) | `dev.md:520-540` ("Prepare tests FIRST (dev agent responsibility)") | **Tier-1 warn** if an `Agent({...prompt: ".../fn skill..."})` dispatch appears in the parent's log without a preceding test-file edit | Grep parent log for fn-spawn vs preceding test-file modifications |
| `/fn` sub-agent inherits parent's locks, does NOT acquire its own | `dev.md:551` ("The sub-agent inherits locks from the parent; it does NOT acquire its own") | **Tier-2 escalate** if a `fn-*` agent ID appears in `MODULE_LOCKS.md` with rows of its own | Read locks |
| Parent MUST archive `fn-*` logs after incorporation | `dev.md:594-597` ("Clean up sub-agent logs") | **Tier-1 warn** if `fn-*-*.md` files persist in `logs/` (non-archive) >10 min after their parent dev agent's Step 5 | Glob + age check |
| Parent MUST handle fn-failures (no proceeding to Step 5 with failing sub-agents) | `dev.md:589-592` | **Tier-2 escalate** if parent log shows Step 5 entry while fn log shows Failed status | Cross-ref logs |

**Step 5 / Step 6 — Tests + Debug (`dev.md:639-681`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Baseline test MUST run before any code edit | `dev.md:346-365` (Step 2) + `:639` (Step 5 compares against baseline) | **Tier-1 warn** if Step 4 edit appears without a preceding `/tmp/baseline_perf.log` entry in the log | Grep log for "baseline" before "Step 4" |
| Hard-fail regression criteria must trigger Step 6, not commit | `dev.md:657-659` ("GPU mean increase > 10% ... any new test failure → Step 6") | **Tier-2 escalate** if Step 10a Phase 1 starts with regression metrics in the most recent perf table | Parse log perf tables vs baseline |
| Debug loop max 5 iterations before stopping | `dev.md:673` ("Iterative loop (max 5 iterations)") + `:681` ("After 5 failed iterations, stop and report findings") | **Tier-1 warn** at iter 6, **Tier-2** at iter 8 | Count Step 6 iteration markers in log |

**Step 7 — Audio Verification (`dev.md:683-718`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Audio-affecting changes MUST invoke `/test-ui` (audio_off) or `/diagnose` (audio_on) per strict-A1 contract | `dev.md:14-19` (Audio Verification Routing) + `dev.md:685-704` | **Tier-2 escalate** if agent reaches Step 10a Phase 1 having edited any of: `MainKernel.cu`, excitation files, hammer/string params, `volume_coefficient`, etc., without a `/test-ui` or `/diagnose` invocation in the log | Grep log + match against affected-file allow-list |

**Step 8 — Update Documentation (`dev.md:719-767`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Step 8 MUST run before any 10a/10b/10c exit | `dev.md:721` ("This step is mandatory for ALL exit procedures") | **Tier-2 escalate** if Step 10a/b/c starts with no Step 8 entry in log | Step-marker order check |
| Doc-gap closure (or filed WIP item with owner+ETA) is part of THIS session | `dev.md:725-728` ("Doc-gap closure MANDATORY") | **Tier-1 warn** if log mentions "doc gap" / "should be documented" without either updating the doc or filing a WIP item before commit | Grep log + check WIP additions |
| C4 regression check: cross-threshold files MUST update `CODE_QUALITY.md` God Objects list | `dev.md:734` | **Tier-1 warn** if a file in scope crossed 500 or 1000 LOC and `CODE_QUALITY.md` was not edited | Pre/post `wc -l` cross-ref |

**Step 10 — Exit Procedures (`dev.md:800-1005`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Commits MUST include `[<agent-id>]` prefix | `dev.md:805-810` (Commit Convention) | **Tier-1 warn** for first occurrence per session, **Tier-2 escalate** on repeat | `git log` author-since-spawn vs commit message regex |
| **Phase 1 MUST stop and report**; Phase 2 only after explicit user approval | `dev.md:824` + `:850` ("STOP HERE. Report changes ... Do NOT proceed to Phase 2 until explicitly told to") | **Tier-2 escalate** if Phase 2 actions (log moved to `logs/archive/`, WIP row removed) appear without an orchestrator-relayed approval message | Diff log archive timestamp vs orchestrator's approval-relay timestamp |
| 10b Reset MUST revert AND release locks AND delete log AND clean WIP | `dev.md:862-879` | **Tier-2 escalate** on partial reset (one of those four steps missing 5+ min after declared reset) | State diff |
| 10c Pause MUST commit/stash AND write Pause Snapshot AND release locks AND mark WIP "Paused" | `dev.md:881-914` | **Tier-2 escalate** on missing Pause Snapshot section in log | Grep log section headers |
| 10e Restart After Lock Conflict MUST acknowledge blocking agent's changes | `dev.md:996-1003` ("Restart After Lock Conflict ... append to log") | **Tier-1 warn** if a previously paused agent resumes without the "Restart After Lock Conflict" log section | Grep log |

**Step 9 — Merge Feature Branch (`dev.md:768-798`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Feature branch must NOT be left unmerged at session end | `dev.md:796-798` ("Do not end the workflow with commits only on a feature branch") | **Tier-2 escalate** if agent reaches CLOSED with commits on `feature/*` that are not present on `dev` | `git log dev..feature/*` per repo |

**Cross-cutting — Audio mode routing (`dev.md:12-19`)**

| Rule | Source | Severity | Detection |
|---|---|---|---|
| Synthesis-output change → `/test-ui` audio_off; mic-engaging change → `/diagnose` audio_on | `dev.md:14-17` + CLAUDE.md "Audio Verification Rule" | **Tier-2 escalate** on wrong mode (e.g., calibration change verified via `/test-ui` instead of `/diagnose`) | Inspect agent's verification choice vs touched-file class |

**Coverage summary.** 25 dev-discipline checks total: 4 Step 0, 1 Step 1 (Documentation-First skipped — added in this revision), 4 Step 1b, 7 Step 4, 4 Step 4b, 3 Step 5/6, 1 Step 7, 3 Step 8, 5 Step 10, 1 Step 9, 1 cross-cutting audio. Combined with the 9 orchestrator-anti-pattern checks from Section 3, plus the 4 stale-monitoring + Documentation-First helper checks (34–37, 38–40 in Section 5e.2), the controller's invariant catalogue is **34 distinct numbered checks** (1–37 in 5e.2 with check 38–40 being the Documentation-First trio; one of those is a status row, so substantively 39 actionable checks).

**Detection limitations.** Several checks rely on grep-style pattern matching of agent log entries (e.g., "did this agent log a Data Model Card before its first edit?"). The agents are well-behaved logging citizens by design (`dev.md:73` makes it mandatory), so log-pattern checks are reliable in practice but not adversarially robust. A few checks (like blanket `taskkill //F //IM python.exe`) are heuristic — they catch the common form but a sufficiently determined misuse can evade. For high-stakes invariants (lock-before-edit, sequential nvcc, no overlapping locks), detection uses ground-truth file-system state (`git status`, `MODULE_LOCKS.md`) rather than log patterns. Section 5e proposes explicit markers to upgrade many of these grep-based checks to direct signal reads.

### 5e. Dev logging additions required for reliable monitoring

The controller's enforcement is only as good as the signals dev agents emit. This sub-section walks every check in Sections 5a–5d and asks: **what specific log/file state does the controller read to detect this violation, does `dev.md` already produce that signal, and what's missing?** Where the current convention forces the controller to grep arbitrary text or guess from absence of logs, we propose an explicit marker.

#### 5e.1. Current dev.md logging conventions (baseline)

`dev.md` already mandates a structured session log. The relevant existing rules:

| Convention | Source | Format |
|---|---|---|
| Session log file path | `dev.md:54-55` | `docs/development/logs/${AGENT_ID}-$(date +%Y-%m-%d-%H%M%S).md` |
| Header block | `dev.md:60-71` | `# Dev Session Log` + Agent / Task / Started / Plan / Status fields |
| Step heading | `dev.md:108-113` | `### Step N: <Step Name> — <HH:MM>` (local time, no date) |
| Logging order | `dev.md:73`, `:104-114` | "Log each step BEFORE starting" — narrative |
| Files Modified list | `dev.md:430` | Free-form list, must be kept current |
| Data Model Card | `dev.md:391-398` | Structured table — already explicit |
| Pause Snapshot | `dev.md:899-909` | Structured block — already explicit |
| Recovery / Restart sections | `dev.md:962-967`, `:996-1003` | Structured blocks — already explicit |

The four structured signals (header, Data Model Card, Pause Snapshot, Recovery/Restart blocks) are reliable and need no change. The two narrative signals (step headings, Files Modified list) and the absence of action-level markers (Step-0 completion, lock acquire/release, build start/end, fn-spawn, server lifecycle, edit operations, Phase 1/2 transitions) are what the controller cannot rely on without additions.

#### 5e.2. Signal × check matrix

For each anti-pattern check from Sections 5a–5d, this table records the signal the controller reads, whether dev.md produces it today, and what improvement is required.

**Notation in "Logging improvement" column:**

- *None* — current dev.md is sufficient
- *MARKER:* `[STAMP]` — propose a new explicit marker the agent must emit
- *FORMAT:* — propose a structural change to an existing convention (e.g., timestamp resolution)

| # | Anti-pattern (Section 5 ref) | Signal needed | Current dev.md support | Logging improvement |
|---|---|---|---|---|
| 1 | Late Step 0 — log file + WIP entry within 120s (5d Step 0) | Single timestamp inside the log marking when Step 0 was actually completed (file existence is necessary but not sufficient — partial log creation must not fool the controller into thinking Step 0 is done) | File exists + free-form Step 0 narrative entry | *MARKER:* `[STEP-0-COMPLETE] {ISO 8601 timestamp}` as the FIRST line under "## Actions" once log file, WIP row, and lock list are all in place. Controller computes spawn → STEP-0-COMPLETE delta; alerts at +120s, escalates at +300s |
| 2 | Log-each-step-before-starting (5d Step 0) | Step heading written before any tool call that does that step's work | `dev.md:73` requires it but enforcement is narrative. Heading format `### Step N: ... — HH:MM` is matchable. | *FORMAT:* require ISO 8601 UTC timestamp on every step heading: `### Step N: <Name> — 2026-05-05T12:30:22Z`. Local `HH:MM` (line 109) is ambiguous across day boundaries; controller cannot compute "Step 0 took >120s" reliably without a date |
| 3 | Recover/restart agent ID reuse (5d Step 0) | New agent's log header `Agent:` field cites a Paused entry's ID | `dev.md:50` requires reuse; `:177-181` requires `**Resuming:** [<OLD_AGENT_ID>...]` link in the new log | *None* (existing Resuming line is matchable) |
| 4 | Blanket `taskkill //F //IM python.exe` / `node.exe` (5d Step 1b) | Bash command text in log | Currently appears as informal `### Step 1b — Environment` narrative entries | *MARKER:* `[STEP-1B-KILL] port=<N> pid=<N>` when killing a port-scoped process; the **absence** of this marker around a `taskkill` invocation is the smoking gun for blanket-kill |
| 5 | Use of system Python instead of venv (5d Step 1b) | Bash command text shows `C:\Python312\python` or `python` (no venv prefix) | Free-form Bash logs | *MARKER:* `[STEP-1B-VENV-CHECK] interpreter=<absolute path>` once per session before first venv invocation; controller alerts if any subsequent `python` Bash call lacks the matching prefix |
| 6 | Server cleanup on exit (5d Step 1b) | Ports 3000/3001/5000/5001 are not LISTENING with PIDs from this agent at CLOSED | Free-form `Cleanup` narrative; no port-PID record | *MARKER:* `[SERVER-START] role=<backend\|frontend\|adapter> port=<N> pid=<N>` and `[SERVER-STOP] port=<N> pid=<N>` symmetric pair. Controller verifies every START has a matching STOP before CLOSED |
| 7 | Backend retry max-3 (5d Step 1b) | Count of `[SERVER-START]` for the same port within 5 min, with intervening errors | Free-form | Falls out of (6): controller counts `[SERVER-START] port=5000` events within 5 min |
| 8 | Lock-before-edit invariant (5d Step 4) | Dev agent's record of acquire/release events PLUS ground-truth `MODULE_LOCKS.md` rows vs `git status --short` dirty files | `MODULE_LOCKS.md` is structured; git is direct. But the *moment* the agent thinks it acquired/released a lock is unrecorded — divergence between agent-intent and file-state is invisible | *MARKER:* `[LOCK ACQUIRED] {file}` when adding a file to the lock row; `[LOCK RELEASED] {file}` when removing it. Controller cross-references against `MODULE_LOCKS.md` reads — divergence (marker says acquired but file row absent, or marker says released but row still present) is a Tier-2 escalate |
| 9 | Pre-implementation Data Model Card (5d Step 4) | `## Data Model Card` section in log present before first source-file Edit | `dev.md:391-398` requires it but does not require any specific section header | *FORMAT:* require literal heading `## Data Model Card — <ISO timestamp>` and `[DMC-COMPLETE]` line at end of card. Controller searches for the marker before any `[EDIT]` line targeting source files |
| 10 | C4 file-size threshold cross (5d Step 4) | LOC of touched file pre/post edit | None — C4 check is documented but not logged | *MARKER:* `[FILE-LOC] <path> before=<N> after=<N>` after each edit batch on a file. Controller flags when `before<500 && after>=500` or `before<1000 && after>=1000` |
| 11 | Pre-build hygiene (5d Step 4) | `tasklist //M pianoidCuda...` Bash output present before any `build_pianoid_cuda.bat` invocation | Free-form Bash log | *MARKER:* `[BUILD-PRECHECK] holders=<comma-pids or none>` immediately before build. Controller alerts if `[BUILD STARTED]` appears without preceding `[BUILD-PRECHECK]` |
| 12 | Canonical build script, not `pip install --force-reinstall` (5d Step 4) | Bash command text contains `build_pianoid_cuda.bat` (or `.sh`), not `pip install ... pianoid_cuda/` | Free-form | Falls out of (13): structured `[BUILD STARTED] mode=heavy\|light variant=release\|debug` marker captures the canonical invocation. Any `pip install` of `pianoid_cuda` lacking a paired `[BUILD STARTED]` is the violation |
| 13 | Rebuild-landed verification (5d Step 4) | `grep -a "<marker>" pianoidCuda*.pyd` output showing the marker present | Free-form | *MARKER:* `[BUILD STARTED] {ts} mode=<heavy\|light> variant=<release\|debug>` and `[BUILD OK] {ts} duration=<s> marker=<grep-string> verified=<yes\|no>` symmetric pair. Use `[BUILD FAILED] {ts} code=<N> error_summary=<one-line>` on failure. Controller alerts if Step 5 begins with no preceding `[BUILD OK] verified=yes` |
| 14 | Multi-stage commit discipline (5d Step 4) | Lock-row size + age + commit count for the agent | `MODULE_LOCKS.md` rows + `git log --author` are direct | *None* (signals are direct file-system reads) |
| 15 | fn tests-first (5d Step 4b) | Test file edit appears before fn-spawn Agent call | Free-form parent log | *MARKER:* `[TEST-WRITTEN] path=<test-file>` before any `[FN-SPAWNED] id=<fn-XXXX> target=<file>` line. Controller compares ordering |
| 16 | fn parent-lock inheritance (5d Step 4b) | `MODULE_LOCKS.md` shows no `fn-*` agent ID rows | Lock file is structured | *None* (direct file-system check) |
| 17 | Parent archives fn logs (5d Step 4b) | `fn-*-*.md` files in non-archive logs/ folder, age >10 min after parent's Step 5 | Glob + age | *MARKER:* parent emits `[FN-RESULT] id=<fn-XXXX> status=<ok\|fail>` after copying fn results into its own log. Controller pairs against existence of the fn log file in non-archive |
| 18 | Parent handles fn failures (5d Step 4b) | Parent's log shows Step 5 entry while fn log shows `**Status:** Failed` | Free-form | Falls out of (17): `[FN-RESULT] id=<fn-XXXX> status=<ok\|fail>`. Controller flags Step 5 entry in parent without all `[FN-RESULT]` lines having `status=ok` or an explicit `[FN-RETRY]` / `[FN-INLINE-FALLBACK]` follow-up |
| 19 | Baseline before edit (5d Step 5/6) | `/tmp/baseline_perf.log` mention OR pytest-output excerpt before first edit | Free-form narrative | *MARKER:* `[BASELINE-TEST] {ts} result=<pass\|fail> perf_log=<path> gpu_mean_ms=<N> sound_corr=<N>` after Step 2 completes. Controller alerts if Step 4 edit markers appear without preceding `[BASELINE-TEST] result=pass` |
| 20 | Hard-fail regression triggers Step 6, not Step 10a (5d Step 5/6) | Compare post-change perf metrics vs baseline | `dev.md:649-655` says "print a table" — table format is matchable | *FORMAT:* require literal table heading `## Post-Change Performance — <ISO timestamp>` and `[REGRESSION-CHECK] {ts} gpu_mean_delta_pct=<N> sound_corr=<N> verdict=<pass\|warn\|fail>` summary line. *MARKER:* on `verdict=fail`, also emit `[REGRESSION-DETECTED] {ts} file=<file> metric=<name> delta=<value>` per offending metric. Controller alerts if `[REGRESSION-DETECTED]` is followed by `[STEP-10A-PHASE-1]` without an intervening `[STEP-6-DEBUG]` marker |
| 21 | Debug loop max 5 iterations (5d Step 5/6) | Count of debug-iteration entries | Free-form (`### Step 6 attempt 1`, `### Step 6 attempt 2`, etc., is the typical pattern but not required) | *MARKER:* `[STEP-6-DEBUG iter=<N>]` line at start of each iteration. Controller counts; warn at iter 6, escalate at iter 8 |
| 22 | Audio-mode routing per strict-A1 (5d Step 7) | Agent invoked `/test-ui` (audio_off) for synthesis change OR `/diagnose` (audio_on) for mic change | Free-form | *MARKER:* `[VERIFY-INVOKE] skill=<test-ui\|diagnose> mode=<audio_off\|audio_on>`. Controller cross-references against the agent's edited file list (categorized as synthesis-output or mic-engaging) |
| 23 | Step 8 mandatory before any 10a/b/c exit (5d Step 8) | Step 8 heading present in log before Step 10 heading | Step heading format is matchable | *MARKER:* `[STEP-8-COMPLETE] {ts} docs_touched=<comma-paths or none>`. Controller alerts if `[STEP-10A-PHASE-1]` / `[STEP-10B-RESET]` / `[STEP-10C-PAUSE]` appears with no preceding `[STEP-8-COMPLETE]` |
| 24 | Doc-gap closure (5d Step 8) | If log mentions "doc gap" / "should be documented", a doc edit OR a WIP item must follow before commit | Pure-text grep — fragile | *MARKER:* if agent identifies a doc gap, log `[DOC-GAP] description=<one-line> resolution=<doc-edit\|wip-deferred> ref=<file-or-wip-anchor>`. Controller alerts when commit appears with `resolution=` empty or absent |
| 25 | C4 God Objects list update (5d Step 8) | If a file crossed 500 / 1000 LOC, `CODE_QUALITY.md` is in the commit | Falls out of (10): if `[FILE-LOC]` shows threshold cross, `CODE_QUALITY.md` must be in commit | Falls out of (10) — no separate marker |
| 26 | Commit `[<agent-id>]` prefix (5d Step 10) | `git log --author` since spawn shows commit messages starting with `[<agent-id>]` | Direct git read | *None* (direct git read) |
| 27 | Phase-1 stop with no premature Phase 2 (5d Step 10) | Log archived to `logs/archive/` AND WIP row removed AFTER orchestrator approval-relay SendMessage | Phase 2 actions are observable as file moves | *MARKER:* `[STEP-10A-PHASE-1] {ts} commit=<sha>` when Phase 1 completes; `[STEP-10A-PHASE-2] {ts}` when proceeding to Phase 2. Controller cross-references the Phase-2 marker against orchestrator's approval-relay timestamp from team-lead inbox; alert if Phase-2 timestamp precedes the approval relay |
| 28 | 10b reset completeness (5d Step 10) | All four reset actions complete | Each is a direct file-system fact (revert, lock release, log delete, WIP clean) | *MARKER:* `[STEP-10B-RESET] {ts} phase=start` and `[STEP-10B-RESET] {ts} phase=done`. Between markers, controller verifies all four actions; partial completion at `phase=done` is the violation |
| 29 | 10c pause snapshot present (5d Step 10) | `## Pause Snapshot — <ISO>` section in log | Already structured per `dev.md:899-909` | *MARKER:* `[STEP-10C-PAUSE] {ts}` line at start of pause procedure. Snapshot section format is already enforced |
| 30 | 10e restart-after-lock log section (5d Step 10) | `## Restart After Lock Conflict — <ISO>` section in log | Already structured per `dev.md:996-1003` | *MARKER:* `[STEP-10E-RESTART] {ts} blocking_agent=<id>`. Restart section format is already enforced |
| 31 | Feature branch must merge to dev (5d Step 9) | `git log dev..feature/*` per repo at CLOSED | Direct git read | *None* (direct git read) |
| 32 | (orchestrator AP, Section 3) Reading source files in orchestrator | Orchestrator's tool-use record | Inaccessible to a sub-agent — orchestrator's own conversation is its own | *None on dev.md side.* Remains heuristic — controller catches the consequence (unlocked dirty file, check 8) not the act. **Open question:** see Section 17 |
| 33 | (orchestrator AP, Section 3) Skipping post-completion verification | Orchestrator log of approval-relay actions | Orchestrator does not maintain its own session log today | *MARKER (orchestrator-side, not dev.md):* orchestrator should `SendMessage(to: "controller", "approval-relayed agent=<id>")` after each user-approval forward. Controller uses this as the gate for check 27 |
| 34 | **Stale-agent detection: Bash call without return** (cross-cutting; primary stall pattern) | Paired markers around every Bash invocation; unmatched call = agent never returned, almost-certain permission stall | Free-form Bash logs only — no current convention captures the stall pattern | *MARKER (paired):* `[BASH-CALL] {ts} {command_summary}` BEFORE every Bash invocation; `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>` AFTER. Controller's stall scan (Section 8d) flags any unmatched `[BASH-CALL]` after 30 min as Tier-2, after 60 min as Tier-3 |
| 35 | **Stale-agent detection: MCP call without return** (cross-cutting; secondary stall pattern) | Paired markers around every MCP tool invocation; unmatched call = MCP server hung or auth-flow gating | Free-form — agents do not log MCP calls today | *MARKER (paired):* `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>` BEFORE; `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>` AFTER. Controller's stall scan flags unmatched `[MCP-CALL]` per same tier rules as check 34 |
| 36 | **Discipline: every potentially-gating tool call must be marker-wrapped** (5d Step 0 / Step 1b — new rule) | Any Bash or MCP invocation in agent log without a preceding paired `*-CALL` marker | None (rule does not exist today) | *DISCIPLINE:* dev.md adds: "Before every `Bash` invocation, emit `[BASH-CALL] {ts} {first 80 chars of command}`. Before every MCP tool invocation, emit `[MCP-CALL] {ts} ...`. Pair with `[BASH-RETURN]` / `[MCP-RETURN]` on completion. Failure to emit is itself a Tier-2 violation — the controller cannot detect stalls without these markers." |
| 37 | **Suspicious-pattern Bash detection** (cross-cutting; preventive) | `[BASH-CALL]` text matches a known-gating pattern (long-running starter, TTY-opening, taskkill on system PIDs) | Free-form | Falls out of (34) once `[BASH-CALL]` exists. Controller maintains a known-gates list (Section 12 catalogue) and flags `[BASH-CALL]` matches with **Tier-2 preemptive** *before* the call goes silent — gives orchestrator a chance to redirect the agent (e.g., "use PowerShell Start-Process instead of cmd //c start") |
| 38 | **Documentation-First rule violation** (cross-cutting; per CLAUDE.md "Documentation-First Rule (MANDATORY)") | A sliding window of the agent's last N=3 `[READ]`/`[GREP]` events, restricted to source-file targets (anything outside `docs/`), with no preceding doc-read in the same window | Free-form Read/Grep tool calls only — no current convention captures whether a docs read preceded a source-file dive | *MARKER (paired with check 39):* once `[READ]`/`[GREP]` markers exist, the algorithm in Section 8e classifies each window. **Tier-1 first occurrence per session** (warn — agent may have missed it); **Tier-2 if it recurs in the same session** (escalate — pattern of skipping docs). Exemptions in Section 8e for syntactic/mechanical tasks, doc-internal navigation, and step-1 doc-read carryover |
| 39 | **Discipline: every Read / Grep / Glob must be marker-wrapped** (5d Step 1 — new rule, parallel to check 36) | Any `Read`/`Grep`/`Glob` tool invocation without a preceding `[READ]` or `[GREP]` marker | None (rule does not exist today) | *DISCIPLINE:* dev.md adds: "Before every `Read` invocation, emit `[READ] {ts} path=<path>`. Before every `Grep`/`Glob` invocation, emit `[GREP] {ts} pattern=<pattern> path=<path>`." Failure to emit is a Tier-2 violation — the controller cannot enforce Documentation-First (check 38) without these markers |
| 40 | **Documentation-First check is now reliably catchable** (cross-reference; flips Section 5e.7 entry) | Same as 38, but stated as a status note — the check moves from "un-checkable, pending dev-side discipline" to "checkable" once markers from row 39 are emitted | n/a (status row, no separate signal) | n/a — check 38 covers the actual enforcement |

#### 5e.3. Proposed marker catalogue (consolidated)

The improvements above propose 30 distinct marker tokens. Names follow the team-lead's canonical conventions (literal bracketed tags, space-separated key=value, easy to grep):

| Marker | Where emitted | What it captures | Used by check(s) |
|---|---|---|---|
| `[STEP-0-COMPLETE] {ts}` | First line under `## Actions` once log + WIP + locks set | Step-0 SLA gate | 1 |
| `[LOCK ACQUIRED] {file}` | Step 4 (or any later step) when adding a file to lock row | Lock-acquire intent | 8 |
| `[LOCK RELEASED] {file}` | Step 10a/b/c when removing a file from lock row | Lock-release intent | 8 |
| `[STEP-1B-KILL] port=<N> pid=<N>` | Step 1b before any `taskkill` | Port-scoped kill | 4 |
| `[STEP-1B-VENV-CHECK] interpreter=<path>` | Step 1b once before first venv use | Confirms venv interpreter | 5 |
| `[SERVER-START] role=<r> port=<N> pid=<N>` | Step 1b after starting a server | Server lifecycle start | 6, 7 |
| `[SERVER-STOP] port=<N> pid=<N>` | Step 1b cleanup or 10a/b/c exit | Server lifecycle end | 6 |
| `[DMC-COMPLETE]` | End of Data Model Card section | Card complete signal | 9 |
| `[EDIT] file=<path>` | Each Edit/Write tool call on source files | Edit operation log | 8, 23 |
| `[FILE-LOC] <path> before=<N> after=<N>` | After edit batch on a file | C4 threshold tracking | 10, 25 |
| `[BUILD-PRECHECK] holders=<...>` | Step 4 before build | Pre-build hygiene check ran | 11 |
| `[BUILD STARTED] {ts} mode=<m> variant=<v>` | Step 4 build wrapper, before invocation | Canonical build start | 12, 13 |
| `[BUILD OK] {ts} duration=<s> marker=<s> verified=<y\|n>` | Step 4 build wrapper, on success | Canonical build success + verification | 13 |
| `[BUILD FAILED] {ts} code=<N> error_summary=<one-line>` | Step 4 build wrapper, on failure | Build failure | 12 |
| `[TEST-WRITTEN] path=<...>` | Step 4b before fn-spawn | Test exists before sub-agent | 15 |
| `[FN-SPAWNED] id=<...> target=<...>` | Step 4b parent log at spawn | fn-spawn record | 17, 18 |
| `[FN-RESULT] id=<...> status=<ok\|fail>` | Step 4b parent log after fn completes | fn-completion record | 17, 18 |
| `[BASELINE-TEST] {ts} result=<pass\|fail> ...` | After Step 2 | Baseline ran before Step 4 | 19 |
| `[REGRESSION-CHECK] {ts} ... verdict=<v>` | After Step 5 | Post-change perf table summary | 20 |
| `[REGRESSION-DETECTED] {ts} file=<f> metric=<m> delta=<d>` | After Step 5 if verdict=fail | Per-metric regression record | 20 |
| `[STEP-6-DEBUG iter=<N>]` | Step 6 each debug iteration | Debug-iteration counter | 21 |
| `[VERIFY-INVOKE] skill=<...> mode=<...>` | Step 7 audio verification | Mode-routing record | 22 |
| `[STEP-8-COMPLETE] {ts} docs_touched=<...>` | End of Step 8 | Doc update done | 23 |
| `[DOC-GAP] description=<...> resolution=<...>` | Step 8 if a gap found | Doc-gap closure record | 24 |
| `[STEP-10A-PHASE-1] {ts} commit=<sha>` | Step 10a Phase 1 complete | Phase 1 boundary | 27 |
| `[STEP-10A-PHASE-2] {ts}` | Step 10a Phase 2 start (after approval) | Phase 2 boundary | 27 |
| `[STEP-10B-RESET] {ts} phase=<start\|done>` | Step 10b boundaries | Reset completeness | 28 |
| `[STEP-10C-PAUSE] {ts}` | Start of Step 10c | Pause start marker | 29 |
| `[STEP-10E-RESTART] {ts} blocking_agent=<id>` | Start of Step 10e | Restart-after-lock marker | 30 |
| `[BASH-CALL] {ts} {command_summary}` | Before every Bash invocation; command_summary is first 80 chars (escaped) | Bash-call boundary | 34, 36, 37 |
| `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>` | After every Bash return | Bash-return boundary | 34, 36 |
| `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>` | Before every MCP tool invocation | MCP-call boundary | 35, 36 |
| `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>` | After every MCP tool return | MCP-return boundary | 35, 36 |
| `[READ] {ts} path=<path>` | Before every `Read` tool invocation on a project file | Read operation log; feeds Documentation-First compliance check | 38, 40 |
| `[GREP] {ts} pattern=<pattern> path=<path>` | Before every `Grep` / `Glob` tool invocation on project files | Grep/Glob operation log; feeds Documentation-First compliance check | 38, 40 |

(That's 30 distinct markers: 24 from the original catalogue + 3 from the lifecycle revision (`[STEP-0-COMPLETE]`, `[LOCK ACQUIRED]`, `[LOCK RELEASED]`) + 4 from the stale-monitoring revision (`[BASH-CALL]`, `[BASH-RETURN]`, `[MCP-CALL]`, `[MCP-RETURN]`) + 2 from this revision (`[READ]`, `[GREP]`) for Documentation-First enforcement. Total minus the lifecycle 3 and the docs-first 2 = 25 in original-plus-stale; with all extensions = 30. The build / regression / Phase-1/2 / reset triplets are conceptually one boundary each but use distinct tags for grep simplicity.)

**Every marker traces to at least one row in 5e.2 — no "just-in-case" markers.**

#### 5e.4. Format conventions

Every marker:

- Appears on its own line in the session log
- Starts with `[MARKER NAME]` in square brackets at column 0 (spaces or hyphens inside the brackets are both accepted; the conventions table above uses hyphens for compound names like `STEP-1B-KILL` and spaces for short pair names like `LOCK ACQUIRED` / `BUILD STARTED` / `BUILD OK` / `BUILD FAILED`)
- Where the marker carries a timestamp, it appears immediately after the bracket (e.g., `[BUILD STARTED] 2026-05-05T12:30:22Z mode=heavy variant=release`)
- Uses `key=value` for fields; values containing spaces are quoted (`name="my file.py"`)
- Multiple key=value pairs are space-separated
- Is emitted by the dev agent's own `Edit`/`Write` to the session log file — no special tooling required
- Coexists with the existing narrative step entries (markers are additive, not replacements)

The marker convention does NOT replace the existing `### Step N: <Name> — <ts>` step headings, the `## Data Model Card` table, the `## Pause Snapshot` block, or the `## Files Modified` list. It supplements them with explicit, greppable, machine-parseable signals at the action boundaries.

#### 5e.5. Step-heading timestamp format change

The current convention `### Step N: <Name> — <HH:MM>` uses local `HH:MM` (line 109). For controller monitoring, this is ambiguous across day boundaries — a step that began at 23:50 and was logged again at 00:10 cannot be ordered without a date. Change to ISO 8601:

```markdown
### Step N: <Name> — 2026-05-05T12:30:22Z
```

The agent already has `$(date +%Y-%m-%d-%H%M%S)` in scope (used at Step 0 line 55), so emitting an ISO timestamp on each heading is `$(date -u +%Y-%m-%dT%H:%M:%SZ)` — one extra command-substitution per step. This change is required for checks 1, 2, 9, 20, 21, 27 to work correctly across long sessions or across midnight.

#### 5e.6. Implementation cost and backwards compatibility

- **Total new dev.md lines:** ~100–130 (Step 0 logging-rule paragraph, per-Step marker requirements, Bash/MCP discipline for stale monitoring, READ/GREP discipline for Documentation-First enforcement).
- **Per-agent runtime cost:** negligible — markers are bash `echo`-equivalent lines appended to a file the agent already writes to. Three pairs add to log size: `[BASH-CALL]`/`[BASH-RETURN]` ~2 lines per Bash invocation; `[MCP-CALL]`/`[MCP-RETURN]` ~2 lines per MCP call; `[READ]`/`[GREP]` ~1 line per file read or grep. For a typical dev session (~50–100 Bash + ~30 reads + ~20 greps) that's 200–300 extra lines, well below the log size where readability suffers.
- **Backwards compatibility:** existing dev session logs (in `logs/archive/`) lack these markers. The controller treats their absence in archived logs as expected; only logs newer than a `controller_marker_baseline_date` (configurable in `dev.md`, default = the date the marker convention is added) are checked against the marker rules.

#### 5e.7. Anti-patterns whose checkability is partial or pending

After the additions in this revision, **two previously un-checkable patterns become reliably catchable**:

1. **Stale-agent pattern** — through the `[BASH-CALL]`/`[BASH-RETURN]` and `[MCP-CALL]`/`[MCP-RETURN]` pairs (checks 34–37) consumed by the periodic-monitor scan in Section 8d.
2. **Documentation-First rule violations** — through the `[READ]`/`[GREP]` markers (checks 38–40) consumed by the sliding-window check in Section 8e.

The two remaining limitations are both orchestrator-side, not dev-side:

- **Check 32 (orchestrator self-reads source files):** the orchestrator's own tool-use is in its conversation context, not in any file the controller can read. *Partial path:* if the orchestrator extends the same `[BASH-CALL]` / `[MCP-CALL]` / `[READ]` / `[GREP]` discipline to its own session log (Section 17 open question 5), the controller would also detect orchestrator-side suspicious operations. Until then, the controller catches the consequence (unlocked dirty file via check 8 + `[LOCK ACQUIRED]` divergence) but cannot detect the read itself. Open question 5 in Section 17.
- **Check 33 (orchestrator skipping post-completion verification):** requires an orchestrator-side log of approval-relay actions. Today the orchestrator does not maintain its own session log — the proposed `SendMessage(to: "controller", "approval-relayed agent=<id>")` marker substitutes for one. Open question 6 in Section 17.

A *third* honest limitation is worth naming: **the Documentation-First check has unavoidable false positives.** The dev agent can legitimately consult docs *mentally* — its training already includes recent reads, and re-reading is wasteful — without producing a `[READ]` marker. The controller cannot see "memory." The check is therefore set to **Tier-1 first occurrence per session** (warn, not halt), graduating to Tier-2 only on a recurring pattern. See Section 8e for exemptions that further reduce false-positive rate.

---

## 6. Triggers — When the Controller Is Spawned

User's stated requirement: "Controller should be involved in all significant development processes, especially when more than one dev agent involved." With the permanent-for-session lifecycle, this is satisfied trivially: the controller is spawned at orchestrator startup and is therefore present for every dispatch the session makes — no dispatch-time decision is required.

| Event | Action |
|---|---|
| `/orchestrator start` (or first orchestrator activation in a session) | **Spawn the controller as part of orchestrator Step 1.5 (Repo Health Check).** Single Agent call with `name: "controller"`, run_in_background, bypassPermissions. Controller initializes by reading the same files Step 1.5 already scans. |
| Orchestrator dispatches any `/dev` agent | **Notify controller** via `SendMessage(to: "controller", "new agent dispatched: dev-XXXX, task: ...")`. Controller adds the agent to its watch list and subscribes via `Monitor` to the agent's log file once it appears. No controller spawn. |
| Orchestrator dispatches `/multitask` | **Notify controller** with the wave plan (agent IDs, conflict matrix, expected file scopes). Controller pre-arms cross-agent invariant checks for the named files. No controller spawn. |
| Orchestrator dispatches `/update-docs`, `/review`, `/sync`, `/test-ui`, `/pianoid-ui`, `/analyse`, `/diagnose` | **Notify controller** the same way. Even though these skills do not normally lock or commit-prefix, the controller still watches `git status` so any accidental source mutation is caught. Reduces the surface of "the controller exists but didn't watch this kind of agent." |
| Orchestrator itself reads a source file or runs `Bash` that mutates state | Controller continues to watch — orchestrator anti-pattern row "Reading source files to quickly check something" is still in scope. |
| `/orchestrator stop` (or session-ending kill) | **Orchestrator notifies controller** via `SendMessage(to: "controller", "session ending")`. Controller produces final compliance summary, sends to orchestrator, archives its own log, exits. |

**Singleton rule.** At most one controller per orchestrator session. If a controller is observed missing mid-session (rare — agent crash), the orchestrator's Step 1.5 health check on the next iteration re-spawns it; this is a Tier-2 issue but does NOT block dev work (see Section 10 fallback).

**Always-on rationale (recap of TL;DR).** The bounded-by-dev-agents alternative leaves a window between `last dev CLOSED → next /dev dispatch` where the orchestrator may dispatch `/update-docs`, `/review`, or perform its own `Read`/`Bash` calls. None of those are dev-agent activity but all of them can affect state the controller is responsible for (`git status` cleanliness, doc-update auto-trigger compliance). Permanent presence eliminates that window.

---

## 7. Tools and Permissions

Controller is read-only on project source. Required tools:

| Tool | Purpose |
|---|---|
| `Read` | `MODULE_LOCKS.md`, `WORK_IN_PROGRESS.md`, dev-agent session logs, `.claude/commands/*` |
| `Grep` | Search log files for step markers, status transitions |
| `Glob` | Enumerate `docs/development/logs/*.md` |
| `Bash` (read-only) | `git status`, `git log`, `git diff --name-only`, `tasklist`, `netstat` |
| `SendMessage` | Reach orchestrator (`team-lead`) and named dev agents |
| `Monitor` | Watch agent log files for new entries; this is the heartbeat mechanism. Each new line in a dev-agent's log is a notification — the controller does not poll. |

Explicitly forbidden: `Edit`, `Write`, `NotebookEdit` on any project file. `Bash` invocations that mutate state (e.g., `git commit`, `taskkill`, anything that writes outside `/tmp` or the controller's own log).

The controller's own session log lives at `docs/development/logs/controller-<orchestrator-session-id>-<timestamp>.md` and IS write-allowed (controller owns its own log). When the controller exits, its log is archived to `docs/development/logs/archive/` like a dev log.

---

## 8. Reporting Protocol

### 8a. Compliance pulse (informational)

Every 5 minutes while at least one dev agent is alive, controller sends:

```
SendMessage(to: "team-lead", summary: "Pulse N", message: "Pulse N at HH:MM
  Agents alive: dev-XXXX (Step 4), dev-YYYY (Step 1)
  Locks: dev-XXXX: pianoid.py, backendServer.py | dev-YYYY: mode_tracking.py
  Repo dirty (matching locks): 2 files in PianoidCore
  Repo dirty (UNLOCKED): 0 files
  Issues: none")
```

If "Issues" is `none` for 3 consecutive pulses, frequency drops to every 15 minutes — pulses are rate-limited so they do not flood the orchestrator's Telegram view. Frequency restores to 5 minutes on any non-`none` issue or new dispatch.

### 8b. Violation alert (immediate)

On any Tier-1/2/3 finding:

```
SendMessage(to: "team-lead", summary: "Tier-N alert: <short>", message: "Tier-N <category>
  Agent: dev-XXXX
  Invariant: <which one>
  Evidence: <git status excerpt or log line>
  Recommended action: <what orchestrator should do>")
```

For Tier-2/3 on a specific agent, ALSO:

```
SendMessage(to: "dev-XXXX", summary: "Compliance flag", message: "Controller flagged: <invariant>.
  Pause edits and check with orchestrator before continuing.")
```

The orchestrator has discretion to override (e.g., approve a retroactive lock add). Controller does not block the agent — the message to the dev agent is advisory; the orchestrator decides enforcement.

### 8c. Final session summary

When the orchestrator notifies the controller that the session is ending (`/orchestrator stop` or kill), the controller writes a summary to its own log AND sends to orchestrator:

```
SendMessage(to: "team-lead", summary: "Controller closing", message: "Session summary:
  Agents observed: dev-XXXX, dev-YYYY, dev-ZZZZ
  Total alerts: 3 (Tier-1: 2, Tier-2: 1, Tier-3: 0)
  Invariants violated: <list with timestamps>
  Recommendations for future sessions: <if any pattern emerged>")
```

Then the controller archives its own log to `logs/archive/` and exits.

(Inter-session note: between the last dev agent's CLOSED and the next dispatch, the controller stays alive but enters a quiet state — pulses drop to 15 minutes, watch list goes empty. It does not produce a summary at that point, only at session end.)

### 8d. Periodic stale-agent monitoring (30-min cadence)

The event-driven model in Sections 8a–8c catches violations the moment a watched log file is updated. It does NOT catch agents that simply STOP writing — for example, agents stuck on a CLI permission prompt that the Telegram user cannot see. This sub-section adds a periodic stale-check, complementary to (not replacing) the event-driven loop.

**Cadence.** Every 30 minutes of wall-clock time, the controller runs a stale-agent scan across every agent on its watch list. The 30-minute number is the user-specified default; see Section 17 (Open Questions) for the cadence-tuning question.

**Per-agent procedure.** For each agent on the watch list:

1. Read the agent's session log file in full (or the last ~50 lines if the file is large).
2. Identify the **last log line** (any non-blank, non-pure-whitespace line) and its **timestamp**. Timestamps come from:
   - Step heading line: `### Step N: <Name> — <ISO 8601 UTC>` (per Section 5e.5)
   - Marker line: `[BASH-CALL] {ts} ...`, `[BUILD STARTED] {ts} ...`, `[STEP-10A-PHASE-1] {ts} ...`, etc.
   - If the last line has no embedded timestamp, fall back to the file's mtime — but flag this as a logging-discipline issue (Tier-1).
3. Classify the **last-entry type**:
   - **Normal narration / step heading** — the agent was in the middle of described work
   - **Unmatched tool-call marker** — the agent emitted `[BASH-CALL]` or `[MCP-CALL]` but no matching `[BASH-RETURN]` / `[MCP-RETURN]` followed (per Section 5e.3 the markers are paired)
   - **Final marker** — `[STEP-10A-PHASE-1]`, `[STEP-10A-PHASE-2]`, `[STEP-10B-RESET ... phase=done]` etc. — agent reached an exit point and may legitimately be idle awaiting orchestrator follow-up
4. Compute the **stall duration**: `now - last_entry_timestamp`.
5. Apply the decision matrix:

| Last-entry age | Last-entry type | Tier | Suspicion score |
|---|---|---|---|
| < 30 min | any | none — agent is active | n/a |
| 30–60 min | normal narration / step heading | T1 — informational ping to orchestrator | low |
| 30–60 min | final marker (Phase 1 / 2 / Reset done / Pause) | none — legitimately idle pending orchestrator | n/a |
| 30–60 min | unmatched `[BASH-CALL]` or `[MCP-CALL]` marker | **T2 — likely permission stall, escalate** | **high** |
| > 60 min | normal narration / step heading | T3 — assume stalled, halt-and-investigate | medium |
| > 60 min | final marker | T1 — orchestrator should follow up; agent is waiting | low |
| > 60 min | unmatched `[BASH-CALL]` or `[MCP-CALL]` marker | **T3 — almost-certain permission stall, immediate halt** | **highest** |

**Output.** Periodic-monitor scan finishes with a single SendMessage to orchestrator listing each candidate stalled agent:

```
SendMessage(to: "team-lead", summary: "Stale-agent scan", message: "Stale-agent scan at HH:MM:
  Active agents: dev-md01, dev-9a47
  Stalled candidates:
    - dev-md01: last entry [BASH-CALL] 2026-05-05T12:30:22Z 'cmd //c start-pianoid.bat' (52 min ago)
                Type: unmatched BASH-CALL — Tier-2 likely permission stall (suspicion: high)
                Recommended: check CLI for pending prompt; if visible, approve. Else kill+respawn.
    - dev-9a47: last entry '### Step 4: Edit Code' (38 min ago)
                Type: normal narration — Tier-1 informational
                Recommended: orchestrator may probe via SendMessage to confirm progress.
  No-issue agents: 0")
```

If no candidates: a single one-line "Stale-agent scan: 2 agents active, no stalls."

**Coordination with the rest of the controller (Section 10 boundary).** The controller does NOT try to wake the agent. It does not Bash, does not killtask, does not auto-respawn. It reports candidates to the orchestrator, which decides:

- If the orchestrator can see the CLI prompt directly (some prompts surface as harness deltas), it approves there.
- If the orchestrator cannot see it, it tells the user via Telegram: "Check the CLI window for a pending permission prompt on agent dev-XXXX. Last attempted operation: `<command>`."
- If user/orchestrator can't recover, the orchestrator kills the agent (TaskStop) and respawns with adjusted approach (e.g., switch from `cmd //c start-pianoid.bat` to `PowerShell Start-Process -WindowStyle Hidden` per CLAUDE.md known-gap workaround).

This boundary keeps controller as the *detector* and orchestrator as the *actor* — same separation as Section 10 already documents for invariant violations.

### 8e. Documentation-First compliance check

The CLAUDE.md "Documentation-First Rule (MANDATORY)" requires dev agents to consult `docs/` BEFORE grepping/reading source code, **every time** they need to understand something — at session start, mid-task, during debugging, or when a new question arises. This sub-section spec's how the controller enforces the rule using the `[READ]` and `[GREP]` markers from Section 5e.3.

**Cadence.** Continuous — the check runs in the event-driven loop. Whenever a dev-agent's log gains a new `[READ]` or `[GREP]` line, the controller re-evaluates the trailing window for that agent.

**Per-event procedure.** When `[READ] {ts} path=<path>` or `[GREP] {ts} pattern=<...> path=<path>` is observed:

1. **Classify the target.**
   - **Doc-read** — `path` starts with `docs/` (any sub-tree). This SATISFIES the Documentation-First rule and resets the docs-skipping counter for that investigation phase.
   - **Source-read** — `path` is in `PianoidCore/`, `PianoidBasic/`, `PianoidTunner/`, or `tests/` and is NOT under `docs/`. This is a candidate for a Documentation-First skip.
   - **Doc-internal navigation** — `Grep` whose `pattern` starts with `^# ` (markdown headings) AND whose `path` is `docs/`, OR `Glob` whose pattern is restricted to `docs/`. SATISFIES — counts as doc consultation.
   - **Other** — `path` is `.claude/`, `tools/`, `.git/`, etc. NEUTRAL — doesn't satisfy or violate; ignored by the windowing.

2. **Identify the investigation phase.** Phases are bounded by Step heading entries in dev.md. The relevant phases:
   - **Phase: Step 1 (Understand Context)** — primary docs-first phase. The agent should ALREADY have consulted docs in this step before any source-file read.
   - **Phase: Step 5 (Test) / Step 6 (Debug) / Step 7 (Verify)** — secondary docs-first phases. CLAUDE.md "ESPECIALLY during debugging" directive applies; the agent should re-consult relevant module docs before grepping source.
   - **Phase: Step 0 / Step 1b / Step 2 / Step 3 / Step 4 (Edit) / Step 8 / Step 9 / Step 10*** — outside the docs-first investigation phases. Source reads here are presumed to follow earlier doc consultation; check is suppressed.

3. **Apply the windowing rule.** Within each in-scope investigation phase, maintain a sliding window over the last **N=3** non-NEUTRAL events for that agent. The default N=3 is the user-suggested value — see Section 17 open question 8 for the windowing-parameter discussion.
   - If all three events are source-reads with NO doc-read or doc-internal-navigation in the window: **VIOLATION**.
   - If at least one event in the window is a doc-read or doc-internal-navigation: COMPLIANT.

4. **Apply exemptions** before flagging:
   - **Exemption A — syntactic/mechanical task.** If the agent's task description (from its log header `Task:` field or orchestrator dispatch payload) matches a known-mechanical pattern (`rename ... to ...`, `replace X with Y everywhere`, `move file`, `update import paths`, `lint fix`, etc.), Documentation-First does not apply — exempt.
   - **Exemption B — Step-1 doc-read carryover.** If the agent's Step 1 produced one or more `[READ] path=docs/...` markers and the current investigation phase is the SAME Step 1 (still in progress), no further doc-read is required; the carryover satisfies the rule. (Subsequent phases reset.)
   - **Exemption C — single-source-file deep-dive.** If the agent has already produced ONE doc-read in this phase and is now reading the specific source file the doc pointed to, that's expected drilling-down. Exempt for the next 5 source-reads of THAT file (heuristic — drilling-down on one file is doc-faithful; jumping to unrelated source files is not).

5. **Classify severity.**
   - **First violation in session** → **Tier-1 warn** (informational ping to orchestrator: "dev-XXXX may have skipped docs-first at <ts>; last 3 reads were source-only with no preceding doc consultation in this phase").
   - **Recurring violation in same session** (≥2 violations across investigation phases) → **Tier-2 escalate** (controller SendMessages both orchestrator AND dev agent: "Pattern of skipping Documentation-First detected. Stop and re-read the relevant module doc before continuing.").
   - **Never Tier-3** — this check is intentionally lenient because of the false-positive caveat in Section 5e.7.

**Output.** Per-event evaluation; alerts emitted only when a violation fires (not on every compliant event). Format identical to Section 8b violation alerts, with the additional `phase=<step-N>`, `last_3_reads=<list>`, and `last_doc_read=<ts or "none in phase">` fields.

**Why this works.** The Documentation-First rule is *behavioural*, not *structural* — there's no file the controller can read that says "this agent consulted docs." The only signal is the agent's tool-call sequence. By making `[READ]` / `[GREP]` markers mandatory (check 39), the controller turns a behavioural rule into a structurally-checkable one, modulo the irreducible false positives of mental-consultation (acknowledged in 5e.7).

**Coordination with the rest of the controller (Section 10 boundary).** Same as 8d: controller detects, reports; orchestrator decides what to do (probe agent, ask user to confirm docs were consulted mentally, instruct agent to re-consult). Controller does not auto-pause or auto-redirect.

---

## 9. Violation Handling — Graduated Response

| Tier | Trigger examples | Controller action | Orchestrator's expected response |
|---|---|---|---|
| **Tier-1 (warn)** | Late Step 0 by 2 min; commit missing `[agent-id]` prefix; cross-agent file proximity; `Status: In Progress` flagged stale (no log lines for 10+ min); first occurrence of a soft-convention break | Single `SendMessage` to orchestrator. No message to dev agent. | Note in Telegram if relevant; otherwise log internally and continue. Pulse history accumulates context. |
| **Tier-2 (escalate)** | Late Step 0 by 5 min; agent edited unlocked file (now caught); premature Phase 2 actions; `/fn` agent edited file outside parent's lock; `/update-docs` touched a `.cu`/`.cpp` file | `SendMessage` to orchestrator AND to the dev agent ("pause edits and check with orchestrator"). Dev-agent message is advisory, not a hard stop. | Decide: restart, pause, kill, or approve retroactively. If approving retroactively, instruct controller to mark this invariant suppressed for this session via a follow-up `SendMessage`. |
| **Tier-3 (halt)** | Two agents holding lock on same file; unlocked dirty source file; concurrent `--heavy` CUDA builds detected; agent reaches Step 10b (commit) without locks present | `SendMessage` to orchestrator with "HALT" prefix; ALSO `SendMessage` to all alive dev agents: "Repo invariant violated. Stop all edits. Await orchestrator instruction." | Immediate orchestrator intervention. Pause every dev agent (Step 10c), resolve, then either restart or reset. |

**Suppression mechanism.** Some invariants legitimately need to be relaxed for a specific session (e.g., a doc-only `/dev` agent that never edits source). The orchestrator can `SendMessage(to: "controller", message: "suppress: <invariant>")` for the remainder of the session. Controller logs the suppression and stops alerting on it for that session only — never permanent. Suppressions reset when the controller exits.

---

## 10. Coordination With Orchestrator

Boundary contract:

| Concern | Owner |
|---|---|
| Communication with the user | Orchestrator only |
| Spawning, killing, pausing dev agents | Orchestrator only |
| Approving user requests | Orchestrator only |
| Reading lock/WIP/log files | Either |
| Detecting invariant violations | Controller (primary), orchestrator (fallback if no controller) |
| **Detecting stalled agents (periodic 30-min sweep, Section 8d)** | **Controller** |
| Acting on violations (e.g., relaying to user, instructing dev agent to stop) | Orchestrator |
| **Acting on stale-agent reports (approve CLI prompt, kill+respawn, tell user via Telegram)** | **Orchestrator** |
| Repo `git status` health checks | Either; controller does periodically, orchestrator does at Step 1.5 |
| Final compliance summary | Controller |
| Final session summary to the user | Orchestrator (may quote the controller's summary) |

**Fallback when no controller exists.** The controller is spawned as part of orchestrator Step 1.5 and is expected to be alive for the full session. If the spawn fails (agent-team capacity exhausted, harness gate, or mid-session crash without re-spawn), the orchestrator must remain capable of running its existing workflow. The orchestrator's existing checks at `:782` ("check within ~2 min") are the fallback for the Step-0 SLA invariant. Controller failure is itself a Tier-2 issue (the orchestrator notices it on the next dispatch when the SendMessage queues silently) but does NOT block dev work — the orchestrator re-attempts spawn at the next Step 1.5 opportunity.

---

## 11. Lifecycle

```
/orchestrator start
    |
    v
Orchestrator runs Step 1.5 (Repo Health Check)
    |
    v
Orchestrator spawns controller as part of Step 1.5:
  - Single Agent call, run_in_background, bypassPermissions
  - Controller boots before any dev dispatch — always present
    |
    v
Controller initializes:
  - Creates own session log at docs/development/logs/controller-<orch-id>-<timestamp>.md
  - Reads MODULE_LOCKS.md, WORK_IN_PROGRESS.md, scans logs/ for any pre-existing
    active sessions (orphaned from a prior orchestrator)
  - Sends initial pulse to team-lead (even with no agents alive — confirms it
    booted)
  - Empty watch list at this point
    |
    v
Controller event loop (mostly event-driven, with one periodic tick):
  - Wakes on:
      * SendMessage from orchestrator ("new agent dispatched", "suppress", "query",
        "session ending")
      * Monitor notification (a watched log file gained a line)
      * Pulse timer (5 min when ≥1 dev agent alive; 15 min idle / empty
        watch list)
      * **Stale-agent scan timer (30 min, cadence per Section 8d)** — wakes
        the controller even if no log file activity has occurred; this is
        what catches agents stuck on a CLI permission prompt (no log line
        produced because the gating tool call never returned)
  - On wake:
      * Update watch list if new dispatch
      * Re-scan locks + WIP + git status if relevant
      * Cross-reference against active invariants (Section 5a-5d, signals
        per Section 5e)
      * On 30-min stale-scan tick: read every active agent's log, classify
        last-entry per Section 8d decision matrix, send stale-agent report
        if any candidates found
      * Send pulses / alerts as needed
  - Between wakes: idle, near-zero token usage
    |
    v
Throughout session: orchestrator dispatches /dev, /multitask, /update-docs,
                    /review, /test-ui etc. Each dispatch sends
                    "new agent dispatched: <id>, type: <skill>" to controller.
                    Controller tracks each agent's full lifecycle through
                    CLOSED / KILLED / RESET. Watch list grows and shrinks
                    over time; controller persists.
    |
    v
/orchestrator stop  OR  session-ending kill
    |
    v
Orchestrator sends SendMessage(to: "controller", "session ending")
    |
    v
Controller:
  - Compiles final session summary (all agents observed, total alerts,
    invariants violated, recommendations)
  - Sends summary to team-lead
  - Archives own log to logs/archive/
  - Exits
    |
    v
On next /orchestrator start, a fresh controller is spawned.
```

**Cross-session.** Each orchestrator session gets its own controller. A VS Code reload, `/orchestrator stop`/`start` cycle, or harness restart drops the existing controller and the new orchestrator instance spawns a fresh one. State (watch list, alert history, suppressions) is intentionally not persisted across sessions — Section 18 codifies this as a non-goal.

---

## 12. Stale-Agent Failure Modes Catalogue

The user's msg 1707 named the dominant cause of stalls: "user confirmation request sent directly to CLI bypassing orchestrator." This section catalogues the known specific patterns that produce this failure, drawn from `.claude/CLAUDE.md` "Orchestrator Sub-Agent Permission Rule — Known gaps in `bypassPermissions`" and from incident history. Each entry includes the controller flag the periodic stale-scan (Section 8d) uses to recognize it, plus the recommended mitigation the orchestrator should apply.

### 12a. Long-running Bash starters

**Pattern.** Commands that spawn detached/long-running children (`cmd //c start-pianoid.bat`, `cmd //c start *.exe`, npm dev server foreground) trigger the harness's "long-running process" detector regardless of `bypassPermissions`. Dev agent emits the call and waits forever for the gate.

**Example incidents.**
- `dev-modal-b3` 2026-05-01 — backend startup via `cmd //c start-pianoid.bat`, gated, agent silent.
- `dev-833f` 2026-04-30 (Phase A) — chrome-devtools session loss after permission prompt invisible to Telegram user.

**Controller flag (via Section 8d).** Unmatched `[BASH-CALL] {ts} cmd //c start*` (or any pattern in the long-running-starter list below) older than 30 min → Tier-2; older than 60 min → Tier-3. Also: pre-emptive Tier-2 the moment `[BASH-CALL]` is emitted if its command_summary matches the pattern (per check 37, 5e.2).

**Long-running-starter pattern list (controller pre-emptive matcher):**
- `cmd //c start*` (Windows start command)
- `cmd //c *start-pianoid.bat*`
- `cmd //c npm run dev*`
- `npm run dev*` (foreground, no `&` or background)
- `python *backendserver.py*` without `run_in_background: true` flag
- Any command containing `Start-Process` without `-WindowStyle Hidden`

**Mitigation.** Orchestrator instructs agent (or respawns) to use the CLAUDE.md-documented workaround:
```
PowerShell Start-Process -WindowStyle Hidden -FilePath ... -RedirectStandardOutput ...
```
or, for backend, the launcher REST API (`POST /api/start-backend` on port 3001).

### 12b. TTY-opening Bash

**Pattern.** Bash commands that expect interactive keyboard input (`git rebase -i`, `git add -i`, `python` REPL with no `-c`/script, `gcloud auth login`, `npm init` without `-y`). Always gates regardless of permission mode. Should never be invoked in agent context.

**Controller flag (pre-emptive, check 37).** `[BASH-CALL]` text matches forbidden-pattern list:
- `git rebase -i*`
- `git add -i*`
- `python` (bare, no script arg)
- `gcloud auth login*`
- `aws configure` (interactive prompt)
- Any command piping into a `read`/prompting interactive program

**Mitigation.** Orchestrator instructs the agent to use a non-interactive equivalent (e.g., `git rebase HEAD~3` non-interactive form, or pipe an answer file). For genuinely interactive operations, route via the `! <command>` prefix (user runs in their CLI directly, output lands in conversation).

### 12c. taskkill on system / high PIDs

**Pattern.** `taskkill //F //PID <high-PID>` or `taskkill //F //IM <name>` on certain processes triggers UAC / harness gate. The exact trigger is inconsistent — observed cases involve PIDs in the system process range or processes owned by services.

**Example incident.** Discovery context in `.claude/CLAUDE.md`: "Some `taskkill` patterns on system PIDs — observed inconsistently."

**Controller flag.** `[BASH-CALL] {ts} taskkill //F //PID <high-pid>` followed by no `[BASH-RETURN]` for 5+ min. Pre-emptive flag is harder here (the gate is inconsistent), so primary detection is via Section 8d unmatched-call scan.

**Mitigation.** Orchestrator instructs agent to scope kills by image name (`taskkill //F //IM <name>`) where possible, or use `//T` (kill tree) which sometimes succeeds where bare PID fails. Last resort: orchestrator runs the kill in its own context (its bash calls render as deltas the orchestrator can see).

### 12d. MCP re-auth flows

**Pattern.** Some MCP servers gate when their session expires and they need to call out to a browser for re-auth. Examples:
- `mcp__claude_ai_Google_Calendar__authenticate` / `mcp__claude_ai_Gmail__authenticate` — port 8000 OAuth flow
- `mcp__plugin_telegram_telegram__*` — `grammy` package re-init when bot token changes
- `mcp__chrome-devtools__*` — stdio pipe loss requires VS Code reload (per CLAUDE.md known issue)

**Controller flag.** `[MCP-CALL] {ts} server=<name> tool=*authenticate*` or `tool=*auth_init*` followed by no `[MCP-RETURN]` for 2+ min — auth flows that take longer than that are stalled. Pre-emptive flag: any `[MCP-CALL]` to a tool name matching `*auth*|*authenticate*|*init*|*pair*` triggers immediate Tier-1 informational ("agent is opening an auth flow — orchestrator should be ready to relay user-side action").

**Mitigation.** Orchestrator tells the user via Telegram: "Agent dev-XXXX needs OAuth re-auth for <server>. Please open the URL in your CLI and complete the flow, then send 'continue'." Once user confirms via Telegram, orchestrator SendMessages the agent to retry.

### 12e. Other harness-gated operations (catch-all)

CLAUDE.md "Known gaps" subsection lists categories beyond the above. As they're discovered, append to this catalogue. Currently:

- **`Bash run_in_background: true` first-call-of-session.** Sometimes triggers the long-running-process gate even with `bypassPermissions` (the gate decision is harness-internal). Per CLAUDE.md, escalate to orchestrator if first-attempt fails — do NOT retry.
- **MCP server stdio drift in long sessions.** Servers spawned via `npx -y X@latest` (chrome-devtools, context7, google-drive) can lose stdio mid-session. Symptom: their tool calls hang — this is a stale `[MCP-CALL]` in the same form as 12d but a different remediation (VS Code reload, not user OAuth). Controller flag is the same; orchestrator distinguishes by the server name + the absence of an auth flow in the call.

### 12f. Pattern matching reference

The controller maintains an in-memory list of known-gating patterns, used by check 37 (pre-emptive flag) and Section 8d (post-stall classification). Initial list (drawn from the catalogue above):

| Class | Regex / pattern (against `[BASH-CALL]` command_summary) |
|---|---|
| Long-running starter | `^cmd //c\s+(start\|.*start-pianoid)`; `^npm run dev`; `Start-Process(?!.*-WindowStyle Hidden)` |
| TTY-opening | `git rebase -i`; `git add -i`; `^python\s*$`; `gcloud auth login`; `aws configure\b` |
| taskkill suspicious | `taskkill //F //PID \d{4,}` (4+ digit PIDs are suspicious) |
| Long-running-process flag-dependent | `Bash run_in_background: true` (first occurrence per session) |

| Class | Regex (against `[MCP-CALL]` `tool=` field) |
|---|---|
| Auth flow | `.*auth.*\|.*authenticate.*\|.*init.*\|.*pair.*` |
| Browser-dependent | `chrome-devtools__*` (susceptible to stdio drift) |

The list is evolving — each new failure mode discovered should be added to this section and to the controller's pattern list.

---

## 13. Concrete Spawn Pattern

The controller is spawned **once, at orchestrator startup, as part of Step 1.5 (Repo Health Check)** — before any dev dispatch is possible. This separates controller-spawn from dev-spawn entirely; dev dispatches just send a notification.

### 13a. Initial spawn (orchestrator startup, runs once)

```javascript
// Inside orchestrator Step 1.5, after the health check completes:
Agent({
  team_name: "pianoid-dev",
  name: "controller",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "Compliance controller for this orchestrator session",
  prompt: `Run as the dev pipeline controller for this orchestrator session.

  Your job is to monitor /dev, /multitask, /fn, and any other dispatches for
  workflow compliance. You are read-only on project source — never use Edit
  or Write on PianoidCore, PianoidBasic, PianoidTunner, or any docs/ file.
  You may write only to your own session log at
  docs/development/logs/controller-<id>-<timestamp>.md.

  Initial actions:
    1. Generate controller ID: ctrl-$(openssl rand -hex 2)
    2. Create your session log
    3. Read docs/development/MODULE_LOCKS.md, WORK_IN_PROGRESS.md
    4. Glob docs/development/logs/dev-*.md (non-archive) to enumerate any
       pre-existing active sessions (e.g., orphaned from a prior orchestrator)
    5. Subscribe via Monitor to each pre-existing dev-agent log file (if any)
    6. Send initial pulse to team-lead — confirms boot, may report orphans

  Invariants to enforce — see proposal at docs/proposals/controller-role.md
  sections 5a, 5b, 5c, 5d, and 9. Signal/marker conventions per Section 5e.
  Stale-agent monitoring per Section 8d + failure-mode catalogue Section 12.
  Tier-1 warn, Tier-2 escalate, Tier-3 halt with the SendMessage patterns
  from Section 8.

  Initial watch list: <empty if no orphans, otherwise list>
  Pulse cadence: 15 min while watch list is empty; 5 min when ≥1 dev agent
                 alive.

  STAY ALIVE until orchestrator sends "session ending". Do not exit on your
  own. Wake events: SendMessage from team-lead, Monitor notifications, pulse
  timer.`
})
```

### 13b. Per-dispatch notification (every /dev, /multitask, /update-docs, /review etc.)

```javascript
// Send BEFORE spawning the dev agent so controller is armed for Step 0 timer
SendMessage({
  to: "controller",
  summary: "New agent dispatched",
  message: "Add dev-<new-id> to watch list.
            Skill: /dev
            Task: <one-line>
            Expected file scope (best guess): <list>
            Spawn timestamp: <ISO>"
})
// Then spawn the agent as today
Agent({
  team_name: "pianoid-dev",
  name: "dev-<new-id>",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "<task description>",
  prompt: `Execute the /dev skill. <full prompt as today>`
})
```

For non-`/dev` dispatches (`/update-docs`, `/review`, `/test-ui`, etc.) the same notification pattern applies — controller still wants to know, even though many invariants will not apply to those agents (commit prefix, MODULE_LOCKS row). The controller filters its checks based on the `Skill: /...` field in the notification.

### 13c. Session-end notification

```javascript
// Inside /orchestrator stop graceful-shutdown handler:
SendMessage({
  to: "controller",
  summary: "Session ending",
  message: "Orchestrator session ending. Produce final summary, archive log,
            exit."
})
```

---

## 14. Worked Example — 2-Dev-Agent Session With Controller

Scenario: orchestrator was started 30 minutes earlier — controller is alive, watch list empty, pulses idle (15 min). User now dispatches "Fix MIDI dedup AND add backend parameter safety net". Orchestrator decides to run both in parallel because the conflict matrix says they're file-disjoint.

```
T-30:00 (earlier) /orchestrator start — controller spawned, idle pulse cadence

T+0:00  User: "Fix MIDI dedup. Also add backend param safety net."
        Orchestrator classifies as 2-task /multitask, conflict matrix clean

T+0:01  Orchestrator sends 2 notifications to controller, then spawns 2 agents:
          SendMessage(to: "controller", "Add dev-md01 to watch list, /dev,
                      MIDI dedup, expected files: backendServer.py")
          SendMessage(to: "controller", "Add dev-9a47 to watch list, /dev,
                      param safety net, expected files: pianoid.py,
                      safety_net.py (new)")
          Agent(name: "dev-md01", ..., prompt: "/dev MIDI dedup ...")
          Agent(name: "dev-9a47", ..., prompt: "/dev param safety net ...")

T+0:02  Controller updates watch list (size 0 → 2), pulse cadence flips to 5 min.
        Reads MODULE_LOCKS.md (empty), WORK_IN_PROGRESS.md (empty).
        Sends pulse #1:
          "Pulse 1: 2 agents armed (dev-md01, dev-9a47), locks: empty,
           dirty files: 0 unlocked, 0 locked. Watching for Step 0 timers."

T+0:30  dev-9a47 writes its Step 0 log, controller's Monitor subscription
        delivers the line. dev-md01 has not written yet (slow Telegram inbox).

T+2:01  Controller's 120s Step-0 timer fires for dev-md01. Tier-1 warn:
          SendMessage(to: "team-lead",
            summary: "Tier-1: dev-md01 late Step 0",
            message: "dev-md01 spawned 121s ago, no log file under
                      docs/development/logs/. dev-9a47 logged Step 0 normally.")
        Orchestrator notes this, decides to wait before respawning.

T+2:30  dev-md01 finally writes its Step 0 — inbox lag was the cause.
        Controller updates state, no escalation.

T+5:00  dev-md01 enters Step 4: registers backendServer.py in MODULE_LOCKS.md.
        Controller observes the lock-table update via its Monitor on
        MODULE_LOCKS.md. No conflict with dev-9a47 (which locked pianoid.py).
        Tier-1 informational in the next pulse:
          "Pulse 2: dev-md01 acquired lock on backendServer.py.
           dev-9a47 acquired lock on pianoid.py.
           Cross-agent file proximity: none. Issues: none."

T+8:00  dev-9a47 spawns a Step 4b /fn sub-agent for the safety-net helper.
        /fn-b7c2 edits a NEW file safety_net.py — NOT in dev-9a47's lock list
        (parent's locks: pianoid.py only).
        Controller's git-status sweep detects: safety_net.py dirty, no lock
        match. **Tier-3 halt** (Section 5d "Lock-before-edit invariant"
        + Section 5d Step 4b "fn inherits parent's locks"):
          SendMessage(to: "team-lead",
            summary: "Tier-3 HALT: unlocked dirty file",
            message: "safety_net.py is dirty in PianoidCore but no agent
                      locks it. dev-9a47's parent lock row contains only
                      pianoid.py. /fn child fn-b7c2 must inherit, not extend.")
          SendMessage(to: "dev-9a47",
            summary: "Compliance flag",
            message: "Repo invariant: unlocked dirty file safety_net.py.
                      Pause fn child edits and check with orchestrator.")
        Orchestrator decides this is a NEW-file scope expansion — instructs
        dev-9a47 to retroactively add safety_net.py to its (parent) lock row.
        dev-9a47 updates MODULE_LOCKS.md.
        Controller observes the update, retracts the alert:
          SendMessage(to: "team-lead", summary: "Tier-3 cleared",
            message: "dev-9a47 added safety_net.py to its parent lock row.
                      Invariant restored.")

T+35:00 dev-md01 reaches Step 10a Phase 1: commits with prefix [dev-md01].
        Controller verifies (Section 5d Step 10): commit prefix matches,
        locks released, log NOT archived yet (Phase 2 not yet), WIP entry
        still present (Phase 2 not yet). Tier-1 informational:
          "Pulse 8: dev-md01 Phase 1 done, awaiting orchestrator approval relay."

T+40:00 User: "approve"
        Orchestrator: SendMessage(to: "dev-md01", "User approved. Proceed
                                  with Step 10a Phase 2.")
        dev-md01 archives log, removes WIP row.
        Controller observes: log moved to logs/archive/, WIP row gone.
        State: dev-md01 = CLOSED. Watch list size 2 → 1.

T+45:00 dev-9a47 finishes similarly. State: dev-9a47 = CLOSED.
        Watch list size 1 → 0. Pulse cadence flips back to 15 min.

T+45:01 Controller stays alive — orchestrator session is still running.
        No final summary at this point. Pulse cadence drops to 15 min.

(... session may continue with more dispatches ...)

T+90:00 User: "/orchestrator stop"
        Orchestrator sends:
          SendMessage(to: "controller", "Session ending. Produce final
                                         summary, archive log, exit.")
        Controller produces final summary:
          "Session summary (90 min):
            Agents observed: dev-md01, dev-9a47, fn-b7c2
            Total alerts: 2 (Tier-1: 1 late Step 0, Tier-3: 1 unlocked
                            dirty file — both resolved)
            Invariants violated then restored: 1 (lock-before-edit at T+8min,
                                                  resolved at T+8:05min)
            Suppressions: none
            Recommendation: Step 0 SLA at 120s caught a real lag case but
                            was a false positive (inbox delay, not stall);
                            consider 180s for first-spawn-after-orchestrator-
                            -idle dispatches."
        Sends summary, archives own log to logs/archive/controller-...md, exits.
```

The key value: in this example the controller surfaced the unlocked `safety_net.py` immediately. Without a controller, it would have been caught only at dev-9a47's own Step 10a "Audit locks vs. dirty files" — by which point dev-9a47 had committed the file under a retroactive lock with only a session-log warning. The controller surfaced the issue the instant the dirty file appeared, in front of the orchestrator AND the dev agent, while the change was small enough to either re-lock cleanly or revert cheaply.

A second value the worked example illustrates: between T+45 and T+90 the controller was idle but alive. If the orchestrator (or an `/update-docs` agent dispatched in that window) had touched a source file, the controller would have caught it. The bounded-by-dev-agents alternative would have exited at T+45 and re-spawned only on the next `/dev` — leaving the T+45 to T+next-/dev window unwatched.

---

## 15. Edits Required to Existing Skills

Read-only proposal. Patches not written. Below is the change list with one-line summaries — to be implemented by the user (orchestrator-level Edit) per the sub-agent permission constraint documented in the user's auto-memory `feedback_subagent_perms.md`.

| File | Section / Line | One-line change |
|---|---|---|
| `.claude/commands/orchestrator.md` | After `:455` (the existing "Controller agent" reference in the CRITICAL RULES list) | Insert a full "## Controller Agent" section spanning ~120 lines: definition, lifecycle (permanent-for-session), spawn pattern, invariant list (orchestrator anti-patterns + dev anti-patterns), signal/marker conventions, stale-agent monitoring (Section 8d) + failure-mode catalogue (Section 12), tier rules, suppression mechanism. Pull from sections 4, 5a–5e, 8d, 9, 11, 12, 13 of this proposal. |
| `.claude/commands/orchestrator.md` | Step 1.5 ("Repo Health Check and Session Recovery") | Add a final bullet: "**Spawn the controller** as the last action of Step 1.5. Single Agent call, run_in_background, bypassPermissions. The controller initializes by reading the same lock/WIP/log state Step 1.5 just verified. Spawn happens once per orchestrator session — not per dispatch." |
| `.claude/commands/orchestrator.md` | Step 3 "Spawning Sub-Agents" | Add rule 6: "Per-dispatch controller notification — every Agent dispatch (regardless of skill: /dev, /multitask, /update-docs, /review, etc.) is preceded by `SendMessage(to: 'controller', ...)` with the agent ID, skill, task, and expected file scope. The controller filters its checks based on the skill field." |
| `.claude/commands/orchestrator.md` | Step 3 / "Graceful shutdown" section | Add: "Before exiting, send `SendMessage(to: 'controller', 'session ending')` so it produces a final summary and archives its own log." |
| `.claude/commands/orchestrator.md` | Anti-Patterns table at `:765` | Update the existing `:782` row from "If no controller, check within ~2 min..." to "Controller (always alive once orchestrator is running) handles this. If controller-spawn fails at Step 1.5, fallback to orchestrator polling check at +2min, +5min." |
| `.claude/commands/orchestrator.md` | New row in Anti-Patterns table | "Dispatching an agent without notifying the controller" → "Every Agent dispatch is preceded by `SendMessage(to: 'controller', ...)`. SEVERE — the controller cannot enforce Step-0 SLA on agents it does not know about." |
| `.claude/commands/dev.md` | Step 0 (Initialize Session) | Add note at end: "A controller is always active in orchestrator-driven sessions. Your log file MUST be created within 120s of spawn, your WIP entry MUST be added within 120s, and your locks MUST be acquired before the first source-file edit. The controller will Tier-1 warn at +120s, Tier-2 escalate at +300s. These are not new requirements — they are the existing requirements with explicit timing." |
| `.claude/commands/dev.md` | Step 4 (Acquire Module Locks and Edit Code), under "Lock-before-edit invariant" | Add: "The controller detects unlocked dirty files within seconds — not at Step 10a's audit. Treat lock-before-edit as a hard precondition, not a wrap-up reconciliation." |
| `.claude/commands/dev.md` | Step 4b (`/fn` Sub-Agent Delegation) | Add: "The controller verifies `/fn` parent-lock inheritance — fn-spawned edits must land on files in the parent dev agent's lock list. New files require parent to retroactively add to its lock row before the fn agent edits, or you'll see a Tier-3 halt." |
| `.claude/commands/dev.md` | Step 8 (Update Documentation) | Add: "Doc-gap closure (`:725-728`) is part of THIS session — the controller flags log entries that mention 'doc gap' / 'should be documented' if no doc edit or WIP entry follows before commit." |
| `.claude/commands/dev.md` | Step 10 (Exit Procedures), Phase 1 stop note | Add: "The controller cross-references `git log` against the orchestrator's approval-relay messages — Phase 2 actions (log archive, WIP cleanup) without an approval-relay trigger Tier-2 escalate." |

**Logging additions (per Section 5e) — these are the signal-emission rules that make controller monitoring reliable. Each row references the marker(s) it adds, traceable to checks in Section 5e.2.**

| File | Section / Line | One-line change |
|---|---|---|
| `.claude/commands/dev.md` | "Logging Rule" block at `:104-114` | Replace `### Step N: <Step Name> — <HH:MM>` with `### Step N: <Step Name> — <ISO 8601 UTC>` (e.g. `2026-05-05T12:30:22Z`). One-line bash hint: `$(date -u +%Y-%m-%dT%H:%M:%SZ)`. **Section 5e.5** covers the rationale (day-boundary disambiguation for checks 1, 2, 9, 20, 21, 27). |
| `.claude/commands/dev.md` | New "## Marker Convention" block immediately after "Logging Rule" at `:104` | Add a ~30-line block listing the 28 marker tokens (Section 5e.3 table — including `[BASH-CALL]`/`[BASH-RETURN]`/`[MCP-CALL]`/`[MCP-RETURN]` for stale-agent detection), the format rules (Section 5e.4: own line, square brackets, key=value space-separated, additive to step headings), and the backwards-compat note (Section 5e.6: archived logs lacking markers are exempt). |
| `.claude/commands/dev.md` | Step 0 "Initialize Session" (`:40-114`) | After agent has created log file + WIP entry + (if any) acquired locks, the FIRST line under `## Actions` MUST be `[STEP-0-COMPLETE] {ISO 8601 UTC}`. Marker for check 1. |
| `.claude/commands/dev.md` | Step 1b "Kill Stale Processes" (`:243-264`) | After the `taskkill //F //PID` block, add: "Log each kill as `[STEP-1B-KILL] port=<N> pid=<N>`." Marker for check 4. |
| `.claude/commands/dev.md` | Step 1b "Start Servers With Correct Venv" (`:266-300`) | At the top of the Rules list, add: "Before first venv invocation, log `[STEP-1B-VENV-CHECK] interpreter=<absolute path>`." After successful server start, log `[SERVER-START] role=<backend\|frontend\|adapter> port=<N> pid=<N>`. Markers for checks 5, 6, 7. |
| `.claude/commands/dev.md` | Step 1b "Clean Up After Yourself" (`:325-344`) | Inside the cleanup block, log each shutdown as `[SERVER-STOP] port=<N> pid=<N>`. Marker for check 6. |
| `.claude/commands/dev.md` | Step 4 "Acquire Locks" (`:404-422`) and Multi-Stage Session Management (`:423-430`) | When adding a file to the agent's lock row, log `[LOCK ACQUIRED] {file}`. When removing, log `[LOCK RELEASED] {file}`. Symmetric pair for check 8 — controller cross-references against `MODULE_LOCKS.md` reads to detect intent/state divergence. |
| `.claude/commands/dev.md` | Step 4 "Pre-implementation Data Model Card" (`:391-398`) | Require literal heading `## Data Model Card — <ISO timestamp>` and a final line `[DMC-COMPLETE]` after the card. Marker for check 9. |
| `.claude/commands/dev.md` | Step 4 "Edit Code" (`:432-446`) | After each batch of `Edit`/`Write` calls on a tracked file, log `[EDIT] file=<path>`. After the agent finishes editing a file, log `[FILE-LOC] <path> before=<N> after=<N>` (computed via `wc -l` pre/post). Markers for checks 8, 10. |
| `.claude/commands/dev.md` | Step 4 "Pre-build check" (`:451-467`) | After running `tasklist //M pianoidCuda...`, log `[BUILD-PRECHECK] holders=<comma-pids or none>`. Marker for check 11. |
| `.claude/commands/dev.md` | Step 4 "Build commands" (`:478-503`) | Wrap each build invocation in marker triple: `[BUILD STARTED] {ts} mode=<heavy\|light> variant=<release\|debug>` before, then on success `[BUILD OK] {ts} duration=<s> marker=<grep-string> verified=<yes\|no>`, on failure `[BUILD FAILED] {ts} code=<N> error_summary=<one-line>`. Markers for checks 12, 13. |
| `.claude/commands/dev.md` | Step 4b "Spawning procedure" (`:541-571`) | Before fn-spawn, log `[TEST-WRITTEN] path=<test-file>`. At fn-spawn, log `[FN-SPAWNED] id=<fn-XXXX> target=<file>`. After incorporating fn results into parent log, log `[FN-RESULT] id=<fn-XXXX> status=<ok\|fail>`. Markers for checks 15, 17, 18. |
| `.claude/commands/dev.md` | Step 2 "Baseline Performance Test" (`:346-365`) | After baseline tests pass, log `[BASELINE-TEST] {ts} result=<pass\|fail> perf_log=<path> gpu_mean_ms=<N> sound_corr=<N>`. Marker for check 19. |
| `.claude/commands/dev.md` | Step 5 "Post-Change Performance Test" (`:639-665`) | After the comparison table, log `[REGRESSION-CHECK] {ts} gpu_mean_delta_pct=<N> sound_corr=<N> verdict=<pass\|warn\|fail>`. On `verdict=fail`, also emit `[REGRESSION-DETECTED] {ts} file=<f> metric=<m> delta=<d>` per offending metric. Markers for check 20. |
| `.claude/commands/dev.md` | Step 6 "Debug" (`:666-681`) | Each iteration starts with heading `### Step 6: Debug iteration N — <ISO timestamp>` followed by `[STEP-6-DEBUG iter=<N>]` line. Marker for check 21. |
| `.claude/commands/dev.md` | Step 7 "UI + Audio Verification" (`:683-704`) | When invoking `/test-ui` or `/diagnose`, log `[VERIFY-INVOKE] skill=<test-ui\|diagnose> mode=<audio_off\|audio_on>`. Marker for check 22. |
| `.claude/commands/dev.md` | Step 8 (`:719-767`) | At end of Step 8, log `[STEP-8-COMPLETE] {ts} docs_touched=<comma-paths or none>`. If a doc gap was identified during the session, log `[DOC-GAP] description=<one-line> resolution=<doc-edit\|wip-deferred> ref=<file-or-wip-anchor>`. Markers for checks 23, 24. |
| `.claude/commands/dev.md` | Step 10a "Phase 1" / "Phase 2" (`:822-861`) | At Phase 1 completion: `[STEP-10A-PHASE-1] {ts} commit=<sha>`. At Phase 2 start (after orchestrator approval): `[STEP-10A-PHASE-2] {ts}`. Marker pair for check 27. |
| `.claude/commands/dev.md` | Step 10b (`:862-879`) | Wrap reset in `[STEP-10B-RESET] {ts} phase=start` / `[STEP-10B-RESET] {ts} phase=done` pair. Marker for check 28. |
| `.claude/commands/dev.md` | Step 10c (`:881-914`) | At start of pause procedure: `[STEP-10C-PAUSE] {ts}`. Marker for check 29. |
| `.claude/commands/dev.md` | Step 10e (`:976-1005`) | At start of restart procedure: `[STEP-10E-RESTART] {ts} blocking_agent=<id>`. Marker for check 30. |
| `.claude/commands/dev.md` | New "## Bash & MCP Discipline" subsection in Step 1b (cross-cutting — applies to all subsequent steps) | Mandate the four paired markers. Before EVERY `Bash` invocation: `[BASH-CALL] {ts} {first 80 chars of command, escaped}`. After return: `[BASH-RETURN] {ts} duration_ms=<N> exit_code=<N>`. Before EVERY MCP tool call: `[MCP-CALL] {ts} server=<name> tool=<name> args_summary=<...>`. After: `[MCP-RETURN] {ts} duration_ms=<N> status=<ok\|error>`. Failure to emit is a Tier-2 violation (check 36). The controller's stale-agent monitoring (Section 8d) depends on these pairs. Adds ~20 lines to dev.md. |
| `.claude/commands/dev.md` | New "## Read & Grep Discipline" subsection in Step 1 (Understand Context — applies to all investigation phases: Step 1, Step 5, Step 6, Step 7) | Mandate the two paired markers. Before EVERY `Read` invocation on a project file: `[READ] {ts} path=<path>`. Before EVERY `Grep`/`Glob` on project files: `[GREP] {ts} pattern=<pattern> path=<path>`. Failure to emit is a Tier-2 violation (check 39). The controller's Documentation-First check (Section 8e) and the catch-all coverage of Section 5e.7 limitation 32 depend on these markers. Adds ~15 lines to dev.md. |
| `.claude/commands/dev.md` | Step 1 (Understand Context) preamble (`:188-201`) | Add reference to Section 8e: "A controller is monitoring this — the `[READ]`/`[GREP]` discipline above feeds the Documentation-First compliance check. Skipping `docs/` and going straight to source greps in this step (or in Steps 5/6/7) is detected as a Tier-1 (first occurrence) or Tier-2 (recurring) violation. Exemptions: syntactic/mechanical tasks; doc-internal navigation; deep-dive on a specific source file the doc pointed to." Adds ~5 lines to dev.md. |
| `.claude/commands/orchestrator.md` | New "## Stalled Agent Recovery" subsection (after Conflict Resolution Policy at `:236-300` or in the Anti-Patterns area near `:765`) | Document the protocol when controller reports a stalled agent (Section 8d output). Steps: (1) read the stale-scan report; (2) for each candidate, attempt to identify the gating tool from the unmatched `[BASH-CALL]` / `[MCP-CALL]` marker; (3) check Section 12 catalogue for the failure mode; (4) apply mitigation per 12a–12e (e.g., user prompt for OAuth; respawn with PowerShell Start-Process for long-running starters); (5) if recoverable inline (orchestrator can see the prompt), approve directly; (6) if not, kill the agent (TaskStop) and respawn with adjusted approach. Adds ~30 lines to orchestrator.md. |
| `.claude/commands/orchestrator.md` | Existing `Conflict Resolution Policy` / `Relaying Questions and Fixes` sections (`:236-300`, `:565-571`) | After relaying user approval to a dev agent, log `SendMessage(to: "controller", "approval-relayed agent=<id>")`. Provides the gating signal for check 27. (Orchestrator-side marker, not a dev.md addition — listed here for completeness; see Section 17 open question 6 for the alternative of a structured orchestrator log file.) |
| `.claude/commands/multitask.md` | Phase 3.3a (Spawn Sub-Agents in Parallel) | Add: "Before each wave's spawns, send `SendMessage(to: 'controller', ...)` for every agent in the wave with the wave plan and conflict matrix. The controller pre-arms cross-agent invariant checks for the named file scopes." |
| `.claude/commands/fn.md` | Step 0 / Step 2 (Lock check) | Add: "The controller verifies parent-lock inheritance: if `target_file` is not in `held_locks` and no `parent_agent` is set, it is a Tier-2 escalate. Always verify before editing." |
| `.claude/commands/fn.md` | Step 1 / Step 3 / Step 4 (any Bash, MCP, Read, or Grep invocation) | Same Bash/MCP/Read/Grep discipline as the dev.md rows above: emit `[BASH-CALL]` / `[BASH-RETURN]` / `[MCP-CALL]` / `[MCP-RETURN]` / `[READ]` / `[GREP]` markers. fn agents are also monitored by the controller's stale-scan AND Documentation-First check. Adds ~15 lines to fn.md. |

Total estimated effort: ~180 lines of new/changed text in `orchestrator.md` (controller agent section + stalled-agent recovery), ~120 lines in `dev.md` (5 explanatory notes + ~95 lines of marker rules + 1 timestamp-format change + Bash/MCP discipline + Read/Grep discipline + Step 1 docs-first reference + the `[STEP-0-COMPLETE]` and `[LOCK ACQUIRED]`/`[LOCK RELEASED]` rules), ~5 lines in `multitask.md`, ~20 lines in `fn.md` (lock-check note + Bash/MCP/Read/Grep discipline). Achievable in 3–4 hours of orchestrator-level editing.

---

## 16. Implementation Order

If this proposal is approved:

1. **Land the dev.md marker convention block** (Logging Rule + Marker Convention sections, including the cross-cutting `[BASH-CALL]`/`[BASH-RETURN]`, `[MCP-CALL]`/`[MCP-RETURN]`, and `[READ]`/`[GREP]` discipline subsections). Without this, the controller has no reliable signals to read — every other change depends on it. The four Bash/MCP markers are load-bearing for the 4th axis (stale-agent monitoring, Section 8d + Section 12). The two Read/Grep markers are load-bearing for the 5th axis (Documentation-First, Section 8e).
2. **Land the dev.md per-Step marker requirements** (the ~24 rows in Section 15's logging-additions sub-table, including the high-leverage `[STEP-0-COMPLETE]` / `[LOCK ACQUIRED]` / `[LOCK RELEASED]`, the Bash/MCP discipline, and the Read/Grep discipline). Each Step section gets its specific markers; agents start emitting them on the next session.
3. **Land the orchestrator.md "Controller Agent" section.** Largest change; everything else references it. Defines the role, spawn pattern, the FIVE axes (5a–5d substantive event-driven + Section 8d/12 periodic stale-agent + Section 8e continuous Documentation-First), signal/marker conventions, tier rules.
4. **Add the spawn pattern to Step 3 + Step 1.5 of orchestrator.md.** Once the orchestrator can spawn a controller and notify it on dispatch, the system is operational at minimum-viable level.
5. **Land the orchestrator.md "Stalled Agent Recovery" subsection** (per Section 15 row, mapped to Section 8d coordination protocol + Section 12 catalogue). Without this, the controller's stall-scan output has no documented receiver protocol on the orchestrator side.
6. **Add the dev.md / multitask.md / fn.md compliance notes** (the explanatory rows in Section 15, including the Step 1 docs-first reference and the fn.md Read/Grep discipline). These are hints for the dev agents about controller existence; the controller works without them but the dev agents will be confused by Tier-2 messages otherwise.
7. **Update Anti-Patterns table** in orchestrator.md.
8. **Live-test on a 2-agent /multitask session.** Pick a low-risk pair (one /dev, one /update-docs) to validate spawn, marker emission, pulse, summary, and archive. Add a stall-injection test (e.g., dev agent runs `cmd //c start-pianoid.bat` directly without backgrounding, or invokes an MCP tool with a stale OAuth) to validate the 4th-axis stale-scan + recovery protocol. Add a docs-first injection test (dev agent grep'ing source files for an architectural question without consulting `docs/` first) to validate the 5th-axis Documentation-First check.

The marker convention (Step 1) lands FIRST because adding markers to dev.md does not break anything if no controller is reading them — they are just extra log lines. The controller (Step 3) cannot reliably enforce checks without them. Reverse order would force an interim "best-effort grep" mode that's harder to verify. Stalled Agent Recovery (Step 5) follows the controller spawn (Step 4) because the receiver protocol depends on the controller existing; until it does, the orchestrator's existing ad-hoc kill/respawn behaviour is the fallback. The Documentation-First check (5th axis) is enabled automatically once Steps 1+2 land — no separate Step 5e implementation needed; the controller's algorithm in Section 8e simply reads the Read/Grep markers as they arrive.

---

## 17. Open Questions

(Lifecycle is settled — see TL;DR and Section 4 for the permanent-for-session decision and rationale. The questions below are the remaining open items.)

1. **Controller log archival scope.** Today only dev-agent logs go to `logs/archive/`. Should controller logs go alongside, or to a separate `logs/controller-archive/`? Proposal: same `logs/archive/`, prefix `controller-` already disambiguates.
2. **Pulse cadence under empty watch list.** With permanent-for-session lifecycle, the controller has long stretches with no active dev agents. Default proposed: 15 min during empty watch list (vs 5 min when ≥1 dev agent alive). Alternative: suspend pulses entirely between dispatches and rely on the dispatch-notification SendMessage to re-arm. Proposal: keep 15 min — "I'm alive" signal is its own debugging value.
3. **Tier-3 enforcement strength.** Today the proposal says "advisory" message to dev agents — they can ignore the SendMessage. Should Tier-3 instead trigger an orchestrator-side automatic Step 10c pause via SendMessage to the violating agent? Proposal: keep advisory; orchestrator owns enforcement decisions. Auto-pause from controller would blur the boundary in Section 10.
4. **Notification scope for non-/dev dispatches.** Section 6 says the orchestrator notifies the controller on every dispatch including `/sync`, `/test-ui`, `/pianoid-ui`. This catches accidental source edits but adds notification volume. Alternative: notify only on `/dev`, `/multitask`, `/fn`, `/update-docs`, `/review` — i.e., skills that *can* edit project state. Proposal: notify all (current text), reconsider if telemetry shows the non-editing skills generate noise.
5. **Detecting orchestrator self-reads of source files (check 32).** The orchestrator's tool-use record is in its own conversation context, inaccessible to the controller. Today the controller catches the consequence (unlocked dirty file via check 8 + `[LOCK ACQUIRED]` divergence) but not the read itself. Options: (a) accept the gap and rely on consequence-detection; (b) require the orchestrator to write its own session log under `docs/development/logs/orchestrator-<session-id>-...md` capturing every Read/Bash tool call against project paths — a substantial new convention. Proposal: option (a). Option (b) is heavier than the failure mode warrants.
6. **Orchestrator-side approval-relay marker (check 33).** The proposal asks the orchestrator to `SendMessage(to: "controller", "approval-relayed agent=<id>")` after each user-approval forward. This is the gating signal for check 27 (no premature Phase 2). Without it, the controller has to read the team-lead inbox file to detect approval relays — works today but ties controller correctness to inbox-file format stability. Should the orchestrator also write the approval-relay action to a structured log file, separate from the SendMessage? Proposal: SendMessage is sufficient; revisit if inbox format changes. Both options addressed in Section 15's orchestrator.md edit row.
7. **Stale-agent scan cadence (30-min default, tunable).** Section 8d defaults to a 30-min cadence per the user's specification. This is a tunable trade-off: shorter cadence catches stalls faster but increases controller wakeups (still cheap, but adds log noise per pulse); longer cadence accepts more dead-time before a stalled agent is reported. Proposal: 30 min as user-specified; revisit if telemetry shows that (a) most stalls produce visible alerts before 30 min via other channels, in which case bump to 60 min; or (b) stalls cluster around well-known patterns where a pre-emptive check (Section 5e.2 row 37 with the Section 12 pattern catalogue) catches them within seconds, making the 30-min sweep less load-bearing.
8. **Documentation-First windowing parameter (N=3 default, tunable).** Section 8e uses a sliding window of the last N=3 non-NEUTRAL `[READ]`/`[GREP]` events to decide whether the agent is grep-first vs docs-first. The user suggested N=3 as the default. Trade-offs: smaller N (e.g., 2) is more sensitive — flags faster but with more false positives; larger N (e.g., 5) is more lenient — fewer false positives but lets a few source-only reads through. Alternative model: time-window (e.g., last 2 minutes of investigation phase) instead of event-window (last 3 events). Proposal: keep N=3 event-window — easier for the controller to reason about and matches the user's intuition. Revisit if (a) telemetry shows persistent false-positive rate >20% on otherwise-compliant sessions, in which case bump to N=5; or (b) agents start gaming the window (e.g., one cheap doc-read followed by 100 source-reads), in which case switch to time-windowed.

---

## 18. Non-Goals

This proposal does NOT:

- Spawn a separate controller per skill — one controller per orchestrator session covers everything (`/dev`, `/multitask`, `/fn`, and any other dispatch the orchestrator makes).
- Change the dev-agent's own discipline (Steps 0/1b/4/10 stay as defined). The controller enforces the existing rules; it does not introduce new ones.
- Change the orchestrator's user-facing protocol (Telegram, dual-output rule, classification table all unchanged).
- Add new tools or MCP servers — controller uses existing harness primitives.
- Persist state across orchestrator sessions — each `/orchestrator start` gets a fresh controller.
- Block agents — all enforcement is advisory; orchestrator decides actions.
- **Auto-recover stalled agents.** The 4th axis (Section 8d periodic stale-scan + Section 12 catalogue) detects stalls and reports them; it never invokes `TaskStop`, never respawns, never auto-approves CLI permission prompts, never opens browser tabs to complete OAuth flows. Recovery is the orchestrator's job per the failure-mode-specific protocol in Section 8d / Section 12. This boundary is intentional: granting recovery authority to the controller would require it to also have actor-level permissions (Bash, TaskStop), which would expand its surface area beyond the read-only-monitor design and reintroduce the ambiguity Section 10 was designed to eliminate.
- **Run more often than every 30 minutes for stall detection.** The cadence is deliberate: shorter intervals create false positives on slow legitimate work (large CUDA build, full pytest, npm cold install — all in F8). Sub-30-min stall sweeps produce noise faster than they catch real stalls. Pre-emptive flagging on the moment of `[BASH-CALL]` against the suspicious-pattern regex (Section 12.6) is the controller's fast-path for catching stalls early; the 30-min sweep is the slow-path safety net.
