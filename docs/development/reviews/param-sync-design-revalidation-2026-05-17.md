# PARAM_SYNC_DESIGN — Re-Validation Against Current Codebase

- **Type:** Design re-validation / audit (read-only investigation, no code changes)
- **Date:** 2026-05-17
- **Subject:** [`docs/proposals/PARAM_SYNC_DESIGN.md`](../../proposals/PARAM_SYNC_DESIGN.md) — "Cycle-Synchronized Parameter Updates"
- **Design authored:** 2026-04-23 (`dev-paramsync`, commit `cc8f528`); moved to `docs/proposals/` 2026-05-09 (`eec59af`, doc-cleanup pass, kept as "active design")
- **Trigger:** before deciding build-vs-park, confirm the design still holds against the current engine.

---

## Verdict

**STILL SOUND as a correctness directive — but the build case has weakened. Recommend PARK (do not build now); revisit only if a measured GPU race is observed.**

The design's *architecture* is sound and remains implementable roughly as written: every CUDA structure, kernel entry point, and middleware path it hooks into still exists and still behaves as the design assumes. Only one of ~14 premises has drifted, and that drift (F5 stream topology) makes the design *easier*, not harder.

The reason for PARK is not a broken premise — it is that the design's **motivating evidence has been re-diagnosed**. The design was written to fix audible iter=8 distortion and explicitly named concurrent parameter writes as "the primary current interference vector" (§6.2). Since 2026-04-23, the `dev-f5-stream` investigation (WIP "Buffer Underrun Investigation", 2026-04-22 onward) measured the distortion same-harness A/B and concluded it is **compute-bound** — the synthesis kernel is over/near budget at iter=8/12 — **not** serialization-bound. The design's §1 anticipated exactly this ("Even if a profiler shows the current audible distortion is driven by something else, the invariant is non-negotiable") and reframed itself as a pure correctness directive. That reframing survives the new evidence — but it means the design now fixes a *theoretical* race with no observed audible symptom, which changes it from "ship to fix distortion" to "harden a latent correctness gap." That is a legitimate goal, but a lower priority for a heavy multi-phase CUDA change. No measured evidence currently shows a parameter write corrupting a kernel.

The design is **not implemented** (confirmed: no `PARAM_UPDATE_RUNTIME`, `PARAM_UPDATE_BULK`, `PARAM_UPDATE_PRESET_SWITCH`, `serviceAsyncUpdates`, `setRuntimeScalar`, or `concurrent_writes_during_kernel_` symbols anywhere in the source tree) and is **not superseded** (nothing shipped that does cycle-synchronized parameter application).

---

## Premise-by-Premise Check

Each row is an architectural assumption the design makes. "Holds" = the current code still matches what the design assumed.

