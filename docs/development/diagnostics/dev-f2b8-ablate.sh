#!/bin/bash
# dev-f2b8 ablations on the Belarus template (deriv 1/2, ltm 0): hf0 = disp_decay zeroed; xN = exc coefficients x N/4.
cd /d/repos/PianoidInstall
OUT=docs/development/diagnostics/dev-f2b8-renders/$1
PY=${2:-PianoidCore/.venv/Scripts/python.exe}
CORE=${3:-PianoidCore}
H=docs/development/diagnostics/dev-f2b8-level-vs-n.py
T=PianoidCore/pianoid_middleware/presets/Belarus_8band_196modes.json
T0=docs/development/diagnostics/dev-f2b8-renders/Belarus_8band_196modes_hf0.json
mkdir -p $OUT
for N in 2 4 8 16; do
 M=$(python -c "print($N/4)")
 for d in 1 2; do
  for v in hf0 xN hf0xN; do
   lab=tmpl_${v}_N${N}_d$d
   [ -f $OUT/$lab/results.json ] && continue
   case $v in
    hf0)   $PY $H $T0 $lab $OUT --n $N --deriv $d --core $CORE > $OUT/$lab.log 2>&1 ;;
    xN)    $PY $H $T  $lab $OUT --n $N --deriv $d --core $CORE --exc-mult $M > $OUT/$lab.log 2>&1 ;;
    hf0xN) $PY $H $T0 $lab $OUT --n $N --deriv $d --core $CORE --exc-mult $M > $OUT/$lab.log 2>&1 ;;
   esac
   echo "$lab rc=$?"
  done
 done
done
echo ABLATE-DONE
