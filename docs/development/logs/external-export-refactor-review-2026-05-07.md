# external_export Refactor Review (2026-05-07)

**Reviewer:** /analyse pass (read-only)
**Scope:** `pianoid_middleware/modal_adapter/external_export.py` plus its REST
endpoint, `ModalAdapter.export_to_text_files` wrapper, `useModalAdapter.exportToText`
hook, and the Apply-panel "Export to Text Files" sub-panel in `ModalAdapter.jsx`.
**Reference upstream:** `RoomResponse/ESPRIT/Merge_res_New.py` (379 LOC, copy
preserved at `.claude/scratch_rrexport/Merge_res_New.py`).
**Author of code under review:** dev-6c54c87f (still alive, lock preserved —
**not modified by this pass**).

---

## 1. Current Architecture Overview

The export tool lives in one Python module
(`PianoidCore/pianoid_middleware/modal_adapter/external_export.py`, 662 LOC)
plus a thin method on `ModalAdapter` and a thin REST endpoint. It produces 5
fixed-shape text files (`Ci_coef_cos`, `omega_coef`, `Q_coeff_Q`, `Q_coeff_E`,
`decka_coeff`) and a JSON sidecar (`stitched_results.json`) that mirror the
RoomResponse Stage-2 contract. Approximation is layout-aware: `interp1d`
linear for `line`, `np.linalg.lstsq` planar fit for `grid`. The frontend
exposes one button + override checkbox + free-text path field.

Call graph:

```
ModalAdapter.jsx (Apply panel sub-Paper)
    -> useModalAdapter.exportToText(opts)             [hook callback]
        -> POST /modal/projects/<name>/export_text     [REST]
            -> routes.py: export_text_files_route()     [Flask handler]
                -> ModalAdapter.export_to_text_files()  [adapter method]
                    -> external_export.export_text_files() [convenience]
                        -> build_export_payload()        [the 258-LOC kitchen sink]
                            -> extract_signed_shapes_per_chain()
                            -> approximate_line()  OR  approximate_planar()
                        -> write_export_files()          [np.savetxt x5 + json.dump]

(side door, dev-md07)
ModalAdapter.get_grid_heatmap_data()
    -> external_export.approximate_planar()        [the only shared helper]
```

The single shared symbol between the export tool and the rest of the modal
adapter is `external_export.approximate_planar`, deliberately reused by
`get_grid_heatmap_data` so the on-screen heatmap and the exported planar
fill are byte-equivalent. That cross-call is healthy. Everything else in
`external_export.py` is an island.

---

## 2. Strengths (don't dismantle these)

1. **The contract is documented end-to-end.** `MODAL_ADAPTER_GUIDE.md`
   §"Export to Text Files (dev-6c54c87f)" describes file shapes, layout-aware
   approximation, fallback rules, the pre-filtered mode-shape gotcha, and
   the channel-to-receiver mapping. The dev-6c54c87f log captures both bugs
   (empty `channel_to_sound`, off-by-one on pre-filtered shapes) with their
   reproductions and validations. This is a high baseline of explanation that
   future agents should not lose during refactor.

2. **The two approximation helpers (`approximate_line`,
   `approximate_planar`) are pure and well-tested.** They take small primitive
   inputs, return arrays, and have direct unit tests. They are also
   genuinely reused (`get_grid_heatmap_data` consumes `approximate_planar`).
   Keep them. They are the seed of a future "approximation strategies"
   sub-module.

3. **Constants are named, hoisted, and commented.** `MAX_MODES = 128`,
   `NUM_RECEIVERS = 16`, `NUM_NN = 44`, `NUM_ROWS = 256`, `BIGQ`,
   `PLACEHOLDER_FREQ_HZ`, `PLACEHOLDER_ZETA` are at module top with an
   "engine ABI — do not expose without coordination" warning. The original
   `Merge_res_New.py` had `BIGQ` buried at line 184; the port surfaces it.

4. **The fallback rules are explicit and observable.** The empty-`channel_to_sound`
   fallback writes `channel_to_receiver` AND `selected_r_indices` into the
   sidecar JSON, so a downstream consumer can see exactly what mapping was
   applied. The `n_modes_padded`, `n_modes_exported`, and `approximation`
   fields are echoed all the way back to the UI, which renders them in the
   success Alert. This is exemplary "make the silent fallback visible".

