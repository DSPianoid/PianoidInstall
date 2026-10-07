# Automatic Volume Equalization — System Review

- **Date:** 2026-10-04
- **Kind:** Analysis / review (`/analyse`). No code changed.
- **Trigger:** user (Telegram): "Review how the automatic volume equalizing works." Context: the dev-17fd
  F15 session (4-note chord clipping ch1/ch3, kernel ch3 ≫ ch0, quiet clicks).
- **Evidence surface:** OFFLINE renders (audio off) in separate processes, release pyd, never the live
  backend. Probe: [`analyse-voleq-probe.py`](../development/diagnostics/analyse-voleq-probe.py). Every
  number below is a measured render unless marked *(source)* or *(inference)*.
- **Status (2026-10-04, dev-168c, merged to PianoidCore dev, not pushed):** I-3 fixed and R3 implemented in its
  user-chosen form — the equalizer's only lever is the per-pitch `hammer_mass` (no new trim factor; per-level
  loudness stays `hammer_speeds`); `level_multipliers` retired. R1, R2, R4–R11 open.
- **Status (2026-10-06, dev-0da4, PianoidCore `feature/dev-0da4-outscale-live`, NOT merged):** I-7 / R6 implemented
  in form (a): the Layer B measurement refuses a live engine before touching it and a refused/failed/silent render
  never writes `output_scale`/flag (stored value kept, `/health.output_scale.warning`); live bug B1 (switch silenced
  the engine ×1/4.6e11) fixed + verified live. Owner module `pianoid_middleware/output_level.py`.
- **Status (2026-10-06, dev-5852, Core `feature/dev-5852-outscale-policy` + Basic `feature/dev-5852-outscale-ref`, NOT
  merged):** I-5 partially addressed — the invalidation set is now the user's edit policy (shape edits stale, mass/speed/c
  never) with an impulse-referenced calibration and an explicit safe `POST /recalibrate_output_level`.
- **Status (2026-10-07, dev-e772, MERGED with dev-0da4/dev-5852 — Core dev 5fef5ca/d66b711/3d25e39, Basic dev
  9c7606b/c8af4d8, not pushed):** I-7/R6 and **R5 IMPLEMENTED** (`output_scale_load_settings`, all six load settings
  measured to move the level, re-measure with the impulse reference kept); string/mode physics no longer stale;
  `sound_channel` kinds dropped from the invalidation set (R7 part). Still open: R1-R4, R7 (rest), R8-R11 — so this
  review stays in `docs/proposals/` (partially implemented).
- **Related (not superseded):** [Excitation Loudness — Corrected Model](excitation-loudness-normalization-correction-2026-06-30.md)
  (excitation-coefficient subtopic), [Output Sound-Channel Calibration](sound-channel-calibration-2026-07-10.md)
  (per-mode inter-channel balance subtopic), [Loudness Chain — Physics Deviation Analysis](loudness-physics-deviation-analysis-2026-10-04.md)
  (2026-10-04: WHY the per-pitch level is uneven — the string gain ∝ ρ·dx² and ×n-unison code deviations behind
  I-4 and the dev-168c mass ranges). No earlier doc covers the whole level chain, so nothing was archived.

---

## 1. Summary

Pianoid has **one automatic loudness mechanism that actually runs on every preset** — the Layer-B
`output_scale` calibration — and it measures exactly **one note (p60 v127) on its hottest channel** and
pins that to −2 dBFS at slider 64. Everything else that "equalizes" is either manual, a FE convenience, or
**inert under the current excitation model**.

