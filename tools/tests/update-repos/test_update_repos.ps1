# =========================================================================
# test_update_repos.ps1 - sandbox test for update-repos.bat
#
# Builds throw-away git repos in a temp folder (bare "origin" remotes for
# PianoidInstall / PianoidCore / PianoidBasic / PianoidTunner, a working
# install laid out like a real one, and an "upstream" clone per repo that
# pushes new commits), then runs update-repos.bat against them for real.
#
# Nothing outside the sandbox is touched: the build scripts are fakes in the
# sandbox PianoidCore, and curl / netstat / taskkill / npm are stubs placed
# first on PATH (so the backend-stop step can never reach a real backend).
# Every stub call is appended to a log the assertions read.
#
# Usage (PowerShell, from anywhere):
#   powershell -ExecutionPolicy Bypass -File tools\tests\update-repos\test_update_repos.ps1
#   ... -ScriptPath <other update-repos.bat>   (e.g. an older version)
#   ... -Only S2                                (one scenario)
#   ... -Keep                                   (keep the sandbox folders)
# Exit 0 = all assertions passed, 1 = at least one failed.
# =========================================================================
param(
    [string] $ScriptPath = (Join-Path $PSScriptRoot '..\..\..\update-repos.bat'),
    [string] $Only = '',
    [switch] $Keep
)

$ErrorActionPreference = 'Continue'
$ScriptPath = (Resolve-Path $ScriptPath).Path
$Base = Join-Path ([IO.Path]::GetTempPath()) ("update-repos-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Base | Out-Null
$script:Failures = 0

# Git identity + byte-exact files for every git call (also the script's).
$env:GIT_CONFIG_COUNT = '3'
$env:GIT_CONFIG_KEY_0 = 'core.autocrlf';     $env:GIT_CONFIG_VALUE_0 = 'false'
$env:GIT_CONFIG_KEY_1 = 'user.name';         $env:GIT_CONFIG_VALUE_1 = 'update-repos-test'
$env:GIT_CONFIG_KEY_2 = 'user.email';        $env:GIT_CONFIG_VALUE_2 = 'test@example.invalid'

# ---- stubs --------------------------------------------------------------
$StubDir = Join-Path $Base 'stubs'
New-Item -ItemType Directory -Path $StubDir | Out-Null
$stubSrc = @'
using System; using System.IO;
public static class Stub {
    public static int Main(string[] a) {
        string log = Environment.GetEnvironmentVariable("STUB_LOG");
        string name = Path.GetFileNameWithoutExtension(
            System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName);
        if (log != null) File.AppendAllText(log, name + " " + string.Join(" ", a) + Environment.NewLine);
        return 0;
    }
}
'@
$stubExe = Join-Path $StubDir 'stub.exe'
Add-Type -TypeDefinition $stubSrc -OutputAssembly $stubExe -OutputType ConsoleApplication
foreach ($n in 'curl', 'netstat', 'taskkill') { Copy-Item $stubExe (Join-Path $StubDir "$n.exe") }
# npm is npm.cmd in real life (the script CALLs it); the stub logs its cwd.
Set-Content -Path (Join-Path $StubDir 'npm.cmd') -Encoding ASCII -Value "@echo npm %* cwd=%CD%>>`"%STUB_LOG%`"`r`n@exit /b 0"

# ---- helpers ------------------------------------------------------------
function Invoke-Git([string] $Dir, [string[]] $GitArgs) {
    $out = & git -C $Dir @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git -C $Dir $($GitArgs -join ' ') failed: $out" }
    return $out
}
function Write-File([string] $Path, [string] $Text) {
    $d = Split-Path $Path
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, [Text.Encoding]::ASCII)
}
function Head([string] $Dir) { return [string](Invoke-Git $Dir @('rev-parse', 'HEAD')) }

# Push one commit with the given files (path -> text) from the upstream clone.
function Push-Change($Sb, [string] $Repo, [hashtable] $Files, [string] $Branch) {
    $up = $Sb.Up[$Repo]
    foreach ($k in $Files.Keys) { Write-File (Join-Path $up $k) $Files[$k] }
    Invoke-Git $up @('add', '-A') | Out-Null
    Invoke-Git $up @('commit', '-q', '-m', "upstream change in $Repo") | Out-Null
    Invoke-Git $up @('push', '-q', 'origin', "HEAD:$Branch") | Out-Null
}

function New-Sandbox([string] $Name, [string] $InstallScriptText) {
    $root = Join-Path $Base $Name
    $sb = @{ Root = $root; Up = @{}; Work = @{}; Log = (Join-Path $root 'stub.log'); Tmp = (Join-Path $root 'tmp') }
    New-Item -ItemType Directory -Path $sb.Tmp -Force | Out-Null
    $spec = @(
        @{ Repo = 'install'; Branch = 'master'; Files = @{
            'update-repos.bat' = $InstallScriptText
            '.gitignore' = "/PianoidCore/`n/PianoidBasic/`n/PianoidTunner/`nnode_modules/`n"
            'tools/pianoid-assistant/package.json' = '{"name":"assistant","version":"1.0.0"}'
            'README.md' = "install`n" } },
        @{ Repo = 'core'; Branch = 'dev'; Files = @{
            'build_pianoid_cuda.bat'  = "@echo build_pianoid_cuda %*>>`"%STUB_LOG%`"`r`n@exit /b 0`r`n"
            'build_pianoid_basic.bat' = "@echo build_pianoid_basic %*>>`"%STUB_LOG%`"`r`n@exit /b 0`r`n"
            'pianoid_cuda/Pianoid.cu' = "// v1`n"
            'pianoid_middleware/backendServer.py' = "# v1`n" } },
        @{ Repo = 'basic'; Branch = 'dev'; Files = @{ 'Pianoid/model.py' = "# v1`n" } },
        @{ Repo = 'tunner'; Branch = 'dev'; Files = @{ 'package.json' = '{"name":"tunner"}'; 'src/App.js' = "// v1`n" } }
    )
    foreach ($s in $spec) {
        $bare = Join-Path $root "remotes\$($s.Repo).git"
        & git init -q --bare -b $s.Branch $bare
        $up = Join-Path $root "up\$($s.Repo)"
        & git clone -q $bare $up 2>&1 | Out-Null
        Invoke-Git $up @('checkout', '-q', '-b', $s.Branch) | Out-Null
        foreach ($k in $s.Files.Keys) { Write-File (Join-Path $up $k) $s.Files[$k] }
        Invoke-Git $up @('add', '-A') | Out-Null
        Invoke-Git $up @('commit', '-q', '-m', 'initial') | Out-Null
        Invoke-Git $up @('push', '-q', '-u', 'origin', $s.Branch) | Out-Null
        $sb.Up[$s.Repo] = $up
    }
    $inst = Join-Path $root 'work\PianoidInstall'
    & git clone -q -b master (Join-Path $root 'remotes\install.git') $inst 2>&1 | Out-Null
    $sb.Work['install'] = $inst
    foreach ($p in @(@('core', 'PianoidCore'), @('basic', 'PianoidBasic'), @('tunner', 'PianoidTunner'))) {
        $d = Join-Path $inst $p[1]
        & git clone -q -b dev (Join-Path $root "remotes\$($p[0]).git") $d 2>&1 | Out-Null
        $sb.Work[$p[0]] = $d
    }
    New-Item -ItemType Directory -Path (Join-Path $inst 'PianoidTunner\node_modules') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $inst 'tools\pianoid-assistant\node_modules') | Out-Null
    return $sb
}

