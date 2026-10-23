"""Analyse page-driven UI trials: divergence of the In 8 capture vs a reference capture,
anchored on the page's raw WS 'play' frame (anchor.t_send, epoch ms)."""
import json, os, shutil, sys
import numpy as np, soundfile as sf
import latlib as L
L.SCHED_TO_IN8_S = 0.0203125

def load_trial(p):
    d = json.load(open(p))
    w = d['wav']
    dst = os.path.join(L.DATA_DIR, 'ui_' + os.path.basename(p).replace('.json', '') + '.wav')
    if os.path.exists(w):
        shutil.move(w, dst)
        d['wav'] = dst; json.dump(d, open(p, 'w'))
    x = sf.read(d['wav'], dtype='float32')[0]
    anchor = [e for e in d['ev'] if e['kind'] == 'anchor'][0]['t_send'] / 1000.0
    return d, {'x': x, 't_note_send': anchor}

def first_div(ref, t, t_from, thr_rel=0.01):
    xr, x = ref['x'], t['x']
    ir = L.onset(xr, int(0.25 * L.FS), noise_win=1200); it = L.onset(x, int(0.25 * L.FS), noise_win=1200)
    sh = L.align(xr, x, ir, it); n = len(x); r = np.zeros(n)
    lo, hi = max(0, sh), min(n, len(xr) + sh); r[lo:hi] = xr[lo - sh:hi - sh]
    d = x.astype(np.float64) - r
    i0 = it + int(round((t_from - t['t_note_send']) * L.FS))
    sig = float(np.sqrt(np.mean(x[i0 - 4800:i0].astype(np.float64) ** 2)))
    e = L.env_rms(d, 96)
    nz = np.nonzero(e[i0:] > sig * thr_rel)[0]
    if not nz.size: return None
    return L.epoch_of_index(t, i0 + int(nz[0]), it)

if __name__ == '__main__':
    ref_d, ref = load_trial(sys.argv[1])
    for p in sys.argv[2:]:
        d, t = load_trial(p)
        act = [e for e in d['ev'] if e['kind'] != 'anchor'][0]
        ta = (act.get('t_action') or act.get('t_down') or act.get('t_keys', [None])[0]) / 1000.0
        tu = (act.get('t_up') or act.get('t_action') or ta * 1000) / 1000.0
        outs = [f['t'] / 1000.0 for f in d['frames'] if f['dir'] == 'out' and ('set_' in f['d'])]
        div = first_div(ref, t, ta - 0.05)
        print(os.path.basename(p), {'action_to_first_emit_ms': round((outs[0] - ta) * 1e3, 1) if outs else None,
              'release_to_first_emit_ms': round((outs[0] - tu) * 1e3, 1) if outs else None,
              'n_emits': len(outs), 'action_to_audible_ms': round((div - ta) * 1e3, 1) if div else None,
              'release_to_audible_ms': round((div - tu) * 1e3, 1) if div else None,
              'first_emit_to_audible_ms': round((div - outs[0]) * 1e3, 1) if (div and outs) else None})
