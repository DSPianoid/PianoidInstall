# Proposal: Split the `Pianoid.cu` God-Object

**Date:** 2026-05-19
**Status:** Planning only — research + design. No code changes proposed for immediate execution.
**Scope:** `PianoidCore/pianoid_cuda/Pianoid.cu` (2988 LOC) and `Pianoid.cuh` (758 LOC).
**Author:** investigation sub-agent (docs-first per CLAUDE.md Documentation-First rule).

---

## 1. Summary

`Pianoid.cu` is the single largest `.cu` translation unit in `pianoid_cuda`
(2988 lines, 124 KB — next largest is `MainKernel.cu` at 31 KB). It is the
implementation file for the `Pianoid` facade class, which owns all GPU state
and is the sole public entry point for the Python middleware. Over successive
refactors it has accreted **nine distinct responsibilities** into one file.

This proposal recommends splitting the *implementation* across **8 files**
(7 new `.cu` + the slimmed-down `Pianoid.cu`) while keeping the **single
`Pianoid` class and single `Pianoid.cuh` header unchanged**. The split is by
member-function group, not by class — `Pianoid` stays one class with one
public API, so the pybind11 layer, all middleware call sites, and the build's
extension-module shape are untouched.

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

Per the CLAUDE.md Documentation-First rule, the responsibility map below was
derived from the `docs/modules/pianoid-cuda/` hierarchy *before* reading
source:

| Doc | Responsibility it documents in `Pianoid` |
|---|---|
| `OVERVIEW.md` | Facade role; owns memory manager, audio driver, profiler; lists key methods |
| `MEMORY_MANAGEMENT.md` | `devMemoryInit()`, buffer registration, preset library delegation |
| `PARAMETER_SYSTEM.md` | Granular + bulk parameter update APIs, volume calc, `ParameterInfo` |
| `SYNTHESIS_ENGINE.md` | `runSynthesisKernel()`, batch excitation API, kernel trigger (`new_notes_ind`) |
| `PLAYBACK_SYSTEM.md` | `runCycle()`, `runOfflinePlayback()`, cycle orchestration |
| `AUDIO_DRIVERS.md` | `startAudioDriver()`/`stopAudioDriver()`, `pushCycleAudioToDriver()`, mic capture |
| `DEBUG_DATA.md` | `getPianoidState()`, `getOutputData()`, `getSoundRecords()`, `fetchExcitation()`, etc. |
| `LOGGING.md` | Confirms `Pianoid.cu` carries ~130 `PLOG` statements, all init-phase |

The doc hierarchy already treats these as **separate concerns** (one doc page
each). The file does not. The split brings the file structure into alignment
with the documentation structure — a one-to-one-ish mapping that makes the
codebase easier to navigate from the docs.

---

## 3. Current State — Section Map of `Pianoid.cu`

The file is internally organised with banner comments (`//*** SECTION ***`).
Reading it top to bottom, the actual section boundaries and line ranges are:

