# Proposal: Courant/CFL Stability Guard in `parameterKernel`

- **Status:** Design proposal — NOT yet implemented. Investigation + design only.
- **Author:** dev-3a08
- **Date:** 2026-05-18
- **Scope:** CUDA (`pianoid_cuda/Kernels.cu`) — a future, separate `/dev` task with a `--heavy` build.
- **Origin:** `length→dx` regression (PianoidCore `a558cb3`). The immediate regression is fixed
  separately (Option A — middleware unit fix). This proposal addresses the *deeper* exposure that
  regression revealed: there is **no stability guard** on the FDTD coefficients, so any parameter
  combination that crosses the explicit scheme's stability bound silently produces a divergent
  (Inf/NaN) string field and engine-wide noise.

---

## 1. Problem

The string solver `addKernel` is an **explicit** finite-difference time-domain (FDTD) scheme. Explicit
schemes are only *conditionally* stable: the per-step update coefficients must satisfy a
von-Neumann / Courant (CFL) bound. If they do not, the displacement field grows without bound each
step → `Inf`/`NaN` within a few milliseconds.

The `length→dx` regression demonstrated the failure mode concretely: a UI `length` edit fed a
wrong-unit value into `dx`, making `dx` ~84-141× too large; `coeff_tension ∝ 1/dx²` and
`coeff_bending ∝ 1/dx⁴` then landed far outside the stable region; the string field diverged, the
divergence migrated through the feedin coupling into the persistent (all-pitch-shared) mode
oscillators, and the whole engine output became noise. The backend ultimately crashed.

That specific unit bug is being fixed in the middleware. But the **general** hazard remains: the
engine has no defence against a parameter set that violates the CFL condition. Many parameters
feed that condition (see §3) and any of them — set via a preset, a granular edit, or auto-tuning —
can push the scheme unstable. A narrow "clamp `dx` to a range" check in one Python code path would
catch only that one path and only that one parameter. The guard belongs where **all** coefficients
are finalised: `parameterKernel`.

---

## 2. The FDTD stability condition for this scheme

### 2.1 The scheme

Per `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` ("Wave Equation: FDTD String Simulation"), each
interior point is advanced by:

```
target = shift_0 · s_a[p]
       + shift_b · s_b
       + shift_1 · (s_a[p-1] + s_a[p+1])      (2nd-order stencil — tension)
       + shift_2 · (s_a[p-2] + s_a[p+2])      (4th-order stencil — bending stiffness)
       + coeff_frequency_decay · (d3 - d3_1)  (HF damping)
       + s_force_function[n] · coeff_force    (hammer force)
```

The `shift_*` coefficients are computed by `parameterKernel` (`Kernels.cu:144-148`) from two
intermediate quantities, `coeff_tension` and `coeff_bending`:

```
coeff_tension = tension / (dxMm2 · coeff_ro · iterPerMs²)            (Kernels.cu:133)
coeff_bending = (π · 250000 · r⁴ · coeff_E) / (coeff_ro · dxMm2² · iterPerMs²)  (Kernels.cu:135)
dec_curr      = coeff_gamma / (iterPerMs·1000) + damper_string·dump_coeff      (Kernels.cu:141)
dec_inv       = 1 / (dec_curr + 1)                                              (Kernels.cu:142)

shift_0 = (2 + 12·coeff_bending − 2·coeff_tension) · dec_inv          (c0,  Kernels.cu:144)
shift_1 = (coeff_tension − 8·coeff_bending) · dec_inv                 (c1,  Kernels.cu:145)
shift_2 = (2·coeff_bending) · dec_inv                                 (c2,  Kernels.cu:146)
shift_b = (dec_curr − 1) · dec_inv                                    (t1,  Kernels.cu:148)
```

where `dxMm2 = (dx·1000)²` (dx in mm, squared) and
`iterPerMs = (sample_rate · string_iteration) / 1000`.

### 2.2 The stability bound

For an explicit stiff-string scheme (tension term + 4th-order bending term), von-Neumann analysis
gives a CFL condition of the form:

```
coeff_tension + 4·coeff_bending ≤ 1            (necessary; the tension+bending CFL limit)
```

Equivalently, since `coeff_tension = (T/ρ)·(dt/dx)²` and the bending term scales as
`(EI/ρ)·dt²/dx⁴`, the classic Courant number `C = c·dt/dx` (with wave speed `c = √(T/ρ)`) plus the
stiffness contribution must keep the amplification factor `|g| ≤ 1` for every spatial frequency.

