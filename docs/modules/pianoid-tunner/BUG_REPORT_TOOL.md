# PianoidTunner — In-App Diagnostic Bug-Report Tool

## What It Is and Why

The **diagnostic bug-report tool** is an always-on, in-app "Report a problem" facility in the
PianoidTunner frontend. When something goes wrong during live tuning, the user clicks a small
🐞 (bug) icon in the bottom bar, types one sentence describing what happened, and clicks
**Generate report**. The browser immediately downloads a single self-contained JSON file that
captures **everything a developer or agent needs to reproduce the exact state**: the active preset,
the full frontend configuration, the **live engine runtime parameters**, and an ordered ring buffer
of the user's **last 200 actions**.

Why it exists: Pianoid is a *live-tuning* application with hundreds of interacting parameters
(per-pitch string/mode/excitation curves, feed-in / feedback matrices, sound-channel routing,
volume/feedback sensitivity, selection state, mosaic layout). Many bugs — the recurring
"volume jumped after switching preset and playing C4" class — are **path-dependent**: they only
manifest after a specific ordered sequence of edits and plays against a specific preset. Asking the
user to narrate that sequence loses the fidelity needed to reproduce it. This tool captures the
sequence **for free, as it happens**, so a fix can be verified against the *exact reported state*
rather than a guess.

This page documents the tool as shipped on the PianoidTunner `dev` branch (`dev-6ef1`). The
**project-agnostic pattern** behind it — intended to be reused in future apps — is written up
separately in
[development/standards/DIAGNOSTIC_BUG_REPORT_TOOL.md](../../development/standards/DIAGNOSTIC_BUG_REPORT_TOOL.md).

---

## Architecture

The tool is four small, single-concern parts. Data flows one way: actions are recorded continuously
into a ring buffer; on demand a snapshot is assembled, packaged into a report, and downloaded.

```
 user actions (edits, plays, selections, preset loads, layout/settings changes)
        │
        ▼
 usePreset.writeParam (SSOT chokepoint)  ─┐
 PianoidTuner effects (selection/…)       ├─▶  actionRecorder.recordAction(type, detail)
                                          ─┘        │  module-level singleton ring buffer
                                                     │  (200-cap, re-render-FREE)
                                                     ▼
                                         [ t, type, …detail ] × ≤200  (oldest→newest)

 click 🐞  ──▶  BugReportDialog
                  │  buildSnapshot()  ──▶  PianoidTuner.buildBugSnapshot()  (sync FE config)
                  │  fetchRuntimeParameters()  ──▶  GET /get_runtime_parameters  (live engine truth)
                  │  getActionHistory()  ──▶  actionRecorder buffer copy
                  ▼
              bugReport.buildReport()  ──▶  self-contained JSON  (schemaVersion 1)
                  ▼
              downloadReport()  ──▶  pianoid-bug-report-<ISO>.json   (copy-to-clipboard fallback)
```

| Part | File | Concern |
|---|---|---|
| Ring buffer | `src/utils/actionRecorder.js` | Always-on, module-singleton, re-render-free capture of the last 200 actions. |
| Report builder | `src/utils/bugReport.js` | Assemble + serialize + download/copy; the live `GET /get_runtime_parameters` call. |
| Dialog | `src/components/BugReportDialog.jsx` | Collect the description, orchestrate generation, download/copy. |
| 🐞 button | `src/components/BottomBar.jsx` | Unobtrusive `onReportProblem` affordance at the far end of the bottom bar. |
| Snapshot builder + capture wiring | `src/PianoidTuner.js` | `buildBugSnapshot()` + the `selection` / `settings_change` / `layout_change` effects; owns the dialog. |

### The ring buffer (`actionRecorder.js`)

A **module-level singleton** — deliberately *not* React state. Recording an action must never trigger
a re-render, so the recorder is the sole owner of the buffer (`let _buffer = []`); UI components only
**read** it (`getActionHistory()`) at report-generation time. Each `recordAction(type, detail)` is a
cheap push plus a length trim — no allocation beyond the entry object, and it **never throws**
(a diagnostic tool must never break the app; the body is wrapped in a `try/catch` that swallows
everything).

Key properties:

- **Capacity 200** (`ACTION_HISTORY_CAPACITY`). When the buffer exceeds capacity it trims from the
  front (`_buffer.splice(0, len - CAPACITY)`), always keeping the **most recent** 200 entries,
  oldest→newest.
