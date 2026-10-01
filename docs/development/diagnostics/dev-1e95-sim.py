"""dev-1e95: time-domain run of the same per-sample map in float32 vs float64 (roundoff hypothesis).
Initial state: small displacement bump on the string; track RMS of the string displacement per 50 ms."""
import importlib.util as _ilu, os as _os
_spec = _ilu.spec_from_file_location("dev_1e95_model", _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "dev-1e95-model.py"))
_mod = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_mod); Pitch, SR = _mod.Pitch, _mod.SR
import json, sys, math, numpy as np
def run(P, dtype, seconds=0.6, seed=0):
    rng = np.random.default_rng(seed)
    u = np.zeros((P.nstr, P.L, 1), dtype); up = np.zeros_like(u)
    q = np.zeros((P.M, 1), dtype); qp = np.zeros_like(q)
    bump = np.exp(-((np.arange(P.L) - (P.main.start + 40))/6.0)**2)*1e-3
    u[0, :, 0] = bump; up[0, :, 0] = bump
    # cast coefficient tables to dtype (the engine computes them in float too)
    for c in P.strs:
        for k in ("main", "tail"): c[k] = tuple(dtype(x) for x in c[k])
        c["cfd"] = dtype(c["cfd"]); c["tension"] = dtype(c["tension"])
    P.deck0 = P.deck0.astype(dtype); P.feedin = P.feedin.astype(dtype)
    P.omega = P.omega.astype(dtype); P.dec = P.dec.astype(dtype); P.mass_inv = P.mass_inv.astype(dtype)
    env = []; blk = int(0.05*SR); acc = 0.0
    for n in range(int(seconds*SR)):
        u, up, q, qp = P.sample_map_SH(u, up, q, qp)
        acc += float(np.mean(u[:, P.main, 0].astype(np.float64)**2))
        if (n+1) % blk == 0:
            env.append(10*math.log10(acc/blk + 1e-300)); acc = 0.0
        if not np.isfinite(u).all():
            return env, "NaN/Inf at %.3f s" % (n/SR)
    return env, "finite"
if __name__ == "__main__":
    pid = int(sys.argv[1]); Ns = [int(x) for x in sys.argv[2].split(",")]
    files = {4: "F15_i8.json", 6: "F15_i6.json", 8: "F15_i8.json", 10: "F15_i10.json", 12: "F15_i12.json", 16: "F15_i16.json"}
    for N in Ns:
        for dt in (np.float32, np.float64):
            P = Pitch(json.load(open(files[N])), pid, N)
            env, st = run(P, dt)
            slope = np.polyfit(np.arange(len(env))*0.05, env, 1)[0] if len(env) > 3 else float("nan")
            print(f"key {pid} N={N:2d} {dt.__name__}: {st}; string-RMS dB per 50ms: {' '.join('%.1f'%e for e in env[::2])}  slope {slope:+.1f} dB/s", flush=True)
