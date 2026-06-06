# Agent-Stall-Resilience Proposal

**Status:** IMPLEMENTED — all three proposed primitives are live conventions in `.claude/commands/dev.md` (+ `fn.md`): **`[PROGRESS]` heartbeat** (≥ every 3 min during long ops; controller fast-freshness flags >8 min silent), **`[PERM-RISK]` pre-action marker** (before any gate-risky action), and the **tiered stall cadence** (8-min Tier-2 / 20-min Tier-3 replacing the single 30-min sweep), plus the §6.3 "re-route the prompt, never relay the invisible CLI prompt to the user" fix. The controller (orchestrator.md) + the CLAUDE.md bypassPermissions/team-allowlist docs cover the rest. Stale "Draft for review" header. Archived 2026-06-06.
**Driver:** The 2026-05-23/24 orchestrator session had repeated agent stalls that the **USER** caught (CLI showing "idle") before the orchestrator did. The controller — which already exists and was implemented from `controller-role.md` — did not surface them proactively. The user requested: a periodic stall-monitor, improved agent logging to identify stalls from the log, special attention to the CLI-permission-request issue, and logging of any action that may exceed pre-granted permission.
**Scope:** `.claude/commands/dev.md`, `.claude/commands/orchestrator.md`, the controller spec (currently in `docs/proposals/archive/controller-role.md`, mirrored into `orchestrator.md` "Controller Agent" + `dev.md` markers). `fn.md` and `multitask.md` inherit the dev.md marker rules. **No source-code or runtime impact** — skills and docs only.
**Relationship to existing work:** This is **not** a from-scratch design. The controller, the `[BASH-CALL]`/`[MCP-CALL]` marker pairs, the 30-min stale sweep, the Section 12 failure-mode catalogue, and the "Stalled Agent Recovery" protocol are **already in place** (see `controller-role.md` and the live `orchestrator.md:217-303`, `:1052-1099`, `dev.md:47-235`, `:430-452`). This proposal diagnoses **why that machinery failed to catch this session's stalls** and adds the three missing primitives the user asked for, as one coherent model layered on top.

---

## TL;DR — Recommendation

The existing controller catches stalls via a **30-minute periodic sweep** that keys almost entirely on **unmatched `[BASH-CALL]`/`[MCP-CALL]` markers** (the permission-stall signature). This session proved that insufficient for three reasons, each a structural gap:

1. **Latency.** 30 minutes is far slower than the user noticing "idle" in the CLI. By the time the sweep would fire, the user has already flagged it. The detector is slower than the human it is meant to replace.
2. **Wrong-signal coverage.** Two of this session's three stall classes produce a **clean final marker**, not an unmatched tool-call marker, so the sweep's decision matrix classifies them as healthy:
   - **`idleReason=failed` (Anthropic-side rate-limit / error stop)** — `dev-preset-bugs` STOPPED on a rate-limit. The last log line is whatever it finished; there is no dangling `[BASH-CALL]`. The agent is *terminated*, not *stuck in a tool call*. Nothing in the current model models "the agent process is no longer running."
   - **Idle-after-a-step** — agents that completed `[STEP-0-COMPLETE]` (or any step) then never advanced. The last marker is a normal, recent step boundary. The 8d matrix treats `< 30 min + step heading` as "active." A freshly-idled agent looks healthy for a full 30 minutes.
3. **No freshness signal between action boundaries.** Markers only fire at Bash/MCP/Read/step boundaries. During a long derivation, a long build, or a "thinking" pause, there is no log growth at all — so "log is fresh" and "log is frozen" are indistinguishable until the next boundary, which a stalled agent never reaches.

The fix is a **single coherent resilience model** built from three new primitives plus a redefinition of how stalls are detected and answered:

- **Primitive A — `[PROGRESS]` heartbeat (dev.md).** A periodic liveness marker emitted at every step boundary AND at least every N minutes during any long-running operation. This makes **log-freshness** a first-class, always-available signal: a live agent's log is never silent for more than N minutes; a stalled agent's heartbeat stops. This is what lets a monitor catch *all three* stall classes from the log alone — including idle-after-step and failed-termination — without waiting for a tool-call marker.
- **Primitive B — `[PERM-RISK]` pre-action marker (dev.md).** Before any action that may trip a CLI permission prompt (process-spawn via Bash/`Start-Process`/`run_in_background`, `taskkill`/`Stop-Process`, anything in CLAUDE.md "Known gaps"), the agent emits `[PERM-RISK] {ts} action=<desc> method=<...> gate-risk=<why>` **first**. If the agent then goes silent, the **last marker pinpoints the prompting action** — instantly classifying the stall as a permission-stall (not a crash) with the offending command known, and removing the need for the monitor to regex-match `[BASH-CALL]` text against a catalogue after the fact.
- **Primitive C — fast per-active-agent freshness check (controller).** Replace the single 30-min sweep with a **tiered cadence**: a lightweight **freshness check every 3 minutes** per *active* agent (is the heartbeat fresh?), keeping the existing 30-min deep sweep as the slow-path safety net. The freshness check is cheap because the heartbeat gives it an O(1) signal: read the last `[PROGRESS]`/marker timestamp, compare to now. Stall threshold: **no new marker for > 2× the heartbeat interval** (default 8 min, i.e. ~2.7× a 3-min heartbeat — generous enough to not false-positive on a single slow step, tight enough to beat the user).

