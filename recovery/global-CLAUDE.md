# User-Level Instructions

## Skill Organization

- **User-level skills** (`~/.claude/commands/`): `self-update`, `setup-mcp`, `setup-google-workspace`, `setup-hostinger-email`, `pair-whatsapp`, `project-management` — synced from `~/claude-config` repo via `/self-update`
- **Project-level skills** (each project's `.claude/commands/`): versioned with the project repo, not managed here

## MCP Servers

| Server | Package | Ports |
|--------|---------|-------|
| hostinger-email | `mcp-mail-server` (npx) | IMAP 993 / SMTP 465 |
| whatsapp | `whatsapp-mcp` (uv + Go bridge) | 8080 |
| whatsapp-work | `whatsapp-mcp` (uv + Go bridge) | 8081 |
| google-workspace | `workspace-mcp` (uv tool) | — |

- Config: `~/.claude.json` under `mcpServers`
- WhatsApp bridges must run in separate terminals; re-auth every ~20 days
- After config changes: reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window")

## Config Repo

`~/claude-config` (GitHub: `DSPianoid/claude-config`) — user-level skills, MCP templates, memory files. Run `/self-update` to sync.