| # | Premise (from design) | Holds | Evidence |
|---|---|---|---|
| 1 | `OnlinePlaybackEngine::run()` calls `processEventsAtCycle(cycle)` before `runCycle()` launches the kernel — the "between cycles" hook. | **Y** | `OnlinePlaybackEngine.cu:101` `processEventsAtCycle(cycle_index)` then `:110` `runCycle({Online, true})`. Loop body unchanged in structure since the design was written. |
| 2 | `RealTimeEventBuffer` is a thread-safe per-cycle buffer drained on the engine thread; producer push < 1μs. | **Y** | `RealTimeEventBuffer.h/.cu` present, `std::multimap<uint32_t,PlaybackEvent>`, `pushEvent`/`drainEventsUpTo` thread-safe (`docs/.../PLAYBACK_SYSTEM.md` "RealTimeEventBuffer"). File mtime Apr 23 — untouched since. |
| 3 | `PlaybackEvent` has `PARAM_UPDATE_SINGLE` (0xE0) and `PARAM_UPDATE_BATCH` (0xE1) event types. | **Y** | `PlaybackEvent.h:19-20`. Enum unchanged. `ParameterUpdateEvent` struct (`:92-109`) still carries `param_type`/`string_index`/`value`. |
| 4 | `EventDispatcher::handleParameterUpdate` exists and maps the event to `updateSingleStringParameter_NEW`. | **Y** | `EventDispatcher.cu:138-183` — handler intact, calls `pianoid_->updateSingleStringParameter_NEW(param_name, string_index, value)` at `:182`. |
| 5 | `processEventsAtCycle` runs on the engine thread before kernel launch; any `cudaMemcpy` issued inside it is naturally sequenced before the kernel. | **Y** | Confirmed by #1. Engine thread = the thread inside `OnlinePlaybackEngine::run()`. |
| 6 | The bulk paths (`setNewPhysicalParameters` etc.), `setRuntimeParameters`, and `switchPreset` run on the **caller's** thread (Flask/WS/MIDI) and write to GPU concurrently with the engine. | **Y** | `Pianoid.cu:1245` `setRuntimeParameters` runs entirely on the caller thread. `docs/.../DATA_FLOWS.md` §2.1-2.8 confirm bulk + preset paths still execute under `cuda_lock` on the Flask thread, never on the engine thread. |
| 7 | `setRuntimeParameters` does a **synchronous** `cudaMemcpy` on the default stream — the named interference vector. | **Y (worse than stated)** | `Pianoid.cu:1288` and `:1317` are synchronous `cudaMemcpy` (default stream), **followed by `cudaDeviceSynchronize()` at `:1334`**. The design cited "Pianoid.cu:1283, 1312" — line numbers drifted by ~5 (file edited since) but the code is exactly as described. The extra `cudaDeviceSynchronize` makes the host-thread perturbation strictly larger than the design's "implicit sync point" wording. |
| 8 | `dev_main_volume_coeff` / `dev_deck_feedback_coeff` are the runtime scalar target buffers. | **Y** | `Pianoid.cu:1289`, `:1318` `getRealPointer("dev_main_volume_coeff" / "dev_deck_feedback_coeff")`. Buffer names unchanged. |
| 9 | `updateTunableParameter` issues `cudaMemcpyAsync` on `update_stream_`; the host-side pointer swap is done by a **background poll thread**, not at a cycle boundary. | **Y** | `UnifiedGpuMemoryManager.cu:66` creates `update_stream_`; `:103` spawns `poll_thread_` running `updatePollThread`; `:922-958` poll loop does `cudaEventQuery` → `swapBuffers()` → `syncBuffers()` with a 100μs `sleep_for` (`:954`). Exactly the state machine the design proposes to retire. |
| 10 | The four-state pipeline `IDLE→UPDATING→SWAPPING→SYNCING→IDLE` exists and is poll-thread-driven. | **Y** | `updatePollThread` body confirms all four states; `docs/.../MEMORY_MANAGEMENT.md` "Double-Buffering" documents the same machine. `UpdatePolicy{DROP_IF_BUSY, BLOCK_UNTIL_READY, QUEUE_NEXT}` unchanged. |
| 11 | `Pianoid::switchPreset(name, async)` → `memory_manager_.switchPreset(...)`; REST path passes `async=false` and blocks the Flask thread. | **Y** | `docs/.../DATA_FLOWS.md` §2.8 "Known Limitations": "Async switch hardcoded to sync: `preset_switch_route()` always passes `async_switch=False`, blocking the Flask thread". Unchanged. |
| 12 | `cuda_lock` (Python `threading.Lock`) wraps param writes but the engine thread does NOT take it — so it does not protect against GPU races. | **Y** | `docs/.../DATA_FLOWS.md` "Thread Safety Model": Flask thread uses `cuda_lock`; Engine thread "Reads `RealTimeEventBuffer` via `std::mutex`" — different lock. The design's core observation is still correct. |
| 13 | `OfflinePlaybackEngine::run` owns its own thread and serialises events with `runCycle` the same way — offline unaffected. | **Y** | `docs/.../PLAYBACK_SYSTEM.md` + `DATA_FLOWS.md` §1.5 confirm `OfflinePlaybackEngine` is single-threaded, `processEventsAtCycle` → `runCycle({Offline,false})` per cycle. |
| 14 | **Open Question #1** — F5 added a dedicated stream for `CircularBuffer::produce()`; the main kernel still launches on the default stream; F5 agent "may have already" moved the synth kernel to a dedicated stream. | **N — partially drifted (in the design's favour)** | F5 **shipped** (`735d80d`, 2026-04-22). `CircularBuffer.cu:61` creates `produce_stream` (`cudaStreamCreateWithFlags`, non-blocking) and `produce()` copies on it (`:133`). BUT the **main synthesis kernels still launch on the default stream** — `runSynthesisKernel` (`Pianoid.cu:2096`) launches `stringMapKernel<<<...>>>` and `gaussKernel<<<...>>>` with **no stream argument**. So Open Question #1 is now answered: the synth kernel was NOT moved to a dedicated stream. The design's §4.3 `cudaStreamWaitEvent(default_stream, update_complete_event_)` plan is still implementable as written (default stream is fine as the wait target), but the design should drop the speculative "F5 agent may have already done this" and state plainly: synth kernel is on the default stream; `update_stream_` is the only non-default stream relevant here besides `produce_stream`. |
| 15 | Baseline evidence §6: iter=8 distorts, iter=4 clean, distortion is param-interference-driven and live-only. | **N — re-diagnosed** | WIP "Buffer Underrun Investigation" (lines 1036-1064): same-harness A/B refuted the serialization hypothesis. Conclusion: distortion is **compute-bound** (iter=12 → 110% underrun = kernel over budget; iter=8 → 33% = kernel near budget, OS scheduling tips it over). The "~100%→33%" improvement the design's context relied on was a cross-load measurement error (an `string_iterations` plural-kwarg drop ran at iter=12 not iter=8). No measured evidence of a parameter write corrupting a kernel exists. |

