# Proposals

Design proposals, investigations, and implementation plans for Pianoid. Each proposal is a
self-contained document capturing a problem, its analysis, and a proposed (or implemented) solution.

- **Active** — proposals still relevant to current or upcoming work.
- **Parked** — designs deferred but not abandoned.
- **Archive** — superseded, completed, or historical proposals kept for reference.

---

## Active

- [Controlled Playback: Exciter Current Sensing and Limiting](controlled-playback-exciter-current-2026-10-20.md) — current / board sensors on the UMC inputs metered in the ASIO callback during normal playback, a per-exciter current-limit safety limiter (fast attack, hold-off one round trip, slow release), optional closed-loop trim, `exciter_telemetry` at 25 Hz, the Exciter Monitor pane, assistant commands, failure modes. Status: Phase 1 implemented (dev-8f54); Phase 2 (closed loop on real sensors, board limit, fault actions) open
- [AI Assistant in the Pianoid UI](ai-assistant-in-ui-2026-10-13.md) — rev 2 FULL CONTROL: launcher-hosted Claude API tool runner whose tools ARE the unified command registry; executes param writes, layout/UI commands, playback and jobs directly inside an audio-safety envelope, confirms only destructive ops, grouped backend undo; phases A1–A5 + MCP as thin adapter. Status: proposal, blocked on the infrastructure below
- [Assistant v2: State, Runbook, Code, Physics, Bugs, Web, Approvals](assistant-v2-2026-10-16.md) — the user's 2026-10-16 requirements: full state snapshot (`system.*` reads), a machine-readable runbook + UI-action coverage audit, a sandboxed `analysis.run_python` (AppContainer + Job Object, artefact store), deterministic Opus pre-routing, a physics primer + sourced timbre → parameter table (UNKNOWN where undocumented), bug filing (local collector + GitHub on a click, de-dup), a web researcher sub-agent with taint, per-category auto-approve with a hard-confirm list; phases P0–P8, decisions V1–V14. Status: proposal
- [Assistant Infrastructure Prerequisites](assistant-infrastructure-2026-10-13.md) — backend-authoritative `state_changed` broadcast (inventory of 14 write paths bypassing `apply_parameter_request`), FE editor sync + reconnect resync (half-open WS), backend undo, command registry + jobs, layout-control API; dispatchable `/dev` tasks I0–I5 with verification surfaces
- [Current-Referenced Modal Measurement Program](modal-current-referenced-program-2026-10-14.md) — uses the coil currents as the force reference. Covers per-ampere vs per-volt, re-referencing existing data, the force calibration (Bl and the inertial-exciter T(ω) by the added-mass method), the sensor strategy (2nd UMC over ADAT, roving grid densities), driving points, reciprocity, scaling, the 32 Hz board-mode test, and a session plan S0–S7. Status: proposal (dev-fd69)
- [ASIO Audio Core — Retire sdl_audio_core / SDL3](asio-audio-core-retire-sdl-2026-10-11.md) — inventory of every SDL audio use, ASIO host capabilities/gaps (already duplex, 18 in / 20 out on UMC1820), shared CUDA-free ASIO core + `pianoid_audio` module (preloaded output matrix, sample-locked multichannel capture, latency compensation), phased migration + open decisions. Status: Phase 0 + 1-lite (dev-1b6c) and Phase 3 modal-adapter migration + `sdl_audio_core` retirement (dev-4284) done; engine-free host pending
- [Loudness Chain — Where the Engine Deviates from the Physical Model](loudness-physics-deviation-analysis-2026-10-04.md) — measured attribution of the 45–50 dB equal-mass keyboard spread: string gain ∝ ρ·dx² (code), unison ×n (code), curve duration vs period and mode-mass law (data); fix order + expected mass ranges
- [Automatic Volume Equalization — System Review](volume-equalization-review-2026-10-04.md) — every level mechanism end to end; single-note calibration vs chords/keyboard, no limiter, inert mic equalizer, cache not keyed by load params

