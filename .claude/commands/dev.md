---
name: dev
description: Development workflow — study context, baseline test, branch, edit, verify, debug, document, commit.
user-invocable: true
argument-hint: <task description — bug fix, feature, or refactor>
---

# Pianoid Development Workflow

Disciplined development cycle for PianoidCore, PianoidBasic, and PianoidTunner. Follow every step in order. Do not skip steps.

**Code principles:** Lean (minimum code for the task), modular (one function one job), no workarounds (fix root causes), no redundancy (reuse existing utilities), match existing style.

## Step 1: Understand Context (top-down)

Read documentation in this order, stopping when you have enough context:

1. `D:\repos\PianoidInstall\docs\index.md` — big picture, module map
2. `D:\repos\PianoidInstall\docs\architecture\SYSTEM_OVERVIEW.md` — 4-layer stack, threading, lifecycle
3. `D:\repos\PianoidInstall\docs\architecture\DATA_FLOWS.md` — trace the relevant data flow
4. Drill into the specific module doc:
   - CUDA engine: `docs/modules/pianoid-cuda/*.md`
   - Middleware: `docs/modules/pianoid-middleware/*.md`
   - Domain model: `docs/modules/pianoid-basic/OVERVIEW.md`
   - Frontend: `docs/modules/pianoid-tunner/OVERVIEW.md`
5. Read the actual source files identified from the docs
6. Check `docs/development/WORK_IN_PROGRESS.md` for related ongoing work

Summarize to the user:
- Which files are affected
- Which data flow / component is involved
- Proposed approach

**Ask the user to confirm the approach before proceeding.**

## Step 2: Baseline Performance Test

Before any code changes, run the performance test suite and save results:

```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/baseline_perf.log
```

Record these metrics from the output:

| Metric | Value |
|--------|-------|
| GPU mean (ms) | — |
| GPU p99 (ms) | — |
| Total cycle mean (ms) | — |
| Underrun count | — |
| Sound correlation | — |

If baseline tests fail, report to user and ask whether to proceed.

## Step 3: Branch (if needed)

**Non-trivial changes** (new features, refactors, multi-file edits):
```bash
git -C "D:\repos\PianoidInstall\PianoidCore" checkout dev
git -C "D:\repos\PianoidInstall\PianoidCore" pull origin dev
git -C "D:\repos\PianoidInstall\PianoidCore" checkout -b feature/<short-description>
```

**Small fixes** (single-file, low risk): work directly on `dev`.

Ask the user which approach if unclear.

## Step 4: Edit Code

**Before writing new code**, search for existing utilities:
- `PianoidCore/pianoid_middleware/pianoid.py` — initialization, orchestration
- `PianoidCore/pianoid_middleware/chartFunctions.py` — analysis helpers
- `PianoidCore/tests/conftest.py` — test constants, helpers
- `PianoidCore/pianoid_cuda/Pianoid.cuh` — C++ API surface

**Code style rules:**
- Minimum code for the task — no speculative features, no "while I'm here" cleanup
- One function, one responsibility — split at ~50 lines
- Fix root causes, not symptoms — no `#ifdef` hacks, no silent fallbacks
- Reuse existing helpers — grep before writing
- Match existing patterns in the file (naming, indentation, error handling)

**Rebuild after edits:**

| Changed Files | Build Command |
|--------------|---------------|
| `pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh`, `setup.py` | `cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && build_pianoid_cuda.bat --heavy"` |
| `pianoid_middleware/*.py` only | `cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && build_pianoid_cuda.bat --light"` |
| PianoidBasic `*.py` | `cmd //c "cd /d D:\repos\PianoidInstall\PianoidCore && build_pianoid_basic.bat"` |
| `tests/**` only | No rebuild needed |

## Step 5: Post-Change Performance Test

Run the same test suite:
```bash
cd D:\repos\PianoidInstall\PianoidCore
.venv/Scripts/python -m pytest tests/system/test_performance.py -v -s 2>&1 | tee /tmp/postchange_perf.log
```

Compare against baseline and print a table:

| Metric | Baseline | After | Delta |
|--------|----------|-------|-------|
| GPU mean (ms) | — | — | — |
| GPU p99 (ms) | — | — | — |
| Total cycle mean (ms) | — | — | — |
| Underrun count | — | — | — |
| Sound correlation | — | — | — |

**Regression criteria (hard fail → go to step 6):**
- GPU mean increase > 10%
- Sound correlation drop below 0.95
- Any new test failure

