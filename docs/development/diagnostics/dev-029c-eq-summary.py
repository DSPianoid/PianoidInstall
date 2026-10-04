import json,sys,glob,os,numpy as np
S=sys.argv[1]
for f in sorted(glob.glob(S+'/eq/*_eq.json')):
    d=json.load(open(f)); ma=d['masses_after']; keys=sorted(ma,key=int)
    m=np.array([ma[k] for k in keys])*1e3
    mr=d.get('mass_rescale') or {}
    lo=[ma[k]*1e3 for k in keys if int(k)<=40]; hi=[ma[k]*1e3 for k in keys if int(k)>=84]
    print(os.path.basename(f), 'conv',d['converged'],'/',d['total'],'spread m_all before',d['spread_before']['m_all'],'after',d['spread_after']['m_all'])
    print('   masses g min/med/max %.2f/%.2f/%.2f  range %.1f dB  bass(<=p40) med %.2f  treble(>=p84) med %.2f  bass-heavy=%s'%(m.min(),np.median(m),m.max(),20*np.log10(m.max()/m.min()),np.median(lo),np.median(hi),np.median(lo)>np.median(hi)))
    print('   rescale', {k:mr.get(k) for k in list(mr)[:6]} if isinstance(mr,dict) else mr)
    f0src={'bp1':'bp1_base.json','f15':'f15_base.json'}[os.path.basename(f)[:3]]
    f0={k:v['factors']['f0_ideal'] for k,v in json.load(open('D:/repos/PianoidInstall/docs/development/diagnostics/analyse-loudphys-renders/'+f0src))['pitches'].items()}
    ml=np.array([ma[k]*1e3 for k in keys if (f0.get(k) or 0)<2000])
    print('   f0<2kHz (%d): min/med/max %.2f/%.2f/%.2f g range %.1f dB'%(len(ml),ml.min(),np.median(ml),ml.max(),20*np.log10(ml.max()/ml.min())))
