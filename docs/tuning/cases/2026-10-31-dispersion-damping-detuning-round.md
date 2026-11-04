# Tuning case: scored round: dispersion damping, detuning, strike point, pulses (presets 15 to 18)

- **Date:** 2026-10-31 · **Verdict:** kept, with a rejected list · **Trait:** sustain (top), partial balance, attack
- **Preset before:** `..._belarusfit_thump_assistant_15.json` · **after:** `..._18.json`; corrected in `..._19_interim.json`
- **Evidence:** assistant notes "Belarus fit: experiment report, thump_assistant_15 to 18" and "keyboard extension report, preset 19"; WAVs prefix `final2_`, `interim19_`
- **Confidence:** measured (offline renders scored against the piano: band-time RMS, cloud, peak sharpness; pedal 60, radiance mix, order 2, A2 C4 G4 at v95)

## Goal (the user's words)

Fit the three held notes (A2, C4, G4) to the recording: tails, partial balance, attack.

## Interpreted target

Lower band-time RMS and cloud against the piano; peak sharpness near the piano (4.0 / 3.4 / 4.3); no partial holes.

## What was done (one change at a time, scored)

KEPT

- Slower thump pulse at level 95 (mu 3.4, sigma .9): the too-sharp peak gone, scores unchanged.
- Small pulse down on C4, G4 (.03) plus more gamma (A2 .3, C4 .45, G4 .4) and A2 thump trim -14: attack centre near
  the piano.
- `hammer_position` C4 .19, G4 .125, A2 .185: fills the render's partial holes (replacing user edits, in new files only).
- `detuning` A2 .002, C4 .001, G4 .0016: fixed A2's long tail; cost: C4 swing 10.4 against 6.5.
- `dispersion_damping` 2e-15 on C4, G4: the biggest gain, C4 10.0 -> 8.5, G4 11.5 -> 9.6. CORRECTED in preset 19 to
  5e-15 / 4e-15: 2e-15 left partials 15-20 ringing up to 14 dB over the piano at 4-10 kHz, and part of the score gain
  was a noise-floor artefact.
- A2 small pulse .13: partial 5 gap closed from -11 to -3 dB.

REJECTED

- Pedal 90 on A2, G4: no gain, G4 cloud worse (60 stays).
- `dispersion_damping` 3e-15 on A2: 8.6 -> 9.8 (back to 8e-15).
- `hammer_sharpness` .2: inert, under 0.1 dB (back to .5).
- A2 `hammer_position` .2: a hole at partial 5.

NEUTRAL, left in: heavier modes on the C4 / G4 third partials (mass 2.5e-11): the third partials did not rise; G4
cloud better, C4 worse.

## Measurements

Overall band-time RMS 9.1 / 10.7 / 12.0 -> 8.7 / 8.5 / 9.9 (A2 / C4 / G4). Cloud 15.1 / 9.2 / 11.1 -> 15.9 / 10.0 / 6.9.
Peak sharpness 5.0 / 7.0 / 6.1 -> 4.2 / 4.0 / 4.8 (piano 4.0 / 3.4 / 4.3). Still open after the round: first 2 s too
slow on C4, G4 (at 2 s -22.8 vs -33.1, -19.1 vs -30.2); G4 third partial 21 dB low; C4 6th and 8th over 30 dB low;
A2 cloud 15.9; attack 500-2000 Hz 8 dB over on C4, G4. Full keyboard sweep clean, no crash-guard trips.

## Lessons

- A single score misleads: state the floor, keep several metrics, audit where the energy went.
- Dispersion damping is the strongest top-end lever and the easiest to over-apply.
- Record rejections with numbers; they saved the next session three experiments.
