---
name: pair-whatsapp
description: Pair a WhatsApp account to the WhatsApp MCP bridge. Run when setting up a new account or re-authenticating after session expiry (~20 days).
user-invocable: true
argument-hint: [personal|work]
---

# WhatsApp Pairing Procedure

Pair a WhatsApp account to one of the two configured bridges. The user may pass `personal` or `work` as $ARGUMENTS to specify which account, or you should ask.

## Account Configuration

| Account | Bridge Directory | Executable | Port | MCP Server |
|---------|-----------------|------------|------|------------|
| personal | `~/whatsapp-mcp/whatsapp-bridge` | `whatsapp-bridge.exe` | 8080 | `~/whatsapp-mcp/whatsapp-mcp-server` |
| work | `~/whatsapp-mcp/whatsapp-bridge-work` | `whatsapp-bridge-work.exe` | 8081 | `~/whatsapp-mcp/whatsapp-mcp-server-work` |

## Prerequisites Check

Before pairing, verify all prerequisites are installed. If any are missing, install them.

### 1. Check Go
```bash
go version
```
If missing: `winget install --id GoLang.Go --accept-source-agreements --accept-package-agreements`

### 2. Check GCC (for CGO)
```bash
export PATH="/c/Users/astri/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:$PATH"
gcc --version
```
If missing: `winget install --id BrechtSanders.WinLibs.POSIX.UCRT --accept-source-agreements --accept-package-agreements`

### 3. Check whatsapp-mcp source
```bash
ls ~/whatsapp-mcp/whatsapp-bridge/main.go
```
If missing, clone and set up:
```bash
git clone https://github.com/lharries/whatsapp-mcp.git ~/whatsapp-mcp
```
Then apply fixes — see "Build/Rebuild" section below.

### 4. Check uv
```bash
where uv.exe
```
Needed for running the Python MCP server.

### 5. Enable CGO
```bash
go env -w CGO_ENABLED=1
```

## Steps

### 1. Determine which account
If `$ARGUMENTS` is empty or unclear, ask the user whether they want to pair `personal` or `work`.

### 2. Clear old session (if re-pairing)
Delete the old store directory so a fresh QR code is generated:
```bash
rm -rf <bridge-directory>/store
```

### 3. Build/Rebuild the bridge (if needed)
Set PATH for Go and GCC:
```bash
export PATH="/c/Users/astri/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:/c/Program Files/Go/bin:$PATH"
```

Update whatsmeow to latest:
```bash
cd <bridge-directory>
go get go.mau.fi/whatsmeow@latest && go mod tidy
```

Apply `context.Background()` fixes to main.go (5 calls):
- `client.Download(...)` → `client.Download(context.Background(), ...)`
- `sqlstore.New(...)` → `sqlstore.New(context.Background(), ...)`
- `container.GetFirstDevice()` → `container.GetFirstDevice(context.Background())`
- `client.GetGroupInfo(jid)` → `client.GetGroupInfo(context.Background(), jid)`
- `client.Store.Contacts.GetContact(jid)` → `client.Store.Contacts.GetContact(context.Background(), jid)`

For the **work** bridge, also change port 8080→8081:
```bash
sed -i 's/startRESTServer(client, messageStore, 8080)/startRESTServer(client, messageStore, 8081)/' main.go
```

Build:
```bash
go build -o <executable-name> main.go
```

### 4. Set up MCP Python server (if missing)
For the work account, copy from personal and change the API port:
```bash
cp -r ~/whatsapp-mcp/whatsapp-mcp-server ~/whatsapp-mcp/whatsapp-mcp-server-work
sed -i 's|http://localhost:8080/api|http://localhost:8081/api|' ~/whatsapp-mcp/whatsapp-mcp-server-work/whatsapp.py
```

### 5. Register in `~/.claude.json` (if not already configured)
Find uv.exe path (`where uv.exe`), then add to `mcpServers`:
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

### 6. Instruct the user to run the bridge
The QR code must render in a real terminal (not in Claude Code output). Tell the user to open a terminal and run:
```
cd <bridge-directory>
.\<executable-name>
```

### 7. Scan QR code
Tell the user:
1. Open **WhatsApp** on your phone
2. Go to **Settings > Linked Devices > Link a Device**
3. **Scan the QR code** displayed in the terminal

### 8. Confirm success
Ask the user to confirm the bridge shows "Connected to WhatsApp" in the terminal.

### 9. Remind about keeping the bridge running
The bridge must stay running in its terminal for the MCP tools to work. Both bridges can run simultaneously for both accounts.

## Troubleshooting
- **"Client outdated (405)"**: Run `go get go.mau.fi/whatsmeow@latest && go mod tidy` in the bridge directory, then rebuild.
- **QR code expired**: Restart the bridge executable to get a new QR code.
- **MCP tools not appearing**: Reload VS Code (`Ctrl+Shift+P` > "Developer: Reload Window") and start a new chat.
- **Bridge crashes on start**: Check that CGO is enabled (`go env CGO_ENABLED` should be `1`) and GCC is in PATH.
- **Build errors about context**: Apply the 5 `context.Background()` fixes listed above.
- **Session expired (~20 days)**: Delete `store/` directory and re-pair with a new QR scan.
