"""dev-elat1 offline harness (audio_off, in-process, ONE Pianoid per process).

Run once per code version (baseline Core worktree vs the feature worktree) and compare the outputs:

    python -u dev-elat1-offline.py <core_dir> <out.npz> [reps]

Phases
  A. coefficient-live check: scale the resident coefficient table x0.5 with NO swap, render -> the note
     must come out x0.5 (proves excitation_coefficients_ is a host table that is live at the next note).
  B. bit-identical sequence: 8 cumulative edits (gauss n1/n1/n8/n12/n88, hammer n1/n12/n88) through
     ParameterManager.update_parameter; after each one render p60 v127, p57 v95, p100 v63 offline and keep
     the buffers + the coefficient table (cache.flat). Compare two runs with dev-elat1-compare.py.
  C. timing: per case, `reps` x (new, old) update_parameter calls -> wall ms, call trace (swap count,
     rows-queued -> coefficient-commit gap) and a GIL probe thread (sleep(1 ms) overshoot = how long a
     concurrent Python thread was kept off the interpreter during the write).
"""
import json
import os
import sys
import threading
import time

import numpy as np

CORE = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2])
REPS = int(sys.argv[3]) if len(sys.argv) > 3 else 5
MW = os.path.join(CORE, "pianoid_middleware")
sys.path.insert(0, MW)
os.chdir(MW)

from pianoid import initialize  # noqa: E402
from PanoidResult import PianoidResult  # noqa: E402
import pianoidCuda  # noqa: E402

PRESET = os.path.join(MW, "presets", "Tuning18-10-26ver1.json")
p = initialize(PRESET, filterlen=48 * 128 * 3, string_iteration=8, array_size=512, sample_rate=48000,
               samples_in_cycle=64, buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0,
               listen_to_modes=False)
pm = p.param_manager
real = pm.pianoid
print("engine up; strings", len(p.sm.string_index), flush=True)


# ------------------------------------------------------------------ call-trace proxy
class Proxy:
    """Delegates to the pybind engine and timestamps the calls this task cares about."""
    TRACED = {"waitForParameterUpdate", "setNewExcitationBaseLevels", "updateExcitationBaseLevelsForString",
              "setNewExcitationCoefficients", "setNewHammerParameters", "updateHammerBlockRow",
              "isParameterUpdateInProgress"}

    def __init__(self, obj):
        object.__setattr__(self, "_o", obj)
        object.__setattr__(self, "log", [])

    def __getattr__(self, name):
        attr = getattr(self._o, name)
        if name not in Proxy.TRACED or not callable(attr):
            return attr
        log = self.log

        def wrapped(*a, **k):
            t0 = time.perf_counter()
            r = attr(*a, **k)
            log.append((name, t0, time.perf_counter()))
            return r
        return wrapped


proxy = Proxy(real)
pm.pianoid = proxy


# ------------------------------------------------------------------ offline render
def render(pitch, vel, note_ms=400, total_ms=700):
    sr, spc = 48000, 64
    q = pianoidCuda.EventQueue()
    for cyc, typ, v in ((0, pianoidCuda.EventType.NOTE_ON, vel),
                        (max(1, int(note_ms / 1000 * sr / spc)), pianoidCuda.EventType.NOTE_OFF, 0)):
        e = pianoidCuda.PlaybackEvent()
        e.channel, e.cycle_index, e.type, e.data = 0, cyc, typ, (pitch << 8) | v
        q.addEvent(e)
    q.sortByCycle()
    c = pianoidCuda.PlaybackConfig()
    c.audio_enabled, c.record_to_buffer = False, True
    c.max_duration_ms, c.sample_rate, c.samples_per_cycle = total_ms + 200, sr, spc
    with p.cuda_lock:
        real.waitForParameterUpdate()
        real.resetStringsState()
        real.runSynthesisKernel()
        real.clearRecords()
        st = real.runOfflinePlayback(q, c)
        assert st.completed_successfully, st.error_message
        r = PianoidResult(real, p.mp)
        r.load_offline_sound_from_pianoid()
    return np.asarray(r.sound, dtype=np.float32)


NOTES = [(60, 127), (57, 95), (100, 63)]
out = {}

