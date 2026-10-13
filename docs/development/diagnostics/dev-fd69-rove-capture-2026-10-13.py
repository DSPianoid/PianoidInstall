"""Roving-piezo capture, one placement per call (2026-10-13).

Exciters stay fixed (Out 1-4, coil currents on In 1-4); the 3 piezos (In 5-7) move between placements.
Per placement: 3 x ESS 20 s 20-2000 Hz per exciter (Out 2 -36 dBFS, Out 1/3/4 -30 dBFS), In 1-7
captured, no loopback (current-referenced FRFs cancel interface latency). Stores
    <root>/placement_NN/sessions/<tag>/{data.npy, signal.npy, meta.json}
    <root>/placement_NN/frf.npz      f (<= 1200 Hz), Hv (3 repeats, F, 7 rows, 4 exciters) voltage-ref;
                                     rows = In 5, In 6, In 7, In 1, In 2, In 3, In 4
    <root>/placement_NN/placement.json   time, coords, levels, sessions, QC
QC: per-channel repeat SNR (<200 Hz, 200 Hz-1 kHz), peak / clipping, silence floor + 50 Hz hum,
coil channels (own admittance + cross-coil) vs placement 0 (must match within ~0.5 dB / 3 deg).

Usage:
  python rove_capture.py --placement 3 [--coords "x1,y1;x2,y2;x3,y3"] [--note "..."]
  python rove_capture.py --placement 0 --from-existing 20261013T135846-frf4ref   (define baseline)
  python rove_capture.py --placement 3 --set-coords "x1,y1;x2,y2;x3,y3"            (coords only)
  python rove_capture.py --rig-coords "x1,y1;x2,y2;x3,y3;x4,y4"                    (exciter positions)
  python rove_capture.py --dry-run                                                  (devices + 2 s floor)
"""
import argparse, json, os, sys, time
import numpy as np

sys.path.insert(0, r"D:\repos\wt-fd69-core")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "rove-20261013")
LV = {"Out 1": -30.0, "Out 2": -36.0, "Out 3": -30.0, "Out 4": -30.0}
OUTS = list(LV)
INS = [f"In {i}" for i in range(1, 8)]
ROWS = ["In 5", "In 6", "In 7", "In 1", "In 2", "In 3", "In 4"]
F1, F2, T, POST = 20.0, 2000.0, 20.0, 3.0
FS = 48000; OFF = 30; NIR = 4 * FS; FMAX = 1200.0
CLIP_DBFS = -1.0
COIL_TOL_DB, COIL_TOL_DEG = 0.5, 3.0


def parse_coords(s, n):
    if not s:
        return None
    pts = [[float(v) for v in p.split(",")] for p in s.split(";") if p.strip()]
    if len(pts) != n or any(len(p) != 2 for p in pts):
        raise SystemExit(f"--coords needs {n} 'x,y' pairs separated by ';'")
    return pts


def pdir(n):
    return os.path.join(ROOT, f"placement_{n:02d}")


def frf_from_sessions(sess_dir, levels):
    from pianoid_middleware.modal_adapter.measurement.ess import deconvolve, exp_sweep
    win = np.ones(NIR); nf = int(0.1 * NIR); win[-nf:] = 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, nf))
    f = np.fft.rfftfreq(NIR, 1 / FS); keep = f <= FMAX
    Hv = np.zeros((3, int(keep.sum()), 7, 4), complex)
    peaks = {}
    rix = [INS.index(r) for r in ROWS]
    for e, o in enumerate(OUTS):
        x = exp_sweep(F1, F2, T, FS, levels[o])
        for r in range(3):
            y = np.load(os.path.join(sess_dir, f"{o.replace(' ', '')}_r{r + 1}", "data.npy")).astype(float)
            peaks[f"{o}_r{r + 1}"] = np.round(20 * np.log10(np.abs(y).max(axis=0) + 1e-12), 1).tolist()
            h = np.roll(deconvolve(y, x, FS, (F1, F2)), -OFF, axis=0)[:NIR] * win[:, None]
            Hv[r, :, :, e] = np.fft.rfft(h, axis=0)[keep][:, rix]
    return f[keep], Hv, peaks


def band_med(f, v, lo, hi):
    s = (f >= lo) & (f < hi)
    for hz in (50, 100, 150):
        s &= np.abs(f - hz) > 1.0
    return float(np.median(v[s]))


