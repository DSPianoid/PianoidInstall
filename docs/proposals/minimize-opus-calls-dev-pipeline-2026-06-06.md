# Minimizing Opus API Calls Across the Dev Pipeline

**Date:** 2026-06-06
**Status:** PARTIALLY IMPLEMENTED (2026-06-07, on `feature/deepseek-codegen-mcp`, unmerged).
- **Phase 0** (context-hygiene rules in `/fn` + `/dev`) — SHIPPED `6ab40ba`.
- **Phase 2** (the `tools/dev-pipeline/` bookkeeping scripts: `dev_init` / `dev_wrap_phase2` /
  `env_sweep` / `verify_phase1` + `common.py`, 80/80 tests + real-git e2e) — SHIPPED `5be7efa`,
  wired into `dev.md` (Step 0, Step 10a Phase 2) + `orchestrator.md` (Full-Clearance, post-agent
  verification).
- **Phase 1** (the row-8 marker hook) — DEFERRED: not cleanly feasible (a `PostToolUse` hook's stdin
  carries the harness `agent_id`/`session_id`, not the `/dev` `dev-XXXX` log id, and no event binds
  them, so it can't target the per-agent log under concurrency). The session-keyed `marker_hook.py`
  variant is shipped UNWIRED as a documented option (`tools/dev-pipeline/README.md`).
- **Phase 3** (test/build wrappers) + **Phase 4** (cheap-model `/fn` lane, infra-gated) — PENDING.

Companion to and generalization of `deepseek-delegation-overhead-2026-06-06.md` (the DeepSeek-specific
cost model) and `deepseek-dev-pipeline-integration-2026-06-06.md`.
**Scope:** Two linked questions unified into one cost-minimization principle for `/fn`, `/dev`, and
`/orchestrator`:
1. (Q2) Apply the minimal-context principle to **all** `/fn` agents, Opus-based ones included — not just
   DeepSeek-delegating ones.
2. (Q3) Audit `/dev`, `/fn`, `/orchestrator` for **deterministic mechanical operations** currently done by
   Opus turns that could be pure (zero-LLM) scripts — each removed = one fewer Opus call.

**Bottom line up front.** Cost in this harness is `Σ over API calls (accumulated context × cache-read
price + output × output price + small write)`. Two independent levers fall out of that formula, one per
factor:
- **Fewer API calls** — every Opus round-trip you remove (mechanical op → script, or N-functions-in-one-agent
  consolidation that the test gate makes safe) removes a full cache-read of the agent's accumulated context.
- **Smaller per-call context** — running each codegen unit in a thin, minimal-context worker makes every
  round-trip re-read ~4k instead of ~50k (or ~480k in a deep `/dev`).
The DeepSeek delegate's own price is irrelevant (0.08% of its arm); the cost is **always** Claude
re-reading its own growing context. The same is true of every mechanical step a `/dev` agent performs.

---

## 0. The generalized cost principle

The companion DeepSeek analysis established that cost in this harness is, to first order:

```
  Cost  =  Σ over API calls [ accumulated_context × cache_read_price
                              + output_tokens     × output_price
                              + context_delta     × cache_write_price ]
```

with Opus 4.8 prices (USD/1M): output **25**, cache-read **0.50**, cache-write-5m **6.25**, input 5.
Measured: **cache-read + cache-write together are 64–72% of cost**; output is 25–31%; genuinely
uncached input is 3–5%. The DeepSeek call itself was **0.08%** of its arm — for cost purposes free.

That formula is **not specific to DeepSeek**. It governs every Opus turn the dev pipeline makes,
whether the turn writes code, runs a test, edits a registry file, or `git mv`s a log. Each turn
re-reads the agent's **entire accumulated context** as cache-read before it does anything. So the
formula exposes exactly **two** orthogonal levers, one per factor:

| Lever | What it attacks | Where it applies | This doc |
|---|---|---|---|
| **L-COUNT** — remove API calls | the `Σ` (number of terms) | every deterministic op an Opus turn performs that a script could do; consolidating N units that the test gate makes safe | Q3 (§2) |
| **L-CTX** — shrink per-call context | the `accumulated_context` factor inside each term | every codegen/edit turn whose working set is bloated with stale tool output and unrelated history | Q2 (§1) |

The single most important scalar is the **API-call count**, and the single most important per-call
quantity is the **accumulated context size**. Everything below is an application of these two levers.

**A crucial asymmetry the levers do NOT share** (this is the central honest finding of Q2): removing
a call (L-COUNT) is *always* a win — you pay strictly less. But shrinking context by **isolating work
into a fresh sub-agent (L-CTX via spawn) is NOT free** — a fresh Opus agent re-pays a fixed
**startup cache-write of the whole system+CLAUDE.md+tool-schema prefix (~$0.15)**. So L-CTX pays only
when (a) it does not multiply that startup tax (i.e. *prune within one agent* rather than *fan out into
many Opus agents*), or (b) the spawned worker runs on a **cheap model** so the re-paid startup is cheap
too. Conflating "small context" with "many isolated workers" is the trap.

---

## 1. Q2 — Minimal context for ALL /fn agents (Opus-based ones included)

### 1.1 Where the re-read context comes from (the self-accumulation clarification)

**A sub-agent does NOT inherit the parent's conversation.** Verified against the actual dispatch
mechanics:

- `/fn` and `/dev` sub-agents are spawned with the `Agent` tool (dev.md Step 4b "Spawning procedure"
  rule 3; fn.md "Example Usage → Spawned by /dev"). The spawn passes a **dispatch prompt** — a short
  brief: `target_file`, `function_spec`, `requirements`, `test_command`, `context_files`,
  `parent_agent`, `held_locks`. It does **not** pass the parent's transcript.
- The sub-agent then invokes `/fn` via the **`Skill` tool inside its own context** (dev.md Step 4b
  rule 3: *"The sub-agent invokes `/fn` via the `Skill` tool inside its own context. Do NOT use
  `Skill("fn")` from the parent."*). So the sub-agent's call-0 prefix is: **harness system prompt +
  tool schemas + global & project `CLAUDE.md` + the deferred-tool list + the `/fn` skill body + the
  dispatch prompt** — a *fresh* prefix, independent of the parent.

Therefore the ~50k context that gets re-read on every Opus turn in the benchmark is **self-accumulated
by the agent as it works**: it reads `SUITE.md`, copies 3 public tests, writes 3 bodies, runs pytest
(sometimes 4× incrementally), and each of those tool results is appended to the agent's own context and
re-read by every *subsequent* turn. The benchmark agent grew **10k → 50k over 7 calls (~3.6k/call)**
doing 3 functions. **Nothing about that growth comes from the parent — it is the agent piling its own
work into one long conversation.**

Two consequences fix the framing for Q2:

1. **The startup prefix is fixed by the harness + `CLAUDE.md`, not by `/fn`.** Measured byte sizes:
   the `/fn` skill body is only **~3.3k tokens** (13.1 KB); project `CLAUDE.md` is **~7k** (28 KB);
   `dev.md` (which a `/dev` parent expands) is **~20k** (81 KB). The benchmark's call-0 cache-write was
   **~23.7k tokens ($0.148)** — dominated by the harness system prompt + tool schemas + `CLAUDE.md`,
   with `/fn` a minor part. **You cannot make a fresh Opus worker's startup cheap by trimming the skill
   — the floor is the harness+`CLAUDE.md`.** This is decisive for the "N workers" option below.
2. **The lever for an Opus `/fn` is therefore the *growth*, not the *spawn*.** Keep each turn's
   re-read small by keeping the **working set** small — not by manufacturing fresh agents (each of
   which re-pays the ~$0.15 startup floor).

### 1.2 One accumulating agent vs N minimal workers vs one *hygienic* agent (quantified)

Three strategies for implementing **N functions**, all on Opus (model `model2.py`, anchored to the
measured benchmark):

- **A — one accumulating agent** (status quo): pays startup once, but context grows across all N
  functions; later functions' write+test turns re-read everything before them.
- **B — N independent minimal-context workers**: each worker re-pays the startup floor, but its
  context stays tiny (~6k) and flat.
- **C — one *hygienic* agent**: pays startup once like A, but **prunes its working set** (drops stale
  tool output and earlier functions' full source from the resident context; keeps only spec + adjacent
  pattern + current test), so per-function growth is ~2k instead of ~12k.

| N | A — one accumulating | B — N workers | C — one hygienic | Best |
|---:|---:|---:|---:|:--|
| 1 | $0.355 | **$0.242** | $0.350 | B |
| 2 | $0.435 | $0.483 | **$0.418** | C |
| 3 | $0.527 | $0.725 | **$0.490** | C |
| 5 | $0.748 | $1.208 | **$0.649** | C |
| 8 | $1.168 | $1.932 | **$0.920** | C |
| 10 | $1.509 | $2.415 | **$1.124** | C |

**The naive "isolate into N minimal workers" idea LOSES for Opus at every N ≥ 2** — and the loss
widens with N (B is **+38%** vs A at N=3, **+60%** at N=10). Cause: B re-pays the **$0.148 startup
cache-write per worker**, and that fixed tax (N × $0.148) swamps the small per-call re-read it saves.
Sensitivity sweep — *how small must the per-worker startup prefix be before B beats A at N=3?*

| per-worker startup prefix | startup-write $ | A (N=3) | B (N=3) | winner |
|---:|---:|---:|---:|:--|
| 4,000 tok | $0.025 | $0.404 | $0.355 | **B** |
| 6,000 tok | ~$0.038 | ~$0.42 | ~$0.42 | break-even |
| 8,000 tok | $0.050 | $0.429 | $0.430 | A |
| 23,700 tok (measured) | $0.148 | $0.527 | $0.725 | **A** |

B only wins below **~6k tokens of startup prefix** — but §1.1 established the Opus startup floor is
**~20–24k** (harness + `CLAUDE.md`), four times too high. **So for plain-Opus `/fn`, fanning out into
isolated workers is structurally a loss.** The winning move is **C: stay in one agent, prune the
context.** C beats A by **7% (N=3) → 26% (N=10)** purely by holding per-function growth down.

**The one regime where isolation (B) wins is when the worker is on a cheap model:**

| Driver for the N workers | N=3 vs Opus-A | N=5 | N=10 |
|---|---:|---:|---:|
| Sonnet (0.6×) workers | save 18% | save 3% | save 4% |
| **Haiku (0.2×) workers** | **save 73%** | **save 68%** | **save 68%** |

A Haiku worker re-pays only **$0.030** of startup, not $0.148, so the isolation tax shrinks 5× and the
flat tiny context dominates. **Isolation and cheap-model are coupled levers** — isolation is worth its
startup tax *only* when the re-paid startup is cheap. (This matches the companion doc's L3+L6 stack,
but the present analysis makes explicit that for a **same-model (Opus) `/fn`, isolation alone is
negative** — a correction to any reading of "thin workers are always cheaper.")

### 1.3 What context a /fn agent GENUINELY needs vs bloat

The `/fn` Input Contract (fn.md) already names the genuine needs; the bloat is what the agent *adds*
during execution and never prunes. Concretely:

| GENUINELY needed (keep resident) | BLOAT (prune / never load) |
|---|---|
| The **target function's** current source (the span being edited) | The **whole** target file when only one function is touched (Read with `offset`/`limit`) |
| The **spec + requirements** (from the dispatch prompt) | Earlier functions' **full bodies** once they're written + green (keep only their signatures if cross-referenced) |
| The **one test** that gates this function (its source) | The **entire** test suite / `SUITE.md` when one test gates one function |
| **Adjacent patterns** named in Step 1 — the 1–3 functions whose style/error-handling to match | Unrelated module docs read "for context" that the function does not touch |
| The **last** test run's pass/fail tail | **Every** prior pytest run's full stdout (the 4×-incremental-test anti-pattern: $0.241 vs $0.108 measured) |
| Doc facts the Data Model Card actually cites | Docs skimmed and not cited (the DMC is the filter — if a fact isn't on the card, its doc text needn't stay resident) |

The measured 4×-incremental-pytest waste (companion doc §2) is the canonical bloat example: each extra
full-context pytest turn re-read ~50–58k and added ~$0.05; running the test **once at the end** removes
three of them.

### 1.4 Proposed dispatch changes + honest tradeoffs

**Prompt-hygiene rules for `/fn` (and for any `/dev` agent editing inline):**

1. **Read narrowly.** Read the target function span with `offset`/`limit`, not the whole file, when the
   file is large and only one function is in scope. Read the one gating test, not the suite.
2. **Don't pile unrelated functions into one long `/fn` session.** `/fn` is *single-function* by
   charter (fn.md). If a `/dev` parent has 5 unrelated functions, that is **not** a reason to spawn 5
   Opus `/fn` workers (B loses) **nor** to cram all 5 into one mega-agent that re-reads all 5 every
   turn. The right shape is **C**: a small number of agents each doing a *cohesive* cluster, pruning
   between functions. Group by shared context (functions that read the same 2 files), not arbitrarily.
3. **Test once at the end of the function**, not after each speculative edit (review-on-red only, per
   companion doc L4). Three saved pytest turns ≈ $0.13 on a 3-function run.
4. **Prune tool output.** After a function is green, the agent should not keep that function's full
   diff + every intermediate pytest dump resident — summarize to one line in the session log and move
   on. (The session log, not the live context, is the durable record.)
5. **Cheap-model `/fn` for routine bodies.** When function bodies are routine and a hard test gate
   exists, dispatch the `/fn` worker on **Haiku/Sonnet**, not Opus — this is the only configuration
   where *isolation* (B) is a net win (68–73% on Haiku). Reserve Opus `/fn` for functions needing
   genuine design judgment. (Requires the harness to support per-Agent model selection; if it does
   not, this lever is blocked — flag as an infra dependency.)

**Honest tradeoffs:**

- **Isolation loses cross-function consistency.** N separate workers can't see each other's choices
  (naming, helper extraction, error-handling) → drift the parent must reconcile. C (one agent, pruned)
  keeps consistency *and* wins on cost; this is a second reason C beats B.
- **Pruning has a floor and a risk.** You can't prune below the spec + current test + adjacent pattern,
  and over-aggressive pruning (dropping a doc fact the next function needed) forces a **re-read** — a
  new high-context turn that costs *more* than keeping it. Prune *stale* output, not *load-bearing*
  context. The Data Model Card is the safe keep-list.
- **Spawn overhead is real and per-agent.** Every `Agent` spawn re-pays ~$0.15 startup on Opus. Never
  spawn an Opus sub-agent for a *sub-$0.15* unit of work — the spawn costs more than doing it inline.
  (This is why B is negative for small functions and why Q3's "script it" beats "spawn a worker to do
  it.")
- **Cheap-model bodies lean entirely on the test gate.** Non-thinking models cut edge-case corners
  (DeepSeek scored 155/160). If the test is thin, a Haiku/DeepSeek `/fn` ships subtly-wrong code an
  Opus `/fn` would have gotten right. The test-first rule (dev.md Step 4b "Prepare tests FIRST") is the
  non-negotiable precondition for any cheap-model or delegated codegen.

**Net Q2 recommendation:** the lever for **all** `/fn` agents (Opus included) is **context hygiene
within one agent (strategy C)**, not fan-out into isolated Opus workers (strategy B, which is
negative). Fan-out earns its startup tax **only** paired with a cheap model. Update fn.md / dev.md
Step 4b with the hygiene rules above; treat "spawn an Opus worker" as justified only when the unit is
large enough to clear the ~$0.15 spawn floor *and* needs Opus judgment.

---

## 2. Q3 — Script-replaceable mechanical ops (save Opus calls)

### 2.1 Method: what makes an op safely scriptable

Each removed Opus turn removes one full cache-read of the agent's accumulated context — worth
**$0.031 at /fn ~50k, $0.066 at /dev mid ~120k, $0.246 at /dev very-deep ~480k** (model `model2.py`).
The deep-`/dev` figure is the important one: bookkeeping turns happen late in a session, when context
is largest, so each one costs the most.

An op is **safely scriptable** iff it satisfies all three:

1. **Deterministic output** — same inputs → same result, no interpretation. (Emitting a timestamped
   log header. Removing a table row by agent ID. `git checkout -b`.)
2. **No branch-on-meaning** — the op does not *decide* anything that changes the workflow. Running
   pytest and **capturing** the result is mechanical; **deciding whether a failure is a real bug or a
   flaky/expected failure** is judgment.
3. **Failure is loud and local** — if the script errors, it errors visibly (non-zero exit, stderr) and
   the agent notices on the next turn; it does not silently corrupt state. (A registry-edit script that
   can't find the row should *fail*, not guess.)

**Two delivery mechanisms** (the repo already uses the first for Telegram patches — `tools/*.py`):

- **(H) Agent-invoked helper script** — a `tools/dev_pipeline/*.py` (or `.ps1`) the agent calls in
  *one* Bash/PowerShell turn instead of *several* reasoning turns. This still costs **one** turn (the
  agent must invoke it and read its result), so it pays when it **collapses ≥2 Opus turns into 1**, or
  removes a high-output turn (e.g. hand-building a comparison table). It does **not** remove the turn
  entirely.
- **(K) Harness hook** — a `PostToolUse` / `Stop` hook in `settings.json` (managed via the
  `update-config` skill) that fires **deterministically with zero Opus turns**. This is strictly
  better than (H) when the trigger is mechanical (e.g. "after the test command runs, parse the junit
  XML and append the metrics table to the log" as a PostToolUse hook on the pytest Bash call). The repo
  currently has **no hooks** (`settings.json` has only permissions) — greenfield, but the highest-
  leverage option because a hook removes the turn rather than cheapening it.

> **Why count, not dollars-per-op, is the headline.** A helper that turns 3 turns into 1 saves 2 turns
> ≈ $0.13–0.49 depending on depth. A hook that removes a turn saves the whole turn. Both attack the
> `Σ`. The ranking below weights **(turns removed) × (safety)**, and notes H-vs-K per row.

### 2.2 Ranked table (saving × safety)

Ranked by **(Opus turns removed per session) × (safety)**. "Turns removed" assumes the op currently
costs the listed turns; "$ @120k / @480k" prices the removed turns at mid- and deep-`/dev` context.

| # | Op (current Opus cost) | Deterministic? | Mechanism | Turns removed | $ saved @120k / @480k | Notes |
|---|---|---|---|---:|---:|---|
| **1** | **Step-0 scaffold** — generate agent ID, write log header, add WIP row, emit `[STEP-0-COMPLETE]` (≈2 turns of templated edits) | **Fully** — pure templating | **K** (a `SessionStart`/pre-dispatch hook) or **H** (`dev_init.py <task>`) | ~2 | $0.13 / $0.49 | Highest safety: zero judgment. A hook can scaffold log+WIP atomically before the agent's first turn. |
| **2** | **Phase-2 bookkeeping** — `git mv` log→archive, remove WIP row, `git mv` shipped proposal→archive + status line (≈2 turns) | **Fully** — given agent ID + approval flag | **H** (`dev_wrap_phase2.py <agent-id>`) | ~2 | $0.13 / $0.49 | Late-session (max context) → top $/turn. Proposal *selection* (which proposal shipped) is judgment, but the agent already knows it — the *moves* are mechanical. |
| **3** | **Step-1b env control** — port-scoped kill sweep on 3000/3001/5000/5001 + verify-free + emit `[STEP-1B-KILL]` (≈2 turns: sweep, then verify) | **Fully** — fixed ports, PID-targeted | **H** (`env_sweep.py` — already half-exists as the inline Bash loop) | ~1–2 | $0.07–0.13 / $0.25–0.49 | Safety guard: script MUST be port-scoped (never `//IM python.exe`) — encode the safe form once, kill the whole class of blanket-kill incidents. |
| **4** | **Test run + PARSE** — run pytest, extract gpu_mean/p99/underrun/sound_corr, emit `[BASELINE-TEST]` / build the baseline-vs-after **delta table** (the *parse + table*, not the verdict) | **Parse: yes. Verdict: NO** | **H** (`run_perf.py --baseline` / `--compare baseline.json` → prints the markdown table + a machine `verdict_hint`) | ~1 (the table-building output turn) | $0.07 / $0.25 | **Split the op**: script parses + formats + emits the marker fields; the **regression verdict** (is a 12% GPU bump acceptable for this change?) STAYS Opus. Script emits `verdict_hint`, Opus confirms. |
| **5** | **Commit mechanics** — `git add <files>` + `git commit -m "[agent-id] <type>: <msg>"` (≈2 turns across intermediate+final) | **Mostly** — message text is light judgment | **H** (`dev_commit.py <agent-id> <type> "<msg>" <files...>` — enforces the `[agent-id]` prefix) | ~1 | $0.07 / $0.25 | Removes the prefix-format violations the controller currently catches (Tier-1). The **message wording** is the agent's; the plumbing + prefix is the script's. Don't auto-generate the message. |
| **6** | **Build invoke + log-tail + verify-marker** — launch detached `Start-Process` build, poll `build.log` for `[SUCCESS]`, grep the `.pyd` for the marker, emit `[BUILD STARTED]`/`[BUILD OK]` (≈2 turns: launch, then poll/verify) | **Invoke + poll + grep-verify: yes. Failure triage: NO** | **H** (`build_pianoid.py --heavy --both` wrapper that does precheck→stop-holder→launch→poll→verify→emit markers, returns ok/fail) | ~1 | $0.07 / $0.25 | Huge *correctness* win too — encodes the detached-Start-Process + stop-holder-first + absolute-bat-path discipline that burns sessions when hand-typed. **Build-failure diagnosis STAYS Opus** (0xC0000142, linker errors → judgment). |
| **7** | **Step-3 branch** — `git checkout dev && git pull && git checkout -b feature/<x>` (≈1 turn) | **Fully** (branch *name* is trivial judgment, usually derivable from task) | **H** (`dev_branch.py feature/<x>`) | ~1 | $0.07 / $0.25 | Low individual value but bundle into `dev_init.py`. The *decision* to branch vs work-on-dev is judgment (small fix vs feature) — keep that with Opus; script only the git plumbing once decided. |
| **8** | **Marker emission discipline** — the dozens of `[BASH-CALL]`/`[BASH-RETURN]`/`[READ]`/`[PROGRESS]` markers the agent hand-writes to its log | **Fully** — they are mechanical echoes of tool calls | **K** (PostToolUse hook that appends the marker for every Bash/Read/MCP call automatically) | fractional per call, but **pervasive** | hard to price; large in aggregate | Today the agent spends output tokens + attention emitting these every turn. A hook that auto-appends them removes a *recurring per-turn output burden* across the whole session — arguably the single biggest aggregate output-token saver, and it makes the controller's signal *more* reliable (no missed markers). |
| **9** | **Orchestrator post-agent verification** — after a dev agent's Phase-1 report, verify commit landed (prefix present), locks released, log not yet archived, WIP row present (≈1 orchestrator turn of git/grep) | **Fully** — 4 boolean checks | **H** (`verify_phase1.py <agent-id>` → prints a 4-line PASS/FAIL the orchestrator relays) | ~1 (orchestrator-side) | $0.07 / $0.25 | Runs in the **orchestrator** context (long-lived, large) so each saved turn is expensive there too. Pure assertions, ideal script. |
| **10** | **Orchestrator full-clearance sweep** — the 4-port `Get-NetTCPConnection`/`Stop-Process` sweep + `git status --short` across 4 repos at handoff (≈1–2 turns) | **Fully** | **H** (`clearance.py` → sweeps ports + reports per-repo dirty state) | ~1 | $0.07 / $0.25 | Already exists as inline PowerShell — promote to a named script the orchestrator calls in one turn instead of pasting the loop + reading 4 `git status` outputs. |

**Aggregate (model `model2.py`):** the plausibly-mechanical budget in one `/dev` session is **~15
Opus turns**; the **safely-scriptable subset is ~13.8 turns** (the rest is the judgment slivers in
rows 4–7). Pricing the scriptable subset:

- **~$0.91 / session @ 120k context**, **~$3.39 / session @ 480k deep context**.
- Across volume: **20 `/dev` sessions ≈ $18 (@120k) … $68 (@480k)** saved; **50 sessions ≈ $45 …
  $169**. (Illustrative — real sessions vary in depth; the deep-context figure applies to long
  multi-phase `/dev` runs where bookkeeping happens at maximum context.)

The aggregate is **dominated by the late-session, high-context bookkeeping** (rows 1, 2, 8) — they are
both the safest (zero judgment) and the most expensive per turn (they fire when context is largest).
That is the quick-win cluster.

### 2.3 What must STAY Opus (mechanical-looking but judgment-bearing)

These look scriptable but hide a decision that changes the workflow. **Do not script the decision** —
at most, a script may *gather evidence* and hand it to Opus.

| Op | Why it needs Opus (the hidden judgment) | Safe partial-script |
|---|---|---|
| **Decide if a test failure is a real bug** vs flaky/expected/environmental | Classifying a failure drives the entire debug-vs-proceed branch (dev.md Step 5→6). A red test can mean "the fix is wrong", "the test is stale", "the GPU was busy". | Script *runs* the test and *captures* output; Opus *classifies*. |
| **Regression verdict** (is GPU mean +12% / sound_corr 0.94 acceptable *for this change*?) | The thresholds in dev.md Step 5 are defaults; whether a breach is acceptable depends on what the change was *for* (a perf-tradeoff feature may legitimately regress p99). | Script computes deltas + a `verdict_hint` from the static thresholds; Opus makes the call. |
| **Resolve a merge / reconcile conflict** | Code-conflict resolution is the canonical judgment call (orchestrator.md Phase-2 step 3: *"code conflicts STOP for user judgement"*; doc conflicts in WIP/LOCKS may be union-merged by script, code conflicts may not). | Script union-merges *registry* conflicts (WIP/MODULE_LOCKS rows); code conflicts go to Opus/user. |
| **Build-failure diagnosis** (0xC0000142, SDL3.lib missing, stale-`.pyd` masquerade) | Each failure class has a different documented recovery; picking the right one is reading-comprehension over BUILD_SYSTEM.md, not a lookup. | Script *detects* the exit code + tails the log; Opus *diagnoses* using the doc. |
| **Data Model Card authorship** (dev.md Step 4) | The whole point of the DMC is that data-model facts must be *judged* against docs (axis semantics, unit ranges) — the "high-stakes inference" categories in `CLAUDE.md`. A script cannot certify a fact. | None — fully Opus. A script could *check* that the marker exists, not that the card is correct. |
| **Lock-conflict / scope decisions** (should scope expand to this file? pause vs push through?) | Acquiring a lock is mechanical; *deciding whether the change should touch that file at all* (P1/P2 authority/concern) is design judgment. | Script edits MODULE_LOCKS rows once the agent decides; the decision stays Opus. |
| **Commit message wording**, **doc prose**, **proposal selection** | Natural-language synthesis. | Script enforces the `[agent-id]` prefix + does the `git`; Opus writes the words. |
| **Classify a diagnosis** / decide a hypothesis is confirmed | Per `CLAUDE.md`: a hypothesis may drive *measurement*, never a *code edit*, until confirmed. That gate is judgment by definition. | None — fully Opus. |

The dividing line is crisp: **scripts may do plumbing and gather evidence; Opus owns every branch-on-
meaning.** Rows in §2.2 that straddle the line (4, 5, 6, 7) are deliberately *split* — the script takes
the deterministic half, Opus keeps the decision.

---

## 3. Recommended phased rollout (quick wins first)

Ordered by **(impact × safety) ÷ effort**. Each phase is independently shippable; nothing here touches
synthesis source (all of it is pipeline tooling + skill-doc edits + harness config).

### Phase 0 — Zero-risk hygiene rules (docs only, ship today)

- Add the **§1.4 prompt-hygiene rules** to `fn.md` and `dev.md` Step 4b: read narrowly
  (`offset`/`limit`), test-once-at-end / review-on-red, don't fan out Opus `/fn` workers for small
  units, prune stale tool output between functions.
- Add a one-line rule: **"Never spawn an Opus sub-agent for a unit of work smaller than ~$0.15 (the
  spawn startup tax) — do it inline or script it."**
- Effort: a few doc edits. Impact: strategy-C savings (**7–26%** per multi-function run) with zero new
  code and zero risk. **This is the single highest ROI item** — it costs nothing to ship.

### Phase 1 — Harness marker hook (highest aggregate output saving)

- Add a **PostToolUse hook** (`settings.json`, via `update-config`) that auto-appends
  `[BASH-CALL]`/`[BASH-RETURN]`/`[READ]`/`[GREP]`/`[MCP-CALL]`/`[MCP-RETURN]` markers for every matching
  tool call (Q3 row 8). This removes a **pervasive per-turn output burden** across every dev/fn session
  *and* makes the controller's stall-detection signal perfectly reliable (no missed/forgotten markers).
- Effort: medium (one hook script + config). Impact: large in aggregate (every turn of every session),
  and it *improves* compliance monitoring rather than weakening it.
- Risk: low — additive; if the hook fails, the agent can still hand-emit (current behavior).

### Phase 2 — Bookkeeping helper scripts (highest per-turn $, top safety)

Build `tools/dev_pipeline/` helpers for the **zero-judgment, late-session** ops (Q3 rows 1, 2, 3, 9,
10) — these fire at maximum context so each saved turn is worth the most:

- `dev_init.py <task> [--branch feature/<x>]` — agent ID, log header, WIP row, optional branch, emit
  `[STEP-0-COMPLETE]` (rows 1, 7).
- `dev_wrap_phase2.py <agent-id>` — archive log, remove WIP row, archive shipped proposal + status line
  (row 2).
- `env_sweep.py` / `clearance.py` — port-scoped kill + verify + per-repo `git status` (rows 3, 10),
  encoding the **port-scoped-only** safety invariant once.
- `verify_phase1.py <agent-id>` — the orchestrator's 4-check Phase-1 verification (row 9).
- Effort: small-medium (mostly wrapping existing inline Bash). Impact: **~$0.5–1.5/session** at deep
  context, all from the safest rows. Risk: low (deterministic, loud-fail) — but each script MUST encode
  the port-scoped-kill and `[agent-id]`-prefix guards so it can't regress into a blanket-kill or an
  unprefixed commit.

### Phase 3 — Test/build wrappers with split verdict (correctness + cost)

- `run_perf.py --baseline | --compare <baseline.json>` — runs pytest, parses metrics, prints the
  markdown delta table, emits the `[BASELINE-TEST]`/`[REGRESSION-CHECK]` marker fields, and prints a
  `verdict_hint` from the static thresholds. **Opus still makes the regression call** (row 4).
- `build_pianoid.py --heavy --both` — precheck holders → stop-holder (launcher REST first) → detached
  `Start-Process` with absolute bat path → poll log → grep-verify the `.pyd` marker → emit build
  markers; returns ok/fail. **Opus still diagnoses failures** (row 6).
- `dev_commit.py <agent-id> <type> "<msg>" <files...>` — enforces prefix + does the git (row 5).
- Effort: medium (these wrap genuinely fiddly procedures). Impact: ~$0.25/turn at deep context **plus**
  a large *reliability* win — these encode the exact build/test discipline whose hand-typed violations
  have burned multiple sessions (stale-`.pyd`, blanket-kill, `--release`-not-`--both`). Risk: medium —
  must be validated against BUILD_SYSTEM.md so the wrapper can't silently reinstall a stale `.pyd`;
  keep the human/Opus diagnosis gate on failure.

### Phase 4 — Cheap-model `/fn` lane (infra-gated)

- If/when the harness supports per-`Agent` model selection, add a `--model haiku|sonnet` lane to `/fn`
  for routine, hard-test-gated bodies (the only configuration where *isolation* is a net win: **68–73%**
  on Haiku). Reserve Opus `/fn` for design-judgment functions.
- Effort: depends on harness support (may be blocked). Impact: large on routine-body-heavy work. Risk:
  the cheap model leans entirely on the test gate — gate quality becomes load-bearing; do not enable
  for thinly-tested functions.

**Sequencing rationale:** Phase 0 is free and immediate; Phase 1 helps *every* session and improves
monitoring; Phase 2 captures the safest, most-expensive turns; Phase 3 adds the higher-effort wrappers
that also fix recurring correctness bugs; Phase 4 waits on an infra capability. Phases 0–2 are the
"quick wins" and capture the large majority of the safe savings.

---

## Appendix — model & method

- **Cost model scripts (scratch, not in repo):** `D:\tmp\ab-arch\model.py` (the prior agent's
  partial — kept) and `D:\tmp\ab-arch\model2.py` (this analysis: the three-strategy Q2 comparison, the
  startup-prefix sensitivity sweep, and the per-step Q3 budget). Both run under
  `PianoidCore/.venv/Scripts/python`.
- **Pricing (Opus 4.8, USD/1M):** output 25, cache-read 0.50, cache-write-5m 6.25, input 5 — identical
  to the companion `deepseek-delegation-overhead-2026-06-06.md` (verified there against the `claude-api`
  skill catalog).
- **Anchors (all from the companion doc's measured A/B benchmark):** pure-Claude `/fn` arm = 3
  functions, **7 API calls**, context **10k → 50k (~3.6k/call growth)**, **$0.608**; call-0 startup
  cache-write **~23.7k tokens = $0.148** (one-time per agent). Skill/doc byte sizes measured directly:
  `fn.md` 13.1 KB (~3.3k tok), `CLAUDE.md` 28 KB (~7k tok), `dev.md` 81 KB (~20k tok) — establishing
  that the Opus startup floor (~20–24k) is fixed by harness+`CLAUDE.md`, **not** by the `/fn` skill,
  which is why fresh-Opus-worker isolation (strategy B) cannot beat in-agent pruning (strategy C).
- **Dispatch facts verified against source:** `/fn` and `/dev` sub-agents are spawned via the `Agent`
  tool with a short dispatch prompt and invoke their skill via `Skill` *inside their own context*
  (`dev.md` Step 4b; `fn.md` Example Usage) → the re-read context is **self-accumulated**, not
  inherited. Mechanical-step inventory drawn from `dev.md` Steps 0/1b/2/3/4/5/8/10 and `orchestrator.md`
  Step 1.5 / Full-Clearance / post-agent verification.
- **Estimates are first-order** (a high-context turn ≈ ctx × $0.50/1M + output × $25/1M + delta ×
  $6.25/1M); the per-step `scriptable_fraction` values in `model2.py` are judgment-weighted (rows that
  straddle the deterministic/judgment line are discounted, e.g. test-run = 0.7 because the verdict
  stays Opus). They are bounds for ranking, not penny-exact forecasts.

