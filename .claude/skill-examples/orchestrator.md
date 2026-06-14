# /orchestrator — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/orchestrator`
skill body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors; this
companion holds the project-specific illustrations, organized by the body section each one illustrates.
**Project-tier — NOT hoisted machine-global.**

---

## Team name + spawn snippets (body: "Controller Agent" / "Spawning Sub-Agents")

Project team name (`PROJECT_CONFIG.md#team`): **`pianoid-dev`**.

**Create the team (orchestrator start):**
```
TeamCreate({ team_name: "pianoid-dev", description: "Pianoid development team" })
```

**Spawn a team dev agent:**
```
Agent({ team_name: "pianoid-dev", name: "dev-calibration", prompt: "...", run_in_background: true })
```
Follow-ups: `SendMessage({ to: "dev-calibration", message: "Fix this additional issue: ..." })`

**Controller spawn template (filled in):**
```javascript
Agent({
  team_name: "pianoid-dev",
  name: "controller",
  subagent_type: "general-purpose",
  run_in_background: true,
  mode: "bypassPermissions",
  description: "Compliance controller for this orchestrator session",
  prompt: `Run as the dev pipeline controller for this orchestrator session.

  Your job is to monitor /dev, /multitask, /fn, and any other dispatches for
  workflow compliance. You are read-only on project source — never use Edit
  or Write on PianoidCore, PianoidBasic, PianoidTunner, or any docs/ file.
  You may write only to your own session log at
  docs/development/logs/controller-<id>-<timestamp>.md.

  Initial actions:
    1. Generate controller ID: ctrl-$(openssl rand -hex 2)
    2. Create your session log
    3. Read docs/development/MODULE_LOCKS.md, WORK_IN_PROGRESS.md
    4. Glob docs/development/logs/dev-*.md (non-archive) to enumerate any
       pre-existing active sessions (e.g., orphaned from a prior orchestrator)
    5. Subscribe via Monitor to each pre-existing dev-agent log file (if any)
    6. Send initial pulse to team-lead — confirms boot, may report orphans

  Invariants to enforce — see docs/development/CONTROLLER.md: the Invariant
  Catalogue (per-agent, cross-agent, workflow, dev-anti-pattern axes), the
  Periodic Scans (30-min stale-agent scan + continuous Documentation-First
  sliding-window scan), and the Tier Rules (warn→escalate→halt). Signal/marker
  conventions per the Marker Conventions section.

  STAY ALIVE until orchestrator sends "session ending". Do not exit on your
  own. Wake events: SendMessage from team-lead, Monitor notifications, pulse
  timer (5 min when ≥1 dev agent alive; 15 min idle), stale-agent scan timer
  (30 min).`
})
```

**Team-lead inbox dump (before declaring a team agent stalled):**
```bash
python -c "import json,os; p=os.path.expanduser('~/.claude/teams/pianoid-dev/inboxes/team-lead.json'); print(json.load(open(p)) if os.path.exists(p) else 'no inbox file')"
```

---

## Ports (body: "Full Clearance" / "Pre-Handoff Process Hygiene" / "UI Testing Agent Crash Monitoring")

The Pianoid stack uses four ports (`PROJECT_CONFIG.md#ports`): **3000** (React frontend / PianoidTunner dev server), **3001** (Node launcher / backend manager, REST on `/api/*`), **5000** (Flask backend + CUDA engine), **5001** (modal adapter backend). The full-clearance sweep targets exactly `3000 3001 5000 5001`. (Docs preview: **8001** for MkDocs.)

---

## Canonical kill script + port sweep (body: "Use the canonical kill script")

Canonical kill script (`PROJECT_CONFIG.md#process-sweep` names the SSOT executable): the project ships
both `tools/kill_pianoid.ps1` (the full tree-kill script) and `tools/dev-pipeline/env_sweep.py` (the
port-scoped sweep + git-status helper).

**`tools/kill_pianoid.ps1`** kills the full stack correctly: the `concurrently` supervisor TREE
(`taskkill /F /T`) + port-owners (3000/3001/5000/5001) + marker-matched orphans (`backendServer.py` /
`modal_adapter_server.py` / `server/launcher.js` / `PianoidTunner` / `pianoid_middleware`). It safely
EXCLUDES the user's shell, VS Code, Claude Code, and MCP servers. Linux equivalents (fuser/pkill) are in
the script header.

