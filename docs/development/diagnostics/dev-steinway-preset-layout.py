"""
dev-steinway-preset: layout + block-count analysis.

Question 1: full 88-key (MIDI 21-108) Steinway preset — how many strings/blocks? Does any string
            hit the <4-main-points clamp at Belarus's dx? Does it exceed 56 blocks (56 SMs)?
Question 2: 56-SM variant — what must be reduced to fit <= 56 blocks (<=224 piano+output strings)?

main-point model (PianoMeasure.calculate_length_in_points / .form_default_measure):
   tail = int(length / tail_ratio / dx) ; main = int(tail * tail_ratio) ; points = main + tail + 2
We keep Belarus's per-pitch dx + tail_ratio where the pitch exists; for NEW pitches (21,22,107,108)
extrapolate dx/tail_ratio from the nearest neighbour.

Output strings: 4 (channels), 1 string each (pitch 128-131), p_full=2.
chore (strings per pitch): MIDI 21-32→1, 33-44→2, 45+→3 (Belarus follows this exactly).
"""
import sys, json, math
sys.path.insert(0, r"D:\repos\PianoidInstall\docs\development\diagnostics")
from importlib import import_module
derive = import_module("dev-steinway-preset-derive")

PRESET = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets\Belarus_196modesC"
d = json.load(open(PRESET, encoding="utf-8"))
pitches = d["pitches"]
mp = d["model_parameters"]
ARRAY_SIZE = mp["array_size"]   # 512
NSA = mp["num_strings_in_array"]  # 4
STEM = 2

# Belarus per-pitch dx + tail_ratio (tail_ratio = main/tail), and chore (num strings)
bel = {}
for pk, p in pitches.items():
    midi = int(pk)
    if midi >= 128:
        continue
    g = p["geometry"]
    main = g["main"]; tail = g["tail"]; L = g["length"]
    dx = L / main if main else None
    tr = (main / tail) if tail else None
    bel[midi] = dict(dx=dx, tail_ratio=tr, chore=len(p.get("strings", [1])), main=main, tail=tail, L=L)

def chore_for(midi):
    if midi <= 32: return 1
    if midi <= 44: return 2
    return 3

def dx_for(midi):
    if midi in bel: return bel[midi]["dx"]
    # nearest neighbour
    near = min(bel, key=lambda m: abs(m - midi))
    return bel[near]["dx"]

def tr_for(midi):
    if midi in bel: return bel[midi]["tail_ratio"]
    near = min(bel, key=lambda m: abs(m - midi))
    return bel[near]["tail_ratio"]

new = derive.full_keyboard()

def layout_for_range(midis, clamp_min_main=4):
    """Return list of per-pitch layout dicts + totals."""
    rows = []
    total_strings = 0
    clamped = []
    for midi in midis:
        nd = new[midi]
        L = nd["length_m"]
        dx = dx_for(midi); tr = tr_for(midi)
        # main from real length at Belarus dx; tail kept from belarus default-measure style
        main_real = int(L / dx)
        clamp = False
        L_used = L
        main_used = main_real
        if main_real < clamp_min_main:
            # clamp length UP to give exactly clamp_min_main points
            main_used = clamp_min_main
            L_used = clamp_min_main * dx
            clamp = True
            clamped.append(midi)
        # tail: keep belarus tail if present, else from tail_ratio
        if midi in bel:
            tail_used = bel[midi]["tail"]
        else:
            tail_used = max(1, int(main_used / tr)) if tr else 4
        pfull = main_used + tail_used + STEM
        ch = chore_for(midi)
        total_strings += ch
        rows.append(dict(midi=midi, L=L, L_used=L_used, dx=dx, main=main_used, tail=tail_used,
                         pfull=pfull, chore=ch, clamp=clamp))
    return rows, total_strings, clamped

print("="*70)
print("FULL 88-KEY (MIDI 21-108):")
rows88, ns88, cl88 = layout_for_range(range(21, 109))
out_strings = 4
total88 = ns88 + out_strings
print(f"  piano strings = {ns88}, +{out_strings} output = {total88} total")
print(f"  blocks = ceil({total88}/{NSA}) = {math.ceil(total88/NSA)}  (need {math.ceil(total88/NSA)} SMs)")
print(f"  <4-main clamps: {cl88 if cl88 else 'NONE'}")
print(f"  longest p_full = {max(r['pfull'] for r in rows88)} (must fit array_size {ARRAY_SIZE} after packing)")

print()
print("="*70)
print("CURRENT BELARUS RANGE (MIDI 23-106), Steinway physics:")
rows84, ns84, cl84 = layout_for_range(range(23, 107))
total84 = ns84 + out_strings
print(f"  piano strings = {ns84}, +{out_strings} output = {total84} total")
print(f"  blocks = ceil({total84}/{NSA}) = {math.ceil(total84/NSA)}  (need {math.ceil(total84/NSA)} SMs)")
print(f"  <4-main clamps: {cl84 if cl84 else 'NONE'}")

print()
print("="*70)
print("Belarus ACTUAL string count (from preset):", sum(chore_for(int(pk)) for pk in pitches if int(pk)<128) + 4)
# per-key chore breakdown for 88-key
ones = [m for m in range(21,109) if chore_for(m)==1]
twos = [m for m in range(21,109) if chore_for(m)==2]
threes = [m for m in range(21,109) if chore_for(m)==3]
print(f"  88-key chore breakdown: 1-string {len(ones)} (MIDI {ones[0]}-{ones[-1]}), "
      f"2-string {len(twos)} (MIDI {twos[0]}-{twos[-1]}), 3-string {len(threes)} (MIDI {threes[0]}-{threes[-1]})")
print(f"  88-key piano strings = {len(ones)*1 + len(twos)*2 + len(threes)*3}")

# What gets us to <=224 (56 blocks)?
print()
print("="*70)
print("56-SM (<=56 blocks = <=224 strings incl 4 output = <=220 piano strings) OPTIONS:")
print(f"  Full 88-key piano strings needed: {ns88} (+4 output = {total88}); over by {total88-224} strings = {math.ceil(total88/NSA)-56} blocks")
