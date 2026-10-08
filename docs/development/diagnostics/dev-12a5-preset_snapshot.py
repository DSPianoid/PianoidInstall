"""dev-12a5: snapshot / diff the backend's GET-visible preset state.

Usage:
  python dev-12a5-preset_snapshot.py snap OUT.json        # capture
  python dev-12a5-preset_snapshot.py diff A.json B.json   # compare (rel tol 1e-9)

Captures every GET /get_parameter kind the editors read, so "save -> reload ->
GET diff = 0" can be asserted for the save/load round trip.
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:5000"
KINDS = [
    ("string", "all"), ("mode", "all"), ("gauss_full", "all"), ("hammer", "all"),
    ("feedin", "all"), ("feedback", "all"), ("feedin_mask", "all"), ("feedback_mask", "all"),
    ("feedback", "output"), ("feedback_mask", "output"),
    ("sound_channel", "all"), ("string_sound_channel", "output"),
]
# Fields that legitimately differ between two loads (derived / runtime).
VOLATILE = {"lastChecked"}


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.loads(r.read().decode())


def snap(out):
    data = {}
    for kind, key in KINDS:
        try:
            data[f"{kind}/{key}"] = get(f"/get_parameter/{kind}/{key}")
        except Exception as e:  # noqa: BLE001 - diagnostic
            data[f"{kind}/{key}"] = {"__error__": str(e)}
    data["runtime"] = get("/get_runtime_parameters")
    data["active"] = get("/preset/list")
    with open(out, "w") as f:
        json.dump(data, f)
    print(f"snapshot -> {out} ({len(data)} sections)")


def _cmp(a, b, path, out, tol):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in set(a) | set(b):
            if k in VOLATILE:
                continue
            if k not in a or k not in b:
                out.append(f"{path}/{k}: missing in {'A' if k not in a else 'B'}")
                continue
            _cmp(a[k], b[k], f"{path}/{k}", out, tol)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: len {len(a)} != {len(b)}")
            return
        for i, (x, y) in enumerate(zip(a, b)):
            _cmp(x, y, f"{path}[{i}]", out, tol)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if a != b and abs(a - b) > tol * max(abs(a), abs(b)):
            out.append(f"{path}: {a!r} != {b!r}")
    elif a != b:
        out.append(f"{path}: {str(a)[:60]!r} != {str(b)[:60]!r}")


def diff(fa, fb, sections=None, tol=1e-9):
    a, b = json.load(open(fa)), json.load(open(fb))
    total = 0
    for sec in sections or [k for k in a if k not in ("runtime", "active")]:
        out = []
        _cmp(a.get(sec), b.get(sec), sec, out, tol)
        total += len(out)
        print(f"{sec}: {len(out)} diffs" + ("" if not out else "  e.g. " + " | ".join(out[:3])))
    print(f"TOTAL DIFFS: {total}")
    return total


if __name__ == "__main__":
    if sys.argv[1] == "snap":
        snap(sys.argv[2])
    else:
        sys.exit(1 if diff(sys.argv[2], sys.argv[3]) else 0)