**Warning (report but continue):**
- GPU p99 increase > 20%
- Underrun count increase > 50%

## Step 6: Debug (if tests fail)

**Build failures:** If a build command fails (linker errors, missing libraries, DLL issues),
consult `docs/architecture/BUILD_SYSTEM.md` — especially the Troubleshooting section — before
attempting manual fixes. Common issues (SDL3.lib not found, import failures, `--heavy` vs
`--light` trade-offs) are documented there with diagnosis steps and fixes.

Iterative loop (max 5 iterations):
1. Read failure output — identify root cause, not just symptom
2. Make targeted fix
3. Rebuild if needed (step 4 commands)
4. Re-run failing test only: `.venv/Scripts/python -m pytest tests/system/test_performance.py::<TestClass>::<test_name> -v -s`
5. Once that test passes, re-run full suite (step 5)
6. Repeat until all pass

After 5 failed iterations, stop and report findings to the user. Do not keep looping.

## Step 7: Feature-Specific Testing (new features only)

Ask the user for acceptance criteria:
- What inputs to test?
- What behavior is expected?
- Edge cases?

Write tests in the appropriate level:
- Full stack (GPU + audio) → `tests/system/`
- GPU, no audio → `tests/integration/`
- Pure Python → `tests/unit/`

Follow patterns from `test_performance.py` (fixtures, markers, assertions).

## Step 8: Update Documentation and Commit

**Documentation** — for each affected section, update the relevant doc file:

| Changed source | Doc to update |
|---------------|---------------|
| `pianoid_cuda/*.cu/cpp/h` | `docs/modules/pianoid-cuda/*.md` |
| `pianoid_middleware/*.py` | `docs/modules/pianoid-middleware/*.md` |
| `tests/**` | `docs/development/TESTING.md` |
| Architecture/flow changes | `docs/architecture/DATA_FLOWS.md` |
| New WIP items | `docs/development/WORK_IN_PROGRESS.md` |

Keep docs lean and concise. Tables over prose. Every sentence earns its place.
**Structural doc changes (new pages, nav changes) require user approval.**

**Infographics** — whenever code changes affect logic that is depicted in an existing
infographic, update that infographic to reflect the new state. All infographics live in
`docs/images/` (SVGs) or inline in markdown (Mermaid). Check existing SVGs in
`docs/images/` and Mermaid blocks in the affected doc files.

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

**Commit** — ask user before committing:

```bash
# PianoidCore changes
cd D:\repos\PianoidInstall\PianoidCore
git add <specific-files>
git commit -m "<type>: <description>"
```

Then ask if they want to push and/or merge to dev.

```bash
# Documentation changes
cd D:\repos\PianoidInstall
git add docs/ mkdocs.yml
git commit -m "Update documentation"
git push origin master
```

## Step 9: Merge Feature Branch to Dev

**This step is mandatory when a feature branch was created in Step 3.** Unmerged feature
branches break other systems that install from `dev`.

After the user confirms the work is complete and tests pass:

1. **Merge into dev** for each repo that has a feature branch:
```bash
# Example for PianoidCore
cd D:\repos\PianoidInstall\PianoidCore
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev

# Example for PianoidBasic (if changed)
cd D:\repos\PianoidInstall\PianoidBasic
git checkout dev
git merge feature/<name> --no-ff -m "Merge feature/<name> into dev"
git push origin dev
```

2. **Clean up** — ask user if the feature branch should be deleted:
```bash
git branch -d feature/<name>
git push origin --delete feature/<name>
```

**Do not end the workflow with commits only on a feature branch.** If the user declines
to merge now, warn them explicitly: "Feature branch `feature/<name>` has not been merged
to dev. Other systems installing from dev will not have these changes."

## Key Paths

| Resource | Path |
|----------|------|
| PianoidCore | `D:\repos\PianoidInstall\PianoidCore` |
| PianoidBasic | `D:\repos\PianoidInstall\PianoidBasic` |
| PianoidTunner | `D:\repos\PianoidInstall\PianoidTunner` |
| Performance tests | `PianoidCore/tests/system/test_performance.py` |
| Audio driver tests | `PianoidCore/tests/system/test_audio_drivers.py` |
| Documentation | `D:\repos\PianoidInstall\docs/` |
| venv Python | `PianoidCore/.venv/Scripts/python` |

## Example Usage

```
/dev Fix buffer underrun race condition in CircularBuffer.cu produce()
/dev Add FIR filter bypass mode for debugging
/dev Refactor preset loading to support hot-reload
```
