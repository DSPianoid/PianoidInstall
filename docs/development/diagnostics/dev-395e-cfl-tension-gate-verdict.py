"""
dev-395e: DIAGNOSE-ONLY repro for "CFL guard fails to block an unstable string-TENSION increase".

User (live): "I raise tension of the string, the system breaks. No block, no warning."

This is IN-PROC / OFFLINE ONLY — loads the StringMap DOMAIN MODEL + constructs the REAL
ParameterManager with pianoid=None (the v2 CFL gate runs entirely host-side on physics BEFORE any
GPU upload, so it needs NO GPU/engine). NO ports, NO Flask, NO live stack.

For a representative piano pitch it sweeps physical `tension` over multiples of the preset baseline and,
at each tension:
  (1) calls the REAL gate `ParameterManager._raise_if_cfl_unstable([pitch], values)` -> PASS or REJECT
      (exactly what /set_parameter/string/<pitch> runs before upload), and
  (2) computes the gate's own max|g| via the shipped cfl_stability (K=24) AND a DENSE K=4000 max|g|
      (ground-truth predictor), and
  (3) runs a faithful forward FDTD interior-point sim (pure numpy, fixed-fixed) to detect ACTUAL
      blowup/collapse — the guard-independent ground truth (the proposal's empirical method, §5.1).

Goal: show (a) does the gate REJECT at the tension the user used (confirm it PASSES = "no block"),
and (b) does the engine actually destabilize there (does the gate SHOULD have caught it), and pin
WHERE the gate border sits vs the empirical blowup border in tension units.

Run:
  cd PianoidCore && unset VIRTUAL_ENV && \
    ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-tension-gate-verdict.py [PRESET.json] [PITCH]
"""
import os, sys, json, math
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

import numpy as np
from StringMap import StringMap            # noqa
from ModelParams import ModelParameters    # noqa
from parameter_manager import ParameterManager, CflRejected   # noqa
import cfl_stability as cfl                  # noqa

PRESET = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
PITCH = int(sys.argv[2]) if len(sys.argv) > 2 else 57

with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters()
mp.update_params(**save['model_parameters'])
sm = StringMap(mp, **save)

# Construct the REAL ParameterManager. The CFL gate (_raise_if_cfl_unstable / _prospective_string_coeffs)
# touches ONLY self.sm + self.mp + cfl_stability — never self.pianoid — so pianoid=None is safe + faithful.
pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)

print(f"preset            : {os.path.basename(PRESET)}")
print(f"pitch under test  : {PITCH}")
print(f"sample_rate       : {mp.sample_rate()}")
print(f"string_iteration  : {mp.string_iteration}")
p = sm.pitches[PITCH]
phys = p.physics
base_tension = float(phys.tension)
print(f"baseline physics  : tension={base_tension:.3f}  r={phys.r:.6g}  rho={phys.rho:.6g}  "
      f"jung={phys.jung:.6g}  gamma={phys.gamma:.6g}  disp_decay={getattr(phys,'disp_decay',0.0)}")
print(f"geometry dx       : {phys.geometry.dx():.6g}")
print(f"num strings       : {len(p.stringIDs)}   tension_offset={getattr(p,'tension_offset',0.0)}")
dt = 1.0 / (mp.sample_rate() * mp.string_iteration)
print(f"dt                : {dt:.6g}")
print()


def gate_verdict(tension_value):
    """Call the REAL pre-upload gate exactly as /set_parameter/string/<pitch> does. Returns
    (rejected: bool, info)."""
    values = {str(PITCH): {"tension": float(tension_value)}}
    try:
        pm._raise_if_cfl_unstable([PITCH], values)
        return False, "PASS (applied)"
    except CflRejected as e:
        return True, f"REJECT pitch={e.pitch} string={e.string_index} |g|={e.amplification:.4f}"


def dense_maxg(tension_value):
    """Ground-truth dense max|g| (K=4000) using the SAME closed form the gate uses, with the gate's own
    prospective coeffs (incl. dec_curr/cfd). Returns (max_over_strings, worst_string, T0, B)."""
    (tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings,
     toff) = pm._prospective_string_coeffs(PITCH, {"tension": float(tension_value)})
    worst = -1.0; wi = 0; T0 = None; Bv = None
    for i in range(max(1, int(num_strings))):
        Ti = tension * (1.0 + i * toff)
        T, B = cfl._coeffs(Ti, r, rho, jung, dx, dt_)
        # dense theta sweep, exclude k=0 (same exclusion as the gate)
        dec_inv = 1.0 / (1.0 + dec_curr)
        s0 = (2.0 + 12.0 * B - 2.0 * T) * dec_inv
        s1 = (T - 8.0 * B) * dec_inv
        s2 = (2.0 * B) * dec_inv
        sb = (dec_curr - 1.0) * dec_inv
        K = 4000
        ks = np.arange(1, K + 1)
        th = math.pi * ks / K
        ct = np.cos(th); c2 = np.cos(2 * th)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 - 2 * cfd * (1 - ct)
        B0 = sb + 2 * cfd * (1 - ct)
        disc = A * A + 4 * B0
        sq = np.sqrt(np.abs(disc))
        rm = np.maximum(np.abs((A + sq) * .5), np.abs((A - sq) * .5))
        cm = np.sqrt(np.abs(B0))
        mg = np.where(disc >= 0, rm, cm).max()
        if i == 0:
            T0, Bv = T, B
        if mg > worst:
            worst, wi = mg, i
    return worst, wi, T0, Bv


