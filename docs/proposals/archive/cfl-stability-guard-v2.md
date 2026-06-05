# Proposal: Courant/CFL Stability Guard — v2 (Simple, Robust Rewrite)

- **Status:** IMPLEMENTED + MERGED — PianoidCore `cfl_stability.py` + `stability_ratio` in tree; v2 re-architecture merged to `dev` via `ce2818b`. Supersedes the v1 design (already in `archive/courant-stability-guard.md`). Archived 2026-06-05.
- **Author:** rev-0a12 (independent reviewer/architect); implemented by dev-cfl-v2.
- **Date:** 2026-05-26
- **Implementation notes (as shipped, 24297c7):** gate moved host-side (option A — prospective
  compute-and-gate before mutate/upload), per-string `tension_offset` honoured, K=24 host θ-grid for
  the decision (blessed: measured 0/0 false-accept/false-reject vs dense truth incl. HF damping),
  reject → REST 400 + `cfl_redline`. Pitch-57 click GONE (sustains; it was the live route path, not
  the synth). 27/27 tests pass. Two route-level bugs found+fixed in live-verify (predicted class —
  surface-level wiring, not the gate math): a `jsonify` 500 and a `CflRejected` status mapped 416→400.
- **Supersedes:** `docs/proposals/courant-stability-guard.md` (dev-3a08, 2026-05-18 — used the
  mathematically-wrong `T + 4·B` bound) and the v1 implementation (dev-cfl, 2026-05-24:
  θ-sweep + companion-matrix + per-point shadow fallback + per-string flag + host flag-polling).
- **Evidence base:** independent re-derivation + empirical crash-limit study, this session.
  Diagnostics: `docs/development/diagnostics/dev-cfl-rev0a12-*.py`. Math reference (correct bound):
  `docs/modules/pianoid-cuda/SYNTHESIS_ENGINE.md` "FDTD Stability (CFL / Courant) Bound".

---

## 0. TL;DR

The current guard works (it catches the blowups and prevents NaN), but it is **over-built** and the
machinery is the source of all three bugs (synthesis halt, k=0 false-reject, the pitch-57 click is
adjacent to it). Three measured facts collapse the design to something far simpler:

1. **The stability criterion is closed-form.** A Jury/Schur test on the final FDTD coefficients
   (equivalently, the two-sided box `8·B ≤ T ≤ 1 + 8·B` on `coeff_tension`/`coeff_bending`, with an
   HF-damping correction) reproduces the *exact* swept amplification factor `max_θ|g(θ)|` with **zero
   mismatches**, including damping. **The 48-point θ-sweep and the companion-matrix cross-check are
   unnecessary.**
2. **The gate can live entirely host-side.** The host (Python `parameter_manager`) computes the
   identical number from PianoidBasic physics — verified to match the GPU's reported ratio to `3e-6`.
   So the edit can be **rejected before the GPU upload**, which removes the per-point shadow buffer,
   the per-string flag, the kernel gate, *and the host/engine flag-polling race that caused the
   synthesis halt*.
3. **The empirical blowup border == the gate border**, to bisection precision, in every parameter
   direction (tension, dx, string_iteration, radius, density), with damping. No false-reject, no miss.

