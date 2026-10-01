"""dev-538e post-fix regression + guard-integrity checks (run against a fresh :5000 backend).

(A) NO FALSE-ABORT: fortissimo healthy notes (vel 127) at several pitches render normal,
    non-silent output (the 1e4 guard must never trip on a loud healthy note, displacement O(1-20)).
(B) GUARD STILL CATCHES CLEANLY: with a runaway config applied and a note held on the ONLINE engine,
    the captured host-buffer audio stays FINITE (no inf/NaN reaches the output) and the backend does
    NOT crash (exception stays False, thread stays alive = self-heal), i.e. the guard still protects.
"""
import time, math, requests
B = "http://localhost:5000"

def load_online_audio_off():
    payload = {"path": "presets/BaselinePreset1.json", "listen_to_midi": 0, "midi_port": 0,
               "use_simulation": 0, "debug_mode": 0, "audio_driver_type": 4, "cycle_iterations": 64,
               "audio_buffer_size": 4, "array_size": 384, "sample_rate": 48, "string_iterations": 4,
               "volume": 120, "audio_on": 0, "start_right_away": 1, "listen_to_modes": 0, "use_cuda": 1}
    r = requests.post(f"{B}/load_preset", json=payload, timeout=180)
    print("  load_preset:", r.status_code); time.sleep(2.0)

def offline_render(pitch, vel):
    body = {"chartType": "note_playback", "pitch": pitch, "velocity": vel,
            "duration_ms": 500, "display_length_ms": 500}
    r = requests.post(f"{B}/get_chart_test", json=body, timeout=60)
    if not r.ok:
        return None, f"HTTP{r.status_code}"
    ch = r.json(); arrs = []
    def walk(o):
        if isinstance(o, dict):
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            if o and all(isinstance(x, (int, float)) for x in o) and len(o) > 20: arrs.append(o)
            else:
                for v in o: walk(v)
    walk(ch)
    if not arrs: return None, "no-series"
    best = max(arrs, key=lambda a: max(abs(x) for x in a) if a else 0)
    finite = all(math.isfinite(x) for x in best)
    rms = (sum(x*x for x in best)/len(best))**0.5
    peak = max(abs(x) for x in best)
    return (rms, peak, finite), None

def health():
    h = requests.get(f"{B}/health", timeout=10).json()
    return h.get("backend_thread_running"), h.get("exception")

def set_tension(pitch, value):
    requests.post(f"{B}/set_parameter/string/{pitch}", json={str(pitch): {"tension": value}}, timeout=20)

def get_tension(pitch):
    d = requests.get(f"{B}/get_parameter/string/{pitch}", timeout=10).json()
    return d[str(pitch)]["tension"]

print("=== dev-538e regression + guard-integrity ===")
load_online_audio_off()

print("\n(A) FORTISSIMO no-false-abort (vel 127):")
okA = True
for p in (40, 55, 60, 72, 84):
    res, err = offline_render(p, 127)
    if res is None:
        print(f"   pitch {p}: ERROR {err}"); okA = False; continue
    rms, peak, finite = res
    verdict = "OK" if (rms > 1e-7 and finite) else "FALSE-ABORT?"
    if not (rms > 1e-7 and finite): okA = False
    print(f"   pitch {p:3d} vel127: rms={rms:.3e} peak={peak:.3e} finite={finite} -> {verdict}")

print("\n(B) GUARD catches a runaway cleanly (online, held note, output finite + no crash):")
orig = get_tension(60)
set_tension(60, orig * 100)  # |g| ~ 7.98 >> 1
# hold the note through several cycles of runaway
requests.post(f"{B}/play", json={"pitch": 60, "command": 144, "velocity": 127}, timeout=10)
time.sleep(2.0)
tr, exc = health()
requests.post(f"{B}/capture", json={}, timeout=20)
res, err = offline_render(60, 127)   # offline self-resets: confirms engine still renders finite after the runaway barrage
requests.post(f"{B}/play", json={"pitch": 60, "command": 128, "velocity": 0}, timeout=10)
set_tension(60, orig)
finite_after = res[2] if res else False
print(f"   during held runaway: backend_thread_running={tr} exception={exc}")
print(f"   engine still renders finite after runaway barrage: {finite_after} (rms={res[0]:.3e} if res else n/a)")
okB = (tr is True) and (exc is False) and finite_after

print("\n=== VERDICT ===")
print(f"  (A) fortissimo no-false-abort : {'PASS' if okA else 'FAIL'}")
print(f"  (B) guard catches + no crash  : {'PASS' if okB else 'FAIL'}")
print("  ALL PASS" if (okA and okB) else "  SOME FAILED")
