# Documentation Cleanup Plan - November 2025

**Date:** November 8, 2025
**Purpose:** Consolidate and organize documentation after major refactoring phases
**Total Files Analyzed:** 30 root-level markdown files (20,519 lines total)

---

## Executive Summary

The PianoidCore project has accumulated extensive documentation (~20,500 lines) across completed refactoring phases. This plan identifies:

- **7 files to DELETE** (obsolete/superseded) - ~3,800 lines
- **13 files to ARCHIVE** (completed work) - ~7,600 lines
- **10 files to KEEP** (active/reference) - ~9,100 lines

**Result:** Cleaner root directory with only active documentation, organized historical archive

---

## Analysis Results

### Current State

```
Root Directory: 30 markdown files
├── Active Documentation: 10 files (~9,100 lines)
├── Completed/Historical: 13 files (~7,600 lines) → MOVE to docs/historical/
└── Obsolete/Superseded: 7 files (~3,800 lines) → DELETE or CONSOLIDATE
```

### Archive Structure (docs/historical/)
```
docs/historical/
├── bug-fixes/         (6 files) - SDL3, offline crashes, driver issues
├── parameter-system/  (6 files) - Parameter refactoring history
├── planning/          (8 files) - Implementation plans
├── status-reports/    (10 files) - Progress summaries
└── technical-notes/   (1 file) - Kernel limits
```

---

## Categorization

### ✅ KEEP - Active Documentation (10 files, ~9,100 lines)

These are actively maintained reference documents:

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| **README.md** | 189 | Project overview | ✅ Active |
| **PIANOID_CORE_DOCUMENTATION.md** | 3,831 | Main app documentation | ✅ Active |
| **PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md** | 1,109 | Parameter system reference | ✅ Active |
| **DOCUMENTATION_INDEX.md** | 422 | Master documentation index | ✅ Active |
| **PLAYBACK_REFACTORING_PLAN.md** | 919 | Current roadmap (Phase 1-6) | 🟡 Active/Planning |
| **PROFILING_EXTRACTION_PLAN.md** | 1,521 | Future work plan | 🟡 Active/Planning |
| **AUDIO_DRIVER_ARCHITECTURE.md** | 557 | Reference architecture | ✅ Active |
| **SDL3_BUILD_INSTRUCTIONS.md** | 310 | Build reference | ✅ Active |
| **SDL3_USAGE_GUIDE.md** | 321 | Usage reference | ✅ Active |
| **CHART_API_DOCUMENTATION.md** | 927 | API reference | ✅ Active |

**Total:** 10,106 lines

**Actions:**
- Keep in root directory
- Update DOCUMENTATION_INDEX.md to reflect cleanup
- Mark PLAYBACK_REFACTORING_PLAN.md and PROFILING_EXTRACTION_PLAN.md as "Current Work"

---

### 📦 ARCHIVE - Completed Work (13 files, ~7,600 lines)

Move to `docs/historical/status-reports/`:

| File | Lines | Category | Reason |
|------|-------|----------|--------|
| **CUDA_CLEANUP_FINAL_SUMMARY.md** | 462 | CUDA Cleanup | ✅ Phase 6 complete (Oct 29) |
| **CUDA_CLEANUP_SUMMARY.md** | 396 | CUDA Cleanup | ✅ Phase 6 complete (merged) |
| **EXCITATION_REFACTORING_SUMMARY.md** | 515 | Excitation | ✅ Phase 0 complete (merged) |
| **LIFECYCLE_REFACTORING_SUMMARY.md** | 426 | Lifecycle | ✅ Complete (Oct 23) |
| **MIDI_PROCESSING_REFACTORING_SUMMARY.md** | 462 | MIDI | ✅ Complete (Oct 23) |
| **MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md** | 563 | Mode Excitation | ✅ Complete (Oct 24) |
| **PLAYBACK_STATUS_SUMMARY.md** | 550 | Playback | ✅ Phase E complete (v3.0) |
| **LEGACY_ONLINE_PLAYBACK_DEPRECATION.md** | 236 | Playback | ✅ Legacy removed (v3.0) |
| **WRAPPER_ANALYSIS.md** | 344 | Analysis | ✅ Complete (wrappers kept) |
| **CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md** | 499 | Bug Fix | ✅ Complete (Oct 11) - Historical |
| **CRASH_ANALYSIS_DETAILED_FLOW.md** | 593 | Bug Fix | ✅ Complete - Historical |
| **FIR_FILTER_INTEGRATION.md** | 501 | FIR Filter | ✅ Complete - Historical |
| **OFFLINE_MIDI_CHART_USAGE.md** | 380 | Testing | ⚠️ May still be useful as reference |

