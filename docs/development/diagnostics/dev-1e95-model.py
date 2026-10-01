"""dev-1e95: exact replica of the engine's per-sample linear map for ONE pitch (its strings + all modes),
from the converted preset's physics via parameterKernel formulas (Kernels.cu) and the MainKernel loop:
 - N sub-steps per sample, stem (2 points) held at the per-sample feedback (sample-and-hold)
 - force_on_bridge = tension*((u[stem0-1]-fb)+(u[stem1+1]-fb)) summed over sub-steps / N
 - modes once per sample: q' = ((2q-q1) + q1*dec - q*omega + F*mass_inv)*(1-dec)
 - feedback (next sample) = sum_m deck0[m]*deck_feedback_coeff*q
Spectral radius of the map = growth per sample; dB/s = 20*log10(rho)*48000.
Variant 'tight': stem refreshed + modes stepped EVERY sub-step (FPGA-like) with rate-matched mode coefficients.
"""
import json, base64, math, sys, numpy as np
GPU_PI = 3.1415; SR = 48000; K_OMEGA = 4*math.pi**2; STEM = 2; LEAD = 2
def deck(p):
    d = p["deck"]; return np.frombuffer(base64.b64decode(d["data"]), dtype=np.float64).reshape(d["shape"])
def string_coeffs(ph, g, N, tension):
    ipm = int(SR*N/1000); dt = 1/(ipm*1000); dx_mm = g["length"]/g["main"]*1000; dxMm2 = dx_mm**2
    ct = tension/(dxMm2*ph["rho"]*ipm*ipm)
    cb = (GPU_PI*250000*ph["r"]**4*ph["jung"])/(ph["rho"]*dxMm2*dxMm2*ipm*ipm)
    cfd = ph["disp_decay"]*1e12/(2*dxMm2)
    dec_main = ph["gamma"]/(ipm*1000)                     # key held: dump_coeff = 0
    dec_tail = dec_main + ph["damper_string"]*int(ph["damper_tail"])
    def sh(dec):
        di = 1/(1+dec); return ((2+12*cb-2*ct)*di, (ct-8*cb)*di, 2*cb*di, (dec-1)*di)
    return dict(ct=ct, cb=cb, cfd=cfd, main=sh(dec_main), tail=sh(dec_tail), dt=dt)
