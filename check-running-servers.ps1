# =========================================================================
# check-running-servers.ps1 - detect an already-running Pianoid stack and
# offer to kill & restart it BEFORE launching a fresh one.
#
# Called by start-pianoid.bat early in the pre-launch sequence. It checks
# whether any Pianoid port (3000 React / 3001 launcher / 5000 backend /
# 5001 modal adapter) is in the LISTENING state. If any are, a stack is
# already up; the script offers (pop-up) to kill those listeners and restart,
# or to cancel the launch.
#
# Kill is PORT-TARGETED: only the owning PIDs of the listening Pianoid ports
# are stopped. It NEVER blanket-kills by image name (no `taskkill /IM
# python.exe` / `node.exe`) - that would murder MCP servers and other apps.
#
# Contract (exit codes the .bat interprets):
#   20  -> a stack WAS running AND the user chose Cancel  -> .bat ABORTS launch.
#    0  -> proceed to launch: no stack was up, OR the user chose Kill & restart
#          (the kill has already been performed here), OR ANY best-effort
#          failure (treated as "unknown" -> just launch).
#
# -Auto switch (passed by the .bat when /auto / --no-prompt is set, e.g. the
# desktop shortcut): the desktop-icon user IS present to answer, AND "warn +
# launch alongside" fails (a busy port can't be launched onto), so under -Auto
# we STILL SHOW the Kill & restart / Cancel prompt - but as a TIMED pop-up
# (WScript.Shell.Popup, 30 s). On timeout (truly headless: nobody clicks) the
# SAFE default is taken = do NOT kill, do NOT launch (exit 20) - never kill a
# live stack with nobody watching, and never launch onto a busy port. Bare /
# interactive runs get a normal blocking MessageBox (no timeout).
#
# DESIGN: BEST-EFFORT - must NEVER hang or error the launch. The whole body is
# wrapped so any unexpected failure falls through to exit 0; the -Auto pop-up
# is time-bounded so it cannot hang a headless launch.
#
# See: start-pianoid.bat (the caller), check-updates.ps1 (sibling pre-launch
#      helper, same pattern), docs/guides/STARTUP_TROUBLESHOOTING.md.
# =========================================================================

param(
    [switch] $Auto
)

# Soft error mode: a non-terminating error must not abort the launch.
$ErrorActionPreference = 'SilentlyContinue'

# Pianoid service ports: 3000 React dev server, 3001 launcher WS,
# 5000 Flask backend, 5001 modal adapter.
$PianoidPorts = @(3000, 3001, 5000, 5001)

# How long the -Auto (timed) pop-up waits for a click before taking the safe
# default. Generous enough for a present desktop-icon user; bounded so a truly
# headless launch never hangs.
$PopupTimeoutSec = 30

# -------------------------------------------------------------------------
# Return the listening Pianoid ports as a sorted unique int array (empty if
# none / on any failure). Get-NetTCPConnection is the documented detection
# method (dev.md / STARTUP_TROUBLESHOOTING.md).
# -------------------------------------------------------------------------
function Get-ListeningPianoidPorts {
    try {
        $conns = Get-NetTCPConnection -State Listen -LocalPort $PianoidPorts -ErrorAction SilentlyContinue
        if ($null -eq $conns) { return @() }
        return ($conns | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
    } catch {
        return @()
    }
}

# -------------------------------------------------------------------------
# Kill the owning processes of the listening Pianoid ports - PORT-TARGETED
# ONLY (by OwningProcess PID, never by image name). Returns nothing; failures
# are swallowed (best-effort).
# -------------------------------------------------------------------------
function Stop-PianoidListeners {
    foreach ($port in $PianoidPorts) {
        try {
            $pids = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($processId in $pids) {
                if ($processId -and $processId -ne 0) {
                    Write-Host ("  Stopping PID {0} on port {1}" -f $processId, $port)
                    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
            # best-effort per port; keep going
        }
    }
}

# -------------------------------------------------------------------------
# Show the Kill & restart / Cancel prompt and return the user's intent as a
# string: 'kill' (kill the listeners + launch) or 'cancel' (abort the launch).
#
#  * Interactive (no -Auto): a normal BLOCKING System.Windows.Forms.MessageBox
#    (YesNo). Yes -> 'kill', No -> 'cancel'.
#  * -Auto: a TIMED WScript.Shell.Popup (YesNo, $PopupTimeoutSec). The present
#    desktop-icon user can still answer; if nobody does (timeout = -1) the SAFE
#    default is 'cancel' - never kill a live stack unattended, never launch
#    onto a busy port.
# -------------------------------------------------------------------------
function Show-ServerPrompt {
    param([string] $PortList)

    $body = "Pianoid servers are already running on port(s):`n`n  $PortList`n`n" +
            "Kill them and restart, or cancel this launch?`n`n" +
            "[Yes] Kill the running servers and restart`n" +
            "[No]  Cancel - leave the running stack and do not launch"
    $title = 'Pianoid - already running'

    if ($Auto) {
        # WScript.Shell.Popup button codes: 4 = Yes/No, 48 = Warning icon.
        # Returns 6 = Yes, 7 = No, -1 = timed out (no click).
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $rc = $wshell.Popup(
                ($body + "`n`n(Auto-launch: defaults to Cancel in $PopupTimeoutSec s.)"),
                $PopupTimeoutSec, $title, (4 + 48))
            if ($rc -eq 6) { return 'kill' }   # Yes
            return 'cancel'                     # No (7) or timeout (-1) -> safe default
        } catch {
            # COM unavailable -> safe default: do not kill, do not launch.
            return 'cancel'
        }
    }

    # Interactive: blocking dialog.
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $result = [System.Windows.Forms.MessageBox]::Show(
        $body, $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { return 'kill' }
    return 'cancel'
}

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (launch).
# =========================================================================
try {
    $listening = @(Get-ListeningPianoidPorts)

    # No Pianoid stack up -> proceed to launch silently.
    if ($listening.Count -eq 0) { exit 0 }

    $portList = ($listening -join ', ')
    Write-Host ("Pianoid servers already running on port(s): {0}." -f $portList)

    $intent = Show-ServerPrompt -PortList $portList

    if ($intent -eq 'kill') {
        Write-Host "Killing the running Pianoid servers (port-targeted)..."
        Stop-PianoidListeners
        # Brief settle so ports release before the .bat relaunches.
        Start-Sleep -Seconds 2
        exit 0
    }

    # 'cancel' -> tell the .bat to abort the launch.
    exit 20
}
catch {
    # Best-effort: never let an unexpected failure block the launch.
    exit 0
}
