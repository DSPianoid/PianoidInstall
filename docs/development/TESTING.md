# Testing System

Three-level pytest framework in `PianoidCore/tests/`, organized top-down by integration scope.

## Structure

```
PianoidCore/tests/
├── conftest.py          # Root: markers, skip logic, shared constants
├── pytest.ini           # Configuration
├── fixtures/            # Reference data (e.g. reference_c4_preset_test5.npy)
├── system/              # Full stack — GPU + audio hardware
│   ├── conftest.py      # Session-scoped Pianoid with SDL3 audio
│   ├── test_audio_drivers.py
│   └── test_performance.py
├── integration/         # GPU required, no audio (planned)
└── unit/                # Pure Python, no GPU (planned)
```

## Running Tests

```bash
cd PianoidCore

# All tests
.venv/Scripts/python -m pytest tests/ -v

# System tests only (requires GPU + audio)
.venv/Scripts/python -m pytest tests/system/ -v -s

# Skip slow tests
.venv/Scripts/python -m pytest tests/ -v -m "not slow"
```

## Markers

| Marker | Meaning |
|--------|---------|
| `gpu` | Requires NVIDIA GPU with `pianoidCuda` |
| `audio` | Requires audio hardware (SDL3/ASIO) |
| `slow` | Takes >30 seconds |

Tests marked `gpu` or `audio` auto-skip when hardware is unavailable.

## System Tests (implemented)

### test_audio_drivers.py

| Test | What it validates |
|------|-------------------|
| `TestDriverAvailability` | At least one audio driver compiled |
| `TestSinewave[sdl3/asio_callback]` | Driver init + GPU sinewave output |
| `TestSynthesis[sdl3/asio_callback]` | Full synthesis path through driver |

### test_performance.py

| Test | What it validates |
|------|-------------------|
| `TestGpuCycleTiming` | Per-cycle GPU kernel time < 1.333ms budget (CUDA events) |
| `TestTotalCycleTiming` | Wall-clock cycle time via offline playback |
| `TestSoundOutputQuality` | Pitch detection (C4 ±5%), non-silent output |
| `TestSoundRegression` | Waveform/spectral correlation vs saved reference |
| `TestBufferSynchronization` | Buffer underrun diagnosis — correlates GPU time with callback stats |
| `TestTimingDistribution` | Statistical tail analysis (p95/p99) of GPU, total, and buffer phase |

## Key Constants

```python
SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
GPU_BUDGET_MS = 64 / 48000 * 1000   # 1.333 ms
TOTAL_BUDGET_MS = GPU_BUDGET_MS * 1.5  # 2.0 ms
```

## Instrumentation APIs

| Python API | Data | Source |
|-----------|------|--------|
| `p.startProfiling()` / `getGpuProfilingData()` | Per-cycle GPU kernel timings (ms) | PianoidProfiler (CUDA events) |
| `p.initTimeRecord()` / `getTimeRecord()` | Per-cycle wall-clock checkpoints (µs) | PlaybackCycleExecutor |
| `p.getCallbackStats()` | Callback count, interval, underruns | AudioDriverInterface |
| `p.getRecordedAudio()` | Offline playback audio buffer | OfflinePlaybackEngine |
