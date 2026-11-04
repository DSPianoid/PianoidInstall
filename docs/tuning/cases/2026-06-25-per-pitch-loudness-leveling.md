# Tuning case: uneven keyboard: per-pitch excitation scatter, not the modes

- **Date:** 2026-06-25 (root cause 2026-06-26 / 30) · **Verdict:** kept as a stopgap (leveled preset); root cause fixed in the engine's conserve coefficient · **Trait:** level
- **Preset before:** `Belarus_196modesC_Fanera6exc.json` · **after:** `Belarus_196modesC_Fanera6exc_leveled.json` (original pristine)
- **Evidence:** orchestrator memory `project_perpitch_volume_ripple_modal_resonance` and `project_excitation_normalization_corrected_model` (dev-volpitch, dev-normfix); harness `scratch_volpitch/*.py`
- **Confidence:** measured (bare per-pitch synthesis peak; a property swap test; GPU delivered impulse)

## Goal (the user's words)

Pitch 52 and 53 at v127 are about 10-14 dB apart; the keyboard is uneven.

## Interpreted target

The bare rendered peak per pitch flat across the keyboard (within a few dB), no timbre change.

## Options offered / considered

- a damping floor or 20 x damping on the modes near pitch 52's 17th partial (the "soundboard resonance" hypothesis);
- a per-pitch leveling of the excitation volume row;
- the normalisation of the excitation coefficient (the root cause).

## What was done

- Refuted: a global damping floor and even 20 x damping on modes 148-154 left the pitch-52 peak byte-identical:
  mode damping does not control per-pitch loudness; the spectral coincidence was correlation.
- The swap test found the lever: swapping the EXCITATION of pitch 52 onto 53 moved 53's peak 44.5 -> 200; physics or
  deck swaps did not.
- Stopgap: per-pitch gain sqrt(target / current) on the excitation volume row (target = the median of 84 pitches;
  boost cap +12 dB): 52 -> 53 step -14.02 -> +0.02 dB; keyboard body 47-72 flat to +-0.17 dB; bass 26-46 left 3-18 dB
  under (physically weak; a taste decision).
- Root cause: the curve integral was double-counted in the excitation coefficient; the conserve coefficient
  (c x mass x speed divided by the temporal and spatial integrals) makes the delivered impulse shape-independent
  (36 x scatter -> 1.08 x). Rendered loudness keeps a +-7 dB per-pitch term from the curve SHAPE (a physical fact).

## Measurements

Delivered impulse scatter 36.4 x -> 1.08 x (GPU force sum); rendered keyboard spread 27 dB -> +-7 dB after
conserve; +-0.17 dB in the body after leveling.

## Lessons

- Confirm causation with a swap or knockout before attributing a per-key effect to a mode.
- Loudness depends on the impulse (mass x speed) and on the curve shape; a curve-volume renormaliser is inert in
  conserve mode.
- Measure the delivered impulse (force on the GPU), not only the loudness.
