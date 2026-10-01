# dev-a480 F_15 offline renders: F_15's own strings at ArraySize 512

Converter: F_15 Pitch.txt (batch4) point counts, blocks = the 57 FPGA 512-point arrays (+1 output block, 232 strings), tension/stiffness/damping/unison from ttn, dt, disp, decr_*, damping (kernel coefficients = FPGA words, rate-scaled to the GPU sub-step), N_eff = N - (int)shteg - 21.1, GPU main = N_eff + 1, mode damping host_q, mode mass host_max (UNCONFIRMED scale), output dq. Offline (`runOfflinePlayback`), separate process, 48 kHz, key held 1.4 s, `array_size=512`.

## GPU string sub-steps per sample (converter rescales the physics for each)

Keys MIDI 21-33 (stiffest bass), 60, 96 x v64/v110 (iter 4: the A/C sweep in `F15_own_a512_iter4/`).

| sub-steps | growing notes (max dB/s) | NaN | |cents vs FPGA| v110 median / max | A0 vs FPGA | A1 vs FPGA | C4 vs FPGA | C7 vs FPGA | verdict |
|---|---|---|---|---|---|---|---|---|
| 4 | 0/32 | 0 | 1.3 / 10.9 | -1.0 | +1.5 | -0.3 | -0.6 | stable |
| 6 | 0/30 | 0 | 2.1 / 16.6 | -16.6 | +0.0 | -0.0 | +0.9 | stable |
| 8 | 0/30 | 0 | 3.4 / 26.1 | +26.1 | +3.4 | -1.1 | +0.7 | stable (**default**) |
| 10 | 1/30 (+2) | 0 | 22.6 / 46.9 | +31.1 | +37.2 | -1.2 | +0.9 | marginal (A1 v64 grows) |
| 12 | 1/30 (+493), 28 saturated | 0 | 192.0 / 307.2 | -165.0 | -193.9 | -194.7 | -192.0 | unstable |
| 16 | 2/30 (+421), 30 saturated | 0 | 193.5 / 307.2 | -165.0 | -193.9 | -194.7 | -210.9 | unstable (= exact FPGA step) |

12 and 16: one stiff bass string runs away (MIDI 22 / 24 at +420..490 dB/s) and every later render in that process is saturated (RMS ~ -2 dB), so their pitch columns are meaningless. Default = the highest stable value, 8. 4 tracks the FPGA scheme most closely in the bass (max 11 c vs 26 c at 8).

## Default (8 sub-steps): all A and all C keys

- Pitch vs Notes_freqs (v110): median -1.5 c, IQR -7.0..+6.3 c, range -24.3..+34.1 c (A0/C1 flat and A7/C8 sharp are F_15's own tuning).
- Pitch vs the FPGA scheme's own prediction: median -0.0 c, max |26.0| c. No NaN, every note decays.

| MIDI | vel | cents vs Notes_freqs | cents vs FPGA prediction | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | NaN/Inf |
|---|---|---|---|---|---|---|---|---|
| 21 | 64 | -6.6 | +28.4 | 0.85 | -3.0 | -100.8 | - | 0 |
| 21 | 110 | -9.0 | +26.0 | 0.95 | -3.5 | -89.6 | - | 0 |
| 24 | 64 | -25.1 | +1.1 | 1.00 | -3.4 | -102.2 | - | 0 |
| 24 | 110 | -24.3 | +1.8 | 1.00 | -3.9 | -92.5 | - | 0 |
| 33 | 64 | -2.7 | +3.3 | 1.00 | -4.9 | -116.9 | -47.2 | 0 |
| 33 | 110 | -2.7 | +3.4 | 1.00 | -5.3 | -107.2 | -44.3 | 0 |
| 36 | 64 | +10.4 | +19.1 | 1.00 | -6.7 | -113.8 | - | 0 |
| 36 | 110 | +10.4 | +19.1 | 1.00 | -7.5 | -105.5 | - | 0 |
| 45 | 64 | -10.9 | -14.7 | 1.00 | -5.1 | -147.0 | - | 0 |
| 45 | 110 | -10.9 | -14.7 | 1.00 | -6.6 | -139.3 | - | 0 |
| 48 | 64 | -14.2 | -16.1 | 1.00 | -7.7 | -133.0 | - | 0 |
| 48 | 110 | -14.2 | -16.1 | 1.00 | -8.3 | -125.7 | - | 0 |
| 57 | 64 | -0.3 | +1.0 | 1.00 | -8.4 | -134.1 | - | 0 |
| 57 | 110 | -0.3 | +1.0 | 1.00 | -10.6 | -125.3 | - | 0 |
| 60 | 64 | -6.3 | -1.0 | 1.00 | -5.9 | -130.6 | -41.3 | 0 |
| 60 | 110 | -6.3 | -1.0 | 1.00 | -8.6 | -121.6 | -39.8 | 0 |
| 69 | 64 | -0.2 | -1.3 | 1.00 | -12.6 | -114.6 | - | 0 |
| 69 | 110 | -0.2 | -1.3 | 1.00 | -12.9 | -109.1 | - | 0 |
| 72 | 64 | -5.9 | -2.1 | 1.00 | -20.1 | -114.7 | - | 0 |
| 72 | 110 | -5.9 | -2.1 | 1.00 | -20.2 | -109.5 | - | 0 |
| 81 | 64 | +0.5 | +1.8 | 1.00 | -32.5 | -117.5 | - | 0 |
| 81 | 110 | +0.5 | +1.8 | 1.00 | -33.1 | -114.7 | - | 0 |
| 84 | 64 | -3.2 | -1.8 | 1.00 | -17.6 | -131.0 | - | 0 |
| 84 | 110 | -3.2 | -1.8 | 1.00 | -17.6 | -130.6 | - | 0 |
| 93 | 64 | +5.0 | -1.1 | 1.00 | -55.0 | -146.7 | - | 0 |
| 93 | 110 | +5.0 | -1.1 | 1.00 | -54.9 | -138.8 | - | 0 |
| 96 | 64 | +10.1 | -0.8 | 1.00 | -50.5 | -140.9 | -18.2 | 0 |
| 96 | 110 | +10.1 | -0.8 | 1.00 | -51.7 | -138.8 | -20.8 | 0 |
| 105 | 64 | +29.6 | +1.7 | 1.00 | -64.4 | -142.7 | - | 0 |
| 105 | 110 | +29.6 | +1.7 | 1.00 | -73.1 | -131.5 | - | 0 |
| 108 | 64 | +34.1 | +0.8 | 1.00 | -71.0 | -142.5 | - | 0 |
| 108 | 110 | +34.1 | +0.8 | 1.00 | -81.7 | -135.5 | - | 0 |
