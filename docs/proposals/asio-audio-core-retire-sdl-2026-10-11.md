# ASIO Audio Core — Retire `sdl_audio_core` / SDL3 for All Use Cases

- **Status:** PARTIALLY IMPLEMENTED — Phase 0 done + Phase 1-lite implemented by dev-1b6c
  (2026-10-11, Core `feature/dev-1b6c-asio-session`, not merged): session inside pianoidCuda +
  `GET /audio/devices` / `POST /audio/session` on `:5000`; rig acceptance passed (§10). Modal
  adapter migration (Phase 3) is next. **User decisions 2026-10-11 override §4/§7 where they
  differ:** (1) the engine's SDL3 fallback driver STAYS; (2) `sdl_audio_core` is NOT retired yet
  (stays until the ASIO path covers all its functions); (3) incremental reuse of the existing ASIO
  host inside pianoidCuda, no new standalone DLL for now (optional later); (D3) licence — open,
  decide later; (D4) loopback `Out 5 → In 8` installed; (D6) synthesis paused during measurements.
- **Date:** 2026-10-11
- **Kind:** Campaign (new shared C++ audio core + Python module; engine driver re-base; modal-collection
  migration; build-system removal of SDL).
- **User directive (verbatim):** "Re-investigate both SDL audio core and Pianoid ASIO driver and figure out
  how to add necessary functionality. ASIO driver is preferable, sdl_audio_core should be replaced and
  retired for all usecases".
- **Trigger evidence:** rig I/O test 2026-10-11 (`D:\scratch\iotest-2026-10-11\summary.json`,
  `main_session.log`) — UMC1820, 4 exciters on OUT 1–4, 7 receivers on IN 1–7.
- **Grounding read:** [AUDIO_DRIVERS.md](../modules/pianoid-cuda/AUDIO_DRIVERS.md),
  [PLAYBACK_SYSTEM.md](../modules/pianoid-cuda/PLAYBACK_SYSTEM.md),
  [MODAL_COLLECTION.md](../modules/pianoid-middleware/MODAL_COLLECTION.md),
  [MODAL_ADAPTER_GUIDE.md](../guides/MODAL_ADAPTER_GUIDE.md),
  [BUILD_SYSTEM.md](../architecture/BUILD_SYSTEM.md),
  [sound-channel-calibration-2026-07-10.md](sound-channel-calibration-2026-07-10.md); then source
  (PianoidCore `feature/dev-d0b7-t5-health` checkout, audio files identical in intent to `dev`).

---

## 1. Summary

1. **`sdl_audio_core` is used only by the modal adapter's acquisition path** (RoomResponse port:
   `RoomResponseRecorder`, `mic_testing.AudioRecorder`, device enumeration, `/devices` endpoints, the
   Tunner Audio-Devices dropdowns) — plus the build. Everything else that touches audio
   (realtime synthesis, mic capture for volume/acoustic calibration, `/play_keyboard capture_mic`,
   sound-channel calibration, sinewave test) already goes through the **engine's** driver layer,
   where **SDL3 is the fallback** (`SDL3AudioDriver`, ASIO→SDL3 runtime fallback, dev-19be
   recovery-onto-SDL3). "Retire SDL for all use cases" therefore means removing **two** things:
   the `sdl_audio_core` extension *and* the engine's `SDL3AudioDriver`/`SDLAudioDriver` fallback.
2. **The engine's ASIO host is already duplex** — `ASIOCreateBuffers` is called for *all* 18 inputs and
   20 outputs of the UMC1820 in one `bufferSwitch`. What it lacks is *API*, not capability: it drives
   only outputs 0–7, captures only input 0 (mono), hard-codes 48 kHz / 64-frame buffers / int32
   samples, exposes no latencies, and lives as process-global state inside the CUDA `.pyd`.
3. **Recommended architecture:** extract a CUDA-free, SDL-free **`pianoid_audio` core** (one ASIO host
   per process, shipped as a DLL) with two front-ends: the engine's synthesis output client
   (pianoidCuda links it) and a **`pianoid_audio` pybind module** for measurement
   (`play_record(signal_matrix, outputs, inputs)` — preloaded output matrix, sample-locked
   multichannel capture in the same `bufferSwitch`, latency-compensated). The **`:5000` backend is the
   single device owner**; the modal adapter (`:5001`) requests measurements from it over REST, and
   opens the core itself only when no backend is running.
4. **Fallback when ASIO is unavailable:** SDL3 goes away; recommend a small **native WASAPI
   (shared-mode) output-only** backend inside the same core for synthesis listening, and
   **ASIO-only, fail-clearly** for every measurement path (decision D1). Linux has no ASIO —
   decision D2.
5. **Effort:** ~14–20 dev-days in 5 phases (§7), acceptance = the rig test re-run on ASIO (each exciter
   alone, 7 receivers synchronous, round-trip latency measured).
6. **Runaway seen today (limiter latched, peak ~1e25):** nothing in the audio path can cause it — the
   limiter peak is measured in `MainKernel` *before* the driver, and no captured input is fed back
   into synthesis. Treat as preset numerics (§8).

