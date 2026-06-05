# Interface Review: feedin / feedback / sound-channels

- **Status:** REVIEW / read-only analysis — for user + orchestrator review. NO code edited, NO build run.
- **Agent:** dev-d52b, 2026-06-04. Maximum-reasoning-depth pass.
- **Trigger:** user report "When I move feedback slider to 0, there is no sound" → escalated to
  "Review feedin/feedback/sound channels interface. Use maximum reasoning depth."
- **Scope:** the full coupling/output interface — `feedin`, `feedback` (both the runtime scalar
  `deck_feedback_coeff` and the per-pitch matrix), `sound_channel` vs `string_sound_channel`, the
  `deck` Python-attr vs CUDA-buffer pair, the output/"sound" pitch region (128–139), and the
  strings-mode audio output tap.
- **Citation discipline (CLAUDE.md high-stakes-inference rule):** every axis/index/unit/same-name
  claim is cited to a source line or doc. Facts that are NOT yet doc-backed and were established by
  reading source are flagged; the two that gate the fix are listed in §6 as requiring live
  measurement before any edit. No fix is proposed on inference.

Primary sources read: `PianoidCore/pianoid_cuda/MainKernel.cu`,
`PianoidCore/pianoid_middleware/{pianoid.py, parameter_manager.py, backendServer.py}`,
`PianoidBasic/Pianoid/{StringMap.py, SoundChannels.py, Pitch.py}`,
`PianoidTunner/src/hooks/usePreset.js`; docs `SYNTHESIS_ENGINE.md`, `DATA_FLOWS.md`, `REST_API.md`,
`pianoid-basic/OVERVIEW.md`, `pianoid-tunner/OVERVIEW.md`, and the prior design proposal
`feedback-excitation-gating-2026-05-30.md`.

- **Prior-art check / one-doc-per-topic reconciliation:** I read
  `docs/proposals/feedback-excitation-gating-2026-05-30.md` in full. It is **related but a distinct
  topic — NOT a duplicate**, so this review does not supersede it and they coexist:
  - *That* proposal = a **runtime dynamical-stability gate**: it bounds the closed-loop runaway
    (`G_loop = c_in·c_out·deck_feedback_coeff·tension·mass_inv / soundStep > 1` → `q` diverges → NaN /
    Sint32 overflow) by detecting & softly scaling feedback when modes outrun the string field. Its
    concern is *"high feedback gain can blow up the synthesis."*
  - *This* review = a **routing/ownership** issue: the feedback controls (slider + matrix) wrongly
    reach the **output/sound-pitch (128–139) audio-tap rows**, so feedback=0 zeroes the output. Its
    concern is *"feedback should not touch the sound-channel region at all."*
  - **Shared substrate, opposite ends of the gain:** both hinge on `deck_feedback_coeff` ×
    `mode_feedback` at `MainKernel.cu:254`. The gating proposal cares about the *high* end (runaway);
    this review cares about the *zero* end (silence) AND *which rows* the scalar should touch.
  - **Consistency note for whoever implements either:** my fix (A) — gating `deck_feedback_coeff` to
    piano-pitch target rows only — narrows the set of rows the feedback scalar multiplies. That is
    *compatible* with the gating proposal (which scales the feedback applied to the resonance path) and
    does not conflict: both operate on the resonance feedback, leaving the output tap as a separate
    concern. If both are built, the runtime gate should apply after the output-row exclusion (gate the
    resonance feedback only). No merge/supersede of the proposal is needed; cross-referenced here.

---

## 0. TL;DR

The "feedback slider → 0 = silence" is **working as currently built, and it is the visible symptom of
one architectural overload**: the engine uses ONE matrix and ONE scalar for two physically different
jobs.

- The single packed coupling matrix (`mode_coefficients`, a.k.a. `dev_deck_parameters` in single-deck
  mode) holds, per *target string*, either a **resonance-coupling row** (piano pitches 0–127) or an
  **audio-output-tap row** (output/"sound" pitches 128–139). The kernel cannot tell them apart at the
  feedback-write site — it scales **every** row by the global `deck_feedback_coeff`.
- Therefore the feedback slider (`deck_feedback_coeff`) and the feedback *matrix* both reach into the
  sound-channel (output-pitch) region. Setting the slider to 0 zeroes the output-tap rows → the
  strings-mode audio output is literally `0` → silence.

**Is the user's "sound-channel region" the SAME indices as the audio output tap? YES — they are the
same rows (output pitches 128–139).** But this is NOT the contradiction it first appears to be (§3.3):
the output tap and the resonance coupling are **separable by `pitch.outerSound`** (the
`soundPitches` vs `keyPitches` split the model already maintains). Excluding `deck_feedback_coeff`
(and feedback-matrix edits) from the output-pitch rows leaves the output tap at its preset value while
zeroing only the piano-string↔mode resonance — which is exactly the user's intent ("feedback shouldn't
kill the sound"). So the fix removes the leak **without** zeroing audio. This is the orchestrator's
case 3a (distinct effect), not 3b (contradiction).

The leak is **not a single site** (§4): it is one principle violation — "output pitches are treated as
notes for feedback purposes" — visible at (a) the kernel scalar multiply, (b) the REST `parse_range`
which lets `feedback/<key>` address output pitches, and (c) the SoundChannels strings-axis editor which
*intentionally* writes `feedback/output`. Any fix must reconcile (c) with the user's intent, because
the SC strings-axis gain mechanism *is* a feedback-matrix write into the sound region.

---

## 1. Entity glossary (disambiguation — the dense same-name region)

