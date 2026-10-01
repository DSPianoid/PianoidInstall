#!/bin/bash
# dev-f2b8: level-vs-N sweep, one offline process per config. Usage: dev-f2b8-sweep.sh OUT_SUBDIR [PY] [CORE]
cd /d/repos/PianoidInstall
OUT=docs/development/diagnostics/dev-f2b8-renders/$1
PY=${2:-PianoidCore/.venv/Scripts/python.exe}
CORE=${3:-PianoidCore}
H=docs/development/diagnostics/dev-f2b8-level-vs-n.py
P=PianoidCore/pianoid_middleware/presets
mkdir -p $OUT
for pre in Belarus_8band_196modes BaselinePreset1; do
 for N in 2 4 8 16; do
  for cfg in "1 0" "0 0" "2 0" "1 1"; do
   set -- $cfg
   lab=${pre}_N${N}_d$1_ltm$2
   [ -f $OUT/$lab/results.json ] && continue
   $PY $H $P/$pre.json $lab $OUT --n $N --deriv $1 --ltm $2 --core $CORE $EXTRA > $OUT/$lab.log 2>&1
   echo "$lab rc=$?"
  done
 done
done
echo SWEEP-DONE
