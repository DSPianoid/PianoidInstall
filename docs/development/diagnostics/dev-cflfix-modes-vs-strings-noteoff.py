"""dev-cflfix — S2 attribution: after NOTE_OFF, do the MODES keep ringing (mode-Q, preset physics) or do the
STRINGS fail to damp (note-off dispatch regression)? IN-PROC offline, no backend.

Team-lead's two candidate causes for "note 62 sustains forever" on Belarus_8band_196modes:
  (a) MODE-Q RINGING: note-off damps STRINGS (dec_open=DUMP_CLOSED) but the 196 high-Q soundboard MODES have NO
      note-off path and decay only via intrinsic mode_dec → they ring on. NOT a regression; preset physics.
  (b) NOTE-OFF DISPATCH REGRESSION: the strings themselves don't damp. A real bug.

This probe renders NOTE_ON@0 + NOTE_OFF@t_off offline (runOfflinePlayback with a multi-second tail) and reads
getModeDisplacements() (q = current modal displacement) at the END, plus the audio-tail RMS after t_off. To
distinguish the two it ALSO renders a NOTE_ON-only (no note-off) baseline. Logic:
  - If note-off vs no-note-off give ~SAME end-modal-q + ~SAME tail RMS → note-off changes nothing audible →
    the energy is in the MODES (no mode note-off path) → cause (a). [Cross-check the strings damp via the
    sound difference between the two renders being SMALL relative to the persisting tail.]
  - If note-off SHARPLY cuts the tail vs no-note-off → strings (and thus the audible note) DO stop on note-off →
    note-off works; any residual is just decay. (Then a "stuck note" would have to be something else.)

Usage: PianoidCore/.venv/Scripts/python docs/development/diagnostics/dev-cflfix-modes-vs-strings-noteoff.py [pitch] [preset]
"""
import sys, os, math

MW = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                  "PianoidCore", "pianoid_middleware")
# When run from repo root the middleware dir differs; resolve robustly.
if not os.path.isdir(MW):
    MW = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware"
sys.path.insert(0, MW)

PITCH = int(sys.argv[1]) if len(sys.argv) > 1 else 62
PRESET = sys.argv[2] if len(sys.argv) > 2 else "Belarus_8band_196modes.json"
SR = 48
SPC = 64
STRING_ITER = 4


def build():
    os.chdir(MW)
    from pianoid import initialize
    return initialize(os.path.join("presets", PRESET), filterlen=SR * 128 * 3,
                      string_iteration=STRING_ITER, array_size=384, sample_rate=SR,
                      samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
                      audio_on=False, audio_driver_type=0)


def rms(xs):
    return math.sqrt(sum(x * x for x in xs) / len(xs)) if xs else 0.0


def render(cpp, pitch, note_off_cycle, total_ms):
    import pianoidCuda, numpy as np
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.type = pianoidCuda.EventType.NOTE_ON
    on.channel = 0; on.cycle_index = 0; on.data = (pitch << 8) | 100
    eq.addEvent(on)
    if note_off_cycle is not None:
        off = pianoidCuda.PlaybackEvent(); off.type = pianoidCuda.EventType.NOTE_OFF
        off.channel = 0; off.cycle_index = note_off_cycle; off.data = (pitch << 8) | 0
        eq.addEvent(off)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = total_ms; cfg.sample_rate = SR; cfg.samples_per_cycle = SPC
    cpp.resetStringsState()
    if hasattr(cpp, "resetModeRunningState"):
        cpp.resetModeRunningState()
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    audio = np.array(cpp.getRecordedAudio(), dtype=np.float64)
    md = cpp.getModeDisplacements()              # [q×N][q_prev×N][dec×N][omega×N][mass_inv×N]
    md = np.array(md, dtype=np.float64)
    n = len(md) // 5
    q = md[:n]                                    # current modal displacements
    dec = md[2 * n:3 * n]                          # mode_dec (damping)
    return audio, q, dec, n


def main():
    print(f"===== S2 modes-vs-strings: pitch {PITCH}  preset {PRESET} =====")
    pw = build()
    cpp = pw.pianoid
    sr_per_ms = SR  # 48 samples/ms (SR is in kHz here)
    total_ms = 3500
    t_off_ms = 700
    off_cycle = int(t_off_ms * SR / SPC)
    # window helpers (channel-interleaved → use the flat buffer; tail = energy after t_off)
    def tail_rms(audio):
        # samples after t_off (approx; buffer is interleaved channels but RMS over the tail is comparable)
        cut = int(t_off_ms / 1000 * SR * 1000 / 1000)  # ~ t_off_ms * SR samples (kHz*ms)
        cut = min(cut, len(audio) // 2)
        return rms(audio[cut:].tolist())

    print(f"\n-- RENDER A: NOTE_ON@0 + NOTE_OFF@{t_off_ms}ms (cycle {off_cycle}), {total_ms}ms total --")
    aA, qA, decA, n = render(cpp, PITCH, off_cycle, total_ms)
    print(f"  modes N={n}  mode_dec[min/median/max]={decA.min():.2e}/{sorted(decA)[n//2]:.2e}/{decA.max():.2e}")
    print(f"  END modal |q| sum={abs(qA).sum():.4e}  max={abs(qA).max():.4e}  (#modes |q|>1e-6: {(abs(qA)>1e-6).sum()})")
    print(f"  audio: total_rms={rms(aA.tolist()):.4e}  tail_rms(after note-off)={tail_rms(aA):.4e}")

    print(f"\n-- RENDER B: NOTE_ON@0, NO note-off, {total_ms}ms total (baseline) --")
    aB, qB, decB, _ = render(cpp, PITCH, None, total_ms)
    print(f"  END modal |q| sum={abs(qB).sum():.4e}  max={abs(qB).max():.4e}")
    print(f"  audio: total_rms={rms(aB.tolist()):.4e}  tail_rms={tail_rms(aB):.4e}")

    print("\n===== ATTRIBUTION =====")
    q_ratio = (abs(qA).sum() / abs(qB).sum()) if abs(qB).sum() > 0 else 0.0
    tail_ratio = (tail_rms(aA) / tail_rms(aB)) if tail_rms(aB) > 0 else 0.0
    print(f"  end-modal-q  note-off / no-note-off = {q_ratio:.3f}")
    print(f"  tail-rms     note-off / no-note-off = {tail_ratio:.3f}")
    if q_ratio > 0.7 and tail_ratio > 0.5:
        print("  >>> CAUSE (a) MODE-Q RINGING: note-off barely changes the modal energy or the tail — the MODES "
              "keep ringing regardless of note-off (no mode note-off path). Preset physics, NOT a regression.")
    elif tail_ratio < 0.3:
        print("  >>> note-off SHARPLY cuts the tail — the audible note DOES stop on note-off. A 'stuck note' would "
              "be something else; strings damp correctly.")
    else:
        print("  >>> MIXED — inspect: modal q persists but tail partly cut, or vice versa. Report raw numbers.")
    try:
        pw.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
