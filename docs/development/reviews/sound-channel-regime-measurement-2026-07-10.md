# Sound-Channel Regime — Empirical Measurement

- **Agent:** dev-scrm
- **Date:** 2026-07-10
- **Type:** MEASUREMENT-ONLY (no source fixes). Settle which sound-channel object the audio path
  consumes when the operator's default preset is loaded, and whether `SYNTHESIS_ENGINE.md`
  "Audio Output" is stale.
- **Method:** live engine brought up `audio_off` (`audio_on=0`, `start_right_away=0`, no ASIO, no
  realtime thread), default preset loaded, state read back + perturbed via existing REST endpoints
  (read-modify-restore), corroborated with kernel + host-packing source under doc support.
  No offline render was triggered (safety constraint); no source was edited.

---

## TL;DR

| Question | Answer (measured) |
|---|---|
| (a) Regime of operator default preset | **MODES** — `listen_to_modes=True` in the loaded engine |
| (b) Sound-channel object the audio path consumes | **`mode_sound_channels`** (`ModeSoundChannels.coefficients`). `string_sound_channels` is inert in this regime |
| (c) Is `SYNTHESIS_ENGINE.md` "Audio Output" stale? | **YES — stale/misleading** as the active-path description for shipped presets |
| (d) `num_channels` | **4** (measured). REST_API.md's "5" is a *different field*, not stale |
| (e) `num_modes + num_sound_channels <= num_strings` | **Unenforced at runtime** — a build-script comment + structural padding only |
| (f) Instrumentation left behind | **None** — temp probe abandoned (lock conflict); only reverted live perturbations |

---

## Setup (measured, not assumed)

- Backend started via launcher `POST :3001/api/start-backend` (pid 15740); `GET :5000/health` →
  `gpu_available=True`.
- Loaded `presets/BaselinePreset1.json` (the operator default, `PROJECT_CONFIG.md#defaults`) with
  `audio_on=0, start_right_away=0, audio_driver_type=2` → `200 {"reinit":"full"}`.
- `GET /health` confirms fully `audio_off`: `lifecycle.audio_driver_active=False`,
  `backend_thread_running=False` (no realtime thread, no ASIO device). The known
  `calibrate_output_scale` / offline-render page-fault condition (realtime + ASIO) is therefore
  absent, and no offline-render path was invoked regardless.

---

## (a) Regime — MODES, measured

- `GET /health` → **`listen_mode: True`** (`= pianoid.mp.listen_to_modes`, backendServer.py:3113).
- `BaselinePreset1.json` **omits** `listen_to_modes` → `pianoid.py:244`
  `model_parameters.get('listen_to_modes', True)` defaults it to **True**. So the operator's default
  preset runs the **modes** regime by default; the live readback confirms it.
- `GET /get_parameter/sound_channel/60` `_meta` → `mode_channel_index=100`, `num_channels=4`.
  `feedin/60` row length = 100 → `num_modes=100`. The sound-channel mode taps therefore ride at mode
  indices **100..103**, immediately above the 100 real modes.

## (b) Object consumed by the audio path — `mode_sound_channels`

The two output paths are **mutually exclusive**, keyed on `listen_to_modes`, proven in the kernel:

- `Kernels.cu:249-251` — `if (!listenToModes) channel_num = outer_sound_s[index];` → the **strings**
  output tap (`outerSoundChannel`, `parameters[24*arraySize]`) is non-zero **only when
  `listen_to_modes=0`**.
- `Kernels.cu:255-256` — `if (listenToModes && modeNo in [modeChannelIndex, +numChannels))
  mode_channel_num = modeNo - modeChannelIndex + 1;` → the **modes** output tap
  (`outerSoundModeChannel`, `parameters[26*arraySize]`) is non-zero **only when
  `listen_to_modes=1`**.

Under `listen_to_modes=True` the strings output tap is dead (`channel_num=0`), so the audio comes
from the **mode-direct** write:

```cpp
// MainKernel.cu:714-721
if (outerSoundModeChannel) {
    int sampleIndex = (outerSoundModeChannel - 1) * samplesInCycle + main_cycle_index;
    if (indexInQuarter == 0) {
        real result = s_mode_applied_force[quarterNumber];      // <-- the audio sample
        soundInt[sampleIndex]   = Sint32(result * main_volume_coefficient);
        soundFloat[sampleIndex] = float(result);
    }
}
```

