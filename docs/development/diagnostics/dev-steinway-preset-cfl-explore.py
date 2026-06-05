"""
dev-steinway-preset: CFL exploration. For each piano pitch present in Belarus_196modesC,
compute the Courant number + max|g| with the NEW Steinway physics, keeping Belarus's existing
jung (Young's modulus coeff), gamma, dx, and the per-pitch main-point count.

dt = 1/(sr * string_iteration). dx = length/main.
We test two dx scenarios:
  (a) Belarus's existing dx (length_belarus/main_belarus) — isolates physics effect.
  (b) new dx = steinway_length / belarus_main  — what you'd get keeping the SAME main-count
      but the REAL Steinway length (the naive substitution).
Reject criterion (cfl_stability): courant >= CFL_MARGIN(0.8) OR max|g| > 1.
"""
import sys, json, math
sys.path.insert(0, r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
sys.path.insert(0, r"D:\repos\PianoidInstall\docs\development\diagnostics")
import cfl_stability as cfl
from importlib import import_module
derive = import_module("dev-steinway-preset-derive")

PRESET = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets\Belarus_196modesC"
d = json.load(open(PRESET, encoding="utf-8"))
mp = d["model_parameters"]
sr = mp["sr"]; string_iter = mp["string_iteration"]
dt = 1.0 / (sr * string_iter)
print(f"sr={sr} string_iteration={string_iter} dt={dt:.3e}  CFL_MARGIN={cfl.CFL_MARGIN}")

new = derive.full_keyboard()
pitches = d["pitches"]

print(f"\n{'MIDI':>4} {'type':>6} | {'L_bel':>7} {'L_stein':>7} | {'main':>4} {'tail':>4} | "
      f"{'jung':>11} | {'dx_bel':>8} {'court(a)':>9} {'|g|(a)':>7} | {'dx_new':>8} {'court(b)':>9} {'|g|(b)':>7} {'verdict_b':>9}")
fails_a = []; fails_b = []
for pk in sorted(pitches, key=lambda x: int(x)):
    midi = int(pk)
    if midi >= 128:   # output pitches not gated
        continue
    if midi not in new:
        continue
    p = pitches[pk]
    g = p["geometry"]; ph = p["physics"]
    main = g["main"]; tail = g["tail"]; L_bel = g["length"]
    jung = ph["jung"]; gamma = ph.get("gamma", 0.0)
    nd = new[midi]
    L_stein = nd["length_m"]; r = nd["r"]; rho = nd["rho"]; T = nd["tension"]
    to = p.get("tension_offset", 0.0)
    nstr = len(p.get("strings", [1]))
    dec_curr = gamma * dt   # velocity damping (does not change |g|<=1 boundary but feeds the formula)

    # (a) Belarus dx
    dx_a = L_bel / main if main else float('nan')
    amp_a, _, court_a = cfl.amp_and_courant_for_pitch_strings(T, r, rho, jung, dx_a, dt, nstr, to, dec_curr)
    # (b) Steinway length, same main count
    dx_b = L_stein / main if main else float('nan')
    amp_b, _, court_b = cfl.amp_and_courant_for_pitch_strings(T, r, rho, jung, dx_b, dt, nstr, to, dec_curr)
    verdict_b = "OK" if cfl.is_stable_with_margin(amp_b, court_b) else "REJECT"
    if not cfl.is_stable_with_margin(amp_a, court_a): fails_a.append(midi)
    if verdict_b != "OK": fails_b.append(midi)
    typ = 'WOUND' if nd['wound'] else 'plain'
    print(f"{midi:>4} {typ:>6} | {L_bel:>7.3f} {L_stein:>7.3f} | {main:>4} {tail:>4} | "
          f"{jung:>11.2e} | {dx_a:>8.5f} {court_a:>9.4f} {amp_a:>7.4f} | {dx_b:>8.5f} {court_b:>9.4f} {amp_b:>7.4f} {verdict_b:>9}")

print(f"\nScenario (a) Belarus dx: {len(fails_a)} fails -> {fails_a}")
print(f"Scenario (b) Steinway L / Belarus main: {len(fails_b)} fails -> {fails_b}")
