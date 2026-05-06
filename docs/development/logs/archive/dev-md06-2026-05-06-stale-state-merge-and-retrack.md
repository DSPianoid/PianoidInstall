# Dev Session Log

- **Agent:** dev-md06 (respawn after permission-blocked attempt at 14:27Z)
- **Task:** Fix two stale-state bugs reported by user after dev-md05's project-switch fix:
  - **Bug A:** Heatmap doesn't reflect merged chain state after CONNECT
  - **Bug B:** Re-tracking doesn't refresh stab diagram + chain data
- **Started:** 2026-05-06T (respawn)
- **Plan file:** None (orchestrator-supplied prompt with hypotheses)
- **Status:** Step 3 complete — paused for planning approval per workflow

## Context

Same family as dev-md05 (frontend state surviving boundary), different triggers:
- dev-md05 fix: stale state across PROJECT switch (added `currentProject`-keyed useEffect)
- dev-md06 task: stale state across CHAIN MERGE (Bug A) and RE-TRACKING (Bug B)

Coordination:
- dev-3151 holds locks on `useModalAdapter.js`, `ModalAdapter.jsx`, modal_adapter.py, etc.
  Per orchestrator: dev-3151 explicitly held; their WIP stashed by previous dev-md06 attempt
  (stash@{0} on all 3 repos), to be restored at end via Step E.
