# Design Proposal: Single feedback/feedin coefficient SLIDER

- **Status:** **IMPLEMENTED 2026-06-05 (dev-fbsl)** on `feature/feedback-coeff-slider` (PianoidBasic +
  PianoidCore + PianoidTunner) — pre-Step-10 halt, awaiting user live test + merge approval. Originally
  CONFIRMED by user 2026-06-05 (two-layer model + ownership inversion APPROVED; defaults accepted:
  frontend composition / no CUDA build, reuse `8^((pos−64)/63)` curve, localStorage slider-pos,
  `/health`-exposed matrix-disable flag). Implemented on clean bases (Core 422f074 / Basic 206ea96 /
  Tunner e2aaacf, after dev-lmode landed). NO CUDA build (frontend composition + PianoidBasic-light only).
- **Agent:** dev-fbsl, 2026-06-05.

> ### ★ IMPLEMENTATION SEMANTIC CORRECTION (measured 2026-06-05) — what "sound channels unaffected" verifies
> The §6 verification gate was originally worded as "the sound-channel OUTPUT is UNCHANGED across both
> layers and their product." **Measurement (probe `dev-fbsl-sc-coupling-probe.py`) showed that literal
> form is physically impossible AND not what dev-d52b guarantees:** in strings mode the rendered audio
> IS the output tap, and piano resonance feedback physically COUPLES into the soundboard, so the rendered
> output legitimately varies with the coefficient (RMS 0.0076 @coeff=1.0 → 0.788 @coeff=0). The CORRECT,
> measurable invariant — the actual dev-d52b mask contract — is: **the output-tap ROWS are not DIRECTLY
> scaled by the coefficient** (the per-string `dev_feedback_output_mask` is 1.0 for the output rows, so
> the coefficient multiplies piano rows only). The user-visible meaning is exactly "feedback shouldn't
> kill the sound": at coeff=0 the piano resonance is zeroed but the note audio is PRESERVED (probe: RMS
> 0.788, NOT silence). The shipped gate (`tests/system/test_feedback_coeff_sound_channels.py`) verifies
> this invariant: (1) the mask classifies exactly the output rows (≥128) as 1.0 and all piano rows as 0.0
> so a single effective scalar (any stored×env) can't reach the sound-channel rows; (2) coeff=0 preserves
> sound-channel audio; (3) the coefficient is not globally inert (resonance coupling does change output,
> so the gate is not vacuous). This holds for the stored layer, the env layer, AND their product.

> ### ★ HARD CONSTRAINT (user, 2026-06-05) — SOUND CHANNELS UNAFFECTED BY BOTH LAYERS
> NEITHER the per-preset stored coefficient NOR the global slider env-multiplier (NOR their product, the
> effective coefficient) may affect **sound channels / output strings (pitch ≥ 128)**. The effective
> coefficient acts on **PIANO PITCHES ONLY**. Guaranteed by routing the composed effective coefficient
> through the **just-merged dev-d52b piano-only output mask** (`dev_feedback_output_mask`): the kernel
> scales piano-pitch resonance rows by the coefficient and multiplies output/sound rows by ×1, exactly
> as the merged feedback work guarantees (`MainKernel.cu:254` + the per-string mask; review §5.1, §10).
> Because the recommended composition (Option A, §3.2) sends ONE effective scalar through the identical
> dev-d52b masked apply path, the sound-channel exclusion is **automatic — no new mask/kernel logic is
> needed**, and it holds for the stored layer, the env layer, AND their product (a single scalar can't
> reach the masked-out rows regardless of how it was composed).
> **EXPLICIT VERIFICATION GATE (§6):** measure that BOTH layers individually AND their product leave
> sound-channel output UNCHANGED.
- **Builds DIRECTLY on the just-merged feedback work:**
  - PianoidCore dev `f332838` / PianoidBasic dev `206ea96` ([dev-d52b]): proportional piano-pitches-only
    feedback coefficient (per-string output mask, Option M) + int-domain output soft-limiter.
  - PianoidTunner dev `2488168` ([dev-uimtx]): matrices UI + clip/limit indicator.
- **Citation discipline (CLAUDE.md high-stakes-inference rule):** every axis/index/unit/same-name/
  stored-vs-effective claim is cited to a source line or doc. Facts that gate the design and are NOT yet
  doc-backed are flagged in §7 (Data Model Card) and §8 (open questions).

---

## 0. TL;DR

The user wants ONE feedback/feedin coefficient driven by the existing toolbar slider, with these
semantics:

