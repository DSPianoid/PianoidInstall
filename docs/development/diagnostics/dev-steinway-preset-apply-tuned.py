"""
dev-steinway-preset: apply the FrequencyTuner's tuned per-pitch tensions back into the preset files.

Reads D:\tmp\steinway_B_tuned_tensions.json {pitch: {tension_after,...}} and writes ONLY
physics.tension for each tuned pitch into:
  - Belarus_196modesC_Steinway1860_56SM (preset B — all its piano pitches, MIDI 23-106)
  - Belarus_196modesC_Steinway1860      (preset A — same shared pitches 23-106; A's 21,22,107,108
    are NOT in the tuned set → left at derived/untuned tension, FLAGGED)
Nothing else is touched. Re-validates JSON after write.
"""
import sys, json, os
from pathlib import Path

PRESETS = Path(r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets")
TUNED = json.load(open(r"D:\tmp\steinway_B_tuned_tensions.json"))
tuned_T = {int(k): v["tension_after"] for k, v in TUNED.items()}

def apply(name):
    path = PRESETS / name
    d = json.load(open(path, encoding="utf-8"))
    applied = []
    untuned = []
    for pk, p in d["pitches"].items():
        m = int(pk)
        if m >= 128:
            continue
        if m in tuned_T:
            old = p["physics"]["tension"]
            p["physics"]["tension"] = round(tuned_T[m], 6)
            applied.append(m)
        else:
            untuned.append(m)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
    # re-validate
    json.load(open(path, encoding="utf-8"))
    return applied, untuned

if __name__ == "__main__":
    for name in ["Belarus_196modesC_Steinway1860_56SM", "Belarus_196modesC_Steinway1860"]:
        applied, untuned = apply(name)
        print(f"{name}: applied tuned tension to {len(applied)} pitches "
              f"({min(applied)}-{max(applied)}); UNTUNED (left derived): {untuned}")
    print("Both presets updated with tuned tensions + re-validated as JSON.")
