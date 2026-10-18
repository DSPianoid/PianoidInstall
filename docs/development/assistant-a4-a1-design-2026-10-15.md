# Assistant A4 + A1: design note (dev-df3c)

**Date:** 2026-10-15 (rev: D5 = single user per installation, no user management; rev 2026-10-16 dev-0a88: §8 revision from the user transcripts) · **Agent:** dev-df3c · **Implements:** [AI assistant proposal](../proposals/ai-assistant-in-ui-2026-10-13.md) phases **A4** (MCP adapter) and **A1** (the pane), on the
user decisions D1–D7 of 2026-10-15 (recorded in the proposal §9). Builds on the merged infrastructure I0–I5
(command registry, `/command`, jobs, undo, the `ui` family + leader relay).

**Phase shape:** ONE combined Phase 1. With the subscription runtime (D1) the assistant reaches Pianoid only through
the MCP server, so A4 is the tool layer of A1. They share the policy module and ship together. A4 is also usable on
its own (Claude Code / the orchestrator, `.mcp.json` template).

---

## 1. Runtime and isolation (D1)

| Item | Decision |
|---|---|
| Runtime | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` 0.3.301, its bundled Claude Code CLI) in a long-lived streaming-input `query()`. It authenticates with the user's **Claude subscription** login. There is no API key anywhere: the service **refuses to start** if `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set in its environment (the supervisor `cost-safety` pattern), and the child env is built from an allow-list, never `process.env`. |
| Process | `tools/pianoid-assistant/service/server.js` (Node ESM, its own `package.json` + `node_modules`, no new Tunner dependencies), on `127.0.0.1:3002`. The launcher spawns / stops it (`launcher.assistant.start|stop|status`). |
| Isolated Claude home | Root `%USERPROFILE%\.pianoid-assistant\` (override `PIANOID_ASSISTANT_HOME`): `claude-home\` = `CLAUDE_CONFIG_DIR` (credentials, `.claude.json`, sessions, all CLI state), `workspace\` = the session `cwd` (empty; no CLAUDE.md on it or its ancestors), `config.json` = the service settings (users, model choice, data opt-out). The child also gets `HOME` = `USERPROFILE` = the root, so any `~` path resolves inside the isolated home. The root `~/.claude` and `~/.claude.json` are never read or written. |
| Context isolation | `settingSources: []` (no user / project / local settings, no CLAUDE.md), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `strictMcpConfig: true` with exactly one MCP server (`pianoid`), `tools: []` (no built-in tools: no Bash / Read / Edit / Web…), the system prompt as a custom string (no Claude Code preset). So the model cannot reach any file, skill, memory or setting outside its own tool list. |
| Login (one time) | PowerShell: `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.pianoid-assistant\claude-home"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`. The service checks `claude auth status --json` with the isolated env and shows the command in the pane while it is not logged in. Verified: with an empty `CLAUDE_CONFIG_DIR` the CLI reports `loggedIn: false` (credentials live per config dir). **Since dev-dc2a (2026-10-18)** the pane connects in-app: **Connect Claude subscription** -> `POST /auth/login` runs that CLI login in the isolated env, its sign-in URL (captured through a `BROWSER` shim) opens from the pane, a code fallback goes to the CLI's stdin, Disconnect = `claude auth logout` on the isolated home only (README "First-time setup", `service/auth.js`); the PowerShell command stays as the fallback. |

## 2. Models (D2)

Picker: **Auto** (default: Sonnet 5.5; the model may call the in-process tool `escalate_model {reason}` to switch to Opus
5.5 for research / multi-step diagnosis / analysis, shown in the pane), **Sonnet 5.5** (forced), **Opus 5.5** (forced;
escalation is a no-op when forced). Implemented with `query.setModel()`. The current model is shown on every turn.

## 3. MCP server (A4) — `tools/pianoid-assistant/mcp/server.js`

- stdio MCP server, tools generated from the registry files (`schemas/commands`, `$PIANOID_COMMANDS_DIR` or the
  repo-relative path), never from a hand list. Name = command with dots → `__` (`play__note`). Description = title +
  description + units (the registry text) + tier. Input schema = the registry `args` schema.
- Annotations: `readOnlyHint` for tiers read / ui, `destructiveHint` for destructive, `idempotentHint` for read,
  `openWorldHint: false`. `excluded` commands are never listed.
- Execution: backend / modal → `POST :5000/command/<name>`; launcher / ui → `POST :3001/api/command/<name>`, with
  `X-Pianoid-Source: assistant` (or `mcp` when used standalone): the journal, the undo history and the activity log keep
  the existing source label.
- Extra tool `search_docs {query}`: a keyword index over `docs/**/*.md` sections built at start; returns section titles,
  snippets and `http://localhost:8001/...#anchor` links.
- Excluded tools (and, with the data opt-out, the modal / calibration tools) are not listed and are refused (defence in
  depth; the service policy is the primary gate).
