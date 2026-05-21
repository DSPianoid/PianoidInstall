# Proposal: Split the `Pianoid.cu` God-Object

**Date:** 2026-05-19
**Status:** Planning only — research + design. No code changes proposed for immediate execution.
**Scope:** `PianoidCore/pianoid_cuda/Pianoid.cu` (2988 LOC) and `Pianoid.cuh` (758 LOC).
**Author:** investigation sub-agent (docs-first per CLAUDE.md Documentation-First rule).
**Revision (2026-05-19):** restructured around the **module-substance criterion** — see §0.

---

## 0. Revision Note — the Module-Substance Criterion

The first draft of this proposal split `Pianoid.cu` into 8 files chosen to
make every file small and to map one-file-per-doc-page. The user rejected
that framing with a sharper criterion, applied verbatim here:

> *Every extracted module must own a clear entity and hold genuine,
> substantive authority + functionality over it — not be a bag of thin
> wrappers/helpers. Functionality that does not belong to `Pianoid.cu`
> organically should be **pushed to** the subsystem that genuinely owns it,
> not carved into a new `Pianoid_*` module merely to shrink the file. A
> smaller `Pianoid.cu` is not the goal; correct ownership is.*

The named bad example was the original `Pianoid_audio.cu`: "a collection of
wrappers around audio driver methods and helpers — no clear substance." The
named good example was preset-library management. The user further asked
whether **calibration** is worth a module of its own.

This revision re-evaluates **every** originally-proposed module against the
criterion. The verdict, in brief:

| Original module | Verdict | What changed |
|---|---|---|
| `Pianoid_internal.cuh` | **KEEP** | Shared preamble — not a module, an enabler. Unchanged. |
| `Pianoid_presets.cu` | **KEEP — strongest** | Owns the preset-library entity. The model module. |
| `Pianoid_parameters.cu` | **KEEP** | Owns the live parameter-update authority. |
| `Pianoid_excitation.cu` | **KEEP** | Owns excitation staging (host batch → GPU). |
| `Pianoid_synthesis.cu` | **KEEP — widened** | Owns the synthesis cycle; **absorbs the audio *output* path** (`pushCycleAudioToDriver`, `appendCycleAudioToHostBuffer`) — that path is the cycle's output stage, not driver business. |
| `Pianoid_debug.cu` | **KEEP** | Owns D2H state extraction. |
| `Pianoid_playback.cu` | **DISSOLVED** | 3 methods, ~45 LOC, no owned entity — folds into `Pianoid.cu` (offline orchestration is core lifecycle). |
| `Pianoid_audio.cu` | **REJECTED — split three ways** | Wrapper bag. Mic/stats/pause/sinewave wrappers **relocate into the audio-driver subsystem**; profiling wrappers stay in `Pianoid.cu`; the **calibration-mode** cluster becomes its own small but cohesive module `Pianoid_calibration.cu`. |

Net result: **6 files** (down from 8) — `Pianoid.cu` + `Pianoid_internal.cuh`
+ 4 substantive modules. Plus a **relocation** of ~10 wrapper methods out of
`Pianoid.*` entirely, into the audio-driver subsystem the work belongs to.

---

## 1. Summary

`Pianoid.cu` is the single largest `.cu` translation unit in `pianoid_cuda`
(2988 lines, 124 KB — next largest is `MainKernel.cu` at 31 KB). It is the
implementation file for the `Pianoid` facade class, which owns all GPU state
and is the sole public entry point for the Python middleware. Over successive
refactors it has accreted multiple responsibilities into one file — but, as §0
records, "number of responsibilities" is the wrong axis. The right question is
**which responsibilities does the `Pianoid` facade organically own**, and of
those, which form cohesive enough clusters to be their own translation unit.

This proposal recommends:

1. Splitting the *implementation* across **6 files** (4 new substantive `.cu`
   modules + 1 new internal header + the slimmed-down `Pianoid.cu`), keeping
   the **single `Pianoid` class and single `Pianoid.cuh` header unchanged**.
2. **Relocating** a cluster of ~10 thin audio-driver pass-through methods out
   of the `Pianoid` facade and **into the audio-driver subsystem** that
   already owns the underlying functionality — these are not modularised,
   they are moved to their rightful home.

The split is by member-function group, not by class — `Pianoid` stays one
class with one public API, so the pybind11 layer, all middleware call sites,
and the build's extension-module shape are untouched. (The relocation in
point 2 *does* touch the public API surface — see §5 — but in a contained,
well-defined way.)

**Critical enabling fact:** `Pianoid.cu` contains **zero `__global__` and zero
`__device__` code**. Every CUDA kernel (`addKernel`, `parameterKernel`,
`gaussKernel`, `convolutionKernel`, `stringMapKernel`, `copyKernel`,
`initializeKernel`, `floatToAudioSampleKernel`) is defined in *other* `.cu`
files and only *launched* from `Pianoid.cu`. `Pianoid.cu` is pure host-side
C++ that happens to carry a `.cu` extension so nvcc compiles the
`<<<>>>` launch syntax and `cudaLaunchCooperativeKernel` calls. This removes
the hardest constraint a CUDA split usually faces (device-code linkage across
translation units) — the split is an ordinary C++ member-function partition.

---

## 2. Documentation Basis

Per the CLAUDE.md Documentation-First rule, the ownership map below was
derived from the `docs/modules/pianoid-cuda/` hierarchy *and the audio-driver
subsystem docs* **before** reading source:

