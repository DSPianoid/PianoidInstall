#!/bin/bash
# dev-elat1 live (audio_on, loopback Out 9 -> In 8) before/after runner. Runs against the backend on
# :5000 that the orchestrator-provided stack serves (Core dev = BEFORE, wt-elat1-core = AFTER, via
# PIANOID_CORE_DIR). Prereqs as in the 2026-10-23 study: PIANOID_AUDIO_OUTPUT_MAP=8,1,2,3,4,5,6,
# user load dict, POST /set_mic_device {"input_channel":7}.
# usage: dev-elat1-live.sh <before|after> [shim]
set -e
TAG=$1; export LAT_TAG=$TAG
unset VIRTUAL_ENV
PY=/d/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe
cd "$(dirname "$0")/../latency-2026-10-23"
for c in "gauss.c2.volume_x0.5|n1" "gauss.c2.volume_x0.5|n8" "gauss.c2.volume_x0.5|n88" \
         "hammer.position_0.25|n1" "hammer.position_0.25|n88"; do
  $PY -u exp04_excitation.py 3 "$c" 0,2,5,10,20,40,80,160,320,640 | tee -a /d/tmp/elat1/live_${TAG}_exp04.log
done
$PY -u exp08_note_during_write.py 3 | tee /d/tmp/elat1/live_${TAG}_exp08.log
if [ "$2" = "shim" ]; then $PY -u exp06_breakdown.py 5 | tee /d/tmp/elat1/live_${TAG}_exp06.log; fi