- **Session-relative time.** Every entry's `t` is `Math.round(performance.now())` — **milliseconds
  since app load** — so ordering never depends on the wall clock (which can jump or be adjusted).
  The wall-clock anchor (`APP_LOADED_AT`, an ISO-8601 string captured when the module loads) lives
  only once, in the report envelope.
- **Value summarization.** `summarizeValue(v)` keeps the buffer cheap and the report human-readable:
  strings over 120 chars are truncated with a `…(len)` marker; arrays over 8 elements collapse to
  `{ __array: N, head: [...8] }`; objects over 24 keys collapse to `{ __object: N, keys: [...24] }`;
  recursion stops at depth 3. Callers pre-summarize large payloads before recording. The tool records
  **what changed**, not necessarily every byte.
- **Entry shape:** `{ t, type, ...detail }`.

### The report builder (`bugReport.js`)

Single concern: turn `(description + configSnapshot + actionHistory)` into a self-contained,
human-readable JSON object and let the user download it. `buildReport()` is **pure** (no I/O) so it is
unit-testable; the dialog supplies the already-gathered snapshot. Supporting functions:
`fetchRuntimeParameters()` (the read-only `GET /get_runtime_parameters`), `getEnv()`/`getBuildInfo()`
(browser + build metadata, all guarded so they work under jsdom/node too), `serializeReport()`
(2-space pretty-print), `reportFileName()` (filesystem-safe timestamped name), `downloadReport()`
(Blob → object URL → synthetic `<a download>` click), and `copyReportToClipboard()` (fallback).

### The dialog (`BugReportDialog.jsx`)

Owns **no** app state. The caller (`PianoidTuner`) passes a `buildSnapshot()` function that returns
the current FE config; the dialog adds the live runtime params and the action-history copy. On
**Generate report** it: calls `buildSnapshot()`, awaits `fetchRuntimeParameters()` (proceeds even if
that returns `{ error }` — a down backend is itself a data point), builds the report, and
**auto-downloads immediately** (the primary delivery path). It then shows a status alert and offers
**Download** (again) and **Copy** buttons, plus a size/action-count/schema-version caption.

### The 🐞 button (`BottomBar.jsx`)

A small, unobtrusive `IconButton` (`BugReportOutlinedIcon`, `color: text.secondary`) at the far end of
the bottom bar, rendered only when an `onReportProblem` handler is wired. Tooltip: *"Report a problem
— capture config + recent actions for diagnosis"*; `aria-label` *"Report a problem"*.

---

## Capture Points

Every user action that matters is recorded through **one of two routes**, both funneling into
`recordAction`:

### 1. The `writeParam` SSOT (single hook for the bulk of actions)

In `src/hooks/usePreset.js`, **every backend write goes through one chokepoint** —
`writeParam` — before it is delivered (optimistically applied + debounced to REST/WS). A single
`recordAction('param_write', …)` at that chokepoint therefore captures **all** of:

- every parameter edit (strings / modes / excitation / feed-in / feedback / sound-channel …),
- **volume** and **feedback** changes (`kind: 'runtime'`),
- **note plays** (`kind: 'play'`),

with no per-editor instrumentation. The entry carries
`{ kind, key, wsEvent, debounceKey, values: summarizeValue(...) }`.

**Why the SSOT is the single hook (and the right one):** `writeParam` is the sole path from *any*
editor to the engine. Instrumenting it once means the recorder is **complete by construction** — a
new parameter editor added later is captured automatically, with zero extra wiring, because it too
must call `writeParam`. Instrumenting individual editors instead would be incomplete the moment a new
one is added, and would scatter identical recording calls across dozens of components. Capturing at
the chokepoint is the same architectural discipline that makes the debounce/optimistic-update logic
live in one place.

Preset lifecycle is also recorded in `usePreset.js`:

- `recordAction('preset_load', { settings: summarizeValue(presetLoadSettings) })` on a preset load, and
- `recordAction('preset_switch', { name })` on a preset switch.

### 2. The `PianoidTuner.js` effects (state that isn't a backend write)

Three `useEffect`s record UI state that changes without going through `writeParam`. Because the
recorder is a module singleton (not React state), these effects only push a cheap entry — they never
cause a re-render:

- `recordAction('selection', { pitch, pitches, mode, modes })` — on any change to
  `selectedPitch / selectedPitches / selectedMode / selectedModes`.
- `recordAction('settings_change', { uiPreferences: summarizeValue(uiPreferences) })` — on
  `uiPreferences` change.
