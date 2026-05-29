"""dev-8085 — Online vs Offline synthesis measurement rig (Option A).

PURPOSE
  Make the LIVE OnlinePlaybackEngine output byte-comparable to the OFFLINE
  note_playback render, for BOTH single notes AND multi-note SEQUENCES, on ONE
  engine instance, deterministically (wrap-free). This is the instrument the
  prior sessions never had — it converts "does online match offline?" from an
  argument into a measured number.

  Superposition is CORRECT on both paths and is NOT the bug (user directive).
  The decisive experiment here is ONLINE-SEQUENCE vs OFFLINE-SEQUENCE: if a
  sequence rendered live diverges from the same sequence rendered offline, THAT
  divergence is the bug.

PATHS COMPARED (same Pianoid object, same preset, same build)
  OFFLINE : OfflinePlaybackEngine via runOfflinePlayback(EventQueue) ->
            getRecordedAudio() (clean per-render vector, channel 0).
  ONLINE  : the REAL OnlinePlaybackEngine::run() thread. Events scheduled via
            schedule_event (the live /play path) at wall-clock spacing; output
            read from the 5s rawSoundBuffer ring, FROZEN first via
            online_engine.pause() so the read is wrap-free.

RUN (own process, audio_off-friendly but ONLINE leg needs the engine running, so
     SDL3 is opened — abort cleanly if the device is busy):
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-8085-online-offline-rig.py
      [--preset=Belarus_8band_196modes-MFeq] [--pitches=55,56,57,60]
      [--on-ms=400] [--gap-ms=600] [--tail-ms=1800] [--driver=3]

  --driver 3 = SDL3 (opens the device; use when no other backend holds it).
  --driver 0 = no driver: ONLINE leg is SKIPPED (offline-only sanity run).
"""
import os, sys, json, time, math
MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE); sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64

# ---- args ----
PRESET = "Belarus_8band_196modes-MFeq"
PITCHES = [55, 56, 57, 60]
ON_MS, GAP_MS, TAIL_MS, VEL, DRIVER = 400, 600, 1800, 100, 3
for a in sys.argv[1:]:
    if a.startswith("--preset="): PRESET = a.split("=", 1)[1]
    elif a.startswith("--pitches="): PITCHES = [int(x) for x in a.split("=", 1)[1].split(",")]
    elif a.startswith("--on-ms="): ON_MS = int(a.split("=", 1)[1])
    elif a.startswith("--gap-ms="): GAP_MS = int(a.split("=", 1)[1])
    elif a.startswith("--tail-ms="): TAIL_MS = int(a.split("=", 1)[1])
    elif a.startswith("--driver="): DRIVER = int(a.split("=", 1)[1])
PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")


def rms(a):
    a = np.asarray(a, np.float64); return float(np.sqrt(np.mean(a * a))) if a.size else 0.0
def pk(a):
    a = np.asarray(a, np.float64); return float(np.max(np.abs(a))) if a.size else 0.0
def ms2cyc(ms): return max(1, int(ms * SR / (1000 * SPC)))
def win(a, t0, t1):
    i0 = max(0, int(t0 / 1000 * SR)); i1 = min(len(a), int(t1 / 1000 * SR))
    return a[i0:i1] if i1 > i0 else np.array([])


def corr(a, b):
    n = min(len(a), len(b))
    if n < 16: return float("nan")
    a = np.asarray(a[:n], np.float64); b = np.asarray(b[:n], np.float64)
    a = a - a.mean(); b = b - b.mean()
    da, db = np.sqrt((a*a).sum()), np.sqrt((b*b).sum())
    if da < 1e-20 or db < 1e-20: return float("nan")
    return float((a*b).sum() / (da*db))


# =====================================================================
print(f"=== dev-8085 rig: preset={PRESET} pitches={PITCHES} on={ON_MS} gap={GAP_MS} tail={TAIL_MS} driver={DRIVER} ===", flush=True)
audio_on = DRIVER != 0
try:
    p = initialize(PRESET_PATH, filterlen=48*128*3, string_iteration=12, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                   audio_on=audio_on, audio_driver_type=DRIVER,
                   start_right_away=(1 if audio_on else 0), listen_to_midi=0)
except Exception as e:
    print(f"INIT FAILED (device busy?): {e}", flush=True); sys.exit(2)
cpp = p.pianoid
nch = p.mp.num_channels
mode_iter = p.mp.mode_iteration
print(f"  num_channels={nch} mode_iteration={mode_iter}", flush=True)


def sidx(pitch):
    return [p.sm.find_string_in_index(s) for s in p.sm.get_string_IDs(pitch)]


# ---- sequence schedule: note k starts at k*GAP_MS, lasts ON_MS ----
def schedule(pitches, gap_ms, on_ms):
    """Return list of (t_on_ms, t_off_ms, pitch)."""
    sched = []
    for k, pt in enumerate(pitches):
        t_on = k * gap_ms
        sched.append((t_on, t_on + on_ms, pt))
    return sched


SCHED = schedule(PITCHES, GAP_MS, ON_MS)
SEQ_END_MS = (len(PITCHES) - 1) * GAP_MS + ON_MS
TOTAL_MS = SEQ_END_MS + TAIL_MS
print(f"  sequence: {SCHED}  seq_end={SEQ_END_MS}ms total(+tail)={TOTAL_MS}ms (ring=5000ms)", flush=True)
assert TOTAL_MS < 4800, "sequence+tail must fit in the 5s ring for a wrap-free online read"


