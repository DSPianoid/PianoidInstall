# Proposal: Reorganize the Collection Subpanel to Match the Standard Settings Architecture

**Date:** 2026-05-26
**Status:** IMPLEMENTED + MERGED — PianoidTunner `dev-collreorg-7a3f` commits `54ccc25`→`44a1617`, merged to `dev` via `86d720c`. Archived 2026-06-05.
**Agent:** `ana-csub-4f12` (read-only `/analyse` pass).
**Status:** **IMPLEMENTED** by `dev-collreorg-7a3f` (2026-05-26) on `feature/dev-collreorg-7a3f` (PianoidTunner) — 6 commits 54ccc25 → 44a1617. Live verification was deferred (test-ui blocker — PowerShell permission denied + Bash long-running-process gate); coverage via Jest (765 tests / 66 suites PASS, including 12 source-text architecture-guard assertions in `ModalAdapter.lockSettings.test.jsx`). Awaits orchestrator merge sweep + user live test.
**Scope:** `PianoidTunner/src/modules/panels/CollectionSubpanel.jsx` (584 LOC) and its 6 child sections in `PianoidTunner/src/modules/panels/collection/*.jsx` (~2,360 LOC across the folder), plus a small number of editorial deltas to `ModalAdapter.jsx`'s inline Setup/Tracking/Apply panels so the cross-pane vocabulary lines up.

**Related docs:**
- `docs/proposals/modal-adapter-measurement-entity-2026-05-10.md` — §4.1 (original Collection layout) and §4.2 (Project subpanel slim-down). The current Collection subpanel was specced by §4.1 and shipped in Phase 2b; the present proposal does NOT re-litigate that contract, it brings the *shell* around the 5 sections in line with the rest of the Modal Adapter.
- `docs/proposals/modal-adapter-split-2026-05-21.md` — backend split (server-side), referenced here only as evidence that the Modal Adapter codebase is mid-refactor and consistency between panes pays off.
- `docs/proposals/modal-adapter-dialog-review-2026-05-26.md` (parallel agent `ana-madlg-7c2e`, NOT yet committed) — dialog inventory. Where this proposal touches dialog *mounting* (open/close state ownership), it cross-references that proposal rather than duplicating dialog-content recommendations.
- `D:\repos\PianoidInstall\.claude\CLAUDE.md` — "Frontend UI Standards" (MUI v6, dark theme, `sx` prop, no inline styles, dense layouts).

---

## Table of Contents

