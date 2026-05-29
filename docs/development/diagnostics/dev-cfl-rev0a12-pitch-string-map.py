"""
rev-0a12: ground-truth the pitch->string mapping for pitches 55/56/57 (the 55-correct / 56-no-decay /
57-clicks per-pitch pattern). READ-ONLY model construction — loads the StringMap DOMAIN MODEL only,
NO GPU kernel, NO audio, NO ports (does not touch the user's live engine stack).

Prints per pitch: chore (#strings), stringIDs, CUDA string_index positions, block IDs + position-in-block,
and the geometry, so we can see what STRUCTURALLY differs across the 3 adjacent pitches. Hypothesis:
a strings-per-note (chore) transition or a block-boundary (num_strings_in_array=2 vs chore up to 3)
around 55-57 mis-aligns the excitation index vs the damper index.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-rev0a12-pitch-string-map.py [PRESET.json]
"""
import os, sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))

from StringMap import StringMap          # noqa
from ModelParams import ModelParameters  # noqa

PRESET = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    REPO, "PianoidCore", "pianoid_middleware", "presets", "Belarus_8band_196modes.json")

with open(PRESET) as f:
    save = json.load(f)
mp = ModelParameters()
mp.update_params(**save['model_parameters'])
sm = StringMap(mp, **save)

print(f"preset: {os.path.basename(PRESET)}")
print(f"num_strings_in_array (strings packed per block) = {mp.num_strings_in_array}")
print(f"array_size = {mp.array_size}")
try:
    print(f"string_index length (total CUDA strings) = {len(sm.string_index)}")
except Exception as e:
    print(f"string_index: {e}")

# chores array shape (140,3): pitch -> up to 3 CUDA string indices
chores = getattr(sm, 'chores', None)
print(f"chores shape = {getattr(chores, 'shape', None)}")

print()
hdr = f"{'pitch':>6}{'chore':>6}{'stringIDs':>16}{'cuda_idx(string_index pos)':>28}{'blockID/posInBlock':>22}"
print(hdr); print('-'*len(hdr))
for pitch in (53, 54, 55, 56, 57, 58, 59):
    if pitch not in sm.pitches:
        print(f"{pitch:>6}  NOT in preset")
        continue
    p = sm.pitches[pitch]
    sids = p.get_strings()
    chore_n = len(sids)
    # CUDA string_index position for each stringID
    cuda_idx = []
    for sid in sids:
        try:
            cuda_idx.append(sm.string_index.index(sid))
        except Exception:
            cuda_idx.append('?')
    # block id + position-in-block
    blk = []
    for sid in sids:
        try:
            b = sm.get_block_for_string(sid)
            bid = b.ID if hasattr(b, 'ID') else b
            pos = b.num_in_block(sid) if hasattr(b, 'num_in_block') else '?'
            blk.append(f"{bid}/{pos}")
        except Exception as e:
            blk.append(f"err")
    # chores-row (what the kernel batch uses)
    chrow = None
    if chores is not None:
        try:
            chrow = list(chores[pitch])
        except Exception:
            chrow = None
    print(f"{pitch:>6}{chore_n:>6}{str(sids):>16}{str(cuda_idx):>28}{str(blk):>22}  chores[{pitch}]={chrow}")

print()
print("WHAT TO LOOK FOR:")
print("- A chore-count CHANGE across 55/56/57 (e.g. 1->2->3): a note-off that damps only chore_n strings")
print("  while excitation hit a different count would leave a string ringing (56 'no decay').")
print("- cuda_idx NON-CONTIGUOUS or crossing a block boundary (num_strings_in_array=2): a 3-string note")
print("  whose strings span 2 blocks → if excitation/damper iterate differently, one string is orphaned.")
print("- chores[pitch] row containing a SENTINEL (-1 / 0 / repeat) in unused slots that the batch loop")
print("  mis-consumes → wrong string excited (57 'click' = excitation hit a near-empty/dummy string).")
print("- Compare 55 (works) as the baseline: its chore/idx/block layout is the 'correct' shape.")
