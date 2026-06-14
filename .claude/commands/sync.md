---
name: sync
description: Clean, commit, and push all project repos — analyse changes, detect conflicts, update docs, commit, merge feature branches, push.
user-invocable: true
tier: generic
argument-hint: [--dry-run|-n] [--skip-docs]
---

# Sync All Project Repos

> **Project-agnostic skill** (`tier: generic`). Operates on an **active project**: resolve `$PROJECT_ROOT`
> and the project's `docs/PROJECT_CONFIG.md` per the machine-global `~/.claude/CLAUDE.md` "Config resolution" section (#config-resolution)
> — including the **graceful fallback** when no `PROJECT_CONFIG.md` is found. All project facts (build,
> ports, venv, repos, endpoints, verification surfaces) come from that config by anchor; this skill
> resolves them there rather than hard-coding them.

**Worked examples (project-tier):** concrete invocations for the active project — the repo/branch table, the per-repo `git -C` status/fetch/log loops, the post-merge rebuild matrix + holder-stop + import & smoke-test verify, and the per-repo push lines — live in [`.claude/skill-examples/sync.md`](../skill-examples/sync.md) ([`#skill-examples`](../../docs/PROJECT_CONFIG.md#skill-examples)).

Analyse, commit, and push all of the active project's repositories to origin. Follow every step in order.

## Arguments

| Flag | Description |
|------|-------------|
| `--dry-run` or `-n` | Analyse and report only — do not commit or push |
| `--skip-docs` | Skip documentation gap analysis (Step 4) |

## Repository Map

The active project's repos, their repo-relative paths, and their integration branches are project facts —
resolve them from the active project's [`PROJECT_CONFIG.md` → Repos](../../docs/PROJECT_CONFIG.md#repos).
Every per-repo step below iterates that repo list; substitute the project's repo-relative paths and
integration branches wherever the examples show placeholders. (The concrete repo/branch table for the
active project is in the [worked-examples companion](../skill-examples/sync.md).)

## Step 1: Full Change Analysis

For each repo (iterate the repo list from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)), collect:

### 1a. Current branch and status

```bash
# Iterate the repo-relative paths from PROJECT_CONFIG.md#repos
for repo in <repo-relative-paths from PROJECT_CONFIG.md#repos>; do
  echo "=== $(basename $repo) ==="
  echo "Branch: $(git -C "$repo" branch --show-current)"
  echo "Status:"
  git -C "$repo" status --porcelain
  echo ""
done
```

### 1b. Uncommitted changes (staged + unstaged)

For each repo with changes:
```bash
git -C "$REPO" diff              # unstaged
git -C "$REPO" diff --cached     # staged
```

### 1c. Committed-but-not-pushed changes

Fetch first, then compare with origin:
```bash
# Iterate the repo-relative paths from PROJECT_CONFIG.md#repos
for repo in <repo-relative-paths from PROJECT_CONFIG.md#repos>; do
  git -C "$repo" fetch origin 2>/dev/null
done
```

Then for each repo, determine its integration branch (per [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)) and show unpushed commits:
```bash
git -C "$REPO" log origin/$BRANCH..HEAD --oneline
```

### 1d. Present summary

Present a clear table to the user — one row per repo from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos):

| Repo | Branch | Uncommitted Files | Unpushed Commits | Notes |
|------|--------|-------------------|------------------|-------|
| *(per repo)* | ... | ... | ... | ... |

## Step 2: Conflict Detection

Look for conflicting edits — changes touching related systems across different repos. Check for:

1. **API contract mismatches**: Changes in one repo that affect interfaces used by another repo (e.g., function signatures, data structures, message formats)
2. **Shared type/enum changes**: If constants, enums, or shared types changed in one repo but consumers in another repo weren't updated
3. **Data flow breaks**: Using the active project's data-flow doc as reference (resolve from [`PROJECT_CONFIG.md#doc-hierarchy`](../../docs/PROJECT_CONFIG.md#doc-hierarchy)), check if changes in one layer break assumptions in another layer
4. **Version/dependency drift**: Package version changes that might cause incompatibilities

For each potential conflict found:
- Describe the conflict clearly
- Show the relevant code on both sides
- **Ask the user how to reconcile** before proceeding

If no conflicts found, report "No cross-repo conflicts detected" and continue.

## Step 3: Branch Check

For each repo, verify the current branch matches the expected integration branch (per [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)).

If any repo is on a **feature branch**:
1. Show the user what commits are on the feature branch vs the main branch
2. **Ask the user**: merge the feature branch into the main branch, or leave it?
3. If user approves merge:
   ```bash
   git -C "$REPO" checkout $MAIN_BRANCH
   git -C "$REPO" merge $FEATURE_BRANCH
   ```
