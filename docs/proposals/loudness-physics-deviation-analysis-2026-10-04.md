# Loudness Chain — Where the Engine Deviates from the Physical Model

- **Date:** 2026-10-04
- **Kind:** Analysis (`/analyse`). No code changed. Measurements are OFFLINE renders in separate processes
  (release pyd, audio off, one `Pianoid` per process); the live stack on :3000/:3001/:5000 was never touched.
- **Trigger:** user (Telegram): *"Analyze the loudness setting logic, find out where it deviates from the physical
  model."* Context: dev-168c made the per-pitch `hammer_mass` the only loudness lever; to make the keyboard even it
  needed masses spanning 37 dB (BaselinePreset1) to 50 dB (F15_Elyashev_array512) with the TREBLE heaviest — the
  reverse of a real piano (bass hammers ~10–12 g, treble ~4 g, a ~10 dB range).
- **Related (not superseded):** [Automatic Volume Equalization — System Review](volume-equalization-review-2026-10-04.md)
  (the level chain's mechanisms; this doc is its physics counterpart), [Excitation Loudness — Corrected Model](excitation-loudness-normalization-correction-2026-06-30.md)
  (the `c·m·v/(temporal·spatial)` coefficient), [Physics-Based Excitation Energy](excitation-physical-energy-2026-06-16.md)
  (D5 hammer-mass design), [FPGA → GPU Preset Port](fpga-to-gpu-preset-port-2026-09-30.md) §11.12.4 (mode-mass scale).
- **Probes:** [`analyse-loudphys-probe.py`](../development/diagnostics/analyse-loudphys-probe.py) (equal-mass keyboard
  sweep + factor dump), [`analyse-loudphys-variants.py`](../development/diagnostics/analyse-loudphys-variants.py)
  (single-factor preset variants), [`analyse-loudphys-attribution.py`](../development/diagnostics/analyse-loudphys-attribution.py)
  (attribution + regression, no GPU). Metric = dev-168c's: pre-volume `soundFloat` RMS over all output channels,
  30–300 ms of a 700 ms render, velocity 95 (`m_all`); `peak` = max |soundFloat|. Cross-process repeatability
  (identical preset, same warm-up set): ≤ 0.8 dB.

---

## 1. Executive summary

With **every hammer mass set equal (10 g)** the engine's per-pitch level spans **44.7 dB** on BaselinePreset1 and
**49.6 dB** on F15 (p95–p5: 32.6 / 36.6 dB) — exactly the mass range dev-168c had to apply. Physics says a
prescribed hammer-force pulse delivers its force to the bridge regardless of the string's linear density ρ or of the
simulation grid, so for equal `c·m·v` the keyboard should be even to within the curve-shape and soundboard terms.
The deficit is attributable, by measurement, to:

| # | Deviation | Where | Kind | Size (equal-mass keyboard) | Evidence |
|---|---|---|---|---|---|
| **D1** | String gain per unit hammer impulse ∝ **ρ·dx²** (should be ρ⁰·dx⁰) | `Kernels.cu:170` (`coeff_force = dec_inv·h[p]·dt²`, no `1/(ρ·dx)`) + `MainKernel.cu:700` (bridge force `T·Δy`, no `/dx`) | **code** | **28.8 dB** (BP1) / **32.2 dB** (F15) of spread; bass up, treble down | keyboard-wide ρ-equalisation moves every pitch by the predicted `20·log(ρ₆₀/ρₚ)` (83 pitches, mean error +1.0, std 1.6 dB); ρ,T×4 → +11.5…11.8 dB peak (pred +12.0); dx×2 → +10.3…13.5 dB; width×4 → 0 |
| **D2** | Every unison string receives the full `c·m·v` | `Pianoid_excitation.cu:72` (per-string coefficient table), `MainKernel.cu:741` (bridge forces summed) | **code** | **+9.5 dB** for 3-string pitches vs 1-string bass (physics: 0; FPGA: +4.8) | in-data steps at 1→2 and 2→3 strings: +5.8/+3.3 (BP1), +6.3/+4.3 (F15) vs predicted +6.0/+3.5; §3.4 |
| **D3** | Loudness at constant impulse is set by the pulse duration τ vs the period (`E ≈ J²/(2Z·τ)`, worse once reflections return during the contact); the engine conserves impulse and leaves τ(p) as free data. BP1: 2.46 ms at every pitch (≥ T₀/2 from middle C up, 10× the top-octave period); F15: 1.6 → 0.26 ms (FPGA) | preset `excitation` data; the June "loudness = impulse only" principle | **data** (+ a principle) | curve time ×0.5 → +8…+14 dB (BP1, every pitch), +7.5 / +30 / +14.5 dB (F15 p60 / p94 / p105); ×0.25 → +18…+23 dB (BP1). Explains BP1's top octave −13…−28 dB after D1 | §3.3 |
| **D4** | Soundboard modal transfer: template `stiffness = 0.1` for every mode ⇒ `mass_inv ∝ 1/f²` ⇒ velocity response ~1/f; F15 `Mass/f²·n_m²` with the absolute scale unmeasured (fpga-port §11.12.4) | preset `modes` data | **data** | BP1 (through the board): **28.9 dB** across the keyboard, **−4.0 dB/octave**; F15: 30.4 dB max−min, a +10…+18 dB bass boost (overdamped low modes), −1.2 dB/octave | measured as L(board tap) − L(bridge tap), §3.5 |

After **D1** alone the implied mass range drops from 44.7 → 31.9 dB (BP1) and 49.6 → 30.4 dB (F15); with D1 + D2 the
part of the keyboard whose curves are not quasi-static (f₀ < 2 kHz, 72 pitches of BP1) is flat to a residual of
**±7 dB** (max−min 14 dB, std 2.4–3.3 dB) — a realistic ~10× mass range. The remaining 20–30 dB are preset data
(D3, D4, and an open F15 bass-string residual), not code.

**Recommended fix order:** (1) fold the physical string gain `1/(ρₚ·dxₚ²)` (normalised at a reference pitch) into the
per-pitch excitation coefficient — host-only, exact, no kernel change; (2) divide the per-string coefficient by the
number of unison strings; (3) rescale each preset's excitation-curve time axis per pitch (contact time ∝ period^α, or
re-derive from the FPGA tables); (4) re-derive the mode mass law / absolute scale (D4) — a separate measurement;
(5) only then re-run the dev-168c equaliser and expect bass-heavy masses within 2–20 g.

