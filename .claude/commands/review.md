---
name: review
description: Code review at three levels — local (function/fix), module (post-refactor), system (periodic audit). Checks against CODE_QUALITY.md principles.
user-invocable: true
argument-hint: <level> [scope] — e.g. "local mode_tracking.py", "module modal_adapter", "system"
---

# Pianoid Code Review

Three-level code review skill that checks code against the project's quality principles (`docs/development/CODE_QUALITY.md`). Each level has different scope, depth, and use case.

**This skill is read-only.** It produces a review report with findings and recommendations. It does NOT edit code. Fixes are implemented via `/dev` after the review is accepted.

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

**Always start here.** Read `docs/development/CODE_QUALITY.md` to load the project's quality principles. These are the criteria for every finding.

Also read `docs/index.md` to understand the module map and layer boundaries.

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
- [ ] Domain terms match the terminology table (frequency, damping_ratio, decrement, etc.)
- [ ] No new synonyms for existing terms

**1.2-1.3 Layer Boundaries**
- [ ] Frontend code doesn't contain business logic
- [ ] Backend code doesn't contain UI concerns
- [ ] The correct server owns the new functionality (port 5000 vs 5001)

**5.1-5.2 Real-Time (if touching engine/audio path)**
- [ ] No blocking calls on audio thread
- [ ] GPU budget impact assessed

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

Identify the module:
- `modal_adapter` → `PianoidCore/pianoid_middleware/modal_adapter/` + frontend `useModalAdapter.js` + `ModalAdapter.jsx`
- `parameter_manager` → `PianoidCore/pianoid_middleware/parameter_manager.py` + callers
- `pianoid_cuda` → `PianoidCore/pianoid_cuda/` + pybind11 bindings + middleware callers
- `domain_model` → `PianoidBasic/Pianoid/` + middleware consumers
- `frontend` → `PianoidTunner/src/` (all hooks, components, modules)
- Any other module name: search for it in the codebase

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
git diff main..HEAD -- <module_path>  # or dev..HEAD
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
| 1 | 1.4 | Medium | modal_adapter.py:245 | ... |

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

**Scope:** All 4 repos, all layers, all interfaces.

### Phase 1: Architecture Health

Read the architecture docs:
- `docs/architecture/SYSTEM_OVERVIEW.md`
- `docs/architecture/DATA_FLOWS.md`
- `docs/architecture/BUILD_SYSTEM.md`

Then verify against code:

**1.1-1.3 Architecture Compliance**
- [ ] Each layer stays within its responsibility
- [ ] No new cross-layer dependencies that bypass defined interfaces
- [ ] Authority table in CODE_QUALITY.md still accurate
- [ ] Both backend servers (5000, 5001) maintain clean separation

**1.4 Modularity**
- [ ] Module list in CODE_QUALITY.md is current
- [ ] No new modules that are undocumented
- [ ] Orchestrator/computation separation maintained

### Phase 2: State Management Audit

For each backend server, inventory all persistent state:

```bash
# Find all files written to disk by each server
grep -rn "open(" --include="*.py" PianoidCore/pianoid_middleware/ | grep "'w'"
grep -rn "json.dump\|np.save\|pickle" --include="*.py" PianoidCore/pianoid_middleware/
```

- [ ] Every persistent value has a corresponding load path
- [ ] No orphaned persistence files (written but never read)
- [ ] No redundant files storing the same data
- [ ] Frontend state is derived from backend, not authoritative

### Phase 3: Naming and Consistency Audit

```bash
# Check for terminology violations
grep -rn "dump_ratio\|damp_ratio" --include="*.py" --include="*.js" --include="*.jsx"
# Check for naming convention violations (sample — adjust patterns as needed)
grep -rn "def [A-Z]" --include="*.py"  # PascalCase function names in Python
```

- [ ] No terminology synonyms across layers
- [ ] Naming conventions followed (spot-check each layer)
- [ ] API endpoint naming consistent

### Phase 4: Thread and Process Safety

- [ ] Thread table in CODE_QUALITY.md is current
- [ ] No new threads without documentation
- [ ] `cuda_lock` usage consistent (every pybind11 call inside lock)
- [ ] No shared mutable state between the two backend servers
- [ ] Audio callback thread path is lock-free

### Phase 5: Dead Code and Technical Debt

```bash
# Find potentially dead endpoints
grep -rn "@.*route\|@modal_bp" --include="*.py" PianoidCore/pianoid_middleware/
# Cross-reference with frontend API calls
grep -rn "axios\.\|fetch(" --include="*.js" --include="*.jsx" PianoidTunner/src/
```

- [ ] Every endpoint has at least one frontend caller
- [ ] No unused imports, unreachable functions, orphaned components
- [ ] No legacy compatibility code that's no longer needed

### Phase 6: Documentation Accuracy

- [ ] `docs/index.md` module map matches actual codebase
- [ ] `docs/architecture/SYSTEM_OVERVIEW.md` matches current architecture
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
| Main (5000) | N | N | ... |
| Modal (5001) | N | N | ... |

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