| # | Section (banner / role) | Lines | ~LOC | Responsibility |
|---|---|---|---|---|
| A | Includes, profiling macros, `CUDA_LAUNCH` / `CUDA_LAUNCH_ASYNC` | 1–137 | 137 | Translation-unit preamble |
| B | Constructor, destructor | 138–262 | 125 | Object lifecycle, audio-driver creation, `cycle_parameters` packing |
| C | Typed buffer pointer/handler accessors | 264–311 | 48 | `getIntPointer`, `getRealHandler`, … (10 trivial delegators) |
| D | `devMemoryInit()` + `switch_filter` + `set_filter` + `initParameters()` | 313–772 | 460 | GPU memory init: buffer registration, FIR config, init kernels |
| E | Parameter management — bulk + granular + volume | 774–1385 | 612 | `setNew*Parameters`, `update*StringParameter_NEW`, `interpolateBaseLevels`, volume calc, `setRuntimeParameters` |
| F | `getStringIndicesForPitch` helper | 1387–1415 | 29 | Pitch→string lookup |
| G | Result extraction (D2H copies) | 1420–1617 | 198 | `getPianoidState`, `getModeDisplacements`, `getRawSoundRecord`, `getSoundRecords`, `getOutputData`, `getParameters`, `fetchExcitation`, `clearRecords` |
| H | Lifecycle: `freeCudaMemory`, `shutdownGpu`, `startApplication`/`stop*`, audio start/stop | 1619–1758 | 140 | GPU + app + audio-driver lifecycle control |
| I | Excitation: `_add_string_for_playback`, `_append_string_gp`, `_exciteSingleMode`, batch API, mode excitation | 1761–1963 | 203 | `beginStringBatch`/`addStringToBatch`/`commitStringBatch`, `addOneString`, `addModeExcitation`, `exciteMode` |
| J | Cycle orchestration: `setCycleIterations`, `runCycle`, `getCurrentCycleAudio`, `processSustain`, `midiPlayerSwitch` | 1965–2092 | 128 | `runCycle(CycleOutput)` — the cycle orchestrator |
| K | `runSynthesisKernel()` + time-record helpers | 2094–2283 | 190 | Kernel launch sequencing (stringMap → parameter → gauss → addKernel) |
| L | Audio output: `pushCycleAudioToDriver` (incl. FIR path), `appendCycleAudioToHostBuffer`, pause/resume | 2286–2569 | 284 | Audio push, FIR convolution launch, host-buffer ring |
| M | Semi-offline calibration + mic capture/analysis | 2571–2736 | 166 | `executeSingleMeasurementCycle`, `startMicCapture`, `analyzeCapturedAudio*`, synthesis capture |
| N | Callback stats + profiling control | 2738–2796 | 59 | `getCallbackStats`, `startProfiling`/`stop`/`reset`, profiling-disabled stubs |
| O | Preset library management | 2798–2944 | 147 | `loadPresetToLibrary`, `switchPreset`, `unloadPresetFromLibrary`, update-policy control |
| P | New playback API | 2946–2988 | 43 | `runOfflinePlayback`, `exportAudioToWav`, `getRecordedAudio` |

Sixteen labelled sections, nine genuine responsibilities. Several sections are
small (C, F, N, P) and naturally fold into a larger sibling.

---

## 4. Proposed Split

### 4.1 Design rules

1. **One class, one header.** `Pianoid.cuh` stays the single declaration of
   the `Pianoid` class. C++ permits a class's member functions to be defined
   across any number of translation units — only the *declaration* must be
   single. No nested classes, no PIMPL, no interface extraction. The public
   API the middleware sees is byte-identical.
2. **Split by cohesive member-function group.** Each new `.cu` file contains
   `Pianoid::` method definitions for one responsibility, plus any
   file-local helpers (`static` functions, anonymous-namespace constants).
3. **Shared preamble moves to a private header.** The `CUDA_LAUNCH` /
   `CUDA_LAUNCH_ASYNC` macros and the common include set are needed by every
   split file. They go into a new internal header `Pianoid_internal.cuh` so
   each `.cu` file has a one-line include instead of duplicating 100 lines of
   macro.
4. **No behavioural change.** This is a pure move-refactor. Function bodies
   are relocated verbatim. The only edits are: (a) `#include` lines, (b)
   removing the macro block from `Pianoid.cu` in favour of the new internal
   header.
5. **`Pianoid.cu` survives as the lifecycle/core file**, not deleted — the
   constructor/destructor and `devMemoryInit` stay there. Keeping the name
   means git history for the core lifecycle code is preserved on the original
   path.

### 4.2 The 8 files (7 new + slimmed `Pianoid.cu`)

