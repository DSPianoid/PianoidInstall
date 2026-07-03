"""dev-strregr — tension -> fundamental regression measurement harness.

In-process audio_off offline render. Drives the REAL granular apply path
(pianoid.update_parameter("string", {"tension": v}, pitches=[P])) exactly as the
Strings panel does, and measures the synthesized FUNDAMENTAL FREQUENCY (FFT peak,
parabolic-interpolated) + RMS before/after each edit.

Run from PianoidCore with the project venv:
  PianoidCore/.venv/Scripts/python.exe docs/development/diagnostics/dev-strregr-tension-sweep.py
"""
import os
import sys
import math
import json
import numpy as np

MIDDLEWARE_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..",
                              "PianoidCore", "pianoid_middleware")
MIDDLEWARE_DIR = os.path.abspath(MIDDLEWARE_DIR)
sys.path.insert(0, MIDDLEWARE_DIR)

SAMPLE_RATE = 48000
SAMPLES_PER_CYCLE = 64
VELOCITY = 90
RENDER_MS = 800
TAIL_MS = 100
SKIP_MS = 120   # skip attack transient before FFT


def midi_to_freq(p):
    return 440.0 * (2.0 ** ((p - 69) / 12.0))


def render_fundamental(p, pitch, velocity=VELOCITY):
    """Offline-render one note, return (fundamental_hz, rms, peak, n)."""
    import pianoidCuda
    cyc_note = max(1, int(RENDER_MS / 1000.0 * SAMPLE_RATE / SAMPLES_PER_CYCLE))
    total_ms = RENDER_MS + TAIL_MS

    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent()
    on.channel = 0; on.cycle_index = 0
    on.type = pianoidCuda.EventType.NOTE_ON
    on.data = (pitch << 8) | velocity
    eq.addEvent(on)
    off = pianoidCuda.PlaybackEvent()
    off.channel = 0; off.cycle_index = cyc_note
    off.type = pianoidCuda.EventType.NOTE_OFF
    off.data = (pitch << 8) | 0
    eq.addEvent(off)
    eq.sortByCycle()

    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.max_duration_ms = total_ms + 200
    cfg.sample_rate = SAMPLE_RATE
    cfg.samples_per_cycle = SAMPLES_PER_CYCLE

    cuda = p.pianoid
    with p.cuda_lock:
        cuda.waitForParameterUpdate()
        cuda.resetStringsState()
        cuda.runSynthesisKernel()  # flush deferred reset
        cuda.clearRecords()
        stats = cuda.runOfflinePlayback(eq, cfg)
        if not stats.completed_successfully:
            raise RuntimeError(f"render failed pitch {pitch}: {stats.error_message}")
        raw = cuda.getRecordedAudio()

    sound = np.array(raw, dtype=np.float64)
    skip = int(SKIP_MS / 1000.0 * SAMPLE_RATE)
    end = int(RENDER_MS / 1000.0 * SAMPLE_RATE)
    seg = sound[skip:end]
    if len(seg) < 1024:
        return (0.0, 0.0, 0.0, 0.0, len(sound))

    rms = float(np.sqrt(np.mean(seg ** 2)))
    peak = float(np.max(np.abs(seg)))

    f0_ac = autocorr_f0(seg, SAMPLE_RATE, fmin=40.0, fmax=2000.0)
    f0_pk = strongest_peak_hz(seg, SAMPLE_RATE)
    logspec = log_freq_spectrum(seg, SAMPLE_RATE)
    return (f0_ac, f0_pk, rms, peak, len(sound), logspec)


# Log-frequency spectrum + cross-correlation shift: measures the whole-spectrum
# frequency SCALING factor between two renders (robust to inharmonicity + dense
# soundboard mixes). If the string tension scales the whole partial series by s,
# the log-spectrum shifts by ln(s). Physics: s should equal sqrt(T/T_base).
LOG_FMIN, LOG_FMAX, LOG_N = 100.0, 4000.0, 2048
_LOG_AXIS = np.exp(np.linspace(math.log(LOG_FMIN), math.log(LOG_FMAX), LOG_N))
_DLOG = (math.log(LOG_FMAX) - math.log(LOG_FMIN)) / (LOG_N - 1)


