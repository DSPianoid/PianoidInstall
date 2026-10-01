# Output Sound-Channel Calibration — Grounding Review (READ-ONLY)

**Date:** 2026-07-10
**Author:** grounding pass (analyse skill, READ-ONLY — no edits/build/render/capture)
**Purpose:** Establish the FACTS a proposed "output sound-channel calibration" feature would rest on,
so a `/compose-proposal` agent can design on solid ground. This document is **grounding, not design** —
it does not propose an algorithm or objective function.

**The operator's request (corrected).** Emit a sine at a target mode's frequency on the emitters and
find the combination of **amplitudes and phases** of the emitters that reaches **maximum output acoustic
loudness at the minimum total RMS of all the channels** (max acoustic output per unit drive effort — a
max-output / min-drive-effort problem; NOT modal-mass, NOT cross-mode-leakage).

**Fact-status legend:** **[DOC]** = stated in a doc (cited). **[SRC]** = established from source only
(UNVERIFIED against a doc — treat as source-grounded, not doc-authoritative). **[MEASURED-PRIOR]** =
established by an earlier measurement recorded in docs/memory. **[UNKNOWN]** = genuinely open.

---

## Executive summary

1. **[CORRECTED 2026-07-10 follow-up — the answer depends on a mode flag I MEASURED.]** The engine has two
   sound-channel regimes selected by `listen_to_modes`, and **a DIFFERENT object is live in each** (DATA_FLOWS
   §2.4 / basic OVERVIEW "Stored vs effective"):
   - `listen_to_modes=1` (**modes mode**) → live store = `mode_sound_channels.coefficients`, **`[pitch][channel]`**,
     effective on **piano pitches 0–127**; the output channel is derived from **mode index** (`Kernels.cu:255`).
   - `listen_to_modes=0` (**strings mode**) → live store = `string_coefficients`, effective on output pitches
     128+; the UI "strings axis" `{output_channel:[coeff_per_mode]}` = **`[output-channel][mode]`** deck-feedback
     matrix drives audio.
   **MEASURED FACT:** every shipped preset — the configured default `BaselinePreset1.json` AND all Belarus
   variants the operator runs (`-MFeq`, `-FFeq`, `_FPGAexc`, `ESPRIT_v2`, …) — has **`listen_to_modes: True`
   (modes mode)**, `num_channels: 4`, `num_modes: 196` (100 for Baseline), `num_strings: 224`. So in the
   operator's ACTUAL running config the live object is `mode_sound_channels.coefficients` **`[pitch][channel]`**,
   **not** the `[output-channel][mode]` strings-axis matrix. The word "mode" in his description is ambiguous
   (soundboard mode vs piano key/string); **which object he means is a question only he can settle** — see §(g)
   Q0. My first pass named `string_coefficients` and my mid-pass named the strings-axis matrix; both are
   **inactive** in modes mode. **[MEASURED: all presets `listen_to_modes=True`; DOC: DATA_FLOWS §2.4,
   basic OVERVIEW "Stored vs effective", `Kernels.cu:249-256`]** ⚠️ **Doc tension:** SYNTHESIS_ENGINE.md
   "Audio Output" describes Belarus output via **strings-mode** sound strings (pitch ≥128, `outerSoundChannel`),
   which conflicts with the measured `listen_to_modes=True`; unresolved — see §(a).
2. **The data model CANNOT express phase per (mode, channel).** Coefficients are `real` (= `float`) scalars.
   A **sign (±, i.e. a 180° flip)** is representable; **continuous phase is not.** The operator's algorithm
   therefore implies a **data-model change** that belongs in the proposal's FOUNDATIONS. **[SRC, personally verified]**
3. The two objective terms live on **different surfaces**: **drive RMS** is computable offline from the
   emitted signal (no device); **acoustic loudness** is an unavoidable **live-mic** measurement. No acoustic
   model avoids the mic. **[DOC + SRC]**
4. An **emit-signal + multichannel-mic-record** primitive already exists (`sdl_audio_core`,
   `measurement/recorder.py`), but it drives a **single mono output** with no per-emitter phase, and there is
   **no** amplitude/phase optimization loop anywhere. Those are **NEW**. **[SRC]**
5. The **0xC0000006 page-fault constraint** is real and, on current master, **unguarded** — but it does **not**
   block this feature, because drive-RMS needs no offline render and the mic loudness path does not call
   `runOfflinePlayback`. The rule to respect: never fire `calibrate_output_scale` / `runOfflinePlayback`
   inside a live realtime+ASIO engine. **[MEASURED-PRIOR + SRC]**
6. This is a **SEPARATE effort** from the active `modaladapter.md` capture campaign (which explicitly fences
   off the apply/injection seam). **[DOC]**

---

## (a) The sound-channels matrix — exact data model

