"""dev-427c — STEP A: stress harness to FORCE the P1-1 GPU-pointer authority race
and observe its symptom (the 55/56/57 trichotomy) on the REAL in-process online engine.

THE RACE (confirmed in code, Step 1):
  - Engine thread (runSynthesisKernel, Pianoid_synthesis.cu:191/216/239 + kernelArgs
    &dev_mode_state/&dev_deck_parameters/&dev_hammer at Pianoid.cu:557/569/571) reads the
    swappable raw `real*` members LOCK-FREE at kernel-launch marshaling.
  - Poll thread (UnifiedGpuMemoryManager::swapBuffers, :874-887) WRITES those same members
    (`*ptr_ref = working+offset`) under update_mutex_, on every async param update / preset swap.
  - The engine never takes update_mutex_  ⟹  C++ data race on `real*` + GPU race on which
    double-buffer half is live, plus syncBuffers (:894) overwriting the just-swapped-out buffer.

WHAT THIS HARNESS DOES:
  Drive a sustained note on each trichotomy pitch on the REAL OnlinePlaybackEngine thread
  (start_realtime_playback_unified spins it up; the poll thread is created in devMemoryInit),
  WHILE a concurrent "swap-storm" thread hammers updateMultiStringParameter_NEW at maximum
  rate to keep swapBuffers firing every few engine cycles. Then look for the symptom:
    (a) NaN / Inf in the per-cycle soundFloat ring (a torn pointer → garbage GPU read),
    (b) glitch spikes — sudden per-window amplitude discontinuities absent in a no-swap control,
    (c) decay-profile corruption — "does not decay" (56) under swap-storm vs clean control,
    (d) torn readback — getModeDisplacements() returning Inf/NaN/absurd values mid-storm.

  CONTROL vs STORM: each pitch is measured twice — once with NO concurrent updates (control),
  once under the swap-storm — so any anomaly is attributable to the concurrent swap, not the pitch.

RUN (opens SDL3 — needs the audio device free; backend must be down):
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-427c-p1-authority-race-stress.py

Honest framing (per dispatch): this race is a transient single-cycle corruption. If the
storm does not surface an observable anomaly after real effort, that is reported as
"could not force from Python on the surrogate" — NOT as "no race" (the race is proven in code).
"""
import os, sys, time, threading
MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE); sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64
PRESET = "Belarus_8band_196modes-MFeq"
PITCHES = [55, 56, 57]
VEL = 127
DRIVER = 3            # SDL3 — the real online path the user drives
MAX_VOLUME = 5e18     # PRE-volume float read; absolute scale irrelevant to per-pitch A/B
LISTEN_TO_MODES = 0   # STRINGS mode — the bug's reported config

ON_MS = 1500          # long sustain so the storm overlaps many cycles + the decay tail
SETTLE_AFTER_OFF_MS = 1400
STORM_SECONDS = None  # storm runs for the full note (set in play())

# Two contrasting damper values to force a real parameter STEP each storm iteration:
#   - DAMP_KILL: large damper (note should die fast)
#   - DAMP_SUST: ~0 damper (note should sustain)
# A clean double-buffer makes the engine see a smooth step old->new. A torn/stale/mixed
# pointer read makes the engine read a half-updated buffer => glitch.
DAMP_KILL = 5.0e-3
DAMP_SUST = 1.0e-7


def rms(a):
    a = np.asarray(a, np.float64); return float(np.sqrt(np.mean(a * a))) if a.size else 0.0
def pk(a):
    a = np.asarray(a, np.float64); return float(np.max(np.abs(a))) if a.size else 0.0


print("=== dev-427c P1-1 AUTHORITY-RACE STRESS HARNESS ===", flush=True)
print(f"  preset={PRESET} pitches={PITCHES} vel={VEL} driver={DRIVER}(SDL3) listen_to_modes={LISTEN_TO_MODES}", flush=True)
PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")
try:
    p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
                   sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=MAX_VOLUME,
                   audio_on=True, audio_driver_type=DRIVER, start_right_away=1,
                   listen_to_midi=0, listen_to_modes=LISTEN_TO_MODES)
except Exception as e:
    print(f"INIT FAILED (device busy?): {e}", flush=True); sys.exit(2)

cpp = p.pianoid
nch = p.mp.num_channels
mode_iter = p.mp.mode_iteration
print(f"  num_channels={nch} mode_iteration={mode_iter} listen_to_modes={p.mp.listen_to_modes}", flush=True)

# DROP_IF_BUSY (default) means many storm updates are dropped while one is in flight.
# That is FINE — every accepted update still fires a swap, and DROP_IF_BUSY is the
# production policy, so this matches live conditions.

# Map each trichotomy pitch to its CUDA string indices (for direct granular updates)
sm = p.sm
def cuda_indices(pitch):
    pit = sm.pitches[pitch]
    return [sm.string_index.index(sid) for sid in pit.stringIDs]

