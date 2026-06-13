# Generic Agentic-Development Skillset — Open-Source Design Proposal

**Status:** PROPOSAL for sign-off. A governed, traceable design spec — read top to bottom.
**Goal:** extract the reusable agentic-development methodology into a robust, consistent, intuitive
open-source dev-kit.

**How to read.** Upstream governs downstream: Purpose → Core Principles (`CP1`–`CP7`) → Architectural
Principles (`AP1`–`AP8`) → Architecture + Flows (`FD`–`FK`) → Work taxonomy → Modules → Cross-cutting
processes. Traceability (which principle each element serves) is carried compactly in the **matrix
appendix**, not inline. Trade-offs are resolved by the **Decision Hierarchy (§0.3)**. The compositional
history and the per-step design notes live in `docs/proposals/.process/proposal-composition-notes-2026-06-13.md`.

---

# PART 0 — THE DESIGN

## 0.1 Purpose

**A toolkit that lets a developer run software development on their projects autonomously and remotely.**
Agents *execute* the work — set up the environment, reproduce, implement, **self-verify with measured
evidence**, report. The **user supplies decisions, approvals, and direction only — from anywhere.**

## 0.2 Core principles (CP)

| ID | Principle | Meaning |
|---|---|---|
| **CP1** | **Maximum autonomy** | Agents own the complete task loop unattended — self-manage the environment, reproduce, diagnose by measurement, implement, and **test-yourself** (self-verify with measured before/after evidence). Operational blockers are solved by the agent, never bounced to the user. |
| **CP2** | **Comprehensive documentation** | Docs-first navigation (the doc hierarchy is the context), a single source of truth for project facts, and working-documentation that records every action so state is legible and recoverable. |
| **CP3** | **Stable & recoverable remote connection** | The user drives from anywhere over a channel that survives interruption — reconnect, resume, recover after editor reloads / stdio drift / stalls without losing work. |
| **CP4** | **Version control + full traceability** | Every change is attributable and followable end-to-end: branches, commit attribution, session logs, and a traceable design hierarchy where upstream governs downstream. |
| **CP5** | **Code quality control** | Quality is gated, not hoped for: review against explicit principles, regression gates, file-size/complexity limits, the verification gate — applied to **all** work regardless of which model produced it. |
| **CP6** | **Cost control** | Spend the minimum that preserves quality: tier work to the cheapest correct executor (script → cheap-model → frontier), prune context — **optimized within quality, never by skipping gates**. |
| **CP7** | **Safety & guardrails** | Bounded autonomy: scoped operations (no blanket kills), fail-fast (no silent workarounds), confirm-before-destructive/outward-facing, full clearance between tasks, a read-only compliance monitor. |

CP1–CP7 are the **generic** principles. A project may carry its own principles/methodologies/preferences in
its project rules file; those **extend or override** the generic principles for that project (§0.3, §0.5 AP3).

## 0.3 Decision hierarchy

When principles conflict, resolve in this order:

1. **QUALITY > COST.** Quality (CP5) outranks cost (CP6). Cost is reduced by *routing* work to the cheapest
   *correct* tier (AP4), never by relaxing a gate. **Cheap-model work goes through the same tests, review,
   and verification as frontier work.**
2. **AUTONOMY ↔ SAFETY = balanced**, by scope of action: **fully autonomous on operations** (environment,
   reproduce, build, test, recover — the user never operates the machine), **human approval on consequential
   or outward-facing actions** (merges to integration branches, pushes, sends, deletions, anything hard to
   reverse). Autonomy is the default; safety draws the line at irreversibility and outward effect.

Unresolved conflicts escalate to the user. **Layer precedence:** project rules extend, and on direct
conflict override, the generic principles for that project (validated against the harness's
personal-over-project memory model). A project rule may refine any CP.

## 0.5 Architectural principles (AP)

| ID | Principle | One line |
|---|---|---|
| **AP1** | **Orchestrator coordinates, sub-agents own** | A thin coordinator classifies + dispatches + relays; sub-agents own the complete task loop in isolated context and report. |
| **AP2** | **Single source of truth (+ drift-lint)** | Project facts live once (`PROJECT_CONFIG.md`); cross-cutting discipline lives once; a forbidden-form/duplication lint makes drift unable to recur. |
| **AP3** | **Generic/project separation** | Generic **methodology** vs project **(facts + project-specific normative rules)**. The core *resolves* the facts config and *observes* the project rules at runtime via the `PROJECT_ROOT` binding. The split is **not** data-vs-code. |
| **AP4** | **Model tiering, gates on every tier** | Route each unit to the cheapest *correct* executor (script → cheap-model → frontier); the same test/review/verification gates apply regardless of tier. |
| **AP5** | **Read-only compliance monitoring** | A permanent Controller watches state + markers and reports graduated alerts (warn → escalate → halt); it never edits, spawns, kills, or blocks. |
| **AP6** | **Explicit state, isolation & recoverability** | Branches, **deterministic partition + worktree isolation** (the §0.10e parallel-dev model — replaces advisory per-file locks), WIP roster, append-only session logs + markers, pause/resume/recover exit procedures. |
| **AP7** | **Explicit multi-project binding** | The orchestrator passes an explicit `PROJECT_ROOT` per dispatch (per-subagent cwd is unshipped in the harness); per-project state/config resolve from it — so one system can run several projects, even two at once. |
| **AP8** | **Pluggability** | Channels, model tiers, and MCP integrations are swappable interfaces, not hardwired. |

**Cross-cutting operating rules** (always on): docs-first navigation; fail-fast / no workarounds;
confirm-before-destructive/outward-facing; full clearance between tasks; commit attribution; scoped
(port/PID-only) process kills; and **multi-issue → consecutive resolution** (present and resolve issues with
the user one at a time, not batched).

**The generic/project boundary (AP3):**
- **GENERIC (shared, one copy):** the methodology — skills/workflows, the principles, the flows, the
  controller, the tooling. Project-agnostic (grep-gated: zero project tokens).
- **PROJECT — facts (`PROJECT_CONFIG.md`):** the operational SSOT the skills *resolve* — stack,
  build/test/run, repo layout, ports, paths, endpoints, verification surfaces.
- **PROJECT — normative rules (project `CLAUDE.md`):** the project's principles / conventions / testing
  methodology / domain cautions / workflow preferences the skills *observe* (extend/override per §0.3).

## 0.6 Architecture

**Three structural layers** — USER (the shared project-agnostic core) · PROJECT (per project: its facts
config + rules file + project-specific skills + state; a *structure*, generated by the Init tool, §0.8 M11)
· DISPATCH (every sub-agent dispatch carries the active `PROJECT_ROOT`).

