# Proposal: Split the `Pianoid.cu` God-Object

**Date:** 2026-05-19
**Status:** Planning only — research + design. No code changes proposed for immediate execution.
**Scope:** `PianoidCore/pianoid_cuda/Pianoid.cu` (2988 LOC) and `Pianoid.cuh` (758 LOC).
**Author:** investigation sub-agent (docs-first per CLAUDE.md Documentation-First rule).
**Revision history:**
- Draft 1 — 8-file split chosen to make every file small and map one-file-per-doc-page.
- Revision 2 (module-substance criterion) — restructured around "every extracted module must own a clear entity."
- **Revision 3 (this document, 2026-05-19) — deep re-validation against the user's three explicit criteria (§0). Each candidate module is now individually scored against all three. The revision found and fixed a counting inconsistency in Revision 2 (`Pianoid_debug.cu` was kept in the verdict table but silently dropped from the file set) and surfaces two shared-touch trigger flags Revision 2 left buried (§6.5).**

---

## 0. The Acceptance Criteria — Three Tests, Applied Per Module

This revision evaluates every candidate extracted module against **three
criteria the user set verbatim**. A module is extracted **only if it passes
all three**:

> 1. **Clear functionality** — it performs an identifiable, nameable job.
> 2. **Cohesion** — its contents genuinely belong together (one reason to change).
> 3. **Single authority** — it *owns* the methods and entities it contains; it
>    does **not** share write-authority over its state with what remains in
>    `Pianoid.cu` or with another module.

The user gave two calibration points:

- **GOOD extraction — "preset library management."** Substantive, cohesive,
  owns its entities. This is the *bar* a module must clear.
- **BAD extraction — "audio management functions."** The audio wrappers in
  `Pianoid.cu` are thin pass-throughs to audio-driver methods; they are *not*
  a meaningful module on their own. They must be **relocated** into the
  audio-driver subsystem, **not** stood up as a freestanding `Pianoid_*`
  module. A candidate that is just thin wrappers **fails criterion 1** — it
  has no real functionality of its own.

These three criteria are not new project rules; they are
[`CODE_QUALITY.md`](../development/CODE_QUALITY.md) **P1 + P2 applied to this
split**:

| User's criterion | CODE_QUALITY principle |
|---|---|
| 1. Clear functionality + 2. Cohesion | **P2 — Separation of Concerns.** "Each module has one reason to change." "If you struggle to give a module a short noun-phrase name, its concern is not clear." |
| 3. Single authority | **P1 — Separation of Authority.** "Every piece of state has exactly one owner… Everything else reads it through the owner's interface." |

So this proposal is, at root, a P1/P2 audit of `Pianoid.cu`. Every verdict
below cites which criterion drove it.

**Verdict table (deep pass — full reasoning in §4–§6):**

| Candidate | C1 clear? | C2 cohesive? | C3 single authority? | Verdict |
|---|---|---|---|---|
| `Pianoid_presets.cu` (section O) | YES | YES | YES | **EXTRACT — strongest. The user's "good example."** |
| `Pianoid_parameters.cu` (E + F) | YES | YES | YES | **EXTRACT** |
| `Pianoid_excitation.cu` (I) | YES | YES | YES* | **EXTRACT** (*one trigger-flag note — §6.5) |
| `Pianoid_synthesis.cu` (J + K + L-output) | YES | YES | YES | **EXTRACT — absorbs the cycle's audio-output stage** |
| `Pianoid_calibration.cu` (M-calibration cluster) | YES | YES | YES* | **EXTRACT** (*one loop-flag note — §6.5) |
| `Pianoid_debug.cu` (section G) | YES | YES | YES | **EXTRACT — Revision 2 dropped this by mistake; restored** |
| `Pianoid_internal.cuh` | n/a — a header, not a module | | | **CREATE** (shared preamble enabler) |
| ~~`Pianoid_audio.cu`~~ (L/M/N wrappers) | **NO** — thin pass-throughs | NO | **NO** — driver owns everything | **REJECT → relocate wrappers to audio-driver subsystem** |
| ~~`Pianoid_playback.cu`~~ (section P) | **NO** — facade-exposure shims | marginal | **NO** — `OfflinePlaybackEngine`/`WavWriter` own it | **REJECT → fold 3 shims into `Pianoid.cu`** |
| ~~`Pianoid_profiling.cu`~~ (section N profiling) | **NO** — thin forwards | — | **NO** — `profiler_` owns it | **REJECT → keep shims in `Pianoid.cu` (no subsystem to relocate to — §4.4)** |

**Net result: 8 files** — the slimmed `Pianoid.cu` + `Pianoid_internal.cuh` +
**6 substantive extracted modules** (`_parameters`, `_presets`, `_excitation`,
`_synthesis`, `_calibration`, `_debug`). **Plus a relocation** of ~10 thin
wrapper methods out of `Pianoid.*` entirely, into the audio-driver subsystem.

> **Correction vs Revision 2.** Revision 2's prose said "6 files" and its §7.2
> table listed only 5 new `.cu` modules — it had kept `Pianoid_debug.cu` in
> its verdict table but **omitted it from the final file set**, leaving
> section G (D2H extraction, ~196 LOC) unaccounted for. The deep pass
> re-scored section G (§5.3): it passes all three criteria and **is** a real
> module. Corrected count: **6 substantive modules**, **8 files total**.

---

## 1. Summary

`Pianoid.cu` is the single largest `.cu` translation unit in `pianoid_cuda`
(2988 lines, 124 KB — next largest is `MainKernel.cu` at 31 KB). It is a
**RED-flagged god object** in `CODE_QUALITY.md`'s baseline-debt list (rank 3).
It is the implementation file for the `Pianoid` facade class, which owns all
GPU state and is the sole public entry point for the Python middleware.

This proposal recommends:

1. Splitting the *implementation* across **8 files** (6 substantive `.cu`
   modules + 1 new internal header + the slimmed-down `Pianoid.cu`), keeping
   the **single `Pianoid` class and single `Pianoid.cuh` header unchanged**.
2. **Relocating** a cluster of ~10 thin audio-driver pass-through methods out
   of the `Pianoid` facade and **into the audio-driver subsystem** that
   already owns the underlying functionality.

The split is **by member-function group, not by class** — `Pianoid` stays one
class with one public API, so the pybind11 layer, all middleware call sites,
and the build's extension-module shape are untouched. (The relocation in
point 2 *does* touch the public API surface — see §5 — but in a contained,
phased, deferrable way.)

**Critical enabling fact (source-verified):** `Pianoid.cu` contains **zero
`__global__` and zero `__device__` code**. Every CUDA kernel (`addKernel`,
`parameterKernel`, `gaussKernel`, `convolutionKernel`, `stringMapKernel`,
`copyKernel`, `floatToAudioSampleKernel`, …) is defined in *other* `.cu` files
and only *launched* from `Pianoid.cu` via `<<<>>>` / `cudaLaunchCooperativeKernel`.
`Pianoid.cu` is pure host-side C++ that carries a `.cu` extension only so nvcc
compiles the launch syntax. This removes the hardest constraint a CUDA split
usually faces (device-code linkage across translation units) — the split is an
ordinary C++ member-function partition.

---

## 2. Documentation Basis

Per the CLAUDE.md Documentation-First rule, the ownership map below was derived
from `docs/index.md` → `architecture/*` → all 7 `docs/modules/pianoid-cuda/`
pages → the middleware OVERVIEW/REST_API calibration sections — **before**
reading source. Source was then read to *verify* every claim.

