# Extended 8-Band Pipeline Run Report

## Run Configuration

- **Date:** April 7, 2026
- **Dataset:** Belarus piano measurements (`D:/repos/RoomResponse/piano`)
- **Scenarios:** 78, 6 channels (4 response: ch0, ch1, ch3, ch4; force: ch2; reference: ch5)
- **Sample rate:** 48000 Hz
- **Band preset:** `extended_8band_mem_safe` (8 bands, reduced from full `extended_8band` for memory safety)
- **GPU:** NVIDIA RTX 4090 (24 GB VRAM), CuPy acceleration enabled
- **System:** 16 GB RAM, Windows 10

## Band Configuration (extended\_8band\_mem\_safe)

| Band | Range (Hz) | Filter Order | Decimation | Exp Factor | Model Order | Window Length |
|------|-----------|-------------|-----------|-----------|------------|--------------|
| Ultra-Low | 30-100 | 4 | 1 | 0.15 | 8 | 4000 |
| Low | 80-200 | 4 | 1 | 0.15 | 10 | 3200 |
| Low-Mid | 180-400 | 5 | 1 | 0.15 | 20 | 2000 |
| Mid | 350-700 | 5 | 1 | 0.15 | 25 | 2000 |
| Mid-High | 600-1200 | 6 | 1 | 0.10 | 30 | 2000 |
| High | 1000-2500 | 6 | 1 | 0.08 | 30 | 2000 |
| Upper | 2000-4500 | 8 | 1 | 0.05 | 30 | 2000 |
| Top | 4000-6000 | 8 | 1 | 0.03 | 30 | 2000 |

Compared to original `extended_8band`: Ultra-Low window reduced 12000 to 4000, Low window reduced 9600 to 3200, model orders capped at 30 (from up to 50). This was necessary because the full `extended_8band` caused system RAM exhaustion (17+ GB) and NVIDIA TDR timeouts on the 16 GB system.

## Results Comparison (8-band mem\_safe vs previous 4-band)

### ESPRIT Extraction

| Metric | 8-band mem\_safe | 4-band standard | Change |
|--------|----------------|----------------|--------|
| Scenarios | 78/78 (100%) | 78/78 (100%) | same |
| Total modes | 6,427 | 4,218 | +52% |
| Avg modes/scenario | 82.4 | 54.1 | +52% |
| Mode range per scenario | 78-87 | 50-57 | wider |
| Avg time/scenario | 22.6s | ~14s | +61% |
| Total ESPRIT time | 29.4 min | ~18 min | +63% |
| Errors | 0 | 0 | same |

### Mode Tracking

| Metric | 8-band | 4-band | Change |
|--------|--------|--------|--------|
| Total chains | 376 | 317 | +19% |
| Bass chains | 176 | N/A | -- |
| Treble chains | 200 | N/A | -- |
| Stable | 152 (40.4%) | 67 (21.1%) | +127% |
| Semi-stable | 118 (31.4%) | 121 (38.2%) | -2% |
| Weak | 73 (19.4%) | 98 (30.9%) | -26% |
| Spurious | 33 (8.8%) | 31 (9.8%) | +6% |

### Feedin Extraction

- 376 modes across 88 pitches (78 measured + 10 interpolated)
- 4 response channels (ch0, ch1, ch3, ch4)
- Extraction time: 0.15s

### Pipeline Timing

| Phase | Duration |
|-------|----------|
| ESPRIT extraction | 29.4 min |
| Mode tracking | 0.3s |
| Feedin extraction | 0.2s |
| **Total** | **29.5 min** |

## First 15 Stable Modes (sorted by frequency)

| # | Freq (Hz) | Damping | Coverage | Detections |
|---|-----------|---------|----------|------------|
| 1 | 56.59 | 0.060126 | 51.0% | 25 |
| 2 | 60.11 | 0.062966 | 86.2% | 25 |
| 3 | 85.36 | 0.055390 | 51.7% | 15 |
| 4 | 87.87 | 0.045935 | 58.6% | 17 |
| 5 | 105.92 | 0.033688 | 61.2% | 30 |
| 6 | 107.10 | 0.051697 | 65.5% | 19 |
| 7 | 129.00 | 0.039220 | 58.6% | 17 |
| 8 | 187.35 | 0.048120 | 59.2% | 29 |
| 9 | 191.23 | 0.046532 | 72.4% | 21 |
| 10 | 194.35 | 0.040182 | 55.1% | 27 |
| 11 | 213.80 | 0.031463 | 86.2% | 25 |
| 12 | 218.26 | 0.033838 | 95.9% | 47 |
| 13 | 236.25 | 0.032496 | 86.2% | 25 |
| 14 | 243.56 | 0.028521 | 51.0% | 25 |
| 15 | 253.92 | 0.029464 | 57.1% | 28 |

## Key Findings

1. **52% more modes extracted** with 8 bands vs 4, providing denser modal coverage.
2. **Stable chain count more than doubled** (152 vs 67, +127%).
3. **Weak chains reduced by 26%** -- better frequency resolution means fewer ambiguous detections.
4. **Memory-safe config was essential** for 16 GB system -- full `extended_8band` window lengths (12000/9600) cause system RAM exhaustion.
5. **GPU memory cleanup** (`_free_cupy_memory`) between scenarios works correctly -- VRAM cycled between 13-17 GB without accumulation.
6. **Per-scenario comprehensive logging** confirmed working via `FileHandler` in `modal_adapter/__init__.py`.

## Known Issues

1. Full `extended_8band` (model\_order up to 50, window 12000/9600) crashes on 16 GB RAM systems due to Hankel matrix memory requirements.
2. Mode count (82 avg) is lower than full `extended_8band` would produce (113-120) due to reduced model orders.
3. NVIDIA TDR (Event 153) can kill long-running GPU kernels on Windows WDDM driver.

## Output Location

- **ESPRIT scenarios:** `D:/tmp/belarus_78_extended_8band/modal_adapter/esprit/`
- **Tracking chains:** `D:/tmp/belarus_78_extended_8band/modal_adapter/tracking/chains.json`
- **Feedin data:** `D:/tmp/belarus_78_extended_8band/modal_adapter/feedin/feedin_data.json`
- **Pipeline log:** `D:/tmp/belarus_78_extended_8band/pipeline.log`
- **Modal adapter log:** `D:/tmp/belarus_78_extended_8band/modal_adapter.log`
