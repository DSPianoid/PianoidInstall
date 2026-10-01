"""dev-chord — MEASURED proof: offline coincident chord vs staggered sweep.

Audio_off / deterministic (runOfflinePlayback). No audio driver, no server.

Renders, through the SAME offline engine primitive `runOfflinePlayback`:
  A) COINCIDENT chord  — built by the SHIPPING `_sound_test_build_event_queue(
     "chord", ...)` (all NOTE_ONs at cycle_index 0).
  B) STAGGERED sweep   — built like backendServer.py `/play_keyboard` offline
     (NOTE_ON i at cycle_index = i * cycles_per_step), big step so onsets are
     unambiguously separated.

Metric = FFT presence in an EARLY window vs a LATE window (the w2_chord_render
method, applied windowed). A fundamental is "present" when its f0 band peak
stands >= PRESENCE_SNR_DB above the window's spectral noise floor.

  * COINCIDENT: every chord fundamental is present in the EARLY window
    (40..190 ms) -> all notes sound together from t~0.
  * STAGGERED : in the EARLY window only the first note is present (later notes
    have NOT entered yet); in the LATE window all are present -> notes enter
    over time. This proves the engine honours per-event onset cycles AND that
    coincident onset is a scheduler choice, not an engine limit.

Writes JSON + PNG (RMS-envelope staircase) under docs/development/diagnostics/.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_ROOT = Path(__file__).resolve().parents[3]
MIDDLEWARE_DIR = REPO_ROOT / "PianoidCore" / "pianoid_middleware"
PRESET_PATH = MIDDLEWARE_DIR / "presets" / "Preset_test5.json"
OUT_DIR = REPO_ROOT / "docs" / "development" / "diagnostics"

sys.path.insert(0, str(MIDDLEWARE_DIR))
os.chdir(MIDDLEWARE_DIR)

import pianoidCuda  # noqa: E402
from pianoid import initialize  # noqa: E402
import chartFunctions  # noqa: E402  (uses the SHIPPING chord queue builder)

VELOCITY = 100
SUSTAIN_MS = 1400          # long enough that all notes overlap in the LATE window
STEP_MS = 350.0           # big stagger so onsets are unambiguously separated
RENDER_TAIL_MS = 400
EARLY_WIN = (150.0, 330.0)    # ms — POST attack-click, BEFORE the 2nd staggered note (~350ms)
LATE_WIN = (1150.0, 1350.0)   # ms — after the last staggered note (~1050ms) has entered
PRESENCE_REL_DB = 30.0        # present if f0 peak within this of the loudest f0 in the window
                              # (the w2_chord_render presence criterion)


def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def _no(pitch, vel, cycle):
    ev = pianoidCuda.PlaybackEvent(); ev.channel = 0; ev.cycle_index = cycle
    ev.type = pianoidCuda.EventType.NOTE_ON; ev.data = (int(pitch) << 8) | int(vel)
    return ev


def _nf(pitch, cycle):
    ev = pianoidCuda.PlaybackEvent(); ev.channel = 0; ev.cycle_index = cycle
    ev.type = pianoidCuda.EventType.NOTE_OFF; ev.data = (int(pitch) << 8)
    return ev


def _build_staggered_queue(pitches, velocity, step_ms, sustain_ms, sr, spc):
    """Mirror backendServer.py /play_keyboard OFFLINE."""
    cps = max(1, int(round((step_ms / 1000.0) * sr / spc)))
    csus = max(1, int(round((sustain_ms / 1000.0) * sr / spc)))
    eq = pianoidCuda.EventQueue()
    for i, p in enumerate(pitches):
        eq.addEvent(_no(p, velocity, i * cps))
        eq.addEvent(_nf(p, i * cps + csus))
    eq.sortByCycle()
    total_ms = (len(pitches) - 1) * step_ms + sustain_ms
    return eq, total_ms, cps * spc / sr * 1000.0


def _render(pianoid, eq, total_play_ms):
    sr = pianoid.mp.sample_rate(); spc = pianoid.mp.mode_iteration
    cpp = pianoid.pianoid
    cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.sample_rate = sr; cfg.samples_per_cycle = spc
    cfg.max_duration_ms = int(total_play_ms + RENDER_TAIL_MS)
    t0 = time.time()
    stats = cpp.runOfflinePlayback(eq, cfg)
    audio = np.array(cpp.getRecordedAudio(), dtype=np.float64)
    return audio, sr, stats, time.time() - t0


def _fft_presence(audio, sr, f0s, win_ms, half_bw_hz=8.0):
    """FFT the [win_ms[0], win_ms[1]] slice; per fundamental return its f0 band
    peak in dB RELATIVE to the loudest chord fundamental in that same window
    (the w2_chord_render criterion). present if within PRESENCE_REL_DB of the
    loudest -> the note is sounding in that window."""
    i0 = int(win_ms[0] * sr / 1000.0)
    i1 = min(len(audio), int(win_ms[1] * sr / 1000.0))
    seg = audio[i0:i1]
    if seg.size < 128:
        return {m: {"rel_db": None, "present": False} for m in f0s}
    w = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * w))
    freqs = np.fft.rfftfreq(len(seg), d=1.0 / sr)
    peaks = {}
    for m, f0 in f0s.items():
        mask = (freqs >= f0 - half_bw_hz) & (freqs <= f0 + half_bw_hz)
        peaks[m] = float(np.max(spec[mask])) if np.any(mask) else 0.0
    loudest = max(peaks.values()) or 1e-12
    out = {}
    for m in f0s:
        rel = 20.0 * np.log10(peaks[m] / loudest) if peaks[m] > 0 else -120.0
        out[m] = {"rel_db": round(rel, 1), "present": bool(rel >= -PRESENCE_REL_DB)}
    return out


def _rms_env(audio, sr, bin_ms=25.0):
    b = max(1, int(bin_ms * sr / 1000.0))
    n = len(audio) // b
    if n == 0:
        return np.array([]), np.array([])
    seg = audio[:n * b].reshape(n, b)
    rms = np.sqrt(np.mean(seg ** 2, axis=1))
    t = (np.arange(n) * b + b / 2) / sr * 1000.0
    return t, rms


def _jsonable(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return str(o)


def main():
    p = initialize(str(PRESET_PATH), filterlen=48 * 128 * 3, string_iteration=4,
                   array_size=384, buffer_size=4, sample_rate=48000,
                   samples_in_cycle=64, max_volume=5e18, audio_on=False,
                   audio_driver_type=0)
    try:
        sr = p.mp.sample_rate(); spc = p.mp.mode_iteration
        try:
            keys = sorted(p.get_all_pitches_in_preset(
                convert_to_notes=False, key_pitches=True))
        except TypeError:
            keys = sorted(p.get_all_pitches_in_preset(convert_to_notes=False))
        keys = [m for m in keys if 21 <= m <= 108]
        keyset = set(keys)
        # Non-colliding strong-register spread: fundamentals 277/370/466/622 Hz,
        # no octave / integer-harmonic relation (avoids one note's overtone
        # masking another's fundamental). Fall back to a mid spread if absent.
        preferred = [61, 66, 70, 75]
        if all(m in keyset for m in preferred):
            pitches = preferred
        else:
            pool = [m for m in keys if 48 <= m <= 79] or keys
            idx = [0, len(pool) // 3, 2 * len(pool) // 3, len(pool) - 1]
            pitches = sorted({pool[i] for i in idx})
        f0s = {m: midi_to_hz(m) for m in pitches}
        print(f"sr={sr} spc={spc} pitches={pitches} "
              f"f0={[round(f0s[m],1) for m in pitches]}")

        # A) COINCIDENT via the SHIPPING sound_test chord builder
        vels = [VELOCITY] * len(pitches); durs = [SUSTAIN_MS] * len(pitches)
        chord_q, chord_ms = chartFunctions._sound_test_build_event_queue(
            "chord", pitches, vels, durs, sr, spc)
        a_audio, _, a_stats, a_t = _render(p, chord_q, chord_ms)

        # B) STAGGERED like /play_keyboard offline
        stag_q, stag_ms, step_real = _build_staggered_queue(
            pitches, VELOCITY, STEP_MS, SUSTAIN_MS, sr, spc)
        b_audio, _, b_stats, b_t = _render(p, stag_q, stag_ms)

        # ---- DEFINITIVE GAP TEST: does offline honour NOTE_ON cycle_index? ----
        # 2 notes, non-overlapping, big gap. Note B scheduled ~800ms. Compare
        # B's f0 band energy in a PRE window (before B's onset, A already off)
        # vs a POST window (after B's onset). Collision-immune: same band, two
        # times; f0_B is not a harmonic of f0_A.
        pA, pB = pitches[0], pitches[-1]
        f0A, f0B = f0s[pA], f0s[pB]
        cps_ms = lambda ms: max(1, int(round((ms / 1000.0) * sr / spc)))
        gap_q = pianoidCuda.EventQueue()
        gap_q.addEvent(_no(pA, VELOCITY, 0))
        gap_q.addEvent(_nf(pA, cps_ms(250)))            # A off at 250ms
        gap_q.addEvent(_no(pB, VELOCITY, cps_ms(800)))  # B on at 800ms
        gap_q.addEvent(_nf(pB, cps_ms(1050)))           # B off at 1050ms
        gap_q.sortByCycle()
        g_audio, _, g_stats, _ = _render(p, gap_q, 1200)

        def _band_peak(audio, f0, win, half_bw=8.0):
            i0 = int(win[0] * sr / 1000.0); i1 = min(len(audio), int(win[1] * sr / 1000.0))
            s = audio[i0:i1]
            if s.size < 128:
                return 0.0
            sp = np.abs(np.fft.rfft(s * np.hanning(len(s))))
            fr = np.fft.rfftfreq(len(s), d=1.0 / sr)
            mk = (fr >= f0 - half_bw) & (fr <= f0 + half_bw)
            return float(np.max(sp[mk])) if np.any(mk) else 0.0

        preW, postW = (400.0, 600.0), (850.0, 1000.0)
        b_pre = _band_peak(g_audio, f0B, preW)     # B's fundamental BEFORE its onset
        b_post = _band_peak(g_audio, f0B, postW)   # B's fundamental AFTER its onset
        gap_db = 20.0 * np.log10(b_post / b_pre) if b_pre > 0 else 120.0
        honors_cycle_index = gap_db >= 12.0        # B clearly enters only after its scheduled onset
        print(f"\n== GAP TEST (does offline honour NOTE_ON cycle_index?) ==")
        print(f"  note A={pA} (on 0-250ms), note B={pB} f0={f0B:.1f}Hz (on 800-1050ms)")
        print(f"  B-fundamental band peak: PRE{preW}={b_pre:.3e}  POST{postW}={b_post:.3e}")
        print(f"  POST/PRE = {gap_db:+.1f} dB  => offline honours cycle_index: {honors_cycle_index}")

        a_early = _fft_presence(a_audio, sr, f0s, EARLY_WIN)
        a_late = _fft_presence(a_audio, sr, f0s, LATE_WIN)
        b_early = _fft_presence(b_audio, sr, f0s, EARLY_WIN)
        b_late = _fft_presence(b_audio, sr, f0s, LATE_WIN)

        a_all_early = all(a_early[m]["present"] for m in pitches)
        a_all_late = all(a_late[m]["present"] for m in pitches)
        b_present_early = [m for m in pitches if b_early[m]["present"]]
        b_all_late = all(b_late[m]["present"] for m in pitches)
        first, last = pitches[0], pitches[-1]

        # COINCIDENT: all fundamentals already present in the EARLY window
        coincident_ok = a_all_early and a_all_late
        # STAGGERED: first note present early, LAST note NOT yet present early,
        # but ALL present late (the notes entered over time).
        staggered_ok = (b_early[first]["present"]
                        and not b_early[last]["present"]
                        and b_all_late)
        verdict = "PASS" if (coincident_ok and staggered_ok) else "FAIL"

        def _show(tag, early, late):
            print(f"\n== {tag} ==")
            print(f"  EARLY window {EARLY_WIN} ms (rel to loudest f0 in window):")
            for m in pitches:
                print(f"    midi {m:3d} f0={f0s[m]:7.1f}Hz  {early[m]['rel_db']:>7} dB  present={early[m]['present']}")
            print(f"  LATE window {LATE_WIN} ms:")
            for m in pitches:
                print(f"    midi {m:3d} f0={f0s[m]:7.1f}Hz  {late[m]['rel_db']:>7} dB  present={late[m]['present']}")

        # Collision-proof cross-check: coarse broadband RMS at 4 probe windows
        # (0-120 / step / 2*step / 3*step ms). Coincident = full RMS at t~0,
        # roughly flat/decaying. Staggered = RMS STAIRCASE (rises as notes enter).
        def _rms_at(audio, c_ms, w_ms=100.0):
            i0 = int(c_ms * sr / 1000.0); i1 = min(len(audio), int((c_ms + w_ms) * sr / 1000.0))
            s = audio[i0:i1]
            return float(np.sqrt(np.mean(s ** 2))) if s.size else 0.0
        probes = [60.0, step_real + 60, 2 * step_real + 60, 3 * step_real + 60]
        a_stair = [_rms_at(a_audio, c) for c in probes]
        b_stair = [_rms_at(b_audio, c) for c in probes]
        _fmt = lambda xs: "[" + ", ".join(f"{x:.3e}" for x in xs) + "]"
        print(f"\nRMS staircase @ {[round(x) for x in probes]} ms (collision-proof):")
        print(f"  COINCIDENT: {_fmt(a_stair)}   [expect full from 1st probe, ~flat/decaying]")
        print(f"  STAGGERED : {_fmt(b_stair)}   [expect rising staircase as notes enter]")

        _show("COINCIDENT (sound_test play_kind=chord, offline runOfflinePlayback)", a_early, a_late)
        print(f"  => all present EARLY={a_all_early}  all present LATE={a_all_late}")
        _show(f"STAGGERED (/play_keyboard-style offline, step~{step_real:.0f}ms)", b_early, b_late)
        print(f"  => present EARLY={b_present_early} (of {pitches})  all present LATE={b_all_late}")
        print(f"\ncoincident_ok={coincident_ok} staggered_ok={staggered_ok}")
        print(f"VERDICT: {verdict}")

        result = {
            "verdict": verdict, "sr": sr, "spc": spc, "pitches": pitches,
            "f0_hz": {str(m): round(f0s[m], 2) for m in pitches},
            "early_window_ms": EARLY_WIN, "late_window_ms": LATE_WIN,
            "presence_rel_db_threshold": PRESENCE_REL_DB,
            "rms_staircase_probe_ms": [round(x) for x in probes],
            "rms_staircase": {"coincident": a_stair, "staggered": b_stair},
            "coincident": {
                "source": "chartFunctions._sound_test_build_event_queue('chord',...) -> runOfflinePlayback",
                "early": {str(m): a_early[m] for m in pitches},
                "late": {str(m): a_late[m] for m in pitches},
                "all_present_early": a_all_early, "all_present_late": a_all_late,
                "render_s": round(a_t, 3), "total_cycles": a_stats.total_cycles,
                "peak": float(np.max(np.abs(a_audio))) if a_audio.size else 0.0},
            "staggered": {
                "source": "backendServer /play_keyboard-style: cycle_index=i*cycles_per_step",
                "step_ms": round(step_real, 1),
                "early": {str(m): b_early[m] for m in pitches},
                "late": {str(m): b_late[m] for m in pitches},
                "present_early": b_present_early, "all_present_late": b_all_late,
                "render_s": round(b_t, 3), "total_cycles": b_stats.total_cycles,
                "peak": float(np.max(np.abs(b_audio))) if b_audio.size else 0.0},
        }
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        with open(OUT_DIR / "dev-chord-result.json", "w") as f:
            json.dump(result, f, indent=2, default=_jsonable)
        print(f"JSON -> {OUT_DIR / 'dev-chord-result.json'}")

        # PNG: RMS-envelope staircase + early/late window markers
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            fig, axes = plt.subplots(2, 1, figsize=(12, 7), constrained_layout=True)
            for ax, audio, title in (
                (axes[0], a_audio, "COINCIDENT chord (sound_test play_kind=chord, offline) — RMS envelope"),
                (axes[1], b_audio, f"STAGGERED sweep (/play_keyboard-style, step~{step_real:.0f}ms) — RMS envelope")):
                t, r = _rms_env(audio, sr)
                ax.plot(t, r, color="steelblue", lw=1.1)
                ax.axvspan(*EARLY_WIN, color="limegreen", alpha=0.18, label="early window")
                ax.axvspan(*LATE_WIN, color="orange", alpha=0.18, label="late window")
                ax.set_title(title); ax.set_xlabel("time (ms)")
                ax.set_ylabel("RMS"); ax.grid(True, alpha=0.3); ax.legend(fontsize=8)
            png = OUT_DIR / "dev-chord-onsets.png"
            plt.savefig(png, dpi=110); plt.close(fig)
            print(f"PNG -> {png}")
        except Exception as e:
            print(f"PNG render failed: {e}")

        return verdict
    finally:
        try:
            p.pianoid.shutdownGpu()
        except Exception:
            pass


if __name__ == "__main__":
    v = main()
    sys.exit(0 if v == "PASS" else 1)
