# Session Log: dev-volume-iter-fix — 2026-04-23

Agent: `dev-volume-iter-fix`
Task: Root-cause fix for peak ∝ string_iteration volume bug in Pianoid synthesis output.
**Outcome (final)**: Bug fixed. Primary iter-variant peak eliminated via coeff_force dt² fix (Kernels.cu:155) + preset rescale (×3.83e8). Ratio iter=12/iter=4 went from 3.07× to 1.011×. Secondary iter-dependence in spectrum/HF/decay flagged as separate follow-up. See [VOLUME_ITER_BUG_INVESTIGATION.md](../VOLUME_ITER_BUG_INVESTIGATION.md) for the full writeup.

## Chronology

### Phase 1 — Baseline measurement
- Captured iter=4/8/12 N=3 via `D:/tmp/volume_iter_probe.py` (Belarus_8band_196modes, pitch=60 vel=63, offline render).
- Result: peak ∝ iter, ratio iter=12/iter=4 = 3.07× confirms prior Phase 1 audit.
- Data: `D:/tmp/volume_iter_baseline.json`, `.log`.

### Phase 2 — coeff_force dt² hypothesis (FALSIFIED)
- Per prior audit, applied fix to `Kernels.cu:155`: `hammer_force = dec_inv * hammer[...] / (iterPerMs * iterPerMs * 1e6)`.
- Rebuilt via `pip install --force-reinstall --no-deps`.
- Result: output byte-identical to baseline. Sabotage had no effect.
- **Note**: at this stage we attributed this to "coeff_force not being the iter-scaling source" and pivoted. In retrospect, this was the FIRST sign the build pipeline wasn't picking up edits, but we didn't recognize it yet.

### Phase 3 — Isolation probe (REAL DATA, stale binary basis)
- Built layered probe `D:/tmp/volume_iter_isolation.py`. Measured bridge_force, applied_force, mode_force, mode_state at iter=4/8/12 via `getSoundRecords()`.
- Discovered: intermediate quantities scale EXACTLY as iter² (4.0× at 8/4, 9.0× at 12/4). Output audio scales as iter¹ (2.0×, 3.0×).
- Hypothesis: `force_on_bridge_summed` lacks /soundStep division that Python reference (`StringState.py:237`) has; `/soundStep` downstream at MainKernel.cu:589 converts iter² → iter¹.
- Data: `D:/tmp/volume_iter_isolation.json`, `.log`.
- **Status of this finding**: likely REAL because measured against baseline. The iter² scaling at bridge layer is genuine architecture of the stale binary.

### Phase 4 — Python-matching /soundStep fix (FALSIFIED AS ENFORCED)
- Applied dual fix: add `/soundStep` at line 565, remove `/soundStep` at line 589.
- Rebuilt debug variant. Output byte-identical to baseline.
- **Second sign of build pipeline issue, not recognized at time.**

### Phase 5 — DLL trap discovery + Test B (valid)
- Found: `PIANOID_BUILD_VARIANT=debug` rebuilds SKIP DLL copy (setup.py:416-419). If release DLLs are removed, debug pyd silently fails to import, `select_cuda_variant` falls back to release silently, probe runs against whatever stale binary is available.
- Fixed by rebuilding release variant (copies DLLs).
- Memory entry saved: `feedback_debug_variant_dll_trap.md`.
- Test B (read-only pybind dump) results:
  - `outerSoundChannel` is 0 for most strings.
  - Strings 220-223 (sound pitches 128-131): channel = 4, 3, 2, 1 respectively.
  - Only 2 isStem points per sound string → 8 stem writes total per cycle.

### Phase 6 — Sabotage tests (UNRELIABLE due to build pipeline)
After the DLL trap fix, ran sabotage tests with release variant (use_debug_build=0). All produced byte-identical audio. List:
- Test 1: `soundFloat[sampleIndex] = 0.0f` at line 493.
- Test 1b: `soundFloat[sampleIndex] = 0.5f` at line 493.
- Test 1c: Both line 493 AND line 628 zeroed.
- Test 1d: Both soundInt AND soundFloat zeroed at line 492-493.
- Test 1e: Added `printf("SABOTAGE FIRED...")` inside the branch — **zero printf output** despite Test B confirming the branch parameters exist.
- Option B: `cudaMemset(dev_soundFloat, 0)` before kernel launch in Pianoid.cu — output unchanged.
- Option B+: Added `cudaMemset` before AND after kernel, plus `std::fprintf(stderr, "SABOTAGE PRE-KERNEL...")` — no stderr output.
- `std::fprintf(stderr, "RUNSYNTHESIS-ENTRY...")` at function entry of `runSynthesisKernel` — **no stderr output at all during render**.