**Score: 13 of 15 premises hold unchanged. #14 drifted in the design's favour (clarification only). #15 — the motivating evidence — was re-diagnosed and no longer supports a "fixes distortion" claim.**

---

## What Must Change in the Design Before It Is Buildable

The design is implementable today, but three edits are needed for honesty and accuracy before a `/dev` agent should pick it up:

1. **Reframe §6 (Baseline Evidence) and §9 success criterion 3.** The iter=8 distortion premise is dead. Success criterion 3 ("iter=8 audio distortion is measurably reduced … RMS spectrum match within 0.5 dB") must be **deleted or inverted** — the WIP investigation already established that param sync will NOT reduce iter=8 distortion (it is compute-bound). Keeping that criterion would make the design un-passable. Replace it with the §5.3 framing's *negative* form already half-present in §6.3: "post-fix, the concurrent-write counter is the acceptance gate; audio is expected to be unchanged."
2. **§4.3 / Open Question #1 — resolve the stream topology.** State as fact: the synthesis kernel launches on the default stream (verified `Pianoid.cu:2096`). The `cudaStreamWaitEvent` fence in §4.3 targets the default stream. Delete the "F5 agent may have already done this — we should coordinate" hedge; F5 shipped and did not touch the synth-kernel stream.
3. **§4.5 / §6.2 — line-number refresh.** `setRuntimeParameters` is at `Pianoid.cu:1245` (body), with the two `cudaMemcpy` calls at `:1288`/`:1317` and a `cudaDeviceSynchronize` at `:1334` (the design cited 1283/1312/1362). Minor, but the design quotes exact lines as evidence, so they should be re-anchored. Note the `cudaDeviceSynchronize` explicitly — it strengthens the design's own argument.

No structural redesign is required. The mechanism (queue `PARAM_UPDATE_*` events into `RealTimeEventBuffer`, drain on the engine thread inside `processEventsAtCycle`, retire the poll thread in favour of `serviceAsyncUpdates`) is fully supported by the current code.

One **new** consideration the design predates: the `dev-midi-p1` single-envelope refactor (`fdf3dd2`, 2026-05-11) changed `dispatchBatch` so the `beginStringBatch`/`commitStringBatch` envelope opens **only when an excitation event is present** in the batch. `PARAM_UPDATE_*` events are not excitation events, so a cycle that drains only param-update events will not open the envelope — which is correct and desirable (param updates must not force an idle-cycle `parameterKernel` launch). The design's §4.3 ordering ("for each event, dispatch") is compatible, but the design text should note that param-update handlers run *outside* the string-batch envelope and must not assume it is open.

---

## Effort / Risk Estimate

A heavy, multi-phase CUDA change. `.cu`/`.cpp`/`.cuh` edits → CUDA rebuild (`build_pianoid_cuda.bat --heavy`) on every iteration → must go through `/dev`.

