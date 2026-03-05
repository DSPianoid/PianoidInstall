# PianoidCore Documentation Index

**Last Updated:** November 9, 2025 (Parameter system consolidation)

---

## 📚 Main Documentation

### Application-Level Documentation

- **[PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md)** - Complete application documentation
  - REST API reference
  - Middleware architecture
  - Frontend integration guide
  - Deployment and configuration
  - **Status:** ✅ Updated Oct 16, 2025 with Phase 0-5 changes

### Technical Documentation

- **[pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md)** - Deep technical dive
  - CUDA kernel architecture
  - GPU memory management
  - Modal synthesis implementation
  - Performance optimization
  - **Status:** ✅ Updated Oct 16, 2025 with unified memory architecture

### Recent Updates

- **[DOCUMENTATION_UPDATE_2025-10-16.md](DOCUMENTATION_UPDATE_2025-10-16.md)** - Comprehensive update covering all Phase 0-5 changes
  - Complete architectural changes summary
  - API migration guide
  - Performance impact analysis
  - **Recommended reading for understanding recent changes**

---

## 🎯 Current Work & Planning

### Active Refactoring Plans

- **[DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md](DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md)** - 📋 **Ready for Implementation** (Nov 2025)
  - Eliminate redundant feedback matrix (save 256 KB / 512 KB memory)
  - Add `deck_feedback_coefficient` as runtime parameter (following volume system pattern)
  - Dual-mode implementation with compile-time selection (`USE_SINGLE_DECK_MATRIX` flag)
  - REST API: `/set_runtime_parameters {"feedback": 1.5}`
  - MIDI integration: CC 74 (Brightness)
  - **Status:** Planning complete, ready to implement Phase 1

- **[FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md](FEEDIN_FEEDBACK_MATRICES_ANALYSIS.md)** - 📖 **Analysis Complete** (Nov 2025)
  - Deep technical analysis of current feedin/feedback architecture
  - Physical model overview (modal synthesis, bidirectional coupling)
  - Memory layout and CUDA kernel usage documented
  - Bug identified: MainKernel.cu:237 (hardcoded +5)
  - Mathematical foundation and reciprocity principle
  - **Status:** Analysis validates single-coefficient approach

- **[PLAYBACK_REFACTORING_PLAN.md](PLAYBACK_REFACTORING_PLAN.md)** - 📋 **In Progress** (Phases 1-6)
  - 6-phase plan for offline/online playback unification
  - Event system design (PlaybackEvent, EventQueue)
  - Playback engines (OnlinePlaybackEngine, OfflinePlaybackEngine)
  - **Status:** Phase 0 complete (offline rendering works), Phases 1-6 planned

- **[PROFILING_EXTRACTION_PLAN.md](PROFILING_EXTRACTION_PLAN.md)** - 📋 **Next Work**
  - Extract profiling system into PianoidProfiler module
  - Reduce Pianoid.cu complexity
  - Clean profiling API
  - **Status:** Analysis complete, implementation planned

- **[PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md)** - 📖 **Reference**
  - Complete parameter system documentation
  - Current state: Phase 0-6C complete
  - String/physics parameters using granular API
  - Remaining work: Migrate excitation, hammer, mode parameters


---

## 📦 Completed Work (Archived)

> **Note:** Completed refactoring summaries have been moved to `docs/historical/` for better organization.
> See [docs/historical/README.md](docs/historical/README.md) for the complete archive.

### Recent Completions (January 2025)

- **[VOLUME_SYSTEM_REFACTORING_SUMMARY.md](docs/VOLUME_SYSTEM_REFACTORING_SUMMARY.md)** - Volume System Refactoring (Jan 12, 2025)
  - Complete refactoring of volume control system
  - Separation of initialization and runtime parameters
  - New parameter structure API with backward compatibility
  - See [docs/guides/VOLUME_API_GUIDE.md](docs/guides/VOLUME_API_GUIDE.md) for usage guide

### Recent Completions (November 2025)

- **[docs/historical/status-reports/CUDA_CLEANUP_FINAL_SUMMARY.md](docs/historical/status-reports/CUDA_CLEANUP_FINAL_SUMMARY.md)** - CUDA Core Cleanup (Oct 29, 2025)
  - 156 lines removed, code quality improvements
  - Removed obsolete functions and dead code

