# pianoid_cuda Module Overview

## Purpose

`pianoid_cuda` is the CUDA-accelerated piano synthesis engine for Pianoid. It models piano strings
using finite-difference time-domain (FDTD) wave simulation running on a GPU, coupled to soundboard
resonance modes, driven by configurable hammer excitation, and delivered to a real-time or offline
audio output. The module exposes a Python extension (via pybind11) so that middleware and the REST
layer can control synthesis without any awareness of GPU internals.

---

## Component Map

```
  Python / REST layer
         |
         v
  +------+-------+
  |    Pianoid   |   (Pianoid.cuh / Pianoid.cu)
  |   (facade)   |   Single public class; all GPU state lives here.
  +--+--+--+--+--+
     |  |  |  |
     |  |  |  +--------------------------------------------+
     |  |  |                                               |
     |  |  v                                               v
     |  | UnifiedGpuMemoryManager               AudioDriverInterface
     |  | (UnifiedGpuMemoryManager.h/.cu)       (AudioDriverInterface.h)
     |  |  Double-buffered preset storage         |         |
     |  |  ~751 KB tunable + ~170 MB working     SDL3    ASIO
     |  |                                        Driver  Driver
     |  v
     | MainKernel  (MainKernel.cuh / MainKernel.cu)
     |  addKernel()  — cooperative-grid CUDA kernel
     |  256 string-blocks × 256 mode threads
     |  FDTD wave eq + harmonic oscillator mode eq
     |
     +---> FIR Filter  (FIRFilter.cuh / FIRFilter.cu)
     |      convolutionKernel()  — optional post-processing
     |
     +---> Playback Engines
            |
            +-- OnlinePlaybackEngine   (real-time, audio-callback driven)
            +-- OfflinePlaybackEngine  (faster-than-real-time, WAV export)
                    |
                    +-- PlaybackCycleExecutor  (shared synthesis step logic)
                    +-- EventQueue             (cycle-accurate event list)
                    +-- EventDispatcher        (event -> Pianoid API translation)
                    +-- RealTimeEventBuffer    (thread-safe live event injection)
                    +-- CycleTimeEstimator     (wall-clock -> cycle mapping)
```

---

## Key Classes

### Pianoid
**File:** `Pianoid.cuh` / `Pianoid.cu`

The central facade. Owns all GPU buffer pointers, the `UnifiedGpuMemoryManager`, the active
`AudioDriverInterface`, and the `PianoidProfiler`. Callers interact exclusively through this
class. Key responsibilities:

- GPU memory initialisation via `devMemoryInit()`
- Synthesis cycle execution via `executeSynthesisCycle()` / `launchMainKernel()`
- Audio buffer management via `manageSoundBuffers()` / `playSoundSamples()`
- Preset switching via `loadPresetToLibrary()` / `switchPreset()`
- String and mode excitation via the batch API (`beginStringBatch()`, `addStringToBatch()`,
  `commitStringBatch()`)
- Per-string and per-parameter granular updates (`updateSingleStringParameter_NEW()`,
  `updateMultiStringParameter_NEW()`)
- Audio driver lifecycle (`startAudioDriver()`, `stopAudioDriver()`)
- Online and offline playback orchestration (`runOnlinePlayback()`, `runOfflinePlayback()`)

### MainKernel (`addKernel`)
**File:** `MainKernel.cuh` / `MainKernel.cu`

The primary CUDA kernel. Launched with cooperative grid groups so that all thread blocks can
synchronise globally. Simulates 256 strings (one block per string array) and 256 resonance
modes simultaneously. See [SYNTHESIS_ENGINE.md](SYNTHESIS_ENGINE.md).

### UnifiedGpuMemoryManager
**File:** `UnifiedGpuMemoryManager.h` / `UnifiedGpuMemoryManager.cu`

Centralised GPU allocator with five buffer categories and asynchronous double-buffering for
tunable (preset) parameters. See [MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md).

### Playback Engines
**Files:** `OnlinePlaybackEngine.h/.cu`, `OfflinePlaybackEngine.h/.cu`,
`PlaybackCycleExecutor.h/.cu`

`IPlaybackEngine` (defined in `PlaybackEngine.h`) is the abstract interface. Two concrete
implementations handle real-time and offline scenarios. `PlaybackCycleExecutor` provides shared
static helpers used by both. See [PLAYBACK_SYSTEM.md](PLAYBACK_SYSTEM.md).

### Audio Drivers
**Files:** `AudioDriverInterface.h`, `SDL3AudioDriver.h/.cpp`,
`ASIOAudioDriver.h/.cpp`, `AudioDriverFactory.h/.cpp`

Abstract driver interface with SDL3 and ASIO implementations selected at compile time and
optionally overridden at runtime. See [AUDIO_DRIVERS.md](AUDIO_DRIVERS.md).

---

## Related Documentation

| File | Contents |
|------|----------|
| [SYNTHESIS_ENGINE.md](SYNTHESIS_ENGINE.md) | FDTD wave equation, kernel grid layout, mode simulation, FIR filter |
| [PLAYBACK_SYSTEM.md](PLAYBACK_SYSTEM.md) | Online/offline engines, EventQueue, RealTimeEventBuffer, CycleTimeEstimator |
| [MEMORY_MANAGEMENT.md](MEMORY_MANAGEMENT.md) | UnifiedGpuMemoryManager, buffer categories, double-buffering, preset library |
| [AUDIO_DRIVERS.md](AUDIO_DRIVERS.md) | SDL3 and ASIO drivers, LockFreeCircularBuffer, AudioDriverFactory |
| [PARAMETER_SYSTEM.md](PARAMETER_SYSTEM.md) | ParameterInfo registry, granular and bulk update APIs, parameter pipeline |
| [DEBUG_DATA.md](DEBUG_DATA.md) | GPU state extraction, PianoidResult wrapper, output_data record layout, compile guards |

---

## Configuration Constants (`constants.h`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `NUM_STRINGS` | 256 | Total simulated strings |
| `NUM_MODES` | 256 | Soundboard resonance modes |
| `NUM_STRINGS_IN_ARRAY` | 4 | Strings packed per GPU block |
| `MAX_ARRAY_SIZE` | 512 | Maximum spatial points per string array |
| `PHYSICAL_PARAMETERS_NUMBER` | 16 | Physical parameters per string |
| `EXCITATION_FACTOR` | 8 | Velocity-level excitation slots |
| `NUM_CHANNELS` | 8 | GPU audio output channels |
| `WARP_SIZE` | 32 | CUDA warp size |
