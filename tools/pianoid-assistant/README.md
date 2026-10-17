# Pianoid assistant (`@pianoid/assistant`)

The AI assistant of the Pianoid UI (proposal: `docs/proposals/ai-assistant-in-ui-2026-10-13.md`; design:
`docs/development/assistant-a4-a1-design-2026-10-15.md`). Two parts:

| Part | Phase | What |
|---|---|---|
| `mcp/server.js` | A4 | stdio MCP server: every command-registry command (`schemas/commands`) as a tool (`play.note` → `play__note`), tier annotations, `search_docs`; excluded (and opted-out) tools hidden and refused |
| `service/server.js` | A1 | the assistant service on `127.0.0.1:3002` (spawned by the launcher): Claude Code headless through the Claude Agent SDK on the user's **subscription**, in an **isolated Claude home**; the pane protocol over WS `/ws` |
| `policy.js` | A4 / A1 | the permission policy (D3 / D4), called for every tool call |
| `service/router.js` | v2 P1 | the model router (pure): pre-route, tool / failure triggers, self-escalation, stickiness |
| `analysis/` + `sandbox/` | v2 P5 | the analysis sandbox: `analysis.run_python` (in-process MCP server `analysis`), the artefact store, `export: true` on renders / reads, the AppContainer + Job Object launcher `PianoidSandbox.exe` and its SAFE escape suite |

## Setup

```
cd PianoidInstall/tools/pianoid-assistant
npm install
npm test              # zero spend: policy, MCP server, isolation, service on the fake driver
```

One-time login of the assistant's own Claude home (never `~/.claude`), PowerShell:

```powershell
$env:CLAUDE_CONFIG_DIR="$env:USERPROFILE\.pianoid-assistant\claude-home"; claude auth login --claudeai; Remove-Item Env:CLAUDE_CONFIG_DIR
```

The Assistant pane shows this command while the isolated home is not logged in, and a **Start assistant** button
while the service is down (`launcher.assistant.start`).

## Analysis sandbox (v2 P5)

The model's ONLY code path: one tool, `run_python` on the in-process MCP server `analysis`
(`mcp__analysis__run_python`, registry-style name `analysis.run_python`, approval category **`code`**). There is no
Bash / PowerShell: `tools: []`, `disallowedTools: ['Bash', 'PowerShell']`, and a PreToolUse hook that denies the
shells and any tool outside the `pianoid` / `assistant` / `analysis` servers and re-checks every analysis call
against the policy (it never allows on its own; the confirm still comes from canUseTool). The handler never
evaluates the code: it writes it to a run dir and spawns the sandbox.

