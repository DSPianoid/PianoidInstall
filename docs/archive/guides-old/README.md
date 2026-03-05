# PianoidCore Usage Guides & API Documentation

This directory contains practical guides and API references for using and extending PianoidCore.

---

## 📚 Available Guides

### Build & Setup Guides

- **[SDL3_BUILD_INSTRUCTIONS.md](SDL3_BUILD_INSTRUCTIONS.md)** - SDL3 compilation guide
  - Building SDL3 from source on Windows
  - Integration with PianoidCore build system
  - Troubleshooting common build issues

- **[SDL3_USAGE_GUIDE.md](SDL3_USAGE_GUIDE.md)** - SDL3 integration guide
  - Using SDL3 audio driver in PianoidCore
  - Configuration and setup
  - Migration from SDL2

### API Documentation

- **[CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md)** - Chart & Action API reference
  - REST API endpoints for charts and actions
  - Plugin-based chart system
  - Step-by-step guide for adding custom charts and actions
  - Complete code examples

### Testing & Development Guides

- **[OFFLINE_MIDI_CHART_USAGE.md](OFFLINE_MIDI_CHART_USAGE.md)** - Offline MIDI playback testing
  - Using the Chart API to test offline MIDI rendering
  - Waveform visualization with audio playback
  - Performance metrics and diagnostics

- **[PROFILING_GUIDE.md](PROFILING_GUIDE.md)** - GPU and CPU profiling guide
  - Profiling tools and techniques
  - Performance measurement
  - Optimization strategies
  - Using PianoidProfiler module

---

## 🎯 Quick Start

### For New Users
1. Start with [SDL3_BUILD_INSTRUCTIONS.md](SDL3_BUILD_INSTRUCTIONS.md) to set up your build environment
2. Follow [SDL3_USAGE_GUIDE.md](SDL3_USAGE_GUIDE.md) to configure audio
3. Test your setup with [OFFLINE_MIDI_CHART_USAGE.md](OFFLINE_MIDI_CHART_USAGE.md)

### For Developers
1. Review [CHART_API_DOCUMENTATION.md](CHART_API_DOCUMENTATION.md) to extend the middleware
2. Use [PROFILING_GUIDE.md](PROFILING_GUIDE.md) to optimize performance
3. Reference main technical docs in [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](../../pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md)

### For Researchers
1. Start with [PROFILING_GUIDE.md](PROFILING_GUIDE.md) for performance analysis
2. Use [OFFLINE_MIDI_CHART_USAGE.md](OFFLINE_MIDI_CHART_USAGE.md) for experimental testing
3. Reference synthesis theory in technical documentation

---

## 📖 Documentation Structure

```
docs/
├── guides/                          ← You are here
│   ├── SDL3_BUILD_INSTRUCTIONS.md   - Build guide
│   ├── SDL3_USAGE_GUIDE.md          - Usage guide
│   ├── CHART_API_DOCUMENTATION.md   - API reference
│   ├── OFFLINE_MIDI_CHART_USAGE.md  - Testing guide
│   └── PROFILING_GUIDE.md           - Performance guide
├── historical/                      - Completed work archives
│   ├── bug-fixes/
│   ├── planning/
│   ├── status-reports/
│   └── technical-notes/
└── technical-notes/                 - Technical reference notes
```

---

## 🔗 Related Documentation

### Main Documentation
- [PIANOID_CORE_DOCUMENTATION.md](../../PIANOID_CORE_DOCUMENTATION.md) - Application overview
- [DOCUMENTATION_INDEX.md](../../DOCUMENTATION_INDEX.md) - Master documentation index
- [README.md](../../README.md) - Project overview

### Technical Documentation
- [pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md](../../pianoid_cuda/COMPREHENSIVE_TECHNICAL_DOCUMENTATION.md) - CUDA implementation details
- [PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md](../../PARAMETER_SYSTEM_UNIFIED_DOCUMENTATION.md) - Parameter system reference
- [AUDIO_DRIVER_ARCHITECTURE.md](../../AUDIO_DRIVER_ARCHITECTURE.md) - Audio driver architecture

---

**Last Updated:** November 8, 2025
**Total Guides:** 5 files
