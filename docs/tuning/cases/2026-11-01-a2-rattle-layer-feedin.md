# Tuning case: A2 rattle: an engine layer, relieved per key by feedin

- **Date:** 2026-11-01 · **Verdict:** kept (partial relief; the source is in the engine) · **Trait:** noise
- **Preset before:** `..._belarusfit_thump_assistant_22_c4attack.json` · **after:** `..._23_a2rattle.json`
- **Evidence:** assistant notes "A2 rattle report, preset 23" and "Keyboard extension report, preset 25"; WAVs prefix `rattle23_`; piano fit report section 3 (engine defects)
- **Confidence:** measured (renders; correlation of identical renders; order 1 vs 2 comparison)

## Goal (the user's words)

A2 has a rattle (dirt above the note).

## Interpreted target

Uncorrelated noise above about 4 kHz that scales with the note level (cloud between partials high in the 4-14 kHz
bands); bring it down without losing the real 2-8 kHz attack.

## Options offered / considered

- unison detuning, half pedal, high modes, string dispersion damping, low modes as the source — each ruled out by a
  one-change test;
- order 1 instead of 2 (settings change) — lowers it about 30 dB, below the piano floor, but changes the whole sound;
- lower A2's feedin to the carrier modes 194 / 195 and the small pulse level.

## What was done

- Found: identical renders correlate near 0.15 above 4 kHz and 1.0 below 500 Hz, so the layer is numerical noise
  lifted by order 2; the block comb (n x 750 Hz) is about 25 % of the 8-14 kHz power, not the whole.
- Modes 193-195 (large mass) hold 95 % of the broadband path on A2 AND carry the real 2-8 kHz attack: muting them
  loses the attack.
- Kept: A2 `feedin` of modes 194 and 195 at 0.5; small pulse level at velocity 95 at 0.05. Layer down 4 dB; scores
  6.8 / 9.7 (band-time / cloud).
- Rejected later (preset 25): sharper, lighter 194 / 195 helped A2 but worsened C4.

## Measurements

Before: A2 above 10 kHz -45 dB against the piano's -65. After: -4 dB on the layer; the board drive has it 11-16 dB
lower than the speaker mix. Keys 46-48 share the layer. The layer is bass-wide (keys 21-50) and rises with the
stiffness Courant number.

## Lessons

- Linearity and determinism tests (velocity change, block-size change, render twice) separate an engine artefact from
  a parameter problem before any fitting.
- A per-key feedin edit is the preset-side relief; the fix belongs in the engine (bug reports filed).
- Parallel modes add paths and cannot filter: a flat layer passes through any mode.
