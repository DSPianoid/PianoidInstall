# I5 UI layout commands: design note (dev-c491)

**Date:** 2026-10-15 · **Agent:** dev-c491 · **Implements:** [assistant-infrastructure proposal §5](../proposals/assistant-infrastructure-2026-10-13.md#5-i5-layout-control-api-fe-command-bus)
**Builds on:** I4 (dev-6026: the command registry, `utils/commandBus.js` with `registerUi`, the launcher
command endpoints). Stacked on the I4 branches.

The lasting contract goes into the Tunner `OVERVIEW.md` ("UI commands (I5)") and REST_API "Commands and jobs".

---

## 1. Decisions

| Item | Decision |
|---|---|
| Where layout state lives | **Per tab, not synced.** The mosaic tree, maximized pane, ties, selection and workbench bindings are view state of ONE page (owned by `useLayout` / `useCurrentValues` / `PianoidTuner`). Two tabs may show different layouts, as today. Syncing them through the backend journal would make one tab's pane clicks rearrange the other tab, which nobody asked for. |
| Who a remote command drives | **The leader tab only** (tab leadership, dev-2d06). The leader registers with the launcher's `/ws/ui-control` relay; followers never register, and a tab also re-checks `isLeader` on receipt (409 `not_leader`). No leader → 503 `no_leader_tab`. |
| Commands | Registry family `ui` (PianoidInstall `schemas/commands/ui.json`): `target: "ui"`, tier `ui` (`ui.snapshot`: tier `read`). The handlers are registered with the I4 bus (`registerUi`) by `hooks/useUiCommands.js`, which calls the EXISTING owners: `useLayout` (maximize / restore / closeMaximized / default), `useWindowManager` (add / remove pane), `PianoidTuner` (named layouts, `activateWorkbenchParam`, `handleOpenWorkbench`), `useCurrentValues` (selection, ties, workbench focus). No new tree surgery: `ui.layout.set` validates the tree and passes it through `ensureGlobalWorkbench`. |
| Local vs remote | In the tab: `commandBus.dispatch('ui.pane.open', {pane: 'Modes'})`. Remote: `POST :3001/api/command/ui.pane.open` (the assistant service lives in the launcher, so it calls the relay in-process later). `POST :5000/command/ui.*` stays 409 `wrong_target`. |
| Results | Each handler waits for React to commit the change, then returns the affected state (for example `{panes, maximized}`), so a caller can chain commands without polling. |
| Validation | Schema pre-flight (bus), then handler checks against live state: unknown pane → 404 `unknown_pane`; opening a pane while one is maximized → 409 `pane_maximized` (restore first); unknown layout name / workbench id → 404; an invalid tree (unknown leaf, duplicate leaf, unbound `Workbench:*` leaf) → 400 `invalid_layout`. |
| Safety | View only (no backend writes). The relay rate-limits at 10 commands/s (429 `rate_limited`). While remote commands arrive, the leader tab shows a chip "Layout driven by <source>" with **Stop**. Stop blocks remote UI commands in this tab (423 `blocked_by_user`) until the user clicks **Allow**. Local dispatches are never blocked. |
| Recording | Every UI command is recorded in the `actionRecorder` with its source (`fe` for local, the relay's `source` for remote). |

## 2. Commands (`ui` family)

| Command | Args | Effect / result |
|---|---|---|
| `ui.snapshot` | — | `{leader, layout, panes, maximized, layoutName, layouts, availablePanes, selection {pitch, pitches, mode, modes, parameter, level}, ties, workbenches}` |
| `ui.pane.open` | `pane` | adds the pane to the layout (window-manager placement) |
| `ui.pane.close` | `pane` | removes it (workbench ids too); closing the maximized pane returns to the multi-pane view |
| `ui.pane.maximize` | `pane` | maximizes it |
| `ui.pane.restore` | — | leaves maximized mode |
| `ui.layout.reset` | — | the default layout |
| `ui.layout.apply_named` | `name` | applies a saved named layout (Manage Layouts) |
| `ui.layout.set` | `layout` (mosaic tree) | replaces the live layout after validation |
| `ui.select.pitch` / `ui.select.mode` | `pitch` / `mode` (or null) | the single selected pitch / mode |
| `ui.select.pitch_range` / `ui.select.mode_range` | `range: [from, to]` or null | the global selection; tied charts zoom to it |
| `ui.select.param` | `groupe`, `name`, `gaussIndex?` | activates a parameter (the global Workbench follows) |
| `ui.select.level` | `level` (pp · p · mf · f · ff) | the velocity level |
| `ui.chart.tie` | `pane`, `tied` | a chart follows the selection (zoom) or shows its full extent |
| `ui.workbench.open` | `groupe`, `name`, `kind?` | spawns a workbench pane, returns its id |
| `ui.workbench.focus` | `id` | makes a workbench's parameter the active one |

Zoom = selection + tie (dev-mwfix): "zoom modes 0–40 in Modes" is `ui.select.mode_range {range: [0, 40]}` with
`ui.chart.tie {pane: "Modes", tied: true}`. There is no separate zoom state.

**Key space (the only data-model fact):** `pitch` and `pitch_range` are MIDI pitch numbers on the piano axis. The
Sound Channels strings axis (output pitches ≥ 128) is SC-local and never follows the global selection.

## 3. Relay (launcher)

`ws://localhost:3001/ws/ui-control`. Tab → launcher: `{type: "register", clientId}` (leader only; re-sent when it
becomes leader, closed when it stops leading). Launcher → tab: `{type: "command", requestId, name, args, source}`;
tab → launcher: `{type: "result", requestId, result}`. The newest registration wins. Timeout 10 s → 504
`ui_timeout`. `POST /api/command/ui.<…>` (the launcher's command endpoint) relays; `GET /api/commands` also lists
the `ui` family.

## 4. Verification

| What | Surface | Pass |
|---|---|---|
| Handlers | Jest (`utils/uiCommands.js` against a fake context) | every command's effect, error codes, tree validation |
| Relay | Node test of the launcher relay module | leader routing, no leader 503, timeout 504, rate limit 429 |
| Live, two tabs | chrome-devtools, worktree CRA + launcher | `POST :3001/api/command/ui.pane.open {pane: "Modes"}` → screenshot shows it in the LEADER tab; the follower is unchanged; `ui.select.mode_range` zooms the tied Modes chart; Stop → 423 |

## 5. Results (Phase 1)

- Jest 1962/1962 (new: `utils/__tests__/uiCommands.test.js`, `hooks/__tests__/useUiCommands.test.jsx`); Core
  `test_command_registry` + `test_command_routes` 21 passed (registry lint + doc anchors cover `ui.json`).
- Live, two tabs (worktree backend + launcher :3001 + CRA :3005): no tab → 503 `no_leader_tab`; `ui.snapshot` of
  the leader; `ui.pane.open Feedback` → the pane appeared in the LEADER only (the follower kept its own layout;
  checked after a separate command because a dev hot-reload re-reads the persisted layout); `ui.select.mode_range
  [0, 40]` + `ui.chart.tie Modes` + `ui.select.param Modes.frequency` → the Workbench showed "Modes · frequency"
  zoomed to modes 0–40; `ui.pane.maximize Strings` / `ui.pane.restore`; `ui.workbench.open Strings.tension` →
  `Workbench:Strings.tension:1` docked under Strings, a second call returned the same id (`changed: false`);
  invalid tree → 400 `invalid_layout`; `:5000/command/ui.*` → 409 `wrong_target`; the chip "Layout driven by
  assistant" appeared; Stop → 423 `blocked_by_user`; Allow → accepted again.
- Found live: the first `afterCommit` (a fixed 300 ms wait) returned the OLD state — a heavy re-render (a zoom
  redraws every tied chart) takes longer, and a passive effect still pending from an earlier commit released the
  waiter early. Fixed with a forced tick render + tick-gated release (the waiter is released only by the commit
  that carries its tick).
