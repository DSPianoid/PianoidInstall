# dev-reset — runaway-reset (re-apply parked W5-B accumulator clear) — 2026-06-19

## Task
User re-report: "When the system goes astray [runaway/unstable state], the reset cannot stop it —
some leaked state regenerates the sound. When the sound is normal it just decays, so [reset working]
is not audible." I.e. reset cuts a normal note (works) but cannot stop a RUNAWAY.

## Investigation (docs-first + git archaeology)
- The prior RCA memory (`project_reset_output_loop_regression.md`) said this fix was already
  CONFIRMED + implemented (dev-excenergy W5-B, `bf5f720`) — full-clear of feedback_cycle_matrix +
  feedin_cycle_matrix on `*status==500`. **Verified against current code: the fix is ABSENT.**
- Git history: `bf5f720` (W5-B) was implemented, built, measured RESET_CONFIRMED_FIXED, then merged
  to dev (`9aaaa2d`, 21:57) bundled with the physics-energy work. At 22:41 BOTH W5 commits were
  reverted: `4c935b9` (reverts W5-B reset) + `81f0417` (reverts W5-A soft-limiter) — dev-excenergy's
  deliberate "Option-A energy-only revert" (MODULE_LOCKS line ~136). W5-A (limiter removal) was later
  RE-APPLIED (`6e91212`); **W5-B was NOT** — parked per dev-reset Phase-12 (2026-06-18) "PRESERVED for
  reference; team-lead checking with the user whether the reset-button fix is still needed... If
  wanted, re-engage dev-reset or a fresh agent with bf5f720." The user's re-report IS that
  confirmation. So this is a re-application of a known-good, previously-measured patch — not a fresh
  diagnosis.

## Mechanism (the regenerating state)
- Reset branch (MainKernel.cu ~324/345) zeroes the per-cycle ENDPOINTS s_a/s_mode/mode_1. The two
  persistent cycle accumulators feedback_cycle_matrix (= mode_new_position) + feedin_cycle_matrix
  (= mode_position) are only cleared per-iteration inside a RUNNING cycle (~507/~687) — nothing
  zeroes them on reset. With dev-d52b's unity-gain output tap (fb_scale=1.0 on output rows,
  MainKernel.cu ~279) the residual re-rings after a single-cycle reset.
- Host cudaMemset of these buffers is a NO-OP (kernel writeback at cycle end overwrites). Clear MUST
  be in the kernel reset branch.

## Fix (re-applied — byte-identical to bf5f720, comment updated)
MainKernel.cu: on `*status==500`, BEFORE the main loop (after `*n_counter=0`), full-clear both
accumulators across the thread's covered range mirroring the per-iteration clear's exact index expr +
guard (`firstStringAddress * SEGMENT_FOR_SHUFFLE_SUMMATION + stMdIndex`, guarded by
`stMdIndex < SEGMENT_FOR_SHUFFLE_SUMMATION * numStringsInArray`) + allThreads/allBlocks sync.

## Build
HEAVY `--both` from worktree `D:/repos/wt-reset` (cwd worktree, VIRTUAL_ENV = canonical
PianoidCore/.venv; copied untracked detect_paths.py into the worktree for the build). [SUCCESS]
release+debug+sdl_audio_core. .pyd sha 3AE9C70C -> 02F9E03C, L1 import OK.

## Verification (offline / audio_off — the synthesis-output surface)
- FIXED build, normal note (pitch 60 vel 100, release@40): ring rms=171.5 peak=906.9 ->
  after pianoid.reset(): string_state=0, mode=0, output RMS=0.000 for 6 fresh cycles
  (RESET_CONFIRMED_FIXED). No regression: normal notes still decay.
- PRE-FIX build (release-only rebuild of dev MainKernel.cu, same note): ALSO RMS=0 post-reset —
  a NORMAL note already silences on reset even without the fix (matches the user: "normal just decays").
- **The offline harness could NOT reproduce the user's AUDIBLE realtime runaway.** It drives the
  kernel synchronously (runOfflinePlayback/runSynthesisKernel), not the live audio-tap feedback loop.
  High deck_feedback_coefficient (1.5/2/3) DAMPS (late/early ~0.40, rings down) rather than runs away;
  extreme fb=8 jumps straight to NaN (a distinct pathology — post-reset string survives as 966.8
  because NaN poisons the writeback). New harness: docs/development/diagnostics/dev-reset-runaway-repro.py.

## MERGED + PUSHED (user: "commit and push all to dev", 2026-06-19)
- `feature/dev-reset-runaway-accumulator-clear` (1f839ac, rebased onto 9c2dd51) MERGED --no-ff ->
  **PianoidCore dev `df0fa58`**, PUSHED origin/dev (`9c2dd51..df0fa58`).
- **Installed .pyd matches dev — NO rebuild needed:** built off 89b1e9f+fix (sha 02F9E03C); the only
  compiled deltas 89b1e9f..df0fa58 are MainKernel.cu (the fix, IN the .pyd) + Pianoid_synthesis.cu
  (COMMENT-ONLY, no codegen). dev-tip MainKernel.cu byte-identical to the build source.
- Worktree D:/repos/wt-reset removed; feature branch deleted; dev checked out nowhere. Lock released.

## State / handoff (pre-merge snapshot)
- Branch `feature/dev-reset-runaway-accumulator-clear`, commit `1f839ac` (rebased onto PianoidCore
  dev 9c2dd51). One file, +20 lines.
- ★OPEN: the audible realtime runaway was not reproduced offline; the prior W5 "RESET_CONFIRMED_FIXED"
  was also only ever measured on a normal note. The fix is correct for the accumulator-residual
  mechanism + is regression-free, but its efficacy against the user's specific runaway needs either
  (a) the user's exact trigger conditions, or (b) a live-device test.
