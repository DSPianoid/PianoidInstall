# Physics-Based Excitation Energy + Curve-Energy Normalization — Design Proposal

**Status:** FINAL-LOCKED — all decisions settled (D1–D9, 2026-06-16). Carry mechanism locked: ONE persisted coefficient per (pitch, level) = `c·m·v·temporalIntegral·hammerSpatial`, applied via the reinstated per-note `volume_coefficient` multiply, updated incrementally (ratio per changed factor). Accepts one small `.cu` un-comment ⇒ HEAVY CUDA rebuild. Implementation is a separate, coordinated `/dev` phase that begins AFTER dev-gausscp's hammer-chart route merges. **No code written yet.**
**Author:** dev-excenergy · **Date:** 2026-06-16
**Parallel-safety:** dev-gausscp is concurrently editing the same excitation domain (gauss copy/paste + hammer chart + a backend excitation route). This proposal is read-only; the implementation lands *after* dev-gausscp merges, REUSES its discrete hammer sampling, and hooks its hammer width/sharpness edit path (dual integration).

This proposal covers two linked requests:

- **PART 1 — Curve-energy normalization (frontend, "not a synthesis change").** When the user edits a Gauss excitation curve's *shape* — OR the hammer spatial shape (width/sharpness) — conserve the strike's total **impulse** (∫F dt): integrate the new shape, then rescale it back to the impulse value it had *before* the edit.
- **PART 2 — Physics-based excitation strength (model change).** Tie excitation strength to real physical parameters via hammer **momentum** (impulse = ∫F dt = m·v): hammer **speed** is per-excitation-level (same across all pitches at a level) and itself tunable, hammer **mass** is a per-pitch tunable parameter, and the global **volume** is recalibrated so loudness stays sensible.

> **CORE PRINCIPLE (load-bearing, user-emphasized).** The total volume/energy a hammer delivers is a function of **speed and mass ONLY**. To change a hammer's loudness you change its **mass** or its **speed** — never a gauss-curve edit. EVERY gauss edit (mu/sigma/shift/component-volume) and EVERY hammer-shape edit (width/sharpness) **reshapes and renormalizes** to preserve the total impulse `= m·v`. (This supersedes an earlier draft assumption that "volume edits are the intentional energy control" — dropped.)
>
> **DUAL INTEGRATION (load-bearing).** Total impulse is integrated over BOTH the **temporal** excitation function (the gauss curves) AND the hammer **spatial** shape (width/sharpness from the hammer chart). Editing either factor must renormalize so the combined impulse stays `= m·v`. This couples the gauss curves and the hammer chart; the normalization hooks BOTH edit paths.

---

## 1. Current-State Map (measured against docs + source, not inferred)

This is a high-stakes data-model area (units, axis/index, stored-vs-effective). Every claim below is traced to a doc section or a source line; nothing is source-inference of a semantic fact.

### 1.1 The excitation pipeline, end to end

```
 FE edit (5 gauss params/level)                 [PianoidTunner]
   └─ usePreset.changeParametersOfExcitation(pitches, level, gaussIdx, param, values)
        POST /set_parameter/gauss/<pitch>  { {level:{chart:{param:val}}} }
              │
              ▼                                   [pianoid_middleware]
   parameter_manager.update_parameter('gauss')
     pitch.excitation.load_from_dict(values)
       → levels_matrix[level, param, curve]       (shape 128×4×5; param 0=mu 1=sigma 2=volume 3=shift)
       → recalculate_excitation_matrix(): take 6 base rows [0,5,31,63,95,127], extrapolate → 128
     sm.pack_base_excitations() → 6×4×5=120 reals/pitch
     pianoid_cpp.setNewExcitationBaseLevels(...)   → C++ interpolates 6→128 → dev_gauss_params_full
              │
              ▼                                   [pianoid_cuda]
   NOTE_ON(pitch, velocity):
     addStringToBatch(stringNo, velocity)          stores volume_coeff[stringNo], param_offset=(stringNo*128+velocity)*20
     gaussKernel reads 20 reals for THAT velocity level:
       for i in 5:  g = exp(-0.5*((x-mu_i)/sigma_i)^2);  g = max(g - g_shift_i, 0);  result += g*g_vol_i
       result *= volume_coefficient                 (per-string; SEE 1.3 — currently 1.0)
       → dev_force_function[stringNo][sample]
     FDTD: u_next += force_function[n] * coeff_force * hammer_shape[p]
              │
              ▼
     soundInt = Sint32(output * main_volume_coefficient)   (output scaling — SEE 1.4)
```

Docs: SYNTHESIS_ENGINE.md "Excitation System" + "gaussKernel — Force Function Computation"; DATA_FLOWS.md §2.2 (Excitation base-levels path); PianoidBasic OVERVIEW "GaussCurve / ExcitationParameters".

### 1.2 Where excitation strength is set TODAY — the "magic numbers"

**Excitation strength is entirely the per-Gaussian `volume` amplitude of the curve, per velocity level.** There is **no kinetic-energy or mass model anywhere** in the excitation path. Concretely:

- A curve for one velocity level = sum of `NUM_GAUSS = 5` Gaussians, each with `(mu, sigma, volume, shift)`. `volume` (param index **2**) is the peak amplitude of that Gaussian (`GaussCurve.get_gauss`: `y = exp(s2) * coeff`, `coeff = self.volume`). Source: `PianoidBasic/Pianoid/StringExcitation.py:92-132`.

