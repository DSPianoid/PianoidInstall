"""dev-cflfix — two CLOSING in-proc measurements (offline engine, no 3-process stack). NO fix.

Matches the KNOWN-WORKING offline render in tests/system/test_cfl_stability_guard.py (units: sample_rate=48000 Hz,
samples_per_cycle=64 — my earlier probe used 48 which gave ~0 cycles → status -18753 crash).

ITEM 1 — LENGTH destabilization render (is the gate NECESSARY + SUFFICIENT?):
  For a destabilizing SMALL length on pitch 62:
   (A) BYPASS the gate (call update_pitch_physical_params_GRANULAR directly, which set_params + uploads WITHOUT
       _raise_if_cfl_unstable) → render → does the engine go NaN/blowup? (proves length-edit CAN destabilize → the
       gate is NECESSARY).
   (B) Through the gate (update_parameter('string',...)) → does it raise CflRejected? (proves the gate is SUFFICIENT
       — covers length).
  Also string_iteration: it's a load-time global (no per-pitch granular path) — note that here, don't try to live-edit it.

ITEM 2 — getModeDisplacements after note-off (S2 confirmation):
  render NOTE_ON@0 + NOTE_OFF@t_off with a tail; read modal q at the end. If modal |q| ~ 0 → modes decayed (note-off
  fine / modes have damping). If modal |q| large → modes still ringing (would support "modes have no note-off path").

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cflfix-inproc-closing.py [pitch] [preset]
"""
import sys, os, math

MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
sys.path.insert(0, MW)
SAMPLE_RATE = 48000      # Hz — MATCHES tests/conftest.py (the working render)
SPC = 64
STRING_ITER = 4
PITCH = int(sys.argv[1]) if len(sys.argv) > 1 else 62
PRESET = sys.argv[2] if len(sys.argv) > 2 else "Belarus_8band_196modes.json"


def build():
    os.chdir(MW)
    from pianoid import initialize
    return initialize(os.path.join("presets", PRESET), filterlen=SAMPLE_RATE * 128 * 3 // 1000 * 1000 if False else 48 * 128 * 3,
                      string_iteration=STRING_ITER, array_size=384,
                      sample_rate=SAMPLE_RATE, samples_in_cycle=SPC,
                      buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)


def render(cpp, pitch, note_off_cycle, total_ms):
    import pianoidCuda, numpy as np
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.type = pianoidCuda.EventType.NOTE_ON
    on.channel = 0; on.cycle_index = 0; on.data = (pitch << 8) | 90
    eq.addEvent(on)
    if note_off_cycle is not None:
        off = pianoidCuda.PlaybackEvent(); off.type = pianoidCuda.EventType.NOTE_OFF
        off.channel = 0; off.cycle_index = note_off_cycle; off.data = (pitch << 8) | 0
        eq.addEvent(off)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = total_ms; cfg.sample_rate = SAMPLE_RATE; cfg.samples_per_cycle = SPC
    cpp.resetStringsState()
    if hasattr(cpp, "resetModeRunningState"):
        cpp.resetModeRunningState()
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    a = np.array(cpp.getRecordedAudio(), dtype=np.float64)
    md = np.array(cpp.getModeDisplacements(), dtype=np.float64)
    n = len(md) // 5
    return a, md[:n]   # audio, modal q


def stats(a):
    import numpy as np
    if a.size == 0:
        return "EMPTY"
    nan = int(np.sum(~np.isfinite(a)))
    finite = a[np.isfinite(a)]
    pk = float(np.max(np.abs(finite))) if finite.size else float('nan')
    return f"n={a.size} nan/inf={nan} peak={pk:.4e} rms={math.sqrt(float(np.mean(finite**2))) if finite.size else float('nan'):.4e}"


