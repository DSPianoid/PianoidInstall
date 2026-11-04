"""dev-bow2: offline-render verification of the friction bow (audio_off, in-process).

Scenarios (BaselinePreset1, the perf-suite engine config, 64 samples / 48 kHz):
  hammer    pitch 60 vel 80 hammer note -> saved buffer; with --compare, correlation / max diff
            against a buffer from another engine (the hammer path must be unchanged)
  sustain   bowed pitch, vel 90, key held 0.2-2.6 s: envelope, pitch, harmonics, release
  speed     the same note at vel 40 and vel 115: steady level ratio
  force     steady level / brightness at force 0.1 / 0.3 / 0.5 / 0.95 (angle 0.3)
  angle     steady level / brightness at angle 0 / 0.5 / 1 (force 0.5)
  live      force 0.5 -> 0.05 -> 0.95 changed while the key is held (no retrigger): 50 ms envelope
Every scenario reports NaN samples and amplitude-gate trips.

Usage: python dev-bow2-bow-render.py --core D:/repos/wt-bow-core --label after [--pitch 48]
                                     [--scenarios hammer,sustain,...] [--compare hammer_before.npy]
"""
import argparse
import json
import os
import sys
import threading
import time

import numpy as np

SR = 48000
SPC = 64


def ev(pc, pitch, vel, t_s, on=True):
    e = pc.PlaybackEvent()
    e.type = pc.EventType.NOTE_ON if on else pc.EventType.NOTE_OFF
    e.channel = 0
    e.cycle_index = int(round(t_s * SR / SPC))
    e.data = (pitch << 8) | (vel if on else 0)
    return e


def render(p, pc, events, dur_s, actions=()):
    """Offline render; `actions` = [(t_s, fn)] run from a timer thread while the render is paced."""
    from PanoidResult import PianoidResult
    eng = p.pianoid
    eng.resetStringsState()
    q = pc.EventQueue()
    for e in events:
        q.addEvent(e)
    q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.max_duration_ms = int(dur_s * 1000)
    cfg.sample_rate = SR
    cfg.samples_per_cycle = SPC
    trips0 = list(eng.getGateTripStats()) if hasattr(eng, "getGateTripStats") else None
    t0 = time.perf_counter()

    def run_actions():
        for t, fn in actions:
            time.sleep(max(0.0, t - (time.perf_counter() - t0)))
            fn()
    th = threading.Thread(target=run_actions)
    th.start()
    stats = eng.runOfflinePlayback(q, cfg)
    th.join()
    assert stats.completed_successfully, stats.error_message
    res = PianoidResult(eng, p.mp)
    res.load_offline_sound_from_pianoid()
    x = np.asarray(res.sound[0], dtype=np.float64)
    trips1 = list(eng.getGateTripStats()) if trips0 is not None else None
    return x, {"nan": int(np.isnan(x).sum()), "gate_trips": (trips1[0] - trips0[0]) if trips0 else None,
               "wall_s": round(time.perf_counter() - t0, 2)}


def seg(x, a, b):
    return x[int(a * SR):int(b * SR)]


def rms(x):
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


def db(a, b):
    return 20 * np.log10(max(a, 1e-30) / max(b, 1e-30))


def f0_autocorr(x, fmin=25, fmax=2000):
    x = x - x.mean()
    n = 1 << int(np.ceil(np.log2(2 * len(x))))
    X = np.fft.rfft(x, n)
    ac = np.fft.irfft(X * np.conj(X))[:len(x)]
    lo, hi = int(SR / fmax), int(SR / fmin)
    k = lo + int(np.argmax(ac[lo:hi]))
    if 1 <= k < len(ac) - 1:   # parabolic refinement
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        k = k + 0.5 * (a - c) / (a - 2 * b + c)
    return SR / k


def harmonics(x, f0, n=10):
    w = x * np.hanning(len(x))
    sp = np.abs(np.fft.rfft(w, 8 * len(x)))
    f = np.fft.rfftfreq(8 * len(x), 1 / SR)
    out = []
    for h in range(1, n + 1):
        band = (f > f0 * (h - 0.3)) & (f < f0 * (h + 0.3))
        out.append(float(sp[band].max()) if band.any() else 0.0)
    ref = max(out[0], 1e-30)
    return [round(db(v, ref), 1) for v in out]


def centroid(x):
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return float((sp * f).sum() / max(sp.sum(), 1e-30))