`s_mode_applied_force` is the string→mode feedin force reduced from `feedin_cycle_matrix`
(`MainKernel.cu:676-698`). The **provenance of which coefficient scales it** is the host packer
`StringMap.pack_pitch_feedin` (StringMap.py:450-476):

```python
if self.mp.num_channels > 0:
    sc_idx = self.soundChannelModes.get_index()          # = [100,101,102,103]
    feedin[sc_idx] = (self.soundChannelModes.get_coeff(pitchID)     # <-- mode_sound_channels
                      * self.soundChannelModes.get_mute(pitchID)) if self.mp.listen_to_modes else 0.0
```

So **`mode_sound_channels` coefficients are injected into `feedin[100:104]`** (the exact deck slots
the tap modes read) **iff `listen_to_modes` is True; otherwise those slots are zeroed.** That feedin
becomes `s_mode_applied_force` for the tap modes → the audio output. Conversely
`string_sound_channels` (`string_coefficients`) is applied (StringMap.py:457-461) only as `sc_gain`
on **output-pitch (`pitch.outerSound`, pitch ≥ 128) feedback** — i.e. it scales the **strings**
output tap, which is dead under `listen_to_modes=True`. For a key pitch (e.g. 60) the string branch
is not even taken. `string_sound_channels` is therefore **inert in the modes regime**.

**Live perturbation (read-modify-restore, on the running engine):**

| Object | Endpoint | baseline | set → | readback | restored |
|---|---|---|---|---|---|
| `mode_sound_channels` | `POST /set_parameter/sound_channel/60` | `[0.3,0.3,0.3,0.3]` | `[0.9,0.1,0.2,0.3]` | `[0.9,0.1,0.2,0.3]` ✓ | `[0.3,0.3,0.3,0.3]` ✓ |
| `string_sound_channels` | `POST /set_parameter/string_sound_channel/60` | `[40,40,40,40]` | `[11,22,33,44]` | `[11,22,33,44]` ✓ | `[40,40,40,40]` ✓ |

Both objects are independently addressable, live model state; each `set` returned `200` (the
model-update + re-pack + GPU upload path ran without error), and `listen_mode` stayed `True`
throughout. This confirms both are real, distinct, live objects; the kernel + packer source above is
what proves the **modes-regime** output reads the `mode_sound_channels` object and not the
`string_sound_channels` one.

**Evidence-strength caveat (honest scoping).** A direct audio-output A/B (zero one object's channel
column, render, observe which channel goes silent) was the ideal test but was **not run**: an offline
render was off-limits under the session's safety constraint, and a device-slot readback probe would
have required editing `backendServer.py`, which is **locked by agent dev-t3cu** (MODULE_LOCKS.md:24).
The consumption conclusion therefore rests on the kernel mutual-exclusivity (`Kernels.cu:249-256`) +
the host-packing provenance (`StringMap.py:464-469`) — both definitive and doc-supported — corroborated
by the measured `listen_mode=True` and the live perturbation of both objects. It is not left to
source-inference alone: the regime and object existence/mutability are measured on the running engine.

## (c) `SYNTHESIS_ENGINE.md` "Audio Output" — STALE / MISLEADING

The "Audio Output" section (SYNTHESIS_ENGINE.md ~L495-549) presents the **strings-mode** path as *the*
audio output, e.g.:

> "Audio is emitted from virtual 'sound strings' that act as soundboard proxies, driven by the mode
> feedback. In the current `Belarus_8band_196modes` layout ... these are strings 220-223. They are
> the strings with `pitch ≥ 128` ..."

and the per-sample write it documents as the output is the **strings-mode** formula:

> `real diff_result = feedback - s_b; ... soundInt[sampleIndex] = Sint32(output * main_volume_coefficient);`

with:

> "The preset configures exactly 4 output channels in Belarus_8band_196modes, yielding 4 of the 22
> strings as 'sound strings' with `outerSoundChannel` values `1..4` ..."

