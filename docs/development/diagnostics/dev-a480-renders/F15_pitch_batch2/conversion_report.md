# FPGA -> GPU conversion report

- FPGA folder: `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\unpacked\F_15\F_15`

## Unconfirmed inputs

- **pitch_file** = `D:\repos\PianoidInstall\PresetsFromFpga\elyashev-2026-09-30\batch2\Pitch.txt` (UNCONFIRMED) - F_15's own Pitch.txt is not in F_15.rar; sets speaking lengths -> hammer geometry, B, grid tuning check
- **string_clocks** = `512` (UNCONFIRMED)
- **mode_clocks** = `256` (UNCONFIRMED)
- **exc_clocks** = `512` (UNCONFIRMED) - sets every gauss centre/width in ms
- **mode_q** = `template` (UNCONFIRMED) - host Q code gives non-physical damping (Q<1); template median used unless host_q
- **output_signal** = `dq` (UNCONFIRMED) - load-time param

## Load with

`{"listen_to_modes": 0, "sound_derivative_order": 1}`

## Dropped / approximated

- tension/rho/r/jung/geometry/blocks/strings: kept from template (FPGA ttn is grid-bound; grid tuning check in strings.*)
- ttn_tails (tail tension): no GPU equivalent (engine gap)
- damping (tail decrement), decr_cl (damper law), decr_disp, disp: template damper_*/disp_decay/jung/r kept
- Shape_512 tabulated hammer shape: replaced by the circular cap fit (width/del) on the template sharpness
- tension_offset: FPGA unison is symmetric (ttn, ttn+dt, ttn-dt); GPU is one-sided (T, T(1+o), T(1+2o)), o = dt/ttn
- gauss slot 4: not sent by the host (vol 0); ind_tail_* (host preview shift) dropped
- per-(pitch, level) loudness: rank-1 hammer_mass x hammer_speeds fit (conserve mode); residual in excitation.*
- excitation beyond the GPU 7 ms window is truncated (excitation.beyond_window_*)
- velocity: engine interpolates linearly between the 6 anchors; FPGA layer interpolation is evaluated only at the anchors
- Ci_coef_str separate feedback matrix: GPU single matrix feedback = feedin (loop sign checked in deck.*)
- global FB magnitude (-Gain_FB[1]): template deck_feedback_coefficient kept (force/displacement scale unknown)
- 16 FPGA outputs -> the template's output pitches (engine gap); columns in output.fpga_columns
- modes above the template num_modes dropped (modes.dropped_*); mode Q per unknowns.mode_q
- mode mass_inv: exact relative host law Mass/f^2, absolute scale anchored to the template stiffness (options.mode_mass; host_median measured UNSTABLE on F_15)
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
 "dropped_above_hz": 8913.043478
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
 "beyond_window_max": 0.793989587930399,
 "beyond_window_median": 0.13970593621053856,
 "centre_ms_range": [
  1.2933461971651181,
  32.764308953959976
 ],
 "velocity_interp_max_dev_ms": 2.4705003439594506,
 "loudness_rank1_residual_db": {
  "max": 6.110012224848747,
  "rms": 1.2693694531015909
 },
 "hammer_speeds": [
  0.0,
  0.019870938362353586,
  0.516774181193921,
  2.362928522331376,
  4.117386306342112,
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
  14.0,
  454.0
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
 "inharmonicity_B_range": [
  8.351281722400349e-06,
  0.0022456678521390796
 ],
 "fpga_grid_tuning_cents_vs_Notes_freqs": {
  "median": -364.5095671197689,
  "min": -1548.359356167055,
  "max": 53.6459820168511
 },
 "strings_per_note_fpga_vs_template": {
  "mismatched_pitches": [],
  "fpga_total_strings": 228
 }
}
```
