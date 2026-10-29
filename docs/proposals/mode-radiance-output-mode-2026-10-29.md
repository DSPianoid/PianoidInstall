# Mode radiance factors and mono / stereo output mode (design only)

**Status:** PROPOSAL (Phase A of dev-rad1). Nothing is implemented. Branch `feature/dev-rad1-design`, not merged.
**Date:** 2026-10-29
**Trigger (user, verbatim):** "output channel coefficient mask to replicate soundboard emission on stereo speakers (check my
dialog with the assistant). For that each mode should get additional parameter (radiance factor), one figure for mono,
2 figures for stereo. Add that to the preset, and also add the command to switch system to the mono/stereo mode
(channels collapsed to 1/2 using radiance factor)."
**Follow-up (user):** "Reconsider if the summation should be done in the host/c++ core/GPU, it must not increase the
cycle time significantly." See [§5](#5-where-the-summation-runs-cycle-cost).

---

## 1. What the assistant dialog established (2026-10-29, session `a15f04f3…`)

The user asked: *"you have now standard acoustic system on out 1-2. By emitting the mode frequencies on the speakers and
on the board find relative radiance for the modes. Ultimate goal to have a set of transition coefficients that will make
synthesized sound through the speakers to sound similarly to the excited board."*

- **Hardware.** Speakers = ASIO **Out 1 / Out 2** (SPKL / SPKR). The exciters E1..E7 are on Out 9, 10, 3..7
  (`PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6`). **E1/E2 are not the stereo pair.** Mic on In 1, piezos P2..P7 on In 2..7.
- **Method.** This is a substitution measurement. At one mic position, the board is driven per mode with its best force
  pattern (the SVD of the FRF), and the speakers play the same frequency. The coefficient is board radiation divided by
  the speaker response, so the room and the mic cancel to first order.
  - **coefA**, per unit of board motion: (mic / piezo) / (speaker mic per volt). The assistant recommends this one for
    synthesized mode signals.
  - **coefB**, per volt of exciter drive.
- **Runs.**
  - Tones at the 25 board modes, position 1: `radiance_board_vs_spk`.
  - The same tones at position 2: `radiance_pos2`.
  - ESS sweeps up to 8 kHz on 7 exciters + 2 speakers: `radiance_sweep_pos2`, where the right speaker was dead, and
    `radiance_sweep_pos2b`, with both speakers working.
  - The per-mode values for all 196 preset modes (1/3-octave smoothed, dB re the median) are in
    `C:\Users\astri\.pianoid-assistant\analysis\artifacts\a-20261029133655-e242b3\radiance_sweep_pos2b.json`, with the
    keys `mode_freq`, `coefA_mode_db`, `coefB_mode_db`, `speaker_feed` and `bands`.
- **Findings.**
  - Low modes need much less speaker gain: about −5 to −22 dB below 130 Hz, and the strong 104 Hz mode needs −12 to
    −22 dB.
  - The 1–2 kHz range needs +3 to +6 dB.
  - Above 2.5 kHz, A and B disagree. That stays open until a listening test.
  - Single-tone values move about 10 dB RMS between mic positions (room modes). The averaged, smoothed sweep curve is the
    usable product, and the assistant plans 2–3 more positions.
  - The left speaker lost its top end in the last run (−11 to −21 dB above 2.5 kHz). That is unresolved.
- **Stereo status.** The values so far were measured with **both speakers fed the same signal (L+R)**, i.e. **mono**.
  Per-speaker (L, R) factors are not derived yet. The sweep data holds separate SPKL / SPKR transfer functions, so they
  can be computed.
- **What the assistant proposed for using them.** "A speaker variant of the preset, coefficient A written as the per-mode
  weights of two channels, with the output map changed to send those channels to Out 1/2". That needs a restart. This
  design turns it into a first-class, live-switchable feature.

---

## 2. How output works today (strings-listen mode, `listen_to_modes = 0`)

