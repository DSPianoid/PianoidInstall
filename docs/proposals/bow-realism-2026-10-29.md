# Bow realism: analysis of today's bow and a path to a physical bowed string (design only)

**Status:** PARTIALLY IMPLEMENTED (dev-bow2, 2026-11-04, branch feature/dev-bow2, not merged): Option B
(friction solve at the hammer point, central velocity) with MIDI velocity = bow speed and live force / angle
(angle = friction-curve softness, a cheap stand-in for bow tilt / contact width) and a x40 (runtime-tunable, user choice) high-frequency loss on the bowed string (clean Helmholtz motion: one slip per period above the bass); the old WRAP bow is retired.
Open: the rest of Option C (bow noise, thermal friction, Guettler-aware attack, Schelleng-aware UI, a separate
bow position), Option D, preset persistence of the bow assignment. Reference:
[SYNTHESIS_ENGINE → Friction bow](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#friction-bow-dev-bow2).
**Date:** 2026-10-29 · **Agent:** des-bow1
**Trigger:** user request "Analyze how the bow action works and propose how to do it more realistic."
**Builds on:** [`universal-excitation-looping-design-2026-07-07.md`](universal-excitation-looping-design-2026-07-07.md)
(Phases 1–2 done, 3–4 never started) and SYNTHESIS_ENGINE → "Temporal Segmentation & Grid Reconciliation".
**CPU check:** `docs/development/diagnostics/des-bow1-friction-bow-fdtd.py` (numpy, ~10 s, no GPU).

---

## 1. How the bow works today

### 1.1 UI, parameters, trigger
- **UI:** one Hammer/Bow toggle per selected pitch in the Excitation panel
  (`PianoidTunner/src/components/Excitation.jsx:416-459`; handler `:174-176`; store `hooks/useExcitationModes.js`).
  Its tooltip already says "NOT loudness-calibrated yet (Phase 4); currently loud / growing".
  **There are no bow parameters** — no bow force, bow speed, bow position or friction constants.
- **Plumbing:** `POST /set_excitation_mode {pitch, mode:'bow'|'hammer'}` (`PianoidCore/pianoid_middleware/backendServer.py:1981-2003`)
  → `pianoid.set_pitch_excitation_mode` (`pianoid.py:457-476`) → `Pianoid::setPitchExcitationMode`
  (`pianoid_cuda/Pianoid_parameters.cu:783-795`) → host vector `excitation_mode_` (default all IMPULSE, `Pianoid.cu:146`).
  Session state only: it is **not saved in the preset** (nothing in PianoidBasic; the WIP "Phase 2b" persistence
  item, `WORK_IN_PROGRESS.md:145-149`, is still open).
- **Trigger:** an ordinary MIDI/UI note. Note-on with velocity v (`Pianoid_excitation.cu:27-36`) stages the string,
  its TYPE (into the legacy int slot, `:58-66`) and the **same per-(pitch, velocity) loudness coefficient the hammer
  uses** (`:71-75`). Velocity therefore sets one fixed "bow" level at note-on; nothing changes it while the key is held
  (no aftertouch/CC path).

### 1.2 The "force model": an open-loop, looped force waveform
- At note-on `gaussKernel` (`gaussTest.cu:20-124`) writes the per-string force time series `force_function`
  = coeff × Σ (5 ReLU-gated Gaussians) over 7 segments of one engine cycle each (1 segment = `initTotalSteps`
  sub-steps = 1.333 ms at 64 samples/48 kHz). For a bow (`:110-115`) it sets the traversal descriptor to
  `WRAP` over **segment 5 only** (`constants.h:77-78`: `EXCT_BOW_LOOP_START_SEG=5`, `END_SEG=6`).
- `MainKernel.cu:465-501`: while the damper is open (key held, `:477-478`), the read index wraps inside
  `[5·initTotalSteps, 6·initTotalSteps)`; `:944-958` advances/wraps the counter once per cycle.
- `MainKernel.cu:691`: the force is added to every string point as `dv += force(t) · coeff_force(x)`, with
  `coeff_force(x) = dec_inv · hammer_profile(x) · dt²` (`Kernels.cu:164-174`). So the bow uses the **hammer's spatial
  profile at the hammer position** (`Kernels.cu:121, 231-236`).
- **No two-way coupling.** The force never reads the string velocity at the contact. It is a *prescribed* force:
  not velocity-driven friction, not stick-slip, not noise-modulated. It is computed on the GPU per sub-step, but it
  is a table lookup, open loop.
- **Consequence (key finding):** the loop is exactly one engine cycle long, so the drive is a **periodic waveform
  at the cycle rate, 750 Hz at 64/48k**, independent of the string's pitch. With the kernel's default shape
  (`gaussTest.cu:69-72`: a Gaussian at μ=5.588 segment, σ=0.112 inside the loop window) that is a narrow pulse train
  at 750 Hz. A forced string responds at the drive's harmonics (k·750 Hz), strongest where one lands near a string
  partial; it does **not** self-oscillate at its own f0. In the CPU toy (§4) the same drive on a 196 Hz string
  gives a dominant output at 4480 Hz (6 × 747 Hz, next to partial 23). *Inference from code + toy; not yet
  measured on the engine — see open question Q1.* If a preset's curve is ~0 in segment 5, the bow is silent;
  if it is ~constant there, the bow is a DC push (static deflection, no tone).
- Amplitude is not self-limiting: the drive keeps injecting energy at a fixed level, balanced only by damping —
  hence "loud / growing" and the Phase-4 plan of per-pitch damping calibration.

### 1.3 Release
Note-off sets `dec_open = DUMP_CLOSED` (`Pianoid_excitation.cu:28-35`); the kernel gate drops WRAP→CLAMP, the
read index leaves the window, the force stops and the **damper** kills the string. That is "key-up damper",
not a bow lift (a lifted bow leaves the string ringing) and not a bow stop.

### 1.4 Phase status (from the 2026-07-07 plan)
| Phase | Content | Status |
|---|---|---|
| 1 | traversal descriptor, hammer byte-identical | done (dev-exp1) |
| 2 | WRAP/bow mode, per-pitch type, REST hook | done (dev-exp2); merged in the CUDA package dev-cpkg (`MODULE_LOCKS.md:320-323`, merge 5705536) |
| 2b | FE toggle + preset persistence | toggle done (dev-fbcb 2026-10-14); **persistence not done** |
| 3 | per-wrap timing/gain jitter | not started |
| 4 | power/RMS normalization + per-pitch damping calibration for a flat sustain | not started |

Measured in Phase 2 (`logs/archive/dev-exp2-2026-07-07-103200.md:53`): bow sustain ratio 1.34 vs hammer 0.19,
bow peak 3× hammer, clean tail-out after note-off. Nobody checked its pitch or spectrum.

---

## 2. The physics gap

| Real bowed string | Today | Audible consequence of the gap |
|---|---|---|
| **Self-sustained oscillation (Helmholtz motion):** one corner circulates; at the bow the string sticks for (1−β) of the period and slips for β; bridge force is a sawtooth of peak-to-peak 2Z·v_b/β | forced response to a 750 Hz loop | wrong pitch/timbre (cycle-rate buzz), no sawtooth spectrum (all harmonics, ∝1/n, at the string's f0) |
| **Friction curve μ(Δv)**, static μ_s ≈ 0.8 → dynamic μ_d ≈ 0.3, hyperbolic/exponential fall-off with slip speed (Smith & Woodhouse 2000; McIntyre, Schumacher & Woodhouse 1983) | none | no stick-slip, no nonlinearity, no mode locking of an inharmonic (piano) string to one period |
| **Two-way coupling** — the friction force depends on the string velocity at the contact | open loop | no self-limiting amplitude: level grows/needs calibration instead of being set by v_b/β |
| **Thermal (rosin) friction** — μ depends on contact temperature (Smith & Woodhouse 2000; Woodhouse 2003; Galluzzo 2004) | none | attacks and hysteresis differ from the velocity curve; matters most for transients and slow bows |
| **Schelleng diagram** — playable window F_min ∝ Z²v_b/(β²R) < F_N < F_max ≈ 2Z v_b/(β Δμ); outside it: surface/multiple slip (too light), raucous/pitch-flattening (too heavy) | no F_N, no v_b, no β | no "playing" behaviour: pressure, speed and contact point have no meaning |
| **Bow width + hair compliance** (Pitteroff & Woodhouse 1998; Serafin 2004) | uses the hammer's spatial profile | rounds the Helmholtz corner, adds slip noise/"differential slipping"; brightness depends on contact width |
| **Torsional modes** (Woodhouse & Loach) | no torsional DOF | lower effective impedance at the contact; damps sub-period ripple; small timbral effect, larger effect on Schelleng limits |
| **Attack transients (Guettler 2002)** — bow acceleration vs force decides whether clean Helmholtz starts in ≤2 periods or the attack is scratchy/choked | fixed one-shot gauss segments 0–4 | every bow onset identical; no expressive attack (martelé, detaché, slow crescendo) |
| **Bow noise** — rosin granularity, hair variation, differential slipping | none (Phase 3 jitter planned) | sterile, perfectly periodic tone |
| **Release**: bow lift (string rings) vs bow stop (string damped by the stuck bow) | damper closes | always a dampened cut-off |

Net: today's bow is a sustained, prescribed forcing at a fixed engine-dependent frequency. The single largest
gap is the absence of the friction feedback loop; once it exists, Helmholtz motion, pitch, sawtooth spectrum,
self-limited amplitude, Schelleng behaviour and much of the attack character all emerge from it. Phase 3
(jitter) and Phase 4 (power normalization + per-pitch damping calibration) become unnecessary: the bow balances
its own energy, and noise comes from the friction physics plus a small F_N/μ jitter.

**Piano context.** Piano strings are bowable ("bowed piano", e.g. Stephen Scott), but their impedance is high
(steel, T≈700 N, linear density ≈7 g/m → Z≈2.2 kg/s vs ≈0.3 for a violin G). F_max scales with Z, so
realistic bow forces are several N, and unison pairs/triplets would each run their own friction solve and couple
through the bridge (beating and mode-locking emerge naturally). Strings are stiff, so the Helmholtz corner
disperses; the friction loop still locks the partials to one period.

---

## 3. Options

All friction options live in the **CUDA kernel's per-sub-step string loop** (`MainKernel.cu:670-694`). The
engine is one thread per string point, the point keeps its velocity increment `s_v` in a register, and
`allThreads.sync()` already separates sub-steps. **The contact velocity is therefore local to the bow-point
thread at the same sub-step: no host round-trip, no extra barrier.** The host only supplies slow controls
(F_N(t), v_b(t), β) per string per cycle.

### Option A — open-loop stop-gap (pitch-correct loop)
Make the loop length one **string period** (`round(fs·soundStep / f0)` sub-steps) instead of one cycle, fill it
with a sawtooth force, add the Phase-3 jitter.
- **Where:** `gaussTest.cu:110-115` (loop bounds per string), a host-computed loop curve; no kernel-loop change.
- **Params:** loop shape, level (arbitrary units), jitter.
- **Stability:** unchanged; amplitude still not self-limited → still needs Phase-4 calibration.
- **Effort/risk:** ~1–2 days, low risk. **Realism: low** — right pitch, but no Schelleng, no attack physics,
  amplitude still grows/decays per pitch. Not recommended except as a quick demo.

### Option B — two-way friction bow at the contact (recommended core)
Per sub-step, for each bow-point thread:
1. compute the free update `dv_free` (all existing terms of `:686-690`, without the excitation term);
2. free contact velocity `v_free` from `s_v + dv_free`; relative velocity `Δv_free = v_free − v_b`;
3. **stick test:** the force needed to stick is `F_stick = −Δv_free / a`, `a` = local admittance
   (`a = dt·dec_inv/(2ρ_lin·dx)` = λ/(2Z) on a Courant-λ grid). If not previously slipping and
   `|F_stick| ≤ μ_s·F_N` → stick, `F = F_stick`;
4. **slip:** with the hyperbolic curve `μ(x) = μ_d + (μ_s − μ_d)·v0/(v0 + x)` the line/curve intersection
   (McIntyre–Woodhouse graphical solution) is the positive root of a **quadratic**,
   `x² + x(v0 − (X − aF_Nμ_d)) + v0(aF_Nμ_s − X) = 0`, X=|Δv_free| — closed form, one `sqrt`, no Newton
   iteration and no lookup table; hysteresis = "stay slipping while a slip root exists" (one bool per point);
5. `dv = dv_free + F · coeff(x)`.
- **What changes where:**
  - *Kernel:* replace line `:691` for bow points by steps 1–5 (~25 flops + 1 sqrt, only on the 1–4 bow-point
    threads; the other threads wait at the existing barrier, so the cost is one short branch per sub-step,
    estimated well under 1 % of the cycle — to be measured N≥3). One persisted slip flag per bow point
    (tiny global buffer, read/written once per launch like `s_a/s_b`).
  - *Bow controls:* reuse the 7-segment machinery as the **control envelope** rather than the force: for a
    bow note `force_function` carries F_N(t) (attack in segments 0–4, steady value looped in segment 5), plus a
    small per-string buffer for v_b and μ constants. This keeps the universal-excitation design intact.
  - *Spatial:* β from a new per-string `bow_position` (default = hammer position); width from the existing
    spatial profile (each covered point gets its share of F_N and its own friction solve — point-wise
    distributed friction, still local).
  - *Host/middleware/FE:* bow F_N [N], v_b [m/s], β [fraction of length from the bridge], μ_s, μ_d, v0 [m/s];
    MIDI velocity → initial F_N or bow acceleration; optional aftertouch/CC → F_N/v_b live. REST + FE fields in
    the Excitation panel shown only in Bow mode; preset persistence (closes Phase 2b).
  - *Release:* bow lift = ramp F_N→0 over ~10–30 ms (string rings, damper behaviour unchanged by default);
    optional "bow stop" = ramp v_b→0 with F_N held.
- **Stability/CFL:** the string coefficients are unchanged, so the CFL bound is untouched. The friction force is
  solved implicitly against the exact update, so it cannot overshoot; it is bounded by μ_s·F_N. The bow is
  energy-self-limiting (amplitude ∝ v_b/β), which removes the runaway risk the Phase-4 plan worried about.
  Float32: compute the solve in physical velocity units (divide `s_v` by dt once) so v0 ≈ 0.1 m/s is
  well-conditioned.
- **Effort/risk:** ~4–6 dev days incl. plumbing and validation. Medium risk: (i) the engine-unit admittance `a`
  (ρ_lin, dx, `dec_inv`, the mm-based scaling in `Kernels.cu:109-139`) is a high-stakes units fact — derive it and
  confirm by measurement (stuck-bow test: injected force vs contact velocity must equal 2Z), not by source
  inference; (ii) the stiff, damped 5-point stencil changes `v_free` slightly vs the ideal-string toy;
  (iii) cooperative-grid timing (measure).

### Option C — B plus contact and control realism
- **Bow width with hair compliance:** a spring between bow and each contact point (one extra state per point),
  turning the velocity constraint into a compliant one; rounds the corner and adds differential slipping.
- **Thermal friction:** one contact temperature per bow point, `dθ/dt = (|F·Δv| − h(θ−θ0))/C`, μ = μ(θ) per
  Smith–Woodhouse; θ is updated explicitly per sub-step, so the quadratic solve stays closed-form (μ_s, μ_d
  from θ). Mostly changes attacks and slow-bow behaviour.
- **Bow noise:** 0.5–2 % band-limited jitter on F_N or μ (seeded; seed 0 = deterministic tests).
- **Guettler-aware attack:** expose bow acceleration a_b [m/s²] and onset force; MIDI velocity maps into the
  Guettler plane (pre-computed per string) so soft keys give a clean start and hard keys a scratchy "martelé".
- **Schelleng-aware UI:** per string compute Z (from T, ρ), show F_min/F_max lines for the current β and v_b,
  clamp/warn outside the playable window.
- **Effort/risk:** +4–6 days; low–medium (all local per-point state; the thermal constants need literature
  values and tuning).

### Option D — full model
Torsional degree of freedom (contact velocity = transverse + r·angular velocity). Cheapest form: 2–4 lumped
torsional modal oscillators at the bow point per string (a few registers, no new spatial field); full form:
a second 1-D field per string (doubles shared memory `s_a` in a block already capped at `MAX_ARRAY_SIZE=512` —
expensive). Plus Pitteroff–Woodhouse finite-width hair dynamics.
**Effort/risk:** 2–3 weeks; high (memory layout, occupancy — see the register/occupancy notes).
Audible gain over C is modest; worth it only if the goal is research-grade bowed-string fidelity.

### Validation (all options)
1. **CPU golden:** extend `des-bow1-friction-bow-fdtd.py` to the engine's exact stencil (bending, `dec_inv`,
   freq-dependent damping) and compare against an offline GPU render sample-by-sample at the bow point.
2. **Helmholtz check:** record contact velocity (the existing `SOUND_REC_APPLIED_FORCE` debug record can carry the
   friction force): exactly one slip per period, slip fraction ≈ β, stick velocity = v_b.
3. **Bridge-force sawtooth:** peak-to-peak ≈ 2Z·v_b/β; harmonics ∝ 1/n at f0.
4. **Schelleng sweep:** grid F_N × β at fixed v_b, classify each run (Helmholtz / multiple slip / raucous by
   slips-per-period and pitch flattening), overlay the theoretical F_max and F_min lines.
5. **Steady state:** hold a bowed note 5 s → flat envelope (the Phase-4 acceptance criterion, now emergent).
6. **A/B render** today vs B for the same pitch; spectrum (f0 vs 750 Hz lines) and listening.
7. **Hammer byte-identical** (the bow branch is never entered for IMPULSE) and cycle-time delta, N≥3 runs.

---

## 4. CPU sanity check (done, numpy, ideal-ish string)

`docs/development/diagnostics/des-bow1-friction-bow-fdtd.py`: one string, f0=196 Hz, T=40 N, Z=0.314 kg/s,
Courant 0.9, light freq-dependent loss, bow at β=0.1, v_b=0.1 m/s, hyperbolic μ (μ_s 0.8, μ_d 0.3, v0 0.1 m/s),
the closed-form solve above.

| Check | Result | Physics expectation |
|---|---|---|
| F_N = 0.5 N: pitch | 195.5 Hz | 196 Hz |
| slips per period / slip fraction | 1.00 / 0.111 | 1 / ≈β = 0.10 |
| bridge-force peak-to-peak | 0.628 N | 2Z·v_b/β = 0.628 N |
| same string, today-style 750 Hz looped pulse | dominant 4480 Hz | not the string's f0 |

Schelleng sweep (β = 0.1, F_max theory ≈ 1.26 N): F_N 0.01–0.1 N → no tone or multiple slipping (784 Hz =
4th partial, "surface sound"); 0.3 N → 2 slips/period; **0.6–1.5 N → clean Helmholtz at 195–196 Hz**;
2.5–4 N → raucous, pitch drops to 113 / 71 Hz. At β = 0.06 the window moves up (Helmholtz at 1.5–2.5 N,
F_max theory ≈ 2.1 N), as the Schelleng diagram predicts. A first try with Courant = 1 plus explicit viscous
loss blew up — a reminder to keep the loss terms inside the existing (validated) stencil.

---

## 5. Recommendation

Do **Option B**, and drop Phases 3–4 of the 2026-07-07 plan (jitter and per-pitch power/damping calibration are
replaced by the physics). Then add the cheap parts of C (bow noise, Schelleng-aware ranges, bow-lift release,
thermal friction later). Keep D on the shelf.

**Minimal first step (no GPU, no risk):** (1) one offline render of today's bow (pitch 60) to confirm or refute
the 750 Hz finding (Q1); (2) port the engine's exact per-point update into the CPU script and derive/measure
the engine-unit admittance `a` — the only high-stakes unknown. Then a single kernel change at
`MainKernel.cu:691` behind the existing `EXCT_TYPE_SUSTAINED` branch, with constants hard-coded for one
string, verified against the CPU golden and the Helmholtz/sawtooth checks before any UI plumbing.

## 6. Open questions for the user
1. **Q1:** OK to spend one offline GPU render (when the stack is free) to confirm today's bow sounds at the
   cycle rate (750 Hz) rather than the note's pitch?
2. Target: a believable **bowed piano** (piano strings, hammer-position contact, high bow forces), or
   violin-family realism on the piano engine?
3. Release: should key-up mean **bow lift** (string rings, damper as for a hammer note) or the current damped stop?
4. Control: MIDI velocity → bow force or bow acceleration? Do you want continuous control (aftertouch / CC /
   a UI slider) while the key is held?
5. Should Phases 3–4 of the old plan be formally retired in favour of the friction model?