def dominant_hz(x):
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x)), 4 * len(x)))
    f = np.fft.rfftfreq(4 * len(x), 1 / SR)
    m = f > 20
    return float(f[m][np.argmax(sp[m])])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--pitch", type=int, default=48)
    ap.add_argument("--scenarios", default="hammer,sustain,speed,force,angle,live")
    ap.add_argument("--compare", default=None, help="hammer buffer .npy from another engine")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    P = args.pitch
    f_nom = 440.0 * 2 ** ((P - 69) / 12)
    out = {"label": args.label, "pitch": P, "f_nominal": round(f_nom, 2)}
    has_bow_api = hasattr(eng, "setBowForce")
    scen = args.scenarios.split(",")
    try:
        if "hammer" in scen:
            x, info = render(p, pc, [ev(pc, 60, 80, 0.1)], 2.0)
            np.save(os.path.join(args.outdir, f"dev-bow2-hammer-{args.label}.npy"), x)
            out["hammer"] = {**info, "rms": rms(x)}
            if args.compare:
                y = np.load(args.compare)
                n = min(len(x), len(y))
                out["hammer"]["vs_compare"] = {"corr": float(np.corrcoef(x[:n], y[:n])[0, 1]),
                                               "max_abs_diff_rel": float(np.abs(x[:n] - y[:n]).max() / max(np.abs(y[:n]).max(), 1e-30))}
        p.set_pitch_excitation_mode(P, 1)
        if has_bow_api:
            eng.setBowForce(0.5)
            eng.setBowSoftness(0.3)
        if "sustain" in scen:
            x, info = render(p, pc, [ev(pc, P, 90, 0.2), ev(pc, P, 0, 2.6, on=False)], 3.6)
            np.save(os.path.join(args.outdir, f"dev-bow2-sustain-{args.label}.npy"), x)
            env = [rms(seg(x, t, t + 0.1)) for t in np.arange(0.0, 3.6, 0.1)]
            steady = seg(x, 1.0, 2.5)
            st = [rms(seg(x, t, t + 0.1)) for t in np.arange(1.0, 2.5, 0.1)]
            f0 = f0_autocorr(seg(x, 1.5, 2.5))
            out["sustain"] = {**info,
                              "env_db_100ms": [round(db(v, max(env)), 1) for v in env],
                              "steady_rms": rms(steady),
                              "steady_flatness_db": round(db(max(st), min(st)), 2),
                              "release_drop_db_0.4s": round(db(rms(seg(x, 2.0, 2.5)), rms(seg(x, 3.0, 3.1))), 1),
                              "f0_autocorr": round(f0, 2), "f0_cents_vs_nominal": round(1200 * np.log2(f0 / f_nom), 1),
                              "dominant_hz": round(dominant_hz(steady), 1),
                              "harmonics_db": harmonics(steady, f0)}
        if "speed" in scen:
            lv = {}
            for vel in (40, 115):
                x, info = render(p, pc, [ev(pc, P, vel, 0.2)], 2.0)
                lv[vel] = {**info, "rms": rms(seg(x, 1.0, 1.9)), "centroid": round(centroid(seg(x, 1.0, 1.9)), 1)}
            out["speed"] = {"levels": lv, "ratio_db_115_vs_40": round(db(lv[115]["rms"], lv[40]["rms"]), 2)}
        def steady(force, angle, vel=90):
            eng.setBowForce(force)
            eng.setBowSoftness(angle)
            x, info = render(p, pc, [ev(pc, P, vel, 0.2)], 2.0)
            v = seg(x, 1.0, 1.9)
            return {**info, "rms": rms(v), "centroid": round(centroid(v), 1),
                    "f0": round(f0_autocorr(v), 2), "harmonics_db": harmonics(v, f0_autocorr(v), 8)}
        if has_bow_api and "force" in scen:
            out["force"] = {str(f): steady(f, 0.3) for f in (0.1, 0.3, 0.5, 0.95)}
        if has_bow_api and "angle" in scen:
            out["angle"] = {str(a): steady(0.5, a) for a in (0.0, 0.5, 1.0)}
        if has_bow_api and "live" in scen:
            # Live change while the key is held: force 0.5 -> 0.05 from a timer thread (the offline render
            # is not paced exactly, so the step is located in the audio). No retrigger = no new attack.
            eng.setBowForce(0.5)
            eng.setBowSoftness(0.3)
            acts = [(1.0, lambda: eng.setBowForce(0.05)), (2.0, lambda: eng.setBowForce(0.95))]
            x, info = render(p, pc, [ev(pc, P, 90, 0.2)], 4.0, acts)
            np.save(os.path.join(args.outdir, f"dev-bow2-live-{args.label}.npy"), x)
            env = [rms(seg(x, t, t + 0.05)) for t in np.arange(0.0, 4.0, 0.05)]
            cen = [round(centroid(seg(x, t, t + 0.2)), 0) for t in np.arange(0.0, 4.0, 0.2)]
            out["live"] = {**info, "env_db_50ms": [round(db(v, max(env)), 1) for v in env], "centroid_200ms": cen}
            eng.setBowForce(0.5)
        p.set_pitch_excitation_mode(P, 0)
    finally:
        eng.shutdownGpu()
    print(json.dumps(out, indent=1))
    with open(os.path.join(args.outdir, f"dev-bow2-render-{args.label}.json"), "w") as f:
        json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