```powershell
# Preview (safe — kills nothing, lists what would die):
powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1 -DryRun
# Real kill (matched trees + re-check ports + one retry pass):
powershell -ExecutionPolicy Bypass -File tools\kill_pianoid.ps1
```

**`env_sweep.py`** — port-scoped sweep (can ONLY kill PIDs found *listening* on 3000/3001/5000/5001 —
the safety invariant is encoded in code), re-verifies the four ports are free, prints per-repo
`git status --short`. Exit 0 = all clear, 2 = a port still in use.
```bash
python tools/dev-pipeline/env_sweep.py            # port-scoped kill + verify free + per-repo git status
python tools/dev-pipeline/env_sweep.py --no-kill  # inspect only (no kill)
```

**Pre-handoff stale-holder scan (`netstat`) and crash-cleanup kill loop:**
```bash
# Check port state (UI-test crash monitoring):
netstat -ano | grep -E ":(3000|3001|5000) "
# Cleanup after crash — kill only Pianoid processes (NEVER blanket-kill python.exe/node.exe):
for port in 5000 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} .*LISTENING" | awk '{print $NF}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    taskkill //F //PID "$pid" 2>/dev/null
  fi
done
```

Pre-handoff per-resource checks:
| Port / Resource | Process | Check command |
|---|---|---|
| 3000, 3001 | PianoidTunner frontend (npm/node) | `netstat -ano \| grep -E ":(3000\|3001)"` |
| 5000 | Main backend | `netstat -ano \| grep ":5000"` |
| 5001 | Modal adapter backend | `netstat -ano \| grep ":5001"` |
| 8001 | MkDocs server | `netstat -ano \| grep ":8001"` |
| `pianoidCuda.cp312-win_amd64.pyd` | Python holding the CUDA module | `tasklist //M pianoidCuda.cp312-win_amd64.pyd` |
| `cudart64_12.dll` | Process holding CUDA runtime | `tasklist //M cudart64_12.dll` |

Found a stale holder → `taskkill //F //T //PID <pid>` (the `//T` flag kills child processes too), then re-verify the port/file is free.

---

## Phase-1 verify helper (body: "What to Verify After Agent Reports")

```
python tools/dev-pipeline/verify_phase1.py <agent-id> [--repo PianoidCore | --scan-repos]
```
Prints PASS/FAIL per check (exit 0 = clean Phase-1 handoff, 2 = any fail). Pure read-only. See `tools/dev-pipeline/README.md`.

---

## Build holders (body: "Pre-Handoff Process Hygiene" / "Rebuild Default")

Native binaries that block a rebuild when held open (`PROJECT_CONFIG.md#build-holders`):
| Holder | Find holders (Windows) | Find holders (Linux) |
|---|---|---|
| `pianoidCuda.cp312-win_amd64.pyd` (release) / `pianoidCuda_debug.cp312-win_amd64.pyd` (debug) | `tasklist //M pianoidCuda.cp312-win_amd64.pyd` | `lsof PianoidCore/.venv/lib/python3.12/site-packages/pianoidCuda*.so` |
| `cudart64_12.dll` (CUDA runtime) | `tasklist //M cudart64_12.dll` | — |

Stop the holder FIRST via the launcher REST `POST /api/stop-backend` (else a PID-targeted kill — never `//IM python.exe`).

---

## Launcher REST start/stop workarounds (body: Core-Principle (a) / "Rebuild Default" / "Stalled Agent Recovery")

Launcher REST endpoints (`PROJECT_CONFIG.md#rest-endpoints`), on port **3001**:
- `POST http://127.0.0.1:3001/api/start-backend` — launcher spawns the Flask backend (no harness gate — preferred startup; routes AROUND the long-running-starter CLI-permission stall).
- `POST http://127.0.0.1:3001/api/stop-backend` — graceful shutdown + force kill; use BEFORE a `--heavy` build to release the `.pyd` holder.
- `POST http://127.0.0.1:3001/api/kill-stale` — kill anything on port 5000.