Doc support:
- [SYNTHESIS_ENGINE "Sound strings" / "Sound-Channel Gain Path"](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md)
- [DATA_FLOWS §2.4 disambiguation](../architecture/DATA_FLOWS.md)
- [pianoid-basic OVERVIEW "SoundChannels — Stored vs effective"](../modules/pianoid-basic/OVERVIEW.md)

Source was confirmed for each step below.

1. **Channels are output strings.** Engine channel `c` is the virtual string(s) of output pitch `128 + c`
   (`outerSoundChannel = pitch − 127`, PianoidBasic `Pitch.py:108`). `num_channels` is the preset's
   (`mode_sound_channels.num_channels`, ≤ `NUM_CHANNELS` = 12). The live preset has 7 channels, one per exciter
   (the `actuator_feeds` output role).
2. **Mode → channel matrix = the output pitches' deck rows.** `StringMap.pitch_deck_row` (PianoidBasic
   `StringMap.py:467–494`) builds the engine row of an output pitch as
   `W[c, m] = deck_feedback[128+c][m] · mask[128+c][m] · string_coefficients[128+c][c]`, which is the effective deck ×
   the SC string gain. `pack_deck` stacks all rows, and `send_deck_params_to_CUDA` → `setNewDeckParameters` uploads them
   as `dev_deck_parameters`. Axes: **row = string (output pitch), column = mode** (`deckColumn(layout, m)`).
3. **The GPU sums it, every sample.**
   - At kernel start each mode-owning thread loads its coefficients into registers:
     `mode_feedback[i] = deck[string_i · deckWidth + deckColumn(m)]` (PianoidCore `MainKernel.cu:281–315`, with
     `NUM_FOLDS_IN_QUARTER` = 3 strings per thread).
   - At every audio sample, each mode scatters `mode_feedback[i] · q_m` into `feedback_cycle_matrix` for **all strings**
     (`MainKernel.cu:545–555`).
   - `sumArray` reduces it per string (`:587`). For an output string,
     `feedback = Σ_m W[c,m] · q_m`.
4. **Write.** At the output-string stem (`MainKernel.cu:606–635`):
   - `y_c = feedback − s_b`, which is velocity, `soundDerivativeOrder` 1. With order 2 it is differenced again
     (acceleration).
   - The result is multiplied by `main_volume_coefficient` and stored in `soundInt[(c)·samplesInCycle + i]`.
   - So **`y_c(t) = Dᵏ Σ_m W[c,m] q_m(t)`**, a linear map of the mode amplitudes.
   - Piano strings never write output directly in strings mode, so **there is no direct string path**. All sound passes
     through the modes.
5. **Routing.** In the ASIO callback, engine channel `k` goes to device output `map[k]`, and unmapped outputs are zeroed
   each switch (`AsioAudioInterface.cpp:255–268`). The map is set once before the driver opens:
   `audio_channels.apply_output_map` (`pianoid.py:3008–3009`) → `setAsioOutputMap` (`AsioAudioInterface.cpp:738–749`,
   a plain `std::vector`, not synchronised with the callback thread).
6. **Back-coupling caveat (high-stakes).** The deck is a single matrix (`USE_SINGLE_DECK_MATRIX=1`), so the same row
   also serves as the output string's **feedin** row: the output string's bridge force (`MainKernel.cu:709–713`) is
   scattered into the modes with `W[c,m]` (`:748–753`). Changing `W` therefore changes the small load the output strings
   put on the board, as well as the readout.
   - Indirect evidence that this load is negligible: duplicating an output pitch's strings changes that channel by
     ≤ 0.01 dB (SYNTHESIS_ENGINE, "An output pitch may own several strings").
   - This must still be **measured** before release (§6, test V4).

---

## 3. Data model

### 3.1 Per-mode radiance factors (preset)