**Four runtime actors** — Orchestrator (thin coordinator) · Sub-agents (own the task loop, report with
evidence) · Controller (read-only monitor) · User (decisions / approvals / direction only).

**Four substrates** — Channel (pluggable, recoverable) · Model tiers (script/cheap/frontier, pluggable) ·
State-tracking (branches, locks, WIP, logs, markers) · Host runtime (the harness + the project's stack,
self-managed by agents).

### Flows (FD–FK)

Flows are **derived from principles**: every principle implying a recurring process yields a flow; the set
is complete iff every such principle has one and every flow traces to one. (A pervasive *property* —
e.g. traceability logging — is cross-cutting, not a flow; a recurring *sequence* — the git lifecycle — is a
flow.)

| Flow | Name | What it produces |
|---|---|---|
| **FD** | Control / data | task in → classify → dispatch (with binding) → execute → relay results/decisions |
| **FE** | Documentation | docs-first reads; SSOT resolution; working-doc create→maintain→archive |
| **FF** | Verification (test-yourself) | reproduce → measure on the change's surface → before/after evidence → gate the "done" claim |
| **FG** | Cost / model-routing | per-unit tier decision (script/cheap/frontier) under the same gates; context hygiene |
| **FH** | Code-review | local/module/system review vs quality principles; severity-gated; blocks on Critical/High |
| **FI** | Recovery | pause/resume/recover; stall detection → orchestrator action; reconnect after reload/drift |
| **FJ** | Approval / safety | confirm-before-destructive/outward; full clearance; the autonomy↔safety boundary |
| **FK** | Version-control | branch → commit → merge → reconcile-with-origin (pull-merge, correct order) → push → tag/release → history/recovery (revert/reset/reflog) |
| **FL** | Documentation-review (∥ FH) | the twin of FH that runs **in parallel** to code-review in the dev pipeline: per-change doc-coverage + freshness lint → doc-review of the touched docs/docstrings vs the change → blocks the merge alongside code-review; + periodic semantic doc-audit (docs match measured behavior) |
| **FM** | Parallel-dev (deterministic conflict prevention) | decompose (write-sets → conflict graph → waves) → isolate (worktrees/edit-copies + per-worktree ports + GPU token) → develop in parallel → deterministic merge (file-disjoint ⟹ clean) → build+test (light: once on merged result; heavy: per-worktree + serial GPU) → rebuild gate |
| **FN** | Adaptive user-interaction loop | shape every user-facing exchange by the per-user profile (language/modality/style/depth) → offer options + the 3 meta-choices → track response statistics → tune autonomy/style/depth by trend (control laws), under the CP7 safety floor |
| **FO** | Wait → signal (monitoring) | a waiting agent registers a concrete completion condition (exit code / sentinel log line / port ready / marker file) → a light deterministic watcher fires when met → nudges the agent awake (a timeout is only a watchdog, never the primary signal) — replaces busy-poll + guessed sleep |

## 0.9 Work taxonomy

A task's **kind** sets its workflow shape. The orchestrator classifies each task into one of six
development-cycle categories before routing; the category parameterizes **which skill / how heavy** and the
**working-documentation lifecycle** (§0.10a).

*(This is the dev-cycle taxonomy — distinct from the version-control taxonomy of FK/M9. **RELEASE is a
version-control operation, not a dev-cycle category.**)*

| Category | Needs proposal? | Phased? | Changes code? | Output / shape |
|---|:--:|:--:|:--:|---|
| **CAMPAIGN** | yes | yes | yes | Major effort: proposal → phased implementation → debugging. |
| **FEATURE** | no | no | yes | One self-contained feature, direct from the prompt. |
| **BUGFIX** | no | no | yes | A bug fix (HOTFIX folded in — urgency is priority, not a different workflow). |
| **INVESTIGATION** | — | — | no (read-only) | Open-ended research to **understand**; output = understanding; may yield a proposal → Campaign. |
| **AUDIT** | — | — | no (read-only) | Systematic assessment vs standards; output = findings vs a rubric (realised by `/review`, M4). |
| **CHORE** | no | light | light | Maintenance: dep bumps, config, cleanup, small non-feature refactors, docs-only. |

**Routing:** CAMPAIGN → proposal lifecycle (§0.10b) then phased `/dev`; FEATURE/BUGFIX → `/dev` (or `/fn`);
INVESTIGATION → `/analyse`; AUDIT → `/review`; CHORE → light `/dev` or a direct edit.

### Transition graph

Categories are nodes in a directed graph — a task of one kind routinely produces work of another. **Entry
points:** direct prompt → Feature/Bugfix/Chore; research question → Investigation; quality concern → Audit
(cold); known major effort → proposal → Campaign. **Four transition kinds:** **SPAWN** (output produces a
*set* of child items of another category), **ESCALATE** (item promoted to a heavier category), **NEST** (a
Campaign contains phased sub-work), **DETOUR** (item spins off an Investigation then resumes).

| Category | Entry | Outgoing edges | Output doc |
|---|---|---|---|
| **INVESTIGATION** | research question / DETOUR-target | TERMINAL · SPAWN → Campaign(s) / Audit / {Features} / {Bugfixes} / Chore | findings report |
| **AUDIT** | quality concern (cold) / SPAWN from Investigation | TERMINAL · SPAWN → {Bugfixes} / {Features} / Campaign (refactor) / Chore / Investigation (cause unknown) | audit report + remediation checklist |
| **CAMPAIGN** | major-effort → proposal / SPAWN from Investigation·Audit / ESCALATE from Feature·Bugfix | TERMINAL (archive) · NEST (phases) · DETOUR → Investigation · SPAWN → {Bugfixes} · SPAWN → follow-on Campaign(s) | proposal + phase plans + logs |
| **FEATURE** | direct / SPAWN from Investigation·Audit | TERMINAL · ESCALATE → Campaign · DETOUR → Investigation · SPAWN → Bugfix | `/dev` session log |
| **BUGFIX** | direct / SPAWN from Audit·Investigation·Feature·Campaign | TERMINAL · DETOUR → Investigation · ESCALATE → Campaign | light `/dev` log (+ link to the finding if audit-spawned) |
| **CHORE** | direct / SPAWN from Investigation·Audit | TERMINAL · (rare) ESCALATE → Feature/Campaign · (rare) SPAWN → Bugfix | light log / commit-only |

**Invariants:** every category can TERMINATE (no forced edges); chains compose (Investigation → Audit →
{Features}).

## 0.8 Modules

The functional components, each with a clear responsibility border. *(Structures/layers live in §0.6;
cross-cutting processes/rules in §0.10; classifications in §0.9. Module boundaries follow concerns, not
legacy skill names — hence the folds noted below.)*

