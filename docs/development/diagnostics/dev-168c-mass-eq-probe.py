"""dev-168c (2026-10-04) -- keyboard equalizer on hammer_mass: OFFLINE verification probe.

Own process, audio off, no ASIO, no realtime thread; never touches the running backend.
One preset + one load config per process (never two Pianoid instances in one process).
Run from the PianoidCore checkout/worktree whose middleware should be tested:

    PianoidCore/.venv/Scripts/python dev-168c-mass-eq-probe.py MIDDLEWARE_DIR PRESET.json \
        ARRAY_SIZE STRING_ITERATION DERIV LISTEN_TO_MODES MODE OUT.json [EXTRA]

MODE
  linearity  hammer_mass x{0.25,0.5,2,4} on 3 pitches -> measured dB vs 20*log10(ratio)
  equalize   sweep (before) -> CalibrationController.calibrate_synthesis (the production
             /calibrate_synthesis code path, now writing hammer_mass) -> sweep (after)
             -> save the preset to EXTRA (a scratch path)
  reload     load EXTRA (the saved preset) fresh -> sweep; then a SHAPE edit (sigma x1.3 on every
             Gaussian of the base levels, through ParameterManager.update_parameter('gauss'))
             and a pure VOLUME edit (all curve volumes x2) on a few pitches -> masses, delivered
             impulse and loudness before/after each edit

Metrics per pitch (velocity VEL=95, a base level):
  m_all   RMS over ALL output channels, 30..300 ms of the 700 ms note render (= the dev-168c
          SynthesisTuner metric, measured by the probe itself so OLD and NEW code share one metric)
  m_ch    hottest single output channel RMS, same window
Both are pre-volume soundFloat (output_scale not applied), so they compare across processes.
"""
import json
import math
import os
import sys

import numpy as np

SR, SPC, VEL = 48000, 64, 95


def db(x):
    return round(20 * math.log10(x), 3) if x > 0 else None


def render_channels(p, pitch, vel, hold_ms=300, total_ms=1000):
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


def measure(p, cc, pitch):
    """Same render as SynthesisTuner._synthesis_only_measure (note-on 0, note-off 300 ms, 700 ms),
    measured here so OLD and NEW middleware are compared with one metric:
      m_all  RMS over ALL output channels, 30..300 ms (the dev-168c production metric)
      m_ch   hottest single channel RMS, same window"""
    snd = render_channels(p, pitch, VEL, hold_ms=300, total_ms=700)
    seg = np.where(np.isfinite(snd), snd, 0.0)[:, int(0.030 * SR):int(0.300 * SR)]
    return {"m_all": db(float(np.sqrt(np.mean(seg ** 2)))),
            "m_ch": db(float(np.sqrt(np.mean(seg ** 2, axis=1)).max()))}


def sweep(p, cc, pitches):
    return {str(k): measure(p, cc, k) for k in pitches}


def spread(sw, key):
    v = np.array([r[key] for r in sw.values() if r[key] is not None])
    silent = [k for k, r in sw.items() if r[key] is None]
    return {"max_minus_min_db": round(float(v.max() - v.min()), 2),
            "p95_minus_p5_db": round(float(np.percentile(v, 95) - np.percentile(v, 5)), 2),
            "std_db": round(float(v.std()), 2), "median_db": round(float(np.median(v)), 2),
            "n": int(v.size), "silent_pitches": silent}


def delivered_impulse(p, pitch, level=VEL):
    """coefficient (live engine table) x temporal x spatial = c*m*v (conserve)."""
    cache = p.param_manager._coeff_cache
    coeff = float(cache.full_by_pitch[pitch][level])
    pf = cache.factors['pitch'][pitch]
    return coeff * p.sm.pitches[pitch].excitation.level_impulse(level) * pf['spatial']


