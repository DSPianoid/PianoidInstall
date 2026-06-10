# Orchestrator Context Handoff — 2026-05-27

Brief for the next orchestrator session that resumes with **Google chrome-devtools MCP attached**. The user will use the chrome-devtools MCP to drive the browser directly for live UI verification of the remaining no-sound bug.

## Active blocker — TOP PRIORITY

**ASIO no-sound regression on UMC 1820.** Despite the `dev-asiocrash-b20f` ASIO fix shipping clean (pianoidCuda.pyd rebuilt 2026-05-27 13:31 with `pythoncom.CoInitializeEx(COINIT_APARTMENTTHREADED)` in `run_online` worker thread + PLOG hygiene + launcher stdout-to-file), the user reports "No sound" after restarting the stack cleanly. Backend `/health` returns `pianoid_loaded:true, audio_driver_active:true, exception:false, backend_thread_running:true, 88 notes`. The fix verified internally (1st/2nd/3rd `/load_preset adt=4` survived; mic SNR 24×/7.3×/10.4× at expected fundamentals; arpeggio cue played at 13:37Z). But user's actual ear-test fails.

**In-flight diagnostic agent** at orchestrator session end: `a5c49dd2e46827954` (`diag-stillnosound-XXXX`, max reasoning). Output JSONL at `C:\Users\astri\AppData\Local\Temp\claude\D--repos-PianoidInstall\09436c05-668a-4e9e-b8ab-5c6f1bc3acf6\tasks\a5c49dd2e46827954.output` — DON'T tail it (overflows context). Status will not survive Claude Code restart; new session should re-diagnose using the chrome-devtools MCP for live UI driving.

## What the next session should do

1. **Read this handoff doc end-to-end** before doing anything else.
2. **Run Step 1.5 repo health check** per orchestrator skill (`docs/development/WORK_IN_PROGRESS.md` + `docs/development/MODULE_LOCKS.md` + git status across 3 repos).
3. **With chrome-devtools MCP attached: actually drive the UI** to reproduce the user's no-sound experience. The prior diagnostics were all backend-side (mic capture, offline render, REST probes). The user is clicking notes via the **frontend UI** — possibly via a different code path (WebSocket, optimistic-UI, debounce) than the REST endpoints the diagnostics exercised.
4. **Classification questions to answer in the browser:**
   - Which preset is actually loaded (the frontend's preset selector vs the backend's loaded preset — do they match?)
   - When user clicks a note on the keyboard UI, what HTTP/WS call goes out (devtools Network tab)?
   - What's the audio_driver_type the frontend sent on APPLY (devtools Network → request body)?
   - Does the offline render endpoint (`POST /get_chart_test note_playback`) produce non-zero `max_amp` with the user's currently-loaded preset (NOT BaselinePreset1.json which all prior diagnostics used)?
   - If user APPLIES BaselinePreset1.json explicitly with adt=4, does sound come?

## Branch + commit state at handoff

**ALL UNMERGED** — awaiting user verification of the no-sound fix before Phase 2 wrap-up.

| Repo | Branch | HEAD | Note |
|---|---|---|---|
| PianoidCore | `feature/dev-asiocrash-b20f` | `5d297a6` | `[dev-asiocrash-b20f] fix: CoInitializeEx in run_online thread + ASIO PLOG hygiene` |
| PianoidTunner | `feature/dev-asiocrash-b20f` | `735d523` | `[dev-asiocrash-b20f] chore: launcher captures backend stdout to PianoidCore/logs/` |
| PianoidInstall | `master` | `f9e2140` | `[dev-asiocrash-b20f] docs: ASIO COM apartment requirement + diagnostic + Phase 1 wrap` |

dev-asiocrash-b20f Phase 1 lock RELEASED, WIP entry still ACTIVE (Phase 2 awaiting user approval).

If next session **fixes the no-sound** and user confirms audible: merge sweep both feature branches → dev on PianoidCore + PianoidTunner, push all 3 repos, archive log, clean WIP.

## Stack state at handoff

- Ports: 3000 (frontend), 3001 (launcher), 5000 (backend) — all LISTENING per last orchestrator check, restart-fresh by orchestrator at ~13:37Z via `start-pianoid.bat`
- 5001 (modal_adapter) NOT running — expected (user is on main synthesis path, not modal adapter)
- Backend healthy per `/health`
- `pianoidCuda.pyd` is the fresh build (May 27 13:31)

## Earlier diagnostic findings (don't redo)

