"""dev-bow3: where does the bowed bass scratch come from? SILENT: offline render, audio off, in-process.

Uses the INSTALLED engine (no build). For each case: noise between partials, centroid, roll-off and
level (dev-bow2-harshness.py metrics). With --debug (the debug build) also every unison string's slip
flag: stick fraction and main slips per period PER STRING of the key.

Cases: the bowed key as is; deck feedback coefficient 0 (soundboard modes do not feed back into the
strings; isolates suspect 2).

Usage: python dev-bow3-bass-diag.py --core D:/repos/wt-bow3-core [--pitches 36,45,48,60] [--debug]
"""
import argparse
import importlib.util
import json
import os
import sys

import numpy as np

SR = 48000
SPC = 64


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--pitches", default="36,45,48,60")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("h", os.path.join(here, "dev-bow2-harshness.py"))
    h = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(h)
    spec = importlib.util.spec_from_file_location("w", os.path.join(here, "dev-bow2-wavs.py"))
    w = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(w)
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
                   use_debug_build=args.debug)
    import pianoidCuda as pc   # AFTER initialize: an earlier import pins the release variant
    eng = p.pianoid
    ns = eng.getNumStrings()
    fb_default = p.get_deck_feedback_coefficient()
    try:
        for P in [int(x) for x in args.pitches.split(",")]:
            f0 = 440.0 * 2 ** ((P - 69) / 12) * 2 ** (-16 / 1200)
            hm = w.render(p, pc, P, 80)
            ref = float(np.sqrt(np.mean(hm[int(0.02 * SR):int(0.22 * SR)] ** 2)))
            strings = list(eng.getStringIndicesForPitch(P))
            for fb in (None, 0.0):
                if fb is not None:
                    p.set_deck_feedback_coefficient(fb)
                p.set_pitch_excitation_mode(P, 1)
                eng.clearRecords()
                x = w.render(p, pc, P, 90)
                p.set_pitch_excitation_mode(P, 0)
                m = h.metrics(x, f0, ref)
                row = {"pitch": P, "strings": strings, "deck_feedback": "default" if fb is None else fb, **m}
                if args.debug:   # a short run of its own: the record buffer holds 500 cycles from the note-on
                    p.set_pitch_excitation_mode(P, 1)
                    eng.resetStringsState()
                    eng.clearRecords()
                    q = pc.EventQueue()
                    e = pc.PlaybackEvent()
                    e.type, e.channel, e.cycle_index, e.data = pc.EventType.NOTE_ON, 0, 2, (P << 8) | 90
                    q.addEvent(e)
                    cfg = pc.PlaybackConfig()
                    cfg.audio_enabled, cfg.record_to_buffer, cfg.max_duration_ms = False, False, 1200
                    cfg.sample_rate, cfg.samples_per_cycle = SR, SPC
                    assert eng.runOfflinePlayback(q, cfg).completed_successfully
                    p.set_pitch_excitation_mode(P, 0)
                    rec = np.array(eng.getSoundRecords(100000)).reshape(-1, 4, ns, SPC)
                    per_string = {}
                    for s in strings:
                        flag = rec[:, 2, s, :].reshape(-1)[int(0.2 * SR):]
                        stick = flag < 0.5
                        segs = np.split(stick.astype(int), np.flatnonzero(np.diff(stick.astype(int))) + 1)
                        periods = len(flag) / SR * f0
                        per_string[s] = {"stick": round(float(stick.mean()), 3),
                                         "main_slips": round(sum(1 for g in segs if g[0] == 0 and len(g) >= 2) / periods, 2)}
                    row["per_string"] = per_string
                print(json.dumps(row), flush=True)
            p.set_deck_feedback_coefficient(fb_default)
    finally:
        eng.shutdownGpu()


if __name__ == "__main__":
    main()
