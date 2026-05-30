"""
dev-eac2: VERIFY the CFL flag is cleared on a PRESET SWITCH (user 2720 Task 2).

PURE PYTHON — NO GPU/Flask/socketio/real-engine. The C++ binding (Pianoid.pianoid) is a recording mock so
switch_preset's engine calls (switchPreset/saveActiveToLibrary/getActivePreset/waitForParameterUpdate) are
no-ops; the rest of switch_preset (Python domain-model swap + param_manager bookkeeping + the new
_clear_cfl_redline call) runs for real.

Cases:
  (1) LIBRARY SWITCH (Pianoid.switch_preset): set cfl_redline=True, switch to another library preset,
      assert cfl_redline == False (the new self.param_manager._clear_cfl_redline() in switch_preset).
  (2) APPLY (POST /load_preset): the route recreates the Pianoid → fresh ParameterManager has
      cfl_redline=False; we assert a fresh ParameterManager starts clean AND that the explicit
      _clear_cfl_redline() the route calls leaves it clean (defensive no-op).

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-eac2-cfl-preset-switch-reset.py
"""
import os, sys, io, json, contextlib, threading

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager

results = []

# ---------------------------------------------------------------------------------------------------------
# Case 2 first (simplest): a fresh ParameterManager starts with cfl_redline=False, and the explicit clear the
# /load_preset route calls is a safe no-op. (APPLY recreates the Pianoid -> fresh param_manager.)
# ---------------------------------------------------------------------------------------------------------
print("=== Case 2: APPLY / load_preset — fresh ParameterManager starts clean + explicit clear is safe ===")
PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
save = json.load(open(PRESET))
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)
pm_fresh = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=threading.Lock())
ok2a = (pm_fresh.cfl_redline is False and pm_fresh.cfl_redline_info is None)
print(f"  [{'PASS' if ok2a else 'FAIL'}] fresh ParameterManager: cfl_redline={pm_fresh.cfl_redline} info={pm_fresh.cfl_redline_info}")
# the route's explicit call:
pm_fresh._clear_cfl_redline()
ok2b = (pm_fresh.cfl_redline is False)
print(f"  [{'PASS' if ok2b else 'FAIL'}] route's explicit _clear_cfl_redline() keeps it clean: cfl_redline={pm_fresh.cfl_redline}")
results += [ok2a, ok2b]

# ---------------------------------------------------------------------------------------------------------
# Case 1: LIBRARY SWITCH via the REAL Pianoid.switch_preset with a mocked C++ binding + a 2-entry library.
# ---------------------------------------------------------------------------------------------------------
print("\n=== Case 1: LIBRARY SWITCH (Pianoid.switch_preset) clears a stale cfl_redline ===")
from pianoid import Pianoid


class FakeCpp:
    """Recording mock of the C++ Pianoid binding — engine calls are no-ops."""
    def __init__(self): self._active = "A"
    def waitForParameterUpdate(self): pass
    def getActivePreset(self): return self._active
    def saveActiveToLibrary(self): pass
    def switchPreset(self, name, async_switch=True): self._active = name; return True
    def setRuntimeParameters(self, *a, **k): pass
    def getMainVolumeLevel(self): return 64
    def getDeckFeedbackCoefficient(self): return 1.0
    def getRuntimeParameters(self):
        class RP:  # minimal stand-in for the C++ RuntimeParameters struct
            volume_level = 64; volume_center = 1.0; volume_range = 10.0
            deck_feedback_coefficient = 1.0
        return RP()
    def getMainVolumeCoefficient(self): return 1.0
    def __getattr__(self, name):
        # any other engine call switch_preset's volume/feedback tail makes -> no-op returning a benign scalar
        return lambda *a, **k: 1.0


# Build a Pianoid shell without running its real __init__/engine: set just what switch_preset touches.
p = Pianoid.__new__(Pianoid)
p.pianoid = FakeCpp()
p.cuda_lock = threading.Lock()

# Build TWO library entries (A active, B target) sharing the same sm/modes/mp (enough for switch_preset).
mp2 = ModelParameters(); mp2.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    smB = StringMap(mp2, **save)


class Entry:
    def __init__(self, sm, modes, mp): self.sm, self.modes, self.mp = sm, modes, mp


class Lib:
    """Minimal stand-in for the preset library used by switch_preset."""
    def __init__(self, entries): self._e = entries
    def __contains__(self, name): return name in self._e
    def is_editable(self, name): return False   # originals -> no saveActiveToLibrary write
    def get(self, name): return self._e[name]


p._library = Lib({"A": Entry(sm, None, mp), "B": Entry(smB, None, mp2)})
p.sm, p.modes, p.mp = sm, None, mp
# Real ParameterManager; stub send_deck_params_to_CUDA so no GPU is touched.
pm = ParameterManager(pianoid=p.pianoid, sm=sm, modes=None, mp=mp, cuda_lock=p.cuda_lock)
pm.send_deck_params_to_CUDA = lambda *a, **k: None
p.param_manager = pm

# Some switch_preset tails (volume restore) may touch helpers; stub the ones that would hit the engine.
p.get_current_volume_coefficient = lambda *a, **k: 1.0
for name in ("_snapshot_global_volume", "_restore_global_volume", "set_main_volume",
             "set_deck_feedback", "_restore_global_feedback"):
    if not hasattr(p, name):
        setattr(p, name, lambda *a, **k: None)

# Raise the flag (simulate an unstable edit on preset A), then switch to B.
pm._set_cfl_redline(99, 0, 1.5, 1.2)
flag_before = pm.cfl_redline
err = None
with contextlib.redirect_stdout(io.StringIO()):
    try:
        p.switch_preset("B", async_switch=False)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
flag_after = pm.cfl_redline
ok1 = (flag_before is True and flag_after is False and err is None)
print(f"  flag before switch={flag_before}  after switch={flag_after}  switch_preset error={err}")
print(f"  [{'PASS' if ok1 else 'FAIL'}] library switch_preset CLEARS the stale cfl_redline")
if err:
    print(f"     (NOTE: if switch_preset raised after the deck-repack+clear line, the clear still ran; "
          f"err is from a later volume-restore stub. flag_after is the real signal.)")
results.append(ok1)

print("\n==================== SUMMARY ====================")
labels = ["Case2a fresh ParameterManager clean", "Case2b APPLY explicit clear safe",
          "Case1 library switch_preset clears flag"]
for lab, rr in zip(labels, results):
    print(f"  {'PASS' if rr else 'FAIL'}  {lab}")
print(f"\n  ALL PASS: {all(results)}")
sys.exit(0 if all(results) else 1)