# Run the sandbox's own update-repos.bat; returns @{ Out; Code; Stub }.
function Invoke-Update($Sb, [string] $ScriptArgs = '') {
    if (Test-Path $Sb.Log) { Remove-Item $Sb.Log }
    $savedPath = $env:PATH; $savedTemp = $env:TEMP; $savedTmp = $env:TMP
    try {
        $env:PATH = "$StubDir;$env:PATH"
        $env:STUB_LOG = $Sb.Log
        $env:TEMP = $Sb.Tmp; $env:TMP = $Sb.Tmp
        $bat = Join-Path $Sb.Work['install'] 'update-repos.bat'
        $out = & cmd /c "call `"$bat`" $ScriptArgs 2>&1"
        $code = $LASTEXITCODE
    } finally {
        $env:PATH = $savedPath; $env:TEMP = $savedTemp; $env:TMP = $savedTmp
        Remove-Item Env:STUB_LOG -ErrorAction SilentlyContinue
    }
    $stub = if (Test-Path $Sb.Log) { Get-Content $Sb.Log } else { @() }
    return @{ Out = ($out -join "`n"); Code = $code; Stub = @($stub) }
}

function Check([string] $Label, [bool] $Ok, [string] $Detail = '') {
    if ($Ok) { Write-Host "  PASS  $Label" }
    else { Write-Host "  FAIL  $Label $Detail" -ForegroundColor Red; $script:Failures++ }
}
function Has($R, [string] $Text) { return $R.Out.Contains($Text) }
function StubHas($R, [string] $Pattern) { return [bool]($R.Stub | Where-Object { $_ -like $Pattern }) }
function Show($R) { if ($env:UPDATE_REPOS_TEST_VERBOSE) { Write-Host $R.Out } }

$ScriptText = [IO.File]::ReadAllText($ScriptPath)
function Run-Scenario([string] $Id) { return ($Only -eq '' -or $Only -eq $Id) }

# ---- S1: everything behind -> all four pulled, matrix builds ---------------
if (Run-Scenario 'S1') {
    Write-Host "S1 all repos behind: pull all four + rebuild per matrix"
    $sb = New-Sandbox 'S1' $ScriptText
    Push-Change $sb 'install' @{ 'tools/pianoid-assistant/package.json' = '{"name":"assistant","version":"1.1.0"}' } 'master'
    Push-Change $sb 'core' @{ 'pianoid_cuda/Pianoid.cu' = "// v2`n" } 'dev'
    Push-Change $sb 'basic' @{ 'Pianoid/model.py' = "# v2`n" } 'dev'
    Push-Change $sb 'tunner' @{ 'package.json' = '{"name":"tunner","v":2}' } 'dev'
    $r = Invoke-Update $sb; Show $r
    Check 'exit code 0' ($r.Code -eq 0) "(got $($r.Code))"
    foreach ($repo in 'install', 'core', 'basic', 'tunner') {
        Check "$repo pulled to origin" ((Head $sb.Work[$repo]) -eq (Head $sb.Up[$repo]))
    }
    Check 'Basic build ran' (StubHas $r 'build_pianoid_basic*')
    Check 'CUDA build ran --heavy --both' (StubHas $r 'build_pianoid_cuda --heavy --both*')
    Check 'backend stopped via launcher REST before CUDA build' (StubHas $r 'curl -s -X POST http://127.0.0.1:3001/api/stop-backend')
    Check 'npm install in PianoidTunner' (StubHas $r 'npm install cwd=*PianoidTunner')
    Check 'npm install in tools\pianoid-assistant' (StubHas $r 'npm install cwd=*pianoid-assistant')
    Check 'summary printed to the end' (Has $r 'To start the application')
    Check 'temp copy removed' (@(Get-ChildItem $sb.Tmp -Filter 'pianoid-update-repos-*.bat').Count -eq 0)
}

# ---- S2: the pull updates update-repos.bat itself -> hand-over -------------
if (Run-Scenario 'S2') {
    Write-Host "S2 PianoidInstall pull rewrites update-repos.bat: new version takes over"
    $sb = New-Sandbox 'S2' $ScriptText
    $marker = 'echo Pianoid Repo Update  (pull + rebuild what changed)'
    if (-not $ScriptText.Contains($marker)) { throw "marker line not found in $ScriptPath" }
    # The new version: one extra banner line plus 4 KB of extra comment lines,
    # so every byte offset of the old file now points somewhere else.
    $pad = ("rem padding line to shift every offset of the running file`r`n" * 70)
    $newText = $ScriptText.Replace($marker, "$marker`r`necho SELFTEST-NEW-VERSION").Replace("setlocal enabledelayedexpansion`r`n", "setlocal enabledelayedexpansion`r`n$pad")
    Push-Change $sb 'install' @{ 'update-repos.bat' = $newText; 'tools/pianoid-assistant/package.json' = '{"v":3}' } 'master'
    Push-Change $sb 'core' @{ 'pianoid_middleware/backendServer.py' = "# v2`n" } 'dev'
    $r = Invoke-Update $sb; Show $r
    Check 'exit code 0' ($r.Code -eq 0) "(got $($r.Code))"
    Check 'install pulled (new script on disk)' ((Head $sb.Work['install']) -eq (Head $sb.Up['install']))
    Check 'hand-over announced' (Has $r 'continuing with the new version')
    Check 'new version ran' (Has $r 'SELFTEST-NEW-VERSION')
    Check 'new version did not pull PianoidInstall again' (Has $r 'Already pulled by the previous version')
    Check 'assistant deps change seen across the hand-over' (StubHas $r 'npm install cwd=*pianoid-assistant')
    Check 'core pulled' ((Head $sb.Work['core']) -eq (Head $sb.Up['core']))
    Check 'middleware-only Core change -> no CUDA build (C2)' (-not (StubHas $r 'build_pianoid_cuda*'))
    Check 'no "unexpected" parse error' (-not (Has $r 'was unexpected'))
    Check 'temp copies removed' (@(Get-ChildItem $sb.Tmp -Filter 'pianoid-update-repos-*.bat').Count -eq 0)
}

# ---- S3: dirty install + feature-branch core -> skipped, rest updated -----
if (Run-Scenario 'S3') {
    Write-Host "S3 dirty PianoidInstall + Core on a feature branch: both skipped"
    $sb = New-Sandbox 'S3' $ScriptText
    Push-Change $sb 'install' @{ 'README.md' = "install v2`n" } 'master'
    Push-Change $sb 'core' @{ 'pianoid_cuda/Pianoid.cu' = "// v2`n" } 'dev'
    Push-Change $sb 'basic' @{ 'Pianoid/model.py' = "# v2`n" } 'dev'
    Write-File (Join-Path $sb.Work['install'] 'README.md') "local edit`n"
    Invoke-Git $sb.Work['core'] @('checkout', '-q', '-b', 'feature/x') | Out-Null
    $preInstall = Head $sb.Work['install']; $preCore = Head $sb.Work['core']
    $r = Invoke-Update $sb; Show $r
    Check 'exit code 0' ($r.Code -eq 0) "(got $($r.Code))"
    Check 'install NOT pulled (local changes)' ((Head $sb.Work['install']) -eq $preInstall)
    Check 'install reported SKIPPED (local changes)' (Has $r 'SKIPPED (local changes)')
    Check 'core NOT pulled (feature branch)' ((Head $sb.Work['core']) -eq $preCore)
    Check "core reported SKIPPED (on 'feature/x')" (Has $r "SKIPPED (on 'feature/x', not 'dev')")
    Check 'core skipped -> no CUDA build' (-not (StubHas $r 'build_pianoid_cuda*'))
    Check 'basic pulled + built' (((Head $sb.Work['basic']) -eq (Head $sb.Up['basic'])) -and (StubHas $r 'build_pianoid_basic*'))
}

# ---- S4: --dry-run -> nothing changes, decisions printed -------------------
if (Run-Scenario 'S4') {
    Write-Host "S4 --dry-run: fetch only, no pull / build / npm"
    $sb = New-Sandbox 'S4' $ScriptText
    Push-Change $sb 'install' @{ 'update-repos.bat' = ($ScriptText + "rem v2`r`n"); 'tools/pianoid-assistant/package.json' = '{"v":2}' } 'master'
    Push-Change $sb 'core' @{ 'build_config.json' = '{"v":2}' } 'dev'
    Push-Change $sb 'basic' @{ 'Pianoid/model.py' = "# v2`n" } 'dev'
    Push-Change $sb 'tunner' @{ 'src/App.js' = "// v2`n" } 'dev'
    $pre = @{}; foreach ($repo in 'install', 'core', 'basic', 'tunner') { $pre[$repo] = Head $sb.Work[$repo] }
    $r = Invoke-Update $sb '--dry-run'; Show $r
    Check 'exit code 0' ($r.Code -eq 0) "(got $($r.Code))"
    foreach ($repo in 'install', 'core', 'basic', 'tunner') {
        Check "$repo HEAD unchanged" ((Head $sb.Work[$repo]) -eq $pre[$repo])
    }
    Check 'no stub called (no stop / build / npm)' ($r.Stub.Count -eq 0) "($($r.Stub -join '; '))"
    Check 'reports the self-update' (Has $r 'the pull would update update-repos.bat')
    Check 'build_config.json -> CUDA decision' (Has $r '-> Rebuild CUDA                : 1')
    Check 'Basic decision' (Has $r '-> Rebuild PianoidBasic        : 1')
    Check 'assistant npm decision' (Has $r '-> npm install (assistant)     : 1')
    Check 'Tunner src-only -> no npm' (Has $r '-> npm install (PianoidTunner) : 0')
}

# ---- S5: diverged Core -> dry run says WOULD FAIL, real run fails ----------
if (Run-Scenario 'S5') {
    Write-Host "S5 diverged PianoidCore dev"
    $sb = New-Sandbox 'S5' $ScriptText
    Push-Change $sb 'core' @{ 'pianoid_cuda/Pianoid.cu' = "// remote`n" } 'dev'
    Write-File (Join-Path $sb.Work['core'] 'local.txt') "x`n"
    Invoke-Git $sb.Work['core'] @('add', '-A') | Out-Null
    Invoke-Git $sb.Work['core'] @('commit', '-q', '-m', 'local commit') | Out-Null
    $r = Invoke-Update $sb '--dry-run'; Show $r
    Check 'dry run: WOULD FAIL reported' (Has $r 'WOULD FAIL (diverged from origin/dev)')
    $r = Invoke-Update $sb; Show $r
    Check 'real run: exit code 1' ($r.Code -eq 1) "(got $($r.Code))"
    Check 'real run: UPDATE FAILED' (Has $r 'UPDATE FAILED')
    Check 'real run: no build' (-not (StubHas $r 'build_pianoid_*'))
}

if (-not $Keep) { Remove-Item -Recurse -Force $Base -ErrorAction SilentlyContinue }
else { Write-Host "sandbox kept: $Base" }
Write-Host ""
if ($script:Failures -eq 0) { Write-Host "ALL PASSED"; exit 0 }
Write-Host "$($script:Failures) FAILED" -ForegroundColor Red
exit 1
