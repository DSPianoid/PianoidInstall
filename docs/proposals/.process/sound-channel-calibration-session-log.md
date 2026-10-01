# Session Log — compose-proposal: Output Sound-Channel Calibration

- **Agent:** compose-proposal author (READ-ONLY on all source; no build/stack/audio/render/commit)
- **Date:** 2026-07-10
- **Skill:** `/compose-proposal` (D:\repos\NoChairCode\skills\compose-proposal.md)
- **Outputs:** `docs/proposals/sound-channel-calibration-2026-07-10.md` (proposal),
  `docs/proposals/.process/sound-channel-calibration-seed.md` (seed), this log.

## Timeline

### 1. Grounding read
- Read `sound-channel-calibration-grounding-2026-07-10.md` and
  `sound-channel-regime-measurement-2026-07-10.md` in full. Loaded SendMessage tool schema.
- Verified no prior sound-channel proposal exists (`docs/proposals/` + `archive/` globbed).

### 2. Build mode + scaffolding
- Chose **Mode B (dialog-from-scratch)** — justified in seed (high-stakes data-model uncertainty around
  phase; emitter entity doesn't exist yet; novel closed-loop measurement; surface-split feasibility hinges
  on operator ground-truth). Wrote seed + this log.

### 3. First dialog turn
- SendMessage(main): build-mode choice + why, draft Purpose, ONE question = the phase decision. Then wait.

### 4. Phase decision returned → D1 logged
- Operator: "Gain and sign is ok." Logged Decision D1 in seed + proposal (rationale cost + physics +
  no-compiled-engine consequence + falsifiability observable). Scaffolded the proposal file (reading note,
  Purpose, Decisions table).
- Next: present Ring 1 MVP flow (the center) for approval; then queued questions one at a time
  (mapping -> mic/loopback -> RMS scope -> persistence -> per-mode-norm scope).

### 5. Ring 1 MVP flow presented
- SendMessage(main): six-step happy path for confirm/correct; 1:1 emitter↔channel carried as flagged
  next-question assumption. Waiting.

### 6. Coordinator's closed-form (matched-filter) claim — verified independently
- Worked the maths: objective = |h·x|/‖x‖ (Rayleigh quotient); Cauchy–Schwarz → x∝h̄ = matched filter,
  max ‖h‖. **CORRECT** under linearity + modal observability + ℓ2 drive-RMS + single loudness scalar.
- Recorded in seed "Technical basis" section + sharpened D1 falsifiability (dB-loss form, unified with the
  0/180 clustering criterion).
- ONE correction sent up: coordinator's "joint = one x for many h, needs collinearity" is inexact for the
  LIVE object `mode_sound_channels[pitch][channel]` (per-mode rows → each mode independent matched filter);
  the real joint question is cross-mode BUDGET/BALANCE = the per-mode-normalization seam.
- Replied to coordinator with evaluation + provisional Ring 1 restructure (measure-each-emitter-once →
  analytic solve; search demoted to Ring 3 fallback behind a linearity gate). NOT locking Ring 1 until
  operator answers.

### 7. LOUDNESS-ONLY retraction — coherent-phase capture removed
- Operator FOUNDATIONS fact: mic yields loudness only, no absolute phase (emitters unsynced to capture).
  Coherent `h_i` capture INVALID → retracted. D1 falsifiability → loudness-only form. Seed technical-basis
  updated with the loudness-only revision + my two precision refinements (real-h-exactness; parallelogram gate).

### 8. Pairwise-against-reference simplification — verified + Ring 1 LOCKED (D2)
- Operator simplified sign step: `N−1` pairwise comparisons vs largest-`|h_i|` reference (linear), not
  `2^(N−1)` enumeration (exponential). Verified independently: `4Re(h_ref h̄_i)` sign discriminant, two-drive
  cancellation, per-mode reference trap, confirmation drive, transitivity/closing-triangle check.
- Positive note sent up: this pairwise design makes the parallelogram-law superposition gate FREE per
  reference-pair (resolves my earlier "costs extra" caveat).
- **Locked Ring 1 (11 measurements/mode) as D2** in seed + proposal. Wrote proposal Flow section (Ring 1
  locked, Ring 2 defer-decision-pending, Ring 3 agent-led) + derived Core Principles CP1–CP10 (each traced).
  Updated D1 falsifiability to operational tie-within-noise form in proposal too.
- Next: SendMessage(main) — verification report + Ring 1-locked confirmation + resume queued questions with
  ONE: emitter↔channel mapping (Q3 RMS-scope already out; do not re-ask).

### 9. RMS scope + mapping answered → D3, D4 (then N-correction)
- Operator: RMS = aggregate ℓ2 → matched filter OPTIMAL, conditional flag LIFTED (D3, with the
  same-optimization equivalence note + the sanctioned-concentration + Ring-3 playback-clip safety item).
  Mapping 1:1 (D4). Recorded both with verbatim evidence; emitter≡channel representation choice logged.
- **N-correction:** operator followed up — `num_channels=N` is a DESIGN PARAMETER up to 16, actuators 1:1.
  Reparameterized everything: measurement count `3N−1` (N=4→11, N=16→47); enumeration `2^(N−1)`=32,768@16 →
  REJECTED; reference-selection elevated to requirement (CP11); num_modes+N≤num_strings unenforced (headroom
  12@N=16 Belarus) → Ring-3 assertion; budget ~9,200 measurements for a 196-mode N=16 sweep → Ring-2 input.