**Detection decision (enhance vs. dedicated monitor): enhance the existing controller.** A separate monitor would duplicate the controller's watch-list, its `Monitor` subscriptions on agent logs, and its SendMessage-to-orchestrator channel — and would create a second agent to keep alive, a second thing that can itself stall. The controller already owns the watch list and the reporting channel; it already has a periodic-tick model (the 30-min sweep). We make that tick faster and add the heartbeat-freshness logic to it. One monitor, one channel, one coherent escalation path. (See §4 for the dedicated-monitor counter-argument and why it loses.)

**Permission-stall response redefinition (the user's special-attention item).** The current orchestrator protocol's second-choice action is "tell the user via Telegram: check the CLI for a pending prompt" (`orchestrator.md:1090`). **That is the exact inversion the Autonomy principle (`orchestrator.md:19-33`) forbids** — it makes the user the operational fallback for a stall. This proposal **re-orders the response so relaying the prompt to the user is the last resort, never the default**: on a `[PERM-RISK]`-pinpointed stall the orchestrator (1) re-routes the agent to the documented no-prompt method, or (2) pre-grants the *specific* command, and only (3) escalates to the user if both fail — and even then asks for a *decision/pre-grant*, not "go click the prompt."

Total cost: ~25 new lines in `dev.md` (two markers + heartbeat-during-long-ops rule), ~30 changed lines in `orchestrator.md` (controller cadence + permission-stall response re-ordering), ~10 lines in the controller spec (tiered cadence + `idleReason` + heartbeat-freshness matrix). The four existing marker pairs and the catalogue stay; nothing is removed.

---

## 1. Why the Existing Controller Did Not Catch This Session's Stalls

The controller was built (per `controller-role.md`) precisely to catch stalls. It is implemented: `orchestrator.md:217-303` defines the Controller Agent, `:1052-1099` defines Stalled Agent Recovery, `dev.md:47-235` defines the marker convention including `[BASH-CALL]`/`[MCP-CALL]`. So the failure is not "no controller." The failure is that **the controller's stall model is too narrow and too slow.** Mapping each of this session's incidents to the existing model:

| Incident (this session) | What the agent's last log line was | How the existing 30-min sweep (8d matrix) classifies it | Why it failed |
|---|---|---|---|
| **(a) `dev-preset-bugs` STOPPED — Anthropic-side rate-limit, `idle_notification idleReason=failed`** | Whatever step it last completed — a *clean* line, no dangling `[BASH-CALL]` | `< 30 min + normal narration → none (active)`. After 30 min: `T3 normal narration → halt-and-investigate`. | The agent is **terminated**, not stuck. The model has no "is the agent process alive?" check and no `idleReason` awareness. It would wait 30 min, then mis-label a *dead* agent as a *slow* one. Recovery (re-spawn `dev-preset-bugs-2`) only happened because the **user** saw the CLI idle. |
| **(b) Agent IDLED right after `[STEP-0-COMPLETE]` without auto-continuing the multi-step task** | `[STEP-0-COMPLETE] {recent ts}` — a clean *final-of-step* marker | `< 30 min + step heading → none (active)`. | A freshly-idled agent is indistinguishable from a working one for 30 min. There is no heartbeat to say "I am still progressing." Idle-after-step is invisible to a boundary-only model. |
| **(c) Recovery required re-spawning a fresh instance (`dev-preset-bugs → dev-preset-bugs-2`)** | n/a — this is the recovery, not the stall | — | The recovery path worked, but it was **user-initiated**. The point of the controller is that this should be **controller-initiated** within minutes, not user-initiated after the user happens to glance at the CLI. |
| **(d) CLI-permission-prompt stalls (recurring, the special-attention item)** | `[BASH-CALL] {ts} 'cmd //c start-pianoid.bat'` or `Start-Process ...` with NO matching `[BASH-RETURN]` | This one IS modeled: `unmatched [BASH-CALL] 30–60 min → T2 high`. | The *detection* model is correct here — but (i) it still waits up to 30 min, and (ii) the *response* (`orchestrator.md:1090`) routes to the user ("check the CLI"), which is the inversion the user flagged. |

**The structural conclusion:** the existing model detects exactly one stall shape (dangling tool-call marker) on a 30-minute clock, and answers the permission case by leaning on the user. This session needed it to detect **three** shapes within **minutes** and answer the permission case **without** the user. Hence the three primitives + cadence + response re-ordering below.

**A second, quieter failure worth naming: does the 30-min timer even fire?** A backgrounded controller agent wakes on (i) inbound `SendMessage`, (ii) `Monitor` notifications on watched logs, (iii) its own timers. A *stalled* agent produces no `Monitor` notification (no log growth). If the orchestrator is also quiet, the controller may have no external event to wake it, and a self-scheduled "every 30 min" tick inside an idle agent is not guaranteed to fire on wall-clock time. The faster cadence in §5 is therefore paired with an **orchestrator-driven poke** (§5.4): the orchestrator, which IS reliably active (it relays user messages), pings the controller on a timer so the controller's freshness check is driven by a live clock rather than relying on a backgrounded agent's self-timer. This closes the "the monitor itself went quiet" hole that a pure self-timer leaves open.

---

## 2. Primitive A — `[PROGRESS]` Heartbeat Logging (dev.md convention)

### 2.1 The marker

```
[PROGRESS] {ISO 8601 UTC} step=<N|name> note=<short free-text>
```

Example:
```
[PROGRESS] 2026-05-24T09:42:10Z step=4 note=editing pianoid.py PresetLibrary integration
[PROGRESS] 2026-05-24T09:50:11Z step=4 note=heavy build running, 8 min elapsed
```

### 2.2 When it is emitted

Two triggers, both mandatory:

1. **At every step boundary.** When the agent writes its `### Step N: <Name> — <ISO ts>` heading (the existing convention, `dev.md:33-45`), it also emits a `[PROGRESS]` line with `step=N`. This is essentially free — it co-locates with the step heading the agent already writes — and gives the freshness check a clean per-step pulse.

2. **At least every N minutes during any long-running operation.** Any single operation expected to exceed the heartbeat interval — a `--heavy` CUDA build, a full `pytest` run, a long ESPRIT/modal derivation, a `/test-ui` or `/diagnose` sub-skill invocation, an extended "thinking"/analysis stretch with no tool calls — gets a `[PROGRESS]` line emitted **before** the long op starts and again roughly every N minutes while it runs (the agent emits the next heartbeat as soon as it regains control between sub-steps, or at the start of the next tool call). `note=` carries elapsed time / what is running.

**Default N = 3 minutes.** Rationale: a single slow legitimate step (a heavy build can run 5–10 min) must not silence the log past the stall threshold. With N=3 and a stall threshold of 8 min (§5.2), a build that emits a heartbeat at start and every ~3 min keeps the log fresh throughout; only a genuine stall (no heartbeat for > 8 min) trips the alarm.

### 2.3 Why this is the load-bearing primitive

The existing markers are all **action-boundary** signals: they fire when something happens (a Bash call, a read, a step transition). The gap they leave is the **interval between actions** — exactly where idle-after-step (incident b) and "thinking" stalls live. `[PROGRESS]` converts liveness from an action-boundary signal into a **time-based signal**: a healthy agent's log grows on a clock, independent of whether it happens to be calling a tool right now. This is what makes **all three** stall classes detectable from the log alone:

- **Permission stall (d):** heartbeat stops because the agent is blocked in the gated tool call. (Also caught by unmatched `[PERM-RISK]`/`[BASH-CALL]` — belt and suspenders.)
- **Idle-after-step (b):** heartbeat stops because the agent went idle after the step boundary. Caught *only* by the heartbeat — no other signal exists.
- **Failed/terminated (a):** heartbeat stops because the process is gone. Caught by the heartbeat (no growth) and confirmed by the liveness probe (§5.3).

A stalled agent is now, definitionally, **an agent whose heartbeat has stopped.** That is the whole detection model in one sentence.

### 2.4 Cost

~3–5 extra log lines per step plus ~1 line per N minutes of long-op runtime. For a typical session that is a few dozen lines — negligible against the 200–300 lines the existing `[BASH-CALL]` pairs already add (`controller-role.md` §5e.6).

---

## 3. Primitive B — `[PERM-RISK]` Pre-Action Marker (dev.md convention)

### 3.1 The marker

```
[PERM-RISK] {ISO 8601 UTC} action=<short desc> method=<bash-bg|start-process|launcher-rest|taskkill|mcp-auth|...> gate-risk=<why this may prompt>
```

Examples:
```
[PERM-RISK] 2026-05-24T09:55:01Z action="start backend" method=start-process gate-risk="Start-Process fresh process may trip long-running gate first time per session"
[PERM-RISK] 2026-05-24T10:01:22Z action="kill PID 18244 on :5000" method=taskkill gate-risk="taskkill on a high PID can hit UAC/harness gate"
```

### 3.2 When it is emitted

**Before any action that may exceed pre-granted permission / trip a CLI prompt** — i.e. before the corresponding `[BASH-CALL]`/`[MCP-CALL]`. The trigger set is exactly the CLAUDE.md "Known gaps in `bypassPermissions`" list plus the Section 12 catalogue:

| Action class | `method=` | Emit `[PERM-RISK]` because |
|---|---|---|
| Process spawn via Bash `run_in_background: true` | `bash-bg` | Long-running-process harness gate (the dominant case) |
| `PowerShell Start-Process` on a fresh process | `start-process` | Can trip the long-running gate the first time per session |
| Backend start via launcher REST | `launcher-rest` | Lowest risk, but log it so the *no-prompt* method is recorded as chosen |
| `taskkill` / `Stop-Process` on a non-trivial PID | `taskkill` | UAC / harness gate on system/high PIDs (inconsistent) |
| MCP tool whose name matches `*auth*\|*authenticate*\|*pair*\|*init*` | `mcp-auth` | OAuth re-auth flow opens a browser/CLI prompt |
| `chrome-devtools__*` after a long session | `mcp-stdio` | stdio-drift hang |
| TTY-opening Bash (`git rebase -i`, bare `python`, `gcloud auth login`) | `tty` | Always gates — should be avoided, but if attempted, mark it |

The marker is emitted **once per risky action**, not for every Bash call. This keeps it a **high-signal** marker (unlike `[BASH-CALL]`, which fires for everything): the *presence* of an unmatched `[PERM-RISK]` as the last log line is, by construction, a permission-stall with the method and reason already named.

### 3.3 What it buys the monitor

The existing detection (`controller-role.md` §8d, §12) classifies a permission-stall *retroactively* by regex-matching the unmatched `[BASH-CALL]` command text against the catalogue. `[PERM-RISK]` makes that **a priori and explicit**:

- **Instant classification.** Last marker is `[PERM-RISK] ... method=start-process ...` → it is a permission-stall, method known, no regex needed.
- **Disambiguation from a crash.** If the last marker is `[PROGRESS]` (not `[PERM-RISK]`) and the heartbeat stopped, it is a crash/failure/idle, not a permission stall → different recovery (re-spawn vs. re-route). This is exactly the (a)-vs-(d) distinction the current model conflates.
- **Pre-emptive option.** The controller can flag the moment a `[PERM-RISK] method=bash-bg` appears (before the call even goes silent) and let the orchestrator redirect the agent to a no-prompt method *before* the stall happens (extends the existing pre-emptive check, `controller-role.md` §5e.2 row 37).

### 3.4 Relationship to `[BASH-CALL]`

`[PERM-RISK]` does **not** replace `[BASH-CALL]`. `[BASH-CALL]` wraps *every* Bash call (the generic stall net); `[PERM-RISK]` precedes *only* risky ones (the high-signal classifier). Order in the log for a risky action:

```
[PERM-RISK] {ts} action="start backend" method=start-process gate-risk="..."
[BASH-CALL]  {ts} Start-Process -WindowStyle Hidden -FilePath ...
   ... (silence — the gate prompted) ...
```

The monitor reads bottom-up: unmatched `[BASH-CALL]` confirms "stuck in a call"; the `[PERM-RISK]` immediately above names *why* and *how to fix*.

---

## 4. Detection Architecture — Enhance the Controller, Not a New Monitor

The user asked for "a periodic stall-monitor." Two ways to deliver it:

**Option 1 — dedicated stall-monitor agent.** A second permanent agent that only watches log freshness.
**Option 2 — enhance the existing controller's periodic tick.** Add the freshness check to the controller's already-existing periodic sweep, make the cadence tiered.

**Recommendation: Option 2.** Reasons:

1. **The controller already is the stall-monitor.** Its §8d 30-min sweep *is* a periodic stall-monitor — it is just too slow and too narrow. We are not adding a capability; we are fixing the cadence and signal of one that exists.
2. **No duplicated infrastructure.** A dedicated monitor would need its own watch list (which agents are active?), its own `Monitor` subscriptions on each log, and its own SendMessage channel to the orchestrator. The controller already maintains all three. Two agents reading the same logs and both messaging the orchestrator is pure duplication and a coordination surface.
3. **One more agent is one more thing that can stall.** A dedicated monitor is itself a backgrounded agent subject to the same "did its timer fire?" problem (§1). Folding the check into the controller — which is *already* woken by `Monitor` notifications on every watched log and is *already* poked by the orchestrator on dispatch — means fewer independent liveness assumptions. We still add the orchestrator-poke (§5.4) so the *controller's* clock is externally driven.
4. **Coherence.** Stall detection and the other compliance checks (locks, Step-0 SLA, docs-first) share the same watch-list lifecycle (agent dispatched → CLOSED). Splitting stall detection into a separate agent fragments that lifecycle for no benefit.

The one honest cost of Option 2: if the *controller itself* stalls or fails, stall detection goes with it. This is mitigated by (a) the orchestrator-poke (§5.4) revealing a dead controller within one poke interval, (b) the existing fallback (`orchestrator.md:301-303`) that re-spawns the controller at the next Step 1.5 / dispatch, and (c) the orchestrator's own minimal liveness floor (§5.5). A dedicated monitor would have the identical single-point-of-failure unless *it* were also monitored — an infinite regress the orchestrator-poke terminates cleanly at one level.

---

## 5. Periodic Stall-Monitor — Cadence, Threshold, Escalation (controller spec change)

### 5.1 Tiered cadence (replaces the single 30-min sweep)

| Tier | What runs | Cadence | Cost |
|---|---|---|---|
| **Fast freshness check** | For each *active* agent, read the last marker timestamp (last `[PROGRESS]`/any marker/step heading), compute `now − last`, apply the threshold | **Every 3 min** | O(active agents) cheap reads — the heartbeat makes this an O(1)-per-agent timestamp comparison |
| **Deep sweep** (existing §8d) | Full last-entry classification (unmatched `[BASH-CALL]`/`[MCP-CALL]`, `[PERM-RISK]`, final-marker, liveness probe), cross-agent lock/dirty audit | **Every 15 min** (was 30) | Heavier, but rare |

The fast check is the new proactive catcher; the deep sweep is the safety net + the cross-agent invariant pass. 3 min beats the user's "glance at the CLI" reaction time in practice while staying well clear of false-positives on a single slow step (because the heartbeat keeps the log fresh through slow steps).

### 5.2 Stall threshold

**An active agent is STALLED when its log has gained no new marker (heartbeat or otherwise) for more than `STALL_THRESHOLD`.**

- **Default `STALL_THRESHOLD = 8 minutes`** (≈ 2.7× the 3-min heartbeat; ≥ 2× covers one missed heartbeat plus jitter).
- A heartbeat every 3 min means a live agent is never silent > ~3 min; 8 min = two-and-a-half missed heartbeats = unambiguously not progressing.
- Agents whose last marker is a **legitimate-idle final marker** (`[STEP-10A-PHASE-1]`, `[STEP-10A-PHASE-2]`, `[STEP-10B-RESET phase=done]`, `[STEP-10C-PAUSE]`) are **exempt** — they are correctly waiting for the orchestrator (this preserves the existing §8d "final marker → idle, not stalled" carve-out). The freshness check skips agents at a known wait-state.

### 5.3 Stall classification (what kind of stall) — extends the §8d matrix

When the freshness check trips (last marker > `STALL_THRESHOLD` ago), classify by the **last marker type** to pick the recovery path:

| Last marker before silence | Classification | Confidence | Recovery path |
|---|---|---|---|
| Unmatched `[PERM-RISK]` (or `[PERM-RISK]` then unmatched `[BASH-CALL]`/`[MCP-CALL]`) | **Permission stall** — method named in the marker | highest | §6 permission response (re-route / pre-grant, NOT user-prompt) |
| Unmatched `[BASH-CALL]`/`[MCP-CALL]` with no `[PERM-RISK]`, command matches §12 catalogue | **Permission stall** — classify via catalogue (existing path) | high | §6 |
| Unmatched `[BASH-CALL]`/`[MCP-CALL]`, command does NOT match catalogue | **Generic tool hang** | medium | Probe liveness (below); if dead → re-spawn; if alive → orchestrator probes the agent |
| `[PROGRESS]` or step heading (clean), heartbeat simply stopped | **Idle-after-step OR failed/terminated** — needs liveness probe to disambiguate | medium | Liveness probe (below) |

**Liveness probe (NEW — closes the `idleReason=failed` gap, incident a).** When the last marker is clean (not a dangling tool call), the controller cannot tell idle-after-step from a dead process by the log alone. It reports the candidate to the orchestrator with `needs-liveness-probe`. The **orchestrator** (the actor) then checks whether the agent is actually alive:
- Read the team-lead inbox for any terminal/idle notification from that agent (the harness surfaces `idle_notification idleReason=failed` here — this is the rate-limit/error signal).
- If `idleReason=failed` / agent reported done-but-incomplete / no longer in the active team roster → **terminated**. Recovery: re-spawn a fresh instance with the session log as context (exactly the `dev-preset-bugs → dev-preset-bugs-2` move, but controller-triggered within minutes, not user-triggered).
- If the agent is alive but idle → **idle-after-step**. Recovery: `SendMessage(to: "<agent>", "Continue with Step <N+1> ...")` — a nudge, not a re-spawn.

This is the missing branch: the current model has no "is it dead or just idle?" disambiguation, so it could neither nudge nor re-spawn proactively.

### 5.4 Escalation chain (controller → orchestrator → re-direct/re-spawn)

```
Fast freshness check trips (heartbeat > STALL_THRESHOLD)
   │
   ▼
Controller classifies (§5.3) and sends ONE SendMessage to team-lead:
   "STALL: agent=<id> last-marker=<type> '<summary>' age=<min> class=<perm|hang|idle-or-dead> action=<recommended>"
   │
   ▼
Orchestrator (the ACTOR) responds per class:
   • perm  → §6 permission response (re-route to no-prompt method / pre-grant the specific command)
   • idle  → SendMessage nudge ("continue with Step N+1")
   • dead  → re-spawn fresh instance, reuse original agent ID, session log as context
   • hang  → liveness probe → dead→respawn / alive→nudge
   │
   ▼
Orchestrator notifies controller: SendMessage(to:"controller","stall recovered: agent=<id> action=<...>")
   │
   ▼
Controller resumes normal freshness checks for that agent
```

**Orchestrator-poke (closes the "did the controller's timer fire?" hole, §1).** The orchestrator — reliably active because it relays user traffic — sends the controller a lightweight `SendMessage(to:"controller","freshness-tick")` on its own ~3-min cadence whenever ≥1 agent is active. This **drives the controller's fast check from a live clock** rather than trusting a backgrounded agent's self-timer. If the controller does not acknowledge a poke within one interval, the controller itself is suspect → orchestrator re-spawns it (existing fallback, `orchestrator.md:301-303`) and, in the meantime, runs the minimal liveness floor (§5.5). The poke is cheap (one SendMessage per 3 min) and makes the whole detection loop depend only on the orchestrator's liveness, which is the one component guaranteed to be alive (it is the session).

### 5.5 Minimal orchestrator liveness floor (degraded mode)

If the controller is absent (spawn failed, crashed, not yet re-spawned), the orchestrator must not regress to "user catches stalls." Degraded-mode floor: when the orchestrator goes to relay a result or finds itself idle with ≥1 active agent, it does a **one-line freshness glance** — read the most recent agent log's last marker timestamp; if > `STALL_THRESHOLD`, run §5.3 classification itself. This is the existing `:782` "check within ~2 min" fallback, generalized from Step-0-only to all-steps via the heartbeat. It is a floor, not the primary path — the controller is the primary path.

---

## 6. CLI-Permission Handling (special attention)

This is the user's explicit focus. Three parts: the no-prompt **method hierarchy** (prevention), the **detection** (the `[PERM-RISK]` marker), and the **response** (re-ordered so the user is the last resort).

### 6.1 No-prompt method hierarchy (tighten dev.md)

The hierarchy already exists in `dev.md:436-452` for backend startup. This proposal **states it as a general rule for ALL gate-risky process spawns** and ties it to the `[PERM-RISK]` marker:

```
PREFERRED:  launcher REST API   (HTTP POST, no process-spawn → no gate at all)
FALLBACK:   Start-Process -WindowStyle Hidden -RedirectStandardOutput ...
              (detached; may prompt ONCE on the first fresh process per session)
NEVER:      Bash run_in_background: true for a server/long-running child
              (the dominant gate-tripper; only acceptable as documented LAST RESORT
               when 1+2 are unavailable, and only with a [PERM-RISK] marker first)
```

Every spawn at FALLBACK or LAST-RESORT level emits `[PERM-RISK] method=<...>` first. The PREFERRED launcher-REST path emits `[PERM-RISK] method=launcher-rest` too — not because it is risky, but so the log *records that the no-prompt method was the one chosen*, which is itself the evidence that the agent followed the hierarchy.

**dev.md edit:** the current Step 1b "Start Servers With Correct Venv" block (`dev.md:393-428`) still leads with the Bash `run_in_background` pattern (line 395-401) and only mentions the hierarchy later (line 436). Re-order so the hierarchy (launcher-REST → Start-Process → Bash-bg-last-resort) is the **primary** instruction and the bare `run_in_background` example is explicitly demoted to LAST RESORT with the `[PERM-RISK]` requirement attached. (Detail in §7.)

### 6.2 Detection

Covered by Primitive B (§3): an unmatched `[PERM-RISK]` (or `[PERM-RISK]` → unmatched `[BASH-CALL]`/`[MCP-CALL]`) as the last log line = permission-stall, method already named. The freshness check (§5.1) trips on it within ~3–8 min; the pre-emptive check can flag it the instant the `[PERM-RISK] method=bash-bg` line appears.

### 6.3 Response — DO NOT relay the prompt to the user (re-ordered)

**The change the user asked for.** The current protocol (`orchestrator.md:1087-1091`) lists, in order: (1) inline approve if visible, (2) **tell the user to check the CLI**, (3) kill+respawn. Step 2 is the inversion. New order:

```
On a [PERM-RISK]-classified permission stall, the orchestrator:

1. RE-ROUTE to a no-prompt method (DEFAULT).
   Kill the stuck call's child if any, and SendMessage the agent the documented
   alternative for the named method:
     • method=bash-bg / start-process for a server  → "Use the launcher REST API:
       curl -X POST http://127.0.0.1:3001/api/start-backend. If the launcher is
       down, use Start-Process -WindowStyle Hidden (see dev.md:444)."
     • method=taskkill on a high PID → "Scope by image name (taskkill //F //IM
       <name>) or //T."
     • method=mcp-auth → handle per §6.4.
   Re-routing requires NO user involvement and resolves the dominant case.

2. PRE-GRANT the specific command (if re-route is not applicable and the command
   is known-safe). The orchestrator adds the exact Bash pattern to
   settings.local.json (e.g. Bash(cmd //c start-pianoid.bat)) OR runs that one
   command in its OWN context (orchestrator Bash calls render as deltas it can
   approve). Scoped, specific — not the whack-a-mole the broader bypass replaced,
   because it is a one-off unblock, not a standing policy.

3. ESCALATE to the user — LAST RESORT, and as a DECISION, not an operation.
   Only if re-route and pre-grant both fail. Even then, the orchestrator does NOT
   say "go click the CLI prompt." It asks for a decision/permission:
   "Agent <id> needs to run <command>, which trips a permission gate I can't clear
   from here. May I pre-grant it / should I take a different approach?" The user
   supplies a DECISION; the orchestrator performs the operation.
```

This keeps the Autonomy principle (`orchestrator.md:19-33`) intact: a permission stall becomes a *re-dispatch decision*, not a *manual user step*. Relaying the raw prompt to the user — the thing that burned this session — is removed from the default path entirely.

### 6.4 MCP auth / stdio-drift sub-case

Unchanged in spirit from `orchestrator.md:1084-1085` but re-ordered to match §6.3: for `method=mcp-auth`, re-route is usually impossible (the server genuinely needs re-auth), so this is the one case that legitimately reaches the user — but as a decision ("the <server> session expired; OK to re-authenticate?"), and the user completing an OAuth flow is supplying *information/credentials only they hold* (allowed by Autonomy rule 3), not performing an operation a sub-agent could do. For `chrome-devtools` stdio-drift, the recovery is a VS Code reload, which only the user can do — again a genuine information/environment action, not an offloaded operation.

---

## 7. Exact Skill Changes To Apply

Structural, one coherent model. Listed per file in implementation order. (Per `feedback_subagent_perms.md`, `.claude/commands/*` edits are applied at orchestrator level, not by a sub-agent — so these are written for the team-lead/orchestrator to apply.)

### 7.1 `dev.md` — Marker Convention block (`dev.md:59-204`, the catalogue table)

Add two rows to the marker catalogue table:

| Marker | Where emitted | What it captures |
|---|---|---|
| `[PROGRESS] {ts} step=<N> note=<...>` | At every step heading AND ≥ every 3 min during any long op | Liveness heartbeat (freshness) |
| `[PERM-RISK] {ts} action=<...> method=<...> gate-risk=<...>` | Before any gate-risky action (process-spawn, taskkill, mcp-auth) | Permission-risk pre-marker |

### 7.2 `dev.md` — new "Heartbeat & Permission-Risk Discipline" subsection (after "Read & Grep Discipline", `dev.md:235`)

~18 lines:

> **Heartbeat (MANDATORY).** Emit `[PROGRESS] {ts} step=<N> note=<short>` (a) at every step boundary alongside the `### Step N` heading, and (b) at least every **3 minutes** during any operation that runs longer than that — `--heavy` builds, full pytest, ESPRIT/modal derivations, `/test-ui`/`/diagnose` invocations, or any extended analysis stretch with no tool calls. Emit one `[PROGRESS]` *before* a long op starts and again whenever you regain control. The controller's fast freshness check (every 3 min) flags any active agent whose log has gained no new marker for > **8 minutes** as STALLED. A live agent's log is therefore never silent longer than ~3 min.
>
> **Permission-risk pre-marker (MANDATORY).** Before any action that may trip a CLI permission prompt (see CLAUDE.md "Known gaps in `bypassPermissions`") — process-spawn via `run_in_background`/`Start-Process`, `taskkill`/`Stop-Process` on a non-trivial PID, an MCP tool whose name matches `*auth*|*pair*|*init*`, or any TTY-opening Bash — emit `[PERM-RISK] {ts} action=<desc> method=<bash-bg|start-process|launcher-rest|taskkill|mcp-auth|...> gate-risk=<why>` **first**, then the `[BASH-CALL]`/`[MCP-CALL]`. If you then stall, this marker pinpoints the prompting action so the orchestrator can re-route you to a no-prompt method instead of relaying the invisible prompt to the user. Emit `[PERM-RISK] method=launcher-rest` even for the safe launcher-REST path, to record that the no-prompt method was chosen.

### 7.3 `dev.md` — Step 1b "Start Servers With Correct Venv" re-order (`dev.md:393-428`)

Promote the startup hierarchy (currently buried at `:436`) to be the **primary** instruction of this block; demote the bare `Bash run_in_background` example to explicit LAST RESORT. Add: "Emit `[PERM-RISK] method=<...>` before each start attempt (§Heartbeat & Permission-Risk Discipline). Launcher-REST is PREFERRED (no process-spawn, no gate); `Start-Process -WindowStyle Hidden` is FALLBACK; `Bash run_in_background: true` is LAST RESORT and only with a `[PERM-RISK] method=bash-bg` marker first." (~6 changed lines.)

### 7.4 `dev.md` — Step 0 note (`dev.md:119-124`, the `[STEP-0-COMPLETE]` block)

Add one line: "After `[STEP-0-COMPLETE]`, do NOT go idle — proceed directly to Step 1 (or Step 0b for a resume). An agent that emits `[STEP-0-COMPLETE]` then stops producing `[PROGRESS]` heartbeats is flagged as idle-after-step within 8 minutes and will be nudged or re-spawned." (Directly addresses incident b.)

### 7.5 `orchestrator.md` — Controller Agent section, cadence (`orchestrator.md:258-267`, the spawn-prompt invariants block)

Change the periodic-monitoring description from the single 30-min sweep to the tiered cadence:

> Stale-agent monitoring is **tiered**: a **fast freshness check every 3 minutes** per active agent (flags any agent whose log has no new marker — `[PROGRESS]` heartbeat or otherwise — for > 8 min as STALLED), plus the **deep sweep every 15 minutes** (full last-marker classification + cross-agent lock/dirty audit). The fast check is driven by an orchestrator `freshness-tick` poke (below) so it does not depend on a backgrounded self-timer. Classify stalls by last-marker type: unmatched `[PERM-RISK]`/`[BASH-CALL]`/`[MCP-CALL]` → permission stall (§Stalled Agent Recovery); clean last marker + stopped heartbeat → idle-or-dead, needs liveness probe.

### 7.6 `orchestrator.md` — new "freshness-tick poke" rule in Step 3 Spawning (`orchestrator.md:600-622` area, near the controller-notification rules)

Add rule: "**Freshness-tick poke.** Whenever ≥1 agent is active, send `SendMessage(to:'controller','freshness-tick')` on a ~3-min cadence. This drives the controller's fast freshness check from the orchestrator's live clock (the controller, backgrounded, cannot rely on its own wall-clock timer). If the controller does not acknowledge within one interval, treat the controller as failed → re-spawn it (Step 1.5 fallback) and run the minimal liveness floor yourself in the meantime."

### 7.7 `orchestrator.md` — "Stalled Agent Recovery" re-ordering (`orchestrator.md:1087-1091`, the "Recovery actions in order of preference")

Replace the current 3-step order (inline / **tell-user-to-check-CLI** / kill+respawn) with the §6.3 order: **(1) re-route to no-prompt method [default], (2) pre-grant the specific command, (3) escalate to user as a DECISION [last resort]**. Add the §5.3 liveness-probe branch for clean-last-marker stalls (idle-vs-dead disambiguation via team-lead inbox `idleReason`), with `dead → re-spawn fresh instance reusing the ID`, `idle → SendMessage nudge`. Explicitly delete the "Check the CLI window for a pending permission prompt" instruction from the default path. (~20 changed/added lines.)

### 7.8 `orchestrator.md` — Anti-Patterns table (`orchestrator.md:1035`)

Update the row "Declaring a dev agent stalled without checking the controller's stale-scan output": change "30-minute periodic stale-agent scan" → "tiered stall monitoring (3-min freshness check + 15-min deep sweep)". Add a new row: "**Relaying a CLI permission prompt to the user as the first response to a stall**" → "Re-route the agent to a no-prompt method or pre-grant the specific command FIRST; escalate to the user only as a last resort and only as a decision, never 'go click the prompt' (§Stalled Agent Recovery, Autonomy principle). SEVERE — this is the documented inversion."

### 7.9 `orchestrator.md` — Controller spawn prompt timers (`orchestrator.md:264`)

Update the "stale-agent scan timer" line in the spawn prompt to: "fast freshness check every 3 min (driven by orchestrator `freshness-tick` poke), deep sweep every 15 min." Add the heartbeat-freshness and liveness-probe logic to the referenced controller spec.

### 7.10 Controller spec (`docs/proposals/archive/controller-role.md` §8d, or its mirror)

The controller's normative spec lives in `controller-role.md` §8d (cadence + decision matrix) and §12 (catalogue). Update §8d: tiered cadence (3-min fast / 15-min deep), `STALL_THRESHOLD=8min` freshness rule, the extended classification matrix (§5.3 here) including the `[PERM-RISK]` row and the liveness-probe branch, and the orchestrator-poke dependency. §12 catalogue is unchanged (it is the method reference the `[PERM-RISK] method=` field and the recovery map both use). (~10 lines.) Note: `controller-role.md` is currently under `archive/`; if it is the live normative source it should move back to `docs/proposals/` — flag for the orchestrator.

### 7.11 `fn.md` and `multitask.md` — inherited

`fn.md` already inherits the Bash/MCP/Read/Grep discipline (`controller-role.md` §15 fn.md rows). Add one line to the same inheritance note: "fn agents also emit `[PROGRESS]` heartbeats and `[PERM-RISK]` pre-markers per the dev.md discipline — they are monitored by the same freshness check." `multitask.md` needs no change beyond the existing per-wave controller notification (it dispatches dev/fn agents that carry the markers themselves).

---

## 8. Why This Is One Coherent Model, Not a Pile of Rules

The three primitives and the cadence change are not independent patches — they compose into a single detection identity:

> **A live agent emits a heartbeat at least every 3 minutes. A stalled agent's heartbeat stops. The controller checks every 3 minutes whether each active agent's heartbeat is fresh (< 8 min). When it is not, the last marker says which kind of stall it is — `[PERM-RISK]`/dangling-`[BASH-CALL]` ⇒ permission stall (re-route, don't ask the user); clean marker ⇒ idle-or-dead (probe, then nudge or re-spawn). The orchestrator's poke keeps the controller's clock honest; the orchestrator's floor covers a dead controller.**

Every piece earns its place in that sentence:
- `[PROGRESS]` is the heartbeat (makes freshness a time-signal, covers idle-after-step and the gap between actions).
- `[PERM-RISK]` is the classifier that distinguishes the permission case and names its fix (so the response can avoid the user).
- The 3-min freshness check is the fast detector (beats the user's reaction time).
- The liveness probe is the idle-vs-dead disambiguator (covers `idleReason=failed`).
- The orchestrator-poke + floor close the "who monitors the monitor" hole.

It also stays inside every existing boundary: the controller remains a **read-only detector**, the orchestrator remains the sole **actor** (`controller-role.md` §10, §18 non-goals), no new tools, no auto-recovery by the controller, advisory-only alerts. The only behavioral change to the *orchestrator's* contract is the §6.3 re-ordering, which brings Stalled Agent Recovery back into line with the Autonomy principle it currently violates.

---

## 9. Open Questions

1. **Heartbeat interval (3 min default).** Tighter (2 min) catches stalls faster but adds log lines and risks false-positives on a step that legitimately runs 5–8 min without a natural heartbeat point. Looser (5 min) is quieter but slower. Proposal: 3 min, revisit if telemetry shows heavy builds can't emit a heartbeat mid-run (in which case the build wrapper itself emits periodic `[PROGRESS]` from a background `echo` loop).
2. **`STALL_THRESHOLD` (8 min default).** Must be ≥ 2× the heartbeat to tolerate one missed beat. 8 min = 2.7× a 3-min beat. If false-positives appear on long single ops, raise to 10 min before loosening the heartbeat.
3. **Orchestrator-poke vs. controller self-timer.** Proposal uses the poke as primary (live clock) with the self-timer as a backup the controller still runs. If pokes prove reliable, the self-timer can be dropped; if the orchestrator is too busy relaying to poke on time, the self-timer covers it. Keep both initially.
4. **Liveness probe mechanics.** §5.3 reads the team-lead inbox for `idleReason`. If the harness exposes a cleaner "is agent X alive" signal (team roster query), prefer it. Until then, inbox + roster-absence is the probe.
5. **Pre-emptive `[PERM-RISK]` flag aggressiveness.** Should the controller flag the *instant* a `[PERM-RISK] method=bash-bg` appears (before any stall), letting the orchestrator redirect pre-emptively? Proposal: yes for `method=bash-bg` (the known dominant tripper) as Tier-1 informational; no for `launcher-rest` (safe). Matches the existing pre-emptive check (`controller-role.md` §5e.2 row 37).
6. **Controller-role.md location.** It is the normative controller spec but lives under `docs/proposals/archive/`. If the controller is live (it is, per `orchestrator.md`), the spec should move to `docs/proposals/` (or `docs/development/`) so it is not mistaken for a parked draft. Flag for the orchestrator; out of scope for this read-only proposal to move it.

---

## 10. Non-Goals

- **Not** auto-recovery by the controller. The controller detects and classifies; the orchestrator acts. (Unchanged from `controller-role.md` §18.)
- **Not** a replacement for the existing markers, catalogue, or recovery protocol — this layers on top.
- **Not** a second monitor agent (§4).
- **Not** persisting stall history across sessions.
- **Not** changing the user-facing Telegram protocol except to *remove* the "go click the CLI prompt" relay from the default permission-stall path.
- **Not** a source-code or runtime change — skills and docs only.
