"""dev-reset — RUNAWAY reproduction + reset-silence verification (offline, deterministic).

The brief: a NORMAL note decays so reset is inaudible; the bug is that reset cannot stop a
RUNAWAY (astray, non-decaying/growing) state. The W5 harness only ever tested a normal note.
This harness:
  1) tries to TRIGGER a runaway (output energy that does NOT decay / grows over cycles with no
     new note-on) via a high deck_feedback_coefficient (loop gain > 1), high velocity, sustain.
  2) once a runaway is established, RESET (resetStringsState + reset cycle) and render N fresh
     cycles -> measure whether output energy goes to ~0 and STAYS there (no regeneration).
  3) prints a per-cycle energy trace for BOTH the ringing phase (to prove non-decay = runaway)
     and the post-reset phase (to prove silence).

Run on whatever .pyd is installed; compare FIXED vs PRE-FIX by swapping the .pyd between runs.

RUN:
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-reset-runaway-repro.py
      [--pitch=60] [--vel=127] [--fb=8.0] [--ring-cyc=120] [--post-reset-cyc=8] [--tag=FIXED]
"""
import os, sys, json
MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE); sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64
PRESET = "BaselinePreset1"
PITCH, VEL = 60, 127
FB = 8.0               # deck_feedback_coefficient (default 1.0; >1 pushes the piano loop gain up)
RING_CYC = 120
POST_RESET_CYC = 8
TAG = "run"
for a in sys.argv[1:]:
    if a.startswith("--pitch="): PITCH = int(a.split("=",1)[1])
    elif a.startswith("--vel="): VEL = int(a.split("=",1)[1])
    elif a.startswith("--fb="): FB = float(a.split("=",1)[1])
    elif a.startswith("--ring-cyc="): RING_CYC = int(a.split("=",1)[1])
    elif a.startswith("--post-reset-cyc="): POST_RESET_CYC = int(a.split("=",1)[1])
    elif a.startswith("--tag="): TAG = a.split("=",1)[1]
PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")

def rms(a):
    a = np.asarray(a, np.float64); return float(np.sqrt(np.mean(a*a))) if a.size else 0.0
def maxabs(v):
    v = np.asarray(v, np.float64); return float(np.max(np.abs(v))) if v.size else 0.0
def cyc2ms(c): return max(1, int(c*SPC*1000/SR))

print(f"=== dev-reset RUNAWAY repro [tag={TAG}]: preset={PRESET} pitch={PITCH} vel={VEL} fb={FB} "
      f"ring={RING_CYC} post-reset={POST_RESET_CYC} ===", flush=True)
