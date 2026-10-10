#!/usr/bin/env bash
# dev-3d2c timing + equivalence: N rounds, run order rotated per round; one fresh process per run.
N=${N:-5}; cd /d/scratch/dev-3d2c
JOBS_B="base:Belarus_8band_196modes:legacy base:Belarus_8band_196modes_flat:flat196 t4:Belarus_8band_196modes:legacy t4:Belarus_8band_196modes_flat:flat196 t4:Belarus_8band_196modes_N1000:N1000 t4:Belarus_8band_196modes_N2000:N2000 t4:Belarus_8band_196modes_N4000:N4000"
JOBS_F="base:F15_Elyashev_array512:legacy base:F15_Elyashev_array512_flat:flat196 t4:F15_Elyashev_array512:legacy t4:F15_Elyashev_array512_flat:flat196 t4:F15_Elyashev_array512_N2000:N2000"
for i in $(seq 1 $N); do
  for set in B F; do
    if [ $set = B ]; then jobs=($JOBS_B); k=Belarus; else jobs=($JOBS_F); k=F15; fi
    n=${#jobs[@]}; rot=$(( (i - 1) % n ))
    for j in $(seq 0 $((n - 1))); do
      job=${jobs[$(( (j + rot) % n ))]}; IFS=: read b p tag <<< "$job"
      r=$(./run.sh $b $p $k $b timing/r$i --render-s 8)
      echo "round $i $k $b $tag $(echo "$r" | grep -o '"add_ms": {[^}]*}') $(echo "$r" | grep -o '"num_regs": [0-9]*') $(echo "$r" | grep -o 'RC=.*') $(date -u +%T)"
    done
  done
done
echo TIMING_DONE
