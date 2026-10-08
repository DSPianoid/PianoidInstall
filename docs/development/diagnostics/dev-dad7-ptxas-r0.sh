#!/usr/bin/env bash
# dev-dad7 — P0 mode-scaling: measure R0 (regs/thread, spills, smem, stack) per kernel via ptxas -v.
# Compile-only, into a scratch dir; mirrors pianoid_cuda/setup.py nvcc flags (release: -O3 -use_fast_math;
# debug: -O2 -DPIANOID_DEBUG_DATA). Never installs anything.
# Usage: dev-dad7-ptxas-r0.sh <pianoid_cuda src dir> <out dir> [archs...]
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"   # stop Git-Bash mangling /MD /EHsc
SRC="$1"; OUT="$2"; shift 2; ARCHS="${*:-80 86 89}"
NVCC="/c/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.5/bin/nvcc.exe"
CCBIN='C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64'
INCS=(-I 'D:\repos\PianoidInstall\PianoidCore\.venv\Lib\site-packages\pybind11\include'
      -I 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.5\include'
      -I "$(cygpath -w "$SRC")" -I 'C:\Python312\Include'
      -I 'C:\SDL3-3.2.0\include' -I 'C:\SDL3-3.2.0\include\SDL3')
GEN=(); for a in $ARCHS; do GEN+=("-gencode=arch=compute_$a,code=sm_$a"); done
HOST=(-ccbin "$CCBIN" -Xcompiler /MD -Xcompiler /EHsc -Xcompiler -bigobj --compiler-options -bigobj)
mkdir -p "$OUT"
for variant in release debug; do
  if [ $variant = release ]; then OPT=(-O3 -use_fast_math); DEF=(-DPIANOID_MODULE_NAME=pianoidCuda)
  else OPT=(-O2); DEF=(-DPIANOID_MODULE_NAME=pianoidCuda_debug -DPIANOID_DEBUG_DATA); fi
  for f in MainKernel Kernels FIRFilter gaussTest add_arrays SinewaveGenerator; do
    "$NVCC" -c "$(cygpath -w "$SRC/$f.cu")" -o "$(cygpath -w "$OUT/${f}_$variant.obj")" --std=c++17 \
      "${OPT[@]}" "${HOST[@]}" -DUSE_SDL3_AUDIO -DUSE_ASIO_AUDIO "${DEF[@]}" "${GEN[@]}" "${INCS[@]}" \
      -Xptxas -v > "$OUT/${f}_$variant.ptxas.txt" 2>&1
    echo "$variant $f exit=$?"
  done
done
