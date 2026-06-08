# setup-path-guard.ps1
# PATH-preservation helpers for setup-dev.ps1.
#
# WHY THIS EXISTS
#   setup-dev.ps1 does not itself persist any PATH change. But the third-party
#   installers it launches DO rewrite the persistent Windows PATH:
#     - the Python installer (PrependPath=1)
#     - VS 2022 Build Tools (vs_buildtools.exe)
#     - the CUDA Toolkit installer
#     - the Node.js MSI
#   On a machine where NI LabWindows/CVI is installed, one of these can drop or
#   reorder the National Instruments PATH entries, leaving CVI unable to find its
#   dependencies. Pianoid's own build does NOT need any of these tools on the
#   persistent PATH (build_pianoid_cuda.bat reads cl.exe from build_config.json
#   and explicitly warns that vcvars64 on PATH breaks the build), so we can safely
#   snapshot the persistent PATH before the installers run and re-append anything
#   they dropped afterwards.
#
# DESIGN
#   The functions here are pure / side-effect-free EXCEPT the three explicitly
#   named to mutate state: Write-PathBackup (writes a backup file) and
#   Restore-DroppedPathEntries (the only function that writes the persistent PATH;
#   it composes the pure helpers). This separation keeps the snapshot/diff/merge
#   math unit-testable in isolation without touching the machine environment.
#
# COMPATIBILITY
#   Windows PowerShell 5.1 (Desktop). No ternary, no ?? / ?. operators.

# Conservative per-variable PATH length ceiling. The registry REG_EXPAND_SZ type
# can hold up to 32767 chars after expansion, but many legacy applications (and
# the classic CreateProcess environment block) break past ~2047 chars for a
# single variable. We refuse to WRITE a reconciled PATH longer than this rather
# than risk silently truncating entries; the backup file is kept for recovery.
$script:PATH_LENGTH_SAFE_CAP = 2047

function Split-PathEntries {
  # Split a raw ';'-delimited PATH string into an ordered list of non-empty,
  # trimmed, de-duplicated entries. De-duplication is case-insensitive (the
  # Windows filesystem/PATH convention) and keeps the FIRST occurrence's order.
  param([string]$PathString)

  $result = New-Object System.Collections.Generic.List[string]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  if ([string]::IsNullOrEmpty($PathString)) {
    return ,$result.ToArray()
  }

  foreach ($raw in ($PathString -split ';')) {
    $entry = $raw.Trim()
    if ($entry.Length -eq 0) { continue }
    if ($seen.Add($entry)) {
      [void]$result.Add($entry)
    }
  }
  # The unary comma forces PowerShell to return the array as a single object
  # (otherwise a 0- or 1-element array gets unwrapped by the pipeline).
  return ,$result.ToArray()
}

function Get-PersistentPathSnapshot {
  # Read the persistent Machine and User PATH values and return both the raw
  # strings and the split/normalised entry lists. This is the state we compare
  # against after the installers run.
  $machineRaw = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
  $userRaw    = [Environment]::GetEnvironmentVariable('PATH', 'User')

  return [PSCustomObject]@{
    MachineRaw     = $machineRaw
    UserRaw        = $userRaw
    MachineEntries = (Split-PathEntries $machineRaw)
    UserEntries    = (Split-PathEntries $userRaw)
    TakenAt        = (Get-Date)
  }
}

function Get-DroppedPathEntries {
  # Pure set difference: return every entry that was in $Before but is NOT in
  # $After (case-insensitive), preserving $Before's order. Empty-safe.
  param(
    [string[]]$Before,
    [string[]]$After
  )

  $dropped = New-Object System.Collections.Generic.List[string]
  if (-not $Before) { return ,$dropped.ToArray() }

  $afterSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  if ($After) {
    foreach ($a in $After) {
      if (-not [string]::IsNullOrEmpty($a)) { [void]$afterSet.Add($a.Trim()) }
    }
  }

  foreach ($b in $Before) {
    if ([string]::IsNullOrEmpty($b)) { continue }
    $entry = $b.Trim()
    if ($entry.Length -eq 0) { continue }
    if (-not $afterSet.Contains($entry)) {
      [void]$dropped.Add($entry)
    }
  }
  return ,$dropped.ToArray()
}

function Merge-RestoredPath {
  # Pure: append $DroppedEntries to the surviving $CurrentEntries, de-duplicated
  # (case-insensitive), preserving the order of survivors first and then the
  # dropped entries. Returns the joined ';' string. Does NOT write anything.
  param(
    [string[]]$CurrentEntries,
    [string[]]$DroppedEntries
  )

  $merged = New-Object System.Collections.Generic.List[string]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  foreach ($e in @($CurrentEntries) + @($DroppedEntries)) {
    if ([string]::IsNullOrEmpty($e)) { continue }
    $entry = $e.Trim()
    if ($entry.Length -eq 0) { continue }
    if ($seen.Add($entry)) {
      [void]$merged.Add($entry)
    }
  }
  return ($merged.ToArray() -join ';')
}

function Test-PathWithinLimit {
  # Pure: $true if the reconciled PATH string is within the safe length cap.
  param([string]$PathString)

  if ([string]::IsNullOrEmpty($PathString)) { return $true }
  return ($PathString.Length -le $script:PATH_LENGTH_SAFE_CAP)
}

