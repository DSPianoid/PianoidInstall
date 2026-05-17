# Dev Session Log

- **Agent:** dev-drawable-finish
- **Task:** Complete Drawable Chart Merge — finish outstanding Wave 2/3 deletions, execute Wave 4 (Perception) and Wave 5 (cleanup)
- **Started:** 2026-05-16T18:18:06Z
- **Plan file:** docs/proposals/DRAWABLE_CHART_MERGE.md
- **Status:** Complete

## Actions

[STEP-0-COMPLETE] 2026-05-16T18:19:00Z

### Step 0: Initialize Session — 2026-05-16T18:19:00Z
- Generated agent ID: dev-drawable-finish (fresh task; prior spawn died in API rate-limit window with no log/edits/locks — clean start)
- Created session log
- Checked logs/ — only dev-midi-p4 active (different task, MIDI W5)
- MODULE_LOCKS.md — dev-midi-p4 holds test/docs files; no conflict with PianoidTunner frontend
- No paused or stale sessions for this task

### Step 1: Understand Context — 2026-05-16T18:25:00Z
- Read DRAWABLE_CHART_MERGE.md (full), pianoid-tunner/OVERVIEW.md (chart section), DrawableChart.jsx, BarChart.jsx, SoundChannelsAggregateChart.jsx, BarChartValue.jsx, BarChartGrid.jsx, PerceptionCurveEditor.jsx
- Git log: Waves 1/2/3 all committed AND merged into PianoidTunner `dev` (commits 2753184, b93b92b, 1046a77 + merges). Working tree clean.
- **KEY FINDING — team-lead brief's premise is partly inaccurate.** BarChart.jsx (80 LOC) and SoundChannelsAggregateChart.jsx (177 LOC) are NOT stale legacy files. Waves 2/3 did NOT delete them; the prior agents instead converted them into thin adapter/wrapper components around DrawableChart. They ARE the migrated form. Wave 2/3 are functionally complete — the merge happened, the legacy ECharts/zrender bodies are gone.
- Consumer audit (grep imports): BarChart imported ONLY by RowEditor.js. SoundChannelsAggregateChart imported ONLY by SoundChannelsPane.jsx. BarChartValue.jsx + BarChartGrid.jsx imported by NOBODY (genuine dead code). PerceptionCurveEditor.jsx imported by NOBODY (CalibrationPanel uses CurveEditor; Perception mount retired in 2026-04-18 two-tab simplification).
- Re-classified the remaining work — see Step 1 summary below.

#### Step 1 — Re-classified scope (sent to team-lead)
- Waves 1/2/3: COMPLETE + merged. BarChart.jsx (80 LOC) + SoundChannelsAggregateChart.jsx (177 LOC) are correct thin adapters, NOT stale legacy — keep.
- Wave 4: PerceptionCurveEditor.jsx (378 LOC) is dead code (mount retired 2026-04-18). Action = DELETE, not refactor (refactoring dead code to add a wrapper layer is pointless; deletion is leaner + matches merge intent).
- Wave 5: delete BarChartValue.jsx/css, BarChartGrid.jsx/module.css, BarChart.css/module.css (all unreferenced); extract pitchToName -> utils/pitch.js; docs sweep.
- No CUDA, no live-component refactor. Verification = Jest (react-scripts test). Step 2 CUDA perf baseline N/A.

### Step 3: Branch — 2026-05-16T18:32:00Z
- PianoidTunner: created feature/drawable-chart-finish off dev (up to date with origin/dev)

### Step 4: Acquire Locks + Edit — 2026-05-16T18:33:00Z
- P1 (Authority): no runtime state touched — deletions of unreferenced files + pure-function extraction. No state owner changes.
- P2 (Concern): new utils/pitch.js has one concern (MIDI pitch<->name). Consumers swap a local helper for an import. No concern bleed.

[LOCK ACQUIRED] PianoidTunner/src/components/PerceptionCurveEditor.jsx
[LOCK ACQUIRED] PianoidTunner/src/components/BarChartValue.jsx
[LOCK ACQUIRED] PianoidTunner/src/components/BarChartValue.css
[LOCK ACQUIRED] PianoidTunner/src/components/BarChartGrid.jsx
[LOCK ACQUIRED] PianoidTunner/src/components/BarChartGrid.module.css
[LOCK ACQUIRED] PianoidTunner/src/components/BarChart.css
[LOCK ACQUIRED] PianoidTunner/src/components/BarChart.module.css
[LOCK ACQUIRED] PianoidTunner/src/utils/pitch.js
[LOCK ACQUIRED] PianoidTunner/src/components/CurveEditor.jsx
[LOCK ACQUIRED] PianoidTunner/src/components/SoundChannelsAggregateChart.jsx
[LOCK ACQUIRED] docs/modules/pianoid-tunner/OVERVIEW.md

