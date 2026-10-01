# dev-f2b8 — output level vs string_iteration N (offline, array 384, v110, BARE soundFloat, pre-volume)

BEFORE = shared venv (PianoidCore dev 682a535 + PianoidBasic dev 112c02a). AFTER = isolated venv D:/repos/wt-f2b8 (same engine source, rebuilt --heavy --both; PianoidBasic feature/dev-f2b8-level-vs-n 0cd275b). d0≡d1 (kernel branches only on order==2), so d0 omitted.

| preset | path | note | BEFORE peak dB N=2/4/8/16 | k | AFTER peak dB N=2/4/8/16 | k | BEFORE rms k | AFTER rms k | AFTER rms Δ(16 vs 4) dB |
|---|---|---|---|---|---|---|---|---|---|
| Belarus_8band_196modes | velocity (strings) | 33 | -42.2/-48.7/-55.8/-63.5 | -1.18 | -48.2/-48.7/-49.8/-51.5 | -0.18 | -1.25 | -0.25 | -3.3 |
| Belarus_8band_196modes | velocity (strings) | 60 | -62.0/-68.0/-74.4/-81.2 | -1.06 | -68.1/-68.0/-68.4/-69.1 | -0.06 | -1.22 | -0.22 | -3.1 |
| Belarus_8band_196modes | velocity (strings) | 96 | -94.5/-100.4/-106.5/-112.7 | -1.01 | -100.5/-100.4/-100.4/-100.6 | -0.01 | -1.26 | -0.26 | -3.4 |
| Belarus_8band_196modes | acceleration (strings) | 33 | -72.2/-79.2/-85.8/-92.8 | -1.14 | -78.2/-79.2/-79.8/-80.8 | -0.14 | -1.26 | -0.26 | -3.5 |
| Belarus_8band_196modes | acceleration (strings) | 60 | -80.6/-86.8/-92.7/-98.9 | -1.01 | -86.6/-86.8/-86.7/-86.8 | -0.01 | -1.17 | -0.17 | -2.6 |
| Belarus_8band_196modes | acceleration (strings) | 96 | -101.9/-107.8/-114.6/-120.5 | -1.04 | -107.9/-107.8/-108.6/-108.5 | -0.04 | -1.27 | -0.27 | -3.5 |
| Belarus_8band_196modes | mode force (listen_to_modes) | 33 | -25.5/-31.9/-38.5/-45.5 | -1.11 | -31.5/-31.9/-32.5/-33.5 | -0.11 | -1.06 | -0.06 | -0.8 |
| Belarus_8band_196modes | mode force (listen_to_modes) | 60 | -44.1/-51.1/-57.6/-64.2 | -1.11 | -50.2/-51.1/-51.5/-52.2 | -0.11 | -1.11 | -0.11 | -1.7 |
| Belarus_8band_196modes | mode force (listen_to_modes) | 96 | -64.4/-69.3/-75.6/-81.9 | -0.97 | -70.4/-69.3/-69.6/-69.8 | +0.03 | -1.18 | -0.18 | -2.2 |
| BaselinePreset1 | velocity (strings) | 33 | -55.2/-61.8/-68.9/-76.0 | -1.16 | -61.2/-61.8/-62.9/-64.0 | -0.16 | -1.12 | -0.12 | -1.6 |
| BaselinePreset1 | velocity (strings) | 60 | -66.8/-73.4/-80.8/-88.6 | -1.21 | -72.8/-73.4/-74.8/-76.6 | -0.21 | -1.21 | -0.21 | -3.1 |
| BaselinePreset1 | velocity (strings) | 96 | -89.6/-96.8/-102.7/-108.4 | -1.04 | -95.6/-96.8/-96.7/-96.4 | -0.04 | -1.13 | -0.13 | -1.6 |
| BaselinePreset1 | acceleration (strings) | 33 | -74.9/-81.5/-88.8/-96.9 | -1.22 | -80.9/-81.5/-82.7/-84.9 | -0.22 | -1.30 | -0.30 | -4.1 |
| BaselinePreset1 | acceleration (strings) | 60 | -83.2/-89.4/-95.9/-103.0 | -1.09 | -89.3/-89.4/-89.9/-90.9 | -0.09 | -1.23 | -0.23 | -3.4 |
| BaselinePreset1 | acceleration (strings) | 96 | -91.4/-98.1/-104.4/-111.6 | -1.11 | -97.4/-98.1/-98.3/-99.5 | -0.11 | -1.22 | -0.22 | -2.7 |
| BaselinePreset1 | mode force (listen_to_modes) | 33 | -59.1/-65.6/-72.8/-81.1 | -1.22 | -65.1/-65.6/-66.8/-69.0 | -0.22 | -1.31 | -0.31 | -4.3 |
| BaselinePreset1 | mode force (listen_to_modes) | 60 | -67.4/-73.4/-79.7/-86.8 | -1.07 | -73.4/-73.4/-73.7/-74.7 | -0.07 | -1.23 | -0.23 | -3.4 |
| BaselinePreset1 | mode force (listen_to_modes) | 96 | -75.3/-82.1/-88.2/-95.5 | -1.11 | -81.3/-82.1/-82.2/-83.5 | -0.11 | -1.22 | -0.22 | -2.7 |

k = fitted exponent in level ∝ N^k. Max |AFTER−BEFORE| at N=4 (stored grid) over all rows: 0.005 dB.
AFTER−BEFORE peak shift per N (mean over rows): N=2: -6.02 dB (expected -6.02), N=4: -0.00 dB (expected +0.00), N=8: +6.02 dB (expected +6.02), N=16: +12.04 dB (expected +12.04)

Pitch/decay BEFORE vs AFTER at every N, every config: see Step 7 in the session log (max |Δdecay|, max |Δcents|).
Residual AFTER rms k ≈ -0.1..-0.3 is the pre-existing decay/HF-damping N-dependence (coeff_frequency_decay not dt-scaled): with disp_decay=0 AND coefficients ×N/4 (ablate/hf0xN) C4/C7 rms is flat within ≤1.2 dB over N=2..16 — see ablate_table.txt.
(hf0 preset = Belarus_8band_196modes.json with pitches[*].physics.disp_decay = 0.0; regenerate before re-running dev-f2b8-ablate.sh — removed to keep the repo lean.)
