# Mode Tracking — Grid Layout Algorithmic Notes

**Status:** Implemented in `feature/modal-adapter-grid-layout` (dev-b9dd, 2026-05-04).

This document describes the algorithmic deltas required to support **grid layout** in the
Modal Adapter mode-tracking pipeline. It is a sibling of
[`MODE_TRACKING_REDESIGN.md`](MODE_TRACKING_REDESIGN.md) — the redesign doc covers the
core algorithm choices (sliding-window vs sequential; cost function structure; cross-bridge
matching). This document only covers the deltas introduced by the grid layout type.

---

## Why a layout type at all?

Two physical measurement scenarios exist:

- **Line layout** (existing): scenarios are taken at successive positions along the piano
  bridge. `scenario_index` corresponds to bridge position; `pitch = scenario_index +
  pitch_offset`. The bass and treble bridges are separate physical structures, so the
  pipeline tracks them independently and matches across afterwards.

- **Grid layout** (new, MVP): scenarios are taken on a 2-D grid (square spacing) over
  some surface (e.g. a soundboard plate). The populated cells form an arbitrary shape
  inside a rectangular bounding box. `scenario_index` is just an opaque cell ID — there
  is **no 1-D ordering** and **no scenario_index → pitch mapping** in this PR (see
  [`BRIDGE_FROM_GRID.md`](proposals/BRIDGE_FROM_GRID.md) for the future plan).

The line-mode pipeline assumed a 1-D ordering at multiple points; we surveyed the
codebase and wrapped each assumption with a layout guard.

---

## Source of Truth

All layout state lives on `MappingConfig` (see `pianoid_middleware/modal_adapter/mapping.py`):

| Field | Type | Line layout | Grid layout |
|-------|------|-------------|-------------|
| `layout_type` | `Literal["line", "grid"]` | `"line"` (default) | `"grid"` |
| `bridge_boundary` | `int` | scenario index dividing bass/treble | ignored |
| `pitch_offset` | `int` | pitch = scenario + offset | ignored |
| `excitation_to_pitch` | `Dict[int, int]` | scenario → pitch | empty |
| `grid_shape` | `Optional[Tuple[int, int]]` | None | `(n_rows, n_cols)` |
| `grid_spacing_mm` | `Optional[float]` | None | square spacing dx = dy |
| `cell_mask` | `Optional[List[List[bool]]]` | None | `cell_mask[r][c]` is True iff populated |
| `point_coordinates` | `Optional[Dict[int, Tuple[float, float]]]` | None | `scenario_index → (x_mm, y_mm)` |

**Invariants:**
- `cell_mask.sum()` MUST equal `len(point_coordinates)`.
- `scenario_index` for grid layout is assigned in row-major order across populated cells
  by the UI editor. Backend never re-orders — it relies on the convention.
- Coordinates are millimetres, anchored at top-left cell `(0, 0) → (0, 0)`.

Persistence: `mapping_config.json` (single file per project). Pre-grid mapping JSONs load
as `layout_type="line"` with all grid fields `None` — the loader is backward compatible.

---

## Tracking Algorithm Branch

`TrackingConfig` has a `layout_type: str = "line"` field (default preserves backward
compat).

