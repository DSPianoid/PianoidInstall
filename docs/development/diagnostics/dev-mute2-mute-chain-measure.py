"""dev-mute2 — MEASURE the sound-channel mute chain end-to-end on the LIVE backend.

Reproduces the operator's report ("Mute does not work at all — I muted all sound,
didn't even change") by measuring every hop:

  FE emit contract  ->  HTTP transport  ->  backend accept/reject  ->  stored mask
  (readback)        ->  packed/engine   ->  AUDIBLE OUTPUT LEVEL (/health peak_level)

The operator runs listen_to_modes=0 (STRINGS mode). On that axis the SC panel mutes by
POSTing the F6 persistent mask kind `feedback_mask` on the OUTPUT pitches 128..131
(useSoundChannels.js emitOneStringsRowMask -> String(channel + OUTPUT_PITCH_OFFSET)).

Usage:  <venv>/python docs/development/diagnostics/dev-mute2-mute-chain-measure.py [label]
Requires a live backend on :5000 with a strings-mode preset loaded and audio ON.
"""
import json
import sys
import time

import requests

BASE = "http://127.0.0.1:5000"
OUTPUT_PITCHES = [128, 129, 130, 131]
PITCH = 60
VELOCITY = 127


def health():
    return requests.get(f"{BASE}/health", timeout=10).json()


def get_mask():
    """Read the STORED strings-axis mute mask back from the backend (never trust the UI)."""
    r = requests.get(f"{BASE}/get_parameter/feedback_mask/output", timeout=10)
    return r.status_code, r.json()


def post_mask(pitch, row):
    r = requests.post(
        f"{BASE}/set_parameter/feedback_mask/{pitch}",
        json={str(pitch): row},
        timeout=10,
    )
    body = None
    try:
        body = r.json()
    except Exception:
        body = r.text[:200]
    return r.status_code, body


def play_and_measure(seconds=3.0, label=""):
    """Play a note and track the PEAK OUTPUT LEVEL the engine actually produces.

    `pre_limit_peak` is a KERNEL PEAK-HOLD (monotonic since the last reset), so we must
    POST /clear_limiting first — it calls clear_limiting_latch() -> cpp.resetLimiterPeaks(),
    zeroing the hold. Without this the "muted" read inherits the "unmuted" latch and the
    comparison is meaningless.
    """
    # settle: let any previous ringdown decay, THEN reset the peak-hold
    time.sleep(3.0)
    requests.post(f"{BASE}/clear_limiting", timeout=10)
    time.sleep(0.3)
    base = health()
    requests.post(f"{BASE}/play", json={"pitch": PITCH, "velocity": VELOCITY, "command": 144}, timeout=10)
    peak = 0.0
    ch_peak = [0.0] * 4
    t0 = time.time()
    while time.time() - t0 < seconds:
        h = health()
        peak = max(peak, float(h.get("peak_level") or 0.0))
        for c in (h.get("limiter") or {}).get("channels") or []:
            i = int(c["channel"])
            ch_peak[i] = max(ch_peak[i], float(c.get("pre_limit_peak") or 0.0))
        time.sleep(0.12)
    requests.post(f"{BASE}/play", json={"pitch": PITCH, "velocity": 100, "command": 128}, timeout=10)
    print(f"  [{label}] peak_level={peak:.1f}  per-channel pre_limit_peak={[round(x,1) for x in ch_peak]}"
          f"  (pre-play peak was {float(base.get('peak_level') or 0.0):.1f})")
    return peak, ch_peak


def mask_summary(payload):
    """Summarise the readback: per output pitch -> (len, #zeros, #ones)."""
    out = {}
    data = payload.get("values", payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, list):
                out[k] = (len(v), sum(1 for x in v if x == 0), sum(1 for x in v if x == 1))
    return out


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    h = health()
    print(f"=== dev-mute2 mute-chain measurement [{label}] ===")
    print(f"backend: status={h['status']} listen_mode={h['listen_mode']} "
          f"driver={h['audio_driver_fallback']['active']} audio_active={h['lifecycle']['audio_driver_active']}")
    assert h["listen_mode"] is False, "expected STRINGS mode (listen_to_modes=0) — the operator's config"

    print("\n--- HOP 5 (stored mask) BEFORE mute ---")
    sc, body = get_mask()
    print(f"  GET /get_parameter/feedback_mask/output -> {sc}  {mask_summary(body)}")

    print("\n--- HOP 7 (AUDIBLE OUTPUT) with mute OFF ---")
    peak_unmuted, ch_unmuted = play_and_measure(label="MUTE OFF")

    print("\n--- HOP 3/4 (TRANSPORT + BACKEND ACCEPT): mute ALL 4 sound channels ---")
    statuses = {}
    for p in OUTPUT_PITCHES:
        row = [0] * 196  # full-axis mute — exactly what the FE emitted in the operator's report
        st, bd = post_mask(p, row)
        statuses[p] = st
        msg = bd.get("message") if isinstance(bd, dict) else bd
        print(f"  POST /set_parameter/feedback_mask/{p}  (196 zeros) -> HTTP {st}  {str(msg)[:110]}")

    print("\n--- HOP 5 (stored mask) AFTER mute ---")
    sc, body = get_mask()
    print(f"  GET /get_parameter/feedback_mask/output -> {sc}  {mask_summary(body)}")

    print("\n--- HOP 7 (AUDIBLE OUTPUT) with mute ON ---")
    peak_muted, ch_muted = play_and_measure(label="MUTE ON ")

    print("\n=== VERDICT ===")
    print(f"  mute POST statuses : {statuses}")
    print(f"  peak UNMUTED       : {peak_unmuted:.1f}")
    print(f"  peak MUTED         : {peak_muted:.1f}")
    if peak_unmuted > 0:
        print(f"  level change       : {100.0 * peak_muted / peak_unmuted:.1f}% of unmuted")
    ok = all(s == 200 for s in statuses.values()) and peak_muted < 0.02 * max(peak_unmuted, 1e-9)
    print(f"  MUTE WORKS?        : {'YES' if ok else 'NO'}")

    # restore: unmute everything so the stack is left as found
    print("\n--- restoring (unmute all) ---")
    for p in OUTPUT_PITCHES:
        st, _ = post_mask(p, [1] * 196)
        print(f"  POST feedback_mask/{p} (196 ones) -> HTTP {st}")

    with open(f"D:/repos/PianoidInstall/dev-mute2-{label}.json", "w") as f:
        json.dump({"statuses": statuses, "peak_unmuted": peak_unmuted, "peak_muted": peak_muted,
                   "ch_unmuted": ch_unmuted, "ch_muted": ch_muted}, f, indent=2)


if __name__ == "__main__":
    main()
