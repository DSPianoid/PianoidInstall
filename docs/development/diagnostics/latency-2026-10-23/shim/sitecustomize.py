"""lat-3636 timing shim - loaded ONLY when this folder is on PYTHONPATH of the backend process
(Python's standard sitecustomize hook; no Pianoid source is edited). Wraps the parameter-write
stages with epoch timestamps and appends them as JSONL to $LAT_TIMING_LOG.

Stages: WS/REST apply (backendServer._apply_parameter_request, runtime_params), edit_commit.commit
(+ undo HISTORY.begin/finish, journal record), ParameterManager methods, every C++ call the
ParameterManager makes (proxy around its pianoid object: waitForParameterUpdate, update*, set*),
cuda_lock wait/hold, CoefficientCache.seed/recompose.
"""
import functools
import importlib.abc
import importlib.machinery
import json
import os
import sys
import threading
import time

LOG = os.environ.get("LAT_TIMING_LOG")
if LOG:
    _buf = []
    _blk = threading.Lock()

    def _rec(name, t0, t1, **kw):
        d = {"n": name, "t0": t0, "t1": t1, "th": threading.current_thread().name}
        d.update(kw)
        with _blk:
            _buf.append(d)

    def _flusher():
        while True:
            time.sleep(0.5)
            with _blk:
                items = _buf[:]
                del _buf[:]
            if items:
                with open(LOG, "a") as f:
                    for it in items:
                        f.write(json.dumps(it, default=str) + "\n")

    threading.Thread(target=_flusher, daemon=True, name="lat-shim-flush").start()

    def timed(name, fn):
        if getattr(fn, "_lat", False):
            return fn

        @functools.wraps(fn)
        def w(*a, **k):
            t0 = time.time()
            try:
                return fn(*a, **k)
            finally:
                _rec(name, t0, time.time())
        w._lat = True
        return w

    class CppProxy:
        """Times every method call on the wrapped pybind object."""
        def __init__(self, obj):
            object.__setattr__(self, "_o", obj)

        def __getattr__(self, item):
            v = getattr(self._o, item)
            if callable(v):
                return timed("cpp." + item, v)
            return v

        def __setattr__(self, k, v):
            setattr(self._o, k, v)

    class LockProxy:
        def __init__(self, lock):
            self._l = lock
            self._t_acq = threading.local()

        def acquire(self, *a, **k):
            t0 = time.time()
            r = self._l.acquire(*a, **k)
            self._t_acq.t = time.time()
            _rec("cuda_lock.wait", t0, self._t_acq.t)
            return r

        def release(self):
            t = getattr(self._t_acq, "t", None)
            self._l.release()
            if t is not None:
                _rec("cuda_lock.hold", t, time.time())

        def __enter__(self):
            self.acquire()
            return self

        def __exit__(self, *e):
            self.release()

        def locked(self):
            return self._l.locked()

    PM_METHODS = ["update_parameter", "_gpu_upload", "_recompose_excitation_coefficients",
                  "_upload_excitation_coefficients", "_upload_excitation_rows_for_pitches",
                  "_upload_deck_rows_for_pitches", "send_deck_params_to_CUDA", "_send_deck_update",
                  "_send_hammer_update", "_upload_hammer_blocks_for_pitches", "send_hammer_params_to_CUDA",
                  "update_pitches_physical_params_GRANULAR", "_flush_gpu_write_plan",
                  "update_mode_params_GRANULAR", "_apply_pitch_physical_to_model", "_pitch_upload_amp",
                  "_collect_pitch_gpu_writes", "apply", "update_pitch_excitation",
                  # dev-elat1 (Phase 1): prepare -> one swap -> wait -> commit
                  "_upload_then_commit_coefficients", "_upload_excitation_curves", "_upload_hammer_for_pitches"]

    def _patch(modname, mod):
        if modname == "parameter_manager":
            PM = mod.ParameterManager
            for m in PM_METHODS:
                if hasattr(PM, m):
                    setattr(PM, m, timed("pm." + m, getattr(PM, m)))
            orig_init = PM.__init__

            def init(self, pianoid, sm, modes, mp, cuda_lock):
                orig_init(self, pianoid, sm, modes, mp, cuda_lock)
                self.pianoid = CppProxy(pianoid)
            PM.__init__ = init
        elif modname == "edit_commit":
            mod.commit = timed("edit_commit.commit", mod.commit)
            mod._record = timed("edit_commit._record(journal+after)", mod._record)
            mod._snapshot = timed("edit_commit._snapshot", mod._snapshot)
            H = mod.HISTORY
            for m in ("begin", "finish"):
                if hasattr(H, m):
                    setattr(H, m, timed("undo." + m, getattr(H, m)))
        elif modname == "excitation_coefficients":
            C = mod.CoefficientCache
            for m in ("seed", "recompose", "prepare", "commit"):
                if hasattr(C, m):
                    setattr(C, m, timed("coeff." + m, getattr(C, m)))
        elif modname == "runtime_params":
            mod.apply_runtime_parameters = timed("runtime.apply", mod.apply_runtime_parameters)
        elif modname == "StringMap" or modname.endswith(".StringMap"):
            S = getattr(mod, "StringMap", None)
            if S is not None:
                for m in ("pack_deck", "pack_base_excitations", "pack_hammers", "update_deck", "pack_pitch_feedin"):
                    if hasattr(S, m):
                        setattr(S, m, timed("sm." + m, getattr(S, m)))

    TARGETS = {"parameter_manager", "edit_commit", "excitation_coefficients", "runtime_params"}

    class Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path, target=None):
            short = fullname.rsplit(".", 1)[-1]
            if fullname not in TARGETS and short != "StringMap":
                return None
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            if spec is None or spec.loader is None:
                return spec
            orig = spec.loader.exec_module

            def exec_module(module, _orig=orig, _name=fullname):
                _orig(module)
                try:
                    _patch(_name, module)
                except Exception as e:  # never break the backend
                    print("[lat-shim] patch failed", _name, e)
            spec.loader.exec_module = exec_module
            return spec

    sys.meta_path.insert(0, Finder())

    def _late():
        """Patch __main__ (backendServer) helpers + the cuda_lock once they exist."""
        main = sys.modules.get("__main__")
        done_apply = False
        while True:
            time.sleep(0.2)
            main = sys.modules.get("__main__")
            if main is None:
                continue
            if not done_apply and hasattr(main, "_apply_parameter_request"):
                main._apply_parameter_request = timed("main._apply_parameter_request", main._apply_parameter_request)
                if hasattr(main, "parse_range"):
                    main.parse_range = timed("main.parse_range", main.parse_range)
                done_apply = True
                print("[lat-shim] __main__ patched")
            p = getattr(main, "pianoid", None)
            pm = getattr(p, "param_manager", None) if p is not None else None
            if pm is not None and not isinstance(pm.cuda_lock, LockProxy):
                lp = LockProxy(pm.cuda_lock)
                pm.cuda_lock = lp
                print("[lat-shim] cuda_lock proxied on ParameterManager")

    threading.Thread(target=_late, daemon=True, name="lat-shim-late").start()
    print("[lat-shim] active ->", LOG)