### 1.1 The two pitch classes (the axis everything hinges on)

| Class | Pitch IDs | Role | Source |
|---|---|---|---|
| **Piano / key pitches** | 0–127 (preset uses 21–108) | Real notes; hammer-excited string bridges | `pianoid-basic/OVERVIEW.md:242,298-304`; `StringMap.all_pitches(piano=True)` → 21..108 (`StringMap.py:209-210`) |
| **Output / "sound" pitches** | 128–139 | Soundboard **receiver** points; NOT notes, never excited; one per audio output channel | `OVERVIEW.md:242,294-296`; `Pitch.py:108` `outer_sound = max(pitch-127, 0)` |

- The model keeps two lists, split at preset-build time by `pitch.outerSound`:
  `outerSound==True → soundPitches`, else `→ keyPitches` (`StringMap.py:160-164`).
  **`soundPitches` == output pitches 128–139 == the user's "sound channels."**
- `outerSoundChannel = max(pitch - 127, 0)`: output pitch 128 → channel 1, 129 → 2, … 0 means "not an
  output" (`Pitch.py:108`; kernel reads it as `parameters[start_ind + 24*arraySize + pointIndex]`,
  `MainKernel.cu:200`).

### 1.2 `feedin` vs `feedback` (deck matrices — per-pitch × per-mode coupling)

| Name | Meaning | Shape | Python store | Source |
|---|---|---|---|---|
| `deck['feedin']` | string→mode coupling: which modes a key excites (spatial mode-shape at the bridge) | `[num_modes]` per pitch | `Pitch.deck['feedin']` | `OVERVIEW.md:460`; `DATA_FLOWS.md:575-579` |
| `deck['feedback']` | mode→string coupling: how each mode pushes back at the bridge (= feedin by reciprocity for piano pitches; = **mode shape at receiver** for output pitches) | `[num_modes]` per pitch | `Pitch.deck['feedback']` | `OVERVIEW.md:302,461`; `pianoid-basic/OVERVIEW.md:274-275` |

