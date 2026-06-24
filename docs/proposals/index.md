# Proposals

Design proposals, investigations, and implementation plans for Pianoid. Each proposal is a
self-contained document capturing a problem, its analysis, and a proposed (or implemented) solution.

- **Active** — proposals still relevant to current or upcoming work.
- **Parked** — designs deferred but not abandoned.
- **Archive** — superseded, completed, or historical proposals kept for reference.

---

## Active

- [In-Place CUDA Re-Initialize](cuda-reinit-in-place-2026-06-22.md) — apply STRUCTURAL params without stopping the backend or reloading the preset
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
