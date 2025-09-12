# setup-dev.ps1
# Installs Python, VS 2022 Build Tools (C++), SDL2, CUDA Toolkit, Node.js
# Supports configuration file for version management
# Works in Windows PowerShell 5.1 and PowerShell 7+.

[CmdletBinding()]
param(
  [switch]$SkipVS,
  [switch]$SkipCUDA,
  [switch]$SkipSDL,
  [switch]$SkipNode,           # Skip Node.js installation
  [switch]$SkipPython,         # Skip Python installation
  [switch]$ForceReinstall,      # Force reinstall all components
  [switch]$ForceVS,            # Force reinstall VS Build Tools
  [switch]$ForceCUDA,          # Force reinstall CUDA
  [switch]$ForceSDL,           # Force reinstall SDL2
  [switch]$ForceNode,          # Force reinstall Node.js
  [switch]$ForcePython,        # Force reinstall Python
  [string]$ConfigFile = "setup-config.json",  # Configuration file path
  [string]$CudaVersion = "",    # Override config file version
  [string]$SdlVersion = "",     # Override config file version
  [string]$NodeVersion = "",    # Override config file version
  [string]$PythonVersion = "",  # Override config file version
  [string]$SdlRoot = ""         # Override config file path
)

$ErrorActionPreference = 'Stop'

# Default versions (used when config file doesn't exist or values are missing)
$DefaultVersions = @{
  python = "3.12.0"
  cuda = "12.6.0"
  nodejs = "20.18.0"
  sdl2 = "2.30.8"
}

$DefaultPaths = @{
  sdl2_root = "C:\"
}

$DefaultCudaArchs = @("75", "80", "86", "89")

function Load-Configuration {
  param([string]$ConfigPath)
  
  $config = @{
    versions = $DefaultVersions.Clone()
    paths = $DefaultPaths.Clone()
    cuda = @{ architectures = $DefaultCudaArchs }
    options = @{
      skip_components = @()
      force_reinstall_components = @()
      auto_reboot = $false
      clean_install = $true
    }
  }
  
  if (Test-Path $ConfigPath) {
    Write-Host "Loading configuration from: $ConfigPath"
    try {
      $configData = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
      
      # Merge versions (use config values, fall back to defaults)
      if ($configData.versions) {
        foreach ($key in $configData.versions.PSObject.Properties.Name) {
          if ($configData.versions.$key) {
            $config.versions[$key] = $configData.versions.$key
            Write-Host "Config: $key = $($configData.versions.$key)"
          }
        }
      }
      
      # Merge paths
      if ($configData.paths) {
        foreach ($key in $configData.paths.PSObject.Properties.Name) {
          if ($configData.paths.$key) {
            $config.paths[$key] = $configData.paths.$key
          }
        }
      }
      
      # Merge CUDA architectures
      if ($configData.cuda -and $configData.cuda.architectures) {
        $config.cuda.architectures = $configData.cuda.architectures
      }
      
      # Merge options
      if ($configData.options) {
        foreach ($key in $configData.options.PSObject.Properties.Name) {
          $config.options[$key] = $configData.options.$key
        }
      }
      
    } catch {
      Write-Warning "Failed to parse config file: $_"
      Write-Host "Using default values"
    }
  } else {
    Write-Host "Config file not found: $ConfigPath"
    Write-Host "Using default versions"
  }
  
  # Apply command line overrides
  if ($PythonVersion) { $config.versions.python = $PythonVersion }
  if ($CudaVersion) { $config.versions.cuda = $CudaVersion }
  if ($NodeVersion) { $config.versions.nodejs = $NodeVersion }  
  if ($SdlVersion) { $config.versions.sdl2 = $SdlVersion }
  if ($SdlRoot) { $config.paths.sdl2_root = $SdlRoot }
  
  return $config
}

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = [Security.Principal.WindowsPrincipal]$id
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this script in an elevated (Administrator) PowerShell."
  }
}

function Get-Tool($name) { 
  Get-Command $name -ErrorAction SilentlyContinue 
}