**M1 — Orchestrator** *(generic).* The thin coordinator and the user's interface: receive tasks over the
channel, classify them (§0.9), dispatch sub-agents each with an explicit `PROJECT_ROOT` (AP7), and relay
results + approvals back. It **runs the adaptive user-interaction loop (§0.10g, FN):** it shapes every
user-facing exchange by the per-user profile (language / modality / style / depth), offers decisions with
the three meta-choices (go-as-recommended / decide-yourself / explain), tracks the response statistics, and
**self-tunes how many decisions to surface** by trend — under the CP7 safety floor (irreversible/outward
actions are always surfaced). Never does deep work and holds no deep project context — staying lean is what
lets one session coordinate for hours and across projects. **Multi-task by nature (the §0.10e parallel-dev model,
FM):** it **decomposes** tasks by **write-sets → conflict graph → deterministic WAVES** of disjoint work
(essential overlaps sequenced later), **isolates** each agent (light edit-copies or heavy worktrees + per-
worktree ports + the GPU token), runs them in parallel, and integrates in a **deterministic merge order**
(file-disjoint ⟹ clean by construction; a conflict means the decompose missed an essential overlap) — the
**merge sweep** — so the user never live-tests a partial state, and conflicts are *prevented*, not detected
after the fact. Enforces **full clearance between tasks** and **never auto-commits** a sub-agent's work. Manages its own context two ways: **(a)** intra-session
self-clean+relaunch *with the user's OK* (snapshot → clear → re-bootstrap from WIP/locks/logs), **(b)**
inter-session resume from the same durable state. *(Subsumes the former `/multitask`.)*

**M2 — `/dev`** *(hybrid).* The workhorse for any code change. A disciplined lifecycle: (0) create session
log + register in WIP + **lock files**; (1) study docs first; (2) **baseline test**; (3) branch; (4) **before
writing any new function, run the REUSE-CHECK** (search the capability index + docstrings — §0.10d — and
reuse if it already exists), then edit + build (from `PROJECT_CONFIG.md`); (5) test + debug vs baseline;
(6) **verify with measured evidence** on the
change's surface — no "done" without it; (7) **update the docstring + local module-doc inline** with the
change (§0.10d) and pass the **doc-coverage/freshness gate** — its verification runs **code-review ∥
doc-review** (FH ∥ FL), both gating the merge; (8) **STOP and report for the user's approval** (it never
auto-commits/merges); (9) on approval, commit (attributed) / merge, release locks, clean WIP. Decomposes
function-level work and **delegates single functions to `/fn`** (tests written first), which is the
cost-tiering seam.

**M3 — `/fn`** *(generic).* The atomic unit of delegation and the cheap-model handoff point: implement/modify
**one** function against caller-supplied requirements + tests. **Mandatory pre-implementation REUSE-CHECK**
(§0.10d): search the capability index + docstrings for an existing implementation and reuse if found —
implement only if genuinely absent. It does not branch, lock, doc, or commit — those stay with the caller
(`/dev` or the user). Because a single function with a hard test gate is the smallest verifiable unit, it is
exactly where work routes to the cheapest correct executor — **routine bodies → cheap model (DeepSeek),
judgment → frontier — both through the same test gate.**

**M4 — `/review`** *(generic; ⚠ name collision — decide at the naming pass).* Graded, **read-only** code
review against the documented quality principles (lean code, no-duplication, complexity/file-size limits, and
**authority/concern boundaries** — single owner per piece of state, one job per module) at three levels —
**local** (a diff, pre-commit), **module** (after a refactor), **system** (periodic audit). Findings:
**Critical/High → BLOCK**, Medium/Low → advisory; the **same review applies to cheap-model output**. Produces
a report; fixes go through `/dev`. It also runs the **doc-level review/audit** (FL) — the periodic semantic
**doc-audit** (docs match measured behavior; the understand-from-docs-alone test of §0.10d), the doc-side
twin of its code review. *(Name collides with the built-in `/review` and overlaps `/code-review`;
options: rename to `code-quality-review`, or wrap the built-in `/code-review` as the engine and keep only the
project rubric.)*

**M5 — `/analyse`** *(generic).* Read-only deep analysis of a system/module: audit its docs, **verify them
against source**, assess architecture + quality against the project principles, produce an **improvement
proposal** (no code change). Artifacts filed canonically. It is the **deep-grounding front end** of the
proposal lifecycle (§0.10b).

**M6 — Controller** *(generic; cheap-model-tier candidate).* The detector half of AP5: a permanent, read-only
agent that watches locks, session logs, `git status`, and per-agent **markers**, and reports graduated alerts
(warn → escalate → halt). Enforces invariants by detection — Step-0 SLA, lock discipline, commit-prefix,
no-premature-wrap, docs-first compliance, and **stall detection** (an unmatched call-marker past a threshold =
an agent stuck on an invisible permission prompt). **It never acts** — it reports candidates; the orchestrator
decides. Because it reasons over a **fixed marker grammar**, it is a prime target to move off frontier: the
boolean checks → a script, the few interpretive calls (classify a stall → recommend action) → a gated
cheap-model call, with the quality guaranteed by the grammar + the gate.

**M7 — Model-tier / cheap-model adapter** *(generic, infra).* The cost-routing engine (realises AP4 / FG):
route each unit to the cheapest tier that meets the quality bar — **deterministic SCRIPT** (no-branch-on-
meaning, loud-local-failure) → **bounded-judgment CHEAP-MODEL** (over a known grammar, behind a deterministic
gate) → **FRONTIER** (open-ended judgment). Pluggable provider (DeepSeek = reference default). The gate is
never relaxed by tier (§0.3).