Measured on F15_Elyashev_array512 (512/16 and the user's 384/6 deriv-2):

| Quantity (slider 64, init-vol 100) | 512/16 d1 | 384/6 d2 |
|---|---|---|
| p60 v127, hottest channel | −2.0 dBFS (by construction) | −2.0 dBFS |
| single notes v127 above 0 dBFS (30 sampled, 21–108) | **10 / 30** (max **+15.1**, p21) | **12 / 30** (max +10.5) |
| keyboard spread of single-note peaks | **42 dB** (−26.8 … +15.1) | 40 dB |
| largest step between pitches 3 semitones apart | 17.1 dB | 18.5 dB |
| ch3 − ch0 (median over the keyboard) | **+17.2 dB** (ch3 hottest on 26/30 notes) | +18.9 dB |
| chord 33-45-60-72 v127 | **+3.8 dBFS** | +5.8 dBFS |
| chord 60-64-67-72 v127 | +6.2 dBFS | +6.9 dBFS |
| 8-note chord 48…76 v127 | **+10.8 dBFS** | +11.1 dBFS |
| peak / RMS crest (single note, median) | 21 dB | 23 dB |

So at the calibration point itself a third of the keyboard and every chord clip, before the slider goes
above 64 (slider 110 adds **+14.6 dB**). There is **no limiter**: the kernel hard-clips in the saturating
`Sint32` cast; the `/health` "limiter / gain reduction" numbers are overshoot telemetry, not attenuation.

---

## 2. How it works — the level chain

```
 note-on (pitch p, velocity v)
   │
   │  EXCITATION COEFFICIENT (per pitch × 6 base levels, host-composed, uploaded at load / on edit)
   │    coeff = c · mass(p) · speed(v) / ( ∫temporal(curve[p][v]) · ∫spatial(hammer[p]) )
   │      c      = mp.excitation_impulse_calibration (global, 2.334e8)
   │      speed  = mp.hammer_speeds  (6 breakpoints, linear between)    ← the velocity curve
   │      ∫temporal uses levels_matrix[...]  → curve VOLUME divides out   ← Layer C / g_vol inert
   ▼
 gaussKernel: force(t) = coeff · Σ gauss_i(t)·g_vol_i            (pure physics, no normalization)
   ▼
 string FDTD ⇄ modes (feedin / feedback matrices, deck_feedback_coefficient = "Feedback" slider)
   ▼
 OUTPUT TAP per channel k (strings mode: output pitch 128+k, its feedback row · sc_gain;
                           modes mode: mode_sound_channels)
   output = d/dt or d²/dt² (sound_derivative_order)                ← soundFloat (pre-volume)
   ▼
 × main_volume_coefficient  = volume_center · volume_range^((slider−64)/63)
      volume_center = exp((initVol−100)/8) · output_scale            ← Layer B lives here
   ▼
 static_cast<Sint32>  → saturates at ±INT32 = HARD CLIP (no limiter since 2026-06-16)
   │  atomicMax(|scaled|) → dev_limiter_peak → /health clipping / "gain_reduction_db"
   ▼
 ASIO driver (clamps ±INT32 again)
```

### 2.1 Inventory of every level mechanism

| # | Mechanism | Measures | Target | When it runs | Stored | Status |
|---|---|---|---|---|---|---|
| B | `calibrate_output_scale` (pianoid.py:935) | bare `soundFloat` peak of **p60 v127**, 2 s hold + 3 s tail, **max over all channels** | that peak × center(100)=1 × scale = −2 dBFS of INT32 | `init_pianoid` (load) and `switch_preset`, **only if `output_scale_calibrated` is False** | preset `model_parameters.output_scale` + flag (persisted on save) | ACTIVE — the only automatic one |
| B-inv | `invalidate_output_calibration` | — | flips flag to False on `LOUDNESS_AFFECTING_PARAMS` edits | per edit | in-memory flag; takes effect only after save → reload | ACTIVE, partial (see I-5) |
| A | `_volume_center_at_64` re-anchor | — | init-volume 100 ⇒ center 1.0 | load + every FE volume push | preset/FE `volume` (init-vol) | ACTIVE |
| — | Volume slider + sensitivity | — | `center · range^((L−64)/63)`, range 10 ⇒ ±20 dB | runtime, instant (no ramp) | runtime only (`volume_range` global per session) | ACTIVE |
| C | `normalize_excitation_volumes` (StringMap.py:525) | global max of curve volumes | volumes → [0:1] | load, if not calibrated | preset curves | **INERT on loudness** under the divide model (volumes divide out) |
| E | excitation coefficient `c·m·v/(∫t·∫s)` | — | delivered impulse = c·m·v, shape-independent | load (full) / incremental on edit | derived (not stored) | ACTIVE — equalizes **impulse**, not loudness |
| V | `hammer_speeds` velocity curve | — | 6 breakpoints, piecewise-linear | load / edit | preset | ACTIVE (F15: FPGA-derived) |
| M | Mic/synthesis equalizer (`/equalize_keyboard`, `/calibrate_volume`, `/tune_note`, perception curves, `apply_level_multipliers`, `normalize_to_clipping_headroom`) | mic RMS or synthesis RMS per pitch | reference pitch RMS / dB targets | manual | **`levels_matrix[level,2,:]` ×= k** | **BROKEN under the divide model** (see I-3) |
| SC | Modal-Adapter sound-channel calibration (single mode + batch "Ring-2", dev-scr1 retarget to `feedback/output`) | mic loudness per actuator drive | per-mode matched filter x*, column **mean preserved** | manual | output pitches' `feedback` rows | ACTIVE, not coupled to B (see I-6) |
| FB | Auto-level volume on Feedback change (dev-3f05, OFF by default) | live RMS of p60 v100 via `/get_chart_test` online | fixed baseline RMS | on feedback-slider settle | adjusts slider level | ACTIVE when toggled; ASIO only |
| L | "Limiter" telemetry (`dev_limiter_peak`, `/health`) | per-channel max \|scaled\| | flags ≥ INT32 | every cycle | runtime latch | TELEMETRY ONLY — no gain reduction exists |

### 2.2 Interactions and ordering

- **C then E then B** at load. C cannot change B's result any more (inert); E fixes impulse; B fixes one note.
- **B and the slider multiply**: the −2 dBFS point exists only at slider 64 / init-vol 100.
- **B and SC never talk**: SC rewrites the effective output store (`feedback/output`) and `feedback` is
  explicitly excluded from B's invalidation set; B's own invalidation set *does* contain
  `sound_channel` / `string_sound_channel`, which are inert in strings mode (stored-vs-effective mismatch).
- **B and M never talk**: M's in-session change (see I-3) is not seen by B, and after a reload M's change
  has vanished anyway.
- **FB** re-levels by the slider, so it compounds on whatever B left.
- **No double counting remains** in the excitation path (the June ti² double count is fixed in mainline:
  `compose_excitation_coefficient` divides by both integrals). The remaining "double" effect is between M
  and E (I-3).

---

## 3. Issues, ranked

### I-1 (Critical) — The calibration target is one note on one channel; real playing clips by up to +17 dB at the calibration point

**Evidence (measured, §1 table):** p60 is **not representative** — it sits near the keyboard median
(−3.2 dBFS median of peaks at 512/16), and 10 of 30 sampled notes exceed full scale *as single notes* at
slider 64. 4-note chords reach +3.8…+6.9 dBFS, 8-note +11 dBFS. Plus the slider: dev-17fd ran slider 110
(+14.6 dB), giving a predicted ch3 chord overshoot of ~+20 dB; dev-17fd measured live ch0..3 overshoot
13/28/21/35 dB (the extra ~15 dB live is unexplained by the offline chain — live state differed:
user edits, feedback slider, debug build; *not* reproduced here).

**Root cause:** `calibrate_output_scale` uses `max|soundFloat|` of p60 v127 with **2 dB** of headroom; no
polyphony allowance, no keyboard coverage, no slider allowance (range 10 ⇒ +20 dB available above the
target), no limiter behind it.

### I-2 (Critical) — No limiter: overshoot is hard digital clipping

**Evidence (source):** `MainKernel.cu:607-622` — the dev-d52b soft-knee limiter was removed 2026-06-16
(W5-A); `scaled = output·mvc; soundInt = (Sint32)scaled` saturates. `backendServer.py:838-930` reports
`gain_reduction_db = 20·log10(INT32/pre_peak)` — it is the *amount of clipping*, nothing attenuates. The
dev-scr1 investigation (2026-07-12) already measured "100 % flat-top at the peak" on the same path.
**Consequence:** I-1's +4…+35 dB overshoots are flat-topped square-ish waveforms on ch1/ch3. The limiter
doc/telemetry wording ("limiter", "gain reduction", constants.h soft-knee comments) is stale.

### I-3 (Critical) — The whole mic/synthesis equalizer writes to a store the engine divides out

**Evidence (measured, both configs):** scaling p60's `levels_matrix[127,2,:]` ×2 and uploading base levels
(exactly `calibration_controller._apply_single_correction` + `_upload_excitations`) gives **+6.02 dB in
the session**; after the coefficient rebuild that every load / save→reload performs
(`_upload_excitation_coefficients`), the gain is **0.00 dB**.

**Why:** `coeff = c·m·v / ∫temporal`, and ∫temporal is linear in the curve volumes, so a uniform volume
scale cancels. The equalizer only "works" because its upload path skips the coefficient recompose
(stale coefficient). Affected: `/equalize_keyboard`, `/calibrate_volume`, `/tune_note`,
`synthesis_tuner.calibrate_synthesis` (+ its clipping second pass), `apply_level_multipliers`,
perception curves, `normalize_to_clipping_headroom`, `NoteTunner.tune_note_volume`. Also inert for the same
reason: Layer C and the WIP option "(A) per-pitch leveling via `levels_matrix[:,2,:]`" (WIP DEFERRAL
dev-normfix) — that option is **not available** under the current model.

### I-4 (Major) — Pitch-to-pitch evenness: 42 dB keyboard spread, no automatic leveler

**Evidence:** §1 table; F15 512/16 per-pitch hottest-channel peaks range −26.8 dB (p45) to +15.1 dB (p21),
adjacent samples 3 semitones apart differ by up to 17 dB; the RMS spread is 41 dB. E equalizes delivered
impulse (`c·m·v`), not loudness; the residual is curve-shape concentration (June finding) **plus**, for
F15, the output-channel/mode coupling of each pitch (the converter's unknown absolute mode-mass scale
feeds straight into this). No mechanism in the chain targets per-pitch loudness, and the one that tried
(M) is inert (I-3).

### I-5 (Major) — Recalibration triggers are incomplete and not keyed by load params

| Change | Level effect (measured) | Recalibrated? |
|---|---|---|
| string_iteration 16→8, 8→6 | **0.0 dB** (512/16 vs 512/8: os 2.2949e15 vs 2.2944e15; 384/8 = 384/6) | no — and not needed (dev-f2b8 dt fix works) |
| array_size 512→384 | **+4.2 dB** bare (7.43e-7 → 1.21e-6) | only if flag False (full reload) |
| sound_derivative_order 1→2 | **−19 dB** bare (384/6: 1.21e-6 → 1.35e-7; 512/16: 7.43e-7 → 8.67e-8) | only if flag False |
| sample_rate (in-place structural) | not measured; d/dt output scales ~1/sr, d² ~1/sr² *(inference)* | no |
| SC calibration / `feedback` edits | can raise the hottest channel up to N× (I-6) | no (`feedback` excluded) |
| `sound_channel` edits in strings mode | none (inert store) | yes (spurious) |
| any LOUDNESS_AFFECTING edit | varies | flag only; takes effect after save + reload |

`output_scale` is cached per preset with **no record of the (array_size, string_iteration, sample_rate,
derivative order, listen_to_modes) it was measured at**. A preset saved after a d1 session and loaded at
d2 is 19 dB quiet; the reverse is 19 dB hot. The brief's "1.26e16 at 384/6 vs 2.29e15 at 512/16" is
mostly the **derivative order** (×8.9), partly array_size (÷1.63) — not array_size alone.

### I-6 (Major) — Per-channel balance is uncontrolled; SC calibration can make it worse and ignores signed averages

- **ch3 is the hottest channel on 26/30 notes**, median +17 dB over ch0 (512/16), and its RMS is ~5 dB
  above ch1/ch2 in chords. The output rows' L2 norms are similar (439/794/567/521, decoded from the preset),
  so the imbalance is the *signed* mode-coupling projection, not a row gain — "rescale the F15 columns"
  will not fix it.
- B normalizes the **max over channels**, so the quiet channels are never targeted; there is no per-channel
  ceiling either.
- SC write rule (`write_calibrated_mode_column`): `new_col = x*·A/mean(x*)` preserves the column *mean*,
  not its energy or peak — a concentrated optimum `x*=[1,0,0,0]` writes `4A` on one channel (+12 dB at N=4,
  +24 dB at N=16); a near-antisymmetric `x*` with `mean(x*)` just above the 1e-3 guard explodes the scale
  (already flagged by dev-scr1). It **skips modes whose existing column mean A ≤ 0** — F15 rows are 14–20 %
  negative, so signed presets get partial coverage. None of this triggers B.

### I-7 (Major) — Load/switch-time calibration renders offline inside a live backend

**Evidence (source):** `switch_preset` (pianoid.py:3343-3348) calls `calibrate_output_scale()` while the
realtime engine and ASIO are running, with no pause; `_measure_bare_synthesis_peak` resets string state and
runs `runOfflinePlayback` on the live `Pianoid`. This is the 0xC0000006 page-fault family recorded on
2026-06-26; the analytic re-derive that avoided it lived on the deleted dev-volpitch branch (1cb52fb) and is
**not in mainline**. Trigger: switching to any library preset with `output_scale_calibrated=false` — e.g.
a freshly converted FPGA preset (the converter writes `false` deliberately). It would also clobber the live
string state mid-performance even when it does not crash *(inference)*.

### I-8 (Minor) — Velocity curve is piecewise-linear in speed with visible kinks

**Evidence (p60, 512/16):** v8 −51.3, v16 −42.2, v32 −34.7, v48 −24.0, v64 −18.3, v80 −12.3, v96 −7.1,
v112 −4.2, v127 −2.0 dBFS. Dynamic range 49 dB; slope changes at the F15 breakpoints (v31: 0.52 m/s,
v63: 2.36 m/s). Loudness is linear in speed (impulse) and there is no perceptual (dB-linear) mapping; the
`calibration.perception_curves` block in the preset is consumed only by the (inert) M path.

### I-9 (Minor) — Peak target on a 21–23 dB crest-factor signal

Single notes have a ~21 dB peak/RMS crest (attack transient). A −2 dBFS peak target puts the sustained RMS
around −24 dBFS for p60 while louder pitches clip — the peak metric over-weights the first milliseconds.

### I-10 (Info) — The user's quiet isolated clicks are not explained by the level chain

Not clipping (user), no underruns / Sint discontinuities (dev-17fd, 17 min captures). Level-chain
candidates, **unverified**: (a) volume/feedback changes are applied as an instant step on the next cycle
(no gain ramp) — an FB auto-level or slider move during a sustained note steps the gain; (b) hard clip of a
single hot note (p21/p75 class, I-1) at low slider would read as a click but the user says not clipping.
Neither is supported by evidence yet; the next step stays a capture during the user's own session.

### I-11 (Info) — Doc gaps

- No module doc describes the level chain (Layer A/B/C live only in code comments + REST_API seed notes).
  This review fills the gap until a module section exists.
- REST_API.md links `MIC_VOLUME_EQUALIZATION_PLAN.md` at `development/` — it is in `development/archive/`.
- `constants.py` Layer-C comment ("C drops soundFloat") and the constants.h / backendServer limiter
  comments describe the pre-divide / pre-W5-A behaviour.

---

## 4. Recommendations

Ordered by value/effort. All are proposals — nothing implemented.

| # | Recommendation | Fixes | Effort |
|---|---|---|---|
| R1 | **Restore an output limiter** before the `Sint32` cast: per-channel look-ahead-free peak limiter or the dev-d52b int-domain soft knee (PianoidCore f332838; removed by W5-A e3e31df), and rename telemetry so `gain_reduction_db` is real. Linked channels (one gain for all) to keep the image. | I-2, the audible part of I-1 | M (CUDA) |
| R2 | **Calibrate for polyphony + keyboard, not one note.** Measure single v127 notes on a sparse keyboard grid (e.g. every 3rd pitch) and a reference chord; set `output_scale` so the **95th-percentile single note + a chord allowance (≈ +6 dB for 4 notes)** lands at −2 dBFS at slider 64, or equivalently a −12…−14 dBFS single-note target. The 512/16 data say this costs ~12–17 dB of nominal loudness, which the slider (+20 dB) recovers. | I-1, I-9 | S–M (Python) |
| R3 | **Move every level-equalizer write into the coefficient, not the curve.** Add a per-(pitch, level) loudness trim factor `t[p][L]` to `c·m·v·t/(∫t·∫s)` (stored in the preset, default 1), and point `/equalize_keyboard`, `calibrate_synthesis`, `tune_note`, perception curves and level multipliers at it. Delete/retire Layer C (inert). | I-3, I-4 | M |
| R4 | **Automatic per-pitch leveling (optional, user decision):** an offline (separate-process or engine-paused) sweep that sets `t[p][127]` so each pitch's RMS (or loudness-weighted RMS) is within ±3 dB of the median, cap boosts at +12 dB. This is the June "task #14" method moved to the right store. | I-4 | M |
| R5 | **Key the cache by load params.** Store `output_scale_load_key = {array_size, string_iteration, sample_rate, sound_derivative_order, listen_to_modes}`; on mismatch invalidate. Known exact factors can be applied analytically without a render (string_iteration: ×1; others measured once). | I-5 | S |
| R6 | **Never render in a live backend.** In `switch_preset` / any live path, if the flag is False either (a) apply an analytic/stale value and mark "pending", running the render in a separate worker process, or (b) pause the realtime thread around it. Port the analytic idea from 1cb52fb only for exactly-known factors. | I-7 | S–M |
| R7 | **Couple SC calibration to level.** Preserve column **energy (L2)** or the per-channel peak rather than the mean; cap the per-write scale (e.g. ≤ 2×); accept signed columns (use `‖old_col‖` instead of mean); add `feedback`(output pitches) to the invalidation set and drop the inert `sound_channel` kinds in strings mode. | I-6, I-5 | S |
| R8 | **Per-channel ceiling, optional per-channel trim.** Report per-channel calibrated peaks in `/health`; optionally calibrate each channel's hottest-note level to the same target (a 4-value trim on the output rows) — only if the operator wants an equal-level speaker array; the inter-channel *ratios* within a mode remain SC's job. | I-6 | S |
| R9 | **Gain ramp** on `main_volume_coefficient` changes (per-sample linear ramp over one cycle in the write site). Cheap, removes a click candidate. | I-10 | S (CUDA) |
| R10 | Velocity curve in dB: map velocity → speed through an explicit dB law (e.g. 40–50 dB range, monotone), keep `hammer_speeds` as the physical breakpoints the law is fitted to. | I-8 | S |
| R11 | Docs: add a "Level chain" section to the middleware/engine module docs (the §2 diagram), fix the archived-link in REST_API, correct the stale limiter and Layer-C comments. | I-11 | S |

**Minimum set for the user's F15 complaint:** R1 + R2 (+ R5 so it stays right when load params change).

---

## 5. Tests proposed

| Gap | Proposed test | Type |
|---|---|---|
| equalizer writes are inert after reload | render p60, apply equalizer correction, rebuild coefficients, assert gain survives (currently 0.0 dB → fails) | integration (GPU, offline) |
| chord headroom | after calibration, assert the reference chord and the keyboard P95 stay ≤ 0 dBFS at slider 64 | integration |
| cache keyed by load params | load a preset calibrated at d1 with d2 → assert recalibration or warning | unit (no GPU, mock render) |
| no live render | `switch_preset` with `output_scale_calibrated=False` while a fake realtime flag is set → assert no `runOfflinePlayback` call | unit |
| SC write energy | `write_calibrated_mode_column` with `x*=[1,0,0,0]` → assert channel peak growth ≤ cap; signed column handled | unit |
| limiter | int-path render of a +12 dB overshoot → no sample at ±INT32 for > N consecutive samples | integration |

---

## 6. Evidence index

- Probe: `docs/development/diagnostics/analyse-voleq-probe.py` (one preset/config per process).
- Runs (2026-10-04, release pyd, offline): F15 `full` at 512/16 d1 and 384/6 d2; `level` at 512/16 d1,
  512/8 d1, 384/8 d1, 384/6 d1, 384/6 d2, 512/16 d2.

| Config | bare p60 v127 peak | output_scale |
|---|---|---|
| 512/16 d1 | 7.433e-7 | 2.2949e15 |
| 512/8 d1 | 7.435e-7 | 2.2944e15 |
| 384/8 d1 | 1.2092e-6 | 1.4107e15 |
| 384/6 d1 | 1.2091e-6 | 1.4107e15 |
| 384/6 d2 | 1.353e-7 | 1.2604e16 (= dev-17fd's live 1.26e16) |
| 512/16 d2 | 8.669e-8 | 1.9678e16 |

- Equalizer ×2 test: 512/16 +6.02 dB in session → 0.00 dB after recompose; 384/6 d2 identical.
- Live numbers quoted from the dev-17fd session log (`logs/archive/dev-17fd-2026-10-04-100753.md`) and the
  dev-scr1 headroom investigation (`logs/archive/dev-scr1-2026-07-12-101300.md`).
- Source anchors: `pianoid.py:844-1000` (formula, Layer B, invalidation), `:2537-2552` (load), `:3343-3366`
  (switch), `:2564` (in-place structural set); `StringExcitation.py:63` (coefficient), `:545` (level impulse);
  `StringMap.py:525` (Layer C), `:577-660` (coefficient pack); `calibration_controller.py:885-926` (equalizer
  writes + upload); `sound_channel_calibrator.py:240-321` (SC write); `MainKernel.cu:597-623, 776-784`
  (output write + telemetry); `backendServer.py:824-930` (limiter telemetry);
  `PianoidTunner/src/hooks/useFeedbackAutoLevel.js` (FB).
