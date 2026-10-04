"""analyse-loudphys (2026-10-04) -- loudness-chain physics-deviation probe. OFFLINE, own process.

NOT the live surface: audio off, no ASIO, no realtime thread; never touches the running backend.
One preset + one load config per process (never two Pianoid instances in one process).

    PianoidCore/.venv/Scripts/python analyse-loudphys-probe.py PRESET.json ARRAY SI DERIV LTM OUT.json \
        [--pitches 36,60,84] [--mass-g 10] [--vel 95] [--no-warmup] [--dump]

Every KEY pitch (or --pitches) is rendered at velocity VEL with EVERY hammer_mass set to --mass-g
(equal masses => the per-pitch level is the engine's gain per unit hammer impulse c*m*v). Metrics
per pitch (dev-168c convention, pre-volume soundFloat): m_all = RMS over all output channels
30..300 ms of a 700 ms render (note-off at 300 ms), m_ch = hottest channel RMS, peak = max |x|.
--dump also writes the engine mode coefficients (dec, omega, mass_inv), the packed deck rows and the
per-pitch string/hammer factors so the analytic board transfer can be computed without the GPU.
"""
import argparse
import json
import math
import os
import sys

import numpy as np

SR, SPC = 48000, 64


def db(x):
    return round(20 * math.log10(x), 3) if x > 0 else None


def render(p, pitch, vel, hold_ms=300, total_ms=700):
    import pianoidCuda
    from PanoidResult import PianoidResult
    eq = pianoidCuda.EventQueue()
    off = int(hold_ms / 1000 * SR / SPC)
    for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel), (off, pianoidCuda.EventType.NOTE_OFF, 0)):
        ev = pianoidCuda.PlaybackEvent()
        ev.channel, ev.cycle_index, ev.type, ev.data = 0, cyc, typ, (pitch << 8) | v
        eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, total_ms
    cpp = p.pianoid
    with p.cuda_lock:
        cpp.waitForParameterUpdate()
        cpp.resetStringsState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        stats = cpp.runOfflinePlayback(eq, cfg)
        if not stats.completed_successfully:
            raise RuntimeError(stats.error_message)
        res = PianoidResult(cpp, p.mp)
        res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound, dtype=np.float64)


def measure(p, pitch, vel):
    snd = render(p, pitch, vel)
    fin = np.where(np.isfinite(snd), snd, 0.0)
    seg = fin[:, int(0.030 * SR):int(0.300 * SR)]
    return {"m_all": db(float(np.sqrt(np.mean(seg ** 2)))),
            "m_ch": db(float(np.sqrt(np.mean(seg ** 2, axis=1)).max())),
            "m_ch0": db(float(np.sqrt(np.mean(seg[0] ** 2)))),
            "peak": db(float(np.abs(fin).max())),
            "nonfinite": int((~np.isfinite(snd)).sum())}


def delivered_impulse(p, pitch, level):
    cache = p.param_manager._coeff_cache
    coeff = float(cache.full_by_pitch[pitch][level])
    pf = cache.factors['pitch'][pitch]
    return coeff * p.sm.pitches[pitch].excitation.level_impulse(level) * pf['spatial']