---

## 2. Inventory — every `sdl_audio_core` / SDL use

### 2.1 `sdl_audio_core` (pybind extension, `PianoidCore/sdl_audio_core/`, vendored from RoomResponse)

| # | Consumer | What it calls | Needs | Process |
|---|---|---|---|---|
| S1 | `modal_adapter/measurement/recorder.py` `RoomResponseRecorder._record_audio` (collection + Setup Test) | `measure_room_response_auto_multichannel(signal, volume, in_dev, out_dev, input_channels)`; legacy mono `measure_room_response_auto` | **Duplex sync record+play**: one pulse train out (mono today), N-ch synchronous in; 48 kHz; device by ordinal | `:5001` (also MAIN role via the modal blueprint on `:5000`) |
| S2 | `recorder.py` device helpers (L224, L392, L585, L624) + `get_sdl_audio_info()` (L291–360) | `list_all_devices`, `AudioEngine.get_sdl_version`, `get_audio_drivers`, `check_installation`, `get_version`, throwaway `AudioEngine()` | Enumeration (name → ordinal), per-device max channels, diagnostics | `:5001` |
| S3 | `recorder.test_multichannel_recording` | `measure_room_response_auto_multichannel` | Duplex smoke test | `:5001` |
| S4 | `measurement/mic_testing.py` `AudioRecorder` (+ `_SDL_AVAILABLE` flag re-exported to recorder) | `AudioEngine`, `AudioEngineConfig`, `start_recording`, chunk reads | **Input-only streaming** level meter | `:5001` (ported RR tool; no live route uses it today) |
| S5 | `collection_engine.list_audio_devices` → `GET /modal/measurements/<id>/devices`, `/modal/measurements/devices` | `list_all_devices`, `get_sdl_version`; 503 `stack_unavailable` if not importable | Enumeration for the FE dropdowns | `:5001` |
| S6 | `modal_adapter_server.py` startup probe | `import sdl_audio_core`, `get_sdl_version` / `SDL_VERSION` | Availability banner | `:5001` |
| S7 | Tunner `modules/panels/collection/AudioDevicesSection.jsx` | the `/devices` payload (`input_devices`, `output_devices`, `sdl_version` chip) | Device pickers (SDL **endpoint ordinals**, which rotate between sessions) | FE |
| S8 | Tests: `tests/integration/test_measurement_port.py`, `test_measurement_collect_routes.py`, `test_v1_collect_410.py`; `tests/unit/test_sound_channel_calibrator.py` (skip-guard only) | import / mocked `CollectionUnavailableError("sdl_audio_core missing")` | — | — |
| S9 | Build: `build_pianoid_cuda.bat :build_sdl_audio_core` (SAC 1–3 + SDL3.dll deploy next to the `.pyd`), `PianoidCore/.gitignore`, `sdl_audio_core/SDL3.dll`; `BUILD_SYSTEM.md` §sdl_audio_core | pip build | SDL3.dll is a **build holder** (WIP: a backend that imported `sdl_audio_core` locks SDL3.dll → pip uninstall WinError 5 → venv left without `pianoidCuda`) | — |
| S10 | Ad-hoc tools: `D:\scratch\iotest-2026-10-11\run_session.py`, `capture.py` | `AudioEngine.start_synchronized_recording_and_playback`, `measure_room_response_auto_multichannel` | The rig test itself | scratch |
| S11 | Docs: MODAL_COLLECTION, MODAL_ADAPTER_GUIDE (Audio Devices section), middleware OVERVIEW, BUILD_SYSTEM, sound-channel-calibration proposal/seed | — | — | — |

Not consumers (checked): live processing (`live_processing_orchestrator.py`, post-scenario
DSP only), ESPRIT/analysis, PianoidBasic, `/diagnose` (uses engine mic capture, see 2.2).

### 2.2 SDL3 inside the engine (`pianoidCuda`) — the other half of "retire SDL"

| # | Consumer | Path | Needs |
|---|---|---|---|
| E1 | Realtime synthesis output fallback | `AudioDriverFactory` → `SDL3AudioDriver` (8 GPU ch downmixed to stereo); `Pianoid::startAudioDriver` ASIO→SDL3 fallback; dev-19be `fallBackToSdl3()` in `recoverAudioDriver` (state `fallback`) | Output-only, any default endpoint, survives ASIO device loss. **Actively relied on**: WIP records the backend running on the SDL3 fallback for ~2 days (2026-10-09, UMC absent). |
| E2 | Engine mic capture when the engine is on SDL3 | `SDL3AudioDriver::startCapture` (default recording device, own stream), `setMicDevice` / `listMicDevices` → `GET /mic_devices`, `POST /set_mic_device` | Input-only, selectable device |
| E3 | Explicit `audio_driver_type: 3` (SDL3) / `2` (SDL2, not compiled) | `/load_preset`, `/diagnose` skill menu (still offers "SDL2 (safe default)" / SDL3 — stale), tests `test_asio_fallback.py`, `test_load_preset_audio_driver_type_0.py`, `test_performance_audio_on.py`, `tests/system/conftest.py`, `cycle_profile.py`, `test_audio_health.py`, `test_engine_lifecycle_gate.py` | — |
| E4 | FE text | `BackendStatusIndicator.jsx` ("ASIO unavailable — using SDL3") + its Jest tests, `useBackendHealth.audioHealth.test.js` | — |
| E5 | Build | `pianoid_cuda/setup.py` SDL2/SDL3 detection + SDL3.dll copy; `AudioDriverConfig.h` default `USE_SDL3_AUDIO`; Linux `build_pianoid_cuda.sh` requires `libsdl3-dev` | `setup.py` **already supports an "ASIO-only mode — no SDL library linked"** (Windows) |

