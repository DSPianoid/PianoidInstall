"""dev-strbatch drop measurement — strings-panel range/rapid edits vs DROP_IF_BUSY.

Measures how many per-string GPU uploads are silently DROPPED (updateMultiStringParameter_NEW
returning False under the default DROP_IF_BUSY policy) across:
  (1) a 12-pitch range tension edit,
  (2) a 24-pitch range tension edit,
  (3) 200 rapid single-pitch tension edits,
  (4) a multi-param (tension+stiffness+damping) 12-pitch edit.

Also records the per-edit wall latency and, for the batched path, exactly which string
indices land in the ONE upload (proof every pitch reached the GPU in one swap).

Run from PianoidCore with the project venv. Audio_off, in-process GPU (clean, single backend).
Re-run after the batch fix lands to get the AFTER numbers from the same script.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.path.abspath(os.path.join(HERE, "..", "..", "..", "PianoidCore"))
MIDDLEWARE = os.path.join(CORE, "pianoid_middleware")
for p in (CORE, MIDDLEWARE):
    if p not in sys.path:
        sys.path.insert(0, p)

os.chdir(MIDDLEWARE)
from pianoid import initialize  # noqa: E402

PRESET = os.path.join(MIDDLEWARE, "presets", "Preset_test5.json")


class _PianoidProxy:
    """Forwards every attribute to the real pybind Pianoid, but intercepts
    updateMultiStringParameter_NEW to record calls + drops (the C++ object's
    attributes are read-only, so we proxy at the param_manager.pianoid ref)."""

    def __init__(self, real, calls):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_calls", calls)

    def updateMultiStringParameter_NEW(self, param_name, string_indices, new_values):
        ok = self._real.updateMultiStringParameter_NEW(param_name, string_indices, new_values)
        self._calls.append((param_name, len(string_indices), tuple(string_indices), bool(ok)))
        return ok

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_real"), name)


class UploadRecorder:
    """Install a proxy on p.param_manager.pianoid for the duration of a with-block."""

    def __init__(self, p):
        self.p = p
        self.calls = []  # (param_name, n_indices, indices_tuple, success)

    def __enter__(self):
        pm = self.p.param_manager
        self._real = pm.pianoid
        pm.pianoid = _PianoidProxy(self._real, self.calls)
        return self

    def __exit__(self, *a):
        self.p.param_manager.pianoid = self._real

    def summary(self):
        n = len(self.calls)
        dropped = sum(1 for c in self.calls if not c[3])
        return n, dropped


def _tension(p, pid):
    return float(p.sm.pitches[pid].physics.tension)


def run_case(p, label, pitches, factor):
    vals = {str(pi): {"tension": _tension(p, pi) * factor} for pi in pitches}
    with UploadRecorder(p) as rec:
        t0 = time.perf_counter()
        p.update_parameter("string", vals, pitches=pitches)
        dt_ms = (time.perf_counter() - t0) * 1000.0
    n, dropped = rec.summary()
    # union of all string indices carried by SUCCESSFUL uploads (reached GPU)
    reached = set()
    for pn, _n, idx, ok in rec.calls:
        if ok:
            reached.update(idx)
    # expected string indices for these pitches
    expected = set()
    for pi in pitches:
        for sid in p.sm.pitches[pi].stringIDs:
            expected.add(p.sm.string_index.index(sid))
    missing = len(expected - reached)
    print(f"[{label}] pitches={len(pitches)} calls={n} dropped={dropped} "
          f"latency={dt_ms:.1f}ms strings_expected={len(expected)} strings_reached_GPU={len(reached)} "
          f"strings_missing={missing}")
    # restore
    restore = {str(pi): {"tension": _tension(p, pi) / factor} for pi in pitches}
    p.update_parameter("string", restore, pitches=pitches)
    return dict(label=label, calls=n, dropped=dropped, latency_ms=dt_ms,
                expected=len(expected), reached=len(reached), missing=missing)


def run_rapid_single(p, label, pitch, count):
    base = _tension(p, pitch)
    dropped = 0
    calls = 0
    with UploadRecorder(p) as rec:
        t0 = time.perf_counter()
        for i in range(count):
            f = 0.8 + 0.4 * (i % 2)  # alternate two values
            p.update_parameter("string", {str(pitch): {"tension": base * f}}, pitches=[pitch])
        dt_ms = (time.perf_counter() - t0) * 1000.0
    calls, dropped = rec.summary()
    print(f"[{label}] edits={count} calls={calls} dropped={dropped} "
          f"total={dt_ms:.1f}ms per_edit={dt_ms/count:.2f}ms")
    p.update_parameter("string", {str(pitch): {"tension": base}}, pitches=[pitch])
    return dict(label=label, calls=calls, dropped=dropped, latency_ms=dt_ms)


def run_multiparam(p, label, pitches):
    vals = {}
    for pi in pitches:
        ph = p.sm.pitches[pi].physics
        vals[str(pi)] = {
            "tension": float(ph.tension) * 0.9,
            "string_stiffness": float(ph.jung) * 1.05,
            "string_damping": float(ph.gamma) * 1.05,
        }
    with UploadRecorder(p) as rec:
        t0 = time.perf_counter()
        p.update_parameter("string", vals, pitches=pitches)
        dt_ms = (time.perf_counter() - t0) * 1000.0
    n, dropped = rec.summary()
    by_param = {}
    for pn, _n, idx, ok in rec.calls:
        by_param.setdefault(pn, [0, 0])
        by_param[pn][0] += 1
        if not ok:
            by_param[pn][1] += 1
    print(f"[{label}] pitches={len(pitches)} calls={n} dropped={dropped} latency={dt_ms:.1f}ms "
          f"per_param={dict((k, f'{v[0]}calls/{v[1]}drop') for k, v in by_param.items())}")
    return dict(label=label, calls=n, dropped=dropped, latency_ms=dt_ms)


def main():
    print("Initializing audio_off GPU pianoid (Preset_test5)...")
    p = initialize(
        PRESET, filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
        sample_rate=48000, samples_in_cycle=64, buffer_size=4, max_volume=5e18,
        audio_on=False, audio_driver_type=0,
    )
    print("GPU ready.\n=== DROP MEASUREMENT ===")
    results = []
    results.append(run_case(p, "range12-tension", list(range(48, 60)), 0.6))
    results.append(run_case(p, "range24-tension", list(range(40, 64)), 0.6))
    results.append(run_multiparam(p, "range12-multiparam", list(range(48, 60))))
    results.append(run_rapid_single(p, "rapid200-single", 60, 200))
    print("\n=== DONE ===")
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
