"""
Sound characteristics of one note (dev-tuneskill): signal -> numbers, CPU only (numpy / scipy), no engine.

The algorithms are ports of analysis code already used in the project, gathered here so the sample library,
the assistant and the dev agents measure the same things the same way:
  - partial tracking with inharmonic stretch, band-time matrix, cloud (noise between partials), envelope
    tables: the assistant's fit library (artefact fit_lib17, the Belarus fit of 30 Oct - 1 Nov 2026);
  - harmonic-comb f0 with the inharmonicity stretch f_n = n f0 sqrt(1 + B n^2):
    pianoid_middleware/auto_tuner.py measure_frequency (R2 / R4);
  - spectral centroid, decay time, attack time: PianoidCore tests/integration/param_sound_harness.py.
None of those modules can be imported without the engine or pytest, which is why the code lives here.

Every value is relative (dB re the sample's own level or the strongest partial): assistant WAVs are
peak-normalised, so absolute loudness is never read from a file (see TUNING_FOR_ASSISTANT.md #measure).
"""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, sosfiltfilt

VERSION = 1

PARTIALS = 12
DECAY_BANDS = ((100, 250), (250, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000))
# the fit library's band-time matrix: windows x bands, dB (fit_lib17 WN / BE)
BT_WINDOWS = ((0.0, 0.06, "attack"), (0.1, 0.8, "body"), (1.0, 3.0, "mid"), (4.0, 8.0, "tail"))
BT_EDGES = (100, 250, 500, 1000, 2000, 4000, 8000)
# the fit library's cloud: windows x bands, energy in bins at least 0.08 f0 away from every partial (fit_lib17 CW / CB)
CLOUD_WINDOWS = ((0.0, 0.1), (0.1, 0.25), (0.25, 0.5), (0.5, 1.0))
CLOUD_BANDS = ((1000, 2000), (2000, 4000), (4000, 8000), (8000, 14000))
THUMP_BAND = (50, 200)        # dev-thump1 metric band
EPS = 1e-30


def db(x):
    return 10.0 * np.log10(np.maximum(np.asarray(x, dtype=float), EPS))


def onset_index(x, sr):
    """First sample above 10 % of the peak, minus 1 ms (fit_lib17 onset)."""
    e = np.abs(x)
    if e.max() <= 0:
        return 0
    return max(0, int(np.argmax(e > 0.1 * e.max())) - int(0.001 * sr))


def bandpass(x, sr, lo, hi, order=4):
    nyq = sr / 2.0
    hi = min(hi, 0.95 * nyq)
    if lo >= hi:
        return np.zeros_like(x)
    sos = butter(order, [lo / nyq, hi / nyq], "band", output="sos")
    return sosfiltfilt(sos, x)


def rms_envelope(x, sr, frame_s=0.01):
    """RMS over a sliding window, same length as x."""
    w = max(1, int(frame_s * sr))
    return np.sqrt(np.convolve(x * x, np.ones(w) / w, "same") + EPS)


def spectrum(x, sr, t0, t1, pad=1):
    """One-sided power spectrum of x[t0:t1] (Hann), zero-padded `pad` times; (f, P)."""
    seg = x[int(t0 * sr):int(t1 * sr)]
    n = len(seg)
    if n < 64:
        return np.array([0.0]), np.array([EPS])
    X = np.fft.rfft(seg * np.hanning(n), pad * n)
    return np.fft.rfftfreq(pad * n, 1.0 / sr), np.abs(X) ** 2 / n


# ---- pitch, partials, inharmonicity ----------------------------------------------------------

def _comb_score(f, P, f0, n_harm=8):
    """Sum of the local spectral maxima near k f0 (k = 1..n_harm): the harmonic comb of auto_tuner R2."""
    s = 0.0
    for k in range(1, n_harm + 1):
        fc = k * f0
        m = (f > fc * 0.985) & (f < fc * 1.015)
        if not m.any() or fc > f[-1]:
            break
        s += P[m].max()
    return s


