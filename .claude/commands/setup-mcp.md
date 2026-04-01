---
name: setup-mcp
description: Set up all MCP servers (Hostinger email, WhatsApp personal+work, Google Workspace). Installs prerequisites, configures servers, and handles authentication.
user-invocable: true
argument-hint: [all|hostinger|whatsapp|google]
---

# Full MCP Server Setup

Set up one or all MCP servers. The user may pass a server name as `$ARGUMENTS` (`all`, `hostinger`, `whatsapp`, `google`), or ask which ones they want.

## Server Overview

| Server | Package | Prerequisites | Auth |
|--------|---------|---------------|------|
| hostinger-email | `mcp-mail-server` (npx) | Node.js | Email + password |
| whatsapp (personal) | `whatsapp-mcp` (uv + Go bridge) | Go, GCC, uv, Python | QR code scan |
| whatsapp-work | `whatsapp-mcp` (uv + Go bridge) | Go, GCC, uv, Python | QR code scan |
| google-workspace | `workspace-mcp` (uv tool) | Python, uv | Google OAuth |

## Config file

All MCP servers are registered in `~/.claude.json` under the `mcpServers` key. Read the file first, add/update entries, and preserve existing content.

---

## Hostinger Email Setup

### 1. Ensure npm directory exists
```bash
mkdir -p "$APPDATA/npm"
```

### 2. Get credentials from user
- Email address (e.g. `user@theirdomain.com`)
- Password

### 3. Add to `~/.claude.json`
```json
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
```

---

## WhatsApp Setup (both accounts)

### 1. Install Go
```bash
winget install --id GoLang.Go --accept-source-agreements --accept-package-agreements
```

### 2. Install GCC (MinGW-w64 for CGO)
```bash
winget install --id BrechtSanders.WinLibs.POSIX.UCRT --accept-source-agreements --accept-package-agreements
```

### 3. Enable CGO globally
```bash
export PATH="/c/Program Files/Go/bin:$PATH"
go env -w CGO_ENABLED=1
```

### 4. Clone whatsapp-mcp
```bash
git clone https://github.com/lharries/whatsapp-mcp.git ~/whatsapp-mcp
```

### 5. Update whatsmeow and fix context.Background() calls
In `~/whatsapp-mcp/whatsapp-bridge/`:
```bash
go get go.mau.fi/whatsmeow@latest && go mod tidy
```
Then add `context.Background()` as first argument to these 5 calls in `main.go`:
- `client.Download(...)` → `client.Download(context.Background(), ...)`
- `sqlstore.New(...)` → `sqlstore.New(context.Background(), ...)`
- `container.GetFirstDevice()` → `container.GetFirstDevice(context.Background())`
- `client.GetGroupInfo(jid)` → `client.GetGroupInfo(context.Background(), jid)`
- `client.Store.Contacts.GetContact(jid)` → `client.Store.Contacts.GetContact(context.Background(), jid)`

### 6. Build personal bridge
```bash
export PATH="/c/Users/astri/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:/c/Program Files/Go/bin:$PATH"
cd ~/whatsapp-mcp/whatsapp-bridge
go build -o whatsapp-bridge.exe main.go
```

### 7. Create and build work bridge
Copy the personal bridge files, change port 8080→8081 in main.go, and change module name in go.mod:
```bash
cp ~/whatsapp-mcp/whatsapp-bridge/main.go ~/whatsapp-mcp/whatsapp-bridge-work/main.go
cp ~/whatsapp-mcp/whatsapp-bridge/go.mod ~/whatsapp-mcp/whatsapp-bridge-work/go.mod
cp ~/whatsapp-mcp/whatsapp-bridge/go.sum ~/whatsapp-mcp/whatsapp-bridge-work/go.sum
sed -i 's/startRESTServer(client, messageStore, 8080)/startRESTServer(client, messageStore, 8081)/' ~/whatsapp-mcp/whatsapp-bridge-work/main.go
sed -i 's|whatsapp-bridge|whatsapp-bridge-work|' ~/whatsapp-mcp/whatsapp-bridge-work/go.mod
cd ~/whatsapp-mcp/whatsapp-bridge-work
go build -o whatsapp-bridge-work.exe main.go
```