- `recordAction('layout_change', { activeMosaicConfig })` — on mosaic layout change.

### Recorded action types (summary)

| `type` | Source | Detail fields |
|---|---|---|
| `param_write` | `usePreset.writeParam` | `kind`, `key`, `wsEvent`, `debounceKey`, `values` |
| `preset_load` | `usePreset` | `settings` |
| `preset_switch` | `usePreset` | `name` |
| `selection` | `PianoidTuner` effect | `pitch`, `pitches`, `mode`, `modes` |
| `settings_change` | `PianoidTuner` effect | `uiPreferences` |
| `layout_change` | `PianoidTuner` effect | `activeMosaicConfig` |

Every entry additionally carries `t` (ms since app load) and `type`.

---

## Report JSON Schema (schemaVersion 1)

The report is a single JSON object. Field names and shape below are verified against the code and
against a real generated sample. `BUG_REPORT_SCHEMA_VERSION = 1`.

```jsonc
{
  "schemaVersion": 1,                 // integer; bump on any breaking shape change
  "createdAt":   "<ISO-8601>",        // wall-clock: when the report was generated
  "appLoadedAt": "<ISO-8601>",        // wall-clock: when the app/session loaded (APP_LOADED_AT)
  "sessionMs":   <number>,            // performance.now() at generation — the anchor for action `t`
  "description": "<string>",          // the user's short problem description (may be "")

  "env": {
    "buildInfo":  { /* nodeEnv?, appVersion?, gitSha?, ...window.__PIANOID_BUILD__ */ },
    "appLoadedAt":"<ISO-8601>",       // (also present here, from getEnv)
    "userAgent":  "<navigator.userAgent>",
    "language":   "<navigator.language>",
    "url":        "<window.location.href>",
    "viewport":   { "w": <number>, "h": <number> }
  },

  "configSnapshot": {
    "preset": {
      "activePreset":          <object>,   // the loaded preset object
      "activePresetReadOnly":  <bool>,
      "libraryPresets":        <array>,    // available presets in the library
      "presetLoadSettings":    <object>    // the settings the preset was loaded with
    },
    "runtimeParams": <object | { "error": <string> }>,  // LIVE engine truth (see below)
    "fe": {                                             // frontend view/selection state
      "volume", "volumeRange", "feedback", "feedbackSensitivity", "storedFeedbackCoeff",
      "selectedPitch", "selectedPitches", "selectedMode", "selectedModes",
      "selectedParameter", "selectedVelocityLevel", "selectedGaussian", "matrixRowIsPiano"
    },
    "params": {                                         // the parameter arrays the FE holds
      "strings", "modes", "excitation",
      "feedInMatrix", "feedbackMatrix", "soundChannelData", "soundChannelFeedbackMatrix",
      "masks": { "feedIn", "feedback", "soundChannel", "soundChannelFeedback" }
    },
    "settings": {                                       // per-domain UI settings
      "uiPreferences", "chartSelectorSettings", "feedInSettings", "feedbackSettings",
      "soundChannelSettings", "workbenchSettings", "virtualPianoSettings",
      "modesSettings", "stringsSettings", "excitationSettings"
    },
    "layout":     { "activeMosaicConfig": <object>, "visibleWindows": <array> },
    "connection": { "wsConnected": <bool>, "wsLatencyMs": <number> },
    "health":     <object>,                             // last-held GET /health (audio driver/status/gpu/limiter…)
    "meta":       { "presetVersion", "totalModes", "availableNotes", "availableOutputChanels" }
  },

  "actionHistory": [                                    // oldest → newest, ≤ 200 entries
    { "t": <ms since load>, "type": "<string>", /* ...type-specific detail */ }
  ]
}
```

Notes on specific fields:

