# Dev Session Log

- **Agent:** dev-wbspawn (orphan-fix follow-up)
- **Task:** FIX "fixed workbench orphaned after layout switch" — (a) stop the L1263 prune effect deleting bindings on a config switch; (c) auto-snapshot active config's workbench bindings on spawn (frozen-config gap)
- **Started:** 2026-06-19T14:10:00Z
- **Plan file:** None
- **Status:** In Progress
- **Worktree:** D:/repos/wt-wbspawn (branch feature/dev-wbspawn-orphan-fix off PianoidTunner dev acbf9e6)

## Actions

[STEP-0-COMPLETE] 2026-06-19T14:10:00Z

### Step 1: Context (already investigated) — 2026-06-19T14:10:00Z
- ROOT CAUSE (reported + greenlit): PianoidTuner.js L1263-1271 `useEffect([layout])` prunes the live `workbenches` map (closeWorkbench for any binding whose pane id is not in the current layout) — on a config switch it deletes the OTHER config's bindings. The genuine pane-CLOSE path already cleans up via removeWindowFromLayout → closeWorkbench (L991-992), so the layout-keyed prune is redundant for close + harmful for switch.
- Binding mechanism: fixed WB = dynamic pane `Workbench:<groupe>.<name>[-<g>]:<counter>`; link lives in `workbenches[id]` map (useCurrentValues), persisted per-config in mosaicConfigWorkbenches via pickWorkbenchBindings (save) / restoreWorkbenches (load, MERGE).
- Secondary: frozen configs don't auto-snapshot a newly-spawned WB into the active config's binding map (only explicit Save does) → (c).
[PROGRESS] 2026-06-19T14:10:00Z step=1 note="root cause known + greenlit; implementing (a)+(c)"

### Step 1b: Environment control — 2026-06-19T14:12:00Z
- Frontend-only audio_off. Worktree wt-wbspawn on feature/dev-wbspawn-orphan-fix off dev acbf9e6, node_modules junction valid. Shared stack may be user-launched; I run my own CRA on 3011 if a live check is needed (chrome-devtools is DOWN per brief → Jest + reasoning is the gate).
[LOCK ACQUIRED] PianoidTunner/src/PianoidTuner.js

### Step 4: Design refinement (P2) — 2026-06-19T14:18:00Z
- DEEPER FINDING beyond the report: the L1263 `useEffect([layout])` prune is the GC for the PRIMARY close path too — the mosaic X button calls `mosaicActions.remove(path)` (react-mosaic internal) → setLayout → the effect GC'd the binding. `removeWindowFromLayout` (L992 closeWorkbench) is only the CHECKBOX/visibility path, NOT the X button. AND the effect ALSO mis-fires on `handleMaximize` (sets layout=single leaf → every other pane transiently absent) and on config switch — both transient-absence, not close. So the effect cannot distinguish close from transient-absence using the live layout alone.
- DECISION (a, robust): DELETE the layout-watching prune effect + make binding-GC EXPLICIT at the two user-close sites: the X button's onClick — non-maximized branch (mosaicActions.remove) and maximized branch (closeMaximized) — both call closeWorkbench(id) for a dynamic Workbench:* pane. This GCs exactly on real close, never on switch/maximize/default-layout. (P1: the close action is the sole writer that should delete a binding; an effect watching derived layout state is the wrong owner.)
- DECISION (c): in handleOpenWorkbench, after spawning, snapshot the active config's CURRENT workbench bindings (the just-added one included) into mosaicConfigWorkbenches[activeMosaicConfig] + persist — so a WB spawned in config A survives switch-away-and-back even without an explicit Save (frozen-config gap). Uses pickWorkbenchBindings against the NEW layout + the new binding.

## Data Model Card — 2026-06-19T14:18:00Z

| Fact the fix relies on | Doc citation | Inferred-only? |
|---|---|---|
| Dynamic WB binding lives in workbenches[id] (useCurrentValues); NOT in layout tree | useCurrentValues.js L64-74 (read); pianoid-tunner OVERVIEW "Savable mosaic layouts" workbench-bindings note | N |
| Mosaic X button close = mosaicActions.remove(path) (non-max) / closeMaximized(id) (max); neither calls closeWorkbench today — the L1263 effect was the GC | PianoidTuner.js L2910-2920 + L1263-1271 (read this session) | N |
| removeWindowFromLayout (checkbox/visibility path) already GCs via closeWorkbench L992 | PianoidTuner.js L990-993 (read) | N |
| handleMaximize sets layout to a single leaf id (other panes transiently absent) | useLayout.js handleMaximize + closeMaximized L170-175 (read) | N |
| Per-config bindings persist via pickWorkbenchBindings(workbenches, layout) → mosaicConfigWorkbenches[name]; restoreWorkbenches MERGES on load | mosaicConfigStore.js L95-102; PianoidTuner.js L1062,1078-1083 (read) | N |
| activeMosaicConfig names the live config; workbenchesRef.current mirrors the live workbenches map without stale closure | PianoidTuner.js L821,826-829 (read) | N |

