# PianoidCore: Complete Application Documentation

**Version:** Development Preview (Post-Phase-5 Refactoring + PlaybackCycleExecutor Enhancement)
**Author:** Pianoid Ltd
**Contact:** astrinleonid@digitalstringspiano.com
**Repository:** PianoidCore Application
**Last Updated:** 2025-10-24

## 🆕 Recent Major Updates (October 2025)

### PlaybackCycleExecutor Enhancement (October 24, 2025)
- **Zero Code Duplication**: Online and offline playback engines now use identical cycle execution logic
- **String Excitation Helpers**: Centralized `exciteStringsForPitch()` and `exciteStringBatch()` methods
- **Simplified Event Handling**: EventDispatcher code reduced by 92% for note-on events
- **Online Recording Support**: Online playback engine gained audio recording capability
- **Architecture**: Clear separation between timing (engines) and execution (PlaybackCycleExecutor)
- See [GPU_BACKEND_EXTRACTION_STATUS.md](GPU_BACKEND_EXTRACTION_STATUS.md) for complete details

### Audio Driver Architecture (October 19, 2025)
- **SDL2/SDL3 Mutual Exclusion**: SDL2 and SDL3 cannot coexist in same build due to symbol conflicts
- **Build-Time Driver Selection**: Choose ONE SDL version (SDL2 OR SDL3) at build time
- **SDL3 Restart Fix**: Fixed CircularBuffer not resetting on resume, eliminating distorted audio after restart
- **Runtime Selection**: ASIO ↔ SDL (chosen SDL version) available at runtime
- See [AUDIO_DRIVER_ARCHITECTURE.md](AUDIO_DRIVER_ARCHITECTURE.md) for complete details

**Parameter Refactoring Project - Phases 0-5 Complete**

PianoidCore has undergone a comprehensive architectural refactoring of its GPU memory management and parameter update systems. Key achievements:

- ✅ **Phase 0:** Excitation flow refactored - 40x bandwidth reduction for note triggering
- ✅ **Phase 1-3:** GPU memory unified - Single `UnifiedGpuMemoryManager` replaces dual systems
- ✅ **Phase 4:** Critical bugs fixed - Buffer overflows, memory corruption resolved
- ✅ **Phase 5:** Codebase cleaned - 290 lines removed, 4 legacy files deleted
- 📋 **Phase 6:** Parameter API planned - Granular updates for 100x-1000x further optimization

**Impact:**
- ~180 MB GPU memory managed by single unified system
- Async parameter updates with no audio glitches
- 3.15 MB redundant allocations eliminated
- Instant preset switching via pointer swap
- Cleaner, more maintainable codebase

**See:** [DOCUMENTATION_UPDATE_2025-10-16.md](DOCUMENTATION_UPDATE_2025-10-16.md) for complete details

