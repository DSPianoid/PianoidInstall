import gzip, json, sys, collections
tr = json.load(gzip.open(sys.argv[1])); ev = tr['traceEvents'] if isinstance(tr, dict) else tr
lo, hi = float(sys.argv[2]) * 1000, float(sys.argv[3]) * 1000
t0 = [e for e in ev if e.get('name') == 'lat-action'][0]['ts']
nodes = {}; parent = {}; samples = []; deltas = []; start = None
for e in ev:
    if e.get('name') == 'ProfileChunk':
        d = e['args']['data']; cp = d.get('cpuProfile', {})
        for n in cp.get('nodes', []):
            nodes[n['id']] = n['callFrame']
            if 'parent' in n: parent[n['id']] = n['parent']
        samples += cp.get('samples', []); deltas += d.get('timeDeltas', [])
    if e.get('name') == 'Profile': start = e['args']['data'].get('startTime')
incl = collections.Counter(); t = start; tot = 0
for s, dt in zip(samples, deltas):
    t += dt
    if lo <= t - t0 <= hi:
        tot += dt; seen = set(); n = s
        while n is not None:
            cf = nodes.get(n, {}); k = (cf.get('functionName') or '(anon)') + ' @' + cf.get('url', '').split('/')[-1] + ':' + str(cf.get('lineNumber'))
            if k not in seen: incl[k] += dt; seen.add(k)
            n = parent.get(n)
print('window', lo/1000, hi/1000, 'ms total sampled', tot/1000)
for k, v in incl.most_common(int(sys.argv[4]) if len(sys.argv) > 4 else 60):
    print(f"{v/1000:7.1f}  {k}")
