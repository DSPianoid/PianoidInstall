"""dev-da62 (2026-10-04) -- R3 excitation re-time verification probe. OFFLINE, own process.

NOT the live surface: audio off, no ASIO, no realtime thread; never touches the running backend; one preset +
one load config per process (never two Pianoid instances in one process). Same level metric as
analyse-loudphys-probe.py / dev-029c (pre-volume soundFloat, m_all = RMS over all output channels 30..300 ms of
a 700 ms render, note-off 300 ms, velocity 95, equal hammer masses), plus per pitch:
  impulse   delivered impulse at v95 = coefficient * level_impulse * spatial (conserve invariant)
  tau_ms    equivalent width of the v95 curve (Pianoid.excitation_retime.equivalent_width_ms)
and for the --wave pitches (timbre / pitch / decay):
  f0        spectral peak near the nominal 12-TET frequency (+-60 cents, 50..300 ms, parabolic interp)
  decay     dB/s slope of the 20 ms-frame RMS envelope, 50..290 ms
  centroid  spectral centroid (Hz) of the 30..300 ms segment, channels summed; centroid_attack = 0..30 ms

    python dev-da62-retime-probe.py PRESET ARRAY SI DERIV LTM OUT.json --mw <pianoid_middleware> --pkg <staged pkg>
        [--mass-g 10] [--vel 95] [--pitches 36,60,84] [--wave 24,36,60,84,96,105]

The preset is rewritten to a temp file with output_scale_calibrated = true (no load-time render).
"""
import argparse
import json
import math
import os
import sys
import tempfile

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


def level(snd):
    fin = np.where(np.isfinite(snd), snd, 0.0)
    seg = fin[:, int(0.030 * SR):int(0.300 * SR)]
    return {"m_all": db(float(np.sqrt(np.mean(seg ** 2)))), "peak": db(float(np.abs(fin).max())),
            "nonfinite": int((~np.isfinite(snd)).sum())}


def centroid(x):
    w = np.hanning(len(x))
    s = np.abs(np.fft.rfft(x * w)) ** 2
    f = np.fft.rfftfreq(len(x), 1.0 / SR)
    return float((f * s).sum() / s.sum()) if s.sum() > 0 else None


