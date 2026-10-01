# Design Proposal: Universal Excitation via Looped Segment Traversal (2026-07-07)

> **Status:** DRAFT design plan (planning only, NO code). Awaiting user confirmation on the
> impulse-vs-power normalization direction (§4) before design lock.
> **Origin:** user request — consolidate the excitation system, make it universal to also support
> sustained/bow excitation, WITHOUT abandoning the existing 7-segment structure; universality via
> LOOPING (a counter embedded in one of the 7 segments). Grounded in the code + the just-added
> `SYNTHESIS_ENGINE.md` "Temporal Segmentation & Grid Reconciliation" section.

## 1. Current one-shot emission — precise map + the hook point
The excitation is a per-string pre-computed force time series (`dev_force_function`,
`EXCITATION_FACTOR = 8` segments of `initTotalSteps` samples) streamed into the FDTD update over
synthesis cycles. "Sweep once, then silence" is defined by exactly three places:

- **(A) Reset** — `gaussTest.cu:100` `exct_cycle_index[stringNumber] = 0;` at note-on. Writes
  segments 0–6; segment 7 stays zero.
- **(B) Read/emit** — `MainKernel.cu:415-426`: windowed copy into shared memory, `force = (globalSample < excitationLength) ? force_function[...] : 0.0` (past-window = silence). Consumed at `:588` `target += s_force_function[...] * coeff_force`.
- **(C) Advance + clamp-to-silence — THE HOOK POINT** — `MainKernel.cu:780-790`: `newOffset = exct_cycle_index + total_steps; exct_cycle_index = (newOffset < excitationLength) ? newOffset : excitationLength;` Once clamped, every read is out-of-window → 0.0 for the rest of the note.
- **Vestigial segment counter** — `gaussTest.cu:105-108` `nextIndexKernel`: advances one SEGMENT/cycle, HOLDS at `FACTOR-1`. This is the segment-granular ancestor of (C); the user's "counter in a segment that loops" = generalize it: **replace hold/clamp at the boundary with WRAP.**

**Net:** one-shot behavior lives entirely in the boundary policy at (C), backed by the read-guard at (B). Everything else (gauss shape, per-sub-step consumption, `coeff_force`) is orthogonal and stays byte-identical.

## 2. Universal looping mechanism — one parameterized counter
Per-note traversal descriptor (extend `dev_exct_cycle_index` or a parallel SoA buffer):
`exct_offset` (existing), `loop_start`, `loop_end`, `loop_mode {CLAMP | WRAP}`, optional `loop_remaining`.

Boundary policy at (C): `CLAMP` → clamp at `loop_end` (== today, hammer preserved); `WRAP` →
`if newOffset >= loop_end: newOffset = loop_start + (newOffset - loop_end)` (continuous re-emission).
Read-guard (B): modulo read within `[loop_start, loop_end)` in WRAP mode.

- **Hammer** = `CLAMP`, `loop_end = excitationLength` → reduces exactly to today's code (byte-identical). 7-segment structure untouched, segment 7 still silent.
- **Bow/sustained** = `WRAP` → counter never reaches silence; re-emits the loop window every
  `span/total_steps` cycles for arbitrary duration. Universality comes purely from the counter's
  boundary policy.
- **"Counter in one of the 7 segments"** = park-and-loop a single steady-state segment, e.g.
  `loop_start=5·initTotalSteps, loop_end=6·initTotalSteps`: segments 0–4 = bow attack/onset, then
  loop inside segment 5 for sustain. (Loop-whole-window `loop_start=0` = simplest Phase-2 default.)
- **Note-off** ends a bow by flipping `loop_mode → CLAMP` (natural tail-out via the existing
  `dec_open` damper path).

## 3. Random-bow model (natural, non-periodic)
A pure WRAP loop is perfectly periodic → buzzy. Add minimal per-wrap randomization (per-string RNG,
cheap xorshift or curand), acting ONLY on the wrap event (negligible cost):
1. **Timing jitter (primary):** offset the wrap restart within the window (`±~0.1·span`) → de-phases loops → non-periodic (dominant naturalness cue).
2. **Per-loop gain jitter:** `coeff_force · (1 ± ~0.05–0.15)` → amplitude breathing (bow-pressure/speed micro-fluctuation).
3. **Segment-selection jitter (optional):** pick the next loop segment among candidates → timbral variation.
`seed = 0` disables jitter → deterministic for tests.

## 4. Consolidation + the impulse-vs-sustained normalization question (★ needs user call)
`ExcitationMode { IMPULSE (hammer), SUSTAINED (bow) }` carried per note-event/per-string. Shared:
7-segment gauss curve+params, `exct_cycle_index` counter+advance, per-sub-step consumption, spatial
profile. Mode-specific: boundary policy + normalization target (+ bow loop/jitter params).

**The impulse-conservation problem (first-class).** Today: `coefficient = (calibration·mass·speed)/(temporal_impulse·spatial_impulse)` conserves per-note IMPULSE (correct for a hammer — fixed momentum, once). A WRAP loop re-delivers `temporal_impulse` every loop → total impulse grows unbounded with duration (which is CORRECT for a bow — a longer stroke delivers more momentum). So a bow cannot be normalized to impulse; the conserved quantity is **POWER** (energy/time) ≈ steady force RMS.

