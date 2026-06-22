# In-Place CUDA Re-Initialize — Apply STRUCTURAL params without stopping the backend or reloading the preset

- **Status:** PROPOSAL — plan only, NOT implemented. Awaiting user review before any code.
- **Date:** 2026-06-22
- **Author:** dev-applyc
- **Builds on:** the Cluster C classify-and-route foundation already implemented on `feature/dev-applyc`
  (`preset_reinit.classify_reinit` + the `load_preset_route` HOT/STRUCTURAL seam + the FE `usePreset`
  `presetVersion`-suppression). This proposal adds a THIRD route below — the in-place GPU re-init — between
  today's two (hot runtime-set vs full reload).
- **Grounding:** all code claims below are MEASURED from the live source (read-only traces af5aa9ff /
  a4058a8 / a58fb2f); file:line refs are inline. High-stakes data-model facts carry doc/measurement support
  per `PROJECT_CONFIG.md#data-model-facts`.

---

## 1. Problem (as diagnosed in Cluster C)

Changing any STRUCTURAL / GPU parameter (`array_size`, `string_iterations`, `cycle_iterations`,
`sample_rate`, `audio_driver_type`, `audio_buffer_size`, …) today forces the full
`/load_preset` path: `destroyPianoid()` **+ a fresh `initialize(path, …)` that re-reads the preset file**.
That:

- tears down the engine AND re-reads the preset JSON from disk — **discarding the user's in-session
  edits** (the live domain model is rebuilt from the file), and
- forces the frontend to re-init (`presetVersion` bump → every editor discards its local history),
  **wiping the UI's edited values** and resetting the view.

But the preset does **not** need reloading — only the GPU module needs to re-initialize with new buffer
dimensions. There is currently no path to re-init CUDA without reloading the preset and resetting
everything.