def qc(f, Hv, peaks, silence, base):
    out = {"repeat_snr_db": {}, "peaks_dbfs_max": {}, "clipping": [], "coil_vs_placement0": {}}
    m = Hv.mean(0); var = Hv.var(0) / 3
    snr = 10 * np.log10(np.abs(m) ** 2 / np.maximum(var, 1e-300))
    for e, o in enumerate(OUTS):
        out["repeat_snr_db"][o] = {ROWS[k]: [round(band_med(f, snr[:, k, e], 25, 200), 1),
                                             round(band_med(f, snr[:, k, e], 200, 1000), 1)] for k in range(7)}
    pk = np.max(np.array(list(peaks.values())), axis=0)
    out["peaks_dbfs_max"] = {INS[j]: float(pk[j]) for j in range(7)}
    out["clipping"] = [INS[j] for j in range(7) if pk[j] > CLIP_DBFS]
    if silence is not None:
        from scipy.signal import welch
        fw, P = welch(silence, FS, nperseg=16384, axis=0)
        out["silence_rms_dbfs"] = {INS[j]: round(float(10 * np.log10(np.mean(silence[:, j] ** 2) + 1e-30)), 1) for j in range(7)}
        i50 = np.argmin(np.abs(fw - 50)); bg = np.median(P[(fw > 30) & (fw < 70)], axis=0)
        out["hum50_db_over_floor"] = {INS[j]: round(float(10 * np.log10(P[i50 - 1:i50 + 2, j].max() / bg[j])), 1) for j in range(7)}
    ok = True
    if base is not None:
        fb, Hb = base
        if len(fb) != len(f) or not np.allclose(fb, f):
            raise RuntimeError("frequency grids differ from placement 0")
        mb = Hb.mean(0)
        for e, o in enumerate(OUTS):
            row = {}
            for k in range(3, 7):
                r = m[:, k, e] / mb[:, k, e]
                s = (f >= 40) & (f <= 1000)
                for hz in (50, 100, 150):
                    s &= np.abs(f - hz) > 1.0
                if k == 3 + e:      # own admittance: high SNR -> strict
                    w = s
                else:               # cross coil: only lines with repeat SNR > 20 dB in both
                    w = s & (snr[:, k, e] > 20)
                if w.sum() < 50:
                    row[ROWS[k]] = None
                    continue
                db = float(np.median(20 * np.log10(np.abs(r[w])))); deg = float(np.median(np.degrees(np.angle(r[w]))))
                tol_db = COIL_TOL_DB if k == 3 + e else 2 * COIL_TOL_DB
                tol_deg = COIL_TOL_DEG if k == 3 + e else 2 * COIL_TOL_DEG
                passed = abs(db) <= tol_db and abs(deg) <= tol_deg
                ok &= passed
                row[ROWS[k]] = {"db": round(db, 2), "deg": round(deg, 1), "own": k == 3 + e, "pass": bool(passed), "lines": int(w.sum())}
            out["coil_vs_placement0"][o] = row
    piezo_snr_ok = all(min(out["repeat_snr_db"][o][r][0] for o in OUTS) >= 20 for r in ROWS[:3])
    out["pass"] = bool(ok and not out["clipping"] and piezo_snr_ok)
    out["piezo_snr_ok"] = bool(piezo_snr_ok)
    return out


