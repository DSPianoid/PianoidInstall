# Re-Validation — Preset System Revision Plan

**Date:** 2026-05-17
**Subject:** `docs/development/PRESET_SYSTEM_REVISION_PLAN.md`
**Mode:** Read-only investigation. No source edits, no implementation.
**Plan age:** Plan content has no date header. The only git commit touching the file
is `57c6724` (2026-04-09 — a docs sweep that picked it up). On-disk mtime is
2026-05-10, but with no corresponding commit, so the body dates to **on or
before 2026-04-09**. It predates the MIDI refactor W1-W5 (2026-05-08…2026-05-16)
and the modal-adapter measurement work (Phases 0-4, 2026-05-10).

---

## 1. Verdict

**NEEDS REVISION — premises have drifted; the plan is still broadly buildable
but several of its "Current Architecture" claims are now stale, and one core
design decision is now in direct conflict with deliberate code that shipped
after the plan was written.**

Not obsolete: the MIDI refactor did **not** overtake this plan. `feedback_midi`
does **not** conflict with the shipped MIDI architecture (they are different
"feedback" — see §4). The plan's goal (per-preset volume/feedback memory) is
still unmet and still coherent.

But it is not "still sound as written" either. The single largest issue:
**`switch_preset()` was rewritten after the plan to deliberately make
volume/feedback GLOBAL-persistent across switches** (`pianoid.py:2566-2582`).
The plan's premise #1 says volume/feedback are "lost" on switch — that was true
when the plan was written; today they are explicitly *preserved*. The plan wants
to change them to *per-preset*. That is a legitimate design choice, but it is
now a **reversal of an intentional, commented decision**, not a fix for a gap.
Whoever builds this must consciously decide to overturn the current
global-persist behaviour, and the plan does not acknowledge that the behaviour
changed under it.

---

## 2. Premise-by-Premise Check

Plan "Current Architecture" claims vs. current code (`pianoid.py`,
`backendServer.py`, `usePreset.js`, `useHotkeys.js`).

| # | Plan premise | Still holds? | Evidence |
|---|---|---|---|
| P0 | `_library_models[name]` entries are `{sm, modes, mp}`, no `runtime` dict | **YES** | `pianoid.py:2104-2106` (`"working"`), `:2117-2121` (reference copy), `:2521` (`load_preset_to_library`). All three sites build exactly `{'sm','modes','mp'}`. No `runtime` key anywhere. `get_preset_runtime_state` / `update_active_preset_runtime` / `feedback_midi` do not exist in the repo. The plan is genuinely unimplemented. |
| P1 | Volume/feedback are global and **lost** when switching A→B→A | **NO — drifted** | `switch_preset()` (`pianoid.py:2566-2582`) now snapshots `volume_level` and `deck_feedback_coefficient` from `getRuntimeParameters()` *before* the switch and re-applies them *after* via `RuntimeParameters(preserved_level)` + `defaults.deck_feedback_coefficient = preserved_feedback`. They are **deliberately preserved (global-persistent)**, not lost. The docstring states this is intentional ("The current volume_level is preserved so the user's loudness setting survives the switch"). The plan's symptom no longer reproduces; the plan now proposes to *replace* this global-persist with per-preset memory. |
| P1b | `volume_center`/`volume_range` are global, "arguably should stay global" | **PARTIALLY drifted** | `switch_preset()` resets `volume_range` to engine default and re-seeds `volume_center` to `max_volume**(64/127)` on every switch (`:2566-2582`). So sensitivity is **reset**, not merely "left global". The plan's runtime schema still lists `volume_center`/`volume_range` as per-preset fields — that contradicts both the current reset behaviour and the plan's own prose ("arguably should stay global"). Internally inconsistent and stale. |
| P2 | Available notes not refreshed after switch (stale keyboard) | **YES** | `usePreset.js` `switchPreset` (`:220-253`) re-fetches strings/modes/excitation/feedin/feedback/sound-channels but **never calls `getAvailableNotes()`**. `getAvailableNotes` exists and is called by `loadPreset` (`:153`) but not by `switchPreset`. Premise holds. |
| P3 | Frontend MIDI feedback slider position lost — lossy reverse mapping | **YES (with nuance)** | `_map_feedback_to_coefficient` (`backendServer.py:90-109`) maps MIDI→coeff via `8.0**((v-64)/63)`. The backend stores only the coefficient (`RuntimeParameters.deck_feedback_coefficient`). Reconstructing the MIDI value needs `63*log(coeff)/log(8)+64` — invertible in principle but float-lossy and not done anywhere. The frontend `feedback` state IS a raw 0-127 MIDI value (`usePreset.js:1477` `useState(64)`), so the *live* slider is fine; the gap is purely **restoring** that value after a switch from the backend response. Premise holds; storing `feedback_midi` is a reasonable fix. |
| P4 | No concurrency guard on `switchPreset()` — rapid `[`/`]` interleaves | **YES** | `useHotkeys.js` `cyclePreset` (`:92-105`) calls `r.switchPreset(...)` with no guard. `usePreset.js` `switchPreset` (`:220-253`) has no `switchingRef`/`isBusy`. (`loadPreset` does have a guard pattern — plan's "mirror `loadingRef`" reference is valid.) Premise holds. |
| P5 | Frontend state refresh after switch is incomplete | **MOSTLY drifted** | `switchPreset` (`:220-253`) already clears the SC cache (`setSoundChannelData(null)` + feedback matrix), calls `resetVolumeSensitivity()`, re-fetches strings/modes/excitation/feedin/feedback/SC, and bumps `presetVersion`. The Wave-B sound-channel-cache fix (WIP doc lines 971-975, 2026-04-20) landed *after* the plan. The **only** genuine remaining gaps are: (a) no `getAvailableNotes()`, (b) volume/feedback values not read from the response. Plan's "Frontend Switch Flow (Current)" diagram is stale — it shows fewer refetches than the code now does. |

### Backend-flow / line-number drift

The plan's "Key Files" table line numbers are **all stale** (the plan
predates ~2 months of edits):