---

## 2. The chain — physics vs code, step by step

Units: `J` N·s (impulse), `F` N, `ρ` kg/m, `T` N, `dx` m, `dt = 1/(sr·N)` s (sub-step), `h[p]` the per-node hammer
profile (unit SUM over nodes since dev-37f6), `y` displacement. "Physics" = the correctly discretised PDE the engine
documents (`y_tt = (T/ρ) y_xx − … + F/ρ`, SYNTHESIS_ENGINE.md) with a **prescribed** hammer-force pulse per pitch (the
gauss curves are data; the hammer–felt contact mechanics are outside the engine).

| Step | Physics (per pitch) | Code | Deviation |
|---|---|---|---|
| **1. Hammer → impulse** | `J = m·v` (momentum), per hammer | `coefficient[p][L] = c·m(p)·v(L)/(temporal·spatial)`; kernel force `f_n = coefficient·Σ gauss(t_n)`; delivered `Σ f_n·dt = c·m·v·dt_ref` (dev-f2b8) | none — shape-independent, N-independent (confirmed: delivered impulse identical for every pitch at equal mass) |
| **2. Force → string nodes** | Force per unit length `f(x,t) = F(t)·h[p]/dx`; node update `ρ·dx·Δv_p = F·h[p]·dt` ⇒ `Δy_p = F·h[p]·dt²/(ρ·dx)` | `MainKernel.cu:680` `dv += s_force_function[n]·coeff_force`, `coeff_force = dec_inv·h[p]·dt²` (`Kernels.cu:170`) ⇒ `Δy_p = f_n·h[p]·dt²` | **missing `1/(ρ·dx)`** — the code string behaves like a physical string driven by `F_eff = f·ρ·dx` (D1a) |
| **3. Contact width** | `h[p]` distributes the same `F` over the contact nodes | unit-sum `h[p]` (Hammer.py:181), floor 1.05·dx | none (width ×4 → −0.4 dB BP1, −0.1…−1.7 dB F15) |
| **4. String wave** | `c² = T/ρ`, stiffness `EI/ρ`, damping | `coeff_tension = T·dt²/(ρ·dx²)`, `coeff_bending`, `dec_curr` (Kernels.cu:136–149) — the homogeneous scheme is dimensionally correct; dt-scaled since dev-f2b8 | none for the level (frequency, inharmonicity, decay are per-pitch physical data) |
| **5. Bridge force** | `F_b = T·∂y/∂x = T·(y_{N−1} − y_N)/dx` | `MainKernel.cu:700` `force_on_bridge_point += shift_F1·(y[stem−1] − feedback)`, `shift_F1 = tension` (Kernels.cu:179) ⇒ `T·Δy` | **missing `/dx`** (D1b). Steps 2+5 together: code bridge force per unit prescribed hammer force `= ρ·dx²` × physics |
| **6. Feed-in to modes** | `F_n = φ_n(x_b)·F_b` summed over the struck strings; the hammer's `J` is shared by the n unison strings (`F_b,total ≈ F_b` of one string with the full `J`) | `feedin_cycle += mode_feedin·force_on_bridge_summed/soundStep` per string (`:741`); every string of the pitch is staged with the full coefficient (`Pianoid_excitation.cu:72`) | **×n** for n unison strings (D2): +6.0 dB (2), +9.5 dB (3). FPGA: hammer shape ÷√n |
| **7. Mode response** | `q̈ + 2γq̇ + ω²q = F/m_n`, modal mass `m_n` ~ constant (a fraction of the board mass), damping ζ ~ 1–3 % | `q[k+1] = (1−dec)[(2−ω²dt²)q − (1−dec)q_prev + mass_inv·F]` — the form is right; **data**: template `stiffness = 0.1` for every mode ⇒ `mass_inv = 0.1/(2πf)²`, i.e. effective modal mass ∝ f² (MODE_PHYSICS.md "why we did NOT fix the physics"); F15 `Mass/f²·n_m²` scaled so the strongest mode has the template `k` (fpga_preset_converter.py:197), decrements 0.4–41 | D4 — a frequency-dependent (hence pitch-dependent) transfer whose absolute law is uncalibrated; measured directly in §3.5 |
| **8. Output tap** | radiated pressure ∝ board velocity (or acceleration) at the listening point | `listen_to_modes=0`: output pitch 128+ch stem = `Σ feedback_row·q`, output = `Δq` per sample (`:601`), order 2 = `Δ²q`; `listen_to_modes=1`: output = `s_mode_applied_force` of the sound-channel "modes" = `Σ_strings mode_sound_channels[p]·F_b` — **the raw bridge force, no board** (`:775–781`) | none in form; note the two taps measure different physical quantities (BP1 ships with `listen_to_modes=1`) |
| **9. Scale** | — | `× main_volume_coefficient = volume_center·range^((L−64)/63)`, `output_scale` from one note (review I-1) | global, not per pitch |

