# Proposal: Online vs Offline Synthesis — Root-Cause Analysis & Path Unification

**Date:** 2026-05-29
**Status:** Proposed — ANALYSIS ONLY. No source changed, nothing built, nothing committed. (Two throwaway measurement scripts were run in a separate `audio_off` process; the user's running stack was not modified.)
**Author tag:** `[online-offline-unify]` (analyse-arch, task #173) — **maximum-rigor pass** per team-lead escalation.
**Trigger:** The user reports *incorrectly rendered notes* that appear **only in online (live UI) synthesis**, never in the offline `note_playback` render — the "55/56/57 trichotomy" (p55 OK, p56 "does not decay", p57 "click"). A prior session shipped a frontend `handleMouseUp` fix on `feature/vp-noteoff-fix`; **that fix FAILED.** The user believes this exposes a severe architectural inconsistency between two synthesis paths.

---

## ⚠️ 2026-05-29 UPDATE — ROOT CAUSE REPRODUCED (supersedes §0–§5 conclusions below)

The user clarified the bug is **consistent across ALL play methods (mouse + MIDI + space-bar)**, which REFUTES the `handleMouseUp` conclusion in §0/§2 (MIDI and space never touch that handler). A cross-method bug must live in the path COMMON to all methods. Reproduced + root-caused (dev-8085, full detail in `docs/development/logs/dev-8085-2026-05-29-123705.md`; memory `project_trichotomy_sint32_overflow`):

**ROOT CAUSE — pervasive Sint32 OVERFLOW in the `soundInt` driver path.** Reproduced with the prior sessions' EXACT config (Belarus_8band_196modes-MFeq, **`listen_to_modes=0` STRINGS**, **legacy `volume=120` → `main_volume_coefficient` mvc ≈ 9.74e9** via `exp((120+64)/8)^…`, velocity 127) driven over the **real WebSocket `handle_ws_play` path** (the transport ALL methods use — `usePreset.playNote` is "WebSocket-first, REST-fallback"). Reconstructing the literal driver samples `soundInt = int32(output × mvc)`:

| pitch | out_peak (soundFloat) | scaled_peak / INT32_MAX | overflow frac | sign-wrapped frac |
|------:|---------:|---------:|---------:|---------:|
| 55 | 9.2 | **41.6×** | 0.55 | 0.28 |
| 56 | 36.8 | **167×** | 0.57 | 0.29 |
| 57 | 5.5 | **24.8×** | 0.46 | 0.26 |
| 59 | 22.2 | **101×** | 0.52 | 0.29 |
| 60 | 32.1 | **146×** | 0.54 | 0.28 |

Every pitch's peak exceeds INT32_MAX by 25–167×; ~half the samples overflow; **~27–29% have their SIGN FLIPPED** by the 64→32-bit wraparound → the waveform randomly inverts = harsh digital garbage = "incorrectly rendered notes."

**Why cross-method + online-only + invisible to all prior measurement.** `MainKernel.cu:492` (string/stem path) and `MainKernel.cu:627` (mode-channel path) both do `soundInt = static_cast<Sint32>(output × main_volume_coefficient)` with **NO clamp/limiter**, and the 196-mode feedback sum is **unnormalized** (`output` peaks 5–38 instead of ≈±1). Every play path (mouse/MIDI/space → WS/REST → `schedule_event` → kernel) hits this `soundInt`. But offline `runOfflinePlayback` + `getRecordedAudio` + `getCurrentCycleAudio` + the `chart@sound` ring + `getSynthesisCaptureBuffer` ALL read `soundFloat` (`MainKernel.cu:493`, the PRE-volume `output`) — so the float decays cleanly on every drivable surface and the defect is invisible to every Python/REST/offline readout (this is exactly why §1's hypothesis table read "engine clean: online≈offline 0.987" — that 0.987 was the *soundFloat* path; the speaker hears `soundInt`). Confirmed there is **NO second float-level defect**: soundFloat is clean across a sequence and on 57/59 (no dropout, no accumulation runaway) in this config.

**§0/§2 correction:** `handleMouseUp` (sending NOTE_OFF for the release-cursor pitch, not `mouseDownPitch`) is a **real but MOUSE-ONLY minor bug** — keep it as a separate small frontend cleanup; it is NOT the cross-method "incorrectly rendered notes." The §3 D4 "soundFloat-vs-unclamped-soundInt output split" was the correct locus all along; it is now the confirmed, reproduced root cause.

### THE FIX (designed, not yet implemented — awaiting user fix-direction + team-lead GO)

Clamp ALONE is insufficient — simulated on the captured p56 float, clamp-only at mvc=9.74e9 still hard-clips (clamped-int↔float correlation only 0.64, ~square wave). **Clamp + gain-fix** gives perfect reconstruction (correlation 1.00, zero overflow, zero sign-wrap). Two parts:

- **PART 1 — saturating clamp** at BOTH emission sites (`MainKernel.cu:492` + `:627`, covering Strings AND Modes paths):
  ```cpp
  real scaled = output * main_volume_coefficient;
  scaled = fminf(fmaxf(scaled, -2147483520.0f), 2147483520.0f);  // largest float < 2^31
  soundInt[sampleIndex] = static_cast<Sint32>(scaled);
  ```
- **PART 2 — tame the gain** so a full-scale note lands near INT32 full-scale with headroom (the loudest pitch is ~344× too hot for −6 dBFS; even a normalized ±1 × mvc(9.74e9) = 4.54× INT32, so the volume mapping itself is over-hot). Levers: **(2c, recommended, smallest)** an `OUTPUT_NORMALIZE` constant (≈1/344) in `constants.h`, linear so relative dynamics are preserved; **(2b, principled)** normalize the unnormalized 196-mode sum in `Pianoid_synthesis.cu`/`MainKernel.cu` (root fix); **(2a)** correct the legacy `main_volume→max_volume` mapping in `pianoid.py:2037`.
- **Files/locks (CUDA → /dev, `--heavy --both`):** `MainKernel.cu` [primary] + (`constants.h` | `pianoid.py` | `Pianoid_synthesis.cu`) per chosen lever. Revert the pre-existing diagnostic probes in `Pianoid_excitation.cu` + `Pianoid_synthesis.cu` and clear the orphaned `dev-3580` lock before the `--heavy` build.
- **Loudness impact:** output drops ~344× (~−51 dB) vs the current *overflowing* level — but the current level is unusable garbage, so the result is "clean audible note at a sane level," dynamics preserved. User will likely re-set the volume slider once.

### SEPARATE ROBUSTNESS FINDING — engine-loop death / back-pressure deadlock (DOCUMENT, do NOT fix this pass)

The user's currently-running backend (PID 80416) is a **diagnostic LEFTOVER** from the `damper-probe-ea77` session (per `MODULE_LOCKS.md`: "Backend kept alive … PID 80416 on port 5000 SDL3"), NOT the user's interactive session — so it is **not evidence of the user's reported bug**. But characterizing it (read-only) revealed a **distinct, real robustness defect**: the `OnlinePlaybackEngine::run()` loop is dead (calibration_count frozen at 69763; 28 threads all in `Wait`; 32 of 36 events stuck undrained; `/capture` → HTTP 500; ring empty). Its log shows the last action was a CFL-unstable parameter edit — a **tension sweep to 500000** on pitch 56. Mechanism: tension=500000 is wildly CFL-unstable on this **unmerged-CFL-guard** backend (@67148fa) → FDTD blows to NaN/Inf → SDL3 callback (consumer) stalls → the engine thread blocks **forever** in `LockFreeCircularBuffer::produce()`'s back-pressure condvar → loop death → all subsequent notes neither sound nor release. This **confirms the WIP "UNCONFIRMED tension/length edit crash" item.** Two defense-in-depth sub-items (separate follow-up tasks, not this pass):
1. **Merge/honor the CFL guard** (`feature/cfl-stability-guard-v2`) so a CFL-unstable parameter edit is REJECTED pre-upload (HTTP 4xx), never reaching the kernel.
2. **Back-pressure deadlock guard** so a stalled audio consumer can NEVER freeze the engine loop forever — e.g. a bounded/timeout wait in `produce()` that drops a cycle (with a logged underrun) instead of blocking indefinitely. Defense-in-depth: even with the CFL guard, a stalled SDL3 callback must not deadlock the engine.

---

## 0. TL;DR (revised after measurement)

I enumerated the full hypothesis set across every layer and ruled each in/out with **hard measurement** (deterministic, wrap-free capture — not the racing ring) or **code evidence**. The headline result **overturns my own first-pass conclusion** and the prior session's:

1. **The synthesis ENGINE is not buggy on the note-on/off path.** Measured four ways — offline render, manual bare-kernel cycling, repeated-fire accumulation, and **the real live `OnlinePlaybackEngine` thread** — pitches 55/56/57/60 **all damp correctly and reproducibly**, and the live engine's output **matches the offline render sample-for-sample at the peak** (live peak 21.4/95.2/17.1/42.8 == offline 21.35/95.22/17.13/42.82).
2. **The proximate cause of "doesn't decay" is a FRONTEND bug that is still present.** `PianoidTunner/src/components/VirtualPiano.js::handleMouseUp` sends NOTE_OFF for the pitch **under the cursor at release**, not the pitch that was **pressed**. The prior "fix" added a `mouseDownPitch` state variable but **never used it in the note-off path** — so the bug is intact. Mouse drift off a ~5 px black key (or the mouse leaving the canvas while held) strands the pressed note: the engine never receives its NOTE_OFF, so the string keeps ringing — *correct physics, wrong input.* That is exactly "does not decay," and exactly why the previous fix "failed."
3. **The architectural inconsistency the user senses is REAL, but it is not the proximate cause of the trichotomy.** Online and offline are genuinely *different execution contexts* (in fact **three**: offline, online, and semi-offline-calibration), and they diverge in four structural ways (observability, state-reset, locking, and the output value path). These make the system **impossible to validate**, have already caused **two contradictory misdiagnoses**, and harbor **latent online-only failure modes** (an unclamped Sint32 cast that clicks at high volume; a WS dedup that can drop a NOTE_OFF; a parameter-write/engine race). They should be removed — but as an *architecture* fix, not as "the trichotomy fix."

**Way ahead (two tracks, both needed):**
- **Track 1 — Fix the live-only bug now:** correct `handleMouseUp` to release `mouseDownPitch` (+ the mouse-leave / button gaps), via `/dev` on PianoidTunner. This is the thing actually blocking the user. Small.
- **Track 2 — Make online/offline divergence STRUCTURALLY IMPOSSIBLE:** unify the three execution contexts behind one event-driven cycle loop with one reset policy, one output buffer (so the speaker and the analysis read the *same* samples), one lock discipline, and a clamped output stage. Larger; staged below.

---

## 1. Full hypothesis set — ruled in / out with evidence

The question "why does online diverge from offline" was decomposed across every layer. Each hypothesis is marked **OUT** (refuted), **REAL** (confirmed divergence), or **LIVE-ONLY LATENT** (a genuine online-only hazard, not necessarily firing in the bare repro). Evidence is a doc citation, a source line, or a measurement (scripts in §8).

| # | Layer | Hypothesis | Verdict | Evidence |
|---|-------|-----------|---------|----------|
| H1 | Kernel | The shared `runSynthesisKernel` damps 55/56/57 wrong | **OUT** | E1 offline + E2 manual bare-kernel: decay ratio 1e-5..8e-5 for all four pitches; probes show `dec_open[201..203]=1`, `damper_string=3.6e-05` intact on NOTE_OFF |
| H2 | State accumulation (D1) | Online never resets → residual energy makes notes "not decay" | **OUT (as a stuck-note cause)** / **REAL (as a divergence)** | E3: fire 6× with no reset → post-damper tail does **not** grow (p56 0.0078→0.0087 then flat; p57 0.0011×6). E4: superposition damps to ~3e-4 after damper. Accumulation is real but self-limiting; it does not strand a note |
| H3 | Live engine thread | `OnlinePlaybackEngine::run()` + wall-clock estimator damps differently than offline | **OUT** | Decisive live test (own-process real engine, freeze-then-read): all four pitches damp, **reproducible across 4 runs**, peaks == offline exactly |
| H4 | RealTime event delivery | A NOTE_OFF gets dropped/reordered by the per-cycle drain | **OUT (for live `/play`)** | `RealTimeEventBuffer::drainEventsUpTo` uses `upper_bound(cycle)` → drains everything at-or-before the cycle even if cycles are skipped (RealTimeEventBuffer.cu:74-115). The `getEventsAtCycle` silent-skip-consume (PLAYBACK_SYSTEM.md) applies **only** to `event_queue_` (MIDI files), not live play |
| H5 | RealTime back-pressure | Buffer cap evicts NOTE_OFFs first → stuck note | **OUT (single-note)** / **LIVE-ONLY LATENT (bursts)** | Eviction triggers only at `size_limit_=10000` (RealTimeEventBuffer.cu:24-38); irrelevant for the user's repro, but the policy *does* drop NOTE_OFFs first under flood — a real online-only hazard |
| H6 | **Frontend NOTE_OFF** | The UI sends NOTE_OFF for the wrong pitch / not at all | **REAL — PROXIMATE CAUSE** | `VirtualPiano.js:252-262` `handleMouseUp` emits `command:128` for `note=getNote(event)` (release-cursor pitch), not `mouseDownPitch`. `mouseDownPitch` is tracked (line 39/225) but unused in note-off. Plus `onMouseLeave={handleMouseUp}` + `event.button` gate drops the OFF when the mouse leaves while held. See §2 |
| H7 | WS transport | The Socket.IO `play` path differs from REST and can drop events | **LIVE-ONLY LATENT** | `handle_ws_play` dedups identical consecutive `(mapped_d1, command)` per `sid` and `return`s (backendServer.py:356-363, 380-385). REST `/play` has no such dedup. A repeated-pitch or out-of-order sequence can drop a NOTE_OFF here |
| H8 | Output value path | The speaker hears different samples than the analysis | **REAL — LIVE-ONLY LATENT** | `MainKernel.cu:492-493`: `soundInt = static_cast<Sint32>(output * main_volume_coefficient)` (driver path, **no clamp** → overflow is UB → click) vs `soundFloat = output` (offline + all observability, **pre-volume**). Offline/charts can *never* see clipping the speaker produces. See §3 |
| H9 | Parameter-write race (D3) | A live param edit corrupts a held note | **LIVE-ONLY LATENT (untested)** | Offline holds `cuda_lock` across the whole render with the engine stopped; the live engine thread runs `runSynthesisKernel` lock-free while Flask param writes hold a Python lock the C++ thread ignores (DATA_FLOWS Thread-Safety; OnlinePlaybackEngine.cu:54-146). Not exercised by the bare ON/OFF repro; a real hazard when editing while playing |
| H10 | Observability (D2) | "Doesn't decay" is a *measurement* artifact, not real | **REAL — explains the contradictory reviews** | The live path exposes only the 5 s `rawSoundBuffer` ring (continuously overwritten). Measured live: identical calls returned `n=205952` (energy all in the wrapped attack) then `n=0`. The `string_shape` GPU read returned a *frozen* value. Both prior 2026-05-29 reviews read this ring and reached **opposite** conclusions |
| H11 | Preset working-copy (dev-bfe2) | Working-copy slot has wrong `damper_string` live | **OUT** | DAMPER_PROBE: `damper_string[201..203]=3.6e-05` on the live working copy; offline reads the same active slot and damps fine; `bisect-live-75` shows no kernel/engine change in range |
| H12 | dev-cbd5 Pianoid.cu split | ODR/static duplication across the 8 new TUs | **OUT** | `bisect-live-75` + `gpu-damping-b7e3`: method bodies verbatim; both online and offline call the same TU; any breakage would be symmetric (offline damps fine) |

**Net:** H1–H4, H11, H12 are **OUT** — the engine and its event path are clean. **H6 is the proximate cause.** H7, H8, H9, H5 are **real online-only hazards** that the architecture permits (worth fixing, may compound perception). H10 is **why the bug was misdiagnosed twice.** H2/H8/the three-contexts split are the **architectural inconsistency** proper.

---

## 2. The proximate cause (H6) — frontend NOTE_OFF, in detail

`PianoidTunner/src/components/VirtualPiano.js`:

```js
const [mouseDownPitch, setMouseDownPitch] = useState(null);     // line 39 — added by the prior fix

const handleMouseDown = (event) => {
  const note = getNote(event);
  setMouseDownPitch(note);                                       // line 225 — press pitch IS captured
  if (note) {
    if (event.button === 0) { onSelectNote?.(note); }            // left = select (no sound)
    else {
      onPlayNote?.({ pitch: note, command: 144, velocity });     // line 230 — NOTE_ON on right/middle button
      setNotesPressedByMouse((prev) => [...prev, note]);
    }
  }
};

const handleMouseUp = (event) => {                               // also bound to onMouseLeave (line 271)
  if (!mouseDownPitch) return;
  const note = getNote(event);                                   // line 254 — pitch under cursor AT RELEASE
  if (event.button === 0) { ... setMouseDownPitch(null); }
  else {
    onPlayNote?.({ pitch: note, command: 128 });                 // line 259 — NOTE_OFF for RELEASE pitch ❌
    setNotesPressedByMouse((prev) => prev.filter((v) => v !== note));
  }
};
```

Three defects, all stranding the note (engine then *correctly* keeps ringing → "does not decay"):

1. **Wrong pitch on release (line 259).** NOTE_OFF uses `note` (release-cursor pitch), not `mouseDownPitch`. Drift off a narrow black key → the pressed pitch never gets NOTE_OFF. **The prior fix captured `mouseDownPitch` but did not use it here** — this is precisely why the user reports the fix failed.
2. **Mouse-leave while held (line 271).** `onMouseLeave={handleMouseUp}`: when the cursor leaves the canvas mid-press, `getNote` returns an edge pitch or `undefined`, and the synthetic leave event's `event.button` is typically `0`, so the `else` (NOTE_OFF) branch is skipped entirely → stuck note.
3. **Button-gate asymmetry.** NOTE_ON/OFF only fire on `event.button !== 0` (right/middle). Any path that delivers the up/leave with `button === 0` silently drops the OFF.

This is a frontend/transport bug, **fully consistent** with the engine measuring clean. It is *online-only* because (a) it lives in the UI, and (b) offline `note_playback` and REST `/play` both emit an explicit, correctly-paired NOTE_OFF and never touch this handler.

> **Why the trichotomy "shape" (p55 OK / p56 stuck / p57 click)?** p56 = G#3 is a **narrow black key** (~5 px) → highest drift probability → most often stranded ("doesn't decay"). p55 = G3 is a **wide white key** → cursor usually stays on it → OK. p57 = A3 is white but adjacent to the black key; a quick in/out gives a very short on→off pair → a click-like transient. The per-key *geometry* produces the three behaviors, on top of an engine that is doing exactly what it's told.

---

## 3. The output-value split (H8) — a real online-only divergence

`MainKernel.cu:492-493` writes two different things from the same sample:

```cpp
soundInt[sampleIndex]   = static_cast<Sint32>(output * main_volume_coefficient); // → audio driver (ONLINE only), UNCLAMPED
soundFloat[sampleIndex] = static_cast<float>(output);                            // → offline render + ALL observability, PRE-volume
```

- The **speaker** (online `pushCycleAudioToDriver`) hears `output × volume_coeff`, cast to `Sint32` with **no saturation**. If `output × coeff > INT32_MAX`, the cast is undefined behavior (wrap → loud click/crackle).
- **Offline `note_playback` and every Python/REST readout** (`getRecordedAudio`, `getCurrentCycleAudio`, the `sound` chart, calibration) read `soundFloat = output` — **pre-volume, never clipped.** (Confirmed by memory `project_soundint_no_python_api` and the §8 source read.)

So clipping that the speaker produces is **structurally invisible** to the offline render and to every measurement surface — a textbook online-vs-offline divergence. On the user's *current* backend (`max_volume=120`, `volume_level=64` → coeff ≈ 11.7) the products (250–1114) are far below INT32_MAX, so it is **not firing now**; but it is a latent, volume-dependent, per-pitch (louder pitch → closer to clip) click source unique to the live path. It must be a **clamped** cast in any unified output stage.

---

## 4. The architectural inconsistency, named precisely

The user is right that "one engine, same result" is a fiction. There are **three** synthesis execution contexts sharing only `runSynthesisKernel`:

| Context | Loop | Events from | State at note | Output sink | Locking |
|---------|------|-------------|---------------|-------------|---------|
| **Offline** (`note_playback`) | `OfflinePlaybackEngine::run` | pre-sorted `EventQueue` | **reset to zero** (`resetStringsState`+flush+`clearRecords`) before each render; engine **stopped** | `getRecordedAudio()` (clean per-render vector, `soundFloat`) | whole render under `cuda_lock` |
| **Online** (`/play`, WS, MIDI) | `OnlinePlaybackEngine::run` (C++ thread) | live `RealTimeEventBuffer` (+ `EventQueue`) drained by wall-clock `CycleTimeEstimator` | **never reset** — accumulates across the whole session | speaker via `soundInt` (volume-scaled, unclamped) **+** the 5 s racing ring (`soundFloat`) | engine thread **lock-free**; Flask writes hold a Python lock it ignores |
| **Semi-offline calibration** | manual `executeSingleMeasurementCycle` loop | direct `addStringToBatch` | reset between measurements | `synthesisCaptureBuffer_` (clean, `soundFloat`) | engine stopped; driven from Python |

Four structural divergences fall out of this table, each independently able to make online ≠ offline:

- **D1 — initial state:** offline/calibration reset; online accumulates. (Real; not the stuck-note cause — H2.)
- **D2 — observability:** offline/calibration return clean per-render buffers; **online has no deterministic output buffer** — only the racing ring. (This is why the bug was misdiagnosed twice — H10.) Note even the existing `startSynthesisCapture` primitive feeds **only** the calibration loop (`Pianoid_calibration.cu:49-58`), *not* the real `OnlinePlaybackEngine::run` loop — so there is currently **no way to observe path #2 deterministically** at all (this analysis had to stop the engine and freeze-read the ring).
- **D3 — locking:** offline serialized under `cuda_lock`; online engine thread races Flask param writes. (Real hazard — H9.)
- **D4 — output value:** offline reads `soundFloat`; the speaker gets unclamped `soundInt`. (Real, latent click — H8.)

None of these is the trichotomy's *proximate* cause, but together they are exactly the "severe architectural inconsistency" the user senses: **the thing you hear (online) and the thing you can measure (offline) are produced by different code, from different state, with different observability, different locking, and different output scaling.** That is why this bug burned multiple sessions.

---

## 5. Distinguishing the two framings (team-lead directive #4)

> Is this a **bug on one path**, or **two genuinely-different code paths never unified** (the user's framing)?

**Both — at different layers, and the distinction matters for the fix:**

- The **proximate symptom** ("notes render wrong, live only") is a **bug on one path** — specifically the *frontend* path (`handleMouseUp`, H6), with a couple of *backend/transport* hazards behind it (H7/H8). The synthesis engine itself is **not** a different-result path: online and offline produce identical samples from identical state (H1–H3, measured).
- The **user's architectural framing is nevertheless correct** — there *are* two-(three-)genuinely-different code paths that were never unified (§4). They do not currently produce the trichotomy, but they (a) made it un-measurable and twice-misdiagnosed, (b) carry latent online-only failure modes, and (c) mean "verify online == offline" is impossible today. Removing that split is the durable fix that prevents the *next* live-only ghost.

So the honest answer is: **fix the bug (Track 1), and remove the architectural split (Track 2) so the class of "live-only, can't-reproduce-offline, misdiagnosed" bugs becomes structurally impossible.**

---

## 6. Way ahead

### Track 1 — Fix the live-only bug now (unblocks the user). Effort: S.

Via `/dev` on PianoidTunner:
- In `handleMouseUp`, send NOTE_OFF for **`mouseDownPitch`** (the pressed pitch), not `note`. Clear `mouseDownPitch`/`notesPressedByMouse` for that pitch.
- Separate `onMouseLeave` from `onMouseUp` (or make the leave handler emit NOTE_OFF for the tracked held pitch regardless of `event.button`). Handle release outside the canvas (window-level `mouseup`/`pointerup`, or Pointer Capture).
- Prefer Pointer Events with `setPointerCapture` so the press→release pair is bound to one pointer and one pitch, immune to drift and canvas-exit.
- Add a Jest test simulating press-pitch-A → move-to-B → up, asserting NOTE_OFF is for A (no such test exists today).
- **Verify on the live UI** (`/pianoid-ui` or `/test-ui`), not just REST — the bug only manifests through the mouse handler.

This is the *correct, complete* version of the fix the prior session attempted.

### Track 2 — Make online/offline divergence structurally impossible. Staged.

The end state the user wants ("one engine, one path, cannot diverge"). Four options, ordered by blast radius; A is the prerequisite for trusting B–D.

**Option A — Deterministic online observability (effort S–M, mostly Python + one small C++ hook).**
Give the live engine a clean, wrap-free capture equal to offline's `getRecordedAudio()`. The capture *primitive exists* (`startSynthesisCapture`/`stopSynthesisCapture`/`getSynthesisCaptureBuffer`, pybind-bound) but currently feeds only the calibration loop — extend the append hook into `runCycle(Online)` (or expose the freeze-then-read pattern this analysis used) and add a REST endpoint. Removes D2; converts "is the live engine OK?" from an argument into a one-line assertion. **Without this, every future live diagnosis is blind — the single highest-leverage step.**

**Option B — One reset policy + clamped output (effort M, `/dev` + CUDA).**
(i) Make `resetStringsState()` actually zero *all* carried state (mode `q/q_prev`, excitation index, `sound_prev_diff`) so "reset" means the same thing everywhere and offline becomes bit-reproducible. (ii) Make the `soundInt` cast **saturating** (clamp to `[INT32_MIN, INT32_MAX]`) so the speaker can never emit UB — closes D4. (iii) Decide & document whether live play resets per note or accumulates (it should accumulate — real pianos superpose — so this is mainly a *test affordance* + the reset-semantics fix).

**Option C — One locking discipline for the live thread (effort M–L, `/dev`, touches the audio thread).**
Order every GPU-buffer write against the live engine's kernel launches: route parameter writes as events on the *same* per-cycle timeline as notes (so a param edit is dispatched between cycles, never mid-kernel), or give the engine a C++ lock it honors. Closes D3. The archived `PLAYBACK_ARCHITECTURE_REVIEW.md` §6 ("unified envelope scheduler") already points here.

**Option D — Collapse to one engine, two regimes (effort L, the real unification).**
Delete the separate `OnlinePlaybackEngine` / `OfflinePlaybackEngine` / calibration loops; keep one event-driven loop that runs either clocked-to-audio (online) or free-running (offline/calibration) via the existing `CycleRegime` switch. State reset, locking, capture, and output scaling all become regime parameters of **one** path — divergence becomes *structurally impossible* because there is only one code path. This is the faithful answer to the user's request; it subsumes A–C and should be planned once A/B/C have de-risked the pieces.

### Recommendation

1. **Track 1 immediately** — it is the actual blocker and is small.
2. **Track 2 Option A next** — stop debugging the live path blind; it is what let two sessions ship wrong conclusions (and one wrong fix).
3. **Then B (clamp + reset semantics)**, then **C**, converging on **D** as the strategic end state. Sequencing keeps each `.cu` change small, testable, and behind a now-trustworthy live measurement.

---

## 7. Verification plan & regression guards

1. **Track-1 proof:** live-UI test (`/pianoid-ui` or `/test-ui`) — press G#3 with deliberate drift and on mouse-leave; assert (via the new Option-A deterministic capture, or audio) the note decays after release. A Jest unit test pins the `handleMouseUp` → `mouseDownPitch` contract.
2. **Online==offline equality test (the anti-divergence guard):** once Option A lands, a system test (`audio_off`) asserts `online_capture(pitch)` ≈ `offline_render(pitch)` within the render noise floor for a fixed pitch set. This is the test that makes divergence *visible the moment it returns* — the artifact this whole class of bug needed.
3. **Clamp guard:** a unit/integration test that drives `output × coeff` past `INT32_MAX` and asserts the emitted `soundInt` saturates (no wrap).
4. **Race guard (after C):** hold a note, fire a concurrent parameter write / preset switch, assert the rendered tail is unchanged beyond threshold.
5. **No mic needed** for any of the above — all `audio_off` (offline buffer + deterministic live capture), per the strict-A1 contract in `docs/development/TESTING.md`.

---

## 8. Evidence index (read-only; nothing modified)

- **Measurements (scripts in `D:\tmp\`, run in a separate `audio_off`/own-process — user stack untouched):**
  - `arch-rigor-probe2.py` — E1 offline / E2 manual bare-kernel / E3 accumulate / E4 overlap. Result: all damp; accumulation self-limits; superposition damps. (H1, H2)
  - `arch-live-engine-probe.py` — real `OnlinePlaybackEngine` thread, freeze-then-read ring, ×4 runs. Result: live damps, reproducible, peaks == offline. (H3)
  - `arch-live-stringstate.py` / `arch-decay-probe.py` — demonstrated the live observability is unreliable (frozen `string_shape`; intermittent ring). (H10)
- **Source:** `VirtualPiano.js:39,225,230,252-262,271` (H6); `backendServer.py:296-404` WS dedup (H7); `MainKernel.cu:492-493` output split (H8); `OnlinePlaybackEngine.cu:54-146,219-278` lock-free loop + drain (H3,H9); `RealTimeEventBuffer.cu:24-38,74-115` drain/eviction (H4,H5); `Pianoid_calibration.cu:39-127` deterministic capture is calibration-only (D2); `chartFunctions.py:20-56,1073-1131` offline reset+lock+`getRecordedAudio` (D1,D2).
- **Docs:** `DATA_FLOWS.md` §1.2/§1.5/§3.4/Thread-Safety; `PLAYBACK_SYSTEM.md` (3 engines, `getEventsAtCycle` skip note, back-pressure); `TESTING.md` (strict-A1, reset noise floor); `SYSTEM_OVERVIEW.md` (volume formula, threading).
- **Prior investigation (re-evaluated, NOT ground truth):** `bug-55-56-57-trichotomy-state-2026-05-29.md` (engine-clean conclusion correct; its `handleMouseUp` remedy was the right *area* but the shipped fix is incomplete — see §2); `reviews/trichotomy-offline-vs-live-2026-05-29.md` ("live regressed" — a ring-wrap/observability artifact, H10); `logs/bisect-live-75`, `logs/gpu-damping-b7e3` (kernel unchanged; soundboard-mode ringout is correct physics).
- Uncommitted probes in `Pianoid_excitation.cu` / `Pianoid_synthesis.cu` accounted for; not reverted, not built.

## 9. Investigation history

This document supersedes the *conclusions* of `bug-55-56-57-trichotomy-state-2026-05-29.md` and the first revision of this proposal (which over-weighted state-accumulation D1 as the cause — refuted here by E3/E4). The data in the companion logs/reviews is retained and cross-referenced above. The first-pass version of this proposal is preserved in git history for this file.
