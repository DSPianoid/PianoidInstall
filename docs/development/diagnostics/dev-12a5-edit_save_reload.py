"""dev-12a5: apply one edit per editor family via REST, verify read-back.

Usage: python dev-12a5-edit_save_reload.py edit
Each edit = GET kind/key -> mutate -> POST set_parameter -> GET again; prints
OK/FAIL per edit. The caller then saves, reloads and diffs snapshots
(dev-12a5-preset_snapshot.py) to prove the edits persisted.
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:5000"


def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read().decode())


def _string(v):
    v["60"]["tension"] *= 1.07


def _mode(v):
    v["5"]["decrement"] *= 1.5


def _hammer(v):
    v["60"]["hammer"]["hammer_position"] = 0.2


def _sc(v):
    v["128"][3] *= 0.5


def _sc_mask(v):
    v["129"][7] = 0.0


def _feedin(v):
    v["60"][2] = 0.5


def _gauss(v):
    v["60"]["5"]["1"]["sigma"] *= 1.2


EDITS = [
    ("string", "60", _string), ("mode", "5", _mode), ("hammer", "60", _hammer),
    ("feedback", "128", _sc), ("feedback_mask", "129", _sc_mask),
    ("feedin", "60", _feedin), ("gauss", "60", _gauss),
]


def edit():
    bad = 0
    for kind, key, fn in EDITS:
        before = req("GET", f"/get_parameter/{kind}/{key}")
        want = json.loads(json.dumps(before))
        fn(want)
        try:
            req("POST", f"/set_parameter/{kind}/{key}", want)
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {kind}/{key}: POST {e}")
            bad += 1
            continue
        after = req("GET", f"/get_parameter/{kind}/{key}")
        ok = json.dumps(after, sort_keys=True) != json.dumps(before, sort_keys=True)
        print(("OK  " if ok else "NOOP") + f" {kind}/{key}")
        bad += 0 if ok else 1
    return bad


if __name__ == "__main__":
    sys.exit(1 if edit() else 0)
