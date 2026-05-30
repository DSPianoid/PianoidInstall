# Known Bugs

Bugs we know about but haven't fixed. Each entry captures the symptom, the investigation history, the test-coverage gap (if any) that prevented earlier fix rounds from catching the real cause, and the fix candidates already considered.

**Before opening a new investigation on a recurring problem, check here first.** Don't repeatedly burn cycles re-running the same diagnoses.

---

## Heatmap vertical-border smoothing not visible on production builds

- **Status:** OPEN
- **First reported:** 2026-05-22 (user, on secondary system after pulling round-27 changes and rebuilding)
- **Last confirmed:** 2026-05-22
- **Severity:** Cosmetic. Heatmap matrix data is correct; only the visual smoothing is asymmetric.
- **Component:** `PianoidTunner/src/components/GridHeatmapInset.jsx` — `SmoothingOverlay` overlay canvas

### Symptom

In the Modal Adapter's Project subpanel, when the user drags the heatmap smoothing slider, **horizontal borders** (between vertically-adjacent cells) blur correctly via a top-to-bottom color gradient. **Vertical borders** (between horizontally-adjacent cells) stay sharp — no visible blend.

### Reproduction

1. Open Project subpanel → trigger heatmap render (any chain with a populated grid)
2. Drag smoothing slider from 0 → 2
3. Observe: horizontal cell-cell borders blur; vertical cell-cell borders remain pixelated

### Investigation history

| Round | Commit(s) | What changed | Outcome |
|---|---|---|---|
| 24 | `93afae4` + `2808ed3` | Backend gaussian smoothing removed; client-side overlay canvas added with bilinear interpolation | Smoothed everything, but contaminated white cells (NaN propagation through bilinear sampler) |
| 26 | `e5cdeb1` / `111171b` | Replaced bilinear with pairwise border anti-aliasing (skip pairs where either neighbor is null) | User reported "border between two white cells gets colored when adjacent to two colored cells" |
| 27 | `ffae98b` / `e03de8a` | Switched `plotRect` resolution from `convertToPixel` (returns category-tick CENTERS — off by ½ cell) to `instance.getModel().getComponent('grid',0).coordinateSystem.getRect()`; added `Math.round` for pixel-boundary consistency; added pair-bounds clip; 12 new tests | jsdom-level tests pass; user confirmed white-cell contamination resolved but vertical borders still sharp on secondary system |
| 28-diag | (diagnose only) | Verified `border-h` and `border-v` paint branches in `computeBorderPaintOps` + per-pixel `fillRect` loop are structurally symmetric — line-by-line mirror with x↔y swap. Gradient color stops correct. Op-rectangle math symmetric. No detectable code-level direction bug. | Rejected "gradient direction" hypothesis. Pinned to **test-coverage gap + possible runtime-only path**. |

### Test-coverage gap (root cause of why rounds 24-27 didn't catch the real bug)

All 38 `GridHeatmapInset.test.jsx` tests are **pure-function tests** on `computeBorderPaintOps`. They verify op-rectangle metadata (bounds, non-overlap, non-intrusion into white cells, pair-extents containment, integer pixel snapping, format-detection chip metadata).

**Zero tests touch `getImageData` or `getContext("2d")` output.** jsdom's default `getContext("2d")` returns `null`; the actual per-pixel paint loop bails at `if (!ctx) return`. node-canvas isn't installed. So the per-pixel `fillRect` paint sequence at `GridHeatmapInset.jsx:728-752` has **never been exercised by automated tests**.

Bug class therefore lives in:

1. Code path not covered by op-level metadata assertions (canvas-context call semantics, DPR handling, browser-specific canvas behavior); OR
2. Runtime-only condition (e.g., CSS-vs-backing-buffer scaling mismatch only visible at specific DPR values); OR
3. Stale build on the user's secondary system despite `git pull` (CRA HMR may not have rebuilt after a multi-commit pull; production-bundle workflow may need `npm run build` re-run).

### Workaround

None currently. Heatmap data is correct (the algorithm doesn't touch the underlying matrix — per round-24 directive). User can still read the chart, just with the visual asymmetry.

### Fix candidates (any of these would close out the investigation)

1. **Install `canvas` npm package + write pixel-level Jest tests.** Make jsdom's `getContext("2d")` return a real canvas (node-canvas backend). Paint a 2×1 horizontally-adjacent red+blue pair at smoothing=2, sample pixels at the cell-cell border, assert visible red→blue gradient across the strip width. Repeat for a 1×2 vertical pair. **This will either catch the bug** (gradient absent on vertical pairs → confirms code bug, points to where) **or prove the algorithm is correct in jsdom** (narrowing the bug to a runtime-only path).
2. **Live verification via chrome-devtools MCP.** Currently unloadable in our long-running orchestrator session per the known stdio-pipe issue (CLAUDE.md "MCP server stdio fragility"). Once it reconnects (or in a fresh orchestrator session), drive a real browser, render the heatmap with smoothing>0, capture canvas via `Page.captureScreenshot`, sample pixels at the border-strip coordinates, compare against the algorithmic prediction. This is the gold-standard runtime check.
3. **User-side bundle hygiene.** Hard-refresh browser (Ctrl+Shift+R); kill+restart the CRA dev server; if using `npm run build` then re-run after the pull; verify `bundle.js` contains the text marker `computeBorderPaintOps` (proves round-27 source IS in the loaded bundle). User has been asked to try these — outcome not yet reported.

### Related code

- Algorithm: `PianoidTunner/src/components/GridHeatmapInset.jsx::computeBorderPaintOps`
- Paint loop: `PianoidTunner/src/components/GridHeatmapInset.jsx:728-752` (`SmoothingOverlay`)
- Geometry: `EChartsWithOverlay` wrapper component using `coordinateSystem.getRect()` (round 27)
- Tests: `PianoidTunner/src/components/__tests__/GridHeatmapInset.test.jsx` (38 tests, all jsdom op-metadata)

### Notes for future investigation

- The user's "horizontal" / "vertical" terminology refers to the BORDER ORIENTATION, not the pair-axis direction. A vertical border is the line between two horizontally-adjacent cells.
- If the bug turns out to be a stale build on the secondary system (option 3), this entry should be re-classified as RESOLVED with a note about the bundle-refresh procedure.
- If option 1 catches the bug in jsdom, the structural-symmetry assumption from the round-28 diagnosis was wrong — the apparent symmetry hid a real code defect.
