"""dev-obuf1: offline-buffer layout + dispersion-damping re-test (audio_off, in-process, ONE Pianoid).

Measures what the two offline consumers hand downstream:
  * POST /play_keyboard mode=offline (Flask test client) -> the WAV in audio_data[0]
  * play_note_offline_chart_function (render.note_playback) -> pianoid.result.sound[0]
and, for each signal: duration vs the rendered seconds, the 7-block level periodicity, the
jump ratio at 64-sample block boundaries, the 750 Hz (= sr / 64) line prominence. Then the
report-06c895bc dispersion test: pitch 67, dispersion_damping x1 / x10 / x100, per-partial
decay (0.2 s Hann STFT, fit 0.3-3 s).

Run (Core worktree venv, cwd anywhere):
  <core>/.venv/Scripts/python.exe dev-obuf1-offline-buffer.py --core <core> --preset <preset.json> --out <out.json>
"""
import argparse
import base64
import io
import json
import os
import sys
import wave

import numpy as np

BLOCK = 64


def layout_metrics(x, sr, num_channels, expected_s):
    x = np.asarray(x, dtype=np.float64)
    n_blocks = x.size // BLOCK
    blocks = x[: n_blocks * BLOCK].reshape(n_blocks, BLOCK)
    rms_db = 20 * np.log10(np.sqrt(np.mean(blocks ** 2, axis=1)) + 1e-30)
    active = rms_db > rms_db.max() - 60          # ignore the silent tail
    d1 = np.abs(np.diff(rms_db))[active[1:]]
    d7 = np.abs(rms_db[7:] - rms_db[:-7])[active[7:]]
    dx = np.abs(np.diff(x))
    idx = np.arange(1, x.size)
    boundary = dx[(idx % BLOCK) == 0]
    interior = dx[(idx % BLOCK) != 0]
    # 750 Hz line prominence over 0.5-2.5 s (or what exists)
    a, b = int(0.5 * sr), min(x.size, int(2.5 * sr))
    seg = x[a:b] * np.hanning(b - a)
    spec = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(seg.size, 1.0 / sr)
    line = {}
    for k in (1, 2, 3, 4):
        f = sr / BLOCK * k
        near = np.abs(freqs - f) <= 2.0
        ring = (np.abs(freqs - f) > 10.0) & (np.abs(freqs - f) <= 60.0)
        line[f"{int(f)}Hz"] = round(float(20 * np.log10(spec[near].max() / (np.median(spec[ring]) + 1e-30))), 1)
    return {
        'samples': int(x.size), 'duration_s': round(x.size / sr, 3), 'expected_s': round(expected_s, 3),
        'duration_ratio': round(x.size / sr / expected_s, 3),
        'median_abs_dRMS_lag1_dB': round(float(np.median(d1)), 3),
        'median_abs_dRMS_lag7_dB': round(float(np.median(d7)), 3),
        'lag7_over_lag1': round(float(np.median(d7) / (np.median(d1) + 1e-12)), 2),
        'boundary_jump_ratio': round(float(boundary.mean() / (interior.mean() + 1e-30)), 2),
        'line_prominence_dB': line,
        'num_channels_engine': int(num_channels),
    }


def partial_decays(x, sr, f0_nominal, n_partials=12, t_fit=(0.3, 3.0)):
    x = np.asarray(x, dtype=np.float64)
    win = int(0.2 * sr)
    hop = int(0.05 * sr)
    w = np.hanning(win)
    starts = np.arange(0, x.size - win, hop)
    frames = np.stack([x[s:s + win] * w for s in starts])
    S = np.abs(np.fft.rfft(frames, n=win * 4, axis=1))
    freqs = np.fft.rfftfreq(win * 4, 1.0 / sr)
    t = (starts + win / 2) / sr
    early = S[(t > 0.05) & (t < 0.5)].mean(axis=0)
    def peak(fc, rel):
        m = (freqs > fc * (1 - rel)) & (freqs < fc * (1 + rel))
        return int(np.flatnonzero(m)[np.argmax(early[m])])
    k0 = peak(f0_nominal, 0.06)
    f0 = freqs[k0]
    out = []
    fit = (t >= t_fit[0]) & (t <= t_fit[1])
    prev_f = 0.0
    for n in range(1, n_partials + 1):
        k = peak(max(n * f0, prev_f + 0.5 * f0), 0.04)
        prev_f = freqs[k]
        band = slice(max(k - 2, 0), k + 3)
        mag_db = 20 * np.log10(S[:, band].max(axis=1) + 1e-30)
        slope = float(np.polyfit(t[fit], mag_db[fit], 1)[0])
        out.append({'n': n, 'hz': round(float(freqs[k]), 1), 'dB_per_s': round(slope, 2),
                    'level_dB_at_0.3s': round(float(mag_db[np.argmin(np.abs(t - 0.3))]), 1)})
    return {'f0_hz': round(float(f0), 2), 'partials': out}


