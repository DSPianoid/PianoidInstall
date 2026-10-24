import json,sys
d=json.load(open(sys.argv[1]))
for k,v in d.items():
    f=v['lat_first']; m=v['lat_m40']; a=v['ack']
    firsts=[round(r['lat_first_ms'] or -1) for r in v['rows']]
    print(f"{k:42s} first {firsts}  m40med {m.get('median') or float('nan'):7.1f} ack med {a['median']:6.1f} max {a['max']:6.1f} restore {v['restore_check_first_diff_ms']}")
