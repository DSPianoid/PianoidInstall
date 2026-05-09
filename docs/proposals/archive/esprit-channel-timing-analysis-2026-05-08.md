# ESPRIT Per-Channel Timing Analysis

> **STATUS — ARCHIVED 2026-05-09 by dev-prophy.** Research Q&A — answered the user's question on per-channel timing in ESPRIT (relative alignment matters; it IS preserved end-to-end; no fix needed). No future-work proposal flowed from this; archived as research history. Tangentially referenced by the multichannel-Hankel Phase A experiment (also archived).

**Date:** 2026-05-08
**Read-only investigation** — no code edits.
**User question (verbatim):** *"All channels in the measurements dataset are
synchronized, meaning that each channel has its own delay. 1) Are those
timings important for the ESPRIT result? 2) Are they honored in the
implementation?"*

---

## 1. Executive Summary

| # | Question | Short answer |
|---|----------|--------------|
| 1 | Are per-channel timings important for the ESPRIT result? | **Yes — but only the *relative* sample-to-sample alignment between channels.** Absolute hardware/propagation delays do NOT need to be removed; what matters is that *sample n* of channel A and *sample n* of channel B refer to the same wall-clock instant. |
| 2 | Are they honored in the implementation? | **Yes, the relative alignment is honored end-to-end.** The acquisition-time multichannel sync is preserved through cycle alignment (one shift, applied to all channels), through the per-band processing (axis-0 operations broadcast across channels), and into ESPRIT's `estimate_mode_shapes` (single time basis shared by all channels). **No** explicit per-channel hardware delay is subtracted anywhere — but that is correct, because what ESPRIT extracts is the *relative phase between channels at each pole*, and a constant per-channel delay maps directly to a frequency-dependent phase that the algorithm captures faithfully. |

**Bottom line:** the user's intuition that scrambled per-channel timing would corrupt mode shapes is mathematically correct, but the implementation does NOT scramble it — every signal-processing stage operates on the multichannel `(T, n_channels)` array with axis-0 (time) operations that act identically across channels. The Q noise floor and mode-shape fragility seen in dev-grid / dev-robust are NOT explained by a per-channel timing bug; the timing is sound.

There is one nuance worth flagging (Section 5.4): ESPRIT extracts poles from a **single channel only** (`signals[:, 0]`, the first response channel after role filtering) — the `use_multichannel=True` path exists but is never wired up by the runner. That is unrelated to per-channel *timing* but is a separate observation about the per-channel signal *content* the user may want to know about.

---

## 2. ESPRIT Theory — Per-Channel Timing Role

### 2.1 What the algorithm extracts

The signal model ESPRIT fits is a sum of complex exponentials. Per channel `c`:

```
y_c[n] = Σ_k φ_c,k · exp(s_k · n · dt) + noise
```

where:

- `s_k = σ_k + j·ω_k` is a continuous-time pole (frequency `ω_k/2π`, damping `−σ_k/|s_k|`) — **shared across all channels** (the structure has the same modes everywhere).
- `φ_c,k` is the **complex per-channel amplitude** (a.k.a. mode shape coefficient) for channel `c` and mode `k`. Magnitude encodes how strongly the mode appears at sensor `c`; **phase encodes the time delay relative to the chosen time origin**.

### 2.2 Why time alignment between channels matters

The `n` in `exp(s_k · n · dt)` is the **same time index** across all channels. If channel B's signal is misaligned to channel A's by `Δn` samples (e.g. you grabbed channel B from a different cycle, or you applied a per-channel onset shift), then refitting yields:

```
y_B[n] = φ_B,k · exp(s_k · (n − Δn) · dt)
       = [φ_B,k · exp(−s_k · Δn · dt)] · exp(s_k · n · dt)
                                      = φ_B,k_apparent
```

The apparent mode-shape coefficient `φ_B,k_apparent` differs from the true `φ_B,k` by a **frequency-dependent complex factor** `exp(−s_k · Δn · dt)`. For a stable mode (`σ_k < 0`), the magnitude is essentially `1` (since `σ_k · Δn · dt ≈ 0` for small `Δn`), but the phase rotates by `−ω_k · Δn · dt = −2π · f_k · Δt`.