| Plan reference | Plan lines | Actual lines (2026-05-17) |
|---|---|---|
| `switch_preset()` / `load_preset_to_library()` | 2136-2168 | `switch_preset` 2524-2585; `load_preset_to_library` 2453-2522 |
| `init_pianoid()` `_library_models` init | 1741-1758 | 2104-2121 |
| Volume/feedback get/set API | 533-654 | 667-811 |
| `/preset/switch` endpoint | 344-357 | 974-987 |
| `/set_runtime_parameters` endpoint | 543-740 | 1247+ ; shared helper `_apply_runtime_parameters` at `backendServer.py:181-246` |
| `usePreset.js` `switchPreset` | 173-191 | 220-253 |
| `usePreset.js` volume/feedback state | 1226-1316 | 1406-1524 |
| `useHotkeys.js` `[`/`]` cycling | 92-105 | 92-105 (unchanged) |

Functional drift beyond line numbers: `/set_runtime_parameters` logic now lives
in a **shared helper** `_apply_runtime_parameters(pianoid, data)`
(`backendServer.py:181-246`) used by *both* the REST route and the WS
`set_runtime_parameters` handler (Tranche A / M6). The plan's Step 5 ("at end of
handler, after `updated` dict is built, sync to library") must target this
shared helper, and the sync then fires for **both** REST and WebSocket callers
— the plan assumes a single REST handler and does not mention the WS path.

---

## 3. Did the MIDI refactor / modal-adapter work overtake this plan?

**No.** Checked against `docs/proposals/midi-implementation-plan.md` (W1-W5
wave plan) and `docs/modules/pianoid-middleware/MIDI_SYSTEM.md`.

The MIDI refactor Sequence A (Phases 0-4 / W1-W5) is entirely about MIDI
**ingress**: kernel per-cycle batch envelope (W1 Phase 1), listener-thread
pre-flight and `GET /midi/ports` (W1 Phase 0), `POST /midi/start|stop` runtime
control (W3 Phase 2), the `midi_note_event` broadcast on/off gate (W4 Phase 3),
and a regression suite (W5 Phase 4). None of those waves touch:

- `_library_models` or the preset library,
- `RuntimeParameters` (volume / `deck_feedback_coefficient`),
- `switch_preset()` / `load_preset_to_library()`,
- `/preset/switch` or `/set_runtime_parameters`.

The MIDI plan's file-scope conflict matrix (`midi-implementation-plan.md` §3.1)
confirms it: the only `pianoid.py` edits are the `emit_midi_callback` constructor
param, `start_midi_listener_unified`, `stop_midi_listener`, and the broadcast
flag — all in the MIDI-listener region, far from the preset region. No overlap.

The modal-adapter measurement work (Phase 0 RR-port etc.) is on the
`modal_adapter_server` (port 5001) and the `modal_adapter/` package — no contact
with `pianoid.py`'s preset library at all.

**Conclusion:** the preset-revision plan and the MIDI refactor are disjoint. The
MIDI work neither satisfies, redundifies, nor obstructs any part of this plan.

---

## 4. Is `feedback_midi` still needed? Does it conflict with the MIDI architecture?

**Still needed: marginally yes. Conflict with MIDI architecture: no — they are
two different "feedback" concepts ("same name, different thing").**