### 2.3 Engine audio consumers that already use the ASIO host (migrate to the new API, not away from SDL)

| # | Consumer | Calls | Needs |
|---|---|---|---|
| A1 | Realtime synthesis (`ASIO_CALLBACK`, type 4) | `LockFreeCircularBuffer` → `audioCallbackForASIO` → outputs 0–7 | Output, 8 ch, 64-frame chunks = `segment_length`, 750 callbacks/s |
| A2 | `/play_keyboard capture_mic`, `measurement_engine.py` (`/calibrate_volume`, `/calibrate_acoustic`, calibration-curve RCM), `chartFunctions.py` sound-test chart, `acoustic_tuner` | `startMicCapture` / `stopMicCapture` / `analyzeCapturedAudio*` | Input-only capture **while synthesis plays** (synthesis→mic transfer ratio) — mono input 0 today |
| A3 | Sound-channel calibration (`sound_channel_calibrator.py`, `calibration_routes.py`, `asio_drive.py`) | `startMicCapture` + `playRecordedAudio(interleaved, coeff)` (dev-scr1 recorded-playback override inside the ASIO callback) | **Duplex**: per-actuator signed drive on outputs 0..N-1 + synchronous capture. This is the prototype of the service proposed below. It moved here *because* running SDL3 RoomResponse concurrently with the engine's ASIO in one process crashed (0xC0000005, "dual-subsystem crash"). |
| A4 | `SinewaveGenerator` / `testSinewave` | `AudioDriverFactory::createDriver(cfg, nullptr)` | Output-only test tone — proves the ASIO driver already runs **without** a `Pianoid` object (but still inside the CUDA `.pyd`) |

### 2.4 Rig-test defects (all in `sdl_audio_core`; none exist in the ASIO host)

| Defect | Root cause (verified in source) |
|---|---|
| (1) No per-output-channel playback; `OUT 01-10` endpoint fails to open | `AudioEngine` opens playback with `spec.channels = 1` and replicates mono to every channel of a WASAPI *endpoint* (stereo pairs `OUT 01-02` …). SDL3 also rejects >8 channels (`'dst_spec->channels' is invalid` for the 10-ch endpoint). WASAPI shared mode exposes the UMC as pair endpoints — per-channel drive is structurally unavailable. |
| (2) Half-speed playback on stereo endpoints | `audio_engine.cpp` overwrites `output_spec_` with the **device** format (2 ch) after opening a **mono** app-side stream; the callback's `count` is in mono samples but the code de-frames it as `count / 2` frames and interleaves 2 samples per frame → consumes the signal at half rate. |
| (3) Device ids rotate between sessions | SDL ordinals are indices into a per-session list; the recorder resolves name→ordinal in one SDL session and opens in another. |
| (4) Output start vs input jitter ≤ 1 buffer | Separate WASAPI input and output streams, each with its own callback; collection compensates by aligning on the calibration-channel onset. |

---

## 3. The Pianoid ASIO host today — capabilities and gaps

Files: `pianoid_cuda/AsioAudioInterface.{h,cpp}` (host), `ASIOAudioDriver.{h,cpp}` (engine adapter),
`CaptureBuffer.h`, `AudioWatchdog.{h,cpp}`, `Pianoid_audio.cu`; vendored Steinberg SDK
`asio.cpp`, `asiodrivers.cpp`, `asiolist.cpp`, `asiosys.h`, `iasiodrv.h`.

**Measured device facts** (from 800+ opens in `PianoidCore/logs/pianoid_runtime.log`; no new probe run —
see note below): `UMC ASIO Driver` → **18 inputs / 20 outputs**, buffer **min 8 / max 2048 / preferred 64 /
granularity −1** (powers of two), **48000 Hz**, `ASIOOutputReady` not supported,
**`ASIOGetLatencies` input 136 / output 168 samples** at buffer 64 (= 304 samples ≈ 6.3 ms reported
round-trip). Other registered ASIO drivers: `Realtek ASIO` (2/2, fixed 1024 or 528 buffer, reports
0 Hz), `ASIO 2.0 - ESI GIGAPORT eX` (2 in / 8 out), `Ableton Push`. dev-19be established the UMC
driver is **multi-client** (a second process can open it).

