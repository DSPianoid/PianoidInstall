import os, sys, json, numpy as np
core=sys.argv[1] if len(sys.argv) > 1 else 'D:/repos/PianoidInstall/PianoidCore'; mw=os.path.join(core,'pianoid_middleware'); os.chdir(mw); sys.path.insert(0, mw)
import chartFunctions
from pianoid import initialize
p = initialize('D:/repos/PianoidInstall/PianoidCore/pianoid_middleware/presets/Tuning18-10-26ver1_work_assistant_3.json', 48*128*3,
    string_iteration=8, array_size=512, sample_rate=48000, samples_in_cycle=64, buffer_size=4, audio_on=False,
    audio_driver_type=0, listen_to_modes=False, sound_derivative_order=2, volume=100)
def render(pitch=67):
    chartFunctions.play_note_offline_chart_function(p, pitch=pitch, velocity=100, duration_ms=3000)
    return np.array(p.result.sound, dtype=np.float64)
def corr(a,b): return float(np.corrcoef(a[0], b[0])[0,1])
def rel(a,b): return float(np.linalg.norm(a[0]-b[0])/np.linalg.norm(a[0]))
base=float(p.pack_for_interface('string', pitches=[67])[0][67]['dispersion_damping'])
upd=lambda m: p.update_parameter('string', {'67': {'dispersion_damping': base*m}}, pitches=[67])
upd(1); A=render()
upd(100); B=render(); C=render()
upd(1); D=render(); E=render()
out={'A_vs_B_rel':rel(A,B),'B_vs_C_rel':rel(B,C),'A_vs_C_rel':rel(A,C),'C_vs_D_rel':rel(C,D),'D_vs_E_rel':rel(D,E),'A_vs_E_rel':rel(A,E)}
print('RESULT', json.dumps(out)); sys.exit(0)
# 3000 Hz line: ch0 and ch1, note and silent tail
def prom(x, f, a, b):
    seg=x[int(a*48000):int(b*48000)]; seg=seg*np.hanning(seg.size); S=np.abs(np.fft.rfft(seg)); F=np.fft.rfftfreq(seg.size,1/48000)
    near=np.abs(F-f)<=2; ring=(np.abs(F-f)>10)&(np.abs(F-f)<=60); k=np.flatnonzero(near)[np.argmax(S[near])]
    return round(float(20*np.log10(S[near].max()/np.median(S[ring]))),1), round(float(F[k]),2)
for ch in (0,1):
    out[f'ch{ch}_3000Hz_0.5-2.5s']=prom(C[ch],3000,0.5,2.5)
    out[f'ch{ch}_750Hz_0.5-2.5s']=prom(C[ch],750,0.5,2.5)
P48=render(48)
out['p48_ch0_3000Hz']=prom(P48[0],3000,0.5,2.5); out['p48_ch0_750Hz']=prom(P48[0],750,0.5,2.5)
print('RESULT', json.dumps(out))
