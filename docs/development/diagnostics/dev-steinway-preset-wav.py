"""
dev-steinway-preset: render a preset's FULL keyboard to a single WAV (ascending chromatic sweep).

STANDING SPEC (user-directed 2026-06-04): 200 ms/note + PER-NOTE normalization so every note is
clearly audible (a single global peak would let the loud bass dominate and bury the treble). Each
piano note (MIDI low..high) is rendered offline (audio_off, deterministic), each peak-normalized to
~-1 dBFS, with a short fade-out to avoid concatenation clicks, then joined into one mono 48k WAV.

Usage: python dev-steinway-preset-wav.py <preset_name> <out_wav_path> [note_seconds]
"""
import sys, os, json, wave
import numpy as np
sys.path.insert(0, r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
import pianoidCuda  # noqa
from pianoid import initialize  # noqa
ET = pianoidCuda.EventType

NOTE_S_DEFAULT = 0.20          # 200 ms/note (standing spec)
PEAK_DBFS = -1.0               # per-note normalization target
TARGET_PEAK = int(32767 * 10 ** (PEAK_DBFS / 20.0))   # ~29234

def ev(p, v, c, on=True):
    e = pianoidCuda.PlaybackEvent(); e.type = ET.NOTE_ON if on else ET.NOTE_OFF
    e.channel = 0; e.cycle_index = c; e.data = (p << 8) | (v if on else 0); return e

def main():
    preset = sys.argv[1]
    out_path = sys.argv[2]
    note_s = float(sys.argv[3]) if len(sys.argv) > 3 else NOTE_S_DEFAULT
    d = json.load(open("presets/" + preset, encoding="utf-8"))
    mp = d["model_parameters"]
    piano = sorted(int(k) for k in d["pitches"] if int(k) < 128)

    p = initialize("presets/" + preset, filterlen=48*128*3, string_iteration=mp["string_iteration"],
                   array_size=mp["array_size"], buffer_size=mp.get("buffer_size", 2),
                   sample_rate=mp["sr"], samples_in_cycle=mp["mode_iteration"],
                   max_volume=5e18, audio_on=False, audio_driver_type=0)
    sr = p.mp.sample_rate(); spc = p.mp.mode_iteration
    n = len(piano)
    print(f"Preset {preset}: {n} notes {piano[0]}-{piano[-1]}, {note_s*1000:.0f}ms/note, "
          f"per-note norm to {PEAK_DBFS}dBFS (peak {TARGET_PEAK}), sr={sr}")

    sustain_ms = note_s * 1000 * 0.6   # held ~60%, rest is natural decay
    render_ms = note_s * 1000
    nsamp = int(note_s * sr)
    fade = int(0.004 * sr)             # 4 ms fade-out to avoid clicks at note joins
    fwin = np.linspace(1.0, 0.0, fade) if fade > 0 else None
    cpp = p.pianoid
    chunks = []
    for pitch in piano:
        off = max(1, int((sustain_ms/1000.0) * sr / spc))
        eq = pianoidCuda.EventQueue(); eq.addEvent(ev(pitch, 100, 1)); eq.addEvent(ev(pitch, 100, off, False)); eq.sortByCycle()
        cpp.resetStringsState(); cpp.runSynthesisKernel(); cpp.clearRecords()
        cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled = False; cfg.record_to_buffer = True
        cfg.sample_rate = sr; cfg.samples_per_cycle = spc; cfg.max_duration_ms = int(render_ms)
        cpp.runOfflinePlayback(eq, cfg)
        a = np.array(cpp.getRecordedAudio(), dtype=np.float64)
        # fixed length per note
        if len(a) >= nsamp:
            a = a[:nsamp]
        else:
            a = np.pad(a, (0, nsamp - len(a)))
        # PER-NOTE normalize to target peak (clearly audible regardless of raw amplitude)
        pk = float(np.max(np.abs(a)))
        if pk > 1e-9:
            a = a / pk * TARGET_PEAK
        if fwin is not None and len(a) > fade:
            a[-fade:] *= fwin
        chunks.append(a)
    full = np.concatenate(chunks) if chunks else np.zeros(1)
    scaled = np.clip(full, -32768, 32767).astype(np.int16)
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes(scaled.tobytes())
    dur = len(full) / sr
    size = os.path.getsize(out_path)
    print(f"WROTE {out_path}")
    print(f"  notes={n} duration={dur:.1f}s sr={sr} size={size/1024/1024:.2f}MB "
          f"per-note-peak={TARGET_PEAK} (~{PEAK_DBFS}dBFS)")
    try:
        cpp.shutdownGpu()
    except Exception:
        pass

if __name__ == "__main__":
    main()
