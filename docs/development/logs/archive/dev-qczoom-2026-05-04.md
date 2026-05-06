# dev-qczoom — QC Visualization Panel zoom controls

**Started:** 2026-05-04 (orchestrator-spawned, follow-up to dev-qcfix)
**Task:** Add visible zoom-IN affordance + X-axis slider to QC chart
(`QCVisualizationPanel.jsx`).

## User report (verbatim)

> "How do I use zoom? There is reset zoom button, but no zoom in controls."

## Investigation (Phase 0)

`QCVisualizationPanel.jsx` ECharts options are built per view-mode (curves /
difference / ratio / combined) and share three module-internal consts:

- `baseGrid` — chart padding.
- `baseDataZoom` — `[inside x, inside y]` only. Wheel-zoom on X works but is
  invisible (no affordance). Y-zoom is gated on shift+wheel — also invisible.
- `baseAxisX` — time-ms axis style.

The "Reset zoom" button on line 619 is a custom MUI `IconButton` outside the
chart that calls `dispatchAction({type: 'restore'})`. There is NO ECharts
toolbox at all — hence "no zoom-in controls".

## Plan (no Step-3 pause — UX patch, not architectural)

1. Add `baseToolbox` const next to `baseGrid` / `baseDataZoom` / `baseAxisX`.
   Two features: `dataZoom` (rect-select zoom-in + back) and `restore`. Hover
   tooltips in English so users discover them. Dark-theme palette icon
   colors. Position top-right inside chart.
2. Add a `slider` dataZoom to the X axis in `baseDataZoom` so the user gets
   a visible draggable range below the chart.
3. Bump `baseGrid.bottom` to ~52 to make room for the slider; bump `top` to
   ~32 so the toolbox doesn't overlap legend or first label.
4. Wire `toolbox: baseToolbox` into all 4 view-mode option objects.
5. Keep the custom Reset Zoom IconButton (belt + suspenders — users may
   already use it, removing it is a UX regression risk).
6. Add 1 new test asserting the chart `data-option` JSON contains `toolbox`
   with `dataZoom` + `restore` features and a `slider` dataZoom on x.

## Files touched

- `PianoidTunner/src/components/QCVisualizationPanel.jsx`
- `PianoidTunner/src/components/__tests__/QCVisualizationPanel.test.jsx`

## Constraints

- 13/13 baseline tests must stay green.
- Frontend-only — no backend touch.
- MUI dark theme palette; transparent backgrounds; no emoji.