def log_freq_spectrum(seg, sr):
    win = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * win))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    ls = np.interp(_LOG_AXIS, freqs, spec)
    ls = ls - np.mean(ls)
    n = np.linalg.norm(ls)
    return ls / n if n > 0 else ls


def spectral_scale_factor(ls_base, ls, max_ln=0.55):
    """Cross-correlate two log-spectra; return frequency scaling factor s
    (edited relative to base) via the lag of peak correlation. The lag search
    is constrained to |ln s| <= max_ln (default ~octave-half) to prevent
    octave-lock false peaks in dense/inharmonic spectra."""
    corr = np.correlate(ls, ls_base, mode='full')
    zero = len(ls_base) - 1              # lag == 0 index
    max_lag = int(max_ln / _DLOG)
    lo = max(0, zero - max_lag)
    hi = min(len(corr), zero + max_lag + 1)
    idx = lo + int(np.argmax(corr[lo:hi]))
    lag = idx - zero
    if 1 <= idx < len(corr) - 1:
        a, b, c = corr[idx - 1], corr[idx], corr[idx + 1]
        denom = (a - 2 * b + c)
        d = 0.5 * (a - c) / denom if abs(denom) > 1e-20 else 0.0
    else:
        d = 0.0
    return math.exp((lag + d) * _DLOG)


def autocorr_f0(seg, sr, fmin=40.0, fmax=2000.0):
    """Robust fundamental via autocorrelation (period of max correlation)."""
    x = seg - np.mean(seg)
    if np.max(np.abs(x)) < 1e-20:
        return 0.0
    x = x * np.hanning(len(x))
    corr = np.correlate(x, x, mode='full')[len(x) - 1:]
    if corr[0] <= 0:
        return 0.0
    corr = corr / corr[0]
    lag_min = int(sr / fmax)
    lag_max = min(int(sr / fmin), len(corr) - 2)
    if lag_max <= lag_min + 1:
        return 0.0
    region = corr[lag_min:lag_max]
    lag = lag_min + int(np.argmax(region))
    # parabolic interp around the lag
    if 1 <= lag < len(corr) - 1:
        a, b, c = corr[lag - 1], corr[lag], corr[lag + 1]
        denom = (a - 2 * b + c)
        d = 0.5 * (a - c) / denom if abs(denom) > 1e-20 else 0.0
    else:
        d = 0.0
    return sr / (lag + d)


def strongest_peak_hz(seg, sr):
    win = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * win))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    lo = np.searchsorted(freqs, 30.0)
    k = lo + int(np.argmax(spec[lo:]))
    return freqs[k]


def top_peaks(seg, sr, fmax=1600.0, n=10):
    """Return the n strongest local-maxima peaks below fmax as (hz, mag)."""
    win = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * win))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    hi = np.searchsorted(freqs, fmax)
    lo = np.searchsorted(freqs, 20.0)
    s = spec[lo:hi]
    f = freqs[lo:hi]
    # local maxima
    peaks = []
    for i in range(1, len(s) - 1):
        if s[i] > s[i - 1] and s[i] >= s[i + 1]:
            peaks.append((f[i], s[i]))
    peaks.sort(key=lambda t: -t[1])
    return peaks[:n]