| Doc | What it establishes about ownership |
|---|---|
| `OVERVIEW.md` | `Pianoid` is the facade; it *owns* the memory manager, the audio driver, the profiler. The audio driver, memory manager, and playback engines are **separate components** the facade holds — not facade responsibilities. |
| `MEMORY_MANAGEMENT.md` | `Pianoid` *delegates* preset-library storage to `UnifiedGpuMemoryManager`; the facade owns the **library-management policy** (load/switch/unload/save). |
| `PARAMETER_SYSTEM.md` | The granular + bulk update APIs, volume calc, `ParameterInfo` use are a genuine facade responsibility — the facade translates middleware calls into double-buffer updates. |
| `SYNTHESIS_ENGINE.md` | `runSynthesisKernel()` and kernel-launch sequencing are facade-owned. The Audio-Output subsection documents `pushCycleAudioToDriver` as **the cycle's output step**. |
| `PLAYBACK_SYSTEM.md` | `runCycle()` is "the single cycle-orchestration entry point"; its Online branch *calls* `pushCycleAudioToDriver()` / `appendCycleAudioToHostBuffer()` as **concern-specific primitives — part of the cycle, not a separate audio module**. |
| `AUDIO_DRIVERS.md` | The audio-driver subsystem (`AudioDriverInterface`, SDL3/ASIO drivers, `AudioDriverFactory`, `LockFreeCircularBuffer`, `CaptureBuffer`) is a **self-contained subsystem**. It already owns: sample push, pause/resume, **mic capture** (`CaptureBuffer`), callback timing stats, input-device selection. |
| `DEBUG_DATA.md` | D2H result-extraction (`getPianoidState`, `getOutputData`, `getSoundRecords`, …) is a coherent facade responsibility (GPU state → Python `PianoidResult`), gated by `PIANOID_DEBUG_DATA`. |
| `pianoid-middleware/OVERVIEW.md` §CalibrationController | **Calibration logic lives in Python** (`calibration_controller.py`). The C++ side provides only the **semi-offline calibration *mode*** — "the engine loop is stopped but the audio driver stays alive." |
| `pianoid-middleware/REST_API.md` §Calibration Endpoints | Confirms: the C++ contribution is the semi-offline mode (engine-stop / driver-alive) plus mic capture and synthesis-reference capture. |
| `LOGGING.md` | `Pianoid.cu` carries ~130 `PLOG` statements, all init-phase — irrelevant to the split axis. |

**The decisive doc finding, source-confirmed in §5.1:** `AudioDriverInterface.h`
**already declares** the mic-capture, callback-stats, and pause/resume virtuals.
The audio-driver subsystem is the organic owner of every method the rejected
`Pianoid_audio.cu` would have wrapped — which is exactly why that module is
rejected and its content *relocated*.

---

## 3. Current State — Section Map of `Pianoid.cu`

Reading the file top to bottom (verified line-by-line against source), the
actual section boundaries, line ranges, and an **ownership verdict** for each:

| # | Section (banner / role) | Lines | ~LOC | Owned by `Pianoid` facade? |
|---|---|---|---|---|
| A | Includes, `PIANOID_ENABLE_PROFILING`, `g_profiling_cycle_counter`, `CUDA_LAUNCH*` macros | 1–137 | 137 | n/a — TU preamble |
| B | Constructor, destructor | 138–262 | 125 | **Yes** — object lifecycle |
| C | Typed buffer pointer/handler accessors (10 delegators) | 264–311 | 48 | **Yes** — facade-over-memory-manager accessors, trivial |
| D | `devMemoryInit` + `switch_filter` + `set_filter` + `initParameters` | 313–772 | 460 | **Yes** — GPU-memory lifecycle |
| E | Parameter management — bulk + granular + volume calc | 774–1385 | 612 | **Yes** — live parameter authority |
| F | `getStringIndicesForPitch` helper | 1387–1415 | 29 | **Yes** — pitch→string lookup |
| G | Result extraction (D2H copies) | 1420–1617 | 198 | **Yes** — state extraction |
| H | Lifecycle: `freeCudaMemory`, `shutdownGpu`, `startApplication`/`stopApplication`, `startAudioDriver`/`stopAudioDriver` + excitation internals `_add_string_for_playback`/`_append_string_gp`/`_exciteSingleMode` | 1619–1963 | 345 | **Yes** — GPU + app + audio-driver *lifecycle* (excitation internals belong with section I) |
| J | Cycle orchestration: `setCycleIterations`, `runCycle`, `getCurrentCycleAudio`, `processSustain`, `midiPlayerSwitch` | 1965–2092 | 128 | **Yes** — cycle orchestrator |
| K | `runSynthesisKernel()` + time-record helpers | 2094–2283 | 190 | **Yes** — kernel launch sequencing |
| **L** | Audio output: `pushCycleAudioToDriver` (incl. FIR), `appendCycleAudioToHostBuffer`, `setChannelForSDL`, `pauseAudioPlayback`/`resumeAudioPlayback` | 2286–2569 | 284 | **Mixed** — see §4.1 |
| **M** | Semi-offline calibration mode + mic capture/analysis + sinewave + `playRecordedAudio` | 2571–2736 | 166 | **Mixed** — see §4.2 |
| **N** | Callback stats + profiling control | 2738–2796 | 59 | **Mixed** — see §4.3 |
| O | Preset library management | 2798–2944 | 147 | **Yes** — library-management policy |
| P | New playback API (`runOfflinePlayback`, `exportAudioToWav`, `getRecordedAudio`) | 2946–2988 | 43 | **Yes** — offline orchestration, but tiny — see §5.4 |

Sections L, M, N — the original "audio" group — are where the substance
analysis bites. §4 dissects them function by function.

---

## 4. The Audio Group (L/M/N) — Function-Level Substance Analysis

Each function in sections L, M, N is classified as **(a)** genuine `Pianoid`
substance, **(b)** a thin wrapper over a subsystem, or **(c)** part of the
cohesive calibration-mode cluster. **Every classification below was verified
against the source line range cited.**

### 4.1 Section L — what is cycle-output, what is a wrapper

| Function | LOC | Class | Reasoning (source-verified) |
|---|---|---|---|
| `pushCycleAudioToDriver()` | ~217 (L2294–2511) | **(a) substance — belongs to *synthesis*** | Launches `convolutionKernel` (FIR), `floatToAudioSampleKernel`, does the 2-ch→8-ch channel-map expansion, manages `filterKernelArgs`, multiple `cudaMemset`/`cudaMemcpy` with full error handling. Heavy GPU orchestration. It is the **output stage of the synthesis cycle** — `runCycle`'s Online branch calls it right after `runSynthesisKernel` (verified `Pianoid.cu:2010`). It owns no audio-driver entity; it owns *the cycle's audio post-processing*. → `Pianoid_synthesis.cu`. |
| `appendCycleAudioToHostBuffer()` | ~40 (L2515–2554) | **(a) substance — belongs to *synthesis*** | D2H copy of `dev_soundFloat` into the `rawSoundBuffer` host ring, with circular-buffer wrap handling. Owns the ring's `rawSoundWritePos` bookkeeping. Cycle-output primitive (`runCycle` Online branch). → `Pianoid_synthesis.cu`. |
| `setChannelForSDL(int)` | 3 (L2288–2290) | trivial setter | One-line `channelForSDL = channel`. Read in the audio path. → `Pianoid_synthesis.cu`. |
| `pauseAudioPlayback()` | 5 (L2559–2563) | **(b) wrapper** | `if (audioDriver) audioDriver->pause();` — nothing else. → **relocate** (§5). |
| `resumeAudioPlayback()` | 5 (L2565–2569) | **(b) wrapper** | `if (audioDriver) audioDriver->resume();` — nothing else. → **relocate** (§5). |