class Pitch:
    def __init__(self, pr, pid, N):
        p = pr["pitches"][str(pid)]; ph = p["physics"]; g = p["geometry"]
        self.N = N; self.nstr = len(p["strings"]); toff = p.get("tension_offset", 0.0)
        self.L = LEAD + g["main"] + STEM + g["tail"] + 2
        self.main = slice(LEAD, LEAD+g["main"]); self.stem0 = LEAD+g["main"]; self.stem1 = self.stem0+1
        self.tail = slice(self.stem0+2, self.stem0+2+g["tail"])
        self.strs = []
        for i in range(self.nstr):
            tension = ph["tension"]*(1+i*toff)
            c = string_coeffs(ph, g, N, tension); c["tension"] = tension; self.strs.append(c)
        self.dt = self.strs[0]["dt"]
        self.deck0 = deck(p)[0]*pr["model_parameters"].get("deck_feedback_coefficient", 1.0)
        self.feedin = deck(p)[0]
        ms = pr["modes"]; f = np.array([m["frequency"] for m in ms]); dcr = np.array([m["decrement"] for m in ms])
        self.mass_inv = np.array([m.get("mass_inv", m.get("mass")) for m in ms])
        dts = 1/SR; self.omega = dts**2*f**2*K_OMEGA; self.dec = dts*dcr*f; self.M = len(ms); self.f = f
    # ---- batched state: columns = basis vectors; u,up: (nstr, L, D); q,qp: (M, D)
    def substep(self, u, up, fb, tight_q=None):
        N = self.N; new = u.copy(); d3_prev = up[:, :-2] + up[:, 2:] - 2*up[:, 1:-1]   # curvature of prev state, index p-1
        force = np.zeros((self.nstr,) + u.shape[2:])
        for s, c in enumerate(self.strs):
            us, ups = u[s], up[s]
            d3 = us[:-2] + us[2:] - 2*us[1:-1]
            for sl, co in ((self.main, c["main"]), (self.tail, c["tail"])):
                s0, s1, s2, sb = co; p = np.arange(sl.start, sl.stop)
                new[s, p] = (s0*us[p] + sb*ups[p] + s2*(us[p-2]+us[p+2]) + s1*(us[p-1]+us[p+1])
                             + c["cfd"]*(d3[p-1] - d3_prev[s][p-1]))
            new[s, self.stem0] = fb[s]; new[s, self.stem1] = fb[s]
        up = u; u = new
        for s, c in enumerate(self.strs):
            force[s] = c["tension"]*((u[s, self.stem0-1] - fb[s]) + (u[s, self.stem1+1] - fb[s]))
        return u, up, force
    def mode_step(self, q, qp, F, omega, dec, mass_inv):
        qn = ((2*q - qp) + qp*dec[:, None] - q*omega[:, None] + F*mass_inv[:, None])*(1-dec[:, None])
        return qn, q
    def sample_map_SH(self, u, up, q, qp):
        fb = np.einsum("m,md->d", self.deck0, q)[None, :].repeat(self.nstr, 0)   # (nstr, D)
        fsum = 0
        for j in range(self.N):
            u, up, force = self.substep(u, up, fb); fsum = fsum + force
        F = np.einsum("m,sd->md", self.feedin, fsum/self.N) if self.nstr else 0
        q, qp = self.mode_step(q, qp, F, self.omega, self.dec, self.mass_inv)
        return u, up, q, qp
    def sample_map_tight(self, u, up, q, qp):
        # FPGA-like: bridge + modes every sub-step; exact-rate mode coeffs at dt_g
        N = self.N; dtg = self.dt; dts = 1/SR
        omega_g = dtg**2*self.f**2*K_OMEGA
        gamma = -np.log(1-self.dec)/dts; dec_g = 1-np.exp(-gamma*dtg)
        mass_g = self.mass_inv*(dtg/dts)**2
        for j in range(N):
            fb = np.einsum("m,md->d", self.deck0, q)[None, :].repeat(self.nstr, 0)
            u, up, force = self.substep(u, up, fb)
            F = np.einsum("m,sd->md", self.feedin, force)
            q, qp = self.mode_step(q, qp, F, omega_g, dec_g, mass_g)
        return u, up, q, qp
    def active(self):
        return np.r_[np.arange(self.main.start, self.main.stop), self.stem0, self.stem1, np.arange(self.tail.start, self.tail.stop)]
    def matrix(self, variant="SH"):
        act = self.active(); na = len(act); n = self.nstr*na
        D = 2*n + 2*self.M; I = np.eye(D)
        u = np.zeros((self.nstr, self.L, D)); up = np.zeros((self.nstr, self.L, D))
        for s in range(self.nstr):
            u[s, act] = I[s*na:(s+1)*na]; up[s, act] = I[n+s*na:n+(s+1)*na]
        q = I[2*n:2*n+self.M]; qp = I[2*n+self.M:]
        f = self.sample_map_SH if variant == "SH" else self.sample_map_tight
        u, up, q, qp = f(u, up, q, qp)
        return np.vstack([u[:, act].reshape(n, D), up[:, act].reshape(n, D), q, qp])
def rho_db(A):
    ev = np.linalg.eigvals(A); r = np.abs(ev).max(); return r, 20*np.log10(r)*SR, ev
if __name__ == "__main__":
    keys = [int(k) for k in sys.argv[1].split(",")] if len(sys.argv) > 1 else [22]
    Ns = [int(k) for k in sys.argv[2].split(",")] if len(sys.argv) > 2 else [4, 8, 16]
    variants = sys.argv[3].split(",") if len(sys.argv) > 3 else ["SH", "tight"]
    files = {4: "F15_i8.json", 6: "F15_i6.json", 8: "F15_i8.json", 10: "F15_i10.json", 12: "F15_i12.json", 16: "F15_i16.json"}
    # NOTE: physics is N-independent in the converter except disp_decay/damper_string (∝k); use the matching file
    for pid in keys:
        for N in Ns:
            pr = json.load(open(files[N])) if N in files else json.load(open("F15_i16.json"))
            P = Pitch(pr, pid, N)
            for v in variants:
                A = P.matrix(v); r, db, ev = rho_db(A)
                top = sorted(ev, key=lambda z: -abs(z))[:1][0]
                fdom = abs(np.angle(top))/(2*math.pi)*SR
                print(f"key {pid} N={N:2d} {v:5s} rho={r:.7f} growth={db:+9.1f} dB/s  dominant |ev| at {fdom:8.1f} Hz  (ct={P.strs[0]['ct']:.2e} cb={P.strs[0]['cb']:+.2e} cfd={P.strs[0]['cfd']:.1e})", flush=True)
