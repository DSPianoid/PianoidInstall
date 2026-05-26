"""
rev-0a12: prove the gate can live ENTIRELY host-side. Compare, per real string of a loaded preset:
  - the KERNEL-reported per-string ratio (getStringStabilityRatios — the swept max|g| from device)
  - a HOST closed-form computation of the SAME quantity from PianoidBasic physics (no GPU):
      * swept max|g| (host mirror of cflMaxAmplification)
      * closed-form Jury verdict
      * the two-sided box on (coeff_T, coeff_B) with HF-damping correction
If host == kernel for every string, the reject decision needs NO kernel involvement: compute it in
parameter_manager BEFORE the GPU upload, reject the edit at the source. Removes the shadow buffer,
the per-string flag, AND the host/engine flag-polling race (the 3-bug machinery).

Run: cd PianoidCore && unset VIRTUAL_ENV && ./.venv/Scripts/python.exe ../docs/development/diagnostics/dev-cfl-rev0a12-host-vs-kernel.py
"""
import os, sys, math
import numpy as np
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
MW = os.path.join(REPO, "PianoidCore", "pianoid_middleware")
sys.path.insert(0, MW); sys.path.insert(0, os.path.join(REPO, "PianoidCore"))
import pianoidCuda  # noqa
SR, SPC = 48000, 64
THp = np.linspace(0, math.pi, 4001)[1:]; COSp, COS2p = np.cos(THp), np.cos(2*THp)


def host_maxg(T, B, dec=0.0, cfd=0.0):
    di = 1.0/(1.0+dec); s0=(2+12*B-2*T)*di; s1=(T-8*B)*di; s2=(2*B)*di; sb=(dec-1)*di
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp); B0 = sb + 2*cfd*(1-COSp)
    disc = A*A+4*B0
    mag = np.where(disc>=0, np.maximum(np.abs((A+np.sqrt(np.abs(disc)))*0.5), np.abs((A-np.sqrt(np.abs(disc)))*0.5)), np.sqrt(np.abs(B0)))
    return float(np.max(mag))


def host_jury(T, B, dec=0.0, cfd=0.0, eps=1e-9):
    di = 1.0/(1.0+dec); s0=(2+12*B-2*T)*di; s1=(T-8*B)*di; s2=(2*B)*di; sb=(dec-1)*di
    A = s0 + 2*s1*COSp + 2*s2*COS2p - 2*cfd*(1-COSp); B0 = sb + 2*cfd*(1-COSp)
    return bool(np.all(np.abs(B0)<=1+eps) and np.all(np.abs(A)<=1-B0+eps))


def main():
    os.chdir(MW)
    from pianoid import initialize
    from tests.conftest import get_preset_path
    si = 4
    pw = initialize(get_preset_path("Preset_test5.json"), filterlen=48*128*3, string_iteration=si,
                    array_size=384, sample_rate=SR, samples_in_cycle=SPC, buffer_size=4,
                    max_volume=5e18, audio_on=False, audio_driver_type=0)
    cpp = pw.pianoid
    cpp.waitForParameterUpdate(); cpp.runSynthesisKernel(); cpp.waitForParameterUpdate()
    kr = list(cpp.getStringStabilityRatios())
    dt = 1.0/(SR*si)
    print(f"{'pitch':>6}{'str':>5}{'coeff_T':>11}{'coeff_B':>12}{'kernel_ratio':>13}{'host_maxg':>11}"
          f"{'|diff|':>10}{'jury':>6}")
    worst = 0.0
    for pid, pitch in sorted(pw.sm.pitches.items()):
        for sid in pitch.get_strings():
            si_idx = pw.sm.string_index.index(sid)
            p = pitch.physics
            dx = p.geometry.dx()
            T = (p.tension/p.rho)*dt**2/dx**2
            B = (math.pi*p.r**4/(4*p.rho))*p.jung*dt**2/dx**4
            isOut = pitch.pitch >= 128
            hk = host_maxg(T, B)
            jk = host_jury(T, B)
            krv = kr[si_idx] if si_idx < len(kr) else float('nan')
            # sound strings: kernel reports 1.0 sentinel (gate skipped). host would too if we skip outer_sound>0.
            d = abs(krv - (1.0 if isOut else hk))
            worst = max(worst, d if not isOut else 0.0)
            if pid <= 30 or isOut or d > 1e-3:
                tag = " (OUTPUT/sentinel)" if isOut else ""
                print(f"{pid:>6}{si_idx:>5}{T:>11.5f}{B:>12.3e}{krv:>13.6f}{hk:>11.6f}{d:>10.2e}{str(jk):>6}{tag}")
    print(f"\nWORST |kernel_ratio - host_maxg| over PHYSICAL strings = {worst:.3e}")
    print("=> host closed-form == kernel device value" if worst < 1e-3 else "=> MISMATCH, investigate")
    try: cpp.shutdownGpu()
    except Exception: pass


if __name__ == "__main__":
    main()
