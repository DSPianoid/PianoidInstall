"""dev-a709 -- offline engine verification of F15_measured_plywood_2026-10-15 (audio off, in-process, one preset).

    PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-a709-verify-preset-2026-10-15.py \
        PRESET.json OUT_DIR --core CORE_DIR [--chord-peak-dbfs -6]

1. load at the declared load params (array 512, 16 sub-steps, order 1, strings mode, SDL3/no audio);
2. engine readback (getModeDisplacements: SoA [q, q_prev, dec, omega, mass_inv] x num_modes_for_model) vs the
   preset's frequency / decrement / mass for every mode;
3. Layer B chord-headroom calibration (output_headroom, the engine's own) -> target + output_scale to persist;
4. mode probe: per probed mode, strings + modes reset, exciteMode(m, 1e-3), free ring 400 ms, no notes: played
   frequency (Hilbert phase slope) and decay rate (Hilbert log-envelope slope) on the channel with the largest
   weight -> f, zeta vs the preset's measured table; per-channel RMS / |row weight| (one output pitch per
   channel; ch 6 has two strings -> must NOT read 2x);
5. notes p60 / p100 v127: finite, per-channel peak dBFS at the calibrated level; p100 spectrum peaks < 1 kHz vs
   the measured modes (the treble string partials are all above 2.6 kHz).
Writes OUT_DIR/results.json (+ with --write-layer-b the calibrated Layer B fields into PRESET).
"""
import argparse
import json
import math
import os
import sys

import numpy as np

SR, SPC = 48000, 64
PROBE_MS, PROBE_AMP = 400, 1e-3


def _run(cpp, ms, notes=()):
    """Offline playback of `ms`; the offline engine sizes its record from the last event, so a no-note run carries
    a NOTE_OFF (of a key that is not playing) on its last cycle."""
    import pianoidCuda as pc
    q = pc.EventQueue()
    last = int(ms / 1000 * SR / SPC) - 1
    for pitch, vel, on, off in list(notes) or [(21, 0, None, last)]:
        for cyc, typ, v in ((on, pc.EventType.NOTE_ON, vel), (off, pc.EventType.NOTE_OFF, 0)):
            if cyc is None:
                continue
            e = pc.PlaybackEvent()
            e.channel, e.cycle_index, e.type, e.data = 0, cyc, typ, (pitch << 8) | v
            q.addEvent(e)
    q.sortByCycle()
    cfg = pc.PlaybackConfig()
    cfg.audio_enabled, cfg.record_to_buffer = False, True
    cfg.sample_rate, cfg.samples_per_cycle, cfg.max_duration_ms = SR, SPC, ms
    s = cpp.runOfflinePlayback(q, cfg)
    if not s.completed_successfully:
        raise RuntimeError(s.error_message)


def _sound(pw):
    from PanoidResult import PianoidResult
    res = PianoidResult(pw.pianoid, pw.mp)
    res.load_offline_sound_from_pianoid()
    return np.asarray(res.sound, dtype=np.float64)


def render(pw, notes, ms):
    import output_level
    assert not output_level.engine_is_live(pw), "engine is live - refusing to render"
    cpp = pw.pianoid
    with pw.cuda_lock, output_level._at_preset_feedback(pw):
        cpp.waitForParameterUpdate()
        cpp.resetStringsState()
        cpp.resetModeRunningState()
        cpp.runSynthesisKernel()
        cpp.clearRecords()
        _run(cpp, ms, notes)
        return _sound(pw)


def probe(pw, m):
    cpp = pw.pianoid
    with pw.cuda_lock:
        cpp.waitForParameterUpdate()
        cpp.resetStringsState()
        cpp.resetModeRunningState()
        cpp.runSynthesisKernel()            # flush the deferred string reset before exciting (chartFunctions mode test)
        cpp.clearRecords()
        cpp.exciteMode(m, PROBE_AMP, 0.0)
        _run(cpp, PROBE_MS)
        return _sound(pw)


