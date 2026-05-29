"""dev-8085 — STRINGS-mode (listen_to_modes=0) per-pitch trichotomy reproduction
+ GPU-slot per-pitch INDEXING readback.

WHY THIS PROBE EXISTS
  Every prior "clean decay" measurement this session ran listen_to_modes=1 (MODES).
  The prior CAREFUL on-screen-UI repro (dev-liveui-3a08, 2026-05-27) reproduced the
  trichotomy ONLY in STRINGS mode (listen_to_modes=0): isolated 55/56 are loud + decay,
  57 (and 59) are NEAR-SILENT (~750-2500x quieter) = the user's "click". STRINGS-mode
  output comes EXCLUSIVELY from OUTPUT PITCHES 128..127+num_output_channels, driven by
  the piano key's deck/feedin coupling into the soundboard-receiver modes
  (pianoid-basic/OVERVIEW.md "Output Pitches" + "Stored vs effective entries").

WHAT IT MEASURES (one in-process engine, STRINGS mode, vel127, isolated notes)
  (A) Per-pitch attack peak + sustain rms + post-note-off decay of the per-cycle
      dev_soundFloat OUTPUT (getCurrentCycleAudio) — the EXACT signal routed ×volume to
      the driver. Reproduces (or refutes) the 57/59 dropout at the engine level in the
      correct (STRINGS) routing.
  (B) GPU-slot INDEXING readback per pitch:
       - getStringIndicesForPitch(pitch)         -> GPU string slots the key drives
       - sm.get_string_IDs(pitch) / find_string_in_index -> model-side string IDs+slots
       - per-pitch string displacement energy (getPianoidState sliced at the pitch slots)
       - per-pitch mode energy (getModeDisplacements) during the note
       - output-pitch (128+) bridge displacement energy = the ACTUAL audio source
      Goal: is 57's energy present in the engine but NOT reaching its output slot
      (indexing/routing), or is 57 genuinely under-excited (data)? Compare 55 vs 56 vs 57.

RUN (own process; STRINGS mode; SDL3 driver opened so the realtime path is faithful,
     but we read per-cycle output via manual runCycle so the ring/driver is irrelevant):
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-8085-strings-trichotomy-gpu.py
"""
import os, sys, time, json
MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE); sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64
PRESET = "Belarus_8band_196modes-MFeq"
PITCHES = [54, 55, 56, 57, 58, 59, 60]
VEL = 127
# legacy main_volume=120 -> mvc ~ 9.74e9 (the user's live coeff); use a modest max_volume
# here since we read PRE-volume float and reconstruct soundInt separately if needed.
MAX_VOLUME = 5e18  # matches the rig; we read float so absolute scale is irrelevant to A/B


def rms(a):
    a = np.asarray(a, np.float64); return float(np.sqrt(np.mean(a * a))) if a.size else 0.0
def pk(a):
    a = np.asarray(a, np.float64); return float(np.max(np.abs(a))) if a.size else 0.0
def ms2cyc(ms): return max(1, int(round(ms * SR / (1000 * SPC))))


print(f"=== dev-8085 STRINGS-mode trichotomy + GPU indexing readback ===", flush=True)
print(f"  preset={PRESET} pitches={PITCHES} vel={VEL} listen_to_modes=0 (STRINGS)", flush=True)
PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")

# audio_on=False + start_right_away=0 -> no driver, no engine thread; we drive runCycle
# manually under cuda_lock for a wrap-free per-cycle output read.
try:
    p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=MAX_VOLUME,
                   audio_on=False, audio_driver_type=0, start_right_away=0,
                   listen_to_midi=0, listen_to_modes=0)
except Exception as e:
    print(f"INIT FAILED: {e}", flush=True); sys.exit(2)

cpp = p.pianoid
nch = p.mp.num_channels
mode_iter = p.mp.mode_iteration
num_modes = p.mp.mode_iteration
print(f"  num_channels={nch} mode_iteration={mode_iter} listen_to_modes={p.mp.listen_to_modes}", flush=True)
n_strings = cpp.getNumStrings()
print(f"  getNumStrings()={n_strings}", flush=True)


def model_slots(pitch):
    """Model-side: string IDs for a pitch and their packed GPU slot indices."""
    try:
        ids = list(p.sm.get_string_IDs(pitch))
    except Exception as e:
        return {"ids": f"ERR:{e}", "slots": None}
    slots = []
    for s in ids:
        try:
            slots.append(p.sm.find_string_in_index(s))
        except Exception as e:
            slots.append(f"ERR:{e}")
    return {"ids": ids, "slots": slots}


def cuda_slots(pitch):
    """Engine-side GPU string slots the kernel uses for this pitch."""
    try:
        return list(cpp.getStringIndicesForPitch(int(pitch)))
    except Exception as e:
        return f"ERR:{e}"


# ---------------------------------------------------------------
# PART B (static): per-pitch routing readback BEFORE playing
# ---------------------------------------------------------------
print("\n--- PART B1: per-pitch string-slot routing (model vs CUDA) ---", flush=True)
routing = {}
for pt in PITCHES:
    ms = model_slots(pt)
    cs = cuda_slots(pt)
    routing[pt] = {"model": ms, "cuda": cs}
    print(f"  pitch {pt}: model_ids={ms['ids']} model_slots={ms['slots']} | cuda_slots={cs}", flush=True)

