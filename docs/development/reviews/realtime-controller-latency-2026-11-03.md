# Real-time controller latency: one parameter across the keyboard in 30 ms (2026-11-03)

**Question (user, Telegram):** "The target latency for updating parameter across keyboard is 30ms. Usecase: the
parameter is controlled by the pedal or a pitch wheel on the midi keyboard, and can be controlled in time of the
live playback. Review and find out if the target is feasible and which parameters can be problematic."

**Scope:** design review, read-only. No engine runs, no builds, no code changes. Sources: the
[tuning-latency study](tuning-latency-study-2026-10-23.md) (measured, live loopback Out 9 → In 8), the
[Phase 1/3 review](tuning-latency-phase1-3-review-2026-10-28.md), the
[half-pedal results](../half-pedal-test-plan-2026-10-31.md), the dev-hstall stall record (Install branch
`feature/dev-hstall-docs` e27f289, `excitation-write-stall-2026-11-03.md`), DATA_FLOWS §1.2 and §2,
SYNTHESIS_ENGINE, MIDI_SYSTEM, and the source on Core dev 2b5bc64. One offline numpy microbenchmark (below).

Every figure is tagged **[M]** measured (with its source) or **[I]** inferred (from code or arithmetic).

## Verdict

**Feasible, but not through the parameter-edit path.** The engine has a fixed floor of about 20 ms
(ring 10.7 + ASIO loop 6.9 + up to one 1.33 ms cycle) **[M, study]**. That leaves about 10 ms per update. The
parameter-edit path (Python model → `edit_commit` → journal → ParameterManager → double-buffer swap) costs
14–25 ms for one keyboard-wide string or mode edit and 0.6 s for an excitation curve. It can't keep up with
a stream of 100 or more updates per second. The pedal already meets the target because it does **not** use that path. It
sends one number to C++, the engine applies it at most once every 4 cycles, and `parameterKernel` turns it into
per-string coefficients on the GPU. The recommendation is to give every slow family the same shape: the controller
writes a few scalars that the kernels apply.

| Family | Today, one 88-key update | Under a 100 Hz stream | Verdict |
|---|---|---|---|
| Sustain / half pedal (CC64) | ≈ 21–27 ms to sound **[I]**; 100 Hz CC for 30 s caused 0 overruns and no clicks **[M, pedal tests 8/9]** | latest wins, at most one apply per 4 cycles (5.3 ms) | **Meets today** (risk: Python listener GIL stall, see §4) |
| Runtime volume, deck feedback coefficient | 18–19 ms audible over WS **[M, study]** | direct async write, no swap | **Meets on the engine side.** MIDI CC7 / CC74 are **dropped** by the unified listener today, so wiring is needed (step 1) |
| Pitch wheel → tension (all keys) | the unified listener drops it. Via the edit path: 14 ms ack, 29 ms audible **[M, study, "tension 88-pitch range"]** | 14 ms of `cuda_lock` work and about 10 ms of Python per message, against a 10 ms gap; one undo entry and one `state_changed` per message | **Needs a new path** (tension scale in `parameterKernel`) |
| String damping (gamma), dispersion damping, stiffness (jung, r), detuning | same path as tension: one swap per parameter, about 14 ms ack **[M for tension, I for the rest]** | as above | **Needs a new path** (scales in `parameterKernel`) |
| Density, length | same, plus a `string_gain` coefficient recompose for 88 pitches **[I, unmeasured]**; length moves `dx` (Courant ∝ 1/dx²) | as above | **Needs a new path; as a controller, only clamped** (see §3) |
| Modes: frequency, damping, mass (all 196) | 25 ms ack [12–40], 26 ms audible [24–28] **[M, study]** | 25 ms of work per message | **Meets for one update, not for a stream.** Needs a new path (mode scales) |
| Deck feedin / feedback rows (88) | one row: 22 ms audible **[M]**. 88 rows: whole-blob `pack_deck` + 256 KB + swap, about 15–40 ms **[I, unmeasured]** | as above | feedback: **meets** through the existing global coefficient. feedin: **after a stated change** (add a global feedin scalar) |
| Sound channels / radiance | one SC row 23 ms **[M]** | as above | **After a stated change** (runtime per-channel output gain vector) |
| Excitation curves: gauss volume, mu, sigma, base levels (88) | 640 ms until every strike is new **[M, 10-28]**; 0.56–0.77 s write on a fresh backend **[M, dev-hstall]** | impossible | **Not feasible on the edit path even after dev-hstall** (§2.3). **Meets with strike-time modifiers** (new path) |
| Hammer position / width / sharpness (88) | 108 ms ack, 80–160 ms until every strike is new **[M, 10-28]** | impossible | **Needs a new path** (precomputed shape tables, §5 step 5) |

