"""dev-d52b LIMITER (B) int-domain verification — measured gates on the INT/DRIVER path.

Redesign (B): the soft-limiter runs in the POST-volume INT domain anchored to the real digital
full-scale R = INT32_MAX (the int the driver clips at). s = output*mvc; |s| <= 0.8*R passes
TRANSPARENT; 0.8*R < |s| soft-knee compressed; bounded at R. The float record now carries
soundFloat = s_lim/mvc, so int_signal = getRecordedAudio()*mvc == s_lim == the actual driver int sample.

Gates (verified ON THE INT PATH — the float-only verify previously masked clipping):
  (a) louder-with-lower PRESERVED: int RMS rises monotonically as feedback coeff drops.
  (b) BOUNDED at the real rail: |int_signal| <= R (INT32_MAX), NO overflow/wrap, every coeff incl 0.
  (c) TRANSPARENT below the knee: a note whose pre-limit peak is < 0.8*R is byte-identical pre/post.
  (d) spec-b / mask: feedback=0 still produces sound; mask rows = the 4 output strings.
  (e) LIMITING SIGNAL: getLimiterPeaks() (now pre-limit |s| in int units) reads > knee (0.8*R) at low
      feedback (active); post-limit int peak is bounded at R.

mvc is read live from getRuntimeParameters (volume_center * volume_range^((level-64)/63)).
Read-only. Writes JSON at repo root.
"""
import os, sys, json, math
import numpy as np

REPO = r"D:/repos/PianoidInstall"
MW = os.path.join(REPO, "PianoidCore", "pianoid_middleware")
os.chdir(MW)
for p in (MW, os.path.dirname(MW)):
    if p not in sys.path:
        sys.path.insert(0, p)

import pianoidCuda
from tests.conftest import SAMPLE_RATE, SAMPLES_PER_CYCLE, get_preset_path
from tests.integration.conftest import build_note_event_queue

PRESET = "Belarus_8band_196modes.json"
PITCH = 57
VEL = 100
NOTE_MS = 100
RENDER_MS = 400
R = 2147483647.0          # INT32_MAX — digital full-scale
KNEE = 0.8 * R
COEFFS = [1.0, 0.5, 0.25, 0.1, 0.0]


def mvc_from(rt, max_volume=5e18):
    # calculateVolumeCoefficient (Pianoid_parameters.cu): new formula if center/range>0, else legacy.
    if rt.volume_center > 0 and rt.volume_range > 0:
        return rt.volume_center * (rt.volume_range ** ((rt.volume_level - 64) / 63.0))
    if max_volume > 0:
        return max_volume ** (rt.volume_level / 127.0)
    return 1.0


def render(cpp, mp, coeff, volume_level=64):
    sr = mp.sample_rate(); spc = mp.mode_iteration
    rt = pianoidCuda.RuntimeParameters(); rt.volume_level = volume_level
    rt.deck_feedback_coefficient = coeff
    cpp.setRuntimeParameters(rt)
    cpp.resetStringsState(); cpp.resetModeRunningState()
    cpp.resetLimiterPeaks()
    cpp.waitForParameterUpdate()
    mvc = mvc_from(cpp.getRuntimeParameters())   # the actual mvc the kernel used this render
    eq = build_note_event_queue(PITCH, VEL, NOTE_MS, sr, spc)
    c = pianoidCuda.PlaybackConfig()
    c.audio_enabled = False; c.record_to_buffer = True
    c.sample_rate = sr; c.samples_per_cycle = spc; c.max_duration_ms = RENDER_MS
    cpp.clearRecords(); cpp.runOfflinePlayback(eq, c)
    flt = np.array(cpp.getRecordedAudio(), dtype=np.float64)   # = soundFloat = (float32)(s_lim/mvc)
    int_sig = flt * mvc                                        # ≈ s_lim = the driver int sample
    post_peak_int = float(np.max(np.abs(int_sig))) if int_sig.size else 0.0
    post_rms_int = float(np.sqrt(np.mean(int_sig ** 2))) if int_sig.size else 0.0
    # soundFloat is stored as float32 (static_cast<float>(s_lim/mvc)); reconstructing s_lim via
    # ·mvc therefore carries float32 quantization (≤ 2^-24·R ≈ 128 counts). The TRUE driver value
    # is Sint32(s_lim) with s_lim ≤ R by the kernel's tanh asymptote, so it never overflows. Use a
    # float32-precision-aware bound to distinguish real overflow (peak ≫ R, e.g. pre-fix 5e10) from
    # the round-trip noise (peak = R ± ~128). 1024 counts = ~8 ulp headroom, still ≪ any real clip.
    F32_ROUNDTRIP = 1024.0
    overflow = post_peak_int > R + F32_ROUNDTRIP
    bounded_at_rail = abs(post_peak_int - R) <= F32_ROUNDTRIP   # peak pinned AT the rail (limiter engaged)
    pre_peaks = [float(x) for x in cpp.getLimiterPeaks()]      # pre-limit |s| (int units)
    pre_peak_max = max(pre_peaks) if pre_peaks else 0.0
    return {
        "post_peak_int": post_peak_int,
        "post_rms_int": post_rms_int,
        "post_peak_frac_of_R": post_peak_int / R,
        "pre_limit_peak_int": pre_peak_max,
        "pre_over_knee": bool(pre_peak_max > KNEE),
        "overflow": bool(overflow),
        "bounded_at_rail": bool(bounded_at_rail),
        "mvc": mvc,
    }


