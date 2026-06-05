# Preset Working-Copy Model — Edit Isolation, Read-Only Originals, Global Runtime State

**Date:** 2026-05-17 (revised 2026-05-18 with user decisions)
**Author:** dev-bfe2 (`/dev` PLAN-FIRST)
**Status:** IMPLEMENTED + MERGED — `PresetLibrary` registry + working-copy model in `PianoidCore/pianoid_middleware/pianoid.py` (`d3958d8` registry class, `ca014f3` edit-isolation/read-only-originals/spawn-promote, `1d30856` REST + 409 mapping, `c2d7c21` engine-correctness + `PresetReadOnlyError` + system tests), merged to `dev` via `7d547c3`. Archived 2026-06-05. (Header below "awaiting approval" was stale — the model shipped.)
**Build type:** `--light` (Python middleware) + `npm` (frontend). No CUDA `.cu/.cuh/.h` edit. Backend restart suffices.

> **Revision note (2026-05-18).** The user answered all open questions (Q1-Q7, Q9)
> and merged the Case 9 runtime-state question into this task. This document is
> the single source of truth. The original (2026-05-17) draft recommended
> excluding promote and deferring the `pianoid.py` carve-out; both recommendations
> were overridden — see §6 for the resolved decisions. `PRESET_SYSTEM_REVISION_PLAN.md`
> is reconciled by this task (§3) and will be archived at Step 8.

---

## 1. The user's request

> 1. **BUG** — I open a preset and tune some parameters. When I switch from the
>    working library copy back to the original library copy, I expect the
>    original values AND the original sound restored. That does not happen.
> 2. **FEATURE** — Block editing of any copy EXCEPT working copies. Original
>    library presets are read-only.
> 3. **FEATURE** — A function to spawn a new editable working copy from the
>    current library preset.
> 4. **FEATURE** — A library may contain SEVERAL editable working copies;
>    they must be labelled accordingly.

Plus, merged in by user decision (originally tracked as "Case 9"):

> 5. **RUNTIME STATE** — Volume and feedback are GLOBAL across the entire
>    library: a single volume + feedback pair shared by all originals and all
>    working copies. Switching / spawning / promoting never changes them.

---

## 2. Confirmed bug root cause (measured against source, not assumed)

The bug has **two independent leak paths**, one per layer. Both must be fixed.

### 2.1 C++ GPU layer — `saveActiveToLibrary()` is unconditional

`pianoid.switch_preset()` (`pianoid.py:2538-2541`) always runs:

```python
with self.cuda_lock:
    self.pianoid.saveActiveToLibrary()          # D2D: working buffer → ACTIVE preset's library slot
    success = self.pianoid.switchPreset(preset_name, async_switch)
```

`UnifiedGpuMemoryManager::saveActiveToLibrary()` (`UnifiedGpuMemoryManager.cu:396-438`)
does a `cudaMemcpy(D2D)` of `dev_preset_working_` into
`preset_gpu_library_[active_preset_name_]` **and** mirrors it to the host copy
`preset_library_[active]`.

Consequence: **every** switch-away first writes the current live GPU edits into
whatever preset you are leaving. If the user tuned parameters while "Original"
was active, then switches to anything else, `saveActiveToLibrary()` bakes those
edits into "Original"'s GPU + host slot. The original is now permanently
mutated for the rest of the session. Switching back shows the mutated values.

### 2.2 Python domain-model layer — reference aliasing

`switch_preset()` (`pianoid.py:2550-2559`) swaps the Python model by **reference**:

```python
model = self._library_models[preset_name]
self.sm = model['sm']            # same object that is stored in the library entry
self.modes = model['modes']
self.mp = model['mp']
self.param_manager.sm = self.sm  # …
```

`parameter_manager.update_pitch_physical_params_GRANULAR()`
(`parameter_manager.py:307-319`) then mutates that object **in place**:

```python
pitch = self.sm.pitches[pitchID]
pitch.physics.set_params(**params)        # in-place mutation
```

So every parameter edit mutates the `sm` object that `_library_models[active]`
holds. There is **one** deep-copy in the whole system —
`init_pianoid()` (`pianoid.py:2117-2121`) deep-copies `sm/modes/mp` exactly once
for the init-time reference entry. `load_preset_to_library()` (the runtime
"Add to library" path, `pianoid.py:2521`) stores the freshly-built `sm`
**by reference with no copy**.