**M8 — Dev-pipeline tooling** *(generic, infra; the SCRIPT tier).* Deterministic bookkeeping/automation
scripts the orchestrator + skills **call instead of reasoning through** — environment **port-scoped sweeps**
(kill only the project's port-listeners, never by image name), Phase-1 verification, session-log/lock/WIP
bookkeeping, and **build launch**. Some scripts **are** the executable SSOT (the port-sweep script is the
canonical port-sweep — AP2). Two named functions: the **deterministic REBUILD function** (rebuild binaries +
sync the environment from a codebase update — the post-pull/post-merge gate: detect a compiled-file change →
rebuild → smoke-test), and the **drift lint** (a CI/pre-commit gate that fails the build if a forbidden or
duplicated form reappears — a stale build command, a fact that belongs in the config, a skill name shadowing
a built-in — the can't-recur guard for the SSOT). It also owns the **documentation-system tooling (§0.10d):**
the **doc-coverage + freshness lint** (the per-change gate), and the **capability-index + docstring-index
generators** that auto-build the capability-oriented "does X already exist?" view from the function
docstrings (so it can't drift). And the **parallel-dev tooling (§0.10e):** the **overlap analysis**
(per-task write-sets → conflict graph → waves) and the **resource allocation** (deterministic per-worktree
port assignment + the serialized GPU/runtime token). Scripts do plumbing + gather evidence; they never
branch-on-meaning (the verdict/commit-message/diagnosis stay frontier). *(The drift lint, the rebuild
function, the doc/capability tooling, and the overlap/resource tooling are dev-pipeline scripts, not separate
modules.)*

**M9 — Version Control Manager** *(hybrid; `/sync` is one capability).* Owns the full git lifecycle (FK)
across the project's repos: **branch** (isolation), **commit** (attribution), **merge** (feature→integration,
`--no-ff`), **pull/reconcile with origin** (the codebase-update half — fetch + pull-merge in the correct
order, before any push), **push**, **tag/release**, and **history/recovery** (revert preferred; reset/reflog
for local recovery). Safety posture: local ops run autonomously; **push, remote-affecting merge, tag/release,
and destructive history ops are confirm-before**, with `reconcile-before-push` and `never-force-push-unasked`
as hard rules. *(The legacy `/update` dissolves here: its codebase-pull half is M9; its rebuild half is M8's
rebuild function; the orchestration is M9 then M8 in sequence.)*

**M10 — Channel adapter** *(hybrid).* The pluggable remote interface between the user and the orchestrator —
the drive-from-anywhere substrate. Carries tasks in and reports/questions/results/**approvals**/files/voice
out (approvals are on the safety path, not just the status path). It carries the **voice/text modality**
(STT in / TTS out) and honors the user **switching modality on the fly** mid-session (§0.10g) — voice while
walking, text for precise content. **Queued + recoverable delivery** (inbound messages aren't lost mid-task
or across a reload). **Swappable** — Telegram is the reference channel, with email/WhatsApp/voice adapters;
the orchestrator codes to the adapter contract, not to one channel.

**M11 — Init tool (`devkit init`)** *(generic; outputs are PROJECT-tier).* The onboarding tool that makes the
generic core serve a specific project by **generating the project layer**: it interrogates the project and
emits **(a)** the facts config (`PROJECT_CONFIG.md`) and **(b)** a starter project rules file. *(The config is
a §0.6 structure; how skills observe the rules is the §0.10c rule; this module is only the generator.)*

**M12 — Host / supervisor app** *(generic; the runtime + I/O control).* The packaging that makes the
methodology a controllable app: a **standalone supervisor process that owns the Claude Code CLI as a
subprocess** (Agent SDK / `claude -p` headless, stream-json I/O), giving **full programmatic stdin/stdout**, a
thin local web/TUI panel, and the durable pluggable channel adapter (M10). It designs out three failure
classes structurally — **invisible permission prompts** (the supervisor sees and routes every prompt),
**editor reloads / MCP stdio drift** (a managed subprocess → a supervised restart, the FI recovery owner), and
**no programmatic I/O** (every byte passes through its bus and is captured). **Subsumes `cli-control`** — the
orchestrator's CLI self-control (remote clear+relaunch; releasing a stuck agent) becomes the supervisor's
programmatic mechanism, the basis of self-context-cleaning + recovery.

## 0.10 Cross-cutting processes & rules

These apply *across* the system rather than being owned by one component.

### (0) The document model

**Hierarchy is logical (authority/governance), not historical (spawn-order).** Authority ranking: **Campaign
proposal = governing (top)** > Audit report / Investigation findings (assessment outputs) > Feature/Bugfix/
Chore docs (operational records). Relationship types a doc can hold: **GOVERNS** (senior rules junior —
proposal → phases), **TRACKS** (senior lists + status-tracks a self-governed junior — audit → remediation
items), **REFERENCES** (citation, no authority). Rule: a higher-authority spawned doc (a proposal) becomes
senior and **demotes its spawner to a REFERENCE**; an investigation/audit that must *govern* is **promoted to
a proposal** (governing authority is proposal-tier).

**Tiers (durability × audience):**

| Tier | Durability · audience | Members |
|---|---|---|
| **T1 — durable deliverables** | human-readable · archived · **survive wrap-up** | **Proposal** (the plan; 1 per campaign; never splits unless the campaign splits) · **Implementation Report** (the as-built outcome, authored at wrap-up, distilled from the ephemerals — the proposal's counterpart) · Investigation findings · Audit report |
| **T2 — working planning** | agent-readable · **ephemeral** | phase plans, dev-process docs — governed by the proposal |
| **T3 — operational logs** | agent-readable · **ephemeral** | session logs — distilled into the T1 report, then discarded |

**Durable-trace floor (CP4 at the line level).** Every code-changing item — even a standalone Feature/Bugfix
with no proposal or report — leaves a durable trace to user intention via the **structured commit record**
(intention + change + verification) in git. Chain: **user-intention → work-item → commit → diff → line**,
walked back by `git blame`. This is why ephemeral logs are safely discardable: the commit carries the durable
essence. Scales by category — Campaign → Implementation Report + commits; Feature/Bugfix → commit record;
Chore → lightest commit; spawned → + a parent tracking link.

### (a) Working-documentation lifecycle

The canonical flow — **entry → during → wrap-up → durable footprint** — parameterized by the §0.9 category,
guaranteeing T1 durability + the trace floor:

| Category | Entry | During (ephemeral) | Wrap-up | Durable footprint |
|---|---|---|---|---|
| **CAMPAIGN** | proposal drafted → approved (governs) | T2 phase plans + T3 logs accumulate | **Implementation Report** authored (distils the ephemerals) → proposal + report archived; T2/T3 discarded | proposal + Implementation Report + commits |
| **FEATURE / BUGFIX** | direct (or spawned) | a T3 session log | structured commit record persists; log discarded | the commit record (+ parent tracking link if spawned) |
| **INVESTIGATION** | research question (or DETOUR) | T3 working log | findings report archived (TRACKS any children); log discarded | the findings report |
| **AUDIT** | quality concern (cold) or spawned | T3 working log | audit report + remediation checklist archived (TRACKS spawned items); log discarded | the audit report |
| **CHORE** | direct | minimal | commit record | the commit |

**Transition overlay:** SPAWN → the parent report TRACKS its children, each child REFERENCES the finding;
ESCALATE → the item's doc is PROMOTED in place (a feature log → a campaign proposal), origin preserved; a
spawned proposal GOVERNS the campaign and demotes its spawner to a REFERENCE.

### (b) Proposal lifecycle

1. **DRAFT** — authored when an Investigation, a complex Feature, or a major refactor warrants a Campaign;
   `/analyse`-grounded; lives in `docs/proposals/`.
2. **REVIEW & APPROVAL** — governed, top-down, iterative: **PART-0 foundations first** (purpose → principles →
   architecture) → module-by-module, each element tracing up; **one question at a time**; the user
   approves/comments per topic. *(How this review runs is itself governed by a standardized
   approval-procedure doc — forthcoming.)*
3. **ACTIVE / IMPLEMENTATION** — the approved proposal **governs** the phased Campaign (source of truth; T2
   docs comply); it never splits unless the Campaign itself splits.
4. **ARCHIVE** — de-reference from working code → `git mv` to `proposals/archive/` + a Status line; **and
   author the Implementation Report** (the as-built T1 counterpart).

**Governance:** PART-0 governs downstream; every element carries a traceability tag; an upstream change
re-traces the whole document.

### (c) Project-rules-observance

The generic skills **observe the project's embedded principles/methodologies/preferences, not just its
facts.** A project's rules file carries its quality standards, UI/design conventions, testing methodology,
domain cautions (e.g. a high-stakes-inference / axis-semantics "never infer this — measure it" category), and
workflow preferences; these **extend or, on conflict, override** the generic principles for that project
(§0.3). On every dispatch a skill resolves the facts config and observes the rules file (the `PROJECT_ROOT`
binding, AP7).

### (d) Project documentation system

The **system's own durable documentation** — the corpus that docs-first reads. *(Distinct from §0.10(a),
which is the dev/working/ephemeral record; this is the persistent, quality-gated knowledge base. It is CP2's
elaboration — and CP5, because it is gated like code.)* Four facets + the pipeline:

**1. Depth = function level.** The corpus + docstrings together must let an agent understand the system
**with no code-body reading.** Every function documents: *what it does · params (semantics + units + ranges)
· returns · side effects · non-obvious behavior.* Module docs describe **how the functions compose.** The
acceptance test: *"answer how-does-X-work from docs + docstrings alone"* — needing the code body is a **GAP**.
(This is documented-or-measured-never-inferred at function granularity.)

**2. Audience = a tiered gradient** (mirrors the working-doc tiers): **TOP** (index · architecture ·
system-overview · data-flows) is **HUMAN-readable** (narrative orientation); **MODULE-and-below** (module
docs · docstrings) is **AGENT-readable** — dense, fact-first, precise signatures / axis-semantics / units /
index-conventions, not narrative.

**3. Robustness = no gaps.**
- **Steady state:** a code change **⟹** a doc change, enforced by a gate — a change touching a function
  without updating its docstring + module-doc **fails review**.
- **Transition (incremental, ongoing dev):** **touch-it ⟹ document-it** — any function created or modified
  is brought to standard as part of that change, so coverage grows **monotonically**; plus **opportunistic
  legacy backfill** (when nearby work touches it) and **scheduled doc-audit Chores** targeting the biggest
  gaps **high-stakes surfaces first** (the data model · public interfaces · axis/unit/index facts). A
  **coverage metric ratchets** — it never drops, only rises.

**4. Process & coordination.**
- **Who updates = HYBRID.** The **dev-agent updates the docstring + local module-doc INLINE** with the change
  (atomic = no drift; the author knows the change best). A **separate doc-agent / doc-audit Chore owns
  cross-cutting consistency + architecture-level docs + periodic reconciliation.**
- **Quality (three points):**
  - **(i) Per-change GATE** — an automated **doc-coverage + freshness lint** (every touched function
    documented; fails the merge), run **inside the dev-agent's verification**. *(The lint is an **M8
    dev-pipeline** script, alongside the drift lint + the rebuild function.)*
  - **(ii) DOC-REVIEW in parallel with CODE-REVIEW** — the dev pipeline runs **code-review ∥ doc-review** as
    twin stages, **both gating the change** (flow **FL**, the twin of FH). Code-review checks the code;
    doc-review checks that the touched docs/docstrings match the change and meet the depth + audience
    standards.
  - **(iii) Periodic system-wide DOC-AUDIT** — **semantic**: the docs match **measured** behavior (the
    understand-from-docs-alone test), via **`/review`** at the doc level (M4) or **`/update-docs`**
    reconciliation. This is where inferred-but-wrong docs are caught against the live system.

**5. Discoverability = no redundant re-implementation (CP5/DRY, realised via the doc system).** *The
problem:* the structural doc hierarchy is organised by **location**, not **capability** — so it doesn't
answer *"does a function that does X already exist?"*, which is the question that prevents duplicate work.
A **layered** defence — DISCOVER → GATE → REVIEW:
- **DISCOVER — a CAPABILITY INDEX** (the reverse view of the structural hierarchy): **capability / verb →
  location + signature + one-line what-it-does**, searchable by capability. **Ideally auto-generated from
  the function docstrings** (facet 1 guarantees they exist), so it **can't drift** — a **tooling job (→
  M8)**. Plus a **DOCSTRING SEARCH fallback:** facet 1's every-function-has-a-docstring guarantee makes a
  docstring search a reliable *"does this exist?"* answer even when the index/hierarchy doesn't surface it.
  *(Function-level depth ENABLES capability discovery.)*