1. [Why this proposal exists](#1-why-this-proposal-exists)
2. [Inventory: what "the standard" actually is](#2-inventory-what-the-standard-actually-is)
3. [Current state of the Collection subpanel](#3-current-state-of-the-collection-subpanel)
4. [Gap analysis — Collection vs the standard](#4-gap-analysis--collection-vs-the-standard)
5. [Proposed reorganization](#5-proposed-reorganization)
6. [Migration plan for the `/dev` agent](#6-migration-plan-for-the-dev-agent)
7. [Risk and rollback](#7-risk-and-rollback)
8. [Out of scope](#8-out-of-scope)
9. [Appendix: file:line evidence index](#9-appendix-fileline-evidence-index)

---

## 1. Why This Proposal Exists

The Modal Adapter pane has 4 user-facing sections in its top-level toolbar:

```
[Collect] [Setup] [Tracking] [Apply]
```

Sections **Setup**, **Tracking**, and **Apply** share a consistent UI shell — a **gear button in the native MosaicWindow title bar** opens a **collapsible settings panel** at the top of the pane body (above the main content). The user toggles settings in/out of view without leaving the section; the section's main content (project info, stabilization diagram, export panels) stays in the body below.

Section **Collect** is structurally different. It does NOT participate in the gear / settings-panel idiom. It uses an Accordion stack inside the main body, with each Accordion holding its OWN per-section save button. The gear icon for the Collect section does not appear at all (it's gated by `PIPELINE_RUN_SECTIONS.includes(activeSection)` at `ModalAdapter.jsx:800`).

**Concrete user-visible consequences:**

1. The settings-gear discoverability story is inconsistent. A user who learns "settings live behind the gear" in Setup/Tracking/Apply does not transfer that mental model to Collect.
2. The Collect view has no clear separation between "configuration I rarely touch" (calibration criteria, audio devices, impulse waveform) and "things I do on every acquisition" (select measurement, run setup test, start collection, watch log). All 7-ish concerns share the same vertical scroll.
3. There is no canonical place to put a **save-all** button or a **per-section dirty indicator** that the toolbar / settings gear can reflect. Each Accordion saves itself in isolation; the parent has no aggregate view.

The intent of this proposal is to bring Collect into the same **toolbar + gear-toggled settings panel + main content body** architecture used by Setup/Tracking/Apply, *without* re-litigating §4.1 of the measurement-entity proposal (the 5 sections themselves and their per-section save model — those are correct and stay).

---

## 2. Inventory: What "the Standard" Actually Is

I read the 3 standard sections (Setup, Tracking, Apply) end-to-end and extracted their common pattern. The standard is **inlined in `ModalAdapter.jsx`**, not in separate files like ProjectSubpanel — the term "subpanel" actually refers to *the body content* of a section, not to a settings shell. Let me lay out what each section does so the canonical pattern is unambiguous.

### 2.1 Where each section lives

| Section | Body content lives in | Settings panel lives in | Toolbar lives in |
|---|---|---|---|
| **Collect** | `panels/CollectionSubpanel.jsx` (its own file) | n/a — Collection has no top-of-pane settings panel | n/a — Collect doesn't surface the gear |
| **Setup** | `panels/ProjectSubpanel.jsx` (its own file) | Inlined in `ModalAdapter.jsx:940-1152` | `ModalAdapter.jsx:820-916` (shared) |
| **Tracking** | Inlined in `ModalAdapter.jsx:1373-1461` | Inlined in `ModalAdapter.jsx:1153-1239` (plus the `feature/dev-mmui-6e97` Auto-chain checkbox added at line 1425+) | shared, plus the dev-mmui-6e97 **Compute Modal Mass** button at line 991+ |
| **Apply** | Inlined in `ModalAdapter.jsx:1473-1664` | Inlined in `ModalAdapter.jsx:1240-1271` | shared |

(`feature/dev-mmui-6e97` is unmerged at time of writing — see the parent agent's brief. The lines above are POST-merge target locations.)

### 2.2 The shared toolbar architecture

`ModalAdapter.jsx:820-916` is the shared toolbar that all 4 sections render under. It is a single `<Stack direction="row">` that contains, left to right:

1. **Server status chip** ("On" / "Off") — at line 829.
2. **Pipeline section ButtonGroup** — `[Collect][Setup][Tracking][Apply]` at line 842.
3. **Flex spacer** at line 874.
4. **(Per-section toolbar buttons — currently only the new `Compute Modal Mass` button at line 991, gated by `activeSection === "tracking"` and only on the dev-mmui-6e97 branch.)**
5. **Run-section + Run-pipeline play buttons** — at line 877, gated by `PIPELINE_RUN_SECTIONS.includes(activeSection)` so Collect skips them.
6. **Gear button** — at `ModalAdapter.jsx:800-814`, portalled into the native MosaicWindow title bar via `ReactDOM.createPortal(settingsButton, toolbarHost)` at line 819. ALSO gated by `PIPELINE_RUN_SECTIONS.includes(activeSection)` — Collect does NOT get a gear.

### 2.3 The shared settings-panel architecture

Directly below the toolbar, a single `<Collapse>` element at `ModalAdapter.jsx:935-1273` renders the settings panel. Three rules govern it:

- **Gate:** `showSettings && PIPELINE_RUN_SECTIONS.includes(activeSection)` — meaning, only when the user has clicked the gear AND the active section is one of `setup` / `tracking` / `apply`.
- **Container:** a single `<Paper variant="outlined" sx={{ mx: 1, mt: 0.5, p: 1, flexShrink: 0 }}>` — consistent vertical rhythm regardless of which section is selected.
- **Body:** a section-switched body. Three blocks, one for each of `activeSection === "setup"` / `"tracking"` / `"apply"`, each wrapped in a `<Stack spacing={...}>`.

The contents of each settings block follow a per-section style but share five sub-patterns:

| Sub-pattern | Setup uses it? | Tracking uses it? | Apply uses it? |
|---|---|---|---|
| Inline form rows (TextField + Select + Switch) | yes — Layout selector at 944 | yes — tracking method + tolerance + max-gap + per-stage MAC thresholds at 1153+ | yes — merge switch + per-channel sound mapping at 1242+ |
| Accordion section with a "Locked" Chip | yes — Channel Mapping at 1003+, Band Configuration at 1070+ | no | no |
| Per-section save button INSIDE the settings panel | yes — Save Settings at 1121, Save Mapping at 1139 | no (auto-save via debounced state) | no (auto-save via debounced state) |
| "Lock" chip pattern in accordion summary | yes — `settingsFrozen && <Chip icon={<LockIcon/>} label="Locked" />` | no | no |
| Cross-section opt-ins (new in dev-mmui-6e97) | n/a | yes — Auto-chain after ESPRIT checkbox at 1425+ | n/a |

### 2.4 The aspect-by-aspect canonical table

| Aspect | Standard (Setup/Tracking/Apply) | Source |
|---|---|---|
| **Top-level layout** | Toolbar row → optional Alert banners (error, progress) → settings Collapse (`Paper`) → main content `Box` (flex: 1, overflow: auto) | `ModalAdapter.jsx:816-1666` |
| **Settings grouping** | Settings live INSIDE a top-of-pane `<Collapse>` toggled by the gear; rich sections (Setup) use nested `<Accordion>` panels for sub-grouping | `ModalAdapter.jsx:935-1273` |
| **Save/apply behavior** | Mixed: most fields auto-save via debounced setters in `useModalAdapter` (e.g. `setTrackingParams`, `setEspritConfig`); explicit Save Settings / Save Mapping buttons exist for Setup only, gated by an `*Dirty` flag | `ModalAdapter.jsx:1121` (espritConfigDirty), `:1139` (mappingDirty) |
| **Settings hook pattern** | All settings state lives in **`useModalAdapter`** — one big hook shared across the whole pane. Section-level state (e.g. `activeSection`, `showSettings`) is local `useState` in `ModalAdapter.jsx` | `ModalAdapter.jsx:70-260` |
| **Backend sync** | Auto-sync per debounced setter for `trackingParams` / `mergeMode` / `channelToSound`; explicit POST on Save Settings (ESPRIT config) / Save Mapping. ESPRIT run reloads project state | `useModalAdapter.js` |
| **Reset / revert** | None — there is no "Reset to defaults" button anywhere in the standard sections. Discard-changes is handled by chain editor only (`StabilizationToolbar`'s `onDiscard`) and only for chains, not for settings | n/a |
| **Setting types used** | `TextField type="number"`, `Switch`, `Select`, `ButtonGroup`, `Checkbox`, `RadioGroup`. Numerics via raw `TextField` (NOT `NumInput`). Inputs are MUI `size="small"` | `ModalAdapter.jsx:1153-1271` |
| **Validation** | Inline `helperText` on TextField (e.g. "sequential only" hint at 1187, 1198); no error variants; no form-level alerts; lock states use a `<Chip>` in the Accordion summary | `ModalAdapter.jsx:1186-1199` |
| **Section dividers** | Inside the Setup settings panel only — `<Accordion>` per sub-section (Channel Mapping, Band Configuration). Inside Tracking + Apply the settings panel is flat (no nested accordions) | `ModalAdapter.jsx:1003-1058`, `:1070-1134` |
| **Lock visualization** | `settingsFrozen` boolean from `useModalAdapter` (true post-ESPRIT) drives a `<Chip icon={<LockIcon/>} label="Locked" />` in the Setup accordion summary AND a `disabled` prop on the inner `<MappingEditor>` / `<EspritConfig>`. No banner; no opacity dimming (explicitly removed in dev-md04) | `ModalAdapter.jsx:1023-1031`, `:1090-1098` |
| **Gear button** | Portalled into the native `.mosaic-window-controls` title bar via `useLayoutEffect` + `ReactDOM.createPortal`; falls back to inline if there's no MosaicWindow ancestor | `ModalAdapter.jsx:114-127`, `:790-819` |

### 2.5 The canonical pattern, distilled

**Standard Settings Architecture** for a Modal Adapter section is:

1. **Toolbar contribution:** a gear icon in the native MosaicWindow title bar that toggles a single `showSettings` boolean. Optional: section-specific toolbar buttons (like the new Compute Modal Mass button) injected to the right of the section ButtonGroup.
2. **Top-of-pane settings panel:** a `<Collapse>` containing a `<Paper variant="outlined">` whose body is a flat `<Stack>` of form rows for simple sections, or a stack of `<Accordion>` panels (each with a Locked / Unsaved chip in its summary row) for rich sections.
3. **State source:** the parent's big shared hook (`useModalAdapter` for the standard; for Collection it would be the existing trio `useMeasurementCatalog` + `useMeasurementSetup` + `useSetupTest`). Section-level UI state (which Accordion is open, dirty flags, dialog open booleans) lives in local `useState` on the *section's* React component.
4. **Save behavior:** prefer debounced auto-save for low-stakes fields; reserve explicit "Save" buttons for high-stakes or schema-validated settings that the user wants to confirm intent on. Dirty flag → button variant flips from `outlined` to `contained` + an asterisk in the label.
5. **Lock visualization:** Chip in the Accordion summary + `disabled` prop on inner editors. No banner, no opacity dimming.
6. **Main content body:** a `<Box sx={{ flex: 1, overflow: "auto", p: 1 }}>` below the (collapsed-by-default) settings panel; this is where the per-section workflow content goes (project info card, stabilization diagram, export panels, …).

That is "the standard". The Collection subpanel does not follow it.

---

## 3. Current State of the Collection Subpanel

`CollectionSubpanel.jsx` (584 LOC) renders all 7 of its concerns inline in a single vertically-scrolling Box, with **no toolbar, no gear, no settings panel**. The render tree, top to bottom:

```
<Box overflow="auto" data-testid="collection-subpanel">
  ├── Top row (Stack direction="row")
  │     ├── <MeasurementSelector>          (catalog dropdown + Create / Import / Manage / Add / + New Project buttons)
  │     └── (when locked) "Acquisition locked" chip + "Unlock with warning" button
  ├── (error alerts from catalog/setup hooks)
  ├── (when no measurement) "Select or create..." placeholder Paper
  └── (when measurement selected) Stack spacing=1.5
        ├── <SetupTestBanner>              (surface #3 of the Setup Test framework)
        ├── <GeneralSection>               (Accordion - Layout, Channel Mapping, Grid)
        ├── <AudioDevicesSection>          (Accordion - input/output devices, multichannel)
        ├── <ImpulseSection>               (Accordion - waveform params + ImpulseShapeChart preview)
        ├── <SeriesSection>                (Accordion - pulses, cycles, derived rates)
        ├── <CalibrationCriteriaSection>   (Accordion - editable rules table, lock-exempt)
        ├── <Divider>
        ├── Start Collection / Cancel Collection button row
        └── <CollectionLog>                (polled message ring buffer)

  (Dialogs mounted at the bottom — modal overlays)
  ├── <UnlockMeasurementDialog>
  ├── <ImportScenariosDialog targetMode="new">
  ├── <CreateProjectFromMeasurementDialog>
  ├── <MeasurementsManagementDialog>
  └── <ImportScenariosDialog targetMode="existing">     (Add Scenarios variant)
```

### 3.1 Settings inventory (what's in the Collection subpanel today)

| Category | What's there | Where (file:line) |
|---|---|---|
| **Measurement choice** | MeasurementSelector dropdown + new/import/manage/add/+newproject buttons | `CollectionSubpanel.jsx:291-318` |
| **Lock control** | Acquisition-locked chip + "Unlock with warning" button | `:322-343` |
| **Setup readiness** | SetupTestBanner (surface #3 — the headline pre-flight check) | `:371-375` |
| **Layout + Mapping** | GeneralSection accordion (layout radio + MappingEditor + GridLayoutEditor + per-section Save Settings button) | `collection/GeneralSection.jsx:225-238` |
| **Audio devices** | AudioDevicesSection accordion (Select dropdowns + multichannel_config form + SetupTestPanel surface #1) | `collection/AudioDevicesSection.jsx:1-455` |
| **Impulse waveform** | ImpulseSection accordion (impulse_form Select + numeric fields + SetupTestPanel surface #2 + ImpulseShapeChart preview) | `collection/ImpulseSection.jsx:1-342` |
| **Series / Cycles** | SeriesSection accordion (numeric inputs + derived display) | `collection/SeriesSection.jsx:1-290` |
| **Calibration criteria** | CalibrationCriteriaSection accordion (editable rule table with Add/Delete row + Reset to defaults) — **lock-exempt** per N4 | `collection/CalibrationCriteriaSection.jsx:1-341` |
| **Acquisition action** | Start Collection / Cancel Collection button + activePhase chip | `CollectionSubpanel.jsx:422-457` |
| **Streaming log** | CollectionLog (polled at 1 Hz) | `:466-470` |

### 3.2 Buttons / actions present

| Button / Action | Location | Triggers |
|---|---|---|
| Create Measurement | MeasurementSelector header | `catalog.createMeasurement` |
| Refresh catalog | MeasurementSelector header | `catalog.refresh` |
| Import (new) | MeasurementSelector header | opens `ImportScenariosDialog targetMode="new"` |
| Manage… | MeasurementSelector header | opens `MeasurementsManagementDialog` |
| Add Scenarios | MeasurementSelector header | opens `ImportScenariosDialog targetMode="existing"` |
| + New Project from this Measurement | MeasurementSelector header | opens `CreateProjectFromMeasurementDialog` |
| Unlock with warning | top row, right side | opens `UnlockMeasurementDialog` |
| Save Settings (per accordion, ×5) | inside each accordion's body | calls the matching `useMeasurementSetup.save<Section>` helper |
| Reset to defaults | inside CalibrationCriteriaSection | reverts staged rules to DEFAULT_CRITERIA |
| Add / Delete row | inside CalibrationCriteriaSection | local table editing |
| Setup Test (×3 surfaces) | banner #3 + inline #1 (Audio) + inline #2 (Impulse) | calls `useSetupTest.run` |
| Start Collection | bottom of section stack | `POST /modal/measurements/<id>/collect/start` |
| Cancel Collection | bottom of section stack (replaces Start) | `POST /modal/measurements/<id>/collect/cancel` |

### 3.3 Dialogs opened from Collection

5 distinct dialogs, all mounted at the bottom of `CollectionSubpanel.jsx` and toggled by local `useState` open-state booleans:

| Dialog | Open-state hook | Mount location | Notes |
|---|---|---|---|
| `UnlockMeasurementDialog` | `unlockDialogOpen` | `:474-484` | only relevant when isLocked |
| `ImportScenariosDialog targetMode="new"` | `importDialogOpen` | `:492-499` | replaces legacy MeasurementImportDialog |
| `CreateProjectFromMeasurementDialog` | `newProjectDialogOpen` | `:506-518` | gated on `createProjectFromMeasurement` prop being supplied |
| `MeasurementsManagementDialog` | `manageDialogOpen` | `:527-555` | the `feature/dev-msdel-3b1a` branch fixed a 5 s axios timeout in the catalog hook this dialog uses |
| `ImportScenariosDialog targetMode="existing"` | `addScenariosTarget` (id-or-null) | `:569-581` | the same component as the "new" mount, reused with a different targetMode prop. The `feature/dev-cptmto-9d7e` branch bumped the polling timeout in `CreateProjectFromMeasurementDialog` (sibling dialog), not this one — but both share the same async-import polling backstop. |

### 3.4 Internal state in `CollectionSubpanel.jsx`

8 local `useState` calls + 3 hook instances:

```
const catalog = useMeasurementCatalog(url);                       // sole writer of the measurement list
const setup = useMeasurementSetup(url, selectedMeasurementId);    // sole writer of the manifest
const setupTest = useSetupTest(url, selectedMeasurementId);       // sole writer of the test report

const [localSelectedId, setLocalSelectedId] = useState(null);     // when uncontrolled
const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
const [isUnlocking, setIsUnlocking] = useState(false);
const [unlockError, setUnlockError] = useState(null);
const [importDialogOpen, setImportDialogOpen] = useState(false);
const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
const [manageDialogOpen, setManageDialogOpen] = useState(false);
const [addScenariosTarget, setAddScenariosTarget] = useState(null);
const [collectError, setCollectError] = useState(null);
const [collectStarting, setCollectStarting] = useState(false);
const [activePhase, setActivePhase] = useState("idle");
const [activeSessionId, setActiveSessionId] = useState(null);
```

Plus a 1 Hz `setInterval` polling `GET /collect/status` at `:174-201` — note this duplicates polling logic that `<CollectionLog>` already does for the message ring-buffer.

### 3.5 Internal layout structure: friction points

1. **No separation of "configure" from "acquire".** A user about to start an acquisition has to scroll past 5 settings accordions to reach Start Collection. On a typical 1080p display in a small mosaic pane, Start Collection is below the fold.

2. **No top-level dirty indicator.** Each section's "Unsaved" chip lives only in its own Accordion summary. If 3 sections are dirty, the user has to expand each one to find them. There's no aggregate "you have unsaved settings" affordance.

3. **No "Save All" affordance.** Each section has its own Save Settings button. Users who edit 3 sections must remember to click 3 Save buttons before locking acquisition.

4. **No gear icon at the top.** Setup/Tracking/Apply users learn the gear pattern; Collect users see no gear and intuit no settings layer above the accordions. The accordion *is* the settings layer here — a different idiom entirely.

5. **6 buttons in the MeasurementSelector header.** The selector grew from "select a measurement" to a hub with Create / Refresh / Import / Manage / Add Scenarios / + New Project. There is no visual hierarchy among them; all 6 are inline.

6. **Mounted dialogs.** All 5 dialogs are always mounted in the render tree (gated only by their `open` props). This is normal MUI practice but pairs awkwardly with point 5 — if a `/dev` agent splits the header into a toolbar, dialog mount-points naturally migrate with their trigger buttons.

7. **Setup Test redundancy.** Setup Test surfaces #1 and #2 live INSIDE the AudioDevicesSection and ImpulseSection accordions; surface #3 is the headline banner at the top of the body. All 3 surfaces share the same `useSetupTest` instance (good), but their layout means the user can run the test from 3 places and only one is visible at any given scroll position.

8. **Polling duplication.** The 1 Hz `setInterval` at `:174-201` polls `collect/status` purely to drive the Start/Cancel button label and the activePhase chip. `<CollectionLog>` polls the same endpoint at the same rate for its own purposes (`collection/CollectionLog.jsx:1-358`). Two timers, same endpoint — minor backend load issue + state-sync risk.

---

## 4. Gap Analysis — Collection vs the Standard

| Aspect | Standard | Collection today | Gap severity |
|---|---|---|---|
| Toolbar with gear | yes (shared with Setup/Tracking/Apply) | no — Collect skips the gear by `PIPELINE_RUN_SECTIONS` gate | **High** — biggest discoverability gap |
| Top-of-pane settings Collapse | yes — single Paper + flat/Accordion body | no — settings live inline in the main body | **High** |
| Per-section state hook | one big `useModalAdapter` | three hooks (`useMeasurementCatalog`/`useMeasurementSetup`/`useSetupTest`) — already good and section-appropriate | None — different but defensibly different (Collection's hooks are scoped to one Measurement and one acquisition; merging them into useModalAdapter would be wrong) |
| Run button(s) in toolbar | Play (run section) + SkipNext (run pipeline to end), gated by `PIPELINE_RUN_SECTIONS` | n/a — Collect doesn't run the analysis pipeline, it acquires data. But there IS an equivalent concept: Start Collection | **Medium** — Start Collection deserves the same toolbar slot |
| Cancel button when running | StopIcon at `:881` | StopIcon inline at `:441` (bottom of body) | **Medium** — same widget, wrong location |
| Status chip in toolbar | "On" / "Off" server-status chip at `:829` | none in Collect (the SetupTestBanner is the closest equivalent but it's body-positioned) | **Medium** |
| Save Settings buttons | Setup has 2 (Save Settings / Save Mapping), inside the settings panel | 5 — one per Accordion section, all in the main body | **Medium** — current model is OK but lacks aggregate signal |
| Lock chip | inside Accordion summary | inside Accordion summary | None — Collection follows the standard here |
| Per-section "Unsaved" chip | not applied in Standard (Setup uses an asterisk on the Save button instead) | yes — every section has its own Unsaved chip | **Low** — Collection is actually *better* on this front; the standard could adopt Collection's chip |
| Inline error Alert | used in Setup/Tracking/Apply settings panel via `<Alert onClose={...}>` | used in each section + globally at top of body | None |
| Dialog mounting | dialogs mount at the section root | dialogs mount at the section root | None |
| Test surface | SetupTest run from a banner | SetupTest run from a banner + 2 inline panels | **Low** — the redundancy is real but historical (the 3 surfaces were a deliberate design in §4.1) |

**Summary:** the Collection subpanel has the right *content*, but the *shell* (toolbar, gear, settings Collapse, top status chip) is missing. The reorg is a shell migration, not a content rewrite.

---

## 5. Proposed Reorganization

### 5.1 Goal

Move the 5 configuration accordions (General, AudioDevices, Impulse, Series, CalibrationCriteria) out of the always-visible main body and into the **gear-toggled settings Collapse** at the top of the pane, matching the Setup/Tracking/Apply pattern. Keep the acquisition-time workflow (SetupTestBanner, Start/Cancel Collection, CollectionLog) visible in the main body without scrolling.

### 5.2 Before / After ASCII layouts

#### Before (current Collect)

```
+- ModalAdapter pane -----------------------------------------+
| [On][Off]  [Collect][Setup][Tracking][Apply]                | <- shared toolbar
|                                                             |   (Collect skips the gear and play buttons)
+- Collection subpanel body ----------------------------------+
| [Selector] [+Create] [Import] [Manage] [Add] [+NewProject]  |   measurement selector header
| [Locked-chip] [Unlock with warning]                         |
|                                                             |
| ::SetupTestBanner:: PASS                                    |   surface #3
|                                                             |
| > General                       [Locked] [Unsaved]          |   <- accordion 1
|   ... Layout / MappingEditor / Grid / Save Settings         |
|                                                             |
| > Audio Devices                 [Locked]                    |   <- accordion 2
|                                                             |
| > Impulse                       [Locked]                    |   <- accordion 3
|                                                             |
| > Series                        [Locked]                    |   <- accordion 4
|                                                             |
| > Calibration Criteria                                      |   <- accordion 5 (lock-exempt)
|                                                             |
| ---                                                         |
|              [ ▶  Start Collection  ]                       |   <- the actual headline action,
|                                                             |      below 5 accordion folds
| ::CollectionLog::                                           |
|   [log lines streaming...]                                  |
+-------------------------------------------------------------+
```

#### After (proposed Collect)

```
+- ModalAdapter pane -----------------------------------------+
| [On][Off]  [Collect][Setup][Tracking][Apply]                | <- shared toolbar
|                                          [▶ Start] [⏹]  [⚙] |   <- gear NOW also for Collect
|                                                             |      Start moves into the toolbar
+- Collapsible settings panel (showSettings=false by default)-+
| (hidden when gear is off)                                   |
| > General                       [Locked] [Unsaved]          |
| > Audio Devices                 [Locked]                    |
| > Impulse                       [Locked]                    |
| > Series                        [Locked]                    |
| > Calibration Criteria                                      |
|             [ Save All Settings  ]  (when any dirty)        |   <- aggregate Save All
+- Collection subpanel main body -----------------------------+
| [Selector] [+Create] [Import] [Manage] [Add] [+NewProject]  |   measurement selector header
| [Locked-chip] [Unlock with warning]                         |
|                                                             |
| ::SetupTestBanner:: PASS                                    |   surface #3, now at the top of body
|                                                             |
| [activePhase=recording]   ::progress timeline::             |   acquisition status moved up
|                                                             |
| ::CollectionLog::                                           |
|   [log lines streaming...]                                  |
+-------------------------------------------------------------+
```

The "after" layout buys two screen-fulls of vertical space for the headline workflow (select → setup-test → start → watch log), and demotes 5 rarely-edited configuration accordions into the gear-toggled Collapse. This matches the Setup/Tracking/Apply mental model exactly.

### 5.3 Concrete reorg moves

| # | Move | From | To | Evidence |
|---|---|---|---|---|
| M1 | Add Collect to `PIPELINE_RUN_SECTIONS`-equivalent for the gear gate, OR introduce a new gate `SECTIONS_WITH_SETTINGS = [...PIPELINE_RUN_SECTIONS, "collect"]` and switch the `settingsButton` + `<Collapse>` to use it | `ModalAdapter.jsx:800`, `:935` | same lines, gated by the wider set | line 800 `settingsButton`, line 935 `<Collapse in={showSettings && PIPELINE_RUN_SECTIONS.includes(activeSection)}>` |
| M2 | Add a `{activeSection === "collect" && (...)}` block inside the `<Collapse>`'s `<Paper>` rendering an inline `<CollectionSettingsPanel>` extracted from CollectionSubpanel | `ModalAdapter.jsx:1240-1271` (right before Apply block) | new block above the Apply block | requires new component `CollectionSettingsPanel.jsx` |
| M3 | Extract the 5 Accordion mounts (`<GeneralSection>` etc.) and the per-section save handlers into a new `panels/collection/CollectionSettingsPanel.jsx` (~80 LOC) | `CollectionSubpanel.jsx:378-413` | new file | the 5 sections + the 5 `handleSave*` callbacks |
| M4 | Wire the gear gate to also accept Collect: change `PIPELINE_RUN_SECTIONS` to add `"collect"`, OR (cleaner) introduce `SECTIONS_WITH_SETTINGS` separate from `PIPELINE_RUN_SECTIONS` since Collect has settings but no run-pipeline semantics | `ModalAdapter.jsx:65, 800, 877, 935` | same lines | line 65 const, line 877 gates the play buttons (Collect should NOT inherit those — keep the play-button gate on `PIPELINE_RUN_SECTIONS`) |
| M5 | Move Start Collection / Cancel Collection from the bottom of the body into the shared toolbar via a section-specific toolbar contribution (mirroring how dev-mmui-6e97 added the Compute Modal Mass button at line 991) | `CollectionSubpanel.jsx:422-457` | `ModalAdapter.jsx` ~ line 991 (with an `activeSection === "collect"` gate) | precedent: the dev-mmui-6e97 `<Tooltip><Button>` block at line 991 |
| M6 | Add a Server-status-style chip for Collect's `activePhase` (idle / recording / saving / complete / error / cancelled), positioned in the toolbar near the play button, so the user gets at-a-glance status without scrolling to the body | `CollectionSubpanel.jsx:447-456` (the existing activePhase Chip) | new toolbar position via the same per-section gate as M5 | the existing Chip block at `:447-456` |
| M7 | Replace the inline 1 Hz `useEffect` poll in CollectionSubpanel with a custom hook `useCollectionStatus(url, measurementId)` that returns `{activePhase, activeSessionId}`. Reuse this hook from BOTH the new toolbar status chip AND the existing Start/Cancel button. (Removes duplication noted in §3.5 #8.) | `CollectionSubpanel.jsx:174-201` | new hook `hooks/useCollectionStatus.js` | the existing 28-line useEffect block |
| M8 | Add an aggregate "Save All Settings" button at the bottom of the new settings Collapse, enabled when ANY of the 5 sections is dirty. (New affordance — matches the "click gear, save all settings, close" mental model.) | new | inside `CollectionSettingsPanel.jsx` | requires lifting per-section dirty flags up via callbacks or via a parent-owned dirty registry. Smallest path: each section exposes `onDirtyChange(boolean)` like a controlled-input pattern. Alternative: keep the per-section Save buttons AND add an outer Save All — additive, lowest risk |
| M9 | Move the per-section "Unsaved" chip up to the gear button as a small dot or count badge (e.g. MUI `Badge`), so the user sees "3 unsaved settings" without expanding the gear | new | gear `<IconButton>` at `ModalAdapter.jsx:805` wrapped in `<Badge badgeContent={dirtyCount}>` | adds `dirtyCount` derivation alongside M8 |
| M10 | (Optional, low priority) Consolidate the 6-button MeasurementSelector header into a `<ButtonGroup>` + an overflow `<Menu>` for less-frequent actions (Import / Manage / Add Scenarios). The +New Project and +Create stay primary | `CollectionSubpanel.jsx:291-318` | same render block; refactor MeasurementSelector internally | scope creep — defer to a follow-up |

### 5.4 Code-extraction opportunities

The reorg naturally pulls out three sub-components from CollectionSubpanel.jsx:

| New file | Responsibility | Approx LOC | Lifted from |
|---|---|---|---|
| `panels/collection/CollectionSettingsPanel.jsx` | Renders the 5 Accordions inside the gear-toggled Collapse; owns the per-section Save handlers; computes `dirtyCount` for the Badge | ~80 LOC | `CollectionSubpanel.jsx:378-413` |
| `hooks/useCollectionStatus.js` | Polls `GET /collect/status` at 1 Hz; returns `{activePhase, activeSessionId, isInFlight}`. Replaces the inline `useEffect` at `CollectionSubpanel.jsx:174-201` AND the parallel polling in `CollectionLog.jsx` (CollectionLog also gets refactored to consume this hook) | ~50 LOC + minor CollectionLog edit | `CollectionSubpanel.jsx:174-201` + the equivalent block in `CollectionLog.jsx` |
| `panels/collection/CollectionToolbarActions.jsx` (or inline in ModalAdapter.jsx like Compute Modal Mass) | The Start/Cancel button + activePhase chip — rendered into the shared toolbar via the same per-section-conditional approach as Compute Modal Mass | ~40 LOC | `CollectionSubpanel.jsx:422-457` |

After the reorg `CollectionSubpanel.jsx` shrinks from 584 LOC to ~350 LOC and becomes:

```
<Box main body of Collect>
  ├── MeasurementSelector header (unchanged)
  ├── Error alerts (unchanged)
  ├── (when no measurement) placeholder Paper (unchanged)
  └── (when measurement selected)
        ├── SetupTestBanner (unchanged, moved up since accordions are gone)
        ├── CollectionLog (unchanged)
        └── (the 5 accordions + Start button + activePhase chip — GONE, moved to settings panel + toolbar)

  ├── 5 dialog mounts (unchanged)
```

The 5 sub-section files (`GeneralSection.jsx`, `AudioDevicesSection.jsx`, `ImpulseSection.jsx`, `SeriesSection.jsx`, `CalibrationCriteriaSection.jsx`) DO NOT change. They are imported by `CollectionSettingsPanel.jsx` instead of by `CollectionSubpanel.jsx`. Their per-section save model also does not change (M8 adds an outer Save All, but the inner buttons stay — they're useful when the user wants to save just one section after a single edit).

---

## 6. Migration Plan for the `/dev` Agent

Sequenced so each step is independently verifiable; each step ends at a passing-tests checkpoint.

### Step 1 — Add `SECTIONS_WITH_SETTINGS` gate (1 commit, ~20 LOC)

- `ModalAdapter.jsx`: introduce `const SECTIONS_WITH_SETTINGS = [...PIPELINE_RUN_SECTIONS, "collect"]` next to the existing const at line 65.
- Replace the gear gate at line 800 from `PIPELINE_RUN_SECTIONS.includes(activeSection)` to `SECTIONS_WITH_SETTINGS.includes(activeSection)`.
- Replace the `<Collapse>` gate at line 935 the same way.
- Leave the play-button gate at line 877 on `PIPELINE_RUN_SECTIONS` (Collect should not get Run-Section / Run-Pipeline play buttons).
- Add a temporary `{activeSection === "collect" && (<Typography>placeholder</Typography>)}` block inside the `<Paper>` so the gear renders something for Collect (one-line stub).
- **Verify:** existing 730 Jest tests still pass (the gate widening is additive; no existing assertions should break). Visually verify gear icon now appears for Collect.

### Step 2 — Extract `CollectionSettingsPanel.jsx` (1 commit, ~100 LOC NEW + ~40 LOC removed from CollectionSubpanel)

- Create `panels/collection/CollectionSettingsPanel.jsx`. Move the 5 `<Section>` mounts and the per-section `handleSave*` callbacks. Props: `manifest`, `isLocked`, `savingSection`, the 5 `handleSave*`, `url`, `measurementId`, `setupTest`.
- Replace the in-body Stack of accordions in `CollectionSubpanel.jsx:378-413` with a new prop `onSettingsDirtyChange` (returns nothing for now — implementation in Step 4).
- Mount `<CollectionSettingsPanel>` inside the `<Paper>` placeholder from Step 1.
- **Verify:** `CollectionSubpanel.test.jsx` should still pass (it asserts "renders the 5 sections" but doesn't assert WHERE they render — depending on how the test queries the DOM, may need to wrap render with a parent that provides showSettings=true). If the test breaks, update it to mount the settings panel.

### Step 3 — Move Start/Cancel into the toolbar (1 commit, ~50 LOC)

- Extract Start/Cancel button + activePhase chip from `CollectionSubpanel.jsx:422-457`.
- Add an `{activeSection === "collect" && (<Tooltip><Button>...</Button></Tooltip>)}` block in `ModalAdapter.jsx` mirroring the dev-mmui-6e97 Compute Modal Mass pattern at line 991+.
- The button state (`isCollectInFlight`, `activePhase`, etc.) must move up to ModalAdapter — easiest via the new `useCollectionStatus` hook from Step 4.
- **Verify:** CollectionSubpanel.test.jsx assertion on the Start Collection button needs an update (the button now renders in the toolbar, not the body).

### Step 4 — Introduce `useCollectionStatus` (1 commit, ~50 LOC NEW + ~30 LOC removed)

- New file `hooks/useCollectionStatus.js`. Returns `{activePhase, activeSessionId, isInFlight, startCollection, cancelCollection}`. Internalize the existing 1 Hz poll + the start/cancel POSTs.
- Replace the inline `useEffect` + handlers in `CollectionSubpanel.jsx:174-240`.
- Replace the equivalent polling in `CollectionLog.jsx` (point it at the same shared hook instance — pass `activePhase` down as a prop instead of polling).
- **Verify:** new Jest test `useCollectionStatus.test.jsx` (mock axios). Existing `CollectionLog.test.jsx` should pass with updates for the prop-based phase.

### Step 5 — Aggregate Save All + Badge counter (1 commit, ~80 LOC)

- Lift per-section `dirty` flags up via a `(sectionKey, dirty) => void` callback prop on each Section. Aggregate in `CollectionSettingsPanel.jsx`.
- Add a `<Button variant="contained">Save All Settings</Button>` at the bottom of the settings Paper, enabled when any section is dirty. On click, iterate the dirty sections and call their save handlers in sequence (or in parallel — they target different endpoints so parallel is safe). Show a `<LinearProgress>` during the multi-save.
- Lift the dirty count to ModalAdapter (via a `onDirtyCountChange` callback prop on CollectionSubpanel → CollectionSettingsPanel).
- Wrap the gear `<IconButton>` in `<Badge badgeContent={dirtyCount} color="warning">`.
- **Verify:** new Jest test `CollectionSettingsPanel.test.jsx` asserts Save All flow.

### Step 6 — Remove the placeholder, tidy up (1 commit, ~30 LOC removed)

- Remove the stub Typography from Step 1.
- Remove any dead imports from `CollectionSubpanel.jsx` (the 5 Section imports stay only if a re-export wrapper is wanted; otherwise drop them).
- Run the full PianoidTunner test suite (`npm test`).
- **Verify:** all green; CollectionSubpanel.jsx is ~350 LOC.

### Total effort estimate

| Phase | LOC delta | Test edits | Risk |
|---|---|---|---|
| Step 1 — gate widening | +20 | 0 | Low |
| Step 2 — extract CollectionSettingsPanel | +100/-40 | 1 file | Low |
| Step 3 — toolbar Start/Cancel | +50/-30 | 1 file | Medium (toolbar prop drilling) |
| Step 4 — useCollectionStatus | +50/-30 | 1 NEW + 1 update | Low |
| Step 5 — Save All + Badge | +80 | 1 NEW | Medium (dirty-flag aggregation) |
| Step 6 — cleanup | -30 | 0 | Low |
| **Total** | **+300 / -130 net +170 LOC** | **2 new test files + 3 updates** | Medium overall |

**Estimated `/dev` work:** ~6-8 hours including baseline test runs, manual UI verification per Step, and the wrap-up `/test-ui` pass.

---

## 7. Risk and Rollback

### Tests at risk

| Test | Risk | Mitigation |
|---|---|---|
| `src/components/__tests__/CollectionSubpanel.test.jsx` (191 LOC, 5-section assertion) | Sections will no longer render in the same DOM location. Queries via `getByText("General")` etc. still work but absolute assertions about render order will break. | Update queries to render with `showSettings=true` via a parent that provides the gear state. Alternative: render the new `CollectionSettingsPanel` directly in the test. |
| `src/modules/panels/collection/__tests__/SeriesSection.test.jsx` and friends (5 per-section tests) | None — the section components themselves don't change. | n/a |
| `src/modules/__tests__/ModalAdapter.lockSettings.test.jsx` | Asserts the gear lock behaviour. Widening the gate adds a Collect case; may need a new "Collect also has a gear" assertion. | Add a Collect-section assertion to the existing test file. |
| Any test that queries the Start Collection button via `screen.getByText("Start Collection")` | After Step 3 the button lives in the toolbar, not the body. The query still works, but DOM containment assertions (`within(panelBody).getByText(...)`) will fail. | Update queries to scope to the new toolbar location. |

### User-workflow risks

| Risk | Severity | Mitigation |
|---|---|---|
| User loses the 5 accordions on first run (they were visible by default, now hidden behind the gear) | **High** — disorientation | Default `showSettings=true` for the Collect section on first mount; persist preference in localStorage so the user can collapse it. Alternative: a one-time tooltip on the gear ("Settings moved here") that auto-dismisses. |
| Long acquisitions: if the user's gear was open, the settings Collapse pushes the SetupTestBanner + CollectionLog further down | Low | Default collapsed; warn via tooltip if the user opens the gear during an active acquisition. |
| Save All semantics differ from per-section Save (sequence of PATCHes vs single PATCH) | Medium — partial-failure UX | Use Promise.allSettled; on partial failure, surface a per-section error list in an Alert; keep dirty flags on the sections that failed so the user can retry. |

### Branch-coordination risks (in-flight branches)

| Branch | Risk to this reorg | Resolution |
|---|---|---|
| `feature/dev-mmui-6e97` (Tracking Compute Modal Mass + Auto-chain) | None — that branch adds to the Tracking section's settings + a Tracking-specific toolbar button. The two reorgs don't touch the same lines. Steps 1 and 3 of this proposal *follow* the dev-mmui-6e97 toolbar-button precedent, so they're cleaner if dev-mmui-6e97 is merged first. | Merge dev-mmui-6e97 BEFORE starting this reorg, or rebase this reorg on dev-mmui-6e97. |
| `feature/dev-msdel-3b1a` (axios timeout in useMeasurementCatalog) | None — touches `useMeasurementCatalog.js` only, no UI structure change. | Safe to merge in any order. |
| `feature/dev-cptmto-9d7e` (CreateProjectFromMeasurementDialog timeout) | None — touches the dialog content, not its mount point. | Safe to merge in any order. |

### Rollback strategy

Each step is a single commit. The reorg is reversible by reverting the commits in reverse order. Step 1 (gate widening) is the only commit that touches code paths shared with Setup/Tracking/Apply — reverting it restores the Collect-skip behaviour exactly. All other steps add new files or rearrange Collect-only code.

If user testing of Steps 1-2 reveals discoverability problems with the gear, the rollback is simply "revert Steps 1-2 and keep the in-body accordion layout".

---

## 8. Out of Scope

The following improvements were noted during the inventory but do NOT belong in this reorg:

| Item | Why out of scope | Where it should go |
|---|---|---|
| Dialog content overhaul / consolidation | The sibling proposal `modal-adapter-dialog-review-2026-05-26.md` (parallel agent `ana-madlg-7c2e`) covers this. This reorg only touches dialog *mount points* (and even those only incidentally — they migrate with their trigger buttons in M3 above). | sibling proposal |
| MeasurementSelector header simplification (the 6-button row) | Tactically real but introduces a new ButtonGroup/Menu pattern that the rest of the pane doesn't use. Worth a separate UX pass with a frontend designer in the loop. | follow-up issue |
| Setup Test multi-surface consolidation | The 3-surface design was a deliberate decision in the §4.1 measurement-entity proposal (surface #1 for audio devices, #2 for impulse, #3 for the headline summary). Removing surfaces requires re-litigating §4.1, which is out of scope. | follow-up if the surfaces actually confuse users in practice |
| Unification of `useMeasurementSetup` save model with `useModalAdapter` save model | Different domains (per-Measurement vs per-Project); merging them would couple the hooks unnecessarily. The hook split is correct as-is. | n/a |
| Telegram-friendly screenshots / animated GIFs in this proposal | This is a `/analyse` doc-only output; image attachments belong with the `/dev` PR. | `/dev` agent's wrap-up |
| Replacing the inline 1 Hz `setInterval` with WebSocket push for activePhase | The polling works and is bounded (3 s timeout, 1 s interval, scoped to the open Measurement). A WebSocket migration is a backend change touching `modal_adapter.py`, which is mid-split. | post-`modal-adapter-split-2026-05-21.md` Wave 2 |
| Migrating `TextField type="number"` → `NumInput` in the inline Tracking/Apply settings | The standard sections use raw TextField; standardizing on NumInput requires a sweep across the whole pane and an MUI v6 audit. | separate /dev session, possibly as part of the dialog review |
| Adding a "Reset to defaults" button at the Collect-settings level | Calibration criteria already has one; the other 4 sections don't because their defaults are domain-specific (audio device IDs come from SDL enumeration, not a static default). A pane-level Reset is not meaningful here. | n/a |

---

## 9. Appendix: file:line Evidence Index

Every `file:line` claim in this proposal points at the `master` branch HEAD of `D:\repos\PianoidInstall` and the corresponding commits in PianoidTunner. Line numbers reference the current state of PianoidTunner `dev` (29c1e41), with notes where `feature/dev-mmui-6e97` would shift lines.

### Standard sections (ModalAdapter.jsx, all on `dev`)

- `ModalAdapter.jsx:65` — `PIPELINE_SECTIONS = ["collect", "setup", "tracking", "modal_mass", "apply"]` (post-mmui-6e97: `modal_mass` is removed)
- `ModalAdapter.jsx:75` — `[activeSection, setActiveSection] = useState("setup")`
- `ModalAdapter.jsx:78` — `[showSettings, setShowSettings] = useState(false)`
- `ModalAdapter.jsx:114-127` — `useLayoutEffect` that resolves `.mosaic-window-controls` and the toolbarHost portal target
- `ModalAdapter.jsx:768-779` — `runCurrentStep` + `canRunCurrentStep` (the per-section run handler dispatch)
- `ModalAdapter.jsx:800-814` — `settingsButton` (the gear IconButton)
- `ModalAdapter.jsx:819` — `ReactDOM.createPortal(settingsButton, toolbarHost)` (the title-bar mount)
- `ModalAdapter.jsx:821-917` — the shared toolbar Stack
- `ModalAdapter.jsx:842-868` — the section ButtonGroup
- `ModalAdapter.jsx:877-916` — the play / skip / cancel buttons (gated by `PIPELINE_RUN_SECTIONS`)
- `ModalAdapter.jsx:935-1273` — the settings Collapse > Paper container
- `ModalAdapter.jsx:940-1152` — Setup settings block (Layout + Channel Mapping accordion + Band Configuration accordion + Save Mapping)
- `ModalAdapter.jsx:1003-1058` — Channel Mapping accordion with `settingsFrozen` Locked Chip pattern
- `ModalAdapter.jsx:1070-1134` — Band Configuration accordion with Locked + QC-warning chips
- `ModalAdapter.jsx:1121-1131` — Save Settings button (ESPRIT config) with dirty-asterisk pattern
- `ModalAdapter.jsx:1139-1149` — Save Mapping button with dirty-asterisk pattern
- `ModalAdapter.jsx:1153-1239` — Tracking settings block (method Select + freq tol + max gap + per-stage MAC thresholds)
- `ModalAdapter.jsx:1240-1271` — Apply settings block (merge Switch + Sound Output Mapping)
- `ModalAdapter.jsx:1282-1306` — Collect body mount: `<CollectionSubpanel ...>`
- `ModalAdapter.jsx:1317-1370` — Setup body mount: `<ProjectSubpanel ...>`
- `ModalAdapter.jsx:1373-1461` — Tracking body (inline)
- `ModalAdapter.jsx:1473-1664` — Apply body (inline: Alert banners, summary Paper, Export-to-Text, Tracking Report PDF)

### feature/dev-mmui-6e97 additions (NOT yet merged to dev)

- ModalAdapter.jsx around line 991 — `<Tooltip><Button data-testid="compute-modal-mass-button">` (the Compute Modal Mass toolbar button, gated on `activeSection === "tracking"`)
- ModalAdapter.jsx around line 1425+ — `<FormControlLabel><Checkbox data-testid="auto-chain-esprit-checkbox">` (the Auto-chain checkbox, INSIDE the Tracking settings block)
- ModalAdapter.jsx around line 1295+ — banner-style progress Alert rendered above the settings Collapse during a modal-mass run

### CollectionSubpanel (current state, no in-flight changes)

- `panels/CollectionSubpanel.jsx:65-103` — props contract (controlled/uncontrolled selection, dialog wiring callbacks)
- `panels/CollectionSubpanel.jsx:104-120` — hook instances (`useMeasurementCatalog`, `useMeasurementSetup`, `useSetupTest`)
- `panels/CollectionSubpanel.jsx:122-142` — local dialog open-state booleans
- `panels/CollectionSubpanel.jsx:165-247` — collect lifecycle state + 1 Hz status polling + start/cancel handlers
- `panels/CollectionSubpanel.jsx:285-344` — top row: MeasurementSelector header + Lock chip + Unlock button
- `panels/CollectionSubpanel.jsx:347-358` — global error alert
- `panels/CollectionSubpanel.jsx:360-366` — "Select or create..." placeholder
- `panels/CollectionSubpanel.jsx:371-375` — SetupTestBanner (surface #3)
- `panels/CollectionSubpanel.jsx:378-413` — the 5 Accordion sections
- `panels/CollectionSubpanel.jsx:415-460` — Divider + Start/Cancel Collection button + collect-error Alert
- `panels/CollectionSubpanel.jsx:466-470` — CollectionLog
- `panels/CollectionSubpanel.jsx:474-484` — UnlockMeasurementDialog mount
- `panels/CollectionSubpanel.jsx:492-499` — ImportScenariosDialog (new) mount
- `panels/CollectionSubpanel.jsx:506-518` — CreateProjectFromMeasurementDialog mount
- `panels/CollectionSubpanel.jsx:527-555` — MeasurementsManagementDialog mount
- `panels/CollectionSubpanel.jsx:569-581` — ImportScenariosDialog (existing) mount

### Sub-section files (unchanged by this reorg)

- `panels/collection/GeneralSection.jsx:225-238` — per-section Save Settings button (with dirty-asterisk pattern echoed by the standard)
- `panels/collection/AudioDevicesSection.jsx:1-455` — Audio devices accordion (SDL3 enumeration, multichannel_config, Setup Test surface #1)
- `panels/collection/ImpulseSection.jsx:1-342` — Impulse accordion (waveform params + SetupTestPanel surface #2 + ImpulseShapeChart preview)
- `panels/collection/SeriesSection.jsx:1-290` — Series accordion (numeric inputs + derived display)
- `panels/collection/CalibrationCriteriaSection.jsx:1-341` — Calibration accordion (lock-exempt rule table editor)
- `panels/collection/CollectionLog.jsx:1-358` — polled message ring buffer (parallel to the 1 Hz status poll in CollectionSubpanel — both consume `collect/status`)

### Hooks

- `hooks/useMeasurementCatalog.js:1-338` — sole writer of the measurement list (delete timeout bumped to 60 s in `feature/dev-msdel-3b1a`)
- `hooks/useMeasurementSetup.js:1-219` — sole writer of the per-Measurement manifest + per-section PATCH helpers
- `hooks/useSetupTest.js:1-141` — sole writer of the Setup Test report (shared across the 3 surfaces in Collection)
- `hooks/useModalAdapter.js` (~big) — sole owner of the Project-side state (espritConfig, trackingParams, mergeMode, channelToSound, dataStatus, stages, etc.)

### Related proposals

- [docs/proposals/modal-adapter-measurement-entity-2026-05-10.md](http://localhost:8001/proposals/modal-adapter-measurement-entity-2026-05-10/) §4.1 — original Collection layout contract (the 5 sections); §4.2 — ProjectSubpanel slim-down (the precedent for extracting per-section files from ModalAdapter)
- [docs/proposals/modal-adapter-split-2026-05-21.md](http://localhost:8001/proposals/modal-adapter-split-2026-05-21/) — backend-side split, NOT directly impacted by this frontend reorg
- `docs/proposals/modal-adapter-dialog-review-2026-05-26.md` (sibling, parallel agent `ana-madlg-7c2e`, not yet committed at time of writing) — should be merged into the migration plan once available; this proposal explicitly defers dialog content concerns to it