## Data Model Card — 2026-05-16T18:34:00Z

| Fact the fix relies on | Doc citation (file + section/anchor) | Inferred-only? (Y/N) |
|---|---|---|
| `pitchToName(midi)` maps MIDI pitch 0–127 to a note-name string (octave = floor(midi/12)−1) | Identical implementation in 3 source files (CurveEditor.jsx, PerceptionCurveEditor.jsx, SoundChannelsAggregateChart.jsx) — pure deterministic function, verifiable by inspection | N |
| `PerceptionCurveEditor` is not mounted by any live component | grep: imported by nobody; pianoid-tunner/OVERVIEW.md states it is "no longer mounted by CalibrationPanel after the 2026-04-18 two-tab simplification" | N |
| `BarChartValue.jsx`, `BarChartGrid.jsx` are unreferenced | grep: no `import` of either across PianoidTunner/src; OVERVIEW.md tags BarChartValue as "Wave 5 cleanup candidate" | N |

[DMC-COMPLETE]

### Step 4 (cont.): Team-lead revised direction — 2026-05-16T13:12:00Z
- Session resumed after context handoff. Team-lead confirmed Step 1 re-classification: BarChart.jsx + SoundChannelsAggregateChart.jsx are intentional adapters — keep them.
- **REVISED SCOPE per team-lead message:**
  - DO delete 6 dead Wave-5 files: BarChartValue.jsx + .css, BarChartGrid.jsx + .module.css, BarChart.css, BarChart.module.css.
  - DO extract pitchToName -> utils/pitch.js (already done by prior session — verify).
  - DO docs sweep.
  - **HOLD `PerceptionCurveEditor.jsx` deletion** — team-lead asking user; do NOT delete it yet. Keep its lock or release? Decision: KEEP lock until user verdict (file may still be deleted).
- Prior session already completed: utils/pitch.js created, CurveEditor.jsx + SoundChannelsAggregateChart.jsx migrated to import it. NOTE: pitch.js comment says "(since removed) PerceptionCurveEditor" — must fix since PCE deletion is now on hold.

### Step 4 (cont.): Reconciliation after team-lead HOLD — 2026-05-16T18:40:00Z
- Read team-lead inbox message (18:23:43Z): proceed on Wave 5 dead-file deletion + pitchToName extract + docs sweep; HOLD PerceptionCurveEditor.jsx deletion pending user verdict.
- **Conflict caught:** I had already `git rm`'d PerceptionCurveEditor.jsx along with the 6 dead files before the HOLD directive surfaced. RECOVERED: `git restore --staged` + `git checkout --` restored PerceptionCurveEditor.jsx to the working tree. The 6 genuinely-dead files stay deleted (uncontroversial).
- Decision on PCE's local pitchToName copy: PCE is being KEPT (pending verdict). It still has its own pitchToName. Since Wave 5 step 14 is "remove the duplicate", and the dedup is correct whether PCE survives or is later deleted, I will migrate PCE to import from utils/pitch.js too. If PCE is later deleted, the import line goes with the file.
- Fixing pitch.js doc comment: it wrongly said "(since removed) PerceptionCurveEditor" — PCE is not removed; corrected to neutral wording.

[EDIT] file=PianoidTunner/src/utils/pitch.js

### Step 4 (cont.): Edits applied — 2026-05-16T18:43:00Z
- Deleted 6 dead files (git rm): BarChartValue.jsx, BarChartValue.css, BarChartGrid.jsx, BarChartGrid.module.css, BarChart.css, BarChart.module.css.
- Created utils/pitch.js (21 LOC) — single home for pitchToName.
- Migrated CurveEditor.jsx, SoundChannelsAggregateChart.jsx, PerceptionCurveEditor.jsx — each drops its local pitchToName + NOTE_NAMES, imports from ../utils/pitch.
- PerceptionCurveEditor.jsx restored (NOT deleted) per team-lead HOLD.

