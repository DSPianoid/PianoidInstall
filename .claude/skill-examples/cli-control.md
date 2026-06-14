# /cli-control — Pianoid worked examples

Concrete invocations for the **Pianoid** project. The generic `/cli-control` skill body is
project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md#channel`; this companion
holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Detached `clear` launch (the form the orchestrator uses)
```powershell
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList `
  '-NoProfile','-ExecutionPolicy','Bypass','-File', `
  'D:\repos\PianoidInstall\tools\cli_control.ps1','-Action','clear','-DelaySeconds','8'
```

## Detached `verify` launch (safe test)
```powershell
Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList `
  '-NoProfile','-ExecutionPolicy','Bypass','-File', `
  'D:\repos\PianoidInstall\tools\cli_control.ps1','-Action','verify'
```
(For pure inspection with zero keystrokes, add `-DryRun`.)

## Project specifics (from PROJECT_CONFIG.md#channel)
- CLI-control script: `tools/cli_control.ps1` (Windows PowerShell 5.1)
- Editor window to drive: top-level `Code.exe` titled `"PianoidInstall - Visual Studio Code"` (auto-detected; the `●` unsaved-edits prefix is stripped)
- Transcript dir (`-ProjectDir`): `~/.claude/projects/D--repos-PianoidInstall/` (holds the live `*.jsonl` receipts)
- Log file: `D:\tmp\cli_control.log`
