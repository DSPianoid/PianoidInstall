# Pianoid Documentation

Pianoid is a real-time GPU-accelerated physical modeling piano synthesizer. It simulates piano string
acoustics by solving wave equations on the GPU, producing physically accurate sound synthesis at
interactive latency.

---

## System Architecture

```
+------------------+
|  PianoidTunner   |  React/TypeScript — parameter UI, visualization, MIDI input
+--------+---------+
         | HTTP REST + Socket.IO WebSocket
+--------+---------+
| pianoid_middlew. |  Python Flask — REST API, orchestration, MIDI routing, chart generation
+--------+---------+
         | C API / shared memory
+--------+---------+
|  pianoid_cuda    |  CUDA C++ — wave equation solver, 256 strings x 256 modes
+------------------+

         +
+------------------+
|  PianoidBasic    |  Python domain model — physical parameters, string geometry, excitation curves
+------------------+
  (consumed by middleware and tunner)
```

---

## Core Principles

- **Modal synthesis grid** — 256 strings x 256 vibrational modes computed in parallel on the GPU
- **Finite-difference time-domain (FDTD) simulation** — wave equation solved per time step for each
  string, capturing realistic resonance and decay
- **Cooperative grid CUDA kernels** — grid-level synchronization allows cross-string coupling and
  sustain pedal simulation within a single kernel launch
- **Double-buffered parameter updates** — parameter changes are staged in a write buffer and swapped
  atomically, eliminating audio glitches during live editing
- **Event-driven playback** — MIDI note events are queued and dispatched to the engine with
  sample-accurate timing

---

## Module Index

| Module | Language | Role |
|--------|----------|------|
| `pianoid_cuda` | CUDA C++ | Real-time synthesis engine |
| `pianoid_middleware` | Python (Flask) | Backend orchestration, API, calibration, and modal extraction |
| `PianoidBasic` | Python | Physical domain model |
| `PianoidTunner` | React / TypeScript | Frontend UI and MIDI input |

---

## Documentation Map

### Architecture

- [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) — End-to-end data flow from
  MIDI input through synthesis to audio output
- [architecture/BUILD_SYSTEM.md](architecture/BUILD_SYSTEM.md) — Toolchain detection, CUDA
  compilation, wheel builds, and dependency management
- [architecture/DATA_FLOWS.md](architecture/DATA_FLOWS.md) — End-to-end traces for playback,
  parameter management, and chart/action flows

### pianoid_cuda

- [modules/pianoid-cuda/OVERVIEW.md](modules/pianoid-cuda/OVERVIEW.md) — Module structure,
  entry points, and key design decisions
- [modules/pianoid-cuda/SYNTHESIS_ENGINE.md](modules/pianoid-cuda/SYNTHESIS_ENGINE.md) — Wave
  equation solver, mode computation, and per-string FDTD update loop
- [modules/pianoid-cuda/PLAYBACK_SYSTEM.md](modules/pianoid-cuda/PLAYBACK_SYSTEM.md) — Note
  event queue, sample-accurate scheduling, and voice allocation
- [modules/pianoid-cuda/MEMORY_MANAGEMENT.md](modules/pianoid-cuda/MEMORY_MANAGEMENT.md) —
  Device memory layout, double-buffering strategy, and allocation policy
- [modules/pianoid-cuda/AUDIO_DRIVERS.md](modules/pianoid-cuda/AUDIO_DRIVERS.md) — SDL3 audio
  callback integration and platform-specific driver configuration
- [modules/pianoid-cuda/PARAMETER_SYSTEM.md](modules/pianoid-cuda/PARAMETER_SYSTEM.md) —
  Parameter schema, atomic swap protocol, and real-time update path
- [modules/pianoid-cuda/DEBUG_DATA.md](modules/pianoid-cuda/DEBUG_DATA.md) —
  GPU state extraction, PianoidResult wrapper, output_data record layout
- [modules/pianoid-cuda/LOGGING.md](modules/pianoid-cuda/LOGGING.md) —
  PianoidLogger, file-based logging, hot-path fixes

### pianoid_middleware

- [modules/pianoid-middleware/OVERVIEW.md](modules/pianoid-middleware/OVERVIEW.md) — Flask app
  structure, startup sequence, and inter-module communication
- [modules/pianoid-middleware/REST_API.md](modules/pianoid-middleware/REST_API.md) — All HTTP
  endpoints, request/response schemas, and error codes
- [modules/pianoid-middleware/MIDI_SYSTEM.md](modules/pianoid-middleware/MIDI_SYSTEM.md) — MIDI
  device enumeration, event parsing, and routing to the engine
- [modules/pianoid-middleware/CHART_SYSTEM.md](modules/pianoid-middleware/CHART_SYSTEM.md) —
  Real-time waveform and spectrum chart generation for the frontend

### PianoidBasic

- [modules/pianoid-basic/OVERVIEW.md](modules/pianoid-basic/OVERVIEW.md) — Physical parameter
  definitions, string geometry model, and excitation curve library

### PianoidTunner

- [modules/pianoid-tunner/OVERVIEW.md](modules/pianoid-tunner/OVERVIEW.md) — React component
  tree, parameter binding, visualization panels, and MIDI input handling

### Development

- [development/TESTING.md](development/TESTING.md) — Three-level pytest framework, test inventory,
  instrumentation APIs
- [development/WORK_IN_PROGRESS.md](development/WORK_IN_PROGRESS.md) — Active investigations
  and planned work

### Guides

- [guides/QUICK_START.md](guides/QUICK_START.md) — Prerequisites, build steps, and running the
  full stack locally
