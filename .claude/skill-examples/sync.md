# /sync — Pianoid worked examples

Concrete invocations and project specifics for the **Pianoid** project. The generic `/sync` skill body
is project-agnostic and resolves these facts from `docs/PROJECT_CONFIG.md` anchors; this companion holds
the project-specific illustrations. **Project-tier — NOT hoisted machine-global.**

## Repository Map (`#repos`)

The four Pianoid repos, their repo-relative paths, and their integration branches:

| Repo | Path | Main Branch |
|------|------|-------------|
| PianoidInstall | `.` | `master` |
| PianoidCore | `PianoidCore` | `dev` |
| PianoidBasic | `PianoidBasic` | `dev` |
| PianoidTunner | `PianoidTunner` | `dev` |

This is the concrete repo list every per-repo step iterates. (Source of truth: [`PROJECT_CONFIG.md#repos`](../../docs/PROJECT_CONFIG.md#repos).)

## Step 1a — Current branch and status (concrete repo loop)

```bash
for repo in "." "PianoidCore" "PianoidBasic" "PianoidTunner"; do
  echo "=== $(basename $repo) ==="
  echo "Branch: $(git -C "$repo" branch --show-current)"
  echo "Status:"
  git -C "$repo" status --porcelain
  echo ""
done
```

## Step 1c — Fetch all repos before comparing with origin

```bash
for repo in "." "PianoidCore" "PianoidBasic" "PianoidTunner"; do
  git -C "$repo" fetch origin 2>/dev/null
done
```

Then per repo, the integration branch is `master` for PianoidInstall and `dev` for the other three:
```bash
git -C "$REPO" log origin/$BRANCH..HEAD --oneline
```

## Step 1d — Summary table (filled with Pianoid repos)

| Repo | Branch | Uncommitted Files | Unpushed Commits | Notes |
|------|--------|-------------------|------------------|-------|
| PianoidInstall | master | ... | ... | ... |
| PianoidCore | dev | ... | ... | ... |
| PianoidBasic | dev | ... | ... | ... |
| PianoidTunner | dev | ... | ... | ... |

## Step 2 — Conflict detection (Pianoid cross-repo specifics)

- **API contract mismatches**: Changes in PianoidCore that affect interfaces used by PianoidBasic or PianoidTunner (function signatures, data structures, message formats).
- **Data flow breaks**: Use `docs/architecture/DATA_FLOWS.md` as reference — check if a change in one layer breaks assumptions in another.

## Step 3 — Branch check (expected branches)

| Repo | Expected |
|------|----------|
| PianoidInstall | `master` |
| PianoidCore | `dev` |
| PianoidBasic | `dev` |
| PianoidTunner | `dev` |

## Step 4 — Documentation gap analysis (Pianoid doc map)

Map each changed repo to its docs:
- PianoidCore changes → `docs/modules/pianoid-cuda/`, `docs/modules/pianoid-middleware/`, `docs/architecture/`
- PianoidBasic changes → `docs/modules/pianoid-basic/OVERVIEW.md`
- PianoidTunner changes → `docs/modules/pianoid-tunner/OVERVIEW.md`
- Any API changes → `docs/architecture/DATA_FLOWS.md`

## Step 5.5 — Post-Merge Rebuild Gate (Pianoid concrete)

Historical trigger: the `pack_output_mask` regression (2026-06-05) shipped because new source was pushed against a stale binary — this gate's absence is exactly what shipped it.

Concrete changed-files → rebuild matrix (authoritative: [`BUILD_SYSTEM.md` → Canonical Install / Rebuild](../../docs/architecture/BUILD_SYSTEM.md#canonical-install--rebuild-read-this-first), [`PROJECT_CONFIG.md#rebuild-matrix`](../../docs/PROJECT_CONFIG.md#rebuild-matrix)):

| Diff touches | Rebuild |
|---|---|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.cuh`, `*.h`, `setup.py`, `detect_paths.py` | HEAVY CUDA `--both` |
| any `PianoidBasic/**` | PianoidBasic build (+ HEAVY CUDA if `.cu/.cpp` also changed) |
| `pianoid_middleware/*.py` only | LIGHT CUDA `--both` |
| `PianoidTunner` `package.json` / `package-lock.json` | `npm install` |
| docs / tests only | no rebuild |

Procedure:
- Stop the `.pyd` holder first: launcher REST `POST /api/stop-backend`, or a PID-targeted kill (never `//IM python.exe`) — see [`PROJECT_CONFIG.md#build-holders`](../../docs/PROJECT_CONFIG.md#build-holders).
- Build DETACHED (`Start-Process -WindowStyle Hidden`, absolute bat path).
- **L1 verify:** `import pianoidCuda` resolves inside `PianoidCore/.venv/`.
- **L2 verify:** `POST /load_preset` returns **200** with no Python traceback (the API-divergence case import-verify alone misses — e.g. `/load_preset` 500 `AttributeError`).
- On build/server failure → invoke `/startup`.

## Step 6 — Push to Origin (concrete per-repo pushes)

```bash
git -C "." push origin master
git -C "PianoidCore" push origin dev
git -C "PianoidBasic" push origin dev
git -C "PianoidTunner" push origin dev
```

Never force-push; on rejection, `git pull --rebase origin $BRANCH` then retry (after user approval).

## Step 7 — Final report table (Pianoid repos)

| Repo | Branch | Commits Pushed | Status |
|------|--------|----------------|--------|
| PianoidInstall | master | N | OK / Error |
| PianoidCore | dev | N | OK / Error |
| PianoidBasic | dev | N | OK / Error |
| PianoidTunner | dev | N | OK / Error |