- [Managing the FPGA System from the Pianoid UI](fpga-system-management-2026-10-22.md) — what the repos know about Dima's FPGA + stm32 instrument (UDP :5555 frame protocol, send_all, no read-back, 16 transducer drives); four tiers (preset exchange, live link, full control, unified UI) with a `FpgaTarget` / `fpga_protocol` architecture, `fpga.*` assistant commands, open questions for the user and Dima, first step. Status: proposal
- [FPGA → GPU Preset Port — Algorithm Comparison & Mapping (Elyashev F_15)](fpga-to-gpu-preset-port-2026-09-30.md) — FPGA RTL/C reverse-engineering, per-stage comparison, porting table, draft converter, open questions for Dima
- [In-Place CUDA Re-Initialize](cuda-reinit-in-place-2026-06-22.md) — apply STRUCTURAL params without stopping the backend or reloading the preset
- [Excitation Loudness / Impulse Normalization — Corrected Model](excitation-loudness-normalization-correction-2026-06-30.md) — corrects the PART-1 frontend renorm (inert + wrong-assumption); recommends removing it + merging the engine conserve fix
- [Physics-Based Excitation Energy + Curve-Energy Normalization](excitation-physical-energy-2026-06-16.md)
- [Generic Agentic-Development Skillset — Core Principles](generic-dev-skillset-principles-2026-06-24.md)
- [Generic Agentic-Development Skillset — Open-Source Design](generic-dev-skillset-opensource-2026-06-11.md)
- [Comprehensive In-Place Generic / Project Separation — Plan & Structural Design](generic-project-separation-plan-2026-06-11.md)
- [4000-Mode Two-Tier (Shaped / Flat) Implementation Proposal](mode-scaling-4000-implementation-proposal-2026-06-06.md)
- [Register / Memory (Occupancy) Management Framework — Plan](register-memory-management-plan-2026-06-10.md)
- [CPU Synthesis for No-CUDA Mode — Deferred Follow-up](no-cuda-cpu-synthesis-2026-06-10.md)
- [Single feedback/feedin coefficient SLIDER](feedback-coefficient-slider-2026-06-05.md)
- [Modes-Explosion → NaN Runtime Gate](modes-explosion-nan-gate-2026-06-04.md)
- [Matrix Select-to-Zoom + Selection-Scoped Edits](matrix-select-zoom-2026-06-05.md)
- [System-Wide Selection + Per-Chart Zoom — Design](system-wide-selection-2026-06-06.md)
- [Live Measurement + Processing Flow](live-processing-flow-2026-05-22.md)
- [Modal Mass + Q-Factor — Consolidated Research](modal-mass-q-factor-2026-05-24-merged.md)
- [Modal Adapter — Split the God-Object](modal-adapter-split-2026-05-21.md)
- [Modal Adapter Facade — Final Slim (shim removal wave)](modal-adapter-facade-shim-removal-2026-06-06.md)
- [Synthetic Dataset Generator for ESPRIT-Tracker Validation](synthetic-dataset-generator-esprit-2026-06-06.md)
- [Bridge-From-Grid Derivation (Deferred)](BRIDGE_FROM_GRID.md)

### Dev pipeline (DeepSeek / Opus)

- [Plug DeepSeek into the /dev + /fn pipeline](deepseek-dev-pipeline-integration-2026-06-06.md)
- [DeepSeek Batch Codegen Pipeline — Production Design](deepseek-batch-pipeline-production-2026-06-06.md)
- [DeepSeek Codegen Delegation — Claude-Side Overhead Analysis](deepseek-delegation-overhead-2026-06-06.md)
- [DeepSeek Codegen Pipeline — Quality-Competitiveness Upgrades](deepseek-pipeline-upgrades-2026-06-07.md)
- [Minimizing Opus API Calls Across the Dev Pipeline](minimize-opus-calls-dev-pipeline-2026-06-06.md)

---

## Parked

- [Cycle-Synchronized Parameter Updates — Design](parked/PARAM_SYNC_DESIGN.md)

---

## Archive

