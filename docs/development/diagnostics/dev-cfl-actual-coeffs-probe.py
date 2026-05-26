"""dev-cfl-3: read the KERNEL'S ACTUAL shift_* for string-index 185 ONLINE and recompute true |g|.

String-index 185 reads ratio=1.00042 online (note sounding). Reconstructing from pitch-60 nominal physics
gives |g|=1.0 — so the kernel's ACTUAL coefficients online must differ. getParameters() (available in this
build) returns dev_parameters; layout = blocks of arraySize*POINT_PARAMETERS_NO(=32), row r at
[block*arraySize*32 + r*arraySize + i]. Rows: c0=0,c1=1,c2=2,t1=3,t2=4,hammer_force=5,cf0=6,cf_decay=7,
stringNo=11. We find the point(s) whose stringNo == the CUDA string-id for index 185, read their c0/c1/c2/t1/
cf_decay, and compute true max|g| (companion-matrix, MainKernel recurrence) from those EXACT values. Compare
to the kernel-reported 1.00042. This isolates: wrong COEFFS (something online changes them) vs wrong FORMULA
(cflMaxAmplification mis-derives |g| from correct coeffs).

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-actual-coeffs-probe.py
"""
import os, sys, math, time, threading
import numpy as np

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MIDDLEWARE_DIR = os.path.join(REPO_ROOT, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MIDDLEWARE_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "PianoidCore"))
import pianoidCuda  # noqa

SR, SPC, SITER = 48000, 64, 4
PP = 32  # POINT_PARAMETERS_NO
TARGET_IDX = 185  # the offending string INDEX


def companion_maxg(s0, s1, s2, sb, cfd, K=4001):
    worst = 0.0; argw = 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (2 * ct - 2)
        B0 = sb - cfd * (2 * ct - 2)
        ev = np.linalg.eigvals(np.array([[A, B0], [1.0, 0.0]]))
        m = float(np.max(np.abs(ev)))
        if m > worst:
            worst = m; argw = t
    return worst, argw


def my_formula_maxg(s0, s1, s2, sb, cfd, K=48):
    worst = 0.0
    for k in range(K + 1):
        t = math.pi * k / K
        ct = math.cos(t); c2 = math.cos(2 * t)
        A = s0 + 2 * s1 * ct + 2 * s2 * c2 + cfd * (-2.0) * (1.0 - ct)
        B0 = sb + cfd * 2.0 * (1.0 - ct)
        disc = A * A + 4.0 * B0
        if disc >= 0:
            sq = math.sqrt(disc); mag = max(abs((A + sq) / 2), abs((A - sq) / 2))
        else:
            mag = math.sqrt(abs(B0))
        worst = max(worst, mag)
    return worst


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize
    from tests.conftest import get_preset_path  # noqa
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=SITER,
                    array_size=384, sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpc = SR / SPC / 1000.0
    # the CUDA string-id for string INDEX 185:
    cuda_string_id = pw.sm.string_index[TARGET_IDX]
    print(f"string INDEX {TARGET_IDX} -> CUDA string_id {cuda_string_id}")

    # play pitch 60 (which owns this string) so the online damping state is active
    eq = pianoidCuda.EventQueue()
    e = pianoidCuda.PlaybackEvent(); e.type = pianoidCuda.EventType.NOTE_ON; e.channel = 0; e.cycle_index = int(100*cpc); e.data = (60 << 8) | 90
    eq.addEvent(e); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cfg.audio_enabled = False; cfg.record_to_buffer = True; cfg.max_duration_ms = 6000; cfg.keep_audio_on_stop = True
    eng = pianoidCuda.OnlinePlaybackEngine(); eng.initialize(cpp, cfg); eng.loadEvents(eq)
    threading.Thread(target=eng.run, daemon=True).start()
    time.sleep(1.6)

    # kernel-reported ratio for this index
    kr = list(cpp.getStringStabilityRatios())[TARGET_IDX]
    kf = list(cpp.getStringStableFlags())[TARGET_IDX]
    print(f"kernel-reported: ratio={kr:.6f} flag={kf}")

    # read dev_parameters and locate points with stringNo == cuda_string_id
    params = np.asarray(cpp.getParameters(), dtype=np.float64)
    cyc = pw.mp
    arraySize = 384
    nblocks = params.size // (arraySize * PP)
    print(f"params size={params.size} arraySize={arraySize} nblocks={nblocks}")
    found = []
    for b in range(nblocks):
        base = b * arraySize * PP
        sN = params[base + 11 * arraySize: base + 12 * arraySize]
        pts = np.nonzero(np.round(sN).astype(int) == cuda_string_id)[0]
        for i in pts:
            c0 = params[base + 0 * arraySize + i]; c1 = params[base + 1 * arraySize + i]
            c2 = params[base + 2 * arraySize + i]; t1 = params[base + 3 * arraySize + i]
            cf = params[base + 7 * arraySize + i]
            found.append((b, int(i), c0, c1, c2, t1, cf))
    print(f"points for string_id {cuda_string_id}: {len(found)}")
    seen = set()
    for (b, i, c0, c1, c2, t1, cf) in found[:6]:
        key = (round(c0, 7), round(c1, 7), round(c2, 7), round(t1, 7), round(cf, 7))
        if key in seen:
            continue
        seen.add(key)
        truth, argw = companion_maxg(c0, c1, c2, t1, cf)
        mine = my_formula_maxg(c0, c1, c2, t1, cf, 48)
        print(f"  blk{b} pt{i}: c0={c0:.6f} c1={c1:.6f} c2={c2:.6e} t1={t1:.6f} cf={cf:.6e}")
        print(f"      -> TRUE max|g|(companion,8001-ish)={truth:.6f} at theta={argw:.4f} | my K48={mine:.6f} | kernel={kr:.6f}")
    try:
        eng.stop(); time.sleep(0.3); cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
