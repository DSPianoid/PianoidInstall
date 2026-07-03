"""dev-strregr — CLEAN fundamental-vs-tension proof. The full-mix offline output
is dominated by a fixed 750 Hz cycle-rate artifact (48000/64) + soundboard/mode
resonances that do NOT scale with tension, burying the string partial. Here we
isolate the STRING response: notch the 750 Hz cycle harmonics, band-limit to the
sub-cycle band, and identify the strongest MOVING partial across a wide tension
sweep. Physics: the string partial should scale as sqrt(T)."""
import os, sys, math
import numpy as np

MW = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..",
                                  "PianoidCore", "pianoid_middleware"))
sys.path.insert(0, MW); os.chdir(MW)
from pianoid import initialize
import pianoidCuda

SR, SPC, VEL = 48000, 64, 100
CYCLE_HZ = SR / SPC   # 750 Hz
RENDER_MS, TAIL_MS, SKIP_MS = 1200, 150, 200


def render(p, pitch):
    cyc = max(1, int(RENDER_MS/1000*SR/SPC))
    eq = pianoidCuda.EventQueue()
    on = pianoidCuda.PlaybackEvent(); on.channel=0; on.cycle_index=0
    on.type = pianoidCuda.EventType.NOTE_ON; on.data=(pitch<<8)|VEL; eq.addEvent(on)
    off = pianoidCuda.PlaybackEvent(); off.channel=0; off.cycle_index=cyc
    off.type = pianoidCuda.EventType.NOTE_OFF; off.data=(pitch<<8)|0; eq.addEvent(off)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig(); cfg.audio_enabled=False; cfg.record_to_buffer=True
    cfg.max_duration_ms=RENDER_MS+TAIL_MS+200; cfg.sample_rate=SR; cfg.samples_per_cycle=SPC
    with p.cuda_lock:
        p.pianoid.waitForParameterUpdate(); p.pianoid.resetStringsState()
        p.pianoid.runSynthesisKernel(); p.pianoid.clearRecords()
        p.pianoid.runOfflinePlayback(eq, cfg)
        raw = p.pianoid.getRecordedAudio()
    s = np.array(raw, dtype=np.float64)
    return s[int(SKIP_MS/1000*SR):int(RENDER_MS/1000*SR)]


def spectrum(seg):
    win = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg*win))
    freqs = np.fft.rfftfreq(len(seg), 1.0/SR)
    # notch cycle-rate harmonics (750, 1500, ...) with +-8 Hz stop
    for h in range(1, 12):
        f0 = CYCLE_HZ*h
        spec[(freqs > f0-8) & (freqs < f0+8)] = 0.0
    spec[freqs < 40] = 0.0
    return freqs, spec


def strongest_in_band(freqs, spec, lo, hi):
    m = (freqs >= lo) & (freqs <= hi)
    if not np.any(m):
        return 0.0
    idx = np.where(m)[0]
    k = idx[int(np.argmax(spec[idx]))]
    if 1 <= k < len(spec)-1:
        a,b,c = spec[k-1],spec[k],spec[k+1]
        d = 0.5*(a-c)/(a-2*b+c) if abs(a-2*b+c)>1e-20 else 0.0
    else:
        d = 0.0
    return (k+d)*SR/ (2*(len(spec)-1))


def main():
    preset = sys.argv[1] if len(sys.argv) > 1 else "Preset_test5.json"
    pitch = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    p = initialize(os.path.join(MW,"presets",preset), filterlen=48*128*3,
        string_iteration=4, array_size=384, sample_rate=SR, samples_in_cycle=SPC,
        buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
    base_t = float(p.sm.pitches[pitch].physics.tension)
    print(f"=== clean fundamental proof: preset={preset} pitch={pitch} baseT={base_t:.5g} "
          f"cycle_artifact={CYCLE_HZ:.0f}Hz ===")

    # 1) Identify the strongest MOVING partial: compare baseline vs 2x tension,
    #    find the low-band bin with the largest change -> that's the string partial band.
    seg_b = render(p, pitch); fb, sb = spectrum(seg_b)
    p.update_parameter("string", {str(pitch): {"tension": base_t*2.0}}, pitches=[pitch])
    seg_h = render(p, pitch); fh, sh = spectrum(seg_h)
    p.update_parameter("string", {str(pitch): {"tension": base_t}}, pitches=[pitch])
    band = (fb >= 60) & (fb <= CYCLE_HZ-20)
    dif = np.zeros_like(sb); dif[band] = np.abs(sh[band]-sb[band])
    kc = int(np.argmax(dif)); fc = fb[kc]
    lo, hi = max(60, fc*0.45), min(CYCLE_HZ-20, fc*2.2)
    print(f"strongest moving partial near {fc:.1f}Hz -> tracking band [{lo:.0f},{hi:.0f}]Hz")

    print(f"{'tension':>12}{'partial_Hz':>12}{'f/base':>9}{'sqrtT':>9}{'err%':>8}")
    base_f = None
    for fct in [0.25, 0.4, 0.5, 0.7, 1.0, 1.4, 2.0, 3.0, 4.0]:
        t = base_t*fct
        p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
        f, s = spectrum(render(p, pitch))
        pf = strongest_in_band(f, s, lo, hi)
        if fct == 1.0 or base_f is None:
            base_f = pf if base_f is None else base_f
        if abs(fct-1.0) < 1e-9:
            base_f = pf
    # second pass now that base_f is set at fct=1.0
    p.update_parameter("string", {str(pitch): {"tension": base_t}}, pitches=[pitch])
    base_f = strongest_in_band(*spectrum(render(p, pitch)), lo, hi)
    for fct in [0.25, 0.4, 0.5, 0.7, 1.0, 1.4, 2.0, 3.0, 4.0]:
        t = base_t*fct
        p.update_parameter("string", {str(pitch): {"tension": t}}, pitches=[pitch])
        f, s = spectrum(render(p, pitch))
        pf = strongest_in_band(f, s, lo, hi)
        fr = pf/base_f if base_f else 0.0
        sq = math.sqrt(fct)
        err = (fr/sq-1)*100 if sq else 0
        print(f"{t:>12.5g}{pf:>12.2f}{fr:>9.4f}{sq:>9.4f}{err:>8.1f}")
    try: p.pianoid.shutdownGpu()
    except: pass


if __name__ == "__main__":
    main()
