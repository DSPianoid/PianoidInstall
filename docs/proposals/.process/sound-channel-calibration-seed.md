# Composition Seed — Output Sound-Channel Calibration

> Side seed for `docs/proposals/sound-channel-calibration-2026-07-10.md`. Holds the design-evolution
> log, per-decision notes, superseded framings, and build-mode justification — so the proposal stays
> lean. READ-ONLY authoring session; no source edits, no build, no stack, no capture.

## Provenance / inputs

- Operator request (voice-transcribed, corrected): emit a sine at a target mode's frequency on the
  emitters; find the combination of **amplitudes and phases** of the emitters that reaches **maximum
  acoustic output loudness at the minimum total RMS across the emitter drive signals** (output per unit
  drive effort). NOT modal-mass, NOT cross-mode-leakage.
- Grounding artefacts (read first, treated as established fact — not re-derived):
  - `docs/development/reviews/sound-channel-calibration-grounding-2026-07-10.md` (37 KB)
  - `docs/development/reviews/sound-channel-regime-measurement-2026-07-10.md` (12 KB, live-engine measured)

## Build-mode decision — **Mode B (dialog-from-scratch)**

Chosen over Mode A. Justification (per the skill's mode-selection table + "when in doubt, B"):

1. **High-stakes data-model uncertainty.** Phase (gain+phase per (mode/channel, emitter)) is NOT
   expressible on today's `real = float` model — carrying it is a coordinated FOUNDATIONS change across
   preset JSON schema + middleware `SoundChannels`/`preset_injector` + the CUDA kernel's per-mode
   accumulation. Whether v1 includes phase changes what a sound-channel coefficient *is*. A pre-drafted
   structure would bake in an answer the operator has not given.
2. **A first-class entity does not exist yet.** "Emitter" is not in the data model; the emitter↔channel
   mapping must be *designed*, not documented. Drafting modules before that entity is settled would be
   downstream-before-upstream.
3. **A new closed-loop measurement.** Max-loudness/min-drive-RMS optimization loop exists in neither
   PianoidCore nor RoomResponse; per-emitter phased drive is unsupported (single mono today). Novel
   surface → co-design.
4. The two objective terms live on **different surfaces** (drive RMS offline; acoustic loudness live-mic
   only) — the flow's feasibility depends on operator ground-truth (is a calibrated mic + loopback on the
   bench?). Structure hinges on an answer only the operator holds.

The governance, traceability, element-kind discipline, and one-question-at-a-time cadence are identical
to Mode A; only the pre-draft is skipped.

## Prior-art / consolidation note (for operator approval before any git mv)

- No existing **proposal** claims "output sound-channel calibration." Unclaimed object.
- The two `feedin-feedback-soundchannels-*-2026-06-04.md` docs are under `docs/development/reviews/`
  (data-model grounding reviews), NOT `docs/proposals/`. They are authoritative reference for the object
  this feature writes; recommend **keep as cited grounding, do not archive** — they are not competing
  proposals. No `git mv` proposed.
