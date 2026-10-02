#!/usr/bin/env python
"""
DRAFT / UNTESTED ON THE ENGINE -- FPGA (Elyashev "F_15") -> GPU Pianoid preset converter.

Status: PROTOTYPE, revision 3 (2026-09-30). It now uses the HOST-PROGRAM formulas from batch 3
(batch3/Pianoid_QM.c, cited as QM:<line> in the .utf8.txt copy). The output is a preset JSON in the
documented GPU schema (DATA_FLOWS.md 2.7), but it has NOT been loaded into pianoid_cuda, rendered, or
listened to. Items that are still inferred are flags and print a WARNING. Full mapping, evidence
and open items: docs/proposals/fpga-to-gpu-preset-port-2026-09-30.md, section 11.

What the host program settles (QM line numbers):
  * exp_all.txt layout = (level 5, key 88, [e x5, d x5, a x5]) -- Save_fcnstr QM:22001..22017 and the
    loader QM:22105..22123. So p0 = e (exponent coefficient, i.e. WIDTH), p1 = d (CENTRE),
    p2 = a (amplitude). The FPGA only uses Gaussians 0..3 (send_exp_coef loops k<4, QM:25305..25360).
  * Codes sent to the FPGA: e_code = int(16777215*e), d_code = int(2147000000*d),
    a_code = int(2147000000*a) (QM:25311/25336/25359); ind_mult_code = int(65000*ind_mult)
    (QM:13481); ind_vol_code = int(v_L*ind_vol*8388607.5), with v_L = Strength_graph[5+L] (QM:13542).
  * Mode mass code = Mass*2^31/f^2 (send_mass QM:338); omega code = 4*f^2*omega_ratio (QM:8909);
    Q code = Q_coeff*q_ratio (QM:9660); ratios = others.txt[1] and others.txt[0].
  * Output weight per (channel, mode) = decka_coeff[ch][m] * Ci_str_1_out[m] * out_vol (QM:27817).
  * Tail length = shteg points: Sdvig = start + N - shteg (send_shteg QM:675). Unison strings 2/3 use
    ttn +/- dt.txt (send_ttn QM:1503). Hammer spatial shape = circular cap from width.txt/del.txt
    (construct_molot QM:394-400).
Dima's answers (2026-09-30 16:03Z): the "send all parameters" path (send_all QM:12670) is authoritative
(the flash writer had a bug); F_15's own Pitch.txt is NOT in F_15.rar; FPGA clock = 393.219 MHz
(read as 393.216 MHz = 8192 x 48 kHz). Step times are now CLOCK COUNTS (flags): strings 512 clk
(one 512-point array per sweep) = 1.3021 us; modes 256 clk = 0.6510 us; exciter 96 clk = 0.2441 us
(derived from the model counters, proposal 11.11).
Batch 4 (stm32 firmware pianoid.c, proposal 11.12): every table is forwarded VERBATIM to the FPGA
(Q -> CMD_decr_0 pianoid.c:2248-2253, omega -> CMD_omega_0 :2263-2267, Mass -> CMD_str_svertk_1 :2279-2284,
output select CMD_init_sw = 2 :4449). F_15 Pitch.txt = batch4/Pitch.txt (content identical to batch3).
Tuning fit: effective speaking length = N - shteg - 21.3 points (512-clk step) -> median 0 cents.
Mode damping (Q) is still OPEN.
"""
import argparse
import base64
import copy
import json
import math
import os
import sys

import numpy as np

N_KEYS = 88                  # key index 0..87 = MIDI 21..108
MIDI0 = 21
GPU_ANCHORS = [0, 5, 31, 63, 95, 127]
EXC_WINDOW_MS = 7.0          # gaussKernel writes 7 of the 8 ~1 ms segments (SYNTHESIS_ENGINE.md)
Q24 = 2.0 ** 24
E_CODE = 16777215.0          # QM:25311
D_CODE = 2147000000.0        # QM:25336
IM_CODE = 65000.0            # QM:13481 (ind_mult_multiplier)
WARNINGS = []


def warn(msg):
    WARNINGS.append(msg)
    print("WARNING:", msg)


def load_col(d, name):
    return np.loadtxt(os.path.join(d, name))


def load_rows(path):
    return [list(map(float, l.split())) for l in open(path) if l.strip()]


def enc(a):
    a = np.ascontiguousarray(a, dtype=np.float64)
    return {"data": base64.b64encode(a.tobytes()).decode("ascii"), "shape": list(a.shape), "type": "float64"}


def dec(obj):
    return np.frombuffer(base64.b64decode(obj["data"]), dtype=np.dtype(obj.get("type", "float64"))).reshape(obj["shape"])


