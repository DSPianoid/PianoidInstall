# dev-overrun Lever A same-binary A/B driver.
# Runs the muted multirun harness twice against the SAME installed binary:
#   arm RT-OFF (PIANOID_SYNTH_RT=0) -> reproduces the un-elevated baseline
#   arm RT-ON  (PIANOID_SYNTH_RT=1) -> synthesis thread elevated to Pro-Audio RT
# Detached-friendly: this script is itself launched hidden; it runs the two arms
# sequentially (each arm = N fresh processes) and writes per-arm combined JSON.
param(
  [int]$Runs = 10,
  [int]$Inducers = 12,
  [double]$Duration = 8,
  [int]$Iter = 8,
  [string]$OutBase = "D:\repos\PianoidInstall\.claude\scratch_overrun"
)
$core = "D:\repos\PianoidInstall\PianoidCore"
$py = "$core\.venv\Scripts\python.exe"
$mr = "$core\tests\system\overrun_multirun.py"

function Run-Arm($label, $rtval) {
  $outdir = Join-Path $OutBase $label
  New-Item -ItemType Directory -Force -Path $outdir | Out-Null
  $env:PIANOID_SYNTH_RT = $rtval
  Write-Host "########## ARM $label (PIANOID_SYNTH_RT=$rtval) ##########"
  & $py $mr --runs $Runs --inducers $Inducers --duration $Duration --iter $Iter `
      --driver 4 --label $label --output-dir $outdir 2>&1
  Write-Host "########## ARM $label DONE ##########"
}

Push-Location $core
Run-Arm "leverA_rtoff" "0"
Run-Arm "leverA_rton"  "1"
Pop-Location
Write-Host "=== LEVER-A A/B COMPLETE ==="