> **IMPORTANT — this exact coefficient form must be derived/confirmed before implementation.**
> The `coeff_tension + 4·coeff_bending ≤ 1` form above is the standard result for this stencil but
> the precise constant (the `4`, and whether the damping term `dec_curr` relaxes or tightens it)
> depends on this scheme's exact discretisation. Per CLAUDE.md "high-stakes inference", the
> implementing `/dev` task MUST either (a) cite a derivation in
> `SYNTHESIS_ENGINE.md`, or (b) derive it and write it into `SYNTHESIS_ENGINE.md`, **before**
> coding the guard. The bound is the load-bearing fact of this whole proposal.

A practical, conservative form the guard can use without a full per-wavenumber analysis: require
each `shift_*` to stay within the range that keeps the update non-amplifying — in particular
`|shift_0| ≤ 2` is violated hard in the regression case (`coeff_tension ≈ coeff_bending ≈ 0` →
`shift_0 ≈ 2·dec_inv`, and with the spatial-coupling terms near zero the recurrence eigenvalue
approaches 2). The implementing task should pick the tightest *correct* check from the derivation.

---

## 3. Full parameter set feeding the CFL condition

Enumerated from `parameterKernel` (`Kernels.cu:80-171`). The guard must treat ALL of these as
inputs — the regression was `dx`, but any of them can break stability.

### 3.1 Physical (per-string) parameters — `dev_physical_parameters`

| Param | Index | Symbol in kernel | Enters via |
|---|---|---|---|
| `dx` (spatial step) | 7 | `dxMm2 = (dx·1000)²` | `coeff_tension ∝ 1/dxMm2`, `coeff_bending ∝ 1/dxMm2²`, `coeff_frequency_decay ∝ 1/dxMm2` |
| `tension` | 5 | `tension` | `coeff_tension ∝ tension` |
| `density` (`coeff_ro`) | 3 | `coeff_ro` | `coeff_tension ∝ 1/coeff_ro`, `coeff_bending ∝ 1/coeff_ro` |
| `radius` (`r`) | 2 | `r` | `coeff_bending ∝ r⁴` |
| `stiffness` (`coeff_E`) | 4 | `coeff_E` | `coeff_bending ∝ coeff_E` |
| `damping` (`coeff_gamma`) | 6 | `coeff_gamma` | `dec_curr` (damping relaxes the bound) |
| `damper_string` | 13 | `damper_string` | `dec_curr` via `damper_string·dump_coeff` |
| `frequency_damping` | 12 | `frequency_dependent_damping` | `coeff_frequency_decay` |
| `string_length` (point count) | 0 | — | not in coeffs directly, but bounds valid `dx` |
| `tail` (point count) | 1 | — | as above |

### 3.2 Model / cycle parameters — `dev_cycle_params`

| Param | `cycle_parameters[]` index | Symbol | Enters via |
|---|---|---|---|
| `sample_rate` | 7 | — | `iterPerMs = sample_rate·string_iteration/1000` |
| `string_iteration` (sound_step) | 4 | — | `iterPerMs` (so `dt = 1/(sample_rate·string_iteration)`) |
| derived `iterPerMs` | — | `iterPerMs` | `coeff_tension ∝ 1/iterPerMs²`, `coeff_bending ∝ 1/iterPerMs²` |
| derived `dt` | — | `dt_sec` | `coeff_force ∝ dt²` |

### 3.3 Runtime input

| Param | Source | Enters via |
|---|---|---|
| `sustain_value` | `dev_sustain_value` | `dump_coeff` → `dec_curr` (sustain pedal changes damping) |

**Key point for the guard's placement:** every one of these is already resident in GPU buffers that
`parameterKernel` reads, and `parameterKernel` already computes `coeff_tension`, `coeff_bending`,
`dec_curr`, and the `shift_*` set from them — once per affected string, every time a parameter
changes (`new_notes_ind > 0`). That is the single chokepoint where the *finalised* coefficients
exist for every string. A guard there covers preset load, granular edits, bulk edits, auto-tuning,
and MIDI-CC paths uniformly.

---

## 4. Proposed guard design (in `parameterKernel`)

After `parameterKernel` computes `coeff_tension`, `coeff_bending`, `dec_curr` and the `shift_*`
coefficients for a string (i.e. immediately after `Kernels.cu:148`), evaluate the CFL bound:

```
stable = (coeff_tension + 4.0 * coeff_bending) <= CFL_LIMIT     // exact form per the §2.2 derivation
         && isfinite(coeff_tension) && isfinite(coeff_bending)
         && isfinite(shift_0) && isfinite(shift_1) && isfinite(shift_2) && isfinite(shift_b)
```

