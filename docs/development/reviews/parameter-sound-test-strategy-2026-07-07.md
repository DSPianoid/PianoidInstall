# Pianoid Parameter → Sound Test Strategy (2026-07-07)

> Read-only design (no code written). For each editable parameter: its INTENDED effect on the
> synthesized sound + a test that changes it and verifies the sound responds as intended. Regression
> safety-net to build BEFORE the parameter-system refactor (see the companion review
> `parameter-editing-system-review-2026-07-07.md`). Mode: `audio_off` throughout.

## Central idea (solves the isolation problem)
Naive "render full-mix → FFT → read dominant peak" CANNOT isolate most params: in strings mode the
output is emitted from output pitches (128+) driven by the MODES → output spectrum is
mode/soundboard-dominated with a fixed ~750 Hz cycle artifact (a prior 16× tension change did NOT move
the dominant partials); offline render also carries ~2.3% render-to-render RMS noise + a post-load
cold-start transient. **So probe each parameter at the PHYSICAL STAGE where its effect isn't yet
swamped, via always-active GPU extraction APIs — not the final mix.**

| Param role | Right probe |
|---|---|
| String physics (tension, stiffness, damping, length, ρ, r) | per-string **bridge-force / displacement time series** (pre mode-mix) |
| Mode physics (freq, decrement, 1/mass) | **full-mix output spectrum** (output IS the modes) |
| Excitation temporal (μ,σ,vol,shift) | **fetchExcitation** force buffer (always active) |
| Hammer spatial (pos,width,sharp) | **get_hammer_shape** + bridge-force partial pattern |
| feedin | **getModeDisplacements** (which mode lit) |
| feedback / sustain | output sustain-tail + mode-displacement decay (coeff 0 vs high A/B) |
| sound-channel gain | **per-channel RMS** of multichannel render |
| runtime volume | **get_sint_audio** (post-volume) — NOT get_synth_audio (pre-volume) |

## Measurement toolkit + metrics
getRecordedAudio/get_synth_audio (float, pre-volume, multichannel); get_sint_audio (post-volume, the
ONLY volume surface); **fetchExcitation(stringNo,cycleIdx)** (always active); getPianoidState;
**getSoundRecords** BRIDGE_FORCE/MODE_STATE per-string time series (**DEBUG build only** — the key
string-physics surface); getModeDisplacements (q/dec/omega/mass_inv); get_hammer_shape/<pitch>;
GET /get_parameter/stability_ratio/<key> (confirm a string edit is in the CFL accept band first).
Metrics: fundamental (FFT/autocorr/Goertzel), inharmonicity B (fit fₙ=n·f0·√(1+Bn²)), decay τ (exp fit
to Hilbert/RMS envelope), spectral centroid, RMS/peak, attack peak-time, beat freq, per-mode amplitude, ∫force.

## Harness design
`audio_off`; string spectral/decay tier needs the DEBUG variant (PIANOID_USE_DEBUG=1, built
--heavy --both). Per test: load minimal fixture → set param (granular API/REST) → **warm-up render +
discard** (cold-start) → probe → metric → before/after DIFF vs the ~2.3% floor → **reversibility**
assert. Level/RMS claims N≥3. Gate string edits on stability_ratio (a CFL-skipped edit reads as "no
effect"). Fixtures: (1) single-string/single-mode (cleanest isolation); (2) single-pitch multi-unison
(tension_offset beats); (3) Belarus_196modes (integration).

## Per-group summary (param → intended effect/direction → probe)
- **STRINGS** (HARD, debug bridge-force / single-mode): tension↑→f0↑(√T); ρ↑→f0↓; length↑→pitch↓; r↑→inharmonicity B↑(r⁴); stiffness E↑→B↑; damping γ↑→decay τ↓; frequency_damping↑→faster HF decay (⚠ iter-variance); tension_offset↑→beat rate↑ (multi-unison); damper/tail↑→shorter release; **volume_coefficient idx8 = deprecated → assert NO change (regression pin)**.
- **MODES** (EASY, output IS modes): frequency→partial moves; decrement↑→band τ↓; mass_inv↑→louder (reject ≤0); stiffness/damping = derived read-only (assert GET, not settable).
- **EXCITATION temporal** (EASY, fetchExcitation): μ↑→peak later; σ↑→wider+duller (reject ≤0); volume↑→∫force↑ (⚠ loudness double-count); shift↑→narrower (assert vs GPU ReLU, not Python).
- **HAMMER spatial** (HARD): position→comb filter (strike L/n suppresses nth partial); width↑→centroid↓; sharpness→centroid shift.
- **MASS/SPEED/CALIBRATION** (HARD + ground-truth-uncertain): mass↑/speed↑→louder (⚠ known double-count, ±7–11 dB scatter — pin current behavior until normalization fix); calibration c→clean global rescale.
- **FEEDIN/FEEDBACK**: feedin[S,M]→mode M excited, 0→silent (getModeDisplacements); feedback[M,S]→sustain, 0→stems zero; deck_feedback_coeff→resonance (note-audio survives coeff=0 via output mask).
- **SOUND CHANNELS** (data-model TRAP): string_coefficients[128+ch]→per-channel gain; **editing piano rows 0–127 is a NO-OP** (kernel reads only 128+) → regression MUST assert piano-row edit = zero change, output-row edit = change.
- **RUNTIME**: volume↑→level↑ on **get_sint_audio** (TRAP: get_synth_audio is pre-volume, shows nothing); feedback = deck_feedback_coeff.

## Params needing ground-truth measurement BEFORE a directional assertion
1. mass/speed/calibration→loudness: known excitation double-count (±7–11 dB); pin measured behavior until the normalization correction merges.
2. frequency_damping γ_HF: documented iter-variance (~25 dB HF swing iter 4→12); pin the iter before asserting magnitude.
3. shift ReLU: assert against GPU (fetchExcitation), never Python calculate().
4. sharpness/tail/damper magnitudes: direction documented; one-time measurement to set thresholds.

## Prioritized rollout
- **P0** (release build; partial coverage exists): MODE freq/decrement/mass_inv; excitation μ/σ/vol/shift; volume (sint); feedin (extend test_feedback_coupling); length (extend with FFT). + regression pins: volume_coefficient no-op, sound-channel piano-row no-op.
- **P1** (DEBUG variant — string-physics tier): tension/density/radius/stiffness (inharmonicity), γ (decay) via getSoundRecords on the single-mode fixture; gate on stability_ratio.
- **P2** (targeted fixtures): hammer pos/width/sharp; feedback/deck_feedback_coeff sustain A/B; sound-channel per-channel gain; tension_offset beats; damper/tail release.
- **P3** (measure-first): mass/speed/calibration loudness; frequency_damping HF-decay magnitude.

**First build:** a shared `ParamSoundHarness` (load minimal fixture → set param → warm-up+discard →
render/probe → metric → DIFF-vs-floor → reversibility) + the two minimal fixtures. P0 rides release;
standing up the debug getSoundRecords path unblocks the entire P1 string-physics tier (where the naive
full-mix approach fails and where most editable params live).
