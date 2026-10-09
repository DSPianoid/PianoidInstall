"""dev-675e: replay today's preset-load packing path (pianoid.py:190-290 -> init: pack_deck(single) + pack_modes)
on a PianoidBasic SOURCE tree (no GPU, no pianoidCuda import) and report whether a preset loads or how it fails.
Usage: python dev-675e-current-loader.py BASIC_PIANOID_DIR PRESET.json [PRESET.json ...]"""
import contextlib, io, json, sys, time, traceback
sys.path.insert(0, sys.argv[1])
import numpy as np
from ModelParams import ModelParameters
from StringMap import StringMap
from Mode import ModeMap


def load(path):
    pr = json.load(open(path))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mp = ModelParameters(); mp.update_params(**pr["model_parameters"])
        mp.mode_channel_index = 196; mp.num_channels = 4          # pianoid.py:254-255
        sm = StringMap(model_params=mp, **pr)
        modes = ModeMap(mp, pr["modes"], num_modes="define", num_modes_for_model=mp.num_strings)
        modes.set_sound_channels(pr["mode_sound_channels"]["num_channels"])
        sm.soundChannelModes.read_from_preset({k: v for k, v in pr["mode_sound_channels"].items() if k != "num_channels"})
        sm.soundChannelModes.read_string_coefficients_from_preset(pr["string_sound_channels"])
        for p in sm.pitches.values():                                 # pianoid.py:283-285
            for k in ("feedin", "feedback"):
                p.deck[k] = np.pad(p.deck[k], (0, modes.num_working_modes() - len(p.deck[k])), mode="edge")
        deck = sm.pack_deck(single_matrix_mode=True)
        ms = modes.pack_modes(keep_state=False)
    return mp, deck, ms


for path in sys.argv[2:]:
    t0 = time.time()
    try:
        mp, deck, ms = load(path)
        print(f"LOADED {path}: num_modes={mp.num_modes} slots={mp.num_modes_for_model} deck={len(deck)} "
              f"(= {mp.num_strings}^2: {len(deck) == mp.num_strings ** 2}) modes={len(ms)} "
              f"(= 3*slots: {len(ms) == 3 * mp.num_modes_for_model}) sc_index={mp.mode_channel_index} [{time.time() - t0:.0f}s]")
    except Exception as e:
        tb = traceback.extract_tb(e.__traceback__)[-1]
        print(f"FAILED {path}: {type(e).__name__}: {e} @ {tb.filename.split(chr(92))[-1]}:{tb.lineno} [{time.time() - t0:.0f}s]")
