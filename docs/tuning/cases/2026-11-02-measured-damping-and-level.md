# Tuning case: measured board damping and the level it costs (BelarusNew2 Ver2 to Ver6)

- **Date:** 2026-11-02 · **Verdict:** open (Ver6 is the working start; the decay gap remains) · **Trait:** body, sustain, level
- **Preset before:** `BelarusNew2Assistant_Ver1.json` (before damping) · **after:** `_Ver2` (measured damping), `_Ver3` (+ radiance matched by mic), `_Ver4` (+ stored feedback 3312), `_Ver5` (realistic hammers), `_Ver6` (zeta x3, slot fixes)
- **Evidence:** assistant notes "Ver1/Ver2 saved, master level cut 18 dB", "Ver4 is the working start", "Ver5/Ver6, composition defect found" (2026-11-02); the merged measured table v5
- **Confidence:** measured (rig modal measurement for the damping; mic RMS per note for the level)

## Goal (the user's words)

Use the measured board modes (frequencies, damping) in the composed preset, and make the speakers sound like the
board.

## Interpreted target

Mode decrement set from the measured zeta (1-4 %) in place of the tuned 10-30 %; speaker-minus-board level per note
near 0 dB at the mic; the A2 / C4 low partials nearer the piano.

## Options offered / considered

- write the measured damping on the 61 modes under 2.1 kHz (Ver2);
- keep tuned damping and only match radiance (Ver3 without Ver2);
- a tuning choice above measured (zeta x3) with mass scaled by sqrt(zeta ratio) to hold the level (Ver6).

## What was done

- Ver2: measured damping on 61 modes (59.7-1905 Hz). The levels moved by up to 12.6 dB and the slider had far less
  range than assumed: runtime volume_center 29.22 -> 3.653 (-18 dB, session only), later the load anchor volume 110.36.
- Ver3: radiance matched per note at the mic: speakers minus board at vel 70 from +17.3 / +18.3 / +11.6 / +14.6 /
  +5.6 / +5.6 / -4.7 dB (C2..C6) to +2.3 / -1.5 / -2.6 / -4.4 / -1.0 / +4.9 / -1.9 dB.
- Found a composition defect: 18 reused slots kept the feedin columns of their old HF modes; slots 46 / 51 / 56 at
  359-396 Hz with 1/mass up to 5400 x old (feedin -1 on C2).
- Ver6: slots 46 / 51 / 56 mass 1e-14; decrement x3 (capped at old) on the 61 modes; mass x sqrt(zeta ratio) on modes
  0-23; stored feedback 6201. Board-to-mic partial RMS A2 10.2 -> 8.9, C4 10.4 -> 10.8; A2 lows -20.7 / -16.8 ->
  -12.8 / -11.6 dB (piano -9.3 / -6.1).

## Measurements

See above. Still open: the decay gap; slots 60-62 and 69-74 with the same feedin flaw at 668-997 Hz; the exciters went
silent twice (hardware, not a preset fault); a full load of a stale file re-calibrates the stored output_scale (-9 dB
on Ver5).

## Lessons

- Measured damping is a level change: lower damping = a louder, longer resonance; re-level after it and warn before
  the first live note.
- Radiance targets the board in the room; a per-note empirical match at the mic beat the formula from FRFs.
- Composition by slot reuse needs a check of every reused row, not only the frequency.