| Field (on `Piano_mode`, preset `modes[m]`) | Shape | Unit | Default (absent) | Range |
|---|---|---|---|---|
| `radiance_mono` | scalar | linear amplitude gain (dimensionless) | `1.0` | `[0, 1e3]`, finite |
| `radiance_stereo` | `[r_L, r_R]` | linear amplitude gain | `[1.0, 1.0]` | each `[0, 1e3]`, finite |

- Both sets are stored, so one preset can be played in either mode, and the measurement products map directly: the
  current L+R data → `radiance_mono`; the per-speaker data → `radiance_stereo`.
- **Linear, not dB, in storage.** dB is a UI/display transform (`20·log10`), and 0 is allowed, meaning that mode is
  muted on the speakers. The assistant's tables are in dB re the median: import = `10^(dB/20)`.
- Negative values are **rejected**. Polarity is not measurable from the magnitude data, and a sign flip per mode would
  create audible cancellations. If phase is ever measured, the range can be relaxed later.
- **Backward compatible.** An absent key loads the default. Native mode never reads these fields, so old presets are
  bit-identical in native mode.
- **Saved** by `Piano_mode.pack_for_preset` **only when not at the default**, so an old preset round-trips byte-identical.
- Preset-level metadata, optional: a `radiance` block with `{source: "radiance_sweep_pos2b", basis: "board_motion",
  mic_positions: n, date}` for provenance.
- **Flat tier.** In a flat-tier preset (`flat_tier_num_flat > 0`), the uniform flat modes share one deck column
  (`w(s)` contract, SYNTHESIS_ENGINE T3). They can only take **one** radiance value per channel, so per-mode radiance
  there would violate the exactness contract. Rule: radiance is per mode for shaped and linked modes. For the flat tier,
  the loader uses the energy-weighted mean of the flat modes' factors and warns. The live preset is legacy (196 modes),
  so this does not apply now.

### 3.2 Output mode (session state, not preset)

`output_mode ∈ {native, mono, stereo}` is a **runtime session setting**, like volume and the output map. It survives
preset switches, it is not written into presets, and a new backend starts `native` (optionally `PIANOID_OUTPUT_MODE`
env). Justification:
- The mode depends on the rig: whether speakers are connected, and where. A preset must play the board natively on any
  rig.
- Tying it to the preset would make loading a preset silently re-route the exciters.

Per-machine **speaker route**: `PIANOID_SPEAKER_OUTPUTS=0,1`, the 0-based ASIO outputs of L, R, defaulting to `0,1`
(Out 1/2). It is a session setting next to `PIANOID_AUDIO_OUTPUT_MAP`.

Plus one scalar **`radiance_gain`** (linear, default 1; per preset, in `model_parameters`): the overall speaker level of
the collapsed mix (see §4.3).

### 3.3 Parameter-system registration

- **Middleware.**
  - `update_parameter('mode', {radiance_mono | radiance_stereo})`, through the existing mode write path, with undo via
    `edit_commit`.
  - REST: `POST /set_parameter/mode/<m>` with `{radiance_mono: x}` / `{radiance_stereo: [l, r]}`, plus a bulk
    `POST /set_parameter/radiance` with `{mono: [N] | stereo: [[l, r] × N], basis}` for importing a measurement.
- **Rule table** (dev-psafe2 `param_rules.json`): rules `mode.radiance_mono` and `mode.radiance_stereo` (kind
  `bound`, min 0 inclusive, max 1e3), plus `finite`. The reason text: gains, a negative is a polarity flip that cannot
  be measured from magnitudes.
- **Assistant.** `param.set` covers `mode.radiance_mono` / `mode.radiance_stereo` through the same inventory
  (`schemas/params`). A new command `output.set_mode {mode: native|mono|stereo}` and `output.get_mode`. An import helper
  `radiance.import {artifact, key: coefA_mode_db, target: mono|L|R}` converts dB re median → linear.

---

## 4. The collapse, mathematically

