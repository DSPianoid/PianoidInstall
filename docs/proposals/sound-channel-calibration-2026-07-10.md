# Output Sound-Channel Calibration — Campaign Proposal

- **Status:** DRAFT — foundations + body complete. **Ring-1 implementation ATTEMPTED (dev-sc7a, 2026-07-10) —
  BLOCKED by two premise breaks; only the hardware-independent core (M3 detector + M4 solver) shipped.** See
  the Implementation Status block immediately below before treating any module as done.
- **Date:** 2026-07-10
- **Kind:** Campaign (new closed-loop bench feature; new service module `sound_channel_calibrator.py`;
  the real new work is the per-actuator phased drive path)
- **Seed (composition history):** `docs/proposals/.process/sound-channel-calibration-seed.md`
- **Grounding (established facts — cited, not re-derived here):**
  `docs/development/reviews/sound-channel-calibration-grounding-2026-07-10.md`,
  `docs/development/reviews/sound-channel-regime-measurement-2026-07-10.md`

> **How to read this document.** It is governed **top-down**: Purpose → **Flow (the center)** → Core
> principles (derived from the flow) → Decision hierarchy → Architectural principles → Architecture +
> internal flows → Modules → Cross-cutting. **Upstream governs downstream.** Every element carries a
> `traces-to:` tag naming the upstream ID(s) it serves; the traceability matrices at the end are the
> machine-checkable view. A change upstream re-traces every dependent (grep its ID). Corrections flow
> UP — never patched downstream.

---

## Implementation Status (dev-sc7a, 2026-07-10) — two premise breaks; core-only ship

A `/dev` pass attempted the Ring-1 MVP (M1–M8 + the task-0 scale-tool verification). **v1's "no
compiled code" scope held for what shipped, but two load-bearing premises broke — both hit the
pre-agreed STOP-and-report conditions — so the live loop was NOT built.**

**SHIPPED (hardware-independent core, worktree `wt-sc7a-core`, branch `feature/dev-sc7a-soundcal`, NOT merged):**
- **M4 matched-filter solver** — `pianoid_middleware/modal_adapter/matched_filter_solver.py`. Pure numpy,
  no device: ref=argmax|hᵢ|, signs from the (+1,±1) loudness difference, near-node zeroing, `xᵢ=sᵢ|hᵢ|`,
  max-normalized row (D7) **and** the raw ray (so the persistence convention stays open — see break #2),
  plus recorded residuals (parallelogram superposition, `cosΔθ` phase falsifier). 21/21 unit tests (synthetic h).
- **M3 narrowband detector** — `pianoid_middleware/modal_adapter/measurement/narrowband_detector.py`. Pure DSP
  lock-in magnitude/power at ω + the CP4 preconditions (settle τ=2Q/ω, integration T>1/Δf, neighbour rejection)
  + the per-measurement wall-clock cost model. 17/17 unit tests.

**PER-MEASUREMENT COST (the flagged unknown — ANSWERED):** physics floor = settle + integration; compute
(~1.8 ms lock-in) is negligible. Typical ~0.44 s/measurement → **N=4 mode ≈ 5 s, N=16 mode ≈ 20 s**
(dense/high-Q worst case ≈ 2 s/measurement → ~24 s / ~100 s). MVP single-mode loop is usable; confirms D8
(196-mode N=16 sweep ≈ 5–6 h → correctly deferred).

### Live-loop completion + stability fix (dev-scr1, 2026-07-11)

The full live ASIO drive+capture loop (M1/M2/M6/M8) was completed on the operator's rig
(Belarus_196modesC_Fanera6exc, ASIO_CALLBACK). The operator reported three defects; all fixed
**Python + FE only, no CUDA rebuild** (branch: dev, HOLD):

- **Tone not a pure sine ("too often / too short").** ROOT CAUSE (measured from captured mic
  buffers): each measurement tone was only ~154 ms = **~9 cycles** at a 55.7 Hz mode, with an
  abrupt onset/offset step (click) → harmonic splatter (3rd harmonic reached 147 % of the
  fundamental); and 3N−1 such short bursts per mode read as rapid chirping. FIX: `asio_drive`
  adds a raised-cosine `fade_ms` (default 8 ms) fade-in/out (kills the click); `calibrate_mode`
  holds the tone far longer (see below) → a genuinely sustained sine (~38 cycles; fundamental now
  dominant, harmonics ≤ ~13 % on coupling channels).
- **High run-to-run variance (same params).** ROOT CAUSE (measured, N≥5): the lock-in skipped
  only ~1 cycle (`settle_samples(Q=1.0,…)`), so it integrated over (a) the mode's resonant
  ring-UP and (b) the **previous same-ω tone's ring-DOWN** (every tone in a mode is at the same
  ω, back-to-back with no decay gap). Low-SNR channels were noise-dominated (only ~9 cycles).
  Quiet channels swung 0.007↔0.65 (CV 55–63 %), the persisted row's sign flipped ±1 run-to-run,
  confirmation-loudness CV 0.43, superposition residual 0.87. FIX in `calibrate_mode` +
  `LiveAsioMicBackend.measure`: (1) `settle_margin` 1.5→**4.0** τ (a driven resonator reaches
  ~98 % steady after 4 time-constants; this ALSO decays the prior tone to ~2 %, so no separate
  silence gap is needed); (2) integration floored at `min_integration_cycles`=**24** periods of
  the tone (not just 1/Δf, which is a handful of cycles at a low mode); (3) `measure()` now takes
  `settle_seconds` and the detector **skips the real settle** and integrates only the steady tail.
  RESULT (measured): dominant-channel self-loudness CV **4.5 %** (was 5–63 %), persisted-row max
  deviation **±0.028** across runs (was ±1.08), confirmation CV **0.013** (was 0.43), **no sign
  flips**; superposition residual 0.37 at mode 0 (55 Hz, physical low-freq non-ideality) and
  **0.048** at mode 40 (< the 0.1 threshold). Cost: per-tone hold 154 ms→~665 ms at mode 0 (the
  `est_mode_cost_s` shown in the UI now reflects the true settle+integration hold).
