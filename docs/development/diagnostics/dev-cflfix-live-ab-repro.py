"""dev-cflfix — LIVE A/B reproduction harness for the user's 3 reported failures (post CFL-v2 re-test).

WHY: the Phase-1 verify used note_playback (OFFLINE synth buffer) — it cannot see the LIVE audio/note path
(RealTimeEventBuffer -> OnlinePlaybackEngine drain -> EventDispatcher envelope -> driver -> rawSoundBuffer).
This harness drives the REAL backend through the path the USER exercises (REST /play note-on/off, /set_parameter
tension) and reads the LIVE rawSoundBuffer via the 'sound' chart (chartFunctions.sound_function ->
get_sound_from_pianoid -> getRawSoundRecord), NOT note_playback.

It is parameterized by port + preset so the SAME script runs against dev (no commit 0d10675) and
feature/cfl-stability-guard-v2 (dev + 0d10675), isolating dev-regression vs CFL-v2-Python. Default preset
Belarus_8band_196modes (the user's, modal-heavy).

REST-ONLY — no process management here. PREREQ (per UI_TESTING.md): the 3-process stack up with a REAL audio
driver (audio_driver_type=3 SDL3, NOT 0) + Belarus loaded; GET /health pianoid_loaded:true first.

Reproductions:
  S2 note-off-stuck : play note-on N, wait, note-off N, wait; /capture the live sound ring; measure RMS in the
                      window AFTER note-off vs during the note. Persisting energy => stuck. (Default N=62.)
  S1 click          : play note-on 57; /capture; measure the attack envelope (peak_attack vs peak_tail in the
                      live ring) — CLICK = attack-then-silence (sustain_ratio < ~0.02) vs SUSTAINED.
  S3 gate           : escalate tension on a pitch via /set_parameter/string and report at which value the gate
                      fires (HTTP 400 cfl_unstable). Distinguishes "stable-but-huge tension (gate correctly
                      silent)" from a real miss. Also tries length + string_iteration-style edits (NOT CFL-gated).

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cflfix-live-ab-repro.py
      [--port=5000] [--preset=Belarus_8band_196modes] [--note=62] [--variant=v2|dev]
  (variant is a label only — it tags the printed report; the actual code under test is whatever the running
   backend imported.)
"""
import sys, os, json, time, base64, struct, math
import urllib.request, urllib.error

PORT = "5000"
PRESET = "Belarus_8band_196modes"
NOTE = 62          # the user's stuck-note example
WORKING = 60       # a control pitch
CLICK_PITCH = 57   # the reported live-click pitch
VARIANT = "?"
for a in sys.argv[1:]:
    if a.startswith("--port="):    PORT = a.split("=", 1)[1]
    elif a.startswith("--preset="): PRESET = a.split("=", 1)[1]
    elif a.startswith("--note="):  NOTE = int(a.split("=", 1)[1])
    elif a.startswith("--variant="): VARIANT = a.split("=", 1)[1]
BASE = f"http://127.0.0.1:{PORT}"


def _post(path, payload, timeout=60):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _get(path, timeout=30):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"_http_error": e.code, "body": e.read().decode()[:200]}


def health():
    st, d = _get("/health")
    loaded = isinstance(d, dict) and d.get("pianoid_loaded")
    drv = isinstance(d, dict) and d.get("lifecycle", {}).get("audio_driver_active")
    print(f"/health: {st} pianoid_loaded={loaded} audio_driver_active={drv} listen_mode={d.get('listen_mode') if isinstance(d,dict) else '?'}")
    return bool(loaded)


def play(pitch, command, velocity=100):
    # command 144=NOTE_ON, 128=NOTE_OFF
    st, body = _post("/play", {"pitch": pitch, "command": command, "velocity": velocity})
    return st, body


def capture_sound(length=240000, channel=0):
    """Fetch the LIVE rawSoundBuffer via the 'sound' chart (NOT note_playback). Returns float samples."""
    st, body = _post("/get_chart_test", {"chartType": "sound", "length": length, "channel": channel})
    try:
        d = json.loads(body)
    except Exception:
        return [], f"non-json chart resp: {body[:160]}"
    # ChartArray: data[0] is the waveform list; audio_data[0] may carry a WAV b64
    arr = None
    if isinstance(d, dict):
        data = d.get("data")
        if isinstance(data, list) and data and isinstance(data[0], list):
            arr = data[0]
        b64 = (d.get("audio_data") or [None])[0] if d.get("audio_data") else None
        if arr is None and b64:
            raw = base64.b64decode(b64)
            if raw[:4] == b"RIFF":
                body2 = raw[44:]; n = len(body2)//2
                arr = [s/32768.0 for s in struct.unpack("<%dh" % n, body2[:n*2])]
    return (arr or []), None


def rms(xs):
    if not xs:
        return 0.0
    return math.sqrt(sum(x*x for x in xs) / len(xs))