**Goal:** re-initialize JUST the `pianoidCuda.Pianoid` GPU module with new GPU params, WHILE
keeping the Flask process up, the live Python domain model (with the user's edits) intact, the FE
connection/state intact, and with NO preset reload and NO `presetVersion` bump.

---

## 2. The enabling fact — `destroyPianoid()` frees the GPU but NOT the domain model

The whole design rests on this measured separation (`pianoid.py:1361-1368`):

```python
def destroyPianoid(self):
    if type(self.pianoid) != type(None):
        self.stop_playback()        # halts audio thread + stops driver
        del self.pianoid            # C++ destructor → frees GPU memory
        self.pianoid = None
```

`destroyPianoid()` deletes ONLY the C++ engine handle `self.pianoid` (the `pianoidCuda.Pianoid`
binding) and frees its GPU memory. It leaves **untouched**:

- `self.sm` — **StringMap** (per-pitch physics, hammer, gauss/excitation — the edited domain model)
- `self.modes` — **ModeMap**
- `self.mp` — **ModelParameters** (array_size, string_iteration, sample_rate, listen_to_modes, …)
- `self.param_manager` — **ParameterManager** (holds refs to the above + the cuda_lock)
- `self._library` — **PresetLibrary** (the working-copy registry)

So after a `destroyPianoid()`, the Python side still holds the *current edited state*. The C++ engine
can be reconstructed from it. **This is what makes an in-place re-init possible as pure middleware
orchestration.**

### 2.1 The domain model IS the source of truth for edits (CONFIRMED — brief item 1/3)

User edits land in the **live Python domain model**, not just on the GPU:

- A per-pitch edit calls `ParameterManager.update_pitch_physical_params(...)` →
  `pitch.set_param(**params)` which **mutates `self.sm.pitches[pitchID]`** (`parameter_manager.py:330-390`),
  THEN packs `self.sm.pack_parameters()` and uploads to GPU.
- Every GPU upload re-packs from `self.sm` (e.g. `send_updated_params_to_CUDA` →
  `self.sm.pack_parameters()`, `parameter_manager.py:187-197`).
- The PresetLibrary **working copy entry IS the same object** as `self.sm/self.modes/self.mp` —
  `register_working(working_name, self.sm, self.modes, self.mp, …)` stores live references, NOT a
  deep copy (`pianoid.py:2246`, `preset_library.py:188-201`). (The *original* entry IS a pristine deep
  copy — `register_original`, `preset_library.py:175-186` — but that is the read-only snapshot, not the
  working copy.)

**Therefore:** re-packing from `self.sm/self.modes/self.mp` after a destroy reproduces the user's
CURRENT edited state — NOT the preset-file defaults. The re-upload source is the live model, exactly as
the goal requires.

### 2.2 `init_params` / `strings_in_pitches` derive from the live model (CONFIRMED — brief item 3)

The C++ constructor inputs come from the domain model, so changing a structural value on `self.mp`
before reconstruction makes the new engine pick it up:

- `strings_in_pitches`, `state_0/1`, `stringMap`, … = `self.sm.pack_parameters()` (`pianoid.py:2122`)
- `init_params` = `self.pack_initialization_params_for_cuda(audio_driver_type, max_volume)` which packs
  `self.mp.pack_as_dict_for_cuda()` (array_size, string_iterations, cycle_iterations, sample_rate,
  sound_derivative_order, listen_to_modes) + the audio-driver enum + buffer chunks (`pianoid.py:2329-2395`).

So the **new structural values are carried by mutating `self.mp` (+ the audio-driver args), then
re-packing** — everything else flows from the unchanged `self.sm/self.modes`.

---

## 3. Proposed procedure — `reinitialize_cuda_engine(new_gpu_params)`

A new method on the middleware `Pianoid` wrapper (`pianoid.py`), driven by a thin backend route helper.
**Pure middleware orchestration — reuses existing C++ entry points; no C++/pybind change** (see §5).

### 3.1 What carries new values vs what is preserved (brief item 3)

| Carried by `new_gpu_params` (mutate `self.mp` / pass to constructor) | Preserved (re-uploaded from the live model) |
|---|---|
| `array_size`, `string_iterations`, `cycle_iterations`, `sample_rate` (→ `self.mp`, re-packed) | All per-pitch physics / hammer / gauss / excitation edits (`self.sm`) |
| `audio_driver_type`, `audio_buffer_size` (→ new `init_params`, driver re-opened by the new constructor) | All mode edits (`self.modes`) |
| `sound_derivative_order`, `listen_to_modes` (→ `self.mp`) | Deck (feedin/feedback) routing + coeffs |
| `max_volume` (constructor arg) | Runtime params (volume level / feedback coeff) — re-applied from current values |
| | The active preset name + library; the Python domain model identity; the Flask process; the FE socket/state |

### 3.2 Ordering (brief item 1 — the correct sequence)

```
reinitialize_cuda_engine(new_gpu_params):           # holds self.cuda_lock for the GPU window
  PRE  0. snapshot current runtime params (volume level, feedback coeff) for re-apply in step 11
       1. cleanly STOP + JOIN the realtime audio thread:
            stop_playback()  →  self.listen=False (+ join MIDI thread)
                              →  self.online_engine.stop()
                              →  self._playback_thread.join(timeout=3.0)   (warn if still alive)
                              →  self.pianoid.stopAudioDriver()
          (state → PAUSED)
  FREE 2. destroyPianoid()  →  del self.pianoid (C++ dtor frees GPU)  →  self.pianoid = None
            ↳ self.sm / self.modes / self.mp / param_manager / _library all INTACT
  SET  3. apply new structural values onto the LIVE model:
            self.mp.array_size = new.array_size; self.mp.string_iteration = …; sample_rate; etc.
            (geometry rescale for array_size mirrors today's path — see §3.4)
  PACK 4. re-pack from the (edited) model with the NEW dims:
            strings_in_pitches, state_0, state_1, …, stringMap = self.sm.pack_parameters()
            init_params = self.pack_initialization_params_for_cuda(new.audio_driver_type, max_volume)
  CTOR 5. RECONSTRUCT:  self.pianoid = pianoidCuda.Pianoid(strings_in_pitches, init_params)
            ↳ the new constructor RE-OPENS the audio driver with new.audio_driver_type / buffer
  ALLOC 6. self.pianoid.devMemoryInit(state_0, state_1, …, stringMap, …)   # new-dim GPU buffers
  LIB  7. re-establish the engine's preset slot from the live model:
            self._load_preset_to_library(active_name, physical_parameters, hammer, gauss, mode_state, mode_coeffs)
            self.pianoid.switchPreset(active_working_name, False)
  UP   8. self._upload_excitation_coefficients()      # re-packs from self.sm
       9. self.pianoid.initParameters()               # ⚠ idempotency — see §5/§7 measurement
      10. self.send_updated_params_to_CUDA() + send_deck_params_to_CUDA()   # belt-and-braces: push edits
  RT  11. re-apply snapshotted runtime params (setRuntimeParameters: volume level, feedback coeff)
      12. re-register lifecycle callbacks; rebind param_manager.pianoid = self.pianoid
  GO  13. restart the realtime thread (the backend re-spawns via the existing _restart_realtime_thread hook)
          (state → PLAYBACK_ACTIVE)
```

> **DRY note (design choice to settle in implementation):** steps 4-9 ARE the body of the existing
> `init_pianoid` (`pianoid.py:2113-2315`). The cleanest implementation **extracts that
> construct→devMemoryInit→library→switch→excitation→initParameters block into a private
> `_construct_and_load_gpu(...)` helper** and calls it from BOTH `init_pianoid` (first load) and
> `reinitialize_cuda_engine` (in-place). The alternative — calling `init_pianoid`/`initialize_pianoid`
> again — is BLOCKED by a lifecycle gate: `initialize_pianoid` early-returns when
> `_lifecycle_state != UNINITIALIZED` (`pianoid.py:1398-1401`). Re-driving it would require first
> forcing the state back to `UNINITIALIZED`, which is fragile. **Extract-the-helper is preferred**
> (one sequence, two callers — no duplicated 13-step body, no lifecycle-gate hack). This refactor is
> behaviour-preserving for the first-load path.

### 3.3 Preservation guarantees (brief item 2)

- **Flask stays up:** nothing touches the process; the route returns normally.
- **Python model + edits stay:** §2/§2.1 — `destroyPianoid` leaves `self.sm/modes/mp` intact; the
  re-upload re-packs from them; the active library working copy IS those objects.
- **FE connection/state stays:** the Socket.IO connection is independent of the engine; no disconnect.
  Critically, the response is **`reinit: "structural-inplace"`** (a NEW kind) → the FE treats it like a
  hot apply: **NO `presetVersion` bump, NO editor re-fetch** (the FE already edits this in `usePreset`,
  §6). The edited values stay on screen and stay authoritative; the backend already matches them.

### 3.4 `array_size` geometry rescale

`array_size` differing from the preset's native value triggers a proportional rescale of `main`/`tail`
string geometry (REST_API.md line 352; today done inside the `/load_preset` path / `Pianoid.__init__`).
The in-place path must apply the **same** rescale onto the live `self.sm` (step 3) BEFORE re-packing,
so the new-dim buffers match. Implementation must reuse the existing rescale routine (find it in the
`Pianoid.__init__`/StringMap geometry path), NOT re-derive it — flagged for the implementer.

---

## 4. Integration with classify-and-route (brief item 5)

The Cluster C classifier already partitions an Apply; this proposal upgrades the STRUCTURAL branch from
"full reload" to "in-place re-init", and keeps a true full reload ONLY for a preset-name change:

| Apply diff (vs live signature) | Route | FE behaviour |
|---|---|---|
| **Name unchanged**, only HOT (volume / feedback / max_volume) | existing runtime-set (`/set_runtime_parameters` path) — `reinit: "hot"` | keep state (already shipped) |
| **Name unchanged**, a GPU/STRUCTURAL param changed | **NEW `reinitialize_cuda_engine`** — `reinit: "structural-inplace"` | keep state (NO reset, NO bump) |
| **Preset name / path changed** | today's full `destroyPianoid()+initialize(path,…)` — `reinit: "full"` | full re-init (bump + re-fetch) — correct: a different preset SHOULD load fresh |

This is a small change to `classify_reinit`: it must distinguish **path-changed** (→ `full`) from
**only-structural-changed, same path** (→ `structural-inplace`). The classifier already computes
`changed` (the list of differing fields) and already treats `"path"` specially — so the split is:
`"path" in changed → full`; else `any STRUCTURAL field in changed → structural-inplace`; else
`hot`. (The HOT subset extraction stays as-is.) The live `_reinit_signature` stash already captures
the values needed for this diff.

---

## 5. Pure middleware vs C++/pybind change? (brief item 4 — MEASURED)

**Determination: PURE MIDDLEWARE ORCHESTRATION. No C++/pybind change required** to make the mechanism
work — every entry point the sequence needs already exists and is re-callable on a freshly-reconstructed
engine:

| Step | Existing C++ entry point | Re-callable on a new engine? |
|---|---|---|
| reconstruct | `pianoidCuda.Pianoid(strings, init_params)` ctor (`pianoid.py:2174`) | yes — it IS the constructor; re-opens the driver |
| alloc | `devMemoryInit(...)` (`pianoid.py:2199`) | yes — GPU allocation on the fresh object |
| library | `loadPresetToLibrary(...)` / `switchPreset(...)` | yes — populate + activate a slot |
| excitation | `_upload_excitation_coefficients()` (re-packs `self.sm`) | yes |
| kernel args | `initParameters()` (`pianoid.py:2281`) | ⚠ **needs live measurement** (see §7) |
| runtime | `setRuntimeParameters(...)` | yes |
| audio stop/start | `stopAudioDriver()` / new ctor opens driver | yes |

The only middleware *refactor* (not a feature gap) is extracting `_construct_and_load_gpu` (§3.2 DRY
note). **No new pybind method is needed** to keep the domain model — the model already lives entirely
on the Python side and survives `destroyPianoid` by construction.

> If §7 measurement reveals `initParameters()` is NOT safely re-runnable on a reconstructed engine (e.g.
> it caches first-init-only state), that would be the ONE place a small C++/pybind adjustment could be
> required. Current evidence is "likely fine" (it runs once per fresh constructor today, and the in-place
> path also gives it a fresh constructor) — but this is the highest-uncertainty item and MUST be measured
> before implementation, not assumed.

---

## 6. Frontend change (small — extends the shipped Cluster C seam)

`usePreset.loadPreset` already branches on `response.data.reinit`. Extend the hot-skip condition to also
cover the new kind:

```js
const keepState = response?.data?.reinit === "hot"
               || response?.data?.reinit === "structural-inplace";
if-block guarding the editor re-fetch + presetVersion bump becomes `if (!keepState) { … }`
```

So a `structural-inplace` Apply preserves the editor state identically to a hot Apply. No other FE change
— the engine restarts itself; the FE just keeps its values. (The PianoidTuner Apply call site is
unchanged; it still calls `loadPreset(settings)`.)

---

## 7. Thread-safety, ordering, failure handling, risks (brief items 6 + 7)

### Thread-safety / ordering (brief item 6)
- **Stop + join BEFORE destroy** (step 1): `stop_playback()` signals `online_engine.stop()`, sets
  `self.listen=False`, and `join(timeout=3.0)` the playback thread (`pianoid.py:437-490`). Destroying the
  C++ engine while the realtime thread still touches it = use-after-free → the join is mandatory and must
  precede step 2. (Warn-and-proceed if the 3 s join times out — but treat a non-joined thread as a hard
  error for the in-place path, since a surviving thread will touch the freed engine.)
- **GPU free-before-alloc** (steps 2→6): `del self.pianoid` frees old GPU buffers before the new
  constructor + `devMemoryInit` allocate the new-dim buffers — avoids holding 2× device memory and avoids
  allocating against a stale context.
- **cuda_lock**: hold `self.param_manager.cuda_lock` across the GPU window (steps 4-12) so no concurrent
  editor upload races the reconstruction. (Editor writes already take this lock.)
- **Audio driver re-open**: handled by the new constructor (step 5) with the new
  `audio_driver_type`/buffer — the same mechanism `/load_preset` uses today; the ASIO→SDL3 fallback path
  applies unchanged.
- **Realtime restart** (step 13): reuse the backend `_spawn_realtime_thread` / `_restart_realtime_thread`
  hook so `running` + lifecycle are restored exactly as on a normal load.

### Failure handling (brief item 6 — the recovery gap)
There is **no existing recovery** for "reconstruct fails after the old engine was freed" — if step 5
(`Pianoid(...)`) or step 6 (`devMemoryInit`) throws, the old engine is already gone and the backend is
left engine-less. The plan adds an explicit recovery contract:

1. Wrap steps 2-13 in try/except.
2. On failure: set `self.pianoid=None`, force lifecycle → a clear `CRASHED`/`UNINITIALIZED` state, and
   return HTTP 500 with `error: "ReinitFailed"` + the structural params that failed.
3. The FE, on `ReinitFailed`, surfaces the error AND offers a one-click **full reload** (`/load_preset`
   with the same settings) as the recovery — that path re-reads the preset and rebuilds from scratch
   (edits are lost on recovery, but the engine is restored). This mirrors the existing destroy-then-crash
   gate philosophy at `backendServer.py:~1073-1091` (which avoids destroying until it knows it can build).
4. **Pre-validate where possible**: classify can reject obviously-bad structural combos (e.g. array_size
   out of 384-512) BEFORE the destroy, so the common bad-input case never frees the engine.

### Risks
- **R1 — `initParameters()` re-run semantics** (highest uncertainty): must measure idempotency on a
  reconstructed engine (§7 measurement). If unsafe → small C++ change.
- **R2 — GPU memory churn / driver re-open stability**: rapid structural Applies stress free→alloc +
  driver open. Measure: repeated in-place re-inits with alternating `array_size` (384↔512) — no leak, no
  driver-open failure, no underrun storm.
- **R3 — partial-failure engine-less window**: addressed by the recovery contract; verify the FE recovery
  path actually restores a playable engine.
- **R4 — geometry rescale correctness**: the in-place `array_size` rescale must produce byte-identical
  geometry to the `/load_preset` path for the same array_size (else the in-place result diverges from a
  full reload). Reuse the existing routine; verify by comparing offline renders (in-place vs full reload
  at the same array_size = identical).
- **R5 — this 56-SM box crashes on the FE audio_on path** (known): the full live Apply test folds into the
  user's combined test on their working system, per the standing constraint.

### Verification approach (brief item 7)
- **Unit (offline, audio_off, no shared :5000):**
  1. classify split test — name-changed→full, structural-only→structural-inplace, hot-only→hot
     (extends the existing `test_preset_reinit_classify.py`).
  2. edit-survival test: load preset → edit a per-pitch param → in-place re-init with a new array_size →
     assert the edited value is still present in `self.sm` AND in the offline render (NOT reset to the
     preset default). This is the central correctness proof (edits survive).
  3. equivalence test (R4): in-place re-init to array_size X vs a full reload at array_size X → identical
     offline render.
  4. recovery test: force a reconstruct failure (bad params) → assert engine-less state + 500
     `ReinitFailed`, then a full reload restores a playable engine.
- **FE Jest:** extend `usePreset.hotReinit.test.jsx` — `reinit:"structural-inplace"` → no re-fetch, no
  `presetVersion` bump (state kept); `reinit:"full"` still bumps.
- **Live (user's working system — combined test):** load preset → edit values in several panels → Apply a
  structural change (e.g. array_size 384→512) → confirm: no backend restart, no UI reset, edited values
  retained on screen AND audible, sound continues. (The 56-SM box can't drive the FE audio_on path.)

---

## 8. Scope summary (what to build when approved)

- **Middleware:** extract `_construct_and_load_gpu(...)` from `init_pianoid`; add
  `reinitialize_cuda_engine(new_gpu_params)` (the §3.2 sequence) + the recovery contract; a backend route
  helper that the STRUCTURAL branch of `load_preset_route` calls instead of full reload (returns
  `reinit:"structural-inplace"`). Reuse the existing geometry-rescale routine.
- **Classifier:** split STRUCTURAL into path-changed (→full) vs same-path-structural (→structural-inplace)
  in `preset_reinit.classify_reinit`.
- **Frontend:** widen the `usePreset.loadPreset` keep-state condition to include `structural-inplace`.
- **Build:** PURE Python middleware + FE. **NO CUDA build** — UNLESS §7/R1 measurement shows
  `initParameters()` needs a C++ change (then a HEAVY `--both` build enters scope; flag to user at that
  point).
- **Tests:** the §7 unit + FE + live set.

**Build type confirmation:** no `.cu/.cpp/.cuh/.h` edits are planned. The one contingency (R1) is the
sole path to a CUDA build; it is gated behind a measurement, not assumed.

---

## 9. Open questions for the user (review gate)

1. **Recovery UX on `ReinitFailed`**: auto-offer a full reload (edits lost, engine restored), or surface
   the error and let the user choose? (Plan currently: surface + one-click full-reload.)
2. **`structural-inplace` while paused/stopped**: if the engine is loaded but NOT playing (audio_on=0),
   the in-place path skips the thread stop/start but still does the GPU reconstruct — confirm that's the
   desired behaviour (it should be).
3. **Scope of "structural" for in-place**: include `audio_driver_type`/`audio_buffer_size`/`audio_on` in
   the in-place path (they re-open the driver via the new constructor — supported), or keep those as full
   reload for now? (Plan currently: in-place handles them, since the new constructor opens the driver
   anyway.)

---

### Investigation history
- Cluster C classification + routing (shipped, `feature/dev-applyc`): `preset_reinit.py`,
  `backendServer.py:load_preset_route`, `usePreset.loadPreset`; session log
  `docs/development/logs/dev-applyc-2026-06-22-054100.md` (Data Model Card + classification-validation).
- Feasibility traces (read-only): destroyPianoid/domain-model separation, edit-write path, upload paths,
  realtime-thread lifecycle, C++/pybind feasibility, failure modes (af5aa9ff / a4058a8 / a58fb2f).
