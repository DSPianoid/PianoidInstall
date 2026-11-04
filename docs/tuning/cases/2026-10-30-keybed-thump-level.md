# Tuning case: keybed thump: which mass matches the piano

- **Date:** 2026-10-30 · **Verdict:** kept (3.4 g, low-mode rim row) · **Trait:** thump
- **Preset before:** `Tuning18-10-26ver1.json` (no thump string) · **after:** `Tuning18-10-26ver1_thump_live.json` (thump on, 3.4 g, low row); variants `_10g`, `_15g`, `_c4row*`
- **Evidence:** memory note "Keybed thump (dev-thump1, 2026-10-30)" (written by the dev team); data `thump-live-2026-10-29/results.txt`; SYNTHESIS_ENGINE "Thump string (keybed, dev-thump1)"
- **Confidence:** measured (mic A/B on the board, slider 82; C4 and G4 are lower bounds, A2 the one true comparison)

## Goal (the user's words)

Add the knock of the key and action that the real piano has at the start of every note.

## Interpreted target

50-200 Hz energy in the first 30 ms, measured against the note's later level (0.5-1 s), as on the real piano:
C4 +27 dB, G4 +27 dB, A2 +6 dB at v80.

## Options offered / considered

- a shared extra "thump" string struck by every key (mass 3.4 g, 10 g, 15 g), with a low-mode rim deck row (pitch 60's
  row zeroed above 250 Hz) or the whole C4 row;
- thump off (the baseline).

## What was done

The thump string was added (one shared string, pitch 20, 6 cm, 300 N, first partial about 8.7 kHz at 8 iterations
so it acts as a flat force below that; a heavy hammer standing for the keybed mass; felt contact 0.8-3 ms). The
masses and rows were rendered live on the board and measured at the mic.

## Measurements

50-200 Hz first 30 ms minus 0.5-1 s, dB, C4 / G4 / A2 at v80 (real piano +27 / +27 / +6):

| Variant | C4 | G4 | A2 |
|---|---|---|---|
| 3.4 g low row (kept) | at least +20 | at least +20 | +7.3 |
| 10 g low row | at least +31 | at least +30 | +13.1 |
| 15 g low row | at least +33 | at least +34 | +16.1 |
| 3.4 g C4 row | at least +18 | at least +13 | +6.4 |
| off | noise | noise | +3.5 |

Later (2026-11-01, preset 21): on the piano the thump and tone onsets coincide; the audible lead is the tone building
later (low-band half-rise lead 20-30 ms on held bass notes, about 0 in the treble). The thump acts in the first 0-20
ms; the 20-60 ms lows are a separate issue.

## Lessons

- Give the metric with its window and its reference level; a WAV's absolute level is not readable.
- A load of the thump file re-derived output_scale by +10.85 dB: drop the slider before the first live note.
- The lower bound (room noise in the late window) must be stated: C4 and G4 were not true comparisons.
