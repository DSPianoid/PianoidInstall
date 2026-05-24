"""dev-preset-bugs — Bug #1 working-copy isolation repro (REST, against LIVE backend).

Reproduces the user's exact flow against the running backend on :5000 and
diffs state to localise the leak:

  1. /preset/list -> find the original entry name
  2. spawn working copy A from the ORIGINAL   (auto-switches to A)
  3. edit string/57 tension on A -> SENTINEL (999.0)
  4. switch to the ORIGINAL  (read-only)
  5. read string/57 on the ORIGINAL  -> must stay pristine (NOT sentinel)
  6. spawn working copy B from the ORIGINAL    (auto-switches to B)
  7. read string/57 on B -> must be pristine (NOT sentinel)   <-- the user's bug
  8. cleanup: unload A and B (leave the user's pre-existing entries intact)

Run:  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-preset-bugs-isolation-repro.py

This ADDS two working copies (A, B) and removes them again; it does not touch
the user's existing working copies or the original's on-disk JSON.
"""
import sys
import time
import requests

BASE = "http://127.0.0.1:5000"
PITCH = 57
SENTINEL = 999.0


def get_list():
    r = requests.get(f"{BASE}/preset/list", timeout=8)
    r.raise_for_status()
    return r.json()


def read_tension(pitch):
    r = requests.get(f"{BASE}/get_parameter/string/{pitch}", timeout=8)
    r.raise_for_status()
    data = r.json()
    return float(data[str(pitch)]["tension"]), data[str(pitch)]


def read_string_payload(pitch):
    r = requests.get(f"{BASE}/get_parameter/string/{pitch}", timeout=8)
    r.raise_for_status()
    return r.json()[str(pitch)]


def switch(name):
    r = requests.post(f"{BASE}/preset/switch", json={"name": name}, timeout=15)
    return r.status_code, r.json()


def spawn(source):
    r = requests.post(f"{BASE}/preset/spawn_working_copy", json={"source": source}, timeout=20)
    r.raise_for_status()
    return r.json()


def set_tension(pitch, payload):
    r = requests.post(f"{BASE}/set_parameter/string/{pitch}", json=payload, timeout=15)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)


def unload(name):
    r = requests.post(f"{BASE}/preset/unload", json={"name": name}, timeout=20)
    return r.status_code, r.json()


def active():
    return get_list()["active"]


def main():
    lst = get_list()
    originals = [p for p in lst["presets"] if p["kind"] == "original"]
    if not originals:
        print("NO ORIGINAL in library; cannot run repro.")
        sys.exit(2)
    original = originals[0]["name"]
    print(f"[setup] original = {original!r}; active = {lst['active']!r}")

    # Baseline pristine tension on the original.
    s, _ = switch(original)
    print(f"[setup] switch to original -> {s}; active now {active()!r}")
    pristine, pristine_payload = read_tension(PITCH)
    print(f"[setup] pristine string/{PITCH} tension on original = {pristine}")
    assert abs(pristine - SENTINEL) > 1.0, "pristine already equals sentinel; pick another sentinel"

    created = []
    try:
        # 2. spawn A from original (auto-switches to A)
        ra = spawn(original)
        a_name = ra["name"]
        created.append(a_name)
        print(f"\n[A] spawned {a_name!r}; active now {active()!r}")
        a_t0, _ = read_tension(PITCH)
        print(f"[A] tension on A right after spawn = {a_t0} (expect == pristine {pristine})")

        # 3. edit tension on A -> sentinel
        payload = dict(pristine_payload)
        payload["tension"] = SENTINEL
        sc, body = set_tension(PITCH, {**payload})
        # endpoint expects {pitch: {fields}} OR flat fields? Probe both shapes.
        if sc != 200:
            sc, body = set_tension(PITCH, {str(PITCH): payload})
        print(f"[A] set tension on A -> {SENTINEL}: status={sc} body={str(body)[:120]}")
        a_t1, _ = read_tension(PITCH)
        print(f"[A] tension on A after edit = {a_t1} (expect == {SENTINEL})")
        edit_landed = abs(a_t1 - SENTINEL) < 1.0

        # 4. switch to original
        s, _ = switch(original)
        print(f"\n[orig] switch back to original -> {s}; active {active()!r}")
        orig_t, _ = read_tension(PITCH)
        leak_into_original = abs(orig_t - SENTINEL) < 1.0
        print(f"[orig] tension on original after editing A = {orig_t} "
              f"({'LEAK!!! original mutated' if leak_into_original else 'OK pristine'})")

        # 6. spawn B from original (auto-switches to B)
        rb = spawn(original)
        b_name = rb["name"]
        created.append(b_name)
        print(f"\n[B] spawned {b_name!r} from original; active {active()!r}")
        b_t, _ = read_tension(PITCH)
        leak_into_B = abs(b_t - SENTINEL) < 1.0
        print(f"[B] tension on B after spawn-from-original = {b_t} "
              f"({'LEAK!!! B contains A edits (USER BUG REPRODUCED)' if leak_into_B else 'OK pristine'})")

        # 7. LATE-DEBOUNCED-WRITE hypothesis (round-2): the frontend does NOT
        #    cancel the per-pitch debounced /set_parameter write on a preset
        #    switch. If A's edit was still pending when the user switched+spawned,
        #    the debounce fires ~300ms later and POSTs onto whatever is active NOW
        #    (copy B). Simulate that late write landing while B is active.
        late_landed = False
        if not leak_into_B:
            print(f"\n[late] simulating A's stale debounced write firing while {b_name!r} active...")
            payload_late = dict(pristine_payload)
            payload_late["tension"] = SENTINEL
            sc, body = set_tension(PITCH, {str(PITCH): payload_late})
            if sc != 200:
                sc, body = set_tension(PITCH, {**payload_late})
            b_t2, _ = read_tension(PITCH)
            late_landed = abs(b_t2 - SENTINEL) < 1.0
            print(f"[late] late /set_parameter status={sc}; tension on B now={b_t2} "
                  f"({'LEAK PATH CONFIRMED — stale debounced write lands on B' if late_landed else 'rejected/no-effect'})")

        print("\n================ VERDICT ================")
        print(f"  edit landed on A:                 {edit_landed}")
        print(f"  leak into ORIGINAL:               {leak_into_original}")
        print(f"  leak into fresh copy B (on spawn):{leak_into_B}")
        print(f"  late debounced write lands on B:  {late_landed}")
        if leak_into_B or leak_into_original:
            print("  => ISOLATION BUG REPRODUCED at the backend (REST) level on spawn/switch.")
        elif late_landed:
            print("  => Spawn/switch backend isolation OK, BUT a stale debounced /set_parameter")
            print("     write CAN land on the newly-active copy. If the frontend doesn't cancel")
            print("     pending debounced writes on a preset transition, THIS is the leak path.")
        else:
            print("  => Backend isolation CORRECT and late-write rejected. Leak is elsewhere in FE.")
        print("=========================================")
    finally:
        # cleanup my own working copies; land on the original first
        try:
            switch(original)
        except Exception as e:
            print(f"[cleanup] switch-to-original failed: {e}")
        for n in created:
            try:
                sc, body = unload(n)
                print(f"[cleanup] unload {n!r}: {sc}")
            except Exception as e:
                print(f"[cleanup] unload {n!r} failed: {e}")
        print(f"[cleanup] final active = {active()!r}; final list = "
              f"{[p['name'] for p in get_list()['presets']]}")


if __name__ == "__main__":
    main()
