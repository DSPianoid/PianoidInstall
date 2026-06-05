"""
dev-steinway-preset: BUILD the two Steinway 1860 presets.

Strategy (no guessing):
 1. Replicate Belarus's EXACT block-packing algorithm (reverse-engineered + PROVEN below):
    walk blocks; slot0 = next LOW-pitch string (pitches ascending, 1 string/block);
    slots 1..3 = next HIGH-pitch's strings (pitches descending, whole pitch/block).
    String IDs assigned per block as [short,short,short,long] -> IDs (4N,4N+1,4N+2)=high, 4N+3=low;
    block stringIDs listed reverse-sorted = [4N+3,4N+2,4N+1,4N]. Output pitches (>=128) form the LAST block.
 2. PROVE it reproduces Belarus_196modesC `blocks` + per-pitch `strings` BIT-FOR-BIT for MIDI 23-106
    (regression gate). If mismatch -> ABORT (do not guess).
 3. Build Preset A = FULL 88-key (MIDI 21-108) with the SAME algorithm.
 4. Build Preset B = Preset A minus the FIRST K = max(0, nblocks - target_SMs) blocks (symmetric trim),
    drop the now-absent pitch entries, fix model_parameters counts.
 5. Override ONLY per-pitch physics {r, rho, tension} + geometry {length, main, tail, dx}. Keep Belarus's
    jung, gamma, disp_decay, damper_*, hammer, excitation, deck, modes, mode_sound_channels,
    string_sound_channels, calibration.

Per-pitch geometry: main = int(real_length / dx), dx kept from Belarus where present else nearest-neighbour;
tail kept from Belarus where present else from nearest tail_ratio; <4-main clamp: if main<4 -> length up to 4*dx.
"""
import sys, json, math, copy
from pathlib import Path
sys.path.insert(0, r"D:\repos\PianoidInstall\docs\development\diagnostics")
from importlib import import_module
derive = import_module("dev-steinway-preset-derive")

