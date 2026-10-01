# Excitation Loudness / Impulse Normalization — Corrected Model

**Status:** ANALYSIS + RECOMMENDATION (measured against the INSTALLED engine, 2026-06-30). No code changed.
**Author:** dev-excitanalysis · **Scope:** the gauss/excitation → loudness chain and the frontend curve-energy renormalizer.
**Corrects:** the PART-1 "curve-energy (impulse) normalization (frontend)" half of
[`excitation-physical-energy-2026-06-16.md`](excitation-physical-energy-2026-06-16.md). PART 2 (physics
mass·speed, the per-(pitch,level) coefficient, D9) is implemented and stands; this doc does **not** revise it.

> **One-line finding.** The frontend curve-energy renormalizer (`excitationImpulse.js` →
> `renormalizeBatchChanges` / `pasteRenormalizeBatchChanges`, wired in `PianoidTuner.js
> handleGaussValueChange`) is built on a **wrong assumption** — "conserving the curve's impulse conserves
> its loudness." Measured against the installed engine it is **inert** (the volumes it rescales divide
> straight back out) *and* it could never have fixed the reported "loudness changes on a shape edit",
> because that change is the **curve-shape / peak-concentration** term, which no volume rescale can touch.

---

## 1. The conserved-quantity confusion (the wrong assumption, pinned)

Two different quantities were conflated:

| Quantity | Definition | What conserves it | What the ear hears |
|---|---|---|---|
| **Impulse** (momentum) | `∫F dt` = area under the force curve = `Σ_k f(t_k)` | the **engine** (conserve mode, §2) — already shape-independent | **not** directly audible |
| **Loudness** | rendered **peak / RMS** of the synthesized note | depends on impulse **AND curve shape** (peak/integral) + modal resonance | this is what "too loud / too quiet" means |

The FE renormalizer conserves **impulse** (the curve point-sum `I = Σ_k f(t_k)`, linear in the gauss
volumes) and assumes that equals conserving **loudness**. It does not. Loudness ∝ the force **peak**, and
two curves with the *same* impulse but different shape (a narrow spike vs a broad bump) deliver the same
momentum but **different peaks** → different loudness. So:

> **WRONG ASSUMPTION (verbatim premise, `PianoidTuner.js:3589-3595` + `excitationImpulse.js:18-22`):**
> *"NO gauss-curve edit EVER changes total volume … restoring impulse is a single LINEAR rescale
> `s = impulse_prev / impulse_new`."* — This is false twice over in the installed engine: (1) loudness ≠
> impulse (it is the shape-dependent peak), and (2) in the installed **conserve** engine the gauss
> volumes have **no effect on output at all** (§2), so the rescale `s` is a no-op on the sound.

---

## 2. The installed gauss → loudness chain (math at each stage, conserve engine)

The installed engine runs `COEFFICIENT_IMPULSE_MODE = 'conserve'` (`constants.py:109`), the per-note REAL
coefficient is live (`gaussTest.cu:54,95`; pyd exports `setNewExcitationCoefficients`), and
`StringMap.pack_excitation_coefficients` composes it via `compose_excitation_coefficient`.

```
FE gauss params (mu,sigma,volume,shift) ×5            [PianoidTunner]
  └─ handleGaussValueChange → (FE renorm rescales the 5 volumes) → changeParametersOfExcitationBatch
        POST /set_parameter/gauss/<pitch>
              ▼                                         [pianoid_middleware / PianoidBasic]
  levels_matrix[level, param, curve]   (param 0=mu 1=sigma 2=volume 3=shift)
  temporal_impulse  I = temporal_curve_impulse(level)        # StringExcitation.py:28
        f(x_k) = Σ_i max(exp(-0.5((x_k-mu_i)/sigma_i)^2) - shift_i, 0) · vol_i   # per-component ReLU
        I      = Σ_k f(x_k)
  coefficient = c · m(pitch) · v(level) · spatial / I        # compose_excitation_coefficient, CONSERVE
              ▼                                         [pianoid_cuda]
  kernel force[n] = s2exp · coefficient · g_vol[i]  summed   # gaussTest.cu:95 ; g_vol = the curve volumes
                 = (c·m·v·spatial / I) · f(t)
                 = c·m·v·spatial · ( f(t) / I )              # = physical scale × UNIT-INTEGRAL shape
```

Two exact consequences fall straight out of `force = c·m·v·spatial · (f/I)`:

- **Delivered impulse** `= ∫force = c·m·v·spatial · (I/I) = c·m·v·spatial`. **Shape-independent and
  volume-scale-independent** — the curve integral divides out. This is the engine author's intended design
  and the user's "loudness = mass·speed only" principle, realized at the impulse level.
