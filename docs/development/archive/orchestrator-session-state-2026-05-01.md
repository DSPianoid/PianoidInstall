# Orchestrator Session State — 2026-05-01

**Saved:** 2026-05-01 (user restarting computer)
**Orchestrator session id:** ff85d739-3392-496c-ab7f-733dc2f8e6d8
**Telegram channel:** active (sender 178036990)

---

## Today's accomplishments (in chronological order)

### Wrap-up of yesterday's work (orchestrator did directly, sandbox blocked doc agents)

- `2df83d4` (PianoidInstall) — `[orchestrator-wrap-up] docs: codify SoundChannels stored-vs-effective contract and deck/SC disambiguation` — applied investigation agent's Deliverable 1 doc proposals
- Memory entries: `feedback_measurement_first_data_model_bugs.md`, `feedback_three_line_patch_smell.md`, `feedback_stand_down_stale_agents.md`, `feedback_high_stakes_inference_categories.md`
- `a60b476` (PianoidInstall) — `[orchestrator-wrap-up] docs(CLAUDE): add per-project /dev rules + high-stakes inference categories from dev-833f investigation`

### RoomResponse SDL3 migration (Wave dev-sdl3, dev-sdl3-88fa)

- `349b6fb` (RoomResponse, branch `dev`) — `[dev-sdl3-88fa] feat: migrate sdl_audio_core from SDL2 to SDL3 3.2.0` (20 files, +1054/-599; 38/38 pytest pass; synthetic IR correlation = 1.0 baseline)
- `025704f` (PianoidInstall) — `[dev-sdl3-88fa] docs: log dev-sdl3-88fa SDL3 migration session`
- `1630821` (PianoidInstall) — `[dev-sdl3-88fa] chore: wrap up dev-sdl3-88fa`

### Modal Adapter measurement collection — Waves B-0, B-1, B-3 (skipping B-2/B-4/B-5 for v2)

**Wave B-0 — RoomResponse bootstrap + /modal/collect/health (dev-modal-b0-6558):**
- `38bdfec` (PianoidCore) — `[dev-modal-b0-6558] feat(modal_adapter): add RoomResponse bootstrap + /modal/collect/health` (3 files, +124 LOC; sys.path injection over `D:/repos/RoomResponse`; soft-failure pattern)
- `a94d6d0` (PianoidInstall) — `[dev-modal-b0-6558] docs: log dev-modal-b0-6558 + RoomResponse bootstrap section` (3 files, +162)
- `ef68220` (PianoidInstall) — `[dev-modal-b0-6558] chore: wrap up dev-modal-b0-6558`

**Wave B-1 — Backend measurement collection engine (dev-de72):**
- `c986f71` (PianoidCore) — `[dev-de72] feat(modal_adapter): add measurement collection backend (B-1)` (4 files, +1218 LOC; MeasurementSession class + 5 REST endpoints + 7 hermetic integration tests; live curl-only end-to-end verified against real RoomResponse)
- `52b1702` (PianoidInstall) — `[dev-de72] docs: log dev-de72 + Modal Adapter measurement collection (B-1)` (6 files, +503; new MODAL_COLLECTION.md, REST_API.md additions, DATA_FLOWS.md §5, mkdocs.yml entry, WIP active session row + 4th deferred bug entry)
- `096d5a6` (PianoidInstall) — `[dev-de72] chore: wrap up dev-de72`

**Wave B-3 — Collect panel UI + measurement-collection hook (dev-modal-b3-1606):**
- `a56c17e` (PianoidTunner, branch `dev`) — `[dev-modal-b3-1606] feat(modal_adapter): add Collect panel + measurement-collection hook (B-3)` (3 files: useMeasurementCollection.js 169 LOC, CollectPanel.jsx 427 LOC, ModalAdapter.jsx +11 LOC delta to 1088 RED C4)
- `b5d274f` (PianoidInstall) — `[dev-modal-b3-1606] docs: log dev-modal-b3-1606 + Collect panel docs (B-3)`
- `c1a719c` (PianoidInstall) — `[dev-modal-b3-1606] chore: wrap up dev-modal-b3-1606`

### Bug A — Cross-mode-count /preset/switch crash (dev-c529)

- `92e2ba2` (PianoidCore) — `[dev-c529] fix(pianoid): swap mp on switch_preset; add cross-mode-count regression test` (~7 LOC fix + 190 LOC test; both directions verified, including silent-truncation reverse case)
- `20f31d1` (PianoidInstall) — `[dev-c529] docs: mark Bug A fixed; correct DATA_FLOWS.md library-model swap`
- `d4f1e29` (PianoidInstall) — `[dev-c529] chore: wrap up dev-c529`

### Bug #2 — /load_preset audio_driver_type=0 crash (dev-f99c) — collapses Bug #3 too

