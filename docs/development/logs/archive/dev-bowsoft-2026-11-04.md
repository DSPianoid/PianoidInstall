# Dev Session Log

- **Agent:** bowsoft (dev-bowsoft)
- **Task:** Softer bow (user, Telegram): wider contact, more receding edges than dev-bow3
- **Status:** Implemented on feature/dev-bowsoft (Core + Install), NOT merged / pushed; awaiting the user's listening

## Actions
- Docs-first: SYNTHESIS_ENGINE "Friction bow", dev-bow3 log. The width cap (16) and the parabola were hardcoded
  in BowFriction.cuh, so params alone were not enough.
- CPU screen (engine-stencil golden, profile (1 - x^2)^p): ribbon x2 p1, x2.5 p2, x3 p3 stay at ~1 slip/period
  on C2-C4; x3 p2 slips twice on C2.
- Core: BOW_MAX_WIDTH 16 -> 32, BOW_CTRL_TAPER, weights (1 - x^2)^p once per launch (p = 1 exact parabola),
  BowController::setEdgeTaper, Pianoid::setBowEdgeTaper, getBowStatus[4]; middleware bow_settings.edge_taper
  (stored, pushed, undo snapshot, param rule 0.5..8). Unit: test_bow_config + test_midi_controllers 66 pass.
- [BUILD OK] isolated: pip --target D:\repos\wt-bowsoft-core\isobuild\{release,debug} (shared venv untouched).
  ptxas addKernel release 124-126 / debug 121-124 registers, 0 spill, smem 20332 B.
- [REGRESSION-CHECK] cycle timing N=3: no bow 0.457-0.462 vs 0.456-0.460 ms before; default bowed +1 %;
  soft3 0.581-0.584; widest (32 points) 0.646-0.657 (49 % of budget). verdict=pass
- Renders (dev-bowsoft-render.py, silent offline): see SYNTHESIS_ENGINE "dev-bowsoft". Bowed renders are not
  sample-deterministic run to run (bow3-setting old vs new build compared by level / metrics: within scatter).

## Merge + soft3 default — 2026-11-05 (agent mergesoft; user approved "merge it and make this the default")
- soft3 made the default: bow_config DEFAULT_MAX_WIDTH 0.035 -> 0.105, DEFAULT_EDGE_TAPER 1 -> 3, mirrored in BowController.h (Core 7b9452d); docs SYNTHESIS_ENGINE / REST_API (Install 5ca1ff5). No preset in pianoid_middleware/presets stores model_parameters.bow, so every preset gets the new default; none edited.
- Merged --no-ff onto post-gpufit dev: Core dev f80042f, Install master 484a90d. No conflicts (AddArraysWithCUDA.cpp auto-merged).
- HEAVY --both: ptxas addKernel release 124-126 / debug 121-124 registers, 0 spill, smem 20332 B; setBowEdgeTaper in both .pyd; L1 both OK.
- Silent backend :5012: GET /get_parameter/bow_settings/all -> max_width 0.105, edge_taper 3.0 (defaults 0.105 / 3.0), engine_supported.
- Offline bowed C2 (BaselinePreset1, default tilt 0.3, velocity 90, no setting touched): engine status width 0.105 / taper 3, 22 contact points, noise between partials -26.1 dB, centroid 1083 Hz; explicit soft3 -25.9 dB / 1082 Hz (same); explicit bow3 7 points, -17.0 dB / 1123 Hz.
- Note: the soft3 listening renders used tilt 0.15 on C2-C4; the per-pitch default tilt (0.3 up to G3) is unchanged.
- Worktrees wt-bowsoft-{core,install} + isobuild removed. NOT pushed.
[STEP-10A-PHASE-2] 2026-11-05
