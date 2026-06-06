---
name: update-pianoid
description: Update all Pianoid repos (PianoidInstall, PianoidCore, PianoidBasic, PianoidTunner) — fetch, rebuild, sync project skills.
user-invocable: true
argument-hint: [--force|-f] [--force-heavy|-h]
---

# Update Pianoid Packages

Update PianoidInstall (docs, skills, config), PianoidCore, PianoidBasic, and PianoidTunner by fetching latest changes from git and rebuilding as needed.

## Docs-first (MANDATORY) before any rebuild

This skill triggers rebuilds on fetched changes. A broken rebuild leaves a silently-stale `.pyd` that breaks every later action. 2026-04-23 lost ~3h to this exact trap.

- **Before triggering CUDA rebuild** — read `docs/architecture/BUILD_SYSTEM.md` + `docs/guides/QUICK_START.md` + `docs/guides/STARTUP_TROUBLESHOOTING.md`.
- **Canonical rebuild — DEFAULT IS `--both`** — `build_pianoid_cuda.bat --heavy --both` (or `--light --both` for Python-only). The `--both` flag builds release **then** debug; the project's testing + profiling workflows require BOTH variants to be current. Use `--release` ONLY when the caller explicitly says "release only" — leaving the debug `.pyd` stale silently breaks every later debug-variant import (per `feedback_debug_variant_dll_trap.md`). Do NOT fall back to `pip install --force-reinstall --no-cache-dir pianoid_cuda/` — silently reinstalls the STALE `.pyd`.
- **Debug variant trap** — `PIANOID_BUILD_VARIANT=debug` alone skips the DLL copy step; the canonical `--both` invocation handles the release→debug order + DLL copy correctly. Never invoke `--debug` standalone.
- **Pre-rebuild hygiene** — `tasklist //M pianoidCuda.cp312-win_amd64.pyd` to find stale holders; kill by PID. A locked `.pyd` causes `[WinError 5] Access is denied` and leaves the package uninstalled.
- **Verify the rebuild landed** — after each rebuild: `PianoidCore/.venv/Scripts/python -c "import pianoidCuda; print(pianoidCuda.__file__)"`. Path must be under `PianoidCore/.venv/`, not root `.venv/`.
- **On rebuild failure** — invoke `/startup` rather than retry blindly.

## Arguments

| Flag | Description |
|------|-------------|
| `--force` or `-f` | Discard local uncommitted changes and proceed |
| `--force-heavy` or `-h` | Force heavy CUDA rebuild regardless of changes |

## Repository Locations

- **PianoidInstall**: `.` (branch: `master` — docs, project skills, config)
- **PianoidCore**: `PianoidCore` (branch: `dev`)
- **PianoidBasic**: `PianoidBasic` (branch: `dev`)
- **PianoidTunner**: `PianoidTunner` (branch: `dev`, React/Node.js frontend)

## Workflow

### 1. Check Local Changes

For all repos, run:
```bash
git -C "." status --porcelain | grep -v "^??"
git -C "PianoidCore" status --porcelain
git -C "PianoidBasic" status --porcelain
git -C "PianoidTunner" status --porcelain
```

Note: PianoidInstall ignores untracked files (`??`) since nested repos appear as untracked — only modified tracked files block the update.

- If uncommitted changes exist and NO `--force` flag: **ABORT** with warning listing changed files
- If `--force` flag provided: discard changes with `git checkout .`

### 2. Fetch and Check for Updates

```bash
git -C "." fetch origin
git -C "PianoidCore" fetch origin
git -C "PianoidBasic" fetch origin
git -C "PianoidTunner" fetch origin
```

**Verify fetch is complete** — for each repo, confirm local `origin/<branch>` matches the remote:
```bash
git -C "." rev-parse origin/master
git -C "PianoidCore" rev-parse origin/dev
git -C "PianoidBasic" rev-parse origin/dev
git -C "PianoidTunner" rev-parse origin/dev
git -C "." ls-remote origin master | cut -f1
git -C "PianoidCore" ls-remote origin dev | cut -f1
git -C "PianoidBasic" ls-remote origin dev | cut -f1
git -C "PianoidTunner" ls-remote origin dev | cut -f1
```
If any local `rev-parse` does not match `ls-remote`, run `git fetch origin` again for that repo.

Show pending commits:
```bash
git -C "." log HEAD..origin/master --oneline
git -C "PianoidCore" log HEAD..origin/dev --oneline
git -C "PianoidBasic" log HEAD..origin/dev --oneline
git -C "PianoidTunner" log HEAD..origin/dev --oneline
```

