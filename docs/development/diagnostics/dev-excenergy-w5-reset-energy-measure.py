"""dev-excenergy W5 — DECISIVE reset-silence + energy offline measurement / render-assertion.

WHAT THIS MEASURES (dev-reset's W5 decision tree, fully offline & cycle-deterministic — it
sidesteps the cooperative-launch box constraint because runOfflinePlayback / runSynthesisKernel
drive the kernel synchronously, not the live audio thread):

  PART 1 — RESET SILENCE (W5-B verify, the headline):
    note -> let it ring -> RELEASE (NOTE_OFF) -> /reset (resetStringsState + a reset cycle)
    -> render N>=4 fresh cycles with NO new note. Per cycle read:
        - dev_string_state  (getPianoidState: 2*total_points reals; current+prev halves)
        - dev_mode_running  (getModeDisplacements: q,q_prev = first 2*num_modes)
        - feedback/feedin cycle-matrix snapshots (getOutputData Records 6/7 — DEBUG build only)
        - output-string (128+) RMS + global output RMS (offline recorded audio of the post-reset render)
    DECISION TREE (dev-reset):
      * PRIMARY full-clear silences it (output RMS -> ~0 over cycles)            => RESET CONFIRMED FIXED.
      * string/mode ENDPOINTS read NONZERO right after reset                     => G-2 (writeback not
            landing live); STOP, report to team-lead (SECONDARY in-kernel writeback fix is dev-reset's).
      * endpoints ZERO but output still regrows after PRIMARY                    => report; dev-reset re-examines.

  PART 2 — ENERGY (B2, informational): note_playback offline render before/after a mass (or speed)
    change shows the loudness SCALING (impulse ~ m*v, linear). USER-GATED audible effect; here we
    assert the offline RMS ratio tracks the mass ratio.

BUILD REQUIREMENT: run inside PianoidCore/.venv. The feedback/feedin matrix reads (getOutputData
Records 6/7) need the DEBUG variant (PIANOID_DEBUG_DATA); set PIANOID_USE_DEBUG=1 to load it. The
string/mode endpoint reads + RMS work on either build. If the debug variant 0-cycles at boot on a
small-SM box, run with the RELEASE build (endpoint + RMS reads still decide the tree; matrix reads
just print "n/a").

RUN:
  set PIANOID_USE_DEBUG=1   (optional, enables matrix snapshots)
  PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-excenergy-w5-reset-energy-measure.py
      [--preset=BaselinePreset1] [--pitch=60] [--vel=100]
      [--ring-cyc=80] [--post-reset-cyc=6] [--mass-factor=2.0]
"""
import os, sys, json, time

MIDDLEWARE = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
os.chdir(MIDDLEWARE)
sys.path.insert(0, MIDDLEWARE)
import numpy as np
import pianoidCuda
from pianoid import initialize

SR, SPC = 48000, 64

PRESET = "BaselinePreset1"
PITCH, VEL = 60, 100
RING_CYC = 80          # cycles to ring the note before release+reset
POST_RESET_CYC = 6     # fresh cycles to render after reset (no new note)  (>=4)
MASS_FACTOR = 2.0      # PART 2 mass multiplier for the energy-scaling assertion
for a in sys.argv[1:]:
    if a.startswith("--preset="): PRESET = a.split("=", 1)[1]
    elif a.startswith("--pitch="): PITCH = int(a.split("=", 1)[1])
    elif a.startswith("--vel="): VEL = int(a.split("=", 1)[1])
    elif a.startswith("--ring-cyc="): RING_CYC = int(a.split("=", 1)[1])
    elif a.startswith("--post-reset-cyc="): POST_RESET_CYC = int(a.split("=", 1)[1])
    elif a.startswith("--mass-factor="): MASS_FACTOR = float(a.split("=", 1)[1])

PRESET_PATH = os.path.join(MIDDLEWARE, "presets", PRESET + ".json")


def rms(a):
    a = np.asarray(a, np.float64)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


def pk(a):
    a = np.asarray(a, np.float64)
    return float(np.max(np.abs(a))) if a.size else 0.0


def ms2cyc(ms):
    return max(1, int(ms * SR / (1000 * SPC)))


def cyc2ms(c):
    return int(c * SPC * 1000 / SR)


def maxabs(v):
    v = np.asarray(v, np.float64)
    return float(np.max(np.abs(v))) if v.size else 0.0


print(f"=== dev-excenergy W5 reset+energy measure: preset={PRESET} pitch={PITCH} vel={VEL} "
      f"ring={RING_CYC}cyc post-reset={POST_RESET_CYC}cyc mass-factor={MASS_FACTOR} ===", flush=True)
print(f"    pianoidCuda from: {pianoidCuda.__file__}", flush=True)
debug_build = "debug" in os.path.basename(pianoidCuda.__file__).lower()
print(f"    debug build (matrix snapshots available): {debug_build}", flush=True)

