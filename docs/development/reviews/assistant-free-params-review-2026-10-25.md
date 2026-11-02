# Assistant free parameter edits + physical gates — review (dev-free1, 2026-10-25)

**Status:** committed on `feature/dev-free1-free-params` (PianoidInstall + PianoidTunner). **Not merged.** The merge
needs user approval.

**User decision (2026-10-25):** "Build all, make change parameters free, agent should be able to do the work
autonomously. Limit for the volume should be at clipping (reject once clipping detected), for the string parameters
- courant criterion."

## What changed

| Area | Before | After |
|---|---|---|
| step limits (A2 envelope) | volume +6 per step, feedback ×1.5 per step and ≤ ×2 of the stored value, mode decrement cut ≤ 50 %, ≤ 128 keys per command, ≤ 20 automatic writes per turn; any other field (strings, hammer, excitation, feedin, mode frequency, …) was "outside the envelope" | **none**: every params / runtime edit is free |
| outside the limits | a HARD confirm (no "Don't ask again"), even in Autonomous mode and inside an approved plan | does not exist. An invalid value (volume not an integer 0..127, a negative decrement) is **denied** with a tool error, never asked |
| string parameters | always outside the envelope | **CFL gate**: applied, then the engine's `/health cfl_redline` is read; on a violation the write's undo group is undone at once and the model gets `error: cfl_violation` with pitch, Courant number and `\|g\|`. An unreadable flag also undoes (fail closed) |
| volume / level | the level watch only after Auto writes | the level watch (clipping, guard trip, peak over target) with auto-revert after **every** params / runtime write, confirmed ones included; the runtime revert now restores volume, feedback, `volume_center`, `volume_range`, `store_feedback_coeff` |
| plans | `params` / `runtime` steps still needed the envelope | a plan covers parameter edits of any size; the gates still apply |
| Tunner UI | "outside the safety envelope" texts | 2 strings updated (`AssistantPane.jsx`, `ApprovalsPopover.jsx`) |

Files: `tools/pianoid-assistant/{envelope,policy,approvals,autonomy}.js`, `service/{autoWrite,session,prompt}.js`,
`schemas/params/{_index,runtime,mode}.json` (the `envelope` entries are validity bounds only + a `cfl` gate entry),
README "Physical gates", tests. Docs gap closed: `SYNTHESIS_ENGINE.md` / `PARAMETER_SYSTEM.md` said
`CFL_MARGIN = 0.8`; the installed engine reports **0.99** (Core `1ca92ec`); PARAMETER_SYSTEM's v2 "skip the
upload" wording now points at the v3 indicator-only behaviour.

## CFL definition used (the engine's own)

Courant number `coeff_tension − 8·coeff_bending` of the worst string ≥ `CFL_MARGIN` (0.99), or `max|g| > 1`
(SYNTHESIS_ENGINE "FDTD Stability (CFL / Courant) Bound"). The assistant does not compute it: it reads the engine's
flag (`ParameterManager._flag_cfl_indication`, the same closed form as the `cfl_ratio` chart and `stability_ratio`).

**Not prospective.** The engine applies every string edit (v3) and has no dry-run route, so the check is
apply → read flag → undo. The bad coefficients live on the GPU for the few ms until the undo (the in-kernel
amplitude guard covers a runaway). A truly prospective check needs a backend dry-run route (`cfl_stability` on
current ⊕ edit, no upload): follow-up, Core.

## Verification against the engine (measured)

Isolated backend `:5012` (main PianoidCore, BaselinePreset1, audio off, no realtime thread), the REAL assistant
service (fake driver → real MCP server → the service executor) in Autonomous mode,
`docs/development/diagnostics/dev-free1-gates-live.mjs`, result `dev-free1-gates-live-result.json`. Pitch 60,
original tension 650.49 N (Courant 0.0253; Courant is linear in tension, 2.5256 at ×100):

| step | tension | engine verdict | assistant | tension after |
|---|---|---|---|---|
| stable | 24003 (×36.9, Courant ≈ 0.93) | `cfl_redline: false` | applied, `level_check: ok`, no prompt | 24003 |
| unstable | 26020 (×40) | Courant **1.018**, `\|g\|` 1.3101 | `cfl_violation`, undone | 24003 (restored) |
| unstable | 65049 (×100) | Courant **2.527**, `\|g\|` 7.9848 | `cfl_violation`, undone | 24003 (restored) |
| restore | 650.49 | stable | applied | 650.49 |
| volume | 64 → 127 (+63) | — | applied, no prompt (was a hard confirm) | 127, set back to 64 |

`/health cfl_redline` was `false` after each undo (the undo goes through the granular path and clears the flag).
Zero confirms raised in the whole run.

## Clipping guard evidence

The live clipping signal needs live **audible** output (`/health` drops offline-render peaks), which the isolated
audio-off backend cannot produce, and the user's live stack was not to be touched. Evidence is therefore the service
end to end against a fake `:5000` that latches `clipping` after a write: `approvals.test.js` "volume is limited by
clipping, not by step": a +16 jump in Auto mode runs without a prompt, clips, and is reverted to 64
(`runtime.set {volume: 80}` then `{volume: 64}`); the same jump confirmed in Ask mode is also reverted. The existing
level-watch tests (history-group revert of a mute, runtime revert) still pass. A live clip check with the rig is a
follow-up when the stack is free.

**Limitation:** the watch sees only what plays during the 15 s window; a volume raise made in silence is caught only
if something plays inside the window. The prompt tells the model to play a loud test after a big level change.

## What still asks

Autonomous mode (hard, no "Don't ask again"): `preset.promote`; deletes / unloads; `audio.exciters_config`; any
external filing / sending; launcher / process control; a rig drive above −24 dBFS or with an unknown level; saving
over a preset the assistant does not own; `preset.create` with overwrite. A web-tainted turn asks for every action.
A plan the user approved and ticked may cover the hard ones, as before.

Outside Autonomous mode, unchanged: `params` / `runtime` ask (ordinary confirm, "Don't ask again" offered) until set to
Auto; the hard-confirm list (save, promote, full load, unload, calibration, modal jobs, launcher start, …) asks.

## Tests

- Assistant (`node --test test/`): **145 pass, 1 skip, 0 fail** (baseline 143 / 1 skip; +2 service tests, the
  envelope tests rewritten for the gates).
- Tunner Assistant Jest (`--maxWorkers=2`): **6 suites, 38 pass**.

## Risks / review notes

- Removing the 20-writes-per-turn bound removes a runaway-loop brake; the audit log and "Undo turn" remain.
- `runtime.set` also accepts `volume_center` / `volume_range` / `store_feedback_coeff` of any size now; they are
  level-watched like volume.
- A preset that is already over the CFL margin on a pitch rejects every string edit on that pitch until it is
  brought back (the flag is the worst offender of the edited pitches). The error message names the pitch.