| Doc | What it establishes about ownership |
|---|---|
| `OVERVIEW.md` | `Pianoid` is the facade; it *owns* the memory manager, the audio driver, the profiler. The audio driver, memory manager, and playback engines are **separate components** the facade holds — not facade responsibilities. |
| `MEMORY_MANAGEMENT.md` | `Pianoid` *delegates* preset-library storage to `UnifiedGpuMemoryManager`; the facade owns the **library-management policy** (load/switch/unload/update-policy). |
| `PARAMETER_SYSTEM.md` | The granular + bulk update APIs, volume calc, `ParameterInfo` use are a genuine facade responsibility — the facade translates middleware calls into double-buffer updates. |
| `SYNTHESIS_ENGINE.md` | `runSynthesisKernel()` and the kernel launch sequencing are facade-owned. The Audio-Output subsection documents `pushCycleAudioToDriver` as the **cycle's output step** ("audio is emitted … push to audio driver"). |
| `PLAYBACK_SYSTEM.md` | `runCycle()` is "the single cycle-orchestration entry point"; its Online branch *calls* `pushCycleAudioToDriver()` / `appendCycleAudioToHostBuffer()` as concern-specific primitives. **These primitives are part of the cycle, not a separate audio module.** |
| `AUDIO_DRIVERS.md` | The audio-driver subsystem (`AudioDriverInterface`, SDL3/ASIO drivers, `AudioDriverFactory`, `LockFreeCircularBuffer`, `CaptureBuffer`) is a **self-contained subsystem**. It already owns: sample push, pause/resume, **mic capture** (`CaptureBuffer`), callback timing stats, input-device selection. |
| `pianoid-middleware/OVERVIEW.md` §CalibrationController | **Calibration logic lives in Python** (`calibration_controller.py`). The C++ side provides only the **semi-offline calibration *mode*** — "the engine loop is stopped but the audio driver stays alive." |
| `pianoid-middleware/REST_API.md` §Calibration | Confirms: the C++ contribution to calibration is the semi-offline mode (engine-stop / driver-alive) plus mic capture and synthesis-reference capture. |
| `DEBUG_DATA.md` | D2H result-extraction is a coherent facade responsibility (state → Python). |
| `LOGGING.md` | `Pianoid.cu` carries ~130 `PLOG` statements, all init-phase — irrelevant to the split axis. |

The decisive doc finding: **`AudioDriverInterface.h` already declares the
mic-capture, callback-stats, and pause/resume virtuals.** The audio-driver
subsystem is the organic owner of every one of the methods the original
`Pianoid_audio.cu` would have wrapped. That is why the original module is
rejected and its content relocated rather than modularised — see §4.

---

## 3. Current State — Section Map of `Pianoid.cu`

The file is internally organised with banner comments. Reading it top to
bottom, the actual section boundaries, line ranges, and — crucially — an
**ownership verdict** for each:

| # | Section (banner / role) | Lines | ~LOC | Owned by `Pianoid` facade? |
|---|---|---|---|---|
| A | Includes, profiling macros, `CUDA_LAUNCH*` | 1–137 | 137 | n/a — TU preamble |
| B | Constructor, destructor | 138–262 | 125 | **Yes** — object lifecycle |
| C | Typed buffer pointer/handler accessors (10 delegators) | 264–311 | 48 | **Yes** — facade-over-memory-manager accessors, but trivial |
| D | `devMemoryInit` + `switch_filter` + `set_filter` + `initParameters` | 313–772 | 460 | **Yes** — GPU-memory lifecycle |
| E | Parameter management — bulk + granular + volume | 774–1385 | 612 | **Yes** — live parameter authority |
| F | `getStringIndicesForPitch` helper | 1387–1415 | 29 | **Yes** — pitch→string lookup |
| G | Result extraction (D2H copies) | 1420–1617 | 198 | **Yes** — state extraction |
| H | Lifecycle: `freeCudaMemory`, `shutdownGpu`, `startApplication`/`stop*`, `startAudioDriver`/`stopAudioDriver` | 1619–1758 | 140 | **Yes** — GPU + app + audio-driver *lifecycle* |
| I | Excitation: batch API, `_append_string_gp`, mode excitation | 1761–1963 | 203 | **Yes** — excitation staging |
| J | Cycle orchestration: `setCycleIterations`, `runCycle`, `getCurrentCycleAudio`, `processSustain`, `midiPlayerSwitch` | 1965–2092 | 128 | **Yes** — cycle orchestrator |
| K | `runSynthesisKernel()` + time-record helpers | 2094–2283 | 190 | **Yes** — kernel launch sequencing |
| **L** | Audio output: `pushCycleAudioToDriver` (incl. FIR), `appendCycleAudioToHostBuffer`, `setChannelForSDL`, `pauseAudioPlayback`/`resumeAudioPlayback` | 2286–2569 | 284 | **Mixed** — see §4.1 |
| **M** | Semi-offline calibration mode + mic capture/analysis + sinewave + `playRecordedAudio` | 2571–2736 | 166 | **Mixed** — see §4.2 |
| **N** | Callback stats + profiling control | 2738–2796 | 59 | **Mixed** — see §4.3 |
| O | Preset library management | 2798–2944 | 147 | **Yes** — library-management policy |
| P | New playback API (`runOfflinePlayback`, `exportAudioToWav`, `getRecordedAudio`) | 2946–2988 | 43 | **Yes** — offline orchestration, but tiny |

Sections L, M, N — the original "audio" group — are where the substance
analysis bites. The next section dissects them function by function.

---

## 4. The Audio Group (L/M/N) — Function-Level Substance Analysis

This is the heart of the revision. Each function in sections L, M, N is
classified as **(a)** genuine `Pianoid` substance, **(b)** a thin wrapper over
the audio-driver subsystem, or **(c)** part of the cohesive calibration-mode
cluster.

### 4.1 Section L — what is cycle-output, what is a wrapper

| Function | LOC | Classification | Reasoning |
|---|---|---|---|
| `pushCycleAudioToDriver()` | ~217 | **(a) substance — but belongs to *synthesis*, not "audio"** | Launches `convolutionKernel` (FIR), the `floatToAudioSampleKernel`, does the 2-ch→8-ch channel-map expansion, manages `filterKernelArgs`. This is heavy GPU orchestration. But it is the **output stage of the synthesis cycle** — `runCycle`'s Online branch calls it right after `runSynthesisKernel`. It owns no audio-driver entity; it owns *the cycle's audio post-processing*. → folds into `Pianoid_synthesis.cu`. |
| `appendCycleAudioToHostBuffer()` | ~40 | **(a) substance — belongs to *synthesis*** | D2H copy of `dev_soundFloat` into the `rawSoundBuffer` host ring. Owns the ring's write-position bookkeeping. Also a cycle-output primitive (`runCycle` Online branch). → folds into `Pianoid_synthesis.cu`. |
| `setChannelForSDL(int)` | 3 | trivial setter | One-line member assignment. Goes wherever `channelForSDL` is most used — `Pianoid_synthesis.cu` (read in the audio path) or `Pianoid.cu`. Not load-bearing. → `Pianoid_synthesis.cu`. |
| `pauseAudioPlayback()` | 5 | **(b) wrapper** | `if (audioDriver) audioDriver->pause();` — nothing else. → **relocate to audio-driver subsystem** (§5). |
| `resumeAudioPlayback()` | 5 | **(b) wrapper** | `if (audioDriver) audioDriver->resume();` — nothing else. → **relocate** (§5). |