5. **The REST contract is small and validated.** Only `output_dir` and
   `selected_chains` are accepted; both are coerced/validated; project-name
   mismatch returns 400 with a clear message. The handler rejects malformed
   `selected_chains` as 400 instead of bubbling a 500. Good.

6. **The hook is a 30-line thin proxy.** `useModalAdapter.exportToText`
   does no business logic — builds the body, posts, returns response or null
   on error. No optimistic updates, no caching. The frontend Paper block is
   self-contained (4 local `useState`s, 2 handlers, doesn't touch shared
   Apply state). Cleanly amputatable.

---

## 3. Weaknesses (ranked by severity)

### High-severity

**H1. `build_export_payload` is a 258-line kitchen sink doing 9 distinct
jobs.** Lines 339–597. It performs: (a) chain selection filter, (b) sort,
(c) MAX_MODES truncation, (d) response-channel resolution, (e)
projection delegation, (f) layout-branched approximation, (g)
placeholder padding, (h) Q computation, (i) Ci_coef_cos packing
(double for-loop), (j) decka_coeff packing including the
amps-idx-to-channel-to-receiver translation table (the bug-prone
section), (k) sidecar dict assembly. Per CODE_QUALITY.md ("If a function
is longer than ~50 lines, it is probably doing more than one thing"),
this is 5x over and it has already been the site of two production bugs
(both decka-related, dev-6c54c87f decka-fix on 2026-05-06). The next bug
will land in the same function. There is no syntactic or test-fixture
boundary between concerns; a reviewer reading the function has to hold
all 9 responsibilities in their head simultaneously.

**H2. The `decka_coeff` packing path concentrates the most
bug-prone logic in the deepest, most cluttered nesting.** Lines 482–557.
Three independent translation tables exist within 75 lines:
`channel_to_receiver` (built two ways — explicit map vs contiguous
fallback), `amps_idx_to_channel` (built two ways — pre-filtered vs
identity), and the `selected_r_indices` derived field for the sidecar.
The "pre-filtered detection" heuristic is `len(amps) == len(response_channels)`
which is FRAGILE: a future change to ESPRIT's pre-filter behaviour, or
a coincidence where measurement-channel count happens to equal response
count, breaks it silently. This is exactly the failure mode the
"high-stakes inference" rule in CLAUDE.md was added to prevent, but the
detection is still inferred from a length comparison rather than a
documented metadata field on the chain dict.

**H3. The planar fit's evaluation coordinate is inconsistent with its
training coordinate.** `approximate_planar` line 296–322. The lstsq
training inputs are `(x_mm, y_mm)` from `mapping.point_coordinates`
(real physical coordinates), but the per-cell evaluation uses
`x = col * grid_spacing_mm; y = row * grid_spacing_mm` (a synthetic
linear lattice). For grids where the populated cells don't sit on the
canonical `(col*spacing, row*spacing)` lattice — sparse grids,
non-uniform spacings, calibration-corrected coords — the fit is trained
on one space and evaluated in another. The unit test
`test_planar_fills_missing_cells` happens to use a fully-uniform 3×3
grid, so this never trips in tests. The duplicate consumer in
`get_grid_heatmap_data` (modal_adapter.py:4018) inherits the bug
silently.

**H4. The sister tool `feedin_extractor.extract_from_mode_shapes` does
the same complex projection (`Re(<shape, conj(ref)>)`).** Both
`external_export.extract_signed_shapes_per_chain` (lines 100–209) and
`feedin_extractor` use the same projection algorithm; the docs
(MODAL_ADAPTER_GUIDE.md line 1721–1724) explicitly note "the same
approach `feedin_extractor.extract_from_mode_shapes` uses". This is a
**copy with drift** — the export's version adds per-chain max-abs
normalisation and amplitude payload selection, which are export-specific,
but the core projection (mean-shape unit-norm + dot product) is
duplicated. A future bug fix in one will not propagate to the other.
(Not verified by reading `feedin_extractor.py` in this pass — flagged
for the refactor agent to confirm.)

### Medium-severity

**M1. `extract_signed_shapes_per_chain` is 144 lines doing 5 things.**
Lines 65–209: complex-shape collection, mask construction, reference
projection, normalisation, and amplitude payload selection. The
mask-construction comment block (lines 119–135) is 17 lines explaining
WHY — that's docs-in-code, valuable, but it makes the function feel
denser than it is. The amplitude-payload selection (lines 183–207) is
loosely related to the projection logic and could be split out as a
peer.

**M2. The `Ci_coef_cos` packing is a nested for-loop with implicit
"note == idx_x" assumption.** Lines 471–480. The loop walks
`packed_shapes[k]` indices and treats each as a "note position". For
`line` layout, `idx_x` IS the scenario-index (full_notes = arange).
For `grid` layout, `packed_shapes[k]` is `n_rows * n_cols` long (the
flattened grid), and `idx_x` becomes a **row-major-flattened cell
index** — which the packing is then treating AS IF IT WERE a note
position. Walk the math: a 11×11 grid produces 121 entries, packed
into the (44, 256)-array via `nn = idx_x // 2, ni = idx_x % 2, col =
k + ni*128`. There is no test that confirms this is what the
downstream consumer wants for grid layouts. The
MODAL_ADAPTER_GUIDE.md line 1675 documents `Ci_coef_cos` as
"Packed mode-shape coefficients `ci[nn = note//2, k + ni*128]` for
`ni = note%2`" — for grids, "note" is undefined. **This may produce a
file that is shaped correctly but semantically meaningless for grid
layouts.** Worth confirming with the user / downstream consumer.

**M3. Two silent fallbacks.** The empty `channel_to_sound` fallback
(line 499–517) is well-logged. But `extract_signed_shapes_per_chain`
also has a silent fallback on line 149–156 ("Bad config — fall back to
all channels for robustness") that emits a warning but keeps going.
And `approximate_planar` falls back to mean for `n_meas == 2` (line 323)
and zeros for `n_meas == 0` (line 305) without a returned indicator —
the caller has no way to know which mode it ran in.

**M4. The grid-layout placeholder shape length is inferred indirectly.**
Line 457: `placeholder_shape_len = len(packed_shapes[0]) if packed_shapes
else len(full_notes)`. This works only because `full_notes` is set
correctly in both branches above (line 434 vs 449). It's not wrong, but
it's the kind of "two paths must stay in sync" plumbing that
silently regresses when a third layout type is added.

**M5. Two-table walk: `mapping.point_coordinates` is iterated by index
0..N-1 in row-major order in `approximate_planar`, AND in
`build_export_payload`'s sidecar (`scenario_names = sorted({int(k) for k
in (point_coords.keys() ...)})`, line 566), AND in
`modal_adapter.get_grid_heatmap_data` (line 3984:
`sorted(mapping.point_coordinates.keys())`). Three places, three
slightly-different walks of the same dict. They agree today only by
convention. There should be a single helper —
`mapping.iter_populated_cells()` or similar — that owns the row-major
traversal contract.

**M6. The Apply-panel UI Paper block (ModalAdapter.jsx:2058–2138, ~80
lines) is well-isolated visually but its disabled-state logic is
duplicated.** Line 2104–2110: `exportTextBusy || !currentProject ||
trackingChains.length === 0 || (!exportTextAllChains && exportSelection.length === 0)`.
The same gating applies to "Apply to Preset" and any future "consume
the export selection" action. Should be a derived selector in the hook
(`canExportSelection`, `whyDisabled` reason string).

**M7. The sidecar's `selected_r_indices` field exists for "backwards
compatibility with consumers that read the original Stage-2 metadata"
(per the docs). It is `sorted(channel_to_receiver.values())` — i.e. a
list of receiver slots. In the original Stage-2 format,
`selected_r_indices` was `present_receivers` — same list. But the
NAMING is misleading: in the new context it's the **set of populated
receiver slots after fallback resolution**, not "indices the user
selected". A consumer reading the JSON without context will assume
user intent.

### Low-severity

**L1. `BIGQ`, `PLACEHOLDER_FREQ_HZ`, `PLACEHOLDER_ZETA` are module-level
constants but appear in the function body via direct reference —
they should be configurable per-export OR documented as "engine ABI
constants do not change". Currently both interpretations are
plausible; the comment at line 49 says "engine ABI — do not expose
without coordination" which leans engine-side, but `PLACEHOLDER_FREQ_HZ
= 1000.0` is a tuning knob (not an ABI requirement).

**L2. `os` is used only for `makedirs`, `path.join`, `path.abspath`.**
Could migrate to `pathlib.Path` for consistency with the rest of the
modal adapter (but not urgent).

**L3. The success Alert in the frontend echoes the approximation as a
raw string (`linear` / `planar`). Most user-facing labels in the rest
of the panel use friendly names ("Bridge", "Grid"). Minor wording.

**L4. `approximate_line` returns `np.zeros(len(full_indices))` for empty
input, but `approximate_planar` returns a (possibly differently-shaped)
zero array — and the surrounding code passes the result to `.ravel()`
which trusts the shape. A divergence here would surface as a hard-to-trace
shape mismatch later.

**L5. The 4 hook-level Jest tests cover request-shaping and error
flow but not the disabled/enabled gating logic on the button. The
gating logic is the user-visible bit most likely to regress in
"redesign Apply panel" passes.

**L6. The `freq_tol = 1e-6` dedup logic from `Merge_res_New.py` line
101–117 was DROPPED in the port (correctly — chains are already
deduped), but no comment confirms this was intentional. A future agent
reading both files will wonder.

---

## 4. Refactoring Proposals

### P1 (resolves H1, M1, M2). Decompose `build_export_payload` into a pipeline of named stages.

**What changes.** Split `external_export.py` into either a small package
(`external_export/__init__.py`, `external_export/approximation.py`,
`external_export/projection.py`, `external_export/packing.py`) or a single
file with clearly grouped functions:

```python
# Stage 1: chain prep
def select_and_sort_chains(chains, selected_chain_ids) -> List[Dict]: ...
def truncate_to_max_modes(chains) -> List[Dict]: ...