| `tracking_method` × `layout_type` | Behaviour |
|---|---|
| `sliding_window` × `line` | Pre-existing path: cluster all detections by frequency window + MAC; label chains `bass`/`treble`/`full` by scenario presence. |
| `sliding_window` × `grid` | Same clustering, but skip bridge labelling. Every chain gets `bridge="grid"`. No cross-bridge match (concept doesn't exist). |
| `sequential` × `line` | Pre-existing path: per-bridge Hungarian assignment + cross-bridge matching. Uses `extrapolate_frequency` for trend-aware cost. |
| `sequential` × `grid` | **Forbidden — raises `NotImplementedError`.** The sequential method depends on a 1-D ordering: cost function uses scenario-index trends, gap-counter is in scenario-index units. None of those make sense on a 2-D grid. The dispatcher (`track_modes_along_bridge`) raises early with a clear message; users / API callers get a 4xx response.

**Rationale for sliding-window-only on grid:** the sliding-window algorithm sorts
detections by frequency globally and clusters by frequency proximity + MAC similarity.
It never references `scenario_index` order. It is layout-agnostic by construction. The
only line-specific code is the post-tracking bridge labelling, which is trivially
guarded.

A future PR could implement a sequential-on-grid variant via BFS over a KD-tree
neighbour graph (Euclidean distance instead of `scenario_index − prev_index`), but the
MVP user spec deferred this work — sliding-window on grid is sufficient for the visualisation goals.

---

## Helper Functions — Layout Awareness

### `ModeChain.extrapolate_frequency(target_scenario, ..., layout_type="line")`

Line: weighted linear regression on the last K detections, predicts frequency at
`target_scenario`. Used by the sequential method's cost function.

Grid: returns `_last_freq` unconditionally. The (scenario_index, frequency) pairs are
not on a 1-D axis, so a regression over them is meaningless.

Backward-compatible default: `layout_type="line"` so existing call sites in the codebase
work unchanged.

### `_merge_split_chains(chains, config, total_scenarios)`

Line: merges two chains into one when they have similar frequencies, non-overlapping
scenario coverage (one ends before the other starts), and similar reference shapes.
This handles cases where a long mode is broken across a measurement gap.

Grid: returns chains as-is. The "one ends before the other starts" test compares
scenario indices as if they were 1-D positions; on a 2-D grid that comparison has no
physical meaning. The sliding-window method already produces non-overlapping clusters by
construction, so skipping the merge step is safe.

### `_run_tracking_sliding_window(...)`

Line: labels chains by bass/treble presence; reports `full_chains`, `bass_chains`,
`treble_chains` in the summary.

Grid: every chain gets `bridge="grid"`; `full_chains`, `bass_chains`, `treble_chains`
are all empty in the summary; `cross_bridge_matches` is always `0`. Logging line
distinguishes the two cases.

---

## REST API Additions

### `POST /modal/mapping` — extended

The existing endpoint accepts new optional fields:

```json
{
  "excitation_to_pitch": {},
  "channel_to_sound": {},
  "skipped_channels": [],
  "channel_roles": {"0": "response", "1": "response"},
  "bridge_boundary": 28,
  "pitch_offset": 21,
  "layout_type": "grid",
  "grid_shape": [4, 4],
  "grid_spacing_mm": 10.0,
  "cell_mask": [[true, true, true, false], [true, true, true, true], ...],
  "point_coordinates": {"0": [0.0, 0.0], "1": [10.0, 0.0], ...}
}
```

When `layout_type` is omitted or `"line"`, the four `grid_*` / `cell_mask` /
`point_coordinates` fields can be omitted; the payload is bit-identical to the pre-grid
contract.

### `GET /modal/grid_heatmap/<chain_id>` — new

Returns per-cell amplitude data for a tracked chain in grid layout. Used by the
`GridHeatmapInset` visualisation component.

```json
{
  "chain_id": 5,
  "frequency": 245.3,
  "stability": "stable",
  "grid_shape": [4, 4],
  "grid_spacing_mm": 10.0,
  "cells": [
    {"row": 0, "col": 0, "scenario_index": 0, "x_mm": 0.0, "y_mm": 0.0, "amplitude": 0.42},
    {"row": 0, "col": 1, "scenario_index": 1, "x_mm": 10.0, "y_mm": 0.0, "amplitude": 0.78},
    ...
    {"row": 2, "col": 1, "scenario_index": 7, "x_mm": 10.0, "y_mm": 20.0, "amplitude": null}
  ]
}
```

`amplitude: null` means the chain had no detection at that cell (transparent /
"missing" cell in the heatmap).

Errors:
- `400` if no tracked chains, no grid layout, or chain_id out of range.
- `500` if mapping is structurally inconsistent (cell count vs point_coordinates count).

---

## Frontend Components

| Component | Role |
|-----------|------|
| `GridLayoutEditor.jsx` (new) | Table-based grid editor — set rows/cols/spacing, click cells to toggle on/off, bulk shape buttons (All On / All Off / Invert). Auto-assigns scenario indices in row-major order over populated cells. |
| `GridHeatmapInset.jsx` (new) | Per-chain 2-D heatmap rendered above the stabilization diagram when grid layout is active and a chain is selected. Uses ECharts heatmap series; transparent for missing cells. |
| `MappingEditor.jsx` (existing) | Bridge boundary + pitch offset fields are auto-disabled when `layout_type === "grid"` — visually communicates that those fields are line-specific. |
| `StabilizationDiagram.jsx` (existing, extended) | Accepts `layoutType` and `getGridHeatmap` props. In grid mode: x-axis labelled "Grid point index" (was "Scenario"); bridge-boundary markline hidden; renders `GridHeatmapInset` above the chart. |
| `ModalAdapter.jsx` (existing, extended) | Adds the LINE/GRID layout selector at the top of the Setup section. Switching to GRID auto-initializes a 4×4 fully-populated grid with 10mm spacing as the default. |

State ownership stays canonical: backend's `MappingConfig` is the single source of
truth. Frontend `useModalAdapter.js` holds layout fields as **mirror state** filled by
`syncFromBackend` and committed back via `submitChannelMapping` (extended to include
the layout payload). User edits are staged via `mappingDirty`; nothing round-trips
until "Save Mapping" is clicked.

---

## Backward Compatibility

- Existing line-mode projects (no `layout_type` in `mapping_config.json`) load as
  `layout_type="line"` with all grid fields `None`. Validation, tracking, feedin
  extraction, and preset injection all behave identically to pre-grid.
- All pre-existing unit tests (183 cases in the modal-adapter suite as of dev-b9dd
  branch start) pass unchanged on the new code.

---

## Out of Scope (future work)

| Item | Status | Tracking |
|------|--------|----------|
| Grid → pitch mapping (any scheme) | Not in MVP | [`BRIDGE_FROM_GRID.md`](proposals/BRIDGE_FROM_GRID.md) |
| Bridge-curve drawing UI | Not in MVP | same |
| Per-pitch coefficient derivation from grid amplitudes | Not in MVP | same |
| `feedin_extractor.py` 2-D extension | Not in MVP | same |
| `preset_injector` grid-aware mode | Not in MVP | same |
| Sequential tracking method on grid | Not in MVP | needs BFS over KD-tree neighbour graph; future PR |

---

## Test Coverage

`PianoidCore/tests/unit/`:

- `test_mapping_grid_roundtrip.py` (17 cases) — defaults, validation, JSON round-trip.
- `test_modal_adapter_grid_layout.py` (15 cases) — sliding-window recovery on synthetic
  2-D plate; sequential-method rejection; layout-aware helpers
  (`extrapolate_frequency`, `_merge_split_chains`); `get_grid_heatmap_data` shape and
  edge cases.

`PianoidTunner/src/components/__tests__/`:

- `GridLayoutEditor.test.jsx` (5 cases) — render, hint text, bulk buttons, disabled
  prop.
- `GridHeatmapInset.test.jsx` (3 cases) — empty state, fetch + render, fetch failure.

All tests pass at MVP merge: backend 215/216 (one pre-existing failure unrelated to
grid layout); frontend 18/18.
