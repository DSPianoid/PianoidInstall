"""
dev-3a08 — LIVE realtime-engine reproduction of the length->dx regression (a558cb3).

Drives the EXACT frontend granular path against the running online engine over HTTP:
  GET  /get_parameter/string/all     -- read what the UI displays for `length`
  POST /set_parameter/string/<pitch> -- the granular edit endpoint the UI POSTs to
  POST /load_preset                  -- reload to a clean engine between sub-tests
  POST /get_chart_test               -- deterministic note_playback render, state
                                        read FROM the live online engine

Each sub-test reloads the preset first so it starts from a known-clean engine.
Verdict keys on BOTH rms ratio and spectral flatness (a558cb3 noise shows as a
large persistent rms swing, not necessarily high flatness).
"""
import sys, json, base64, io, wave, urllib.request, time

BASE = "http://127.0.0.1:5000"
PRELOAD = {
    "path": "presets/Preset_test5.json", "listen_to_midi": 0, "midi_port": 0,
    "use_simulation": 0, "debug_mode": 0, "audio_driver_type": 0,
    "cycle_iterations": 64, "audio_buffer_size": 4, "array_size": 384,
    "sample_rate": 48, "string_iterations": 4, "volume": 120, "audio_on": 1,
    "start_right_away": 1, "listen_to_modes": 1, "use_cuda": 1,
}


def _post(path, body, timeout=120):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _get(path, timeout=60):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def reload_engine():
    _post("/load_preset", PRELOAD, timeout=120)
    for _ in range(20):
        h = _get("/health")
        if h.get("status") == "healthy" and h["lifecycle"]["audio_driver_active"]:
            return True
        time.sleep(0.5)
    return False


def measure(pitch, vel=110, dur=600):
    resp = _post("/get_chart_test", {
        "chartType": "note_playback", "pitch": pitch, "velocity": vel,
        "duration_ms": dur, "display_length_ms": dur,
    })
    b64 = (resp.get("audio_data") or [None])[0]
    if not b64:
        return None
    raw = base64.b64decode(b64)
    with wave.open(io.BytesIO(raw), "rb") as w:
        n, sw = w.getnframes(), w.getsampwidth()
        frames = w.readframes(n)
    import numpy as np
    if sw == 2:
        a = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    else:
        a = np.frombuffer(frames, dtype=np.float32).astype(np.float64)
    if a.size == 0:
        return dict(peak=0, rms=0, flat=0, nan=0, n=0)
    nan = int(np.count_nonzero(~np.isfinite(a)))
    fin = a[np.isfinite(a)]
    peak = float(np.max(np.abs(fin))) if fin.size else 0.0
    rms = float(np.sqrt(np.mean(fin**2))) if fin.size else 0.0
    mag = np.abs(np.fft.rfft(fin)) + 1e-12
    flat = float(np.exp(np.mean(np.log(mag))) / np.mean(mag))
    return dict(peak=peak, rms=rms, flat=flat, nan=nan, n=int(a.size))


def run_one(pitch, safe=64):
    """One clean sub-test for `pitch`. Returns a result dict."""
    assert reload_engine(), "engine did not come up clean"

    strings = _get("/get_parameter/string/all")
    ui_len = strings[str(pitch)]["length"]

    base_p = measure(pitch)
    base_s = measure(safe)

    # THE EDIT: the UI takes the displayed value (a block count) and the user
    # nudges it. Replay a -5% nudge of the displayed number, exactly as the UI
    # POSTs it.
    new_val = round(ui_len * 0.95, 4)
    _post(f"/set_parameter/string/{pitch}", {str(pitch): {"length": new_val}})
    edit_p = measure(pitch)
    edit_s = measure(safe)

    # RESTORE: user types the original displayed value back.
    _post(f"/set_parameter/string/{pitch}", {str(pitch): {"length": ui_len}})
    rest_p = measure(pitch)
    rest_s = measure(safe)

    return dict(pitch=pitch, ui_len=ui_len, new_val=new_val,
                base_p=base_p, base_s=base_s, edit_p=edit_p, edit_s=edit_s,
                rest_p=rest_p, rest_s=rest_s)


def verdict(label, base, after):
    """Flag noise: NaN present, OR rms swung >3x, OR flatness >3x + 0.05."""
    nan = after["nan"] > 0
    rms_swing = (after["rms"] > base["rms"] * 3) or (base["rms"] > after["rms"] * 3 + 1e-6)
    flat = after["flat"] > base["flat"] * 3 + 0.05
    bad = nan or rms_swing or flat
    print(f"  {label}: rms {base['rms']:.5f}->{after['rms']:.5f}  "
          f"flat {base['flat']:.4f}->{after['flat']:.4f}  nan={after['nan']}  "
          f"=> {'DISTURBED' if bad else 'ok'}")
    return bad


def main():
    pitches = [int(x) for x in sys.argv[1:]] or [96, 57, 40]
    print("LIVE length->dx regression reproduction (online realtime engine)")
    print("Each pitch: fresh preset reload -> baseline -> UI length edit -> "
          "restore.\n")

    any_broke = any_persist = False
    for p in pitches:
        print(f"===== pitch {p} =====")
        r = run_one(p)
        print(f"  UI-displayed length = {r['ui_len']}  (edit nudge -> {r['new_val']})")
        print(f"  -- after EDIT --")
        b1 = verdict(f"edited pitch {p}", r["base_p"], r["edit_p"])
        b2 = verdict(f"safe  pitch 64 ", r["base_s"], r["edit_s"])
        print(f"  -- after RESTORE --")
        b3 = verdict(f"edited pitch {p}", r["base_p"], r["rest_p"])
        b4 = verdict(f"safe  pitch 64 ", r["base_s"], r["rest_s"])
        broke = b1 or b2
        persist = b3 or b4
        any_broke |= broke
        any_persist |= persist
        print(f"  PITCH {p}: edit produced disturbance={broke}  "
              f"persisted after restore={persist}\n")

    print("===== OVERALL =====")
    print(f"any pitch disturbed by a length edit:        {any_broke}")
    print(f"disturbance persisted after length restore:  {any_persist}")


if __name__ == "__main__":
    main()
