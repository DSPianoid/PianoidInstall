"""dev-1e95: what the ENGINE computes (parameterKernel formula, numpy) from each converted F_15 preset,
per sub-step count N; check converter scaling: ct/k^2, cb/k^2, cfd/k, dec/k must be N-invariant."""
import json, sys, numpy as np
GPU_PI=3.1415
DT_F = 512/393.216e6
def kernel_coeffs(pr, pid, N, sr=48000):
    p = pr["pitches"][str(pid)]; ph = p["physics"]; g = p["geometry"]
    ipm = int(sr*N/1000); dx_mm = g["length"]/g["main"]*1000 if g["tail"]>0 else 1.0
    dxMm2 = dx_mm*dx_mm
    ct = ph["tension"]/(dxMm2*ph["rho"]*ipm*ipm)
    cb = (GPU_PI*250000*ph["r"]**4*ph["jung"])/(ph["rho"]*dxMm2*dxMm2*ipm*ipm)
    cfd = ph["disp_decay"]*1e12/(2*dxMm2)
    dec = ph["gamma"]/(ipm*1000)
    dec_rel = dec + ph["damper_string"]*int((127*1)**0.6)
    dec_tail = dec + ph["damper_string"]*int(ph["damper_tail"])
    return dict(ct=ct, cb=cb, cfd=cfd, dec=dec, dec_rel=dec_rel, dec_tail=dec_tail, main=g["main"], tail=g["tail"],
                nstr=len(p["strings"]), toff=p.get("tension_offset",0), k=(1/(ipm*1000))/DT_F)
files = {4:"F15_own.json",6:"F15_i6.json",8:"F15_i8.json",10:"F15_i10.json",12:"F15_i12.json",16:"F15_i16.json"}
pre = {N: json.load(open(f)) for N,f in files.items()}
for N,pr in pre.items():
    lp = pr.get("fpga_conversion",{}).get("load_params",{}); print(N, lp, "modes", len(pr["modes"]), "pitches", len(pr["pitches"]))
print("\nkey | N | k | ct | cb | cfd | dec | dec_tail | ct/k2 | cb/k2 | cfd/k | dec/k | CFL=ct-8cb | main tail nstr toff")
for pid in (21,22,24,28,33,60,96):
    for N,pr in pre.items():
        c = kernel_coeffs(pr,pid,N); k=c["k"]
        print(f"{pid} | {N:2d} | {k:5.2f} | {c['ct']:.3e} | {c['cb']:+.3e} | {c['cfd']:.3e} | {c['dec']:.2e} | {c['dec_tail']:.2e} | {c['ct']/k**2:.4e} | {c['cb']/k**2:+.4e} | {c['cfd']/k:.4e} | {c['dec']/k:.3e} | {c['ct']-8*c['cb']:.4f} | {c['main']} {c['tail']} {c['nstr']} {c['toff']:.4f}")