So the engine's **gain per unit hammer impulse** carries a spurious per-pitch factor

```
G_code(p) / G_physics(p)  =  ρ(p) · dx(p)²  ·  n_strings(p)          (D1 × D2)
```

For BP1: `ρ` 0.157 → 0.0044 kg/m (A0 → C8, 31 dB), `dx = length/main` 5.5 → 6.8 mm ⇒ D1 = 27 dB bass-over-treble;
`n_strings` 1 (p23–32), 2 (p33–44), 3 (p45+) ⇒ D2 = +9.5 dB treble-over-bass. For F15 (`dx` 4.5 → 4.3 mm,
10–15 mm mid): D1 = 32 dB. These are the two **code** deviations; everything else in the spread is preset data.

### 2.1 Why D1 is ρ·dx² (derivation)

The interior update in summed form is `Δ(s_v) = … + f_n·coeff_force`, `s_v = v·dt`. With the physical forcing the same
increment is `Δ(s_v) = F_p·dt²/(ρ·dx)`, so the code integrates a physical string driven by node forces
`F_p ≡ f_n·h[p]·ρ·dx` (total `f·ρ·dx`, since `Σh = 1`). The string dynamics are linear and otherwise physical, so the
code's string state equals the physical state for a hammer force scaled by `ρ·dx`. The bridge force the code reads is
`T·Δy = dx·(T·∂y/∂x)`, another factor `dx`. Hence `F_b,code = ρ·dx²·F_b,phys` for the same prescribed hammer force —
independent of `T` (the `T` cancels: both sides read `T·slope`) and of the contact width (`Σh = 1`).

Physics then says the bridge force scale is independent of ρ and T for a prescribed force pulse: an ideal string
transmits a point force to its terminations (`F_b = Z·v`, `v = F/(2Z)` ⇒ `F_b = F/2` per direction); ρ and T set
the period, the spectrum and the decay, not the scale. The same holds for `dx`, which is a numerical choice (BP1 384-
point blocks, F15 512-point FPGA allocation).

---

## 3. Measurements

### 3.1 Equal-mass keyboard sweep (the engine's gain per unit hammer impulse)

Every key pitch rendered at velocity 95 with `hammer_mass = 10 g` everywhere (coefficient table rebuilt through the
load path, delivered impulse verified identical at every pitch). `D = 20·log(ρ·dx²)`, `N = 20·log(n_strings)`, both
relative to pitch 60.

| Preset (config) | measured L: max−min / p95−p5 / std | L − D | L − D − N | D alone | N alone |
|---|---|---|---|---|---|
| BaselinePreset1 (384/4, d1, `listen_to_modes=1` = bridge-force tap) | **44.7 / 32.6 / 10.1 dB** | 31.9 / 22.0 / 7.7 | 31.9 / 21.4 / 6.8 | 28.8 / 23.4 / 7.3 | 9.5 / 9.5 / 3.0 |
| F15_Elyashev_array512 (512/16, d1, `listen_to_modes=0` = through the board) | **49.6 / 36.6 / 11.4 dB** | 30.4 / 25.6 / 8.9 | 30.4 / 19.4 / 6.8 | 32.2 / 27.6 / 8.1 | 9.5 / 9.5 / 3.3 |

