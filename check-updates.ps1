# =========================================================================
# check-updates.ps1 - best-effort "is origin ahead?" check for Pianoid repos
#
# Called by start-pianoid.bat BEFORE launch. For each Pianoid repo it does a
# SHORT-timeout `git fetch`, then counts how many commits the repo's REMOTE
# INTEGRATION BRANCH has that the local HEAD lacks:
#   PianoidCore / PianoidTunner / PianoidBasic -> origin/dev
#   outer PianoidInstall                       -> origin/master
# If ANY repo is behind its integration branch it shows a Yes/No pop-up
# offering to run update-repos.bat.
#
# WHY origin/<integration> and NOT @{u}: the local checkout may be on a
# FEATURE branch with no upstream (e.g. a merged-but-not-deleted feature
# branch = an old `dev`, or a detached HEAD). `@{u}` then ERRORS -> the repo
# was reported "unknown" and SILENTLY SKIPPED even when origin/dev was ahead
# (observed live 2026-06-10: Core on feature/synthetic-dataset + Tunner on
# feature/toolbar-responsive-overflow while origin/dev was +4 / +13 ahead, no
# prompt). Comparing HEAD against the explicit integration ref is independent
# of the local branch: HEAD stays the "local" side, so even a merged-feature
# checkout correctly sees origin/dev's new commits. `@{u}` is kept only as a
# secondary fallback when the integration ref can't be resolved.
#
# Contract (exit codes the .bat interprets):
#   10  -> updates available AND the user clicked "Yes" (run update-repos.bat)
#    0  -> everything else: up to date, user clicked "No", git unreachable,
#          no network, no integration ref, or ANY unexpected failure.
#
# DESIGN: this is BEST-EFFORT and must NEVER block, hang, or error the
# launch. Every git call is timeout-guarded; the whole body is wrapped so any
# failure falls through to exit 0 (-> the launcher proceeds normally). git
# missing / offline / missing-integration-ref are all treated as "unknown",
# not errors.
#
# -WhatIf: print the per-repo ahead decision and the would-be result to stdout
# WITHOUT fetching's side effects mattering and WITHOUT popping the MessageBox.
# Used for non-disruptive verification of the detection logic. Exit code still
# follows the contract (10 if updates would be offered, 0 otherwise) but no GUI
# is shown.
#
# See: update-repos.bat (the pull+rebuild the pop-up triggers),
#      start-pianoid.bat (the caller), docs/guides/QUICK_START.md.
# =========================================================================

param(
    # Dry-run: report the decision to stdout, never show the pop-up.
    [switch] $WhatIf
)

# Soft error mode: a non-terminating error must not abort the launch.
$ErrorActionPreference = 'SilentlyContinue'

# Per-fetch network budget. Kept short so a slow/dead network cannot stall
# the launch; the whole check is bounded by (repos * FetchTimeoutSec).
$FetchTimeoutSec = 8

$RepoRoot = $PSScriptRoot