- **IMPULSE (hammer):** unchanged.
- **SUSTAINED (bow):** `coefficient_bow = (calibration_bow · bow_force) / (loop_rms · spatial_impulse)`, `loop_rms` = RMS of the force curve over the loop window; `bow_force` (pressure×speed) plays the `mass·speed` role. Makes the sustained drive level shape-independent; duration then correctly scales total energy.

Open sub-questions (flagged): (1) normalizer denominator — RMS vs mean-abs vs point-sum/span (recommend RMS, validate vs measured string energy); (2) loop-seam energy — wrap+jitter can inject a force discontinuity → click/DC; mitigate via segment-boundary-aligned near-equal endpoints (+ optional short crossfade), measure DC + CFL/stability headroom.

**★ STEADY-STATE requirement (user, 2026-07-07 — the concrete acceptance criterion for bow normalization).** A bowed pitch must produce a CONSTANT sound — it must neither GROW (runaway/instability) nor DECAY. Physically: the continuous bow energy INPUT must BALANCE the string's damping DISSIPATION → steady-state constant amplitude. Therefore each pitch assigned to BOW needs a per-pitch DAMPING CALIBRATION: calibrate the damping parameters (against the bow drive level) so input = dissipation. This couples the power-normalization (§4, sets input) with the string damping (sets dissipation); the acceptance test is "hold a bowed note → amplitude envelope is flat (neither grows nor decays)." Provide the calibration as a per-bowed-pitch function/utility (analogous to the hammer's output-scale calibration but targeting a flat sustain envelope, NOT a peak). This also directly addresses the CFL/stability risk: a correctly damping-balanced bow sits at constant energy, away from the stability edge.

`compose_excitation_coefficient` generalizes cleanly with a `mode` arg; incremental
`update_coefficient_factor` (linear rescale) still applies within each mode.

## 5. Touch points, trade-offs, risks, phased roadmap
**Touch points:** kernel hook (C) `MainKernel.cu:780-790` + read-guard (B) `:415-426` (the whole loop
mechanism = these two edits); per-string traversal state (extend `dev_exct_cycle_index` / small SoA);
note-on descriptor init (`gaussTest.cu:100`; revive or retire `nextIndexKernel`); facade staging
`Pianoid_excitation.cu` (`_append_string_gp`/batch — thread mode+bow params); coefficient/normalization
`StringExcitation.py` (`compose_excitation_coefficient` + an RMS sibling of `temporal_curve_impulse`);
middleware excitation upload + `ExcitationParameters` (mode+bow params through preset/REST plumbing);
FE `ExcitationProperties.jsx`/`Excitation.jsx`/`ExcitationEnergyEditor.jsx`/`utils/excitationImpulse.js`/
`hooks/useExcitationEnergy.js` (excitation-type selector + bow params; impulse readout branches to a
power/RMS readout in bow mode; preserve the DOMAIN=8 drawn-curve consistency).

**Trade-offs / risks:** real-time kernel cost (a `%` in (B) per sample×soundStep×string×cycle — the
only nontrivial cost; precompute `span`, branchless/power-of-two spans; measure — cooperative-grid is
latency-sensitive); **impulse model = highest design risk** (genuine physics change; validate vs
measured string energy AND the FDTD CFL/stability margin — a sustained drive continuously injects
energy, must not creep toward the stability edge); loop-seam clicks/DC; the load-bearing gauss-grid
invariant (`numSeg·gaussBlockSize = 7·initTotalSteps`) is safe by construction (loop touches the
counter, not the gauss launch — do not let bow-segment provisioning tempt a grid change).

**Phased roadmap (hammer byte-identical until Phase 4, bow-only):**
0. **Design lock** — confirm loop-window model, power/RMS normalizer, note-off semantics, jitter model; produce the `ExcitationMode` contract + descriptor layout.
1. **Hammer-parity refactor (NO behavior change)** — introduce the descriptor, rewrite (B)/(C) as the parameterized policy with `IMPULSE/CLAMP` the only value; assert byte-identical force_function + audio (regression vs dev-excenergy impulse tests).
2. **Bow/loop mode** — `SUSTAINED/WRAP` with segment-aligned loop; thread mode through facade+middleware+minimal FE toggle; deterministic (no jitter); verify sustained output + clean note-off.
3. **Randomness** — per-wrap timing+gain (+optional segment) jitter, `rng_seed`; seed=0 deterministic.
4. **Normalization** — power/RMS coefficient for SUSTAINED (`StringExcitation.py` + middleware); FE bow-force control + power readout; validate energy calibration + CFL headroom.

### Critical files
`PianoidCore/pianoid_cuda/MainKernel.cu` (C:780-790, B:415-426, consume:588) · `gaussTest.cu`
(reset:100, vestigial counter:105-108) · `Pianoid_excitation.cu` (batch staging) ·
`PianoidBasic/Pianoid/StringExcitation.py` (`compose_excitation_coefficient`/`temporal_curve_impulse`) ·
`PianoidTunner/src/components/ExcitationProperties.jsx` (+ `utils/excitationImpulse.js`).
