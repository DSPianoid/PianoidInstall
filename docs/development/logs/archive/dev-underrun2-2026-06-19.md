# Dev Session Log

- **Agent:** dev-underrun2
- **Task:** Take over the underrun/profiling investigation from stalled dev-underrun. 3 deliverables: (1) realtime underrun rate-sweep + attribution; (2) e5/add_ms pure-kernel-time .cu fix + profiling-flag confirm + heavy build; (3) chartFunctions sound_test switch to add_ms (pure kernel) + every-3rd-cycle re-check.
- **Started:** 2026-06-19
- **Status:** In Progress

## Deliverable 1 — Realtime underrun rate-sweep (DONE)

Approach (per coordinator handoff — in-process audio_on init HANGS on this box):
- Backend started via launcher REST `:3001/api/start-backend` (documented stable audio_on path), preset IversPond_ESPRIT_128modes audio_on=1 SDL3(2) iter=8 buf=4 vol=80 listen_to_modes=0.
- Telemetry read via a TEMPORARY read-only diagnostic endpoint `/diag_rate_sweep` added to backendServer.py (Python-only, no rebuild; REMOVE at close-out). It drives NOTE_ON/OFF at the rate via `schedule_event`, opens one initTimeRecord/startProfiling window, reads getCallbackStats + getTimeRecord + getGpuProfilingData.
- 5 rates idle/2/8/20/40 note-ons/sec, 30s each, single engine instance across all rates.

PROFILING FLAG: getGpuProfilingData() returns REAL per-cycle data (22499 rows/30s) — PIANOID_ENABLE_PROFILING=1 IS compiled into the installed release pyd. No rebuild needed for profiling.

### Attribution table (budget 1333us = 64@48k)

```
  rate  notes    cyc   undr%   over%   cb_max  cb_std  add_med  add_p95  full_med  full_p95  full_max
  idle      0  22450    0.00   13.46    11033     189      533      549       858      4689     13576
   2/s    120  22446    0.07   13.37    11048     188      538      559       862      4686     13988
   8/s    475  22435    0.47   13.38    11085     188      538      559       863      4665     26620
  20/s   1141  22448    0.00   13.43    11046     188      537      555       864      4634     11254
  40/s   2165  22448    0.00   13.36    11006     189      537      555       868      4588     12787
```

Measurement-chain validation: notes confirmed reaching engine (playback_stats events_processed==events_pushed, no drops). param_ms/gauss_ms medians are 0 because parameterKernel/gaussKernel fire only on note-LANDING cycles (param_nonzero=0, gauss_nonzero=1 across 8950 cycles at 40/s) — negligible in the hot path; addKernel (main synthesis) runs every cycle.

### VERDICT: SYSTEM HICCUPS, not GPU slowdown
- add_median (pure GPU kernel device time) FLAT at ~530-538us (0.9% spread) idle->40/s = 40% of budget.
- over_budget% FLAT at ~13.4% — does NOT track note rate.
- underruns near-zero (max 0.47% at 8/s = noise).
- full_median (~860us) - add_median (~535us) = ~325us flat host-side per-cycle overhead; the over-budget tail (full_p95 ~4600us, full_max up to 26ms) is host/scheduler jitter, NOT kernel time.
- cb_avg ~10ms, cb_max ~11ms: callback covers ~8 cycles at buf=4.

## Deliverable 2 — e5/add_ms placement (FINDING: brief premise was WRONG)

The brief asked to move the add_ms event e5 from BEFORE the line-368 cudaDeviceSynchronize
to AFTER it, claiming the pre-sync placement measures launch-ENQUEUE latency rather than
device time. MEASUREMENT DISPROVED this:

- BEFORE any rebuild (original installed pyd, e5 pre-sync): add_median = 530-538us, stable,
  non-zero across the whole rate sweep. => the original code ALREADY measured true device time.
- I made the brief's edit (e5 AFTER the sync) + heavy --both build. Result on the new build:
  add_ms = ALL ZERO (cadence run add_median_us=0, add sample all 0.0).
