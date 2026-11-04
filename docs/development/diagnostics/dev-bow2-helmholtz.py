"""dev-bow2: bow-point stick / slip check on the DEBUG build (SOUND_REC_APPLIED_FORCE carries the bow's
slip flag, one value per sample = the state after the sample's last sub-step).

Renders a bowed note offline, reads the debug sound records, and reports for one string of the pitch:
stick fraction and slips per period over the steady part. Helmholtz motion: one slip per period,
stick fraction ~ 1 - beta (beta = bow position / string length, ~0.15 at the hammer point).

Usage: python dev-bow2-helmholtz.py --core D:/repos/wt-bow-core [--pitch 48] [--force 0.5] [--angle 0.3]
"""
import argparse
import os
import sys

import numpy as np

SR = 48000
SPC = 64


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", required=True)
    ap.add_argument("--pitch", type=int, default=48)
    ap.add_argument("--vel", type=int, default=90)
    ap.add_argument("--forces", default="0.15,0.5,0.95")
    ap.add_argument("--angles", default="0.3")
    args = ap.parse_args()
    mw = os.path.join(args.core, "pianoid_middleware")
    sys.path.insert(0, mw)
    os.chdir(mw)
    from pianoid import initialize
    p = initialize(os.path.join(mw, "presets", "BaselinePreset1.json"), filterlen=48 * 128 * 3,
                   string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
                   use_debug_build=True)
    import pianoidCuda as pc
    eng = p.pianoid
    ns = eng.getNumStrings()
    strings = list(eng.getStringIndicesForPitch(args.pitch))
    s0 = strings[0]
    p.set_pitch_excitation_mode(args.pitch, 1)
    f_nom = 440.0 * 2 ** ((args.pitch - 69) / 12)
    try:
        for angle in [float(a) for a in args.angles.split(",")]:
            for force in [float(f) for f in args.forces.split(",")]:
                eng.setBowForce(force)
                eng.setBowSoftness(angle)
                eng.resetStringsState()
                eng.clearRecords()
                q = pc.EventQueue()
                ev = pc.PlaybackEvent()
                ev.type = pc.EventType.NOTE_ON
                ev.channel = 0
                ev.cycle_index = 2
                ev.data = (args.pitch << 8) | args.vel
                q.addEvent(ev)
                cfg = pc.PlaybackConfig()
                cfg.audio_enabled = False
                cfg.record_to_buffer = False
                cfg.max_duration_ms = 1200
                cfg.sample_rate = SR
                cfg.samples_per_cycle = SPC
                stats = eng.runOfflinePlayback(q, cfg)
                assert stats.completed_successfully, stats.error_message
                rec = np.array(eng.getSoundRecords(100000)).reshape(-1, 4, ns, SPC)
                flag = rec[:, 2, s0, :].reshape(-1)[int(0.2 * SR):]   # steady part (attack glide 5 ms)
                stick = flag < 0.5
                slips = np.sum(np.diff(stick.astype(int)) == -1)
                periods = len(flag) / SR * f_nom
                runs = np.diff(np.flatnonzero(np.diff(stick.astype(int)) != 0))
                print(f"pitch {args.pitch} string {s0} force {force:.2f} angle {angle:.2f}: samples={len(flag)} "
                      f"stick_frac={stick.mean():.3f} slips/period={slips / periods:.2f} "
                      f"median_run={int(np.median(runs)) if len(runs) else 0} period_samples={SR / f_nom:.0f} "
                      f"nan={int(np.isnan(flag).sum())}", flush=True)
    finally:
        p.set_pitch_excitation_mode(args.pitch, 0)
        eng.shutdownGpu()


if __name__ == "__main__":
    main()
