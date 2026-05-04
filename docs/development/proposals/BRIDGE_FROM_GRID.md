# Bridge-From-Grid Derivation (Deferred Proposal)

**Status:** Proposal — NOT IMPLEMENTED. The grid-layout MVP shipped in
`feature/modal-adapter-grid-layout` (dev-b9dd) deliberately stops at the
tracking visualisation step. This document captures the future plan so the
next agent / PR has a clear handoff.

---

## Background

The Modal Adapter pipeline historically assumes a **line layout** of
measurements: scenario indices laid out along a 1-D bridge, with
`pitch_offset`/`bridge_boundary` mapping `scenario_index → MIDI pitch`. The
feedin extractor (`feedin_extractor.py`) uses this 1-D mapping to compute
per-pitch coupling coefficients; the preset injector (`preset_injector.py`)
writes those per-pitch coefficients into the synthesis preset.

The grid-layout MVP added a **second layout type**: scenarios are laid out on
a 2-D rectangular grid (square spacing) with an arbitrary cell mask. The MVP
implementation:

- Lets the user define the grid (rows, cols, spacing, populated cells)
- Tracks modes via the existing layout-agnostic sliding-window method
- Visualises per-chain amplitude as a 2-D heatmap

The MVP **does not** derive per-pitch coefficients from the grid. There is no
`scenario_index → pitch` mapping for grid layout in this PR. The pipeline
terminates at the tracking step for grid projects.

This document describes how to bridge that gap in a future PR.

---

## The Goal

Allow a user with a grid measurement to produce a Pianoid synthesis preset
without manually re-running their measurement campaign as a 1-D bridge sweep.
Concretely:

1. The user has a grid project with mode chains identified across populated
   cells.
2. The user draws a **bridge curve** (1-D path) over the 2-D grid in the UI.
3. For every pitch the user wants to drive (e.g. MIDI 21 to 108), the system
   derives a feedin coefficient for each mode chain by sampling the chain's
   amplitude field along the bridge curve at the position corresponding to
   that pitch.
4. The derived per-pitch feedin matrix flows into `preset_injector` exactly
   like a line-mode feedin matrix does today.

---

## Proposed UI

A new **"Bridge Curve"** sub-panel inside the Modal Adapter, available only
for grid layout, between Tracking and Apply.

- **Canvas overlay** on top of the cell heatmap (similar to
  `GridHeatmapInset` but for the *layout* — not per-chain).
- User clicks/drags to place control points along a path.
- Path is rendered as a **polyline / cubic spline** anchored to the control
  points. Each control point has an associated **pitch label** — the pitch
  value to assign at that path-position. Intermediate pitches interpolate
  linearly along the arc length of the path.
- Optionally: a "Snap to populated cells" toggle so control points must lie
  on the centre of a populated cell.

MUI dark-theme baseline like the rest of the modal adapter UI.

---

## Proposed Backend

A new module `pianoid_middleware/modal_adapter/bridge_curve.py` that owns:

```python
@dataclass
class BridgeCurve:
    """A user-drawn 1-D path through the 2-D grid, with per-pitch anchors."""
    control_points: List[Tuple[float, float]]  # (x_mm, y_mm)
    control_point_pitches: List[int]            # MIDI pitch at each control point
    interpolation: str = "linear"               # "linear" or "cubic_spline"

    def sample_at_pitch(self, pitch: int) -> Tuple[float, float]:
        """Return (x_mm, y_mm) on the curve corresponding to a MIDI pitch.

        Interpolates between control points by arc length.
        """
        ...

    def to_dict(self) -> Dict: ...
    @classmethod
    def from_dict(cls, d: Dict) -> "BridgeCurve": ...
```

Stored on `MappingConfig` as a new optional field `bridge_curve:
Optional[BridgeCurve]`. Persists via `mapping_config.json` like every other
mapping field.

---

## Per-Pitch Coefficient Derivation

For each (chain, pitch) pair:

1. Compute target position `(x_mm, y_mm) = bridge_curve.sample_at_pitch(pitch)`.
2. Look up the chain's amplitude field on the grid: each cell has an
   amplitude (already present in `get_grid_heatmap_data`).
3. **Approximate / interpolate** the amplitude at `(x_mm, y_mm)`:
   - **Option A: nearest-cell** — pick the populated cell closest to the
     target; cheapest and probably good enough for typical 4-6 cm grids.
   - **Option B: bilinear** — interpolate from the four neighbouring cells
     when all four are populated; fall back to nearest-cell when any are
     missing (irregular cell mask).
   - **Option C: barycentric on Delaunay triangulation** — most physically
     plausible since the populated cells form an arbitrary point cloud, not
     a regular grid. Requires `scipy.spatial.Delaunay` (already in venv via
     `scipy`).

   Recommend Option C as the default; Option A as a fallback diagnostic. The
   choice should be a `MappingConfig.grid_interpolation` field, defaulting
   to `"barycentric"`.

4. The result is the per-pitch feedin coefficient for that chain. Aggregated
   across all chains and pitches, this produces a feedin matrix shaped
   identically to the line-mode `feedin_extractor` output —
   downstream `preset_injector` works unchanged.

---

## Suggested File Layout

```
PianoidCore/pianoid_middleware/modal_adapter/
├── bridge_curve.py             # NEW — BridgeCurve dataclass + sampling
├── grid_to_pitch.py            # NEW — derive_per_pitch_feedin_from_grid()
└── feedin_extractor.py         # UNCHANGED for line; new branch for grid

PianoidTunner/src/components/
├── BridgeCurveEditor.jsx       # NEW — canvas overlay on the grid
└── ...

docs/
├── development/MODE_TRACKING_GRID_LAYOUT.md   # CURRENT — extend
└── modules/pianoid-middleware/MAPPING.md      # NEW (or extend OVERVIEW)
```

---

## Out-of-Scope for This Future PR

- Cross-pitch shape constraints (e.g. neighbouring pitches must use similar
  chain weights): the MVP grid-from-curve derivation should be purely local,
  as line-mode's already is.
- 2-D visualisation of the resulting feedin matrix beyond the existing
  per-pitch curves shown in the Apply panel — the existing line-mode display
  is layout-agnostic.

---

## Why Defer?

The MVP unblocks two things on its own without the bridge curve:

1. Users with grid measurements can run **mode tracking** and **per-chain
   visualisation** — the engineering value of seeing modal patterns on a 2-D
   plate is substantial even without preset injection.
2. The data model (mapping_config + grid heatmap endpoint) is in place.
   Bridge-curve implementation is a UI + algorithm task on a stable backend
   schema, isolated from the larger data-model questions resolved in MVP.

Splitting the work this way keeps MVP small and gives the user a chance to
validate the grid mode against real measurements before committing to a
specific bridge-curve interaction model.

---

## Cross-References

- MVP implementation: `feature/modal-adapter-grid-layout` branch, dev-b9dd
  session log
- Algorithm details for grid tracking:
  [`MODE_TRACKING_GRID_LAYOUT.md`](../MODE_TRACKING_GRID_LAYOUT.md)
- Modal Adapter user guide:
  [`MODAL_ADAPTER_GUIDE.md`](../../guides/MODAL_ADAPTER_GUIDE.md)
- Pipeline architecture:
  [`MODAL_ADAPTER_REDESIGN_PLAN.md`](../MODAL_ADAPTER_REDESIGN_PLAN.md)
