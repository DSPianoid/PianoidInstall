# CUDA Kernel Layer — Architecture & Latency Review (2026-07-08)

> Read-only review (Fable). Sources: MainKernel.cu, gaussTest.cu, Kernels.cu, all Pianoid_*.cu,
> UnifiedGpuMemoryManager.cu, FIRFilter.cu, OnlinePlaybackEngine.cu, constants.h + docs. Paths relative
> to PianoidCore\pianoid_cuda\. No code changed. Companion to the parameter-editing-system review.

## ★ THE "THIRD" CONFLICT — update_stream_ is BLOCKING
Three streams: `synthesis_stream_` (nonBlocking, Pianoid.cu:561) ✓, `readback_stream_` (nonBlocking, :569) ✓, **`update_stream_` (double-buffer preset pipeline) = plain `cudaStreamCreate` = BLOCKING (UnifiedGpuMemoryManager.cu:66)**. Two conflicts:
- **(a) Re-couples preset edits into the audio hot path.** Blocking → implicitly syncs with the legacy default stream. Note-on staging memcpys (_load_exct_params_to_GPU, Pianoid_excitation.cu:136/151/161) + the dev_dec_open upload each new-note cycle (blocking cudaMemcpy, UnifiedGpuMemoryManager.cu:534) serialize on-device against in-flight update_stream_ traffic (per edit: up-to-2.5MB H2D + ~3MB D2D SYNCING). A note-on during a slider drag STALLS behind it — the cp0→cp1 contention class dev-cpfix removed, re-introduced via the third stream.
- **(b) SYNCING writes a buffer a live kernel may still be reading.** Poll thread swaps working↔updating then enqueues the SYNCING D2D into the new-updating (= OLD working) buffer (:894-911); the engine adopts the swap only at the next cycle boundary (Pianoid_synthesis.cu:232) → an in-flight addKernel READS the old working buffer while update_stream_ WRITES it → ~1-cycle torn/changed coefficients, defeating "kernels never observe a partially-updated block" (MEMORY_MANAGEMENT.md:97). dev-427c fixed the HOST pointer handoff; the GPU buffer handoff still has this hole.
- **FIX (small):** update_stream_ → `cudaStreamNonBlocking` AND defer `syncBuffers()` until the engine consumes the swap (ack from consumeSwapPending / cudaStreamWaitEvent on a cycle-boundary event).

## SSOT / write-authority
- addKernel TUNABLE (dev_mode_state, host double-buffer) vs WORKING (dev_mode_running kernel-writeback, never swapped) split is EXEMPLARY; feedin/feedback cycle matrices kernel-internal single-owner.
- **new_notes_ind mailbox = real race** (dev-427c class): plain int (Pianoid.cuh:285), producers on Flask thread + engine, drained `=0` at Pianoid_synthesis.cu:371 → a raise between the :295 check and :371 clear is silently LOST (params uploaded but coefficients never recomputed until next note). Same for run_string_map_kernel_ / resetFlag (plain bools cross-thread). FIX: atomics + exchange(0) drain.
- **dev_mode_running dual writer:** kernel writeback + host cudaMemset from the REST thread (resetModeRunningState, Pianoid_parameters.cu:121-125) — the racy-memset pattern the code retracts for dev_string_state; the kernel status==500 path already zeroes it → remove/stream-order.
- **★ kernel_status / incycle_counter are cudaMallocManaged** (Pianoid.cu:541-544), host-written (*kernel_status=500, Pianoid_synthesis.cu:373) while gauss/param kernels may be in flight. On Windows (no concurrentManagedAccess) host access while device busy is UNSUPPORTED → latent access-violation whose signature is **STATUS_IN_PAGE_ERROR (0xC0000006)** — speculative link to the recurring page-fault reports. FIX: device buffer + explicit copy, or pinned.
- kernel_arg_storage_ `vector<void*>` reserved 30, using ~27-29 → one more handler → realloc → EVERY kernel arg dangles. Add capacity guard.
- Excitation TYPE rides the vacated `string_excitation_params[i*3+1]` legacy slot (Pianoid_excitation.cu:63) — 2nd meaning on a reused slot. Naming: mode_position/mode_new_position marshaled into feedin/feedback cycle-matrix params (unrelated names across the launch boundary).