def estimate_f0(x, sr, nominal_hz=None, t0=0.05, window_s=1.0):
    """Harmonic-comb fundamental (auto_tuner R2): candidates are spectral peaks (and their sub-multiples), the
    winner has the strongest comb; with `nominal_hz` the search stays within +-1 semitone of it. Returns Hz or None."""
    n = len(x) / sr
    t1 = min(t0 + window_s, n)
    if t1 - t0 < 0.1:
        t0, t1 = 0.0, n
    f, P = spectrum(x, sr, t0, t1, pad=4)
    if nominal_hz:
        lo, hi = nominal_hz / 2 ** (1 / 12), nominal_hz * 2 ** (1 / 12)
        grid = np.geomspace(lo, hi, 400)
        best = max(grid, key=lambda c: _comb_score(f, P, c))
    else:
        m = (f > 25) & (f < 4200)
        idx = np.where(m)[0]
        p = P[idx]
        thr = p.max() * 1e-4
        peaks = [idx[i] for i in range(1, len(idx) - 1) if p[i] > thr and p[i] >= p[i - 1] and p[i] >= p[i + 1]]
        peaks = sorted(peaks, key=lambda i: -P[i])[:12]
        cands = {f[i] / d for i in peaks for d in (1, 2, 3, 4) if f[i] / d > 25}
        if not cands:
            return None
        best = max(cands, key=lambda c: _comb_score(f, P, c))
    # refine on the fine grid around the winner
    fine = np.linspace(best * 0.995, best * 1.005, 201)
    best = max(fine, key=lambda c: _comb_score(f, P, c))
    return float(best)


def track_partials(x, sr, f0, n=PARTIALS, t0=0.05, window_s=1.0):
    """[(k, hz, level_db)] of the first n partials, following the measured stretch (fit_lib17 track); the level is
    the peak-bin power in dB (relative values are what matter)."""
    t1 = min(t0 + window_s, len(x) / sr)
    f, P = spectrum(x, sr, t0, t1, pad=8)
    out = []
    drift = 1.0
    top = None
    for k in range(1, n + 1):
        fc = k * f0 * drift
        m = (f > fc - 0.25 * f0) & (f < fc + 0.25 * f0)
        if fc > f[-1] or not m.any():
            break
        j = np.where(m)[0][np.argmax(P[m])]
        level = float(db(P[j]))
        top = level if top is None else max(top, level)
        if level < top - 60.0:
            break                                                 # past the last real partial: the rest is floor
        out.append((k, float(f[j]), level))
        drift = f[j] / (k * f0)
    return out


def inharmonicity(partials):
    """B from (f_k / k)^2 = f0^2 (1 + B k^2): a straight line in k^2 (fit_lib17 Bof). Returns (B, f0_fit) or None."""
    if len(partials) < 3:
        return None
    k = np.array([p[0] for p in partials], dtype=float)
    y = (np.array([p[1] for p in partials]) / k) ** 2
    slope, intercept = np.polyfit(k ** 2, y, 1)
    if intercept <= 0:
        return None
    return float(slope / intercept), float(math.sqrt(intercept))


def cents(hz, ref_hz):
    return 1200.0 * math.log2(hz / ref_hz)


def nearest_midi(hz):
    return int(round(69 + 12 * math.log2(hz / 440.0)))


def midi_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


# ---- spectrum shape ---------------------------------------------------------------------------

def spectral_centroid(x, sr, t0, t1, fmax=12000):
    """Power-weighted mean frequency of x[t0:t1] below fmax (fit_lib17 sc / param_sound_harness)."""
    f, P = spectrum(x, sr, t0, t1)
    m = f < fmax
    if P[m].sum() <= 0:
        return None
    return float((f[m] * P[m]).sum() / P[m].sum())


def rolloff_db_per_oct(partials):
    """Slope of partial level (dB) against log2(k): the spectral tilt over the tracked partials."""
    if len(partials) < 3:
        return None
    k = np.log2([p[0] for p in partials])
    lv = [p[2] for p in partials]
    return float(np.polyfit(k, lv, 1)[0])