- Adjacent proposals (respect, don't merge): `feedback-coefficient-slider-2026-06-05.md`
  (`deck_feedback_coeff` rescales the same output-tap row), `excitation-loudness-normalization-
  correction-2026-06-30.md` (methodological analog: loudness ≠ the coefficient you think), `modaladapter.md`
  (active Campaign; declares processing-onward OUT OF SCOPE — this feature is at the far apply/output end,
  a SEPARATE effort).

## Missing per-mode normalization — scope decision (to record)

The FFT-measured coefficients are written by `preset_injector.py` **summed across modes and RAW** (per-mode
0–1 normalization ABSENT; only opt-in global clip via `PresetConfig.sound_max`, default None). This is a
concrete existing DEFECT feeding "not balanced properly." OPEN: is fixing it in scope for this proposal, a
prerequisite bugfix, or superseded by the calibration (which re-derives coefficients from live measurement
and may make the injector's raw-sum path moot for calibrated presets)? To be put to the operator after the
flow is settled — NOT silently absorbed. Note: this is the per-channel scalar-gain object, distinct from
the *deck* feedin/feedback per-mode-normalization fact (`SYNTHESIS_ENGINE.md:436-439`) — do not conflate.

## Composition log

### 2026-07-10 — session start
- Read both grounding artefacts. Confirmed no prior sound-channel proposal in `docs/proposals/` or
  `archive/`. Chose Mode B (above). Scaffolded seed + session log.
- Next: SendMessage(main) with build-mode + draft Purpose + the phase question (the single most
  downstream-constraining foundations choice). Then wait.

## Decisions log (locked answers from operator)

### D1 — Phase: v1 = gain-and-sign; continuous phase DEFERRED (2026-07-10)
- **Operator answer (verbatim):** "Gain and sign is ok."
- **Decision:** v1 optimizes per-channel **amplitude + polarity (±, a 180° flip)** only. **Continuous phase
  is a named, deferred future effort — not an omission.** The operator's phrase "amplitudes and phases" is
  realized in v1 as a two-valued (±) phase.
- **Rationale (cost):** gain-and-sign is buildable on today's real-valued model; continuous phase is a
  coordinated foundations change across preset JSON schema + middleware `SoundChannels`/`preset_injector`
  + the CUDA kernel's per-mode real MAC.
- **Rationale (physics — why this is not a mere compromise):** for a **lightly-damped mode with a real mode
  shape**, the per-emitter transfer to that mode is **real-valued**, so the sign is the COMPLETE answer — it
  records which side of the nodal line each actuator sits on. Continuous phase becomes physically necessary
  ONLY under **heavy / non-proportional damping**, or when actuators inject **frequency-dependent phase lag**
  (e.g. voice coils driven near their own resonance).
- **Consequence (scope/risk boundary — must be VISIBLE in the proposal):** v1 touches **NO compiled engine
  code** — no preset-JSON schema change, no `SoundChannels`/`preset_injector` data-model change, no CUDA
  kernel change. Calibration writes real floats (per-channel amplitude with polarity) into the EXISTING
  `mode_sound_channels` field.
- **Falsifiability (LOUDNESS-ONLY, OPERATIONAL form — replaces the retracted coherent-phase version;
  requires nothing the rig cannot do):** in the pairwise sign pass, **a comparison whose two drives
  `(+1,+1)`/`(+1,−1)` tie within noise means `cosΔθ_ref,i ≈ 0` — the relative sign is genuinely
  INDETERMINATE because that emitter's phase is not at 0°/180°.** That is the deferred continuous-phase
  content firing directly in the loudness data, exactly where D1 predicted → **gain-and-sign is insufficient
  for that mode.** The closed form `cosΔθ_ij = (|h_i+h_j|² − |h_i−h_j|²)/(4|h_i||h_j|)` quantifies it, and
  step-3's two drives already supply the numerator. Carry as explicit assumption + Ring 3 report line,
  `traces-to:` D1.
  > **RETRACTED (2026-07-10):** an earlier version measured the COMPLEX `h_i` coherently. The operator's rig
  > has **no absolute phase reference** across measurements — the mic yields **loudness only** (emitters are
  > not clock-synchronized to the capture). Any step requiring `arg(h_i)` is INVALID and removed.

### D2 — Ring 1 measurement procedure LOCKED (loudness-only, pairwise-against-reference, 11 measurements) (2026-07-10)
- **Operator dialogue** established: mic yields loudness only (no absolute phase); drives are synchronized
  so relative ± is exact; sign determined by `N−1` pairwise comparisons against the largest-`|h_i|`
  reference (his simplification), not `2^(N−1)` enumeration.
- **Procedure:** `N` magnitude + `2(N−1)` sign + 1 confirmation = **`3N−1` loudness measurements per mode**
  (N=4→11, N=16→47; upper bound — near-node emitters skipped); solve `x_i=s_i|h_i|` = matched filter.
  Verified independently (Cauchy–Schwarz optimum; `4Re(h_ref h̄_i)` sign discriminant; two-drive
  cancellation; parallelogram gate free per pair). **N is a design parameter ≤16 (D4) — never hardcode 4.**
- **Retraction chain (recorded honestly):** coherent-phase capture → RETRACTED (no phase reference);
  8-pattern enumeration → DEMOTED to documented alternative (exponential growth). The matched-filter RESULT
  survived both; only the MEASUREMENT of it changed.
- **RESOLVED by D3 (below):** RMS scope = aggregate ℓ2 → matched filter IS optimal → **conditional flag on
  the solve rule LIFTED.**

### D3 — RMS scope = AGGREGATE ℓ2 across channels; matched filter is optimal (2026-07-10)
- **Operator (verbatim):** "RMS is aggregate across actuators, so again the target optimization is maximum
  loudness with the same RMS, with the same RMS aggregated across all output channels."
- **Settles** load-bearing assumption (3): the drive-effort denominator is the aggregate ℓ2 norm `‖x‖`, NOT a
  per-channel bound. The matched filter `x∝h̄` is therefore the true optimum — the Ring-1 solve rule is
  **unconditional**.
- **Equivalence note (state in proposal):** his "maximum loudness with the SAME RMS" (constant-denominator)
  is exactly equivalent to maximizing the scale-invariant ratio `|h·x|/‖x‖`. "Max loudness at fixed RMS" and
  "max loudness per unit RMS" are the SAME optimization, not two — a future reader must see this.
- **Consequence — SANCTIONED behavior + a surfaced risk:** with no per-channel term, the matched filter will
  **drive one actuator hard while others idle** when one couples strongly to a mode. That is now sanctioned,
  not an oversight. BUT voice coils have individual excursion + thermal limits → **Ring 3 safety item:** a
  per-channel clip/limit the calibration must respect at PLAYBACK time, even though it does NOT enter the
  optimization. Surfaced for the operator's later decision; NOT silently added to the objective.

### D4 — Emitter↔channel mapping = 1:1; N actuators ↔ N channels, N is a DESIGN PARAMETER up to 16 (2026-07-10)
- **Operator (verbatim):** "each output channel maps to exactly one physical actuator." + "and then can be
  more numerous than four, can be up to 16 of them." + "I mean both channels and actuators."
- **Settles:** mapping is 1:1; **`num_channels = N` is a design parameter, `N ≤ 16`.** The measured `N=4` is
  the *Belarus preset's current value*, NOT a system constant. **Every count in the proposal is parameterized
  by `N` — never hardcoded to 4.** No projection step; the `N` solved drives write straight into that mode's
  `N` `mode_sound_channels` coefficients.
- **N-consequences (all verified):**
  1. **Measurement count = `3N − 1`** (N magnitude + `2(N−1)` sign + 1 confirmation). N=4→**11**, N=16→**47**.
     *Upper bound* — near-node emitters (below) are skipped.
  2. **Pairwise is now DECISIVE, enumeration REJECTED (not merely demoted).** Pairwise `N−1`=15 at N=16;
     enumeration `2^(N−1)`=**32,768** at N=16 — unusable. Its one merit (direct evaluation of the measured
     objective) is already recovered by the single confirmation drive. Keep in seed as REJECTED-with-reason so
     it cannot be resurrected.
  3. **Reference selection is STRUCTURAL, not a nicety.** With ≤16 actuators, more sit near nodes per mode
     (`|h_i|≈0`); the discriminant `4|h_ref||h_i|` means a low-`|h|` reference poisons EVERY comparison.
     `ref = argmax_i |h_i|`, **per mode**, is a REQUIREMENT (elevate to a principle), not a design note.
  4. **Near-node emitters — the indeterminate-sign case self-resolves (my refinement).** An emitter with
     `|h_i|` below the noise floor has an indeterminate sign, BUT `x_i=s_i|h_i|≈0` so its contribution is ~0
     either way. **Rule:** threshold `|h_i|` at the noise floor → set sub-threshold coefficients to ZERO and
     SKIP their sign comparisons. Not an unresolved edge case; a clean rule that also trims the budget.
  5. **`num_modes + num_channels ≤ num_strings` now has teeth + is UNENFORCED.** N=4: 196+4=200≤224 (headroom
     24). N=16: 196+16=212≤224 (headroom **12**, slots 100–115). Baseline `num_modes=100`→116, ample. Only a
     comment (`create_belarus_preset.py:55`) + structural padding (`pianoid.py:251`), **no runtime assert** →
     surface as a prerequisite/risk; a runtime assertion is warranted. Margin depends on the preset.
  6. **Aggregate RMS now spans ≤16 channels; concentration disparity grows** → strengthens the Ring-3
     per-channel excursion/thermal safety item (D3).
  7. **Budget:** full 196-mode sweep at N=16 = 196×47 = **9,212 measurements**, each needing settle
     (`τ=2Q/ω`) + integration (`T>1/Δf`) → order-of-hours (ESTIMATE, flag as such). Directly shapes Ring 2.
  8. **Multiplexing does NOT help (my correction — coordinator asked me to evaluate, not assume).**
     Hadamard/orthogonal multiplex needs a LINEAR measurement to invert (`h=H⁻¹m`, Fellgett √N gain). Here
     emitters are COHERENT and the mic measures `|Σ H_ki h_i|²` — coherent power with cross-terms
     (interferometry), NOT a linear combination. The magnitude detector destroys the sign/phase the inversion
     needs → per-channel recovery from multiplexed magnitudes is phase-retrieval/combinatorial = the rejected
     `2^N` search. Keep the `N`-measurement magnitude pass; multiplexing cannot cheaply demux.
- **Representation seam (settle in Modules, NOT implicit):** at 1:1 the "emitter" is *representable by the
  channel index*, not *present* in the data model. **Design decision (agent-led, provisional — finalize in
  Modules):** v1 **identifies emitter ≡ output channel** (NO new data-model entity), names the physical
  referent "actuator"; a future N:M mapping (or N>16) could introduce an explicit emitter entity without
  renaming. Rationale: adds nothing at 1:1; respects the D1 no-compiled-engine boundary.

### D5 — Measurement mic EXISTS; requirement is LINEAR/FIXED-GAIN/FIXED-POSITION, NOT calibrated (2026-07-10)
- **Operator (verbatim):** "Yes, the mic is connected." Foundations-breaking "no mic" risk cleared.
- **Do NOT upgrade "connected" → "calibrated".** Absolute SPL calibration is a **NON-REQUIREMENT**: a constant
  mic scale `α` cancels in `x_i=s_i|h_i|` (uniform scale = same matched-filter direction; absolute level is a
  separate headroom lever) and leaves `sign(4Re(h_ref h̄_i))` unchanged. State this affirmatively so no
  implementer blocks on procuring a calibrated reference mic the method never needed.
- **What the sense chain MUST be (requirements traced to the flow):**
  1. **Sense-side linearity** across the driven level range — no AGC / compressor / limiter / clipping. This is
     a SECOND linearity assumption, on the SENSE side, DISTINCT from the actuator-side superposition gate; the
     proposal previously named only the actuator side. `|h_ref+h_i|` must be the linear response to the sum.
  2. **Fixed gain for the mode's pass** — a gain change between the magnitude pass and the sign pass corrupts
     relative `|h_i|`; the sign discriminant survives (± cancels common scaling within a comparison) but
     `x_i=s_i|h_i|` does not. (Bonus robustness: signs are gain-invariant.)
  3. **Fixed mic position for the mode's pass** — moving the mic changes `h` itself; across DIFFERENT modes the
     mic MAY move (each mode's solve is self-contained), within a mode it must NOT.
  4. **Adequate SNR at ω** after narrowband integration — weakly-coupled actuators (`4|h_ref||h_i|` small)
     need longer integration or are zeroed by the near-node rule (CP11).
- **Ring-3 item:** a **joint linearity check** — measure `|h_i|` at two drive levels 6 dB apart, confirm the
  *measured* level scales by 6 dB. This tests actuator-side AND sense-side linearity TOGETHER; on failure the
  side is ambiguous → disambiguate by re-running at a lower absolute level (if it linearizes, the input stage
  was clipping). Supersedes the earlier actuator-only "amplitude-linearity check" bullet.

### ⚠️ CORRECTION to the retraction chain — "not balanced properly" = INTER-CHANNEL, not pitch-to-pitch (2026-07-10)
The coordinator (and thus my brief) misread the operator's original complaint. **"The coefficients are not
balanced properly" = INTER-CHANNEL balance WITHIN each mode** (the relative gains/signs across the `N`
channels for a given mode), **NOT pitch-to-pitch loudness scatter across modes.** The matched filter solves
**exactly** the problem he has. My earlier argument ("the ∝‖h‖ scatter survives calibration, therefore
per-mode normalization must land") answered a question he never asked. **The direction-vs-scale MATH stays
(it is correct), but its FRAMING changes:** cross-mode scale is a **stated NON-GOAL / the contract**, not a
gap this feature must fill. Recorded here rather than overwriting the earlier text, per the retraction-chain
discipline.

### D6 — Per-mode normalization / cross-mode balance OUT OF SCOPE (2026-07-10)
- **Operator (verbatim):** "The overall scale is not critical for this task. There are other places and other
  tools to correct this scale. This tool has to output the relative coefficients interchannels for each mode.
  Therefore, the absolute scale should be comfortable in terms of clear no clipping sound easily recordable by
  the mic. That's it." + (on the norm bug) "this one has to be tested. I suggest we assume for now that the
  function is linear and then we check the result and if it will be unsatisfactory we can revisit it."
- **Settles:** per-mode 0–1 normalization is **NOT folded in and NOT a prerequisite** — other tools own the
  row scale. The feature outputs **relative inter-channel coefficients per mode** (a row up to a scalar).
  Normalization-scope question RETIRED. CONTRACT + NON-GOAL, not a gap (see correction above; reframes CP13).
- **Measurement-drive-level requirement (his criterion):** pick the absolute drive level for **measurement
  comfort** — loud enough for good mic SNR at ω, quiet enough that nothing clips. **Convergence to state:** this
  is the SAME operating point that keeps actuators + sense chain in their linear regime (comfort criterion ≡
  linearity operating point). NB: the measurement drive level is DISTINCT from the stored coefficient
  convention (D7).
- **Linearity stance (from his message (1)):** DEMOTE the superposition/linearity precondition from a
  **BLOCKING Ring-1 gate** to a **RECORDED CHECK** — compute the parallelogram residual (free from the ±
  drives), record + surface it, do NOT block the run; the continuous-search fallback (Ring 3) is triggered by
  an OBSERVED residual, not a gate. Same for the joint 6 dB check. **Justification (assume-and-revisit, not
  assume-and-hope):** every falsifier is already in the data — parallelogram residual ⇒ superposition failure;
  sign tie ⇒ phase content; 6 dB deviation ⇒ sense-chain compression. The run produces its own evidence.

### D7 — Persistence convention = MAX-NORMALIZED (orchestrator default, delegated authority) (2026-07-10)
- **Basis:** operator: "you can proceed to implementation if you don't have any other questions" → orchestrator
  adopted the default on his behalf, invited objection. **NOT recorded as his ruling — a delegated default.**
- **Decision:** write each mode's row with **`max_i |x_i| = 1`**, all coefficients in `[-1,1]`. Rationale: most
  legible in the matrix; matches existing `sound_max` clip semantics; since the row's absolute scale is
  meaningless downstream (D6), normalizing to the peak discards nothing.

### D8 — Ring 2 (many-modes sweep) DEFERRED (orchestrator default, delegated authority) (2026-07-10)
- **The customer-facing defer choice the skill requires — delegated, with the budget as basis.** MVP calibrates
  ONE mode at a time. Rationale: a 196-mode N=16 sweep = `3N−1`=47 × 196 ≈ **9,200 measurements**, order-of-
  hours; batch orchestration should be designed AFTER the single-mode loop has been run and observed (building
  the sweep first optimizes a procedure nobody has used).

### D9 — Optional per-mode `‖h‖` export OFF by default (orchestrator default, delegated authority) (2026-07-10)
- **Decision:** the free per-mode `‖h‖` table (from the magnitude pass) is emitted ONLY when the mic is fixed
  across the whole sweep; **flag-gated, default OFF**, enabled by an explicit "mic fixed across modes"
  assertion (operator has NOT asserted it — do not assume). Meaningless if the mic moves per mode (per-mode α).

## Technical basis — closed-form (matched filter) verification (2026-07-10)

Coordinator proposed the objective has a closed form; I verified independently. **Verdict: CORRECT** under
explicit assumptions; ONE framing correction; the falsifier is sharpened (above).

- **Result.** `h` = per-emitter complex transfer to the target mode at ω; `x` = drive vector. Loudness
  `=|h·x|`, total drive RMS `∝‖x‖`, objective `=|h·x|/‖x‖` (a Rayleigh quotient). Cauchy–Schwarz →
  optimum `x ∝ h̄`, max value `‖h‖` = the **matched filter / maximum-ratio combining**. Real `h` (v1) →
  `|x_i| ∝ |h_i|`, `sign(x_i)=sign(h_i)`.
- **Assumptions the closed form STANDS ON (must be checked, not assumed):**
  1. **Linearity/superposition across emitters** — testable: drive two emitters together = sum of their
     individual responses. Failure (actuator interaction, amp nonlinearity, clipping) ⇒ closed form invalid,
     search required. → **Ring 1 precondition gate; Ring 3 search fallback.**
  2. **Modal observability** — the measured level at ω is that mode's response, not a mixture; measurement
     bandwidth (burst length / Goertzel bin) must be narrower than spacing to the nearest neighbour mode.
     → explicit assumption + Ring 3 check.
  3. **ℓ2 (aggregate energy) drive-RMS.** If the operator means a **per-channel** RMS bound (box/L∞), the
     matched filter is NOT optimal → different (constrained) optimization. Ties to Q3.
  4. Single loudness scalar (single mic, or a fixed multi-mic combining rule).
- **Scale-invariance nuance:** the matched filter fixes only the **shape** (relative gains+signs); absolute
  level is a separate headroom scalar `c` on the ray `x=c·h̄`. Maps onto coefficient-row × global-scale
  (`deck_feedback_coeff`/`output_scale`).
- **THE framing correction (coordinator's point 3 is inexact for the LIVE object).** In modes mode the live
  store is `mode_sound_channels[pitch][channel]` — **each mode/pitch has its OWN coefficient row.** So each
  mode gets an **independent** matched filter; there is **no "one x for many h" conflict**, and the
  collinearity obstruction the coordinator described applies to a **per-channel SCALAR shared across modes**
  (the strings-mode `string_coefficients`, object D) — which is NOT the live object. Therefore the real
  "joint across modes" question is NOT "one drive for several modes"; it is a **cross-mode BUDGET / BALANCE**
  problem: global drive headroom when many modes sound together + pitch-to-pitch loudness balance. That is
  **exactly where the missing per-mode 0–1 normalization defect lives** → Q3 and the normalization-scope
  decision are the same seam. Fold into how Q3 is asked.
### LOUDNESS-ONLY revision (2026-07-10, supersedes the coherent-phase measurement design)

The operator established a FOUNDATIONS fact: **the mic yields loudness only** (emitters unsynchronized to
the capture → no absolute phase). Coherent `h_i` capture is INVALID and removed. The matched-filter RESULT
is unchanged; the MEASUREMENT of it is loudness-only:

- **Ring 1 LOCKED procedure (per mode, at ω), 11 loudness measurements** — PAIRWISE AGAINST A REFERENCE
  (operator's simplification; supersedes the 8-pattern enumeration, which grew exponentially and is demoted
  to a documented alternative):
  1. **Magnitude pass (`num_channels`=4):** drive each emitter alone at unit amplitude → narrowband
     (Goertzel/lock-in) level at ω = `|h_i|`. Preconditions from modal data: settle past `τ=2Q/ω`; integrate
     `T > 1/Δf` (`Δf`=nearest-neighbour mode spacing).
  2. **Reference = largest `|h_i|`, RE-CHOSEN PER MODE.** Discriminant is `4|h_ref||h_i|`; a reference near a
     nodal line (`|h_ref|≈0`) makes every comparison pure noise, and which emitter is nodal is mode-dependent
     → reference is NOT fixed once. Real trap, first-class in the design.
  3. **Sign pass (`N−1`=3 comparisons × 2 drives = 6):** for each non-ref `i`, drive `(ref,i)=(+1,+1)` then
     `(+1,−1)`, measure loudness. Difference `= |h_ref+h_i|² − |h_ref−h_i|² = 4·Re(h_ref h̄_i)`; its SIGN is
     `s_i`. TWO drives (not one): the `|h_ref|²+|h_i|²` terms cancel in the difference, so the sign needs NO
     calibrated magnitude; the one-drive variant differences large numbers and inherits mic/room/integration
     magnitude error — rejected.
  4. **Solve:** `x_i = s_i·|h_i|` (`s_ref=+1`; global flip unobservable/meaningless).
  5. **Confirmation (1):** drive the winning `x`, measure loudness. Recovers the one property pairwise
     inference lacks (enumeration evaluated the ACTUAL measured objective) at 1 recording; if not louder than
     expected, superposition is failing → Ring-3 search fallback.
  **Free-with-the-11 checks:** the `±` pair drives make the **parallelogram-law** superposition gate
  `|h_ref+h_i|²+|h_ref−h_i|² = 2(|h_ref|²+|h_i|²)` free per reference-pair (resolves my earlier "costs
  extra" note); an optional **closing-triangle** consistency check (1 extra comparison) independently
  detects phase via transitivity failure.
- **Reconciliation with operator's "you need iterations" (he was pointing at something real):**
  (a) sign determination IS a search — an **exhaustive** one over 8 discrete points, not a continuous 4-D
  descent; (b) the exhaustive form evaluates the **actual measured objective**, so mild nonlinearity degrades
  it gracefully (a genuine robustness edge over the pure algebra — prefer it); (c) iteration remains
  justified because **`h` drifts** with drive level + voice-coil heating (calibration-`h` ≠ performance-`h`)
  → re-measure + re-solve across rounds (iterating the ESTIMATE of `h`, NOT a continuous search).
- **My precision refinements (sent up for verification, not blockers):**
  1. **The 12-measurement procedure fixes amplitudes at `|h_i|` and searches only signs — this is the EXACT
     optimum only when `h` is real** (the accepted v1 regime). For complex `h` it does not re-optimize
     amplitudes, so it is a real-restricted approximation — consistent with D1's v1 scope; state it, don't
     over-claim.
  2. **The clean, phase-free superposition gate is the PARALLELOGRAM LAW:** `|h_i+h_j|² + |h_i−h_j|² =
     2(|h_i|²+|h_j|²)`. The bare 12 do NOT fully contain the per-pair `±` 2-emitter measurements, so a
     rigorous gate costs a few extra measurements (per reference pair). The bare 12 give only a PARTIAL free
     check (best 4-emitter pattern loudness `≤ Σ|h_i|`, reaching it iff real+linear — but that conflates
     phase loss with nonlinearity). Recommend: lightweight parallelogram check on the reference pair in Ring
     1; full pairwise diagnostic in Ring 3.
- **Amplitude-linearity check:** `|h_i|` at two drive levels 6 dB apart; confirm it scales (cheap; include).
- **Machinery:** `sdl_audio_core` (simultaneous emit + multichannel record) + `recorder.py` (arbitrary-freq
  sine bursts) + RMS/FFT/Goertzel exist. **Gap to build:** per-emitter independent drive (current path is
  single mono) + continuous tone. RoomResponse `calibration_channel`/`reference_channel` is loopback prior
  art if ever wanted — the procedure needs no loopback.

*(Superseded: the "excite each emitter once coherently → analytic solve" flow consequence above — the
analytic SOLVE survives, but the measurement is the 12-loudness procedure, not a coherent capture.)*

## Direction-vs-scale decomposition — calibration ≠ balance (verified 2026-07-10)

> **⚠️ FRAMING SUPERSEDED by D6 (kept per retraction-chain discipline, not overwritten).** The MATH below is
> correct, but its framing — "the ∝‖h‖ scatter IS the operator's complaint, so normalization must land" —
> answered a question he never asked. Per D6, "not balanced properly" = INTER-CHANNEL within a mode (which the
> matched filter solves), and the per-mode SCALE is a **stated NON-GOAL owned by other tools**. Read the scale
> DOF below as **the CONTRACT** (calibration outputs a direction), not a gap. My refinement #2 (cross-mode
> mic-consistency) survives, repurposed as the **optional flag-gated `‖h‖` export, D9**.

Coordinator's claim, verified independently. **Verdict: CORRECT**; two refinements added (one a real constraint).

- **Matched filter sets DIRECTION, not SCALE.** `|h·x|/‖x‖` is scale-invariant (`x→cx` unchanged), so the
  optimum is a **ray** `x∝h`, not a point. `x_i=s_i|h_i|` is one representative — relative gains+signs fixed,
  overall row magnitude FREE. (Consistent with my first-verification "scale-invariance nuance".)
- **Pitch-to-pitch loudness scatter SURVIVES calibration.** At equal drive RMS `R`, `x=c·h` with `c=R/‖h‖` →
  loudness `=|h·x|=R‖h‖`, ∝ `‖h‖`, which varies per mode. The matched filter (independent per mode, free
  scalar per row) CANNOT equalize it → **that scatter IS the operator's "not balanced properly."** So the
  missing per-mode normalization is NOT an adjacent bug — it is **the half of the problem the calibration is
  mathematically incapable of solving.** Orthogonal & complementary: **calibration = direction; normalization
  = magnitude/relative loudness.** Neither substitutes.
- **Cross-mode headroom is a SCALE question.** With aggregate ℓ2 RMS per mode and `N` shared actuators, total
  drive when many modes sound together depends entirely on the per-mode row scales → ties normalization
  directly to the Ring-3 per-channel excursion/thermal clip (clip protects actuators; normalization sets the
  loudness distribution that decides how often the clip is hit).
- **Verification consequence:** normalization + calibration shipped together = two changes to one output that
  can't be told apart → the two MUST be **separately observable** (before/after each alone), whichever scoping
  the operator picks. → cross-cutting Verification section.
- **Confirmation-drive scope (tighten in Ring 1):** the confirmation validates only that the **direction** is
  right (louder than sign/amplitude alternatives at equal drive RMS). It says NOTHING about the row's scale —
  do not let it appear to validate a loudness the calibration never set.

**My refinements (value-add, not corrections):**
1. Per-mode **0–1 normalization** is a scale *convention* (prevents raw blowup/silence); true loudness-
   *balancing* needs a per-mode scale from measured loudness. Both are the scale DOF; name precisely which.
2. **Cross-mode mic-consistency constraint (D5 interaction — a real seam).** The calibration DOES measure
   per-mode `‖h‖` (magnitude pass) — exactly what loudness-balancing needs — **but only up to a per-mode mic
   scale `α`.** `α` cancels WITHIN a mode (direction is `α`-invariant → D5's "mic may move between modes" is
   fine for calibration) but NOT ACROSS modes. So to FEED loudness-balancing from calibration, the mic must be
   fixed **across** modes too; a pure 0–1 convention needs no cross-mode acoustic measurement. Surface this
   where D5 and normalization meet.

**Modules consequence:** the coefficient writer must apply a per-mode SCALE, not persist `x_i=s_i|h_i|` as the
final row. Whoever owns normalization owns that scale.

## Open foundations questions (raise one at a time)

- ✅ **Phase in/out of v1?** → **D1** (gain-and-sign; phase deferred).
- ✅ **RMS scope** (per-mode/joint; aggregate vs per-channel) → **D3** (aggregate ℓ2; matched filter optimal).
- ✅ **Emitter↔channel mapping** → **D4** (1:1; 4 actuators; emitter ≡ channel in v1).
- ✅ **Mic bench reality** → **D5** (mic connected; requirement is linear/fixed-gain/fixed-position, NOT
  calibrated; sense-side linearity added; joint 6 dB check → Ring 3).
- ✅ **Per-mode normalization scope** → **D6** (OUT OF SCOPE; other tools own scale; "not balanced" =
  inter-channel, corrected). Retired.
- ✅ **Persistence target** → **D7** (max-normalized, `max_i|x_i|=1`; orchestrator default, delegated).
- ✅ **Ring 2 defer-or-now** → **D8** (DEFERRED; orchestrator default, delegated; budget basis).
- ✅ **Optional `‖h‖` export** → **D9** (OFF by default, flag-gated on mic-fixed-across-sweep).

**ALL foundations questions resolved. Operator authorized implementation ("proceed to implementation if you
don't have any other questions"). Proposal body COMPLETE.**