> Hardware probe: the user's stack was live on ASIO_CALLBACK during this investigation
> (`/health` state `ok`). Opening the driver from a second process risks a `kAsioResetRequest` →
> watchdog re-open glitch on the live engine, so channel names / sample types were **not** probed;
> Phase 0 does it with the stack down. (Note: `/health` already shows `asio_reset_requests: 6` today
> with `recovery_count: 0` — possibly provoked by the WASAPI rig session on the same device; worth
> checking in Phase 0.)

| Area | Today | Gap for the measurement use cases |
|---|---|---|
| Duplex | `create_asio_buffers` creates buffers for **all** inputs + outputs (≤ 32 each); one `bufferSwitchTimeInfo` serves both → **sample-locked in/out already** | — (the key capability exists) |
| Outputs used | Engine path writes outputs `[0..NUMBER_CHANNELS=8)` (`pointersToBuffersArray`); no routing map | Arbitrary output channel selection (UMC has 20); guard when a driver has < 8 outputs (today a 2-output driver would hand null buffer pointers to the callback) |
| Inputs used | `CaptureBuffer` mono, **input 0 only** | Multichannel capture of a selected input set |
| Sample format | Hard-coded int32 out; capture assumes int32 with `BIT_DEPTH=24` scaling (`1/2^23`) | Per-channel `ASIOGetChannelInfo.type` conversion (Int32LSB / Int24LSB / Float32LSB / Int16LSB / Int32LSB24 …). **Suspected bug:** if the UMC delivers `ASIOSTInt32LSB` (the output path working with raw int32 strongly suggests it), full-scale input reads as ±256 rather than ±1 — verify in Phase 0. |
| Buffer size | `BUFFER_SIZE=64` constant forced into `preferredSize` (no min/max/granularity check) | Configurable + validated. The engine's ring requires ASIO buffer == `segment_length` (one chunk per callback) — keep that as an engine-client constraint, not a host constraint |
| Sample rate | Forced 48 kHz (`fSAMPLES_PER_MS`), `ASIOCanSampleRate` not used | Configurable, validated |
| Latency | `ASIOGetLatencies` queried and **only logged** | Exposed; re-read on `kAsioLatenciesChanged` |
| Channel names | not read | `ASIOGetChannelInfo.name` → stable name-based selection |
| Ownership | Process-global C statics (`asioDriverInfo`, `directOutputFn`, `queueToPlay`, `ASIOAudioDriver::staticDriverInstance/staticCaptureBuffer`); compiled **inside `pianoidCuda.pyd`** (CUDA-dependent: `LockFreeCircularBuffer::produce` does `cudaMemcpyAsync`) | A CUDA-free host usable by a measurement process without the engine |
| Threading | Driver's callback thread → `audioCallbackForASIO` (takes `statsMutex` every callback); legacy polling path uses a `std::mutex` queue and unbounded spin (`pushToAudioDriver`, WIP follow-up) | Lock-free callback; bounded everything |
| Duplex playback API | `playRecordedAudio` (ASIO_CALLBACK): host buffer emitted from the callback while `CaptureBuffer` records — blocking with timeout; synthesis paused around it via `enter_calibration_mode(keep_audio=True)` | Generalise: preloaded output **matrix** + multichannel capture + common start sample position + latency compensation |
| Fault handling (dev-19be) | `asioMessages` latches `kAsioResetRequest`; `AudioWatchdog` (synthesis-thread) closes/re-opens (3 s bounded teardown), falls back to SDL3; heartbeat, producer-timeout, `injectAudioFault` test hook, `/audio/reopen` | Keep semantics; move device-level parts into the core so a measurement session also fails fast (not hangs) on stall/reset |
| Driver choice | Cached name (`asio_driver_cache.txt`) then first driver that opens | Explicit driver by name (+ cache), refuse drivers with too few channels |
| Python exposure | Only via `pianoidCuda.Pianoid`: `startMicCapture/stopMicCapture/isMicCapturing`, `playRecordedAudio`, `listMicDevices/setMicDevice`, `getCallbackStats`, `getAudioHealth`, `injectAudioFault`, `testSinewave`, `SinewaveGenerator` | Standalone module |
| Without synthesis | Possible inside the `.pyd` (`SinewaveGenerator` uses `createDriver(cfg, nullptr)`), but requires the CUDA build + runtime | Standalone, CUDA-free |
| Concurrent with synthesis | ASIO SDK = **one loaded driver per process** (global `asioDrivers` / `theAsioDriver`); in-process sharing must therefore go through one host. Cross-process works only on multi-client drivers (UMC yes; many are single-client) | Single-owner policy (§4.4) |

---

## 4. Recommended architecture

### 4.1 Shape

