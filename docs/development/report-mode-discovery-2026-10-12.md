# Soundboard mode discovery with attached exciters: progress report (2026-10-12)

**Scope:** what we did on 2026-10-11 and 2026-10-12 to identify the modes of the rig soundboard with 4 attached voice-coil exciters and 7 piezo contact sensors. The report covers the theory, compares the identification methods (ours and Dima's), and gives the preliminary results. No new rig runs were made for this report. Every number comes from saved data and analysis logs (sources in Appendix A).

**Work items:** dev-69fd (swept discovery), dev-fd69 (PolyMAX, chirp-ESPRIT, appropriation, rig checks, stepped sine E1–E3), dev-1b6c / dev-4284 (ASIO measurement session). Code is on Core `feature/dev-fd69-modal-methods` (unmerged).

---

## 1. Summary

**Key findings**

1. **The measurement chain is sound.** The new ASIO measurement session plays and records sample-locked: loopback onset is the same in every session (spread 0) and there were 0 xruns in more than 100 sessions. Repeat FRFs agree to γ² ≥ 0.9996 (42–48 dB repeat SNR). Interface crosstalk is −63…−71 dB. The board behaves as a linear time-invariant (LTI) system at our levels.
2. **One exciter is nonlinear.** Out 3 has 2nd-order distortion: H2 is −23 dB at −30 dBFS and grows 6 dB per 6 dB of drive. Swept-sine and chirp deconvolution remove it from the linear FRF. Keep Out 3 at ≤ −30 dBFS and check its mounting.
3. **Damping is settled at ζ ≈ 1.6 % (median, range 1.1–2.5 %) between 150 Hz and 1 kHz.** The source is a model-free free decay after multi-exciter force appropriation. PolyMAX matches it (ratio 1.01). The swept rational fit reads about 30 % high. Per-exciter ESPRIT is erratic and reads low (down to 0.1–0.2 %).
4. **Methods that use all exciters at once work on this board. Per-exciter ESPRIT does not.** The swept joint fit and PolyMAX are independent algorithms. On the same FRFs they agree on 39 modes (chance: 19), with shape MAC 0.81 below 250 Hz. ESPRIT agrees with the other methods, and with itself across exciters, only at chance level, whether it runs on impulse or chirp IRs.
5. **Below 200 Hz there are about 22 modes.** Five agree across all 4 exciters at MAC ≥ 0.9: 33.0, 57.9/59.1, 67.8, 81.4 and 118.3 Hz. Six more nearly agree. The raw response at each exciter's resonance gives a median pair MAC of only **0.31**. After a local multi-mode fit with residual terms the median is **0.90**. The main cause is **modal overlap**: the overlap factor has a median of 1.9, so at its own resonance each exciter drives a different *mixture* of modes. The second cause is clusters of close modes that 4 drive points × 7 sensors cannot separate. Nonlinearity, drive level, near-field sensors and a faulty exciter were tested and ruled out.
6. **Usable band today is about 30 Hz–1 kHz, with about 55–65 modes.** 1–2 kHz is marginal. Above 2 kHz the 4 × 7 data do not support a consistent modal model, because no pole is stable in its participation vector.

**Confirmed vs open**

| Confirmed | Open |
|---|---|
| Chain timing, linearity (except Out 3 H2), repeatability, crosstalk | Physical cause of Out 3's distortion (mechanical check) |
| ζ ≈ 1.6 % (appropriated decay); PolyMAX ζ is right | Absolute modal mass (1/m) needs a **force (current) reference** |
| 5 + 6 modes below 200 Hz that all exciters agree on (or nearly agree on) | ~11 modes in close clusters below 200 Hz. They need **more sensors / a roving grid / a hammer** |
| Method ranking: PolyMAX (f, ζ, shapes) + swept (cross-check) ≫ per-exciter ESPRIT | Mapping board modes to engine modes (decka / actuator feed) |
| 50 Hz mains hum shows up as a ζ 0.36 % "mode" | Hum notch / exclusion in the identification code |

---

## 2. Setup

### 2.1 Rig

| Item | Configuration |
|---|---|
| Interface | Behringer UMC1820, **ASIO**, 48 kHz, buffer 64; all channels `ASIOSTInt32LSB` |
| Exciters | 4 voice-coil exciters on **Out 1–4**, attached to the board, each through its own amplifier channel |
| Sensors | 7 piezoelectric contact sensors on **In 1–7** |
| Loopback | **Out 5 → In 8**, electrical, carries only a timing marker |
| Levels | −36…−24 dBFS sine/sweep peak (hard ceiling −12 dBFS in code; Out 3 kept at −30 dBFS) |
| Noise floor | −78…−87 dBFS rms per sensor; mode SNR 18–88 dB at −30 dBFS |

The physical geometry (sensor and exciter positions) is not documented. We inferred the sensor nearest to each exciter from the earliest acoustic arrival: Out 1 → In 1, Out 2 → In 5/6, Out 3 → In 3, Out 4 → In 1/2.

### 2.2 The ASIO measurement session (new, 2026-10-11)

The I/O test on 2026-10-11 ran through the old SDL3 / WASAPI recorder (`sdl_audio_core`) and found structural defects:

- no per-output-channel drive (WASAPI exposes stereo pair endpoints);
- half-speed playback on stereo endpoints;
- device ids that change between sessions;
- up to one buffer of jitter between output and input.

All measurement I/O therefore moved to a **sample-locked ASIO session inside the engine's own ASIO host** (`POST /audio/session` on `:5000`; dev-1b6c, dev-4284). The session works as follows:

- The play matrix and capture **arm on the same `bufferSwitch`**, so output and input share one sample clock and one start sample.
- Synthesis is paused for the session, so measurement and engine do not fight over Out 1–4.
- Each session emits a **loopback marker** on Out 5 → In 8. This gives the measured round trip of every capture, and the capture is aligned on it.
- **Measured round trip: 334 frames** in every session on 2026-10-12 (328 frames in the 2026-10-11 runs; spread 0 within each day). The driver reports **304 frames** (`ASIOGetLatencies` in 136 + out 168). The driver under-reports by about 30 frames (0.6 ms), so we use the measured value.
- The drive is **not** mirrored onto the loopback output. A mirrored drive leaks into In 5–7 at only about 33–42 dB below it.
- In the Phase-0 probe, the session also found and fixed a **capture-scale bug** (1/2²³ instead of 1/2³¹, a ×256 error).

### 2.3 Levels and exciter linearity

Figure 6 shows each exciter driven with an 8 s ESS at −36, −30 and −24 dBFS.

- The **linear** FRFs scale within 0.1–0.5 dB. The worst case is Out 1 below 250 Hz at −36 dBFS, which is limited by SNR.
- **Out 3** has H2 at **−29.5, −22.9 and −16.8 dB** for the three levels (7 % at −30 dBFS, 14 % at −24 dBFS). That is classic 2nd-order distortion: it grows 1 dB per dB of drive.
- Out 2 shows the same pattern about 17 dB lower. Out 1 and Out 4 are clean (H2 ≤ −44 dB).
- ESS and chirp deconvolution push the harmonics to negative time, so the linear FRF stays clean. An impulse train cannot do this.

![Per-exciter linearity](report-mode-discovery-2026-10-12/fig06_linearity_per_exciter.png)

*Figure 6. Left: H2 relative to the linear IR vs drive level (median over the 7 sensors). Right: linear FRF change for +6 dB of drive.*

---

## 3. Theoretical base

### 3.1 Modal model of the soundboard

For a linear, lightly damped structure with viscous (or proportional) damping, the FRF from exciter *e* to sensor *k* is a sum over modes:

```
H_ke(ω) = Σ_m  φ_k,m · φ_e,m / ( m_m · (ω_m² − ω² + 2 j ζ_m ω_m ω) )
        ≈ Σ_m [ R_m,ke / (jω − λ_m)  +  R*_m,ke / (jω − λ*_m) ]
λ_m = −ζ_m ω_m + j ω_m √(1 − ζ_m²)
```

Each mode is described by four quantities:

- the pole λ_m, which gives f_m and ζ_m;
- the mode shape φ_m at the sensors;
- its value at the drive points φ_e,m (the **participation**);
- the modal mass m_m.

With K sensors and E exciters the residue matrix R_m = φ_m · L_mᵀ / m_m is K × E and **rank 1**. All exciters see the same shape and differ only by a scalar. Our identification rests on this property. Every multi-reference method imposes it: the swept joint fit, PolyMAX, and Dima's SVD.

**Reciprocity.** H_ke = H_ek. It would let us check a drive point and calibrate the scale. On this rig it cannot be used: the piezo sensors cannot drive, and the voice coils are not read back as sensors.

### 3.2 MAC: how we compare shapes

```
MAC(a, b) = |aᴴ b|² / ( (aᴴ a)(bᴴ b) )        ∈ [0, 1]
```

- MAC is 1 for parallel vectors, whatever their scale or common phase.
- **Chance level depends on the dimension.** For two random complex 7-vectors the expected MAC is about 1/7 ≈ 0.14. We measure 0.12–0.16 on shuffled pairs. A MAC of 0.3 between 7-sensor shapes is therefore **not** weak agreement. It is near chance.
- Distinct modes measured with only 7 DOF can also have high MAC: 7 sensors cannot make 20 or more modes mutually orthogonal (Figure 3).
- We call a mode **agreed** across exciters when **all 6 exciter pairs reach MAC ≥ 0.9**.

### 3.3 Modal overlap: why single-input estimates depend on the exciter

The modal overlap factor compares the half-power bandwidth to the mode spacing:

- Statistical form: M = η · f · n(f), where η = 2ζ is the loss factor and n(f) the modal density.
- Local form, per mode: M_m = 2 ζ_m f_m / Δf_m, where Δf_m is the distance to the nearest neighbour.

When M ≳ 1, every frequency line is a superposition of several modes with comparable weights. The response at exciter *e*'s resonance is then

```
y(ω_peak,e) ≈ Σ_m  φ_m · (L_m,e / m_m) · g_m(ω_peak,e),   g_m = 1/(ω_m² − ω² + 2jζ_m ω_m ω)
```

The mixing weights L_m,e depend on where exciter *e* sits on each neighbouring mode. Each exciter therefore "sees" a different blend, and even its peak frequency shifts. Below 200 Hz we found a per-exciter resonance spread of 1.7 % (median). A single-input peak-picking or single-reference fit then returns an **exciter-dependent pseudo-mode**. Only a model that fits all overlapping poles together, with a background term for out-of-band modes, can recover the common φ_m. That is exactly the raw 0.31 → corrected 0.90 MAC jump in §5.7.

### 3.4 CMIF / SVD rank test

At each frequency line we take the SVD of the K × E FRF matrix: H(ω) = U Σ Vᴴ.

- The **CMIF** σ1(ω) peaks at modes. U[:,0] is the operating shape there and V[:,0] the participation vector.
- **σ2/σ1 is a rank test.** If one mode dominates a line, σ2 ≪ σ1. A high σ2/σ1 at a peak means several modes are active, or the data do not follow a low-rank modal sum.
- On this board σ2/σ1 at the CMIF peaks is 0.31–0.36 below 250 Hz, 0.38–0.40 at 250–1 kHz, 0.53–0.56 at 1–2 kHz and about 0.50 above. It is the same in all repeats and sweep durations, so it describes the board, not the noise.
- Dima's acceptance rule is σ1/σ2 ≥ 1.35, which is σ2/σ1 ≤ 0.74. That is lenient compared with these values.

### 3.5 Stabilization diagrams

A parametric estimator such as pLSCF / PolyMAX is solved at increasing model orders p:

- **Physical poles** come back at the same f, ζ and participation vector at every order.
- **Mathematical (noise or fit) poles** move around.

A pole is marked stable in f, then in f + ζ, then in f + ζ + participation vector (MPF) against the previous order. Our tolerances are 1 % in f, 10 % in ζ and MAC 0.9 on the MPF. Poles are selected when they are stable across at least 30 % of the orders. The MPF criterion is the strict one. Above 2 kHz the frequencies and damping stabilise but the MPFs do not, which is the same 4 × 7 inconsistency that §3.4 shows.

### 3.6 Force reference vs drive-voltage reference

All our FRFs are referenced to the **digital drive voltage**. The exciter is an electro-mechanical transducer:

```
Z_el(ω) = R + jωL + (Bl)² / Z_mech(ω)          force F = Bl · I
```

Z_mech is the mechanical impedance at the attachment point: the board plus the moving mass of the exciter. A voltage reference therefore has three effects:

- **Different scale and phase per exciter column.** MAC does not see these, but absolute 1/m and cross-exciter participation comparisons do.
- **Back-EMF damping.** With a low-impedance amplifier, the motional current (Bl)²/R adds damping to every mode the exciter moves, and the amount differs per exciter. Part of the identified ζ belongs to the coupled board + exciter system.
- **Mass loading.** The attached exciters shift the frequencies of the modes they sit on. The board we identify is "the board with 4 exciters attached".

Dima measures the drive **current** with a CT. That is the force reference, up to Bl. We plan to do the same with a second UMC1820 over ADAT. It fixes scale, phase and per-exciter damping attribution. It does **not** change shape MAC.

### 3.7 Force appropriation (phase-resonance) and free decay

With E exciters driven at one frequency, the **phase-resonance criterion** (Asher / MMIF) says a pure normal mode is excited when the response is in quadrature with the force. We implement the energy form: choose the exciter weights w that maximise the target mode's share of modal energy,

```
P_m(w) = |g_m|² ‖R_m w‖² / Σ_r |g_r|² ‖R_r w‖²,    g_r = 1/(jω_m − λ_r)
```

This is a generalized Rayleigh quotient, solved as the top generalized eigenvector. The weights can be real and signed (Dima's form), or complex. Four exciters can suppress at most three neighbours.

After the appropriated dwell the drive stops. The free decay is then modal-filtered and demodulated, which gives **f and ζ without a model**: a straight-line fit of log-amplitude and phase. The envelope residual flags any neighbour that is left over. This is the reference that settled the damping.

### 3.8 What the literature leads us to expect

From `piano-soundboard-mode-count-literature-2026-10-10.md`:

- **Loss factor** η ≈ 2 % ± 1 % (ζ ≈ 1 %), roughly flat up to several kHz. Ege 2013 reports η 1–3 % below 1.2 kHz on an upright. Our ζ ≈ 1.6 % (η ≈ 3.2 %) is at the upper end, which fits extra damping from the attached exciters.
- **Two kinds of modal density.** The *global* density counts every mode (FEM). For an upright it is about 0.06 modes/Hz up to 1 kHz; for a grand 0.1–0.24. The *apparent* (local) density is what one point sees. Above about 1.1 kHz modes localise between the ribs, so the apparent density falls to 0.01–0.02 modes/Hz.
- **Modal overlap** is above 30 % above 150 Hz and about 100 % at 1 kHz (upright). Above 0.5–1 kHz single modes cannot be resolved, and only the statistics of the response matter.
- **Our board fits this picture.** About 22 modes below 200 Hz is about 0.13 modes/Hz. ζ ≈ 1.5–3 % from the stepped fits gives local overlap factors of about 2. A few sensors cannot see a consistent modal model above about 2 kHz, which matches localised modes.

---

## 4. Approaches and algorithms compared

| | Excitation | Reference | Multi-exciter handling | Damping estimate | Overlap handling | Speed (4 exc.) | Verdict on this board |
|---|---|---|---|---|---|---|---|
| **(a) Impulse-train ESPRIT** (existing pipeline) | 100 ms pulse train, 5 averages per exciter | drive (digital) | none: one ESPRIT per exciter path | from poles; biased **low** (median 0.77 %) | none; ~130 poles per path | ~4 min + ESPRIT 1 min | **Not usable**: cross-exciter agreement at chance; harmonics not separated |
| **(b) Chirp → IR → ESPRIT** | ESS, deconvolved to 0.85–2 s IRs | drive | none (per exciter) | biased low (0.6–1.0 %; 0.2–0.35 % below 200 Hz) | none | ~4 min + 1 min | **Not usable** for modes: repeatable per exciter (MAC 0.98) but cross-exciter at chance |
| **(c) Swept-sine peak + joint fit** (ours, dev-69fd) | coarse ESS 20 s + fine linear sweeps per zone | drive | **joint**: poles shared by all exciters, polyreference rational fit per zone | from the fit; about **30 % high** | context poles, σ2 extra poles; misses pairs closer than ½ B | ~8 min | **Good** for f and shapes below 1 kHz; independent cross-check |
| **(d) PolyMAX** (pLSCF + LSFD, ours) | any FRF matrix (60 s ESS used) | drive | **multi-reference**: MPF in the stability test | **right** (ratio 1.01 to the appropriated decay) | resolves overlapped modes in simulation (22/22 at overlap 1.5–3) | seconds on an existing FRF | **Best**: primary f, ζ, shapes ≤ 2 kHz; none above |
| **(e) Stepped-sine lock-in + local multi-mode fit** (E1/E3, ours) | phase-continuous steps, ≥ 10 τ settle, 50-cycle lock-in | drive (current possible) | per exciter, then compared | per-exciter fit (1.5–3 %) | free poles + constant / jω background terms | **slow**: 7 min per exciter < 200 Hz | **Diagnostic**: shows which modes all exciters agree on |
| **(f) Force appropriation + free decay** (ours) | all 4 exciters at once, weighted sine dwell, then silence | drive (current possible) | the solve is multi-exciter | **model-free** decay, the **reference** | suppresses up to 3 neighbours; envelope residual flags failures | ~20 s per mode | **Damping reference**; per-mode actuator weights (decka form) |
| **(g) Dima's `adjust_tr_10e`** | stepped sine lock-in 100–4000 Hz, 72 pt/oct (≤ 2 Hz), 200 ms settle, ≥ 20 cycles | **CT current** (force) | CMIF on the 6 × A matrix, merge peaks within 0.6 %; real-weight solve max \|uᴴAa\|² | **none** | σ1/σ2 ≥ 1.35, MAC(u, f ± 0.15 %) ≥ 0.8; keeps u₁ only | ~12 min per actuator, ~1.5 h for 7 | **Strong reference and solve**; settle too short < 250 Hz; no ζ; close pairs lost |

**(a) / (b) ESPRIT.** ESPRIT fits each sensor-path IR with a sum of damped exponentials. The fits are very repeatable on the same data: same exciter across runs, f 0.03–0.15 % and MAC ≈ 1.0. Across exciters, however, its ~130 poles per path agree only at chance:

- matched pairs 32–44 vs chance 30–37;
- shape MAC 0.11–0.28;
- 15–21 of ~330 modes found by all 4 exciters.

When modes are heavily overlapped and about 2–3 % damped, a single-reference subspace fit describes each *path* with many lightly damped poles. It does not describe the shared modes. Longer IRs (2 s, a dedicated band set below 200 Hz) give shapes that are clearly related to the stepped-sine shapes (MAC 0.61 vs chance 0.14), but damping stays 5–10× too low and the exciters still disagree with each other.

**(c) Swept-sine discovery** (dev-69fd). The coarse ESS gives the FRF on a 0.25 Hz grid. CMIF peaks (prominence ≥ 3 dB, SNR ≥ 10 dB, shape stable over the peak) define zones. Fine linear sweeps per zone are followed by a polyreference rational fit (variable projection over f and log ζ, linear residues, constant + jω background). In simulation it finds 38 of 42 modes in a dense random plant. The misses are always pairs closer than one half-power bandwidth. On the rig its ζ is about 30 % high, because it partly absorbs unmodelled neighbours.

**(d) PolyMAX** (dev-fd69). This is a poly-reference least-squares complex frequency-domain estimator (right matrix-fraction model, noise-weighted). It runs a stabilization diagram per band, selects poles automatically with the MPF criterion, merges duplicates, and gets residues from LSFD. On a synthetic plant with 22 modes at overlap 1.5–3 (where the CMIF shows ONE peak) it recovers 22/22 modes with f error < 0.5 % and no spurious modes. The swept peak method finds only 0–5 of them there. On the rig its consistency checks are:

- leave-one-exciter-out: 40–49 modes match vs 14–17 by chance;
- run to run: df 0.15 %, dζ 4.6 %, MAC 0.82.

**(e) Stepped sine + local multi-mode fit.** This is the slow, model-light check. Each exciter alone steps through ±3 B around every mode. A local fit then shares free poles across the 7 sensors and adds background terms. The residue of the target pole is the *residual-corrected* shape. This is what turned "the exciters disagree" into "the exciters agree once neighbours are modelled" (§5.7).

**(f) Appropriation.** See §3.7. In simulation the decay ζ is within 0.6 % of the truth even when the model's damping is off by ×0.5 or ×2. The best single exciter is biased by ±8 % by beating. On this board, real weights perform as well as complex ones (ζ within 3 %), so the decka form (one real signed weight per exciter per mode) is enough for playback.

**(g) Dima's method** (from `adjust_tr_10e_4khz.py`). It is the closest to ours. He uses a stepped sine with a CT-current reference, finds peaks on the CMIF (local max ≥ 1.45 × floor, fine scan ±2 %), accepts a peak by σ1/σ2 and MAC stability, and solves for real actuator weights that maximise |uᴴAa|² (the same objective as our model-free appropriation, without phase). A live mic-driven refine loop follows. Compared with our data:

- **Strong points:** force reference; fully model-free; directly produces the per-mode actuator drive that the FPGA needs.
- **Settle time:** the constant 200 ms is too short below 250 Hz. At ζ = 1.6 %, τ = 1/(2πζf) is 100 ms at 100 Hz, so 200 ms is only 2 τ (14 % of the transient left). At 50 Hz it is under 1 τ.
- **No damping estimate.**
- **Close modes:** the ±0.15 % MAC test stays inside one peak, and keeping only u₁ per cluster loses close pairs.
- **Current magnitude only:** the conversion ignores phase per actuator.
- **Peak vs natural frequency:** `omega_coef` is the amplitude peak, not the natural frequency.

The shared, unavoidable limit is the same as ours. In an overlapped band, the CMIF peak vector u₁ is a mixture of modes. Our E1/E3 numbers suggest it will reproduce across actuators only for the roughly 5–11 best-isolated low modes.

---

## 5. Results (2026-10-11 and 2026-10-12)

### 5.1 Exciter tone check and I/O test (10-11)

Each exciter was driven with test tones at −30 dBFS. Every output reached all 7 sensors with > 20 dB SNR. Sensor noise floor was −78…−87 dBFS rms. The test also exposed the four SDL/WASAPI defects of §2.2, which led to the ASIO session. Its acceptance run: 4 exciters × 5 measurements, each session driving exactly `[Out k, Out 5]`, loopback onset spread 0, 0 xruns.

### 5.2 First swept run (10-11, `20261011-rig3`)

- 9 sessions in 233 s. The coarse pass gave 23 zones.
- **70 modes from 33 Hz to 6.3 kHz** (20 below 250 Hz, 23 in 250–1 k, 11 in 1–2 k, 14 above).
- ζ median 3.2 %. Fit MAC ≥ 0.966.
- Residue-matrix σ2/σ1 median 0.45.
- Repeatability: f spread 0.15 % (isolated modes 0.002–0.06 %), ζ spread 4.3 %.

### 5.3 Cross-exciter consistency, first analysis (10-11)

Swept independent fits and impulse ESPRIT, per exciter (`D:\scratch\xexc-2026-10-11`):

- **Swept per-exciter fits** agree below 250 Hz: median MAC 0.81, 33 % of clusters ≥ 0.9.
- From 250 Hz up they fall to 0.42 and then 0.23–0.27.
- **ESPRIT** never exceeds chance (MAC 0.13–0.41; 15 of 320 clusters seen by all 4 exciters).

Swept damping was 3.2 % and ESPRIT damping 0.77 %, so the ζ question was opened here.

### 5.4 Rig checks (10-12)

| Check | Result |
|---|---|
| Crosstalk (ESS on the unconnected Out 6) | −63 / −71 / −70 / −69 dB re the Out 3 response, per band: **negligible** |
| Early arrival (exciter-path electrical leak) | no t = 0 component beyond the ringing of the acoustic arrival; ≤ −31…−60 dB upper bound |
| Linearity per exciter | §2.3: linear FRFs within 0.1–0.5 dB; Out 3 H2 −23 dB at −30 dBFS |
| Sweep speed 8 / 30 / 60 s | SNR rises as 10 log T (56→66 dB below 250 Hz); FRFs differ ≤ 0.12 dB; **σ2/σ1 unchanged** (0.35–0.56); PolyMAX 65 / 67 / 69 modes, agreeing like repeats |
| New defaults | coarse ESS **20 s**; fine zones capped at a quasi-stationarity index of 0.05 (≤ 20 s per zone); decay gap 8 τ ≤ 3 s |

A slower sweep buys SNR but does not change what can be identified. The inconsistency belongs to the board and sensor layout, not to the acquisition.

### 5.5 Swept rerun and PolyMAX (10-12)

- **Swept `20261012-rig4b`** (new defaults): 73 modes from 33 Hz to 7.4 kHz (21 / 23 / 13 / 16 per band), median ζ 3.0 %, 491 s. Repeatability over 3 repeats: f spread 0.074 % (median), ζ 7 %.
- **PolyMAX on the 60 s FRF:** 69 modes, all ≤ 2 kHz (Figure 7).
- **Leave-one-exciter-out:** 40–49 modes match (chance 14–17), shape MAC 0.49–0.71.
- **Swept vs PolyMAX:** 39 modes match (chance 19.0). Shape MAC by band: **0.81** below 250 Hz, **0.63** at 250–1 k, 0.27 at 1–2 k.
- **Figure 4** uses a looser frequency gate (within max(ζ, 1 %)). It finds 17 matched pairs below 200 Hz (median MAC 0.71) and 45 below 1 kHz (median MAC 0.75). The diagonal is clearly visible up to 1 kHz.

![CMIF overview](report-mode-discovery-2026-10-12/fig07_cmif_overview.png)

*Figure 7. CMIF (σ1, σ2) of the 60 s ESS FRF, with the 69 PolyMAX modes. Above 2 kHz no pole is stable in its participation vector.*

![Swept vs PolyMAX cross-MAC](report-mode-discovery-2026-10-12/fig04_crossmac_swept_vs_polymax.png)

*Figure 4. Cross-MAC between the swept joint-fit modes and the PolyMAX modes. Left: below 200 Hz (values ≥ 0.8 printed). Right: below 1 kHz. Orange boxes mark frequency-matched pairs. Off-diagonal blocks with high MAC are close modes that 7 sensors cannot make orthogonal.*

### 5.6 Chirp collection end to end, and the damping settled (10-12)

**Chirp collection through the Tunner/REST flow:**

- New Measurement with the chirp default (9.87 s ESS, 1 s IRs): 4 exciters × 5, 20 sessions, 0 xruns.
- Per-measurement harmonic metadata reproduces the linearity test (H2 for Out 1–4: −53.5, −39.7, −23.2, −49.6 dB).
- ESPRIT gives 130–139 modes per exciter, median ζ 0.85–1.0 %.
- Same exciter vs the day before: MAC 0.98, df 0.09 %, so it is repeatable.
- Across exciters it is still at chance.

**Appropriation and free decay** on 13 modes, 76.8–958.5 Hz:

- Complex weights, real weights and the best single exciter were all run.
- 9 decays are clean (envelope residual < 2 dB). 4 beat and are indicative only (76.8, 635.5, 652.9, 958.5 Hz).
- **Appropriated ζ: median 1.58 % (1.1–2.5 %).**

| Method | ζ relative to the appropriated decay (9 clean modes): median (range) |
|---|---|
| appropriated, real weights | 1.00 (0.97–1.03) |
| **PolyMAX** | **1.01** (0.76–1.14) |
| best single exciter | 1.00 (0.86–1.38) |
| swept joint fit | **1.31** (0.87–1.90) |
| chirp-ESPRIT | 0.69 (0.07–1.07) |
| impulse-ESPRIT | 0.79 (0.09–1.57) |

![Damping by method](report-mode-discovery-2026-10-12/fig08_damping_by_method.png)

*Figure 8. Damping ratio by method on the 13 appropriated modes. The model-free appropriated decay (black) is the reference.*

![Cross-method agreement vs chance](report-mode-discovery-2026-10-12/fig09_cross_method_vs_chance.png)

*Figure 9. Number of modes matched between methods, compared with the number expected by chance (2026-10-12 data).*

### 5.7 Below 200 Hz: do the exciters agree? Experiments E1–E3 (10-12)

**Reference list (25 candidates).**

- 20 PolyMAX modes from the 60 s FRF.
- 5 swept-only candidates: 36.2, 47.8, 57.9, 64.7 and 126.9 Hz. The fit gave them ζ 4–19 %. They are entered at a seed ζ of 5 % in the table below.
- **49.9 and 50.1 Hz are excluded:** a ζ 0.36 % "mode" at the mains frequency is **50 Hz hum**. It also enters the joint PolyMAX fit, so the identification code needs a hum notch.
- 57.9 and 59.1 Hz are the same mode (AutoMAC 1.00), so the list holds about **22 distinct physical modes**.

**The experiments.**

- **E1:** each exciter alone, a 173-point stepped sine over ±3 B windows, plus a long dwell at its own resonance. 7 min per exciter, 0 xruns.
- **E2:** a level test on 6 modes at −42, −36 and −30 dBFS.
- **E3:** the analysis.

![Stabilization diagram < 200 Hz](report-mode-discovery-2026-10-12/fig01_stabilization_below_200Hz.png)

*Figure 1. PolyMAX stabilization diagram below 200 Hz, re-computed from the 60 s ESS FRF of 2026-10-12 (bands 30–60, 60–120, 120–250 Hz, orders 2–40; each band shows only the poles inside its own range). Top: CMIF σ1 and σ2.*

- **Markers:** filled blue = stable in f + ζ + participation vector; orange + = stable in f + ζ; yellow × = stable in f; grey = unstable.
- **Triangles** are the poles PolyMAX selected. They reproduce the 22-pole list exactly; the orange triangles at 49.9 and 50.1 Hz are the hum.
- **Vertical lines** are the 25 reference candidates, coloured by cross-exciter agreement in E1: blue = all 6 pairs ≥ 0.9; green = median ≥ 0.9; grey = disagree.
- **30–60 Hz:** the board has few modes here but the noise is relatively higher, so many mathematical poles stabilise in f only.
- **Above 60 Hz:** the physical columns stand out clearly.

**Cross-exciter shape agreement**

| Shape compared across the 4 exciters | median pair MAC | modes with all 6 pairs ≥ 0.9 |
|---|---|---|
| raw dwell response at each exciter's own resonance | **0.31** | **0 / 25** |
| residual-corrected residue (local multi-mode fit) | **0.90** | **5**: 33.0, 57.9 (= 59.1), 67.8, 81.4, 118.3 Hz |
| same, with the sensors nearest to both exciters removed | 0.90 | 5 (same) |
| only exciters with participation ≥ 0.3 of the strongest | — | 7: + 64.7 (2 exc.), 126.9 (3 exc.) |

![Best modes: cross-exciter MAC and shapes](report-mode-discovery-2026-10-12/fig02_best_modes_cross_exciter_mac.png)

*Figure 2. The four best-agreeing modes. Top: 4 × 4 cross-exciter MAC of the residual-corrected residues. Bottom: the 7-sensor shape seen by each exciter (normalised, phase-aligned real part). The four exciters see the same pattern sensor by sensor.*

![Raw vs corrected MAC](report-mode-discovery-2026-10-12/fig05_raw_vs_corrected_mac.png)

*Figure 5. Left: per mode, the median and range of the 6 exciter-pair MACs, raw dwell (grey) vs residual-corrected (blue). Right: all 150 pairs. The raw shapes cluster near chance, the corrected ones near 1. The ~25 % of corrected pairs that stay low come from the close clusters.*

![AutoMAC](report-mode-discovery-2026-10-12/fig03_automac_reference_modes.png)

*Figure 3. AutoMAC of the 25 reference candidates. Each mode's shape here is the consensus over the 4 exciters (first singular vector of the corrected residues). The off-diagonal median is 0.10. The four high off-diagonal pairs are:*

- *57.9 / 59.1 Hz, MAC 1.00: the same mode;*
- *81.0 / 81.4 Hz, MAC 0.99;*
- *107.2 / 109.4 Hz, MAC 0.82;*
- *136.7 / 141.2 Hz, MAC 0.94.*

*These are the close pairs that 7 sensors cannot tell apart by shape.*

**Per-mode table (below 200 Hz).**

- **Src:** P = PolyMAX, S = swept-only.
- **ζ:** the PolyMAX model value; * = seed value for a swept-only candidate.
- **M:** local overlap factor.
- **f spread:** spread of the resonance frequency across the 4 exciters.
- **n drive:** number of exciters with participation ≥ 0.3 of the strongest.

| f (Hz) | src | ζ (%) | M | f spread (%) | raw MAC med | corrected MAC min / med | n drive | agreement |
|---|---|---|---|---|---|---|---|---|
| 33.0 | P | 3.3 | 0.7 | 1.1 | 0.71 | 0.94 / 0.95 | 4 | **all 4** |
| 36.2 | S | 5* | 1.1 | 4.5 | 0.47 | 0.65 / 0.85 | 4 | |
| 47.8 | S | 5* | 0.5 | 10.9 | 0.32 | 0.36 / 0.61 | 3 | |
| 57.9 | S | 5* | 5.0 | 3.5 | 0.35 | 0.91 / 0.94 | 3 | **all 4** (= 59.1) |
| 59.1 | P | 3.0 | 3.0 | 3.4 | 0.35 | 0.88 / 0.91 | 4 | near |
| 64.7 | S | 5* | 2.1 | 2.6 | 0.41 | 0.78 / 0.89 | 2 | 2 drivers agree (0.98) |
| 67.8 | P | 2.8 | 1.3 | 0.8 | 0.23 | 0.97 / 0.99 | 4 | **all 4** |
| 70.6 | P | 2.3 | 1.1 | 1.4 | 0.03 | 0.03 / 0.35 | 2 | |
| 75.7 | P | 2.9 | 0.8 | 1.7 | 0.47 | 0.86 / 0.94 | 1 | near (one driver) |
| 81.0 | P | 3.0 | 10.2 | 1.5 | 0.43 | 0.89 / 0.93 | 4 | near |
| 81.4 | P | 1.9 | 6.4 | 0.3 | 0.44 | 0.94 / 0.96 | 2 | **all 4** |
| 94.3 | P | 2.3 | 4.3 | 1.3 | 0.51 | 0.21 / 0.70 | 4 | cluster |
| 95.3 | P | 3.1 | 5.8 | 0.8 | 0.56 | 0.77 / 0.92 | 3 | near |
| 107.2 | P | 2.2 | 2.2 | 0.5 | 0.72 | 0.23 / 0.64 | 1 | cluster (0.98 in E2's narrow window) |
| 109.4 | P | 2.0 | 2.0 | 2.7 | 0.60 | 0.69 / 0.83 | 4 | cluster |
| 118.3 | P | 2.8 | 0.8 | 0.5 | 0.21 | 0.96 / 0.98 | 4 | **all 4** |
| 126.9 | S | 4.4 | 1.7 | 1.3 | 0.43 | 0.87 / 0.96 | 3 | near |
| 133.4 | P | 2.4 | 1.9 | 0.7 | 0.28 | 0.83 / 0.91 | 3 | near |
| 136.7 | P | 2.4 | 2.0 | 4.8 | 0.18 | 0.03 / 0.28 | 2 | cluster |
| 141.2 | P | 3.0 | 1.9 | 3.0 | 0.22 | 0.49 / 0.77 | 2 | cluster |
| 155.1 | P | 3.2 | 2.3 | 3.0 | 0.28 | 0.13 / 0.40 | 2 | cluster |
| 159.4 | P | 2.0 | 1.5 | 2.2 | 0.18 | 0.43 / 0.75 | 1 | one driver |
| 173.9 | P | 2.3 | 0.9 | 3.0 | 0.20 | 0.20 / 0.55 | 2 | cluster |
| 182.6 | P | 2.6 | 1.3 | 0.6 | 0.38 | 0.71 / 0.86 | 4 | cluster |
| 190.0 | P | 2.3 | 1.2 | 6.7 | 0.23 | 0.04 / 0.21 | 4 | cluster |

**Hypotheses tested**

| Hypothesis | Test | Verdict |
|---|---|---|
| Neighbouring / background modes contaminate each exciter's response | raw 0.31 → corrected 0.90; overlap factor median 1.9 (> 1 for 20 / 25) | **main cause** |
| Close modes that 4 × 7 data cannot separate | failures come in clusters (94/95, 107/109, 133/137/141, 155/159, 174/183/190 Hz). Per-exciter PolyMAX finds 15 / 19 / 20 / 20 modes vs 21 joint. 107.2 Hz agrees (0.98) when the window excludes 109.4 Hz | **second cause** |
| Low participation | 75.7, 107.2 and 159.4 Hz are driven by one exciter only | explains ~3 modes |
| Near-field sensor | removing the nearest sensors leaves median 0.90 | **not the cause** |
| Nonlinearity / level | E2: the FRF difference halves per +6 dB (SNR-limited); per-step shape MAC vs level ≥ 0.97; pairs with Out 3 agree **best** (0.92) | **not the cause** below 200 Hz |
| One faulty exciter | pair medians 0.86–0.92; no outlier exciter | minor |

### 5.8 Chirp-based ESPRIT below 200 Hz (10-12)

The project ESPRIT pipeline was run unchanged, with a dedicated band set below 200 Hz, on two IR sets: (a) the live chirp collection (1 s IRs), and (b) a fresh 15–300 Hz chirp with 2 s IRs.

| | (a) 1 s IRs | (b) LF chirp, 2 s IRs |
|---|---|---|
| ESPRIT poles below 200 Hz per exciter | 35–43 | 46–49 (≈ 2× the reference) |
| frequency hits within B/2 (chance) | 96–100 (79.5) | 98–100 (83.5) |
| shape MAC vs the E1 corrected shape (chance) | 0.10 (0.11) | **0.61** (0.14) |
| ESPRIT ζ / reference ζ | 0.08 | 0.11 |
| reference modes confirmed by ≥ 2 exciters | 0 | 7 |

ESPRIT does not independently find the same modes. With twice as many poles as modes, frequency coincidence is only about 15 % above chance. Long low-frequency IRs make its shapes clearly related to the stepped-sine shapes, but its damping stays 5–10× too low.

![LF chirp ESPRIT](report-mode-discovery-2026-10-12/fig10_lf_chirp_esprit.png)

*Figure 10. Low-frequency chirp ESPRIT poles vs the 25 reference candidates (frequency, damping, shape MAC).*

### 5.9 50 Hz hum

PolyMAX on every FRF returns a pair of poles at 49.9 and 50.1 Hz with ζ 0.36–0.38 %. That is about 5× lighter damping than any board mode, and it sits exactly on the mains frequency. It is mains hum in the sensor chain, not a board mode. It is excluded from the reference list. The identification needs a hum notch or exclusion band at 50 Hz and its harmonics before results are exported.

---

## 6. Conclusions and next steps

### 6.1 Conclusions

1. Use **PolyMAX** for frequencies, damping and multi-reference shapes up to about 1 kHz (2 kHz marginal). Its damping matches the model-free decays.
2. Use the **swept joint fit** as an independent frequency and shape cross-check. Its ζ is about 30 % high.
3. **Drop per-exciter ESPRIT** for this board, whether it runs on impulse or chirp IRs.
4. Below 200 Hz the exciters **do** agree on the board's modes once overlap is modelled. This holds for 5 modes at MAC ≥ 0.9 and 6 more nearly. The remaining disagreement is a **resolution problem**: 4 drive points × 7 sensors against about 20 heavily overlapping modes. It is not nonlinearity, drive level, a near-field effect or a bad exciter.
5. For playback through Out 1–4, **real per-mode weights** (decka form) are as good as complex ones here (`actuator_feed.npz`).

### 6.2 Next steps, in priority order

| # | Step | Why | Effort |
|---|---|---|---|
| E9 | **More sensors** (16–24) or a **roving sensor grid** | 7 DOF cannot separate about 20 overlapping modes (chance MAC 0.14; close pairs at 0.8–1.0). This is the decisive experiment | hardware + 1 day |
| E6 | **Impulse hammer, force-referenced, roving over a grid** | many drive points; reference independent of the exciters; shows the mass-loading effect of the attached exciters | hammer + 1 day |
| E8 | **Current sense** (2nd UMC1820 over ADAT, `--current-inputs`) | force reference: per-exciter scale, phase and back-EMF damping; absolute 1/m | wiring + S code |
| E7 | **Out 3 mechanical check** (mounting, coupling, amplifier) | H2 −23 dB at −30 dBFS | user's hands, 10 min |
| — | **50 Hz hum notch / exclusion** in PolyMAX / swept | prevents spurious modes | S |
| — | **Merge plan** | Core `feature/dev-fd69-modal-methods` + Tunner `feature/dev-fd69-chirp-ui` → `dev` after review; chirp collection is already the default for new Measurements | review + merge |
| — | **Board ↔ engine mode matching** for `actuator_feed.npz` → decka coefficients | playback use | M |

E4 (cable swap) and E5 (one exciter at a time) are low value. Crosstalk is −63…−71 dB and no single exciter is an outlier.

### 6.3 Open questions for Dima

1. What damping (Q) does he see? Could he send a survey `.npz`, the CT calibration file and the sensor/actuator layout? PolyMAX can take his FRFs directly and return ζ.
2. Below 250 Hz, do his results change if the settle time goes from 200 to 1000 ms? (At ζ 1.6 %, 200 ms is about 2 τ at 100 Hz.)
3. Actuators and amplifier: voltage or current drive? Impedance curves? CT or shunt? Does the current phase differ between actuators?
4. Does each actuator give the same mode shape (MAC of the columns at a peak)? On our board this holds only for about 5–11 low modes, and only after a multi-mode fit.
5. How does he handle close or degenerate pairs? His clustering keeps only u₁.
6. Current THD at working level: how large is it, and does it depend on level?
7. FPGA: does a slot decay in normal play? What are the units of `omega_coef`, the ×10000 factor and `f·690·0.97`?
8. How much did his REFINE loop gain over the SVD solve?
9. Is any sensor at the same point as an actuator? A drive-point FRF would give 1/m.

---

## Appendix A: Sources and reproduction

- Methods + rig results: `docs/development/modal-methods-attached-exciters-2026-10-11.md` (§1–§10).
- Swept design: `docs/proposals/swept-sine-mode-discovery-2026-10-11.md`.
- Dima comparison: `docs/development/dima-vs-pianoid-mode-discovery-2026-10-11.md`.
- ASIO session: `docs/proposals/asio-audio-core-retire-sdl-2026-10-11.md`.
- Literature: `docs/development/piano-soundboard-mode-count-literature-2026-10-10.md`.
- Data: `D:\modal_measurements\`
  - `swept_discovery\20261011-rig{1,2,3}`, `20261012-rig4b`;
  - `rig_checks\20261012T160627-crosstalk`, `T160700-linearity`, `T161018-sweep_speed`, `T172442-e1`, `T175239-e2`, `T182323-lfchirp`;
  - `appropriation\20261012T164630`, `T164732`;
  - analysis in `analysis\dev-fd69-2026-10-1{1,2}\`; first consistency analysis in `D:\scratch\xexc-2026-10-11\`.
- Figures 1–7 were regenerated from the saved data by `docs/development/diagnostics/dev-fd69-report-figures-2026-10-12.py`. It re-runs PolyMAX below 270 Hz on the 60 s FRF and reproduces the 22-pole list. Figures 8–10 are copied from the existing analysis outputs.
