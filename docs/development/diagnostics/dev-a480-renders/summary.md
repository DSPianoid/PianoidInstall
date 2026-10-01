# dev-a480 F_15 offline renders: F_15's own strings at ArraySize 512

Converter: F_15 Pitch.txt (batch4) point counts, blocks = the 57 FPGA 512-point arrays (+1 output block, 232 strings), tension/stiffness/damping/unison from ttn, dt, disp, decr_*, damping (kernel coefficients = FPGA words), N_eff = N - (int)shteg - 21.1, GPU main = N_eff + 1, mode damping host_q, mode mass host_max (UNCONFIRMED scale), output dq. Engine: PianoidCore dev 682a535 (dev-1e95 summed-form float32 FDTD loop), shared venv build of 16:55. Offline (`runOfflinePlayback`), separate process, 48 kHz, key held 1.4 s, `array_size=512`; cycle_ms = offline wall time per 64-sample cycle (real-time budget 1.333 ms).

## GPU string sub-steps per sample (fixed engine; physics rate-scaled per value)

Keys MIDI 21-33 (stiffest bass), 60, 96 x v64/v110.

| N | growing | NaN | cents vs FPGA, v110 median / max | A0 | A1 | C4 | C7 | cycle_ms median / max |
|---|---|---|---|---|---|---|---|---|
| 4 | 0/30 | 0 | +2.8 / 16.0 | +2.2 | -16.0 | -1.0 | +1.0 | 0.56 / 0.58 |
| 8 | 0/30 | 0 | +2.5 / 13.7 | +2.5 | +8.2 | -1.1 | +0.8 | 0.69 / 0.71 |
| 12 | 0/30 | 0 | +3.9 / 10.1 | +3.4 | +3.2 | -1.1 | +0.7 | 0.85 / 0.89 |
| 16 (**default**) | 0/30 | 0 | +2.2 / 13.7 | +3.1 | -7.8 | -0.9 | +0.7 | 1.02 / 1.05 |

All N stable. The larger single-key deviations (MIDI 32/33, |8-16| c, at every N) are comb-detector readings on a weak fundamental: a partial-based estimate on the same renders is within +-5 c (MIDI 31-33 at N=4 and 16). Default = 16 = the FPGA string step (rate scale exactly 1). Before the dev-1e95 fix, float32 rounding swallowed the per-sub-step bass update at high N (runaway at N >= 12); that pre-fix sweep is kept in `substep_sweep_prefix_engine/`.

Engine level: output RMS falls ~15 dB from N=4 to N=16 for every preset (Belarus template A1 -63.0 -> -78.3, C4 -81.8 -> -97.0 dB), an engine property; F_15's deficit vs the template at the same N is ~31-41 dB at A1/C4.

## Default (16 sub-steps): all A and all C keys

- Pitch vs Notes_freqs (v110): median -1.1 c, IQR -7.0..+3.3 c, range -31.9..+33.8 c (A0/C1 flat and A7/C8 sharp are F_15's own tuning).
- Pitch vs the FPGA scheme's own prediction: median -1.0 c, max |7.8| c (A1, comb detector). No NaN, every note decays. cycle_ms 1.02 (max 1.06).

| MIDI | vel | cents vs Notes_freqs | cents vs FPGA prediction | conf | decay dB/s | RMS dB (0-0.5 s) | cycle_ms | NaN/Inf |
|---|---|---|---|---|---|---|---|---|
| 21 | 64 | -32.2 | +2.9 | 1.00 | -3.7 | -106.7 | 1.03 | 0 |
| 21 | 110 | -31.9 | +3.1 | 1.00 | -4.9 | -96.0 | 1.01 | 0 |
| 24 | 64 | -25.1 | +1.0 | 1.00 | -3.7 | -108.3 | 1.05 | 0 |
| 24 | 110 | -24.4 | +1.8 | 1.00 | -4.9 | -98.9 | 1.02 | 0 |
| 33 | 64 | -13.9 | -7.8 | 1.00 | -4.1 | -122.9 | 1.04 | 0 |
| 33 | 110 | -13.9 | -7.8 | 1.00 | -5.9 | -113.5 | 1.04 | 0 |
| 36 | 64 | -9.2 | -0.5 | 1.00 | -5.4 | -119.8 | 1.01 | 0 |
| 36 | 110 | -9.2 | -0.5 | 1.00 | -7.0 | -111.7 | 1.04 | 0 |
| 45 | 64 | +2.7 | -1.1 | 1.00 | -5.1 | -153.3 | 1.04 | 0 |
| 45 | 110 | +2.7 | -1.1 | 1.00 | -6.9 | -146.0 | 1.02 | 0 |
| 48 | 64 | +0.4 | -1.5 | 1.00 | -6.9 | -139.1 | 1.03 | 0 |
| 48 | 110 | +0.4 | -1.5 | 1.00 | -8.3 | -132.0 | 1.02 | 0 |
| 57 | 64 | -2.0 | -0.7 | 1.00 | -8.1 | -140.5 | 1.03 | 0 |
| 57 | 110 | -2.0 | -0.7 | 1.00 | -11.0 | -131.6 | 1.03 | 0 |
| 60 | 64 | -6.3 | -1.0 | 1.00 | -11.1 | -136.5 | 1.02 | 0 |
| 60 | 110 | -6.3 | -1.0 | 1.00 | -13.8 | -127.6 | 1.01 | 0 |
| 69 | 64 | -0.3 | -1.4 | 1.00 | -20.2 | -120.5 | 0.99 | 0 |
| 69 | 110 | -0.3 | -1.4 | 1.00 | -20.3 | -114.9 | 1.02 | 0 |
| 72 | 64 | -5.3 | -1.4 | 1.00 | -23.8 | -120.9 | 1.01 | 0 |
| 72 | 110 | -5.3 | -1.4 | 1.00 | -23.8 | -115.6 | 1.02 | 0 |
| 81 | 64 | +0.7 | +2.0 | 1.00 | -30.3 | -123.6 | 1.03 | 0 |
| 81 | 110 | +0.7 | +2.0 | 1.00 | -30.4 | -120.7 | 1.05 | 0 |
| 84 | 64 | -3.1 | -1.7 | 1.00 | -28.3 | -136.9 | 1.06 | 0 |
| 84 | 110 | -3.1 | -1.7 | 1.00 | -28.2 | -136.5 | 1.06 | 0 |
| 93 | 64 | +5.0 | -1.1 | 1.00 | -56.9 | -152.7 | 1.03 | 0 |
| 93 | 110 | +5.0 | -1.1 | 1.00 | -56.8 | -144.9 | 1.04 | 0 |
| 96 | 64 | +10.0 | -0.9 | 1.00 | -54.2 | -147.0 | 1.02 | 0 |
| 96 | 110 | +10.0 | -0.9 | 1.00 | -55.3 | -144.8 | 0.98 | 0 |
| 105 | 64 | +29.4 | +1.5 | 1.00 | -69.4 | -148.7 | 0.99 | 0 |
| 105 | 110 | +29.4 | +1.5 | 1.00 | -78.1 | -137.6 | 1.00 | 0 |
| 108 | 64 | +33.8 | +0.5 | 1.00 | -76.0 | -148.5 | 1.00 | 0 |
| 108 | 110 | +33.8 | +0.5 | 1.00 | -86.7 | -141.5 | 1.02 | 0 |
