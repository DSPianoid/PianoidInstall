# dev-a480 F_15 offline renders: F_15's own strings at ArraySize 512

Converter: F_15 Pitch.txt (batch4) point counts, blocks = the 57 FPGA 512-point arrays (+1 output block, 232 strings), tension/stiffness/damping/unison from ttn, dt, disp, decr_*, damping (kernel coefficients = FPGA words; disp_decay and damper_string written at the engine's reference grid 48 kHz x 4, dev-f2b8 semantics), N_eff = N - (int)shteg - 21.1, GPU main = N_eff + 1, mode damping host_q, mode mass host_max (UNCONFIRMED scale), output dq, output_scale_calibrated=False. Engine: PianoidCore dev cc4b540 (dev-1e95 summed-form FDTD + dev-f2b8 dt-referenced damping/impulse), shared venv build 19:20. Offline (`runOfflinePlayback`), separate process, 48 kHz, key held 1.4 s, `array_size=512`; cycle_ms = offline wall time per 64-sample cycle (real-time budget 1.333 ms). Template reference = Belarus_8band_196modes at 4 sub-steps.

## GPU string sub-steps per sample (physics rate-scaled per value)

Keys MIDI 21-33 (stiffest bass), 60, 96 x v64/v110.

| N | growing | NaN | cents vs FPGA, v110 median / max | decay A1 / C4 / C7 dB/s | RMS A1 / C4 / C7 dB | vs template A1 / C4 / C7 dB | cycle_ms |
|---|---|---|---|---|---|---|---|
| 4 | 0/30 | 0 | +2.8 / 16.0 | -5.9 / -12.9 / -57.7 | -101.5 / -115.7 / -132.2 | -38.6 / -33.9 / -14.3 | 0.55 |
| 8 | 0/30 | 0 | +2.5 / 13.7 | -5.9 / -12.9 / -57.7 | -101.5 / -115.7 / -132.2 | -38.6 / -33.9 / -14.3 | 0.70 |
| 16 (**default**) | 0/30 | 0 | +2.2 / 13.7 | -5.9 / -12.9 / -57.7 | -101.5 / -115.7 / -132.3 | -38.6 / -33.9 / -14.3 | 1.03 |

Pitch, decay and level are independent of N. The larger single-key pitch deviations (MIDI 32/33) are comb-detector readings on a weak fundamental; a partial-based estimate on the same renders is within +-5 c. Default = 16 = the FPGA string step. History: before dev-1e95 (float32 rounding of the per-sub-step bass update) N >= 12 ran away (`substep_sweep_prefix_engine/`); before dev-f2b8 the output level fell ~6 dB per doubling of N (F_15 at N=16 was A1 -113.6 / C4 -127.8 dB, now -101.5 / -115.7).

## Default (16 sub-steps): all A and all C keys

- Pitch vs Notes_freqs (v110): median -1.1 c, IQR -7.0..+3.3 c, range -31.9..+33.8 c (A0/C1 flat and A7/C8 sharp are F_15's own tuning).
- Pitch vs the FPGA scheme's own prediction: median -1.0 c, max |7.8| c (A1, comb detector). No NaN, every note decays. cycle_ms 1.03 (max 1.06).

| MIDI | vel | cents vs Notes_freqs | cents vs FPGA prediction | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | cycle_ms | NaN/Inf |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 64 | -32.2 | +2.9 | 1.00 | -3.7 | -94.7 | - | 1.02 | 0 |
| 21 | 110 | -31.9 | +3.1 | 1.00 | -4.9 | -84.0 | - | 1.03 | 0 |
| 24 | 64 | -25.1 | +1.0 | 1.00 | -3.7 | -96.3 | - | 1.05 | 0 |
| 24 | 110 | -24.4 | +1.8 | 1.00 | -4.9 | -86.8 | - | 1.01 | 0 |
| 33 | 64 | -13.9 | -7.8 | 1.00 | -4.1 | -110.9 | -41.1 | 1.01 | 0 |
| 33 | 110 | -13.9 | -7.8 | 1.00 | -5.9 | -101.5 | -38.6 | 1.01 | 0 |
| 36 | 64 | -9.2 | -0.5 | 1.00 | -5.4 | -107.7 | - | 1.05 | 0 |
| 36 | 110 | -9.2 | -0.5 | 1.00 | -7.0 | -99.6 | - | 1.03 | 0 |
| 45 | 64 | +2.7 | -1.1 | 1.00 | -5.1 | -141.2 | - | 1.02 | 0 |
| 45 | 110 | +2.7 | -1.1 | 1.00 | -6.9 | -134.0 | - | 1.03 | 0 |
| 48 | 64 | +0.4 | -1.5 | 1.00 | -7.0 | -127.1 | - | 1.02 | 0 |
| 48 | 110 | +0.4 | -1.5 | 1.00 | -8.3 | -119.9 | - | 1.00 | 0 |
| 57 | 64 | -2.0 | -0.7 | 1.00 | -8.1 | -128.5 | - | 1.03 | 0 |
| 57 | 110 | -2.0 | -0.7 | 1.00 | -11.0 | -119.5 | - | 1.04 | 0 |
| 60 | 64 | -6.3 | -1.0 | 1.00 | -11.1 | -124.5 | -35.2 | 1.05 | 0 |
| 60 | 110 | -6.3 | -1.0 | 1.00 | -13.8 | -115.6 | -33.8 | 1.02 | 0 |
| 69 | 64 | -0.3 | -1.4 | 1.00 | -20.2 | -108.5 | - | 1.04 | 0 |
| 69 | 110 | -0.3 | -1.4 | 1.00 | -20.3 | -102.8 | - | 1.03 | 0 |
| 72 | 64 | -5.3 | -1.4 | 1.00 | -23.8 | -108.9 | - | 1.00 | 0 |
| 72 | 110 | -5.3 | -1.4 | 1.00 | -23.8 | -103.5 | - | 1.04 | 0 |
| 81 | 64 | +0.7 | +2.0 | 1.00 | -30.3 | -111.5 | - | 1.04 | 0 |
| 81 | 110 | +0.7 | +2.0 | 1.00 | -30.4 | -108.7 | - | 1.04 | 0 |
| 84 | 64 | -3.1 | -1.7 | 1.00 | -28.3 | -124.9 | - | 1.04 | 0 |
| 84 | 110 | -3.1 | -1.7 | 1.00 | -28.2 | -124.5 | - | 1.02 | 0 |
| 93 | 64 | +5.0 | -1.1 | 1.00 | -56.9 | -140.6 | - | 1.04 | 0 |
| 93 | 110 | +5.0 | -1.1 | 1.00 | -56.8 | -132.8 | - | 1.04 | 0 |
| 96 | 64 | +10.0 | -0.9 | 1.00 | -54.2 | -134.9 | -12.1 | 1.02 | 0 |
| 96 | 110 | +10.0 | -0.9 | 1.00 | -55.3 | -132.8 | -14.8 | 1.04 | 0 |
| 105 | 64 | +29.4 | +1.5 | 1.00 | -69.4 | -136.6 | - | 1.06 | 0 |
| 105 | 110 | +29.4 | +1.5 | 1.00 | -78.1 | -125.5 | - | 1.04 | 0 |
| 108 | 64 | +33.8 | +0.5 | 1.00 | -76.0 | -136.5 | - | 1.03 | 0 |
| 108 | 110 | +33.8 | +0.5 | 1.00 | -86.7 | -129.5 | - | 1.05 | 0 |
