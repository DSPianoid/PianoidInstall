"""dev-dad7 — P0 mode-scaling: runtime occupancy of addKernel from its compiled cubin (driver API via ctypes).

Loads ONLY the extracted addKernel cubin into a private CUDA context (no pianoidCuda import, no engine
init, no audio device). Queries cuFuncGetAttribute (NUM_REGS, SHARED_SIZE_BYTES, LOCAL_SIZE_BYTES,
MAX_THREADS_PER_BLOCK) and cuOccupancyMaxActiveBlocksPerMultiprocessor(block=512, dynSmem=0) — the exact
call the cooperative-launch pre-flight would make — then x SM count = cooperative capacity.
Usage: python dev-dad7-occupancy.py <cubin> [<cubin> ...]
"""
import ctypes as C, sys
cu = C.WinDLL("nvcuda.dll") if sys.platform == "win32" else C.CDLL("libcuda.so")
def ck(r, what):
    if r != 0: raise RuntimeError(f"{what} -> CUresult {r}")
ck(cu.cuInit(0), "cuInit")
dev = C.c_int(); ck(cu.cuDeviceGet(C.byref(dev), 0), "cuDeviceGet")
name = C.create_string_buffer(256); cu.cuDeviceGetName(name, 256, dev)
def dattr(a):
    v = C.c_int(); ck(cu.cuDeviceGetAttribute(C.byref(v), a, dev), f"devattr {a}"); return v.value
SM = dattr(16); MAXTHR_SM = dattr(39); REGS_SM = dattr(82); SMEM_SM = dattr(81); MAXBLK_SM = dattr(106); COOP = dattr(95)
print(f"device={name.value.decode()} SMs={SM} maxThr/SM={MAXTHR_SM} regs/SM={REGS_SM} smem/SM={SMEM_SM} maxBlk/SM={MAXBLK_SM} coop={COOP}")
ctx = C.c_void_p(); ck(cu.cuCtxCreate_v2(C.byref(ctx), 0, dev), "cuCtxCreate")
MANGLED = b"_Z9addKernelPfS_S_S_S_S_PiS0_S_S_S_S0_S_S_S0_S_S_S0_S0_S_S_S_S_S_S_S0_S0_S0_S0_S0_"
for path in sys.argv[1:]:
    mod = C.c_void_p(); r = cu.cuModuleLoad(C.byref(mod), path.encode())
    if r != 0: print(f"{path}: cuModuleLoad CUresult {r} (arch mismatch?)"); continue
    fn = C.c_void_p(); ck(cu.cuModuleGetFunction(C.byref(fn), mod, MANGLED), "getFunction")
    def fattr(a):
        v = C.c_int(); ck(cu.cuFuncGetAttribute(C.byref(v), a, fn), f"fattr {a}"); return v.value
    regs, smem, local, maxthr = fattr(4), fattr(1), fattr(3), fattr(0)
    print(f"\n{path}\n  numRegs={regs} staticSmem={smem} localBytes={local} maxThreadsPerBlock={maxthr}")
    for bs in (512, 384, 256, 128):
        nb = C.c_int(); ck(cu.cuOccupancyMaxActiveBlocksPerMultiprocessor(C.byref(nb), fn, bs, C.c_size_t(0)), "occ")
        print(f"  block={bs:4d}: maxActiveBlocks/SM={nb.value}  coopCapacity={nb.value*SM} blocks  "
              f"(warps/SM={nb.value*bs//32} of {MAXTHR_SM//32})")
    cu.cuModuleUnload(mod)
cu.cuCtxDestroy_v2(ctx)
