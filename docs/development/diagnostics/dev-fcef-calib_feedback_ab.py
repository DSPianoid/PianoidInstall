"""dev-fcef A/B (own process, engine NOT live -> offline render legal; shares the GPU with the user backend):
does the Layer B calibration depend on the SESSION deck feedback (FE slider) instead of the preset's stored one?

Loads F15_Elyashev_array512 at its declared settings (512/d1/si16/lm0), forces calibrate_output_scale at
runtime feedback 1.0 (= stored) and at 2.0, and prints the two scales + their dB difference, plus the
runtime feedback after the calibration (must be the session value). Run with MW=<pianoid_middleware dir>
to compare the code under test (worktree) with the current main checkout.
Usage: MW=<dir> python dev-fcef-calib_feedback_ab.py"""
import json, math, os, sys, time

MW = os.environ.get("MW", r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware")
os.chdir(MW); sys.path.insert(0, MW)
import backendServer as B  # noqa: E402

body = {'path': 'presets/F15_Elyashev_array512.json', 'volume': 100, 'sample_rate': 48, 'string_iterations': 16,
        'number_of_modes': 64, 'use_simulation': 0, 'debug_mode': 0, 'cycle_iterations': 64, 'start_right_away': 0,
        'audio_on': 0, 'listen_to_midi': 0, 'use_cuda': 1, 'audio_driver_type': 0, 'audio_buffer_size': 2,
        'array_size': 512, 'listen_to_modes': 0, 'sound_derivative_order': 1}
c = B.app.test_client()
t = time.time(); r = c.post("/load_preset", json=body); print("load", r.status_code, f"{time.time()-t:.1f}s", flush=True)
pw = B.pianoid
res = {"mw": MW, "stored_feedback": pw.mp.deck_feedback_coefficient}
for fb in (1.0, 2.0):
    pw.set_deck_feedback_coefficient(fb)
    res[f"scale_at_fb{fb}"] = pw.calibrate_output_scale(force=True)
    res[f"runtime_fb_after_fb{fb}"] = pw.get_deck_feedback_coefficient()
res["delta_db"] = 20 * math.log10(res["scale_at_fb2.0"] / res["scale_at_fb1.0"])
print(json.dumps(res), flush=True)
os._exit(0)