Notation:
- `q_m(t)`: mode amplitude.
- `Dᵏ`: the engine's sample difference, order k = `sound_derivative_order`.
- `W[c,m]`: the native output-row matrix (§2.2).
- `b_m`: the board-motion basis (§4.2).
- `g`: `radiance_gain`.

### 4.1 Definitions

| Mode | Channel 0 | Channel 1 | Channels ≥ 2 (mono: ≥ 1) |
|---|---|---|---|
| native | `Dᵏ Σ_m W[0,m] q_m` | `Dᵏ Σ_m W[1,m] q_m` | unchanged |
| mono | `Dᵏ Σ_m g·r_mono[m]·b_m·q_m` | silent (row 0) | silent (row 0) |
| stereo | `Dᵏ Σ_m g·r_L[m]·b_m·q_m` | `Dᵏ Σ_m g·r_R[m]·b_m·q_m` | silent |

- **Replace, not multiply, the per-channel rows.** Native rows are per-exciter drive weights (the mode shapes at the
  exciter positions, `actuator_feeds`). They describe how to drive the board, not how it radiates to a listener, so
  multiplying the speaker mix by one exciter's row would be physically meaningless.
- **There is no string direct path to handle**: §2.4.
- **Silent channels.** Their rows become 0, so their `feedback` is 0 and the output decays to exactly 0 after the
  output string's transient, about one cycle. They are also unmapped from the exciter outputs (§4.4), so the exciters
  get hard silence regardless.

### 4.2 The basis `b_m`: what "radiance per unit board motion" multiplies

coefA is *sound per unit piezo-measured board motion*. The engine's `q_m` has an arbitrary normalisation: `mass_inv` is
folded in, and spans many orders (DATA_FLOWS "Coefficient ≠ audible weight"). So `r[m]` alone cannot be applied to `q_m`.
It must multiply the engine's own "board motion at the sensor points" for mode m.

- **Proposed `b_m`** = RMS over the native output rows: `b_m = sqrt(mean_c W_native[c,m]²)`. That is the mode-shape
  magnitude at the exciter points, which is the engine's analogue of what the piezos read, **if the piezos sit at or near
  the exciters**. This is an **open question for the user** (Q2).
  - With this basis, the identity test is exact: setting `r ≡ 1` gives the "average exciter-point motion" channel.
- **Alternative basis `b_m = 1`** ("absolute"). Use it when the radiance factors were fitted directly against the
  engine, e.g. a future fit of renders against mic captures.
- The basis is a stored choice (`radiance.basis = board_motion | absolute`), so imported data says what it means.

### 4.3 Gain normalisation and clipping headroom

- **Default `g`: the energy match.** On a switch to mono or stereo, `g` is computed so that the collapsed channel's
  analytic energy equals the mean native channel energy, using the closed-form per-mode response energy `E_m` already in
  the Audibility view (DATA_FLOWS "Analytic audible weight"; `E_m` from `decrement`, `f`, `mass_inv`, `sr`, k):
  `g² Σ_m (r_m b_m)² E_m = mean_c Σ_m W[c,m]² E_m`.
  - This is analytic and needs **no offline render** (no render in the live backend:
    `project_no_offline_render_in_live_backend`).
  - The user can then trim `radiance_gain` (dB in the UI).
- **Headroom.** Collapsing 7 exciter channels into 1 sums partially coherent mode contributions. With the energy match,
  the RMS stays the same, but the peak can rise because modes add in phase at the attack.
  - Report it through the existing clip telemetry (`dev_limiter_peak` per channel → `/health level.over_full_scale`).
  - Add a conservative `−3 dB` default trim. Open question Q4.
- `main_volume_coefficient`, the volume and `output_scale` are unchanged and act as today.

### 4.4 Hardware routing

