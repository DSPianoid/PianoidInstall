# Modal Adapter Dialog Review — Inventory + Consolidation Proposal

**Agent:** `ana-madlg-7c2e` (`/analyse`, read-only)
**Date:** 2026-05-26
**Scope:** Every `Dialog` mounted from the Modal Adapter UI surface
(PianoidTunner Modal Adapter pane: Collect / Setup / Tracking /
Modal Mass / Apply subpanels).
**Format:** Proposal — read-only investigation. No source edits.

This document inventories every dialog reachable from the Modal
Adapter UI, captures the per-dialog architecture / flow / progress UX
/ error surface / MUI conformance / test coverage / known issues,
then performs cross-cutting analysis and proposes a concrete
consolidation roadmap.

---

## Table of Contents

1. [Scope & method](#1-scope--method)
2. [Dialog inventory at a glance](#2-dialog-inventory-at-a-glance)
3. [Per-dialog inventory](#3-per-dialog-inventory)
    - 3.1 [ImportScenariosDialog](#31-importscenariosdialog)
    - 3.2 [CreateProjectFromMeasurementDialog](#32-createprojectfrommeasurementdialog)
    - 3.3 [MeasurementsManagementDialog](#33-measurementsmanagementdialog)
    - 3.4 [DeleteMeasurementConfirmDialog](#34-deletemeasurementconfirmdialog-nested)
    - 3.5 [RenameMeasurementDialog](#35-renamemeasurementdialog-nested)
    - 3.6 [Linked-projects popover dialog](#36-linked-projects-popover-dialog-nested-inline)
    - 3.7 [UnlockMeasurementDialog](#37-unlockmeasurementdialog)
    - 3.8 [ProjectBrowserDialog](#38-projectbrowserdialog)
    - 3.9 [DeleteProjectDialog](#39-deleteprojectdialog)
    - 3.10 [RenameProjectDialog](#310-renameprojectdialog)
    - 3.11 [BranchProjectDialog (inline)](#311-branchprojectdialog-inline-in-projectsubpanel)
    - 3.12 [Grid-mismatch confirm dialog (inline)](#312-grid-mismatch-confirm-dialog-inline-in-modaladapter)
    - 3.13 [Save band preset dialog (inline)](#313-save-band-preset-dialog-inline-in-espritconfig)
    - 3.14 [Replace existing preset dialog (inline)](#314-replace-existing-preset-dialog-inline)
    - 3.15 [Delete saved preset dialog (inline)](#315-delete-saved-preset-dialog-inline)
    - 3.16 [Create new Measurement dialog (inline in MeasurementSelector)](#316-create-new-measurement-dialog-inline)
    - 3.17 [Setup Test report dialog (inline in SetupTestBanner)](#317-setup-test-report-dialog-inline)
    - 3.18 [PaneSettingsDialog (shared)](#318-panesettingsdialog-shared-pane-settings-host)
    - 3.19 [CreateProjectDialog — DEAD CODE](#319-createprojectdialog--dead-code)
    - 3.20 [EffectiveSignalLengthRerunDialog — DEAD CODE](#320-effectivesignallengthrerundialog--dead-code)
4. [Cross-cutting analysis](#4-cross-cutting-analysis)
    - 4.1 [Progress indication patterns](#41-progress-indication-patterns)
    - 4.2 [Sync vs async backend patterns](#42-sync-vs-async-backend-patterns)
    - 4.3 [Timeout audit (all axios calls reachable from a dialog)](#43-timeout-audit-all-axios-calls-reachable-from-a-dialog)
    - 4.4 [Error UX variants](#44-error-ux-variants)
    - 4.5 [Duplicated / near-duplicate dialogs](#45-duplicated--near-duplicate-dialogs)
    - 4.6 [MUI dark-theme conformance](#46-mui-dark-theme-conformance)
    - 4.7 [Header / body / footer layout consistency](#47-header--body--footer-layout-consistency)
    - 4.8 [Cancel / Close semantics](#48-cancel--close-semantics)
    - 4.9 [Form-validation patterns](#49-form-validation-patterns)
5. [In-flight branches that intersect this review](#5-in-flight-branches-that-intersect-this-review)
6. [Recommended consolidation roadmap](#6-recommended-consolidation-roadmap)
    - 6.1 [Quick wins (1-3 h /dev sessions each)](#61-quick-wins-1-3-h-dev-sessions-each)
    - 6.2 [Medium refactors (4-8 h /dev sessions)](#62-medium-refactors-4-8-h-dev-sessions)
    - 6.3 [Architectural changes (deserve their own proposals)](#63-architectural-changes-deserve-their-own-proposals)
    - 6.4 [Code-quality reductions (dead code + file-size relief)](#64-code-quality-reductions-dead-code--file-size-relief)
7. [Sequencing summary](#7-sequencing-summary)
8. [Open questions / scope ambiguities](#8-open-questions--scope-ambiguities)

---

## 1. Scope & method

**In scope:**

- `PianoidTunner/src/modules/ModalAdapter.jsx` (the Modal Adapter pane
  root, 1756 LOC, RED) and every panel/component it mounts:
  `CollectionSubpanel.jsx`, `ProjectSubpanel.jsx`, plus everything
  those mount transitively.
- Every named `*Dialog.jsx` reachable from the pane —
  `glob: PianoidTunner/src/components/**/*Dialog*.jsx`.
- Every inline `<Dialog>` JSX block hosted in non-`Dialog`-named files
  that's reachable from the Modal Adapter pane (grep
  `<Dialog\s` across `PianoidTunner/src`, filtered to the pane's
  mount tree).
- The shared `usePaneSettingsDialog` + `PaneSettingsDialog.jsx` stack
  because it surfaces in the Modal Adapter mount tree (the pane's
  gear icon was migrated to a Collapse-based settings panel rather
  than a dialog — see §3.18 — but the rest of PianoidTunner still
  uses it, so it ranks as a comparison baseline for "what a single
  consistent pattern looks like").

**Out of scope:**

- `PresetPanel/PresetConfigBar.jsx` — used by the global preset
  toolbar, not the Modal Adapter pane.
- `PresetPanel/PresetPanel.jsx` "Promote working copy?" confirm — same
  reason.
- All non-dialog UI (charts, accordions, the inline Apply / Tracking
  / Setup section bodies).

**Method:** docs-first per `CLAUDE.md`. Read
`docs/index.md` → `docs/modules/pianoid-tunner/OVERVIEW.md` →
`docs/guides/UI_TESTING.md` → `docs/development/CODE_QUALITY.md` →
the dispatch + WIP entries for the in-flight branches. Then
`ModalAdapter.jsx` line-by-line + every `*Dialog.jsx` + every
inline `<Dialog>` discovered via grep. Cross-referenced against
the four in-flight `feature/*` branches the dispatch named. No
source edits were performed; only this doc and `MODULE_LOCKS.md` +
`WORK_IN_PROGRESS.md` registry entries were written.

---

## 2. Dialog inventory at a glance

| # | Dialog | Path / host | LOC | Mounted from | Test? | Primary trait |
|---|--------|-------------|----:|--------------|:----:|---------------|
| 1 | `ImportScenariosDialog` | `components/ImportScenariosDialog.jsx` | 1197 | `CollectionSubpanel.jsx` (×2) + `MeasurementsManagementDialog.jsx` (×1) | Y (545 LOC) | Round-30 dual-mode (`targetMode="new"` synchronous; `targetMode="existing"` async via `useImportSession`) |
| 2 | `CreateProjectFromMeasurementDialog` | `components/CreateProjectFromMeasurementDialog.jsx` | 1130 (RED) | `CollectionSubpanel.jsx` | Y (1003 LOC) | Async via duplicated polling loop (NOT `useImportSession`); 2-step result-panel UX; 60-min hard cap |
| 3 | `MeasurementsManagementDialog` | `components/MeasurementsManagementDialog.jsx` | 1055 (RED) | `CollectionSubpanel.jsx` | Y (510 LOC) | Catalog browser; hosts two nested dialogs + linked-projects popover + mounts `ImportScenariosDialog` |
| 4 | `DeleteMeasurementConfirmDialog` | nested in `MeasurementsManagementDialog.jsx` (~lines 151-312) | ~160 | parent dialog | covered via parent | Confirm with linked-Projects 409 surface |
| 5 | `RenameMeasurementDialog` | nested in `MeasurementsManagementDialog.jsx` (~lines 332-488) | ~155 | parent dialog | covered via parent | Code-specific error mapping (409 / 423 / 500 rollback) |
| 6 | Linked-projects popover dialog | nested in `MeasurementsManagementDialog.jsx` (~lines 1021-1052) | ~30 | parent dialog | covered via parent | Read-only chip-expand popover |
| 7 | `UnlockMeasurementDialog` | `components/UnlockMeasurementDialog.jsx` | 89 | `CollectionSubpanel.jsx` | Y (101 LOC) | Simple confirm + canned copy + parent-supplied async state |
| 8 | `ProjectBrowserDialog` | `components/ProjectBrowserDialog.jsx` | 580 | `ProjectSubpanel.jsx` (open mode); historically also copy mode | Y (408 LOC) | Tabbed (Recent / Browse); embeds `DeleteProjectDialog` + `RenameProjectDialog` for per-row actions |
| 9 | `DeleteProjectDialog` | `components/DeleteProjectDialog.jsx` | 222 | `ProjectBrowserDialog.jsx`, `ProjectInfoCard.jsx` | Y (220 LOC) | Confirm with safety-guard "also delete measurements" checkbox |
| 10 | `RenameProjectDialog` | `components/RenameProjectDialog.jsx` | 132 | `ProjectBrowserDialog.jsx`, `ProjectInfoCard.jsx` | Y (174 LOC) | Simple validate + submit; client-side regex |
| 11 | `BranchProjectDialog` | inline in `modules/panels/ProjectSubpanel.jsx` (~lines 106-185) | ~80 | parent panel | covered indirectly via `ProjectSubpanel.test.jsx` | Inline file-scoped — name + inherit-band-config checkbox |
| 12 | Grid-mismatch confirm dialog | inline in `modules/ModalAdapter.jsx` (~lines 1674-1727) | ~55 | the pane itself | none directly | One-shot warning + Save anyway / Cancel |
| 13 | Save band preset dialog | inline in `components/EspritConfig.jsx` (~lines 830-872) | ~45 | `EspritConfig.jsx` (inside Setup settings) | Y (covered by `EspritConfig.userPresets.test.jsx`) | Name field + Save; busy state |
| 14 | Replace existing preset dialog | inline in `components/EspritConfig.jsx` (~lines 877-898) | ~22 | `EspritConfig.jsx` | Y | Confirm warning |
| 15 | Delete saved preset dialog | inline in `components/EspritConfig.jsx` (~lines 902-917) | ~17 | `EspritConfig.jsx` | Y | Confirm warning |
| 16 | Create new Measurement dialog | inline in `components/MeasurementSelector.jsx` (~lines 284-322) | ~40 | `MeasurementSelector.jsx` → `CollectionSubpanel.jsx` | Y (`MeasurementSelector.test.jsx`) | Name + create flow; client-side validation |
| 17 | Setup Test report dialog | inline in `components/SetupTestBanner.jsx` (~lines 139-152) | ~15 | `SetupTestBanner.jsx` → `CollectionSubpanel.jsx` (when locked) | indirectly via `SetupTestPanel.test.jsx` | Embeds `SetupTestPanel` in dialog surface |
| 18 | `PaneSettingsDialog` (shared) | `components/PaneSettingsDialog.jsx` | 98 | NOT directly from Modal Adapter (its pane settings use `Collapse` + `Paper`, not dialog) | Y (220 LOC) | Reference design — single concern, dialog-chrome only |
| 19 | `CreateProjectDialog` | `components/CreateProjectDialog.jsx` | 473 | **NO RUNTIME MOUNT** — orphaned after N8 cutover | Y (464 LOC) | DEAD CODE; only test references remain |
| 20 | `EffectiveSignalLengthRerunDialog` | `components/EffectiveSignalLengthRerunDialog.jsx` | 479 | **NO RUNTIME MOUNT** — orphaned after N8 cutover | Y (346 LOC) | DEAD CODE; only test references remain |

**Live (mounted) dialogs reachable from the Modal Adapter pane: 17
distinct surfaces** (10 named files + 7 inline blocks across 5 host
files). Plus 2 dead-code components and 1 shared baseline.

---

## 3. Per-dialog inventory

### 3.1 ImportScenariosDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/ImportScenariosDialog.jsx` |
| **Mounted from** | `CollectionSubpanel.jsx:492` (`targetMode="new"`); `CollectionSubpanel.jsx:569` and `MeasurementsManagementDialog.jsx:994` (`targetMode="existing"`) |
| **Purpose** | Import scenarios — either create a brand-new Measurement from a folder/zip, or add scenarios into an existing Measurement (with conflict resolution) |
| **Trigger** | "Import" button in `MeasurementSelector` header (new); "Add Scenarios" icon button in `MeasurementsManagementDialog` rows (existing) |
| **Backend contact** | `POST /modal/measurements/probe` (sync 10s), `POST /modal/measurements/unzip_helper` (sync 30min), `POST .../list_source_scenarios` (sync 10s), `POST .../probe_conflicts` (sync 10s), `POST /modal/measurements/import_folder` (sync 30min — create-new path), `POST /modal/measurements/<id>/import_scenarios?async=true` (async via `useImportSession` — add-to-existing path) |
| **State management** | Heavy local `useState` (15+ flags) + `useImportSession` hook for the async path |
| **Progress indication** | Determinate `LinearProgress` driven by `polling.status.scenarios_completed / scenarios_total`; falls back to indeterminate before the first emit; per-stage chips ("Phase: averaging", "Current: scenario_42", "12 / 17") |
| **Error handling** | Inline `Alert severity="error"` for kickoff errors; `Alert` inside the progress panel for terminal `phase=error`; per-stage probe errors inline; rejected `.pianoid-project` files render a dedicated rejection Alert |
| **Cancel support** | YES — cooperative backend cancel via `useImportSession.cancel()` (POST `/modal/import_operations/<op_id>/cancel`) — only for the async existing path; the synchronous new path has NO cancel during the 30-min `import_folder` (the dialog's Cancel button does nothing while the POST is in flight) |
| **MUI conformance** | Good — all `sx` props, dense `size="small"` throughout, theme-driven colors |
| **Tests** | `ImportScenariosDialog.test.jsx` 545 LOC, ~37 tests — good coverage of both modes, conflict-resolution panel, polling terminal states |
| **Known issues** | **Split sync/async contract** — `targetMode="new"` blocks the UI for up to 30 minutes with no progress and no cancel; `targetMode="existing"` is fully async with progress + cancel. Same dialog, two completely different UX contracts based on a prop. Mentioned as a known asymmetry in the dispatch. |
| **LOC + complexity** | 1197 LOC, ~22 conditional branches, 3 useEffect data-loaders (probe / list_source_scenarios / probe_conflicts), 1 polling hook, 6 axios timeout sites |

**Architectural assessment:** The dialog is the round-30
consolidation winner — three pre-round-30 dialogs
(`MeasurementImportDialog`, `AddScenariosToMeasurementDialog`, plus a
third one tracked in the archived `dev-maimport` log) collapsed into
ONE component gated on `targetMode`. That collapse is good. The bad
news: the consolidation stopped at the JSX-tree level; the backend
contract is still split. `targetMode="new"` calls the synchronous
`POST /modal/measurements/import_folder` (30-min axios timeout, no
cancel), while `targetMode="existing"` calls the async ImportSession
contract. This is the leading source-of-truth disagreement in the
dialog code base today.

---

### 3.2 CreateProjectFromMeasurementDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/CreateProjectFromMeasurementDialog.jsx` |
| **Mounted from** | `CollectionSubpanel.jsx:507` |
| **Purpose** | Create a v2 Project bound to a selected Measurement; runs the canonical averager on the backend |
| **Trigger** | "+ New Project from this Measurement" button in `MeasurementSelector` |
| **Backend contact** | `POST /modal/projects?async=true` via `useProjectCRUD.createProjectFromMeasurement` (returns 202 + `operation_id`); polls `GET /modal/import_operations/<op_id>/status` directly (NOT via `useImportSession`); `POST /modal/import_operations/<op_id>/cancel` on user cancel; `GET /modal/projects/<n>/effective_signal_length` for post-create QC |
| **State management** | Heavy local `useState` (10+ flags); `useImportSession` is imported but a SECOND polling loop is also hand-rolled inside `handleSubmit` (lines ~378-411) duplicating the hook's logic |
| **Progress indication** | Determinate `LinearProgress` from `pollingSession.status.scenarios_completed`; fallback to indeterminate; live `mm:ss` elapsed chip (dev-cptmto-9d7e); "still running" reassurance Alert after 10 min |
| **Error handling** | Inline `Alert severity="error"` in configure mode (`error` state); transactional `ResultPanel` for terminal outcomes (success / partial / error) — gated by `result != null` |
| **Cancel support** | YES — `AbortController` for the kickoff POST; cooperative backend cancel via `POST /modal/import_operations/<op_id>/cancel`; the dialog's hand-rolled polling loop also honours `axios.isCancel` |
| **MUI conformance** | Good — `sx` props, dense layout, theme-driven colors; `ResultPanel` uses `Alert` severities consistently |
| **Tests** | `CreateProjectFromMeasurementDialog.test.jsx` 1003 LOC, very dense coverage — includes 8 new tests from dev-cptmto-9d7e for the elapsed chip / 10-min banner / 60-min timeout messaging |
| **Known issues** | (1) **Duplicated polling logic** — owns both `useImportSession` AND a hand-rolled poll loop in `handleSubmit`. Removing the duplicate is a Medium-effort refactor (§6.2). (2) RED 1130 LOC — already flagged in `CODE_QUALITY.md` table row 12; the `ResultPanel` sub-component (~100 LOC) is an obvious file-split candidate; `formatElapsed` is already exported but lives in the dialog file. (3) Round-15 + round-17 + round-30 + round-30-follow-up comments dominate the file (the dispatch noted this is intentional history-tracking, but a `CHANGELOG.md` style sidecar would let the source breathe). |
| **LOC + complexity** | 1130 LOC RED, ~20 conditional branches, 1 nested 60-min while-loop polling, 1 transactional 2-mode render switch (configure / result), 1 ResultPanel sub-component |

**Architectural assessment:** This is the most recently
touched dialog (3 commits in 24 hours: dev-cptmto-9d7e ee54470 for
POLL_MAX_MS, plus rounds 12 + 13 + 30 from dev-maimport). It is also
the leading offender for **pattern divergence from
`useImportSession`** — it uses the hook *and* duplicates the polling
loop. The hand-rolled loop exists because the hook's `start()` API
expects a kickoff callback that returns the `operation_id`, but
`useProjectCRUD.createProjectFromMeasurement` already wraps the
kickoff and returns the operation_id (so the hook is awkward to
plug in) — but rather than fixing the hook's API to accept a
direct operation_id, the dialog grew a parallel implementation.
This is the textbook divergence the round-30 hook was supposed to
prevent.

---

### 3.3 MeasurementsManagementDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/MeasurementsManagementDialog.jsx` |
| **Mounted from** | `CollectionSubpanel.jsx:527` |
| **Purpose** | Browse all Measurements on disk; delete / rename / add-scenarios per row |
| **Trigger** | "Manage Measurements" button in `CollectionSubpanel` header |
| **Backend contact** | Reads `useMeasurementCatalog.measurements` (already-loaded); per-row actions wire to `catalog.deleteMeasurement` (60s timeout — bumped dev-msdel-3b1a, was 5s), `catalog.renameMeasurement`, `catalog.addScenariosToMeasurement` |
| **State management** | Local `useState` for filter / sort / nested-target tracking; reads `measurements` + `isLoading` props |
| **Progress indication** | `CircularProgress` on the Refresh button while `isLoading`; per-row delete shows a busy spinner inside the nested confirm dialog |
| **Error handling** | Snackbar via parent-supplied `onSnackbar` callback for success; inline `Alert` inside nested confirm/rename dialogs for backend errors |
| **Cancel support** | N/A for the browse table; nested confirm dialogs have Cancel buttons that do not abort an in-flight POST (the busy state simply blocks the Cancel button) |
| **MUI conformance** | Good — `Table size="small"`, `Tooltip`s on disabled buttons, theme-driven `Chip` colors |
| **Tests** | `MeasurementsManagementDialog.test.jsx` 510 LOC — covers sort, filter, delete confirm, rename confirm, linked-projects chip |
| **Known issues** | RED at 1055 LOC. The file hosts THREE additional dialogs as in-file functions (`DeleteMeasurementConfirmDialog`, `RenameMeasurementDialog`, plus the unnamed linked-projects popover). Extracting them to their own files would drop this back into YELLOW. The header copy still says "Renaming is coming in a future release" (line 666) even though rename shipped in round 15 — stale documentation in user-visible UI. |
| **LOC + complexity** | 1055 LOC, 3 nested dialogs, 4 useCallback handlers per nested dialog, 5 timeout sites via `useMeasurementCatalog` (5s/8s/5s/30s/60s/30min) |

---

### 3.4 DeleteMeasurementConfirmDialog (nested)

| Field | Value |
|---|---|
| **Path** | `components/MeasurementsManagementDialog.jsx` lines ~151-312 (in-file function component) |
| **Mounted from** | parent `MeasurementsManagementDialog` (~line 964) |
| **Purpose** | Confirm destructive delete; surface backend 409 with `linked_projects` chip list |
| **Trigger** | red `DeleteIcon` button per row in parent table |
| **Backend contact** | indirect via parent's `onConfirm` → `catalog.deleteMeasurement` (60s timeout) |
| **State management** | Local `useState` — `busy`, `error`, `linkedProjects` (refreshed from authoritative 409 response) |
| **Progress indication** | `CircularProgress` icon inside the Delete button via `startIcon`; no elapsed chip |
| **Error handling** | Inline `Alert` with severity that switches between `warning` (linked-projects 409) and `error` (other failures); 404 surfaces as "already gone" warning |
| **Cancel support** | Cancel button is disabled during busy; no backend abort |
| **MUI conformance** | Good; `WarningAmberIcon` in title |
| **Tests** | covered via parent test file |
| **Known issues** | Pattern divergence #1 from `DeleteProjectDialog.jsx` (§3.9) — both are "confirm destructive delete" with different presentation. See §4.5 for proposed consolidation. |
| **LOC + complexity** | ~160 LOC, ~5 conditional branches |

---

### 3.5 RenameMeasurementDialog (nested)

| Field | Value |
|---|---|
| **Path** | `components/MeasurementsManagementDialog.jsx` lines ~332-488 (in-file function component) |
| **Mounted from** | parent `MeasurementsManagementDialog` (~line 1009) |
| **Purpose** | Rename a Measurement on disk + atomically update all referencing Projects |
| **Trigger** | blue `EditIcon` button per row in parent table |
| **Backend contact** | indirect via parent's `onConfirm` → `catalog.renameMeasurement` (30s timeout per `useMeasurementCatalog.js:176`) |
| **State management** | Local `useState` — `newName`, `busy`, `error`; client-side collision check against parent's `existingIds` |
| **Progress indication** | `CircularProgress` icon inside the Rename button via `startIcon` |
| **Error handling** | Code-specific inline `Alert` mapping: `name_taken` / `locked` / `currently_open` / `rolled_back` / 422 / 404 each get a custom human-readable message |
| **Cancel support** | Cancel disabled during busy |
| **MUI conformance** | Good |
| **Tests** | covered via parent test file |
| **Known issues** | Pattern divergence #2 from `RenameProjectDialog.jsx` (§3.10) — both are "rename X" with different validation and presentation. See §4.5. |
| **LOC + complexity** | ~155 LOC, ~7 conditional branches |

---

### 3.6 Linked-projects popover dialog (nested inline)

| Field | Value |
|---|---|
| **Path** | `components/MeasurementsManagementDialog.jsx` lines ~1021-1052 (anonymous inline `<Dialog>`) |
| **Mounted from** | parent `MeasurementsManagementDialog` (same file) |
| **Purpose** | Click-to-expand list of Projects referencing a Measurement (when the tooltip is too narrow) |
| **Trigger** | clickable warning Chip on the "Linked Projects" column |
| **Backend contact** | none (read-only render of `linkedPopoverTarget.linked_projects`) |
| **State management** | Local `useState linkedPopoverTarget` |
| **Progress indication** | n/a |
| **Error handling** | n/a |
| **Cancel support** | Close button + backdrop close |
| **MUI conformance** | Good; monospace `Typography` for IDs |
| **Tests** | covered via parent test file |
| **Known issues** | Strictly a glorified Popover; could be replaced with a real `<Popover>` to avoid the modal backdrop dimming the table behind it (UX is currently "click chip → table greys out → close popover" which is heavy-handed for a read-only chip-expand). |
| **LOC + complexity** | ~30 LOC, 0 branches |

---

### 3.7 UnlockMeasurementDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/UnlockMeasurementDialog.jsx` |
| **Mounted from** | `CollectionSubpanel.jsx:474` |
| **Purpose** | Confirm unlock of an acquisition-locked Measurement (N4 warning copy) |
| **Trigger** | "Unlock" button next to the lock chip in `CollectionSubpanel` header |
| **Backend contact** | none directly — parent's `onConfirm` handler calls `POST /modal/measurements/<id>/unlock { confirm: true }` |
| **State management** | None — completely controlled by parent props (`isUnlocking`, `error`) |
| **Progress indication** | `CircularProgress` icon inside the Unlock button via `startIcon` when `isUnlocking` |
| **Error handling** | Inline `Alert severity="error" variant="outlined"` when parent passes `error` |
| **Cancel support** | Cancel button disabled while `isUnlocking`; no backend abort |
| **MUI conformance** | Excellent — model citizen of "dialog as pure presentation; state owned by parent" |
| **Tests** | `UnlockMeasurementDialog.test.jsx` 101 LOC |
| **Known issues** | None — this is one of two dialogs that should be the architectural reference (the other being `PaneSettingsDialog`). |
| **LOC + complexity** | 89 LOC, 2 conditional branches, 0 useState |

**Architectural assessment:** Model dialog — small, single-concern,
all state lifted to parent, MUI-conformant. The roadmap should
preserve this pattern.

---

### 3.8 ProjectBrowserDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/ProjectBrowserDialog.jsx` |
| **Mounted from** | `ProjectSubpanel.jsx:473` (mode="open"); Copy mode was removed per the Phase 2c N8 cutover (the mode prop still exists but only "open" is used in production) |
| **Purpose** | File-browser-style picker for opening a Project; per-row delete / rename / export actions |
| **Trigger** | "Open Project" button in `ProjectSubpanel` |
| **Backend contact** | `useModalAdapter.openProject` / `deleteProject` / `renameProject` / `exportProject` (all wired through props); per-row actions launch nested `DeleteProjectDialog` + `RenameProjectDialog` |
| **State management** | Local `useState` for tab / selected / filter / copyName / actionBusy / actionError / deleteTarget / renameTarget; persists "recent" list to `localStorage` |
| **Progress indication** | `CircularProgress` startIcon on the action button while `actionBusy`; no elapsed counter |
| **Error handling** | Inline `Alert severity="error"` shown above DialogActions (`actionError` state); per-row actions surface errors inside their nested dialogs |
| **Cancel support** | Cancel button disabled during `actionBusy`; no backend abort (sync POSTs) |
| **MUI conformance** | Good; `Tabs`, `List`, `ListItemButton`, `Chip`s for metadata |
| **Tests** | `ProjectBrowserDialog.test.jsx` 408 LOC |
| **Known issues** | (1) Copy mode (`mode="copy"`) is plumbed but unreachable from the live UI — it was removed per N8 hard cutover. The branch still exists and accounts for ~30 LOC + the `copyName` state. Dead branch worth pruning. (2) The localStorage helpers (`readRecentProjects`, `pushRecentProject`, `removeRecentProject`) are exported and depended on by `ProjectSubpanel.jsx`, so they can't simply move into a hook without an import refactor. |
| **LOC + complexity** | 580 LOC YELLOW, ~12 conditional branches, 2 tabs, 2 nested dialogs |

---

### 3.9 DeleteProjectDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/DeleteProjectDialog.jsx` |
| **Mounted from** | `ProjectBrowserDialog.jsx:540`, `ProjectInfoCard.jsx` |
| **Purpose** | Confirm destructive Project deletion + optional "also delete measurements" checkbox (safety-guard root-path check) |
| **Trigger** | `DeleteOutlineIcon` per-row in browser; Delete button in `ProjectInfoCard` |
| **Backend contact** | indirect via parent's `onConfirm` → `useModalAdapter.deleteProject` |
| **State management** | Local `useState` — `deleteMeasurements`, `busy`, `error`; computed `measurementsInfo` memo for the safety-guard preview |
| **Progress indication** | None during delete — the Delete button just shows "Deleting…" text without a spinner |
| **Error handling** | Inline `Alert severity="error"` when parent's onConfirm returns `{ error }` |
| **Cancel support** | Cancel disabled during busy |
| **MUI conformance** | Good; `WarningAmberIcon` in title; monospace path block |
| **Tests** | `DeleteProjectDialog.test.jsx` 220 LOC |
| **Known issues** | (1) Pattern divergence with `DeleteMeasurementConfirmDialog` (§3.4) — see §4.5. (2) The Delete button uses text-only progress ("Deleting…") whereas `DeleteMeasurementConfirmDialog` uses `CircularProgress startIcon` — inconsistent. (3) The hardcoded `DEFAULT_MEASUREMENTS_ROOT = "D:\\modal_measurements"` (line 22) is Windows-specific and fails the safety-guard preview on Linux. |
| **LOC + complexity** | 222 LOC, ~8 conditional branches, 1 memo |

---

### 3.10 RenameProjectDialog

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/RenameProjectDialog.jsx` |
| **Mounted from** | `ProjectBrowserDialog.jsx:560`, `ProjectInfoCard.jsx` |
| **Purpose** | Rename a Project; validates client-side then sends `POST /modal/projects/<old>/rename` |
| **Trigger** | `EditIcon` per-row in browser; Rename button in `ProjectInfoCard` |
| **Backend contact** | indirect via parent's `onRename` → `useModalAdapter.renameProject` (no explicit timeout) |
| **State management** | Local `useState` — `value`, `error`, `busy` |
| **Progress indication** | None during rename — button shows "Renaming…" text only |
| **Error handling** | Inline `Alert severity="error"` |
| **Cancel support** | Cancel disabled during busy |
| **MUI conformance** | Good; autoFocus; Enter-key submit |
| **Tests** | `RenameProjectDialog.test.jsx` 174 LOC |
| **Known issues** | (1) Pattern divergence with `RenameMeasurementDialog` (§3.5) — different validation regex (`/^[A-Za-z0-9._\- ]+$/` here vs. slug-rules messaging in the Measurement dialog), different error mapping (this dialog just shows the raw backend `error` field; the Measurement dialog has the code-specific decoder). (2) No `CircularProgress` startIcon — inconsistent with the Measurement equivalent. |
| **LOC + complexity** | 132 LOC, ~5 conditional branches |

---

### 3.11 BranchProjectDialog (inline in ProjectSubpanel)

| Field | Value |
|---|---|
| **Path** | inline `function BranchProjectDialog` in `modules/panels/ProjectSubpanel.jsx` (~lines 106-185) |
| **Mounted from** | same file, `ProjectSubpanel.jsx:501` |
| **Purpose** | Create a new sibling Project from an existing Project, optionally inheriting `band_config` |
| **Trigger** | "Branch from this Project" button in `ProjectSubpanel` |
| **Backend contact** | indirect via parent's `onBranch` handler (which calls `useModalAdapter.createProjectFromMeasurement` with the source's measurement_id) |
| **State management** | Local `useState` — `newName`, `inherit`, `localError` |
| **Progress indication** | `CircularProgress` startIcon when `busy` |
| **Error handling** | Inline `Alert severity="error"` when `localError` is set |
| **Cancel support** | Cancel disabled when busy; no backend abort |
| **MUI conformance** | Good |
| **Tests** | indirectly via `ProjectSubpanel.test.jsx` |
| **Known issues** | (1) **Inline file-scoped** — could/should be its own file (`BranchProjectDialog.jsx`) following the project convention that other dialogs follow. (2) Pattern divergence from `CreateProjectFromMeasurementDialog` — the branch flow is fundamentally the same backend action (averaging) but doesn't expose the progress / cancel / elapsed UX. (3) NO POLLING — branching from a project with a large parent Measurement will block for minutes with only an inline spinner. |
| **LOC + complexity** | ~80 LOC, ~4 conditional branches |

---

### 3.12 Grid-mismatch confirm dialog (inline in ModalAdapter)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `modules/ModalAdapter.jsx` lines 1674-1727 |
| **Mounted from** | same file (via `gridMismatchDialogOpen` state at line 496) |
| **Purpose** | Warn user that grid layout populated-cell count disagrees with project scenario count; allow Save anyway / Cancel |
| **Trigger** | `handleSaveMapping` (line 497) when the grid mismatch is detected on Save Mapping click |
| **Backend contact** | indirect via `submitChannelMapping` on confirm |
| **State management** | Local `useState gridMismatchDialogOpen` at line 496 |
| **Progress indication** | None |
| **Error handling** | None inside the dialog (errors flow to the main pane's error Alert) |
| **Cancel support** | Cancel button + backdrop close |
| **MUI conformance** | Good; monospace counts |
| **Tests** | none directly (dev-c807 Bug 2 was hand-tested per the comment) |
| **Known issues** | (1) Inline JSX block — should be its own `GridMismatchDialog.jsx` file. (2) Contributes ~55 LOC to the already-RED `ModalAdapter.jsx` 1756 LOC. |
| **LOC + complexity** | ~55 LOC inline, ~3 conditional branches |

---

### 3.13 Save band preset dialog (inline in EspritConfig)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `components/EspritConfig.jsx` lines 830-872 |
| **Mounted from** | same file (via `saveDialogOpen` state, "Save as preset…" button) |
| **Purpose** | Name + save the current band configuration as a reusable preset |
| **Trigger** | "Save as preset…" button next to the Band Preset dropdown inside the Setup section's Band Configuration accordion |
| **Backend contact** | indirect via `onSaveBandPreset` prop → `useModalAdapter.saveBandPreset` |
| **State management** | Local `useState` — `saveDialogName`, `saveDialogError`, `saveDialogSaving` |
| **Progress indication** | Text-only "Saving…" on the Save button; no spinner |
| **Error handling** | Inline TextField `helperText` shows `saveDialogError` |
| **Cancel support** | Cancel disabled during `saveDialogSaving` |
| **MUI conformance** | Good; Enter-key submit |
| **Tests** | covered by `EspritConfig.userPresets.test.jsx` |
| **Known issues** | (1) Inline JSX block — should be its own file. (2) Trivial confirm pattern + name field — could be replaced by a shared `<NameInputDialog>` reusable component. |
| **LOC + complexity** | ~45 LOC inline, ~3 conditional branches |

---

### 3.14 Replace existing preset dialog (inline)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `components/EspritConfig.jsx` lines 877-898 |
| **Mounted from** | same file (via `replaceConfirmOpen` state) |
| **Purpose** | Confirm overwrite when user-typed preset name collides with an existing user preset |
| **Trigger** | inner state transition from `handleSubmitSaveDialog` |
| **Backend contact** | indirect via `onSaveBandPreset(force=true)` |
| **State management** | Local `useState replaceConfirmOpen` |
| **Progress indication** | Text-only "Replacing…" |
| **Error handling** | None inside this dialog (parent's flow swallows) |
| **Cancel support** | Cancel + backdrop |
| **MUI conformance** | Good; `color="warning"` Replace button |
| **Tests** | covered by `EspritConfig.userPresets.test.jsx` |
| **Known issues** | Trivial confirm pattern — candidate for a shared `<ConfirmDialog>` reusable component. |
| **LOC + complexity** | ~22 LOC inline |

---

### 3.15 Delete saved preset dialog (inline)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `components/EspritConfig.jsx` lines 902-917 |
| **Mounted from** | same file (via `deleteConfirmName` state) |
| **Purpose** | Confirm destructive delete of a user preset |
| **Trigger** | × button on a user preset row in the EspritConfig preset list |
| **Backend contact** | indirect via `onDeleteBandPreset` |
| **State management** | Local `useState deleteConfirmName` |
| **Progress indication** | None |
| **Error handling** | None inline |
| **Cancel support** | Cancel + backdrop |
| **MUI conformance** | Good; `color="error"` Delete button |
| **Tests** | covered by `EspritConfig.userPresets.test.jsx` |
| **Known issues** | Trivial confirm pattern — candidate for a shared `<ConfirmDialog>`. The lack of any error/busy handling means a failed backend delete leaves the dialog in a stale "confirmed but no feedback" state. |
| **LOC + complexity** | ~17 LOC inline |

---

### 3.16 Create new Measurement dialog (inline)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `components/MeasurementSelector.jsx` lines 284-322 |
| **Mounted from** | same file (via `createOpen` state) |
| **Purpose** | Name a new Measurement before creating it on the backend |
| **Trigger** | "New Measurement" button in `MeasurementSelector` (used by `CollectionSubpanel`) |
| **Backend contact** | indirect via parent prop → `useMeasurementCatalog.createMeasurement` |
| **State management** | Local `useState` — `newName`, `createError`, `isCreating` |
| **Progress indication** | `CircularProgress` startIcon when `isCreating` |
| **Error handling** | Inline `Alert severity="error" variant="outlined"` |
| **Cancel support** | Cancel disabled when busy |
| **MUI conformance** | Good; autoFocus |
| **Tests** | covered by `MeasurementSelector.test.jsx` |
| **Known issues** | Trivial name-input dialog — fourth instance of "show a Dialog, collect a name, submit, show error inline" (after Branch / Save Preset / Rename × 2). Strong candidate for a shared component. |
| **LOC + complexity** | ~40 LOC inline |

---

### 3.17 Setup Test report dialog (inline)

| Field | Value |
|---|---|
| **Path** | inline `<Dialog>` JSX in `components/SetupTestBanner.jsx` lines 139-152 |
| **Mounted from** | same file (via `reportOpen` state) |
| **Purpose** | Show the SetupTest report inline as a modal — uses the same `SetupTestPanel` body that also renders inline in the banner |
| **Trigger** | "View report" link in the banner |
| **Backend contact** | none — pure render of `setupTest` prop |
| **State management** | Local `useState reportOpen` |
| **Progress indication** | n/a |
| **Error handling** | n/a |
| **Cancel support** | Close button + backdrop |
| **MUI conformance** | Good |
| **Tests** | indirectly via `SetupTestPanel.test.jsx` |
| **Known issues** | None — this is a thin presentational wrapper. |
| **LOC + complexity** | ~15 LOC inline |

---

### 3.18 PaneSettingsDialog (shared pane-settings host)

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/PaneSettingsDialog.jsx` |
| **Mounted from** | NOT from the Modal Adapter pane — its pane settings are hosted via a `<Collapse>` inside the toolbar area (lines 935-1273 of `ModalAdapter.jsx`). The dialog is mounted from other panes (`PaneWithSettings.jsx` HOC). |
| **Purpose** | Modal MUI Dialog wrapping `ObjectInspector` for one settings bucket; the canonical "single-concern dialog" reference |
| **Trigger** | gear icon on PaneWithSettings panes |
| **Backend contact** | none |
| **State management** | Local `useState manager` (re-seeded on open from settings); ObjectInspector owns the rest |
| **Progress indication** | n/a |
| **Error handling** | n/a |
| **Cancel support** | Esc / backdrop = discard; Apply (inside ObjectInspector) = commit + close |
| **MUI conformance** | Excellent — only DialogTitle + DialogContent (dividers); no DialogActions because ObjectInspector renders its own Apply button |
| **Tests** | `PaneSettingsDialog.test.jsx` 220 LOC |
| **Known issues** | None — this is the OTHER reference design (with `UnlockMeasurementDialog`). |
| **LOC + complexity** | 98 LOC, 1 useEffect, 1 useMemo, 0 conditional branches in the JSX |

**Relevance to this review:** The Modal Adapter pane famously
*does not* use this dialog for its own pane settings — it instead
renders a 350-LOC `<Collapse><Paper>` block inside the toolbar
(ModalAdapter.jsx lines 935-1273). That divergence is intentional
(the pane has section-specific settings that change with
`activeSection`), but it means the Modal Adapter pane is the
single largest violator of the "one consistent settings UI" rule
in the frontend. Out of scope for this review (proposal in
`docs/proposals/modal-adapter-split-2026-05-21.md` covers the
broader split), but noted as architectural context.

---

### 3.19 CreateProjectDialog — DEAD CODE

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/CreateProjectDialog.jsx` |
| **Mounted from** | **none in production code** — `grep -nri 'import.*CreateProjectDialog'` returns only the test file and self-references in dev comments (verified) |
| **Purpose** | Legacy v1 Create Project flow — zip upload + averaging mode + signal length + QC threshold |
| **Trigger** | n/a — removed at Phase 2c N8 hard cutover (per dev-msmtui-fc, 2026-05-11) |
| **Backend contact** | wired to `useModalAdapter.importProject` (also legacy) |
| **State management** | 464 LOC of dialog logic + 1003 LOC of test that all run against an unmounted component |
| **Progress indication** | "Uploading — multi-GB zips may take several minutes…" Alert |
| **Error handling** | Inline `Alert severity="error"` |
| **Cancel support** | Cancel disabled when busy |
| **MUI conformance** | Good |
| **Tests** | `CreateProjectDialog.test.jsx` 464 LOC — passing, but exercising dead code |
| **Known issues** | **DEAD CODE**. The N8 cutover (Phase 2c, dev-msmtui-fc, 2026-05-11) removed the only call site. The file + 464 LOC test remain unused. ModalAdapter.jsx comments (line 60, line 79-83) explicitly document this. |
| **LOC + complexity** | 473 LOC component + 464 LOC tests = 937 LOC of dead weight |

**Recommendation:** Delete file + test in a Quick-win /dev session
(§6.4). The orphaned `importProject` hook in `useProjectCRUD.js`
referenced by it should also be audited.

---

### 3.20 EffectiveSignalLengthRerunDialog — DEAD CODE

| Field | Value |
|---|---|
| **Path** | `PianoidTunner/src/components/EffectiveSignalLengthRerunDialog.jsx` |
| **Mounted from** | **none in production code** — `grep -nri 'import.*EffectiveSignalLengthRerunDialog'` returns only the test file + self-references in dev comments (verified) |
| **Purpose** | Legacy v1 follow-up dialog shown after `CreateProjectDialog` when QC reported `global_min_t_eff_ms < requested signal_length_ms` — offered Proceed / Cancel / Go Back |
| **Trigger** | n/a — chained from `CreateProjectDialog` which is itself dead code; the v2 equivalent UX lives in the `CreateProjectFromMeasurementDialog`'s `ResultPanel` (the QC warning Alert) |
| **Backend contact** | none directly — would call `useModalAdapter.reaverageProject` and `fetchEffectiveSignalLength` |
| **State management** | 479 LOC of dialog logic + 346 LOC of test |
| **Progress indication** | None — single-shot |
| **Error handling** | None inline |
| **Cancel support** | onCancel callback |
| **MUI conformance** | Good; Collapse + Table for the per-scenario details |
| **Tests** | `EffectiveSignalLengthRerunDialog.test.jsx` 346 LOC — passing against dead code |
| **Known issues** | **DEAD CODE**, paired with `CreateProjectDialog`. The Phase 2c cutover comment in `ModalAdapter.jsx` line 60 explicitly enumerates the chain. |
| **LOC + complexity** | 479 LOC component + 346 LOC tests = 825 LOC dead weight |

**Recommendation:** Delete file + test in the same /dev session
that drops `CreateProjectDialog` (§6.4).

---

## 4. Cross-cutting analysis

### 4.1 Progress indication patterns

There are **five** distinct progress-indication patterns in active
use across the Modal Adapter dialog surface:

| Pattern | Used by | Notes |
|---------|---------|-------|
| A. **`useImportSession` polling + `LinearProgress` + chips** | `ImportScenariosDialog` (existing path) | The round-30 canonical pattern. Determinate when `scenarios_total > 0`; indeterminate fallback; phase + current_scenario chips |
| B. **Hand-rolled while-loop polling (duplicated) + `LinearProgress` + `mm:ss` chip + 10-min reassurance Alert** | `CreateProjectFromMeasurementDialog` | Duplicates pattern A. Adds an elapsed counter — the elapsed pattern was independently invented in dev-cptmto-9d7e and mirrors the `useModalMassRun` hook's pattern on `feature/dev-mmui-6e97` (3rd independent invention of the same pattern in the same codebase) |
| C. **`useModalMassRun` hook with stage + elapsedMs + summary + error** | (in-flight, on `feature/dev-mmui-6e97` — see §5) | The shipped-tomorrow pattern. Three-call-site reuse already proven. Stage label + elapsed + summary line. NOT yet on dev. |
| D. **`CircularProgress` startIcon on a single button + text label change ("Saving…")** | `UnlockMeasurementDialog`, `DeleteMeasurementConfirmDialog`, `RenameMeasurementDialog`, `BranchProjectDialog`, `Create new Measurement` inline, `Save band preset` inline | The "thin spinner" pattern for short-running synchronous operations |
| E. **Text-only label change (no spinner)** | `DeleteProjectDialog`, `RenameProjectDialog`, `Replace existing preset` inline, `Delete saved preset` inline, `EffectiveSignalLengthRerunDialog` (dead) | The "no feedback" pattern — `{busy ? "Deleting…" : "Delete"}` |
| F. **Indeterminate `LinearProgress` with no progress signal** | `ImportScenariosDialog` (new path — the synchronous import_folder POST has nowhere to report progress because the endpoint is blocking) | The "we don't actually know what's happening" fallback |

Patterns A, B and C are all "polling-based progress with elapsed
counter and stage label" — they should be ONE hook. Patterns D and
E should be ONE convention (the "spinner + label" being the
preferred one because text-only changes are easy to miss). Pattern
F should not exist (it's the symptom of the sync/async split in
ImportScenariosDialog — fix is to make the new path async too).

**Proposal:** Promote `useModalMassRun`'s `stage` / `elapsedMs` /
`error` / `summary` shape to a generic `useAsyncOperation` hook;
rebuild `useImportSession` on top of it (the existing hook's
phase / scenarios_total / scenarios_completed surface becomes a
specialization of the general one). Migrate
`CreateProjectFromMeasurementDialog`'s hand-rolled loop to use
the new hook. Result: one canonical async-operation pattern across
all four call sites (dialogs 1, 2, the toolbar "Compute Modal Mass"
button in Tracking, and the auto-chain hook).

---

### 4.2 Sync vs async backend patterns

Operations exposed by the Modal Adapter dialog surface, classified
by their backend contract:

| Operation | Endpoint | Sync/Async | Notes |
|-----------|----------|-----------|-------|
| Probe source | `POST /modal/measurements/probe` | Sync (10s timeout) | Fast — appropriate as sync |
| List source scenarios | `POST /modal/measurements/<id>/list_source_scenarios` | Sync (10s) | Fast — appropriate |
| Probe conflicts | `POST /modal/measurements/<id>/probe_conflicts` | Sync (10s) | Fast — appropriate |
| Unzip helper | `POST /modal/measurements/unzip_helper` | Sync (30 min timeout) | Long-running — should be async, but isn't |
| Import folder (new) | `POST /modal/measurements/import_folder` | Sync (30 min) | **Long-running, should be async, but isn't** — this is the sync half of the sync/async split in `ImportScenariosDialog` |
| Import scenarios (existing) | `POST /modal/measurements/<id>/import_scenarios?async=true` | Async (ImportSession) | Correct |
| Create Project from Measurement | `POST /modal/projects?async=true` | Async (ImportSession) | Correct |
| Delete Measurement | `POST /modal/measurements/<id>/delete` | Sync (60s — bumped from 5s in dev-msdel-3b1a) | Borderline — 60s is the right cap for `rmtree`-cost; could be async but probably not worth the complexity |
| Rename Measurement | `POST /modal/measurements/<id>/rename` | Sync (30s) | Acceptable — rename is fast |
| Delete Project | (via `useModalAdapter.deleteProject`) | Sync (no explicit timeout — axios default) | **Missing explicit timeout** — risk vector |
| Rename Project | (via `useModalAdapter.renameProject`) | Sync (no explicit timeout) | **Missing explicit timeout** |
| Run ESPRIT / Tracking / Feedin / FRF / Modal Mass | various | Sync (10-minute timeout on the pipeline run; some via WebSocket events) | Out of scope (not dialog-hosted) |
| Branch project | (uses `createProjectFromMeasurement`) | Async-capable but `BranchProjectDialog` does NOT request async | **Bug** — large branch operations could time out without progress |
| Save / delete band preset | (various) | Sync (no explicit timeout) | Acceptable — fast operations |

**Net finding:** Two endpoints are silently long-running with no
async path:

1. `POST /modal/measurements/import_folder` (used by
   `ImportScenariosDialog` `targetMode="new"`) — symptomatically
   identical to the bug that motivated dev-cptmto-9d7e for
   `create_project_from_measurement` (5-min → 60-min cap).
2. `POST /modal/measurements/unzip_helper` (used by the zip tab of
   `ImportScenariosDialog`) — 30-min timeout, no progress, no
   cancel.

**Recommendation:** The backend already supports the `?async=true`
+ ImportSession pattern. Extend it to `import_folder` (and
optionally `unzip_helper`); migrate the new-path of
`ImportScenariosDialog` onto `useImportSession` so both paths use
the same contract. This is the Medium-effort #2 in §6.2.

The Branch flow's missing async path is a separate Quick-win
(§6.1) — it already has the hook, it just needs `async: true` in
the options.

---

### 4.3 Timeout audit (all axios calls reachable from a dialog)

Sorted by exposure (highest-risk first — long sync POSTs without
cancel):

| Site | Timeout | Operation | Cancel? | Verdict |
|------|--------:|-----------|:------:|---------|
| `useMeasurementCatalog.js:277` | 30 min | `import_folder` (sync new-path) | NO | **Risk** — same symptom as dev-cptmto-9d7e; should migrate to async |
| `useProjectCRUD.js:402, 465` | 30 min | `importProject` (legacy) | NO | DEAD code path — the orphaned hook calls these. Audit + delete. |
| `ImportScenariosDialog.jsx:383` | 30 min | `unzip_helper` | NO | **Risk** — silent multi-GB upload with no progress |
| `ImportScenariosDialog.jsx:491` | 30 min | `import_folder` (sync new-path) | NO | (duplicate of the catalog hook — Dialog also calls direct) |
| `useModalAdapter.js:984` | 10 min | pipeline run | YES (cancelEsprit) | OK |
| `useImportSession.js:78, 168` | 5s | status poll + cancel POST | n/a | OK — short poll is correct |
| `useMeasurementCatalog.js:176` | 30s | rename Measurement | NO | OK — bounded |
| `useMeasurementCatalog.js:91` | 8s | (probably create) | NO | OK |
| `useMeasurementCatalog.js:55, 123` | 5s | list / something | NO | OK |
| `useMeasurementCatalog.js:175-176` (delete) | 60s (post dev-msdel-3b1a) | delete Measurement | NO | OK after recent bump |
| `ImportScenariosDialog.jsx:233, 261, 305` | 10s | probe / list / conflicts | NO | OK |
| `ImportScenariosDialog.jsx:515` | 30s | async kickoff POST | n/a | OK |
| `useSetupTest.js:106` | 30s | setup test run | NO | OK |
| `useSetupTest.js:61, useMeasurementSetup.js:*, useServerLifecycle.js:*` | 5s | misc short ops | NO | OK |
| `ServerFolderPicker.jsx:134` | 8s | folder listing | NO | OK |
| `CollectionSubpanel.jsx:186, CollectionLog.jsx:107, useModalAdapter.js:259` | 3s | health / defaults | NO | OK |
| **Project Delete / Rename via `useModalAdapter`** | **no explicit timeout** | calls relevant POSTs | NO | **Gap** — falls through to axios default (no timeout). A hung backend would freeze the dialog forever. |

**Recommendation:** Adopt a per-operation-class timeout scheme,
encoded as constants in a single file (e.g.
`src/utils/apiTimeouts.js`):

```
TIMEOUT_PING              = 3_000     // health checks, defaults
TIMEOUT_SHORT             = 5_000     // single-record reads, validation
TIMEOUT_MEDIUM            = 30_000    // multi-record reads, kickoffs
TIMEOUT_LONG              = 60_000    // delete (rmtree-cost), rename (atomic Project rewrites)
TIMEOUT_BLOCKING_LEGACY   = 30 * 60_000  // ONLY for sync-blocking endpoints
                                         // that have not yet migrated to
                                         // ImportSession. Use SHOULD trigger
                                         // a code-review challenge.
```

Then sweep `grep -rn 'timeout:' PianoidTunner/src` and replace
literals with named constants. The `TIMEOUT_BLOCKING_LEGACY`
constant exists primarily to make a /dev session for "migrate
import_folder + unzip_helper to async" naturally trip the search
and complete the migration.

---

### 4.4 Error UX variants

| Variant | Dialogs using it | When |
|---------|------------------|------|
| Inline `<Alert severity="error">` inside DialogContent | Almost all (1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 13?, 14?, 15?, 16) | Default — works well |
| Inline `<Alert severity="error" variant="outlined">` | `UnlockMeasurementDialog`, `Create new Measurement` inline | Subtle visual distinction; no functional difference |
| `<Alert severity="warning">` with switching to error based on string-startsWith check | `DeleteMeasurementConfirmDialog` (`error.startsWith("Cannot delete") ? "warning" : "error"`) | Hack — should be a `kind` field on the error object |
| `setSnackbar({ message, severity })` via parent prop | `MeasurementsManagementDialog` (for success) | Good for success notifications; rarely used for error |
| `<ResultPanel>` transactional 2-step mode (configure → result) | `CreateProjectFromMeasurementDialog` | Heavy but appropriate for long-running create flow |
| TextField `helperText` for validation errors | `RenameProjectDialog`, `Save band preset` inline, `Create new Measurement` inline | OK for client-side validation, but mixes with backend-error display in inconsistent ways (e.g. some dialogs show backend errors in a separate Alert; others overload `helperText`) |
| Code-specific error mapping | `RenameMeasurementDialog` (5 distinct mappings) | The right approach — but ONLY one dialog does this. Others surface raw backend `error` strings |
| No error display at all | `Replace existing preset` inline, `Delete saved preset` inline | Bug — silent failures possible |

**Recommendation:** Pick ONE canonical error display contract:

1. Client-side validation errors → TextField `helperText` (existing).
2. Backend errors → Inline `<Alert severity="error" variant="outlined">` inside DialogContent (the existing default).
3. Success notifications → Snackbar via the global Snackbar mechanism already in `ModalAdapter.jsx` line 1734.
4. Long-running transactional flows → `ResultPanel`-style 2-step (kept for `CreateProjectFromMeasurementDialog` only — overkill for others).

The "warning vs error by string-prefix" hack in
`DeleteMeasurementConfirmDialog` should be replaced by a structured
error object `{ kind: "warning" | "error", message }`.

---

### 4.5 Duplicated / near-duplicate dialogs

The round-30 consolidation already killed several pre-existing
duplicates (`MeasurementImportDialog`, `AddScenariosToMeasurementDialog`,
and one more per the archived log). The dialogs that remain
suspiciously similar:

#### Duplicate pair A — "Delete X with linked-resource 409 surface"

- `DeleteProjectDialog.jsx` (222 LOC) — also handles "delete linked Measurements" checkbox via the safety-guard.
- `DeleteMeasurementConfirmDialog` (nested in `MeasurementsManagementDialog`, ~160 LOC) — also handles linked-Projects 409 with chip list.

Both: confirm destructive action; both: show linked-resource list
from the 409 response; both: nested inside a parent browser
dialog. They differ in busy-state presentation, error
severity-switching style, and the "delete linked extras" option
(checkbox on the Project side; no equivalent for the Measurement
side because the contract is "delete linked Projects first, then
retry" rather than "delete both").

**Consolidation:** A shared `<ConfirmDestructiveDialog>` that
accepts:

```
{
  open, onClose, onConfirm,
  title, body,
  resourceName, resourceKind,                // "Project" | "Measurement"
  cascadeOption?: { label, checked, onChange, disabled, reason }
  linkedResources?: { count, list, fetchOnConflict }
  busy, error: { severity: "error"|"warning", message }
}
```

Both consumers shrink to a 30-line invocation each.

#### Duplicate pair B — "Rename X with code-specific error messages"

- `RenameProjectDialog.jsx` (132 LOC) — simple regex validation; raw backend error.
- `RenameMeasurementDialog` (nested, ~155 LOC) — code-specific error decoder.

Both: name input + validate + submit. The decoder in the
Measurement variant is the better pattern; the Project equivalent
should adopt it. A shared `<RenameDialog>` with a
`resourceKind` + `errorDecoder` prop is the natural consolidation.

#### Duplicate pair C — "Name input + create" patterns

Four dialogs (Branch, Save band preset, Create new Measurement,
plus the simpler half of CreateProjectFromMeasurement) follow the
same pattern: open dialog → user types name → optional toggle →
busy state → success/error. They could share a
`<NamedActionDialog>` with optional fields. **However** this
consolidation has lower ROI than A and B because the dialogs are
small and varied; might create more abstraction than it removes.
Tentative recommendation: build A + B first; revisit C only if it
shrinks total LOC meaningfully.

#### Dead-code duplicates

`CreateProjectDialog.jsx` (473 LOC) + `EffectiveSignalLengthRerunDialog.jsx`
(479 LOC) + their two test files (810 LOC) — see §3.19 and §3.20.
Pure dead-weight; trivially deletable.

---

### 4.6 MUI dark-theme conformance

Sweep for `style=` (inline) and hardcoded hex colors across the
dialog files:

- Every dialog uses MUI components and `sx` props — no Tailwind, no shadcn, no custom CSS files.
- No inline `style=` attributes for color / size.
- Hardcoded path `D:\\modal_measurements` in `DeleteProjectDialog.jsx:22` is the only environment-specific literal; not a theme issue but a portability concern.
- Some dialogs use `backgroundColor: "background.default"` (theme-driven) for monospace path blocks — correct pattern. Two examples: `DeleteProjectDialog.jsx:140`, `RenameProjectDialog.jsx:87`.
- All `CircularProgress` instances use `color="inherit"` inside startIcon — correct for theme inheritance.
- `EspritConfig.jsx` inline preset dialogs use `color="warning"` and `color="error"` semantically — correct.

**Net:** dialog code base is MUI dark-theme conformant. No
violations to fix. This is the one cross-cutting category where
nothing needs to change.

---

### 4.7 Header / body / footer layout consistency

| Pattern | Usage |
|---------|-------|
| `<DialogTitle>` plain string | Most dialogs |
| `<DialogTitle>` with `<Stack direction="row" alignItems="center" spacing={1}>` + icon + label | `DeleteProjectDialog`, `DeleteMeasurementConfirmDialog`, `UnlockMeasurementDialog` — the "destructive action" subset |
| `<DialogTitle>` with subtitle line (caption) | `ProjectBrowserDialog` (shows `projectsBase`); `CreateProjectFromMeasurementDialog` (shows parent Measurement) |
| `<DialogContent>` | Universal |
| `<DialogContent dividers>` | Only `PaneSettingsDialog` — uses MUI's built-in dividers |
| `<DialogContentText>` | Used by most "simple confirm" dialogs (BranchProjectDialog, UnlockMeasurementDialog, EspritConfig presets, grid-mismatch); NOT used by the larger form-based dialogs |
| `<DialogActions>` Cancel + primary | Almost universal |
| `<DialogActions>` Cancel + primary with `color="warning"` or `color="error"` | Destructive action variant |
| `<DialogActions>` single OK button | `ResultPanel` mode of CreateProjectFromMeasurementDialog; SetupTest report dialog |
| `<DialogActions>` Cancel + primary with `startIcon={busy ? <CircularProgress size={14} /> : null}` | The "thin spinner" pattern (D in §4.1) |

**Net:** layout is consistent within tolerance. The one
opportunity: extract a `<DialogHeader>` shared component that
accepts `{ icon, title, subtitle }` and produces the
`Stack`-wrapped header. Five+ dialogs would shrink by ~10 LOC each
(50 LOC total). Low ROI individually but bundles well with the
shared `<ConfirmDestructiveDialog>` (§4.5 pair A) refactor.

---

### 4.8 Cancel / Close semantics

| Pattern | Used by | Issue |
|---------|---------|-------|
| Cancel button + Esc / backdrop both work | Most simple confirms | OK |
| Cancel button works; Esc / backdrop disabled while busy (`onClose={busy ? undefined : onCancel}`) | `UnlockMeasurementDialog`, `DeleteMeasurementConfirmDialog`, `RenameMeasurementDialog`, `CreateProjectFromMeasurementDialog`, `ImportScenariosDialog` | Correct pattern for in-flight operations |
| Cancel button aborts the in-flight POST via AbortController + backend cancel | `CreateProjectFromMeasurementDialog`, `ImportScenariosDialog` (existing path only) | The right behavior — but only 2 dialogs do this |
| Cancel button disabled while busy (does NOTHING during busy) | `DeleteProjectDialog`, `DeleteMeasurementConfirmDialog`, `RenameProjectDialog`, `RenameMeasurementDialog`, `BranchProjectDialog`, `Create new Measurement` inline, `Save band preset` inline | Acceptable for short ops (< 30s); risky for any op that can run > 30s |
| Cancel button is BOTH active AND not wired to abort | `ImportScenariosDialog` `targetMode="new"` during the 30-min `import_folder` POST | **Bug** — user clicks Cancel, nothing visible happens, dialog remains "Importing…" until the 30-min timeout fires. Same UX as the pre-dev-cptmto-9d7e symptom for CreateProjectFromMeasurement |
| Cancel button label changes to "Close" after terminal phase | `ImportScenariosDialog` | Nice touch |

**Recommendation:** establish a hard convention: any dialog that
can have an in-flight backend operation > 5 seconds MUST have
Cancel wired to a real abort (AbortController + cooperative
backend cancel where available). The migration to async + the
shared `useAsyncOperation` hook (§4.1) would deliver this
automatically — that's another reason to prioritize §4.1.

---

### 4.9 Form-validation patterns

| Pattern | Usage |
|---------|-------|
| Client-side regex for name validation | `RenameProjectDialog` (`/^[A-Za-z0-9._\- ]+$/`); `MeasurementSelector` create dialog (no regex, just trim+nonempty); `RenameMeasurementDialog` (just trim+nonempty); `BranchProjectDialog` (just trim+nonempty) |
| Client-side collision check against parent's existing names | `CreateProjectFromMeasurementDialog`, `ImportScenariosDialog` (`targetMode="new"`), `RenameMeasurementDialog` (`existingIds` prop) |
| Submit button disabled state | Universal — driven by per-dialog `submitDisabled` computation |
| Inline error → cleared on user typing | `RenameProjectDialog` (line 100: `if (error) setError("")`), `Save band preset` (line 846), `BranchProjectDialog` (line 148) |
| `autoFocus` on the primary input | Most dialogs that take input |
| `onKeyDown` for Enter-submits | `RenameProjectDialog` (line 103), `Save band preset` (lines 852-857), `BranchProjectDialog` (line 149); NOT consistent elsewhere |

**Net:** patterns are mostly consistent but the validation regex
disagreement between `RenameProjectDialog` (printable subset) and
`RenameMeasurementDialog` ("slug rules apply" message but no
regex shown) reflects the backend's different validators. That's
not a frontend bug per se but is a UX inconsistency. The
shared-`<RenameDialog>` refactor (§4.5 pair B) is the natural
fix.

---

## 5. In-flight branches that intersect this review

Four `feature/*` branches are NOT yet merged to `dev` and contain
changes that touch the dialog surface or its supporting hooks.
Reviewing them in context so the consolidation roadmap is built on
their post-merge state:

| Branch | Repo | Status | Files touched | Relevance to this review |
|--------|------|--------|---------------|--------------------------|
| `feature/dev-mmui-6e97` | PianoidTunner | Round 3 done, NOT merged. 730/730 tests PASS. | NEW `useModalMassRun.js` (242 LOC), NEW `ModalMassFreqChart.jsx` (408 LOC), DELETED `ModalMassPanel.jsx` (664 LOC), DELETED `ModalMassPanel.test.jsx` (263 LOC), edits to `ModalAdapter.jsx` (+276), `ModalResultsView.jsx`, `StabilizationDiagram.jsx` | **Largest relevance.** Introduces `useModalMassRun` — the canonical "stage + elapsedMs + error + summary" hook that the §6.2 Medium refactor proposes to generalize. The Modal Mass *tab* is removed; functionality moves into the Tracking subpanel + StabilizationDiagram. Net effect on this review: 1 fewer dialog-adjacent panel (ModalMassPanel) and 1 new hook ready to consume. |
| `feature/dev-msdel-3b1a` | PianoidTunner | Done, NOT merged. | `useMeasurementCatalog.js` (5s → 60s timeout for `deleteMeasurement`) + test | Tiny change. Resolves one of the §4.3 timeout audit findings. The roadmap should NOT propose to re-tune this — leave the merge to land. |
| `feature/dev-cptmto-9d7e` | PianoidTunner | Done, NOT merged. | `CreateProjectFromMeasurementDialog.jsx` (5min → 60min POLL_MAX_MS + elapsed UX + still-running banner + improved error msg) + 8 new tests | Tied directly to dialog #2. Pushes CreateProjectFromMeasurementDialog from 975 LOC YELLOW → 1130 LOC RED. The roadmap should NOT propose to re-tune the timeout; the file-split (§6.2 ResultPanel extraction) IS proposed because the new LOC tipped it past the RED line. |
| `feature/dev-mmui-6e97-r3` | PianoidCore | Round 3 backend, NOT merged | `modal_adapter.py` get_project_state fix + tests | Backend-only — pairs with `feature/dev-mmui-6e97`. No direct relevance to dialog review but the roadmap assumes its `data_status` fixes have landed because they unblock the Modal Mass chart's empty-state. |

**Sequencing implication:** The roadmap recommendations in §6
should be **applied AFTER** the four branches above merge to `dev`.
Specifically:

- Recommendation §6.2 #1 (generalize `useModalMassRun` →
  `useAsyncOperation`) depends on the hook being on `dev`. If
  this review's /dev session starts before the merge, it must
  rebase on `feature/dev-mmui-6e97`.
- Recommendation §6.4 #1 (delete `CreateProjectDialog`,
  `EffectiveSignalLengthRerunDialog`) can be done now — no branch
  collisions.
- Recommendation §6.1 #2 (file-split for
  `CreateProjectFromMeasurementDialog.jsx`) MUST wait for
  `feature/dev-cptmto-9d7e` to merge — splitting before merging
  would lose the dev-cptmto-9d7e edits.

No conflict between this review's recommendations and any in-flight
work; only sequencing.

---

## 6. Recommended consolidation roadmap

Recommendations are sorted by ROI within each tier and tagged with
file:line scope, effort estimate (hours of a /dev session
including tests + docs), risk level (Low / Med / High), and
explicit dependencies.

### 6.1 Quick wins (1-3 h /dev sessions each)

| # | Recommendation | Scope | Effort | Risk | Depends on |
|---|---------------|-------|-------:|------|------------|
| 1 | **Wire `BranchProjectDialog` to `async: true`** so large parent-Measurement branches show progress + can cancel | `modules/panels/ProjectSubpanel.jsx:106-185` + `handleBranch` upstream | 2h | Low | — |
| 2 | **Drop the "warning vs error by string-startsWith" hack** in `DeleteMeasurementConfirmDialog` — replace with structured `{ severity, message }` object | `MeasurementsManagementDialog.jsx:253` | 1h | Low | — |
| 3 | **Add explicit timeouts to Project rename + delete** in `useModalAdapter.js` (currently use axios default = no timeout) | `useModalAdapter.js` — find the relevant POSTs | 1h | Low | — |
| 4 | **Add error handling to Replace + Delete preset inline dialogs** in `EspritConfig.jsx` — currently swallow backend failures | `EspritConfig.jsx:877-917` | 2h | Low | — |
| 5 | **Update stale "Renaming is coming in a future release" copy** in `MeasurementsManagementDialog.jsx:666` — rename shipped in round 15 | `MeasurementsManagementDialog.jsx:664-669` | 0.5h | Low | — |
| 6 | **Add `CircularProgress` startIcon to `DeleteProjectDialog` and `RenameProjectDialog`** for visual consistency with the Measurement counterparts (pattern E → pattern D) | `DeleteProjectDialog.jsx:213`, `RenameProjectDialog.jsx:120-125` | 1h | Low | — |
| 7 | **Replace the dead Copy-mode branch in `ProjectBrowserDialog`** — `mode="copy"` is documented but unreachable since N8 hard cutover. DONE (dev-dlgrm-4b1a, 2026-05-26, commit 4154b6c). Also paired with §6.4 #4. | `ProjectBrowserDialog.jsx` — drop `mode === "copy"` branches + `copyName` state | 2h | Low | Confirm no test depends on copy mode (likely safe per dispatch wording about Phase 2c) |
| 8 | **Extract a `<DialogHeader>` shared component** for the destructive-action-with-icon pattern (4 dialogs use it) | new `components/dialogs/DialogHeader.jsx` + replace in `DeleteProjectDialog`, `DeleteMeasurementConfirmDialog`, `UnlockMeasurementDialog`, `MeasurementsManagementDialog` (rename target) | 3h | Low | — |

**Total quick wins effort:** ~12.5 hours.

---

### 6.2 Medium refactors (4-8 h /dev sessions)

| # | Recommendation | Scope | Effort | Risk | Depends on |
|---|---------------|-------|-------:|------|------------|
| 1 | **Generalize `useModalMassRun` → `useAsyncOperation`** ; rebuild `useImportSession` on top of it ; migrate `CreateProjectFromMeasurementDialog`'s hand-rolled polling loop to use it | NEW `src/hooks/useAsyncOperation.js` (~150 LOC); migrate `useImportSession.js` (-50 LOC); migrate `CreateProjectFromMeasurementDialog.jsx` (-80 LOC of duplicated polling loop) | 8h | Med | `feature/dev-mmui-6e97` merged |
| 2 | **Migrate `ImportScenariosDialog`'s `targetMode="new"` path to async** + extend `POST /modal/measurements/import_folder` to accept `async: true` (backend work) | `ImportScenariosDialog.jsx` lines 478-496; backend `measurement_routes.py` import_folder route | 8h split across frontend + PianoidCore | Med | §6.2 #1 (hook generalization) + close-out of in-flight `dev-msdel-3b1a` |
| 3 | **Extract `<ConfirmDestructiveDialog>` shared component** ; migrate `DeleteProjectDialog` and `DeleteMeasurementConfirmDialog` to use it | new `components/dialogs/ConfirmDestructiveDialog.jsx` (~150 LOC); migrate two consumers | 6h | Med | §6.1 #8 (DialogHeader) recommended first |
| 4 | **Extract `<RenameDialog>` shared component** ; migrate `RenameProjectDialog` and `RenameMeasurementDialog` to use it ; standardize code-specific error decoder pattern | new `components/dialogs/RenameDialog.jsx` (~120 LOC); migrate two consumers | 5h | Med | — |
| 5 | **Extract `ResultPanel` + `formatElapsed` from `CreateProjectFromMeasurementDialog.jsx`** to drop the file under the 1000-LOC RED line | new `components/CreateProjectFromMeasurementDialog/ResultPanel.jsx` (~120 LOC); `utils/formatElapsed.js` (already exported, just move); main file shrinks from 1130 → ~900 (YELLOW) | 4h | Low | `feature/dev-cptmto-9d7e` merged |
| 6 | **Extract nested dialogs from `MeasurementsManagementDialog.jsx`** to drop it under 1000 LOC RED | new `components/MeasurementsManagementDialog/DeleteMeasurementConfirmDialog.jsx`, `RenameMeasurementDialog.jsx`, `LinkedProjectsPopover.jsx`; main file shrinks 1055 → ~700 (YELLOW) | 5h | Low | Bundles well with §6.2 #3 and #4 |
| 7 | **Extract grid-mismatch dialog from `ModalAdapter.jsx`** to a `GridMismatchDialog.jsx` file (small step toward shrinking the 1756 LOC RED `ModalAdapter.jsx`) | new `components/GridMismatchDialog.jsx` (~55 LOC); strip `ModalAdapter.jsx` ~55 LOC | 2h | Low | — |
| 8 | **Establish `apiTimeouts.js` constants** + sweep replace literals across the dialog files | new `src/utils/apiTimeouts.js`; ~30 grep-replace sites across hooks + dialogs | 4h | Low | — |

**Total medium refactor effort:** ~42 hours, split across 8
sessions (one PR each).

---

### 6.3 Architectural changes (deserve their own proposals)

| # | Recommendation | Rationale | Scope |
|---|---------------|-----------|-------|
| 1 | **`ModalAdapter.jsx` decomposition** — split the 1756 LOC pane into a thin shell + per-section subpanels (Setup section + Apply section already exist as subpanels; Tracking section is still inline; Collect section is delegated; Modal Mass section is going away per dev-mmui-6e97). The grid-mismatch dialog + the in-toolbar settings Collapse panel are the remaining inline weight. | Already YELLOW since 2025; was 2249 LOC before the Phase 2c extraction; the dev-mmui-6e97 round-2 round-3 work added 276 LOC pushing it back up | own /analyse → own proposal doc; cross-references `docs/proposals/modal-adapter-split-2026-05-21.md` |
| 2 | **Backend async opt-in for ALL long-running endpoints** — formalize the ImportSession pattern as the *only* contract for any backend operation > 5s. Audit + migrate `import_folder`, `unzip_helper`, `setup_test`, anything else | Three independent inventions of the same elapsed-counter+polling pattern is the symptom that the contract isn't yet formalized | own proposal doc; touches PianoidCore measurement_routes + frontend hooks |
| 3 | **Unify pane settings UX** — the Modal Adapter's Collapse-based settings panel diverges from PaneSettingsDialog. Either migrate other panes to Collapse, or migrate Modal Adapter to the dialog. | Cross-pane consistency; users don't know if the gear icon will open a dialog or a Collapse | own proposal doc; intersects with the App.js / mosaic-window rework |

These are deliberately NOT scoped into the /dev roadmap. Each
should be its own /analyse → proposal → /dev cycle so the
trade-offs get the discussion they deserve.

---

### 6.4 Code-quality reductions (dead code + file-size relief)

| # | Recommendation | LOC saved | Risk | Notes |
|---|---------------|---------:|------|-------|
| 1 | **Delete `CreateProjectDialog.jsx` + its test** — DONE (dev-dlgrm-4b1a, 2026-05-26, commit 9391fb7) | 937 LOC | Low | DEAD CODE; verified no production import. Phase 2c cutover comment in `ModalAdapter.jsx:60` confirms |
| 2 | **Delete `EffectiveSignalLengthRerunDialog.jsx` + its test** — DONE (dev-dlgrm-4b1a, 2026-05-26, commit dd5c8cf) | 825 LOC | Low | DEAD CODE; was chained from CreateProjectDialog |
| 3 | **Audit and remove orphaned hooks in `useProjectCRUD.js`** — `importProject`, `copyProject`, `reaverageProject`, `fetchEffectiveSignalLength` are referenced by the dead dialogs above and possibly nothing else. Audit COMPLETE (dev-dlgrm-4b1a, 2026-05-26): all 4 confirmed orphaned at production-caller level. `fetchEffectiveSignalLength` has zero tests too. See dev-dlgrm-4b1a session log "Heads-up — orphaned hook methods" for the per-method breakdown. Deletion scheduled for a separate /dev session per §8 #2. | ~200-400 LOC | Med | Per `ModalAdapter.jsx:183-188` comment: "the hook still exports them (legacy callers + tests still reach for them); only this mount stops using them". |
| 4 | **Drop the Copy-mode branch** from `ProjectBrowserDialog.jsx` (paired with §6.1 #7) — DONE (dev-dlgrm-4b1a, 2026-05-26, commit 4154b6c) | 118 LOC | Low | Same dead-code source — Phase 2c removed the Copy-From button |
| 5 | **Extract nested dialogs from `MeasurementsManagementDialog.jsx`** (paired with §6.2 #6) | n/a (relocates not removes) | Low | Drops the file out of the RED ranking |
| 6 | **Extract `ResultPanel` from `CreateProjectFromMeasurementDialog.jsx`** (paired with §6.2 #5) | n/a (relocates not removes) | Low | Drops the file out of the RED ranking |

**Net deletable LOC if §6.4 #1-4 land:** ~2000+ LOC of dead/duplicated code,
across components + tests + orphaned hook methods. This is the
single highest-ROI bucket in the entire roadmap — a `/dev`
session of about 4-6 hours could land all of it.

**Status (2026-05-26, dev-dlgrm-4b1a):** §6.4 #1, #2, #4 LANDED on
`feature/dev-dlgrm-4b1a` (PianoidTunner). LOC removed: 937 + 825 + 118
= **1880 LOC**. Jest sweep: 64 suites / 739 tests pre-change → 62 suites /
694 tests post-change (-2 suites, -45 tests, all in deleted-test boundary,
no regression in surviving tests). §6.4 #3 (orphan hook removal) deferred
to a follow-up session per §8 #2; audit findings recorded in
`docs/development/logs/dev-dlgrm-4b1a-*.md` "Heads-up — orphaned hook
methods" section.

---

## 7. Sequencing summary

Suggested merge order, given the in-flight branches and the
dependencies above:

**Phase A — wait for in-flight merges (no work):**
- `feature/dev-mmui-6e97` (+ `r3`) → `dev`
- `feature/dev-cptmto-9d7e` → `dev`
- `feature/dev-msdel-3b1a` → `dev`
- `feature/dev-frfres-9c41` → `dev` (PianoidCore-only; doesn't block frontend dialog work)

**Phase B — code-quality reductions (Quick win; biggest single-session payoff):**
- §6.4 #1, #2, #4 — delete dead code + Copy-mode branch (~2000 LOC removed)
- §6.4 #3 — audit and remove orphaned hooks (separate session if it expands)

**Phase C — Quick wins (parallel, can be one or two PRs):**
- §6.1 #1-7 — bundled into a single "dialog polish" PR; ~10-12 h
- §6.1 #8 — DialogHeader extraction can also land here; small enough to bundle

**Phase D — Medium refactors (sequence matters):**
1. §6.2 #5 (ResultPanel extraction) — depends on Phase A merge of dev-cptmto-9d7e
2. §6.2 #6 (Measurements dialog nested extraction)
3. §6.2 #7 (grid-mismatch extraction from ModalAdapter)
4. §6.2 #1 (useAsyncOperation generalization) — depends on Phase A merge of dev-mmui-6e97
5. §6.2 #2 (ImportScenariosDialog new-path async migration) — depends on §6.2 #1 + backend route work
6. §6.2 #3 (ConfirmDestructiveDialog) — bundles with §6.2 #6
7. §6.2 #4 (RenameDialog shared) — bundles with §6.2 #6
8. §6.2 #8 (apiTimeouts constants) — final sweep, can ride along with any of the above

**Phase E — architectural changes (each as its own proposal):**
- §6.3 #1, #2, #3 — sized as separate /analyse sessions

---

## 8. Open questions / scope ambiguities

1. **Copy-mode dead branch (§6.1 #7 / §6.4 #4) — does anyone still rely on it?** The dispatch text says "Round 30 explicitly killed several" duplicates but Copy mode isn't enumerated. `ProjectBrowserDialog.jsx` still accepts `mode="copy"` and `ProjectSubpanel.jsx:476` passes `mode="open"` only. Cross-checked: no production call passes `"copy"`. The dispatch line 60-62 of ModalAdapter.jsx confirms Copy-From was removed per N8. **Confidence: high that this is dead.** /dev session should re-verify with a fresh grep before deletion.

2. **Orphaned hooks audit (§6.4 #3) — out of scope here?** The `useProjectCRUD.js` legacy methods are referenced by dead-code tests. Doing the audit properly means tracking ALL imports of `useModalAdapter` destructures across the test suite. Could either be a stand-alone /dev session OR rolled into §6.4 #1. Flagging as ambiguous; recommend stand-alone session to avoid scope creep on the dead-code-delete PR.

3. **Backend dependency for §6.2 #2** — migrating `import_folder` to async requires a PianoidCore-side endpoint change. Out of scope for a frontend-only /dev session. Either schedule a `multitask` to coordinate frontend + backend (the dev-cptmto-9d7e / dev-frfres-9c41 split is the recent prior art for this), or do the backend change as a separate session and queue the frontend migration after merge.

4. **§6.2 #1 risk surface** — generalizing `useModalMassRun` will touch a hook that is brand-new and not yet merged to dev. The risk is "the dev-mmui-6e97 hook hasn't yet seen user verification; generalizing it might bake in a bug". Mitigation: gate the generalization on live verification of dev-mmui-6e97 first. The Phase A wait above naturally handles this.

5. **`PaneSettingsDialog` vs in-Modal-Adapter Collapse settings (§6.3 #3)** — the Modal Adapter pane's settings UX is a 350-LOC `<Collapse><Paper>` block embedded in the toolbar area (`ModalAdapter.jsx` lines 935-1273). This is intentional (per-section settings change with `activeSection`), but it means the entire pane diverges from the rest of the frontend. Worth a dedicated proposal — flagged here so the consolidation roadmap doesn't accidentally try to migrate it (the in-Collapse layout is locked to `activeSection` and trying to dialog-ify it would re-introduce the lock issues that motivated dev-md04 Bug 2 + the dev-malock fix).

6. **`DEFAULT_MEASUREMENTS_ROOT` in `DeleteProjectDialog.jsx:22`** — hardcoded Windows path. Either pass the root through props from the backend's resolved value, OR mark this as a known Linux-portability gap. Not strictly a dialog-review finding (it's a portability bug), but surfaced because it lives in a dialog file. Flag for a follow-up after the broader Linux-port effort lands.

---

## Cross-references

- Round-30 import consolidation: archived
  `docs/development/logs/archive/dev-maimport-2026-05-19-135147.md`
  ("Round 30" sections)
- ModalAdapter split history:
  [`docs/proposals/modal-adapter-split-2026-05-21.md`](http://localhost:8001/proposals/modal-adapter-split-2026-05-21/)
- Measurement entity design:
  [`docs/proposals/modal-adapter-measurement-entity-2026-05-10.md`](http://localhost:8001/proposals/modal-adapter-measurement-entity-2026-05-10/)
- REST_API doc-gap for round-30 async endpoints (open):
  [`docs/development/WORK_IN_PROGRESS.md`](http://localhost:8001/development/WORK_IN_PROGRESS/#doc-gap-round-30-async-import-path-in-rest_apimd-2026-05-25)
- Code quality file-size thresholds:
  [`docs/development/CODE_QUALITY.md` §Current Known God Objects](http://localhost:8001/development/CODE_QUALITY/#current-known-god-objects-baseline-debt)
- Frontend overview:
  [`docs/modules/pianoid-tunner/OVERVIEW.md`](http://localhost:8001/modules/pianoid-tunner/OVERVIEW/)
- UI testing canonical procedure:
  [`docs/guides/UI_TESTING.md`](http://localhost:8001/guides/UI_TESTING/)
- `useModalMassRun` hook (currently on `feature/dev-mmui-6e97`):
  `PianoidTunner/src/hooks/useModalMassRun.js`
- `useImportSession` hook:
  `PianoidTunner/src/hooks/useImportSession.js`
- Measurement Collection v2:
  [`docs/modules/pianoid-middleware/MODAL_COLLECTION.md`](http://localhost:8001/modules/pianoid-middleware/MODAL_COLLECTION/)
