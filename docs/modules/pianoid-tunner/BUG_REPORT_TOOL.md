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
              bugReport.buildReport()  ──▶  self-contained JSON  (schemaVersion 2)
                  ▼
              postReportToCollector()  ──▶  POST /bug_report  ──▶  PianoidCore/logs/reports/…-manual-<reportId>.json
                  │  (collector unreachable / refused)
                  ▼
              downloadReport()  ──▶  pianoid-bug-report-<ISO>.json   (copy-to-clipboard fallback)
```

| Part | File | Concern |
|---|---|---|
| Ring buffer | `src/utils/actionRecorder.js` | Always-on, module-singleton, re-render-free capture of the last 200 actions. |
| Report builder | `src/utils/bugReport.js` | Assemble + serialize + download/copy; the live `GET /get_runtime_parameters` call. |
| Dialog | `src/components/BugReportDialog.jsx` | Collect the description, orchestrate generation, file the report in the backend store (download/copy as the fallback). |
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
**files it in the backend's report store** — `POST /bug_report` via `autoReporter.postReportToCollector`,
the same collector and folder as the auto and assistant reports (dev-fe18, 2026-10-18). On success the
alert shows the stored report id and file name; when the POST fails or the collector answers
`ok: false`, the report is **downloaded** instead and the alert says why. The **Download** and
**Copy** buttons stay available either way, plus a size/action-count/schema-version caption.

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
| `system_signal` | `systemSignals.recordSystemSignal` (via the axios interceptor, /health watch, `useSocketIO`, `window.onerror`/`unhandledrejection`) | `kind`, `detail` |

Every entry additionally carries `t` (ms since app load) and `type`.

---

## Auto-Fire on Internal System Faults

The tool no longer waits for a user click. It also **reacts to internal system
signals** — server crashes, unresponsive endpoints, prohibited/clamped values —
and **assembles + delivers a full report automatically, with no user
interference** (dev-bugauto, 2026-07-11). The manual 🐞 flow is 100% unchanged.

Three parts, each a single-concern module (mirrors the manual tool's shape):

| Part | File | Concern |
|---|---|---|
| Signal capture | `src/utils/systemSignals.js` | Record internal faults into the SAME ring buffer (`type:"system_signal"`) + classify significance + notify subscribers. Module singleton, re-render-free, never-throws. |
| Auto-report controller | `src/utils/autoReporter.js` | Dedup/rate-limit/debounce → assemble (reuse `buildReport`) → deliver (collector POST, localStorage fallback, flush-on-recovery + backoff retry, `createPendingRetrier`). |
| Wiring | `src/hooks/useAutoReport.js` | Install the fault sources (axios interceptor, `/health` watch, `window.onerror`/`unhandledrejection`), gate on the setting, feed the controller. Mounted once in `PianoidTuner`. |
| Collector | `PianoidCore/pianoid_middleware/backendServer.py` → `POST /bug_report` | Save the posted report JSON to `PianoidCore/logs/reports/`. |

### The fault set (what fires, what is context-only)

| Signal kind | Source | Significant? (auto-fires) |
|---|---|---|
| `backend_exception` | `/health` `exception:true` (engine/MIDI fault latched) | **yes** |
| `backend_crashed` | `/health` `status:'crashed'` (at once) OR `backend_thread_running:false` while loaded — the latter only when a fresh `/health` **still** shows it `CRASH_CONFIRM_MS` = 8 s later and is not `status:'loading'` (dev-2cce R4, below) | **yes** |
| `endpoint_unresponsive` | axios interceptor: **5xx** (except a lifecycle 503), or the **3rd consecutive** network error / timeout of a host that has answered before (dev-2cce R2, below); for the `:5000` backend only once a `/health` re-probe rules out a render / calibration window (dev-f8f9, below) | **yes** — EXCEPT the optional modal-adapter `:5001/health` poll (excluded; see below) |
| `endpoint_timeout` | a network error / timeout below that threshold, before the host ever answered, or during this tab's own preset load (`isBusy`) | no — context |
| `endpoint_busy` | `503 {code:"lifecycle_in_progress"}` — the engine gate refusing a request while a preset lifecycle op runs | no — context |
| `read_refused` | a 4xx on a **GET** (e.g. `400 "No preset loaded"` before the first load) — only refused WRITES are `param_rejected` | no — context |
| `js_error` | `window.onerror` | **yes** |
| `unhandled_rejection` | `window.onunhandledrejection` | **yes** |
| `param_rejected` | axios interceptor: **HTTP 4xx** (a prohibited/clamped value) | only in **burst** (≥5 in 5 s ⇒ `reject_burst`) |
| `ws_disconnect` | `useSocketIO` `disconnect` | no — recorded for context (a restart is normal) |
| `ws_degraded` | `useSocketIO` half-open/degraded cooldown | no — recorded for context (falls back to REST) |

> **`healthStatus.running` mirrors `/health backend_thread_running`** (useBackendHealth). Until
> dev-17fd (2026-10-04) it read a non-existent top-level `running` key, so `running` was always
> false once a preset was loaded and **every preset load filed a false `backend_crashed`** ~2–6 s
> later (the realtime loop was healthy). Reports from before that fix with
> `trigger.detail = {status:'healthy', running:false}` are false positives.

**The REST layer is captured at ONE chokepoint — a global axios response
interceptor** — exactly as the manual tool captures writes at the `writeParam`
SSOT: every failed REST call (any call site, present or future) is classified
without per-call instrumentation. A `{ok:false}` WS ack falls back to REST in
`writeParam`, so a genuine rejection surfaces as the REST 4xx the interceptor
sees. The interceptor **ignores its own** `/bug_report` and
`/get_runtime_parameters` calls (no feedback loop). Backend crash/exception is
read from the **existing** `useBackendHealth` poll — **no second poll is added**.

**Optional-service health polls are excluded (dev-f10d, 2026-07-12).** The
modal-adapter server (`:5001`) is an OPTIONAL, on-demand backend started by the
Modal Adapter panel; while it is stopped, `useServerLifecycle` polls
`http://127.0.0.1:5001/health` **every 2 s** and each poll fails. Those failures
are *expected*, not a bug, so `classifyAxiosError` **drops any `:5001/health`
failure** (`isOptionalHealthUrl`) before it reaches the reporter — a stopped
optional server never produces a report. (Genuine `:5001` *operations* — e.g.
`/modal/gpu_status`, tracking, esprit — are still classified; they are bounded by
per-host episode dedup below, so a down `:5001` yields at most ONE report, not a
flood.) This closed a runaway where a stopped `:5001` produced 300+ identical
`endpoint_unresponsive` reports in minutes.

