# Bug 55/56/57 trichotomy — investigation state (2026-05-29)

> ## USER CORRECTION (2026-05-29, authoritative)
>
> **The 55/56/57 trichotomy bug is REAL and MAY RECUR.** It is **NOT** a measurement
> artifact and **NOT** connected to the diagnostic probes added during this
> investigation — it **predates them** (the user heard it in normal usage before any
> probe existed).
>
> The earlier **"phantom / Heisenbug-from-probes / no-regression"** conclusion reached
> in this session is **SUPERSEDED**. "Not reproduced on a clean build in limited tests"
> ≠ "does not exist." The bug is **intermittent / state-dependent**, which is exactly
> why a small number of clean-build attempts failed to trigger it.
>
> A **deep static code review of the playback path is underway** to find it. The
> measured findings below (Sint32 overflow refuted; offline / in-process paths clean;
> the soundInt-readback hook bug) remain valid as *measurements*, but any sentence in
> this document that concludes the bug **"does not exist" / "is only a ring-wrap
> artifact" / "is only handleMouseUp"** is overruled by this correction.
>
> This note is authoritative and takes precedence over the original "Status" line and
> §2 root-cause framing immediately below.

---

Status: ~~**Root cause identified; fix not yet applied.** Engine path verified clean.
Investigation closed after ruling out all engine-side hypotheses; the failure lives in the
PianoidTunner frontend `VirtualPiano.js` mouse-up handler.~~ **SUPERSEDED — see USER
CORRECTION above.** The bug is REAL, intermittent/state-dependent, and still unlocated; a
deep static review of the playback path is underway. Diagnostic probes + the soundInt
readback hook are preserved (stashed on PianoidCore `feature/soundint-readback`,
`stash@{0}` = `26799bf`) — NOT discarded — but they are NOT merged to `dev` (the hook has a
known readback bug; the probes are stale).

---

## 1. Observed bug (user-visible)

**Preset:** `presets/Belarus_8band_196modes-MFeq.json` (PianoidCore middleware presets).
**Backend:** any version on or after the `dev-cbd5` Pianoid.cu split + `dev-midi-play /play` un-gate landed on dev (currently HEAD `67148fa`).
**Interface:** live frontend at `http://localhost:3000`, Virtual Piano panel.