def mode_linearity(p, cc, out):
    from hammer_mass_gain import HammerMassGain
    keys = sorted(p.sm.keyPitches)
    probe = [keys[len(keys) // 6], 60 if 60 in keys else keys[len(keys) // 2], keys[-len(keys) // 6]]
    mg = HammerMassGain(p)
    res = {}
    for k in probe:
        base = measure(p, cc, k)
        rows = []
        for f in (0.25, 0.5, 2.0, 4.0):
            mg.set_gain(k, f); mg.commit()
            m = measure(p, cc, k)
            rows.append({"mass_ratio": f, "expected_db": round(20 * math.log10(f), 3),
                         "d_m_all_db": round(m["m_all"] - base["m_all"], 3),
                         "d_m_ch_db": round(m["m_ch"] - base["m_ch"], 3)})
        mg.set_gain(k, 1.0); mg.commit()
        res[str(k)] = {"base": base, "rows": rows}
    out["linearity"] = res


def mode_equalize(p, cc, out, save_path):
    keys = sorted(p.sm.keyPitches)
    masses_before = {str(k): float(p.sm.pitches[k].physics.hammer_mass) for k in keys}
    before = sweep(p, cc, keys)
    target = 10 ** (np.median([r["m_all"] for r in before.values() if r["m_all"] is not None]) / 20)
    p._calibration_active = True     # engine not running in this offline process
    res = cc.calibrate_synthesis(keys, VEL, target_rms=float(target))
    after = sweep(p, cc, keys)
    p.save_preset(save_path)
    out.update({
        "target_rms_db": db(target), "clipping_adjusted": res.get("clipping_adjusted"),
        "converged": res["summary"]["converged"], "total": res["summary"]["total"],
        "before": before, "after": after,
        "spread_before": {k: spread(before, k) for k in ("m_all", "m_ch")},
        "spread_after": {k: spread(after, k) for k in ("m_all", "m_ch")},
        "masses_before": masses_before,
        "masses_after": {str(k): float(p.sm.pitches[k].physics.hammer_mass) for k in keys},
        "saved_preset": save_path})


def mode_reload(p, cc, out):
    keys = sorted(p.sm.keyPitches)
    out["masses_loaded"] = {str(k): float(p.sm.pitches[k].physics.hammer_mass) for k in keys}
    out["after_reload"] = sweep(p, cc, keys)
    out["spread_after_reload"] = {k: spread(out["after_reload"], k) for k in ("m_all", "m_ch")}
    edit = [keys[len(keys) // 4], keys[len(keys) // 2], keys[3 * len(keys) // 4]]
    base_levels = [5, 31, 63, 95, 127]
    pm = p.param_manager
    shape, volume = {}, {}
    for k in edit:
        exc = p.sm.pitches[k].excitation
        m0, i0, l0 = p.sm.pitches[k].physics.hammer_mass, delivered_impulse(p, k), measure(p, cc, k)
        vals = {str(k): {lv: {c: {"sigma": float(exc.levels_matrix[lv, 1, c]) * 1.3} for c in range(5)}
                         for lv in base_levels}}
        pm.update_parameter('gauss', vals, pitches=[k])
        m1, i1, l1 = p.sm.pitches[k].physics.hammer_mass, delivered_impulse(p, k), measure(p, cc, k)
        shape[str(k)] = {"mass_before": m0, "mass_after": m1,
                         "impulse_change_db": round(20 * math.log10(i1 / i0), 4),
                         "d_m_all_db": round(l1["m_all"] - l0["m_all"], 3),
                         "d_m_ch_db": round(l1["m_ch"] - l0["m_ch"], 3)}
        vals = {str(k): {lv: {c: {"volume": float(exc.levels_matrix[lv, 2, c]) * 2.0} for c in range(5)}
                         for lv in base_levels}}
        pm.update_parameter('gauss', vals, pitches=[k])
        m2, i2, l2 = p.sm.pitches[k].physics.hammer_mass, delivered_impulse(p, k), measure(p, cc, k)
        volume[str(k)] = {"mass_unchanged": m2 == m1,
                          "impulse_change_db": round(20 * math.log10(i2 / i1), 4),
                          "d_m_all_db": round(l2["m_all"] - l1["m_all"], 3),
                          "d_m_ch_db": round(l2["m_ch"] - l1["m_ch"], 3)}
    out["shape_edit_sigma_x1.3"] = shape
    out["volume_edit_x2"] = volume


def main():
    mw, preset, array_size, si, deriv, ltm, mode, out_path = sys.argv[1:9]
    extra = sys.argv[9] if len(sys.argv) > 9 else None
    preset = os.path.abspath(preset)
    sys.path.insert(0, os.path.abspath(mw))
    os.chdir(os.path.abspath(mw))
    from pianoid import initialize
    from calibration_controller import CalibrationController
    p = initialize(preset, filterlen=48 * 128 * 3, string_iteration=int(si), array_size=int(array_size),
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, audio_on=False, audio_driver_type=0,
                   listen_to_modes=bool(int(ltm)), sound_derivative_order=int(deriv), use_debug_build=False)
    cc = CalibrationController(p)
    # Offline post-load warm-up: the first renders after initialize() measure differently
    # (dev-168c finding, up to ~1 dB); one throw-away sweep reaches the steady state.
    for k in sorted(p.sm.keyPitches):
        measure(p, cc, k)
    out = {"preset": os.path.basename(preset), "array_size": int(array_size), "string_iteration": int(si),
           "deriv": int(deriv), "listen_to_modes": int(ltm), "mode": mode, "velocity": VEL,
           "middleware": os.path.abspath(mw)}
    {"linearity": lambda: mode_linearity(p, cc, out),
     "equalize": lambda: mode_equalize(p, cc, out, os.path.abspath(extra)),
     "reload": lambda: mode_reload(p, cc, out)}[mode]()
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)
    print("RESULT written", out_path)


if __name__ == "__main__":
    main()
