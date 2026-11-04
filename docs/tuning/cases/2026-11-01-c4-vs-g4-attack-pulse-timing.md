# Tuning case: C4 versus G4 attack: pulse timing, not stiffness

- **Date:** 2026-11-01 · **Verdict:** kept · **Trait:** attack, partial balance
- **Preset before:** `F15_measured_20261030_belarusfit_thump_assistant_21_clear.json` · **after:** `..._22_c4attack.json`
- **Evidence:** assistant note "Preset 22 report: C4 versus G4 attack" (2026-11-01); WAV pairs prefix `thump22_`; piano fit report section 3
- **Confidence:** measured (offline renders against the Belarus recording, order 2, 8 iterations, pedal 60)

## Goal (the user's words)

Listening on preset 21: "C4 attack better than G4, more spectrum." Make G4's attack like C4's.

## Interpreted target

G4's low partials 2-5 formed a hump that C4 did not have; the attack band levels of G4 should fall like C4's
(a falling partial series as in the piano), and the 8-12 kHz of the attack should stay.

## Options offered / considered

- raise stiffness on G4 (the obvious parameter: inharmonicity differs between the keys) — tested, not the cause;
- copy C4's excitation pulse set (mu / sigma / volume per level) to G4 and the keys of the same family;
- move G4's strike point (hammer_position) to fill the holes;
- reduce G4's hammer width to bring back the top.

## What was done

- The cause was excitation pulse TIMING: G4 and its neighbours had shorter, earlier pulses. Copying C4's pulse set to
  A3-B3, C#4-C5 and A2 gave a falling partial series close to the piano.
- `hammer.hammer_width` G4 -> 0.038 restored 8-12 kHz. (Width is quantised: 0.0275 and 0.034 render the same.)
- `hammer.hammer_position` 0.125-0.13 on C#4-C5 and A2 filled 2-3 kHz and A2 partial 11.
- Attack equalisation to C4 restored the level.
- Rejected: G4 position 0.19 and 0.16 (nulls, louder); hammer_sharpness (no effect); A2 lower dispersion damping
  (cloud worse); thump trim changes (no lead gained).

## Measurements

Before: G4 partials 2-5 a hump above the piano's series; thump lead present on G4 and A2.
After: G4 partial series falling like the piano below 3 kHz (room-simulation prediction: G4 matches the piano below
3 kHz; C4 on the board 8-13 dB short at 1-3 kHz, a prediction not a capture). Cost: the thump lead fell on G4 and A2;
key boundaries 56/57 and 72/73 not smooth; keys 56, 73, 74 stand out at v127.

## Lessons

- The natural parameter (stiffness) was not the lever; a one-change test of the pulse set found it.
- A recipe that travels (one key's pulse set applied to a family) beats per-key fitting, and shows its limits at the
  family's edges.
- hammer_width works only above the grid quantum; hammer_sharpness is inert.
