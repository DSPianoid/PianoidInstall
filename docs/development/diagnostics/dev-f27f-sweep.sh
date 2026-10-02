#!/bin/bash
# dev-f27f: tail-damper render sweep, one offline process per config.
# Usage: dev-f27f-sweep.sh OUT_SUBDIR PY CORE "LABEL:PRESET:TAILMODE ..."
cd /d/repos/PianoidInstall
OUT=docs/development/diagnostics/dev-f27f-renders/$1
PY=$2; CORE=$3
H=docs/development/diagnostics/dev-f27f-tail-damper-render.py
P=$CORE/pianoid_middleware/presets
mkdir -p $OUT
for spec in $4; do
  IFS=: read lab pre mode <<< "$spec"
  [ -f $OUT/$lab/results.json ] && continue
  unset VIRTUAL_ENV
  $PY $H $P/$pre.json $lab $OUT --core $CORE --tail $mode > $OUT/$lab.log 2>&1
  echo "$lab rc=$?"
done
echo SWEEP-DONE
