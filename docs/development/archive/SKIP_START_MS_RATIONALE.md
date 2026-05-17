# Per-Band `skip_start_ms` — Design Rationale

**Status:** Landed dev-07b4 (2026-05-05).
**Affected modules:** `pianoid_middleware/modal_adapter/esprit/band_processing.py`,
`esprit_runner.py`, `EspritConfig.jsx`.

## Problem

ESPRIT modal identification fits an autoregressive subspace model to the
post-bandpass impulse response of each frequency band. Two distinct sources
of pollution contaminate the **start** of the bandpass-filtered signal,
particularly in the low bands:

1. **Forcing-function transient.** The hammer impact (or whatever
   excitation drives the system) is broadband. Its energy at low
   frequencies decays with a short time constant — but inside the bandpass
   filter the ringing from the forcing transient persists for several
   filter-settling time constants beyond the physical impact. ESPRIT
   has no way to distinguish "transient driven by the input" from "freely
   decaying mode of the structure" — it fits both as poles, generating
   wide-band high-damping ghost modes that pollute the chain decomposition
   downstream.

2. **Butterworth `sosfiltfilt` zero-edge-state settling.** The
   forward-backward filter `scipy.signal.sosfiltfilt` initialises both
   passes with zero state. For an order-N Butterworth bandpass with lower
   cutoff `f_min`, the settling region scales roughly as

   ```
   t_settle ~ 10 * N / (2 * pi * f_min)   seconds
   ```

   At `f_min = 30 Hz, order 4`: `t_settle ~ 21 ms`. At `f_min = 80 Hz,
   order 4`: `t_settle ~ 8 ms`. Both fall well within the impulse-response
   window the user expects ESPRIT to consume, so the polluted region IS
   what ESPRIT sees.

The cleanest fix is to discard the polluted prefix before ESPRIT sees the
signal. Allemang and Brown (Vibration: Analytical and Experimental Modal
Analysis, 2002) routinely recommend trimming the first 5-10 cycles at the
band's lowest frequency for exactly this reason — the residual is then
dominated by the freely-decaying modal response that ESPRIT was designed
to fit.

## Solution

Add a per-band `skip_start_ms: Optional[float]` field to the
`FrequencyBand` dataclass. When set, `process_band` discards the
configured prefix from the **end** of the pipeline:

```
input signal
  -> [optional ir_length_ms slice (dev-ir01)]
  -> bandpass filter (sosfiltfilt)
  -> optional preemphasis (multiplicative exp(alpha*t))
  -> decimation (sp_signal.decimate)
  -> [skip_start_ms prefix removed]   <-- dev-07b4 inserts here
  -> emit to caller
```

### Why post-decimation, post-preemphasis?

- **Post-decimation:** the prefix-removal cost is `n_samples_skipped =
  round(skip_start_ms * fs_band / 1000)` samples, where `fs_band` is the
  decimated rate. For Ultra-Low (decimation=4, fs=48000 -> fs_band=12000)
  a 50 ms skip removes 600 samples — cheap. Skipping pre-decimation would
  be semantically equivalent but compute against fs (4x more samples to
  decide on, no real benefit).
- **Post-preemphasis:** preemphasis is `signal * exp(alpha * t)` where
  `t` is measured from the original signal start. Slicing AFTER
  preemphasis preserves the multiplicative envelope shape over the
  original time axis. Slicing BEFORE preemphasis would mean the envelope
  multiplier starts at `exp(alpha * 0) = 1` mid-signal — physically
  meaningless for a tail-boost transform.

### Per-band defaults (EXTENDED_BANDS)

| Band      | f_min (Hz) | filter_order | settling estimate (ms) | `skip_start_ms` |
|-----------|------------|--------------|------------------------|-----------------|
| Ultra-Low | 30         | 4            | ~21                    | **50**          |
| Low       | 80         | 4            | ~8                     | **30**          |
| Low-Mid   | 180        | 5            | ~4                     | **15**          |
| Mid       | 350        | 5            | ~2                     | **5**           |
| Mid-High  | 600        | 6            | ~1.6                   | 0               |
| High      | 1000       | 6            | ~1                     | 0               |
| Upper     | 2000       | 8            | ~0.6                   | 0               |
| Top       | 4000       | 8            | ~0.3                   | 0               |

The per-band default carries a ~2-3x margin over the rough filter-only
settling estimate. The extra margin covers the forcing-function transient
which dominates the low bands. Top 5 bands stay 0 because at
`f_min >= 600 Hz` the pollution region is sub-millisecond and rounds to
zero samples post-decimation.

Post-skip useful signal length stays >= 28 cycles at `f_min` for every
band — ESPRIT has plenty of data to fit the configured `model_order`
poles.

`STANDARD_BANDS` deliberately omits per-band defaults (every band stays
`None`). That preset is the "fast first-pass" starting point; users
opting into `EXTENDED_BANDS` get the per-band defaults automatically.

## Implementation invariants

- `skip_start_ms = None` is a no-op — preserves backward compatibility.
- `skip_start_ms = 0` is also a no-op — `0` is a meaningful "explicitly no
  skip" value vs `None` ("not configured").
- Misconfigured large values (skip > available signal) are clamped to
  `len(filtered) - 1` so `process_band` never returns an empty signal.
  ESPRIT downstream consumes the 1-sample tail — degraded but not crashing.
- New metadata fields:
  - `skip_start_ms`: the configured value (None / int / float).
  - `n_samples_skipped`: actual count removed post-decimation.
  - `n_samples_final`: `len(filtered)` post-skip (mirrors
    `n_samples_decimated` which counts pre-skip).

## Frontend surface

`EspritConfig.jsx` exposes a "Skip (ms)" column in the per-band advanced
table (right of "IR (ms)"). Empty input -> `null`. Placeholder "0"
indicates the no-skip default. Changing any value flips the active preset
to "custom" (matching the existing per-band field convention).

The Modal Adapter `/modal/band_presets` REST endpoint serializes the
field automatically (via `EspritRunner.get_band_presets`), so a frontend
preset switch hydrates the new column from backend state without
additional plumbing.

## Tests

- `PianoidCore/tests/unit/test_band_processing_skip.py` — 15 tests
  covering dataclass field defaults, EXTENDED_BANDS / STANDARD_BANDS
  preset values, no-op (None / 0), exact sample-count removal,
  metadata correctness, clamping, multichannel / preemphasis interaction,
  end-to-end ESPRIT recovery on synthetic transient + 30 Hz mode.
- `PianoidTunner/src/components/__tests__/EspritConfig.skipStart.test.jsx` —
  7 tests covering column rendering, placement after IR (ms), value
  display, edit/clear handlers, addBand defaults, null-value placeholder.

## References

- Allemang, R. J., Brown, D. L. — *Vibration: Analytical and Experimental
  Modal Analysis*, UC-SDRL course notes (2002), section on residue
  truncation and impulse-response windowing.
- ESPRIT analyst report (agent `a2fdd66c78c1a9f95`) Q4 — recommended
  per-band skip table.
- dev-ir01 (2026-05-04) — established the `Optional[float]` per-band
  parameter pattern (`ir_length_ms`) that `skip_start_ms` follows.
