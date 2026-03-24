---
name: update-pianoid
description: Update all Pianoid repos (PianoidInstall, PianoidCore, PianoidBasic, PianoidTunner) — fetch, rebuild, sync project skills.
user-invocable: true
argument-hint: [--force|-f] [--force-heavy|-h]
---

# Update Pianoid Packages

Update PianoidInstall (docs, skills, config), PianoidCore, PianoidBasic, and PianoidTunner by fetching latest changes from git and rebuilding as needed.

## Arguments

| Flag | Description |
|------|-------------|
| `--force` or `-f` | Discard local uncommitted changes and proceed |
| `--force-heavy` or `-h` | Force heavy CUDA rebuild regardless of changes |

## Repository Locations

- **PianoidInstall**: `D:\repos\PianoidInstall` (branch: `master` — docs, project skills, config)
- **PianoidCore**: `D:\repos\PianoidInstall\PianoidCore` (branch: `dev`)
- **PianoidBasic**: `D:\repos\PianoidInstall\PianoidBasic` (branch: `dev`)
- **PianoidTunner**: `D:\repos\PianoidInstall\PianoidTunner` (branch: `dev`, React/Node.js frontend)

## Workflow

### 1. Check Local Changes

For all repos, run:
```bash
git -C "D:\repos\PianoidInstall" status --porcelain | grep -v "^??"
git -C "D:\repos\PianoidInstall\PianoidCore" status --porcelain
git -C "D:\repos\PianoidInstall\PianoidBasic" status --porcelain
git -C "D:\repos\PianoidInstall\PianoidTunner" status --porcelain
```

Note: PianoidInstall ignores untracked files (`??`) since nested repos appear as untracked — only modified tracked files block the update.

- If uncommitted changes exist and NO `--force` flag: **ABORT** with warning listing changed files
- If `--force` flag provided: discard changes with `git checkout .`

### 2. Fetch and Check for Updates

```bash
git -C "D:\repos\PianoidInstall" fetch origin
git -C "D:\repos\PianoidInstall\PianoidCore" fetch origin
git -C "D:\repos\PianoidInstall\PianoidBasic" fetch origin
git -C "D:\repos\PianoidInstall\PianoidTunner" fetch origin
```

**Verify fetch is complete** — for each repo, confirm local `origin/<branch>` matches the remote:
```bash
git -C "D:\repos\PianoidInstall" rev-parse origin/master
git -C "D:\repos\PianoidInstall\PianoidCore" rev-parse origin/dev
git -C "D:\repos\PianoidInstall\PianoidBasic" rev-parse origin/dev
git -C "D:\repos\PianoidInstall\PianoidTunner" rev-parse origin/dev
git -C "D:\repos\PianoidInstall" ls-remote origin master | cut -f1
git -C "D:\repos\PianoidInstall\PianoidCore" ls-remote origin dev | cut -f1
git -C "D:\repos\PianoidInstall\PianoidBasic" ls-remote origin dev | cut -f1
git -C "D:\repos\PianoidInstall\PianoidTunner" ls-remote origin dev | cut -f1
```
If any local `rev-parse` does not match `ls-remote`, run `git fetch origin` again for that repo.

Show pending commits:
```bash
git -C "D:\repos\PianoidInstall" log HEAD..origin/master --oneline
git -C "D:\repos\PianoidInstall\PianoidCore" log HEAD..origin/dev --oneline
git -C "D:\repos\PianoidInstall\PianoidBasic" log HEAD..origin/dev --oneline
git -C "D:\repos\PianoidInstall\PianoidTunner" log HEAD..origin/dev --oneline
```

If no updates in any repo: report "Already up to date" and exit.

### 3. Analyze Changes for Smart Rebuild

Get changed files:
```bash
git -C "D:\repos\PianoidInstall" diff HEAD..origin/master --name-only
git -C "D:\repos\PianoidInstall\PianoidCore" diff HEAD..origin/dev --name-only
git -C "D:\repos\PianoidInstall\PianoidBasic" diff HEAD..origin/dev --name-only
git -C "D:\repos\PianoidInstall\PianoidTunner" diff HEAD..origin/dev --name-only
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
| `package.json` or `package-lock.json` in PianoidTunner | Run `npm install` |
| Any files in PianoidTunner (no dependency changes) | Skip npm install (no build step needed) |

### 4. Pull Updates

```bash
git -C "D:\repos\PianoidInstall" pull origin master
git -C "D:\repos\PianoidInstall\PianoidCore" pull origin dev
git -C "D:\repos\PianoidInstall\PianoidBasic" pull origin dev
git -C "D:\repos\PianoidInstall\PianoidTunner" pull origin dev
```

### 4a. Install Project-Level Skills and Settings

After pulling PianoidInstall, project-level skills and settings in `.claude/` are automatically updated via git. Report any new or changed files:

```bash
git -C "D:\repos\PianoidInstall" diff HEAD@{1}..HEAD --name-only -- .claude/
```

If any `.claude/commands/*.md` files changed, list them in the report.
If `.claude/settings.json` changed, note that Claude Code permissions were updated (takes effect on next session or VS Code reload).

### 5. Rebuild Packages

**IMPORTANT — venv isolation:** The build scripts check `VIRTUAL_ENV` and skip activating `PianoidCore\.venv` if it's already set (e.g. to the root `.venv` from the bash shell). Use `env -u VIRTUAL_ENV` to strip it from the environment before spawning cmd. This ensures packages install into `PianoidCore\.venv` (the correct target). Note: `set VIRTUAL_ENV=` inside cmd does NOT work because the bat file's `setlocal` captures the inherited environment before the chained `set` takes effect.

**PianoidBasic** (if changed):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_basic.bat"
```

**PianoidCuda Heavy** (if C++/CUDA changed OR `--force-heavy`):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --heavy --both"
```

**PianoidCuda Light** (if only Python middleware changed):
```bash
env -u VIRTUAL_ENV cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && D:\repos\PianoidInstall\PianoidCore\build_pianoid_cuda.bat --light --both"
```

**PianoidTunner** (if `package.json` or `package-lock.json` changed):
```bash
cmd //c "cd /d D:\repos\PianoidInstall\PianoidTunner && npm install"
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

2. If source code changed (not just docs), review affected documentation files in `D:\repos\PianoidInstall\docs\` and update them to reflect code changes:
   - `modules/pianoid-cuda/` docs if CUDA files changed
   - `modules/pianoid-middleware/` docs if middleware Python files changed
   - `modules/pianoid-basic/` docs if PianoidBasic files changed
   - `modules/pianoid-tunner/` docs if frontend files changed
   - `architecture/DATA_FLOWS.md` if any data flow logic changed
   - `architecture/SYSTEM_OVERVIEW.md` if architecture changed
   - `architecture/BUILD_SYSTEM.md` if build scripts changed

3. If documentation was updated, commit to PianoidInstall:
```bash
cd D:\repos\PianoidInstall && git add docs/ && git commit -m "Update documentation to match code changes" && git push origin master
```

**Documentation structure** (`D:\repos\PianoidInstall\docs/`):
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

**Browse docs locally:** `cd D:\repos\PianoidInstall && mkdocs serve -a localhost:8001`

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