- **Rendered peak** `∝ c·m·v·spatial · peak(f)/I`. The factor `peak(f)/I` is the curve's
  **peak-to-integral ratio = shape concentration**. It is *invariant to scaling all volumes* (numerator and
  `I` both scale by `s`), but it **moves when the shape (sigma/mu/shift/relative mix) changes**.

**Therefore, in the installed engine:**
1. Scaling the gauss volumes (what the FE renorm does) changes **nothing** in the output — `f/I` is invariant.
2. A **shape** edit changes `peak(f)/I` → changes the rendered peak → **changes loudness**, and no volume
   rescale can correct it (volume is divided out).

---

## 3. Measured evidence

Pure-Python measurement against the **installed** `StringExcitation` (no GPU, no backend, live pid
untouched). Force PEAK = `coefficient · peak(curve)` (loudness proxy); DELIVERED = `coefficient · I`.
Harness: `scratchpad/measure_excit.py` (this session).

**T1 — scaling all gauss volumes, installed CONSERVE engine:**

| edit | curve impulse I | coefficient | force_peak | delivered |
|---|---|---|---|---|
| vol ×1.0 | 1824.97 | 5.48e-4 | **5.833e-3** | **1.000** |
| vol ×2.0 | 3649.93 | 2.74e-4 | **5.833e-3** | **1.000** |
| vol ×0.5 | 912.48 | 1.10e-3 | **5.833e-3** | **1.000** |

→ force_peak and delivered are **invariant** to volume scale. **The FE volume renorm has zero audio effect.**

**T2 — same scaling under legacy MULTIPLY mode (the double-count; NOT installed):**

| edit | force_peak | ratio vs ×1 |
|---|---|---|
| vol ×1.0 | 1.943e4 | 1.000 |
| vol ×2.0 | 7.771e4 | **4.000** |
| vol ×0.5 | 4.857e3 | **0.250** |

→ ratio = s² — this is the brief's "rendered loudness ∝ volume²" double-count. It is the **legacy** state;
the installed engine already removed it (conserve, T1). Reproduced here only to confirm the prior diagnosis.

**T3 — a SHAPE edit (widen sigma) WITH the FE linear renorm applied, installed CONSERVE engine:**

| shape edit | FE renorm s | curve impulse | Δ force_peak (loudness) | Δ delivered (impulse) |
|---|---|---|---|---|
| sigma ×1.3 | 0.769 | held = I_prev | **−1.81 dB** | +0.00 dB |
| sigma ×1.6 | 0.626 | held = I_prev | **−3.14 dB** | +0.00 dB |
| sigma ×2.0 | 0.507 | held = I_prev | **−4.46 dB** | +0.00 dB |
| sigma ×0.7 | 1.429 | held = I_prev | **+2.43 dB** | +0.00 dB |

→ The FE renorm holds the impulse **exactly** (its stated goal), yet the rendered loudness still moves
**±2–4 dB**; the delivered impulse stays perfectly flat. The FE renorm conserves the wrong quantity, and
its lever (volume) is divided out — it cannot touch the shape/peak term.

**Cross-check (prior GPU ground-truth, dev-volpitch 2026-06-26, `dev_force_function` buffer):** in conserve
mode the *delivered impulse* flattens 36.4× → **1.08×** across the keyboard (the smooth mass taper), while
*rendered loudness* keeps a **±7 dB** note-to-note ripple — exactly the shape/peak + modal-resonance residual
that T3 isolates. The pure-Python proxy and the GPU render agree.

---

## 4. Solutions evaluated

The brief framed three options against the *double-count* engine. Re-framed against the **installed
conserve** engine:

| Option | What it is | Verdict |
|---|---|---|
| **(a) Engine conservation fix** | divide the coefficient by the curve integral so delivered impulse = c·m·v·spatial | **Already installed + correct.** Remaining work is to **merge** the feature branches to mainline + ship the analytic `output_scale` re-derive + a one-time offline preset migration. This is the principled fix for the double-count (the real volume² bug). |
| **(b) Correct the FE renorm's exponent** | rescale volumes by the "right power" so rendered loudness conserves | **Moot / reject.** In the conserve engine volume has **no** loudness effect (T1) — there is no exponent that works, because the lever is divided out. The residual is the shape/peak term, which is not a power of volume at all. |
| **(c) Remove the FE auto-renorm** | drop `renormalizeBatchChanges` / `pasteRenormalizeBatchChanges` from the edit/paste handlers | **Recommended.** It is inert for audio, redundant with the engine's conserve division, mutates stored volume rows, and visibly rescales the chart on a shape edit (the curve "jumps" while the sound does not) — confusing and wrong. |