- **"Why is pitch needed at all?"** DETERMINATION (data model, DATA_FLOWS.md §2.4 + source):
  `mode_no` and `pitch` are **orthogonal keyspaces** — `mode_no` (0…num_modes−1 = 0…195) selects
  which soundboard-resonance FREQUENCY is driven/measured (a mode is a global board resonance and
  carries no pitch); `pitch` (0…127) selects which `mode_sound_channels` ROW the solved
  coefficients are written to. There are more modes than keys and no mode→pitch mapping exists on
  the engine, so **pitch is NOT redundant and cannot be derived from mode_no**. RESOLUTION: keep
  both; the FE (`CalibrationSubpanel.jsx`) now labels them "Mode # (drive freq)" / "Pitch (write
  row)" with tooltips explaining the distinction (no API change).

Live-verified on the UI Calibrate tab: two consecutive runs gave [+0.126,+0.065,+1.000,+0.375]
and [+0.123,+0.077,+1.000,+0.373] (ref consistently ch2), Confirm persisted to
`mode_sound_channels[60]`. Evidence: session log `logs/dev-scr1-2026-07-11-101600.md`, probes
`development/diagnostics/dev-scr1-variance-probe.py` + `dev-scr1-buffer-analysis.py`.

### Operator resolution (2026-07-10 — both breaks resolved)

- **Break #1 → re-scoped to ASIO, NOT an sdl_audio_core change.** Operator: *"the audio driver can drive all
  channels separately. You have to use ASIO driver for that and you have to build the functionality to send a
  sine wave. Don't use SDL, don't use mono, use multi-channel ASIO output."* → M2 moves to the **multichannel
  ASIO output path**; `sdl_audio_core` is NOT touched/widened. Per-channel signed sine emission on the ASIO path
  is being investigated read-first before any build; if it needs compiled changes that is reported + stopped.
- **Break #2 → resolved, not a blocker; scale question closed.** Operator: *"I have my tools, they are working
  and do satisfy me. I don't need the calibration, I need just relative signal amplitudes across channels."* →
  this IS D6/D7: output the **relative inter-channel amplitudes WITH SIGN, per mode**, max-normalized (D7);
  absolute per-mode scale stays a non-goal; **do NOT build a scale owner.**
- **Carried FE defect (required in M7, not blocking the drive path):** FE `scaleMembersProportional`
  (`matrixAggregate.js:34,39,42`) clamps members `Math.max(0, v*factor)` → touching that control silently zeros
  negative coefficients. Relative amplitudes are meaningless without their relative signs (actuators either side
  of a nodal line must add, not cancel). M7 must fix this clamp to preserve sign.

### Original break analysis (retained for context)

**BREAK #1 — M2 device path cannot do per-actuator drive (needs compiled C++, out of scope).** The existing
`sdl_audio_core` binding forces `config.output_channels = 1` (`src/python_bindings.cpp:431`,
"Keep output mono for now" `audio_engine.h:60`) and `handle_playback_output` (`audio_engine.cpp:1015-1018`)
duplicates ONE mono sample to every physical output channel. A signed drive vector `[+1,−1,+0.5,…]` — the
entire basis of Ring-1 — is **unrepresentable**. Multichannel RECORD works; multichannel signed DRIVE does not.
AP1/M2's "composes `sdl_audio_core` multichannel emit" **overstated the existing capability** (the grounding
review flagged single-mono-output as `[SRC]` NEW, but the module plan assumed the emit existed). Fixing M2
requires editing compiled `python_bindings.cpp` + `audio_engine.cpp/.h` and a rebuild — **violating the
no-compiled-code boundary.** ⇒ the live loop (M1 orchestrator, M8 coord, M6 REST, M7 FE) was NOT built on an
unproven/broken drive path, per the M2 STOP instruction.

**BREAK #2 — M5's persistence contract (D7) is unsafe; no tool owns the scale (operator must resolve).** Task-0
verification: the claim "other tools own the per-mode scale" is FALSE. `PresetConfig.sound_max`
(`preset_injector.py:57-58,479-486`) is a build-time GLOBAL downscale-clip using `.max()` (assumes non-negative);
`calibrate_output_scale` (`pianoid.py:935-974`) is a global peak→dBFS scalar that never touches coefficients;
the middleware writers pass RAW magnitudes (live readbacks ~430). The **only** live per-mode scale UI —
FE `scaleMembersProportional` (`matrixAggregate.js:34,39,42`) — **clamps every member to ≥0**, so it would
**silently zero the negative (sign) coefficients D7 deliberately preserves.** The store/kernel accept sign, but
the operator-facing scale tool does not. ⇒ M5's max-normalized-signed-[-1,1] contract cannot be justified from
the code; **only the operator can rule** (options: persist raw signed magnitudes, or fix the FE clamp, or a
dedicated per-mode scale owner). M4 therefore returns BOTH the raw ray and the normalized row so the decision
stays open.

**ALSO SURFACED — M7 pane disabled in the live regime.** `SoundChannelsPane.jsx:121-148` renders a disabled
"editor unavailable" placeholder when `listen_to_modes=true` (the regime **every** shipped preset runs). The
FE calibrate control's host surface needs regime handling that the proposal did not anticipate.

