# Audio Drivers

## Overview

The audio driver subsystem abstracts platform-specific audio output behind a single
interface. Two driver implementations are provided: `SDL3AudioDriver` for general-purpose
use and `ASIOAudioDriver` for low-latency professional audio on Windows. The active
driver is selected at compile time via `AudioDriverConfig.h` and can be overridden at
runtime through `AudioDriverFactory`.

All audio output passes through `LockFreeCircularBuffer`, which decouples the GPU synthesis
thread (producer) from the audio hardware callback thread (consumer).

Both SDL3 and ASIO drivers also support **microphone capture** via the `CaptureBuffer` class,
used by the calibration system for semi-offline RMS measurement.

---

## AudioDriverInterface

**File:** `AudioDriverInterface.h`

Pure virtual interface all drivers must implement:

```cpp
class AudioDriverInterface {
public:
    virtual void init()                                  = 0;
    virtual void start()                                 = 0;
    virtual void pause()                                 = 0;
    virtual void resume()                                = 0;
    virtual void stop()                                  = 0;
    virtual void stopAndWait();                          // default: delegates to stop()
    virtual void pushSamples(Sint32* data, size_t size) = 0; // GPU memory
    virtual void pushSamplesCPU(Sint32* data, size_t n);     // CPU memory (optional)
    virtual void setupCuda(int device)                   = 0;
    virtual bool isCudaReady() const                     = 0;
    virtual int  getBufferSize()   const                 = 0;
    virtual int  getSampleRate()   const                 = 0;
    virtual int  getNumChannels()  const                 = 0;
    virtual CallbackTimingStats getCallbackStats() const;
    virtual void resetCallbackStats();
};
```

`CallbackTimingStats` tracks callback interval statistics:

```cpp
struct CallbackTimingStats {
    int    callbackCount;       // total callbacks received
    double avgIntervalUs;       // average interval (microseconds)
    double minIntervalUs;
    double maxIntervalUs;
    double stdDevUs;
    int    chunksPerCallback;
    int    underrunCount;
};
```

---

## AudioConfig

**File:** `AudioConfig.h`

Configuration structure passed to driver constructors and `AudioDriverFactory`:

```cpp
struct AudioConfig {
    int             sample_rate;
    int             buffer_size;
    int             num_channels;
    int             mode_iteration;         // synthesis chunk size (== segment_length)
    AudioDriverType driver_type;
    int             circular_buffer_chunks; // buffer depth (default 4)
    int             cuda_device_id;         // default 0
};
```

---

## AudioDriverType Enum

**File:** `AudioConfig.h`

```cpp
enum class AudioDriverType {
    SDL2,          // SDL2 legacy driver
    SDL3,          // SDL3 stream-based driver (recommended)
    ASIO,          // ASIO polling mode
    ASIO_CALLBACK, // ASIO callback mode
    SDL = SDL2     // backward compatibility alias
};
```

---

## SDL3AudioDriver

**File:** `SDL3AudioDriver.h` / `SDL3AudioDriver.cpp`

Uses SDL3's stream API. The synthesis thread pushes samples via `pushSamples()`; SDL's
internal audio thread drains them from the stream via `audioStreamCallback`.

```cpp
class SDL3AudioDriver : public AudioDriverInterface {
    SDL_AudioStream*         audioStream;
    SDL_AudioDeviceID        deviceId;
    int                      sampleRate;
    int                      bufferSize;
    int                      numChannels;    // output channels (stereo = 2)
    int                      inputChannels;  // GPU channels (8)
    int                      samplesInCycle;
    LockFreeCircularBuffer   audioBuffer;    // GPU → CPU transfer buffer
    Pianoid*                 pianoidInstance;

public:
    SDL3AudioDriver(const AudioConfig& config, Pianoid* instance);
    void init()     override;
    void start()    override;
    void pause()    override;
    void resume()   override;
    void stop()     override;
    void stopAndWait() override;
    void pushSamples(Sint32* data, size_t dataSize) override;  // GPU memory
    void pushSamplesCPU(Sint32* data, size_t numSamples) override;
    void setupCuda(int device) override;
    bool isCudaReady() const   override;
    int  getInputChannels() const;
};
```

The static callback `audioStreamCallback()` is registered with SDL3's audio device. It
calls the instance method `fillAudioStream()`, which:
1. Calls `audioBuffer.consume()` to dequeue one chunk from `LockFreeCircularBuffer`
2. Downmixes 8 GPU channels to 2 output channels
3. Pushes stereo data to the SDL3 audio stream

---

## ASIOAudioDriver

