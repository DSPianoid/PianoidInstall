# Generic Agentic-Development Skillset — Core Principles

> Standalone principles reference, extracted 2026-06-24 from `docs/proposals/generic-dev-skillset-opensource-2026-06-11.md` (§0.2 Core principles · §0.3 Decision hierarchy · §0.5 Architectural principles + cross-cutting rules + the generic/project boundary). The proposal carries the full design; the CP/AP IDs + decision hierarchy here are the canonical principles SSOT. Section numbers retain the proposal's numbering.

## 0.2 Core principles (CP)

| ID | Principle | Meaning |
|---|---|---|
| **CP1** | **Maximum autonomy** | Agents own the complete task loop unattended — self-manage the environment, reproduce, diagnose by measurement, implement, and **test-yourself** (self-verify with measured before/after evidence). Operational blockers are solved by the agent, never bounced to the user. **Never ask the user a question you can answer yourself** by checking system state, code, logs, or the running environment — determine it first; reserve user questions for decisions, approvals, and knowledge only they hold (the seam to CP9). |
| **CP2** | **Comprehensive documentation** | Docs-first navigation (the doc hierarchy is the context), a single source of truth for project facts, and working-documentation that records every action so state is legible and recoverable. |
| **CP3** | **Stable & recoverable remote connection** | The user drives from anywhere over a channel that survives interruption — reconnect, resume, recover after editor reloads / stdio drift / stalls without losing work. |
| **CP4** | **Version control + full traceability** | Every change is attributable and followable end-to-end: branches, commit attribution, session logs, and a traceable design hierarchy where upstream governs downstream. |
| **CP5** | **Code quality control** | Quality is gated, not hoped for: review against explicit principles, regression gates, file-size/complexity limits, the verification gate — applied to **all** work regardless of which model produced it. |
| **CP6** | **Cost control** | Spend the minimum that preserves quality: tier work to the cheapest correct executor (script → cheap-model → frontier), prune context — **optimized within quality, never by skipping gates**. |
| **CP7** | **Safety & guardrails** | Bounded autonomy: scoped operations (no blanket kills), fail-fast (no silent workarounds), confirm-before-destructive/outward-facing, full clearance between tasks, a read-only compliance monitor. |
| **CP8** | **Adaptive to feedback** | Treat **any** user signal — criticism **or** praise — as feedback: identify **exactly** what the user dislikes (or likes) about the behavior and convert it into a concrete **behavioral correction**, so the disliked behavior does not recur and the liked behavior is reinforced. Adaptation is per-user and persists (§0.10g profile + statistics). |
| **CP9** | **Understand-first (no guessing)** | The first task for any request is to **understand it exactly**. If the formulation admits **any** ambiguity, **rephrase it in your own words and present it back for confirmation** before acting. Ask when unsure; **never guess** intent. (CP1 still applies to *facts* — answer those yourself; CP9 governs *intent* — confirm that with the user.) The read-back is a **judgment call by default**, but is **ENFORCED for high-stakes Campaigns** (always restate + confirm scope, like the verification gate). |

CP1–CP9 are the **generic** principles. A project may carry its own principles/methodologies/preferences in
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
3. **AUTONOMY ↔ UNDERSTAND-FIRST = split by facts-vs-intent.** CP1 (don't ask what you can determine) and CP9
   (confirm ambiguous intent) do not conflict — they partition by *kind of unknown*: a **fact** the agent can
   establish from system state / code / logs / environment is **answered by the agent, never asked** (CP1);
   genuine **intent ambiguity** in the request is **reflected back for confirmation, never guessed** (CP9). A
   read-back is for intent, not for facts; a clear request needs none.

Unresolved conflicts escalate to the user. **Layer precedence:** project rules extend, and on direct
conflict override, the generic principles for that project (validated against the harness's
personal-over-project memory model). A project rule may refine any CP.

## 0.5 Architectural principles (AP)

| ID | Principle | One line |
|---|---|---|
| **AP1** | **Coordinate-vs-own by tier (the hybrid middle tier is first-class)** | The **TOP-tier orchestrator coordinates and does not execute** — a thin classifier/dispatcher/relay that owns no deep work. **FEATURE-tier dev agents own** the complete task loop in isolated context and report. The **MIDDLE-tier agent (M1.5) legitimately does BOTH** — it coordinates (dispatches feature sub-agents) **and** owns/executes work itself within its scope. This hybrid is a **first-class part of the model, not an exception**; what holds at *every* tier is the CP7 safety floor + never-auto-commit (whoever executes owns their own loop + evidence). |
| **AP2** | **Single source of truth (+ drift-lint)** | Project facts live once (`PROJECT_CONFIG.md`); cross-cutting discipline lives once; a forbidden-form/duplication lint makes drift unable to recur. |
| **AP3** | **Generic/project separation** | Generic **methodology** vs project **(facts + project-specific normative rules)**. The core *resolves* the facts config and *observes* the project rules at runtime via the `PROJECT_ROOT` binding. The split is **not** data-vs-code. |
| **AP4** | **Model tiering, gates on every tier** | Route each unit to the cheapest *correct* executor (script → cheap-model → frontier); the same test/review/verification gates apply regardless of tier. |
| **AP5** | **Read-only compliance monitoring** | A permanent Controller watches state + markers and reports graduated alerts (warn → escalate → halt); it never edits, spawns, kills, or blocks. |
| **AP6** | **Explicit state, isolation & recoverability** | Branches, **deterministic partition + worktree isolation** (the §0.10e parallel-dev model — replaces advisory per-file locks), WIP roster, append-only session logs + markers, pause/resume/recover exit procedures. |
| **AP7** | **Explicit multi-project binding** | The orchestrator passes an explicit `PROJECT_ROOT` per dispatch (per-subagent cwd is unshipped in the harness); per-project state/config resolve from it — so one system can run several projects, even two at once. |
| **AP8** | **Pluggability** | Channels, model tiers, and MCP integrations are swappable interfaces, not hardwired. |
| **AP9** | **A bug is an architectural signal** | Every bug is a **YELLOW flag for the underlying architecture**, not merely a local defect — its fix is provisional until the architecture is checked. It escalates to **RED** when it either (i) indicates **diverging behavior** (the same thing behaving inconsistently across paths/contexts) **or** (ii) **recurs / resembles a bug fixed before**. A RED bug signals a **single-source-of-truth (AP2) violation** (and related AP breach) and **MUST trigger an architectural review of that source of truth** — not just another local patch. |

**Cross-cutting operating rules** (always on): docs-first navigation; fail-fast / no workarounds;
confirm-before-destructive/outward-facing; full clearance between tasks; commit attribution; scoped
(port/PID-only) process kills; **multi-issue → consecutive resolution** (present and resolve issues with
the user one at a time, not batched); and the **bug-triage rule (AP9)** — classify every bug YELLOW/RED, and
a RED bug escalates from a local fix to an architectural review of the violated source of truth.

**The generic/project boundary (AP3):**
- **GENERIC (shared, one copy):** the methodology — skills/workflows, the principles, the flows, the
  controller, the tooling. Project-agnostic (grep-gated: zero project tokens).
- **PROJECT — facts (`PROJECT_CONFIG.md`):** the operational SSOT the skills *resolve* — stack,
  build/test/run, repo layout, ports, paths, endpoints, verification surfaces.
- **PROJECT — normative rules (project `CLAUDE.md`):** the project's principles / conventions / testing
  methodology / domain cautions / workflow preferences the skills *observe* (extend/override per §0.3).