Net effect: the GET-parameter read-back path (`pack_for_interface` reads
`self.sm`) and the deck repack on the next switch both see mutated values for a
preset that was supposed to be pristine. Nothing ever restores a pristine state
short of a full `/load_preset` (which calls `destroyPianoid()` and rebuilds from
the JSON file).

### 2.3 Relation to the "Strings-mode switch silence" investigation

Distinct. The revalidation review (`preset-revision-plan-revalidation-2026-05-17.md`
§5) establishes the silence bug is a separate CUDA double-buffer / `stringMapKernel`
routing issue; the sound-channel cache half was already fixed (Wave B, 2026-04-20).
This proposal does not touch that path. Verification still exercises
`listen_to_modes=0` because preset switching has that separate known fragility.

---

## 3. Case 9 / runtime state — now merged into this task

The user decided **volume and feedback are GLOBAL across the entire library** —
one shared pair, library-wide, independent of which entry is active; switching,
spawning, and promoting never change them.

**Investigation of the current code (not the stale `PRESET_SYSTEM_REVISION_PLAN.md`):**

- `volume_level` and `deck_feedback_coefficient` live **only on the GPU** via the
  C++ `RuntimeParameters` struct. There is **no per-preset storage** anywhere —
  `_library_models[name]` is `{sm, modes, mp}`, no `runtime` dict.
- `switch_preset()` (`pianoid.py:2566-2582`) **already** snapshots
  `volume_level` + `deck_feedback_coefficient` from `getRuntimeParameters()`
  before the switch and re-applies them after. So volume/feedback are **already
  global-persistent across a switch** — the revalidation review confirmed this
  is intentional, post-plan code.
- `save_preset()` (`pianoid.py:2435`) does **not** write runtime scalars into the
  preset JSON.

**Conclusion — no design fork.** The user's "global" choice *aligns with current
behaviour*. This task therefore does NOT need a `runtime` dict on preset records
and does NOT adopt the old `PRESET_SYSTEM_REVISION_PLAN.md` per-preset design
(which the revalidation already flagged as a reversed premise). The runtime-state
work here is small and confirmatory:

1. Keep volume/feedback global — the existing `switch_preset` snapshot/restore
   stays. **New spawn and promote operations must also preserve them** (they will
   naturally, since neither touches `RuntimeParameters`, but the verification
   plan explicitly checks this).
2. **Volume sensitivity** (`volume_center`/`volume_range`): `switch_preset`
   currently *resets* `volume_range` to engine default and re-seeds
   `volume_center` on every switch. Under "global" this is mildly inconsistent —
   sensitivity is neither per-preset nor truly persistent. **Decision folded in:**
   treat sensitivity as global-persistent too (snapshot + restore it across a
   switch, exactly like `volume_level`), so the whole volume/feedback surface
   behaves uniformly "global". This removes the surprise "sensitivity jumps back
   to default on switch" behaviour and matches the user's intent of one shared
   volume/feedback configuration. **This is the one substantive Case 9 change.**
3. `PRESET_SYSTEM_REVISION_PLAN.md` is reconciled by this task — its still-valid
   content (the `getAvailableNotes()`-after-switch gap, the `switchingRef`
   concurrency guard) is folded into §7 below; the doc is archived at Step 8.

The old plan's `feedback_midi` / per-preset `runtime` dict is **dropped** — it
was designed for per-preset state, which the user explicitly rejected in favour
of global.

---

## 4. Current architecture brief

| Layer | Element | Role |
|---|---|---|
| GPU (C++) | `preset_gpu_library_[name]` | Per-preset GPU snapshot (~3.15 MB) |
| GPU (C++) | `preset_library_[name]` | Per-preset host mirror |
| GPU (C++) | `dev_preset_working_` | Active buffer the kernel reads |
| GPU (C++) | `RuntimeParameters` | volume_level, deck_feedback_coefficient, volume_center/range — **global GPU scalars, not per-preset** |
| Python | `_library_models[name]` | `{sm, modes, mp}` domain objects per entry |
| Python | `self.sm/.modes/.mp` | Active model — aliased to `_library_models[active]` |
| REST | `/preset/load`, `/preset/switch`, `/preset/unload`, `/preset/list` | Library management |
| REST | `/save_preset`, `/set_runtime_parameters` | Persist to JSON; runtime scalars |
| Frontend | `usePreset` | `libraryPresets` (name list), `activePreset` |
| Frontend | `PresetPanel.jsx` | Library list UI; click row → `switchPreset` |