PITCH_IDX = {pt: cuda_indices(pt) for pt in PITCHES}
print(f"  cuda string indices: " + ", ".join(f"{pt}->{PITCH_IDX[pt]}" for pt in PITCHES), flush=True)


def ring_ch0():
    raw = np.asarray(cpp.getRawSoundRecord(), np.float64)
    per_cycle = mode_iter * nch
    ncyc = len(raw) // per_cycle
    if ncyc == 0:
        return np.array([])
    r = raw[:ncyc * per_cycle].reshape(ncyc, nch, mode_iter)
    return r[:, 0, :].reshape(-1)


if not (hasattr(p, "online_engine") and p.online_engine.isRunning()):
    p.start_realtime_playback_unified()
    time.sleep(0.5)
print(f"  online_engine running = {p.online_engine.isRunning()}", flush=True)


def flush_all():
    for pt in range(21, 109):
        p.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, pt, 0, delay_ms=5)
    time.sleep(1.2)


# ---- swap-storm thread -----------------------------------------------------
class SwapStorm(threading.Thread):
    def __init__(self, idxs):
        super().__init__(daemon=True)
        self.idxs = idxs
        self._stop = threading.Event()
        self.accepted = 0
        self.attempts = 0
        self.exc = 0

    def run(self):
        toggle = False
        while not self._stop.is_set():
            toggle = not toggle
            val = DAMP_SUST if toggle else DAMP_KILL
            vals = [val] * len(self.idxs)
            try:
                ok = cpp.updateMultiStringParameter_NEW("damper_string", self.idxs, vals)
                self.attempts += 1
                if ok:
                    self.accepted += 1
            except Exception:
                self.exc += 1
            # also hammer mode_state via setNewModeParameters? No — keep to the granular
            # path that the live editor uses. Tight loop maximizes swap frequency.

    def stop(self):
        self._stop.set()


# ---- torn-readback probe thread -------------------------------------------
class ReadbackProbe(threading.Thread):
    """Repeatedly read getModeDisplacements() (reads dev_mode_state — a swappable
    pointer). If a swap tears the pointer, this can return Inf/NaN/absurd values."""
    def __init__(self):
        super().__init__(daemon=True)
        self._stop = threading.Event()
        self.bad = 0
        self.reads = 0
        self.worst = 0.0

    def run(self):
        while not self._stop.is_set():
            try:
                md = np.asarray(cpp.getModeDisplacements(), np.float64)
                self.reads += 1
                if md.size:
                    mx = float(np.max(np.abs(md[np.isfinite(md)]))) if np.any(np.isfinite(md)) else float("inf")
                    if (not np.all(np.isfinite(md))) or mx > 1e12:
                        self.bad += 1
                        self.worst = max(self.worst, mx if np.isfinite(mx) else 1e300)
            except Exception:
                self.bad += 1
            time.sleep(0.0005)

    def stop(self):
        self._stop.set()


def analyze(ch0, label):
    n = len(ch0)
    if n == 0:
        return {"n": 0}
    aa = np.abs(ch0)
    finite = np.isfinite(ch0)
    nbad = int(np.sum(~finite))
    pidx = int(np.argmax(np.where(finite, aa, 0)))
    gpk = float(aa[pidx]) if np.isfinite(aa[pidx]) else float("inf")
    dur_s = n / SR

    def w(i0, i1):
        i0 = max(0, i0); i1 = min(n, i1)
        return ch0[i0:i1] if i1 > i0 else np.array([])
    # decay points measured from peak (proxy for note-on); note-off ~ON_MS after on
    decay = {d: rms(w(pidx + int((ON_MS + d) / 1000 * SR), pidx + int((ON_MS + d + 120) / 1000 * SR)))
             for d in (100, 400, 900)}
    on_rms = rms(w(pidx, pidx + int(0.30 * SR)))
    # glitch detector: largest single-sample jump (|x[i]-x[i-1]|) relative to peak
    if n > 1 and np.all(finite):
        diffs = np.abs(np.diff(ch0))
        max_jump = float(np.max(diffs))
        jump_ratio = max_jump / gpk if gpk > 0 else 0.0
    else:
        max_jump = float("inf"); jump_ratio = float("inf")
    tail_decay = decay[900] / on_rms if on_rms > 0 else 0.0
    return {"n": n, "dur_ms": dur_s * 1000, "nonfinite": nbad, "peak": gpk,
            "peak_ms": pidx / SR * 1000, "on_rms": on_rms, "decay": decay,
            "tail_decay_ratio": tail_decay, "max_jump": max_jump, "jump_ratio": jump_ratio}


