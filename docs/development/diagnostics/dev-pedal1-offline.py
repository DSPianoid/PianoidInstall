"""dev-pedal1 half-pedal measurements, offline (runOfflinePlayback, no audio driver, no realtime thread).

Usage (cwd = <core>/pianoid_middleware, venv python; one process = one engine = one preset):
  python dev-pedal1-offline.py --preset presets/X.json --out D:/tmp/pedal1/before --tests t4,sweep
Tests: t4 (0/127 renders + coefficients saved as .npy for before/after), sweep, grid, stage, deadzone, held, patch,
       node, moving (renders with the pedal moving, wall time + click measure).
"""
import argparse
import json
import os
import sys
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--preset', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--tests', default='t4')
ap.add_argument('--sweep-pitches', default='36,60,84')
args = ap.parse_args()
sys.path.insert(0, os.getcwd())
os.makedirs(args.out, exist_ok=True)

import pianoidCuda  # noqa: E402
from pianoidCuda import EventType  # noqa: E402
from pianoid import initialize  # noqa: E402
from PanoidResult import PianoidResult  # noqa: E402

preset = json.load(open(args.preset, encoding='utf-8'))
mp = preset['model_parameters']
ITER = int(mp.get('string_iteration', 4))
ARRAY = int(mp.get('array_size', 384))
SR = 48000
SPC = int(mp.get('mode_iteration', 64))
print('load', ITER, ARRAY, SPC, flush=True)
p = initialize(args.preset, filterlen=48 * 128 * 3, string_iteration=ITER, array_size=ARRAY, sample_rate=SR,
               samples_in_cycle=SPC, buffer_size=4, max_volume=5e18, audio_on=False, audio_driver_type=0)
cpp = p.pianoid
CYC = SPC / SR
print('curve API', hasattr(cpp, 'setDamperCurve'), flush=True)


def ev(kind, cycle, data):
    e = pianoidCuda.PlaybackEvent()
    e.type, e.channel, e.cycle_index, e.data = kind, 0, int(cycle), int(data)
    return e


def sus(v, t):
    return ev(EventType.SUSTAIN, t / CYC, v)


def on(pitch, t, vel=90):
    return ev(EventType.NOTE_ON, t / CYC, (pitch << 8) | vel)


def off(pitch, t):
    return ev(EventType.NOTE_OFF, t / CYC, pitch << 8)


def render(events, ms):
    cpp.resetStringsState()
    cpp.clearRecords()
    eq = pianoidCuda.EventQueue()
    for e in events:
        eq.addEvent(e)
    eq.sortByCycle()
    cfg = pianoidCuda.PlaybackConfig()
    cfg.audio_enabled = False
    cfg.record_to_buffer = True
    cfg.sample_rate = SR
    cfg.samples_per_cycle = SPC
    cfg.max_duration_ms = ms
    t0 = time.perf_counter()
    cpp.runOfflinePlayback(eq, cfg)
    wall = time.perf_counter() - t0
    r = PianoidResult(cpp, p.mp)
    r.load_offline_sound_from_pianoid()
    return np.asarray(r.sound, dtype=np.float64), wall


def env_db(x, win_ms=20):
    """RMS envelope over all channels, dB re its own peak; (times s, dB)."""
    n = int(SR * win_ms / 1000)
    e = np.sum(x ** 2, axis=0)
    k = len(e) // n
    r = np.sqrt(e[:k * n].reshape(k, n).mean(axis=1))
    return (np.arange(k) + 0.5) * n / SR, 20 * np.log10(r / r.max() + 1e-12)


def level(t, d, at):
    return float(d[np.argmin(abs(t - at))])


def slope(t, d, a, b):
    """Decay in dB/s fitted over [a, b] s; only points above -100 dB."""
    m = (t >= a) & (t <= b) & (d > -100)
    return float(-np.polyfit(t[m], d[m], 1)[0]) if m.sum() > 3 else None


def note_with_pedal(pitch, v, ms=2600, rel=0.3):
    x, wall = render([sus(v, CYC), on(pitch, 0.02), off(pitch, rel)], ms)
    t, d = env_db(x)
    return x, wall, {'v': v, 'L0.5': level(t, d, 0.5), 'L1.0': level(t, d, 1.0), 'L1.5': level(t, d, 1.5),
                     'L2.5': level(t, d, 2.5), 'dB_s_0.35_1.0': slope(t, d, 0.35, 1.0),
                     'dB_s_1.0_2.5': slope(t, d, 1.0, 2.5)}


REPORT = {'preset': args.preset, 'iter': ITER, 'array': ARRAY}
tests = args.tests.split(',')
VALUES = [0, 6, 16, 32, 48, 64, 80, 96, 110, 118, 127]


def save():
    json.dump(REPORT, open(os.path.join(args.out, 'report.json'), 'w'), indent=1)


def coeffs():
    return np.asarray(cpp.returnParameters(), dtype=np.float64)