Post-rebuild smoke-test (`PROJECT_CONFIG.md#rest-endpoints`): `POST http://127.0.0.1:5000/load_preset` → expect **200**, no traceback (the API-divergence check that import-verify misses).

---

## Canonical rebuild — `--both` (body: "Rebuild Default — full-variant" / Phase-2 rebuild gate)

Canonical build (`PROJECT_CONFIG.md#docs-first-build--run` · `#rebuild-matrix`):
```
cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both
```
- In agent context use the **detached `Start-Process -WindowStyle Hidden`** form with the **absolute** bat path (a bare bat name after `cd /d` fails *"not recognized"*); NEVER `cmd //c … --heavy` (gate-stalls DESTRUCTIVELY → removes the `.pyd` before reinstall → bricks the venv).
- **Stop the `.pyd` holder first** via launcher REST `POST /api/stop-backend` (a running backend → `[WinError 5]` on the `--heavy` uninstall).
- Always `--both` (release + debug); release-only leaves the debug `.pyd` silently stale → runtime symbol error.
- **Verify-landed:** `grep -a "<marker>" PianoidCore/.venv/Lib/site-packages/pianoidCuda.cp312-win_amd64.pyd`.
- On build/server failure → invoke `/startup`.

PianoidBasic-only change → `PianoidCore/build_pianoid_basic.bat` (+ HEAVY CUDA if a `.cu/.cpp` also changed).

---

## 4-repo reconcile (body: "Phase 2 sequence" / "Full Clearance")

The project's repos + integration branches (`PROJECT_CONFIG.md#repos`):
| Repo | Repo-relative path | Integration branch |
|------|--------------------|--------------------|
| PianoidInstall (root: docs, skills, config) | `.` | `master` |
| PianoidCore (Flask + CUDA engine) | `PianoidCore` | `dev` |
| PianoidBasic (domain model) | `PianoidBasic` | `dev` |
| PianoidTunner (React frontend) | `PianoidTunner` | `dev` |

Note the root PianoidInstall integration branch is **`master`**; the three sub-repos use **`dev`**.

**Per-repo `git status` health check (Step 1.5):**
```bash
echo "=== PianoidCore ===" && cd PianoidCore && git status --short
echo "=== PianoidTunner ===" && cd PianoidTunner && git status --short
echo "=== PianoidBasic ===" && cd PianoidBasic && git status --short
echo "=== PianoidInstall ===" && cd . && git status --short
```

**Phase-2 reconcile** pulls `origin/dev` (merge-mode, not FF-only) on each sub-repo; root docs go on `master`. Phase-2 cleanup commit lands on PianoidInstall `master`: `[orchestrator] chore: Phase 2 cleanup for dev-XXXX (agent returned earlier)`.

**Post-merge/pull rebuild gate (BLOCKING):** if the pulled diff touches `.cu/.cpp/.cuh/.h/setup.py/detect_paths.py` or any `PianoidBasic/**`, REBUILD `--both` and run the `/load_preset` **200** smoke-test BEFORE push.

---

## Channel — Telegram / voice STT+TTS / CLI control (body: Step 1, Step 3, File Exchange)

Channel facts (`PROJECT_CONFIG.md#channel`):