def ring_fit(x, f0=None, skip_ms=30.0, span_db=25.0, win_ms=10.0):
    """Free decay of one damped sinusoid: (f_hz, gamma_per_s). The first `skip_ms` (the output strings' step
    response to the initial displacement) are skipped. f = the zero-padded spectral peak within +-20 % of f0 (f0 =
    the global peak when not given); gamma = the slope of the log RMS in `win_ms` windows over the first `span_db`
    of decay (a band filter biases it: its ringing outlives a fast decay)."""
    y = x[int(skip_ms / 1000 * SR):]
    n = 8 * y.size
    sp = np.abs(np.fft.rfft(y * np.hanning(y.size), n))
    fr = np.fft.rfftfreq(n, 1 / SR)
    band = (fr > 0.8 * f0) & (fr < 1.2 * f0) if f0 else fr > 20
    k = np.flatnonzero(band)[np.argmax(sp[band])]
    f = float(fr[k] + 0.5 * (sp[k - 1] - sp[k + 1]) / (sp[k - 1] - 2 * sp[k] + sp[k + 1]) * (fr[1] - fr[0]))
    w = int(win_ms / 1000 * SR)
    rms = 20 * np.log10(np.sqrt(np.mean(y[:y.size // w * w].reshape(-1, w) ** 2, axis=1)) + 1e-300)
    t = (np.arange(rms.size) + 0.5) * w / SR
    below = np.flatnonzero(rms <= rms[0] - span_db)
    s = np.arange(below[0] + 1 if below.size else rms.size)
    if s.size < 4:
        return f, None
    g = -np.polyfit(t[s], rms[s], 1)[0] * math.log(10) / 20
    return f, float(g)


def readback(pw, preset):
    n = int(pw.mp.num_modes_for_model)
    raw = np.asarray(pw.pianoid.getModeDisplacements(), dtype=np.float64)
    dec, omega, mi = raw[2 * n:3 * n], raw[3 * n:4 * n], raw[4 * n:5 * n]
    f = np.array([m["frequency"] for m in preset["modes"]])
    d = np.array([m["decrement"] for m in preset["modes"]])
    mass = np.array([m["mass"] for m in preset["modes"]])
    k = len(f)
    exp_dec, exp_om = d * f / SR, (2 * math.pi * f / SR) ** 2
    rel = lambda a, b: float(np.max(np.abs(a / b - 1)))
    return {"num_modes_for_model": n, "max_rel_err": {"dec": rel(dec[:k], exp_dec), "omega": rel(omega[:k], exp_om),
                                                     "mass_inv": rel(mi[:k], mass)},
            "spot": [{"mode": int(i), "f_field": float(f[i]), "dec": float(dec[i]), "omega": float(omega[i]),
                      "mass_inv": float(mi[i])} for i in (0, 1, 18, 37, 38, 39, 179, 180, 195)]}


def spectrum_peaks(x, fmax=1000.0, n_peaks=40):
    from scipy.signal import find_peaks
    seg = x[:SR] * np.hanning(SR)
    sp = 20 * np.log10(np.abs(np.fft.rfft(seg, 4 * SR)) + 1e-300)
    fr = np.fft.rfftfreq(4 * SR, 1 / SR)
    s = (fr > 40) & (fr < fmax)
    pk, pr = find_peaks(sp[s], prominence=6)
    order = np.argsort(pr["prominences"])[::-1][:n_peaks]
    return sorted(float(fr[s][pk[i]]) for i in order)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preset")
    ap.add_argument("out_dir")
    ap.add_argument("--core", required=True)
    ap.add_argument("--chord-peak-dbfs", type=float, default=-6.0)
    ap.add_argument("--write-layer-b", action="store_true", help="persist the calibrated Layer B fields into PRESET")
    a = ap.parse_args()
    a.out_dir, a.preset = os.path.abspath(a.out_dir), os.path.abspath(a.preset)
    os.makedirs(a.out_dir, exist_ok=True)
    mw = os.path.abspath(os.path.join(a.core, "pianoid_middleware"))
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    import output_headroom
    import output_level
    from Pianoid.bytestream_encoding import decode_from_json
    preset = json.load(open(a.preset))
    lp = preset["fpga_conversion"]["load_params"]
    pw = initialize(a.preset, filterlen=48 * 128 * 3, string_iteration=lp["string_iteration"],
                    array_size=lp["array_size"], sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, audio_on=False,
                    audio_driver_type=0, listen_to_modes=False, sound_derivative_order=1)
    r = {"preset": a.preset, "load": {"num_modes": pw.mp.num_modes, "num_channels": pw.mp.num_channels,
                                      "num_strings": pw.mp.num_strings, "mode_channel_index": pw.mp.mode_channel_index},
         "readback": readback(pw, preset)}
    chords = output_headroom.calibrate_chord_headroom(pw, a.chord_peak_dbfs)
    r["chord_headroom"] = {"committed": chords["committed"], "worst": chords.get("worst"),
                           "worst_db_vs_p60": chords.get("worst_db"), "target_dbfs": chords.get("target_dbfs"),
                           "layer_b": {k: getattr(pw.mp, k, None) for k in (
                               "output_scale", "output_scale_calibrated", "output_scale_reference_impulse",
                               "output_scale_load_settings", "output_scale_target_dbfs")}}
    if a.write_layer_b and chords["committed"]:
        preset["model_parameters"].update(r["chord_headroom"]["layer_b"])
        with open(a.preset, "w") as f:
            json.dump(preset, f)
    gain = float(pw._volume_center_at_64(pw.OUTPUT_SCALE_BASE_PRESET_VOLUME)) * float(pw.mp.output_scale) / output_level.FULL_SCALE
    table = preset["measured_modes_build"]["measured_table"]["modes"]
    rows = np.stack([decode_from_json(preset["pitches"][str(128 + c)]["deck"])[1] for c in range(pw.mp.num_channels)])
    probes = []
    targets = [(i, m["f_hz"], m["zeta"]) for i, m in enumerate(table)] + [(i, None, None) for i in (38, 39, 40, 180, 181)]
    for i, f_t, z_t in targets:
        x = probe(pw, i)
        c = int(np.argmax(np.abs(rows[:, i])))
        f, g = ring_fit(x[c], f_t)
        rms = np.sqrt(np.mean(x ** 2, axis=1))
        ratio = rms / np.maximum(np.abs(rows[:, i]), 1e-30)
        ok = np.abs(rows[:, i]) > 0.05 * np.abs(rows[:, i]).max()
        p = {"mode": i, "channel": c, "f_meas_hz": f, "gamma_per_s": g, "finite": bool(np.isfinite(x).all()),
             "rms_over_weight_spread_db": float(20 * np.log10(ratio[ok].max() / ratio[ok].min())),
             "ch6_over_median_db": float(20 * np.log10(ratio[6] / np.median(ratio[ok]))) if ok[6] else None}
        if f is not None:
            p["zeta_meas"] = g / (2 * math.pi * f)
        if f_t is not None:
            p.update(f_target_hz=f_t, zeta_target=z_t, f_err_cents=1200 * math.log2(f / f_t) if f else None,
                     zeta_rel_err=(p["zeta_meas"] / z_t - 1) if f else None)
        probes.append(p)
        print(f"probe m{i:3d} ch{c} f {f} target {f_t} zeta {p.get('zeta_meas')} target {z_t} "
              f"spread {p['rms_over_weight_spread_db']:.3f} dB ch6 {p['ch6_over_median_db']}")
    r["probes"] = probes
    notes = {}
    for name, pitch in (("p60_v127", 60), ("p100_v127", 100)):
        x = render(pw, [(pitch, 127, 0, int(1.5 * SR / SPC))], 2500)
        notes[name] = {"finite": bool(np.isfinite(x).all()), "peak_dbfs": [round(20 * math.log10(max(np.abs(c).max() * gain, 1e-30)), 2) for c in x],
                       "clipped_samples": int((np.abs(x * gain) >= 1.0).sum())}
        if pitch == 100:
            pk = spectrum_peaks(x.sum(axis=0))
            fm = np.array([m["f_hz"] for m in table])
            near = [float(1200 * np.min(np.abs(np.log2(fm / q)))) for q in pk]
            notes[name]["peaks_below_1k_hz"] = [round(q, 1) for q in pk]
            notes[name]["peak_to_nearest_measured_cents"] = [round(c, 1) for c in near]
            notes[name]["share_within_25c"] = float(np.mean(np.array(near) < 25))
        np.save(os.path.join(a.out_dir, f"{name}.npy"), x.astype(np.float32))
    r["notes"] = notes
    with open(os.path.join(a.out_dir, "results.json"), "w") as f:
        json.dump(r, f, indent=1)
    meas = [p for p in probes if "f_target_hz" in p and p["f_meas_hz"]]
    print(json.dumps({"readback": r["readback"]["max_rel_err"], "chords": r["chord_headroom"]["target_dbfs"],
                      "f_err_cents_max": max(abs(p["f_err_cents"]) for p in meas),
                      "zeta_rel_err_median": float(np.median([abs(p["zeta_rel_err"]) for p in meas])),
                      "notes": {k: {kk: v[kk] for kk in ("finite", "peak_dbfs", "clipped_samples")} for k, v in notes.items()},
                      "p100_share_within_25c": notes["p100_v127"]["share_within_25c"]}, indent=1))


if __name__ == "__main__":
    main()
