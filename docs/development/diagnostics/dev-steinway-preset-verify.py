"""
dev-steinway-preset: offline A/B verify harness (deterministic note_playback render).

Renders a spread of sample pitches (a wound-bass note, a mid, a plain-treble, and a
top note) through the runOfflinePlayback path for a GIVEN preset, measures per-note:
  - attack peak amplitude (audible attack present)
  - decay ratio late/early RMS (damps, no runaway)
  - fundamental Hz vs equal-tempered target (pitch correct)
  - NaN/Inf check

Usage:
    python dev-steinway-preset-verify.py <preset_name> [pitch1 pitch2 ...]

Adapted from tests/system/w2_chord_render.py. Init params MATCH the preset's own
model_parameters (array_size, string_iteration, samples_in_cycle) so the render is
faithful to the preset. audio_on=False, audio_driver_type=0 → strictly offline.

NOTE: loading a >56-block preset on this 56-SM GPU will exercise the cooperative
launch; if it raises cudaErrorCooperativeLaunchTooLarge that is the empirical 56-SM
confirmation (reported, not a crash to hide).
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
MIDDLEWARE_DIR = REPO_ROOT / "PianoidCore" / "pianoid_middleware"
PRESETS_DIR = MIDDLEWARE_DIR / "presets"
sys.path.insert(0, str(MIDDLEWARE_DIR))
os.chdir(MIDDLEWARE_DIR)

import pianoidCuda  # noqa: E402
from pianoid import initialize  # noqa: E402
EventType = pianoidCuda.EventType

VEL = 100
SUSTAIN_MS = 600
RENDER_MS = SUSTAIN_MS + 400

def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))

def _ev(pitch, vel, cycle, on=True):
    ev = pianoidCuda.PlaybackEvent()
    ev.type = EventType.NOTE_ON if on else EventType.NOTE_OFF
    ev.channel = 0
    ev.cycle_index = cycle
    ev.data = (pitch << 8) | (vel if on else 0)
    return ev

def render_pitch(cpp, sr, spc, pitch):
    off_cycle = int((SUSTAIN_MS / 1000.0) * sr / spc)
    eq = pianoidCuda.EventQueue()
    eq.addEvent(_ev(pitch, VEL, 1, on=True))
    eq.addEvent(_ev(pitch, VEL, off_cycle, on=False))
    eq.sortByCycle()
    cpp.resetStringsState()
    cpp.runSynthesisKernel()
    cpp.clearRecords()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.sample_rate = sr
    cfg.samples_per_cycle = spc
    cfg.max_duration_ms = RENDER_MS
    cpp.runOfflinePlayback(eq, cfg)
    return np.array(cpp.getRecordedAudio(), dtype=np.float64)

def fundamental_hz(audio, sr, target):
    n = len(audio)
    if n == 0:
        return 0.0
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft(audio * win))
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    # search within +-6% of target
    lo, hi = target * 0.94, target * 1.06
    mask = (freqs >= lo) & (freqs <= hi)
    if not np.any(mask):
        # fall back to global peak above 20 Hz
        mask = freqs > 20
    idx = np.argmax(spec[mask])
    return float(freqs[mask][idx])

def analyse(audio, sr, target):
    if len(audio) == 0:
        return dict(samples=0, peak=0, nan=False, decay_ratio=None, f0=0.0, target=target)
    nan = bool(np.any(~np.isfinite(audio)))
    peak = float(np.max(np.abs(audio)))
    nseg = len(audio) // 5
    early = float(np.sqrt(np.mean(audio[:nseg] ** 2))) if nseg else 0.0
    late = float(np.sqrt(np.mean(audio[-nseg:] ** 2))) if nseg else 0.0
    decay_ratio = (late / early) if early > 0 else None
    f0 = fundamental_hz(audio, sr, target)
    return dict(samples=len(audio), peak=peak, nan=nan, decay_ratio=decay_ratio,
                f0=round(f0, 2), target=round(target, 2), cents=round(1200*np.log2(f0/target), 1) if f0>0 else None)

def main():
    if len(sys.argv) < 2:
        print("usage: dev-steinway-preset-verify.py <preset_name> [pitches...]")
        return 2
    preset_name = sys.argv[1]
    preset_path = PRESETS_DIR / preset_name
    d = json.load(open(preset_path, encoding="utf-8"))
    mp = d["model_parameters"]
    # default sample pitches: wound bass, mid, plain treble, top — clamp to those present
    avail_piano = sorted(int(k) for k in d["pitches"] if int(k) < 128)
    if len(sys.argv) > 2:
        pitches = [int(x) for x in sys.argv[2:]]
    else:
        cand = [28, 41, 60, 84, max(avail_piano)]
        pitches = [p for p in cand if p in avail_piano]
    print(f"=== offline verify: {preset_name} ===")
    print(f"model_parameters: array_size={mp['array_size']} nsa={mp['num_strings_in_array']} "
          f"num_strings={mp['num_strings']} blocks={len(d.get('blocks',[]))} sr={mp['sr']} "
          f"string_iteration={mp['string_iteration']} mode_iteration={mp['mode_iteration']} "
          f"listen_to_modes={mp.get('listen_to_modes')}")
    print(f"sample pitches: {pitches}")

    p = initialize(
        str(preset_path),
        filterlen=48 * 128 * 3,
        string_iteration=mp["string_iteration"],
        array_size=mp["array_size"],
        buffer_size=mp.get("buffer_size", 2),
        sample_rate=mp["sr"],
        samples_in_cycle=mp["mode_iteration"],
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
    )
    try:
        sr = p.mp.sample_rate()
        spc = p.mp.mode_iteration
        results = {}
        for pitch in pitches:
            audio = render_pitch(p.pianoid, sr, spc, pitch)
            res = analyse(audio, sr, midi_to_hz(pitch))
            results[pitch] = res
            note = f"{['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][pitch%12]}{pitch//12 - 1}"
            print(f"  MIDI {pitch:>3} {note:>4}: samples={res['samples']:>6} peak={res['peak']:.4g} "
                  f"nan={res['nan']} decay={res['decay_ratio']} f0={res['f0']}Hz target={res['target']}Hz "
                  f"cents={res['cents']}")
        return 0
    finally:
        try:
            p.pianoid.shutdownGpu()
        except Exception:
            pass

if __name__ == "__main__":
    sys.exit(main())
