"""dev-cfl-3: FULL-BACKEND pitch-57 click repro via the canonical note_playback path (PREP — coordinate
the backend port with team-lead before running; do NOT collide with the user's live backend).

WHY: the bare in-proc render (dev-cfl-pitch57-repro.py) drives OnlinePlaybackEngine directly and showed
pitch 57 SUSTAINS + flag=0. But that BYPASSES the live path the user exercises: the REST/WS note-trigger,
the middleware param-apply flow (the passive/branched R1 change lives in parameter_manager.update_parameter),
and preset-load. This harness hits the REAL backend (per docs/guides/UI_TESTING.md): it reads the CFL flags
via REST, renders pitch 57 through the note_playback chart (offline deterministic SYNTH BUFFER through the
real preset-load+param-apply+kernel flow), and optionally applies a PRE-EDIT first (the user may have edited a
param before the click).

DISTINCTION it makes (team-lead): does the note_playback SYNTH BUFFER itself click (-> synthesis/param-apply
flow, guard-related) or sustain (-> the click is in the live streaming/audio path, not the synth)?

PREREQ (per UI_TESTING.md): three-process stack up (npm run dev -> launcher 3001 + frontend 3000; APPLY -> backend
5000 with a preset loaded). Verify GET /health pianoid_loaded:true first. This script only does REST calls
(read-only note_playback + the param-apply the user themselves would do) — no process management here.

Usage:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cfl-pitch57-fullbackend.py [PITCH] [PRE_EDIT_PARAM] [PRE_EDIT_VALUE]
  e.g.  ... 57                      # just render pitch 57 + a working pitch
        ... 57 tension 0.8x         # apply tension *0.8 to pitch 57 first, then render (relative: '<mult>x')
        ... 57 jung 2e11            # set jung=2e11 on pitch 57 first, then render (absolute)
"""
import sys, json, base64, struct, math
import os
import urllib.request

# Port override: env CFL_PORT or --port=NNNN. Default 5000.
#   Option A (team-lead): point at the USER's running backend :5000 but READ-ONLY (set CFL_READONLY=1 / --read-only) —
#     GET flags/ratio + note_playback only; NEVER set_parameter (would mutate the user's live working copy).
#   Option B: my OWN backend on a spare port (e.g. 5050) where the pre-edit path is safe to exercise.
_PORT = os.environ.get("CFL_PORT", "5000")
_READONLY = os.environ.get("CFL_READONLY", "0") == "1"
for _a in sys.argv[1:]:
    if _a.startswith("--port="):
        _PORT = _a.split("=", 1)[1]
    if _a == "--read-only":
        _READONLY = True
BASE = f"http://127.0.0.1:{_PORT}"
WORKING = 60


def _post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def health():
    try:
        st, d = _get("/health")
        print(f"/health: {st} {d}")
        return d.get("pianoid_loaded", False)
    except Exception as e:
        print(f"/health FAILED: {e} — is the backend up on :5000? (UI_TESTING.md start sequence)")
        return False


def stability(pitch):
    try:
        st, d = _get(f"/get_parameter/stability_ratio/{pitch}")
        return st, d
    except Exception as e:
        return None, {"error": str(e)}


def note_playback(pitch, dur_ms=600):
    st, d = _post("/get_chart_test", {"chartType": "note_playback", "pitch": pitch, "velocity": 100,
                                      "duration_ms": dur_ms, "display_length_ms": dur_ms})
    b64 = (d.get("audio_data") or [None])[0]
    if not b64:
        return None, d
    raw = base64.b64decode(b64)
    # WAV: skip 44-byte header, 16-bit PCM mono
    if raw[:4] == b"RIFF":
        body = raw[44:]
        n = len(body) // 2
        samp = struct.unpack("<%dh" % n, body[:n*2])
        a = [s / 32768.0 for s in samp]
    else:
        a = []
    return a, d


def envelope(a):
    if not a:
        return "EMPTY (no audio_data)"
    n = len(a); seg = max(1, n // 8)
    pa = max(abs(x) for x in a[:seg]); pt = max(abs(x) for x in a[-seg:])
    s = (pt / pa) if pa > 0 else 0.0
    return f"peak_attack={pa:.4e} peak_tail={pt:.4e} sustain_ratio={s:.4f} -> {'CLICK (synth buffer dies)' if s < 0.02 else 'SUSTAINED (synth buffer rings)'}  n={n}"


def main():
    # positional args, ignoring --flags (handled at module load): [pitch] [pre_edit_param] [pre_edit_value]
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    pitch = int(pos[0]) if len(pos) > 0 else 57
    pre_param = pos[1] if len(pos) > 1 else None
    pre_val = pos[2] if len(pos) > 2 else None

    print(f"TARGET BASE={BASE}  READ_ONLY={_READONLY}")
    if not health():
        print("ABORT: backend not loaded. Bring up the 3-process stack (UI_TESTING.md) + APPLY a preset first.")
        return

    print(f"\n--- BEFORE any edit ---")
    for p in (pitch, WORKING):
        st, sd = stability(p)
        print(f"  pitch {p} stability_ratio: status={st} {json.dumps(sd)[:300]}")
        a, _ = note_playback(p)
        print(f"  pitch {p} note_playback: {envelope(a)}")

    if pre_param and pre_val and _READONLY:
        print("\n[READ-ONLY] pre-edit SKIPPED — refusing set_parameter against a read-only (user's live) backend. "
              "Use option B (own backend on a spare port, no --read-only) to exercise the pre-edit path.")
    elif pre_param and pre_val:
        # exercise the REAL middleware param-apply (passive/branched R1). Relative '<mult>x' or absolute value.
        st0, sd = stability(pitch)
        # read current value to support relative edit
        cur = None
        try:
            cur = sd.get(str(pitch), {}).get(pre_param)
        except Exception:
            pass
        if isinstance(pre_val, str) and pre_val.endswith("x"):
            mult = float(pre_val[:-1])
            base = cur if cur is not None else 1.0
            value = base * mult
            print(f"\n--- PRE-EDIT: {pre_param} {base} *{mult} = {value} on pitch {pitch} (relative) ---")
        else:
            value = float(pre_val)
            print(f"\n--- PRE-EDIT: {pre_param} = {value} on pitch {pitch} (absolute) ---")
        st, d = _post(f"/set_parameter/string/{pitch}", {str(pitch): {pre_param: value}})
        print(f"  set_parameter status={st} body={json.dumps(d)[:300]}")

        print(f"\n--- AFTER edit ---")
        st, sd = stability(pitch)
        print(f"  pitch {pitch} stability_ratio: status={st} {json.dumps(sd)[:300]}")
        a, _ = note_playback(pitch)
        print(f"  pitch {pitch} note_playback: {envelope(a)}")

    print("\nINTERPRETATION:")
    print("  CLICK in the note_playback SYNTH BUFFER => synthesis/param-apply flow (guard-related). Compare flags/ratio.")
    print("  SUSTAINED here but the user hears a click LIVE => the click is in the live streaming/audio path, not synth.")


if __name__ == "__main__":
    main()