| File | Contains (sections) | ~LOC | Responsibility |
|---|---|---|---|
| **`Pianoid.cu`** (slimmed) | B, C, D — constructor/dtor, accessors, `devMemoryInit`, `initParameters`, filter config | ~720 | Object + GPU-memory lifecycle, buffer registration |
| **`Pianoid_internal.cuh`** (new header) | A — `CUDA_LAUNCH*` macros, common includes | ~110 | Shared TU preamble for all split files |
| **`Pianoid_parameters.cu`** (new) | E, F — bulk/granular param updates, `interpolateBaseLevels`, volume calc, `setRuntimeParameters`, `getStringIndicesForPitch` | ~640 | Parameter system |
| **`Pianoid_presets.cu`** (new) | O — `loadPresetToLibrary`, `switchPreset`, library mgmt, update-policy control | ~147 | Preset library GPU ops |
| **`Pianoid_excitation.cu`** (new) | I — string batch API, `_append_string_gp`, mode excitation | ~205 | Note/mode excitation staging |
| **`Pianoid_synthesis.cu`** (new) | J, K — `runCycle`, `runSynthesisKernel`, `setCycleIterations`, time-record helpers | ~320 | Synthesis cycle + kernel launch sequencing |
| **`Pianoid_audio.cu`** (new) | L, M, N — `pushCycleAudioToDriver` (incl. FIR), host-buffer ring, mic capture, calibration, profiling control, callback stats | ~510 | Audio output, mic, calibration, profiling |
| **`Pianoid_debug.cu`** (new) | G — all D2H result-extraction methods | ~200 | Debug/state extraction |
| **`Pianoid_playback.cu`** (new) | P — `runOfflinePlayback`, `exportAudioToWav`, `getRecordedAudio` | ~45 | High-level playback API |

Lifecycle methods from section H are split by affinity: `freeCudaMemory` and
`shutdownGpu` stay in `Pianoid.cu` (memory lifecycle); `startApplication` /
`stopApplication` / `startAudioDriver` / `stopAudioDriver` move to
`Pianoid_audio.cu` (audio-driver lifecycle, where the mutex they share with
the audio path also lives).

**Result:** the largest file drops from 2988 → ~720 LOC. No file exceeds
~720 LOC. Every file maps to exactly one doc page (or a tight cluster).

### 4.3 Include / dependency structure

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
  ┌─────┴──────┬──────────┬──┴───────┬──────────┬──────────┬──┴────────┐
  │            │          │          │          │          │           │
Pianoid.cu  _parameters  _presets  _excitation _synthesis  _audio   _debug / _playback
  .cu          .cu         .cu        .cu         .cu        .cu        .cu