If no updates in any repo: report "Already up to date" and exit.

### 3. Analyze Changes for Smart Rebuild

Get changed files:
```bash
git -C "." diff HEAD..origin/master --name-only
git -C "PianoidCore" diff HEAD..origin/dev --name-only
git -C "PianoidBasic" diff HEAD..origin/dev --name-only
git -C "PianoidTunner" diff HEAD..origin/dev --name-only
```

**Rebuild Decision Matrix:**

| Changed Files | Action |
|--------------|--------|
| Any files in PianoidBasic | Rebuild PianoidBasic |
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh` | Heavy CUDA rebuild (dual: release + debug) |
| `pianoid_cuda/setup.py` | Heavy CUDA rebuild (dual: release + debug) |
| `detect_paths.py`, `build_config.json` | Heavy CUDA rebuild (dual: release + debug) |
| `pianoid_middleware/*.py` only | Light CUDA rebuild (dual: release + debug) |
| `docs/**`, `*.md` files only | Skip CUDA rebuild, update documentation |
| `--force-heavy` flag | Heavy CUDA rebuild |
| `package.json` or `package-lock.json` in PianoidTunner | Run `npm install` (see Step 4d) |
| Any files in PianoidTunner (no dependency changes) | Skip npm install (no build step needed) |
| MCP servers missing from `~/.claude.json` | Install via Step 4b |
| Node.js < 20.19.0 | Upgrade via Step 4c |

### 4. Pull Updates

```bash
git -C "." pull origin master
git -C "PianoidCore" pull origin dev
git -C "PianoidBasic" pull origin dev
git -C "PianoidTunner" pull origin dev
```

### 4a. Install Project-Level Skills and Settings

After pulling PianoidInstall, project-level skills and settings in `.claude/` are automatically updated via git. Report any new or changed files:

```bash
git -C "." diff HEAD@{1}..HEAD --name-only -- .claude/
```

If any `.claude/commands/*.md` files changed, list them in the report.
If `.claude/settings.json` changed, note that Claude Code permissions were updated (takes effect on next session or VS Code reload).

### 4b. Check and Install Required MCP Servers

The following MCP servers are required for Pianoid development. Check `~/.claude.json` and install any that are missing.

**Required servers:**

| Server | Package | Purpose |
|--------|---------|---------|
| `chrome-devtools` | `chrome-devtools-mcp@latest` | Browser automation for `/pianoid-ui` skill |
| `context7` | `@upstash/context7-mcp@latest` | Up-to-date library documentation lookup |

**Check and install:**

```bash
# Read current config
python -c "
import json, sys
with open('C:/Users/astri/.claude.json') as f:
    cfg = json.load(f)
servers = cfg.get('mcpServers', {})
missing = []
required = {
    'chrome-devtools': {'command': 'npx', 'args': ['-y', 'chrome-devtools-mcp@latest']},
    'context7': {'command': 'npx', 'args': ['-y', '@upstash/context7-mcp@latest']},
}
for name, spec in required.items():
    if name not in servers:
        missing.append(name)
        servers[name] = spec
        print(f'INSTALLING: {name}')
    else:
        print(f'OK: {name}')
if missing:
    cfg['mcpServers'] = servers
    with open('C:/Users/astri/.claude.json', 'w') as f:
        json.dump(cfg, f, indent=2)
    print(f'Added {len(missing)} MCP server(s). Reload VS Code to activate.')
else:
    print('All required MCP servers configured.')
"
```

If any servers were added, warn the user to reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window").

### 4c. Check Node.js Version

The `chrome-devtools-mcp` package requires Node.js ≥ 20.19.0. Check and upgrade if needed:

```bash
node --version
```

If the version is below 20.19.0:
```bash
winget upgrade --id OpenJS.NodeJS.20 --accept-source-agreements --accept-package-agreements
```

After upgrading, verify:
```bash
node --version
```

### 4d. Update npm in PianoidTunner

If PianoidTunner was updated or `package.json`/`package-lock.json` changed, ensure npm is current and dependencies are installed:

```bash
npm install -g npm@latest
cmd //c "cd /d PianoidTunner && npm install"
```

### 5. Rebuild Packages

**IMPORTANT — venv isolation:** The build scripts check `VIRTUAL_ENV` and skip activating `PianoidCore\.venv` if it's already set (e.g. to the root `.venv` from the bash shell). Use `env -u VIRTUAL_ENV` to strip it from the environment before spawning cmd. This ensures packages install into `PianoidCore\.venv` (the correct target). Note: `set VIRTUAL_ENV=` inside cmd does NOT work because the bat file's `setlocal` captures the inherited environment before the chained `set` takes effect.

**Before building — stop the `.pyd` holder** (a running backend → `[WinError 5]` on the `--heavy` uninstall, which bricks the venv): launcher REST `curl -X POST http://127.0.0.1:3001/api/stop-backend` (preferred) or a PID-targeted kill (never `//IM python.exe`). **In agent context, build via the detached `Start-Process -WindowStyle Hidden` form** — the `cmd //c` lines below are the interactive-human form (`cmd //c` for `--heavy` gate-stalls DESTRUCTIVELY in agent context). **After building — verify BOTH levels:** L1 `import pianoidCuda` resolves inside `PianoidCore/.venv/`, AND L2 `POST /load_preset` returns **200** with no traceback (a pull that diverges the Python↔C++ API surfaces only at `/load_preset`, not at import). Full procedure: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first).

**PianoidBasic** (if changed):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && .\build_pianoid_basic.bat"
```

**PianoidCuda Heavy** (if C++/CUDA changed OR `--force-heavy`):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && .\build_pianoid_cuda.bat --heavy --both"
```

**PianoidCuda Light** (if only Python middleware changed):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d PianoidCore && .\build_pianoid_cuda.bat --light --both"
```

**PianoidTunner** (if `package.json` or `package-lock.json` changed):
```bash
cmd //c "cd /d PianoidTunner && npm install"
```

**Build failures:** If any build command fails, consult `docs/architecture/BUILD_SYSTEM.md`
(Troubleshooting section) for diagnosis and fixes before retrying.

### 6. Update Documentation (if docs or source changed)

If any source code files (`.py`, `.cu`, `.cpp`, `.h`, `.cuh`, `.tsx`, `.jsx`, `.ts`, `.js`) changed in any repo, or if `docs/**` files changed in PianoidInstall:

**Sync documentation with code changes:**

1. Check if `mkdocs-material` is installed, install if missing:
```bash
pip show mkdocs-material > /dev/null 2>&1 || pip install mkdocs-material
```

2. If source code changed (not just docs), review affected documentation files in `docs\` and update them to reflect code changes:
   - `modules/pianoid-cuda/` docs if CUDA files changed
   - `modules/pianoid-middleware/` docs if middleware Python files changed
   - `modules/pianoid-basic/` docs if PianoidBasic files changed
   - `modules/pianoid-tunner/` docs if frontend files changed
   - `architecture/DATA_FLOWS.md` if any data flow logic changed
   - `architecture/SYSTEM_OVERVIEW.md` if architecture changed
   - `architecture/BUILD_SYSTEM.md` if build scripts changed

3. If documentation was updated, commit to PianoidInstall:
```bash
cd . && git add docs/ && git commit -m "Update documentation to match code changes" && git push origin master
```

**Documentation structure** (`docs/`):
```
docs/
├── index.md                          # Entry point
├── architecture/
│   ├── SYSTEM_OVERVIEW.md            # 4-layer architecture
│   ├── BUILD_SYSTEM.md               # Build pipeline
│   └── DATA_FLOWS.md                 # End-to-end data flows
├── modules/
│   ├── pianoid-cuda/                 # 6 CUDA engine docs
│   ├── pianoid-middleware/           # 4 middleware docs
│   ├── pianoid-basic/OVERVIEW.md     # Domain model
│   └── pianoid-tunner/OVERVIEW.md    # Frontend
├── development/
│   ├── TESTING.md                    # Test framework and inventory
│   └── WORK_IN_PROGRESS.md          # Active investigations
└── guides/QUICK_START.md            # Getting started
```

**Browse docs locally:** `cd . && mkdocs serve -a localhost:8001`

---

### 7. Report Summary

- Which repos were updated (with commit count), including PianoidInstall
- Which packages were rebuilt (and build mode)
- Which project-level skills were added/updated (from `.claude/commands/`)
- Any warnings or errors

## Example Usage

```
/update-pianoid              # Check and update (abort if local changes)
/update-pianoid --force      # Discard local changes and update
/update-pianoid --force-heavy # Force heavy CUDA rebuild
/update-pianoid -f -h        # Both options
```