def fpga_level_interp(tables5, vint):
    """RTL + host (Construct_force_shape QM:16857ff): k = v>>5, frac = v&31, linear on raw tables."""
    if vint <= 0:
        return None
    k = vint >> 5
    frac = vint & 31
    lo = tables5[k]
    hi = tables5[min(k + 1, 4)]
    return lo + (hi - lo) * frac / 32.0


def decode_curve(raw3x5, im, mode, dt_fpga):
    """raw3x5 = (3 params [e, d, a], 5 gauss). Returns (mu_ms, sigma_ms, vol) for the GPU.
    rtl       : FPGA datapath. t += 65000*im per exciter step, x = (t - d_code)/2^29,
                arg = (e_code/2^18)*x^2 (gauss block, mapp_4_fir_4_str.slx). Exciter step = dt_fpga (INFERRED).
    legacy_ms : PianoidBasic read_excitations_from_txt constants, applied to the CORRECT slots:
                sigma = 1.28/sqrt(e) ms, centre = 81.25*d ms (the '650/8' comment), both / im.
    H0        : current production loader (mu = 1.28/sqrt(p0), sigma = p1) -- KNOWN SWAPPED, compare only.
    """
    e = np.where(raw3x5[0] <= 0, 1e-12, raw3x5[0])
    d = raw3x5[1]
    a = raw3x5[2].copy()
    a[4] = 0.0                                   # the FPGA only uses Gaussians 0..3 (QM:25305)
    if mode == "rtl":
        step_ms = dt_fpga * 1e3
        centre_steps = D_CODE * d / (IM_CODE * im)
        sigma_steps = (2 ** 29 / (IM_CODE * im)) / np.sqrt(2.0 * E_CODE * e / 2 ** 18)
        return centre_steps * step_ms, sigma_steps * step_ms, a
    if mode == "legacy_ms":
        return 81.25 * d / im, 1.28 / np.sqrt(e) / im, a
    return 1.28 / np.sqrt(e) / im, d / im, a     # H0 (production loader convention)


def curve_on_grid(mu, sigma, vol, t_ms):
    f = np.zeros_like(t_ms)
    for m, s, v in zip(mu, sigma, vol):
        if s > 0 and v != 0:
            f += np.exp(-0.5 * ((t_ms - m) / s) ** 2) * v
    return f


def build_excitation(fd, mode, dt_fpga, sign_mode):
    raw = load_col(fd, "exp_all.txt").reshape(5, N_KEYS, 3, 5)
    ind_mult = np.stack([load_col(fd, f"ind_mult_{i}.txt")[:N_KEYS] for i in range(5)])
    ind_vol = np.stack([load_col(fd, f"ind_vol_{i}.txt")[:N_KEYS] for i in range(5)])
    strength = load_col(fd, "Strength_graph.txt")
    v_level = strength[5:10]                                  # QM:13225-13240 / 13542
    ind_vol_eff = ind_vol * v_level[:, None]
    vel_map = load_col(fd, "velocity.txt").astype(int)        # MIDI -> internal (QM:4396)
    t = np.linspace(0, 40.0, 16001)
    dt_ms = t[1] - t[0]
    matrices, impulse, tail, centres = {}, np.zeros((N_KEYS, len(GPU_ANCHORS))), [], []
    for key in range(N_KEYS):
        m = np.zeros((128, 4, 5))
        for v in range(128):
            vint = int(vel_map[v])
            r = fpga_level_interp(raw[:, key], vint)
            if r is None:
                continue
            im = fpga_level_interp(ind_mult[:, key], vint)
            iv = fpga_level_interp(ind_vol_eff[:, key], vint)
            mu, sigma, vol = decode_curve(r, im, mode, dt_fpga)
            if sign_mode == "abs":
                vol = np.abs(vol)
            elif sign_mode == "clip":
                vol = np.maximum(vol, 0)
            m[v, 0], m[v, 1], m[v, 2] = mu, sigma, vol
            if v in GPU_ANCHORS:
                f = curve_on_grid(mu, sigma, vol, t)
                tot = np.abs(f).sum() * dt_ms
                impulse[key, GPU_ANCHORS.index(v)] = iv * f.sum() * dt_ms
                centres.extend(list(mu[:4]))
                if tot > 0:
                    tail.append(np.abs(f[t > EXC_WINDOW_MS]).sum() * dt_ms / tot)
        matrices[MIDI0 + key] = m
    print(f"excitation [{mode}]: gauss centres {np.min(centres):.2f}..{np.max(centres):.2f} ms")
    if tail and max(tail) > 0.01:
        warn(f"excitation ({mode}): up to {100*max(tail):.1f}% (median {100*np.median(tail):.1f}%) of |force| "
             f"lies beyond the GPU {EXC_WINDOW_MS} ms window and will be truncated")
    return matrices, impulse


