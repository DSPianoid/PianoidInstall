<#
.SYNOPSIS
    Give the orchestrator keystroke control over its own Claude Code CLI window.

.DESCRIPTION
    Orchestrator meta-infrastructure. The Claude Code CLI runs as `claude.exe` inside
    VS Code's integrated terminal; the OS window that owns that terminal is the top-level
    `Code.exe` window (title "PianoidInstall - Visual Studio Code"). This script locates
    that window, activates it, and synthesizes keystrokes into it via .NET SendKeys so
    the orchestrator can drive its own CLI without a human at the keyboard.

    TWO use cases:

      (1) REMOTE CONTEXT-CLEAR. The orchestrator's context grows too large. We send
          "/clear", wait a few seconds, then send "/orchestrator start" to relaunch.
          This MUST be done by a DETACHED copy of this script: after "/clear" fires there
          is no agent alive to send the relaunch, so the relaunch has to come from an
          independent OS process that survives the clear. (See the launch line below.)

      (2) RELEASE A STUCK AGENT. A sub-agent is blocked on a CLI permission prompt that
          renders only in the local terminal and is therefore invisible to the Telegram
          user (see CLAUDE.md "Known gaps in bypassPermissions"). We send an approval
          keystroke (default {ENTER}; operator may override with -ReleaseKeys "1{ENTER}",
          "y{ENTER}", "{DOWN}{ENTER}", etc., depending on the prompt shape).

    SAFETY MODEL (read this before running):
      * The target window is the LIVE orchestrator's OWN CLI. A stray "/clear" wipes the
        orchestrator's context. NEVER fire real keystrokes while developing/validating.
      * -DryRun prints the exact intended keystrokes + the resolved target window and
        SENDS NOTHING. Always -DryRun first.
      * -Action clear self-verifies control (sends a unique "hi <nonce>" and confirms it
        landed in the live transcript) BEFORE sending "/clear". If verification fails it
        ABORTS unless -Force is given.

    DETACHED LAUNCH (the form the orchestrator uses for a remote clear -- survives /clear
    because it is a separate OS process):

        Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList `
          '-NoProfile','-ExecutionPolicy','Bypass','-File', `
          'D:\repos\PianoidInstall\tools\cli_control.ps1','-Action','clear','-DelaySeconds','8'

    Receipt verification: when a line is submitted to the CLI it is appended to the live
    session transcript -- the NEWEST top-level *.jsonl directly under -ProjectDir
    (sub-agent transcripts under <id>\subagents\ are EXCLUDED). We tail that file for the
    unique nonce to confirm our keystrokes actually reached the CLI.

.PARAMETER Action
    verify (default) | clear | release.
      verify  -- send "hi <nonce>", confirm it lands in the transcript. Proves control.
      clear   -- verify, then "/clear", wait -DelaySeconds, then -OrchestratorCommand.
      release -- send -ReleaseKeys raw (best-effort approve a stuck permission prompt).

.PARAMETER DelaySeconds
    Seconds to wait between "/clear" and the relaunch command (default 8). The relaunch
    has to wait for the CLI to finish clearing and become idle again.

.PARAMETER OrchestratorCommand
    Command sent after "/clear" to relaunch the orchestrator (default "/orchestrator start").

.PARAMETER ProjectDir
    Directory holding the live session transcripts
    (default "C:\Users\astri\.claude\projects\D--repos-PianoidInstall").

.PARAMETER WindowMatch
    Optional title-substring override for window detection. A leading "* " (the VS Code
    unsaved-changes marker) is stripped before matching.

.PARAMETER ReleaseKeys
    Keys sent for -Action release (default "{ENTER}"). SendKeys syntax.

.PARAMETER VerifyTimeoutSec
    Seconds to poll the transcript for the nonce before giving up (default 25).

.PARAMETER DryRun
    Print intended keystrokes + resolved target and SEND NOTHING. Use this first.

.PARAMETER Force
    For -Action clear: proceed even if verification fails. Dangerous -- only when you are
    certain the window is correct and the transcript path is just stale/unreadable.

.PARAMETER LogFile
    Timestamped log destination (default "D:\tmp\cli_control.log"). Parent dir is created.

.EXAMPLE
    # Safe: prove the verify path without sending anything.
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\cli_control.ps1 -Action verify -DryRun

.EXAMPLE
    # Safe: preview the full clear sequence without sending anything.
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\cli_control.ps1 -Action clear -DryRun

.EXAMPLE
    # LIVE verify (sends "hi <nonce>", tails the transcript). Only when you intend it.
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\cli_control.ps1 -Action verify

.NOTES
    Windows PowerShell 5.1 compatible (no ternary / ?? / ?.). Self-contained: only .NET
    SendKeys, WScript.Shell (AppActivate), and CIM (parent-chain walk). Does not commit.
#>

