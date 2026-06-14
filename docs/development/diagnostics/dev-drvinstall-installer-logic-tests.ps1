# =========================================================================
# dev-drvinstall-installer-logic-tests.ps1
#
# Unit tests for the PURE / offline-testable logic in install-nvidia-driver.ps1
# (the chocolatey-primary automated NVIDIA display-driver installer). The real
# install / bootstrap / reboot are NEVER run here (a real `choco install
# nvidia-display-driver` would force a reboot and kill the session); instead we
# test the decision logic that drives them:
#   1. choco success-code set - the {0,1605,1614,1641,3010} whitelist the script
#      treats as success (3010 = reboot required). Mirrored + the boundary cases.
#   2. command construction   - the exact `choco install ...` argument vector the
#      script builds, with and without -Force. Mirrored from Invoke-Tier1.
#   3. shipped-script SAFETY invariants - grep the REAL file to assert the -DryRun
#      guard on the real install + the -not-DryRun gate on Restart-Computer + that
#      the fragile NVIDIA-API tier was removed (choco-only).
#
# The end-to-end command FLOW + the -DryRun plan (choco bootstrap line + the
# `choco install nvidia-display-driver -y --no-progress` line + the success-code
# echo + "no install, no reboot") is verified by actually running the script with
# -DryRun (SAFE - it executes nothing) and recorded in the session log. This
# harness covers the unit logic.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File `
#        docs\development\diagnostics\dev-drvinstall-installer-logic-tests.ps1
# Exit 0 = all pass; 1 = a failure.
# =========================================================================

$ErrorActionPreference = 'Stop'
$script:Pass = 0; $script:Fail = 0
function Assert-Equal {
    param([string] $Name, $Expected, $Actual)
    if ($Expected -eq $Actual) { $script:Pass++; Write-Host ("  [PASS] {0}" -f $Name) }
    else { $script:Fail++; Write-Host ("  [FAIL] {0} : expected '{1}', got '{2}'" -f $Name, $Expected, $Actual) }
}

# --- load the REAL Get-NvDriverShort from install-nvidia-driver.ps1 ---
$scriptPath = Join-Path $PSScriptRoot '..\..\..\install-nvidia-driver.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "FATAL: cannot locate install-nvidia-driver.ps1 (looked at $scriptPath)"; exit 1
}
$scriptText = Get-Content -LiteralPath (Resolve-Path $scriptPath) -Raw

# --- mirrored logic (kept in sync with install-nvidia-driver.ps1 Invoke-Tier1) ---
# The success-code whitelist + the command vector the script builds.
$ChocoSuccess = @(0, 1605, 1614, 1641, 3010)
function Test-ChocoSuccess { param([int] $Code) return ($ChocoSuccess -contains $Code) }
function Build-ChocoArgs { param([bool] $Force)
    $a = @('install', 'nvidia-display-driver', '-y', '--no-progress')
    if ($Force) { $a += '--force' }
    return $a
}

Write-Host ''
Write-Host '=== install-nvidia-driver.ps1 (chocolatey-primary) logic tests ==='
Write-Host ''
Write-Host '-- choco success-code classification ({0,1605,1614,1641,3010}) --'
Assert-Equal 'exit 0    -> success'   $true  (Test-ChocoSuccess 0)
Assert-Equal 'exit 3010 -> success (reboot req)'  $true  (Test-ChocoSuccess 3010)
Assert-Equal 'exit 1641 -> success (reboot init)' $true  (Test-ChocoSuccess 1641)
Assert-Equal 'exit 1605 -> success'   $true  (Test-ChocoSuccess 1605)
Assert-Equal 'exit 1614 -> success'   $true  (Test-ChocoSuccess 1614)
Assert-Equal 'exit 1    -> FAIL (-> guided)'  $false (Test-ChocoSuccess 1)
Assert-Equal 'exit -1   -> FAIL'      $false (Test-ChocoSuccess -1)
Assert-Equal 'exit 5    -> FAIL'      $false (Test-ChocoSuccess 5)

Write-Host ''
Write-Host '-- choco command construction --'
Assert-Equal 'no Force -> exact args'  'install nvidia-display-driver -y --no-progress' ((Build-ChocoArgs $false) -join ' ')
Assert-Equal 'with Force -> +--force'  'install nvidia-display-driver -y --no-progress --force' ((Build-ChocoArgs $true) -join ' ')

Write-Host ''
Write-Host '-- shipped-script invariants (grep the REAL file) --'
# The package id is the community catalog id, verified present 2026-06-10.
Assert-Equal 'script targets nvidia-display-driver' $true ($scriptText -match "ChocoPkg\s*=\s*'nvidia-display-driver'")
# The success whitelist in the script matches our mirror.
Assert-Equal 'script ChocoSuccess whitelist present' $true ($scriptText -match '0,\s*1605,\s*1614,\s*1641,\s*3010')
# SAFETY: -DryRun must guard the real install (the script must NOT call choco
# install unconditionally). Assert the DryRun-returns-before-install guard exists.
Assert-Equal 'DryRun guards the real install' $true ($scriptText -match "if\s*\(\`$DryRun\)\s*\{[^}]*WOULD run")
# SAFETY: Restart-Computer must be gated by -not $DryRun.
Assert-Equal 'reboot gated by -not DryRun' $true ($scriptText -match 'RebootLikely\s*-and\s*-not\s*\$DryRun')
# The NVIDIA-API/AjaxDriverService tier was REMOVED (choco-only mechanism).
Assert-Equal 'no AjaxDriverService tier remains' $false ($scriptText -match 'AjaxDriverService')