**This is the `listen_to_modes=0` path.** Every shipped preset (BaselinePreset1 and the Belarus
variants) runs `listen_to_modes=True`, under which that path is **dead** (`channel_num=0`) and the
audio instead comes from the mode-direct path (`output = s_mode_applied_force`, `MainKernel.cu:714-721`).
The doc relegates the actually-active path to a 3-line afterthought:

> "There is also a parallel **mode-direct output path** for listen-to-modes mode
> (`MainKernel.cu:623-630`) that writes `s_mode_applied_force[quarter]` directly when
> `outerSoundModeChannel > 0` — used when `listen_to_modes=1` ..."

Two problems: (1) it frames the **active** path (for every shipped preset) as a secondary tap, and
(2) the line reference **`MainKernel.cu:623-630` is stale** — the mode-direct write is at
**`MainKernel.cu:714-721`**. The section's strings-mode mechanics are accurate *for
`listen_to_modes=0`*, but as a description of how shipped presets produce audio it is
**wrong/misleading**. The contradiction the grounding analysis flagged is **REAL and confirmed**.
(The later "Sound-Channel Gain Path (strings mode)" subsection is correctly scoped to
`listen_to_modes=0` and is not at issue.)

## (d) `num_channels` = 4 (measured); REST_API.md "5" is a different field

- Measured live: engine `num_channels=4` (`sound_channel/60` `_meta`, and the 4-element coefficient
  vectors). Matches every shipped preset's `mode_sound_channels.num_channels`.
- REST_API.md's only `num_channels: 5` (REST_API.md:2012) is **`measurement_info.num_channels`** in
  the `GET /modal/project_state` response for the `belarus_78` **modal-measurement project** — the
  measurement-rig channel count, a **same-name-different-thing** vs the engine's audio-output
  `InitializationParameters.num_channels`. It is **not** a stale statement of the engine's channel
  count. The "REST_API is stale about num_channels" suspicion is therefore **REFUTED** — the correct
  note is that it's an easily-confused same-name pair (per `PROJECT_CONFIG.md#data-model-facts`).

## (e) `num_modes + num_sound_channels <= num_strings` — unenforced at runtime

- No runtime engine assertion exists. The relationship is:
  - a **comment** in a preset-build script: `create_belarus_preset.py:55`
    `# (num_modes + num_sound_channels must be <= num_strings = 224)`;
  - **structural**: the kernel forces `num_modes_for_model = num_strings` (`pianoid.py:251`,
    `ModeMap(..., num_modes_for_model=self.mp.num_strings)`), so the deck row width is `num_strings`
    and the sound-channel taps (at `mode_channel_index..+num_channels`, here 100..103) occupy dummy
    slots above the real modes.
- So the previously-UNVERIFIED "constraint is a source-comment claim, not enforced" is **CONFIRMED**:
  it is a construction-time invariant + structural padding, with **no runtime guard**. Loading a
  preset that violates it would not be rejected by any assertion — the taps would collide with real
  mode/string slots.

## (f) Instrumentation — none left behind

- No source was edited. The intended temporary read-only probe route in `backendServer.py` was
  **abandoned** because that file is locked by agent dev-t3cu (MODULE_LOCKS.md:24).
- The only live mutations were the two perturbations in (b), each **restored** and re-verified
  (`sound_channel/60` → `[0.3×4]`, `string_sound_channel/60` → `[40×4]`).
- All four repo trees carry no changes from this session (this review doc + the session log are the
  only additions).

---

## Source references

- `Kernels.cu:249-256` — regime-keyed output-tap selection (mutual exclusivity).
- `MainKernel.cu:714-721` — mode-direct audio write (`s_mode_applied_force`); `MainKernel.cu:522` — strings-mode write (`feedback - s_b`).
- `StringMap.py:450-476` (`pack_pitch_feedin`) — `mode_sound_channels` → `feedin[sc_idx]` (modes regime); `string_coefficients` → output-pitch `sc_gain` (strings regime).
- `pianoid.py:244` (`listen_to_modes` default True), `pianoid.py:251` (`num_modes_for_model=num_strings`).
- `backendServer.py:3113` (`/health.listen_mode`), `:1359` (`load_preset` `listen_to_modes` default 1).
- `create_belarus_preset.py:55` — the constraint comment.
- Docs: `SYNTHESIS_ENGINE.md` "Audio Output" (stale); `REST_API.md:2012` (`measurement_info.num_channels`).