p = initialize(PRESET_PATH, filterlen=48*128*3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
cpp = p.pianoid
num_modes = p.mp.num_modes
print(f"    pianoidCuda from: {pianoidCuda.__file__}", flush=True)

# crank the deck feedback coefficient (the runtime loop-gain knob)
try:
    old = p.get_deck_feedback_coefficient()
    p.set_deck_feedback_coefficient(FB)
    print(f"    deck_feedback_coefficient {old} -> {p.get_deck_feedback_coefficient()}", flush=True)
except Exception as e:
    print(f"    (could not set deck_feedback_coefficient: {e})", flush=True)

def render_cycles(queue, total_cyc):
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = cyc2ms(total_cyc); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.runOfflinePlayback(queue, cfg)
        return np.asarray(cpp.getRecordedAudio(), np.float64)

def endpoints():
    try: ss = maxabs(np.asarray(cpp.getPianoidState(), np.float64))
    except Exception: ss = -1
    try:
        md = np.asarray(cpp.getModeDisplacements(), np.float64)
        mm = maxabs(md[:2*num_modes] if md.size>=2*num_modes else md)
    except Exception: mm = -1
    return ss, mm

# ---- fresh start ----
with p.cuda_lock:
    cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()

# ---- RING: NOTE_ON at 1, NO note-off (sustained), render in WINDOWS to trace energy per chunk ----
WIN = 10
on = pianoidCuda.PlaybackEvent(); on.channel=0; on.cycle_index=1
on.type = pianoidCuda.EventType.NOTE_ON; on.data = (PITCH<<8)|VEL
q = pianoidCuda.EventQueue(); q.addEvent(on); q.sortByCycle()
ring_audio = render_cycles(q, RING_CYC)
# slice the recorded audio into time windows to see decay vs growth
n = ring_audio.size
print(f"  [ring] {RING_CYC}cyc sustained, total samples={n}", flush=True)
ring_trace = []
if n > 0:
    seg = max(1, n // 8)
    for w in range(8):
        chunk = ring_audio[w*seg:(w+1)*seg]
        ring_trace.append(rms(chunk))
    print("  [ring] windowed RMS (early->late): " + "  ".join(f"{x:.3e}" for x in ring_trace), flush=True)
    growth = (ring_trace[-1] / ring_trace[0]) if ring_trace[0] > 0 else float('nan')
    print(f"  [ring] late/early ratio = {growth:.3e}  (>~1 = NON-decaying / runaway; <<1 = normal decay)", flush=True)
ring_ss, ring_mm = endpoints()
print(f"  [ring-end] max|string|={ring_ss:.3e} max|mode|={ring_mm:.3e}  fullRMS={rms(ring_audio):.3e}", flush=True)

# ---- RESET ----
with p.cuda_lock:
    cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
r_ss, r_mm = endpoints()
print(f"  [post-reset] max|string|={r_ss:.3e} max|mode|={r_mm:.3e}", flush=True)

# ---- POST-RESET: render fresh cycles, NO new note ----
post = []
for c in range(POST_RESET_CYC):
    with p.cuda_lock:
        cpp.clearRecords()
        eq = pianoidCuda.EventQueue()
        cfg = pianoidCuda.PlaybackConfig()
        cfg.audio_enabled=False; cfg.record_to_buffer=True
        cfg.max_duration_ms=cyc2ms(2); cfg.sample_rate=SR; cfg.samples_per_cycle=SPC
        cpp.runOfflinePlayback(eq, cfg)
        a = np.asarray(cpp.getRecordedAudio(), np.float64)
    ss, mm = endpoints()
    post.append(rms(a))
    print(f"      [post-reset cyc{c}] outRMS={rms(a):.3e}  max|string|={ss:.3e} max|mode|={mm:.3e}", flush=True)

max_post = max(post) if post else 0.0
ring_full = rms(ring_audio)
silenced = max_post < max(1e-9, 1e-3*ring_full)
is_runaway = bool(ring_trace and ring_trace[0] > 0 and ring_trace[-1] >= 0.5*ring_trace[0])
print(f"\n  RUNAWAY established during ring (late >= 0.5*early): {is_runaway}", flush=True)
print(f"  post-reset max outRMS={max_post:.3e} vs ring fullRMS={ring_full:.3e} -> SILENCED={silenced}", flush=True)
verdict = ("RESET_SILENCES_RUNAWAY" if (is_runaway and silenced)
           else "RESET_FAILS_runaway_regrows" if (is_runaway and not silenced)
           else "NO_RUNAWAY_TRIGGERED" if not is_runaway
           else "?")
print(f"  >>> VERDICT [{TAG}]: {verdict}", flush=True)
print("\n===JSON===\n" + json.dumps({
    "tag": TAG, "fb": FB, "pitch": PITCH, "vel": VEL,
    "ring_trace": [round(x,3) for x in ring_trace], "ring_full_rms": round(ring_full,3),
    "ring_end_string": round(ring_ss,3), "ring_end_mode": round(ring_mm,6),
    "post_reset_string": round(r_ss,3), "post_reset_mode": round(r_mm,6),
    "post_reset_rms": [round(x,6) for x in post],
    "is_runaway": is_runaway, "silenced": silenced, "verdict": verdict
}, indent=2), flush=True)
try: cpp.stopApplication(True)
except Exception: pass
print("done", flush=True)
