# Historical Documentation Archive

This directory contains documentation from completed work that has been moved out of the root directory for better organization.

---

## Directory Structure

### planning/
Original planning documents for major refactorings that have been completed.

**Files (12)**:
- `EXCITATION_FLOW_REFACTORING_PLAN.md` - Excitation optimization plan (40x bandwidth improvement achieved)
- `DOUBLE_BUFFER_REFACTORING_PLAN.md` - Double-buffer parameter system plan (completed Phase 0-6C)
- `GPU_MEMORY_UNIFICATION_PLAN.md` - GPU memory management unification plan (Phases 1-3 complete)
- `PLAYBACK_REFACTORING_PLAN.md` - Playback system event-driven architecture plan (Phases 1-5 complete)
- `UNIVERSAL_PLAYBACK_REFACTORING_PLAN.md` - Universal playback primitives plan (completed)
- `SDL3_MIGRATION_PLAN.md` - SDL3 audio driver migration plan (migration complete)
- `PHASE_E_ONLINE_EVENTQUEUE_IMPLEMENTATION_PLAN.md` - Phase E unified EventQueue planning (✅ completed v3.0)
- `DOCUMENTATION_CLEANUP_PLAN.md` - Documentation organization plan (✅ completed Oct 2025)
- `PIANOID_MODULARIZATION_PROPOSAL.md` - Pianoid.cu modularization proposal (future work)
- `PLAYBACK_SYSTEM_COMPREHENSIVE_AUDIT.md` - Playback system complete audit and cleanup plan
- `DOCUMENTATION_CLEANUP_PLAN_2025-11.md` - **NEW** November 2025 documentation cleanup plan (✅ completed)
- `(removed duplicate)`

### status-reports/
Intermediary status reports from multi-phase projects.

**Files (21)**:
- `PLAYBACK_PHASE4_STATUS.md` - Playback Phase 4 middleware integration status
- `PLAYBACK_TESTING_PROGRESS.md` - Playback Phases 1-3 testing report
- `DOCUMENTATION_UPDATE_2025-10-16.md` - Documentation update summary (Oct 16)
- `GPU_BACKEND_EXTRACTION_STATUS.md` - GPU backend extraction status
- `IMPLEMENTATION_SUMMARY_OFFLINE_MIDI_CHART.md` - Offline MIDI chart implementation summary
- `SDL3_MIGRATION_STATUS.md` - SDL3 migration completion report
- `PHASE_E_IMPLEMENTATION_SUMMARY.md` - Phase E complete implementation summary (✅ v3.0)
- `PHASE_E_REVISED_IMPLEMENTATION.md` - Phase E revised approach using existing routes
- `PLAYBACK_DOCUMENTATION_UPDATE_2025-10-25.md` - Playback system comprehensive audit (Oct 25)
- `DOCUMENTATION_CLEANUP_SUMMARY.md` - Documentation cleanup execution summary
- `CUDA_CLEANUP_FINAL_SUMMARY.md` - CUDA Core cleanup final summary (Oct 29, 156 lines removed)
- `CUDA_CLEANUP_SUMMARY.md` - CUDA cleanup phase summary
- `EXCITATION_REFACTORING_SUMMARY.md` - Excitation refactoring summary (40x bandwidth reduction)
- `LIFECYCLE_REFACTORING_SUMMARY.md` - Lifecycle pipeline refactoring (unified 4-method API)
- `MIDI_PROCESSING_REFACTORING_SUMMARY.md` - MIDI processing refactoring (state-aware processing)
- `MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md` - Mode excitation playback implementation
- `PLAYBACK_STATUS_SUMMARY.md` - Playback refactoring current status (Phase E complete v3.0)
- `LEGACY_ONLINE_PLAYBACK_DEPRECATION.md` - Legacy online playback deprecation (removed in v3.0)
- `WRAPPER_ANALYSIS.md` - Wrapper functions analysis (recommendation: keep wrappers)
- `FIR_FILTER_INTEGRATION.md` - FIR filter integration summary
- `DOCUMENTATION_CLEANUP_EXECUTION_SUMMARY.md` - **NEW** November 2025 documentation cleanup execution summary

### bug-fixes/
Documentation of resolved bugs and debug sessions.

**Files (8)**:
- `OFFLINE_PLAYBACK_CRASH_FIX.md` - Fix for offline playback buffer overflow crash
- `OFFLINE_PLAYBACK_DEBUG_SESSION_SUMMARY.md` - Debug session for playback hang at cycle 10
- `AUDIO_DRIVER_STOP_BUG.md` - SDL2 audio driver stop/restart bug (fixed by SDL3 migration)
- `SDL3_ISSUE_SUMMARY.md` - SDL3 early issues summary
- `SDL3_LATENCY_PROBLEM_SUMMARY.md` - SDL3 >1000ms latency problem and solution
- `SDL3_LATENCY_SOLUTIONS_ANALYSIS.md` - Analysis of 6 potential solutions (Solution 1 implemented)
- `CRASH_FIXES_AND_LIVE_PARAMETER_UPDATES.md` - **NEW** Crash fixes and async parameter updates (Oct 11)
- `CRASH_ANALYSIS_DETAILED_FLOW.md` - **NEW** Detailed crash analysis and flow documentation

### technical-notes/
Technical reference documents and implementation notes.

**Files (2)**:
- `COOPERATIVE_KERNEL_LIMITS.md` - Grid sizing fix for cooperative kernels
- `CUDA_LAUNCH_MACROS_EXPLAINED.md` - **NEW** CUDA kernel launch macro reference and patterns

---

## Why These Documents Were Archived

These documents describe **completed work**:
- Planning documents have been superseded by implementation summaries
- Status reports are no longer current (work is complete)
- Bug fixes have been resolved and documented
- Technical notes remain useful but represent resolved issues

**For current documentation**, see:
- Main documentation: [PIANOID_CORE_DOCUMENTATION.md](../../PIANOID_CORE_DOCUMENTATION.md)
- Current status: [README.md](../../README.md)
- Comprehensive technical docs: [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](../../pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md)

---

## Value of Historical Documentation

While no longer current, these documents provide:
- **Context** for architectural decisions
- **Lessons learned** from debugging sessions
- **Evolution** of the system over time
- **Reference** for similar future work

---

**Archive Created**: 2025-10-25
**Last Updated**: 2025-11-08 (Major documentation cleanup and reorganization)
**Total Documents**: 43 files (12 planning + 21 status + 8 bug-fixes + 2 technical-notes)
**Total Size**: ~1.5MB

### Recent Additions (November 8, 2025)

**Phase 1 - Initial cleanup:**
- 12 completed refactoring summaries moved to `status-reports/`
- 2 bug fix documents moved to `bug-fixes/`
- 2 planning documents moved to `planning/`
- 1 technical reference moved to `technical-notes/`

**Phase 2 - Cleanup documentation archived:**
- `DOCUMENTATION_CLEANUP_PLAN_2025-11.md` → `planning/`
- `DOCUMENTATION_CLEANUP_EXECUTION_SUMMARY.md` → `status-reports/`

**Deleted obsolete files (Phase 1)**:
- `CUDA_CORE_CLEANUP_PLAN.md` (superseded by final summary)
- `RUNTIME_AUDIO_DRIVER_SELECTION.md` (merged into AUDIO_DRIVER_ARCHITECTURE.md)
- `AUDIO_TYPE_SYSTEM.md` (covered in SDL3_USAGE_GUIDE.md)

**Organized to new structure**:
- 5 usage guides moved to `docs/guides/` (SDL3, Chart API, Profiling, MIDI testing)

