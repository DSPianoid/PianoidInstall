# setup-path-guard.Tests.ps1
#
# Standalone unit tests for the pure PATH-preservation helpers in
# ../setup-path-guard.ps1. Runs WITHOUT Pester (plain assertions) so it works on
# any Windows PowerShell 5.1 box regardless of the installed Pester major
# version. Exercises ONLY the side-effect-free functions with mock PATH strings —
# it never runs the installers and never writes the real persistent PATH.
#
# Run:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\setup-path-guard.Tests.ps1
# Exit code 0 = all passed; non-zero = at least one failure (CI-gateable).

$ErrorActionPreference = 'Stop'

# Dot-source the module under test (the guard sits one level up from tests/).
$guard = Join-Path (Split-Path -Parent $PSScriptRoot) 'setup-path-guard.ps1'
if (-not (Test-Path $guard)) {
  Write-Error "setup-path-guard.ps1 not found at $guard"
  exit 2
}
. $guard

# --- tiny assertion harness ---
$script:Passed = 0
$script:Failed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) {
    $script:Passed++
    Write-Host "  [PASS] $Message"
  } else {
    $script:Failed++
    Write-Host "  [FAIL] $Message" -ForegroundColor Red
  }
}

function Assert-SequenceEqual {
  # Ordered, exact equality of two string arrays.
  param([string[]]$Actual, [string[]]$Expected, [string]$Message)
  $a = @($Actual)
  $e = @($Expected)
  $ok = ($a.Count -eq $e.Count)
  if ($ok) {
    for ($i = 0; $i -lt $e.Count; $i++) {
      if ($a[$i] -cne $e[$i]) { $ok = $false; break }
    }
  }
  if (-not $ok) {
    Write-Host "    expected: [$($e -join ' | ')]" -ForegroundColor DarkYellow
    Write-Host "    actual:   [$($a -join ' | ')]" -ForegroundColor DarkYellow
  }
  Assert-True $ok $Message
}

Write-Host "=== setup-path-guard pure-helper unit tests ==="

# ---------------------------------------------------------------------------
# Case 1 (the core requirement): before-PATH contains NI/CVI entries, after-PATH
# is missing them -> reconcile re-adds EXACTLY those, deduped, survivors' order
# preserved.
# ---------------------------------------------------------------------------
Write-Host "`n[Case 1] NI/CVI dropped by an installer -> restored, order preserved"

$before = Split-PathEntries 'C:\Windows;C:\Windows\System32;C:\Program Files (x86)\National Instruments\CVI2019\bin;C:\Program Files (x86)\National Instruments\Shared;C:\Python312'
# After: the installer dropped both NI entries and prepended its own bin dir.
$after  = Split-PathEntries 'C:\Python312\Scripts;C:\Windows;C:\Windows\System32;C:\Python312'

$dropped = Get-DroppedPathEntries -Before $before -After $after
Assert-SequenceEqual $dropped @(
  'C:\Program Files (x86)\National Instruments\CVI2019\bin',
  'C:\Program Files (x86)\National Instruments\Shared'
) "drops exactly the two NI entries, in before-order"

$merged = Merge-RestoredPath -CurrentEntries $after -DroppedEntries $dropped
$mergedEntries = Split-PathEntries $merged
# Survivors keep their current order; dropped entries are appended after them.
Assert-SequenceEqual $mergedEntries @(
  'C:\Python312\Scripts',
  'C:\Windows',
  'C:\Windows\System32',
  'C:\Python312',
  'C:\Program Files (x86)\National Instruments\CVI2019\bin',
  'C:\Program Files (x86)\National Instruments\Shared'
) "merged PATH = survivors (current order) then restored NI entries"

Assert-True ($mergedEntries -contains 'C:\Program Files (x86)\National Instruments\CVI2019\bin') "CVI bin is back on PATH"

# ---------------------------------------------------------------------------
# Case 2: nothing dropped -> no spurious additions / no-op.
# ---------------------------------------------------------------------------
Write-Host "`n[Case 2] nothing dropped -> no-op (no spurious additions)"

$before2 = Split-PathEntries 'C:\Windows;C:\Windows\System32;C:\Program Files (x86)\National Instruments\CVI2019\bin'
# After: the installer APPENDED a new dir but dropped nothing.
$after2  = Split-PathEntries 'C:\Windows;C:\Windows\System32;C:\Program Files (x86)\National Instruments\CVI2019\bin;C:\NewTool\bin'

$dropped2 = Get-DroppedPathEntries -Before $before2 -After $after2
Assert-True ($dropped2.Count -eq 0) "no entries reported dropped"

