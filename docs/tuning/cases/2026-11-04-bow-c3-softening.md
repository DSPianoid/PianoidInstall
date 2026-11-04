# Tuning case: bow: C3 harshness is a flat spectrum; string loss and force soften it

- **Date:** 2026-11-04 · **Verdict:** kept (the user picked x40 by ear; a C3 register curve on top) · **Trait:** brightness, harshness (bowed pitches)
- **Preset before:** the friction bow at string loss x1 (BaselinePreset1, pitch 48 bowed) · **after:** host register curves: loss x40 bass, x100 C3 region, x60 C4 up; force x0.6 around C3; angle scales the loss
- **Evidence:** dev-bow2 session log 2026-11-03/04 (engine sweeps on pitches 36 / 48 / 60 / 67 at force 0.3 / 0.5 / 0.8; `dev-bow2-timbre.py`); WAVs `bow_C3_*.wav` (library sample `bow_C3_loss60`); proposal bow-realism-2026-10-29
- **Confidence:** measured (offline renders; slips per period from the debug build; a CPU golden model of the stencil)

## Goal (the user's words)

"Generate some sounds and send me wavs. Try to improve." Then, on C3: it is harsh; soften it.

## Interpreted target

A bowed C3 whose spectrum falls like the C4's (roll-off about -4.5 dB/oct, centroid near partial 11) instead of a
flat one (0 dB/oct, centroid at partial 17); one slip per period (clean Helmholtz motion) instead of multi-slip.

## Options offered / considered

- raise the bowed string's HF loss factor (x10 / x20 / x40 / x60 / x80);
- lower the bow force around C3;
- move the bow position (rejected: rougher);
- let the angle scale the loss (kept).

## What was done

- The multi-slip came from the strings' very low HF loss; a per-register HF loss on the bowed string gave 1.0 slip per
  period: x20 was the smallest robust factor on all four test pitches; the user chose x40 by ear; x60 / x80 were clean
  at 48 / 60 / 67 but worse in the bass.
- C3 harshness: a flat spectrum. The C3 region got loss x100 and force x0.6; the new default gives -4.4 dB/oct and the
  centroid at partial 12.2, slips 1.0-1.1.

## Measurements

Centroid (C4): hammer 1.09 kHz; bow x1 6.78 kHz, x20 3.23, x40 2.54. Slips per period at force 0.3 / 0.5 / 0.8,
x1 -> x20: p48 5.4 / 2.3 / 20 -> 1.02 / 1.00 / 1.00; p60 3.2 / 3.0 / 10.6 -> 0.99 / 0.99 / 0.97. Level vs x40: x60 /
x80 -0.7 to -2.3 dB. Force 0.1 / 0.3 / 0.5 / 0.95 -> RMS 1.07e-5 / 1.94e-5 / 2.13e-5 / 7.03e-5 (0.1 and 0.95 leave the
clean regime); angle 0 / 0.5 / 1 -> centroid 6438 / 6655 / 6919 Hz. Library card of `bow_C3_loss60`: f0 129.7 Hz,
roll-off -0.7 dB/oct, centroid body 1.23 kHz.

## Lessons

- "Harsh" on a bowed note = a flat spectrum and multi-slip; the loss factor is the lever, the position is not.
- Register curves beat one global factor: the bass needs less loss than the C3 region.
- The user's ear chose a larger factor than the measurement's "smallest robust" one.
