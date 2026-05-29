# Module Review: Pianoid.cu God-Object Split (dev-cbd5)

**Date:** 2026-05-19
**Level:** MODULE
**Reviewer:** review sub-agent (read-only on source; this report is the only file written)
**Scope:** `PianoidCore` branch `feature/pianoid-cu-split` (7 commits `c5a8b40..cdb9f4a`, phases 0-6;
branched off `dev` @ `1369ca2`, NOT merged) + `PianoidInstall` master doc-sync commit `c1be045`
(phase 8).
**Spec:** `docs/proposals/pianoid-cu-split-proposal-2026-05-19.md` (committed Revision 3).

---

## Verdict

**SAFE TO MERGE to PianoidCore `dev` as-is.** No Critical and no High findings. The §6 split is a
verified **pure move-refactor** — every relocated function body is byte-identical to its `dev`
original; the only content differences across the entire change are mechanical (include guards,
the documented `g_profiling_cycle_counter` extern/definition split, per-file include preamble,
banner comments, and `using namespace` directives). The 6 extracted modules honour the proposal's
module-substance criteria and section-to-module mapping exactly. The one new cross-TU linkage is
sound. Findings are 2 Low (documentation-accuracy in the doc-sync commit) and 1 informational.

> **One scope clarification.** The task brief said "8 per-phase commits c5a8b40..cdb9f4a (phases
> 0-8)". The branch actually carries **7** commits (phases 0-6). This is consistent with the
> agent-reported deviations: phase 7 produced no commit (its action was conditional — section P
> shims were already co-sited), and phase 8 is the docs-only commit `c1be045` on PianoidInstall.
> So the work is 7 PianoidCore commits + 1 PianoidInstall doc commit = 8 total. Correct and benign.

---

## Top 5 Files in Scope by LOC

| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | `PianoidCore/pianoid_cuda/Pianoid.cu` | 1041 | **RED** (was 2988; barely over the 1000 line — see below) |
| 2 | `PianoidCore/pianoid_cuda/Pianoid.cuh` | 758 | YELLOW (unchanged — header invariant; pre-existing debt, not this change) |
| 3 | `PianoidCore/pianoid_cuda/Pianoid_parameters.cu` | 667 | YELLOW (new — cohesive single concern; acceptable per C4) |
| 4 | `PianoidCore/pianoid_cuda/Pianoid_synthesis.cu` | 622 | YELLOW (new — cohesive single concern; acceptable per C4) |
| 5 | `PianoidCore/pianoid_cuda/Pianoid_excitation.cu` | 225 | — |

Other new files: `Pianoid_debug.cu` 216, `Pianoid_presets.cu` 162, `Pianoid_internal.cuh` 151,
`Pianoid_calibration.cu` 127 — all sub-500, no size finding.

