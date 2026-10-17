# Assistant v2: state, runbook, code, physics, bugs, web, approvals (proposal)

**Date:** 2026-10-16 · **Author:** plan-assistant-v2 (orchestrator-dispatched; design only, no code) · **Status:** APPROVED by the user ("Go"); in
progress: P1, P2 and P5 DONE (merge SHAs in [§11](#11-phased-plan)); the decisions recorded so far are in [§12](#12-decisions-for-the-user).
**Builds on:** [AI assistant proposal](ai-assistant-in-ui-2026-10-13.md) (decisions D1–D7, §9), the
[A4 + A1 design note](../development/assistant-a4-a1-design-2026-10-15.md) (merged, dev-df3c), and the **unmerged** dev-0a88
revision (PianoidInstall `feature/dev-0a88-assistant-rev`, PianoidCore `feature/dev-0a88-assistant-ops`, PianoidTunner
`feature/dev-0a88-assistant-pane`; design note §8 + the [transcript review](../development/assistant-transcript-review-2026-10-16.md) on that branch).
**Docs read:** `docs/index.md` → `PROJECT_CONFIG.md` (`#data-model-facts` `#verification-surfaces` `#key-paths`) → the two assistant docs above →
`modules/pianoid-middleware/REST_API.md` (Commands and jobs (I4), `/health`, `/get_parameter`, `/audio/*`, `/bug_report`) →
`modules/pianoid-cuda/SYNTHESIS_ENGINE.md` (string FDTD, modes, coupling, excitation) → `modules/pianoid-cuda/PARAMETER_SYSTEM.md` →
`modules/pianoid-basic/OVERVIEW.md` (PhysicalParameters, PianoHammer) → `development/reviews/parameter-sound-test-strategy-2026-07-07.md` →
`modules/pianoid-tunner/OVERVIEW.md` (UI commands (I5), feedback semantics) + `BUG_REPORT_TOOL.md` → the registry `schemas/commands/*.json`.

**The user's requirements (Telegram, 2026-10-16, verbatim):**

1. The assistant has to have full information on the running system: presets, parameters, environment.
2. It should perform the standard actions (basically everything that can be done by the UI: parameter updates, layout
   updates, user actions) exactly as prescribed by the runbook. Actions outside the standard set should use documented
   functionality. It should be able to write and run code to perform actions not covered by the application (e.g. compare
   the spectra of two signals). There should be a robust set of triggers to escalate the backend to Opus depending on the
   action requested.
3. It should have full access to and information on the physics of the process and the model's working principles, in
   order to discuss and predict the effect of parameter changes on the sound; escalate to Opus for such tasks. It should
   understand requests such as "make the sound brighter" and know which parameters to change.
4. It should identify bugs in the application and file issues as soon as a bug is identified.
5. It should have web search for theoretical and practical discussions around the project.
6. There should be a way to cancel approval requests for certain categories of actions (e.g. parameter editing), so those
   actions are performed straight away.

---

## 1. Summary

| | |
|---|---|
| **What changes** | v1 is a tightly sealed tool user: one MCP server (the registry), `escalate_model`, no files, no shell, no web, every write confirmed. v2 keeps that seal as the default and opens **four controlled doors**, each with its own gate in the service policy (never in the prompt): (a) a **runbook** layer over the registry, so every UI action is a command and common tasks are machine-readable recipes; (b) a sandboxed **`analysis.run_python`** tool that works on exported signal artefacts only; (c) a **researcher sub-agent** that alone holds WebSearch / WebFetch; (d) **bug filing** to the native Pianoid bug-report system only (the backend collector `POST /bug_report`; never GitHub: user decision 2026-10-17). |
| **Knowledge** | A full state snapshot (`system.*` reads: environment, build, GPU, audio map, the preset files, a parameter inventory) and a **physics primer** with a sourced **timbre → parameter** table. Directions come from the docs, and magnitudes stay UNKNOWN until they are measured (§6). |
| **Models** | A **deterministic pre-router** picks Opus for physics / prediction, code, bug analysis, comparisons and multi-step plans before the turn starts. Tool triggers (first code run, a bug draft, web research) and failure triggers (repeated tool errors) escalate during the turn, and the model can still self-escalate (§5). |
| **Approvals** | Per-category **Ask / Auto** switches in the pane, persisted per installation in the assistant's `config.json`. A **hard-confirm list** can never be set to Auto, and a turn **tainted** by web content asks again for every write / exec / filing (§9). |
| **Biggest risk** | Code execution ends D1's "no file / exec tools" isolation. It is prompt-injectable through docs, preset metadata and the web. The design keeps the model away from a shell: one custom tool, an OS sandbox (AppContainer + Job Object on Windows, a container as the fallback), no network, no repo or credential access, inputs only from the artefact store (§4.3). |
| **Prerequisite** | Merge dev-0a88 first (three repos): the context digest, `preset.load_settings`, the mute commands and the R6 render guard are the base that v2 extends. |
| **Effort** | P0–P8, about 25–35 agent-days in total; the first user-visible value (approvals + snapshot + escalation) lands in P1–P2, about 5–7 days (§11). |

---

## 2. Gap analysis: the current assistant vs the six requirements

**The current assistant** (master + dev-0a88): the Agent SDK `query()` with `tools: []` (no built-in tool), `settingSources: []`,
`strictMcpConfig: true`, `mcpServers: {pianoid, assistant}` (the registry MCP server and the in-process `escalate_model`),
`CLAUDE_CONFIG_DIR` and `HOME` inside `%USERPROFILE%\.pianoid-assistant`, `cwd` = the empty `workspace\`, and `policy.decide` in
`canUseTool` (read / ui / act allow; write, destructive and launcher control confirm; renders denied while live audio runs (R6, dev-0a88)).
The prompt carries the data-model facts and the reading rules; `search_docs` is a keyword index over `docs/**/*.md`.

| Req | Needed | Current | Gap | Section |
|---|---|---|---|---|
| 1 Full state | presets, parameters, environment | `/health` digest per turn (audio, level, load, layout, warnings; dev-0a88), `runtime.get`, `param.get` per domain, `preset.list` (the loaded library), `preset.load_settings`, `ui.snapshot`, `history.get`, `play.stats`, `job.*`, `launcher.status`, `calibration.status`, `modal.status` | **no environment read** (GPU, driver, CUDA, build variant, installed wheel vs checkout, repo SHAs, `PIANOID_*` env vars, the audio output map, MIDI ports, mic device); **no list of preset files on disk** (only the in-memory library); **no parameter inventory** (field names, units, ranges, key spaces, derived vs editable; the P0 glossary was never written); `/health` is used by the digest but is not a tool | §3 |
| 2a Standard actions per a runbook | every UI action as a command, prescribed procedures | 60 registry commands (11 families incl. `ui`), the prompt's mute / load rules | **no runbook** (procedures exist only as prompt prose); **UI actions without a command** (coverage audit §4.2: MIDI port and listener, excitation / hammer special routes, workbench edits, named-layout save, preset save-as / import / export, calibration sub-panels, modal pipeline stages, the bug dialog, audio device / session); nothing makes a new UI action register a command | §4.1, §4.2 |
| 2b Documented functionality outside the set | cite docs, use only documented routes | `search_docs` (keyword snippets) | no full-section read; nothing stops an undocumented route call (the MCP server exposes only the registry, which is good) | §4.1, §6.1 |
| 2c Write and run code | e.g. compare two spectra | none (`tools: []`) | **no execution, no artefacts**: render results are summarised to `{samples, peak_abs, rms, all_zero}` (dev-0a88) and the raw audio is dropped; renders are refused while live audio runs (R6) | §4.3 |
| 2d / 3 Opus triggers | robust, per action | `escalate_model` self-call only (the prompt's "research or complex reasoning") | no deterministic routing; the transcripts show Sonnet staying on a failing multi-step diagnosis (session 2c86b530, 9 of 11 FAIL) without escalating | §5 |
| 3 Physics | the model's principles, timbre requests | the prompt's data-model facts; `search_docs` can find SYNTHESIS_ENGINE sections | **no physics primer, no timbre → parameter map**; no prediction discipline (state the hypothesis, A/B it) | §6 |
| 4 Bug filing | detect + file at once | the FE auto-fires reports to `POST /bug_report` → `PianoidCore/logs/reports/` (269 files on this machine today); the manual 🐞 dialog only **downloads** | the assistant cannot file, list or de-duplicate (GitHub filing is not wanted: user decision 2026-10-17) | §7 |
| 5 Web search | theory and practice | none | everything: the tools, the injection guard, the D4 query rule | §8 |
| 6 Category auto-approve | e.g. param edits run at once | every write confirms (A2's envelope + auto-revert never built) | no categories, no persisted setting, no hard-confirm list; Auto for parameters needs the A2 envelope first (D3) | §9 |

---

## 3. Requirement 1: the full state snapshot

### 3.1 What exists and what is missing

| Area | Existing read (route → command) | Missing |
|---|---|---|
| Engine health | `GET /health` (status, lifecycle, `audio_driver_fallback`, `audio_health`, `output_scale`, `mode_layout`, `clipping` / `peak_level`, `gate_trip_count`, `cooperative_launch`, `gpu_available`, `listen_mode`, `single_deck_matrix`, `stored_feedback_coeff`) → digest only | a **`system.health`** command (the raw `/health`, bounded) |
| Load settings | `GET /load_settings` → `preset.load_settings` (dev-0a88) | — |
| Runtime | `GET /get_runtime_parameters` → `runtime.get` | — |
| Audio device | `GET /audio/devices` (ASIO host: driver, rate, buffer, latencies, inputs / outputs) | a command (**`audio.devices`**, read); the engine-channel → device-output map `PIANOID_AUDIO_OUTPUT_MAP` (AUDIO_DRIVERS.md) is a backend env var, readable nowhere |
| GPU / build | `cooperative_launch` in `/health` (SMs, regs, blocks); `:5001 /modal/gpu_status` (CuPy probe) | **`system.environment`**: GPU name, VRAM, driver version, CUDA runtime, `pianoidCuda` version + build variant (release / debug) + build time, the installed `pianoid_basic` wheel version, the four repos' branch + SHA + dirty flag, the Python version, the OS, the allow-listed `PIANOID_*` env vars (`PIANOID_AUDIO_OUTPUT_MAP`, `PIANOID_SYNTH_RT`, `PIANOID_BUILD_VARIANT`, `PIANOID_MEASUREMENTS_DIR`, `PIANOID_COMMANDS_DIR`, `PIANOID_MODAL_URL`), ports + PIDs (from `launcher.status`) |
| MIDI | `GET /midi/ports`, `GET /midi/broadcast`, `GET /get_fix_velocity` | commands (`midi.ports`, `midi.status`, read) |
| Calibration | `calibration.status`; `GET /calibration_params`, `GET /mic_devices` | commands for the last two (read) |
| Presets in memory | `preset.list` (library entries, active, read-only flags, versions) | a **`preset.summary {entry}`** (num modes / strings, key range, output channels, listen mode, declared load params, `output_scale` state, provenance such as `fpga_conversion`, file path, unsaved edits) |
| Presets on disk | none for the assistant (the FE load dialog browses files; see the audit) | **`preset.files`**: the JSON files under the preset roots (`pianoid_middleware/presets/`, `PresetsFromFpga/` …; roots allow-listed in the backend, never a free path), with size, mtime and a cheap header (name, modes, channels, declared settings) |
| Parameters | `param.get` per domain and key range; `stability_ratio` | a **`param.inventory`**: every domain and field with units, range, key space, stored vs effective / derived, Layer-B class (shape vs level), CFL relevance, the registry command that writes it and the doc anchor; generated from a new machine-readable `schemas/params/*.json` (§6.1), which also becomes the long-missing parameter glossary |
| History / jobs / UI | `history.get`, `job.list`, `ui.snapshot` | — |
| Bug reports | none | `bug.list_reports` (§7) |

### 3.2 How the assistant gets it

- **Per-turn digest (exists, dev-0a88):** stays small (about 400–800 tokens): status, audio, level, load, layout, warnings,
  jobs, UI selection. Add one line: environment fingerprint (GPU, build variant, repo SHAs abbreviated) so the model
  notices when the engine changed between turns.
- **On demand:** `system.environment`, `system.health`, `preset.summary`, `preset.files`, `param.inventory {domain?}`. All
  read tier, bounded (≤ 4k tokens per result; long arrays summarised as dev-0a88 does for masks).
- **One composite read**, `system.snapshot`, returns the digest + environment + active preset summary in one call. It is
  the first call of the "full state" runbook entry and of every bug draft (§7).
- **Data rule (D4):** all of it may go to the model; environment values are machine facts, never credentials. The
  env-var read is an **allow-list** in the backend: it never returns `ANTHROPIC_*`, tokens, `PATH` or the user profile.

---

## 4. Requirement 2: standard actions, documented functionality, code

### 4.1 The runbook: a machine-readable registry of standard actions

**Principle.** "Every UI action is a command" (the registry, I4) plus "every standard task is a recipe" (new). The
registry already holds commands with tiers, JSON-Schema args, the wrapped route and a doc anchor. v2 adds two things.

**(a) Command coverage.** Each UI control that changes backend or UI state names its registry command. The structural
guarantee: the frontend reaches the backend through the command bus (`POST /command/<name>` or WS `command`) for every
write, with raw `fetch` / `socket.emit` writes banned outside the bus by a lint rule, so a new UI action cannot ship
without a command. The coverage audit (§4.2) lists what is missing today.

**(b) Recipes.** `schemas/runbook/<area>.json`, validated by the same schema subset as the registry (`_conformance.json`):

```json
{
  "id": "mute.channels.solo",
  "title": "Hear one output channel only",
  "intents": ["hear channel N only", "solo channel", "только канал N"],
  "preconditions": [{"read": "system.health", "expect": "status in [healthy, degraded]"}],
  "steps": [
    {"command": "param.mute_channels", "args": {"channels": "{channels}", "action": "solo"}},
    {"command": "ui.pane.open", "args": {"pane": "SoundChannels"}}
  ],
  "verify": [{"read": "param.get", "args": {"parameter": "feedback_mask", "key_no": "output"}, "expect": "rows for {channels} on, others off"}],
  "undo": "history.undo (one group)",
  "doc": "modules/pianoid-middleware/REST_API.md#mute-operations-dev-0a88",
  "category": "params"
}
```

The first set of recipes comes from the v1 prompt prose and the 2026-10-16 transcripts: keep-settings load + mismatch
report, mute / solo modes, mute / solo / unmute channels, why-no-sound (the dev-0a88 order), A/B a parameter edit (render
before / after with audio off), compare two presets, open-and-zoom views, play a test sequence, undo a turn, collect the
full state.

**Tools:** `runbook.find {text}` (intent match, returns ids + titles), `runbook.get {id}`. The MCP server generates a recipe's
steps from the registry, so a recipe cannot name an unknown command (a load-time check, a CI test).

**How the assistant follows it (prompt + policy):**

1. A request that matches a recipe runs **that recipe exactly** (its steps, then its verify reads). The activity log
   shows the recipe id.
2. No recipe → use registry commands only, and cite the doc anchor of each command (`doc` is in every registry entry).
   Routes outside the registry stay unreachable (the MCP server lists only the registry).
3. Neither covers it → analysis code (§4.3) for computation, never for control (the sandbox cannot reach the backend).
4. A deviation from a recipe (a step skipped or added) is stated in the reply. The service checks it: after a turn
   tagged with a recipe, it compares the executed tool sequence with the recipe and logs a `runbook_deviation` activity
   entry. That is a review signal, not a block.

**Docs:** an MkDocs page generated from `schemas/runbook` (like the registry tables), so the runbook a human reads is
the one the assistant follows.

### 4.2 Coverage audit: UI actions vs registry commands

Method: a read-only audit of the Tunner source (every user-triggerable control with its transport and category; audit
sub-agent, 2026-10-16) against the registry (60 commands on the dev-0a88 branch; master lacks `param.mute_*` and
`preset.load_settings`).

**Main finding: the FE command bus carries few families.** `utils/commandBus.js` (WS `command` with ack, else
`POST /command/<name>`) carries only `preset.*`, `play.note` / `play.mode` / `play.reset` / `play.keyboard`, `render.chart` /
`render.keyboard`, `launcher.assistant.start` and the `ui.*` family. Everything else bypasses it:

| Covered by a command, but sent another way | FE transport today |
|---|---|
| parameter and mask edits (`param.set`) | `usePreset.writeParam` → WS `set_parameter` or REST `/set_parameter/<kind>/<key>` (masks via `emitMaskRows`) |
| volume / feedback / sensitivity fold (`runtime.set`) | WS / REST `set_runtime_parameters` |
| undo / redo (`history.*`) | REST `/history/*` with `UNDO_DOMAINS` (`useBackendUndo.js`) |
| backend / modal adapter start (`launcher.*`) | the legacy `:3001/api/*` routes |

So the UI does not yet make "literally the same call" as the assistant for its most common actions. P3 moves these onto
the bus first; the journal `source` and the undo grouping then match by construction.

**Covered through the bus:** the preset toolbar and Preset pane (reload, switch, save as, add to library, unload, working
copy, promote); keys, Play All online / offline, Modes play; chart windows; all 17 `ui.*` commands (`utils/uiCommands.js`,
relayed by `server/uiControlRelay.js`: 10 commands/s, 10 s timeout).

**Missing** (no command; the P3 list):

| UI area (file) | Route / state | Proposed command | Tier / category |
|---|---|---|---|
| Excitation energy editor (`ExcitationEnergyEditor.jsx`, `useExcitationEnergy.js`) | `POST /excitation_energy` (mass / speed / calibration) | `param.excitation_energy.get/set` | write / `params` |
| Fixed velocity (`useFixVelocity.js`) | `POST /set_fix_velocity`, `GET /get_fix_velocity` | `runtime.fix_velocity.get/set` | write / `runtime` |
| Clipping indicator reset (`AmplitudeIndicators.jsx`, `ToolBar.jsx`) | `POST /clear_limiting` | `level.clear_latch` | act / `playback` |
| MIDI listener (`MidiComponent.jsx`, `useMidiStatus.js`) | `/midi/ports`, `/midi/select_port`, `/midi/start`, `/midi/stop`, `/midi/broadcast` | `midi.ports`, `midi.status`, `midi.select_port`, `midi.start/stop`, `midi.broadcast` | read + act / `playback` |
| Excitation-pane level tools (`Excitation.jsx`) | `/measure_rms`, `/equalize_keyboard`, `/tune_note` | `calibration.measure_rms`, `calibration.equalize_keyboard`, `calibration.tune_note` | destructive (they rewrite levels / tuning) |
| Measurement timing (`MeasurementTimingPanel.jsx`); mic device | `/calibration_params` GET / POST; `/mic_devices`, `/set_mic_device` | `calibration.params.get/set`; `calibration.mic_devices` (read; the mic change stays **excluded**, parent §4.1) | read / write |
| Sound-channel calibration (`CalibrationSubpanel.jsx`) | `:5001 /modal/calibrate_sound_channel` (+ `/confirm`) | `modal.calibrate_sound_channel` | destructive (rig) |
| Modal projects (`useProjectCRUD.js`, `ProjectBrowserDialog.jsx`) | `/modal/projects/*` (create / open / delete / import / export / branch / set_base), `/modal/fs/*` | `modal.project.*` (delete stays **excluded**, parent §4.1) | write / destructive |
| Modal configuration + results | `/modal/mapping`, `/modal/esprit_config`, `/modal/band_presets/*`, chain save + granular chain edits, `/modal/stabilization_diagram`, `/modal/grid_heatmap/*` | `modal.config.*`, `modal.chains.*`, `modal.results.*` | read / write |
| Measurement collection v2 (`/modal/measurements/*`: create, probe, import_folder, synthesize, collect, devices) | about 20 call sites | `modal.measurement.*` | write / destructive (collect drives the rig) |
| Named layouts (`MosaicConfigManager.jsx`, localStorage) | FE-only save / delete / rename | `ui.layout.save`, `ui.layout.delete`, `ui.layout.list` | ui / `layout_save` |
| Pane and app settings (`useSettings.js`, `PaneWithSettings`) | FE-only (localStorage) | `ui.settings.get/set` | ui |
| Free chart zoom (ECharts dataZoom) | FE-only | `ui.chart.zoom {pane, axis, range}` (today only select + tie) | ui |
| Preset export / download (`PresetConfigBar.jsx`) | FE-only download | `preset.export {entry}` → an artefact (§4.3), not a browser download | read |
| Bug dialog (`BugReportDialog.jsx`) | FE-only download | `ui.bug_report.collect` (§7) | read |
| Chart pop-out windows (`newWindowChart.jsx`) | a new browser window | none (out of scope: the assistant drives the leader tab) | — |
| ASIO device and session | `GET /audio/devices`, `POST /audio/session` (no FE caller; the FE also never calls MIDI-file playback, `play.stats`, `render.note_playback`, `job.*`, `history.get`) | `audio.devices` (read), `audio.session` (destructive, hard-confirm), the D-h test tone | read / destructive |
| Excitation mode (hammer / bow) | `/get_excitation_mode`, `/set_excitation_mode` | `param.excitation_mode.get/set` | write / `params` |
| Calibration pane (`CalibrationPanel.jsx`, `CurveEditor.jsx`) | `/set_reference`, `/reference`, `POST /precision_profile`, `/calibration_curve/*` (apply / follow / flat / revert / load / save / RCM), Excitation-pane `/save_reference` | `calibration.reference.*`, `calibration.precision_profile`, `calibration.curve.*` | read / destructive |
| Sound-channel calibration batch | `/modal/calibrate_sound_channel/batch` (+ `/batch/status`) | `modal.calibrate_sound_channel_batch` (a job) | destructive |
| Modal FRF and modal-mass runs, deletes | `/modal/run_frf`, `/modal/run_modal_mass`, `DELETE /modal/modal_mass` | more `modal.run_stage` stages; `modal.results.delete` | destructive |
| Collection controls | `/collect/{start,status,cancel}`, `/unlock`, `/setup_test`, section `PATCH`, `/devices`, `/validate` | `modal.measurement.collect.*` | destructive (rig) |
| Synth chip, chart actions, capture | `POST /start_test {action_type}`, `POST /capture` | `render.action`, `render.capture` | act |
| Pause / resume synthesis | `/pause_synthesis`, `/resume_synthesis` | `play.pause` / `play.resume` | act |
| Stop sweep | FE only (no backend stop) | `play.keyboard_stop` (needs a backend stop route) | act |
| Kill stale (`BackendStatusIndicator.jsx`) | `:3001/api/kill-stale` | stays **excluded** (process kill) | — |
| Named load-settings configs, auto-load toggle (`PresetConfigBar.jsx`) | localStorage `presetLoadConfigs` + JSON export / import | `preset.load_configs.*` | ui |
| View toggles: clear selection, autoscale, orientation, audibility view, matrix rotate, show all levels, MatrixTools tool state, pane refresh, mode-ruler / derived workbenches | FE | `ui.select.clear`, `ui.view.set {pane, option, value}`, `ui.pane.refresh`, more `ui.workbench.open` kinds | ui |
| Global settings: pitch numbering, workbench placement, log scale | localStorage `uiPreferences` | `ui.settings.*` | ui |
| Global settings: amplitude gate, crash-guard ceiling | `set_runtime_parameters {amplitude_gate_enabled, amplitude_limit}` | stays **excluded** for the assistant (parent §4.1) | excluded |
| Hotkeys (`useHotkeys.js`: Space play, Ctrl+Z / Y, arrows, +/- volume, Shift +/- feedback, [ ] preset, Esc reset) | the same handlers | each hotkey maps to its command (no new command) | — |
| Assistant chat protocol, tab takeover, remote-control Allow / Stop | WS `:3002/ws`, FE | none: the user's own controls, never assistant tools | — |

Excluded on purpose (parent §4.1, unchanged): `/shutdown`, `/api/stop-backend`, `/debug/audio_fault`, project delete, the
gate / amplitude limit, the mic device change.

### 4.3 Code execution: the sandbox

This is the big security item. D1 decided "no file / exec tools". v2 replaces that with "**no general** file / exec
tools, plus one narrow analysis tool in an OS sandbox".

#### Threat model

| | |
|---|---|
| **Assets** | the assistant's own OAuth credentials (`claude-home\.credentials.json`; a stolen token is the user's subscription); the user's `~/.claude` (credentials, MCP tokens, memory); the repos (source, unpublished presets, the Elyashev / FPGA third-party data); `D:\modal_measurements`; the running engine (the hearing and speakers at the end of the audio chain); the machine (persistence, startup items) |
| **Injection sources** | web pages (high: anyone writes them); preset metadata and names, FPGA conversion notes, measurement project names (medium: third-party files); bug reports and logs (medium: they quote user text and tracebacks); docs (low: repo-reviewed, but long and old); the user's own pasted text (trusted) |
| **What injected text can make the model do** | write code that reads files, opens sockets, spawns processes, calls `:5000` / `:3001` / `:3002` directly (bypassing the policy and the envelope), loops forever, fills the disk, or prints secrets into the chat; put data into a WebFetch URL (exfiltration) |
| **Design rule** | the "lethal trifecta" (private data + untrusted content + an outbound channel) must never meet in one unconfirmed step: the sandbox has no network, web content taints the turn (§8), and filing / publishing is always confirmed |

#### Options

| | (A) Agent SDK `Bash` + sandbox settings / permission hook | (B) custom `analysis.run_python` MCP tool, OS-sandboxed executor (**recommended**) | (C) container (Docker / WSL2) executor |
|---|---|---|---|
| Surface for the model | a full shell; policy = parse the command line in `canUseTool` / a PreToolUse hook | one tool: `{code, inputs: [artefact ids], timeout_s}` | the same tool as (B), a different executor |
| Isolation on Windows | **none: the SDK sandbox does not work on native Windows** (Agent SDK sandboxing docs: it "runs commands unsandboxed"; it covers only Bash / PowerShell, for macOS / Linux / WSL2). What is left is a command-string filter in `canUseTool` / a PreToolUse hook: whack-a-mole (`python -c`, PowerShell encodings) | AppContainer (no network capability, file access only to granted folders) + a Job Object (memory, CPU time, one process, kill on close) | strong (namespaces, `--network none`, read-only mounts) |
| Dependencies | none | a small native launcher (Python `ctypes` or a Node addon) + an analysis venv | Docker Desktop or a WSL2 distro on every installation; a collaborator's machine may not have it |
| Fits D1 (minimal seal break) | no | yes | yes |
| Verdict | **reject** (decisive: no OS sandbox on native Windows) | **recommend**, with a P5 spike to prove the AppContainer launcher | the fallback if the AppContainer spike fails; also the Linux path (bubblewrap / a container) |

#### The recommended design (B)

- **Tool:** `analysis.run_python {code, inputs[], timeout_s ≤ 300, memory_mb ≤ 2048}` in a new in-process SDK MCP server
  `analysis` (the service runs it; the model never gets Bash). An in-process MCP tool runs **unsandboxed inside the service
  process** (SDK custom-tools docs), so the handler never evaluates the code: it only writes `code.py` and spawns the separate
  sandboxed process below. `disallowedTools` also denies `Bash` / `PowerShell` in every mode, and a PreToolUse hook (it can deny
  even in bypass mode) re-checks every `analysis` call against the policy. Category `code` (§9). It returns `{exit, stdout (≤ 20 kB, truncated
  with a marker), stderr (≤ 8 kB), files: [{name, kind, size, artefact_id}], elapsed_s}`.
- **Workspace:** `%USERPROFILE%\.pianoid-assistant\analysis\` with `artifacts\` (inputs, read-only to the run) and
  `runs\<run_id>\` (`code.py`, `in\` = hard links / copies of the requested artefacts, `out\`, the cwd). It sits outside
  every repo and outside `claude-home\` (the credentials).
- **Interpreter:** a **separate analysis venv** `%USERPROFILE%\.pianoid-assistant\analysis\venv` with numpy, scipy,
  matplotlib (Agg backend), soundfile. **Not** the PianoidCore venv: that one has CuPy, the engine wheels and write access
  to the repos. No CUDA (`CUDA_VISIBLE_DEVICES` empty; CuPy not installed): the GPU belongs to the engine.
- **Process:** `python -I -B code.py` (isolated mode: no user site, no cwd on `sys.path`) under:
  - an **AppContainer** profile `pianoid.analysis`: no capabilities (so no network, including localhost `:5000` / `:3001`
    / `:3002`), file ACL grants only on `runs\<run_id>\` (read / write) and `artifacts\` + the venv (read); every other
    path (repos, `~/.claude`, `claude-home`, `D:\modal_measurements`) is denied by the container's identity, not by a
    path filter;
  - a **Job Object**: job memory limit (default 2 GB), CPU time limit (= `timeout_s`), active process limit 1 (no child
    processes), kill-on-job-close, plus a wall-clock timer in the service;
  - an environment built from an allow-list (no `ANTHROPIC_*`, no `PIANOID_*`, `HOME` = the run dir);
  - output caps: `out\` ≤ 20 files, ≤ 5 MB each, ≤ 20 MB per run; the workspace is pruned to the newest 200 runs.
- **Defence in depth (not a boundary):** a `sitecustomize`-style audit hook in the venv that refuses `socket.*`,
  `subprocess.*`, `os.system`, `ctypes` loads and `open()` outside the run dir. It catches mistakes and naive injected code;
  the AppContainer is the boundary.
- **Results in the pane:** stdout as text, PNG files as images in the activity card, `.npy` / `.json` outputs become new
  artefacts the next run can read.

#### How code gets signals: the artefact store

The model never passes paths. It passes artefact ids, and only the service (the MCP server) creates artefacts:

| Source | How it becomes an artefact | Constraint |
|---|---|---|
| Offline render (`render.note_playback`, `render.chart` sound types, `render.keyboard`) | an `export: true` arg on the render tools: the MCP server decodes the result it already receives (`audio_data` base64 WAV, `data` arrays) into `artifacts\<id>.npy` / `.wav` + `meta.json` (command, args, preset entry + version, load settings, sample rate, **units = raw engine units before output_scale**) instead of dropping it | R6: renders are refused while live audio runs, so with live audio there is no render artefact (decision V3) |
| ASIO measurement session (`POST /audio/session`, rig) | a new command `audio.session` (destructive tier: it pauses synthesis and drives physical outputs) whose result `data_path` (under the measurements base) is **copied** by the service into an artefact | rig only; hard confirm |
| Parameter data | `param.get` / `preset.summary` results saved as JSON artefacts on request (`export: true`) | bounded by the result size limits |
| Modal pipeline results | the `:5001` result reads (`/modal/results`, `/modal/frf/summary`, …) as artefacts | D4 opt-out switch applies |
| User files | a file dropped on the pane, copied into an artefact | the user's choice |

Example: "compare the spectra of C4 on presets A and B" = recipe `compare.render_spectra`: switch to A → render p60
`export` → switch to B → render p60 `export` → `analysis.run_python` (Welch PSD of both, centroid, partial table, a PNG)
→ the reply cites the numbers and shows the plot. With live audio running, the recipe stops at its precondition and says
why (R6).

#### Approval of code runs

Code runs are category `code`, **Ask by default**. Auto is available only once the escape test suite (P5) passes on that
installation (the pane shows the result), and never in a web-tainted turn (§8). Whether code may ever be Auto is
decision V1.

---

## 5. Requirements 2 and 3: the Opus escalation rules

Today the model escalates itself with `escalate_model {reason}`, and the transcripts show it does not when it should.
v2 routes in three layers. The service owns the model choice; the picker's forced Sonnet / Opus still wins over all of it.

**Layer 1: deterministic pre-routing (before the turn starts).** A pure, unit-tested `router.js` scores the user text
(English and Russian keyword sets) and the context:

| Category | Text signals (examples) | Context signals | Route |
|---|---|---|---|
| physics / prediction | why, what happens if, predict, explain the physics, brighter, darker, warmer, sustain, attack, timbre, inharmonic, ярче, тембр, почему | — | Opus |
| timbre edit | make it / the bass / the treble + a timbre adjective | — | Opus (plan) |
| code / analysis | compare, spectrum, FFT, plot, correlate, analyse the signal, measure, сравни, спектр | artefacts referenced | Opus |
| bug analysis | bug, broken, crash, doesn't work, wrong, ошибка, не работает | `warnings` not empty, a new auto bug report since the last turn, `status` not healthy | Opus |
| comparisons | vs, versus, difference between, A/B | two presets named | Opus |
| multi-step plan | then, after that, for each, in turn, all channels / all pitches, по очереди | — | Opus |
| plain action / read | set, play, open, show, mute, volume, load, what is the active | — | Sonnet |

**Layer 2: tool and failure triggers (during the turn), in `canUseTool`:** the first `analysis.run_python`, the first
`bug.draft`, the researcher sub-agent, and any write while a recipe is not matched escalate the rest of the turn before
the call runs (`query.setModel` then allow). Two consecutive tool errors, or a denied call followed by a retry of the
same intent, escalate too.

**Layer 3: self-escalation** (`escalate_model`, unchanged), for what the rules miss.

**Stickiness and de-escalation:** an Opus turn keeps Opus for the next two turns of the same thread (follow-ups such as
"and the bass?"), then returns to Sonnet. Every routing decision is an activity entry with its rule ("Opus: physics /
prediction (brighter)"). **Test:** a routing corpus built from the 2026-10-16 transcripts and the requirement examples,
`node --test`, no spend. An optional Haiku classifier for the ambiguous middle is decision V9 (it costs a model call per
turn on the subscription).

---

## 6. Requirement 3: physics knowledge and "make it brighter"

### 6.1 What to feed and how

| Layer | Content | Delivery |
|---|---|---|
| **Physics primer** (new, curated, about 6–8k tokens) | the signal chain (excitation → string FDTD → bridge → modes → output pitches / channels); the string PDE and what each term does; the mode oscillator; feedin / feedback coupling and the single-deck matrix; excitation (5 Gaussians, per-velocity levels, impulse conservation); Layer B level (`output_scale`, load-settings key); the CFL bound; the data-model traps (`#data-model-facts`); the measured facts the assistant uses (feedback is damping, raw render units, the R6 render limit) | `docs/guides/ASSISTANT_PHYSICS_PRIMER.md`, served on MkDocs and loaded as a **cached system block** when the turn is on Opus (Sonnet gets a 1k summary), so the model always has the principles without a search |
| **Parameter inventory** | `schemas/params/*.json` (§3.1): field, units, range, key space, stored / derived, level vs shape class, CFL relevance, doc anchor; this is the P0 parameter glossary, finally machine-readable | `param.inventory` + a generated MkDocs page |
| **Timbre map** | §6.2, as `schemas/params/timbre_map.json` with per-row sources and evidence | `timbre.lookup {quality, range?}` + the primer |
| **Retrieval** | the module docs (SYNTHESIS_ENGINE, PARAMETER_SYSTEM, Basic OVERVIEW, MODE_PHYSICS, the loudness / excitation proposals, the test strategy) | `search_docs` upgraded from keyword snippets to BM25 over sections + a new `docs.read {page, anchor}` that returns one whole section (≤ 6k tokens); both read-only |

The primer is written **from the docs** (each statement links its source anchor) and reviewed like code. It is not
generated by the model at run time. Where the docs and the engine disagree, the docs say which is authoritative
(e.g. "the GPU formula is the one used in actual synthesis" for the excitation ReLU).

**Prediction discipline (prompt + recipe `timbre.adjust`):** state the hypothesis with its source and confidence → pick
the smallest edit on a working copy → **A/B it** (audio off: render before / after + `analysis.run_python` metrics such as
the spectral centroid, the decay τ and the attack peak time; live: play it and ask the user to listen) → report the
measured change or "no measurable change" → keep or undo. A row marked UNKNOWN is never presented as known.

### 6.2 The timbre → parameter table (sourced; UNKNOWN where the docs lack support)

Sources: **[TS]** `development/reviews/parameter-sound-test-strategy-2026-07-07.md` (per-group "param → intended effect"),
**[SE]** `modules/pianoid-cuda/SYNTHESIS_ENGINE.md`, **[BO]** `modules/pianoid-basic/OVERVIEW.md`, **[TO]**
`modules/pianoid-tunner/OVERVIEW.md` (feedback semantics), **[EN]** `proposals/excitation-loudness-normalization-correction-2026-06-30.md`,
**[SC]** `development/reviews/sound-channels-panel-flow-and-test-strategy-2026-07-16.md`. "Direction (docs)" means a documented
direction with no measured magnitude for a given preset.

| Request | Parameter (domain.field) | Direction | Confidence | Side effects / checks |
|---|---|---|---|---|
| **brighter** | `hammer.hammer_width` | ↓ (width ↑ → spectral centroid ↓) | direction (docs) [TS] | the rendered width has a floor, so a small width may be inert: read `hammer_width_effective` (REST_API: `max(stored, 1.05·dx)`; Basic OVERVIEW says 3·dx, a doc conflict to resolve) |
| | `gauss.sigma` (excitation pulse width, per velocity level) | ↓ (σ ↑ → wider + duller) | direction (docs) [TS]; a shorter pulse gives a louder transient at the same impulse [EN] | level rises: check clipping; σ ≤ 0 is rejected |
| | `string.frequency_damping` (`disp_decay`, γ_HF) | ↓ (γ_HF ↑ → faster HF decay) | direction (docs) [TS][SE]; dt-scaled since dev-f2b8, so the old iteration variance is fixed [SE] | γ_HF tightens the CFL bound [SE]: lowering it is safe |
| | `mode.decrement` of the high-frequency modes | ↓ (decrement ↑ → that band's τ ↓) | direction (docs) [TS] | longer ringing of those bands |
| | `mode.mass_inv` of the high-frequency modes | ↑ (mass_inv ↑ → louder) | direction (docs) [TS] | level class edit; ≤ 0 rejected |
| | Sound-channel aggregate curve per mode (the SC pane, G2) | raise the high modes | documented UI goal "brighter / quieter per mode" [SC] | per-mode level; `output_scale` may go stale |
| | `hammer.hammer_position` | comb filter: striking at L/n suppresses the n-th partial [TS] | which way is "brighter" for a given key: **UNKNOWN** in the docs (textbook: nearer the end → more upper partials; not measured here) | — |
| | `hammer.hammer_sharpness` | "sharpness → centroid shift" [TS] | direction **UNKNOWN** (TS lists it as needing a one-time measurement) | — |
| | runtime feedback coefficient ↓ | "louder / sharper attack" [TO] | direction (measured, `project_feedback_coeff_is_damping`) | clipping risk at low feedback; stable at all values [TO] |
| **darker / warmer** | the inverse of the rows above | — | as above; "warm" as a separate quality: **UNKNOWN** (no doc defines it) | — |
| **longer sustain** | `string.damping` (γ) | ↓ (γ ↑ → decay τ ↓) | direction (docs) [TS][SE] | CFL invariant in γ [SE] |
| | `mode.decrement` | ↓ | direction (docs) [TS] | — |
| | feedback / `deck_feedback_coefficient` | [TS] names feedback as the sustain path; [TO] calls it a damping coefficient where lower is louder | direction for sustain **UNKNOWN** (the two docs do not give one; needs the A/B the TS P2 tier plans) | — |
| **shorter release / less ring after key-up** | `string.damper_string`; the tail `damper_tail` multiplier | ↑ (damper / tail ↑ → shorter release) | direction (docs) [TS][SE]; stock presets store `damper_tail == damper_string`, so the tail damper is near-inert until set as a multiplier (e.g. 127) [SE] | — |
| **more attack / percussive** | `gauss.sigma` ↓, `gauss.mu` earlier (μ ↑ → peak later) | as stated | direction (docs) [TS][EN] | level rises |
| | lower feedback coefficient | sharper attack [TO] | direction (measured) | clipping |
| **louder / softer (one key or a range)** | excitation calibration / mass / speed (`excitation_energy` family), per-pitch levels | mass ↑ / speed ↑ → louder | direction (docs); ±7–11 dB scatter by curve shape is a known, decided behaviour [TS][EN] | never touch `output_scale` or the gate / limit; global loudness = runtime volume |
| **pitch / tuning** | `string.tension` (f0 ∝ √T), `string.rho` (ρ ↑ → f0 ↓), `string.length` (↑ → pitch ↓, metres) | as stated | direction (docs) [TS][SE] | tension ↑ raises the CFL ratio: check `stability_ratio` first |
| **more metallic / bell-like (inharmonicity)** | `string.r` (B ∝ r⁴), `string.jung` (E ↑ → B ↑) | ↑ | direction (docs) [TS][SE] | bending stiffness tightens the CFL bound: check `stability_ratio` |
| **chorus / beating (unisons)** | `string.tension_offset` (UI "detuning") | ↑ → beat rate ↑ | direction (docs) [TS] | multi-string pitches only |
| **more body / soundboard resonance** | feedin rows (coupling strength), `mode.mass_inv`, the feedback coefficient | — | **UNKNOWN** as a perceptual claim; the coupling semantics are documented [SE] | mask, don't zero (data-model rule) |
| **channel balance / stereo** | the output rows of `feedback` (strings axis) or `sound_channel` (modes axis), by listen mode | per-channel gain | documented [SE][REST_API] | the listen-mode trap (dev-0a88 defect c) |

**Measured upgrade (P4):** the ParamSoundHarness the test strategy designs (warm-up + discard, before / after vs the ~2.3%
render floor, N ≥ 3) measures direction and magnitude per row on the three fixtures, audio off. Each row gains
`evidence` (the run) and `magnitude` (e.g. "hammer_width ×0.8 → centroid +x %"). Until then the assistant says
"direction per the docs, size unknown, let me A/B it".

---

## 7. Requirement 4: identifying and filing bugs

> **USER DECISION 2026-10-17:** the assistant **NEVER files bugs to GitHub**. Bugs go only to the native Pianoid
> bug-report system: the backend collector `POST /bug_report`, the same store as the 🐞 / auto-fire reports. GitHub
> filing, the PAT and decisions V4 / V5 are removed from this plan.

**Where issues go.** One destination:

1. **The native collector (always).** `POST /bug_report` (exists; the FE auto-fire already uses it) gets a new trigger kind
   `assistant`: `bugreport-<time>-assistant-<kind>-<hex>.json` in `PianoidCore/logs/reports/`. It is local, it is what the
   orchestrator and dev agents already consume, and it needs no credentials. The assistant does this **without asking**
   (category `bug_local`, Auto by default): it is a local file, the same as the FE auto-fire.
**When a bug is identified.** The trigger set, checked by the service, not left to the model's judgment alone:

| Signal | Example | Draft |
|---|---|---|
| a tool answered 5xx or a traceback | dev-0a88 defect l (a wrong-length mask row → 500) | automatic draft |
| a write's read-back does not match | `param.set` → `param.get` differs (not a clamp the docs describe) | automatic draft |
| a new FE auto-fire report during the turn | `backend_crashed`, `endpoint_unresponsive` | linked to the existing report (no new one) |
| a documented invariant fails | a `state_changed` that never reached the editor, a recipe's verify step failing | automatic draft |
| the model concludes "app bug" | the user describes broken behaviour and the reads confirm it | the model calls `bug.draft` |

Not a bug: the user's own settings (all channels muted is the user's state, not a defect: dev-0a88), an R6 deny, an
envelope deny. The prompt and the draft template ask "user state, environment, or app bug?" with the evidence for the
choice.

**Auto-attached context** (the draft builder, not the model, assembles it): `system.snapshot` (digest + environment +
preset summary + repo SHAs); the failing tool call(s) with args and the response (bounded); the last 30 activity entries
of the session; the FE report JSON (a new `ui.bug_report.collect` command runs the existing `bugReport.js` builder in the
leader tab: ring buffer of 200 actions, config, runtime); the matching auto-fire report ids; the user's words.

**De-duplication.** A fingerprint = hash(kind, command, HTTP status, error code / exception type, component). Before
drafting: (1) the local collector index (`bug.list_reports`, fingerprints of the last 500 reports); (2) `docs/development/KNOWN_BUGS.md`
headings. A match → "known: report X". Many identical auto-fires (269 reports here, mostly `endpoint_unresponsive`) collapse into
one draft with a count.

**Data rule.** Reports stay on the machine (`PianoidCore/logs/reports/`), so D4 applies as for the model: no
extra stripping is needed, since nothing is published.

---

## 8. Requirement 5: web search

**Tools.** The Agent SDK's built-in WebSearch and WebFetch. SDK facts (code.claude.com/docs/en/agent-sdk + tools-reference):
`tools: [...]` selects which built-ins exist; `WebFetch(domain:…)` allow / deny rules work; WebSearch has **no operator domain
allow-list**, and its availability under claude.ai subscription auth through the SDK is **not documented**. The first P7 task
measures it in the isolated home (if unavailable: WebFetch on an allow-listed search front end, decision V6), and verifies that
the rules apply through `allowedTools` / `disallowedTools` with `settingSources: []`. The tools are **not** given to the main
assistant. A **researcher
sub-agent** (the SDK `agents` option; a sub-agent carries its own `tools` and `model: 'opus'`, SDK subagents docs) holds exactly `WebSearch`, `WebFetch` and `search_docs`, no Pianoid tools,
no code. The main assistant calls it with a question and gets a summary with source URLs. Injected text in a web page
can then at most bias a summary; it cannot call a Pianoid tool, run code or file anything in the same context.

**Rules (enforced in `canUseTool` for the sub-agent's calls):**

- **D4 extended to queries:** a query must not carry project data (preset names, file paths, parameter arrays, numbers
  longer than a few digits, the names of third-party sources such as Elyashev) unless a pane switch "Allow project data
  in web queries" is on (default **off**). The check is a pure filter in `policy.js`; a blocked query is returned to the
  sub-agent with the reason.
- **URL provenance:** WebFetch may open only a URL that appeared in a WebSearch result of this session or in the user's
  own message. That closes the main exfiltration path (data encoded into a URL the model builds).
- **Taint:** any turn in which the researcher returned web content is **tainted**. In a tainted turn every write, code
  run, preset load and bug filing asks for confirmation, even in an Auto category (§9). The pane marks the turn.
- **Labelling:** the researcher's summary reaches the main model inside a `<web_research>` block labelled untrusted data,
  like the per-turn context.
- **Approval:** category `web`, Auto by default for searches (they publish only a query that passed the D4 filter);
  WebFetch follows the same category. Decision V6.

---

## 9. Requirement 6: per-category auto-approve

**Categories** (a new `approval_category` field on every registry command and v2 tool; the policy maps tier +
category → decision):

| Category | Commands / tools | Default | Can be Auto? |
|---|---|---|---|
| `view` | `ui.*`, reads | Auto (as today) | yes (fixed) |
| `playback` | `play.*`, MIDI file | Auto (as today) | yes |
| `renders` | `render.*` (with audio off; R6 deny stays) | Auto (D3) | yes |
| `params` | `param.set`, `param.mute_*`, excitation / hammer routes | **Ask** | yes, **inside the A2 envelope** + the post-write level check with auto-revert (D3); outside the envelope it asks anyway |
| `runtime` | `runtime.set` (volume, feedback slider) | Ask | yes, inside the envelope (volume +6 levels per step, feedback bounds) |
| `preset_nav` | `preset.switch`, `preset.spawn_working_copy`, `preset.load_to_library` | Ask | yes |
| `history` | `history.undo` / `redo` | Ask | yes |
| `layout_save` | named-layout save (new command) | Ask | yes |
| `code` | `analysis.run_python` | Ask | yes (user, 2026-10-17); P2 / P5 ship it locked Ask (follow-up: unlock the switch) |
| `web` | the researcher (search / fetch) | Auto (searches) | yes |
| `bug_local` | `bug.report_local` (the native `POST /bug_report`) | Auto | yes |

**Hard-confirm list (never Auto, enforced in `policy.js`, a unit test pins it):** `preset.save` over an existing file;
`preset.promote`; `preset.unload` of an entry with unsaved edits; `preset.load` (full reload: it re-initialises the engine);
`calibration.*`; `modal.run_stage` / `modal.apply_to_preset`; `audio.session` and the test tone (rig / physical outputs,
D-h); launcher process control; envelope overrides; anything in a web-tainted turn.
`excluded` stays excluded (`/shutdown`, the gate and the amplitude limit, …).
**CONFIRMED by the user as-is (2026-10-17)** (V8): `code` is not on it; it is Ask by default and may be switched to Auto.

**The pane.** A "Permissions" popover next to the model picker: one row per category with **Ask / Auto**, a "this session
only" option, the hard-confirm list shown greyed with the reason. A confirm dialog gets a checkbox "Don't ask again for
`params`" that flips the category (with "this session" as the default scope, so a permanent change is deliberate).

**Persistence.** The per-installation default lives in the service's `config.json` in the isolated home (the same file
as the model choice and the data opt-out), read and written only by the service. The browser's localStorage is not used
(a persisted browser setting that survives reloads is a known source of "it does not work" reports). Changing a category
is an activity entry, so the transcript shows why a write ran without a dialog.

**Dependency.** Auto for `params` / `runtime` is exactly A2's "execute directly within the envelope" (D3). v2 therefore
absorbs A2: the envelope (`policy.js`, pure, unit-tested), the auto working copy, the grouped-undo UI and the post-write
level check with auto-revert land in P2, before the `params` switch can be set to Auto.

---

## 10. Architecture after v2

```
 Browser (leader tab)            assistant service :3002 (isolated home)                    Flask :5000 / modal :5001 / launcher :3001
 ┌──────────────────────────┐ WS ┌──────────────────────────────────────────────────┐         ┌──────────────────────────────┐
 │ AssistantPane            │◄──►│ router.js (pre-route Sonnet / Opus)              │         │ /command/<name> (registry)   │
 │  chat · activity · Stop  │    │ Agent SDK query()  tools: []  settingSources: [] │  HTTP   │ system.* reads (new)         │
 │  model · usage           │    │  canUseTool → policy.js (categories, envelope,   │────────►│ /bug_report collector        │
 │  Permissions (Ask/Auto)  │    │               hard-confirm, taint, R6, D4)       │         │ :3001 /api/command/ui.* →    │
 │  draft cards · plots     │    │  MCP pianoid (registry + runbook + docs + timbre)│         │   leader tab relay (I5)      │
 └──────────────────────────┘    │  MCP analysis (in-process) ── run_python ──┐     │         └──────────────────────────────┘
                                 │  agent "researcher": WebSearch, WebFetch   │     │
                                 │  bug reports → POST /bug_report (native)   │     │
                                 └────────────────────────────────────────────┼─────┘
                                     AppContainer + Job Object: analysis venv ▼ (no network, runs\<id>\ + artifacts\ only)
```

---

## 11. Phased plan

**P0 is a hard prerequisite:** dev-0a88 merged in all three repos (it is still being revised on its branches today:
R6 and the output-level correction landed after the transcript review). v2 extends its digest, prompt, registry entries
and render shaping; building on master would fork them.

| Phase | Scope | Needs | Verification surface | Effort |
|---|---|---|---|---|
| **P0** | Merge dev-0a88 (Install / Core / Tunner); fix follow-up l (a wrong-length mask row → 400, not a 500 traceback) | — | the dev-0a88 tests + its live re-run table | S (0.5–1 d) |
| **P1 State + escalation** | `system.health`, `system.environment` (env allow-list in Core), `system.snapshot`, `audio.devices`, `midi.*` reads, `preset.summary`, `preset.files` (allow-listed roots); the environment fingerprint in the digest; `router.js` (3 layers, stickiness) + the routing corpus | P0 | pytest for the new routes (no secret in `system.environment`: a planted `ANTHROPIC_API_KEY` / token env var never appears); `node --test` router corpus; live: "what GPU / build / output map is running?" answered from the reads | M (3–4 d) |
| **P2 Approvals + A2** | `approval_category` in the registry; categories + hard-confirm + session / installation scope in `policy.js`; the Permissions popover + the confirm checkbox; the A2 envelope, auto working copy, grouped-undo UI, post-write level check with auto-revert | P0 | `node --test` policy table (hard-confirm can never be Auto); Jest pane; **audio_off `note_playback`**: an Auto `params` edit and the identical manual edit give bit-identical buffers, Undo restores bit-exactly; a level breach auto-reverts | M–L (4–5 d) |
| **P3 Runbook + coverage** | the missing commands from §4.2; `schemas/runbook` + `runbook.find/get` + the deviation log; the generated MkDocs page; the FE "writes only through the bus" lint + a coverage test (every UI write control maps to a registry command) | P0 (P2 for the new write commands' categories) | CI: recipe → registry check; FE lint; live: each first-set recipe run from its intent text through the real runtime, verify steps green | L (5–7 d; the FE bus migration is the bulk) |
| **P4 Physics KB + timbre** | `schemas/params` (the glossary) + `param.inventory`; the physics primer; BM25 `search_docs` + `docs.read`; `timbre_map.json` (§6.2) + `timbre.lookup` + the `timbre.adjust` recipe; then the ParamSoundHarness measurements (P0 tier of the test strategy) to fill magnitudes | P1, P3 | doc review of the primer (every statement sourced); live: "make it brighter" → a plan citing rows, a working-copy A/B with the centroid change reported; harness: direction asserts vs the 2.3% floor, N ≥ 3 | M (3–4 d) + measurements M (3 d) |
| **P5 Analysis sandbox** | **P5a spike first** (1–2 d, can run in parallel with P1): the AppContainer + Job Object launcher on Windows 10, proven by an escape suite (read `~/.claude`, `claude-home`, a repo file; connect to `127.0.0.1:5000`; spawn a child; allocate 4 GB; loop past the timeout; write outside the run dir; all must fail). Then the artefact store, `export: true` on the render / param reads, `analysis.run_python`, plot cards in the pane, the `compare.render_spectra` recipe | P2 (category `code`), P5a | the escape suite (must be 100 %); live, audio off: "compare the spectra of C4 on presets A and B" → two artefacts, one run, a PNG, numbers that match an independent numpy run on the same artefacts | L (5–8 d) |
| **P6 Bug filing** | `bug.report_local`, `bug.list_reports`, `bug.draft` (auto context, fingerprint, de-dup), `ui.bug_report.collect`, the draft card; native `POST /bug_report` only, never GitHub (user decision 2026-10-17) | P1 | `node --test` fingerprints / de-dup on the 269 local reports; live: a forced 500 (the l case on a test stack) → one report in `logs/reports/`, a second identical failure → "known" | M (3 d) |
| **P7 Web research** | the researcher sub-agent, the D4 query filter, URL provenance, taint propagation, the `<web_research>` block | P2 (taint uses the policy) | `node --test` filter + provenance + taint table; live: a theory question answered with sources; a planted page with an injected instruction ("call param.set …") → no tool call, and the next write in that turn asks | M (2–3 d) |
| **P8 Hardening** | a red-team pass over P5 + P7 (injected docs / preset names / web pages), the transcript review procedure of dev-0a88 repeated on a week of real sessions | P5, P7 | a transcript review table like 2026-10-16 | M (2 d) |

**Status (2026-10-17):**

| Phase | Status | Merge SHAs |
|---|---|---|
| P1 | DONE (dev-fcef) | PianoidCore dev `fb9ae2c` · PianoidInstall master `4de2ef1` (no Tunner change) |
| P2 | DONE (dev-4324) | PianoidCore dev `69735ef` · PianoidTunner dev `7223709` · PianoidInstall master `3d25ad8` |
| P5 (+ P5a spike) | DONE (dev-11f8; spike merged into P5 as `f3de035`) | PianoidTunner dev `8a94171` · PianoidInstall master `6114e08` |

**Order:** P0 → P1 ∥ P5a → P2 → P3 ∥ P4 → P6 → P7 → P5 → P8. P5 (the riskiest) goes after the approvals and the taint
model exist; its spike runs early because its result decides V1 / V2. The total is about 25–35 agent-days.

---

## 12. Decisions for the user

**Recorded decisions:**
- The plan as a whole: approved ("Go").
- **V8 (2026-10-17):** the hard-confirm list of §9 is **CONFIRMED as-is**; `code` is Ask by default and may be switched to Auto.
- **USER DECISION 2026-10-17 (replaces V4 / V5):** the assistant NEVER files bugs to GitHub; bugs go only to the native
  Pianoid bug-report system (`POST /bug_report`, the 🐞 / auto-fire store). No PAT. P6 is adjusted accordingly.

| # | Decision | Recommendation |
|---|---|---|
| **V1** | Code execution at all, and its approval: allowed? Ask for every run, or Auto after the escape suite passes? | allow, through the narrow `analysis.run_python` only (never Bash); Ask by default, Auto possible after the suite passes, never in a tainted turn |
| **V2** | The executor: native Windows AppContainer + Job Object, or a container (Docker Desktop / WSL2) required on every installation? And a separate analysis venv (numpy / scipy / matplotlib / soundfile, about 150 MB)? | AppContainer (no new dependency for collaborators; the SDK sandbox is not an option on native Windows), container as the fallback if the P5a spike fails; yes to the separate venv |
| **V3** | Signals while live audio runs: renders are refused live (R6). Accept "analysis of renders needs audio off", or fund engine work for a render that does not stop realtime playback (feasibility **UNKNOWN**, not evaluated by dev-0a88), or use rig recordings (`audio.session`) only? | accept for now; investigate the non-stopping render as a separate engine task |
| **V6** | Web: a researcher sub-agent with no Pianoid tools (recommended) vs web tools on the main assistant; URL provenance; the D4 switch extended to web queries (default off) | sub-agent + provenance + query filter off by default; if WebSearch turns out unavailable on the subscription (undocumented), accept WebFetch on an allow-listed search front end |
| **V7** | The approval categories and their defaults (§9); scope of "Don't ask again" (session vs installation) | as in §9; session as the default scope |
| **V8** | The hard-confirm list (§9): add or remove items? In particular `preset.load` (full reload) and `code` | as in §9 (full reload hard-confirm; code not hard-confirm but Ask by default) |
| **V9** | Escalation: deterministic rules + tool / failure triggers + self-escalation only, or also a Haiku classifier per turn (a model call per turn on the subscription)? Stickiness of 2 turns? | rules + triggers + self-escalation; no classifier; stickiness 2 |
| **V10** | The runbook scope: recipes in `schemas/runbook` (code-reviewed JSON, a generated docs page), and the FE refactor that sends every write through the command bus (the bulk of P3) | yes to both; the bus migration is the only structural guarantee that every UI action is a command |
| **V11** | Timbre magnitudes: run the ParamSoundHarness measurement campaign (P4, about 3 d, audio off) before the assistant quantifies timbre changes? | yes; until then it states directions only and A/Bs each edit |
| **V12** | Carried over from dev-0a88: D-h (a test tone through `audio.session`, hard-confirm, rig-verified) and D-c (`solo` / `unmute` rewrite a channel row whole, clearing its per-mode mutes) | D-h yes, in P3 as a recipe + command; D-c keep (whole-row) and say so in the recipe |
| **V13** | Environment exposure: the env-var allow-list in §3.1, machine paths and the repo SHAs to the model (D4 allows it) | as listed; never credentials or `PATH` |
| **V14** | Auto for `params` requires the A2 envelope + post-write level check with auto-revert (D3). Confirm that v2 absorbs A2 in P2, and that the envelope limits of the parent proposal §4.3 stand | yes |

---

## 13. Bookkeeping

- **Defects / gaps noted (not edited):** the parameter glossary planned as P0 of the parent proposal was never written
  (`docs/guides/PARAMETER_GLOSSARY.md` does not exist), and §6.1 replaces it with `schemas/params`. `GET /health` is consumed
  by the digest but is not a registry command. `gh` is not installed on this machine.
  The hammer width floor differs between the docs: Basic OVERVIEW says 3·dx, REST_API `hammer_width_effective = max(stored,
  1.05·dx)` (the latter is the engine's reported value).
- **UNKNOWN (needs measurement, not inference):** the feedback coefficient's direction for sustain; hammer position and
  sharpness → brightness for a given key; "warm" and "body" as perceptual targets; the feasibility of a render that does not
  stop realtime playback.
- **High-stakes data-model facts this design relies on** all have doc support: the pitch key spaces and the output pitches
  (REST_API Data Model Card), raw render units (design note §8, dev-0a88), the listen-mode channel mute (dev-0a88), the
  stored vs effective hammer width (REST_API), the CFL dependencies (SYNTHESIS_ENGINE).
