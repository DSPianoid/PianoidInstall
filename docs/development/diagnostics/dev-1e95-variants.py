"""dev-1e95 ablation presets from the converted F_15 (i16 for N=16; i8 rescaled to N=4: disp_decay, damper_string x2)."""
import json, base64, numpy as np, copy, sys
def load(N):
    pr = json.load(open("F15_i16.json" if N == 16 else "F15_i8.json"))
    if N == 4:
        for k, p in pr["pitches"].items():
            p["physics"]["disp_decay"] *= 2.0; p["physics"]["damper_string"] *= 2.0
        pr["fpga_conversion"]["load_params"]["string_iteration"] = 4; pr["model_parameters"]["string_iteration"] = 4
    return pr
def zero_deck_except(pr, keep):
    for k, p in pr["pitches"].items():
        if int(k) < 128 and int(k) not in keep:
            d = p["deck"]; arr = np.zeros(d["shape"]); p["deck"] = {"data": base64.b64encode(arr.tobytes()).decode(), "shape": d["shape"], "type": "float64"}
for N in (16, 4):
    base = load(N); json.dump(base, open(f"v_full_N{N}.json", "w"))
    v = copy.deepcopy(base); zero_deck_except(v, {22}); json.dump(v, open(f"v_only22_N{N}.json", "w"))
    v2 = copy.deepcopy(v); v2["pitches"]["22"]["physics"]["jung"] = 0.0; json.dump(v2, open(f"v_only22_nobend_N{N}.json", "w"))
    v3 = copy.deepcopy(v); v3["pitches"]["22"]["physics"]["disp_decay"] = 0.0; json.dump(v3, open(f"v_only22_noHF_N{N}.json", "w"))
    v4 = copy.deepcopy(v); v4["pitches"]["22"]["physics"]["damper_string"] = 0.0; json.dump(v4, open(f"v_only22_notail_N{N}.json", "w"))
    v5 = copy.deepcopy(base); zero_deck_except(v5, set(range(21, 33))); json.dump(v5, open(f"v_bass21_32_N{N}.json", "w"))
print("ok")