**NOT YET BUILT (unblocked by the operator resolution; gated only on the ASIO feasibility read):** M2 (drive
path — now the ASIO output path), M1 (loop orchestrator), M5 (live max-normalized write — D7 stands, no ruling
needed), M6 (5001 REST), M7 (FE control + the clamp fix + the `listen_to_modes` regime gate), M8 (live
pause/measure/resume coord). Substrate mapped (write path `parameter_manager.py:948-954`; pause/resume
`backendServer.py:3247-3268` + `collection_engine.py:756-792`; blueprint reg `routes/__init__.py:139-147`; 5001
FE seam via a new `MODAL_ADAPTER_URL` const) and recorded in the session log. **M2 proceeds only after the ASIO
per-channel-signed-sine feasibility is confirmed by reading — no build on an unverified device path.**

---

## PART 0 — Foundations

### 1. Purpose

Give the operator a closed-loop bench procedure that, for a chosen mode, drives the physical actuators and
solves for that mode's **relative inter-channel coefficients** — the per-channel gains and signs that make
the instrument produce **maximum acoustic loudness at the mode's frequency per unit of total drive effort
(aggregate RMS)**. This replaces today's inter-channel coefficients, which are FFT-measured and written
without this optimization — the operator's "not balanced properly" complaint, which means the balance
**between the channels within a mode**, NOT pitch-to-pitch loudness across modes (D6; see the seed's
retraction-chain correction). The matched filter solves exactly that inter-channel problem. Verified on the
live-mic surface with measured before/after loudness-per-drive-RMS.

**Scope boundary (v1).** v1 calibrates the LIVE modes-mode store `mode_sound_channels.coefficients`
(`[pitch][channel]`; the object every shipped preset actually runs — measured, `listen_to_modes=True`),
writing per-channel **amplitude with polarity (±)**. It touches **no compiled engine code** (D1). **The
per-mode absolute scale is a stated NON-GOAL** — owned by other tools (D6); this feature outputs each mode's
row **up to a scalar** (persisted max-normalized, D7).

### Decisions (locked with the operator)