# ------------------------------------------------------------------ A. coefficient-live check
a0 = render(60, 127)
r0 = render(60, 127)
out["A_repeat_identical"] = bool(np.array_equal(a0, r0))
out["A_repeat_maxdiff_rel"] = float(np.max(np.abs(a0 - r0)) / (np.max(np.abs(a0)) + 1e-30))
cache = pm._coeff_cache
flat0 = list(cache.flat)
with p.cuda_lock:
    real.setNewExcitationCoefficients([v * 0.5 for v in flat0])   # host table only, no swap issued
a1 = render(60, 127)
with p.cuda_lock:
    real.setNewExcitationCoefficients(flat0)
a2 = render(60, 127)
peak = float(np.max(np.abs(a0))) + 1e-30
out["A_ratio_rms"] = float(np.sqrt(np.mean(a1.astype(np.float64) ** 2)) / np.sqrt(np.mean(a0.astype(np.float64) ** 2)))
out["A_max_dev_from_half"] = float(np.max(np.abs(a1 - 0.5 * a0)) / peak)
out["A_restored_identical"] = bool(np.array_equal(a0, a2))
print("A", {k: v for k, v in out.items()}, flush=True)


# ------------------------------------------------------------------ edits
def gauss_vals(pitches, level, curve, field, f):
    idx = {"mu": 0, "sigma": 1, "volume": 2, "shift": 3}[field]
    return {str(q): {level: {curve: {field: float(p.sm.pitches[q].excitation.levels_matrix[level, idx, curve]) * f}}}
            for q in pitches}


def keys(lo, hi):
    return [q for q in range(lo, hi + 1) if q in p.sm.pitches]


def ham_vals(pitches, field, fn):
    from hammer_payload import _stored
    return {str(q): {"hammer": {"hammer_" + field: fn(float(_stored(p.sm.pitches[q].physics.hammer, field)))}}
            for q in pitches}


EDITS = [
    ("gauss", keys(60, 60), lambda ps: gauss_vals(ps, 127, 2, "volume", 0.5)),
    ("gauss", keys(60, 60), lambda ps: gauss_vals(ps, 127, 2, "sigma", 1.5)),
    ("gauss", keys(57, 64), lambda ps: gauss_vals(ps, 95, 1, "mu", 1.1)),
    ("gauss", keys(55, 66), lambda ps: gauss_vals(ps, 127, 3, "volume", 0.7)),
    ("gauss", keys(21, 108), lambda ps: gauss_vals(ps, 63, 2, "sigma", 1.2)),
    ("hammer", keys(60, 60), lambda ps: ham_vals(ps, "position", lambda v: 0.25)),
    ("hammer", keys(55, 66), lambda ps: ham_vals(ps, "width", lambda v: v * 1.2)),
    ("hammer", keys(21, 108), lambda ps: ham_vals(ps, "sharpness", lambda v: 0.8)),
]

# ------------------------------------------------------------------ B. bit-identical sequence
for i, (kind, ps, mk) in enumerate(EDITS):
    pm.update_parameter(kind, mk(ps), pitches=ps)
    for (q, v) in NOTES:
        out[f"B_e{i}_p{q}_v{v}"] = render(q, v)
        # gaussKernel's force function of every string of the struck pitch (deterministic: no atomics);
        # = the excitation curve (dev_gauss_params_full) x the per-(string,level) coefficient.
        out[f"B_e{i}_p{q}_v{v}_force"] = np.stack(
            [np.asarray(real.fetchExcitation(int(s), -1), dtype=np.float32)
             for s in real.getStringIndicesForPitch(q)])
    out[f"B_e{i}_coeff"] = np.asarray(cache.flat, dtype=np.float64)
    print("B edit", i, kind, len(ps), "rendered", flush=True)


# ------------------------------------------------------------------ C. timing + GIL probe
class GilProbe:
    def __init__(self):
        self.stop = False
        self.samples = []

    def run(self):
        while not self.stop:
            t0 = time.perf_counter()
            time.sleep(0.001)
            self.samples.append((t0, (time.perf_counter() - t0 - 0.001) * 1e3))

    def __enter__(self):
        self.th = threading.Thread(target=self.run, daemon=True)
        self.th.start()
        time.sleep(0.05)
        return self

    def __exit__(self, *a):
        self.stop = True
        self.th.join()