```

- Every split `.cu` includes `Pianoid.cuh` (for the class declaration) and
  `Pianoid_internal.cuh` (for the launch macros + common headers).
- `Pianoid_internal.cuh` includes `Pianoid.cuh`, `<cuda_runtime.h>`,
  `<cooperative_groups.h>`, `PianoidLogger.h`, `constants.h`, `Kernels.cuh`,
  `gaussTest.cuh`, `MainKernel.cuh`, `FIRFilter.cuh`, `Profiler.h`, plus the
  Windows `<windows.h>` guard block.
- Files that need extra headers include them directly (e.g.
  `Pianoid_playback.cu` includes `OfflinePlaybackEngine.h` / `WavWriter.h`;
  `Pianoid_audio.cu` includes `ASIOAudioDriver.h` / `SinewaveGenerator.h` /
  `MicAnalyzer.h`).
- **No new cross-`.cu` symbol dependencies are introduced.** Each method
  already only calls `memory_manager_`, `audioDriver`, `profiler_`, other
  `Pianoid::` methods, and free kernel functions — all reachable via headers.
  Member-to-member calls across files resolve fine because they are all
  `Pianoid::` methods declared in the one shared `Pianoid.cuh`.

### 4.4 Items needing care

| Item | Note |
|---|---|
| `Pianoid::instance` static | Defined once (`Pianoid* Pianoid::instance = nullptr;`). Must live in exactly one `.cu` — keep it in `Pianoid.cu`. |
| `Pianoid::testModeEnabled` static | `bool Pianoid::testModeEnabled = false;` currently at line 2557 (section L). Must move to exactly one file — put it in `Pianoid.cu` next to `instance` so all static-member definitions are co-located. |
| `g_profiling_cycle_counter` | File-`static` `std::atomic<int>` used by `runSynthesisKernel` (increment) and `resetProfiling` (reset). After the split these land in *different* files (`_synthesis.cu` and `_audio.cu`). Promote to a single owner: declare `extern` in `Pianoid_internal.cuh`, define in `Pianoid_synthesis.cu`, reference from `Pianoid_audio.cu`. **This is the one genuine new cross-file linkage** and it is trivial. |
| `PIANOID_ENABLE_PROFILING` `#define` | Currently `#define PIANOID_ENABLE_PROFILING 1` as the *first line* of `Pianoid.cu`, before any include — it gates `PianoidProfiler.h`. Every split file that touches the profiler (`_synthesis`, `_audio`) needs the same define active before including `Pianoid.cuh`. Cleanest: move the `#define` into `Pianoid_internal.cuh` (before its includes) so it is consistent across all TUs. |
| `loadParameterToPianoid<T>` template | Defined in `Pianoid.cuh` (header) — already correct, no move needed; instantiations in any `.cu` resolve. |
| `using namespace` directives | `Pianoid.cu` has `using namespace std; std::chrono; cooperative_groups;` at file scope. Each split file should declare only the namespaces it actually uses (avoid blanket `using namespace std` in the new files — keep it scoped). Not strictly required for correctness but worth doing while the code is being moved. |
| `setup.py` | **No edit required.** `_discover_sources()` (setup.py:548) globs `THIS_DIR.glob("*.cu")` — new `.cu` files are picked up automatically. Confirmed against `docs/architecture/BUILD_SYSTEM.md` §"Source Discovery". |

---

## 5. CUDA / Build-System Risk Assessment

| Risk | Severity | Assessment |
|---|---|---|
| Device-code linkage across TUs | **None** | `Pianoid.cu` has zero `__global__`/`__device__` code (verified by grep). All kernels are defined elsewhere; this file only launches them. Splitting host code that issues `<<<>>>` launches has no relocatable-device-code (`-rdc`) implications. |
| `setup.py` source discovery | **None** | Auto-glob of `*.cu`; new files compile automatically. No `setup.py` change. |
| Per-file compile cost | **Low / positive** | nvcc compiles each `.cu` independently to a `.obj`. Eight smaller files parallelise better than one 124 KB file and make incremental builds (`PIANOID_INCREMENTAL_BUILD=1`) far more effective — editing the audio path no longer recompiles the parameter system. |
| Cooperative-kernel launches | **None** | `cudaLaunchCooperativeKernel((void*)addKernel, …)` and `(void*)convolutionKernel` are host API calls; the function-pointer cast resolves against the kernel symbol declared in `MainKernel.cuh` / `FIRFilter.cuh`. Works identically from any TU that includes those headers. |
| `kernelArgs` / `filterKernelArgs` vectors | **Low** | These `std::vector<void*>` members are *populated* in `initParameters()` (stays in `Pianoid.cu`) and *consumed* in `runSynthesisKernel`/`pushCycleAudioToDriver` (move to `_synthesis.cu`/`_audio.cu`). They are class members — cross-file access is normal member access, no linkage concern. |
| Macro redefinition | **Low** | `CUDA_LAUNCH*` macros centralised in `Pianoid_internal.cuh` with the standard `#ifndef` include guard — no double-definition risk. |
| pybind11 binding layer | **None** | Bindings live in `AddArraysWithCUDA.cpp` and bind `Pianoid::` methods by name. Method definitions moving between `.cu` files does not change their mangled symbols or signatures. |
| Build-green at each step | **Mitigated by phasing** | See §6 — each phase moves one cohesive group and is independently compilable + testable. |
| Linux `.sh` build sibling | **None** | `build_pianoid_cuda.sh` uses the same `setup.py` auto-glob. No divergence; the `.bat`/`.sh` sibling invariant is unaffected. |