**Verdict on L:** the two substantive functions are *synthesis-cycle output*,
not a freestanding "audio" concern — they move to `Pianoid_synthesis.cu`. The
two pause/resume functions are pure pass-throughs — they leave `Pianoid.*`
entirely.

### 4.2 Section M — calibration-mode cluster vs wrappers

| Function | LOC | Classification | Reasoning |
|---|---|---|---|
| `stopEngineKeepAudio()` | ~8 | **(c) calibration-mode** | Stops the engine loop (`endMainLoop()`) but deliberately keeps the audio driver alive. This is the *defining operation* of semi-offline mode. Manipulates engine-loop state — a genuine `Pianoid` responsibility. |
| `executeSingleMeasurementCycle()` | ~24 | **(c) calibration-mode — substance** | Runs one `runCycle({Online, record_to_host=true})` synchronously from Python when no engine thread exists, and appends to `synthesisCaptureBuffer_` when capture is active. Real logic, owns the synthesis-capture append. |
| `restartOnlineEngine()` | ~9 | **(c) calibration-mode** | Re-arms the loop flags (`beginMainLoop()`) to exit semi-offline mode. Counterpart of `stopEngineKeepAudio`. |
| `startSynthesisCapture()` | ~6 | **(c) calibration-mode — substance** | Owns `synthesisCaptureActive_` / `synthesisCaptureBuffer_` — the reference-signal capture state. |
| `stopSynthesisCapture()` | ~8 | **(c) calibration-mode — substance** | Returns + clears the synthesis-capture buffer. |
| `getSynthesisCaptureBuffer()` | ~4 | **(c) calibration-mode** | Accessor for the capture buffer. |
| `analyzeCapturedAudio(...)` | ~18 | **(c) calibration-mode — substance** | Resolves default skip/window timing via `MicAnalyzer::getTimingForFrequency`, then calls `MicAnalyzer::analyze`. Holds the timing-default *policy* — not a pure wrapper. |
| `analyzeCapturedAudioWithReference(...)` | ~18 | **(c) calibration-mode — substance** | Same timing-default policy, then `MicAnalyzer::analyzeWithReference`. The mic-vs-synthesis transfer-ratio analysis — the core of acoustic calibration. |
| `startMicCapture(int)` | ~8 | **(b) wrapper** | `audioDriver->startCapture(maxDurationMs)` + null-check + throw. → **relocate** (§5). |
| `stopMicCapture()` | ~8 | **(b) wrapper** | `return audioDriver->stopCapture();` + null-check. → **relocate** (§5). |
| `isMicCapturing()` | ~5 | **(b) wrapper** | `return audioDriver->isCapturing();` + null-check. → **relocate** (§5). |
| `setMicDevice(const std::string&)` | ~7 | **(b) wrapper** | `audioDriver->setInputDevice(deviceName);` + null-check. → **relocate** (§5). |
| `listMicDevices()` | ~6 | **(b) wrapper** | `return audioDriver->listInputDevices();` + null-check. → **relocate** (§5). |
| `playRecordedAudio(...)` | ~22 | **(b) wrapper** | `dynamic_cast<ASIOAudioDriver*>` then `asioDriver->playRecordedAudio(...)`. Pure delegation to a concrete driver. → **relocate** (§5). |
| `testSinewave(...)` | ~4 | **(b) wrapper** | `SinewaveGenerator generator; return generator.generate(config);` — a free-standing audio-driver *test* helper, no `Pianoid` state. → **relocate** (§5) or move next to `SinewaveGenerator`. |

**Verdict on M:** there are two distinct things tangled together. The
**calibration-mode cluster** (the 8 `(c)` functions) is cohesive and
substantive: it owns the engine-loop-vs-audio-driver decoupling and the
synthesis-reference-capture state. The remaining 7 functions are **mic /
playback / sinewave wrappers** over the audio-driver subsystem.

### 4.3 Section N — profiling wrappers

| Function | LOC | Classification | Reasoning |
|---|---|---|---|
| `getCallbackStats()` | ~7 | **(b) wrapper** | `return audioDriver->getCallbackStats();` + null-check. → **relocate** (§5). |
| `resetCallbackStats()` | ~5 | **(b) wrapper** | `audioDriver->resetCallbackStats();` + null-check. → **relocate** (§5). |
| `startProfiling` / `stopProfiling` / `resetProfiling` / `writeProfilingData` / `getGpuProfilingData` / `getCpuProfilingData` (+ the `#else` stub set) | ~45 | **(b) wrapper — over `profiler_`** | Each is a one-line forward to `profiler_` (a `PianoidProfiler` member). `resetProfiling` additionally zeroes `g_profiling_cycle_counter`. The profiler is *owned by the facade as a member*; these wrappers are the facade's thin control surface over it. |

**Verdict on N:** the two callback-stats functions are audio-driver wrappers →
relocate. The profiling wrappers are a borderline case — see §4.4.

### 4.4 The profiling wrappers — why they stay in `Pianoid.cu`

The profiling control methods (`startProfiling` etc.) are thin forwards to the
`profiler_` member. By the strict criterion they "own no entity." But unlike
the audio-driver wrappers, **there is no separate subsystem to push them to**:
`PianoidProfiler` is a leaf utility class, not a subsystem with its own facade.
The wrappers exist because the *facade's public API* must expose profiling
control to pybind11. Relocating them would mean either (a) exposing
`PianoidProfiler` directly to Python — a real API change for no benefit, or
(b) inventing a `Pianoid_profiling.cu` that is itself a 45-LOC wrapper bag —
the exact anti-pattern under review.

