import json,sys
d=json.load(open(sys.argv[1]));t0=d['t_cap_req']
for e in d['ev']:
    print('EV', {k:(round(v-t0,1) if isinstance(v,float) and v>1e12 else v) for k,v in e.items() if k!='t_keys'})
for f in sorted(d['frames'], key=lambda f:f['t']):
    if f['dir']=='xhr' and not f['d'] and '/health' in f['url']: continue
    print(round(f['t']-t0,1), (round(f['t_done']-t0,1) if f.get('t_done') else ''), f['dir'], f['url'][-40:] if f['dir'] in('xhr','fetch') else '', f['d'][:140])