def trace_metrics(log, t_start):
    swaps = [e for e in log if e[0] in ("setNewExcitationBaseLevels", "updateExcitationBaseLevelsForString",
                                        "setNewHammerParameters", "updateHammerBlockRow")]
    coeff = [e for e in log if e[0] == "setNewExcitationCoefficients"]
    waits = [e for e in log if e[0] == "waitForParameterUpdate"]
    m = {"uploads": len(swaps), "waits": len(waits),
         "wait_ms": sum((e[2] - e[1]) * 1e3 for e in waits)}
    if swaps and coeff:
        last_q = max(e[2] for e in swaps)
        m["rows_queued_to_coeff_ms"] = (coeff[-1][2] - last_q) * 1e3
        # swap landed = end of the first post-upload wait, or of the last post-upload state poll
        later_waits = [e for e in waits if e[1] >= last_q]
        polls = [e for e in log if e[0] == "isParameterUpdateInProgress" and e[1] >= last_q]
        done = later_waits[0][2] if later_waits else (polls[-1][2] if polls else None)
        m["swap_done_to_coeff_ms"] = ((coeff[-1][2] - done) * 1e3) if done else None
        m["swap_wait_ms"] = ((done - last_q) * 1e3) if done else None
        m["coeff_after_ms"] = (coeff[-1][2] - t_start) * 1e3
    return m


CASES = {
    "gauss|n1": ("gauss", keys(60, 60), 127, 2), "gauss|n8": ("gauss", keys(57, 64), 127, 2),
    "gauss|n12": ("gauss", keys(55, 66), 127, 2), "gauss|n88": ("gauss", keys(21, 108), 127, 2),
    "hammer|n1": ("hammer", keys(60, 60)), "hammer|n12": ("hammer", keys(55, 66)),
    "hammer|n88": ("hammer", keys(21, 108)),
}
timing = {}
for name, spec in CASES.items():
    kind, ps = spec[0], spec[1]
    if kind == "gauss":
        new, old = gauss_vals(ps, 127, 2, "volume", 0.5), gauss_vals(ps, 127, 2, "volume", 1.0)
    else:
        new, old = ham_vals(ps, "position", lambda v: 0.27), ham_vals(ps, "position", lambda v: v)
    rows = []
    for rep in range(REPS):
        for tag, vals in (("new", new), ("old", old)):
            proxy.log.clear()
            with GilProbe() as g:
                t0 = time.perf_counter()
                pm.update_parameter(kind, vals, pitches=ps)
                t1 = time.perf_counter()
                time.sleep(0.03)
            during = [s[1] for s in g.samples if t0 - 0.002 <= s[0] <= t1]
            row = {"tag": tag, "ms": (t1 - t0) * 1e3, "gil_max_ms": max(during) if during else 0.0,
                   "gil_p50_ms": float(np.median(during)) if during else 0.0, "gil_n": len(during)}
            row.update(trace_metrics(list(proxy.log), t0))
            rows.append(row)
            time.sleep(0.15)
    timing[name] = rows
    nm = [r["ms"] for r in rows if r["tag"] == "new"]
    gm = [r["gil_max_ms"] for r in rows if r["tag"] == "new"]
    print(f"C {name:10s} ms med {np.median(nm):7.1f} [{min(nm):.1f}-{max(nm):.1f}]  gil_max med {np.median(gm):6.1f} "
          f"[{min(gm):.1f}-{max(gm):.1f}]  uploads {rows[0]['uploads']}  q->coeff {rows[0].get('rows_queued_to_coeff_ms')}"
          f"  swapdone->coeff {rows[0].get('swap_done_to_coeff_ms')}", flush=True)

np.savez_compressed(OUT, **{k: v for k, v in out.items() if isinstance(v, np.ndarray)})
with open(OUT.replace(".npz", ".json"), "w") as f:
    json.dump({"A": {k: v for k, v in out.items() if k.startswith("A_")}, "C": timing}, f, indent=1, default=float)
print("saved", OUT, flush=True)
try:
    real.shutdownGpu()
except Exception:
    pass
