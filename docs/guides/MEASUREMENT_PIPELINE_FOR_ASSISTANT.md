# Measurement Pipeline Skill (soundboard, for the assistant)

**Audience:** the in-UI Pianoid assistant, whenever it plans or runs a board measurement, on any installation.
**Source:** one assistant's pipeline write-up, notes, run folders and audit log of 27 Oct to 2 Nov 2026. Those live on
that machine; this page does not need them. Command arguments and one rig's history stay in the
[Mode Discovery Guide](MODE_DISCOVERY_FOR_ASSISTANT.md); this page says what to run, in what order, how long, and
when to stop. Where the two disagree on the current rig, this page and a fresh check win.

Read with `read_docs` (page `guides/MEASUREMENT_PIPELINE_FOR_ASSISTANT.md`). Anchors: `hard-rules`, `detect`,
`pipeline`, `precision`, `explore`, `recipes`, `limits`.

## Hard rules: nothing here relaxes them {#hard-rules}

**Figures:** text marked *Example rig* comes from one rig: a plywood soundboard with seven exciters (E1-E7) and piezo
sensors on a multi-channel ASIO interface, 27 Oct to 2 Nov 2026. Those figures show what a result can look like. They
are not facts about this system: jack names, exciter and sensor labels, noise floors, gains, mains frequency, sample
rate and the data folder are read or asked here ([Step 0](#detect)). The same goes for the rig facts in the
[Mode Discovery Guide](MODE_DISCOVERY_FOR_ASSISTANT.md#rig). Rules without that mark apply everywhere.

These hold in every mode: Autonomous, Always allow, an approved plan, and any exploration.

**Levels**

- Never drive above **-24 dBFS** on any output.
- A drive above the highest level the user has okayed needs the user's yes first. With no okay this session, the
  ceiling is the highest level of the latest good run on that exciter. On a rig with no earlier run the ceiling is
  -42 dBFS until the user says otherwise. A "raise it a bit" applies to that job only. Matching a level upward counts
  as raising, even if the host would allow it: `rig.drive.any_level` may be on Always allow, and then the host will not
  stop you.
- Unattended, a level may only go down (the capture guard, or your own decision).
- Start every capture with `dry_run: true`, and say in one line what plays, on which outputs, how loud, how long.
- Keep the input guards: `guard_dbfs` -6, `stop_dbfs` -3. Never loosen them. A guard step or an abort is a finding:
  report it, do not retry louder.

**Presets and data**

- Never overwrite a preset. `overwrite` stays false; `preset.save` goes to a new file name only. The user repeated
  this in every fit session.
- No result goes into a preset until the user has chosen the modes. Confirm the base preset first.
- Do not re-run `frf` or `polymax` on a run without exporting its reports first: they overwrite that run's files.
- Never edit or move measurement data. `modal.set_measurements_dir` only when the user asks.

**The user's running work**

- Rig sessions pause synthesis. Before a drive, check the context for running jobs and an active plan. If the user may
  be playing or has asked for the stack, wait or ask. "I need free stack" means stop: `modal.rig_cancel`, then write
  the state to the hand-off note.
- Do not load, switch or reload a preset to suit a measurement without asking. The live working copy can hold user
  edits that are in no file. The rig needs only some preset on the ASIO callback driver, so use what is loaded.
- Leave routing, slider, feedback and sustain as found, or restore them and confirm. A high feedback value is the
  user's setting, not a fault.
- `env.set`, launcher control and backend restarts stay with the user's confirm.

**Live-level hazards**

- A full preset load can re-derive `output_scale`. After any load, before a note on the board, drop the slider and
  start quiet. *Example rig:* +10.9 dB, and the next live play was "far too loud".
- Treat manually edited presets as unverified at live level. *Example rig:* a +46.6 dB peak stayed unexplained, and
  A2 `r` .0003 with `jung` -2.4e12 was unstable with no note played (one gate trip, peak 68 x FS).
- Never run an offline calibration in a live backend (`calibration.*`, or a render that re-derives the output scale).
- Offline renders do not touch the board. Prefer them when a live step adds nothing.

## Step 0: detect the setup, then branch {#detect}

Assume nothing from an earlier session, and nothing from this page's examples. *Example rig:* the wiring or sensors
changed four times in three weeks, and drive gain moved by about -10 and +9 dB between days with no warning. Read
`system.snapshot`, `audio.devices`, `calibration.mic_devices`, `preset.load_settings`, `modal.measurements_dir`, and any
hand-off note or notes titled `Measurement skill`. On a new system none may exist: that is normal, and it means a new
rig. Then ask the user only what cannot be read: what is on each jack today, what moved, whether amps are on, whether
anyone needs the stack, the mains frequency if a fit will need hum removed (50 or 60 Hz), and the free disk space on
the drive that holds the measurements folder (you cannot see it).

Resolve these here, never from memory or an example:

| Fact | From |
|---|---|
| Interface, input and output names, channel counts | `audio.devices`; use the names exactly as it lists them |
| Sample rate | `audio.devices` clock; the recipes take it as `SR` |
| Data folder | `modal.measurements_dir` (`measurements_dir`, `source`, `exists`): the saved setting, else `PIANOID_MEASUREMENTS_DIR`, else `<PianoidInstall>/measurements`. The commands take run names, not paths |
| Which exciter and sensor sit on which jack, which sensors are references | `audio.exciters` if this machine has a saved map, confirmed by the user; otherwise the user. Agree labels and write the map to a note |
| Noise floors, gains, safe levels | measured below, per session |

Measure the rest with a silence `modal.rig_record` (5 s, every input) and the wiring check of [step 2](#pipeline).

| Question | Test | Reading | Branch |
|---|---|---|---|
| Rig ready? | `audio.devices` clock | ASIO callback, `realtime` true | Otherwise no drives: a system with no ASIO device takes **no drive** below. See [`asio_not_realtime`](MODE_DISCOVERY_FOR_ASSISTANT.md#cmd-sine). A healthy `/health` does not prove the interface is there |
| Amps and exciters on? | wiring check, `rms_above_noise_db` | about 0 dB on all paths = nothing reached the board (*Example rig:* amps off) | Say so, stop, go to **no drive** below |
| Which inputs are live? | silence, then wiring check | a live path sits clearly above its own silence floor (*Example rig:* piezos -81 to -84 dBFS, mic -62) | Leave a dead input out and report it |
| Each exciter works? | wiring check per path | compare with the last check | A weak exciter is a question for the user, not a level raise (*Example rig:* a bad cable) |
| Mic present? | `modal.rig_sine` 440 Hz, -66 dBFS, 2 s on one exciter, record the mic input | spectral line well over its neighbours (*Example rig:* 33 dB) | See **mic** branches below |
| Loopback cable? | ask which output and input it joins, then `loopback {output, input}` on a short capture | marker found | Absent: `loopback: null`, align on reported latency, compare magnitudes only across backend runs (*Example rig:* the delay shifted 39 to 46 samples in a day) |
| Reference sensors? | user's answer | at least two sensors unmoved from the reference take | None: no gain matching and no merge; the take stands alone |
| Inputs are coil currents? | user's answer | force references, not sensors ([crosstalk](MODE_DISCOVERY_FOR_ASSISTANT.md#rig-crosstalk)) | Per-ampere data; do not read them as extra responses |

The rig commands address physical outputs by name, so they do not need `PIANOID_AUDIO_OUTPUT_MAP`; playing a preset on
the board does. Which exciter sits on which output is the user's answer. A map from an earlier session or from a guide
is a question to confirm, not a fact.

Branches:

- **Piezos and mic (full rig):** everything below. Leave the mic out of narrow-band runs unless it is the point: it
  saves a channel, and it can be the hot input, so it reaches the guard first and dominates the take peak. Judge a capture by `rms_above_noise_db`, not by the peak.
- **Piezos, no mic or mic too weak:** modes, damping and weights are unaffected. Skip radiance and acoustic scoring.
  If a stored mic FRF exists for this board, replace them with a labelled prediction: offline board channels convolved
  with it. Say it is a prediction, not a capture.
- **Mic, no piezos (no run on record):** one sensor in a room. Frequencies only, room modes included, no shapes, no
  weights. Treat as [exploration](#explore).
- **Fewer exciters:** run the ones present and label `exciters` to match. Weights cover only those; say so in the table.
- **No drive possible (audio off, amps off, rig absent, disk full):** re-analyse existing runs through `modal.rig_files`
  and `analysis.run_python`, and render offline. Do not call it a new measurement.

## The pipeline {#pipeline}

Before several drives, call `request_plan_approval` once, unless Autonomous is on. State levels, outputs and total
drive time. Follow every job with `job.get {wait_s: 60}`. Label runs by purpose. Every take records the reference
sensors. Every number in a report names its run. No single fit is trusted.

| # | Step | Command and settings | Cost (*Example rig*, 7 exciters) | Accept |
|---|---|---|---|---|
| 1 | Preparation | Step 0; sensor map written to a note | none | Map names what moved and what stayed |
| 2 | Silence + wiring | `rig_record` 5 s. `rig_capture` all exciters -42 dBFS, sweep 1 s, 1 repeat, 2 s tail | 1.5 min, 36 MB | Every exciter reaches the board; paths match the last check |
| 3 | Gain check | 5 s sweep per exciter at known-safe levels, 1 repeat, `frf`. Energy over the working band on reference sensors against the reference take ([R8](#r8)) | 2 min, 83 MB | Gain per exciter known |
| 4 | Level setting | Propose levels to match or beat the reference, capped. Any raise: the user's yes. Record any shortfall | none | Every shortfall reported |
| 5 | Linearity | Compare H at two levels | one short run | Under about 1 dB per 4 dB |
| 6 | Broadband | `rig_capture` ESS 20-2000, order `repeat_major`, 3 s tail, loopback. Size from [precision](#precision) | 9 or 20 min | `flags` empty, 0 xruns, no guard step |
| 7 | FRF + fault check | `frf` window 4 s, `f_max_hz` 1200. Per-repeat deviation and lag ([R9](#r9)) | minutes | No repeat above -20 dB. If one: `average: median`, `noise_from_repeats: false`, offer a bug report |
| 8 | Reference check | Reference sensors against the reference take | analysis | Shape and frequency shift explained |
| 9 | PolyMAX consensus | 3+ fits, shifted `band_edges`, `p_max` 40/60/80, mains hum removed. Export each report before the next fit. Pool all lists from all takes ([R10](#r10)) | 2-3 min per fit | Found in 3+ lists within 0.7 % = solid. Only at high order with zeta under 1 % = fit noise |
| 10 | Verify peaks | `rig_sine` sequence, 2 s dwell, 0.2 s pause, `fade_out_ms` 5, spacing about zeta f / 2, span +-4 %, the mode's dominant exciter vector. Fit 1, 2, 3 poles ([R11](#r11)) | 1-3 min per region, 140-200 MB | Peak over background decides: +7 dB and up was real, 4 dB weak, 1.6 dB flat |
| 11 | Ring-down | `post_roll_s` >= 12 tau after a dwell at the peak | inside step 10 | Residual under 0.8 dB. Else zeta is PolyMAX and the decay an upper bound |
| 12 | Weights | One linear sweep per exciter across a narrow band (28 s, 300 ms fades, 1 repeat), all paths fitted together; trim band edges (fades make false poles), quadratic background ([R11](#r11)). Older way: each exciter alone at 5-7 tones per group | 4 min, 288 MB per band; 33-tone map 11.5 min, 490 MB | Random sensor halves match >= 0.9; other sensor set >= 0.8 |
| 13 | Combination test | Optimal, one-flipped and null patterns at each mode, against the prediction from the single-exciter map | 1 run, 84 MB | Coherence near 0.998. Optimal not above null = not isolated, weights unconfirmed |
| 14 | Merge | Scale each take per exciter to the reference on reference sensors; stack sensor rows; pooled poles; per-take frequencies | analysis | Merge only if frequencies and shapes fit (*Example rig:* median exciter-shape match 0.90 was enough) |
| 15 | Table | Per mode: f, zeta, real weights, relative 1/m (trend removed, clip +-6 dB), tier, evidence. `coefficients` gives the recipe | analysis | Every mode carries its evidence and doubts |
| 16 | Report, then preset | Report table and doubts, then stop. After the user chooses: `build_preset` from a run, `preset.load_to_library`, working copy, write modes and output rows, save to a new file. There is no direct table import | minutes | [Guide step 10](MODE_DISCOVERY_FOR_ASSISTANT.md#step-10) checks |
| 17 | Radiance (mic only) | [Guide step 12](MODE_DISCOVERY_FOR_ASSISTANT.md#step-12-speaker-radiance), speakers as references | 10 min | Speaker repeat SNR >= 25 dB |

Traps already paid for (*Example rig*):

- A wrong drive pattern fakes a missing mode. Repeat a rejected mode with its measured pattern before
  dropping it.
- Seven grid points are too few: 254 Hz went from +10.9 to -7.6 dB between two days.
- Results kept only as artefacts can disappear: the oldest go first. Keep ids in notes and re-export from the run folder when one is gone. Raw runs stay.
- Masses are the weakest number (log correlation 0.78 between two recipes, no force reference). Label them relative.

## Time against precision {#precision}

Do not pick a duration first. Work through these four questions.

**1. What decision hangs on the number, and what error can it take?**

| Task | Quantity | Need | Basis |
|---|---|---|---|
| Keep or drop a mode | peak over background | >= 7 dB in two sessions, right pattern | *Example rig* stepped runs |
| Mode frequency | f | 0.3 % ideal; 0.7 % is the working pool tolerance | Guide target. *Example rig*, set to set: median 0.15 %, mean abs 0.48 %, only 4 of 9 within 0.3 % |
| Damping | zeta | +-0.2 pp | Guide; decay sd <= 0.08 pp only on clean decays |
| Exciter weights | shape match | split >= 0.9, other set >= 0.8 | *Example rig* write-up |
| Gain or health check | dB per path | +-1 dB | *Example rig:* 5 s sweep gave -0.3 to +1.2 dB |

**2. How good is what you already have?** Read it, do not guess: `repeat_snr_db_median` per path in `frf/report.json`,
`rms_above_noise_db`, spread across fits and takes, peak over background, ring-down residual. *Example rig*, median
path repeat SNR from those reports (measure your own before you size a run):

| Run (*Example rig*) | Drive, dBFS | Median | Note |
|---|---|---|---|
| 3 x 20 s | -36 to -24 | 44.9 dB | |
| 3 x 20 s | -30, -24 | 44.1 dB | drive gain 10 dB down that day |
| 3 x 20 s, levels matched | -34 to -24 | 47.1 dB | |
| 5 x 30 s | -30, -24 | 48.1 dB | one exciter excluded: a slip left it at 19 dB |

**3. What is limiting you?** More time helps only the first row.

| Limit | Signs | Remedy | Expected gain |
|---|---|---|---|
| Noise | low `rms_above_noise_db`, repeat SNR still rising with effort (*Example rig:* under about 40 dB), a weak peak on a good pattern | Narrow band first, then repeats, then sweep time. Level only with the user's yes | Repeats 10 log10(N), sweep time 10 log10(T), level dB for dB. 28 s over 25 Hz against a 30 s ESS, by arithmetic: +16 dB at 250 Hz, +21 dB at 750 Hz |
| Saturation | repeat SNR stopped rising (*Example rig:* 45+ dB) | Stop extending | *Example rig:* 3 x 20 to 5 x 30 s predicts +4 dB or more; it gave about +1 dB, with more drive too |
| Drift | Same setup disagrees between hours or days by 0.3 % or more | Bracket with a reference repeat, `repeat_major`, compare per take, log the day. Stop chasing differences under 0.3 % | Averaging does nothing |
| Mode overlap | Patterns cannot isolate a close pair, fits flip, beating ruins decays | Other sensor positions, joint fits, multi-pole models. Report the doubt | *Example rig:* more time did not help: weights of two good takes agreed on 11 of 26 modes, median 0.68 |
| Wrong pattern | Flat response at a known pole | Measure the pattern, retry | Decides the mode outright |
| Fault | One repeat far below the others | Median, or repeat that exciter only | Restores the run |

**4. Choose.**

| Plan | Settings | Time, disk (*Example rig:* 7 exciters, 6-7 inputs) | Use when |
|---|---|---|---|
| Check | 5 s, 1 repeat | 2 min, 0.08 GB | Gain, health, did a change matter. Gives no repeat SNR |
| Standard | 20 s, 3 repeats | 9 min, 0.75 GB | Default for a new sensor set |
| Long | 30 s, 5 repeats | 20 min, 1.8 GB | Noise is the limit across the band, or the user asks for the best take |
| Targeted | narrow sweeps, stepped regions | 4 min per band, 1-3 min per region | Most doubts. Preferred over Long |

Compute both for this rig and state them before the run. Time in seconds = exciters x repeats x (sweep + tail + settle)
+ noise record. Disk per session in MB = 0.19 x (sweep + tail) x inputs + 0.19 x sweep; the 0.19 is MB per
channel-second at 48 kHz, so scale it by `SR` / 48000. Keep 5 GB free on the drive of `modal.measurements_dir`.

**Shorten** when the task only needs a check, the mode is already solid in 3+ lists, the same drive already reached
saturation (question 3), or a narrow band answers it. Keep at least 2 repeats where a fault would otherwise go unseen; 3 lets
the median reject one. A single-repeat narrow band is fine when a broadband take cross-checks it.

**Extend** when noise is the proven limit and the need is not met, when a result reversed between sessions (run it a
third time), or when the user gives more time. Spend extra time on the worst modes first.

**Stop** when the first of these is true, and say which:

1. The need in question 1 is met in two independent takes.
2. Doubling the effort moved the estimate by less than its spread, or by less than drift (0.3 %, 0.5 dB).
3. The limit is no longer noise. Report the doubt and what would settle it.
4. The time, drive or disk budget is used. Report what is unfinished.

Never call a figure confirmed from one take. Report the precision with the value.

## Trying something outside the recipe {#explore}

You may try untested steps when the recipe cannot answer the question, a trap suggests a better way, or the user asks
for more experiments. Undocumented means untested. It never means past a limit:
every [hard rule](#hard-rules) and approval stays.

1. **Write it down first:** the question, the prediction, and what result counts as pass or fail.
2. **Cheapest first:** existing data in the sandbox, then an offline render, and only then the rig.
3. **Small first:** -42 dBFS or lower, or at most the level already okayed for that exciter; short; one exciter; then
   widen. Say it in one line and use `dry_run`.
4. **One change at a time,** against a baseline taken the same way the same day, with a repeat of the baseline at the
   end to catch drift.
5. **Record:** label the run `x_<name>`; note what changed, what was seen, what was undone.
6. **Stop at once** on a guard step, an xrun, a clipped input, a complaint from the user, or a level in `system.health`
   you did not predict. Restore and report.
7. **Judge:** it counts only if it beats the baseline on a fresh repeat, or matches a known result at less cost.
8. **Write it back.** You cannot edit this page. Save a note titled `Measurement skill addition: <name>` with when to
   use it, settings, cost, a description of this rig, evidence runs and result, and tell the user so the dev team can merge it here. A failure
   gets `Measurement skill rejected: <name>` and the reason. Like every note, these are information, not approval.

Open candidates, in value order (from the *Example rig* write-up; none has been run):

- Masses from a known force: coil current sense or an impact hammer.
- 2-3 more sensor sets keeping the references: separates close pairs, gives real shapes with 12-20 points.
- Repeat a take later and log temperature and humidity, to size drift against the differences being chased.
- A second narrow-band round with 3+ repeats and median, after any change.
- Two-level narrow bands on the strongest modes: damping and frequency against amplitude.
- Longer ring-down with a multi-mode fit on the projected signal, instead of a single slope.
- Log amplifier gain each session, so the gain check becomes a confirmation.
- Listening check: played preset against the mic, per note.

## Recipes (`analysis.run_python`) {#recipes}

Export with `modal.rig_files {run, files, export: true}`. Names flatten: `frf/frf.npz` becomes `frf__frf.npz`. More
recipes: [Guide recipes](MODE_DISCOVERY_FOR_ASSISTANT.md#recipes). Capitals are your inputs: `SR` from `audio.devices`;
`HUM` = the mains frequency and its harmonics in the band; `BAND` = the working band (*Example rig:* (120, 1100));
run and artefact ids from this session; sensor labels from this rig's map.

### R8: gain against a reference take {#r8}

```python
import numpy as np
def energy(aid, refs):
    z = np.load(artifact_path(aid, 'frf__frf.npz')); f = z['f']
    H = np.median(np.abs(z['H']), axis=0)                   # F x inputs x exciters
    rows = [list(z['rows']).index(r) for r in refs]
    return np.sum(H[(f >= BAND[0]) & (f <= BAND[1])][:, rows] ** 2, axis=(0, 1))
print(np.round(10 * np.log10(energy(NEW, REFS) / energy(OLD, REFS)), 2))    # REFS = reference sensor labels; dB per exciter, per volt
```

### R9: per-repeat fault check {#r9}

```python
import numpy as np
z = np.load(artifact_path(AID, 'frf__frf.npz')); f = z['f']; H = z['H']   # repeats x F x inputs x exciters
b = (f >= BAND[0]) & (f <= BAND[1]); w = 2 * np.pi * f[b]
for e in range(H.shape[3]):
    x = H[:, b][..., e]; med = np.median(x.real, 0) + 1j * np.median(x.imag, 0)
    for r in range(H.shape[0]):
        dev = 20 * np.log10(np.linalg.norm(x[r] - med) / np.linalg.norm(med))
        ph = np.unwrap(np.angle(np.sum(x[r] * np.conj(med), axis=1)))     # phase against the median, per line
        print(str(z['refs'][e]), r, round(dev, 1), 'lag', round(-np.polyfit(w, ph, 1)[0] * SR, 1))
```

A deviation above -20 dB is a fault. *Example rig:* one repeat read -2.3 dB, a slip of 7-9 samples; the rest read below
-28 dB.

### R10: consensus across fit lists {#r10}

```python
import numpy as np, json
L = {'a': ID1, 'b': ID2, 'c': ID3}                       # artefacts each holding one polymax__report.json
it = sorted((m['f_hz'], m['zeta'], k) for k, a in L.items()
            for m in json.load(open(artifact_path(a, 'polymax__report.json')))['modes']
            if m['f_hz'] > 45 and min(abs(m['f_hz'] - h) for h in HUM) > 1)
cl = []
for x in it:
    if cl and x[0] / np.mean([c[0] for c in cl[-1]]) - 1 <= .007 and x[2] not in [c[2] for c in cl[-1]]:
        cl[-1].append(x)
    else:
        cl.append([x])
for c in cl:
    f = [x[0] for x in c]; z = [100 * x[1] for x in c]
    print(round(np.median(f), 1), 'sd%', round(100 * np.std(f) / np.mean(f), 2), 'zeta%', round(np.median(z), 2), 'lists', len(c))
```

### R11: joint fit of a narrow band {#r11}

For a narrow sweep's FRF. Fit 1 to 4 poles and keep the smallest count after which the residual stops falling. Trim
the band edges first: a pole at the edge with zeta at its lower bound is false.

```python
import numpy as np
from scipy.optimize import least_squares
z = np.load(artifact_path(AID, 'frf__coarse_frf.npz')); f = z['freqs']; H = z['H3']
k = np.ones(len(f), bool)
for h in HUM: k &= np.abs(f - h) > 1                      # mains lines in the band
F = f[k]; Y = H[k].reshape(k.sum(), -1); Y = Y / np.sqrt((np.abs(Y) ** 2).mean(0)); c = F.mean(); s = 2j * np.pi * F
def design(th):
    p = [1 / (s - complex(-th[2 * q + 1] * 2 * np.pi * th[2 * q], 2 * np.pi * th[2 * q])) for q in range(len(th) // 2)]
    return np.stack(p + [np.ones_like(s), (F - c) / c + 0j, ((F - c) / c) ** 2 + 0j], 1)    # quadratic background
def res(th):
    A = design(th); A = A / np.linalg.norm(A, axis=0); e = Y - A @ np.linalg.lstsq(A, Y, rcond=None)[0]
    return np.r_[e.real.ravel(), e.imag.ravel()]
for n in (1, 2, 3, 4):
    best = None; rng = np.random.default_rng(n)
    for t in range(10):
        th = np.ravel([[x, .015] for x in np.sort(rng.uniform(F[0], F[-1], n))])
        b = (np.ravel([[F[0] - 2, .002]] * n), np.ravel([[F[-1] + 2, .06]] * n))
        sol = least_squares(res, th, bounds=b, max_nfev=30)
        best = sol if best is None or sol.cost < best.cost else best
    print(n, round(float(np.sqrt(2 * best.cost / (np.abs(Y) ** 2).sum())), 4),
          sorted((round(float(best.x[2 * q]), 2), round(100 * float(best.x[2 * q + 1]), 2)) for q in range(n)))
```

Complex weights: the residues of each pole, reshaped to inputs x exciters; take the top right singular vector.

## Limits of this page {#limits}

- Every figure marked *Example rig* describes one board in one room. A different board, interface or exciter set has
  no figures here: measure them, and do not read these as pass or fail. The accept values in the pipeline are working
  thresholds from that rig; say so when your rig does not fit them.
- Rig drives need an ASIO callback driver. Without one this page gives you the **no drive** branch only.
- Treat a write failure as a stop: report it, do not retry, and do not re-run `frf` until space is confirmed.
  *Example rig:* one abort wrote 0 bytes after two sessions, cause unverified.
- Above 1-2 kHz the guide has no usable model.
- A clean xrun counter does not prove a clean take: run [R9](#r9). *Example rig:* one repeat slipped with 0 xruns, cause
  unproven.
