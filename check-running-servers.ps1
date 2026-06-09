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
# -Auto switch (passed by the .bat when /auto / --no-prompt is set): run
# non-interactively. A desktop-shortcut launch is unattended, so a blocking
# MessageBox with nobody to click it would hang forever. In -Auto we DETECT +
# warn on the console but apply the SAFE default: do NOT kill the running
# stack (killing the user's live stack unattended is the dangerous choice) and
# proceed (exit 0). Bare/interactive runs get the full pop-up.
#
# DESIGN: BEST-EFFORT - must NEVER block, hang, or error the launch. The whole
# body is wrapped so any unexpected failure falls through to exit 0.
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

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (launch).
# =========================================================================
try {
    $listening = @(Get-ListeningPianoidPorts)

    # No Pianoid stack up -> proceed to launch silently.
    if ($listening.Count -eq 0) { exit 0 }

    $portList = ($listening -join ', ')

    # Unattended (/auto): warn on console, DO NOT kill the running stack,
    # proceed. Killing the user's live stack unattended is the dangerous
    # default, so the safe choice is to leave it and launch alongside (the
    # React dev server / launcher tolerate a port clash by reporting it; the
    # user sees the warning in the spawned window).
    if ($Auto) {
        Write-Host ("WARNING: Pianoid servers already running on port(s): {0}." -f $portList)
        Write-Host "  /auto mode: leaving the running stack untouched and proceeding."
        exit 0
    }

    # Interactive: offer Kill & restart vs Cancel via a pop-up.
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $msg = "Pianoid servers are already running on port(s):`n`n  $portList`n`n" +
           "Kill them and restart, or cancel this launch?`n`n" +
           "[Yes] Kill the running servers and restart`n" +
           "[No]  Cancel - leave the running stack and do not launch"
    $title = 'Pianoid - already running'
    $result = [System.Windows.Forms.MessageBox]::Show(
        $msg, $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning)

    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) {
        Write-Host "Killing the running Pianoid servers (port-targeted)..."
        Stop-PianoidListeners
        # Brief settle so ports release before the .bat relaunches.
        Start-Sleep -Seconds 2
        exit 0
    }

    # User chose Cancel -> tell the .bat to abort the launch.
    exit 20
}
catch {
    # Best-effort: never let an unexpected failure block the launch.
    exit 0
}
