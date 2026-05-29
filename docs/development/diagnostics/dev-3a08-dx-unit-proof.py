"""
dev-3a08 — proves the length->dx UNIT mismatch numerically, in-process, with no
live engine. Pure data-model arithmetic: loads the preset, reads what the UI's
`string` GET serializer produces for `length`, then replays exactly what the
granular setter does with that value and prints the resulting `dx`.

This isolates the regression mechanism from any FDTD / audio behaviour.
"""
import sys, os, json

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic", "Pianoid"))
sys.path.insert(0, os.path.join(REPO, "PianoidBasic"))

PRESET = os.path.join(REPO, "PianoidCore", "pianoid_middleware", "presets",
                      "Preset_test5.json")


def main():
    from StringState import StringGeometry

    preset = json.load(open(PRESET))
    pitches = preset["pitches"]

    print(f"{'pitch':>5} | {'geom.length(m)':>14} | {'geom.main':>9} | "
          f"{'correct dx(m)':>13} | {'UI shows length':>15} | "
          f"{'dx after UI edit':>16} | {'dx error x':>11}")
    print("-" * 110)

    worst = 0.0
    for pid in sorted(pitches, key=lambda k: int(k)):
        ip = int(pid)
        if not (21 <= ip <= 108):
            continue
        g = pitches[pid]["geometry"]
        length_m, main, tail = g["length"], g["main"], g.get("tail", 0)

        # ---- ground truth: a StringGeometry built from the preset ----
        geom = StringGeometry(length=length_m, tail=tail, main=main)
        correct_dx = geom.dx()  # length / p_main()

        # ---- what the UI `string` GET serializer reports as `length` ----
        # PhysicalParameters.pack(): param_dict['length'] = self.geometry.p_main()
        # The `string`/`physics` GET branch does NOT apply the *dx correction
        # (only the `combined` branch does). So the UI receives & displays:
        ui_length = geom.p_main()  # == main, the block count

        # ---- what the granular setter does with the UI's value on a restore /
        # an edit: update_pitch_physical_params_GRANULAR ->
        #   pitch.geometry.set_length(ui_length); params['dx'] = geometry.dx()
        edited = StringGeometry(length=ui_length, tail=tail, main=main)
        edited.set_length(ui_length)
        dx_after_ui_edit = edited.dx()  # ui_length / main

        err = dx_after_ui_edit / correct_dx if correct_dx else float("inf")
        worst = max(worst, err)

        if ip in (21, 40, 57, 60, 84, 96, 100, 104, 108):
            print(f"{ip:>5} | {length_m:>14.4f} | {main:>9} | "
                  f"{correct_dx:>13.6f} | {ui_length:>15} | "
                  f"{dx_after_ui_edit:>16.6f} | {err:>10.1f}x")

    print("-" * 110)
    print(f"\nWorst dx inflation across all 88 piano pitches: {worst:.1f}x")
    print("\nMechanism: the UI displays `length` = block count (geometry.main),")
    print("because the `string` GET branch omits the *dx correction that the")
    print("`combined` branch applies. When the user edits OR restores `length`,")
    print("that block count is fed to geometry.set_length() and dx = blockcount/main")
    print("= ~1.0 m, vs the true dx of ~0.01 m. coeff_bending proportional to 1/dx^4")
    print("=> the FDTD coefficient is wrong by ~(error)^4. That is the regression.")
    print("\nNote: dx error == main/length_m, so SHORT treble strings (small")
    print("length_m, e.g. pitch 96 length~0.085 m) get the LARGEST error.")


if __name__ == "__main__":
    main()
