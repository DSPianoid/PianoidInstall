# dev-a480 F_15 offline renders: F_15's own strings at ArraySize 512

Converter: F_15 Pitch.txt (batch4) point counts, blocks = the 57 FPGA 512-point arrays (+1 output block, 232 strings), tension/stiffness/damping/unison from ttn, dt, disp, decr_*, damping (kernel coefficients = FPGA words, rate-scaled), speaking length N - (int)shteg - 21.1, GPU main = N_eff + 1 (engine vibrates main - 1), mode damping host_q, mode mass host_max (UNCONFIRMED scale), output dq.
Load: `array_size=512, string_iteration=4, listen_to_modes=0, sound_derivative_order=1`, 48 kHz, offline (`runOfflinePlayback`), separate process, key held 1.4 s.

- **Pitch vs Notes_freqs (16 keys, v110): median -1.5 c, IQR -5.2..+3.5 c, range -36.1..+35.2 c.** The extremes (A0/C1 flat, A7/C8 sharp) are F_15's own tuning: the FPGA scheme itself predicts them.
- **Pitch vs the FPGA's own prediction (exact clamped scheme on the same points): median -0.7 c, max |10.9| c** (C2 is the only key beyond 2.5 c).
- Detector confidence 1.00 on every key. No NaN/Inf. Every note decays. Engine read-back of gamma/tension_offset/hammer equals the preset.
- At 16 sub-steps (the exact FPGA step) the same preset GROWS: MIDI 21 +168 dB/s, MIDI 33 +201 dB/s, MIDI 60 +217 dB/s, MIDI 96 +275 dB/s -> default 4 sub-steps.

| MIDI | vel | cents vs Notes_freqs | cents vs FPGA prediction | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | NaN/Inf |
|---|---|---|---|---|---|---|---|---|
| 21 | 64 | -37.0 | -2.0 | 1.00 | -3.4 | -94.5 | - | 0 |
| 21 | 110 | -36.1 | -1.0 | 1.00 | -4.0 | -83.6 | - | 0 |
| 24 | 64 | -24.6 | +1.6 | 1.00 | -3.4 | -96.2 | - | 0 |
| 24 | 110 | -23.9 | +2.2 | 1.00 | -4.1 | -86.6 | - | 0 |
| 33 | 64 | -5.2 | +0.9 | 1.00 | -9.6 | -111.0 | -41.2 | 0 |
| 33 | 110 | -4.6 | +1.5 | 1.00 | -10.0 | -101.4 | -38.5 | 0 |
| 36 | 64 | -19.5 | -10.8 | 1.00 | -6.7 | -107.7 | - | 0 |
| 36 | 110 | -19.5 | -10.9 | 1.00 | -7.4 | -99.5 | - | 0 |
| 45 | 64 | +2.9 | -0.9 | 1.00 | -8.6 | -141.2 | - | 0 |
| 45 | 110 | +2.9 | -0.8 | 1.00 | -9.4 | -133.7 | - | 0 |
| 48 | 64 | +1.8 | -0.1 | 1.00 | -7.7 | -127.0 | - | 0 |
| 48 | 110 | +1.8 | -0.1 | 1.00 | -8.8 | -119.9 | - | 0 |
| 57 | 64 | -3.1 | -1.8 | 1.00 | -8.2 | -128.4 | - | 0 |
| 57 | 110 | -3.1 | -1.9 | 1.00 | -11.1 | -119.5 | - | 0 |
| 60 | 64 | -5.6 | -0.3 | 1.00 | -10.7 | -124.5 | -35.2 | 0 |
| 60 | 110 | -5.6 | -0.3 | 1.00 | -13.4 | -115.6 | -33.8 | 0 |
| 69 | 64 | -0.0 | -1.1 | 1.00 | -19.9 | -108.5 | - | 0 |
| 69 | 110 | -0.1 | -1.1 | 1.00 | -20.0 | -102.8 | - | 0 |
| 72 | 64 | -5.0 | -1.2 | 1.00 | -25.3 | -108.8 | - | 0 |
| 72 | 110 | -5.0 | -1.2 | 1.00 | -25.3 | -103.5 | - | 0 |
| 81 | 64 | +0.9 | +2.1 | 1.00 | -25.4 | -111.5 | - | 0 |
| 81 | 110 | +0.9 | +2.1 | 1.00 | -25.5 | -108.7 | - | 0 |
| 84 | 64 | -3.0 | -1.6 | 1.00 | -27.7 | -124.9 | - | 0 |
| 84 | 110 | -3.0 | -1.6 | 1.00 | -27.7 | -124.5 | - | 0 |
| 93 | 64 | +5.2 | -0.9 | 1.00 | -54.3 | -140.6 | - | 0 |
| 93 | 110 | +5.2 | -0.9 | 1.00 | -54.2 | -132.8 | - | 0 |
| 96 | 64 | +10.3 | -0.6 | 1.00 | -55.1 | -134.9 | -12.1 | 0 |
| 96 | 110 | +10.3 | -0.6 | 1.00 | -56.2 | -132.8 | -14.8 | 0 |
| 105 | 64 | +30.3 | +2.4 | 1.00 | -68.7 | -136.6 | - | 0 |
| 105 | 110 | +30.3 | +2.4 | 1.00 | -77.6 | -125.5 | - | 0 |
| 108 | 64 | +35.2 | +1.8 | 1.00 | -75.3 | -136.5 | - | 0 |
| 108 | 110 | +35.2 | +1.8 | 1.00 | -86.2 | -129.5 | - | 0 |
