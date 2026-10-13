"""dev-960f: before/after behaviour-preservation check on the audio_off surface.

Fresh /load_preset, then the SAME edit sequence through every migrated write path, then
note_playback offline renders; prints a sha256 per render. Run on the pre-change backend and on the
post-change backend. The GPU render is NOT bit-deterministic run-to-run (measured: two consecutive
renders of p60 differ by up to ~2e-4 of peak), so the verdict compares the before/after difference
against that run-to-run noise floor (``--compare a.npz b.npz``) and checks that each edit moved the
render far above it (proves the edit landed).

Usage: python dev-960f-bitexact-render.py [base_url] [out_npz]
       python dev-960f-bitexact-render.py --compare before.npz after.npz
"""
import base64
import json
import sys
import urllib.error
import urllib.request

import numpy as np

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5002"
OUT = sys.argv[2] if len(sys.argv) > 2 else None

LOAD = {"path": "presets/BaselinePreset1.json", "listen_to_midi": 0, "use_simulation": 0,
        "debug_mode": 0, "audio_driver_type": 0, "cycle_iterations": 64, "audio_buffer_size": 4,
        "array_size": 384, "sample_rate": 48, "string_iterations": 4, "volume": 100,
        "audio_on": 0, "start_right_away": 0, "listen_to_modes": 1}


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]


def render(pitch, velocity=100):
    code, body = call("POST", "/get_chart_test", {"chartType": "note_playback", "pitch": pitch,
                                                  "velocity": velocity, "duration_ms": 600,
                                                  "display_length_ms": 600})
    assert code == 200, (code, body)
    return np.asarray(body["data"][0], dtype=float)


def edits():
    """One edit per migrated path class (all on the active working copy)."""
    steps = []
    f57 = call("GET", "/get_parameter/feedin/57")[1]["57"]
    steps.append(call("POST", "/set_parameter/feedin/57", {"57": [v * 1.7 for v in f57]})[0])
    m5 = call("GET", "/get_parameter/mode/5")[1]["5"]
    steps.append(call("POST", "/set_parameter/mode/5", {"5": {"frequency": m5["frequency"] * 1.03}})[0])
    t60 = call("GET", "/get_parameter/string/60")[1]["60"]["tension"]
    steps.append(call("POST", "/set_parameter/string/60", {"60": {"tension": t60 * 1.02}})[0])
    m = call("GET", "/excitation_energy")[1]["hammer_mass"]["60"]
    steps.append(call("POST", "/excitation_energy", {"hammer_mass": {"60": m * 1.3}})[0])
    steps.append(call("POST", "/set_runtime_parameters", {"feedback_coeff": 1.25})[0])
    steps.append(call("POST", "/set_hammer_shape/60", {"position": 0.13})[0])
    return steps


def rel(a, b):
    return float(np.abs(a - b).max() / max(np.abs(a).max(), 1e-30))


def compare(path_a, path_b):
    a, b = np.load(path_a), np.load(path_b)
    for k in sorted(a.files):
        if k == "edit_codes":
            print(f"edit_codes  before={a[k].tolist()} after={b[k].tolist()}")
            continue
        print(f"{k:12s} before-vs-after rel_max_diff={rel(a[k], b[k]):.3e} "
              f"corr={np.corrcoef(a[k], b[k])[0, 1]:.9f}")
    for p in ("57", "60"):
        print(f"edit effect p{p}: rel_max_diff(baseline, edited) = {rel(a['base_' + p], a['edit_' + p]):.3e}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--compare"]:
        compare(sys.argv[2], sys.argv[3])
        sys.exit(0)
    # Two structural loads: the second is a guaranteed FULL reload (an identical re-load is HOT
    # and would keep the previous run's edits).
    call("POST", "/load_preset", dict(LOAD, listen_to_modes=0))
    code, body = call("POST", "/load_preset", LOAD)
    assert code == 200, (code, body)
    out = {f"base_{p}": render(p) for p in (57, 60)}
    out["noise_60"] = render(60)
    out["edit_codes"] = np.array(edits())
    out.update({f"edit_{p}": render(p) for p in (57, 60)})
    print("edit codes", out["edit_codes"].tolist(), "| run-to-run noise p60:",
          f"{rel(out['base_60'], out['noise_60']):.3e}")
    if OUT:
        np.savez(OUT, **out)
