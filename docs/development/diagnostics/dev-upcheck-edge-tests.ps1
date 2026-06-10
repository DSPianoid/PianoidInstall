# dev-upcheck edge tests for check-updates.ps1 (origin-ahead hardening).
# Dot-sources ONLY the functions from check-updates.ps1 (strips param + Main)
# and exercises the integration-ref primary / @{u} fallback / unknown edges.
# Non-disruptive: read-only git (fetch + rev-list); never pulls or pops a GUI.

$src = Get-Content -Raw "$PSScriptRoot/../../../check-updates.ps1"
# Keep everything from the first function definition up to (not including) Main.
# This drops the leading header + the top-level param() + $Repos vars, and
# critically does NOT touch the param() blocks INSIDE the functions.
$fnStart = $src.IndexOf("function Invoke-GitWithTimeout")
$mainAt  = $src.IndexOf("# Main - fully wrapped")
$funcsOnly = $src.Substring($fnStart, $mainAt - $fnStart)
# The functions use $FetchTimeoutSec (a script-level var defined above the cut);
# redefine it here so the dot-sourced functions resolve it.
$FetchTimeoutSec = 8
Invoke-Expression $funcsOnly

$core = (Resolve-Path "$PSScriptRoot/../../../PianoidCore").Path
$pass = 0; $fail = 0
function Check($label, $got, $expect) {
    $ok = ($got -eq $expect)
    if ($ok) { $script:pass++ } else { $script:fail++ }
    Write-Host ("  [{0}] {1}: got={2} expect={3}" -f $(if($ok){'PASS'}else{'FAIL'}), $label, $got, $expect)
}

Write-Host "=== Get-RepoAheadCount edges (Core currently on dev, +4 behind origin/dev) ==="
Check "primary valid ref"        (Get-RepoAheadCount -RepoPath $core -IntegrationBranch 'dev')             4
Check "bogus ref -> @{u} fallbk" (Get-RepoAheadCount -RepoPath $core -IntegrationBranch 'nonexistent_xyz') 4
Check "empty ref -> @{u} fallbk" (Get-RepoAheadCount -RepoPath $core -IntegrationBranch '')                4
Check "non-repo path -> unknown" (Get-RepoAheadCount -RepoPath "$core/does_not_exist" -IntegrationBranch 'dev') -1

Write-Host "=== ConvertTo-AheadCount unit checks ==="
Check "'7'"   (ConvertTo-AheadCount '7')   7
Check "'0'"   (ConvertTo-AheadCount '0')   0
Check "''"    (ConvertTo-AheadCount '')    -1
Check "null"  (ConvertTo-AheadCount $null) -1
Check "'abc'" (ConvertTo-AheadCount 'abc') -1
Check "' 3 '" (ConvertTo-AheadCount ' 3 ') 3

Write-Host ("=== RESULT: $pass passed / $fail failed ===")
if ($fail -gt 0) { exit 1 } else { exit 0 }
