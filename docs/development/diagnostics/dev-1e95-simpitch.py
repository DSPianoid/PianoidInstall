"""dev-1e95: pitch of the replica's fundamental in float32 vs float64 vs N (key 22, single pitch coupled)."""
import importlib.util as _ilu, os as _os
_spec = _ilu.spec_from_file_location("dev_1e95_model", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "dev-1e95-model.py"))
_mod = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_mod); Pitch, SR = _mod.Pitch, _mod.SR
import json, sys, math, numpy as np
def f0(x, sr):
    x = x - x.mean(); n = len(x); X = np.abs(np.fft.rfft(x*np.hanning(n), 8*n)); fr = np.fft.rfftfreq(8*n, 1/sr)
    sel = (fr > 20) & (fr < 60); i = np.argmax(X[sel]) + np.nonzero(sel)[0][0]
    # parabolic interpolation
    a, b, c = np.log(X[i-1]+1e-30), np.log(X[i]+1e-30), np.log(X[i+1]+1e-30); d = 0.5*(a-c)/(a-2*b+c)
    return (i+d)*(fr[1]-fr[0])
def run(P, dtype, seconds=1.0):
    u = np.zeros((P.nstr, P.L, 1), dtype); up = np.zeros_like(u); q = np.zeros((P.M, 1), dtype); qp = np.zeros_like(q)
    bump = np.exp(-((np.arange(P.L) - (P.main.start + 40))/6.0)**2)*1e-3; u[0, :, 0] = bump; up[0, :, 0] = bump
    for c in P.strs:
        for k in ("main", "tail"): c[k] = tuple(dtype(x) for x in c[k])
        c["cfd"] = dtype(c["cfd"]); c["tension"] = dtype(c["tension"])
    for a in ("deck0", "feedin", "omega", "dec", "mass_inv"): setattr(P, a, getattr(P, a).astype(dtype))
    probe = np.empty(int(seconds*SR))
    for n in range(len(probe)):
        u, up, q, qp = P.sample_map_SH(u, up, q, qp); probe[n] = u[0, P.main.start + 100, 0]
    return probe
pid = int(sys.argv[1]); Ns = [int(x) for x in sys.argv[2].split(",")]; fref = 440*2**((pid-69)/12)
files = {4: "F15_i8.json", 8: "F15_i8.json", 16: "F15_i16.json"}
for N in Ns:
    for dt in (np.float32, np.float64):
        pr = json.load(open(files[N]))
        if N == 4:
            for k, p in pr["pitches"].items(): p["physics"]["disp_decay"] *= 2; p["physics"]["damper_string"] *= 2
        P = Pitch(pr, pid, N); x = run(P, dt); f = f0(x[int(0.2*SR):], SR)
        print(f"key {pid} N={N:2d} {dt.__name__}: f0={f:.3f} Hz  {1200*math.log2(f/fref):+.1f} c vs 12-TET; finite={np.isfinite(x).all()} rms(last 0.1s)={np.sqrt(np.mean(x[-4800:]**2)):.2e}", flush=True)
