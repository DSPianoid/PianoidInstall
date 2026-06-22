"""dev-profchart online population check.

Initializes a single real Pianoid (audio_on, ASIO->SDL3 fallback) in-process,
runs ONE short online Sound Test render with include_profiling=True against the
WORKTREE chartFunctions.py, and prints the profiling chart + render_hints +
text_fields so we can confirm the kernel-cycle-timing series + over-budget
markers + underrun summary populate with REAL numbers.

Single-instance invariant respected (one Pianoid, one teardown). Does NOT bind
the launcher ports (3001/5000) — pure in-process.

Run:
    cd D:/repos/PianoidInstall/PianoidCore
    .venv/Scripts/python ../docs/development/diagnostics/dev-profchart-online-population-check.py
"""
import os
import sys
import json

CORE = r"D:/repos/PianoidInstall/PianoidCore"
WT_MIDDLEWARE = r"D:/repos/PianoidInstall/PianoidCore/.git/wt-profchart/pianoid_middleware"
# Worktree middleware FIRST so chartFunctions resolves to the edited copy.
for p in (WT_MIDDLEWARE, os.path.join(CORE, "pianoid_middleware"), CORE):
    if p not in sys.path:
        sys.path.insert(0, p)

PRESET = os.path.join(CORE, "pianoid_middleware", "presets", "BaselinePreset1.json")


def main():
    # Force the WORKTREE chartFunctions into sys.modules before anything else
    # imports it, so the real engine path uses the edited copy.
    import importlib.util
    wt_cf_path = os.path.join(WT_MIDDLEWARE, "chartFunctions.py")
    spec = importlib.util.spec_from_file_location("chartFunctions", wt_cf_path)
    cf = importlib.util.module_from_spec(spec)
    sys.modules["chartFunctions"] = cf
    spec.loader.exec_module(cf)
    print("chartFunctions loaded from:", cf.__file__)
    assert ".git/wt-profchart" in cf.__file__.replace("\\", "/"), \
        "NOT loading worktree chartFunctions!"

    from pianoid import initialize

    print("Initializing Pianoid (audio_on, ASIO_CALLBACK -> SDL3 fallback)...")
    pianoid = initialize(
        PRESET,
        384,
        sample_rate=48000,
        samples_in_cycle=64,
        audio_on=1,
        audio_driver_type=4,          # ASIO callback; auto-falls back to SDL3
        start_right_away=1,           # start the realtime thread
        listen_to_midi=False,
        use_placeholder=0,
    )
    try:
        active = pianoid.pianoid.isAudioDriverActive()
        print("audio_driver_active:", active)
        print("Calling sound_test_function(mode=online, include_kernel, include_profiling)...")
        result = cf.sound_test_function(
            pianoid,
            mode="online",
            play_kind="note",
            pitches="60",
            velocities="100",
            note_durations_ms="500",
            tail_ms=500,
            include_kernel=True,
            include_profiling=True,
            channels="0",
        )
        if len(result) == 4:
            charts, header, text_fields, extra = result
        else:
            charts, header, text_fields = result
            extra = {}

        headers, datas, audios = charts.get_data()
        print("\n=== TOP HEADER ===", header)
        print("\n=== CHART HEADERS ===")
        for i, h in enumerate(headers):
            n = len(datas[i]) if datas[i] is not None else 0
            has_audio = audios[i] is not None
            print(f"  [{i}] {h}  (points={n}, audio_player={has_audio})")

        # Profiling chart specifics
        prof_idx = None
        for i, h in enumerate(headers):
            if h == "Kernel cycle time (us)":
                prof_idx = i
                break
        print("\n=== PROFILING CHART ===")
        if prof_idx is None:
            print("  NOT FOUND. text_fields Profiling note:",
                  text_fields.get("Profiling note"))
        else:
            d = datas[prof_idx]
            print(f"  found at index {prof_idx}; cycles={len(d)}")
            print(f"  first 10 cycle times (us): {[round(x,1) for x in d[:10]]}")
            print(f"  min={min(d):.1f} median={sorted(d)[len(d)//2]:.1f} max={max(d):.1f}")
            print(f"  audio_player attached: {audios[prof_idx] is not None} (expect False)")
            hint = extra.get("render_hints", [None]*len(headers))[prof_idx]
            print("  render_hints.threshold:", hint.get("threshold") if hint else None)
            n_over = sum(1 for m in (hint.get("point_meta") or []) if m.get("over_budget"))
            print(f"  over-budget markers: {n_over} / {len(d)}")

        print("\n=== TEXT FIELDS (profiling-relevant) ===")
        for k in ("Cycle timing", "Underruns", "Callback interval (us)", "Profiling note"):
            if k in text_fields:
                print(f"  {k}: {text_fields[k]}")
    finally:
        try:
            pianoid.stop_playback()
            print("\nstop_playback OK")
        except Exception as e:
            print("stop_playback error:", e)


if __name__ == "__main__":
    main()