[CmdletBinding()]
param(
    [ValidateSet('verify', 'clear', 'release')]
    [string]$Action = 'verify',

    [int]$DelaySeconds = 8,

    [string]$OrchestratorCommand = '/orchestrator start',

    [string]$ProjectDir = 'C:\Users\astri\.claude\projects\D--repos-PianoidInstall',

    [string]$WindowMatch = '',

    [string]$ReleaseKeys = '{ENTER}',

    [int]$VerifyTimeoutSec = 25,

    [switch]$DryRun,

    [switch]$Force,

    [string]$LogFile = 'D:\tmp\cli_control.log'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Write-Log {
    param(
        [string]$Message,
        [string]$Level = 'INFO'
    )
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts] [$Level] $Message"
    try {
        $parent = Split-Path -Parent $LogFile
        if ($parent -and -not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch {
        # Logging must never abort the action; fall through to stdout only.
    }
    $color = 'Gray'
    if ($Level -eq 'ERROR')   { $color = 'Red' }
    elseif ($Level -eq 'WARN')  { $color = 'Yellow' }
    elseif ($Level -eq 'DRYRUN') { $color = 'Cyan' }
    elseif ($Level -eq 'OK')     { $color = 'Green' }
    Write-Host $line -ForegroundColor $color
}

# ---------------------------------------------------------------------------
# Window detection -- find the top-level OS window that owns the CLI terminal.
#
# claude.exe runs inside VS Code's integrated terminal and has NO window of its
# own (MainWindowHandle == 0). The window we must drive is the FIRST ancestor up
# the parent chain that has a visible MainWindow -- i.e. the Code.exe top-level
# window hosting the terminal. (This is the inverse of walking DOWN to a child.)
# ---------------------------------------------------------------------------
function Get-TargetWindow {
    # Strip a leading "* " VS Code unsaved-changes marker from a title.
    function Strip-Marker {
        param([string]$Title)
        if ($null -eq $Title) { return '' }
        return ($Title -replace '^\s*●\s*', '').Trim()
    }

    # All top-level windowed processes (have a real MainWindow + a title).
    $windowed = Get-Process | Where-Object {
        $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
    }

    # --- Priority 1: explicit -WindowMatch title substring -------------------
    if (-not [string]::IsNullOrWhiteSpace($WindowMatch)) {
        foreach ($p in $windowed) {
            $clean = Strip-Marker $p.MainWindowTitle
            if ($clean -like "*$WindowMatch*") {
                Write-Log "Window match (-WindowMatch '$WindowMatch'): PID=$($p.Id) title='$clean'"
                return [pscustomobject]@{ PID = $p.Id; Hwnd = $p.MainWindowHandle; Title = $clean }
            }
        }
        Write-Log "-WindowMatch '$WindowMatch' did not match any top-level window; falling back to auto-detect." 'WARN'
    }

    # --- Priority 2: walk UP from each claude.exe to its windowed ancestor ----
    $claudes = @(Get-Process -Name claude -ErrorAction SilentlyContinue)
    $candidates = New-Object System.Collections.Generic.List[object]
    $seenPids = New-Object System.Collections.Generic.HashSet[int]
    foreach ($c in $claudes) {
        $cur = $c.Id
        $depth = 0
        while ($cur -and $depth -lt 10) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
            if (-not $proc) { break }
            $ps = Get-Process -Id $cur -ErrorAction SilentlyContinue
            if ($ps -and $ps.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($ps.MainWindowTitle)) {
                if ($seenPids.Add([int]$ps.Id)) {
                    $clean = Strip-Marker $ps.MainWindowTitle
                    $candidates.Add([pscustomobject]@{ PID = $ps.Id; Hwnd = $ps.MainWindowHandle; Title = $clean })
                }
                break  # first windowed ancestor only
            }
            $cur = [int]$proc.ParentProcessId
            $depth++
        }
    }

    if ($candidates.Count -gt 0) {
        # Prefer a Visual Studio Code window if several claude.exe instances exist.
        $vscode = $candidates | Where-Object { $_.Title -like '*Visual Studio Code*' } | Select-Object -First 1
        $chosen = $vscode
        if (-not $chosen) { $chosen = $candidates[0] }
        Write-Log "Window auto-detect (claude.exe ancestor): PID=$($chosen.PID) title='$($chosen.Title)' (candidates=$($candidates.Count))"
        return $chosen
    }

    # --- Priority 3: any window whose title contains 'Visual Studio Code' -----
    foreach ($p in $windowed) {
        $clean = Strip-Marker $p.MainWindowTitle
        if ($clean -like '*Visual Studio Code*') {
            Write-Log "Window fallback (title contains 'Visual Studio Code'): PID=$($p.Id) title='$clean'" 'WARN'
            return [pscustomobject]@{ PID = $p.Id; Hwnd = $p.MainWindowHandle; Title = $clean }
        }
    }

    Write-Log 'No target window found (no claude.exe ancestor and no Visual Studio Code window).' 'ERROR'
    return $null
}

# ---------------------------------------------------------------------------
# SendKeys metacharacter escaper. The chars + ^ % ~ ( ) { } [ ] are special in
# SendKeys and must each be wrapped in braces to be sent literally.
# ---------------------------------------------------------------------------
function ConvertTo-SendKeysLiteral {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        switch ($ch) {
            '+' { [void]$sb.Append('{+}') }
            '^' { [void]$sb.Append('{^}') }
            '%' { [void]$sb.Append('{%}') }
            '~' { [void]$sb.Append('{~}') }
            '(' { [void]$sb.Append('{(}') }
            ')' { [void]$sb.Append('{)}') }
            '{' { [void]$sb.Append('{{}') }
            '}' { [void]$sb.Append('{}}') }
            '[' { [void]$sb.Append('{[}') }
            ']' { [void]$sb.Append('{]}') }
            default { [void]$sb.Append($ch) }
        }
    }
    return $sb.ToString()
}