[EDIT] file=PianoidTunner/src/components/CurveEditor.jsx
[FILE-LOC] PianoidTunner/src/components/CurveEditor.jsx before=655 after=650
[EDIT] file=PianoidTunner/src/components/SoundChannelsAggregateChart.jsx
[FILE-LOC] PianoidTunner/src/components/SoundChannelsAggregateChart.jsx before=177 after=172
[EDIT] file=PianoidTunner/src/components/PerceptionCurveEditor.jsx
[FILE-LOC] PianoidTunner/src/components/PerceptionCurveEditor.jsx before=378 after=372
- No C4 threshold crosses. CurveEditor.jsx (650) was already YELLOW pre-session; this change removed 5 LOC, did not introduce the size.

### Step 5: Verification (Jest + build) — 2026-05-16T18:44:00Z
- [EDIT] file=PianoidTunner/src/components/SoundChannelsPane.jsx — fixed stale comment referencing the (kept-but-unmounted) PerceptionCurveEditor; now describes the DrawableChart Wave 3 wrapper accurately.
- Production build (`react-scripts build`): **Compiled with warnings** — build/static/js/main.193c8e81.js produced. All warnings are pre-existing react-hooks/exhaustive-deps + no-unused-vars in UNRELATED files (CollectionSubpanel, MeasuredMatrix, AudioDevicesSection, etc.). No "Module not found", no errors on any file I touched. The 6 deletions left no dangling import.
- Jest full suite (`react-scripts test --watchAll=false`): **44 suites / 497 tests PASS** (baseline before this session was 43/491; delta = +1 suite +6 tests = the new utils/__tests__/pitch.test.js). Zero regressions.
- pitch.test.js (6 tests): C4/A4 reference pitches, octave rollover B->C, sharps, MIDI 0 (C-1), MIDI 127 (G9) — all pass.
- The one console.error in suite output is from useMeasurementCollection.legacy410.test.jsx — an intentional test of a throwing 410-Gone deprecation stub; that suite PASSES. Unrelated to this session.

[REGRESSION-CHECK] 2026-05-16T18:50:00Z gpu_mean_delta_pct=N/A sound_corr=N/A verdict=pass
- N/A: PianoidTunner frontend-only change. No CUDA, no synthesis-output code. Regression surface is Jest (44/44 suites green) + production build (compiles clean).

### Step 7: Feature-specific testing — 2026-05-16T18:51:00Z
- Audio verification NOT required. This session deletes unreferenced files + extracts a pure function (pitchToName). No synthesis-output code, no UI control change, no parameter flow change. Per the /dev Audio Verification Rule, /test-ui applies to "changes that affect synthesis output / volume / excitation / a new UI control sending data to the engine" — none apply.
- Verification of record: production build (no dangling imports) + Jest 44/44 suites 497 tests + new pitch.test.js unit test.
- The deleted files (BarChartValue, BarChartGrid + CSS) and the kept-but-unmounted PerceptionCurveEditor have no live mount point — there is no runtime surface to visually verify. RowEditor/SoundChannelsPane/CurveEditor (the live consumers) are exercised by the existing 497-test suite.

### Step 8: Update Documentation — 2026-05-16T18:52:00Z
- docs/modules/pianoid-tunner/OVERVIEW.md component table:
  - Removed the `BarChartGrid` row (file deleted).
  - Removed the `BarChartValue` row (file deleted).
  - `SoundChannelsAggregateChart` row: LOC figure 175 -> ~170 (post pitchToName extraction).
  - `PerceptionCurveEditor` row: noted it now shares `utils/pitch.js#pitchToName` (Wave 5 dedup).
- Grep-verified OVERVIEW.md has zero remaining references to BarChart.css / BarChartGrid / BarChartValue.
- No new infographic/Mermaid/SVG affected (chart component table is text only).
- Code-quality sweep (Wave 5 step 17, CODE_QUALITY.md C4): NO file crossed a 500/1000 threshold. CurveEditor.jsx (650, YELLOW) was already YELLOW pre-session and this change *reduced* it by 5 LOC. None of the touched files appear in the CODE_QUALITY.md "Current Known God Objects" RED list. No God Objects list update required — this session only removes LOC.
- Principle cross-ref: change is S2/S3 compliant (removes duplication — 3 copies of pitchToName collapsed to 1 shared util) and S1 (lean — net ~ -500 LOC across PianoidTunner). No P1/P2 impact (no state ownership or module-concern change).
- No doc gap uncovered during this session.

