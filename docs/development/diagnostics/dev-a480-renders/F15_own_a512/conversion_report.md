# FPGA -> GPU conversion report

- FPGA folder: `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\unpacked\F_15\F_15`

## Inputs (DERIVED from code / UNCONFIRMED / OVERRIDDEN)

- **pitch_file** = `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\batch4\Pitch.txt` (DERIVED) - F_15's own layout (confirmed by Dima 2026-10-01: batch4 Pitch.txt == batch3 content); sets speaking lengths -> hammer geometry, B, grid tuning check
- **speaking_offset** = `21.1` (DERIVED) - DERIVED FROM DATA (fit, not read from the RTL): N_eff = N - (int)shteg - 21.1 makes the exact FPGA scheme (clamped ends) play F_15 at median -0.2 c, IQR -6.4..+6.4 c vs Notes_freqs (the continuous-formula fit of proposal 11.12.3 gave 21.3); mechanism inferred (point-counter/termination alignment in STRINGS0)
- **gpu_string_iteration** = `16` (DERIVED) - GPU string sub-steps per audio sample; 16 at 48 kHz = 768 kHz = the FPGA string step exactly (rate scale 1). Requires the summed-form float32 FDTD loop (PianoidCore 682a535, dev-1e95): before it, float32 rounded the per-sub-step bass update away at high string_iteration (pitch drift, and runaway of F_15's stiff bass strings at >= 12). Measured on the fixed engine (F_15 MIDI 21-33, 60, 96 x v64/v110, dev-a480): N = 4/8/12/16 all stable, pitch vs the FPGA scheme median +2.2 c at 16, ~1.0 ms/cycle offline (budget 1.333)
- **string_clocks** = `512` (DERIVED) - /mashinka_0/Force_str0/Counter1 (SID 1830601): 512 points, 1 per clock
- **mode_clocks** = `256` (DERIVED) - /oscill_dbl2 256-deep state RAMs, 1 mode per clock
- **exc_clocks** = `96` (DERIVED) - /Mid_Graph2/Counter3 (SID 1634313) 0..95, per-note time RAM depth 96 (SID 1634315); sets every gauss centre/width in ms
- **mode_q** = `host_q` (DERIVED) - q[n+1] = (2q[n] - q[n-1] + D q[n-1] - W q[n] + M F)(1 - D) per 256-clock step (/oscill_dbl2, proposal 11.11.2), D = (int)(Q_coeff*q_ratio)/2^31 forwarded verbatim to CMD_decr_0 by the stm32 (pianoid.c S:2248-2253; 11.12.2). tau 0.28-0.56 ms IS the real F_15 behaviour: a deliberately damped broadband soundboard (q_ratio knob); sustain comes from the strings. host_q reproduces the decay rate exactly at the audio rate; 'template' (template median) is an override
- **mode_mass** = `host_max` (UNCONFIRMED) - the stm32 forwards M = Mass/f^2 verbatim (pianoid.c S:2279), so only the absolute FPGA->GPU mass/force unit scale is open; host_max puts every mode's k = mass_inv(2 pi f)^2 at or BELOW the template k (strongest = template, weakest ~3400x lower on F_15): stable (host_median runs away even with the derived host_q damping). With host_q and F_15's own strings, F_15 renders 14-39 dB below the Belarus template (A1 ~39, C4 ~34, C7 ~14 dB), the same at every sub-step count since the dev-f2b8 impulse fix (PianoidCore cc4b540 / PianoidBasic 91086d7): the heavy real mode damping plus this capped mass scale
- **output_signal** = `dq` (DERIVED) - send_all sets RING_15 = 2 (Gain_FB[0] = 2); /Mux1 (SID 1898483) input 2 = dq (modal velocity); stm32 boot sets CMD_init_sw = 2 (pianoid.c S:4449), runtime S:1652-1656; load-time param

## Level

Output level vs the template is set by the mode-mass scale: the stm32 forwards M = Mass/f^2 verbatim (pianoid.c S:2279), so only the absolute FPGA->GPU mass/force unit scale is open; host_max puts every mode's k = mass_inv(2 pi f)^2 at or BELOW the template k (strongest = template, weakest ~3400x lower on F_15): stable (host_median runs away even with the derived host_q damping). With host_q and F_15's own strings, F_15 renders 14-39 dB below the Belarus template (A1 ~39, C4 ~34, C7 ~14 dB), the same at every sub-step count since the dev-f2b8 impulse fix (PianoidCore cc4b540 / PianoidBasic 91086d7): the heavy real mode damping plus this capped mass scale.

## Load with

`{"listen_to_modes": 0, "sound_derivative_order": 1, "array_size": 512, "string_iteration": 16, "sample_rate": 48000}`

## Template fallbacks used

- none

## Dropped / approximated

- string length / rho / r: free choices kept from the template -- only the kernel products (T/(rho dx^2), r^4 E/(rho dx^4), disp_decay/dx^2, gamma dt) reach the GPU and those equal the FPGA words (strings.*)
- ttn_tails (tail tension): the GPU tail uses the main tension; identical in F_15 (ttn_tails == ttn)
- GPU tail >= 1 point: keys with (int)shteg <= 0 get a 1-point tail (StringGeometry: tail 0 marks a dummy string)
- release damping on keys without dampers (decr_cl == decr_op): +18e-6 of the tail damping excess
- GPU string sub-steps: 16 per sample = the FPGA string step, so the rate scale is exactly 1 (needs the summed-form float32 engine, PianoidCore 682a535 / dev-1e95; older engines lose bass accuracy above 4-8)
- Shape_512 tabulated hammer shape: replaced by the circular cap fit (width/del) on the template sharpness
- unison: GPU strings T_base(1 + k o) reproduce the FPGA set {ttn-dt, ttn, ttn+dt} exactly (string order permuted)
- gauss slot 4: not sent by the host (vol 0); ind_tail_* (host preview shift) dropped
- per-(pitch, level) loudness: rank-1 hammer_mass x hammer_speeds fit (conserve mode); residual in excitation.*
- excitation beyond the GPU 7 ms window would be truncated (excitation.beyond_window_*; ~0 on F_15 with the derived 96-clock exciter step: centres 0.24-6.1 ms)
- velocity: engine interpolates linearly between the 6 anchors; FPGA layer interpolation is evaluated only at the anchors
- Ci_coef_str separate feedback matrix: GPU single matrix feedback = feedin (loop sign checked in deck.*)
- global FB magnitude (-Gain_FB[1]): template deck_feedback_coefficient kept (force/displacement scale unknown)
- 16 FPGA outputs -> the template's output pitches (engine gap); columns in output.fpga_columns
- modes above the template num_modes dropped (modes.dropped_*); mode Q per unknowns.mode_q
- mode mass_inv: exact relative host law Mass/f^2, absolute scale per unknowns.mode_mass
- negative shteg (strings.negative_shteg_keys_unclamped): on the FPGA string 3 of those notes has Sdvig >= 512 (u9 wrap) and is NOT coupled to the modes, strings 1-2 terminate in the next packed string's start; the GPU's per-pitch deck couples all unison strings (proposal 11.12.3)
- ttn_micro, FB.txt, NL, NL_disp, Ci_str_out, Ci_str_curve, impulse_resp_*, others[3..14]: not mapped

## modes

```
{
 "host_q_decrement_range": [
  0.38788958095115056,
  39.71732647755741
 ],
 "template_decrement_median": 0.08516383254345274,
 "template_stiffness_k_median": 0.1,
 "stiffness_k_range": [
  2.9089642966830506e-05,
  0.1
 ],
 "fpga_run_frequency_cents": {
  "median": -37.76864684602154,
  "q25": -37.781564197039046,
  "q75": -37.76801988539992,
  "min": -42.63316334375188,
  "max": -37.767787815301546
 },
 "dropped_modes": 60,
 "first_dropped_mode_hz": 8913.043478,
 "sample_rate_for_decrement": 48000.0
}
```

## deck

```
{
 "fb_sent": -8.571429e-05,
 "modes_negative_loop_gain": [],
 "negative_coefficients": 7442,
 "zero_modes": 0
}
```

## output

```
{
 "gpu_output_pitches": [
  128,
  129,
  130,
  131
 ],
 "fpga_columns": [
  0,
  2,
  4,
  5
 ],
 "template_row_max": 430.0
}
```

## excitation

```
{
 "window_ms": 7.0,
 "beyond_window_max": 0.00024506843503551887,
 "beyond_window_median": 6.2655718289460615e-102,
 "centre_ms_range": [
  0.24250241196845967,
  6.143307928867496
 ],
 "velocity_interp_max_dev_ms": 0.463218814492397,
 "loudness_rank1_residual_db": {
  "max": 6.110012224848747,
  "rms": 1.2693694531015896
 },
 "hammer_speeds": [
  0.0,
  0.019870938362353593,
  0.516774181193921,
  2.362928522331377,
  4.117386306342114,
  5.5
 ]
}
```

## strings

```
{
 "keys_added_from_template": [
  21,
  22,
  107,
  108
 ],
 "gpu_grid": {
  "blocks": 58,
  "strings": 232,
  "block_points_max": 462
 },
 "points_per_string": [
  {
   "midi": 21,
   "fpga_alloc": 413,
   "fpga_tail": 28,
   "n_eff": 363.9,
   "gpu_main": 365,
   "gpu_tail": 28,
   "strings": 1
  },
  {
   "midi": 22,
   "fpga_alloc": 413,
   "fpga_tail": 27,
   "n_eff": 364.9,
   "gpu_main": 366,
   "gpu_tail": 27,
   "strings": 1
  },
  {
   "midi": 23,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 24,
   "fpga_alloc": 413,
   "fpga_tail": 28,
   "n_eff": 363.9,
   "gpu_main": 365,
   "gpu_tail": 28,
   "strings": 1
  },
  {
   "midi": 25,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 26,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 27,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 28,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 29,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 30,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 31,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 32,
   "fpga_alloc": 413,
   "fpga_tail": 29,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 29,
   "strings": 1
  },
  {
   "midi": 33,
   "fpga_alloc": 413,
   "fpga_tail": 22,
   "n_eff": 369.9,
   "gpu_main": 371,
   "gpu_tail": 22,
   "strings": 2
  },
  {
   "midi": 34,
   "fpga_alloc": 413,
   "fpga_tail": 22,
   "n_eff": 369.9,
   "gpu_main": 371,
   "gpu_tail": 22,
   "strings": 2
  },
  {
   "midi": 35,
   "fpga_alloc": 413,
   "fpga_tail": 22,
   "n_eff": 369.9,
   "gpu_main": 371,
   "gpu_tail": 22,
   "strings": 2
  },
  {
   "midi": 36,
   "fpga_alloc": 413,
   "fpga_tail": 24,
   "n_eff": 367.9,
   "gpu_main": 369,
   "gpu_tail": 24,
   "strings": 2
  },
  {
   "midi": 37,
   "fpga_alloc": 413,
   "fpga_tail": 25,
   "n_eff": 366.9,
   "gpu_main": 368,
   "gpu_tail": 25,
   "strings": 2
  },
  {
   "midi": 38,
   "fpga_alloc": 413,
   "fpga_tail": 24,
   "n_eff": 367.9,
   "gpu_main": 369,
   "gpu_tail": 24,
   "strings": 2
  },
  {
   "midi": 39,
   "fpga_alloc": 413,
   "fpga_tail": 24,
   "n_eff": 367.9,
   "gpu_main": 369,
   "gpu_tail": 24,
   "strings": 2
  },
  {
   "midi": 40,
   "fpga_alloc": 413,
   "fpga_tail": 24,
   "n_eff": 367.9,
   "gpu_main": 369,
   "gpu_tail": 24,
   "strings": 2
  },
  {
   "midi": 41,
   "fpga_alloc": 413,
   "fpga_tail": 24,
   "n_eff": 367.9,
   "gpu_main": 369,
   "gpu_tail": 24,
   "strings": 2
  },
  {
   "midi": 42,
   "fpga_alloc": 413,
   "fpga_tail": 23,
   "n_eff": 368.9,
   "gpu_main": 370,
   "gpu_tail": 23,
   "strings": 2
  },
  {
   "midi": 43,
   "fpga_alloc": 404,
   "fpga_tail": 20,
   "n_eff": 362.9,
   "gpu_main": 364,
   "gpu_tail": 20,
   "strings": 2
  },
  {
   "midi": 44,
   "fpga_alloc": 389,
   "fpga_tail": 17,
   "n_eff": 350.9,
   "gpu_main": 352,
   "gpu_tail": 17,
   "strings": 2
  },
  {
   "midi": 45,
   "fpga_alloc": 368,
   "fpga_tail": 17,
   "n_eff": 329.9,
   "gpu_main": 331,
   "gpu_tail": 17,
   "strings": 3
  },
  {
   "midi": 46,
   "fpga_alloc": 344,
   "fpga_tail": 15,
   "n_eff": 307.9,
   "gpu_main": 309,
   "gpu_tail": 15,
   "strings": 3
  },
  {
   "midi": 47,
   "fpga_alloc": 281,
   "fpga_tail": 17,
   "n_eff": 242.9,
   "gpu_main": 244,
   "gpu_tail": 17,
   "strings": 3
  },
  {
   "midi": 48,
   "fpga_alloc": 281,
   "fpga_tail": 15,
   "n_eff": 244.9,
   "gpu_main": 246,
   "gpu_tail": 15,
   "strings": 3
  },
  {
   "midi": 49,
   "fpga_alloc": 239,
   "fpga_tail": 14,
   "n_eff": 203.9,
   "gpu_main": 205,
   "gpu_tail": 14,
   "strings": 3
  },
  {
   "midi": 50,
   "fpga_alloc": 191,
   "fpga_tail": 12,
   "n_eff": 157.9,
   "gpu_main": 159,
   "gpu_tail": 12,
   "strings": 3
  },
  {
   "midi": 51,
   "fpga_alloc": 134,
   "fpga_tail": 10,
   "n_eff": 102.9,
   "gpu_main": 104,
   "gpu_tail": 10,
   "strings": 3
  },
  {
   "midi": 52,
   "fpga_alloc": 126,
   "fpga_tail": 9,
   "n_eff": 95.9,
   "gpu_main": 97,
   "gpu_tail": 9,
   "strings": 3
  },
  {
   "midi": 53,
   "fpga_alloc": 126,
   "fpga_tail": 5,
   "n_eff": 99.9,
   "gpu_main": 101,
   "gpu_tail": 5,
   "strings": 3
  },
  {
   "midi": 54,
   "fpga_alloc": 126,
   "fpga_tail": 4,
   "n_eff": 100.9,
   "gpu_main": 102,
   "gpu_tail": 4,
   "strings": 3
  },
  {
   "midi": 55,
   "fpga_alloc": 107,
   "fpga_tail": 4,
   "n_eff": 81.9,
   "gpu_main": 83,
   "gpu_tail": 4,
   "strings": 3
  },
  {
   "midi": 56,
   "fpga_alloc": 107,
   "fpga_tail": 5,
   "n_eff": 80.9,
   "gpu_main": 82,
   "gpu_tail": 5,
   "strings": 3
  },
  {
   "midi": 57,
   "fpga_alloc": 107,
   "fpga_tail": 4,
   "n_eff": 81.9,
   "gpu_main": 83,
   "gpu_tail": 4,
   "strings": 3
  },
  {
   "midi": 58,
   "fpga_alloc": 91,
   "fpga_tail": 3,
   "n_eff": 66.9,
   "gpu_main": 68,
   "gpu_tail": 3,
   "strings": 3
  },
  {
   "midi": 59,
   "fpga_alloc": 91,
   "fpga_tail": 4,
   "n_eff": 65.9,
   "gpu_main": 67,
   "gpu_tail": 4,
   "strings": 3
  },
  {
   "midi": 60,
   "fpga_alloc": 91,
   "fpga_tail": 4,
   "n_eff": 65.9,
   "gpu_main": 67,
   "gpu_tail": 4,
   "strings": 3
  },
  {
   "midi": 61,
   "fpga_alloc": 77,
   "fpga_tail": 2,
   "n_eff": 53.9,
   "gpu_main": 55,
   "gpu_tail": 2,
   "strings": 3
  },
  {
   "midi": 62,
   "fpga_alloc": 77,
   "fpga_tail": 3,
   "n_eff": 52.9,
   "gpu_main": 54,
   "gpu_tail": 3,
   "strings": 3
  },
  {
   "midi": 63,
   "fpga_alloc": 77,
   "fpga_tail": 2,
   "n_eff": 53.9,
   "gpu_main": 55,
   "gpu_tail": 2,
   "strings": 3
  },
  {
   "midi": 64,
   "fpga_alloc": 77,
   "fpga_tail": 2,
   "n_eff": 53.9,
   "gpu_main": 55,
   "gpu_tail": 2,
   "strings": 3
  },
  {
   "midi": 65,
   "fpga_alloc": 77,
   "fpga_tail": 2,
   "n_eff": 53.9,
   "gpu_main": 55,
   "gpu_tail": 2,
   "strings": 3
  },
  {
   "midi": 66,
   "fpga_alloc": 77,
   "fpga_tail": 3,
   "n_eff": 52.9,
   "gpu_main": 54,
   "gpu_tail": 3,
   "strings": 3
  },
  {
   "midi": 67,
   "fpga_alloc": 56,
   "fpga_tail": 0,
   "n_eff": 34.9,
   "gpu_main": 36,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 68,
   "fpga_alloc": 56,
   "fpga_tail": 0,
   "n_eff": 34.9,
   "gpu_main": 36,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 69,
   "fpga_alloc": 56,
   "fpga_tail": 0,
   "n_eff": 34.9,
   "gpu_main": 36,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 70,
   "fpga_alloc": 48,
   "fpga_tail": 0,
   "n_eff": 26.9,
   "gpu_main": 28,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 71,
   "fpga_alloc": 48,
   "fpga_tail": 0,
   "n_eff": 26.9,
   "gpu_main": 28,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 72,
   "fpga_alloc": 48,
   "fpga_tail": 0,
   "n_eff": 26.9,
   "gpu_main": 28,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 73,
   "fpga_alloc": 41,
   "fpga_tail": -2,
   "n_eff": 21.9,
   "gpu_main": 23,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 74,
   "fpga_alloc": 41,
   "fpga_tail": -2,
   "n_eff": 21.9,
   "gpu_main": 23,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 75,
   "fpga_alloc": 36,
   "fpga_tail": -3,
   "n_eff": 17.9,
   "gpu_main": 19,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 76,
   "fpga_alloc": 36,
   "fpga_tail": -3,
   "n_eff": 17.9,
   "gpu_main": 19,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 77,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 78,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 79,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 80,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 81,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 82,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 83,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 84,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 85,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 86,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 87,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 88,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 89,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 90,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 91,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 92,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 93,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 94,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 95,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 96,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 97,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 98,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 99,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 100,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 101,
   "fpga_alloc": 33,
   "fpga_tail": -2,
   "n_eff": 13.9,
   "gpu_main": 15,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 102,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 103,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 104,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 105,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 106,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 107,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  },
  {
   "midi": 108,
   "fpga_alloc": 33,
   "fpga_tail": -3,
   "n_eff": 14.9,
   "gpu_main": 16,
   "gpu_tail": 1,
   "strings": 3
  }
 ],
 "grid_rescale_range": [
  1.000270343336037,
  1.0071942446043167
 ],
 "coeff_tension_range": [
  0.0006434876331935172,
  0.027592646839930013
 ],
 "cfl_margin_min": 0.9692192109522181,
 "gamma_range": [
  0.3204345703125,
  4.2572021484375
 ],
 "damper_tail_range": [
  142,
  1000000
 ],
 "tail_damper_int_truncation": {
  "affected": false,
  "note": "the engine reads the tail damper as an INTEGER dump_coeff; the converter writes an integer multiplier (>= 1) with damper_string carrying the scale, so nothing is truncated"
 },
 "keys_without_damper": {
  "midi": [
   91,
   92,
   93,
   94,
   95,
   96,
   97,
   98,
   99,
   100,
   101,
   102,
   103,
   104,
   105,
   106,
   107,
   108
  ],
  "note": "decr_cl == decr_op: tail exact via a 1e6 tail multiplier; release adds 18e-6 of the tail damping excess (approximated)"
 },
 "tail_decrement_rel_error_max": 0.003165988240615203,
 "predicted_f_hz": [
  26.949,
  29.319,
  32.84,
  32.213,
  33.931,
  36.403,
  38.497,
  40.832,
  43.491,
  46.277,
  48.826,
  51.655,
  54.807,
  58.36,
  61.73,
  65.079,
  69.059,
  73.539,
  77.332,
  82.509,
  87.419,
  92.933,
  97.908,
  103.808,
  110.241,
  116.625,
  124.199,
  130.955,
  138.919,
  147.818,
  155.691,
  164.375,
  174.382,
  185.681,
  195.526,
  207.027,
  219.839,
  232.192,
  247.279,
  260.823,
  275.888,
  293.346,
  308.973,
  329.876,
  348.601,
  371.555,
  390.845,
  413.413,
  440.273,
  463.419,
  494.555,
  522.093,
  551.868,
  586.213,
  615.924,
  658.458,
  693.829,
  740.231,
  774.882,
  824.324,
  879.386,
  926.743,
  988.332,
  1045.64,
  1105.94,
  1175.049,
  1237.39,
  1324.153,
  1399.962,
  1488.154,
  1572.828,
  1656.223,
  1766.208,
  1864.09,
  1989.08,
  2106.254,
  2239.492,
  2362.247,
  2501.206,
  2663.579,
  2832.648,
  2971.957,
  3151.32,
  3345.187,
  3577.181,
  3795.203,
  4023.744,
  4267.333
 ],
 "negative_shteg_keys_unclamped": {
  "keys": [
   52,
   53,
   54,
   55,
   56,
   57,
   58,
   59,
   60,
   61,
   62,
   63,
   64,
   65,
   66,
   67,
   68,
   69,
   70,
   71,
   72,
   73,
   74,
   75,
   76,
   77,
   78,
   79,
   80,
   81,
   82,
   83,
   84,
   85,
   86,
   87
  ],
  "note": "host tail arithmetic kept (N_eff > N - offset); on the FPGA string 3 of these notes has Sdvig >= 512 (u9 wrap) -> uncoupled from the modes, strings 1-2 terminate in the next packed string's start; the GPU couples all unison strings (approximated)"
 },
 "full_allocation_hammer_keys": [],
 "inharmonicity_B_range": [
  9.852327448093981e-06,
  0.007295887217741051
 ],
 "fpga_grid_tuning_cents_vs_Notes_freqs": {
  "median": -0.20780595184148568,
  "q25": -6.383858195556856,
  "q75": 6.429180212090548,
  "min": -36.325930225111236,
  "max": 107.10247731968263
 }
}
```