def band_time_matrix(x, sr):
    """dB per (window, band) of BT_WINDOWS x BT_EDGES (fit_lib17 mat); None where the window is past the end."""
    rows = []
    for a, b, _ in BT_WINDOWS:
        if b > len(x) / sr:
            rows.append([None] * (len(BT_EDGES) - 1))
            continue
        f, P = spectrum(x, sr, a, b)
        rows.append([float(db(P[(f >= lo) & (f < hi)].sum())) for lo, hi in zip(BT_EDGES[:-1], BT_EDGES[1:])])
    return rows


def cloud(x, sr, f0, B=0.0):
    """Noise between partials (fit_lib17 cloud) as a RATIO: cloud energy minus total energy of the band, dB, per
    (window, band) of CLOUD_WINDOWS x CLOUD_BANDS. 0 dB = all energy between partials, -30 dB = clean partials."""
    out = []
    for a, b in CLOUD_WINDOWS:
        if b > len(x) / sr:
            out.append([None] * len(CLOUD_BANDS))
            continue
        f, P = spectrum(x, sr, a, b, pad=4)
        row = []
        for lo, hi in CLOUD_BANDS:
            m = (f >= lo) & (f < hi)
            ff, pp = f[m], P[m]
            if not len(ff):
                row.append(None)
                continue
            k = np.maximum(1, np.round(ff / f0))
            d = np.abs(ff - k * f0 * np.sqrt(1 + max(B, 0.0) * k ** 2))
            row.append(float(db(pp[d >= 0.08 * f0].sum()) - db(pp.sum())))
        out.append(row)
    return out


# ---- time behaviour ----------------------------------------------------------------------------

def decay_per_band(x, sr, noise_db=None):
    """Per DECAY_BANDS band: the decay rate (dB/s) fitted from 5 dB under the band's peak down to 35 dB under it
    (or the noise floor + 6 dB), and t60 = 60 / rate. `valid` is False when under 15 dB of range was usable."""
    out = []
    for lo, hi in DECAY_BANDS:
        y = bandpass(x, sr, lo, hi)
        env = db(rms_envelope(y, sr) ** 2)
        i0 = int(np.argmax(env))
        top = env[i0]
        floor = top - 35.0
        if noise_db is not None:
            floor = max(floor, noise_db + 6.0)
        tail = env[i0:]
        below = np.where(tail < floor)[0]
        i1 = int(below[0]) if len(below) else len(tail) - 1
        start = np.where(tail[:i1 + 1] < top - 5.0)[0]
        a = int(start[0]) if len(start) else 0
        seg = tail[a:i1 + 1]
        rec = {"band_hz": [lo, hi], "rate_db_s": None, "t60_s": None, "range_db": float(top - tail[i1]), "valid": False}
        if len(seg) > int(0.05 * sr) and (top - tail[i1]) >= 15.0:
            t = np.arange(len(seg)) / sr
            slope = -float(np.polyfit(t, seg, 1)[0])
            if slope > 0:
                rec.update(rate_db_s=slope, t60_s=60.0 / slope, valid=True)
        out.append(rec)
    return out


def attack(x, sr):
    """Broadband envelope: time from onset to the peak, and the 10 % -> 90 % rise time (param_sound_harness
    attack_peak_time_s); both in ms."""
    env = rms_envelope(x, sr, 0.001)
    i_peak = int(np.argmax(env))
    peak = env[i_peak]
    i10 = int(np.argmax(env >= 0.1 * peak))
    i90 = int(np.argmax(env >= 0.9 * peak))
    return {"peak_time_ms": 1000.0 * i_peak / sr, "rise_10_90_ms": 1000.0 * max(0, i90 - i10) / sr}


def half_rise_time(env, sr):
    """Time (s) at which an envelope first reaches half its maximum."""
    return float(np.argmax(env >= 0.5 * env.max()) / sr)