def summary_line(n, q, coords):
    sn = {r: min(q["repeat_snr_db"][o][r][0] for o in OUTS) for r in ROWS[:3]}
    coil = []
    for o, row in q.get("coil_vs_placement0", {}).items():
        for r, v in row.items():
            if v and v["own"]:
                coil.append(f"{o}:{v['db']:+.2f}dB/{v['deg']:+.1f}deg")
    worst_x = max([abs(v["db"]) for row in q.get("coil_vs_placement0", {}).values() for v in row.values() if v and not v["own"]] or [0])
    return (f"placement {n:02d}: QC {'PASS' if q['pass'] else 'FAIL'} | piezo min repeat-SNR<200Hz "
            + ", ".join(f"{r} {v:.0f}dB" for r, v in sn.items())
            + f" | peaks max {max(q['peaks_dbfs_max'].values()):.1f} dBFS, clipping {q['clipping'] or 'none'}"
            + (f" | own coil vs P0 {'; '.join(coil)}; worst cross-coil {worst_x:.2f} dB" if coil else "")
            + f" | coords {'given' if coords else 'none'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--placement", type=int)
    ap.add_argument("--coords"); ap.add_argument("--set-coords"); ap.add_argument("--rig-coords")
    ap.add_argument("--note", default="")
    ap.add_argument("--from-existing"); ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--root"); ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    global ROOT
    if a.root:
        ROOT = a.root
    os.makedirs(ROOT, exist_ok=True)
    if a.rig_coords:
        json.dump({"exciter_coords": parse_coords(a.rig_coords, 4), "exciters": OUTS},
                  open(os.path.join(ROOT, "rig.json"), "w"), indent=1)
        print("exciter coords stored"); return
    if a.dry_run:
        from pianoid_middleware.modal_adapter.measurement.audio_io import RemoteAudioIO
        io = RemoteAudioIO(); d = io.devices()
        cap = io.record(INS, 2.0, tag="rove-dryrun")
        rms = 20 * np.log10(np.sqrt(np.mean(cap.data.astype(float) ** 2, axis=0)) + 1e-12)
        print("ASIO", d.get("driver"), d.get("sample_rate"), "open", d.get("open"), "| floor dBFS",
              {k: round(float(v), 1) for k, v in zip(INS, rms)}); return
    if a.placement is None:
        raise SystemExit("--placement N required")
    D = pdir(a.placement); mp = os.path.join(D, "placement.json")
    if a.set_coords:
        meta = json.load(open(mp)); meta["coords"] = parse_coords(a.set_coords, 3)
        json.dump(meta, open(mp, "w"), indent=1); print("coords stored for placement", a.placement); return
    if os.path.exists(mp) and not a.force:
        raise SystemExit(f"{mp} exists (use --force to redo into a NEW placement number instead)")
    os.makedirs(D, exist_ok=True)
    coords = parse_coords(a.coords, 3)
    t0 = time.time()
    silence = None
    if a.from_existing:
        src = a.from_existing if os.path.isabs(a.from_existing) else os.path.join(HERE, a.from_existing)
        sess = os.path.join(src, "sessions"); levels = json.load(open(os.path.join(src, "config.json")))["levels"]
        sessions = json.load(open(os.path.join(src, "sessions.json"))) if os.path.exists(os.path.join(src, "sessions.json")) else []
        sp = os.path.join(sess, "silence", "data.npy")
        silence = np.load(sp).astype(float) if os.path.exists(sp) else None
        source = src
    else:
        from pianoid_middleware.modal_adapter.swept_discovery.audio_io import SessionAudioIO
        from pianoid_middleware.modal_adapter.measurement.ess import exp_sweep
        sess = os.path.join(D, "sessions"); levels = LV
        io = SessionAudioIO(sess, loopback=None)
        y, _ = io.record(3.0, INS, "silence"); silence = y
        for rep in range(1, 4):
            for o, lv in LV.items():
                y, m = io.play_record(exp_sweep(F1, F2, T, FS, lv), o, INS, 0.0, POST, f"{o.replace(' ', '')}_r{rep}")
                if m.get("status") != "ok" or m.get("xruns"):
                    print("WARNING session", m.get("tag"), m.get("status"), "xruns", m.get("xruns"), flush=True)
            print(f"  repeat {rep}/3 done ({time.time() - t0:.0f} s)", flush=True)
        sessions = io.sessions; source = "live"
    f, Hv, peaks = frf_from_sessions(sess, levels)
    np.savez(os.path.join(D, "frf.npz"), f=f, Hv=Hv, rows=np.array(ROWS), outs=np.array(OUTS))
    base = None
    b0 = os.path.join(pdir(0), "frf.npz")
    if a.placement != 0 and os.path.exists(b0):
        z = np.load(b0); base = (z["f"], z["Hv"])
    q = qc(f, Hv, peaks, silence, base)
    meta = {"placement": a.placement, "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "coords": coords, "note": a.note,
            "source": source, "levels": levels, "inputs": INS, "rows": ROWS, "ess": [F1, F2, T],
            "sessions": sessions, "elapsed_s": round(time.time() - t0, 1), "qc": q}
    json.dump(meta, open(mp, "w"), indent=1, default=str)
    print(summary_line(a.placement, q, coords))


if __name__ == "__main__":
    main()