function Invoke-Download($Url, $OutFile) {
  Write-Host "Downloading $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $OutFile
  if (-not (Test-Path $OutFile)) { 
    throw "Download failed: $Url" 
  }
}

function Ensure-Python {
  param([string]$Version)
  
  if ($SkipPython) { 
    return $null 
  }
  
  # Check if Python is already installed
  $forceRequested = $ForceReinstall -or $ForcePython
  $python = Get-Tool 'python'
  
  if ($python -and (-not $forceRequested)) {
    try {
      $currentVersion = & $python --version 2>&1
      if ($currentVersion -match "Python (\d+\.\d+\.\d+)") {
        $installedVersion = $Matches[1]
        Write-Host "Python already installed: $currentVersion"
        if ($installedVersion -eq $Version) {
          Write-Host "Correct version already installed."
          # Also check pip
          $pip = Get-Tool 'pip'
          if ($pip) {
            $pipVersion = & $pip --version
            Write-Host "pip available: $pipVersion"
          }
          return $python.Source
        } else {
          Write-Host "Different version found, will install Python $Version"
        }
      }
    } catch {
      Write-Host "Python found but version check failed, proceeding with installation"
    }
  }
  
  if ($forceRequested) {
    Write-Host "Force reinstall requested for Python"
  }

  Write-Host "`n== Installing Python $Version =="
  
  # Try winget first
  $winget = Get-Tool 'winget'
  if ($winget) {
    try {
      Write-Host "Attempting to install Python $Version via winget..."
      & $winget install -e --id Python.Python.3.12 --version $Version --silent --accept-package-agreements --accept-source-agreements
      Start-Sleep -Seconds 5
      
      # Refresh PATH and test
      $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
      $python = Get-Tool 'python'
      
      if ($python) { 
        $installedVersion = & $python --version
        Write-Host "Python installed successfully: $installedVersion"
        return $python.Source
      }
    } catch { 
      Write-Warning "winget install failed, falling back to direct installer..." 
    }
  }

  # Fallback to direct installer
  Write-Host "Using direct installer method..."
  
  # Determine architecture
  $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "win32" }
  Write-Host "Detected architecture: $arch"
  
  # Construct download URL
  $url = "https://www.python.org/ftp/python/$Version/python-$Version-$arch.exe"
  $tmp = Join-Path $env:TEMP "python-$Version-installer.exe"
  
  try {
    Write-Host "Downloading Python $Version..."
    Invoke-Download $url $tmp
    
    Write-Host "Running Python installer..."
    $installArgs = @(
      '/quiet',
      'InstallAllUsers=0',
      'PrependPath=1',
      'Include_test=0',
      'Include_pip=1',
      'Include_doc=1',
      'Include_dev=1',
      'Include_launcher=1'
    )
    
    Start-Process $tmp -ArgumentList $installArgs -NoNewWindow -Wait
    
    # Cleanup installer
    Remove-Item $tmp -ErrorAction SilentlyContinue
    
    # Refresh PATH and test
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
    $python = Get-Tool 'python'
    
    if ($python) { 
      $installedVersion = & $python --version
      Write-Host "Python installed successfully: $installedVersion"
      
      # Verify pip
      $pip = Get-Tool 'pip'
      if ($pip) {
        $pipVersion = & $pip --version
        Write-Host "pip installed successfully: $pipVersion"
      }
      
      return $python.Source
    } else {
      throw "Python installation failed or not found in PATH"
    }
  } catch {
    throw "Failed to install Python: $_"
  }
}