def thump(x, sr, f0):
    """The keybed-thump signature (dev-thump1 metric, fit_lib lowtab): low band energy in the first 30 ms minus
    0.5-1 s (dB), and the low band's half-rise lead over the tone (ms). Meaningless when f0 sits in the band."""
    lo, hi = THUMP_BAND
    f0_in_band = f0 is not None and lo <= f0 * 1.15 and f0 * 0.85 <= hi
    y = bandpass(x, sr, lo, hi)
    e = y * y
    n = len(x)
    early = e[:int(0.03 * sr)].mean() if n > int(0.03 * sr) else None
    late = e[int(0.5 * sr):int(1.0 * sr)].mean() if n > int(1.0 * sr) else None
    excess = float(db(early) - db(late)) if early is not None and late is not None else None
    lead = None
    if f0 and not f0_in_band:
        tone = bandpass(x, sr, 0.8 * f0, 1.25 * f0)
        lead = 1000.0 * (half_rise_time(rms_envelope(tone, sr, 0.002), sr) - half_rise_time(rms_envelope(y, sr, 0.002), sr))
    return {"excess_db": excess, "lead_ms": lead, "f0_in_band": bool(f0_in_band)}


def beating(x, sr, f0, t0=0.3, t1=3.0):
    """Ripple of the fundamental's envelope (dB) between t0 and t1 after a straight-line decay is removed, and the
    strongest modulation frequency (Hz): unison beating shows as a few-Hz ripple of several dB."""
    if len(x) / sr < t1 or not f0:
        return None
    bw = min(0.3 * f0, 25.0)
    y = bandpass(x, sr, f0 - bw, f0 + bw, order=3)
    env = db(rms_envelope(y, sr, 0.02) ** 2)[int(t0 * sr):int(t1 * sr)]
    t = np.arange(len(env)) / sr
    resid = env - np.polyval(np.polyfit(t, env, 1), t)
    step = max(1, int(sr / 200))
    r = resid[::step]
    spec = np.abs(np.fft.rfft(r - r.mean()))
    fr = np.fft.rfftfreq(len(r), step / sr)
    m = (fr > 0.3) & (fr < 30)
    peak_hz = float(fr[m][np.argmax(spec[m])]) if m.any() else None
    return {"depth_db": float(resid.max() - resid.min()), "modulation_hz": peak_hz}


# ---- the whole card ---------------------------------------------------------------------------

def analyse(x, sr, nominal_midi=None):
    """The characteristics card of one mono note. `nominal_midi` (the played key) narrows the pitch search and
    gives the tuning in cents; without it the nearest equal-tempered pitch is the reference."""
    x = np.asarray(x, dtype=float)
    if x.ndim > 1:
        x = x[:, 0]
    o = onset_index(x, sr)
    noise = db(np.mean(x[:o] ** 2)) if o > int(0.05 * sr) else None       # the pre-onset floor, when there is one
    x = x[o:]
    dur = len(x) / sr
    head = x[:int(0.5 * sr)] if dur > 0.5 else x
    peak = float(np.abs(x).max()) if len(x) else 0.0
    rms = float(np.sqrt(np.mean(head ** 2))) if len(head) else 0.0
    nominal_hz = midi_hz(nominal_midi) if nominal_midi is not None else None
    f0 = estimate_f0(x, sr, nominal_hz) if peak > 0 else None
    card = {
        "version": VERSION, "sample_rate": sr, "duration_s": round(dur, 3), "onset_s": round(o / sr, 4),
        "level": {"peak_dbfs": float(20 * np.log10(max(peak, 1e-12))), "rms_dbfs_first_0_5s": float(20 * np.log10(max(rms, 1e-12))),
                  "crest_factor": float(peak / rms) if rms > 0 else None, "noise_floor_db": None if noise is None else float(noise)},
        "pitch": None, "partials": [], "spectrum": None, "decay": None, "attack": None, "thump": None, "beating": None,
        "band_time_db": None, "cloud_db": None,
    }
    if f0 is None or len(x) < int(0.2 * sr):
        return card
    parts = track_partials(x, sr, f0)
    inh = inharmonicity(parts)
    B, f0_fit = inh if inh else (None, f0)
    ref_midi = nominal_midi if nominal_midi is not None else nearest_midi(f0_fit)
    top = max(p[2] for p in parts) if parts else 0.0
    card["pitch"] = {"f0_hz": f0_fit, "nominal_midi": ref_midi, "nominal_hz": midi_hz(ref_midi),
                     "tuning_cents": cents(f0_fit, midi_hz(ref_midi)), "inharmonicity_B": B}
    card["partials"] = [{"k": k, "hz": hz, "level_db": lv - top} for k, hz, lv in parts]
    card["spectrum"] = {"centroid_attack_hz": spectral_centroid(x, sr, 0.0, 0.03),
                        "centroid_body_hz": spectral_centroid(x, sr, 0.1, 0.4) if dur > 0.4 else None,
                        "rolloff_db_per_oct": rolloff_db_per_oct(parts)}
    card["decay"] = decay_per_band(x, sr, noise)
    card["attack"] = attack(x, sr)
    card["thump"] = thump(x, sr, f0_fit)
    card["beating"] = beating(x, sr, f0_fit)
    card["band_time_db"] = band_time_matrix(x, sr)
    card["cloud_db"] = cloud(x, sr, f0_fit, B or 0.0)
    return card