**File:** `ASIOAudioDriver.h` / `ASIOAudioDriver.cpp`

Windows-only ASIO driver providing hardware-level latency. Wraps `AsioAudioOutput`
(ASIO SDK interface in `AsioAudioInterface.h`).

```cpp
class ASIOAudioDriver : public AudioDriverInterface {
    AsioAudioOutput        asioDriver;
    int                    sampleRate;
    int                    bufferSize;
    int                    numChannels;
    int                    samplesPerCycle;
    LockFreeCircularBuffer audioBuffer;
    Pianoid*               pianoidInstance;

    static void audioCallbackForASIO(uint32_t* (*source_of_pointers));
    static Pianoid*         staticInstance;
    static ASIOAudioDriver* staticDriverInstance;

public:
    ASIOAudioDriver(const AudioConfig& config, bool callback_mode, Pianoid* instance);
    void init()     override;
    void start()    override;
    void stop()     override;
    void stopAndWait() override;
    void pushSamples(Sint32* data, size_t dataSize) override;
    void pushSamplesCPU(Sint32* data, size_t numSamples) override;
    void playRecordedAudio(const std::vector<float>& samples, float volumeCoeff);
    LockFreeCircularBuffer& getBuffer();
};
```

`circular_buffer_chunks = 4` is recommended for ASIO (minimal latency). SDL3 typically
uses 16 or more chunks for stability.

---

## AudioDriverFactory

**File:** `AudioDriverFactory.h` / `AudioDriverFactory.cpp`

Creates the appropriate driver instance based on configuration or compile-time defaults.

```cpp
class AudioDriverFactory {
public:
    // Create driver from explicit AudioConfig
    static std::unique_ptr<AudioDriverInterface> createDriver(
        const AudioConfig& config, Pianoid* pianoidInstance);

    // Create driver with compile-time defaults
    static std::unique_ptr<AudioDriverInterface> createDefaultDriver(
        int sampleRate, int bufferSize, int numChannels,
        int modeIteration, Pianoid* pianoidInstance);

    // Create driver with explicit type override (-1 = compile-time default)
    static std::unique_ptr<AudioDriverInterface> createDriverWithType(
        int sampleRate, int bufferSize, int numChannels, int modeIteration,
        int driverTypeInt, Pianoid* pianoidInstance,
        int circularBufferChunks = 4);

    // Query available drivers
    static AudioDriverType getBestAvailableDriver();
    static bool isDriverAvailable(AudioDriverType driverType);
};
```

Compile-time selection (`AudioDriverConfig.h`):
- Default when neither `USE_SDL2_AUDIO` nor `USE_SDL3_AUDIO` nor `USE_ASIO_AUDIO` is
  defined: `#define USE_SDL3_AUDIO` and `#define USE_ASIO_AUDIO`
- Priority at runtime: ASIO > SDL3 > SDL2

Note: `isDriverAvailable()` / `getBestAvailableDriver()` are **compile-time** checks
("was this driver compiled in?"), NOT runtime device probes. A build with
`USE_ASIO_AUDIO` reports ASIO available even on a machine with no ASIO driver
installed; the actual device load happens later in `ASIOAudioDriver::init()`.

---

## ASIO → SDL3 Runtime Fallback

**File:** `Pianoid.cu` (`Pianoid::startAudioDriver()`) — added dev-asioload, 2026-06-02.

The audio driver object is **constructed** in the `Pianoid` constructor (via
`AudioDriverFactory::createDriverWithType`, matching `init_params_.audio_driver_type`),
but the physical device is only **opened** later, when `startAudioDriver()` calls
`audioDriver->init()`. For ASIO that init enumerates the Steinberg ASIO drivers from
`HKLM\SOFTWARE\ASIO`; with no ASIO driver installed it throws
(`"ASIO driver initialization failed — no working ASIO device found"`).

`startAudioDriver()` catches that throw and, **only when the requested driver was an
ASIO variant** (`ASIO` or `ASIO_CALLBACK`), reconstructs the driver as **SDL3**
(`circular_buffer_chunks = 16`), re-runs `setupCuda` + `init`, and continues — so the
user still gets audio instead of `audio_driver_active = false` (silent no-sound).

The fallback is **not silent**: the engine records it (engine is the sole writer — P1)
and exposes it for a user-visible warning:

```cpp
bool        didAudioDriverFallback() const;   // true once an ASIO→SDL3 fallback occurred
int         getRequestedDriverType() const;   // AudioDriverType int requested (-1 = not started)
int         getActiveDriverType() const;      // AudioDriverType int actually running
std::string getAudioDriverFallbackReason();   // human-readable reason ("" when none)
```