def peak(xs):
    return max((abs(x) for x in xs), default=0.0)


def seg_stats(xs, label):
    n = len(xs)
    if n == 0:
        return f"{label}: EMPTY"
    seg = max(1, n // 8)
    return (f"{label}: n={n} peak={peak(xs):.4e} rms={rms(xs):.4e} "
            f"peak_attack={peak(xs[:seg]):.4e} peak_tail={peak(xs[-seg:]):.4e} "
            f"sustain_ratio={ (peak(xs[-seg:])/peak(xs[:seg])) if peak(xs[:seg])>0 else 0:.4f}")


def reset_records():
    _post("/capture", {})   # triggers a GPU result extraction + clears
    time.sleep(0.2)


def test_s2_note_off_stuck():
    print("\n========== S2: note-off stuck (modes vs strings) ==========")
    print(f"note {NOTE} on Belarus; measure live sound ring AFTER note-off.")
    reset_records()
    play(NOTE, 144, 100)
    time.sleep(1.2)                       # let the note ring + buffer fill
    a_on, err = capture_sound()
    print("  " + seg_stats(a_on, f"DURING note {NOTE} (1.2s after on)"))
    play(NOTE, 128, 0)                    # NOTE_OFF
    print(f"  sent NOTE_OFF {NOTE}; waiting 2.5s...")
    time.sleep(2.5)                       # well past any string damper close
    a_off, err = capture_sound()
    print("  " + seg_stats(a_off, f"AFTER note-off {NOTE} (2.5s later)"))
    r_on, r_off = rms(a_on), rms(a_off)
    ratio = (r_off / r_on) if r_on > 0 else 0.0
    print(f"  >>> RMS after-off / during = {ratio:.3f}  "
          f"({'STUCK — energy persists after note-off' if ratio > 0.25 else 'decays as expected'})")
    return {"during_rms": r_on, "after_off_rms": r_off, "ratio": ratio}


def test_s1_click():
    print("\n========== S1: pitch-57 LIVE click ==========")
    reset_records()
    play(CLICK_PITCH, 144, 100)
    time.sleep(1.0)
    a, err = capture_sound()
    print("  " + seg_stats(a, f"LIVE pitch {CLICK_PITCH} (1.0s)"))
    n = len(a); seg = max(1, n//8)
    sr = (peak(a[-seg:])/peak(a[:seg])) if a and peak(a[:seg])>0 else 0.0
    print(f"  >>> {'CLICK (attack then silence)' if (a and sr < 0.02) else ('SUSTAINED' if a else 'NO AUDIO CAPTURED')}")
    play(CLICK_PITCH, 128, 0)
    return {"sustain_ratio": sr, "n": n}


def test_s3_gate():
    print("\n========== S3: live tension gate (find firing threshold + non-gated params) ==========")
    p = NOTE
    fired_at = None
    for tv in (500, 2000, 10000, 30000, 50000, 100000, 500000):
        st, body = _post(f"/set_parameter/string/{p}", {str(p): {"tension": tv}})
        code = None
        try:
            code = json.loads(body).get("code")
        except Exception:
            pass
        tag = "REJECT(400)" if st == 400 else ("OK(200)" if st == 200 else f"HTTP{st}")
        print(f"  tension={tv:<8} -> {tag}{' code='+code if code else ''}")
        if st == 400 and fired_at is None:
            fired_at = tv
    print(f"  >>> gate first fires at tension ~ {fired_at}")
    # NON-CFL-gated params (affect dt / grid, NOT the gated tension): length, string_iteration-like
    print("  -- non-CFL-gated edits (expected NOT to be gated; affect dt/grid) --")
    for param, val in (("length", 5.0), ("length", 50.0)):
        st, body = _post(f"/set_parameter/string/{p}", {str(p): {param: val}})
        print(f"  {param}={val:<6} -> HTTP{st} {body[:60]}")
    return {"gate_fires_at_tension": fired_at}


def main():
    print(f"===== dev-cflfix LIVE A/B repro  variant={VARIANT}  preset={PRESET}  base={BASE} =====")
    if not health():
        print("ABORT: backend not loaded. Bring up the 3-process stack with audio_driver_type=3 + Belarus first.")
        return
    res = {}
    res["s2"] = test_s2_note_off_stuck()
    res["s1"] = test_s1_click()
    res["s3"] = test_s3_gate()
    print("\n===== SUMMARY (variant=%s) =====" % VARIANT)
    print(json.dumps(res, indent=2))
    print("\nNOTE: S2 measures the AGGREGATE live ring (modes+strings summed). To attribute persistence to MODES "
          "vs STRINGS, follow up with an in-proc getModeDisplacements probe (modes have no note-off path; they "
          "decay only via per-mode mode_dec).")


if __name__ == "__main__":
    main()