Excitation and hammer parameters act **only at a strike**: a controller on them changes the next note, never one that is already sounding.
Here "audible in 30 ms" means "the next strike after the controller moves reflects it". With modifiers that
holds immediately, because the modifier is read at note staging.

## 1. The two paths

### 1.1 Pedal path (fast, measured working)

```
rtmidi → MIDI_listener_unified (Python, polls with a 1 ms idle sleep)
  → MidiInputHub.map_message → schedule_event → midi_to_event_type: CC64 → SUSTAIN
  → RealTimeEventBuffer.pushEvent (< 1 µs, mutex)
engine thread, next cycle: EventDispatcher → processSustain(v) = atomic store
  → applyPendingSustain() once per cycle: unchanged → nothing; else at most every SUSTAIN_MIN_CYCLE_GAP = 4 cycles,
    latest wins; 0/127 land at once → cudaMemcpy 4 bytes to dev_sustain_value → requestParameterKernel
  → parameterKernel (all strings, DamperLaw.cuh) → addKernel
```

| Stage | Cost |
|---|---|
| Listener poll + decode + map + push | 1–3 ms poll wait on Windows **[M, MIDI_SYSTEM dev-c6b6]**; decode in µs **[I]** |
| Wait for cycle + rate gap | ≤ 1.33 ms + ≤ 5.3 ms **[I, code `Pianoid_synthesis.cu:216`]** |
| `parameterKernel` | per-kernel ms not measured (no profiling build); 100 Hz CC under 10 notes: render 3.16 s vs 3.15 s still, 709 live CC at 72/s with 0 produce timeouts **[M, pedal test 9]** |
| Floor | 20.3 ms **[M]** |
| **Total** | **≈ 21–27 ms** **[I]** (end to end not captured with the loopback) |

Why it is fast: no Python model, no journal, no swap. All strings are recomputed by `parameterKernel` anyway
(grid = all string arrays), so 88 keys cost the same as one key.

### 1.2 Parameter-edit path (slow)

```
WS/REST or MidiListener action → Pianoid.update_parameter → edit_commit.commit (guard, apply, Layer B)
  → ParameterManager: Python model edit per pitch (+ CFL indication, coefficient recompose)
  → with cuda_lock: _gpu_upload = waitForParameterUpdate() [GIL HELD] → updateTunableParameter (DROP_IF_BUSY)
      → cudaMemcpyAsync host → updating buffer; printf "Updating …" (pushed to every open page)
      → poll thread (100 µs sleeps): event done → swap → syncBuffers (full preset D2D) → IDLE
  → engine: refreshSwappablePointersIfPending at the top of the next cycle; since dev-late1 the adopting cycle
    re-runs parameterKernel (F1 of the study is fixed)
  → StateJournal: one undo entry + state_changed broadcast to every client (each one a React render, study finding 6)
```

| Stage, per 88-key update | Strings (1 param) | Modes (196) | Excitation curve | Hammer |
|---|---|---|---|---|
| Python model work | ≈ 10 ms total incl. CFL indication **[I = 14 ms ack − 4 ms swap]** | `fit_params` per mode, ≈ 20 ms **[I]** | `load_from_dict` ≈ 206 ms **[M, 10-23]** | `calculate_hammer_shape` per pitch, ≈ 60–100 ms **[I from 108 ms ack]** |
| Coefficient recompose | none (B2: tension/stiffness/damping move no factor) | none | 384 ms **[M, 10-23]** → 88 × 6 curves; after dev-hstall + C++ impulse: see §2.3 | spatial factor re-read |
| Packing | per-string (index, value) lists, small | 3 × 196 reals | `pack_base_excitations` + C++ 6→128 interpolation: 3–3.5 ms **[M]** | `pack_hammers` 98 KB |
| Transfer | 16 KB buffer, few hundred values | 5 KB | 2.6 MB (`dev_gauss_params_full`, 655 360 reals) | 98 KB |
| Double-buffer swap | ≈ 4 ms per swap, mostly 1 ms Windows sleep granularity in polling **[M total, I split]**; one swap **per parameter** | one | one, then a GIL-free wait, then commit the coefficient | one |
| Adoption | next cycle, `parameterKernel` re-run (dev-late1) | next cycle (MainKernel reads `dev_mode_state` directly) | at the next strike | at the next strike |
| **Ack / audible** | **14 / 29 ms [M]** | **25 / 26 ms [M]** | **0.56–0.77 s / 640 ms all-new [M]** | **108 / 80–160 ms [M]** |