4. After successful merge, optionally delete the feature branch:
   ```bash
   git -C "$REPO" branch -d $FEATURE_BRANCH
   ```

## Step 4: Documentation Gap Analysis

Skip this step if `--skip-docs` flag is provided.

Review all changes (uncommitted + unpushed commits) and check if documentation reflects them:

1. Read the relevant docs based on which repos have changes — map each changed source area to its doc section via the active project's [`PROJECT_CONFIG.md` → Doc-hierarchy](../../docs/PROJECT_CONFIG.md#doc-hierarchy) (engine/module sources → their module docs; any API changes → the data-flows architecture doc).

2. For each undocumented change:
   - Describe what's missing
   - **Ask the user** whether to update the docs now or skip
   - If user approves, update the docs following the lean style from `/update-docs`:
     - No filler, no verbose explanations
     - Prefer tables and code blocks over prose
     - Every sentence must earn its place

## Step 5: Commit Uncommitted Changes

For each repo with uncommitted changes:

1. Show the user a summary of what will be committed
2. Stage all changes:
   ```bash
   git -C "$REPO" add -A
   ```
3. Generate a commit message:
   - Analyse the nature of changes (feature, fix, refactor, docs, etc.)
   - Write a concise message following the repo's existing commit style
   - Check recent commits for style reference:
     ```bash
     git -C "$REPO" log --oneline -5
     ```
4. Commit:
   ```bash
   git -C "$REPO" commit -m "$(cat <<'EOF'
   <commit message>

   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

**Important**: Present all commit messages to the user for approval before committing. The user may want to adjust wording or split commits.

## Step 5.5: Post-Merge Rebuild Gate (BLOCKING — before push)

A merge that brings in compiled-code changes leaves the LOCAL binaries stale against the new source. Pushing without rebuilding publishes new source that the binaries don't match — the backend then runs new code against a stale native build and fails only at runtime (e.g. a post-load smoke-test returns 500 / `AttributeError`). **This gate is mandatory** — its absence is exactly what ships a broken build (new source published against a stale binary).

1. Compute what the Step-3 merges brought into each repo:
   ```bash
   git -C "$REPO" diff <pre-merge-SHA>..HEAD --name-only
   ```
2. If the diff touches compiled code, REBUILD per the active project's rebuild matrix and canonical build procedure — resolve the changed-files → build mapping from [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix) and the build procedure from [`#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run). (Compiled-engine sources → a heavy/full rebuild; domain-model sources → the domain-model build; server/middleware-only sources → a light rebuild; frontend dependency changes → the frontend package install; docs/tests only → no rebuild.)

3. Stop the build holder first (per [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders) — e.g. the project's start-API stop endpoint, or a PID-targeted kill), build DETACHED (`Start-Process -WindowStyle Hidden`, absolute build-script path), then **VERIFY both levels**: L1 the rebuilt module imports inside the project's venv (per [`#interpreters`](../../docs/PROJECT_CONFIG.md#interpreters)), AND L2 the post-load smoke-test returns **200** with no traceback (the API-divergence case that import-verify alone misses — see [`#rest-endpoints`](../../docs/PROJECT_CONFIG.md#rest-endpoints) / [`#verification-surfaces`](../../docs/PROJECT_CONFIG.md#verification-surfaces)). On unexpected build or server failure → invoke the project's startup/build-recovery skill (see [`#docs-first-build--run`](../../docs/PROJECT_CONFIG.md#docs-first-build--run)).

**Step 6 (push) is BLOCKED until the rebuild + the post-load 200 smoke-test pass.** If no compiled code changed, record "post-merge gate: no compiled diff, no rebuild" and proceed. (The active project's concrete rebuild command, holder-stop call, and verify commands are in the [worked-examples companion](../skill-examples/sync.md).)

## Step 6: Push to Origin

For each repo, push its integration branch to origin (iterate the repo + branch list from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos)):

```bash
# Per-repo push — substitute each repo-relative path + its integration branch from PROJECT_CONFIG.md#repos
git -C "<repo>" push origin "<integration-branch>"
```

If push fails (e.g., remote has new commits):
1. Report the error to the user
2. **Do NOT force push** — ask the user how to proceed
3. Typical resolution: `git pull --rebase origin $BRANCH` then retry push

## Step 7: Final Report

Present a summary — one row per repo from [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos):

| Repo | Branch | Commits Pushed | Status |
|------|--------|----------------|--------|
| *(per repo)* | ... | N | OK / Error |

If `--dry-run` was specified, instead present what *would* happen without actually committing or pushing.
