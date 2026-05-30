"""
dev-395e: exercise the REAL dispatch chain end-to-end (minus HTTP transport + GPU upload):
   ParameterUpdateRequest(kind='string') -> ParameterManager.apply -> update_parameter('string')
   -> _raise_if_cfl_unstable  (the SAME chain /set_parameter/string/<pitch> and WS set_parameter run).

To run update_parameter WITHOUT a GPU we monkeypatch update_pitch_physical_params_GRANULAR to a no-op
APPLY recorder (the gate runs BEFORE that call at L623, so a no-op apply faithfully tests "did the gate
let it through?"). Confirms the gate fires through the real dispatch, not only when called directly.

Also tests payload variants that could slip a tension edit past the gate's pending-dict handling:
  - plain {pitch:{tension:X}} (frontend shape)
  - frontend-name keys (string_radius etc.) mixed with a big tension
  - a whole-range edit (key 'all'-style: pitches=[many], values keyed per-pitch) with ONE over-edge pitch
  - values keyed by INT vs STR pitch (the gate looks up values[str(pitchID)])

IN-PROC, no GPU, no ports.
Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-395e-cfl-apply-dispatch.py
"""
import os, sys, json, io, contextlib
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))
sys.path.insert(0, os.path.join(REPO, "PianoidCore", "pianoid_middleware"))

from StringMap import StringMap
from ModelParams import ModelParameters
from parameter_manager import ParameterManager, CflRejected, ParameterUpdateRequest

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes-MFeq.json")
with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters(); mp.update_params(**save['model_parameters'])
with contextlib.redirect_stdout(io.StringIO()):
    sm = StringMap(mp, **save)
pm = ParameterManager(pianoid=None, sm=sm, modes=None, mp=mp, cuda_lock=None)

# Record APPLY calls; the gate runs BEFORE this (L623), so this faithfully reports "gate passed -> applied".
applied = []
def fake_granular(pitchID, send_to_cuda=True, **params):
    applied.append((int(pitchID), dict(params)))
pm.update_pitch_physical_params_GRANULAR = fake_granular

P = 99               # most-vulnerable pitch
bt = float(sm.pitches[P].physics.tension)
print(f"pitch {P} baseline tension={bt:.2f}; gate rejects ~21.7x (coeff_T~1)\n")


def run_apply(kind, values, pitches):
    """REAL dispatch: ParameterManager.apply(request). Returns ('REJECT', amp) or ('APPLIED', n)."""
    applied.clear()
    req = ParameterUpdateRequest(kind=kind, values=values, pitches=pitches, modes=list(range(mp.num_modes)))
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            pm.apply(req)
        return ("APPLIED", len(applied), list(applied))
    except CflRejected as e:
        return ("REJECT", round(e.amplification, 3), f"pitch {e.pitch} string {e.string_index}")
    except Exception as e:
        return (f"CRASH:{type(e).__name__}", str(e), None)


print("--- Variant 1: plain single-pitch tension, BELOW edge (x10) vs ABOVE (x25) via REAL apply() ---")
print("  x10 :", run_apply('string', {str(P): {"tension": bt * 10}}, [P])[:2])
print("  x25 :", run_apply('string', {str(P): {"tension": bt * 25}}, [P])[:2])

print("\n--- Variant 2: over-edge tension + frontend-name keys mixed in ---")
r = run_apply('string', {str(P): {"tension": bt * 50, "string_radius": 0.0004, "string_stiffness": -2e11}}, [P])
print("  x50 + frontend-name keys :", r[:2])

print("\n--- Variant 3: whole-range edit (ONLY preset pitches), values keyed per-pitch, ONE over edge ---")
pitches = sorted(p for p in sm.pitches if 21 <= p <= 108)
vals = {str(p): {"tension": float(sm.pitches[p].physics.tension)} for p in pitches}
vals[str(P)] = {"tension": bt * 50}          # one pitch pushed over the edge
r = run_apply('string', vals, pitches)
print("  range with p99 over-edge :", r[:2])

print("\n--- Variant 3b: range INCLUDING a pitch not in the preset (gate robustness) ---")
# parse_range validates endpoints in all_pitches, but interior gaps can exist in sparse presets.
present = sorted(p for p in sm.pitches if 21 <= p <= 108)
gap = next((p for p in range(present[0], present[-1] + 1) if p not in sm.pitches), None)
if gap is not None:
    pitches_gap = list(range(present[0], present[-1] + 1))
    vals_gap = {str(p): {"tension": float(sm.pitches[p].physics.tension)} for p in present}
    r = run_apply('string', vals_gap, pitches_gap)
    print(f"  range w/ missing pitch {gap} :", r[:2],
          "  <-- KeyError crash (unhandled) if it raises" if r[0] not in ("APPLIED", "REJECT") else "")
else:
    print("  (no interior gap in this preset's piano range — skipped)")

print("\n--- Variant 4: values keyed by INT pitch (not str) — does the gate still see the edit? ---")
# the gate looks up values[str(pitchID)]; if the frontend/route ever passes int keys, str() lookup MISSES
r = run_apply('string', {P: {"tension": bt * 50}}, [P])
print("  int-keyed values, x50 :", r[:2],
      "  <-- if APPLIED, gate MISSED (str-key lookup) and the over-edge edit went through" if r[0] == "APPLIED" else "")

print("\n--- Variant 5: 'physics' kind alias (same branch) over-edge ---")
print("  physics x50 :", run_apply('physics', {str(P): {"tension": bt * 50}}, [P])[:2])