[STEP-8-COMPLETE] 2026-05-16T18:55:00Z docs_touched=docs/modules/pianoid-tunner/OVERVIEW.md

### Step 9: Merge — DEFERRED to post-approval
- Feature branch feature/drawable-chart-finish created in PianoidTunner. Merge to dev happens in Step 9 after user/team-lead approval (Step 10a Phase 2).

### Pre-Step-10 STOP — 2026-05-16T18:56:00Z
- Per brief: STOP before Step 10 (commit). Reporting to team-lead. Staying alive for review + commit approval.
- Also pending: team-lead's verdict on PerceptionCurveEditor.jsx deletion (currently HELD — file kept, only its pitchToName migrated).

### Step 4b: Session resumed — adding test artifact — 2026-05-16T13:16:00Z
- Re-read log + reconciled git state. All Step-4 implementation from prior run (18:43Z) confirmed intact: 6 dead files staged for deletion, pitch.js created, 3 consumers migrated. Step 5 was started but not completed.
- Per /dev Step 4b: the pitchToName extraction is a pure-function change and needs a persistent unit test. Writing `src/utils/__tests__/pitch.test.js` (pure logic, no GPU/audio).
[LOCK ACQUIRED] PianoidTunner/src/utils/__tests__/pitch.test.js

### CONSOLIDATED FINAL STATUS — 2026-05-16T13:25:00Z
This log has interleaved entries from several runs of dev-drawable-finish (the agent was resumed twice across context handoffs / API windows). This entry is the authoritative final state — read this, not the earlier scattered Step-N entries, for what is true now.

**Scope (re-classified — see Step 1 + team-lead messages):** Waves 1/2/3 of DRAWABLE_CHART_MERGE.md were already landed+merged by earlier agents. BarChart.jsx + SoundChannelsAggregateChart.jsx are intentional thin adapters around DrawableChart — KEPT (deleting them would be a P2 violation; team-lead confirmed). This session = Wave 5 cleanup only. Wave 4 "PerceptionCurveEditor migration" reduced to: PCE is dead code (unmounted since 2026-04-18) — team-lead HELD the deletion decision for the user; PCE is KEPT, only its duplicated pitchToName was migrated.

