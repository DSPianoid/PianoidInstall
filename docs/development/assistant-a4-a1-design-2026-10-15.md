# Assistant A4 + A1: design note (dev-df3c)

**Date:** 2026-10-15 (rev: D5 = single user per installation, no user management) · **Agent:** dev-df3c · **Implements:** [AI assistant proposal](../proposals/ai-assistant-in-ui-2026-10-13.md) phases **A4** (MCP adapter) and **A1** (the pane), on the
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
