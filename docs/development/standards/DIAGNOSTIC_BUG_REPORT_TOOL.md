# Standard: In-App Diagnostic Bug-Report Tool

> **Liftable / project-agnostic.** This is a reusable design **pattern**, not a Pianoid feature spec.
> It names no project-specific fact. It is a **candidate to sync into `~/claude-config`** (via
> `/self-update`) so it can be applied to any application. Pianoid is used below only as a worked
> example; the normative pattern is app-agnostic. When lifted, keep the normative sections verbatim
> and replace the "Worked Example" section with the target app's specifics.

---

## Purpose

Give any interactive application a **one-click, self-contained, reproducible bug report** so that a
developer or agent can reproduce the user's exact state and verify a fix against it — instead of
asking the user to narrate, re-test, or paste logs.

The pattern targets a specific, expensive class of bug: **path-dependent** defects that only manifest
after a particular ordered sequence of user actions against a particular configuration ("it broke
after I switched X, edited Y, then did Z"). Human narration loses the fidelity needed to reproduce
these. This tool captures the sequence **automatically, as it happens**, and packages it with a full
state snapshot.

---

## Design Principles

1. **Always-on, free capture.** Record every meaningful user action into a lightweight, in-memory
   **ring buffer**, continuously, from app start — not only after a problem is noticed. The user
   should never have to "start recording"; by the time they realize something is wrong, the evidence
   already exists.

2. **Hook the single write chokepoint (SSOT), not every widget.** Instrument the *one* place every
   state-changing action already flows through (the single-source-of-truth write path). This makes
   capture **complete by construction**: a feature added later is captured automatically, with zero
   extra wiring, because it too must go through the chokepoint. Instrumenting individual controls is
   incomplete the moment a new one is added and scatters identical calls everywhere. Capture the
   handful of actions that *don't* pass the chokepoint (selection, layout, settings) at their own
   small hooks.

3. **Recording must be invisible and unbreakable.** Recording an action must **never** trigger a
   re-render, never allocate meaningfully, and **never throw** — a diagnostic tool must not perturb or
   crash the app it observes. Use a module-level singleton (not framework state) so a write is a cheap
   push + trim, wrapped so it can never surface an error to the app.

4. **On-demand full snapshot of config + live runtime state.** When the user files a report, capture
   *both* what the client *believes* (its config/view state) *and* the **live runtime/server truth**
   (a read-only query of the backend's actual applied state). The **divergence** between the two is
   frequently the bug itself.

5. **Self-contained, human-readable, reproducible report.** One file, no external dependencies to
   interpret it. Pretty-printed JSON. It must contain everything needed to (a) restore the
   configuration and (b) replay the action sequence. "Reproducible" is the contract: if the report
   cannot be turned back into the reported state, it has failed.

6. **Minimal user friction.** The whole interaction is: notice → click one unobtrusive affordance →
   type one sentence → the file downloads → send it. No account, no upload step required to *save* it,
   no multi-field form. Client-side generation; the only network call is the read-only runtime query.

7. **Agent-replay / verification loop.** The report exists so a fix is **verified against the exact
   reported state**, honoring the verification-surface discipline: restore config → replay actions →
   reproduce → fix → re-observe on the surface that observes the affected output.

---

## Generalized Report Schema (categories, not field names)

Version the schema (`schemaVersion`) and organize it into these **categories**. Field names are the
integrator's choice; the *categories* are normative.

| Category | What it holds | Why |
|---|---|---|
| **Versioning** | `schemaVersion` (integer). | Lets consumers/replay tools evolve; bump on any breaking shape change. |
| **Timestamps** | Wall-clock report-creation time; wall-clock app/session-load time; a session-relative "now" (ms since load) that anchors action times. | Places actions on an absolute timeline without trusting the wall clock for ordering. |
| **Description** | The user's short free-text problem statement (may be empty). | Human intent — what "wrong" means here. |
| **Environment** | Client/runtime identity: user-agent/platform, locale, URL/route, viewport/window, and **build/version info** (ideally a VCS commit SHA). | Reproduce on the right build + platform. |
| **Config snapshot** | The full current configuration in two halves: **(a) client-believed state** — active document/preset/profile, view & selection state, all parameter/setting values, layout; and **(b) live runtime truth** — a read-only snapshot of what the backend/engine actually applied, plus connection/health status. | Restore the exact configuration; the (a)-vs-(b) delta often *is* the bug. |
| **Action history** | An ordered array (oldest→newest) of the last *N* recorded actions, each `{ t: <ms since load>, type, …detail }`, `t` monotonic. | Replay the exact sequence that produced the bug. |

Design the schema so the two config halves are **separable**: restoring "load profile P, then apply
these deltas" is cheaper and clearer for a consumer than diffing one giant blob.

---

## Integration Recipe

### 1. Where to hook the recorder

- **Find the write chokepoint.** Identify the single function every state-changing action already
  passes through before it hits the backend/model (the debounced/optimistic "apply" path, the Redux
  middleware, the command dispatcher, the API-client wrapper). Add one record call there. This is the
  highest-leverage hook — it covers the bulk of actions for one line of instrumentation.
- **Add small hooks for out-of-band state.** Selection, navigation/route, layout, and preference
  changes usually don't pass the write chokepoint. Record each at its own minimal hook (e.g. a
  reactive effect keyed on that state).
- **Categorize by `type`.** Give each action a stable `type` string and merge a small, already-
  summarized `detail` object.

### 2. What to snapshot on demand

- **Client-believed config:** active document/preset, all editable parameters/settings, view &
  selection state, layout. Read the *latest* values at generation time (don't memoize a stale copy).
- **Live runtime truth:** one **read-only** query to the backend for its actually-applied state, plus
  connection + health/status. Make it **fail-soft**: if the backend is down, record
  `{ error: <message>}` and still assemble the report (a down backend is itself a data point).
- **Environment + build info:** best-effort; wire a **commit SHA** at build time if at all possible —
  it is what makes a report reproducible against a specific build.

### 3. The reproducibility contract

The report is only done if a consumer can, from it alone:

1. **Restore config** = load the referenced profile/preset, then apply the recorded deltas
   (client state), and confirm against the live-runtime snapshot.
2. **Replay actions** = walk the action history in `t` order and re-perform each typed action.
3. **Reproduce → fix → re-observe** on the surface that observes the affected output.

If any of these can't be done from the file, add the missing category — don't rely on out-of-band
context.

### 4. Ring-buffer sizing

- Keep the **last N** actions; trim from the front so the buffer is always the most-recent window.
  N≈200 is a good default for a fine-grained editing app (covers minutes of dense interaction while
  staying tiny). Size N to "enough actions to contain the sequence that triggers a typical bug,"
  not "the whole session."
- Store **session-relative** monotonic time (`performance.now()`-equivalent) per entry, and one
  wall-clock anchor once in the envelope. Never rely on wall-clock for ordering.
- The buffer is **not persisted** — a full reload clears it. Generate the report *before* reloading;
  say so in the tool's help text.

### 5. Size and PII considerations

- **Summarize large values.** Truncate long strings; collapse large arrays/objects to
  `{ count, head/keys }` markers; cap recursion depth. Record *what changed*, not every byte — this
  keeps both the ring buffer cheap and the report readable.
- **Mind report size.** A full config snapshot can be large (megabytes). That's usually fine for a
  downloaded file; if the report is *uploaded*, consider gzip and/or snapshot-trimming.
- **PII / secrets.** The snapshot may include a URL, filesystem-ish names, or user content. Before
  adopting: audit what the config snapshot and action details can contain, redact secrets/tokens, and
  — if reports leave the user's machine — disclose what is collected. Default to **local download +
  user-initiated send**, which keeps the user in control of the data.

### 6. Delivery

- **Auto-download** the file as the primary path; offer **copy-to-clipboard** as a fallback.
- Give the file a **stable, timestamped, filesystem-safe name**.
- Keep the affordance **unobtrusive** (a small icon in a status/bottom bar), gated so it only appears
  where a handler is wired.

---

## Worked Example — Pianoid (PianoidTunner)

Pianoid, a live GPU piano synthesizer with hundreds of interacting per-pitch parameters, implements
this pattern to catch path-dependent bugs (e.g. "volume jumped after switching preset and playing
C4"). Mapping to the principles:

| Pattern element | Pianoid realization |
|---|---|
| Ring buffer (singleton, re-render-free, 200-cap, `performance.now` times, `summarizeValue`) | `src/utils/actionRecorder.js` |
| Write chokepoint (SSOT) | `usePreset.writeParam` — one `recordAction('param_write', …)` covers all param edits, volume/feedback, and note plays |
| Out-of-band hooks | `PianoidTuner.js` effects → `selection` / `settings_change` / `layout_change`; preset `preset_load` / `preset_switch` in `usePreset` |
| On-demand client snapshot | `PianoidTuner.buildBugSnapshot()` (preset, fe, params, settings, layout, connection, health, meta) |
| Live runtime truth (read-only, fail-soft) | `GET /get_runtime_parameters` → `configSnapshot.runtimeParams` (or `{ error }`) |
| Report builder + delivery | `src/utils/bugReport.js` — `buildReport` (schemaVersion 1), auto-download, clipboard fallback |
| Dialog + affordance | `src/components/BugReportDialog.jsx`; 🐞 icon in `src/components/BottomBar.jsx` |

Full project-specific write-up (exact JSON schema, capture points, consumption workflow):
[modules/pianoid-tunner/BUG_REPORT_TOOL.md](../../modules/pianoid-tunner/BUG_REPORT_TOOL.md).

---

## Adoption Notes

- **Minimum viable adoption** is four small parts: a singleton ring buffer, one record call at the
  write chokepoint, an on-demand snapshot function, and a dialog that assembles + downloads. Everything
  else (out-of-band hooks, live-runtime query, clipboard fallback, value summarization) is additive.
- **Framework-agnostic.** The buffer is deliberately *outside* the UI framework's state, so the pattern
  applies to React/Vue/Svelte/native alike — the only framework-specific pieces are the effects that
  watch out-of-band state and the dialog.
- **Cost.** Instrumentation is a handful of lines; the ongoing runtime cost is one array push + trim
  per user action.
- **Biggest wins, in order:** (1) hooking the true SSOT chokepoint, (2) capturing live-runtime truth
  alongside client-believed state, (3) pinning the build SHA. These three are what turn "a log" into
  "a reproducible report."
- **Known limits to design around:** no engine/server-log capture by default (pair with a server-side
  capture for output bugs); ring buffer lost on reload; replay is manual unless you build a harness
  that drives the chokepoint from the action history.
