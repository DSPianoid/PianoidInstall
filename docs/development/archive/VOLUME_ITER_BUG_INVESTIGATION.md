# Volume-vs-String_Iteration Bug Investigation

**Agent**: `dev-volume-iter-fix`
**Date**: 2026-04-23
**Branch**: `feature/fix-volume-iter-bug` (PianoidCore)
**Outcome**: Primary bug resolved. Secondary iter-dependence in spectrum/decay remains (separate issue, flagged as follow-up).

## Symptom

Audio output peak scaled linearly with `string_iteration` setting. Ratio iter=12/iter=4 = 3.07× (measured, R²=0.9999). Peak at iter=8 baseline = 0.0666; iter=4 = 0.0326; iter=12 = 0.100. Spectrum and envelope also shifted — attack timing invariant but HF content and decay rates iter-dependent.

Baseline data: `/tmp/volume_iter_baseline.json`.

## Root cause

**Kernels.cu:155** — `coeff_force` formula was missing one factor of `dt`.

```cpp
// BEFORE (buggy):
hammer_force = dec_inv * hammer[blockIdx.x * arraySize + i] / iterPerMs;
// where iterPerMs = (sample_rate × string_iteration) / 1000
// → formula expands to dec_inv × hammer × dt¹ × 1000 (dt in ms)

// AFTER (fix):
real dt_sec = 1.0 / (cycle_parameters[7] * cycle_parameters[4]);
hammer_force = dec_inv * hammer[blockIdx.x * arraySize + i] * dt_sec * dt_sec;
// → dec_inv × hammer × dt² (in seconds), matches Python reference
```

**Python reference** (PianoidBasic/Pianoid/Pitch.py:319):
```python
cf = dt**2 * dec_inv
```

**Why it manifested as peak ∝ iter**: the FDTD explicit substep recurrence `y[n+1] = 2y[n] − y[n−1] + F·c` accumulates `iter` substeps per sample. With `coeff_force ∝ 1/iter`, the per-substep contribution is iter-invariant, so the per-sample force integral scales as `iter × 1 = iter`. With correct `coeff_force ∝ dt² ∝ 1/iter²`, per-sample integral is `iter × 1/iter² = 1/iter` — but then the forcing integrates into mode displacement with compensating factors that yield iter-invariant output.

## Fix applied

Two commits on `feature/fix-volume-iter-bug`:

1. **Code fix** — Kernels.cu:155. Single-line formula change to `dt² × dec_inv`.
2. **Preset rescale** — 16 preset JSONs in `PianoidCore/pianoid_middleware/presets/`. `levels_matrix[:, 2, :]` (Gauss volume row) multiplied by 3.830e8 to restore pre-fix iter=8 output magnitude.

### Why the preset rescale was needed

The dt² formula produces output ~3.83×10⁸ times smaller per sample (factor = `iterPerMs × 1e6` at iter=8). Without rescale, audio peak drops from 0.0666 to 1.74×10⁻¹⁰ — effectively silent. Scaling excitation volume by the measured magnitude ratio restores the pre-fix loudness.

## Verification

Post-fix iter=4/8/12 probe (Belarus_8band_196modes, pitch=60 vel=63, N=3, offline):

| iter | peak | vs iter=4 | vs pre-fix 0.0666 |
|---|---|---|---|
| 4 | 0.06501 | 1.000× | −2.3% |
| 6 | 0.06590 | 1.014× | −1.0% |
| 8 | 0.06634 | 1.020× | −0.4% |
| 10 | 0.06620 | 1.018× | −0.6% |
| 12 | 0.06571 | 1.011× | −1.3% |

- **Peak iter=12/iter=4 = 1.011×** (was 3.07×). Well within ±2% acceptance.
- **Peak absolute at iter=8 = 0.0663** vs pre-fix 0.0666. Within −0.4%.
- **Attack iter-invariant**: 3.10 ms across all iter values.

Full verification data: `/tmp/h1_full_phase1_verify.json`, `iter_phase1_final.json`.

## Hypothesis-test arc

This investigation went through multiple rounds of apparent dead-ends before landing on the correct fix. Recording what was tried + why earlier conclusions appeared wrong:

### H1 — coeff_force missing dt² factor (Kernels.cu:155) — CORRECT