# Stage 2: per-chain extraction (already exists)
def extract_signed_shapes_per_chain(chains, response_channels) -> ...: ...
def extract_loudest_amplitudes_per_chain(chains, ...) -> ...:  # split out from above

# Stage 3: approximation strategy
class ApproximationStrategy(Protocol): ...
class LinearStrategy: ...   # wraps approximate_line
class PlanarStrategy: ...   # wraps approximate_planar
def select_strategy(layout_type, mapping_config) -> ApproximationStrategy: ...

# Stage 4: padding
def pad_modes_to_max(freqs, zetas, packed_shapes, amplitudes) -> ...: ...

# Stage 5: packing
def pack_ci_coef_cos(packed_shapes) -> np.ndarray: ...
def pack_decka_coeff(amplitudes_per_chain, channel_to_receiver, amps_idx_to_channel) -> np.ndarray: ...
def compute_q_from_zeta(zetas) -> List[float]: ...

# Stage 6: channel resolution (the bug-prone bit, now isolated)
def resolve_channel_to_receiver(mapping_config, response_channels) -> Dict[int, int]: ...
def resolve_amps_idx_to_channel(amps_len, response_channels) -> Dict[int, int]: ...

# Stage 7: thin orchestrator (replaces today's 258-line build_export_payload)
def build_export_payload(chains, mapping_config, ...) -> Dict:
    chains = select_and_sort_chains(chains, selected)
    chains = truncate_to_max_modes(chains)
    response_channels = resolve_response_channels(mapping_config, response_channels)
    shapes, amps = extract_signed_shapes_per_chain(chains, response_channels)
    strategy = select_strategy(mapping_config.layout_type, mapping_config)
    packed = [strategy.fill(s) for s in shapes]
    freqs, zetas, packed, amps = pad_modes_to_max(freqs, zetas, packed, amps)
    ci = pack_ci_coef_cos(packed)
    decka = pack_decka_coeff(amps, ...)
    return assemble_payload(...)
