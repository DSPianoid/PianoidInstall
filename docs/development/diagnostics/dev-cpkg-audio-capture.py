"""dev-cpkg: reusable offline-render audio-noise-floor capture + compare tool.

PURPOSE: characterize the run-to-run noise floor of DEFAULT-HAMMER note synthesis via the
deterministic OFFLINE render surface (POST /get_chart_test, chartType=note_playback), so a
later code/binary change can be judged "within noise" or "a real regression" against a
PRE-change baseline. Read-only against the live backend — never touches mic/ASIO, never
calls /load_preset, /reset, /shutdown, or any mutating endpoint.

SURFACE (per docs/modules/pianoid-middleware/REST_API.md + CHART_SYSTEM.md):
  POST /get_chart_test {"chartType": "note_playback", "pitch": P, "velocity": V,
                         "duration_ms": D, "display_length_ms": D}
  -> play_note_offline_chart_function (strict-A1 audio_off determinism, NOT fix-velocity-clamped,
     no mic/ASIO engagement). Response "data": [[float samples...]] is the RAW (unnormalized)
     per-sample synthesis output — matches text_fields "Generated Sound Max"/"RMS" exactly
     (confirmed by probe: data max abs == text_fields Generated Sound Max). "audio_data" is a
     base64 WAV (16-bit quantized) attached for playback — data[0] is the higher-precision source,
     used here instead.

USAGE (PianoidCore venv):
  D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe dev-cpkg-audio-capture.py \
      --label before --n 5
  ... (after a rebuild) ...
  D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe dev-cpkg-audio-capture.py \
      --label after --n 5
  D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python.exe dev-cpkg-audio-capture.py \
      --compare before after

Outputs land under --outdir (default: this session's scratchpad, see SCRATCHPAD_DEFAULT below) —
one .npy per render (raw float64 samples) plus one {label}_summary.json with per-render metrics,
the exact request payload, and the preset/health info read at capture time.
"""
import argparse
import json
import time
import urllib.request
import os

import numpy as np

BASE_URL_DEFAULT = "http://127.0.0.1:5000"
SCRATCHPAD_DEFAULT = (
    r"C:\Users\astri\AppData\Local\Temp\claude\D--repos-PianoidInstall"
    r"\4736eaaf-d247-4015-baef-33e5edae4eb1\scratchpad"
)

# Default-hammer, middle-pitch, deterministic single-note render.
DEFAULT_PITCH = 60
DEFAULT_VELOCITY = 127
DEFAULT_DURATION_MS = 600