**Decision:** the profiling wrappers stay in `Pianoid.cu` alongside the
constructor. They are ~45 LOC, they touch a facade member, and they are part
of the irreducible "facade exposes its members to Python" surface. This is the
honest answer — not every thin method can or should be relocated; some are the
legitimate cost of being a facade. The test is whether a *better owner exists*.
For audio-driver wrappers it does (the driver subsystem); for profiling it does
not.

`g_profiling_cycle_counter` (the file-static atomic incremented by
`runSynthesisKernel`, zeroed by `resetProfiling`) — see §6.4.

---

## 5. Relocation — Audio-Driver Wrappers Move Into the Audio-Driver Subsystem

This section answers the user's directive: *functionality that does not belong
to `Pianoid.cu` organically should be pushed to the audio-driver system, not
made into a new module.*

### 5.1 What relocates

The following **10 thin pass-through methods** are removed from the `Pianoid`
class and the audio-driver capability is exposed directly:

| Method (currently on `Pianoid`) | Forwards to | New home |
|---|---|---|
| `pauseAudioPlayback()` | `audioDriver->pause()` | already an `AudioDriverInterface` virtual — see §5.2 |
| `resumeAudioPlayback()` | `audioDriver->resume()` | already a virtual |
| `startMicCapture(int)` | `audioDriver->startCapture()` | already a virtual |
| `stopMicCapture()` | `audioDriver->stopCapture()` | already a virtual |
| `isMicCapturing()` | `audioDriver->isCapturing()` | already a virtual |
| `setMicDevice(string)` | `audioDriver->setInputDevice()` | already a virtual |
| `listMicDevices()` | `audioDriver->listInputDevices()` | already a virtual |
| `getCallbackStats()` | `audioDriver->getCallbackStats()` | already a virtual |
| `resetCallbackStats()` | `audioDriver->resetCallbackStats()` | already a virtual |
| `playRecordedAudio(...)` | `ASIOAudioDriver::playRecordedAudio()` | ASIO-specific — see §5.3 |

`testSinewave(...)` is a related case: it constructs a `SinewaveGenerator` and
returns `generate(config)`. It touches no `Pianoid` state at all. It moves
**next to `SinewaveGenerator`** (a static factory function or a
`SinewaveGenerator::runTest(config)` static), exposed to pybind11 directly.

**Decisive fact (verified against `AudioDriverInterface.h`):** every one of the
first 9 methods forwards to a virtual *that already exists on
`AudioDriverInterface`*. The interface was already designed to own mic capture
(`startCapture`/`stopCapture`/`isCapturing`/`setInputDevice`/`listInputDevices`,
lines 88–109), callback stats (`getCallbackStats`/`resetCallbackStats`, lines
82–86), and pause/resume (lines 45–48). The `Pianoid::` wrappers add **nothing
but a null-check**. The audio-driver subsystem is not *a candidate* owner — it
is *the* owner, and has been all along. The wrappers are vestigial.

### 5.2 How the relocation works — the binding-layer change

This is the one part of the proposal that touches the **public API surface**
(unlike the §6 split, which is API-invariant). It must be done deliberately.

The middleware reaches these methods today as `pianoid_cpp.startMicCapture(...)`
etc. (pybind11 bindings in `AddArraysWithCUDA.cpp`). Two relocation strategies,
with a recommendation:

**Strategy A — expose the audio driver as a sub-object (recommended).**
Add one accessor to `Pianoid`: `AudioDriverInterface* audioDriver()` (or a
reference). Bind `AudioDriverInterface` to pybind11 once, with its mic /
pause / stats virtuals. Python then calls `pianoid.audio_driver().start_capture(...)`.
- *Pro:* the audio-driver subsystem owns its API end-to-end, including the
  Python surface; the `Pianoid` class shrinks by 10 methods; no wrapper bag
  anywhere.
- *Con:* every middleware call site for these 10 methods is updated (a
  mechanical rename — `pianoid.X()` → `pianoid.audio_driver().X()`); the
  null-check the wrappers did (`if (!audioDriver) throw`) moves into the
  accessor (`audioDriver()` throws if the driver is absent) so the safety
  is preserved in exactly one place.
- *This is the "push to the owning subsystem" answer in its cleanest form.*

**Strategy B — keep the bindings, move only the bodies.**
Leave the 10 method *declarations* on `Pianoid` but mark them clearly as
"binding shims for the audio-driver subsystem" and move their (one-line)
bodies into an audio-driver-adjacent file. This is *not* recommended — it
keeps the wrapper bag, just relocates the `.cu` text. It fails the criterion.
Listed only to be explicitly rejected.

**Recommendation:** Strategy A. It is the only option that actually transfers
*authority* (not just code) to the audio-driver subsystem. It is a contained
middleware change (call-site renames + one new pybind class + one accessor),
and it can be its own phase (§7, Phase R) verified independently.

### 5.3 `playRecordedAudio` — ASIO-specific, belongs on the ASIO driver

`playRecordedAudio` is already half-relocated: its body is a
`dynamic_cast<ASIOAudioDriver*>` followed by `asioDriver->playRecordedAudio(...)`.
`ASIOAudioDriver` *already has* a `playRecordedAudio(const std::vector<float>&,
float)` method (confirmed in `AUDIO_DRIVERS.md` and `ASIOAudioDriver.h`). The
`Pianoid::` method is a pure dispatch wrapper. Under Strategy A it disappears
entirely — Python calls it via the `audio_driver()` accessor; the `dynamic_cast`
becomes the audio-driver subsystem's internal concern (or `playRecordedAudio`
is promoted to a default-throwing `AudioDriverInterface` virtual so no cast is
needed).

### 5.4 What does NOT relocate

To be precise about the boundary:

- **`pushCycleAudioToDriver` / `appendCycleAudioToHostBuffer` do NOT relocate
  to the audio-driver subsystem.** They are not driver operations — they are
  the *synthesis cycle's* output stage (FIR kernel, channel map, D2H ring).
  They stay in `Pianoid` and move to `Pianoid_synthesis.cu` (§6). Pushing them
  into the driver subsystem would be the *opposite* error — burying
  cycle/kernel logic inside a driver.
