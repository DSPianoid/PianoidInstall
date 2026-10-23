import glob, numpy as np, soundfile as sf, latlib as L
def load(p): return sf.read(p, dtype='float32')[0]
cases=sorted(set(p.split('exp03_')[1].rsplit('_ref',1)[0] for p in glob.glob(L.DATA_DIR+'/exp03_*_ref_*.wav')))
for c in cases:
    r1=sorted(glob.glob(f"{L.DATA_DIR}/exp03_{c}_ref_*.wav")); r2=sorted(glob.glob(f"{L.DATA_DIR}/exp03_{c}_ref2_*.wav"))
    if not r1 or not r2: continue
    a,b=load(r1[-1]),load(r2[-1])
    ia=L.onset(a,int(.25*L.FS),noise_win=1200); ib=L.onset(b,int(.25*L.FS),noise_win=1200)
    sh=L.align(a,b,ia,ib); n=len(b); r=np.zeros(n); lo,hi=max(0,sh),min(n,len(a)+sh); r[lo:hi]=a[lo-sh:hi-sh]
    d=b-r; e=L.env_rms(d,480); sig=float(np.sqrt(np.mean(b[ib:ib+48000]**2)))
    nz=np.nonzero(np.abs(d)>4/32768)[0]
    first=(nz[0]-ib)/L.FS if nz.size else None
    print(f"{c:36s} shift {sh:6d} relshift {(ib-ia)}  first_nz_after_note {first}  max_diff_rel_dB {20*np.log10(e.max()/sig+1e-12):6.1f}")
