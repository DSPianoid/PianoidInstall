"""dev-soundd online population check (D1 checkpoint decomposition + D2 spectrum).

Initializes a single real Pianoid (audio_on, ASIO->SDL3 fallback) in-process,
runs ONE short online Sound Test render with include_profiling + include_spectrum
against the WORKTREE chartFunctions.py, and confirms the NEW D1 series populate
with REAL numbers:
  - "Full cycle incl. sync (us)" chart
  - "Driver-push sync wait (us)" chart (the isolated host audio-clock back-pressure)
  - "Cycle checkpoint breakdown" + "Non-kernel delay attribution" text fields
and the D2 spectrum chart appears (freq axis, no audio player).

Single-instance invariant respected (one Pianoid, one teardown). Pure in-process,
does NOT bind the launcher ports.

Run:
    cd D:/repos/wt-soundd-core
    D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python ../PianoidInstall/docs/development/diagnostics/dev-soundd-online-population-check.py
"""
import os
import sys

WT_CORE = r"D:/repos/wt-soundd-core"
WT_MIDDLEWARE = os.path.join(WT_CORE, "pianoid_middleware")
for p in (WT_MIDDLEWARE, WT_CORE):
    if p not in sys.path:
        sys.path.insert(0, p)

PRESET = os.path.join(WT_MIDDLEWARE, "presets", "BaselinePreset1.json")


def main():
    import importlib.util
    wt_cf_path = os.path.join(WT_MIDDLEWARE, "chartFunctions.py")
    spec = importlib.util.spec_from_file_location("chartFunctions", wt_cf_path)
    cf = importlib.util.module_from_spec(spec)
    sys.modules["chartFunctions"] = cf
    spec.loader.exec_module(cf)
    print("chartFunctions loaded from:", cf.__file__)
    assert "wt-soundd-core" in cf.__file__.replace("\\", "/"), \
        "NOT loading worktree chartFunctions!"

    from pianoid import initialize

    print("Initializing Pianoid (audio_on, ASIO_CALLBACK -> SDL3 fallback)...")
    pianoid = initialize(
        PRESET,
        384,
        sample_rate=48000,
        samples_in_cycle=64,
        audio_on=1,
        audio_driver_type=4,
        start_right_away=1,
        listen_to_midi=False,
        use_placeholder=0,
    )
    try:
        print("audio_driver_active:", pianoid.pianoid.isAudioDriverActive())
        print("Running sound_test (online, kernel+profiling+spectrum)...")
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
            include_spectrum=True,
            channels="0",
        )
        if len(result) == 4:
            charts, header, text_fields, extra = result
        else:
            charts, header, text_fields = result
            extra = {}

        headers, datas, audios = charts.get_data()
        print("\n=== CHART HEADERS ===")
        for i, h in enumerate(headers):
            n = len(datas[i]) if datas[i] is not None else 0
            print(f"  [{i}] {h}  (points={n}, audio_player={audios[i] is not None})")

        # dev-soundd-multipoint: confirm EVERY per-segment series renders.
        want = ["Segment: kernel cp0→cp1 (us)",
                "Segment: FIR/audio-prep cp1→cp2 (us)",
                "Segment: sync wait cp2→cp3 (us)",
                "Segment: host tail cp3→cp4 (us)",
                "Full cycle incl. sync (us)",
                "Add-kernel device time (us)"]
        idx = {h: i for i, h in enumerate(headers)}
        print("\n=== D1 MULTI-POINT SERIES ===")
        for w in want:
            if w in idx:
                d = datas[idx[w]]
                print(f"  {w}: cycles={len(d)} "
                      f"median={sorted(d)[len(d)//2]:.0f} max={max(d):.0f} "
                      f"audio_player={audios[idx[w]] is not None}")
            else:
                print(f"  {w}: NOT FOUND")

        spectra = [h for h in headers if h.endswith("spectrum")]
        print("\n=== D2 SPECTRUM ===")
        print("  spectrum charts:", spectra or "NONE")

        print("\n=== TEXT FIELDS (D1/profiling) ===")
        for k in ("Cycle checkpoint breakdown (us, median)",
                  "Non-kernel delay attribution",
                  "Add-kernel device time", "Full-cycle host span (us)",
                  "Underruns", "Callback interval (us)", "Profiling note"):
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
