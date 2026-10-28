# Tuning-latency study: parameter change → audible at In 8 (2026-10-23, lat-3636)

**Question (user, Telegram):** how long does it take from changing a parameter to hearing the change? Cover all
parameters, look closely at excitation, and find the source of every large delay.

**Scope:** measurement and root-cause analysis only. No source was edited. Instrumentation lived only in
`docs/development/diagnostics/latency-2026-10-23/`: client scripts, a page-side tap (an `initScript`) and, for
the stage breakdown only, a `sitecustomize` timing shim that was loaded through `PYTHONPATH`. Audio and traces
are in `D:\modal_measurements\latency-2026-10-23\`. Builds measured: Core `dev` 72b2c85, Tunner `dev` 9747061,
Basic `dev` 4c4e485. The Tunner ran as the CRA **development** build (`npm run dev`), which is what the user runs.

## Summary

| # | Finding | Size | Where |
|---|---|---|---|
| **1** | **A string-physics edit (Strings panel: tension, damping, stiffness, density, radius, length, detuning, dispersion damping) is often not heard until the next note event.** The upload raises the "run parameterKernel" flag right after it *queues* the asynchronous double-buffer upload. The engine consumes the flag at its next cycle, before the swap has landed, and recomputes the string coefficients from the **old** buffer. Nothing raises the flag again after the swap. | about 80 % of edits: latency = time to the next key press, key release or pedal event (measured 163–1033 ms; unbounded while you hold a note). Otherwise 14–22 ms. | `Pianoid_parameters.cu:541` (and `:457`), `Pianoid_synthesis.cu:300` |
| **2** | **Excitation edits get slower with the number of pitches, and the per-row "fast path" for 1–8 pitches is the slowest.** Each string row is its own double-buffer swap (about 4 ms each, waited with the GIL held). The temporal impulse is also recomputed for all 6 levels of every edited pitch, on a 4096-point grid. | first strike that reflects the edit: 1 pitch 40 ms · 8 pitches **320 ms** · 9 pitches 80 ms · 12 pitches 160 ms · 88 pitches **640 ms** | `parameter_manager.py:329, 354-364, 903-919`; `excitation_coefficients.py:254`; `Pianoid/StringExcitation.py:63, 366-408` |
| **3** | **Frontend: about 145–320 ms pass between Enter and the network write.** On keydown the DEV-build React tree re-renders synchronously (one 90–160 ms task), and the debounced emit fires only after that. Hammer fields add a 150 ms "staged" settle. | Enter→emit: mode 144–158, tension 157–178, excitation curve 231–241, hammer position 304–321 ms | `usePreset.js:18-46,50`; `HammerStringChart.jsx:87`; Chrome trace |
| **4** | **Sliders send nothing while they are being dragged.** The debounce is trailing-only (50 ms), so continuous pointer moves keep resetting it. | 600 ms volume drag: first audible change 660–757 ms after the drag starts | `usePreset.js:18-46` |
| **5** | **A large excitation write delays notes played at the same time.** Python-heavy model rebuilding makes the socket and MIDI threads queue for the GIL. | a note-on sent during an 88-pitch curve write: 71–267 ms instead of 19–26 ms (hammer, 88 pitches: 53–75 ms) | `StringExcitation.load_from_dict` / `level_impulse` |
| **6** | After every edit the browser main thread is blocked by a chain of 60–150 ms React renders for 0.5–0.9 s. Each `state_changed`, `history_changed`, `param_ack`, backend-console log line and `midi_message` triggers a render. Notes played from the page in that window are delayed by up to ~130 ms. | | Chrome trace / `longtask` observer |
| — | **Fixed floor of the engine path:** a note or parameter event reaches In 8 about 20 ms after it is scheduled. That is the 8-chunk ring (10.7 ms), plus the ASIO out→in loop (329 frames, 6.9 ms), plus up to one 1.33 ms cycle. Runtime, mode and deck edits sit on this floor (15–25 ms over WS, 30–45 ms over REST). | | `pianoid.py:3000` (`circular_buffer_chunks = 8`) |

The user's most likely experience is "hold a note and turn tension, nothing happens until I strike again". That
is finding 1. Excitation-curve work across many keys feels sluggish because of findings 2, 3 and 5.

## Method

**Rig.** UMC1820 on ASIO (callback driver 4), 48 kHz, 64-frame buffer. A physical cable runs from Out 9 to In 8
(loop gain about +1.5 dB, noise floor about −101 dBFS). The backend ran with `PIANOID_AUDIO_OUTPUT_MAP=8,1,2,3,4,5,6`,
so engine channel 0 played on Out 9. Channel 0 was chosen because it is one of the two loudest channels by the
`/health` latched peaks. Capture used the engine's own mic capture (`POST /set_mic_device {"input_channel":7}`,
then `POST /play_keyboard capture_mic`), so synthesis kept running and no second ASIO client was opened.

**Preset and settings.** `Tuning18-10-26ver1` with the user's exact load dictionary, taken from
`backend_stdout.log`: array 512, string_iterations 8, cycle 64, d2, `listen_to_modes 0`, `listen_to_midi 1`,
buffer 4, volume 127. That gives 196 modes, 236 strings and 7 channels. The user's own Chrome tab stayed
connected all night and auto-loaded the same dictionary.

**Clock.** Every timestamp is epoch time from `time.time()` in Python or `performance.timeOrigin + now()` in the
browser. Both read the same Windows system clock on the one host.

**Anchoring a capture.** The request time of the capture call is useless as an anchor: the handler starts
−4 to +17 ms after it. Instead, every capture contains a WS `NOTE_ON` sent by the client.

- A note scheduled inside the capture handler reaches In 8 after **exactly 975 samples (20.31 ms)**, 5 of 5
  times. That figure includes the ring, the hardware loop and the phase lock to `bufferSwitch`.
- So the anchor time of a capture sample is `t_note_send + 1.3 ms (WS one-way) + 20.3 ms`.
- Uncertainty is about ±3 ms (WS one-way time measured at 0.5–3 ms).

**Detector.** The live engine is **bit-exact** from run to run. With a silent marker pitch (127), a reference
capture and a repeat capture differ by 0 above the 4-LSB16 noise floor. Each trial is therefore compared with a
reference capture of the identical sequence without the change, aligned on the note onset. Two times are taken:

- `first`: the first sustained non-zero difference.
- `m40`: the first time the difference envelope exceeds −40 dB relative to the signal. This is the
  "audible" figure used in the tables.

**Excitation.** A change is sent at t = 0.3 s and p60 v127 is struck d ms later. The strike is compared bit-exactly
with an "old value" reference and a "new value" reference and classed **old**, **new** or **mixed** (matches
neither, so it caught a half-applied upload). `first_all_new` is the smallest d from which every strike is new.

**Layers.**

- Direct WS `emitWithAck` and REST from Python (exp03, exp04).
- The real UI: chrome-devtools page, real CDP click / fill / Enter, mouse drags, and an epoch-stamped WS/XHR tap.
- Backend stages from the shim (exp06): epoch intervals for `_apply_parameter_request`, `edit_commit`,
  undo, `ParameterManager` methods, every C++ call the manager makes, and `cuda_lock` wait/hold.
- py-spy sampling of the backend during writes.
- Chrome performance trace (CPU profile and long tasks).

The shim's ack times match the stock backend within noise (excitation 1 pitch 30 vs 24 ms, 8 pitches 190 vs
182 ms, 88 pitches 618 vs 639 ms, hammer 8 / 24 / 109 vs 8 / 22 / 108 ms), so it does not distort the results.

N ≥ 3 for every cell. Values are median [min–max] in ms.

## Results per parameter family (direct layer)

Change sent at t = 1.0 s while p60 v100 is held. Latency is measured from the client send to the change at In 8.
WS is the transport the FE uses by default for string, mode, excitation, hammer and runtime; REST is its default
for feedin, feedback, sound-channel and masks.

| Case | WS ack | first divergence | audible (m40) |
|---|---|---|---|
| runtime volume 64→90 | 3 [2-3] | 12 [10-12] | **18** [16-18] |
| runtime feedback_coeff ×0.5 | 2 [2-5] | 13 [13-13] | **19** [18-19] |
| runtime volume_center ×2 | 2 [2-3] | 12 [11-12] | **18** [18-18] |
| string tension ×1.02 | 5 [5-12] | 1010 [15-1024] | **1020** [22-1031] |
| string gamma (damping) ×3 | 6 [5-7] | 1024 [16-1031] | **1085** [31-1094] |
| string jung (stiffness) ×1.5 | 5 [5-5] | 14 [13-1024] | **21** [20-1051] |
| string rho (density) ×1.02 | 10 [8-14] | 1014 [1013-1016] | **1023** [1023-1023] |
| string r (radius) ×1.05 | 5 [5-7] | 1016 [1013-1028] | **1074** [1071-1090] |
| string length ×1.02 | 7 [6-9] | 1014 [1012-1025] | **1023** [1021-1034] |
| string detuning ×4 | 10 [8-28] | 1020 [1010-1025] | **1045** [1038-1054] |
| string dispersion_damping ×100 | 6 [6-6] | 1016 [700-1026] | **1036** [1023-1038] |
| string tension, 12-pitch range | 7 [7-8] | 1022 [14-1036] | **1033** [21-1042] |
| string tension, 88-pitch range | 14 [14-15] | 21 [20-1032] | **29** [29-1042] |
| mode 0 frequency ×1.05 | 6 [5-13] | 15 [15-16] | **22** [22-22] |
| mode 0 decrement ×3 | 5 [5-17] | 15 [12-19] | **21** [19-24] |
| mode 0 mass_inv ×2 | 5 [5-9] | 14 [14-15] | **21** [21-21] |
| all 196 modes frequency ×1.02 | 25 [12-40] | 23 [15-43] | **26** [24-28] |
| feedin p60 row ×0.5 | 16 [16-18] | 15 [13-15] | **22** [20-22] |
| feedin_mask p60 mute | 16 [16-18] | 15 [12-15] | **21** [20-21] |
| SC strings axis feedback row 128 ×0.5 | 8 [6-12] | 19 [15-22] | **23** [21-24] |
| SC strings axis feedback_mask 128 mute | 6 [5-9] | 14 [13-15] | **21** [19-22] |
| REST: feedin p60 row | 34 [29-42] | 37 [29-42] | **43** [35-48] |
| REST: mode 0 frequency | 19 [16-27] | 29 [26-39] | **37** [35-46] |
| REST: runtime volume | 24 [19-27] | n/a¹ | **38** [35-42] |
| REST: SC feedback row 128 | 17 [7-25] | 28 [16-33] | **32** [23-40] |
| REST: string tension | 6 [6-22] | 1025 [1011-1028] | **1035** [1022-1038] |

¹ The `first` detector fired on a stray sample before the send in 2 of 3 trials. `m40` is the robust figure.

The ~1000 ms values are not a delay of the change itself. They are the time until the next engine note event in
the capture, which was the silent marker's note-off at t = 2.0 s. See root cause 1.

Not measured separately:

- **Damper** (`damper_string`, `damper_tail`) acts only at note-off. Note-off is itself a parameterKernel
  trigger, so the race below cannot delay it.
- `sound_channel` (modes axis) has no effect in this strings-mode preset (`listen_to_modes 0`).
- `string_sound_channel` has no FE writer.
- MIDI-CC knobs could not be generated on this rig. They use the same `runtime_params` path as the toolbar
  sliders.

## Excitation deep-dive (strike-time parameters)

Change sent over WS at t = 0.3 s (asynchronously). p60 v127 struck d ms after the send. Letters are the
class of each of 3 strikes: o = old, n = new, m = mixed. The audible new strike arrives ~21 ms after the strike
send.

| Case | WS ack | first all-new d | strike class by d (ms) |
|---|---|---|---|
| gauss level-127 curve 2 volume ×0.5, 1 pitch | 24 [19-61] | **40** | 0:oom 2:moo 5:mmm 10:mmm 20:onn 40:nnn |
| gauss sigma ×1.5, 1 pitch | 24 [21-57] | **40** | 0:ooo 2:moo 5:mmm 10:mmm 20:nno 40:nnn |
| gauss volume, **8 pitches** (per-row path) | **182** [154-278] | **320** | ≤40:ooo 80:mmm 160:mmn 320:nnn |
| gauss volume, 9 pitches (blob path) | 77 [72-223] | **80** | ≤20:ooo 40:mmn 80:nnn |
| gauss volume, 12 pitches | 95 [90-257] | **160** | ≤20:ooo 40:mmm 80:nom 160:nnn |
| gauss volume, **88 pitches** | **639** [582-799] | **640** | ≤160:ooo 320:mmm 640:nnn |
| hammer position 0.25, 1 pitch | 8 [7-11] | **5** | 0:ooo 2:ooo 5:nnn |
| hammer width ×1.5, 1 pitch | 8 [7-24] | **5** | 2:ooo 5:nnn |
| hammer sharpness 0.8, 1 pitch | 9 [7-12] | **5** | 2:noo 5:nnn |
| hammer position, 12 pitches | 22 [20-44] | **20** | 5:ooo 10:nno 20:nnn |
| hammer position, 88 pitches | 108 [103-123] | **80** | 40:ooo 80:nnn |
| `/excitation_energy` hammer_mass ×0.5, 1 pitch | 8 [6-30] | **20** | 2:ono 5:non 10:onn 20:nnn |
| `/excitation_energy` impulse calibration ×0.5 | 19 [8-33] | **40** | 10:noo 20:non 40:nnn |
| `/excitation_energy` hammer_speeds ×0.5 | 26 [7-32] | **40** | 20:noo 40:nnn |

**Answers to the two questions in the brief.**

**(a) Latency until a struck note reflects the change.**

- One pitch: 40 ms (gauss) and 5 ms (hammer) after the send. With the strike's own ~21 ms that is about 60 ms /
  26 ms to sound.
- Excitation scales with the pitch range, and the scaling is not monotonic: 8 pitches (320 ms) is 4× slower
  than 9 pitches (80 ms).
- 88 pitches: 640 ms.

**(b) Applied or missed when the strike comes right before or during the write.**

- A strike sent before the write lands plays the old excitation, and nothing is lost.
- A strike sent while the write is in flight can catch a **half-applied** excitation (**mixed**):
  - 1 pitch: at 2–10 ms.
  - 8 pitches: at 80–160 ms.
  - 88 pitches: at 320 ms.
- So a strike within the write window plays a hybrid that matches neither the old nor the new setting.

### Where the excitation time goes (exp06 shim, N = 5, median ms per edit)

| Stage | 1 pitch | 8 pitches | 9 pitches | 12 pitches | 88 pitches |
|---|---|---|---|---|---|
| ack (client) | 30 | 190 | 84 | 99 | 618 |
| `ParameterManager.update_parameter` | 25 | 179 | 67 | 86 | 599 |
| ↳ outside `cuda_lock`: `excitation.load_from_dict` per pitch | ~2 | ~19 | ~22 | ~31 | **~206** |
| ↳ `cuda_lock` hold | 22 | 159 | 45 | 56 | 393 |
| ↳↳ per-row uploads `_gpu_upload` × n (`waitForParameterUpdate` part) | 16 × 3 (10.8) | **122 × 24 (98.7)** | — | — | — |
| ↳↳ blob upload (`pack_base_excitations` + `setNewExcitationBaseLevels`) | — | — | 3 | 3 | 3.5 |
| ↳↳ `CoefficientCache.recompose('curve')` | 4.5 | 35 | 38 | 48 | **384** |
| `edit_commit`: undo begin/finish, journal, after-snapshot | ~1-2 | ~3 | ~4 | ~4 | ~13 |

**Root causes (measured, with evidence).**

1. **One double-buffer swap costs about 4 ms, and the 1–8 pitch path pays it once per string.**
   - `_upload_excitation_rows_for_pitches` (`parameter_manager.py:354-364`) issues one `_gpu_upload` per unison
     string. Each one first calls `waitForParameterUpdate()` (`:182`).
   - Below `PER_ROW_MAX_PITCHES = 8` (`:329`) that is up to 24 sequential swaps. Measured: 24 waits = 98.7 ms,
     about 4.1 ms each. For 1 pitch: 3 waits = 10.8 ms.
   - Why a swap takes ~4 ms: `waitForUpdateCompletion` (`UnifiedGpuMemoryManager.cu:688-692`) and the poll
     thread (`:924-957`) both poll with `std::this_thread::sleep_for(100µs)`. Every swap also does a full-preset
     device-to-device sync copy (`syncBuffers`, `:894`).
   - The 1 ms Windows sleep granularity in two to three polling hops explains most of the 4 ms. This split is
     inferred from source; only the 4 ms total was measured.
   - The binding has no `gil_scoped_release` (`AddArraysWithCUDA.cpp:763`, unlike the bindings at `:407`, `:507`),
     so the GIL is held through every wait.
   - The 9+ pitch path makes **one** blob upload (3 ms). That is why 8 pitches is slower than 88 at the upload
     stage.
   - Deck edits use the same per-row pattern (`_upload_deck_rows_for_pitches`, `:331-341`). Measured: feedin
     p60, 3 rows = 8.5 ms of waits out of a 17 ms ack.
2. **The coefficient recompose recomputes the temporal impulse of every level on a 4096-point grid.**
   - `CoefficientCache._recompose_pitches('curve')` (`excitation_coefficients.py:254`) calls
     `level_impulse(lv)` for all 6 levels. Each call evaluates `gpu_force_curve`
     (`Pianoid/StringExcitation.py:63-76`) on `excitation_length = num_iterations × excitation_factor`
     = 64 × 8 × 8 = **4096** samples × 5 Gaussians.
   - The FE edit touches only one level, but all 6 are recomputed.
   - Measured: about 4.4 ms per pitch (384 ms for 88 pitches). py-spy: 53 % of an 88-pitch write is in
     `level_impulse` → `temporal_curve_impulse` → `gpu_force_curve`.
   - The grid length doubles with `string_iterations` (the user runs si = 8; the reference grid is si = 4).
3. **Model rebuild on every write.**
   - `excitation.load_from_dict` → `load_from_matrix` (`StringExcitation.py:366-408`) rebuilds 128
     `ExcitationCurve` objects, each holding 5 `GaussCurve` objects, for every edited pitch.
   - Measured: about 2.3 ms per pitch (~206 ms for 88 pitches). py-spy: 37 % of the write.
   - This is pure Python, so it is also what starves the GIL (see "concurrent notes" below).
4. **Half-applied states (mixed strikes).**
   - The unison rows land in separate swaps.
   - The coefficient table is host-side and changes when `setNewExcitationCoefficients` returns, not when the
     GPU swap lands (`Pianoid_parameters.cu:317-332`).
   - A strike in between reads new rows with an old coefficient, or the reverse.

### Concurrent notes during a write (exp08 / exp09)

**WS `NOTE_ON` sent X ms after a write started** (send → In 8; idle baseline 24 [19-26] ms):

| Write in flight | X = 10 | X = 50 | X = 150 |
|---|---|---|---|
| gauss, 8 pitches | 29 [27-31] | 24 [20-26] | 22 [19-25] |
| gauss, 88 pitches | **162** [82-219] | **159** [126-267] | **152** [71-212] |
| hammer, 88 pitches | 58 [53-75] | 35 [33-39] | 19 [19-21] |

**Second socket's `ping_ws` RTT during a write:** usually 2 ms, but with one stall per write of up to
**138–202 ms** (gauss, 88 pitches) and **55–60 ms** (hammer, 88 pitches). The stalls fall in the first
~250 ms of the write, which is the pure-Python `load_from_dict` / `update_hammer_shape` phase.

This is GIL convoying. Each I/O thread hop (engine.io read, socket.io dispatch, handler, ack write) waits up to
the 5 ms switch interval behind the CPU-bound writer. The MIDI listener is also a Python thread
(`MIDI_listener_unified`), so notes from the keyboard are exposed to the same delay. The audio engine itself did
not stall: 0 producer timeouts.

## Frontend layer (real UI, agent Chrome page, DEV build)

All inputs are real CDP input (click, fill, Enter, or mouse drag). Each figure is from Enter (or the start of
the drag) to the WS frame on the wire (tap), and on to audible where a capture ran.

| Control | Enter → emit | emit → ack seen in page | Enter → audible at In 8 |
|---|---|---|---|
| Strings: tension NumInput | 164, 157, 178 | 137-155 | 183 (race won) / 543 (race lost: waited for the next event) |
| Modes: frequency NumInput | 158, 150, 144 | 142-152 | **174, 171, 167** (= FE 143-148 + 23-26) |
| Excitation: gauss volume NumInput (FE renormalizes all 5 curves of the level) | 241, 231, 235 | 167-179 | (strike-based; next strike reflects it ≥ emit + ~13-21 ms) |
| Excitation: hammer position NumInput (`useStagedParamEdits`, 150 ms settle) | 304, 314, 321 | 139-176 | — |
| Volume slider, 600 ms drag (60 Hz mouse moves) | **one** write, 1 ms after release (641-738 ms after drag start) | ~55 | **660, 666, 721** from drag start (18-20 after release) |
| Volume slider, slow drag (one move / 80 ms) | a write ~50 ms after each move | 53-57 | follows the moves |

**Where the frontend time goes** (Chrome performance trace of one excitation edit,
`D:\modal_measurements\latency-2026-10-23\trace_exc_numinput.json.gz`):

- **The keydown (Enter) task alone runs 160 ms.**
  - Synchronous React render: 93 ms. That is `renderRootSync` over the PianoidTuner tree, in DEV React
    (`jsxDEV`, `createElementWithValidation`, `validateProperty` are all hot).
  - Commit: 49 ms, of which **44 ms is `echarts-for-react componentDidUpdate`** (the excitation curve chart).
  - The handler logic itself (`handleGaussValueChange`) is only 9 ms.
  - The 50 ms debounce timer expires during this task and fires right after it, so emit lands at ~175 ms.
- **The page then stays blocked for 0.5-0.9 s.** It is a chain of 60-150 ms `performWorkUntilDeadline` React
  renders, one per incoming frame (`state_changed`, `history_changed`, `param_ack`, and the launcher console
  stream: every backend `printf` line such as "Updating dev_gauss_params_full…" is pushed to the page), plus
  zrender animation frames (~10 ms each).
- **Effect on page-originated strikes:** they were sent up to ~130 ms late. The tap shows strikes scheduled for
  +175 to +250 ms going out at +270 to +296 ms.
- The pedal on the rig chatters CC0 between 41 and 42 on channel 3. Every page receives that as about
  5 `midi_message` events per second on 2 ports.
- "emit → ack seen in page" (55-180 ms) is mostly the page's own main-thread delay. The same payloads acked in
  2-4 ms from a Python client.

## Root cause 1 in detail: string physics waits for the next note event

**Measured (exp05, tension ×1.02 on held p60, change at t = 1.0 s, silent poke = p127 `NOTE_ON` at +X):**

| X | latency to In 8 (4 reps) |
|---|---|
| no poke (next event = marker note-off at +1000) | 1029, 1009, 1033, 1020 |
| 150 | 163, 163, **17, 15** |
| 400 | 411, 412, 413, 413 |
| 700 | 711, 713, 713, 712 |

The latency tracks the next note event exactly. Across all string trials the change was heard right away in
about 1 of 5 cases. Through the UI it went both ways: 183 ms when the race was won, 543 ms when it was lost.

**Mechanism (source):**

- `Pianoid::updateMultiStringParameter_NEW` calls `memory_manager_.updateTunableParameter(...)`. That only
  *starts* an async copy, and the state becomes UPDATING. The function then sets **`new_notes_ind = 1`**
  (`Pianoid_parameters.cu:541`; the single-string variant does the same at `:457`).
- `runSynthesisKernel` first calls `refreshSwappablePointersIfPending()` (`Pianoid_synthesis.cu:260`).
  - No swap has been published yet: the poll thread needs one or more ~1 ms sleeps plus the copy.
  - Then `nni = new_notes_ind.exchange(0)` (`:300`) launches `parameterKernel` on the **old**
    `dev_physical_parameters` (`:322`).
- The swap lands a few ms later. Nothing sets `new_notes_ind` again, so the kernel coefficients stay stale until
  the next NOTE_ON, NOTE_OFF, sustain (`processSustain`, `Pianoid_synthesis.cu:213`) or preset switch.
- The race is won only when the swap is published before the engine's next cycle.

**What the user experiences:** holding a note while changing tension, damping, stiffness and so on does nothing
until the next key or pedal event. Re-striking always picks the change up, because the NOTE_ON runs
parameterKernel first.

**Hammer edits share the dependency but are not affected.** They feed `parameterKernel` (`dev_hammer`), but the
strike's own NOTE_ON triggers it. Measured: hammer reflected 5 ms after the send.

## Fixed floor: the engine output path

- A note scheduled in the backend reaches In 8 after **20.31 ms**, constant over 5/5 runs, because it is
  phase-locked to `bufferSwitch`.
- Ring depth is 8 chunks × 1.333 ms = **10.7 ms** (`pianoid.py:3000` `circular_buffer_chunks = 8`; the backend
  log line reads "ASIO: ring depth 8 chunks").
- The ASIO electrical loop is out 168 + in 136 reported + ~25 frames of converter filter = **329 frames,
  6.9 ms** (measured on the rig).
- The rest is cycle quantization (≤ 1.33 ms).
- A WS note-on adds ~1-3 ms of transport. A REST `/play` adds ~15-20 ms (exp01: REST −2..+40 ms against WS
  −4..+17 ms around the request-time anchor).
- Every "immediate" parameter therefore sits at 15-25 ms (WS) or 30-45 ms (REST).

## Fix options

**Status (2026-10-28):** PARTIALLY implemented by dev-elat1 (Core a2659d2, Tunner c805037): F2a/F6 one swap per excitation write with the coefficient committed after the swap, F5 GIL yield per pitch, F7b send on Enter, F7f hammer fields skip the settle. Results: [tuning-latency-phase1-3-review-2026-10-28](tuning-latency-phase1-3-review-2026-10-28.md). F1, F2b/c, F3, F4, F7a/c/d/e and F8 remain open.

**F1. String physics heard immediately (root cause 1).** Re-raise the trigger when the swap is adopted, not when
it is queued.

- Option A: in `refreshSwappablePointersIfPending()`, when a swap is consumed, set `new_notes_ind |= 1`. The
  engine thread already owns that point (P1).
- Option B: have `updateMultiStringParameter_NEW` set a "physical params dirty" flag that the engine converts
  into a parameterKernel run at adoption.
- Cost: one extra parameterKernel per string-physics swap. parameterKernel already runs at every note event.
- Expected result: string edits at the same ~15-25 ms as mode edits.
- Verify with exp05 (latency must no longer track X).

**F2. Swap cost and per-row uploads (root cause 2.1).**

- (a) Make the per-row paths upload **all rows in one** `updateTunableParameter`: one swap per edit instead of
  one per string or row. Either a multi-row C++ entry, or upload the contiguous span. At minimum, lower
  `PER_ROW_MAX_PITCHES` until the per-row path beats the blob. Measured: blob 3 ms vs 4 ms per row, so per-row
  only pays off for a single string.
- (b) Replace the `sleep_for(100µs)` polling in `waitForUpdateCompletion` and in the poll thread with an
  event/condition-variable handoff, or `cudaEventSynchronize` on the update event.
- (c) Add `py::call_guard<py::gil_scoped_release>()` to `waitForParameterUpdate` (and to the `update*` entries
  that wait), so the GIL is not held through the waits.

**F3. Excitation recompose (root cause 2.2).**

- (a) Recompute `temporal` only for the level(s) in the edit payload; the FE always sends one level. That
  alone is 6× less.
- (b) Vectorize `gpu_force_curve` across levels and pitches into one numpy evaluation, or cache it by curve
  parameters.
- (c) Evaluate the impulse in closed form, as a sum of Gaussians sampled on the grid, or on a decimated grid
  with an exact scale factor. This must be checked against `test_excitation_interpolation` and the B2
  coefficient tests, because coefficient byte-identity is pinned.

**F4. `load_from_dict` (root cause 2.3).** Patch `levels_matrix` and the 6 base levels in place, and build the
128 `ExcitationCurve` objects lazily (only the GET/save path needs them). This removes ~2.3 ms per pitch and
most of the GIL starvation behind finding 5.

**F5. Concurrent notes (finding 5).** F3 and F4 shrink the window. Beyond that:

- Run the heavy recompute without holding the GIL in long pure-Python loops (numpy batches).
- Or move note scheduling for MIDI input fully into C++. The listener already pushes into the C++
  `RealTimeEventBuffer`; only the Python hop is exposed.
- A smaller `sys.setswitchinterval` is a blunt alternative.

**F6. Half-applied strikes.** Apply the rows and the coefficient table as one unit:

- one swap carrying all rows;
- coefficient table switched at swap adoption, or uploaded as part of the tunable block.

**F7. Frontend.**

- (a) Use leading-plus-trailing throttle (for example ≤ 50 ms intervals during a drag) instead of a
  trailing-only debounce for sliders, workbench drags and wheels, so the sound follows the gesture.
- (b) For an explicit commit (Enter), emit before the expensive re-render. Call `writeParam` without the
  debounce, and defer the chart and pane re-render with `startTransition` / `requestIdleCallback`.
- (c) Stop the synchronous whole-tree re-render on a single-field edit: memoize panes, and keep ECharts updates
  out of the commit phase.
- (d) Throttle or coalesce re-renders driven by `midi_message`, console-log stream and `history_changed` while
  their consumers are not visible.
- (e) A production build would cut the measured render costs several-fold. Measure before relying on this.
- (f) Hammer fields: skip the 150 ms staged settle on Enter (Enter is an explicit commit).

**F8. Fixed floor (optional).** The ring depth of 8 (10.7 ms) could go to 4 (5.3 ms) if underrun-free. Check
with the `test_performance_audio_off` / underrun counters before changing it.

**Estimated effect.** F1, F2a, F3a and F7b together would put the slowest common cases (string edit while
holding a note; single-pitch excitation via the UI) at about 40-80 ms from Enter to sound, against 0.2 s to
"next key" today.

## Odd things noticed (not latency)

- **Test artifact that exposed a weak spot.** A synthetic `focus()` + `Enter` (no real click) on a Strings
  NumInput routed the commit to the previously active parameter: `hammer_position = 677.932`.
  - The WS write was rejected ("Inconsistent hammer parameters").
  - The F1 REST fallback then **accepted** the same invalid value into the model.
  - A later `POST /history/undo` raised 500 on it.
  - Real CDP input routed correctly. I recovered by restarting the backend. Worth a look: the WS path and the
    REST path disagree on validation.
- **My excitation and hammer test edits cleared the working copy's `output_scale_calibrated` flag** (shape-edit
  policy), and the kernel limiter showed `LIMIT -22.5 dB` during v127 strikes. All values were restored, and the
  backend was restarted from the preset file at the end.
- **Pedal CC0 chatter** (41/42 on channel 3) floods `midi_message` to every page. dev-392a is working on the
  pedal channel.

## Data and scripts

`docs/development/diagnostics/latency-2026-10-23/`:

- `latlib.py`: capture, anchor and detectors.
- `exp01_anchor.py`, `exp02_determinism.py`, `exp03_continuous.py`, `exp04_excitation.py`,
  `exp05_trigger.py`, `exp06_breakdown.py`, `exp07_pyspy_load.py`, `exp08_note_during_write.py`,
  `exp09_ping_during_write.py`.
- UI: `ws_tap_initscript.js`, `ui_lib.js`, `ui_analyse.py`, `ui_exc_analyse.py`, `ui_timeline.py`,
  `emit_summ.py`.
- Trace and stack analysis: `trace_tasks.py`, `trace_incl.py`, `pyspy_incl.py`.
- Timing shim: `shim/sitecustomize.py`.
- Results: JSON and logs under `data/`, UI results under `data/ui/`.

`D:\modal_measurements\latency-2026-10-23\`:

- every capture WAV (`exp*_*.wav`, `ui_*.wav`)
- `timing.jsonl` (shim)
- `trace_exc_numinput.json.gz` (Chrome trace)
- the py-spy raw output is in `data/pyspy_gauss88.txt`