- **SDL3** hard-codes `SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK` at `SDL3AudioDriver.cpp:82`. Windows default playback is MME "OUT 01-10 (BEHRINGER UMC 1820)" (10-channel aggregated). SDL3 stereo→10ch remap lands on wrong physical pair, not OUT 1-2. **User MUST use ASIO (driver type 4)** for deterministic UMC OUT 1-2 routing.
- **2nd `/load_preset` adt=4 crash** (the bug dev-asiocrash-b20f fixed): COM apartment context missing on Flask request worker thread. Symptom was `Pianoid constructor completes` → `engine.run() never reaches "Starting playback"` → backend `exception:true` within seconds.
- **9.7e9 main_volume warning is a RED HERRING.** `synthesis_peak * volume_coefficient` saturates Sint32 max only at 5% over — not gross clipping. The `measurement_engine.py:361` log labels it "main_volume" but it's actually the volume_coefficient that correctly scales float [-1,1] into Sint32 range (max 2.147e9). Don't waste time chasing this.
- **`UMC ASIO Driver`** is sounddevice id 51 (18in/20out), pinned in `D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\asio_driver_cache.txt`.
- **ASIO init log**: ASIOAudioDriver.cpp now uses PLOG (post-fix). Backend stdout captured at `PianoidCore/logs/backend_stdout.log` (post-fix). Pre-fix the launcher wasn't piping stdout.

## Other in-flight follow-ups (queued, not blocking)

1. **`/play_keyboard mode=offline` silence bug** — same engine returns peak 3.30e-11 via this endpoint vs peak 26213 via `/get_chart_test note_playback`. Both call `Pianoid::runOfflinePlayback`. Real bug in export endpoint, NOT what caused user's silence. Reproducer:
   ```bash
   curl -X POST localhost:5000/play_keyboard -H "Content-Type: application/json" \
     -d '{"mode":"offline","pitches":[60],"velocity":127,"speed_ms_per_note":700}'
   ```
2. **Dialog consolidation roadmap Wave 2** (proposal `8b3b475`, `docs/proposals/modal-adapter-dialog-review-2026-05-26.md` §6.2/6.3):
   - Generalize `useModalMassRun` → `useAsyncOperation` (~8 h)
   - Migrate `ImportScenariosDialog` create-new path to async (~8 h, backend+frontend)
   - Extract `<ConfirmDestructiveDialog>` + `<RenameDialog>` shared components (~11 h)
   - File splits to drop 2 files out of RED (~9 h)
3. **`useProjectCRUD` orphan hooks cleanup** — per dev-dlgrm-4b1a audit, `fetchEffectiveSignalLength` is fully orphaned (safe S-effort delete), `copyProject` + `importProject` + `reaverageProject` need their dedicated tests cleaned. Total ~550 LOC.
4. **Modal mass NaN follow-ups**:
   - MDOF cluster cap tuning (proposal `34efc44` flagged 596/757 chains hit `low_density_unresolved`) — needs measurement-backed tuning
   - SDOF path is 0/30 success on LG_p3 — essentially dead-branch on this dataset

## Memory references the next session should consult

Auto-memory in `C:\Users\astri\.claude\projects\D--repos-PianoidInstall\memory\`:

- `feedback_chrome_devtools_permission_silence.md` — CRITICAL for next session: pre-allow `Skill`, `Skill(*)`, `Monitor`, ALL `mcp__` namespaces, and deferred `Task*`/`Team*` tools before agent dispatch; chrome-devtools alone is not enough (/dev invokes /test-ui via Skill which prompts separately)
- `feedback_telegram_replies.md` — all user-facing output via Telegram
- `feedback_self_service.md` — never ask user to restart servers; kill+start yourself
- `feedback_pre_handoff_process_hygiene.md` — before "ready to test" handoff, orchestrator kills stale processes
- `feedback_measurement_first_data_model_bugs.md` — measure backend state before/after each transition; never diagnose from source-code reading alone
- `feedback_behavioral_rules_in_skills.md` — behavioral rules go in .claude/commands/*.md, NOT in auto-memory

## Skill updates shipped this session (2026-05-26 → 2026-05-27)

- `.claude/commands/orchestrator.md` — added `### Merge Sweep Before Live Test (BLOCKING)` (commit `7d379ff`) + `### Parallel /dev Agents on Same Repo MUST Use Dedicated Worktrees (BLOCKING)` (commit `2b231d2`) subsections. Read these before doing parallel dispatch.

## How user prefers to work (observed)

- Terse messages. Direct.
- Strict about "ALL user output via Telegram" rule.
- Wants orchestrator to ACT, not ASK. ("Act according to your skill" / "use all tools you have")
- Wants persistent fixes, not just runtime workarounds.
- Will give A/B/C/D menu picks for choices; volunteers preferences when prompted.
- Strong opinion: behavioral rules → skill files, NOT auto-memory.
- Watching the IDE — keeps opening `utilities.py` during ASIO investigation (was a hint about where calibration_controller lives).

## Saved at

2026-05-27 ~13:50Z, mid-flight in diag-stillnosound-XXXX. User explicitly requested context save before restarting with chrome-devtools MCP.
