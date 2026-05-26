"""dev-cfl-3: read string 185's ACTUAL online computed coefficients (via the TEMP getStringDebugCoeffs
buffer) and compare to its 2 unison siblings. Verdict: (a) per-string COEFFICIENT bug vs (b) marginal physics.
Domain expert ruled out (b) (real strings have huge margin), so we expect (a) — find WHICH per-string term
makes 185 differ from siblings (they share pitch.physics).

getStringDebugCoeffs() returns 6 reals/string: [c0,c1,c2,t1,cf_decay,dec_curr], indexed by string-id*6,
written UNCONDITIONALLY by parameterKernel before the gate (so it holds the offending coeffs regardless of eps).

Also BREADTH: how many strings have |g|>1 / NEGATIVE dec_curr online (the user's halt hypothesis: a systematic
per-string coeff error → many spurious rejects → R1 fallbacks → the deeper halt root).

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-debug-coeffs.py
"""
import os, sys, math, time, threading
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa  (release; getStringDebugCoeffs added)

SR, SPC, SITER = 48000, 64, 4
PITCH = 60


def companion_maxg(s0, s1, s2, sb, cfd, K=2001):
    worst, argw = 0.0, 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (2 * ct - 2)
        B0 = sb - cfd * (2 * ct - 2)
        ev = np.linalg.eigvals(np.array([[A, B0], [1.0, 0.0]]))
        m = float(np.max(np.abs(ev)))
        if m > worst:
            worst, argw = m, t
    return worst, argw


def main():
    print("pianoidCuda:", pianoidCuda.__file__)
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    from tests.conftest import get_preset_path  # noqa
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=SITER,
                    array_size=384, sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpc = SR / SPC / 1000.0
    string_ids = list(pw.sm.pitches[PITCH].get_strings())
    idx = {sid: pw.sm.string_index.index(sid) for sid in string_ids}
    print(f"pitch {PITCH} string_ids={string_ids} indices={idx}")

    eq = pianoidCuda.EventQueue()
    e = pianoidCuda.PlaybackEvent(); e.type = pianoidCuda.EventType.NOTE_ON; e.channel = 0
    e.cycle_index = int(100 * cpc); e.data = (PITCH << 8) | 90
    eq.addEvent(e); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cfg.audio_enabled = False; cfg.record_to_buffer = True; cfg.max_duration_ms = 6000; cfg.keep_audio_on_stop = True
    eng = pianoidCuda.OnlinePlaybackEngine(); eng.initialize(cpp, cfg); eng.loadEvents(eq)
    threading.Thread(target=eng.run, daemon=True).start()
    time.sleep(1.6)

    ratios = list(cpp.getStringStabilityRatios())
    flags = list(cpp.getStringStableFlags())
    dbg = list(cpp.getStringDebugCoeffs())  # 6 per string-id

    print("\n=== pitch-60 unison siblings: computed coeffs (by string-id) ===")
    keys = ["c0", "c1", "c2", "t1", "cf_decay", "dec_curr"]
    arr = {}
    for sid in string_ids:
        base = sid * 6
        c0, c1, c2, t1, cf, dec = dbg[base:base + 6]
        arr[sid] = (c0, c1, c2, t1, cf, dec)
        truth, argw = companion_maxg(c0, c1, c2, t1, cf)
        si = idx[sid]
        print(f"  sid={sid} idx={si} kernel_ratio={ratios[si]:.6f} flag={flags[si]}")
        print(f"      c0={c0:.7f} c1={c1:.7f} c2={c2:.4e} t1={t1:.7f} cf_decay={cf:.4e} dec_curr={dec:.6e}"
              f"  ({'NEG dec_curr!' if dec < 0 else 'dec>=0'})")
        print(f"      recomputed true max|g|={truth:.6f} at theta={argw:.4f}")

    print("\n=== sibling DIFF (what's different about the flagged string) ===")
    for j, name in enumerate(keys):
        vals = {sid: arr[sid][j] for sid in string_ids}
        uniq = set(round(v, 9) for v in vals.values())
        tag = "  <-- DIFFERS across siblings" if len(uniq) > 1 else ""
        print(f"  {name}: " + " ".join(f"sid{sid}={vals[sid]:.6e}" for sid in string_ids) + tag)

    ra = np.array(ratios); fl = np.array(flags)
    over = np.nonzero(ra > 1.0 + 1e-9)[0]
    negdec = [sid for sid in range(len(ratios)) if dbg[sid * 6 + 5] < 0]
    print("\n=== BREADTH (online, note sounding) ===")
    print(f"  strings ratio>1: {list(over)} (count {len(over)})")
    print(f"  strings flagged: {[i for i in range(len(fl)) if fl[i]]} (count {int(fl.sum())})")
    print(f"  strings with NEGATIVE dec_curr: {negdec[:40]} (count {len(negdec)})")

    try:
        eng.stop(); time.sleep(0.3); cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