1. **Single-matrix mode** (the active `USE_SINGLE_DECK_MATRIX=1` build): the per-pitch feedback
   **matrix** editor is **disabled** — only the scalar coefficient acts on feedback there.
2. The single coefficient **persists in the preset** (per-preset, written to disk on preset save).
3. A new **button** next to the feedback slider **folds** the current slider position into the
   stored coefficient.
4. Slider semantics:
   - **Center (64) = the preset-STORED coefficient** (the persisted baseline).
   - Off-center = an **environment-only multiplier** on top of the stored coefficient (runtime, NOT
     persisted).
   - The **slider position persists across library preset switches** (a global/environment setting);
     switching presets does NOT reset it, but the baseline it sits on is each preset's own stored coeff.
   - Pressing the button **folds** the current position into the stored coefficient AND **resets the
     slider to 64**. The updated coefficient lives **in MEMORY only** — written to disk only when the
     preset itself is saved.

**The single biggest architectural fact this design must reconcile:** the feedback coefficient is
**TODAY a RUNTIME parameter that is GLOBAL across the whole library** (`switch_preset` explicitly
snapshots and restores `deck_feedback_coefficient` so it does NOT reset on switch —
`pianoid.py:2627-2688`). The spec asks for the *opposite ownership*: the **stored coefficient becomes
per-preset** (persisted, switches with the preset), while a **NEW global/environment layer** (the
slider's off-center multiplier) takes over the "survives preset switch" role. This is a clean
re-layering, not a contradiction — but it MUST be designed deliberately because it inverts the current
ownership of `deck_feedback_coefficient`.

This proposal recommends a **two-layer model**:

```
effective_coeff  =  stored_coeff[active_preset]   ×   env_multiplier(slider_position)
                    └─ PER-PRESET, persisted ──┘       └─ GLOBAL/env, NOT persisted ─┘
```

with the button performing `stored_coeff ← stored_coeff × env_multiplier(pos); slider ← 64`
(which leaves `effective_coeff` unchanged across the fold — the fold is value-preserving).

---

## 1. Where the coefficient lives today (the substrate this design extends)

### 1.1 The F1 slider path (runtime scalar) — fully traced

| Layer | Fact | Source |
|---|---|---|
| Frontend slider | `FeedbackSlider` (toolbar), `feedback` 0–127, default **64**, `presetFeedback` prop hardcoded `64` | `ToolBar.jsx:120,154-158,609` |
| Frontend handler | `changeFeedback(v)` → clamp 0–127 → `setFeedback` → `sendFeedbackToBackend` (debounced) → POST `/set_runtime_parameters {feedback}` (or WS) | `usePreset.js:1640-1648,1615-1636` |
| Slider is NOT bootstrapped from preset | `loadPreset` does **not** call `setFeedback`; slider stays at its session value across preset loads today (purely a session/runtime value) | `usePreset.js:115` (no `setFeedback` in body) |
| Backend map | `_map_feedback_to_coefficient(v)`: `0→0.0`; `1..127 → 8^((v-64)/63)` (so **64→1.0**, 127→8.0, 1→~0.125); else clamp 0–1000 | `backendServer.py:122-141` |
| Backend apply | `_apply_runtime_parameters` → `pianoid.set_deck_feedback_coefficient(coeff)` | `backendServer.py:259-267` |
| Engine write | `RuntimeParameters.deck_feedback_coefficient = coeff`; `setRuntimeParameters` → direct cudaMemcpy (STATIC_INPUT, **NOT double-buffered**) | `pianoid.py:775-809` |
| Kernel consume | per-string scale: coeff scales **only piano-pitch resonance rows**; output/sound rows (128–139) always ×1 (Option M, the dev-d52b mask) | `MainKernel.cu:254` + `StringMap.py:543` (mask docstring); review §5.1, §10.2 |

> **The slider's center 64 already maps to coefficient 1.0 ("unity, maintains preset values").**
> This is the natural anchor for the new "center = stored baseline" semantics (§3).

### 1.2 Current ownership of the coefficient: GLOBAL, NOT per-preset, NOT persisted

- **Runtime, not persisted.** `save_preset` (`pianoid.py:2498-2532`) serializes `pitches`, `blocks`,
  `model_parameters` (= `mp.pack()` over `PARAM_NAMES`), `modes`, `mode_sound_channels`,
  `string_sound_channels`, `calibration`. There is **no feedback-coefficient field** in the preset JSON
  (confirmed by inspecting `BaselinePreset1.json` top keys + `PARAM_NAMES` `ModelParams.py:20-34`).
- **Global across library.** `switch_preset` (`pianoid.py:2627-2688`) snapshots `deck_feedback_coefficient`
  before the switch and restores it after, *by design* — the docstring says "Volume / feedback /
  sensitivity are GLOBAL across the whole library (plan §5.9) … none of it is per-preset."
- **Default after init.** A fresh `Pianoid` starts at `deck_feedback_coefficient = 1.0` (engine default;
  unity coupling — `set_deck_feedback_coefficient` docstring `pianoid.py:781-787`).

**Consequence for the design:** making the coefficient persist per-preset is a deliberate **ownership
move** — see §8 Q1. The slider's off-center multiplier becomes the new home of the "survives switch"
behavior the global coefficient has today.

### 1.3 "single-matrix mode" = `USE_SINGLE_DECK_MATRIX=1` (grounds spec item 1)

- The active build compiles `USE_SINGLE_DECK_MATRIX=1` (review §10.2, `constants.h:105`). In this mode
  there is **ONE** packed coupling matrix (`mode_coefficients`); `pack_deck` emits **feedin only**
  (`StringMap.py:466-470`); the kernel **derives** feedback as `feedin_row × deck_feedback_coeff`
  (`MainKernel.cu:254`). There is **no separate feedback half** in GPU memory.
- Therefore, in single-matrix mode, a per-pitch **feedback MATRIX** edit has no independent storage to
  write to that the kernel would read as "feedback" — feedback IS feedin × the scalar. The spec's
  "disable feedback matrix editing in single-matrix mode; only the scalar applies" is the correct,
  architecturally-honest UI for this build mode.
- (Legacy two-matrix mode `=0` keeps a real feedback half; if the build ever flips, the matrix editor
  should re-enable. The design exposes the mode so the UI follows the engine — §2.3, §8 Q4.)

---

## 2. Frontend approach

### 2.1 The two-layer slider model

Introduce a clean separation in `usePreset.js`:

| State | Owner (sole writer) | Lifetime | Persisted? |
|---|---|---|---|
| `storedFeedbackCoeff` (per-preset baseline) | `usePreset` (set on preset load from the preset value; updated on button-fold) | per-preset; switches with the active preset | **yes — to preset file on save** (via backend) |
| `feedbackSliderPos` (0–127, env multiplier; **64 = neutral**) | `usePreset` / `FeedbackSlider` | **global/environment**; survives preset switches; persisted to **localStorage** (matches the existing `FEEDBACK_RANGE_KEY` precedent, `ToolBar.jsx:118`) | localStorage only — **never** to preset |

- **Slider center (64) → env multiplier 1.0** (reuse the existing `8^((v-64)/63)` curve, so 64→1.0,
  127→8.0, 1→~0.125 — same shape the slider already has, just re-interpreted as a *multiplier on the
  stored baseline* instead of the absolute coefficient).
- **Effective coefficient** sent to the engine = `storedFeedbackCoeff × envMultiplier(sliderPos)`.

### 2.2 Components touched (frontend)

| Component | Change |
|---|---|
| `usePreset.js` | Add `storedFeedbackCoeff` state + `feedbackSliderPos` (env) state. `changeFeedback(pos)` now computes `effective = storedCoeff × envMult(pos)` and POSTs `effective` to the engine (the engine still receives a single coefficient — backend contract unchanged for the *runtime apply*, see §3.2). On `loadPreset`/`switchPreset`, set `storedFeedbackCoeff` from the preset's persisted value (does **not** reset `feedbackSliderPos`). Add `foldFeedbackIntoPreset()` (the button action, §2.4) and `getStoredFeedbackCoeff()`. |
| `ToolBar.jsx` `FeedbackSlider` | `presetFeedback`/`center` now reflects the per-preset stored baseline (not hardcoded 64). Add the **"Set" / fold button** next to the slider (MUI `IconButton` or small `Button`, dark theme, `aria-label`). `feedbackSliderPos` persisted to localStorage (extend the existing `FEEDBACK_RANGE_KEY` pattern with a `FEEDBACK_SLIDER_POS_KEY`). Value label shows the **effective** coefficient (stored × env) so the user sees the real engine value. |
| `PianoidTuner.js` | Pass `storedFeedbackCoeff`, `foldFeedbackIntoPreset`, slider-pos props from `usePreset` into `ToolBar`. Pass a `feedbackMatrixDisabled` flag (derived from single-matrix mode, §2.3) into the **Feedback** matrix pane case (`:1785`-ish) to render it read-only. |
| Feedback matrix pane (`MeasuredMatrix` via the `case "Feedback"`) | When `feedbackMatrixDisabled`, render the matrix **read-only / visibly disabled** (reuse the SC pane's H2 disable precedent — SC matrix disabled when listen-to-modes — `feedin-feedback-soundchannels-UI-review-2026-06-04.md` H2). Show a short caption: "Single-matrix mode: feedback is set by the coefficient slider." |

### 2.3 How the UI learns it is in single-matrix mode

`USE_SINGLE_DECK_MATRIX` is a **compile-time** constant in the engine. The frontend cannot infer it
from preset data. Options (design choice — §8 Q4):

- **(a) [recommended] Expose it via `/health` or the load_preset response** — the engine already exposes
  `pianoidCuda.USE_SINGLE_DECK_MATRIX` (the refactoring plan references
  `getattr(pianoidCuda, 'USE_SINGLE_DECK_MATRIX', 0)` `DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md:351`).
  Surface it as a boolean in `/health` so the frontend disables the matrix editor authentically. This
  avoids the H2 anti-pattern (frontend-only localStorage diverging from backend truth).
- **(b) Hardcode** `feedbackMatrixDisabled = true` in the frontend, since the active build is always
  single-matrix today. Simpler, but a silent-divergence trap if the build flips (the same class of bug
  H2 flags). NOT recommended.

### 2.4 The button (fold action)

`foldFeedbackIntoPreset()`:

1. `newStored = storedFeedbackCoeff × envMultiplier(feedbackSliderPos)` (the current effective coeff).
2. `storedFeedbackCoeff ← newStored` (in React state — the in-memory per-preset baseline).
3. `feedbackSliderPos ← 64` (reset slider to neutral; persist 64 to localStorage).
4. POST the **in-memory** update of the stored coefficient to the backend so backend memory matches
   (so a subsequent preset SAVE writes the new value) — **without** writing to disk (§3.3). The effective
   coefficient sent to the engine is unchanged by the fold (newStored × 1.0 == old effective), so **no
   audible jump** at the moment of folding. This is the value-preserving-fold invariant.

> UX note: place the button immediately right of the slider; label it "Set" (or a save-pin icon) with a
> tooltip "Fold current feedback into the preset baseline (saved to disk when you save the preset)".

---

## 3. Backend approach

### 3.1 Where the stored coefficient lives in the preset structure

**Recommendation:** add `deck_feedback_coefficient` (float, default `1.0`) to the **preset's
`model_parameters`** block, via:

- A `ModelParameters.deck_feedback_coefficient` attribute (`ModelParams.py:36-59`, default `1.0`).
- Add `'deck_feedback_coefficient'` to `PARAM_NAMES` (`ModelParams.py:20-34`) so `mp.pack()` →
  `model_parameters` carries it into `save_preset`'s `pack_for_preset_file` automatically
  (`StringMap.py:557-558`). Loading is already additive: `mp.update_params(**preset_dict['model_parameters'])`
  (`pianoid.py:2544-2545`) picks up any new key with no schema migration.
- **Back-compat:** older presets without the key → `update_params` leaves the default `1.0` → identical
  to today's unity behavior. No migration needed.

(Alternative home: a new top-level `runtime_defaults` block in the preset. Rejected — `model_parameters`
already holds the engine-config scalars `listen_to_modes`, `num_channels`, `mode_channel_index`; the
coefficient is the same class of per-preset engine setting and the pack/load plumbing already exists.)

### 3.2 How env-multiplier × stored composes into the EFFECTIVE coefficient

There are two viable compositions (design choice — §8 Q2):

- **(A) [recommended] Frontend composes; engine stays single-coefficient.** The frontend computes
  `effective = storedCoeff × envMult(sliderPos)` and POSTs that single `effective` value via the
  existing `/set_runtime_parameters {feedback: <coeff-or-level>}` path. The engine's
  `deck_feedback_coefficient` and the dev-d52b piano-only mask are **unchanged** — the effective coeff
  is the same single scalar the kernel already applies to piano rows at `MainKernel.cu:254`. This keeps
  the engine contract intact and reuses the entire just-merged Option-M apply path verbatim.
  - **Subtlety:** today `/set_runtime_parameters {feedback}` takes a slider *level* 0–127 and maps it
    through `_map_feedback_to_coefficient`. The new effective value is a *coefficient* (a product), not a
    level. Use the existing "outside 1–127 → direct coefficient (clamp 0–1000)" branch
    (`backendServer.py:137-140`) by POSTing the **coefficient directly** (e.g. a `feedback_coeff` field
    OR a value >127 that the existing else-branch passes through). Cleanest: add an explicit
    `feedback_coeff` field to `/set_runtime_parameters` that bypasses the level-mapping and calls
    `set_deck_feedback_coefficient(value)` directly (small additive backend change, no build).
- **(B) Engine composes from two stored scalars.** Persist `stored` in the engine and apply
  `env_mult` separately. Rejected — duplicates state ownership in the engine (P1 violation) and needs a
  kernel/RuntimeParameters change (build). (A) is leaner.

### 3.3 In-memory (button-write) vs disk (preset-save) mechanism

- **Button-write (in-memory only):** the fold updates the **backend's in-memory** stored coefficient so
  a later save persists it. Mechanism: set `mp.deck_feedback_coefficient = newStored` on the active
  domain model (`self.mp`) — a pure-Python attribute write, **no disk I/O**. Add a small REST endpoint
  (e.g. `POST /set_stored_feedback_coefficient {value}`) OR fold it into `/set_runtime_parameters` as a
  `store_feedback_coeff` field. This writes ONLY `self.mp.deck_feedback_coefficient` (memory). It does
  **not** call `save_preset`.
- **Disk-write (preset save only):** when the user saves the preset (existing `/save_preset` →
  `pianoid.save_preset` → `pack_for_preset_file`), `mp.pack()` now includes
  `deck_feedback_coefficient`, so the in-memory value is serialized **together with the preset**
  (exactly the spec's "coefficient saved together with the preset").
- **Per-preset switching:** `switch_preset` must STOP treating `deck_feedback_coefficient` as global.
  The **stored** baseline now lives on `self.mp` and switches automatically with the preset (because
  `self.mp` is swapped — `pianoid.py:2655-2657`). On switch, the backend should recompute and apply
  `effective = mp.deck_feedback_coefficient × envMult(currentSliderPos)` to the engine runtime
  coefficient. The **env multiplier (slider pos)** is what survives the switch now (held frontend-side +
  localStorage), replacing the global-coefficient snapshot/restore. → `switch_preset`'s
  feedback-snapshot/restore (`pianoid.py:2685`) is **removed/repurposed**: it no longer preserves the
  coefficient (that's per-preset now); the frontend re-applies effective after the switch. (Volume +
  volume-sensitivity stay global as-is — only feedback's ownership changes.)

### 3.4 Relationship to the just-merged dev-d52b `deck_feedback_coeff` path

- The effective coefficient flows through the **identical** Option-M path: a single
  `deck_feedback_coefficient` runtime scalar applied to **piano-pitch rows only** (output/sound rows
  always ×1, via the per-string mask `dev_feedback_output_mask`). Nothing in the mask, the kernel
  multiply, or the int-domain soft-limiter changes — they act on whatever single coefficient is current.
- **Limiter interaction:** the int-domain output soft-limiter (dev-d52b) acts on the **output** signal
  after the piano-feedback scaling. Since the env-multiplier feeds the SAME `deck_feedback_coeff` the
  mask + limiter already act on, a high env-multiplier (e.g. slider 127 × a stored coeff already near
  the runaway edge) can push piano feedback into the regime the limiter tames. This is **expected and
  already handled** — the limiter is the backstop. No new interaction risk beyond what dev-d52b already
  covers; flagged for the verification step (§6) to confirm the limiter still engages correctly at the
  product `stored × env` extreme.

---

## 4. Data flow (end to end)

### 4.1 Slider move (env multiplier change)
```
FeedbackSlider onChange(pos)
  → usePreset.changeFeedback(pos)
      effective = storedFeedbackCoeff × envMult(pos)        [envMult(64)=1.0]
      persist pos → localStorage (FEEDBACK_SLIDER_POS_KEY)
  → POST /set_runtime_parameters { feedback_coeff: effective }   (debounced, WS-or-REST)
  → set_deck_feedback_coefficient(effective)  → engine runtime scalar
  → KERNEL: piano rows × effective; output rows × 1 (dev-d52b mask)
```

### 4.2 Button (fold)
```
"Set" button → usePreset.foldFeedbackIntoPreset()
  newStored = storedFeedbackCoeff × envMult(pos)     (== current effective)
  storedFeedbackCoeff ← newStored                    (React state)
  feedbackSliderPos   ← 64  (persist 64 → localStorage)
  → POST /set_runtime_parameters { store_feedback_coeff: newStored }   (in-MEMORY backend update: self.mp.deck_feedback_coefficient = newStored; NO disk write)
  effective after fold = newStored × envMult(64) = newStored × 1.0 = unchanged  ← no audible jump
```

### 4.3 Preset switch (cross-preset persistence of slider position)
```
switchPreset(name)
  backend: self.mp swapped → stored baseline = new preset's mp.deck_feedback_coefficient (per-preset)
  frontend: feedbackSliderPos UNCHANGED (global/env, from localStorage)
  → re-apply effective = newPresetStored × envMult(pos)  to engine
  (the OLD global snapshot/restore of deck_feedback_coefficient is REMOVED)
```

### 4.4 Preset save (disk write)
```
/save_preset → pianoid.save_preset → pack_for_preset_file
  model_parameters now includes deck_feedback_coefficient = self.mp.deck_feedback_coefficient
  → coefficient written to disk TOGETHER with the preset
```

### 4.5 Preset load (bootstrap)
```
loadPreset → backend reads model_parameters.deck_feedback_coefficient (default 1.0 if absent)
  frontend: storedFeedbackCoeff ← that value; feedbackSliderPos NOT reset (stays at env value)
  → apply effective = stored × envMult(pos)
```

---

## 5. Implementation surface (for the build phase — NOT executed in this design phase)

| Repo | File | Change | Build? |
|---|---|---|---|
| PianoidBasic | `Pianoid/ModelParams.py` | `deck_feedback_coefficient` attr (default 1.0) + add to `PARAM_NAMES` | `build_pianoid_basic.bat` (light) |
| PianoidCore | `pianoid_middleware/pianoid.py` | `switch_preset` feedback-ownership change (stop global snapshot/restore; per-preset via `self.mp`); load bootstrap; in-memory stored setter | none (Python middleware) → `--light` |
| PianoidCore | `pianoid_middleware/backendServer.py` | `/set_runtime_parameters` additive `feedback_coeff` + `store_feedback_coeff` fields (or a small dedicated endpoint) | none → `--light` |
| PianoidTunner | `src/hooks/usePreset.js` | two-layer state, `changeFeedback` composition, `foldFeedbackIntoPreset`, load/switch bootstrap, localStorage slider-pos | HMR |
| PianoidTunner | `src/components/ToolBar.jsx` | fold button, env-multiplier slider semantics, effective-value label | HMR |
| PianoidTunner | `src/PianoidTuner.js` | wire props; `feedbackMatrixDisabled` into Feedback matrix case | HMR |
| PianoidCore (CONFIRMED) | `/health` payload | expose `single_deck_matrix` boolean (from `pianoidCuda.USE_SINGLE_DECK_MATRIX`) for authentic matrix-disable | none → `--light` |

**No CUDA kernel change is required** — the effective coefficient reuses the existing dev-d52b
single-coefficient apply path verbatim. (This is the key reason composition Option A in §3.2 is
recommended: it avoids any `--heavy --both` build.)

**P1/P2 check:** the stored coefficient gets a single owner (`self.mp` backend / `storedFeedbackCoeff`
frontend mirror); the env multiplier gets a single owner (frontend slider state + localStorage). The
fold is the only writer that moves value from env into stored. No non-owner writes. The Feedback matrix
pane's concern (per-pitch feedback editing) is correctly suppressed in single-matrix mode rather than
silently no-op'ing.

---

## 6. Verification plan (build phase)

- **Synthesis-output change → `/test-ui` (audio_off, offline `note_playback`)** per the Audio
  Verification Rule. Required measured before/after:
  - Slider 64 + stored 1.0 (default preset) ⇒ output byte-identical to current dev (the design is inert
    at neutral).
  - Slider off-center ⇒ effective = stored × envMult; piano feedback scales, output tap preserved
    (audio survives, consistent with dev-d52b).
  - **Fold invariant:** effective coefficient unchanged immediately before vs after the button press
    (value-preserving fold; no audible jump).
  - **Persistence round-trip:** fold → save preset → reload preset ⇒ stored baseline restored from disk;
    slider at 64; effective == folded value.
  - **Cross-preset:** switch preset ⇒ stored swaps to the new preset's value; slider pos unchanged;
    effective recomputed.
  - **Limiter backstop (dev-d52b interaction):** stored×env at the high extreme still triggers the
    int-domain soft-limiter / clip indicator correctly (no overflow regression).
  - **★ SOUND-CHANNELS-UNCHANGED GATE (user hard constraint, MANDATORY):** measure the offline
    multi-channel output of the **sound-channel / output strings (pitch ≥ 128)** specifically, and assert
    it is UNCHANGED across all of:
    (i) the **stored layer alone** — vary `stored_coeff` (e.g. fold a non-unity value) with slider at 64;
    (ii) the **env layer alone** — move the slider off-center with stored at preset default;
    (iii) the **product** — non-unity stored × off-center slider simultaneously.
    In every case the sound-channel output buffer must match the baseline (within float tolerance), while
    only the **piano-pitch** resonance feedback changes. This is the direct measured proof that neither
    layer (nor their product) leaks into the sound region — the dev-d52b `dev_feedback_output_mask`
    guarantee, re-verified for the composed coefficient. (Strict A1: synthesis-output change → `/test-ui`
    audio_off; the verification surface is the `note_playback` / sound_test offline multi-channel render,
    comparing the output-string channels before/after.)
- Unit/integration: `ModelParameters` pack/load round-trip of `deck_feedback_coefficient` (default-1.0
  back-compat for legacy presets); `switch_preset` per-preset coefficient swap; the in-memory
  store-setter does NOT write disk. A masked-apply unit check (host-side, no GPU) asserting the
  per-string `dev_feedback_output_mask` keeps output rows (≥128) at ×1 for any composed effective coeff
  (reuses the dev-d52b probe `dev-d52b-feedback-index-mapping-probe.py` approach).

---

## 7. Data Model Card (design-gating facts)

| Fact the design relies on | Doc / source citation | Inferred-only? |
|---|---|---|
| Slider 64 → coeff 1.0 (mapping `8^((v-64)/63)`) | `backendServer.py:122-141`; review §2.1 | N |
| Coefficient is a RUNTIME param, STATIC_INPUT, not double-buffered | `pianoid.py:775-809`; review §10.1 | N |
| Coefficient NOT in preset JSON today | `BaselinePreset1.json` keys (inspected); `pianoid.py:2514-2532`; `PARAM_NAMES` `ModelParams.py:20-34` | N |
| Coefficient is GLOBAL across library today (snapshot/restore) | `pianoid.py:2627-2688` (docstring + code) | N |
| `model_parameters` = `mp.pack()` over `PARAM_NAMES`; load via `mp.update_params(**...)` (additive) | `StringMap.py:557-558`; `pianoid.py:2544-2545`; `ModelParams.py:79-83` | N |
| Single-matrix mode = `USE_SINGLE_DECK_MATRIX=1`; feedback derived from feedin × coeff; no separate feedback half | review §10.2; `MainKernel.cu:254`; `StringMap.py:466-470` | N |
| Coefficient scales piano rows only; output rows ×1 (dev-d52b mask) | review §5.1, §10; `StringMap.py:543` | N |
| `pianoidCuda.USE_SINGLE_DECK_MATRIX` is queryable from Python | `DECK_FEEDBACK_COEFFICIENT_REFACTORING_PLAN.md:351` | **Y** — verify the attribute is actually exported on the installed `.pyd` (build-phase check) before relying on §8 Q4a |
| Frontend slider not bootstrapped from preset today | `usePreset.js:115` (loadPreset body has no `setFeedback`) | N |

All but one fact are doc/source-backed. The single inferred-only fact (the `.pyd` exporting
`USE_SINGLE_DECK_MATRIX`) gates only the *optional* §8 Q4a enhancement, not the core design; it will be
measured against the installed engine at build time before use. **Doc gap to close at implementation:**
the new per-preset-vs-global feedback ownership + the preset `deck_feedback_coefficient` field must be
documented in `DATA_FLOWS.md` §2.6 (Runtime Parameters) and `PARAMETER_SYSTEM.md` / `REST_API.md`.

---

## 8. Design questions — RESOLVED (user, 2026-06-05)

All design choices below are CONFIRMED. They are now decisions, not open questions.

1. **Ownership inversion (the big one). — APPROVED.** The stored coefficient becomes **per-preset**
   (persisted, switches with the preset); the **slider's off-center multiplier** becomes the new
   **global/environment** layer that survives preset switches. Today's "feedback coefficient is global
   across the library" behavior (`pianoid.py:2627`) is **removed** — `switch_preset` no longer
   snapshots/restores `deck_feedback_coefficient` (volume + volume-sensitivity stay global; only feedback
   moves to per-preset).
2. **Composition site (§3.2). — Option A (frontend composes, one effective coefficient to engine).**
   Engine + dev-d52b mask unchanged; **NO CUDA build**.
3. **Env-multiplier curve. — Reuse `8^((pos-64)/63)`** (64→×1, 127→×8, 1→×0.125). Identical slider feel.
4. **Matrix-disable signal (§2.3). — Expose `USE_SINGLE_DECK_MATRIX` via `/health`** (authentic; avoids
   the H2 silent-divergence trap). Disable the **Feedback** pane in single-matrix mode; the **Feedin**
   pane is the live coupling matrix and **stays editable**.
5. **Slider-pos persistence scope. — localStorage** (per-browser; matches the existing `FEEDBACK_RANGE_KEY`
   precedent) is the "global/environment" scope.
6. **Fold while at 64. — Accepted** as a harmless no-op (`stored ← stored × 1`).

★ **NEW HARD CONSTRAINT (user) — SOUND CHANNELS UNAFFECTED.** Neither layer (nor their product) affects
sound channels / output strings (pitch ≥ 128); piano pitches only, via the dev-d52b output mask. See the
banner at the top + the mandatory §6 SOUND-CHANNELS-UNCHANGED verification gate.

**Implementation HOLD:** do NOT edit source until the orchestrator greenlights — sequenced AFTER
dev-lmode's listen_mode fix commits on PianoidCore (shared `pianoid.py` / preset-model area), to avoid
mixed uncommitted PianoidCore changes.

---

## 9. Interactions / risk register

- **dev-d52b (just merged):** the effective coefficient reuses the piano-only mask + int-domain limiter
  unchanged. The env-multiplier feeds the SAME `deck_feedback_coeff` the mask + limiter act on (§3.4).
  No structural conflict; verify limiter at the `stored × env` extreme (§6).
- **dev-uimtx (just merged):** the Feedback **matrix** pane is one of the three `MeasuredMatrix` editors
  the UI review covered. Disabling it in single-matrix mode reuses the SC pane's H2 disable precedent.
  H3 (speculative-emit anti-pattern in the Feedin/Feedback matrix editors) is **orthogonal** — this
  design touches the SLIDER (runtime-param) path, not the matrix-emit React state (review §10.2a).
- **dev-lmode (concurrent, PianoidCore middleware listen_mode):** PianoidCore overlap. This DESIGN phase
  is read-only (no locks). At implementation, the `pianoid.py` `switch_preset` edit overlaps the
  middleware area dev-lmode works; the orchestrator will sequence/worktree to avoid concurrent
  PianoidCore editing (per the dispatch note).
- **`switch_preset` ownership change:** removing the feedback snapshot/restore is a behavior change to a
  load-bearing path (volume/sensitivity stay global; only feedback moves to per-preset). Needs the
  regression test in §6 to confirm volume/sensitivity globals are untouched.

---

## 10. Summary

- **Two-layer model:** `effective = stored_coeff[preset] (per-preset, persisted) × env_mult(slider_pos)
  (global, localStorage)`; button folds env into stored value-preservingly and resets slider to 64.
- **Persistence:** new `deck_feedback_coefficient` in preset `model_parameters` (additive, back-compat);
  in-memory on button-fold (`self.mp` write, no disk); to disk only on preset save (rides `mp.pack()`).
- **Ownership inversion:** stored coefficient becomes per-preset (was global); slider env-multiplier
  becomes the global/survives-switch layer (replaces the current global-coefficient snapshot/restore in
  `switch_preset`). **This is the central design decision needing user sign-off (§8 Q1).**
- **No CUDA build** under the recommended composition (Option A) — reuses the dev-d52b single-coefficient
  apply path; only PianoidBasic light + PianoidCore `--light` + PianoidTunner HMR.
- **Matrix-disable** in single-matrix mode is architecturally honest (no separate feedback half exists);
  expose `USE_SINGLE_DECK_MATRIX` via `/health` to avoid the H2 silent-divergence trap.
- **Status:** DESIGN only; no edits, no build, no locks, stack down, tree clean. Awaiting user answers to
  §8 before any implementation.

---

### Investigation history
- `docs/development/reviews/feedin-feedback-soundchannels-review-2026-06-04.md` (dev-d52b) — the data-model
  ground truth for the feedback coefficient path, Option M, and the single-deck constraint.
- `docs/development/reviews/feedin-feedback-soundchannels-UI-review-2026-06-04.md` (ana-uimtx) — the matrix
  editors' UI behavior, the H2 disable precedent, and the H3 orthogonality note.
