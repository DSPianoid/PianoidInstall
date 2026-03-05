# Audio Drivers

## Overview

The audio driver subsystem abstracts platform-specific audio output behind a single
interface. Two driver implementations are provided: `SDL3AudioDriver` for general-purpose
use and `ASIOAudioDriver` for low-latency professional audio on Windows. The active
driver is selected at compile time via `AudioDriverConfig.h` and can be overridden at
runtime through `AudioDriverFactory`.

All audio passes through `LockFreeCircularBuffer`, which decouples the GPU synthesis
thread (producer) from the audio hardware callback thread (consumer).

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

    bool produce(const Sint32* gpu_data); // GPU memory → buffer; false if full
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
`cudaMemcpy` from GPU to this buffer. `consume()` provides pointers into the buffer
for the audio callback to read without copying.

---

## Audio Pipeline Diagram

```
GPU kernel (addKernel)
  |  dev_soundInt[NUM_CHANNELS × samplesInCycle]  (Sint32, GPU memory)
  |
  v
Pianoid::playSoundSamples()
  |  audioDriver->pushSamples(dev_soundInt, ...)
  |
  v
LockFreeCircularBuffer::produce(gpu_data)
  |  cudaMemcpy (GPU → CPU Sint32 buffer)
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