# Offline only — no audio driver, deterministic kernel cycling.
p = initialize(PRESET_PATH, filterlen=48 * 128 * 3, string_iteration=12, array_size=384,
               sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
               audio_on=False, audio_driver_type=0, start_right_away=0, listen_to_midi=0)
cpp = p.pianoid
num_modes = p.mp.num_modes
print(f"    num_modes={num_modes} num_channels={p.mp.num_channels}", flush=True)


def read_endpoints(label):
    """dev_string_state + dev_mode_running max|.| — the reset endpoints."""
    try:
        ss = np.asarray(cpp.getPianoidState(), np.float64)
    except Exception as e:
        ss = np.array([]); print(f"      [{label}] getPianoidState failed: {e}", flush=True)
    md = np.array([])
    try:
        md_full = np.asarray(cpp.getModeDisplacements(), np.float64)
        md = md_full[:2 * num_modes] if md_full.size >= 2 * num_modes else md_full  # q, q_prev
    except Exception as e:
        print(f"      [{label}] getModeDisplacements failed: {e}", flush=True)
    smax = maxabs(ss)
    mmax = maxabs(md)
    print(f"      [{label}] max|string_state|={smax:.3e}  max|mode q/q_prev|={mmax:.3e}", flush=True)
    return smax, mmax


def read_matrices(label):
    """feedback/feedin cycle-matrix snapshots (Records 6/7) — DEBUG only; informational."""
    if not debug_build:
        return None, None
    try:
        od = np.asarray(cpp.getOutputData(), np.float64)
    except Exception as e:
        print(f"      [{label}] getOutputData failed: {e}", flush=True)
        return None, None
    # The records are slices of output_data; we report only the global max|.| as a residual proxy.
    # (Exact record offsets vary; the headline signal is the audio RMS + endpoints above.)
    return maxabs(od), None


def offline_render_cycles( on_cyc, off_cyc, total_cyc):
    """Render a single-note schedule offline; return recorded audio (channel 0)."""
    q = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = on_cyc
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (PITCH << 8) | VEL; q.addEvent(on)
    if off_cyc is not None:
        off = pianoidCuda.PlaybackEvent(); off.channel = 0; off.cycle_index = off_cyc
        off.type = pianoidCuda.EventType.NOTE_OFF; off.data = (PITCH << 8) | 0; q.addEvent(off)
    q.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = cyc2ms(total_cyc); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    with p.cuda_lock:
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cpp.runOfflinePlayback(q, cfg)
        audio = np.asarray(cpp.getRecordedAudio(), np.float64)
    return audio


result = {"preset": PRESET, "pitch": PITCH, "vel": VEL, "debug_build": debug_build}

# =====================================================================
# PART 1 — RESET SILENCE
# =====================================================================
print("\n=== PART 1: RESET SILENCE (W5-B) ===", flush=True)

