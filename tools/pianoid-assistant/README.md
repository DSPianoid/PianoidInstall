# Pianoid assistant (`@pianoid/assistant`)

The AI assistant of the Pianoid UI (proposal: `docs/proposals/ai-assistant-in-ui-2026-10-13.md`; design:
`docs/development/assistant-a4-a1-design-2026-10-15.md`). Two parts:

| Part | Phase | What |
|---|---|---|
| `mcp/server.js` | A4 | stdio MCP server: every command-registry command (`schemas/commands`) as a tool (`play.note` → `play__note`), tier annotations, `search_docs`; excluded (and opted-out) tools hidden and refused |
| `service/server.js` | A1 | the assistant service on `127.0.0.1:3002` (spawned by the launcher): Claude Code headless through the Claude Agent SDK on the user's **subscription**, in an **isolated Claude home**; the pane protocol over WS `/ws` |
| `policy.js` | A4 / A1 | the permission policy (D3 / D4), called for every tool call |

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

## Policy

One installation = one user (D5: no user management): a collaborator runs Pianoid on their own system or in their own
directory / OS account, with their own assistant home and their own subscription login.

| | |
|---|---|
| read, ui, act (playback, renders), `search_docs` | run |
| write (`param.set`, `runtime.set`, `preset.switch`, `history.*`, …) | confirm (direct within the envelope from A2) |
| destructive (save, promote, full load, unload, calibration, modal jobs) | confirm |
| launcher process control | confirm |
| "Block measurement data" switch on | modal / calibration denied |

Confirms are answered in the pane; Stop interrupts the turn, declines pending confirms and cancels the turn's jobs.

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