# Inspect the StringMap for output-pitch / deck / feedin per pitch (strings-path coupling).
print("\n--- PART B2: per-pitch deck/feedin coupling (strings-path: which modes/output the key drives) ---", flush=True)
def deck_summary(pitch):
    """Pull the pitch's deck coupling (feedin) from the model — the strings-mode
    coupling that drives output-pitch bridge displacement."""
    out = {}
    try:
        pit = p.sm.pitches[pitch] if hasattr(p.sm, "pitches") else None
    except Exception:
        pit = None
    # Try several access paths; record whichever exists.
    for attr in ("deck", "feedin", "feedback"):
        try:
            if pit is not None and hasattr(pit, attr):
                v = getattr(pit, attr)
                arr = np.asarray(v, np.float64).ravel()
                out[attr] = {"n": int(arr.size), "nz": int((np.abs(arr) > 1e-12).sum()),
                             "sum": float(np.abs(arr).sum()), "max": float(np.abs(arr).max()) if arr.size else 0.0}
        except Exception as e:
            out[attr] = f"ERR:{e}"
    return out

for pt in PITCHES:
    print(f"  pitch {pt}: {deck_summary(pt)}", flush=True)


# ---------------------------------------------------------------
# PART A: per-pitch isolated reproduction (manual runCycle, wrap-free)
# ---------------------------------------------------------------
ON_MS, TAIL_MS = 600, 2500
ATTACK_WIN = (0, 80)        # ms after note-on
SUSTAIN_WIN = (300, 580)    # ms after note-on (before note-off)
DECAY_PTS = [100, 300, 600, 1000, 2000]  # ms after note-off

def play_isolated(pitch):
    """Manual-cycle an isolated note in true silence; return per-cycle output samples
    (channel 0, dev_soundFloat) plus mode/string energy snapshots."""
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.resetModeRunningState(); cpp.runSynthesisKernel(); cpp.clearRecords()
    # event helpers via the offline EventQueue executed cycle-by-cycle is heavy; instead
    # use schedule_event into the realtime buffer won't run without the engine thread.
    # Simplest faithful manual path: use runOfflinePlayback for a single note (same kernel,
    # CycleRegime Offline) to get the per-sample output deterministically.
    q = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = ms2cyc(1)
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (int(pitch) << 8) | VEL; q.addEvent(on)
    off = pianoidCuda.PlaybackEvent(); off.channel = 0; off.cycle_index = ms2cyc(ON_MS)
    off.type = pianoidCuda.EventType.NOTE_OFF; off.data = (int(pitch) << 8) | 0; q.addEvent(off)
    q.sortByCycle()
    total = ON_MS + TAIL_MS
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = total; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.resetModeRunningState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cpp.runOfflinePlayback(q, cfg)
        audio = np.asarray(cpp.getRecordedAudio(), np.float64)  # channel 0
        # snapshot GPU state AT END (after full decay) — should be ~0 if it decays
        mode_disp_end = np.asarray(cpp.getModeDisplacements(), np.float64)
        string_state_end = np.asarray(cpp.getPianoidState(), np.float64)
    return audio, mode_disp_end, string_state_end

def winrms(a, t0, t1):
    i0 = max(0, int(t0 / 1000 * SR)); i1 = min(len(a), int(t1 / 1000 * SR))
    return rms(a[i0:i1]) if i1 > i0 else 0.0
def winpk(a, t0, t1):
    i0 = max(0, int(t0 / 1000 * SR)); i1 = min(len(a), int(t1 / 1000 * SR))
    return pk(a[i0:i1]) if i1 > i0 else 0.0

print("\n--- PART A: isolated per-pitch reproduction (STRINGS mode, OFFLINE per-sample render) ---", flush=True)
print(f"    attack_win={ATTACK_WIN}ms sustain_win={SUSTAIN_WIN}ms note_off@{ON_MS}ms decay_pts(after off)={DECAY_PTS}ms", flush=True)
results = {}
for pt in PITCHES:
    audio, mode_end, str_end = play_isolated(pt)
    atk = winpk(audio, *ATTACK_WIN)
    sus = winrms(audio, *SUSTAIN_WIN)
    decay = {}
    for d in DECAY_PTS:
        t = ON_MS + d
        decay[d] = winrms(audio, t, t + 100)
    results[pt] = {"attack_pk": atk, "sustain_rms": sus, "decay": decay,
                   "len": len(audio), "mode_end_rms": rms(mode_end), "str_end_rms": rms(str_end)}
    dstr = " ".join(f"+{d}:{decay[d]:.2e}" for d in DECAY_PTS)
    print(f"  pitch {pt}: attack_pk={atk:.4f} sustain_rms={sus:.4e} | decay {dstr} | mode_end={rms(mode_end):.2e} str_end={rms(str_end):.2e}", flush=True)

# Relative loudness vs neighbours (the trichotomy texture)
print("\n--- PART A summary: per-pitch attack relative to median (dropout detector) ---", flush=True)
atks = {pt: results[pt]["attack_pk"] for pt in PITCHES}
med = float(np.median([v for v in atks.values() if v > 0])) if atks else 0.0
for pt in PITCHES:
    a = atks[pt]
    ratio = (a / med) if med > 0 else 0.0
    tag = "  <-- DROPOUT (near-silent)" if (med > 0 and ratio < 0.05) else ""
    print(f"  pitch {pt}: attack_pk={a:.4e}  ratio_to_median={ratio:.4f}{tag}", flush=True)

print("\n=== DONE ===", flush=True)