Consequence: a per-channel time misalignment of `Δn` samples scrambles the per-channel phase by a frequency-dependent amount. MAC across modes that are physically the same but at different frequencies starts to break down because the apparent mode shape vector has a frequency-dependent twist.

### 2.3 What about a constant per-channel hardware delay (cable, mic position)?

If channel B's *raw* recording is delayed by a fixed `Δn_B` samples relative to channel A (cable length, preamp latency, mic distance from the source), then its sample-0 corresponds to a slightly earlier wall-clock instant than A's sample-0. After ESPRIT, the apparent `φ_B,k = φ_B,k_true · exp(−s_k · Δn_B · dt)`. The mode shape vector across channels picks up a per-channel phase twist that varies linearly with frequency (because each channel's `Δn_c` is a constant in samples but the resulting phase shift is `2π·f·Δt_c`).

**This is a feature, not a bug, of the algorithm output:**

- The MAC compares mode shapes *at the same pole*. Since the twist is the same for every detection of the same mode (same `f_k`, same per-channel `Δn_c`), MAC remains 1.0 for "this mode at scenario 1" vs "the same mode at scenario 2". So mode tracking is **not** affected.
- The mode shape *visualised* on the bridge is the apparent shape (with twist) rather than the true shape. For mode-shape *interpretation* (which sensor is leading, which is lagging) you'd want to subtract the hardware delays — but for *tracking* and *MAC-based merging* across scenarios, you don't.

So the algorithm only requires: **same time origin for all channels in a single ESPRIT call** (i.e. `signals[:, c]` for every `c` shares the same sample-0 wall-clock instant). Hardware-delay offsets that survive the recording chain are absorbed into the mode shape's complex value, but as long as those offsets are constant *per channel across scenarios* they cancel in the cross-scenario MAC.

### 2.4 What would break ESPRIT

The failure modes the user worried about are:

1. **Per-channel onset alignment** (each channel realigned independently to its own first peak). This would scramble `Δn_c` cycle-by-cycle and scenario-by-scenario, completely destroying mode-shape coherence.
2. **Per-channel cycle averaging without coherent shifts** (each channel averaged from a different set of cycles, or with a different shift per cycle). Same effect: random phase noise on the per-channel amplitudes.
3. **Per-channel signal length mismatch** (channel A truncated to length T_A, channel B to T_B with B's content shifted to fit). Would force the LSQ basis `Z[n] = exp(s_k · n · dt)` to fit out-of-phase data.

Section 4 verifies that **none of these failure modes occur** in the current pipeline.

---

## 3. Implementation Audit (with file:line citations)

### 3.1 Multichannel signal entry into ESPRIT

`pianoid_middleware/modal_adapter/esprit_runner.py:67-105`
- `EspritRunner.run_single_point(signals, fs, params)` accepts `signals` of shape `(T, n_channels)` and forwards it to `merge_multiband_results`.
- No per-channel rearrangement, no per-channel slicing on the time axis.

`pianoid_middleware/modal_adapter/esprit_runner.py:193-201`
- The only per-channel manipulation is **column** filtering (channel selection by role): `signals_filtered = signals[:, response_channels]`. The time axis (axis 0) is untouched. Sample n of every selected response channel is the same wall-clock instant.

### 3.2 Per-band signal processing

`pianoid_middleware/modal_adapter/esprit/band_processing.py:225-407` — `process_band(signals, fs, band, ...)`:
- Operates on `(T, n_channels)` from input to output.
- Per-band IR slice (`signals[:n_samples_total]`, line 264-282): same length truncation across **all** channels.
- `sosfiltfilt(sos, signals, axis=0)` (line 287): bandpass on the time axis, broadcast across channels. Identical filter taps, identical zero-phase forward-backward pass on every channel.
- `apply_exponential_preemphasis(filtered, exp_factor, fs)` (band_processing.py line 205-222): multiplies by a single time-window `exp(α·t)` broadcast across channels — same time-domain shaping per channel.
- `decimate(filtered, decimation, axis=0, ftype='iir', zero_phase=True)` (line 295): decimation along time axis only; identical zero-phase IIR per channel.
- Skip-start (line 308-314), start-fade (line 326-337), end-fade (line 367-380): **all** broadcast across channels (`filtered[:n_samples_fade_in, :] *= fade_in_window[:, np.newaxis]` — see lines 337, 380). Same window applied to every channel.

**Verdict:** every operation in `process_band` preserves the per-channel time alignment exactly. After processing, `processed[:, A]` and `processed[:, B]` still share sample-0 in wall-clock terms (modulo the scenario-wide identical truncation/skip).

### 3.3 Hankel matrix construction

`pianoid_middleware/modal_adapter/esprit/esprit_core.py:534-538` — `_build_hankel(signals, window_length, use_multichannel)`:
```python
def _build_hankel(signals, window_length, use_multichannel):
    if use_multichannel:
        return build_multichannel_hankel(signals, window_length, mode='stack')
    return build_hankel_matrix(signals[:, 0], window_length)
```

**Critical observation:** the default path uses **only `signals[:, 0]`** — the first response channel — to build the Hankel matrix that drives pole extraction. The multichannel `stack` path (`esprit_core.py:56-77`) vertically stacks per-channel Hankel matrices, but `use_multichannel=False` is the default and is hard-coded to `False` in the runner (Section 3.5).

This is **NOT** a per-channel-timing bug per se — pole extraction from a single channel is mathematically valid (the poles are global to the structure, every channel sees the same poles). It IS, however, a "we're throwing away information that could improve pole estimation" observation. See Section 5.4.

### 3.4 Per-channel mode shape estimation (the *key* timing-sensitive step)

`pianoid_middleware/modal_adapter/esprit/esprit_core.py:374-391` — `estimate_mode_shapes(signals, poles, dt)`:
```python
def estimate_mode_shapes(signals, poles, dt):
    T, n_channels = signals.shape
    M = len(poles)
    n = np.arange(T)                              # SHARED time index
    Z = np.exp(np.outer(n, poles) * dt)           # SHARED basis

    mode_shapes = np.zeros((M, n_channels), dtype=complex)
    for ch in range(n_channels):
        mode_shapes[:, ch], _, _, _ = np.linalg.lstsq(Z, signals[:, ch], rcond=None)
    return mode_shapes
```

**This is exactly the right thing.** `n = np.arange(T)` is the same `[0, 1, 2, ...]` for every channel; `Z = exp(n ⊗ poles · dt)` is computed once and reused for every channel. Each channel's `lstsq(Z, signals[:, ch])` recovers the complex `φ_c,k` *with respect to the same time origin* (sample 0 = same wall-clock instant for every channel).

If channel B's `signals[:, B]` were misaligned to channel A's by `Δn` samples (Section 2.2), the LSQ would silently absorb the misalignment into a frequency-dependent phase twist on `φ_B,k`. **The implementation is correct: it takes the multichannel-coherent input and produces a per-channel complex amplitude with consistent phase reference.**

### 3.5 `use_multichannel` is never enabled

`PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py:53-61` — `DEFAULT_ESPRIT_PARAMS` does not include `use_multichannel`.
`esprit_runner.py:86-92` — `esprit_params` constructed in `run_single_point` does not set it.
`PianoidTunner/src/components/EspritConfig.jsx:204` — destructured default `use_multichannel = false`, but **never rendered as a UI control** (verified by grep — only one occurrence of the symbol in the file). It is a dead config field.

So `_build_hankel` always takes the `use_multichannel=False` branch → `signals[:, 0]` only.

### 3.6 Mode shape carries through to tracking + downstream

`PianoidCore/pianoid_middleware/modal_adapter/esprit_runner.py:567-606` — `_build_all_detections`:
- Each detection's `mode_shape` is passed through as a complex vector.
- `det.shape_magnitudes` is the *real-rotated* visualization vector (rotate so dominant channel is real-positive, then take real part) — but the **complex** `mode_shape` is preserved on the detection and used for MAC.

`PianoidCore/pianoid_middleware/modal_adapter/esprit/mode_tracking.py:439-445` — `_rotate_shape`:
- Rotates the entire complex vector by a single scalar phase (the dominant channel's phase). **Per-channel relative phases are preserved** — only a global phase is removed (which is conventional and correct: the absolute phase of a mode is meaningless; the relative pattern is the signature).

`PianoidCore/pianoid_middleware/modal_adapter/esprit/band_merging.py:51-60` — `compute_mac`:
```python
numerator = abs(np.dot(shape1.conj(), shape2)) ** 2
denom     = np.dot(shape1.conj(), shape1).real * np.dot(shape2.conj(), shape2).real
```
Standard complex MAC. Operates on the complex vectors; sensitive to per-channel relative phase. So MAC will correctly distinguish modes whose per-channel phase patterns differ — provided the per-channel timings are consistent across detections (they are, per Section 4).

### 3.7 Cycle alignment & averaging in the scenario averager

`PianoidCore/pianoid_middleware/modal_adapter/scenario_averager.py:894-906` (and identically lines 1474-1480):
```python
# Step 3: align using calibration channel
alignment = sp.align_cycles_by_onset(
    initial_cycles, validation_results,
    correlation_threshold=correlation_threshold)

# Step 4: apply alignment to every channel
aligned_multichannel = {
    c: sp.apply_alignment_to_channel(recorded[c], alignment)
    for c in channel_indices}
```

**This is the multichannel-coherent shift the docs reference.** The alignment (which cycles, how to circular-shift each kept cycle) is computed **once** on the calibration channel, then **the same shifts** are applied to every channel. So:

- All channels share the same set of surviving cycles (no per-channel cycle drop).
- All channels share the same per-cycle circular shift (no per-channel onset realignment).
- Sample n of channel A's averaged response and sample n of channel B's averaged response refer to the same wall-clock instant in the impulse-response time axis.

`scenario_averager.py:1080-1089` — per-channel mean and truncate: each channel is independently averaged across the same set of cycles and truncated to the same length. The truncation is identical (`ir_working_length_ms` and `fade_length_ms` are scalar config), so all channels emit `T` samples with sample-0 at the same instant.

### 3.8 Per-channel `.npy` re-stack

`PianoidCore/pianoid_middleware/modal_adapter/modal_adapter.py:2530-2553`:
```python
ch_files = sorted(glob.glob(os.path.join(avg_dir, "average_ch*.npy")), ...)
channels = [np.load(p) for p in ch_files]
combined = np.stack(channels, axis=1)   # (T, n_channels)
```

The per-channel `.npy` files (each shape `(T,)`, all of length `T`) are stacked along axis 1 to form `(T, n_channels)`. Because every channel was truncated to the same `T` and they all share sample-0, the stacked array carries the multichannel coherence into the rest of the pipeline.

### 3.9 `mode_amplitudes.csv` (dev-camp)

`PianoidCore/pianoid_middleware/modal_adapter/external_export.py:217-305` — `extract_complex_amplitudes_per_chain`:
- Builds a per-chain reference shape (unit-norm mean of per-detection complex shapes).
- Projects each detection's complex shape onto the reference: `<shape, conj(ref)>` (complex inner product, real AND imaginary parts retained).
- The output is a complex scalar per (mode, scenario).

**Does this depend on per-channel timing being honored?** Yes — fundamentally. The complex inner product weights each channel by `conj(ref[c])`, so a per-channel phase twist that differs across detections would break the projection. Since Section 3.7 / 3.4 / 3.2 / 3.1 verify that per-channel timings are consistent across detections, this projection is well-defined and the resulting complex amplitude is physically meaningful (modulo the Section 2.3 hardware-delay absorption — which is a constant per channel and thus does NOT vary across detections of the same chain).

---

## 4. Data-Path Diagram

```
Hardware acquisition
    ┌──────────────────────────────────────────────────────────────┐
    │ ADC samples N channels in lock-step on a shared clock        │
    │ Per-channel hardware delay (cable, mic position, preamp):     │
    │   PRESENT — NOT corrected anywhere in the pipeline            │
    │   (this is fine — see Section 2.3)                            │
    └─────┬────────────────────────────────────────────────────────┘
          │ raw_recordings/recording_<m>_ch<c>.npy
          ▼  shape (T_raw,) per (measurement, channel)
    ┌──────────────────────────────────────────────────────────────┐
    │ scenario_averager.compute_average_for_scenario               │
    │  Step 1-2: extract & validate cycles on calibration channel  │
    │  Step 3:   align_cycles_by_onset (calibration-channel only)  │  ← shifts computed ONCE
    │  Step 4:   apply_alignment_to_channel (every channel, same   │  ← multichannel-coherent
    │            shifts) ✓ MULTICHANNEL COHERENCE PRESERVED        │
    │  Step 5:   normalize_by_calibration (per-cycle scalar)       │  ← scalar, no time skew
    │  Step 6:   per-channel mean of identical cycle set, then     │  ← same N cycles, same T
    │            truncate-with-fadeout to the same length           │
    └─────┬────────────────────────────────────────────────────────┘
          │ averaged_responses/average_ch<c>.npy
          ▼  shape (T,) per channel; same T, same sample-0 across all c
    ┌──────────────────────────────────────────────────────────────┐
    │ modal_adapter._load_scenario  (modal_adapter.py:2530-2553)   │
    │   np.stack([np.load(ch_file)], axis=1)                        │
    │   ✓ Reassembles into (T, n_channels) preserving sample-0     │
    └─────┬────────────────────────────────────────────────────────┘
          │ measurements[idx] = combined  shape (T, n_channels)
          ▼
    ┌──────────────────────────────────────────────────────────────┐
    │ EspritRunner.run_all_points (esprit_runner.py:106-284)       │
    │   signals_filtered = signals[:, response_channels]            │  ← column filter only
    │   ✓ Time axis untouched                                       │
    └─────┬────────────────────────────────────────────────────────┘
          ▼
    ┌──────────────────────────────────────────────────────────────┐
    │ merge_multiband_results → process_band (per band)            │
    │   sosfiltfilt(axis=0) — same filter, every channel            │
    │   decimate(axis=0)    — same decimation, every channel        │
    │   skip_start, fade-in, fade-out — same windows, broadcast    │
    │   ✓ Per-channel time alignment preserved                      │
    └─────┬────────────────────────────────────────────────────────┘
          ▼
    ┌──────────────────────────────────────────────────────────────┐
    │ esprit_modal_identification (per band)                       │
    │   _build_hankel: uses signals[:, 0] only (use_multichannel    │  ← Section 5.4
    │                  is False / unwired)                          │
    │   esprit_poles → poles                                        │
    │   estimate_mode_shapes(signals, poles, dt):                   │
    │     n = arange(T), Z = exp(n ⊗ poles · dt)  — SHARED basis    │  ← time origin shared
    │     for ch: lstsq(Z, signals[:, ch])                          │  ← per-channel φ_c,k
    │   ✓ Per-channel complex amplitude extracted with consistent   │
    │     phase reference                                           │
    └─────┬────────────────────────────────────────────────────────┘
          ▼
    ┌──────────────────────────────────────────────────────────────┐
    │ Mode tracking (mode_tracking_nuclei._set_reference_shape)    │
    │   _rotate_shape: removes ONE global scalar phase from the    │
    │                  entire complex vector → per-channel relative │
    │                  phases preserved                             │
    │   compute_mac: standard complex MAC on rotated vectors        │
    │   ✓ Tracks consistently across scenarios                      │
    └─────┬────────────────────────────────────────────────────────┘
          ▼
    ┌──────────────────────────────────────────────────────────────┐
    │ extract_complex_amplitudes_per_chain  (mode_amplitudes.csv)  │
    │   reference = unit-norm mean(complex shapes)                  │
    │   projection = <shape, conj(ref)>  per (mode, scenario)       │
    │   ✓ Well-defined because per-channel phases are consistent    │
    │     across detections of the same chain                       │
    └──────────────────────────────────────────────────────────────┘
```

**Result:** at no point in the pipeline is a per-channel time shift applied independently. The multichannel-coherence established at acquisition is preserved through every downstream stage.

---

## 5. Impact on Observed Behavior

### 5.1 Q noise floor (dev-grid Q std = 0.21)

The Q noise floor was traced (in `docs/development/logs/archive/dev-grid-stage1-fragmentation-analysis.md`) to **Stage-1 fragmentation** at window-grid boundaries — the dominant mode being split across two adjacent sliding-window passes during nucleus detection. The fragmentation gives a Q-std contribution of ~0.05 per affected mode, which adds up to the ~0.21 floor.

**Per-channel timing is NOT a contributor.** A timing-scrambling bug would manifest as poor MAC across detections of the *same* mode (because the per-channel phase pattern would differ scenario-to-scenario), which would in turn break tracking AND give wrong damping estimates. The actual Q noise floor was traced to a clustering-window boundary issue, not a per-detection MAC failure. The MAC-based merging works, which is direct evidence that per-channel timings are consistent across detections.

### 5.2 Mode shape fragility in dev-robust

Dev-robust improved the reference-shape mean by replacing arithmetic mean with iterative MAC outlier filtering (`docs/development/MODE_TRACKING_NUCLEI_MERGE.md` line 298+). The improvement (Q_std 0.2120 → 0.1840) came from rejecting *physically wrong* per-detection shapes (cross-mode contamination, weak-mode noise) rather than fixing a timing-induced phase scramble. If per-channel timing were broken, the iterative MAC filter would have collapsed the inlier set on every chain because no detection would agree with the mean — the filter works precisely because most detections of a given mode DO agree on per-channel phase pattern.

### 5.3 dev-camp `mode_amplitudes.csv` complex amplitudes

The complex projection `<shape, conj(ref)>` is mathematically well-defined exactly when per-channel timings are consistent across detections. Section 3 verifies this is the case, so the dev-camp export is built on a sound foundation. The complex amplitudes carry the (constant) hardware-delay phase twist of Section 2.3, which is *fine* for downstream use — every detection of the same mode carries the same twist, so amplitude *ratios* across scenarios (the typical use case for the matrix) cancel the twist exactly.

### 5.4 Independent observation — single-channel pole extraction

Per Section 3.3 / 3.5, the Hankel matrix that drives pole extraction is built from `signals[:, 0]` only — only the **first** response channel contributes to pole estimation. The multichannel-stacked Hankel option (`use_multichannel=True` → `(L·n_channels, K)` matrix) would in principle improve pole-estimation SNR by `√n_channels`, but it is wired neither in the runner nor in the frontend.

This is **NOT a per-channel timing issue** (it is unrelated to the user's question), but the user should be aware:

- Pole estimates depend entirely on the first response channel's signal quality. If that channel happens to be a node of a particular mode (low energy at that mic position), that mode is poorly estimated or missed entirely, even though other channels see it strongly.
- Mode shape estimation (Section 3.4) does use all channels for the per-channel amplitude — only the pole step is single-channel.

If the dev-grid Q noise floor turns out to have a residual contribution from poor pole estimation on weak-at-channel-0 modes, switching the runner to wire `use_multichannel=True` would be a low-effort experiment. But this is independent of per-channel timing and outside the scope of the user's question.

---

## 6. Verdict on the Two Questions

### 6.1 "Are per-channel timings important for the ESPRIT result?"

**Yes — relative inter-channel sample alignment is essential.** The complex per-channel mode-shape coefficient `φ_c,k` is meaningful only when every channel's signal shares the same time origin `n=0`. A misalignment of `Δn` samples on one channel produces a frequency-dependent phase rotation `exp(−s_k · Δn · dt)` on its `φ_c,k`, which corrupts the mode shape and breaks MAC.

**Constant per-channel hardware delays (cable, mic position) are *not* important to remove.** They are absorbed into the complex `φ_c,k` as a consistent per-channel phase twist that:
- does not vary across detections of the same chain (so MAC across scenarios works);
- does not affect pole/frequency/damping (those are determined by the time-axis behaviour, not the cross-channel pattern);
- only affects the *visualisation* of the mode shape on the bridge (which sensor leads which by how much). For visualisation purposes it would be better to subtract them, but that's a separate question from "does ESPRIT produce correct modal parameters".

### 6.2 "Are they honored in the implementation?"

**Yes, end-to-end:**

1. Acquisition: ADC samples in lock-step on a shared clock — multichannel sync is established.
2. Cycle alignment (`scenario_averager.py:894-906`): one shift computed on the calibration channel, applied identically to every channel — multichannel coherence preserved cycle-by-cycle.
3. Cycle averaging + truncation: per-channel mean across the same cycle set, identical truncation length — sample-0 still aligned across channels.
4. Re-stack into `(T, n_channels)` (`modal_adapter.py:2530-2553`): plain `np.stack(axis=1)` — no time-axis manipulation.
5. Channel-role filtering (`esprit_runner.py:194-195`): column slice only.
6. Per-band processing (`band_processing.py:225-407`): every operation broadcasts across channels along axis 0 — identical filter, decimation, skip, fades.
7. Hankel matrix (single-channel path): uses `signals[:, 0]` only — no per-channel timing issue (one channel, no relative alignment needed).
8. Mode shape estimation (`esprit_core.py:374-391`): single shared time basis `Z = exp(n ⊗ poles · dt)` for every channel's `lstsq` — by construction, sample 0 of every channel maps to the same `n=0` in the basis.
9. Tracking (`mode_tracking.py:439-445`): `_rotate_shape` removes a global scalar phase only — per-channel relative phases preserved.
10. MAC, dev-camp complex amplitudes: standard complex inner products on the preserved-phase mode shapes.

**The user's intuition that scrambled per-channel timing would corrupt mode shapes is correct, but the implementation does NOT scramble timing.** No fix is needed.

---

## 7. Effort Estimate (if a fix were needed)

Not applicable — no fix needed. If the user nevertheless wants to *measure* per-channel hardware delay and subtract it for visualisation purposes (Section 6.1, second paragraph), that would be a few-hours feature in `scenario_averager.py` (one additional per-channel shift after `apply_alignment_to_channel`, scalar shift values stored in a new metadata field). It would not change ESPRIT outputs in any tracking-relevant way; it would only make the mode-shape *visualisation* on the bridge geometrically meaningful.

---

## 8. Confidence

- Sections 2 (theory), 3 (implementation citations), 4 (data path) are derived from primary sources (the docs and the cited file:line locations) and verified against the read-only code paths.
- Section 5 (impact) draws on existing dev-grid / dev-robust analysis logs cited in `docs/development/logs/archive/`.
- Section 5.4 (single-channel pole extraction observation) is independent of the user's question and is flagged as a follow-up worth knowing about.
- No code was edited; this is a read-only audit.

## 9. Files Referenced

- `D:\repos\PianoidInstall\docs\guides\MODAL_ADAPTER_GUIDE.md`
- `D:\repos\PianoidInstall\docs\development\MODE_TRACKING_NUCLEI_MERGE.md`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit\esprit_core.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit\band_processing.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit\band_merging.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit\mode_tracking.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit\mode_tracking_nuclei.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\esprit_runner.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\scenario_averager.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\modal_adapter.py`
- `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\external_export.py`
- `D:\repos\PianoidInstall\PianoidTunner\src\components\EspritConfig.jsx`
- `D:\repos\PianoidInstall\docs\development\logs\archive\dev-grid-stage1-fragmentation-analysis.md`
- `D:\repos\PianoidInstall\docs\development\logs\archive\dev-grid-robust-stats-analysis.md`
