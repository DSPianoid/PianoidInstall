# Sound-Channel Mute / Panel Logic — Root-Cause Analysis (2026-07-12)

> ## CORRECTION (dev-mute2, 2026-07-12) — symptom #2's root cause below is **REFUTED BY MEASUREMENT**
>
> This document was written **read-only, from source inference, with the live audio confirm explicitly
> deferred** (see the "Ringdown caveat" in §2&3). That deferral is why the wrong cause shipped. When the
> operator re-reported the bug in its starkest form — *"mute does not work at all, I muted all sound and
> it didn't even change"* — dev-mute2 reproduced it on the live ASIO stack and measured every hop.
>
> **The real root cause is in the BACKEND, not the frontend.** `backendServer.parse_range` granted the
> output-pitch key space (128-131, the sound-channel rows) to the **hardcoded literal `'feedback'`** —
> the raw VALUE kind. The F6 persistent-mute MASK kind `feedback_mask`, which the strings-axis mute
> emits on those same rows, was never added to that escape hatch. So:
>
> ```
> POST /set_parameter/feedback/128       -> 200   (raw value lands)
> POST /set_parameter/feedback_mask/128  -> 416   (MUTE REJECTED — never reaches the model)
> ```
>
> **Every strings-axis mute write was rejected with HTTP 416 before it touched the model** — and so was
> every *unmute*, which is why the state was not even recoverable. The modes axis
> (`sound_channel_mask`, keyed by piano pitch) was unaffected, which is why this was never seen in
> modes mode; the operator runs `listen_to_modes=0`, so 100% of their mute writes died.
>
> **What this refutes.** §"Symptoms 2 & 3" below blames a frontend mode-column selection bound
> (`Mute` inheriting `bounds.{modeMin,modeMax}`). The operator's own action history refutes it: the
> frontend emitted a **full 196-element all-zero mask for all four channels** — the emit was never
> partial. The write died at the transport/backend boundary. dev-f10d's frontend fix (PianoidTunner
> `a14302a`) is defensible hardening but is **inert** w.r.t. this symptom — it cannot affect a request
> that returns 416. (Symptom **#1** and its fix, PianoidCore `997ece8`, are unaffected and stand.)
>
> **Measured on the live ASIO engine** (`listen_to_modes=0`, preset `Belarus_196modesC_Fanera6exc.json`,
> per-channel `pre_limit_peak`, kernel peak-hold reset via `POST /clear_limiting` before each play):
>
> | | mute POSTs | stored mask (`GET feedback_mask/output`) | audible: mute OFF | audible: mute ON |
> |---|---|---|---|---|
> | **before fix** | `416` ×4 | 196×`1`, **0 zeros — unchanged** | `[400028288, 249348944, 464938624, 180153600]` | `[399952608, 249306656, 464920832, 180120208]` — **identical, zero attenuation** |
> | **after fix** | `200` ×4 | **196 zeros ×4 channels** | `[399988224, 249331136, 464911936, 180142464]` | **`[0, 0, 0, 0]`** |
>
> Unmute also restores output (`[399863616, 249253248, 464934176, 180081264]` = baseline within 0.03%).
>
> **Fix:** PianoidCore `pianoid_middleware/backendServer.py` — the output-pitch hatch is now keyed off a
> declared set (`OUTPUT_PITCH_RAW_PARAMS`) with the `_mask` kinds **derived**, pinning the invariant that
> *a `<param>_mask` addresses exactly the same pitch key space as the raw `<param>` it masks*. Regression:
> `PianoidCore/tests/unit/test_parse_range_output_pitches.py`.
>
> **Methodological lesson:** the code path here was "unambiguous" on inspection and still wrong — the
> defect lived one layer *below* the layer being read. A live confirm on the surface that observes the
> output would have caught it immediately. Do not ship an RCA with the verification deferred.

**Scope:** RCA of four operator misbehaviors during a live strings-mode session (`listen_to_modes=0`,
volume 110). READ-ONLY analysis — no source edits, no build. Live state was inspected via `GET
/get_parameter/*` only (no mutations, no `calibrate_output_scale` / offline render).

**Verdict up front:** the four symptoms are **NOT one common root cause**. They resolve to **three
distinct causes**. The leading hypothesis — that an average-preserving proportional rescale on mute
(`scaleMembersProportional`) is the single thread — is **REFUTED**: muting is a pure 0/1 mask multiply
and never calls the rescale. The rescale only fires on aggregate **VALUE draws**, which the operator
did not perform in this sequence.

| # | Symptom | Root cause | Shared with | Confidence |
|---|---------|-----------|-------------|-----------|
| 1 | Preset switch → silent | Library-switch drops `string_sound_channels` → strings-mode gain `sc_gain=0` | none (own) | High (code-confirmed) |
| 2 | Mute-all still sounds | ~~Mute is scoped to the selected mode-column sub-range → partial mask~~ **REFUTED — see CORRECTION above.** Real cause: `parse_range` rejects `feedback_mask` on the output pitches → **HTTP 416**, the mute never reaches the model | none (own) | **Measured** (live ASIO, before/after) |
| 3 | Mute/unmute changes loudness | Selection-scoped mute (below) is a real latent frontend defect, but it is **not** what the operator hit — their mute writes were rejected outright (#2). Hardened by `a14302a`; **not** live-confirmed as a loudness cause | — | Low (code-only; unproven live) |
| 4 | Unmute → limit → crash | No output limiter + int32 hard clip (known); reachable via aggregate VALUE-draw rescale, NOT via mute | none (own) | High for clip path; mute-as-mask cannot itself exceed full-scale |

---

## How muting actually works (the mechanism the hypothesis got wrong)

Muting a sound channel is a **persistent independent mask** (F6 / dev-c5ce), applied as a pure
multiply at pack time — it never rescales survivors and never touches raw coefficients.

- Frontend: a `Mute`/`MuteSet` change mutates `muteMap` only and emits the **MASK** kind
  (`feedback_mask` on the strings axis, `sound_channel_mask` on the modes axis), NOT the raw value.
  `PianoidTunner/src/hooks/useSoundChannels.js:347-357` (`emitChange`), `matrixEmit.js:41-44`
  (`isMuteChange`). A `Value` change emits the raw row; raw and mask stay independent.
- Backend: `feedback_mask` → `parameter_manager.py:964-972` → `StringMap.update_deck_mask` →
  `Pitch.update_deck_mask`. The mask is applied only in `Pitch.effective_deck`
  (`PianoidBasic/Pianoid/Pitch.py:142-146`): `deck[matrix] * _align_mask(deck_mask[matrix], …)`.
- `scaleMembersProportional` (`PianoidTunner/src/utils/matrixAggregate.js:44-49`) — the
  average-preserving rescale — is invoked **only** by `fanOutColumnAggregateChange` /
  `fanOutAggregateChangeAxis` for a **VALUE** aggregate draw (`applyAggregateChange`). The mute paths
  (`applyImperativeChange` with a `Mute` change, and `applyAggregateMuteCycle` with `MuteSet`) never
  call it.

**Consequences that directly bear on the hypothesis:**
- Mute cannot change loudness by itself — `mask ∈ {0,1}`, unmute restores `mask=1` bit-exactly
  (proven: `PianoidCore/tests/unit/test_mute_mask.py::test_mute_zeroes_effective_preserves_raw`).
- The deck-mask edit path (`parameter_manager.py:341-350` `_send_deck_update`) only re-uploads deck
  rows to the GPU. It does **not** call `calibrate_output_scale`, so a mute/unmute does not trigger
  the offline-render `0xC0000006` crash path. Live `/health` confirms the backend is up in strings
  mode with the mask fully unmuted right now (`feedback_mask/output` = all `1.0`).

So the hypothesis's specific claims are each refuted or relocated:
- "#2 mute-all hits `currentAvg ≤ eps` → set every member to target instead of zero" — that branch is
  in `scaleMembersProportional`, which mute does not use. Refuted.
- "#3 rescaling survivors changes level" — true only for a VALUE draw, not for mute. Relocated.
- "#4 rescale pushes peak past full-scale" — true only for a VALUE draw fan-out, not for mute. Relocated.
- "#1 persistent mask carried across the preset switch" — refuted as the cause (see #1 below); the
  deterministic cause is a dropped gain array.

---

## Symptom 1 — preset switch → silent (SEPARATE root cause)

**Mechanism (code-confirmed).** In strings mode the audible output of each channel is the output-pitch
routing computed in `StringMap.pack_pitch_feedin`
(`PianoidBasic/Pianoid/StringMap.py:457-461`):

```python
if pitch.outerSound:                      # output pitches 128..128+num_channels-1
    sc_gain = 1.0
    if pitchID in self.soundChannelModes.string_coefficients:
        sc_gain = self.soundChannelModes.string_coefficients[pitchID][pitch.soundChannel]
    feedin = ext_to_the_right(pitch.effective_deck('feedback') * sc_gain, self.mp.num_strings)
```

`sc_gain` is the per-output-pitch strings-mode gain (`string_sound_channel`). `add_pitch` creates it
**defaulted to zeros** for every pitch including the output pitches 128-131
(`SoundChannels.py:71-78`, `StringMap.py:162`).

The main load path (`Pianoid.__init__`, `pianoid.py:258-260`) restores it from the preset:
`read_string_coefficients_from_preset(preset['string_sound_channels'])`.

**The library-switch path does not.** `load_preset_to_library` (`pianoid.py:3199-3206`) reads
`mode_sound_channels` and the modes-axis mute mask but **never calls
`read_string_coefficients_from_preset`**. `switch_preset` then swaps `self.sm = entry.sm`
(`pianoid.py:3283-3297`) and repacks the deck from that model — whose output-pitch
`string_coefficients` are still the zero default. Result: `sc_gain = 0` for every output pitch →
`feedin = 0` → **total silence** in strings mode. This is a deterministic every-switch failure, not a
mask carry-over.

**Live corroboration.** With the current (freshly-applied) model, `GET
/get_parameter/string_sound_channel/all` returns `[40,40,40,40]` on every piano key — i.e. the correct
gain is present now (via the `__init__` path). The output pitches 128-131 are addressable in the store
(created by `add_pitch`) but hidden from the GET because the range parser is piano-only (23-106); on
the library-switch path those output-pitch rows stay at 0.

**Not the mask.** The persistent mask is saved into presets (`deck_mute_mask`,
`mode_sound_channels_mute_mask`) and IS read on the library path (`pianoid.py:3203-3204`, and
`Pitch.__init__:84-90`). A preset saved while fully muted could also silence on reload — a real but
secondary path. The deterministic cause is the dropped `string_sound_channels`, and this is
independent of any mute state, which matches #1 occurring first (before any muting).

**Proposed fix.** Add `read_string_coefficients_from_preset` to `load_preset_to_library` (mirror
`__init__:258-260`):
```python
if "string_sound_channels" in preset_dict:
    sm.soundChannelModes.read_string_coefficients_from_preset(preset_dict["string_sound_channels"])
```
No tradeoff — it closes an asymmetry between the two load paths. Effort: S.

---

## Symptoms 2 & 3 — mute-all still sounds / mute is non-idempotent (ONE shared root cause)

> **SUPERSEDED for symptom #2 (dev-mute2, 2026-07-12).** The cause identified in this section is **not**
> why the operator's mute did nothing — their frontend emitted a correct full 196-zero mask and the
> *backend* rejected it with HTTP 416 (see [CORRECTION](#sound-channel-mute-logic--root-cause-analysis-2026-07-12)
> at the top). What follows remains a *plausible latent frontend defect* (a scoped mute is surprising),
> and dev-f10d hardened it in `a14302a` — but it was never observed live, and it is not the reported bug.
> Read it as "a defect we hardened", not "the root cause".

**Mechanism (code-confirmed): mute is scoped to the selected mode-column sub-range.** A matrix Mute
change carries `bounds.{modeMin,modeMax}` whenever a mode sub-range is selected that is **narrower**
than the full extent (`PianoidTunner/src/components/MeasuredMatrix.jsx:206-243`,
`isSubRange` + `bounds`). `useMatrixHistory.applyChangeInPlace` honors those bounds for the mute
toggles — `modesVector` and `Matrix` mute only flip cells inside `[modeLo,modeHi]`
(`useMatrixHistory.js:128-161`, via `modeLo/modeHi` at lines 106-109). The aggregate tri-state mute is
identical: state 1 = `MuteSet(muted=true, bounds=selectionBounds)`
(`useSoundChannels.js:466-476`), and `MuteSet` masks only the bounded columns
(`useMatrixHistory.js:118-125`).

So if any mode sub-range is selected (a modes-ruler drag, a single-mode select, or a
selection left over from a prior edit/zoom):

- **#2:** "mute all channels" masks only the selected mode **columns** across the channel rows. Every
  channel keeps outputting through its **unmuted** modes → the channel is not silenced → "still a
  sound." (With NO selection, `bounds` is `undefined`, the whole row is masked, and mute-all is truly
  silent — so the bug is conditional on an active mode sub-selection.)
- **#3:** unmute-one-then-mute-again masks a **different set of columns** if the mode selection changed
  between the two clicks (or if the toggle's `containsZero` test — `useMatrixHistory.js:137-139` —
  evaluates over a different bounded span). The channel returns to a different partial-mask state, so
  its summed level differs → "volume changed (became louder)." A full-range (or absent) selection is
  idempotent; a changing sub-selection is not.

Both symptoms are the same defect: **a `Mute`/`MuteSet` inherits the mode-column selection bound.**
Value/coefficient edits are *intended* to be selection-scoped (dev-mzoom Option A); extending that to
mute is what makes "mute this channel" mean "mute this channel within the current mode window."

**Ringdown caveat for #2.** Even a correct full-row mute stops only new drive; already-excited modes
ring out their decay. A one-shot live confirmation (play a note, mute-all with **no** mode selection,
watch `/health.peak_level` → 0 after decay; then with a **partial** mode selection → peak stays > 0)
disambiguates selection-scope from benign ringdown. ~~Not run here to avoid disrupting the operator's
live ASIO session; the code path is unambiguous.~~

> **This confirmation was later RUN (dev-mute2) and it broke this section.** With **no** mode selection —
> the very case this text predicts is "truly silent" — the mute-all did **not** silence: the four
> `POST /set_parameter/feedback_mask/128..131` returned **416** and the per-channel `pre_limit_peak` was
> unchanged. The deferral is precisely what allowed the wrong cause to ship: "the code path is
> unambiguous" was true of the code path being *read*, and the defect was one layer below it. Measure on
> the surface that observes the output.

**Proposed fix + tradeoff.** Make mute **unconditionally whole-axis** on the SC panel — i.e. do not
attach mode-column `bounds` to a `Mute`/`MuteSet` change (or, if scoped mute is a wanted feature,
require an explicit "mute selection" affordance distinct from the per-channel mute button, and make
the per-channel/mute-all button always full-range). Tradeoff: this removes the ability to mute a
mode-band of a channel from the matrix; if the operator relies on scoped mute, keep it only behind the
aggregate tri-state's *explicit* selection cycle and make the per-row/mute-all path always full-range.
Effort: S (frontend-only — strip `bounds` from the mute branch of `handleMatrixValuesChange`, and/or
gate the tri-state's state-1 bound).

---

## Symptom 4 — unmute → limit flashed → engine crash (SEPARATE, known clip path)

**Mechanism.** The engine has no soft output limiter with real headroom — output is hard-clipped at
int32 full-scale (known since 2026-06-16). Live `/health` shows a `limiter` telemetry block with
`ceiling = 2147986943 ≈ 2^31-1` (int32 max) and `knee ≈ 0.8·ceiling`; a ceiling at the int32 boundary
is effectively still a hard clip. With ~2 dB headroom, a channel whose peak crosses full-scale clips,
and the reported "limit flashed → crash" is that clip path. This is independent of the mute logic and
already under separate investigation.

**Can the mute logic itself push the engine into the clip?** No, not pure mute. Masking multiplies by
`{0,1}`, so it can only **reduce** amplitude; unmute restores the raw value **exactly** and cannot
exceed the pre-mute level (`test_mute_mask.py`). Two mute-adjacent routes to the clip do exist, but
neither is the mask itself:

1. **Aggregate VALUE-draw rescale (the real rescale hazard).** Drawing the collapsed aggregate curve
   upward fans out via `scaleMembersProportional` and scales **all** channel rows (including currently
   muted ones, because the aggregate averages the **raw** matrix) to hit the drawn average
   (`matrixAggregate.js:99-169`, `useSoundChannels.js:498-532`). Later unmuting reveals rows that were
   scaled **up** → peak past full-scale → clip. The `|currentAvg| ≤ EPS → set every member to target`
   branch (`matrixAggregate.js:44-49`) makes this worse: if a column's raw values are ~0, every
   channel jumps to the full target rather than staying proportionally small.
2. **Operator gain compensation.** If the operator raised volume/feedback to compensate for the
   quieter *partially-muted* output (symptom #2), unmuting the remaining columns/channels sums back to
   an above-full-scale level → clip.

**Proposed fix + tradeoff.** The durable fix is a real output limiter / headroom (out of scope here —
tracked separately). For the mute/panel contribution: (a) clamp the aggregate VALUE fan-out so a
rescale cannot lift any member above the channel's full-scale ceiling (tradeoff: breaks strict
average-preservation when it would clip — the operator must choose *no-clip* over *exact-average*); and
(b) fixing #2/#3 (whole-axis mute) removes the "compensate-then-unmute" route. Effort: limiter = L
(separate); aggregate clamp = S.

---

## Single-vs-separate verdict (with evidence)

- **#1** is its own bug: `load_preset_to_library` omits `read_string_coefficients_from_preset`
  (`pianoid.py:3199-3206` vs `pianoid.py:258-260`) → `sc_gain=0` → silence. Independent of mute;
  consistent with it occurring first, before any muting.
- **#2 + #3** share ONE root cause: **selection-scoped mute** — a `Mute`/`MuteSet` inherits the
  mode-column selection bound (`MeasuredMatrix.jsx:206-243` → `useMatrixHistory.js:118-161`), making
  mute-all partial and mute non-idempotent whenever a mode sub-range is selected.
- **#4** is the separate, already-known no-limiter/int32-clip defect. The mute mask cannot by itself
  exceed full-scale; the clip is reachable via the aggregate VALUE-draw rescale
  (`scaleMembersProportional`) or via operator gain compensation — not via mute.

The hypothesized single thread (average-preserving rescale on mute) does not exist: **mute is a pure
mask, not a rescale.** The rescale is real but lives on a different action (VALUE draws) and explains
only the #4 clip hazard, not #1/#2/#3.

## Proposed fixes summary

| # | Fix | Layer | Tradeoff | Effort |
|---|-----|-------|----------|--------|
| 1 | Call `read_string_coefficients_from_preset` in `load_preset_to_library` | backend (pianoid.py) | none | S |
| **2** | **THE REAL FIX (dev-mute2):** key `parse_range`'s output-pitch hatch off a declared set with the `_mask` kinds **derived**, so `feedback_mask/128..131` parses like `feedback/128..131` instead of 416 | backend (`backendServer.py`) | none — it restores an addressability the mask kinds were always supposed to have | S |
| 2/3 | ~~Make per-channel / mute-all mute whole-axis~~ — hardening only; **does not fix #2** (the write was rejected before reaching the model) | frontend (MeasuredMatrix / useSoundChannels) | loses matrix mode-band mute unless kept behind an explicit control | S |
| 4a | Clamp aggregate VALUE fan-out so no member is rescaled above full-scale | frontend (matrixAggregate) | breaks strict average-preservation when it would clip (no-clip wins) | S |
| 4b | Real output limiter / headroom | engine (CUDA) | separate track | L |

## Verification surfaces (for whoever implements)

- #1: `switch_preset` to a strings-mode preset with a fresh Pianoid, then `GET
  /get_parameter/string_sound_channel/<128..131-equivalent>` — expect the preset's gains, not 0;
  audible check via a played note (`/health.peak_level > 0`).
- #2/#3: play a note; with **no** mode selection, mute-all → `peak_level → 0`; with a partial mode
  selection, mute-all → `peak_level > 0` (pre-fix) vs `→ 0` (post-fix); mute→unmute→mute idempotence
  by reading `feedback_mask/output` (all-0 vs partially-0).
- #4: aggregate draw-up while muted, then unmute, watch `/health.clipping` / `limiter.active`.
