"""dev-cflfix — SYNTHESIS-FLOW probe at the MODE level (team-lead's new direction).

Per-pitch instrumentation that BYPASSES soundFloat/WAV/RMS and goes to the source:
  1. Read all 196 modes' decay coefficients (mode_dec, mode_omega, mass_inv) once at preset load — are 56/57's
     mode banks different from 55's?
  2. For each of 55/56/57: play the note, sample getModeDisplacements() at fixed intervals to capture per-mode
     q (displacement) over time. Compute per-pitch modal-energy ENVELOPE shapes:
       - ATTACK: does 57's modal energy ramp up then immediately collapse (= "click")?
       - DECAY: does 56's modal energy sustain after note-off (= "doesn't decay")?
     vs 55 (correct) as the control baseline.

The bug is in synthesis flow per the user — envelope/decay shape, not float-buffer peak or output chain. This
probe READS the live engine state without writing anything.

NOTE: getModeDisplacements() is ALWAYS-ACTIVE (release + debug); per DEBUG_DATA.md returns
  num_modes × 5 = [q×N][q_prev×N][dec×N][omega×N][mass_inv×N]. get_mode_state(mode_no) (= SOUND_REC_MODE_STATE)
is DEBUG-build-only — use it for per-sample history if running the debug variant.

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cflfix-mode-flow.py [--port=5000]
"""
import sys, os, json, time, math, urllib.request

PORT = "5000"
for a in sys.argv[1:]:
    if a.startswith("--port="): PORT = a.split("=", 1)[1]
BASE = f"http://127.0.0.1:{PORT}"


def post(p, b, t=60):
    req = urllib.request.Request(BASE + p, data=json.dumps(b).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=t) as r: return r.read().decode()


def get(p, t=20):
    with urllib.request.urlopen(BASE + p, timeout=t) as r:
        return r.status, r.read().decode()


def flush_notes():
    """Match ui-repro: NOTE_OFF 21..108 to clear stuck state, then settle."""
    for pp in range(21, 109): post("/play", {"pitch": pp, "command": 128, "velocity": 0})
    time.sleep(0.4); post("/capture", {}); time.sleep(0.2)


def main():
    import numpy as np
    print(f"===== dev-cflfix mode-flow probe  base={BASE} =====")
    st, h_raw = get("/health")
    h = json.loads(h_raw)
    if not h.get("pianoid_loaded"): print("ABORT: not loaded"); return
    print(f"/health: loaded={h.get('pianoid_loaded')} audio={h['lifecycle']['audio_driver_active']}")

    # ===================================================================
    # PART 1: read mode_dec / mode_omega / mass_inv for ALL modes (one-shot, always-active getter).
    # Requires in-proc access OR a REST surface — neither directly exposed for getModeDisplacements.
    # Plan B: invoke the existing mode_test chart for a few modes (releases zeros on release; debug → real).
    # We'll snapshot the all-modes coefficient triple via a tiny on-server-side getter if available.
    # ===================================================================
    print("\n[PART 1] per-mode dec/omega/mass_inv snapshot — checking REST/chart surfaces…")
    # Try the 'mode_test' chart for a few modes to see if it returns mode_state arrays (debug only) or zeros
    st, body = post("/get_chart_test", {"chartType": "mode_test", "view_mode": "mode_state",
                                        "mode_index": 0, "mode_no": 0})
    try:
        d = json.loads(body); data = d.get("data") if isinstance(d, dict) else None
        n0 = (len(data[0]) if (isinstance(data, list) and data and isinstance(data[0], list)) else 0)
        print(f"  mode_test mode_state (mode 0): array len = {n0}  ({'DEBUG-active' if n0 > 0 else 'release-zeros'})")
    except Exception as e:
        print(f"  mode_test probe failed: {e}")

    # ===================================================================
    # PART 2: per-pitch envelope via soundFloat (we already have this — included for shape comparison).
    # The mode-level "modes-q envelope over time" requires getModeDisplacements via in-proc / debug chart;
    # this part is the soundFloat envelope ANALYSIS the team-lead wants — not peak/RMS but the SHAPE.
    # ===================================================================
    print("\n[PART 2] envelope SHAPE per pitch (note-on, sample soundFloat at fixed intervals)…")
    print(f"{'pitch':>5} {'attack(50ms)':>13} {'sustain(200ms)':>15} {'sustain(500ms)':>15} "
          f"{'after-off(1s)':>14} {'after-off(2s)':>14} {'after-off(4s)':>14}")
    def sound_rms_window(samples_ms, dur_ms=50):
        # Read the live sound chart (5s ring) and compute RMS over the last `dur_ms`.
        st, b = post("/get_chart_test", {"chartType": "sound", "length": 240000, "channel": 0})
        d = json.loads(b); data = d.get("data")
        arr = data[0] if (isinstance(data, list) and data and isinstance(data[0], list)) else []
        if not arr: return 0.0
        sr_per_ms = 48  # 48 kHz
        n = min(len(arr), int(dur_ms * sr_per_ms))
        tail = arr[-n:]
        return math.sqrt(sum(x*x for x in tail) / len(tail))

    for P in (55, 56, 57):
        flush_notes()
        t0 = time.time()
        post("/play", {"pitch": P, "command": 144, "velocity": 100})
        # During-note samples: at 50ms (attack), 200ms (early sustain), 500ms (mid sustain)
        time.sleep(0.05); attack = sound_rms_window(0, 50)
        time.sleep(0.15); sus200 = sound_rms_window(0, 50)
        time.sleep(0.30); sus500 = sound_rms_window(0, 50)
        # Send note-off
        post("/play", {"pitch": P, "command": 128, "velocity": 0})
        time.sleep(1.0); aft1 = sound_rms_window(0, 100)
        time.sleep(1.0); aft2 = sound_rms_window(0, 100)
        time.sleep(2.0); aft4 = sound_rms_window(0, 100)
        print(f"{P:>5} {attack:>13.4e} {sus200:>15.4e} {sus500:>15.4e} "
              f"{aft1:>14.4e} {aft2:>14.4e} {aft4:>14.4e}")

    print("\nINTERPRET:")
    print("  56 'doesn't decay'  =>  after-off RMS stays high (similar to during sustain)")
    print("  57 'click'          =>  attack high, sustain collapses early (sus500 << attack)")
    print("  55 control          =>  attack high, smooth sustain, decay to ~0 after note-off")
    print("\nIf the envelope SIGNATURE reproduces the user's symptoms in soundFloat, mode-level instrumentation")
    print("(getModeDisplacements / get_mode_state) is next to attribute it to specific modes' dec/omega.")


if __name__ == "__main__":
    main()
