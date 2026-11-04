"""dev-bow2: listening WAVs of the friction bow (offline render, in-process, audio_off).

Output channel 0 (the normal output; no documented speakers-mode mix), 48 kHz 24-bit mono.
Each note is held 3 s then released, 1 s tail (4 s files). Every file is peak-normalised to
-3 dBFS on its own, except the velocity pair (normalised together, relative level kept).
BaselinePreset1 sits ~-17 cents flat (pitch 48 renders at 129.4 Hz, nominal 130.8).

Usage: python dev-bow2-wavs.py --core D:/repos/wt-bow-core --out <dir> [--suffix _v2]
"""
import argparse
import os
import sys
import threading
import time
import wave

import numpy as np

SR = 48000
SPC = 64
HOLD = 3.0
TOTAL = 4.0
SWELL_WALL_PER_AUDIO_S = 0.42   # the offline render runs ~2.4x real time (measured); the swell timer is wall-clock


def ev(pc, pitch, vel, t_s, on=True):
    e = pc.PlaybackEvent()
    e.type = pc.EventType.NOTE_ON if on else pc.EventType.NOTE_OFF
    e.channel = 0
    e.cycle_index = int(round(t_s * SR / SPC))
    e.data = (pitch << 8) | (vel if on else 0)
    return e


def render(p, pc, pitch, vel, actions=()):
    from PanoidResult import PianoidResult
    eng = p.pianoid
    eng.resetStringsState()
    q = pc.EventQueue()
    q.addEvent(ev(pc, pitch, vel, 0.02))
    q.addEvent(ev(pc, pitch, 0, 0.02 + HOLD, on=False))
    q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.max_duration_ms = int(TOTAL * 1000)
    cfg.sample_rate = SR
    cfg.samples_per_cycle = SPC
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
    x = np.asarray(res.sound[0], dtype=np.float64)[:int(TOTAL * SR)]
    assert not np.isnan(x).any()
    return x


def write24(path, x, gain):
    y = np.clip(x * gain, -1, 1)
    i = (y * (2 ** 23 - 1)).astype(np.int32)
    b = np.zeros((len(i), 3), np.uint8)
    b[:, 0] = i & 0xFF
    b[:, 1] = (i >> 8) & 0xFF
    b[:, 2] = (i >> 16) & 0xFF
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(b.tobytes())


def norm_gain(*xs):
    return 10 ** (-3 / 20) / max(np.abs(x).max() for x in xs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--suffix", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    import pianoidCuda as pc
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    eng = p.pianoid
    sfx = args.suffix
    files = []

    def bow(pitch, vel=90, force=0.5, angle=0.3, actions=()):
        p.set_pitch_excitation_mode(pitch, 1)
        eng.setBowForce(force)
        eng.setBowSoftness(angle)
        x = render(p, pc, pitch, vel, actions)
        p.set_pitch_excitation_mode(pitch, 0)
        eng.setBowForce(0.5)
        eng.setBowSoftness(0.3)
        return x

    def save(name, x, gain=None, note=""):
        path = os.path.join(args.out, f"{name}{sfx}.wav")
        write24(path, x, norm_gain(x) if gain is None else gain)
        files.append((path, note, float(np.abs(x).max())))

    try:
        for pitch, name in ((45, "A2_45"), (48, "C3_48"), (60, "C4_60"), (67, "G4_67")):
            save(f"bow_{name}_default", bow(pitch), note="bow vel 90, force 0.5, angle 0.3")
        for f in (0.1, 0.5, 0.95):
            save(f"bow_C3_force_{f}", bow(48, force=f), note=f"force {f}, angle 0.3")
        for a in (0.0, 1.0):
            save(f"bow_C3_angle_{a}", bow(48, angle=a), note=f"angle {a}, force 0.5")
        # live swell, timer-driven (the offline render runs about 2x real time: steps in wall time)
        steps = np.linspace(0, 1, 41)
        prof = np.interp(steps, [0, 0.5, 1], [0.1, 0.9, 0.2])
        acts = [(s * HOLD * SWELL_WALL_PER_AUDIO_S, (lambda v: (lambda: eng.setBowForce(float(v))))(v)) for s, v in zip(steps, prof)]
        save("bow_C3_force_swell", bow(48, force=0.1, actions=acts), note="force 0.1 -> 0.9 -> 0.2 while held (live CC path)")
        lo, hi = bow(48, vel=40), bow(48, vel=115)
        g = norm_gain(lo, hi)
        save("bow_C3_vel_40", lo, g, note="velocity 40, normalised together with vel 115")
        save("bow_C3_vel_115", hi, g, note="velocity 115, normalised together with vel 40")
        save("hammer_C3_v80_reference", render(p, pc, 48, 80), note="hammer reference")
    finally:
        eng.shutdownGpu()
    for path, note, peak in files:
        print(f"{os.path.basename(path)} | {note} | raw peak {peak:.3e}")


if __name__ == "__main__":
    main()
