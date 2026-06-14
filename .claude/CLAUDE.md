# Pianoid Project Instructions

<!-- The generic agentic-development methodology now lives MACHINE-GLOBAL at ~/.claude/CLAUDE.md
     (applies to every project on this machine; distributed via ~/claude-config + /self-update).
     The rules below are PIANOID-SPECIFIC and OVERRIDE any conflicting generic default from the
     machine-global core. Operational facts live in docs/PROJECT_CONFIG.md — referenced by anchor,
     never re-inlined. -->

## Project-specific rules (Pianoid) — these OVERRIDE conflicting generic (machine-global ~/.claude/CLAUDE.md) defaults

### Orchestrator sub-agent permission allow-list (Pianoid specifics)
The orchestrator's agent-team name is `pianoid-dev` ([`PROJECT_CONFIG.md#team`](../docs/PROJECT_CONFIG.md#team)).
Team sub-agents are governed by `.claude/settings.local.json` `permissions.allow`, NOT by the spawn's
bypass mode — it MUST blanket-allow BOTH shells (`Bash(*)` AND `PowerShell(*)`) + the core tools
(`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `Skill`, `SendMessage`, `Monitor`, `ToolSearch`, the
`Task*` tools, MCP servers). The orchestrator verifies + repairs this at startup. The generic
permission-suppression rule + the cross-cutting failure-mode catalogue are in the machine-global
generic core (`~/.claude/CLAUDE.md` → "Sub-agent permission rule + known gaps"); the Pianoid-flavored
known gaps (the `cmd //c start-pianoid.bat` long-running-starter, the launcher REST `:3001/api/start-backend`
workaround, `taskkill //F //PID` on system PIDs) are detailed in
[`docs/guides/STARTUP_TROUBLESHOOTING.md`](../docs/guides/STARTUP_TROUBLESHOOTING.md) and `PROJECT_CONFIG.md`
(`#ports` `#build-holders` `#process-sweep`).

### Compiled-language / build
Compiled file types that MUST go through `/dev`: `.cu`, `.cpp`, `.cuh`, `.h`, `setup.py` (CUDA/C++ —
they need the CUDA build). Canonical build + the docs-first build/run discipline:
[`docs/PROJECT_CONFIG.md#docs-first-build--run`](../docs/PROJECT_CONFIG.md#docs-first-build--run).
On build/startup failure → invoke `/startup`. venv + holders + ports + smoke-test:
`PROJECT_CONFIG.md` ([`#interpreters`](../docs/PROJECT_CONFIG.md#interpreters)
[`#build-holders`](../docs/PROJECT_CONFIG.md#build-holders) [`#ports`](../docs/PROJECT_CONFIG.md#ports)
[`#rest-endpoints`](../docs/PROJECT_CONFIG.md#rest-endpoints)).

### Repository roots & paths
Repo roots (per-OS), branches, and the path table:
[`PROJECT_CONFIG.md#repos`](../docs/PROJECT_CONFIG.md#repos) +
[`#key-paths`](../docs/PROJECT_CONFIG.md#key-paths) +
[`#interpreters`](../docs/PROJECT_CONFIG.md#interpreters). Use repo-relative paths.

### UI interaction
Frontend interaction (view/edit params, play notes, capture sound, browser work) → invoke `/pianoid-ui`
unless told otherwise.

### Backend startup
When the backend must start and the process/preset/params are unclear, consult the docs first
(`docs/guides/UI_TESTING.md`, `docs/guides/STARTUP_TROUBLESHOOTING.md`,
`docs/modules/pianoid-middleware/REST_API.md`). Default preset + init params:
[`PROJECT_CONFIG.md#defaults`](../docs/PROJECT_CONFIG.md#defaults) +
[`#rest-endpoints`](../docs/PROJECT_CONFIG.md#rest-endpoints).

### Audio / verification routing
Synthesis-output change → `/test-ui` (audio_off); mic-engaging change → `/diagnose` (audio_on). Surfaces:
[`PROJECT_CONFIG.md#verification-surfaces`](../docs/PROJECT_CONFIG.md#verification-surfaces). Canonical
live-UI procedure: `docs/guides/UI_TESTING.md`.

### Startup & build failure
On launcher/`npm run dev`/backend-crash/port-conflict/build-failure/driver-error → invoke `/startup`
(the authoritative install/build/startup reference).

### Documentation-First data-model facts (Pianoid specifics)
The high-stakes inference categories for this engine:
[`PROJECT_CONFIG.md#data-model-facts`](../docs/PROJECT_CONFIG.md#data-model-facts). Doc lookup order:
[`#doc-hierarchy`](../docs/PROJECT_CONFIG.md#doc-hierarchy).

### Documentation links
MkDocs served at the URL in [`PROJECT_CONFIG.md#key-paths`](../docs/PROJECT_CONFIG.md#key-paths)
(`http://localhost:8001/`); build URLs from `mkdocs.yml` nav. Anchor fragments = heading text lowercased
with hyphens.

### Frontend UI standards
React 18 + MUI v6 + ECharts + react-mosaic, dark theme, NumInput, context7-before-MUI-API:
[`PROJECT_CONFIG.md#frontend-stack`](../docs/PROJECT_CONFIG.md#frontend-stack).

### Key paths · team · channel
[`PROJECT_CONFIG.md#key-paths`](../docs/PROJECT_CONFIG.md#key-paths) ·
[`#team`](../docs/PROJECT_CONFIG.md#team) · [`#channel`](../docs/PROJECT_CONFIG.md#channel).
