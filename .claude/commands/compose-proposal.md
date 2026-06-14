---
name: compose-proposal
description: AGENT-INVOKED. Compose a Campaign-scale proposal by governed top-down design — foundations first, one topic at a time, every element traced to a principle. The agent invokes this on detecting Campaign-scale work; it produces a lean Tier-1 proposal that enters the proposal lifecycle.
tier: generic
---

# compose-proposal — author a Campaign's governing proposal (governed, top-down)

> **Generic composer skill** (`tier: generic`, agent-invoked). It names no project facts (it authors proposals from principles), so it has **no project worked-examples companion** — that absence is intentional; do not add one.

A generic dev-kit skill, **invoked by an agent** (the orchestrator or a dev-agent) when it detects that the
work in front of it is **Campaign-scale** and therefore needs a proposal. It is **not** a standalone
user-typed command — the user initiates a Campaign (a new initiative, or a spin-off the agent surfaces), the
agent gathers the context, and the agent then invokes `compose-proposal` as a step in the pipeline.

It drives the **composition + governed top-down design** of the proposal: most-foundational layer first,
the user approves/comments per topic, every element traced to a principle, lean human-readable output
(history preserved in a side seed). The result is the **governing** document of the Campaign, which then
runs the proposal lifecycle (Draft → Review/Approval → Active → Archive + Implementation Report).

---

## When the agent invokes this (the pipeline)

This skill sits inside an agent's workflow, not at the user's keyboard. The pipeline:

