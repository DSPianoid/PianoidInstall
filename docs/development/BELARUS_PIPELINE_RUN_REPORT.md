# Belarus Piano -- Modal Adapter Pipeline Run Report

**Date:** 2026-04-07  
**Operator:** Automated pipeline via Claude agent  
**Outcome:** SUCCESS -- 78/78 scenarios processed, feedin generated for 88 pitches

---

## 1. Summary

A full modal adapter pipeline run was executed against the Belarus piano measurement data on 2026-04-07. The pipeline extracted modal parameters from 78 bridge-position scenarios using the ESPRIT algorithm, tracked 317 mode chains across scenarios, and generated feedin coefficients covering MIDI pitches 21--108 (88 keys, full piano range).

The run initially attempted the `extended_8band` ESPRIT preset but encountered out-of-memory failures starting around scenario 39/78. The pipeline was restarted with the `standard_4band` preset, which completed all 78 scenarios successfully. The backend was launched on port 5050 due to a stale socket on port 5000.

---

## 2. Configuration

### ESPRIT Parameters

| Parameter        | Value             |
|------------------|-------------------|
| Band preset      | `standard_4band`  |
| MAC threshold    | 0.9               |
| Frequency tolerance | 1%             |
| GPU acceleration | Yes (CuPy)        |
| TLS-ESPRIT       | Yes               |
| Max damping ratio | 0.2              |
| Window length    | 2000 samples      |

### Mapping Configuration

| Parameter        | Value             |
|------------------|-------------------|
| Pitch offset     | 21 (MIDI)         |
| Bridge boundary  | Scenario 28       |
| Response channels | 0, 1, 3, 4       |
| Skipped channels | 2 (force), 5 (reference) |
| Channel roles    | 0=response, 1=response, 2=force, 3=response, 4=response, 5=reference |

### Why `extended_8band` Failed

The `extended_8band` preset defines 8 frequency bands with larger Hankel matrices. During processing (around scenario 39/78), the following OOM errors appeared:

- **Ultra-Low band:** Hankel matrix shape `(12000, 16801)` -- required **1.50 GiB** allocation
- **Low band:** Hankel matrix shape `(9600, 19201)` -- required **1.37 GiB** allocation
- **All other bands (Low-Mid through Top):** shape `(2000, 26801)` -- required **409 MiB** each

Combined with CuPy GPU memory pressure (`cudaErrorMemoryAllocation: out of memory`) and host pinned-memory failures (428 MB and 1.6 GB), the system could not sustain the 8-band decomposition. The `standard_4band` preset uses smaller matrices and completed without OOM.

### Backend Port

The backend was launched on **port 5050** (instead of the default 5000) because a stale socket from a previous session was holding port 5000. The startup script (`start_backend.py`) explicitly set `port=5050`.

---

## 3. Results

### 3.1 ESPRIT Decomposition

- **78/78 scenarios** processed successfully
- **4218 raw modes** extracted across all scenarios (avg 54.1 per scenario, range 50--57)
- **36 merged modes** (cross-band duplicates removed)

### 3.2 Mode Tracking

317 mode chains were identified by tracking modes across the 78 scenarios:

| Stability Class | Count | Percentage |
|-----------------|-------|------------|
| Stable          | 67    | 21.1%      |
| Semi-stable     | 121   | 38.2%      |
| Weak            | 98    | 30.9%      |
| Spurious        | 31    | 9.8%       |
| **Total**       | **317** | **100%** |

- **Frequency range:** 31.9 Hz -- 4651.9 Hz
- **Coverage:** min 0.020, max 0.931, mean 0.339 (fraction of scenarios where mode was detected)
- **Stabilization points:** 4182 total (individual mode detections across scenarios)

### 3.3 Feedin Generation

| Metric              | Value                       |
|----------------------|-----------------------------|
| Measured pitches     | 78 (MIDI 24--108, with gaps) |
| Interpolated pitches | 10 (MIDI 21--23, 59, 68--73) |
| Total feedin pitches | 88 (MIDI 21--108)           |
| Mode frequencies     | 317                         |
| Response channels    | 4 (channels 0, 1, 3, 4)     |

**Measured pitch gaps** (filled by interpolation):

- MIDI 21--23: below lowest measurement (extrapolated down)
- MIDI 59: gap in mid-range measurement data
- MIDI 68--73: gap in upper-mid measurement data

---

## 4. Timing

Timing derived from file modification timestamps and backend log entries (all times UTC+3):

| Phase                  | Start    | End      | Duration   |
|------------------------|----------|----------|------------|
| Backend startup        | ~08:34   | 08:35    | ~1 min     |
| ESPRIT (with OOM retries) | ~08:35 | 08:53:21 | ~18 min |
| Mode tracking          | 08:53:21 | 08:53:40 | ~19 sec    |
| Feedin generation      | 08:53:40 | 08:53:53 | ~13 sec    |
| Result export          | 08:53:53 | 08:54:00 | ~7 sec     |
| Stabilization plot     | 08:54:00 | 08:54:37 | ~37 sec    |
| **Total pipeline**     | **~08:34** | **08:54:37** | **~20 min** |

