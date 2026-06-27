# dev-applyc-arraysize — array_size in-place re-init silent-render: ROOT CAUSE + FIX

Agent: dev-applyc-arraysize (continuation of dev-applyc)
Date: 2026-06-22
Branch: feature/dev-applyc-arraysize (off merged origin/dev 480ead8)
Worktree: D:/repos/wt-applyc-core

## Task
In-place CUDA re-init (`Pianoid.reinitialize_cuda_engine`) rendered SILENT (offline peak=0)
when `array_size` changed (384↔512), while a fresh `initialize(array_size=512)` rendered sound.
Find the root cause, fix, and un-gate array_size to the in-place path.

## Reproduction (confirmed at start)
`dev-applyc-arraysize-minrepro.py`: reconstruct-512 peak=0.000e+00, fresh-512 peak=1.868e+05.

## Diagnosis chain (measurement-first; instrumentation reverted before commit)
1. Packed Python data BYTE-IDENTICAL (stringMap, strings_in_pitches, physical_parameters
   maxdiff 2.78e-17, output_mask). The `blocks` vs `blocks_pitches` StringMap loader divergence
   produces the SAME packed arrays.
2. The string physically vibrates ~identically (state energy 7.8e10 vs fresh 9.3e10) and mode
   displacements are identical (0.524). The physics runs.
3. Host-side kernel instrumentation: `dev_parameters` slot 26 (mode-channel routing) sum=1280,
   identical to fresh; `cycle_params[0]`=512 correct. Routing is correct.
4. The addKernel writes ZERO to `dev_soundFloat` every cycle in recon-512 (sfMax=0) even though
   strings vibrate (strE huge). With `listen_to_modes=True`, output = `s_mode_applied_force`
   (string→mode feedin), which depends on the deck/feedin coupling matrix.
5. The uploaded `dev_deck_parameters` was ~1000× too small in recon (deckSum 2.2e4 vs 2.82e7).
6. `pack_deck_for_cuda()` ITSELF returned the wrong deck after the array_size reinit
   (sum_abs 2.20e4, **max=1.0** = default) — a Python-layer bug, not C++/CUDA.
7. Narrowed to `pack_pitch_feedin()` for the SOUND pitches (128–131) returning sum=0 in recon
   (vs 7.05e6 fresh). The sound-string feedin row = `pitch.deck['feedback'] * sc_gain`, where
   `sc_gain = soundChannelModes.string_coefficients[pitch][channel]`.

## ROOT CAUSE (file:line)
`pianoid_middleware/pianoid.py` `_rebuild_stringmap_for_array_size` rebuilt `self.sm` via
`StringMap(model_params=self.mp, **pack_for_preset_file())` but did NOT re-populate the new
StringMap's `soundChannelModes` coefficients. `SoundChannels.ModeSoundChannels.add_pitch`
(`Pianoid/SoundChannels.py:67-73`) defaults `string_coefficients[pitch] = np.zeros(nc)`.
`pack_for_preset_file()` does NOT serialize `mode_sound_channels` / `string_sound_channels`,
and the fresh `/load_preset` path populates them separately (pianoid.py ~254-266
`read_from_preset` / `read_string_coefficients_from_preset`). So the rebuilt StringMap had
ALL `string_coefficients = 0` → `pack_pitch_feedin` sound-string row collapses to 0 →
the deck/feedin coupling matrix degenerates to ~identity (max 1.0) → with `listen_to_modes`
the mode-channel audio tap reads zero applied-force → SILENT. (The strings still vibrate from
the hammer; only the string→mode→audio coupling is severed.) NOT a C++/CUDA bug.

## THE FIX (pure Python)
`pianoid_middleware/pianoid.py` `_rebuild_stringmap_for_array_size`: capture the per-pitch
`soundChannelModes.coefficients` + `string_coefficients` from the LIVE StringMap BEFORE the
rebuild (they are resolution-independent per-pitch mode/string gains), then RESTORE them onto
the freshly constructed StringMap's `soundChannelModes` after. Only surviving pitches restored;
vectors copied unchanged.

## VERIFICATION
- `pack_deck_for_cuda()` recon-512 == fresh-512 EXACTLY (maxdiff 0.0, sumratio 1.0).
- `dev-applyc-arraysize-minrepro.py`: recon-512 peak=1.868e+05 == fresh-512 peak=1.868e+05,
  **BUG_REPRODUCED=False** (bit-identical sound).