# Repos to check (display name + path + remote integration branch). All four
# share one origin account; the sub-repos integrate on origin/dev, the outer
# install/launcher repo integrates on origin/master. HEAD is compared against
# this explicit ref regardless of which local branch is currently checked out.
$Repos = @(
    @{ Name = 'PianoidCore';    Path = (Join-Path $RepoRoot 'PianoidCore');   Integration = 'dev'    },
    @{ Name = 'PianoidTunner';  Path = (Join-Path $RepoRoot 'PianoidTunner'); Integration = 'dev'    },
    @{ Name = 'PianoidBasic';   Path = (Join-Path $RepoRoot 'PianoidBasic');  Integration = 'dev'    },
    @{ Name = 'PianoidInstall'; Path = $RepoRoot;                             Integration = 'master' }
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
# Parse a `git rev-list --count` result string into a non-negative int.
# Returns the count, or -1 if the result is blank / not an integer ("unknown").
# -------------------------------------------------------------------------
function ConvertTo-AheadCount {
    param([string] $CountText)
    if ([string]::IsNullOrWhiteSpace($CountText)) { return -1 }
    $n = 0
    if ([int]::TryParse($CountText, [ref]$n)) { return $n }
    return -1
}

# -------------------------------------------------------------------------
# For one repo: fetch (timeout-guarded), then count commits the repo's REMOTE
# INTEGRATION BRANCH has that local HEAD lacks (= how far behind origin we are).
#
# Primary comparison: HEAD..origin/<IntegrationBranch>. This is independent of
# the local current branch, so a no-upstream feature branch / detached HEAD /
# merged-but-not-deleted branch is still measured correctly. If origin/<branch>
# can't be resolved (rare: ref missing / fetch failed) we fall back to the
# current branch's @{u}; if that also fails we report "unknown" (skip).
#
# Returns the ahead-count (int >= 0), or -1 for "unknown" (no git / no repo /
# no integration ref AND no upstream / fetch or compare failed).
# -------------------------------------------------------------------------
function Get-RepoAheadCount {
    param(
        [string] $RepoPath,
        [string] $IntegrationBranch
    )

    if (-not (Test-Path -LiteralPath (Join-Path $RepoPath '.git'))) { return -1 }

    # Best-effort fetch; ignore the result (compare below tolerates a stale
    # remote-tracking ref - it just means we may under-report, never error).
    Invoke-GitWithTimeout -RepoPath $RepoPath -GitArgs @('fetch', '--quiet') -TimeoutSec $FetchTimeoutSec | Out-Null

    # PRIMARY: count commits on origin/<integration> not reachable from HEAD.
    # Works regardless of the local current branch (dev, a feature branch =
    # old dev, detached, ...) because HEAD is the "local" side. Errors (=>
    # $null) only if origin/<integration> can't be resolved -> fall back.
    if (-not [string]::IsNullOrWhiteSpace($IntegrationBranch)) {
        $remoteRef = "origin/$IntegrationBranch"
        $count = Invoke-GitWithTimeout -RepoPath $RepoPath -GitArgs @('rev-list', '--count', "HEAD..$remoteRef") -TimeoutSec $FetchTimeoutSec
        $n = ConvertTo-AheadCount $count
        if ($n -ge 0) { return $n }
    }

    # FALLBACK: the current branch's upstream @{u}. Fails (=> $null) if there
    # is no upstream (detached HEAD / no tracking branch) -> treat as unknown.
    $count = Invoke-GitWithTimeout -RepoPath $RepoPath -GitArgs @('rev-list', '--count', 'HEAD..@{u}') -TimeoutSec $FetchTimeoutSec
    return (ConvertTo-AheadCount $count)
}

# =========================================================================
# Main - fully wrapped so ANY failure falls through to exit 0 (launch).
# =========================================================================
try {
    # git on PATH at all? If not, silently skip the whole check.
    $gitProbe = Invoke-GitWithTimeout -RepoPath $RepoRoot -GitArgs @('--version') -TimeoutSec 5
    if ([string]::IsNullOrWhiteSpace($gitProbe)) {
        if ($WhatIf) { Write-Host '[check-updates -WhatIf] git unreachable -> exit 0 (launch, silent)' }
        exit 0
    }

    $aheadRepos = @()
    foreach ($repo in $Repos) {
        $ahead = Get-RepoAheadCount -RepoPath $repo.Path -IntegrationBranch $repo.Integration
        if ($WhatIf) {
            $state = if ($ahead -lt 0) { 'unknown (skip)' }
                     elseif ($ahead -eq 0) { 'up to date' }
                     else { "behind origin/$($repo.Integration) by $ahead" }
            Write-Host ("[check-updates -WhatIf] {0,-14} vs origin/{1,-6} -> {2}" -f $repo.Name, $repo.Integration, $state)
        }
        if ($ahead -gt 0) { $aheadRepos += ("{0} (+{1})" -f $repo.Name, $ahead) }
    }

    # Nothing ahead (or everything unknown) -> proceed to launch silently.
    if ($aheadRepos.Count -eq 0) {
        if ($WhatIf) { Write-Host '[check-updates -WhatIf] decision: no updates -> exit 0 (launch)' }
        exit 0
    }

    # Dry-run: report what WOULD be offered, but never pop the MessageBox.
    if ($WhatIf) {
        Write-Host ('[check-updates -WhatIf] decision: updates available -> would prompt for: ' + ($aheadRepos -join ', '))
        Write-Host '[check-updates -WhatIf] (Yes -> exit 10 / run update-repos; No -> exit 0 / launch)'
        exit 10
    }

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