```

**Why this approach (alternatives considered).**

- **Alternative A: keep one function, add comments.** Rejected — the
  function is already heavily commented. The problem is concept count,
  not vocabulary count.
- **Alternative B: full class-based refactor (`ExportBuilder` class with
  `_chains`, `_mapping`, etc. as attributes).** Rejected — adds state
  without buying anything; the data flow is straightforwardly functional
  (chains in, payload out). `scenario_averager.py` (the closest sibling)
  uses module-level pure functions for the same reason.
- **Alternative C (chosen): module of small pure functions, thin
  orchestrator.** Matches `scenario_averager.py`'s pattern (lots of
  `_helper` functions, public functions are thin), trivially testable,
  each function gets a focused unit test, and the channel-mapping bugs
  H2 / H3 / H4 / M3 land in named functions where they can be tested
  in isolation.

**Risk.** Low — current test coverage is 36 tests on `external_export`,
all of which would survive (most test public functions that stay public).
The refactor adds tests, doesn't remove them. The only regression risk
is a subtle change in the order of operations (e.g. truncate-before-pack
vs pack-before-truncate). Mitigation: keep the existing
`build_export_payload` integration tests as the golden contract
(`test_output_shapes_match_constants`, `test_padding_with_placeholders`,
`test_decka_phase_alignment`).

**Effort.** **M** — 1–2 day /dev. Well-bounded refactor, straight
mechanical decomposition. No new features.

---

### P2 (resolves H2). Make the "pre-filtered mode_shape" detection explicit, not inferred.

**What changes.** Today the code detects pre-filtered shapes via
`len(amps) == len(response_channels)` (line 541). This is a heuristic
that holds today only because ESPRIT's runner happens to pre-filter
that way. Add an explicit metadata field to the chain dict at the
point where pre-filtering happens (`esprit_runner.run_with_progress`),
e.g. `chain["mode_shape_axis"] = "response_channels"` vs `"all_channels"`.
Then in `external_export`:

```python
def resolve_amps_idx_to_channel(chain, response_channels):
    axis = chain.get("mode_shape_axis", "all_channels")
    if axis == "response_channels":
        return {i: int(response_channels[i]) for i in range(len(response_channels))}
    elif axis == "all_channels":
        return {i: i for i in range(...)}
    else:
        raise ValueError(f"Unknown mode_shape_axis: {axis}")
