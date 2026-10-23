"""Classify UI-driven excitation strikes (old / new / mixed) against page-driven references."""
import json, os, shutil, sys
import numpy as np, soundfile as sf
import latlib as L

def wav_of(r, tag):
    w = r['wav']
    dst = os.path.join(L.DATA_DIR, f'ui_{tag}.wav')
    if os.path.exists(w): shutil.move(w, dst)
    r['wav'] = dst if os.path.exists(dst) else w
    return sf.read(r['wav'], dtype='float32')[0]

def strike_info(r, x):
    s = [e for e in r['ev'] if e['kind'] == 'strike'][0]
    rel = (s['t_send'] - r['t_cap_req']) / 1000.0
    i = L.onset(x, max(0, int((rel - 0.05) * L.FS)), noise_win=1200)
    return s['t_send'] / 1000.0, i

def compare(xa, ia, xb, ib, n=9600):
    sh = L.align(xa, xb, ia, ib, n=2400, search=128)
    a = xa[ib - sh: ib - sh + n].astype(np.float64); b = xb[ib: ib + n].astype(np.float64)
    m = min(len(a), len(b)); d = b[:m] - a[:m]
    return float(np.sqrt(np.mean(d ** 2)) / (np.sqrt(np.mean(b[:m] ** 2)) + 1e-12))

refs = json.load(open(sys.argv[1]))
ro = refs['refOld'][0]; rn = refs['refNew'][0]
xo = wav_of(ro, 'exc_refold'); xn = wav_of(rn, 'exc_refnew')
io = strike_info(ro, xo)[1]; inn = strike_info(rn, xn)[1]
print('separation', round(compare(xo, io, xn, inn), 4))
rows = []
for p in sys.argv[2:]:
    for k, r in enumerate(json.load(open(p))):
        x = wav_of(r, f"{os.path.basename(p)[:-5]}_{k}")
        ts, i = strike_info(r, x)
        act = [e for e in r['ev'] if e['kind'] == 'numinput'][0]['t_action'] / 1000.0
        outs = [f['t'] / 1000.0 for f in r['frames'] if f['dir'] == 'out' and 'set_parameter' in f['d']]
        acks = [f['t'] / 1000.0 for f in r['frames'] if f['dir'] == 'in' and f['d'].startswith('43') and '"parameter":"excitation"' in f['d']]
        eo, en = compare(xo, io, x, i), compare(xn, inn, x, i)
        cls = 'old' if eo < 1e-3 else ('new' if en < 1e-3 else 'mixed')
        rows.append({'d_req': r['d'], 'strike_after_action_ms': (ts - act) * 1e3, 'strike_after_emit_ms': (ts - outs[0]) * 1e3 if outs else None,
                     'action_to_emit_ms': (outs[0] - act) * 1e3 if outs else None, 'emit_to_ack_seen_ms': (acks[0] - outs[0]) * 1e3 if (acks and outs) else None,
                     'class': cls, 'eo': eo, 'en': en, 'undo': r.get('undo_status'), 'after_undo': r.get('value_after_undo')})
rows.sort(key=lambda r: r['strike_after_action_ms'])
for r in rows:
    print({k: (round(v, 1) if isinstance(v, float) and k not in ('eo', 'en') else (round(v, 4) if isinstance(v, float) else v)) for k, v in r.items()})
L.save_json('ui_excitation_numinput.json', rows)
