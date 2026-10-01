# dev-a480 F_15 offline renders (audio_off, listen_to_modes=0, sound_derivative_order=1, 48 kHz, key held 1.4 s)

Converter with the proposal 11.11 derived clocks: strings 512 / modes 256 / **exciter 96** clocks at 393.216 MHz; output dq; tension_offset = (int)dt/(int)ttn.
With the 96-clock exciter the F_15 gauss centres are 0.24-6.1 ms and nothing falls beyond the 7 ms GPU window (max 0.02 % of |force|, was 79 % at 512 clocks).
Versus the previous (512-clock exciter) render set: A1 +4..6 dB, C4 +16..20 dB, C7 +5 dB (shorter pulses = more high-frequency drive; delivered impulse is conserved), pitch at A1/C4 within 1 c; C7 detector confidence ~0 (as for the template), so its cents/decay are not meaningful.

| preset | pitch | vel | cents vs Notes_freqs | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | NaN/Inf | ch RMS balance (dB) |
|---|---|---|---|---|---|---|---|---|---|
| template_belarus | 33 | 64 | -18.3 | 1.00 | -16.0 | -69.8 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 33 | 110 | -18.3 | 1.00 | -16.0 | -62.9 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 60 | 64 | -20.2 | 1.00 | -23.3 | -89.3 | +0.0 | 0 | 0 / -1 / -1 / -9 |
| template_belarus | 60 | 110 | -20.2 | 1.00 | -22.8 | -81.8 | +0.0 | 0 | 0 / -2 / -1 / -8 |
| template_belarus | 96 | 64 | -23.3 | 0.00 | -33.2 | -122.8 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| template_belarus | 96 | 110 | -23.3 | 0.00 | -33.3 | -118.0 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| F15_pitch_batch2 | 33 | 64 | -0.3 | 1.00 | -14.6 | -82.3 | -12.5 | 0 | -11 / -7 / 0 / -6 |
| F15_pitch_batch2 | 33 | 110 | +0.3 | 1.00 | -14.3 | -75.1 | -12.2 | 0 | -10 / -6 / 0 / -7 |
| F15_pitch_batch2 | 60 | 64 | -19.3 | 1.00 | -7.2 | -103.6 | -14.3 | 0 | -9 / -4 / 0 / -6 |
| F15_pitch_batch2 | 60 | 110 | -19.3 | 1.00 | -8.0 | -98.1 | -16.3 | 0 | -8 / -2 / 0 / -1 |
| F15_pitch_batch2 | 96 | 64 | -10.0 | 0.00 | -22.3 | -133.6 | -10.8 | 0 | -16 / -9 / -4 / 0 |
| F15_pitch_batch2 | 96 | 110 | -10.0 | 0.00 | -22.3 | -127.6 | -9.7 | 0 | -16 / -9 / -4 / 0 |
| F15_pitch_batch3 | 33 | 64 | -0.3 | 1.00 | -14.6 | -82.2 | -12.5 | 0 | -11 / -7 / 0 / -6 |
| F15_pitch_batch3 | 33 | 110 | +0.3 | 1.00 | -14.3 | -75.1 | -12.2 | 0 | -10 / -6 / 0 / -7 |
| F15_pitch_batch3 | 60 | 64 | -19.3 | 1.00 | -7.2 | -103.6 | -14.3 | 0 | -9 / -4 / 0 / -6 |
| F15_pitch_batch3 | 60 | 110 | -19.3 | 1.00 | -8.0 | -98.1 | -16.3 | 0 | -8 / -2 / 0 / -1 |
| F15_pitch_batch3 | 96 | 64 | -10.0 | 0.00 | -22.3 | -132.9 | -10.1 | 0 | -16 / -9 / -4 / 0 |
| F15_pitch_batch3 | 96 | 110 | -10.0 | 0.00 | -22.4 | -126.9 | -9.0 | 0 | -16 / -9 / -4 / 0 |

Read-back after initialize() (preset value == engine model value):
- template_belarus: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch2: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch3: gamma/tension_offset/hammer_position/hammer_width preserved = True

Level: the remaining 9-16 dB deficit vs the template is mainly the `--mode-mass host_max` scale (every FPGA mode's k <= template k; UNCONFIRMED); see the conversion reports.
