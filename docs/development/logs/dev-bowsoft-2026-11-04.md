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
