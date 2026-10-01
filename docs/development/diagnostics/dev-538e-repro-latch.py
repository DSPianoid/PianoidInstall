"""dev-538e amplitude-guard NON-RECOVERY (latch) reproduction / verification harness.

Reproduces the user's bug on the ONLINE engine (audio_off, no ASIO -> agent-safe):
a string runaway trips the in-kernel amplitude guard; BEFORE the fix the synthesis
thread dies (OnlinePlaybackEngine.cu:185) and Reset cannot recover it (only a full
backend restart does). AFTER the fix the kernel self-heals on a trip: the thread
stays alive and sound returns with no restart.

Primary measured signal: /health backend_thread_running (thread alive vs dead).
Sound signal: offline note_playback render RMS (deterministic, self-resetting surface).

Usage: python dev-538e-repro-latch.py   (run against a fresh backend on :5000)
"""
import sys, time, json, statistics
import requests

B = "http://localhost:5000"
PITCH = 60
RUNAWAY_MULT = 100.0

def health():
    try:
        h = requests.get(f"{B}/health", timeout=10).json()
        return h.get("backend_thread_running"), h.get("exception")
    except Exception as e:
        return f"ERR:{e}", None

def load_online_audio_off():
    payload = {
        "path": "presets/BaselinePreset1.json",
        "listen_to_midi": 0, "midi_port": 0, "use_simulation": 0, "debug_mode": 0,
        "audio_driver_type": 4, "cycle_iterations": 64, "audio_buffer_size": 4,
        "array_size": 384, "sample_rate": 48, "string_iterations": 4, "volume": 120,
        "audio_on": 0,            # NO ASIO driver
        "start_right_away": 1,    # ONLINE synthesis thread RUNS (host-buffer)
        "listen_to_modes": 0,     # strings mode: string runaway is on the audio path
        "use_cuda": 1,
    }
    r = requests.post(f"{B}/load_preset", json=payload, timeout=180)
    print("  load_preset:", r.status_code, r.json() if r.ok else r.text[:200])
    time.sleep(2.0)

def get_tension(pitch):
    r = requests.get(f"{B}/get_parameter/string/{pitch}", timeout=10)
    try:
        d = r.json()
    except Exception:
        return None
    # response shape: {'<pitch>': {'tension': v, ...}}
    if isinstance(d, dict) and str(pitch) in d and isinstance(d[str(pitch)], dict):
        return d[str(pitch)].get("tension")
    if isinstance(d, dict) and "tension" in d:
        return d["tension"]
    return d

def set_tension(pitch, value):
    body = {str(pitch): {"tension": value}}
    r = requests.post(f"{B}/set_parameter/string/{pitch}", json=body, timeout=20)
    return r.status_code, (r.json() if r.ok else r.text[:150])

def reset():
    r = requests.get(f"{B}/reset", timeout=20)
    return r.status_code

def play(pitch, vel=110):
    requests.post(f"{B}/play", json={"pitch": pitch, "command": 144, "velocity": vel}, timeout=10)

def note_off(pitch):
    requests.post(f"{B}/play", json={"pitch": pitch, "command": 128, "velocity": 0}, timeout=10)

def offline_rms(pitch):
    """Offline note_playback render -> RMS of the first output channel waveform."""
    body = {"chartType": "note_playback", "pitch": pitch, "velocity": 110,
            "duration_ms": 500, "display_length_ms": 500}
    try:
        r = requests.post(f"{B}/get_chart_test", json=body, timeout=60)
        if not r.ok:
            return f"ERR{r.status_code}"
        ch = r.json()
        # find first numeric series in the chart payload
        arrs = []
        def walk(o):
            if isinstance(o, dict):
                for v in o.values(): walk(v)
            elif isinstance(o, list):
                if o and all(isinstance(x, (int, float)) for x in o) and len(o) > 20:
                    arrs.append(o)
                else:
                    for v in o: walk(v)
        walk(ch)
        if not arrs:
            return "no-series"
        best = max(arrs, key=lambda a: max(abs(x) for x in a) if a else 0)
        rms = (sum(x*x for x in best)/len(best))**0.5
        return rms
    except Exception as e:
        return f"ERR:{e}"

def step(label):
    tr, exc = health()
    print(f"  [{label}] backend_thread_running={tr} exception={exc}")
    return tr

def main():
    print("=== dev-538e latch reproduction (ONLINE audio_off) ===")
    print("1) Load preset online/audio_off")
    load_online_audio_off()
    base_thread = step("after-load")
    orig_t = get_tension(PITCH)
    print(f"   original tension(pitch {PITCH}) = {orig_t}")

    print("2) Baseline: play healthy note")
    play(PITCH); time.sleep(1.2); note_off(PITCH); time.sleep(0.5)
    step("baseline-note")
    print(f"   offline RMS (healthy) = {offline_rms(PITCH)}")

    print(f"3) RUNAWAY: set tension x{RUNAWAY_MULT}, then play -> guard should trip")
    if isinstance(orig_t, (int, float)):
        bad = orig_t * RUNAWAY_MULT
    else:
        bad = 1e9
    print("   set_tension(runaway):", set_tension(PITCH, bad))
    play(PITCH); time.sleep(1.5); note_off(PITCH); time.sleep(1.0)
    after_trip = step("after-runaway")

    print("4) RECOVER attempt: restore safe tension + Reset + play")
    if isinstance(orig_t, (int, float)):
        print("   set_tension(safe):", set_tension(PITCH, orig_t))
    print("   reset:", reset()); time.sleep(0.8)
    play(PITCH); time.sleep(1.2); note_off(PITCH); time.sleep(0.5)
    after_recover = step("after-safe+reset")
    print(f"   offline RMS (after recover) = {offline_rms(PITCH)}")

    print("\n=== VERDICT ===")
    print(f"  thread after load        : {base_thread}")
    print(f"  thread after runaway trip: {after_trip}")
    print(f"  thread after safe+reset  : {after_recover}")
    if base_thread and not after_trip and not after_recover:
        print("  => BUG REPRODUCED: guard trip KILLS the online thread and reset does NOT recover (brick).")
    elif base_thread and after_trip and after_recover:
        print("  => RECOVERED: thread survived the trip and stayed alive after safe+reset (FIX WORKING).")
    else:
        print("  => INCONCLUSIVE (see values above).")

if __name__ == "__main__":
    main()