- **GATE — a mandatory REUSE-CHECK.** Before implementing any function, the **`/dev` / `/fn` agent MUST
  search** (capability index + docstring search) for an existing implementation; **reuse if found, implement
  only if genuinely absent.** A mandatory pre-implementation step (→ **M2** `/dev` + **M3** `/fn`).
- **REVIEW — the backstop.** **Code-review (CP5)** flags redundant re-implementation; **doc-review (FL)**
  flags a new function missing from the capability index. Catches what slips past the gate.

> **Traces:** CP2 (it is CP2's function-level elaboration), CP5 (gated like code; + DRY/no-redundancy via
> facet 5). **Realises FL** (the doc-review flow ∥ FH). Implementation: the per-change
> doc-coverage/freshness lint **and** the capability-index + docstring-index generators → **M8**; the
> pre-implementation reuse-check → **M2** `/dev` + **M3** `/fn`; doc-review ∥ code-review in the pipeline
> (M2 verification + M4 `/review`); the semantic audit → **M4 `/review`** (doc level) + **`/update-docs`**.

### (e) Parallel development & deterministic conflict prevention

**Objective: truly parallel multi-agent development with conflict PREVENTION by construction** — not advisory
locks, not after-the-fact detection. *(This **replaces** the advisory per-file MODULE_LOCKS concept.)* It
realises **FM** (the parallel-dev flow).

