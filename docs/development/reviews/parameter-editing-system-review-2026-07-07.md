# Parameter-Editing System — Deep Architecture Review (2026-07-07)

> Read-only audit (Fable agent), FE (PianoidTunner) → WS/REST → middleware → CUDA kernel, all groups.
> Grounded in DATA_FLOWS.md §2, PARAMETER_SYSTEM.md, pianoid-tunner/OVERVIEW.md + full code trace.
> **Bottom line:** backend backbone is unified + healthy; the divergences are almost all in the FE
> state/emit layer and per-group GPU-upload granularity. Canonical pattern = Sound Channels &
> mass/energy editors. Outliers/tech-debt = Strings, Modes, Excitation (pre-dev-833f effect-diff arch).

## Canonical pattern (as designed)
Three FE principles (encoded `useSoundChannels.js:180-192`): **P1 single-source-of-truth** (history
re-seeds from backend on every `presetVersion` bump), **P2 granular writes**, **P3 no speculative emits**
(imperative emit at the user-action site; a state change alone never emits).
Backend backbone (healthy, unified): REST `POST /set_parameter/<param>/<key>` (`backendServer.py:1660`) +
WS `set_parameter` (:461) byte-share `_apply_parameter_request` (:153) → `parse_range` → typed request →
`Pianoid.apply_parameter_request` (`pianoid.py:3870`; read-only guard → 409) → `ParameterManager` → model
mutation → `_gpu_upload` wait-for-IDLE → double-buffer swap → engine-thread pointer adoption. Post-
dev-strbatch: one swap per param per batch, 0 DROP_IF_BUSY losses.