**`Pianoid.cu` remains RED (1041 > 1000).** This is **expected, disclosed, and not a regression** —
the file *dropped* from rank 3 (2988 LOC) to rank 15 (1041 LOC), a ~65% reduction. A RED file
reduced toward the threshold is a *win* per C4 ("Reducing a RED file toward the threshold is a win
— note it"). The CODE_QUALITY.md baseline-debt table was updated accordingly (commit `c1be045`),
with an honest note that the file is "barely over the RED line" and drops below 1000 after the
deferred Phase R relocates the ~10 audio-driver wrappers. The two new YELLOW files
(`_parameters` 667, `_synthesis` 622) were correctly added to the YELLOW table; the four sub-500
new files were correctly omitted. The RED-list update is **accurate and honest**.

---

## Architectural Consistency

**Layer audit: PASS.** All 8 changed files are within `PianoidCore/pianoid_cuda/` — the CUDA
engine layer. No layer boundary is crossed. The `Pianoid` class stays one class with one
unchanged public header (`Pianoid.cuh` — verified byte-identical to `dev` ignoring CRLF;
`git diff --numstat` reports zero changes). The pybind11 binding surface is therefore untouched,
exactly as the proposal's "split by member-function group, not by class" design requires. No
middleware or frontend file was touched.

**Server audit: N/A** — CUDA-engine-only change; no backend-server (5000/5001) code involved.

**Module-boundary audit: PASS.** Each of the 6 extracted modules' contents was verified
function-by-function against the proposal's section-to-module mapping (§7.2). Every function
landed in the correct module — see "Internal Consistency" below. No function is misplaced.

---

## Authority Violations (P1)

**None.** The split is authority-preserving by construction (it relocates code, does not rewrite
it). The proposal's two identified shared-touch flags were re-verified against the actual branch
code:

| State | Documented owner/interface | Verified | Notes |
|-------|---------------------------|----------|-------|
| `new_notes_ind` | kernel-trigger mailbox; raised by multiple producers, drained by `runSynthesisKernel` | **10 writes in `dev`, 10 writes on branch — exact parity.** No write added or removed. | The mailbox pattern is intact. The producer *count* the docs cite is incomplete — see Low finding L1. Code is unchanged. |
| `shouldContinueLoop_` | written via `begin/endMainLoop()` setters; "nothing writes the raw atomic directly" | Raw `.store(false)` write exists in `Pianoid::shutdownGpu()` (`Pianoid.cu:718`) — **pre-existing in `dev` (orig line 1654), moved verbatim.** | Code is unchanged; the doc claim overstates — see Low finding L2. |

Neither flag's *write authority* changed. The refactor introduced no new writer of any state.

---

## Concern Violations (P2)

**None.** This change is, at root, a P2 *remediation*: it splits a 2988-LOC grab-bag (RED rank 3)
into 6 single-concern modules + a slimmed lifecycle/core file. Each extracted module has a clear
one-sentence concern and one reason to change:

| Module | Single concern | Cohesion verdict |
|--------|----------------|------------------|
| `Pianoid_presets.cu` | preset-library policy (load/switch/save/unload/list + update-policy) | Cohesive — all 10 methods serve the named-preset library |
| `Pianoid_parameters.cu` | live parameter-update authority (bulk + granular + volume + `getStringIndicesForPitch`) | Cohesive — one reason to change: the parameter-update protocol |
| `Pianoid_excitation.cu` | excitation staging (begin/add/commit envelope + mode excitation + `_*` internals) | Cohesive — one reason to change: the batch-excitation protocol |
| `Pianoid_synthesis.cu` | synthesis cycle (`runCycle`/`runSynthesisKernel` + cycle audio-output stage) | Cohesive — kernel-launch sequencing + the cycle's output stage |
| `Pianoid_calibration.cu` | semi-offline calibration mode (engine-loop/audio-driver decoupling + reference capture) | Cohesive — the 8 `(c)` functions of proposal §4.2, one workflow |
| `Pianoid_debug.cu` | GPU state extraction (D2H copies) | Cohesive — 8 `get*`/`fetch*`/`clear*` D2H functions |
| `Pianoid.cu` (slimmed) | `Pianoid` object lifecycle + GPU-memory lifecycle + facade-exposure shims | Cohesive for a facade core; the ~10 audio wrappers it still holds are Phase-R deferred |

`Pianoid_internal.cuh` is correctly *not* a module — it is a shared TU preamble (macros, the
`PIANOID_ENABLE_PROFILING` define, the `extern g_profiling_cycle_counter` declaration, the common
include block). Its own banner comment states this explicitly.

---

## Patch / Workaround Findings

**TODO/FIXME/HACK/XXX count in scope: 0.** None of the 8 Pianoid split files contains a
TODO/FIXME/HACK/XXX marker. No silent exception handler, no sleep-based synchronization, no
legacy shim was introduced — the change relocates existing code verbatim and adds only mechanical
preamble. Nothing to report.

---

## Internal Consistency (per the 6 KEY REVIEW QUESTIONS)

### 1. Pure move-refactor integrity — VERIFIED PURE

This is the single most important check and it **passes decisively**.

**Method.** (a) Extracted every `Pianoid::` symbol reference from `dev`'s `Pianoid.cu` and from the
concatenation of all 7 branch `.cu` files — **116 symbols in `dev`, 116 on the branch, zero added,
zero lost.** (b) Concatenated all 8 branch files and ran a sorted-line content diff against `dev`'s
original `Pianoid.cu`. (c) Byte-diffed 5 individual function bodies spanning 4 different modules.

**Result of the sorted-line content diff** (the exhaustive test — 262 differing lines, *every one*
classified):

| Difference category | Count | Verdict |
|---------------------|-------|---------|
| Blank lines (per-file banner spacing) | ~24 | mechanical |
| `#include "Pianoid_internal.cuh"` (one per new file) | 7 | mechanical preamble |
| Include-guard machinery (`#ifndef PIANOID_INTERNAL_CUH_INCLUDED`, `#define`, `#endif`, `#ifndef CUDA_LAUNCH`…) | ~9 | mechanical |
| Extra includes per proposal §7.6 (`MicAnalyzer.h`, `<algorithm>`, `<cmath>`) | 3 | justified — `_calibration` needs MicAnalyzer, `_debug`/`_parameters` use std algorithms/cmath |
| Banner / cross-reference comment lines | ~210 | mechanical — descriptive comments naming sibling modules |
| `extern std::atomic<int> g_profiling_cycle_counter;` (added in `Pianoid_internal.cuh`) | 1 | the documented §7.5 cross-TU split |
| `static std::atomic<int> ...{0}` → `std::atomic<int> ...{0}` (the `static` correctly dropped) | 1 | the documented §7.5 cross-TU split |
| `using namespace std;` (one per new module file) | 6 | mechanical preamble |

**There are ZERO modified function-body lines.** Every single difference is a comment, blank line,
include directive, include-guard line, `using` directive, or the documented profiling-counter
linkage change. Function-body spot-checks confirm this independently:

| Function | Module | Body diff vs `dev` |
|----------|--------|--------------------|
| `runSynthesisKernel` (156 lines — the hot path) | `Pianoid_synthesis.cu` | **byte-identical** |
| `pushCycleAudioToDriver` (218 lines) | `Pianoid_synthesis.cu` | **byte-identical** |
| `loadPresetToLibrary` (80 lines) | `Pianoid_presets.cu` | **byte-identical** |
| `updateSingleStringParameter_NEW` (69 lines) | `Pianoid_parameters.cu` | **byte-identical** |
| `commitStringBatch` (23 lines) | `Pianoid_excitation.cu` | **byte-identical** |
| `_add_string_for_playback` (10 lines — a section-H `_*` internal) | `Pianoid_excitation.cu` | **byte-identical** |

**Conclusion: the §6 split alters no behavior.** It is a genuine pure move-refactor. No
Critical/High finding here.

### 2. Module boundaries — VERIFIED CORRECT

Every function landed in the module the proposal §7.2 assigned it to. Verified by extracting the
`Pianoid::` definition list per file:

- `Pianoid_presets.cu` (section O): `loadPresetToLibrary`, `switchPreset`, `saveActiveToLibrary`,
  `unloadPresetFromLibrary`, `getLibraryPresets`, `getActivePreset`, `setUpdatePolicy`,
  `getUpdatePolicy`, `isParameterUpdateInProgress`, `waitForParameterUpdate` — matches.
- `Pianoid_debug.cu` (section G): `getPianoidState`, `getModeDisplacements`, `getRawSoundRecord`,
  `getSoundRecords`, `getOutputData`, `getParameters`, `fetchExcitation`, `clearRecords` — matches.
- `Pianoid_calibration.cu` (section M cluster): the exact 8 `(c)` functions —
  `stopEngineKeepAudio`, `executeSingleMeasurementCycle`, `restartOnlineEngine`,
  `analyzeCapturedAudio`, `analyzeCapturedAudioWithReference`, `startSynthesisCapture`,
  `stopSynthesisCapture`, `getSynthesisCaptureBuffer` — matches §4.2 exactly. No mic/sinewave
  wrapper leaked into the calibration module.
- `Pianoid_excitation.cu` (section I + the `_*` internals from mid-section-H): `beginStringBatch`,
  `addStringToBatch`, `commitStringBatch`, `addOneString`, `addModeExcitation`, `exciteMode`,
  `_add_string_for_playback`, `_append_string_gp`, `_exciteSingleMode`, `_load_exct_params_to_GPU`
  — matches, including the proposal-prescribed move of the section-H `_*` excitation internals.
- `Pianoid_parameters.cu` (sections E + F): bulk/granular updates, volume calc, and the section-F
  `getStringIndicesForPitch` read helper — matches.
- `Pianoid_synthesis.cu` (sections J + K + L-output): `runCycle`, `runSynthesisKernel`,
  `setCycleIterations`, `getCycleIterations`, `getCurrentCycleAudio`, `processSustain`,
  `midiPlayerSwitch`, the time-record helpers, and the section-L output trio
  `pushCycleAudioToDriver` / `appendCycleAudioToHostBuffer` / `setChannelForSDL` — matches §4.1.
- `Pianoid.cu` (slimmed — sections B/C/D/H-lifecycle/N-profiling/P): ctor/dtor, the buffer-accessor
  delegators, `devMemoryInit`/`set_filter`/`switch_filter`/`initParameters`, the GPU/app/audio
  lifecycle (`freeCudaMemory`/`shutdownGpu`/`startApplication`/`stopApplication`/`startAudioDriver`/
  `stopAudioDriver`), the profiling-control shims, and the section-P offline-playback shims
  (`runOfflinePlayback`/`exportAudioToWav`/`getRecordedAudio`) — matches. Both static-member
  definitions (`Pianoid::instance`, `Pianoid::testModeEnabled`) are co-located in `Pianoid.cu` as
  proposal §7.5 prescribes.

### 3. Build / link integrity — SOUND

The one new cross-TU linkage (`g_profiling_cycle_counter`) was audited exhaustively. All
references across the `pianoid_cuda` directory:

- **Exactly one definition:** `Pianoid_synthesis.cu:30` — `std::atomic<int> g_profiling_cycle_counter{0};`
  (the `static` keyword correctly removed so the symbol has external linkage). This is the TU that
  increments it (`Pianoid_synthesis.cu:312`, inside `runSynthesisKernel`) — owner-by-incrementer
  per §7.5.
- **Exactly one extern declaration:** `Pianoid_internal.cuh:55` — `extern std::atomic<int> g_profiling_cycle_counter;`
- **Two uses:** the increment in `Pianoid_synthesis.cu:312` (same TU as the definition), and the
  reset in `Pianoid.cu:963` (`Pianoid::resetProfiling`, resolved via the extern).

**No ODR violation, no duplicate definition, no missing definition.** All three sites — extern,
definition, and both uses — are wrapped in matching `#if PIANOID_ENABLE_PROFILING` guards.
`PIANOID_ENABLE_PROFILING` is `#define`d to `1` unconditionally at the top of
`Pianoid_internal.cuh` (before any include), and every implementation `.cu` includes that header
first, so all TUs see the define consistently. The static→external-linkage change is exactly the
documented design. Linkage is correct.

No other symbol was found that should be `extern` but isn't, or that is defined twice. The
`Pianoid` class's member-to-member calls all resolve through the single unchanged `Pianoid.cuh`.
`setup.py` requires no edit — `_discover_sources()` (`setup.py:548-554`) globs `*.cu` from the
directory, so the 7 new `.cu` files compile automatically (verified; `setup.py` is not in the
branch diff). Linux `.sh` build inherits the same auto-glob.

### 4. CODE_QUALITY.md compliance — ACCURATE

Covered under "Top 5 Files by LOC" and "Concern Violations" above. The RED-list update in
`c1be045` is accurate and honest about `Pianoid.cu` remaining RED at 1041. The 6 new modules are
all sub-RED; the two YELLOW ones (`_parameters`, `_synthesis`) are correctly listed in the YELLOW
table. No P1 single-authority concern — state ownership is preserved verbatim (see Authority
Violations). The modules are genuinely cohesive (P2 — see the per-module concern table).

### 5. The 3 agent-reported deviations — ALL VERIFIED BENIGN

| # | Deviation | Verdict |
|---|-----------|---------|
| a | Phase 7 produced no commit | **Benign.** The branch has 7 commits (phases 0-6). Phase 7's action was conditional ("fold dissolved section P shims if not already co-sited"); the section-P shims (`runOfflinePlayback` etc.) were already in `Pianoid.cu` and never extracted, so there was nothing to fold — no commit needed. The "phases 0-8" framing counts phase 7 (a no-op confirmation) and phase 8 (the doc commit `c1be045`). |
| b | `Pianoid.cu` at 1041, not the proposal's ~830 | **Benign.** ~830 is the *post-Phase-R* projection. Phase R (relocating the ~10 thin audio-driver wrappers into the audio-driver subsystem) is explicitly deferred — it is the one API-changing phase and the proposal §9 marks it "deferrable to a separate `/dev` task." All 11 audio wrapper methods (`pauseAudioPlayback`, `resumeAudioPlayback`, `startMicCapture`, `stopMicCapture`, `isMicCapturing`, `setMicDevice`, `listMicDevices`, `playRecordedAudio`, `testSinewave`, `getCallbackStats`, `resetCallbackStats`) were verified to **correctly remain** in `Pianoid.cu`. 1041 is the correct phases-0-6 figure. |
| c | `g_profiling_cycle_counter` definition migrated to `synthesis.cu` in phase 6 | **Benign and correct.** This is precisely proposal §7.5: declare `extern` in `Pianoid_internal.cuh`, define in `Pianoid_synthesis.cu` (the TU that increments it). Verified sound in review question 3 above. |

### 6. Hygiene — CLEAN

- **Header include discipline: correct.** `Pianoid_internal.cuh` carries the common include block
  (`Pianoid.cuh`, `PianoidLogger.h`, `constants.h`, `Kernels.cuh`, `gaussTest.cuh`,
  `MainKernel.cuh`, `FIRFilter.cuh`, `Profiler.h`, `pianoid_types.h`, the CUDA runtime headers, the
  Windows guard block). Files needing extra headers include them directly per §7.6 — `Pianoid.cu`
  pulls `AudioDriverConfig.h`/`ASIOAudioDriver.h`/the Playback headers/`WavWriter.h`/
  `SinewaveGenerator.h`; `Pianoid_calibration.cu` pulls `MicAnalyzer.h`; `_debug` pulls
  `<algorithm>`; `_parameters` pulls `<cmath>`. All justified.
- **`Pianoid_internal.cuh` contents: appropriate.** Include guard present and correct
  (`#ifndef PIANOID_INTERNAL_CUH_INCLUDED`). It carries only the shared preamble; its banner
  explicitly states it is "NOT a module."
- **Include guard correctness: PASS.** The `Pianoid_internal.cuh` guard is well-formed; the
  `CUDA_LAUNCH` / `CUDA_LAUNCH_ASYNC` macros use `#ifndef` guards (harmless redefinition
  protection — though with the file-level include guard they cannot in fact be re-included).
- **`run_cuda_build_tmp.bat`: NOT PRESENT.** The task asked whether this untracked build-helper in
  the PianoidInstall root should be removed at Step 10. It is **not in the working tree** — it was
  already cleaned up (or never committed). The only untracked `.bat` files in the repo are inside
  `.venv/Scripts/` (legacy venv artifacts unrelated to this refactor). No action needed.
- **Clean tree.** `pianoid_cuda/` has no untracked files. The branch diff touches exactly the 8
  intended files and nothing else — no collateral edits to `setup.py`, other `.cu`/`.cpp`, or
  other headers.

---

## Recent Changes Assessment

**Coherent.** The 7 phase commits follow the proposal §9 plan precisely: phase 0 establishes the
shared preamble; phases 1-6 are leaf-first extractions (`_presets` → `_debug` → `_calibration` →
`_excitation` → `_parameters` → `_synthesis`), each commit touching exactly 2 files (`Pianoid.cu`
minus the section + the new module file). Each phase is an isolated, individually-revertible
commit on the feature branch. No commit contradicts or partially reverts another — they all move
in one direction (god-object decomposition). The phase-8 doc-sync commit `c1be045` on
PianoidInstall master correctly describes the phases-0-8 end state and explicitly notes Phase R is
out of scope (so it adds no post-Phase-R claims to AUDIO_DRIVERS.md).

---

## Findings

| # | Principle | Severity | Confidence | File:Line | Description |
|---|-----------|----------|------------|-----------|-------------|
| L1 | D1 (docs match code) | **Low** | 95 | `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` (the `new_notes_ind` paragraph added in `c1be045`) | The new paragraph lists 3 producer modules for `new_notes_ind` (`_excitation` `commitStringBatch`/`addOneString`, `_presets` `switchPreset`, `_synthesis` `processSustain`). Code audit found writes also in `Pianoid_parameters.cu` (`updateSingleStringParameter_NEW:345`, `updateMultiStringParameter_NEW:429`) and `Pianoid.cu` init path (`devMemoryInit:662`, `initParameters:625`). Producer list is non-exhaustive — 5 files write the flag, doc names 3. **No code defect** (write count is 10 in `dev` and 10 on the branch — exact parity; behavior unchanged). The proposal §6.5 itself made the same simplification; the doc inherited it. Recommendation: in a future docs touch, broaden the producer list to "raised by excitation, preset-switch, sustain, granular parameter updates, and the init path" — or qualify it as "the principal producers." Does not block merge. |
| L2 | D1 (docs match code) | **Low** | 90 | `docs/modules/pianoid-cuda/PLAYBACK_SYSTEM.md` (the `shouldContinueLoop_` paragraph added in `c1be045`) | The new paragraph asserts `begin/endMainLoop()` are "the single write-interface for that flag — nothing writes the raw atomic directly." Code audit found a raw `shouldContinueLoop_.store(false)` in `Pianoid::shutdownGpu()` (`Pianoid.cu:718`). This write is **pre-existing in `dev`** (original line 1654) and was moved verbatim — **no code defect, behavior unchanged**. But the doc-sync commit added a claim that overstates: the raw write does exist. Recommendation: in a future docs touch, soften to "`begin/endMainLoop()` are the *intended* write-interface; the only raw write outside them is the idempotent shutdown path in `shutdownGpu()`." Does not block merge. |
| I1 | — | Info | 100 | task brief | The task brief's "8 per-phase commits c5a8b40..cdb9f4a" is off by one — the branch has 7 PianoidCore commits (phases 0-6); phase 7 is a no-op confirmation (no commit) and phase 8 is the PianoidInstall doc commit `c1be045`. Recorded for accuracy; not a defect. |

**No Critical, no High, no Medium findings.** L1 and L2 are documentation-accuracy nits in the
phase-8 doc-sync commit — the *code* is correct in both cases (the divergent writers pre-exist in
`dev` and were moved verbatim). They are worth a one-line fix the next time those doc pages are
edited, but neither is a merge blocker.

---

## Recommendations

1. **Merge `feature/pianoid-cu-split` to PianoidCore `dev`.** The §6 split is a verified pure
   move-refactor with zero behavior change; module boundaries are correct; the one new cross-TU
   linkage is sound; CODE_QUALITY.md is honestly updated.
2. **Before merge, confirm the build was actually run.** This review is static (read-only on
   source — no compile was performed). The proposal §9 mandates a `--heavy --release` build at
   each phase, and the source analysis shows no reason a build would fail (host-only file,
   `setup.py` auto-glob, sound `extern`/definition split). The `/dev` agent's Step-9 build/test
   evidence should be checked in the agent's wrap-up report; if for any reason a clean
   `--heavy --release` build + an `audio_off` `/test-ui` synthesis-output check has not been run on
   the final branch state, run it before merging — that is the proposal's own build-green gate.
3. **Fix L1 + L2 opportunistically.** Next time `SYNTHESIS_ENGINE.md` / `PLAYBACK_SYSTEM.md` are
   touched, broaden the `new_notes_ind` producer list and soften the `shouldContinueLoop_`
   single-write-interface claim to match the actual (pre-existing) code. Not urgent.
4. **Phase R remains correctly deferred.** The ~10 audio-driver wrapper relocation is the one
   API-changing phase; it is appropriately out of scope for this branch and should be its own
   future `/dev` `--heavy` task with a live `/diagnose` (audio + mic) verification, per proposal
   §9 Phase R. After Phase R, `Pianoid.cu` drops below the RED line.

---

## Summary

3 findings: **0 Critical, 0 High, 0 Medium, 2 Low** (+ 1 informational). Overall: **healthy** —
the refactor is a textbook pure move-refactor that decomposes a RED-flagged god object (2988 LOC)
into 6 cohesive single-concern modules + a slimmed core, with no functional change, correct module
boundaries, a sound cross-TU linkage, and an honest CODE_QUALITY.md update. The only findings are
two minor documentation-accuracy overstatements in the phase-8 doc-sync commit, neither of which
reflects a code defect. **Safe to merge to PianoidCore `dev` as-is.**