# 1) ring the note (NOTE_ON at cyc 1, NOTE_OFF mid-way = RELEASE), render through RING_CYC.
on_cyc = 1
off_cyc = max(2, RING_CYC // 2)        # release partway so the tail is ringing at reset time
ring_audio = offline_render_cycles(on_cyc, off_cyc, RING_CYC)
ring_rms = rms(ring_audio); ring_pk = pk(ring_audio)
print(f"  [ring] note rendered {RING_CYC}cyc, release@{off_cyc}cyc: rms={ring_rms:.3e} peak={ring_pk:.3e}", flush=True)
# endpoints WHILE ringing (after the ring render the kernel state holds the tail)
ring_smax, ring_mmax = read_endpoints("ringing")
result["ring"] = {"rms": ring_rms, "peak": ring_pk, "string_max": ring_smax, "mode_max": ring_mmax}

if ring_rms <= 0:
    print("  !! note produced NO sound — preset/pitch/vel issue; cannot judge reset. ABORT.", flush=True)
    result["verdict"] = "INCONCLUSIVE_NO_SOUND"
    print("\n===== JSON =====\n" + json.dumps(result, indent=2, default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)
    try: cpp.stopApplication(True)
    except Exception: pass
    sys.exit(3)

# 2) RESET: the button path = pianoid.reset() -> resetStringsState + a reset synthesis cycle.
print("  [reset] calling pianoid.reset() (resetStringsState + reset cycle)...", flush=True)
with p.cuda_lock:
    cpp.resetStringsState()        # sets resetFlag -> next kernel cycle is *status==500 (reset cycle)
    cpp.runSynthesisKernel()       # the reset cycle: s_a=0, s_mode=0, W5-B clears accumulators
    cpp.clearRecords()
reset_smax, reset_mmax = read_endpoints("post-reset")
reset_mat = read_matrices("post-reset")
result["post_reset"] = {"string_max": reset_smax, "mode_max": reset_mmax}

# 3) render POST_RESET_CYC fresh cycles with NO new note; read endpoints + RMS each cycle.
print(f"  [post-reset] rendering {POST_RESET_CYC} fresh cycles, NO new note:", flush=True)
post_rows = []
for c in range(POST_RESET_CYC):
    with p.cuda_lock:
        cpp.clearRecords()
        # render ONE empty cycle via an empty offline queue of length 1 cycle
        q = pianoidCuda.EventQueue()  # no events
        cfg = pianoidCuda.PlaybackConfig()
        cfg.audio_enabled = False; cfg.record_to_buffer = True
        cfg.max_duration_ms = cyc2ms(2); cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
        cpp.runOfflinePlayback(q, cfg)
        cyc_audio = np.asarray(cpp.getRecordedAudio(), np.float64)
    smax, mmax = read_endpoints(f"cyc{c}")
    cr = rms(cyc_audio)
    print(f"      [cyc{c}] post-reset output rms={cr:.3e}", flush=True)
    post_rows.append({"cyc": c, "rms": cr, "string_max": smax, "mode_max": mmax})
result["post_reset_cycles"] = post_rows

# VERDICT
max_post_rms = max((r["rms"] for r in post_rows), default=0.0)
endpoints_zero = (reset_smax < 1e-9 and reset_mmax < 1e-9)
silenced = max_post_rms < max(1e-9, 1e-3 * ring_rms)   # post-reset RMS dropped to <0.1% of ring RMS
print(f"\n  reset endpoints zero (string+mode): {endpoints_zero} (string={reset_smax:.3e} mode={reset_mmax:.3e})", flush=True)
print(f"  post-reset max output rms={max_post_rms:.3e}  vs ring rms={ring_rms:.3e}  -> silenced={silenced}", flush=True)

if silenced:
    verdict = "RESET_CONFIRMED_FIXED"
elif not endpoints_zero:
    verdict = "G-2_WRITEBACK_NOT_LANDING"   # endpoints nonzero post-reset
else:
    verdict = "ENDPOINTS_ZERO_BUT_OUTPUT_REGROWS"
result["reset_verdict"] = verdict
print(f"  >>> RESET VERDICT: {verdict}", flush=True)

# =====================================================================
# PART 2 — ENERGY SCALING (B2, informational)
# =====================================================================
print("\n=== PART 2: ENERGY SCALING (mass) ===", flush=True)
try:
    base_audio = offline_render_cycles(1, None, RING_CYC)
    base_rms = rms(base_audio)
    # multiply this pitch's hammer mass by MASS_FACTOR via the SAME model+upload path the
    # REST /excitation_energy POST uses (sm.pitches[pitch].physics.hammer_mass +
    # upload_excitation_coefficients) — exercises the live coefficient pipeline end to end.
    applied = False
    try:
        from excitation_coefficients import upload_excitation_coefficients
        pitch_obj = p.sm.pitches.get(PITCH) if hasattr(p.sm, "pitches") else None
        if pitch_obj is not None and hasattr(pitch_obj, "physics") and hasattr(pitch_obj.physics, "hammer_mass"):
            old_mass = pitch_obj.physics.hammer_mass
            pitch_obj.physics.hammer_mass = old_mass * MASS_FACTOR
            with p.cuda_lock:
                upload_excitation_coefficients(cpp, p.sm)
            print(f"  mass[{PITCH}] {old_mass:.5f} -> {pitch_obj.physics.hammer_mass:.5f} kg "
                  f"(x{MASS_FACTOR}); coefficients re-uploaded", flush=True)
            applied = True
        else:
            print(f"  (no physics.hammer_mass on pitch {PITCH} object)", flush=True)
    except Exception as e:
        print(f"  (mass-bump path error: {e})", flush=True)
    if applied:
        bumped_audio = offline_render_cycles(1, None, RING_CYC)
        bumped_rms = rms(bumped_audio)
        ratio = (bumped_rms / base_rms) if base_rms > 0 else float("nan")
        print(f"  base rms={base_rms:.3e}  mass*{MASS_FACTOR} rms={bumped_rms:.3e}  ratio={ratio:.3f} "
              f"(expect ~{MASS_FACTOR:.2f} if impulse ~ m)", flush=True)
        result["energy"] = {"base_rms": base_rms, "bumped_rms": bumped_rms,
                            "ratio": ratio, "expected": MASS_FACTOR}
    else:
        print(f"  base rms={base_rms:.3e}  (mass-scaling assertion SKIPPED — run via REST "
              f"/excitation_energy on a live backend for the user-gated audible test)", flush=True)
        result["energy"] = {"base_rms": base_rms, "note": "mass-scaling skipped in offline harness"}
except Exception as e:
    print(f"  PART 2 error: {e}", flush=True)
    result["energy"] = {"error": str(e)}

print("\n===== JSON SUMMARY =====", flush=True)
print(json.dumps(result, indent=2, default=lambda o: round(o, 6) if isinstance(o, float) else o), flush=True)

try:
    cpp.stopApplication(True)
except Exception:
    pass
print("done", flush=True)
