import sys, collections, re
tot = 0; incl = collections.Counter(); selfc = collections.Counter()
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    line = line.rstrip()
    if not line: continue
    stack, n = line.rsplit(' ', 1); n = int(n)
    if sys.argv[2] not in stack: continue
    frames = stack.split(';'); tot += n
    seen = set()
    for f in frames:
        k = re.sub(r'\s*\(.*?([^\/]+\.py):(\d+)\)', r' (\1:\2)', f)
        if k not in seen: incl[k] += n; seen.add(k)
    selfc[re.sub(r'\s*\(.*?([^\/]+\.py):(\d+)\)', r' (\1:\2)', frames[-1])] += n
print('samples', tot)
for k, v in incl.most_common(int(sys.argv[3]) if len(sys.argv) > 3 else 45):
    print(f"{100*v/tot:5.1f}%  {k}")
print('-- self')
for k, v in selfc.most_common(15):
    print(f"{100*v/tot:5.1f}%  {k}")
