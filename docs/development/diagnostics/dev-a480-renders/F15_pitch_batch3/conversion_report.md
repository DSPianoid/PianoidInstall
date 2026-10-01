# FPGA -> GPU conversion report

- FPGA folder: `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\unpacked\F_15\F_15`

## Inputs (DERIVED from code / UNCONFIRMED / OVERRIDDEN)

- **pitch_file** = `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\batch3\Pitch.txt` (UNCONFIRMED) - F_15's own Pitch.txt is not in F_15.rar; sets speaking lengths -> hammer geometry, B, grid tuning check
- **string_clocks** = `512` (DERIVED) - /mashinka_0/Force_str0/Counter1 (SID 1830601): 512 points, 1 per clock
- **mode_clocks** = `256` (DERIVED) - /oscill_dbl2 256-deep state RAMs, 1 mode per clock
- **exc_clocks** = `96` (DERIVED) - /Mid_Graph2/Counter3 (SID 1634313) 0..95, per-note time RAM depth 96 (SID 1634315); sets every gauss centre/width in ms
- **mode_q** = `template` (UNCONFIRMED) - derived equation (/oscill_dbl2, proposal 11.11.2): q[n+1] = (2q[n] - q[n-1] + D q[n-1] - W q[n] + M F)(1 - D), D = (int)(Q_coeff*q_ratio)/2^31 (s32.31, no hidden shift), one step per 256 clocks; verbatim D gives tau 0.28-0.56 ms (non-physical) -> the physical Q is UNCONFIRMED (bridge firmware not delivered); template median used unless host_q
- **mode_mass** = `host_max` (UNCONFIRMED) - absolute FPGA->GPU mass/force scale unknown; host_max puts every mode's k = mass_inv(2 pi f)^2 at or BELOW the template k (strongest = template, weakest ~3400x lower on F_15): stable by attenuation, and the main reason the converted preset renders 9-16 dB below the template (F_15, A1/C4/C7)
- **output_signal** = `dq` (DERIVED) - send_all sets RING_15 = 2 (Gain_FB[0] = 2); /Mux1 (SID 1898483) input 2 = dq (modal velocity); load-time param

## Level

Output level vs the template is set by the mode-mass scale: absolute FPGA->GPU mass/force scale unknown; host_max puts every mode's k = mass_inv(2 pi f)^2 at or BELOW the template k (strongest = template, weakest ~3400x lower on F_15): stable by attenuation, and the main reason the converted preset renders 9-16 dB below the template (F_15, A1/C4/C7).

## Load with

`{"listen_to_modes": 0, "sound_derivative_order": 1}`

## Template fallbacks used

- none

## Dropped / approximated

- tension/rho/r/jung/geometry/blocks/strings: kept from template (FPGA ttn is grid-bound; grid tuning check in strings.*)
- ttn_tails (tail tension): no GPU equivalent (engine gap)
- damping (tail decrement), decr_cl (damper law), decr_disp, disp: template damper_*/disp_decay/jung/r kept
- Shape_512 tabulated hammer shape: replaced by the circular cap fit (width/del) on the template sharpness
- tension_offset: FPGA unison is symmetric ((int)ttn, +(int)dt, -(int)dt); GPU is one-sided (T, T(1+o), T(1+2o)), o = (int)dt/(int)ttn
- gauss slot 4: not sent by the host (vol 0); ind_tail_* (host preview shift) dropped
- per-(pitch, level) loudness: rank-1 hammer_mass x hammer_speeds fit (conserve mode); residual in excitation.*
- excitation beyond the GPU 7 ms window would be truncated (excitation.beyond_window_*; ~0 on F_15 with the derived 96-clock exciter step: centres 0.24-6.1 ms)
- velocity: engine interpolates linearly between the 6 anchors; FPGA layer interpolation is evaluated only at the anchors
- Ci_coef_str separate feedback matrix: GPU single matrix feedback = feedin (loop sign checked in deck.*)
- global FB magnitude (-Gain_FB[1]): template deck_feedback_coefficient kept (force/displacement scale unknown)
- 16 FPGA outputs -> the template's output pitches (engine gap); columns in output.fpga_columns
- modes above the template num_modes dropped (modes.dropped_*); mode Q per unknowns.mode_q
- mode mass_inv: exact relative host law Mass/f^2, absolute scale per unknowns.mode_mass
- ttn_micro, FB.txt, NL, NL_disp, Ci_str_out, Ci_str_curve, impulse_resp_*, others[3..14]: not mapped

## modes

```
{
 "host_q_decrement_range": [
  0.40209815445192754,
  40.46086291450308
 ],
 "template_decrement_median": 0.08516383254345274,
 "template_stiffness_k_median": 0.1,
 "stiffness_k_range": [
  2.9089642966830506e-05,
  0.1
 ],
 "fpga_run_frequency_cents": {
  "median": -37.76864684602154,
  "min": -42.63316334375188,
  "max": -37.767787815301546
 },
 "dropped_modes": 60,
 "first_dropped_mode_hz": 8913.043478
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
 "gamma_range": [
  0.3204345703125,
  4.2572021484375
 ],
 "speaking_points_range": [
  35.0,
  391.0
 ],
 "negative_shteg_keys_unclamped": [
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
 "full_allocation_hammer_keys": [],
 "inharmonicity_B_range": [
  8.351281722400349e-06,
  0.001150725199461019
 ],
 "fpga_grid_tuning_cents_vs_Notes_freqs": {
  "median": -588.1257028850339,
  "min": -1633.3253972974762,
  "max": -8.721200291932153
 },
 "strings_per_note_fpga_vs_template": {
  "mismatched_pitches": [],
  "fpga_total_strings": 228
 }
}
```
