"""dev-a480 -- offline render of an FPGA-converted preset (verification surface for the converter).

ONE preset per process (never two Pianoid instances in one process; never the live backend):
    PYTHONPATH=<PianoidBasic build> PianoidCore/.venv/Scripts/python \
        docs/development/diagnostics/dev-a480-fpga-render.py PRESET.json LABEL OUT_DIR [--core CORE_DIR]

Renders low/mid/high notes at two velocities with the key held, de-interleaves the multi-channel
offline buffer (PianoidResult), and writes OUT_DIR/LABEL/results.json (+ channel-0 WAVs):
pitch (harmonic-comb detector of auto_tuner, cents vs F_15 Notes_freqs), decay (dB/s of the 50 ms RMS
envelope, 0.2..1.3 s), loudness (RMS / peak), NaN count, int32 headroom at the current volume
coefficient, and a read-back of the preset fields the converter writes (gamma, tension_offset,
hammer position/width) after initialize().
"""
import argparse
import json
import os
import sys
import wave

import numpy as np

NOTES = (33, 60, 96)                 # A1 / C4 / C7 (template covers MIDI 23..106)
VELOCITIES = (64, 110)
HOLD_MS, RENDER_MS = 1400, 1600
SR, SPC = 48000, 64


def notes_freq(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)   # == F_15 Notes_freqs.txt (12-TET, A4 = 440)


def render(p, pitch, vel):
    import pianoidCuda
    from PanoidResult import PianoidResult
    eq = pianoidCuda.EventQueue()
    for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel),
                        (int(HOLD_MS / 1000 * SR / SPC), pianoidCuda.EventType.NOTE_OFF, 0)):
        ev = pianoidCuda.PlaybackEvent()
        ev.channel, ev.cycle_index, ev.type, ev.data = 0, cyc, typ, (pitch << 8) | v
        eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, RENDER_MS
    cpp = p.pianoid
    with p.cuda_lock:
        cpp.resetStringsState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        stats = cpp.runOfflinePlayback(eq, cfg)
        if not stats.completed_successfully:
            raise RuntimeError(stats.error_message)
        res = PianoidResult(cpp, p.mp)
        res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound, dtype=np.float64)          # (channels, samples)


def decay_db_per_s(x):
    n = int(0.05 * SR)
    env = np.array([np.sqrt(np.mean(x[i:i + n] ** 2)) for i in range(0, len(x) - n, n)])
    t = (np.arange(len(env)) + 0.5) * 0.05
    sel = (t > 0.2) & (t < 1.3) & (env > 0)
    if sel.sum() < 4:
        return None
    return float(np.polyfit(t[sel], 20 * np.log10(env[sel]), 1)[0])


def write_wav(path, x):
    peak = np.max(np.abs(x)) or 1.0
    pcm = (x / peak * 0.9 * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def readback(p, preset):
    out = {}
    for pid in (str(n) for n in NOTES):
        pv, pm = preset["pitches"][pid], p.sm.pitches[int(pid)]
        h = pm.physics.hammer
        out[pid] = {"gamma": [pv["physics"]["gamma"], pm.physics.gamma],
                    "tension_offset": [pv["tension_offset"], pm.tension_offset],
                    "hammer_position_ratio": [pv["physics"]["hammer"]["hammer_position"], h.pos_ratio],
                    "hammer_width_m": [pv["physics"]["hammer"]["hammer_width"], h.width]}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset")
    ap.add_argument("label")
    ap.add_argument("out_dir")
    ap.add_argument("--core", default=os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidCore"))
    a = ap.parse_args()
    a.out_dir, a.preset = os.path.abspath(a.out_dir), os.path.abspath(a.preset)   # before chdir
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    from auto_tuner import MeasurementEngine
    with open(a.preset) as f:
        preset = json.load(f)
    p = initialize(os.path.abspath(a.preset), filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=False, sound_derivative_order=1)
    out_dir = os.path.join(a.out_dir, a.label)
    os.makedirs(out_dir, exist_ok=True)
    mvc = float(p.get_current_volume_coefficient())
    me = MeasurementEngine()
    results = {"preset": os.path.abspath(a.preset), "main_volume_coefficient": mvc,
               "readback": readback(p, preset), "notes": []}
    for pitch in NOTES:
        for vel in VELOCITIES:
            snd = render(p, pitch, vel)
            x = snd[0]
            fin = np.isfinite(snd)
            xf = np.where(np.isfinite(x), x, 0.0)
            peak = float(np.max(np.abs(snd[fin]))) if fin.any() else float("nan")
            mp_ = me.measure_frequency(xf[: int(1.0 * SR)], SR, notes_freq(pitch))
            head = xf[: int(0.5 * SR)]
            r = {"pitch": pitch, "velocity": vel, "samples": int(x.size), "channels": int(snd.shape[0]),
                 "nonfinite": int((~fin).sum()), "peak": peak, "rms_0_500ms": float(np.sqrt(np.mean(head ** 2))),
                 "rms_db": float(20 * np.log10(np.sqrt(np.mean(head ** 2)) + 1e-300)),
                 "int32_headroom_db": float(20 * np.log10(2 ** 31 / (peak * mvc))) if peak > 0 else None,
                 "f_expected": notes_freq(pitch), "f_measured": float(mp_.hz), "cents": float(mp_.cents_error),
                 "pitch_confidence": float(mp_.confidence), "decay_db_per_s": decay_db_per_s(xf),
                 "channel_rms": [float(np.sqrt(np.mean(np.where(np.isfinite(c), c, 0)[: int(0.5 * SR)] ** 2)))
                                 for c in snd]}
            results["notes"].append(r)
            write_wav(os.path.join(out_dir, f"p{pitch}_v{vel}_ch0.wav"), xf)
            print(json.dumps({k: r[k] for k in ("pitch", "velocity", "nonfinite", "rms_db", "cents",
                                                  "pitch_confidence", "decay_db_per_s", "int32_headroom_db")}))
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    print("readback", json.dumps(results["readback"]))


if __name__ == "__main__":
    main()
