---
name: update-docs
description: Update Pianoid documentation to match current codebase state.
user-invocable: true
argument-hint: [architecture|cuda|middleware|basic|tunner|development|all]
---

# Update Pianoid Documentation

Sync documentation in `D:\repos\PianoidInstall\docs\` with current source code.

**CRITICAL: Keep all documentation as lean and concise as possible. No filler, no verbose explanations. Prefer tables and code blocks over prose. Every sentence must earn its place.**

## Arguments

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

## Workflow

### 1. Detect Changes

If no argument given, scan for uncommitted changes to infer affected sections:

```bash
git -C "D:\repos\PianoidInstall\PianoidCore" diff --name-only
git -C "D:\repos\PianoidInstall\PianoidCore" diff --name-only --cached
git -C "D:\repos\PianoidInstall\PianoidBasic" diff --name-only
git -C "D:\repos\PianoidInstall\PianoidTunner" diff --name-only
git -C "D:\repos\PianoidInstall" diff --name-only
```

**Change → Section mapping:**

| Changed files | Section |
|--------------|---------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh` | `cuda` |
| `pianoid_middleware/*.py` | `middleware` |
| PianoidBasic `*.py` | `basic` |
| PianoidTunner `*.tsx`, `*.ts`, `*.jsx`, `*.js` | `tunner` |
| `tests/**` | `development` |
| Build scripts, `setup.py`, `detect_paths.py` | `architecture` (BUILD_SYSTEM) |
| Playback/event/parameter flow changes | `architecture` (DATA_FLOWS) |

If no changes detected and no argument given, report "No changes detected" and exit.

### 2. Update Affected Docs

For each affected section:
1. Read the current doc file(s)
2. Read the relevant source files that changed
3. Update the doc to reflect current code state
4. **Style rules:**
   - Tables over prose
   - Code blocks for APIs and paths
   - One sentence per concept
   - No redundant explanations
   - Delete outdated content rather than marking it

### 2b. Update Infographics

Whenever changes affect logic depicted in an existing infographic, update that
infographic to reflect the new state. Check all SVGs in `docs/images/` and any
Mermaid code blocks in the affected doc files.

When documentation would benefit from a new diagram (flow, architecture, state machine,
sequence, etc.), prefer **Mermaid** over ASCII art. Mermaid is configured in `mkdocs.yml`
(superfences custom fences) and renders natively in MkDocs Material. Use fenced code
blocks with `mermaid` language tag. For complex, high-visual-impact diagrams (hero
overviews, dense coupling diagrams), use **hand-crafted SVG** in `docs/images/`.

SVG style rules:
- Dark background (`#1a1a2e`), gradient fills matching Material theme (deep purple + amber)
- `filter` with `feDropShadow` for depth, rounded rectangles (`rx="10-14"`)
- Embed as `![Alt text](../images/filename.svg)` in markdown

**Never add new ASCII art diagrams.** Replace existing ASCII diagrams with Mermaid or SVG
when you are already editing that section.

### 3. Structural Changes (REQUIRES USER APPROVAL)

If code changes suggest any of these, **stop and ask the user before proceeding:**
- Creating a new doc page
- Reorganizing sections or moving content between files
- Removing an existing doc page
- Adding/removing entries in `mkdocs.yml` nav
- Adding/removing sections in `index.md` documentation map

Present the proposed change with rationale. Only proceed after explicit approval.

Content updates to existing doc files can proceed without asking.

### 4. Update Cross-References

If doc files were added/removed (after user approval):
- Update `docs/index.md` documentation map
- Update `mkdocs.yml` nav section

### 5. Verify Build

```bash
pip show mkdocs-material > /dev/null 2>&1 || pip install mkdocs-material
cd D:\repos\PianoidInstall && python -m mkdocs build 2>&1 | grep -c "ERROR"
```

### 6. Commit

Ask user before pushing:
```bash
cd D:\repos\PianoidInstall && git add docs/ mkdocs.yml && git commit -m "Update documentation" && git push origin master
```

## Documentation Structure

```
D:\repos\PianoidInstall\docs\
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

**MkDocs config:** `D:\repos\PianoidInstall\mkdocs.yml`
**Local preview:** `cd D:\repos\PianoidInstall && mkdocs serve -a localhost:8001`

## Example Usage

```
/update-docs                # Auto-detect from git changes
/update-docs cuda           # Update CUDA engine docs only
/update-docs development    # Update testing & WIP docs
/update-docs all            # Full documentation review
```