Original hypothesis from prior `analyse-distortion` audit. Tested twice: first attempt (Phase 2) appeared to have no effect due to build pipeline bug; second attempt (Phase 8, via .bat --heavy) produced expected factor-3.83×10⁸ magnitude drop, confirming the formula change landed and fixing peak iter-invariance.

### H2 — Bridge-force sum missing /soundStep (MainKernel.cu:565) — NOT NEEDED

Phase 2 layered isolation probe measured bridge_force and mode_state scaling as iter² (ratios 4.0× at iter=8/4, 9.0× at iter=12/4). Hypothesis was that Python reference divides by `string_iteration` after substep loop (StringState.py:237: `force_accum / self.mp.string_iteration`), but GPU didn't. Appeared to need `/soundStep` added at MainKernel.cu:565 and removed at line 589.

**Status**: Did NOT need to be applied. With H1 alone, peak becomes iter-invariant. The iter² scaling at bridge_force is real but cancels out downstream in the mode ODE + feedback aggregation. H2 attempt (Phase 4) appeared to have no effect — then confirmed it wasn't applied due to the build pipeline bug. Re-testing after pipeline fix was skipped because H1 alone sufficed.

### H3 — outerSoundChannel branch is dead code — FALSIFIED

Phase 5 sabotage probe (write 0 to soundFloat at MainKernel.cu:493) appeared to have no effect, leading to the hypothesis that the audio was coming from somewhere else. After fixing build pipeline, the same sabotage DID silence audio — confirming line 482-494 IS the audio path. The "dead code" appearance was a build-pipeline artifact.

### Audio path discovery

Via parameter dump (`/tmp/volume_iter_test_b.py`): only strings 220-223 have non-zero `outerSoundChannel` (values 4, 3, 2, 1). These are the "sound pitches" (128-131 per `outer_sound = max(pitch - 127, 0)` in PianoidBasic/Pitch.py:108). Their 2 stem points per string write audio samples via `sampleIndex = (outerSoundChannel - 1) × samplesInCycle + main_cycle_index` → 8 total writes per cycle → fills `dev_soundFloat[0..255]`.

Audio formula at MainKernel.cu:485-494:
```cpp
if (isStem) {
    real diff_result = feedback - s_b;              // 1st derivative (velocity)
    real output = diff_result;
    if (soundDerivativeOrder == 2) {
        output = diff_result - prev_diff;           // 2nd derivative (acceleration)
        prev_diff = diff_result;
    }
    soundInt[sampleIndex] = Sint32(output * main_volume_coeff);
    soundFloat[sampleIndex] = float(output);
}
```

Where:
- `feedback = s_feedback[stringInArr]` from modes (line 461, via `sumArray(feedback_cycle_matrix)` where feedback_cycle_matrix was accumulated with `mode_feedback × s_mode`).
- `s_b` = previous string displacement at stem point (from FDTD inner substep loop, line 540-541).

## Build pipeline discovery — CRITICAL

Halfway through the investigation, every sabotage test produced byte-identical baseline audio. After extensive verification (binary grep of .obj files showed code was compiled; binary grep of .pyd showed the new strings were NOT in the installed binary), the root cause was:

**`pip install --force-reinstall --no-deps --no-cache-dir pianoid_cuda/` silently returns stale .pyd despite fresh .obj compilation.** The .obj files were correct; the linker/wheel step was caching.

**`./build_pianoid_cuda.bat --heavy --release` works correctly** because it:
1. Does full clean of `pianoid_cuda/build/`.
2. Runs `pip cache purge` explicitly.
3. Uninstalls existing pianoidCuda.
4. Builds fresh from scratch.

This was responsible for multiple apparent-null results across this session. Every "fix had no effect" measurement from before the discovery is invalidated — those fixes were never actually compiled into the running binary.

Memory entry saved: `feedback_pip_install_stale_pyd.md`. Supersedes `feedback_synchronous_cuda_build.md`.

## Secondary issue — open follow-up

Peak is iter-invariant. However secondary metrics DO vary with iter (data from the Phase 1 full battery):

| iter | fund_dB | h3/h1 | HF_dB | centroid_Hz | init_decay_dB/s |
|---|---|---|---|---|---|
| 4 | -66.1 | 0.68 | -108 | 1340 | -56.8 |
| 8 | -62.2 | 0.68 | -89 | 1787 | -61.4 |
| 12 | -67.2 | 0.68 | -83 | 2687 | -63.5 |