def pitch_factors(p, pitch, vel):
    pt = p.sm.pitches[pitch]
    g, ph = pt.geometry, pt.physics
    dx = g.dx()
    shape = np.asarray(ph.get_hammer(), dtype=float)
    lm = pt.excitation.levels_matrix[int(vel)]
    length = p.mp.excitation_length()
    k = np.arange(length, dtype=float)
    x = k * (p.mp.excitation_factor / length)
    z = (x[:, None] - lm[0][None, :]) / lm[1][None, :]
    f = (np.maximum(np.exp(-0.5 * z * z) - lm[3][None, :], 0.0) * lm[2][None, :]).sum(axis=1)
    return {"tension": float(ph.tension), "rho": float(ph.rho), "r": float(ph.r), "jung": float(ph.jung),
            "gamma": float(ph.gamma), "length": float(g.l_main()), "main": int(g.p_main()), "tail": int(g.p_tail()),
            "dx": float(dx), "hammer_width": float(ph.hammer.width), "hammer_position": float(ph.hammer.pos_ratio),
            "n_contact": int((shape > 0).sum()), "spatial_sum": float(shape.sum()),
            "n_strings": int(len(pt.stringIDs)), "hammer_mass": float(ph.hammer_mass),
            "f0_ideal": float(math.sqrt(ph.tension / ph.rho) / (2 * g.l_main())) if ph.rho > 0 and g.l_main() > 0 else None,
            "curve_peak": float(f.max()), "curve_sum": float(f.sum()),
            "curve_width_ms": float(f.sum() / f.max() * (p.mp.excitation_factor / length)) if f.max() > 0 else None,
            "delivered_impulse": delivered_impulse(p, pitch, int(vel))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset"); ap.add_argument("array_size", type=int); ap.add_argument("si", type=int)
    ap.add_argument("deriv", type=int); ap.add_argument("ltm", type=int); ap.add_argument("out")
    ap.add_argument("--pitches", default=None); ap.add_argument("--mass-g", type=float, default=10.0)
    ap.add_argument("--vel", type=int, default=95); ap.add_argument("--no-warmup", action="store_true")
    ap.add_argument("--dump", action="store_true"); ap.add_argument("--repeat", type=int, default=1)
    a = ap.parse_args()
    preset = os.path.abspath(a.preset)
    mw = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidCore", "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=a.si, array_size=a.array_size, sample_rate=SR,
                   samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=bool(a.ltm),
                   sound_derivative_order=a.deriv, use_debug_build=False)
    keys = sorted(p.sm.keyPitches)
    pitches = [int(x) for x in a.pitches.split(",")] if a.pitches else keys
    # equal masses everywhere, then the full coefficient rebuild (same path as preset load)
    for k in keys:
        p.sm.pitches[k].physics.hammer_mass = a.mass_g * 1e-3
    with p.cuda_lock:
        p._upload_excitation_coefficients()
        p.pianoid.waitForParameterUpdate()
    out = {"preset": os.path.basename(preset), "array_size": a.array_size, "string_iteration": a.si, "deriv": a.deriv,
           "listen_to_modes": a.ltm, "vel": a.vel, "mass_g": a.mass_g, "num_channels": int(p.mp.num_channels),
           "output_scale": float(p.mp.output_scale), "dt": float(p.mp.dt())}
    if not a.no_warmup:   # dev-168c: first renders after initialize() are up to ~1 dB off; one throw-away sweep
        for k in pitches:
            render(p, k, a.vel)
    res = {}
    for k in pitches:
        runs = [measure(p, k, a.vel) for _ in range(a.repeat)]
        m = dict(runs[-1])
        if a.repeat > 1:
            m["m_all_runs"] = [r["m_all"] for r in runs]
        m["factors"] = pitch_factors(p, k, a.vel)
        res[str(k)] = m
    out["pitches"] = res
    if a.dump:
        md = np.asarray(p.pianoid.getModeDisplacements(), dtype=float)
        n = int(p.mp.num_modes)
        out["modes"] = {"dec": md[2 * n:3 * n].tolist(), "omega": md[3 * n:4 * n].tolist(),
                        "mass_inv": md[4 * n:5 * n].tolist(),
                        "frequency": [float(getattr(m, 'frequency', 0) or 0) for m in p.mm.modes.values()] if hasattr(p, 'mm') else None}
        feedin, feedback = p.sm.pack_deck(pack_for_cuda=False, single_matrix_mode=False)
        out["deck"] = {"pitch_index": [int(x) for x in p.sm.pitch_index],
                       "feedin_rows": {str(int(pid)): feedin[i].tolist() for i, pid in enumerate(p.sm.pitch_index)},
                       "deck_feedback_coefficient": float(getattr(p.mp, 'deck_feedback_coefficient', 1.0))}
    with open(a.out, "w") as f:
        json.dump(out, f)
    print("RESULT written", a.out)


if __name__ == "__main__":
    main()