# ---------- OFFLINE: one EventQueue, runOfflinePlayback ----------
def offline_sequence():
    q = pianoidCuda.EventQueue()
    for (t_on, t_off, pt) in SCHED:
        on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = ms2cyc(t_on)
        on.type = pianoidCuda.EventType.NOTE_ON; on.data = (pt << 8) | VEL; q.addEvent(on)
        off = pianoidCuda.PlaybackEvent(); off.channel = 0; off.cycle_index = ms2cyc(t_off)
        off.type = pianoidCuda.EventType.NOTE_OFF; off.data = (pt << 8) | 0; q.addEvent(off)
    q.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = TOTAL_MS; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cpp.runOfflinePlayback(q, cfg)
        audio = np.asarray(cpp.getRecordedAudio(), np.float64)
    return audio  # channel 0, length ~ TOTAL_MS*SR/1000


# ---------- ONLINE: real engine thread, schedule_event, freeze-read ring ----------
def ring_ch0():
    raw = np.asarray(cpp.getRawSoundRecord(), np.float64)
    per_cycle = mode_iter * nch
    ncyc = len(raw) // per_cycle
    if ncyc == 0: return np.array([])
    r = raw[:ncyc*per_cycle].reshape(ncyc, nch, mode_iter)
    return r[:, 0, :].reshape(-1)


def online_sequence():
    """Drive the REAL engine thread but schedule every event at an EXACT target
    cycle via add_realtime_event(delay_ms=...) (predictCycleForDelay), so the
    online sequence lands on the SAME relative cycle grid as the offline queue —
    no wall-clock jitter. A small LEAD_MS shifts the whole schedule forward so
    the first event clears the getCurrentCycle()+1 safety margin."""
    LEAD_MS = 60  # all events delayed by this so none lands in the past/next-cycle race
    if not (hasattr(p, "online_engine") and p.online_engine.isRunning()):
        p.start_realtime_playback_unified()
        time.sleep(0.4)
    p.online_engine.pause(); time.sleep(0.1)
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel()
    cpp.clearRecords()
    p.online_engine.resume(); time.sleep(0.05)
    # schedule ALL events up-front at precise delays (deterministic cycle targets)
    for (t_on, t_off, pt) in SCHED:
        p.add_realtime_event(pianoidCuda.EventType.NOTE_ON, pt, VEL, delay_ms=LEAD_MS + t_on)
        p.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, pt, 0, delay_ms=LEAD_MS + t_off)
    # wait for the whole schedule + tail to play out
    time.sleep((LEAD_MS + TOTAL_MS) / 1000.0 + 0.2)
    # FREEZE the ring (true engine pause), then read
    p.online_engine.pause(); time.sleep(0.08)
    ch0 = ring_ch0()
    p.online_engine.resume()
    # drop the LEAD_MS pre-roll so ch0 index 0 aligns with offline index 0
    lead_samples = int(LEAD_MS / 1000 * SR)
    return ch0[lead_samples:] if len(ch0) > lead_samples else ch0


def per_note_windows(label, audio):
    """RMS during each note + RMS in the final tail (post last note-off)."""
    print(f"  [{label}] n={len(audio)} (~{len(audio)/SR*1000:.0f}ms) peak={pk(audio):.3e}", flush=True)
    rows = []
    for k, (t_on, t_off, pt) in enumerate(SCHED):
        dur = win(audio, t_on + 50, t_off - 30)
        rows.append((pt, rms(dur)))
    tail = win(audio, SEQ_END_MS + TAIL_MS - 400, SEQ_END_MS + TAIL_MS - 50)
    note_rms = "  ".join(f"p{pt}={r:.3e}" for pt, r in rows)
    print(f"    during-note: {note_rms}", flush=True)
    print(f"    final-tail rms={rms(tail):.3e}  ({'DAMPS' if (rows and rms(tail) < 0.1*max(r for _,r in rows)) else 'TAIL-HOT'})", flush=True)
    return {"n": len(audio), "peak": pk(audio), "note_rms": [(pt, r) for pt, r in rows], "tail_rms": rms(tail)}


# =====================================================================
print("\n=== OFFLINE sequence (runOfflinePlayback) ===", flush=True)
off = offline_sequence()
off_stats = per_note_windows("OFFLINE", off)

result = {"offline": off_stats}
if audio_on:
    print("\n=== ONLINE sequence (real OnlinePlaybackEngine thread, freeze-read) ===", flush=True)
    on = online_sequence()
    on_stats = per_note_windows("ONLINE", on)
    result["online"] = on_stats
    # align lengths to the shorter; both start at t=0 (clean reset), so direct compare
    c = corr(off, on)
    print(f"\n=== COMPARISON ===", flush=True)
    print(f"  full-buffer correlation offline vs online = {c:.4f}", flush=True)
    print(f"  per-note RMS ratio (online/offline):", flush=True)
    for (pt, ro), (_, rn) in zip(off_stats["note_rms"], on_stats["note_rms"]):
        ratio = (rn/ro) if ro > 0 else float("nan")
        flag = "" if 0.7 < ratio < 1.4 else "  <-- DIVERGES"
        print(f"    p{pt}: offline={ro:.3e} online={rn:.3e} ratio={ratio:.3f}{flag}", flush=True)
    result["correlation"] = c
else:
    print("\n(ONLINE leg skipped — driver=0)", flush=True)

print("\n===== RIG SUMMARY (JSON) =====", flush=True)
print(json.dumps(result, indent=2, default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)

try:
    if hasattr(p, "online_engine") and p.online_engine.isRunning():
        p.stop_playback()
    cpp.stopApplication(True)
except Exception:
    pass
print("done", flush=True)