def _rms_diff(a, b):
    """RMS of a - b over the cells both have (nested lists with None)."""
    d = [float(u) - float(v) for ra, rb in zip(a, b) for u, v in zip(ra, rb) if u is not None and v is not None]
    return (float(np.sqrt(np.mean(np.square(d)))), d) if d else (None, [])


def compare(a, b):
    """Differences of two cards (b minus a, so '+' = b has more): level-matched band-time RMS (the fit library's
    headline score), cloud RMS, partial-level RMS, pitch, inharmonicity, centroids, decay per band."""
    out = {"band_time_rms_db": None, "band_time_offset_db": None, "cloud_rms_db": None, "partials_rms_db": None,
           "pitch_cents": None, "inharmonicity_ratio": None, "centroid_attack_ratio": None, "centroid_body_ratio": None,
           "decay_t60_ratio": [], "attack_rise_ms": None, "thump_excess_db": None}
    if a.get("band_time_db") and b.get("band_time_db"):
        _, d = _rms_diff(b["band_time_db"], a["band_time_db"])
        if d:
            off = float(np.mean(d))                                  # the level match (WAVs are normalised anyway)
            out["band_time_offset_db"] = off
            out["band_time_rms_db"] = float(np.sqrt(np.mean(np.square(np.array(d) - off))))
    if a.get("cloud_db") and b.get("cloud_db"):
        out["cloud_rms_db"] = _rms_diff(b["cloud_db"], a["cloud_db"])[0]
    pa = {p["k"]: p["level_db"] for p in a.get("partials", [])}
    pb = {p["k"]: p["level_db"] for p in b.get("partials", [])}
    common = sorted(set(pa) & set(pb))
    if common:
        out["partials_rms_db"] = float(np.sqrt(np.mean([(pb[k] - pa[k]) ** 2 for k in common])))
        out["partials_diff_db"] = [[k, round(pb[k] - pa[k], 1)] for k in common]
    if a.get("pitch") and b.get("pitch"):
        out["pitch_cents"] = cents(b["pitch"]["f0_hz"], a["pitch"]["f0_hz"])
        if a["pitch"].get("inharmonicity_B") and b["pitch"].get("inharmonicity_B"):
            out["inharmonicity_ratio"] = b["pitch"]["inharmonicity_B"] / a["pitch"]["inharmonicity_B"]
    for key in ("attack", "body"):
        sa = (a.get("spectrum") or {}).get(f"centroid_{key}_hz")
        sb = (b.get("spectrum") or {}).get(f"centroid_{key}_hz")
        if sa and sb:
            out[f"centroid_{key}_ratio"] = sb / sa
    for da, dbb in zip(a.get("decay") or [], b.get("decay") or []):
        out["decay_t60_ratio"].append([da["band_hz"], (dbb["t60_s"] / da["t60_s"]) if da["valid"] and dbb["valid"] else None])
    if a.get("attack") and b.get("attack"):
        out["attack_rise_ms"] = b["attack"]["rise_10_90_ms"] - a["attack"]["rise_10_90_ms"]
    ta, tb = (a.get("thump") or {}).get("excess_db"), (b.get("thump") or {}).get("excess_db")
    if ta is not None and tb is not None:
        out["thump_excess_db"] = tb - ta
    return out
