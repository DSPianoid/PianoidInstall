"""dev-12a5: REST scenario matrix for the preset library (live backend).

Usage: python dev-12a5-library_matrix.py <second_preset_rel_path> [switch_rounds]
Precondition: a preset is loaded (its original + "(working 1)"); <second_preset> has the
same string layout. Prints PASS/FAIL per scenario. Mutates <second_preset>'s file
(save-over / promote) — pass a scratch copy.
"""
import json
import os
import sys
import urllib.error
import urllib.request

B = "http://127.0.0.1:5000"


def rq(m, p, body=None):
    r = urllib.request.Request(B + p, data=None if body is None else json.dumps(body).encode(),
                               method=m, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=180) as x:
            return x.status, json.loads(x.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def lib():
    d = rq("GET", "/preset/list")[1]
    return d["active"], {p["name"]: p for p in d["presets"]}


def tension():
    return rq("GET", "/get_parameter/string/60")[1]["60"]["tension"]


def set_tension(v):
    g = rq("GET", "/get_parameter/string/60")[1]
    g["60"]["tension"] = v
    return rq("POST", "/set_parameter/string/60", g)[0]


RESULTS = []


def check(name, cond, info=""):
    RESULTS.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {info}")


def main():
    second = sys.argv[1]
    rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    name2 = os.path.splitext(os.path.basename(second))[0]
    active0, entries0 = lib()

    s, r = rq("POST", "/preset/load", {"path": second, "name": name2})
    check("L1 add original to library", s == 200 and name2 in lib()[1], s)
    s, r = rq("POST", "/preset/spawn_working_copy", {"source": name2})
    w2 = r.get("name")
    check("L2 spawn working copy (auto-activated)", s == 200 and lib()[0] == w2, w2)
    check("L2b working record carries source_path",
          lib()[1][w2].get("source_path", "").endswith(os.path.basename(second)))
    t0 = tension()
    check("L3 edit on working copy", set_tension(t0 * 1.05) == 200)
    rq("POST", "/preset/switch", {"name": active0})
    rq("POST", "/preset/switch", {"name": w2})
    check("L4 edit survives switch away/back", abs(tension() - t0 * 1.05) < 1e-9)
    rq("POST", "/preset/switch", {"name": name2})
    check("L5 edit on original rejected 409", set_tension(1.0) == 409)
    s, r = rq("POST", "/preset/promote", {"name": w2})
    check("L6 promote while ORIGINAL active -> original shows promoted value",
          s == 200 and lib()[0] == name2 and abs(tension() - t0 * 1.05) < 1e-9, f"{tension():.4f}")
    rq("POST", "/preset/switch", {"name": w2})
    check("L7 save-over own original (working copy -> source file) refreshes original",
          set_tension(t0 * 1.10) == 200 and rq("POST", "/save_preset", {"path": second})[1].get("refreshed_original") == name2)
    rq("POST", "/preset/switch", {"name": name2})
    check("L7b original serves the saved value", abs(tension() - t0 * 1.10) < 1e-9, f"{tension():.4f}")
    s, r = rq("POST", "/preset/unload", {"name": name2})
    check("L8 unload ACTIVE original -> lands on its own working copy", s == 200 and r.get("active") == w2, r.get("active"))
    s, r = rq("POST", "/preset/promote", {"name": w2})
    check("L9 promote after original unloaded -> still writes source file", s == 200, r.get("message"))
    # switch stress
    names = list(lib()[1])
    ref = {}
    for n in names:
        rq("POST", "/preset/switch", {"name": n})
        ref[n] = tension()
    bad = 0
    for i in range(rounds):
        n = names[(i * 7 + i // 3) % len(names)]
        s, _ = rq("POST", "/preset/switch", {"name": n})
        bad += not (s == 200 and lib()[0] == n and tension() == ref[n])
    check(f"L10 switch stress x{rounds} over {len(names)} entries", bad == 0, f"bad={bad}")
    s, r = rq("POST", "/preset/unload", {"name": w2})
    check("L11 unload working copy", s == 200)
    # unload until one remains, then the last must 409
    while len(lib()[1]) > 1:
        a, ents = lib()
        victim = next(n for n in ents if n != a) if len(ents) > 1 else a
        rq("POST", "/preset/unload", {"name": victim})
        if len(lib()[1]) == len(ents):
            break
    last = list(lib()[1])
    s, r = rq("POST", "/preset/unload", {"name": last[0]})
    check("L12 last preset cannot be unloaded (409)", s == 409 and len(last) == 1, r.get("message"))
    h = rq("GET", "/health")[1]
    check("L13 engine healthy after matrix", not h.get("exception") and h.get("backend_thread_running"))
    print(f"\n{sum(ok for _, ok in RESULTS)}/{len(RESULTS)} PASS")
    return all(ok for _, ok in RESULTS)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