def forward_sim_blowup(tension_value, nsteps=40000, N=200):
    """Faithful forward interior-point FDTD recurrence (MainKernel.cu:523-541), fixed-fixed boundary.
    Ground-truth, guard-INDEPENDENT. Returns 'BLOWUP' / 'COLLAPSE' / 'STABLE' for the WORST string.

    Initial condition: a SMOOTH superposition of the first few sine modes (NOT a sharp impulse). A sharp
    impulse excites the Nyquist mode which, with the negative-E bending here, sits exactly on the |g|=1
    knife-edge and produces persistent non-decaying ripple a crude energy test misreads as 'BLOWUP'. A
    smooth IC tests the physical regime the player actually excites. BLOWUP is declared only on TRUE
    geometric growth (a sustained, large energy-ratio between late windows) or non-finite/overflow."""
    (tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings,
     toff) = pm._prospective_string_coeffs(PITCH, {"tension": float(tension_value)})
    i = max(0, int(num_strings) - 1) if toff > 0 else 0
    Ti = tension * (1.0 + i * toff)
    T, B = cfl._coeffs(Ti, r, rho, jung, dx, dt_)
    dec_inv = 1.0 / (1.0 + dec_curr)
    s0 = (2.0 + 12.0 * B - 2.0 * T) * dec_inv
    s1 = (T - 8.0 * B) * dec_inv
    s2 = (2.0 * B) * dec_inv
    sb = (dec_curr - 1.0) * dec_inv

    x = np.linspace(0, math.pi, N)
    u = (np.sin(x) + 0.3 * np.sin(2 * x) + 0.1 * np.sin(3 * x))   # smooth low-mode pluck
    u[0] = u[-1] = 0.0
    u_prev = u.copy()
    win, prev_win_max = 1000, None
    for n in range(nsteps):
        un = np.empty(N)
        sl = slice(2, N - 2)
        un[sl] = (s0 * u[sl]
                  + s1 * (u[3:N - 1] + u[1:N - 3])
                  + s2 * (u[4:N] + u[0:N - 4])
                  + sb * u_prev[sl])
        un[0] = 0.0; un[1] = 0.0; un[N - 2] = 0.0; un[N - 1] = 0.0
        u_prev, u = u, un
        if not np.all(np.isfinite(u)) or np.max(np.abs(u)) > 1e15:
            return "BLOWUP", T, B
        # geometric-growth detector: compare max|u| in successive windows; sustained >2x growth = blowup
        if (n + 1) % win == 0:
            wm = float(np.max(np.abs(u)))
            if prev_win_max is not None and wm > 2.0 * prev_win_max and wm > 10.0:
                return "BLOWUP", T, B
            prev_win_max = wm
    final = float(np.max(np.abs(u)))
    if final < 1e-4:
        return "COLLAPSE", T, B
    return "STABLE", T, B


# --- Sweep multiples of baseline tension ---------------------------------------------------------
mults = [1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100, 200]
print(f"{'mult':>5} {'tension':>12} {'coeff_T':>10} {'coeff_B':>11} {'gateK24|g|':>11} "
      f"{'dense|g|':>10} {'GATE':>8} {'forward-sim':>11}")
print("-" * 92)
for m in mults:
    tv = base_tension * m
    rej, info = gate_verdict(tv)
    dg, wi, T0, B = dense_maxg(tv)
    # gate's own K=24 worst (re-derive for the print, matches what the gate decided on)
    (tension, r, rho, jung, dx, dt_, dec_curr, cfd, num_strings,
     toff) = pm._prospective_string_coeffs(PITCH, {"tension": tv})
    k24 = -1.0
    for i in range(max(1, int(num_strings))):
        amp = cfl.max_amplification(*cfl._coeffs(tension * (1 + i * toff), r, rho, jung, dx, dt_),
                                    dec_curr, cfd)
        k24 = max(k24, amp)
    sim, Ts, Bs = forward_sim_blowup(tv)
    gate = "REJECT" if rej else "pass"
    print(f"{m:>5} {tv:>12.2f} {T0:>10.5f} {B:>11.3e} {k24:>11.5f} {dg:>10.5f} {gate:>8} {sim:>11}")

print()
print("Reading: 'GATE'=REJECT means the real pre-upload guard refused the edit (HTTP 400). 'pass' means")
print("it let the edit reach the engine. 'forward-sim' is the guard-INDEPENDENT ground truth (BLOWUP =")
print("the engine actually diverges -> 'system breaks'). A row with forward-sim=BLOWUP but GATE=pass is a")
print("real gate MISS. dense|g| (K=4000) is the exact predictor; gateK24|g| is what the shipped gate uses.")

# --- Bisection: where does the gate flip, where does the sim blow up (in tension multiples)? ------
def find_border(predicate, lo=1.0, hi=1000.0, iters=40):
    # predicate(mult) True == unstable/reject. assumes lo stable, hi unstable.
    if not predicate(hi):
        return None
    if predicate(lo):
        return lo
    for _ in range(iters):
        mid = math.sqrt(lo * hi)
        if predicate(mid):
            hi = mid
        else:
            lo = mid
    return math.sqrt(lo * hi)

gate_border = find_border(lambda m: gate_verdict(base_tension * m)[0])
sim_border = find_border(lambda m: forward_sim_blowup(base_tension * m)[0] == "BLOWUP")
print()
print(f"GATE reject border    : {gate_border}  (x baseline tension)  -> coeff_T ~ "
      f"{dense_maxg(base_tension*gate_border)[2] if gate_border else float('nan'):.5f}")
print(f"FORWARD-SIM blowup    : {sim_border}  (x baseline tension)  -> coeff_T ~ "
      f"{dense_maxg(base_tension*sim_border)[2] if sim_border else float('nan'):.5f}")
if gate_border and sim_border:
    print(f"gap (sim/gate)        : {sim_border/gate_border:.3f}x  "
          f"(>1 means gate rejects BEFORE blowup = conservative/correct; "
          f"<1 means gate MISSES a real blowup)")