---

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [REST API Reference](#3-rest-api-reference)
4. [Middleware Layer Deep Dive](#4-middleware-layer-deep-dive)
5. [PianoidBasic Integration](#5-pianoidbasic-integration)
6. [Frontend Integration Guide](#6-frontend-integration-guide)
7. [Deployment & Configuration](#7-deployment--configuration)
8. [Development Guide](#8-development-guide)
9. [Troubleshooting](#9-troubleshooting)
10. [Future Architecture](#10-future-architecture)

---

## 1. Executive Summary

### 1.1 Application Purpose and Capabilities

**PianoidCore** is a full-stack piano synthesis application that combines a Flask REST API backend with Python middleware and a CUDA-accelerated physics engine to deliver real-time physical modeling piano synthesis. The application enables remote control, parameter manipulation, and sophisticated data visualization for a physics-based piano simulator.

**Key Capabilities:**
- **Web-Based Control**: Complete REST API for remote parameter management and playback control
- **Real-Time Synthesis**: CUDA-accelerated physics simulation with sub-millisecond latency
- **Physical Modeling**: Authentic piano sound through string vibration and modal synthesis
- **MIDI Integration**: Real-time MIDI input with configurable keyboard mappings
- **Dynamic Visualization**: Extensible chart generation system for analysis and debugging
- **Preset Management**: Load and save complete piano configurations
- **FIR Filtering**: Multi-channel audio post-processing with 24-filter capabilities
- **Parameter Routing**: Sophisticated system for updating physics parameters in real-time
- **Profiling System**: GPU and CPU timing analysis for performance optimization

### 1.2 Target Users and Use Cases

**Web Developers:**
- Build rich web interfaces for piano control
- Create parameter editors and visualization dashboards
- Integrate piano synthesis into web applications

**Audio Engineers:**
- Design custom piano sounds through physical parameters
- Apply real-time effects via FIR filters
- Analyze sound characteristics through built-in charts

**Researchers:**
- Study piano acoustics and physical modeling
- Generate datasets for machine learning
- Experiment with alternative synthesis algorithms

**Integration Engineers:**
- Connect DAWs via MIDI
- Build controller interfaces
- Integrate with external audio systems

### 1.3 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           WEB FRONTEND                              │
│                    (Browser / External Client)                      │
│                   HTTP Requests → JSON Responses                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ REST API (CORS enabled)
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                       FLASK REST API LAYER                          │
│                      (backendServer.py)                             │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Endpoints: /load_preset, /set_parameter, /play, /health   │    │
│  │ Chart Registry: Dynamic graph and action registration     │    │
│  │ Global Pianoid Instance: Singleton for synthesis control  │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Python Function Calls
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                     PYTHON MIDDLEWARE LAYER                         │
│                    (pianoid_middleware/)                            │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Pianoid Orchestrator (pianoid.py)                          │    │
│  │  • Parameter Management & Routing                          │    │
│  │  • CUDA Wrapper Interface                                  │    │
│  │  • Thread Safety (cuda_lock)                               │    │
│  │                                                             │    │
│  │ ChartGenerator + ChartRegistry                             │    │
│  │  • Dynamic visualization system                            │    │
│  │  • Extensible chart types                                  │    │
│  │  • Audio data embedding                                    │    │
│  │                                                             │    │
│  │ MidiListener (pianoidMidiListener.py)                      │    │
│  │  • Real-time MIDI input processing                         │    │
│  │  • Keyboard configuration system                           │    │
│  │                                                             │    │
│  │ PianoidResult (PanoidResult.py)                            │    │
│  │  • Data extraction from CUDA                               │    │
│  │  • Result formatting                                       │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ pybind11 Bindings
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                      PIANOID BASIC LIBRARY                          │
│                    (PianoidBasic Package)                           │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ StringMap: Piano string layout and physics                 │    │
│  │ Pitch: Note abstraction with excitation curves             │    │
│  │ Piano_mode / ModeMap: Modal synthesis parameters           │    │
│  │ ModelParameters: System configuration                      │    │
│  │ PianoidSimulation: High-level simulation interface         │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ pybind11 Bindings
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         CUDA ENGINE LAYER                           │
│                      (pianoidCuda Module)                           │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Pianoid C++ Class (Pianoid.cu)                             │    │
│  │  • GPU Memory Management (UnifiedGpuMemoryManager)         │    │
│  │  • Parameter Transfer (setNew*Parameters)                  │    │
│  │  • Audio Device Control (SDL2/SDL3/ASIO)                   │    │
│  │  • Universal Playback Primitives (Oct 2025)                │    │
│  │    - executeSynthesisCycle() - Run GPU kernels             │    │
│  │    - manageSoundBuffers() - Handle audio buffers           │    │
│  │    - recordCycleAudio() - Capture audio to memory          │    │
│  │    - getCurrentCycleAudio() - Extract cycle audio          │    │
│  │                                                             │    │
│  │ PlaybackCycleExecutor (PlaybackCycleExecutor.cu)           │    │
│  │  • Shared synthesis cycle logic (Oct 2025)                 │    │
│  │  • Event processing coordination                           │    │
│  │  • String excitation helpers                               │    │
│  │    - exciteStringsForPitch() - MIDI pitch → strings        │    │
│  │    - exciteStringBatch() - Batch string triggering         │    │
│  │  • Zero duplication between online/offline engines         │    │
│  │                                                             │    │
│  │ Playback Engines:                                          │    │
│  │  • OnlinePlaybackEngine - Real-time with audio driver      │    │
│  │  • OfflinePlaybackEngine - Fast offline rendering          │    │
│  │  • Both use PlaybackCycleExecutor (unified behavior)       │    │
│  │                                                             │    │
│  │ CUDA Kernels:                                              │    │
│  │  • String Physics Simulation (MainKernel.cu)               │    │
│  │  • Mode Integration (Mode kernels)                         │    │
│  │  • FIR Convolution (FIRFilter.cu)                          │    │
│  │  • Excitation Application (Gauss kernels)                  │    │
│  │  • Format Conversion (floatToAudioSampleKernel)            │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ Audio Samples
                             ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        AUDIO OUTPUT                                 │
│              (ASIO / SDL2 / SDL3 Audio Driver)                      │
│                      Real-time Playback                             │
│         See: AUDIO_DRIVER_ARCHITECTURE.md for details               │
└─────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────┐
                    │   MIDI INPUT (Optional)  │
                    │  (MIDI Controller/Piano) │
                    └──────────┬───────────────┘
                               │ rtmidi
                               ↓
                      MidiListener Thread
```

### 1.4 Technology Stack Overview

**Backend:**
- **Flask 3.1.2** - Web framework for REST API
- **Flask-CORS 4.0.1** - Cross-origin request handling
- **Python 3.x** - Primary application language

**Middleware:**
- **NumPy 2.2.6** - Numerical computations
- **Pandas 2.2.3** - Data handling
- **python-rtmidi 1.5.8** - MIDI input processing
- **Matplotlib 3.9.4** - Visualization backend
- **SciPy 1.16.1** - Scientific computing

**Physics Engine:**
- **PianoidBasic** (custom package) - Physics simulation library
- **pianoidCuda** (custom C++/CUDA module) - GPU-accelerated synthesis
- **pybind11 3.0.1** - Python/C++ bindings
- **CUDA** - GPU computation

**Audio:**
- **simpleaudio 1.0.4** - Audio playback
- **sounddevice 0.4.6** - Audio I/O
- **librosa 0.11.0** - Audio analysis

**Development:**
- **JupyterLab 4.4.7** - Interactive development
- **PyYAML 6.0.1** - Configuration files

### 1.5 Data Flow Summary

**Preset Loading:**
```
JSON Preset File → Flask /load_preset → Pianoid.initialize() →
StringMap.pack_parameters() + ModeMap.pack_modes() →
pianoidCuda.devMemoryInit() → GPU Memory Allocation
```

**Note Triggering (REST API):**
```
POST /play → pianoid.perform_midi_command() →
pianoidCuda.processMidiPoints() → String Excitation Kernel →
String Physics Kernel → Mode Integration → FIR Filter → Audio Output
```

**Note Triggering (MIDI):**
```
MIDI Controller → rtmidi → MidiListener.perform_action() →
pianoid.perform_midi_command() → [same as above]
```

**Parameter Update:**
```
POST /set_parameter/string/60 → parse_range() →
pianoid.update_parameter() → StringMap.update_* →
pianoid.update_params_on_cuda() → pianoidCuda.setNewPhysicalParameters() →
GPU Memory Update (cudaMemcpy)
```

**Chart Generation:**
```
POST /get_chart_test → ChartRegistry.get_type() →
ChartGenerator.get_response() → chartFunctions.sound_function() →
pianoid.result.get_sound() → ChartArray with audio embedding →
JSON Response with base64 audio
```

### 1.6 Key Design Patterns

**Singleton Pattern:**
- Global `pianoid` instance in [backendServer.py:15](backendServer.py#L15)
- Single synthesis engine shared across all requests

**Registry Pattern:**
- `ChartTypeRegistry` for dynamic chart type registration
- Extensible action and visualization system
- JSON-based configuration ([chart_config.json](chart_config.json))

**Factory Pattern:**
- Dynamic chart/action instantiation via `load_function()` in [ChartGenerator.py:11](ChartGenerator.py#L11)
- Runtime function loading through `importlib`

**Thread Safety:**
- `cuda_lock` threading.Lock in [pianoid.py:46](pianoid.py#L46)
- Protects CUDA parameter updates during concurrent access
- Sleep delays after updates to allow GPU operations to complete

**Wrapper Pattern:**
- Python `Pianoid` class wraps C++ `pianoidCuda.Pianoid`
- Abstraction layer for complex CUDA operations
- High-level interface for parameter management

**Strategy Pattern:**
- Pluggable chart functions in `chartFunctions.py`
- Different visualization strategies selected at runtime
- Configurable action handlers

### 1.7 Performance Characteristics

**Latency:**
- **Target Cycle Time**: 1ms @ 48kHz sample rate
- **Samples per Cycle**: 48 (configurable via `mode_iteration`)
- **Real-time Capability**: Sub-millisecond synthesis with proper GPU configuration

**Throughput:**
- **String Simulation**: 256 strings @ 384 points each
- **Modal Synthesis**: 16-64 modes (configurable)
- **Polyphony**: Limited by CUDA memory and GPU performance
- **FIR Filtering**: 24 filters (12 input channels × 2 output channels)

**Memory Usage:**
- **GPU Memory**: ~500MB-2GB depending on configuration
  - String states: 256 strings × 384 points × 2 states × 4 bytes
  - Mode states: 64 modes × 6 fields × 4 bytes
  - FIR ring buffers: 12 channels × (filter_length + 48) × 2 × 4 bytes
  - Physical parameters, hammer shapes, excitation curves

**Scalability:**
- Single-instance architecture (global singleton)
- Thread-safe for concurrent parameter updates
- Limited by GPU memory for additional voices
- Designed for single-user interactive use, not multi-tenant

---

## 2. System Architecture

### 2.1 Component Diagram with Layer Boundaries

```
┌──────────────────────── PRESENTATION LAYER ─────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    Flask Application                        │    │
│  │                   (backendServer.py:20)                     │    │
│  │                                                             │    │
│  │  • CORS Middleware (Flask-CORS)                            │    │
│  │  • JSON Request/Response Handling                          │    │
│  │  • Exception Handling & HTTP Status Codes                  │    │
│  │  • Background Thread Management                            │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Endpoints (RESTful):                                               │
│  ├─ Lifecycle: /load_preset, /save_preset, /reset, /health, /ping  │
│  ├─ Parameters: /get_parameter/<type>/<range>                       │
│  │               /set_parameter/<type>/<range>                      │
│  ├─ Playback: /play, /play_mode/<mode_no>                          │
│  ├─ Configuration: /set_deck, /set_hammer_shape,                   │
│  │                  /set_string_excitation, /set_velocity           │
│  ├─ Visualization: /get_chart_test, /graph_names, /command_names   │
│  └─ Metadata: /get_available_notes, /get_string_map, /get_settings │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                   ↕ Function Calls
┌────────────────────── APPLICATION LAYER ────────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │              Pianoid Middleware Layer                       │    │
│  │             (pianoid_middleware/)                           │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Main Orchestrator (pianoid.py):                                    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ class Pianoid:                                              │    │
│  │   Attributes:                                               │    │
│  │   • sm: StringMap (from PianoidBasic)                       │    │
│  │   • modes: ModeMap (from PianoidBasic)                      │    │
│  │   • mp: ModelParameters (configuration)                     │    │
│  │   • pianoid: pianoidCuda.Pianoid (C++ wrapper)              │    │
│  │   • result: PianoidResult (data extraction)                 │    │
│  │   • midi_listener: MidiListener (MIDI input)                │    │
│  │   • cuda_lock: threading.Lock (thread safety)               │    │
│  │   • extract_data: bool (debug mode)                         │    │
│  │   • fixed_level, fixed_velocity: int (testing)              │    │
│  │   • exception: bool (error state tracking)                  │    │
│  │                                                             │    │
│  │   Core Methods:                                             │    │
│  │   • runPianoid() - Main synthesis loop                      │    │
│  │   • reset() - Clear state                                   │    │
│  │   • update_parameter() - Parameter dispatch                 │    │
│  │   • pack_for_interface() - API serialization                │    │
│  │   • perform_midi_command() - MIDI processing                │    │
│  │   • get_chart_for_frontend() - Visualization                │    │
│  │   • perform_frontend_command() - Action execution           │    │
│  │   • send_mode_params_to_CUDA() - Mode updates               │    │
│  │   • send_deck_params_to_CUDA() - Coupling updates           │    │
│  │   • update_params_on_cuda() - Physics parameter sync        │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Chart System:                                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ ChartTypeRegistry (ChartRegistry.py:321)                    │    │
│  │  • types: dict[str, ChartType]                              │    │
│  │  • register_type(), get_type()                              │    │
│  │  • graph_names_json(), action_names_json()                  │    │
│  │  • sync_config_file() - Persistence                         │    │
│  │                                                             │    │
│  │ ChartGenerator (ChartGenerator.py:23)                       │    │
│  │  • Dynamic function loading (importlib)                     │    │
│  │  • Parameter extraction                                     │    │
│  │  • Response formatting with audio embedding                 │    │
│  │                                                             │    │
│  │ ActionPerformer (ChartGenerator.py:72)                      │    │
│  │  • Action execution                                         │    │
│  │  • Registry-based dispatch                                  │    │
│  │                                                             │    │
│  │ chartFunctions.py - Implementations:                        │    │
│  │  • sound_function() - Audio waveform charts                 │    │
│  │  • string_shape_function() - String state visualization     │    │
│  │  • feedin_function() - Mode coupling analysis               │    │
│  │  • filter_test_function() - FIR filter testing              │    │
│  │  • profiling_data_function() - Performance analysis         │    │
│  │  • filter_action() - FIR filter control                     │    │
│  │  • profiling_action() - Profiling control                   │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  MIDI System:                                                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ MidiListener (pianoidMidiListener.py:8)                     │    │
│  │  • rtmidi integration                                       │    │
│  │  • YAML keyboard configuration                              │    │
│  │  • Action mapping (command → function)                      │    │
│  │  • Real-time event processing loop                          │    │
│  │  • Configurable control mappings                            │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Result Management:                                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ PianoidResult (PanoidResult.py:4)                           │    │
│  │  • get_sound_from_pianoid() - Extract audio                 │    │
│  │  • get_pianoid_state() - Fetch string states                │    │
│  │  • get_output_data_from_pianoid() - Debug data              │    │
│  │  • get_parameters_data_from_pianoid() - Parameter capture   │    │
│  │  • save_sound_to_wav() - Export audio                       │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                   ↕ Python API
┌───────────────────── DOMAIN LAYER (PianoidBasic) ───────────────────┐
│                                                                      │
│  StringMap (Pianoid.StringMap):                                     │
│  • Pitch objects with physics parameters                            │
│  • String-to-block mapping                                          │
│  • Hammer shape management                                          │
│  • Excitation curve storage                                         │
│  • pack_parameters() - Serialize for CUDA                           │
│  • pack_deck() - Coupling coefficients                              │
│  • update_hammer_shape(), update_deck()                             │
│                                                                      │
│  ModeMap (Pianoid.Mode.ModeMap):                                    │
│  • Piano_mode objects (frequency, decrement, mass)                  │
│  • pack_modes() - Serialize mode state                              │
│  • fit_params() - Compute coefficients (dec, omega)                 │
│  • State management (state, state_1)                                │
│                                                                      │
│  ModelParameters (Pianoid.ModelParams.ModelParameters):             │
│  • System configuration (sample rate, array size)                   │
│  • num_strings, num_modes, mode_iteration                           │
│  • pack_as_dict_for_cuda() - Configuration export                   │
│                                                                      │
│  Pitch (Pianoid.Pitch):                                             │
│  • Note abstraction (MIDI number, frequency)                        │
│  • Physics (tension, density, stiffness)                            │
│  • Geometry (length, tail)                                          │
│  • Excitation (temporal shape)                                      │
│  • Hammer (spatial shape)                                           │
│  • deck['feedin'], deck['feedback'] (modal coupling)                │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                   ↕ pybind11
┌────────────────────── INFRASTRUCTURE LAYER ─────────────────────────┐
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │              pianoidCuda C++ Module                         │    │
│  │            (Compiled from pianoid_cuda/)                    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Pianoid C++ Class (Pianoid.cu):                                    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ Constructor:                                                │    │
│  │  • Store CycleParameters                                    │    │
│  │  • Initialize instance variables                            │    │
│  │                                                             │    │
│  │ Memory Management:                                          │    │
│  │  • devMemoryInit() - Allocate GPU buffers                   │    │
│  │  • GpuDataHandler system for managed memory                 │    │
│  │  • Named buffer lookup (getRealPointer, etc.)               │    │
│  │                                                             │    │
│  │ Parameter Transfer:                                         │    │
│  │  • setNewPhysicalParameters() - String physics              │    │
│  │  • setNewHammerParameters() - Hammer shapes                 │    │
│  │  • setNewExcitationParameters() - Temporal curves           │    │
│  │  • setNewModeParameters() - Mode state                      │    │
│  │  • setNewDeckParameters() - Coupling coefficients           │    │
│  │  • set_filter() - FIR filter coefficients                   │    │
│  │                                                             │    │
│  │ Application Control:                                        │    │
│  │  • runMainApplication() - Main synthesis loop               │    │
│  │  • startApplication(), stopApplication()                    │    │
│  │  • isApplicationRunning()                                   │    │
│  │                                                             │    │
│  │ MIDI Processing:                                            │    │
│  │  • processMidiPoints() - Note on/off                        │    │
│  │  • processSustain() - Pedal control                         │    │
│  │                                                             │    │
│  │ Data Extraction:                                            │    │
│  │  • getRawSoundRecord() - Audio output                       │    │
│  │  • getPianoidState() - String states                        │    │
│  │  • getOutputData() - Debug data                             │    │
│  │  • getGpuProfilingData() - Performance metrics              │    │
│  │                                                             │    │
│  │ Audio Device:                                               │    │
│  │  • initAudioDevice() - Setup ASIO/SDL                       │    │
│  │  • resumeAudioPlayback(), stopAudioDevice()                 │    │
│  │                                                             │    │
│  │ FIR Filter:                                                 │    │
│  │  • switch_filter() - Enable/disable with parameters         │    │
│  │  • loadFirFilterFromFile() (Python wrapper)                 │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  CUDA Kernels (MainKernel.cu, FIRFilter.cu):                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ String Physics:                                             │    │
│  │  • addArraysKernel() - Main string simulation               │    │
│  │  • Finite difference method with stiffness                  │    │
│  │  • Boundary conditions and damping                          │    │
│  │                                                             │    │
│  │ Mode Integration:                                           │    │
│  │  • addModesArrayKernel() - Mode oscillator update           │    │
│  │  • Bidirectional coupling (feedin/feedback)                 │    │
│  │  • Resonance simulation                                     │    │
│  │                                                             │    │
│  │ Excitation:                                                 │    │
│  │  • addGaussKernel() - Apply temporal excitation             │    │
│  │  • Velocity-dependent curves                                │    │
│  │  • Multi-Gaussian summation                                 │    │
│  │                                                             │    │
│  │ FIR Filtering:                                              │    │
│  │  • convolutionKernel() - Multi-channel FIR convolution      │    │
│  │  • Ring buffer management                                   │    │
│  │  • 24-filter matrix (12 inputs × 2 outputs)                 │    │
│  │  • Warp shuffle reduction                                   │    │
│  │                                                             │    │
│  │ Format Conversion:                                          │    │
│  │  • floatToAudioSampleKernel() - Float to int32              │    │
│  │  • Volume scaling                                           │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Threading Model and Concurrency

**Main Thread (Flask):**
- Handles HTTP requests
- Parameter updates via [backendServer.py](backendServer.py)
- Chart generation (synchronous)
- Short-lived operations

**Background Thread (Synthesis):**
- Created in [/load_preset](backendServer.py#L190) route
- Runs `long_running_procedure()` ([backendServer.py:30](backendServer.py#L30))
- Executes `pianoid.runPianoid()` ([pianoid.py:485](pianoid.py#L485))
- Delegates to `pianoidCuda.runMainApplication()` ([pianoid.py:521](pianoid.py#L521))
- Long-running or infinite duration
- `daemon = False` to keep application alive ([backendServer.py:191](backendServer.py#L191))

**MIDI Thread (Optional):**
- Created when `listen = True` in runPianoid ([pianoid.py:504](pianoid.py#L504))
- Runs `MidiListener.start()` ([pianoidMidiListener.py:55](pianoidMidiListener.py#L55))
- Polls MIDI input via rtmidi
- Calls `pianoid.perform_midi_command()` for events
- Joins with background thread on completion

**Thread Synchronization:**

```python
# pianoid.py:46
self.cuda_lock = threading.Lock()
```

**Protected Operations:**
- All parameter updates to CUDA ([pianoid.py:782](pianoid.py#L782), [837](pianoid.py#L837), [867](pianoid.py#L867))
- Memory transfers (cudaMemcpy)
- Includes sleep delays to allow GPU operations to complete

**Race Condition Prevention:**
```python
# Example from send_updated_params_to_CUDA (pianoid.py:780-784)
with self.cuda_lock:
    strings_in_pitches, state_0, state_1, gauss_params, ... = self.sm.pack_parameters()
    self.pianoid.setUpdatedParameters(physical_parameters, hammer, gauss_params, volume_coefficients)
```

**Global State Management:**
```python
# backendServer.py:15-16
pianoid = None
running = False
```

- `pianoid`: Global Pianoid instance (singleton)
- `running`: Flag to track background thread status
- Modified by Flask routes and background thread
- Not thread-safe by design (single-user assumption)

### 2.3 State Management Strategy

**Application State:**
```python
class Pianoid:
    # Core State
    sm: StringMap              # String physics and geometry
    modes: ModeMap             # Mode oscillators state
    mp: ModelParameters        # System configuration
    pianoid: pianoidCuda       # C++ wrapper instance

    # Runtime State
    listen: bool               # MIDI listening mode
    sustain: int               # Pedal state
    exception: bool            # Error flag
    extract_data: bool         # Debug mode
    fixed_level: int/bool      # Testing mode (fixed velocity)
    fixed_velocity: int        # Testing mode (override MIDI velocity)

    # Result Caching
    result: PianoidResult      # Last extracted data
    sound_buffer: list         # Audio buffer
```

**State Synchronization Points:**

1. **Initialization** ([pianoid.py:537](pianoid.py#L537)):
   ```python
   def init_pianoid():
       # Pack all Python state
       (strings_in_pitches, state_0, state_1, ...) = self.sm.pack_parameters()
       mode_state = self.modes.pack_modes(keep_state=False)

       # Transfer to GPU
       self.pianoid.devMemoryInit(state_0, state_1, mode_state, ...)
   ```

2. **Parameter Updates** ([pianoid.py:835](pianoid.py#L835)):
   ```python
   def update_params_on_cuda():
       with self.cuda_lock:
           # Pack updated parameters
           ..., gauss_params, physical_parameters, hammer, ... = self.sm.pack_parameters()

           # Sync to GPU
           self.pianoid.setNewPhysicalParameters(...)
           self.pianoid.setNewHammerParameters(...)
           self.pianoid.setNewExcitationParameters(...)
   ```

3. **Mode Updates** ([pianoid.py:856](pianoid.py#L856)):
   ```python
   def send_mode_params_to_CUDA(updated_modes={}):
       with self.cuda_lock:
           mode_state = self.modes.pack_modes(updated_modes=updated_modes)
           self.pianoid.setNewModeParameters(mode_state)
   ```

4. **Deck Updates** ([pianoid.py:866](pianoid.py#L866)):
   ```python
   def send_deck_params_to_CUDA():
       with self.cuda_lock:
           deck = self.sm.pack_deck()
           self.pianoid.setNewDeckParameters(deck)
   ```

**State Extraction:**
```python
# PianoidResult.fetch (PanoidResult.py:77)
def fetch(self, length, debug=False):
    self.get_pianoid_state()        # Fetch string states from GPU
    if debug:
        self.get_output_data_from_pianoid()  # Debug data
        self.get_sound_from_pianoid(length)  # Audio samples
        self.get_sound_records_from_pianoid(length)  # Per-string records
```

**Stateless vs Stateful Routes:**

Stateless (no side effects):
- `/health`, `/ping`
- `/get_parameter/*`
- `/get_available_notes`, `/get_string_map`, `/get_settings`
- `/graph_names`, `/command_names`

Stateful (modify pianoid state):
- `/load_preset` - Complete state replacement
- `/set_parameter/*` - Partial state update
- `/play`, `/play_mode` - Transient state (excitation)
- `/reset` - Clear dynamic state
- `/set_velocity` - Modify test mode

Persistent (file I/O):
- `/save_preset` - Serialize state to JSON

### 2.4 Error Propagation Paths

**Error Categories:**

1. **HTTP Errors (Flask Layer):**
```python
# backendServer.py:290-296
try:
    params, status = pianoid.pack_for_interface(parameter, pitches=pitches, modes=modes)
except Exception as e:
    return jsonify(f"Internal error in module: {e}"), 416
```

Status Codes:
- `200` - Success
- `416` - Range/parameter validation error
- `417` - Exception state (Pianoid crashed)
- `457` - Pitch range error
- `499` - Action response (special case)
- `500` - Server error

2. **Middleware Errors (Python Layer):**
```python
# pianoid.py:828-833 (update_pitch_physical_params)
try:
    self.pianoid.setNewPhysicalParameters(...)
except Exception as e:
    print(f"ERROR updating parameters: {e}")
    traceback.print_exc()
    self.exception = True  # Mark as crashed
```

Exception Handling Strategy:
- Print exception and traceback
- Set `self.exception = True`
- Prevent further commands ([backendServer.py:528](backendServer.py#L528))

3. **CUDA Errors (C++ Layer):**
```cpp
// Pianoid.cu:926 (setNewModeParameters)
cudaError_t cudaStatus = cudaMemcpy(...);
if (cudaStatus != cudaSuccess) {
    printf("cudaMemcpy failed! mode_state %s\n", cudaGetErrorString(cudaStatus));
}
```

Error Handling:
- Print CUDA error string
- Continue execution (no exception thrown to Python)
- May result in corrupted state

4. **Application Runtime Errors:**
```python
# pianoid.py:519-525 (run_application)
def run_application(self, num_cycles):
    print("run_application: Application thread started")
    result = self.pianoid.runMainApplication(num_cycles, self.audioOn)
    self.listen = False
    self.exception = True  # Always set on completion/crash
    self.get_result_from_pianoid(length=0, clear=False)
```

On Crash:
- `exception` flag set
- Background thread exits
- `/play` requests rejected with 417 status
- Requires `/load_preset` to recover

**Health Check System:**

```python
# backendServer.py:902-962
@app.route('/health')
def health_check():
    status = {
        'timestamp': time.time() * 1000,
        'pianoid_loaded': pianoid is not None,
        'running': running,
        'exception': False
    }

    if pianoid is None:
        status['status'] = 'not_started'
    else:
        status['exception'] = getattr(pianoid, 'exception', False)
        try:
            available_notes = pianoid.get_all_pitches_in_preset(convert_to_notes=False)
            status['cpp_module_responsive'] = True
            if status['exception']:
                status['status'] = 'crashed'
            else:
                status['status'] = 'healthy'
        except Exception as e:
            status['cpp_module_responsive'] = False
            status['status'] = 'crashed'

    return jsonify(status), 200
```

Health States:
- `not_started` - Pianoid not loaded
- `healthy` - Core loaded and responsive
- `crashed` - Exception state or unresponsive

### 2.5 Data Flow from REST API to CUDA - Complete Trace

**Example: Setting String Tension for Middle C (Pitch 60)**

```
HTTP POST /set_parameter/string/60
Body: {"tension": 725.0, "gamma": 0.05}

↓ Flask Route Handler (backendServer.py:304)
┌──────────────────────────────────────────────────────────┐
│ def set_parameter(parameter, key_no):                    │
│   # Parse range                                          │
│   pitches, modes, err = parse_range(pianoid, "string", "60")  │
│   # pitches = [60], modes = [0..num_modes-1]            │
│                                                          │
│   # Extract JSON body                                    │
│   values = request.get_json()                            │
│   # values = {"tension": 725.0, "gamma": 0.05}          │
│                                                          │
│   # Dispatch to middleware                               │
│   pianoid.update_parameter(                              │
│       "string",                                          │
│       values=values,                                     │
│       pitches=[60],                                      │
│       modes=[0..15]                                      │
│   )                                                      │
└──────────────────────────────────────────────────────────┘

↓ Pianoid Middleware (pianoid.py:998)
┌──────────────────────────────────────────────────────────┐
│ def update_parameter(param, values, pitches, modes):     │
│   if param == 'string' or param == 'physics':            │
│     for pitchID in pitches:  # pitchID = 60             │
│       self.update_pitch_physical_params(                 │
│           60,                                            │
│           send_to_cuda=True,                             │
│           **values  # tension=725.0, gamma=0.05          │
│       )                                                  │
└──────────────────────────────────────────────────────────┘

↓ Physical Parameter Update (pianoid.py:786)
┌──────────────────────────────────────────────────────────┐
│ def update_pitch_physical_params(pitchID, send_to_cuda, **params):  │
│   pitch = self.sm.pitches[60]                            │
│                                                          │
│   # Update Python object                                 │
│   pitch.set_param(tension=725.0, gamma=0.05)            │
│   # pitch.physics.tension = 725.0                        │
│   # pitch.physics.gamma = 0.05                           │
│                                                          │
│   if send_to_cuda:                                       │
│     with self.cuda_lock:  # Thread safety               │
│       # Pack ALL parameters (not just updated ones)      │
│       (strings_in_pitches, state_0, state_1,             │
│        gauss_params, physical_parameters, hammer,        │
│        volume_coefficients, excitation_cycle_index,      │
│        dec_open, stringMap) = self.sm.pack_parameters()  │
│                                                          │
│       # Transfer to GPU                                  │
│       self.pianoid.setNewPhysicalParameters(             │
│           physical_parameters,  # All strings' params    │
│           volume_coefficients                            │
│       )                                                  │
│       self.pianoid.setNewHammerParameters(hammer)        │
│       self.pianoid.setNewExcitationParameters(gauss_params)  │
└──────────────────────────────────────────────────────────┘

↓ C++ CUDA Wrapper (Pianoid.cu:896 via pybind11)
┌──────────────────────────────────────────────────────────┐
│ void Pianoid::setNewPhysicalParameters(                  │
│     const std::vector<real>& physical_parameters,        │
│     const std::vector<real>& volume_coeff)               │
│ {                                                        │
│   cudaError_t cudaStatus;                                │
│   cudaStatus = cudaMemcpy(                               │
│       getRealPointer("dev_physical_parameters"),         │
│       physical_parameters.data(),                        │
│       (numStrings * 16) * sizeof(real),                  │
│       cudaMemcpyHostToDevice                             │
│   );                                                     │
│   if (cudaStatus != cudaSuccess) {                       │
│       printf("cudaMemcpy failed! %s\n",                  │
│              cudaGetErrorString(cudaStatus));            │
│   }                                                      │
│   printf("Physical parameters updated\n");               │
│ }                                                        │
└──────────────────────────────────────────────────────────┘

↓ GPU Memory (Device)
┌──────────────────────────────────────────────────────────┐
│ dev_physical_parameters:                                 │
│   [string_0: tension, rho, r, jung, gamma, ...]          │
│   [string_1: ...]                                        │
│   ...                                                    │
│   [string_60: 725.0, 0.0008, 0.0003, -2e10, 0.05, ...]  │ ← Updated
│   ...                                                    │
│   [string_255: ...]                                      │
│                                                          │
│ ↓ Next synthesis cycle                                   │
│ CUDA Kernel: addArraysKernel reads dev_physical_parameters  │
│ Uses new tension and gamma for string simulation         │
└──────────────────────────────────────────────────────────┘

↓ Response to Client
HTTP 200 OK
{"message": "OK"}
```

**Key Observations:**

1. **Full Pack, Not Delta**: Python packs ALL parameters, not just changed ones
2. **Thread Lock**: CUDA memory transfer protected by `cuda_lock`
3. **Synchronous Update**: Request blocks until GPU memory updated
4. **No Validation**: C++ layer doesn't validate parameter values
5. **Error Handling**: CUDA errors printed but don't fail HTTP request
6. **Side Effects**: Updates are immediate - next synthesis cycle uses new values

---

## 3. REST API Reference

### 3.1 API Overview

**Base URL**: `http://localhost:5000` (default Flask development server)

**Protocol**: HTTP/1.1 with JSON payloads

**CORS**: Enabled for all origins via Flask-CORS ([backendServer.py:21](backendServer.py#L21))

**Authentication**: None (designed for local/trusted network use)

**Content-Type**: `application/json` for all POST requests

### 3.2 Initialization & Lifecycle Endpoints

#### POST /load_preset

Load a complete piano configuration and optionally start synthesis.

**Request Body**:
```json
{
  "path": "presets/Preset.json",
  "listen_to_midi": 0,
  "use_simulation": 0,
  "extract_data": 0,
  "user_1": 384,
  "cycle_iterations": 48,
  "user_3": 2,
  "sample_rate": 48000,
  "string_iterations": 6,
  "volume": 64,
  "audio_on": 1,
  "start_right_away": 1
}
```

**Parameters**:
- `path` (string, required): Path to preset JSON file
- `listen_to_midi` (int, 0 or 1): Enable MIDI listener thread
- `use_simulation` (int, 0 or 1): Use placeholder instead of CUDA (testing)
- `extract_data` (int, 0 or 1): Enable debug data extraction
- `user_1` (int): **Audio driver selection** - 0=default, 1=ASIO, 2=SDL2, 3=SDL3
  - **NOTE:** Only drivers compiled into the build are available
  - See [AUDIO_DRIVER_ARCHITECTURE.md](AUDIO_DRIVER_ARCHITECTURE.md) for details
- `cycle_iterations` (int): Samples per cycle (default 48)
- `user_3` (int): Buffer size (default 2)
- `sample_rate` (int): Sample rate in Hz (e.g., 48000)
- `string_iterations` (int): String physics iterations per cycle
- `volume` (int): Main volume level (0-127)
- `audio_on` (int, 0 or 1): Enable audio output
- `start_right_away` (int, 0 or 1): Start background thread immediately

**Response** (200 OK):
```json
{
  "message": "Preset loaded successfully"
}
```

**Behavior**:
- Destroys existing pianoid instance if present ([backendServer.py:130-135](backendServer.py#L130))
- Creates new Pianoid instance with preset ([backendServer.py:167-176](backendServer.py#L167))
- Optionally starts background synthesis thread ([backendServer.py:188-196](backendServer.py#L188))

**Example**:
```bash
curl -X POST http://localhost:5000/load_preset \
  -H "Content-Type: application/json" \
  -d '{
    "path": "presets/MaximExample.json",
    "sample_rate": 48000,
    "audio_on": 1,
    "start_right_away": 1,
    "listen_to_midi": 0,
    "use_simulation": 0,
    "extract_data": 0,
    "cycle_iterations": 48,
    "string_iterations": 6,
    "volume": 64,
    "user_1": 384,
    "user_3": 2
  }'
```

#### POST /save_preset

Save current piano configuration to file.

**Request Body**:
```json
{
  "path": "presets/MyCustomPreset.json"
}
```

**Response** (200 OK):
```json
{
  "message": "Preset saved successfully"
}
```

**Implementation**: [backendServer.py:241-250](backendServer.py#L241)

#### GET /reset

Reset string and mode states without reloading preset.

**Response** (200 OK):
```json
{
  "message": "Reset successfull"
}
```

**Side Effects**:
- Clears string vibration states
- Resets mode oscillators
- Clears audio buffers
- Does NOT reload preset parameters

**Implementation**: [backendServer.py:253-256](backendServer.py#L253)

#### GET /health

Detailed health check with system status.

**Response** (200 OK):
```json
{
  "timestamp": 1728745632000,
  "pianoid_loaded": true,
  "running": true,
  "exception": false,
  "listen_mode": false,
  "cpp_module_responsive": true,
  "available_notes_count": 88,
  "status": "healthy",
  "message": "Core loaded and responsive"
}
```

**Status Values**:
- `not_started`: Pianoid not loaded
- `healthy`: Core loaded and responsive
- `crashed`: Exception state or C++ module unresponsive

**Implementation**: [backendServer.py:902-962](backendServer.py#L902)

#### GET /ping

Simple connectivity check.

**Response** (200 OK):
```json
{
  "message": "pong",
  "timestamp": 1728745632000
}
```

### 3.3 Parameter Management Endpoints

#### GET /get_parameter/\<parameter\>/\<key_no\>

Retrieve parameter values for specified range.

**URL Parameters**:
- `parameter`: Parameter type (see table below)
- `key_no`: Pitch/mode range (integer, "all", "output", or "from\<N\>to\<M\>")

**Parameter Types**:

| Type | Description | key_no Interpretation |
|------|-------------|----------------------|
| `string` | String physical parameters | Pitch number |
| `mode` | Mode oscillator parameters | Mode number |
| `gauss` | Temporal excitation (base levels) | Pitch number |
| `gauss_full` | Temporal excitation (all 128 levels) | Pitch number |
| `gauss_flat` | Temporal excitation (flat array) | Pitch number |
| `hammer` | Spatial excitation shape | Pitch number |
| `excitation` | Combined temporal + spatial | Pitch number |
| `feedin` | Mode → String coupling | Pitch number |
| `feedback` | String → Mode coupling | Pitch number |
| `output` | External sound output | "all" or "output" |

**Range Syntax**:
- Single: `"60"` (middle C)
- Range: `"from21to108"` (full piano range)
- All: `"all"` (all available pitches/modes)
- Output: `"output"` (sound output pitches only, for feedback parameter)

**Response Example** (GET /get_parameter/string/60):
```json
{
  "60": {
    "length": 1.04,
    "tail": 0.15,
    "tension": 725.0,
    "rho": 0.00078,
    "r": 0.0003,
    "jung": -20000000000,
    "gamma": 0.05,
    "dispersion_damping": 1e-13,
    "detuning": 0.001,
    "volume_coefficient": 1.0,
    "damper_string": 1e-6,
    "damper_tail": 1e-6
  }
}
```

**Implementation**: [backendServer.py:260-301](backendServer.py#L260)

**Error Responses**:
- 416: Range parsing error or parameter validation failed

#### POST /set_parameter/\<parameter\>/\<key_no\>

Update parameter values for specified range.

**URL Parameters**: Same as GET /get_parameter

**Request Body**: Dictionary mapping pitch/mode IDs to parameter objects

**Example** (POST /set_parameter/string/60):
```json
{
  "60": {
    "tension": 725.0,
    "gamma": 0.05,
    "volume_coefficient": 1.2
  }
}
```

**Example** (POST /set_parameter/mode/from0to15):
```json
{
  "0": {"frequency": 100.5, "decrement": 0.8},
  "1": {"frequency": 250.3, "decrement": 0.7},
  ...
  "15": {"frequency": 3200.1, "decrement": 1.2}
}
```

**Response** (200 OK):
```json
{
  "message": "OK"
}
```

**Error Responses**:
- 416: Parameter validation failed or internal error
- Error message contains traceback for debugging

**Side Effects**:
- Immediately updates GPU memory
- Changes take effect on next synthesis cycle
- Thread-safe via cuda_lock

**Implementation**: [backendServer.py:304-340](backendServer.py#L304)

### 3.4 Playback Control Endpoints

#### POST /play

Trigger note on/off via REST API.

**Request Body**:
```json
{
  "pitch": 60,
  "command": 144,
  "velocity": 100
}
```

**Parameters**:
- `pitch` (int, 21-108): MIDI pitch number
- `command` (int): 144 = note on, 128 = note off
- `velocity` (int, 0-127): Note velocity (0-127)

**Response** (200 OK):
```json
{
  "Message": "OK"
}
```

**Error Responses**:
- 417: Pianoid in exception state

**Behavior**:
- Debouncing: Ignores duplicate (pitch, command) pairs ([backendServer.py:540-543](backendServer.py#L540))
- MIDI override: Ignored when `listen_to_midi` is active
- Debug mode: Extracts data on note off if `extract_data` enabled ([backendServer.py:552-556](backendServer.py#L552))

**Implementation**: [backendServer.py:517-563](backendServer.py#L517)

#### POST /play_mode/\<mode_no\>

Directly trigger a mode oscillator.

**URL Parameters**:
- `mode_no` (int): Mode number to trigger

**Response** (200 OK):
```json
{
  "Message": "OK"
}
```

**Implementation**: [backendServer.py:566-577](backendServer.py#L566)

#### POST /set_velocity/\<velocity\>

Set fixed velocity for testing (overrides MIDI velocity).

**URL Parameters**:
- `velocity` (int, 0-127): Fixed velocity value

**Response** (200 OK):
```json
{
  "Message": "OK"
}
```

**Implementation**: [backendServer.py:511-514](backendServer.py#L511)

### 3.5 Configuration Endpoints

#### POST /set_deck/\<matrix\>

Update feedin or feedback coupling matrices.

**URL Parameters**:
- `matrix` (string): "feedin" or "feedback"

**Request Body**:
```json
{
  "pitch": "all",
  "values": [[0.5, 0.3, 0.2, ...], ...]
}
```

**Parameters**:
- `pitch`: "all", integer, or [start, stop] tuple
- `values`: NumPy-compatible array of coupling coefficients
  - Shape: (num_pitches, num_modes) for specified pitches

**Response** (200 OK):
```json
{
  "message": "feedin set successfully"
}
```

**Error Responses**:
- 457: Invalid pitch range

**Implementation**: [backendServer.py:346-388](backendServer.py#L346)

#### POST /set_hammer_shape/\<pitch_no\>

Update hammer shape parameters for a note.

**URL Parameters**:
- `pitch_no` (int): Pitch number

**Request Body**:
```json
{
  "shape": "circular",
  "width": 0.015,
  "position": 0.12,
  "sharpness": 0.5
}
```

**Parameters**:
- `shape` (string): "circular" (only supported type currently)
- `width` (float): Hammer width in meters
- `position` (float): Distance from string start (0.0-1.0 normalized)
- `sharpness` (float, 0-1): Curvature (0=flat, 1=sharp)

**Response** (200 OK):
```json
{
  "Message": "OK",
  "Width": 0.015
}
```

**Implementation**: [backendServer.py:433-455](backendServer.py#L433)

#### POST /set_mode_parameters

Update mode oscillator parameters.

**Request Body**: Array of mode parameter objects
```json
[
  {
    "mode": 0,
    "parameters": {
      "frequency": 100.5,
      "decrement": 0.8,
      "mass": 1.0,
      "stiffness": 50000
    }
  },
  {
    "mode": 1,
    "parameters": {
      "frequency": 250.3,
      "decrement": 0.7
    }
  }
]
```

**Response** (200 OK):
```json
{
  "Message": "OK"
}
```

**Side Effects**:
- Calls `mode.update_params()` for each mode
- Triggers mode oscillator ([backendServer.py:471](backendServer.py#L471))
- Syncs to CUDA ([backendServer.py:472](backendServer.py#L472))

**Implementation**: [backendServer.py:457-474](backendServer.py#L457)

#### POST /set_string_parameters

Update string physical parameters.

**Request Body**: Array of pitch parameter objects
```json
[
  {
    "pitch": 60,
    "parameters": {
      "tension": 725.0,
      "gamma": 0.05,
      "jung": -20000000000,
      "r": 0.0003,
      "length": 1.04,
      "volume_coefficient": 1.0,
      "detuning": 0.001
    }
  }
]
```

**Special Parameters**:
- `__modeID` (int): Associated mode number for coupling
- `__outer_sound` (float): Sound output feedback coefficient
- `level` (int): Velocity level for volume coefficient application

**Response** (200 OK):
```json
{
  "Message": "OK"
}
```

**Implementation**: [backendServer.py:476-509](backendServer.py#L476)

### 3.6 Visualization Endpoints

#### POST /get_chart_test

Generate visualization charts or execute actions.

**Request Body**:
```json
{
  "chartType": "sound",
  "length": 24000,
  "channel": 0
}
```

**Common Parameters**:
- `chartType` (string, required): Chart or action type name
- Additional parameters depend on chart type (extracted via ChartParameter definitions)

**Response** (200 OK for charts):
```json
{
  "data": [[0.1, 0.2, 0.15, ...], [...]],
  "general_header": "Sound record",
  "text_fields": {
    "Sound obtained": "Length 500.00 ms, channels 12",
    "Sound displayed": "Length 500.00 ms, channel 0"
  },
  "chart_headers": ["", ...],
  "audio_data": ["base64_encoded_wav_data", null, ...]
}
```

**Response** (499 for actions):
```json
{
  "status": "success",
  "message": "Action completed"
}
```

**Built-in Chart Types**:
- `sound`: Audio waveform with embedded playback
- `string_shape`: String state visualization
- `feedin`: Mode coupling analysis
- `filter_test`: FIR filter testing
- `profiling_data`: Performance analysis
- `block_output_data`: Internal state inspection

**Built-in Actions**:
- `filter_action`: Enable/disable FIR filter
- `profiling_action`: Start/stop profiling
- `add_chart_type` / `add_action_type`: Runtime extension

**Implementation**: [backendServer.py:621-650](backendServer.py#L621)

**Error Responses**:
- 416: Chart type not found or processing error

#### GET /graph_names

List available chart types and actions.

**Response** (200 OK):
```json
{
  "graphs": [
    {
      "name": "sound",
      "label": "Sound Analysis",
      "parameters": [
        {"name": "length", "type": "number", "label": "Length", "defaultValue": 10000},
        {"name": "channel", "type": "number", "label": "Channel Number", "defaultValue": 0}
      ]
    }
  ],
  "actions": [
    {
      "name": "filter_action",
      "label": "FIR Filter Control",
      "parameters": [
        {"name": "toggle", "type": "boolean", "label": "Enable Filter", "defaultValue": true},
        {"name": "file", "type": "string", "label": "Filter File", "defaultValue": ""}
      ]
    }
  ],
  "message": "OK"
}
```

**Implementation**: [backendServer.py:211-236](backendServer.py#L211)

#### GET /command_names

List available frontend commands (legacy, minimal).

**Response** (200 OK):
```json
{
  "commands": ["volume"],
  "message": "OK"
}
```

### 3.7 Metadata Endpoints

#### GET /get_available_notes

Get list of available MIDI pitches in current preset.

**Response** (200 OK):
```json
[21, 22, 23, ..., 108]
```

**Implementation**: [backendServer.py:606-609](backendServer.py#L606)

#### GET /get_string_map

Get complete string-to-pitch mapping.

**Response** (200 OK):
```json
{
  "pitch_index": [21, 22, 23, ...],
  "string_index": [0, 1, 2, ...],
  "blocks": [...]
}
```

**Implementation**: [backendServer.py:611-614](backendServer.py#L611)

#### GET /get_settings

Get system configuration settings (minimal implementation).

**Response** (200 OK):
```json
{
  "path": "",
  "volume": "",
  "sample_rate": "",
  "string_iterations": 6,
  "use_simulation": 0,
  "extract_data": 0,
  "listen_to_midi": 0
}
```

**Implementation**: [backendServer.py:111-122](backendServer.py#L111)

### 3.8 CORS Configuration

All endpoints support cross-origin requests via Flask-CORS:

```python
# backendServer.py:21
CORS(app)
```

**Headers Automatically Added**:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

**Preflight Requests**: Automatically handled for POST routes

### 3.9 Error Response Format

**Standard Error Response**:
```json
{
  "message": "Error description"
}
```

**Status Codes**:
- `200`: Success
- `416`: Parameter validation error
- `417`: Pianoid in exception state
- `457`: Pitch range error
- `499`: Action response (special case, not an error)
- `500`: Internal server error

**Error Examples**:

```bash
# Invalid range
GET /get_parameter/string/999
→ 416: {"message": "Wrong range for pitches, available 21 to 108 requested 999"}

# Exception state
POST /play {"pitch": 60, "command": 144, "velocity": 100}
→ 417: {"Message": "Pianoid in exception state"}

# Internal error
POST /set_parameter/string/60 {"60": {"invalid_param": 123}}
→ 416: {"message": "Set parameter route: Internal error in module pianoid.py: ..."}
```

---## 4. Middleware Layer Deep Dive

### 4.1 Pianoid Class Lifecycle

The `Pianoid` class ([pianoid.py:44](pianoid.py#L44)) serves as the central orchestrator for all synthesis operations. Understanding its lifecycle is crucial for integration.

**Initialization Sequence:**

```python
# 1. Object Creation (pianoid.py:44-111)
pianoid = Pianoid()

# 2. Load Preset (pianoid.py:114-147)
pianoid.initialize(
    path="presets/Preset.json",
    audioOn=True,
    volume=64,
    sample_rate=48000,
    # ... other parameters
)

# 3. Internal Setup (pianoid.py:537-625)
pianoid.init_pianoid()
# Creates pianoidCuda.Pianoid instance
# Allocates GPU memory
# Transfers initial parameters

# 4. Start Synthesis (pianoid.py:485-532)
pianoid.runPianoid(
    num_cycles=0,  # 0 = infinite
    listen=False,  # MIDI input
    audioOn=True
)
```

**Key Instance Variables:**

```python
class Pianoid:
    # Core Components
    sm: StringMap              # String physics and layout
    modes: ModeMap             # Modal oscillators
    mp: ModelParameters        # System configuration
    pianoid: pianoidCuda       # C++ CUDA wrapper

    # State Management
    listen: bool               # MIDI mode
    sustain: int               # Pedal state (0-127)
    exception: bool            # Crash flag
    extract_data: bool         # Debug mode
    fixed_level: int/bool      # Test mode flag
    fixed_velocity: int        # Override MIDI velocity

    # Data Extraction
    result: PianoidResult      # Last extracted data
    sound_buffer: list         # Audio cache

    # Thread Safety
    cuda_lock: threading.Lock  # Parameter update protection
```

**State Transitions:**

```
┌──────────────┐
│  Uninitialized│
└──────┬───────┘
       │ initialize()
       ↓
┌──────────────┐
│  Initialized  │────┐
└──────┬───────┘    │ reset()
       │            └─────┘
       │ runPianoid()
       ↓
┌──────────────┐
│   Running     │←───┐
└──────┬───────┘    │ (background thread)
       │            │
       │ exception  │ perform_midi_command()
       │   or       │ update_parameter()
       │ stopApplication()
       ↓            │
┌──────────────┐    │
│  Crashed      │    │
└──────┬───────┘    │
       │            │
       │ initialize()
       ↓            │
   (restart)    ────┘
```

### 4.2 Parameter Update Routing

The parameter update system is one of the most complex parts of PianoidCore. It handles routing parameter changes from the REST API through to GPU memory.

**Update Flow Architecture:**

```
REST API Request
    ↓
parse_range() → [pitch_list, mode_list]
    ↓
pianoid.update_parameter(type, values, pitches, modes)
    ↓
┌────────────────────────────────────────┐
│       Parameter Type Dispatcher        │
├────────────────────────────────────────┤
│ "string"/"physics"                     │
│   → update_pitch_physical_params()     │
│                                        │
│ "mode"                                 │
│   → update_mode_params()               │
│                                        │
│ "hammer"                               │
│   → sm.update_hammer_shape()           │
│                                        │
│ "gauss"/"gauss_full"/"gauss_flat"      │
│   → sm.update_excitation_gauss_param() │
│                                        │
│ "feedin"/"feedback"                    │
│   → sm.update_deck()                   │
│                                        │
│ "excitation"                           │
│   → update_excitation_with_velocity()  │
└────────────────────────────────────────┘
    ↓
Update Python Objects (StringMap, ModeMap)
    ↓
with cuda_lock:
    Pack Parameters
    Transfer to GPU
    ↓
CUDA Memory Updated
```

**Implementation Details:**

**1. Range Parsing** ([backendServer.py:656-774](backendServer.py#L656)):

```python
def parse_range(pianoid, parameter, key_no):
    """
    Parse pitch/mode range specifications.

    Examples:
        "60" → [60], [0..num_modes-1]
        "all" → [21..108], [0..num_modes-1]
        "from21to108" → [21..108], [...]
        "output" → [output_pitches], [...]
    """
    if key_no == 'all':
        pitches = pianoid.get_all_pitches_in_preset(convert_to_notes=False)
        modes = [i for i in range(pianoid.modes.num_modes)]
    elif key_no == 'output':
        # Special case for feedback parameter
        pitches = pianoid.sm.soundChannelModes.pitch_map()
        modes = pianoid.sm.soundChannelModes.mode_map()
    elif 'from' in key_no and 'to' in key_no:
        # Parse range like "from21to108"
        start = int(key_no.split('from')[1].split('to')[0])
        stop = int(key_no.split('to')[1])
        pitches = [i for i in range(start, stop+1)]
        modes = [i for i in range(pianoid.modes.num_modes)]
    else:
        # Single value
        pitches = [int(key_no)]
        modes = [int(key_no)]

    return pitches, modes, None  # None = no error
```

**2. Physical Parameter Updates** ([pianoid.py:786-833](pianoid.py#L786)):

```python
def update_pitch_physical_params(self, pitchID, send_to_cuda=True, **params):
    """
    Update string physics parameters.

    Key Design: Updates ALL parameters to GPU, not just changed ones.
    This ensures consistency but has performance implications.
    """
    # Update Python object
    pitch = self.sm.pitches[pitchID]
    pitch.set_param(**params)

    if send_to_cuda:
        with self.cuda_lock:
            # Pack ALL strings (not just updated pitch)
            (strings_in_pitches, state_0, state_1, gauss_params,
             physical_parameters, hammer, volume_coefficients,
             excitation_cycle_index, dec_open, stringMap) = \
                self.sm.pack_parameters()

            # Transfer to GPU
            self.pianoid.setNewPhysicalParameters(
                physical_parameters, volume_coefficients)
            self.pianoid.setNewHammerParameters(hammer)
            self.pianoid.setNewExcitationParameters(gauss_params)

            # Allow GPU to process
            time.sleep(0.02)
```

**Critical Points:**
- Full pack, not delta updates
- Thread-safe with cuda_lock
- Sleep delay for GPU processing
- No rollback on error

**3. Mode Parameter Updates** ([pianoid.py:856-863](pianoid.py#L856)):

```python
def send_mode_params_to_CUDA(self, updated_modes={}, keep_state=True):
    """
    Update mode oscillator parameters.

    updated_modes format:
    {
        mode_id: [state, state_1, dec, omega, mass]
        # 'keep' for unchanged values
    }
    """
    with self.cuda_lock:
        mode_state = self.modes.pack_modes(
            updated_modes=updated_modes,
            keep_state=keep_state
        )
        self.pianoid.setNewModeParameters(mode_state)
        time.sleep(0.02)
```

**4. Deck (Coupling) Updates** ([pianoid.py:866-873](pianoid.py#L866)):

```python
def send_deck_params_to_CUDA(self, feedin_coeff=1,
                             feedback_coeff=1, feedbackOFF=False):
    """
    Update mode-string coupling coefficients.
    """
    with self.cuda_lock:
        deck = self.sm.pack_deck()
        self.pianoid.setNewDeckParameters(deck)
        time.sleep(0.02)
```

### 4.3 Chart Generation System

The chart system provides dynamic visualization and action execution capabilities.

**Architecture:**

```
ChartTypeRegistry (chart_config.json)
    ├─ Chart Types (visualization)
    │   ├─ name, label, parameters[]
    │   ├─ function_module, function_name
    │   └─ Returns: charts, header, text_fields
    │
    └─ Action Types (operations)
        ├─ name, label, parameters[]
        ├─ function_module, function_name
        └─ Returns: status dict
```

**ChartType Definition** ([ChartRegistry.py:9-117](ChartRegistry.py#L9)):

```python
class ChartType:
    def __init__(self, name, label, is_action=False,
                 parameters=None, **kwargs):
        self.name = name          # Unique identifier
        self.label = label        # Display name
        self.is_action = is_action
        self.parameters = []      # ChartParameter objects

        # Function loading
        self.function_module = kwargs.get('function_module',
                                         'chartFunctions')
        self.function_name = kwargs.get('function_name',
                                       f"{name}_function")
```

**ChartParameter Definition** ([ChartRegistry.py:120-169](ChartRegistry.py#L120)):

```python
class ChartParameter:
    def __init__(self, name, paramType, label, defaultValue,
                 enum=None, **kwargs):
        self.name = name             # Parameter name
        self.type = paramType        # number, string, boolean, enum
        self.label = label           # Display label
        self.defaultValue = defaultValue
        self.enum = enum             # For dropdown options
```

**Chart Function Implementation Pattern:**

```python
# chartFunctions.py
def my_chart_function(pianoid, **kwargs):
    """
    Standard chart function signature.

    Args:
        pianoid: Pianoid instance
        **kwargs: Parameters extracted from request

    Returns:
        (charts, top_header, text_fields)
    """
    # Extract parameters
    param1 = kwargs.get('param1', default_value)
    param2 = kwargs.get('param2', default_value)

    # Create chart array
    charts = ChartArray()

    # Generate data
    data = get_some_data(pianoid, param1, param2)
    charts.append_chart("My Chart", data)

    # Add audio embedding if needed
    charts.create_audio_to_chart('all',
                                sample_rate=pianoid.mp.sample_rate())

    # Prepare response
    top_header = "My Visualization"
    text_fields = {
        "Param 1": str(param1),
        "Param 2": str(param2),
        "Data Length": str(len(data))
    }

    return charts, top_header, text_fields
```

**ChartArray Class** ([ChartRegistry.py:172-256](ChartRegistry.py#L172)):

```python
class ChartArray:
    def __init__(self):
        self.data = []
        self.chart_headers = []
        self.audio_data = []

    def append_chart(self, header, data):
        """Add a chart with optional header."""
        self.data.append(data)
        self.chart_headers.append(header)
        self.audio_data.append(None)

    def create_audio_to_chart(self, option='all', sample_rate=48000):
        """Embed audio data as base64-encoded WAV."""
        for i, chart_data in enumerate(self.data):
            if option == 'all' or i in option:
                wav_base64 = self._encode_audio(chart_data, sample_rate)
                self.audio_data[i] = wav_base64
```

**Dynamic Function Loading** ([ChartGenerator.py:11-22](ChartGenerator.py#L11)):

```python
def load_function(chart_type: ChartType):
    """
    Dynamically import and load chart function.
    """
    module_name = chart_type.function_module
    function_name = chart_type.function_name

    # Import module
    module = importlib.import_module(module_name)

    # Get function
    func = getattr(module, function_name)

    return func
```

**Request Processing** ([ChartGenerator.py:23-70](ChartGenerator.py#L23)):

```python
def get_response(pianoid, chart_registry, request_data):
    """
    Process chart/action request and generate response.
    """
    chart_type_name = request_data.get('chartType')
    chart_type = chart_registry.get_type(chart_type_name)

    # Extract parameters
    kwargs = {}
    for param in chart_type.parameters:
        value = request_data.get(param.name, param.defaultValue)
        kwargs[param.name] = value

    # Load and execute function
    func = load_function(chart_type)

    if chart_type.is_action:
        # Action: return status dict
        result = perform_action(pianoid, chart_registry,
                               chart_type, **kwargs)
        return result, 499  # Special status for actions
    else:
        # Chart: return visualization data
        charts, header, text_fields = func(pianoid, **kwargs)
        response = {
            "data": charts.data,
            "general_header": header,
            "text_fields": text_fields,
            "chart_headers": charts.chart_headers,
            "audio_data": charts.audio_data
        }
        return response, 200
```

**Example: Sound Chart** ([chartFunctions.py:7-23](chartFunctions.py#L7)):

```python
def sound_function(pianoid, **kwargs):
    """Visualize synthesized audio."""
    charts = ChartArray()
    length = kwargs.get('length', 24000)
    channel = kwargs.get('channel', 0)

    # Get sound from result cache
    sound = pianoid.result.get_sound(channel=-1)
    data = sound[channel][:length]

    sr = pianoid.mp.sample_rate() / 1000
    text_fields = {
        "Sound obtained": f"Length {sound.shape[1]/sr:.2f} ms, channels {sound.shape[0]}",
        "Sound displayed": f"Length {len(data)/sr:.2f} ms, channel {channel}"
    }

    charts.append_chart("", data)
    charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())

    top_header = "Sound record"
    return charts, top_header, text_fields
```

### 4.4 MIDI Processing Pipeline

The MIDI system ([pianoidMidiListener.py](pianoidMidiListener.py)) provides real-time input from MIDI controllers.

**MIDI Listener Architecture:**

```
MIDI Controller
    ↓ (USB/Serial)
rtmidi Library
    ↓
MidiListener Thread
    ↓
Command Mapping (YAML config)
    ↓
Action Functions
    ↓
Pianoid.perform_midi_command()
    ↓
pianoidCuda.processMidiPoints()
```

**MidiListener Class** ([pianoidMidiListener.py:8-49](pianoidMidiListener.py#L8)):

```python
class MidiListener:
    def __init__(self, parent=None):
        self.p = parent  # Pianoid instance

        # Initialize rtmidi
        self.midi_in = rtmidi.MidiIn()
        available_ports = self.midi_in.get_ports()

        if available_ports:
            self.midi_in.open_port(0)
            self.keyboard_name = available_ports[0].split()[0]
        else:
            raise RuntimeError("No MIDI input ports available")

        # Load keyboard configuration
        self.set_keyboard(self.keyboard_name)
```

**MIDI Event Loop** ([pianoidMidiListener.py:55-96](pianoidMidiListener.py#L55)):

```python
def start(self):
    """Main MIDI processing loop."""
    self.active_pitch = 57
    self.dumper = 127

    while self.p.pianoid.isApplicationRunning():
        self.play = False
        msg = self.midi_in.get_message()

        if msg:
            midi_data, delta_time = msg
        else:
            continue

        # Parse MIDI message
        command = midi_data[0]
        channel = command & 0x0F
        pitch = midi_data[1]
        velocity = midi_data[2]

        # Execute mapped action
        self.perform_action(command, pitch, velocity)

        # If note event, send to CUDA
        if self.play and command in (128, 144):
            midi_command = [1, pitch, 0, 0, self.dumper, velocity_mapped]
            index = 0
            self.p.pianoid.processMidiPoints(midi_command, index)

        time.sleep(0.01)
```

**Keyboard Configuration** (YAML format):

```yaml
# keyboard_config.yaml
set_params:
  num_mode: 16
  num_note: 88

note_on:
  command: 144
  pitch: any

note_off:
  command: 128
  pitch: any

sustain:
  command: 176
  pitch: 64

mode_pad:
  command: 144
  pitch: range
  low_pitch: 36

stop_pianoid:
  command: 144
  pitch: 48
```

**Action Mapping** ([pianoidMidiListener.py:178-236](pianoidMidiListener.py#L178)):

```python
def read_config(self, file_name, pitches_in_preset):
    """
    Parse YAML config and build command→action mapping.

    Returns command_dict:
    {
        144: {  # Note On
            60: "note_on",
            61: "note_on",
            ...,
            36: "mode_pad",  # Mode triggers
            48: "stop_pianoid"
        },
        128: {  # Note Off
            60: "note_off",
            ...
        },
        176: {  # Control Change
            64: "sustain",
            7: "main_volume"
        }
    }
    """
    # Load YAML
    with open(file_name, 'r') as file:
        kb_conf = yaml.safe_load(file)

    # Build mapping
    com_dict = {}
    for action, data in kb_conf.items():
        if action == 'set_params':
            continue

        command = data['command']
        pitch = data['pitch']

        if pitch == 'any':
            pitch_range = range(0, 128)
        elif pitch == 'range':
            low = data['low_pitch']
            high = low + getattr(self, f"num_{action.split('_')[0]}")
            pitch_range = range(low, high)
        else:
            pitch_range = [int(pitch)]

        if command not in com_dict:
            com_dict[command] = {}

        for p in pitch_range:
            com_dict[command][p] = action

    return kb_conf, com_dict
```

**Example MIDI Actions** ([pianoidMidiListener.py:303-319](pianoidMidiListener.py#L303)):

```python
def note_on(self, pitch, velocity):
    """Handle note on event."""
    self.dumper = 1  # Damper released
    if self.p.fixed_velocity >= 0:
        self.velocity = self.p.fixed_velocity

    if self.active_pitch != pitch:
        self.active_pitch = pitch
        print(f"New active note: {pitch}")

    self.play = True

def note_off(self, pitch, velocity):
    """Handle note off event."""
    self.dumper = 127  # Damper engaged
    self.velocity = 0
    self.p.get_result_from_pianoid(100)
    self.play = True

def sustain(self, pitch, velocity):
    """Handle sustain pedal."""
    sustain_value = max(127 - velocity, 1)
    self.p.pianoid.processSustain(sustain_value)
```

### 4.5 Preset Management

Presets store complete piano configurations in JSON format.

**Preset Structure:**

```json
{
  "strings": {
    "21": {  // Pitch number
      "physics": {
        "length": 2.04,
        "tail": 0.15,
        "tension": 185.0,
        "rho": 0.00387,
        "r": 0.00095,
        "jung": -20000000000,
        "gamma": 0.05,
        "dispersion_damping": 1e-13,
        "detuning": 0.001,
        "volume_coefficient": 1.0,
        "damper_string": 1e-6,
        "damper_tail": 1e-6
      },
      "hammer": {
        "shape": "circular",
        "width": 0.025,
        "position": 0.125,
        "sharpness": 0.5
      },
      "excitation": {
        "base_level": [[...], [...], ...],  // 128 levels
        "amplitudes": [1.0, 0.5, 0.2, ...],
        "positions": [0.001, 0.002, ...],
        "widths": [0.0001, 0.0001, ...]
      },
      "deck": {
        "feedin": [0.5, 0.3, 0.2, ...],  // num_modes values
        "feedback": [1e-6, 2e-6, ...]
      }
    },
    "22": {...},
    ...
  },
  "modes": {
    "0": {
      "frequency": 100.5,
      "decrement": 0.8,
      "mass": 1.0,
      "stiffness": 50000,
      "damping": 0.1
    },
    ...
  },
  "model_parameters": {
    "sample_rate": 48000,
    "array_size": 384,
    "num_modes": 16,
    "mode_iteration": 48,
    "num_channels": 12
  }
}
```

**Loading Process** ([pianoid.py:114-147](pianoid.py#L114)):

```python
def initialize(self, path, audioOn=True, volume=64,
               sample_rate=48000, **kwargs):
    """
    Load preset and initialize synthesis engine.
    """
    # 1. Create ModelParameters
    self.mp = ModelParameters(
        preset=path,
        sample_rate=sample_rate,
        array_size=kwargs.get('user_1', 384),
        mode_iteration=kwargs.get('cycle_iterations', 48),
        num_channels=kwargs.get('user_3', 2),
        string_iterations=kwargs.get('string_iterations', 6)
    )

    # 2. Load StringMap (pitches with physics)
    self.sm = StringMap(path, mp=self.mp, **kwargs)

    # 3. Load ModeMap
    self.modes = ModeMap(self.mp, preset=path)

    # 4. Initialize CUDA engine
    self.init_pianoid(
        feedbackOFF=True,
        main_volume=volume,
        firFilterLength=kwargs.get('fir_filter_length', 0)
    )

    # 5. Create result extractor
    self.result = PianoidResult(
        self.pianoid,
        self.mp,
        num_records=4
    )
```

**Saving Process** ([pianoid.py:149-152](pianoid.py#L149)):

```python
def save_preset(self, path):
    """Save current configuration to JSON file."""
    self.sm.save_preset(path, self.modes)
```

The StringMap.save_preset() method serializes all pitch parameters, mode parameters, and model configuration to JSON format.

---

## 5. PianoidBasic Integration

### 5.1 Overview of PianoidBasic

**PianoidBasic** is the physics simulation library that PianoidCore depends on. It provides the high-level abstractions for piano string physics and modal synthesis.

**Key Components:**
- **StringMap**: Container for all piano strings (Pitch objects)
- **Pitch**: Individual note abstraction with physics
- **ModeMap** / **Piano_mode**: Modal oscillators for soundboard
- **ModelParameters**: System configuration
- **PianoidSimulation**: High-level simulation interface (not used by PianoidCore)

### 5.2 Key Classes and Usage

#### StringMap (Pianoid.StringMap)

Manages the collection of all piano strings and their mapping to computation blocks.

**Initialization**:
```python
# pianoid.py:128
self.sm = StringMap(path, mp=self.mp)
```

**Key Methods Used by PianoidCore:**

```python
# Pack all parameters for CUDA transfer
(strings_in_pitches, state_0, state_1, gauss_params,
 physical_parameters, hammer, volume_coefficients,
 excitation_cycle_index, dec_open, stringMap) = sm.pack_parameters()

# Pack coupling coefficients
deck = sm.pack_deck()  # Returns [feedin_data] + [feedback_data]

# Update operations
sm.update_hammer_shape(pitchID, shape, width, position, sharpness)
sm.update_deck(pitch, deck_type, values)
sm.update_excitation_gauss_param(pitchID, level, values)

# Querying
pitches = sm.get_all_pitches()
string_ids = sm.get_string_IDs(pitchID)
```

**String-to-Block Mapping:**

PianoidBasic uses a "block" system to efficiently organize strings in GPU memory:

```python
# Each block contains multiple strings
num_blocks = ceil(num_strings / strings_per_block)

# StringMap tracks:
- pitch_index: [21, 22, 23, ...]  # Available pitches
- string_index: [0, 1, 2, ...]    # String IDs
- blocks: Mapping of strings to computation blocks
```

#### Pitch (Pianoid.Pitch)

Represents a single piano note with all its parameters.

**Structure:**

```python
pitch = sm.pitches[60]  # Middle C

# Physics parameters
pitch.physics.length       # String length (m)
pitch.physics.tail         # Free tail length
pitch.physics.tension      # String tension (N)
pitch.physics.rho          # Linear density (kg/m)
pitch.physics.r            # Radius (m)
pitch.physics.jung         # Stiffness coefficient
pitch.physics.gamma        # Damping coefficient

# Geometry
pitch.hammer_position      # Normalized (0-1)
pitch.hammer_width         # Meters
pitch.hammer_sharpness     # 0-1

# Excitation
pitch.excitation           # ExcitationParameters object
pitch.deck['feedin']       # Mode coupling array
pitch.deck['feedback']     # Feedback array

# Methods
pitch.set_param(tension=725.0, gamma=0.05)  # Update physics
pitch.pack_physical_params()  # Serialize for CUDA
```

#### ModeMap and Piano_mode

Modal synthesis components for soundboard resonance.

**Structure:**

```python
modes = ModeMap(mp, preset=path)

# Access individual modes
mode = modes.modes[0]
mode.frequency    # Hz
mode.decrement    # Damping factor
mode.mass         # Physical mass
mode.stiffness    # Spring constant
mode.state        # Current oscillator state
mode.state_1      # Previous state

# Pack for CUDA
mode_state = modes.pack_modes(keep_state=False)
# Returns: [all_state, all_state_1, all_dec, all_omega, all_mass]
```

**Mode Oscillator Physics:**

Each mode is a damped harmonic oscillator:

```
y''(t) + 2*dec*y'(t) + omega²*y(t) = excitation

Where:
  dec = dt * decrement * frequency
  omega = dt² * frequency² * K_OMEGA
  dt = 1 / sample_rate
```

#### ModelParameters

System configuration container.

```python
mp = ModelParameters(
    preset=path,
    sample_rate=48000,
    array_size=384,
    mode_iteration=48,
    num_channels=12,
    string_iterations=6
)

# Key attributes
mp.sample_rate()          # Sample rate (Hz)
mp.array_size             # Points per string
mp.num_modes              # Number of modes
mp.mode_iteration         # Samples per cycle
mp.num_strings            # Total strings
mp.num_channels           # Output channels
mp.listen_to_modes        # Mode output flag
```

### 5.3 Data Structure Mappings

**Physics Parameter Packing:**

PianoidBasic packages parameters into flat arrays for CUDA transfer:

```python
# Physical parameters (16 per string)
physical_parameters = [
    length, tail, tension, rho, r, jung, gamma,
    dispersion_damping, 0, 0, detuning, volume_coefficient,
    damper_string, damper_tail, 0, 0
] * num_strings

# Gauss (excitation) parameters (24 per string)
gauss_params = [
    amplitude_0, position_0, width_0,
    amplitude_1, position_1, width_1,
    ...  # 8 Gaussians
] * num_strings

# Hammer shape (8 per string)
hammer = [
    width, position, sharpness, shape_type,
    0, 0, 0, 0
] * num_strings
```

**Mode State Packing:**

```python
# Mode state (5 fields per mode, transposed)
mode_state = pack_modes()
# Structure: [all_state, all_state_1, all_dec, all_omega, all_mass]
# Size: num_modes * 5
```

**Deck Parameter Packing:**

```python
# Coupling coefficients
deck = pack_deck()
# Structure: [all_feedin, all_feedback]
# all_feedin: num_strings * num_modes values
# all_feedback: num_strings * num_modes values
# Size: num_strings * num_modes * 2
```

### 5.4 Physics Parameter Interpretation

**String Physics:**

```
Wave equation with stiffness:
∂²u/∂t² = (T/ρ) * ∂²u/∂x² - (B/ρ) * ∂⁴u/∂x⁴ - γ * ∂u/∂t

Where:
  T = tension (N)
  ρ = rho (kg/m)
  B = -(r²/4) * jung (Pa*m⁴)
  γ = gamma (damping coefficient)
```

**Parameter Ranges:**

| Parameter | Typical Range | Unit | Description |
|-----------|---------------|------|-------------|
| length | 0.5 - 2.5 | m | String length |
| tension | 50 - 1500 | N | String tension |
| rho | 0.0001 - 0.01 | kg/m | Linear density |
| r | 0.0001 - 0.002 | m | String radius |
| jung | -1e10 to -1e11 | Pa | Young's modulus (negative in formula) |
| gamma | 0.01 - 0.5 | - | Velocity damping |
| dispersion_damping | 1e-15 - 1e-12 | - | Artificial damping |

**Hammer Parameters:**

| Parameter | Typical Range | Description |
|-----------|---------------|-------------|
| width | 0.005 - 0.05 m | Contact width |
| position | 0.08 - 0.2 | Normalized distance from bridge |
| sharpness | 0.0 - 1.0 | Curvature (0=flat, 1=sharp) |

**Optimal Hammer Position:** 1/7 to 1/9 from bridge (~0.11-0.14) for rich tone

---

## 6. Frontend Integration Guide

### 6.1 API Usage Patterns for UI Developers

**Initialization Flow:**

```javascript
// 1. Load preset and start synthesis
async function initialize() {
  const response = await fetch('http://localhost:5000/load_preset', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      path: 'presets/Preset.json',
      sample_rate: 48000,
      audio_on: 1,
      start_right_away: 1,
      listen_to_midi: 0,
      use_simulation: 0,
      extract_data: 0,
      cycle_iterations: 48,
      string_iterations: 6,
      volume: 64,
      user_1: 384,
      user_3: 2
    })
  });

  const data = await response.json();
  console.log(data.message);
}

// 2. Wait for healthy status
async function waitForReady() {
  while (true) {
    const health = await fetch('http://localhost:5000/health');
    const status = await health.json();

    if (status.status === 'healthy') {
      console.log('Pianoid ready');
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// 3. Get available notes
async function getAvailableNotes() {
  const response = await fetch('http://localhost:5000/get_available_notes');
  return await response.json();  // [21, 22, 23, ..., 108]
}
```

**Parameter Editing:**

```javascript
// Get current parameters
async function getStringParams(pitch) {
  const response = await fetch(
    `http://localhost:5000/get_parameter/string/${pitch}`
  );
  return await response.json();
  // {60: {tension: 725.0, gamma: 0.05, ...}}
}

// Update parameters
async function setStringParams(pitch, params) {
  const response = await fetch(
    `http://localhost:5000/set_parameter/string/${pitch}`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({[pitch]: params})
    }
  );
  return await response.json();
}

// Example: Tension slider
function onTensionChange(pitch, newTension) {
  setStringParams(pitch, {tension: newTension});
}
```

**Note Triggering:**

```javascript
// Play note
async function playNote(pitch, velocity) {
  await fetch('http://localhost:5000/play', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      pitch: pitch,
      command: 144,  // Note on
      velocity: velocity
    })
  });
}

// Release note
async function releaseNote(pitch) {
  await fetch('http://localhost:5000/play', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      pitch: pitch,
      command: 128,  // Note off
      velocity: 0
    })
  });
}

// Virtual keyboard
document.getElementById('key-60').addEventListener('mousedown', () => {
  playNote(60, 100);
});

document.getElementById('key-60').addEventListener('mouseup', () => {
  releaseNote(60);
});
```

### 6.2 Chart Data Visualization

**Fetching Chart Data:**

```javascript
async function getChart(chartType, params) {
  const response = await fetch('http://localhost:5000/get_chart_test', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      chartType: chartType,
      ...params
    })
  });

  const data = await response.json();
  return data;
  /*
  {
    data: [[0.1, 0.2, ...], ...],
    general_header: "Sound record",
    text_fields: {...},
    chart_headers: ["", ...],
    audio_data: ["base64_wav_data", null, ...]
  }
  */
}
```

**Rendering with Chart.js:**

```javascript
import Chart from 'chart.js/auto';

async function renderSoundChart() {
  const chartData = await getChart('sound', {
    length: 24000,
    channel: 0
  });

  const ctx = document.getElementById('waveform').getContext('2d');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartData.data[0].map((_, i) => i),
      datasets: [{
        label: chartData.chart_headers[0],
        data: chartData.data[0],
        borderColor: 'rgb(75, 192, 192)',
        borderWidth: 1,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: {display: false},
        y: {title: {display: true, text: 'Amplitude'}}
      }
    }
  });
}
```

**Audio Playback:**

```javascript
async function playChartAudio(chartData, chartIndex) {
  const base64Audio = chartData.audio_data[chartIndex];
  if (!base64Audio) return;

  // Decode base64 to ArrayBuffer
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Create audio context
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);

  // Play
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);
  source.start();
}
```

### 6.3 Real-Time Parameter Updates

**Debouncing Strategy:**

```javascript
class ParameterUpdater {
  constructor(pitch) {
    this.pitch = pitch;
    this.pendingUpdates = {};
    this.timeout = null;
  }

  // Queue parameter update
  update(paramName, value) {
    this.pendingUpdates[paramName] = value;

    // Debounce: wait 200ms after last change
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.flush();
    }, 200);
  }

  // Send batched update
  async flush() {
    if (Object.keys(this.pendingUpdates).length === 0) return;

    await setStringParams(this.pitch, this.pendingUpdates);
    this.pendingUpdates = {};
  }
}

// Usage
const updater = new ParameterUpdater(60);

tensionSlider.addEventListener('input', (e) => {
  updater.update('tension', parseFloat(e.target.value));
});

gammaSlider.addEventListener('input', (e) => {
  updater.update('gamma', parseFloat(e.target.value));
});
```

**Range Updates for Efficiency:**

```javascript
// Instead of updating each note individually:
// ❌ Bad (slow)
for (let pitch = 21; pitch <= 108; pitch++) {
  await setStringParams(pitch, {gamma: 0.05});
}

// ✅ Good (fast)
const params = {};
for (let pitch = 21; pitch <= 108; pitch++) {
  params[pitch] = {gamma: 0.05};
}

await fetch('http://localhost:5000/set_parameter/string/from21to108', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(params)
});
```

### 6.4 WebSocket vs Polling Considerations

**Current Architecture: HTTP Polling**

PianoidCore does not implement WebSockets. For real-time updates, use polling:

```javascript
// Health monitoring
setInterval(async () => {
  const health = await fetch('http://localhost:5000/health');
  const status = await health.json();

  if (status.status === 'crashed') {
    alert('Synthesis engine crashed!');
  }
}, 1000);  // Check every second
```

**Future WebSocket Implementation:**

If WebSockets were added, the architecture could support:

```javascript
// Hypothetical future implementation
const ws = new WebSocket('ws://localhost:5000/updates');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case 'parameter_changed':
      updateUI(data.pitch, data.parameter, data.value);
      break;
    case 'note_triggered':
      highlightKey(data.pitch);
      break;
    case 'status_update':
      updateHealthIndicator(data.status);
      break;
  }
};
```

**Performance Recommendation:**
- For parameter updates: HTTP POST (low frequency)
- For health monitoring: HTTP GET polling every 1-2 seconds
- For note visualization: Consider MIDI passthrough to browser if available

---

## 7. Deployment & Configuration

### 7.1 Installation Steps

**Prerequisites:**

```bash
# System requirements
- Windows 10/11 or Linux
- NVIDIA GPU with CUDA support (Compute Capability 3.5+)
- Python 3.8+
- CUDA Toolkit 11.0+
- Visual Studio Build Tools (Windows)
```

**Step 1: Clone Repository**

```bash
git clone <repository_url>
cd PianoidCore
```

**Step 2: Create Virtual Environment**

```bash
python -m venv .venv
.venv\Scripts\activate  # Windows
source .venv/bin/activate  # Linux
```

**Step 3: Install Python Dependencies**

```bash
pip install -r requirements.txt
```

**Key Dependencies:**
- Flask==3.1.2
- Flask-CORS==4.0.1
- numpy==2.2.6
- pandas==2.2.3
- python-rtmidi==1.5.8
- matplotlib==3.9.4
- scipy==1.16.1
- PyYAML==6.0.1

**Step 4: Install PianoidBasic**

```bash
# If using local copy
cd ../PianoidBasic
pip install -e .
cd ../PianoidCore

# Or from PyPI (when available)
pip install Pianoid
```

**Step 5: Compile pianoidCuda Module**

```bash
cd pianoid_cuda
pip install -e .
cd ..
```

**Compilation Requirements:**
- CUDA Toolkit installed and in PATH
- CMake or setuptools with CUDA support
- pybind11==3.0.1

**Step 6: Verify Installation**

```python
# test_installation.py
import pianoidCuda
import Pianoid
import flask

print("pianoidCuda version:", pianoidCuda.__version__ if hasattr(pianoidCuda, '__version__') else 'OK')
print("Pianoid version:", Pianoid.__version__)
print("Flask version:", flask.__version__)
print("Installation successful!")
```

### 7.2 Environment Setup

**Directory Structure:**

```
PianoidCore/
├── pianoid_middleware/
│   ├── backendServer.py
│   ├── pianoid.py
│   ├── ChartGenerator.py
│   ├── ChartRegistry.py
│   ├── chartFunctions.py
│   ├── pianoidMidiListener.py
│   ├── PanoidResult.py
│   ├── FirFilterTest.py
│   ├── FirFilterFileIO.py
│   └── chart_config.json
├── pianoid_cuda/
│   ├── Pianoid.cu
│   ├── Pianoid.cuh
│   ├── MainKernel.cu
│   ├── FIRFilter.cu
│   ├── Kernels.cu
│   ├── AddArraysWithCUDA.cpp
│   ├── setup.py
│   └── ...
├── presets/
│   ├── Preset.json
│   ├── MaximExample.json
│   └── filters/
│       └── filter_data.npz
├── requirements.txt
├── README.md
└── .venv/
```

**Environment Variables:**

```bash
# Optional: CUDA device selection
export CUDA_VISIBLE_DEVICES=0

# Optional: Flask configuration
export FLASK_APP=pianoid_middleware/backendServer.py
export FLASK_ENV=development
export FLASK_DEBUG=1
```

### 7.3 Configuration Files

**chart_config.json:**

Registry for chart types and actions:

```json
{
  "types": [
    {
      "name": "sound",
      "label": "Sound Analysis",
      "is_action": false,
      "function_module": "chartFunctions",
      "function_name": "sound_function",
      "parameters": [
        {
          "name": "length",
          "type": "number",
          "label": "Length",
          "defaultValue": 10000
        },
        {
          "name": "channel",
          "type": "number",
          "label": "Channel Number",
          "defaultValue": 0
        }
      ]
    }
  ]
}
```

**Keyboard Configuration (YAML):**

Located in pianoid_middleware/ or loaded from constants:

```yaml
# keyboard_config.yaml
set_params:
  num_mode: 16
  num_note: 88

note_on:
  command: 144
  pitch: any

note_off:
  command: 128
  pitch: any

sustain:
  command: 176
  pitch: 64

main_volume:
  command: 176
  pitch: 7
```

### 7.4 Performance Tuning

**GPU Configuration:**

```python
# In pianoid.py initialization
mp = ModelParameters(
    sample_rate=48000,      # Higher = better quality, more CPU
    array_size=384,         # Higher = better quality, more GPU memory
    mode_iteration=48,      # Samples per cycle (48 @ 48kHz = 1ms)
    string_iterations=6,    # Higher = more accurate, slower
    num_modes=16            # Higher = richer sound, more GPU work
)
```

**Performance Targets:**

| Configuration | GPU Usage | CPU Usage | Latency | Quality |
|---------------|-----------|-----------|---------|---------|
| Low (array_size=256, modes=8) | ~30% | ~20% | <1ms | Basic |
| Medium (array_size=384, modes=16) | ~50% | ~30% | ~1ms | Good |
| High (array_size=512, modes=32) | ~80% | ~50% | ~2ms | Excellent |

**Profiling:**

```bash
# Enable profiling via API
POST /get_chart_test
{
  "chartType": "profiling_action",
  "action": "start"
}

# Run synthesis for N cycles

POST /get_chart_test
{
  "chartType": "profiling_action",
  "action": "stop",
  "cpu_file": "cpu_profiling.csv",
  "gpu_file": "gpu_profiling.csv"
}

# View results
POST /get_chart_test
{
  "chartType": "profiling_data",
  "budget_ms": 1.0
}
```

**Optimization Tips:**

1. **Reduce num_modes** if not using soundboard resonance
2. **Lower array_size** for faster iteration at cost of detail
3. **Disable extract_data** in production (debug overhead)
4. **Use FIR filter sparingly** (adds ~0.3ms per cycle)
5. **Minimize parameter updates** during synthesis

---

## 8. Development Guide

### 8.1 Adding New Chart Types

**Step 1: Create Chart Function**

```python
# pianoid_middleware/chartFunctions.py

def my_new_chart_function(pianoid, **kwargs):
    """
    Custom chart implementation.

    Args:
        pianoid: Pianoid instance
        **kwargs: Parameters from request

    Returns:
        (charts, top_header, text_fields)
    """
    from ChartRegistry import ChartArray

    # Extract parameters
    param1 = kwargs.get('param1', 'default_value')
    param2 = kwargs.get('param2', 100)

    # Generate data
    charts = ChartArray()
    data = []
    for i in range(param2):
        # Your logic here
        data.append(compute_value(pianoid, i, param1))

    charts.append_chart("My Chart Title", data)

    # Optional: embed audio
    # charts.create_audio_to_chart('all', sample_rate=pianoid.mp.sample_rate())

    top_header = "My Visualization"
    text_fields = {
        "Parameter 1": str(param1),
        "Parameter 2": str(param2),
        "Data Points": str(len(data))
    }

    return charts, top_header, text_fields
```

**Step 2: Register in chart_config.json**

```json
{
  "types": [
    {
      "name": "my_new_chart",
      "label": "My Custom Visualization",
      "is_action": false,
      "function_module": "chartFunctions",
      "function_name": "my_new_chart_function",
      "parameters": [
        {
          "name": "param1",
          "type": "string",
          "label": "First Parameter",
          "defaultValue": "default_value"
        },
        {
          "name": "param2",
          "type": "number",
          "label": "Data Length",
          "defaultValue": 100
        }
      ]
    }
  ]
}
```

**Step 3: Use in Frontend**

```javascript
const chartData = await getChart('my_new_chart', {
  param1: 'custom_value',
  param2: 200
});

console.log(chartData.data[0]);  // Your data array
```

### 8.2 Extending Parameter Types

**Step 1: Add to Pianoid.pack_for_interface()**

```python
# pianoid.py:943-994

def pack_for_interface(self, parameter, pitches=[], modes=[]):
    if parameter == 'my_new_param':
        params = {}
        for pitchID in pitches:
            pitch = self.sm.pitches[pitchID]
            params[pitchID] = {
                'custom_field_1': pitch.custom_field_1,
                'custom_field_2': pitch.custom_field_2
            }
        return params, 200
    # ... existing code
```

**Step 2: Add to Pianoid.update_parameter()**

```python
# pianoid.py:998-1071

def update_parameter(self, param, values, pitches=[], modes=[]):
    if param == 'my_new_param':
        for pitchID in pitches:
            if pitchID in values:
                self.update_my_new_param(pitchID, **values[pitchID])
    # ... existing code
```

**Step 3: Implement Update Method**

```python
# pianoid.py

def update_my_new_param(self, pitchID, send_to_cuda=True, **params):
    """Update custom parameter."""
    pitch = self.sm.pitches[pitchID]

    # Update Python object
    for key, value in params.items():
        setattr(pitch, key, value)

    if send_to_cuda:
        with self.cuda_lock:
            # Pack and transfer to GPU
            custom_data = self.pack_custom_params()
            self.pianoid.setCustomParameters(custom_data)
            time.sleep(0.02)
```

### 8.3 Custom Action Implementation

```python
# chartFunctions.py

def my_custom_action_function(pianoid, **kwargs):
    """
    Custom action implementation.

    Returns:
        dict with status, message, and optional data
    """
    param = kwargs.get('param', 'default')

    try:
        # Perform action
        result = do_something(pianoid, param)

        return {
            "status": "success",
            "message": f"Action completed with {param}",
            "result": result
        }
    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }
```

**Register as Action:**

```json
{
  "name": "my_custom_action",
  "label": "My Custom Action",
  "is_action": true,
  "function_module": "chartFunctions",
  "function_name": "my_custom_action_function",
  "parameters": [
    {
      "name": "param",
      "type": "string",
      "label": "Action Parameter",
      "defaultValue": "default"
    }
  ]
}
```

### 8.4 Testing Strategies

**Unit Testing:**

```python
# tests/test_parameter_update.py

import unittest
from pianoid_middleware.pianoid import Pianoid

class TestParameterUpdate(unittest.TestCase):
    def setUp(self):
        self.pianoid = Pianoid()
        self.pianoid.initialize(
            path="presets/Preset.json",
            use_simulation=True,  # Use placeholder, not CUDA
            audioOn=False
        )

    def test_string_parameter_update(self):
        """Test updating string tension."""
        initial = self.pianoid.sm.pitches[60].physics.tension

        self.pianoid.update_parameter(
            'string',
            values={60: {'tension': 750.0}},
            pitches=[60]
        )

        updated = self.pianoid.sm.pitches[60].physics.tension
        self.assertEqual(updated, 750.0)
        self.assertNotEqual(initial, updated)

    def tearDown(self):
        if hasattr(self.pianoid, 'pianoid'):
            self.pianoid.pianoid.stopApplication(True)
```

**Integration Testing:**

```python
# tests/test_api.py

import requests
import unittest

class TestAPI(unittest.TestCase):
    BASE_URL = 'http://localhost:5000'

    def test_load_preset(self):
        """Test preset loading."""
        response = requests.post(
            f'{self.BASE_URL}/load_preset',
            json={
                'path': 'presets/Preset.json',
                'sample_rate': 48000,
                'audio_on': 0,
                'start_right_away': 0
            }
        )
        self.assertEqual(response.status_code, 200)

    def test_get_parameter(self):
        """Test parameter retrieval."""
        response = requests.get(
            f'{self.BASE_URL}/get_parameter/string/60'
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn('60', data)
        self.assertIn('tension', data['60'])
```

---

## 9. Troubleshooting

### 9.1 Common Issues and Solutions

**Issue: "No MIDI input ports available"**

```
MidiListener Error: RuntimeError: No MIDI input ports available
```

**Solution:**
- Connect a MIDI device before starting
- Or disable MIDI: `listen_to_midi: 0` in /load_preset
- Check device with `python-rtmidi`:
  ```python
  import rtmidi
  midi_in = rtmidi.MidiIn()
  print(midi_in.get_ports())
  ```

**Issue: "CUDA out of memory"**

```
cudaError: out of memory
```

**Solution:**
- Reduce `array_size` (e.g., 384 → 256)
- Reduce `num_modes` (e.g., 32 → 16)
- Lower `fir_filter_length` or disable FIR filter
- Free GPU memory:
  ```bash
  nvidia-smi  # Check GPU usage
  # Kill other GPU processes
  ```

**Issue: "Pianoid in exception state" (417 error)**

**Solution:**
- Check `/health` endpoint for details
- Reload preset: POST /load_preset
- Check logs for CUDA errors
- Verify preset JSON is valid

**Issue: "Parameter update has no effect"**

**Symptoms:**
- Parameter changes don't affect sound
- Values update in GET but sound unchanged

**Solution:**
- Ensure `send_to_cuda=True` in update calls
- Check for exception state (silently fails)
- Verify parameter ranges are valid
- Check cuda_lock isn't deadlocked

### 9.2 Log Interpretation

**Flask Debug Output:**

```
127.0.0.1 - - [12/Oct/2025 10:15:32] "POST /set_parameter/string/60 HTTP/1.1" 200 -
```
- 200: Success
- 416: Parameter error
- 417: Exception state
- 500: Server crash

**Pianoid Console Output:**

```
Mode state updated
Physical parameters updated
Deck parameters updated
```
- Normal CUDA update messages

```
cudaMemcpy failed! mode_state invalid argument
```
- CUDA error: Check parameter sizes

```
ERROR updating parameters: <exception>
```
- Python exception: Check traceback

**Profiling Output:**

```
Profiling started - data will be recorded to memory buffer
Profiling stopped - data written to:
  CPU: cpu_profiling.csv
  GPU: gpu_profiling.csv
```

**CSV Format:**

```csv
cycle,parameter_ms,gauss_ms,add_ms,filter_ms
0,0.123,0.234,0.345,0.456
1,0.125,0.232,0.348,0.451
...
```

### 9.3 Performance Debugging

**Check GPU Timing:**

```bash
# Start profiling
POST /get_chart_test
{"chartType": "profiling_action", "action": "start"}

# Play notes...

# Stop and view
POST /get_chart_test
{"chartType": "profiling_action", "action": "stop"}

POST /get_chart_test
{"chartType": "profiling_data", "budget_ms": 1.0}
```

**Interpret Results:**

```
Mean Total Time: 0.850 ms
Max Total Time: 1.200 ms
Cycles Over Budget: 15 (3.2%)

Mean Parameter Kernel: 0.123 ms (14.5%)
Mean Gauss Kernel: 0.234 ms (27.5%)
Mean Add Kernel: 0.345 ms (40.6%)
Mean Filter Kernel: 0.148 ms (17.4%)
```

**Performance Status:**
- ✓ OK: Mean < 0.8 * budget
- ⚠️ WARNING: Mean > 0.8 * budget
- ❌ EXCEEDS BUDGET: Mean > budget

**Optimization Priority:**
1. Reduce array_size if Add Kernel is slowest
2. Reduce num_modes if Gauss/Add are slow
3. Disable FIR filter if Filter Kernel is slow
4. Optimize parameter updates if Parameter Kernel is slow

---

## 10. Future Architecture

### 10.1 Architectural Debt

**Global Singleton Pattern:**

Current implementation uses a global `pianoid` instance ([backendServer.py:15](backendServer.py#L15)). This limits scalability:

**Problems:**
- Only one preset loaded at a time
- No multi-tenant support
- State shared across all requests

**Future Solution:**
- Session-based architecture with multiple Pianoid instances
- Instance pooling for resource management
- Per-user state isolation

**Thread Safety:**

Current `cuda_lock` is coarse-grained ([pianoid.py:46](pianoid.py#L46)):

**Problems:**
- Blocks all parameter updates during transfer
- No read/write lock distinction
- Sleep delays (20ms) after each update

**Future Solution:**
- Fine-grained locking per parameter type
- Lock-free data structures for reads
- Asynchronous parameter updates with acknowledgment

**Error Handling:**

Current exception handling sets a global flag ([pianoid.py:828](pianoid.py#L828)):

**Problems:**
- No recovery mechanism
- Requires full reload
- Error details lost in logs

**Future Solution:**
- Graceful degradation
- Automatic retry with backoff
- Detailed error reporting to frontend

### 10.2 Scalability Considerations

**Multi-Instance Architecture:**

```
Load Balancer
    ↓
┌───────────────────────────────────┐
│ Session Manager                   │
│  • User → Pianoid Instance        │
│  • Resource Allocation            │
│  • Lifecycle Management           │
└───────────────────────────────────┘
    ↓           ↓           ↓
[Pianoid 1] [Pianoid 2] [Pianoid 3]
    ↓           ↓           ↓
  GPU 0       GPU 0       GPU 1
```

**WebSocket Support:**

Real-time bidirectional communication:

```
Client ←→ WebSocket ←→ Pianoid Event System
                           ↓
                    • Parameter changes
                    • Note triggers
                    • Status updates
```

**Distributed GPU:**

Multi-GPU support for higher polyphony:

```
Pianoid Instance
    ├─ String Simulation → GPU 0
    ├─ Mode Integration → GPU 1
    └─ FIR Filtering → GPU 2
```

### 10.3 Extension Points

**Plugin System:**

Dynamic loading of custom components:

```python
# plugins/custom_synthesis.py

class CustomSynthesisPlugin:
    def process(self, pianoid, data):
        # Custom processing
        return modified_data

# Register
pianoid.register_plugin('custom_synthesis', CustomSynthesisPlugin())
```

**Parameter Validation:**

Schema-based validation:

```json
{
  "string": {
    "tension": {"type": "float", "min": 10, "max": 2000},
    "gamma": {"type": "float", "min": 0, "max": 1},
    "length": {"type": "float", "min": 0.1, "max": 3.0}
  }
}
```

**MIDI Mapping Editor:**

Runtime keyboard configuration:

```
POST /midi/configure
{
  "command": 144,
  "pitch": 48,
  "action": "stop_pianoid"
}
```

**Preset Versioning:**

Track preset history and changes:

```json
{
  "version": "2.0",
  "created": "2025-10-12T10:00:00Z",
  "modified": "2025-10-12T15:30:00Z",
  "history": [
    {"timestamp": "...", "changes": {"60": {"tension": 725.0}}}
  ]
}
```

---

## Appendix A: File Reference

### Core Files

| File | Lines | Purpose |
|------|-------|---------|
| [backendServer.py](backendServer.py) | 1000+ | Flask REST API |
| [pianoid.py](pianoid.py) | 1100+ | Main orchestrator |
| [ChartGenerator.py](ChartGenerator.py) | 120 | Chart processing |
| [ChartRegistry.py](ChartRegistry.py) | 450 | Registry system |
| [chartFunctions.py](chartFunctions.py) | 556 | Chart implementations |
| [pianoidMidiListener.py](pianoidMidiListener.py) | 423 | MIDI input |
| [PanoidResult.py](PanoidResult.py) | 120 | Result extraction |

### CUDA Files

| File | Purpose |
|------|---------|
| [Pianoid.cu](pianoid_cuda/Pianoid.cu) | C++ wrapper |
| [MainKernel.cu](pianoid_cuda/MainKernel.cu) | String physics |
| [FIRFilter.cu](pianoid_cuda/FIRFilter.cu) | FIR convolution |
| [Kernels.cu](pianoid_cuda/Kernels.cu) | Utility kernels |
| [AddArraysWithCUDA.cpp](pianoid_cuda/AddArraysWithCUDA.cpp) | pybind11 bindings |

### Documentation Files

| File | Purpose |
|------|---------|
| [FIR_FILTER_INTEGRATION.md](FIR_FILTER_INTEGRATION.md) | FIR filter system |
| [MODE_AND_DECK_PARAMETER_FLOW.md](MODE_AND_DECK_PARAMETER_FLOW.md) | Parameter flow |
| [PROFILING_GUIDE.md](PROFILING_GUIDE.md) | Performance profiling |

---

## Appendix B: Parameter Quick Reference

### String Physics Parameters

| Parameter | Type | Range | Unit | Description |
|-----------|------|-------|------|-------------|
| length | float | 0.5-2.5 | m | String length |
| tail | float | 0.05-0.3 | m | Free tail length |
| tension | float | 50-1500 | N | String tension |
| rho | float | 0.0001-0.01 | kg/m | Linear density |
| r | float | 0.0001-0.002 | m | String radius |
| jung | float | -1e11 to -1e10 | Pa | Young's modulus |
| gamma | float | 0.01-0.5 | - | Velocity damping |
| dispersion_damping | float | 1e-15 to 1e-12 | - | Artificial damping |
| detuning | float | 0-0.01 | - | Unison detuning |
| volume_coefficient | float | 0.1-10 | - | Output gain |
| damper_string | float | 1e-8 to 1e-4 | - | Damper effect (main) |
| damper_tail | float | 1e-8 to 1e-4 | - | Damper effect (tail) |

### Mode Parameters

| Parameter | Type | Range | Unit | Description |
|-----------|------|-------|------|-------------|
| frequency | float | 20-20000 | Hz | Mode frequency |
| decrement | float | 0.1-10 | - | Damping factor |
| mass | float | 0.1-10 | kg | Physical mass |
| stiffness | float | 1000-100000 | N/m | Spring constant |

---

*End of Documentation*

**Generated:** 2025-10-12
**Version:** 1.0
**Total Sections:** 10
**Total Pages:** ~80 equivalent