> **CORRECTION (2026-07-10 follow-up — two revisions).** My first pass said "no live `[mode][channel]` matrix"
> and named `string_coefficients` (D); a mid-pass named the strings-axis deck-feedback matrix and called strings
> mode "the default". **BOTH are wrong for the operator's actual running config.** Two things are now settled:
> (1) There genuinely IS a per-(output-channel, mode) matrix — the **strings-axis "Sound Channels" matrix** in
> the UI, `{ output_channel: [coeff_per_mode] }` = **`[output-channel][mode]`**, = deck-**feedback** rows of the
> output pitches `128+`, surfaced via `/get_parameter/feedback/output` (`useSoundChannels.js:16-19,149`). But
> (2) **it is LIVE only in strings mode (`listen_to_modes=0`), and I MEASURED that every shipped preset — the
> default `BaselinePreset1.json` and all Belarus variants — runs `listen_to_modes=True` (MODES mode).** In modes
> mode the live sound-channel store is instead `mode_sound_channels.coefficients` (**`[pitch][channel]`**,
> effective piano pitches 0–127), and the output channel is derived from **mode index** (`Kernels.cu:255`:
> `mode_channel_num = modeNo - modeChannelIndex + 1`). So which object the operator means is **genuinely
> ambiguous** and depends on (i) whether by "mode" he means a soundboard mode or a piano key/string, and (ii)
> whether he intends modes-mode or strings-mode operation — a question only he can settle (§(g) Q0). ⚠️ **Doc
> tension flagged:** SYNTHESIS_ENGINE.md "Audio Output" describes Belarus output via **strings-mode** sound
> strings (pitch ≥128, `outerSoundChannel`), contradicting the measured `listen_to_modes=True`; this is either
> doc staleness or a subtlety of the mode flag — **UNRESOLVED, needs live measurement, not a guess.** See the
> full disambiguation at the end of this section.

There are **five** distinct objects loosely called "deck" / "sound channel"; they are packed into the single
GPU buffer `dev_deck_parameters`, which is the source of the confusion.

| # | Object (code) | Preset JSON | Shape | Dim ORDER | Index convention | Units / range | Status |
|---|---|---|---|---|---|---|---|
| A | `Pitch.deck['feedin']` | inside per-pitch `deck` (row 0 of `[2,num_modes]`) | `[num_modes]` per pitch | **[pitch][mode]** | pitch MIDI 0–127; output pitch 128+ → feedin = **0**; mode 0-based | normalized spatial coupling **0–1** | active |
| B | `Pitch.deck['feedback']` | per-pitch `deck` (row 1) | `[num_modes]` per pitch | **[pitch][mode]** | = feedin by reciprocity for keys; for output pitch = mode shape at receiver | **0–1** | active |
| C | `ModeSoundChannels.coefficients` = `mode_sound_channels` | `mode_sound_channels` `{pitchID:[ch...]}` | `{pitch: [num_channels]}` | **[pitch][channel]** | pitch 0–139 stored; **effective rows = piano pitches 0–127** in `listen_to_modes=1`; channel 0-based | real gain (raw, e.g. up to ~430) | active (modes mode) |
| D | `ModeSoundChannels.string_coefficients` = `string_sound_channels` | `string_sound_channels` `{pitchID:[ch...]}` | `{pitch: [num_channels]}` | **[pitch][channel]** | pitch 0–139 stored; **effective rows = OUTPUT pitches 128..127+num_channels** in `listen_to_modes=0`; channel 0-based | real gain; legacy default **40.0**/channel | **DORMANT** — valid backend kind, preset-persisted, **no current frontend writer** |
| E | `StringSoundChannels.coefficients` | (none) | `[num_channels, num_modes]` | **[channel][mode]** | — | — | **DEAD / reserved** — never reaches GPU; its `np.zeros(nc, nm)` constructor even throws → cannot be instantiated |

**The regime flag decides which object is live. MEASURED: all shipped presets = `listen_to_modes=True`
(modes mode).** So enumerate the candidates by regime:

**MODES mode (`listen_to_modes=1`) — the operator's ACTUAL running regime:**
- **Live store = `mode_sound_channels.coefficients` (object C), `[pitch][channel]`,** effective on piano
  pitches 0–127, columns `[0..num_channels)`. Per-pitch, length `num_channels`. This says *how strongly each
  piano key/string drives each output channel*. Injected into feedin at columns `[mode_channel_index ..
  mode_channel_index+num_channels)`; the output channel for a mode is `mode_channel_num = modeNo −
  modeChannelIndex + 1` (`Kernels.cu:255`). If the operator calls a piano key/string a "mode", **this is the
  matrix he means, and it is `[pitch(=his "mode")][channel]`.** It is the direct product of the FFT
  measurement (see the measurement-time matrix below). **[DOC: DATA_FLOWS §2.4, basic OVERVIEW "Stored vs
  effective"; SRC `Kernels.cu:249-256`]**

**STRINGS mode (`listen_to_modes=0`) — NOT the running regime for any shipped preset:**
1. **`[output-channel][mode]` deck-FEEDBACK matrix** — for output pitch `128+ch`, `deck['feedback'][128+ch]`
   is a length-`num_modes` vector = the **mode shape at receiver `ch`**. Collected across output pitches this
   is `{output_channel: [coeff_per_mode]}` — the literal "coefficients for each output channel on each
   (soundboard) mode." Real-valued, **signed** (mode shapes have nodes), per-mode normalized (spatial max = 1).
   Edited by the `SoundChannelsPane` **strings axis** via `/set_parameter/feedback/output`. **If by "mode" the
   operator means a soundboard mode, THIS is the literal match — but it is inert while `listen_to_modes=True`.**
   **[DOC: `useSoundChannels.js:16-19,149`; DATA_FLOWS §2.4; basic OVERVIEW "Output Pitches" 306–314, "Per-mode
   normalisation is mandatory" 277]**
2. **Per-channel scalar gain = `string_coefficients` (object D), `[output-pitch][channel]`** — diagonal
   `string_coefficients[128+ch][ch]` scales the whole strings-path feedback into channel `ch`. **DORMANT**
   (no FE writer). NOT a per-mode object. **[DOC: SYNTHESIS_ENGINE.md "Sound-Channel Gain Path"; DATA_FLOWS
   §2.4 DORMANT note]**

**A third candidate exists only at MEASUREMENT time and is thrown away before storage:** in
`feedin_extractor.py::extract_for_scenario` the FFT step builds `per_channel = ndarray(n_response_ch, n_modes)`
— an explicit **`[channel][mode]`** matrix (magnitude of each mode at each response channel) — then **collapses
it with `sound_coeffs = per_channel.sum(axis=1)`** (sum over modes) into a per-channel scalar before it is
written to the preset. So the per-(channel, mode) structure the operator describes genuinely exists in the
measurement pipeline but is **summed over modes and not preserved** in the stored data model — which is a plausible
root of "not balanced properly" (per-mode structure is discarded; only the per-channel deck-feedback rows carry
per-mode information, and those need the mandatory per-mode 0–1 normalization). **[SRC: `feedin_extractor.py:44-85`]**

The only literal `[channel][mode]` *class* in the model (`StringSoundChannels`, object E) is dead code and never
reaches the GPU. So the operator's `[output-channel][mode]` reading maps to the strings-mode deck-feedback rows
(candidate 1), NOT E — but that regime is not what any shipped preset runs.

### Disambiguation paragraph (for the operator)

> There are **three** objects your phrase "sound channels matrix … coefficients for each output channel on each
> mode" could mean. (1) **`mode_sound_channels`** — a per-piano-key × channel real matrix, `[key][channel]`,
> **currently LIVE** (every preset runs `listen_to_modes=True`); if by "mode" you mean a piano key/string, this
> is it, and it's FFT-measured then written without per-mode normalization (a plausible "not balanced" cause).
> (2) **The output-pitch deck-feedback matrix** — `[output-channel][soundboard-mode]`, real & signed, the literal
> "each channel on each soundboard mode", and what the UI's Sound-Channels *strings axis* edits — but it is LIVE
> **only in strings mode**, which no shipped preset uses. (3) **A `[channel][mode]` matrix that exists at
> measurement time** (`per_channel` in the FFT extractor) but is **summed over modes and discarded** before it
> reaches the preset. All three are **real-valued (no phase; sign only)**; `num_channels = 4` (measured, not 5).
> **The one I believe you mean** is (2) — the `[output-channel][mode]` matrix — because it is the only one that
> literally indexes "output channel × mode" and is the strings-axis matrix in the UI; **but** your rig runs
> modes mode, where the live object is (1). Before design I need you to confirm: **do you mean soundboard modes
> or piano keys, and do you intend strings-mode or modes-mode operation?** (There is also a doc/measurement
> conflict about which output path Belarus actually uses, which I flag rather than guess.)

**Same-name traps to carry into design:**
- `Pitch.soundChannel = pitch - 128` → **0-based** channel index (used to index the coefficient column).
- `outer_sound` / `outerSoundChannel = max(pitch - 127, 0)` → **1-based** (0 = "not an output"); used by the
  CUDA output tap `sampleIndex = (outerSoundChannel-1)*samplesInCycle + …`.
  So to calibrate channel `ch` (0-based) you write backend **pitch `128+ch`**; its column is `soundChannel=ch`
  but its kernel tap is `outerSoundChannel=ch+1`. Off-by-one here is the dev-833f bug class. **[SRC + DOC]**

**Default channel count — SETTLED by measurement: `num_channels = 4`.** I read the preset JSON directly:
`BaselinePreset1.json`, `Belarus_8band_196modes.json`, `-MFeq`, `-FFeq`, `_FPGAexc`, `ESPRIT_v2`, and
`196modesC_Fanera6exc` **all** have `model_parameters.num_channels = 4`, `num_strings = 224`, `num_modes = 196`
(100 for Baseline/ESPRIT_v2), and `string_sound_channels` output-pitch rows exactly `128,129,130,131`. The
`num_channels: 5` in REST_API.md is a **stale/example value — 4 is correct for every shipped preset.**
**[MEASURED — preset files read 2026-07-10]**

---

## (b) Can the data model express PHASE per (mode, channel)? — **NO** (single most important finding)

**Answer: NO. The coefficients are real scalars. A sign (±180°) is expressible; continuous phase is NOT.**
Personally verified against source:

- **Scalar type:** `using real = float;` — `PIANOID_USE_FLOAT` is defined, no `PIANOID_USE_DOUBLE`.
  **There is no complex type anywhere in the engine.** (`PianoidCore/pianoid_cuda/pianoid_types.h:6,15–18`) **[SRC, verified]**
- **Storage:** `ModeSoundChannels.coefficients` and `.string_coefficients` are `{pitchNo: np.zeros(num_channels)}`
  — plain real numpy arrays, one scalar per (pitch, channel). No imaginary/phase field. The preset JSON stores
  each row as a flat real array `[coeff0, coeff1, ...]`. (`PianoidBasic/Pianoid/SoundChannels.py:47–111`) **[SRC, verified]**
- **Kernel usage — pure real multiply-accumulate:** `mode_feedback[i] = mode_coefficients[...] * fb_scale`,
  then `atomicAdd(feedback_cycle_matrix + idx, mode_feedback[i] * s_mode[quarter])`. The coefficient multiplies
  the instantaneous mode displacement identically every sample — a scalar gain, no delay/phase state.
  (`MainKernel.cu`) **[SRC, per agents; corroborated by DOC SYNTHESIS_ENGINE.md lines 445–460, 595–600]**
- **Sign IS available:** nothing in the store or validators clamps to non-negative (`update_coefficients`
  checks only index bounds — `SoundChannels.py:95–106`). A negative coefficient inverts polarity (a 180° flip)
  of that channel's contribution. But this is the ONLY phase-like freedom; there is no 45°/90°/continuous phase
  and no per-channel time delay. **[SRC, verified]**
- **Holds for ALL candidate objects (coordinator Q5).** The answer is identical for the modes-mode store
  `mode_sound_channels.coefficients` (candidate C), the strings gain `string_coefficients` (D), AND the
  `[output-channel][mode]` deck-feedback matrix (candidate 1): the deck feedback rows are `Pitch.deck`
  real numpy arrays packed into the real `dev_deck_parameters` and consumed by the same real MAC. **None can
  carry phase; all can carry sign.** (The deck feedback is *already* signed — mode-shape amplitudes with nodes.)
  **[SRC, verified]**

**Downstream assumptions that a phase extension would break:**
- **Preset JSON schema** stores flat real arrays per pitch — a complex/phase field is a schema change.
- **`preset_injector.py`** writes real per-mode sums (see (c)); it assumes real coefficients.
- **The kernel's per-mode accumulation** is a real MAC into `feedback_cycle_matrix`. Phase would require either
  complex accumulation (two reals + a rotation) or a per-channel delay line — a **kernel change**, not just a
  new field.
- **The deck 0–1 normalization convention** (raw ~1e-4 → silence) assumes real magnitudes; a phase channel sits
  orthogonal to it.

**Verdict for the proposal:** the operator's algorithm wants a **complex weight (gain AND phase) per
(mode/channel, emitter)**. The current data model expresses only real gain. **Carrying phase requires a
coordinated change across (1) the stored preset schema, (2) the middleware `SoundChannels`/`preset_injector`
data path, and (3) the CUDA kernel's per-mode accumulation.** This is a FOUNDATIONS-level data-model change and
must be surfaced as such — it is not "new values into an existing field."

---

## (c) Who writes the coefficients today + what normalization is applied

**Origin — MEASURED/DERIVED from FFT, not hand-tuned.**
`PianoidCore/pianoid_middleware/modal_adapter/feedin_extractor.py::extract_for_scenario` (lines 44–85):
`sound_coeffs = per_channel.sum(axis=1)` then `sound_coeffs /= sc_max` — per-channel sum of FFT magnitudes,
normalized so max = 1 *per scenario/pitch*. **[SRC]**

**Note — this covers the LIVE modes-mode object.** Since all shipped presets run `listen_to_modes=True`, the
`mode_sound_channels.coefficients` written below IS the operative sound-channel store; the strings-path writers
feed the (inert-in-modes-mode) `string_coefficients`.

**Writers —** `PianoidCore/pianoid_middleware/modal_adapter/preset_injector.py`:
- `_build_sound_channels_from_feedin` (line 442) — builds `mode_sound_channels`. Normalization is **opt-in via
  `PresetConfig.sound_max`** (default `None` → **raw values, no normalization**; header explicitly: "Defaults
  preserve legacy behavior (no normalization)"). Output pitches ≥128 get the **average** of all measured pitch rows.
- `_update_sound_channels` (line 731, live-engine path) — **sums** coefficients across modes and calls
  `pm.update_parameter('sound_channel', ...)`. **No normalization.**
- `_build_sound_channels_in_preset` (line 784, offline preset path) — same **raw per-mode sum**; output pitches
  get the **average** of all pitch rows. **No normalization.** **[SRC]**

`apply_service.py`, `frf_orchestrator.py`, `modal_mass_orchestrator.py` do **NOT** write sound-channel
coefficients (verified by the agent: apply = mode-apply/export/persistence; frf = spectral extraction;
modal_mass = residue→modal-mass). Authorship is confined to `feedin_extractor.py` (measure) → `preset_injector.py`
(write). **[SRC]**

**Why "not balanced properly" is consistent with the code.** The extractor normalizes per pitch to max=1, but
the injectors then **sum across modes** and apply **no per-mode 0–1 normalization and no global balancing**
unless `sound_max` is set (which only clips the global max — it does not per-mode balance). The established
project fact (memory `feedback_deck_normalization` + DOC `SYNTHESIS_ENGINE.md` lines 436–439: "engine expects
deck coefficients in 0–1; raw FFT magnitudes ~1e-4 produce silent output") prescribes **per-mode 0–1
normalization** — and that step is **absent from the current injector code**. For the DORMANT
`string_sound_channels` store the only "balancing" is a flat **40.0/channel default** for legacy presets.
**[MEASURED-PRIOR + SRC + DOC]**

---

## (d) Emit-and-measure machinery — EXISTS vs NEW; offline/live; the page-fault constraint

**Two objective terms, two surfaces** (per `PROJECT_CONFIG.md#verification-surfaces`):

| Term | How computed | Surface | Tool today |
|---|---|---|---|
| **Total drive RMS across channels** | `np.sqrt(mean(x²))` on the **emitted drive vectors** — a property of the signal you generate, **no device/render** | `audio_off` (offline/free) | `mic_testing.AudioProcessor.calculate_rms`, or trivial numpy |
| **Acoustic output loudness** | **requires a live mic** capturing real emitter output | `audio_on` (mic) | see paths below |

**EXISTS (reusable):**
- **Emit-signal + multichannel-record primitive:** `sdl_audio_core.measure_room_response_auto` /
  `..._multichannel` (C++ SDL3 extension, vendored from `D:\repos\RoomResponse\sdl_audio_core\`, built by
  `build_pianoid_cuda.bat`), wrapped by
  `PianoidCore/pianoid_middleware/modal_adapter/measurement/recorder.py::RoomResponseRecorder`.
- **Arbitrary-frequency sine BURST:** `recorder._generate_single_pulse` (line 503) `impulse_form="sine"` emits
  `sin(2π·pulse_frequency·t)`; `_generate_complete_signal` tiles it into a pulse train.
- **Loudness/level:** `mic_testing.AudioProcessor.calculate_rms` (RMS), `signal_processor.compute_spectral_analysis`
  (FFT magnitude / dB), and the engine's Goertzel `transferRatio` path (`measurement_engine.py`, `acoustic_tuner.py`).
- **Two mic paths:** (1) modal-adapter `sdl_audio_core` recorder on **port 5001** — opens its OWN device, needs
  the engine to `POST /pause_synthesis` first; (2) the engine's own `CaptureBuffer` / `MeasurementEngine`
  semi-offline `audio_on` path on **port 5000** (needs `_MIC_LOOPBACK_CONFIGURED=True` + speaker→mic loopback).
- **Offline render:** `runOfflinePlayback` + `getRecordedAudio`, and the `note_playback` chart — but this yields
  the **engine's synthesized output waveform**, NOT a physical drive→room→mic model.

**NEW (must be built):**
1. Independent **per-emitter drive with controlled amplitude AND phase** (current binding = single mono output).
2. Continuous **arbitrary-tone emission at a target mode frequency** (current is a fixed pulse train).
3. The **amplitude/phase optimization loop** (max mic loudness / min drive RMS) — absent from BOTH repos.
4. A **data-model bridge** physical emitters ↔ output sound channels + where phase results persist (see (b)).
5. There is **NO acoustic model that avoids a mic** — the loudness term is unavoidably live-mic. **[SRC + DOC]**

**Reference clone (`D:\repos\RoomResponse`, read-only):** `RoomResponseRecorder.py`,
`calibration_validator_v2.py`, `gui_calibration_impulse_panel.py`, and the `sdl_audio_core` C++ are **already
vendored in-tree** (as `measurement/recorder.py`, `measurement/calibration_validator.py`, the built extension) —
re-porting is unnecessary. RoomResponse has **no** amplitude/phase optimizer or per-emitter phased drive either.
**[SRC]**

**The 0xC0000006 page-fault constraint — exact bite + safety.**
- **Location:** `calibrate_output_scale` (`PianoidCore/pianoid_middleware/pianoid.py:935`) →
  `_measure_bare_synthesis_peak` (line 884) → `runOfflinePlayback` (line 924), under `self.cuda_lock`. Invoked
  from the **load path (line 2525)** and **`switch_preset` (line 3304)**; a `sound_channel`/`string_sound_channel`
  edit is in `LOUDNESS_AFFECTING_PARAMS` (line 987) so it **invalidates the cache** → the next load/switch
  re-renders. **[SRC]**
- **Status on master:** **UNGUARDED.** The only skips are the `output_scale_calibrated` cache flag and
  `if not use_placeholder`; neither checks realtime/ASIO liveness. The **analytic re-derivation** described in
  memory (`project_no_offline_render_in_live_backend`) is on feature branch
  `feature/dev-volpitch-impulse-conserve @ 1cb52fb`, **NOT on master** — flag this divergence. **[SRC + MEASURED-PRIOR]**
- **Safe vs unsafe:** UNSAFE = `runOfflinePlayback` inside a live realtime+ASIO backend (page-faults 0xC0000006
  on preset-switch). SAFE = (a) an offline-only backend (ASIO/realtime never started), (b) the engine's
  semi-offline `enter_calibration_mode(keep_audio=True)` (line 519) which stops the online run-loop first,
  (c) a separate process. **[MEASURED-PRIOR + SRC]**
- **Does it block THIS feature? NO.** Drive-RMS needs no render at all (property of the generated signal), and
  the acoustic-loudness term uses the mic path, which does not call `runOfflinePlayback`. The operational rule to
  respect is simply: don't call `calibrate_output_scale`/`runOfflinePlayback` while the live ASIO+realtime engine
  runs, and let the mic emit-loop own the device (semi-offline engine, or 5001 recorder after `/pause_synthesis`).
  **[SRC]**

**Note:** `calibrate_output_scale` is a **loudness** calibration (peak → −2 dBFS via `output_scale`),
**distinct** from sound-channel *balancing*. Do not conflate.

---

## (e) Plausible module home + REST surface + frontend host (facade frozen)

**Emitters vs output sound channels are DIFFERENT entities.** "Emitter" (physical actuator / voice-coil driving
the real soundboard) is **not a first-class synthesis entity** — the term does not appear in middleware source
or synthesis docs. Its representatives: `recorder.py impulse_form="voice_coil"`, and `mapping.py`'s
"excitation points" (`MappingConfig.excitation_to_pitch`) + "response channels" (`channel_to_sound`). An "output
sound channel" is the data-model receiver (output pitch 128+, a soundboard-proxy "sound string"). **The
calibration ACTS on physical emitters (drive signals) and would STORE into output-sound-channel coefficients
(`string_coefficients` at pitch 128+) — a mapping the proposal must define (how many emitters ↔ which channels).**
Currently `sdl_audio_core` drives only a **single mono output**, so multi-emitter phased drive is unsupported.
**[SRC + DOC]**

**Module home (facade `modal_adapter.py` ~1755 LOC is FROZEN — land in service modules):** the feature has three
verbs mapping to two owners plus a gap:
- emit tones + measure acoustically → closest pattern: `measurement/` subpackage (`recorder.py`, `mic_testing.py`,
  `signal_processor.py`) + `setup_test_engine.py` (the "Setup Test / Test Pulse" emit→capture→validate cycle).
- write coefficients → `preset_injector.py` (owns sound-coeff writing incl. `sound_max` normalization) +
  `apply_service.py` (apply-to-live).
- pause/measure/resume coordination → `live_processing_orchestrator.py`.
- **Verdict: a NEW service module is warranted** (e.g. `sound_channel_calibrator.py` /
  `output_calibration_service.py`) that **composes** the above — no existing module owns the full
  emit→measure→solve→write loop. **[SRC]**

**REST surface:** the modal adapter is a single `modal_bp` Blueprint (`url_prefix=/modal`), mountable on **5001**
(modal-only) or **5000** (combined "main" role); engine-touching endpoints require `role=='main'` + `get_pianoid`.
Follow the existing `POST /modal/measurements/<id>/setup_test` (emit→capture→report) and
`POST /modal/apply_to_preset` (main-role write) patterns. Plausible new endpoint:
`POST /modal/calibrate_sound_channels` in a new `calibration_routes.py` (or folded into `measurement_routes.py`);
it will need `role=='main'` (it emits on the engine + writes coefficients). **[SRC]**

**Frontend host:** `PianoidTunner/src/components/SoundChannelsPane.jsx` + `hooks/useSoundChannels.js` — already
owns per-channel (strings axis) and per-pitch (modes axis) coefficient editing. **Cross-layer caveat:** this pane
is a **main PianoidTuner editor that writes to the ENGINE backend (port 5000)** — it has **no 5001 client wiring
at all** (grep: zero `/modal` / 5001 references). The Modal Adapter UI is the separate
`src/modules/ModalAdapter.jsx` (`useModalAdapter.js`, mounted at 5001). **[SRC]**

**Cross-layer leak risk (flag for design):** the feature spans **both servers** — emit on engine (5000), mic
capture on modal-adapter (5001), write coefficients (both paths exist). A "calibrate" button in
`SoundChannelsPane` (a 5000 panel) calling `/modal/...` (5001) is the same class of leak the modal review §3.2
catalogs. The one sanctioned cross-server pattern is the modal-adapter reaching into 5000 via
`apply_to_preset` / `pause_synthesis` / `resume_synthesis` gated by `role=='main'` — reuse
`live_processing_orchestrator`'s pause→emit→capture→resume, do not reinvent. **[SRC + DOC]**

---

## (f) Prior art, collisions, and campaign fit

**Direct object-overlap (same object — grounding, NOT competitors):**
- `docs/development/reviews/feedin-feedback-soundchannels-review-2026-06-04.md` — **authoritative data-model doc**
  for the exact object this feature writes (sound channels = output pitches 128–139; `sound_channel` vs
  `string_sound_channel` axis; the strings-mode audio tap = packed `deck['feedback']·sc_gain` output-pitch row
  scaled by `deck_feedback_coeff`; stored-vs-effective rows). **[DOC]**
- `docs/development/reviews/feedin-feedback-soundchannels-UI-review-2026-06-04.md` — the `SoundChannelsPane`
  render/edit surface + write paths (`/set_parameter/sound_channel`, `/set_parameter/feedback/output`); live
  read-backs up to ~430 raw. **[DOC]**

**Related theme, DIFFERENT object (no collision):**
- `docs/proposals/excitation-loudness-normalization-correction-2026-06-30.md` — excitation curve-energy renorm
  (excitation object, not sound channels). Methodologically the closest analog (render-based loudness trim through
  a coefficient) and a precedent for the "loudness ≠ the quantity you think" trap. **[DOC]**
- `docs/proposals/feedback-coefficient-slider-2026-06-05.md` — the `deck_feedback_coeff` scalar. **Adjacency to
  respect:** solved coefficients ride the same output-tap row this slider scales — calibrating at
  `deck_feedback_coeff=1` gets rescaled live unless you write the un-scaled `string_sound_channel` gain. **[DOC]**
- `docs/development/reviews/modal-measurement-review-2026-07-10.md` — the measured-mass → `mass_inv` seam
  (per-mode amplitude, a NEIGHBOR object). Supplies the apply-seam ownership map, the `string_sound_channel`
  DORMANCY fact, and the `num_modes + num_sound_channels ≤ num_strings` flag. Does **not** itself propose channel
  gain/phase calibration. **[DOC]**

**No existing proposal claims "output sound-channel calibration" (emit-tone → measure-acoustic → solve
gain/phase). It is an unclaimed object.**

**Campaign fit — SEPARATE effort.** `docs/proposals/modaladapter.md` (active, in composition, DO NOT EDIT) is a
Campaign-scale **Modal Adapter capture/measurement front redesign** (stages A–E: configure rig → design
excitation → validate → capture → review/finalize), foundations CP1–CP5 all tracing to "express the RoomResponse
reference exactly," WI1–WI5 on the capture surface. It **explicitly declares processing-onward (ESPRIT → …→
apply/preset_injector) OUT OF SCOPE.** Output sound-channel calibration is an **apply/output-tuning** function at
the far end, has **no principle to trace to** in that campaign, and verifies on a **synthesis-output surface**
(not capture fidelity). Recommend a **separate proposal**. **[DOC]**

---

## (g) Questions only the operator can settle (before design)

0. **WHICH matrix, and in WHICH regime? (settle before anything else.)** "Sound channels matrix … coefficients
   for each output channel on each mode" is ambiguous, and the running config makes it consequential: **every
   shipped preset runs `listen_to_modes=True` (modes mode)**, where the live store is
   `mode_sound_channels.coefficients` **`[pitch][channel]`** — if by "mode" you mean a piano key/string, this is
   your matrix. The literal `[output-channel][mode]` matrix (deck-feedback of output pitches) is live **only in
   strings mode**, which no shipped preset uses. Also: SYNTHESIS_ENGINE.md describes Belarus output via the
   strings-mode path, contradicting the measured `listen_to_modes=True` — I did not resolve this by guessing.
   **Please confirm: (a) do you mean soundboard modes or piano keys/strings by "mode"? (b) is calibration
   intended for modes-mode or strings-mode operation? (c) is your rig actually running modes mode?**
1. **Phase — commit to the data-model change?** The algorithm needs a complex weight (gain + phase) per
   (mode/channel, emitter), but the engine stores real gain only. Carrying phase requires coordinated changes to
   the preset schema, `SoundChannels`/`preset_injector`, AND the CUDA kernel's per-mode accumulation. Is the
   feature approved to make that FOUNDATIONS-level change, or should v1 be **gain-only (optionally with sign)**
   and phase deferred?
2. **Emitter ↔ output-channel mapping.** How many physical emitters (actuators) exist, and how do they map to the
   `num_channels` output sound channels (1:1? N:M?)? The calibration acts on emitters (hardware drive) but stores
   into output-channel coefficients — the mapping is currently undefined in the data model.
3. **Where do results persist, and against the slider?** Into the DORMANT `string_sound_channels` store (would be
   its first live writer, avoids the `deck_feedback_coeff` rescale) or the `sound_channel`/feedback path (rescaled
   live by the slider)? And per-preset or global?
4. **Measurement rig reality.** Is a calibrated mic + speaker→mic loopback actually available on the run machine
   for the live acoustic-loudness term? (No offline substitute exists.) Which mic path — the 5001 `sdl_audio_core`
   recorder or the engine `MeasurementEngine` `audio_on` loop?
5. **"Total RMS of all the channels" — scope of the constraint.** Is drive RMS summed across emitters at the
   optimum for a single target mode, or a joint objective across all modes/channels at once? (This shapes whether
   it is a per-mode solve or a global one — needed to scope the surface, not to design the objective.)

---

## (h) UNVERIFIED / source-only facts (explicit list)

- **Phase absence + `real=float` type** — [SRC], personally verified in `pianoid_types.h` and `SoundChannels.py`;
  no dedicated doc states "coefficients cannot carry phase." (High confidence; verified, but doc-tag it if used in
  the proposal's foundations.)
- **`num_modes + num_sound_channels ≤ num_strings`** — [SRC], real but source-tagged only. Stated in
  `modal-measurement-review-2026-07-10.md:256` and `string-mode-coupling-mode-scaling-context-2026-06-06.md` as
  `[SRC]` from `create_belarus_preset.py:55`; root cause = mode-sound-channel coeffs injected at feedin columns
  `[num_modes .. num_modes+num_channels)` in a `num_strings`-wide row. Not in a primary module doc.
- **`dev_deck_parameters` packing detail** (`pack_deck(single_matrix_mode=True)` = `feedin.ravel()` only under
  `USE_SINGLE_DECK_MATRIX=1`) — [SRC], corroborated by DATA_FLOWS but the column-layout specifics are source.
- **`string_sound_channels` DORMANCY** (no frontend writer) — [DOC] per DATA_FLOWS §2.4 / review §6, but "no FE
  writer" is a source/grep-established negative.
- **`calibrate_output_scale` unguarded on master** + analytic re-derivation living only on feature branch
  `feature/dev-volpitch-impulse-conserve @ 1cb52fb` — [SRC + MEASURED-PRIOR]; the page-fault itself is
  measured-prior (memory `project_no_offline_render_in_live_backend`).
- **`num_channels` = 4** — [MEASURED] settled by reading all preset JSONs (was a 4-vs-5 doc dispute; REST_API's 5
  is stale). All presets: `num_channels=4`, `num_strings=224`, `num_modes=196` (100 Baseline/ESPRIT_v2).
- **`listen_to_modes=True` for ALL shipped presets** (default `BaselinePreset1.json` + every Belarus variant) —
  [MEASURED] read from preset `model_parameters`. Consequence: the LIVE sound-channel store is
  `mode_sound_channels.coefficients` `[pitch][channel]`, NOT the strings-mode objects. This is the load-bearing
  correction of this follow-up.
- **Modes-mode output-channel derivation** (`mode_channel_num = modeNo − modeChannelIndex + 1`, channel = a mode
  slot beyond `num_modes`) — [SRC: `Kernels.cu:249-256`]; not in a primary module doc.
- **DOC TENSION (unresolved):** SYNTHESIS_ENGINE.md "Audio Output" describes Belarus output via the **strings-mode**
  sound-string path (pitch ≥128, `outerSoundChannel`), but every Belarus preset measures `listen_to_modes=True`
  (modes mode). Either doc staleness or a mode-flag subtlety — **needs live measurement to resolve; not resolved
  here (no guessing).** Material because it decides which object is the operator's live "sound channels matrix".
- **Emitters not a first-class entity** — [SRC]; the term is absent from middleware source and synthesis docs;
  its only representatives are `impulse_form="voice_coil"` and `mapping.py` excitation-points/response-channels.
- **Multi-emitter phased drive unsupported by `sdl_audio_core`** (single mono output) — [SRC], from reading the
  binding; not doc-stated.

---

*Grounding only. No algorithm or objective function designed here — that is the proposal's job. This document is
the `/compose-proposal` agent's input: FACT = [DOC]/[MEASURED-PRIOR], provisional = [SRC], open = the (g) questions.*