def dump_peaks(p, pitch, label):
    import pianoidCuda
    # reuse render to get the raw segment
    cyc_note = max(1, int(RENDER_MS / 1000.0 * SAMPLE_RATE / SAMPLES_PER_CYCLE))
    total_ms = RENDER_MS + TAIL_MS
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel = 0; on.cycle_index = 0
    on.type = pianoidCuda.EventType.NOTE_ON; on.data = (pitch << 8) | VELOCITY
    eq.addEvent(on)
    off = pianoidCuda.PlaybackEvent(); off.channel = 0; off.cycle_index = cyc_note
    off.type = pianoidCuda.EventType.NOTE_OFF; off.data = (pitch << 8) | 0
    eq.addEvent(off); eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False; cfg.record_to_buffer = True
    cfg.max_duration_ms = total_ms + 200
    cfg.sample_rate = SAMPLE_RATE; cfg.samples_per_cycle = SAMPLES_PER_CYCLE
    with p.cuda_lock:
        p.pianoid.waitForParameterUpdate(); p.pianoid.resetStringsState()
        p.pianoid.runSynthesisKernel(); p.pianoid.clearRecords()
        p.pianoid.runOfflinePlayback(eq, cfg)
        raw = p.pianoid.getRecordedAudio()
    sound = np.array(raw, dtype=np.float64)
    skip = int(SKIP_MS / 1000.0 * SAMPLE_RATE)
    end = int(RENDER_MS / 1000.0 * SAMPLE_RATE)
    seg = sound[skip:end]
    pk = top_peaks(seg, SAMPLE_RATE)
    print(f"  [peaks {label}] " + ", ".join(f"{hz:.1f}Hz" for hz, _ in pk))


def main():
    os.chdir(MIDDLEWARE_DIR)
    from pianoid import initialize

    preset = sys.argv[1] if len(sys.argv) > 1 else "Preset_test5.json"
    pitch = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    preset_path = os.path.join(MIDDLEWARE_DIR, "presets", preset)

    print(f"=== dev-strregr tension sweep — preset={preset} pitch={pitch} ===")
    p = initialize(
        preset_path,
        filterlen=48 * 128 * 3,
        string_iteration=4,
        array_size=384,
        sample_rate=SAMPLE_RATE,
        samples_in_cycle=SAMPLES_PER_CYCLE,
        buffer_size=4,
        max_volume=5e18,
        audio_on=False,
        audio_driver_type=0,
    )

    pobj = p.sm.pitches[pitch]
    base_tension = float(pobj.physics.tension)
    print(f"expected note freq (ET) = {midi_to_freq(pitch):.2f} Hz")
    print(f"base tension (pitch {pitch}) = {base_tension:.6g}")
    print(f"KEY METRIC: spec_scale = whole-spectrum freq scaling vs baseline; f0_ac = "
          f"autocorrelation fundamental. Physics: both track sqrt(T/T_base).")
    print(f"{'label':<20}{'tension':>12}{'spec_scale':>11}{'f0_ac_Hz':>10}"
          f"{'f0/base':>9}{'sqrtT':>9}{'rms':>13}{'cfl':>6}")

    base_holder = {}

    def line(label, tension):
        f0, f0pk, rms, peak, n, ls = render_fundamental(p, pitch)
        cfl = getattr(p, 'cfl_redline', False)
        if 'ls' not in base_holder:
            base_holder['ls'] = ls
            base_holder['T'] = tension
            base_holder['f0'] = f0
        s = spectral_scale_factor(base_holder['ls'], ls)
        sqrtr = math.sqrt(tension / base_holder['T']) if base_holder['T'] else 0.0
        f0r = f0 / base_holder['f0'] if base_holder['f0'] else 0.0
        print(f"{label:<20}{tension:>12.5g}{s:>11.4f}{f0:>10.2f}"
              f"{f0r:>9.4f}{sqrtr:>9.4f}{rms:>13.5g}{str(cfl):>6}")
        return s

    f0_base = line("baseline", base_tension)

    # Tension DOWN sweep — physics: lower tension -> lower fundamental
    down_factors = [0.9, 0.75, 0.6, 0.5, 0.4]
    for fct in down_factors:
        t = base_tension * fct
        p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
        line(f"down x{fct}", t)

    # restore, then UP sweep — physics: higher tension -> higher fundamental
    p.update_parameter("string", {str(pitch): {"tension": base_tension}}, pitches=[pitch])
    line("restore-base", base_tension)
    up_factors = [1.1, 1.25, 1.5]
    for fct in up_factors:
        t = base_tension * fct
        p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
        line(f"up x{fct}", t)

    # Repeat-apply test: apply the SAME down value twice to expose
    # "no effect first time, then changes" double-buffer read-modify-write.
    print("--- repeat-apply (same value twice) to expose deferred apply ---")
    t = base_tension * 0.5
    p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
    line("half #1", t)
    p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
    line("half #2", t)
    p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
    line("half #3", t)

    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