- In mono and stereo, engine channel 0 (and 1) must reach the **speakers**, not E1/E2.
- The output map in force is replaced with a **speaker map** of the same length:
  - `[sL, sR, x2..x(N−1)]`, where the silent channels go to distinct outputs that are neither the speakers nor any
    exciter, if the device has spares. Otherwise they go to their native exciter outputs (their rows are 0 → silence).
  - Mono: `[sL, sR, …]` with channel 1 silent, or mono sent to **both** speakers. Q3: the dialog measured L+R fed
    together, so mono = the same signal on both is the faithful reproduction of the measurement.
- In native mode, the original `PIANOID_AUDIO_OUTPUT_MAP` comes back.

**The exciter monitor/limiter (dev-8f54)** applies per-engine-channel exciter safety gains. In speaker mode, channels
0/1 would inherit E1/E2's limiter state. In mono and stereo, the exciter safety gain must be bypassed for the
speaker-routed channels. This is a host `.cpp` concern (exmon is keyed by engine channel); see §5.4.

---

## 5. Where the summation runs: cycle cost

Baseline: 64 samples per cycle, GPU cycle mean 0.475 ms (0.511 ms total). Live preset: 196 modes, 224 legacy mode slots,
about 224 strings, 7 channels.

### (a) Host-side precompute into the EXISTING GPU mixing path (RECOMMENDED)

- The GPU already computes `Σ_m W[c,m] q_m` for every string, every sample: the dense mode→string scatter
  (`MainKernel.cu:545–555`) does about `numModes_slots × numStrings` multiply-adds per sample (224 × 224 ≈ 50 k
  atomicAdds/sample, about 3.2 M/cycle).
  - The output strings are 7 of the 224 rows, about 3 % of that work.
  - The work is **independent of the coefficient values**: zeros are multiplied like anything else.
- Mono and stereo change only the **values** of 7 rows. Per-cycle work is **identical**: no extra instruction, memory
  access or barrier. Collapsing to 1/2 channels costs the same as native; it does not save the zeroed rows, which are
  negligible anyway.
- **Switch/edit cost (off the audio path).**
  - The host repacks the deck (`pack_deck`, Python, about 224 rows; ms-scale, on the request thread).
  - Upload: `setNewDeckParameters` → `updateTunableParameter("dev_deck_parameters")`, which is 65 536 reals = 256 KB
    host→device, about 20–40 µs of PCIe through the existing tunable-swap path that every feedback/feedin edit already
    uses.
  - The kernel loads `mode_feedback[]` into registers **at launch** (`MainKernel.cu:281–315`), so the switch takes
    effect **at the next cycle** (≤ 1.33 ms at 48 kHz / 64). It is live, with no preset reload.
- Expected cycle-time change: **0** (same kernel binary, same work).
- **C++ needed: none for the mixing.** Python only: PianoidBasic `StringMap.pitch_deck_row` gains the radiance branch,
  and the middleware gains the mode state and routes. The routing swap (§4.4) needs one small host change (§5.4).

### (b) GPU kernel change: a dedicated radiance reduction

- Extra work per sample: `2 × numModes` multiply-adds (392). That is trivial compute, but a **cross-block reduction**,
  because modes live on different blocks.
  - Done in place, it needs either a new `allBlocks.sync()` per sample (a grid barrier costs about 1–3 µs; × 64 ≈
    64–190 µs/cycle, which is **+13–40 %** of 0.475 ms), or a piggy-back on the existing feedback barrier, the way the
    T3 flat tier did (a block partial into a spare row of `feedback_cycle_matrix` + a warp-0 tree sum).
  - The piggy-back is cheap (the flat tier measured ~no barrier cost), but it is a `.cu` change: registers (release
    111 / debug 118–120, of a 128 cap), a rebuild, the debug variant.
  - It buys nothing over (a), because (a) already performs exactly this sum inside the existing scatter.