The `isfinite` checks catch the degenerate cases (a zero/NaN `dx`, `coeff_ro`, or `iterPerMs`) that
produce `Inf`/`NaN` coefficients directly, before they ever reach `addKernel`.

A small per-string stability flag buffer (e.g. `dev_string_stable`, 256 ints) records the result so
the host can read it back after the kernel.

### 4.1 Where exactly

`parameterKernel` runs one thread per spatial point but the coefficient computation is per-string
(`stringNo`); the guard evaluation should be done once per string (e.g. by the first point of each
string, or unconditionally with an `atomicAnd` into the per-string flag — cheap, runs only on
parameter-change cycles, not every audio cycle).

---

## 5. On-violation behaviour — options and recommendation

Three candidate responses when a string's coefficients violate the bound:

| Option | Behaviour | Pros | Cons |
|---|---|---|---|
| **R1 — Reject** | Do not apply the offending coefficients; keep the string's previous stable coefficients. Set the per-string flag; host reads it and reports an error to the middleware → REST 4xx → UI surfaces "parameter rejected: would destabilise string N". | No noise ever; the engine stays alive; the user gets a clear, actionable message. | Needs the kernel to retain the prior coefficient set per string (a shadow copy) so it can fall back. |
| **R2 — Clamp** | Scale the offending coefficient(s) back onto the stability boundary. | Engine stays alive; the edit "mostly" applies. | Silent — the user's value is changed without consent; the resulting sound is not what they asked for. Violates fail-fast/no-silent-fallback (CODE_QUALITY S5). |
| **R3 — Signal only** | Apply the coefficients anyway but raise the per-string flag; host reads it and warns. | Simplest kernel change. | The engine STILL explodes this cycle — the flag is post-hoc; does not prevent the NaN. |

**Recommendation: R1 (Reject + fall back to last stable coefficients) + host-side error signalling.**
Rationale:
- It is the only option that *prevents* the noise rather than reporting it after the fact.
- It is fail-fast and non-silent (CODE_QUALITY P5/S5): the bad parameter is refused and the user is
  told, rather than the value being silently mangled (R2) or the engine being allowed to blow up
  (R3).
- The fallback cost is one extra per-string coefficient buffer (`shift_*` × 256 strings — small).
- The host-side half (read the flag buffer after `parameterKernel`, translate to a REST error)
  pairs naturally with the existing granular-update return path (`updateMultiStringParameter_NEW`
  already returns a `bool`).

A reasonable phased implementation: **Phase 1** = the `isfinite` guard + R1 reject for the
NaN/Inf-coefficient case (catches the catastrophic class, including the `length→dx` family);
**Phase 2** = the full `coeff_tension + 4·coeff_bending ≤ CFL_LIMIT` bound once the exact constant
is derived and documented.

---

## 6. Why this is a separate future task (not part of the `length→dx` fix)

- It is a **CUDA change** (`Kernels.cu`) → requires a `--heavy` build, and touches the hot
  synthesis path → needs performance verification (the guard runs only on parameter-change cycles,
  so the expected cost is negligible, but it must be measured).
- It needs the **exact CFL constant derived and written into `SYNTHESIS_ENGINE.md`** first
  (§2.2) — a high-stakes-inference item that must not be guessed.
- It needs a **host-side counterpart** (read the per-string stability flag, surface a REST error)
  and a **UI counterpart** (display "parameter rejected" instead of silent failure).
- The immediate `length→dx` regression is fully resolved by the middleware unit fix (Option A);
  this guard is defence-in-depth for the *whole class* of CFL-violating parameter sets, which is a
  larger, independently-scoped piece of work.

**Recommended follow-up:** a dedicated `/dev` task — "FDTD CFL stability guard in parameterKernel"
— covering (1) derive + document the exact bound, (2) implement the kernel guard with R1 reject,
(3) host-side flag read-back + REST error, (4) `--heavy` build + performance regression check,
(5) a test that asserts a known-unstable parameter set is rejected (not exploded).

---

## Investigation history

- Diagnostic + live reproduction of the `length→dx` regression: `dev-3a08` session log
  `docs/development/logs/archive/dev-3a08-2026-05-17-220851.md` (rounds 1-7) and the diagnostic
  scripts under `docs/development/diagnostics/dev-3a08-*`.
- FDTD scheme + coefficient reference: `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md`
  ("Wave Equation: FDTD String Simulation", "Coefficient scaling table").
