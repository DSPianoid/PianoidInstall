"""dev-sfix online check — #3a per-series profiling toggles + #3b all-channels.

Single in-process Pianoid (audio_on, ASIO->SDL3 fallback). Runs the WORKTREE
chartFunctions and confirms:
  #3a: with only a subset of prof_* toggles, only those profiling charts render.
  #3b: include_all_channels=True renders every channel per source (ch0,ch1,...).

Run:
    cd D:/repos/wt-sfix-core
    D:/repos/PianoidInstall/PianoidCore/.venv/Scripts/python ../PianoidInstall/docs/development/diagnostics/dev-sfix-online-check.py
"""
import os
import sys

WT_CORE = r"D:/repos/wt-sfix-core"
WT_MIDDLEWARE = os.path.join(WT_CORE, "pianoid_middleware")
for p in (WT_MIDDLEWARE, WT_CORE):
    if p not in sys.path:
        sys.path.insert(0, p)

PRESET = os.path.join(WT_MIDDLEWARE, "presets", "BaselinePreset1.json")


def _headers(charts):
    h, _, _ = charts.get_data()
    return h


def main():
    import importlib.util
    wt_cf = os.path.join(WT_MIDDLEWARE, "chartFunctions.py")
    spec = importlib.util.spec_from_file_location("chartFunctions", wt_cf)
    cf = importlib.util.module_from_spec(spec)
    sys.modules["chartFunctions"] = cf
    spec.loader.exec_module(cf)
    assert "wt-sfix-core" in cf.__file__.replace("\\", "/"), "wrong chartFunctions!"

    from pianoid import initialize
    pianoid = initialize(PRESET, 384, sample_rate=48000, samples_in_cycle=64,
                         audio_on=1, audio_driver_type=4, start_right_away=1,
                         listen_to_midi=False, use_placeholder=0)
    try:
        nc = pianoid.mp.num_channels
        print("num_channels:", nc, "| audio_driver_active:", pianoid.pianoid.isAudioDriverActive())

        # #3a: only sync-wait + add-kernel selected, the rest OFF.
        r = cf.sound_test_function(
            pianoid, mode="online", play_kind="note", pitches="60",
            velocities="100", note_durations_ms="400", tail_ms=300,
            include_kernel=True, include_profiling=True,
            prof_add_kernel=True, prof_sync_wait=True,
            prof_full_cycle=False, prof_kernel=False,
            prof_audio_prep=False, prof_host_tail=False,
            channels="0",
        )
        h = _headers(r[0])
        prof = [x for x in h if x.startswith("Segment:") or x.startswith("Full cycle")
                or x.startswith("Add-kernel")]
        print("\n#3a SUBSET (add_kernel + sync_wait only):")
        for x in prof:
            print("   ", x)
        print("   PASS" if set(prof) == {"Segment: sync wait cp2→cp3 (us)",
                                         "Add-kernel device time (us)"}
              else "   CHECK (expected only sync-wait + add-kernel)")

        # #3b: all channels for the kernel source.
        r2 = cf.sound_test_function(
            pianoid, mode="online", play_kind="note", pitches="60",
            velocities="100", note_durations_ms="400", tail_ms=300,
            include_kernel=True, include_profiling=False,
            include_all_channels=True,
        )
        h2 = _headers(r2[0])
        kernel_ch = [x for x in h2 if x.startswith("Kernel ch")]
        print("\n#3b ALL CHANNELS (kernel):")
        print("   ", kernel_ch)
        print("   PASS" if len(kernel_ch) == nc else f"   CHECK (expected {nc} channels)")
    finally:
        try:
            pianoid.stop_playback()
        except Exception as e:
            print("stop_playback error:", e)


if __name__ == "__main__":
    main()
