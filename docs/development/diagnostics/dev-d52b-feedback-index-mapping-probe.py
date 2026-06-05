"""
dev-d52b READ-ONLY index-mapping probe (M2) — NO GPU, NO pianoidCuda import.

Goal: nail the high-stakes index fact for the feedback-over-sound-channels fix:
  At MainKernel.cu:254  mode_feedback[i] = mode_coefficients[ foldedIndexInQuarter[i]*numModes + modeNo ] * deck_feedback_coeff
  -> for a given feedback TARGET string index `foldedIndexInQuarter[i]`, is that target an OUTPUT/sound string?

Approach (pure Python, builds the same StringMap the middleware builds; constructor does NOT import pianoidCuda):
  - Build Pianoid(preset=...) WITHOUT init_pianoid (no GPU).
  - Dump sm.pitch_index (the per-string -> pitch map used to build the packed mode_coefficients matrix),
    sm.string_index, sm.soundPitches / keyPitches, and pitch.outerSound per row.
  - Confirm: the packed mode_coefficients matrix is np.stack([pack_pitch_feedin(p) for p in pitch_index]),
    so ROW index == position in pitch_index, and `foldedIndexInQuarter[i]` indexes that SAME space.
  - Report the exact output-string row indices + the gate predicate.

This script ONLY reads/builds in-process; it writes nothing, touches no GPU, opens no ports.
"""
import os, sys, json

REPO = r"D:/repos/PianoidInstall"
MW = os.path.join(REPO, "PianoidCore", "pianoid_middleware")
PB = os.path.join(REPO, "PianoidBasic")
# `Pianoid` is pip-installed in the venv (site-packages/Pianoid), so `from Pianoid import StringMap`
# and its internal bare imports resolve via the installed package. We only need the middleware dir on
# path (for `pianoid`, `utilities`, etc.). Do NOT add PB/Pianoid — it shadows middleware `utilities`.
os.chdir(MW)
if MW not in sys.path:
    sys.path.insert(0, MW)

PRESET = os.path.join(MW, "presets", "Belarus_8band_196modes.json")

import numpy as np

# Import the middleware Pianoid class WITHOUT triggering pianoidCuda (constructor is GPU-free; import is lazy).
from pianoid import Pianoid

with open(PRESET) as f:
    preset = json.load(f)

# Build the model exactly as initialize() does, but DO NOT call init_pianoid (which would import pianoidCuda).
pno = Pianoid(
    preset=preset,
    string_iteration=12,
    array_size=384,
    sr=48000,
    mode_iteration=128,
    buffer_size=2,
    listen_to_modes=False,   # strings-listen mode = the audio-output-via-feedback path under review
    sound_derivative_order=1,
)
pno.mp.set_num_modes(pno.mp.num_modes, pno.mp.num_strings)

sm = pno.sm
print("=== MODEL ===")
print("num_modes        :", sm.mp.num_modes)
print("num_strings      :", sm.mp.num_strings)
print("num_channels     :", getattr(sm.mp, "num_channels", "n/a"))
print("keyPitches (count):", len(sm.keyPitches), "range:", (min(sm.keyPitches), max(sm.keyPitches)) if sm.keyPitches else None)
print("soundPitches     :", sm.soundPitches)
print()

# The packed feedback/coupling matrix the kernel reads (single-deck mode) is built from sm.pitch_index:
#   feedin = np.stack([pack_pitch_feedin(p) for p in sm.pitch_index])   (StringMap.pack_deck:466)
# so ROW r of mode_coefficients corresponds to STRING sm.string_index[r] / PITCH sm.pitch_index[r].
print("=== pitch_index / string_index (the packed-matrix ROW order) ===")
print("len(pitch_index) :", len(sm.pitch_index))
print("len(string_index):", len(sm.string_index))

# Which ROWS are output/sound strings?
out_rows = [r for r, pid in enumerate(sm.pitch_index) if sm.pitches[pid].outerSound]
key_rows_sample = [r for r, pid in enumerate(sm.pitch_index) if not sm.pitches[pid].outerSound][:8]
print("OUTPUT/sound-string ROW indices (foldedIndexInQuarter target == output):")
for r in out_rows:
    pid = sm.pitch_index[r]
    p = sm.pitches[pid]
    print(f"  row {r:4d}  pitch {pid:4d}  outerSound={p.outerSound}  outerSoundChannel(max(pid-127,0))={max(pid-127,0)}")
print(f"  (total output rows: {len(out_rows)}; total rows: {len(sm.pitch_index)})")
print("sample piano (non-output) rows:", key_rows_sample, "pitches:", [sm.pitch_index[r] for r in key_rows_sample])
print()

# Confirm the gate predicate: target row r is an output string IFF sm.pitches[sm.pitch_index[r]].outerSound.
# Equivalent integer predicate available in-kernel via the packed physics slot 'outer_sound' = max(pitch-127,0):
print("=== GATE PREDICATE CHECK ===")
print("Per-row outer_sound (max(pitch-127,0)) — nonzero == output string == EXCLUDE from deck_feedback_coeff scaling:")
nonzero = {r: max(sm.pitch_index[r]-127, 0) for r in range(len(sm.pitch_index)) if max(sm.pitch_index[r]-127,0) > 0}
print("  rows with outer_sound>0:", nonzero)

# Cross-check: pack_pitch_feedin output rows are deck['feedback']*sc_gain (the audio tap); piano rows are deck['feedin'].
print()
print("=== pack_pitch_feedin row-type spot check ===")
for r in (out_rows[:2] + key_rows_sample[:2]):
    pid = sm.pitch_index[r]
    p = sm.pitches[pid]
    row = sm.pack_pitch_feedin(pid)
    print(f"  row {r:4d} pitch {pid:4d} outerSound={p.outerSound}  packed[:5]={np.asarray(row)[:5]}")

print()
print("=== DONE (read-only; no GPU, no files written) ===")
