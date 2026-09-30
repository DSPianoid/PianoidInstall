# Session log — Sound-channel calibration grounding (READ-ONLY)

**Date:** 2026-07-10
**Task:** READ-ONLY grounding pass for proposed "output sound-channel calibration" (ModalAdapter). No edits/build/render/capture/commit.
**Deliverable:** `docs/development/reviews/sound-channel-calibration-grounding-2026-07-10.md`

## Method
- Docs-first: read `docs/index.md`, `PROJECT_CONFIG.md`, `SYNTHESIS_ENGINE.md` (personally).
- 4 parallel general-purpose research agents: (A) matrix taxonomy/data-model, (B) calibrate_output_scale + coeff writers + facade dir, (C) emit-and-measure machinery + RoomResponse clone + page-fault, (D) prior art + campaign fit + module home/REST/FE.
- Personally verified the highest-stakes fact: `pianoid_types.h` (`real=float`, no complex) and `SoundChannels.py` (real per-(pitch,channel) stores; dead `[channel][mode]` class).

## Key findings
1. Object to calibrate = `string_coefficients` / `string_sound_channels`, `[pitch][channel]`, real gain, effective rows = output pitches 128+; DORMANT (no FE writer). No `[mode][channel]` matrix exists in the GPU path.
2. **PHASE: NO.** Coefficients are `real`(=float) scalars. Sign (±180°) expressible; continuous phase is NOT. Carrying phase = coordinated change to preset schema + middleware + CUDA kernel = FOUNDATIONS-level.
3. Coeffs FFT-measured (`feedin_extractor.py`) then written RAW per-mode-summed (`preset_injector.py`); prescribed per-mode 0–1 normalization is ABSENT — consistent with "not balanced properly."
4. Drive-RMS = offline/free (signal property); acoustic loudness = unavoidable live-mic. Emit+multichannel-record primitive EXISTS (`sdl_audio_core`, `recorder.py`) but single mono drive, no phase; optimizer is NEW.
5. 0xC0000006 page-fault (`calibrate_output_scale`→`runOfflinePlayback`) real + UNGUARDED on master (analytic fix only on feature branch `1cb52fb`); does NOT block this feature (RMS needs no render, mic path doesn't call runOfflinePlayback).
6. SEPARATE effort from `modaladapter.md` capture campaign (fences off apply seam). Home = new service module composing measurement + preset_injector; REST `/modal/calibrate_sound_channels` (role==main); FE host `SoundChannelsPane` (currently 5000-only → cross-layer seam to design).

## Correction handled mid-task
Operator: objective is min total **RMS** (not "error mass"). Sharpened phase (b) and surface-split (d/e) items accordingly. No algorithm/objective designed (proposal's job).

## Follow-up (coordinator "which object does his sentence mean?")
Settled from source+docs+MEASURED preset reads (no guessing):
- `mode_sound_channels` (`coefficients`) and `string_coefficients` are BOTH `{pitch:[num_channels]}` = `[pitch][channel]` (DATA_FLOWS §2.4, basic OVERVIEW, SoundChannels.py). NEITHER is `[mode][channel]`.
- The UI strings-axis Sound-Channels matrix IS `{output_channel:[coeff_per_mode]}` = `[output-channel][mode]` = deck-feedback rows of output pitches (useSoundChannels.js:16-19,149) — the literal match for his phrase, LIVE only in strings mode.
- MEASURED: ALL presets (default BaselinePreset1 + every Belarus variant) run `listen_to_modes=True` (MODES mode) → live store is `mode_sound_channels.coefficients` `[pitch][channel]`, NOT the strings-axis matrix. num_channels=4 (settles 4-vs-5; REST_API's 5 is stale). num_strings=224, num_modes=196.
- Kernels.cu:249-256: modes-mode output channel = mode index (`mode_channel_num=modeNo-modeChannelIndex+1`); strings-mode channel = outer_sound.
- feedin_extractor `per_channel` IS `[channel][mode]` at measure time but summed over modes (sum axis=1) before storage → per-(channel,mode) structure discarded (plausible "not balanced" root).
- Phase answer holds for ALL candidates (real=float, real numpy, real MAC; sign only).
- DOC TENSION flagged (unresolved, not guessed): SYNTHESIS_ENGINE "Audio Output" describes Belarus via strings-mode path, contradicting measured listen_to_modes=True.
- Corrected artefact §(a) + exec-summary + added operator-facing disambiguation paragraph + §(g) Q0.

## Constraints honored
READ-ONLY throughout; did not edit `docs/proposals/modaladapter.md`; RoomResponse read-only; no stack/device/render.
