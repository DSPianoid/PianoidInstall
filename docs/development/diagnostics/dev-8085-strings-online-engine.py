"""dev-8085 — STRINGS-mode reproduction via the REAL OnlinePlaybackEngine THREAD.

This is the ACTUAL online path the browser drives: start_realtime_playback_unified()
spins up OnlinePlaybackEngine::run(); add_realtime_event() pushes into the
RealTimeEventBuffer (the same buffer the WS /play handler feeds via schedule_event);
the engine thread drains it per cycle, runs the realtime excitation + synthesis, and
writes the 5s rawSoundBuffer ring + driver. We freeze the ring (online_engine.pause())
for a wrap-free per-pitch read.

KEY: the OFFLINE render (dev-8085-strings-trichotomy-gpu.py) showed 57 only ~3.6x
quieter + clean in STRINGS mode — NOT the dropout. The prior on-screen-UI session
(dev-liveui-3a08) reproduced 57 near-silent (750-2500x) via the REAL online path.
So this probe tests: does the REAL ONLINE ENGINE THREAD (not offline, not manual-cycle)
produce the 57 dropout in STRINGS mode?

Per-pitch ISOLATED capture (flush 21..108 note-off + settle before each note, exactly
like dev-liveui-3a08), with clearRecords reset between notes (wrap-free).

RUN (opens SDL3 — needs the audio device free; the user's backend is down so 5000 is
     free, but this opens its OWN device in-process, not via the launcher):
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-8085-strings-online-engine.py
"""
import os, sys, time
MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE); sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64
PRESET = "Belarus_8band_196modes-MFeq"
PITCHES = [54, 55, 56, 57, 58, 59, 60]
VEL = 127
DRIVER = 3  # SDL3 (real driver, NOT type 0) — matches dev-liveui-3a08
MAX_VOLUME = 5e18  # read PRE-volume float; absolute scale irrelevant to per-pitch A/B

ON_MS = 600
SETTLE_AFTER_OFF_MS = 1200  # let the note decay before reading + before next note


def rms(a):
    a = np.asarray(a, np.float64); return float(np.sqrt(np.mean(a * a))) if a.size else 0.0
def pk(a):
    a = np.asarray(a, np.float64); return float(np.max(np.abs(a))) if a.size else 0.0


print("=== dev-8085 STRINGS-mode via REAL OnlinePlaybackEngine THREAD ===", flush=True)
print(f"  preset={PRESET} pitches={PITCHES} vel={VEL} driver={DRIVER}(SDL3) listen_to_modes=0", flush=True)
PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")
try:
    p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=MAX_VOLUME,
                   audio_on=True, audio_driver_type=DRIVER, start_right_away=1,
                   listen_to_midi=0, listen_to_modes=0)
except Exception as e:
    print(f"INIT FAILED (device busy?): {e}", flush=True); sys.exit(2)

cpp = p.pianoid
nch = p.mp.num_channels
mode_iter = p.mp.mode_iteration
print(f"  num_channels={nch} mode_iteration={mode_iter} listen_to_modes={p.mp.listen_to_modes}", flush=True)


def ring_ch0():
    raw = np.asarray(cpp.getRawSoundRecord(), np.float64)
    per_cycle = mode_iter * nch
    ncyc = len(raw) // per_cycle
    if ncyc == 0:
        return np.array([])
    r = raw[:ncyc * per_cycle].reshape(ncyc, nch, mode_iter)
    return r[:, 0, :].reshape(-1)


# ensure the engine thread is running
if not (hasattr(p, "online_engine") and p.online_engine.isRunning()):
    p.start_realtime_playback_unified()
    time.sleep(0.5)
print(f"  online_engine running = {p.online_engine.isRunning()}", flush=True)


def flush_all():
    """Send NOTE_OFF for every playable pitch + settle, so each measurement starts in
    true silence (dev-liveui-3a08 method)."""
    for pt in range(21, 109):
        p.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, pt, 0, delay_ms=5)
    time.sleep(1.5)