**Verdict on L:** the two substantive functions are *synthesis-cycle output* —
not a freestanding "audio" concern. They move to `Pianoid_synthesis.cu`. The
two pause/resume functions are pure pass-throughs — they leave `Pianoid.*`.

### 4.2 Section M — calibration-mode cluster vs wrappers

| Function | LOC | Class | Reasoning (source-verified) |
|---|---|---|---|
| `stopEngineKeepAudio()` | ~8 (L2573–2580) | **(c) calibration-mode** | `endMainLoop()` (engine loop stop) but deliberately *not* `stopAudioDriver()`. The *defining operation* of semi-offline mode. |
| `executeSingleMeasurementCycle()` | ~24 (L2582–2605) | **(c) calibration — substance** | Runs `runCycle({Online, record_to_host=true})` synchronously; appends to `synthesisCaptureBuffer_` when capture is active. Real logic; owns the synthesis-capture append. |
| `restartOnlineEngine()` | ~9 (L2607–2614) | **(c) calibration-mode** | `beginMainLoop()` to exit semi-offline mode. Counterpart of `stopEngineKeepAudio`. |
| `startSynthesisCapture()` | ~6 (L2677–2681) | **(c) calibration — substance** | Owns `synthesisCaptureActive_` / clears `synthesisCaptureBuffer_`. |
| `stopSynthesisCapture()` | ~8 (L2683–2689) | **(c) calibration — substance** | `std::move`s out + clears the synthesis-capture buffer. |
| `getSynthesisCaptureBuffer()` | ~4 (L2691–2693) | **(c) calibration-mode** | Accessor for the capture buffer. |
| `analyzeCapturedAudio(...)` | ~18 (L2639–2656) | **(c) calibration — substance** | Resolves default skip/window timing via `MicAnalyzer::getTimingForFrequency`, *then* calls `MicAnalyzer::analyze`. Holds the **timing-default policy** — not a pure wrapper (verified L2648–2652). |
| `analyzeCapturedAudioWithReference(...)` | ~18 (L2658–2675) | **(c) calibration — substance** | Same timing-default policy, then `MicAnalyzer::analyzeWithReference` — the mic-vs-synthesis transfer-ratio analysis. |
| `startMicCapture(int)` | ~8 (L2618–2624) | **(b) wrapper** | `audioDriver->startCapture(maxDurationMs)` + null-check + throw. → **relocate** (§5). |
| `stopMicCapture()` | ~8 (L2626–2632) | **(b) wrapper** | `return audioDriver->stopCapture();` + null-check. → **relocate** (§5). |
| `isMicCapturing()` | ~5 (L2634–2637) | **(b) wrapper** | `return audioDriver->isCapturing();` + null-check. → **relocate** (§5). |
| `setMicDevice(const std::string&)` | ~7 (L2695–2701) | **(b) wrapper** | `audioDriver->setInputDevice(deviceName);` + null-check. → **relocate** (§5). |
| `listMicDevices()` | ~6 (L2703–2708) | **(b) wrapper** | `return audioDriver->listInputDevices();` + null-check. → **relocate** (§5). |
| `playRecordedAudio(...)` | ~22 (L2710–2731) | **(b) wrapper** | `dynamic_cast<ASIOAudioDriver*>` then `asioDriver->playRecordedAudio(...)`. Pure dispatch to a concrete driver. → **relocate** (§5). |
| `testSinewave(...)` | ~4 (L2733–2736) | **(b) wrapper** | `SinewaveGenerator generator; return generator.generate(config);` — touches **no `Pianoid` state at all**. → move next to `SinewaveGenerator` (§5). |

**Verdict on M:** two distinct things are tangled. The **calibration-mode
cluster** (the 8 `(c)` functions) is cohesive and substantive. The remaining 7
functions are **mic / playback / sinewave wrappers** over the audio-driver
subsystem.

### 4.3 Section N — callback-stats and profiling wrappers

| Function | LOC | Class | Reasoning (source-verified) |
|---|---|---|---|
| `getCallbackStats()` | ~7 (L2740–2745) | **(b) wrapper** | `return audioDriver->getCallbackStats();` + null-check. → **relocate** (§5). |
| `resetCallbackStats()` | ~5 (L2747–2751) | **(b) wrapper** | `audioDriver->resetCallbackStats();` + null-check. → **relocate** (§5). |
| `startProfiling` / `stopProfiling` / `resetProfiling` / `writeProfilingData` / `getGpuProfilingData` / `getCpuProfilingData` (+ the `#else` stub set) | ~45 (L2755–2796) | **(b) wrapper — over `profiler_`** | Each is a one-line forward to `profiler_` (a `PianoidProfiler` member). `resetProfiling` additionally zeroes `g_profiling_cycle_counter`. → **stay in `Pianoid.cu` — §4.4.** |

### 4.4 The profiling wrappers — why they stay (the asymmetry with audio wrappers)

The profiling wrappers fail criteria 1 and 3 exactly as the audio wrappers do
— they own no entity; `profiler_` does. So why not relocate them too?

**Because there is no separate *subsystem* to relocate into.** The audio
driver *is* a subsystem: a factory, an interface, two concrete drivers, its own
documentation page, and — decisively — a pybind-bindable boundary
(`AudioDriverInterface`). `PianoidProfiler` is a **leaf utility class**, not a
subsystem. Relocating the profiling wrappers would mean either:

- (a) exposing `PianoidProfiler` directly to pybind11 — a real API change for
  no architectural gain; or
- (b) inventing a `Pianoid_profiling.cu` that is *itself* a 45-LOC wrapper bag
  — the exact anti-pattern under review.

**The test is "does a better owner exist," not "is it thin."** For audio-driver
wrappers a better owner exists (the driver subsystem) → relocate. For profiling
none does → the wrappers stay in `Pianoid.cu` as the **irreducible cost of a
facade exposing one of its members to Python**. This is the honest answer: not
every thin method can or should be relocated. The asymmetry is principled, and
it is the *consistent* application of the user's criterion — the criterion
rejects standing up a *new module* with no owned entity; it does **not** demand
that every thin shim find a home elsewhere when no such home exists.

`g_profiling_cycle_counter` (file-static atomic, incremented by
`runSynthesisKernel` → `Pianoid_synthesis.cu`, zeroed by `resetProfiling` →
`Pianoid.cu`) — see §7.5.

---

## 5. Relocation — Audio-Driver Wrappers Move Into the Audio-Driver Subsystem

This section answers the user's directive: *thin wrappers around audio-driver
methods are not a module — push them to the subsystem that owns them.*

### 5.1 The decisive fact — verified against `AudioDriverInterface.h`

The following **10 thin pass-through methods** are removed from the `Pianoid`
class:

| Method (currently on `Pianoid`) | Forwards to | Owner status |
|---|---|---|
| `pauseAudioPlayback()` | `audioDriver->pause()` | **`AudioDriverInterface.h:45`** — pure virtual |
| `resumeAudioPlayback()` | `audioDriver->resume()` | **`AudioDriverInterface.h:48`** — pure virtual |
| `startMicCapture(int)` | `audioDriver->startCapture()` | **`AudioDriverInterface.h:92`** — virtual + default |
| `stopMicCapture()` | `audioDriver->stopCapture()` | **`AudioDriverInterface.h:98`** — virtual + default |
| `isMicCapturing()` | `audioDriver->isCapturing()` | **`AudioDriverInterface.h:103`** — virtual + default |
| `setMicDevice(string)` | `audioDriver->setInputDevice()` | **`AudioDriverInterface.h:106`** — virtual + default |
| `listMicDevices()` | `audioDriver->listInputDevices()` | **`AudioDriverInterface.h:109`** — virtual + default |
| `getCallbackStats()` | `audioDriver->getCallbackStats()` | **`AudioDriverInterface.h:83`** — virtual + default |
| `resetCallbackStats()` | `audioDriver->resetCallbackStats()` | **`AudioDriverInterface.h:86`** — virtual + default |
| `playRecordedAudio(...)` | `ASIOAudioDriver::playRecordedAudio()` | ASIO-specific — see §5.3 |

