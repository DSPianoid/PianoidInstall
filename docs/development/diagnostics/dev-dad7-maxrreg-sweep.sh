#!/usr/bin/env bash
# dev-dad7 — compile-only sweep: addKernel (release flags, sm_89) under -maxrregcount N -> regs + spill bytes.
# Answers "what does capping registers cost in spills" (proposal §3.6 / regmem plan LEVER 5). No source edits.
set -u; export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"
SRC="$1"; OUT="$2"; mkdir -p "$OUT"
NVCC="/c/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.5/bin/nvcc.exe"
CCBIN='C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64'
for N in ${NS:-128 112 96 80 72 64 56 48}; do
  "$NVCC" -c "$(cygpath -w "$SRC/MainKernel.cu")" -o "$(cygpath -w "$OUT/mk_r$N.obj")" --std=c++17 -O3 -use_fast_math \
    -ccbin "$CCBIN" -Xcompiler /MD -Xcompiler /EHsc -Xcompiler -bigobj -DUSE_SDL3_AUDIO -DUSE_ASIO_AUDIO \
    -DPIANOID_MODULE_NAME=pianoidCuda -gencode=arch=compute_89,code=sm_89 -maxrregcount=$N \
    -I 'D:\repos\PianoidInstall\PianoidCore\.venv\Lib\site-packages\pybind11\include' \
    -I 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.5\include' -I "$(cygpath -w "$SRC")" \
    -I 'C:\Python312\Include' -I 'C:\SDL3-3.2.0\include' -I 'C:\SDL3-3.2.0\include\SDL3' -Xptxas -v 2>&1 \
    | grep -A3 "entry function '_Z9addKernel" | tail -2 | tr -s ' ' | sed "s/^/maxrreg=$N: /"
done
