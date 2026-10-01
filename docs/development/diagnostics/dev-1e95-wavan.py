"""dev-1e95: envelope (dB per 50 ms) + dominant frequency in windows of a rendered WAV."""
import sys, wave, numpy as np
def load(p):
    with wave.open(p) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)/32767; sr = w.getframerate()
    return x, sr
for p in sys.argv[1:]:
    x, sr = load(p); n = int(0.05*sr)
    env = [20*np.log10(np.sqrt(np.mean(x[i:i+n]**2))+1e-12) for i in range(0, len(x)-n, n)]
    # dominant frequency in 3 windows: 0.1-0.2 s, 0.4-0.5 s, last 0.1 s before the max
    imax = int(np.argmax(np.abs(x)))
    out = []
    for a, b in ((0.1, 0.2), (0.3, 0.4), (max(imax/sr-0.1, 0), max(imax/sr, 0.1))):
        seg = x[int(a*sr):int(b*sr)]
        if len(seg) < 64: continue
        seg = seg*np.hanning(len(seg)); sp = np.abs(np.fft.rfft(seg)); fr = np.fft.rfftfreq(len(seg), 1/sr)
        top = np.argsort(sp)[-3:][::-1]
        out.append(f"[{a:.2f}-{b:.2f}s] " + ", ".join(f"{fr[t]:.0f}Hz({20*np.log10(sp[t]/sp.max()+1e-12):+.0f}dB)" for t in top))
    print(p.split("/")[-2], "env:", " ".join(f"{e:.0f}" for e in env[::2]), "| peak at %.2fs |" % (imax/sr), " ".join(out))