```

This eliminates the silent length-coincidence trap and gives future
agents an unambiguous contract.

**Why.** Per CLAUDE.md "high-stakes inference categories: axis
semantics MUST have doc support, or the agent MUST measure". The
current detection is *inferred from length*, which CLAUDE.md
explicitly flags as insufficient.

**Risk.** Medium — requires touching `esprit_runner.py` and migrating
existing chain dicts (or accepting that old chains default to
`"all_channels"` which matches their actual layout). Needs a
backwards-compat guard during the migration window.

**Effort.** **M** — 1 day /dev, plus coordination with the esprit
runner (which is locked by another agent — verify the lock state at
implementation time).

---

### P3 (resolves H3). Fix the planar-fit train/eval coordinate mismatch.

**What changes.** In `approximate_planar`, replace the synthetic
evaluation lattice with the real per-cell coordinates derived the same
way the training data was. Walk the cell mask, look up
`point_coordinates[p_idx]` for populated cells (real coords), and use
`(col*spacing, row*spacing)` ONLY when the cell is unpopulated AND has
no entry in `point_coordinates` — i.e. the synthetic lattice becomes
the fallback for unmeasured cells (which is what the original intent
was). Equivalent: precompute a `cell_coords[r][c]` 2-D array from
`point_coordinates` (with synthetic fallback for missing entries) and
evaluate the plane on that.

**Why.** For uniform-grid fixtures, the fix is a no-op (real coords
== synthetic coords). For real grids with non-uniform or
calibration-adjusted coords (which the user's `PlyWoodTake1_4` may
have — needs verification), the fix produces planar fills that
actually lie on the fitted plane.

**Risk.** Low — trivially testable. Add a test fixture with
non-uniform `point_coordinates` (e.g. one cell offset by 5mm) and
assert the planar evaluation at that cell uses the real offset.

**Effort.** **S** — half a day /dev. Single function change, one new
test. Verify `get_grid_heatmap_data` still produces consistent
heatmaps after the fix (should be identical for uniform fixtures).

---

### P4 (resolves H4). Lift the complex-shape projection into a shared helper.

**What changes.** Extract the projection algorithm
(`mean_shape -> unit-norm reference -> Re(<shape, conj(ref)>)`) into a
shared helper in `feedin_extractor` (or a new
`mode_shape_projection.py`). Both `extract_signed_shapes_per_chain`
and `feedin_extractor.extract_from_mode_shapes` call it. The
export-specific bits (per-chain max-abs normalisation, amplitude
payload selection) stay in `external_export`.

**Why.** Eliminates copy-with-drift. A future bug fix to the
projection (e.g. handling near-zero reference shapes more gracefully)
propagates to both consumers automatically.

**Risk.** Medium — requires confirming the two call sites really do
use the same algorithm (this audit didn't read `feedin_extractor.py`).
If they have meaningful semantic differences, the merge becomes
more delicate.

**Effort.** **S–M** — half-to-one day /dev, depending on what the audit
of `feedin_extractor.py` reveals.

---

### P5 (resolves M2). Confirm-and-document `Ci_coef_cos` packing for grid layouts.

**What changes.** Either (a) the user / downstream consumer confirms
that "row-major flatten of grid cells" IS the desired note-axis
mapping for grid layouts, in which case add explicit documentation
and a passing test that asserts the packing convention; OR (b) the
desired behaviour is different (e.g. only `bridge_boundary` row of
the grid is exported, or grid is collapsed via column-mean, etc.) —
in which case fix the packing.

**Why.** Today the code happily produces a file that looks correct
(right shape, right format) but whose semantic content for grid
layouts is undocumented and untested. The user might already be
consuming garbage and not realising it.

**Risk.** Unknown — depends on (a) vs (b) above. A measurement-first
approach: produce a test export from a real grid project, hand the
output to the downstream consumer (or visually verify the
`Ci_coef_cos` plot), get the verdict.

**Effort.** **S** if (a) — half day to add doc + test. **L** if (b) —
new packing logic, new tests, possibly a new constant.

**Recommended:** ask the user before scheduling.

---

### P6 (resolves M5). Centralise the row-major populated-cell walk in `MappingConfig`.

**What changes.** Add `MappingConfig.iter_populated_cells() ->
Iterable[Tuple[int, int, int, Tuple[float, float]]]` returning
`(p_idx, row, col, (x_mm, y_mm))` for every populated cell in
row-major order. Replace the three current walks
(`approximate_planar`, `build_export_payload` sidecar,
`get_grid_heatmap_data`) with a single call.

**Why.** Owns the "row-major over populated cells" contract in one
place. Today it is a convention asserted three times.

**Risk.** Very low — pure refactor with mechanical replacement.

**Effort.** **S** — couple hours.

---

### P7 (resolves M6). Lift Apply-panel disabled gating into a hook-level selector.

**What changes.** In `useModalAdapter`, expose a derived
`canExportSelection` (or `exportSelectionState: { canExport, reason }`)
that consolidates "no project / no chains / empty selection without
override". The Apply panel reads it and uses `reason` for tooltips.
Reusable by any future "consume export selection" action.

**Why.** DRY: same gating logic was duplicated in (or about to be
duplicated by) Apply-to-Preset, future heatmap-export, etc.

**Risk.** Very low — frontend-only, no behaviour change.

**Effort.** **S** — couple hours.

---

### P8 (resolves M3 / M7). Make silent fallbacks return their reason.

**What changes.** Functions that take a fallback path return a
`(value, reason: str | None)` tuple instead of just `value`. The
top-level orchestrator collects all reasons into a `warnings: List[str]`
field on the response payload. The frontend renders them in a yellow
Alert under the green success Alert.

**Why.** Today the user sees "Wrote 6 files" and never knows that
`channel_to_sound` was empty and a fallback kicked in. Per CLAUDE.md
("high-stakes inference: silent inference forbidden"), fallbacks
need to be visible.

**Risk.** Low — additive API change.

**Effort.** **S** — one day /dev.

---

## 5. Recommended Sequence

Highest leverage, lowest risk first. **P1 is the structural
foundation — most other proposals collapse cleanly into it.**

1. **P1** (decompose `build_export_payload`) — **first**. Big leverage,
   makes every other refactor smaller, low risk because tests already
   pin the contract.
2. **P3** (planar fit coord fix) — **second**. Half a day, lands
   inside P1's new `approximation` module, fixes a latent correctness
   bug.
3. **P6** (centralise populated-cell walk) — **third**. Lands inside
   P1's new `packing.py`, low effort.
4. **P8** (visible fallback warnings) — **fourth**. Once the structure
   from P1 is in place, threading `warnings` through is cheap.
5. **P7** (frontend gating selector) — anytime, independent thread.
6. **P2** (explicit `mode_shape_axis` metadata) — needs coordination
   with esprit_runner agents; schedule when other locks are clear.
7. **P4** (shared projection helper) — needs `feedin_extractor.py`
   audit first; may upgrade to S after that audit.
8. **P5** (`Ci_coef_cos` grid semantics) — **gated on user input**.

---

## 6. Open Questions for the User

1. **P5 — `Ci_coef_cos` for grid layouts:** Today the packing flattens
   the grid into a 1-D "note axis" by row-major order. Is that what
   the downstream RoomResponse consumer expects for grid layouts? Or
   should grid projects collapse the grid (e.g. take only one row of
   cells along the bridge axis) before packing? A real export from a
   grid project that the downstream consumer has validated would
   answer this.

2. **P2 — `mode_shape_axis` metadata:** Adding an explicit field to
   chain dicts is the right long-term fix, but it touches a code path
   currently held by other agents (esprit_runner). Is the
   length-equality heuristic acceptable for the next 1–2 weeks, or
   should we prioritise P2 ahead of the other agents' work?

3. **P5 → grid `Ci_coef_cos` constant `NUM_NN = 44`:** The constant
   `NUM_NN = 44` (line 54) is "engine ABI" — `nn = note // 2` for note
   ≤ 87 covers a piano range, hence 44. But for a grid where
   `idx_x` runs 0..(n_rows*n_cols - 1), e.g. a 10×10 grid produces
   `idx_x` up to 99 → `nn` up to 49 → silently truncated by `if 0 <=
   nn < NUM_NN` (line 477). The user should confirm whether grid
   layouts > 88 cells are expected (and whether silent truncation is
   acceptable).