- **The calibration-mode cluster does NOT relocate.** It manipulates the
  *engine loop* (`beginMainLoop`/`endMainLoop`/`runCycle`) and owns
  synthesis-capture state — both genuine `Pianoid` responsibilities. It
  becomes its own module (§6).
- **Profiling wrappers do NOT relocate** — §4.4.

---

## 6. Calibration — Own Module, or Fold In?

The user explicitly asked: *reconsider whether [calibration] is worth making a
separate module.* Here is the reasoning, both ways, and the verdict.

### 6.1 What "calibration" means in `Pianoid.cu`

Critically — and this is the doc-first finding — **the calibration *algorithm*
is not in C++ at all.** `pianoid-middleware/OVERVIEW.md` §CalibrationController
is unambiguous: the 4-phase pipeline, the direct-linear-correction algorithm,
the bisection fallback, perception curves, level multipliers — all of that is
Python (`calibration_controller.py`). What `Pianoid.cu` contributes is the
**semi-offline calibration *mode*** and the **measurement primitives** the
Python controller drives:

- *Semi-offline mode* — `stopEngineKeepAudio()` / `restartOnlineEngine()`:
  decouple the engine loop from the audio driver so Python can step synthesis
  cycle-by-cycle while audio + mic stay live.
- *Single-cycle stepping* — `executeSingleMeasurementCycle()`.
- *Synthesis-reference capture* — `startSynthesisCapture()` / `stop` / `get`
  + the `synthesisCaptureBuffer_` / `synthesisCaptureActive_` members.
- *Captured-audio analysis* — `analyzeCapturedAudio()` /
  `analyzeCapturedAudioWithReference()` (timing-default policy + `MicAnalyzer`).

That is **8 functions, ~95 LOC**, plus 2 member variables.

### 6.2 The case *for* a `Pianoid_calibration.cu` module

- It **owns a clear entity**: the *semi-offline calibration mode* — a distinct
  operating mode of the engine, with its own enter (`stopEngineKeepAudio`) and
  exit (`restartOnlineEngine`) transitions, and its own state
  (`synthesisCaptureBuffer_`, `synthesisCaptureActive_`).
- It holds **genuine authority**: it is the only code allowed to stop the
  engine loop *without* stopping the audio driver — a non-obvious, deliberate
  decoupling that the rest of the codebase must not do ad hoc.
- It is **cohesive**: all 8 functions serve one workflow (Python-driven
  cycle-by-cycle measurement). `analyzeCapturedAudio*` is not a wrapper — it
  carries the skip/window timing-default policy.
- It maps to a **documented concept**: "semi-offline calibration mode" is a
  named mode in both `REST_API.md` and the middleware overview.
- It is the C++ **counterpart of a real Python module** (`CalibrationController`)
  — the boundary is principled, not arbitrary.

### 6.3 The case *against* (fold into `Pianoid.cu` or `Pianoid_synthesis.cu`)

- 95 LOC is small. The original proposal's own rule rejected sub-100-LOC
  modules (it folded sections C, F, N for exactly this reason).
- The mode transitions (`stopEngineKeepAudio`/`restartOnlineEngine`) are
  *engine-loop lifecycle* — arguably they belong with the other lifecycle code
  (`startApplication`/`stopApplication`) in `Pianoid.cu`.
- `executeSingleMeasurementCycle` just calls `runCycle` — it could sit next to
  `runCycle` in `Pianoid_synthesis.cu`.

### 6.4 Verdict — yes, a small but real module: `Pianoid_calibration.cu`

**Keep it as its own module.** The deciding argument: the substance criterion
the user set is about **owning a clear entity with genuine authority**, *not*
about LOC count. The semi-offline calibration mode **is** a clear entity — a
named, documented operating mode with explicit enter/exit transitions and
dedicated state. The 95-LOC size is a consequence of the C++ side being
deliberately thin (the algorithm is in Python); it is not evidence of
incohesion. Splitting these 8 functions across `Pianoid.cu` (the transitions)
and `Pianoid_synthesis.cu` (`executeSingleMeasurementCycle`) and somewhere
(the capture state) would **destroy** a cohesive unit to satisfy a LOC
heuristic — the opposite of the criterion.

This is also the *consistent* call: the criterion that rejects
`Pianoid_audio.cu` (no owned entity) is the same criterion that *accepts*
`Pianoid_calibration.cu` (a clearly owned entity). Size differs; ownership is
what the rule actually measures.

`Pianoid_calibration.cu` owns: the semi-offline calibration mode (engine-loop /
audio-driver decoupling) and the synthesis-reference-capture state. Authority:
sole owner of "stop engine, keep audio"; sole owner of
`synthesisCaptureBuffer_` / `synthesisCaptureActive_`.

(Note: `analyzeCapturedAudio*` calls `MicAnalyzer` — a leaf utility, like
`PianoidProfiler`. The mic-*capture* wrappers relocate to the driver subsystem
(§5); the mic-*analysis* methods stay here because they carry the
timing-default policy and are part of the measurement workflow. Capture and
analysis are different concerns: capture is a driver capability, analysis is a
calibration-measurement step.)

---

## 7. Proposed File Set

### 7.1 Design rules (unchanged from original, still valid)

1. **One class, one header.** `Pianoid.cuh` stays the single declaration of
   the `Pianoid` class. C++ permits a class's member functions to be defined
   across any number of translation units. No nested classes, no PIMPL.
2. **Split by *owned entity*, not by file size.** Each new `.cu` file contains
   the `Pianoid::` methods for one owned responsibility.
3. **Shared preamble → private header** (`Pianoid_internal.cuh`).
4. **The §6 split is a pure move-refactor** — function bodies relocated
   verbatim, only `#include` lines change. **The §5 relocation is NOT** — it
   changes the public API and middleware call sites; it is phased separately.
5. **`Pianoid.cu` survives as the lifecycle/core file.**

### 7.2 The 6 files (after the §6 split)