**Recommendation:** move the gate to the host, make it a single closed-form check computed *before*
upload, reject (don't apply) on violation with a clear REST error, expose the ratio on request for the
chart. Keep `isfinite` defence. Remove the kernel gate, the shadow buffer, the flag buffer, and the
flag-polling logic. Scope: **Courant blowup only** — modes and the collapse/click mode are explicitly
out.

---

## 1. Scope (unambiguous)

**IN scope — the Courant/CFL instability (BLOWUP):** an explicit-FDTD parameter set whose
amplification factor `max_θ|g(θ)| > 1`, i.e. the displacement field grows geometrically → `Inf`/`NaN`.
The gate is checked **after any parameter change** that feeds the string coefficients (preset load,
granular string-physics edit, bulk edit, auto-tune, MIDI-CC that changes damping). It applies to
**physical FDTD strings only.**

**OUT of scope (stated explicitly so the contract is unambiguous):**

- **Modes.** The soundboard modes are a separate entity class (`dev_mode_state`: dec/omega/mass_inv;
  modal synthesis, not the FDTD wave equation). They do not use the `shift_*` coefficients and are not
  governed by this criterion. (Mode stability, if ever needed, is a different analysis.)
- **Sound / output strings** (pitch ≥ 128, `outer_sound > 0`). These are soundboard proxies whose
  displacement is the summed mode feedback, not the wave recurrence; their placeholder physics
  (`tension = r = 0`) makes `max|g|` meaningless. They are skipped.
- **The COLLAPSE / click / no-sustain mode.** This is a *different* failure: energy decays to ~zero
  (over-damping, or the `length→dx` degenerate drift where `coeff_tension, coeff_bending → 0` and the
  recurrence sits on a defective double root at `|g| = 1` producing slow polynomial drift). **It is
  NOT a Courant blowup and the gate does NOT (and must not) flag it** — flagging it would reject normal
  lossless strings (a healthy preset also sits at `|g| = 1`). The historical `length→dx` regression
  (#143/#144) belongs here; it is handled by unit validation + the `isfinite` defence, not by this
  gate. See §3 and the empirical study (§5).
- **The pitch-57 LIVE click.** Measured to be NOT a synthesis/guard defect (the in-proc render
  sustains pitch 57, flag = 0). It lives in the live REST/WS trigger, the param-apply threading, or the
  streaming path. Tracked separately (§6.3); the v2 design removes the threading hazard that is the
  most likely culprit.

---

## 2. The mathematics (independently re-derived + measurement-confirmed)

### 2.1 Scheme and amplification factor

The interior-point update (`MainKernel.cu:503–541`), homogeneous (forcing dropped for linear
stability), with `B = coeff_bending`, `T = coeff_tension`, `dec_curr` velocity damping,
`cfd = coeff_frequency_decay` (HF damping), `dec_inv = 1/(1+dec_curr)`:

```
shift_0 = (2 + 12B − 2T)·dec_inv     shift_1 = (T − 8B)·dec_inv
shift_2 = (2B)·dec_inv                shift_b = (dec_curr − 1)·dec_inv
```

Fourier mode `u^n_p = g^n e^{iθp}`, `θ = k·dx ∈ [0, π]`:

```
g² − A(θ)·g − B0(θ) = 0
A(θ)  = shift_0 + 2·shift_1·cosθ + 2·shift_2·cos2θ − 2·cfd·(1 − cosθ)
B0(θ) = shift_b + 2·cfd·(1 − cosθ)
```

Stable iff both roots satisfy `|g| ≤ 1` for every θ. For the quadratic `g² + a₁g + a₀` with
`a₁ = −A`, `a₀ = −B0`, the **Jury/Schur closed-disk condition** is:

```
(i)   |B0(θ)| ≤ 1          for all θ
(ii)  |A(θ)| ≤ 1 − B0(θ)   for all θ
```

### 2.2 Closed-form bound (the gate)

Evaluating the binding modes gives the **two-sided box** (undamped, exact to 6 digits for
`B ∈ [0, 0.05]` — the entire physical range):

```
8·coeff_bending  ≤  coeff_tension  ≤  1 + 8·coeff_bending
```

- **Upper edge (the CFL limit):** `coeff_tension − 8·coeff_bending ≤ 1`.
- **Lower edge:** `coeff_tension ≥ 8·coeff_bending` (tension must dominate bending at the grid scale).

**Damping (measured):** velocity damping `dec_curr` does **not** move the edges (`A` and `B0` both
scale by `dec_inv`). HF damping `cfd` **tightens** the upper edge (e.g. `cfd = 0.1` drops the upper
edge from `1+8B` to `≈ 0.80 + 8B`). So the undamped box is the *loosest*; ignoring HF damping is
*conservative* but **can false-reject when HF damping is large** — so the gate should include the HF
term for exactness (it is cheap; see §4).

### 2.3 Two corrections to `SYNTHESIS_ENGINE.md`

The doc's bound and ratio are **correct**. Two statements in it are imprecise and should be fixed:

1. **"The binding wavenumber is the Nyquist mode θ = π."** Imprecise. Measured: as `T → 1⁻`
   (approaching the upper CFL edge *from below*), the growth onset binds at **θ → 0⁺** (long
   wavelength near DC), *not* π. Nyquist θ = π binds the **lower** edge (`T < 8B` self-amplifies at π)
   and the overshoot once already unstable. The doc conflates the two. (This is exactly why the v1
   implementer observed "instabilities bind at interior θ, not only Nyquist" and built a sweep — but
   the closed-form Jury check captures both edges without sweeping.)
2. **The `(coeff_tension − 8·coeff_bending) / CFL_LIMIT` ratio is a fine *display* number but is NOT a
   sufficient *reject* criterion** — it only encodes the **upper** edge. It **misses** a real
   bending/lower-edge blowup (measured: `B = 2.77e-3, T = 0.018` blows up with `max|g| = 1.14`, but
   `(T − 8B) = −0.004 ≤ 1`). A correct gate must test **both** edges (the box) or, equivalently, the
   Jury condition.

### 2.4 The k = 0 (DC) exclusion — resolved (it is justified, not a hack)

At θ = 0 the spatial operators vanish and, *symbolically for all T, B*:

```
A(0) = (2 + 12B − 2T) + 2(T − 8B) + 2(2B) = 2     (the T and B terms cancel identically)
B0(0) = shift_b = −1   (undamped)
⇒ g² − 2g + 1 = 0 ⇒ g = 1  DOUBLE root.
```

This is a **defective (non-diagonalisable) marginal mode** = rigid-body translation. A fixed-fixed
string (both ends pinned — the bridge/stem boundary) **cannot express it**; it is boundary-controlled,
not a free mode. The discriminant `disc = A² + 4·B0 = 0` *exactly* at θ = 0, so in float arithmetic it
flips slightly positive and the real-root branch returns `(A + √disc)/2` a hair above 1 — the
**spurious** `|g(0)| = 1.00042` the v1 implementer saw. **Excluding θ = 0 is mathematically correct;
it is NOT masking a DC damping-discretisation error.** (The v1 code's instinct was right; the
*reason* is "exactly-known defective double root pinned by the boundary," which is worth stating
precisely.) The v2 closed-form gate avoids the issue entirely: it does not evaluate a free-running
recurrence at θ = 0 — it tests the box on (T, B), which has the DC mode designed out.

### 2.5 eps — float-precision guard, not a tunable margin

The criterion is exact: a physical string that sounds without diverging has `|g| ≤ 1` (lossless → = 1,
damped → < 1). `CFL_STABILITY_EPS = 1e-6` only absorbs ~`1e-7` float round-off on the `= 1` knife-edge.
It is **not** a safety margin and must not be widened to clear a false-reject (the historical 1e-3
push was correctly reverted). With the DC mode designed out (§2.4), the dominant source of spurious
overshoot is gone, so the eps is purely numerical hygiene. **Do not tune it.** A string computing
`|g| > 1 + eps` indicates a *formula* error, not a too-tight gate.

---

## 3. The two failure modes (must stay distinct)

| | BLOWUP (Courant) | COLLAPSE / drift |
|---|---|---|
| Signature | `\|field\|` grows geometrically → Inf/NaN | energy → ~0, or slow polynomial "noise that grows and persists" |
| Cause | `max_θ\|g(θ)\| > 1` (T,B outside the box) | over-damping; OR `coeff_tension, coeff_bending → 0` (huge dx / tiny dt) → defective double root at `\|g\|=1` |
| Example | radius↑, tension↑↑, dx↓↓, string_iter↓↓, rho↓↓ | `length→dx` unit regression (#143/#144); pathological damping |
| Caught by | **this gate** (the box / Jury) | `isfinite` (when dx/rho/iterPerMs hit 0/Inf/NaN) + the lower edge; unit validation upstream. **NOT the upper CFL test.** |
| Empirically | gate flags exactly at the NaN border (§5) | gate correctly reports `max\|g\|=1`, does NOT flag (§5) |

This distinction is the spine of the design. The v2 gate targets **only** the left column. The
`isfinite` checks (already present) catch the degenerate right-column corner where coefficients become
non-finite. Everything else in the right column is a **separate task** (unit validation / a
collapse-detector), explicitly not built here.

---

## 4. Proposed design (host-side, closed-form, pre-upload reject)

### 4.1 Where: `parameter_manager.py`, **prospective** check before mutate + upload (DESIGN-RESOLVED)

The single chokepoint where the *finalised* coefficients are known for an edit is — on the **host** —
the string-edit path. **Decision (design authority, 2026-05-26): option (A) — prospective
compute-and-gate, computed from `(current physics ⊕ pending param dict)` BEFORE `set_param` mutates the
Python model and before the GPU upload.** Rejected option (B) (mutate → check → revert): it
reintroduces revert-fidelity fragility on a model with special-cased state (`geometry.set_length`,
`tension_offset`, the `FRONTEND_TO_PYTHON_PARAM_MAP` rename layer, hammer extraction) — a botched
revert leaves `pitch.physics` silently wrong. (A) makes "never applied" literally true at both the
Python-model and GPU levels with zero revert.

**Avoid duplicating the derivation.** `Pitch.get_coefficients()` (Pitch.py:294) reads only ~7 scalars:
`dx = physics.geometry.dx()`, `dt` (from `mp`), and `tension / r / rho / jung / gamma / disp_decay`.
So the prospective compute overrides those scalars with the pending param dict and feeds them into the
closed-form check — **no** re-implementation of `set_param`'s logic. The one derived quantity is
`dx` for a `length` edit: `StringGeometry.dx()` = `length / p_main()` (with a `0.001` fallback when
`tail ≤ 0`) — `StringState.py:48`. Cleanest implementation: **clone just the lightweight
`StringGeometry`** (no deck/excitation/hammer arrays), `set_length` on the clone, read `dx()` — this
reuses the real formula incl. the fallback branch. Do **not** deep-copy the whole `Pitch` (heavy for
the bulk path).

**CORRECTNESS — per-string `tension_offset` (must-hold; not in v1's host logic).** `tension_offset`
makes each string of a pitch receive `tension·(1 + i·tension_offset)` at the GPU (parameter_manager.py
≈ L378; `Pitch.pack(offset=…)`), while `get_coefficients()` uses the **nominal** `physics.tension`. So
a pitch's strings have **different** `coeff_tension`; with `tension_offset > 0` the highest-index
string is closest to the upper CFL edge. The gate MUST evaluate the **per-string offset-adjusted
tension** and reject if the **worst** string of the pitch violates — a host gate computing from nominal
tension alone would pass a pitch whose top string blows up. (The v1 *kernel* gate got this for free by
running per-string on the already-offset-packed `physical_parameters`; the host gate must reproduce it
explicitly: `T_i = T_nominal·(1 + i·tension_offset)`, `i ∈ range(num_strings_of_pitch)`, only tension
varies across `i`; report the worst string's ratio so the per-string `stability_ratio` contract stays
meaningful.) The §3/§5.3 cross-check (host vs kernel) MUST include a pitch with nonzero
`tension_offset`.

Compute the bound there (pseudocode below shows the single-string core; wrap it in the per-string
`tension_offset` loop + the prospective-scalar override described above).

```
# pseudocode, host-side, in parameter_manager
def _cfl_amp(T, B, dec_curr, cfd):           # closed form; the SAME number the kernel used to sweep
    # exact via Jury on the binding modes, OR a small fixed θ-set; both reproduce max|g| exactly.
    ...
    return max_amp                            # <= 1 stable

# in the string-edit path, for each edited pitch's string:
T, B, dec_curr, cfd = coeffs_from_physics(pitch)   # PianoidBasic Pitch physics + dx + dt
amp = _cfl_amp(T, B, dec_curr, cfd)
if not isfinite(T) or not isfinite(B) or amp > 1 + CFL_STABILITY_EPS:
    raise CflRejected(pitch, string, amp)          # -> REST 400 BEFORE any GPU upload
# else: proceed to upload as today.
```

**Why host-side is correct and robust:**

- **Measured equivalence.** Host closed-form `max|g|` == kernel device ratio to `3e-6` for every
  physical string of a real preset (`dev-cfl-rev0a12-host-vs-kernel.py`). The host has all the inputs
  (`Pitch.physics`, `dx`, `dt`).
- **Bulk-path performance (user's reservation — addressed).** Preset load and "whole-matrix" edits
  check **all ~220 strings at once**. The check MUST be **vectorised over strings** (one numpy array
  op across the 220 rows: compute `coeff_T`, `coeff_B`, `dec_curr`, `cfd` as arrays, then the box test
  as array comparisons), NOT a per-string Python loop. This is the decisive reason to prefer the
  **closed-form box (option A)** over the Jury-θ-sweep (option B) for the *decision*: option A is a
  per-string **scalar** formula with no inner θ loop, so it vectorises to a handful of array ops over
  220 elements — sub-millisecond, negligible against the preset-load GPU upload it precedes. (Option B's
  small θ-set also vectorises, but adds an inner axis for no decision benefit in the physical regime.)
  The implementing task must **measure** the bulk-path added latency (preset load + all-220-string
  edit) and record it; the user's reservation is that this stay negligible. A per-string Python loop
  with a per-θ inner loop would be the wrong implementation and is explicitly ruled out.
  **Measured (`dev-cfl-rev0a12-bulk-latency.py`, gate arithmetic for all 224 strings, mean of 200):**
  vectorised box (A) = **29.5 µs**; vectorised Jury (B) = 70.9 µs; naive per-string×48-θ Python loop =
  **45 820 µs (~1550× slower)**. The 29.5 µs is negligible against the ms-scale preset-load GPU upload
  it precedes. (This benchmarks only the gate arithmetic; the per-string `coeffs_from_physics`
  derivation must also be vectorised — array ops over the 224 rows — and the implementer measures the
  real end-to-end bulk-path delta to close the user's reservation.)
- **Rejecting before upload removes the race.** The unstable coefficients never reach the GPU, so
  there is **nothing to fall back from** (no shadow buffer) and **no flag to poll** (no host/engine
  flag-polling, no 250 ms deadline, no "best-effort 400"). The synthesis-halt bug (§6.1) is *designed
  out*, not patched.
- **Fail-fast / non-silent** (CODE_QUALITY P5/S5): the bad edit is refused with a clear message; the
  prior good state is simply *retained* because it was never overwritten.
- **No `--heavy` build, no hot-path cost.** It runs in the REST/param thread, once per edited string,
  on edit only.

### 4.2 The closed-form check

Two equivalent implementations; pick the simpler to read:

- **(A) Two-sided box + HF correction.** Compute `T, B, cfd`. Test
  `8B ≤ T` (lower) and the HF-tightened upper edge. The upper edge with HF damping is
  `A(π) ≤ 1 − B0(π)` evaluated in closed form (Nyquist binds the box's upper edge in the
  physical regime). Cheap, fully closed-form, no loop.
- **(B) Jury over a tiny fixed θ-set.** Evaluate conditions (i)+(ii) of §2.1 at a handful of θ
  (the endpoints + a few interior points) — measured to match exact `max|g|` with zero mismatches.
  More obviously "general" but slightly more code than (A).

**Recommendation: (A)** for the gate's *decision* (one comparison, no loop, provably equivalent in the
physical regime), and report `max|g|` (computed by the same closed form) as the *ratio* for the chart.
Keep `CFL_LIMIT = 1`. Document the exact closed-form upper edge (incl. the HF term) in
`SYNTHESIS_ENGINE.md` alongside the existing derivation.

> Note on the lower edge in practice: real presets store Young's modulus **negative** → `B ≤ 0`, so the
> lower edge `T ≥ 8B` is satisfied with margin and only the upper edge binds. But a positive-E preset
> with a large radius *can* hit the lower edge (measured), so the gate must keep both — it is one extra
> comparison.

### 4.3 On-violation behaviour: REJECT (R1), surfaced to middleware → UI

When the gate rejects, **do not apply the edit** (the engine keeps its last good coefficients because
they were never overwritten). Surface it:

- **Middleware:** raise `CflRejected` → REST **400** with a structured body:
  `{ "error": "cfl_unstable", "pitch": p, "string": s, "amplification": amp, "limit": 1.0,
     "message": "would destabilise the FDTD solver (Courant). Edit not applied." }`.
- **Redline flag to the middleware:** the same path sets/returns a per-edit "redline crossed" boolean
  so the UI can react without parsing the message string.

### 4.4 Ratio on request (for the chart)

Expose the per-string amplification ratio (`max|g|`, ≤ 1 stable) on demand:

- Keep the existing `GET /get_parameter/stability_ratio/<key>` and `/all` REST surface (the
  `dev-ratiochart` companion already consumes it). Back it with the **host closed-form** computation
  over the current `StringMap` physics (no GPU round-trip needed), returning per-pitch
  `{ ratio, stable, limit }` + `_meta { cfl_limit: 1.0 }`. This keeps the chart contract identical
  while dropping the device flag/ratio buffers.

### 4.5 UI / middleware behaviour when flagged (per user directive)

On a 400 `cfl_unstable`, the UI must **warn the user** and offer two actions:

1. **Revert the last change to the safe zone** — restore the parameter to its pre-edit value (the
   backend already holds it; the edit was never applied, so "revert" is just resetting the UI field to
   the value the backend still has). One click.
2. **Restart with different parameters** — i.e. keep the field editable so the user can choose a value
   inside the stable region; optionally show the safe range (`coeff_tension ≤ 1 + 8B` translated back
   to the physical parameter's units, e.g. "max tension ≈ X N at current dx/iteration").

No silent clamping (that would violate fail-fast / no-silent-fallback and give the user a sound they
did not ask for). The choice is always the user's: revert, or re-enter a stable value.

---

## 5. Testing strategy — the empirical crash-limit method as standing validation

This is the user's testing strategy and the objective ground truth. It is reproduced as a permanent
test so the gate is validated against *measured* blowup, not an assertion.

### 5.1 The method

A faithful forward simulation of the actual interior-point recurrence (pure numpy, fixed-fixed
boundaries) is run with a localised pluck for ~20 000 steps; a parameter is swept toward instability;
**BLOWUP** is detected when the late-window energy grows geometrically (or overflows to Inf/NaN),
**COLLAPSE** when it decays to ~0, else **STABLE**. This is guard-independent (it is the *scheme*, not
the *predictor*), so its border is ground truth. Reference: `dev-cfl-rev0a12-crashborder.py`,
`dev-cfl-rev0a12-borders-precise.py`.

### 5.2 Memorized crash borders (fixed points the suite asserts against)

Bisected, faithful-sim crash borders in `coeff_tension`, and the gate predictors at the border:

| Direction (fixed B, damping) | Empirical crash `coeff_T` | `1+8B` / `8B` (expected) | gate `max\|g\|` just past | gate flags? |
|---|---|---|---|---|
| Upper, B = −7.58e-4, dec=cfd=0 | 0.9946 | 0.9939 (1+8B) | 1.057 | **yes** |
| Upper, B = 0 | 1.0000 | 1.0000 | 1.022 | **yes** |
| Upper, B = −0.05 | 0.6009 | 0.6000 | 1.066 | **yes** |
| Upper, B = 0, dec = 0.3 | 1.0007 | 1.0000 (unmoved by dec) | 1.005 | **yes** |
| Upper, B = 0, cfd = 0.1 | 0.8007 | 0.80 (HF-tightened) | 1.008 | **yes** |
| Lower, B = 0.01 | 0.0799 | 0.0800 (8B) | 1.025 | **yes** (Jury); (T−8B) **misses** |
| Lower, B = 0.05 | 0.3997 | 0.4000 (8B) | 1.039 | **yes** (Jury); (T−8B) **misses** |
| COLLAPSE (dx↑, T,B→0) | *no blowup* | — | 1.000 | **no** (correct — out of scope) |

And the live full-physics sweeps (pitch-57-like string, `dev-cfl-rev0a12-crashborder.py`):
tension↑ → crash at `coeff_T = 1.006`; dx↓ → `0.232` (`B = −0.129`); string_iter↓ → `0.781`;
radius↑(posE) → `B = 2.77e-3` (lower-edge, `(T−8B)` misses, Jury catches); rho↓ → `0.881`. **In every
case the gate's border coincides with the empirical NaN border.**

### 5.3 Standing assertions

1. **Gate == empirical border.** For each memorized fixed point: the gate flags at/above the crash and
   not below (no false-reject, no miss). (A pure-Python test; no GPU needed — runs in CI fast.)
2. **Live reject + finite render.** A known-unstable edit (e.g. tension ×200, radius ×8, jung ×100) via
   the real `update_parameter('string', …)` path raises 400 **and** a subsequent render is finite
   (engine never saw the unstable coeffs). (The existing system tests already do this; keep them.)
3. **No false-reject of healthy presets / collapse edits.** Baseline preset → all strings stable; a
   large `length` edit (drives T,B→0, the collapse direction) is **allowed** (not flagged). (Existing
   `test_large_length_edit_is_allowed_not_falsely_rejected` — keep.)
4. **Real-preset margin sentinel.** `Belarus_8band_196modes` sits ≥ 0.9 below the upper edge (a
   regression that pushed a real preset near the edge would trip this).

> **Test-margin fidelity note (from the implementer).** `test_cfl_stability_guard.py` overrides
> `string_iteration = 4` via `initialize()`, while `Preset_test5.json` stores `6` and
> `BaselinePreset1` runs at `12`. Since `coeff_tension ∝ 1/string_iteration²`, the test deliberately
> sits at a **tighter** CFL margin than production (≈ 2.25× / 9× closer to the edge). This is fine —
> it stresses the gate harder — but the memorized borders in §5.2 are stated in `coeff_tension`
> (iteration-independent), so the standing assertions are unaffected by the iteration choice. Keep the
> physics-space (not multiplier-space) framing so the test is robust to preset/iteration changes.

---

## 6. The three bugs — root cause and how v2 removes each

### 6.1 Synthesis halt on a (stabilising) tension reduction
**Cause:** the v1 host check called `runSynthesisKernel()` from the REST/param thread to refresh the
flag. When the engine was playing, that second, unsynchronised **cooperative-grid** kernel launch
raced the engine thread's launch → silent synthesis halt on *every* string edit (including stabilising
ones). The v1 "passive/branched R1" change patched it (don't launch when online; poll the flag with a
250 ms deadline) — but that leaves a fragile timing dependency and a best-effort 400.
**v2 removal:** the gate is computed host-side **before** upload; there is no kernel launch from the
param thread, no flag to refresh, no race. Eliminated by construction.

### 6.2 k = 0 false-positive reject
**Cause:** evaluating the free-running recurrence at θ = 0, where `g = 1` is an *exact defective double
root* (§2.4); float round-off pushes the computed `|g(0)|` to 1.00042 → spurious reject. v1 patched it
by starting the sweep at k = 1.
**v2 removal:** the closed-form box/Jury check tests (T, B) directly and has the DC mode designed out —
there is no θ = 0 evaluation to round-off. (The v1 k≥1 instinct was correct; v2 makes it structural.)

### 6.3 pitch-57 "clicks / no sustain"
**Cause (measured):** NOT the synthesis or the guard. The in-proc deterministic render of pitch 57
**sustains**, with flag = 0 and finite output, at both `string_iteration = 4` and `6`
(`dev-cfl-pitch57-repro.py`, reconfirmed this session). pitch 57's `coeff_T = 0.018`, ~50× under the
edge. The click is therefore in the **live** path: the REST/WS note trigger, the param-apply threading
(the passive/branched-R1 region), or the audio streaming path.
**v2 relation:** v2 removes the passive/branched-R1 threading entirely (§6.1), which is the most
likely live-only culprit (it was bolted onto the param-apply path for the guard). If the click
persists after v2, it is in the WS trigger or streaming path and is a **separate** task — to be pinned
with a full-backend repro (`dev-cfl-pitch57-fullbackend.py`) that distinguishes "note_playback synth
buffer clicks" (→ param-apply/synth) from "synth sustains but live audio clicks" (→ streaming).

---

## 7. Migration — keep / simplify / remove

**Remove (CUDA, `Kernels.cu` / `constants.h` / `Pianoid*.cu`):**
- `cflMaxAmplification` (the device θ-sweep) — replaced by the host closed form.
- The gate block in `parameterKernel` (the apply-vs-fallback branch, L225–309).
- `dev_string_shadow_coeffs` + `SHADOW_COEFF_ROWS` + all shadow read/write (R1 fallback no longer
  needed — the host rejects before upload, so the GPU only ever holds stable coefficients).
- `CFL_THETA_SAMPLES`, and the `string_stability_ratio` / `string_stable_flag` **device buffers** +
  their getters (`getStringStabilityRatios` / `getStringStableFlags`) — the ratio is computed
  host-side now.
- `CFL_LIMIT = 1.0` / `CFL_BENDING_COEFF = 8.0` — **confirmed vestigial by the implementer**: they are
  already unused by the active swept gate (kept only for the doc cross-ref). They become host-side
  constants if the host gate uses the box form, or are deleted entirely if it uses Jury. This also
  resolves the stale-comment drift flagged in the review (the constants/comments referenced a
  `(T−8B)/CFL_LIMIT` reject path the code never took — the code reported `max|g|`).

**Simplify (middleware, `parameter_manager.py`):**
- Delete `_raise_if_cfl_rejected` (the flag-readback + engine-branch + 250 ms poll). Replace with a
  **pre-upload** closed-form check that raises `CflRejected` *before* `send_to_cuda`/`_gpu_upload`.
- Back `GET /get_parameter/stability_ratio/<key>` and `/all` with the host closed-form over the
  current `StringMap` (drop the device round-trip). Keep the REST contract + `_meta { cfl_limit }`
  identical so the `dev-ratiochart` frontend is unchanged.

**Keep:**
- `isfinite` defence (the degenerate-coefficient / collapse-corner catch) — move it into the host
  check.
- `CFL_LIMIT = 1`, `CFL_STABILITY_EPS = 1e-6` (now host-side constants).
- The closed-form **bound and derivation** in `SYNTHESIS_ENGINE.md` (apply the two §2.3 corrections +
  add the HF-damped upper edge + the §2.4 DC proof).
- All existing system tests in `test_cfl_stability_guard.py` (they assert reject + finite render +
  no-false-reject via the REST path — all still valid against the host gate). **Fix their docstrings**
  to state the criterion is the two-sided box / Jury (not just `(T−8B)`), matching the code. Add the
  §5 pure-Python "gate == empirical border" test.

**Net effect:** the guard becomes one host-side closed-form function + a pre-upload `if` + a REST 400,
plus an unchanged chart. No kernel change, no shadow buffer, no flag, no race, no `--heavy` build for
the guard itself. (A `--heavy` build is needed once, only to *remove* the now-dead kernel code/buffers
— a cleanup, not a feature.)

---

## 8. Risks / open questions

- **HF-damped upper edge closed form.** §2.2 measured that `cfd` tightens the upper edge; the exact
  closed form for the HF-damped Nyquist edge should be written and unit-tested against the swept
  `max|g|` (trivial — already have the swept reference). Until then, option (B) (Jury over a tiny
  θ-set) is the safe fallback and is also exact.
- **Output-string skip.** The host must apply the same `outer_sound > 0` (pitch ≥ 128) skip the kernel
  did, so output strings are not gated (their physics is placeholder). Trivial host-side.
- **Granular `dx` update bug** ("Failed to batch update dx", noted in WIP) is independent of the gate
  but should be confirmed not to interact with the host check (the check reads `Pitch.physics`/`dx`,
  so a failed `dx` write would just be checked against the old `dx` — acceptable, and orthogonal).
- **dev-cflfix rationale (informational, non-blocking).** This plan resolved the k=0/eps/sweep/
  passive-R1 questions from first principles + measurement; dev-cflfix's notes would corroborate but
  are not required for the design.

---

## 9. Recommended implementation steps (after approval)

1. Write the host closed-form `_cfl_amp(T, B, dec_curr, cfd)` + `coeffs_from_physics(pitch)` in
   `parameter_manager.py`; unit-test it against the swept `max|g|` reference (§5.3 #1).
2. Replace `_raise_if_cfl_rejected` with the pre-upload check (raise before `_gpu_upload`); keep the
   `isfinite` defence; return the redline flag.
3. Back `stability_ratio` REST on the host computation; verify the `dev-ratiochart` chart is unchanged.
4. UI: 400-handler → warn + (revert | re-enter) per §4.5.
5. `--heavy` build to delete the dead kernel gate + shadow/flag buffers + getters; verify no synth
   regression (offline render parity) and the existing system tests still pass.
6. Docs: apply the §2.3 corrections + §2.4 proof + HF-damped edge to `SYNTHESIS_ENGINE.md`; fix the
   test docstrings; archive `courant-stability-guard.md` (v1) with a pointer here.