**Total:** ~6,927 lines (excluding OFFLINE_MIDI_CHART_USAGE.md)

**Actions:**
```bash
# Move to historical archive
mv CUDA_CLEANUP_FINAL_SUMMARY.md docs/historical/status-reports/
mv CUDA_CLEANUP_SUMMARY.md docs/historical/status-reports/
mv EXCITATION_REFACTORING_SUMMARY.md docs/historical/status-reports/
mv LIFECYCLE_REFACTORING_SUMMARY.md docs/historical/status-reports/
mv MIDI_PROCESSING_REFACTORING_SUMMARY.md docs/historical/status-reports/
mv MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md docs/historical/status-reports/
mv PLAYBACK_STATUS_SUMMARY.md docs/historical/status-reports/
mv LEGACY_ONLINE_PLAYBACK_DEPRECATION.md docs/historical/status-reports/
mv WRAPPER_ANALYSIS.md docs/historical/status-reports/
mv CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md docs/historical/bug-fixes/
mv CRASH_ANALYSIS_DETAILED_FLOW.md docs/historical/bug-fixes/
mv FIR_FILTER_INTEGRATION.md docs/historical/status-reports/

# Optional: Keep as reference in root or move to tests/
# OFFLINE_MIDI_CHART_USAGE.md - Decision needed
```

---

### ❌ DELETE or CONSOLIDATE - Obsolete (7 files, ~3,800 lines)

These files are superseded by other documentation or no longer relevant:

| File | Lines | Status | Replacement/Reason |
|------|-------|--------|-------------------|
| **CUDA_CORE_CLEANUP_PLAN.md** | 529 | Superseded | Completed → CUDA_CLEANUP_FINAL_SUMMARY.md |
| **PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md** | 1,097 | Superseded | Phase E complete → PLAYBACK_STATUS_SUMMARY.md |
| **PIANOID_MODULARIZATION_PROPOSAL.md** | 961 | Proposal Only | Not implemented yet - archive or delete |
| **RUNTIME_AUDIO_DRIVER_SELECTION.md** | 347 | Redundant | Covered in AUDIO_DRIVER_ARCHITECTURE.md |
| **AUDIO_TYPE_SYSTEM.md** | 181 | Redundant | Covered in SDL3_USAGE_GUIDE.md |
| **CUDA_LAUNCH_MACROS_EXPLAINED.md** | 554 | Reference | Move to docs/technical-notes/ or delete |
| **PROFILING_GUIDE.md** | 817 | Partial | Merge into PROFILING_EXTRACTION_PLAN.md or keep as reference |

**Total:** ~4,486 lines

**Decision Matrix:**

1. **CUDA_CORE_CLEANUP_PLAN.md**
   - Action: **DELETE** (work complete, final summary exists)

2. **PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md**
   - Action: **ARCHIVE** to `docs/historical/planning/` (useful context for Phase E)

3. **PIANOID_MODULARIZATION_PROPOSAL.md**
   - Action: **ARCHIVE** to `docs/historical/planning/` (may inform future work)

4. **RUNTIME_AUDIO_DRIVER_SELECTION.md**
   - Action: **DELETE** (content merged into AUDIO_DRIVER_ARCHITECTURE.md)

5. **AUDIO_TYPE_SYSTEM.md**
   - Action: **DELETE** (covered in SDL3_USAGE_GUIDE.md)

6. **CUDA_LAUNCH_MACROS_EXPLAINED.md**
   - Action: **MOVE** to `docs/technical-notes/` (useful reference)

7. **PROFILING_GUIDE.md**
   - Action: **KEEP** (useful reference, complements PROFILING_EXTRACTION_PLAN.md)

---

## Special Cases

### OFFLINE_MIDI_CHART_USAGE.md (380 lines)

**Status:** Unclear - appears to be testing documentation

**Options:**
1. Keep in root as reference (if actively used for testing)
2. Move to `docs/testing/` (create new directory)
3. Move to `docs/historical/status-reports/`

**Recommendation:** Check recent usage. If used in last month, keep in root or create `docs/testing/`. Otherwise archive.

### PROFILING_EXTRACTION_PLAN.md (1,521 lines)

**Status:** Future work plan

**Current location:** Root (correct - active planning)

**Note:** This is the NEXT planned work after playback refactoring completes

---

## Implementation Plan

### Phase 1: Safety Backup
```bash
# Create backup branch
git checkout -b docs-cleanup-2025-11
git add -A
git commit -m "docs: Checkpoint before documentation cleanup"
```

### Phase 2: Archive Completed Work (Low Risk)