**Every one of the first 9 methods forwards to a virtual that already exists on
`AudioDriverInterface` — verified directly in the header.** The interface was
already designed to own pause/resume, mic capture, and callback stats. The
`Pianoid::` wrappers add **nothing but a null-check**. The audio-driver
subsystem is not *a candidate* owner — it is *the* owner, and has been all
along. **By criterion 1, an audio module here would have no functionality of
its own; by criterion 3, it would own nothing. It fails two of three tests
outright. This is the user's named anti-pattern, exactly.**

`testSinewave(...)` constructs a `SinewaveGenerator` and returns
`generate(config)` — it touches **no `Pianoid` state** (verified L2733–2736).
It moves **next to `SinewaveGenerator`** (a static factory function or a
`SinewaveGenerator::runTest(config)` static), exposed to pybind11 directly.

### 5.2 How the relocation works — the binding-layer change

This is the one part of the proposal that touches the **public API surface**
(unlike the §6 split, which is API-invariant). Two strategies:

**Strategy A — expose the audio driver as a sub-object (recommended).**
Add one accessor to `Pianoid`: `AudioDriverInterface* audioDriver()`. Bind
`AudioDriverInterface` to pybind11 once, with its pause / resume / mic / stats
virtuals. Python then calls `pianoid.audio_driver().start_capture(...)`.
- *Pro:* the audio-driver subsystem owns its API **end-to-end, including the
  Python surface**; the `Pianoid` class shrinks by 10 methods; no wrapper bag
  anywhere. This *transfers authority*, not just code.
- *Con:* every middleware call site for these 10 methods is updated (a
  mechanical rename — `pianoid.X()` → `pianoid.audio_driver().X()`). The
  null-check the wrappers did moves into the accessor (`audioDriver()` throws
  if the driver is absent) so the safety is preserved in **exactly one place**.

**Strategy B — keep the bindings, move only the bodies.** Leave the 10 method
declarations on `Pianoid`, move their one-line bodies into an
audio-driver-adjacent file. **Rejected** — it keeps the wrapper bag, just
relocates the `.cu` text. Relabeling a bag does not give it substance.

**Recommendation: Strategy A.** It is the only option that transfers
*authority* to the audio-driver subsystem. It is a contained middleware change
(call-site renames + one new pybind class + one accessor), and it is its own
phase (§9, Phase R), independently verifiable and **deferrable** — the §6 split
stands on its own without it.

### 5.3 `playRecordedAudio` — ASIO-specific, belongs on the ASIO driver

`playRecordedAudio` is already half-relocated: its body is a
`dynamic_cast<ASIOAudioDriver*>` followed by `asioDriver->playRecordedAudio(...)`
(verified L2710–2731). `ASIOAudioDriver` *already has* a `playRecordedAudio`
method (`AUDIO_DRIVERS.md` / `ASIOAudioDriver.h:170`). Under Strategy A the
`Pianoid::` method disappears — Python reaches it via the `audio_driver()`
accessor, and the `dynamic_cast` becomes the subsystem's internal concern (or
`playRecordedAudio` is promoted to a default-throwing `AudioDriverInterface`
virtual so no cast is needed).

### 5.4 What does NOT relocate to the audio-driver subsystem

- **`pushCycleAudioToDriver` / `appendCycleAudioToHostBuffer` do NOT relocate.**
  They are not driver operations — they are the *synthesis cycle's* output
  stage (FIR kernel, channel map, D2H ring). They stay in `Pianoid` and move to
  `Pianoid_synthesis.cu` (§6). Pushing them into the driver would be the
  *opposite* P2 error — burying cycle/kernel logic inside a driver.
- **The calibration-mode cluster does NOT relocate** — §6.4.
- **Profiling wrappers do NOT relocate** — §4.4.

---

## 6. Per-Module Verdicts — The Three Criteria, Module by Module

This is the heart of the deep pass. Each candidate is scored against all three
criteria with explicit reasoning. **A module ships only if it passes all three.**

### 6.1 `Pianoid_presets.cu` — section O (~147 LOC) — PASS / PASS / PASS

The user's stated **"good example."** It clears the bar comfortably.

- **C1 — Clear functionality? YES.** Preset-library management:
  `loadPresetToLibrary`, `switchPreset`, `saveActiveToLibrary`,
  `unloadPresetFromLibrary`, `getLibraryPresets`, `getActivePreset`, plus the
  update-policy controls. A single, nameable job.
- **C2 — Cohesive? YES.** Every method is about the named-preset library; one
  reason to change (preset-library semantics). `loadPresetToLibrary` carries
  real packing/section-padding logic (verified L2800–2879), not delegation.
- **C3 — Single authority? YES.** It owns the **library-management policy** —
  which presets exist, which is active, the load/switch sequencing. P1 is about
  *write-authority*, not storage: the bytes live in `UnifiedGpuMemoryManager`,
  but the *policy* of the library is written only here. `switchPreset`
  additionally owns the derived-pointer refresh and the `run_string_map_kernel_`
  arming. (One trigger-flag touch — `switchPreset` raises `new_notes_ind` — is
  the documented mailbox pattern; see §6.5.)

### 6.2 `Pianoid_parameters.cu` — sections E + F (~640 LOC) — PASS / PASS / PASS

- **C1 — Clear functionality? YES.** The **live parameter-update authority**:
  translate middleware calls into double-buffer updates. Bulk
  (`setNewPhysicalParameters`, `setNewModeParameters`,
  `setNewDeckParameters`, …), granular (`updateSingleStringParameter_NEW`,
  `updateMultiStringParameter_NEW`, `updateModeParameters_GRANULAR`), volume
  calc (`calculateVolumeBase/Coefficient`), `setRuntimeParameters`. Section F's
  `getStringIndicesForPitch` is a parameter-adjacent read helper that fits.
- **C2 — Cohesive? YES.** One reason to change: the parameter-update protocol
  and the `ParameterInfo` contract. (~640 LOC is the largest extracted module
  — but `CODE_QUALITY.md` C4 explicitly notes a large file is acceptable when
  it is one cohesive concern; this is. It sits under the 1000-LOC RED line.)
- **C3 — Single authority? YES.** Owns the parameter-update path; sole writer
  of the tunable parameter buffers via `memory_manager_.updateTunableParameter`;
  owns `runtime_params_` application. **Nuance — handled, not hidden:**
  `setUpdatedParameters` (L777) has an init-path branch that launches
  `parameterKernel` *directly* (pre-first-preset). That is still parameter
  authority (it is the *initial* parameter load). The `parameterKernel` *launch*
  it shares with `runSynthesisKernel` is a kernel **launch** (a verb) — not
  shared *state* ownership. P1 governs state; two files may legitimately launch
  the same kernel. No authority conflict.

### 6.3 `Pianoid_excitation.cu` — section I (~205 LOC) — PASS / PASS / PASS*