# ---------------------------------------------------------------------------
# Activate the target window. Tries AppActivate by PID, then by title.
# ---------------------------------------------------------------------------
function Set-WindowActive {
    param([object]$Target)
    $shell = New-Object -ComObject WScript.Shell
    $activated = $false
    try {
        $activated = [bool]$shell.AppActivate($Target.PID)
    } catch {
        $activated = $false
    }
    if (-not $activated) {
        try {
            $activated = [bool]$shell.AppActivate($Target.Title)
        } catch {
            $activated = $false
        }
    }
    Start-Sleep -Milliseconds 500
    if (-not $activated) {
        Write-Log "AppActivate did not confirm focus for PID=$($Target.PID) title='$($Target.Title)' (continuing anyway)." 'WARN'
    }
    return $activated
}

# ---------------------------------------------------------------------------
# Send one line of text to the CLI: activate, type the (escaped) text, ENTER.
# In -DryRun, prints the plan and sends NOTHING.
# ---------------------------------------------------------------------------
function Send-CliLine {
    param(
        [object]$Target,
        [string]$Text
    )
    $escaped = ConvertTo-SendKeysLiteral $Text
    if ($DryRun) {
        Write-Log "[DRYRUN] -> PID $($Target.PID) '$($Target.Title)': '$Text' + ENTER  (escaped: '$escaped')" 'DRYRUN'
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    [void](Set-WindowActive -Target $Target)
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Write-Log "Sent to PID $($Target.PID): '$Text' + ENTER"
}

# ---------------------------------------------------------------------------
# Send raw SendKeys (no escaping, no trailing ENTER added) -- for -release,
# where -ReleaseKeys already contains the exact key tokens (e.g. "1{ENTER}").
# ---------------------------------------------------------------------------
function Send-RawKeys {
    param(
        [object]$Target,
        [string]$Keys
    )
    if ($DryRun) {
        Write-Log "[DRYRUN] -> PID $($Target.PID) '$($Target.Title)': RAW '$Keys' (no ENTER appended)" 'DRYRUN'
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    [void](Set-WindowActive -Target $Target)
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Write-Log "Sent RAW keys to PID $($Target.PID): '$Keys'"
}

# ---------------------------------------------------------------------------
# Resolve the active session transcript: newest top-level *.jsonl in ProjectDir
# (NOT recursing into <id>\subagents\).
# ---------------------------------------------------------------------------
function Get-ActiveTranscript {
    if (-not (Test-Path -LiteralPath $ProjectDir)) {
        Write-Log "ProjectDir not found: $ProjectDir" 'ERROR'
        return $null
    }
    $f = Get-ChildItem -LiteralPath $ProjectDir -File -Filter *.jsonl -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $f) {
        Write-Log "No top-level *.jsonl transcript in $ProjectDir" 'ERROR'
        return $null
    }
    return $f.FullName
}

# ---------------------------------------------------------------------------
# Read a file that the CLI is actively writing -- use a shared read handle so
# we don't fail on the writer's lock ([IO.File]::ReadAllText can throw on lock).
# ---------------------------------------------------------------------------
function Read-LockedText {
    param([string]$Path)
    try {
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs)
            try {
                return $sr.ReadToEnd()
            } finally {
                $sr.Dispose()
            }
        } finally {
            $fs.Dispose()
        }
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------------------
# Poll the active transcript for the nonce, up to VerifyTimeoutSec.
# ---------------------------------------------------------------------------
function Test-Receipt {
    param([string]$Nonce)
    $transcript = Get-ActiveTranscript
    if (-not $transcript) {
        Write-Log 'Cannot verify receipt: no transcript resolved.' 'ERROR'
        return $false
    }
    Write-Log "Verifying receipt of nonce '$Nonce' in transcript: $transcript"
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $content = Read-LockedText -Path $transcript
        if ($content -and $content.Contains($Nonce)) {
            Write-Log "Nonce '$Nonce' FOUND in transcript -- control VERIFIED." 'OK'
            return $true
        }
        Start-Sleep -Milliseconds 700
    }
    Write-Log "Nonce '$Nonce' NOT found within $VerifyTimeoutSec s -- control UNVERIFIED." 'WARN'
    return $false
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
function Invoke-Verify {
    param([object]$Target)
    $nonce = 'cliok-' + (Get-Random)
    Write-Log "Action=verify  nonce=$nonce  DryRun=$DryRun"
    Send-CliLine -Target $Target -Text "hi $nonce"
    if ($DryRun) {
        $transcript = Get-ActiveTranscript
        Write-Log "[DRYRUN] verify would tail '$transcript' for nonce '$nonce' (up to ${VerifyTimeoutSec}s)." 'DRYRUN'
        return 0
    }
    $ok = Test-Receipt -Nonce $nonce
    if ($ok) {
        Write-Log 'VERIFIED: keystroke control over the CLI is confirmed.' 'OK'
        return 0
    } else {
        Write-Log 'UNVERIFIED: could not confirm keystrokes reached the CLI.' 'WARN'
        return 2
    }
}

function Invoke-Clear {
    param([object]$Target)
    Write-Log "Action=clear  DelaySeconds=$DelaySeconds  OrchestratorCommand='$OrchestratorCommand'  DryRun=$DryRun  Force=$Force"

    # Step 1: establish + verify control (skipped in DryRun -- nothing is sent).
    if (-not $DryRun) {
        $nonce = 'cliok-' + (Get-Random)
        Write-Log "Step 1/4: verifying control before clear  nonce=$nonce"
        Send-CliLine -Target $Target -Text "hi $nonce"
        $ok = Test-Receipt -Nonce $nonce
        if (-not $ok) {
            if ($Force) {
                Write-Log 'Control UNVERIFIED but -Force set -- proceeding with clear anyway.' 'WARN'
            } else {
                Write-Log 'Control NOT verified -- aborting clear (use -Force to override).' 'ERROR'
                return 3
            }
        }
    } else {
        Write-Log '[DRYRUN] Step 1/4: would send "hi <nonce>" and verify receipt before clearing.' 'DRYRUN'
    }

    # Step 2: send /clear
    Write-Log 'Step 2/4: sending /clear'
    Send-CliLine -Target $Target -Text '/clear'

    # Step 3: wait for the CLI to finish clearing and become idle
    if ($DryRun) {
        Write-Log "[DRYRUN] Step 3/4: would Start-Sleep -Seconds $DelaySeconds." 'DRYRUN'
    } else {
        Write-Log "Step 3/4: waiting $DelaySeconds s for the CLI to clear..."
        Start-Sleep -Seconds $DelaySeconds
    }

    # Step 4: relaunch the orchestrator
    Write-Log "Step 4/4: sending relaunch command '$OrchestratorCommand'"
    Send-CliLine -Target $Target -Text $OrchestratorCommand

    Write-Log 'Clear sequence complete.' 'OK'
    return 0
}

function Invoke-Release {
    param([object]$Target)
    Write-Log "Action=release  ReleaseKeys='$ReleaseKeys'  DryRun=$DryRun"
    Send-RawKeys -Target $Target -Keys $ReleaseKeys
    Write-Log 'Release keystroke dispatched (best-effort approval of a stuck prompt).' 'OK'
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$exitCode = 0
try {
    Write-Log '=== cli_control.ps1 start ==='
    Write-Log "Params: Action=$Action DryRun=$DryRun Force=$Force ProjectDir='$ProjectDir' VerifyTimeoutSec=$VerifyTimeoutSec"
    if ($DryRun) { Write-Log 'DRY RUN MODE -- no keystrokes will be sent.' 'DRYRUN' }

    $target = Get-TargetWindow
    if (-not $target) {
        Write-Log 'Exiting: no target window.' 'ERROR'
        exit 4
    }
    Write-Log "Target window: PID=$($target.PID) Hwnd=$($target.Hwnd) Title='$($target.Title)'"

    switch ($Action) {
        'verify'  { $exitCode = Invoke-Verify  -Target $target }
        'clear'   { $exitCode = Invoke-Clear   -Target $target }
        'release' { $exitCode = Invoke-Release -Target $target }
    }
    Write-Log "=== cli_control.ps1 done (exit $exitCode) ==="
} catch {
    Write-Log "FATAL: $($_.Exception.Message)" 'ERROR'
    Write-Log $_.ScriptStackTrace 'ERROR'
    $exitCode = 1
}
exit $exitCode
