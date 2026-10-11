"""dev-b59d -- per-channel level / headroom of an FPGA-converted preset (output_role A/B), OFFLINE.

ONE preset per process, never the live backend (in-process engine, audio off, offline renders only):
    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-b59d-output-role-ab.py \
        PRESET.json LABEL OUT_DIR [--core CORE_DIR] [--chord-peak-dbfs -6]

1. load the preset at its declared load params (fpga_conversion.load_params);
2. Layer B chord-headroom calibration (output_headroom.calibrate_chord_headroom: p60 + 16 canonical chords,
   target = chord_peak - worst chord/p60, absolute output_scale) -- the engine's own calibration;
3. per-channel peak dBFS @ slider 64 (bare peak x base volume_center x output_scale / 2^31) of p60 v127 and of
   the worst canonical chord, per-channel p60 RMS and the share of p60 energy above 2 kHz;
4. WAVs at the calibrated absolute level (int16, 4 channels + ch0/ch1 stereo): p60 v127, C_maj_2hand_9 v100,
   the worst chord v127;
5. OUT_DIR/LABEL/results.json incl. the calibrated Layer B fields (to persist into the preset if wanted).
"""
import argparse
import json
import math
import os
import sys
import wave

import numpy as np

SR, SPC = 48000, 64
WAV_SET = (("p60_v127", (60,), 127, 2000, 1500), ("Cmaj_2hand_v100", None, 100, 2500, 1500))
LAYER_B = ("output_scale", "output_scale_calibrated", "output_scale_reference_impulse",
           "output_scale_load_settings", "output_scale_target_dbfs")


def render(p, pitches, vel, dur_ms, tail_ms):
    """Bare (pre-volume) offline render, (channels, samples), at the preset's stored deck feedback."""
    import pianoidCuda
    import output_level
    from PanoidResult import PianoidResult
    eq = pianoidCuda.EventQueue()
    off = int(dur_ms / 1000 * SR / SPC)
    for pitch in pitches:
        for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel), (off, pianoidCuda.EventType.NOTE_OFF, 0)):
            ev = pianoidCuda.PlaybackEvent()
            ev.channel, ev.cycle_index, ev.type, ev.data = 0, cyc, typ, (pitch << 8) | v
            eq.addEvent(ev)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, dur_ms + tail_ms
    assert not output_level.engine_is_live(p), "engine is live - refusing to render"
    cpp = p.pianoid
    with p.cuda_lock, output_level._at_preset_feedback(p):
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


def write_wav(path, x, gain):
    """x (channels, samples) bare -> int16 at the calibrated absolute level (gain = 1/FS of the engine)."""
    y = np.clip(x * gain, -1.0, 1.0)
    pcm = (y.T * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[0])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def db(x):
    return round(20 * math.log10(x), 2) if x > 0 else None


def hf_share(x, f0=2000.0):
    spec = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(x.size, 1 / SR)
    tot = spec.sum()
    return round(float(spec[f >= f0].sum() / tot), 4) if tot > 0 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset")
    ap.add_argument("label")
    ap.add_argument("out_dir")
    ap.add_argument("--core", default=os.path.join(os.path.dirname(__file__), "..", "..", "..", "PianoidCore"))
    ap.add_argument("--chord-peak-dbfs", type=float, default=-6.0)
    a = ap.parse_args()
    a.out_dir, a.preset = os.path.abspath(a.out_dir), os.path.abspath(a.preset)
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    import output_headroom
    import output_level
    with open(a.preset) as f:
        lp = dict(json.load(f).get("fpga_conversion", {}).get("load_params", {}))
    p = initialize(a.preset, filterlen=48 * 128 * 3, string_iteration=lp.get("string_iteration", 4),
                   array_size=lp.get("array_size", 384), sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                   audio_on=False, audio_driver_type=0, listen_to_modes=False,
                   sound_derivative_order=lp.get("sound_derivative_order", 1))
    out_dir = os.path.join(a.out_dir, a.label)
    os.makedirs(out_dir, exist_ok=True)
    stored = {k: getattr(p.mp, k, None) for k in LAYER_B}
    chords = output_headroom.calibrate_chord_headroom(p, a.chord_peak_dbfs)
    assert chords["committed"], chords
    scale = float(p.mp.output_scale)
    base = float(p._volume_center_at_64(p.OUTPUT_SCALE_BASE_PRESET_VOLUME))
    gain = base * scale / output_level.FULL_SCALE                    # bare -> fraction of full scale
    r = {"preset": a.preset, "load_params": lp, "stored_layer_b": stored,
         "calibrated_layer_b": {k: getattr(p.mp, k, None) for k in LAYER_B},
         "worst_chord": chords["worst"], "worst_chord_db_vs_p60": round(chords["worst_db"], 2),
         "chord_db_vs_p60": {k: (round(v["db_vs_p60"], 2) if v["db_vs_p60"] is not None else None)
                             for k, v in chords["chords"].items()},
         "target_dbfs": chords["target_dbfs"]}
    worst = tuple(output_headroom.CANONICAL_CHORDS[chords["worst"]]) if chords["worst"] else (60,)
    p60 = render(p, (60,), 127, output_headroom.RENDER_NOTE_MS, output_headroom.RENDER_TAIL_MS)
    wc = render(p, worst, 127, output_headroom.RENDER_NOTE_MS, output_headroom.RENDER_TAIL_MS)
    r["per_channel"] = {
        "p60_v127_peak_dbfs": [db(np.max(np.abs(c)) * gain) for c in p60],
        "worst_chord_peak_dbfs": [db(np.max(np.abs(c)) * gain) for c in wc],
        "p60_rms_0_500ms_dbfs": [db(float(np.sqrt(np.mean(c[:SR // 2] ** 2))) * gain) for c in p60],
        "p60_energy_share_above_2khz": [hf_share(c[:SR // 2]) for c in p60],
        "nonfinite": int((~np.isfinite(p60)).sum() + (~np.isfinite(wc)).sum())}
    for name, ps, vel, dur, tail in WAV_SET + (("worst_chord_v127", worst, 127, 2000, 1500),):
        x = render(p, ps or output_headroom.CANONICAL_CHORDS["C_maj_2hand_9"], vel, dur, tail)
        write_wav(os.path.join(out_dir, f"{a.label}_{name}_4ch.wav"), x, gain)
        write_wav(os.path.join(out_dir, f"{a.label}_{name}_ch0ch1.wav"), x[:2], gain)
    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(r, f, indent=1)
    print(json.dumps({k: r[k] for k in ("worst_chord", "worst_chord_db_vs_p60", "target_dbfs", "per_channel")},
                     indent=1))


if __name__ == "__main__":
    main()
