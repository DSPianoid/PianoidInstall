---
name: review
description: Code review at three levels — local (function/fix), module (post-refactor), system (periodic audit). Checks against the project's code-quality principles.
user-invocable: true
tier: generic
argument-hint: <level> [scope] — e.g. "local <file>", "module <module-name>", "system"
---

# Code Review

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the layer/server model, the module→path map, the persistence/dead-code grep paths, and the terminology synonym pairs — live in [`.claude/skill-examples/review.md`](../skill-examples/review.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Three-level code review skill that checks code against the project's quality principles (`docs/development/CODE_QUALITY.md`). Each level has different scope, depth, and use case.

**This skill is read-only.** It produces a review report with findings and recommendations. It does NOT edit code. Fixes are implemented via `/dev` after the review is accepted.

**Primary architectural principles — dominate all other checks:**
- **P1 Separation of Authority** — every piece of state has exactly one owner (the writer). Multi-writer state, silent fallbacks, defaults masking drift, and stale-copy propagation are all P1 violations.
- **P2 Separation of Concern** — every module/class/function has one job. Grab-bag managers, cross-layer leaks, and concern bleed are P2 violations.

These two principles anchor the review rubric. File-size red flags (C4), patch/workaround hunting (S5), authority/concern audits — all derive from P1 + P2.

## Arguments

Parse `$ARGUMENTS`:
- `local <file_or_diff>` — review a specific file, function, or recent change
- `module <module_name>` — review a module and its interfaces after significant changes
- `system` — full system-wide audit (periodic)

If no level is specified, infer from context:
- If a recent commit or diff is mentioned → `local`
- If a module name is mentioned → `module`
- If "full", "everything", or "audit" is mentioned → `system`

---

## Step 0: Load Quality Principles

**Always start here.** Read `docs/development/CODE_QUALITY.md` to load the project's quality principles. These are the criteria for every finding. Pay particular attention to the two Primary Principles (P1 Authority, P2 Concern) — they dominate the severity matrix.

Also read `docs/index.md` to understand the module map and layer boundaries, and the "Current Known God Objects" baseline at the bottom of CODE_QUALITY.md so new entries can be flagged as regressions.

---

## Step 1: God-Object and File-Size Check (RUN BEFORE LINE-BY-LINE REVIEW)

Run a line-count pass on every file in the review scope:

```bash
wc -l <files_in_scope>
```

Apply the C4 thresholds from CODE_QUALITY.md:
- **`> 1000 LOC` → RED flag.** Automatic **High**-severity finding: "God-object risk — file exceeds 1000 LOC." If the change being reviewed grows a file across the 1000 threshold, escalate to **Critical** and require a split plan before approval.
- **`500–1000 LOC` → YELLOW flag.** Automatic **Medium**-severity finding. The change is allowed to land but the file must be named in the review output with a note "Watch — approaching god-object threshold."
- **New RED file introduced by this change** → automatic Critical. No new >1000-line files should ship.
- **Cross-reference "Current Known God Objects" in CODE_QUALITY.md.** An existing RED file that grows further is a regression (High). Reducing a RED file toward the threshold is a win — note it.

**Required output section (every review, every level):**
```markdown
### Top 5 Files in Scope by LOC
| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | ... | 2952 | RED |
```

---

## Step 2: First-Pass Architectural Consistency

Before line-by-line review, audit the change at the architectural level. Answer four questions:

**2.1 Layer Audit.** Which of the project's architectural layers (resolve the layer model from the active project's [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) system-overview doc) does the change belong to? Does it stay within that layer's responsibility, or does it leak? (E.g. frontend business logic, backend UI concerns, a domain-model module making HTTP calls.)