Today a "library entry" is just a **name string**. There is no metadata, no
read-only flag, no working/original distinction. `/preset/list` returns a flat
`["working", "Steinway", ...]` array.

---

## 5. Proposed design

### 5.1 Core concept — explicit entry kind

Every library entry gains a **kind**: `original` (read-only) or `working`
(editable), plus `source` (the originating original) and, for originals, the
on-disk JSON `path` (needed for promote-to-disk). The library becomes a list of
records, not bare names:

```json
{
  "presets": [
    { "name": "Steinway",            "kind": "original", "source": "Steinway", "path": "presets/Steinway.json" },
    { "name": "Steinway (working 1)", "kind": "working",  "source": "Steinway", "path": null },
    { "name": "Steinway (working 2)", "kind": "working",  "source": "Steinway", "path": null }
  ],
  "active": "Steinway (working 1)"
}
```

- **`original`** — an unmodified snapshot of a preset as loaded from disk.
  Read-only; all parameter-edit endpoints reject writes while an original is
  active. Carries `path` = its on-disk JSON file.
- **`working`** — an editable copy spawned from an original (or another working
  copy). Edits are allowed and isolated to this entry. Session-only (Q2).
- **`source`** — the name of the `original` this entry ultimately derives from.

### 5.2 Fixing the bug (the two leaks)

**Leak 1 — C++ unconditional `saveActiveToLibrary()`.** Gate the save on the
active entry being a working copy. In `switch_preset()`:

```python
# only persist live edits back to the slot if the active entry is editable
if self._library.kind_of(self.get_active_preset()) == "working":
    self.pianoid.saveActiveToLibrary()
success = self.pianoid.switchPreset(preset_name, async_switch)
```

Originals are never written back → their GPU + host slots stay pristine. No C++
change — `saveActiveToLibrary()` stays as-is; only the Python call site is gated.

**Leak 2 — Python reference aliasing.** Copies must never share `sm/modes/mp`
objects. The spawn operation deep-copies the source entry's domain objects.
`load_preset_to_library()` already builds a *fresh* `sm` from JSON, so the
`original` it creates is naturally isolated. With copy-on-spawn, editing a
working copy mutates only that copy's `sm`; switching to the original and back
returns genuinely separate objects.

### 5.3 Read-only enforcement (Feature 2)

A single guard at the **`Pianoid` orchestrator boundary** — the one place all
parameter writes funnel through. A `_assert_active_editable()` check is called
by the parameter-edit entry points (`update_parameter`,
`apply_parameter_request`, `update_pitch_physical_params*`, hammer/mode/deck
edits). Runtime-parameter writes (volume/feedback) are **exempt** — they are
global, not preset-block edits, and stay allowed on any active entry.

```python
def _assert_active_editable(self):
    name = self.get_active_preset()
    if self._library.kind_of(name) != "working":
        raise PresetReadOnlyError(
            f"Preset '{name}' is read-only. Spawn a working copy to edit."
        )
```

`PresetReadOnlyError` → REST handlers return HTTP 409 with a structured message;
WS handlers emit `error` with `code: "preset_read_only"`. Mirrors the existing
`ParameterRangeError` → 400 pattern (`parameter_manager` safety net).

P1 (Authority): the orchestrator owns "which preset is active and is it
editable"; the guard lives there exactly once. The frontend complements it with
**proactive** UI locking (editors disabled when an original is active) so the
user does not hit the 409 in normal use — the backend guard is the authority,
the UI lock is UX.

### 5.4 Spawn working copy (Feature 3) — Q1: from CURRENT state

New backend operation `spawn_working_copy(source_name)`:

1. Resolve the source entry; determine its `original` ancestor.
2. Generate a unique label: `"<original> (working N)"` — N is the next free
   index among existing working copies of that original (Q5: auto-labelled).