| Phase | Work | Effort | Risk |
|---|---|---|---|
| 0 | §5.1 concurrent-write counter (`concurrent_writes_during_kernel_` + engine-thread-id capture). Acceptance gate for all later phases. | S (hours) | Low. Debug-build-only instrumentation. |
| 1 | Runtime-scalar path (`PARAM_UPDATE_RUNTIME`, `setRuntimeScalar`, producer shims for volume / deck-fb / volume-center/range / max-volume / iter). Event envelope extension for the scalar payload (8-byte `data` field suffices — §4.1). | M (1-2 days) | Medium. Touches the hottest producer path (MIDI CC at up to 1 kHz). |
| 2 | Bulk-tunable path (`PARAM_UPDATE_BULK` + `shared_ptr` payload in the event envelope) for physics/hammer/excitation/modes/deck. Engine-side handlers. | M-L | Medium. Event-envelope size grows; `shared_ptr` lifetime across the buffer must be correct. |
| 3 | **Poll-thread retirement** → `serviceAsyncUpdates()` called at cycle start. Highest-risk item: it changes the `UpdateState` machine's driver from a background thread to the engine thread. | L (3+ days) | **High.** The poll thread today owns `swapBuffers`/`syncBuffers`. Moving that onto the engine thread risks regressing every parameter update path and the preset library hot-switch. Needs the §5.2 bit-identical-render test as a guard. |
| 4 | Preset-switch path (`PARAM_UPDATE_PRESET_SWITCH`). | M | Medium. Interacts with the GPU-resident preset library (D2D path). |
| 5 | Precondition assertions on direct C++ APIs; Python re-routing; docs; 3 new test files. | M | Low-Medium. Mostly mechanical; the semantic change (calls return before the GPU write lands) can break startup-path tests — design §7.3 already flags this. |

**Total: roughly 8-12 working days across 6 phases, dominated by Phase 3 (poll-thread retirement).** This is a serious investment. Given that premise #15 removed the audible-distortion payoff, the return is "a provably race-free parameter path" — valuable as hardening, but not urgent, and not currently backed by any observed failure.

**Risk if NOT built:** the latent race the design describes is real (premises #6, #7, #12 all hold). A concurrent `cudaMemcpy` to a live-read buffer *can* in principle corrupt a kernel read. But: (a) `setRuntimeParameters` ends with `cudaDeviceSynchronize`, so the runtime-scalar path actually serialises hard against any in-flight kernel rather than racing it — it perturbs *timing* (a real defect) but does not produce a *torn read*; (b) the bulk path uses double-buffering, so the kernel reads a stable `working` copy while `updating` is written — the documented race window is the poll-thread pointer swap, not the memcpy itself; (c) no measured audio corruption has been attributed to this. So the practical risk is **timing jitter on the runtime-scalar path**, not memory corruption — and jitter is exactly what the compute-bound diagnosis already identifies as the dominant underrun cause. Param sync would remove one jitter source among several; it would not, on current evidence, move the underrun rate.

---

## Recommendation

1. **Do not build now.** Park the design.
2. **Apply the three §"What Must Change" edits to `PARAM_SYNC_DESIGN.md`** (reframe the dead distortion premise, resolve the stream-topology open question, refresh line numbers) so the doc does not mislead a future reader into thinking it fixes iter=8 distortion. *(This is a documentation edit — out of scope for this read-only re-validation; flag for an `/update-docs` pass or a follow-up.)*
3. **If the design is revived**, do Phase 0 (the concurrent-write counter) first as a standalone `/dev` task. It is cheap (S), low-risk, and will *measure* whether the race the design targets actually fires under load. If the counter reads 0 after the §5.1 battery on the current code, the design's premise is empirically dead and it can be archived. If it rises, that is the missing measured evidence that would justify the full 8-12 day build.
4. **Keep the design in `docs/proposals/`** (it is still an active, valid design) — but it should carry a status note pointing at this re-validation and at the WIP "Buffer Underrun Investigation" compute-bound conclusion.

---

## Cross-References

- Design under review: [`docs/proposals/PARAM_SYNC_DESIGN.md`](../../proposals/PARAM_SYNC_DESIGN.md)
- Compute-bound re-diagnosis of the motivating distortion: `docs/development/WORK_IN_PROGRESS.md` — "Buffer Underrun Investigation" (lines 1036-1064)
- F5 dedicated-stream change (Open Question #1): commit `735d80d`, `CircularBuffer.cu`
- Single-envelope refactor that postdates the design: commit `fdf3dd2` (`dev-midi-p1`), `EventDispatcher.cu:58-97`
- Documented architecture verified against: `docs/modules/pianoid-cuda/PARAMETER_SYSTEM.md`, `MEMORY_MANAGEMENT.md`, `PLAYBACK_SYSTEM.md`; `docs/architecture/DATA_FLOWS.md` §2
