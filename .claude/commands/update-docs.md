---
name: update-docs
description: Update documentation to match current codebase state.
user-invocable: true
tier: generic
argument-hint: [architecture|<module/area keyword>|development|all]
---

# Update Documentation

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the per-repo diff scan, the change→section mapping, the module-doc tree, and the docs-server build/preview commands — live in [`.claude/skill-examples/update-docs.md`](../skill-examples/update-docs.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Sync documentation in `docs/` with current source code.

**CRITICAL: Keep all documentation as lean and concise as possible. No filler, no verbose explanations. Prefer tables and code blocks over prose. Every sentence must earn its place.**

## Arguments

The scope keywords map to the active project's documentation sections — resolve the doc tree and the change→section mapping from the active project's [`PROJECT_CONFIG.md` → Doc-hierarchy](../../docs/PROJECT_CONFIG.md#doc-hierarchy) and [→ Key Paths](../../docs/PROJECT_CONFIG.md#key-paths). The argument keywords are the per-module/per-area scopes the project declares; pass `all` for a full review of every section, or *(none)* to auto-detect from changed files.

| Argument | Scope |
|----------|-------|
| *(none)* | Auto-detect from changed files |
| `architecture` | The project's architecture docs (system overview, build system, data flows) |
| *(per-area keyword)* | The project's module/area doc section (resolve the section list from the project's doc tree — [`#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy) / [`#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths)) |
| `development` | The development docs (testing inventory, work-in-progress) |
| `all` | Full review of all sections |

The concrete keyword set for the active project (its module/area scopes and the doc filenames each maps to) is a project fact — see the [worked-examples companion](../skill-examples/update-docs.md).

## Workflow

### 1. Detect Changes

If no argument given, scan for uncommitted changes to infer affected sections (run the per-repo diff across every repo in the active project's [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):

```bash
# Per-repo uncommitted change scan — resolve the repo list from PROJECT_CONFIG.md#repos
for repo in <repo-relative-paths from PROJECT_CONFIG.md#repos>; do
  git -C "$repo" diff --name-only
  git -C "$repo" diff --name-only --cached
done
```

The concrete repo list (and the resolved `git -C` invocations) is a project fact — see the [worked-examples companion](../skill-examples/update-docs.md).

**Change → Section mapping:** map each changed source area to its documentation section. The concrete file-glob → doc-section table is a project fact — resolve it from the active project's [`PROJECT_CONFIG.md` → Doc-hierarchy](../../docs/PROJECT_CONFIG.md#doc-hierarchy) and [→ Key Paths](../../docs/PROJECT_CONFIG.md#key-paths) (compiled-engine sources → the engine module docs; middleware/server sources → the middleware docs; domain-model sources → the domain-model docs; frontend sources → the frontend docs; tests → the development/testing docs; build scripts → the build-system architecture doc; cross-layer data-flow changes → the data-flows architecture doc).

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
- Dark background, gradient fills matching the docs theme
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

Build the docs site and confirm zero errors (the project's docs-server tooling — the concrete build/preview command is a project fact, see the [worked-examples companion](../skill-examples/update-docs.md)):

```bash
python -m mkdocs build 2>&1 | grep -c "ERROR"
```

### 6. Commit

Ask the user before pushing (commit the docs + config and push the docs repo to its integration branch — resolve the repo + branch from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):

```bash
git add docs/ mkdocs.yml && git commit -m "Update documentation" && git push origin <docs-integration-branch>
```

## Documentation Folder Taxonomy

When updating docs, respect the canonical folder layout (single source of truth in `.claude/commands/dev.md`):

- `docs/development/logs/` - agent session logs ONLY
- `docs/development/logs/archive/` - completed sessions
- `docs/proposals/` - currently-active design proposals (one doc per topic — see "One-doc-per-topic" rule in `.claude/commands/dev.md`)
- `docs/proposals/archive/` - superseded / preparation / research / implemented proposal docs
- `docs/development/reviews/` - code/system reviews and audits
- `docs/development/diagnostics/` - diagnostic snippets/scripts
- `docs/development/screenshots/` - standalone UI screenshots
- `docs/architecture/`, `docs/guides/`, `docs/modules/` - long-lived reference docs

Never move agent session logs out of `docs/development/logs/`. Never deposit non-session-log artefacts into it. If a stray plan / review / diagnostic appears under `logs/`, file an issue or relocate via `git mv` to the correct folder. Likewise, `docs/development/proposals/` must NOT exist — proposals (one per topic) belong in `docs/proposals/`; working/planning docs go directly under `docs/development/`.

## Documentation Structure

The concrete documentation tree is a project fact — resolve the module/area layout from the active project's [`PROJECT_CONFIG.md` → Doc-hierarchy](../../docs/PROJECT_CONFIG.md#doc-hierarchy) and [→ Key Paths](../../docs/PROJECT_CONFIG.md#key-paths). The tree typically follows this shape:

```
docs/
├── index.md                  # Entry point, documentation map
├── architecture/             # System overview, build system, data flows
├── modules/                  # One subtree per module/area (engine, middleware, domain model, frontend)
├── development/              # Testing inventory, work-in-progress
└── guides/                  # Getting-started + operational guides
```

The active project's actual tree (module folder names, per-module doc counts) is in the [worked-examples companion](../skill-examples/update-docs.md).

**MkDocs config:** `mkdocs.yml`
**Local preview:** `mkdocs serve` at the project's docs-server address (resolve from [`PROJECT_CONFIG.md#key-paths`](../../docs/PROJECT_CONFIG.md#key-paths))

## Example Usage

```
/update-docs                # Auto-detect from git changes
/update-docs architecture   # Update architecture docs only
/update-docs <module>       # Update one module/area's docs only
/update-docs development    # Update testing & WIP docs
/update-docs all            # Full documentation review
```