- **[docs/historical/status-reports/EXCITATION_REFACTORING_SUMMARY.md](docs/historical/status-reports/EXCITATION_REFACTORING_SUMMARY.md)** - Phase 0 Complete
  - GPU-resident excitation parameters
  - 40x bandwidth reduction

- **[docs/historical/status-reports/LIFECYCLE_REFACTORING_SUMMARY.md](docs/historical/status-reports/LIFECYCLE_REFACTORING_SUMMARY.md)** - Lifecycle Pipeline (Oct 23, 2025)
  - Unified 4-method API
  - 5-state machine
  - Fixed GPU initialization error

- **[docs/historical/status-reports/MIDI_PROCESSING_REFACTORING_SUMMARY.md](docs/historical/status-reports/MIDI_PROCESSING_REFACTORING_SUMMARY.md)** - MIDI Processing (Oct 23, 2025)
  - State-aware MIDI command processing
  - Prevents GPU writes when paused

- **[docs/historical/status-reports/MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md](docs/historical/status-reports/MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md)** - Mode Excitation (Oct 24, 2025)
  - Direct soundboard mode excitation
  - Custom MIDI command 0xF1

- **[docs/historical/status-reports/PLAYBACK_STATUS_SUMMARY.md](docs/historical/status-reports/PLAYBACK_STATUS_SUMMARY.md)** - Phase E Complete (v3.0)
  - Unified EventQueue online playback
  - Legacy system removed (546 lines)

- **[docs/historical/status-reports/WRAPPER_ANALYSIS.md](docs/historical/status-reports/WRAPPER_ANALYSIS.md)** - Wrapper Functions Analysis
  - Analyzed and documented wrapper functions
  - Recommendation: keep wrappers

### Historical Planning Documents

All planning documents are archived in [docs/historical/planning/](docs/historical/planning/):
- GPU Memory Unification Plan
- Double Buffer Refactoring Plan
- Phase E Online EventQueue Implementation Plan
- Playback Refactoring Plan (historical version)
- SDL3 Migration Plan
- Universal Playback Refactoring Plan
- Pianoid Modularization Proposal
- Playback System Comprehensive Audit

### Bug Fixes (Archived)

All bug fix documentation in [docs/historical/bug-fixes/](docs/historical/bug-fixes/):
- Crash fixes and live parameter updates
- Crash analysis detailed flow
- Audio driver stop bug
- Offline playback crash fix
- SDL3 latency problems and solutions

---

## 🔧 Reference Documentation

### Parameter System

**📖 PRIMARY REFERENCE:**
- **[PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md)** - **v6.0** - Consolidated parameter system documentation
  - ✅ **Single comprehensive entry point for all parameter system documentation**
  - Four-layer architecture (REST API → Middleware → PianoidBasic → CUDA)
  - Phase 0-6C implementation history and current state
  - GPU memory layout (~180 MB unified under UnifiedGpuMemoryManager)
  - Function inventory with deprecation status
  - Complete REST API to CUDA flow analysis
  - PianoidBasic processing overview
  - Migration roadmap and next steps
  - **Status:** ✅ v6.0 (Nov 9, 2025) - Fully consolidated and current

**COMPANION DOCUMENTATION:**
- **[PIANOIDBASIC_PARAMETER_MANAGEMENT_DOCUMENTATION.md](PIANOIDBASIC_PARAMETER_MANAGEMENT_DOCUMENTATION.md)** - Deep technical dive (3000+ lines)
  - Detailed PianoidBasic Layer 3 processing
  - Complete class hierarchy and API reference
  - Mathematical formulas (finite differences, wave equation, detuning)
  - Parameter validation and state management
  - CUDA data packing specifications
  - Performance characteristics and memory footprint

**HISTORICAL ARCHIVE:**
- **[docs/historical/parameter-system/](docs/historical/parameter-system/)** - Superseded documents
  - Previous versions and analysis documents
  - Code reviews and flow analysis
  - Phase-specific summaries
  - Review history (Nov 9, 2025 verification)

### Audio System

- **[AUDIO_DRIVER_ARCHITECTURE.md](AUDIO_DRIVER_ARCHITECTURE.md)** - Audio driver architecture reference
  - SDL2/SDL3 mutual exclusion architecture
  - Build-time driver selection
  - Driver switching guide

### Usage Guides & API Documentation

> **Location:** All guides are now organized in [docs/guides/](docs/guides/)

