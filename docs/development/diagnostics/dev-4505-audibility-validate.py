import json,base64,numpy as np,math
d=json.load(open(r'D:/repos/PianoidInstall/PianoidCore/pianoid_middleware/presets/F15_Elyashev_array512.json'))
sr=48000; dt=1/sr
modes=d['modes']
f=np.array([m['frequency'] for m in modes]); dec_=np.array([m['decrement'] for m in modes]); mi=np.array([m['mass'] for m in modes])
deck=np.frombuffer(base64.b64decode(d['pitches']['60']['deck']['data']),dtype=np.float64)
print('deck len',len(deck))
def energies(f,decr,mi,k):
    d_=dt*decr*f; w=(2*np.pi*f*dt)**2
    a=(1-d_)*(2-w); b=(1-d_)**2; g=(1-d_)*mi
    R0=g*g*(1+b)/((1-b)*((1+b)**2-a*a)); R1=a*R0/(1+b); R2=a*R1-b*R0
    if k==0: return R0
    if k==1: return 2*(R0-R1)
    if k==2: return 6*R0-8*R1+2*R2
meas={0:1.02e-7,1:8.1e-8,2:6.8e-8,20:4.1e-14,67:4.0e-16,127:5.1e-14}
for k in (0,1,2):
  E=energies(f,dec_,mi,k); A=np.sqrt(E)
  for note in (False,True):
    W=A*(np.abs(deck[:len(A)]) if note else 1)
    print('k',k,'note',note, ' '.join(f"m{m}:{20*np.log10(W[m]/W[0]):7.1f}/{20*np.log10(v/meas[0]):7.1f}" for m,v in meas.items()))
for m in meas: print(m, f[m], dec_[m], mi[m], deck[m] if m<len(deck) else None)