[DMC-COMPLETE]
[PROGRESS] 2026-06-19T14:18:00Z step=4 note="DMC done; deleting prune effect + explicit close-GC + spawn auto-snapshot"

### Step 4: Edits — 2026-06-19T14:30:00Z (worktree wt-wbspawn)
[EDIT] file=src/PianoidTuner.js — (a) DELETED the L1263 layout-watching prune useEffect; added explicit closeWorkbench(id) for dynamic WB in the pane Close (X) onClick (both maximized + non-maximized branches). (c) handleOpenWorkbench now computes nextLayout via the pure transform (appendToScreenBottom / dockUnderPanel) + setLayout, then auto-snapshots pickWorkbenchBindings(nextBindings, nextLayout) into mosaicConfigWorkbenches[activeMosaicConfig] + persists. Removed now-unused addPanelBottomToLayout wrapper (logic inlined where the return value is needed). addBottomPinnedToLayout kept (used by addWindowToLayout). useCallback deps updated (+activeMosaicConfig, +mosaicConfigWorkbenches).
[EDIT] file=src/hooks/__tests__/mosaicConfigStore.test.jsx — NEW describe "workbench binding survives a config switch (orphan-fix)": A->B->A preserves A's binding; the REMOVED prune would have orphaned it; restore from empty (reload); spawn-in-A auto-snapshot survives switch-away-and-back.
[FILE-LOC] src/PianoidTuner.js before=3620(at-merge) after=3656 (net +36: -10 prune effect, +~30 spawn snapshot + close-GC, -6 wrapper)
[PROGRESS] 2026-06-19T14:30:00Z step=5 note="running targeted + full Jest + CRA build"

### Step 5/6: Tests + build — 2026-06-19T14:40:00Z
[BASELINE-TEST] 2026-06-19T14:40:00Z result=pass perf_log=jest-full note="frontend-only; baseline = pre-edit suite green"
- Targeted: mosaicConfigStore (incl. 4 NEW orphan-fix tests) + useLayout.closeMaximized = 40/40 PASS (closeMaximized regression guard confirms close path intact).
- FULL Jest: 119 suites / 1254 tests ALL PASS (+4 new, ZERO regressions).
- CRA production build = "Compiled successfully." → eslint gate PASS (deleted prune effect + removed addPanelBottomToLayout wrapper leave no unused-var; useCallback deps clean).
[REGRESSION-CHECK] 2026-06-19T14:40:00Z scope=frontend-jest verdict=pass note="0 regressions, +4 new; chrome-devtools DOWN so no live click-through (user live-tests on dev per workflow)"
[PROGRESS] 2026-06-19T14:40:00Z step=8 note="docs then commit+merge"

### Step 8 + 10a Phase 1 — 2026-06-19T14:50:00Z
[STEP-8-COMPLETE] 2026-06-19T14:50:00Z docs_touched="docs/modules/pianoid-tunner/OVERVIEW.md"
- OVERVIEW: NEW "★Bindings survive a config switch — prune-on-switch removed + spawn auto-snapshot (dev-wbspawn)" para under the dev-mosaicref workbench-bindings note.
- COMMITTED feature/dev-wbspawn-orphan-fix 9ac5002 (1 commit beyond dev acbf9e6).
[STEP-10A-PHASE-1] 2026-06-19T14:50:00Z commit=9ac5002
[LOCK RELEASED] PianoidTunner/src/PianoidTuner.js
- ★MERGE BLOCKED on checkout: dev is NOT checked out anywhere — the MAIN PianoidTunner checkout is on feature/dev-pitchfix-exc-restructure with UNCOMMITTED dev-mosaicsave excitation work (Excitation*.jsx, MatrixTools.jsx dirty). Cannot `git checkout dev` there without clobbering dev-mosaicsave's active edits. Coordinating: dev-mosaicsave rebases onto my fix (team-lead's plan) OR commits/stashes so the merge can run in the main checkout. Reported to team-lead + dev-mosaicsave. Branch 9ac5002 is ready; lock released so dev-mosaicsave can proceed.

### Step 10a Phase 2 — 2026-06-19T15:05:00Z (team-lead authorized merge in own worktree)
[STEP-10A-PHASE-2] 2026-06-19T15:05:00Z
- team-lead clarified dev is checked out NOWHERE → merged in MY worktree without touching the main checkout (dev-mosaicsave's dirty branch):
  git checkout dev (free) → pull --no-rebase origin dev (Already up to date, off acbf9e6) → merge --no-ff feature/dev-wbspawn-orphan-fix → push origin dev → checkout back to feature branch (leaves dev free for dev-mosaicsave).
- MERGED + PUSHED: PianoidTunner dev acbf9e6..62974f6 (origin/dev = 62974f6). Merge commit 62974f6 (9ac5002 --no-ff).
- Pinged dev-mosaicsave to rebase its excitation restructure onto new dev + restart :3000 (CRA won't hot-reload a git merge). Orphaning task COMPLETE; HOLD + stand ready to partner on mass→workbench-link.
