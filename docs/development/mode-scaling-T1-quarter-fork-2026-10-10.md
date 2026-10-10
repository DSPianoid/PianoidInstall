# Mode-scaling T1 — quarter-fork mode re-index (measurements, 2026-10-10)

**Agent:** dev-624c · **Spec:** [4000-modes proposal §R.5 T1](../proposals/mode-scaling-4000-implementation-proposal-2026-06-06.md#r5-implementation-plan-next-dev-tasks-in-order) (P1 of §R.3; §2, §4b, §7.2–7.3)
· **Code:** PianoidCore `feature/dev-624c-quarter-fork` (off dev a92500c) · **Status:** implemented + verified; MERGED into Core dev 443d42c (2026-10-10).
Reference doc for the new map: [SYNTHESIS_ENGINE → Mode placement](../modules/pianoid-cuda/SYNTHESIS_ENGINE.md#mode-placement-modelayoutcuh-4000-modes-t1-quarter-fork-dev-624c-2026-10-10).

## 1. What changed

| File | Change |
|---|---|
| `pianoid_cuda/ModeLayout.cuh` (new) | The single placement map: `makeModeLayout(N, B, S)`, `slotMode(b, k)`, `ownedMode(b, t, Q, &slot)` (host+device) |
| `pianoid_cuda/Kernels.cu` (`stringMapKernel`) | slot 25 = `slotMode(b, quarter)`; NEW slot 27 = owned mode, slot 28 = its coupling slot |
| `pianoid_cuda/MainKernel.cu` (`addKernel`) | feedin row → mode via `slotMode`; oscillator load / advance / persist by the **owner thread** (the `indexInQuarter == 0` gate is gone); `s_mode[ownedSlot]` |

No host, middleware, Python or buffer-layout change: `dev_mode_running` / `dev_mode_state` stay indexed by the
global mode number, so `exciteMode`, `getModeDisplacements`, mode records 1/3 and presets are unaffected.
`NUM_MODES` / `dev_mode_running` sizing is left to T4 (§R.5 assigns `NUM_MODES ≥ 4096` there; at T1 counts
`N ≤ num_strings ≤ NUM_MODES = 256`).

### Index mapping, before → after (`B` blocks, `S` = 4, `Q` = arraySize/S, `F` = ceil((N−B)/B))

| Quantity | Before (a92500c) | After (T1) | Belarus (B 56, Q 96, N 224) | F15 (B 58, Q 128, N 232) |
|---|---|---|---|---|
| Mode coupled by quarter `k` of block `b` | `k·B + b` | `k=0`: `b` · `k≥1`: `B + b·F + k − 1` | block 1: 1 / 59 / 60 / 61 (was 1 / 57 / 113 / 169) | block 1: 1 / 61 / 62 / 63 (was 1 / 59 / 117 / 175) |
| Feedin row `r` → mode | `(r % S)·B + r / S` | `slotMode(r / S, r % S)` | | |
| Oscillator owner of mode `m` | block `m % B`, thread `(m / B)·Q` | `m < B`: block `m`, thread 0 · `m ≥ B`: block `(m−B) / F`, thread `Q + (m−B) % F` | F = 3; flat owners t = 96, 97, 98 | F = 3; flat owners t = 128, 129, 130 |
| Shared state of mode `m` | `s_mode[m / B]` | `s_mode[slot]`, slot 0 shaped / `1 + j` flat | | |
| Shaped tier | — | quarter 0 = modes `[0, B)` | modes 0–55 (55.7–658 Hz) | modes 0–57 (44.5–1044 Hz; T3 caps at 56) |

Real modes are frequency-sorted in both presets (mode ω non-decreasing over the 196 real modes, measured), so
quarter 0 = the lowest modes as decision Q3 requires.

## 2. Verification

All runs from scratch binaries via `PYTHONPATH` (shared venv untouched): base = installed dev a92500c pyds,
T1 = worktree `setup.py build_ext`. Harness `docs/development/diagnostics/dev-624c-t1-harness.py`,
report `dev-624c-t1-compare.py`, audit `dev-624c-ownership-audit.py`.

**Ownership audit** (baked slots 25/27/28 read back with `getParameters()`, debug build): every placed mode has
**exactly one** owner thread at the layout position and is coupled by exactly one quarter — Belarus 224/224,
F15 232/232, 0 errors. Negative control: the base binary fails the same audit (old map, no slots 27/28).

**Offline render equivalence** (3 s chord C2–C6 ×2, 4 channels, 576 000 samples; N = 6 fresh processes per
binary, interleaved). The engine is not bit-deterministic (float `atomicAdd` order), so base-vs-T1 is judged
against base-vs-base:

| Preset / artefact | base-base relRMS median (max) · corr min | base-T1 relRMS median (max) · corr min |
|---|---|---|
| Belarus audio (release) | 1.820e-3 (1.843e-3) · 0.9999983012 | 1.871e-3 (1.886e-3) · 0.9999982219 |
| Belarus audio (debug, N=3) | 1.825e-3 (1.828e-3) · 0.9999983299 | 1.875e-3 (1.885e-3) · 0.9999982236 |
| F15 audio (release) | 1.029e-4 (1.084e-4) · 0.9999999941 | 1.015e-4 (1.067e-4) · 0.9999999943 |
| F15 audio (debug, N=3) | 1.001e-4 (1.022e-4) · 0.9999999948 | 1.026e-4 (1.065e-4) · 0.9999999943 |
| Belarus / F15 mode state after render (q, q_prev) | 5.0e-5 / 7.4e-5 | 4.0e-5 / 6.1e-5 |
| Belarus / F15 all-mode probe (every mode excited, no strings, 0.25 s) | 5.4e-5 / 1.7e-5 | 4.9e-5 / 2.1e-5 |

Mode config (`dec`/`omega`/`mass_inv`) bit-identical in every run. **Indistinguishable at the single-render
level.** Ensemble check (mean of 3 renders vs 3): F15 base|base 6.0e-5 vs base|T1 5.9e-5 (no systematic
difference); Belarus 1.05e-3 vs 1.11e-3 → a systematic component ≈ 3e-4 relative (≈ ¼ of one run's noise).
Expected: each `feedback/feedin_cycle_matrix` cell now sums a different group of modes (`{b, B+3b, B+3b+1,
B+3b+2}` instead of `{b, B+b, 2B+b, 3B+b}`), i.e. a different fp rounding order — the "fp tolerance" of the
spec, not a math change.

**ptxas budget** (build check passed, 0 spill / 0 stack, smem 18 496 B unchanged):

| `addKernel` | sm_80 | sm_86 | sm_89 |
|---|---|---|---|
| release base → T1 | 98 → 100 | 98 → 101 | 98 → 101 |
| debug base → T1 | 98 → 102 | 99 → 103 | 99 → 103 |

Pre-flight (`[OCCUPANCY]`, loaded binary): regs/thread 101 (release) / 103 (debug), 1 block/SM, capacity
128 ≥ grid 56 / 58 — OK. The 2–4 extra registers are the owner tags (`ownedModeNo`, `ownedSlot`) live across
the sample loop.

**Timing** — `addKernel` CUDA events, 8 s render, N = 6 per binary, interleaved. **Contended:** the user's
backend (:5000) was synthesizing on the same GPU (~46 % util) for the whole A/B; quiet-GPU reference before it
came up: Belarus base 460 µs.

| Preset | base run-mean median (range, sd) | T1 run-mean median (range, sd) | Δ |
|---|---|---|---|
| Belarus (384, si 4) | 869 µs (861–873, 4.7) | 861 µs (858–866, 2.6) | −0.9 % |
| F15 (512, si 16) | 1516 µs (1512–1520, 3.1) | 1518 µs (1508–1529, 7.3) | +0.1 % |

**Unit suite** (Core `tests/unit`, T1 binary, `-k "not esprit"`, `test_band_processing_skip.py` ignored as in
prior wraps): 1934 passed / 4 failed (pre-existing `test_start_right_away_binary`) / 1 skipped.

## 3. Readiness for T3

- **The fork exists where T3 needs it.** Tier is decided once, in `ModeLayout` (`k == 0` shaped, `k ≥ 1`
  flat); flat oscillators are already one-per-thread on contiguous flat threads `t = Q + j`, block-major, with
  their own register `q_prev` and owner-only load / advance / persist.
- **What T3 changes:** (1) flat owners keep `q` in a register instead of `s_mode[1 + j]` and drop the
  transitional slot link (`flatPerBlock ≤ S − 1`) — `flatPerBlock` may then grow to `3Q` per block;
  (2) the feedback scatter and the feedin write/reduce run the per-mode deck only for slot 0 (shaped), and the
  flat tier adds the two `[1 × SEGMENT]` reductions of §R.2 (`F_sum`, `Q_sum`); (3) cap `numShaped` at 56
  (`makeModeLayout`) — on F15 (58 blocks) quarter 0 of blocks 56/57 is then empty; (4) `a(m)²` mass fold and
  shaped deck width 56 at pack time (PianoidBasic).
- **Open (unchanged, for T3):** output-channel readout of flat modes (§R.2 open item) needs a user decision;
  the deck row for feedback is the array position `t` while feedin uses `stringMap[S·b + k]` — identical today
  because the string map is the identity order (measured: baked slot 16 `stringNoForModeMapping` == `S·b + k`
  for every block/quarter on both presets), but T3's uniform broadcast must keep using the array position.