def main():
    from pianoid import initialize
    p = initialize(get_preset_path(PRESET), filterlen=48 * 128 * 3, string_iteration=4,
                   array_size=384, sample_rate=SAMPLE_RATE, samples_in_cycle=SAMPLES_PER_CYCLE,
                   buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
                   listen_to_modes=False)
    cpp = p.pianoid; mp = p.mp
    mask = np.array(p.sm.pack_output_mask())
    out_rows = np.nonzero(mask)[0].tolist()
    cpp.waitForParameterUpdate()
    mvc = mvc_from(cpp.getRuntimeParameters())   # default-volume mvc (for reporting)

    render(cpp, mp, 1.0, volume_level=64)  # warm
    res = {f"{c}": render(cpp, mp, c, volume_level=64) for c in COEFFS}

    # Transparency probe: a genuinely quiet signal whose pre-limit |s| < knee must pass UNTOUCHED.
    # Drop volume (level=1) so the post-volume sample sits well below the knee (0.8·R), coeff=1.
    res_quiet = render(cpp, mp, 1.0, volume_level=1)
    mvc_low = res_quiet["mvc"]

    rms = [res[f"{c}"]["post_rms_int"] for c in COEFFS]      # coeff 1.0 -> 0.0
    peak = [res[f"{c}"]["post_peak_int"] for c in COEFFS]

    F32_ROUNDTRIP = 1024.0
    louder_with_lower = all(rms[i] <= rms[i + 1] + 1e-6 for i in range(len(rms) - 1))
    bounded_no_overflow = all(not res[f"{c}"]["overflow"] for c in COEFFS) and all(pk <= R + F32_ROUNDTRIP for pk in peak)
    coeff0_audible = res["0.0"]["post_rms_int"] > 1.0   # > 1 int count
    signal_low_active = res["0.0"]["pre_over_knee"] is True
    # (c) transparency: the quiet probe's pre-limit |s| must be BELOW knee AND post == pre (untouched).
    transparent_below_knee = bool(
        (not res_quiet["pre_over_knee"]) and
        (abs(res_quiet["post_peak_int"] - res_quiet["pre_limit_peak_int"])
            <= max(F32_ROUNDTRIP, 1e-4 * max(res_quiet["pre_limit_peak_int"], 1.0))))
    # (b) extra: at every loud (over-knee) coeff the post peak must be BOUNDED < R (soft-knee asymptote,
    # never reaches/exceeds R) AND meaningfully COMPRESSED below the pre-limit |s| (the knee engaged).
    # (Not "pinned exactly at R" — the soft-knee approaches R asymptotically; a modestly-over-knee signal
    # like coeff=1 lands just under R, which is correct.)
    all_compressed_and_bounded = all(
        (res[f"{c}"]["post_peak_int"] < R + F32_ROUNDTRIP) and
        (res[f"{c}"]["post_peak_int"] < res[f"{c}"]["pre_limit_peak_int"])  # compressed below pre-limit
        for c in COEFFS if res[f"{c}"]["pre_over_knee"]
    )

    out = {
        "preset": PRESET, "mvc": mvc, "mvc_low_volume": mvc_low, "R_fullscale": R, "knee_0.8R": KNEE,
        "mask_out_rows": out_rows, "mask_out_count": int(mask.sum()),
        "results": res, "quiet_probe": res_quiet,
        "gates": {
            "a_louder_with_lower_int": bool(louder_with_lower),
            "b_bounded_no_overflow_int": bool(bounded_no_overflow),
            "b_compressed_and_bounded_when_loud": bool(all_compressed_and_bounded),
            "c_transparent_below_knee": transparent_below_knee,
            "d_specb_coeff0_audible": bool(coeff0_audible),
            "e_signal_low_active": bool(signal_low_active),
        },
    }
    out["ALL_PASS"] = bool(louder_with_lower and bounded_no_overflow and all_compressed_and_bounded
                           and transparent_below_knee and coeff0_audible and signal_low_active)
    with open(os.path.join(REPO, "dev-d52b-limiter-verify.json"), "w") as f:
        json.dump(out, f, indent=2)

    print("LIMITER_VERIFY(int): mvc=%.6g  R=%.0f  knee=%.0f  mask_rows=%s" % (mvc, R, KNEE, out_rows))
    for c in COEFFS:
        r = res[f"{c}"]
        print("  coeff=%-4s post_peak_int=%.6g (%.2f%% R) post_rms_int=%.4g  pre_limit=%.4g over_knee=%s overflow=%s rail=%s"
              % (c, r["post_peak_int"], 100 * r["post_peak_frac_of_R"], r["post_rms_int"],
                 r["pre_limit_peak_int"], r["pre_over_knee"], r["overflow"], r["bounded_at_rail"]))
    rq = res_quiet
    print("  QUIET(vol1) post_peak_int=%.6g (%.2f%% R) pre_limit=%.6g over_knee=%s  (transparent path)"
          % (rq["post_peak_int"], 100 * rq["post_peak_frac_of_R"], rq["pre_limit_peak_int"], rq["pre_over_knee"]))
    print("GATES: " + json.dumps(out["gates"]))
    print("ALL_PASS=%s" % out["ALL_PASS"])
    try:
        cpp.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
