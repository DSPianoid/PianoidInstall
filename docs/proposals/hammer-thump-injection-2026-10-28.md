# Hammer "thump" injection: candidate architectures (design only)

**Status:** Option F (§9, one shared thump string) APPROVED 2026-10-29 and IMPLEMENTED by dev-thump1 on `feature/dev-thump1-*` (Basic `thump_string.py`, Core host C++ `addThumpToBatch` + `thump_config.py`, Tunner Thump bar) — NOT merged; live listen pending. Options A–E remain proposals. Engine doc: [SYNTHESIS_ENGINE → Thump string](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#thump-string-keybed-dev-thump1).
**Date:** 2026-10-28
**Trigger:** user request "Propose several ways to structure the thump injection function. Try to make it the most compatible with real physics."
**Evidence:** assistant feature request `PianoidCore/logs/reports/bugreport-2026-10-25T19-17-39-802Z-assistant-app_bug-5e2c20fd8e46142c.json`, and `D:\modal_measurements\assistant-sessions\2026-10-25\TUNING_NOTE.md`.

---

## 0. The problem, in measured terms

From the feature request (mic captures of the user's piano and of Pianoid, same rig). The metric is the band level 50–200 Hz in the first 30 ms after onset minus the same band at 0.5–1 s:

| Note | Real piano | Pianoid | Gap |
|---|---|---|---|
| C4 | **+27 dB** | +1 … +4 dB | ~24 dB |
| G4 | **+27 dB** | +3 dB | ~24 dB |
| A2 | +6 dB | +2 dB | ~4 dB (f1 = 110 Hz sits inside the band, so the body is loud there as well) |

The assistant changed hammer width (0.04 → 0.012 m), halved the pulse sigma and fitted a multi-component pulse. The gap did not move. The feature request concludes that no preset parameter can produce the thump, because the soundboard is driven only through the strings.

The tuning note adds one fact that matters here: hammer_position was moved from ~0.29 to 1/9 (0.111), and "the key got ~10 dB quieter". This is relevant to option A below, because the bridge's quasi-static share of the hammer force is `x_h/L`. It fell from 0.29 to 0.11, which is −8.4 dB.

---

## 1. What the engine does today (confirmed in source)

Docs: [SYNTHESIS_ENGINE.md](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md) ("Wave Equation", "Mode Simulation", "String–Mode Coupling", "Excitation System"); [pianoid-basic OVERVIEW](../modules/pianoid-basic/OVERVIEW.md) (StringGeometry, string_gain).

- **String layout.** Each string is laid out as `main | stem(2) | tail`. The bridge sits at index `main` (`StringState.py:71`, `bridge(i) = p_main() + i`). The hammer centre is `position` measured from index 0, the non-bridge (agraffe) end (`Hammer.py:171`). So `hammer_position = 0.111` puts the strike 1/9 of the speaking length from the agraffe, as in a real grand.
- **Bridge boundary.** The stem points are not integrated. Their displacement is overwritten with the summed mode feedback (`MainKernel.cu:696-699`). This is a displacement-driven (board-compliant) termination.
- **Bridge force.** It is the full tension × slope at the termination, accumulated over every sub-step on both sides (main and tail): `force_on_bridge_point += shift_F1 * (s_a[p∓1] − feedback)` (`MainKernel.cu:710-714`). `shift_F1` is the packed tension (`Kernels.cu:180`).
  - This is **not** a "dynamic slope only" coupling. Nothing in it high-passes the force. The quasi-static component of the hammer force is therefore transmitted in principle.
  - For a string fixed at the agraffe, the long-time average of the bridge force (its spectrum at f → 0) equals `J · x_h/L`, where `J` is the delivered hammer impulse. That holds whatever the string dynamics, by momentum balance, minus a small share lost to the viscous γ term.
- **Feedin.** `feedin_cycle_matrix += mode_feedin · force_on_bridge_summed / soundStep` (`MainKernel.cu:752`). It is reduced to `F_applied` per mode, and the oscillator advance adds `appliedForce · mode_mass_inv` (`MainKernel.cu:807-816`).
- **The hammer is a prescribed force**, not a mass. `gaussKernel` precomputes `force_function` (5 Gaussians, 7 × 1.333 ms window) and injects `force · coeff_force · hammer[p]`. Nothing carries the reaction of the hammer, key or action anywhere. The only path into the board is string → bridge.
- **Low modes are present and coupled.** In the tuning preset `Tuning18-10-26ver1_work_assistant_11.json`, 9 modes lie below 250 Hz: 66.6, 94.8, 133.2, 140.3, 174.5, 189.0, 198.8, 220.1 and 232.1 Hz (measured, ζ ≈ 0.8–3 %). C4's deck feedin to those modes is 1.09, 0.47, 0.32, −0.76, 0.51, 0.35, −0.93, 0.81 and 0.98. **The board has the right modes and they couple strongly at C4's bridge position.** What is missing is the force that kicks them at the attack.
- **Direct mode access exists** but only as a test tool. `exciteMode` / `addModeExcitation` *overwrite* `(q, q_prev)` with a synchronous `cudaMemcpy` (`Pianoid_excitation.cu:85-121`). This is usable for an offline experiment from rest, not for live injection.
- **Note-on path.** `EventDispatcher.cu:116` → `PlaybackCycleExecutor::stageStringsForPitch` (`PlaybackCycleExecutor.cu:55`) → `addStringToBatch` (`Pianoid_excitation.cu:202`). The engine closes the cycle with one `commitStringBatch` (`Pianoid_excitation.cu:227`), under the single-envelope-per-cycle invariant.

**So the honest answer to "does the coupling already transmit the bridge-force thump?"** Structurally, yes: the slope-based force carries the sub-fundamental floor `J·x_h/L`. Quantitatively, this has not been checked, and the measured +1…4 dB says it is either far too weak or masked. See option A and Step 0b.

---

## 2. Real-piano physics: where the thump comes from

Citations below are from memory. The numeric values are approximate ranges and must be checked against the papers before any default is frozen.

1. **Hammer–string contact force through the bridge** (Askenfelt & Jansson 1993, *JASA* 93(4); Chaigne & Askenfelt 1994, *JASA* 95; Giordano 1998, *JASA* 103(4), on soundboard impedance).
   - Contact lasts about 4 ms in the bass, about 2 ms in the mid-range and under 1 ms in the top treble at mf, and shortens with velocity.
   - The bridge receives a force pulse with a broadband low-frequency content of about `J·x_h/L`, and the board's low modes ring it out.
   - Commuted synthesis gets the "knock" exactly this way: it feeds the hammer-force pulse through the soundboard/body impulse response (Smith & Van Duyne 1995, "Commuted piano synthesis", ICMC; Van Duyne & Smith 1995, "Developments for the commuted piano", ICMC).
2. **Key bottoming on the keybed (front-rail punching).** The key stops against felt on the keybed. The impact goes keyframe → keybed → rim/case → soundboard edge, and the case radiates too.
   - Askenfelt & Jansson 1990 (*JASA* 88(1), "Timing in the grand piano action") and Goebl, Bresin & Galembo 2005 (*JASA* 118(2)) put key-bottom contact within a few ms of hammer–string contact. The sign of the offset depends on dynamics.
   - Askenfelt 1993 ("Observations on the transient components of the piano tone", SMAC 93) treats the keybed knock and the finger–key "touch" noise as audible parts of the attack. The touch noise occurs only with struck/staccato touch, tens of ms *before* string contact.
3. **Action reaction forces.** These are the jack accelerating the hammer, the escapement/let-off, and the **backcheck catching the rebounding hammer** some tens of ms after the strike (Askenfelt & Jansson 1991, *JASA* 90(5); Hirschkorn, McPhee & Birkett 2006, *J. Comput. Nonlinear Dyn.* 1(1)).
   - These reach the board through balance rail → keyframe → keybed → rim. They are weaker than the keybed impact and mostly happen before the strike.
4. **Agraffe / plate reaction.** By the lever rule, the remaining `(1 − x_h/L)` of the hammer's quasi-static force goes into the agraffe and the iron frame (≈ 8/9 at a 1/9 strike point). The frame is stiff and massive and bolted to the rim, so transmission into the board is weak but not zero.
5. **Longitudinal / phantom components** (Conklin 1996, *JASA* 100(3); Giordano & Korty 1996, *JASA* 100(6); Bank & Sujbert 2005, *JASA* 117(4); Chabassier, Chaigne & Joly 2013, *JASA* 134(1)).
   - The tension modulation ∝ ∫y_x² gives a longitudinal bridge force with a quasi-DC "stretch" pulse at the attack, plus longitudinal modes and phantom partials (kHz range in the bass).
   - It acts mostly along the string, so it reaches the board only through bridge rocking and downbearing. **It is not the cause of a 50–200 Hz, 25 dB thump.** It belongs to a separate proposal (nonlinear tension term) and is out of scope here.

Hammer felt contact law, used for every pulse model below: Hunt & Crossley 1975 (*J. Appl. Mech.* 42); Boutillon 1988 (*JASA* 83(2)); Stulov 1995 (*JASA* 97(4)). The law is `F = K·δ^p (+ λ·δ^p·δ̇)` with p ≈ 2–3.5. For a power-law contact hit at speed v by an effective mass M, energy balance gives:

```
δ_max ∝ v^(2/(p+1))      F_max ∝ v^(2p/(p+1))      τ_contact ∝ v^((1−p)/(p+1))      J ≈ (1+e)·M·v
```

At p = 2.5: F_max ∝ v^1.43 and τ ∝ v^−0.43. Fortissimo is shorter and brighter: the pulse spectrum extends to higher frequency.

---

## 3. A shared building block: the Board Force Injector (BFI)

Options B to E all need the same small piece of engine: **add an external, time-limited force to `F_applied` of selected modes.** It is described once here.

**Data**

- `dev_thump_pulse` (TUNABLE, preset region): the pulse shapes `P[shape][velocity_level][t]`, up to `L = 512` samples (10.7 ms at 48 kHz). Python precomputes them from the contact law (half-sine, Hann or Hunt–Crossley integrated in a 1-DOF ODE). The kernel only reads the table, so the physics stays in Python.
  - Size: 128 levels × 512 × 4 B ≈ 256 KB per shape, or 6 anchors with linear interpolation, as `gauss_params` already does.
- `dev_thump_coupling` (TUNABLE): `C[row][mode]`, about 0–1 like the deck. The rows are a few named injection points: rim/keybed, frame, and optionally one per register. Per-key gain is a separate `g[pitch]` vector.
- `dev_thump_events` (WORKING): at most 32 active events. Each holds `{start_cycle, start_offset, shape, vel_level, amplitude, row}`. Events are written at note-on inside the existing batch envelope (one more small `cudaMemcpy` in `commitStringBatch`).

**Kernel.** In the oscillator advance (`MainKernel.cu:808`), the owner thread of each mode does:

```
t_k = (cycle − start_cycle_k)·samplesInCycle + main_cycle_index − start_offset_k
appliedForce += Σ_k  amp_k · g[pitch_k] · C[row_k][ownedModeNo] · P[shape_k][vel_k][t_k]    (0 ≤ t_k < L)
```

- Load the event table into shared memory once per launch. A uniform branch on `numActive == 0` keeps the existing path bit-identical.
- Cost: K_active FMAs plus one table read per mode per sample. Typically K ≤ 4. Compared with the FDTD (≈ 512 points × string_iteration × ~12 flops per block per sample), that is **under 0.5 %**.
- **Constraint: shaped-tier modes only.** The flat tier (`FlatTier.cuh`) shares one uniform force `s_flat[2]`. The low modes must be in the shaped tier. Verify `ModeLayout` for that before implementing.

**Zero-per-sample variant: "modal kick".** The board is linear, and a lightly damped mode only "sees" the pulse spectrum at its own frequency. So after the pulse ends (t > τ), the response of mode n to a pulse p(t) is exactly a free oscillation. Its complex amplitude is `mass_inv_n · C_n · P̂(ω_n)`, with the phase from the pulse's delay. The host can compute `Δq_n` and `Δq_prev_n` analytically, and the kernel *adds* them once, at the event sample.

- Exact after the pulse. During the first τ (1–8 ms) the pulse itself is missing, which is inaudible for a 50–200 Hz thump.
- Event cost: about one FMA per mode, once.
- It needs an *additive* kick. The present `exciteMode` overwrites state and is synchronous, so it cannot be used live.

**Invariants**

- The thump is an external force on a stable linear system, so it **cannot change loop gain or stability**, even with `deck_feedback_coefficient` 10000.
- The board energy it adds does flow back into the strings through feedback. That is physical: the knock excites undamped strings, which matters with the sustain pedal.

---

## 4. Candidate architectures

### A. Bridge-force path (verify and tune what exists, plus an optional frame-reaction term)

**Physics.** The hammer pulse travels to the bridge, and the bridge force's sub-fundamental content (`≈ J·x_h/L`, flat below f1) kicks the low board modes. This is the commuted-synthesis knock, produced here by the physical model itself.

**Status.** Present in the equations (§1). It is the only one of the five options that is already "free". The open question is purely quantitative: why does it give +1…4 dB instead of +27 dB? Candidates, to be measured rather than guessed:

1. `x_h/L = 0.111` gives a small lever. The tuning note already shows a 10 dB level drop when the hammer moved from 0.29 to 1/9.
2. The displacement-driven stem (`target = feedback`) lets a compliant board relieve the static load.
3. The 7 × 1.33 ms Gaussian window may shape the pulse so that its low-frequency content is small relative to the partial peaks.
4. In the bass, the low-frequency band is masked by f1 itself (A2).
5. The rig speaker may not reproduce < 80 Hz, so the *mic* metric cannot see a thump the engine does produce. **Check the engine output, not only the mic.**

**Optional structural add: frame/agraffe reaction (A′).** Compute `F_agr = T·(y[1] − 0)` at index 0 in the same inner loop, at the same zero-cost place as the stem force. Project it through a "frame" coupling row with a small gain `r_frame`. This is the other `(1 − x_h/L)` of the force, which today vanishes into a rigid support.

**Force model.** None new: it is the existing gauss pulse, with impulse `c·m·v·G`. A′ uses the string's own slope.

**Injection.** For A, the existing deck feedin row at the bridge. For A′, a new `C[frame][mode]` row: the measured or estimated mode shape near the plate's rim bolts. This is unmeasured today.

**Tuner parameters.** For A: none new (hammer_position, pulse shape, deck). For A′: `r_frame` (dimensionless ratio, default 0 = off, fitted range 0–0.3) and the `C[frame]` row.

**Engine.** A has no change. A′ adds about 2 lines in the inner loop (`MainKernel.cu:710-714` area) plus a frame accumulator reduced like `force_on_bridge_summed` and fed to the BFI. It is C++/CUDA and needs a rebuild.

**Conventions.** Fully consistent: the force comes from the same delivered impulse, so it is shape-independent by construction.

**Risk / effort.** The measurement is low risk and about 0.5 day, Python only (Step 0b). A′ is about 1–1.5 days of C++ plus the BFI.

**Expected gain.** A alone will very likely **not** close a 24 dB gap. A real piano has the same lever and still needs the keybed/action paths, and the assistant's pulse experiments did not move the metric. Knowing how much A contributes sets the budget for B to D.

### B. Key-bottom (keybed) impact through a rim/keybed coupling vector

**Physics.** The key and finger hit the keybed felt. The force goes keyframe → keybed → rim → soundboard edge (and case radiation). This is a separate impact with its own felt, mass and timing. It is the main candidate for the thump in the literature (§2.2) and the most physical addition.

**Force model.** Felt contact of effective mass `M_kb` (key plus the finger/hand share) at key-front speed `v_k = v_h / R_action` (R ≈ 5–6):

- **Shape:** Hunt–Crossley pulse, precomputed per velocity level. Fallback: a Hann (raised-cosine) pulse. Avoid the half-sine: its slope jumps at the edges, and with `sound_derivative_order = 2` (acceleration output) those jumps become clicks.
- **Duration:** `τ_kb(v) = τ_kb0 · (v_h/v_ref)^((1−p_kb)/(p_kb+1))`.
- **Impulse:** `J_kb(v) = r_kb · (c·m_h·v_h)`. It is tied to the same hammer-momentum convention as the string, so a velocity curve or loudness-calibration change moves both together.
- **Optional press term:** after the impact, the finger keeps pressing, which is a small force step with a rise time of about τ. It excites the lowest modes like a step.
- **Timing:** `t_kb = t_strike + Δt_kb(v)` with `Δt_kb(v) = d0 + d1·log(v_ref/v_h)`. A negative Δt (key bottoming before string contact) cannot be honoured live, because note-on is the earliest knowledge. Clamp it to 0 live; offline playback can honour it.

**Injection.** The row `C[keybed][mode]` is the board's mode shape at the keybed/rim attachment, max 1 like the deck.

- **Best source:** measure it. The existing modal rig (exciter coil plus PolyMAX/ESPRIT, `D:\modal_measurements`) can drive or sense at the keybed/rim point. The measured table already stores mode-shape samples per channel (`measured_modes_build.measured_table.modes[].channels`), so one more channel at the rim gives this row directly.
- **Interim:** fit per-mode weights for the 9 modes below 250 Hz from the recording (§6).
- **Optional:** 2–4 dedicated **body/case modes** (for example 40–150 Hz, Q 5–20). These are ordinary entries in `modes[]` with **zero feedin from strings** and non-zero feedback to the output pitches. Only the thump drives them. They need no new data structure beyond the BFI.

**Tuner parameters** (preset `model_parameters.thump.keybed`):

| Param | Unit | Default (to fit) | Meaning |
|---|---|---|---|
| `enabled` | bool | false | Opt-in; existing presets stay bit-identical |
| `r_kb` | – (ratio to hammer impulse) | 0.5 | Keybed impulse strength |
| `tau_kb0` | ms | 4.0 at v_ref = 2.4 m/s | Felt contact duration |
| `p_kb` | – | 2.5 | Felt stiffness exponent (sets the τ(v) and F(v) laws) |
| `d0`, `d1` | ms | +1.0, 0 | Delay after the strike |
| `press` | – (ratio) | 0 | Finger-press step |
| `C[keybed][·]` | 0–1 | fitted or measured | Rim coupling per mode |
| `g[pitch]` | dB | 0 | Per-key trim (register-smoothed) |

**Engine.** BFI only. The producer is `stageStringsForPitch` → new `Pianoid::addThumpToBatch(pitch, velocity)`, inside the same envelope. Per-cycle GPU cost is under 0.5 % (zero with modal kicks). It uses the existing mode state.

**Conventions.** A separate energy channel, **not** part of `c·m·v·G`. The string's impulse conservation and shape-independence are untouched. The thump depends on velocity and key only, not on the Gauss curve or hammer width. Run `output_scale` calibration and per-pitch equalization with the thump **disabled**, so existing calibrations keep their meaning, and document that.

**Risk.** Medium-low. The ModeLayout indexing (shaped vs flat) has to be right. The rim coupling is unmeasured. The live delay is clamped.

**Effort.** C++/CUDA BFI about 2–3 days, PianoidBasic schema and pulse precompute about 1 day, middleware/REST about 0.5 day, tuner panel about 1–2 days. Heavy rebuild plus wheel.

### C. Action reaction (launch / escapement / backcheck catch)

**Physics.** Reaction forces in the action reach the keyframe:

- the jack drive, which is before the strike, so it is unavailable live;
- let-off, a few ms before the strike;
- the **backcheck catch**: the rebounding hammer is caught some tens of ms after the strike. This one is honourable live.

**Force model.** Each is a small Hann/Hunt–Crossley pulse. The backcheck pulse has impulse `≈ (1+e_bc)·m_h·v_rebound`, with `v_rebound ≈ e_hs·v_h`, and a delay `Δt_bc(v)` of 20–50 ms, shrinking with velocity. Values need confirming against Askenfelt & Jansson 1991.

**Injection.** The same keyframe/keybed row as B.

**Parameters.** `r_bc` and `Δt_bc0` in ms; `r_launch` and `Δt_launch` only for offline use.

**Engine.** It is just another BFI event source, about 0.5 day on top of B.

**Assessment.** Physically real but secondary. The pre-strike part cannot be done live without adding latency to every note. **Fold the backcheck catch into B as an optional second event. Do not build C on its own.**

### D. Phenomenological: per-key, velocity-scaled modal pulse with a fitted spectrum

**Physics.** None explicit. It reproduces the measured attack-residual spectrum directly: commuted-style, but with the board modes the engine already has.

**Force model.** `F_thump(t) = A(pitch, v) · P_τ(t)`.

- `A = g[pitch] · (v_h/v_ref)^α`
- `τ = τ0 · (v_h/v_ref)^β`
- The pulse shape is Hann, which gives a spectral roll-off at about 1/τ.

**Injection.** Per-mode weights `W[pitch_group][mode]` fitted directly, or `W = deck_feedin[pitch] · H(f_mode)` with a smooth spectral envelope H (a low-pass corner f_c and a slope). That reuses the bridge row and needs only a handful of numbers per register.

**Parameters.** `g[pitch]` (dB), `α`, `β`, `τ0` (ms), `f_c` (Hz), slope (dB/oct), delay (ms). All of them can be fitted from the recordings in §6.

**Engine.** The BFI, or the cheapest form: the **modal kick** (host computes Δq per mode at note-on). No per-sample cost.

**Conventions.** The same separation as in B.

**Risk.** Low technically. Physically it is not predictive: a new key, a new velocity or a new preset needs refitting, and the result can drift from physical plausibility.

**Effort.** About 2–3 days with the BFI.

### E. Hybrid (recommended target): BFI + physical sources + phenomenological trim

- **E1.** Build the BFI once (§3), with both the pulse-table path and the modal-kick path.
- **E2.** Source **B** (keybed) as the primary thump, with physics laws for τ(v), J(v) and Δt(v), and an optional backcheck event (C).
- **E3.** Keep **A** as is, quantified. Add **A′** (frame reaction) only if Step 0b shows a meaningful missing share.
- **E4.** Add **D**'s per-key trim `g[pitch]`, so the user can close the residual against their piano without leaving the physical parameterisation.
- **E5.** Optionally add 2–4 body/case modes driven only by the thump. This covers the case if the measured thump peaks do not sit on the board modes.

**Why this order.** Every term is a named physical path with physical laws in velocity. One injector serves all of them, and the fitted per-key trim absorbs whatever the physics misses. It also leaves room for the rim coupling to be *measured* on the real instrument with the existing modal rig.

---

## 5. Comparison

| | A bridge path (+A′ frame) | B keybed | C action / backcheck | D phenomenological | E hybrid |
|---|---|---|---|---|---|
| Physical fidelity | High (already in model) | High | Medium (secondary path) | Low (descriptive) | High, plus trim |
| Can close the 24 dB gap? | Unlikely alone | Likely | No (secondary) | Yes (by fit) | Yes |
| Velocity dependence | Automatic | Contact-law τ(v), J(v), Δt(v) | Contact law | Fitted power laws | Contact law, fitted trim |
| Live-timing issue | None | Δt < 0 clamped | Pre-strike parts offline only | None | As B |
| New data | none / 1 coupling row | pulse table, 1 row, events | same as B | per-group weights | as B, plus g[pitch] |
| GPU cost / cycle | 0 / ~0 | < 0.5 % (≈0 with kick) | as B | ≈0 (kick) | < 0.5 % |
| Touches string energy convention | No | No (separate channel) | No | No | No |
| Fit from mic | n/a | Yes (§6) + rim tap test | Partly (late event) | Yes, directly | Yes |
| Effort | 0.5 d measure / +1.5 d A′ | ~5–7 d incl. FE | +0.5 d on B | ~2–3 d | ~6–8 d total |
| Rebuild | no / yes | yes (+ wheel) | yes | yes (or offline hack) | yes |

---

## 6. Fitting from the user's mic recordings

The inputs already exist: piano run `20261025T180612-belarus_held_C4_A2_G4` (artefact a-20261025180748-8d0641; onsets C4 11.53 s, A2 33.91 s, G4 55.25 s) and the Pianoid takes a-20261025201048-0fcc45 and a-20261025202532-4bf896.

1. **Align onsets** with the HF transient. Remove the harmonic part with a sinusoidal model (ESPRIT or partial tracking), or low-pass below 0.8·f1 where f1 lies above the band. The **attack residual** remains.
2. **Peak-pick the residual's 30–80 ms spectrum.**
   - If the peaks sit on the measured board modes (66.6 / 94.8 / 133 / 140 / 189 Hz), the thump is the board being kicked: fit `C` or `W` per mode from the residual's modal amplitudes.
   - If the peaks lie elsewhere, case/keybed or room modes are involved: add body modes (E5) with the fitted f and ζ.
3. **Timing:** measure the delay between the HF onset and the low-band envelope peak. That gives `Δt_kb`.
4. **Velocity laws:** record each key at three velocities (pp, mf, ff). Fit `J(v)` and `τ(v)` (the residual bandwidth gives τ) to get `r_kb`, `p_kb` and `tau_kb0`.
5. **Rim coupling (best):** a tap or exciter test at the keybed/rim point with the existing modal rig, which gives `C[keybed][mode]` directly.
6. **Check the rig speaker's low-frequency response before trusting Pianoid mic takes in 50–100 Hz.** Judge thump *level* on engine output, and thump *perception* by mic and the user.

---

## 7. Recommendation and minimal first steps

**Recommendation.** Build **E**: the Board Force Injector with keybed impact (B) as the primary physical source, an optional backcheck event, and a per-key trim. Implement it after a cheap validation that the 24 dB gap really is a low-mode kick at the attack. Treat **A** as a measurement, not a feature.

**Step 0a: numpy only, no engine, about 2 h.**

1. From the preset's 9 sub-250 Hz modes (f, ζ, mass_inv) and C4's deck feedin, synthesise a modal thump: a Hann pulse with τ = 3 ms, ringing on those modes.
2. Scale it so the attack-minus-body band metric matches the piano's +27 dB.
3. Mix it into the existing Pianoid C4 mic take. Compare the band metric, the 0–100 ms spectrogram and the residual spectrum peaks against the piano take.
4. Give the user a 3-way A/B: piano, Pianoid as is, Pianoid with thump.

This answers "is this the missing ingredient?" before any C++.

**Step 0b: Python reference string, no GPU, about 0.5 day.** Run PianoidBasic's reference string for C4 (`StringState`). Compute the bridge-force spectrum, check that its floor below f1 is `J·x_h/L`, and predict the board low-band level the bridge path gives on its own. That number is A's contribution and the budget left for B.

**Step 0c: optional, isolated offline GPU render, no rebuild.** Do this in a **separate process and backend, never the live stack.** Render C4 from rest with `exciteMode(n, 0, v_n)` on the 9 low modes at t = 0, with `v_n = A·mass_inv_n·C_n·|P̂(ω_n)|`. This is the modal-kick idea, using the existing overwrite API (valid only from rest). It checks units and coupling end-to-end on the `note_playback` offline surface before the BFI is built.

---

## 8. Open questions for the user

1. Is the target your Belarus piano at the rig, so that per-key trims fitted to it are acceptable, or a general physical default?
2. May we spend a rig session on a rim/keybed tap test (step 6.5) and on pp/mf/ff takes of 4–6 keys?
3. Live behaviour: is clamping a negative keybed delay to 0 acceptable? The alternative is a global latency of a few ms to honour the pre-strike events.
4. Should the thump stay excluded from loudness calibration (recommended), or be included?

---

## 9. Option F: thump string (user proposal, 2026-10-29)

**Proposal (verbatim):** "introduce one extra string of the length 0 (bridge only) with the hammer located on the bridge. Then thump is injected as a normal string excitation. You have all coefficients ready to use, no need to introduce extra. Consider combining the thump string with one of the sound channel strings to save the slot. Or I may be wrong, excitation will not be transferred directly from the hammer to the modes."

Analysis: des-thump2. Design plus CPU-only numerics. No engine run, nothing committed.

### F.1 Verdict on the zero-length string: as stated, it does not work

The user's doubt is right: a force applied at the bridge point is thrown away. Three facts from the source:

1. **The hammer force reaches integrated points only.** `dv += s_force_function[...] * coeff_force` (`MainKernel.cu:691`) sits inside `if (onString)` (`MainKernel.cu:670`), and `onString = onMainString || onTail` (`MainKernel.cu:247`).
2. **The two stem points are not integrated.** Their displacement is overwritten: `target = feedback` (`MainKernel.cu:696-699`). `parameterKernel` does compute `hammer[p]` for a stem point (`Kernels.cu:171`), but the result is never used.
3. **The bridge force comes only from the neighbouring slope.** It is `shift_F1 * (s_a[p∓1] − feedback)` (`MainKernel.cu:710-714`), where `shift_F1` is the raw tension (`Kernels.cu:180`).
   - A zero-length string has no integrated neighbour on the main side, only a fixed point at 0.
   - Its bridge force is therefore `−T·feedback`. That is a pure spring load on the board: it detunes the coupled modes and carries no hammer contribution at all.

**The engine already contains zero-length strings: the sound-channel (output) strings.** In `Tuning18-10-26ver1_work_assistant_11.json`, pitches 128–134 (strings 228–235) have `main = 0, tail = 0, tension = 0`. They work as displacement probes, not as force sources, for exactly the reasons above.

**Geometry facts** (`Kernels.cu:238, 285-295`, `stringMapKernel`):

- Points `start` and `start+1` are fixed (the agraffe).
- Main points `start+2 … stem−1` are integrated.
- The stem is the pair `start+main` and `start+main+1`.
- Tail points `stem+2 … stem+1+tail` are integrated; beyond them is a fixed guard.
- So the speaking length is `(main−1)·dx`, and point k sits at `x/L = (k−1)/(main−1)`.
- `StringGeometry.dx()` returns the sentinel 0.001 when `tail == 0`.
- **Minimum working string:** `main ≥ 4` and `tail ≥ 1`.

To make the literal idea work, the kernel would have to add the hammer force at the stem straight into `force_on_bridge_point`. Because of the engine's units it would also need a ρ·dx²·Σh conversion (see `string_gain`). That is a compiled-code change plus a new unit convention. The variant below gets the same physics without touching the kernel.

### F.2 The organic variant: a short, light "thump string" struck next to the bridge

**Construction.** The thump string is an ordinary string with:

- a few integrated points;
- `jung = 0`;
- normal tension;
- tiny ρ, which puts f1 far above the audio band;
- the hammer on the last main point before the stem.

**Why it works.** Below f1 the string acts as a massless lever: its bridge force is `J·x_h/L`, with a flat transfer. The pulse is the existing Gauss force function, so everything else applies unchanged:

- velocity levels and `levels_matrix`;
- impulse conservation (`c·m·v·G/(temporal·spatial)`);
- `string_gain`;
- coefficient caching;
- the batch/envelope path.

**Numerical check.** CPU only: an engine-indexed numpy FDTD with a rigid bridge, string_iteration 8, 48 kHz. The script is scratch, not in the repo.

| Case | x_h/L | f1 | Courant | bridge/hammer transfer 30–250 Hz | ringing after pulse |
|---|---|---|---|---|---|
| C4 key string (main 67, tail 4, T 658 N, ρ 6.9e-3, x_h 0.111) | 0.111 | 259 Hz | 0.09 | −20.0 dB @30, −17.9 @100, −8.7 @200, then resonance | long (it is the note) |
| thump: main 12, tail 2, dx 5 mm, T 300 N, ρ 3.3e-4 | 0.82 | 8.7 kHz | 0.50 | **−1.7 dB, flat** (= 20·log 0.82) | none (pulse spectrum ≪ f1), even at γ = 0.04 |
| thump: main 20 | 0.89 | 5.0 kHz | 0.50 | −1.0 dB flat | none |
| thump: main 8, tail 1 | 0.71 | 13.6 kHz | 0.50 | −2.9 dB flat | none |

What the table shows:

- **The existing key-string path is confirmed.** At 60 Hz it gives −19.4 dB, matching x_h/L = 0.111 (−19.1 dB), as §1 predicted. This answers Step 0b for a single string.
- **The thump string delivers 82–89 % of J, flat across the band.**
  - Per unit impulse, that is about +18 dB over one C4 string.
  - Against C4's three unison strings it is about +8 dB, because the bridge forces sum when `unison_split_exponent = 0`.
- **Closing the ~24 dB gap needs J_thump ≈ 5–15 × J_hammer.**
  - In this role, the thump pitch's `hammer_mass` stands for the effective keybed mass (key plus finger, about 50–100 g).
  - That is physically plausible against the preset's tuned hammer masses.
- **Viscous damping costs no net impulse.** γ·ρ·∫∫y_t dx dt = 0 once the string is back at rest, so γ can be large.

**Stability.**

- With `jung = 0`, B = 0 and the lower CFL edge is met trivially.
- `coeff_tension = Courant² ≈ 0.25 ≤ 1`.
- Choose ρ from `ρ = T·dt²/(σ²·dx²)` with Courant σ ≈ 0.5.
- The host CFL indicator should read about 0.25.

**Static load on the board.** The string acts as a spring between the agraffe and the bridge, with engine stiffness `k = T·(1/(main−1) + 1/(tail+1))`:

| Spring | k |
|---|---|
| thump string, T 300, main 12, tail 4 | ≈ 87 |
| one C4 string | ≈ 142 |
| all 236 strings together | ~2·10⁴ |

So the thump string loads the board like less than one extra string, and mode detuning is negligible. Keep T in the piano range (100–700 N). A tiny T would push the displacement toward `amp_limit` (1e4), because engine displacement goes as 1/T.

**Parameter map (thump pitch).** Each existing parameter, its role here, and the physical quantity it stands for:

| existing parameter | role here | physical quantity |
|---|---|---|
| `hammer_mass` | impulse scale `J = c·m·v·G` | effective keybed mass M_kb (key + finger share); r_kb = M_kb/m_h |
| velocity→speed table (global) | v | key speed, folded into M_kb. `J = (1+e)·M·v` is linear in v, as is the existing convention |
| Gauss `sigma` per level | pulse width | felt contact time τ_kb(v). Shorter at ff: set the 6 anchor levels to τ ∝ v^((1−p)/(p+1)) |
| Gauss `mu` per level | pulse delay within the 7-segment window (0–9.3 ms, 1.333 ms per segment) | keybed delay Δt_kb(v) ≥ 0 after the strike. Delay plus pulse must fit in ~9 ms. A backcheck catch (20–50 ms) cannot be expressed |
| `deck` row (feedin = feedback, own pitch) | projection of the force onto the modes | **C[keybed][mode], the rim coupling**, independent of any key's row. Deck rows are per pitch (`Pitch.deck`) and packed per string (`pack_deck`). Feedback by reciprocity: the rim moves the thump stem |
| `hammer_position` ≈ (main−2)/main | lever share x_h/L | 0.8–0.9; the remainder is folded into M_kb |
| `gamma` 2000–5000 s⁻¹, `disp_decay` 0, `damper_string` 0 | damps the string's own 5–14 kHz partials | none (numerical hygiene); no impulse loss |
| T, ρ, main, tail, length | keep f1 ≫ band, Courant ≈ 0.5, small spring load | a "transmitter stiffness", not a physical piano part |

### F.3 Per pitch, shared, or per register?

**Per pitch (a 4th unison string): not recommended.**

- The engine hard-codes 3 strings per pitch:
  - `getStringIndicesForPitch` reads `pitch*3 + i` for `i < 3` (`Pianoid_parameters.cu:762-772`);
  - Python `chores` is `(140,3)` (`StringMap.py:321`).
- 64 of the 88 keys already have 3 strings.
- It would cost 88 slots, i.e. 22 more 4-string blocks. That is a real risk for the cooperative co-residency pre-flight.
- Intake itself would be fine: 7 × 4 = 28 ≤ `MAX_STRINGS_PER_EVENT` 64 (`constants.h:82-87`).

**One shared thump string: recommended first.**

- The keybed is one structure, and one rim row is the physical first approximation.
- Cost: one slot.
- Caveat: re-exciting a string **overwrites** its force function and resets `exct_cycle_index` (`gaussTest.cu:101`).
  - A second note-on within the 9.3 ms pulse window truncates the first pulse.
  - Two note-ons in the same cycle write the same row; one velocity wins.
  - The string state itself is additive, not reset, so ringing superposes correctly.
- For chords, use a pool of 2–4 thump strings in round-robin. Each takes about 20 points and fits in the output block.

**Per register: the refinement.** MIDI 0–20 and 109–127 give 40 unused key-pitch IDs. A few register thump pitches can each carry their own rim row and gain, at a few slots instead of 88.

### F.4 "Combine with a sound-channel string": share the block, not the string

An output string cannot carry the thump, for three reasons:

1. **Its deck row serves both directions.** It is used for feedin and feedback (`USE_SINGLE_DECK_MATRIX=1`), so the injection row would be that receiver's mode shape instead of the rim row.
2. **Output rows bypass the `deck_feedback_coefficient` mask** (`pack_output_mask`; the coefficient is 10000 in this preset).
3. **It would change the output path.** Giving the output string tension and points would make it feed in through the receiver row. That collides with dev-rad1 (`feature/dev-rad1-output-routing` rewrites the output rows).

What can be shared is the block. Output blocks are almost empty: each output string uses 2 of 512 points.

- In this preset, **string 235 is a padding duplicate of output pitch 134**. An output pitch with several strings writes the same sample, so the level does not change (≤ 0.01 dB, SYNTHESIS_ENGINE "Audio Output").
- Reassigning that slot to the thump pitch costs **zero new blocks**. That is the organic form of "save the slot".

Constraints:

- The thump pitch must be `< 128`: not in `soundPitches`, with `outer_sound = 0` and output mask 0.
- dev-rad1 must not reclaim the slot. Coordinate the output-string count and padding with that branch.
- Presets with no padding slot need either one more 4-string block or one fewer unison string (via `preset_restructure`).

### F.5 Engine and preset changes

**Validation: no engine change (preset + Python only).**

1. Add pitch 20 ("thump") on slot 235, taken from pitch 134, which keeps string 234. Give it the geometry, physics, Gauss levels and rim deck row from F.2.
2. Run an offline `note_playback` render in a separate process, never on the live stack. Add an extra note-on for pitch 20 at the C4 onset, with the same velocity. The note-on path accepts pitches 0–127 (`Pianoid_parameters.cu:757`).
3. Check that `excitation_retime` and `string_gain` treat pitch 20 sanely. `excitation_retime` skips only `p ≥ 128`, so pin the thump curve explicitly.

**Live: host C++ only, no kernel change.** This needs `/dev` and a `.pyd` rebuild.

- `PlaybackCycleExecutor::stageStringsForPitch` / `exciteStringsForPitch` append `thump_string_for_pitch_[pitch]` (−1 = none; round-robin pool) with the key's velocity.
- A per-key gain `g[pitch]` scales that entry's `string_excitation_coeff`, through an `addStringToBatch(stringNo, vel, gain)` overload.
- A pybind setter, loaded from `model_parameters.thump {enabled, strings, pitch_map, gain}`.
- Update the `constants.h:86` invariant to "≤ 4 strings per note-on".
- Effort: about 1 day, plus middleware and schema.
- `enabled = false` (the default) keeps output bit-identical.

**Calibration.** As in §4.B: run `output_scale` and the per-pitch equalisation with the thump disabled.

### F.6 Risks

- The delay must be ≥ 0 and fit within the 9.3 ms window, so there is no backcheck event.
- On a shared string, note-ons less than 9.3 ms apart truncate the earlier pulse. Use a pool.
- The conserve-mode convention fixes J ∝ v. A different J(v) law needs a per-level factor in the Python coefficient composition (still no engine change).
- The rim row is unmeasured. Start from the 9 sub-250 Hz modes (fitted per §6), or use C4's row as a proxy.
- The thump uses the normal deck path, so the shaped/flat tier distinction does not matter. On flat-tier presets, `check_uniform_flat_row` still applies.

### F.7 Validation steps

1. **Offline render**, C4 at v = 40/80/120, with and without the thump note.
   - Metric: the band level (50–200 Hz) in the first 30 ms minus the same band at 0.5–1 s, measured on **engine output**.
   - Targets: +27 dB for C4 and G4; +6 dB for A2.
2. **Parameter sweep.** Sweep the thump `hammer_mass` (the impulse ratio) and the rim row. Check that J is linear in v, and that τ(v) and Δt(v) come out of the levels.
3. **Regression checks.**
   - Without a thump note-on, output is unchanged (≤ 0.01 dB, from the slot-235 change only).
   - Free-decay mode frequencies are unchanged with the string present (spring load only).
   - The CFL indicator reads ≈ 0.25.
   - No amplitude-gate trips at v = 127.
4. **Compare with the piano take:** the 0–100 ms spectrogram and the residual peaks (§6). Then a user A/B.

**Side finding (from reading the source; not measured).**

- `getStringIndicesForPitch` accepts only `stringNo > 0` (`Pianoid_parameters.cu:770`).
- But `chores` holds CUDA slot indices, with −1 meaning "none" (`StringMap.py:321`).
- So the string in CUDA slot 0 is never struck by a note-on. In this preset that is string ID 3, one of the three C8 (pitch 108) strings.
- The check should probably be `>= 0`.