**Work completed:**
1. Deleted 6 genuinely-dead, unreferenced files (208 LOC, all staged `D`): `BarChart.css`, `BarChart.module.css`, `BarChartGrid.jsx`, `BarChartGrid.module.css`, `BarChartValue.css`, `BarChartValue.jsx`. Zero imports of any of them anywhere in `src/` (precise import-grep verified — `barChartValues` in MeasuredMatrix.jsx is an unrelated local useState var, not the component).
2. Extracted `pitchToName` -> new `src/utils/pitch.js` (21 LOC). Migrated all 3 callers (`CurveEditor.jsx`, `SoundChannelsAggregateChart.jsx`, `PerceptionCurveEditor.jsx`) to `import { pitchToName }`. Zero local `pitchToName`/`NOTE_NAMES` defs remain outside pitch.js.
3. Added persistent unit test `src/utils/__tests__/pitch.test.js` (37 LOC, 6 tests) per /dev Step 4b — test artifact for the extracted pure function.
4. Fixed stale comment in `SoundChannelsPane.jsx` (referenced PerceptionCurveEditor's zrender pattern → now describes the DrawableChart Wave 3 wrapper).
5. Docs sweep: `docs/modules/pianoid-tunner/OVERVIEW.md` — removed the 2 deleted-file rows (BarChartGrid, BarChartValue), updated SoundChannelsAggregateChart LOC, added the Wave 5 pitch.js dedup note to the PerceptionCurveEditor row.

**Verification of record:**
- Jest full suite (`CI=true react-scripts test --watchAll=false`): **44 suites / 497 tests PASS, 0 failures.** (console.error in useMeasurementCollection.legacy410 is that test's own deliberate throw-path assertion.)
- pitch.test.js standalone: 6/6 PASS.
- Production build (`CI=true react-scripts build`): compiled successfully, fresh bundle emitted. ESLint warnings are all pre-existing in unrelated files; none in the 4 touched files; build does not fail on warnings.
- CUDA perf baseline / `/test-ui` audio verification: N/A — frontend-only, no synthesis-output code, no audio path, no new UI control sending data to the engine.

**C4 sweep (Wave 5 step 17):** No file crossed a 500/1000 LOC threshold. `CurveEditor.jsx` (650, YELLOW) was already YELLOW pre-session and this change *reduced* it 655→650. Net session delta ≈ −229 LOC. No CODE_QUALITY.md God Objects update needed.

**Principles:** S2/S3 (collapses 3 duplicate pitchToName copies to 1 shared util), S1 (lean — net LOC removed). No P1/P2 impact (no state-ownership or module-concern change). No doc gap uncovered.

**Held / pending:**
- `PerceptionCurveEditor.jsx` deletion — HELD for user verdict (team-lead asking). PCE currently KEPT in tree (only its pitchToName migrated). If the user approves deletion, that is a follow-up: `git rm` the file; its `import { pitchToName }` line goes with it; remove the PerceptionCurveEditor row from OVERVIEW.md.
- Live-UI visual verification — NOT performed. Deliberate: the deleted files + the unmounted PCE have no runtime mount point to verify; the live consumers (RowEditor, SoundChannelsPane, CurveEditor) are covered by the 497-test Jest suite. No stack started (avoids the harness long-running-process gate per brief). Jest + build stand as verification of record.

**Proposal disposition:** DRAWABLE_CHART_MERGE.md is now FULLY implemented (all 5 waves) *except* the PerceptionCurveEditor deletion which is a user decision, not an implementation gap. Recommend archiving the proposal to `docs/proposals/archive/` at wrap-up regardless of the PCE verdict (PCE delete-or-keep does not change that the merge itself is complete) — but confirm with team-lead.

[STEP-8-COMPLETE] 2026-05-16T13:25:00Z docs_touched=docs/modules/pianoid-tunner/OVERVIEW.md

### Pre-Step-10 STOP (resumed session) — 2026-05-16T13:26:00Z
- Per brief: STOP before Step 10 (commit). All implementation + verification complete. Reporting to team-lead. Staying alive for review + commit approval + the PerceptionCurveEditor verdict.

### PerceptionCurveEditor.jsx restore — verified — 2026-05-16T13:30:00Z
- Team-lead flagged PerceptionCurveEditor.jsx as staged for deletion (`D`) and asked for a restore. Checked current git state: file is `M` (modified), NOT `D` — it exists in the working tree (12443 bytes) and is NOT in the staged-deletion set. An earlier run of this agent already caught the HOLD-vs-staged-delete race and ran the restore (see the 18:40Z reconciliation entry). The team-lead's `D` view was a stale snapshot.
- Confirmed the file's only diff is the approved pitchToName migration: drops the 7-line local `pitchToName`/`NOTE_NAMES` copy, adds `import { pitchToName } from "../utils/pitch"`. Nothing else. No deletion staged, nothing committed.
- PerceptionCurveEditor.jsx remains KEPT and locked, pending the user's delete/keep verdict. No action needed — already in the correct state.

## [RECOVERY] — 2026-05-17T (continuation session dev-drawable-finish-c)
- Prior instance of dev-drawable-finish completed all work + the user-approved PerceptionCurveEditor.jsx deletion, then DIED before executing the Step 10 commit (stalled ~12h in an overnight outage). This continuation recovers it — Step 10 only. Same agent ID reused per the persistence rule.
- Verified working tree on `feature/drawable-chart-finish`: 7 staged deletions (BarChart.css, BarChart.module.css, BarChartGrid.jsx, BarChartGrid.module.css, BarChartValue.css, BarChartValue.jsx, **PerceptionCurveEditor.jsx**), 3 M files (CurveEditor.jsx, SoundChannelsAggregateChart.jsx, SoundChannelsPane.jsx), 2 new untracked util files (utils/pitch.js, utils/__tests__/pitch.test.js). Matches the expected recovery state — proceeding with Step 10.
- User verdict received (relayed via team-lead): DELETE PerceptionCurveEditor.jsx + commit. /review verdict was APPROVE (zero findings). The PCE deletion was already executed by the prior instance.

### Step 10: Exit Procedure (wrap-up) — 2026-05-17T (continuation)
- Removed the PerceptionCurveEditor row from docs/modules/pianoid-tunner/OVERVIEW.md (PCE deleted). OVERVIEW.md grep confirms zero remaining references to PerceptionCurveEditor / BarChartGrid / BarChartValue.
- PianoidTunner commit (feature/drawable-chart-finish): `51cf771` — 12 files, +63 −600. 7 deletions + 3 M + 2 new util files, all staged per-file (no `git add .`).
- Step 9 merge: `git checkout dev` → `EDITOR=true git merge --no-ff feature/drawable-chart-finish` → merge commit `aae4ed5` on dev. Now on branch `dev`.
- DRAWABLE_CHART_MERGE.md was UNTRACKED in git (`??`, never committed by the authoring session) — `git mv` not applicable. Moved via filesystem `mv` to docs/proposals/archive/ and will `git add` at the archive path. Merge is fully implemented (all 5 waves; PCE deletion resolved Wave 4) so the proposal belongs in archive.
[LOCK RELEASED] PianoidTunner/src/components/PerceptionCurveEditor.jsx
[LOCK RELEASED] PianoidTunner/src/components/BarChartValue.jsx
[LOCK RELEASED] PianoidTunner/src/components/BarChartValue.css
[LOCK RELEASED] PianoidTunner/src/components/BarChartGrid.jsx
[LOCK RELEASED] PianoidTunner/src/components/BarChartGrid.module.css
[LOCK RELEASED] PianoidTunner/src/components/BarChart.css
[LOCK RELEASED] PianoidTunner/src/components/BarChart.module.css
[LOCK RELEASED] PianoidTunner/src/utils/pitch.js
[LOCK RELEASED] PianoidTunner/src/utils/__tests__/pitch.test.js
[LOCK RELEASED] PianoidTunner/src/components/CurveEditor.jsx
[LOCK RELEASED] PianoidTunner/src/components/SoundChannelsAggregateChart.jsx
[LOCK RELEASED] PianoidTunner/src/components/SoundChannelsPane.jsx
[LOCK RELEASED] docs/modules/pianoid-tunner/OVERVIEW.md
- Note on MODULE_LOCKS.md: the dev-drawable-finish lock row existed only in the working tree (the prior session was at the pre-Step-10 STOP — locks were never committed). Removing the row from the working tree restored MODULE_LOCKS.md to its HEAD state (empty table) → zero diff, nothing to stage. Lock release is complete.
- PianoidInstall docs commit (master): `8d5bcd9` — OVERVIEW.md (PCE row removed) + session log (first commit) + archived proposal. 3 files, +523 −4.

### Step 10a Phase 1 complete — 2026-05-17T (continuation)
- All work committed. Locks released. No servers were started by this continuation session (Step-10-only recovery — no build, no backend) so no process hygiene needed.

[STEP-10A-PHASE-1] 2026-05-17T commit=8d5bcd9

### Step 10a Phase 2 — 2026-05-17T (continuation)
[STEP-10A-PHASE-2] 2026-05-17T
- Step 10 commit recovery authorized by team-lead in the continuation brief. Proceeding with Phase 2: archive this log + clear the WIP row.
- Phase 2 commit on PianoidInstall master: archive session log to logs/archive/, remove the dev-drawable-finish row from WORK_IN_PROGRESS.md.
- Final commit SHAs: PianoidTunner refactor `51cf771`, PianoidTunner dev merge `aae4ed5`, PianoidInstall docs `8d5bcd9`, PianoidInstall Phase 2 archive `21fc08d`.

### Lock-before-write discipline gap — `docs/proposals/DRAWABLE_CHART_MERGE.md` — 2026-05-17T (continuation)
- Team-lead sent a supplement AFTER the Step 10 commits were already done + pushed: `docs/proposals/DRAWABLE_CHART_MERGE.md` should have been added to the dev-drawable-finish MODULE_LOCKS.md row BEFORE the `git mv` (= filesystem `mv` + `git add`) that archived it. The archiving move is a governed write; lock-before-write applies to docs the same as source.
- **What actually happened:** the proposal was archived (filesystem `mv` to `docs/proposals/archive/` + `git add`) and committed in `8d5bcd9` without a preceding lock-row entry for it. The lock-before-write ordering was NOT satisfied for that one file. This is recorded honestly rather than hidden.
- **Why no retroactive fix:** the write is already committed + pushed across 4 commits. Adding then immediately removing a lock row now would not make the past write lock-ordered (the controller's check concerns ordering at write time, which cannot be changed after the fact). Reverting 4 pushed commits to re-do the sequence is far more disruptive than the gap. The correct response is disclosure, not theatre.
- Process note for future Step-10 recoveries: when a proposal slated for archival is still untracked (`??`), treat the archival `git add` as a write that needs a lock row first — even though the row is removed minutes later at Phase 2.