3. **Deep-copy the source entry's CURRENT `sm/modes/mp`** (Q1: live edits
   included — "duplicate what I have"). If the source is currently the active
   entry, its in-memory model already reflects live edits; if it is a non-active
   working copy, its stored model is its last-saved state. Either way the deep
   copy is taken from `_library_models[source]`.
4. Pack arrays and call `_load_preset_to_library(label, …)` to create the GPU +
   host slot (C++ already supports arbitrary-named entries).
5. Register the record `{sm, modes, mp, kind:"working", source:<original>,
   path:None}`.
6. Return the new label; the frontend switches to it.

New REST endpoint `POST /preset/spawn_working_copy {source}` →
`{name, presets}`. New `usePreset.spawnWorkingCopy(source)`.

Note: spawn does NOT touch `RuntimeParameters` → volume/feedback stay global
(§3).

### 5.5 Several labelled working copies (Feature 4)

Falls out of 5.4 — the library already supports arbitrary named entries; we
allow multiple `working` entries per `source`, the label carries the index N.
The frontend library list renders kind + source (§5.10).

### 5.6 Promote working copy to disk (Feature, Q4 = B1) — NEW SCOPE

The user chose to **include a promote action that overwrites the original's
on-disk JSON file** (permanent, survives restart).

New backend operation `promote_working_copy(working_name)`:

1. Resolve the working entry; require `kind == "working"` (cannot promote an
   original onto itself).
2. Find its `source` original and that original's on-disk `path`.
3. **Write the working copy's current model to that JSON path** — reuse the
   existing `save_preset()` machinery (`pianoid.py:2435`,
   `sm.pack_for_preset_file()` + `modes.pack_modes_for_preset()` +
   sound-channels), but packing from the *working copy's* `sm/modes` (temporarily,
   or via a `save_preset(path, sm=…, modes=…)` parameterisation — see §7 step 5).
4. **Update the in-memory `original` entry to match** — re-load the just-written
   JSON into the original's library slot (or deep-copy the working copy's model
   into the original's record) so the original now reflects the promoted state
   without requiring a restart.
5. Volume/feedback untouched (global; not in the JSON anyway).

New REST endpoint `POST /preset/promote {name}` → `{message, presets}`. New
`usePreset.promoteWorkingCopy(name)`.