Single-term fits of `L` on `D`: slope **0.90** (both presets), i.e. the data follow `ρ·dx²` at 90 % of the full
coefficient 1.0 (the remaining 10 % is the RMS metric's decay sensitivity — see the peak column in §3.2).

Restricting BP1 to the 72 pitches with `f₀ < 2 kHz` (curves not quasi-static): the fixed-coefficient residual
`L − D − N` has std 3.3 dB (max−min 14.0, p95−p5 10.2), and a free fit gives `L = 1.26·D + 2.00·N` with R² 0.81,
residual std 2.4 dB. For F15 the same restriction gives R² 0.92 with D 1.26, N 2.9, residual std 2.4 dB.

Sampled rows (BP1; full tables in the probe outputs):

| pitch | L meas | D | N | L−D−N | ρ kg/m | dx mm | n_str | f₀ Hz |
|---|---|---|---|---|---|---|---|---|
| 24 | −2.2 | +15.9 | −9.5 | −8.6 | 0.1427 | 5.55 | 1 | 33 |
| 32 | −5.5 | +9.0 | −9.5 | −4.9 | 0.0666 | 5.44 | 1 | 52 |
| 33 | +1.3 | +10.0 | −3.5 | −5.2 | 0.0726 | 5.54 | 2 | 55 |
| 44 | −0.5 | +4.1 | −3.5 | −1.1 | 0.0255 | 6.63 | 2 | 103 |
| 45 | −7.3 | −6.0 | 0 | −1.3 | 0.0080 | 6.63 | 3 | 110 |
| 60 | 0.0 | 0.0 | 0 | 0.0 | 0.0069 | 10.10 | 3 | 254 |
| 72 | −3.5 | −4.0 | 0 | +0.5 | 0.0061 | 8.50 | 3 | 496 |
| 84 | −10.0 | −6.6 | 0 | −3.4 | 0.0054 | 7.76 | 3 | 955 |
| 96 | −22.1 | −9.3 | 0 | −12.8 | 0.0048 | 7.08 | 3 | 2560 |
| 106 | −39.0 | −10.8 | 0 | −28.2 | 0.0044 | 6.84 | 3 | 4593 |

The two unison steps are visible in the raw data: p32→33 (1→2 strings) **+6.8 dB** measured, of which D accounts for
+1.0 ⇒ **+5.8** (predicted +6.0); p44→45 (2→3 strings) **−6.8** measured, D −10.1 ⇒ **+3.3** (predicted +3.5). F15:
+6.5 (D +0.2 ⇒ **+6.3**) and −5.4 (D −9.7 ⇒ **+4.3**).

### 3.2 Single-factor experiments (one pitch at a time, everything else fixed)

| Variant (preset edit → own process) | code predicts | physics predicts | BP1 p36 / p60 / p84 (`m_all`; peak) | F15 p36 / p60 / p94 (`m_all`; peak) |
|---|---|---|---|---|
| ρ, T, jung ×4 (same c, f₀, CFL; impedance ×2) | **+12.0 dB** | 0 dB | +8.8 / +5.5 / +4.3; **peak +10.6 / +10.9 / +11.2** | +9.7 / +9.7 / −1.4; **peak +11.8 / +11.5 / +11.5** |
| `main` ×0.5 ⇒ dx ×2 (length fixed) | **+12.0 dB** | 0 dB | +10.3 / +10.3 / +3.0; peak +9.2 / +11.6 / +5.9 | +13.5 / +10.8 / +5.9; peak +14.7 / +12.3 / +9.6 |
| hammer width ×4 | 0 | 0 | −1.0 / −0.8 / −0.1 | −1.7 / −0.1 / +0.1 |
| tension ×4 only (f₀ ×2) | +12 (level) + period effects | 0 + period effects | −0.1 / −3.2 / −9.3; peak +2.2 / +4.2 / +3.7 | — |
| identical preset (noise floor) | 0 | 0 | −0.7 / −0.8 / −0.4 | — |

Reading: the **peak** follows the `ρ·dx²` law within ±1.5 dB of +12 in every bass/mid case; the 30–300 ms RMS is
1–7 dB lower because a string that pushes ×4 harder on the bridge also loses its energy to the modes faster (the
coupling loop gain carries the same spurious `dx` — §2 step 5 — so this is a second, smaller consequence of D1:
per-pitch decay). p84/p94 at 10–16 mm grid spacing are resolution-limited (contact 1–2 nodes, 2–3 nodes per
half-wavelength of the 4th partial), which is itself a reason not to let `dx` carry physics.

**Keyboard-wide ρ-equalisation (BP1).** Every pitch's ρ set to ρ(60) = 0.00689 kg/m with T and jung scaled by
the same factor (f₀, inharmonicity, CFL margin unchanged). Predicted shift `20·log(ρ₆₀/ρₚ)` from −26.3 dB (p24) to
+4.0 dB (p106); measured −26.4 … +1.5 dB; **over 83 pitches measured − predicted = +1.0 ± 1.6 dB (max 4.1)**,
measured spread 30.7 dB vs predicted 30.3 dB. **F15 (through the board): 88 pitches, measured − predicted =
−0.2 ± 1.2 dB (max 4.7), spread 30.9 vs 31.1 dB** — e.g. p21 −26.9 (pred −27.2), p42 −12.9 (−13.0), p108 +3.6 (+4.0).
This is the decisive test: nothing but ρ changed (strings keep their frequencies, inharmonicity and damping), and
the level moved by exactly the factor the code equations predict and physics forbids.

### 3.3 Curve duration (D3): impulse is conserved, energy is not

Every excitation curve of a pitch (all 128 levels, all 5 Gaussians) had its `mu` and `sigma` scaled by a factor;
the engine's coefficient rebuild keeps the delivered impulse `c·m·v` **identical** (verified in the dump), so the
only change is the pulse duration at constant momentum.

| Curve time × | BP1 p36 (65 Hz) | p60 (254 Hz) | p84 (955 Hz) | p96 (2.6 kHz) | p105 (4.6 kHz) | F15 p36 | p60 | p94 (1.7 kHz) | p105 (3.3 kHz) |
|---|---|---|---|---|---|---|---|---|---|
| base duration (sum/peak) | 2.47 ms | 2.46 | 2.47 | 2.46 | 2.46 | 1.62 ms | 0.90 | 0.45 | 0.26 |
| ×2 | −0.7 dB | +2.6 (peak +9.0) | +5.7 (peak +10.5) | — | — | **−5.0** | **−5.8** | **−15.2** | — |
| ×0.5 | — | **+8.2** (peak +11.8) | **+7.9** (peak +13.2) | **+9.7** | **+14.3** | — | **+7.5** | **+29.8** (peak +18.4) | **+14.5** |
| ×0.25 | — | **+22.2** (peak +20.4) | **+18.1** (peak +22.1) | **+20.6** | **+22.7** | — | — | — | — |

(noise floor for these pitch lists: ≤ 0.9 dB BP1, ≤ 1.8 dB F15.)

Reading. The engine conserves the strike's **impulse** (the hammer's momentum — correct), but a string's energy
uptake from a prescribed force pulse is `E ≈ ∫F²dt/(2Z) = J²/(2Z·τ_eff)` for a pulse shorter than the round trip,
and falls off much faster once the reflected wave returns during the contact (the pulse does negative work — the
quasi-static regime). So **at constant impulse the loudness is set by the pulse duration τ relative to the period
T₀**: 6–14 dB per halving in BP1 at every pitch (its 2.46 ms curves are already ≥ T₀/2 at middle C), 6–30 dB per
halving in F15 where the FPGA-derived curves are shorter but the treble sits at τ ≈ 0.5–1 T₀. The June principle
"loudness must depend on impulse only" (corrected-model doc §1) is the hammer's conservation law, not the string's
response: physics makes loudness `∝ J²/(Z·τ)`, and the engine has no hammer–felt model that would make τ follow
`m`, `v`, felt stiffness and `Z` — τ is free per-pitch **data**. Consequences: (a) BP1's constant 2.46 ms is
unphysical (real contact ~3–4 ms at A0, ~1–2 ms at C4, ~0.5–1 ms at C8) and is the dominant cause of its top-octave
deficit; (b) F15's curves follow the physical trend but the 0.26–0.45 ms treble pulses are still ≥ T₀; (c) any
"even keyboard from mass alone" presupposes physically graded τ(p) — otherwise the equaliser is silently
compensating pulse duration with mass.

