# Mode Tracking Algorithm Redesign

**Status:** Design document (not yet implemented)
**Date:** 2026-04-14

---

## 1. Problem Statement

Mode tracking assigns ESPRIT-detected resonance modes at each measurement scenario (bridge position) into continuous chains that represent the same physical mode evolving along the piano bridge. The current algorithm in `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py` (`track_modes_along_bridge()`, lines 107-220) has several deficiencies:

1. **Greedy frequency-only matching.** Candidates are sorted by relative frequency distance and assigned first-come-first-served (lines 154-175). This produces locally acceptable matches but globally suboptimal assignments — a slightly closer spurious mode can steal a chain from its true continuation, cascading errors downstream.

2. **No mode shape information used.** The `ModeDetection` dataclass carries `shape_magnitudes` and `mode_shape` fields (line 21-28), but `track_modes_along_bridge()` receives only bare frequency lists (`Dict[int, List[float]]`), discarding all shape data. Shape information is only attached post-hoc via fragile `round(f, 2)` keyed lookups in `EspritRunner._track_bridge()` (lines 480-516).

3. **No trend awareness.** Matching uses only the last observed frequency (`chain._last_freq`), with no consideration of the frequency trend along the bridge. A mode drifting steadily upward will match poorly against a flat tolerance window centered on the last point.

4. **Fragile `round(f, 2)` keying.** `EspritRunner.run_tracking()` builds lookup dicts keyed by `round(f, 2)` (lines 323-384) to reconnect damping, amplitude, and mode shapes to chain detections after tracking. Two distinct modes at 440.004 Hz and 440.006 Hz both round to 440.01, causing incorrect data attachment. This pattern also appears in `ModalAdapter._enrich_chains_from_esprit()` (lines 984-992) and `get_stabilization_data()` (line 2295, 2309).

5. **No scenario gap awareness.** The algorithm assumes scenario indices are contiguous. Gaps in numbering (missing measurements) are treated identically to consecutive scenarios, applying the same `freq_tol_pct` regardless of how many physical positions were skipped.

6. **Two-bridge structure underutilized.** `EspritRunner.run_tracking()` splits scenarios at `bridge_boundary` (line 392-396) and tracks independently, but there is no cross-bridge chain matching to identify the same physical mode appearing on both bridges.

7. **No splitter mode detection.** When ESPRIT over-estimates model order, a single physical mode can appear as two closely-spaced modes. The current algorithm silently tracks both as separate chains with no diagnostic output.

---

## 2. Physical Model

### What modes are

Each soundboard resonance mode is a standing wave pattern with a characteristic frequency, damping ratio, and deflection shape. The deflection shape describes how each point on the soundboard moves when that mode is excited — some points are nodes (zero motion), others are antinodes (maximum motion).

### How modes behave along the bridge

The bridge is a narrow strip where strings contact the soundboard. When we measure impulse responses at successive positions along the bridge (one per scenario), each mode appears at a slightly different frequency and with a slightly different local deflection pattern. The key physical properties:

- **Frequency continuity**: A mode's frequency changes smoothly along the bridge. Low modes (< 200 Hz) are nearly constant. Higher modes can drift by 5-10% across the full bridge span. The drift is monotonic or slowly varying — no discontinuous jumps between adjacent measurement points.

- **Mode shape continuity**: The deflection pattern at the 5 accelerometer positions evolves smoothly between adjacent scenarios. The shape vector rotates gradually — adjacent scenarios should have high MAC (> 0.9 for well-resolved modes, > 0.7 for closely-spaced modes).

- **Mode density increases with frequency**: Below 200 Hz, modes are well-separated. Above 500 Hz, modes crowd together, making frequency alone insufficient for disambiguation. This is precisely where MAC adds value — even closely-spaced modes have distinct spatial patterns.

- **Frequency crossings**: Two modes can have their frequencies converge, cross, and diverge as they traverse the bridge. At the crossing point, frequency proximity is ambiguous but mode shapes remain distinct (the modes are orthogonal). This is the critical case where MAC-based verification prevents chain swaps.

### Two-bridge structure

The piano has two physically separate bridges:

- **Bass bridge**: scenarios with index <= `bridge_boundary` (default 28, corresponding to MIDI pitch 49 / C#3 via `pitch_offset=21`)
- **Treble bridge**: scenarios with index > `bridge_boundary`

These are distinct wooden structures with no physical continuity. A mode on the bass bridge has no obligation to continue smoothly onto the treble bridge. However, the same physical soundboard mode will typically appear on both bridges at similar frequencies. Cross-bridge matching is a separate post-processing step that pairs chains by frequency and shape similarity, not spatial continuity.

### Gaps in scenario numbering

Not all scenarios may be measured. Gaps in the scenario index sequence indicate skipped measurement positions. When there is a gap of N scenarios, the expected frequency drift and shape drift should be scaled proportionally — the same smoothness applies per unit bridge distance, not per scenario count.

---

## 3. Available Data

### Per-scenario ESPRIT output

After `merge_multiband_results()`, each scenario produces a dict stored in `_per_scenario_results[sc_idx]`:

| Field | Type | Description | Currently used in tracking? |
|-------|------|-------------|---------------------------|
| `frequencies` | `np.ndarray` (N,) | Mode frequencies in Hz | Yes (converted to `List[float]`) |
| `damping_ratios` | `np.ndarray` (N,) | Damping ratios (dimensionless) | No (post-hoc via `round(f,2)` lookup) |
| `n_raw` | `int` | Raw mode count before merging | No |
| `n_merged` | `int` | Mode count after merging | No |
| `mode_shapes` | `np.ndarray` (N, C) complex128 | Complex mode shape vectors (C = number of response channels, typically 5) | No (post-hoc via `round(f,2)` lookup) |

The `mode_shapes` array is the richest data available. Each row is a complex vector of length C (number of response channels). The magnitude gives the relative motion amplitude at each accelerometer; the phase gives the relative timing. MAC is computed from these vectors.

### ModeDetection dataclass (current)

```python
@dataclass
class ModeDetection:
    scenario_index: int
    frequency: float
    damping_ratio: Optional[float] = None
    amplitude: Optional[float] = None
    shape_magnitudes: Optional[List[float]] = None
    mode_shape: Optional[np.ndarray] = None  # complex (n_channels,)
```

All fields except `scenario_index` and `frequency` are populated post-hoc, not during tracking.

### ModeChain dataclass (current)

```python
@dataclass
class ModeChain:
    chain_id: int
    detections: Dict[int, ModeDetection]  # keyed by scenario_index
    frequency_mean: float
    frequency_range: Tuple[float, float]
    frequency_drift: float
    damping_mean: float
    detection_count: int
    coverage: float
    stability: str  # "stable" / "semi-stable" / "weak" / "spurious"
    _gap_counter: int
    _closed: bool
    _last_freq: float
```

Internal tracking state is minimal: only `_last_freq` and `_gap_counter`. No trend state, no reference shape.

### Existing MAC infrastructure

`band_merging.py` provides:

- `compute_mac(shape1, shape2) -> float` (line 52-59) — standard MAC formula, handles complex vectors, returns 0.0-1.0
- `_modes_match(m1, m2, freq_tol_pct, mac_threshold, ...) -> (bool, Optional[float])` (line 63-90) — combined frequency + MAC check with damping fallback

Both are directly reusable in the tracking algorithm.

---

## 4. Algorithm Design

### 4.1 Pre-processing

#### Input format change

The tracking function receives full `ModeDetection` objects instead of bare frequencies. This eliminates post-hoc `round(f, 2)` enrichment entirely.

```python
def track_modes_along_bridge(
    per_scenario_detections: Dict[int, List[ModeDetection]],
    scenario_order: Optional[List[int]] = None,
    config: TrackingConfig = TrackingConfig(),
) -> TrackingResult:
```

The caller (`EspritRunner._track_bridge()`) constructs `ModeDetection` objects directly from ESPRIT output, attaching frequency, damping, amplitude, and mode_shape at creation time — not post-hoc.

#### Bridge partitioning

`EspritRunner.run_tracking()` reads `bridge_boundary` from `MappingConfig.bridge_boundary` (stored in mapping metadata, default 28). Scenarios are split:

```python
bass_detections = {s: dets for s, dets in per_scenario_detections.items()
                   if s <= bridge_boundary}
treble_detections = {s: dets for s, dets in per_scenario_detections.items()
                     if s > bridge_boundary}
```

Each bridge is tracked independently, then cross-bridge matching runs in post-processing.

#### Scenario gap detection

Compute the gap between consecutive scenario indices in the ordered list. Where gaps exceed 1, the algorithm relaxes continuity expectations proportionally:

```python
scenario_order = sorted(per_scenario_detections.keys())
for i in range(1, len(scenario_order)):
    step_size = scenario_order[i] - scenario_order[i - 1]
    # step_size > 1 indicates a measurement gap
    # frequency/shape drift tolerances scale by step_size
```

### 4.2 Matching Criteria

#### Cost function

For each (chain, candidate detection) pair, compute a total cost:

```
cost(chain, det) = w_f * C_freq(chain, det)
                 + w_s * C_shape(chain, det)
                 + hard_reject(chain, det)
```

Where `hard_reject` returns +infinity if any hard cutoff is violated, making the pair unmatchable.

#### Primary: Frequency (range gate + trend continuity)

Two sub-criteria, both required:

**Range gate** — the candidate frequency must fall within the chain's overall frequency envelope, extended by a tolerance:

```python
f_lo = chain.frequency_range[0] * (1 - freq_envelope_margin)
f_hi = chain.frequency_range[1] * (1 + freq_envelope_margin)
if not (f_lo <= det.frequency <= f_hi):
    return INFINITY  # hard reject
```

Default `freq_envelope_margin = 0.05` (5% beyond observed range). This prevents a chain from suddenly jumping to a completely different frequency region.

**Trend-aware continuity** — extrapolate the chain's recent frequency trend and compute deviation:

```python
# Linear trend from last K detections (K=3 when available, fewer at chain start)
f_predicted = chain.extrapolate_frequency(det.scenario_index)
f_deviation = abs(det.frequency - f_predicted) / max(det.frequency, 1.0)

# Scale tolerance by scenario step size (relax for gaps)
step_size = det.scenario_index - chain.last_scenario_index
effective_tol = freq_tol_pct * step_size

C_freq = (f_deviation / effective_tol) ** 2  # quadratic penalty
```

The extrapolation uses weighted linear regression on the last K detected frequencies (weighted toward recent), predicting the frequency at the candidate scenario index. For chains with only 1 detection, `f_predicted = chain._last_freq` (degenerates to current behavior).

Mathematically, the trend model for a chain with recent detections at scenarios `[s_1, ..., s_K]` with frequencies `[f_1, ..., f_K]`:

```
f_predicted(s) = a * s + b
where (a, b) = weighted_least_squares(s_i, f_i, weights=exp(-lambda * (s_K - s_i)))
```

With `lambda = 0.3` providing exponential recency weighting.

Default parameters: `freq_tol_pct = 0.02` (2% per scenario step), `trend_window = 3`.

#### Secondary: MAC verification

When both the chain's reference shape and the candidate's mode shape are available:

```python
mac_val = compute_mac(chain.reference_shape, det.mode_shape)
if mac_val < mac_reject_threshold:
    return INFINITY  # hard reject — orthogonal shapes
C_mac = 1.0 - mac_val  # 0 for identical, 1 for orthogonal
```

MAC serves two roles:
- **Hard rejection** (`mac_reject_threshold = 0.3`): shapes that are clearly orthogonal cannot be the same mode, regardless of frequency proximity. This prevents chain swaps at frequency crossings.
- **Soft penalty** in the cost function: higher MAC reduces cost, helping disambiguate close-frequency candidates.

When mode shapes are unavailable (e.g., loaded from old project data without `.npy` files), the MAC terms are zeroed and matching relies on frequency alone.

The chain's **reference shape** is a running estimate, updated as detections are added:

```python
# Exponential moving average of (rotated) complex mode shapes
chain.reference_shape = alpha * det.mode_shape_rotated + (1 - alpha) * chain.reference_shape
```

With `alpha = 0.3`, balancing responsiveness to gradual shape evolution against noise resilience.

#### Tertiary: Mode shape drift rate

The physical deflection shape evolves smoothly along the bridge. Rapid shape changes between adjacent scenarios suggest a tracking error or a mode that is poorly resolved.

```python
if chain.last_detection.mode_shape is not None and det.mode_shape is not None:
    shape_mac = compute_mac(chain.last_detection.mode_shape, det.mode_shape)
    drift_rate = (1.0 - shape_mac) / step_size

    # Relax tolerance with frequency — higher modes have denser, more rapidly
    # varying shapes, so shape drift is naturally larger
    freq_ref = max(chain._last_freq, 50.0)  # floor at 50 Hz
    freq_scale = 1.0 + shape_drift_freq_relax * (freq_ref - 50.0) / 950.0
    # At 50 Hz: scale = 1.0 (strictest). At 1000 Hz: scale = 1 + relax.
    effective_max_drift = max_shape_drift_rate * freq_scale

    C_shape = drift_rate / effective_max_drift  # normalized, clipped to [0, 1]
```

Default `max_shape_drift_rate = 0.15` per scenario step (at the lowest frequencies). Default `shape_drift_freq_relax = 2.0` — at 1000 Hz the effective tolerance is 3x the base rate (0.45), making shape drift a soft criterion for higher modes while remaining meaningful for lower modes where shapes are more distinctive and stable.

#### Combined cost formula

```
cost = w_freq * C_freq + w_mac * C_mac + w_shape * C_shape_drift
```

Default weights: `w_freq = 1.0`, `w_mac = 0.5`, `w_shape = 0.3`.

These are normalized so that a "perfect" match (zero frequency deviation, MAC = 1.0, zero shape drift) has cost 0.0, and the maximum acceptable match has cost near 1.0. Costs above `max_cost = 2.0` result in no assignment (the detection starts a new chain).

#### Hard cutoffs summary

| Cutoff | Condition | Effect |
|--------|-----------|--------|
| Frequency envelope | `det.frequency` outside `[f_lo, f_hi]` | Infinite cost |
| MAC rejection | `mac_val < 0.3` | Infinite cost |
| Maximum cost | `cost > 2.0` | Not assigned (starts new chain) |

### 4.3 Assignment

#### Hungarian algorithm

Replace greedy matching with globally optimal bipartite assignment using `scipy.optimize.linear_sum_assignment`:

```python
from scipy.optimize import linear_sum_assignment

# For each scenario step:
n_chains = len(active_chains)
n_dets = len(detections)

# Build cost matrix: rows = chains, cols = detections
# Pad to square if needed (scipy requires it for unbalanced problems — or
# use rectangular support in scipy >= 1.4)
cost_matrix = np.full((n_chains, n_dets), fill_value=NO_ASSIGN_COST)

for i, chain in enumerate(active_chains):
    for j, det in enumerate(detections):
        cost_matrix[i, j] = compute_cost(chain, det, step_size)

row_ind, col_ind = linear_sum_assignment(cost_matrix)

# Filter assignments where cost exceeds max_cost
for r, c in zip(row_ind, col_ind):
    if cost_matrix[r, c] < max_cost:
        active_chains[r].add_detection(detections[c])
    # else: both chain and detection remain unmatched
```

`NO_ASSIGN_COST` is set to `max_cost + 1.0` so that the Hungarian algorithm can "assign" a chain to a dummy column (or vice versa) at a known high cost, effectively leaving it unmatched. Alternatively, use a rectangular formulation where unmatched rows/columns are identified by exclusion from the assignment.

**Complexity**: O(max(M, N)^3) per scenario step, where M = active chains, N = detections. With typical values of M ~ 50-200 and N ~ 20-80, this is sub-millisecond per step. Total tracking across ~80 scenarios: well under 1 second.

#### Handling unmatched entities

- **Unmatched detections** (columns not in assignment, or assigned at cost >= `max_cost`): start new chains.
- **Unmatched chains** (rows not in assignment, or assigned at cost >= `max_cost`): increment gap counter. If gap exceeds `max_gap` (scaled by step size), close the chain.

### 4.4 Chain Management

#### Chain initialization

When a detection is unmatched, a new chain is created:

```python
chain = ModeChain(chain_id=next_id)
chain.add_detection(det)
chain.reference_shape = det.mode_shape  # initial reference
chain._trend_freqs = [(det.scenario_index, det.frequency)]
```

#### Gap handling

Gap counter increments by `step_size` (not 1) when a scenario is processed without a match:

```python
chain._gap_counter += step_size
if chain._gap_counter > max_gap:
    chain.close()
```

Default `max_gap = 5` (in scenario-index units, not step counts). This allows a mode to disappear for up to 5 scenario positions before the chain closes.

#### Reference state maintenance

Each active chain maintains:

| State | Type | Updated on | Purpose |
|-------|------|-----------|---------|
| `_last_freq` | `float` | Each detection | Quick reference for gap checking |
| `_last_scenario_index` | `int` | Each detection | Step size calculation |
| `_trend_freqs` | `List[Tuple[int, float]]` | Each detection (keep last K) | Frequency trend extrapolation |
| `reference_shape` | `np.ndarray` complex | Each detection (EMA) | MAC computation for next step |
| `_gap_counter` | `int` | Each scenario step | Gap-based closure |

#### Chain closure

A chain is closed (moved from active to finished) when:
- `_gap_counter > max_gap`, or
- The algorithm has processed all scenarios

On closure, `finalize()` computes summary statistics (mean frequency, range, drift, damping mean, coverage, stability class).

#### Chain merging for split chains

After all scenarios are processed, `_merge_split_chains()` (existing, lines 223-296) runs with enhanced criteria:

- Frequency proximity (existing)
- Non-overlapping scenario ranges (existing)
- **New: MAC between reference shapes** — if both chain segments have reference shapes, require `MAC > 0.5` for merge. This prevents merging chains that happen to have similar frequencies but are actually different modes.

### 4.5 Post-processing

#### Cross-bridge chain matching

After tracking each bridge independently, match chains across bridges to identify the same physical mode:

```python
def match_chains_cross_bridge(
    bass_chains: List[ModeChain],
    treble_chains: List[ModeChain],
    freq_tol_pct: float = 0.03,
    mac_threshold: float = 0.5,
) -> List[Tuple[int, int, float, Optional[float]]]:
    """
    Returns list of (bass_chain_id, treble_chain_id, freq_diff_pct, mac_value)
    for matched pairs.
    """
```

Matching criteria:
- Frequency proximity: `|f_bass_mean - f_treble_mean| / f_bass_mean < freq_tol_pct`
- MAC between reference shapes (when available): `MAC > mac_threshold`
- One-to-one assignment via Hungarian algorithm on the cross-bridge cost matrix

Cross-bridge matches are stored as metadata on the chains (`chain.cross_bridge_match = other_chain_id`) but do not merge the chains — they remain independent for feedin extraction purposes. The match information is used downstream for preset building (same mode → same mode index on both bridges).

#### Coverage filtering

Chains with coverage below 50% of their bridge's scenarios are reclassified:

```python
bridge_scenario_count = len(scenarios_on_this_bridge)
for chain in chains:
    chain.coverage = chain.detection_count / bridge_scenario_count
    if chain.coverage < 0.50:
        chain.stability = "weak" if chain.coverage >= 0.25 else "spurious"
```

Only chains with `stability in ("stable", "semi-stable")` pass to feedin extraction by default. The unassigned pool (detections not in any chain + detections in rejected chains) is available for diagnostic visualization.

Current stability thresholds:
- `stable`: coverage >= 50%
- `semi-stable`: coverage >= 25%
- `weak`: coverage >= 10%
- `spurious`: coverage < 10%

These thresholds remain unchanged. The 50% coverage requirement means only `stable` chains pass by default; `semi-stable` chains can be included via configuration.

#### Splitter mode detection

After tracking, scan all chain pairs within each bridge for potential splitter modes:

```python
def detect_splitter_modes(
    chains: List[ModeChain],
    freq_tol_pct: float = 0.02,
    mac_threshold: float = 0.7,
) -> List[SplitterReport]:
    """
    Two chains are flagged as potential splitters when:
    1. |f_mean_1 - f_mean_2| / f_mean_1 < freq_tol_pct
    2. MAC(ref_shape_1, ref_shape_2) > mac_threshold (similar shapes)
    3. Both have overlapping scenario coverage (they coexist at the same bridge positions)
    """
```

Output:

```python
@dataclass
class SplitterReport:
    chain_id_a: int
    chain_id_b: int
    frequency_a: float
    frequency_b: float
    mac_value: float
    overlap_scenarios: int
    recommendation: str  # "merge" / "reduce_model_order" / "investigate"
```

Diagnostic aggregation:
- If > 3 splitter pairs in a 50 Hz frequency band, recommend reducing ESPRIT model order for that band
- Store splitter reports in tracking output for frontend display
- This creates a feedback loop: tracking results → ESPRIT configuration adjustments → re-run

#### Chain quality classification

Beyond coverage-based stability, add quality metrics:

```python
@dataclass
class ChainQuality:
    coverage: float              # fraction of bridge scenarios covered
    frequency_smoothness: float  # R^2 of linear fit to frequency trend
    shape_consistency: float     # mean pairwise MAC between adjacent detections
    damping_stability: float     # 1 - (std(damping) / mean(damping))
    overall_score: float         # weighted combination
```

This informs the `max_modes` filtering in `PresetConfig` — when selecting the top N chains, prefer high-quality chains over merely high-coverage ones.

---

## 5. Interface Changes

### New/modified dataclasses

#### `ModeDetection` (modified)

No structural change — all fields already exist. The change is that all fields are populated at construction time, not post-hoc.

#### `ModeChain` (modified)

```python
@dataclass
class ModeChain:
    chain_id: int
    detections: Dict[int, ModeDetection] = field(default_factory=dict)
    # Summary statistics (computed by finalize())
    frequency_mean: float = 0.0
    frequency_range: Tuple[float, float] = (0.0, 0.0)
    frequency_drift: float = 0.0
    damping_mean: float = 0.0
    detection_count: int = 0
    coverage: float = 0.0
    stability: str = "spurious"
    quality: Optional[ChainQuality] = None

    # Cross-bridge matching
    cross_bridge_match: Optional[int] = None  # chain_id on the other bridge
    bridge: str = ""  # "bass" or "treble"

    # Internal tracking state
    _gap_counter: int = field(default=0, repr=False)
    _closed: bool = field(default=False, repr=False)
    _last_freq: float = field(default=0.0, repr=False)
    _last_scenario_index: int = field(default=0, repr=False)
    _trend_freqs: List[Tuple[int, float]] = field(default_factory=list, repr=False)
    _reference_shape: Optional[np.ndarray] = field(default=None, repr=False)
```

New internal state: `_last_scenario_index`, `_trend_freqs`, `_reference_shape`.
New public fields: `quality`, `cross_bridge_match`, `bridge`.

#### `TrackingConfig` (new)

```python
@dataclass
class TrackingConfig:
    # Frequency matching
    freq_tol_pct: float = 0.02           # per-step relative tolerance
    freq_envelope_margin: float = 0.05    # range gate extension beyond observed envelope
    trend_window: int = 3                 # number of recent detections for trend fit
    trend_decay: float = 0.3             # exponential weight decay for trend fit

    # MAC
    mac_reject_threshold: float = 0.3     # hard reject below this
    mac_weight: float = 0.5              # weight in cost function

    # Shape drift
    max_shape_drift_rate: float = 0.15    # per scenario step (at lowest frequencies)
    shape_drift_freq_relax: float = 2.0  # relaxation factor: at 1000 Hz, tolerance = base * (1 + this)
    shape_drift_weight: float = 0.3       # weight in cost function

    # Cost
    freq_weight: float = 1.0
    max_cost: float = 2.0                # above this, no assignment
    no_assign_cost: float = 3.0          # dummy cost for unmatched padding

    # Chain management
    max_gap: int = 5                     # in scenario-index units
    reference_shape_alpha: float = 0.3    # EMA update rate for reference shape

    # Post-processing
    coverage_threshold: float = 0.50      # minimum coverage for "stable"
    splitter_freq_tol: float = 0.02       # frequency tolerance for splitter detection
    splitter_mac_threshold: float = 0.7   # MAC threshold for splitter detection
    cross_bridge_freq_tol: float = 0.03   # frequency tolerance for cross-bridge matching
    cross_bridge_mac_threshold: float = 0.5
```

All parameters are global (same for both bridges). Per-bridge overrides are not needed because the physical properties are similar on both bridges; only the scenario ranges differ.

#### `TrackingResult` (new)

```python
@dataclass
class TrackingResult:
    bass_chains: List[ModeChain]
    treble_chains: List[ModeChain]
    all_chains: List[ModeChain]
    cross_bridge_matches: List[Tuple[int, int, float, Optional[float]]]
    splitter_reports: List[SplitterReport]
    unassigned_detections: List[ModeDetection]
    summary: Dict[str, Any]
```

### Function signature changes

#### `track_modes_along_bridge()` (esprit/mode_tracking.py)

Old:
```python
def track_modes_along_bridge(
    per_scenario_freqs: Dict[int, List[float]],
    scenario_order: Optional[List[int]] = None,
    freq_tol_pct: float = 0.02,
    max_gap: int = 3,
) -> List[ModeChain]:
```

New:
```python
def track_modes_along_bridge(
    per_scenario_detections: Dict[int, List[ModeDetection]],
    scenario_order: Optional[List[int]] = None,
    config: TrackingConfig = TrackingConfig(),
) -> List[ModeChain]:
```

#### `EspritRunner._track_bridge()` (esprit_runner.py)

Old (lines 455-518): builds frequency lists, calls `track_modes_along_bridge()` with bare frequencies, then loops over chains to attach damping/amplitude/shape via `round(f, 2)` lookups.

New: builds `List[ModeDetection]` directly from ESPRIT output, calls `track_modes_along_bridge()` with full objects. No post-hoc enrichment needed.

```python
@staticmethod
def _track_bridge(
    per_scenario_results: Dict[int, Dict],
    config: TrackingConfig,
) -> List[ModeChain]:
    # Build ModeDetection objects directly from ESPRIT output
    per_scenario_detections: Dict[int, List[ModeDetection]] = {}
    for sc_idx, result in per_scenario_results.items():
        freqs = result.get("frequencies", np.array([]))
        dampings = result.get("damping_ratios", np.array([]))
        mode_shapes = result.get("mode_shapes")
        # ... build ModeDetection list with all fields populated ...
    return track_modes_along_bridge(per_scenario_detections, config=config)
```

#### `EspritRunner.run_tracking()` (esprit_runner.py)

Old (lines 279-432): builds four separate `round(f, 2)` keyed lookup dicts, splits scenarios, calls `_track_bridge()` with all lookups.

New: passes `per_scenario_results` dicts directly to `_track_bridge()`, adds cross-bridge matching and splitter detection:

```python
def run_tracking(
    self,
    per_scenario_results: Dict[int, Dict],
    bridge_boundary: int = 28,
    config: TrackingConfig = TrackingConfig(),
) -> TrackingResult:
```

#### `ModalAdapter.run_tracking()` (modal_adapter.py)

Updated to accept `TrackingConfig` and return `TrackingResult`. Persists splitter reports and cross-bridge matches alongside chains.

### Elimination of `round(f, 2)` lookups

All `round(f, 2)` patterns are removed:

| Location | Current pattern | Replacement |
|----------|----------------|-------------|
| `esprit_runner.py` lines 323-384 | 4 lookup dicts keyed by `round(f, 2)` | Direct `ModeDetection` construction |
| `esprit_runner.py` lines 480-516 | Post-hoc nearest-freq attachment | Eliminated — data in `ModeDetection` from start |
| `modal_adapter.py` lines 984-992 | `_enrich_chains_from_esprit()` | Eliminated — chains carry full data |
| `modal_adapter.py` line 2295, 2309 | `get_stabilization_data()` assigned set | Use `(sc_idx, chain_id)` keying instead |

---

## 6. Output Format

### Primary output: `TrackingResult`

The tracking stage produces:

- **`all_chains`**: `List[ModeChain]` — sorted by `frequency_mean`, with `chain_id` sequentially numbered. Each chain's `detections` dict is keyed by scenario index and contains fully-populated `ModeDetection` objects.

- **`bass_chains` / `treble_chains`**: Subsets of `all_chains` partitioned by bridge. Each chain's `bridge` field is set to `"bass"` or `"treble"`.

- **`cross_bridge_matches`**: `List[Tuple[bass_chain_id, treble_chain_id, freq_diff_pct, mac_or_None]]` — pairs of chains that likely represent the same physical mode on both bridges.

- **`splitter_reports`**: `List[SplitterReport]` — pairs of chains flagged as potential splitter modes, with recommendations.

- **`unassigned_detections`**: `List[ModeDetection]` — all detections that were not assigned to any chain (either never matched or in chains that were rejected by coverage threshold). Available for diagnostic visualization in the stabilization diagram.

- **`summary`**: Statistics dict (total chains, per-bridge counts, stability breakdown, splitter count, cross-bridge match count).

### Serialization for persistence

`EspritRunner.chains_to_dicts()` is updated to include new fields:

```python
{
    "chain_id": 0,
    "frequency_mean": 65.41,
    "frequency_range": [64.8, 66.1],
    "frequency_drift": 1.3,
    "damping_mean": 0.002,
    "detection_count": 25,
    "coverage": 0.89,
    "stability": "stable",
    "bridge": "bass",
    "cross_bridge_match": 42,  # or null
    "quality": {"coverage": 0.89, "frequency_smoothness": 0.97, ...},
    "detections": {
        "3": {"frequency": 64.8, "damping_ratio": 0.002, "amplitude": 0.015,
              "shape": [0.1, -0.3, 0.5, -0.2, 0.1],
              "mode_shape": [[0.1, 0.02], [-0.3, -0.01], ...]},
        ...
    }
}
```

### Integration with downstream consumers

- **Feedin extraction** (`FeedinExtractor`): receives `List[ModeChain]` with `ModeDetection.mode_shape` already populated. Uses `reference_shape` (mean complex shape per chain) for projection — no change needed to feedin extraction itself, just cleaner input data.

- **Preset building** (`PresetInjector`): uses `cross_bridge_match` to ensure the same physical mode gets the same mode index across bass and treble pitches. Uses `quality.overall_score` for `max_modes` filtering instead of coverage alone.

- **Stabilization diagram** (`get_stabilization_data()`): uses `unassigned_detections` directly instead of reconstructing them via `round(f, 2)` set difference.

---

## 7. Configuration Parameters

All parameters live in `TrackingConfig`. Summary with rationale:

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `freq_tol_pct` | 0.02 | 2% matches current default; allows ~1 Hz drift at 50 Hz, ~10 Hz at 500 Hz |
| `freq_envelope_margin` | 0.05 | 5% beyond observed range prevents false matches while accommodating edge cases |
| `trend_window` | 3 | 3 points gives a trend line without overfitting; degrades gracefully to 1-point |
| `trend_decay` | 0.3 | Moderate recency weighting; recent points matter more but old points stabilize |
| `mac_reject_threshold` | 0.3 | Orthogonal modes have MAC near 0; 0.3 is conservative (allows noisy matches) |
| `mac_weight` | 0.5 | Half the weight of frequency — MAC is informative but limited with 5 channels |
| `max_shape_drift_rate` | 0.15 | Empirical: adjacent scenarios on Belarus data show MAC > 0.85 for well-tracked modes |
| `shape_drift_weight` | 0.3 | Lower than MAC weight — drift rate is a softer criterion |
| `freq_weight` | 1.0 | Frequency is the primary criterion — full weight |
| `max_cost` | 2.0 | Roughly: 2x the "normal" cost threshold; allows imperfect but plausible matches |
| `no_assign_cost` | 3.0 | Must exceed `max_cost` so Hungarian prefers not assigning over forced bad matches |
| `max_gap` | 5 | In scenario-index units; ~5 positions of missing data before chain closes |
| `reference_shape_alpha` | 0.3 | EMA balance: responsive to real drift, robust to single-scenario noise |
| `coverage_threshold` | 0.50 | Physical modes should appear in most scenarios; below 50% is unreliable |
| `splitter_freq_tol` | 0.02 | Same as tracking tolerance — splitters are within one tracking tolerance of each other |
| `splitter_mac_threshold` | 0.7 | Higher than reject threshold — splitters must be genuinely similar, not just non-orthogonal |
| `cross_bridge_freq_tol` | 0.03 | Slightly relaxed — frequency can shift more between separate bridges |
| `cross_bridge_mac_threshold` | 0.5 | Moderate — mode shapes at the bridge boundary may differ somewhat between structures |

All parameters are global (not per-bridge). The physical mode behavior is similar on both bridges; only the scenario ranges differ. If future datasets show bridge-specific needs, `TrackingConfig` can be extended with per-bridge overrides.

---

## 8. Implementation Plan

### Step 1: TrackingConfig and TrackingResult dataclasses

**File:** `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py`
**Scope:** Add `TrackingConfig`, `ChainQuality`, `SplitterReport`, `TrackingResult` dataclasses. Extend `ModeChain` with new fields (`quality`, `cross_bridge_match`, `bridge`, `_last_scenario_index`, `_trend_freqs`, `_reference_shape`). Add `extrapolate_frequency()` method to `ModeChain`.

**Incremental:** Yes — existing code continues to work; new fields have defaults.

### Step 2: Build ModeDetection objects in EspritRunner

**File:** `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`
**Scope:** Rewrite `_track_bridge()` to construct `ModeDetection` objects directly from ESPRIT output (frequency, damping, amplitude, mode_shape all populated at creation). Remove the four `round(f, 2)` lookup dicts and the post-hoc enrichment loop.

**Incremental:** Yes — `_track_bridge()` is self-contained. Can be done while `track_modes_along_bridge()` still accepts the old interface (adapter pattern), then switch once Step 3 is ready.

### Step 3: Core algorithm replacement

**File:** `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py`
**Scope:** Rewrite `track_modes_along_bridge()`:
- Accept `Dict[int, List[ModeDetection]]` instead of `Dict[int, List[float]]`
- Accept `TrackingConfig` instead of individual parameters
- Implement cost function with frequency trend + MAC + shape drift
- Replace greedy matching with `scipy.optimize.linear_sum_assignment`
- Implement gap-aware step size scaling
- Update `_merge_split_chains()` to use MAC

**Atomic:** This is the core change. Must be done together with Step 2 (the interface change).

### Step 4: Post-processing — splitter detection and cross-bridge matching

**File:** `PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py`
**Scope:** Add `detect_splitter_modes()` and `match_chains_cross_bridge()` functions. Add `ChainQuality` computation in `finalize()`.

**Incremental:** Yes — can be added after Step 3. These are new functions called after the core tracking.

### Step 5: Update EspritRunner.run_tracking()

**File:** `PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py`
**Scope:** Update `run_tracking()` to use `TrackingConfig`, call cross-bridge matching and splitter detection, return `TrackingResult`. Update `chains_to_dicts()` for new fields.

**Incremental:** Yes — depends on Steps 2-4.

### Step 6: Update ModalAdapter integration

**File:** `PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py`
**Scope:**
- Update `run_tracking()` to accept `TrackingConfig`
- Remove `_enrich_chains_from_esprit()` method (no longer needed)
- Update `get_stabilization_data()` to use `unassigned_detections` from `TrackingResult` instead of `round(f, 2)` set difference
- Persist splitter reports and cross-bridge matches
- Update chain loading from disk to reconstruct new fields

**Incremental:** Yes — depends on Step 5.

### Step 7: Update routes and frontend

**File:** `PianoidCore/pianoid_middleware/modal_adapter/routes.py`, `PianoidTunner/src/...`
**Scope:** Expose splitter reports and cross-bridge matches via API. Frontend stabilization diagram can highlight splitter pairs and cross-bridge matches.

**Incremental:** Yes — depends on Step 6.

### Test strategy

1. **Unit tests for cost function:** Given known chain state and candidate detection, verify cost computation matches expected values. Test frequency trend extrapolation, MAC rejection, shape drift penalty.

2. **Unit tests for Hungarian assignment:** Small synthetic scenarios (3 chains, 5 detections) with known optimal assignment. Verify the algorithm finds it.

3. **Integration test on Belarus data:** Load the existing Belarus dataset per-scenario ESPRIT results. Run new tracking. Compare chain count, coverage distribution, and stability classification against the current algorithm's output. The new algorithm should produce:
   - Fewer broken chains (higher mean coverage)
   - Fewer duplicate chains for the same physical mode
   - Correct tracking through known frequency crossings
   - Splitter mode detection where ESPRIT over-estimated

4. **Regression test:** Verify that feedin extraction and preset building produce equivalent output when given the same tracked chains (the downstream pipeline should not need changes).

5. **Performance test:** Verify that tracking 80 scenarios with ~100 modes each completes in < 5 seconds total.

### Dependency

`scipy` is already available in the project venv (used by ESPRIT). No new dependencies required.
