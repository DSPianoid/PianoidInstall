---
name: setup-hostinger-email
description: Set up Hostinger email MCP server for reading and sending emails via IMAP/SMTP.
user-invocable: true
argument-hint: [email@domain.com]
---

# Hostinger Email MCP Setup

Register the Hostinger email MCP server so Claude can read, search, and send emails.

## Prerequisites
- Node.js and npm installed
- A Hostinger email account (email + password)

## Steps

### 0. Ensure npm directory exists
On Windows, npx may fail if the npm directory doesn't exist:
```bash
mkdir -p "$APPDATA/npm"
```

### 1. Get credentials
If `$ARGUMENTS` contains an email address, use it. Otherwise ask the user for:
- **Email address** (e.g. `user@theirdomain.com`)
- **Password** for that Hostinger email account

### 2. Register the MCP server
Add the server to `~/.claude.json` under the `mcpServers` key:

```json
{
  "hostinger-email": {
    "command": "npx",
    "args": ["mcp-mail-server"],
    "env": {
      "IMAP_HOST": "imap.hostinger.com",
      "IMAP_PORT": "993",
      "IMAP_SECURE": "true",
      "SMTP_HOST": "smtp.hostinger.com",
      "SMTP_PORT": "465",
      "SMTP_SECURE": "true",
      "EMAIL_USER": "<email>",
      "EMAIL_PASS": "<password>"
    }
  }
}
```

Read `~/.claude.json`, find or create the `mcpServers` object, and add/update the `hostinger-email` entry. Be careful not to corrupt the existing JSON.

### 3. Reload VS Code
Tell the user to reload VS Code:
- `Ctrl+Shift+P` > "Developer: Reload Window"
- Then start a new Claude Code chat

### 4. Verify
After reload, the following MCP tools should be available:
- `mcp__hostinger-email__open_mailbox`
- `mcp__hostinger-email__get_message`
- `mcp__hostinger-email__search_by_sender`
- `mcp__hostinger-email__search_by_subject`
- `mcp__hostinger-email__send_email`
- And others (list_mailboxes, get_unseen_messages, reply_to_email, etc.)

## Hostinger IMAP/SMTP reference
| Protocol | Host | Port | Security |
|----------|------|------|----------|
| IMAP | imap.hostinger.com | 993 | SSL |
| SMTP | smtp.hostinger.com | 465 | SSL |

## Troubleshooting
- **MCP tools not appearing**: Reload VS Code and start a new chat.
- **Authentication failed**: Double-check email and password. Test with a direct IMAP connection if possible.
- **npx errors on Windows**: Ensure `%APPDATA%\npm` directory exists (`mkdir -p "$APPDATA/npm"`).
- **npm not found**: Ensure Node.js is installed and `npx` is in PATH.
- **Config location**: Claude Code reads MCP configs from `~/.claude.json`, NOT from `~/.claude/settings.json`.

## Security note
The password is stored in plaintext in `~/.claude.json`. Consider using environment variables for sensitive credentials on shared machines.