def _get(base_url, path, timeout=30):
    with urllib.request.urlopen(base_url + path, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def _post(base_url, path, payload, timeout=60):
    req = urllib.request.Request(
        base_url + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def health_and_preset(base_url):
    """Read-only pre-flight: confirm healthy + note the loaded preset. Never mutates state."""
    hst, hd = _get(base_url, "/health")
    pst, pd = _get(base_url, "/preset/list")
    return {
        "health_status": hst,
        "pianoid_loaded": hd.get("pianoid_loaded"),
        "status": hd.get("status"),
        "message": hd.get("message"),
        "active_preset": pd.get("active"),
        "preset_status": pst,
    }


def dominant_freq(samples, sample_rate):
    """Coarse magnitude-spectrum peak bin -> dominant frequency (Hz). DC bin excluded."""
    n = len(samples)
    if n < 2:
        return 0.0
    spec = np.abs(np.fft.rfft(samples))
    if len(spec) < 2:
        return 0.0
    spec[0] = 0.0  # exclude DC
    peak_bin = int(np.argmax(spec))
    return peak_bin * sample_rate / n


def render_once(base_url, pitch, velocity, duration_ms):
    payload = {
        "chartType": "note_playback",
        "pitch": pitch,
        "velocity": velocity,
        "duration_ms": duration_ms,
        "display_length_ms": duration_ms,
    }
    t0 = time.time()
    status, resp = _post(base_url, "/get_chart_test", payload)
    elapsed = time.time() - t0
    if status != 200:
        raise RuntimeError(f"/get_chart_test returned {status}: {json.dumps(resp)[:400]}")
    data = resp.get("data")
    if not data or not data[0]:
        raise RuntimeError(f"No 'data' in response: {json.dumps(resp)[:400]}")
    samples = np.asarray(data[0], dtype=np.float64)
    tf = resp.get("text_fields", {})
    sr_field = tf.get("Sample Rate", "48000 Hz")
    try:
        sample_rate = float(str(sr_field).split()[0])
    except Exception:
        sample_rate = 48000.0
    return samples, sample_rate, tf, elapsed, payload


def metrics_for(samples, sample_rate):
    peak_abs = float(np.max(np.abs(samples))) if samples.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
    dom_freq = dominant_freq(samples, sample_rate)
    return {
        "sample_count": int(samples.size),
        "peak_abs": peak_abs,
        "rms": rms,
        "dominant_freq_hz": dom_freq,
    }


def capture(args):
    os.makedirs(args.outdir, exist_ok=True)

    hp = health_and_preset(args.base_url)
    print(f"# /health: status={hp['health_status']} pianoid_loaded={hp['pianoid_loaded']} "
          f"engine_status={hp['status']}")
    print(f"# active preset: {hp['active_preset']}")
    if not hp["pianoid_loaded"]:
        raise SystemExit("ABORT: backend not loaded (pianoid_loaded=false). Not touching the stack "
                          "(read-only tool) — bring the preset up yourself first.")

    rows = []
    saved_paths = []
    for i in range(args.n):
        samples, sample_rate, tf, elapsed, payload = render_once(
            args.base_url, args.pitch, args.velocity, args.duration_ms
        )
        m = metrics_for(samples, sample_rate)
        m["render_index"] = i
        m["sample_rate"] = sample_rate
        m["processing_time_s"] = elapsed
        m["engine_reported_max"] = tf.get("Generated Sound Max")
        m["engine_reported_rms"] = tf.get("Generated Sound RMS")
        rows.append(m)

        out_path = os.path.join(args.outdir, f"dev-cpkg-audio-capture_{args.label}_render{i}.npy")
        np.save(out_path, samples)
        saved_paths.append(out_path)
        print(f"  render {i}: n={m['sample_count']} peak_abs={m['peak_abs']:.6e} "
              f"rms={m['rms']:.6e} dom_freq={m['dominant_freq_hz']:.2f}Hz "
              f"({elapsed:.2f}s)  -> {out_path}")

    # Cross-render noise band.
    def band(key):
        vals = [r[key] for r in rows]
        return {"min": min(vals), "max": max(vals), "mean": sum(vals) / len(vals)}

    summary = {
        "label": args.label,
        "base_url": args.base_url,
        "request_payload_template": {
            "chartType": "note_playback",
            "pitch": args.pitch,
            "velocity": args.velocity,
            "duration_ms": args.duration_ms,
            "display_length_ms": args.duration_ms,
        },
        "health_preset": hp,
        "n_renders": args.n,
        "renders": rows,
        "noise_band": {
            "peak_abs": band("peak_abs"),
            "rms": band("rms"),
            "dominant_freq_hz": band("dominant_freq_hz"),
        },
        "npy_paths": saved_paths,
        "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    summary_path = os.path.join(args.outdir, f"dev-cpkg-audio-capture_{args.label}_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\n# noise band across N={args.n} '{args.label}' renders "
          f"(pitch={args.pitch} vel={args.velocity} dur={args.duration_ms}ms):")
    print(f"  peak_abs        : min={summary['noise_band']['peak_abs']['min']:.6e}  "
          f"mean={summary['noise_band']['peak_abs']['mean']:.6e}  "
          f"max={summary['noise_band']['peak_abs']['max']:.6e}")
    print(f"  rms             : min={summary['noise_band']['rms']['min']:.6e}  "
          f"mean={summary['noise_band']['rms']['mean']:.6e}  "
          f"max={summary['noise_band']['rms']['max']:.6e}")
    print(f"  dominant_freq_hz: min={summary['noise_band']['dominant_freq_hz']['min']:.2f}  "
          f"mean={summary['noise_band']['dominant_freq_hz']['mean']:.2f}  "
          f"max={summary['noise_band']['dominant_freq_hz']['max']:.2f}")
    print(f"\n# summary saved: {summary_path}")


def compare(args):
    path_a = os.path.join(args.outdir, f"dev-cpkg-audio-capture_{args.compare[0]}_summary.json")
    path_b = os.path.join(args.outdir, f"dev-cpkg-audio-capture_{args.compare[1]}_summary.json")
    with open(path_a) as f:
        a = json.load(f)
    with open(path_b) as f:
        b = json.load(f)

    print(f"# comparing '{a['label']}' (N={a['n_renders']}) vs '{b['label']}' (N={b['n_renders']})")
    for key in ("peak_abs", "rms", "dominant_freq_hz"):
        ba, bb = a["noise_band"][key], b["noise_band"][key]
        overlap = not (bb["max"] < ba["min"] or ba["max"] < bb["min"])
        verdict = "WITHIN NOISE (bands overlap)" if overlap else "OUTSIDE NOISE (bands disjoint)"
        print(f"  {key}:")
        print(f"    {a['label']:>8}: min={ba['min']:.6e} mean={ba['mean']:.6e} max={ba['max']:.6e}")
        print(f"    {b['label']:>8}: min={bb['min']:.6e} mean={bb['mean']:.6e} max={bb['max']:.6e}")
        print(f"    -> {verdict}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--label", default=None, help="capture-run label, e.g. 'before'/'after'")
    ap.add_argument("--n", type=int, default=5, help="number of renders (default 5)")
    ap.add_argument("--pitch", type=int, default=DEFAULT_PITCH)
    ap.add_argument("--velocity", type=int, default=DEFAULT_VELOCITY)
    ap.add_argument("--duration-ms", type=int, default=DEFAULT_DURATION_MS, dest="duration_ms")
    ap.add_argument("--base-url", default=BASE_URL_DEFAULT, dest="base_url")
    ap.add_argument("--outdir", default=SCRATCHPAD_DEFAULT)
    ap.add_argument("--compare", nargs=2, metavar=("LABEL_A", "LABEL_B"), default=None,
                     help="compare two previously-saved labels' summaries instead of capturing")
    args = ap.parse_args()

    if args.compare:
        compare(args)
        return

    if not args.label:
        raise SystemExit("--label is required for a capture run (e.g. --label before)")
    capture(args)


if __name__ == "__main__":
    main()
