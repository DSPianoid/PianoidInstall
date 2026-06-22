"""dev-applyc — In-place CUDA re-init ACCEPTANCE TEST (the verification gate).

User-specified acceptance sequence (audio_off offline render):
  1. Load a preset.
  2. Apply parameter EDITS that audibly change a string (tension_offset on a pitch).
  3. Render the edited note offline -> reference SOUND A.
  4. IN-PLACE re-init the CUDA engine with DIFFERENT array_size (384->512) AND
     DIFFERENT string_iterations (4->8) via reinitialize_cuda_engine (NO preset
     reload, edits preserved). This changes dx (grid spacing) AND
     dt = 1/(sr*string_iteration); the spatial/per-point arrays are RE-COMPUTED
     from the resolution-INDEPENDENT physical model (length/tension/rho/r) + the
     user's edits — NOT copied from the old grid.
  5. Render the SAME edited note offline -> SOUND B.
  6. Compare A vs B. ACCEPTANCE: NEARLY IDENTICAL — same fundamental pitch, same
     character/decay, edits clearly still in effect — only a minor sound-quality
     delta allowed (finer dx + different dt slightly change rendering accuracy).

Also runs a 384 -> 512 -> 384 ROUND-TRIP: render at each array_size; the return
to 384 must match the original 384 edited render closely (dx/dt recompute is
reversible + correct).

Metrics reported per comparison: fundamental-freq match (Hz), RMS ratio,
normalized waveform correlation, and a magnitude-spectrum correlation.

Run from PianoidCore/pianoid_middleware. Prints ACCEPT / REJECT + a JSON line.
"""
import os
import sys
import gc
import json
import time
import traceback
import faulthandler

import numpy as np

faulthandler.enable()

MIDDLEWARE = os.getcwd()
if MIDDLEWARE not in sys.path:
    sys.path.insert(0, MIDDLEWARE)

import pianoidCuda
from pianoid import initialize

SR = 48000
SPC = 48
TEST_PITCH = 60
TEST_VELOCITY = 80
PRESET = "presets/Preset_test5.json"

out = {"renders": {}, "comparisons": {}, "verdict": None}


def log(m):
    print(m, flush=True)


def settle():
    """Quiesce the GPU between an offline render and a destroy+reconstruct
    (measured necessary: an offline render leaves stream/engine state a same-
    process reconstruct otherwise cannot survive). gc + cupy stream/device sync."""
    gc.collect()
    try:
        import cupy
        cupy.cuda.Stream.null.synchronize()
        cupy.cuda.Device().synchronize()
    except Exception:
        pass
    time.sleep(0.2)


def make_event(pitch, velocity, cycle):
    ev = pianoidCuda.PlaybackEvent()
    ev.type = pianoidCuda.EventType.NOTE_ON
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8) | velocity
    return ev


def render(p, label, sample_rate=SR):
    """Offline-render the test note; return the recorded buffer (float64)."""
    eq = pianoidCuda.EventQueue()
    eq.addEvent(make_event(TEST_PITCH, TEST_VELOCITY, 100))
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.max_duration_ms = 2000
    cfg.sample_rate = sample_rate
    cfg.samples_per_cycle = SPC
    p.pianoid.resetStringsState()
    stats = p.pianoid.runOfflinePlayback(eq, cfg)
    if not stats.completed_successfully:
        raise RuntimeError(f"{label}: render failed: {stats.error_message}")
    sound = np.array(p.pianoid.getRecordedAudio(), dtype=np.float64)
    if len(sound) == 0:
        raise RuntimeError(f"{label}: empty buffer")
    log(f"  [{label}] peak={np.max(np.abs(sound)):.3e} rms={np.sqrt(np.mean(sound**2)):.3e} n={len(sound)}")
    return sound


def fundamental(sig, sr=SR):
    from SoundFeatures import soundTone
    skip = int(0.1 * sr)
    if len(sig) <= skip + 1000:
        return -1.0
    try:
        return float(soundTone(sig[skip:], sr))
    except Exception:
        return -1.0


def compare(a, b, sr=SR):
    """A-vs-B metrics: fundamental match, RMS ratio, waveform corr, spectral corr."""
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    rms_a = float(np.sqrt(np.mean(a**2))) or 1e-30
    rms_b = float(np.sqrt(np.mean(b**2)))
    fa, fb = fundamental(a, sr), fundamental(b, sr)
    # waveform correlation (mean-removed, normalized)
    am, bm = a - a.mean(), b - b.mean()
    wav_corr = float(np.dot(am, bm) / ((np.linalg.norm(am) * np.linalg.norm(bm)) or 1e-30))
    # magnitude-spectrum correlation
    fa_mag = np.abs(np.fft.rfft(a))
    fb_mag = np.abs(np.fft.rfft(b))
    fam, fbm = fa_mag - fa_mag.mean(), fb_mag - fb_mag.mean()
    spec_corr = float(np.dot(fam, fbm) / ((np.linalg.norm(fam) * np.linalg.norm(fbm)) or 1e-30))
    return {
        "freq_a": fa, "freq_b": fb,
        "freq_match": (fa > 0 and fb > 0 and abs(fa - fb) / fa < 0.02),
        "rms_ratio": rms_b / rms_a,
        "wav_corr": wav_corr,
        "spec_corr": spec_corr,
    }


def edit_pitch(p, tension_offset):
    p.param_manager.update_pitch_physical_params(
        TEST_PITCH, send_to_cuda=True, tension_offset=tension_offset)