if 't4' in tests:
    seqs = {
        'up_p60': ([sus(0, CYC), on(60, 0.02), off(60, 0.3)], 1500),
        'down_p60': ([sus(127, CYC), on(60, 0.02), off(60, 0.3)], 1500),
        'up_p36': ([sus(0, CYC), on(36, 0.02), off(36, 0.3)], 1500),
        'down_p84': ([sus(127, CYC), on(84, 0.02), off(84, 0.3)], 1500),
        'switch': ([sus(0, CYC), on(48, 0.02), sus(127, 0.1), off(48, 0.3), on(55, 0.4), off(55, 0.6),
                    sus(0, 0.9)], 1500),
    }
    REPORT['t4'] = {}
    for rep in range(2):        # two passes: the second pass is the run-to-run noise of the same state
        for name, (events, ms) in seqs.items():
            x, wall = render(events, ms)
            np.save(os.path.join(args.out, f't4_{name}_{rep}.npy'), x.astype(np.float32))
            REPORT['t4'][f'{name}_{rep}'] = {'wall': wall, 'peak': float(abs(x).max())}
            print(name, rep, round(wall, 2), flush=True)
            if rep == 0:
                np.save(os.path.join(args.out, f't4_coeff_{name}.npy'), coeffs().astype(np.float32))
    save()

if 'sweep' in tests:
    REPORT['sweep'] = {}
    for pitch in [int(q) for q in args.sweep_pitches.split(',')]:
        rows = []
        for v in VALUES:
            _x, wall, row = note_with_pedal(pitch, v)
            rows.append(row)
            print(pitch, row, round(wall, 1), flush=True)
        REPORT['sweep'][pitch] = rows
        save()

if 'grid' in tests:             # test 2: the pedal value of the geometric-mean decay, per pitch
    REPORT['grid'] = {}
    for pitch in [p_ for p_ in range(24, 100, 6) if p_ in p.sm.pitches]:
        rows = []
        for v in [0, 20, 40, 60, 80, 100, 127]:
            _x, _w, row = note_with_pedal(pitch, v, ms=1600)
            rows.append(row)
        REPORT['grid'][pitch] = rows
        print(pitch, [round(r['dB_s_0.35_1.0'] or 0, 1) for r in rows], flush=True)
        save()

if 'stage' in tests:            # test 3
    import pedal_config
    REPORT['stage'] = {}
    for spread in (24, 0):
        pedal_config.write(p, {'register_spread': spread})
        for v in (60, 80, 100):
            REPORT['stage'][f'{spread}_{v}'] = {q: note_with_pedal(q, v, ms=1600)[2]['dB_s_0.35_1.0'] for q in (36, 60, 84)}
            print(spread, v, REPORT['stage'][f'{spread}_{v}'], flush=True)
    pedal_config.write(p, None)
    save()

if 'deadzone' in tests:         # test 5
    res = {}
    for pair in ((0, 3), (0, 5), (127, 120), (127, 124)):
        a, _ = render([sus(pair[0], CYC), on(60, 0.02), off(60, 0.3)], 1000)
        b, _ = render([sus(pair[1], CYC), on(60, 0.02), off(60, 0.3)], 1000)
        res[str(pair)] = float(np.sum((a - b) ** 2) / np.sum(a ** 2))
    print(res, flush=True)
    REPORT['deadzone'] = res
    save()

if 'held' in tests:             # test 6: string of the held key, slot 8 (dec2)
    slots = list(cpp.getStringIndicesForPitch(60))
    res = {}
    PPN, AS = 32, ARRAY
    for v in (0, 64, 127):
        render([sus(v, CYC), on(60, 0.02)], 200)
        c = coeffs()
        n = len(c) // (PPN * AS)
        dec2 = c[8 * AS:9 * AS]     # first block; located by slot 11 = stringNo over all blocks below
        found = {}
        for b in range(n):
            base = b * PPN * AS
            sn = c[base + 11 * AS: base + 12 * AS]
            d2 = c[base + 8 * AS: base + 9 * AS]
            main = c[base + 18 * AS: base + 19 * AS] > 0
            for s in slots:
                m = (sn == s) & main
                if m.any():
                    found[int(s)] = [float(d2[m].min()), float(d2[m].max())]
        res[v] = found
    print(res, flush=True)
    REPORT['held'] = {str(k): v for k, v in res.items()}
    save()