- **[docs/guides/SDL3_BUILD_INSTRUCTIONS.md](docs/guides/SDL3_BUILD_INSTRUCTIONS.md)** - SDL3 compilation guide
  - Building SDL3 from source
  - Integration with PianoidCore
  - Troubleshooting

- **[docs/guides/SDL3_USAGE_GUIDE.md](docs/guides/SDL3_USAGE_GUIDE.md)** - SDL3 integration guide
  - Using SDL3 audio driver
  - Configuration and setup
  - Migration from SDL2

- **[docs/guides/CHART_API_DOCUMENTATION.md](docs/guides/CHART_API_DOCUMENTATION.md)** - Chart & Action API reference
  - REST API endpoints
  - Plugin-based chart system
  - Step-by-step guide for adding charts

- **[docs/guides/OFFLINE_MIDI_CHART_USAGE.md](docs/guides/OFFLINE_MIDI_CHART_USAGE.md)** - Offline MIDI playback testing
  - Chart API integration
  - Waveform visualization
  - Performance diagnostics

- **[docs/guides/PROFILING_GUIDE.md](docs/guides/PROFILING_GUIDE.md)** - GPU and CPU profiling guide
  - Profiling tools and techniques
  - Performance measurement
  - Optimization strategies

- **[docs/guides/VOLUME_API_GUIDE.md](docs/guides/VOLUME_API_GUIDE.md)** - Volume parameter system guide
  - New parameter structure API (v2.0)
  - Initialization vs. runtime parameters
  - REST API, Python, C++, and MIDI integration
  - Backward compatibility with legacy API
  - Mathematical reference and troubleshooting

### Technical Notes

- **[docs/technical-notes/CUDA_LAUNCH_MACROS_EXPLAINED.md](docs/technical-notes/CUDA_LAUNCH_MACROS_EXPLAINED.md)** - CUDA launch macro reference
  - Kernel launch patterns
  - Synchronization strategies
  - Performance implications

- **[docs/technical-notes/COOPERATIVE_KERNEL_LIMITS.md](docs/technical-notes/COOPERATIVE_KERNEL_LIMITS.md)** - Kernel optimization constraints

---

## 📖 How to Use This Documentation

### For New Users

