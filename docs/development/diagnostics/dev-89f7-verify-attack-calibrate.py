"""dev-89f7 offline verification of the Virtual Piano Calibrate job (calibration.attack_equalize).

Run against an ISOLATED spare-port backend started from the feature worktree with audio_on 0
(never the user's :5000). Steps:
  1. load F15_measured_plywood_2026-10-17 at its declared settings (512 / si16 / d1 / 48k / 64);
  2. BEFORE: an independent measure-only run (max_passes 0: fresh per-key renders of all 88 keys,
     A-weighted 300 ms attack energy-summed over the unmuted channels, re the reference; no write).
     (/play_keyboard offline is NOT usable here: its WAV is the raw per-cycle-interleaved multi-channel
     buffer written as mono — dev-89f7 finding);
  3. run calibration.attack_equalize through POST /command (the registry path the UI / assistant
     use), follow job.get until terminal, time it;
  4. AFTER: the same measure-only run;
  5. history: exactly one new group, history.undo {group} -> masses equal the BEFORE masses, the
     measure-only run matches BEFORE; output_scale unchanged throughout;
  6. cancel: a run stopped at ~30 % ends job_cancelled with the partial result, the engine cycles
     again, and history.undo {group} restores the masses.
Writes a JSON report next to --out. Usage:
  python dev-89f7-verify-attack-calibrate.py --base http://127.0.0.1:5012 --out <dir>
"""
import argparse
import json
import math
import os
import time

import requests


PRESET = 'presets/F15_measured_plywood_2026-10-17.json'
DECLARED = {'array_size': 512, 'string_iterations': 16, 'sound_derivative_order': 1,
            'sample_rate': 48, 'cycle_iterations': 64, 'listen_to_modes': 0}
REF, VEL = 62, 95


def post(base, path, body=None, timeout=600):
    r = requests.post(base + path, json=body or {}, timeout=timeout)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, r.text


def get(base, path, timeout=60):
    r = requests.get(base + path, timeout=timeout)
    return r.status_code, r.json()


def run_job(base, args, cancel_after_pct=None):
    """Run calibration.attack_equalize through POST /command; follow job.get to the end."""
    t0 = time.monotonic()
    status, res = post(base, '/command/calibration.attack_equalize', args)
    assert status == 200 and res.get('jobId'), res
    job_id, last, cancelled = res['jobId'], None, False
    while True:
        job = post(base, '/command/job.get', {'jobId': job_id})[1]['result']['job']
        if job['pct'] != last:
            print(f"  job {job['state']} {job['pct']}% {job['msg']}", flush=True)
            last = job['pct']
        if cancel_after_pct is not None and not cancelled and job['pct'] >= cancel_after_pct:
            print('  job.cancel ->', post(base, '/command/job.cancel', {'jobId': job_id})[1].get('result'))
            cancelled = True
        if job['state'] not in ('pending', 'running'):
            break
        time.sleep(0.5)
    return job, round(time.monotonic() - t0, 1)


def measure(base):
    """Independent measure-only run (max_passes 0: fresh renders of all keys, no write)."""
    job, wall = run_job(base, {'reference_pitch': REF, 'velocity': VEL, 'max_passes': 0})
    assert job['state'] == 'finished', job
    r = job['result']
    return {'wall_s': wall, 'max_abs_db': r['max_abs_dev_before_db'], 'std_db': r['std_before_db'],
            'min_db': min(r['before_db'].values()), 'max_db': max(r['before_db'].values()),
            'channels': r['channels'], 'dev_db': r['before_db'], 'renders': r['renders']}


def masses(base):
    status, res = get(base, '/excitation_energy')
    assert status == 200, res
    return {int(k): float(v) for k, v in res['hammer_mass'].items()}