- **HF energy increases ~25dB from iter=4 to iter=12**.
- **Centroid doubles**.
- **Initial decay rate varies** from -57 to -64 dB/s.
- **Fundamental amplitude fluctuates ±3dB**.

This is the `coeff_frequency_decay` (Kernels.cu:139) bug flagged by the original directive as "out of scope for this task":
```cpp
// Currently:
real coeff_frequency_decay = frequency_dependent_damping * 1e12 / (2 * dxMm2);
// Missing iter compensation → HF damping strength depends on iter
```

This is a separate fix and should be a new task. User-reported bug (peak ∝ iter) is fully addressed.

## Lessons learned

### 1. `pip install` is unreliable for CUDA extensions on Windows

**Always use `./build_pianoid_cuda.bat --heavy --release`** for code changes. `pip install --force-reinstall --no-cache-dir` silently returns cached pyd.

### 2. Verify rebuild actually landed before measurement

After rebuild, do `grep -a <unique-string> <installed-pyd>` to confirm the new code is in the binary. Size change is another signal but less conclusive. This 60-second check saves hours of wasted investigation.

### 3. Debug variant has a DLL trap

`PIANOID_BUILD_VARIANT=debug` skips DLL copy. Always rebuild release first (or via .bat --both) to ensure cudart/SDL3 DLLs are present.

### 4. Sabotage tests are the ground truth

When dimensional analysis or measurement-based hypotheses conflict, insert a "must-crash-the-output" change (e.g., set the write to 0). If audio is unchanged, your analysis is wrong OR the binary isn't running your code. Both are cheaper to diagnose than a 2-hour analytical deep-dive.

### 5. N≥3 runs for stability claims

All peak measurements here used N=3. The baseline peak varied ±0.001% across runs — enough to distinguish a real 3× bug from noise but not enough to miss a ±1% fix effect.

### 6. Python reference is authoritative for physics

When GPU and Python disagree, Python is correct. This was the pointer that led to H1: `Pitch.py:319` has `cf = dt² × dec_inv`, GPU didn't. Dimensional analysis of the mismatch directly predicted the 3.83×10⁸ scale factor, which was measured to 0.3% precision.

## Falsified paths — future devs do NOT re-investigate these

- **coeff_force missing dt²**: ADDRESSED. Do not revisit.
- **Bridge-force `/soundStep` (H2)**: Not needed. H1 alone is sufficient.
- **Mode ODE scaling**: Correct as-is.
- **Hammer data iter-dependence**: Checked, not iter-dependent.
- **outerSoundChannel branch dead code**: Falsified — it IS the audio path for sound-pitches.

## Open follow-ups (separate tasks)

1. **coeff_frequency_decay iter compensation** (Kernels.cu:139). Causes HF skew and decay-rate variation with iter. Not in scope here.
2. **pip install stale pyd bug** — structural issue in `setup.py` or pip build isolation. Workaround is the .bat script. Proper fix would identify the caching layer and bypass it.
3. **string_sound_channels=40.0 default** — documentation mentions this is a gain coefficient; actual code path treats it as channel index. Worth auditing for semantic consistency.

## Data artifacts

- `/tmp/volume_iter_baseline.json` — pre-fix iter=4/8/12 N=3 measurements.
- `/tmp/volume_iter_isolation.json` — layered probe (bridge_force/mode_state iter² scaling, pre-fix).
- `/tmp/h1_iter_ratio.json` — post-H1-code-fix, pre-rescale iter ratio (1.015× at iter=12/4).
- `/tmp/h1_full_phase1_verify.json` — full Phase 1 battery post-rescale.
- `/tmp/volume_iter_probe.py`, `volume_iter_isolation.py`, `volume_iter_release_probe.py`, `rescale_presets.py` — probe and rescale scripts.

## Cross-references

- Session log: `docs/development/logs/dev-volume-iter-fix-2026-04-23.md`
- Memory: `feedback_pip_install_stale_pyd.md` (new, documents build trap)
- Memory: `feedback_debug_variant_dll_trap.md` (DLL copy trap)
- Python reference: `PianoidBasic/Pianoid/Pitch.py:319` (`cf = dt**2 * dec_inv`)
- Audio path doc: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md#audio-output`
- Architecture doc: `docs/architecture/DATA_FLOWS.md#sound-channel-coefficients`