| File | Owned entity / authority | Contains (sections) | ~LOC |
|---|---|---|---|
| **`Pianoid.cu`** (slimmed) | The `Pianoid` object itself + GPU-memory lifecycle. Constructor/destructor, `devMemoryInit`, buffer registration, filter config, GPU/app lifecycle, **offline-playback orchestration** (`runOfflinePlayback` etc. — folded in from dissolved section P), **profiling control surface** (§4.4). | B, C, D, H, N(profiling only), P | ~830 |
| **`Pianoid_internal.cuh`** (new header) | — (shared TU preamble: `CUDA_LAUNCH*` macros, `PIANOID_ENABLE_PROFILING`, common includes) | A | ~110 |
| **`Pianoid_parameters.cu`** (new) | The live parameter-update authority — translates middleware calls into double-buffer updates. Bulk + granular param updates, `interpolateBaseLevels`, volume calc, `setRuntimeParameters`, `getStringIndicesForPitch`. | E, F | ~640 |
| **`Pianoid_presets.cu`** (new) | The **preset-library** entity — load / switch / unload / save / update-policy. The model module (user's "good example"). | O | ~150 |
| **`Pianoid_excitation.cu`** (new) | Excitation **staging** — host batch buffers → GPU; the begin/add/commit batch envelope; mode excitation. | I | ~205 |
| **`Pianoid_synthesis.cu`** (new) | The **synthesis cycle** — kernel launch sequencing AND the cycle's audio-output stage. `runCycle`, `runSynthesisKernel`, `setCycleIterations`, time-record helpers, **`pushCycleAudioToDriver`** (FIR + channel map), **`appendCycleAudioToHostBuffer`** (host ring), `getCurrentCycleAudio`, `setChannelForSDL`, `processSustain`, `midiPlayerSwitch`. | J, K, L(output funcs) | ~600 |
| **`Pianoid_calibration.cu`** (new) | The **semi-offline calibration mode** — engine-loop/audio-driver decoupling + synthesis-reference capture. `stopEngineKeepAudio`, `restartOnlineEngine`, `executeSingleMeasurementCycle`, `startSynthesisCapture`/`stop`/`get`, `analyzeCapturedAudio`/`WithReference`. | M(calibration cluster only) | ~110 |

**Plus the §5 relocation** (separate from the file count above): ~10 wrapper
methods leave `Pianoid.*` for the audio-driver subsystem; `testSinewave` moves
next to `SinewaveGenerator`. After this, sections L(wrappers), M(wrappers),
N(callback-stats) no longer exist on `Pianoid` at all.

**Result:** `Pianoid.cu` drops from 2988 → ~830 LOC. No file exceeds ~830 LOC.
Every new module owns a named entity with stated authority. There is **no
`Pianoid_audio.cu`** — the wrapper bag was relocated, the cycle-output path
went to synthesis, the calibration cluster became its own module.

### 7.3 What changed vs the original 8-file proposal

| Original | Now | Why |
|---|---|---|
| `Pianoid_audio.cu` (L+M+N) | **deleted** | Wrapper bag — fails the substance criterion. |
| — | wrappers **relocated** to audio-driver subsystem | §5 — pushed to the organic owner. |
| L's `pushCycleAudioToDriver` etc. → `Pianoid_audio.cu` | → `Pianoid_synthesis.cu` | It is the synthesis cycle's output stage. |
| M's calibration cluster → `Pianoid_audio.cu` | → new `Pianoid_calibration.cu` | Cohesive owned entity (semi-offline mode). |
| N's profiling → `Pianoid_audio.cu` | → `Pianoid.cu` | No better owner exists (§4.4). |
| `Pianoid_playback.cu` (P, ~45 LOC) | **dissolved** → `Pianoid.cu` | 3 methods, no owned entity; offline orchestration is core lifecycle. |
| 8 files | **6 files** + 1 relocation | Fewer, each substantive. |

### 7.4 Include / dependency structure

```
                       Pianoid.cuh   (unchanged — single class declaration)
                            ▲
                            │  #include
        ┌───────────────────┼───────────────────────────────┐
        │                   │                               │
 Pianoid_internal.cuh        │                               │
 (CUDA_LAUNCH macros,        │                               │
  common includes)           │                               │
        ▲                    │                               │
        │ #include            │                               │
        │                    │                               │
  ┌─────┴──────┬──────────┬──┴───────┬───────────┬────────────┐
  │            │          │          │           │            │
Pianoid.cu  _parameters  _presets  _excitation  _synthesis  _calibration
  .cu          .cu         .cu        .cu          .cu          .cu
```

- Every split `.cu` includes `Pianoid.cuh` (class declaration) and
  `Pianoid_internal.cuh` (launch macros + common headers).
- `Pianoid_internal.cuh` includes `Pianoid.cuh`, `<cuda_runtime.h>`,
  `<cooperative_groups.h>`, `PianoidLogger.h`, `constants.h`, `Kernels.cuh`,
  `gaussTest.cuh`, `MainKernel.cuh`, `FIRFilter.cuh`, `PianoidProfiler.h`,
  plus the Windows `<windows.h>` guard block.
- Files needing extra headers include them directly: `Pianoid.cu` →
  `OfflinePlaybackEngine.h` / `WavWriter.h` (offline playback); `Pianoid_synthesis.cu`
  → FIR headers if not already in the internal header; `Pianoid_calibration.cu`
  → `MicAnalyzer.h`.
- **No new cross-`.cu` symbol dependencies** beyond the one file-static atomic
  (§6.4 / the items table). All member-to-member calls resolve via the single
  `Pianoid.cuh`.

### 7.5 Items needing care

| Item | Note |
|---|---|
| `Pianoid::instance` static | `Pianoid* Pianoid::instance = nullptr;` — keep in `Pianoid.cu` (one TU). |
| `Pianoid::testModeEnabled` static | `bool Pianoid::testModeEnabled = false;` currently at line 2557 (section L). Move to `Pianoid.cu` next to `instance` so all static-member definitions co-locate. |
| `g_profiling_cycle_counter` | File-`static` `std::atomic<int>` — incremented by `runSynthesisKernel` (→ `Pianoid_synthesis.cu`) and reset by `resetProfiling` (→ `Pianoid.cu`). Promote to a single owner: declare `extern` in `Pianoid_internal.cuh`, **define in `Pianoid_synthesis.cu`**, reference from `Pianoid.cu`. The one genuine new cross-file linkage; trivial. |
| `PIANOID_ENABLE_PROFILING` `#define` | Currently the first line of `Pianoid.cu`, before any include. Move into `Pianoid_internal.cuh` (before its includes) so every TU sees it consistently. |
| `loadParameterToPianoid<T>` template | Defined in `Pianoid.cuh` — already correct, no move. |
| `kernelArgs` / `filterKernelArgs` | Class-member `std::vector<void*>` — *populated* in `initParameters()` (`Pianoid.cu`), *consumed* in `runSynthesisKernel` / `pushCycleAudioToDriver` (`Pianoid_synthesis.cu`). Normal cross-file member access. |
| §5 relocation — pybind | The relocation (Strategy A) adds an `AudioDriverInterface` pybind class + a `Pianoid::audioDriver()` accessor and updates ~10 middleware call sites. **This is an API change** — phase it separately (Phase R) and verify with a live `/diagnose`. |
| `setup.py` | **No edit required for the §6 split.** `_discover_sources()` (setup.py:548) globs `THIS_DIR.glob("*.cu")` — new `.cu` files are picked up automatically. Confirmed against `BUILD_SYSTEM.md` §"Source Discovery". |

---

## 8. CUDA / Build-System Risk Assessment

| Risk | Severity | Assessment |
|---|---|---|
| Device-code linkage across TUs | **None** | `Pianoid.cu` has zero `__global__`/`__device__` code. All kernels defined elsewhere; this file only launches them. No `-rdc` implications. |
| `setup.py` source discovery | **None** | Auto-glob of `*.cu`; new files compile automatically. |
| Per-file compile cost | **Low / positive** | nvcc compiles each `.cu` independently. Six smaller files parallelise better and make incremental builds far more effective. |
| Cooperative-kernel launches | **None** | `cudaLaunchCooperativeKernel((void*)convolutionKernel, …)` is a host API call; the function-pointer cast resolves against the kernel symbol in `FIRFilter.cuh`. Works from any TU including that header. |
| Macro redefinition | **Low** | `CUDA_LAUNCH*` centralised in `Pianoid_internal.cuh` with an `#ifndef` guard. |
| pybind11 binding layer — **§6 split** | **None** | Method definitions moving between `.cu` files does not change mangled symbols. |
| pybind11 binding layer — **§5 relocation** | **Medium — by design** | Strategy A *intentionally* changes the Python API for ~10 audio-driver methods. This is the point of the relocation. Contained: new `AudioDriverInterface` pybind class + accessor + call-site renames. Isolated to Phase R; verified with live `/diagnose`. |
| Build-green at each step | **Mitigated by phasing** | See §9 — each phase is independently compilable + testable. |
| Linux `.sh` build sibling | **None** | `build_pianoid_cuda.sh` uses the same `setup.py` auto-glob. |

**Overall CUDA risk: very low** for the §6 split (host-only file, auto-glob).
The §5 relocation carries a **contained, deliberate API-surface change** —
medium risk, fully phased and independently verifiable.

---

## 9. Phased Migration Plan

Each phase keeps the build green and is verified with a `--heavy --release`
build (per CLAUDE.md). **Phases are ordered leaf-first** for the split, with
the API-changing relocation (Phase R) sequenced deliberately. The split itself
is a future `/dev` `--heavy` task.

| Phase | Action | Build-green check | Why this order |
|---|---|---|---|
| **0** | Create `Pianoid_internal.cuh`: move `PIANOID_ENABLE_PROFILING`, the `CUDA_LAUNCH*` macros, the common include block. `Pianoid.cu` `#include`s it. No methods move. | `--heavy --release` build; `/test-ui` audio_off (synthesis output bit-identical). | Establishes the shared preamble all later phases depend on. |
| **1** | Extract `Pianoid_presets.cu` (section O). | Build; preset-switch system test. | Self-contained delegation to `memory_manager_`; the strongest-cohesion module — proves the mechanics on a clean case. |
| **2** | Extract `Pianoid_debug.cu` (section G — D2H extraction). | Build; debug-variant build (`--both`); chart-function smoke test. | Read-only D2H, no synthesis coupling; exercises the `PIANOID_DEBUG_DATA` guards early. |
| **3** | Extract `Pianoid_calibration.cu` (section M calibration cluster only — the 8 `(c)` functions). | Build; `/diagnose` semi-offline measurement path (mic Phase 7 if available). | Cohesive cluster, no synthesis-path edits; isolates the calibration mode before synthesis moves. |
| **4** | Extract `Pianoid_excitation.cu` (section I). | Build; single-note + chord `/test-ui`. | Excitation staging; consumed by synthesis (phase 6). |
| **5** | Extract `Pianoid_parameters.cu` (sections E, F). | Build; parameter-edit `/test-ui` (tension/stiffness audible change). | Largest group (~640 LOC); isolated after smaller phases shrink `Pianoid.cu`. |
| **6** | Extract `Pianoid_synthesis.cu` (sections J, K + L's `pushCycleAudioToDriver` / `appendCycleAudioToHostBuffer` / `setChannelForSDL`). Define `g_profiling_cycle_counter` here; declare `extern` in `Pianoid_internal.cuh`. | Build; full playback `/test-ui`; live audio `/diagnose`; profiling-data smoke test. | The hottest path + the audio-output stage — moved as one unit, verified hard. |
| **7** | Fold dissolved section P (`runOfflinePlayback` etc.) into the now-slimmed `Pianoid.cu` if not already there; confirm only B, C, D, H, profiling, P remain. | Build; offline-render `/test-ui`. | Cleanup — `Pianoid.cu` reaches its final ~830-LOC shape. |
| **R** | **Relocation phase (API change).** Strategy A: add `AudioDriverInterface` pybind class + `Pianoid::audioDriver()` accessor; delete the 10 wrapper methods from `Pianoid`; move `testSinewave` next to `SinewaveGenerator`; rename the ~10 middleware call sites. | Build; full regression `/test-ui` + live `/diagnose` (audio + mic) — the mic-capture and callback-stats paths must work through the new accessor. | Sequenced LAST: it is the only API-changing phase; doing it after the file split means the split is already verified and stable when the API moves. Can also be deferred to a follow-up `/dev` task entirely — the §6 split stands on its own. |
| **8** | Final pass: per-file `using`-namespace cleanup, minimal include lists, doc updates. | Build; full regression `/test-ui` + `/diagnose`. | Cosmetic + doc sync. |

**Rollback:** every phase is an isolated commit on a feature branch. Phases
0–8 are pure move-refactors — revert one commit, earlier phases remain valid.
**Phase R is the one phase that is not a pure move** — it gets its own commit
(or its own PR) so it can be reverted or deferred independently of the split.

### Documentation updates (phase 8)

- `docs/modules/pianoid-cuda/OVERVIEW.md` — update the "Pianoid (facade)" box
  and file references to list the new `.cu` files; note that the audio-driver
  subsystem now owns the mic/stats/pause API directly (Phase R).
- `docs/modules/pianoid-cuda/AUDIO_DRIVERS.md` — document that the
  mic-capture / callback-stats / pause-resume / `playRecordedAudio` API is
  reached directly via the driver (post Phase R), not via `Pianoid` wrappers.
- Module docs that cite `Pianoid.cu:<line>` for a method
  (`SYNTHESIS_ENGINE.md`, `PLAYBACK_SYSTEM.md`, `PARAMETER_SYSTEM.md`,
  `MEMORY_MANAGEMENT.md`, `DEBUG_DATA.md`, `LOGGING.md`) — repoint file
  references to the new home file.
- No new doc *page* is needed — `Pianoid_calibration.cu` maps to the existing
  "semi-offline calibration mode" concept already documented in
  `REST_API.md` and the middleware overview.

---

## 10. Why This Shape (Alternatives Considered)

| Alternative | Verdict |
|---|---|
| **The original 8-file split with `Pianoid_audio.cu`** | Rejected — §0. `Pianoid_audio.cu` was a wrapper bag with no owned entity; it bundled three unrelated things (cycle-output, calibration-mode, profiling). |
| **Keep `Pianoid_audio.cu` but rename it / add a doc comment** | Rejected — §5.2 Strategy B. Renaming a wrapper bag does not give it substance. |
| **Make a `Pianoid_profiling.cu`** | Rejected — §4.4. It would be a 45-LOC wrapper bag over `profiler_`; no separate subsystem to own it. The wrappers stay in `Pianoid.cu` as the legitimate facade-exposure cost. |
| **Fold calibration into `Pianoid.cu` / `Pianoid_synthesis.cu`** | Rejected — §6.4. The semi-offline calibration mode is a clearly owned entity; splitting it across files to satisfy a LOC heuristic destroys cohesion. |
| **Relocate `pushCycleAudioToDriver` into the audio-driver subsystem** | Rejected — §5.4. It is synthesis-cycle output (FIR kernel, channel map), not a driver operation. Burying it in a driver would be the opposite ownership error. |
| **PIMPL / `PianoidImpl`** | Rejected. Adds an indirection layer for zero benefit — the problem is file size + ownership clarity, not header compile coupling. |
| **Extract sub-objects** (a `PianoidAudio` class owning the audio path) | Rejected for *this* proposal. Note Strategy A (§5.2) *does* lean on the **already-existing** `AudioDriverInterface` sub-object — that is exposing an existing component, not extracting a new class. A genuine new-sub-object refactor (e.g. a `PianoidSynthesis` class) is a deeper change with real `this`-threading / state-ownership risk; it could be a separate later proposal. |
| **Keep `Pianoid.cu` as-is** | Rejected. 2988 LOC in one file is a navigation + merge-conflict hazard; it is the file most likely to collide when multiple `/dev` agents touch the engine. |

---

## 11. Deliverable Summary (for team-lead)

- **Revised per the module-substance criterion.** A smaller `Pianoid.cu` is
  not the goal — correct ownership is. Every extracted module must own a
  named entity with genuine authority.
- **File set: 6 files** — `Pianoid.cu` (slimmed, ~830 LOC) + `Pianoid_internal.cuh`
  + 4 substantive modules: `_parameters`, `_presets`, `_excitation`,
  `_synthesis`, `_calibration`. (That is the slimmed core + 1 header + 4
  new `.cu` = 6.) Down from the original 8.
- **`Pianoid_audio.cu` is rejected and dissolved three ways:**
  1. The ~10 thin audio-driver pass-through methods (mic capture, callback
     stats, pause/resume, `playRecordedAudio`) **relocate into the
     audio-driver subsystem** — which `AudioDriverInterface.h` shows already
     owns every one of them. `testSinewave` moves next to `SinewaveGenerator`.
  2. The substantive audio-*output* path (`pushCycleAudioToDriver` with its
     FIR kernel + channel map, `appendCycleAudioToHostBuffer`) goes to
     **`Pianoid_synthesis.cu`** — it is the synthesis cycle's output stage.
  3. The profiling wrappers stay in `Pianoid.cu` — no better owner exists.
- **Calibration: yes, its own module** (`Pianoid_calibration.cu`, ~110 LOC).
  Small but cohesive — it owns the *semi-offline calibration mode* (a named,
  documented operating mode with explicit enter/exit transitions) and the
  synthesis-reference-capture state. The C++ side is deliberately thin
  because the calibration *algorithm* is Python (`CalibrationController`);
  thinness here reflects a clean Python/C++ boundary, not incohesion.
- **`Pianoid_playback.cu` dissolved** — 3 methods, no owned entity; offline
  orchestration folds into `Pianoid.cu` as core lifecycle.
- **Migration: 10 phases (0–8 + R).** Phases 0–8 are pure move-refactors,
  leaf-first, each one commit and independently build-green. **Phase R** is
  the single API-changing phase (the audio-driver relocation) — sequenced
  last, its own commit/PR, and deferrable to a follow-up task if desired.
- **CUDA risk:** very low for the split (`Pianoid.cu` is host-only; `setup.py`
  auto-globs `*.cu`). The relocation carries a contained, deliberate
  API-surface change, fully phased.
- **Execution:** planning only. The split + relocation is a future `--heavy`
  CUDA `/dev` task following the §9 phase plan.