def timbre(snd, pitch):
    mono = np.where(np.isfinite(snd), snd, 0.0).sum(axis=0)
    f_nom = 440.0 * 2 ** ((pitch - 69) / 12.0)
    seg = mono[int(0.050 * SR):int(0.300 * SR)]
    n = 1 << 20
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n))
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    band = (freqs > f_nom * 2 ** (-0.05)) & (freqs < f_nom * 2 ** 0.05)
    i = int(np.flatnonzero(band)[spec[band].argmax()])
    a, b, c = np.log(spec[i - 1:i + 2] + 1e-300)
    f0 = freqs[i] + 0.5 * (a - c) / (a - 2 * b + c) * (freqs[1] - freqs[0])
    fr = int(0.020 * SR)
    t, e = [], []
    for s0 in range(int(0.050 * SR), int(0.290 * SR) - fr, fr):
        r = float(np.sqrt(np.mean(mono[s0:s0 + fr] ** 2)))
        if r > 0:
            t.append(s0 / SR); e.append(20 * math.log10(r))
    decay = float(np.polyfit(t, e, 1)[0]) if len(t) > 2 else None
    # decay of the FUNDAMENTAL alone (linear system: independent of the excitation; the broadband slope is not,
    # it follows the partial mix): 40 ms Hann frames, DFT at f0, 50..290 ms
    fl = int(0.040 * SR)
    tt, ee = [], []
    for s0 in range(int(0.050 * SR), int(0.290 * SR) - fl, fl // 2):
        x = mono[s0:s0 + fl] * np.hanning(fl)
        amp = abs(np.dot(x, np.exp(-2j * np.pi * f0 * np.arange(fl) / SR)))
        if amp > 0:
            tt.append(s0 / SR); ee.append(20 * math.log10(amp))
    decay_f0 = float(np.polyfit(tt, ee, 1)[0]) if len(tt) > 2 else None
    return {"f0": float(f0), "f0_cents_vs_nominal": 1200 * math.log2(f0 / f_nom), "decay_db_per_s": decay,
            "decay_f0_db_per_s": decay_f0,
            "centroid": centroid(mono[int(0.030 * SR):int(0.300 * SR)]),
            "centroid_attack": centroid(mono[:int(0.030 * SR)])}


def main():
    ap = argparse.ArgumentParser()
    for a_ in ("preset", "array_size", "si", "deriv", "ltm", "out"):
        ap.add_argument(a_, type=int if a_ in ("array_size", "si", "deriv", "ltm") else str)
    ap.add_argument("--mw", required=True); ap.add_argument("--pkg", required=True)
    ap.add_argument("--pitches", default=None); ap.add_argument("--mass-g", type=float, default=10.0)
    ap.add_argument("--vel", type=int, default=95); ap.add_argument("--wave", default="")
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.mw))
    sys.path.insert(0, os.path.abspath(a.pkg))
    d = json.load(open(os.path.abspath(a.preset)))
    d["model_parameters"]["output_scale_calibrated"] = True
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(d, tmp); tmp.close()
    os.chdir(os.path.abspath(a.mw))
    import Pianoid
    assert os.path.abspath(Pianoid.__file__).startswith(os.path.abspath(a.pkg)), Pianoid.__file__
    from Pianoid.excitation_retime import EngineGrid, equivalent_width_ms
    from pianoid import initialize
    p = initialize(tmp.name, filterlen=48 * 128 * 3, string_iteration=a.si, array_size=a.array_size, sample_rate=SR,
                   samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0, listen_to_modes=bool(a.ltm),
                   sound_derivative_order=a.deriv, use_debug_build=False)
    os.unlink(tmp.name)
    keys = sorted(p.sm.keyPitches)
    pitches = [int(x) for x in a.pitches.split(",")] if a.pitches else keys
    if a.mass_g > 0:
        for k in keys:
            p.sm.pitches[k].physics.hammer_mass = a.mass_g * 1e-3
    with p.cuda_lock:
        p._upload_excitation_coefficients()
        p.pianoid.waitForParameterUpdate()
    cache = p.param_manager._coeff_cache
    grid = EngineGrid({"mode_iteration": p.mp.mode_iteration, "string_iteration": p.mp.string_iteration,
                       "sr": p.mp.sr, "excitation_factor": p.mp.excitation_factor})
    out = {"preset": os.path.basename(a.preset), "array_size": a.array_size, "si": a.si, "deriv": a.deriv,
           "ltm": a.ltm, "vel": a.vel, "mass_g": a.mass_g, "string_gain_model": p.mp.string_gain_model,
           "x_unit_ms": grid.x_unit_ms}
    for k in pitches:       # warm-up sweep (dev-168c: first renders after initialize() are up to ~1 dB off)
        render(p, k, a.vel)
    wave = {int(x) for x in a.wave.split(",") if x}
    res = {}
    for k in pitches:
        snd = render(p, k, a.vel)
        m = level(snd)
        pt = p.sm.pitches[k]
        pf = cache.factors["pitch"][k]
        lm = pt.excitation.levels_matrix
        m.update({"impulse": float(cache.full_by_pitch[k][a.vel]) * pt.excitation.level_impulse(a.vel) * pf["spatial"],
                  "tau_ms": equivalent_width_ms(lm[a.vel], grid), "n_strings": len(pt.stringIDs),
                  "f0_ideal": float(math.sqrt(pt.physics.tension / pt.physics.rho) / (2 * pt.geometry.l_main()))})
        if k in wave:
            m.update(timbre(snd, k))
        res[str(k)] = m
    out["pitches"] = res
    with open(a.out, "w") as f:
        json.dump(out, f)
    print("RESULT written", a.out)


if __name__ == "__main__":
    main()