```
                  +--------------------------------------------------------------+
                  |  pianoid_audio_core.dll   (C++17, no CUDA, no SDL)            |
                  |                                                              |
                  |  AsioHost (process singleton)                                |
                  |   open(driver, sr, buf) / close / reopen   watchdog hooks    |
                  |   channel table: {index, name, type, group} in/out          |
                  |   latencies (in, out), samplePosition per bufferSwitch       |
                  |   format converters (per channel ASIOSampleType)             |
                  |                                                              |
                  |   bufferSwitch(index):                                       |
                  |     for each OutputClient: render(ownedChannels, frames)     |
                  |     for each CaptureTap:   append(selectedInputs, frames)    |
                  |   (lock-free; SPSC rings; no allocation; no Python)          |
                  |                                                              |
                  |  Clients:                                                    |
                  |   - SynthOutputClient  (ring fed by the engine, GPU->CPU)    |
                  |   - MatrixPlayer       (preloaded frames x nOut float32)     |
                  |   - CaptureTap         (preallocated frames x nIn float32)   |
                  |   - (later) MonitorClient                                    |
                  |  Routing/ownership: each physical output owned by <=1 client |
                  |                                                              |
                  |  Fallback backend: WasapiOutput (shared, output-only) [D1]   |
                  +----------------------+-------------------+-------------------+
                                         |                   |
              pianoidCuda.pyd (links the DLL)         pianoid_audio.pyd (pybind, thin)
              ASIOAudioDriver = SynthOutputClient     list_drivers / probe / host()
              + startMicCapture compat (CaptureTap)   play_record / record / play
              + playRecordedAudio compat (MatrixPlayer)  info / latencies / stats / health
```

Why a **DLL** and not a static library: two `.pyd` modules in one process (pianoidCuda + pianoid_audio)
must see **the same** `AsioHost` singleton (the ASIO SDK itself allows one driver per process). A static
lib linked into both would create two singletons and two loaded drivers. Both `.pyd`s link
`pianoid_audio_core.dll`, deployed next to `pianoidCuda` (same mechanism as `cudart64_*.dll` today).

### 4.2 Measurement session (replaces `measure_room_response_*` and `start_synchronized_recording_and_playback`)

1. Python passes a **preloaded** output matrix `float32[frames, n_out]` + output channel list + input
   channel list + `pre_roll`/`post_roll` frames. The core copies it once; nothing is generated per
   buffer in Python (no GIL in the audio path, no underruns from Python).
2. The session **arms on a bufferSwitch boundary**: on switch `k` (sample position `P`) the MatrixPlayer
   writes frame 0 and the CaptureTap starts writing input frame 0 — both from the same `index` buffer
   half. Output frame `n` and input frame `n` share the hardware sample clock → **(4) eliminated**:
   the residual offset is a constant, not jitter.
3. **Latency compensation:** the physical round trip = `out_latency + in_latency (+ converter /
   driver safety offset not always included in the report)`. The session returns raw data **and**
   `roundtrip_frames` (reported) and, if configured, a **calibrated** per-(driver, sr, buffer) offset
   measured once with an electrical loopback (§4.6). `compensate=True` trims the leading
   `roundtrip_frames` so `data[n]` aligns with `signal[n]`. The calibration-channel onset alignment
   in the averager is kept as a **check** (assert |residual| ≤ 1 sample), not as the alignment
   mechanism.
4. Completion: callback marks done; Python waits with GIL released and a timeout derived from the
   length; a watchdog fault (stall / reset request) aborts the session with an error instead of hanging.
5. Output float→driver format conversion with clamp; per-channel gain.

### 4.3 Python API (sketch)

```python
import pianoid_audio as pa

pa.list_drivers()                      # ["UMC ASIO Driver", "Realtek ASIO", ...]
pa.probe("UMC ASIO Driver")            # channels (index, name, type), buffer sizes, rates; uses the
                                       # live host if already open in-process, else Init->query->Exit
h = pa.host()                          # process singleton
h.open(driver="UMC ASIO Driver", sample_rate=48000, buffer_size=64)  # idempotent; error if the
                                       # engine already holds it with a different config
h.info()       # {driver, sample_rate, buffer_size, in_latency, out_latency, inputs[], outputs[], owner_map}
r = h.play_record(signal,               # np.float32 [frames, n_out]
                  outputs=["OUT 1", "OUT 2", "OUT 3", "OUT 4"],   # names or indices
                  inputs=[f"IN {i}" for i in range(1, 9)],
                  post_roll_s=1.0, compensate_latency=True, timeout_s=None)
r.data          # np.float32 [frames + post, n_in]
r.start_sample_position, r.roundtrip_frames, r.compensated, r.xruns, r.driver_messages
h.record(inputs=[...], seconds=2.0)     # input-only (mic level meter, ambient)
h.play(signal, outputs=[...])           # output-only
h.stats(); h.health()
```

Python-side **`AudioIO` protocol** with two implementations so callers do not care which process owns
the device: `LocalAudioIO` (calls `pianoid_audio` in-process) and `RemoteAudioIO` (calls the `:5000`
backend). Middleware REST on `:5000`:

| Endpoint | Purpose |
|---|---|
| `GET /audio/devices` | drivers + live channel table (names, types), sr/buffer, latencies, owner map |
| `POST /audio/session` | play_record / record / play; body = signal file path (`.npy` in the measurement folder) + channel lists + options; pauses synthesis on overlapping outputs (§4.4); writes result `.npy`, returns metadata |
| `GET /audio/session/<id>` | status (for long collections; cancel via `DELETE`) |
| existing `/health` `audio_health`, `/audio/reopen`, `/debug/audio_fault` | unchanged, now covering sessions too |

