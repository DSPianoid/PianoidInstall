# Session Handoff — 2026-05-19

Orchestrator session handoff, written before a VS Code reload (to activate the Telegram voice-message plugin patch). The reload restarts the orchestrator session — restart it with `/orchestrator start`, then read this file.

## IMMEDIATELY AFTER RESTART
1. The Telegram plugin was patched for outbound **voice notes**. Test it: send a TEXT reply first (confirm the Telegram lifeline is alive), then generate speech and send the `.ogg`.
   - TTS helper: `py -3 C:\Users\astri\.claude\tools\tts_voice.py "text"` → prints an `.ogg` path → send via `reply(files:[...])`.
2. **STT already works** (no reload needed): transcribe inbound voice with
   `PianoidCore\.venv\Scripts\python.exe tools\transcribe_voice.py "<abs-path.ogg>"` (run from repo root). The orchestrator skill's Voice Message Detection flow already calls this.

## SHIPPED THIS SESSION — all on origin
- **Length→dx regression fix** — PianoidCore origin/dev. `GET /get_parameter/string` returns `length` in metres (was the FDTD block count). Live-verified.
- **Preset working-copy model** — PianoidCore + PianoidTunner origin/dev. Edit-isolation bug fixed; read-only originals; spawn/promote; global volume/feedback. 13/13 system tests. Live UI verification was user-deferred (user said they'd do it).
- **PianoidInstall master** — reconciled with origin; all proposals committed + pushed. HEAD `4eb7e60`.
- **Pianoid.cu split proposal** — written, then revised per the user's module-substance criterion (`868228d`): 6 substantive modules + relocation of ~10 audio wrappers into the audio-driver subsystem. `docs/proposals/pianoid-cu-split-proposal-2026-05-19.md`.
- **Courant-stability guard proposal** — `docs/proposals/courant-stability-guard.md`.

## VOICE CAPABILITY (set up this session)
- **STT (inbound):** `faster-whisper` revived in PianoidCore/.venv, pinned in `tools/requirements-orchestrator.txt`. `tools/transcribe_voice.py` + orchestrator voice flow intact. Works now.
- **TTS (outbound):** edge-tts + ffmpeg installed; helper `C:\Users\astri\.claude\tools\tts_voice.py`. Telegram plugin `server.ts` patched (`.ogg`→`sendVoice`). Backup `server.ts.bak`; re-appliable diff `server.ts.voicepatch.diff`. ACTIVATES on this reload. NOTE: the patch is in the plugin cache dir — wiped on a plugin update; re-apply the diff.

## PENDING USER DECISION
- **Doc patch** — `docs/guides/UI_TESTING.md` + `STARTUP_TROUBLESHOOTING.md` still tell agents to start the stack via `Bash run_in_background` (the pattern that stalled 3 agents this session). Fix detailed in `D:\tmp\live-verification-research-findings.md`. User has not approved applying it.

## BACKLOG
- Courant-stability guard — proposal ready → future CUDA `/dev` task.
- Pianoid.cu god-object split — revised proposal ready → future CUDA `/dev` task.
- MIDI Sequence B (Phases 5–7) — `docs/proposals/midi-implementation-plan.md`.
- Phase 4 file-size refactoring — `pianoid.py` (~3177 LOC RED), `chartFunctions.py`, `ModalAdapter`, `usePreset.js`, `NumInput.js`.
- Parked-set decision; undecided proposals: `modal-mass-q-factor-measurement-techniques`, `modal-adapter-measurement-entity`, `midi-system-refactoring-plan-revised`, `openai-gate`, `fpga-preset-excitation-loader`.
- Personal threads (paused): studio rent calc, MIDI controller board purchase, job application + CV, personal WhatsApp re-pair.

## REFERENCE ARTIFACTS (D:\tmp\)
- `voice-tts-investigation-2026-05-19.md`, `tts-setup-result-2026-05-19.md` — TTS setup.
- `stt-history-investigation-2026-05-19.md`, `whisper-revive-result-2026-05-19.md` — STT.
- `live-verification-research-findings.md` — the doc-patch detail.
- `pianoid-cu-split-revision-2026-05-19.md` — proposal-revision reasoning.
- `controller-session-summary-2026-05-19.md` — controller's final summary + controller-role.md revision candidates (if written before the reload).
