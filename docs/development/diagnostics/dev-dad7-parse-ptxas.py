"""dev-dad7 — parse `-Xptxas -v` logs into a per-kernel x arch x variant resource table (markdown)."""
import re, sys, glob, os, subprocess
out = sys.argv[1]
rows = []
for path in sorted(glob.glob(os.path.join(out, "*.ptxas.txt"))):
    tu, variant = os.path.basename(path).replace(".ptxas.txt", "").rsplit("_", 1)
    cur = None
    for line in open(path, errors="replace"):
        m = re.search(r"Compiling entry function '(\S+)' for '(sm_\d+)'", line)
        if m: cur = {"tu": tu, "variant": variant, "mangled": m.group(1), "arch": m.group(2)}; continue
        m = re.search(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", line)
        if m and cur: cur.update(stack=int(m.group(1)), spill_st=int(m.group(2)), spill_ld=int(m.group(3))); continue
        m = re.search(r"Used (\d+) registers(?:, used \d+ barriers)?(?:, (\d+) bytes smem)?", line)
        if m and cur:
            cur.update(regs=int(m.group(1)), smem=int(m.group(2) or 0)); rows.append(cur); cur = None
names = subprocess.run(["cu++filt"] + [r["mangled"] for r in rows], capture_output=True, text=True).stdout.split("\n") \
    if rows else []
for r, n in zip(rows, names): r["name"] = n.split("(")[0] if n else r["mangled"]
print("| TU | kernel | variant | arch | regs/thr | static smem B | stack B | spill st/ld B |")
print("|---|---|---|---|---|---|---|---|")
for r in sorted(rows, key=lambda r: (r["tu"], r["name"], r["variant"], r["arch"])):
    print(f"| {r['tu']} | `{r['name']}` | {r['variant']} | {r['arch']} | **{r['regs']}** | {r['smem']} | {r.get('stack',0)} | {r.get('spill_st',0)}/{r.get('spill_ld',0)} |")
