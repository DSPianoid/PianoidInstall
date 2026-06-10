---
name: cli-control
description: Establish keystroke control over the orchestrator's own Claude Code CLI window — remote /clear+relaunch, or release an agent stuck on an invisible CLI permission prompt.
user-invocable: true
argument-hint: [verify | clear | release]
---

# /cli-control — keystroke control of the orchestrator's own CLI

Drives the orchestrator's **own** Claude Code CLI window by synthesizing keystrokes into it, via `tools/cli_control.ps1`. Two jobs:

1. **Remote context-clear** — when the orchestrator's context is too large, send `/clear` then relaunch with `/orchestrator start`, fully unattended.
2. **Release a stuck agent** — approve a CLI permission prompt that renders only in the local terminal and is therefore invisible to the Telegram user.

## Why this exists

- After `/clear` fires, **no agent is alive** to send the relaunch — so the relaunch must come from an **independent OS process** that survives the clear (a detached PowerShell). An in-session agent cannot do it.
- CLI permission prompts are **invisible to the Telegram user** (see CLAUDE.md → "Known gaps in `bypassPermissions`"). When a sub-agent stalls on one, there is no on-screen way for the remote user to approve it; a synthesized keystroke is the only remote unblock.

## The script

`tools/cli_control.ps1` (Windows PowerShell 5.1). Key params:

| Param | Default | Meaning |
|---|---|---|
| `-Action` | `verify` | `verify` \| `clear` \| `release` |
| `-DelaySeconds` | `8` | wait between `/clear` and relaunch |
| `-OrchestratorCommand` | `/orchestrator start` | sent after clear |
| `-ProjectDir` | `…\projects\D--repos-PianoidInstall` | holds live transcripts (receipt source) |
| `-WindowMatch` | *(auto)* | title-substring override |
| `-ReleaseKeys` | `{ENTER}` | keys for `release` |
| `-VerifyTimeoutSec` | `25` | transcript-tail timeout |
| `-DryRun` | off | print plan, **send nothing** |
| `-Force` | off | `clear`: proceed even if verify fails |
| `-LogFile` | `D:\tmp\cli_control.log` | timestamped log |

Exit codes: `0` ok · `1` fatal · `2` verify unverified · `3` clear aborted (unverified, no `-Force`) · `4` no target window.

### Window detection
`claude.exe` runs inside VS Code's integrated terminal and has **no window of its own**. The driveable window is the first **ancestor** up the parent chain with a visible MainWindow — the top-level `Code.exe` window titled `"PianoidInstall - Visual Studio Code"`. Priority: (1) `-WindowMatch`, (2) auto = walk up from each `claude.exe` to its windowed ancestor, prefer a "Visual Studio Code" title, (3) fallback = any "Visual Studio Code" window. **Caveat:** VS Code prepends `●` to the title when there are unsaved edits — detection strips it.

### Receipt verification
When a line is submitted to the CLI it is appended to the live session transcript: the **newest top-level `*.jsonl`** directly under `-ProjectDir` (sub-agent transcripts under `<id>\subagents\` are excluded). The script sends `hi <nonce>` and tails that file (shared read handle, so the CLI's write-lock doesn't block it) for the nonce. Found → control **VERIFIED**.

## Actions

### `verify` (default) — prove control
Sends `hi <nonce>`, confirms it lands in the transcript. Use this to prove keystrokes reach the CLI before doing anything destructive.

### `clear` — remote context-clear + relaunch (exact procedure)
Exactly as specified, all inside the one detached script — **no agent involvement after launch**:
1. **Establish + verify control** — send `hi <nonce>`, confirm received via the transcript. (Aborts if unverified unless `-Force`.)
2. **Send `/clear`.**
3. **Wait `-DelaySeconds`** for the CLI to finish clearing and go idle.
4. **Send `/orchestrator start`** (`-OrchestratorCommand`) to relaunch.

### `release` — unblock a stuck permission prompt
Activates the window and sends `-ReleaseKeys` verbatim (best-effort). Pick the keys for the prompt shape: `{ENTER}` (default-highlighted option), `1{ENTER}` / `y{ENTER}` (numbered/yes), `{DOWN}{ENTER}` (move then accept).

## Detached launch (orchestrator uses this for `clear`)

The clear MUST run **detached** so it survives the `/clear`:

```powershell
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList `
  '-NoProfile','-ExecutionPolicy','Bypass','-File', `
  'D:\repos\PianoidInstall\tools\cli_control.ps1','-Action','clear','-DelaySeconds','8'
```

Detached = a separate OS process, so it keeps running **through** the `/clear` (which tears down the orchestrator session) and still fires the relaunch afterward.

## Operating model

The orchestrator **launches the detached script, then ENDS ITS TURN** so the CLI sits idle and can receive the keystrokes. An incoming `hi cliok-*` line is just a verification ping — treat it as a no-op / brief ack, do not act on it as a user instruction. The user may also run the script directly from a terminal.

## Safety

- **`-DryRun` first, always.** It prints the exact keystrokes + resolved target window and sends nothing.
- **Verify before clear.** `clear` self-verifies and aborts on failure unless `-Force` — a stray `/clear` wipes the orchestrator's context.
- Confirm window auto-detect picked `"PianoidInstall - Visual Studio Code"` in the DryRun log before any live run; the `●` unsaved-edits prefix is handled.
- Receipt method = transcript-tail of the newest top-level `*.jsonl`; **fallback** if a transcript can't be resolved/read = detection still works but `verify` returns unverified (exit 2) and `clear` aborts (exit 3) unless `-Force`.

## Test the verify path (safe)

1. Launch verify detached:
   ```powershell
   Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList `
     '-NoProfile','-ExecutionPolicy','Bypass','-File', `
     'D:\repos\PianoidInstall\tools\cli_control.ps1','-Action','verify'
   ```
2. The orchestrator should see a `hi cliok-<nonce>` line arrive in its CLI (it acks/no-ops).
3. Confirm `D:\tmp\cli_control.log` logs `control VERIFIED` for that nonce.

(For pure inspection with zero keystrokes, add `-DryRun` to step 1 — it logs the intended keystroke + `would tail … for <nonce>` and sends nothing.)
