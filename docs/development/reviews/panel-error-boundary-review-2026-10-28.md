# Per-panel error boundary — review (dev-ebnd1, 2026-10-28)

**Branch:** Tunner `feature/dev-ebnd1-panel-error-boundary` (a06a809, from `dev` 908e500) · Install docs on the same branch name. **Not merged, not pushed.**

## Why
2026-10-25: an HMR hot-swap made the Assistant pane throw ("Should have a queue"). With no error boundary, React unmounted the whole root → blank page, and the `:5000` / `:3002` sockets closed.

## Change
| File | Change |
|---|---|
| `src/components/PanelErrorBoundary.jsx` (NEW, ~95 LOC) | Class boundary: `getDerivedStateFromError` + `componentDidCatch` (console.error with panel id + component stack). MUI crash box: title, message, Show/Hide stack (`Collapse`), **Reload panel** (clears error, bumps `resetKey` on a keyed Fragment → remount). |
| `src/components/PanelTile.jsx` (NEW, ~40 LOC) | The extracted `renderTile` output: `MosaicWindow` (unchanged props) → `PanelErrorBoundary` → `PanelBody` (calls `renderContent()` below the boundary). |
| `src/PianoidTuner.js` (4783 → 4779 LOC) | `renderTile` returns `<PanelTile … renderContent={() => renderWindowContent(id)} />`; drops the now-unused `MosaicContext`/`MosaicWindow` imports. |
| `src/components/__tests__/PanelErrorBoundary.test.jsx` (NEW) | 3 tests via the real `PanelTile` (react-mosaic stand-in, as in the perf harness). |

## Where the wrap happens
One place: every mosaic pane's **body**, inside its `MosaicWindow` (title bar stays usable on crash). The tile's direct DOM child is still the `MosaicWindow` (dev-ae2a geometry guard passes).

## Unguarded (a throw still blanks the page)
App shell (`PianoidTuner` render itself — incl. pane titles + toolbar controls built per tile), `ToolBar`, `BottomBar`, `TabLeaderBanner`, `UiRemoteChip`, dialogs (MIDI, BugReport, MosaicConfigManager, GlobalSettings), Snackbar/Backdrop. No panel renders outside the mosaic (MIDI is a dialog, not a pane).

## Caveats
- The Assistant's `:3002` socket lives in `useAssistant` **inside** `AssistantPane`, so it closes while that pane is crashed; Reload panel reconnects. The `:5000` socket (PianoidTuner hooks) survives.
- An HMR "Should have a queue" crash may recur on reload until the page is reloaded (stale hook module) — the boundary contains it to the pane.
- In dev, CRA's error overlay still pops for caught errors (dismissable); production shows only the crash box.

## Verification
- Jest (`--maxWorkers=2`, targeted): `PanelErrorBoundary.test.jsx` 3/3 pass (no-throw unchanged; one pane throws → other pane + crashed pane's toolbar render, crash box + console.error; Reload → remount count 1→2, local state reset). `workbenchTileGeometry.source` + `toolbarOverflow.source` 7/7 pass.
- ESLint (CRA config) on the 3 source files: 0 errors (pre-existing warnings only).
- **No visual/live check**: the user's live stack runs from the main checkout; no CRA compile was started.