> **★ DATA-MODEL CONFIRMATION (D6, verified against source `StringExcitation.py:109-132`):**
> - `mu` = the **horizontal** center (timing, ms): it appears as `((xCoordinate - self.mu)/self.sigma)²` inside the exponent — it shifts the peak along the time axis.
> - `sigma` = horizontal width.
> - `shift` = a **VERTICAL** offset, NOT horizontal: `vertical_shift = volume * shift`, and each point is `y = exp(...)·volume − vertical_shift`. It moves the whole Gaussian DOWN by a fraction of its amplitude (then the GPU's per-component ReLU clips what falls below 0). So `shift` raises the ReLU floor / trims the curve's tails and skirts. This is why `shift` is shape-affecting (D6) — it changes the realized (post-ReLU) curve, hence its impulse.
- Only **6 base levels** are authored — `LEVEL_INDICES = [0, 5, 31, 63, 95, 127]` (MIDI-velocity breakpoints). `recalculate_excitation_matrix()` linearly interpolates them to 128 levels (`StringExcitation.py:419-426`; mirrored in C++ `interpolateBaseLevels`). So the velocity→strength curve is *piecewise-linear in the authored `volume` numbers* — the magic numbers.
- The literal defaults: `DEFAULT_VOLUME = [10, 3, 2, 1, 5]` (`StringExcitation.py:23`). Real presets store their own per-level volume rows (base64 in the preset `excitation` block).
- **Velocity's only role** is to *select the level* (`addStringToBatch(stringNo, velocity)` → `param_offset = (stringNo*128 + velocity)*20`). It does **not** apply any separate scalar. All velocity sensitivity is baked into the interpolated `volume` rows.

> **High-stakes fact (units):** the gauss `volume` numbers are **dimensionless engine amplitudes**, not physical force units. They flow straight into `dev_force_function` and then into the FDTD update scaled by `coeff_force = dt²·dec_inv` and the spatial `hammer_shape[p]`. There is no N, no kg, no m/s anywhere in this chain today.

### 1.3 The deprecated per-string `volume_coefficient` — MEASURED ground truth (★critical correction)

The user's plan (§3) is to "reinstate the deprecated `volume_coefficient`" to carry the physics scale, noting it "was functioning almost the same way." I traced its CURRENT state precisely against source. The reality is more deprecated than the earlier draft (or the SYNTHESIS_ENGINE doc) said — this is load-bearing for the §3 carry-mechanism decision:

- **The gaussKernel multiply is COMMENTED OUT, not hardcoded to 1.0.** In `pianoid_cuda/gaussTest.cu` the per-note volume is dead at the source:
  - line 46: `// real volume = string_excitation_params[blockIdx.x * 3 + 1];` (read commented out)
  - line 86–87: `// result += s2exp * volume * g_vol[i];` replaced by `result += s2exp * g_vol[i];` (the multiply is GONE).
  So the kernel applies **no** per-string/per-note volume factor today. The doc's "`result *= volume_coefficient`" is **stale** — there is no such live multiply.
- **The per-note volume slot is explicitly unused.** `Pianoid_excitation.cu:58-60`: `string_excitation_params[...*3+1] = 0; // volume slot unused (deprecated)`. The host writes 0 into the per-note volume slot at every note-on.
- **The per-string preset buffer is all 1.0.** `StringMap.pack_volume()` returns `[1.0 for _ in pitch_index]` (`StringMap.py:478-480`); physics slot [8] is "deprecated, always 1.0, kept for ABI" (`StringMap.py:495`); `initialize()` overwrites `volume_coefficient=1` every load (DATA_FLOWS §2.7); `parameter_manager` pops it as deprecated (`parameter_manager.py:320,382`); `PhysicalParameters.volume_coefficient` is *(removed)* in OVERVIEW.

**Two consequences for the user's reinstatement plan (both are §4 blocking issues):**
1. **Reinstating it REQUIRES a kernel edit** (uncomment the read + the multiply in `gaussTest.cu`, re-wire the buffer) → a **HEAVY CUDA rebuild**. It is NOT a free "the multiply already exists" lever. This contradicts the earlier D3 "no rebuild."
2. **It is per-STRING, not per-(string,level).** The buffer has one scalar per string, uploaded once at init; the per-note slot that *could* vary per velocity is the one that's been deleted. So a reinstated per-string `volume_coefficient` can carry `c·m(pitch)` (per-pitch mass) but **cannot carry `v(level)`** (per-velocity speed) — that factor has no per-level home in this buffer. See §3.2 + §4 for how the design resolves this.

### 1.4 The global volume — the recalibration knob

`main_volume_coefficient = max_volume^(volume_level/127)` (`pianoid.get_current_volume_coefficient`, `pianoid.py:807-818`). Applied at audio emission: `soundInt = Sint32(output * main_volume_coefficient)` (SYNTHESIS_ENGINE "Audio Output"; DATA_FLOWS §2.6). `max_volume` comes from `InitializationParameters`; `volume_level` is the runtime 0–127 toolbar/CC-7 control. This is the single global lever for PART 2's loudness recalibration.

### 1.5 Frontend representation of a curve

The FE stores a curve as **the 5 gauss params × 4** (`mu/sigma/volume/shift`), nested `parametersOfExcitation[pitch][level][chart][param]` — **not** a sampled array. Rendering samples the analytic Gaussians at 800 points (`GaussChart.jsx generateGaussian`), but edits write *parameters*. There is **no energy / integral / normalize logic in the FE today** (Explore-confirmed grep). Writers: `usePreset.changeParametersOfExcitation` (single), `changeParametersOfExcitationBatch` (stretch/shrink), `pasteExcitationToAllPitches` (paste). `usePreset` is the sole P1 writer; edits are optimistic + debounced. Workbench has `applyAnchoredFunction` (shape morph) and stretch/shrink (volume scale, or mu+sigma scale).

---

## 2. PART 1 — Curve-Energy (Impulse) Normalization (frontend)

### 2.1 The conserved quantity = IMPULSE (∫|f| dt), as a point-sum (D1)

The curve drives a **force** on the string. The conserved quantity is the strike's **impulse** (area under the force curve):

```
impulse  =  ∫ |f| dt   ≈   Σ_k  f(t_k) · Δt        (the curve is non-negative post-ReLU, so |f| = f)
```

**Computed as the discrete SUM of the already-discretized curve points — NO analytic Gaussian integral, NO kernel, NO CuPy.** The curve is already sampled for rendering; we reuse those points. Δt is constant across the window, so it factors out of the ratio and the practical conserved number is simply `Σ_k f(t_k)` (the point-sum). Rationale (D1):

1. **Linear rescale.** Because `f ∝ vol` and impulse `∝ Σ f ∝ vol`, restoring impulse is a single **linear** scale `s = impulse_prev / impulse_new` (no √). Simplest possible, exact in one step.
2. **Physically it is momentum.** With the impulse metric the conserved quantity is **momentum**: impulse `= ∫F dt = m·v`. This is exactly what PART 2 sets as the physical scale (`m·v`, linear) — PART 1 and PART 2 use the *same* quantity, which is why the two compose cleanly.
3. **Cheap.** A point-sum over a few hundred samples per edit is trivially fast for live editing (D3 — no GPU fallback needed; flag only if it ever lags, which it won't).

The force points MUST be computed with the **GPU force formula** (per-component ReLU `max(g − shift, 0)` BEFORE summation), not the Python post-sum clip, so the conserved number matches what the engine integrates.

### 2.2 The algorithm (discrete point-sum, linear rescale)

For a curve with params `{mu_i, sigma_i, vol_i, shift_i}`, i in 0..4, sampled on the engine's `EXCITATION_FACTOR = 8 ms` window at the curve's render resolution (reuse dev-gausscp's discrete sampler):

```
f(t_k) = Σ_i  max( exp(-0.5*((x_k - mu_i)/sigma_i)^2) - shift_i, 0 ) * vol_i     # GPU formula
   where x_k = k * EXCITATION_FACTOR / N
impulse(curve) = Σ_k f(t_k)                                                      # point-sum (Δt cancels)
```

**Normalization on a shape edit (gauss OR hammer):**

```
I_prev = impulse(curve_before_edit)        # captured BEFORE applying the user's change
curve' = apply_user_edit(curve)            # the shape the user just produced
I_new  = impulse(curve')
if I_new > 0:
    s = I_prev / I_new                      # LINEAR (impulse ∝ vol)
    for i in 0..4:  curve'.vol[i] *= s      # rescale the 5 amplitudes
```

One linear step is exact because every Gaussian is linear in its `vol_i`: scaling all five `vol_i` by `s` scales `f` by `s` and the impulse by `s`. (If `I_new == 0` — e.g. the user shifted the whole curve below the ReLU floor — leave amplitudes unchanged and surface nothing changed; a degenerate edit can't carry impulse.)

### 2.3 Dual integration — gauss curve × hammer spatial shape (load-bearing)

Total impulse is integrated over BOTH factors:

```
total_impulse  =  temporal_impulse(gauss curve)  ×  spatial_impulse(hammer width/sharpness)
```

The hammer spatial shape (`hammer_shape[p]`, computed from `width`/`sharpness`, circular/parabolic profile — PianoHammer) multiplies the temporal force per spatial point in the FDTD update (`force_function[n] · coeff_force · hammer_shape[p]`). So **editing the hammer width or sharpness changes the spatial integral and therefore the total impulse**, exactly like a gauss edit changes the temporal integral. Both must renormalize to hold `total_impulse = m·v`.

**Mechanics:** The renormalization scalar is applied to the gauss `vol` amplitudes (the temporal factor is the adjustable one; the spatial shape is what the user is sculpting on the hammer chart, and the temporal curve is what they sculpt on the gauss editor — whichever they touch, the *other* stays and the gauss `vol` carries the correction). Concretely:

- **Gauss-curve edit** → recompute temporal impulse, rescale gauss `vol` to restore `total_impulse` (spatial factor held constant).
- **Hammer width/sharpness edit** → recompute spatial impulse; since `total = temporal × spatial`, rescale gauss `vol` by `spatial_prev / spatial_new` so `total` is restored.

> **★ Spatial integrand source — REUSE dev-gausscp's route (no re-expose).** dev-gausscp already shipped a read-only **`GET /get_hammer_shape/<pitch>`** (PianoidCore `feature/dev-gausscp-hammer-shape-route` @ `e66bc8d`) that returns the engine's resident per-node `hammer_shape` array + geometry (`l_main`, `dx`, `p_full`, `node_positions`), computed host-side in numpy — **no rebuild**. So `hammerSpatial(pitch) = Σ (per-node hammer_shape values)` from that route — we do NOT re-derive or re-expose the profile. Reuse its pure mapper `mapExactNodesToDisplay` (exported in `HammerStringChart.jsx`) where useful.
> - **DATA-MODEL fact (measured by dev-gausscp):** `hammer_shape` is **SPARSE** — e.g. pitch 100 has only 3 nonzero nodes out of `p_full=22`. The spatial sum is over the (few) nonzero nodes; account for the sparse layout (sum the array as returned; don't assume dense). `hammer_position` in the packed/REST form is a **RATIO [0,1]**, not metres.

This couples the two editors: a hammer-shape edit nudges the gauss amplitudes under the hood, and vice-versa, so the user never accidentally changes loudness by reshaping. Loudness only moves when mass or speed moves (the core principle).

### 2.4 Which edits renormalize (D6 corrected, core principle applied)

| Edit | Renormalize? | Effect |
|---|---|---|
| gauss `mu` (timing), `sigma` (width), `shift` (**vertical** offset / ReLU floor — D6) | **YES** | recompute temporal impulse, rescale gauss `vol` to hold `total = m·v`. |
| gauss component `volume` (one Gaussian's amplitude) | **YES** | even a component-volume edit reshapes the *relative* mix; total impulse is then renormalized — so a single component's volume changes the SHAPE (its share of the mix) but NOT the total. (This is the core principle: no gauss edit changes total volume.) |
| Excitation stretch/shrink (vertical = all vol; horizontal = mu+sigma) | **YES** | both reshape ⇒ renormalize. |
| Workbench `applyAnchoredFunction` (shape morph) | **YES** | reshape ⇒ renormalize. |
| Hammer `width` / `sharpness` (spatial) | **YES** (dual integration) | recompute spatial impulse, rescale gauss `vol` by spatial ratio. |
| Hammer `position` | **NO** (decision: position doesn't change the spatial *integral* of the profile, only where it lands) — confirm during impl that `position` leaves `Σ hammer_shape` invariant; if it doesn't, treat as renormalizing. |
| **mass / speed change** (PART 2) | n/a — these are the ONLY loudness controls; they SET the target `m·v` that everything else renormalizes to. |

> The conserved quantity is per-curve (per excitation level), per pitch: "previous impulse" = the impulse of *that level's curve at that pitch* immediately before the edit.

### 2.5 Paste = RENORMALIZE to destination's prior energy (D4)

Copy/paste imports a **shape**, not loudness. On paste, compute the destination curve's impulse **before** paste, apply the pasted shape, then renormalize the pasted curve to the destination's prior impulse. So paste transfers shape only; the destination's loudness (set by its mass×speed) is preserved. This applies to single-level paste and paste-to-all-pitches (`pasteExcitationToAllPitches` renormalizes per destination pitch/level).

### 2.6 Where it hooks (granular, usePreset sole writer)

- New pure util `src/utils/excitationImpulse.js` — `curveImpulse(curveParams)` (temporal point-sum), `hammerSpatialImpulse(hammerShapeArray)` = sparse sum of the per-node array from **`GET /get_hammer_shape/<pitch>`** (dev-gausscp's route — reuse, don't re-expose; sum nonzero nodes), `renormalizeToImpulse(curveParams, I_target)`. **No backend change, no synthesis change** for the temporal part — matches "not a synthesis change"; the spatial factor is a read-only GET.
- Each edit handler computes `I_prev` from the current `parametersOfExcitation` snapshot, applies the edit, renormalizes, and routes the shape param + the 5 renormalized `vol` values through the existing `changeParametersOfExcitationBatch(pitch, changes)` — **one** debounced granular POST, one optimistic state update, no speculative emit. `usePreset` stays the sole writer; the util is called inside the handler, never from a new effect.
- The **hammer** edit path (dev-gausscp's `handleHammerParamChange` → `changeParametersOfExcitation` for hammer) additionally triggers a gauss-`vol` renormalization for the same pitch — so a hammer-width drag emits both the hammer POST and a gauss batch POST. This is the dual-integration coupling.

### 2.7 Interaction with dev-gausscp (REUSE, not fence)

dev-gausscp owns the gauss copy/paste + hammer-chart + the `GET /get_hammer_shape/<pitch>` route. PART 1 **builds on** that work, not around it:
- **Spatial impulse** = sparse sum of the per-node array from dev-gausscp's read-only **`GET /get_hammer_shape/<pitch>`** (PianoidCore `feature/dev-gausscp-hammer-shape-route` @ `e66bc8d`; host-side numpy, no rebuild). Do NOT re-expose `hammer_shape`.
- Reuse the pure mapper **`mapExactNodesToDisplay`** (exported in `HammerStringChart.jsx`).
- Hook dev-gausscp's hammer width/sharpness edit path for the dual-integration renormalization.

Therefore PART 1 implementation **must land after dev-gausscp's hammer unit (incl. this route) merges**, on the updated PianoidTunner + PianoidCore dev base, with MODULE_LOCKS acquired on the excitation/hammer files (coordinate via team-lead if dev-gausscp still holds any).

---

## 3. PART 2 — Physics-Based Excitation Strength (model change)

### 3.1 The physical model — MOMENTUM (impulse = m·v), not KE

Because PART 1 conserves **impulse** (∫F dt), the matching physical quantity is **momentum**: the impulse a hammer delivers equals its change in momentum, `∫F dt = m·v`. So the physical SCALE the excitation must hit is **linear in both mass and speed**:

```
target_impulse(pitch, level)  =  c · m(pitch) · v(level)        # LINEAR in m and v
```

(This reconciles the earlier KE = ½mv² framing to momentum m·v — D1+D3. The conserved quantity, the physics scale, and the rescale law are now all linear and all the *same* quantity, which is the clean property the whole design rests on.) The design:

- **Speed `v(level)` is per excitation level, shared across all pitches, and itself tunable (D2).** At a given level (0/5/31/63/95/127), every hammer regardless of pitch moves at the same speed (keystroke speed sets it, not pitch). The 6 per-level speeds are stored tunable parameters, not hardcoded.
- **Mass `m(pitch)` is a PER-PITCH tunable parameter (D5).** Each pitch carries its own hammer mass, with physical defaults graded heavy→light bass→treble (real pianos do exactly this). Editable per pitch.
- The strike's target impulse for `(pitch, level)` is `c · m(pitch) · v(level)`.

### 3.2 Carry mechanism — FINAL LOCKED design (user, 2026-06-16): per-(pitch,level) coefficient, incremental update

The user completed the design. The SCALE is carried as ONE coefficient **per (pitch, level)**, sent to the kernel and applied via the (reinstated) `result *= volume_coefficient` multiply. The gauss curve is a pure normalized SHAPE that never carries loudness.

**The coefficient is a PRODUCT of factors:**

```
coefficient[pitch][level] = c · m(pitch) · v(level) · temporalIntegral(curve[pitch][level]) · hammerSpatial(width, sharpness)
final force amplitude     = normalized_shape  ×  coefficient[pitch][level]
```

- `c` — global calibration constant (pinned at mf / middle C, §3.5).
- `m(pitch)` — per-pitch tunable mass.
- `v(level)` — per-level tunable speed.
- `temporalIntegral(curve)` — the discrete point-SUM of the (normalized) gauss curve, its own impulse.
- `hammerSpatial(width, sharpness)` — the discrete point-SUM of the hammer spatial profile (the spatial half of dual integration).

**★ INCREMENTAL (compositional) update — the efficiency point.** Because the coefficient is a *product*, when ANY single factor changes, DO NOT re-integrate the whole excitation — just multiply the stored coefficient by the changed factor's ratio:

```
mass change:            coefficient *= m_new / m_old
speed change:           coefficient *= v_new / v_old
hammer-shape change:    coefficient *= hammerSpatial_new / hammerSpatial_old
TEMPORAL curve-shape change: recompute the point-sum → coefficient *= tInt_new / tInt_old
```

Only a **temporal curve-shape** edit recomputes the point-sum; mass / speed / hammer-shape edits are pure O(1) multiplicative ratio updates to the stored scalar. In every case the result is ONE scalar, persisted and sent to the kernel — the full curve is never re-uploaded or re-integrated except on a genuine temporal-shape edit (and even then only the cheap point-sum is recomputed).

`coefficient[pitch][level]` is the reinstated `volume_coefficient`, now dimensioned **per (pitch, level)**, persisted in the preset alongside the other parameters.

> **Carry-option resolution — CHOSEN: B2 (user-approved 2026-06-16, "Rebuild is ok").** Revive the per-note volume slot, compute `c·m(pitch)·v(velocity)·temporalIntegral·hammerSpatial` **at note-on** in `addStringToBatch`, write it to `string_excitation_params[...*3+1]`, and apply it via the reinstated kernel multiply. The one-time HEAVY CUDA rebuild is accepted. **B1 (split mass/speed) — REJECTED** (speed changes would still re-touch the curve). **B3 / Route A (bake into curve rows, no rebuild) — REJECTED** (re-bakes the curve on every mass/speed/shape change, the very thing the user wants to avoid). D9 is final.

#### Confirmations (a)/(b)/(c) requested by team-lead

**(a) Per-(pitch,level) granularity is carried per-NOTE at note-on — via a DEDICATED REAL buffer (CORRECTED at implementation, Wave 2 2026-06-16).** The coefficient is realized natively per note-event: at note-on (`Pianoid_excitation.cu:_append_string_gp`), when BOTH the pitch (string) AND the velocity (level) are known, look up the stored `coefficient[pitch][velocity]` and write it into a per-note-event slot indexed by `blockIdx.x` (the batched string for THIS note). No `[strings×levels]` GPU buffer.

> **★ ABI CORRECTION (Wave 2, measured — supersedes the "no new kernel arg" claim).** The original per-note volume slot the draft pointed at — `string_excitation_params[blockIdx.x*3+1]` — is **integer-typed end to end** (`int* string_excitation_params` kernel arg; host `std::vector<int>`; device int buffer). The B2 coefficient `c·m·v·temporalImpulse·hammerSpatial` is a **fractional float**; stored in the int slot it would TRUNCATE (silent loudness corruption, often →0). The draft assumed the int slot "just works"; it does not. **Resolution (user-approved Option A, 2026-06-16): a DEDICATED `real` buffer** `dev_string_excitation_coeff` (host per-note staging `std::vector<real> string_excitation_coeff` + a resident host table `excitation_coefficients_[num_strings·128]` sampled at note-on; ONE new `real*` arg added to `gaussKernel`, read as `string_excitation_coeff[blockIdx.x]`). The legacy int slot is left `=0` and unused. This costs ONE extra kernel arg (the draft's "no new kernel arg" claim is **withdrawn**) but NO device-buffer reshape and NO new GPU upload path beyond the small per-note real buffer. Correctness over the no-arg nicety. Options B (fixed-point int) and C (int-as-float bit-pun) were rejected (lossy / brittle). HEAVY `--both` build landed + L1 verified (`setNewExcitationCoefficients` symbol present in the installed `.pyd`, `import pianoidCuda` OK). The middleware uploads the resident table via `setNewExcitationCoefficients(num_strings·128 reals)` (Wave 3).

**(b) Incremental factor-update scheme** — as above: multiplicative ratio into the stored coefficient for mass/speed/hammer-shape; point-sum recompute only on a temporal-curve-shape edit. All host-side (middleware), O(1) except the rare point-sum. The stored `coefficient[pitch][level]` table lives in the Python model + preset; at note-on the engine receives `coefficient[pitch][velocity]` via the per-note slot.

**(c) Rebuild verdict: ONE small `.cu` change ⇒ HEAVY CUDA `--both` rebuild — minimal, no buffer reshape.** The kernel work is exactly: uncomment `gaussTest.cu:46` (read the slot) + `:86` (`result += s2exp * volume * g_vol[i]`), drop placeholder `:87`; and write the real coefficient into `string_excitation_params[...*3+1]` at note-on (`Pianoid_excitation.cu:58-60`, today `= 0`). It is a compiled-file edit ⇒ HEAVY build per the rebuild matrix — but **no buffer reshape, no new kernel arg, no new upload path**: the per-note slot and the multiply already exist; we un-deprecate them. This single, well-understood HEAVY rebuild is the only kernel-side cost, and it is the design the user chose (clean shape/scale separation).

> **Performance:** mass/speed/hammer-shape edit = one ratio-multiply into a stored scalar (O(1)). Temporal-shape edit = one point-sum (few-hundred samples) + one multiply. Note-on = one slot write. Nothing re-uploaded but the single coefficient (+ the curve only on a temporal-shape edit). No GPU/CuPy.

### 3.3 The speed↔level mapping — TUNABLE per-level speeds (D2)

Six per-level hammer speeds, **stored as tunable parameters**, defaults below. Real grand-piano hammer speeds span ~0.1 m/s (ppp) to ~6 m/s (fff). Linear interpolation between the 6 breakpoints (matching the existing `extrapolate`):

| Level (MIDI vel) | Dynamic | Default v (m/s) |
|---|---|---|
| 0 | silence | 0.0 |
| 5 | pp | 0.3 |
| 31 | p | 0.9 |
| 63 | mf | 1.8 |
| 95 | f | 3.2 |
| 127 | ff | 5.5 |

Shared across all pitches at a level. With the **momentum** law (impulse ∝ m·v, linear), the loudness ratio fff:ppp ≈ 5.5/0.3 ≈ 18× ≈ **+25 dB** in impulse — musically sensible. (Note: under the dropped KE framing this would have been (5.5/0.3)² — much steeper; the momentum framing gives a gentler, linear dynamic law.) These 6 defaults are tunable; expose as a small editor (a per-level speed row), persisted per preset.

> **Units discipline:** `v` in m/s, `m` in kg, impulse in N·s. The map `m·v → engine amplitude` carries a single calibration constant `c` (folding dt², dx, hammer-shape normalization, float scaling), fixed once by the volume recalibration (§3.5).

### 3.4 The tunable PER-PITCH mass parameter (D5)

| Aspect | Proposal |
|---|---|
| Scope | **Per-pitch** — each pitch its own `hammer_mass`, editable individually and in ranges. |
| Defaults | Physically graded heavy bass → light treble. Concrete starting curve: ~12 g at pitch 21 (A0) down to ~4 g at pitch 108 (C8), interpolated across the compass (matches real grand hammer mass grading). |
| Range | `0.002 – 0.020 kg` (2–20 g) per pitch. |
| Units | kg (UI may show grams; store kg). |
| Where it lives | Per-pitch model state — extend `PhysicalParameters` (or `Pitch`) with `hammer_mass`, packed per pitch and saved in the preset's per-pitch `physics` block. (The slot exists conceptually; this is added per-pitch, NOT global.) |
| Effect | Linear: amplitude ∝ m, so doubling a pitch's mass = ×2 impulse = +6 dB on that pitch. |

> **Build note:** per-pitch mass in **Route A** still needs NO kernel change — the per-pitch `m(pitch)` is folded into that pitch's gauss `volume` rows by `apply_physical_excitation_scale`. So D5 (per-pitch) does NOT force a HEAVY CUDA rebuild, because we did NOT take Route B (the per-string `volume_coefficient` revival). This is the key reason Route A was chosen for per-pitch mass.

### 3.5 Volume recalibration — pin mf / middle C to today's loudness (D7)

PART 2 dramatically changes absolute excitation level, so the global output is retuned once. Lever: `main_volume_coefficient = max_volume^(volume_level/127)` (§1.4) and the calibration constant `c`. Procedure:

1. **Reference operating point (D7):** velocity ~64 (mf), **middle C (pitch 60)**, default mass for pitch 60, default `volume_level` (64). Render it offline (`note_playback`) on **today's** engine; measure peak/RMS at int32 output → the target.
2. **Set `c`** so the new physics path reproduces that same peak/RMS at the reference point (before/after parity by construction). Everything else scales linearly around it.
3. **Check the range:** fff (level 127) at the loudest/heaviest pitch must stay < int32 full-scale (no hard clip); ppp must remain audible. If fff clips, lower `c` (or `max_volume`); the dev-d52b int-domain soft-knee limiter is the safety net, not the primary gain stage.
4. Bake `c` as a named constant (e.g. `EXCITATION_IMPULSE_CALIBRATION`) beside `EXCITATION_FACTOR`, documented as "the (N·s → engine-amplitude) constant, pinned at mf/middle-C to the 2026-06 pre-physics loudness."

### 3.6 Files each change touches (implementation phase)

Final-locked carry design (D9):

| Change | Repo / file | Build |
|---|---|---|
| Per-pitch `hammer_mass` + per-level tunable speeds + per-(pitch,level) coefficient store + incremental factor-update + point-sum integrals | PianoidBasic `Pianoid/PhysicalParameters.py`/`Pitch.py` (mass), `ModelParams.py`/`StringExcitation.py` (speeds + coefficient), `constants.py` (defaults + calibration `c`) | PianoidBasic wheel rebuild |
| **Reinstate the per-note volume multiply** — uncomment `gaussTest.cu:46` (read slot) + `:86` (multiply), drop `:87`; write the real `coefficient[pitch][velocity]` into `string_excitation_params[...*3+1]` at note-on (`Pianoid_excitation.cu:58-60`) | PianoidCore `pianoid_cuda/gaussTest.cu`, `Pianoid_excitation.cu` | **HEAVY CUDA `--both`** (small, no buffer reshape) |
| Wire mass/speed through load + edit; persist coefficient; incremental ratio updates | PianoidCore `pianoid_middleware/pianoid.py`, `parameter_manager.py` | LIGHT |
| `hammer_mass` (per-pitch) + speeds + coefficient REST get/set + preset save/load schema | PianoidCore `backendServer.py`, preset schema | LIGHT |
| Volume recalibration constant `c` + reference measurement | PianoidCore (offline render harness) | none (measurement) |
| FE: per-pitch mass editor + per-level speed editor + impulse-normalization util + dual-integration hooks | PianoidTunner `usePreset.js`, new control components, `utils/excitationImpulse.js`; spatial factor via dev-gausscp's `GET /get_hammer_shape/<pitch>` (reuse, sparse sum) + `mapExactNodesToDisplay`; hooks into dev-gausscp's gauss + hammer paths | npm only (no new backend route) |

> **Rebuild verdict (LOCKED, user-approved "Rebuild is ok"):** ONE small `.cu` un-comment (the per-note multiply + the slot write) ⇒ a **HEAVY CUDA `--both` rebuild**. No buffer reshape, no new kernel arg, no new upload path. PianoidBasic changes ⇒ wheel rebuild; middleware Python ⇒ LIGHT; FE ⇒ npm.
>
> **Implementation-phase build discipline (PROJECT_CONFIG.md#docs-first-build--run + #rebuild-matrix):** build BOTH variants via the canonical **detached `Start-Process`** form, **stop the `.pyd` holder first** (launcher REST `POST /api/stop-backend`), absolute bat path after `cd /d PianoidCore` (NEVER `cmd //c … --heavy` in agent context — bricks the venv). Then verify the rebuild LANDED (grep a marker string into `PianoidCore/.venv/.../pianoidCuda.cp312-win_amd64.pyd`), and the two acceptance levels: **L1** `import pianoidCuda` resolves inside `PianoidCore/.venv/`; **L2** `POST /load_preset` → 200, no traceback. Both L1+L2 run on THIS box. The **AUDIO before/after** (`note_playback` offline render, `audio_off`) is **USER-GATED** — this box's cooperative-grid GPU won't sustain it; ship a ready-to-run render-assertion script for the user / a clean session.

---

## 4. Decisions — RESOLVED (user, 2026-06-16)

| # | Decision | RESOLVED |
|---|---|---|
| **D1** | Energy metric | **∫\|f\| (impulse / AREA), as a discrete point-SUM of the already-discretized curve — no analytic integral, no kernel. Rescale LINEAR: scale by impulse_prev/impulse_new.** Physics framing = **momentum** (impulse = m·v). |
| **D2** | Speed↔level | **Per-level hammer speed, defaults ppp 0.3 → fff 5.5 m/s, linear interp. The per-level speeds are TUNABLE params.** |
| **D3** | Route / carry mechanism | **SUPERSEDED by D9 (LOCKED).** Original D3 ("bake into curve rows, no rebuild") is dropped in favour of the carried-coefficient design — see D9. |
| **D4** | Paste policy | **RENORMALIZE to the destination's previous impulse (shape only)** — not keep-source. |
| **D5** | Mass scope | **PER-PITCH tunable** (each pitch its own mass; heavy bass → light treble defaults). |
| **D6** | `shift` | **Shape-affecting → included in renormalization. Data-model correction: `shift` is a VERTICAL offset; `mu` is the horizontal center** (confirmed §1.2 against `StringExcitation.py`). |
| **D7** | Recalibration reference | **mf (velocity ~64) / middle C (pitch 60); pin to today's loudness.** |
| **D8** | Replace vs multiply | **MULTIPLY — gauss curve = normalized SHAPE, physics (mass×speed) = SCALE; final amplitude = shape × scale.** |
| **D9** | Carry mechanism — **LOCKED (user, 2026-06-16)** | **Carry the SCALE as ONE coefficient PER (pitch, level)** = `c · m(pitch) · v(level) · temporalIntegral(curve) · hammerSpatial(width,sharpness)` (a PRODUCT). Persist it; send it to the KERNEL; apply via the reinstated `result *= volume_coefficient`. Gauss curve stays a pure normalized SHAPE. **INCREMENTAL update:** on a mass/speed/hammer-shape change, multiply the stored coefficient by that factor's ratio (no re-integration); recompute the temporal point-sum ONLY on a temporal curve-shape edit. Per-(pitch,level) is carried by the engine's existing per-NOTE slot (written at note-on, inherently per-pitch+velocity) — NO new GPU buffer. **Rebuild: ONE small `.cu` un-comment ⇒ HEAVY CUDA `--both`** (accepted by the user as the cost of clean shape/scale separation). |

**Core principles (load-bearing, restated):** (1) loudness = f(speed, mass) ONLY — no gauss or hammer-shape edit ever changes total volume; every such edit reshapes + renormalizes to preserve impulse = m·v. (2) DUAL INTEGRATION — impulse spans BOTH the temporal gauss curve AND the hammer spatial shape (width/sharpness); editing either renormalizes. (3) Physics scale is LINEAR (momentum), so conserved-quantity, scale, and rescale are all the same linear quantity.

---

## 5. Verification Plan

Both parts change the synthesised waveform ⇒ **synthesis-output ⇒ `note_playback` deterministic offline render, `audio_off`, `/test-ui`** (PROJECT_CONFIG.md#verification-surfaces). Measured before/after, buffer-vs-buffer.

| Item | Verification | Local vs user-gated |
|---|---|---|
| PART 1 impulse conservation | Jest on `excitationImpulse.js`: a shape edit (change sigma/mu/shift) then assert `impulse(after) ≈ impulse(before)` (point-sum). Pure FE. | **Local** (Jest). |
| PART 1 dual integration | Jest: a hammer width/sharpness change renormalizes gauss `vol` so `temporal×spatial` impulse is held. | **Local** (Jest). |
| PART 1 paste renormalize (D4) | Jest: paste a shape into a destination of different impulse → assert result matches destination's prior impulse. | **Local** (Jest). |
| PART 1 audio invariance under shape edit | Offline `note_playback` before/after a sigma edit (normalization on): peak/RMS within tolerance (impulse conserved ⇒ loudness ~stable). | Offline render — box constraint. |
| PART 2 dynamics (momentum) | Offline `note_playback` at levels 5/31/63/95/127, same pitch: peak/RMS ratios track `v(level)` (LINEAR, not v²); fff < int32 full-scale (no clip). | Offline render. |
| PART 2 loudness parity (D7) | At mf / middle C / vol 64: peak/RMS within tolerance of today's engine (recalibration target). | Offline render + a captured "today" baseline. |
| PART 2 per-pitch mass (D5) | Offline render of pitch P at mass m vs 2m: assert ×2 impulse (+6 dB) ±tol; assert a neighboring pitch's output is unchanged. | Offline render. |

> **Box constraint (must call out):** the cooperative-grid `addKernel` cannot launch reliably under heavy GPU contention on this box, and the backend won't stay up under load here. So: the **FE impulse math + param wiring is fully verifiable locally (Jest)**; the **offline-render audio assertions are USER-GATED** — they need a clean GPU session (the user's machine, or the user driving the offline harness). Implementation ships the offline assertions as a ready-to-run script; do NOT claim the audio half works without that render.

---

## 6. Summary

- **PART 1** — pure-frontend impulse normalizer (no synthesis change for the temporal part): integrate each curve as a discrete point-sum of the force formula (per-component ReLU); on ANY shape edit — gauss (mu/sigma/shift/component-volume) OR hammer (width/sharpness, via dual integration) — rescale the 5 gauss `vol` amplitudes LINEARLY (`impulse_prev/impulse_new`) so the strike's total impulse is conserved. Paste renormalizes to the destination's prior impulse (D4). Builds ON dev-gausscp (reuses its discrete sampler + hooks its hammer path), lands AFTER it merges, with MODULE_LOCKS.
- **PART 2** — physics law `amplitude(pitch,level) ∝ m(pitch)·v(level)` (momentum, linear), replacing the magic per-level volume numbers. `v(level)` = per-level tunable hammer speed (defaults 0.3→5.5 m/s); `m(pitch)` = per-pitch tunable mass (heavy bass→light treble). **Carry mechanism (D9, LOCKED):** ONE coefficient PER (pitch, level) = `c·m·v·temporalIntegral·hammerSpatial` (a product), persisted and applied via the reinstated per-note `volume_coefficient` multiply; updated INCREMENTALLY (ratio per changed factor — only a temporal curve-shape edit recomputes the point-sum). The gauss curve stays a pure normalized SHAPE; nothing re-uploaded but the single coefficient. Per-(pitch,level) is carried by the engine's existing per-note slot (no new GPU buffer). Cost: ONE small `.cu` un-comment ⇒ HEAVY CUDA `--both` rebuild (accepted). Global volume recalibrated once (constant `c`) pinned to today's loudness at mf/middle C.
- **Verification** — `note_playback` offline render (audio_off); FE impulse math + param wiring locally testable (Jest); audio assertions user-gated by the box's GPU constraint.

**STATUS: FINAL-LOCKED (D1–D9). HOLDING for team-lead's go (after dev-gausscp merges) before implementation.**