- Standalone (Claude Code / orchestrator): `.mcp.json` template; destructive tools are confirmed by Claude Code's own
  permission prompt (MCP tool permission), not by elicitation.

## 4. Policy (D3, D4) — `tools/pianoid-assistant/policy.js` (pure, unit-tested)

`decide({command, tier, family, settings}) → allow | confirm | deny(reason)`, called from the SDK `canUseTool` for every
tool call (never in the prompt). One installation = one user (D5), so these are the owner rules for everyone:

| Tier / command | Decision |
|---|---|
| read, ui, act (`play.*`, `play.reset`, renders) | allow |
| renders (`render.*`) | allow — D3: renders run freely (the registry tier moves from destructive to act) |
| write (`param.set`, `runtime.set`, `preset.switch`, `preset.spawn_working_copy`, `history.*`, `preset.load_to_library`) | **confirm until A2** (the envelope and the post-write level check with auto-revert are A2; D3's "execute directly within the envelope" starts then) |
| destructive: `preset.save` (save over a file), `preset.promote`, `preset.load` (full reload), `preset.unload`, `calibration.*`, `modal.run_stage`, `modal.apply_to_preset` | confirm |
| launcher process control (`launcher.*` except status) | confirm |
| data opt-out ON (D4, default OFF) | modal / calibration tools denied ("measurement data opted out") |

A confirm is a dialog in the pane naming the command and its args; deny → the model is told why. Stop interrupts
the turn (`query.interrupt()`), denies pending confirms and cancels running jobs started this turn (`job.cancel`).

## 5. Service and pane (A1)

- **Service** (`service/`): HTTP + WS `/ws` for the pane. Pane → service: `turn {text}`, `stop`, `confirm {id,
  allow}`, `settings {model, dataOptOut}`. Service → pane: `status` (logged in, model), `delta` /
  `message` (streamed text), `activity` (tool call + decision + result summary), `confirm` requests, `usage` (the SDK
  `rate_limit_event` status / utilization / reset and the result's token totals; no caps, D7), `error`. Changing the
  data opt-out restarts the session (the MCP server is spawned with it).
- **Per-turn context:** before each user turn the service prepends a compact snapshot (`ui.snapshot` via the relay +
  `/health` digest + running jobs) as a labelled data block.
- **System prompt** (`service/prompt.js`): tiers and confirms, the data-model facts of proposal §4.2, "use the ui tools
  to show what you talk about".
- **Driver seam:** `drivers/sdk.js` (real) and `drivers/fake.js` (scripted, zero spend: plays a script of tool calls
  through the SAME MCP server and policy path), selected by `PIANOID_ASSISTANT_DRIVER=fake`.
- **Pane** (Tunner `components/Assistant/AssistantPane.jsx` + `hooks/useAssistant.js`, pane id `Assistant`): model
  picker + current-model badge (escalations shown), usage indicator, chat, activity log, confirm
  dialog, Stop, data opt-out switch, login banner with the exact command, "Start assistant" when the service is down.
- **Single user (D5):** one installation = one user = one isolated assistant home. A collaborator runs Pianoid on their
  own system or in their own directory / OS account and logs the assistant in with their own subscription. There is no
  user selector, no role and no per-user label.

## 6. Verification

| What | Surface | Pass |
|---|---|---|
| Policy | `node --test` | the table of §4 + opt-out |
| MCP server | `node --test` with the MCP SDK client over stdio against a fake `:5000` / `:3001` | tools = registry minus excluded, annotations per tier, `__` names, opt-out filtering, a call becomes `POST /command/<name>` with the source header, search_docs |
| Isolation | `node --test` + the real bundled CLI | the child env holds no `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR` / `HOME` / `USERPROFILE` = the isolated root, cwd outside the repo; `claude auth status` in that env does not see the root login; SDK options: `tools: []`, `settingSources: []`, `strictMcpConfig`, one MCP server |
| Service + fake driver | `node --test` | a scripted turn → activity, confirm round trip, opt-out deny, escalation, Stop |
| Pane | Jest | render, user / model switch messages, confirm dialog, login banner |
| Live | chrome-devtools, real UI, after the user's one-time login | "open Modes and Feedin side by side and zoom modes 0–40" → screenshot; "why no sound" with the backend up; a played note shows in `/playback_stats`; a confirm for a destructive command; the assistant cannot read `~/.claude` (no file tools listed) |

## 7. Results (Phase 1, live on the real subscription runtime, 2026-10-16)

Isolated agent stack (launcher :3012, backend :5012 audio_off, CRA :3005 with the port-rewrite initScript; the user's
own browser tab kept auto-loading against `:5000`, so the standard ports were avoided), one automation page, the
assistant home logged in by the user (claude.ai Max).

| Check | Result | Evidence |
|---|---|---|
| Panes / zoom | PASS — "Modes maximized, selection 0–40, zoomed": `ui.select.mode_range [0,40]` + `ui.chart.tie Modes` + `ui.pane.maximize Modes`, all `allow` | `logs/dev-df3c-live-01`, `-02` |
| "Why no sound?" | PASS — read-only diagnosis through `runtime.get`, `play.stats`, `launcher.status`, `preset.list` (+ the per-turn health context): healthy engine, 0 events played, volume 64, feedback 1.0, limiter off, SDL3 fallback | `-03` |
| Confirm on a write | PASS — `param.set mode 5 frequency` (same value) raised the dialog with the args; Allow → `POST /command/param.set` 200, value unchanged, no undo step (no-op) | `-04` |
| No file tools | PASS — the runtime's own init lists 61 tools: 60 `mcp__pianoid__*` + `mcp__assistant__escalate_model`, no built-ins; MCP servers `pianoid` (dynamic) + `assistant` (sdk); asked to read `~/.claude/CLAUDE.md` it answers it has no file access and no skills | `-05` |
| Usage indicator | PASS — `rate_limit_event`: seven_day 59 % `allowed_warning` (chip shows it), five_hour 2 %; per-turn tokens | `-07` |
| Sonnet default / Opus | PASS — default Sonnet 5.5; self-escalation on a research prompt switched to Opus 5.5 (badge) and back after the turn; forced Opus in the picker → turn on Opus (`modelUsage` gained `claude-opus-5-5`), Auto → Sonnet | `-06`, `-07` |

Defects found and fixed on the branch: the assistant could close / hide its own chat pane (a remote
`ui.pane.close Assistant` is now refused, 409 `assistant_pane_protected`, and the prompt says to keep the chat
visible); replies quoted raw tool ids (prompt: plain words). Added for evidence: `/status` carries the runtime's init
tool list and each turn's `modelsUsed`.

## 8. Revision from the user transcripts (dev-0a88, 2026-10-16)

The user's first real session (11:59–12:23 UTC, F15 presets) failed on 9 of 11 requests. The per-request review and
the defect list a–l are in [the transcript review](assistant-transcript-review-2026-10-16.md). Changes:

| Layer | Change |
|---|---|
| Core (`pianoid_middleware`) | `/load_preset`: an omitted load setting keeps the live engine's value on every path (`load_settings.py`; `inherited_load_params` in the response). `GET /load_settings`. `POST /mute/modes` and `POST /mute/channels` (`mute_ops.py`): whole-row mask writes through the choke point, one undo group; the channel mask follows the listen mode. [REST_API](../modules/pianoid-middleware/REST_API.md#mute-operations-dev-0a88) |
| Registry | `param.mute_modes`, `param.mute_channels` (write), `preset.load_settings` (read); `preset.load` text: omitted settings are kept |
| Service | `service/contextDigest.js` (pure): `audio {requested, active, fallback}`, `level` (clipping, peak, limiter, gate trips, slider, deck_feedback_coefficient, output_scale state), `load` (settings, declared, mismatches), `layout` (num_modes, listen mode, channel mask), the UI snapshot without the layout tree, `warnings`. Activity results matched by tool-use id; a blank line between text blocks around tool calls |
| MCP | render results: per-series `{samples, peak_abs, rms, all_zero}` (raw units, before output_scale), no base64 / samples; long 0/1 rows → `{mask_length, on, off}` |
| Prompt | mask shapes + the mute commands; channel mask by listen mode; keep-settings loads + mismatch report; fallback / clipping / stale-level reading; why-no-sound order (incl. mode masks); raw render units; offer only what the tools can do; open the pane that shows a change (SC shows channel mutes on both axes; Feedback is disabled in single-matrix mode); plain text, no markdown; no guessed causes |
| Tunner | `PitchesModesMatrixCanvas`: a preset with another key range loaded outside the tab (REST / the assistant) crashed the whole UI (`matrix[col]` undefined). Reproduced live. The draw now skips a matrix that does not cover the range |

**Live re-run** (isolated stack: launcher :3012, CRA :3013, assistant :3014, backend :5012 from the worktrees, audio off,
`listen_to_modes` 0, the user's d2 / si8 / 512 / volume 127 settings; the real subscription runtime in the isolated home; one
automation page; confirms answered Allow by a WS client, as the user's click):

| User request (as typed) | Before (transcript) | After |
|---|---|---|
| lower the volume | OK | OK: one confirmed `runtime.set 64 → 48` |
| load preset F15_measured_plywood_2026-10-15 (keep settings) | 400; guessed 48 kHz / 2000 iterations | `preset.load {path}` → 200 full reload, `inherited_load_params` = the user's settings. It reported "string_iterations 8 vs 16, sound_derivative_order 2 vs 1" and offered the declared reload |
| Mute all modes except 0 and 1 | 3 failed writes, nothing muted | one `param.mute_modes {modes: [0, 1], action: solo}` → `GET feedin_mask/60` on = [0, 1] of 196; `feedback_mask` 21..108 all `[0, 1]`; the Feedin pane shows the dark cells |
| I want to hear channel 0 only / channel 2 only | `sound_channel_mask` (no-op) | `param.mute_channels {channels: [0], action: solo}` → axis strings, `feedback_mask` 128..134, `channels_on [0]`; it opened Sound Channels itself: channels 1–6 columns dark (`logs/dev-0a88-live-01-channel0-solo-mode01-solo.png`) |
| No, just unmute all | no-op | `{channels: all, action: unmute}` → `GET feedback_mask/output` every row 196 / 196 ones |
| Why is there no sound? | "ASIO fallback", render "real content", volume blamed | every check with its value: load mismatch, slider 48 + coefficient 1.0 (normal), channels on, **modes 2–195 muted on p60** (found), 0 events pushed, render not silent (raw units), `audio_on` 0 named. No fallback claim (`logs/dev-0a88-live-02-assistant-pane.png`) |
| send 200Hz to all channels in turn, 5 s each | honest refusal | honest refusal + a feasible plan (G3 ≈ 196 Hz, solo each channel in turn) |

**Measured fact used by the render shaping:** the `note_playback` samples are raw engine units before `output_scale`. p60 v100 raw peak is
1.2e-4 on BaselinePreset1 (output_scale 6.1e12) and 1.6e-8 on F15_measured_plywood at its declared d1 / si16 (output_scale 3.6e15).
1.5e-9 at d2 / si8 (output_scale 3.46e16) is not silence. A raw peak in dB is meaningless across presets. Only all-zero is silent.

**R6 (bug triage 2026-10-16): renders are refused while live audio runs.** At 15:19:27 the user's assistant ran `render.note_playback`. The route stops realtime playback and renders offline inside the live engine (3.2 s), so the FE auto-reported `backend_crashed`. Offline rendering in the live realtime + ASIO backend is a known page-fault risk. Chosen option: the **deny** (safe) one. `policy.decide` denies every `render.*` when `settings.liveAudio`. The service computes it per render call: `/health.backend_thread_running` and `/load_settings.settings.audio_on == 1`, and an unreachable backend counts as live (fail closed). The model is told why and judges the level from the context instead. A render still runs with audio off (agent / test stacks). The render route stops playback by design (the triage evidence). I did not evaluate a render that does not stop playback, which would be engine work. Standalone MCP use (Claude Code) is not gated: there the user's own permission prompt confirms. **Revised 2026-10-18 (§11):** with live audio the stop / render / restart renders ask instead of being denied, and reads are never gated.

**Output level and muted channels in the context (corrected 2026-10-16).** The output is NOT limited. `MainKernel.cu` (W5-A comment at the stem output write, about line 618) writes it UNLIMITED: the dev-d52b soft-limiter was removed. The `Sint32` cast saturates at the INT32 rail, so a peak above full scale is hard clipping ([SYNTHESIS_ENGINE: Output-clipping telemetry (dev-538e)](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md)). The `/health` `limiting` / `limiting_info.gain_reduction_db` are host-side telemetry: `backendServer._gain_reduction_db` computes from the peak what a limiter would apply, and no stage attenuates. The user's latched figure (-72 dB, peak 8.67e12 = 4040 × full scale) therefore means massive hard clipping and distortion, not silence. The digest carries `level.over_full_scale {peak_x_full_scale, db_over, channel}`, and the warning says "far above full scale → hard clipping; check the load mismatch and output_scale". The silence measured by inv-silent-measured was all `feedback_mask` output rows 128..134 at 0 (the user's own Sound Channels edits; history `feedback_mask [128..134] (fe)`). Every turn now reads `GET feedback_mask/output` (strings axis). `layout.channels_on / channels_muted` and a first-class "EVERY output channel is muted" warning point the assistant at it. An earlier version of this revision (b23cf1b) wrongly called the -72 dB "near-silent"; that is corrected in the same branch.

**Not reproduced:** the user's "completely mute" itself. With audio off there is no live output to observe. The offline render at the user's
settings is not silent, and the user's context showed `limiting: true` with no clipping field (the old digest did not carry it).
The new warnings put clipping / limiter / gate / stale level in front of the model the next time it happens live.

**Decisions for the user:**
- **D-h test tone:** no engine change is needed. The ASIO `POST /audio/session` `mode: play` already plays a signal on chosen physical
  outputs (synthesis paused). Proposal: a command `audio.test_tone {freq_hz, seconds, outputs | channels in turn, level_dbfs}` with the
  sine made server-side, confirm-gated. It can only be verified on the rig. Not built.
- **D-c solo semantics:** `solo` / `unmute` write a channel row whole, which clears that channel's per-mode mutes. The alternative is to
  only mute the other channels.

**Follow-ups:** a wrong-length `param.set` mask row answers 500 with a traceback instead of a 400 (l). The dev-branch launcher's
`killProcessesOnPort(5012)` matches `:5012` as a substring of ephemeral ports. On this run it killed the user's `:5000` backend
(fixed on the unmerged dev-7bb0 branch). After a non-FE load, the Preset pane's "CURRENT PRESET" still names the previous file.
`tests/unit/test_start_right_away_binary.py` fails 4/5 on dev (the fail-fast reads the preset path relative to the cwd, and the exact-body
asserts predate `load_param_warnings`).

## 9. Assistant v2 P1: state reads and the model router (dev-fcef, 2026-10-16)

Implements phase P1 of the assistant v2 proposal (`docs/proposals/assistant-v2-2026-10-16.md`, Install branch `feature/plan-assistant-v2`) §3 and §5 (user approval
2026-10-16 19:23Z), plus follow-up l.

| Layer | Change |
|---|---|
| Core | `system_routes.py` + `system_state.py`: `GET /system/environment`, `/system/snapshot`, `/preset/files`, `/preset/summary`, `/param/inventory`, all `read_only`. The env read is an allow-list (no `ANTHROPIC_*`, tokens, `PATH`, profile; paths outside the repos redacted). [REST_API](../modules/pianoid-middleware/REST_API.md#system-state-reads-assistant-v2-p1) |
| Core | follow-up l: `mask_rows.py`: a malformed `feedin_mask` / `feedback_mask` write answers `400 invalid_mask_row` before anything is written. Measured in session 2c86b530: these writes answered **416** with a traceback, not 500 as §8 said |
| Registry | family `system` (`system.health`, `system.environment`, `system.snapshot`, `audio.devices`), `midi.ports`, `midi.broadcast_state`, `preset.summary`, `preset.files`, `param.inventory` (all read) |
| Inventory | `schemas/params/*.json`: 24 domains, 77 fields, every value from the docs, `UNKNOWN` where they are silent (12 fields), 9 doc conflicts listed in `_index.json` |
| Service | `service/router.js` (pure): layer 1 EN + RU pre-route + a crashed-engine context signal, layer 2 triggers (heavy tools, a retry of a refused command, 2 consecutive tool errors), layer 3 `escalate_model`; sticky for 2 turns; each decision is a `model route` activity entry. Digest: `environment` fingerprint (GPU, build, repo branch@SHA, output map; re-read at most every 30 s). Prompt: the new reads |

**Conservative choices** (the proposal left them open): only a crashed engine routes to Opus from the context, not
`warnings` (the F15 session had a load-mismatch warning on every turn). The "write without a matching recipe" trigger
waits for the runbook (P3). "No sound" counts as a complaint only when phrased as one. `midi.status` is
`midi.broadcast_state` (the listener state is in `midi.ports`). `PresetsFromFpga/` is not a preset root (it has no
loadable JSON).

**Tests:** Core `tests/unit/test_system_state.py`, `test_mask_rows.py`; assistant `test/router.test.js` with
`test/routing-corpus.json` (57 cases: 24 transcript turns, 19 requirement examples, 14 Russian), `mcp.test.js`
(state reads listed read-only and allowed), `contextDigest.test.js`, `service.test.js` (stickiness end to end).

**Live check (2026-10-17, isolated stack).** Launcher :3012, CRA :3013 (port-rewrite initScript incl. :3002 → :3014,
isolated browser context), backend :5012 from the worktree, assistant :3014. The real subscription runtime ran in the
isolated home, Auto picker. F15_measured_plywood at its declared settings, `audio_on` 0, no notes played. Confirms were
declined by the WS client. Evidence: `logs/dev-fcef-live-01-assistant-activity-routing.png` (the activity log with the
`model route` entries).

| Turn (as typed) | Route | Reads | Answer |
|---|---|---|---|
| What's my environment? GPU, driver, build, and which code versions are running. | Sonnet: plain action / read | `system.environment` | RTX 4090 24 GB, driver 565.90 / CUDA 12.7, release `.pyd` built 2026-10-15 17:04 UTC, Pianoid 0.1.15, both repos' branch@SHA clean, output map unset = identity |
| What is my output map? | Sonnet | (from the context fingerprint) | unset → identity (channel k → output k), ASIO callback only, 7 channels none muted, set via `PIANOID_AUDIO_OUTPUT_MAP` before the backend starts |
| Which presets do I have? | Sonnet | `preset.files`, `preset.list` | the files grouped by family with modes / strings / channels / listen axis, the non-presets named, the 2 library entries (original read-only + active working copy) |
| Make the sound brighter. Only tell me your plan ... | **Opus: timbre edit** | `param.inventory` (hammer, mode, excitation, gauss), `param.get hammer 60` | a plan led by hammer width ↓ (docs), A/B renders, level recalibration; sharpness left alone because its direction is UNKNOWN in the docs |
| And the bass? | **Opus: sticky 1 of 2** | `param.get hammer 21..40` | bass widths 0.036 to 0.087 m with an outlier at key 27 |
| ok, lower the volume a little | **Opus: sticky 2 of 2** | `runtime.set` → confirm declined | volume still 64, nothing changed |
| Open the Feedin pane | Sonnet: plain action / read | `ui.pane.open` | the pane was already open |
| Почему нет звука? Ноты не играй и ничего не меняй. | **Opus: bug analysis ("нет звука")** | `system.health`, `midi.ports`, `play.stats`, `param.get` masks, `audio.devices`, `runtime.get` | every check with its value; 0 events played; the MIDI listener is off (`listen_to_midi` 0) |

Follow-up l on the live route: the three session cases (a 3-value row plus a placeholder key, 198 values, one row
for an 88-pitch range) each answered `400 invalid_mask_row` with the pitches, through `/command/param.set` and the
direct route. `GET feedin_mask/all` was byte-identical before and after. A correct same-value row write answered 200,
and the masks stayed unchanged.

Result sizes measured via `/command` on F15: `system.snapshot` 7.2 kB, `preset.files` 11.7 kB, the `param.inventory`
overview 13.1 kB, `system.health` 3.2 kB. All are under about 4k tokens.

**Gap found (not fixed; needs measurement):** asked why there is no sound with `audio_on` 0, the assistant reported
`audio_on` 0 while the ASIO driver is active and said it does not know what that means. The current docs do not
define what `audio_on` 0 does to the live output. An archived note (orchestrator-session-state 2026-05-01) records
that `audio_on` 0 still leaves `audio_driver_active` true. A digest warning would need that behaviour measured on the
rig first, so none was added.

## 10. Assistant v2 P2: approvals and the A2 envelope (dev-4324, 2026-10-17)

Implements phase P2 of the assistant v2 proposal (§9, Install branch `feature/plan-assistant-v2`) with the A2 envelope of
the [parent proposal §4.3](../proposals/ai-assistant-in-ui-2026-10-13.md#43-safety-model-for-direct-execution) (D3: the
post-write level check with auto-revert is ON). User approval 2026-10-17 13:48Z.

| Layer | Change |
|---|---|
| Registry | `approval_category` on every command (`view` 39, `playback` 9, `renders` 3, `params` 3, `runtime` 1, `preset_nav` 3, `history` 2, `hard_confirm` 11, `excluded` 3); `history.undo` / `redo` take an optional `group` |
| Inventory | `envelope` entries in `schemas/params`: `runtime.volume` (up at most +6 per step), `runtime.feedback_coeff` (x1.5 per step both ways, at most x2.0 of the stored baseline), `mode.decrement` (cut at most 50%, never < 0), the mask domains (mute / solo / unmute commands); `_index.json` `envelope`: 128 keys per command, 20 Auto writes per turn, the level-breach rule, and the list of what is NOT in the envelope |
| Core | `POST /history/undo` / `redo` `{group}` = only the latest group with that `X-Pianoid-Group` id (the linear check still applies); `GET /history` adds `undo_groups` / `redo_groups` ([REST_API](../modules/pianoid-middleware/REST_API.md#undo--redo-ssot-i3)) |
| Policy (`policy.js`, pure) | excluded → opt-out → R6 → web-tainted turn (hard) → the hard-confirm list (hard) → category Ask (the dialog may offer "Don't ask again") → category Auto: `params` / `runtime` only with an envelope verdict ok (else a hard confirm = an envelope override), the rest allow |
| `approvals.js` (pure) | the 11 categories of §9 with defaults; effective = session ?? installation ?? default; fixed: `view` (Auto), `code` (Ask until the sandbox escape suite passes, V1), `hard_confirm`, `excluded` |
| `envelope.js` (pure) | the checks against `before` values the service reads first (`GET /get_runtime_parameters`, `/health` `stored_feedback_coeff`, `GET /get_parameter/mode/<key_no>`), the revert plan, `levelBreach(before, after)` |
| Service | `service/autoWrite.js`: the MCP server spawned by the service sends every call to `POST /internal/command/<name>` (JSON only, no `Origin`), which runs it only with a permit the policy just left; each `params` / `runtime` write carries its own group `assistant-<tag>-t<turn>-w<n>` (one action = one undo group); an Auto write is followed by a level check (settle 1.2 s, then a 15 s watch); a breach reverts it (`POST /history/undo {group}`, or a `runtime.set` of the values read before: runtime is not in the backend history). The tool result carries `assistant {auto, group, level_check | auto_reverted, reason}`; a later revert reaches the next turn as `assistant_notes`. WS: `approvals`, `undo {groupId}`, `undo_turn {turn}`, `confirm {remember}` |
| Pane | Permissions popover (shield icon: one Ask / Auto row per category, "Save for this installation / this session only", fixed rows disabled with the reason, the hard-confirm list greyed), the `Auto: …` chip while an Ask-by-default category is Auto, "Don't ask again for <category>" + scope on the confirm dialog (not on a hard confirm), Undo per applied action and `reverted: <why>` in the activity log |

**Level breach** (REST_API `/health`, dev-538e): `clipping_now`; `clipping` newly latched; `gate_trip_count` grew; or the
latched `peak_level` newly above `output_scale.target_dbfs` + 3 dB. An unreadable `/health` decides nothing.

**Conservative choices (documented, not asked):**
- Only limits the docs give are in the envelope. String edits (needs a prospective CFL ratio, not available), hammer /
  gauss / excitation, raw feedin / feedback / sound_channel rows, `mode.frequency` / `mass_inv`, `runtime.feedback` (the
  level mapping is auto-detected by value), `store_feedback_coeff`, `volume_center`, `volume_range` stay Ask-only even
  when their category is Auto.
- `mode.decrement` may also rise at most x2 per step (the doc limits only the cut); a mode with decrement 0 asks.
- `feedback_coeff` is bounded both ways (lower feedback is louder, the risk is clipping).
- Mute / solo / unmute are in the envelope (no magnitude; an unmute is covered by the level watch).
- `code` stays Ask (§9: Auto only after the sandbox escape suite, V1); there is no `analysis.run_python` yet. `web`,
  `bug_local`, `layout_save` are categories without commands until P3 / P6 / P7.
- `preset.save` / `preset.unload` always ask (whether the file exists or the entry has edits is not checked);
  `calibration.cancel`, `modal.cancel`, `job.cancel` stay in `playback` (Auto: a cancel must never wait for a dialog).
- The auto working copy of §4.3 is not built: a write to a read-only original answers 409 and the model can spawn a
  working copy (category `preset_nav`).
- The confirm dialog's "Don't ask again" defaults to this session; the popover defaults to this installation (the
  deliberate place for a lasting change).

**Tests:** `test/approvals.test.js` (the policy table on the real registry: the hard-confirm list never Auto with every
category and scope set to Auto; the envelope limits from `schemas/params`; the breach rule; the service end to end with
the fake driver: Auto without a dialog under its own group, outside the envelope asks hard, a hard confirm asks, a level
breach reverts by group and a runtime breach re-sets the value read before, the executor refuses a call without a
permit / with an Origin / non-JSON, the pane Undo, persistence across a service restart); Core
`test_undo_history.py` (group filter) + `tests/integration/test_undo_routes.py` (a `/command` write under
`X-Pianoid-Group`, a later fe edit, `POST /history/undo {group}` reverts only the named group); Jest
`ApprovalsPopover.test.jsx`.

**Live check (2026-10-17, isolated stack).** Launcher :3012, backend :5012 (BaselinePreset1, `audio_on` 0, driver 0,
working copy), CRA :3013 (port-rewrite initScript incl. :3002 → :3014, isolated browser context), the assistant :3014
on the real subscription runtime in its home (its `config.json` backed up before and restored after; `claude-home`
untouched). The assistant's backend URL went through a pass-through proxy (`docs/development/diagnostics/dev-4324-health-breach-proxy.js`)
that, when armed, reports `clipping: true` after a write: a mocked breach with no note played.

| Check | Result | Evidence |
|---|---|---|
| Permissions popover; `params` + `runtime` → Auto (this installation) | `config.json` gained `approvals {params: auto, runtime: auto}`; `Auto: params, runtime` chip | `logs/dev-4324-live-01-permissions-default.png` |
| Auto params without a dialog | "Mute all modes except 0 and 1 (solo them)" → `param.mute_modes` decision `auto`, no dialog; `GET /history` `undo_groups ["assistant-b9c0-t1-w1"]`, label `(assistant)`; `GET feedin_mask/60` on = [0, 1] of 100; the model opened Feedin itself | `-02-auto-params-no-dialog.png` |
| Undo per action | the activity Undo → `POST /history/undo {group}` → feedin_mask/60 sum 100 / 100 again, the group moved to `redo_groups` | activity `reverted · undo (pane)` |
| Hard confirm still asks | "Save the active preset to presets/assistant_p2_test.json" → dialog `preset.save (saves over a preset file)`, "always asks", no checkbox; declined, no file written | `-03-hard-confirm-save.png` |
| Envelope override asks | "Set the volume slider to 100 in one step" (Auto runtime) → dialog `outside the envelope: volume 64 -> 100 (+36; at most +6 per step)`; declined, volume 64; the model did not retry and offered steps of 6 | `-04-envelope-override-asks.png` |
| Level breach → auto-revert | proxy armed; "Raise the volume slider by 4 levels" → `runtime.set {volume: 68}` auto; the next `/health` read clipping (proxy injected 1); `revert … level breach: the output clipped (latched)` → `runtime.set {volume: 64}`; backend `volume_level` 64; the model told the user it was reverted and why | `-05-level-breach-auto-revert.png` |
| Settings persist across a service restart | launcher `assistant/stop` + `start` (new PID, Activity (0)) → the popover still shows `params` / `runtime` Auto, the chip shown | `-06-settings-persist-after-restart.png` |

## 11. Renders during live audio, and bug filing (dev-947d, 2026-10-18)

From the user's session ab7294d3 (2026-10-18 05:58–07:10Z, F15_measured_plywood, ASIO live). R6 (§8) refused
`render.chart_types`, which is a registry read, and every render, so the assistant proposed a full reload with audio
off. The user corrected it: the engine stops, renders and restarts by itself, and the UI's offline Play All does the
same during live audio. The user asked to file both issues as bugs, and the assistant had no filing tool.

**Code proof of the restart path (Core dev 15896da).**

| Route | Sequence | Gap found |
|---|---|---|
| `/get_chart_test` (class `transient` → `engine_busy`) → chart functions | `_stop_online_engine` (`stop_playback` + `endMainLoop`), render under `cuda_lock`, `_restart_online_engine` (the backend `_restart_realtime_thread` hook re-spawns the realtime thread) | `note_playback` returned on a render exception with no restart. Offline `sound_test` restarted only on success. In both cases live audio stayed silent until re-APPLY. **Fixed:** both restart on every path (`tests/unit/test_chart_render_restart.py`, 2 of its 4 tests fail before the fix) |
| `/play_keyboard` offline (`render.keyboard`) | stop → render → restart in `try / finally` | none |
| output_scale calibration (`calibrate_output_scale`) | refuses to render while `shouldContinue()` / `isRunning()` (REST_API Layer B); `/recalibrate_output_level` stops → renders → restarts | not reachable through `render.*`: `/get_chart_test` looks names up as `chart` / `dynamic_chart` only, so action types (incl. `auto_tune`) answer 416, and no chart function calls `output_level`. The 0xC0000006 incident (2026-06-26) was a calibration render at preset switch with the engine **not** stopped |

**Policy (R6 revised).**
- Read tiers are never gated.
- With live audio, `LIVE_RENDERS` = `render.note_playback`, `render.chart` and `render.keyboard` ask every time, even with
  `renders` on Auto. The reason shown is "live audio pauses for a few seconds: the engine stops, renders offline and
  restarts by itself". The dialog has no "Don't ask again".
- Any other `render.*` with live audio is denied, fail closed. That covers a future calibration-render command.
- A web-tainted turn makes the confirm hard.
- An unreachable backend still counts as live, so the render asks.
- The 2026-10-16 15:19 false `backend_crashed` auto-report predates the R4 fix. `useAutoReport` now confirms a stopped
  thread with a fresh `/health` 8 s later (`CRASH_CONFIRM_MS`) and is suppressed while the engine is busy. A render of
  2–3 s has restarted the thread by then.

**Bug filing (v2 §7, P6 minimal).**
- `bug_report` on the in-process `assistant` server, registry-style name `bug.report`, category `bug_local`, **Ask** by
  default and switchable.
- `service/bugReport.js` attaches the latest `pianoid_context`, the versions, the last 12 chat messages and the last 30
  activity entries.
- The dialog shows the draft as it will be filed. Only that report is POSTed, once, to `POST /bug_report`.
- The collector names the file `-assistant-<kind>-`. `PIANOID_REPORTS_DIR` lets an isolated backend write into the
  main store. Never GitHub.
- The prompt tells the model to offer filing when its reads confirm an app bug or an environment fault.

**The user's two bugs, filed** through this path: an `AssistantSession` with the user's own transcript, context and
activity, confirmed as the user's "File both issues as bugs". The collector was an isolated backend on :5012 (Core
worktree, no preset, no CUDA context) writing into `PianoidCore/logs/reports/`:
- `bugreport-2026-10-18T07-35-18-387Z-assistant-app_bug-1e126e19c4de5b10.json`: renders blocked during live audio.
- `bugreport-2026-10-18T07-35-18-486Z-assistant-app_bug-2830f22348a2b3fb.json`: `render.chart_types` refused as a render.

**Chart auto-scale.** The mode `mass_inv` values (~1e-12) looked like empty bars because the pane's Auto-scale toggle
was off: off freezes the y-axis at an earlier maximum. There is no ui command for it. The toggle is per-pane settings
state in `PianoidTuner.js` (4553 LOC, RED), and the file should not grow without a split plan. So only the prompt
changed: it now says to tell the user to switch the toggle on and to give the values read with `param__get`.

**Measured (isolated :5012, Core worktree 7c6cd6d, BaselinePreset1, `audio_on` 0, driver 0, `start_right_away` 1, no
notes, user stack down).**
- `note_playback` p60 ×3: 200 in 2.46–2.49 s, and `backend_thread_running` was true after each one.
- `/health` polled at 5 Hz during a p48 render: `backend_thread_running` / `main_loop_should_continue` true → **false
  for about 2.5 s** → true. That is the stop → render → restart, observed.
- `/command/render.keyboard` [60, 62]: 200 in 1.30 s, offline, 2175 cycles, and the thread was true after it.
- `/command/render.chart_types`: 200, the registry.
- `/get_chart_test {chartType: "live_play"}` (an action name): **416** `Invalid chart type`, and the thread was unchanged.
  The REST_API "499 for actions" line is corrected.
- The backend log has no traceback.
- Through `AssistantSession.canUseTool` on that backend: `liveAudio` false, and `render.note_playback`,
  `render.chart_types` and `render.keyboard` were all allowed with no dialog.

**Not verified here:** the live-audio render itself (`audio_on` 1 needs the user's terminal approval). The user checks
it in their own session: ask for a note render with live audio, then confirm the dialog. Expected: live audio pauses
for about 2–3 s and comes back, with `/health.backend_thread_running` true after the render.
