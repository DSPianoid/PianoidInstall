# Pitch→String Mapping Trace — 55/56/57 per-pitch pattern (rev-0a12)

**Trigger:** user reports 3 CONSECUTIVE notes, consistent across both Belarus presets AND all paths:
55 correct / 56 does NOT decay on note-off / 57 clicks. Team-lead hypothesis: per-pitch
indexing/string-alignment bug. My task: independent READ-ONLY source + model trace of pitch→string.
**Method:** docs-first (DATA_FLOWS, PianoidBasic OVERVIEW) then loaded the StringMap DOMAIN MODEL
read-only (no GPU/audio/ports — does not touch the user's live stack).
**Diagnostic:** docs/development/diagnostics/dev-cfl-rev0a12-pitch-string-map.py + an inline physics dump.

## RESULT: the per-pitch INDEXING-BUG hypothesis is REFUTED by measurement.

Both the string-index MAPPING and the per-pitch PHYSICS are structurally REGULAR across 55/56/57 — no
anomaly, no boundary, no off-by-one, no count transition, no degenerate value at 56 or 57.

### Mapping (Belarus_8band_196modes, num_strings_in_array=4, array_size=512, 224 total strings):
| pitch | chore | stringIDs | cuda_idx (string_index pos) | block/posInBlock | chores[pitch] |
|---|---|---|---|---|---|
| 54 | 3 | [208,209,210] | [211,210,209] | 52/3,52/2,52/1 | [211,210,209] |
| 55 | 3 | [204,205,206] | [207,206,205] | 51/3,51/2,51/1 | [207,206,205] |
| 56 | 3 | [200,201,202] | [203,202,201] | 50/3,50/2,50/1 | [203,202,201] |
| 57 | 3 | [196,197,198] | [199,198,197] | 49/3,49/2,49/1 | [199,198,197] |
| 58 | 3 | [192,193,194] | [195,194,193] | 48/3,48/2,48/1 | [195,194,193] |
- All chore=3 (NO count transition across 55/56/57 — refutes the strings-per-note-boundary idea).
- Perfectly linear: block = 106 − pitch; each pitch owns positions 1/2/3 of its own 4-wide block
  (position 0 unused). stringIDs ascend by 1 within a pitch; chores[pitch] == cuda_idx (self-consistent).
- NO sentinel, NO block-boundary crossing, NO non-contiguity. The excitation index (chores row) and the
  damper index (same stringIDs → dec_open[stringID]) are the SAME — no excitation-vs-damper mismatch.

### Per-pitch physics (54-58) — also smooth, no anomaly at 56/57:
tension 718→709→670→662→662; rho descends smoothly; gamma 0.599→0.593→0.588→0.569→0.532;
damper_string 3.4e-5→3.5→3.6→3.7→3.8e-5 (smooth ASCEND); disp_decay ~3.16-3.20; coeff_T all ~0.003
(~300× under CFL edge); coeff_B all ~ -2e-4. 57's coeff_T (0.0035) ≈ 54's (0.0034). NO zero damper,
NO degenerate coeff, NO missing excitation. Nothing distinguishes 56 or 57 from 54/55/58 in the data.

## ⇒ IMPLICATION (redirects the hunt)
Since BOTH the index mapping AND the per-pitch physics are regular/identical-in-structure across the
three pitches, the deterministic per-pitch behavior (55 ok / 56 no-decay / 57 click) CANNOT originate in
the Python-side StringMap indexing or the per-pitch physics values. It must be either:
1. LIVE GPU per-string STATE at those CUDA indices (e.g. a stale/uninitialised dec_open or
   force_function at specific string_index positions, or kernel per-block-position handling — needs the
   live engine; I cannot read dec_open/state read-only, no pybind getter), OR
2. A TRIGGER/MEASUREMENT confound — "3 consecutive notes" may not map cleanly to 55/56/57 (the earlier
   per-pitch REST results were already shown unreliable). Consistency across presets/paths argues
   against pure confound, but the trigger device is still unconfirmed.

dev-cf-v2's LIVE readback is now the discriminator — at the EXACT CUDA string indices I mapped:
  pitch 55 → string_index [207,206,205]; 56 → [203,202,201]; 57 → [199,198,197].
After note-on+note-off on each, read per-string dec_open + the string state/force at those indices.
If 56's strings show dec_open=DUMP_OPEN (not closed) while 55's are closed → a per-string GPU damper
bug at specific indices (NOT the mapping). If 57's excited string shows a degenerate force/state → a
GPU per-string excitation issue. Both are live-only.

## STALE-DOC notes (for a later docs pass)
- PianoidBasic OVERVIEW / SYNTHESIS_ENGINE: "num_strings_in_array = 2" — this preset uses 4.
- (Prior) SYNTHESIS_ENGINE "addStringToBatch sets DUMP_OPEN unconditionally" — actually velocity-gated.

## STATIC PATH FULLY EXHAUSTED — indexing-bug REFUTED from BOTH ends + ALL data sources clear

DECK COUPLING + EXCITATION (read-only, added 2026-05-27) — also REGULAR across 54-58, no 56/57 anomaly:
| pitch | feedin nnz/len, max, L2 | feedback (same) | excitation base-levels L2 |
|---|---|---|---|
| 54 | 196/196, 1.0, 7.99 | =feedin | 1.03e9 |
| 55 | 196/196, 0.96, 5.88 | =feedin | 1.10e9 |
| 56 | 196/196, 1.0, 9.56 | =feedin | 1.40e9 |
| 57 | 196/196, 1.0, 8.90 | =feedin | 1.47e9 |
| 58 | 196/196, 1.0, 8.82 | =feedin | 1.56e9 |
- feedin/feedback FULLY DENSE (196/196), max~1.0 (normalized), L2 smooth. 56/57 if anything coupled
  SLIGHTLY STRONGER than 55 → would sustain MORE, not less. NO near-zero/degenerate coupling.
- Excitation smooth monotonic ascend (1.03→1.10→1.40→1.47→1.56e9). NO missing/zero excitation at 56/57.

dev-cf-v2 KERNEL trace (MainKernel.cu:171-249): uniform quarter/fold per-string structure, SAME for
every block — NO special-case branch on pitch / string index / block-position. Indexing bug refuted
from the kernel end too.

⇒ EVERY static per-pitch source is REGULAR across 55/56/57: index mapping, string physics, deck
coupling (feedin/feedback), excitation, AND the kernel computation. NOTHING static distinguishes 56 or
57 from their neighbours. The static path is EXHAUSTED — I cannot find a per-pitch distinguisher because
there isn't one in the static data/code.

## SYMPTOM RE-CHARACTERISATION (dev-cf-v2 reconciliation — important)
dev-cf-v2's prior "57 stops after note-off (1.3e-5)" is NOT contradictory with "57 clicks": a CLICK =
attack-then-NO-SUSTAIN (barely sounds) → ALSO low energy after note-off. The distinguishing measurement
is SUSTAIN **DURING** the note, NOT the after-note-off decay — which has NOT been cleanly measured
per-pitch. And 56 (the "stuck/no-decay" one) was NEVER individually tested (the note-off set was
62/57/40/88). So the symptom itself is not yet cleanly characterised at the backend.

## REMAINING DISCRIMINATOR (purely empirical, GPU-gated — neither of us can run it now)
Render 55/56/57 INDIVIDUALLY offline, measuring (i) DURING-note sustain and (ii) after-note-off decay,
each ALONE. Outcomes:
- 56 sustained-during + no-decay-after, 57 attack-then-no-during-sustain, ALONE → a REAL per-pitch
  effect that is NOT static (live GPU transient state / per-string init) → then trace GPU per-string
  state. (But static says there's no per-pitch code branch, so this would be surprising — more likely
  a uniform-but-state-dependent transient, e.g. block neighbour interaction.)
- 56/57 render NORMALLY alone (sustain+decay like 55) → the user's "3 consecutive" pattern is a
  TRIGGER/SEND/sequence artifact (consecutive-note timing, the device, or same-cycle event handling),
  NOT a per-pitch backend bug. Given the static path is clean, this is the more likely outcome.
GATED ON: team-lead freeing the GPU (user holds :5000; dev-cf-v2 stood down) + the user's trigger device.
NOTE: getStringStableFlags/getStringStabilityRatios are V1 device getters, ABSENT on the v2 binary
(v2 removed them); on v2 read stability host-side via /get_parameter/stability_ratio. Either needs a GPU.

## CONSECUTIVE-NOTE BATCHING ANGLE (fdf3dd2) — traced, ALSO sound for the likely play pattern

Re-read fdf3dd2 dispatchBatch + the per-cycle drain (OnlinePlaybackEngine.cu:219-278) + beginStringBatch
with the consecutive-note lens:
- Per-cycle drain: RT events drained up to `cycle`, scheduled appended, cap (256) drops from TAIL, then
  ONE dispatchBatch per cycle. Order preserved (RT first). dispatchBatch opens beginStringBatch iff any
  NOTE_ON/OFF/TEST present, dispatches staging-only, closes commitStringBatch. NOTE_OFF (vel=0) →
  dec_open[str]=DUMP_CLOSED, no staging append; NOTE_ON → _append_string_gp appends + noStrings_in_GP++.
  Staging arrays indexed by the running noStrings_in_GP → CONTIGUOUS, NO aliasing across pitches.
  beginStringBatch resets ONLY noStrings_in_GP (NOT dec_open — correct: held-note open damper persists).
- fdf3dd2 FIXED the real chord bug (old per-event commit dropped all-but-last). Its test covers 12-key
  chord, 2-key chord, AND "NOTE_ON+NOTE_OFF different-pitch same-cycle" + 300-event flood-vs-cap.

CRITICAL TIMING POINT: the user plays 55/56/57 as a DELIBERATE SEQUENCE (distinct presses/releases over
hundreds of ms). Each note's NOTE_ON and NOTE_OFF then land in DIFFERENT ~1.3ms cycles → SEPARATE batches
→ the per-cycle batching/envelope/cap CANNOT be the culprit for deliberately-played consecutive notes
(it only groups events within ONE 1.3ms cycle = a true simultaneous chord). Cap (256) irrelevant for 3
notes. ⇒ the consecutive-note BATCHING hypothesis is UNLIKELY for the deliberate-sequence pattern; the
one residual same-cycle hazard (a true chord, 56-off + 57-on in one cycle) is already covered by the
existing test's different-pitch same-cycle case + the contiguous staging indexing.

⇒ UPDATED PICTURE: mapping, physics, deck, excitation, kernel-uniformity, AND batching/drain are ALL
sound. The 55/56/57 pattern points AWAY from any backend mechanism, toward a TRIGGER/MEASUREMENT artifact
(esp. the already-found VirtualPiano handleMouseUp send-side bug, which IS sequence/pointer dependent) OR
a live-GPU transient — both needing the GPU-gated empirical render + the user's exact play pattern/device.

## NEXT
- Report: batching also sound for the deliberate-sequence case; static fully exhausted across ALL
  mechanisms. Decisive test remains the GPU-gated individual + sequence render + the user's trigger/timing.
  NO fix. Nothing more I can do read-only.