def main():
    try:
        log("=== In-place re-init ACCEPTANCE TEST (array_size + string_iterations) ===")
        # 1. Load.
        p = initialize(PRESET, filterlen=48*128*3, string_iteration=4,
                       array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                       buffer_size=4, max_volume=5e18, audio_on=False,
                       audio_driver_type=0)
        log(f"1. loaded; array_size={p.mp.array_size} string_iter={p.mp.string_iteration} "
            f"dx-native, sr={p.mp.sample_rate()}")

        # base (unedited) render for context.
        base = render(p, "base-384-iter4")

        # 2. EDIT a pitch audibly (tension_offset shifts the string clearly).
        EDIT_TO = 0.5
        edit_pitch(p, EDIT_TO)
        log(f"2. edited pitch {TEST_PITCH} tension_offset -> {EDIT_TO}")

        # 3. SOUND A — edited note at array_size=384, string_iter=4.
        A = render(p, "A: edited-384-iter4")
        out["renders"]["A_384_iter4"] = True

        # 4. IN-PLACE re-init: array_size 384->512 AND string_iterations 4->8.
        log("4. in-place re-init: array_size 384->512 AND string_iterations 4->8 (dx + dt change)")
        settle()
        info = p.reinitialize_cuda_engine({"array_size": 512, "string_iterations": 8})
        log(f"   reinit done: {info}; now array_size={p.mp.array_size} "
            f"string_iter={p.mp.string_iteration}")
        assert p.mp.array_size == 512 and p.mp.string_iteration == 8
        # edit must still be on the live model.
        post_to = float(getattr(p.sm.pitches[TEST_PITCH], "tension_offset", 0.0))
        log(f"   edit preserved on model? tension_offset={post_to} -> {abs(post_to-EDIT_TO)<1e-6}")

        # 5. SOUND B — SAME edited note at array_size=512, string_iter=8.
        B = render(p, "B: edited-512-iter8")
        out["renders"]["B_512_iter8"] = True

        # 6. Compare A vs B.
        cmpAB = compare(A, B)
        out["comparisons"]["A_vs_B"] = cmpAB
        log(f"6. A vs B: freq {cmpAB['freq_a']:.2f}->{cmpAB['freq_b']:.2f}Hz "
            f"match={cmpAB['freq_match']} rms_ratio={cmpAB['rms_ratio']:.3f} "
            f"wav_corr={cmpAB['wav_corr']:.4f} spec_corr={cmpAB['spec_corr']:.4f}")

        # ROUND-TRIP: 512 -> back to 384 (string_iter back to 4); must match A.
        log("7. round-trip: in-place re-init back to array_size 384, string_iterations 4")
        settle()
        p.reinitialize_cuda_engine({"array_size": 384, "string_iterations": 4})
        assert p.mp.array_size == 384 and p.mp.string_iteration == 4
        rt_to = float(getattr(p.sm.pitches[TEST_PITCH], "tension_offset", 0.0))
        log(f"   edit preserved after round-trip? tension_offset={rt_to} -> {abs(rt_to-EDIT_TO)<1e-6}")
        C = render(p, "C: edited-384-iter4 (round-trip)")
        cmpAC = compare(A, C)
        out["comparisons"]["A_vs_C_roundtrip"] = cmpAC
        log(f"   A vs C (round-trip): freq {cmpAC['freq_a']:.2f}->{cmpAC['freq_b']:.2f}Hz "
            f"match={cmpAC['freq_match']} rms_ratio={cmpAC['rms_ratio']:.3f} "
            f"wav_corr={cmpAC['wav_corr']:.4f} spec_corr={cmpAC['spec_corr']:.4f}")

        # CFL / stability sanity: redline flag after each re-init.
        cfl_red = False
        try:
            cfl_red = bool(getattr(p.param_manager, "_cfl_redline", False))
        except Exception:
            pass
        out["cfl_redline"] = cfl_red
        log(f"8. CFL redline after re-inits: {cfl_red}")

        try:
            p.pianoid.shutdownGpu()
        except Exception:
            pass

        # ACCEPTANCE: A vs B nearly identical (same fundamental + high correlation),
        # edit preserved, no CFL redline. Round-trip A vs C must be even closer
        # (same resolution -> should be near-exact).
        edit_ok = abs(post_to - EDIT_TO) < 1e-6 and abs(rt_to - EDIT_TO) < 1e-6
        ab_ok = (cmpAB["freq_match"] and cmpAB["spec_corr"] > 0.9
                 and 0.5 < cmpAB["rms_ratio"] < 2.0)
        ac_ok = (cmpAC["freq_match"] and cmpAC["wav_corr"] > 0.95
                 and cmpAC["spec_corr"] > 0.95)
        accept = edit_ok and ab_ok and ac_ok and not cfl_red
        out["edit_ok"] = edit_ok
        out["ab_ok"] = ab_ok
        out["ac_roundtrip_ok"] = ac_ok
        out["verdict"] = "ACCEPT" if accept else "REJECT"
        log(f"\nVERDICT: {out['verdict']} "
            f"(edit_ok={edit_ok} A-vs-B_ok={ab_ok} roundtrip_ok={ac_ok} cfl_red={cfl_red})")
        print("ACCEPT_RESULT_JSON=" + json.dumps(out, default=float), flush=True)
        return 0 if accept else 2
    except Exception as e:
        log(f"ERROR: {type(e).__name__}: {e}")
        traceback.print_exc()
        out["verdict"] = "ERROR"
        out["error"] = f"{type(e).__name__}: {e}"
        print("ACCEPT_RESULT_JSON=" + json.dumps(out, default=float), flush=True)
        return 3


if __name__ == "__main__":
    sys.exit(main())
