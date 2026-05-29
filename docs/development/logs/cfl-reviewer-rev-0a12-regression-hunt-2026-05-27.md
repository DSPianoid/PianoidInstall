# Recent-Commit Regression Hunt — live re-test failures (rev-0a12)

**Date:** 2026-05-27. **Trigger:** v2 live re-test FAILED — (1) pitch 57 still clicks live,
(2) note-off broken (notes sustain forever, e.g. 62), (3) gate didn't catch a live tension raise.
**Task:** independent recent-commit regression hunt on PianoidCore; verify against actual diffs; NO fix.
**Coordination:** dev-cfl-v2 is doing the live 3-symptom repro + dev-vs-v2 A/B.

## Commit map
- v2 = `0d10675` [dev-cfl-v2], branched off dev at `9030237` (2026-05-24 22:33).
- v2 diff STAT: touches ONLY Python middleware + tests — backendServer.py(+32), cfl_stability.py(new),
  parameter_manager.py(+138), pianoid.py(+50), tests. **NO .cu/.cuh kernel change.** Pure-additive (1 del).

## FINDING 1 — v2 CANNOT be the note-off cause (verified against the diff)
- v2's only behavioural hook is `_raise_if_cfl_unstable(pitches, values)` called at the TOP of the
  `update_parameter` `'string'/'physics'` branch (parameter_manager.py). It is a PURE prospective
  computation (no mutation) that either returns or raises CflRejected. It does NOT touch note-on/off,
  the event drain, the damper, sustain, or update_pitch_physical_params_GRANULAR's body.
- backendServer.py v2 diff: adds a CflRejected errorhandler + WS error branch + 'stability_ratio' in
  parse_range + a re-raise in set_parameter. Touches NO note-on/off/playback route.
- ⇒ note-off (stuck notes) does NOT route through update_parameter('string',...); v2 is not in that path.
  The note-off regression is in DEV's recent history, not v2. (Matches the user's instinct.)

## FINDING 2 — the KERNEL note-off/damper path is INTACT (verified, NOT the bug)
Traced the full NOTE_OFF chain in the post-split code:
- EventDispatcher::handleNoteOff (EventDispatcher.cu:119) → stageStringsForPitch(pitch, vel=0).
- → addStringToBatch(stringNo, 0) (Pianoid_excitation.cu:178) → _add_string_for_playback(stringNo, 0).
- _add_string_for_playback (Pianoid_excitation.cu:27-36): velocity==0 → `dumper = DUMP_CLOSED` →
  `dec_open[stringNo] = DUMP_CLOSED`. CORRECT. (velocity>0 → DUMP_OPEN + _append_string_gp.) The split
  preserved this. NOTE: SYNTHESIS_ENGINE.md's claim that addStringToBatch "sets dec_open=DUMP_OPEN
  unconditionally" is STALE/WRONG — the code routes through the velocity-gated _add_string_for_playback.
- commitStringBatch (Pianoid_excitation.cu:203): noStrings_in_GP==0 for a NOTE_OFF (velocity=0 doesn't
  call _append_string_gp), so _load_exct_params_to_GPU() is skipped — BUT it sets `new_notes_ind = 0+1 = 1`.
- _load_exct_params_to_GPU (Pianoid_excitation.cu:108) uploads only gauss indices + excitation params —
  NOT dec_open. dec_open is uploaded at Pianoid_synthesis.cu:203 `loadParameterToPianoid("dev_dec_open",
  dec_open)` which is INSIDE `if (new_notes_ind > 0)` (line 199). Since the NOTE_OFF set new_notes_ind=1,
  the dec_open (damper-close) upload + parameterKernel DO run next cycle. ⇒ the damper-close reaches the GPU.
- CONCLUSION: with this code, a NOTE_OFF that is DISPATCHED correctly closes the damper. So the regression
  is NOT in the leaf damper logic. It is UPSTREAM: either NOTE_OFF events are not DISPATCHED/DRAINED, or
  not SENT by the frontend/middleware, or DROPPED by the per-cycle cap.

## PRIORITISED SUSPECTS (for dev-cfl-v2's A/B to discriminate)
Recent dev commits touching the note-lifecycle/event/playback path (post-, near-, or pre-v2-base):
1. **`fdf3dd2` [dev-midi-p1] kernel single-envelope batch + TEST_* envelope merge + MAX_EVENTS_PER_CYCLE
   cap** — TOP SUSPECT for note-off. Reworked dispatchBatch + the per-cycle drain + added an event cap.
   Mechanism: if the cap or the has_excitation/envelope-merge drops or fails to dispatch NOTE_OFF (or a
   NOTE_ON+NOTE_OFF same-cycle merge cancels the off), notes never get dec_open=DUMP_CLOSED → stuck.
   Touches EventDispatcher.cu (most recent change to it).