def rank1_mass_speed(impulse, tmpl_mass_median, tmpl_speeds):
    A = np.abs(impulse[:, 1:])
    ok = A > 0
    la = np.where(ok, np.log(np.where(ok, A, 1)), np.nan)
    lm = np.nanmean(la, axis=1)
    lv = np.nanmean(la - lm[:, None], axis=0)
    for _ in range(20):
        lm = np.nanmean(la - lv[None, :], axis=1)
        lv = np.nanmean(la - lm[:, None], axis=0)
    resid_db = 20 / np.log(10) * np.nanmax(np.abs(la - lm[:, None] - lv[None, :]))
    m, v = np.exp(lm), np.exp(lv)
    m *= tmpl_mass_median / np.median(m)
    v *= tmpl_speeds[-1] / v[-1]
    return m, np.concatenate([[0.0], v]), resid_db


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fpga-dir", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pitch-file", default=None, help="Pitch.txt (default batch4/Pitch.txt = F_15's own, per Dima)")
    ap.add_argument("--length-offset", type=float, default=21.3,
                    help="points subtracted from N-shteg to get the effective speaking length (fit to F_15 tuning, 11.12)")
    ap.add_argument("--clock", type=float, default=393.216e6, help="FPGA clock [Hz] (Dima: 393.219 MHz)")
    ap.add_argument("--string-clocks", type=int, default=512, help="clocks per string step (512-point sweep)")
    ap.add_argument("--mode-clocks", type=int, default=256, help="clocks per mode step (256-mode sweep)")
    ap.add_argument("--exc-clocks", type=int, default=96,
                    help="clocks per exciter step: 96 = Mid_Graph2/Counter3 (SID 1634313) sweeps 96 note slots, "
                         "one per clock, per-note time RAM depth 96 (SID 1634315)")
    ap.add_argument("--exc-decode", choices=["rtl", "legacy_ms", "H0"], default="rtl")
    ap.add_argument("--volume-sign", choices=["raw", "abs", "clip"], default="raw")
    ap.add_argument("--deck-sign", choices=["keep", "abs"], default="keep")
    ap.add_argument("--mode-decrement", choices=["template", "host_q"], default="host_q",
                    help="host_q = FPGA D=Q_coeff*q_ratio/2^31 per 256-clk step, forwarded verbatim by the stm32 (11.12)")
    ap.add_argument("--mode-mass", choices=["host", "template_law"], default="host")
    ap.add_argument("--no-gamma", action="store_true")
    ap.add_argument("--no-unison", action="store_true", help="skip tension_offset from dt.txt")
    ap.add_argument("--no-hammer-geometry", action="store_true")
    ap.add_argument("--set-hammer-mass-speeds", action="store_true")
    a = ap.parse_args()

    fd = a.fpga_dir
    here = os.path.dirname(os.path.abspath(__file__))
    pitch_file = a.pitch_file or os.path.join(here, "batch4", "Pitch.txt")
    others = load_col(fd, "others.txt")
    q_ratio, omega_ratio = others[0], others[1]
    dt_fpga = a.string_clocks / a.clock
    dt_mode = a.mode_clocks / a.clock
    dt_exc = a.exc_clocks / a.clock
    f_scale = math.sqrt(4 * omega_ratio / 2 ** 31) / (2 * math.pi * dt_mode)
    print(f"steps: string {dt_fpga*1e6:.4f} us, mode {dt_mode*1e6:.4f} us, exciter {dt_exc*1e6:.4f} us; "
          f"send-all omega code reproduces f x {f_scale:.4f} ({1200*math.log2(f_scale):+.0f} cents) at the mode step")
    warn("step clock counts (string 512 / mode 256 / exciter 96) derived from model counters/RAM depths (11.11); "
         "num_point_256 itself is not defined in the delivered files (taken as 256)")

    tmpl = json.load(open(a.template))
    out = copy.deepcopy(tmpl)
    mp = out["model_parameters"]
    K = int(mp["num_modes"])

    # ---------------- modes ----------------
    freqs = load_col(fd, "omega_coef.txt")
    mass = load_col(fd, "Mass.txt")
    q = load_col(fd, "Q_coeff.txt")
    if K < len(freqs):
        warn(f"FPGA has {len(freqs)} modes; template capacity {K}: keeping 0..{K-1} (<= {freqs[K-1]:.0f} Hz)")

    def tmpl_decrement(md):
        mi, k, c = md["mass"], md["stiffness"], md["damping"]
        zeta = 0.5 * c / np.sqrt(mi * k)
        return 2 * np.pi * zeta / np.sqrt(1 - zeta ** 2)

    t_dec = np.array([tmpl_decrement(md) for md in tmpl["modes"]])
    t_mi = np.array([md["mass"] for md in tmpl["modes"]])
    host_mi = mass[:K] / freqs[:K] ** 2                       # send_mass QM:338 (relative law)
    host_mi *= np.median(t_mi) / np.median(host_mi)
    D = q[:K] * q_ratio / 2 ** 31                               # Send_Q_coef QM:9660 -> RTL s.31
    gamma_m = -np.log(1 - D) / dt_mode                          # decay rate [1/s] of the FPGA mode
    dt_gpu_mode = 1.0 / float(mp.get("sr", 48000))               # GPU mode update = 1 audio sample (SYNTHESIS_ENGINE)
    dec_gpu = 1 - np.exp(-gamma_m * dt_gpu_mode)                # same decay per second on the GPU grid
    host_dec = dec_gpu / (dt_gpu_mode * freqs[:K])               # GPU dec = dt*decrement*f (Mode.fit_params)
    modes = []
    for i in range(K):
        f = float(freqs[i])
        d = float(np.median(t_dec)) if a.mode_decrement == "template" else float(host_dec[i])
        mi = float(host_mi[i]) if a.mode_mass == "host" else 0.1 / (2 * np.pi * f) ** 2
        modes.append({"ID": i, "frequency": f, "decrement": d, "mass": mi})
    out["modes"] = modes
    tau = 1 / gamma_m
    print(f"FPGA mode damping (verbatim D): tau {tau.min()*1e3:.3f}..{tau.max()*1e3:.3f} ms, "
          f"GPU decrement {host_dec.min():.3g}..{host_dec.max():.3g} (template median {np.median(t_dec):.3g})")
    if a.mode_decrement == "template":
        warn("mode decrement = template median (NOT F_15-faithful; F_15 modes are heavily damped)")
    else:
        warn("mode decrement = F_15-faithful heavy damping (tau ~0.3-0.6 ms); untested on engine")
    if a.mode_mass == "host":
        warn("mode mass_inv = Mass/f^2 (host law, exact RELATIVE) scaled to the template median (absolute scale approximate)")

    # ---------------- deck + output ----------------
    ci = load_col(fd, "Ci_coef_cos.txt").reshape(176, 256)[:N_KEYS, :K]
    if a.deck_sign == "abs":
        ci = np.abs(ci)
    norm = np.abs(ci).max(axis=0)
    norm[norm == 0] = 1
    ci_n = ci / norm
    out_w = load_col(fd, "Ci_str_1_out.txt")[:K]
    decka = np.array(load_rows(os.path.join(fd, "decka_coeff.txt")))[:K]
    for pk, pv in out["pitches"].items():
        p = int(pk)
        if p < 128:
            key = p - MIDI0
            row = ci_n[key] if 0 <= key < N_KEYS else np.zeros(K)
            pv["deck"] = enc(np.stack([row, row]))    # FB = -Gain_FB (QM:9534) x Ci_str (~ -Ci_cos) => +Ci_cos
        else:
            old = dec(pv["deck"])
            scale = np.abs(old[1]).max() or 1.0
            ch = p - 128
            w = (decka[:, ch] if ch < decka.shape[1] else decka[:, 0]) * out_w     # QM:27817
            pv["deck"] = enc(np.stack([np.zeros(K), w / max(np.abs(w).max(), 1e-30) * scale]))
    warn("output rows = decka_coeff[:,ch]*Ci_str_1_out (host QM:27817), scaled to the template output-row max; "
         "FPGA has 16 outputs, only the template's output pitches are filled")
    if a.deck_sign == "keep" and (ci < 0).any():
        warn("deck keeps SIGNED Ci_coef_cos (FPGA loop gain per mode = |FB| Ci^2 > 0); all shipped GPU presets are "
             "non-negative -- untested on the engine")

    # ---------------- excitation ----------------
    mats, impulse = build_excitation(fd, a.exc_decode, dt_exc, a.volume_sign)
    tmpl_mass = [pv["physics"].get("hammer_mass", 0.008) for pk, pv in tmpl["pitches"].items() if int(pk) < 128]
    speeds = mp.get("hammer_speeds", [0.0, 0.3, 0.9, 1.8, 3.2, 5.5])
    m_fit, v_fit, resid = rank1_mass_speed(impulse, float(np.median(tmpl_mass)), speeds)
    print(f"loudness rank-1 fit (includes Strength_graph v_L): max residual {resid:.1f} dB, speeds {np.round(v_fit, 3)}")
    mp["level_indices"] = GPU_ANCHORS
    for pk, pv in out["pitches"].items():
        p = int(pk)
        if p in mats:
            pv["excitation"] = enc(mats[p])
            if a.set_hammer_mass_speeds:
                pv["physics"]["hammer_mass"] = float(m_fit[p - MIDI0])
    if a.set_hammer_mass_speeds:
        mp["hammer_speeds"] = [float(x) for x in v_fit]
    else:
        warn("hammer_mass/hammer_speeds kept from template (pass --set-hammer-mass-speeds for the rank-1 port)")

    # ---------------- strings ----------------
    rows = [list(map(int, l.split())) for l in open(pitch_file) if l.strip()]
    n_alloc = np.array([r[0] for r in rows], dtype=float)
    shteg = np.trunc(load_col(fd, "shteg.txt"))                 # FPGA gets (int)shteg (QM:8608, S:923)
    n_speak = n_alloc - shteg - a.length_offset              # QM:675 / QM:14310 + 21.3-pt fit (11.12)
    ttn, disp_ = load_col(fd, "ttn.txt"), load_col(fd, "disp.txt")
    B = math.pi ** 2 * (disp_ / ttn) / n_speak ** 2
    print(f"strings: Pitch file {os.path.relpath(pitch_file, here)}; speaking points {n_speak.min():.0f}..{n_speak.max():.0f}; "
          f"inharmonicity B (pi^2 Disp/Tn/N^2) {B.min():.2e}..{B.max():.2e} (report only)")
    f_note = load_col(fd, "Notes_freqs.txt")[:N_KEYS]
    _ct = load_col(fd, "ttn.txt") / Q24
    _fp = np.sqrt(_ct) * np.sqrt(1 + B) / (2 * n_speak * dt_fpga)
    _c = 1200 * np.log2(_fp / f_note)
    print(f"tuning check (ttn, Pitch, offset {a.length_offset}): median {np.median(_c):.0f} cents, "
          f"IQR {np.percentile(_c,25):.0f}..{np.percentile(_c,75):.0f}, max |{np.abs(_c).max():.0f}|")
    g = load_col(fd, "decr_op.txt") / Q24 / dt_fpga
    dtt, width, dl = load_col(fd, "dt.txt"), load_col(fd, "width.txt"), load_col(fd, "del.txt")
    for pk, pv in out["pitches"].items():
        p = int(pk)
        key = p - MIDI0
        if p >= 128 or not (0 <= key < N_KEYS):
            continue
        if not a.no_gamma:
            pv["physics"]["gamma"] = float(g[key])
        if not a.no_unison:
            pv["tension_offset"] = float(dtt[key] / ttn[key])          # strings 2/3 = ttn +/- dt (QM:1503)
        if not a.no_hammer_geometry:
            L = pv["geometry"]["length"]
            frac_alloc = 0.5 - dl[key]                                  # centre of the cap (QM:394-400)
            half_w_alloc = math.sqrt(max(0.0, 1 - width[key] ** 2))
            scale = n_alloc[key] / n_speak[key]
            h = pv["physics"].setdefault("hammer", {})
            h["hammer_position"] = float(frac_alloc * scale * L)
            h["hammer_width"] = float(2 * half_w_alloc * scale * L)
    if not a.no_gamma:
        warn(f"gamma = decr_op/2^24/dt_fpga: {g.min():.3f}..{g.max():.3f} 1/s (depends on dt_fpga)")
    if not a.no_unison:
        warn("tension_offset = dt/ttn (unison ttn +/- dt); NOTE Pianoid.initialize() overrides tension_offset "
             "and hammer position on load (DATA_FLOWS 2.7 Known Issues)")
    warn("tension/rho/r/jung/geometry/damper/disp_decay kept from template (grid-bound FPGA codes; B reported only)")

    note = {"status": "DRAFT - UNTESTED ON ENGINE", "source": os.path.abspath(fd),
            "template": os.path.abspath(a.template), "dt_string_s": dt_fpga, "dt_mode_s": dt_mode, "dt_exc_s": dt_exc, "options": vars(a),
            "warnings": WARNINGS}
    with open(a.out, "w") as fo:
        json.dump(out, fo)
    with open(os.path.splitext(a.out)[0] + ".conversion_note.json", "w") as fo:
        json.dump(note, fo, indent=1)
    print(f"wrote {a.out}  ({len(WARNINGS)} warnings)")


if __name__ == "__main__":
    main()
