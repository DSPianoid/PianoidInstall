# Measurement Algorithm — Modal Adapter vs RoomResponse Reference: Differential Audit

**Date:** 2026-07-10
**Mode:** READ-ONLY. No source edited, nothing built, no audio device opened, no capture run, no commit.
**Trigger:** Operator hypothesis — the measurement/collection procedure was migrated *from* a
known-good RoomResponse implementation and is "wired but not tested; not sure it is intact."
**Scope:** The live capture → per-scenario averaging → `averaged_responses/average_chN.npy` path that
feeds ESPRIT, compared against the canonical RoomResponse measuring procedure.
**Companion:** Does not redo `docs/development/reviews/modal-measurement-review-2026-07-10.md`
(subsystem review, same day). This is the algorithm-level differential only.

---

## 0. TL;DR verdict (REVISED 2026-07-10 — reference recovered & diffed)

**DIVERGENT — now CONFIRMED against the true reference** (`github.com/astrinleonid/RoomResponse`,
branch `dev` @ `3b09427`, cloned read-only to `D:\repos\RoomResponse`). Confidence **high** on both
the existence AND reference-faithfulness of the divergence; **medium** only on audible/modal magnitude
(needs one offline measurement, §6). My original DIVERGENT verdict (reached without the reference by
comparing the two in-tree paths) **survives contact with the original** and is now upgraded from
inferred to confirmed, with a precise root cause and one NEW finding (excitation drift).

Two independent divergences, both settled against the original:

1. **Acquisition MODE (CONFIRMED).** The reference's interactive acquisition GUIs
   (`gui_series_settings_panel.py` default `'calibration'`; `gui_collect_panel.py` radio
   `index=1 # Default to Calibration mode`) **default to `recording_mode='calibration'`** whenever a
   calibration channel is configured — i.e. the shipped piano/voice-coil default. Calibration mode
   runs the recorder's validate → per-cycle-align (calibration channel) → **normalize-by-calibration**
   → average pipeline. The Modal Adapter live path **hardwires `standard`** (`MODAL_COLLECTION.md`:
   "real acquisition is always standard"), skipping all of it. So calibration normalization + robust
   per-cycle alignment — which the reference applies **by default** for physical-impact capture — are
   dropped on every live Modal Adapter capture.

2. **Excitation waveform (CONFIRMED DRIFT — REFUTES my earlier §11 clean bill).** The vendored
   `recorder.py` carries an **older, hardcoded `voice_coil` pulse** ("square + `-0.5` ramp pull-back"
   over `fade_samples`) and is **missing** the reference's fully-parameterized `voice_coil_config`
   pulse (init/positive/gap/negative ramps) AND the reference's global `pulse_smoothing_ms` (Hann
   convolution) + `invert_polarity` post-processing. For the default `impulse_form:"voice_coil"` the
   port emits a materially different actuator drive than the reference.

Crucially, the naive cross-measurement averager (`missing_averages`) is **byte-identical to the
reference** and IS the reference's own averaging step — so it is NOT the fault. The fault is that the
live path feeds it **standard-mode (un-normalized) impulses** instead of the **calibration-mode
(normalized) impulses** the reference feeds it. The live path has **no functional test coverage at
all**. This matches the operator's "wired but not tested / not intact" intuition precisely.