There are two unrelated "feedback MIDI" things in the codebase:

1. **`deck_feedback` CC handler** (`MIDI_SYSTEM.md` "MIDI Action Methods" —
   `deck_feedback`, CC 74): a *hardware MIDI controller* turning a physical knob
   maps CC value → `set_deck_feedback_coefficient` via `8.0**((v-64)/63)`. This
   is the legacy `MidiListener` YAML-keyboard path. It is **not** wired into the
   unified ingress path (`MIDI_SYSTEM.md` notes per-note CC handlers "have not
   yet been migrated to the unified path").

2. **The plan's `feedback_midi`**: the *frontend feedback slider* position
   (0-127), stored per-preset so the slider can be restored to the right spot
   after a preset switch. This has nothing to do with hardware MIDI — it is a
   UI-state-restoration field. The name "midi" is used only because the slider's
   0-127 domain mirrors MIDI velocity range and reuses `_map_feedback_to_coefficient`.

These never collide: #1 is an *input* path (hardware → coefficient), #2 is a
*persisted display value*. Both feed the **same** `_map_feedback_to_coefficient`
function and the **same** `deck_feedback_coefficient` runtime scalar, so they are
consistent, not conflicting.

**Is `feedback_midi` strictly necessary?** It is a *convenience*, not a
correctness requirement. The coefficient→MIDI inverse is computable
(`63*log(coeff)/log(8)+64`). Storing the raw MIDI value avoids float round-trip
drift (e.g. MIDI 80 → coeff 2.8298… → back to 79.97 → rounds to 80, usually
fine, but exact at the 0/0.125 boundary cases is fragile). Given the plan
already adds a `runtime` dict, one extra int field is near-zero cost. **Keep
`feedback_midi` in the design** — but note it is the *only* field that is not
directly read back from a C++ getter, so it relies on `/set_runtime_parameters`
faithfully recording every feedback write into the library (plan Step 5). If
that sync is missed on any path, `feedback_midi` silently desyncs from the
actual coefficient. That is the plan's most fragile seam.

One caveat the plan must add: if the unified MIDI ingress path ever gains a
`deck_feedback` CC handler (a future migration item per `MIDI_SYSTEM.md`), a
hardware knob turn would change `deck_feedback_coefficient` **without** going
through `/set_runtime_parameters`, so `feedback_midi` would not be updated. The
plan should either (a) note this as out of scope, or (b) route any future CC
feedback handler through the same `update_active_preset_runtime` helper.

---

## 5. Preset-switch silence in Strings mode — relation to this plan

The historical "preset library switch silence in Strings mode"
(`listen_to_modes=0`) bug is **separate from this plan and largely resolved**.

- The plan's own WIP section (`WORK_IN_PROGRESS.md:971`) records: **"Sound-channel
  cache silence on preset switch — resolved (2026-04-20, Wave B)."** That fix
  (clearing `soundChannelData`/`soundChannelFeedbackMatrix` to `null` at the top
  of `loadPreset`/`switchPreset`) is present in the current code
  (`usePreset.js:228-229`).
- The deeper CUDA-side investigation (project memory
  `project_preset_switch_silence.md`) concerned the GPU double-buffer swap /
  `stringMapKernel` re-run — a kernel-level routing issue, **not** a
  runtime-state issue. That is in the CUDA layer and is orthogonal to adding a
  Python `runtime` dict. The preset-revision plan neither causes nor fixes it.

**Implication:** the preset-revision plan does not need to address the silence
bug, and the silence bug does not block the plan. But anyone implementing this
plan should be aware that preset switching has a *separate* known CUDA-layer
fragility — and should run the Strings-mode switch as part of verification
(plan checklist item 5/6 already exercises switching, but the checklist does not
explicitly say "test with `listen_to_modes=0`"; recommend adding that).

---

## 6. Effort / Risk / Build

**Build: `--light` only (Python middleware) + `npm` for the frontend. No CUDA
build. Confirmed.**

- `pianoid.py` changes (runtime dict, `switch_preset` save/restore, two helper
  methods) are pure Python on the `Pianoid` orchestrator — no `.cu/.cuh/.h/.cpp`,
  no `setup.py`. `--light` rebuilds nothing native; a backend restart suffices.
  (Per CLAUDE.md, even `--light` is only needed if a native-binding interface
  changed — here nothing does, so strictly just a backend process restart.)
- `backendServer.py` changes (`/preset/switch` response, `_apply_runtime_parameters`
  sync) — pure Python, no build.
- `usePreset.js` changes — frontend, `npm` dev server picks them up.

**Effort estimate (S–M, ~1 day for a focused `/dev` session):**

| Step | Scope | Effort |
|---|---|---|
| 1-3 | `runtime` dict on 3 `_library_models` sites + `switch_preset` save/restore + 2 helper methods | S (2-3 h) — but must consciously overturn the current global-persist logic at `pianoid.py:2566-2582`; that is a *replacement*, not an addition |
| 4 | `/preset/switch` response enrichment | XS (<1 h) |
| 5 | `_apply_runtime_parameters` → library sync (REST **and** WS, shared helper) | S (1-2 h) — fragile seam, needs care |
| 6 | `usePreset.js` `switchPreset` rewrite + `switchingRef` guard + `getAvailableNotes()` | S (2 h) |
| — | Verification (load 2 presets, A/B/A volume+feedback round-trip, rapid `[`/`]`, Strings-mode switch) | S (1-2 h) |

**Risk: LOW-MEDIUM.**

- Low mechanically — small, well-isolated Python + JS changes.
- Medium by *decision risk*: the plan silently assumes premise #1 ("volume lost
  on switch") still holds. It does not. The implementer must explicitly decide
  to flip volume/feedback from **global-persistent** (current, intentional,
  commented) to **per-preset**. This is a UX behaviour change that a user may or
  may not still want — it should be re-confirmed before building. If the user
  actually likes the current "my loudness follows me across presets" behaviour,
  most of the plan evaporates and only P2 (`getAvailableNotes`) + P4
  (concurrency guard) remain as genuine ~1-hour fixes.
- The `feedback_midi` field depends on *every* feedback write reaching the
  library sync (Step 5). A missed path = silent slider desync. Medium-fragile.
- `volume_center`/`volume_range` in the runtime schema contradict the current
  reset-on-switch behaviour and the plan's own prose. The schema must be
  reconciled before implementation (drop them from per-preset state, or
  consciously decide to make sensitivity per-preset too).

---

## 7. Recommended Disposition

**Do not build as-is. Revise first, then decide.** Concretely:

1. **Re-confirm the UX intent with the user.** The plan's foundational premise
   (volume/feedback lost on switch) is stale — the code now deliberately keeps
   them global. Ask: do you want volume/feedback to be **per-preset** (the
   plan's goal) or stay **global-persistent** (current behaviour)? Everything
   downstream depends on this answer.
2. **If per-preset is still wanted:** update the plan to (a) acknowledge it is
   *overturning* the `pianoid.py:2566-2582` global-persist logic, not filling a
   gap; (b) fix all stale line numbers; (c) retarget Step 5 at the shared
   `_apply_runtime_parameters` helper and note it covers REST + WS; (d) resolve
   the `volume_center`/`volume_range` schema contradiction; (e) trim premise #5
   (most of the frontend refresh already landed — only `getAvailableNotes` +
   response-value consumption remain); (f) add an explicit "test with
   `listen_to_modes=0`" verification item.
3. **If global-persist is fine:** park the bulk of the plan. Extract only the
   two still-valid quick wins as a tiny `/dev` task — `getAvailableNotes()` in
   `switchPreset` (P2) and a `switchingRef` concurrency guard (P4) — roughly
   1-2 h total.
4. **Filing:** per the one-doc-per-topic rule, when a revised plan is produced
   it belongs in `docs/proposals/`; the current `PRESET_SYSTEM_REVISION_PLAN.md`
   should then be archived to `docs/proposals/archive/`. (This re-validation
   stays here under `docs/development/reviews/`.)

---

## 8. Summary Table

| Question | Answer |
|---|---|
| Plan implemented? | No — `_library_models` is still `{sm,modes,mp}`; no `runtime`, no `get_preset_runtime_state`, no `feedback_midi`. |
| Verdict | **NEEDS REVISION** — premises drifted; one core premise (P1) reversed by intentional post-plan code. |
| MIDI refactor overtook it? | No. Disjoint subsystems. No conflict, no redundancy. |
| `feedback_midi` still needed? | Marginally — a convenience to avoid float-inverse drift. No conflict with the MIDI `deck_feedback` CC handler (different concept). |
| Strings-mode switch-silence bug related? | No — separate CUDA-layer issue; the SC-cache part is already fixed (Wave B). |
| Build type | `--light` / backend restart + `npm`. No CUDA. Confirmed. |
| Effort | S-M, ~1 day full plan; ~1-2 h if reduced to P2+P4 only. |
| Risk | Low mechanically; medium decision risk (silently reverses an intentional behaviour). |
| Biggest issue | Premise #1 is stale: volume/feedback are now *deliberately global-persistent* (`pianoid.py:2566-2582`). The plan must consciously decide to overturn that, not treat it as a gap. |
