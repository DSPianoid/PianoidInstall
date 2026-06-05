# Proposal: Modes-Explosion → NaN Runtime Gate

- **Status:** DESIGN / RESEARCH — for user review. **No implementation, no engine edits, no build.**
- **Author:** dev-d52b (research + first-principles design, building on hot context from the 2026-06-04
  feedback-coefficient + output soft-limiter work). Maximum-reasoning-depth pass.
- **Scope:** A **runtime** gate that detects soundboard-**mode-state divergence** (modal displacement
  `q_n` growing toward `float` overflow / `NaN`) and acts on it **before** the NaN poisons the engine.
- **Supersedes:** `docs/proposals/feedback-excitation-gating-2026-05-30.md` (archived to
  `docs/proposals/archive/`). That proposal characterized the same closed-loop runaway and proposed four
  detection gates (#1 dA/dt, #2 abs clamp, #3 passivity/energy, #4 max|q| vs max|s|). **This document
  carries that analysis forward unchanged in substance** and updates it with three things learned since:
  (1) an **output soft-limiter now exists** (`LIMITER_CEILING·tanh`, dev-d52b) — and it does **NOT**
  solve this problem (it is downstream of the mode state; `tanh(NaN)=NaN`); (2) **measured** bounded-vs-
  divergent behaviour distinguishing "loud" from "diverging"; (3) a **per-output-channel telemetry +
  latch infrastructure** (`dev_limiter_peak`, `getLimiterPeaks`, `/health` `limiter`, `feedback_redline`-
  style flag) the gate's UI surface can reuse.
- **Relation to the two existing guards (keep them distinct — the user has conflated them before):**
  | Guard | When | Where | Catches |
  |---|---|---|---|
  | **CFL stability guard** (`cfl_stability.py`, `cfl-stability-guard-v2.md`) | **edit-time** (pre-upload) | host (Python) | a *single string's* explicit FDTD recurrence diverging on a **coefficient edit** (static Courant bound) |
  | **Output soft-limiter** (dev-d52b, `LIMITER_CEILING·tanh`, `MainKernel.cu` output write) | **runtime, per sample** | kernel, **downstream of modes** | the **output sample** exceeding ±ceiling (headroom/clip control) |
  | **THIS proposal: modes-explosion gate** | **runtime, per cycle** | kernel, **on the mode state** | the **mode displacement `q_n`** diverging toward overflow/NaN (system-level loop instability) |
  None subsumes the others; a preset/run must survive all three.

---

## 0. TL;DR

The output soft-limiter shipped this session bounds the *emitted sample* but sits **downstream of the
mode oscillator state**. If a mode displacement `q_n` diverges (closed-loop feedback instability, or a
bad mode-`omega` edit), the divergence reaches the limiter as `output = feedback − s_b` already `Inf`/
`NaN`, and `LIMITER_CEILING·tanh(NaN) = NaN` — so the limiter does **not** prevent the NaN, the freeze,
or the pre-NaN Sint32-overflow burst. The runtime gate must therefore act **on `q_n` itself, per cycle,
in the kernel**, before the value propagates.

This session **measured** the discriminator the gate needs: a loud-but-stable note **decays** (energy
falls to ~zero in the tail; mode displacement at end-of-render `1e-8…1e-6` across the whole feedback
range), whereas a runaway **grows without bound**. "Loud" and "diverging" separate cleanly on the
**growth/energy** axis, not on absolute amplitude — confirming the prior proposal's conclusion that the
right gate watches *divergence*, not *level*.

**Recommendation (unchanged in spirit from the superseded proposal, re-confirmed by measurement):**
phased —
- **Phase 1 (stop the NaN now, no calibration):** a **composite criterion** (derived in §3) — the
  per-cycle **string-referenced ratio** `max|q| > κ₀·deck_feedback_coeff·max|s_a|` (catches divergence
  magnitude, attack-safe, self-normalizing) **AND** a short **windowed growth guard** (`max|q|`
  non-decreasing over N≈4–8 cycles — catches "growth where the physics mandates decay", rejecting healthy
  transients that immediately decay). Requiring BOTH makes a false positive need two simultaneous
  violations the measured-healthy envelope never produces (§3.4). Action = soft feedback scale-down +
  `modes_redline` flag + clean reset to silence. Pair with a `tanh` **NaN/overflow FLOOR** on `q`
  (independent of detection latency).
- **Phase 2 (principled):** **aggregate energy passivity** (modal energy non-increasing post-excitation)
  or **per-mode expected-`mode_dec`-decay** comparison — calibration-free, false-positive-free by
  construction; replaces the `κ₀`/`N` heuristics (§3.3 C4/C5).
- **Immediate no-build stopgap:** lower the `deck_feedback_coeff` validation ceiling (1000 → 8–16).

The detection POINT, THRESHOLD, ACTION, and COST are detailed in §3–§6. Open questions in §8.

---

## 1. Why the new output soft-limiter does NOT already solve this

The dev-d52b soft-limiter (approved + built this session) is, in the kernel at the output write:

```
output = feedback − s_b;                 // feedback = Σ_n c_out(n)·q_n  (the mode sum at the receiver)
output = LIMITER_CEILING · tanh(output / LIMITER_CEILING);   // bound the EMITTED sample
soundInt   = Sint32(output · main_volume_coefficient);
soundFloat = output;
```

- It operates on the **output sample**, which is *derived from* the mode state (`feedback = Σ c_out·q`),
  **after** the modes have advanced for the cycle. It never touches `q_n`, `mode_1` in
  `dev_mode_running`.
- If `q_n` has already diverged, `feedback` is `Inf`/`NaN`, and `tanh(±Inf)=±1` but **`tanh(NaN)=NaN`** —
  the moment any `q_n` becomes `NaN` (subtracting two `Inf`s in the FDTD interior), the limiter passes
  the NaN straight through. The existing always-on `isnan(target)` trip (`MainKernel.cu:532`) then
  freezes the cycle with no auto-recovery — exactly the failure the superseded proposal traced (§1.6
  there).
- Even **before** NaN, the limiter helps the *audible* artifact (it bounds `soundFloat`/`soundInt` while
  `output` is finite-but-huge), so it does reduce the Sint32-overflow burst — but it does **nothing** to
  arrest the underlying `q_n` divergence, which will reach NaN a cycle or two later and freeze the
  engine. **The limiter is a downstream cosmetic clamp on the symptom; the modes gate is the upstream
  cure on the cause.**

⇒ The two are complementary: keep the limiter for headroom on healthy-but-loud output; add the modes
gate to stop divergence at the source.

---

## 2. Measured basis (this session) — "loud" vs "diverging" separate on growth, not level

From the dev-d52b diagnosis runs (offline `runOfflinePlayback`, Belarus_8band_196modes, listen-to-modes
off; diagnostics: `docs/development/diagnostics/dev-d52b-runaway-diagnosis.py`,
`dev-d52b-headroom-design.py`):

- **A stable note DECAYS** at every feedback setting incl. coeff=0: time-windowed RMS falls from the
  attack window to ~zero by the tail (late/early ratio `1e-3 … 1e-6`); **mode displacement at
  end-of-render is `1e-8 … 1e-6`** across the whole sweep — modes do **not** diverge in the healthy
  regime, even when the *output* is loud (peak pre-limit up to 19.5 at coeff=0).
- This is the empirical confirmation that **loudness ≠ divergence**: a low-feedback note is loud (large
  attack transient) yet its mode state stays bounded and decays. The gate must therefore key on
  **sustained growth / energy imbalance**, not on `|q|` or `|output|` magnitude — precisely why the
  prior proposal ranked the absolute-clamp (#2) as a dumb floor and the ratio/energy gates (#4/#3) as
  the musical detectors.
- A genuine runaway (the user's reported crash class; `G_loop > 1` in the superseded §1.2) instead shows
  `q_n` growing geometrically every sample with no decay — the regime the gate exists to catch.

**Implication for the threshold:** the bounded regime gives a concrete reference. At healthy settings,
`max|q|` stays at or below the live string field `max|s_a|` (modulo the `deck_feedback_coeff` scale, see
superseded §1.5, measured). A gate that fires when `max|q|` overtakes `κ₀·deck_feedback_coeff·max|s_a|`
is **inert across the entire measured healthy sweep** and trips only on the divergent regime — the
"calibration-free, attack-safe" property the prior analysis argued, now backed by this session's data.

---

## 3. THE DETECTION CRITERION (central section — maximum rigor)

This is the crux. A gate is only as good as its ability to fire on genuine divergence **and stay silent
on every healthy note**, including the loud, low-feedback notes the user explicitly wants un-clamped.
This session proved how easy it is to get this wrong: a 100 ms window reported peak **42** and looked
like an explosion, but windowing the full 800 ms render proved it was **bounded and decaying** — a
healthy note. **The criterion must not repeat that mistake.** §3.1 states the discriminating principle,
§3.2 derives the measured signature of "healthy", §3.3 evaluates five candidate criteria against
false-positive/false-negative tradeoffs, §3.4 specifies the chosen criterion precisely, §3.5 lists the
residual failure modes it does *not* cover (handed to the backstop / Phase 2).

### 3.1 The discriminating principle: divergence is a GROWTH property, not a MAGNITUDE property

A NaN is reached by *unbounded growth*, not by being momentarily large. The physical system has exactly
one thing that distinguishes a runaway from a loud note: **after the hammer excitation ends, a healthy
mode DECAYS** (its `mode_dec` damping envelope removes energy every sample), whereas a **diverging mode
GROWS** (the feedback loop injects energy faster than `mode_dec` removes it — superseded §1.3 energy
form). Therefore the criterion must measure **the sign and rate of `|q_n|` change relative to the
expected decay**, not the level of `|q_n|`. Any criterion that thresholds raw magnitude is measuring the
wrong axis and will false-positive on loud-but-bounded notes (the trap above).

Two corollaries that the criterion must respect:
1. **The attack is a legitimate steep rise.** At note onset `|q_n|` jumps from ~0 by orders of magnitude
   within a few cycles (impulsive hammer force). A growth-rate gate must therefore be **gated to the
   post-excitation regime** (or reference the string field, which is hammer-dominated at onset) — else
   it fires on every fortissimo attack (superseded §3.1 — this is exactly why naive dA/dt was rejected).
2. **The expected decay rate is known per mode.** `mode_dec` (= `dt·decrement_n·f_n`, superseded §1.1) is
   the per-mode damping coefficient already in `dev_mode_state`. A healthy mode's amplitude envelope
   should be **non-increasing at a rate ≥ the `mode_dec` envelope** once the hammer is gone. This gives a
   *physically-derived, per-mode, calibration-free* expectation to compare against — the strongest form
   of the criterion.

### 3.2 The measured signature of "healthy" (anchors every threshold below)

From this session's `dev-d52b-runaway-diagnosis.py` (Belarus pitch 57, 100 ms note, 800 ms render, 8
equal time-windows; per-window RMS, all feedback settings). **This is what the gate must treat as inert:**

| coeff | W1 (attack) | W2 | W3 | W4 | … | W8 (tail) | late/early | mode_disp@end |
|---|---|---|---|---|---|---|---|---|
| 1.0 | 0.410 | 0.0886 | 0.00353 | 0.00181 | … | 0.000143 | 3.5e-4 | 3.0e-8 |
| 0.5 | 0.766 | 0.163 | 0.00960 | 0.00544 | … | 0.000329 | 4.3e-4 | 1.3e-7 |
| 0.1 | 3.65 | 0.744 | 0.0441 | 0.0344 | … | 0.00760 | 2.1e-3 | 6.5e-6 |
| 0.01 | 8.33 | 2.35 | 0.0148 | 0.0103 | … | 0.00588 | 7.1e-4 | 2.4e-6 |
| 0.0 | 8.21 | 2.24 | 0.0468 | 0.00826 | … | 9.0e-6 | 1.1e-6 | 3.4e-8 |

**Quantitative healthy signature (the gate's "must not fire" envelope):**
- **Monotone decay after the attack.** Every setting: `W_{k+1} < W_k` for all k≥1 (the loudest, coeff=0,
  even reaches the noise floor 9e-6). The attack (W1) is the global max; from W2 on the envelope only
  falls. The single largest cycle-over-cycle DROP is W2→W3 (e.g. coeff=0: 2.24→0.047, a **48× drop in
  one window** ≈ ~100 ms). There is **no window anywhere that grows**.
- **Tail mode displacement is `1e-8 … 1e-6`** at every setting — six to eight orders below the attack
  amplitude. A healthy mode at rest is effectively zero.
- **Loudness does not predict divergence:** coeff=0 has the 2nd-highest attack RMS (8.21) yet the
  *deepest* decay (late/early 1.1e-6). The attack peak (19.5) and the divergence risk are uncorrelated —
  the whole point.

**The runaway counter-signature (from superseded §1.2/§1.6, not re-measured this session — no live
runaway preset was rendered; flagged as the one inference):** `|q_n|` grows geometrically every sample
with ratio >1, sustained across many cycles, with **no decay window**, until `float` overflow → interior
`NaN`. So the discriminator is stark: healthy = "every post-attack window strictly smaller, ratio ≪ 1";
runaway = "windows growing, ratio > 1, sustained." **A growth-vs-decay test has enormous separation
margin** (healthy per-window ratios are 0.02–0.5 falling; a runaway is >1 rising) — this is why the
criterion can be robust without delicate tuning.

> **Measurement gap flagged (CLAUDE.md high-stakes-inference rule):** I measured the HEALTHY envelope
> directly but did NOT render a confirmed runaway this session (would require constructing a
> `G_loop>1` preset/parameter set and is a divergence I deliberately did not trigger). The runaway
> signature is taken from the superseded proposal's first-principles derivation. **Before implementation,
> the repro harness (§7) must render an actual runaway and confirm the chosen criterion's growth signal
> fires on it** — the threshold separation is argued from healthy data + theory, not yet from a measured
> two-sided comparison.

### 3.3 Candidate criteria — false-positive / false-negative analysis

Five candidates, each judged on: does it fire on the measured-healthy envelope (FALSE POSITIVE — fatal,
clamps the notes the user wants loud)? does it miss a real runaway, or catch it too late to prevent the
burst/NaN (FALSE NEGATIVE / latency)?

**(C1) Absolute magnitude near the float/int rail** — `max|q| > Q_rail` (e.g. `Q_rail·mvc ≈ INT32_MAX`).
- FP: low (the rail is far above any healthy `|q|`). FN/latency: **fatal** — by the time `q` nears the
  rail it is one cycle from overflow; the Sint32 burst has *already* been emitted (superseded §1.6) and
  there's no headroom to recover gracefully. It detects the explosion *at* the explosion.
- Verdict: **not a detector.** Only useful as the dumb `tanh` overflow FLOOR (the backstop), never the
  trigger.

**(C2) Raw growth rate** — `max|q|[c] / max|q|[c−1] > ρ_max`.
- FP: **high** unless gated — the attack (corollary 1) is a legitimate steep rise (coeff=0 W1 is a huge
  jump from silence); a fixed `ρ_max` either passes the attack (and then misses slow runaways) or fires
  on every fortissimo. FN: misses slow runaways if `ρ_max` set high for attack safety.
- Verdict: **rejected as standalone** (superseded #1) — right idea (growth), wrong framing (no decay
  reference, attack-collision). It becomes correct when measured *against the expected decay* (C5).

**(C3) Ratio vs the live string field** — `max|q| > κ₀·deck_feedback_coeff·max|s_a|`.
- FP: **low.** The string field is the live reference; at onset the hammer-driven string interior makes
  `max|s_a|` large while `q` ramps (attack-safe by construction); in sustain a healthy `q` decays with
  the string. Measured healthy `q` is tiny in the tail, far under any `s_a`-scaled bound. Self-
  normalizing ⇒ **no absolute calibration**; `deck_feedback_coeff` folds in the only scale shift. FN:
  low — a runaway makes `q` overtake the string field it produces. Residual FP: a pathological preset
  where one mode legitimately rings far louder than any string point (rare — coupling normalization
  bounds a mode's string contribution to ≤1×`q`, so such a mode barely affects output anyway).
- Verdict: **strong Phase-1 primary.** Cheap, attack-safe, calibration-free modulo one headroom `κ₀`.
  Its one weakness vs C5: it's an *instantaneous* magnitude-ratio, so it fires only once `q` is already
  large (κ₀× the field) — slightly later than a pure growth signal, though still well before overflow.

**(C4) Aggregate energy/norm growth over a window** — `Σ_n E_n[c] > Σ_n E_n[c−W] · (1+ε)` once excitation
is exhausted (`E_n = ½(v_n² + ω_n q_n²)`, all in-kernel).
- FP: **lowest, by construction** — a passive (healthy) note's total modal energy is bounded by the
  hammer work supplied and only decays after onset; only a runaway grows energy without source. The
  measured monotone-decay envelope (§3.2) means aggregate energy falls every window post-attack ⇒ the
  gate is provably inert on it. FN: low. Cost: one extra grid energy-reduction/cycle (≈ one `sumArray`)
  + the correctness burden of deriving the discrete leapfrog's *actual* conserved energy (incl. the
  `(1−dec)` envelope + stem boundary work) — get that wrong and the bound is subtly off.
- Verdict: **the principled Phase-2 primary** (superseded #3). Most robust, most derivation. Deferred
  because it needs the energy derivation + validation; C3/C5 stop the crash first.

**(C5) Per-mode growth measured against the EXPECTED `mode_dec` decay envelope** — the discriminator
corollary 2 points to. A healthy mode, post-excitation, obeys `|q_n[c]| ≤ |q_n[c−1]| · D_n` where
`D_n = (1 − mode_dec_n)` is the per-cycle decay factor the scheme itself applies (envelope of the
leapfrog, superseded §1.1). **Divergence = the amplitude growing where the physics mandates decay:**
```
|q_n[c]|  >  |q_n[c−1]| · (1 − mode_dec_n)·(1 + ε)      (post-excitation, per mode)
```
- FP: **very low** — it compares each mode to *its own* physically-required decay, so it is intrinsically
  attack-gated (only checked once the mode's driving excitation is exhausted) and needs no global
  magnitude scale. The measured envelope (§3.2) decays *faster* than `(1−mode_dec)` would alone (because
  feedback is also removing energy at healthy settings), so healthy notes sit comfortably inside the
  bound. FN: low and **earliest detection of all candidates** — it fires the moment a single mode stops
  decaying as required, before `q` is even large (catches the runaway in its first growing cycles, not
  after it's κ₀× the string field). Cost: per-mode compare needs the previous cycle's `|q_n|` ⇒ a new
  per-mode envelope buffer (read+write/cycle, memory traffic) — heavier than C3's two reductions.
- Verdict: **the most physically-precise and earliest-firing detector.** Its cost (per-mode envelope
  state) and its need for a clean "excitation exhausted" signal per mode make it heavier to ship than C3.

**Synthesis of the tradeoff:** C1 is a floor, not a detector (rejected as trigger). C2 is the right
instinct mis-framed (rejected standalone). The genuine contenders are **C3 (instantaneous ratio vs
string field), C5 (per-mode growth vs expected decay), C4 (aggregate energy)** — all three measure
divergence on the growth/energy axis and are provably inert on the measured-healthy envelope. They trade
off **earliness/precision vs cost**: C5 fires earliest and is most precise (per-mode, physics-derived)
but needs per-mode envelope state; C4 is most robust (energy, false-positive-free) but needs the energy
derivation; C3 is cheapest and reuses existing reduction machinery but fires slightly later and carries
a `κ₀` heuristic.

### 3.4 Chosen criterion — precise specification

**Phase 1 — ship C3 as primary, add the C2/C5 growth signal as a confirming guard, C1 as the floor.**
Rationale: C3 alone stops the crash now with existing primitives and is attack-safe; pairing it with a
*windowed* growth check (the defensible core of C2, framed per §3.1 as "growth where decay is expected")
covers C3's one weakness (it fires only once `q` is already large). Precisely:

- **Quantity:** two grid reductions sampled **once per cycle**, at the end of the cycle after the mode
  update (`MainKernel.cu` mode update site) and after the string update (`MainKernel.cu:319` region):
  - `Q_max[c] = max_n |q_n|` over all modes (from `s_mode`/`dev_mode_running`).
  - `S_max[c] = max_p |s_a_p|` over all string points (from `s_a`/`dev_string_state`).
- **Primary trigger (C3):** `Q_max[c] > κ₀ · deck_feedback_coeff · S_max[c]`, `κ₀ ≈ 2–4` (dimensionless,
  tuned live like `CFL_MARGIN`; `deck_feedback_coeff` is the live kernel arg).
- **Confirming growth guard (windowed C2, decay-referenced):** require the trigger to PERSIST with
  `Q_max` non-decreasing across a short confirmation window of **N ≈ 4–8 cycles** (≈ a few ms) —
  `Q_max[c] ≥ Q_max[c−1]` sustained N cycles. This rejects a single-cycle spike (e.g. a transient that
  immediately decays per the §3.2 envelope) and confirms *sustained* growth, the runaway signature. The
  window length N is bounded above by the overflow latency (a runaway must not reach the rail within N
  cycles — checked in the repro harness; the `tanh` floor guarantees safety even if it does).
- **Per-mode vs aggregate:** **aggregate** (`max` over modes) for Phase 1 — cheapest, and a single
  diverging mode dominates the max. (Per-mode C5 is the Phase-2/1.5 upgrade for earliest detection.)
- **Where evaluated:** block 0 / thread 0 after the two grid reductions, once per cycle; sets a
  `modes_redline` flag + computes the scale-down factor `r` (§4) broadcast to next cycle.
- **Backstop floor (C1 as `tanh`):** independently, `q ← Q_max_floor·tanh(q/Q_max_floor)` at mode
  write-back, `Q_max_floor` sized so `Q_max_floor·main_volume_coefficient < INT32_MAX` with margin —
  guarantees no Sint32 overflow / NaN propagation even within the N-cycle confirmation window.

**Phase 2 — replace the C3+growth heuristic with C4 (aggregate energy passivity) or C5 (per-mode
expected-decay)**, once the discrete-energy derivation (C4) or the per-mode envelope buffer (C5) is built
and validated against the repro harness. Both remove the `κ₀`/`N` heuristics and fire earlier/cleaner.

**Why this composite, justified against the measured data:** on every row of the §3.2 table the primary
(C3) never fires (healthy `Q_max` ≪ `deck_feedback_coeff·S_max` once decaying) AND the growth guard never
fires (every post-attack window strictly decreases, so `Q_max` is monotone falling — the N-cycle
non-decreasing condition is never met). The two conditions are **independently** inert on the healthy
envelope, so requiring BOTH (primary magnitude-ratio AND sustained growth) makes a false positive
require two simultaneous violations the healthy data never produces — maximal robustness for Phase 1
without the energy derivation.

### 3.5 What this criterion does NOT cover (handed to backstop / Phase 2 / separate ticket)

- **A single-cycle jump straight to overflow** (faster than the N-cycle window): covered by the `tanh`
  FLOOR (C1), not the detector — the floor guarantees no overflow regardless of detection latency.
- **The mode oscillator's OWN numerical instability** (`ω_n ≥ 4` from a bad mode-frequency edit,
  superseded §1.7): this is an *edit-time, per-mode-parameter* hazard (like CFL), NOT a runtime loop
  runaway. Out of scope here; flagged as a separate edit-time check (open question §8.2).
- **Pathological "one mode legitimately louder than all strings" presets** (C3 residual FP): covered by
  `κ₀` headroom + the growth guard (a *legitimately* loud mode still decays, so the growth condition
  rejects it); fully removed by Phase-2 energy passivity.

---

## 4. Action on trigger

Recommended (spectrum-preserving, soft) — same as the superseded proposal, re-affirmed:

1. **Soft feedback scale-down (primary action):** on trigger, scale next cycle's feedback by
   `r = (κ₀·deck_feedback_coeff·max|s_a|) / max|q| < 1` (fold into the `deck_feedback_coeff` read or
   `mode_feedback[i] *= r`). This attacks the **loop gain** (the actual cause), pulls `q` back toward the
   string reference, and is inherently soft + spectrum-preserving (scales the drive, not the state
   discontinuously).
2. **Clean reset, not freeze:** when the gate latches (or on the `isnan` backstop), raise the existing
   reset (`*status = 500` → zero `s_mode`/`mode_1`/`s_a`, `MainKernel.cu:306,327`) on the next cycle so a
   runaway **self-heals to silence** instead of the current garbage freeze (superseded §1.6 — the C++
   side currently only logs, never resets).
3. **NaN-proof floor (backstop):** `tanh` clamp on `q` (above) guarantees the Sint32 cast never sees an
   unbounded value even within the single cycle before the per-cycle gate reacts.
4. **UI flag — `modes_redline` (runtime sibling of `cfl_redline`):** surface via `/health` + a
   `BackendStatusIndicator` chip. **Reuse the dev-d52b limiting-indicator infrastructure** built this
   session: the same latch pattern (`_limiting_latch` / `clear_limiting_latch` / `/clear_limiting` /
   preset-load auto-clear / `param_ack` WS ride) maps directly onto a `modes_redline` latch — clip-hold
   semantics, click-to-clear, survives the slow poll. This is a meaningful reuse win: the contract,
   backend latch, and chip wiring already exist; the modes gate just adds a second flag through the same
   pipe.

Alternatives (open question §8): mode-bank attenuation (scale all `q` by `1/√β`, prior #3 renorm) vs the
feedback scale-down vs hard reset.

---

## 5. Cost / feasibility (per-cycle budget)

The per-cycle cooperative-grid audio engine `cudaLaunchCooperativeKernel`s + `cudaDeviceSynchronize`s
each cycle; a runtime gate must be **GPU-resident, host-round-trip-free** (a per-cycle host readback
would stall the audio thread — the CFL guard's host-side edit-time pattern cannot be copied).

- **Phase 1 ratio gate:** two grid **max-reductions per cycle** (`max|q|`, `max|s_a|`) — same *class* as
  the existing `sumArray` warp-shuffle reductions the kernel already runs per sample for feedin/feedback
  (swap the `+` combiner for `max` / `atomicMax`-on-float). Sampled **once per cycle** (not per sample),
  amortized over `samplesInCycle` inner FDTD loops ⇒ **negligible** overhead. One `modes_redline` int +
  one broadcast scalar `r`. **Feasible with existing primitives; moderate kernel work.**
- **`tanh` floor:** one per-element op per mode (cheapest possible); no state, no reduction.
- **Phase 2 passivity:** one extra grid reduction per cycle (energy sum) + a per-mode multiply on
  trigger — comparable to one existing `sumArray`. The cost is in the **derivation** (exact discrete
  energy), not the runtime.
- **Telemetry reuse:** the gate can piggyback the dev-d52b `dev_limiter_peak`-style WORKING buffer
  pattern (small per-channel/per-flag GPU scalar, D2H only on `/health` poll) for `modes_redline` info —
  no new heavy path.
- **No-build stopgap (zero kernel cost):** lower the `deck_feedback_coeff` validation ceiling 1000→8–16
  (Python/C++ validation only) — removes the most extreme runaway trigger immediately while Phase 1 is
  built.

---

## 6. Implementation sketch (design, not code — for a future /dev cycle)

- **Kernel (`MainKernel.cu`):** after the mode update, per-block `max|q|`; after the string update,
  per-block `max|s_a|`; grid-reduce both with a `max` variant of `sumArray` (once per cycle). On
  block0/thread0 compute `r` + set `modes_redline`; broadcast `r` for next cycle's feedback read. Add
  the `tanh` floor at `q` write-back. On latch, set `*status = 500` for the next cycle.
- **Constants (`constants.h` / a `modes_stability.*`):** `MODES_KAPPA0` (≈2–4), `MODE_DISP_CEILING`
  (`Q_max`), `MODES_REDLINE_*` codes — single source of truth, tunable like `CFL_MARGIN`/`LIMITER_CEILING`.
- **C++ (`Pianoid.cu`/`Pianoid_synthesis.cu`):** read `modes_redline` after launch (next to
  `kernel_status`); getter for `/health` (mirror `getLimiterPeaks`).
- **Middleware/UI (`backendServer.py` + frontend):** `modes_redline` latch reusing the dev-d52b limiting
  latch pattern (`/health` flat field + `limiter`-style object + `param_ack` ride + `/clear_*` + preset-
  load auto-clear); a `BackendStatusIndicator` chip alongside the CFL + limiting chips.
- **Host-only stopgap (no build):** `deck_feedback_coeff` ceiling lowering in
  `Pianoid::setRuntimeParameters` + `pianoid.py` validation.

---

## 7. Testing strategy (design)

- **Repro harness (offline, deterministic):** high `feedin`/`feedback` + high `deck_feedback_coeff` +
  high velocity driving `G_loop>1`; `runOfflinePlayback` and assert pre-gate → `q` diverges/NaN/Sint32
  overflow; post-gate → `q` bounded, output finite, `modes_redline` set, non-runaway tail still decays.
- **False-positive sentinels (must-not-neuter):** fortissimo (vel 127, default feedback) — gate inert,
  amplitude byte-unchanged; bright/percussive attack — gate inert during attack (assert the interior-
  string-dominates property); `deck_feedback_coeff` swept 1→8 on a stable preset — gate inert. **Use
  this session's measured healthy sweep (mode_disp 1e-8…1e-6) as the standing "gate must stay inert"
  regression baseline.**
- **Audio-verification rule:** non-runaway waveform **byte-identical** pre/post-gate (gate provably inert
  on healthy notes).

---

## 8. Open questions for the user

1. **Confirm the divergence path.** Runtime `deck_feedback_coeff` (knob/REST up to 1000), preset-baked
   high coupling, or a bad **mode-`omega`** edit (the separate `omega_n < 4` mode-oscillator self-
   stability bound, superseded §1.7)? Decides whether the host ceiling stopgap alone helps + the repro.
2. **Mode-`omega` self-stability (superseded §1.7).** In scope here (fold an edit-time `omega_n<4` check
   alongside, like CFL) or a separate edit-time ticket? It is a *different* hazard (mode-parameter, edit-
   time) from the runtime loop runaway.
3. **Action on trigger:** soft feedback scale-down (recommended), mode-bank renorm, or hard reset to
   silence? Auto-reset to clean state vs hold last good cycle?
4. **`κ₀` headroom:** OK with a single dimensionless constant (≈2–4, tuned live) until Phase 2 passivity
   replaces it?
5. **Phasing:** ship Phase 1 (ratio gate + `tanh` floor + `modes_redline` reusing the dev-d52b latch) and
   live-test before building Phase 2 (passivity)?
6. **No-build stopgap:** lower `deck_feedback_coeff` ceiling 1000→8–16 immediately?
7. **Relationship to the output limiter:** confirm the modes gate is ADDITIVE to the dev-d52b output
   soft-limiter (limiter = downstream headroom; modes gate = upstream divergence) — not a replacement.

---

### Appendix A — what changed vs the superseded `feedback-excitation-gating-2026-05-30.md`

| Aspect | Superseded proposal | This proposal |
|---|---|---|
| Framing | feedback-loop runaway → crash | mode-state divergence → NaN (NaN-prevention angle) |
| Output limiter | did not exist | EXISTS (dev-d52b); shown NOT to solve this (downstream, tanh(NaN)=NaN) — §1 |
| Bounded-vs-runaway evidence | derived (G_loop) | MEASURED this session (decay + mode_disp 1e-8…1e-6 healthy) — §2 |
| UI/latch surface | proposed `feedback_redline` chip from scratch | REUSE dev-d52b limiting latch infra (`/health`, `/clear_*`, param_ack ride, chip) — §4.4 |
| Gate ranking (#1–#4), thresholds, energy analysis | full derivation | carried forward unchanged in substance — §3 |
| Line citations | pre-limiter line numbers | NaN trip `MainKernel.cu:532`, reset `:306/:327` (post-limiter-edit) |

Substantive engineering content (the four gates, the closed-loop derivation, the cost model, the
CFL-vs-runtime distinction) is unchanged; the superseded doc remains the deeper derivation reference and
is preserved in `docs/proposals/archive/`.
