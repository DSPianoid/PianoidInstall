# Mode-scaling T4 — N ≈ 2000 modes (measurements, 2026-10-10)

**Agent:** dev-3d2c · **Spec:** [4000-modes proposal §R.3 P4 / §R.5 T4](../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md#r5-implementation-plan-next-dev-tasks-in-order)
· **Code:** PianoidCore `feature/dev-3d2c-t4-scale` (off dev 824dba5 = T3 merged), PianoidBasic `feature/dev-3d2c-t4-pack`
(off dev 2f1d072) · **Status:** implemented + verified, NOT merged (held for the user's listening verdict).
Reference docs: [SYNTHESIS_ENGINE → Mode capacity + compact deck](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#mode-capacity-compact-deck-4000-modes-t4-dev-3d2c-2026-10-10),
[PianoidBasic OVERVIEW → Flat tier](../modules/pianoid-basic/OVERVIEW.md#flat-tier-opt-in-pack-contract-4000-modes-campaign-t3-dev-5bf7).
Predecessor: [T3 flat tier](mode-scaling-T3-flat-tier-2026-10-10.md).

## 1. Changes

| Layer | Change |
|---|---|
| Capacity (`constants.h`, `PresetParameters.h`) | `NUM_MODES` 256 → **4096** (`dev_mode_running` 2×, preset mode-config region 3×: +11 520 reals per preset slot). New `MAX_DECK_COLUMNS` = 256: the deck region is `NUM_STRINGS × MAX_DECK_COLUMNS` = 65 536 reals, **unchanged** and no longer tied to the mode count |
| Compact deck (`ModeLayout.cuh`) | `deckWidth` + `deckColumn(L, m)`. Legacy: width `N`, column `m` (unchanged). Flat tier: `[shaped 0..nS) \| ONE flat column nS = w(s) \| linked]`, width `nS + 1 + (N − linkedBase)` — **61** columns for 56 + 1 + 4 SC slots at any N (was `num_strings` = 224 wide; a full N-wide deck would be 224 × 2004) |
| Kernel (`MainKernel.cu`, `FlatTier.cuh`) | every deck read goes through `deckWidth` / `deckColumn` (feedin, feedback, `flatDeckWeight`, debug records 4/5/9 — record 4/5 now bounded to the `arraySize`-wide record row) |
| Host checks | `validateModeLayout`: `N ≤ NUM_MODES`, `deckWidth ≤ MAX_DECK_COLUMNS` (a legacy preset above 256 modes fails), blocks ≤ `SEGMENT_FOR_SHUFFLE_SUMMATION` (64 — was unguarded); `loadPresetToLibrary`: a flat-tier deck must be exactly `num_strings × deckWidth` |
| Mode count decoupled (Basic `ModelParameters.engine_mode_slots`, sole owner of `num_modes_for_model`) | legacy presets: `num_strings` (divisibility + `N + channels ≤ num_strings` guards unchanged); **flat-tier presets: `N + num_channels`** (SC slots at `mode_channel_index = N`), ≤ `MAX_NUM_MODES` = 4096. `pianoid.py` (load, library slot, `initialize`) passes `ModelParameters.ENGINE_SLOTS` instead of `num_strings`; a library preset whose mode layout differs from the running engine fails with `PresetLibraryError` |
| Pack (`StringMap`, `flat_tier.py`) | `pitch_deck_row` = domain row (`num_modes_for_model` wide, SC slots filled); `pack_pitch_feedin` = engine row → uniformity check → `compact_deck_row`. `ext_to_the_right` returned `None` when no padding was needed (the obscure T2-era `'NoneType'.shape` failure) — now pads or fails loudly. `updateDeckRow` already takes the row width from the row |
| Generator (`mode_extension`, CLI) | `current_engine` also reports `flat_tier_ceiling_num_modes` (4092) / `loadable_with_flat_tier`; the CLI prints the flat-tier load verdict with `--flat-tier` |

## 2. Verification

Scratch binaries via `PYTHONPATH` (shared venv untouched): base = installed merged dev (824dba5 HEAVY `--both`, copied to
`D:/scratch/dev-3d2c/bin_base` + Basic 0.1.15), T4 = worktree `setup.py build_ext` → `bin_t4` + branch Basic wheel
(`pip --target basic_t4`). Presets (seed 0, literature law, `--flat-tier`): Belarus N 1000 (f_max 5.2 kHz), **N 2000
(10.2 kHz)**, N 2000 `plate`, N 4000 (20.2 kHz, capacity point); F15 N 2000 (10.17 kHz; F15 N 1000 is infeasible —
75 real modes above its f_max).

### 2.1 Registers / occupancy / layout

| `addKernel` | sm_80 | sm_86 | sm_89 |
|---|---|---|---|
| release T3 → T4 | 109 → **111** | 111 → **113** | 111 → **113** |
| debug T3 → T4 | 112 → **118** | 114 → **120** | 114 → **120** |

0 spill / 0 stack, smem 18 524 B; pre-flight (loaded binary) regs 113, 1 block/SM, capacity 128 ≥ grid 56/58. The +2 / +6
are the `deckColumn` index arithmetic (debug: also the bounded debug records); 8 registers of debug headroom remain.
**Ownership audit** (debug pyd, `dev-5bf7-ownership-audit.py`): Belarus N 2000 (B 56, Q 96, U **35**, L 1) 2004/2004
owners, F15 N 2000 (B 58, Q 128, U **34**) 2004/2004, Belarus N 4000 (U **71**) 4004/4004, Belarus legacy 224/224 —
**0 errors**. One flat oscillator per thread; quarters 1–3 offer 288 / 384 threads, so N = 4000 still fits.

### 2.2 Timing — addKernel per 64-sample cycle (budget 1 333 µs), N = 5 interleaved rounds, fresh process per run, idle GPU

| Preset | base (dev 824dba5) | T4 | % of budget |
|---|---|---|---|
| Belarus legacy (384, si 4) | 461.9 µs (461–464) | 455.5 (454–459, −1.4 %) | 34.2 % |
| Belarus flattened 56 + 140 | 417.9 (416–421) | 407.7 (405–411, −2.4 %) | 30.6 % |
| Belarus **N 1000** | — | 409.6 (408–412) | 30.7 % |
| Belarus **N 2000** | — | **409.3** (408–411) | **30.7 %** |
| Belarus **N 4000** | — | 410.4 (409–413) | 30.8 % |
| F15 legacy (512, si 16) | 986.0 (971–987) | 973.9 (970–979, −1.2 %) | 73.0 % |
| F15 flattened 56 + 140 | 938.1 (927–942) | 911.0 (900–916, −2.9 %) | 68.3 % |
| F15 **N 2000** | — | **917.1** (911–919) | **68.8 %** |

**The flat tier costs the same at any N**: 196 → 2000 → 4000 modes adds +0.4 % / +0.7 % (Belarus / F15) — one
register oscillator per thread on otherwise idle quarter threads; the reductions are N-independent. T4 is 1–3 % faster than
base on the same presets, legacy included (cause not isolated — not claimed as a T4 effect).

### 2.3 Legacy / T3 presets unchanged (3 s chord C2–C6, all cross-round pairs of the 5 rounds)

| Preset / artefact | base-base median (max) | T4-T4 | **base-T4** |
|---|---|---|---|
| Belarus audio | 1.904e-3 (1.910e-3) | 1.899e-3 | **1.900e-3** (1.917e-3) |
| F15 audio | 1.029e-4 (1.066e-4) | 1.015e-4 | **1.026e-4** (1.063e-4) |
| Belarus / F15 mode state | 3.2e-5 / 9.9e-5 | 7.2e-5 / 3.4e-5 | 5.7e-5 / 9.3e-5 |
| Belarus / F15 all-mode probe | 4.5e-5 / 3.0e-5 | 3.6e-5 / 3.2e-5 | 4.3e-5 / 3.0e-5 |
| flattened Belarus audio (T3: 224 slots, full-width deck → T4: 200 slots, compact deck) | 1.709e-3 | 1.702e-3 | **1.705e-3** |
| flattened F15 audio | 1.027e-4 | 1.022e-4 | **1.037e-4** |

**Indistinguishable** (inside the engine's float atomic-order noise) — existing presets and the T3 flat presets render
the same; the T3 flat presets lose only the 24 zero-coupled padding slots.

### 2.4 fp32 accuracy of the flat sums (deferred from T3)

`dev-3d2c-flat-sum-accuracy.py`: 150 snapshots of the REAL engine state (fp32 `q'` of every mode, every 20 ms of a 3 s
chord incl. release), the bit-exact fp32 emulation of `FlatTier.cuh` (per-block warp-shuffle trees + shared atomic,
both atomic orders; cross-block `row[t] + row[t+32]` + tree) vs `math.fsum` of the same fp32 values:

| Preset | U | max \|err\| / rms `Q_sum` | rms err / rms `Q_sum` | max err in ulps of `Σ\|q'\|` |
|---|---|---|---|---|
| Belarus N 2000 | 35 | 4.5e-7 | 8.4e-8 | 1.06 |
| Belarus N 4000 | 71 | 5.3e-7 | 8.8e-8 | 1.44 |
| F15 N 2000 | 34 | 3.8e-7 | 6.6e-8 | 1.02 |
| flattened Belarus (T3) | 3 | 2.5e-7 | 4.4e-8 | 0.76 |

The error is ~1 ulp of `Σ|q'|`, there is no cancellation (`Σ|q'|` ≈ 1.2–2.4 × rms `Q_sum`), and it is 4 orders below
the render-to-render noise (1e-4 … 2e-3). `F_sum` sums the same 224 / 232 string terms at any N. **No Kahan / double
stage is needed** — the register budget stays untouched.

### 2.5 Offline renders — no NaN / clipping / runaway

Every N 1000 / 2000 / 4000 render (3 s chord ×5 rounds, 24.7 s listen material, 6 s chord) is finite; peak level within
±0.4 dB of the 196-mode source (no headroom change, no `output_scale` re-derivation needed); the release envelope
decays like the source (−101 dB 0.5 s after note-off, −131 dB at 6 s). Mode probe: all 2000 modes advance
(`tests/integration/test_mode_scaling_t4.py`).

### 2.6 Listening A/B — Belarus 196 real modes (current dev) vs N 2000 (T4), one gain per material

WAVs (16-bit stereo = out ch 1 / 2, plus 4-channel), reports `*_report.json`, all under `D:/scratch/dev-3d2c/wav/`
(reports, timing/equivalence table, accuracy summary, smoke + timing scripts copied to `docs/development/diagnostics/dev-3d2c-t4/`):

| Material | A (reference) | B | C | D |
|---|---|---|---|---|
| `T4_AB_Belarus_listen_*` — notes 28→100 + C2 / C4 / C5 / C2–C6 chords (24.7 s, as the T3 A/B) | `A_196real` (base binary, source preset) | `B_N2000` | `C_N2000_plate` | `D_flat196` (56 shaped + 140 flat, no synthetic) |
| `T4_AB_Belarus_lastchord_*` — C2–C6 alone from silence, off at 2.6 s, 6 s | same | same | same | same |
| `T4_AB_F15_{listen,lastchord}_*` | `A_196real` | `B_N2000` | — | — |

| vs A (dB) | Belarus B N 2000 | Belarus C plate | Belarus D flat196 | F15 B N 2000 |
|---|---|---|---|---|
| level ch 1 / 2 / 3 / 4 (listen) | **+0.10 / −0.08 / +0.01 / +0.28** | −0.80 / −1.34 / −1.37 / −0.15 | +0.02 / −0.06 / −0.06 / +0.06 | +0.17 / +0.26 / +0.11 / −0.43 |
| level ch 1 / 2 (last chord) | +0.01 / −0.11 | −0.76 / −1.37 | 0.00 / −0.09 | +0.13 / +0.32 |
| octaves 31.5 Hz–4 kHz, ch 1 (listen) | −0.3 … +0.4 | −2.1 … +0.4 | ±0.15 | −0.0 … +1.2 |
| octaves 8 / 16 kHz, ch 1 (listen) | **+1.2 / +1.6** | **+8.4 / +27.5** | +0.1 / +0.15 | +1.3 / −0.4 |
| per segment ch 1 (notes / chords) | +0.2 … +0.4, note 100 **+1.5** | −2.4 … +2.7, note 100 **+16** | ±0.3 | +0.1 … +0.3, note 88 +1.6 |
| waveform relRMS ch 1 | 10.8 % | 41.5 % | 5.1 % | 6.4 % |

Reading: with the default `measured` energy rule the 1 804 synthetic modes leave the loudness where it was (≤ 0.3 dB per
channel) and add ~+1–1.6 dB of 8–16 kHz energy and a denser board response (waveform 11 % vs 5 % for the flat
projection alone); the highest note (100, ~2.6 kHz fundamental) gains +1.5 dB. The `plate` rule (constant total mass,
literal plate physics) is ~1 dB quieter overall and **+8 / +27 dB at 8 / 16 kHz** — a strongly brighter instrument.
Whether B (or C) sounds better is the user's call (§R.6 acceptance).

### 2.7 Tests

PianoidBasic `tests/` **57/57** (52 + 5 T4 cases). Core `tests/integration/test_mode_scaling_t4.py` 2/2 (N 2000 flat
tier loads with 2004 slots / renders / advances every mode; without the flat tier fails "engine packs only"),
`test_flat_tier_exactness.py` 2/2 (T4 binary). Core `tests/unit` (`-k "not esprit"`, `test_band_processing_skip.py`
ignored): **1944 passed / 4 failed (pre-existing `test_start_right_away_binary`) / 1 skipped — identical to base**
(installed dev binaries, main checkout); from the worktree `test_fpga_preset_converter.py` needs `PIANOID_FPGA_ROOT`
(14 worktree-only skips, 47/47 with it).

**In-process smoke** (real Flask routes via `app.test_client()`, no port bound, ASIO callback, 384 / si 4 / d2, volume
100; T4 scratch bins + branch Basic): Belarus legacy `/load_preset` 200 → `/health` healthy, `/play` p60 peak 0.0645 FS
→ **Belarus N 2000 `/load_preset` 200 (engine 2004 modes), healthy, audio watchdog ok (0 produce timeouts), p60 peak
0.0607 FS (−0.5 dB)** → Belarus legacy again 200, 0.0645 FS → `/shutdown` 200; no `.pyd` holder after.

## 3. Readiness for T5 (UI)

- Engine + loader run any `N ≤ 4092` flat-tier preset; legacy presets unchanged. A flat-tier preset needs no new
  fields beyond the T3 opt-in.
- **Middleware / UI gaps (T5):** `/health` should report `num_modes` (engine slots), `n_shaped`, `n_flat`; mode
  editors / `getModeDisplacements` charts get 2004 modes (5 × 2004 reals) — render the flat tier as one aggregated band;
  deck editors must address the DOMAIN row (`pitch_deck_row`, one column per mode) — a per-pitch flat-column edit or
  mute fails the upload by design (`FlatTierError`) — **T5 (dev-d0b7, 2026-10-11): edits now write one value to all flat columns of the row (backend `flat_tier.sync_flat_edit` + FE `useMatrixHistory` flatRange), `/health mode_layout` added**; the feedin chart (`pack_deck(pack_for_cuda=False)`) already shows
  domain rows. Library D2D switch between presets with different mode layouts is refused (`PresetLibraryError`) —
  the UI should offer APPLY.
- Not done: a `/load_preset` through the user's own launcher stack (the in-process ASIO smoke above covers the engine
  + middleware path); the merge gate needs the HEAVY `--both` install + that smoke on the shared venv.