def output_scale(base):
    return get(base, '/health')[1].get('output_scale', {}).get('value')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:5012')
    ap.add_argument('--out', required=True)
    ap.add_argument('--skip-load', action='store_true')
    a = ap.parse_args()
    base, report = a.base, {}
    if not a.skip_load:
        body = dict(DECLARED, path=PRESET, audio_on=0, start_right_away=1, listen_to_midi=0,
                    audio_driver_type=0, audio_buffer_size=4, volume=100, debug_mode=0)
        t0 = time.monotonic()
        status, res = post(base, '/load_preset', body, timeout=900)
        report['load'] = {'status': status, 's': round(time.monotonic() - t0, 1),
                          'warnings': res.get('load_param_warnings') if isinstance(res, dict) else res}
        assert status == 200, res
    # the realtime loop must have cycled before a calibration enters calibration mode: entering
    # within ~1 s of the start races the loop start ("Main loop is active" on the first render)
    for _ in range(60):
        ms = get(base, '/health')[1].get('audio_health', {}).get('ms_since_last_cycle', -1)
        if 0 <= ms < 100:
            break
        time.sleep(0.5)
    time.sleep(2.0)
    keys = sorted(masses(base))
    keys = [p for p in keys if p < 128]
    report['keys'] = len(keys)
    m0, os0 = masses(base), output_scale(base)
    report['before'] = measure(base)
    hist0 = get(base, '/history')[1]
    job, wall = run_job(base, {'reference_pitch': REF, 'velocity': VEL})
    report['job'] = {'state': job['state'], 'wall_s': wall, 'error': job.get('error'),
                     'result': job.get('result')}
    assert job['state'] == 'finished', job
    result = job['result']
    m1, os1 = masses(base), output_scale(base)
    report['after'] = measure(base)
    hist1 = get(base, '/history')[1]
    report['history'] = {'depth_before': hist0.get('depth'), 'depth_after': hist1.get('depth'),
                         'undo_groups_after': hist1.get('undo_groups', [])[:3]}

    status, undo = post(base, '/command/history.undo', {'group': result['group']})
    m2, os2 = masses(base), output_scale(base)
    report['undo'] = {'status': status, 'steps': (undo.get('result') or {}).get('steps'),
                      'masses_equal_before': all(m2[p] == m0[p] for p in m0),
                      'max_mass_rel_diff': max(abs(m2[p] - m0[p]) / m0[p] for p in m0),
                      'changed_keys_by_run': sum(1 for p in m0 if m1[p] != m0[p])}
    report['undone'] = measure(base)
    # cancel path: Stop after ~30 %, then Undo the partial group
    cjob, cwall = run_job(base, {'reference_pitch': REF, 'velocity': VEL}, cancel_after_pct=30)
    cres = cjob.get('result') or {}
    health = get(base, '/health')[1]
    cu_status, cu = post(base, '/command/history.undo', {'group': cres.get('group')})
    m3 = masses(base)
    report['cancel'] = {'state': cjob['state'], 'wall_s': cwall, 'cancelled': cres.get('cancelled'),
                        'renders': cres.get('renders'), 'passes': cres.get('passes'),
                        'engine_cycling_after': health.get('audio_health', {}).get('ms_since_last_cycle'),
                        'undo_status': cu_status, 'masses_equal_before': all(m3[p] == m0[p] for p in m0)}
    report['output_scale'] = {'before': os0, 'after_run': os1, 'after_undo': os2}
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, 'dev-89f7-verify-attack-calibrate.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    summary = {k: report[k] for k in ('load', 'keys', 'history', 'undo', 'output_scale') if k in report}
    for k in ('before', 'after', 'undone'):
        summary[k] = {f: report[k][f] for f in ('max_abs_db', 'std_db', 'min_db', 'max_db', 'wall_s', 'renders')}
    summary['cancel'] = report['cancel']
    summary['job'] = {k: report['job'][k] for k in ('state', 'wall_s')}
    summary['job_result'] = {k: result.get(k) for k in (
        'channels', 'max_abs_dev_before_db', 'max_abs_dev_after_db', 'std_before_db', 'std_after_db',
        'converged', 'passes', 'clamped', 'silent', 'renders', 'runtime_s', 'reference_drift_db', 'group')}
    print(json.dumps(summary, indent=1))
    print('report:', path)


if __name__ == '__main__':
    main()