def play(pitch, storm):
    flush_all()
    p.online_engine.pause(); time.sleep(0.08)
    cpp.clearRecords()
    p.online_engine.resume(); time.sleep(0.05)

    st = rb = None
    if storm:
        st = SwapStorm(PITCH_IDX[pitch]); st.start()
        rb = ReadbackProbe(); rb.start()

    p.add_realtime_event(pianoidCuda.EventType.NOTE_ON, pitch, VEL, delay_ms=40)
    p.add_realtime_event(pianoidCuda.EventType.NOTE_OFF, pitch, 0, delay_ms=40 + ON_MS)
    time.sleep((40 + ON_MS + SETTLE_AFTER_OFF_MS) / 1000.0 + 0.1)

    storm_stats = {}
    if storm:
        st.stop(); rb.stop(); time.sleep(0.05)
        storm_stats = {"swap_attempts": st.attempts, "swap_accepted": st.accepted,
                       "swap_exc": st.exc, "rb_reads": rb.reads, "rb_bad": rb.bad,
                       "rb_worst": rb.worst}

    p.online_engine.pause(); time.sleep(0.08)
    ch0 = ring_ch0()
    p.online_engine.resume()
    return ch0, storm_stats


print("\n" + "=" * 78, flush=True)
print("PASS 1 — CONTROL (no concurrent updates): establishes clean per-pitch behavior", flush=True)
print("=" * 78, flush=True)
ctrl = {}
for pt in PITCHES:
    ch0, _ = play(pt, storm=False)
    a = analyze(ch0, f"ctrl-{pt}")
    ctrl[pt] = a
    dstr = " ".join(f"+{d}:{a['decay'][d]:.2e}" for d in (100, 400, 900))
    print(f"  pitch {pt} CTRL: n={a['n']}(~{a['dur_ms']:.0f}ms) nonfinite={a['nonfinite']} "
          f"peak={a['peak']:.3e}@{a['peak_ms']:.0f}ms on_rms={a['on_rms']:.3e} "
          f"tail_decay={a['tail_decay_ratio']:.4f} jump_ratio={a['jump_ratio']:.3f} | decay {dstr}", flush=True)


print("\n" + "=" * 78, flush=True)
print("PASS 2 — SWAP-STORM (concurrent updateMultiStringParameter_NEW hammering swapBuffers)", flush=True)
print("=" * 78, flush=True)
storm = {}
for pt in PITCHES:
    ch0, ss = play(pt, storm=True)
    a = analyze(ch0, f"storm-{pt}")
    storm[pt] = (a, ss)
    dstr = " ".join(f"+{d}:{a['decay'][d]:.2e}" for d in (100, 400, 900))
    print(f"  pitch {pt} STORM: n={a['n']}(~{a['dur_ms']:.0f}ms) nonfinite={a['nonfinite']} "
          f"peak={a['peak']:.3e}@{a['peak_ms']:.0f}ms on_rms={a['on_rms']:.3e} "
          f"tail_decay={a['tail_decay_ratio']:.4f} jump_ratio={a['jump_ratio']:.3f} | decay {dstr}", flush=True)
    print(f"           swaps: attempts={ss['swap_attempts']} accepted={ss['swap_accepted']} "
          f"exc={ss['swap_exc']} | readback: reads={ss['rb_reads']} BAD={ss['rb_bad']} "
          f"worst={ss['rb_worst']:.2e}", flush=True)


print("\n" + "=" * 78, flush=True)
print("VERDICT — symptom forced?", flush=True)
print("=" * 78, flush=True)
forced = False
for pt in PITCHES:
    a, ss = storm[pt]
    c = ctrl[pt]
    flags = []
    if a["nonfinite"] > 0:
        flags.append(f"NONFINITE x{a['nonfinite']} in soundFloat ring")
    if ss["rb_bad"] > 0:
        flags.append(f"TORN READBACK x{ss['rb_bad']} (worst={ss['rb_worst']:.2e})")
    # glitch: storm jump_ratio markedly exceeds control (transient discontinuity)
    if np.isfinite(a["jump_ratio"]) and np.isfinite(c["jump_ratio"]) and c["jump_ratio"] > 0:
        if a["jump_ratio"] > 3.0 * c["jump_ratio"] and a["jump_ratio"] > 0.5:
            flags.append(f"GLITCH jump_ratio {a['jump_ratio']:.2f} vs ctrl {c['jump_ratio']:.2f}")
    if a["nonfinite"] > 0 or not np.isfinite(a["jump_ratio"]):
        flags.append("INF jump (torn buffer)")
    tag = ("  <<< SYMPTOM FORCED: " + "; ".join(flags)) if flags else "  (no anomaly vs control)"
    if flags:
        forced = True
    print(f"  pitch {pt}:{tag}", flush=True)

print(f"\n  RACE SYMPTOM FORCED ON SURROGATE = {forced}", flush=True)
if not forced:
    print("  -> Could NOT force an observable anomaly from Python on this surrogate in this run.", flush=True)
    print("     The race is PROVEN IN CODE (Step 1); it may be too narrow to force on demand", flush=True)
    print("     from the Python surrogate. See log for the code-level proof.", flush=True)

try:
    if hasattr(p, "online_engine") and p.online_engine.isRunning():
        p.stop_playback()
    cpp.stopApplication(True)
except Exception:
    pass
print("\n=== DONE ===", flush=True)
