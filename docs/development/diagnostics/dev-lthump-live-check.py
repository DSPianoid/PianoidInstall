"""dev-lthump SILENT live check (audio off, offline renders + GETs only) of the thump level coefficients, the
no-thump-on-bowed-keys rule and the mute, against an isolated backend (default :5012).

  python dev-lthump-live-check.py [--base http://127.0.0.1:5012] [--preset <abs path to a *_thump_live preset>]

Thump component of a render = render(thump on) - render(thump off) (renders are deterministic). With level_coeff
p = 0.5 and f = 2, the component at velocity 31 / 95 must scale by 0.5 / 2 against all-1.0.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

import numpy as np

PITCH = 60


def call(base, method, path, body=None, timeout=300):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def thump(base):
    status, body = call(base, "GET", "/get_parameter/thump/all")
    assert status == 200, (status, body)
    return body


def set_thump(base, values):
    return call(base, "POST", "/set_parameter/thump/all", values)


def render(base, velocity):
    status, body = call(base, "POST", "/get_chart_test", {"chartType": "note_playback", "pitch": PITCH,
                                                          "velocity": velocity, "duration_ms": 400,
                                                          "display_length_ms": 400})
    assert status == 200 and body.get("data"), (status, str(body)[:300])
    # the raw engine sound of channel 0 (the WAV in audio_data is peak-normalised: not a level measurement)
    return np.asarray(body["data"][0], dtype=np.float64)


def rms(x):
    return float(np.sqrt(np.mean(x * x)))


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:5012")
    ap.add_argument("--preset", required=True)
    a = ap.parse_args()
    base = a.base
    results = []

    # the preset's required_load_params: si 16, listen_to_modes 0, derivative order 1, array 512
    status, body = call(base, "POST", "/load_preset", {
        "path": a.preset, "listen_to_midi": 0, "audio_on": 0, "start_right_away": 0, "audio_driver_type": 0,
        "cycle_iterations": 64, "audio_buffer_size": 4, "array_size": 512, "sample_rate": 48,
        "string_iterations": 16, "volume": 100, "listen_to_modes": 0, "sound_derivative_order": 1,
        "use_cuda": 1}, timeout=600)
    results.append(check("load_preset", status == 200, f"{status} {str(body)[:120]}"))
    status, lib = call(base, "GET", "/preset/list")
    active = lib.get("active")
    kind = next((p.get("kind") for p in lib.get("presets", []) if p.get("name") == active), None)
    if kind != "working":
        status, sp = call(base, "POST", "/preset/spawn_working_copy", {"source": active})
        name = sp.get("name")
        status, lib = call(base, "GET", "/preset/list")
        if lib.get("active") != name:
            call(base, "POST", "/preset/switch", {"name": name}, timeout=600)
    status, lib = call(base, "GET", "/preset/list")
    print("active preset:", lib.get("active"))

    t = thump(base)
    cfg = t["config"]
    set_thump(base, {"level_coeff": [1, 1, 1, 1, 1], "gain": 1.0})
    cfg = thump(base)["config"]
    results.append(check("thump available, level_coeff readable", t["available"] and cfg["level_coeff"] == [1.0] * 5,
                         json.dumps(cfg)))
    if not cfg["enabled"]:
        set_thump(base, {"enabled": True})
    pool = thump(base)["engine_pool"]
    results.append(check("enabled -> engine pool non-empty", bool(pool), str(pool)))

    # 1. level coefficients: thump component at v31 (p) and v95 (f)
    comp = {}
    for label, lc in (("ones", [1, 1, 1, 1, 1]), ("p0.5_f2", [1, 0.5, 1, 2, 1])):
        print(set_thump(base, {"level_coeff": lc}))
        set_thump(base, {"enabled": False})
        off = {v: render(base, v) for v in (31, 95)}
        set_thump(base, {"enabled": True})
        on = {v: render(base, v) for v in (31, 95)}
        comp[label] = {v: rms(on[v] - off[v]) for v in (31, 95)}
        print(label, "thump component rms", comp[label], "total rms on", {v: rms(on[v]) for v in on})
    r31 = comp["p0.5_f2"][31] / comp["ones"][31]
    r95 = comp["p0.5_f2"][95] / comp["ones"][95]
    results.append(check("v31 thump x0.5", abs(r31 - 0.5) < 0.02, f"ratio {r31:.4f}"))
    results.append(check("v95 thump x2", abs(r95 - 2.0) < 0.04, f"ratio {r95:.4f}"))
    results.append(check("thump audible in the render", comp["ones"][95] > 0, f"{comp['ones'][95]:.3g}"))

    # 2. refused value: 400, nothing changes
    before = thump(base)["config"]["level_coeff"]
    status, body = set_thump(base, {"level_coeff": [11, 1, 1, 1, 1]})
    after = thump(base)["config"]["level_coeff"]
    results.append(check("level_coeff 11 refused, unchanged", 400 <= status < 500 and after == before,
                         f"{status} {str(body)[:160]} -> {after}"))

    # 3. bowed key: effective gain 0, stored trim kept; back to hammer restores
    set_thump(base, {"trim_db": {str(PITCH): -6.0}})
    call(base, "POST", "/set_excitation_mode", {"pitch": PITCH, "mode": "bow"})
    t = thump(base)
    g = t["engine_key_gains"]
    results.append(check("bowed key: engine gain 0, others kept, stored trim kept",
                         g[PITCH] == 0.0 and g[PITCH + 1] > 0 and t["bowed_keys"] == [PITCH]
                         and t["config"]["trim_db"].get(str(PITCH)) == -6.0,
                         f"gain60={g[PITCH]} gain61={g[PITCH + 1]} bowed={t['bowed_keys']} trim={t['config']['trim_db']}"))
    call(base, "POST", "/set_excitation_mode", {"pitch": PITCH, "mode": "hammer"})
    g = thump(base)["engine_key_gains"]
    results.append(check("back to hammer: gain = gain x 10^(-6/20)",
                         abs(g[PITCH] - 10 ** (-6 / 20) * cfg["gain"]) < 1e-6, f"gain60={g[PITCH]}"))
    set_thump(base, {"trim_db": {str(PITCH): 0}})

    # 4. mute keeps the values
    set_thump(base, {"enabled": False})
    t = thump(base)
    results.append(check("mute: pool empty, level_coeff kept", t["engine_pool"] == []
                         and t["config"]["level_coeff"] == [1.0, 0.5, 1.0, 2.0, 1.0], str(t["engine_pool"])))
    set_thump(base, {"enabled": True})
    t = thump(base)
    results.append(check("unmute: pool back", bool(t["engine_pool"]), str(t["engine_pool"])))

    print("ALL PASS" if all(results) else "SOME FAILED")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
