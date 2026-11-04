# Tuning case: the fast first decay was unison beating

- **Date:** 2026-10-30 · **Verdict:** kept · **Trait:** beating, sustain
- **Preset before:** `F15_measured_20261030_assistant_2.json` · **after:** `F15_measured_20261030_belarusfit_assistant_3.json`
- **Evidence:** assistant note "Belarus fit: A2 C4 G4 offline, envelope + gap fill (belarusfit_assistant_3)"; target recording run `20261025T180612-belarus_held_C4_A2_G4`
- **Confidence:** measured (offline `render.chart sound_test`, velocity 95, 5 s hold; fit library scores)

## Goal (the user's words)

Make the model's A2, C4 and G4 decay like the recorded piano (the first part of the note died too fast).

## Interpreted target

The early-decay rate (dB/s over the first second) and the partial-level error against the recording; the render's
first second fell far faster than the piano's.

## Options offered / considered

- lower the string damping (gamma) or the dispersion damping — the obvious decay levers;
- the unison detuning: a fast first decay can be two strings beating against each other, not damping;
- gap modes to fill missing body resonances.

## What was done

- Found: the fast first decay was BEATING between the unison strings. Detuning became the lever:
  `string.detuning` p45 .0027, p60 .0019, p67 .0028; gamma p60 1.0, p67 .75; `dispersion_damping` p60 1e-14,
  p67 1.2e-14, p45 3.5e-14; first-spike component 2 at levels 95 and 127 (p60 sigma .045 vol 1.0; p45 .055 vol 1.3;
  p67 .05 vol .6).
- Gap fill (labelled placeholders, no measured evidence of real modes): spare modes moved to 590 / 632 / 668 / 705 Hz
  (mass 3-8e-13, decrement .09) keeping their old feedin rows. Mode 9 mass 2.7e-12 was rejected: A2 665 Hz +1.7 dB but
  E5 +10.8 dB (modes are shared across keys).
- hammer_width: no effect on these keys (matches a user report).

## Measurements

Partial-level error: baseline 21.4 dB -> fit 9.8 -> envelope pass 10.6 -> gap fill 10.25 dB. Early decay 28.6 ->
12.1 dB/s. Overall envelope 5.4 dB (A2 3.8, C4 5.2, G4 7.2). A2 665 Hz need +19.8 -> +12.6 dB. C5-G5 level spread
7.7 -> 4.3 dB (gap on). Open after: G4 fades too regularly; C4 8-10 dB high at 1-2 s; A2 fundamental 13 dB high.

## Lessons

- Before touching damping for a "fast decay", read the beating (envelope ripple of the fundamental): detuning may be
  the lever.
- A placeholder mode improves a score without evidence it exists; label it so.
- Shared modes: a per-key gain can be a 10 dB cost on another key.