- Isolated round-trip (mirrors the acceptance sequence: load 384 → edit → render A →
  reinit 512+iter8 → render B → reinit back 384+iter4 → render C):
  base-384 peak=4.055e5, A-384 peak=3.166e5, **B-512 peak=2.607e5 (SOUND)**, edit preserved
  (tension_offset=0.5 ✓), **C-384-rt peak=3.166e5 == A-384 EXACTLY** (round-trip reversible).
- Full acceptance test `dev-applyc-inplace-acceptance.py`: A/B/C renders all SOUND, edits
  preserved, "restored 88 sound-channel coeff sets" logged. NOTE: the test's `compare()` step
  uses pandas `Series.autocorr` (`SoundFeatures.soundTone`) on full-length 384k-sample signals,
  which is VERY slow (minutes per comparison) — NOT an engine hang (watchdog stack confirmed the
  process was inside pandas `nancorr`, not the reinit). A numpy-FFT reimplementation of the same
  metrics ran fast:
    - A(384) vs B(512+iter8): freq 987.34→986.71 Hz **MATCH** (same fundamental), rms_ratio 0.748,
      spec_corr 0.45. The test's `ab_ok` (spec_corr>0.9) is FALSE here — but that threshold is
      MIS-CALIBRATED for an array_size change: see the gold-standard proof below.
    - A(384) vs C(384, round-trip 384→512→384): freq 987.34→987.34 Hz EXACT, rms_ratio 0.997,
      wav_corr 0.9947, spec_corr 0.9975 — round-trip is REVERSIBLE + near-exact. `ac_ok`=True.
    - Edits preserved through both reinits (tension_offset=0.5).

### THE CORRECT VERIFICATION SURFACE (gold-standard): recon-512 == fresh-512
  The acceptance test compares 384 vs 512 renders and expects high spec_corr, but a 384↔512
  array_size change LEGITIMATELY alters the timbre (finer dx resolves string stiffness/dispersion
  differently → partials shift), keeping the same fundamental. The correct check is "does the
  in-place reconstruct at 512 sound like a FRESH initialize(512)":
    - **recon-512 vs fresh-512 spec_corr = 0.9953** (≈identical — the fix is correct).
    - GOLD fresh-384 vs fresh-512 spec_corr = 0.3691 (even two FRESH inits differ this much — the
      array_size physics, not a bug).
    - recon-512 vs fresh-384 spec_corr = 0.3695 (matches GOLD exactly).
  VERDICT: the FIX IS VERIFIED CORRECT. The headline acceptance test's spec_corr>0.9 A-vs-B gate
  is too strict for a combined dx(+dt) change; the gold-standard recon==fresh check passes at 0.9953.

## ROUND-TRIP / REPEATED-REINIT NOTE
  3 back-to-back in-process Pianoid reconstructions (the acceptance sequence) ran clean in the
  isolated harness; the original acceptance test's apparent "stall" was the slow pandas autocorr,
  not the engine. (The pre-existing ASIO/SDL3-on-repeated-in-process-construction instability noted
  by dev-37f6 is unrelated to this fix.)

## UN-GATING (array_size → in-place path)
- `pianoid_middleware/preset_reinit.py`: moved `array_size` into `INPLACE_STRUCTURAL_FIELDS`
  (out of the implicit FULL_ONLY set); updated comments.
- `pianoid_middleware/pianoid.py`: added `array_size` to `REINIT_INPLACE_STRUCTURAL`.
- `tests/unit/test_preset_reinit_classify.py`: moved `("array_size", 512)` from the full-only
  parametrize to the in-place parametrize; updated docstring. 28/28 pass.

## BUILD
`build_pianoid_cuda.bat --heavy --release` into the shared venv. NOTE: the build resolves its
venv from `PROJECT_ROOT/.venv` or `.venv-pointer`; the worktree had neither, so it silently
used system Python (`C:\Python312`) and installed there, NOT the venv — set
`PIANOID_VENV_DIR=D:\repos\PianoidInstall\PianoidCore\.venv` before invoking. Also copy the
gitignored `detect_paths.py` into the worktree (the build looks for it in the worktree / parent).

## NOTES
- The fix is Python-only; NO .cu change is required for the bug. (The clean release .pyd was
  rebuilt only to strip diagnostic instrumentation that had been added during the hunt.)
- Diagnostic harnesses + this log left UNCOMMITTED in root PianoidInstall for the merge-sweep.