The curve-spectrum predictor `Q = |F̂(f₀)|/F̂(0)` (attribution script) tracks this with correlation 0.6–0.7 and
slope 0.4–0.5 — directionally right, over-steep as an absolute law; the measured per-halving numbers above are the
usable calibration.

### 3.4 Unison count (D2)

Code path: `PlaybackCycleExecutor::stageStringsForPitch` stages every string of the pitch; `_append_string_gp`
writes `excitation_coefficients_[string·128 + vel]` — the full `c·m·v` — for each (`Pianoid_excitation.cu:72`); each
string's bridge force is summed into the mode drive (`MainKernel.cu:741`). Physics: the hammer's `m·v` is shared by the
n strings (the FPGA divides its hammer shape by √n, `fpga-to-gpu` §11.2). Measured, from the equal-mass sweeps at the
two string-count boundaries (D removed): **+5.8 / +3.3 dB (BP1), +6.3 / +4.3 dB (F15)** for 1→2 and 2→3 strings
against the predicted +6.0 / +3.5 dB.

A direct test (`hammer_offset = 10` to park the hammer beyond the string end on strings 2..n) could not be run: the
variant made **all** strings of the pitch silent (`n_contact 0`, `spatial_sum 0` on both presets). Cause, from source:
`Pitch.get_hammer_shapes` (Pitch.py:307) calls `PianoHammer.calculate_hammer_shape(offset)` once per string on the
**same** hammer object, which fills and returns its single `hammer_shape` array in place (Hammer.py:169, :184) — every
string of the pitch aliases the LAST string's profile, so a non-zero `hammer_offset` is wrong by construction (inert
today because every preset stores `hammer_offset = 0`). Recorded as a side defect (§6 R-note).

### 3.5 The soundboard term (D4), measured directly

Same preset, same equal masses, the other output tap: `L(listen_to_modes=0) − L(listen_to_modes=1)` is the modal
board's transfer from bridge force to output velocity, per pitch (relative to p60).

| Preset | board transfer across the keyboard | tilt | notes |
|---|---|---|---|
| BP1 (template modes, `stiffness = 0.1` ⇒ `mass_inv ∝ 1/f²`, 100 modes) | **max−min 28.9 dB, p95−p5 25.9, std 8.2**; p24 +10.7, p36 +6.2, p60 0, p84 −8.2, p96 −12.9, p106 −15.7 | **−4.0 dB/octave** (linear fit vs log₂ f₀) | BP1 ships with `listen_to_modes=1`, so this term is absent in its normal use; through the board its equal-mass spread would be 65.8 dB |
| F15 (FPGA modes, `Mass/f²·n_m²` host_max, decrement 0.4–41) | **max−min 30.4 dB, p95−p5 17.2, std 5.6**, not a tilt but a **bass boost**: p21 +9.7, p24 +15.0, p30 +17.6, p48 +15.1, p72 +13.8, p84 +5.3, p96 +7.2, p108 +2.5 (channel 0, `mode_sound_channels` weight divided out) | −1.2 dB/octave, per-pitch scatter ±6 dB | F15 ships with `listen_to_modes=0`, so this term IS in its level; its overdamped low modes (decrement 24–41) act as a broadband bass sink/radiator |

