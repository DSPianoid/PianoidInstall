"""dev-exp2 — bow-sustains-vs-hammer-decays verification (universal-excitation Phase 2).

Renders the SAME pitch offline (audio_off) as hammer (IMPULSE/CLAMP) and as bow (SUSTAINED/WRAP),
holding the note for `hold_ms` then releasing (note-off) with a tail window. Computes a windowed-RMS
envelope for each and reports:
  - sustain ratio = RMS(late-hold window) / RMS(early-hold window):
      hammer << 1 (decays away)   |   bow >= ~1 (sustains; may GROW un-normalized — expected, Phase 4)
  - tail-out    = RMS(post-note-off) relative to hold: bow drops after release (dec_open -> CLAMP)
  - finite check (no NaN/Inf) — a short render guards against un-normalized runaway.
"""
import os
import sys
import numpy as np

MW = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "PianoidCore", "pianoid_middleware",
)
sys.path.insert(0, MW)
os.chdir(MW)
import pianoidCuda
print("pianoidCuda:", pianoidCuda.__file__)
from pianoid import initialize

SR, SPC = 48000, 64
HOLD_MS = 150      # note held (bow should sustain here)
TAIL_MS = int(os.environ.get("EXP2_TAIL_MS", "100"))  # after note-off (bow should tail out)
WIN_MS = 10        # envelope window


def build_eq(pitch, velocity, hold_ms):
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0; on.cycle_index = 0; on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (pitch << 8) | velocity
    eq.addEvent(on)
    cycles = int((hold_ms / 1000.0) * SR / SPC)
    off = pianoidCuda.PlaybackEvent()
    off.channel = 0; off.cycle_index = cycles; off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()
    return eq, cycles


def render(p, pitch, velocity):
    cpp = p.pianoid
    sr = p.mp.sample_rate(); spc = p.mp.mode_iteration
    cpp.waitForParameterUpdate()
    cpp.resetStringsState()
    eq, off_cycles = build_eq(pitch, velocity, HOLD_MS)
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.sample_rate = sr; cfg.samples_per_cycle = spc
    cfg.max_duration_ms = HOLD_MS + TAIL_MS
    cpp.clearRecords()
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)


def envelope(audio, sr=SR, win_ms=WIN_MS):
    # audio is interleaved stereo (2ch); collapse to mono magnitude for the envelope
    if audio.ndim == 1 and audio.size % 2 == 0:
        a = audio.reshape(-1, 2).mean(axis=1)
    else:
        a = audio
    w = max(1, int(win_ms / 1000.0 * sr))
    n = len(a) // w
    return np.array([np.sqrt(np.mean(a[i*w:(i+1)*w]**2)) for i in range(n)])


def summarize(name, audio):
    finite = bool(np.all(np.isfinite(audio)))
    env = envelope(audio)
    hold_wins = int(HOLD_MS / WIN_MS)
    early = env[1:4]            # ~10-40ms (after attack)
    late = env[hold_wins-4:hold_wins-1]  # last ~30ms of the hold
    tail = env[hold_wins+1:hold_wins+6]  # ~10-60ms after note-off
    early_rms = float(np.mean(early)) if early.size else 0.0
    late_rms = float(np.mean(late)) if late.size else 0.0
    tail_rms = float(np.mean(tail)) if tail.size else 0.0
    sustain_ratio = late_rms / early_rms if early_rms > 0 else 0.0
    tail_drop = tail_rms / late_rms if late_rms > 0 else 0.0
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    print(f"  [{name}] finite={finite} peak={peak:.4g} "
          f"early_rms={early_rms:.4g} late_hold_rms={late_rms:.4g} tail_rms={tail_rms:.4g}")
    print(f"         sustain_ratio(late/early)={sustain_ratio:.3g}  tail_drop(tail/late)={tail_drop:.3g}")
    return dict(finite=finite, sustain_ratio=sustain_ratio, tail_drop=tail_drop, env=env)


def main():
    pitch = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    vel = 100
    p = initialize(
        os.path.join("presets", "Preset_test5.json"),
        filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
        sample_rate=SR, samples_in_cycle=SPC, buffer_size=4, max_volume=5e18,
        audio_on=False, audio_driver_type=0,
    )
    print(f"\n=== pitch {pitch} vel {vel}: HOLD {HOLD_MS}ms + TAIL {TAIL_MS}ms ===")
    # HAMMER (default IMPULSE)
    p.pianoid.setPitchExcitationMode(pitch, 0)
    assert p.pianoid.getPitchExcitationMode(pitch) == 0
    hammer = summarize("HAMMER", render(p, pitch, vel))
    # BOW (SUSTAINED)
    n = p.pianoid.setPitchExcitationMode(pitch, 1)
    print(f"  setPitchExcitationMode(bow) -> {n} strings updated; getMode={p.pianoid.getPitchExcitationMode(pitch)}")
    bow = summarize("BOW   ", render(p, pitch, vel))
    # revert
    p.pianoid.setPitchExcitationMode(pitch, 0)

    print("\n=== VERDICT ===")
    hammer_decays = hammer["sustain_ratio"] < 0.6
    bow_sustains = bow["sustain_ratio"] > max(1.5 * hammer["sustain_ratio"], 0.8)
    bow_tails = bow["tail_drop"] < 0.9
    print(f"  hammer DECAYS during hold (sustain_ratio {hammer['sustain_ratio']:.3g} < 0.6): {hammer_decays}")
    print(f"  bow SUSTAINS during hold (sustain_ratio {bow['sustain_ratio']:.3g} >> hammer): {bow_sustains}")
    print(f"  bow TAILS OUT after note-off (tail_drop {bow['tail_drop']:.3g} < 0.9): {bow_tails}")
    print(f"  both FINITE (no runaway NaN/Inf): {hammer['finite'] and bow['finite']}")
    ok = hammer_decays and bow_sustains and bow_tails and hammer["finite"] and bow["finite"]
    print("  PHASE-2 SUSTAIN VERDICT:", "PASS" if ok else "REVIEW")
    # Tail-out trajectory: bow RMS at horizons after note-off, relative to the peak-hold level.
    off = int(HOLD_MS / WIN_MS)
    benv = bow["env"]
    hold_peak = float(np.max(benv[:off])) if off > 0 else 0.0
    print(f"\n  BOW tail-out (hold_peak={hold_peak:.4g}); RMS at +ms after note-off:")
    for ms in [0, 30, 60, 100, 200, 300, 400]:
        idx = off + ms // WIN_MS
        if idx < len(benv):
            print(f"    +{ms:4d}ms: rms={benv[idx]:.4g}  ({benv[idx]/hold_peak:.2f}x hold_peak)")
    print("\nHAMMER env:", np.array2string(hammer["env"], precision=3, max_line_width=240, threshold=10000))
    print("\nBOW env:", np.array2string(bow["env"], precision=3, max_line_width=240, threshold=10000))
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
