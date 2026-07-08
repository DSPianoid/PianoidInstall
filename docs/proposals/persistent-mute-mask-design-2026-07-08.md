# F6 — Persistent Independent Mute Mask: design (2026-07-08)

> Read-only design (no code changed). User decision (review-finding F6): mute must be PERSISTENT +
> INDEPENDENT — a stored mask, raw values never destroyed, mutes survive reload + preset-switch.
> **★ Changes the SAVED PRESET FORMAT — confirm §E migration with the user before implementing.**

## Current — destructive FE-only mute
The FE ALREADY keeps raw (`matrix`) + mask (`muteMap`) separate (useMatrixHistory.js:7-8, toggles never
touch `matrix`). The destruction is at EMIT: the emit path multiplies them (`computeMutedMatrix`,
matrixEmit.js:23-34; useSoundChannels.js:324-333; useFeedinAggregate.js:59-60) and posts ONLY the
product. Backend stores the product (parameter_manager.py:824-892 → Pitch.update_deck overwrites),
save_preset persists the product (Pitch.py:123-135; pianoid.py:3117-3123). → raw-under-mute lives only
in FE history → GONE on reload/preset-switch; a muted 0 is indistinguishable from a real 0.
(The existing `feedback_output_mask` is per-STRING static — NOT reusable for a per-cell dynamic mute.)

## Design — independent mask, applied HOST-SIDE at pack time (NO kernel/CUDA change)
Store raw UNCHANGED; store the mask as a PARALLEL structure; multiply `mask×raw` ONLY inside the pack
functions (transient, never written back). GPU still receives `mask×raw`; raw+mask stay independent for save.
- **Storage:** `pitch.deck_mask['feedin'/'feedback']` (same shape as `deck[...]`, covers Feedin/Feedback/SC-strings-axis) + `soundChannelModes.mute_mask[pitch]` (SC modes-axis). Default all-1.0 (unmuted) when absent.
- **Pack (single multiply point):** an `effective(deck[m]*deck_mask[m])` helper in StringMap.pack_pitch_feedin (:433-457) + the feedback branch of pack_deck (:459-482); analogous SC-modes multiply. No other pack site changes.
- **Wire protocol:** new mask KINDS `feedin_mask`/`feedback_mask`/`sound_channel_mask` (VALID_REQUEST_KINDS) mirroring the value kinds; a value write updates raw + re-packs, a mask write updates the mask + re-packs → GPU gets `mask×raw` either way (existing double-buffer/CFL machinery).
- **FE (small — raw+mask already separate):** emit RAW (not `computeMutedMatrix` product); a mute toggle posts the affected mask row via the new `*_mask` kinds; seed the mask from backend (`/get_parameter/*_mask`) on preset load instead of forcing all-1. DISPLAY unchanged (canvas already renders raw×mask).

## Preset format + backward-compat (★ CONFIRM)
Add per matrix: `pitches[id]['deck_mute_mask']` (2×num_modes) + a `mode_sound_channels_mute_mask` block.
**Migration: ABSENT mask ⇒ all-unmuted (all 1.0); existing baked zeros treated as REAL values.**
→ Lossless-safe: every existing preset renders BYTE-IDENTICALLY to today (it already holds the product;
mask=1 changes nothing). CAVEAT: raw-under-OLD-mute (from before this change) is genuinely unrecoverable
(it was never stored) — inherent, acceptable; from the first save under the new scheme, raw+mask both
preserved and mutes persist.

## Touch points + build
- FE (PianoidTunner): useMatrixHistory, useSoundChannels + useFeedinAggregate + Feedback hook + matrixEmit (emit raw+mask), the mute UI (SoundChannelsPane/MeasuredMatrix), usePreset (mask emit/get).
- Middleware (PianoidCore): parameter_manager (kinds + apply branches), pianoid.py save/load (mask blocks), new /get_parameter/*_mask + set routes in backendServer.py.
- Domain (PianoidBasic): Pitch (deck_mask store + serialize), StringMap (mask update + pack multiply + preset pack), soundChannelModes (mask store).
- **Engine/kernel: NONE.** Build: PianoidBasic + a LIGHT CUDA `--both` (middleware .py only) + backend restart. No `.cu` change, no HEAVY build.

## Trade-offs
(+) raw never destroyed, mute survives reload + preset-switch, real 0 ≠ muted; no kernel change. (−) preset JSON ~2× the deck block per pitch (acceptable). Sync risk mitigated by re-packing `mask×raw` on BOTH write kinds (single source of effective value); aggregate/undo already compute both synchronously.

## Phased plan
1. Domain+pack (PianoidBasic): deck_mask store, all-1 default, pack multiply, serialize/deserialize + absent-⇒-unmuted migration; unit-test pack equivalence (mask=1 ⇒ byte-identical).
2. Middleware: mask kinds + apply branches + save/load blocks + get/set routes; /load_preset 200 smoke on an OLD preset (identical) + a new mask round-trip.
3. FE: emit raw not product; add mask emit; seed mask from backend on load; wire mute UI; Jest for the emit substitution.
4. Verify (SC/Feedin/Feedback): mute a cell → reload → still muted + raw preserved (edit-under-mute survives); switch preset → mask persists per preset.