def wav_from_b64(b64):
    with wave.open(io.BytesIO(base64.b64decode(b64)), 'rb') as wf:
        nch, sr, n = wf.getnchannels(), wf.getframerate(), wf.getnframes()
        data = np.frombuffer(wf.readframes(n), dtype=np.int16).astype(np.float64)
    return data.reshape(-1, nch)[:, 0], sr, nch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--core', required=True)
    ap.add_argument('--preset', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--pitch', type=int, default=67)
    args = ap.parse_args()

    mw = os.path.join(args.core, 'pianoid_middleware')
    os.chdir(mw)
    sys.path.insert(0, mw)
    import backendServer                       # the Flask app; NOT run (no port)
    import chartFunctions
    from pianoid import initialize

    p = initialize(os.path.abspath(args.preset), 48 * 128 * 3, string_iteration=8, array_size=512,
                   sample_rate=48000, samples_in_cycle=64, buffer_size=4, audio_on=False,
                   audio_driver_type=0, listen_to_modes=False, sound_derivative_order=2, volume=100)
    backendServer.pianoid = p
    sr = int(p.mp.sample_rate())
    nch = int(p.mp.num_channels)
    res = {'num_channels': nch, 'mode_iteration': int(p.mp.mode_iteration), 'sample_rate': sr}

    # 1) /play_keyboard offline (the report-8761 surface, shortened: 3 pitches x 1500 ms)
    client = backendServer.app.test_client()
    r = client.post('/play_keyboard', json={'mode': 'offline', 'pitches': [48, 60, 67],
                                            'speed_ms_per_note': 1500, 'velocity': 95})
    body = r.get_json()
    wav, wsr, wch = wav_from_b64(body['audio_data'][0])
    res['play_keyboard'] = {'http': r.status_code, 'reported_duration_ms': body['duration_ms'],
                            'reported_audio_samples': body['audio_samples'], 'wav_channels': wch,
                            'cycles_rendered': body['cycles_rendered'],
                            'raw_over_cycles_x64': round(body.get('audio_samples', 0) / (body['cycles_rendered'] * 64), 3),
                            'metrics': layout_metrics(wav, wsr, nch, body['duration_ms'] / 1000.0)}

    # 2) render.note_playback + dispersion sweep (report 06c895bc)
    pitch = args.pitch
    base = float(p.pack_for_interface('string', pitches=[pitch])[0][pitch]['dispersion_damping'])
    res['dispersion_base'] = base
    f0_nom = 440.0 * 2 ** ((pitch - 69) / 12)
    res['note_playback'] = {}
    for label, mult in (('x1', 1), ('x10', 10), ('x10_repeat', 10), ('x100', 100), ('x100_repeat', 100)):
        p.update_parameter('string', {str(pitch): {'dispersion_damping': base * mult}}, pitches=[pitch])
        back = float(p.pack_for_interface('string', pitches=[pitch])[0][pitch]['dispersion_damping'])
        chartFunctions.play_note_offline_chart_function(p, pitch=pitch, velocity=100, duration_ms=12000)
        ch0 = np.asarray(p.result.sound[0], dtype=np.float64)
        entry = {'dispersion_damping': back, 'sound_shape': list(np.shape(p.result.sound)),
                 'decays': partial_decays(ch0, sr, f0_nom)}
        if mult == 1:
            entry['metrics'] = layout_metrics(ch0, sr, nch, 12.0 + 5.0)
        res['note_playback'][label] = entry
    p.update_parameter('string', {str(pitch): {'dispersion_damping': base}}, pitches=[pitch])

    # 3) report bc956d19: a string write whose values miss one pitch of the range
    def damper(k):
        return float(p.pack_for_interface('string', pitches=[k])[0][k]['damper_string'])
    before = {k: damper(k) for k in (58, 59, 61)}
    vals = {str(k): {'damper_string': before.get(k, damper(k)) * 0.1} for k in (58, 59, 61)}
    rc = client.post('/set_parameter/string/from58to61', json=vals)
    res['missing_pitch'] = {'http': rc.status_code, 'body': rc.get_json(),
                            'damper_before': before, 'damper_after': {k: damper(k) for k in (58, 59, 61)}}

    with open(args.out, 'w') as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res, indent=1))
    try:
        p.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == '__main__':
    main()