## 2. Behaviour under a continuous stream

### 2.1 Coalescing, drop-if-busy

- The engine buffer policy is `DROP_IF_BUSY`. Every `_gpu_upload` waits for IDLE first, so slow-path writes
  **serialise, they do not drop** **[I, code `parameter_manager.py:184`]**. At 100 Hz with 14–25 ms per write the
  queue grows without bound unless something coalesces.
- dev-hstall (today) adds FE latest-wins coalescing (one write in flight per debounce key). A MIDI-driven write
  never passes the FE, so the backend has **no** coalescing for a controller stream today **[I]**.
- The pedal coalesces in C++ (`pending_sustain_value_` latest wins), which is the right model.

### 2.2 GIL

- `waitForParameterUpdate` has no `gil_scoped_release` (`AddArraysWithCUDA.cpp:786`, still true on dev
  2b5bc64) **[M, source]**. Every slow-path swap holds the GIL for about 4 ms.
- The MIDI listener is a Python thread. A note sent while an 88-pitch excitation write runs arrives 30–330 ms late
  (median 80–98 ms) after the `time.sleep(0)` yields **[M, 10-28 exp08]**. The pedal travels on the same thread,
  so the "meets today" verdict for the pedal holds only while no heavy write is running.
- A pitch-wheel stream on the slow path would spend about 10 ms of Python per message, which is a full core of
  GIL at 100 Hz, and it would starve notes and the pedal in the same way **[I]**.

### 2.3 What is left on the excitation slow path after dev-hstall

dev-hstall fixes the leak (writes were 45× slower after 46 h) and the agent is moving the impulse integration into
C++. Assuming that lands:

- The impulse maths is about 0.5 ms per curve in numpy. 88 pitches × 6 levels = 528 curves = 273 ms with a
  per-curve loop. Vectorising does **not** help: 404 ms float64, 231 ms float32, because 10.8 M `exp` calls are
  bound by memory traffic **[M, offline microbenchmark below, loaded machine]**. In C++ it will be several times
  faster, but it is still 10.8 M `exp`, so about 10–50 ms on the host **[I]**. Recomputing only the edited
  level (F3a) cuts that 6× (88 curves: 43 ms numpy **[M]**).
- `load_from_dict` (F4) is still about 206 ms for 88 pitches **[M, 10-23]**, and it is pure Python, so it
  is also the GIL starver.
- One swap of a 2.6 MB upload, plus the journal and broadcast.
- **The remaining floor is about 0.25 s for an 88-key curve edit.** That is fine for editing in the UI and an
  order of magnitude too slow for a controller.

## 3. Physical and stability concerns

| Concern | Finding |
|---|---|
| **CFL / Courant guard** | **It no longer rejects edits.** Since 2026-07-08 the host check is indication only (`_flag_cfl_indication`, `parameter_manager.py:818`; SYNTHESIS_ENGINE "v3 gate removed"). DATA_FLOWS §2.1 still describes the old reject/skip gate and is stale. The only safety net is the in-kernel amplitude guard (`amplitude_limit`, default 1e4). On a trip it drops the cycle and **zeroes all string and mode state** (dev-538e self-heal). For a controller that crosses the bound, **every sounding note cuts out at once**. So every string-physics modifier must be **clamped** to a range computed in advance (§5 step 2). The directions that can breach the bound: tension up and length down (Courant `T − 8B` rises, ∝ T/dx²), stiffness or radius up (bending edge `max|g| > 1`). Damping in either direction is safe (`dec_inv` keeps it stable) **[I, from the scheme]**. |
| Clicks / zipper | Changing a coefficient leaves the displacement unchanged, so a step makes no discontinuity in the waveform. Measured for damping: 100 Hz and 25 Hz CC sweeps raise the HF crest by no more than the noise (3.8–4.4 dB) **[M, pedal test 8]**. For tension (pitch) a step is a frequency step. With 14-bit bend at 100 Hz the steps are fractions of a cent (inaudible). With a 7-bit CC over ±2 semitones a step is about 3 cents and could zipper **[I]**. A per-cycle slew (linear ramp of the scale over N cycles in `parameterKernel`) removes it. Then `parameterKernel` runs every cycle while a ramp is moving. That cadence is **unmeasured** (only every 4 cycles is measured clean). |
| Energy jumps | Raising tension at constant displacement raises the potential energy ∝ T, so amplitude follows the pitch a little, as on a real string **[I]**. Damping changes only the decay rate. Excitation and hammer changes affect only new strikes, so a sounding note has nothing to jump. |
| Coefficient vs curve atomicity, the ~1 ms mixed window | On the slow path: excitation commits the coefficient after the curve swap, so a strike can hit new curve + old coefficient for about 1 ms **[M, 10-28]**. Phase 2 is still open. A multi-parameter string edit makes **one swap per parameter**, about 4 ms apart, so it leaves a mixed state of about 4 ms **[I, `_flush_gpu_write_plan`]**. **Modifiers avoid all of this.** The engine thread writes them between kernels, so the whole keyboard changes at one cycle boundary. A strike-time excitation modifier is read at staging on the same thread, so the curve and the coefficient always agree. |
| Density / length | Both change `string_gain` (excitation loudness) and pitch. Length also changes `dx`, so tension and bending both move, by 1/dx² and 1/dx⁴. As a performance controller they are poor choices: pitch is better driven by tension, which is cleaner and has one CFL direction. If wanted, offer them only as a clamped scale. |

