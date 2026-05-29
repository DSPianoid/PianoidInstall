"""dev-cflfix — AUTONOMOUS per-pitch reproduction + 50-65 scan (user directive: reproduce 55/56/57, don't ask).
REST-only against the live backend (note_playback = deterministic offline render through the REAL backend; full
during-note envelope, no 5s-ring-hygiene issue). For each pitch: render note_playback, measure DURING-sustain
(attack vs mid vs tail) + classify behavior. Scan 50-65 to expose the pattern STRUCTURE vs block-number /
absolute-CUDA-index / within-block-position.

Belarus mapping (cfl-reviewer): pitch P (22 strings, 4-wide blocks) → block = 106 - P, owns within-block positions
1/2/3, cuda string_index ~ (P-specific). So per pitch we tag block# + the within-block position pattern.

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cflfix-pitch-scan.py [--port=5000] [--lo=50] [--hi=65]
"""
import sys, json, base64, struct, math, urllib.request, urllib.error

PORT = "5000"; LO = 50; HI = 65
for a in sys.argv[1:]:
    if a.startswith("--port="): PORT = a.split("=",1)[1]
    elif a.startswith("--lo="): LO = int(a.split("=",1)[1])
    elif a.startswith("--hi="): HI = int(a.split("=",1)[1])
BASE = f"http://127.0.0.1:{PORT}"


def post(path, body, t=60):
    req = urllib.request.Request(BASE+path, data=json.dumps(body).encode(),
                                 headers={"Content-Type":"application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=t) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()


def get(path, t=20):
    try:
        with urllib.request.urlopen(BASE+path, timeout=t) as r: return r.status, json.loads(r.read().decode() or "{}")
    except Exception as e: return None, {"err": str(e)}


def note_playback(pitch, dur_ms=600):
    """Deterministic offline render through the real backend. NOTE_ON@0, NOTE_OFF@~dur_ms internal.
    Returns the waveform samples (full note: attack + sustain + release)."""
    st, body = post("/get_chart_test", {"chartType":"note_playback", "pitch":pitch, "velocity":100,
                                        "duration_ms":dur_ms, "display_length_ms":dur_ms})
    try: d = json.loads(body)
    except Exception: return [], f"non-json: {body[:120]}"
    b64 = (d.get("audio_data") or [None])[0] if d.get("audio_data") else None
    if b64:
        raw = base64.b64decode(b64)
        if raw[:4] == b"RIFF":
            body2 = raw[44:]; n = len(body2)//2
            return [s/32768.0 for s in struct.unpack("<%dh" % n, body2[:n*2])], None
    data = d.get("data")
    if isinstance(data, list) and data and isinstance(data[0], list): return data[0], None
    return [], f"no audio: {body[:120]}"


def envelope(a):
    """Characterize the DURING-note envelope: peak position + decay shape + click vs sustain vs no-decay."""
    if not a: return None
    n = len(a); k = max(1, n//10)
    peak = max(abs(x) for x in a); pidx = max(range(n), key=lambda i: abs(a[i]))
    attack = max(abs(x) for x in a[:k])           # first 10%
    mid    = max(abs(x) for x in a[n//2-k:n//2+k]) # middle 20%
    tail   = max(abs(x) for x in a[-k:])           # last 10%
    # behavior classification
    if peak <= 0: beh = "SILENT"
    elif tail/peak > 0.5: beh = "NO-DECAY (sustains/stuck)"      # still loud at the end
    elif mid/peak < 0.05 and attack/peak > 0.5: beh = "CLICK (attack-only, no sustain)"
    else: beh = "NORMAL (attack-decay)"
    return dict(n=n, peak=peak, pk_pos=f"{pidx*100//n}%", attack=attack, mid=mid, tail=tail,
                mid_ratio=mid/peak if peak>0 else 0, tail_ratio=tail/peak if peak>0 else 0, beh=beh)


def main():
    print(f"===== dev-cflfix per-pitch scan {LO}-{HI}  base={BASE} =====")
    st, h = get("/health")
    print(f"/health: {st} loaded={h.get('pianoid_loaded') if isinstance(h,dict) else '?'}")
    if not (isinstance(h, dict) and h.get("pianoid_loaded")):
        print("ABORT: backend not loaded."); return
    print(f"\n{'pitch':>5} {'block':>5} {'beh':<28} {'peak':>10} {'pk_pos':>7} {'mid/pk':>8} {'tail/pk':>8}")
    rows = []
    for p in range(LO, HI+1):
        a, err = note_playback(p)
        if err: print(f"{p:>5}  render err: {err}"); continue
        e = envelope(a)
        if e is None: print(f"{p:>5}  EMPTY"); continue
        block = 106 - p   # Belarus mapping (cfl-reviewer)
        rows.append((p, block, e))
        print(f"{p:>5} {block:>5} {e['beh']:<28} {e['peak']:>10.3e} {e['pk_pos']:>7} {e['mid_ratio']:>8.4f} {e['tail_ratio']:>8.4f}")
    # structure analysis
    print("\n===== STRUCTURE =====")
    bad = [(p,b,e) for (p,b,e) in rows if e['beh'].startswith(('NO-DECAY','CLICK','SILENT'))]
    if not bad:
        print("  ALL pitches NORMAL in note_playback (no per-pitch anomaly via offline render).")
    else:
        print("  Anomalous pitches:", [(p, e['beh'].split()[0]) for (p,b,e) in bad])
        print("  by block parity:", [(p, b, b%2, b%4) for (p,b,e) in bad])
        # period detection
        ps = [p for (p,b,e) in bad]
        if len(ps) >= 2:
            diffs = [ps[i+1]-ps[i] for i in range(len(ps)-1)]
            print(f"  anomaly pitch spacing: {diffs} (constant→every-Nth; varies→boundary/other)")


if __name__ == "__main__":
    main()
