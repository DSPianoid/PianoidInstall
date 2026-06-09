# =========================================================================
# make-shortcut.ps1 - create a "Pianoid" shortcut on the user's Desktop
#
# Drops Desktop\Pianoid.lnk pointing at start-pianoid.bat with the no-prompt
# /auto flag, so a double-click launches Pianoid straight through (no "press
# any key" pause). WorkingDirectory is the repo root; the icon is the app
# favicon. Re-running overwrites the existing shortcut (idempotent).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-shortcut.ps1
#   (or just double-click make-shortcut.bat)
#
# See: docs/guides/QUICK_START.md (launcher), start-pianoid.bat (/auto flag).
# =========================================================================

$ErrorActionPreference = 'Stop'

# Repo root = the folder this script lives in (trailing slash stripped).
$RepoRoot   = $PSScriptRoot
$TargetBat  = Join-Path $RepoRoot 'start-pianoid.bat'
$IconFile   = Join-Path $RepoRoot 'PianoidTunner\public\favicon.ico'
$LinkName   = 'Pianoid.lnk'

Write-Host '========================================================================='
Write-Host 'Creating Pianoid desktop shortcut'
Write-Host '========================================================================='

# --- Verify the launch target exists -------------------------------------
if (-not (Test-Path -LiteralPath $TargetBat)) {
    Write-Host "ERROR: start-pianoid.bat not found at $TargetBat" -ForegroundColor Red
    exit 1
}

# --- Resolve the Desktop path --------------------------------------------
$Desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrEmpty($Desktop)) {
    Write-Host 'ERROR: could not resolve the Desktop folder.' -ForegroundColor Red
    exit 1
}
$LinkPath = Join-Path $Desktop $LinkName

# --- Create / overwrite the shortcut via the WScript.Shell COM API -------
try {
    $shell    = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($LinkPath)
    $shortcut.TargetPath       = $TargetBat
    $shortcut.Arguments        = '/auto'
    $shortcut.WorkingDirectory = $RepoRoot
    $shortcut.Description       = 'Launch Pianoid (launcher + frontend)'

    if (Test-Path -LiteralPath $IconFile) {
        # IconLocation = "<path>,<index>"; index 0 = first icon in the .ico.
        $shortcut.IconLocation = "$IconFile,0"
    } else {
        Write-Host "WARNING: icon not found at $IconFile - shortcut will use the default icon." -ForegroundColor Yellow
    }

    $shortcut.Save()
}
finally {
    if ($shortcut) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
    if ($shell)    { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)    | Out-Null }
}

Write-Host ''
Write-Host "  OK  Shortcut created: $LinkPath" -ForegroundColor Green
Write-Host "      Target:  $TargetBat /auto"
Write-Host "      Workdir: $RepoRoot"
if (Test-Path -LiteralPath $IconFile) { Write-Host "      Icon:    $IconFile" }
Write-Host ''
exit 0