1. **The user initiates a Campaign** — either a **NEW INITIATIVE** (a fresh major effort the user asks for)
   or a **SPIN-OFF** (work that branches off something already underway — the spin-off may itself be at an
   **agent's suggestion**).
2. **The agent figures out the context** — what the Campaign is, what it touches, what already exists
   (grounding it against docs/source where relevant).
3. **The agent invokes `compose-proposal`** once it has judged the work **Campaign-scale**.

**Trigger = the agent DETECTING Campaign-scale** (not a user command). Map it onto the work taxonomy +
transition graph:
- **NEW INITIATIVE** → a **direct major-effort entry** (the user already knows it's big — start at the
  proposal).
- **SPIN-OFF** → a **SPAWN or ESCALATE** edge from an Investigation / Audit / Feature / Bugfix (findings
  warrant a Campaign, or an in-flight item turns out major). When a Campaign is spawned, the **spawner is
  demoted to a REFERENCE** and this new proposal becomes the governing doc.

**Do NOT invoke** for a plain **Feature / Bugfix / Chore** — those go direct (`/dev` or `/fn`), no proposal.
If the kind is unclear, classify first; only a `CAMPAIGN` (or an Investigation/Audit electing to spawn one)
earns a proposal.

**Output location:** the proposal lives in the proposals folder (e.g. `docs/proposals/<topic>-<date>.md`);
the preserved composition seed lives beside it in a side folder (e.g. `docs/proposals/.process/`).

---

## Two build modes (the agent chooses)

The agent picks **how** to build the proposal based on complexity. Both modes converge on the **same
governed output** (a Tier-1 proposal + seed, PART-0-governs-downstream, traceable, element-kind disciplined,
one question at a time during dialog) — they differ only in whether there is a pre-draft.

- **Mode A — DRAFT-FIRST.** The agent drafts a **v1 from the gathered context**, then **refines it with the
  user in dialog** — still top-down and governed, topic by topic. *Faster; for clearer, well-understood,
  lower-complexity Campaigns* where the structure is not in doubt and the draft just needs the user's
  corrections.
- **Mode B — DIALOG-FROM-SCRATCH.** The agent **co-builds top-down in dialog** with no pre-draft — PART 0
  first, topic by topic — so the **structure itself is co-designed** with the user. *For complex, novel,
  structurally-uncertain, or high-stakes/sensitive Campaigns* (this is what the dev-kit proposal itself
  used).

**Mode selection (the agent's call):**

| Signal | Mode |
|---|---|
| Simple / well-scoped / well-understood; structure obvious | **A — draft-first** |
| Complex / novel / structure uncertain / high-stakes / sensitive (the framework needs co-design) | **B — dialog-from-scratch** |

When in doubt, prefer **B** — a wrong structure is expensive to unwind, and the dialog surfaces it early.
Either way the **governance, traceability, element-kind discipline, and one-question-at-a-time cadence are
identical**; in Mode A they apply during *refinement*, in Mode B during *construction*.

## The composition method (the core — applies in BOTH modes)

Build the proposal **top-down in governed order** — the same order the reader will later read it, and the
same order in which upstream governs downstream. **Present each topic to the user for approve/comment
BEFORE moving to the next** (in Mode A this is reviewing the drafted topic; in Mode B it is constructing it
together). Never jump ahead to a downstream element while an upstream one it depends on is unsettled.

**PART 0 — FOUNDATIONS first (in this order):**
1. **Purpose** — the one-paragraph product objective. Everything downstream exists to serve it.
2. **Core principles** — the small set of named principles (give each an ID, e.g. `CP1…`). One line each.
3. **Decision hierarchy** — how to resolve conflicts *between* principles (the user's priority ordering).
   This is what you consult whenever two principles pull apart.
4. **Architectural principles** — the architecture-level commitments that realise the core principles
   (IDs `AP1…`), each tracing to the CP(s) it serves.
5. **Overall architecture + flows** — the layers / actors / substrates, and the **flow set** *derived from
   the principles* (every principle implying a recurring process yields a flow; IDs `FD…`). Check
   completeness: walk the principles, ask "does this imply a recurring process?", require a flow for each.

**THE ELEMENT BODY (only after PART 0 is approved):**
6. **Classification(s)** — any taxonomy the design needs (e.g. a work-kind taxonomy) **and its transition
   graph** (how the kinds flow into one another). *Design the graph before anything that derives from it.*
7. **Modules** — the functional components, one at a time, each a tight paragraph (responsibility + key
   behavior). Each module traces to its principles + flows.
8. **Cross-cutting processes / rules / lifecycles** — the things that span the components (e.g. document
   model + lifecycles), built **after** the classification/graph they consume.

> Foundations govern the body. If a body element forces a change upstream (a new principle, a corrected
> flow), **go back, change the upstream element, and re-trace** — do not smuggle the change in downstream.

---

## Governance + traceability (the spine)

- **Upstream governs downstream.** Purpose → principles → architecture → classification → modules →
  cross-cutting. A downstream element must comply with every element above it.
- **Every element carries a `traces-to:` tag** naming the upstream ID(s) it serves. The tags are the
  source of truth.
- **An upstream change re-traces the whole document.** To find everything a principle governs (before
  changing it), grep its ID; every hit is an affected dependent. Fix them all, or the change is incomplete.
- **Traceability lives in compact MATRICES, not inline prose.** Keep one principle→(architectural-
  principles + flows) matrix and one element→(principles + flows + kind) matrix. The body reads as a clean
  human spec; the matrices carry the machine-checkable record. (Strip verbose inline "this traces to X
  because…" sentences — the tag + the matrix say it once.)
- A downstream element that serves **no** principle is scope creep — flag it. An upstream principle with
  **no** downstream element is unrealised — flag it.

---

## Element-kind discipline (do not conflate kinds)

Before placing any element, classify **what kind of thing it is** — each kind gets its own section:

| Kind | Test | Where it goes |
|---|---|---|
| **MODULE** | a functional component with a clear responsibility border — you can point at it and say "this owns X" | the modules section |
| **CROSS-CUTTING PROCESS / RULE** | applies *across* the system; not owned by one component | the cross-cutting section |
| **STRUCTURE / LAYER** | a place things live / a parameter set, not a component that does work | the architecture section |
| **CLASSIFICATION** | a way of categorizing work/elements | the taxonomy section (upstream) |
| **FLOW** | a recurring *sequence* derived from a principle | the flow set |
| **PRINCIPLE** | a governing commitment | core or architectural principles |

**Module boundaries follow CONCERNS / CAPABILITIES, not legacy names.** A capability named after an old
tool may belong inside another module (or split across two) once you ask "what concern does this serve?"
When a candidate "module" is really a process, a structure, or a capability of another module, **re-home
it** and leave a one-line pointer so nothing is lost. (Example shape: a "multi-task" capability folds into
the coordinator; a lint folds into the tooling; an "update" splits by concern across version-control +
build.)

---

## Design-before-dependents

- **Design the upstream artifact before the thing that derives from it.** The flow set before the modules;
  the transition graph before the document lifecycles (the lifecycles thread parent→child along the graph's
  edges — you need the edges first); the doc *model* (hierarchy + tiers) before the per-category lifecycle
  that obeys it.
- **Validate a framework by mapping the user's concrete examples onto it.** When you propose a taxonomy, a
  graph, or a hierarchy, take the user's real cases and place each one — if a case doesn't fit, the
  framework is wrong (or incomplete), not the case. Surface the misfit and fix the framework.

---

## Communication discipline

- **One question at a time.** When several issues or decisions arise, resolve them **consecutively**, not
  batched into one message. Present a topic, get the answer, then the next.
- **Surface conflicting principles to the user to prioritize.** When two principles pull apart and the
  decision hierarchy doesn't already settle it, do not pick silently — present the trade-off and let the
  user set the priority (then record it).
- **Make procedure observations along the way.** When you notice a structural point (a misfiled element, an
  under-derived principle, a naming collision, a better element-kind), say it as a short note and let the
  user steer — don't bury it or unilaterally restructure.
- **Lean, human-readable output.** The durable proposal is a Tier-1 deliverable: concise, read top-to-
  bottom, tables doing the heavy lifting. No worklog tone, no inline history, no re-derivation.
- **Preserve history in a side seed, out of the proposal.** Keep the compositional record — the
  design-evolution log, the per-decision notes, superseded framings — in a side file (the `.process/`
  seed), so the proposal stays clean while nothing is lost. The seed is also the input to *this* skill's
  future refinements.

---

## Procedure (operational steps)

1. **Confirm it earns a proposal.** The agent classifies the work; proceed only for a Campaign — a new
   initiative or a spin-off (SPAWN/ESCALATE). Otherwise route to `/dev`/`/fn` and stop.
2. **Ground the context.** Gather what the Campaign is + what it touches; if it concerns an existing system,
   run the deep-grounding pass first (audit docs, verify against source, assess) so it sits on measured
   reality, not assumption.
3. **Choose the build mode** (the agent's call): **A — draft-first** for a clear/well-scoped Campaign;
   **B — dialog-from-scratch** for a complex/novel/structure-uncertain/high-stakes one. When in doubt, B.
4. **Scaffold the two files.** Create the proposal (in the proposals folder) and the side seed (in
   `.process/`). Put the "how to read / governed-hierarchy" note at the top of the proposal.
5. **PART 0 top-down, one topic at a time.** Purpose → core principles → decision hierarchy → architectural
   principles → architecture + flows. *(Mode A: draft the topic, then present it; Mode B: construct it with
   the user.)* **Stop after each topic; get approve/comment; record any decision** before the next. Tag
   every element `traces-to:`.
6. **The body top-down, one element at a time.** Classification + transition graph → modules (each a tight
   paragraph) → cross-cutting processes/lifecycles. Same stop-and-approve cadence. Classify each element's
   KIND and place it in the right section. Map the user's concrete examples onto every framework to
   validate it.
7. **Maintain the spine continuously.** When any topic forces an upstream change, go back, change it, and
   re-trace dependents (grep the ID). Keep the two matrices current as the derived view.
8. **Record decisions + observations.** Lock each user decision in the proposal (a compact decisions
   table); append the longer reasoning + any superseded framing to the seed.
9. **Keep it lean.** Periodically (or at the end) strip motivation prose, inline traces-prose, and history
   to the seed — the proposal is the spec, the seed is the memory.
10. **Hand off to the proposal lifecycle.** The finished proposal is the **DRAFT** stage of the proposal
    lifecycle; it then goes Review/Approval → Active/Implementation (it GOVERNS the phased Campaign; it
    never splits unless the Campaign itself splits) → Archive (+ author the Implementation Report at wrap-up).

---

## Output

- **The proposal** (Tier-1, durable): a concise, governed, human-readable spec — PART 0 foundations, the
  element body, and a compact traceability-matrix section. This is the **governing document** of the
  Campaign.
- **The composition seed** (side file): the design-evolution log + per-decision notes + superseded
  framings — the preserved history, out of the proposal.

The proposal enters the **proposal lifecycle** (Draft → Review/Approval → Active → Archive + Implementation
Report). Quality + safety: this skill does **read-only** authoring + user-facing review; it does not commit,
merge, or change code — those happen later, in the Campaign's `/dev` + version-control work, under the
approved proposal.

---

## Anti-patterns (don't)

- Don't write the modules before the principles + flows are approved (downstream-before-upstream).
- Don't conflate a process or a structure with a module — classify the kind first.
- Don't name-drive a module ("this is the X skill, so it's a module") — concern-drive it.
- Don't batch multiple open questions into one message — one at a time.
- Don't pick a side of a principle conflict silently — surface it to the user.
- Don't leave traceability as inline prose — put it in the matrices.
- Don't let history/motivation bloat the proposal — push it to the seed.
- Don't smuggle an upstream change in downstream — go back, change it, re-trace.
