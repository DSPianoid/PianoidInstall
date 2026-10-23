"""Long main-thread tasks + top self-time JS functions (from the CPU profile) in a Chrome trace."""
import gzip, json, sys, collections
tr = json.load(gzip.open(sys.argv[1]))
ev = tr['traceEvents'] if isinstance(tr, dict) else tr
# main renderer thread = thread with most RunTask time named CrRendererMain
names = {(e['pid'], e['tid']): e['args']['name'] for e in ev if e.get('name') == 'thread_name'}
main = [k for k, v in names.items() if v == 'CrRendererMain']
dur = collections.Counter()
for e in ev:
    if e.get('name') == 'RunTask' and e.get('ph') == 'X' and (e['pid'], e['tid']) in main:
        dur[(e['pid'], e['tid'])] += e.get('dur', 0)
mt = dur.most_common(1)[0][0]
tasks = sorted([e for e in ev if e.get('name') == 'RunTask' and e.get('ph') == 'X' and (e['pid'], e['tid']) == mt], key=lambda e: e['ts'])
mark = [e for e in ev if e.get('name') == 'lat-action']
t0 = mark[0]['ts'] if mark else tasks[0]['ts']
print('action mark', bool(mark))
long = [e for e in tasks if e.get('dur', 0) > 8000 and -200000 < e['ts'] - t0 < 2500000]
for e in long:
    # children summary: function calls / event dispatch inside
    kids = [c for c in ev if c.get('ph') == 'X' and (c['pid'], c['tid']) == mt and c['ts'] >= e['ts'] and c['ts'] + c.get('dur', 0) <= e['ts'] + e['dur'] and c.get('name') in ('FunctionCall', 'EventDispatch', 'TimerFire', 'v8.callFunction', 'UpdateLayoutTree', 'Layout', 'Paint', 'MajorGC', 'MinorGC', 'FireAnimationFrame')]
    agg = collections.Counter()
    for c in kids:
        d = c.get('args', {}).get('data', {})
        key = c['name'] + ':' + str(d.get('type') or d.get('functionName') or '')
        agg[key] += c.get('dur', 0)
    print(f"task +{(e['ts']-t0)/1000:8.1f} ms dur {e['dur']/1000:7.1f} ms ::", ', '.join(f"{k} {v/1000:.0f}" for k, v in agg.most_common(6)))
# CPU profile samples -> self time per function within [t0, t0+1.5s]
nodes = {}; samples = []; tdeltas = []; start = None
for e in ev:
    if e.get('name') == 'ProfileChunk':
        d = e['args']['data']; cp = d.get('cpuProfile', {})
        for n in cp.get('nodes', []):
            nodes[n['id']] = n['callFrame']
        samples += cp.get('samples', []); tdeltas += d.get('timeDeltas', [])
    if e.get('name') == 'Profile':
        start = e['args']['data'].get('startTime')
if start is not None and samples:
    t = start; self_t = collections.Counter()
    for s, dt in zip(samples, tdeltas):
        t += dt
        if 0 <= t - t0 <= 1500000:
            cf = nodes.get(s, {})
            self_t[(cf.get('functionName') or '(anon)') + ' @' + cf.get('url', '').split('/')[-1] + ':' + str(cf.get('lineNumber'))] += dt
    tot = sum(self_t.values())
    print('profile self time in [action, +1.5s]: total', tot / 1000, 'ms')
    for k, v in self_t.most_common(25):
        print(f"  {v/1000:7.1f} ms  {k}")