- **My two corrections sent up:** (a) near-node indeterminate-sign self-resolves — `x_i=s_i|h_i|≈0` so zero
  the coefficient + skip the comparison (makes 3N−1 an upper bound); (b) Hadamard multiplexing does NOT work
  under a coherent square-law (loudness) detector — can't linearly invert, per-channel recovery is
  combinatorial = the rejected search. Verified all coordinator arithmetic (3N−1, 2^(N−1), 212≤224, 9212).
- Wrote D3/D4 into proposal decisions table, reparameterized Flow to `N`, added Ring-3 items (excursion clip,
  slot-headroom assertion) + Ring-2 budget, added CP11. Updated seed D4 with the 8 N-consequences.
- Next: SendMessage(main) — N-correction verification + my 2 corrections + ONE question: calibrated-mic bench
  reality (ask about the MIC only; procedure needs NO loopback — do not request one).

### 10. Mic answered → D5 (mic connected; NOT calibrated)
- Operator: "Yes, the mic is connected." Foundations-breaking risk cleared.
- Verified coordinator's refinement: absolute SPL calibration is a NON-REQUIREMENT (constant scale α cancels
  in `x_i=s_i|h_i|` and in `sign(4Re(h_ref h̄_i))`). Requirement is LINEAR + FIXED-GAIN + FIXED-POSITION per
  mode. Sense-side linearity is a genuinely SECOND, distinct assumption (I'd only named the actuator side).
- Recorded D5 (seed + proposal decisions table); added proposal subsection "What the measurement mic MUST and
  MUST NOT be"; updated Ring-3 linearity check to the JOINT actuator+sense 6 dB form with the
  lower-level disambiguation; added CP12 (measurement-chain integrity, not absolute calibration).
- Next: SendMessage(main) — D5 confirmation + ONE question: per-mode normalization scope (unmerged; the
  concrete "not balanced properly" cause) — in this proposal or a prerequisite bugfix?
- Sent the normalization-scope question (out to operator now).

### 11. Direction-vs-scale decomposition — verified + folded in (holds regardless of scoping)
- Coordinator: matched filter sets DIRECTION not SCALE; loudness scatter ∝‖h‖ SURVIVES calibration →
  normalization is the complementary half, not an adjacent bug. Verified independently (scale-invariant ray;
  loudness=R‖h‖ at equal RMS).
- **My two refinements:** (1) 0–1 normalization is a scale CONVENTION vs true loudness-balance (measured
  per-mode scale) — name precisely; (2) **cross-mode mic-consistency seam (D5×CP13):** calibration measures
  per-mode ‖h‖ but only up to per-mode mic α, which cancels WITHIN a mode (mic may move between modes) but NOT
  across → feeding loudness-balance needs the mic fixed ACROSS modes; a 0–1 convention does not.
- Folded in regardless of the pending scoping answer: proposal Ring-1 step 5 now outputs a DIRECTION (row up
  to scalar; confirmation validates direction only); added CP13 (calibration=direction, normalization=scale);
  Ring-3 cross-mode-headroom tie + separately-observable Verification note; mic subsection cross-mode caveat.
  Seed "Direction-vs-scale decomposition" section added. Modules TODO: coefficient writer applies a per-mode
  SCALE, not `x_i=s_i|h_i|` as-is.
- Verification report sent to coordinator; NOT re-asking normalization scope (already out). Waiting on his reply.

### 12. Scope narrowing (D6) + delegated defaults (D7–D9) → BODY complete
- Operator (2 msgs): normalization OUT OF SCOPE (other tools own scale; outputs relative inter-channel
  coefficients per mode; absolute scale = comfort/no-clip); "assume linear, check, revisit." Then: "proceed to
  implementation if you don't have any other questions."
- **Corrected the misreading** ("not balanced properly" = INTER-CHANNEL within a mode, NOT pitch-to-pitch) —
  recorded in the retraction chain + a SUPERSEDED-framing banner on the direction-vs-scale section (not
  overwritten). Matched filter solves exactly his problem.
- **Re-traced upstream (corrections-flow-UP):** Purpose (inter-channel + scale non-goal); CP5 (cross-mode out
  of scope), CP6 (assume-and-revisit, not gate), CP13 (contract/non-goal); Ring 1 (comfort drive-level ≡
  linearity operating point; recorded-check not gate; max-normalized persist); Ring 2 (DEFERRED, D8); Ring 3
  (recorded checks, ‖h‖ export D9, direction-only verification).
- **Recorded D6 (scope), D7 (max-normalized persist), D8 (Ring 2 deferred), D9 (‖h‖ export off)** — D7–D9
  attributed to orchestrator-with-delegated-authority, NOT operator rulings.
- **Wrote the full BODY:** decision hierarchy (elicited trade-off ranking), AP1–AP7, architecture + internal
  flows FD1–FD5 (each mapped to a Ring-1 step), classification (none needed, justified), Modules M1–M8 (the
  implementation plan; emitter≡channel resolved; drive path = the real gap), cross-cutting (verification/safety/
  data-model/cross-layer), two traceability matrices. Updated header status.
- Proposal COMPLETE. Next: final report to coordinator (summary + ordered work-items + genuinely-unsettled),
  then STOP (no implement, no commit).