- ROOT CAUSE: cudaEventElapsedTime(e4,e5) requires the END event (e5) to have COMPLETED. With
  e5 recorded BEFORE the line-368 sync, that sync completes e5 before elapsedMs reads it (correct).
  With e5 recorded AFTER the sync, nothing syncs e5 before elapsedMs → cudaErrorNotReady → ms=0.
- Mechanism the brief missed: e4 (pre-launch) and e5 (post-launch-enqueue, pre-sync) bracket the
  kernel ON THE STREAM; CUDA events carry DEVICE-side timestamps in stream order, so e5's
  timestamp is AFTER the kernel completes. e4→e5 already = true addKernel device time.
- RESOLUTION: reverted to the original placement (e5 before sync, elapsedMs after sync). The .cu
  diff vs HEAD is now COMMENT-ONLY (code byte-identical to original) documenting why the placement
  is correct + why the "fix" would zero add_ms.

PIANOID_ENABLE_PROFILING: confirmed compiled into the installed release pyd (getGpuProfilingData
returns real per-cycle data). NO build change needed to enable it.

NET: NO functional .cu change required for add_ms correctness. Rebuild #2 restores the correct
(non-zero) add_ms after my broken intermediate build.

## Deliverable 3 — sound_test profiling chart switched to add_ms (DONE)

chartFunctions.py: the sound_test online profiling chart now plots getGpuProfilingData add_ms
(pure addKernel DEVICE time, ms→us) instead of the full-cycle host span r[4]-r[1]. Kept the
1333us budget markLine + over-budget/underrun markers + callback summary. Full-cycle host span
now reported as CONTEXT text only ("Full-cycle host span (us)"). Online branch also arms
resetProfiling/startProfiling and reads getGpuProfilingData; allow-list + unit tests updated.
Unit tests: 16 profiling (rewritten for add_ms) + 52 sound_test = 68/68 green.

### EVERY-3RD-CYCLE PROOF (user-confirmed sync-wait, not a defect)
Cadence run (8/s, 20s, corrected build), over-budget rate by cycle phase (i%3):
- FULL-cycle host span:  phase0 19.8%, phase1 13.2%, phase2 7.2%  (periodicity PRESENT; sample
  shows periodic 3958us/4829us spikes among ~870us cycles = the audio-clock back-pressure wait).
- ADD_MS pure kernel:    phase0 0.0%,  phase1 0.0%,  phase2 0.0%   (periodicity ABSENT; flat
  ~510-546us every phase). => the every-3rd over-budget lives ENTIRELY in the host sync wait
  (pushCycleAudioToDriver), NOT in GPU compute. Switching the chart to add_ms removes the artifact.

## FINAL attribution table — corrected build (TRUE add_ms device time)
IversPond 128modes, SDL3, iter=8, buf=4, 30s/rate, budget 1333us:
```
  rate  notes   undr% ovr%(full)  add_med  add_p95  add_max  full_med   cb_max  cb_std
  idle      0    0.67     13.45      537      546     1261       872    11012     188
   2/s    120    0.73     13.33      537      546     1403       872    11061     189
   8/s    474    1.27     13.27      537      546     1303       872    11000     187
  20/s   1137    0.53     13.37      537      545     1312       871    11077     188
  40/s   2148    1.40     13.43      536      545     1472       876    10981     189
```
add_median FLAT 536-537us (0.1% spread) = 40% of budget, regardless of note rate.

### VERDICT (answers "GPU slowdown or system hiccups?"): SYSTEM HICCUPS.
- True GPU kernel device time (add_ms) is FLAT at ~537us across idle→40/s — it does NOT rise
  with note rate and never approaches the 1333us budget. GPU compute is NOT the bottleneck.
- The over-budget cycles (~13.4%, flat) and the rare real underruns (<1.4%, no rate trend) are
  HOST-SIDE: the audio-clock sync wait (every-3rd back-pressure, normal) plus occasional
  scheduler/callback jitter (cb_max ~11ms, cb_std ~188us). Not GPU slowdown.

## Cleanup TODO at close-out
- REMOVE the temporary /diag_rate_sweep endpoint from backendServer.py (throwaway measurement tool).
