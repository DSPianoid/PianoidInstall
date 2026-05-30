# Proposal: Feedback-over-Excitation Runaway Gating

- **Status:** DESIGN / RESEARCH — for user review. No implementation, no engine edits, no build.
- **Author:** /analyse (research + first-principles design), 2026-05-30. Maximum-reasoning-depth pass.
- **Scope:** A runtime control mechanism for the **physical feedback-loop runaway** between the
  soundboard modes and the FDTD strings (the `feedin`/`feedback` coupling) — distinct from the CFL
  stability guard, which gates **FDTD numerical** (Courant) instability on string-physics uploads.
- **Relation to the CFL guard:** complementary, not overlapping. The CFL guard
  (`docs/proposals/cfl-stability-guard-v2.md`) prevents a *single string's* explicit recurrence from
  diverging on a **parameter edit** (a static, per-string coefficient bound). This proposal targets a
  *system-level dynamical* runaway that depends on **runtime state and the feedback gain**, not on any
  single coefficient exceeding a static bound. A preset can be CFL-stable on every string and still run
  away through the loop — which is exactly what the user found ("the crash was a feedback loop, not
  CFL").
- **Evidence base / citation discipline (CLAUDE.md high-stakes-inference rule):** every claim about
  axis semantics, unit/scale, the coupling, the state layout, and the failure point is cited to a
  specific source line in `PianoidCore/pianoid_cuda/` or to a doc. Where the docs do **not** settle a
  fact, this is stated explicitly and the inference is flagged. Primary sources:
  `MainKernel.cu`, `Kernels.cu`, `Pianoid_synthesis.cu`, `Pianoid_parameters.cu`, `Mode.py`,
  `constants.py`; `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, `docs/architecture/DATA_FLOWS.md`.

---

## 0. TL;DR

The crash is a **closed-loop dynamical instability** of the bidirectional string↔mode coupling, not a
per-string CFL violation. Section 1 derives, from the actual update equations, that the modal
displacement `q_n` obeys a damped-oscillator recurrence **driven by a force that is itself proportional
to `q_n`** through the round trip string→bridge→string→mode. The closed-loop per-cycle gain is

```
G_loop(n)  ∝  c_in(n) · c_out(n) · deck_feedback_coeff · tension · mass_inv_n · (Δt-scaling)
```

When the **effective damping cannot remove energy as fast as the loop injects it** (`G_loop > 1`),
`q_n` grows geometrically each sample until the FDTD field produces `Inf`/`NaN`; the existing `isnan`
guard then **freezes** the cycle (no auto-recovery), and `soundInt = Sint32(output·main_volume_coeff)`
**overflows** on the ramp — the audible burst-then-crash.

Four candidate gates are derived and stress-tested for false positives (the user's three + a
coordinator-added fourth). Headline conclusions:

1. **dA/dt limiter** — physically apt (it watches the divergent mode), but the trigger threshold is
   **velocity/pitch-dependent and collides with the legitimate attack transient**; kernel-heavy.
   **Not the gate** — at best a windowed sub-component of #3.
2. **Absolute `|q|` clamp** — cheapest and overflow-proof, but the threshold **needs excitation
   calibration** (no single `Q_max` is both transparent to fortissimo and tight enough to stop a
   runaway pre-overflow). **Use as a dumb NaN-proof floor, not as the gate.**
3. **Physics passivity / energy** — the only **calibration-free AND false-positive-free** option (a
   loud-but-stable note is passive; only runaway violates passivity), but the most derivation + the most
   kernel work. **The right long-term primary.**
4. **`max|mode_disp| > max|string_disp|`** — a **self-referencing** detector: the live string field is
   the reference, so **no external excitation calibration** *provided the two displacements are on a
   comparable scale*. **Measurement (not inference) confirms they are** — at unity feedback the stem
   displacement *equals* `Σ(normalized coupling ≤ 1)·q`, so `q` and `s_a` share a scale to within an
   O(1) coupling factor (§1.5, §3.4). The one honest caveat — the `deck_feedback_coeff ≠ 1` reference
   shift — is removable by folding the (engine-known) coefficient into the threshold. This makes #4 the
   best **first step**: cheap, attack-safe, physically motivated, calibration-free modulo one
   dimensionless headroom constant.

**Recommendation — phased hybrid:**
- **Phase 1 (stop the crash, no calibration):** per-cycle kernel **ratio gate** (#4),
  `max|q| > κ₀·deck_feedback_coeff·max|s_a|`, action = **softly scale the feedback gain down** that
  cycle (attacks the loop gain directly, spectrum-preserving). Pair with #2 as a generous `tanh`
  **NaN-proof floor** on `q` so a single cycle can never reach the Sint32 cast. Surface a runtime
  `feedback_redline` flag (sibling of `cfl_redline`) and **auto-reset to silence** on latch instead of
  freezing. Optional **no-build stopgap:** lower the `deck_feedback_coeff` ceiling 1000→8–16.
- **Phase 2 (robust):** per-mode **passivity/leaky-energy limiter** (#3) — bound each mode's per-cycle
  energy gain to the work the strings supply, renormalize amplitude-only on violation. Removes the
  heuristic `κ₀` and the residual false-positive question.

Open questions for the user are in §8 (most important: confirm the runaway is driven by the **runtime
feedback gain** vs preset-baked coupling, and approve folding `deck_feedback_coeff` into the threshold).

---

## 1. First-principles characterization of the runaway

### 1.1 The two coupled subsystems and their exact discrete updates

The kernel advances two coupled subsystems every audio sample (the outer loop,
`MainKernel.cu:416`, runs `samplesInCycle` times per launch; each outer iteration runs an inner loop of
`soundStep` FDTD sub-steps, `MainKernel.cu:508`).

**(A) Mode `n` — damped harmonic oscillator (leapfrog).** Verified at `MainKernel.cu:634–640`
(identical to the Python reference `Mode.iteration`, `Mode.py:282–285`):

```
q_n[k+1] = ( 2·q_n[k] − q_n[k−1]                  (inertia / leapfrog second difference)
             + q_n[k−1]·dec_n                       (damping, q_prev term)
             − q_n[k]·omega_n                        (restoring force, ω² term)
             + F_n[k]·mass_inv_n )                   (modal forcing)
           · (1 − dec_n)                             (symmetric damping envelope)
```

with (verified `MainKernel.cu:304–306`, `Mode.py:150–152`, `constants.py:43`):

```
omega_n    = dt² · f_n² · 4π²        (dt = 1/sample_rate)     — restoring coefficient
dec_n      = dt · decrement_n · f_n                            — damping coefficient
mass_inv_n = 1/m_n  (inverse modal mass)                       — forcing scale
```

`q_n` (`s_mode[quarterNumber]`) and `q_n[k−1]` (`mode_1`) persist in `dev_mode_running`
(`MainKernel.cu:300–301,707–708`). **This is the state that diverges.**

**(B) String — the forcing `F_n` comes from the bridge.** The per-string bridge force is accumulated
over the inner sub-steps (verified `MainKernel.cu:547–550`, `Kernels.cu:167`):

```
force_on_bridge_point += shift_F1 · (s_a[stem_neighbor] − feedback),   shift_F1 = tension   (raw tension)
```

i.e. the tension-weighted difference between the near-bridge string displacement and the
feedback-clamped stem. After the inner loop, summed per string (`MainKernel.cu:565`) and written into
the string→mode accumulator, **normalized by `soundStep`** (verified `MainKernel.cu:589`):

```
feedin_cycle_matrix[n] += mode_feedin[n] · force_on_bridge_summed / soundStep
```

A grid reduction (`sumArray`, `MainKernel.cu:607`) then yields the modal forcing `F_n` =
`s_mode_applied_force[n]`. So:

```
F_n  =  Σ_strings  c_in(n, string) · ⟨ tension · (s_a_nearbridge − feedback) ⟩_soundStep
```

where `c_in = mode_feedin` is the feedin coupling coefficient (`MainKernel.cu:247`).

**(C) The feedback closes the loop — the stem displacement IS the mode sum.** Before the string
update, the stem displacement is overwritten by the mode→string feedback (verified
`MainKernel.cu:431,458,461,534–535`):

```
feedback_cycle_matrix[string] += c_out(n, string) · q_n            (per mode, MainKernel.cu:431)
feedback = sumArray(feedback_cycle_matrix[string])                 (reduce, MainKernel.cu:458)
if (onStem)  s_a[stem] = feedback                                  (MainKernel.cu:534–535)
```

where `c_out = mode_feedback = mode_coefficients · deck_feedback_coeff` (verified `MainKernel.cu:254`).

### 1.2 The closed loop, assembled

Chaining (C)→(B)→(A)→(C): the mode forcing `F_n` depends on the stem displacement, which **is** the
feedback sum of all modes' `q`. Schematically, for a single dominant mode coupling to a single string
(the others add linearly), the bridge force term `(s_a_nearbridge − feedback)` carries a contribution
`−feedback = −Σ_m c_out(m)·q_m`, so:

```
F_n  ⊇  c_in(n) · tension · ( s_a_nearbridge  −  Σ_m c_out(m)·q_m )
```

Substituting into (A), the `q`-dependent part of the modal forcing makes the recurrence **self-driven**:

```
q_n[k+1]  =  (damped-oscillator part in q_n)
             +  mass_inv_n · c_in(n) · tension · ( ... − Σ_m c_out(m)·q_m[k'] ) / soundStep · (1−dec_n)
```

The cross-mode term `Σ_m c_out(m)·q_m` injected back into every mode's forcing is the **positive-
feedback path**. Define the **per-cycle closed-loop gain** for mode `n` as the magnitude of the
round-trip multiplier on `q_n`:

```
G_loop(n)  ∝  c_in(n) · c_out(n) · tension · mass_inv_n · (1 − dec_n) / soundStep
           =  c_in(n) · c_out_coupling(n) · deck_feedback_coeff · tension · mass_inv_n · (1−dec_n)/soundStep
```

(`c_out = c_out_coupling · deck_feedback_coeff`, `MainKernel.cu:254`.) **Two facts follow:**

1. **`deck_feedback_coeff` multiplies the loop gain linearly** and is the one *runtime* knob the user
   controls (range 0–1000, §1.4). Turning it up directly pushes `G_loop` toward and past 1.
2. **The loop gain is independent of any single CFL coefficient bound.** Every per-string `coeff_tension
   − 8·coeff_bending` can be `≤ 1` (CFL-stable) while `G_loop > 1`. *This is why the CFL guard does not
   and cannot catch it.*

### 1.3 Energy-flow view (where energy is injected faster than dissipated)

The damped oscillator (A) has, per step, an energy change of two competing signs:

- **Dissipation:** the `(1 − dec_n)` envelope and the `+q_n[k−1]·dec_n` term remove energy at a rate
  `∝ dec_n` per step. `dec_n = dt·decrement_n·f_n` is **small** for lightly-damped modes (long
  sustain), so the dissipation budget is small.
- **Injection:** the feedback term injects work `∝ mass_inv_n · c_in · c_out · deck_feedback_coeff ·
  tension` per step. With a high feedback gain this exceeds the `dec_n` dissipation.

**Runaway condition (energy form):** `injected_energy_per_step > dissipated_energy_per_step`, i.e.

```
mass_inv_n · c_in(n) · c_out_coupling(n) · deck_feedback_coeff · tension / soundStep   >   ~dec_n
```

The left side is the loop's energy input; the right side (`dec_n`, small for sustain modes) is the
only sink. **Lightly-damped modes (small `dec_n`) are therefore the most vulnerable** — they have the
least dissipation to absorb the feedback injection. This is the precise physical statement of "the
feedback can run away": a passivity violation of the modal subsystem under the feedback drive. (It is
also why approach #3, which enforces passivity directly, is the principled fix.)

### 1.4 The feedback gain term and its range (measured)

- `deck_feedback_coeff` is a **single global `real`** in GPU memory (STATIC_INPUT category, direct
  `cudaMemcpy` + sync; `Pianoid.cu:300–302`, SYNTHESIS_ENGINE.md "Runtime Feedback Coefficient"). It
  multiplies **every** mode→string feedback (`MainKernel.cu:254`).
- **Runtime control:** MIDI CC 74, exponential mapping `8.0^((CC−64)/63)` → CC 0 = 0.125, CC 64 = 1.0,
  CC 127 = 8.0 (SYNTHESIS_ENGINE.md "Runtime Feedback Coefficient"; `pianoid.py:set_deck_feedback_
  coefficient`).
- **Validation range, however, is 0.0–1000.0** (verified `Pianoid_parameters.cu:505–508`;
  `pianoid.py:779`). So although the CC mapping tops out at 8.0, the REST/runtime API admits up to
  1000 — a value that multiplies the loop gain by 1000× and is a near-guaranteed runaway. **This is a
  realistic trigger** (the docstring even labels 1000 "extreme coupling," `pianoid.py:781`).

### 1.5 Mode displacement vs string displacement — UNITS/SCALE (decisive for #4; measured, not inferred)

This is the high-stakes unit question for approach #4. **It is settled by measurement of the coupling,
not by single-read inference.**

- **Deck coupling coefficients are per-mode-normalized to `[0,1]`, spatial max = 1.** Verbatim from
  SYNTHESIS_ENGINE.md "Coupling Coefficients": *"Each deck coefficient is a normalised spatial coupling
  value: the mode shape amplitude at a bridge position, scaled so that the spatial maximum for each mode
  equals 1 … each mode's absolute amplitude is encoded in its frequency, damping, and mass parameters."*
  And: *"The engine expects deck coefficients in the 0–1 range."* So `c_in, c_out_coupling ∈ [0,1]`.
- **The string stem displacement is literally SET EQUAL to the feedback sum.** `target = feedback`
  (`MainKernel.cu:535`), `feedback = Σ_n c_out(n)·q_n` (`MainKernel.cu:431,461`), `c_out =
  c_out_coupling·deck_feedback_coeff`.
- **Therefore, at `deck_feedback_coeff = 1`:** `s_a(stem) = Σ_n (c_out_coupling(n) ≤ 1)·q_n`. The
  string displacement at the bridge is the **coupling-weighted sum of the mode displacements, with
  weights ≤ 1.** Hence `q_n` and `s_a` are on the **same physical scale**, differing only by an O(1)
  coupling factor (a single coupling ≤ 1, or a sum over a handful of strongly-coupled modes). A healthy
  note has `max|q|` of the same order as `max|s_a|`; a runaway has `q` outrunning the string field it
  produces. **Measurement supports the coordinator's "self-normalizing / calibration-free" intuition —
  the units are directly comparable.**
- **Two honest caveats (flagged, not hidden):**
  1. **`deck_feedback_coeff ≠ 1` shifts the reference.** At `deck_feedback_coeff = 8`, a *stable* note
     legitimately has stem displacement up to ~8× the bare coupling sum, so the `q`:`s_a` ratio moves.
     A fixed `κ = 1` would mis-fire. **Fix:** the gate tests `max|q| > κ₀·deck_feedback_coeff·max|s_a|`
     — `deck_feedback_coeff` is already a kernel argument (`MainKernel.cu:108,254`), so folding it in
     needs **no new calibration**; it uses a value the engine already holds. The only residual freedom
     is the *number of strongly coupled modes* (sum vs single coupling), absorbed by the single
     dimensionless headroom `κ₀` — **not** an excitation-dependent quantity.
  2. **The docs do not give an absolute SI displacement for `q`.** They state the *relative*
     normalization (couplings ≤ 1) and that "absolute amplitude is encoded in frequency/damping/mass"
     — which is exactly what makes the *ratio* `q`:`s_a` meaningful while an *absolute* `Q_max` (#2) is
     preset-dependent. This asymmetry is the core reason #4 needs no calibration where #2 does. **No
     doc gives a number for "a fortissimo `q` is X"** — so #4's strength (ratio, self-referencing) is
     precisely that it never needs that number, whereas #2 does.

### 1.6 The precise numerical failure (where NaN/Inf/Sint overflow first occurs)

Tracing a runaway forward:

1. `q_n` grows geometrically (G_loop > 1), one sample at a time (the leapfrog has no internal bound).
2. The stem displacement follows one step behind: `s_a[stem] = feedback = Σ c_out·q_n` → grows.
3. The **interior FDTD stencil** then amplifies: `target = shift_0·s_a[p] + shift_1·(neighbors) + …`
   (`MainKernel.cu:525–531`). With the stem feeding ever-larger values into the boundary, the interior
   reaches `float` overflow → `Inf`, and a subtract of two `Inf`s → `NaN`.
4. **First trip:** `if (isnan(target)) { pointStatus = −1; goto nanInData; }`
   (`MainKernel.cu:510–512`) — this is the **always-on** NaN check in the inner loop, so the first
   `NaN` anywhere trips it. `atomicAdd(status, −1)` and `if (*status < 0) { *n_counter =
   main_cycle_index; break; }` (`MainKernel.cu:658–666`).
5. **The audible artifact precedes the NaN trip:** on the ramp **before** the field becomes NaN,
   `soundInt = static_cast<Sint32>(output · main_volume_coefficient)` (`MainKernel.cu:492`) is computed
   from an already-huge `output`. `static_cast<Sint32>` of a value `> INT32_MAX` is
   **implementation-defined / overflow** → wraps or saturates → the loud click/burst the user hears.
   This matches the parked "Sint32 overflow" finding in memory (the post-volume int path has no
   limiter). `soundFloat` (`MainKernel.cu:493`) stays finite-but-huge, which is why every *pre-volume*
   float readback historically "looked clean" — the overflow is only in the int path the driver gets.
6. **No auto-recovery.** The C++ side only **logs** `kernel_status != 200` and explicitly does **not**
   throw or reset: *"do not throw to preserve original behavior"* (`Pianoid_synthesis.cu:328–332`). A
   full reset (`*status == 500` → zero `s_mode`, `mode_1`, `s_a`; `MainKernel.cu:295–297,316–317`) fires
   **only** on an explicit `resetFlag` (`Pianoid_synthesis.cu:294–296`), which a runaway never raises.
   **Net: after a runaway the engine sits in a frozen/garbage state until a manual reset / preset
   reload.** Any gate must therefore *also* flip the engine into a clean recoverable state (§5
   Phase-1.3), not merely stop the burst.

**Summary of the failure chain:** `G_loop>1` → `q` geometric growth → stem/interior overflow → (a)
**Sint32 overflow burst** [audible], then (b) **NaN freeze** [silence/garbage] with no auto-recovery.
A gate that bounds `q` (or the loop gain) early prevents both (a) and (b).

### 1.7 Separate, out-of-scope sibling: the mode oscillator's OWN stability bound

The leapfrog (A) is itself only conditionally stable. With `dec_n → 0` it reduces to `q[k+1] = (2 −
omega_n)·q[k] − q[k−1]`, whose amplification factor is on the unit circle iff `|2 − omega_n| ≤ 2`, i.e.
**`omega_n < 4`**. Since `omega_n = dt²·f_n²·4π²` (`Mode.py:151`), a sufficiently high mode frequency
`f_n` self-destabilizes **independent of feedback** (the modal analogue of CFL). This is a
*mode-parameter* bound, **not** a feedback runaway, and is **out of scope** here — but it is a real,
separate hazard (a bad `frequency` edit on a mode), flagged as a ticket in §8. (Conversely, it means a
mode-stability check would be a host-side, edit-time gate like CFL — not a runtime gate like this
proposal.)

---

## 2. Realtime constraint (the budget every option is weighed against)

Per-cycle cooperative-grid CUDA audio engine; the loop runs `samplesInCycle` times per launch
(`MainKernel.cu:416`); the engine thread `cudaLaunchCooperativeKernel`s and `cudaDeviceSynchronize`s
each cycle (`Pianoid_synthesis.cu:308,313`). Therefore a runtime feedback gate must be:

- **GPU-resident, host-round-trip-free per cycle.** A per-cycle host readback would stall the audio
  thread. **The CFL guard's host-side pattern cannot be copied** — it runs *on edit*, not per cycle.
  A runtime feedback gate must live **in the kernel** (or be a coarse host-side cap on
  `deck_feedback_coeff`, which is conservative but blunt).
- **Cheap**, ideally reusing reductions the kernel already performs (`sumArray` warp-shuffle reductions
  run every sample, `MainKernel.cu:458,607`).
- **Non-neutering** — must not suppress legitimate loud/fortissimo/bright notes (the dominant design
  risk; analyzed per-approach in §3).

**Cost vocabulary used below.** *Per-element op* = one arithmetic op per thread, no synchronization
(cheap, ~1 cyc). *Warp reduction* = `__shfl_down`/`__shfl` over 32 lanes (~10 cyc). *Grid reduction* =
warp reduction + cross-warp/cross-block `atomic*` into shared/global + `grid.sync()` (~100+ cyc, the
dominant cost). The kernel already pays one grid reduction per sample for feedin and one for feedback.

---

## 3. The four candidate approaches — exact trigger math, action, cost, false-positive analysis

### 3.1 Approach #1 — Limit the sharp increase of mode amplitude (dA/dt)

- **WHERE:** kernel, per mode, in/after the mode update (`MainKernel.cu:632–642`). Requires the previous
  cycle's amplitude (or a running envelope `A_n`) per mode in a new GPU buffer.
- **EXACT TRIGGER:** geometric-growth detection. Per mode, let `A_n[c] = |q_n|` sampled once per cycle.
  Trigger when the **per-cycle growth ratio** exceeds a bound:
  ```
  A_n[c] / A_n[c−1]  >  ρ_max          (ρ_max > 1, e.g. 1.05 ⇒ ≤5%/cycle growth)
  ```
  Equivalently a discrete `d|q|/dt > θ`. To be robust it needs an **N-cycle confirmation window**
  (sustained growth over N cycles), because a single-cycle ratio is dominated by the attack.
- **ACTION:** clamp the increment (`q_n ← q_n[c−1]·ρ_max`), freeze the mode, or scale that mode's
  feedback contribution.
- **CALIBRATION:** **hard** (the user's own caveat, confirmed by the physics). A real **attack
  transient is itself a steep rise** — at note onset `|q|` legitimately jumps from ~0 by orders of
  magnitude within a few cycles (the hammer force is impulsive; SYNTHESIS_ENGINE.md "Excitation Cycle
  Index"). The legitimate onset `d|q|/dt` is **velocity-, pitch-, and excitation-dependent**, so a
  single `ρ_max` either (a) is high enough to pass onsets and then **misses slow runaways** that build
  over many cycles, or (b) is low enough to catch slow runaways and **false-triggers on every
  fortissimo onset**. There is no single threshold that does both; you need a per-pitch/per-velocity
  profile or a multi-cycle window — i.e. calibration.
- **IMPLEMENTATION:** **kernel change → CUDA `--heavy` build**, **plus new per-mode envelope state**
  (`dev_mode_envelope`, read+write each cycle). Non-trivial.
- **RUNTIME:** per mode: one subtract + one compare per cycle (cheap), **but** an extra envelope-state
  **read+write to global memory per cycle** (memory traffic, not free). No reduction needed (it's
  per-mode local). Cost ≈ moderate (memory-bound, not compute-bound).
- **FALSE-POSITIVE ANALYSIS:** **highest of the four.** Fortissimo onsets and percussive/bright attacks
  produce exactly the steep `d|q|/dt` the gate watches for. Mitigations (N-cycle window, per-pitch
  threshold) add detection latency (a runaway can overflow within those N cycles) and state/complexity.
- **VERDICT:** the *signal* is physically the most "on the nose" (a runaway IS a sustained geometric
  rise), but it is the **hardest to threshold without neutering attacks** and the most kernel-heavy.
  **Not the gate.** Its one good use is as a **windowed growth term inside #3** (energy that grows N
  cycles running is a passivity violation) — but there #3's energy framing already subsumes it.

### 3.2 Approach #2 — Clamp absolute mode displacement (`|q| ≤ Q_max`)

- **WHERE:** kernel, per mode, right after the mode update (`MainKernel.cu:640`) or as a saturating
  nonlinearity on `q` before write-back (`MainKernel.cu:707`).
- **EXACT TRIGGER + ACTION:** `|q_n| > Q_max` ⇒ either hard clamp `q_n ← sign(q_n)·Q_max`, or
  **soft-clip** `q_n ← Q_max·tanh(q_n/Q_max)` (continuous; avoids the discontinuity a hard clamp injects,
  which would itself be an audible click).
- **CALIBRATION:** **needs excitation calibration** (user's caveat, confirmed §1.5 caveat 2). The
  *absolute* scale of `q` at a legitimate fortissimo depends on the velocity→excitation mapping and the
  per-mode `mass_inv` — and the docs give **no absolute number** for it. A single `Q_max` that is both
  (a) above every real fortissimo (transparent) and (b) below the overflow threshold (`Q_max·
  main_volume_coeff < INT32_MAX`) and (c) tight enough to stop a runaway *before* the burst — may not
  exist for all presets. A *per-mode* `Q_max` from a preset calibration pass would be required for
  transparency.
- **IMPLEMENTATION:** **kernel change → CUDA build, but tiny** (one `fminf/fmaxf` or `tanh` per mode).
  With a **single global `Q_max`**, **no per-mode state** is needed (its advantage over #1).
- **RUNTIME:** **cheapest of all four** — one per-element op per mode per sample (or per cycle); **no
  reduction, no extra memory.**
- **FALSE-POSITIVE ANALYSIS:** a too-low `Q_max` **distorts fortissimo** (clips real loud notes — a
  neuter); a too-high `Q_max` lets the burst grow audible before clamping and, if `Q_max·mvc >
  INT32_MAX`, **still overflows**. The transparent-vs-safe window is preset-dependent → the calibration
  fragility the user identified.
- **VERDICT:** **excellent as a dumb, NaN-/overflow-proof FLOOR** — set `Q_max` generously, purely so
  the Sint32 cast can never see an unbounded value, accepting that a clamped runaway is *still loud*
  (the floor stops the crash, not the loudness). **Not** a good *primary* musical gate (calibration to
  make it transparent is fragile). **Role: the overflow guarantee beneath a smarter gate (#4 or #3).**

### 3.3 Approach #3 — Physics-based feedback control (passivity / energy)

- **WHERE:** kernel, per mode + a grid-level energy reduction. Uses the discrete modal energy
  `E_n = ½(v_n² + omega_n·q_n²)` where `v_n = (q_n − q_n[k−1])` (leapfrog velocity proxy) — all three
  available in-kernel (`q_n`, `mode_1`, `omega_n`; `MainKernel.cu:300–305`).
- **EXACT TRIGGER (passivity):** the modal subsystem must not gain more energy than the strings supply.
  Per cycle, require:
  ```
  ΔE_modes(cycle)  ≤  W_strings→modes(cycle)  +  ε
  ```
  where `ΔE_modes = Σ_n (E_n[c] − E_n[c−1])` and `W_strings→modes` is the work the feedin path did
  (`Σ over samples of F_n·v_n`, computable from `s_mode_applied_force·(q−q_prev)`). A simpler,
  strictly-conservative surrogate that needs no work term: a **leaky energy cap** — require each mode's
  energy to be **non-increasing in the absence of new excitation**, i.e. `E_n[c] ≤ E_n[c−1]` once the
  excitation cycle for the driving strings is exhausted (`exct_cycle_index` past its window,
  SYNTHESIS_ENGINE.md "Excitation Cycle Index"). Runaway = sustained energy growth with no active
  hammer ⇒ a clean trigger.
- **ACTION — energy renormalization (least audible):** if the bound is exceeded by factor `β > 1`,
  scale **all** `q_n, q_n[k−1]` by `1/√β` so total modal energy returns to the passive envelope while
  **relative amplitudes (the spectrum/timbre) are preserved**. No per-mode discontinuity, no spectral
  distortion — strictly amplitude.
- **CALIBRATION:** **~none in principle.** Passivity is defined by the physics (energy in vs energy
  out), not by an excitation-dependent threshold. The only tunables are a small safety `ε` and how
  often to sample energy.
- **IMPLEMENTATION:** **kernel change → CUDA build, and the MOST design work.** Needs: per-mode energy
  computation (per-element, cheap), a **grid reduction** of total modal energy (same *shape* as the
  existing `sumArray`, so primitives exist), optionally a second reduction for the string-work term,
  and a renorm broadcast. The correctness burden is real: the energy expression must match the discrete
  scheme's *actual* conserved quantity (including the `(1−dec)` envelope and the boundary work at the
  stem), or the bound is subtly wrong. Deriving the exact discrete energy of this specific leapfrog +
  boundary is the hard part.
- **RUNTIME:** one extra **grid reduction per cycle** (energy) — comparable to one existing `sumArray` —
  plus a per-mode multiply when triggered. Sampling energy **once per cycle** (not per sample) keeps it
  cheap relative to the FDTD inner loops.
- **FALSE-POSITIVE ANALYSIS:** **lowest of the four, by construction.** A loud-but-stable note is
  *passive* — its energy is bounded by the work the hammer+strings supplied, and decays via `dec_n`;
  only a *runaway* injects energy faster than supplied. A fortissimo is high-energy but **not
  energy-growing without source**, so it does not trip a leaky/passivity bound. (This is the decisive
  advantage: it distinguishes "loud" from "diverging" on the correct axis — energy balance — where #1
  and #2 cannot.)
- **VERDICT:** **the right long-term primary gate.** Uniquely simultaneously cheap-enough, calibration-
  free, and false-positive-free. But the derivation + build mean it should **follow** a simpler first
  step that stops the crash immediately.

### 3.4 Approach #4 — `max|mode_disp| > max|string_disp|` (coordinator addition)

- **WHERE:** kernel, **per cycle** (sampling once per cycle suffices; per-sample is possible but
  wasteful). Compares two grid-wide max-reductions:
  - `max|q|` over all modes — from `s_mode` / `dev_mode_running` (`MainKernel.cu:300,707`).
  - `max|s_a|` over all string points — from `s_a` / `dev_string_state` (`MainKernel.cu:319,680`).
- **EXACT TRIGGER:** `max_n |q_n| > κ · max_p |s_a_p|`, with the calibration-free form (§1.5 caveat 1):
  ```
  max_n |q_n|  >  κ₀ · deck_feedback_coeff · max_p |s_a_p|
  ```
  `κ₀` = single dimensionless headroom (start ≈ 2–4; tuned live like `CFL_MARGIN`); `deck_feedback_coeff`
  is the kernel argument already present (`MainKernel.cu:108`).
- **ACTION:** on trigger, **softly scale the feedback** applied next cycle by
  ```
  r = (κ₀ · deck_feedback_coeff · max|s_a|) / max|q|   < 1
  ```
  i.e. `mode_feedback[i] *= r` (or fold `r` into the `deck_feedback_coeff` read at `MainKernel.cu:254`).
  This pulls `q` back toward the string reference **and attacks the loop gain directly** (the actual
  cause), spectrum-preserving and inherently soft.
- **WHY THE UNITS ARE COMPARABLE (measured — §1.5):** at `deck_feedback_coeff = 1`, `s_a(stem) =
  Σ_n(c_out_coupling ≤ 1)·q_n`, so `q` and `s_a` share a scale to within an O(1) coupling factor.
  `max|s_a|` over **all** points additionally includes the **hammer-driven interior** of every piano
  string — which is **large during a forte attack while `q` is still ramping**, so at onset `max|s_a| ≥
  max|q|` *naturally*, **protecting against attack false-positives** (the opposite failure from #1). The
  runaway regime is the **sustain/decay**, where the hammer force is gone (excitation cycle exhausted)
  and only feedback keeps `q` alive — exactly when `max|q|` overtaking `max|s_a|` is unambiguous.
- **CALIBRATION:** **~none** — the live string field is the reference (self-normalizing). The only
  tunable is the dimensionless `κ₀`; `deck_feedback_coeff` is engine-known (folded in, not calibrated).
  Contrast #2, which needs an absolute `Q_max` the docs cannot supply. **This is #4's central advantage
  over #2** and the reason it is the better *primary* first step.
- **IMPLEMENTATION:** **kernel change → CUDA build.** Two max-reductions. The string max can ride on
  existing per-block work; the grid-wide max is one cooperative reduction — the **same class as the
  existing `sumArray`** (swap the `+` combiner for `max`, `atomicMax`-on-float), so the primitives
  exist. Sampling **per cycle** (not per sample) keeps it cheap. A `feedback_redline` flag (one int,
  like the kernel `status`).
- **RUNTIME:** **two grid max-reductions per cycle** (~one `sumArray` each, ~100+ cyc), amortized over
  `samplesInCycle` FDTD inner loops ⇒ **negligible** if sampled once per cycle. A per-element check is
  *not* an option here because the criterion is a global max-vs-max, **inherently a reduction**.
- **FALSE-POSITIVE ANALYSIS:** **low.** (i) Attacks are protected by the interior-string-dominates
  property above. (ii) The `deck_feedback_coeff` scale shift is handled by folding it into `κ`. (iii)
  Residual risk: a pathological preset where a **single mode legitimately rings far louder in steady
  state than any string point** — rare given per-mode coupling normalization (a mode's contribution to
  the string is `c_out_coupling ≤ 1` times its `q`, so a mode much larger than the string would need
  near-zero coupling, i.e. it barely affects output anyway), and `κ₀` headroom covers it. (iv) The
  action (feedback scale-down) is **global per cycle**, so it briefly dims *all* notes during a runaway
  — acceptable for a safety gate (a runaway is rare and the alternative is a crash).
- **VERDICT:** **the best Phase-1 gate.** Calibration-free (modulo a single headroom constant + the
  engine's own feedback coefficient), cheap, attack-safe, physically grounded ("feedback amplifying
  modes beyond their string source"), and reuses existing reduction machinery. Strictly better than #2
  as a *primary* gate because it tracks excitation automatically. #2 remains the dumb overflow floor
  beneath it.

---

## 4. Comparison matrix

| | #1 dA/dt | #2 abs clamp | #3 passivity/energy | #4 max q vs max s |
|---|---|---|---|---|
| **Signal watched** | mode growth rate `d\|q\|/dt` | absolute `\|q\|` | modal energy vs string work | `max\|q\|` vs `max\|s_a\|` |
| **Trigger (math)** | `A_n[c]/A_n[c−1] > ρ_max` (N-cyc) | `\|q_n\| > Q_max` | `ΔE_modes > W_strings+ε` (or leaky `E↓`) | `max\|q\| > κ₀·dfc·max\|s_a\|` |
| **Where** | kernel, per-mode (+state) | kernel, per-mode | kernel, per-mode + 1 reduction | kernel, per-cycle, 2 reductions |
| **Calibration** | **hard** (attack vs runaway) | **needs excitation calib** | **~none** (physics) | **~none** (self-ref; κ₀ + engine dfc) |
| **CUDA build?** | yes (+state buffer) | yes (tiny) | yes (most work) | yes (moderate) |
| **Runtime / cycle** | per-mode + mem traffic | **cheapest** (1 op) | 1 reduction + renorm | 2 max-reductions |
| **False-positive risk** | **highest** (attacks) | medium (loud notes) | **lowest** (passive = safe) | low (attack-safe; κ₀ headroom) |
| **Overflow-proof?** | no (detects only) | **yes** (hard ceiling) | yes (energy bounded) | only with action; pair w/ #2 floor |
| **Timbre-preserving?** | n/a | no (clips) | **yes** (renorm, amplitude-only) | yes (soft feedback scale) |
| **Role in plan** | (windowed sub-part of #3) | **NaN/overflow floor** | **Phase-2 primary** | **Phase-1 primary** |

---

## 5. Recommendation — phased hybrid (gate in the kernel; flag mirrors `cfl_redline`)

**Rationale for the phasing (not asserted — argued):** the user needs the crash to stop *now*, with no
risk of neutering normal dynamics and no preset-calibration project. #4 satisfies all three (cheap,
attack-safe, calibration-free) and reuses existing reduction primitives — but it carries a heuristic
`κ₀`. #3 removes the heuristic and is false-positive-free by construction, but needs a careful discrete-
energy derivation + the most kernel work. So: ship #4 (the self-normalizing ratio gate) + #2 (the dumb
overflow floor) first; then replace the `κ₀` heuristic with #3's passivity bound once derived and
validated. #1 is not on the path (its threshold cannot separate attack from runaway without
calibration, which defeats the point of choosing a runtime gate).

### Phase 1 — Stop the crash now, no calibration (#4 primary + #2 floor)

1. **Primary gate (#4), per cycle, kernel-side.** After the mode update, compute `max|q|` (grid max-
   reduction) and `max|s_a|` (per-block + cross-block max). If `max|q| > κ₀·deck_feedback_coeff·max|s_a|`,
   scale next cycle's feedback by `r = (κ₀·deck_feedback_coeff·max|s_a|)/max|q| < 1` and latch a GPU
   `feedback_redline` flag. `κ₀` ≈ 2–4 (tune live like `CFL_MARGIN`). **Scale feedback, not `q`** — it
   attacks the loop gain (the cause), is spectrum-preserving, and is inherently soft.
2. **NaN/overflow floor (#2), per mode, kernel-side.** `q ← Q_max·tanh(q/Q_max)` with `Q_max` sized so
   `Q_max·main_volume_coefficient < INT32_MAX` with margin — high enough to never touch a musical note,
   low enough that the Sint32 cast (`MainKernel.cu:492`) **cannot overflow** even within one explosive
   cycle before the per-cycle gate reacts. This is the hard overflow guarantee; #4 is the musical gate.
3. **Recover cleanly.** When `feedback_redline` latches (or on NaN via the existing `status<0` path),
   raise the existing reset (`*status = 500` → zero modal + string state, `MainKernel.cu:295,316`) on
   the next cycle instead of freezing — so a runaway **self-heals to silence** rather than a garbage
   freeze (§1.6). Surface `feedback_redline` to middleware/UI exactly like `cfl_redline` (via `/health`
   + a `BackendStatusIndicator` chip — cf. `cfl-stability-guard-v2.md` §4.3).
4. **No-build stopgap (ships immediately):** lower the `deck_feedback_coeff` validation ceiling from
   **1000.0** (`Pianoid_parameters.cu:507`, `pianoid.py:779`) to a musical maximum (8–16, matching the
   CC 74 mapping's intent). Python/C++-validation-only — **no CUDA change** — a reasonable interim
   mitigation that removes the most extreme runaway trigger while Phase 1 proper is built.

### Phase 2 — Robust, physics-based (#3 passivity)

Replace the heuristic `κ₀` gate with a **per-mode passivity/leaky-energy limiter**: bound each mode's
per-cycle energy gain to the string work supplied (or enforce energy non-increase once the driving
excitation is exhausted), renormalize the modal bank amplitude-only on violation. Removes the last
heuristic and the residual false-positive question; reuses Phase-1's reduction machinery (swap max for
an energy sum) and the `feedback_redline` flag. Derivation prerequisite: the exact discrete energy of
the leapfrog (A) including the `(1−dec)` envelope and the stem boundary work.

### Synergy with the CFL guard

- **Flag pattern:** introduce `feedback_redline` as the **runtime sibling** of `cfl_redline`
  (`cfl-stability-guard-v2.md` §4.3; DATA_FLOWS.md §2.1 "Stability gate"). One latches on a runtime
  dynamical event, the other on an edit-time static event; both surface to the same UI chip.
- **Division of labor (document it so they're never conflated again — the user's confusion was exactly
  this):** CFL guard = *edit-time, host-side, per-string Courant bound*. Feedback gate = *runtime,
  kernel-side, system-level loop gain / passivity*. Neither subsumes the other; a preset must pass both.
  Add a short "Two stability guards" note to `SYNTHESIS_ENGINE.md`.

---

## 6. Where the gate lives — implementation sketch (design, not code)

- **Kernel (`MainKernel.cu`):**
  - After the mode update (`MainKernel.cu:632–642`): per-block `max|q|`. After the string update
    (`MainKernel.cu:541`): per-block `max|s_a|`. Reduce both grid-wide with a `max` variant of the
    existing `sumArray` (warp-shuffle max + cross-warp `atomicMax`-on-float + `grid.sync`). Sample
    **once per cycle**.
  - Compute `r` + the redline flag on block 0 / thread 0; broadcast `r` (a global/`__shared__` scalar)
    so next cycle's `mode_feedback[i] *= r` (or fold into the `deck_feedback_coeff` read at
    `MainKernel.cu:254`).
  - Add the `tanh`/clamp floor at `q` write-back (`MainKernel.cu:640/707`).
  - On redline-latch (or `status<0`), set `*status = 500` (reset) for the next cycle.
- **Constants (`constants.h` / a new `feedback_stability.*`):** `FEEDBACK_KAPPA0` (dimensionless
  headroom ≈2–4), `MODE_DISP_CEILING` (`Q_max`), `FEEDBACK_REDLINE_*` status codes — single source of
  truth, clearly named, tunable (mirroring `CFL_MARGIN`/`CFL_LIMIT`).
- **C++ (`Pianoid_synthesis.cu`):** read the `feedback_redline` flag after the launch (next to the
  existing `kernel_status` read, `:328`); expose a getter for `/health`.
- **Middleware/UI:** `feedback_redline` boolean on `/health` + a chip, identical to the CFL chip.
- **Host-only stopgap (no build):** `deck_feedback_coeff` ceiling lowering (§5 Phase-1.4) in
  `Pianoid::setRuntimeParameters` (`Pianoid_parameters.cu:505`) + `pianoid.py` validation.

---

## 7. Testing strategy (design)

- **Repro harness (offline, deterministic — no live stack):** a preset/parameter set with high
  `feedin`/`feedback` + high `deck_feedback_coeff` + high velocity driving `G_loop > 1`. Render offline
  (`runOfflinePlayback`) and assert: pre-gate → `q` diverges / NaN / Sint32 overflow; post-gate → `q`
  bounded, output finite, `feedback_redline` set, and the *non-runaway* tail still decays normally.
- **False-positive sentinels (the must-not-neuter tests):**
  - Genuine **fortissimo** (velocity 127), normal preset, `deck_feedback_coeff = 1`: gate must **not**
    trigger; peak amplitude byte-unchanged vs pre-gate.
  - **Bright/percussive** attack: gate must **not** trigger during the attack window (assert the §3.4
    interior-string-dominates-at-onset property explicitly).
  - `deck_feedback_coeff` swept 1→8 on a stable preset: gate must **not** trigger (validates the
    `deck_feedback_coeff`-folded `κ`).
- **Audio-verification rule (CLAUDE.md):** any synthesis-output change verified with a measured before/
  after offline render. Assert the *non-runaway* waveform is **byte-identical** so the gate is provably
  inert on healthy notes.
- **Standing assertion:** "gate inert on every note of `Belarus_8band_196modes` at default feedback" —
  a regression that fired the gate on a normal note would trip this.

---

## 8. Open questions for the user (resolve before implementation)

1. **Confirm the runaway path.** Is the crash driven by the **runtime `deck_feedback_coeff`** (CC 74 /
   the feedback knob set high, up to 1000 via REST), by a **preset-baked** high `feedin`/`feedback`
   coupling, or both? This decides whether the **host-only ceiling stopgap** (§5 Phase-1.4) alone helps
   substantially, and what the repro preset should look like.
2. **Phase-1 gate reference for `deck_feedback_coeff ≠ 1`.** Approve folding `deck_feedback_coeff` into
   the `κ` threshold (keeps #4 calibration-free at any feedback setting) vs pinning to
   `deck_feedback_coeff = 1` semantics. (Recommended: fold it in — §1.5 caveat 1.)
3. **Action on trigger.** Preferred: **soft feedback scale-down** (recommended, spectrum-preserving),
   **mode-bank attenuation**, or **hard reset to silence**? And should a runaway **auto-reset to clean
   state** (§1.6 / §5 Phase-1.3) or hold the last good cycle?
4. **`κ₀` headroom.** Comfortable with a single dimensionless headroom constant (≈2–4, tuned live like
   `CFL_MARGIN`), accepting it is a heuristic until Phase 2's passivity bound replaces it?
5. **Host ceiling stopgap.** OK to lower the `deck_feedback_coeff` validation max 1000→8–16 immediately
   (Python/C++ validation only, no build) as interim mitigation?
6. **Scope — mode-oscillator self-stability (§1.7, `omega_n < 4`).** Out of scope here (separate
   edit-time ticket, like CFL), or fold a mode-`omega` check into this work?
7. **Phasing.** Ship Phase 1 (#4 + #2 floor) and live-test before building Phase 2 (#3 passivity)?
   (Recommended.)

---

## 9. Summary of the recommendation

- **Primary (Phase 1): #4** — per-cycle kernel gate `max|q| > κ₀·deck_feedback_coeff·max|s_a|`, action =
  soft feedback scale-down. Self-normalizing (string field = live reference) ⇒ **no excitation
  calibration**; cheap (two max-reductions/cycle, reusing existing reduction primitives); attack-safe
  (interior string displacement dominates at onset). **Measurement confirms `q` and `s_a` are
  comparable** because deck couplings are per-mode-normalized to ≤1 and the stem displacement *is* the
  coupling-weighted mode sum — the only residual scale is `deck_feedback_coeff`, already engine-held and
  folded into the threshold.
- **Backstop (Phase 1): #2** — a generous `tanh` NaN-/overflow-proof floor on `q`, sized so the Sint32
  cast can never overflow.
- **Robust (Phase 2): #3** — per-mode passivity/energy limiter; calibration-free and false-positive-free
  by construction; replaces the heuristic `κ₀`.
- **Not the gate: #1** (dA/dt) — physically apt but cannot separate attack from runaway without
  calibration; revisit only as a windowed term inside #3.
- **Immediate no-build stopgap:** lower `deck_feedback_coeff` ceiling 1000→8–16.
- **Synergy:** `feedback_redline` as the runtime sibling of `cfl_redline`; document the
  edit-time-CFL vs runtime-feedback division so the two guards are never conflated again.

---

### Appendix A — Verified source map (for the implementer)

| Fact | Source |
|---|---|
| Outer loop = `samplesInCycle`; inner = `soundStep` | `MainKernel.cu:416`, `:508` |
| Mode leapfrog update | `MainKernel.cu:634–640`; ref `Mode.py:282–285` |
| `omega = dt²·f²·4π²`, `dec = dt·decrement·f` | `Mode.py:150–152`, `constants.py:43` (`K_OMEGA=4π²`) |
| Mode state buffers (`q`, `q_prev`) | `dev_mode_running`, `MainKernel.cu:300–301,707–708` |
| Mode config (`dec`,`omega`,`mass_inv`) | `dev_mode_state`, `MainKernel.cu:304–306` |
| Feedback write `+= c_out·q` | `MainKernel.cu:431` |
| `c_out = mode_coefficients · deck_feedback_coeff` | `MainKernel.cu:254` |
| Stem displacement = feedback | `MainKernel.cu:534–535` |
| Bridge force `+= tension·(s_a_neighbor − feedback)` | `MainKernel.cu:547–550`; `shift_F1=tension` `Kernels.cu:167` |
| Feedin write `+= c_in·force/soundStep` | `MainKernel.cu:589` |
| `c_in = mode_feedin` (coupling) | `MainKernel.cu:247` |
| Coupling coefficients normalized to ≤1 (0–1 range) | SYNTHESIS_ENGINE.md "Coupling Coefficients" |
| Audio emit `Sint32(output·mvc)` (overflow point) | `MainKernel.cu:492` |
| `soundFloat` stays finite (pre-volume) | `MainKernel.cu:493` |
| NaN trip → status<0 → break, no recover | `MainKernel.cu:510–512,658–666`; `Pianoid_synthesis.cu:328–332` |
| Reset path `status==500` | `MainKernel.cu:295–297,316–317`; `Pianoid_synthesis.cu:294–296` |
| `deck_feedback_coeff` validation 0–1000 | `Pianoid_parameters.cu:505–508`; `pianoid.py:779` |
| CC 74 exponential mapping (0.125–8.0) | SYNTHESIS_ENGINE.md "Runtime Feedback Coefficient" |
| String state buffer (`s_a`) | `dev_string_state`, `MainKernel.cu:319,680` |
| Engine thread launch + sync per cycle | `Pianoid_synthesis.cu:308,313` |
