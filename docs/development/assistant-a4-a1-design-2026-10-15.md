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
| Login (one time) | PowerShell: `$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.pianoid-assistant\claude-home"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR`. The service checks `claude auth status --json` with the isolated env and shows the command in the pane while it is not logged in. Verified: with an empty `CLAUDE_CONFIG_DIR` the CLI reports `loggedIn: false` (credentials live per config dir). |

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

**R6 (bug triage 2026-10-16): renders are refused while live audio runs.** At 15:19:27 the user's assistant ran `render.note_playback`. The route stops realtime playback and renders offline inside the live engine (3.2 s), so the FE auto-reported `backend_crashed`. Offline rendering in the live realtime + ASIO backend is a known page-fault risk. Chosen option: the **deny** (safe) one. `policy.decide` denies every `render.*` when `settings.liveAudio`. The service computes it per render call: `/health.backend_thread_running` and `/load_settings.settings.audio_on == 1`, and an unreachable backend counts as live (fail closed). The model is told why and judges the level from the context instead. A render still runs with audio off (agent / test stacks). The engine has no path to render without stopping playback, so the non-stopping option does not exist without engine work. Standalone MCP use (Claude Code) is not gated: there the user's own permission prompt confirms.

**Limiter gain reduction in the context.** The triage found the user's reports latched at `limitingInfo {channel 0, gain_reduction -72 dB, peak 8.67e12}` (4000 × full scale). That is the likely "completely mute": the d2 / si8 load with the d1 / si16 output_scale blows the level up, and the limiter turns it down by 72 dB. `level.limiter {gain_reduction_db_now, worst_latched}` now goes into the digest, and a warning fires at <= -20 dB that names the near-silence and its level cause.

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
