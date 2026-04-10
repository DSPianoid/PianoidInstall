# Interactive Stabilization Diagram — Implementation Plan

## Overview

Make the Modal Adapter's stabilization diagram fully interactive with diagram enhancements, bidirectional table sync, and manual chain editing (add/remove points, draw/connect/break/dissolve chains).

## Current State

The stabilization diagram is an ECharts scatter plot in `ModalResultsView.jsx` (lines 35-144). It shows tracked mode chains colored by stability class (stable/semi-stable/weak/spurious) with scenario on the x-axis and frequency (log) on the y-axis. Current interactivity is limited to hover tooltips and click-to-inspect (loads mode shape plot).

### Key Files

| Layer | File | Role |
|-------|------|------|
| Backend data | `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py` | `get_stabilization_data()` — returns points + chain objects |
| REST endpoint | `PianoidCore/pianoid_middleware/modal_adapter/routes.py` | `GET /modal/stabilization_diagram` |
| Frontend hook | `PianoidTunner/src/hooks/useModalAdapter.js` | `getStabilizationDiagram()` fetches data |
| Container | `PianoidTunner/src/modules/ModalAdapter.jsx` | Passes stabilizationData + handlers to results view |
| Diagram component | `PianoidTunner/src/components/ModalResultsView.jsx` | `StabilizationDiagram` — ECharts scatter |

## Architectural Decisions

**A1. Client-side editing with batch save.** Chain edits accumulate locally with undo/redo. A "Save" action commits to backend via `POST /modal/chains/save`. Rationale: edits are exploratory; immediate API calls would complicate undo and create unnecessary round-trips.

**A2. ECharts is sufficient.** Native `brush` component (rect/polygon selection), `dataZoom` (zoom/pan), and ZRender event handling cover all required interactions. The project already uses this pattern in `PerceptionCurveEditor.jsx` (lines 119-230).

**A3. Toolbar mode-switching.** Mutually exclusive interaction modes: `select` (default), `addPoint`, `drawChain`, `connectChains`, `breakChain`, `dissolve`. A toolbar component renders as a ToggleButtonGroup above the chart. Active mode determines click/drag behavior.

**A4. Snapshot-based undo/redo.** Full `editedChains` array snapshotted on each edit. Chain data is typically a few hundred objects — snapshotting is simple and reliable.

**A5. Chain save invalidates feedin.** Backend clears `_feedin_data` on save. UI shows warning and blocks apply-to-preset until feedin is re-run.

---

## Phase 1 — Diagram Interaction Enhancements

No backend changes. All work in `ModalResultsView.jsx` (to be extracted to `StabilizationDiagram.jsx`).

### 1.1 Zoom & Pan
Add `dataZoom` (inside scroll + bottom slider) to the ECharts option. Adjust grid bottom margin.

### 1.2 Brush Selection
Add ECharts `brush` component (rect/polygon/clear). Wire `brushselected` event to collect `chain_id` values from selected points and update `selectedChains` via `onSelectionChange`.

### 1.3 Chain Path Lines
Toggle (`showChainPaths`, default off). When enabled, generate a `line` series per chain connecting its detections sorted by scenario index. Thin, semi-transparent, stability-colored.

### 1.4 Bidirectional Table-Diagram Sync
Diagram click toggles chain selection in `selectedChains` (currently it only loads mode shape). Table-to-diagram already works via highlight.

### 1.5 Visual Encoding
`symbolSize` mapped from coverage (range 3-10). `opacity` mapped from damping ratio (low damping = higher opacity, more physically relevant).

### 1.6 Damping Layer Toggle
Toggle button. When enabled, add second y-axis with damping ratio scatter overlay in small grey symbols.

---

## Phase 2 — Backend Chain CRUD

### 2.1 New Method: `save_edited_chains(chains)`

**File:** `modal_adapter.py`

```python
def save_edited_chains(self, chains: List[Dict]):
    """Replace tracked chains with manually edited version."""
    self._tracked_chains = chains
    self._tracked_chains_raw = _reconstruct_chains(chains)
    self._feedin_data = None  # invalidate downstream
    self._applied = False
    # Re-assign chain_ids sequentially
    for i, c in enumerate(self._tracked_chains):
        c["chain_id"] = i
    # Persist
    self._persist("tracking", "chains.json", {
        "chains": self._tracked_chains,
        "summary": {"total": len(chains), "edited": True},
        "params": {},
    })
```

### 2.2 New Endpoint: `POST /modal/chains/save`

**File:** `routes.py`

Accepts full modified chains array, calls `save_edited_chains`, returns updated `data_status`.

---

## Phase 3 — Frontend Editing Infrastructure

### 3.1 New Hook: `useChainEditor.js`

State:
- `editedChains` — working copy (initialized from tracking data)
- `isDirty` — true if modified since last save/load
- `interactionMode` — `select | addPoint | drawChain | connectChains | breakChain | dissolve`
- `undoStack`, `redoStack` — snapshot arrays
- `drawingChain` — points being placed for new chain
- `connectSource` — first chain selected for merge

Methods:
- `initFromServer(chains)` — load chains, clear undo
- `addPointToChain(chainId, scenarioIdx, frequency, dampingRatio)`
- `removePointFromChain(chainId, scenarioIdx)`
- `createNewChain(points)` — commit from `drawingChain`
- `mergeChains(chainIdA, chainIdB)`
- `breakChainAt(chainId, scenarioIdx)`
- `dissolveInRange(freqMin, freqMax, scenarioMin?, scenarioMax?)`
- `undo()`, `redo()`
- `save()` — POST to `/modal/chains/save`
- `discard()` — reset to server state