When the user clicks the keys for pitches 55, 56, 57 (G3 / G#3 / A3) on the Virtual Piano,
they hear three *distinct* failure modes:

| Pitch | Key class            | User-reported symptom                              |
|------:|----------------------|----------------------------------------------------|
| 55    | G3, **white** wide   | OK — note rings then damps when released           |
| 56    | G#3, **black narrow**| **Does not decay** — note continues after release  |
| 57    | A3, white, next to black | **Click** — short transient with no sustain       |

The combination — three discrete behaviours at three adjacent semitones with smoothly
continuous physical parameters — is the "trichotomy". It is NOT reproducible from any of:
- REST `POST /play` issued from a script (any listener config)
- REST `POST /play_keyboard` sweep
- `chart@note_playback` offline render

It IS reproducible from:
- Direct frontend Virtual Piano clicks
- Specifically, when the mouse drifts off the depressed key before the user releases the
  mouse button (most common on narrow black keys; sometimes on edges of white keys).

This binary "UI-only vs REST-fine" is the dominant diagnostic clue.

---

## 2. Root cause

`PianoidTunner/src/components/VirtualPiano/VirtualPiano.js` `handleMouseUp` (or
equivalent pointer-up / touch-end) sends NOTE_OFF for the pitch under the cursor at
release time, **not** for the pitch that was depressed at mouse-down.

Sequence on a black key with even modest cursor drift:

1. User mouses down on G#3 (pitch 56) → component emits `NOTE_ON pitch=56`.
2. While holding, cursor naturally drifts a few pixels — G#3 is only ~5 px wide at
   typical zoom — and ends up over a neighbouring white key (G3=55 or A3=57).
3. User releases the mouse button.
4. `handleMouseUp` reads the pitch under the cursor (55 or 57), emits `NOTE_OFF` for
   THAT pitch. Pitch 56 was never sent NOTE_OFF.
5. The Pianoid engine's per-string `dec_open[201..203]` stays at `DUMP_OPEN=0` because
   the off event for those strings was never dispatched. The strings continue to ring
   exactly as the FDTD physics says they should — that is the "doesn't decay" symptom.
6. Pitch 55 or 57 receives a NOTE_OFF for which no NOTE_ON existed (or a fast-paired
   one if the cursor was over them only briefly). The handler short-circuits or
   triggers a short click envelope, producing the "click" symptom on 57.
7. P55 frequently sounds OK because when the user clicks G3 directly (a wide white
   key) the cursor stays on it through release.

The "engine-side defects" listed in memory `project_55_56_57_repro`
(attack over-gain → Sint32 overflow; sequence accumulation; near-silent dropout for
some pitches) are real but **not the cause of the trichotomy**. They are independent
defects that may compound user perception once a note has been stranded by the
frontend bug.

Per memory:

> ROOT CAUSE of live "doesn't decay": VirtualPiano.js handleMouseUp sends note-OFF
> for the RELEASE-position pitch not the pressed pitch (mouseDownPitch) → mouse
> drift on ~5px keys strands the note; notes go over Socket.IO; REST /play bypasses it.

---

## 3. Reproduction — UI (manifests the bug)

Requires the canonical three-process stack per `docs/guides/UI_TESTING.md`:

1. From an empty workspace at the repo root, start the launcher:
   - Windows: `start-pianoid.bat`
   - Linux:   `start-pianoid.sh`
2. Wait for the launcher to bind port 3001 and spawn frontend (3000) and backend (5000).
3. Open `http://localhost:3000` in Chrome (the bug is not browser-specific but the
   `/pianoid-ui` skill and chrome-devtools MCP target Chrome).
4. In the APPLY dialog, ensure `Belarus_8band_196modes-MFeq.json` is selected and
   `debug_mode=1` is checked (matches the canonical user configuration). Click APPLY.
5. Open the Virtual Piano panel.
6. Click **directly on G#3 (pitch 56)** — the narrow black key — using a deliberate
   slow press. Do NOT try to click cleanly: the bug only surfaces with realistic
   user mouse drift.
7. Release the mouse over a neighbouring key.
8. The G#3 note will continue to ring after release. Verify by recording the live
   audio output (any of: mic capture, virtual loopback, `/capture` via `chart@sound`)
   and observing that post-release RMS does not decay.
9. Repeat for pitches 55 and 57 to observe the OK / click variants. Note that
   results depend on cursor drift direction and timing, so the trichotomy will
   reproduce reliably only over multiple clicks per pitch.

### What does NOT reproduce the bug

- Programmatic `POST /play {"pitch":56,"command":144,"velocity":100}` followed by
  `POST /play {"pitch":56,"command":128,"velocity":0}` from any script — the
  on/off pair is explicit and atomic.
- `chart@note_playback` deterministic offline render.
- `POST /play_keyboard` full-sweep.
- Hardware MIDI input (the listener pairs on/off on the wire).

---

## 4. Hypotheses tested and refuted

All five candidate engine-side causes were measured against the live engine and
refuted. Bisect log at `docs/development/logs/bisect-live-75-2026-05-29.md`,
companion investigation at `docs/development/logs/gpu-damping-b7e3-2026-05-28-234617.md`,
companion measurement review at
`docs/development/reviews/trichotomy-offline-vs-live-2026-05-29.md`.

| # | Hypothesis | How tested | Result |
|--:|-----------|------------|--------|
| H_A | `damper_string` wiped or zeroed for strings 201-203 during live preset load | DAMPER_PROBE inserted at `Pianoid_synthesis.cu:204-210` reads device-side `dev_physical_parameters[s*16+13]` immediately before `parameterKernel` launch | **Refuted.** `damper_string[201..203] = 3.6e-05`, identical to preset stored value. |
| H_B | Audio measured 100 ms post-noteoff is soundboard mode ringout, not source string — i.e. correct physics | Quantitative RMS measurement at 100/500/1500/1700 ms post-noteoff on `chart@note_playback` offline render | **Refuted.** Offline damps to ~0.0001 RMS by 500 ms. |
| S1 | `dev-bfe2` preset working-copy model creates a race: audio thread reads `dev_dec_open` / `dev_physical_parameters` outside `cuda_lock` while middleware writes inside it, producing torn writes only in live | S2 verify script (next row) ran with `listen_to_midi=0` AND `=1` after `reset_records` (POST `/capture` to clear ring) and measured `decay_ratio` in both configs | **Refuted.** decay_ratio ≈ 0.0001 in both configs, engine damps cleanly. |
| S2 | `dev-midi-p2/p3/play` MIDI listener now runs concurrent with audio thread (removed legacy listener-gate from `/play`); listener generates phantom events that re-trigger NOTE_ON during a hold, masking damping | Same S2 verify script — `D:\tmp\s2-listener-verify.py` (Phase A `listen=0`, Phase B `listen=1`, both with `/capture` reset between every measurement window) | **Refuted.** Listener state has no measurable effect on damping ratio. |
| S3 | `dev-cbd5` Pianoid.cu split introduces some non-templated symbol duplication or static-instantiation bug | Source diff against baseline (`fdf3dd2`); method bodies confirmed verbatim across `Pianoid.cu` → `Pianoid_synthesis.cu`, `Pianoid_excitation.cu`, `Pianoid_parameters.cu`, `Pianoid_debug.cu`, `Pianoid_calibration.cu`, `Pianoid_presets.cu`, `Pianoid_internal.cuh` per `gpu-damping-b7e3` log | **Refuted.** Symmetric across live and offline; offline damps fine. |

~~Eliminating all engine paths AND noting REST `/play` damps cleanly forces the
conclusion that the divergence is in the only remaining unique-to-UI input
mechanism — the frontend Virtual Piano click handler.~~ **SUPERSEDED (see USER
CORRECTION at top).** This inference does not hold: the bug is cross-method (the user
hears it via mouse, MIDI, and spacebar), so it cannot be a mouse-only handler defect.
The refutations in the table above are valid *as measurements of the surfaces tested*,
but they do NOT establish that the bug "does not exist" — it is intermittent /
state-dependent and was simply not triggered on the clean builds probed here. The real
locus is still unlocated; a static review of the playback path is underway.

### Measurement of decisive S2 verify (cleanest data)

Source: `D:\tmp\s2-listener-verify.py` ran against current-dev backend at `67148fa`,
SDL3 driver, debug mode, fresh `/capture` between every window.

| Pitch | Config   | on_rms | tail_rms | decay_ratio | Verdict |
|------:|----------|-------:|---------:|------------:|---------|
| 55    | listen=0 | 4.2879 |   0.0004 |     0.0001  | DAMPS   |
| 56    | listen=0 |19.8169 |   0.0016 |     0.0001  | DAMPS   |
| 57    | listen=0 | 3.6347 |   0.0002 |     0.0001  | DAMPS   |
| 55    | listen=1 | 4.1472 |   0.0002 |     0.0000  | DAMPS   |
| 56    | listen=1 |19.3103 |   0.0013 |     0.0001  | DAMPS   |
| 57    | listen=1 | 3.5117 |   0.0001 |     0.0000  | DAMPS   |

The earlier 2026-05-28 captures (`D:\tmp\currentdev-2026-05-28-p{55,56,57}.wav`)
that suggested "live damping broken" were affected by a ring-wrap artifact in
the `chart@sound` slicing — the `/capture` reset pattern was missing, so the
returned ring contained wrapped attack samples from prior cycles. Lesson
captured in user memory `feedback-ring-buffer-wrap-artifact`.

**Caveat (USER CORRECTION):** the ring-wrap artifact explains why *those specific
captures* were noisy — it does NOT explain away the bug itself. Per the user, the
trichotomy is real and was heard in normal usage independent of any probe or capture
script. Do not read "this capture was a wrap artifact" as "the bug is a wrap artifact."

---

## 5. Diagnostic probes still in source (not committed)

These were added during the investigation and remain in the working tree on the
current branch. They must be reverted before the next merge to master.

- `PianoidCore/pianoid_cuda/Pianoid_excitation.cu` line 36 — `NOTE_OFF_PROBE`:
  ```cpp
  if (velocity == 0) std::cout << "[NOTE_OFF_PROBE] stringNo=" << stringNo
      << " velocity=" << velocity << " dec_open=" << dec_open[stringNo] << std::endl;
  ```
- `PianoidCore/pianoid_cuda/Pianoid_synthesis.cu` lines 203-210 — `UPLOAD_PROBE` +
  `DAMPER_PROBE`:
  ```cpp
  std::cout << "[UPLOAD_PROBE] new_notes_ind=" << new_notes_ind
      << " dec_open[201]=" << dec_open[201]
      << " dec_open[202]=" << dec_open[202]
      << " dec_open[203]=" << dec_open[203] << std::endl;
  // DAMPER_PROBE: read damper_string[s] from device-side dev_physical_parameters
  real host_damper[3];
  real* dev_pp_real = getRealPointer("dev_physical_parameters");
  cudaMemcpy(host_damper+0, dev_pp_real + 201*PHYSICAL_PARAMETERS_NUMBER + 13,
             sizeof(real), cudaMemcpyDeviceToHost);
  cudaMemcpy(host_damper+1, dev_pp_real + 202*PHYSICAL_PARAMETERS_NUMBER + 13,
             sizeof(real), cudaMemcpyDeviceToHost);
  cudaMemcpy(host_damper+2, dev_pp_real + 203*PHYSICAL_PARAMETERS_NUMBER + 13,
             sizeof(real), cudaMemcpyDeviceToHost);
  std::cout << "[DAMPER_PROBE] damper_string[201..203]="
      << host_damper[0] << "/" << host_damper[1] << "/" << host_damper[2]
      << std::endl;
  ```

Revert is straightforward — both files have a clean `git diff` against `67148fa`
showing only these probe lines. A simple `git checkout HEAD -- <file>` works.

---

## 6. Current stack state at end of investigation

- **Backend:** `python.exe` PID 80416 listening on `127.0.0.1:5000`, SDL3 driver, debug
  build of `pianoidCuda_debug.cp312-win_amd64.pyd` loaded, Belarus MFeq preset
  active with `listen_to_midi=0`. Stays alive for follow-up.
- **Frontend:** prior session's frontend tab(s) likely still open; new launcher
  not running (`running=false`).
- **Launcher (port 3001):** down.
- **Branches:**
  - `PianoidInstall` master at `5020e17`
  - `PianoidCore` dev at `67148fa` (probes uncommitted in working tree)
  - `PianoidTunner` dev at `a9624c8`
  - `PianoidBasic` dev at `af92ecb`
- **Tags pushed to origin** earlier this session: `release/baseline-2026-05-10`
  across PianoidCore + PianoidTunner + PianoidBasic.
- **WAVs saved at `D:\tmp\`:** offline+live+baseline reference at 05-05, 05-10,
  current-dev (2026-05-28). Plus `offline-current-dev-p{55,56,57}.wav` rendered
  by `D:\tmp\trichotomy-offline-measure.py`.
- **Scripts at `D:\tmp\`:** `trichotomy-offline-measure.py`,
  `compare-wavs.py`, `s2-listener-verify.py`.

---

## 7. Pending action items (awaiting user authorization)

1. **Revert engine probes** — via `/dev`, since `.cu` edits + rebuild require the
   `/dev` workflow per `CLAUDE.md`. Rebuild `--heavy --both` to keep both release
   and debug variants consistent.
2. **Fix `PianoidTunner/src/components/VirtualPiano/VirtualPiano.js`** — track
   `mouseDownPitch` on `onMouseDown` / `onPointerDown` / `onTouchStart`; send the
   stored value on the corresponding `Up`/`End` events. Add a unit test that
   simulates pointer-drift across a `note-onmousedown=56, note-onmousemove=55,
   note-onmouseup` sequence and asserts NOTE_OFF is for pitch 56. Frontend lives
   in PianoidTunner so the `/dev` workflow applies.
3. **Optional follow-up investigation** of the P56 attack over-gain observed in
   `s2-listener-verify.py` results (P56 during-on `rms=19.8` vs P55 `rms=4.3`,
   peak 92.7 → almost certainly Sint32 overflow at the post-volume stage per
   memory `project-soundint-no-python-api`).
4. **Clean handoff** — kill backend PID 80416, revert probes, verify port 5000
   free, verify clean git status across all 4 repos per the Verified Clean
   Handoff rules in `orchestrator.md`.

---

## 7b. P1-1 GPU-pointer authority race — CONFIRMED + FIXED (dev-427c, 2026-05-29)

A system structural review flagged a CRITICAL authority race (P1-1) as the most plausible root cause
of the REAL, intermittent, live-only, per-pitch trichotomy. dev-427c investigated, **confirmed it in
code AND measured it on the live engine**, and implemented a single-owner fix.

**The race (confirmed in code + measured):** the swappable preset sub-pointers
(`Pianoid::dev_physical_parameters`, `dev_hammer`, `dev_gauss_params_full`, `dev_mode_state`,
`dev_deck_parameters`) were written by the `UnifiedGpuMemoryManager` **poll thread** inside
`swapBuffers()` (`*ptr_ref = working+offset` under `update_mutex_`) on every async parameter update /
preset swap, WHILE the **engine thread** read those same members lock-free at kernel-launch marshaling
(`runSynthesisKernel`: `dev_physical_parameters`/`dev_hammer`/`dev_gauss_params_full` direct;
`dev_mode_state`/`dev_deck_parameters`/`dev_hammer` via `&member` in `kernelArgs`). The engine never
took `update_mutex_`. A compile-guarded probe (`-DPIANOID_RACE_PROBE`) measured **1842 mid-cycle
pointer mutations** during a single sustained note under a ~780-swap/note storm on Belarus MFeq /
STRINGS — i.e. the engine demonstrably read pointers the poll thread moved out from under it,
constantly, under live update load.

**Why it stayed invisible on every prior surrogate:** on x86-64 a naturally-aligned pointer store is
atomic at the hardware level, so a mid-cycle stale read usually lands on a *previous-but-valid* pointer
(1.3 ms-stale params for one cycle) → benign in the common case. No NaN/Inf/torn-readback surfaced on
the Python surrogate even under the storm. So the **race is real and fires constantly**, but its
*audible* consequence is below the surrogate's noise floor — which is exactly the
intermittent/state-dependent/timing-dependent profile the user reports (different alignment, compiler
codegen, the multi-pointer mixed-base window vs `syncBuffers`' concurrent D2D overwrite can corrupt).
**Honest caveat:** the empirical "race → exact 55/56/57 trichotomy" link is NOT proven on the surrogate
(the symptom was not cleanly isolated); the race ITSELF is no longer in doubt (measured 1842×).

**The fix (single-owner, P1):** move the host-side pointer refresh OFF the poll thread ONTO the engine
thread. `swapBuffers()` now publishes the new working base (release atomic) + raises `swap_pending_`;
the engine consumes it (acquire) and refreshes the five members at the top of `runSynthesisKernel`
(`refreshSwappablePointersIfPending`), before any kernel-arg read. The engine is the sole writer.
After the fix the SAME probe measured **0 mid-cycle pointer mutations** under the SAME storm
(reproduced 2×). No perf regression (5/5 perf tests), no audio regression (control 55/56/57 clean +
damping; 11/11 preset-switch + feedback-coupling functional tests). Files: `UnifiedGpuMemoryManager.{h,cu}`,
`Pianoid.cuh`, `Pianoid_synthesis.cu`, `Pianoid_presets.cu` (on `feature/p1-authority-fix`, NOT merged —
awaits user live re-test). Full detail: dev-427c session log + `docs/development/diagnostics/dev-427c-p1-authority-race-stress.py`.

**Status:** the structural race is closed. Whether it FULLY explains the user-heard trichotomy can only
be confirmed by the user's live re-test on the fixed build (the surrogate cannot reproduce the audible
symptom). If the trichotomy persists after this fix, the next suspect is the post-volume Sint32 path /
mode-sum normalization (memory `project_trichotomy_sint32_overflow`) — a SEPARATE, parked finding.

## 8. References

- Memory `project_55_56_57_repro` — earlier session's identification of the same
  root cause.
- Memory `feedback_ring_buffer_wrap_artifact` — 2026-05-29 lesson on `/capture`
  reset for live `chart@sound` measurement.
- Memory `project_soundint_no_python_api` — context for the P56 over-gain
  follow-up.
- `docs/development/reviews/trichotomy-offline-vs-live-2026-05-29.md` — earlier
  ring-wrap-contaminated measurement (kept for the methodology, numbers noisy).
- `docs/development/logs/gpu-damping-b7e3-2026-05-28-234617.md` — kernel-side
  source investigation (parameterKernel + MainKernel data path).
- `docs/development/logs/bisect-live-75-2026-05-29.md` — commit-range bisect that
  eliminated the CUDA range.
- `docs/development/logs/damper-probe-ea77-2026-05-29-210147.md` — probe insertion
  and live damper_string readback.
- `docs/development/diagnostics/dev-cflfix-live-ab-repro.py` — canonical
  `reset_records()` + `capture_sound()` pattern.