**Safety:** promote overwrites a file on disk — it is a destructive,
hard-to-reverse action. The frontend MUST confirm via a dialog ("Promote
'<working>' — this overwrites <original>.json on disk. Continue?") before
calling the endpoint. The backend writes atomically (write to a temp file, then
replace) so a crash mid-write cannot corrupt the original JSON.

### 5.7 Unload behaviour (Q6 = B, Q7 = B)

- **Q7 — boot preset is fully unloadable.** Drop today's "cannot unload
  default/working" exemption in `PresetPanel.jsx:314`. Any entry can be unloaded
  **as long as at least one preset remains loaded** — a `last-preset` guard
  prevents an empty engine. `unload_preset()` raises `PresetLibraryError` if it
  would remove the final entry; REST returns 409.
- **Q6 — never leave the user with no editable copy.** When unloading an entry
  would leave its `source` original with **zero** working copies, the backend
  **auto-spawns a fresh working copy** from that original immediately after the
  unload, and (if the unloaded entry was active) switches to the new copy.
  Equally, if a user unloads the *original* itself, its working copies remain
  (they are independent GPU slots); they simply lose their `source` ancestor —
  acceptable, they stay editable.
- Practical effect: the library can hold originals-only *transiently* during an
  unload, but the auto-spawn restores an editable copy whenever an original has
  none and is the natural place to edit.

### 5.8 What happens to the init-time pair (Q3)

`init_pianoid()` currently creates `"working"` + a deep-copied filename
reference. Under the new model:

- The freshly loaded preset is registered as an **`original`** entry named after
  the preset file, carrying its on-disk `path`.
- Exactly **one `working` copy is auto-spawned** from it and made active (Q3),
  so the user can edit immediately. Labelled `<file> (working 1)`.
- The bare magic name `"working"` goes away — replaced by labelled working
  copies.

On app restart (Q2/Q3): nothing in-memory persists; the on-disk preset reloads
as a read-only original and one fresh working copy is auto-spawned and activated.
Promoted changes survive because promote wrote them to the JSON file (§5.6).

### 5.9 Global runtime state (volume / feedback) — §3 folded in

- Volume + feedback remain **one global pair**, shared library-wide. The
  existing `switch_preset` snapshot/restore stays.
- **Volume sensitivity** (`volume_center`/`volume_range`) is made
  global-persistent too: `switch_preset` snapshots and restores it instead of
  resetting `volume_range` to default — so the entire volume/feedback surface is
  uniformly "global". (This is the single substantive Case 9 code change.)
- Spawn and promote do not touch `RuntimeParameters` → volume/feedback are
  inherently preserved across them.
- Plan-folded quick wins from `PRESET_SYSTEM_REVISION_PLAN.md` (still valid per
  the revalidation): add the missing `getAvailableNotes()` call in the frontend
  `switchPreset`, and a `switchingRef` concurrency guard so rapid `[`/`]`
  preset-cycling cannot interleave.

### 5.10 Frontend library list

`PresetPanel.jsx` library list renders records:

- **Originals** — plain name, a small lock icon, `source`/path as secondary
  text. A "Spawn working copy" action (icon button) per row.
- **Working copies** — name `Steinway (working 2)`, an "editable" chip/icon,
  `source` as secondary text, an unload (delete) button, and a "Promote to
  original" action (with the confirm dialog from §5.6).
- The active entry stays highlighted as today.
- MUI v6, dark professional theme, existing patterns — no new libraries.

---

## 6. Resolved design decisions (user answered all 9)

| # | Question | **Resolved** |
|---|---|---|
| Q1 | Spawn from current (edited) state or pristine original? | **Current active entry's state** (live edits included). |
| Q2 | Working copies persisted to disk, or session-only? | **Session-only** (in-memory). |
| Q3 | What on app restart? | Reload on-disk preset as a read-only **original** + auto-spawn ONE fresh working copy, made active. |
| Q4 | Can a working copy be promoted/saved back? | **Yes — include a Promote action that OVERWRITES the original's on-disk JSON file** (permanent, survives restart). New scope vs the original draft. |
| Q5 | Label format | Auto-labelled `<original> (working N)`. |
| Q6 | Last working copy of an original unloaded? | **Auto-spawn a fresh working copy** — never leave the user with no editable copy. |
| Q7 | Boot preset unloadable? | **Yes, fully unloadable** — drop the boot exemption; keep only a `last-preset` guard (no empty engine). |
| Q9 | `pianoid.py` size (already C4-RED) | **Carve out a `PresetLibrary` class AS PART of this task** — do not defer the split. |
| Case 9 | Volume/feedback runtime state | **Global library-wide** — one shared pair, independent of the active entry, NOT hung off working-copy records. Merged into this task. |

No remaining open decision. Case 9 surfaced no genuine design fork (§3) — the
"global" choice aligns with current code behaviour; the only substantive change
is making volume *sensitivity* global-persistent for uniformity.

---

## 7. Implementation plan

### New module — `PresetLibrary` class (Q9 carve-out)

Create `PianoidCore/pianoid_middleware/preset_library.py` — a `PresetLibrary`
class that owns the library registry and all entry bookkeeping. This addresses
the C4-RED state of `pianoid.py` (WIP §4.3 flagged exactly this carve-out) by
moving preset-library concern OUT of the orchestrator.

`PresetLibrary` owns:
- the entry records (`name → {sm, modes, mp, kind, source, path}`) — replaces
  the raw `_library_models` dict;
- `kind_of(name)`, `source_of(name)`, `path_of(name)`, `working_copies_of(orig)`;
- `register_original(name, sm, modes, mp, path)`,
  `register_working(name, sm, modes, mp, source)`;
- `next_working_label(original)` — the `(working N)` indexer;
- `remove(name)` and the `last-preset` / auto-respawn policy helpers;
- `records_for_api()` — the `/preset/list` payload shape.

It does **not** own GPU calls — those stay on `Pianoid` (it holds the C++
binding). `Pianoid` keeps a `self._library = PresetLibrary(...)` and delegates.
This keeps P2: `PresetLibrary` = library bookkeeping; `Pianoid` = orchestration +
GPU. Net effect on `pianoid.py` LOC: roughly neutral-to-negative (methods move
out; thin delegators move in).

### Backend — `pianoid.py` (delegates to `PresetLibrary`)

1. **`load_preset_to_library()`** — build the model as today, then
   `self._library.register_original(name, sm, modes, mp, path)`.
2. **`spawn_working_copy(source_name)`** — §5.4: deep-copy current model,
   `next_working_label`, `_load_preset_to_library` GPU slot,
   `register_working(...)`. Returns the label.
3. **`promote_working_copy(working_name)`** — §5.6: atomic JSON write to the
   original's `path` via the parameterised `save_preset`, then refresh the
   in-memory original entry.
4. **`switch_preset()`** — gate `saveActiveToLibrary()` on `kind_of(active) ==
   "working"` (Leak 1). Snapshot/restore volume sensitivity alongside
   volume_level (§5.9). Python model swap unchanged (objects now separate).
5. **`save_preset(path, sm=None, modes=None)`** — parameterise so promote can
   pass a working copy's model; default `None` → current `self.sm/.modes` (no
   behaviour change for the existing `/save_preset` route). Atomic write
   (temp-file + replace).