Each mutating method pushes current state to `undoStack` and clears `redoStack`.

### 3.2 New Component: `StabilizationToolbar.jsx`

MUI ToggleButtonGroup with icons:
- Mouse pointer: Select (default)
- Plus: Add point to chain
- Pen: Draw new chain
- Link: Connect chains
- Scissors: Break chain
- Eraser: Dissolve range
- Undo / Redo buttons (disabled when stack empty)
- Save button (dirty indicator badge)
- Discard button

### 3.3 Hook Extension: `useModalAdapter.js`

Add `saveEditedChains(chains)` — POST to `/modal/chains/save`. Expose in return object.

---

## Phase 4 — Interactive Chart Editing ✓ DONE

### 4.1 Extract `StabilizationDiagram.jsx` ✓

Already extracted in Phase 1. Component now contains full editing logic.

### 4.2 Mode-Dependent Interaction Handlers ✓

ZRender-level mouse event handlers via `onChartReady` + `getZr()`. Handlers re-attach when `interactionMode` changes. Coordinate conversion via `convertFromPixel('grid', ...)`.

| Mode | Interaction | Implementation |
|------|-------------|----------------|
| **Select** | Click toggles chain selection. Brush selects region. | ECharts `click` event + `brush` component |
| **Add Point** | Click existing → remove. Click empty → add to nearest chain (5% freq tolerance). | `findExactPoint` / `findNearestChain` helpers |
| **Draw Chain** | Click places points. Dashed preview line. Double-click or toolbar button commits. | `drawingChain` transient state + scatter+line series |
| **Connect** | Click chain A (glow highlight). Click chain B → merge. | `connectSource` state + shadow styling |
| **Break** | Click a chain point → split into two chains. | `findExactPoint` → `breakChainAt` |
| **Dissolve** | Drag rect → dissolve all points in range. Red tint overlay. | ZRender mousedown/move/up + absolute-position overlay |

### 4.3 Visual Feedback ✓

- Draw mode: pink dashed line + scatter points for placed points
- Connect mode: blue glow/shadow on first selected chain
- Dissolve mode: red-tinted selection rectangle (absolute-position overlay)
- Add point / break / connect modes: crosshair/pointer cursor, hovered chain glow
- Dirty state: yellow border around diagram Paper
- Status text in toolbar showing current mode instructions

### 4.4 Integration in `ModalAdapter.jsx` ✓

`chainEditor` object passed through `ModalResultsView` → `StabilizationDiagram`. Toolbar extended with commit/cancel drawing buttons.

### 4.5 Independent Axis Zoom ✓

Both X-axis (scenarios) and Y-axis (frequency) have independent `dataZoom` sliders. Inside zoom (scroll) available in select mode only (disabled during editing to prevent conflicts).

---

## Phase 5 — Polish & Edge Cases ✓ DONE

All Phase 5 items implemented:

- **Unassigned detections:** Backend `get_stabilization_data()` computes unassigned detections from `_per_scenario_results` not in any tracked chain. Rendered as faint gray dots (opacity 0.25, size 3) in a dedicated scatter series.
- **Keyboard shortcuts:** `useEffect` keydown handler in `StabilizationDiagram`: Ctrl+Z undo, Ctrl+Y/Ctrl+Shift+Z redo, Escape cancel (drawing/connect/mode), Delete remove selected chains. Only active when diagram `visible` prop is true.
- **Validation:** `addPointToChain` rejects duplicate scenario-frequency pairs across chains. `saveChains` requires minimum 2 detections per chain. `dissolveInRange` returns `{ dissolveWarning: true }` when >50% of a chain's points removed.
- **Performance:** ECharts `large: true` + `largeThreshold: 5000` auto-applied to scatter series with >5000 points. Mousemove handler throttled to 16ms (~60fps). `drawingChain` uses `useRef` mirror to fix stale closure in rapid clicks.
- **Feedin guard:** Apply step blocked when chains are dirty (play button disabled + warning). Stale-feedin indicator shown when chains saved since last feedin. `savedSinceFeedin` flag tracked in `useChainEditor`, reset after feedin runs.
- **Delete selected chains:** Toolbar delete button + Delete key shortcut. `deleteChains(chainIds)` method in `useChainEditor`.

---

## Implementation Sequence

| Order | Phase | Scope | Dependencies |
|-------|-------|-------|-------------|
| 1 | Phase 1 | Diagram enhancements (zoom, brush, paths, sync, encoding, damping) | None |
| 2 | Phase 2 | Backend `save_edited_chains` + route | None (parallel with Phase 1) |
| 3 | Phase 3 | `useChainEditor` hook + toolbar + API method | Phase 2 |
| 4 | Phase 4 | Interactive chart editing with mode handlers | Phase 1 + Phase 3 | ✓ |
| 5 | Phase 5 | Polish, keyboard shortcuts, validation, performance | Phase 4 | ✓ |

---

## Risk Mitigation

**Chain ID stability after edits:** `apply_to_preset` uses chain IDs as indices into `mode_frequencies`. `save_edited_chains` re-indexes sequentially, and frontend remaps `selectedChains` in the save callback.

**Feedin invalidation:** `run_feedin_extraction` uses `_tracked_chains_raw` (ModeChain objects). After edits, these are rebuilt via `_reconstruct_chains` — the same path used when loading from persistence (proven to work).

**ECharts interaction conflicts:** Zoom/pan and brush/edit modes share mouse events. The toolbar ensures only one mode is active; `dataZoom` is disabled during editing modes to prevent conflicts.