2. **Pianoid.cu split: `cdb9f4a` (synthesis), `6e74a66` (excitation), `006c8dd` (presets)** — moved
   note-on/excitation/sustain/synthesis out of the god object. Leaf damper logic verified intact, but
   the split could have altered the new_notes_ind plumbing or the engine drain wiring. Medium suspect.
3. **`589fbe6` C3 delete playSoundSamples/manageSoundBuffers/audioOn + the dev-cf56 dead-code series**
   (runSynthesisKernel rename, delete runOnlinePlayback wrapper, etc.) — aggressive playback-path
   deletions; a removed path the live note-off/engine loop needed. Medium.
4. **`448084b`/`9cee1b5` Tranche A revert/un-revert (M1+M7+M6+M12); M12 = back-pressure on
   RealTimeEventBuffer** — back-pressure that DROPS events under load could drop NOTE_OFF. There is prior
   regression history here (sound-regression bisect). Suspect for both note-off AND the live click.

## v2-SPECIFIC: the "gate didn't catch a live tension raise" symptom
This one IS plausibly v2 (it's the v2 gate). The gate fires only in update_parameter's 'string'/'physics'
branch. To verify with dev-cfl-v2: trace the LIVE tension-raise path — does the live REST/WS edit reach
`update_parameter('string', ...)`, or does it call update_pitch_physical_params_GRANULAR directly / use a
different `param` key (bypassing the gate)? Also: gate uses dec_curr=gamma*dt undamped baseline → that is
CONSERVATIVE for rejection (can't cause a MISS-to-instability), so a "didn't catch" is a wiring/path gap,
not a math gap. Candidate: the WS path (handle_ws_set_parameter) vs the REST path — confirm the WS path
actually routes through update_parameter and thus the gate.

## UPDATE — preset is Belarus_8band_196modes (MODAL-HEAVY, 196 modes). Re-prioritised.

Physics (SYNTHESIS_ENGINE.md): audio output = MODE FEEDBACK driving the sound strings. The damper
(dec_open/DUMP_CLOSED) affects the STRING decay; the soundboard MODES are persistent all-pitch-shared
oscillators that decay only via their own `mode_dec` coefficient. Note-off does NOT stop modes —
verified: the only dev_mode_running touch in the event/excitation path is _exciteSingleMode (Pianoid_
excitation.cu:88-91, mode EXCITATION), there is NO mode-stop on note release. So "sustains forever" on a
modal preset has TWO possible loci: (a) note-off events not reaching the engine (string-damper symptom,
suspects 1-3 above), OR (b) the modes not decaying (mode_dec wrong/zero/mis-loaded). [CAVEAT: whether the
damper is *supposed* to also kill mode feedback is a data-model question I have NOT confirmed — do not
infer; dev-cfl-v2's live A/B + a mode_dec readback on this preset must settle it.]

EXONERATIONS (verified by file-stat):
- `0bc6a52 [dev-modal-mass-p2]` (most recent dev) — OFFLINE only: touches ONLY modal_adapter/ (modal_mass
  fit, orchestrator, pipeline_routes, tests). NO pianoid.py / kernel / shared playback / mode-state.
  NOT a live-playback suspect. (This is the "offline FRF/modal generation" vs "shared playback" split
  team-lead asked me to make — it's the offline side.)
- `8c8bd92 [dev-modes-S3]` — middleware ONLY (parameter_manager +19, pianoid +6); a GRANULAR-edit path
  field-strip. Would only bite if the user edited MODE params, not on plain note-off. Lower priority.

MODAL-SHARPENED SUSPECT RANKING (for dev-cfl-v2's bisect on Belarus_8band_196modes):
- For locus (a) note-off-not-dispatched: suspects 1-3 unchanged (dev-midi-p1 cap/merge TOP; Pianoid.cu
  split; M12 back-pressure). Symptom would be STRINGS not damping.
- For locus (b) modes-not-decaying: `7b64531 [dev-mass-rename] mass->mass_inv` (a stale ref could zero
  mode_mass_inv / mis-load mode_dec), `92e2ba2 [dev-c529] swap mp on switch_preset` (mode-count/param
  mismatch on switch), the Pianoid.cu split phase 5 `92795d9` (Pianoid_parameters.cu — mode-param load)
  + phase 6 `cdb9f4a` (Pianoid_synthesis.cu — the mode ODE update). Symptom would be MODES ringing with
  the string already damped.
- DISCRIMINATOR for dev-cf-v2: when a note "sustains forever", is it the string or the modes ringing?
  Read back dev_mode_running decay + dec_open[stringNo] after a note-off. If dec_open=DUMP_CLOSED but
  modes still ring → locus (b) mode-decay. If dec_open stayed DUMP_OPEN → locus (a) note-off-not-applied.

## SYMPTOM-3 (gate-not-firing-live) — wiring traced end-to-end (refined)

Traced the LIVE string/tension-edit path fully (frontend → backend → gate):
- Frontend (PianoidTunner usePreset.js:855-874): live string edit sends `parameter:'string'` over WS
  (`wsEmit('set_parameter', {parameter:'string', key:pitch, values:{[pitch]:{[paramName]:value}}})`),
  REST fallback POST `/set_parameter/string/${pitch}`. Debounced (DEBOUNCE_WS / DEBOUNCE_REST).
- Backend WS handler handle_ws_set_parameter (backendServer.py:447) → `_apply_parameter_request` (the
  SAME shared helper as REST) → `pianoid.apply_parameter_request` (pianoid.py:3180) →
  `param_manager.apply` (parameter_manager.py:451) → falls through to `update_parameter('string',...)`
  → `_raise_if_cfl_unstable`. The WS handler HAS a CflRejected except (459). REST route also gated +
  re-raises (set_parameter:1216). So BOTH transports REACH the gate with parameter=='string'.
- ⇒ the gate is NOT bypassed by a wrong `kind` or a realtime PARAM_UPDATE path (there is NO middleware
  PARAM_UPDATE/updateSingleStringParameter path — those greps were all NOTE_ON/OFF schedule_event).

So symptom-3 is NOT the broad "wiring bypass." Narrowed to subtler, verifiable candidates:
1. **PARAM-NAME NORMALISATION in the prospective compute (STRONG).** The WS payload is
   `values[pitch] = {paramName: value}` where paramName is the FRONTEND name. _raise_if_cfl_unstable
   reads `pending[name]` for python names (tension/r/rho/jung/...) AFTER applying
   FRONTEND_TO_PYTHON_PARAM_MAP. If the frontend tension paramName is NOT 'tension' (or not in the map),
   the override `ov('tension', phys.tension)` silently falls back to the CURRENT (pre-edit) tension →
   the prospective amp is computed on the OLD value → STABLE → no reject. EXACTLY "didn't catch a live
   tension raise." dev-cf-v2 can confirm instantly by logging the `values`/`pending` dict the gate sees.
2. The user's "live tension raise" may have used a DIFFERENT editor (bulk/whole-matrix, or the
   tension_offset detuning field) not on this per-pitch string emit.
3. dev-cf-v2 found+fixed 2 route-level bugs in live-verify (jsonify 500; CflRejected 416→400) — the
   build the USER tested may PREDATE those fixes, so CflRejected was swallowed (416) → looked like
   "gate didn't fire" when it did but the 400/redline never surfaced. CHECK: which commit did the user
   test — pre or post 0d10675 / the two route fixes?

FIX TARGET for symptom-3: ensure the prospective compute applies the frontend→python name map to the
incoming `values` correctly (mirror exactly what update_pitch_physical_params_GRANULAR does to `params`),
so the edited value is actually used. + confirm the user tested the build WITH the route fixes.

### CORRECTION (verified FRONTEND_TO_PYTHON_PARAM_MAP — candidate #1 LARGELY REFUTED for tension)
Map (parameter_manager.py:112): {detuning→tension_offset, dispersion_damping→disp_decay,
string_stiffness→jung, string_damping→gamma, string_radius→r, string_density→rho}. NOTE: `tension`
and `length` are NOT in the map → the frontend sends them as-is (python names). So for a TENSION edit
the frontend sends paramName='tension', and the gate's normalize-then-ov('tension',...) reads it
CORRECTLY. The gate ALSO applies the same map before ov() for r/jung/rho/disp_decay. ⇒ the param-name
normalisation is actually correct for tension AND the other physics params — candidate #1 does NOT
explain a missed *tension* raise. Walk this back from my earlier "wiring gap" framing: the backend gate
IS correctly wired to the live string/tension path (WS at usePreset.js:864 + REST, both → gated
update_parameter('string'), correct normalisation).

⇒ REVISED symptom-3 conclusion (most parsimonious, unifies with "2 route bugs found+fixed"):
- MOST LIKELY #3: the USER tested a build PREDATING dev-cf-v2's two route-bug fixes (jsonify 500;
  CflRejected mapped 416→400). With those bugs, the gate FIRED but the exception was swallowed into a
  416/500 and the UI never surfaced the 400/redline → looked exactly like "gate didn't fire." The
  re-test on the FIXED build (0d10675 / after) should show the gate firing. CHECK: which commit did
  the user run for the failing re-test?
- OR #2: the user raised tension via a DIFFERENT editor/path (bulk/whole-matrix, detuning field,
  startup-config reload) not on the per-pitch string emit.
- The gate MATH is conservative (undamped dec_curr) → cannot MISS a true instability. So symptom-3 is
  a surfacing/build-version or alternate-path issue, NOT a gate-coverage hole on the standard editor.
dev-cf-v2's live trace settles it: log the `values`/`pending` the gate receives on a live tension
raise + confirm the build SHA. If the gate raises CflRejected but no 400 reaches the UI → it's #3.

## RESOLUTION (dev-cf-v2 live A/B + my independent confirm) — all 3 symptoms closed

dev-cf-v2 ran the rigorous live A/B on Belarus_8band_196modes (dev vs v2, real rawSoundBuffer). Results
corrected one of my predictions and confirmed the rest:

**Note-off — WORKS on BOTH dev AND v2 (my A/B prediction was WRONG in direction).** I predicted "fails
on both (shared regression)"; measured truth = note-off SUCCEEDS on both. dev-cf-v2's first pass looked
stuck (RMS 0.618) but that was a MEASUREMENT ARTIFACT — the rawSoundBuffer is a 5s RING and it sampled
only 2.5s after note-off on a ~1.2s note (ring still held the during-note attack). Rigorous re-test
(note-on→off→wait 7s > full ring flush): 62→1.7e-5, 57→1.3e-5, 40→8.9e-6, 88→1.3e-6 (all silent);
HELD control→2.9e-2 (1000-2000× higher). So a DISPATCHED note-off closes the damper exactly as I traced
(my kernel-leaf trace + new_notes_ind plumbing HELD UP). My suspects #1-3 are NOT triggered in the REST
/play repro. The lesson: my static trace was right (leaf intact); my EXTRAPOLATION (symptom = backend
regression) was wrong — the backend was never broken.

**Note-off symptom is FRONTEND SEND-side — CONFIRMED + sharpened (I verified VirtualPiano.js myself).**
handleMouseUp (VirtualPiano.js:252-262) sends note-off for `getNote(event)` — the key under the cursor
AT RELEASE — NOT the pressed pitch(es) in notesPressedByMouse[]. Failure modes (all → "sustains
forever"): (a) pointer drifts to another key before release → note-off targets the WRONG key, pressed
note never released; (b) getNote returns undefined off the keyboard edge → note-off for undefined pitch;
(c) onMouseLeave={handleMouseUp} (line 271) fires note-off with the leave-position note. Correct fix:
release every pitch in notesPressedByMouse (release-what-you-pressed), not the position-derived note.
Frontend, pre-v2, independent of CFL. (Suspects #1-3 would only bite with MIDI hardware / rapid chords
hitting the MAX_EVENTS_PER_CYCLE cap — pending the user's exact trigger; but the virtual-keyboard repro
is the send-side bug.)

**Gate (symptom-3) — NOT bypassed, NOT a coverage hole, NOT even a build artifact (CONFIRMED).** My
corrected trace was right: WS + REST both reach the gate. dev-cf-v2 drove unstable tension=50000 over WS
→ BLOCKED + {code:cfl_unstable, cfl_redline:true, |g|=5.78}; length=0.05 → |g|=713 blocked (length
coverage confirmed). The user's "un-gated tension" was a STABLE-but-large value (gate fires ≥25000 on
Belarus pitch 62; below is genuinely stable physics). dev-cf-v2's earlier "WS bypassed" was test-state
pollution (malformed unkeyed payload → KeyError), not a real bypass.

**v2 EXONERATED** on all three live symptoms. The pitch-57 click + note-off are pre-v2 frontend/path
issues; the gate works. Net for the user: (1) note-off "fix" = VirtualPiano.js handleMouseUp release-
tracking (frontend, separate task); (2) gate = working as designed, user's tension was simply stable;
(3) pitch-57 click = live send/streaming path (separate, pre-v2). Stale-doc fix for later:
SYNTHESIS_ENGINE.md "addStringToBatch sets DUMP_OPEN unconditionally" → it is velocity-gated (confirmed).

## NEXT
- Report the converged resolution to team-lead (note my A/B-direction prediction was corrected by
  measurement; the static traces held).
- Await any team-lead ask (e.g. confirm the VirtualPiano fix scope, or the user's exact note-off trigger
  device). NO fixes (frontend handleMouseUp fix would be a separate /dev task if approved).