**F15 bass — an open residual.** At the bridge tap the F15 bass (p21–32, single strings) sits **−30 dB** below the
D1+D2 prediction (BP1's bass: −9 dB at the same tap); the board's +16 dB brings the shipped level to −13 dB. Peak-to-RMS
crest is ~15 dB on both taps for bass and mid alike, so this is a bridge-force *level* deficit of the converted
F15 bass strings themselves (364–370 points at 4.5 mm, `jung` −8e12 (BP1: −2e10), hammer at 0.12–0.13 of the
length, 15-node contact, 1.6–1.9 ms curves), not a decay artefact. It is not explained by any term in this doc and is
left as a measured open item for the FPGA-port follow-ups (fpga-to-gpu §12): render the F15 bass pitches with the
BP1 string physics (`jung`, hammer position/width) one factor at a time.

Physics reference: a piano soundboard's driving-point mobility is roughly flat (±6 dB) from 50 Hz to 2 kHz and
its radiation efficiency rises towards coincidence (~1–2 kHz), i.e. the physical board does **not** cut the treble by
4 dB per octave. The template's constant-stiffness law gives every mode the same static compliance, so velocity
response falls as ~1/f — a **data** deviation of the same order as D1 (≈ 29 dB over the keyboard) for any preset that
listens through the board with template modes.

---

## 4. Preset data: physical or not

| Datum | BP1 | F15 | Physical? |
|---|---|---|---|
| String linear density ρ | 0.157 (A0) → 0.0044 kg/m (C8) | same (template) | yes — a wound A0 string is ~0.1–0.2 kg/m, 0.8 mm steel is 0.0039 kg/m |
| Tension | 1630 N bass, ~650 N mid, 1719 N at C8 | 1800 / 665 / 1295 N (FPGA `ttn` rescaled to the template geometry) | plausible (real 700–1000 N mid, up to ~2 kN bass); treble high |
| Speaking length | 1.65 m → 68 mm | same | yes |
| Grid `dx = length/main` | 5.5 mm bass, 10–14 mm mid, 6–9 mm treble (set by the 384-point block budget) | 4.5 mm bass, 9–15 mm mid, 4.3 mm treble (FPGA allocation) | **numerical, not physical** — and it sets the level through D1 |
| Hammer contact width | 5–10 mm (≈ 1–2 nodes) | 17–68 mm (4–15 nodes, FPGA cap) | real felt contact ~10–20 mm; harmless for level (unit-sum) |
| Excitation-curve duration (sum/peak) | **2.46 ms at every pitch** | 1.9 ms (A0) → 0.25 ms (C8) | BP1 **no** (real contact ~3–4 ms bass → 0.5–1 ms treble; a 2.5 ms pulse on a 0.22 ms period is quasi-static); F15 follows the trend but the top octave is still ≥ 1 period |
| Unison strings | 1 / 2 / 3 | 1 / 2 / 3 (FPGA) | yes — but the engine triples the impulse (D2) |
| Mode mass law | `stiffness = 0.1` for all 100 modes ⇒ `mass_inv = 0.1/(2πf)²` | `Mass/f²·n_m²`, strongest mode at the template `k`, 196 modes | **no** absolute calibration on either (MODE_PHYSICS.md keeps the legacy convention; fpga-port §11.12.4 "needs measurement") |
| Mode damping | `damping` 1e-7…1e-5 (template) | decrement 0.4–41 (FPGA, deliberately damped, τ 0.3–0.6 ms) | FPGA-derived; the template is arbitrary |
| Output rows | 1.0 everywhere, sc gain 40 | `decka·Ci_str_1_out/n_m`, scaled to the template max | per-channel weighting, not per pitch |
| `hammer_mass` (before dev-168c) | 11.8 → 4.2 g graded | 2.98 → 124 g (rank-1 fit of the FPGA's own `ind_vol·v_L` loudness table) | F15's fitted masses already encode the FPGA designer's hand compensation of the same ρ-less algorithm (the FPGA injects force in displacement units too) |

---

## 5. Deviations ranked, with the expected mass range after each correction

"Implied mass range" = the per-pitch `hammer_mass` a flat keyboard needs at the measured level (`m ∝ 10^(−L/20)`,
median pinned to 10 g), i.e. what dev-168c's equaliser would write. A real piano needs ~4–12 g (10 dB), bass heavy.

| Rank | Deviation | Kind | dB contribution to the equal-mass spread | Implied mass range after removing it (cumulative) |
|---|---|---|---|---|
| 1 | **D1 string gain ∝ ρ·dx²** (steps 2 + 5) | code | 28.8 dB (BP1) / 32.2 dB (F15), monotone bass → treble; slope 0.90 measured | BP1 44.7 → **31.9 dB** (4.5–175 g); F15 49.6 → **30.4 dB** (3.8–127 g). The remainder is the top octave (D3) and, for F15, the bass (board scatter D4 + the open bass-string residual, §3.5) |
| 2 | **D3 curve duration vs period** (loudness ∝ `J²/(Z·τ)` at constant impulse; BP1's τ is constant 2.46 ms) | data (+ the "impulse = loudness" principle) | measured 6–14 dB per halving of τ (BP1, all pitches), 6–30 dB per halving (F15); the BP1 top octave is −13 … −28 dB after D1 and the F15 top octave −7 … −23 dB | with D1 + D2 removed the f₀ < 2 kHz keyboard is already within **~14 dB max−min, p95−p5 10 dB** (≈ 4.5–22 g); re-timing the top-octave curves by ×0.25–0.5 (= +10…+23 dB measured) brings it into the same band |
| 3 | **D2 unison ×n** | code | +9.5 dB treble-over-bass (masks ~a third of D1 in the bass; makes the bass look *less* deficient than it is); four in-data steps confirm +6.0/+3.5 | shifts the bass down by 6–9.5 dB once D1 is fixed — needed so the corrected keyboard does not come out bass-heavy by 9.5 dB (p95−p5 22.0 → 21.4 BP1; 25.6 → 19.4 F15) |
| 4 | **D4 soundboard transfer / mode mass law** | data | BP1 template board: 28.9 dB across the keyboard (−4 dB/octave) — absent in BP1's shipped `listen_to_modes=1`, present for any preset listened through template modes; F15 board: 30.4 dB max−min, a +10…+18 dB bass boost with ±6 dB per-pitch scatter; it *hides* a −30 dB bridge-force deficit of the converted F15 bass strings (open residual, §3.5) | F15 after D1 + D2 (shipped tap): 4.1–135 g (p95−p5 19.4 dB), f₀ < 2 kHz 4.6–61 g (p95−p5 16.5); the board's scatter and the bass-string residual are the remaining F15-specific data items |
| 5 | D1b's second face: string→board coupling loop gain ∝ dx (bridge force `T·Δy`) | code | per-pitch decay/coupling, 10–12 dB RMS deficit measured when the bridge force is ×4 (§3.2 peak-vs-RMS gap) | not a mass-range item; a decay-rate item (follow-up measurement) |
| 6 | Curve-shape concentration C (peak/impulse) | data | 0.7 dB (BP1), 17.8 dB (F15, bass curves 1.9 ms vs treble 0.25 ms) — but it is largely the same physics as D3 (shorter pulse ⇒ sharper peak) | folded into D3 |
| 7 | `dx` resolution in the top octave (10–16 mm, 1–2 contact nodes, 2–3 nodes per half-wavelength of the 4th partial) | numerical | p84/p94 single-factor tests under-respond by 6–9 dB | second-order; argues for a per-pitch `dx` policy independent of block packing |

Not deviations (verified): delivered impulse `c·m·v` is exactly shape-, width- and N-independent (step 1, dev-f2b8 /
dev-37f6 confirmed); hammer width is inert for level; `string_iteration` is inert (review I-5).

---

## 6. Recommended corrections (order of value / safety)

| # | Correction | Where | Expected effect | Effort / risk |
|---|---|---|---|---|
| **R1** | **Physical string gain in the coefficient.** Multiply each pitch's excitation coefficient by `g(p) = (ρ_ref·dx_ref²)/(ρ(p)·dx(p)²)` (reference = pitch 60 of the preset, so `c` and every calibrated `output_scale` keep their meaning at the calibration note). Compose it as a 6th factor in `pack_excitation_factors` (`StringMap.py:610`) / `CoefficientCache`, recomputed when ρ or the geometry changes; store nothing new. | PianoidBasic `StringMap.pack_excitation_factors` + `compose_excitation_coefficient`; `CoefficientCache` kinds `rho`/`geometry` | removes D1 exactly (level only — the string dynamics are unchanged, so decay, pitch, CFL are untouched). BP1 spread 44.7 → 31.9 dB; F15 49.6 → 30.4 dB. Recalibrate `output_scale` per preset afterwards (R-A of the June doc). | S (host Python, wheel rebuild); no kernel change; byte-identical at the reference pitch |
| **R2** | **Divide by the unison count.** `coefficient[p][L] /= n_strings(p)` (physics: the hammer's `m·v` is shared), or `/√n` if the FPGA convention is preferred (document which). | same place as R1 | removes D2: bass +9.5 dB relative to 3-string pitches after R1 (otherwise the R1-corrected keyboard is bass-heavy) | S |
| **R3** | **Re-time the excitation curves per pitch** (and state the principle correctly: the engine conserves impulse; loudness then follows `J²/(Z·τ)`, so τ(p) is loudness data). Scale every pitch's `mu`/`sigma` so the pulse duration follows the period (e.g. `τ(p) = clamp(k·T₀(p), 0.4 ms, 4 ms)` with k ≈ 0.3–0.5, or re-derive from the FPGA tables where available). Measured sensitivity: ×0.5 → +8…+14 dB (BP1), ×0.25 → +18…+23 dB; so the BP1 top octave (−13…−28 dB after D1) is recovered by ×0.25–0.5. | preset data (BP1 and the Belarus family); converter option for FPGA presets | removes D3; brings the top octave into the ±7 dB band of the rest | M (data + listening); changes the treble attack timbre — the user decides the k |
| **R4** | **Mode-mass law / board transfer.** Measure the board transfer directly (this doc §3.5 gives the per-pitch `listen_to_modes` 0 vs 1 difference) and either (a) calibrate the modal masses so the bridge-force → output transfer is flat ±6 dB across the keyboard (constant modal mass ⇒ `mass_inv` independent of f), or (b) keep the FPGA relative law and add a per-mode gain. Ties into the open absolute-scale item of the FPGA port (§11.12.4). | preset data + `fpga_preset_converter.mode_mass_inv` | removes D4: the −4 dB/octave template tilt (29 dB) for board-listening presets and F15's ±6 dB per-pitch board scatter; the F15 bass-string residual (§3.5) is a separate converter item | M; needs a design decision (physical board vs FPGA fidelity) |
| **R5** | **Bridge-force readout `/dx`** (make `shift_F1 = T/dx`) — the physically right form of step 5, which also fixes the per-pitch string→board coupling (rank 5). Keep R1 as the level fix and treat this as a separate measured change: it rescales every `feedin`/`mass_inv` by ~1/dx (×100–250) so presets must be re-normalised together. | `Kernels.cu:179` + preset migration | per-pitch decay consistency | M (CUDA + migration); do after R1–R4, with a decay-rate sweep as the surface |
| **R6** | Per-pitch `dx` policy (points per string chosen for ≥ 8 nodes per half-wavelength of the 8th partial rather than by block packing) and the hammer floor; the F15 treble at 16 points / 4.3 mm is at the edge | preset generators | removes rank 7 | S–M, data |
| **R7** | Re-run the dev-168c equaliser only after R1–R3 (and R4 for F15). Expect bass-heavy masses in a ~10 dB range; keep the equaliser as the last-mile trim, not as the physics. | — | — | — |
| R-note | Fix `Pitch.get_hammer_shapes` / `PianoHammer.calculate_hammer_shape` so each string gets its own profile copy (today every string aliases the last string's array; `hammer_offset ≠ 0` silences the pitch). Inert for shipped presets; blocks per-string hammer experiments. | PianoidBasic `Hammer.py:169–184`, `Pitch.py:307–313` | correctness | S |

**Expected per-pitch mass range after each step** (equal-mass data, median 10 g): as measured 3.4–590 g (BP1) /
1.4–430 g (F15) → after R1 4.5–175 / 3.8–127 g → after R1+R2 the f₀ < 2 kHz keyboard sits within ~14 dB (≈ 4–20 g);
the top octave needs R3 (×0.25–0.5 curve time = +10…+23 dB measured, which is the size of its residual); F15
additionally needs its bass-string residual resolved (§3.5, −13 dB through the board) and R4 for the ±6 dB board
scatter. A bass-heavy 2–20 g keyboard (the user's target) is reachable only with R1–R3 together;
none of them is a tuning knob — each is a specific equation or datum.

---

## 7. Evidence index

- Kept evidence: [`analyse-loudphys-results.txt`](../development/diagnostics/analyse-loudphys-results.txt) (the full
  per-pitch attribution tables + every single-factor variant, both presets) and
  `docs/development/diagnostics/analyse-loudphys-renders/` (`bp1_base.json`, `bp1_ltm0.json`, `f15_base.json`,
  `f15_ltm1.json`: the four equal-mass keyboard sweeps with mode/deck dumps). Re-run:
  `PianoidCore/.venv/Scripts/python docs/development/diagnostics/analyse-loudphys-probe.py <preset> <array> <si> <deriv> <ltm> out.json --dump`
  then `analyse-loudphys-attribution.py out.json --preset=<preset> [variant_out.json:label …]`.
- Source anchors: `Kernels.cu:136–179` (coefficients; `coeff_force` :170; `shift_F1 = tension` :179),
  `MainKernel.cu:680` (force injection), `:700–702` (bridge force), `:741` (feed-in `/soundStep`), `:775–781`
  (`listen_to_modes` tap = bridge force), `:789–793` (mode update), `:601–618` (output tap);
  `Pianoid_excitation.cu:72` (per-string coefficient); `Hammer.py:163–183` (unit-sum profile);
  `StringExcitation.py:63–91` (coefficient), `:545–561` (`level_impulse`); `StringMap.py:558–661` (factors);
  `StringState.py:47` (`dx = length/main`); `Mode.py:127–136` (`stiffness = 0.1` seed law);
  `fpga_preset_converter.py:197–213` (`mode_mass_inv` host_max), `:264–283` (deck normalisation `n_m`).
- Docs: SYNTHESIS_ENGINE.md (FDTD, coefficient table, dev-f2b8 impulse/dt, output), MODE_PHYSICS.md (mass_inv
  convention), fpga-to-gpu-preset-port §11.2 (`Mass/f²`, `ind_vol·v_L`, `FB ÷√n`), §11.12.4, §12 finding 2.
- dev-168c session log (`docs/development/logs/dev-168c-2026-10-04-144434.md`): equalised masses 3.29–241 g (BP1),
  1.93–582 g (F15); `shape sigma ×1.3` → −0.9 dB mid / −9.1 dB at p87 (F15) — the D3 sensitivity seen from the other side.
