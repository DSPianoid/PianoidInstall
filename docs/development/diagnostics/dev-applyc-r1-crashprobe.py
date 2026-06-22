"""Minimal isolated probe for the in-place reconstruct hard-crash.

Reproduces: init -> destroy -> reconstruct -> devMemoryInit, the smallest path
that crashed (no edits, no renders). Tests whether a settle (GC + cupy sync +
sleep) after destroyPianoid lets the reconstruct's devMemoryInit succeed.

Run from pianoid_middleware. Prints PROBE_OK / PROBE_CRASH markers.
"""
import os
import sys
import gc
import time
import traceback
import faulthandler

faulthandler.enable()

MIDDLEWARE = os.getcwd()
if MIDDLEWARE not in sys.path:
    sys.path.insert(0, MIDDLEWARE)

import pianoidCuda
from pianoid import initialize

SR = 48000
SPC = 48
PRESET = "presets/Preset_test5.json"


def step(msg):
    print(f"PROBE: {msg}", flush=True)


def reconstruct(p, settle):
    """Destroy + reconstruct + devMemoryInit, optionally with a settle."""
    active_name = p.get_active_preset()
    (strings_in_pitches, state_0, state_1, gauss_params, physical_parameters,
     hammer, _v, exc_idx, dec_open, stringMap) = p.sm.pack_parameters()
    fb_mask = p.sm.pack_output_mask()

    step("destroyPianoid()")
    p.destroyPianoid()

    if settle:
        step("settle: gc + cupy sync + sleep(0.3)")
        gc.collect()
        try:
            import cupy
            cupy.cuda.Stream.null.synchronize()
            cupy.cuda.Device().synchronize()
        except Exception as e:
            step(f"cupy sync note: {e}")
        time.sleep(0.3)

    init_params = p.pack_initialization_params_for_cuda(
        audio_driver_type=0, max_volume=5e18)
    step("reconstruct Pianoid(...)")
    p.pianoid = pianoidCuda.Pianoid(strings_in_pitches, init_params)
    from PanoidResult import PianoidResult
    p.result = PianoidResult(p.pianoid, p.mp)
    p.param_manager.pianoid = p.pianoid

    mode_coeffs = p.pack_deck_for_cuda()
    mode_state = p.modes.pack_modes(keep_state=False)
    step("devMemoryInit() on reconstructed engine  <-- crash site")
    p.pianoid.devMemoryInit(state_0, state_1, exc_idx, [], stringMap, dec_open,
                            fb_mask, 10000, p.sustain)
    step("devMemoryInit OK")
    for slot in p._library.names():
        p._load_preset_to_library(slot, physical_parameters, hammer, gauss_params,
                                  mode_state, mode_coeffs)
    p.pianoid.switchPreset(active_name, False)
    p._upload_excitation_coefficients()
    p.pianoid.initParameters()
    step("full reconstruct sequence OK")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "nosettle"
    settle = (mode == "settle")
    do_playback = (mode == "playback")  # mirror production: run+stop playback first
    step(f"mode={mode} settle={settle} do_playback={do_playback}")
    try:
        p = initialize(PRESET, filterlen=48 * 128 * 3, string_iteration=4,
                       array_size=384, sample_rate=SR, samples_in_cycle=SPC,
                       buffer_size=4, max_volume=5e18, audio_on=False,
                       audio_driver_type=0)
        step("init #1 OK")
        if do_playback:
            # Production path: the engine has been RUNNING; reinit stops+joins it
            # first. start the unified realtime engine, let it run, then the
            # reinitialize_cuda_engine path (stop_playback) before reconstruct.
            step("start_realtime_playback_unified() + run ~0.5s")
            p.start_realtime_playback_unified(with_midi_listener=False)
            time.sleep(0.5)
            step("stop_playback() (mirrors reinit step 1)")
            p.stop_playback()
            time.sleep(0.1)
        reconstruct(p, settle=settle)
        try:
            p.pianoid.shutdownGpu()
        except Exception:
            pass
        print("PROBE_OK", flush=True)
        return 0
    except Exception as e:
        step(f"PROBE_EXCEPTION {type(e).__name__}: {e}")
        traceback.print_exc()
        print("PROBE_CRASH_PYEXC", flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
