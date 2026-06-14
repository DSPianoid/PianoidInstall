---
name: analyse
description: Deep analysis of a system/module in the active project — docs audit, code review, architecture assessment, improvement proposal.
user-invocable: true
tier: generic
argument-hint: <system or module name — e.g. "excitation system", "playback engine", "parameter routing", "deck coupling">
---

# System/Module Analysis

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the canonical rebuild command, the module-doc drill, the docs-server restart, and the test tiers — live in [`.claude/skill-examples/analyse.md`](../skill-examples/analyse.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Deep-dive analysis workflow: audit documentation, verify against source code, update docs, then assess architecture and code quality. Produces two deliverables: an updated documentation report and an improvement proposal.

**CRITICAL: Documentation-first rule applies throughout.** Always check docs before reading source.

## Docs-first (MANDATORY) if the analysis triggers a rebuild

If this analysis reproduces behavior, runs tests, or rebuilds to verify a finding, the rebuild MUST go through canonical paths (a silently-stale binary voids every "I verified this" claim).

- **Full docs-first build/run discipline: the single canonical copy at the active project's [`PROJECT_CONFIG.md` → Docs-first for build + run](../../docs/PROJECT_CONFIG.md#docs-first-build--run)** — the canonical build command + agent-context detached form (stop the build holder first), the **never-substitute traps**, and the **verify-landed** step (marker absent → the rebuild didn't land, any conclusion is void); also [`#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) / [`#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders).
- **On unexpected build or server failure → invoke the project's startup/build-recovery skill** (see [`PROJECT_CONFIG.md#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run)) rather than ad-hoc fixes.

## Arguments

The argument is a system or module name in the active project, e.g.:
- `excitation system`
- `playback engine`
- `parameter routing`
- `deck coupling`
- `mode simulation`
- `string simulation`
- `midi system`
- `chart system`
- `preset system`
- `memory management`
- `audio drivers`

Or any other subsystem the user names. Scope the analysis to the named system. (The example names above are illustrative; the real subsystem set is whatever the active project exposes — resolve the module map from [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy).)

## Documentation Folder Taxonomy (MANDATORY)

When this skill produces a written artefact (proposal, analysis, review, diagnostic snippet), route it to the canonical location - never to `docs/development/logs/` (that folder is for agent session logs only).

| Artefact | Folder |
|----------|--------|
| Refactor proposal, design analysis, plan, planning doc | `docs/proposals/` |
| Code review, system review, audit | `docs/development/reviews/` |
| Diagnostic snippet (`.py`, `.js`, `.html`) | `docs/development/diagnostics/` |
| Standalone screenshot | `docs/development/screenshots/` |
| Long-lived architecture / module / guide doc | `docs/architecture/` / `docs/modules/` / `docs/guides/` |

Naming: `<topic>-<YYYY-MM-DD>.md` for proposals; `<scope>-review-<YYYY-MM-DD>.md` for reviews. The full taxonomy lives in `.claude/commands/dev.md` - the Phase 4 report and any saved proposal MUST be filed under `docs/proposals/`.

**One-doc-per-topic in `docs/proposals/` (MANDATORY):** the canonical rule lives in [`.claude/commands/dev.md`](dev.md) — `docs/proposals/` holds exactly ONE currently-active doc per topic; archive a superseded/preparation/research doc to `docs/proposals/archive/` (`git mv` the prior version BEFORE adding a new one). For this skill: the FINAL plan stays in `docs/proposals/`, its supporting investigation docs go to `archive/`. Never create `docs/development/proposals/` (working/planning docs go directly under `docs/development/`).

## Phase 1: Documentation Audit

### 1.1 Identify Relevant Docs

Read docs in this order to build context. Stop and note which docs cover the target system:

1. `docs/index.md` — locate the system in the module map
2. the system-overview architecture doc — where the system sits in the layered stack
3. the data-flows architecture doc — trace the system's data flows
4. Drill into the relevant module doc under `docs/modules/` (resolve the module→doc mapping from the active project's [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) — engine/compute, middleware/server, domain-model, and frontend each have their own module doc)
5. the development/testing doc — test coverage for this system
6. `docs/development/WORK_IN_PROGRESS.md` — active investigations

(The exact doc filenames are project facts — read them top-down per [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy).)

**Output:** List of doc files that cover (or should cover) the target system.

### 1.2 Read Source Code

After docs, read the actual source files for the target system. Use Explore agents for broad searches; use Grep/Glob for targeted lookups.

Focus on:
- Function signatures, class structure, data flow
- Constants, magic numbers, configuration
- Error handling, edge cases, thread safety
- Naming conventions, code organization

### 1.3 Identify Documentation Gaps

Compare docs against source. Flag:
- **Incomplete:** Features/APIs/flows not documented
- **Incorrect:** Docs that contradict the source code
- **Inconsistent:** Different docs that disagree with each other
- **Stale:** Docs referencing removed/renamed code

## Phase 2: Documentation Update

### 2.1 Update Existing Docs

For each gap found in Phase 1:
- Update the relevant doc file(s) in place
- Follow style rules: tables over prose, code blocks for APIs, one sentence per concept, no filler
- Keep documentation lean — every sentence earns its place
- Ensure cross-references between related docs are correct

### 2.2 Structural Changes (REQUIRES USER APPROVAL)

If the analysis reveals the need for:
- New doc pages
- Reorganizing sections between files
- Removing doc pages
- Changes to `mkdocs.yml` nav or `index.md` map

**Stop and ask the user before proceeding.**

### 2.3 Restart the docs server

After doc updates, restart the docs/preview server so changes are reflected. Kill the running instance and relaunch it at the project's docs-server address ([`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)); the concrete project command (kill + serve) is in the [worked-examples companion](../skill-examples/analyse.md).

### 2.4 Documentation Report

Present the user with a report listing:
- Which docs were updated and what changed
- MkDocs links (at the project's docs-server address — see [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)) to every updated section
- Any remaining coverage gaps (if structural changes are needed but not yet approved)

**Ask user to review the docs and confirm correctness before proceeding to Phase 3.**

## Phase 3: Architecture & Code Quality Assessment

Once docs are approved, perform a deep analysis of the system's implementation. Answer each question with specific evidence (file paths, line numbers, code snippets).

### 3.1 Architecture Cleanliness

- Is the architecture clean and consistent?
- Does the system follow the project's layered architecture (resolve the layer model from the system-overview doc — [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy))?
- Are responsibilities clearly separated between layers?

### 3.2 Redundancy

- Are there duplicate implementations of the same logic?
- Are there multiple code paths that do the same thing?
- Are there unused functions or dead code?

### 3.3 Consistency

- Do all functions in the system follow the same patterns and conventions?
- Are error handling, logging, and return values consistent?
- Do similar operations use similar approaches?

### 3.4 Workarounds

- Are there `time.sleep()` calls that mask timing issues?
- Are there `try/except` blocks that silently swallow errors?
- Are there TODO/FIXME/HACK comments?
- Are there temporary fixes that became permanent?

### 3.5 Bugs & Safety

- Are there uncovered edge cases (empty inputs, boundary values, overflow)?
- Are there unsafe memory operations (buffer overflows, use-after-free, race conditions)?
- Are there thread safety issues (missing locks, lock ordering)?
- Are there resource leaks (GPU memory, file handles, threads)?

### 3.6 Performance

- Are there visible inefficiencies (unnecessary copies, redundant computations)?
- Are GPU transfers minimized and batched appropriately?
- Are there blocking operations on hot paths?
- Is the memory layout cache-friendly?

### 3.7 Modularity

- Is the code concentrated in dedicated modules, or scattered across files?
- Is there a god object that does too much?
- Are internal details properly encapsulated?
- Could any logic be extracted into reusable utilities?

### 3.8 Parameterization

- Are all configurable values parameterized with a single source of truth?
- Are there magic numbers in the code?
- Are there duplicate constant definitions across files?
- Are default values consistent between layers (e.g. Python and C++)?

### 3.9 Naming

- Is naming consistent across layers (e.g. Python ↔ C++ ↔ Frontend)?
- Are abbreviations used consistently?
- Do names accurately describe what they represent?

## Phase 4: Status Report & Improvement Proposal

### 4.1 System Description

Open the report with a concise overview of the system:

```
## [System Name] — Analysis Report

### System Description
**Purpose:** What the system does and why it exists (1-2 sentences).

**Use cases:**
- [Primary use case 1]
- [Primary use case 2]

**Performance criteria:**
| Criterion | Target | Rationale |
|-----------|--------|-----------|
| Latency | ... | ... |
| Throughput | ... | ... |
| Memory | ... | ... |
```

Derive purpose and use cases from the documentation and code. Derive performance criteria from the system's role in the project's runtime (e.g., for a real-time pipeline: must complete within one processing cycle, must not block the latency-critical thread, must fit within the compute/memory budget).

### 4.2 Health Summary

```
### Health Summary
| Aspect | Rating | Notes |
|--------|--------|-------|
| Documentation | Good/Fair/Poor | ... |
| Architecture | Good/Fair/Poor | ... |
| Code Quality | Good/Fair/Poor | ... |
| Test Coverage | Good/Fair/Poor | ... |
| Performance | Good/Fair/Poor | ... |
```

### 4.3 Findings

Categorized list of all findings from Phase 3, with severity: Critical/Major/Minor/Info.

### 4.4 Documentation Updates Made

List with MkDocs links to every updated section.

### 4.5 Improvement Proposal

For each finding rated Major or Critical, propose a concrete fix:

```
### Proposed Improvements

| # | Finding | Severity | Proposed Fix | Effort |
|---|---------|----------|-------------|--------|
| 1 | ... | Critical | ... | S/M/L |
| 2 | ... | Major | ... | S/M/L |
```

Effort scale: S = hours, M = 1-2 days, L = 3+ days

### 4.6 Test Proposal

Assess existing test coverage for the system and propose updates:

```
### Test Coverage & Proposal

**Existing tests:** [List tests that cover this system, with file paths]

**Coverage gaps:**
| Gap | Risk | Proposed Test | Type |
|-----|------|--------------|------|
| [Untested scenario] | [What could go wrong] | [Test description] | unit/integration/system |

**Proposed test updates:**
- [New tests to write, with rationale]
- [Existing tests to extend or modify]
```

Test types follow the project's test convention (resolve the tiers + locations from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths) / the development/testing doc) — typically a pure-logic tier, a compute/integration tier, and a full-stack/system tier.

**Ask user which improvements and tests to implement.** If they select any, invoke `/dev` for each.

## Key Paths

Repo roots, the docs tree, and the docs-server URL are project facts — resolve them from the active
project's [`PROJECT_CONFIG.md` → Key Paths](../../docs/PROJECT_CONFIG.md#key-paths).

## Example Usage

```
/analyse excitation system
/analyse playback engine
/analyse parameter routing
/analyse deck coupling
/analyse memory management
```