**Conflict classes → prevention mechanism:**
1. **Shared working tree / build** → **ISOLATION** (per-agent git worktrees or edit-copies).
2. **Overlapping code** → **PARTITIONING** by deterministic overlap analysis: per-task **write-sets** → a
   **conflict graph** (an edge = write-sets intersect **OR** an interface-dependency) → **WAVES** of
   mutually-disjoint tasks; tasks with *essential* overlap are sequenced to later waves.
3. **Shared runtime** (ports / GPU) → **deterministic per-worktree port allocation** + a **serialized TOKEN**
   for the singleton GPU.
4. **Integration** → a **deterministic MERGE ORDER** (file-disjoint partitions ⟹ textually clean by
   construction).

**Invariants:** every task can run **solo**; **deterministic** — the same tasks + write-sets → the same waves
→ the same merge order → the same result.

**Two-tier model** (chosen by **isolation-need + overlap strength**, *not* overlap-weight alone — does the
change need an isolated build/test to verify? is the overlap essential/strong or light/independent?):
- **LIGHT — edit-parallel / build-once.** Each agent edits in a **cheap isolated copy** (edit-only worktree
  or a patch; **no build in the copy**), so agents can edit the **same file / different function** in
  parallel → **merge** the branches (git auto-merges non-overlapping hunks **cleanly**; overlapping lines =
  essential overlap → escalate to heavy / sequence) → **one build + test on the merged result.** This solves
  same-file/different-function parallelism *and* avoids serialized slow rebuilds (build **once per wave**, not
  N times, not N serialized). *Caveat:* it tests the merged result, so a build failure needs a quick **bisect
  among the contributors** — fine for independent, non-essential edits.
- **HEAVY — fully isolated.** Per-worktree **build + test**, for changes needing **isolated verification** or
  essential/overlapping logic. Compiles parallelize across cores; the merge is still deterministic.
- **RESIDUAL:** the **GPU/runtime test serializes on the single GPU in BOTH tiers** — parallelism helps
  edit + compile, never the single-GPU test (more test parallelism ⟹ more GPUs).

**Procedure (replaces advisory MODULE_LOCKS):**
1. **DECOMPOSE** — overlap analysis → write-sets → conflict graph → waves; essential-overlap sequenced **(M1)**.
2. **ISOLATE** — light = edit-only copies; heavy = full worktrees + deterministic ports.
3. **DEVELOP in parallel** — agents confined to their partition / copy.
4. **MERGE** — deterministic order; non-overlapping hunks auto-clean; **a conflict = an essential overlap the
   decompose step should have caught** (so a conflict is a decomposition bug, not a routine event).
5. **BUILD + TEST** — light = **once** on the merged result; heavy = per-worktree (parallel compile) + serial
   GPU test. Then the **post-merge rebuild gate** (§0.10d / M8).

**What "locks" become.** The advisory MODULE_LOCKS (per-file, after-the-fact) are **replaced** by
deterministic **partition + isolation + deterministic merge**. The only real "lock" that remains is the
**GPU / runtime TOKEN** — a deterministic queue for the one resource that cannot be isolated (the single GPU).

> **Traces:** CP1 (autonomy — parallel autonomous agents), CP4 (version-control/traceability — branches +
> deterministic merge + commit trace), CP5 (quality — **correct, isolated test environments**: the light tier
> tests the merged result, the heavy tier tests in isolation — both give a correct env, vs the broken
> shared-tree contamination the advisory locks couldn't prevent) · **AP6** (explicit state, isolation &
> recoverability). **Realises FM.** Implementation: the decompose / schedule-into-waves / merge-order → **M1**;
> the overlap-analysis (write-sets → conflict graph → waves) + the resource-allocation (per-worktree ports +
> the GPU token) tooling → **M8**; the per-agent worktree isolation → the Agent/sub-agent layer.

### (f) Monitoring (light, deterministic wait-signaling)

A **monitor** is a **light, deterministic watcher that wakes / signals a waiting agent when a defined
completion condition is met** — replacing busy-polling and guessed timeouts. It realises **FO** and is what
lets an agent **wait efficiently** for any async event.

- **Deterministic.** It fires on a **concrete condition** — a process **exit code**, a **sentinel log line**
  (e.g. `[SUCCESS]`), a **port becoming ready**, a **marker file** — **not a timed guess**; the same
  condition → the same wake. A **timeout exists only as a safety watchdog** for a hung process, never as the
  primary signal (so there is no flaky timing).
- **Light.** A cheap condition-watcher (a condition-poll loop, or the harness's native background-completion
  signal) — **not a context-burning reasoning agent.** No analysis: condition-check → nudge.
- **Used for:** long **rebuilds** (wake on `[SUCCESS]` / exit), lengthy **tests** (wake on completion),
  **server startup** (wake when the port is ready), the **§0.10e parallel-dev** build / GPU-token waits, and
  any async wait — including the **test-yourself** (FF) measurement waits.

**It enforces efficient waiting:** the agent waits with **no busy-poll and no guessed sleep** → **CP1**
(autonomy — it waits without needing the user) + **CP6** (cost — no wasted polling cycles); and the wake is
**caused by the real event** → determinism (no flaky timing).

> **Traces:** CP1 (wait autonomously), CP6 (no wasted cycles). **Realises FO**; **supports FM** (§0.10e
> build/test/GPU-token waits) and **test-yourself** (FF measurement waits). Implementation: the monitor /
> condition-watcher tooling → **M8**; wiring the nudge to the waiting agent → **M1** / **M12** (the
> orchestrator / host owns the wait→wake plumbing on its I/O bus).

### (g) User-orchestrator interaction (adaptive profile)

A **per-user (optionally per-context / per-category) configuration that shapes every user-facing exchange**,
**adaptive** — tuned by tracked statistics. It is how the system delivers "full control over input/output"
(§0.11) *to a specific person*. It realises **FN** and operationalises the §0.3 decision hierarchy
(autonomy↔control) as a per-user self-tuning loop.