- **C1 — Clear functionality? YES.** **Excitation staging**: host batch buffers
  → GPU. The `beginStringBatch` / `addStringToBatch` / `commitStringBatch`
  envelope, `addOneString`, `_append_string_gp`, `_load_exct_params_to_GPU`,
  `_add_string_for_playback`, and mode excitation (`addModeExcitation`,
  `exciteMode`, `_exciteSingleMode`).
- **C2 — Cohesive? YES.** One reason to change: the batch-excitation protocol
  (the single-envelope-per-cycle invariant documented in `SYNTHESIS_ENGINE.md`).
- **C3 — Single authority? YES, with one documented trigger-flag touch.** Sole
  owner of the host-side staging state: `noStrings_in_GP`,
  `string_excitation_params`, `string_gauss_param_indices`,
  `pending_mode_excitation_*`. **The one shared-touch item:** `commitStringBatch`
  and `addOneString` raise `new_notes_ind`. So do `switchPreset` (presets) and
  `processSustain` (synthesis/cycle). `new_notes_ind` has three producers and is
  drained by `runSynthesisKernel`. **This is the kernel-trigger mailbox — §6.5.
  It is not owned domain state and does not break the extraction.** It is
  flagged here, not buried, per the criterion's intent.

### 6.4 `Pianoid_calibration.cu` — section M calibration cluster (8 fns, ~95 LOC) — PASS / PASS / PASS*

**The user explicitly asked whether calibration deserves its own module.** Here
is the full reasoning, both directions, and the verdict.

**What "calibration" means in `Pianoid.cu` (doc-first finding).** The
calibration *algorithm* is **not in C++ at all** —
`pianoid-middleware/OVERVIEW.md` §CalibrationController is unambiguous: the
4-phase pipeline, direct-linear-correction, bisection fallback, perception
curves are all Python (`calibration_controller.py`). What `Pianoid.cu`
contributes is the **semi-offline calibration *mode*** and the measurement
primitives the Python controller drives. That is the 8 `(c)` functions of §4.2,
~95 LOC, plus 2 member variables.

- **C1 — Clear functionality? YES.** The **semi-offline calibration mode** — a
  *named, documented* operating mode. `REST_API.md` §"Calibration Endpoints":
  "the engine loop is stopped but the audio driver stays alive, allowing
  deterministic cycle-by-cycle synthesis." It has explicit **enter**
  (`stopEngineKeepAudio`) and **exit** (`restartOnlineEngine`) transitions, a
  step operation (`executeSingleMeasurementCycle`), reference-capture
  (`start/stop/getSynthesisCapture`), and measurement analysis
  (`analyzeCapturedAudio*`). An identifiable, nameable job.
- **C2 — Cohesive? YES.** All 8 functions serve **one workflow** — Python-driven
  cycle-by-cycle measurement. One reason to change: the measurement protocol.
  `analyzeCapturedAudio*` are *not* wrappers — they carry the skip/window
  timing-default *policy* (verified L2648–2652, L2667–2671).