- **`runtimeParams`** is the **live engine truth** — the payload of the read-only
  `GET /get_runtime_parameters` (documented in
  [REST_API.md](../pianoid-middleware/REST_API.md)), fetched at generation time. It is *not* part of
  the sync `buildBugSnapshot()`; the dialog attaches it. Compare it against `configSnapshot.fe` /
  `params` to detect FE↔engine divergence (the "optimistic UI shows a change the engine never
  applied" class of bug). If the backend is down it is `{ error: "<message>" }` — still a useful
  data point, and the report still assembles.
- **`sessionMs` + each `t`** together let you place actions on an absolute timeline: wall-clock of an
  action ≈ `appLoadedAt + t` ms; `sessionMs - t` is "how long before report generation" the action
  occurred.
- **`env.appLoadedAt`** duplicates the top-level `appLoadedAt` (both come from the same
  `APP_LOADED_AT`). Harmless; prefer the top-level one.
- **Size.** A real report is ~2.3 MB pretty-printed, dominated by the `params` arrays and
  `runtimeParams`; `actionHistory` is small thanks to `summarizeValue`.

---

## User Flow

1. Something looks wrong during tuning.
2. Click the 🐞 icon at the far end of the **bottom bar**.
3. In **Report a problem**, type one sentence in *What happened?* (e.g. "Volume jumped after switching
   preset and playing C4"). The dialog shows how many actions are currently recorded.
4. Click **Generate report**. The report is built (config snapshot + live runtime params + action
   history) and the browser **auto-downloads** `pianoid-bug-report-<timestamp>.json`.
5. If the download is blocked, use the **Download** or **Copy** buttons the dialog reveals.
6. **Send the JSON file** to the developer / agent (Telegram, email, etc.).

No backend round-trip is required to *save* the report (it is generated entirely client-side); the
only network call is the read-only `GET /get_runtime_parameters` to capture live engine state.

---

## Consumption Workflow (how a developer/agent reproduces from a report)

A report is **data**; replay is done by a human or agent, not automated by the tool. To reproduce the
reported state:

1. **Restore the configuration.**
   - Load the reported preset: `configSnapshot.preset.activePreset` (name in
     `presetLoadSettings` / `preset_load`/`preset_switch` history). This establishes the baseline the
     deltas apply on top of.
   - Apply the **FE deltas** vs that preset's defaults: the values in `configSnapshot.fe`
     (volume / feedback / sensitivities / selections) and any edited `configSnapshot.params` arrays
     / matrices / masks that differ from the freshly-loaded preset. (Restoring the *preset* + the
     *deltas* is cheaper and clearer than diffing the whole `params` blob.)
   - Match `settings` (per-domain UI settings) and `layout` (mosaic) if the bug is UI/layout related.

2. **Confirm the engine baseline.** Cross-check `configSnapshot.runtimeParams` (what the engine
   actually had) against `fe`/`params` (what the FE believed). A mismatch here often **is** the bug
   (e.g. a WS write that never reached the backend — see the "half-open socket masks emits" failure
   mode). Also read `configSnapshot.health` (audio driver, GPU, limiter/clipping) and
   `connection.wsConnected` / `wsLatencyMs`.

3. **Replay the action history in `t` order.** Walk `actionHistory` oldest→newest and re-perform each
   action:
   - `param_write` — re-issue the write (`key` / `wsEvent` / `values`; `kind` distinguishes
     param vs `runtime` volume/feedback vs `play` note),
   - `selection` — re-select the same pitches/modes,
   - `preset_load` / `preset_switch` — re-load/switch,
   - `settings_change` / `layout_change` — re-apply.
   The `t` values give the relative timing; `sessionMs` anchors the sequence to generation time.

4. **Verify the fix against the reported state.** Per the project's Verification-Surface rule, once
   the state is restored and the sequence replayed, confirm the bug reproduces, apply the fix, and
   re-observe on the surface that observes the affected output (e.g. the `note_playback` offline
   render for a synthesis/volume bug). The report gives you the *exact* state to verify against
   instead of a guess.

---

## Under-Documented / Improvement Notes

Observations from documenting the shipped tool (candidates, not defects):

- **No engine-side capture.** The report is entirely client-side plus one read-only GET. Backend logs
  (`backend.log`), the CUDA gate/clip counters over time, or a short output-buffer capture are not
  included. For synthesis bugs, pairing the report with a `POST /capture` / `note_playback` render is
  still a manual step.
- **`env.appLoadedAt` duplication** (also top-level) — cosmetic; could be dropped from `getEnv()`.
- **Build/version info is best-effort.** A git SHA only appears if `REACT_APP_GIT_SHA` or
  `window.__PIANOID_BUILD__` is set at build time; by default a report cannot pin the exact FE build.
  Wiring the SHA at CRA build time would make reports reproducible against a specific commit.
- **Ring buffer is not persisted.** A full page reload (the user's standard clean-restart routine)
  clears the 200-action history, so a report must be generated *before* reloading. Worth noting in
  the user-facing tooltip/help.
- **No automated replay.** Replay is manual. The schema is regular enough that a replay harness
  (drive `writeParam`-equivalent calls from `actionHistory`) is feasible future work.