**Start here:**
1. [PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md) - Understand the application
2. [REST API section](PIANOID_CORE_DOCUMENTATION.md#3-rest-api-reference) - Learn the endpoints
3. Frontend integration guide - Build your interface

### For Developers

**Start here:**
1. [DOCUMENTATION_UPDATE_2025-10-16.md](DOCUMENTATION_UPDATE_2025-10-16.md) - Catch up on recent changes
2. [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md) - Understand the engine
3. [GPU_MEMORY_UNIFICATION_PLAN.md](GPU_MEMORY_UNIFICATION_PLAN.md) - Current memory architecture

**For extending the API:**
- [CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md) - Add custom charts and actions to the middleware

### For Researchers

**Start here:**
1. [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md) - Modal synthesis theory
2. [PIANOID_PARAMETER_FLOW_ANALYSIS.md](PIANOID_PARAMETER_FLOW_ANALYSIS.md) - Parameter routing
3. [PROFILING_GUIDE.md](PROFILING_GUIDE.md) - Performance measurement

### For Contributors (Future Phase 6)

**When Phase 6 begins:**
1. Read [PARAMETER_REFACTORING_PLAN.md](PARAMETER_REFACTORING_PLAN.md) - Phase 6 overview
2. Follow detailed implementation plan (to be created)
3. Use incremental validation approach

---

## 🗺️ Documentation Roadmap

### Current Status (October 16, 2025)

| Documentation Area | Status | Notes |
|-------------------|--------|-------|
| Application docs | ✅ Complete | Updated with Phase 0-5 |
| Technical docs | ✅ Complete | Updated with unified memory |
| Phase 0-5 refactoring | ✅ Complete | All summaries written |
| API reference | ✅ Complete | REST and C++ APIs documented |
| Chart & Action API | ✅ Complete | Middleware extension guide |
| Phase 6 planning | 📋 Pending | Separated for future work |

### Future Work

**Short-term:**
- Phase 6 implementation guide (when work begins)
- Performance benchmarking results
- Migration guide for external users

**Medium-term:**
- Video tutorials for REST API
- Interactive API explorer
- Preset format specification

**Long-term:**
- Academic paper on modal synthesis implementation
- Case studies from production use
- Community contribution guide

---

## 📝 Documentation Standards

### File Naming Conventions

- **Summaries:** `*_SUMMARY.md` - Completed work documentation
- **Plans:** `*_PLAN.md` - Planning and strategy documents
- **Guides:** `*_GUIDE.md` - How-to and tutorial content
- **References:** `*_REFERENCE.md` - API and technical references
- **Analysis:** `*_ANALYSIS.md` - Deep-dive investigations

### Update Guidelines

**When to update documentation:**
1. After completing any Phase (write summary)
2. When changing APIs (update reference docs)
3. When fixing critical bugs (document in summary)
4. When changing architecture (update technical docs)

**Update checklist:**
- [ ] Update main docs (PIANOID_CORE_DOCUMENTATION.md or COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md)
- [ ] Create/update summary document for the change
- [ ] Update DOCUMENTATION_INDEX.md (this file)
- [ ] Link new documents from related docs
- [ ] Update "Last Updated" dates

---

## 🔗 External Resources

### Official Links

- **GitHub:** (Repository URL if public)
- **Website:** (Project website if exists)
- **Contact:** astrinleonid@digitalstringspiano.com

### Related Projects

- PianoidBasic - Basic synthesis engine
- (Other related projects)

### References

- Modal synthesis literature
- CUDA programming guides
- Physical modeling resources

---

## ❓ FAQ

**Q: Which document should I read first?**
A: Start with [PIANOID_CORE_DOCUMENTATION.md](PIANOID_CORE_DOCUMENTATION.md) for application overview, or [DOCUMENTATION_UPDATE_2025-10-16.md](DOCUMENTATION_UPDATE_2025-10-16.md) if you're catching up on recent changes.

**Q: Where is the Phase 6 implementation guide?**
A: Phase 6 is planned but not yet implemented. See [PARAMETER_REFACTORING_PLAN.md](PARAMETER_REFACTORING_PLAN.md) for the overview. Detailed implementation guides will be created when work begins.

**Q: How do I know if documentation is current?**
A: Check the "Last Updated" date at the top of each document. Main docs were updated October 16, 2025 to reflect all Phase 0-5 changes.

**Q: What happened to GpuHandler and DoubleBufferedPresetManager?**
A: Both were replaced by UnifiedGpuMemoryManager in Phase 5. See the archived planning documents in [docs/historical/planning/](docs/historical/planning/) for details.

**Q: Are there breaking API changes?**
A: No breaking changes in Python or REST APIs. C++ APIs enhanced but backward compatible. See migration guide in [DOCUMENTATION_UPDATE_2025-10-16.md](DOCUMENTATION_UPDATE_2025-10-16.md).

**Q: Can I use both SDL2 and SDL3 in the same build?**
A: No. SDL2 and SDL3 have conflicting symbols and cannot be linked together. You must choose ONE SDL version at build time. See [AUDIO_DRIVER_ARCHITECTURE.md](AUDIO_DRIVER_ARCHITECTURE.md) for details.

**Q: How do I switch between SDL2 and SDL3?**
A: Edit `pianoid_cuda/build_config.json`, change `default_audio_driver` to "SDL2" or "SDL3", then run `python build.py`. See the [driver switching guide](AUDIO_DRIVER_ARCHITECTURE.md#switching-between-sdl-versions).

**Q: Why is SDL3 audio distorted after restart?**
A: This was fixed on October 19, 2025. Update to the latest code which includes the CircularBuffer reset fix.

**Q: How do I add custom charts or actions to the middleware?**
A: See [docs/guides/CHART_API_DOCUMENTATION.md](docs/guides/CHART_API_DOCUMENTATION.md) for a complete guide. You'll need to:
1. Write a processing function in `chartFunctions.py`
2. Add a configuration entry to `chart_config.json`
3. Restart the server

The documentation includes step-by-step examples for both charts (with data visualization) and actions (executable commands).

**Q: What's the new unified lifecycle API?**
A: As of October 23, 2025, there's a new streamlined API with 4 clear methods:
1. `initialize_pianoid()` - One-time GPU and parameter setup
2. `start_realtime_playback()` - Begin audio playback
3. `pause_playback()` - Pause cleanly (keeps GPU warm)
4. `shutdown_pianoid()` - Complete cleanup

See [docs/historical/status-reports/LIFECYCLE_REFACTORING_SUMMARY.md](docs/historical/status-reports/LIFECYCLE_REFACTORING_SUMMARY.md) for details. Legacy methods still work for backward compatibility.

**Q: Why are my MIDI commands being rejected when paused?**
A: As of October 23, 2025, playback commands (note on/off) are rejected when lifecycle state is not `PLAYBACK_ACTIVE`. This prevents writing to GPU memory when paused. Control commands (sustain, volume) are still allowed. See [docs/historical/status-reports/MIDI_PROCESSING_REFACTORING_SUMMARY.md](docs/historical/status-reports/MIDI_PROCESSING_REFACTORING_SUMMARY.md) for details.

**Q: What are universal playback primitives?**
A: As of October 24, 2025, core synthesis operations are exposed as public primitives (`executeSynthesisCycle`, `manageSoundBuffers`, `recordCycleAudio`, `getCurrentCycleAudio`) that both online and offline engines use. This eliminates code duplication and guarantees identical behavior. See [docs/historical/planning/UNIVERSAL_PLAYBACK_REFACTORING_PLAN.md](docs/historical/planning/UNIVERSAL_PLAYBACK_REFACTORING_PLAN.md) for architecture details.

**Q: What is PlaybackCycleExecutor and why was it enhanced?**
A: PlaybackCycleExecutor is a helper class that provides shared synthesis cycle logic for both online and offline playback engines. As of October 24, 2025 (Phase A & B), it was enhanced with string excitation helpers (`exciteStringsForPitch`, `exciteStringBatch`) that centralize string triggering logic. This eliminated all code duplication between engines - both now use identical cycle execution. See [GPU_BACKEND_EXTRACTION_STATUS.md](GPU_BACKEND_EXTRACTION_STATUS.md) for the complete refactoring summary.

**Q: Will Pianoid be split into separate GPU backend and middleware layers?**
A: This was analyzed and planned in October 2025. While architecturally desirable, the extraction revealed that Pianoid.cu has deeply intertwined middleware and GPU code that cannot be separated with a simple rename. The work is documented in [docs/historical/status-reports/GPU_BACKEND_EXTRACTION_STATUS.md](docs/historical/status-reports/GPU_BACKEND_EXTRACTION_STATUS.md) as a future multi-day refactoring project. For now, the focus was on eliminating engine duplication (completed successfully).

**Q: How do I excite individual soundboard modes for testing?**
A: As of October 24, 2025, you can use the Mode Playback Test chart function:
1. Access Frontend → Charts → "Mode Playback Test"
2. Set parameters: mode_index (0-255), velocity (0-127), duration_ms, display_length_ms
3. View two charts: mode oscillation (direct mode response) + generated sound (soundboard output)
4. Play audio for both waveforms

This uses the custom 0xF1 MIDI command for direct mode excitation in offline playback. See [docs/historical/status-reports/MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md](docs/historical/status-reports/MODE_EXCITATION_IMPLEMENTATION_SUMMARY.md) for technical details. Primary use case is testing and debugging individual mode responses.

**Q: What is Phase E and is it complete?**
A: **YES!** Phase E (unified EventQueue online playback) is **complete in v3.0** (October 25-26, 2025). The legacy online playback system has been completely removed. All online playback now uses the unified EventQueue architecture with cycle-accurate timing (±5 cycles), thread-safe event scheduling, and event logging. See [docs/historical/status-reports/PLAYBACK_STATUS_SUMMARY.md](docs/historical/status-reports/PLAYBACK_STATUS_SUMMARY.md) for details.

**Q: Do I need to enable unified playback with an environment variable?**
A: **No.** As of v3.0, unified EventQueue playback is the **only** system and is always enabled. The `PIANOID_UNIFIED_PLAYBACK` environment variable was removed along with all legacy code.

**Q: What happened to the legacy online playback system?**
A: It was completely removed in v3.0 (546 lines deleted across commits bf4f82e, 1a21ca7, ec98e8b). The unified EventQueue system replaced it with better timing accuracy, thread safety, and event logging capabilities.

---

**Maintained by:** PianoidCore Development Team
**Last Index Update:** November 12, 2025 (Added deck feedback coefficient refactoring plan)
**Questions?** Contact: astrinleonid@digitalstringspiano.com