- **C3 — Single authority? YES, with one documented loop-flag touch.** Sole
  owner of "**stop the engine loop, keep the audio driver alive**" — a
  deliberate, non-obvious decoupling that nothing else in the codebase may do
  ad hoc. Sole owner of `synthesisCaptureBuffer_` / `synthesisCaptureActive_`
  (verified private members, `Pianoid.cuh:204–205`). **The one shared-touch
  item:** `stopEngineKeepAudio` / `restartOnlineEngine` flip
  `shouldContinueLoop_` via `endMainLoop()` / `beginMainLoop()`;
  `startApplication` / `stopApplication` (→ `Pianoid.cu`) also flip it. **This
  is the loop-control flag — §6.5. Calibration does not *own*
  `shouldContinueLoop_`; it *calls* the owner's `begin/endMainLoop()` interface**
  — which is exactly what P1 prescribes ("everyone else reads it through the
  owner's interface"). No authority conflict.

**The size objection, answered.** Draft 1 used a sub-100-LOC folding heuristic
and would have dissolved this 95-LOC cluster. **The user's three criteria
contain no size term.** They measure *ownership*. A small module that cleanly
owns a named entity passes; a large bag that owns nothing fails. This is the
*consistent* call: the **same criterion** that rejects an audio module (owns
nothing — §5.1) **accepts** `Pianoid_calibration.cu` (owns the mode + the
capture state). Size is not the axis. Splitting these 8 cohesive functions
across `Pianoid.cu` and `Pianoid_synthesis.cu` to satisfy a LOC heuristic would
**destroy a real unit** — the opposite of the criterion.

**Verdict: EXTRACT.** `Pianoid_calibration.cu`, ~110 LOC including banner/includes.

### 6.5 The two shared-touch flags — explicitly surfaced (Revision 2 buried these)

The deep pass found **exactly two** pieces of state touched by more than one
prospective module. Neither breaks the split; both must be *documented*, not
left implicit.

| Flag | Writers (across modules) | Reader / drainer | Why it is not a P1 violation |
|---|---|---|---|
| `new_notes_ind` | `switchPreset` (`_presets`), `commitStringBatch`/`addOneString` (`_excitation`), `processSustain` (`_synthesis`) | `runSynthesisKernel` (`_synthesis`) — drains to 0 after consuming | It is a **kernel-trigger mailbox**, not owned domain state. Multiple producers raising a flag that a single documented consumer drains is an accepted pattern (cf. `RealTimeEventBuffer`'s multi-producer model in `PLAYBACK_SYSTEM.md`). Its "authority" is "the kernel-launch trigger, raised by excitation/preset/sustain events, drained by `runSynthesisKernel`." That contract belongs in `SYNTHESIS_ENGINE.md`'s "Kernel Trigger: `new_notes_ind`" section, which already documents the value semantics. |
| `shouldContinueLoop_` | `startApplication`/`stopApplication` (`Pianoid.cu` lifecycle), `stopEngineKeepAudio`/`restartOnlineEngine` (`_calibration`) | the engine loop in `OnlinePlaybackEngine` | It is a **loop-control flag**. Its *owner interface* is `begin/endMainLoop()` — inline setters declared in `Pianoid.cuh` (verified L287–289). Both lifecycle and calibration are valid *callers of that setter*, not independent writers of the raw flag. The actual engine loop that *reads* it lives in `OnlinePlaybackEngine`, not in `Pianoid` at all. Under P1 — "everything else reads/writes through the owner's interface" — this is clean. |

**Recommendation:** the migration's documentation phase (§9 Phase 8) adds one
sentence to `SYNTHESIS_ENGINE.md` (the `new_notes_ind` mailbox: producers vs
drainer) and one to `PLAYBACK_SYSTEM.md` (the `begin/endMainLoop` setter is the
single write-interface for `shouldContinueLoop_`). With those two sentences,
both flags have an explicit, single, documented authority surface — and the
split is fully P1-clean.

---

## 7. Proposed File Set

### 7.1 Design rules

1. **One class, one header.** `Pianoid.cuh` stays the single declaration of the
   `Pianoid` class. C++ permits a class's member functions to be defined across
   any number of translation units. No nested classes, no PIMPL.
2. **Split by *owned entity*, not by file size.** Each new `.cu` file contains
   the `Pianoid::` methods for one owned responsibility that **passes all three
   criteria**.
3. **Shared preamble → private header** (`Pianoid_internal.cuh`).
4. **The §6 split is a pure move-refactor** — function bodies relocated
   verbatim, only `#include` lines change. **The §5 relocation is NOT** — it
   changes the public API and middleware call sites; it is phased separately
   and is deferrable.
5. **`Pianoid.cu` survives as the lifecycle/core file.**

### 7.2 The 8 files (after the §6 split)

| File | Owned entity / authority | Contains (sections) | ~LOC |
|---|---|---|---|
| **`Pianoid.cu`** (slimmed) | The `Pianoid` object's own lifecycle + GPU-memory lifecycle. Constructor/destructor, buffer-accessor delegators, `devMemoryInit`, filter config, `initParameters`, GPU/app/audio-driver lifecycle, **offline-playback facade shims** (folded-in section P — §5.4), **profiling control shims** (§4.4). | B, C, D, H(lifecycle), N(profiling), P | ~830 |
| **`Pianoid_internal.cuh`** (new header) | — (shared TU preamble — an enabler, not a "module": `CUDA_LAUNCH*` macros, `PIANOID_ENABLE_PROFILING`, `extern` decl of `g_profiling_cycle_counter`, common includes) | A | ~110 |
| **`Pianoid_parameters.cu`** (new) | The live parameter-update authority — bulk + granular + volume calc + `getStringIndicesForPitch`. | E, F | ~640 |
| **`Pianoid_presets.cu`** (new) | The **preset-library** entity — load / switch / save / unload / list + update-policy. The model module (user's "good example"). | O | ~150 |
| **`Pianoid_excitation.cu`** (new) | Excitation **staging** — host batch buffers → GPU; begin/add/commit envelope; mode excitation. | I (incl. the `_*` excitation internals currently sited mid-section-H) | ~205 |
| **`Pianoid_synthesis.cu`** (new) | The **synthesis cycle** — kernel-launch sequencing AND the cycle's audio-output stage. `runCycle`, `runSynthesisKernel`, `setCycleIterations`, time-record helpers, `pushCycleAudioToDriver` (FIR + channel map), `appendCycleAudioToHostBuffer`, `getCurrentCycleAudio`, `setChannelForSDL`, `processSustain`, `midiPlayerSwitch`. Defines `g_profiling_cycle_counter`. | J, K, L(output funcs) | ~600 |
| **`Pianoid_calibration.cu`** (new) | The **semi-offline calibration mode** — engine-loop/audio-driver decoupling + synthesis-reference capture. The 8 `(c)` functions of §4.2. | M(calibration cluster only) | ~110 |
| **`Pianoid_debug.cu`** (new) | **GPU state extraction (D2H)** — `getPianoidState`, `getModeDisplacements`, `getOutputData`, `getParameters`, `getRawSoundRecord`, `getSoundRecords`, `fetchExcitation`, `clearRecords`. Owns the `PIANOID_DEBUG_DATA` compile-guard discipline for extraction. | G | ~200 |

**Plus the §5 relocation** (separate from the file count above): ~10 wrapper
methods leave `Pianoid.*` for the audio-driver subsystem; `testSinewave` moves
next to `SinewaveGenerator`.

**Result:** `Pianoid.cu` drops from 2988 → ~830 LOC — **below the 1000-LOC RED
line**. No file exceeds ~830 LOC. Every new module names an entity that passes
all three criteria. There is **no `Pianoid_audio.cu`** and **no
`Pianoid_playback.cu`** — both failed the criteria.

### 7.3 What changed vs Revision 2's file set

| Revision 2 | Revision 3 (this doc) | Why |
|---|---|---|
| Said "6 files"; §7.2 listed 5 new `.cu` | **8 files** — 6 substantive modules + core + header | Revision 2 kept `Pianoid_debug.cu` in its verdict table but dropped it from the file set; section G (D2H, ~200 LOC) was unaccounted for. §5.3 of this doc re-scores section G → it passes all three criteria → restored as a real module. Count corrected. |
| Two shared-touch flags not mentioned | §6.5 surfaces `new_notes_ind` and `shouldContinueLoop_` explicitly with their authority contracts | The criterion *is* "single authority"; flags touched by multiple modules must be named and shown to be clean (documented mailbox / documented setter interface), not left implicit. |
| `Pianoid_debug.cu` verdict was inconsistent | `Pianoid_debug.cu` scored explicitly: PASS/PASS/PASS (§5.3) | A verdict must be reproducible from the three tests. |

### 7.4 Why the rejected modules are rejected (the criteria, made explicit)

| Rejected candidate | Fails which criterion | Disposition |
|---|---|---|
| `Pianoid_audio.cu` (L/M/N wrappers) | **C1** (thin pass-throughs — no functionality of its own) **and C3** (the driver owns every method — proven in §5.1) | Wrappers **relocate** to the audio-driver subsystem (§5). The user's named anti-pattern. |
| `Pianoid_playback.cu` (section P) | **C1** (facade-exposure shims — `runOfflinePlayback` is 22 LOC of constructing+calling `OfflinePlaybackEngine`) **and C3** (`OfflinePlaybackEngine` owns offline playback; `WavWriter` owns WAV) | The 3 shims **fold into `Pianoid.cu`** as irreducible facade-exposure (§5.4). A deeper "expose playback engines to pybind" cleanup is possible but is its own future proposal. |
| `Pianoid_profiling.cu` (section N profiling) | **C1 + C3** (thin forwards over `profiler_`) | Shims **stay in `Pianoid.cu`** — no separate subsystem to relocate into (§4.4). |

### 7.5 Items needing care

| Item | Note |
|---|---|
| `Pianoid::instance` static | `Pianoid* Pianoid::instance = nullptr;` (`Pianoid.cu:138`) — keep in `Pianoid.cu` (one TU). |
| `Pianoid::testModeEnabled` static | `bool Pianoid::testModeEnabled = false;` currently at `Pianoid.cu:2557` (mid-section L). Move to `Pianoid.cu` next to `instance` so all static-member definitions co-locate. |
| `g_profiling_cycle_counter` | File-`static` `std::atomic<int>` at `Pianoid.cu:42` — incremented by `runSynthesisKernel` (→ `Pianoid_synthesis.cu`), reset by `resetProfiling` (→ `Pianoid.cu`). Promote to a single owner: declare `extern` in `Pianoid_internal.cuh`, **define in `Pianoid_synthesis.cu`**, reference from `Pianoid.cu`. The one genuine new cross-file linkage; trivial. |
| `PIANOID_ENABLE_PROFILING` `#define` | Currently the first line of `Pianoid.cu` (line 2), before any include. Move into `Pianoid_internal.cuh` (before its includes) so every TU sees it consistently. |
| `loadParameterToPianoid<T>` template | Defined in `Pianoid.cuh:722` — already correct, no move. |
| `kernelArgs` / `filterKernelArgs` | Class-member `std::vector<void*>` — *populated* in `initParameters()` (`Pianoid.cu`), *consumed* in `runSynthesisKernel` / `pushCycleAudioToDriver` (`Pianoid_synthesis.cu`). Normal cross-file member access via the single `Pianoid.cuh`. |
| `new_notes_ind`, `shouldContinueLoop_` | The two shared-touch flags — §6.5. Not a code change; a **doc** change in Phase 8 (one sentence each to `SYNTHESIS_ENGINE.md` / `PLAYBACK_SYSTEM.md`). |
| §5 relocation — pybind | Strategy A adds an `AudioDriverInterface` pybind class + a `Pianoid::audioDriver()` accessor and updates ~10 middleware call sites. **API change** — phase it separately (Phase R), verify with a live `/diagnose`. Deferrable. |
| `setup.py` | **No edit required for the §6 split.** `_discover_sources()` (`setup.py`) globs `*.cu` from `pianoid_cuda/` — new `.cu` files are picked up automatically. Confirmed against `BUILD_SYSTEM.md` §"Source Discovery" (`setup.py` "globs all `*.cu` and `*.cpp` files"). |

### 7.6 Include / dependency structure

```
                       Pianoid.cuh   (unchanged — single class declaration)
                            ^
                            |  #include
        +-------------------+----------------------------------+
        |                   |                                  |
 Pianoid_internal.cuh        |                                  |
 (CUDA_LAUNCH macros,        |                                  |
  PIANOID_ENABLE_PROFILING,  |                                  |
  extern g_profiling_*,      |                                  |
  common includes)           |                                  |
        ^                    |                                  |
        | #include            |                                  |
        |                    |                                  |
  +-----+------+-----------+--+--------+-----------+-------------+-----------+
  |            |           |           |           |             |           |
Pianoid.cu  _parameters  _presets  _excitation  _synthesis  _calibration  _debug
  .cu          .cu         .cu        .cu          .cu          .cu          .cu
```

- Every split `.cu` includes `Pianoid.cuh` (class declaration) and
  `Pianoid_internal.cuh` (launch macros + common headers).
- `Pianoid_internal.cuh` includes `Pianoid.cuh`, `<cuda_runtime.h>`,
  `<cooperative_groups.h>`, `PianoidLogger.h`, `constants.h`, `Kernels.cuh`,
  `gaussTest.cuh`, `MainKernel.cuh`, `FIRFilter.cuh`, `Profiler.h`, plus the
  Windows `<windows.h>` guard block.
- Files needing extra headers include them directly: `Pianoid.cu` →
  `OfflinePlaybackEngine.h` / `WavWriter.h` / `SinewaveGenerator.h`;
  `Pianoid_calibration.cu` → `MicAnalyzer.h`.
- **No new cross-`.cu` symbol dependencies** beyond the single file-static
  atomic (§7.5). All member-to-member calls resolve via the one `Pianoid.cuh`.

---

## 8. CUDA / Build-System Risk Assessment

| Risk | Severity | Assessment |
|---|---|---|
| Device-code linkage across TUs | **None** | `Pianoid.cu` has zero `__global__`/`__device__` code (verified). All kernels defined elsewhere; this file only launches them. No `-rdc` implications. |
| `setup.py` source discovery | **None** | Auto-glob of `*.cu`; new files compile automatically (`BUILD_SYSTEM.md` §Source Discovery). |
| Per-file compile cost | **Low / positive** | nvcc compiles each `.cu` independently. Eight smaller files parallelise better and make incremental builds far more effective. |
| Cooperative-kernel launches | **None** | `cudaLaunchCooperativeKernel((void*)addKernel, …)` is a host API call; the function-pointer cast resolves against the kernel symbol in its defining header. Works from any TU including that header. |
| Macro redefinition | **Low** | `CUDA_LAUNCH*` centralised in `Pianoid_internal.cuh` with `#ifndef` guards. |
| pybind11 binding layer — **§6 split** | **None** | Method definitions moving between `.cu` files does not change mangled symbols. |
| pybind11 binding layer — **§5 relocation** | **Medium — by design** | Strategy A *intentionally* changes the Python API for ~10 audio-driver methods. Contained: new `AudioDriverInterface` pybind class + accessor + call-site renames. Isolated to Phase R; verified with live `/diagnose`; deferrable. |
| Build-green at each step | **Mitigated by phasing** | See §9 — each phase is independently compilable + testable. |
| Linux `.sh` build sibling | **None** | `build_pianoid_cuda.sh` uses the same `setup.py` auto-glob. |

**Overall CUDA risk: very low** for the §6 split (host-only file, auto-glob).
The §5 relocation carries a **contained, deliberate API-surface change** —
medium risk, fully phased, and **deferrable to a follow-up `/dev` task**.

---

## 9. Phased Migration Plan

Each phase keeps the build green and is verified with a `--heavy --release`
build (per CLAUDE.md). **Phases 0–8 are pure move-refactors, leaf-first.**
Phase R (the API-changing relocation) is sequenced last and is deferrable. The
split is a future `/dev` `--heavy` task.

| Phase | Action | Build-green check | Why this order |
|---|---|---|---|
| **0** | Create `Pianoid_internal.cuh`: move `PIANOID_ENABLE_PROFILING`, the `CUDA_LAUNCH*` macros, the common include block; add `extern` decl of `g_profiling_cycle_counter`. `Pianoid.cu` `#include`s it. No methods move. | `--heavy --release` build; `/test-ui` audio_off (synthesis output bit-identical). | Establishes the shared preamble all later phases depend on. |
| **1** | Extract `Pianoid_presets.cu` (section O). | Build; preset-switch system test. | Self-contained delegation to `memory_manager_`; the strongest-cohesion module — proves the mechanics on a clean case. |
| **2** | Extract `Pianoid_debug.cu` (section G — D2H extraction). | Build; debug-variant build (`--both`); chart-function smoke test. | Read-only D2H, no synthesis coupling; exercises the `PIANOID_DEBUG_DATA` guards early. |
| **3** | Extract `Pianoid_calibration.cu` (section M calibration cluster — the 8 `(c)` functions). | Build; `/diagnose` semi-offline measurement path (mic Phase 7 if available). | Cohesive cluster, no synthesis-path edits; isolates the calibration mode before synthesis moves. |
| **4** | Extract `Pianoid_excitation.cu` (section I, including the `_*` excitation internals currently mid-section-H). | Build; single-note + chord `/test-ui`. | Excitation staging; consumed by synthesis (phase 6). |
| **5** | Extract `Pianoid_parameters.cu` (sections E, F). | Build; parameter-edit `/test-ui` (tension/stiffness audible change). | Largest group (~640 LOC); isolated after smaller phases shrink `Pianoid.cu`. |
| **6** | Extract `Pianoid_synthesis.cu` (sections J, K + L's `pushCycleAudioToDriver` / `appendCycleAudioToHostBuffer` / `setChannelForSDL`). **Define `g_profiling_cycle_counter` here.** | Build; full playback `/test-ui`; live audio `/diagnose`; profiling-data smoke test. | The hottest path + the audio-output stage — moved as one unit, verified hard. |
| **7** | Confirm only B, C, D, H(lifecycle), N(profiling), P remain in `Pianoid.cu`; fold dissolved section P shims if not already co-sited. | Build; offline-render `/test-ui`. | Cleanup — `Pianoid.cu` reaches its final ~830-LOC shape. |
| **R** | **Relocation phase (API change).** Strategy A: add `AudioDriverInterface` pybind class + `Pianoid::audioDriver()` accessor; delete the 10 wrapper methods from `Pianoid`; move `testSinewave` next to `SinewaveGenerator`; rename the ~10 middleware call sites. | Build; full regression `/test-ui` + live `/diagnose` (audio + mic) — mic-capture and callback-stats paths must work through the new accessor. | Sequenced LAST: the only API-changing phase; doing it after the file split means the split is verified and stable when the API moves. **Deferrable to a separate `/dev` task entirely** — the §6 split stands on its own. |
| **8** | Final pass: per-file `using`-namespace cleanup, minimal include lists, **doc updates** (including the two §6.5 flag-authority sentences). | Build; full regression `/test-ui` + `/diagnose`. | Cosmetic + doc sync. |

**Rollback:** every phase is an isolated commit on a feature branch. Phases
0–8 are pure move-refactors — revert one commit, earlier phases remain valid.
**Phase R is the one phase that is not a pure move** — it gets its own commit
(or its own PR) so it can be reverted or deferred independently.

### Documentation updates (Phase 8)

- `docs/modules/pianoid-cuda/OVERVIEW.md` — update the "Pianoid (facade)" box
  and file references to list the new `.cu` files; note that the audio-driver
  subsystem owns the mic/stats/pause API directly post-Phase-R.
- `docs/modules/pianoid-cuda/AUDIO_DRIVERS.md` — document that the mic-capture /
  callback-stats / pause-resume / `playRecordedAudio` API is reached directly
  via the driver post-Phase-R, not via `Pianoid` wrappers.
- `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` — add one sentence to the
  "Kernel Trigger: `new_notes_ind`" section: the flag is a kernel-launch
  *mailbox* — raised by excitation / preset-switch / sustain, drained by
  `runSynthesisKernel` (the §6.5 contract).
- `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md` — add one sentence: `begin/endMainLoop()`
  is the single write-interface for `shouldContinueLoop_`; both lifecycle and
  semi-offline calibration are callers of it (the §6.5 contract).
- Module docs that cite `Pianoid.cu:<line>` for a method
  (`SYNTHESIS_ENGINE.md`, `PLAYBACK_SYSTEM.md`, `PARAMETER_SYSTEM.md`,
  `MEMORY_MANAGEMENT.md`, `DEBUG_DATA.md`, `LOGGING.md`) — repoint file
  references to the new home file.
- `CODE_QUALITY.md` — update the baseline-debt RED table: `Pianoid.cu` drops
  off the RED list (→ ~830 LOC); the six new modules are sub-RED.
- **No new doc *page* is needed** — `Pianoid_calibration.cu` maps to the
  already-documented "semi-offline calibration mode"; `Pianoid_debug.cu` maps
  to the existing `DEBUG_DATA.md`.

---

## 10. Why This Shape (Alternatives Considered)

| Alternative | Verdict |
|---|---|
| **The original 8-file split with `Pianoid_audio.cu`** | Rejected — Revision 2 / §0. `Pianoid_audio.cu` was a wrapper bag bundling three unrelated things; fails C1 + C3. |
| **Keep `Pianoid_audio.cu` but rename it / add a doc comment** (Strategy B) | Rejected — §5.2. Relabeling a wrapper bag does not give it substance. |
| **Make a `Pianoid_profiling.cu`** | Rejected — §4.4. A 45-LOC wrapper bag over `profiler_`; no subsystem to own it. The shims stay in `Pianoid.cu` as the legitimate facade-exposure cost. |
| **Stand up `Pianoid_playback.cu` (section P)** | Rejected — §7.4. 3 facade-exposure shims; `OfflinePlaybackEngine`/`WavWriter` own the work. Fails C1 + C3. Fold into `Pianoid.cu`. |
| **Fold calibration into `Pianoid.cu` / `Pianoid_synthesis.cu` (the LOC heuristic)** | Rejected — §6.4. The semi-offline calibration mode is a clearly owned entity; the user's criteria have no size term. Splitting it destroys cohesion. |
| **Drop `Pianoid_debug.cu` (Revision 2's accidental omission)** | Rejected — §5.3. Section G passes all three criteria — D2H extraction is a real, cohesive, sole-owner module. Restored. |
| **Relocate `pushCycleAudioToDriver` into the audio-driver subsystem** | Rejected — §5.4. It is synthesis-cycle output (FIR kernel, channel map), not a driver operation. Burying it in a driver is the opposite ownership error. |
| **PIMPL / `PianoidImpl`** | Rejected. Adds an indirection layer for zero benefit — the problem is file size + ownership clarity, not header compile coupling. |
| **Extract sub-objects** (a `PianoidAudio` class owning the audio path) | Rejected for *this* proposal. Strategy A (§5.2) *does* lean on the **already-existing** `AudioDriverInterface` sub-object — that is exposing an existing component, not extracting a new class. A genuine new-sub-object refactor (e.g. a `PianoidSynthesis` class) is a deeper change with real `this`-threading / state-ownership risk; it could be a separate later proposal. |
| **Keep `Pianoid.cu` as-is** | Rejected. 2988 LOC in one file is a RED-flagged god object (`CODE_QUALITY.md` rank 3) — a navigation + merge-conflict hazard, the file most likely to collide when multiple `/dev` agents touch the engine. |

---

## 11. Deliverable Summary (for team-lead)

- **Revised per the user's three explicit criteria** (clear functionality /
  cohesion / single authority). Each candidate module is scored against all
  three in §6; a module ships only if it passes all three. The criteria are
  `CODE_QUALITY.md` P1 + P2 applied to this split.
- **File set: 8 files** — the slimmed `Pianoid.cu` (~830 LOC, off the RED list)
  + `Pianoid_internal.cuh` + **6 substantive modules**: `_parameters`,
  `_presets`, `_excitation`, `_synthesis`, `_calibration`, `_debug`.
- **Correction vs Revision 2:** Revision 2 said "6 files" but had dropped
  `Pianoid_debug.cu` from its file set while keeping it in its verdict table —
  section G (D2H extraction, ~200 LOC) was unaccounted for. The deep pass
  re-scores section G: it passes all three criteria → restored. Correct count
  is **8 files / 6 substantive modules**.
- **`Pianoid_audio.cu` rejected** — fails C1 (thin pass-throughs) and C3 (the
  audio driver owns every method — proven against `AudioDriverInterface.h`).
  Its ~10 wrappers **relocate into the audio-driver subsystem** (Strategy A);
  `testSinewave` moves next to `SinewaveGenerator`. This is the user's named
  anti-pattern, handled exactly as the user prescribed.
- **`Pianoid_playback.cu` rejected** — fails C1 + C3 (3 facade-exposure shims;
  `OfflinePlaybackEngine`/`WavWriter` own the work). Folds into `Pianoid.cu`.
- **`Pianoid_profiling.cu` rejected** — thin forwards over `profiler_`; no
  subsystem to relocate into, so the shims stay in `Pianoid.cu` (§4.4). The
  test is "does a better owner exist," not "is it thin."
- **Calibration: YES, its own module** (`Pianoid_calibration.cu`, ~110 LOC) —
  it owns the *semi-offline calibration mode* (a named, documented operating
  mode with explicit enter/exit transitions) and the synthesis-reference-capture
  state. The C++ side is deliberately thin because the calibration *algorithm*
  is Python; thinness reflects a clean boundary, not incohesion. Size is not a
  criterion; ownership is.
- **Two shared-touch flags surfaced** (§6.5) — `new_notes_ind` (kernel-trigger
  mailbox) and `shouldContinueLoop_` (loop-control flag set via the
  `begin/endMainLoop` interface). Neither breaks P1; both get a one-sentence
  doc contract in Phase 8. Revision 2 left these implicit; this revision names
  them.
- **Migration: 9 phases (0–8 + R).** Phases 0–8 are pure move-refactors,
  leaf-first, each one commit and independently build-green. **Phase R** is the
  single API-changing phase (the audio-driver relocation) — sequenced last, its
  own commit/PR, **deferrable**.
- **CUDA risk:** very low for the split (`Pianoid.cu` is host-only; `setup.py`
  auto-globs `*.cu`). The relocation carries a contained, deliberate
  API-surface change, fully phased.
- **Execution:** planning only. The split + relocation is a future `--heavy`
  CUDA `/dev` task following the §9 phase plan.

### Investigation history

- Draft 1 + Revision 2 reasoning: `D:\tmp\pianoid-cu-split-revision-2026-05-19.md`.
- Revision 3 (this doc) deep-pass reasoning notes:
  `D:\tmp\pianoid-cu-split-deep-pass-2026-05-19.md`.