### 4.4 Coexistence with realtime synthesis

- **Single device owner per machine = the `:5000` backend** (it always holds ASIO when running). The
  modal adapter (`:5001`) uses `RemoteAudioIO`; only when `:5000` is down does it host the core
  itself (`LocalAudioIO`). This removes the cross-process two-client situation entirely, so
  single-client ASIO drivers on other hardware also work.
- **Output ownership:** the GPU's 8 output channels map to physical outputs via a routing map
  (default identity `0..7` = today's behaviour). The exciters (OUT 1–4) are *synthesis* outputs too,
  so a measurement session on OUT 1–4 must take them. Default policy = **exclusive-with-pause**: the
  session calls the engine's `enter_calibration_mode(keep_audio=True)` (synthesis loop stopped, ASIO
  left running — no close/re-open, no reset glitch), runs, then resumes — exactly what sound-channel
  calibration does today. The ownership map additionally allows **concurrent** use on *disjoint*
  channels later (e.g. synthesis monitored on OUT 5–6 while exciters 1–4 measure) — optional, not
  required for acceptance.
- **Inputs** are never owned by synthesis; capture taps can run while synthesis plays (A2 use case:
  synth→mic transfer ratio) — now multichannel and on any input.
- Config conflicts (a session wants 96 kHz while the engine runs 48 kHz) → explicit 409; the engine's
  rate/buffer win while it is active.

### 4.5 Fallback when ASIO is unavailable (SDL3 removed)

| Use | Recommendation |
|---|---|
| Realtime synthesis listening | **WASAPI shared-mode, output-only** backend in the core (native Win32, no DLL dependency; stereo downmix like `SDL3AudioDriver` does today). Keeps the dev-19be `fallback` state and the "device absent → still hear sound" behaviour that the user relied on 2026-10-09..11. Alternative: no fallback, `/health` `failed` + FE alert (decision **D1**). |
| Mic capture for calibration (A2) | WASAPI capture on the same fallback backend, *or* refuse with a clear error. Recommend: refuse (calibration needs the measurement interface anyway). |
| Modal collection, sound-channel calibration, rig tests | **ASIO-only, fail clearly** (`503 asio_unavailable` + reason). Per-channel exciter drive and sample-locked duplex are impossible through WASAPI shared pair-endpoints — that is precisely what the rig test proved. |

### 4.6 Hardware recommendation: permanent electrical loopback

IN 8 is unused (rig noise floor −109 dBFS = nothing connected) and OUT 5–10 are free. Patch a spare
output (e.g. **OUT 5 → IN 8**) and emit a short marker on it in every session: this gives a measured,
per-session round-trip (sample-exact) independent of what the driver reports, and a permanent self-test
for the acceptance suite (decision **D4**).

---

## 5. Consumer → replacement map

| Consumer | Replacement |
|---|---|
| S1 `RoomResponseRecorder._record_audio` | `AudioIO.play_record(signal_matrix, outputs=<exciter set>, inputs=<calibration + response channels>)`. The pulse train becomes a matrix column per exciter ("each exciter alone" = one-hot columns, sequential scenarios; simultaneous patterns become possible). |
| S2/S5/S6 enumeration, `/devices`, startup probe | `pa.list_drivers()`, `GET /audio/devices` (driver + channel **names**); `/modal/measurements/<id>/devices` returns `{driver, sample_rate, buffer_size, latencies, inputs[{index,name}], outputs[...]}`; `sdl_version` → `asio_driver`. |
| S3 multichannel smoke test | `play_record` with a 100 ms tone. |
| S4 `mic_testing.AudioRecorder` | `AudioIO.record` (or delete — no live route uses it). |
| S7 Tunner Audio Devices section | Driver select + **output channel multi-select** + **input channel multi-select** by name; role assignment (calibration / response / reference) stays in `multichannel_config`. |
| Setup schema (`audio_config.input_device/output_device` ordinals + names) | New `audio_config.driver`, `output_channels: [names]`, `input_channels: [names]`; loader maps legacy fields (ordinal ignored, name kept for provenance) so imported RoomResponse datasets and existing Measurements still open. |
| A1 synthesis | `SynthOutputClient` on the core (same ring, same 64-frame chunk), routing map. |
| A2 mic capture APIs | `startMicCapture/stopMicCapture` kept as compat wrappers over a `CaptureTap` (`inputs=[mic_channel]`); new optional `channels` arg; correct per-format scaling. |
| A3 `playRecordedAudio` | Compat wrapper over `MatrixPlayer`; `sound_channel_calibrator` moves to `play_record` (one call instead of start/play/stop). |
| A4 `SinewaveGenerator` | `pa.host().play(...)` (or keep as engine test). |
| E1 SDL3 fallback | WASAPI output backend (D1) — `fallBackToSdl3()` → `fallBackToWasapi()`; `audio_driver_type` 3 → mapped to WASAPI (or rejected) with a deprecation note. |
| E2 `/mic_devices`, `/set_mic_device` | `GET /audio/devices` + input-channel selection. |
| E3/E4 tests, `/diagnose` menu, FE text | Updated per Phase 4; `/diagnose` offers ASIO (+ WASAPI fallback) only. |
| S9/E5 build | Remove `:build_sdl_audio_core`, SDL3.dll deploys, SDL detection in `setup.py` (use the existing ASIO-only mode); add `pianoid_audio_core` build step; SDL3.dll disappears from the build-holder list. |

