# dev-fd69 session log: roving piezos, placement 1 (2026-10-13)

**Trigger:** the user said on Telegram, 2026-10-13 12:33 UTC: "Now the new set of three piezos is connected, go ahead with new measurement."

**Plan followed:** E9 from the [2026-10-12 report §6.2](../report-mode-discovery-2026-10-12.md) ("more sensors or a roving sensor grid"). An earlier session today (scripts in `D:\modal_measurements\rig_checks\`, not committed until now) prepared the rig and the procedure:

- **Rewired rig.** In 1–4 now carry the **coil currents** of exciters Out 1–4. This is the E8 force reference: the current-referenced FRFs cancel interface latency and drive drift. In 5–7 carry **3 roving piezos**. The loopback is not used.
- Runs: `20261013T134636-linearity`, `T135846-frf4ref` (4 references, V and I), `T140346-drivingpoint` (driving-point impedance), `T142616-gaincheck`.
- `rove_capture.py` / `rove_analyse.py`: one placement per call, then stitching plus 4-reference PolyMAX. The analysis is current-referenced, excludes the 50/100/150 Hz hum lines, runs up to 1.1 kHz, and reports cross-exciter MAC and AutoMAC.
- Placement 0 is the "experiment 1 piezo positions", taken from `frf4ref`.

This session ran the user's new piezo set as **placement 1**. The two scripts are now committed as `diagnostics/dev-fd69-rove-{capture,analyse}-2026-10-13.py`. The analysis script gained a `--drop` option, which leaves out named piezo points (e.g. `P01.In5`).

## Step 1: stack and rig probe

- Ports 3000/3001/5000/5001 were all down. The backend was started from the main `PianoidCore` checkout (`dev`, with the `/audio/session` endpoint) as a detached hidden process, then `/load_preset` BaselinePreset1 was loaded with `audio_driver_type` 4.
- `GET /audio/devices`: UMC ASIO Driver, 48 kHz / 64, 18 in / 20 out, reported round trip 304.
- **Probe** (`diagnostics/dev-fd69-rig-probe-2026-10-13.py`, `D:\modal_measurements\rig_checks\20261013T161056-probe3piezo`). Inputs: every ASIO input except In 8. Signal: 8 s ESS on each exciter at −30 dBFS, plus a silence record. 0 xruns.

| Input | Role | Noise rms | Probe result |
|---|---|---|---|
| In 1–4 | coil currents I1–I4 | −85 / −99 / −103 / −106 dBFS | Own exciter IR SNR 49–72 dB, arrival 0–1 sample after the round trip (electrical). Healthy. |
| **In 5** | piezo A | −83.6 dBFS (normal) | **About 30 dB below In 6/7 in every band**: SNR 24–35 (<200 Hz), 32–40 (200 Hz–1 kHz), 35–47 (1–8 kHz) dB. Sweep peak −64.6 dBFS. At placement 0, In 5 peaked at **−13.7 dBFS**. |
| In 6 | piezo B | −80.4 dBFS | SNR 55–65 / 65–72 / 71–78 / 67–75 dB. Healthy. |
| In 7 | piezo C | −79.3 dBFS | SNR 52–63 / 66–77 / 70–82 / 67–79 dB. Healthy. |
| SPDIF, ADAT 1–8 | — | digital zero | Nothing connected. |

**In 5 diagnosis.** The noise floor is unchanged from placement 0 (−83.5 vs −81.3 dBFS), so the cable and preamp are alive and the gain is probably unchanged. The signal, however, is about 50 dB down and flat across frequency. That points at the piezo element itself: not bonded to the board, a broken lead, or a shorted element. This needs the user's hands.

## Step 2: placement 1 capture

Command: `rove_capture.py --placement 1`. Per exciter, 3 × ESS 20 s, 20 Hz–2 kHz. Levels: Out 2 at −36 dBFS, the others at −30 dBFS. 286 s, 0 xruns. Data: `D:\modal_measurements\rig_checks\rove-20261013\placement_01\` (`frf.npz`, `placement.json`, `sessions\`). No board coordinates were given.

QC:

- **Rig stable vs placement 0.** Own coil admittance is within 0.02 dB / 0.0°. Worst cross-coil difference is 0.16 dB. No clipping (max peak −14.0 dBFS).
- **Repeat SNR <200 Hz / 200 Hz–1 kHz, min over exciters:** In 5 **15** / 30 dB, which **fails the 20 dB gate**. In 6 41 / 51 dB. In 7 39 / 54 dB. Placement 0 was 42–53 dB for all three piezos.
- 50 Hz hum is 48–49 dB above the floor on the piezos, the same as placement 0.

## Step 3: analysis (current-referenced PolyMAX, 25 Hz–1.1 kHz)

The three runs below are all `rove_analyse.py` output under `D:\modal_measurements\rig_checks\rove-20261013\`. Placement 0 alone is the earlier session's `analysis_validation_p0`.

| Set | Points (piezo + coils) | Modes <200 / 200–1k | Median ζ 150–1k | <200 Hz median cross-exciter pair MAC | Chance (median / p90) | AutoMAC off-diagonal <200 Hz (median / p95) |
|---|---|---|---|---|---|---|
| P0 only | 3 + 2 per pair | 15 / 33 | 1.66 % | 0.728 | 0.143 / 0.556 | 0.329 / **0.919** |
| P0 + P1 (all) | 6 + 2 | 15 / 37 | 1.62 % | 0.643 | 0.097 / 0.387 | 0.176 / 0.664 |
| **P0 + P1, P1-In 5 dropped** | 5 + 2 | 16 / 39 | 1.67 % | 0.572 | 0.102 / 0.416 | 0.144 / **0.588** |
| P1 only, In 5 dropped | 2 + 2 | 11 / 27 | 1.67 % | 0.703 | 0.225 / 0.738 | 0.64 / 0.981 |

**Reading:**

1. **Adding the second placement makes the shapes separable.** With P0 alone, the <200 Hz AutoMAC p95 was 0.92, so several distinct modes looked the same on 3 points. With 5 points the p95 is 0.59, and the median falls to 0.14. This is the effect E9 predicted.
2. **Cross-exciter agreement over the larger point set is not yet better than chance by a wider margin.** The pair MAC drops from 0.73 to 0.57–0.64, while chance falls from 0.14/0.56 to 0.10/0.39–0.42. Only 32.6 Hz (all 6 pairs ≥ 0.9) and 67.3 Hz (participation-gated) pass in the 5-point set. With 3 + 2 points the agreement was partly a low-dimension artefact. The <200 Hz modes that look consistent across both sets are 32.6, 35.7, 58.5/62.5, 67.4, 76.2, 94.5, 107, 109.9, 117–118.5, 133.1, 140.9, 154.5, 159.7, 174.6 and 183/190 Hz.
3. Against the 2026-10-12 cross-exciter consensus (33.0, 57.9/59.1, 67.8, 81.4 and 118.3 Hz, 7 fixed piezos, stepped-sine with local multi-mode fits):
   - 33, 58–59, 67.5 and 117–118 Hz are found again.
   - 81.4 Hz has no counterpart here. The nearest poles are 76.2 and 85.6 Hz.
   - The damping is consistent with the appropriated free decays (median 1.6 %).
4. Placement 1 alone is too small (2 piezo points) to judge. Its chance p90 is 0.74.
5. **Next:** repair or re-seat the In 5 piezo, then recapture as a new placement. The analysis gets its strength from the number of good piezo points, so each placement should add 3 healthy ones. Board coordinates for placement 0, placement 1 and the exciters (`--set-coords`, `--rig-coords`) would turn the bar plots into board maps.

Figures (5-point set, P1-In 5 dropped):

![AutoMAC P0+P1](dev-fd69-2026-10-13-rove-p01-automac.png)
![AutoMAC P0 only](dev-fd69-2026-10-13-rove-p0-automac.png)
![Cross-exciter MAC P0+P1](dev-fd69-2026-10-13-rove-p01-cross_exciter_mac.png)
![Consensus shapes P0+P1](dev-fd69-2026-10-13-rove-p01-shapes_1.png)

## Cleanup

The backend started for this session (PID 10320 and its children) was stopped afterwards. Ports 3000/3001/5000/5001 are free again, as they were at the start. The modal adapter (:5001) was not used.
