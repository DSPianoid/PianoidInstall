---
name: sync
description: Clean, commit, and push all Pianoid repos — analyse changes, detect conflicts, update docs, commit, merge feature branches, push.
user-invocable: true
argument-hint: [--dry-run|-n] [--skip-docs]
---

# Sync All Pianoid Repos

Analyse, commit, and push all Pianoid repositories to origin. Follow every step in order.

## Arguments

| Flag | Description |
|------|-------------|
| `--dry-run` or `-n` | Analyse and report only — do not commit or push |
| `--skip-docs` | Skip documentation gap analysis (Step 4) |

## Repository Map

| Repo | Path | Main Branch |
|------|------|-------------|
| PianoidInstall | `D:\repos\PianoidInstall` | `master` |
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` | `dev` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` | `dev` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` | `dev` |

## Step 1: Full Change Analysis

For each repo, collect:

### 1a. Current branch and status

```bash
for repo in "D:\repos\PianoidInstall" "D:\repos\PianoidInstall\PianoidCore" "D:\repos\PianoidInstall\PianoidBasic" "D:\repos\PianoidInstall\PianoidTunner"; do
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
for repo in "D:\repos\PianoidInstall" "D:\repos\PianoidInstall\PianoidCore" "D:\repos\PianoidInstall\PianoidBasic" "D:\repos\PianoidInstall\PianoidTunner"; do
  git -C "$repo" fetch origin 2>/dev/null
done
```

Then for each repo, determine the main branch (`master` for PianoidInstall, `dev` for others) and show unpushed commits:
```bash
git -C "$REPO" log origin/$BRANCH..HEAD --oneline
```

### 1d. Present summary

Present a clear table to the user:

| Repo | Branch | Uncommitted Files | Unpushed Commits | Notes |
|------|--------|-------------------|------------------|-------|
| PianoidInstall | master | ... | ... | ... |
| PianoidCore | dev | ... | ... | ... |
| PianoidBasic | dev | ... | ... | ... |
| PianoidTunner | dev | ... | ... | ... |

## Step 2: Conflict Detection

Look for conflicting edits — changes touching related systems across different repos. Check for:

1. **API contract mismatches**: Changes in PianoidCore that affect interfaces used by PianoidBasic or PianoidTunner (e.g., function signatures, data structures, message formats)
2. **Shared type/enum changes**: If constants, enums, or shared types changed in one repo but consumers in another repo weren't updated
3. **Data flow breaks**: Using `docs/architecture/DATA_FLOWS.md` as reference, check if changes in one layer break assumptions in another layer
4. **Version/dependency drift**: Package version changes that might cause incompatibilities

For each potential conflict found:
- Describe the conflict clearly
- Show the relevant code on both sides
- **Ask the user how to reconcile** before proceeding

If no conflicts found, report "No cross-repo conflicts detected" and continue.

## Step 3: Branch Check

For each repo, verify the current branch matches the expected main branch:

| Repo | Expected |
|------|----------|
| PianoidInstall | `master` |
| PianoidCore | `dev` |
| PianoidBasic | `dev` |
| PianoidTunner | `dev` |

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

1. Read the relevant docs based on which repos have changes:
   - PianoidCore changes → check `docs/modules/pianoid-cuda/`, `docs/modules/pianoid-middleware/`, `docs/architecture/`
   - PianoidBasic changes → check `docs/modules/pianoid-basic/OVERVIEW.md`
   - PianoidTunner changes → check `docs/modules/pianoid-tunner/OVERVIEW.md`
   - Any API changes → check `docs/architecture/DATA_FLOWS.md`

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

   Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
   EOF
   )"
   ```

**Important**: Present all commit messages to the user for approval before committing. The user may want to adjust wording or split commits.

## Step 6: Push to Origin

For each repo, push the main branch to origin:

```bash
git -C "D:\repos\PianoidInstall" push origin master
git -C "D:\repos\PianoidInstall\PianoidCore" push origin dev
git -C "D:\repos\PianoidInstall\PianoidBasic" push origin dev
git -C "D:\repos\PianoidInstall\PianoidTunner" push origin dev
```

If push fails (e.g., remote has new commits):
1. Report the error to the user
2. **Do NOT force push** — ask the user how to proceed
3. Typical resolution: `git pull --rebase origin $BRANCH` then retry push

## Step 7: Final Report

Present a summary:

| Repo | Branch | Commits Pushed | Status |
|------|--------|----------------|--------|
| PianoidInstall | master | N | OK / Error |
| PianoidCore | dev | N | OK / Error |
| PianoidBasic | dev | N | OK / Error |
| PianoidTunner | dev | N | OK / Error |

If `--dry-run` was specified, instead present what *would* happen without actually committing or pushing.