function Uninstall-CUDA {
  Write-Host "`n== Uninstalling existing CUDA installations =="
  
  # Try winget uninstall first
  $winget = Get-Tool 'winget'
  if ($winget) {
    try {
      Write-Host "Attempting to uninstall CUDA via winget..."
      & $winget uninstall --id Nvidia.CUDA --silent --accept-source-agreements
    } catch {
      Write-Warning "winget uninstall failed, continuing with manual cleanup..."
    }
  }

  # Manual cleanup of CUDA environment variables and common paths
  $cudaPaths = @(
    "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA",
    "C:\ProgramData\NVIDIA Corporation\CUDA Samples"
  )
  
  foreach ($path in $cudaPaths) {
    if (Test-Path $path) {
      Write-Host "Removing CUDA directory: $path"
      try {
        Remove-Item -Path $path -Recurse -Force -ErrorAction Continue
      } catch {
        Write-Warning "Could not fully remove $path - some files may be in use"
      }
    }
  }

  # Clear CUDA environment variables
  [Environment]::SetEnvironmentVariable('CUDA_PATH', $null, 'Machine')
  [Environment]::SetEnvironmentVariable('CUDA_PATH_V13_0', $null, 'Machine')
  [Environment]::SetEnvironmentVariable('CUDA_PATH_V12_6', $null, 'Machine')
  
  Write-Host "CUDA cleanup completed. A reboot may be required for full cleanup."
}

function Ensure-VSBuildTools {
  if ($SkipVS) { 
    return 
  }
  
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $needInstall = $true
  
  $forceRequested = $ForceReinstall -or $ForceVS
  
  if ((Test-Path $vswhere) -and (-not $forceRequested)) {
    $instPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($instPath) { 
      Write-Host "VS Build Tools found at: $instPath"
      $needInstall = $false 
    }
  }
  
  if ($forceRequested) {
    Write-Host "Force reinstall requested for VS Build Tools"
    $needInstall = $true
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
      if (Test-Path $bin) { 
        return $bin 
      }
    }
  }
  
  $roots = @("$env:ProgramFiles\Microsoft Visual Studio", "${env:ProgramFiles(x86)}\Microsoft Visual Studio")
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $cl = Get-ChildItem -Path $r -Recurse -Filter cl.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like '*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe' } |
            Select-Object -First 1
      if ($cl) { 
        return $cl.Directory.FullName 
      }
    }
  }
  throw "MSVC bin\Hostx64\x64 not found. Make sure the C++ workload is installed."
}

function Ensure-NodeJS {
  param([string]$Version)
  
  if ($SkipNode) { 
    return $null 
  }
  
  # Check if Node.js is already installed
  $forceRequested = $ForceReinstall -or $ForceNode
  $node = Get-Tool 'node'
  
  if ($node -and (-not $forceRequested)) {
    $currentVersion = & $node --version
    Write-Host "Node.js already installed: $currentVersion"
    if ($currentVersion -like "v$Version*") {
      Write-Host "Correct version already installed."
      return $node.Source
    } else {
      Write-Host "Different version found, will install Node.js $Version"
    }
  }
  
  if ($forceRequested) {
    Write-Host "Force reinstall requested for Node.js"
  }

  Write-Host "`n== Installing Node.js $Version =="
  $winget = Get-Tool 'winget'
  if ($winget) {
    try {
      Write-Host "Attempting to install Node.js $Version via winget..."
      & $winget install -e --id OpenJS.NodeJS --version $Version --silent --accept-package-agreements --accept-source-agreements
      Start-Sleep -Seconds 5
      
      # Refresh PATH and test
      $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
      $node = Get-Tool 'node'
      
      if ($node) { 
        $installedVersion = & $node --version
        Write-Host "Node.js installed successfully: $installedVersion"
        return $node.Source
      }
    } catch { 
      Write-Warning "winget install failed, falling back to direct installer..." 
    }
  }

  # Fallback to direct installer
  Write-Host "Downloading Node.js $Version installer..."
  $tmp = Join-Path $env:TEMP "node-v$Version-x64.msi"
  $url = "https://nodejs.org/dist/v$Version/node-v$Version-x64.msi"
  
  try {
    Invoke-Download $url $tmp
    Write-Host "Running Node.js installer..."
    Start-Process "msiexec.exe" -ArgumentList @('/i', $tmp, '/quiet', '/norestart') -NoNewWindow -Wait
    
    # Refresh PATH and test
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
    $node = Get-Tool 'node'
    
    if ($node) { 
      $installedVersion = & $node --version
      Write-Host "Node.js installed successfully: $installedVersion"
      return $node.Source
    } else {
      throw "Node.js installation failed or not found in PATH"
    }
  } catch {
    throw "Failed to install Node.js: $_"
  }
}