**Overall CUDA risk: very low.** The dangerous version of a "split a `.cu`
file" task — separating coupled `__device__` functions and `__global__`
kernels across translation units, which forces `-rdc=true` and changes link
behaviour — **does not apply here**, because `Pianoid.cu` is host-only.

---

## 6. Phased Migration Plan

Each phase keeps the build green and is verified with a `--heavy --release`
build (per CLAUDE.md: any `.cu` change goes through a CUDA build). The split
itself is a future `/dev` `--heavy` task; this proposal is the plan it would
follow. **Phases are ordered leaf-first** — files with the fewest inbound
dependencies move first, so the high-traffic core (`Pianoid.cu`) is touched
last and least.

| Phase | Action | Build-green check | Why this order |
|---|---|---|---|
| **0** | Create `Pianoid_internal.cuh`: move `PIANOID_ENABLE_PROFILING` define, the `CUDA_LAUNCH*` macros, and the common include block into it. Make `Pianoid.cu` `#include "Pianoid_internal.cuh"`. No methods move yet. | `--heavy --release` build; full system test (`/test-ui` audio_off — synthesis output must be bit-identical, this phase changes only preprocessing). | Establishes the shared preamble all later phases depend on. Isolating it first means every subsequent phase is a pure method-move. |
| **1** | Extract `Pianoid_playback.cu` (section P — 3 methods, smallest, leaf). | Build; `/test-ui` offline-render path. | Smallest, lowest-risk move — proves the file-split mechanics and the include structure before touching anything load-bearing. |
| **2** | Extract `Pianoid_debug.cu` (section G — D2H extraction). | Build; debug-variant build (`--both`); chart-function smoke test. | Read-only D2H methods, no synthesis-path coupling. Touches `PIANOID_DEBUG_DATA` guards — good to isolate early so the debug-variant build is exercised. |
| **3** | Extract `Pianoid_presets.cu` (section O). | Build; preset-switch system test. | Self-contained delegation to `memory_manager_`. |
| **4** | Extract `Pianoid_excitation.cu` (section I). | Build; single-note + chord `/test-ui`. | Excitation staging; consumed by synthesis (phase 5) — must exist before phase 5 cleanly references it, though member calls would resolve regardless. |
| **5** | Extract `Pianoid_parameters.cu` (sections E, F). | Build; parameter-edit `/test-ui` (tension/stiffness audible change). | Largest single group (~640 LOC). Isolated late so earlier phases shrink `Pianoid.cu` first, making the diff reviewable. |
| **6** | Extract `Pianoid_synthesis.cu` (sections J, K) — define `g_profiling_cycle_counter` here, declare `extern` in `Pianoid_internal.cuh`. | Build; full playback `/test-ui`; profiling-data smoke test. | The synthesis cycle is the hottest path — moved as a unit, verified hard. |
| **7** | Extract `Pianoid_audio.cu` (sections L, M, N) + the audio-driver lifecycle methods from H. `g_profiling_cycle_counter` referenced via `extern`. | Build; live audio `/diagnose` (sound reaches output); mic Phase 7 if available. | Last and largest of the remaining; completes the split. After this, `Pianoid.cu` is sections B+C+D + statics only (~720 LOC). |
| **8** | Final pass: per-file `using`-namespace cleanup, confirm each file's include list is minimal, update docs. | Build; full regression `/test-ui` + `/diagnose`. | Cosmetic + doc sync; no behaviour change. |

**Rollback:** every phase is an isolated commit on a feature branch. If a
phase fails the build-green check, revert that single commit — earlier phases
remain valid. Because phases are leaf-first, a failure never strands a
half-migrated dependency.

