"""
dev-3a08 — finely-staged LIVE reproduction. One pitch, one edit, one restore.
A /health probe after EVERY operation so the exact crashing step is identified.
Drives the real frontend granular endpoint POST /set_parameter/string/<pitch>.
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


def health(tag):
    try:
        h = _get("/health", timeout=8)
        lc = h["lifecycle"]
        alive = (h.get("status") == "healthy"
                 and lc.get("main_loop_should_continue"))
        print(f"  [health/{tag}] status={h.get('status')} "
              f"audio={lc.get('audio_driver_active')} "
              f"loop={lc.get('main_loop_should_continue')} "
              f"exception={h.get('exception')} "
              f"=> {'ALIVE' if alive else 'DEGRADED'}")
        return alive
    except Exception as e:
        print(f"  [health/{tag}] BACKEND UNREACHABLE: {type(e).__name__}: {e}")
        return False


def measure(pitch, vel=110, dur=600):
    try:
        resp = _post("/get_chart_test", {
            "chartType": "note_playback", "pitch": pitch, "velocity": vel,
            "duration_ms": dur, "display_length_ms": dur,
        }, timeout=60)
    except Exception as e:
        print(f"  [measure pitch {pitch}] RENDER FAILED: {type(e).__name__}: {e}")
        return None
    b64 = (resp.get("audio_data") or [None])[0]
    if not b64:
        print(f"  [measure pitch {pitch}] no audio in response keys={list(resp)}")
        return None
    raw = base64.b64decode(b64)
    with wave.open(io.BytesIO(raw), "rb") as w:
        sw = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    import numpy as np
    if sw == 2:
        a = np.frombuffer(frames, dtype=np.int16).astype(np.float64) / 32768.0
    else:
        a = np.frombuffer(frames, dtype=np.float32).astype(np.float64)
    nan = int(np.count_nonzero(~np.isfinite(a))) if a.size else 0
    fin = a[np.isfinite(a)] if a.size else a
    peak = float(np.max(np.abs(fin))) if fin.size else 0.0
    rms = float(np.sqrt(np.mean(fin**2))) if fin.size else 0.0
    mag = np.abs(np.fft.rfft(fin)) + 1e-12 if fin.size else np.array([1.0])
    flat = float(np.exp(np.mean(np.log(mag))) / np.mean(mag))
    return dict(peak=peak, rms=rms, flat=flat, nan=nan, n=int(a.size))


def step(label, fn):
    print(f"* {label}")
    return fn()


def main():
    pitch = int(sys.argv[1]) if len(sys.argv) > 1 else 96
    safe = 64
    print(f"=== staged live repro: pitch {pitch}, safe pitch {safe} ===\n")

    step("load preset", lambda: print(f"  {_post('/load_preset', PRELOAD)}"))
    time.sleep(1)
    if not health("post-load"):
        print("ABORT: engine not healthy after load"); return

    strings = step("GET /get_parameter/string/all",
                    lambda: _get("/get_parameter/string/all"))
    ui_len = strings[str(pitch)]["length"]
    print(f"  UI-displayed length for pitch {pitch} = {ui_len}")

    base_p = step(f"baseline render pitch {pitch}", lambda: measure(pitch))
    print(f"  baseline pitch {pitch}: {base_p}")
    health("post-baseline-edited")
    base_s = step(f"baseline render safe pitch {safe}", lambda: measure(safe))
    print(f"  baseline pitch {safe}: {base_s}")
    health("post-baseline-safe")

    new_val = round(ui_len * 0.95, 4)
    step(f"EDIT POST /set_parameter/string/{pitch} length={new_val}",
         lambda: print(f"  {_post(f'/set_parameter/string/{pitch}', {str(pitch): {'length': new_val}})}"))
    crashed_on_edit = not health("post-edit-call")

    edit_p = step(f"render pitch {pitch} after edit", lambda: measure(pitch))
    print(f"  after-edit pitch {pitch}: {edit_p}")
    health("post-edit-render")
    edit_s = step(f"render safe pitch {safe} after edit", lambda: measure(safe))
    print(f"  after-edit pitch {safe}: {edit_s}")
    health("post-edit-safe-render")

    step(f"RESTORE POST /set_parameter/string/{pitch} length={ui_len}",
         lambda: _safe_post(f"/set_parameter/string/{pitch}",
                            {str(pitch): {"length": ui_len}}))
    health("post-restore-call")
    rest_p = step(f"render pitch {pitch} after restore", lambda: measure(pitch))
    print(f"  after-restore pitch {pitch}: {rest_p}")
    rest_s = step(f"render safe pitch {safe} after restore", lambda: measure(safe))
    print(f"  after-restore pitch {safe}: {rest_s}")
    health("final")

    print("\n=== SUMMARY ===")
    print(f"  baseline    edited={base_p}  safe={base_s}")
    print(f"  after edit  edited={edit_p}  safe={edit_s}")
    print(f"  after rest  edited={rest_p}  safe={rest_s}")
    print(f"  crashed during edit call: {crashed_on_edit}")


def _safe_post(path, body):
    try:
        print(f"  {_post(path, body)}")
    except Exception as e:
        print(f"  RESTORE FAILED: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
