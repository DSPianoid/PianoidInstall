"""dev-t3cu F7-hammer granularity verification (offline, audio_off).

Proves a single-pitch hammer edit uploads ONLY the affected block row(s) via
updateHammerBlockRow (NOT the whole-matrix setNewHammerParameters), and that
each upload reaches the engine (returns True). Fresh process; never the live backend.
"""
import os, sys
HERE = os.path.abspath(__file__)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(HERE))))
CORE = os.environ.get("PIANOID_CORE_DIR") or os.path.join(REPO, "PianoidCore")
MID = os.path.join(CORE, "pianoid_middleware")
sys.path.insert(0, CORE); sys.path.insert(0, MID); os.chdir(MID)

from pianoid import initialize

p = initialize(os.path.join(MID, "presets", "Preset_test5.json"),
               filterlen=48 * 128 * 3, string_iteration=4, array_size=384,
               sample_rate=48000, samples_in_cycle=64, buffer_size=4,
               max_volume=5e18, audio_on=False, audio_driver_type=0)

pm = p.param_manager
PITCH = 60

num_blocks = p.sm.mp.num_string_arrays() if hasattr(p.sm.mp, 'num_string_arrays') else len(p.sm.blocks)
affected = sorted(set(p.sm.get_blocks_for_pitch(PITCH)))
print(f"NUM_BLOCKS={num_blocks} AFFECTED_BLOCKS_FOR_PITCH_{PITCH}={affected}")

# Instrument the Python upload layer (the binding methods are read-only).
block_calls = []
bulk_calls = [0]
orig_gpu_upload = pm._gpu_upload
def spy_gpu_upload(method, *args):
    name = getattr(method, '__name__', str(method))
    if name == 'updateHammerBlockRow':
        block_calls.append((args[0], len(args[1])))
    elif name == 'setNewHammerParameters':
        bulk_calls[0] += 1
    return orig_gpu_upload(method, *args)
pm._gpu_upload = spy_gpu_upload

# Trigger a single-pitch hammer edit through the real apply path.
cur_w = float(p.sm.pitches[PITCH].physics.hammer.width)
new_w = cur_w * 1.15
pm.update_parameter('hammer', {str(PITCH): {'width': new_w}}, pitches=[PITCH])

print(f"BULK_CALLS={bulk_calls[0]}  BLOCK_CALLS={len(block_calls)}  BLOCK_IDS={[b for b,_ in block_calls]}  ROW_SIZES={sorted(set(n for _,n in block_calls))}")
ok_scope = (bulk_calls[0] == 0
            and sorted(b for b, _ in block_calls) == affected
            and all(n == 384 for _, n in block_calls))
print(f"F7_HAMMER_GRANULAR_OK={ok_scope}")

try:
    p.pianoid.shutdownGpu()
except Exception:
    pass