**Recording hierarchy — CONFIRMED, and it CLEARS the averaging *level*.** The reference's hierarchy is
cycle (one pulse) → measurement (one N-pulse recording, cycle-averaged inside the recorder) → scenario
(several measurements at ONE actuator position, **naively mean-averaged together**) → dataset (loop over
scenarios, operator repositions the actuator; **NO cross-scenario averaging**). The reference's scenario
combine is a plain `np.mean` across per-measurement impulses (`esprit_helper._average_npy_files` /
`_average_room_responses`; and the export-side `generate_missing_averages.py`), fed to ESPRIT from
`impulse_responses/`. **The port's live `missing_averages` averages at the SAME level with the SAME
algorithm** — so my earlier suspicion that the port might average at the *wrong* level is **REFUTED**;
the level is faithful. This *narrows* the defect to mode (#1) + excitation (#11), and it also shows the
**import-path `scenario_averager` (cycle-pooling + re-normalize) is the NON-reference outlier**, not the
canonical one.

**A structural third issue (from the reference's design):** in the reference, correctness is carried by
an **interactive, advisory validate loop** — Test Pulse, cycle-consistency overlay, valid-cycle % /
alignment-correlation readouts, and **operator-learned per-cycle quality thresholds** — living in the
Streamlit GUI (`gui_series_settings_panel.py`, `gui_single_pulse_recorder.py`,
`gui_calibration_impulse_panel.py`). Only the **backend** modules were vendored; that entire expert
loop was **not ported**. So "wired but not tested" is *structural*: the reference never relied on
automated tests here — it relied on an expert watching live diagnostics — and that safeguard is absent
from the Modal Adapter path (§4a).

---

## 1. What the reference actually is (CORRECTED — the reference exists)

**The reference was recovered.** RoomResponse was never on this machine's local disk (the sibling
`D:\repos\RoomResponse` had indeed been deleted), but it lives on the operator's PERSONAL GitHub —
`github.com/astrinleonid/RoomResponse` — not under the DSPianoid org, which is why nothing in-tree
pointed at it. It was cloned, **read-only, with the operator's approval, to `D:\repos\RoomResponse`,
branch `dev`, HEAD `3b094272f31688b74b36f46516f9164dd2eef120`.**

This is decisive: `COLLECT_MIGRATION_FROM_ROOMRESPONSE.md` records RoomResponse `origin/dev` head as
`3b09427` at the time of the migration study, and origin has not moved since — so the clone is the
code the Modal Adapter was modeled from. File-size corroboration matched exactly
(`RoomResponseRecorder.py` = 1420 lines; `gui_series_settings_panel.py` = 2643 lines;
`ESPRIT/esprit_core.py` = 828 lines). `Merge_res_New.py` is present at `ESPRIT/Merge_res_New.py` (not
top-level). The Streamlit GUI (`gui_series_settings_panel.py`, `gui_collect_panel.py`) IS the
operator's "room response REPL" — the working interactive tool.

The known-good measuring procedure was vendored into
`D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\modal_adapter\measurement\`. Port-vs-origin
fidelity (§1a) is now measured, not inferred.

| Vendored module | Origin (`D:\repos\RoomResponse\…`) | Fidelity (ws/EOL-insensitive diff) |
|---|---|---|
| `recorder.py` | `RoomResponseRecorder.py` | **DRIFTED** — excitation + post-processing (see §1a) |
| `signal_processor.py` | `signal_processor.py` | **byte-faithful** (0 diff) |
| `dataset_collector.py` | `DatasetCollector.py` | semantically faithful (1 import line) |
| `missing_averages.py` | `generate_missing_averages.py` | **byte-faithful** (0 diff) |
| `mic_testing.py` | `MicTesting.py` | **byte-faithful** (0 diff) |
| `calibration_validator.py` | `calibration_validator_v2.py` | **byte-faithful** (0 diff) |
| `filename_utils.py` | `multichannel_filename_utils.py` | **byte-faithful** (0 diff) |
| `default_recorderConfig.json` | `recorderConfig.json` (Belarus) | Shipped default config |

### 1a. Port fidelity verdict: **semantically faithful EXCEPT `recorder.py` excitation, which is DRIFTED (regressed)**

Every DSP/averaging/validation module is byte-faithful; the ONLY behavioural drift is in `recorder.py`,
and it is confined to **excitation generation**, not processing. Processing/averaging methods
(`_process_multichannel_signal`, `_process_calibration_mode`, `_process_single_channel_signal`,
normalization, onset detection) are **byte-identical** between port and reference (they do not appear
in the diff at all).

Drift list (reference `RoomResponseRecorder.py` @ 3b09427 → port `recorder.py`):

| Reference (origin) | Port | Direction | Impact |
|---|---|---|---|
| `voice_coil` = parameterized `voice_coil_config` pulse: init-positioning ramp (`init_pos_ms`,`init_pos_amplitude`) + positive plateau (`positive_ms`) + silent gap (`gap_ms`) + negative ramp (`-pullback_amplitude`→0 over `negative_ms`); length via `_compute_pulse_samples()` (orig L438–505) | `voice_coil` = `np.ones(pulse_samples)` + hardcoded pull-back: `-0.5`→0 ramp starting `fade_samples//3` into the last `fade_samples`; length = `pulse_duration*sr` (port L516–534) | port **regressed** | Materially different actuator drive for the default `impulse_form:"voice_coil"` |
| Global post-processing in `_generate_single_pulse`: `pulse_smoothing_ms` Hann-kernel convolution + `invert_polarity` sign flip (orig L520–531) | **absent** | port **regressed** | Configured smoothing/polarity silently dropped |
| `default_config` includes `invert_polarity`, `pulse_smoothing_ms`; `voice_coil_config` dict + file-load (orig L48–51, 93–105, 162–165) | **absent** — `voice_coil_config` in Modal Adapter setup files is read but **never consumed** (`MODAL_COLLECTION.md` confirms "voice_coil-mode parameters are hardcoded") | port **regressed** | User-set voice-coil params in the Modal Adapter UI have no effect |
| (no name persistence) | ADDED `_resolve_device_ids` / `_lookup_device_name` / device-name persistence (port L205–273, 580–591) | port **ahead** (forward SDL3 work) | Does not affect the measuring algorithm |

Most likely provenance: the recorder was ported from an **earlier** RoomResponse working state (with
the SDL3 device-name shim but before the `voice_coil_config` parameterization + smoothing/polarity
landed), while the migration STUDY cited `origin/dev` @ 3b09427, which already had them. Regardless of
git archaeology, the observable fact stands: **the port's excitation differs from the reference at the
cited commit.** Sine/square excitation branches ARE identical (fade-in/out logic unchanged); only
`voice_coil` + the global post-processing drifted.

---

## 2. The two averaging paths (the crux)

Both paths terminate in `averaged_responses/average_chN.npy`, which ESPRIT (and the
`measurements/scenario_N.npy` mirror) consume identically. They are selected by **how a scenario
reached the project**, not by any user choice.

### Path A — LIVE acquisition (record in the Collect panel)

`collection_engine.MeasurementSession._invoke_collection`
→ `SingleScenarioCollector.collect_scenario_measurements()` calls
`recorder.take_record(mode='standard')` **N times** (recording_mode is hardwired `'standard'` —
`MODAL_COLLECTION.md` "real acquisition is always standard"; `dataset_collector` default
`recording_mode='standard'`; `collection_engine` never passes a mode).
→ each measurement's per-channel impulse is produced by `recorder._process_multichannel_signal`
(STANDARD mode): `extract_cycles` → `average_cycles(start_cycle=num_pulses//4)` → onset detected on
**`reference_channel`** → **single shared `np.roll` shift** applied to all channels → optional
`truncate_with_fadeout` → saved as `impulse_*_chN.npy`.
→ `collection_engine._default_averager` → **`missing_averages.generate_averaged_responses_for_scenario`**:
reads `impulse_responses/*.npy`, groups by channel, **naive `np.mean` across measurements** (zero-pad
to max length). **No cross-measurement alignment. No calibration normalization. No truncation at this
stage. No outlier rejection.**

### Path B — IMPORT / re-average (import a dataset, or project re-average)

`scenario_averager.ensure_averaged_responses` reads `raw_recordings/raw_*_chN.npy` and runs a
re-implementation of the calibration pipeline at the AVERAGING stage: per measurement `extract_cycles`
→ `align_cycles_by_onset` (negative-peak + cross-correlation outlier filter, keyed on
**`calibration_channel`**) → `apply_alignment_to_channel` to every channel → `normalize_by_calibration`
(÷ per-cycle impact magnitude) → **pool all aligned cycles across all measurements** →
`average_cycles(start_cycle=0)` → `truncate_with_fadeout` → plus Effective-Signal-Length QC.

**NOTE (corrected against the reference):** `scenario_averager.py` has **no counterpart in
RoomResponse** — it is a **PianoidInstall original** that moves calibration processing from the
record-stage to the average-stage (so it can normalize/align imported raw data recorded in any mode).
Its docstring calling itself "the canonical `RoomResponseRecorder` averaging pipeline" and its stated
assumption that "live recordings write these files as part of the calibration-mode pipeline" are both
**inaccurate**: (i) the reference does NOT pool cycles then mean — it does calibration processing
**per measurement inside the recorder**, then a **naive mean of per-measurement impulses** via
`generate_missing_averages.py` (byte-identical to the port's `missing_averages`); (ii) the reference
has **no Effective-Signal-Length QC** at all (that is also a PianoidInstall addition). So Path B
diverges from BOTH the reference (pooling vs mean-of-means) AND from Path A (normalized vs not).

### The reference's actual data flow (for comparison)

`take_record(mode='calibration')` — per measurement: validate cycles → `align_cycles_by_onset`
(calibration channel) → `apply_alignment_to_channel` → `normalize_by_calibration` → `average_cycles`
→ writes an already-normalized, already-aligned `impulse_*_chN.npy` → then
`generate_missing_averages.generate_averaged_responses_for_scenario` does a **naive mean of those
per-measurement impulses**. The naive mean is legitimate **because each per-measurement impulse is
already impact-normalized**. The Modal Adapter live path uses the SAME naive mean but on
**standard-mode (un-normalized) impulses** — that is the defect.

### Why this is a genuine defect, not a benign design choice

- The **shipped default** `default_recorderConfig.json` is a **physical-impact** measurement:
  `impulse_form:"voice_coil"`, `normalize_by_calibration:true`, `calibration_channel:2`,
  `reference_channel:5`, `alignment_correlation_threshold:0.45`, `calibration_quality_config` with 17
  thresholds. This is exactly the piano-soundboard hammer-impact case the Modal Adapter exists for.
- On the **live** path (standard mode), `normalize_by_calibration`, `calibration_channel`,
  `alignment_correlation_threshold`, and `calibration_quality_config` are **all dead** — standard mode
  never calls the calibration pipeline. Impact-strength variation between hammer strikes is **not**
  removed; per-cycle timing jitter is **not** robustly aligned (only a single reference-channel onset
  shift per measurement); onset is keyed off `reference_channel` (5), not the calibration sensor (2).
- The import path honours all of them. So **the same physical scenario yields different
  `average_chN.npy` depending on whether it was recorded live or imported/re-averaged.**
- **Idempotency compounds it:** `ensure_averaged_responses` **skips** any scenario that already has
  `average_ch*.npy` (`status='skipped_existing'`) unless `force=True`. Live collection writes those
  files first (via `missing_averages`), so the canonical averager **defers to the naive live averages**
  on ordinary project creation — the "preserve pre-existing high-quality averages" comment preserves
  the *low*-quality ones.
- **Broken stated assumption:** `scenario_averager`'s docstring asserts "Live recordings produced by
  `RoomResponseRecorder` write these files as part of the **calibration-mode** processing pipeline."
  The live recorder runs **standard** mode and never writes `averaged_responses/` at all — the files
  come from `missing_averages`. The code and its own documented assumption disagree — a hallmark of an
  incomplete migration.

---

## 3. Step-by-step differential (RE-ADJUDICATED against `D:\repos\RoomResponse` @ 3b09427)

Reference = the actual RoomResponse procedure as the operator's GUI drives it (calibration mode for
the piano/multichannel-with-calibration-channel default). "vs ref" = confirmed against the original;
"internal" = a PianoidInstall-only divergence with no reference counterpart.

| # | Step | Reference @ 3b09427 (verified) | Modal Adapter LIVE path | Class | Symptom |
|---|------|--------------------------------|--------------------------|-------|---------|
| 1 | Recording mode | GUI default **`calibration`** (`gui_series_settings_panel` `default 'calibration'`; `gui_collect_panel` radio `index=1`) → validate+align+normalize | **hardwired `standard`** | **defect — CONFIRMED vs ref** | Calibration normalization + per-cycle alignment never run live |
| 3 | Calibration normalization | ÷ per-cycle impact magnitude, applied per measurement in calibration mode (`normalize_by_calibration:true`) | **omitted** (standard mode ignores it) | **defect — CONFIRMED vs ref (follows from #1)** | Hammer-strength scatter not removed → per-mode feedin/amplitude scatter, unstable modal magnitudes |
| 4 | Per-cycle alignment | negative-peak per cycle + cross-corr outlier filter, keyed on `calibration_channel`, in calibration mode | single `reference_channel` onset shift per measurement; no per-cycle align/outlier reject | **defect — CONFIRMED vs ref (follows from #1)** | Jitter smears the IR → damping over-estimated, modes broadened/split in ESPRIT |
| 11 | **Excitation `voice_coil`** | **parameterized `voice_coil_config` pulse + global `pulse_smoothing_ms`/`invert_polarity`** | **older hardcoded square+`-0.5`-ramp pull-back; no smoothing/polarity; `voice_coil_config` ignored** | **defect — CONFIRMED DRIFT vs ref (was §11 "clean bill" — NOW REFUTED)** | Different actuator drive for the default; user voice-coil params inert; force-input spectrum differs → measured IR + modes differ from reference |
| 5 | Onset channel by mode | calibration mode → `calibration_channel`; standard mode → `reference_channel` (BOTH exist, mode-selected, intentional in ref) | live uses standard → `reference_channel`; import (Path B) uses `calibration_channel` | **suspicious — consequence of #1, not an independent ref bug** | Same scenario aligned off different channels across live vs import paths |
| 2 | Cross-measurement averaging LEVEL + code | scenario = **naive `np.mean` across measurements** (`esprit_helper._average_npy_files`; `generate_missing_averages.py`); ESPRIT fed from `impulse_responses/` | **same level, same algorithm** (`missing_averages`, byte-identical); ESPRIT fed from materialized `averaged_responses/average_chN.npy` | **benign — port faithful (my earlier "wrong level" suspicion REFUTED)** | Averager code + level are correct; only the inputs (mode #1) are wrong. PianoidInstall materializes the same mean to a file earlier — plumbing, same math |
| 6 | Combine granularity | mean-of-per-measurement-means (each already cycle-averaged); **no cross-scenario averaging** | live = same (mean-of-means, per-scenario) | **benign vs ref** | Live matches ref. It is Path B (`scenario_averager` cycle-pooling + re-normalize) that diverges from ref — an *internal* PianoidInstall re-implementation, not the canonical one |
| 15 | **Pre-commit validation loop** | interactive advisory: Test Pulse, cycle-consistency overlay, valid-cycle %/alignment-corr readouts; zero-valid-cycle hard-stop (calibration mode) | Streamlit GUI **not ported**; the ported zero-valid hard-stop (`dataset_collector`) fires only in calibration mode → **dead on the live standard path** | **defect — CONFIRMED structural gap vs ref** | Reference trust = expert watching live diagnostics; port has neither that loop nor tests → bad captures pass silently |
| 16 | **Per-cycle quality criteria** | **operator-learned** `calibration_quality_config` (17 tuned thresholds; `Vc_hammer_8ch.json` shows non-round learned values) via `CalibrationValidatorV2` + learning UI | validator class byte-ported but runs **only in calibration mode** (dead on live); learning UI not ported; Setup Test uses a **separate thin 5-criterion** `calibration_criteria.json` | **defect — CONFIRMED vs ref** | The learned per-cycle acceptance gate is unused on the live path; explains why `setup_test_engine` criteria look thin |
| 9 | Effective-Signal-Length QC | **not present in reference at all** | not produced live (only in Path B) | **internal (PianoidInstall addition), not a ref divergence** | T_eff is a new QC layer; absent-on-live is an internal gap, not unfaithfulness |
| 7 | Truncation primitive (`truncate_with_fadeout`) | Hann second-half fade, applied per measurement in-recorder | **identical primitive** (`signal_processor` byte-faithful) | **benign — CONFIRMED clean vs ref** | — |
| 8 | Cycle-settling skip | `start_cycle=num_pulses//4` in standard; `0` in calibration (already validated) — same code both sides | identical | **benign — CONFIRMED clean vs ref** | — |
| 12 | Cycle extraction (`extract_cycles`) | shared primitive | **identical** (byte-faithful) | **benign — CONFIRMED clean vs ref** | — |
| 10 | `.npy` availability | ref `generate_missing_averages` reads `impulse_responses/*.npy` too (same dep) | same; **requires `save_npy:true`** | **latent-fragility (same as ref)** | Default cfg has `save_npy:true`; but `_build_recorder_config` allow-list omits `save_format` and the built-in fallback default is `save_npy:false` → live averager would silently write nothing |
| 13 | Config unit conversions (ms↔s) | n/a — ref uses `recorderConfig.json` directly | PianoidInstall-original glue; conversions internally correct | **internal — not a ref comparison** | — |
| 14 | Pause/resume device coordination | n/a — ref is Streamlit, nothing to pause | PianoidInstall-original; sound fail-fast | **internal — not a ref comparison** | — |

### Which of my earlier §11–§14 "clean bills" survived the real source

- **#11 Excitation generation — DID NOT SURVIVE.** Confirmed DRIFT: the port's `voice_coil` is an older
  hardcoded formula and the reference's `pulse_smoothing_ms`/`invert_polarity`/`voice_coil_config` are
  absent. Promoted to a **defect**.
- **#12 Cycle extraction — SURVIVED** (`signal_processor.py` byte-faithful).
- **#7 Truncation primitive — SURVIVED** (byte-faithful).
- **#13 ms↔s stitching, #14 pause/resume — reclassified:** these are **PianoidInstall-original glue**
  with no reference counterpart, so "carried over cleanly" was the wrong frame; they are internally
  sound but were never in the reference.

---

## 4. Testedness map

| Procedure step | Coverage | Notes |
|---|---|---|
| Excitation / pulse generation (`_generate_single_pulse`, voice_coil formula) | **UNTESTED** | No test constructs a real recorder and inspects `playback_signal` |
| Recording (`_record_audio`, SDL) | mock-only | Hardware — expected; mocked everywhere |
| Standard-mode processing (`_process_multichannel_signal`, onset+single-shift) | **UNTESTED** | The live per-measurement processing has no test |
| Calibration-mode processing (`_process_calibration_mode`) | mock-only (indirect) | `test_setup_test_engine` mocks the recorder; its DSP primitives are covered only via Path B |
| **Live averaging (`missing_averages.generate_averaged_responses_for_scenario`)** | **UNTESTED** | Only `test_measurement_port.py` does `assert hasattr(...)` — an import/attribute smoke check, never executed on data |
| Import averaging (`scenario_averager.ensure_averaged_responses`) | **REAL coverage** | `test_scenario_averager.py` (~30 cases) drives synthetic triangular-pulse cycles through align→normalize→truncate + T_eff — the one path with genuine DSP tests |
| Signal-processor primitives (align/normalize/truncate) | real (via Path B only) | Exercised through `scenario_averager`, not through the recorder |
| Setup Test criteria reduction | tested (mock recorder) | `test_setup_test_engine.py` — logic only, no real capture |
| Collection route + config stitching | tested (fakes) | `test_measurement_collect_routes.py` uses `_FakeSession`/`_FakeMeasurement` |
| Session lifecycle / pause-resume orchestration | tested (synthetic factories) | `test_modal_collection_b1.py` injects `_synthetic_averager`, `_SyntheticRecorder` — real averager/recorder bypassed |

**Bottom line:** every test that touches the live measurement path substitutes a synthetic recorder,
collector, or averager, or a `_FakeSession`. **The actual live measuring algorithm — standard-mode
recorder processing followed by the naive `missing_averages` mean — is not exercised on data by any
test.** The only real-DSP coverage is the *import* averager, which is the path that does NOT run on
live captures. "Wired but not tested" is literally accurate for the live path.

### 4a. Why "not tested" is STRUCTURAL, not incidental (from the reference)

The reference never carried this code with automated tests either — it carried it with an **expert in
the loop**: the Streamlit GUI shows Test Pulse, a cycle-consistency overlay, valid-cycle % and
alignment-correlation readouts, and lets the operator **learn** per-cycle acceptance thresholds from
cycles they mark good (`gui_calibration_impulse_panel.py`, `gui_series_settings_panel.py`). The
operator commits a scenario only when those live diagnostics look right; the sole hard automatic stop
is a *calibration*-mode measurement yielding zero valid cycles. **That entire interactive safeguard was
not ported** (only backend modules were vendored), and the port replaced calibration-mode acquisition
with standard mode — so even the ported zero-valid hard-stop never fires on the live path. The
Modal Adapter therefore has **neither** the reference's expert-loop safeguard **nor** substitute
automated coverage over the live measuring algorithm. That is the precise shape of "wired but not
tested / not intact."

---

## 5. UNVERIFIED facts (source-only or unmeasurable here)

- **Port fidelity — now RESOLVED (was the top UNVERIFIED item).** Diffed against
  `D:\repos\RoomResponse` @ `3b09427`: `signal_processor`, `mic_testing`, `missing_averages`,
  `calibration_validator`, `filename_utils` **byte-faithful**; `dataset_collector` faithful (1 import
  line); `recorder.py` **DRIFTED in excitation only** (§1a). No longer UNVERIFIED.
- **Divergence #1 (mode) — now CONFIRMED (was inferred).** Reference GUIs default to `calibration`
  (`gui_series_settings_panel.py:167` `default 'calibration'`; `gui_collect_panel.py:461`
  `index=1 # Default to Calibration mode`); `recording_mode` is a GUI/session choice, absent from
  `configs/*.json`. No longer UNVERIFIED.
- **Magnitude of the downstream effect** on extracted modes (frequency/damping/feedin) — the
  divergence is proven in the data-flow; the audible/modal significance needs one offline measurement
  (§6). UNVERIFIED (needs measurement).
- **Whether any production project already carries standard-mode (un-normalized) live averages into
  ESPRIT** — consistent with the zero test coverage and the idempotency-skip, but not confirmed on real
  project data. UNVERIFIED.
- **Provenance of the excitation drift** (whether the recorder was ported from a pre-`voice_coil_config`
  RR commit vs deliberately simplified) — the *effect* is verified; the git history behind it is
  inferred. UNVERIFIED (does not change the finding).
- **Whether the Modal Adapter frontend re-implements any of the reference's advisory validation loop
  elsewhere** — not found in the backend/setup-test surface reviewed; the React panel was out of scope
  here. UNVERIFIED (frontend not audited in this pass).
- **Channel roles** (`calibration_channel:2`, `reference_channel:5`) confirmed in BOTH
  `default_recorderConfig.json` and reference `configs/Vc_hammer_8ch.json`. The mode-dependent onset
  channel (standard→`reference_channel`, calibration→`calibration_channel`) is intentional in the
  reference (mode design), so #5 is a *consequence of #1*, not an independent reference bug.

---

## 6. Cheapest empirical check (UPDATED — the reference is now available to diff against)

The rows #1/#11 are already CONFIRMED against the reference by source diff (no measurement needed). The
one remaining open question is **magnitude** — how much the standard-vs-calibration mode changes the
modal result on real data. The cheapest, hardware-free check now takes the true reference as oracle:

Take one existing recorded scenario that has `raw_recordings/*.npy` + `impulse_responses/*.npy` (or
synthesize per-measurement multichannel cycle stacks with deliberate per-measurement impact-amplitude
scatter + a few samples of per-cycle jitter, using the reference's own `Vc_hammer_8ch.json` profile).
Then, in one Python process, produce the scenario average two ways and compare per response channel
(peak-normalized NRMSE / spectral-envelope delta, and downstream ESPRIT freq/damping if convenient):

1. **Reference procedure:** drive the vendored recorder in `mode='calibration'` per measurement
   (validate→align→normalize→cycle-average) → then a naive `np.mean` across measurements (matches
   `esprit_helper._average_npy_files`). This is exactly what RoomResponse produces.
2. **Modal Adapter live procedure:** drive it in `mode='standard'` → `missing_averages` naive mean.

**Prediction:** (2) retains impact-amplitude scatter + jitter smear that (1) removes — so the averaged
IRs (and the ESPRIT damping/feedin) diverge. This isolates the *mode* effect specifically, with the
reference as ground truth, and needs no audio device. (The excitation drift #11 is already proven by
the §1a diff and needs no run.)

*(Describe-only — not run, per the read-only constraint.)*

---

## 7. Recommendation (for the operator's decision — not implemented here)

The differential against the true reference reframes the fix. The averaging *level/algorithm* is
already faithful (naive per-measurement mean = reference), so the fix is NOT "swap the averager." The
three real gaps are:

1. **Restore calibration mode for physical-impact capture.** The live path should run the recorder in
   `mode='calibration'` (validate→align→normalize per measurement) for voice-coil/multichannel configs
   — the reference's default — instead of the hardwired `standard`. This restores divergences #1/#3/#4
   in one move. (Alternatively, move calibration processing to the averaging stage as
   `scenario_averager` does — but note that is a *non-reference* algorithm and should be validated on
   its own terms.)
2. **Restore the parameterized `voice_coil` excitation + `pulse_smoothing_ms`/`invert_polarity`** in
   `recorder.py` from `RoomResponseRecorder.py` @ `3b09427`, and actually consume the
   `voice_coil_config` the setup files already carry (#11).
3. **Replace the missing expert-loop with automated coverage** (§4a): a real end-to-end test over the
   live measuring algorithm on synthetic data (mirroring `test_scenario_averager.py`), plus surfacing
   the reference's advisory diagnostics (valid-cycle %, alignment correlation, zero-valid hard-stop) on
   the live path — otherwise bad captures pass silently with neither an expert nor a test to catch them.

This is a data-model/calibration correctness fix; scope and sequencing are the operator's call. The
recovered `D:\repos\RoomResponse` @ `3b09427` is now available as the byte-level oracle for all three.

---

*End of differential. UPDATED 2026-07-10 after the reference was recovered
(`github.com/astrinleonid/RoomResponse` `dev` @ `3b094272`, cloned READ-ONLY to `D:\repos\RoomResponse`
— no edit/commit/push/checkout/pull performed). READ-ONLY pass overall — no source edited, nothing
built, no device opened, no capture run, no commit. `docs/proposals/modaladapter.md` intentionally
untouched (owned by another agent).*