### Documentation updates (phase 8)

- `docs/modules/pianoid-cuda/OVERVIEW.md` — update the "Pianoid (facade)"
  box and the file references to list the new `.cu` files.
- Each module doc that currently cites `Pianoid.cu:<line>` for a method
  (`SYNTHESIS_ENGINE.md`, `PLAYBACK_SYSTEM.md`, `PARAMETER_SYSTEM.md`,
  `AUDIO_DRIVERS.md`, `MEMORY_MANAGEMENT.md`, `DEBUG_DATA.md`, `LOGGING.md`)
  — repoint file references to the new home file. Line numbers in those docs
  are already approximate; the file name is the load-bearing part.
- No new doc page is needed — the split *matches* the existing page
  structure rather than adding a concept.

---

## 7. Why This Shape (Alternatives Considered)

| Alternative | Verdict |
|---|---|
| **PIMPL / `PianoidImpl`** | Rejected. Adds an indirection layer and a second class for zero benefit — the problem is file size, not compile-time coupling of the header. `Pianoid.cuh` is already only 758 lines and changes rarely. |
| **Extract sub-objects** (e.g. a `PianoidAudio` class owning the audio path) | Rejected for *this* proposal. It is a deeper architectural change with real risk (state ownership, `this`-pointer threading, pybind11 surface). The file-size problem is solved by the member-function partition without it. A sub-object refactor could be a *separate, later* proposal once the file split has de-risked navigation. |
| **Split into 2–3 large files** | Rejected. Still leaves 1000+ LOC files; doesn't map cleanly to the doc pages. The 8-file shape gives a clean one-file-per-concern mapping with no file over ~720 LOC. |
| **Split into 12+ tiny files** (one per section banner) | Rejected. Sections C, F, N, P are too small to stand alone (~30–60 LOC); folding them into the cohesive sibling (C/D, F→parameters, N→audio, P standalone only because it pulls distinct playback-engine headers) avoids file-count sprawl. |
| **Keep as-is** | Rejected. 2988 LOC in one file is a navigation and merge-conflict hazard; it is the file most likely to collide when multiple `/dev` agents touch the engine. The split also makes incremental builds materially faster. |

---

## 8. Deliverable Summary (for team-lead)

- **Proposed split shape:** keep the single `Pianoid` class + single
  `Pianoid.cuh` header; partition the *implementation* by member-function
  responsibility group across multiple `.cu` files.
- **New-file count:** **8 files total** — 7 new (`Pianoid_internal.cuh`
  header + 6 new `.cu`: `_parameters`, `_presets`, `_excitation`,
  `_synthesis`, `_audio`, `_debug`, `_playback` … i.e. 6 `.cu` + 1 `.cuh`),
  plus the slimmed `Pianoid.cu`. Largest file falls from 2988 → ~720 LOC.

  *(Count detail: 1 new internal header + 6 new `.cu` = 7 new files; `Pianoid.cu`
  stays. `Pianoid_playback.cu` is one of the 6.)*
- **Migration phasing:** 9 phases (0–8), leaf-first — shared header first,
  then smallest/most-isolated files, synthesis and audio (hot paths) last.
  Each phase is one commit, independently build-green, verified with a
  `--heavy` build + the appropriate `/test-ui`/`/diagnose` surface.
- **CUDA risk:** very low. `Pianoid.cu` is host-only (no `__global__`/
  `__device__` code) — no relocatable-device-code or cross-TU kernel-linkage
  concern. `setup.py` auto-globs `*.cu`, so **no build-system edit is
  needed**. The only genuine new cross-file linkage is one file-static atomic
  (`g_profiling_cycle_counter`), trivially handled with `extern`.
- **Execution:** this is planning only. The split itself is a future
  `--heavy` CUDA `/dev` task that would follow the phase plan in §6.