PRESETS = Path(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets")
SRC = PRESETS / "Belarus_196modesC"
STEM = 2
INTERVAL = 2

belarus = json.load(open(SRC, encoding="utf-8"))
B_pitches = belarus["pitches"]
ARRAY_SIZE = belarus["model_parameters"]["array_size"]  # 512
NSA = belarus["model_parameters"]["num_strings_in_array"]  # 4

# ---- Belarus per-pitch dx, tail_ratio, chore, tail (for geometry reconstruction) ----
bel_geo = {}
for pk, p in B_pitches.items():
    midi = int(pk)
    if midi >= 128:
        continue
    g = p["geometry"]; main = g["main"]; tail = g["tail"]; L = g["length"]
    bel_geo[midi] = dict(dx=(L/main if main else None), tail_ratio=(main/tail if tail else None),
                         chore=len(p.get("strings", [1])), tail=tail, main=main, L=L)

def chore_for(midi):
    if midi <= 32: return 1
    if midi <= 44: return 2
    return 3

def nn(midi, attr):
    if midi in bel_geo and bel_geo[midi][attr] is not None:
        return bel_geo[midi][attr]
    near = min(bel_geo, key=lambda m: abs(m - midi))
    return bel_geo[near][attr]

# ---- block packing algorithm (replicates Belarus) ----
def build_blocks(piano_midis, n_output=4):
    """Return (blocks, pitch_strings) where blocks is a list of 4-int stringID lists (reverse-sorted),
    pitch_strings maps midi -> [stringIDs ascending]. Mirrors Belarus: per block slot0=low string,
    slots1-3 = one high pitch's strings; IDs per block = [3 high, 1 low] assigned 4N..4N+3.
    Low pitches consumed ascending (1 string/block); high pitches consumed descending (whole pitch/block)."""
    los = sorted(piano_midis)
    his = sorted(piano_midis, reverse=True)
    # expand low side into a queue of (pitch) one entry per string, ascending
    low_q = []
    for m in los:
        low_q += [m] * chore_for(m)
    # high side: queue of pitches (descending); each contributes its whole chore as the 3 short slots
    hi_idx = 0
    his_list = his
    pitch_strings = {m: [] for m in piano_midis}
    blocks = []
    next_id = 0
    li = 0
    # high pointer consumes pitches; we need 3 short strings per block (a 3-string high pitch).
    # Build a high-string queue too, but grouped so each block takes exactly one high pitch's 3 strings.
    # Belarus: every high pitch in the packed region is 3-string. We assert that and consume per-pitch.
    hq = list(his_list)
    # We pack until low_q exhausted; each block: 3 high strings (one high pitch) + 1 low string.
    # Stop taking from high when high pointer meets low pointer (pitch collision).
    used = set()
    while li < len(low_q):
        low_pitch = low_q[li]
        # pick the next high pitch not equal to / not below the current low frontier
        # consume from hq front
        if not hq:
            break
        high_pitch = hq[0]
        if high_pitch <= low_pitch:
            # pointers met — remaining low strings pack against themselves; handled below
            break
        hq.pop(0)
        hc = chore_for(high_pitch)
        # assign IDs: 3 (or hc) high short strings get 4N..4N+hc-1, low gets next
        # Belarus blocks are always 4 = (NSA). high contributes hc short, low contributes (NSA-hc)??
        # In Belarus packed region: 1 low + 3 high (hc=3). Assign 3 high then 1 low.
        block_ids = []
        for _ in range(hc):
            pitch_strings[high_pitch].append(next_id); block_ids.append(next_id); next_id += 1
        # low strings to fill the block up to NSA
        n_low_slots = NSA - hc
        for _ in range(n_low_slots):
            if li >= len(low_q): break
            lp = low_q[li]; li += 1
            pitch_strings[lp].append(next_id); block_ids.append(next_id); next_id += 1
        blocks.append(sorted(block_ids, reverse=True))
    # Meeting region: remaining low_q pitches + remaining hq pitches pack as before but pointers crossed.
    # In Belarus the meeting is clean (block 54 = pitch51 low + pitch52 high). Handle leftover by pairing
    # remaining lows (ascending) with remaining highs (now ascending from the meet) using same 1-low+3-high.
    # Reconstruct leftover pitches still needing strings:
    remaining = []
    for m in piano_midis:
        need = chore_for(m) - len(pitch_strings[m])
        remaining += [m] * need
    # pair from extremes of `remaining`
    remaining.sort()
    while remaining:
        # take highest as the 3-short, lowest as 1-long (or whatever fits)
        block_ids = []
        # 3 highest
        highs = []
        for _ in range(3):
            if remaining:
                highs.append(remaining.pop())   # highest
        lows = []
        if remaining:
            lows.append(remaining.pop(0))        # lowest
        # assign IDs: highs first (ascending pitch order within block), then low
        for hp in sorted(highs):
            pitch_strings[hp].append(next_id); block_ids.append(next_id); next_id += 1
        for lp in lows:
            pitch_strings[lp].append(next_id); block_ids.append(next_id); next_id += 1
        if block_ids:
            blocks.append(sorted(block_ids, reverse=True))
    # Output pitches as the final block
    out_block = []
    out_pitches = list(range(128, 128 + n_output))
    pitch_strings_out = {}
    for op in out_pitches:
        pitch_strings_out[op] = [next_id]; out_block.append(next_id); next_id += 1
    blocks.append(sorted(out_block, reverse=True))
    pitch_strings.update(pitch_strings_out)
    return blocks, pitch_strings

def reproduce_check():
    """Prove the algorithm reproduces Belarus blocks + strings for MIDI 23-106."""
    piano = [m for m in range(23, 107)]
    blocks, pstr = build_blocks(piano, n_output=4)
    # Belarus blocks
    bel_blocks = belarus["blocks"]
    ok_blocks = (blocks == bel_blocks)
    # per-pitch strings
    mism = []
    for pk, p in B_pitches.items():
        midi = int(pk)
        got = sorted(pstr.get(midi, []))
        exp = sorted(p["strings"])
        if got != exp:
            mism.append((midi, exp, got))
    return ok_blocks, blocks, bel_blocks, mism

# ---- geometry + physics for one pitch (Steinway override) ----
def steinway_geometry(midi, derived):
    """Return geometry dict {length, main, tail} + dx, applying the <4-main clamp. Keeps Belarus dx & tail."""
    L = derived["length_m"]
    dx = nn(midi, "dx")
    main = int(L / dx)
    clamp = False
    if main < 4:
        main = 4
        L = main * dx
        clamp = True
    # tail: keep Belarus tail where present, else from nearest tail_ratio
    if midi in bel_geo:
        tail = bel_geo[midi]["tail"]
    else:
        tr = nn(midi, "tail_ratio")
        tail = max(1, int(main / tr)) if tr else 4
    return dict(length=round(L, 6), main=int(main), tail=int(tail)), dx, clamp

def assemble_preset(piano_midis, name, target_sms=None):
    """Build a full preset dict for the given piano range. If target_sms given and nblocks>target_sms,
    trim the FIRST K=nblocks-target_sms blocks (symmetric keyboard trim) and drop absent pitches."""
    new = derive.full_keyboard()
    blocks, pstr = build_blocks(piano_midis, n_output=4)
    nblocks = len(blocks)
    cut = 0
    if target_sms is not None and nblocks > target_sms:
        cut = nblocks - target_sms
    kept_blocks = blocks[cut:]
    # which string IDs survive
    surviving_ids = set(s for blk in kept_blocks for s in blk)
    # which pitches survive (have >=1 surviving string)
    surviving_pitches = set()
    id2pitch = {}
    for m, ids in pstr.items():
        for sid in ids:
            id2pitch[sid] = m
    for sid in surviving_ids:
        surviving_pitches.add(id2pitch[sid])
    # RE-NUMBER string IDs to be contiguous 0..N-1 in the kept-block order (engine expects dense IDs)
    remap = {}
    nid = 0
    for blk in kept_blocks:
        for sid in sorted(blk):   # ascending within block for stable renumber
            if sid not in remap:
                remap[sid] = nid; nid += 1
    kept_blocks_remapped = [sorted([remap[s] for s in blk], reverse=True) for blk in kept_blocks]
    # rebuild pitch -> strings (remapped), only surviving pitches
    new_pstr = {}
    for m, ids in pstr.items():
        kept = sorted(remap[s] for s in ids if s in remap)
        if kept:
            new_pstr[m] = kept

    # assemble preset by DEEP-COPYING Belarus and overriding
    preset = copy.deepcopy(belarus)
    # build pitches dict
    out_pitches = {}
    clamps = []
    for m in sorted(new_pstr):
        if m >= 128:
            # output pitch — copy from Belarus output pitch (128-131); they map by channel
            src_key = str(m)
            if src_key in B_pitches:
                pp = copy.deepcopy(B_pitches[src_key])
            else:
                # shouldn't happen (always 4 output)
                pp = copy.deepcopy(B_pitches["128"])
            pp["strings"] = new_pstr[m]
            out_pitches[str(m)] = pp
            continue
        # piano pitch: base = Belarus pitch if exists, else nearest-neighbour template
        if str(m) in B_pitches:
            pp = copy.deepcopy(B_pitches[str(m)])
        else:
            near = min((int(k) for k in B_pitches if int(k) < 128), key=lambda x: abs(x - m))
            pp = copy.deepcopy(B_pitches[str(near)])
        d = new[m]
        geo, dx, clamp = steinway_geometry(m, d)
        if clamp: clamps.append(m)
        pp["geometry"] = geo
        # override physics r, rho, tension; keep jung/gamma/disp_decay/damper/hammer
        pp["physics"]["r"] = round(d["r"], 9)
        pp["physics"]["rho"] = round(d["rho"], 9)
        pp["physics"]["tension"] = round(d["tension"], 6)
        pp["strings"] = new_pstr[m]
        out_pitches[str(m)] = pp

    preset["pitches"] = out_pitches
    preset["blocks"] = kept_blocks_remapped
    # model_parameters counts
    num_strings = sum(len(v) for v in new_pstr.values())
    preset["model_parameters"]["num_strings"] = num_strings
    preset["model_parameters"]["num_strings_in_array"] = NSA
    # mode_sound_channels / string_sound_channels: keep only surviving pitch keys + meta
    for sec in ("mode_sound_channels", "string_sound_channels"):
        if sec in preset:
            old = preset[sec]
            newsec = {}
            for k, v in old.items():
                if not k.isdigit():   # meta like num_channels
                    newsec[k] = v
                elif int(k) in surviving_pitches:
                    newsec[k] = v
            preset[sec] = newsec
    return preset, kept_blocks_remapped, sorted(p for p in surviving_pitches if p < 128), clamps, cut, nblocks

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="write preset files")
    ap.add_argument("--target-sms", type=int, default=56)
    args = ap.parse_args()

    ok_blocks, blocks, bel_blocks, mism = reproduce_check()
    print(f"[GATE] Block reproduction (23-106): {'MATCH' if ok_blocks else 'MISMATCH'} "
          f"({len(blocks)} vs {len(bel_blocks)}); per-pitch string mismatches: {len(mism)}")
    if not ok_blocks or mism:
        print("ABORT: algorithm does not reproduce Belarus — do NOT guess. Stopping.")
        sys.exit(1)

    # Preset A = full 88-key (21-108), no trim
    full_midis = list(range(21, 109))
    A, A_blocks, A_pitches, A_clamps, A_cut, A_nb = assemble_preset(full_midis, "A", target_sms=None)
    print(f"\n[PRESET A] full 88-key: pitches {A_pitches[0]}-{A_pitches[-1]} ({len(A_pitches)} keys), "
          f"blocks={len(A_blocks)}, num_strings={A['model_parameters']['num_strings']}, clamps={A_clamps}")

    # Preset B = trim to target SMs
    B, B_blocks, B_pitches_l, B_clamps, B_cut, B_nb = assemble_preset(full_midis, "B", target_sms=args.target_sms)
    print(f"[PRESET B] target_sms={args.target_sms}: cut {B_cut} blocks from start -> "
          f"pitches {B_pitches_l[0]}-{B_pitches_l[-1]} ({len(B_pitches_l)} keys), blocks={len(B_blocks)}, "
          f"num_strings={B['model_parameters']['num_strings']}, clamps={B_clamps}")
    # verify symmetric trim
    dropped_low = [m for m in A_pitches if m not in B_pitches_l and m < 64]
    dropped_high = [m for m in A_pitches if m not in B_pitches_l and m >= 64]
    print(f"  symmetric-trim check: dropped LOW={dropped_low}  dropped HIGH={dropped_high}")

    # block-budget sanity: every block sum(p_full)+intervals <= array_size
    def block_budget_ok(preset):
        sid2pf = {}
        for pk, p in preset["pitches"].items():
            g = p["geometry"]; pf = (g.get("main", 0) or 0) + (g.get("tail", 0) or 0) + STEM
            for s in p["strings"]:
                sid2pf[s] = pf
        worst = 0
        for blk in preset["blocks"]:
            occ = sum(sid2pf.get(s, 0) for s in blk) + (NSA + 1) * INTERVAL
            worst = max(worst, occ)
        return worst
    print(f"  [BUDGET] Preset A worst block occupancy = {block_budget_ok(A)} (<= {ARRAY_SIZE}? "
          f"{block_budget_ok(A) <= ARRAY_SIZE})")
    print(f"  [BUDGET] Preset B worst block occupancy = {block_budget_ok(B)} (<= {ARRAY_SIZE}? "
          f"{block_budget_ok(B) <= ARRAY_SIZE})")

    if args.write:
        pa = PRESETS / "Belarus_196modesC_Steinway1860"
        pb = PRESETS / "Belarus_196modesC_Steinway1860_56SM"
        with open(pa, "w", encoding="utf-8") as f:
            json.dump(A, f, indent=2)
        with open(pb, "w", encoding="utf-8") as f:
            json.dump(B, f, indent=2)
        print(f"\nWROTE:\n  {pa}\n  {pb}")