## Cross-group consistency matrix
| Group | FE owner(s) | Emit style | Debounce | Wire gran | GPU gran | P1/P2/P3 |
|---|---|---|---|---|---|---|
| Strings | 3 copies | effect-diff (legacy) | 1 shared ref | member+bulk | **member** | ⚠/✔/✘ |
| Modes | 3 copies | effect-diff (+tail re-emit) | 1 shared ref | member+bulk | **member** | ⚠/✔/✘ |
| Excitation gauss | 3 copies | MIXED direct+effect-diff (gated on selection) | shared+batch | nested member | **blob** all-pitch | ⚠/⚠/✘ |
| Hammer spatial | excitationHistory | effect-diff | shared | member | **blob** | ⚠/-/✘ |
| Mass/speed/calib | sole hook | **imperative + reconcile** | none | member | incr recompose | **✔✔✔ reference** |
| Feedin/Feedback | matrix history (+mirror) | **imperative** | 1 shared ref | row/matrix | **blob** 256KB deck | ⚠/⚠/✔ |
| Sound Channels | histories (sole) | **imperative** | **per-key map** | row | **blob** deck | **✔**/row/**✔** |
| Runtime vol/fb | C++ struct authoritative | imperative debounced | per-field | scalar | scalar memcpy | ✔ (formula-mirror fragility) |

## Ranked findings
- **F1 HIGH — transport-level speculative emit (ALL groups).** `useSocketIO.js:96-103` emit is fire-and-forget on `socket.connected`, no ack; half-open WS buffers silently (the live [[project_ws_buffering_masks_emit]] failure). Backend sends per-write `param_ack` but FE uses it only as cfl/limiter telemetry. FIX: socket.io ack callbacks + timeout → REST retry, in the single emit helper + ~8 usePreset sites.
- **F2 HIGH — Strings/Modes/Excitation still on the deprecated effect-driven diff-sync emit** (`PianoidTuner.js:1762-1851/1879-1944/1972-2089`) — the anti-pattern the code's own comment (:1624-1628) says was fixed for SC in dev-833f. **F2b active defect:** the gauss sweep gated on `selectedParameter?.gaussIndex` (:2013) → undo/redo of a gauss edit while a non-gauss param is selected never emits (FE shows undone curve, engine keeps old). FIX: migrate to the imperative wrapper pattern; delete the 3 sync effects + skip-refs.
- **F3 HIGH — dual/triple FE copies, reconcile-by-diff (SSOT violation by construction).** `parametersOfX` is fetch-cache + diff-baseline + optimistic-mirror at once; a lost write makes baseline==history → divergence permanently undetectable; `selectedParameter.value` is a 3rd copy. FIX (with F2): demote parametersOfX to a pure fetch snapshot, derive selectedParameter.value at render.
- **F4 MED-HIGH — shared single debounce refs collapse rapid cross-target edits into lost writes.** One timer per group; two edits to different keys inside the window → first payload cancelled, never sent (invisible per F3). Fix pattern already in-tree (per-key maps `usePreset.js:549-577`). FIX: key every group's debounce by (group,key,param).
- **F5 MED — Feedin Refresh corrupts history to NaN.** `PianoidTuner.js:1634-1636` sends lowercase `"value"` (→ multiply branch) with an object newValue → `row*obj`=NaN every cell; next edit emits NaN. Feedback refresh is a 3rd behavior. FIX: plain `feedinHistory.init(...)` re-init; align Feedback.
- **F6 MED — mute is FE-only + destructively overwrites the backend model.** Emit = matrix×muteMap product; backend stores the zeroed product, save_preset persists it; raw masked values live only in FE history → lost on reload/switch. FIX (user decision): persist the mask in the preset (backend-owned mute) or document the lossy semantics.
- **F7 MED — granular writes stop at the middleware for Excitation/Hammer/Deck.** One gauss mu edit → all-pitch repack (30,720 reals); any deck/SC cell → whole 256×256 (256 KB); hammer → all hammers. Only Strings+Modes are GPU-granular. FIX: per-row granular C++ entry points (deck first by edit frequency).
- **F8 MED — write-authority inconsistencies.** (a) CFL gate covers the granular path only; bulk (MIDI-CC, NoteTunner) reaches the engine ungated — same param, two safety contracts by client. (b) SC strings-axis writes `deck['feedback'][128+ch]`; the distinct `string_sound_channel` kind + `string_coefficients` multiplicative gain has ZERO FE writers (dormant layer) — and DATA_FLOWS §2.4 still says the FE posts it (**doc drift**). (c) `'output'` kind is in the docstring/parse but rejected by VALID_REQUEST_KINDS (dead surface).
- **F9 LOW-MED — runtime RMW race + device-wide sync per slider tick.** `set_volume_level`/`set_deck_feedback_coefficient` do `getRuntimeParameters()` OUTSIDE cuda_lock then set the whole struct inside → interleaved volume+feedback ticks can revert a field; `setRuntimeParameters` ends with device-wide `cudaDeviceSynchronize()` every tick (the host-wait class cp0→cp1 removed). FIX: get inside the lock / per-field setters; stream-scope or drop the sync.
- **F10 LOW — volume/feedback modulation composition split across tiers, duplicated by convention** (exp((vol−100)/8) mirrored in 3 places). FIX: publish authoritative constants via /health.
- **F11 LOW — debounce latency mode frozen at first call** (WS-vs-REST wait chosen once); a session starting without WS keeps 300 ms forever. Cosmetic.

## Confirmed healthy (no action)
Unified REST/WS dispatch (no 2nd write path); `_gpu_upload` wait-for-IDLE + dev-strbatch batching (0 drops); double-buffer swap w/ engine-thread-only pointer adoption; read-only 409 + FE advisory mirror; `cancelPendingParamWrites` + version-keyed re-seed on preset transitions; CFL skip-not-reject single-owner flag; runtime scalars on direct memcpy; `feedback_output_mask` separating resonance scaling from output rows.

## Suggested sequencing
1. **F1+F4** (transport ack + per-key debounce) — small, group-agnostic; kills the silent-loss modes that make everything else undetectable.
2. **F2+F3** (imperative-emit migration of Strings/Modes/Excitation; closes F2b).
3. **F5** (NaN refresh) — one-line class bug, immediate.
4. **F6 + F8b** — need user decisions (mute persistence; string_sound_channel expose-or-remove + DATA_FLOWS §2.4 fix).
5. **F7** (granular deck/excitation GPU entries) — next CUDA build window.
6. **F9–F11** opportunistically.