- Only justified if back-coupling (§2.6) proves non-negligible and a **pure readout** without feedin load is needed.
  Even then, the cheaper fix is a separate "readout-only" flag that zeroes the feedin of output strings at pack time.
  That is still host-side, if the single-deck matrix permits it; otherwise it is a one-line kernel guard.

### (c) Host/C++ post-mix on the CPU after the GPU

- It needs the per-mode signals for every sample: `numModes × 64 × 4 B` = 196 × 64 × 4 ≈ **50 KB/cycle**, written to
  global memory by the kernel. That is a new store of 12.5 k values/cycle, so it is also a kernel change.
- Then a device→host copy, a CPU mix of 196 × 2 × 64 ≈ 25 k MACs (about 10 µs, trivial) and the Dᵏ differencing on
  the host.
- The cost is **latency on the critical path**. Each cycle would need a synchronous D→H copy (PCIe round trip plus
  `cudaMemcpy` sync ≈ 15–40 µs for 50 KB) before the ASIO buffer can be filled, serialised after the kernel. That is
  **+3–8 % of the cycle**, plus jitter from host scheduling. This jitter is exactly the class of spike solved by the
  MMCSS/TIME_CRITICAL work (cp0→cp1).
- It also duplicates the derivative state (`sound_prev_diff`) on the host, and bypasses the kernel's clip telemetry.
- **Rejected.**

### 5.4 The one host-C++ change: a safe live output-map swap

- `g_outputMap` is a `std::vector` read by the ASIO callback each `bufferSwitch` (`AsioAudioInterface.cpp:265–268`) and
  written by `setOutputMap` from Python with no synchronisation.
  - An equal-length assignment copies in place without reallocating, so a live swap would "work" on x86.
  - It is still a data race (UB), and it could tear for one buffer.
- **Proposal:** a fixed `std::array<int, kMaxOutputChannels>` double buffer + `std::atomic<int>` active index. `set`
  writes the inactive copy and then flips the index; the callback reads the index once per switch.
  - Same for the exmon bypass flag per engine channel.
  - This is host `.cpp` only, **not** the kernel. Zero per-cycle cost: one atomic load per callback.
  - It goes through `/dev` (a C++ build), scheduled when the user's live stack is free.
- **No-C++ fallback:** apply the speaker map at the next driver open, either through the recovery path
  (`POST /audio/reopen`, `audio_health.py:105–117`, with the map set while the driver is closed) or at the next preset
  load. That costs one driver reopen (an audible gap of ~0.1–0.5 s) per switch. Acceptable for Phase 1 if the user
  agrees (Q5).

**Recommendation: (a)** for the summation, plus the §5.4 atomic map swap for routing. No kernel change, and no
measurable cycle-time change is expected.

---

## 6. Implementation sketch (Phase B, for approval)

1. **PianoidBasic.**
   - `Piano_mode`: `radiance_mono`, `radiance_stereo`; load/save with defaults and the save-only-if-non-default rule.
   - `ModeMap`: vectors `radiance_matrix(mode)`.
   - `StringMap.pitch_deck_row`: if `outerSound` and `mp.output_mode != 'native'`, the row is `g·r_c[m]·b_m` for
     `c < n_active`, else 0. `b_m` is computed from the native rows (cached, invalidated on a deck edit).
   - Flat-tier fold (§3.1).
2. **Middleware.**
   - `output_mode` session state (+ env default).
   - `POST /output_mode {mode}`, `GET /output_mode` → `{mode, speaker_outputs, radiance_gain, basis, warnings}`.
   - The switch:
     1. validate (radiance present? otherwise warn that the defaults r = 1 apply);
     2. compute `g` (energy match);
     3. pack + `send_deck_params_to_CUDA`;
     4. swap the output map (§5.4) in the same request;
     5. clear the per-channel peak telemetry.
   - The order of steps 3 and 4: map first when going to speakers, deck first when going back to native, so no
     exciter ever receives the speaker mix for a cycle.
   - The radiance params get REST + bulk import + undo; rules in `param_rules.json`; `/health` exposes `output_mode`.