- `ed96c2e` (PianoidCore) — `[dev-f99c] fix(pianoid): pin audio_driver_type=0 to SDL3 + chunks=16; resolves Bug #2 + Bug #3 in-place reload crash` (8 LOC fix + 175 LOC tests; live before/after verified)
- `bac4729` (PianoidInstall) — `[dev-f99c] docs: log dev-f99c + corrected WIP for Bug #2/#3 + REST_API.md audio_driver_type=0 semantics` — corrected the misleading WIP descriptions for Bug #2 (actual symptom is `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:false, exception:true`, NOT `pianoid_loaded:false`); marked Bug #3 as duplicate of Bug #2; added new deferred follow-up for the C++ struct default `circular_buffer_chunks=4` mismatch
- `d41e952` (PianoidInstall) — `[dev-f99c] chore: wrap up dev-f99c`

### Bug #1 — Listen-mode toggle (dev-eng-bug-1, dev-eng-bug-1-r — paused, COUNTER-FINDING)

- `7ba5356` (PianoidInstall) — `[dev-eng-bug-1] chore: pause Bug #1 — Phase A finding archived; rescope after Bug #2`
- TBD `[dev-eng-bug-1-r] chore: pause Bug #1 — Phase A counter-finding archived; user restarting computer`

**dev-eng-bug-1-r's Phase A counter-finding (CRITICAL — invalidates BOTH prior hypotheses):**
- Belarus + listen_to_modes=1 + use_simulation=0 → 200 OK, engine healthy, **NO CRASH**
- In-place reload Belarus listen=0 → listen=1 → 200 OK, engine healthy, **NO CRASH**
- Belarus + use_simulation=1 + listen_to_modes=**0** (control) → HTTP 500 TypeError missing `strings_in_pitches`, engine destroyed
- Belarus + use_simulation=1 + listen_to_modes=1 → SAME crash
- **Real destructive parameter is `use_simulation=1`, NOT listen-mode toggle.** The WIP author had already noted "use_simulation auto-flips 0→1 during APPLY (likely the actual trigger)" — they were correct.
- The "deck-buffer undersize" rescope hypothesis (dev-eng-bug-1's Phase A) was numerically wrong — confused `num_strings=224` (Belarus 2-strings/pitch grand piano) with `num_pitches=88`. Recomputed correctly: feedin extends to 224, sc_idx max=199 → IN BOUNDS at both Python pack and CUDA layers.

### CLAUDE.md / dev.md reorganization

- `5390b12` (PianoidInstall) — `[orchestrator-wrap-up] reorganize /dev rules — single source of truth + backend startup hierarchy`
  - Discovery: `/dev` skill source IS in this repo at `.claude/commands/dev.md` (984 LOC). Earlier doc agent missed it because they only checked `claude-config/skills/`.
  - Moved Pre-implementation Data Model Card → dev.md Step 4
  - Moved Doc-gap closure → dev.md Step 8
  - Removed "Per-Project /dev Rules" section from CLAUDE.md
  - Added new "Backend startup failure modes & workarounds" subsection to dev.md Step 1b: launcher REST API (PREFERRED) → PowerShell Start-Process (FALLBACK) → Bash run_in_background (LAST RESORT) hierarchy
- `e9f2fda` (PianoidInstall) — `[orchestrator-wrap-up] docs(CLAUDE): extend bypassPermissions rule with transitive dispatch + known gaps`
  - Made bypassPermissions rule transitive (sub-agents that spawn sub-sub-agents must also pass mode)
  - Documented known gaps (long-running-process Bash, TTY-interactive Bash, taskkill patterns)
  - Documented PowerShell Start-Process workaround for the long-running-process gap

---

## Engine bug cluster status

| Bug | Description | Status |
|---|---|---|
| Cross-mode-count /preset/switch crash | switch_preset doesn't swap mp; over-indexes deck arrays | ✅ FIXED 2026-05-01 (dev-c529) |
| /load_preset audio_driver_type=0 crashes engine | Symptom: `pianoid_loaded:true, gpu_initialized:true, audio_driver_active:false, exception:true`. Root: pack_initialization_params_for_cuda set audio_driver_type=-1 + circular_buffer_chunks=4 (struct default for ASIO) but SDL3 needs ≥16. Underrun on second in-place reload | ✅ FIXED 2026-05-01 (dev-f99c) |
| /load_preset audio_driver_type=3 missing strings_in_pitches | DUPLICATE of audio_driver_type=0 crash — state-corruption from prior failed init | ✅ COLLAPSED with Bug #2 |
| Listen-mode toggle + APPLY destroys engine on Belarus | **MISDIAGNOSED.** Real bug is `use_simulation=1` parameter (any listen mode). dev-eng-bug-1-r confirmed via measurement | ⏸ PAUSED — see decision queue below |
| Flask auto-reloader hardcoded `socketio.run(debug=True)` | Reloader restarts backend on .pyc writes | DEFERRED (in WIP) |
| `pianoid.py:1317 start_realtime_playback_unified` hardcodes `audio_enabled=True` | Loading preset with audio_on:0 still results in audio_driver_active:true | DEFERRED (in WIP) |
| C++ struct default `circular_buffer_chunks=4` wrong for SDL3 | Python helper patches symptom; struct default should be 16 OR SDL3 driver should clamp at construction time | DEFERRED (added to WIP today by dev-f99c) |

---

## Open decisions awaiting user direction (RESUME HERE)

### Bug #1 — listen-mode-toggle ticket — needs corrected diagnosis path

dev-eng-bug-1-r exposed that the listen-mode-toggle observation was a misleading correlation. Real destructive path is `use_simulation=1` crashing with `TypeError: Pianoid.__init__() missing 1 required positional argument: 'strings_in_pitches'`.

Options pending user pick (a/b/c/d, presented in Telegram message id 1696):
- **(a)** Fix the actual destructive path — `use_simulation=1` should either supply `strings_in_pitches` correctly OR be rejected with a clear HTTP 4xx if not supported for this pitches layout.
- **(b)** Audit whether `use_simulation=1` is still a supported feature — the WIP S3 deferred items already note `/load_preset` raises KeyError for several "required" fields with no defaults. Surface needs cleanup.
- **(c)** Close Bug #1 with corrected diagnosis (the listen-mode-toggle framing was misleading correlation; the real issue is the use_simulation=1 path which has its own existing tracking).
- **(d)** User had a SECOND distinct symptom in mind — share the exact UI sequence and dispatch a fresh repro.

Orchestrator's lean recommendation: **(a) + (c)** — fix the use_simulation=1 path AND close Bug #1 with corrected diagnosis.

### Modal Adapter integration — remaining waves (optional)

After B-0 + B-1 + B-3 the user-visible workflow is end-to-end usable: open Modal Adapter pane → Collect tab → pick scenario number + project_dir + recorder config → Start → output paths on done. Remaining waves (deferred per user direction "essentials only"):

- **B-2** — recorder config full schema viewer (v2 polish, optional)
- **B-4** — live preview Socket.IO + ECharts (v2 polish, optional)
- **B-5** — consolidated docs + integration tests for the full pipeline
- **Q4 ports** of remaining essential Streamlit panels: Audio Settings + Device Selector, Series Settings, Single-Pulse + Calibration Impulse — fully replaces the standalone Streamlit GUI per user direction "fully integrate into react"

### Manual hardware verification still pending

- **SDL3 migration acceptance** — synthetic IR correlation = 1.0 verified, but real hardware loopback (UMC1820 → speaker → mic → IR extraction → compare to known-good baseline) is a deferred manual gate. Worth a one-off check by user before broad rollout.
- **B-3 done-flow live UI test** — was blocked by the (now-fixed) Bug #2 reload corruption. Worth re-doing now that Bug #2 is fixed: load a preset → start measurement collection from Collect panel → watch full status transitions including done phase.

---

## Memory updates this session

New entries:
- `feedback_measurement_first_data_model_bugs.md` — for "state survives X" bugs, measure backend value before/after each transition
- `feedback_three_line_patch_smell.md` — when fix collapses to "set X on Y", check for broader principle violation
- `feedback_stand_down_stale_agents.md` — superseding an agent needs hard "STOP" + verification
- `feedback_high_stakes_inference_categories.md` — six fact categories where silent inference is forbidden

Updated:
- `feedback_orchestrator_bypass_permissions.md` — added transitive dispatch requirement + documented known gaps in bypassPermissions (long-running-process Bash, TTY-interactive, taskkill patterns) + PowerShell Start-Process workaround
- `feedback_chrome_devtools_permission_silence.md` — extended to cover Skill, Skill(*), Monitor, deferred Task*/Team* tools

---

## Stack state at pause

| Port | Process | PID | Status |
|---|---|---|---|
| 3000 | PianoidTunner React dev server (npm run dev) | 16040 | LISTENING |
| 3001 | Launcher (server/launcher.js) | 8636 | LISTENING |
| 5000 | Backend (backendserver.py) | 27632 | LISTENING |
| 5001 | Modal adapter (modal_adapter_server.py) | 18020 | LISTENING |

**To restart cleanly after computer reboot:** run `D:/repos/PianoidInstall/start-pianoid.bat` (interactive — opens new window with `cd PianoidTunner && npm run dev` which spawns launcher + frontend via concurrently). Backend + modal_adapter then started via launcher REST API: `curl -X POST http://127.0.0.1:3001/api/start-backend` and `curl -X POST http://127.0.0.1:3001/api/start-modal-adapter`.

---

## How to resume orchestrator

1. User runs `/orchestrator start` in the new session
2. Read this file at `D:/repos/PianoidInstall/docs/development/orchestrator-session-state-2026-05-01.md` first
3. The Bug #1 a/b/c/d decision is the immediate-resume action item
4. Telegram channel state should still be operational (sender 178036990 paired)

Memory file `MEMORY.md` will auto-load. Per-project rules in CLAUDE.md will auto-load. Recent commits available via `git log --oneline -30`.