- For **output pitches**, `deck['feedin'] = 0` (receivers don't excite modes) and `deck['feedback'] =
  mode shape at receiver` — this is what drives the audio output (`pianoid-basic/OVERVIEW.md:301-309`;
  `pianoid.py:3092` `outer_sound = sm.pitches[128].deck['feedback'][mode.ID]`).

### 1.3 The "feedback" SAME-NAME triple — three distinct things called "feedback"

| # | "feedback" sense | Type | Write path | Range/units | Source |
|---|---|---|---|---|---|
| F1 | **Runtime feedback SCALAR** `deck_feedback_coeff` (the SLIDER) | single global `real`, STATIC_INPUT (direct cudaMemcpy, not double-buffered) | `changeFeedback(v)` → POST `/set_runtime_parameters {feedback}` → `_map_feedback_to_coefficient` → `set_deck_feedback_coefficient` | slider 0–127 → coeff: 0.0→0.0 ("silence"), 1→~0.125, 64→1.0, 127→8.0; REST clamp 0–1000 | `usePreset.js:1640,1615-1636`; `backendServer.py:121-140,258-266`; `pianoid.py:775-809`; `SYNTHESIS_ENGINE.md:607-613` |
| F2 | **Per-pitch feedback MATRIX** (deck Feedback editor) | `{pitch: [num_modes]}` | `changeFeedbackValues` → POST `/set_parameter/feedback/{pitch}` → `update_deck(matrix='feedback')` | matrix display filtered to pitches **21–108** (piano only) | `usePreset.js:674-748,646-672`; `parameter_manager.py:720-724`; `StringMap.py:320-342` |
| F3 | **SC strings-axis gain** written THROUGH the feedback matrix at output pitches | `{output_pitch: [num_modes]}` via `feedback/output` | `useSoundChannels`/SoundChannelsPane → POST `/set_parameter/feedback/output` (key 128+) | the strings-mode per-channel gain; intentionally addresses the sound region | `usePreset.js:420,491-505`; `parse_range:737`; `DATA_FLOWS.md:585-591` |

> F1 is the user's slider. F2 is the deck matrix the user also names ("feedback matrix"). F3 is the
> subtle one: the SoundChannels **strings-axis** editor *deliberately* writes feedback into the
> output-pitch region as its gain mechanism (§4).

### 1.4 `sound_channel` vs `string_sound_channel` (the SC coefficient pair — a DIFFERENT axis from feedback)

| Name | Listen mode | Store | Shape | What it does | Source |
|---|---|---|---|---|---|
| `sound_channel` (a.k.a. `coefficients`) | `listen_to_modes=1` (modes) | `soundChannelModes.coefficients[pitch]` | `[num_channels]`, all pitches 0..139 | per-pitch coupling injected into the feedin slots reserved for mode channels (`mode_channel_index..`) | `SoundChannels.py:47-65`; `DATA_FLOWS.md:580-583`; `StringMap.py:441-444` |
| `string_sound_channel` (a.k.a. `string_coefficients`) | `listen_to_modes=0` (strings) | `soundChannelModes.string_coefficients[pitch]` | `[num_channels]`, all pitches 0..139 | per-output-pitch gain `sc_gain` that scales the feedback-tap row when packing output pitches | `SoundChannels.py:51-52`; `StringMap.py:436-438`; `DATA_FLOWS.md:584-591` |

- These are `[num_channels]` arrays — a **different axis** from the `[num_modes]` feedback matrix.
- **Stored vs effective** (`pianoid-basic/OVERVIEW.md:441-450`): both dicts are stored for ALL pitches
  0..139, but kernel-effective rows are a strict subset: modes mode reads `coefficients` rows 0..127;
  strings mode reads `string_coefficients` rows 128..127+num_output_channels ONLY.
- ⚠ **Same-name trap:** `sound_channel`/`string_sound_channel` (the `[num_channels]` SC arrays) are NOT
  the "feedback matrix". But `string_sound_channel` *feeds into* the feedback tap row as `sc_gain`
  (`StringMap.py:437`), and the SC strings-axis editor also writes the feedback matrix directly at
  output pitches (F3). The SC editor therefore touches the sound region through TWO mechanisms.

### 1.5 `deck` — Python attribute vs CUDA buffer (same-name pair)

| Sense | What | Source |
|---|---|---|
| `deck` (Python attr) | `Pitch.deck` dict `{'feedin': [num_modes], 'feedback': [num_modes]}` per pitch | `Pitch.py`; `DATA_FLOWS.md:575-579` |
| `dev_deck_parameters` (CUDA buffer) | the single packed matrix the kernel reads as `mode_coefficients`. In active **single-deck mode** (`USE_SINGLE_DECK_MATRIX=1`) it is `pack_pitch_feedin` for every string, raveled — feedback is DERIVED from it × `deck_feedback_coeff` (NOT a separately packed feedback half) | `StringMap.pack_deck:466-470`; `MainKernel.cu:247,254` |

### 1.6 The strings-mode audio output tap (and how it relates to the above)

- In strings mode (`listen_to_modes=0`), audio comes EXCLUSIVELY from output pitches
  (`pianoid-basic/OVERVIEW.md:306`). Per output-pitch stem string:
  `output = feedback − s_b`, `soundInt = Sint32(output·main_volume_coeff)` (`MainKernel.cu:486-492`;
  `SYNTHESIS_ENGINE.md:486-518`).
- `feedback` here = `s_feedback[stringInArr]` = grid-reduction of `mode_feedback[i]·s_mode`
  (`MainKernel.cu:431,461`), and `mode_feedback[i] = mode_coefficients[targetStringRow] ·
  deck_feedback_coeff` (`MainKernel.cu:254`).
- For an output string, `mode_coefficients[targetStringRow]` is the packed
  `deck['feedback']·sc_gain` row (`pack_pitch_feedin:434-438`). **So the audio output IS that packed
  feedback row, scaled by `deck_feedback_coeff` AND by the string_sound_channel gain.**

---

## 2. Data flow — slider (F1) and matrix (F2/F3)

### 2.1 F1 — feedback slider (runtime scalar)

```
ToolBar feedback slider
  → usePreset.changeFeedback(v)              clamp 0..127            (usePreset.js:1640-1648)
  → sendFeedbackToBackend(v) [debounced 100ms]                       (usePreset.js:1615-1636)
  → POST /set_runtime_parameters { feedback: v }   (or WS)           (usePreset.js:1620-1630)
  → backendServer._apply_runtime_parameters                          (backendServer.py:258-266)
      _map_feedback_to_coefficient(v):  0.0→0.0; 1..127→8^((v-64)/63); else→v(clamp 0..1000)  (:121-140)
  → pianoid.set_deck_feedback_coefficient(coeff)                     (pianoid.py:775-809)
      RuntimeParameters.deck_feedback_coefficient = coeff
  → pianoid_cpp.setRuntimeParameters → cudaMemcpy → dev deck_feedback_coeff (direct, no swap)
  → KERNEL: mode_feedback[i] = mode_coefficients[ foldedIndexInQuarter[i]*numModes + modeNo ]
                               * (*deck_feedback_coeff)              (MainKernel.cu:254)
            ... applies to EVERY target string row, piano AND output.
```

### 2.2 F2 — deck feedback matrix (piano pitches)

```
PitchesModesMatrix (deck Feedback editor)  — display filtered to pitches 21..108  (usePreset.js:655)
  → changeFeedbackValues(matrix, pitch)  [debounced 300ms]          (usePreset.js:674-748)
  → POST /set_parameter/feedback/{pitch}   (or WS set_parameter)    (usePreset.js:716-718)
  → backendServer._apply_parameter_request → parse_range            (backendServer.py:151-188,700-745)
  → pianoid.apply_parameter_request → param_manager.update_parameter('feedback')  (parameter_manager.py:720-724)
      sm.update_deck(matrix='feedback', pitches, values)            (StringMap.py:320-342)
        → pitch.deck['feedback'] = values
      send_deck_params_to_CUDA()  → pack_deck (single-matrix → pack_pitch_feedin per string)
                                  → updateTunableParameter('dev_deck_parameters')  (double-buffer swap)
```

### 2.3 F3 — SC strings-axis gain (output pitches) — the subtle path

```
SoundChannelsPane strings axis (useSoundChannels)
  → fetch via GET /get_parameter/feedback/output                    (usePreset.js:420)
  → edit gain → POST /set_parameter/feedback/output  (key 'output' → output_pitches)  (usePreset.js:491-505)
  → parse_range('feedback','output') → output_pitches (128..127+N)  (backendServer.py:719-720,737)
  → update_parameter('feedback') → sm.update_deck on OUTPUT pitches
      → pitch.deck['feedback'] for output pitch = the channel's gain pattern
  → pack_pitch_feedin(outputPitch): row = deck['feedback'] * string_coefficients[pitch][channel]  (StringMap.py:434-438)
  → KERNEL: same line :254 — scaled by deck_feedback_coeff.
```

**Convergence point:** F1, F2, F3 ALL converge on `mode_coefficients` row × `deck_feedback_coeff` at
`MainKernel.cu:254`. The output-pitch rows are the audio; the piano-pitch rows are resonance.

---

## 3. The defect

### 3.1 Precise leak site

`MainKernel.cu:254`:
```c
mode_feedback[i] = mode_coefficients[ foldedIndexInQuarter[i]*numModes + modeNo ] * (*deck_feedback_coeff);
```
`foldedIndexInQuarter[i]` is the **target string** of the mode→string feedback. `deck_feedback_coeff`
is applied **unconditionally** — it does not check whether the target string belongs to a piano pitch
(resonance) or an output pitch (audio tap). Consequence:

- `deck_feedback_coeff = 0` ⇒ EVERY `mode_feedback[i] = 0` ⇒ `s_feedback = 0` for output strings ⇒
  `output = feedback − s_b = 0 − 0 = 0` ⇒ **silence** (the user's report).
- The same uniform application means the feedback *matrix* (F2/F3) and the slider (F1) both modulate
  the output-tap rows.

### 3.2 Measured/cited evidence

- Backend explicitly maps slider 0 → coeff 0.0 = "silence (no deck coupling)"
  (`backendServer.py:125,130`; `pianoid.py:785`; `REST_API.md:715-717`).
- The output tap reads the packed feedback row scaled by the coeff (`MainKernel.cu:254,431,461,486-492`;
  `pack_pitch_feedin:434-438`).
- **Live offline before/after is still owed** (§6 M1): confirm a `note_playback` render at
  `deck_feedback_coeff=1` has audio and at `=0` is silent. This reproduces the bug deterministically
  and is the pre-fix baseline. (Diagnosis is source-conclusive; the measurement is the regression anchor
  the Audio-Verification rule requires, not a check on whether the diagnosis is right.)

### 3.3 SAME vs DISTINCT — the orchestrator's critical question, resolved

**The user's "sound-channel region" IS the same row indices as the strings-mode output tap** (both =
output pitches 128–139). Naïvely "removing feedback from those rows" would zero the audio — that would
be case 3b (contradiction).

**But it is case 3a, because the two roles are separable on a different axis.** The leak is that the
SAME `deck_feedback_coeff` *scalar multiply* hits both the resonance rows and the output rows. The fix
is NOT "delete the output rows' feedback" — it is "**make `deck_feedback_coeff` (and feedback-matrix
slider-style scaling) apply only to the resonance rows; leave the output-tap rows at their preset
coefficient (unity-scaled)**." Then:

- `deck_feedback_coeff = 0` ⇒ piano-string↔mode resonance feedback = 0 (no soundboard coloration / no
  runaway), BUT output-tap rows keep their preset `deck['feedback']·sc_gain` ⇒ **audio still plays.**

This is exactly "feedback shouldn't kill the sound." The separation key already exists:
`pitch.outerSound` / the `soundPitches` vs `keyPitches` split (`StringMap.py:160-164`), and the codebase
already uses a sound/non-sound distinction for feedback elsewhere (`StringMap.reset_feedback` operates
on `keyPitches` only, `StringMap.py:566-574`; `update_deck_coefficient` docstring "not applied to the
sound pitches", `StringMap.py:347`). So the engine already *knows* this boundary in the Python layer; it
is only the **kernel scalar multiply** and the **REST/matrix write paths** that ignore it.

---

## 4. Three-line-patch-smell check — is this one site or a principle violation?

**It is a principle violation, visible at three layers.** The principle: *"output/sound pitches are
not notes; resonance-feedback controls (the slider and the feedback matrix) must not treat them as
notes."* Today they ARE treated as notes for feedback:

1. **Kernel (F1 leak):** `deck_feedback_coeff` scales output-pitch rows (`MainKernel.cu:254`). — the
   slider symptom.
2. **REST surface (F2/F3 leak):** `parse_range` lets `parameter=='feedback'` address output pitches
   explicitly (`backendServer.py:737`, plus key `'output'` at `:719-720`). A feedback-matrix write can
   land on the sound region by API.
3. **Frontend (F3 — intentional today):** the SoundChannels strings-axis editor *uses*
   `/set_parameter/feedback/output` AS its per-channel gain mechanism (`usePreset.js:420,501`). This is
   the load-bearing wrinkle: the sound region's `deck['feedback']` is BOTH "the thing the user wants
   feedback to stop touching" AND "the strings-mode output gain the SC editor legitimately sets."

**Architectural reading.** `deck['feedback']` is overloaded: for piano pitches it is *resonance
coupling*; for output pitches it is *the audio output transfer (mode→receiver) × channel gain*. The
"feedback" controls (slider + deck matrix) should govern only the resonance sense. The output sense is
properly owned by the SoundChannels strings-axis editor (`string_sound_channel`) — a separate concern
(P2). The clean architecture is:

- **Resonance feedback** (piano pitches): governed by `deck_feedback_coeff` (slider) + deck feedback
  matrix (F2). Scaled, zeroable, can run away (cf. `feedback-excitation-gating-2026-05-30.md`).
- **Output transfer / channel gain** (output pitches): governed by `string_sound_channel` (and the
  fixed receiver mode-shape). NOT scaled by the resonance slider. Always-on so audio survives.

A one-line kernel gate stops the *slider* symptom but leaves (2) and (3) — the API can still write
feedback to the sound region, and the SC editor still routes its gain through `feedback/output`. A
principled fix names the owner of each region and enforces the boundary at every layer.

### Incidental finding (out of scope, flag only)
`StringSoundChannels.__init__` (`SoundChannels.py:10`): `np.zeros(self.num_channels, self.num_modes)` —
`np.zeros` takes a shape tuple; the 2nd positional arg is `dtype`, so this would raise
`TypeError`/`ValueError` if instantiated. `StringSoundChannels` appears unused (the live store is
`ModeSoundChannels.string_coefficients`). Recommend confirming it is dead and deleting it (S1/S3), but
this is NOT part of the feedback fix.

---

## 5. Fix proposal (grounded in §3–§4) — for confirmation, NOT yet implemented

Two coordinated changes that enforce "resonance-feedback controls do not touch the output/sound region,"
plus the SC-editor reconciliation. Presented as options where a design choice is open.

### 5.1 (A) Slider — stop `deck_feedback_coeff` scaling the output-pitch rows

The output tap must keep its coefficient when the slider is at any value (incl. 0). Two candidate
surfaces:

- **A-kernel (preferred for correctness):** at `MainKernel.cu:254`, apply `deck_feedback_coeff` only
  when the **target string** `foldedIndexInQuarter[i]` is a piano (non-output) string; use unity (×1)
  for output strings. → **CUDA `--heavy --both` build.**

  **Exact gate (MEASURED — M2 resolved, read-only probe `dev-d52b-feedback-index-mapping-probe.py`,
  no GPU):** the packed `mode_coefficients` matrix is `np.stack([pack_pitch_feedin(p) for p in
  sm.pitch_index])` → **row r ↔ `string_index[r]` ↔ `pitch_index[r]`**, and the kernel feedback target
  `foldedIndexInQuarter[i]` indexes this SAME `num_strings`-row space. For `Belarus_8band_196modes`
  (num_strings=224, num_modes=196, num_channels=4): the output/sound strings are the **last 4 rows
  220–223** (→ pitches 131/130/129/128, channels 4/3/2/1). The predicate is:
  ```
  is_output(targetString) ⟺ outer_sound[targetString] > 0 ⟺ pitch_of(targetString) >= 128
  ```
  So the gated multiply is:
  ```c
  real fb_scale = (outer_sound_of(foldedIndexInQuarter[i]) > 0) ? 1.0 : (*deck_feedback_coeff);
  mode_feedback[i] = mode_coefficients[ foldedIndexInQuarter[i]*numModes + modeNo ] * fb_scale;
  ```
  CORROBORATION from the probe: output rows carry large receiver-mode-shape×sc_gain magnitudes
  (row 220 ≈ 5e3, row 221 ≈ 1.7e4 — the audio tap) while piano rows carry normalized 0–1 coupling
  (row 0 ≈ 0.6 — resonance), confirming the two row classes are physically distinct and separable.
  **Remaining ENGINE-AUTHORSHIP detail (not a data-model uncertainty):** the per-string `outer_sound`
  is in the packed physics (slot 24 `outerSoundChannel`) but currently loaded by `pointIndex`
  (`MainKernel.cu:200`), not by the feedback target. The implementer must confirm slot-24 is readable
  at `foldedIndexInQuarter[i]` OR add a small per-string `is_output`/`outer_sound` array indexable by
  that fold index (cheap; the value already exists per string). This is resolved during implementation
  in the agent's own clean stack; the data-model fact (which rows, the predicate) is **measured and
  settled**.
- **A-python (lighter, no build):** since `pack_pitch_feedin` already special-cases output pitches
  (`StringMap.py:434-438`), fold the *inverse* of the runtime coeff into the output rows so the kernel's
  later `×deck_feedback_coeff` cancels — REJECTED: `deck_feedback_coeff` is a runtime scalar applied
  live in the kernel AFTER packing; the Python pack cannot see the current slider value without
  re-packing on every slider move (defeats the direct-cudaMemcpy fast path) and is fragile. Documented
  here so it is not re-proposed.

**⇒ (A) is a kernel change requiring a build, gated on the §6 M2 index measurement.**

### 5.2 (B) Matrix — feedback-matrix edits must not write the sound region (except the SC editor's owned gain)

- **B1 — deck Feedback editor (F2):** already display-filtered to 21–108 (`usePreset.js:655`); confirm
  it can never emit an output-pitch key. Add a backend guard in `parse_range`/`update_parameter` so a
  `feedback` write to output pitches is rejected *unless* it comes from the SC strings-axis path.
  Python-only, no build.
- **B2 — SC strings-axis editor (F3):** this is the design decision for the user (§7 Q2). It currently
  writes `feedback/output` as the channel gain. If "feedback must not touch sound channels" is taken
  literally, the SC gain should be re-homed onto `string_sound_channel` exclusively (its proper owner)
  and the `feedback/output` write removed — but that is a larger SC-editor refactor and must be
  confirmed not to regress the strings-mode gain. If the user means only the *resonance* feedback
  (slider F1 + deck matrix F2), then F3 stays and only A+B1 are needed.

### 5.3 Files (by option)
- (A-kernel): `PianoidCore/pianoid_cuda/MainKernel.cu` (+ possibly `constants.h`/packing to supply the
  per-string output flag) → CUDA `--heavy --both`.
- (B1): `PianoidCore/pianoid_middleware/backendServer.py` (`parse_range`) and/or
  `parameter_manager.py` (`update_parameter`) — Python, no build.
- (B2, if chosen): `PianoidTunner/src/hooks/usePreset.js` + `useSoundChannels.js` /
  `SoundChannelsPane.jsx` — frontend, HMR; ⚠ reconcile dev-8085's stale `usePreset.js` lock.

### 5.4 Tests + measured before/after (mandatory before "works")
- Regression: offline `note_playback` deterministic render —
  - **pre-fix:** `deck_feedback_coeff=0` ⇒ RMS ≈ 0 (silence) [reproduce the bug];
  - **post-fix:** `deck_feedback_coeff=0` ⇒ note output RMS ≈ the unity-feedback output (audio
    preserved) AND the piano-pitch resonance feedback rows are 0 (leak gone);
  - **post-fix sentinel:** `deck_feedback_coeff=1` ⇒ output byte-identical to pre-fix (the gate is inert
    at unity).
- Unit: a `pack_pitch_feedin` / `update_deck` test asserting output-pitch rows are unaffected by a
  feedback-matrix write routed through F2, and that the slider scaling excludes `soundPitches`.
- Route on synthesis-output change → `/test-ui` (audio_off, offline buffer), per the Audio Verification
  Rule.

---

## 6. Facts that MUST be measured before editing (no inference)

| ID | Fact to confirm | Status | Method / Result |
|---|---|---|---|
| M2 | The kernel index mapping from feedback target `foldedIndexInQuarter[i]` to the target string's output/sound class (so A-kernel gates the RIGHT rows) | **RESOLVED 2026-06-04 (read-only, no GPU)** | Pure-Python probe `dev-d52b-feedback-index-mapping-probe.py` built the middleware `Pianoid(preset=Belarus_8band_196modes, listen_to_modes=False)` without `init_pianoid` (no `pianoidCuda`). **Result:** packed `mode_coefficients` = `np.stack([pack_pitch_feedin(p) for p in sm.pitch_index])` ⇒ row r ↔ `string_index[r]` ↔ `pitch_index[r]`; `foldedIndexInQuarter[i]` indexes that 224-row space; output strings = last 4 rows 220–223 (pitches 131/130/129/128); predicate = `outer_sound[target]>0 ⟺ pitch>=128`. Output rows carry large audio-tap magnitudes vs piano rows' 0–1 coupling. See §5.1 for the exact gate. **Residual: engine-authorship only** (read slot-24 at the fold index OR add a per-string flag) — resolved at implementation, not a data-model uncertainty. |
| M1 | `deck_feedback_coeff=0` silences the offline `note_playback` render; `=1` produces audio | **DEFERRED to fix-verification** (per orchestrator) | Needs the GPU engine; will be captured as the before/after offline render in the agent's OWN clean stack at fix-implementation time (the natural place for before/after). Not needed for the plan — source+doc diagnosis is conclusive that feedback=0 ⇒ output rows ×0 ⇒ silence. |
| M3 | Confirm `StringSoundChannels` (SoundChannels.py:4-42) is dead (unused) before recommending deletion | OPEN (incidental, out of scope) | Grep call sites; runtime check — separate cleanup, not part of this fix |

Per docs-first hygiene: M2's confirmed mapping is a documentation gap — it will be written into
`SYNTHESIS_ENGINE.md` ("Runtime Feedback Coefficient" / "Audio Output") as part of the fix, before the
kernel edit. (Recorded in the dev-d52b session log now; the doc edit lands with the implementation under
a held lock.)

---

## 7. Open questions for the user (resolve before implementation)

1. **Confirm the target behavior:** feedback slider (F1) + deck feedback matrix (F2) should affect ONLY
   the piano-string↔mode resonance, and the output/sound region (128–139) keeps its preset coefficient
   so audio survives at feedback=0. (This is the fix in §5 A+B1.) Yes?
2. **SC strings-axis editor (F3):** it currently sets the per-channel strings-mode gain by writing the
   feedback matrix at output pitches (`/set_parameter/feedback/output`). Do you want that left as-is
   (the SC editor *is* the legitimate owner of the output-region feedback/gain, and "feedback should not
   touch sound channels" refers to the slider + the deck matrix, not the SC editor) — OR re-homed onto
   `string_sound_channel` so the feedback matrix never touches the sound region at all (larger SC
   refactor, B2)?
3. **`deck_feedback_coeff=0` semantics for output:** at feedback 0, should the output tap be at preset
   value (unity, recommended — "feedback off = dry soundboard output") or at some other reference?
4. **Build appetite:** the slider fix (A) is a kernel change (CUDA `--heavy --both`). OK to build, or
   prefer to scope Phase 1 to the Python/REST guard (B1) + defer the kernel gate?

---

## 8. Summary

- **Entity map:** "feedback" is three things (F1 scalar slider, F2 deck matrix, F3 SC strings-axis gain),
  all converging on one packed matrix × one scalar at `MainKernel.cu:254`. "Sound channels" = output
  pitches 128–139 = `soundPitches`. `sound_channel`/`string_sound_channel` are a separate
  `[num_channels]` axis; `string_sound_channel` feeds the output-tap gain.
- **Defect:** `deck_feedback_coeff` (and feedback-matrix writes) reach the output-pitch rows, which ARE
  the strings-mode audio tap → feedback=0 = silence.
- **SAME indices as the output tap, but case 3a not 3b:** the resonance role and the output role are
  separable by `pitch.outerSound`; excluding the resonance controls from the output rows removes the
  leak while preserving audio.
- **Not a one-liner:** the leak is one principle violation across kernel + REST + frontend; the SC
  strings-axis editor's intentional `feedback/output` write must be reconciled with the user's intent.
- **Fix:** (A) kernel gate so `deck_feedback_coeff` skips output-pitch rows [build; gated on M2 index
  measurement], (B1) REST guard so feedback writes can't address the sound region [no build], (B2 — open
  design) optionally re-home the SC gain off the feedback matrix. Measured offline before/after is
  mandatory.
- **Status:** read-only review; no edits, no build, no locks held, stack down, tree clean. Awaiting user
  answers to §7 before any implementation.

---

## 10. Feedin/feedback PARAMETER-UPDATE pipeline review (user-mandated) + middleware-only feasibility

User decisions (2026-06-04): Q1 YES, Q2 (a) leave F3 as-is, Q3 YES, **Q4 = apply the feedback coefficient
from the MIDDLEWARE; the in-kernel gate (option A) is OFF the table.** User also mandated this pipeline
review "to get correct context." This section traces the update pipeline and evaluates middleware-only
feasibility. **Verdict: a NO-kernel-change, NO-CUDA-build middleware-only fix is NOT achievable in the
active single-deck architecture (proof below). Surfacing per the orchestrator's STOP instruction.**

### 10.1 The two update pipelines

**(P-slider) F1 — runtime feedback coefficient (the slider):**
```
changeFeedback(v) → POST /set_runtime_parameters {feedback:v}
  → _apply_runtime_parameters → _map_feedback_to_coefficient(v)            (backendServer.py:121-140,258-266)
  → pianoid.set_deck_feedback_coefficient(coeff)                           (pianoid.py:775-809)
  → RuntimeParameters.deck_feedback_coefficient = coeff
  → pianoid_cpp.setRuntimeParameters(params)  → cudaMemcpy → dev `deck_feedback_coeff` (single global real, STATIC_INPUT, no double-buffer)
  → KERNEL consume: mode_feedback[i] = mode_coefficients[target row] * (*deck_feedback_coeff)  (MainKernel.cu:254)
```
The slider's effect is applied ONLY in-kernel, as a single global scalar multiply, at the feedback read.

**(P-matrix) F2/F3 — per-pitch feedback matrix:**
```
changeFeedbackValues / SC strings-axis → POST /set_parameter/feedback/<key>   (usePreset.js:674-748,491-505)
  → parse_range → update_parameter('feedback')                              (backendServer.py:700-745; parameter_manager.py:720-724)
  → sm.update_deck(matrix='feedback', pitches, values)  → pitch.deck['feedback'] = values  (StringMap.py:320-342)
  → send_deck_params_to_CUDA()  → pack_deck(single_matrix_mode=True)  → setNewDeckParameters (double-buffer swap)  (parameter_manager.py:273-278)
```

### 10.2 The single-deck coupling — why middleware-only per-row feedback scaling is blocked

**Active build mode: `USE_SINGLE_DECK_MATRIX = 1`** (`constants.h:105`), and `send_deck_params_to_CUDA`
packs `single_matrix_mode=True` (`parameter_manager.py:275`). Consequences (all source-cited):

1. **ONE packed matrix** `mode_coefficients` is uploaded — `pack_deck` returns `feedin` only
   (`StringMap.py:466-470`); NO separate feedback half exists in GPU memory.
2. **The kernel reads that ONE matrix for BOTH roles, at different rows:**
   - feedin (`MainKernel.cu:247`): `mode_coefficients[stringNoForQuarter*numModes + modeIdx]` — the
     SOURCE-string row, **NOT scaled**.
   - feedback (`MainKernel.cu:254`): `mode_coefficients[foldedIndexInQuarter[i]*numModes + modeNo] *
     deck_feedback_coeff` — the TARGET-string row, **scaled** by the global slider scalar.
3. A PIANO pitch's matrix row is read as **feedin when that string is a source** AND as **feedback when
   it is a target** — the SAME row, dual-use. (Output pitches have `deck['feedin']=0` and are read only
   as feedback targets.)
4. In single-deck mode the kernel's piano "feedback" coefficient literally **IS** `deck['feedin']` of the
   target row (`pack_pitch_feedin` packs `deck['feedin']` for piano pitches, `StringMap.py:439-440`) —
   there is **no separate piano `deck['feedback']` storage the kernel consults** that could be scaled
   independently of feedin.

**Proof of the block.** To "apply the slider middleware-side, scaling only piano feedback, leaving
feedin and output rows intact," the middleware would pre-scale the packed matrix and upload
`deck_feedback_coeff = 1.0` (making the kernel multiply inert). But by (3)+(4), pre-scaling a piano row
ALSO scales that row's **feedin** contribution (string→mode excitation coupling) — which the slider must
NOT touch. There is no middleware-reachable storage that is "piano feedback but not feedin" in
single-deck mode. **∴ a pure-Python middleware-only change (no kernel edit, no CUDA build) cannot
implement the user's intent.** The only mechanisms that can separate piano-feedback scaling from feedin
require touching the engine:

- **Option K (rejected by user):** the in-kernel conditional at `:254` (§5.1). Cleanest, one line, but
  it is in the kernel.
- **Option L (legacy two-matrix mode):** flip `USE_SINGLE_DECK_MATRIX → 0` (`constants.h:105`) so
  feedin and feedback are SEPARATE packed matrices (`MainKernel.cu:258` reads a dedicated feedback half;
  `pack_deck` already emits both halves when `single_matrix_mode=False`, `StringMap.py:472-474`). Then
  the slider scaling becomes a **pure middleware pack-time operation forever** (scale only the piano rows
  of the feedback half; upload `deck_feedback_coeff=1.0`). **BUT** this is a one-time **kernel recompile
  (`--heavy --both`)** + 2× deck GPU memory (512 KB vs 256 KB, `PresetParameters.h:37-40`) + it changes
  the feedback semantics from "reciprocal-to-feedin" to "independent feedback matrix" (need to confirm
  the packed feedback half still equals feedin at preset load so existing presets are unchanged).
- **Option M (per-string feedback-scale vector):** upload a small `num_strings` scale vector from
  middleware (1.0 for output rows, slider-value for piano rows); kernel multiplies `mode_feedback` by
  `scale[foldedIndexInQuarter[i]]` instead of the global scalar. Still a kernel change + build, but the
  *scaling policy* lives in middleware (which rows get scaled), matching the spirit of "apply from the
  middleware." Smaller than Option L, no memory doubling.

**None of the three is build-free.** Option K is rejected. Options L and M both honor "the scaling
decision/coefficient comes from the middleware" but each needs ONE kernel recompile to wire the
mechanism. After that one-time wiring, slider changes are middleware-only (no rebuild per slider move —
slider changes never rebuild today either; they're a runtime cudaMemcpy).

### 10.2a Interaction with ana-uimtx's H3 (frontend speculative-emit) — no collision

ana-uimtx's UI review (`feedin-feedback-soundchannels-UI-review-2026-06-04.md`, H3) flags that the
**Feedin/Feedback MATRIX editors** (F2) still use the speculative-emit `useEffect`-on-`mutedMatrix`
anti-pattern (`PianoidTuner.js:1140-1154,1179-1194`) — the dev-833f C2 silence pattern, documented as
deferred tech debt. **This does NOT interact with my middleware fix:** the fix targets the SLIDER
coefficient path (F1: `changeFeedback` → `/set_runtime_parameters` → `deck_feedback_coeff`), a *runtime-
parameter* path entirely separate from the matrix-editor write path (F2: `changeFeedbackValues` /
`useEffect`-on-`mutedMatrix` → `/set_parameter/feedback/<pitch>`) where H3 lives. Option M/L change how
`deck_feedback_coeff` (or the per-string scale vector) is applied at synthesis time; they neither read
nor write the F2 matrix-emit React state, so the middleware change does not depend on, and is not
corrupted by, the H3 anti-pattern. **Scoping note:** Q1's intent technically also covers the F2 deck
matrix, but F2 is already display-filtered to piano pitches 21–108 (`usePreset.js:655`) so it cannot
reach the output region via the normal editor; only F1 (global slider) and the explicit REST
`feedback/output` key (F3, which Q2=(a) keeps) touch output rows. H3 is a separate frontend-correctness
follow-up (ana-uimtx's), out of scope for this middleware-coefficient fix.

### 10.3 Recommendation to surface

The user's "middleware-only, keep it out of the kernel" is achievable in *operation* (the slider value
applied middleware-side) but NOT in *initial wiring* without one kernel recompile, because single-deck
mode fuses feedin and feedback into one unscaled-vs-scaled matrix. Recommend **Option M** (per-string
feedback-scale vector): the *policy* (which rows scale) and the *coefficient* live entirely in the
middleware pack/upload; the kernel change is a one-time mechanical swap of "global scalar" → "per-string
scale[target]" at `:254` (no per-row conditional logic in the kernel — it just indexes a vector the
middleware fills). This is the closest honest fit to the user's preference. If even one kernel recompile
is unacceptable, the only alternative is Option K (rejected) — there is no fourth door in single-deck
mode. **Awaiting user/orchestrator decision before any edit.**

---

### Appendix A — Verified source map

| Fact | Source |
|---|---|
| Slider → /set_runtime_parameters {feedback} | `usePreset.js:1640,1620-1630` |
| feedback 0.0 → coeff 0.0 "silence" | `backendServer.py:121-140,125,130`; `pianoid.py:785`; `REST_API.md:715-717` |
| `set_deck_feedback_coefficient` | `pianoid.py:775-809` |
| Kernel feedback scale `× deck_feedback_coeff` | `MainKernel.cu:254` |
| Output tap `output = feedback − s_b` | `MainKernel.cu:486-492`; `SYNTHESIS_ENGINE.md:486-518` |
| feedback reduction `mode_feedback·s_mode` | `MainKernel.cu:431,461` |
| `outerSoundChannel = max(pitch-127,0)` | `Pitch.py:108`; `MainKernel.cu:200` |
| pitch split outerSound→soundPitches/keyPitches | `StringMap.py:160-164` |
| all_pitches(piano=True) = 21..108 | `StringMap.py:209-210` |
| feedback default pitch set = piano | `parameter_manager.py:717,720-724` |
| pack_deck single-matrix = feedin only | `StringMap.py:466-470` |
| pack_pitch_feedin output row = feedback·sc_gain | `StringMap.py:434-438` |
| pack_pitch_feedin piano row = feedin | `StringMap.py:439-440` |
| parse_range allows feedback→output pitches | `backendServer.py:719-720,737` |
| SC strings-axis uses /feedback/output | `usePreset.js:420,491-505` |
| reset_feedback over keyPitches (non-sound) only | `StringMap.py:566-574`; `pianoid.py:1086-1096` |
| update_deck_coefficient "not applied to sound pitches" | `StringMap.py:347` |
| output-pitch deck['feedback'] = receiver mode shape | `pianoid-basic/OVERVIEW.md:301-309`; `pianoid.py:3092` |
| `StringSoundChannels.__init__` np.zeros bug | `SoundChannels.py:10` |
| Runtime feedback gate proposal (related) | `docs/proposals/feedback-excitation-gating-2026-05-30.md` |