function Ensure-SDL2 {
  param([string]$Version, [string]$SdlRoot)
  
  if ($SkipSDL) { 
    return $null 
  }
  
  $final = Join-Path $SdlRoot ("SDL2-$Version")
  $forceRequested = $ForceReinstall -or $ForceSDL
  
  if ($forceRequested) {
    Write-Host "Force reinstall requested for SDL2"
    if (Test-Path $final) {
      Write-Host "Removing existing SDL2 installation: $final"
      Remove-Item -Recurse -Force $final
    }
  }
  
  if ((Test-Path $final) -and (-not $forceRequested)) {
    Write-Host "SDL2 $Version already installed at: $final"
    return $final
  }
  
  Write-Host "`n== Installing SDL2 $Version (VC) to $final =="

  $zip   = Join-Path $env:TEMP "SDL2-devel-$Version-VC.zip"
  $stage = Join-Path $env:TEMP ("sdl2_unpack_" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  Invoke-Download "https://www.libsdl.org/release/SDL2-devel-$Version-VC.zip" $zip
  Expand-Archive -Path $zip -DestinationPath $stage -Force

  $src = (Get-ChildItem -Directory $stage | Where-Object { $_.Name -like 'SDL2-*' } |
          Sort-Object Name -Descending | Select-Object -First 1)
  if (-not $src) { 
    throw "SDL2 base folder not found after extraction." 
  }

  $parent = Split-Path -Path $final -Parent
  if ($parent -and (-not (Test-Path $parent))) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  Move-Item -Path $src.FullName -Destination $final

  # Cleanup staging
  Remove-Item -Recurse -Force $stage, $zip -ErrorAction SilentlyContinue
  return $final
}

function Ensure-CUDA {
  param([string]$Version)
  
  if ($SkipCUDA) { 
    return $env:CUDA_PATH 
  }
  
  # Check if force reinstall is requested
  $forceRequested = $ForceReinstall -or $ForceCUDA
  if ($forceRequested) {
    Write-Host "Force reinstall requested for CUDA"
    Uninstall-CUDA
    # Refresh environment variables after uninstall
    $env:CUDA_PATH = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine')
  }
  
  $cuda = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine')
  if (-not $cuda) { 
    $cuda = $env:CUDA_PATH 
  }
  
  if ($cuda -and (Test-Path $cuda) -and (-not $forceRequested)) { 
    Write-Host "CUDA already installed at: $cuda"; 
    return $cuda 
  }

  Write-Host "`n== Installing CUDA Toolkit $Version =="
  $winget = Get-Tool 'winget'
  if ($winget) {
    try {
      Write-Host "Attempting to install CUDA $Version via winget..."
      & $winget install -e --id Nvidia.CUDA --version $Version --silent --accept-package-agreements --accept-source-agreements
      Start-Sleep -Seconds 10
      
      # Refresh environment variables
      $env:CUDA_PATH = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine')
      $cuda = $env:CUDA_PATH
      
      if ($cuda -and (Test-Path $cuda)) { 
        return $cuda 
      }
    } catch { 
      Write-Warning "winget install failed, falling back to direct installer..." 
    }
  }

  # Fallback to direct installer
  Write-Host "Downloading CUDA $Version installer..."
  $tmp = Join-Path $env:TEMP "cuda_${Version}_windows_network.exe"
  $url = "https://developer.download.nvidia.com/compute/cuda/$Version/network_installers/cuda_${Version}_windows_network.exe"
  
  try {
    Invoke-Download $url $tmp
  } catch {
    # Try local installer as fallback
    $localUrl = "https://developer.download.nvidia.com/compute/cuda/$Version/local_installers/cuda_${Version}_windows.exe"
    $tmp = Join-Path $env:TEMP "cuda_${Version}_windows.exe"
    Write-Host "Network installer failed, trying local installer..."
    Invoke-Download $localUrl $tmp
  }
  
  Write-Host "Running CUDA installer (this may take several minutes)..."
  Start-Process $tmp -ArgumentList @('-s','-n') -NoNewWindow -Wait

  # Refresh and find CUDA installation
  $env:CUDA_PATH = [Environment]::GetEnvironmentVariable('CUDA_PATH','Machine')
  $cuda = $env:CUDA_PATH
  
  if (-not ($cuda -and (Test-Path $cuda))) {
    $guess = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if (Test-Path $guess) {
      $cuda = (Get-ChildItem -Directory $guess | Where-Object { $_.Name -like 'v*' } |
               Sort-Object Name -Descending | Select-Object -First 1).FullName
    }
  }
  
  if (-not ($cuda -and (Test-Path $cuda))) { 
    throw "CUDA Toolkit not found after install; please verify and rerun." 
  }
  return $cuda
}

function Write-BuildConfig($CudaHome, $VcBin, $SdlBase, $CudaArchs) {
  $cfg = @{
    windows = @{
      cuda_home = $CudaHome
      visual_studio = @{ vc_tools_bin_hostx64_x64 = $VcBin }
      sdl2 = @{ base_path = $SdlBase }
    }
    cuda_arch_list = $CudaArchs
  }
  $out = Join-Path (Get-Location) 'build_config.json'
  $cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $out -Encoding UTF8
  Write-Host "`nbuild_config.json written to: $out"
  Write-Host "  cuda_home  : $CudaHome"
  Write-Host "  VC bin     : $VcBin"
  Write-Host "  SDL2 base  : $SdlBase"
}

# --- main ---
Write-Host "=== PianoidCore Development Environment Setup ==="

# Load configuration
$config = Load-Configuration $ConfigFile

Write-Host "Python Version: $($config.versions.python)"
Write-Host "CUDA Version: $($config.versions.cuda)"
Write-Host "Node.js Version: $($config.versions.nodejs)"
Write-Host "SDL2 Version: $($config.versions.sdl2)"

if ($ForceReinstall) { 
  Write-Host "Force reinstall: ALL components" 
}
elseif ($ForceVS -or $ForceCUDA -or $ForceSDL -or $ForceNode -or $ForcePython) {
  $components = @()
  if ($ForceVS) { $components += 'VS' }
  if ($ForceCUDA) { $components += 'CUDA' }
  if ($ForceSDL) { $components += 'SDL2' }
  if ($ForceNode) { $components += 'Node.js' }
  if ($ForcePython) { $components += 'Python' }
  Write-Host "Force reinstall: $($components -join ' ')"
}

Assert-Admin

# Install in logical order
$python   = Ensure-Python -Version $config.versions.python
Ensure-VSBuildTools
$vcBin = Get-VcBinHostx64x64
& (Join-Path $vcBin 'cl.exe') /? | Out-Null  # sanity check

$sdlBase  = Ensure-SDL2 -Version $config.versions.sdl2 -SdlRoot $config.paths.sdl2_root
$nodeJs   = Ensure-NodeJS -Version $config.versions.nodejs
$cudaHome = Ensure-CUDA -Version $config.versions.cuda

Write-BuildConfig -CudaHome $cudaHome -VcBin $vcBin -SdlBase $sdlBase -CudaArchs $config.cuda.architectures

Write-Host "`n=== Setup Complete ==="
if ($python) { Write-Host "Python $($config.versions.python) installed at: $python" }
Write-Host "CUDA $($config.versions.cuda) installed at: $cudaHome"
if ($nodeJs) { Write-Host "Node.js installed at: $nodeJs" }
Write-Host "Open a NEW terminal so PATH updates are visible, then build with:"
Write-Host "  pip install -v ."