def play_isolated(pitch):
    flush_all()
    # reset the ring just before the note so the read window is the note + decay only
    p.online_engine.pause(); time.sleep(0.08)
    cpp.clearRecords()
    p.online_engine.resume(); time.sleep(0.05)
    # NOTE_ON now, NOTE_OFF at ON_MS, then settle
    p.add_realtime_event(pianoidCuda.EventType.NOTE_ON, pitch, VEL, delay_ms=40)
    p.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, pitch, 0, delay_ms=40 + ON_MS)
    time.sleep((40 + ON_MS + SETTLE_AFTER_OFF_MS) / 1000.0 + 0.1)
    # freeze + read
    p.online_engine.pause(); time.sleep(0.08)
    ch0 = ring_ch0()
    p.online_engine.resume()
    return ch0


def windows(ch0):
    """Window-robust against realtime-scheduling jitter: find the GLOBAL peak anywhere
    in the ring (the attack), then measure sustain (peak..peak+280ms) and decay relative
    to the peak index. This removes the fixed-40ms-on assumption that the variable
    add_realtime_event delay breaks."""
    n = len(ch0)
    dur_s = n / SR
    if n == 0:
        return {"n": 0, "dur_ms": 0, "global_pk": 0.0, "peak_ms": 0.0, "sustain_rms": 0.0, "decay": {}}
    aa = np.abs(ch0)
    pidx = int(np.argmax(aa))
    gpk = float(aa[pidx])
    def w(i0, i1):
        i0 = max(0, i0); i1 = min(n, i1)
        return ch0[i0:i1] if i1 > i0 else np.array([])
    sus = rms(w(pidx, pidx + int(0.280 * SR)))
    # decay points measured from the peak (proxy for note-on); note-off is ~ON_MS after on
    decay = {d: rms(w(pidx + int((ON_MS + d) / 1000 * SR), pidx + int((ON_MS + d + 100) / 1000 * SR)))
             for d in (100, 300, 600, 1000)}
    return {"n": n, "dur_ms": dur_s * 1000, "global_pk": gpk, "peak_ms": pidx / SR * 1000,
            "sustain_rms": sus, "decay": decay}


print("\n--- per-pitch ISOLATED via real online engine thread (flush before each) ---", flush=True)
res = {}
for pt in PITCHES:
    ch0 = play_isolated(pt)
    w = windows(ch0)
    res[pt] = w
    dstr = " ".join(f"+{d}:{w['decay'][d]:.2e}" for d in (100, 300, 600, 1000))
    print(f"  pitch {pt}: n={w['n']}(~{w['dur_ms']:.0f}ms) peak={w['global_pk']:.4e}@{w['peak_ms']:.0f}ms sustain_rms={w['sustain_rms']:.4e} | decay {dstr}", flush=True)

print("\n--- DROPOUT detector (global peak relative to median) ---", flush=True)
atks = {pt: res[pt]["global_pk"] for pt in PITCHES}
pos = [v for v in atks.values() if v > 0]
med = float(np.median(pos)) if pos else 0.0
for pt in PITCHES:
    a = atks[pt]; ratio = (a / med) if med > 0 else 0.0
    tag = "  <-- DROPOUT (near-silent)" if (med > 0 and ratio < 0.05) else (
        "  <-- quiet" if (med > 0 and ratio < 0.3) else "")
    print(f"  pitch {pt}: peak={a:.4e} ratio_to_median={ratio:.4f}{tag}", flush=True)
print("\n--- sustain_rms relative to median (jitter-robust) ---", flush=True)
sus = {pt: res[pt]["sustain_rms"] for pt in PITCHES}
sm = float(np.median([v for v in sus.values() if v > 0])) if sus else 0.0
for pt in PITCHES:
    s = sus[pt]; r = (s / sm) if sm > 0 else 0.0
    tag = "  <-- DROPOUT" if (sm > 0 and r < 0.05) else ("  <-- quiet" if (sm > 0 and r < 0.3) else "")
    print(f"  pitch {pt}: sustain_rms={s:.4e} ratio_to_median={r:.4f}{tag}", flush=True)

# teardown
try:
    if hasattr(p, "online_engine") and p.online_engine.isRunning():
        p.stop_playback()
    cpp.stopApplication(True)
except Exception:
    pass
print("\n=== DONE ===", flush=True)