The ESPRIT phase dominated the runtime. A significant portion of the 18-minute ESPRIT phase was consumed by failed `extended_8band` attempts that triggered OOM before falling back to `standard_4band`. The tracking and feedin phases completed in under 40 seconds combined.

Per-scenario ESPRIT average: approximately **14 seconds** (for successful `standard_4band` runs, excluding OOM retry overhead).

---

## 5. Data Locations

### Input

| File | Path | Size |
|------|------|------|
| Measurement data | Belarus ESPRIT v2 recordings (loaded via preset) | -- |
| Mapping config | `D:/tmp/belarus_78_full_run/modal_adapter/mapping/mapping_config.json` | 312 B |
| Startup script | `D:/tmp/belarus_78_full_run/start_backend.py` | 320 B |

### Intermediate Files

| File | Path | Size |
|------|------|------|
| ESPRIT metadata | `D:/tmp/belarus_78_full_run/modal_adapter/esprit/metadata.json` | 959 B |
| ESPRIT scenarios (78 files) | `D:/tmp/belarus_78_full_run/modal_adapter/esprit/scenario_*.json` | 332 KB total |
| Tracking chains | `D:/tmp/belarus_78_full_run/modal_adapter/tracking/chains.json` | 504 KB |
| Feedin data (internal) | `D:/tmp/belarus_78_full_run/modal_adapter/feedin/feedin_data.json` | 844 KB |

### Output Files

| File | Path | Size |
|------|------|------|
| Tracking results | `D:/tmp/belarus_78_full_run/tracking_results.json` | 272 KB |
| Feedin results | `D:/tmp/belarus_78_full_run/feedin_results.json` | 620 KB |
| Stabilization data | `D:/tmp/belarus_78_full_run/stabilization_data.json` | 668 KB |
| Stabilization diagram | `D:/tmp/stabilization_diagram.png` | 904 KB |
| Backend log | `D:/tmp/belarus_78_full_run/backend.log` | 28 KB |
| Plot script | `D:/tmp/belarus_78_full_run/plot_stabilization.py` | 3.6 KB |
| **Total run directory** | `D:/tmp/belarus_78_full_run/` | **3.3 MB** |

### Directory Structure

```
D:/tmp/belarus_78_full_run/
  backend.log
  start_backend.py
  plot_stabilization.py
  tracking_results.json
  feedin_results.json
  stabilization_data.json
  modal_adapter/
    esprit/
      metadata.json
      scenario_0.json .. scenario_77.json  (78 files)
    tracking/
      chains.json
    feedin/
      feedin_data.json
    mapping/
      mapping_config.json
    output/                                (empty)

D:/tmp/
  stabilization_diagram.png
```

---

## 6. Problems Encountered

### 6.1 `extended_8band` OOM Failure

The pipeline first attempted the `extended_8band` ESPRIT preset, which failed around scenario 39/78 with memory allocation errors. All 8 bands failed with OOM on every subsequent scenario:

- Ultra-Low band required 1.50 GiB for a single Hankel matrix `(12000, 16801)`
- Low band required 1.37 GiB for shape `(9600, 19201)`
- Six remaining bands each required 409 MiB for shape `(2000, 26801)`
- CuPy GPU pinned-memory allocations of 428 MB and 1.6 GB also failed
- `init_gesdd failed init` errors appeared (LAPACK SVD initialization failure under memory pressure)
- One Werkzeug `MemoryError` occurred on a status poll request (line 174 of backend.log)

**Resolution:** Switched to `standard_4band` preset, which completed all 78 scenarios.

### 6.2 Port 5000 Stale Socket

Port 5000 was occupied by a stale socket from a previous backend session. The startup script was configured to use port 5050 as a workaround.

### 6.3 Agent Rate Limits

The first two automated agent attempts to run the pipeline were interrupted by API rate limits. The third attempt completed successfully.

### 6.4 Telegram MCP Plugin Crash

The Telegram MCP plugin, used for monitoring pipeline progress, crashed during the run. This did not affect pipeline execution but disrupted real-time status reporting.

---

## 7. Stabilization Diagram

The stabilization diagram is saved at `D:/tmp/stabilization_diagram.png` (904 KB, 150 DPI).

### What It Shows

The diagram plots all 4182 mode detection points across the 78 scenarios (x-axis: scenario index / bridge position, y-axis: frequency on a logarithmic scale from 25 Hz to 6000 Hz). Each point represents a mode detected by ESPRIT in a given scenario, color-coded by chain stability:

- **Green circles** (stable, 67 chains) -- modes consistently detected across many scenarios with low frequency drift
- **Yellow squares** (semi-stable, 121 chains) -- modes detected in a moderate number of scenarios
- **Orange triangles** (weak, 98 chains) -- modes with sparse detections or high frequency drift
- **Gray crosses** (spurious, 31 chains) -- modes appearing in very few scenarios, likely noise artifacts

Points belonging to the same chain are connected with thin lines, showing how each mode's frequency evolves across bridge positions. A **red dashed vertical line** at scenario 28 marks the bridge boundary (the transition between two measurement regions).

The stable chains form clear horizontal bands across the full scenario range, representing the piano's true resonant modes. The density of stable chains is highest in the 50--2000 Hz range, consistent with the fundamental and low-order partial frequencies of a piano soundboard.
