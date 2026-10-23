import json, sys
d = json.load(open(sys.argv[1]))
for k, rs in d.items():
    for r in rs:
        outs = [f for f in r['frames'] if f['dir'] in ('out',) and ('set_' in f['d'] or 'command' in f['d'])]
        rest = [f for f in r['frames'] if f['dir'] in ('xhr', 'fetch') and f['d'] and 'set_' in f['url']]
        acks = [f for f in r['frames'] if f['dir'] == 'in' and f['d'].startswith('43') and '"ok"' in f['d']]
        sc = [f for f in r['frames'] if f['dir'] == 'in' and 'state_changed' in f['d']]
        lt = r['longtasks']; blk = sum(x['dur'] for x in lt if x['dt'] < 1500)
        print(k, 'emit', [o['dt'] for o in outs][:3], 'rest', [(o['dt'], o.get('done')) for o in rest][:3], 'ack_seen', [a['dt'] for a in acks][:2], 'state_changed', [s['dt'] for s in sc][:2],
              'longtasks', [(x['dt'], x['dur']) for x in lt][:6], 'blocked_ms', round(blk), 'undo', r.get('undo'), 'logs', r.get('console_log_frames'))