def main():
    import numpy as np
    print(f"===== dev-cflfix in-proc CLOSING  pitch {PITCH}  preset {PRESET}  (branch = whatever is checked out) =====")
    pw = build(); cpp = pw.pianoid; pm = pw.param_manager
    base_len = pw.sm.pitches[PITCH].geometry.length
    has_gate = hasattr(pm, "CflRejected") or hasattr(__import__("parameter_manager"), "CflRejected")
    print(f"  pitch {PITCH} preset length={base_len:.4f}  gate-present(parameter_manager.CflRejected)={has_gate}")

    # baseline render (sanity the offline engine works on this preset)
    a0, q0 = render(cpp, PITCH, None, 600)
    print(f"\n[BASELINE note-on, no edit] audio {stats(a0)}  modal|q|sum={np.abs(q0).sum():.4e}")

    # ITEM 1A — BYPASS gate: apply a destabilizing small length directly (no _raise_if_cfl_unstable), then render
    DESTAB_LEN = round(base_len * 0.1, 4)   # ~10% of preset length → ~10x smaller dx → large coeffs
    print(f"\n[ITEM 1A — BYPASS gate] apply length={DESTAB_LEN} via update_pitch_physical_params_GRANULAR (NO gate), render:")
    try:
        pm.update_pitch_physical_params_GRANULAR(int(PITCH), send_to_cuda=True, length=float(DESTAB_LEN))
        aB, qB = render(cpp, PITCH, None, 600)
        print(f"  bypass-render audio {stats(aB)}  modal|q|sum={np.abs(qB).sum():.4e}")
        nanB = int(np.sum(~np.isfinite(aB)))
        print(f"  >>> {'ENGINE DESTABILIZED (NaN/Inf) — length-edit CAN blow up → gate is NECESSARY' if nanB>0 or (np.isfinite(aB).any() and np.max(np.abs(aB[np.isfinite(aB)]))>1e3) else 'engine stayed finite at this length — try smaller'}")
    except Exception as e:
        print(f"  bypass raised: {type(e).__name__}: {e}")

    # reset model state (reload pitch length) by rebuilding is heavy; instead set length back via the gated path (stable)
    try:
        pw.update_parameter('string', {str(PITCH): {'length': float(base_len)}}, pitches=[PITCH])
    except Exception as e:
        print(f"  (restore length raised: {type(e).__name__}: {e})")

    # ITEM 1B — THROUGH gate: same destabilizing length via update_parameter → expect CflRejected
    from parameter_manager import CflRejected
    print(f"\n[ITEM 1B — THROUGH gate] length={DESTAB_LEN} via update_parameter('string') — expect CflRejected:")
    try:
        pw.update_parameter('string', {str(PITCH): {'length': float(DESTAB_LEN)}}, pitches=[PITCH])
        print("  >>> NO raise — gate did NOT fire on the destabilizing length (COVERAGE GAP if 1A destabilized)")
    except CflRejected as e:
        print(f"  >>> CflRejected raised (gate SUFFICIENT): {e}")

    # ITEM 2 — getModeDisplacements after note-off
    print(f"\n[ITEM 2 — modes after note-off] note-on@0 + note-off@{int(400*SAMPLE_RATE/1000/SPC)}cyc, 3000ms tail:")
    off_cyc = int(400 * SAMPLE_RATE / 1000 / SPC)
    aN, qN = render(cpp, PITCH, off_cyc, 3000)   # note-off at 400ms, 3s total
    aH, qH = render(cpp, PITCH, None, 3000)       # held (no note-off), 3s
    print(f"  note-OFF render: end modal|q|sum={np.abs(qN).sum():.4e} max={np.abs(qN).max():.4e}  audio {stats(aN)}")
    print(f"  HELD    render: end modal|q|sum={np.abs(qH).sum():.4e} max={np.abs(qH).max():.4e}  audio {stats(aH)}")
    qr = (np.abs(qN).sum()/np.abs(qH).sum()) if np.abs(qH).sum()>0 else 0.0
    print(f"  >>> end-modal-q note-off/held = {qr:.3f}  ({'modes persist after note-off (~same as held) → modes have no note-off path' if qr>0.7 else 'modes decayed more with note-off' if qr<0.5 else 'mixed'})")

    try: cpp.shutdownGpu()
    except Exception: pass


if __name__ == "__main__":
    main()
