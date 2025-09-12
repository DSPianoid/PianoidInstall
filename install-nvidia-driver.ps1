# install-nvidia-driver.ps1
# Simple NVIDIA driver installer

[CmdletBinding()]
param(
    [switch]$CleanInstall,
    [switch]$NoReboot
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = [Security.Principal.WindowsPrincipal]$id
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Please run this script as Administrator"
    }
}

function Get-GPUInfo {
    Write-Host "Detecting NVIDIA GPU..."
    $gpus = Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -like "*NVIDIA*" }
    
    if (-not $gpus) {
        throw "No NVIDIA GPU detected"
    }
    
    $gpu = $gpus[0]
    Write-Host "Found GPU: $($gpu.Name)"
    Write-Host "Current driver: $($gpu.DriverVersion)"
    return $gpu
}

function Install-DriverViaWinget {
    Write-Host "Installing NVIDIA driver via winget..."
    $winget = Get-Command 'winget' -ErrorAction SilentlyContinue
    
    if (-not $winget) {
        return $false
    }
    
    try {
        & winget install --id NVIDIA.GeForceExperience --silent --accept-package-agreements --accept-source-agreements
        return $true
    } catch {
        Write-Warning "Winget installation failed"
        return $false
    }
}

function Install-DriverManual {
    Write-Host "Opening NVIDIA drivers page for manual download..."
    Write-Host "1. Download the latest driver for your GPU"
    Write-Host "2. Run the installer as Administrator"
    
    if ($CleanInstall) {
        Write-Host "3. Choose 'Custom Installation' and select 'Clean Installation'"
    }
    
    try {
        Start-Process "https://www.nvidia.com/drivers"
    } catch {
        Write-Host "Please visit: https://www.nvidia.com/drivers"
    }
    
    Read-Host "Press Enter after installing the driver manually"
}

function Test-Installation {
    Write-Host "Verifying installation..."
    $nvidiaSmi = Get-Command 'nvidia-smi' -ErrorAction SilentlyContinue
    
    if ($nvidiaSmi) {
        try {
            $version = & nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits
            Write-Host "Driver installed successfully: $version"
            return $true
        } catch {
            Write-Warning "nvidia-smi not responding properly"
        }
    }
    
    Write-Host "Checking Device Manager..."
    $gpu = Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -like "*NVIDIA*" } | Select-Object -First 1
    if ($gpu) {
        Write-Host "GPU: $($gpu.Name)"
        Write-Host "Driver: $($gpu.DriverVersion)"
        return $true
    }
    
    return $false
}

# Main execution
Write-Host "=== NVIDIA Driver Installer ==="
Write-Host ""

try {
    Assert-Admin
    $gpu = Get-GPUInfo
    
    Write-Host "Attempting automatic installation..."
    $success = Install-DriverViaWinget
    
    if (-not $success) {
        Write-Host "Automatic installation failed, switching to manual method"
        Install-DriverManual
    }
    
    $verified = Test-Installation
    
    if ($verified) {
        Write-Host "Driver installation successful!"
        
        if (-not $NoReboot) {
            $reboot = Read-Host "Restart computer now? (y/N)"
            if ($reboot -match "^[Yy]") {
                Restart-Computer -Force
            }
        }
    } else {
        Write-Host "Could not verify installation. Check Device Manager."
    }
    
} catch {
    Write-Error "Installation failed: $_"
    Write-Host "Try visiting https://www.nvidia.com/drivers manually"
}

Write-Host "Installation complete. Test with: nvidia-smi"