### Lifecycle and startup windows are not faults (dev-2cce, 2026-10-16)

The 2026-10-16 triage found 14 of 39 auto-reports were expected windows, plus single `/health`
timeouts and duplicate deliveries:

| Window | What it looked like | Rule now |
|---|---|---|
| FE loaded before the backend started (every start, the user's restart routine) | `/health` `ERR_NETWORK` → `endpoint_unresponsive` | a host that has **never answered** since app load is not down — its failures are `endpoint_timeout` (`createUnresponsiveGate` in `autoReporter.js`) |
| Preset load / re-init (the engine gate) | `/midi/ports` `503` ×3 per window | `503 lifecycle_in_progress` → `endpoint_busy` (context) |
| Before the first preset load | ~8 startup GETs answer `400 "No preset loaded"` → `reject_burst` (measured live on every fresh start) | a 4xx on a GET → `read_refused` (context) |
| Preset re-init (old realtime thread stopped, new one not yet started) | WS `lifecycle` events (`GPU_READY` / `PARAMETERS_LOADED` → `healthy`) with `running:false` → `backend_crashed` 0.3 s after the load | thread-stopped is confirmed by a fresh `GET /health` 8 s later (skipped while `isBusy` or the probe says `loading`) |
| Backend busy under a write burst | ONE 2 s `/health` timeout → `endpoint_unresponsive` | `UNRESPONSIVE_THRESHOLD` = 3 consecutive network/timeout failures of the host; any success of that host resets the count |
| A large (12 MB, N2000 preset) report | the 5 s collector POST timed out mid-save → the lifeboat copy was delivered again later (5 duplicate pairs) | `COLLECTOR_TIMEOUT_MS` = 30 s, and every report carries a `reportId` — the collector saves it once ([REST `POST /bug_report`](../pianoid-middleware/REST_API.md#post-bug_report)) |

### Render and calibration pauses are not faults (dev-f8f9, 2026-10-18)

The 2026-10-18 triage (12 auto-reports 11:06-11:48Z, correlated with `backend_stdout.log`) found
no real crash. Every `backend_crashed` was a calibration or an offline render with the realtime
thread stopped, or the flag left off after a calibration. Every `endpoint_unresponsive` was `/health`
starved for ~10 s at the end of a ~47 s `render.chart` (`sound_test`, 88 pitches) with live audio.

| Window | Rule now |
|---|---|
| Render / calibration in progress | `/health` `engine_busy.active` ([REST](../pianoid-middleware/REST_API.md#get-health)): the crash-confirm probe files nothing |
| `:5000` outage (3rd consecutive failure) | re-probe `/health` every `OUTAGE_PROBE_MS` (5 s). Unreachable for `OUTAGE_MAX_MS` (60 s) → `endpoint_unresponsive` (`confirmedAfterMs`). Answers with `engine_busy` active, `status:'loading'`, or `engine_busy.last.ended_at` after the outage began (5 s margin) → `endpoint_busy` (context, with `reason`). Answers with no busy window → `endpoint_unresponsive` (`recoveredAfterMs`: a stall that recovered) |
| After a calibration | backend fix: `exit_calibration_mode` restarts live playback through the realtime-thread owner, so `backend_thread_running` is `true` again |

Pinned by `hooks/__tests__/useAutoReport.lifecycle.test.jsx`. Live (isolated stack, measured preset, 2026-10-16): a fresh start + one full re-init filed 3 reports before the fix (`reject_burst`, `endpoint_unresponsive` 503, `backend_crashed` `healthy/running:false`); after it, a fresh start + two full re-inits filed none, while a real backend stop still filed `endpoint_unresponsive`.

### Trigger policy — one report per fault EPISODE

A crash must not spawn 50 reports. The controller (`createAutoReporter`):

- **Debounce** `DEBOUNCE_MS = 1500` — a fault's flurry of signals collapses into ONE report.
- **Episode dedup** — all backend faults share the episode key `backend_fault`; while an episode is *active* (fired, not yet cleared) further signals are suppressed. The episode is **re-armed** only when the fault CLEARS (`/health` recovers, WS reconnects), so a later recurrence can fire again.
- **`endpoint_unresponsive` is keyed PER HOST (dev-f10d, 2026-07-12)** — `episodeKeyFor` appends the request's `host:port` (e.g. `endpoint_unresponsive:127.0.0.1:5001`), and the axios **success** interceptor clears **only the succeeding URL's** episode. This is load-bearing: a global key let a healthy `:5000` success re-arm the still-down `:5001` episode every cooldown, turning dedup into a 300+-report flood. Per-host keys isolate each endpoint's up/down state, so a continuously-down endpoint fires exactly ONCE and stays latched until *that* endpoint itself recovers. (Relative / same-origin URLs collapse to the base key `endpoint_unresponsive`.)
- **Global cooldown** `MIN_INTERVAL_MS = 10000` between auto-reports; **session cap** `MAX_PER_SESSION = 20`.
- **Reject burst** — a single 4xx is minor; `REJECT_BURST_THRESHOLD = 5` within `REJECT_BURST_WINDOW_MS = 5000` becomes a significant `reject_burst`.

The auto-report is the SAME assembly as the manual path (config snapshot + live
runtime params + action history) with an auto-filled `description`
(`"AUTO: backend exception latched — engine/MIDI fault"`, …) and a
`trigger:{auto:true, kind, count?, detail?}` marker.

### Auto-deliver — collector, with a backend-down lifeboat

**PRIMARY — backend collector.** The FE POSTs the auto-report to
`POST /bug_report`; the backend saves it to
`PianoidCore/logs/reports/bugreport-<createdAt>-<auto-<kind>|manual>-<hex6>.json`
(dir auto-created; oldest pruned beyond `_REPORTS_KEEP = 500`). No download, no
click — it lands in a folder the dev/orchestrator watches.

**FALLBACK — the fault IS the backend being down**, so the collector POST fails.
The report must still survive: it is persisted to `localStorage`
(`pianoid_pending_bug_reports`, bounded to `MAX_PENDING = 5`, oldest dropped).
The persisted copy is **compacted** — the heavy `configSnapshot.params` arrays
are dropped (`{__omitted:…}`) so the ~2 MB report fits localStorage's ~5 MB cap;
the diagnostic core (fault/trigger, `actionHistory`, `fe`, `health`,
`runtimeParams`) is kept. localStorage **survives the user's full-reload restart
routine**, so the backend-crash report — the most important one — is not lost.

**FLUSH-ON-RECOVERY + RETRY (dev-16af).** Every persisted report is POSTed to the collector and
cleared from localStorage as soon as the backend is back, through one retrier
(`createPendingRetrier` in `autoReporter.js`): **at once** on app mount, a WS reconnect, ANY
`/health` transition into a healthy state (incl. `disconnected` → `healthy` — a stall), and a
successful `:5000` request while something is queued (throttled to one attempt per 5 s); and on a
**backoff timer** (5 s doubling to 60 s) while the queue is non-empty, so a report is delivered even
with no edge at all. Reports that still fail stay queued. Before the fix the queue flushed only on a
WS reconnect, mount, or a recovery from `crashed`/`exception`: reports stored during the 2026-10-20
13:42–13:47Z backend stall (WS up, `/health` timing out = `disconnected`) waited until 16:30Z.
Tests: `hooks/__tests__/useAutoReport.deliveryRetry.test.jsx`.

**One report per fault across tabs (dev-16af).** Each report carries `trigger.episode` (the episode
key above); the collector saves the first report of an episode and answers the other tabs'
copies within 120 s with `duplicate: true`
([REST `POST /bug_report`](../pianoid-middleware/REST_API.md#post-bug_report)).

### Settings toggle

Auto-reporting is **ON by default**. A user can disable it via the
`uiPreferences.autoReportEnabled` flag (`=== false` disables the whole
controller — no interceptor, no watchers, no auto-fire). It is a `useSettings`
preference (persisted); a dedicated UI control is a small follow-up. The **manual
🐞 path is never gated by this flag.**

> **Open decision flagged to the user:** auto-reports land as files in
> `logs/reports/` and (when the backend is down) in `localStorage`. A backend-down
> report is NOT auto-downloaded by default (to avoid surprise browser downloads) —
> it relies on localStorage + flush. If you'd prefer backend-down reports to ALSO
> auto-download as a belt-and-suspenders, that is a one-line change
> (`autoReporter.deliverReport`).

## Report JSON Schema (schemaVersion 2)

The report is a single JSON object. Field names and shape below are verified against the code and
against a real generated sample. `BUG_REPORT_SCHEMA_VERSION = 2` (v2 added the
`trigger` field + the `system_signal` action type — both additive; see
[Auto-Fire on Internal System Faults](#auto-fire-on-internal-system-faults)).

```jsonc
{
  "schemaVersion": 1,                 // integer; bump on any breaking shape change
  "reportId":    "<16 hex>",          // identity of this report (additive, dev-2cce): the collector saves it once
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
   history) and saved in the backend's report store (`PianoidCore/logs/reports/`, next to the auto
   reports); the dialog shows `Report <id> saved to the bug-report store (<file>)`.
5. If the backend is unreachable, the browser **downloads** `pianoid-bug-report-<timestamp>.json`
   instead; **Download** / **Copy** are always offered.
6. A stored report needs no hand-off (agents read the store); a downloaded one is sent to the
   developer / agent (Telegram, email, etc.).

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
