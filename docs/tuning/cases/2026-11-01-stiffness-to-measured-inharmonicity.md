# Tuning case: stiffness to the measured inharmonicity, with retune

- **Date:** 2026-11-01 · **Verdict:** kept · **Trait:** inharmonicity, thump timing
- **Preset before:** `..._belarusfit_thump_assistant_20_attack.json` · **after:** `..._21_clear.json`; extended to 88 keys in `..._25_keyboard.json`
- **Evidence:** assistant notes "Belarus fit report: preset 21, thump timing, attack, comb test" and "Keyboard extension report, preset 25"; WAVs prefix `thump21_`, `kb25_` (in the sample library: `kb25_C4_piano`, `kb25_C4_render`)
- **Confidence:** measured

## Goal (the user's words)

Make the render's partials sit where the piano's do (the piano fit, clarity of the tone).

## Interpreted target

The partial stretch B of each key equal to the measured piano's; the pitch kept after the change.

## Options offered / considered

- raise `string.jung` (Young's modulus coefficient) on the fitted keys to the measured B, then retune (tension);
- change the radius r (also raises B, r^4) — not used: r also changes the string mass and the excitation gain.

## What was done

- `string.jung` raised on keys 45-69 to match the measured inharmonicity, with a retune of each key.
- Preset 25: keys 37-44 raised partway (a higher stiffness raises the numerical HF layer, which grows with the
  stiffness Courant number); keys 85-108 had NEGATIVE B from numerical dispersion at 8 iterations, now positive and
  near the piano to key 99, lower at 100-104.
- Also in 21: the thump gauss moved earlier at all levels; A2 small pulse volume lower at level 95; C4 cloud recovered.
- Rejected in 21: board Q x3, reducing modes 194 and 195, raising mode 3, delaying the main pulses (the spectrum
  breaks; a delay is not time invariant).

## Measurements

C4 piano B 3.3e-4 against the render's 4.3e-4 after the keyboard extension (library compare `kb25_C4_piano` vs
`kb25_C4_render`: inharmonicity ratio 1.31; f0 both 260.7 Hz, within 0.1 cent). All keys within 1.9 dB of C4 at v95
after the attack equalisation. Thump: on the piano the low band and the tone start together within noise; the audible
lead is the tone building later (low-band half-rise lead 20-30 ms on held bass notes, about 0 in the treble).

## Lessons

- Stiffness and pitch are coupled: every E change needs a retune.
- Stiffness has a cost on the numerical layer at 8 iterations; hold it partway in the bass.
- Negative inharmonicity in the top octave is a grid artefact, not a preset value to keep.