**The profile — four axes:**
1. **Language.** The **interaction** language (user-facing — the user's choice, e.g. Russian/English) is
   **distinct** from the **artifact** language: code, docs, and commits stay **canonical English** for
   portability / open-source.
2. **Modality.** Voice (STT in / TTS out) + text, **switchable on the fly mid-session** (the user goes to
   voice while walking/driving, back to text when settled; the orchestrator honors the switch). **Precise
   content** (code / paths / numbers / tokens) **favors text** — voice is error-prone there.
3. **Style.** Terseness / formality / structure, per user.
4. **Technical depth.** Full mechanics (technical user) ↔ decisions + outcomes only, mechanics hidden
   (non-technical). **Depth shapes HOW a decision is framed, NEVER WHETHER it is surfaced.**

**The adaptive decision loop (the core).** Each one-by-one decision offers the actual options + a free
comment + **three meta-choices with clear, distinct semantics:**
- **GO AS RECOMMENDED** — *"I read it, understood, and AGREE"* (engaged agreement).
- **DECIDE YOURSELF** — *"I trust you; I'm NOT going into the details"* (trusting delegation).
- **EXPLAIN** — *"I want more before I decide."*

> ★ **The GO-AS-RECOMMENDED vs DECIDE-YOURSELF distinction MUST be unmistakable** (clear labels + a one-line
> gloss) — they carry **different adaptation signals**, and **only "decide yourself" lowers the decision
> surface.** If the user blurs them, the statistics + adaptation corrupt.

**Track** per-user response statistics: accept-rec / decide-yourself / explain / deviate-from-rec /
comment-instead-of-choosing. **Control laws (statistics → adaptation):**
- many **DECIDE-YOURSELF** → surface **fewer** decisions (raise agent autonomy; stop asking what the user
  keeps delegating).
- many **EXPLAIN** → adjust **style / depth** for clarity (simplify, more context).
- many **DEVIATIONS-from-rec** and/or **COMMENTS-instead-of-choosing** → surface **more** decisions (the user
  wants finer control).

**Guards:**
- **Safety floor (CP7).** The dial tunes **routine** decisions only; **safety-critical / irreversible /
  outward-facing actions are ALWAYS surfaced.** The loop may delegate *which approach*, **never** *ok to
  force-push / send / delete.* The autonomy dial cannot cross this floor.
- **Transparent + overridable.** The user can inspect the current profile ("I've been deciding more /
  explaining more") and reset / override it; **no silent lock-out** of a decision class.
- **Smooth (hysteresis).** Adapt on a **trend**, not a single answer.
- **Compact.** Once the convention is known, the three meta-choices are offered **tersely** (not a verbose
  menu each time).

> **Traces:** §0.3 decision hierarchy (autonomy↔control, made a per-user self-tuning dial), CP1 (autonomy),
> CP7 (the safety floor), CP6 (efficient interaction — stop asking what the user delegates). **Realises FN.**
> Implementation: **M1** shapes output + interprets input + runs the loop, with per-user state holding the
> profile + the statistics; **M10** (channel adapter) carries the voice/text modality + the on-the-fly
> switch. Ties to §0.11 "full control over input/output."

## 0.11 Key design mechanisms

**Test-yourself (the central tenet) — the debugging-reproduction stance.** When something is wrong, **do not
ask the user to test, reproduce, narrow down, or paste logs — reproduce the user's experience exactly
yourself, observe the failure first-hand, and debug from that.** A bug report is information, not a request to
keep operating the machine. Two mechanisms keep the stance real:
- **Enablement (the capability doctor).** Before reproducing, check whether the environment can reach the
  user's actual experience for the affected surface. If it can't (no GPU, no audio driver, no mic-loopback,
  headless), the agent does **not** silently substitute a weaker check and does **not** offload to the user —
  it **prompts the user with concrete steps to upgrade the environment** and reports exactly which surfaces it
  could and couldn't reproduce. A `devkit doctor` runs a capability-probe matrix (each capability has a probe
  + an upgrade prompt; project-extensible).
- **Enforcement (the verification gate, warn-first → enforce).** A "done"/Phase-1 report must carry a matching
  **evidence artifact** for the change's verification surface — proof the behavior was reproduced and
  re-observed, not asserted. Each project declares its **verification surfaces** (an offline render, an HTTP
  200 + payload assertion, a screenshot diff, a benchmark delta, a mic recording, …); evidence files are
  durable and referenced from the session log. Ships **warn-first** (flag a missing-evidence "done"), then
  graduates to **enforce** (fail-closed unless the evidence references a real artifact). A surface the box
  can't reach routes to enablement, never a silent skip.

**Procedure tiering (script-first → cheap-model → frontier).** A unit is **scriptable** iff deterministic +
no-branch-on-meaning + loud-local-failure; **cheap-model-able** iff bounded judgment over a known grammar
behind a deterministic gate; otherwise **frontier**. A frontier turn re-reads the whole accumulated context,
so removing a turn (→ a script) is always a win, and isolating work into a fresh frontier sub-agent pays a
startup tax (so N isolated frontier workers lose to one pruned agent — isolation pays only with a cheap
model). Most recurring `/dev` bookkeeping is already scripted (Step-0 scaffold, wrap, port sweep, Phase-1
verify, build, commit); routine codegen is cheap-model (validated ~300× cheaper, with the test gate as the
correctness guarantee); the prime remaining migration is the **Controller** (boolean core → script; the stall
classification → a gated cheap-model call). What stays frontier: task classification, conflict/merge
resolution, regression verdicts, build-failure diagnosis, the Data Model Card, hypothesis-confirmation.

**Orchestrator-as-app.** The supervisor (M12) is the chosen form-factor over (A) staying in the CLI and
hardening the keystroke/monkey-patch glue, or (B) a Claude Code plugin — only the supervisor delivers literal
full programmatic I/O, survives reloads, and dissolves the invisible-prompt/stdio-drift classes. Incremental,
de-risked migration: ship the pluggable channel adapter + transcript capture first (alongside today's in-CLI
orchestrator), then add subprocess ownership, then retire the keystroke/patch glue. A and B remain fallbacks.

---

# PART 1 — TRACEABILITY MATRIX

The compact, machine-checkable record of which architectural principles + flows realise each core principle,
and which principles + flows each module serves. Upstream governs downstream; to find everything a principle
governs, grep its ID. *(The tables are the at-a-glance view; the per-element tags in the source carry the
authority.)*

**Core principle → realised by:**

| Core principle | Architectural principles | Flows |
|---|---|---|
| **CP1 Autonomy** | AP1, AP7 | FD, FF, FI, FM (parallel autonomous agents), FN (the autonomy dial), FO (wait autonomously) |
| **CP2 Documentation** | AP2 | FE, FL (doc-review) |
| **CP3 Remote connection** | AP1, AP8 | FI |
| **CP4 Version control + traceability** | AP5, AP6 | **FK** (the version-control process), FM (branches + deterministic merge); the traceability *property* is cross-cutting (FE + the `traces-to:` hierarchy) |
| **CP5 Code quality** | AP2, AP3, AP5 | FF, FH, FL (doc-review), FG-gates, FM (correct isolated test envs); + DRY/no-redundancy via §0.10d (capability index + reuse-check) |
| **CP6 Cost** | AP1, AP2, AP3, AP4, AP8 | FG, FN (efficient interaction — stop asking what's delegated), FO (no wasted polling) |
| **CP7 Safety & guardrails** | AP5, AP6, AP7 | FJ, FN-floor (the autonomy dial can't cross the safety floor) |

**Module → principles / flows / tier:**

| Module | Tier | APs | CPs | Flows |
|---|---|---|---|---|
| **M1 Orchestrator** | generic | AP1, AP7, AP6 | CP1, CP3, CP4, CP6, CP7 | FD, FI, FJ, FK (merge-sweep), FM (decompose/waves/merge-order), FN (runs the adaptive loop; + §0.3), FO (wires the wait→wake) |
| **M2 `/dev`** | hybrid | AP6, AP1, AP3 | CP1, CP5, CP2, CP4 | FD, FE, FF, FH, FL (doc-review ∥), FK (wrap-up); + §0.10d reuse-check |
| **M3 `/fn`** | generic | AP4, AP1, AP3 | CP1, CP6, CP5 | FF, FG; + §0.10d reuse-check |
| **M4 `/review`** ⚠ | generic | AP5 | CP5, CP7, CP4, CP2 | FH, FL (doc-level audit) |
| **M5 `/analyse`** | generic | AP5 | CP2, CP5, CP4, CP1 | FE |
| **M6 Controller** | generic | AP5 | CP5, CP7, CP4 | FI |
| **M7 Model-tier adapter** | generic (infra) | AP4, AP8 | CP6, CP5 | FG |
| **M8 Dev-pipeline tooling** | generic (infra) | AP4, AP2, AP6 | CP6, CP5, CP4, CP2, CP1 | FG, FD, FL (doc-coverage lint + capability-index/docstring-index generators), FM (overlap-analysis + resource/token tooling), FO (monitor/condition-watcher tooling) |
| **M9 Version Control Manager** | hybrid | — (uses M8 scripts) | CP4, CP7, CP5, CP1 | FK (owns) |
| **M10 Channel adapter** | hybrid | AP8 | CP3, CP7, CP1 | FD, FJ, FN (voice/text modality + on-the-fly switch) |
| **M11 Init tool** | generic | AP8, AP3, AP2 | CP2 | — |
| **M12 Host / supervisor app** | generic | AP1, AP8 | CP3, CP1, CP7 | FI, FO (wait→wake on the I/O bus) |

Non-module elements (referenced, not modules): the **project layer** (config/facts) → §0.6 (a structure); the
**working-documentation lifecycle**, **proposal lifecycle**, **project-rules-observance**, the **project
documentation system**, **parallel development & deterministic conflict prevention**, **monitoring
(deterministic wait-signaling)**, and the **user-orchestrator interaction (adaptive profile)** → §0.10
(cross-cutting); the **Implementation Report** → §0.10(0) (a T1 doc category).

---

# PART 2 — DECISIONS & ROADMAP

## 2a. Locked decisions

| # | Decision | Choice |
|---|---|---|
| **D1** | Open-source scope | Full kit; cheap-model, channel, and codegen layers all pluggable (provider-agnostic). |
| **D2** | Orchestrator form-factor | **Standalone supervisor process** owning the Claude Code CLI subprocess (stream-json I/O). "Stay-in-CLI" and "plugin" are fallbacks. |
| **D3** | License | **MIT.** |
| **D4** | Package name | **Deferred** (working placeholder; `hammock`/`offleash`/`codenomad` collide). |
| **D5** | Control channels | **CLI + Telegram core; pluggable adapter** (Slack/web/etc.). |
| **D6** | Cheap-model provider | **Pluggable; DeepSeek = reference default.** |
| **D7** | P0 de-drift + SSOT | **Done** — build-command drift fixed across the skillset; `PROJECT_CONFIG.md` is the SSOT; the drift lint makes it unable to recur. |
| **D8** | Personal-assistant skills | **Exclude the skills; keep the generic MCP extension mechanism** (the kit supports adding MCP servers; it just doesn't bundle the personal ones). |
| **D9** | Reference example | **Sanitized generic example;** the dogfood project stays private. |
| **D10** | Where the kit lives | **New dedicated public repo** with its own CI. |
| **D11** | Verification-gate strictness | **Warn-first → graduate to enforce.** |

## 2b. Phased roadmap

| Phase | Scope | Depends on |
|---|---|---|
| **P0 — De-drift + SSOT** *(done)* | The build-command de-drift across the skillset; `PROJECT_CONFIG.md` (operational-facts SSOT); the docs-first preamble collapsed to a single pointer; the forbidden-form drift lint (CI gate). | — |
| **P1 — Generic/project separation** | In-place: make the generic skills project-agnostic (every project fact → a `PROJECT_CONFIG.md` reference, grep-gate-proven), split the generic rules into a `@`-imported file, add the multi-project `PROJECT_ROOT` dispatch binding. Later, separately approved: hoist the generic core to the user-level shared layer + the public-kit extraction (`devkit init`). | P0 |
| **P2 — Supervisor app + I/O control** | Build the standalone supervisor: channel adapter + transcript capture first (alongside the current orchestrator), then subprocess ownership, then retire the keystroke/patch glue. | P1 (skills channel-agnostic) |
| **P3 — Verification gate + capability matrix** | Generalize verification surfaces; add the structural warn-first verification gate + durable evidence; build the capability probe + `devkit doctor` + the runtime upgrade-prompt loop. | P1 |
| **P4 — Complete the tier migration** | Split the Controller into a script core + a gated cheap-model judgment layer; move the remaining invariant checks to scripts; wire the supervisor-based marker hook. | P2 |
| **P5 — Public release** | License, onboarding, packaging, a generic `examples/` project, the kit's own CI (lint + tests + capability-aware matrix). | P1–P4 |

P0 and P1 deliver most of the value; P2 (the app) is the biggest user-facing improvement; P3+P4 deepen
test-yourself + the cheap-model tiering.

## 2c. Other improvements worth folding in

- **Kill the dead text** (e.g. stale "tool not available" passages that misdirect agents into wasteful
  respawns) as part of P1.
- **Ship the permission allow-list as a `devkit init` artifact** (both shells + core tools + MCP) so no
  project re-discovers the whack-a-mole trap; template the machine-local settings and document regeneration.
- **Observability** — with the supervisor capturing all I/O, add a session-replay/metrics view (per-session
  token cost, tier breakdown, stall events, the verification-evidence index).
- **Capability-aware CI** — `devkit doctor --ci` reports which verification surfaces a runner can reach and
  loudly skips (never green-washes) the ones it can't.
- **Cross-platform parity** as a first-class config concern (interpreter path, process-kill mechanism, build
  invocation resolved from config, not scattered inline caveats).
- **Promote the "investigation → implementation handoff" rule** (a hypothesis drives *measurement*, never a
  *code edit*, until confirmed) to a top-level generic tenet — it pairs with the verification gate.
