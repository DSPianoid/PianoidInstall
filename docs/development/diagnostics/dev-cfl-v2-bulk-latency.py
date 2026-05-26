"""dev-cfl-v2: END-TO-END bulk-latency measurement of the host CFL gate (user perf reservation, 2026-05-26).

The user flagged that the host-side check could add latency on the BULK path (preset load / an edit touching
all ~220 strings). This measures the REAL delta:
  1. the gate's own cost on an ALL-PITCH string edit (per-pitch loop vs the numpy-vectorized box over all strings),
  2. the end-to-end update_parameter('string', {all pitches}) wall time (gate + the existing GRANULAR upload),
  3. a preset-load-equivalent full-StringMap stability_ratio computation (the read path).

Reports absolute µs/ms so the reservation is answered with numbers. Plan: cfl-stability-guard-v2.md §4 perf note.

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-v2-bulk-latency.py
"""
import os, sys, time
import numpy as np

CORE = os.getcwd() if os.path.basename(os.getcwd()) == "PianoidCore" else \
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) + "/PianoidCore"
sys.path.insert(0, os.path.join(CORE, "pianoid_middleware"))
sys.path.insert(0, CORE)
from tests.conftest import get_preset_path  # noqa


def main():
    os.chdir(os.path.join(CORE, "pianoid_middleware"))
    from pianoid import initialize
    import cfl_stability as cfl
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=6,
                    array_size=384, sample_rate=48000, samples_in_cycle=64, buffer_size=4, max_volume=5e18,
                    audio_on=False, audio_driver_type=0)
    pm = pw.param_manager
    piano_pitches = pw.sm.all_pitches(piano=True)
    n_pitches = len(piano_pitches)
    n_strings = sum(len(pw.sm.pitches[p].stringIDs) for p in piano_pitches)
    print(f"piano pitches={n_pitches} total physical strings={n_strings}")

    # --- (1) gate-only cost: _raise_if_cfl_unstable over ALL pitches (the per-pitch scalar path actually wired) ---
    base_t = {str(p): {'tension': float(pw.sm.pitches[p].physics.tension * 1.05)} for p in piano_pitches}
    N = 50
    t0 = time.perf_counter()
    for _ in range(N):
        pm._raise_if_cfl_unstable(piano_pitches, base_t)
    dt_gate = (time.perf_counter() - t0) / N
    print(f"(1) GATE per-pitch over ALL {n_pitches} pitches: {dt_gate*1e3:.3f} ms/call ({dt_gate/n_strings*1e6:.2f} µs/string)")

    # --- (1b) vectorized box over all strings (the bulk-path target form) ---
    dt = 1.0 / (48000 * 6)
    Ts, Bs, decs, cfds = [], [], [], []
    for p in piano_pitches:
        ph = pw.sm.pitches[p].physics
        dx = ph.geometry.dx()
        off = getattr(pw.sm.pitches[p], 'tension_offset', 0.0) or 0.0
        for i in range(len(pw.sm.pitches[p].stringIDs)):
            T, B = cfl._coeffs(ph.tension * (1.0 + i * off), ph.r, ph.rho, ph.jung, dx, dt)
            Ts.append(T); Bs.append(B); decs.append(ph.gamma * dt)
            cfds.append((getattr(ph, 'disp_decay', 0.0) or 0.0) / (2.0 * dt * dx * dx) if dx else 0.0)
    Ts = np.array(Ts); Bs = np.array(Bs); decs = np.array(decs); cfds = np.array(cfds)
    M = 200
    t0 = time.perf_counter()
    for _ in range(M):
        amps = cfl.max_amp_vector(Ts, Bs, decs, cfds)
        _ = bool(np.all(amps <= cfl.CFL_LIMIT + cfl.CFL_STABILITY_EPS))
    dt_vec = (time.perf_counter() - t0) / M
    print(f"(1b) VECTORIZED box over all {n_strings} strings at once: {dt_vec*1e6:.1f} µs/call ({dt_vec/n_strings*1e6:.3f} µs/string) -> {amps.max():.4f} max|g|")

    # --- (2) end-to-end update_parameter('string', all pitches) wall time (gate + GRANULAR upload) ---
    K = 5
    t0 = time.perf_counter()
    for _ in range(K):
        pw.update_parameter('string', base_t, pitches=piano_pitches)
    dt_e2e = (time.perf_counter() - t0) / K
    print(f"(2) END-TO-END update_parameter('string', ALL pitches) [gate + upload]: {dt_e2e*1e3:.1f} ms/call")

    # --- (3) preset-load-equivalent: full-StringMap stability_ratio (the chart/read path) ---
    t0 = time.perf_counter()
    payload, _ = pw.pack_for_interface('stability_ratio', pitches=piano_pitches)
    dt_ratio = time.perf_counter() - t0
    print(f"(3) full-StringMap stability_ratio (read path, {n_pitches} pitches): {dt_ratio*1e3:.1f} ms")

    print("\nRESERVATION ANSWER:")
    print(f"  gate adds ~{dt_gate*1e3:.2f} ms to a full all-string edit (vectorized form: ~{dt_vec*1e6:.0f} µs).")
    print(f"  end-to-end all-string edit (gate + GPU upload) = {dt_e2e*1e3:.0f} ms (upload dominates; gate is {100*dt_gate/dt_e2e:.1f}%).")
    try:
        pw.pianoid.shutdownGpu()
    except Exception:
        pass


if __name__ == "__main__":
    main()