| Item | Value |
|---|---|
| Primary channel | Telegram (`mcp__plugin_telegram_telegram__*`) — inbox queue under `~/.claude/channels/telegram/inbox/` |
| Inbox patch | `python tools/apply_telegram_patch.py` (file-queue; the plugin drops inbound msgs without it) |
| Voice in (STT) | `PianoidCore/.venv/Scripts/python tools/transcribe_voice.py <audio>` (faster-whisper) |
| Voice out (TTS) | `py -3 tools/tts_voice.py "<text>"` (edge-tts → `.ogg`); voice patch `python tools/apply_telegram_voice_patch.py` |
| CLI keystroke control | `tools/cli_control.ps1` (drives the orchestrator's own VS Code/CLI window; transcripts under `~/.claude/projects/D--repos-PianoidInstall/`) |

**Telegram MCP tools (body refers to "the channel reply tool"):**
- Reply / send file: `mcp__plugin_telegram_telegram__reply(chat_id=<id>, files=[...])`
- Download attachment: `mcp__plugin_telegram_telegram__download_attachment(file_id=<attachment_file_id>)`

**Inbox queue processing — archive immediately:**
```bash
mkdir -p ~/.claude/channels/telegram/inbox/archive
mv ~/.claude/channels/telegram/inbox/<filename> ~/.claude/channels/telegram/inbox/archive/
```
Stale-archive cleanup (>7 days):
```bash
mkdir -p ~/.claude/channels/telegram/inbox/archive
find ~/.claude/channels/telegram/inbox/archive/ -type f -mtime +7 -delete 2>/dev/null
```

**Plugin dependency check / install (Telegram disconnected):**
```bash
ls ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4/node_modules/ 2>/dev/null | head -3
cd ~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.4 && bun install
```
Zombie-bun check: `tasklist | grep -i bun` → if >2, `taskkill /F /IM bun.exe`.

**Voice IN (STT) — transcribe a downloaded `.oga`/`.ogg`** (run from the **repo root** — the script lives in repo-root `tools/`, not under `PianoidCore/`):
```bash
PianoidCore/.venv/Scripts/python.exe tools/transcribe_voice.py "<archived_path>"
```
(Linux: `PianoidCore/.venv/bin/python`.) The `small` model (~500MB) downloads on first use; pre-download with `--preload`.

**Voice OUT (TTS) — reply with a voice note** (prints the absolute `.ogg` path as the LAST stdout line):
```bash
py -3 tools/tts_voice.py "Your spoken message here"
```
Then `mcp__plugin_telegram_telegram__reply(chat_id=<id>, files=["<printed .ogg path>"])` — the `server.ts` voice patch routes `.ogg`/`.oga`/`.opus` through `sendVoice`. Dual-output: also send the same content as text.

**Voice-patch durability (marketplace copy, not the volatile cache):**
```bash
python tools/apply_telegram_voice_patch.py --check   # report state
python tools/apply_telegram_voice_patch.py           # apply/re-apply (idempotent, marker-guarded, backs up server.ts.bak), then reload
```
Full STT+TTS setup + re-apply procedure: `docs/guides/TELEGRAM_CHANNEL_SETUP.md` § Voice I/O Setup.

---

## Doc-context reads (body: Step 1.7 "Load Project Context")

Pianoid doc-hierarchy entry points (`PROJECT_CONFIG.md#doc-hierarchy`), read top-down before source:
1. `docs/index.md` — module map, what each layer does, where things live
2. `docs/architecture/SYSTEM_OVERVIEW.md` — 4-layer stack (CUDA engine, domain model, middleware, frontend), dual backend servers (port 5000 main, port 5001 modal adapter), threading model
3. `docs/development/CODE_QUALITY.md` — quality principles all code changes follow
4. `docs/development/WORK_IN_PROGRESS.md` — active investigations and planned work

---

## UI-interaction skill + classification (body: "Task Classification" / per-dispatch notification)

The project's UI-interaction skill (the live-UI / parameter-edit / play-notes / capture-sound skill) is
**`/pianoid-ui`** — dispatch it for "adjust params, play notes, capture sound, browser work" requests.
The `/diagnose` skill is the mic-engaging (`audio_on`) verification path; `/test-ui` is the synthesis-output
(`audio_off`) path (`PROJECT_CONFIG.md#verification-surfaces`). Both `/pianoid-ui` and `/test-ui` are still
preceded by the per-dispatch controller `SendMessage`.

---

## Stalled-agent marker examples (body: "Stalled Agent Recovery")

The dominant Pianoid long-running-starter that stalls on the invisible CLI-permission prompt is
`cmd //c start-pianoid.bat` (and `npm run dev`). A controller stale-scan candidate looks like:
```
Stalled candidates:
  - dev-md01: last entry [BASH-CALL] 2026-05-05T12:30:22Z 'cmd //c start-pianoid.bat' (52 min ago)
              Type: unmatched BASH-CALL — Tier-2 likely permission stall (suspicion: high)
              Recommended: check CLI for pending prompt; if visible, approve. Else kill+respawn.
```
Mitigation: switch the starter to `PowerShell Start-Process -WindowStyle Hidden -RedirectStandardOutput ...`,
or for the backend prefer the launcher REST `POST http://127.0.0.1:3001/api/start-backend`.