---

## 6. Verification surfaces / acceptance

- **Rig acceptance (the 2026-10-11 test, re-run on ASIO):** per exciter OUT 1..4 alone (one-hot matrix),
  7 receivers + loopback IN 8 captured in one session; assert: correct tone frequency (no half-speed),
  energy only when the intended exciter drives (cross-talk matrix like `response_matrix.png`), per-repeat
  phase spread ≤ today's 0.3° and **inter-run onset spread = 0 samples** on the loopback channel,
  round-trip latency reported vs measured (store the delta).
- **Synthesis regression (audio_on):** 3 × 10 s ASIO: 750 cycles/s, 0 underruns, 0 producer timeouts,
  callback ≈1333 µs (dev-19be baseline); `/play` p60 peak unchanged; dev-19be fault-injection suite
  (reset_request, stall, device_loss → fallback, device_return + `/audio/reopen`).
- **Mic-engaging (`/diagnose` Phase 7):** `analyzeCapturedAudioWithReference` transfer ratio unchanged
  except the expected scale correction if the int32 capture bug is confirmed.
- **Unit (no hardware):** a `FakeAsioDriver` (IASIO implementation with configurable channel counts,
  sample types, buffer sizes, loopback delay) loaded through the same host → deterministic tests for
  routing, format conversion, session arming, latency compensation, watchdog abort.
- **Build:** clean venv build with no SDL3 anywhere (`Get-Process` module scan shows no SDL3.dll).

---

## 7. Migration plan

| Phase | Content | Exit criterion | Effort |
|---|---|---|---|
| **0 — Probe & pin facts** (stack down) | Small console probe (C++ or ctypes on IASIO): UMC channel names/types/groups, `ASIOCanSampleRate` 44.1/48/96, latencies for buffers 32/64/128/256; loopback OUT5→IN8 round-trip measured; confirm/deny int32 capture-scale bug; check whether WASAPI sessions on the UMC trigger `kAsioResetRequest` in a live ASIO client | Facts table appended to this doc + AUDIO_DRIVERS.md | 0.5–1 d |
| **1 — `pianoid_audio_core` + `pianoid_audio` module** | Host extracted from `AsioAudioInterface` (SDK files moved), channel table, format converters, configurable sr/buffer with validation, latencies, lock-free callback, MatrixPlayer / CaptureTap / session arming, watchdog hooks, FakeAsioDriver tests, WASAPI-free for now; standalone pybind module; new build step | Rig acceptance passes **standalone** (`:5000` stopped) from a Python script | 4–6 d |
| **2 — Engine re-base** | `ASIOAudioDriver` → `SynthOutputClient`; remove `BUFFER_SIZE`/`NUMBER_CHANNELS`/48k constants from the engine path; routing map; `startMicCapture`/`playRecordedAudio` compat wrappers; dev-19be watchdog on the core; HEAVY rebuild | Synthesis regression + fault-injection suite green; sound-channel calibration unchanged on the rig | 3–4 d |
| **3 — Measurement migration** | `/audio/devices`, `/audio/session` on `:5000`; `AudioIO` Local/Remote; `RoomResponseRecorder` backend swap; setup-schema migration + legacy import mapping; Tunner Audio Devices section (channel pickers); collection pause/resume replaced by session-level ownership | Rig acceptance through the **UI** collection flow; existing Measurements/imports still open; Jest + integration green | 3–5 d |
| **4 — Retire SDL** | WASAPI output fallback (if D1 = yes) → `fallBackToWasapi`; delete `sdl_audio_core/`, `SDL3AudioDriver`, `SDLAudioDriver`, SDL `setup.py` paths, build-bat SAC steps, `mic_testing` SDL code; update tests, `/diagnose` + `/startup` skills, FE fallback text, docs (AUDIO_DRIVERS, BUILD_SYSTEM, MODAL_COLLECTION, MODAL_ADAPTER_GUIDE, STARTUP_TROUBLESHOOTING, REST_API) | No SDL symbol/DLL in the build; device-absent → WASAPI fallback (or clear failure) verified with `device_loss` hook | 2–3 d (+1–2 d WASAPI) |
| **5 — Linux** (D2) | Either declare Linux `audio_off`-only (offline render + headless) or add a JACK/PipeWire backend (JACK is duplex + sample-locked like ASIO) | per decision | 0 d or 4–6 d |

Total ≈ **14–20 dev-days** (Windows), Phases 1–2 gated by Phase 0 facts. Phases 1 and 3 are mostly
new code with low merge risk; Phase 2 touches `.cu`/`.cpp` → `/dev` + HEAVY build discipline.

---

## 8. Risks and notes