4. **Strategy pattern vs functional split:** P1 sketches an
   `ApproximationStrategy` Protocol. The codebase generally avoids
   Protocols (uses ducktype + module functions). Confirm the user is
   OK with introducing a small Protocol here, or prefer plain
   `def select_approximation(layout_type) -> Callable[..., np.ndarray]`.

---

## Appendix — File Inventory & LOC

| File | LOC | Severity (CODE_QUALITY thresholds) |
|------|-----|------------------------------------|
| `pianoid_middleware/modal_adapter/external_export.py` | 662 | **YELLOW** (500–1000) |
| `tests/unit/test_external_export.py` | 724 | YELLOW (test files often run long; defensible) |
| `pianoid_middleware/modal_adapter/modal_adapter.py` | 4837 | RED (pre-existing, not in scope) |
| `pianoid_middleware/modal_adapter/routes.py` | 1724 | RED (pre-existing, not in scope) |
| `PianoidTunner/src/hooks/useModalAdapter.js` | ~2300 | RED (pre-existing, not in scope) |
| `PianoidTunner/src/modules/ModalAdapter.jsx` | ~2200 | RED (pre-existing, not in scope) |

The export-tool code itself sits in YELLOW — defensible for now, but a
file that started at 430 LOC and hit 662 in two iterations (port + bug
fix) is on a clear trajectory toward RED. P1's decomposition pre-empts
that.