| # | Decision | Basis |
|---|---|---|
| **D1** | **Phase: v1 = gain-and-sign; continuous phase DEFERRED.** v1 optimizes per-channel amplitude + polarity (±180°) only, written into the existing `mode_sound_channels` real field. Continuous phase is a NAMED future effort, not an omission. | Operator: "Gain and sign is ok." Physics: for a lightly-damped mode with a real mode shape the per-emitter transfer is real-valued, so sign (which side of the nodal line each actuator sits on) is the COMPLETE answer; continuous phase is physically required only under heavy/non-proportional damping or frequency-dependent actuator phase lag. **Consequence:** NO compiled-engine change (no preset-schema / no `SoundChannels`/`preset_injector` model / no CUDA-kernel change). **Falsifiable (loudness-only, measured by the loop itself):** in the pairwise sign pass, a comparison whose two drives tie within noise means the relative sign is indeterminate (`cosΔθ≈0`) — the mode's phase is not at 0°/180°, so gain-and-sign is insufficient for that mode. `cosΔθ_ij=(|h_i+h_j|²−|h_i−h_j|²)/(4|h_i||h_j|)` quantifies it from measurements already taken. NO absolute phase reference is used (the mic yields loudness only). |
| **D2** | **Ring 1 measurement procedure LOCKED — loudness-only, pairwise-against-reference, `3N−1` measurements/mode** (`N` magnitude + `2(N−1)` sign + 1 confirmation; N=4→11, N=16→47). Solve `x_i=s_i·|h_i|` (matched filter). | Mic yields loudness only (no absolute phase); drives synchronized (one output buffer) so relative ± is exact; signs by `N−1` pairwise comparisons vs the largest-`|h_i|` reference (re-chosen per mode) — operator's simplification, linear not exponential (enumeration `2^(N−1)`=32,768 at N=16 → REJECTED). Verified independently. **Unconditional after D3** (aggregate ℓ2 RMS → matched filter is the true optimum). |
| **D3** | **RMS scope = AGGREGATE ℓ2 across channels → matched filter is optimal.** The drive-effort denominator is `‖x‖` (aggregate), not a per-channel bound. "Max loudness at the SAME RMS" = "max loudness per unit RMS" — the SAME scale-invariant optimization `|h·x|/‖x‖`, not two. | Operator: *"RMS is aggregate across actuators … maximum loudness with the same RMS, aggregated across all output channels."* **Consequence (sanctioned + risked):** no per-channel term ⇒ the matched filter drives strongly-coupled actuators hard while others idle — sanctioned, but voice coils have excursion/thermal limits → Ring 3 surfaces a **playback-time** per-channel clip (NOT an optimization constraint; his later call). |
| **D4** | **Mapping 1:1; `N` actuators ↔ `N` channels; `N` is a DESIGN PARAMETER ≤ 16.** The measured `N=4` is the Belarus preset's value, not a system constant — all counts are parameterized by `N`. `N` solved drives write straight into the mode's `N` `mode_sound_channels` coefficients (no projection). | Operator: *"each output channel maps to exactly one physical actuator … can be up to 16 … both channels and actuators."* **Seam:** the "emitter" entity is not in the data model; v1 **identifies emitter ≡ output channel** (no new construct; names the physical referent "actuator") — recorded, to be stated in Modules. **Scaling risk:** `num_modes+N ≤ num_strings` is UNENFORCED (comment + padding only); N=16 leaves headroom 12 on Belarus (196+16≤224) — a runtime assertion is warranted (Ring 3 / cross-cutting). |
| **D5** | **Measurement mic EXISTS; absolute SPL calibration is a NON-REQUIREMENT.** The sense chain must be **linear, fixed-gain (per mode's pass), fixed-position (per mode)** — not calibrated. | Operator: *"Yes, the mic is connected."* A constant mic scale `α` cancels in `x_i=s_i·|h_i|` and leaves `sign(4Re(h_ref h̄_i))` unchanged, so absolute calibration is unneeded — do not block on procuring a reference mic. **New assumption surfaced:** sense-side linearity (no AGC/compression/clipping) is a SECOND linearity requirement, DISTINCT from the actuator-side superposition gate → Ring 3 joint 6 dB check. |
| **D6** | **Per-mode normalization / cross-mode balance OUT OF SCOPE; scale is a stated NON-GOAL.** The feature outputs relative inter-channel coefficients per mode (a row up to a scalar); other tools own the row scale. Measurement drive level chosen for **comfort** (good mic SNR, no clipping) = the same operating point that keeps actuators + sense chain **linear**. Linearity is **assumed, not gated** — checked and recorded, revisited if unsatisfactory. | Operator: *"overall scale is not critical … other tools to correct this scale. This tool has to output the relative coefficients interchannels for each mode … absolute scale should be comfortable … no clipping … recordable by the mic."* + *"assume for now that the function is linear … check the result … revisit."* **Corrects a misreading:** "not balanced properly" = inter-channel within a mode, not pitch-to-pitch (retraction chain). **Justification for assume-and-revisit:** every falsifier is already in the data (parallelogram residual ⇒ superposition failure; sign tie ⇒ phase; 6 dB ⇒ compression). |
| **D7** | **Persistence convention = MAX-NORMALIZED** (`max_i|x_i|=1`, coefficients in `[-1,1]`). *(Orchestrator default under delegated authority — not the operator's ruling.)* | Most legible in the matrix; matches existing `sound_max` clip semantics; since the row's absolute scale is meaningless downstream (D6), normalizing to the peak discards nothing. Operator: *"proceed to implementation if you don't have any other questions."* |
| **D8** | **Ring 2 (many-modes sweep) DEFERRED — MVP calibrates ONE mode at a time.** *(Orchestrator default under delegated authority — the customer-facing defer choice the method requires.)* | A 196-mode N=16 sweep = `3N−1`=47 × 196 ≈ 9,200 measurements, order-of-hours; batch orchestration is designed AFTER the single-mode loop is run + observed. Building the sweep first optimizes a procedure nobody has used. |
| **D9** | **Optional per-mode `‖h‖` export OFF by default.** Flag-gated on an explicit "mic fixed across the whole sweep" assertion. *(Orchestrator default under delegated authority.)* | Free from the magnitude pass (`‖h‖=√Σ|h_i|²`) and useful to the downstream scale-owning tools — but cross-mode-comparable only if the per-mode mic scale `α` is common (mic fixed across modes). Operator has NOT asserted a fixed mic → default off. |

### 2. Flow — THE center (INTERACTIVE → user flow)

Notation: `N` = `num_channels` = number of actuators (a DESIGN PARAMETER, `N ≤ 16` — D4; the current Belarus
preset has `N=4`). `h_i` = actuator `i`'s acoustic transfer to the mode at frequency ω (real in the v1
regime, D1); `x_i` = that channel's drive (signed amplitude). The mic yields **loudness only** — no absolute
phase; the `N` drives share **one synchronized output buffer**, so relative polarity (`±1`) is exact while
absolute (global) polarity is physically meaningless. **No count below is hardcoded to 4.**

#### Ring 1 — MVP: calibrate ONE mode (LOCKED — D2)

Per target mode, at its frequency ω, the operator runs one closed pass:
1. **Pick the target mode** → read its frequency ω.
2. **Magnitude pass — `N` measurements.** Drive each actuator alone at unit amplitude; narrowband (Goertzel /
   lock-in) mic level at ω = `|h_i|`. Preconditions verified from modal data: settle past the resonant
   build-up `τ = 2Q/ω`; integrate `T > 1/Δf` (`Δf` = nearest-neighbour modal spacing) so no neighbour leaks
   into the bin. *(Multiplexing the `N` measurements does not help — the loudness detector is a coherent
   square-law, so a Hadamard multiplex cannot be linearly inverted; see the seed.)*
3. **Reference pick — `argmax_i |h_i|`, RE-CHOSEN PER MODE (a requirement, CP11).** The sign discriminant is
   `4|h_ref||h_i|`; a reference near a nodal line (`|h_ref|≈0`) poisons EVERY comparison, and which actuators
   are nodal is mode-dependent. At larger `N` more actuators sit near nodes per mode, so this is structural.
4. **Sign pass — `N−1` comparisons × 2 drives = `2(N−1)` measurements.** For each non-reference actuator `i`,
   drive `(ref,i)=(+1,+1)` then `(+1,−1)` and measure loudness; the difference `= 4·Re(h_ref h̄_i)`, whose
   sign is `s_i`. Two drives, not one — the common `|h_ref|²+|h_i|²` cancels, so the sign needs no calibrated
   magnitude. **Near-node rule (CP11):** actuators with `|h_i|` below the noise floor get coefficient **0**
   and their sign comparison is SKIPPED — their sign is indeterminate but `x_i≈0` makes it irrelevant (this
   makes `3N−1` an upper bound).
5. **Solve → the row DIRECTION** `x_i ∝ s_i·|h_i|` (matched filter; `s_ref=+1`). This fixes the *relative*
   gains and signs but NOT the row's overall scale — the objective is scale-invariant in `x`, so the solution
   is a proportionality, not an equality. **The per-mode scale is a stated NON-GOAL (D6, CP13)** — owned by
   other tools; the row is persisted max-normalized (D7). **Confirmation — 1 measurement:** drive the winning
   direction, measure loudness; it validates only that the DIRECTION is right (louder than sign/amplitude
   alternatives at equal drive RMS) — it says nothing about the row's scale. A low result is a **recorded**
   superposition residual (non-blocking, D6), not a gate.
6. **Review & persist.** Operator sees the solved gains/signs and before/after loudness-per-drive-RMS, and
   confirms before the write (max-normalized, D7) into that mode's `mode_sound_channels` row.

**Total: `3N − 1` loudness measurements per mode** (N=4 → 11, N=16 → 47; upper bound — near-node actuators
skipped). Because the sign pass holds amplitudes fixed at `|h_i|`, total drive RMS is constant within it, so
the loudest pattern is the max loudness-per-RMS directly (D3: RMS is aggregate ℓ2).

**Drive level (D6, CP12).** Pick the absolute drive amplitude for **measurement comfort** — loud enough for
good mic SNR at ω, quiet enough that nothing clips. This is the **same operating point** that keeps both the
actuators and the sense chain in their linear regime: the comfort criterion and the linearity assumption
select the same level. (The measurement drive level is distinct from the stored coefficient convention, D7.)
**Linearity is assumed, not gated** — the parallelogram residual and the 6 dB check are computed and recorded
every run (Ring 3), never block it.

#### Ring 2 — branch: many modes (DEFERRED — D8)

Repeat Ring 1 across a set/sweep of modes. **Deferred to a second stage (D8):** a full sweep costs `(3N−1)` ×
(modes) — e.g. a 196-mode sweep at `N=16` ≈ **9,200 measurements**, each needing settle (`τ=2Q/ω`) +
integration → **order-of-hours**. Batch orchestration is designed AFTER the single-mode loop is run and
observed. **Cross-mode balance is NOT part of this branch** — the per-mode absolute scale is a non-goal
owned by other tools (D6); each mode's row is an independent matched filter. The only Ring-2 concern is
batching/sweeping the MVP loop, plus the optional per-mode `‖h‖` export (D9) when the mic is held fixed
across the sweep.

#### Ring 3 — robustness (agent-led)

- **Superposition — RECORDED CHECK, not a gate (D6).** The `±` pair drives make the phase-free
  **parallelogram-law** check `|h_ref+h_i|²+|h_ref−h_i|² = 2(|h_ref|²+|h_i|²)` free per reference-pair;
  compute it and the confirmation-drive residual every run, **surface them, do NOT block**. A **continuous
  derivative-free search** fallback (evaluates the measured objective directly) is triggered by an *observed*
  residual, not by a precondition. *(Justification: assume-and-revisit is safe because every falsifier is
  already in the data — this residual ⇒ superposition failure; a sign tie ⇒ phase content; the 6 dB check ⇒
  compression. The run produces its own evidence about which assumption broke.)*
- **Joint linearity check (actuator + sense side) — recorded, non-blocking:** measure `|h_i|` at two drive
  levels 6 dB apart; confirm the *measured* level scales by 6 dB. Tests actuator-side superposition AND
  mic-chain linearity at once; on failure the side is ambiguous → disambiguate by re-running at a lower
  absolute level (if it linearizes, the input stage was clipping).
- **Per-channel excursion/thermal limit (D3 safety item, surfaced for operator decision):** the aggregate-RMS
  objective has NO per-channel term, so the matched filter can drive one actuator hard while others idle — at
  larger `N` the strong/weak coupling disparity grows. Voice coils have individual excursion + thermal limits
  → a **playback-time** per-channel clip/limit the calibration must respect, even though it does NOT enter the
  optimization. Surfaced, not silently added. (Cross-mode headroom during simultaneous playback is a SCALE
  question owned by the downstream scale tools, D6 — not this feature.)
- **Optional per-mode `‖h‖` export (D9), default OFF:** free from the magnitude pass; emitted only when the
  mic is held fixed across the whole sweep (a flag the operator sets), giving the downstream scale-owning
  tools their per-mode relative-loudness input at zero extra measurement cost. Absent/meaningless if the mic
  moves per mode.
- **Direction-only verification (into cross-cutting Verification):** the Ring-1 confirmation drive validates
  the row's DIRECTION only, never its scale (a stated non-goal, D6/CP13). The calibration's inter-channel
  effect is verified on its own surface (live-mic loudness-per-drive-RMS before/after).
- **Mode-slot headroom assertion (D4 scaling risk):** `num_modes + N ≤ num_strings` is UNENFORCED at runtime
  (comment + structural padding only); N=16 leaves headroom 12 on Belarus (196+16≤224). A runtime assertion
  is warranted before scaling `N`.
- **h-drift iteration:** `h` depends on drive level and voice-coil heating (calibration-`h` ≠
  performance-`h`), so re-measure + re-solve across a few rounds — iterating the ESTIMATE of `h`, not a
  continuous search.
- **Phase falsifier (D1):** a sign comparison tying within noise ⇒ that mode needs continuous phase; the
  optional closing-triangle transitivity check independently detects it.
- **Live-engine safety:** never trigger an offline render inside a live realtime+ASIO backend (0xC0000006);
  never instantiate `Pianoid` twice; own the device via the sanctioned pause→emit→measure→resume path.

#### What the measurement mic MUST and MUST NOT be (D5)

The mic is **connected** (D5), and that is enough — **absolute SPL calibration is NOT required** and the
proposal must not demand it: the objective is a ratio and a constant mic scale cancels out of both
`x_i=s_i·|h_i|` and the sign discriminant. What the sense chain MUST satisfy, per mode:
- **Linear** across the driven range — no AGC, compressor, limiter, or clipping (a SECOND linearity
  requirement, on the sense side, distinct from the actuator-side superposition gate).
- **Fixed gain** for the mode's pass (relative `|h_i|` depend on it; signs are gain-invariant).
- **Fixed position** for the mode's pass (moving the mic changes `h`); it MAY move between modes.
- **Adequate SNR at ω** after integration; weakly-coupled actuators integrate longer or are zeroed (CP11).

*Cross-mode caveat (D5 × D9):* the per-mode mic scale `α` cancels WITHIN a mode (direction is `α`-invariant,
so the mic may move between modes and the calibration is unaffected) but NOT across modes. The **optional**
per-mode `‖h‖` export (D9, default OFF) is meaningful only when the mic is held fixed across the whole sweep;
the core calibration never depends on it.

### 3. Core principles (DERIVED from the flow)

| ID | Principle | traces-to |
|---|---|---|
| **CP1** | **Loudness-only measurability.** Every quantity the objective needs is obtained from mic LOUDNESS alone; no step may require an absolute phase `arg(h_i)` — the rig cannot measure it. | Flow Ring 1 §2,§4; D1 |
| **CP2** | **Synchronized relative drive is the only phase freedom.** The shared output buffer makes relative polarity (`±`) exact; absolute/global sign is physically meaningless and never claimed. | Ring 1 §4–§5; D1 |
| **CP3** | **Choose by the measured objective, minimally.** The optimum is picked from actual measured loudness (at fixed RMS), via the smallest procedure that lands on it (`N−1` pairwise comparisons + 1 confirmation), not by trusting an unverified model. | Ring 1 §4–§5 |
| **CP4** | **Modal observability before trust.** A level at ω represents the target mode only when steady state is reached (`τ=2Q/ω`) and the window resolves neighbours (`T>1/Δf`); verify from modal data first. | Ring 1 §2 |
| **CP5** | **Per-mode independence; cross-mode scale is out of scope.** Each mode owns its coefficient row and is calibrated independently; the per-mode absolute scale (and thus any cross-mode/pitch-to-pitch balance) is a stated NON-GOAL owned by other tools (D6). This feature never couples modes. | Ring 1 §5; D6 |
| **CP6** | **Assume-and-revisit: record checks, don't gate.** Superposition and linearity are ASSUMED; their falsifiers (parallelogram residual, 6 dB check) are computed and recorded every run but never block it. A continuous-search fallback triggers on an *observed* residual. Safe because every falsifier is already in the data. | Ring 3; D6 |
| **CP7** | **Drift-aware, not one-shot.** `h` is non-stationary (drive-level + thermal); a calibration is a re-measurable estimate re-solved across rounds. | Ring 3 |
| **CP8** | **The deferral is self-documenting.** The same `3N−1` measurements that solve the mode also quantify the cost of the deferred continuous-phase capability (tie-within-noise / `cosΔθ`), keeping D1 honest and revisitable. | Ring 3; D1 |
| **CP9** | **Live-engine safety (inherited baseline).** No offline render in a live realtime+ASIO backend; no double `Pianoid`; device owned via pause→emit→measure→resume. *(Referenced from grounding, not re-derived.)* | Purpose; cross-cutting |
| **CP10** | **Review before persist (user control).** The operator sees solved gains/signs + before/after loudness-per-RMS and confirms before any write to `mode_sound_channels`. | Ring 1 §6 |
| **CP11** | **Reference on the strongest coupler; zero the near-nodes.** Sign resolution needs `ref = argmax_i|h_i|` per mode (the discriminant `4|h_ref||h_i|` collapses at a nodal reference), and actuators below the noise floor take coefficient 0 with their sign skipped (`x_i≈0` makes the sign moot). Structural at larger `N`, where more actuators sit near nodes per mode. | Ring 1 §3–§4; D4 |
| **CP12** | **Measurement-chain integrity, not absolute calibration.** The sense chain must be linear, fixed-gain, and fixed-position per mode; absolute SPL calibration is explicitly NOT required (it cancels in the ratio). Sense-side linearity is a first-class assumption, gated jointly with the actuator side. | Ring 1 §2,§4; D5 |
| **CP13** | **The contract: calibration outputs a DIRECTION; the SCALE is a deliberate non-goal.** The matched filter fixes which actuator combination drives a mode most efficiently (relative gains+signs) and leaves the row magnitude free — mathematically, the solution is a ray `x∝h`. This is the CONTRACT, not a gap: the per-mode scale is meaningless downstream and owned by other tools (D6). A reader must NOT expect this feature to balance pitch-to-pitch loudness. | Ring 1 §5; Purpose; D6 |

### 4. Decision hierarchy

**(a) Functional conflicts → ring ordering.** MVP-core (Ring 1) > branch (Ring 2) > robustness (Ring 3). A
single-mode calibration that produces the correct inter-channel direction wins over sweep throughput and over
up-front hardening.

**(b) Trade-off axes — elicited from the operator's decisions, not guessed:**

| Rank | Axis chosen over | Evidence |
|---|---|---|
| 1 | **Correctness of the per-mode inter-channel direction** — the core deliverable — over everything | the whole Purpose; D2/D3 |
| 2 | **Minimal surface / no compiled-engine change** over feature completeness | D1 (phase deferred), D6 (cross-mode scale out) |
| 3 | **Get a usable result now (assume-and-revisit)** over up-front robustness (blocking gates) | D6: "assume linear … check … revisit" |
| 4 | **Deliver the MVP loop first** over measurement throughput | D8 (sweep deferred); order-of-hours accepted |

Nothing here is dogma: a later operator correction flows UP and re-traces (the skill's rule; already
exercised — the D6 scope narrowing re-traced Purpose, CP5/CP6/CP13, Ring 2/3).

### 5. Architectural principles

| ID | Principle | traces-to |
|---|---|---|
| **AP1** | **Compose, don't invent.** Build by composing existing pieces (`measurement/`, `preset_injector`, `live_processing_orchestrator`, `sdl_audio_core`); the only genuinely new code is the per-actuator phased drive, continuous-tone emission, and the narrowband detector. | Purpose; CP1,CP3; trade-off 2 |
| **AP2** | **No-compiled-engine boundary.** v1 writes real floats into the existing `mode_sound_channels` field via the existing injector/apply path — no preset-schema, middleware-model, or CUDA-kernel change. | D1; trade-off 2 |
| **AP3** | **Facade frozen; land in a new service module.** `modal_adapter.py` (1755 LOC) is not extended; the loop lives in `sound_channel_calibrator.py`. | grounding; maintainability |
| **AP4** | **Device-owning, loudness-only measurement.** Own the audio device via the sanctioned pause→emit→measure→resume; never offline-render in a live realtime+ASIO backend; never double-instantiate `Pianoid`. | CP1,CP9 |
| **AP5** | **Assume-and-revisit robustness.** Checks are computed and recorded, never gate the run; the continuous-search fallback triggers on an observed residual. | CP6; D6; trade-off 3 |
| **AP6** | **Parameterized by `N ≤ 16`; emitter ≡ output channel.** Nothing hardcodes 4; no new data-model entity. | D4 |
| **AP7** | **Own the 5000/5001 cross-layer seam explicitly.** Emit on the engine (5000); the calibrator runs on the modal-adapter Flask server (5001) reaching the engine via `role=='main'` (pause/apply); the FE calibrate control deliberately crosses from the 5000 pane to the 5001 service. | grounding cross-layer; CP10 |

### 6. Overall architecture + internal flows

**Layers / actors:** (i) **Frontend** — `SoundChannelsPane.jsx` (today 5000-only) + a new calibrate control;
(ii) **Modal-Adapter Flask server (5001)** — hosts `sound_channel_calibrator.py`; (iii) **Engine backend
(5000)** — owns the drive path, model state, and the `mode_sound_channels` write; (iv) **Measurement
substrate** — `sdl_audio_core` (multichannel emit + record) + `recorder.py` (tone gen) + Goertzel/FFT/RMS.

**Internal flows (each maps onto a Ring-1 step — completeness both ways):**

| ID | Internal flow | realizes | traces-to |
|---|---|---|---|
| **FD1** | FE selects a mode → calibrator reads its frequency ω from engine/preset | Ring 1 §1 | CP4 |
| **FD2** | calibrator → per-actuator unit drive (one at a time) → mic capture → narrowband `|h_i|` | Ring 1 §2 | CP1,CP4; M2,M3 |
| **FD3** | calibrator → `±` pair drives vs `argmax|h_i|` reference → loudness → sign `s_i`; near-node zeroing | Ring 1 §3–§4 | CP2,CP11; M2,M4 |
| **FD4** | solve `x_i=s_i·|h_i|` → max-normalize → confirmation drive → record parallelogram/6 dB residuals + `cosΔθ` | Ring 1 §5; Ring 3 | CP3,CP6,CP13,D7; M4 |
| **FD5** | FE review (gains/signs + before/after loudness-per-RMS) → on confirm, write max-normalized row via injector/apply (`role=='main'`) | Ring 1 §6 | CP10,D7; M5,M7 |

**MVP as pluggable scaffolding.** The single-mode loop (FD1–FD5) is the backbone; the seams left for later
rings without tearing it apart: **Ring 2** iterates FD1–FD5 over a mode list (+ the optional `‖h‖` export);
**Ring 3** swaps FD4's analytic solve for a continuous search when a residual is observed. Minimal in what it
does now, but the sockets are left.

### 7. Classification

No new work-kind taxonomy is required. The only categorization the design needs — the four measurement
primitives (magnitude / sign / confirmation / linearity-check) and the two effect-classes (direction vs the
out-of-scope scale) — is already captured in the flow and enumerated in M2–M4. *(Conditional section: not
invented to fill space.)*

### 8. Modules — the implementation plan

> **Scope/risk boundary (top of Modules).** v1 touches **NO compiled code** (AP2): gain-and-sign writes real
> floats into the existing `mode_sound_channels` field — no preset-schema, middleware-model, or CUDA-kernel
> change. `modal_adapter.py` is FROZEN (AP3). **The real gap is the DRIVE PATH** (M2), today single-mono.
> Everything else is composition of existing pieces. `N ≤ 16`, parameterized — nothing hardcodes 4. **Emitter
> ≡ output channel** in v1 (D4): no new data-model entity; the physical referent is named "actuator".

| ID | Module | Responsibility + key behavior | Composes (existing) / NEW | traces-to |
|---|---|---|---|---|
| **M1** | `sound_channel_calibrator.py` (NEW service) | Orchestrate the Ring-1 loop for one mode: FD1→FD5. Owns sequencing, residual recording, review handoff. | composes `measurement/` + `preset_injector` + `live_processing_orchestrator`; NEW file (facade frozen) | Purpose; AP1,AP3; Ring 1 |
| **M2** | Per-actuator phased drive (**the gap**) | Drive `N` channels independently with a signed amplitude vector, continuous tone at ω. | composes `sdl_audio_core` multichannel emit + `recorder.py` tone gen; **NEW:** per-channel amplitude/sign vector + continuous (not burst) emission | CP2; D2,D4; AP6 |
| **M3** | Narrowband magnitude detector | `|h_i|` at ω via Goertzel/lock-in with settle (`τ=2Q/ω`) + integration (`T>1/Δf`) precondition checks from modal data. | composes `signal_processor`/`mic_testing` Goertzel/FFT/RMS; **NEW:** single-bin lock-in wrapper + modal-observability preconditions | CP4; Ring 1 §2 |
| **M4** | Matched-filter solver (pure numpy, no device) | ref=`argmax|h_i|`; signs via `4Re(h_ref h̄_i)`; near-node zeroing; `x_i=s_i|h_i|`; **max-normalize (D7)**; residuals (parallelogram, 6 dB, `cosΔθ`). | **NEW** (small); no device | D2,D7; CP3,CP11,CP13; CP6,CP8 |
| **M5** | Coefficient writer / persistence | Write the max-normalized row into `mode_sound_channels[pitch][*]` via the existing per-row set/apply path (`role=='main'`). NOT the summed-raw `preset_injector` bulk path. | composes `preset_injector`/`apply_service` per-row write | D7; CP10; AP2 |
| **M6** | REST endpoint(s) on 5001 | `POST /modal/calibrate_sound_channel` (`role=='main'`): run the loop for a mode, return solved row + residuals for review; separate confirm-persist call. | composes `modal_bp` Blueprint pattern; NEW route module | AP7; grounding REST |
| **M7** | Frontend calibrate control | "Calibrate this mode" in `SoundChannelsPane.jsx`; review UI (gains/signs + before/after loudness-per-RMS); confirm-to-persist. **Cross-layer seam:** the pane is 5000-only today → must call the 5001 modal-adapter. | NEW FE work on existing pane | CP10; AP7; grounding FE |
| **M8** | Live-processing coordination | pause→emit→measure→resume via `live_processing_orchestrator`; enforce the 0xC0000006 / no-double-`Pianoid` safety. | composes `live_processing_orchestrator` | CP9; AP4 |

**Deferred modules (carried, not dropped):** sweep orchestrator (Ring 2, D8); optional `‖h‖` export (D9);
continuous-search fallback (Ring 3, D6/CP6); per-channel playback clip (D3); `num_modes+N ≤ num_strings`
runtime assertion (D4).

### 9. Cross-cutting

- **Verification (surface per claim).** The inter-channel direction is verified on the **live-mic** surface:
  before/after **loudness-per-drive-RMS** at ω for the calibrated mode. The Ring-1 confirmation drive
  validates **direction only** (never scale — a non-goal, D6/CP13). Drive-RMS is computed offline from the
  emitted signals (no device). Residuals (parallelogram, 6 dB, `cosΔθ`) are recorded artifacts, not gates.
- **Safety (carried into implementation).** Never trigger `calibrate_output_scale`/`runOfflinePlayback` in a
  live realtime+ASIO backend (0xC0000006, unguarded on master); never instantiate `Pianoid` twice; device
  owned via pause→emit→measure→resume. *(AP4, CP9.)*
- **Data-model integrity.** Emitter ≡ output channel (same-name seam recorded, D4); all counts parameterized
  by `N ≤ 16`; `num_modes+N ≤ num_strings` assertion warranted (unenforced today).
- **Cross-layer.** The 5000 (engine) / 5001 (modal-adapter) split is owned by the `role=='main'` pattern
  (M6/M8); the FE seam is explicit work (M7). *(AP7.)*
- **Lifecycle.** This proposal is the DRAFT; on approval it governs the `/dev` implementation of M1–M8.

### 10. Traceability matrices

**Principle → (architectural principles + flow):**

| CP | Realized by | Flow |
|---|---|---|
| CP1 loudness-only | AP1,AP4 | Ring 1 §2,§4 |
| CP2 relative-drive/±-only | AP6 | Ring 1 §3–§5 |
| CP3 measured-objective/minimal | AP1 | Ring 1 §4–§5 |
| CP4 modal observability | — | Ring 1 §2 |
| CP5 per-mode indep / no cross-mode | AP6 | Ring 1 §5 |
| CP6 assume-and-revisit | AP5 | Ring 3 |
| CP7 drift-aware | AP5 | Ring 3 |
| CP8 self-documenting deferral | — | Ring 3 |
| CP9 live-engine safety | AP4 | cross-cutting |
| CP10 review-before-persist | AP7 | Ring 1 §6 |
| CP11 reference/near-node | AP6 | Ring 1 §3–§4 |
| CP12 measurement-chain integrity | AP4 | Ring 1 §2,§4 |
| CP13 direction-not-scale contract | AP2 | Ring 1 §5 |

**Element → (flow + principles + kind):**

| Element | Flow | Principles | Kind |
|---|---|---|---|
| M1 calibrator service | Ring 1 (all) | AP1,AP3 | MODULE |
| M2 phased drive | FD2,FD3 | CP2; AP6 | MODULE (new work) |
| M3 magnitude detector | FD2 | CP4 | MODULE |
| M4 matched-filter solver | FD4 | CP3,CP11,CP13,D7 | MODULE |
| M5 coefficient writer | FD5 | D7,CP10,AP2 | MODULE |
| M6 REST endpoint | FD1,FD5 | AP7 | STRUCTURE/interface |
| M7 FE calibrate control | FD1,FD5 | CP10,AP7 | MODULE |
| M8 live-processing coord | all | CP9,AP4 | CROSS-CUTTING |
| Verification | Ring 1 §5–§6 | CP13,D6 | CROSS-CUTTING |
| Sweep / ‖h‖ export / fallback / clip / assertion | Ring 2/3 | D8,D9,D6,D3,D4 | DEFERRED |

---

**Status:** PART 0 foundations + body complete. Decisions D1–D9 locked (D7–D9 orchestrator defaults under
delegated authority). Ready for Review/Approval → Active (governs the `/dev` implementation of M1–M8).
