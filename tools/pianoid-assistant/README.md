# Pianoid assistant (`@pianoid/assistant`)

The AI assistant of the Pianoid UI (proposal: `docs/proposals/ai-assistant-in-ui-2026-10-13.md`; design:
`docs/development/assistant-a4-a1-design-2026-10-15.md`). Two parts:

| Part | Phase | What |
|---|---|---|
| `mcp/server.js` | A4 | stdio MCP server: every command-registry command (`schemas/commands`) as a tool (`play.note` → `play__note`), tier annotations, `search_docs`; excluded (and opted-out) tools hidden and refused |
| `service/server.js` | A1 | the assistant service on `127.0.0.1:3002` (spawned by the launcher): Claude Code headless through the Claude Agent SDK on the user's **subscription**, in an **isolated Claude home**; the pane protocol over WS `/ws` |
| `policy.js` | A4 / A1 / v2 P2 | the permission policy (D3 / D4, categories, hard-confirm list, envelope verdict), called for every tool call |
| `service/router.js` | v2 P1 | the model router (pure): pre-route, tool / failure triggers, self-escalation, stickiness |
| `approvals.js`, `envelope.js`, `lib/paramLimits.js` | v2 P2 | per-category Ask / Auto (pure); the A2 envelope checks + level-breach rule (pure); the limits read from `schemas/params` |
| `service/autoWrite.js` | v2 P2 | the executor of the service's MCP server: permits, one undo group per action, the post-write level watch and auto-revert |

## Setup

```
cd PianoidInstall/tools/pianoid-assistant
npm install
npm test              # zero spend: policy, MCP server, isolation, service on the fake driver
```

One-time login of the assistant's own Claude home (never `~/.claude`), PowerShell:

```powershell
$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.pianoid-assistant\claude-home"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR
```

The Assistant pane shows this command while the isolated home is not logged in, and a **Start assistant** button
while the service is down (`launcher.assistant.start`).

## Isolation (user decision D1)

- `CLAUDE_CONFIG_DIR` = `%USERPROFILE%\.pianoid-assistant\claude-home` (override the root with
  `PIANOID_ASSISTANT_HOME`); the child's `HOME` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` point inside the root;
  the `cwd` is `...\workspace` (outside every repo). The env is an allow-list: no `ANTHROPIC_*` variable reaches the
  child, and the service refuses to start if `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set (it would bill the
  paid API).
- SDK options: `tools: []` (no built-in tool: no Bash, Read, Edit, Web…), `settingSources: []` (no settings, no
  CLAUDE.md), `strictMcpConfig: true` with only the `pianoid` MCP server and the in-process `escalate_model` tool, a
  custom system prompt (`service/prompt.js`), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Per-turn context: `service/contextDigest.js` builds the `<pianoid_context>` block from `/health`,
  `/get_runtime_parameters`, `/load_settings`, `/preset/list`, `job.list` and `ui.snapshot`: audio (requested / active /
  fallback), level (clipping, limiter, gate trips, output_scale state), load settings vs the preset's declared ones, the
  mode layout and listen mode, and precomputed `warnings` (dev-0a88); since v2 P1 also the `environment`
  fingerprint (GPU, build variant, repo branch@SHA, output map) from `GET /system/environment`, re-read at most every 30 s.
- State reads (v2 P1, registry `system.json` + `preset.summary` / `preset.files` / `param.inventory` / `midi.*`):
  `system__snapshot`, `system__environment`, `system__health`, `audio__devices`, `midi__ports`,
  `midi__broadcast_state`, `preset__summary`, `preset__files`, `param__inventory` (the parameter glossary,
  `schemas/params`). Routes: REST_API.md "System state reads (assistant v2 P1)".

## Model routing (v2 P1)

The service picks the model per turn when the picker is **Auto** (a forced Sonnet / Opus wins over everything):

| Layer | When | Rule (activity entry `model route`) |
|---|---|---|
| 1 pre-route | before the turn | English + Russian keywords: bug analysis, timbre edit, physics / prediction, code / analysis, comparison, multi-step plan → Opus; else Sonnet. Context: a crashed engine (`status` crashed / exception) → Opus |
| 2 triggers | during the turn, before the call | the first `analysis.run_python` / `bug.draft` / web research (later phases); a retry of a denied or declined command; 2 consecutive tool errors |
| 3 self | the model calls `escalate_model` | unchanged |

An Opus turn (any layer) keeps Opus for the next **2** turns (sticky follow-ups do not renew it). Not yet:
"any write without a matching recipe" waits for the runbook (P3). Corpus: `test/routing-corpus.json` (the 2026-10-16
transcripts, the requirement examples, Russian), `test/router.test.js`.

## Policy

One installation = one user (D5: no user management): a collaborator runs Pianoid on their own system or in their own
directory / OS account, with their own assistant home and their own subscription login.

| | |
|---|---|
| reads, ui, `search_docs` (category `view`) | run |
| playback, renders | run (Auto by default; renders refused while live audio runs, R6) |
| `params`, `runtime`, `preset_nav`, `history` | Ask by default; Auto per category. Auto `params` / `runtime` run only inside the A2 envelope, then the level watch with auto-revert |
| the hard-confirm list (save, promote, full load, unload, calibration, modal jobs, launcher start, …) | always confirm (category `hard_confirm`, never Auto) |
| "Block measurement data" switch on | modal / calibration denied |

Every registry command names its `approval_category`; a missing one fails the registry load. The categories are set in
the pane's Permissions popover (per installation in `config.json` `approvals`, or for this session only) and by the
confirm dialog's "Don't ask again" (this session by default). Confirms are answered in the pane; Stop interrupts the
turn, declines pending confirms, drops the turn's permits and cancels the turn's jobs. Details: design note §10.

## Standalone MCP (Claude Code / the orchestrator)

`.mcp.json` entry (Claude Code's own permission prompt confirms each tool):

```json
{
  "mcpServers": {
    "pianoid": {
      "command": "node",
      "args": ["D:/repos/PianoidInstall/tools/pianoid-assistant/mcp/server.js", "--source", "mcp"]
    }
  }
}
```

Environment: `PIANOID_BACKEND_URL` (default `http://127.0.0.1:5000`), `PIANOID_LAUNCHER_URL` (`:3001`),
`PIANOID_COMMANDS_DIR`.

## Drivers

`PIANOID_ASSISTANT_DRIVER=sdk` (default: the real subscription runtime) or `fake` (a scripted, zero-spend driver that
still runs every tool call through the policy and the real MCP server; `PIANOID_ASSISTANT_FAKE_SCRIPT` = a JSON
script).