**RECOMMENDATION = (a) + (c): keep/merge the engine conserve fix, and remove the FE renorm.**

Reasoning: the engine conserve division already *is* the user's "loudness = mass·speed only" principle,
applied in the correct place (the coefficient) on the correct quantity (delivered impulse) for **every**
preset automatically. The FE renorm is a second, redundant attempt at the same goal, in the wrong layer, on
a quantity the engine then divides out — so it does nothing but churn stored data and confuse the display.
Removing it is pure-frontend and low-risk; keeping the engine fix is the principled physics.

**The residual ±7 dB (shape → loudness) is a separate decision, not a bug.** A sharper hammer pulse delivers
the same momentum but a louder transient — real-piano-like. Two paths:
- **Accept it** (recommended default): impulse-conservation is the correct physics; note-to-note shape
  variation is musical, not an error.
- **Dead-flat (optional, render-gated):** layer a per-pitch **render-based loudness trim** — measure the
  rendered peak and apply a gain through the *coefficient* (not the curve) — i.e. automate the dev-volpitch
  task-14 method. This conserves **loudness** (the right quantity for "flat keyboard"), needs a clean-GPU
  offline render, and is a separate follow-up. It is **not** a curve-integral renorm.

---

## 5. Recommended implementation plan (for user go — not yet executed)

| # | Change | Repo / file | Build | Risk |
|---|---|---|---|---|
| 1 | Remove the renorm wiring from `handleGaussValueChange` (gauss edits) and the two paste handlers; keep the **read-only** `totalImpulse` / `curveImpulse` / `hammerSpatialImpulse` readouts. Prune the renorm-specific Jest cases; keep the impulse-math tests. | PianoidTunner `src/PianoidTuner.js` (~3587-3643, 3684, 3719), `src/utils/excitationImpulse.js` (trim renorm exports), `__tests__/excitationImpulse.test.js` | npm only | Low (pure FE; no audio behavior change since renorm is inert) |
| 2 | Merge the conserve fix to mainline so the install is reproducible from `dev`/`master`: `compose_excitation_coefficient` divide + `output_scale` mode-tag + the **analytic** `output_scale` re-derive (no live-backend render). | PianoidBasic `feature/dev-volpitch-impulse-conserve` (713c126, ea547b1); PianoidCore `feature/dev-volpitch-impulse-conserve` (1cb52fb) | wheel + LIGHT | Medium — must ship the offline preset `output_scale` migration too (cached multiply-era scale ≈ ti²≈30× off → wrong absolute level). Never re-derive via an offline render inside the live backend (page-faults). |
| 3 | (Optional, deferred) per-pitch render-based loudness trim through the coefficient for dead-flat keyboard. | PianoidCore offline harness + StringMap coefficient | offline render | User-gated (box GPU constraint) |

**Verification surface:** synthesis-output → `note_playback` offline render (`audio_off`), measured
before/after. FE removal is verifiable by Jest + the fact that audio is provably unchanged (renorm inert,
§3 T1). The conserve merge's audio parity is **user-gated** by this box's cooperative-grid GPU constraint
(consistent with the parent proposal's verification stance) — ship a ready-to-run render-assertion script.

---

## 6. Gauss-handling reference (the documented model)

- A curve at one velocity level = `NUM_GAUSS = 5` Gaussians, each `(mu, sigma, volume, shift)`:
  `mu` = horizontal center (timing, ms); `sigma` = horizontal width; `volume` = peak amplitude;
  `shift` = **vertical** offset (`y = exp(...) − shift` per component, then ReLU clips < 0) — so `shift`
  trims tails / raises the ReLU floor and is **shape-affecting**.
- The engine integrates the curve with **per-component ReLU before the ×volume and the sum**
  (`max(exp − shift, 0) · vol`), not the per-curve post-sum clip. Any impulse computed for comparison must
  use the same order (the FE `curveImpulse` does — that part is correct).
- **Loudness is set by `c · m(pitch) · v(level)` (mass × speed), divided into the curve as a per-note
  coefficient; the gauss curve carries SHAPE only — its integral divides out (conserve mode).**
- A gauss **volume** edit (scaling amplitudes) is therefore **loudness-neutral by construction** in the
  engine — no FE renorm needed to make it so.
- A gauss **shape** edit (sigma/mu/shift/relative mix) changes the curve's **peak-to-integral ratio**, which
  changes the rendered **peak** → a real, intrinsic loudness change (same momentum, different transient).
  This is not corrected by any volume rescale; it is corrected, if desired, only by a render-based loudness
  trim applied through the coefficient.
