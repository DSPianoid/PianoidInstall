# Session Handoff — 2026-05-25 (~09:48 local)

**Reason:** Agent-team framework degraded after a long session + overnight machine suspension. Three consecutive guard-recovery spawns (`dev-cfl`, `dev-cfl-2`, `dev-cflfix`) were accepted but never executed (no log writes, no rebuild, no processes). A **VS Code reload** is required to restore the agent framework (and restart `/orchestrator`). All work is safe on branches; nothing merged or pushed.

## Resume after reload
1. Reload VS Code → restart `/orchestrator`.
2. Respawn the guard recovery in the fresh framework (it will run): point it at the dev-cfl log + the uncommitted θ-swept edits (below).
3. Verify the zombie agents (`dev-cfl`, `dev-cfl-2`, `dev-cflfix`) are gone (reload clears them).

## CFL stability guard — feature/cfl-stability-guard (PianoidCore) — TOP PRIORITY
- **Committed:** `2a37faa [dev-cfl]` — the original guard. It has **two bugs**:
  - **(A) Incomplete condition** — the `(T−8B)` reject was **Nyquist-only**; misses interior-θ instabilities (measured 2912 cases). 
  - **(B) URGENT realtime regression** — with this build, synthesis **silently STOPS on ANY string parameter change, even a stabilizing one (tension reduction), in the live engine.** A stabilizing edit halting synthesis ⇒ it's the guard's **MACHINERY** in the realtime loop (shadow snapshot/restore, per-string flag, the 3 new OUTPUT buffers, two-phase host R1 read, or parameterKernel's guard branch) — **NOT** the condition. Offline tests pass and miss it.
- **Uncommitted θ-swept fix (5 dirty files — PRESERVE, do NOT `git reset`/`checkout` the branch):** Kernels.cu, constants.h, pianoid_middleware/pianoid.py, tests/system/test_cfl_stability_guard.py. Replaced the Nyquist-only reject with `unstable = !isfinite || max_θ|g(θ)| > 1 + CFL_STABILITY_EPS` over the final shift_* coeffs (CFL_THETA_SAMPLES=24, EPS=1e-3, non-strict so the |g|=1 lossless baseline is allowed). Reported per-string ratio is now `max|g|` (≤1 stable). This addresses (A) but was **never rebuilt** — installed `.pyd` is still the old 16:46 build.
- **Next:** rebuild `--heavy` via the **detached Start-Process method** (foreground `cmd //c` gate-stalls; the install phase removes the `.pyd` at [4/6] before [6/6] so a gate-freeze bricks the venv). Then **diagnose (B)**: reproduce in the realtime path + A/B vs no-guard `dev`, fix the machinery. Validate across tension/Young's/radius/length/string_iter. **NO merge** until the realtime regression is reproduced AND resolved + user re-tests.
- Full investigation in `docs/development/logs/dev-cfl-2026-05-24-092641.md`. Diagnostics: `docs/development/diagnostics/dev-cfl-*.py`.

## CFL ratio-vs-pitch chart — feature/cfl-stability-chart (PianoidTunner)
- **Part 1 DONE + committed** (`0a3973f [dev-ratiochart]`; root docs `fae09a4`): opt-in `render_hints` contract in the standard chart renderer (`newWindowChart.jsx` → `buildChartOption` helper). Back-compat verified (62/693 Jest, zero regressions). Contract spec in `docs/modules/pianoid-middleware/CHART_SYSTEM.md`.
- **Part 2 HELD** until the guard merges: a PianoidCore `chartFunctions.py` `cfl_stability_ratio` fn + `chart_config.json` entry emitting the `render_hints` shape. Consumes the engine's stability getters. Chart plots `stability_ratio` (now `max|g|`, threshold line at 1.0 = stable boundary) vs pitch.

## Separate tracked bugs
- **Length/string_iteration crash** — a *separate, non-CFL* mechanism (dx-unit / grid-resolution / array-bounds; the #144 length→dx family). The T,B→0 regime is `|g|=1`, same as the healthy baseline, so the CFL guard must NOT reject it. Deferred; do not fold into the guard. (research-courant offered to take it, coordinated with dev-cfl, collision-safe.)
- **"Cycle iterations" not in preset settings** — naming mismatch, not missing: it's `mode_iteration` in the preset model (`cycle_iterations` in REST, `samplesInCycle` in kernel); `string_iteration` similarly. Both init-time (rebuild engine via /load_preset), not per-string runtime. Fix = surface/relabel in the preset-settings UI. Pending user confirmation.

## Other open items
- **Stall-resilience** (DONE, applied) — uncommitted on root `master`: `.claude/commands/{dev,orchestrator,fn}.md`, `docs/proposals/controller-role.md` (content edits; the archive→proposals move is committed in `886e739`), `docs/proposals/agent-stall-resilience-2026-05-24.md`. **User hasn't said "commit"** — hold.
- Env: ports 3000/3001 listening (pre-existing/frontend), backend 5000 down. User may revert PianoidCore to `dev` + rebuild for a working no-guard system meanwhile.