### 8. Set up MCP Python servers
```bash
cp -r ~/whatsapp-mcp/whatsapp-mcp-server ~/whatsapp-mcp/whatsapp-mcp-server-work
sed -i 's|http://localhost:8080/api|http://localhost:8081/api|' ~/whatsapp-mcp/whatsapp-mcp-server-work/whatsapp.py
```

### 9. Find uv.exe path
```bash
where uv.exe
```
Use the actual path found (e.g. `C:\Users\astri\AppData\Local\Programs\Python\Python312\Scripts\uv.exe`).

### 10. Add to `~/.claude.json`
```json
"whatsapp": {
  "command": "<uv-path>",
  "args": ["--directory", "C:\\Users\\astri\\whatsapp-mcp\\whatsapp-mcp-server", "run", "main.py"]
},
"whatsapp-work": {
  "command": "<uv-path>",
  "args": ["--directory", "C:\\Users\\astri\\whatsapp-mcp\\whatsapp-mcp-server-work", "run", "main.py"]
}
```

### 11. Pair WhatsApp accounts
Tell the user to open two separate terminals and run each bridge. They need to scan QR codes with their phones. Use the `/pair-whatsapp` skill for detailed pairing instructions.

---

## Google Workspace Setup (Gmail + Calendar)

### 1. Install workspace-mcp
Find uv.exe path first, then:
```bash
<uv-path> tool install workspace-mcp
```
This installs `workspace-mcp.exe` to `~/.local/bin/`.

### 2. Create Google Cloud OAuth credentials
Guide the user through these steps in the browser:
1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create a new project (e.g. `claude-mcp`)
3. **APIs & Services → Library** → Enable **Gmail API** and **Google Calendar API**
4. **APIs & Services → OAuth consent screen** → External → Fill in app name + emails
5. Add user's Gmail as a **test user** (under Audience/Test Users)
6. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app**
7. Copy **Client ID** and **Client Secret**

### 3. Add to `~/.claude.json`
```json
"google-workspace": {
  "command": "C:\\Users\\astri\\.local\\bin\\workspace-mcp.exe",
  "args": ["--tools", "gmail", "calendar", "--single-user"],
  "env": {
    "GOOGLE_OAUTH_CLIENT_ID": "<client-id>",
    "GOOGLE_OAUTH_CLIENT_SECRET": "<client-secret>",
    "OAUTHLIB_INSECURE_TRANSPORT": "1"
  }
}
```

### 4. Run initial OAuth authentication
Start the server in streamable-http mode to handle the OAuth callback:
```bash
export GOOGLE_OAUTH_CLIENT_ID="<client-id>"
export GOOGLE_OAUTH_CLIENT_SECRET="<client-secret>"
export OAUTHLIB_INSECURE_TRANSPORT=1
workspace-mcp.exe --tools gmail calendar --single-user --transport streamable-http
```
Run this in background, then trigger auth via MCP protocol:
```bash
# Initialize session
SESSION_ID=$(curl -s -D - -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup","version":"1.0"}}}' \
  2>&1 | grep -i "mcp-session-id" | tr -d '\r' | awk '{print $2}')

# Trigger auth - extract the URL from the response and present to user
curl -s -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_google_auth","arguments":{"service_name":"gmail","user_google_email":"<user-email>"}}}'
```
Present the authorization URL to the user as a clickable link. They must:
1. Click the link
2. Sign in with their Google account
3. Click "Continue" past the unverified app warning
4. Grant all permissions

After success, kill the temp server. Credentials are saved to `~/.google_workspace_mcp/credentials/`.

---

## Final Steps

1. Tell the user to **reload VS Code** (`Ctrl+Shift+P` → "Developer: Reload Window")
2. Open a new Claude Code chat
3. Verify each server by making a simple tool call

## Troubleshooting
- **MCP tools not appearing**: Reload VS Code and start a new chat
- **Config location**: Claude Code reads MCP configs ONLY from `~/.claude.json`
- **npm errors**: Ensure `%APPDATA%\npm` directory exists
- **WhatsApp "Client outdated (405)"**: Update whatsmeow: `go get go.mau.fi/whatsmeow@latest && go mod tidy` then rebuild
- **Google "Access blocked"**: Add user's email as a test user in OAuth consent screen
- **Google "Invalid state"**: The auth URL must be generated by the same server process that handles the callback. Always use the MCP protocol method above, not the CLI method.