Fail-fast is preserved (S5): a **non-ASIO** init failure rethrows (no fallback), and if
the **SDL3 fallback also fails** the exception is rethrown (`audio_driver_active` stays
`false`). Only the ASIO-fails-but-SDL3-succeeds path is the new graceful behaviour.

The middleware surfaces these getters via the `/health` `audio_driver_fallback` field and
the WebSocket `lifecycle` event so the frontend can show
"ASIO unavailable — using SDL3" — see
[REST_API.md — /health](../pianoid-middleware/REST_API.md) and the audio-driver selection
rule there. When no ASIO driver is installed at all, the fix for getting native ASIO is
environmental (install the device's ASIO driver or ASIO4ALL); see
[STARTUP_TROUBLESHOOTING.md](../../guides/STARTUP_TROUBLESHOOTING.md#symptom-audio-driver-fails-to-initialize).

The start/stop + fallback code lives in `Pianoid_audio.cu` (moved out of `Pianoid.cu` by
dev-19be; the SDL3 fallback body is `fallBackToSdl3()`, shared with the runtime recovery
below).

---

## Driver Fault Watchdog & Recovery (dev-19be)

**Files:** `AudioWatchdog.h/.cpp` (decide + record), `Pianoid_audio.cu` (recover),
`AsioAudioInterface.cpp` (ASIO messages), `CircularBuffer.cu` (bounded wait).

**Incident it fixes (2026-10-08).** The UMC1820's ASIO driver sent 6× `kAsioResetRequest`
(asioMessage selector 3) and the device vanished. The host's handler was the SDK-sample
no-op (`asioDriverInfo.stopped;`) yet returned 1 ("accepted"); the callback stopped, the
producer blocked forever in `produce()`'s **unbounded** back-pressure wait, the synthesis
loop (and REST event draining) froze for ~6 h, and `/health` still said `healthy`.

| Piece | Behaviour |
|---|---|
| `asioMessages()` | Counts `kAsioResetRequest` / `kAsioResyncRequest` / `kAsioLatenciesChanged` / `kAsioBufferSizeChange` (process-global atomics) and **latches a pending reset** — never resets inside the driver's callback (SDK rule). `kAsioBufferSizeChange` is not advertised (returns 0 → driver uses ResetRequest). Re-opening a driver clears the latch. |
| `LockFreeCircularBuffer::produce()` | Back-pressure wait is **bounded** (`PRODUCE_WAIT_TIMEOUT_MS = 200`); on timeout the chunk is dropped, `false` returned and `produce_timeouts` / `consecutive_produce_timeouts` count it. Normal operation never waits more than ~one chunk period (measured: 0 timeouts in 3×10 s ASIO runs). |
| `AudioDriverInterface` | Callback **heartbeat** (`armHeartbeat()` at open, `noteCallback()` per callback, `msSinceLastCallback()`), `takePendingResetRequest()`, `getMessageCounts()`, producer-timeout getters, and the `simulateStall(ms)` test hook (ASIO + SDL3 wired). |
| `AudioWatchdog::evaluate()` | Run by `Pianoid::auditAudioDriver()` once per synthesis-loop iteration (lock-free fast path). Fault = reset request, or producer blocked ≥ `STALL_REPORT_MS` (400) with a silent callback → state `stalled`; ≥ `STALL_MS` (1000) → **recover**. Automatic recoveries back off 1 → 30 s; a manual request (`POST /audio/reopen`) bypasses the backoff. |
| `Pianoid::recoverAudioDriver()` | On the **synthesis thread** (the only thread that pushes to the driver, so the swap never races `pushSamples`), under `audioDriverMutex_`: close the old driver on a helper thread with a 3 s bound (a hung ASIO teardown is abandoned and ASIO is not re-opened in this process), construct + open the **requested** driver; if ASIO cannot open → `fallBackToSdl3()`. The online loop re-anchors its `CycleTimeEstimator` after a recovery. |

Watchdog states (`getAudioHealth().state`): `ok` · `stalled` / `reset_requested` /
`recovering` (fault, auto-recovery under way) · `fallback` (recovered only onto SDL3 after a
fault — audio plays, but not on the requested device; sticky until the requested driver is
re-opened or the driver restarts) · `failed` (no driver could be opened; retried with
backoff). The snapshot also carries the loop heartbeat (`ms_since_last_cycle`), callback
heartbeat, producer timeouts, ASIO message counts and recovery counters; `getAudioHealth()`
never takes `audioDriverMutex_`, so `/health` never waits on a recovery.

```cpp
bool        auditAudioDriver(bool paused);                  // synthesis thread, per iteration
void        requestAudioDriverRecovery(const std::string&); // any thread (queued)
AudioHealth getAudioHealth() const;                         // any thread (snapshot)
std::string injectAudioFault(const std::string& kind, int durationMs); // TEST HOOK:
            // stall | reset_request | resync_request | latencies_changed | device_loss | device_return
```

Measured live (ASIO_CALLBACK, UMC1820, BaselinePreset1; `docs/development/diagnostics/dev-19be-asio-*-live.py`):
injected `kAsioResetRequest` → ASIO closed + re-opened in ~0.1 s, p60 peak unchanged
(0.605 FS); 6 s callback stall → `/health` `degraded` 0.4 s after the stall began, ASIO
re-opened at 1.0 s, a `/play` sent during the stall drained right after; `device_loss`
(incident replay: stall + reset request + ASIO opens fail) → `fallback` on SDL3 after 0.6 s,
sound + event draining continue, `device_return` + `POST /audio/reopen` → back on ASIO.
Cycle timing unchanged (3 × 10 s, ASIO: 750 cycles/s, 0 underruns, 0 producer timeouts,
callback 1332.8 µs avg — identical to the pre-change build). The UMC1820 ASIO driver is
multi-client (a second process can open it), so "device busy" cannot stand in for "device
absent" — hence the `device_loss` hook. Middleware/REST surface:
[REST_API.md — /health `audio_health`](../pianoid-middleware/REST_API.md).

---

## LockFreeCircularBuffer

**File:** `CircularBuffer.cuh` / `CircularBuffer.cu`

Ring buffer connecting the GPU synthesis thread (producer) to the audio callback thread
(consumer). Both ASIO and SDL3 drivers use this same class.

```cpp
class LockFreeCircularBuffer {
public:
    LockFreeCircularBuffer(
        size_t chunk_size,          // samples per chunk
        size_t num_chunks,          // total slots
        size_t num_chunks_in_buffer,// active circular range
        int    num_channels         // audio channels
    );

    bool cudaSetup(int device_id);
    bool isCudaReady() const;

    bool produce(const Sint32* gpu_data); // GPU memory → buffer; waits ≤ 200 ms for a slot, false on timeout (dev-19be)
    bool consume(uint32_t* (*source_of_pointers)); // buffer → caller; false if empty

    size_t getAvailableChunks()     const;
    size_t getFreeChunks()          const;
    double getUtilizationPercent()  const;
    bool   isEmpty() const;
    bool   isFull()  const;
    void   stop();
    void   resume();
};
```

Internal storage is `std::vector<Sint32>` on the CPU. `produce()` performs a
`cudaMemcpyAsync` from GPU to this buffer on a **dedicated non-blocking CUDA stream**
(`produce_stream`), then `cudaStreamSynchronize` on that stream. The dedicated stream
isolates the D→H copy from the synthesis kernel on the default stream — a correctness
/ architecture improvement so the producer copy does not implicitly wait on unrelated
default-stream GPU work. (See Fix F5 in the Buffer Underrun Investigation; note that
the F5 A/B measurement showed this change did not reduce silent-engine underrun rate
at iter=8 or iter=12 — the remaining underruns are synthesis-compute bound.)
`consume()` provides pointers into the buffer for the audio callback to read without
copying.

---

## Audio Pipeline Diagram

```
GPU kernel (addKernel)
  |  dev_soundInt[NUM_CHANNELS × samplesInCycle]  (Sint32, GPU memory)
  |
  v
Pianoid::pushCycleAudioToDriver()  (Online regime only)
  |  audioDriver->pushSamples(dev_soundInt, ...)
  |
  v
LockFreeCircularBuffer::produce(gpu_data)
  |  cudaMemcpyAsync on produce_stream (GPU → CPU Sint32 buffer)
  |  cudaStreamSynchronize(produce_stream)  — no synthesis-stream wait
  |  atomic write_position advance
  |
  v
  [buffer]  Sint32 chunks, num_chunks slots
  |
  v  (audio callback thread)
LockFreeCircularBuffer::consume(channel_pointers)
  |  atomic read_position advance
  |  provide pointer array into buffer
  |
  v
SDL3: audioStreamCallback  /  ASIO: audioCallbackForASIO
  |  downmix 8 channels → stereo (SDL3) or multi-channel (ASIO)
  |
  v
Audio hardware
```

Buffer depth (`circular_buffer_chunks`) trades latency for stability:
- 4 chunks (ASIO default): minimal latency, requires consistent GPU cycle timing
- 16+ chunks (SDL3 default): greater cushion against timing jitter
