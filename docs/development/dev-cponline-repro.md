# cp0→cp1 spike — reproduction recipe + clean BEFORE baseline (dev-cponline, 2026-06-24)

Decisive RCA already proven (instrumented dev-cpdeep build): on a spike cycle the cp0→cp1
span is held ENTIRELY by the addKernel `cudaDeviceSynchronize` HOST-WAIT (the `COOP_SYNC`
field), NOT by OS preemption (host gaps ~0) and NOT by a code op. GPU device time stays flat.
Measured CPDEEP sample (instrumented debug build):

```
[CPDEEP] cyc=271 SPAN=8805us add_ms_device=644us | enter->refresh=0 refresh->paramLaunch=0
 paramLaunch->paramSync=0 paramSync->gauss=8 gauss->preCoop=11 preCoop->postCoopEnqueue=12
 COOP_SYNC(postCoopEnqueue->postSync)=8505 postSync->exit=267
```
COOP_SYNC = 8505us = 97% of the 8805us span. Trigger = competing CUDA submissions (chart renders).

---

## Environment / engine config (identical for AFTER)

- PROJECT_ROOT: `D:\repos\PianoidInstall`
- Backend: `PianoidCore/pianoid_middleware/backendServer.py`, launched DETACHED under the
  venv python (`PianoidCore/.venv/Scripts/python.exe`), stderr+stdout redirected to files.
  Port 5000. NO React dev server / browser tab polling :5000 (neutralize stale Chrome pages
  to `about:blank` first — they auto-APPLY competing structural load_presets and crash the
  debug backend).
- Engine: **DEBUG variant** (`pianoidCuda_debug`), preset
  `presets/Belarus_196modesC_Fanera6exc.json`, ONLINE, `audio_driver_type=4` (ASIO Callback),
  `audio_on=1`, `listen_to_midi=0`. The backend auto-inits this at boot (start_right_away=1);
  health shows `audio_driver_active:true`, `audio_driver_fallback.active:ASIO_CALLBACK`,
  `occurred:false`.
- load_preset body uses key **`path`** (NOT `preset`):
  `{"path":"presets/Belarus_196modesC_Fanera6exc.json","debug_mode":1,"audio_driver_type":4,"audio_on":1,"listen_to_midi":0}`

## The reproduction (the INDUCER + the armed capture run CONCURRENTLY)

1. **Inducer** — competing CUDA chart-render load. Start N parallel loops (N=3 light, N=5
   heavy) that continuously POST `/get_chart_test` with the two GPU-touching chart types,
   interleaved, for ~25-30s:
   ```
   POST http://localhost:5000/get_chart_test  {"chartType":"string_shape"}
   POST http://localhost:5000/get_chart_test  {"chartType":"feedin"}
   ```
   (These submit CUDA work that queues ahead of the synthesis thread's addKernel sync — the
   exact mechanism the real browser frontend triggers by polling these charts.)

2. **Armed online capture** (0.5s after the inducer starts, so the contention is live):
   a single armed Sound Test online run with profiling — this both arms the per-cycle timing
   (`initTimeRecord`) AND drives synthesis cycles:
   ```
   POST http://localhost:5000/get_chart_test
   {"chartType":"sound_test","mode":"online","include_kernel":"true","play_kind":"sequence",
    "pitches":"48,52,55,60,64,67,72,76,79,84,55,60,64,67,72","velocities":"100",
    "durations_ms":"900","tail_ms":"300","include_profiling":"true"}
   ```
   ~9s, ~5800 synthesis cycles. (On the INSTRUMENTED build, every cycle with cp0→cp1 > 5ms
   prints a `[CPDEEP]` line to the backend STDERR — grep the redirected stderr file for it.)

3. **Read the numbers** from the sound_test response `text_fields`:
   - `Underruns` (the audible symptom): "N / M callbacks (P%)"
   - `Add-kernel device time`: over-budget count (budget 1333us) + median/max device us
   - `Cycle checkpoint breakdown`: kernel(cp0→cp1), SYNC-WAIT(cp2→cp3), FULL(cp0→cp5) medians
   And from the per-cycle series in the JSON (numeric arrays > 100 long):
   - `/data[3]` = full-cycle host span (cp0→cp5) per cycle — count cycles >5ms / >20ms.
     NOTE: the FIRST 1-2 entries are a spurious idle-gap (engine idles in canProduce.wait
     before the first note fires) showing as a 40-70s "max" — EXCLUDE it; use the
     under-10ms max and the >5ms count of the real cycles.
   - `/data[4]` = add-kernel device time per cycle (proves GPU stays flat ~644us).

## CLEAN BEFORE baseline (measured 2026-06-24 on the freshly-rebuilt clean DEBUG .pyd, no CPDEEP)

Two runs under the inducer (3-loop, then 5-loop). Identical engine config above.

| run | inducer | callbacks | underruns | GPU over-budget | full-cycle median | full-cycle real-max (<10ms) | cycles >5ms (real) | add-kernel device max |
|-----|---------|-----------|-----------|-----------------|-------------------|------------------------------|--------------------|-----------------------|
| 1   | 3 loops | 5558      | 0 (0.00%) | 0 / 5554        | 1044us            | 4871us                       | 0                  | 1018us                |
| 2   | 5 loops | 5858      | 0 (0.00%) | 0 / 5854        | 1042us            | 4347us                       | 1 (idle-gap only)  | 1007us                |

Per-cycle full-cycle host span (cp0→cp5), run 2: n=5855, median 1042us, p99.5=2039us,
real-max (excluding the single idle-gap outlier) = 4347us, **>5ms real cycles = 0** (the lone
>5ms / >20ms entry is the idle-gap artifact = 68s, not a synthesis spike).
sync-wait (cp2→cp3): median 41us, max 3283us. add-kernel device: median 644us, max 1007us (FLAT).

### Interpretation of the BEFORE baseline (important caveat for the fix-proof)

On the AGENT-context system the spikes barely reproduce: 0 underruns, and the real cp0→cp1/
full-cycle stays <~4.3ms even under 5 parallel chart-render loops. The single decisive >5ms
spike (8.8ms, COOP_SYNC=97%) was caught ONLY with the lighter 2-loop string_shape+feedin
inducer at a precise timing alignment — it is RARE and timing-sensitive in agent context. The
user's 40ms spikes need their real continuous browser chart-polling (deeper, sustained GPU
queue). So the AFTER proof should either (a) run the inducer much longer / with the real
browser frontend rendering charts to push real >20ms spikes + actual underruns, or (b) prove
the fix on the COOP_SYNC mechanism directly (e.g. show the synthesis cudaDeviceSynchronize no
longer serializes behind chart-render CUDA — separate stream/context/priority, or chart-render
gating during playback). The mechanism (COOP_SYNC host-wait behind competing CUDA) is the thing
the fix must break; underrun% is the audible end-metric.

## Final state
- Clean `.pyd` installed: both `pianoidCuda` + `pianoidCuda_debug` rebuilt 2026-06-24 23:53:35,
  `--heavy --both`, CPDEEP marker ABSENT from both (grep count 0). Source reverted (working tree clean).
- Clean DEBUG backend running on :5000 (user preset, ASIO Callback, audio_on, debug variant).