**2.2 Server Audit.** For multi-server projects: does the change land on the correct backend server, and are the cross-server import rules respected? The project's server topology (which ports run which server, and the import-isolation rules between them) is a project fact — resolve it from the active project's [`PROJECT_CONFIG.md` → Ports](../../docs/PROJECT_CONFIG.md#ports) and the system-overview doc ([`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)). (A route owned by one server must not import the other server's module; each server keeps its own import surface.) Mark N/A if the project is single-server.

**2.3 Authority Audit (P1).** List every piece of state touched by the change. For each: who is the owner (sole writer)? Does this change make a non-owner write it? Does it add a silent default that masks drift from the true owner?

**2.4 Concern Audit (P2).** For each module modified: what is its single concern (one-sentence)? Does this change add a second concern or widen the existing one? A module name like "manager" / "handler" / "helpers" that's doing three unrelated things is a P2 violation.

**Required output sections (every review):**
```markdown
### Architectural Consistency
Layer audit: <PASS | VIOLATION — describe>
Server audit: <PASS | VIOLATION — describe | N/A>

### Authority Violations (P1)
| # | State | Owner | Violating Writer | Severity |
|---|-------|-------|------------------|----------|
(empty table if none)

### Concern Violations (P2)
| # | Module | Stated Concern | Concern Added/Widened | Severity |
|---|--------|---------------|----------------------|----------|
(empty table if none)
```

---

## Step 3: Patch / Workaround / Dead-Code Hunt (S5)

Actively hunt for quick fixes and smell patterns. Run the following grep passes across the review scope:

**3.1 TODO/FIXME/HACK markers.** Count and list each. TODO rot is a High-severity finding if the same marker has existed across multiple sessions.
```bash
grep -rn -E "TODO|FIXME|HACK|XXX" --include="*.py" --include="*.js" --include="*.jsx" --include="*.cu" --include="*.cpp" <scope>
```

**3.2 Silent exception handlers.**
```bash
grep -rn -B1 -A3 -E "except\s*:|except\s+Exception\s*:" --include="*.py" <scope>
grep -rn -A2 "catch\s*\(\s*\)\s*{" --include="*.js" --include="*.jsx" <scope>
```
Each `try: ... except: pass` or empty JS `catch { }` is an S5 finding. High if it masks a real error path; Medium otherwise.

**3.3 Fallback-masks-error.** Read for patterns like "if this fails, use the default" or "return null on error and continue." Every one of these must be justified — a fallback that hides a bug is an S5 violation.

**3.4 Legacy/migration shims left in place.** Search for `legacy`, `deprecated`, `old_`, `_old`, `compat`, `backup_`, `TODO: remove after` comments. A migration that completed should have its shim removed; leaving it is technical debt.

**3.5 Sleep-based synchronization.**
```bash
grep -rn -E "time\.sleep\(|setTimeout\(" --include="*.py" --include="*.js" --include="*.jsx" <scope>
```
Distinguish UI pacing (OK) from race workarounds (not OK — use events/signals).

**3.6 Compatibility code for removed features.** If the codebase recently removed feature X, grep for references to X — leftover branches/conditions that were "just in case" are S5 violations.

**Required output section:**
```markdown
### Patch / Workaround Findings
TODO/FIXME/HACK count in scope: <N> (list in Appendix if > 5)
Other patch/workaround findings:
| # | Category | File:Line | Severity | Description |
|---|----------|-----------|----------|-------------|
```

---

## Severity Matrix (applies to every finding)

| Severity | Triggers |
|----------|----------|
| **Critical** | Cross-server authority leak (P1); new file introduced above 1000 LOC (C4); existing feature broken by the change; frontend-visible regression |
| **High** | Landing in a RED (>1000 LOC) file without a split plan; multi-owner state introduced (P1); concern bleed into an unrelated module (P2); silent exception handler that masks a real error path; TODO rot across sessions; persistence without load path (A2) or load without persistence (A1) |
| **Medium** | YELLOW file growth (500–1000 LOC); fallback that could hide a bug but isn't proven to (S5); duplicated logic at 3+ sites without extraction (S3); naming drift (N1); legacy shim still in place after migration completed |
| **Low** | Unused import; single-site cosmetic inconsistency; comment mismatch; localized naming nit |

A review with **any Critical or High finding** cannot approve the change until addressed or explicitly waived by the user with a follow-up task logged.

---

## Required Output Sections (every review, every level)

Every review report, regardless of level, must include ALL of the following sections — in this order — before any level-specific findings:

1. **Top 5 Files in Scope by LOC** (with RED/YELLOW flags)
2. **Architectural Consistency** (layer + server audits)
3. **Authority Violations (P1)** — table or "None"
4. **Concern Violations (P2)** — table or "None"
5. **Patch / Workaround Findings** (TODO count + other patterns)
6. **Level-specific findings** (per Level 1/2/3 below)

A review missing any of these sections is incomplete and must be re-run.

---

## Level 1: Local Review

**When to use:** After implementing a function, fixing a bug, or making a localized change. Quick check before committing.

**Scope:** The changed files and their immediate context (imports, callers, callees).

### Input

Determine what to review:
- If a file path is given: read that file
- If "last commit" or similar: `git diff HEAD~1` or `git diff --cached`
- If a function name: find and read it
- If no specific target: `git diff` for uncommitted changes across all repos

### Checks

For each changed file/function, evaluate:

**3.1 Lean Code**
- [ ] Every new function/variable/endpoint has an active consumer
- [ ] No commented-out code, no "TODO: remove later"
- [ ] No speculative features beyond what the task requires

**3.2 No Redundancy**
- [ ] The new code doesn't duplicate existing functionality (grep for similar patterns)
- [ ] No new storage file that overlaps with an existing one

**3.3 No Code Duplication**
- [ ] Shared logic is extracted if used 3+ times
- [ ] But no premature abstraction for one-time use

**2.1 Single Source of Truth**
- [ ] New state/config has exactly ONE authoritative location
- [ ] No new frontend state that duplicates backend state

**2.2 Explicit Persistence**
- [ ] If the user would expect this setting to survive a restart, it's persisted
- [ ] Persistence has both a save path and a load path

**2.4 No Silent Defaults**
- [ ] Any new default values match across frontend and backend
- [ ] Defaults are defined in one place, not duplicated

**4.1-4.2 Naming**
- [ ] Follows naming conventions (snake_case Python, camelCase JS, PascalCase components/classes)
- [ ] Domain terms match the project's terminology table (the canonical term list — see the project's CODE_QUALITY.md / data-model facts)
- [ ] No new synonyms for existing terms

