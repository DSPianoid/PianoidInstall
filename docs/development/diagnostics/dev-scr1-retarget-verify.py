"""dev-scr1 — live end-to-end verify of the retargeted calibration write (listen_to_modes=0).

1. Snapshot feedback/output (channels x modes) — record mode m's column old_col + other modes.
2. Calibrate mode m -> x* (+ empirical noise floor / mode SNR).
3. Confirm -> writes new_col = x* * (A/mean(x*)) into feedback/output column m, average preserved.
4. Read back: column m == new_col (write reached the kernel deck), mean(new_col)==A_before,
   balance == x* (relative + signs), and OTHER mode columns untouched.
Reports the noise floor + mode SNR margin. Measurement only beyond the single approved write.
"""
import json
import sys
import urllib.request

import numpy as np

BASE = "http://127.0.0.1:5000"


def get(ep):
    with urllib.request.urlopen(f"{BASE}/get_parameter/{ep}", timeout=8) as r:
        return json.loads(r.read().decode())


def post(ep, body, timeout=240):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}/{ep}", data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def column(fb, mode_no):
    keys = sorted(int(k) for k in fb if k != "_meta")
    return np.array([fb[str(k)][mode_no] for k in keys]), keys


def main():
    m = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    fb0 = get("feedback/output")
    old_col, chans = column(fb0, m)
    A_before = float(np.mean(old_col))
    other = 1 if m != 1 else 3
    other_col0, _ = column(fb0, other)
    print(f"channels(output pitches)={chans}")
    print(f"mode {m} old_col={np.round(old_col,3)}  A(before)=mean={A_before:.4f}")

    rv = post("modal/calibrate_sound_channel", {"mode_no": m}).get("review", {})
    xstar = np.array(rv["row_normalized"], float)
    print(f"\ncalibration: x*={np.round(xstar,4)}  ref=ch{rv['reference']}  "
          f"noise_floor={rv['noise_floor']:.3e}  mode_snr={rv['mode_snr']:.1f}  "
          f"noise_level={rv['noise_level']}  repeats={rv['noise_repeats']}")
    print(f"per_channel_snr={np.round(rv['per_channel_snr'],1)}")

    if rv["noise_level"]:
        print("MODE AT NOISE LEVEL -> would not write. Pick a better-coupled mode.")
        return

    res = post("modal/calibrate_sound_channel/confirm", {"mode_no": m, "row": xstar.tolist()})
    print(f"\nconfirm status={res.get('status')}  flipped={res.get('x_star_flipped')}  "
          f"scale={res.get('scale'):.4g}")
    new_col_reported = np.array(res["new_col"], float)

    fb1 = get("feedback/output")
    new_col, _ = column(fb1, m)
    other_col1, _ = column(fb1, other)
    A_after = float(np.mean(new_col))

    print(f"\n--- READBACK (write reached the kernel deck) ---")
    print(f"mode {m} new_col(readback)={np.round(new_col,3)}")
    print(f"  == reported new_col?        {np.allclose(new_col, new_col_reported, atol=1e-6)}")
    print(f"  average preserved: A_before={A_before:.4f} A_after={A_after:.4f} "
          f"equal={np.isclose(A_before, A_after, atol=1e-4)}")
    # balance: new_col normalized (max) vs x* (allow global sign flip)
    nn = new_col / np.max(np.abs(new_col))
    bal_ok = np.allclose(nn, xstar, atol=0.02) or np.allclose(nn, -xstar, atol=0.02)
    print(f"  balance == x* (max-norm, up to global sign): {bal_ok}")
    print(f"    new_col max-norm={np.round(nn,3)}   x*={np.round(xstar,3)}")
    print(f"  NOT blown up / zeroed: |new_col| range [{np.min(np.abs(new_col)):.3f}, "
          f"{np.max(np.abs(new_col)):.3f}] vs old [{np.min(np.abs(old_col)):.3f}, "
          f"{np.max(np.abs(old_col)):.3f}]")
    print(f"  OTHER mode {other} column untouched: {np.allclose(other_col0, other_col1, atol=1e-6)}")


if __name__ == "__main__":
    main()
