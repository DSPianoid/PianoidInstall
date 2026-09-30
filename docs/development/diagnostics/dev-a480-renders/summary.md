# dev-a480 F_15 offline renders (audio_off, listen_to_modes=0, sound_derivative_order=1, 48 kHz, key held 1.4 s)

Converter at the review-fix commit (tension_offset = (int)dt/(int)ttn). Versus the first render set, the only preset field that changed is `tension_offset`: pitch moved <= 0.9 c, RMS <= 0.3 dB; the A1 decay-slope fit moved -9 -> -13 dB/s (unison beating over the 0.2-1.3 s fit window). C7 pitch confidence is ~0.03 (as for the template), so its cents value is not meaningful.

| preset | pitch | vel | cents vs Notes_freqs | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | NaN/Inf | ch RMS balance (dB) |
|---|---|---|---|---|---|---|---|---|---|
| template_belarus | 33 | 64 | -18.3 | 1.00 | -16.0 | -69.8 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 33 | 110 | -18.3 | 1.00 | -16.0 | -62.9 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 60 | 64 | -20.2 | 1.00 | -23.3 | -89.3 | +0.0 | 0 | 0 / -1 / -1 / -9 |
| template_belarus | 60 | 110 | -20.2 | 1.00 | -22.8 | -81.8 | +0.0 | 0 | 0 / -2 / -1 / -8 |
| template_belarus | 96 | 64 | -23.3 | 0.00 | -33.2 | -122.8 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| template_belarus | 96 | 110 | -23.3 | 0.00 | -33.3 | -118.0 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| F15_pitch_batch2 | 33 | 64 | +0.7 | 1.00 | -13.0 | -88.0 | -18.2 | 0 | -10 / -7 / 0 / -7 |
| F15_pitch_batch2 | 33 | 110 | +0.4 | 1.00 | -13.4 | -79.4 | -16.5 | 0 | -10 / -8 / 0 / -6 |
| F15_pitch_batch2 | 60 | 64 | -19.3 | 1.00 | -7.9 | -123.6 | -34.3 | 0 | -9 / -2 / -0 / 0 |
| F15_pitch_batch2 | 60 | 110 | -19.3 | 1.00 | -7.3 | -113.9 | -32.1 | 0 | -9 / -4 / 0 / -6 |
| F15_pitch_batch2 | 96 | 64 | -41.3 | 0.03 | -36.6 | -138.3 | -15.5 | 0 | -15 / -17 / -1 / 0 |
| F15_pitch_batch2 | 96 | 110 | -24.4 | 0.03 | -37.9 | -132.3 | -14.3 | 0 | -15 / -17 / -0 / 0 |
| F15_pitch_batch3 | 33 | 64 | +0.7 | 1.00 | -13.0 | -87.9 | -18.2 | 0 | -10 / -7 / 0 / -7 |
| F15_pitch_batch3 | 33 | 110 | +0.4 | 1.00 | -13.4 | -79.4 | -16.5 | 0 | -10 / -8 / 0 / -6 |
| F15_pitch_batch3 | 60 | 64 | -19.3 | 1.00 | -7.9 | -123.6 | -34.3 | 0 | -9 / -2 / -0 / 0 |
| F15_pitch_batch3 | 60 | 110 | -19.3 | 1.00 | -7.3 | -113.9 | -32.1 | 0 | -9 / -4 / 0 / -6 |
| F15_pitch_batch3 | 96 | 64 | -41.3 | 0.03 | -36.6 | -137.6 | -14.8 | 0 | -15 / -17 / -1 / 0 |
| F15_pitch_batch3 | 96 | 110 | -24.2 | 0.03 | -37.9 | -131.6 | -13.6 | 0 | -15 / -17 / -0 / 0 |

Read-back after initialize() (preset value == engine model value):
- template_belarus: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch2: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch3: gamma/tension_offset/hammer_position/hammer_width preserved = True

Level: the 14-34 dB deficit vs the template is the `--mode-mass host_max` scale (every FPGA mode's k <= template k); see the conversion reports.