**1.2-1.3 Layer Boundaries**
- [ ] Frontend code doesn't contain business logic
- [ ] Backend code doesn't contain UI concerns
- [ ] The correct server owns the new functionality (resolve the server topology from [`PROJECT_CONFIG.md#ports`](../../docs/PROJECT_CONFIG.md#ports); N/A if single-server)

**5.1-5.2 Real-Time (if touching engine/audio/latency-critical path)**
- [ ] No blocking calls on the latency-critical thread
- [ ] Compute-budget impact assessed

### Output

```markdown
## Local Review: <file/function>

### Findings
| # | Principle | Severity | Description |
|---|-----------|----------|-------------|
| 1 | 2.1 | High | ... |

### Summary
<pass/fail> — <N> findings (<high/medium/low breakdown>)
```

If no findings: `Pass — no issues found.`

---

## Level 2: Module Review

**When to use:** After significant refactoring, adding a new subsystem, or when a module has accumulated many incremental changes. Checks the module internally AND its interfaces with other modules.

**Scope:** All files in the module + all files that import from or interface with the module.

### Input

Identify the module and its files + consumers. The concrete module→path mapping is a project fact — resolve module locations from the active project's [`PROJECT_CONFIG.md` → Repos](../../docs/PROJECT_CONFIG.md#repos) and [→ Key Paths](../../docs/PROJECT_CONFIG.md#key-paths), and find the module's callers by searching the codebase. A module review covers the module's own directory plus every file that imports from it or interfaces with it (a backend module + its frontend hook/component, a backend module + its callers, a native/compiled module + its bindings + middleware callers, the domain model + its consumers, the frontend tree, or any other module the user names). Concrete project module→path examples live in the [worked-examples companion](../skill-examples/review.md).

### Phase 1: Internal Consistency

Read all files in the module. Check:

**1.4 Modularity**
- [ ] Clear separation between orchestrator (stateful) and computation (stateless)
- [ ] No computation module holds its own state
- [ ] Module has a defined public interface (what it exports vs internal helpers)

**3.4 Stateless Where Possible**
- [ ] State is concentrated in the orchestrator, not scattered across helpers
- [ ] Pure functions are actually pure (no hidden side effects, no global state)

**4.3 Structural Consistency**
- [ ] All endpoints follow the same pattern (validate → process → respond)
- [ ] All hooks follow the same pattern (state → callbacks → effects → return)
- [ ] File organization matches functional hierarchy

**4.4 Directory Structure**
- [ ] Files are in the correct directory for their function
- [ ] No misplaced files that belong in a different module

**3.1 Lean Code**
- [ ] No dead endpoints, unused functions, orphaned state
- [ ] No legacy code paths that are no longer reachable

**2.1-2.5 State Management (for stateful modules)**
- [ ] Every piece of state has one owner
- [ ] All persistent state has save + load paths
- [ ] Round-trip consistency: save → reload → identical
- [ ] No auto-submit or debounce races
- [ ] Defaults are consistent

### Phase 2: Interface Consistency

Find all callers/consumers of the module. Check:

**1.1 Layer Boundaries**
- [ ] The module's interface matches its documented API
- [ ] No caller reaches into the module's internals (private methods, internal state)
- [ ] Data flows in the documented direction

**1.3 Separation of Authority**
- [ ] The module owns what it should own — no authority leaks to callers
- [ ] No caller maintains a redundant copy of the module's state

**4.2 Terminology**
- [ ] Term names are consistent across the module boundary (same field names in request/response/state)
- [ ] No silent type coercions at the boundary (string vs int keys, etc.)

**5.5 Thread Management (if applicable)**
- [ ] Thread interactions are documented and correct
- [ ] Lock ordering is consistent
- [ ] No new threads introduced without documentation

### Phase 3: Recent Changes Impact

```bash
# Check what changed recently in this module
git log --oneline -20 -- <module_path>
git diff main..HEAD -- <module_path>  # or <integration-branch>..HEAD
```

- [ ] Recent changes don't contradict each other
- [ ] No incremental fix that partially reverts a previous fix
- [ ] All changes follow the same architectural direction

### Output

```markdown
## Module Review: <module_name>

### Internal Consistency
| # | Principle | Severity | File:Line | Description |
|---|-----------|----------|-----------|-------------|
| 1 | 1.4 | Medium | <file>:<line> | ... |

### Interface Issues
| # | Principle | Severity | Boundary | Description |
|---|-----------|----------|----------|-------------|
| 1 | 1.1 | High | frontend→backend | ... |

### Recent Changes Assessment
<coherent/contradictory> — <summary>

### Recommendations
1. ...
2. ...

### Summary
<N> internal findings, <M> interface findings. Overall: <healthy/needs attention/needs refactor>
```

---

## Level 3: System Review

**When to use:** Periodic audit (monthly or after a major development sprint). Checks the entire system's architectural health.

**Scope:** All repos, all layers, all interfaces (resolve the repo + layer set from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos) and the system-overview doc).

### Phase 1: Architecture Health

Read the architecture docs (resolve the set from the active project's [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) — the system-overview, data-flows, and build-system docs).

Then verify against code:

**1.1-1.3 Architecture Compliance**
- [ ] Each layer stays within its responsibility
- [ ] No new cross-layer dependencies that bypass defined interfaces
- [ ] Authority table in CODE_QUALITY.md still accurate
- [ ] All backend servers maintain clean separation (resolve the server set from [`#ports`](../../docs/PROJECT_CONFIG.md#ports))

**1.4 Modularity**
- [ ] Module list in CODE_QUALITY.md is current
- [ ] No new modules that are undocumented
- [ ] Orchestrator/computation separation maintained

### Phase 2: State Management Audit

For each backend server, inventory all persistent state (resolve the server paths from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths); substitute the project's server module dir for `<server-module-dir>` below — the concrete paths are in the [worked-examples companion](../skill-examples/review.md)):

```bash
# Find all files written to disk by each server
grep -rn "open(" --include="*.py" <server-module-dir> | grep "'w'"
grep -rn "json.dump\|np.save\|pickle" --include="*.py" <server-module-dir>
```

- [ ] Every persistent value has a corresponding load path
- [ ] No orphaned persistence files (written but never read)
- [ ] No redundant files storing the same data
- [ ] Frontend state is derived from backend, not authoritative

### Phase 3: Naming and Consistency Audit

```bash
# Check for terminology violations (substitute the project's known synonym pairs for <wrong-term>/<synonym>)
grep -rn "<wrong-term>\|<synonym>" --include="*.py" --include="*.js" --include="*.jsx"
# Check for naming convention violations (sample — adjust patterns as needed)
grep -rn "def [A-Z]" --include="*.py"  # PascalCase function names in Python
```

- [ ] No terminology synonyms across layers
- [ ] Naming conventions followed (spot-check each layer)
- [ ] API endpoint naming consistent

### Phase 4: Thread and Process Safety

- [ ] Thread table in CODE_QUALITY.md is current
- [ ] No new threads without documentation
- [ ] The engine/compute lock usage is consistent (every native/bindings call inside the lock)
- [ ] No shared mutable state between separate backend servers
- [ ] The latency-critical (e.g. audio-callback) thread path is lock-free

### Phase 5: Dead Code and Technical Debt

```bash
# Find potentially dead endpoints — substitute the project's server module dir + route decorator (worked-examples companion)
grep -rn "@.*route" --include="*.py" <server-module-dir>
# Cross-reference with frontend API calls — substitute the project's frontend source dir
grep -rn "axios\.\|fetch(" --include="*.js" --include="*.jsx" <frontend-source-dir>
```

- [ ] Every endpoint has at least one frontend caller
- [ ] No unused imports, unreachable functions, orphaned components
- [ ] No legacy compatibility code that's no longer needed

### Phase 6: Documentation Accuracy

- [ ] `docs/index.md` module map matches actual codebase
- [ ] The system-overview doc matches current architecture
- [ ] `docs/development/CODE_QUALITY.md` entity lists are current
- [ ] `docs/development/WORK_IN_PROGRESS.md` has no stale entries
- [ ] API documentation matches actual endpoints

### Output

```markdown
## System Review — <date>

### Architecture Health
<healthy/degraded/needs restructuring>
<summary of cross-cutting concerns>

### State Management
| Server | Persistent Items | Load Paths | Gaps |
|--------|-----------------|------------|------|
| <server-a> | N | N | ... |
| <server-b> | N | N | ... |

### Naming & Consistency
<N> violations found: <summary>

### Thread Safety
<pass/issues found>

### Dead Code & Debt
<N> dead items found: <summary>

### Documentation
<N> stale references: <summary>

### Priority Actions
1. [Critical] ...
2. [High] ...
3. [Medium] ...

### Overall Health Score
Architecture: <1-5>/5
State Management: <1-5>/5
Consistency: <1-5>/5
Performance Safety: <1-5>/5
Documentation: <1-5>/5
```

---

## Severity Definitions

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Breaks functionality, loses data, or violates real-time constraints | Fix before next commit |
| **High** | Violates core principle (single source of truth, layer boundary, persistence) | Fix in current sprint |
| **Medium** | Inconsistency, naming violation, missing test | Fix when touching the file |
| **Low** | Style preference, minor optimization, documentation gap | Track, fix opportunistically |

## Confidence Scoring

For each finding, assess confidence (0-100):
- **80-100:** Verified issue — confirmed by reading code, tracing data flow, or testing
- **50-79:** Likely issue — pattern matches a known problem but not fully verified
- **Below 50:** Possible issue — suppress from report (avoid false positives)

Only report findings with confidence ≥ 50. Mark 50-79 findings as "likely" to distinguish from verified ones.
