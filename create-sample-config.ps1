# create-sample-config.ps1
# Creates a sample setup-config.json with default versions.
# Called from setup-packages.bat option 6.

$config = @{
    versions = @{
        python = "3.12"
        cuda   = "12.6"
        nodejs = "20"
        sdl2   = "2.30.8"
        sdl3   = "3.1.6"
    }
    paths = @{
        sdl_root = "C:\"
    }
    options = @{
        skip_components              = @()
        force_reinstall_components   = @()
        auto_reboot                  = $false
        clean_install                = $true
    }
    cuda = @{
        architectures = @("75", "80", "86", "89")
    }
}

$config | ConvertTo-Json -Depth 4 | Set-Content -Path 'setup-config.json' -Encoding UTF8
Write-Host "Sample config file created: setup-config.json"
Write-Host "You can edit this file to customize versions and options."
