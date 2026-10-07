"""Copy ONLY the Layer B fields of a preset saved from the engine (/save_preset) into a repo preset
file (round-trip-exact single-line json). Backs up the original first.
Usage: patch_layer_b.py <saved.json> <repo_preset.json> <backup_dir>"""
import json, os, shutil, sys

FIELDS = ('output_scale', 'output_scale_calibrated', 'output_scale_reference_impulse',
          'output_scale_load_settings', 'output_scale_target_dbfs')
saved, target, backup = sys.argv[1:4]
os.makedirs(backup, exist_ok=True)
bk = os.path.join(backup, os.path.basename(target))
if not os.path.exists(bk):
    shutil.copy2(target, bk)
src = json.load(open(saved, encoding='utf-8'))['model_parameters']
raw = open(target, encoding='utf-8').read()
d = json.loads(raw)
assert json.dumps(d) == raw, "not round-trip exact"
before = {k: d['model_parameters'].get(k) for k in FIELDS}
for k in FIELDS:
    d['model_parameters'][k] = src[k]
open(target, 'w', encoding='utf-8', newline='').write(json.dumps(d))
print(json.dumps({'file': target, 'backup': bk, 'before': before,
                  'after': {k: d['model_parameters'][k] for k in FIELDS}}, indent=1))