## Appendix — Function Sizes in `external_export.py`

| Function | Lines | Verdict |
|----------|-------|---------|
| `extract_signed_shapes_per_chain` | 65–209 (~144) | LONG — split per M1 |
| `approximate_line` | 216–249 (~33) | OK |
| `approximate_planar` | 251–332 (~81) | LONG but cohesive — fix per H3 first |
| `build_export_payload` | 339–597 (~258) | RED — split per H1 |
| `write_export_files` | 600–629 (~30) | OK |
| `export_text_files` | 632–662 (~31) | OK |

CODE_QUALITY says >50 lines is a smell. Two functions are 3–5x over.

## Appendix — Documentation Links

- [MODAL_ADAPTER_GUIDE.md §Export to Text Files](http://localhost:8001/guides/MODAL_ADAPTER_GUIDE/#export-to-text-files-dev-6c54c87f)
- [MODAL_ADAPTER_GUIDE.md §Channel-to-receiver mapping fallback](http://localhost:8001/guides/MODAL_ADAPTER_GUIDE/#channel-to-receiver-mapping-fallback-dev-6c54c87f-decka-fix)
- [MODAL_ADAPTER_GUIDE.md §Mode-shape array layout](http://localhost:8001/guides/MODAL_ADAPTER_GUIDE/#mode-shape-array-layout-subtle-but-important)
- [REST_API.md §POST /modal/projects/&lt;name&gt;/export_text](http://localhost:8001/modules/pianoid-middleware/REST_API/#export-to-text-files-dev-6c54c87f)
- [CODE_QUALITY.md §LOC thresholds](http://localhost:8001/development/CODE_QUALITY/#file-size-loc-thresholds)
- [dev-6c54c87f session log](http://localhost:8001/development/logs/dev-6c54c87f-2026-05-06-144408/)

---

**End of review.** dev-6c54c87f's lock on `external_export.py` is
preserved. No code modified by this pass.