3. **Assistant.**
   - `output.set_mode` / `output.get_mode`, `param.set mode.radiance_*`, `radiance.import`.
   - `<pianoid_context>` shows `output_mode`.
4. **Tunner UI.**
   - A bottom-bar or Sound Channels pane **Output: Native | Mono | Stereo** toggle (MUI `ToggleButtonGroup`), with the
     speaker route shown and a `radiance_gain` NumInput (dB).
   - In the **Modes** pane / Workbench, a new mode parameter group `Radiance` (fields `mono`, `L`, `R`; dB display,
     linear store) uses the existing per-mode chart editor, so it is a bar chart over modes, like decrement and mass_inv.
   - The Audibility view gains an option to show `|g·r·b|·√E` for the collapsed channel.
5. **C++ host** (§5.4): an atomic map swap + exmon bypass, through `/dev` with a build.

## 7. Verification plan (no runs now: the user's live stack is in use)

| # | Test | Surface | Pass |
|---|---|---|---|
| V1 | Native bit-identity: an old preset, render native before/after the feature | offline render (`getRecordedAudio`), unit test of `pack_deck` | packed deck byte-identical; render identical |
| V2 | Identity collapse: `r ≡ 1`, basis `absolute`, `g = 1`, with row 0 set to `W_native[0]` through a test hook | offline render | ch0 identical to native ch0 (≤ float noise) |
| V3 | Weighted-sum check: random `r_L`, `r_R`; render one note; compare each channel's per-mode energy (bandpass at f_m, or the debug mode readout) against `(g r b)² E_m` | offline render | per-mode level error ≤ 0.5 dB on audible modes; silent channels exactly 0 after 1 cycle |
| V4 | Back-coupling: render native vs. stereo with all native rows kept on extra channels, and compare the mode amplitudes / a fixed exciter channel | offline render, 12-ch test preset | ≤ 0.1 dB change, otherwise escalate to the readout-only flag |
| V5 | Live switch: native→stereo→mono→native while a note sustains; no NaN, no gate trip; the map swap is atomic | live engine (`/health`, rig record of Out 1/2 + E1) | speakers carry the mix, exciters silent in mono/stereo, restored in native |
| V6 | Cycle time: perf suite, N ≥ 3 runs per configuration (native, mono, stereo), before vs. after | perf suite (`test_ui`/perf, cycle mean / p99) | Δ mean within run-to-run noise (< 5 µs); no new spikes |
| V7 | Rules / undo / assistant: a negative or NaN radiance is rejected; undo restores; `param.set` round-trip | Jest + pytest + assistant command test | green |

---

## 8. Open questions for the user

1. **Which coefficient goes into the preset: coefA (per board motion) or coefB (per exciter volt)?** And should we wait
   for 2–3 more mic positions plus the left-speaker treble issue before importing? (The proposal is coefA, smoothed,
   averaged.)
2. **Are the piezos P2..P7 at or near the exciter positions?** That decides whether the board-motion basis
   `b_m` = RMS of the native exciter rows is the right normaliser for coefA.
3. **Mono:** the same signal on both speakers (matching how it was measured), or one speaker only?
4. **Stereo factors:** should the assistant derive per-speaker L/R factors from the existing SPKL/SPKR sweep data (an
   independent fit per speaker, which ignores L/R interference at the mic), or measure L and R separately?
5. **The switch path:** accept a short driver reopen per switch now (no C++), or wait for the atomic map swap (a small
   C++ host change and a rebuild) for a gapless switch?
6. **Exciters in speaker mode:** fully silent (proposed), or a hybrid "board + speakers" mode for A/B listening? Hybrid
   needs a preset with 2 extra output channels routed to Out 1/2.
7. Default **headroom trim** for the collapsed mix (−3 dB proposed), and should `radiance_gain` live in the preset (as
   proposed) or in the session?