6. **`unload_preset()`** — `last-preset` guard (raise `PresetLibraryError` if it
   would empty the library); auto-respawn per Q6; activate the respawned copy if
   the unloaded one was active.
7. **`init_pianoid()`** — §5.8: register the loaded preset as `original`,
   auto-spawn one `working`, activate the working copy. Remove the `"working"`
   magic entry + the init-time deep-copy reference pair.
8. **`_assert_active_editable()`** + `PresetReadOnlyError` /
   `PresetLibraryError` — guard called by all parameter-edit entry points.

### Backend — `backendServer.py`

9. **`/preset/list`** — return `self._library.records_for_api()`.
10. **`POST /preset/spawn_working_copy {source}`** — → `spawn_working_copy`.
11. **`POST /preset/promote {name}`** — → `promote_working_copy`.
12. **Error mapping** — catch `PresetReadOnlyError` (409 `preset_read_only`) and
    `PresetLibraryError` (409) in the parameter REST + WS handlers and the
    preset routes. Mirror `ParameterRangeError` handling.

### Frontend — `usePreset.js`

13. `libraryPresets` becomes a record list; `refreshPresetLibrary` /
    `switchPreset` / `loadPresetToLibrary` / `unloadPreset` adjust to the new
    `/preset/list` shape.
14. `spawnWorkingCopy(source)`, `promoteWorkingCopy(name)` — new methods.
15. `activePresetReadOnly` derived boolean (active entry `kind !== "working"`).
16. `switchPreset` — add the missing `getAvailableNotes()` call + a
    `switchingRef` concurrency guard (folded-in `PRESET_SYSTEM_REVISION_PLAN`
    quick wins, §5.9).

### Frontend — `PresetPanel.jsx` + editor panes

17. **Library list** — render `kind` (lock icon / editable chip), `source`
    secondary text; per-row Spawn action; per-working-copy Promote action +
    confirm dialog (§5.6) + Unload.
18. **Read-only UI lock** — when `activePresetReadOnly`, disable the parameter
    editors (Strings, Modes, Excitation, Feedin/Feedback, Sound Channels,
    Hammer) + a banner "Read-only original — spawn a working copy to edit".
    Reuse the existing lock-aware disable pattern. MUI v6, dark theme.

### Tests

19. `tests/system/` — **preset isolation**: load → spawn working copy → tune a
    string param → switch to original → assert original's `get_parameter`
    values AND a `note_playback` offline render match the pre-edit baseline →
    switch back to the working copy → assert tuned values persist. Covers both
    leak paths.
20. `tests/system/` — **read-only enforcement**: with an original active,
    `/set_parameter/string/<p>` returns 409 `preset_read_only`.
21. `tests/system/` — **promote**: spawn → tune → promote → assert the on-disk
    JSON file changed AND the in-memory original now reflects the promoted
    values; reload the preset → assert the promoted state survives restart.
22. `tests/system/` — **global runtime state**: set volume + feedback → spawn /
    switch / promote → assert volume + feedback (and sensitivity) unchanged.
23. `tests/system/` — **unload policy**: unloading the last working copy of an
    original auto-spawns a new one; unloading down to one preset is blocked
    (409).

### Docs (Step 8)