```bash
# Move completed summaries to historical archive
git mv CUDA_CLEANUP_FINAL_SUMMARY.md docs/historical/status-reports/
git mv CUDA_CLEANUP_SUMMARY.md docs/historical/status-reports/
git mv EXCITATION_REFACTORING_SUMMARY.md docs/historical/status-reports/
git mv LIFECYCLE_REFACTORING_SUMMARY.md docs/historical/status-reports/
git mv MIDI_PROCESSING_REFACTORING_SUMMARY.md docs/historical/status-reports/
git mv MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md docs/historical/status-reports/
git mv PLAYBACK_STATUS_SUMMARY.md docs/historical/status-reports/
git mv LEGACY_ONLINE_PLAYBACK_DEPRECATION.md docs/historical/status-reports/
git mv WRAPPER_ANALYSIS.md docs/historical/status-reports/
git mv FIR_FILTER_INTEGRATION.md docs/historical/status-reports/

# Move bug fix docs
git mv CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md docs/historical/bug-fixes/
git mv CRASH_ANALYSIS_DETAILED_FLOW.md docs/historical/bug-fixes/

# Commit archive moves
git commit -m "docs: Archive completed refactoring summaries to historical/"
```

### Phase 3: Move Technical References

```bash
# Create technical-notes directory if needed
mkdir -p docs/technical-notes

# Move technical references
git mv CUDA_LAUNCH_MACROS_EXPLAINED.md docs/technical-notes/

# Commit
git commit -m "docs: Move technical references to docs/technical-notes/"
```

### Phase 4: Archive Planning Documents

```bash
# Move planning documents
git mv PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md docs/historical/planning/
git mv PIANOID_MODULARIZATION_PROPOSAL.md docs/historical/planning/

# Commit
git commit -m "docs: Archive planning documents to historical/planning/"
```

### Phase 5: Delete Redundant/Obsolete Files

```bash
# Delete superseded files
git rm CUDA_CORE_CLEANUP_PLAN.md
git rm RUNTIME_AUDIO_DRIVER_SELECTION.md
git rm AUDIO_TYPE_SYSTEM.md

# Commit
git commit -m "docs: Remove obsolete/redundant documentation files"
```

### Phase 6: Update Master Index

Edit `DOCUMENTATION_INDEX.md`:
- Remove references to deleted files
- Add references to archived files with new paths
- Update status indicators
- Add "Recently Archived" section at top

```bash
git add DOCUMENTATION_INDEX.md
git commit -m "docs: Update DOCUMENTATION_INDEX.md after cleanup"
```

### Phase 7: Update Historical README

Edit `docs/historical/README.md`:
- Add new archived files to appropriate sections
- Update archive statistics

```bash
git add docs/historical/README.md
git commit -m "docs: Update historical/README.md with newly archived files"
```

### Phase 8: Final Review

```bash
# Review all changes
git log --oneline docs-cleanup-2025-11

# Create PR or merge to dev
git checkout dev
git merge docs-cleanup-2025-11
git push origin dev

# Delete cleanup branch
git branch -d docs-cleanup-2025-11
```

---

## Post-Cleanup Structure

### Root Directory (10 files, ~9,100 lines)
```
PianoidCore/
├── README.md                                    (189) - Entry point
├── PIANOID_CORE_DOCUMENTATION.md                (3,831) - Main docs
├── PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md    (1,109) - Parameter ref
├── DOCUMENTATION_INDEX.md                       (422) - Master index
├── PLAYBACK_REFACTORING_PLAN.md                 (919) - Current work
├── PROFILING_EXTRACTION_PLAN.md                 (1,521) - Future work
├── PROFILING_GUIDE.md                           (817) - Profiling ref
├── AUDIO_DRIVER_ARCHITECTURE.md                 (557) - Audio ref
├── SDL3_BUILD_INSTRUCTIONS.md                   (310) - Build ref
├── SDL3_USAGE_GUIDE.md                          (321) - SDL3 ref
└── CHART_API_DOCUMENTATION.md                   (927) - API ref
```

