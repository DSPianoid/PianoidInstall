---
name: analyse
description: Deep analysis of a Pianoid system/module — docs audit, code review, architecture assessment, improvement proposal.
user-invocable: true
argument-hint: <system or module name — e.g. "excitation system", "playback engine", "parameter routing", "deck coupling">
---

# Pianoid System/Module Analysis

Deep-dive analysis workflow: audit documentation, verify against source code, update docs, then assess architecture and code quality. Produces two deliverables: an updated documentation report and an improvement proposal.

**CRITICAL: Documentation-first rule applies throughout.** Always check docs before reading source.

## Arguments

The argument is a system or module name, e.g.:
- `excitation system` — Gaussian excitation pipeline (Python model → GPU kernel)
- `playback engine` — online/offline playback, event dispatch, audio output
- `parameter routing` — REST → Python → CUDA parameter flow
- `deck coupling` — feedin/feedback matrices, string-mode coupling
- `mode simulation` — harmonic oscillator modes
- `string simulation` — FDTD wave equation solver
- `midi system` — MIDI listener, event scheduling
- `chart system` — chart registry, chart functions, actions
- `preset system` — save/load/switch presets
- `memory management` — GPU memory allocation, double-buffer swap
- `audio drivers` — ASIO/SDL3 audio output

Or any other subsystem the user names. Scope the analysis to the named system.

## Phase 1: Documentation Audit

### 1.1 Identify Relevant Docs

Read docs in this order to build context. Stop and note which docs cover the target system:

1. `docs/index.md` — locate the system in the module map
2. `docs/architecture/SYSTEM_OVERVIEW.md` — where the system sits in the 4-layer stack
3. `docs/architecture/DATA_FLOWS.md` — trace the system's data flows
4. Drill into module docs under `docs/modules/`:
   - CUDA engine: `pianoid-cuda/*.md`
   - Middleware: `pianoid-middleware/*.md`
   - Domain model: `pianoid-basic/OVERVIEW.md`
   - Frontend: `pianoid-tunner/OVERVIEW.md`
5. `docs/development/TESTING.md` — test coverage for this system
6. `docs/development/WORK_IN_PROGRESS.md` — active investigations

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

### 2.3 Restart MkDocs

After doc updates, restart the MkDocs dev server so changes are reflected:

```bash
# Kill existing mkdocs process
tasklist | grep -i mkdocs | awk '{print $2}' | xargs -r kill 2>/dev/null
# Start fresh (run in background)
cd D:\repos\PianoidInstall && mkdocs serve -a 0.0.0.0:8001
```

### 2.4 Documentation Report

Present the user with a report listing:
- Which docs were updated and what changed
- MkDocs links (`http://localhost:8001/...`) to every updated section
- Any remaining coverage gaps (if structural changes are needed but not yet approved)

**Ask user to review the docs and confirm correctness before proceeding to Phase 3.**

## Phase 3: Architecture & Code Quality Assessment

Once docs are approved, perform a deep analysis of the system's implementation. Answer each question with specific evidence (file paths, line numbers, code snippets).

### 3.1 Architecture Cleanliness

- Is the architecture clean and consistent?
- Does the system follow the project's layered architecture (Frontend → Middleware → Domain Model → CUDA)?
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
- Are default values consistent between Python and C++?

### 3.9 Naming

- Is naming consistent across layers (Python ↔ C++ ↔ Frontend)?
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

Derive purpose and use cases from the documentation and code. Derive performance criteria from the system's role in the real-time audio pipeline (e.g., must complete within one synthesis cycle, must not block the audio thread, must fit within GPU memory budget).

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

Test types follow the project convention:
- `tests/unit/` — pure Python, no GPU
- `tests/integration/` — GPU, no audio driver
- `tests/system/` — full stack including audio

**Ask user which improvements and tests to implement.** If they select any, invoke `/dev` for each.

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| MkDocs config | `D:\repos\PianoidInstall\mkdocs.yml` |
| MkDocs preview | `http://localhost:8001/` |

## Example Usage

```
/analyse excitation system
/analyse playback engine
/analyse parameter routing
/analyse deck coupling
/analyse memory management
```