- **ASIO SDK licensing / redistribution.** The repo vendors Steinberg SDK sources (`asio.cpp`,
  `asiodrivers.cpp`, `asiolist.cpp`, `asiosys.h`, `iasiodrv.h`). Distribution of SDK sources/binaries
  is governed by Steinberg's license (historically a signed proprietary agreement; Steinberg announced
  a dual GPLv3 / proprietary licensing of the ASIO SDK in 2025 — verify the current terms and which
  applies to this repo). Moving the files into the new core does not change the obligation (decision **D3**).
- **Single-client ASIO drivers** on other hardware: handled by the single-owner policy (§4.4); the
  standalone mode refuses with a clear "device held by backend" message.
- **Thread priority / MMCSS:** the bufferSwitch thread belongs to the driver (its priority is set by the driver — not
  measured here; Phase 0 can read it);
  the core must never block in it (today's `statsMutex` lock per callback and the mutex-guarded
  `CircularBufferAsio` are removed). The engine's synthesis thread keeps its Pro-Audio MMCSS (bf48343).
- **Underruns from Python-side generation:** eliminated by design — signals are preloaded matrices,
  captures are preallocated; Python is never on the real-time path.
- **Memory:** an 8-in × 60 s × 48 kHz float32 capture = 92 MB; cap session length and stream long
  collections in segments (one session per scenario repeat, as today).
- **Hard-coded driver fallback order** today can open `Realtek ASIO` / `GIGAPORT` when the UMC is absent;
  the core must require an explicit driver (or a channel-count check) so the engine does not end up on
  the wrong device silently.
- **Behaviour change for users of `audio_driver_type: 3`** (explicit SDL3): mapped/deprecated in Phase 4.
- **Runaway today (limiter latched, peak ~1e25):** not audio-path. `dev_limiter_peak` is written in
  `MainKernel` from the post-volume synthesis output *before* the driver; drivers only consume the
  ring (a stall drops chunks / produces silence, never energy); captured input is never fed into
  synthesis; the only internal loop (output feedback/feed-in) is on the GPU. Most likely preset
  numerics (unstable mode / feedback parameters — cf. the NaN-gate and reset-loop notes). Not
  investigated further here.

---

## 9. Open decisions for the user

| ID | Decision | Recommendation |
|---|---|---|
| **D1** | Fallback when ASIO is unavailable: (a) native WASAPI shared output-only for synthesis listening; (b) no fallback — fail clearly (`/health failed`, FE alert) | (a) for synthesis; measurement always ASIO-only |
| **D2** | Linux audio after SDL removal: (a) `audio_off`-only on Linux; (b) JACK/PipeWire backend in the core | (a) now, (b) only if Linux realtime is needed |
| **D3** | ASIO SDK license basis for the vendored sources (proprietary agreement vs GPLv3 option) | Confirm before Phase 1 moves the files |
| **D4** | Install a permanent loopback (e.g. OUT 5 → IN 8) as the per-session timing reference | Yes |
| **D5** | Measurement process placement: (a) `:5000` owns the device, `:5001` uses REST (`RemoteAudioIO`), standalone only when `:5000` is down; (b) move all acquisition routes into the MAIN role | (a) |
| **D6** | During a measurement: pause all synthesis (exclusive-with-pause), or keep synthesis on disjoint outputs | Pause all (default); disjoint-channel concurrency later if wanted |
| **D7** | Keep the calibration-channel onset alignment after sample-locked duplex lands — as a check only, or drop | Keep as an assertion (≤ 1 sample) for one release, then drop |

---

## 10. Implementation record — Phase 0 + Phase 1-lite (dev-1b6c, 2026-10-11)

**Phase 0 facts** (standalone probe, stack down) are in
[AUDIO_DRIVERS.md — Rig facts](../modules/pianoid-cuda/AUDIO_DRIVERS.md#rig-facts-umc1820-phase-0-probe-2026-10-11-stack-down):
all 38 channels `ASIOSTInt32LSB`; 44.1–96 kHz; latencies per buffer size; driver callback
thread priority 15; **capture-scale bug confirmed** (1/2^23 vs 2^31 → ×256) and fixed; loopback
`Out 5 → In 8` round trip 334–335 frames vs reported 304.

**Phase 1-lite as built** (differs from §4.1 by user decision — no DLL, no standalone host):
`AsioSession` (session + device snapshot) hooked into the existing host's `bufferSwitch` after the
engine client; per-type conversion `AsioSampleFormat.h`; module functions
`pianoidCuda.asio_device_info()` / `asio_play_record()`; REST in `audio_session.py` /
`audio_session_routes.py` (nested in the `/audio` blueprint). Design + acceptance numbers:
[AUDIO_DRIVERS.md — ASIO Measurement Session](../modules/pianoid-cuda/AUDIO_DRIVERS.md#asio-measurement-session-dev-1b6c),
[REST_API.md — POST /audio/session](../modules/pianoid-middleware/REST_API.md#post-audiosession).
Not done (by scope): configurable rate/buffer, `GET/DELETE /audio/session/<id>`, engine-free
host, `startMicCapture` multichannel, modal adapter migration (next), SDL removal (deferred by
the user).