- Branch base: `dev` on PianoidCore + PianoidTunner (md05's fix already merged: SHA `4e65948` Tunner, `a9ae6eb` Core).

## Step 0–3 Actions

- Stashed locally: dev-3151's WIP already saved to stash@{0} on all 3 repos by prior attempt.
- Checked out `dev` on Tunner + Core, verified clean tree.
- Ran baseline frontend tests: `useChainEditor` 12/12 pass on dev tip.
- Created feature branch `feature/dev-md06-stale-state-merge-and-retrack` on all 3 repos.

## Step 1 — Docs-first findings

Consulted `docs/guides/MODAL_ADAPTER_GUIDE.md` Tracking section (lines 771–897).
Key facts:
- Backend `_tracked_chains` is the authoritative chain store on server.
- `save_edited_chains` is the ONLY path that writes frontend edits back to backend.
- `/modal/grid_heatmap/<chain_id>` reads `_tracked_chains[chain_id].detections`
  (modal_adapter.py:3597–3678, confirmed).
- `mergeChainsMany` (useChainEditor.js:224) commits a multi-source merge in a
  single `setEditedChains` call (dev-md04 fix). No backend round-trip.
- The chains-source priority in StabilizationDiagram is
  `chainEditor?.editedChains || stabilizationData?.chains || chains` (dev-md05's
  doc-comment in ModalAdapter.jsx:202–207).

## Bug A — Heatmap stale after Connect

**Live chrome-devtools evidence (project PlyWoodTake1_4 currently loaded, 276 chains, grid 5×6):**

```
chain 0: 4 detections   {6, 7, 18, 24}
chain 1: 5 detections   {2, 3, 10, 15, 29}
chain 2: 10 detections  {4, 9, 14, 15, 16, 19, 20, 21, 22, 28}
```

If the user selects {0, 1, 2} and clicks Connect:
- `mergeChainsMany(0, [1, 2])` mutates `chainEditor.editedChains` → chain 0 now
  shows 18 unique detections (4 + 5 + 10 minus 1 shared scenario 15 between c1 & c2).
- `onSelectionChange([0])` keeps `selectedChains = [0]`.
- StabilizationDiagram passes `chainId={selectedChains[0]}` to GridHeatmapInset
  (StabilizationDiagram.jsx:2210).
- GridHeatmapInset `useEffect(() => fetch..., [chainId, getGridHeatmap])`
  (GridHeatmapInset.jsx:27–44) — `chainId` is **still 0**, so the effect
  **does NOT re-fire**. The cached pre-merge heatmap (4 cells) remains rendered.
- Even if it DID re-fire: backend `/grid_heatmap/0` reads `_tracked_chains[0]`,
  which is still the original 4-detection chain (verified live —
  `tracking_results` returns `chain[0].detection_count = 4`).

**Root cause (two-layer):**

1. **Frontend cache invalidation gap** — `GridHeatmapInset` only refetches on
   `chainId` change. Merge operations change a chain's detection contents but
   not its id, so the cache stays stale.
2. **Frontend↔backend mirror gap** — even if (1) is fixed, refetching
   `/grid_heatmap/N` from backend gets pre-edit data because edits only land
   server-side at `saveChains`.

**Proposed fix — render the heatmap from frontend `editedChains` directly, with backend as fallback.**

Compute `cells` from `editedChains[chainId].detections` + `mapping.point_coordinates`
+ `mapping.cell_mask` on the frontend, instead of fetching `/grid_heatmap/<id>`.
This needs the per-cell `(row, col)` mapping which the backend already returns
(walk `cell_mask` row-major, zip with sorted `point_coordinates` keys — same
algorithm as modal_adapter.py:3642–3658).

Two viable approaches:

- **Approach A1 (simpler, smaller scope):** Add a `chainDetections` prop to
  `GridHeatmapInset`. When provided, it overrides the per-cell `amplitude`
  values from the backend response. The component still calls `getGridHeatmap`
  ONCE per `chainId` to fetch the cell layout (`grid_shape` + `cells[].row/col/x_mm/y_mm/scenario_index`),
  then re-renders amplitude cells from `chainDetections` whenever it changes.
  This keeps the layout code on the backend (one source of truth for cell↔scenario
  mapping) and only client-overrides the *values*.

- **Approach A2 (full client-side):** Push the entire cell-layout enumeration to
  the frontend. Remove the backend dependency entirely. More LOC, more risk of
  layout-mapping divergence.

A1 is cheaper and safer. Recommended.

**Proposed fix LOC:** ~50 LOC (GridHeatmapInset prop + memo + 2–3 lines in
StabilizationDiagram to pass the selected chain's detections; no backend change).

## Bug B — Re-tracking doesn't refresh stab diagram + chain data

**File:line evidence:**

`ModalAdapter.jsx:400–407` — `handleRunTracking`:

```javascript
const handleRunTracking = async () => {
    await runTracking();
    const stabData = await getStabilizationDiagram();
    if (stabData) setStabilizationData(stabData);
    // Re-init chain editor with fresh tracking chains
    const chains = stages.tracking.data?.chains;          // STALE CLOSURE
    if (chains) chainEditor.initFromServer(chains);       // doesn't fire on re-track
};
```

Two compounding bugs:

1. **Stale closure** — `stages.tracking.data?.chains` is read from the closure
   captured at handler creation time, NOT the version updated by the
   `updateStage("tracking", ...)` call inside `runTracking`. So `chains` is
   either undefined (first run) or stale (subsequent runs).

2. **Auto-init effect blocked by editedChains guard** —
   `ModalAdapter.jsx:232–237`:

   ```javascript
   React.useEffect(() => {
     const chains = stages.tracking.data?.chains;
     if (chains && chains.length > 0 && chainEditor.editedChains === null) {
       chainEditor.initFromServer(chains);
     }
   }, [stages.tracking.data?.chains, chainEditor]);
   ```

   After a previous tracking run, `editedChains` is non-null (initialized from
   the previous chains). When the user re-tracks, `stages.tracking.data?.chains`
   updates → effect fires → guard `editedChains === null` is false → skip.
   New chains never replace old chains in the editor.

   The stabilizationData refresh ALSO doesn't fire automatically, because
   the auto-fetch effect (line 244) is keyed on `stages.esprit.done` (not
   tracking).

**Proposed fix:** in `handleRunTracking`, after `await runTracking()` resolves
successfully, explicitly:

1. Reset chainEditor to allow re-init (call a new `useChainEditor.resetForRetrack`
   that nulls `editedChains` like `resetForProjectSwitch` but preserves
   transient mode state). Actually — `resetForProjectSwitch` already does
   exactly the right thing (nulls editedChains, clears undo, clears transient).
   The mode reset (back to "select") is fine for re-tracking too, since the
   new chains have new IDs.
2. Refetch stab diagram (already done — line 402).

The chain re-init then happens automatically via the existing useEffect at
line 232 (now that the guard passes). No need to read the stale `stages` closure.

**Alternative:** call `runTracking` and have `useModalAdapter` itself signal a
"tracking refreshed" event that the chain editor listens to. Cleaner long-term
but bigger refactor — defer.

**Proposed fix LOC:** ~10 LOC in ModalAdapter.jsx (call `chainEditor.resetForProjectSwitch()`
before re-tracking starts, OR after it completes; remove the broken stale-closure
init line).

## Plan summary for orchestrator/user approval

| Item | Bug A | Bug B |
|------|-------|-------|
| Root cause | Heatmap reads backend `_tracked_chains` (pre-merge); `useEffect` keyed on `chainId` doesn't refire on same-id chain mutation | `handleRunTracking` reads stale `stages` closure; auto-init effect blocked by `editedChains !== null` guard |
| Files touched | `GridHeatmapInset.jsx` (+~30), `StabilizationDiagram.jsx` (+~20 to plumb through) | `ModalAdapter.jsx` (~5 LOC: call `resetForProjectSwitch` from `handleRunTracking`, drop stale-closure read) |
| Tests | New: `GridHeatmapInset.editedChainsOverride.test.jsx` (~3 cases) | New: `ModalAdapter.handleRunTracking.test.jsx` OR a unit test on the chainEditor reset (~2 cases) |
| Backend changes | None | None |
| Total LOC | ~80 LOC + tests | ~10 LOC + tests |

**Open questions for orchestrator/user:**

1. **Approach A1 vs A2 for Bug A.** Recommendation A1 (override amplitudes
   from frontend `editedChains`, keep backend layout). OK?
2. For Bug A, the current behaviour for the **chain tooltip** ("scenario N,
   x=… mm, y=… mm, amplitude: …") shows backend-only data. After A1 the
   amplitude in the tooltip would reflect the merged value. The
   `scenario_index` shown is the **layout's** scenario at that cell — which
   is correct for the merged chain too (a merged chain's detection at
   scenario N is at the same cell as the originally-tracked detection at
   scenario N). Confirm this is the desired UX?
3. For Bug B, **rename `resetForProjectSwitch` to something more general**
   (e.g. `resetForFreshChains`)? It's now used in two places. Or add a thin
   alias? Lean toward keeping the current name and adding a one-line
   comment on the new caller — minimal churn.

**Awaiting orchestrator/user approval before Step 4 (implementation).**