## 4. Why the existing live controls meet (or not) 30 ms

- **Damper pedal: meets.** It is one integer. C++ coalesces it, latest wins. The engine applies it at most once
  every 4 cycles. `parameterKernel` computes every string's coefficient from the value plus a per-string curve
  uploaded once (`setDamperCurve`). No Python model, no swap, no journal. Exposure: the Python listener (§2.2).
- **Volume, feedback coefficient: meet on the engine side.** Each is a device scalar written by
  `setRuntimeParameters` (async on the synthesis stream since dev-cpkg, no device-wide sync), and it is audible
  at 18–19 ms **[M]**. Two gaps:
  - They take `cuda_lock`, so they wait behind any slow-path write that holds it (up to 0.4 s during an
    88-pitch excitation write **[M, 10-23 lock hold]**).
  - **MIDI CC7 / CC74 never reach them.** `midi_to_event_type` maps only notes and CC64 (`pianoid.py:159`).
    Those CC actions live in the legacy `MidiListener`, which is not running. The same is true of pitch bend
    (MIDI_SYSTEM: the dev-ped1 follow-up "pitch bend never reaches the engine on the unified path").
- **Pitch wheel: not working live today.** Its legacy action is one 88-pitch `string` edit through
  `edit_commit` per message. Wired back on that path it would cost 29 ms for one update and would collapse under
  a stream (§2).

## 5. Recommended architecture: controller modifiers

Principle: **a controller writes a few numbers; the engine thread applies them at a cycle boundary; the kernels
derive per-string and per-mode values.** This is how the pedal works, generalised.

```
MIDI (CC / pitch bend / channel pressure)
  → listener: decode → push CONTROL(target_id, value14) into RealTimeEventBuffer      (no model, no journal)
engine thread, each cycle: applyPendingControls()  (generalised applyPendingSustain)
  → ControllerMap[target]: curve (lin / exp / table), range, CLAMP [lo, hi] → modifier value
  → slew toward it (optional, per cycle); latest wins; rate-limit like SUSTAIN_MIN_CYCLE_GAP
  → write dev_modifiers[] (one small array, cudaMemcpyAsync on synthesis_stream_)
  → string targets: requestParameterKernel(); mode / output targets: no extra kernel; excitation: host value read at staging
UI: one throttled 'controllers_changed' (≤ 10 Hz) broadcast; no undo entry per message;
    a "fold into preset" action = ONE slow-path write (like the feedback "Set" button)
```