### Phase 7 — Build pipeline smoking gun
- Verified source with grep: string IS in Pianoid.cu.
- Verified obj with `grep -a "RUNSYNTHESIS-ENTRY" Pianoid.obj`: ✓ present.
- Verified installed pyd with `grep -a "RUNSYNTHESIS-ENTRY" pianoidCuda.cp312-win_amd64.pyd`: **✗ 0 matches**.
- pyd size consistently 1228288 bytes across multiple `--no-cache-dir --force-reinstall` rebuilds.
- **Conclusion: nvcc produces fresh .obj files, but the linker/wheel step produces an unchanged pyd.** No edit has reached the running binary this session.

## Falsified hypotheses (evidence invalidated by build pipeline)

The following hypotheses APPEARED to be falsified (sabotage had no effect) but the evidence is UNRELIABLE because the sabotage code never ran:

- H1: coeff_force missing dt² factor (Kernels.cu:155)
- H2: bridge_force sum missing /iter (MainKernel.cu:565)
- H3: Mode-channel write path (MainKernel.cu:628)
- H4: outerSoundChannel branch writes (MainKernel.cu:493)
- H5: dev_soundFloat stale data from prior renders

Each of these needs **re-testing once the build pipeline is fixed**.

## Confirmed findings (independent of build issue)

These stand because they're based on reads/measurements of the stable baseline binary:

- **Symptom**: peak ∝ iter, R²=0.9999. iter=4 → 0.0326; iter=8 → 0.0666; iter=12 → 0.100.
- **Intermediate quantities scale iter²**: bridge_force, applied_force, mode_force, mode_state (measured via sound_records tape).
- **Audio writes at MainKernel.cu:482-493 are gated on `outerSoundChannel`**: only pitch-128..131 sound strings (IDs 220-223) have non-zero channel; only their isStem threads reach the write.
- **Python reference (StringState.py:237) divides `force_accum` by `string_iteration` after substep loop**; GPU does not.
- **`physics.hammer`** in presets is a shape dict (width/position/etc), not an amplitude. Amplitude comes from `excitation.levels_matrix[:, 2, :]` (Gauss volume parameter).
- **DLL copy trap in setup.py:416-419**: debug variant skips DLL copy; if release is absent, debug silently falls back to release, which may itself be absent or stale.

## Build pipeline artifacts

The true fix for this session was never delivered because of the pipeline bug. Artifacts:
- Every `pip install --force-reinstall --no-deps pianoid_cuda/` output says "Successfully installed".
- `nvcc` runs for all .cu files and produces fresh .obj files.
- Final pyd has a mtime from the install but size is static and content matches a pre-session version.
- Suspected cause: wheel caching in pip-ephem-wheel-cache, or setup.py link step not reassembling.

## Data preserved

- `D:/tmp/volume_iter_baseline.json` — iter=4/8/12 N=3 peak/RMS baseline
- `D:/tmp/volume_iter_isolation.json` — layered iter² ratio table across bridge/mode/audio
- `D:/tmp/volume_iter_release.json` — release-variant smoke shots (all equivalent to baseline)
- `D:/tmp/volume_iter_postfix_unrescaled.json`, `volume_iter_isolation_postfix.json` — "post-fix" measurements (all identical to baseline because fix never landed)
- `D:/tmp/volume_iter_probe.py` — main probe script (debug variant, full Phase 1 battery)
- `D:/tmp/volume_iter_isolation.py` — layered probe via sound_records
- `D:/tmp/volume_iter_release_probe.py` — release-variant smoke probe
- `D:/tmp/volume_iter_test_b.py` — parameters dump (outerSoundChannel per point)

## Next steps

1. ~~**Fix build pipeline first.**~~ DONE. `.bat --heavy --release` works; `pip install` silently returns stale pyd. Memory entry saved (`feedback_pip_install_stale_pyd.md`).
2. ~~**Re-test hypotheses with a trustworthy build**~~ DONE. H1 dt² fix confirmed. H2 not needed. H3/H4 falsified (they are real paths, not dead code).
3. ~~**Produce final investigation doc**~~ DONE at `docs/development/VOLUME_ITER_BUG_INVESTIGATION.md`.

## Final resolution

- Kernels.cu:155 dt² fix applied.
- 16 preset JSONs rescaled by 3.830e8.
- Two commits on `feature/fix-volume-iter-bug` in PianoidCore.
- Investigation doc + WORK_IN_PROGRESS update + session-log update in PianoidInstall.
- Lock on Kernels.cu / presets released.

## Open follow-ups (for future tasks)

1. **Secondary iter-dependence in spectrum/HF/decay** — HF increases 25dB from iter=4 to iter=12, centroid doubles, decay rates vary. Likely `coeff_frequency_decay` (Kernels.cu:139). Out of scope.
2. **pip install stale pyd** — structural bug in setup.py / pip build isolation. Workaround documented; proper fix would require build-system rework.

## Links

- Memory: `feedback_debug_variant_dll_trap.md`
- Memory: `feedback_multi_run_for_regression_claims.md`
- Team-lead directive chain: orchestrator relayed many times throughout session.
