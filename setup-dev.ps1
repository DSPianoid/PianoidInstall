# setup-dev.ps1
# Installs VS 2022 Build Tools (C++), SDL2 (flattened to C:\SDL2-<ver>), CUDA Toolkit,
# then writes build_config.json that setup.py expects.
# Works in Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding()]
param(
  [switch]$SkipVS,
  [switch]$SkipCUDA,
  [switch]$SkipSDL,
  [string]$CudaVersion = "13.0.0",   # used for non-winget fallback
  [string]$SdlVersion  = "2.30.8",
  [string]$SdlRoot     = "C:\"       # final path will be $SdlRoot\SDL2-$SdlVersion
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = [Security.Principal.WindowsPrincipal]$id
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this script in an elevated (Administrator) PowerShell."
  }
}

function Get-Tool($name) { Get-Command $name -ErrorAction SilentlyContinue }

function Invoke-Download($Url, $OutFile) {
  Write-Host "Downloading $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $OutFile
  if (-not (Test-Path $OutFile)) { throw "Download failed: $Url" }
}

function Ensure-VSBuildTools {
  if ($SkipVS) { return }
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $needInstall = $true
  if (Test-Path $vswhere) {
    $instPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($instPath) { $needInstall = $false }
  }
  if ($needInstall) {
    Write-Host "`n== Installing Visual Studio 2022 Build Tools (C++ workload) =="
    $tmp = Join-Path $env:TEMP "vs_buildtools.exe"
    Invoke-Download "https://aka.ms/vs/17/release/vs_buildtools.exe" $tmp
    $args = @(
      '--quiet','--wait','--norestart','--nocache',
      '--add','Microsoft.VisualStudio.Workload.VCTools',
      '--add','Microsoft.VisualStudio.Component.Windows10SDK.19041',
      '--add','Microsoft.VisualStudio.Component.VC.CMake.Project',
      '--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '--includeRecommended'
    )
    Start-Process $tmp -ArgumentList $args -NoNewWindow -Wait
  } else {
    Write-Host "VS Build Tools with C++ workload already present."
  }
}

function Get-VcBinHostx64x64 {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $inst = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    if ($inst) {
      $vcToolsRoot = Join-Path $inst 'VC\Tools\MSVC'
      $vcVer = (Get-ChildItem -Directory $vcToolsRoot | Sort-Object Name -Descending | Select-Object -First 1).FullName
      $bin = Join-Path $vcVer 'bin\Hostx64\x64'
      if (Test-Path $bin) { return $bin }
    }
  }
  $roots = @("$env:ProgramFiles\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio")
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $cl = Get-ChildItem -Path $r -Recurse -Filter cl.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like '*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe' } |
            Select-Object -First 1
      if ($cl) { return $cl.Directory.FullName }
    }
  }
  throw "MSVC bin\Hostx64\x64 not found. Make sure the C++ workload is installed."
}

function Ensure-SDL2 {
  if ($SkipSDL) { return $null }
  $final = Join-Path $SdlRoot ("SDL2-$SdlVersion")
  Write-Host "`n== Installing SDL2 $SdlVersion (VC) to $final =="

  # Download & expand to a temp staging folder, then move SDL2-<ver> directly to $final
  $zip   = Join-Path $env:TEMP "SDL2-devel-$SdlVersion-VC.zip"
  $stage = Join-Path $env:TEMP ("sdl2_unpack_" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  Invoke-Download "https://www.libsdl.org/release/SDL2-devel-$SdlVersion-VC.zip" $zip
  Expand-Archive -Path $zip -DestinationPath $stage -Force

  $src = (Get-ChildItem -Directory $stage | Where-Object { $_.Name -like 'SDL2-*' } |
          Sort-Object Name -Descending | Select-Object -First 1)
  if (-not $src) { throw "SDL2 base folder not found after extraction." }

  if (Test-Path $final) {
    Write-Host "Target $final already exists; keeping it and ignoring new files."
    # If you'd prefer replacing instead, uncomment the next line:
    # Remove-Item -Recurse -Force $final
  } else {
    $parent = Split-Path -Path $final -Parent
    if ($parent -and -not (Test-Path $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Move-Item -Path $src.FullName -Destination $final
  }

  # Cleanup staging
  Remove-Item -Recurse -Force $stage, $zip -ErrorAction SilentlyContinue
  return $final
}

function Ensure-CUDA {
  if ($SkipCUDA) { return $env:CUDA_PATH }
  $cuda = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine'); if (-not $cuda) { $cuda = $env:CUDA_PATH }
  if ($cuda -and (Test-Path $cuda)) { Write-Host "CUDA already installed at: $cuda"; return $cuda }

  Write-Host "`n== Installing CUDA Toolkit =="
  $winget = Get-Tool 'winget'
  if ($winget) {
    try {
      winget install -e --id Nvidia.CUDA --silent --accept-package-agreements --accept-source-agreements
      $cuda = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine'); if (-not $cuda) { $cuda = $env:CUDA_PATH }
      if ($cuda -and (Test-Path $cuda)) { return $cuda }
    } catch { Write-Warning "winget install failed, falling back to direct installer..." }
  }

  $tmp = Join-Path $env:TEMP "cuda_${CudaVersion}_windows_network.exe"
  $url = "https://developer.download.nvidia.com/compute/cuda/$CudaVersion/network_installers/cuda_${CudaVersion}_windows_network.exe"
  Invoke-Download $url $tmp
  Start-Process $tmp -ArgumentList @('-s','-n') -NoNewWindow -Wait

  $cuda = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine'); if (-not $cuda) { $cuda = $env:CUDA_PATH }
  if (-not ($cuda -and (Test-Path $cuda))) {
    $guess = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if (Test-Path $guess) {
      $cuda = (Get-ChildItem -Directory $guess | Where-Object { $_.Name -like 'v*' } |
               Sort-Object Name -Descending | Select-Object -First 1).FullName
    }
  }
  if (-not ($cuda -and (Test-Path $cuda))) { throw "CUDA Toolkit not found after install; please verify and rerun." }
  return $cuda
}

function Write-BuildConfig($CudaHome, $VcBin, $SdlBase) {
  $cfg = @{
    windows = @{
      cuda_home = $CudaHome
      visual_studio = @{ vc_tools_bin_hostx64_x64 = $VcBin }
      sdl2 = @{ base_path = $SdlBase }
    }
    cuda_arch_list = @('80','86','89')
  }
  $out = Join-Path (Get-Location) 'build_config.json'
  $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding UTF8
  Write-Host "`nbuild_config.json written to: $out"
  Write-Host "  cuda_home  : $CudaHome"
  Write-Host "  VC bin     : $VcBin"
  Write-Host "  SDL2 base  : $SdlBase"
}

# --- main ---
Assert-Admin
Ensure-VSBuildTools
$vcBin = Get-VcBinHostx64x64
& (Join-Path $vcBin 'cl.exe') /? | Out-Null  # sanity check

$sdlBase  = Ensure-SDL2
$cudaHome = Ensure-CUDA

Write-BuildConfig -CudaHome $cudaHome -VcBin $vcBin -SdlBase $sdlBase

Write-Host "`nDone. Open a NEW terminal so PATH updates are visible, then build with:"
Write-Host "  pip install -v ."
