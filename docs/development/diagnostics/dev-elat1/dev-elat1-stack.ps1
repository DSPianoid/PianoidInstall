# dev-elat1: bring up launcher (:3001) + backend (:5000) from a given Core dir, load the user's
# tuning preset with the user's load dict (audio_on, ASIO callback), engine ch0 -> Out 9, mic In 8.
# usage: powershell -File dev-elat1-stack.ps1 -CoreDir D:\repos\wt-elat1-core -Tag after
param([string]$CoreDir, [string]$Tag)
$ErrorActionPreference = 'Stop'
$tunner = 'D:\repos\PianoidInstall\PianoidTunner'
$env:PIANOID_CORE_DIR = $CoreDir
$env:PIANOID_AUDIO_OUTPUT_MAP = '8,1,2,3,4,5,6'
$env:BROWSER = 'none'
$env:PIANOID_COMMANDS_DIR = 'D:/repos/PianoidInstall/schemas/commands'   # worktree Core resolves it one level too high
Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'server/launcher.js' -WorkingDirectory $tunner `
  -RedirectStandardOutput "D:\tmp\elat1\launcher_$Tag.log" -RedirectStandardError "D:\tmp\elat1\launcher_$Tag.err"
for ($i = 0; $i -lt 60; $i++) { if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { break }; Start-Sleep -Milliseconds 500 }
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3001/api/start-backend' -ContentType 'application/json' -Body '{}' | Out-Null
for ($i = 0; $i -lt 120; $i++) { try { Invoke-RestMethod 'http://127.0.0.1:5000/health' -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
$body = @{ path = 'presets/Tuning18-10-26ver1.json'; array_size = 512; string_iterations = 8; cycle_iterations = 64;
  sample_rate = 48000; listen_to_modes = 0; sound_derivative_order = 2; audio_on = 1; audio_driver_type = 4;
  audio_buffer_size = 4; volume = 127; start_right_away = 1; listen_to_midi = 1 } | ConvertTo-Json
$r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:5000/load_preset' -ContentType 'application/json' -Body $body -TimeoutSec 300 -UseBasicParsing
"load_preset $($r.StatusCode)"
Start-Sleep -Seconds 3
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:5000/set_mic_device' -ContentType 'application/json' -Body '{"input_channel":7}' | ConvertTo-Json -Compress
$h = Invoke-RestMethod 'http://127.0.0.1:5000/health'
"health: " + ($h | ConvertTo-Json -Compress).Substring(0, 300)