| Piece | What |
|---|---|
| `sandbox/launcher/PianoidSandbox.cs` | the launcher (C#, `build.bat` with the Windows .NET 4 `csc`, no SDK, no admin; the `.exe` is not committed). AppContainer with zero capabilities (no network, incl. localhost) + Job Object (memory 2 GB, one process, kill on close, UI limits, below-normal priority). **Wall clock = the hard bound**, CPU time capped at wall / 2 (the job CPU limit fires ~2x late). **Disk watchdog**: the job's write counter (10 ms) and the run dir + container folder size (50 ms) over `--disk-mb` (200) terminate the job (measured kill at 240-270 MB for a 1.8 GB/s fill). **Container wipe**: the container's own folder (`%LOCALAPPDATA%\Packages\<profile>\AC`) and registry storage key are wiped after every run, and a run refuses to start unless both are empty. Output: `limits_hit` (`wall`, `cpu`, `memory`, `disk`, `processes`, `stdout`, `stderr`, `out_files`) |
| `analysis/runPython.js` | the tool: `{code, inputs: [artefact ids], timeout_s <= 120 (60), memory_mb <= 2048}` -> `runs\<run_id>\` (`code.py` = a service prelude with an audit hook as defence in depth, `user.py` = the model's code, `in\<id>\` copies, `out\`, `tmp\`) -> `{ok, exit, stdout (20 kB), stderr (8 kB), files: [{artifact_id, name, kind, size}], skipped, limits_hit, elapsed_s}`. The code sees `ARTIFACTS`, `artifact_path(id, name=None)`, `OUT`. Runs pruned to the newest 50 |
| `analysis/store.js` | the artefact store `%USERPROFILE%\.pianoid-assistant\analysis\artifacts\<id>\` (`meta.json` + data; ids `a-<yyyymmddhhmmss>-<hex6>`; newest 500 kept). Only the service creates artefacts; the model passes ids, never paths |
| `analysis/export.js` | `export: true` on `render.note_playback` / `render.chart` / `render.keyboard` / `param.get` / `preset.summary`: the MCP server strips the flag, runs the command, saves `audio_<i>.wav` (as the backend wrote it) + `series_<i>.npy` (raw engine units before output_scale and volume) or `result.json`, with the command, args and the live `/load_settings`, and returns `artifact: {id, files}`. R6 still holds: no render (so no export) under live audio |
| pane | a run's PNGs show in the chat ("Analysis result") and on its activity entry, served by the service at `GET /artifacts/<id>/<file>` (listed data files only); a code confirm shows the code |

**Policy:** category `code` always asks (`policy.js`); a tainted turn (web content, P7) says so in the reason and still
asks. P2's approvals keep `code` locked to Ask; Auto is decision V1 (after the escape suite, never in a tainted turn).
The first `run_python` of a turn escalates it to Opus (router layer 2); code / analysis requests pre-route to Opus.

**One-time setup (idempotent, no admin):** `node analysis/setup.js` builds the launcher if missing (`--rebuild`
forces it), creates the AppContainer profile `pianoid.analysis` and grants it ReadAndExecute on the runtime (skipped
when the ACE is already there: 1.6 s first, 16 ms after), and creates `runs\` and `artifacts\`.

**The private runtime** (`%USERPROFILE%\.pianoid-assistant\analysis\runtime`, 311 MB). An AppContainer cannot
use a venv (its `python.exe` spawns the base interpreter) nor `C:\Python312` (no ALL APPLICATION PACKAGES ACE;
granting one needs admin), so the sandbox runs a user-owned copy of the 3.12 runtime. To recreate it:

```powershell
$a = "$env:USERPROFILE\.pianoid-assistant\analysis"
New-Item -ItemType Directory -Force "$a\runtime" | Out-Null
Copy-Item -Recurse C:\Python312\DLLs, C:\Python312\Lib "$a\runtime\"         # site-packages comes from pip below
Copy-Item C:\Python312\python.exe, C:\Python312\python3*.dll, C:\Python312\vcruntime*.dll "$a\runtime\"
C:\Python312\python.exe -m venv "$a\venv"                                     # only the pip host
& "$a\venv\Scripts\python.exe" -m pip install --target "$a\runtime\Lib\site-packages" numpy scipy matplotlib soundfile
node analysis/setup.js                                                        # profile + RX grant
```

(spike versions: numpy 2.5.4, scipy 1.18.1, matplotlib 3.11.2, soundfile 0.14.0.) Delete the whole `analysis\`
folder and run `PianoidSandbox.exe cleanup --profile pianoid.analysis --revoke <runtime>` to uninstall.

**SAFE escape suite** (`sandbox/suite/run_safe_suite.py`, user-approved scope: canaries only, its own 127.0.0.1
listener, 5 spawn attempts, no credential paths): `python -I run_safe_suite.py --launcher ..\launcher\PianoidSandbox.exe
--runtime <runtime> --out results.json [--extra-canary-dir DIR]` uses its own profile `pianoid.analysis.suite` and
removes it, its ACEs, canaries and run dirs in `finally`; it prints a PASS / FAIL verdict per test. Results: spike doc
§9 (spike) and §10 (production launcher).

## Isolation (user decision D1)

- `CLAUDE_CONFIG_DIR` = `%USERPROFILE%\.pianoid-assistant\claude-home` (override the root with
  `PIANOID_ASSISTANT_HOME`); the child's `HOME` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` point inside the root;
  the `cwd` is `...\workspace` (outside every repo). The env is an allow-list: no `ANTHROPIC_*` variable reaches the
  child, and the service refuses to start if `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set (it would bill the
  paid API).
- SDK options: `tools: []` (no built-in tool: no Bash, Read, Edit, Web…), `disallowedTools: ['Bash', 'PowerShell']`,
  `settingSources: []` (no settings, no CLAUDE.md), `strictMcpConfig: true` with only the `pianoid` MCP server, the
  in-process `escalate_model` tool and the in-process `analysis` server (v2 P5), a PreToolUse re-check hook, a
  custom system prompt (`service/prompt.js`), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Per-turn context: `service/contextDigest.js` builds the `<pianoid_context>` block from `/health`,
  `/get_runtime_parameters`, `/load_settings`, `/preset/list`, `job.list` and `ui.snapshot`: audio (requested / active /
  fallback), level (clipping, limiter, gate trips, output_scale state), load settings vs the preset's declared ones, the
  mode layout and listen mode, and precomputed `warnings` (dev-0a88); since v2 P1 also the `environment`
  fingerprint (GPU, build variant, repo branch@SHA, output map) from `GET /system/environment`, re-read at most every 30 s.
- State reads (v2 P1, registry `system.json` + `preset.summary` / `preset.files` / `param.inventory` / `midi.*`):
  `system__snapshot`, `system__environment`, `system__health`, `audio__devices`, `midi__ports`,
  `midi__broadcast_state`, `preset__summary`, `preset__files`, `param__inventory` (the parameter glossary,
  `schemas/params`). Routes: REST_API.md "System state reads (assistant v2 P1)".

## Model routing (v2 P1)

The service picks the model per turn when the picker is **Auto** (a forced Sonnet / Opus wins over everything):

| Layer | When | Rule (activity entry `model route`) |
|---|---|---|
| 1 pre-route | before the turn | English + Russian keywords: bug analysis, timbre edit, physics / prediction, code / analysis, comparison, multi-step plan → Opus; else Sonnet. Context: a crashed engine (`status` crashed / exception) → Opus |
| 2 triggers | during the turn, before the call | the first `analysis.run_python` / `bug.draft` / web research (later phases); a retry of a denied or declined command; 2 consecutive tool errors |
| 3 self | the model calls `escalate_model` | unchanged |

An Opus turn (any layer) keeps Opus for the next **2** turns (sticky follow-ups do not renew it). Not yet:
"any write without a matching recipe" waits for the runbook (P3). Corpus: `test/routing-corpus.json` (the 2026-10-16
transcripts, the requirement examples, Russian), `test/router.test.js`.

## Policy

One installation = one user (D5: no user management): a collaborator runs Pianoid on their own system or in their own
directory / OS account, with their own assistant home and their own subscription login.

| | |
|---|---|
| read, ui, act (playback, renders), `search_docs` | run |
| write (`param.set`, `runtime.set`, `preset.switch`, `history.*`, …) | confirm (direct within the envelope from A2) |
| destructive (save, promote, full load, unload, calibration, modal jobs) | confirm |
| launcher process control | confirm |
| "Block measurement data" switch on | modal / calibration denied |

Confirms are answered in the pane; Stop interrupts the turn, declines pending confirms and cancels the turn's jobs.

## Standalone MCP (Claude Code / the orchestrator)

`.mcp.json` entry (Claude Code's own permission prompt confirms each tool):

```json
{
  "mcpServers": {
    "pianoid": {
      "command": "node",
      "args": ["D:/repos/PianoidInstall/tools/pianoid-assistant/mcp/server.js", "--source", "mcp"]
    }
  }
}
```

Environment: `PIANOID_BACKEND_URL` (default `http://127.0.0.1:5000`), `PIANOID_LAUNCHER_URL` (`:3001`),
`PIANOID_COMMANDS_DIR`.

## Drivers

`PIANOID_ASSISTANT_DRIVER=sdk` (default: the real subscription runtime) or `fake` (a scripted, zero-spend driver that
still runs every tool call through the policy and the real MCP server; `PIANOID_ASSISTANT_FAKE_SCRIPT` = a JSON
script).