## MODULATION — mostly single-point
Hammer shape folded once (Kernels.cu:158); temporal×coeff once (gaussTest.cu:96); feedback deck×coeff+output-mask composed once (MainKernel.cu:280-283). Volume applied ONLY to soundInt (soundFloat pre-volume, :576-577) AND FIR-on applies volume inside convolutionKernel (FIRFilter.cu:73) → same-name-different-scaling trap; doc it.

## ★ LATENCY (ranked by per-cycle impact)
- **L1 — in-kernel atomic storm on `status`** (MainKernel.cu:741-742): EVERY thread EVERY outer iteration `atomicAdd(status, pointStatus)` ≈ 1.8–3.7M serialized atomics on ONE global word/launch, ~all adding 0. Guard `if(pointStatus!=0)` → free device-time win.
- **L2 — NaN goto = divergent barriers (UB):** `goto nanInData` (:594-596) skips ~10 syncs; NaN thread waits at :743 while healthy at :622 → mismatched barriers = hang/corruption on the very cycle the guard should rescue. Restructure to flow through the normal barriers.
- **L3 — setRuntimeParameters per control tick (review-F9 CONFIRMED):** 2 blocking default-stream memcpys (:567,596) + device-wide `cudaDeviceSynchronize` (:613, drains ALL streams incl. synthesis) + ~25 PLOG lines. MIDI CC74/volume sweeps hit dozens/sec.
- **L4 — unconditional per-cycle D2H + 3 stream syncs:** record_to_host hardwired true online (OnlinePlaybackEngine.cu:182-183) → soundFloat+soundInt ring appends + tail check, each a cudaStreamSynchronize; the Sint32 ring feeds only capture endpoints → make lazy.
- **L5 — PLOG on the MMCSS/TIME_CRITICAL synthesis thread = priority inversion:** logger default ON, global mutex+vfprintf shared with normal-prio Flask threads; PLOGs every note-on cycle. Next preemption-class risk after cp0→cp1. Lock-free/ring log for the RT thread.
- **L6 — DROP_IF_BUSY last-value loss:** per slider tick full D2H + full H2D + ~3MB SYNCING + printf; under DROP_IF_BUSY the FINAL edit of a drag can be the dropped one → engine stuck at penultimate, no retry. QUEUE_NEXT declared but unimplemented (:129-133) → implement queue-latest.
- **L7 — FIR-on path:** ~5 sequential stream syncs + 4 memset/memcpy + 2 extra kernels/cycle → one enqueued chain + terminal sync.
- **L8 — structural ceiling:** launch-per-cycle cooperative kernel + blocking host sync + per-launch deck/parameter reload scaling with mode/string count → persistent-kernel redesign is the strategic option for the 4000-mode goal (not a fix now).

## Other (ranked) + What's GOOD
Dead code retaining the FIXED race: `updateDerivedPointers()` (UnifiedGpuMemoryManager.cu:1041, no callers) — delete. ~12MB dead allocations (dev_string_excitations, dev_soundDouble, dev_stem, filter temps, nextIndexKernel). gaussTest harness cudaFree leaks (test-only). fetchExcitation still device-wide-syncs (Pianoid_debug.cu:173,206) — inconsistent with its readback_stream_ siblings.
GOOD (preserve): dev-427c engine-thread-only pointer adoption; the stream-decouple across the synthesis TU; single-envelope excitation staging; descriptor-parameterized CLAMP/WRAP; UnifiedGpuMemoryManager as sole allocation authority.

## Top recommendations (priority)
1. update_stream_ → non-blocking + order SYNCING after engine swap-consumption (closes both third-stream conflicts).
2. Guard the status atomicAdd (L1) + converge the NaN-exit barriers (L2) — one small kernel patch.
3. Atomicize new_notes_ind / run_string_map_kernel_ / resetFlag with lost-raise-proof drain.
4. Strip setRuntimeParameters to a stream-ordered upload + 1 log line (L3).
5. Replace managed kernel_status/incycle_counter (Windows managed-access hazard → likely 0xC0000006).
6. Implement QUEUE_NEXT queue-latest; lazy Sint32 ring; PLOG off the RT cycle path.
7. Housekeeping: delete updateDerivedPointers + dead buffers; rename mode_position/mode_new_position; kernel_arg_storage_ capacity guard.