| Family | Modifier(s) | Applied where | Notes |
|---|---|---|---|
| Volume, deck feedback | existing runtime scalars | existing | only the ControllerMap wiring is new |
| Deck feedin | `feedin_scale` (new runtime scalar) | MainKernel feedin reduction, or folded like the existing `dev_feedback_output_mask` | MainKernel is register-tight (cooperative launch; see memory "register budget"): check with `ptxas_budget.py` |
| Sound channels / radiance | `channel_gain[num_channels]` | output stage | a few numbers; same register check |
| Pitch bend | `tension_scale` (pitch ratio ≈ √s, so ±2 semitones ⇒ s ∈ [0.794, 1.260]) | `parameterKernel`: `coeff_tension × s` before `shift_0` / `shift_1` | clamp `s ≤ s_max`. The host computes `s_max = min over strings of CFL_MARGIN / Courant_i` at preset load and on each edit (`cfl_stability` already has the per-string numbers) and sends it with the map. The kernel clamps too |
| Damping, dispersion damping | `gamma_scale`, `disp_decay_scale` | `parameterKernel` (`dec_curr`, `coeff_frequency_decay`) | the damper multiplier is already this pattern |
| Stiffness / radius | `bending_scale` | `parameterKernel` (`coeff_bending`) | clamp for the `max|g| > 1` edge, computed in advance as above |
| Detuning | `detune_scale` | `parameterKernel`: tension × (1 + i·d·s) per unison string | needs the unison index in `dev_string_map` (check) |
| Modes | `mode_freq_scale` k, `mode_damp_scale`, `mode_gain_scale` | a tiny `modeParameterKernel` that writes effective `w·k²`, `d·k`, `mass_inv·g` from the stored `dev_mode_state` into an effective buffer that MainKernel reads (keeps MainKernel registers unchanged) | `d = decrement·f/sr`, `w = (2πf/sr)²` (DATA_FLOWS audibility formula). 196 × 3 values, µs |
| Excitation volume | `exc_gain` | host, at staging: `excitation_coefficients_[s][v] × g` in `_append_string_gp` | exact (loudness is linear in the curve volume), zero GPU work |
| Excitation mu / sigma | `exc_mu_shift`, `exc_sigma_scale` | `gaussKernel` arguments | the coefficient needs compensation: the temporal impulse changes with sigma and, when the window clips, with mu. Exact option: normalise on the GPU (gaussKernel already evaluates `f_k`; a per-strike sum plus a scale pass costs µs). Building on dev-hstall's C++ impulse: compensate at staging from the C++ closed form |
| Hammer position / width / sharpness | `hammer_pos_offset` etc. | **precomputed tables**: at load, K variants of `dev_hammer` (98 KB each; K = 32 ⇒ 3 MB) plus their spatial factors; the modifier picks or blends two variants in `parameterKernel` and at staging | avoids GPU hammer-shape synthesis; K bounds resolution (or blend between neighbours) |

**What modifiers do not cover:** a controller that reshapes **per-key** data (for example, one key's curve).
That stays on the slow path. Make it bearable with backend latest-wins coalescing (one write in flight per
target), F2b (event or condition-variable swap handoff instead of 100 µs / 1 ms sleeps), F2c (`gil_scoped_release`
on `waitForParameterUpdate`), F3a/F4 for excitation, and remove the per-update `printf` that streams to every page.

## 6. Build order

1. **Controller event + map, runtime targets only.** A `CONTROL` event type and `applyPendingControls` in C++. A
   ControllerMap set over REST and persisted like `midi_input_settings.json`. Decode CC / pitch bend in
   `midi_to_event_type`. Targets: volume, feedback coefficient. This fixes CC7 / CC74 / pitch bend being dropped
   today. No kernel change.
2. **String modifiers in `parameterKernel`:** tension (pitch bend), gamma, dispersion damping, bending, detune,
   with the precomputed CFL clamp. Verify: a pitch-bend sweep at 100 Hz under 10 notes, overruns, a clip check, and
   an HF crest check like pedal test 8. Then decide on per-cycle slew from that (measure `parameterKernel` at an
   every-cycle cadence).
3. **Mode modifiers** (`modeParameterKernel` + effective buffer) and **feedin / channel gain** (register
   budget first).
4. **Excitation volume** at staging (trivial). Then **mu / sigma** with GPU-side or closed-form normalisation,
   after dev-hstall's C++ coefficient lands.
5. **Hammer tables.**
6. **C++ MIDI ingress** (RtMidi callback thread straight into `RealTimeEventBuffer`). This takes notes, the pedal
   and controllers off the GIL for good, and closes the §2.2 risk for everything.

Independent and cheap, any time: F2b + F2c (the swap drops from about 4 ms to under 1 ms, and the GIL is
released during it). Also correct DATA_FLOWS §2.1, which still describes the removed CFL reject gate.

## Offline microbenchmark (this review)

`C:\Users\astri\AppData\Local\Temp\claude\D--repos-PianoidInstall\e3e92ee6-279f-44a6-8ae0-61d28f337451\scratchpad\mb.py`,
PianoidCore venv Python, `-I`, plain numpy. It is a replica of `gpu_force_curve` (4096 points × 5 Gaussians,
excitation factor 8) with random curves and no project imports. N = 5, median [min–max] ms. The machine was
loaded: another agent was building C++.

| Case | ms |
|---|---|
| per-curve loop, 528 curves (88 pitches × 6 levels) | 273 [259–350] |
| per-curve loop, 88 curves (one level) | 43 [41–47] |
| one vectorised pass, 528 curves, float64 | 404 [401–423] |
| one vectorised pass, 88 curves, float64 | 64 [61–70] |
| one vectorised pass, 528 curves, float32 | 231 [204–321] |
| 65 536-value deck `tolist()` | 1.2 [1.0–1.8] |