$merged2 = Merge-RestoredPath -CurrentEntries $after2 -DroppedEntries $dropped2
$mergedEntries2 = Split-PathEntries $merged2
Assert-SequenceEqual $mergedEntries2 @(
  'C:\Windows',
  'C:\Windows\System32',
  'C:\Program Files (x86)\National Instruments\CVI2019\bin',
  'C:\NewTool\bin'
) "merged PATH is unchanged from the installer's PATH (no spurious entries)"

# ---------------------------------------------------------------------------
# Case 3: over-length case -> the truncation guard reports NOT within limit, so
# the orchestrator will warn instead of writing/dropping.
# ---------------------------------------------------------------------------
Write-Host "`n[Case 3] over-length reconciled PATH -> guard refuses (warn, don't truncate)"

# Build a PATH guaranteed to exceed the 2047-char safe cap.
$longEntries = @()
for ($i = 0; $i -lt 60; $i++) {
  $longEntries += ("C:\Program Files\SomeVendor\ReallyLongDirectoryNameNumber{0:D3}\bin" -f $i)
}
$longPath = $longEntries -join ';'
Assert-True ($longPath.Length -gt 2047) "constructed PATH is genuinely over the 2047 cap ($($longPath.Length) chars)"
Assert-True (-not (Test-PathWithinLimit $longPath)) "Test-PathWithinLimit returns FALSE for the over-length PATH"

# A short PATH passes the guard.
Assert-True (Test-PathWithinLimit 'C:\Windows;C:\Windows\System32') "Test-PathWithinLimit returns TRUE for a normal-length PATH"
Assert-True (Test-PathWithinLimit '') "Test-PathWithinLimit returns TRUE for an empty PATH"

# ---------------------------------------------------------------------------
# Case 4: de-duplication + trimming + empty-safety (defensive edges).
# ---------------------------------------------------------------------------
Write-Host "`n[Case 4] dedup / trim / empty-safety"

# Case-insensitive dedup, keeps FIRST occurrence, drops empties & whitespace.
$split = Split-PathEntries 'C:\Windows;;  C:\Windows  ;c:\windows;C:\Tools'
Assert-SequenceEqual $split @('C:\Windows', 'C:\Tools') "dedup is case-insensitive, keeps first, trims, drops empties"

# Merge dedups a dropped entry that already survived (no double-add).
$mergeDedup = Merge-RestoredPath -CurrentEntries @('C:\A', 'C:\B') -DroppedEntries @('c:\a', 'C:\C')
Assert-SequenceEqual (Split-PathEntries $mergeDedup) @('C:\A', 'C:\B', 'C:\C') "merge does not re-add an entry already present (case-insensitive)"

# Empty-safety: null/empty inputs never throw.
$emptyDrop = Get-DroppedPathEntries -Before @() -After @()
Assert-True ($emptyDrop.Count -eq 0) "Get-DroppedPathEntries is empty-safe"
$emptySplit = Split-PathEntries ''
Assert-True ($emptySplit.Count -eq 0) "Split-PathEntries is empty-safe"
$emptyMerge = Merge-RestoredPath -CurrentEntries @() -DroppedEntries @()
Assert-True ($emptyMerge -eq '') "Merge-RestoredPath of empties is the empty string"

# ---------------------------------------------------------------------------
# Case 5: NI detection from a PATH entry list (no filesystem dependency).
# ---------------------------------------------------------------------------
Write-Host "`n[Case 5] NI/CVI detection from PATH entries"

$niFromPath = Find-NationalInstrumentsPaths -PathEntries @(
  'C:\Windows',
  'C:\Program Files (x86)\National Instruments\CVI2019\bin'
)
Assert-True ($niFromPath.Count -ge 1) "NI footprint detected from a PATH entry"
Assert-True (($niFromPath | Where-Object { $_ -match 'CVI2019' }).Count -ge 1) "the CVI PATH entry is reported as evidence"

$niNone = Find-NationalInstrumentsPaths -PathEntries @('C:\Windows', 'C:\Python312')
# (Filesystem roots may or may not exist on the test box; assert only that a
# vanilla PATH with no NI entry yields no PATH-derived evidence.)
$pathEvidence = @($niNone | Where-Object { $_ -like 'PATH entry:*' })
Assert-True ($pathEvidence.Count -eq 0) "no NI PATH-entry evidence for a vanilla PATH"

# ---------------------------------------------------------------------------
Write-Host "`n=== Results: $script:Passed passed, $script:Failed failed ==="
if ($script:Failed -gt 0) { exit 1 } else { exit 0 }