function Find-NationalInstrumentsPaths {
  # Detect an NI LabWindows/CVI footprint so we can print a clear heads-up that
  # the setup will snapshot+restore PATH to protect it. Checks the two standard
  # NI install roots, any *CVI* child directory under them, and any NI/CVI entry
  # already present on the supplied PATH entry list. Returns a list of evidence
  # strings (empty if nothing found). Filesystem reads only, no mutation.
  param([string[]]$PathEntries)

  $evidence = New-Object System.Collections.Generic.List[string]

  $niRoots = @(
    "${env:ProgramFiles(x86)}\National Instruments",
    "$env:ProgramFiles\National Instruments"
  )
  foreach ($root in $niRoots) {
    if ([string]::IsNullOrEmpty($root)) { continue }
    if (Test-Path $root) {
      [void]$evidence.Add("NI directory: $root")
      try {
        $cviDirs = Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
                   Where-Object { $_.Name -like '*CVI*' }
        foreach ($d in $cviDirs) {
          [void]$evidence.Add("CVI directory: $($d.FullName)")
        }
      } catch {
        # Non-fatal: detection is best-effort.
      }
    }
  }

  if ($PathEntries) {
    foreach ($entry in $PathEntries) {
      if ([string]::IsNullOrEmpty($entry)) { continue }
      if ($entry -match 'National Instruments' -or $entry -match 'CVI') {
        [void]$evidence.Add("PATH entry: $entry")
      }
    }
  }

  return ,$evidence.ToArray()
}

function Write-PathBackup {
  # Write a timestamped backup of both raw PATH strings for manual recovery.
  # Returns the backup file path, or $null if the write failed (non-fatal).
  param(
    [string]$MachineRaw,
    [string]$UserRaw,
    [string]$Directory
  )

  if ([string]::IsNullOrEmpty($Directory)) { $Directory = $env:TEMP }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $file = Join-Path $Directory "pianoid-setup-path-backup-$stamp.txt"

  $lines = @(
    "# Pianoid setup-dev.ps1 PATH backup",
    "# Created: $(Get-Date -Format 'o')",
    "# Restore manually by pasting the value(s) below into the matching scope",
    "# (System Properties -> Environment Variables) if anything is lost.",
    "",
    "[MACHINE PATH]",
    $MachineRaw,
    "",
    "[USER PATH]",
    $UserRaw
  )

  try {
    Set-Content -Path $file -Value $lines -Encoding UTF8 -ErrorAction Stop
    return $file
  } catch {
    Write-Warning "Could not write PATH backup to ${file}: $_"
    return $null
  }
}

function Restore-DroppedPathEntries {
  # The orchestration wrapper and the ONLY function here that writes the
  # persistent PATH. For each scope (Machine, User): re-read the current
  # persistent PATH, diff it against the pre-installer $Snapshot, and if any
  # entries were dropped, re-append them (deduped, survivors-first). If the
  # reconciled value would exceed the safe length cap, WARN loudly and do NOT
  # write (the backup file is the recovery path). Returns a summary object.
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [string]$BackupFile
  )

  $summary = [PSCustomObject]@{
    MachineDropped  = @()
    UserDropped     = @()
    MachineRestored = $false
    UserRestored    = $false
    MachineSkipped  = $false   # set if a write was refused (over length cap)
    UserSkipped     = $false
  }

  $scopes = @(
    @{ Name = 'Machine'; BeforeEntries = $Snapshot.MachineEntries },
    @{ Name = 'User';    BeforeEntries = $Snapshot.UserEntries }
  )

  foreach ($scope in $scopes) {
    $scopeName = $scope.Name
    $currentRaw = [Environment]::GetEnvironmentVariable('PATH', $scopeName)
    $currentEntries = Split-PathEntries $currentRaw
    $dropped = Get-DroppedPathEntries -Before $scope.BeforeEntries -After $currentEntries

    if (-not $dropped -or $dropped.Count -eq 0) {
      Write-Host "  $scopeName PATH: no entries dropped by installers."
      continue
    }

    Write-Host "  $scopeName PATH: $($dropped.Count) entr$(if ($dropped.Count -eq 1) { 'y' } else { 'ies' }) dropped by installers:"
    foreach ($d in $dropped) { Write-Host "    - $d" }

    $merged = Merge-RestoredPath -CurrentEntries $currentEntries -DroppedEntries $dropped

    if (-not (Test-PathWithinLimit $merged)) {
      Write-Warning "  $scopeName PATH would exceed the safe length cap ($($script:PATH_LENGTH_SAFE_CAP) chars) after restoring dropped entries (would be $($merged.Length) chars)."
      Write-Warning "  REFUSING to write a value that could silently truncate entries. The dropped entries above were NOT restored automatically."
      if ($BackupFile) {
        Write-Warning "  Restore them manually from the backup: $BackupFile"
      }
      if ($scopeName -eq 'Machine') { $summary.MachineSkipped = $true } else { $summary.UserSkipped = $true }
      continue
    }

    try {
      [Environment]::SetEnvironmentVariable('PATH', $merged, $scopeName)
      Write-Host "  $scopeName PATH: restored $($dropped.Count) dropped entr$(if ($dropped.Count -eq 1) { 'y' } else { 'ies' })."
      if ($scopeName -eq 'Machine') {
        $summary.MachineRestored = $true
        $summary.MachineDropped = $dropped
      } else {
        $summary.UserRestored = $true
        $summary.UserDropped = $dropped
      }
    } catch {
      Write-Warning "  Failed to write restored $scopeName PATH: $_"
      if ($BackupFile) {
        Write-Warning "  Restore manually from the backup: $BackupFile"
      }
    }
  }

  return $summary
}
