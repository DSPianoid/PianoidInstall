# /update-docs — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/update-docs`
skill body is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors;
this companion holds the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Argument keywords (Pianoid's actual scopes)
The per-area scope keywords the body abstracts, with the doc files each maps to:

| Argument | Scope |
|----------|-------|
| *(none)* | Auto-detect from changed files |
| `architecture` | `architecture/SYSTEM_OVERVIEW.md`, `BUILD_SYSTEM.md`, `DATA_FLOWS.md` |
| `cuda` | `modules/pianoid-cuda/*.md` |
| `middleware` | `modules/pianoid-middleware/*.md` |
| `basic` | `modules/pianoid-basic/OVERVIEW.md` |
| `tunner` | `modules/pianoid-tunner/OVERVIEW.md` |
| `development` | `development/TESTING.md`, `development/WORK_IN_PROGRESS.md` |
| `all` | Full review of all sections |

## Step 1 — per-repo change scan (resolved `git -C`, from PROJECT_CONFIG.md#repos)
```bash
git -C "PianoidCore" diff --name-only
git -C "PianoidCore" diff --name-only --cached
git -C "PianoidBasic" diff --name-only
git -C "PianoidTunner" diff --name-only
git -C "." diff --name-only
```

## Step 1 — Change → Section mapping (Pianoid file globs)
| Changed files | Section |
|--------------|---------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh` | `cuda` |
| `pianoid_middleware/*.py` | `middleware` |
| PianoidBasic `*.py` | `basic` |
| PianoidTunner `*.tsx`, `*.ts`, `*.jsx`, `*.js` | `tunner` |
| `tests/**` | `development` |
| Build scripts, `setup.py`, `detect_paths.py` | `architecture` (BUILD_SYSTEM) |
| Playback/event/parameter flow changes | `architecture` (DATA_FLOWS) |

## Step 2b — SVG infographic palette (Pianoid Material theme)
- Dark background (`#1a1a2e`), gradient fills matching Material theme (deep purple + amber)

## Step 5 — Verify Build (concrete command)
```bash
pip show mkdocs-material > /dev/null 2>&1 || pip install mkdocs-material
cd . && python -m mkdocs build 2>&1 | grep -c "ERROR"
```

## Step 6 — Commit + push (PianoidInstall integration branch = master, from PROJECT_CONFIG.md#repos)
```bash
cd . && git add docs/ mkdocs.yml && git commit -m "Update documentation" && git push origin master
```

## Documentation Structure (Pianoid's actual tree)
```
docs\
├── index.md                          # Entry point, documentation map
├── architecture/
│   ├── SYSTEM_OVERVIEW.md            # 4-layer architecture
│   ├── BUILD_SYSTEM.md               # Build pipeline
│   └── DATA_FLOWS.md                 # End-to-end data flows
├── modules/
│   ├── pianoid-cuda/                 # 6 docs: Overview, Synthesis, Playback, Memory, Drivers, Parameters
│   ├── pianoid-middleware/           # 4 docs: Overview, REST API, MIDI, Chart System
│   ├── pianoid-basic/OVERVIEW.md     # Domain model
│   └── pianoid-tunner/OVERVIEW.md    # Frontend
├── development/
│   ├── TESTING.md                    # Test framework and inventory
│   └── WORK_IN_PROGRESS.md          # Active investigations
└── guides/QUICK_START.md            # Getting started
```

## Local preview (MkDocs, docs-server address per PROJECT_CONFIG.md#key-paths)
```bash
cd . && mkdocs serve -a localhost:8001
```
Preview URL: `http://localhost:8001/`
