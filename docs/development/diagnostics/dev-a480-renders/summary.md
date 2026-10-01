# dev-a480 F_15 offline renders (audio_off, listen_to_modes=0, sound_derivative_order=1, 48 kHz, key held 1.4 s)

Converter on proposal 11.12 (batch 4 stm32 firmware): F_15's own Pitch.txt (batch4, DERIVED), speaking length N - (int)shteg - 21.3 (DERIVED from data), mode damping `host_q` (DERIVED: exact FPGA decay rate, tau 0.28-0.56 ms), clocks 512/256/96, output dq, tension_offset (int)dt/(int)ttn, mode mass `host_max` (UNCONFIRMED absolute scale).

- `F15_pitch_batch4` = the defaults. `F15_pitch_batch4_modeq_template` = same but `--mode-q template` (override) to isolate the damping change.
- Rendered pitch follows the TEMPLATE tension (the converter does not retune); the FPGA-grid tuning check with the F_15 Pitch.txt + offset is in the conversion report: median +0.7 c, IQR -6.3..+13.3 c, range -49..+90 c over 88 keys.
- C7 detector confidence is ~0 (as for the template): its cents/decay are not meaningful.
- Stability: no NaN/Inf; all notes decay. A probe with `--mode-mass host_median` + host_q still runs away (+300 dB/s), so the host_max cap stays.

| preset | pitch | vel | cents vs Notes_freqs | conf | decay dB/s | RMS dB (0-0.5 s) | dRMS vs template | NaN/Inf | ch RMS balance (dB) |
|---|---|---|---|---|---|---|---|---|---|
| template_belarus | 33 | 64 | -18.3 | 1.00 | -16.0 | -69.8 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 33 | 110 | -18.3 | 1.00 | -16.0 | -62.9 | +0.0 | 0 | -2 / -10 / 0 / -10 |
| template_belarus | 60 | 64 | -20.2 | 1.00 | -23.3 | -89.3 | +0.0 | 0 | 0 / -1 / -1 / -9 |
| template_belarus | 60 | 110 | -20.2 | 1.00 | -22.8 | -81.8 | +0.0 | 0 | 0 / -2 / -1 / -8 |
| template_belarus | 96 | 64 | -23.3 | 0.00 | -33.2 | -122.8 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| template_belarus | 96 | 110 | -23.3 | 0.00 | -33.3 | -118.0 | +0.0 | 0 | -1 / -5 / 0 / -8 |
| F15_pitch_batch4 | 33 | 64 | -1.2 | 1.00 | -12.7 | -100.0 | -30.2 | 0 | -8 / -6 / 0 / -3 |
| F15_pitch_batch4 | 33 | 110 | -0.8 | 1.00 | -13.8 | -91.3 | -28.4 | 0 | -9 / -5 / -2 / 0 |
| F15_pitch_batch4 | 60 | 64 | -20.1 | 1.00 | -12.4 | -115.9 | -26.7 | 0 | -17 / -6 / -10 / 0 |
| F15_pitch_batch4 | 60 | 110 | -20.1 | 1.00 | -16.0 | -107.9 | -26.1 | 0 | -17 / -6 / -12 / 0 |
| F15_pitch_batch4 | 96 | 64 | -10.1 | 0.00 | -35.5 | -132.7 | -9.9 | 0 | -22 / -8 / -17 / 0 |
| F15_pitch_batch4 | 96 | 110 | -10.1 | 0.00 | -35.8 | -126.4 | -8.4 | 0 | -22 / -8 / -17 / 0 |
| F15_pitch_batch4_modeq_template | 33 | 64 | -0.4 | 1.00 | -14.7 | -82.0 | -12.2 | 0 | -11 / -7 / 0 / -6 |
| F15_pitch_batch4_modeq_template | 33 | 110 | +0.3 | 1.00 | -14.4 | -75.0 | -12.0 | 0 | -11 / -6 / 0 / -7 |
| F15_pitch_batch4_modeq_template | 60 | 64 | -19.3 | 1.00 | -7.2 | -100.9 | -11.6 | 0 | -9 / -4 / 0 / -6 |
| F15_pitch_batch4_modeq_template | 60 | 110 | -19.3 | 1.00 | -7.8 | -95.6 | -13.8 | 0 | -8 / -3 / 0 / -2 |
| F15_pitch_batch4_modeq_template | 96 | 64 | -10.0 | 0.00 | -22.3 | -122.7 | +0.1 | 0 | -16 / -9 / -3 / 0 |
| F15_pitch_batch4_modeq_template | 96 | 110 | -10.0 | 0.00 | -22.3 | -116.8 | +1.2 | 0 | -16 / -9 / -3 / 0 |

Read-back after initialize() (preset value == engine model value):
- template_belarus: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch4: gamma/tension_offset/hammer_position/hammer_width preserved = True
- F15_pitch_batch4_modeq_template: gamma/tension_offset/hammer_position/hammer_width preserved = True