Write-Host ''
Write-Host '-- uninstall-old: pnputil enum parsing + Display-class filter --'
# Mirror the script's Get-NvidiaDisplayDriverPackages parse against a synthetic
# pnputil /enum-drivers sample: a Display-class NVIDIA pkg (must match) + a
# non-Display NVIDIA pkg (Sound) + a non-NVIDIA Display pkg (must NOT match).
$NvDisplayClassGuid = '{4d36e968-e325-11ce-bfc1-08002be10318}'
function Parse-NvDisplayPkgs {
    param([string] $Raw)
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($b in ($Raw -split "(?:\r?\n){2,}")) {
        if ([string]::IsNullOrWhiteSpace($b)) { continue }
        $pub=$null;$prov=$null;$cls=$null
        foreach ($line in ($b -split "\r?\n")) {
            if ($line -match '(?i)^\s*Published Name\s*:\s*(\S+)') { $pub=$Matches[1] }
            elseif ($line -match '(?i)^\s*Provider Name\s*:\s*(.+?)\s*$') { $prov=$Matches[1] }
            elseif ($line -match '(?i)^\s*Class GUID\s*:\s*(\{[0-9a-fA-F-]+\})') { $cls=$Matches[1] }
        }
        if ($pub -and $cls -and ($cls.ToLower() -eq $NvDisplayClassGuid.ToLower()) -and ($prov -match '(?i)NVIDIA')) { $out.Add($pub) }
    }
    # Return the items (the caller wraps with @() to normalise), mirroring the
    # script's Get-NvidiaDisplayDriverPackages -> @(...) pattern.
    return $out.ToArray()
}
$sample = @"
Published Name:     oem3.inf
Original Name:      nv_dispig.inf
Provider Name:      NVIDIA
Class Name:         Display adapters
Class GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}
Driver Version:     08/14/2024 32.0.15.6094

Published Name:     oem16.inf
Original Name:      nvvad.inf
Provider Name:      NVIDIA
Class Name:         Sound, video and game controllers
Class GUID:         {4d36e96c-e325-11ce-bfc1-08002be10318}
Driver Version:     02/28/2024 4.65.0.3

Published Name:     oem9.inf
Original Name:      iigd_dch.inf
Provider Name:      Intel Corporation
Class Name:         Display adapters
Class GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}
Driver Version:     01/01/2024 31.0.101.0
"@
$parsed = @(Parse-NvDisplayPkgs $sample)
Assert-Equal 'enum parse: exactly 1 NVIDIA Display pkg' 1 $parsed.Count
Assert-Equal 'enum parse: it is oem3.inf'  'oem3.inf'  ($parsed[0])
# (the NVIDIA Sound pkg + the Intel Display pkg must be excluded)
$sampleStale = @"
Published Name:     oem3.inf
Provider Name:      NVIDIA
Class GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}

Published Name:     oem21.inf
Provider Name:      NVIDIA
Class GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}
"@
$parsed2 = @(Parse-NvDisplayPkgs $sampleStale)
Assert-Equal 'enum parse: 2 stale Display pkgs (Dmitri case)' 2 $parsed2.Count

Write-Host ''
Write-Host '-- uninstall-old: pnputil delete command construction --'
function Build-PnputilArgs { param([string] $Inf) return @('/delete-driver', $Inf, '/uninstall', '/force') }
Assert-Equal 'pnputil delete args' '/delete-driver oem3.inf /uninstall /force' ((Build-PnputilArgs 'oem3.inf') -join ' ')

Write-Host ''
Write-Host '-- uninstall-old: shipped-script SAFETY invariants (grep the REAL file) --'
# The uninstall step targets the Display class GUID only.
Assert-Equal 'targets Display class GUID' $true ($scriptText -match '4d36e968-e325-11ce-bfc1-08002be10318')
# pnputil delete-driver is the mechanism (not DDU/winget for the uninstall).
Assert-Equal 'uses pnputil /delete-driver /uninstall /force' $true ($scriptText -match 'delete-driver.*\/uninstall.*\/force')
# SAFETY: the pnputil delete must be guarded by -DryRun (no real delete in DryRun).
Assert-Equal 'DryRun guards the pnputil delete' $true ($scriptText -match 'if\s*\(\$DryRun\)[^}]*WOULD run: pnputil')
# The uninstall runs BEFORE the choco install in the main flow.
$uninstIdx = $scriptText.IndexOf('Invoke-UninstallOldDrivers')
$installIdx = $scriptText.IndexOf('$done = Invoke-Tier1-Chocolatey')
Assert-Equal 'uninstall call precedes the choco install' $true (($uninstIdx -gt 0) -and ($installIdx -gt $uninstIdx))
# The risk prompt warns that uninstall-then-install can leave NO driver.
Assert-Equal 'risk prompt warns uninstall-first / NO driver' $true ($scriptText -match '(?i)UNINSTALLS the existing')

Write-Host ''
Write-Host ('=== RESULT: {0} passed, {1} failed ===' -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
