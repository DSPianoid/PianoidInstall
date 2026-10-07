"""dev-0ccf exploration (own process, engine NOT live -> offline render legal; stop the user backend first or accept GPU sharing): offline (engine NOT live, own process) bare peaks of single notes + chords at v127.
Usage: python chord_explore.py <preset_rel_path> <out.json> [json overrides for the load body] [--scan]"""
import os, sys, json, time, math
OUT_ABS = os.path.abspath(sys.argv[2])  # before chdir
import numpy as np

MW = os.environ.get("MW", r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(MW); sys.path.insert(0, MW)
import backendServer as B
import pianoidCuda

preset, out = sys.argv[1], sys.argv[2]
over = json.loads(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else {}
SCAN = "--scan" in sys.argv
body = {'path': preset, 'volume': 100, 'sample_rate': 48, 'string_iterations': 4, 'number_of_modes': 196,
        'use_simulation': 0, 'debug_mode': 0, 'cycle_iterations': 64, 'start_right_away': 0, 'audio_on': 0,
        'listen_to_midi': 0, 'use_cuda': 1, 'audio_driver_type': 0, 'audio_buffer_size': 2, 'array_size': 384,
        'listen_to_modes': 0, 'sound_derivative_order': 2}
body.update(over)
c = B.app.test_client()
t = time.time(); r = c.post("/load_preset", json=body); print("load", r.status_code, f"{time.time()-t:.1f}s", r.get_json())
pw = B.pianoid
from output_level import engine_is_live
assert not engine_is_live(pw), "engine live"
notes = c.get("/get_available_notes").get_json()
print("notes", str(notes)[:200])
sr = pw.mp.sample_rate(); spc = pw.mp.mode_iteration


def render(events, total_ms):
    eq = pianoidCuda.EventQueue()
    for cyc, typ, data in events:
        e = pianoidCuda.PlaybackEvent(); e.channel = 0; e.cycle_index = cyc; e.type = typ; e.data = data
        eq.addEvent(e)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = total_ms; cfg.sample_rate = sr; cfg.samples_per_cycle = spc
    with pw.cuda_lock:
        pw.pianoid.waitForParameterUpdate(); pw.pianoid.resetStringsState(); pw.pianoid.runSynthesisKernel()
        pw.pianoid.clearRecords()
        st = pw.pianoid.runOfflinePlayback(eq, cfg)
        a = np.asarray(pw.pianoid.getRecordedAudio(), dtype=np.float64)
    i = int(np.argmax(np.abs(a)))
    return float(np.abs(a[i])), i, a.size


ON, OFF, SUS = pianoidCuda.EventType.NOTE_ON, pianoidCuda.EventType.NOTE_OFF, pianoidCuda.EventType.SUSTAIN
cyc = lambda ms: int(ms / 1000.0 * sr / spc)


def chord(pitches, vel=127, dur_ms=2000, tail_ms=1000, strikes=1, gap_ms=0, pedal=False):
    ev = []
    if pedal: ev.append((0, SUS, 127))
    for k in range(strikes):
        c0 = cyc(k * gap_ms)
        for p in pitches:
            ev.append((c0, ON, (p << 8) | vel))
            if not pedal or k == strikes - 1:
                pass
    off = cyc((strikes - 1) * gap_ms + dur_ms)
    for p in pitches: ev.append((off, OFF, p << 8))
    return render(ev, (strikes - 1) * gap_ms + dur_ms + tail_ms)


res = {"body": body, "single": {}, "chords": {}}
p60 = chord([60]); res["p60"] = p60; print("p60", p60)
CH = {
    "C_maj_2hand_9": [36, 43, 48, 52, 55, 60, 64, 67, 72],
    "C_maj_wide_10": [24, 36, 43, 48, 52, 60, 64, 67, 72, 76],
    "oct_bass_treble_6": [24, 36, 48, 84, 96, 108],
    "oct_A_6": [21, 33, 45, 81, 93, 105],
    "oct_chain_C_8": [24, 36, 48, 60, 72, 84, 96, 108],
    "cluster_mid_10": list(range(55, 65)),
    "cluster_bass_10": list(range(28, 38)),
    "cluster_tenor_10": list(range(43, 53)),
    "cluster_treble_10": list(range(84, 94)),
    "dim7_2hand_10": [36, 42, 45, 48, 51, 54, 57, 60, 63, 66],
    "D_maj_rach_10": [26, 33, 38, 42, 45, 50, 62, 66, 69, 74],
    "bass_5ths_oct_6": [24, 31, 36, 43, 48, 55],
    "F_maj_high_10": [53, 57, 60, 65, 69, 72, 77, 81, 84, 89],
    "E_min_2hand_8": [28, 40, 47, 52, 55, 59, 64, 67],
    "Bb_maj_2hand_10": [22, 34, 41, 46, 50, 53, 58, 62, 65, 70],
    "G_dom7_2hand_9": [31, 43, 50, 53, 55, 59, 62, 65, 67],
}
for name, ps in CH.items():
    ps = [p for p in ps if 21 <= p <= 108]
    r1 = chord(ps); res["chords"][name] = {"pitches": ps, "peak": r1[0], "idx": r1[1], "db_vs_p60": 20 * math.log10(r1[0] / p60[0])}
    print(name, f"{res['chords'][name]['db_vs_p60']:+.2f} dB", r1)
# repeated/pedalled
for name in ("C_maj_2hand_9", "cluster_bass_10", "D_maj_rach_10"):
    ps = CH[name]
    r3 = chord(ps, strikes=3, gap_ms=300, pedal=True, dur_ms=2600)
    res["chords"][name + "_x3_pedal"] = {"pitches": ps, "peak": r3[0], "idx": r3[1], "db_vs_p60": 20 * math.log10(r3[0] / p60[0])}
    print(name + "_x3_pedal", f"{res['chords'][name + '_x3_pedal']['db_vs_p60']:+.2f} dB")
if SCAN:
    for p in range(21, 109):
        r1 = chord([p], dur_ms=1500, tail_ms=500)
        res["single"][p] = {"peak": r1[0], "db_vs_p60": 20 * math.log10(r1[0] / p60[0]) if r1[0] > 0 else None}
    top = sorted(res["single"].items(), key=lambda kv: -(kv[1]["db_vs_p60"] or -999))[:8]
    print("loudest singles", [(k, round(v["db_vs_p60"], 2)) for k, v in top])
if "--random" in sys.argv:
    import random
    rng = random.Random(1234); rnd = []
    for k in range(int(sys.argv[sys.argv.index("--random") + 1])):
        lo = rng.randint(21, 52); lh = sorted(rng.sample(range(lo, lo + 13), rng.randint(3, 5)))
        hi = rng.randint(max(lo + 12, 52), 88); rh = sorted(rng.sample(range(hi, hi + 13), rng.randint(4, 5)))
        ps = sorted(set(p for p in lh + rh if 21 <= p <= 108))
        r1 = chord(ps); d = 20 * math.log10(r1[0] / p60[0]); rnd.append((d, ps))
    rnd.sort(reverse=True); res["random"] = rnd
    print("random top", [(round(d, 2), ps) for d, ps in rnd[:5]], "median", round(rnd[len(rnd)//2][0], 2))
json.dump(res, open(OUT_ABS, "w"), indent=1)
os._exit(0)