if 'patch' in tests:            # test 7: dec2 along a released string at v
    import pedal_config
    PPN, AS = 32, ARRAY
    render([sus(60, CYC), on(60, 0.02), off(60, 0.1)], 300)
    c = coeffs()
    slot = int(list(cpp.getStringIndicesForPitch(60))[0])
    out = None
    for b in range(len(c) // (PPN * AS)):
        base = b * PPN * AS
        sn = c[base + 11 * AS: base + 12 * AS]
        main = c[base + 18 * AS: base + 19 * AS] > 0
        m = (sn == slot) & main
        if m.any():
            out = {'index': c[base + 20 * AS: base + 21 * AS][m].tolist(), 'dec2': c[base + 8 * AS: base + 9 * AS][m].tolist(),
                   'hammer_center': c[base + 20 * AS: base + 21 * AS][(c[base + 10 * AS: base + 11 * AS] > 0) & (sn == slot)].tolist()}
    print(out, flush=True)
    REPORT['patch'] = out
    save()

if 'node' in tests:             # test 7b: partials with / without a node at the damper
    import pedal_config
    res = {}
    pitch = 60
    for label, cfg in (('patch', {}), ('whole', {'patch_width': 0.0}), ('node3', {'patch_offset': None})):
        if label == 'node3':
            hp = 1 / 3 - float(p.sm.pitches[pitch].pack_params_for_strings()[list(p.sm.pitches[pitch].stringIDs)[0]]['hammer_position'])
            cfg = {'patch_offset': round(hp, 4)}
        pedal_config.write(p, cfg)
        x, _ = render([sus(70, CYC), on(pitch, 0.02), off(pitch, 0.3)], 1600)
        mono = x.sum(axis=0)
        f0 = 440 * 2 ** ((pitch - 69) / 12)
        out = {}
        for k in (1, 2, 3, 4, 6):
            levels = []
            for t0, t1 in ((0.35, 0.65), (1.0, 1.3)):
                seg = mono[int(t0 * SR):int(t1 * SR)] * np.hanning(int(t1 * SR) - int(t0 * SR))
                sp = abs(np.fft.rfft(seg))
                f = np.fft.rfftfreq(len(seg), 1 / SR)
                m = abs(f - k * f0) < 12
                levels.append(20 * np.log10(sp[m].max() + 1e-30))
            out[k] = (levels[0] - levels[1]) / 0.65
        res[label] = out
        print(label, out, flush=True)
    pedal_config.write(p, None)
    REPORT['node'] = res
    save()

if 'moving' in tests:           # tests 8 + 9: 100 Hz CC under 10 sounding notes, offline wall time vs a still pedal
    notes = [36, 43, 48, 55, 60, 64, 67, 72, 76, 84]
    base = [on(q, 0.02) for q in notes]
    dur = 6000
    res = {}
    still, wall = render([sus(64, CYC)] + base, dur)
    res['still_wall'] = wall
    wave = [sus(int(63.5 + 63.5 * np.sin(2 * np.pi * 0.5 * k / 100)), 0.1 + k / 100) for k in range(590)]
    mv, wall = render([sus(64, CYC)] + base + wave, dur)
    res['moving_wall'] = wall
    fast = [sus(127 if (k // 8) % 2 else 0, 0.1 + k / 100) for k in range(590)]     # both ends at 12.5 Hz
    sw, wall = render([sus(0, CYC)] + base + fast, dur)
    res['switch_wall'] = wall

    def hf(x):
        """Energy above 8 kHz in 2 ms blocks: peak over median, dB (a click stands out)."""
        s = np.fft.rfft(x.sum(axis=0))
        f = np.fft.rfftfreq(x.shape[1], 1 / SR)
        s[f < 8000] = 0
        y = np.fft.irfft(s, x.shape[1])
        n = int(SR * 0.002)
        e = (y[:len(y) // n * n].reshape(-1, n) ** 2).mean(axis=1)[300:]
        return float(10 * np.log10(e.max() / (np.median(e) + 1e-300) + 1e-30))

    res['hf_crest_still'], res['hf_crest_moving'], res['hf_crest_switching'] = hf(still), hf(mv), hf(sw)
    print(res, flush=True)
    REPORT['moving'] = res
    save()
if 'moving2' in tests:          # tests 8 + 9 refined: N=3 wall per kernel; clicks against the local HF level
    notes = [36, 43, 48, 55, 60, 64, 67, 72, 76, 84]
    base = [on(q, 0.02) for q in notes]
    dur = 4000
    res = {}

    def local_crest(x):
        """2 ms block HF (> 8 kHz) energy over the median of the +-100 ms around it, max dB, after 0.6 s."""
        s = np.fft.rfft(x.sum(axis=0))
        f = np.fft.rfftfreq(x.shape[1], 1 / SR)
        s[f < 8000] = 0
        y = np.fft.irfft(s, x.shape[1])
        n = int(SR * 0.002)
        e = (y[:len(y) // n * n].reshape(-1, n) ** 2).mean(axis=1)
        out = [e[i] / (np.median(e[i - 50:i + 50]) + 1e-300) for i in range(300, len(e) - 50)]
        return float(10 * np.log10(max(out))), float(10 * np.log10(np.percentile(out, 99)))

    ramp = [sus(int(63.5 + 63.5 * np.sin(2 * np.pi * 0.5 * k / 100)), 0.1 + k / 100) for k in range(390)]
    plans = {'still': [], 'cc100hz': ramp, 'cc25hz': ramp[::4], 'ends_12hz': [sus(127 if (k // 8) % 2 else 0, 0.1 + k / 100) for k in range(390)],
             'dup100hz': [sus(64, 0.1 + k / 100) for k in range(390)]}
    for rep in range(3):
        for name, extra in plans.items():
            x, wall = render([sus(64, CYC)] + base + extra, dur)
            r_ = res.setdefault(name, {'wall': [], 'crest': None})
            r_['wall'].append(wall)
            if rep == 0:
                r_['crest'] = local_crest(x)
    print(res, flush=True)
    REPORT['moving2'] = res
    save()

print('DONE', flush=True)
save()
