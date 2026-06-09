# =========================================================================
# check-updates.ps1 - best-effort "is origin ahead?" check for Pianoid repos
#
# Called by start-pianoid.bat BEFORE launch. For each Pianoid repo
# (PianoidCore / PianoidTunner / PianoidBasic on their current branch, and
# the outer PianoidInstall on master) it does a SHORT-timeout `git fetch`,
# then compares the local branch against its upstream. If ANY repo's origin
# is ahead it shows a Yes/No pop-up offering to run update-repos.bat.
#
# Contract (exit codes the .bat interprets):
#   10  -> updates available AND the user clicked "Yes" (run update-repos.bat)
#    0  -> everything else: up to date, user clicked "No", git unreachable,
#          no network, no upstream, or ANY unexpected failure.
#
# DESIGN: this is BEST-EFFORT and must NEVER block, hang, or error the
# launch. Every git call is timeout-guarded; the whole body is wrapped so any
# failure falls through to exit 0 (-> the launcher proceeds normally). git
# missing / offline / detached-no-upstream are all treated as "unknown", not
# errors.
#
# See: update-repos.bat (the pull+rebuild the pop-up triggers),
#      start-pianoid.bat (the caller), docs/guides/QUICK_START.md.
# =========================================================================

# Soft error mode: a non-terminating error must not abort the launch.
$ErrorActionPreference = 'SilentlyContinue'

# Per-fetch network budget. Kept short so a slow/dead network cannot stall
# the launch; the whole check is bounded by (repos * FetchTimeoutSec).
$FetchTimeoutSec = 8

$RepoRoot = $PSScriptRoot

# Repos to check (display name + path). All four share one origin account;
# sub-repos track their current branch, the outer repo tracks master.
$Repos = @(
    @{ Name = 'PianoidCore';    Path = (Join-Path $RepoRoot 'PianoidCore')   },
    @{ Name = 'PianoidTunner';  Path = (Join-Path $RepoRoot 'PianoidTunner') },
    @{ Name = 'PianoidBasic';   Path = (Join-Path $RepoRoot 'PianoidBasic')  },
    @{ Name = 'PianoidInstall'; Path = $RepoRoot                             }
)

# -------------------------------------------------------------------------
# Run a git command in a repo with a hard timeout. Returns the trimmed
# stdout on success, or $null on timeout / failure / non-zero exit.
# -------------------------------------------------------------------------
function Invoke-GitWithTimeout {
    param(
        [string]   $RepoPath,
        [string[]] $GitArgs,
        [int]      $TimeoutSec = 8
    )
    try {
        $job = Start-Job -ScriptBlock {
            param($p, $a)
            Set-Location -LiteralPath $p
            # Capture stdout only; stderr is discarded (best-effort).
            (& git @a 2>$null)
        } -ArgumentList $RepoPath, (,$GitArgs)

        if (Wait-Job $job -Timeout $TimeoutSec) {
            $out = Receive-Job $job
            Remove-Job $job -Force
            if ($out -is [array]) { $out = ($out -join "`n") }
            if ($null -eq $out) { return $null }
            return ([string]$out).Trim()
        } else {
            # Timed out - kill the job and report "unknown".
            Stop-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            return $null
        }
    } catch {
        return $null
    }
}

# -------------------------------------------------------------------------
# For one repo: fetch (timeout-guarded), then count commits the upstream has
# that the local branch lacks. Returns the ahead-count (int >= 0), or -1 for
# "unknown" (no git / no repo / no upstream / fetch or compare failed).
# -------------------------------------------------------------------------
function Get-RepoAheadCount {
    param([string] $RepoPath)

    if (-not (Test-Path -LiteralPath (Join-Path $RepoPath '.git'))) { return -1 }

    # Best-effort fetch; ignore the result (compare below tolerates a stale
    # remote-tracking ref - it just means we may under-report, never error).
    Invoke-GitWithTimeout -RepoPath $RepoPath -GitArgs @('fetch', '--quiet') -TimeoutSec $FetchTimeoutSec | Out-Null

    # @{u} = the current branch's upstream. Fails (=> $null) if there is no
    # upstream (detached HEAD / no tracking branch) -> treat as unknown.
    $count = Invoke-GitWithTimeout -RepoPath $RepoPath -GitArgs @('rev-list', '--count', 'HEAD..@{u}') -TimeoutSec $FetchTimeoutSec
    if ([string]::IsNullOrWhiteSpace($count)) { return -1 }

    $n = 0
    if ([int]::TryParse($count, [ref]$n)) { return $n }
    return -1
}

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (launch).
# =========================================================================
try {
    # git on PATH at all? If not, silently skip the whole check.
    $gitProbe = Invoke-GitWithTimeout -RepoPath $RepoRoot -GitArgs @('--version') -TimeoutSec 5
    if ([string]::IsNullOrWhiteSpace($gitProbe)) { exit 0 }

    $aheadRepos = @()
    foreach ($repo in $Repos) {
        $ahead = Get-RepoAheadCount -RepoPath $repo.Path
        if ($ahead -gt 0) { $aheadRepos += ("{0} (+{1})" -f $repo.Name, $ahead) }
    }

    # Nothing ahead (or everything unknown) -> proceed to launch silently.
    if ($aheadRepos.Count -eq 0) { exit 0 }

    # Some repo's origin is ahead -> offer the update via a GUI pop-up.
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $msg  = "Updates are available on origin for:`n`n  " + ($aheadRepos -join "`n  ") + "`n`nRun the update now (git pull + rebuild what changed)?"
    $title = 'Pianoid - updates available'
    $result = [System.Windows.Forms.MessageBox]::Show(
        $msg, $title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)

    if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { exit 10 }
    exit 0
}
catch {
    # Best-effort: never let an unexpected failure block the launch.
    exit 0
}