- [Preset System Revision — Per-Preset Runtime State & Complete Switch](archive/preset-system-revision-plan-2026-04-09.md)
- [Preset Working-Copy Model — Edit Isolation, Read-Only Originals](archive/preset-working-copy-model-2026-05-17.md)
- [ESPRIT Per-Channel Timing Analysis](archive/esprit-channel-timing-analysis-2026-05-08.md)
- [Multichannel Hankel ESPRIT Experiment](archive/multichannel-hankel-experiment-2026-05-08.md)
- [Multichannel Hankel ESPRIT — Phase B: model_order Sweep](archive/multichannel-hankel-phase-b-2026-05-09.md)
- [Kernel MIDI Batch Investigation](archive/kernel-midi-batch-investigation-2026-05-08.md)
- [MIDI Input Relocation Analysis](archive/midi-input-relocation-analysis-2026-05-08.md)
- [MIDI System Refactoring — Consolidated Plan](archive/midi-system-refactoring-plan-2026-05-08.md)
- [MIDI / Online-Playback System Refactoring — REVISED Plan](archive/midi-system-refactoring-plan-revised-2026-05-08.md)
- [MIDI Refactor — Implementation Plan (Wave Breakdown)](archive/midi-implementation-plan.md)
- [Modal Adapter Collect Subpanel Overhaul (SUPERSEDED)](archive/modal-adapter-collect-overhaul-2026-05-10.md)
- [Modal Adapter — Measurement Entity Refactor (Option B)](archive/modal-adapter-measurement-entity-2026-05-10.md)
- [Modal Adapter Dialog Review — Inventory + Consolidation](archive/modal-adapter-dialog-review-2026-05-26.md)
- [Modal Mass NaN Investigation — LG_p3](archive/modal-mass-nan-investigation-2026-05-26.md)
- [Collect Sub-Pane Migration from RoomResponse Series Settings](archive/COLLECT_MIGRATION_FROM_ROOMRESPONSE.md)
- [Reorganize the Collection Subpanel to Match the Standard Settings Architecture](archive/collection-subpanel-reorg-2026-05-26.md)
- [Controller Agent Role](archive/controller-role.md)
- [Controller Implementation Patches](archive/controller-implementation-patches.md)
- [Agent-Stall-Resilience](archive/agent-stall-resilience-2026-05-24.md)
- [Courant/CFL Stability Guard in parameterKernel](archive/courant-stability-guard.md)
- [Courant/CFL Stability Guard — v2 (Simple, Robust Rewrite)](archive/cfl-stability-guard-v2.md)
- [Feedback-over-Excitation Runaway Gating](archive/feedback-excitation-gating-2026-05-30.md)
- [Online vs Offline Synthesis — Root-Cause Analysis & Path Unification](archive/online-offline-synthesis-unification-2026-05-29.md)
- [Chart-native playback for audio-containing charts — Phase A2](archive/chart-native-playback-2026-05-31.md)
- [Drawable Chart Merge — Line-vs-Bar Unification](archive/DRAWABLE_CHART_MERGE.md)
- [Sound Test diagnostic chart — design](archive/sound-test-chart-2026-05-30.md)
- [Cursor-Position Drift in NumInput — Deep Analysis](archive/cursor-drift-analysis-2026-05-17.md)
- [Split the Pianoid.cu God-Object](archive/pianoid-cu-split-proposal-2026-05-19.md)
- [FPGA Preset Excitation Loader — schema discovery](archive/fpga-preset-excitation-loader-2026-05-17.md)
- [No-CUDA Graceful Mode — Design](archive/no-cuda-graceful-mode-2026-06-10.md)
- [setup-packages: detect + reinstall the NVIDIA DISPLAY DRIVER](archive/setup-packages-driver-reinstall-2026-06-10.md)
- [Build / Rebuild / Update Instruction-Set — Audit & Consolidation](archive/build-rebuild-consolidation-2026-06-05.md)
- [OpenAI Gate — Claude Code → OpenAI Services](archive/openai-gate.md)
- [Windows / Linux Track Separation](archive/windows-linux-separation.md)

---

> Composition notes for proposal authoring live in `proposals/.process/` (not served).