### Historical Archive (Expanded)
```
docs/historical/
├── bug-fixes/
│   ├── AUDIO_DRIVER_STOP_BUG.md
│   ├── OFFLINE_PLAYBACK_CRASH_FIX.md
│   ├── OFFLINE_PLAYBACK_DEBUG_SESSION_SUMMARY.md
│   ├── SDL3_ISSUE_SUMMARY.md
│   ├── SDL3_LATENCY_PROBLEM_SUMMARY.md
│   ├── SDL3_LATENCY_SOLUTIONS_ANALYSIS.md
│   ├── CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md ← NEW
│   └── CRASH_ANALYSIS_DETAILED_FLOW.md ← NEW
├── planning/
│   ├── DOCUMENTATION_CLEANUP_PLAN.md
│   ├── DOUBLE_BUFFER_REFACTORING_PLAN.md
│   ├── EXCITATION_FLOW_REFACTORING_PLAN.md
│   ├── GPU_MEMORY_UNIFICATION_PLAN.md
│   ├── PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md
│   ├── PLAYBACK_REFACTORING_PLAN.md
│   ├── SDL3_MIGRATION_PLAN.md
│   ├── UNIVERSAL_PLAYBACK_REFACTORING_PLAN.md
│   ├── PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md ← NEW
│   └── PIANOID_MODULARIZATION_PROPOSAL.md ← NEW
├── status-reports/
│   ├── DOCUMENTATION_CLEANUP_SUMMARY.md
│   ├── DOCUMENTATION_UPDATE_2025-10-16.md
│   ├── GPU_BACKEND_EXTRACTION_STATUS.md
│   ├── IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md
│   ├── PHASE_E_IMPLEMENTATION_SUMMARY.md
│   ├── PHASE_E_REVISED_IMPLEMENTATION.md
│   ├── PLAYBACK_DOCUMENTATION_UPDATE_2025-10-25.md
│   ├── PLAYBACK_PHASE4_STATUS.md
│   ├── PLAYBACK_TESTING_PROGRESS.md
│   ├── SDL3_MIGRATION_STATUS.md
│   ├── CUDA_CLEANUP_FINAL_SUMMARY.md ← NEW
│   ├── CUDA_CLEANUP_SUMMARY.md ← NEW
│   ├── EXCITATION_REFACTORING_SUMMARY.md ← NEW
│   ├── LIFECYCLE_REFACTORING_SUMMARY.md ← NEW
│   ├── MIDI_PROCESSING_REFACTORING_SUMMARY.md ← NEW
│   ├── MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md ← NEW
│   ├── PLAYBACK_STATUS_SUMMARY.md ← NEW
│   ├── LEGACY_ONLINE_PLAYBACK_DEPRECATION.md ← NEW
│   ├── WRAPPER_ANALYSIS.md ← NEW
│   └── FIR_FILTER_INTEGRATION.md ← NEW
├── parameter-system/
│   ├── DOUBLE_BUFFER_REFACTORING_SUMMARY.md
│   ├── PARAMETER_SYSTEM_CODE_REVIEW.md
│   ├── PARAMETER_SYSTEM_COMPREHENSIVE_SUMMARY.md
│   ├── PARAMETER_UPDATE_FLOW_ANALYSIS.md
│   ├── PIANOID_PARAMETER_FLOW_ANALYSIS.md
│   └── README.md
└── technical-notes/
    ├── COOPERATIVE_KERNEL_LIMITS.md
    └── CUDA_LAUNCH_MACROS_EXPLAINED.md ← NEW
```

---

## Benefits

### For Developers
- **Cleaner root directory**: Only 11 active files vs 30
- **Clear documentation hierarchy**: Active vs historical
- **Faster navigation**: Less clutter in root
- **Preserved history**: All work documented in archive

### For New Contributors
- **Clear entry points**: README → DOCUMENTATION_INDEX → specific docs
- **Historical context**: Can review past decisions
- **Reduced confusion**: Obsolete docs removed

### For Maintenance
- **Easier updates**: Fewer files to maintain
- **Clear status**: Active vs archived
- **Better organization**: Logical grouping by purpose

---

## Risks and Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking external links | Medium | Low | Update DOCUMENTATION_INDEX.md with redirects |
| Losing important context | Low | Medium | Archive, don't delete; keep git history |
| Merge conflicts | Low | Low | Work in branch, review before merge |
| Deleting active docs | Very Low | High | Conservative delete list, backup branch |

---

## Success Criteria

- ✅ Root directory has ≤12 markdown files
- ✅ All completed work archived to docs/historical/
- ✅ All obsolete files deleted or archived
- ✅ DOCUMENTATION_INDEX.md updated and accurate
- ✅ docs/historical/README.md reflects new structure
- ✅ No broken internal links
- ✅ Git history preserved for all moves/deletes

---

## Timeline

**Estimated Time:** 1-2 hours

1. **Phase 1-2:** 15 minutes (backup + archive)
2. **Phase 3-4:** 10 minutes (move technical refs + planning)
3. **Phase 5:** 5 minutes (delete obsolete)
4. **Phase 6-7:** 20 minutes (update indices)
5. **Phase 8:** 10 minutes (review + merge)

**Total:** ~60 minutes of focused work

---

## Next Steps

1. Review this plan with team/maintainer
2. Get approval for DELETE list
3. Execute phases 1-8
4. Update this file with execution results
5. Close related GitHub issues (if any)

---

**Document Status:** ✅ Ready for Execution
**Prepared By:** Claude (Sonnet 4.5)
**Date:** November 8, 2025
