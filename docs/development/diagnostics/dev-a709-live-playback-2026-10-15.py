"""dev-a709 -- live playback of F15_measured_plywood_2026-10-15 through the plywood board's 7 exciters (REST only).

Pre-conditions (the caller): clean stack; backend started from the branch Core with
PIANOID_AUDIO_OUTPUT_MAP=8,9,2,3,4,5,6 (E1..E7 = Out 9, 10, 3..7; Out 1/2 monitor-only stay silent).

    python dev-a709-live-playback-2026-10-15.py <step> [--volume V] [--out DIR]
steps: load | routing | chords | midi | peaks

load     POST /load_preset (ASIO callback, audio on, realtime) at init volume V (default 67: worst chord ~ -42 dBFS);
         E2 (channel 1 = output pitch 129) feedback row x 0.5 (-6 dB, until its mounting is inspected).
routing  per channel k: mute every other output row (feedback_mask), POST /measure_rms p69 v50 (piezo P1 on In 1),
         plus an all-muted baseline; masks restored after. Writes routing.json.
chords   C major, A minor, open low (C2 G2 E3), open high (C6 E6 G6 C7), ~3 s each, v80, then /health peaks.
midi     POST /midi_playback elise.mid, poll status until done (or --max-s), then /health peaks.
midi_rest  the same file streamed through POST /play (mido, real time, first 120 s) when /midi_playback fails.
peaks    GET /health latched peak (fraction of full scale) -> dBFS.
"""
import argparse
import json
import math
import os
import time

import requests

B = "http://127.0.0.1:5000"
N_CH = 7
ROUTE_VEL = int(os.environ.get("A709_ROUTE_VEL", "50"))
PRESET_FILE = os.environ.get("A709_PRESET", "D:/repos/wt-a709-core/pianoid_middleware/presets/F15_measured_plywood_2026-10-15.json")
CHORDS = {"C_major": (48, 52, 55, 60, 64, 67), "A_minor": (45, 52, 57, 60, 64, 69),
          "open_low": (36, 43, 52), "open_high": (84, 88, 91, 96)}


def post(path, body=None, timeout=60):
    r = requests.post(B + path, json=body or {}, timeout=timeout)
    r.raise_for_status()
    return r.json() if r.content else {}


def get(path, timeout=30):
    r = requests.get(B + path, timeout=timeout)
    r.raise_for_status()
    return r.json()


def peaks():
    h = get("/health")
    lim = h.get("limiter") or {}
    pk = h.get("peak_level", lim.get("peak_level"))
    return {"peak_level": pk, "peak_dbfs": round(20 * math.log10(pk), 2) if pk else None,
            "clipping": h.get("clipping"), "limiter": lim}


def load(volume):
    r = post("/load_preset", {"path": "presets/F15_measured_plywood_2026-10-15.json", "audio_driver_type": 4,
                              "audio_on": 1, "start_right_away": 1, "array_size": 512, "string_iterations": 16,
                              "cycle_iterations": 64, "sample_rate": 48, "audio_buffer_size": 4,
                              "listen_to_modes": 0, "listen_to_midi": 0, "sound_derivative_order": 1,
                              "volume": volume}, timeout=300)
    import base64
    import numpy as np
    stored = json.load(open(PRESET_FILE))["pitches"]["129"]["deck"]       # the STORED row: re-loads never stack trims
    row = np.frombuffer(base64.b64decode(stored["data"]), np.dtype(stored["type"])).reshape(stored["shape"])[1]
    post("/set_parameter/feedback/129", {"129": [0.5 * float(x) for x in row]})
    return {"load": r, "e2_trim_db": -6.02}


def set_masks(active):
    """Unmute output rows in `active` (channel indices), mute the rest."""
    n = len(get("/get_parameter/feedback/128")["128"])
    for c in range(N_CH):
        post(f"/set_parameter/feedback_mask/{128 + c}", {str(128 + c): [1.0 if c in active else 0.0] * n})


def routing(out_dir):
    res = {}
    try:
        for label, act in [("baseline_all_muted", ())] + [(f"E{k + 1}", (k,)) for k in range(N_CH)]:
            set_masks(act)
            time.sleep(0.3)
            res[label] = post("/measure_rms", {"pitch": 69, "velocity": ROUTE_VEL, "repetitions": 1}, timeout=60)
            print(label, res[label].get("db"))
    finally:
        set_masks(range(N_CH))
    json.dump(res, open(os.path.join(out_dir, "routing.json"), "w"), indent=1)
    return res


def note(p, v, on=True):
    post("/play", {"pitch": p, "velocity": v if on else 0, "command": 144 if on else 128})


def chords(hold_s=3.0, vel=80):
    out = {}
    post("/clear_limiting")
    for name, ps in CHORDS.items():
        for p in ps:
            note(p, vel)
        time.sleep(hold_s)
        for p in ps:
            note(p, 0, on=False)
        time.sleep(1.0)
        out[name] = peaks()
        print(name, out[name]["peak_dbfs"])
    return out


def midi(max_s=150):
    post("/clear_limiting")
    r = post("/midi_playback", {"action": "start", "midi_file": "elise.mid", "start_delay_ms": 500})
    t0 = time.time()
    dur = r.get("duration_ms", max_s * 1000) / 1000
    while time.time() - t0 < min(dur + 3, max_s):
        time.sleep(5)
        print(f"{time.time() - t0:5.0f} s", peaks()["peak_dbfs"])
    if time.time() - t0 >= max_s:
        post("/midi_playback", {"action": "stop"})
    return {"start": r, "played_s": round(time.time() - t0, 1), "peaks": peaks()}


def midi_rest(path, max_s=120.0):
    """Fallback player when /midi_playback fails (here: pretty_midi needs pkg_resources, missing in the venv):
    stream the file's note_on / note_off / sustain (CC64) through POST /play in real time (mido), stop after
    max_s with all notes and the pedal released."""
    import mido
    post("/clear_limiting")
    t0, sounding = time.time(), set()
    for msg in mido.MidiFile(path).play():               # sleeps to each event's time
        if time.time() - t0 > max_s:
            break
        if msg.type == "note_on" and msg.velocity > 0:
            note(msg.note, msg.velocity)
            sounding.add(msg.note)
        elif msg.type in ("note_on", "note_off"):
            note(msg.note, 0, on=False)
            sounding.discard(msg.note)
        elif msg.type == "control_change" and msg.control == 64:
            post("/play", {"pitch": 64, "velocity": msg.value, "command": 176})
    for n in sounding:
        note(n, 0, on=False)
    post("/play", {"pitch": 64, "velocity": 0, "command": 176})
    return {"played_s": round(time.time() - t0, 1), "peaks": peaks()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=("load", "routing", "chords", "midi", "midi_rest", "peaks"))
    ap.add_argument("--volume", type=float, default=67)
    ap.add_argument("--out", default=".")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    elise = os.path.join(os.path.dirname(PRESET_FILE), "..", "MIDI_records", "elise.mid")
    r = {"load": lambda: load(a.volume), "routing": lambda: routing(a.out), "chords": chords, "midi": midi,
         "midi_rest": lambda: midi_rest(elise), "peaks": peaks}[a.step]()
    print(json.dumps(r, indent=1, default=str)[:3000])


if __name__ == "__main__":
    main()