24. `docs/architecture/DATA_FLOWS.md` §2.7-2.8 — working-copy model, conditional
    `saveActiveToLibrary`, entry-kind records, spawn/promote flows, global
    runtime state.
25. `docs/modules/pianoid-middleware/REST_API.md` — `/preset/list` new shape,
    `/preset/spawn_working_copy`, `/preset/promote`, `preset_read_only` 409.
26. `docs/modules/pianoid-middleware/OVERVIEW.md` — the new `PresetLibrary` class.
27. `docs/modules/pianoid-tunner/OVERVIEW.md` — PresetPanel library records,
    read-only locking, `spawnWorkingCopy`/`promoteWorkingCopy`.
28. `docs/development/CODE_QUALITY.md` — update the God Objects list for
    `pianoid.py` (the carve-out should drop it, or hold it, below the prior LOC).
29. **Archive `PRESET_SYSTEM_REVISION_PLAN.md`** to `docs/proposals/archive/` via
    `git mv` — its still-valid content (the `getAvailableNotes` gap + concurrency
    guard) is folded into this proposal §5.9 and implemented; the per-preset
    `runtime`/`feedback_midi` design is superseded by the user's "global"
    decision. This proposal is the single source of truth.

---

## 8. Code-quality notes

- **P1 (Authority).** "Which preset is active + its kind" is owned solely by the
  `Pianoid` orchestrator; the read-only guard lives there once. Library
  bookkeeping is owned solely by the new `PresetLibrary`. No editor pane or
  endpoint independently decides editability.
- **P2 (Concern).** The `PresetLibrary` carve-out *improves* P2 — preset-library
  bookkeeping leaves the orchestrator. UI locking is a frontend display concern,
  stays in the panes.
- **C4 (file size).** `pianoid.py` is C4-RED (~2547 LOC). The `PresetLibrary`
  carve-out (Q9) moves preset-library methods out — net LOC neutral-to-negative;
  the God Objects list is updated in Step 8. The new `preset_library.py` is a
  fresh, small file.
- **S5 (fail-fast).** `PresetReadOnlyError` / `PresetLibraryError` are hard
  rejects, not silent no-ops — consistent with the engine safety-net philosophy.
- **Promote is destructive** — atomic temp-file write + replace on the backend;
  frontend confirm dialog. No silent overwrite.

---

## 9. Verification plan

Live-engine, per the Audio Verification Rule (state-isolation bug → offline
render alone is insufficient; need before/after on a real switch):

1. Start the full stack (launcher + backend + frontend).
2. Load a preset → confirm an `original` + auto-spawned `working` appear; the
   working copy is active and editable.
3. On the working copy, tune a string parameter; capture a `note_playback`
   render → record amplitude/waveform.
4. Switch to the `original` → confirm `get_parameter` shows pristine values AND
   a `note_playback` render matches the pristine baseline (the bug fix).
5. Switch back to the working copy → confirm the tuned values + sound persist.
6. With the `original` active, attempt a parameter edit → confirm 409 + UI lock;
   editors disabled.
7. Spawn a second working copy → confirm `(working 2)` label, independent
   editing; switching among `(working 1)`/`(working 2)`/`original` all isolated.
8. **Promote**: tune `(working 2)`, promote it → confirm the original's on-disk
   JSON changed, the in-memory original reflects the promoted values; reload the
   preset → confirm the promoted state survived.
9. **Global runtime state**: set volume + feedback → spawn / switch / promote →
   confirm volume + feedback + sensitivity unchanged throughout.
10. **Unload policy**: unload the last working copy of an original → confirm a
    fresh one auto-spawns; unload down toward one preset → confirm the last
    unload is blocked (409).
11. Repeat steps 3-5 with `listen_to_modes=0` (Strings mode) — separate known
    switch fragility, must not regress.
12. `tests/system/test_performance.py` baseline vs post-change — no GPU-mean
    regression (>10%), sound correlation ≥ 0.95.

---

## Investigation history

- `docs/development/reviews/preset-revision-plan-revalidation-2026-05-17.md`
  — establishes Case 9 status and the separateness of the Strings-mode silence
  bug.
- `docs/development/PRESET_SYSTEM_REVISION_PLAN.md` — Case 9 (per-preset runtime
  state); reconciled and superseded by this task (§3); archived at Step 8.
