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

## Part 2 — decay N-dependence (kernel: HF damping + damper × dt/dt_ref, PianoidCore 8113480)

BEFORE = `before/` (shared dev engine, impulse bug present). AFTER = `decay/` (isolated venv: impulse fix + kernel decay fix). decay = dB/s of the 50 ms RMS envelope 0.2–1.3 s (key held), ch0. Spread = (max−min)/|mean| over N.

| preset | path | note | BEFORE decay N=2/4/8/16 | spread | AFTER decay N=2/4/8/16 | spread | AFTER peak dB (2/4/8/16) | AFTER rms dB (2/4/8/16) |
|---|---|---|---|---|---|---|---|---|
| Belarus_8band_196modes | velocity | 33 | -15.7/-16.9/-18.1/-19.6 | 22% | -16.9/-16.9/-16.9/-16.9 | 0.0% | -48.7/-48.7/-48.7/-48.7 | -63.0/-63.0/-63.0/-63.0 |
| Belarus_8band_196modes | velocity | 60 | -22.2/-23.0/-24.5/-27.7 | 22% | -23.0/-23.0/-23.0/-23.0 | 0.1% | -68.0/-68.0/-68.1/-68.1 | -81.8/-81.8/-81.8/-81.8 |
| Belarus_8band_196modes | velocity | 96 | -20.5/-33.4/-57.2/-68.1 | 106% | -33.5/-33.4/-33.4/-33.4 | 0.2% | -100.7/-100.4/-100.4/-100.6 | -117.8/-118.0/-118.1/-118.1 |
| Belarus_8band_196modes | acceleration | 33 | -16.3/-17.6/-18.9/-20.5 | 22% | -17.6/-17.6/-17.6/-17.7 | 0.0% | -78.9/-79.2/-79.1/-79.1 | -95.4/-95.4/-95.4/-95.4 |
| Belarus_8band_196modes | acceleration | 60 | -17.3/-20.2/-22.9/-26.6 | 43% | -20.2/-20.2/-20.2/-20.2 | 0.3% | -86.9/-86.8/-86.7/-86.7 | -103.4/-103.5/-103.5/-103.5 |
| Belarus_8band_196modes | acceleration | 96 | -20.9/-33.5/-57.8/-80.1 | 123% | -33.5/-33.5/-33.5/-33.5 | 0.2% | -108.1/-107.8/-108.6/-108.6 | -126.2/-126.4/-126.5/-126.5 |
| Belarus_8band_196modes | listen_to_modes | 33 | -10.2/-10.9/-11.6/-12.3 | 19% | -10.9/-10.9/-10.9/-10.9 | 0.2% | -31.9/-31.9/-31.9/-31.8 | -43.6/-43.6/-43.6/-43.6 |
| Belarus_8band_196modes | listen_to_modes | 60 | -19.6/-20.7/-22.3/-25.7 | 28% | -20.7/-20.7/-20.7/-20.7 | 0.1% | -50.8/-51.1/-50.9/-50.9 | -64.6/-64.6/-64.6/-64.6 |
| Belarus_8band_196modes | listen_to_modes | 96 | -24.3/-33.7/-54.4/-82.3 | 119% | -33.5/-33.7/-33.8/-33.9 | 1.1% | -70.6/-69.3/-69.6/-69.6 | -89.6/-89.7/-89.8/-89.8 |
| BaselinePreset1 | velocity | 33 | -6.4/-6.6/-6.9/-7.5 | 17% | -6.6/-6.6/-6.6/-6.6 | 0.0% | -61.9/-61.8/-61.8/-61.8 | -72.4/-72.4/-72.4/-72.4 |
| BaselinePreset1 | velocity | 60 | -12.1/-12.8/-13.7/-14.9 | 21% | -12.8/-12.8/-12.8/-12.8 | 0.1% | -73.5/-73.4/-73.5/-73.5 | -86.6/-86.6/-86.6/-86.6 |
| BaselinePreset1 | velocity | 96 | -20.1/-30.9/-40.0/-38.2 | 62% | -30.5/-30.9/-31.1/-31.1 | 2.0% | -95.7/-96.8/-96.6/-96.1 | -119.4/-119.5/-119.6/-119.6 |
| BaselinePreset1 | acceleration | 33 | -8.7/-8.3/-8.1/-8.5 | 6% | -8.3/-8.3/-8.3/-8.3 | 0.0% | -81.5/-81.5/-81.5/-81.5 | -102.8/-102.8/-102.8/-102.8 |
| BaselinePreset1 | acceleration | 60 | -14.2/-15.6/-17.1/-19.0 | 29% | -15.5/-15.6/-15.6/-15.6 | 0.2% | -89.7/-89.4/-89.3/-89.3 | -106.9/-106.9/-106.9/-106.9 |
| BaselinePreset1 | acceleration | 96 | -21.5/-32.1/-53.6/-58.0 | 88% | -31.6/-32.1/-32.3/-32.4 | 2.4% | -97.4/-98.1/-97.7/-97.9 | -123.5/-123.7/-123.8/-123.8 |
| BaselinePreset1 | listen_to_modes | 33 | -9.1/-8.6/-8.1/-8.1 | 11% | -8.6/-8.6/-8.6/-8.6 | 0.1% | -65.6/-65.6/-65.6/-65.6 | -86.9/-86.9/-86.9/-86.9 |
| BaselinePreset1 | listen_to_modes | 60 | -14.4/-15.7/-17.3/-19.4 | 30% | -15.7/-15.7/-15.7/-15.7 | 0.1% | -73.9/-73.4/-73.2/-73.2 | -90.7/-90.7/-90.7/-90.7 |
| BaselinePreset1 | listen_to_modes | 96 | -21.5/-32.1/-53.3/-56.6 | 86% | -31.6/-32.1/-32.3/-32.4 | 2.4% | -81.3/-82.1/-81.6/-81.7 | -107.4/-107.6/-107.7/-107.8 |

N=4 render diff (raw soundFloat, all 18 note×config cells): decay-fix engine vs current dev = 1.1e-5…6.9e-3 relative, identical to dev-vs-dev run-to-run (float atomicAdd non-determinism) 9.5e-6…5.9e-3 → equivalent at N=4 (dt_ratio is exactly 1.0f, so the coefficients are bit-identical; the engine itself is not run-to-run bit-deterministic). 0 non-finite samples in the whole sweep. Pitch A1/C4 N-flat within 1.2 c (C7 detector confidence 0 at this level — not a pitch reading).
Damper confirmation (dev engine, disp_decay=0 AND damper_string=0, `ablate/tmpl_hf0damp0_*`): decay A1 −6.4/−6.2, C4 −11.6/−11.6 at N=4/16 (flat), level k=−1.00 exactly → the A1 residual with disp_decay=0 alone was the non-dt-scaled damper of the NON-played (damper-closed) strings draining the shared modes.
