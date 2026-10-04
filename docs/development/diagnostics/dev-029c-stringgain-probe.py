"""dev-029c (2026-10-04) -- physical string gain (R1+R2) verification probe. OFFLINE, own process.

NOT the live surface: audio off, no ASIO, no realtime thread; never touches the running backend; one preset +
one load config per process (never two Pianoid instances in one process). Same metric as analyse-loudphys-probe.py
(dev-168c convention): pre-volume soundFloat, m_all = RMS over all output channels 30..300 ms of a 700 ms render
(note-off 300 ms), peak = max |x|.

    python dev-029c-stringgain-probe.py PRESET ARRAY SI DERIV LTM OUT.json --mw <pianoid_middleware> --pkg <dir>
        [--model physical|legacy] [--exponent K] [--reference R] [--mass-g 10 | 0 = preset masses]
        [--variant rhoT_x:4:36,60,84 | main_x:0.5:36,60,84] [--pitches 36,60,84] [--wave 24,60,96]

--pkg is put FIRST on sys.path (a staged copy of the worktree PianoidBasic, so the shared venv is untouched).
The preset is rewritten to a temp file with model_parameters string_gain_model / unison_split_exponent /
string_gain_reference (--reference carries the BASE preset's frozen R into a variant, as a saved preset would)
and output_scale_calibrated = true (no load-time render). --wave saves the raw renders (npz) for waveform
identity checks (pitch/decay).
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


def metrics(snd):
    fin = np.where(np.isfinite(snd), snd, 0.0)
    seg = fin[:, int(0.030 * SR):int(0.300 * SR)]
    return {"m_all": db(float(np.sqrt(np.mean(seg ** 2)))), "peak": db(float(np.abs(fin).max())),
            "nonfinite": int((~np.isfinite(snd)).sum())}


def apply_variant(d, variant):
    kind, f, pitches = variant.split(":")
    f = float(f)
    for k in pitches.split(","):
        if kind == "rhoT_x":
            ph = d["pitches"][k]["physics"]
            ph["rho"] *= f; ph["tension"] *= f; ph["jung"] *= f
        elif kind == "main_x":
            g = d["pitches"][k]["geometry"]
            g["main"] = max(4, int(round(g["main"] * f)))
        else:
            raise SystemExit("unknown variant " + kind)


def main():
    ap = argparse.ArgumentParser()
    for a_ in ("preset", "array_size", "si", "deriv", "ltm", "out"):
        ap.add_argument(a_, type=int if a_ in ("array_size", "si", "deriv", "ltm") else str)
    ap.add_argument("--mw", required=True); ap.add_argument("--pkg", required=True)
    ap.add_argument("--model", default=None); ap.add_argument("--exponent", type=float, default=None)
    ap.add_argument("--reference", type=float, default=None); ap.add_argument("--variant", default=None)
    ap.add_argument("--pitches", default=None); ap.add_argument("--mass-g", type=float, default=10.0)
    ap.add_argument("--vel", type=int, default=95); ap.add_argument("--wave", default="")
    a = ap.parse_args()
    sys.path.insert(0, os.path.abspath(a.mw))
    sys.path.insert(0, os.path.abspath(a.pkg))
    d = json.load(open(os.path.abspath(a.preset)))
    mp = d["model_parameters"]
    if a.model is not None:
        mp["string_gain_model"] = a.model
    if a.exponent is not None:
        mp["unison_split_exponent"] = a.exponent
    if a.reference is not None:
        mp["string_gain_reference"] = a.reference
    mp["output_scale_calibrated"] = True
    if a.variant:
        apply_variant(d, a.variant)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(d, tmp); tmp.close()
    os.chdir(os.path.abspath(a.mw))
    import Pianoid
    assert os.path.abspath(Pianoid.__file__).startswith(os.path.abspath(a.pkg)), Pianoid.__file__
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
    out = {"preset": os.path.basename(a.preset), "array_size": a.array_size, "si": a.si, "deriv": a.deriv,
           "ltm": a.ltm, "vel": a.vel, "mass_g": a.mass_g, "variant": a.variant,
           "string_gain_model": p.mp.string_gain_model, "unison_split_exponent": p.mp.unison_split_exponent,
           "string_gain_reference": p.mp.string_gain_reference, "output_scale": float(p.mp.output_scale)}
    for k in pitches:       # warm-up sweep (dev-168c: first renders after initialize() are up to ~1 dB off)
        render(p, k, a.vel)
    waves = {}
    wave = {int(x) for x in a.wave.split(",") if x}
    res = {}
    for k in pitches:
        snd = render(p, k, a.vel)
        m = metrics(snd)
        pt = p.sm.pitches[k]
        pf = cache.factors["pitch"][k]
        m.update({"string_gain": pf.get("string_gain", 1.0), "rho": float(pt.physics.rho),
                  "dx": float(pt.geometry.dx()), "n_strings": len(pt.stringIDs),
                  "hammer_mass": float(pt.physics.hammer_mass),
                  "coeff_v95": float(cache.full_by_pitch[k][a.vel]),
                  "coeff_base": [float(x) for x in cache.full_by_pitch[k][[0, 5, 31, 63, 95, 127]]]})
        res[str(k)] = m
        if k in wave:
            waves[str(k)] = snd
    out["pitches"] = res
    with open(a.out, "w") as f:
        json.dump(out, f)
    if waves:
        np.savez_compressed(os.path.splitext(a.out)[0] + "_waves.npz", **waves)
    print("RESULT written", a.out)


if __name__ == "__main__":
    main()
