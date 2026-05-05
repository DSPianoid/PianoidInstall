# Windows / Linux Track Separation Proposal

**Status:** Draft for review (dev-3b60, 2026-05-05)
**Driver request:** "Propose clear separation between windows and Linux tracks. Make sure both of them are functioning correctly."
**Scope:** Build/install/startup machinery in PianoidInstall + PianoidCore

---

## TL;DR — Recommendation

Keep the current **single-source / platform-branched** approach, but harden three weak points:

1. Add `.gitattributes` to all three sub-repos (PianoidCore, PianoidBasic, PianoidTunner) so the LF/CRLF policy is enforced consistently across clones — not only in PianoidInstall.
2. Stop committing `.venv`-style symlinks under any path that can be checked out on Windows; the Linux relocation logic must be entirely runtime, not on-disk.
3. Fix the `start-pianoid.bat` filename-casing inconsistency (`backendserver.py` → `backendServer.py`) and add a documented invariant: shell wrappers must reference the canonical filename.

A full track separation (separate branches, parallel script trees) was considered and rejected as too expensive — see Section 6.

---

## 1. Current State

### What's shared

| Asset | Mechanism |
|---|---|
| Source code (`pianoid_cuda/*.cu`, `*.cpp`, `*.h`, `*.cuh`) | Same files; platform `#ifdef` guards in 1 file (`Pianoid.cu` for `windows.h` include) |
| `pianoid_cuda/setup.py` | Single file; runtime branch on `sys.platform.startswith("win")` |
| `detect_paths.py` | Single file; `IS_WINDOWS` / `IS_LINUX` branches with separate `_find_*_linux` helpers |
| `requirements.txt` | Single file (UTF-16 LE); per-package `; sys_platform == "win32"` markers gate Windows-only deps (pywin32, pywinpty) |
| `pianoid_middleware/backendServer.py` venv guard | Single file; `sys.platform.startswith('win')` chooses Scripts/python.exe vs bin/python |
| `pianoid_middleware/modal_adapter_server.py` venv guard | Same as above |
| Documentation (`docs/`) | Single tree; OS-specific commands flagged inline (paths use repo-relative + per-OS prefix table at top of CLAUDE.md) |
| `setup-config.json` | Shared (versions are platform-agnostic; `sdl_root` is Windows-only but harmless on Linux) |

### What's split (parallel `.bat` and `.sh` files)

| Function | Windows | Linux |
|---|---|---|
| Install system packages | `setup-packages.bat` | `setup-packages.sh` |
| Install Pianoid (venv + builds) | `setup-pianoid.bat` | `setup-pianoid.sh` |
| Build PianoidBasic wheel | `PianoidCore/build_pianoid_basic.bat` | `PianoidCore/build_pianoid_basic.sh` |
| Build PianoidCuda extension | `PianoidCore/build_pianoid_cuda.bat` | `PianoidCore/build_pianoid_cuda.sh` |
| Launch full stack | `start-pianoid.bat` | `start-pianoid.sh` |

The `.bat` and `.sh` files at each pair are functional siblings: same step structure, same flags, same exit semantics. They diverge only where the OS actually differs (NTFS venv relocation, `lsof` vs `tasklist` for lock detection, `cmd //c` vs direct shell invocation).

### What's Windows-only

| File | Reason |
|---|---|
| `clone-packages.bat`, `install-git.bat`, `install-gpu-driver.bat`, `install-python.bat` | Bootstrap scripts for users without `winget` access; not needed on Linux (use distro package manager) |
| `copy_installation_to_core.bat`, `create_archive.bat`, `start_detect_path.bat`, `test.bat`, `venv-activate.bat` | Developer convenience scripts |
| ASIO source files (`asio.cpp`, `asiodrivers.cpp`, etc.) | ASIO depends on COM/`ole32`/`advapi32`; filtered out of Linux build by `setup.py:_discover_sources` |

### What's Linux-only

| File | Reason |
|---|---|
| `setup-packages.sh` Linux logic — apt/dnf/pacman/zypper detection | Distro-specific package install |
| `detect_paths.py:_find_gcc_linux`, `_find_cuda_linux`, `_find_sdl_linux` | Linux toolchain discovery |
| `setup-pianoid.sh` venv-relocate-on-NTFS logic | NTFS via ntfs-3g rejects `*.` filenames pip writes during install |
| Linux-only docs: `docs/guides/LINUX_BUILD.md` | Linux-specific install walkthrough |

---

## 2. Identified Issues

### I1. `.gitattributes` scope gap (Risk)

The Linux session added `.gitattributes` to PianoidInstall only — pinning `.bat`/`.cmd`/`.ps1` to CRLF, all other text to LF. PianoidCore, PianoidBasic, PianoidTunner have no `.gitattributes`. Consequence: `PianoidCore/build_pianoid_cuda.bat`, `PianoidCore/build_pianoid_basic.bat`, and any `.cmd`/`.ps1` files in the sub-repos are eol-unspecified — vulnerable to local `core.autocrlf=input` flipping them to LF, which can break execution on Windows.

Currently safe on this machine (CRLF on disk), but it is a latent failure for fresh clones.

### I2. Linux symlink leaks into Windows working tree (Bug)

The Linux `setup-pianoid.sh` venv-relocation logic creates a symlink at `PianoidCore/.venv` → `~/.cache/pianoid-venv-<hash>`. When the same checkout is opened on Windows, the symlink is a broken Windows symlink (file containing a Linux path string). It is gitignored (`.venv/` excluded), but it persists in the working tree and breaks every Windows tool that follows the venv path.

Also encountered on this machine — required manual cleanup before any Windows build could run.

### I3. `start-pianoid.bat` filename casing (Risk)

The Windows launcher references `backendserver.py` (lowercase 's'). Canonical filename is `backendServer.py` (capital S). NTFS is case-insensitive, so it currently works on Windows. The Linux session correctly fixed `start-pianoid.sh` to use the canonical name. The `.bat` was not touched.

This is a fragile inconsistency — case-sensitive Windows volumes (NTFS with the per-directory case-sensitivity flag, or WSL bind mounts) would break it.

### I4. PianoidBasic CRLF noise (Cosmetic)

`PianoidBasic/Pianoid/*.py` show as modified on every Windows checkout (working copy LF, git wants CRLF) because PianoidBasic has no `.gitattributes` to pin the policy. Pure CRLF noise — `git diff --stat` is empty — but it pollutes `git status` output and risks accidental commits of EOL flips.

### I5. No documented invariant for cross-platform shell wrappers (Risk)

The `.bat`/`.sh` pair model relies on developer discipline. There is no documented rule that "an edit to one of the pair must be mirrored in the other when the change is platform-agnostic". The casing fix in I3 is exactly what slips through.

---

## 3. Recommended Fixes

### F1. Replicate `.gitattributes` to sub-repos (priority: high)

Copy the policy file (with adjustments per repo) to:
- `PianoidCore/.gitattributes`
- `PianoidBasic/.gitattributes`
- `PianoidTunner/.gitattributes`

Then `git add --renormalize .` in each repo (committed as a separate "chore: normalize line endings" commit). The PianoidBasic CRLF noise (I4) disappears as a side-effect.

The four `.gitattributes` files are 95% identical — small variations:
- PianoidTunner: also pin `.json` to LF (npm/Node tooling assumes LF), include `.eslintrc`, `.prettierrc` etc.
- PianoidBasic: pure-Python; minimal — `* text=auto eol=lf` plus binary markers
- PianoidCore: needs `*.bat eol=crlf` + binary markers for `.pyd`, `.so`, `.obj`, `.dll`

### F2. Move venv relocation entirely runtime (priority: high)

The current Linux `setup-pianoid.sh` creates a `PianoidCore/.venv` symlink as on-disk state. Replace with a runtime indirection so the working tree never has a `.venv` symlink committed-style.

Options:
- **Option A — env var:** `setup-pianoid.sh` sets `PIANOID_VENV_DIR=$HOME/.cache/pianoid-venv-<hash>` if NTFS; all build/launch scripts read this var instead of hardcoding `PianoidCore/.venv`. The `.venv` directory inside the repo never exists.
- **Option B — wrapper script:** `setup-pianoid.sh` writes a `PianoidCore/.venv-pointer.txt` (gitignored) containing the real venv path. Build scripts read the pointer.
- **Option C — keep symlink but document explicitly:** Symlink stays but `setup-pianoid.bat` (Windows) starts by deleting `PianoidCore/.venv` if it's a regular file <1KB (heuristic for "stale Linux symlink").

Recommendation: **Option A** — cleanest. Both `build_pianoid_cuda.{bat,sh}` already activate the venv; they just need to honor `PIANOID_VENV_DIR` if set, fall back to `PianoidCore/.venv`.

### F3. Fix `start-pianoid.bat` casing (priority: medium)

```diff
- set "BACKEND_SCRIPT=%MIDDLEWARE_DIR%\backendserver.py"
+ set "BACKEND_SCRIPT=%MIDDLEWARE_DIR%\backendServer.py"
```

Trivial one-liner. Three references in the `.bat` (lines 13, 36, 119).

### F4. Document the cross-platform shell wrapper invariant (priority: low)

Add to `docs/architecture/BUILD_SYSTEM.md`:

> **Invariant:** Every Windows `.bat` shell wrapper has a Linux `.sh` sibling with identical step structure, identical flags, and identical exit semantics. When editing one, audit the other for divergence.
>
> **Pairs:** see the table in `docs/proposals/windows-linux-separation.md`.

---

## 4. Naming / File-Layout Convention

Adopt the following convention going forward:

### Shell wrappers — sibling pairs

| Function | Windows | Linux |
|---|---|---|
| Anything that launches a process or runs a build | `name.bat` | `name.sh` |

When the two are functional siblings, name them identically except for the extension. When they diverge (Windows-only or Linux-only function), prefix or directory-segment the Windows-only one (`win-*.bat`, `tools/windows/*.bat`).

### Python modules

Keep the single-file/single-branch pattern — branch on `sys.platform.startswith("win")` (not `os.name == "nt"`, mixing patterns risks bugs). Helpers for the non-current platform should be entirely lazy (called only inside the matching branch).

Example pattern from `detect_paths.py`:

```python
IS_WINDOWS = sys.platform.startswith("win")
IS_LINUX = sys.platform.startswith("linux")

if IS_WINDOWS:
    # call _find_msvc, _find_windows_sdk, _find_cuda(...), _find_sdl{2,3}(...)
elif IS_LINUX:
    # call _find_gcc_linux, _find_cuda_linux(...), _find_sdl_linux(...)
```

The `_find_*_linux` helpers do not exist in the import scope on Windows because they're never called; importing the module on Windows does not pay any Linux cost.

### C/CUDA sources

Two patterns are acceptable:

1. **Source-level filtering (preferred for whole files):** filter in `setup.py:_discover_sources` (current ASIO pattern: `asio*.cpp`, `Asio*.cpp`, `asiodrivers.cpp` excluded from non-Windows builds).
2. **Preprocessor guards (preferred for small includes):** `#if defined(_WIN32) || defined(_WIN64)` (current `Pianoid.cu` pattern for `<windows.h>`).

Avoid mixing — if a file's body has more than ~10 lines of platform guards, split it into `Foo.cpp` (cross-platform) + `FooWin.cpp` (Windows-only, filtered in `_discover_sources`).

### Documentation

Single tree (`docs/`) with:
- Per-OS prefix table at top of `.claude/CLAUDE.md` (already in place — keep)
- OS-specific guides under `docs/guides/`: `QUICK_START.md` (Windows-default), `LINUX_BUILD.md` (Linux), shared sections cross-reference each other
- Build commands in `BUILD_SYSTEM.md` show both invocations side-by-side (current pattern — keep)

---

## 5. Line-Ending Policy (`.gitattributes`)

Standard policy for all four repos, with per-repo additions:

```gitattributes
# Default: text files stored as LF, checked out using OS-native endings
* text=auto eol=lf

# Windows-only scripts — keep CRLF on every checkout
*.bat   text eol=crlf
*.cmd   text eol=crlf
*.ps1   text eol=crlf

# Lock common text formats to LF explicitly
*.svg   text eol=lf
*.json  text eol=lf
*.yml   text eol=lf
*.yaml  text eol=lf

# Python source: LF (PEP 8 default)
*.py    text eol=lf

# C/C++/CUDA source: LF
*.c     text eol=lf
*.cpp   text eol=lf
*.h     text eol=lf
*.cu    text eol=lf
*.cuh   text eol=lf

# Binary files
*.pdf   binary
*.png   binary
*.jpg   binary
*.jpeg  binary
*.gif   binary
*.ico   binary
*.zip   binary
*.7z    binary
*.tar   binary
*.gz    binary
*.exe   binary
*.dll   binary
*.pyd   binary
*.so    binary
*.o     binary
*.obj   binary
*.wav   binary
*.mp3   binary
*.ogg   binary
*.mp4   binary
```

Per-repo additions:
- **PianoidTunner:** `package.json`, `package-lock.json`, `tsconfig.json` already covered by `*.json eol=lf`; nothing extra needed
- **PianoidBasic:** add `*.npy binary`, `*.pkl binary` if those are committed
- **PianoidCore:** explicit `requirements.txt text eol=lf` is wise (the file is UTF-16 LE — git's auto-detection should mark it binary, but eol=lf protects in case of misclassification). Or `requirements.txt -text` to skip EOL processing entirely.

---

## 6. Alternatives Considered

### A1. Separate Windows / Linux branches

**Rejected.** Maintaining two branches doubles every change, requires constant sync, and degenerates into "Linux branch is 6 months stale" within a quarter. The current single-source approach with platform branches is cheap to maintain because each branch is small.

### A2. Separate top-level directories (`windows/`, `linux/`)

**Rejected.** Would force every commit to choose a directory, doubles import paths, and makes `git log <file>` track only one platform's history. Would also duplicate `setup.py`, `detect_paths.py` — the bulk of the platform-aware code.

### A3. CMake or another cross-platform build system

**Considered.** CMake would replace the dual `.bat`/`.sh` build scripts with one `CMakeLists.txt`. Pros: industry-standard, less duplicated logic. Cons: large rewrite, adds a CMake dependency to install (small but real), and the current `.bat`/`.sh` pair already works. **Defer** — revisit when next major build-system pain hits.

### A4. Use `tox` or `nox` for Python builds

**Rejected for now.** These help with multi-Python testing but don't address the C++/CUDA compile chain, which is the bulk of the platform-divergence cost.

---

## 7. CI Considerations

Currently no CI. If/when added:

- **Windows runner:** `windows-latest` GitHub Actions or self-hosted Windows VM. Run `setup-pianoid.bat` non-interactively (would need `--non-interactive` flag added to the .bat — current version has `pause`s).
- **Linux runner:** `ubuntu-22.04` or `ubuntu-24.04`. Run `setup-packages.sh --all && setup-pianoid.sh` non-interactively.
- Both runners must have CUDA toolkit + GPU. Self-hosted runners for both.
- The `start-pianoid.{bat,sh}` flow opens a browser — not suitable for CI. Add a `pianoid-smoketest.{bat,sh}` that imports `pianoidCuda`, runs `tests/system/test_performance.py`, and exits.

---

## 8. Documentation Sync Strategy

Avoid divergence between `QUICK_START.md` (Windows) and `LINUX_BUILD.md` (Linux):

- **Single source for shared content** — installation prerequisites that apply to both go in `BUILD_SYSTEM.md`, both guides reference it.
- **Per-OS guides** are thin wrappers — clone, install packages, run setup script. The detailed troubleshooting lives in `BUILD_SYSTEM.md` and `STARTUP_TROUBLESHOOTING.md`.
- **Cross-link pattern:** `LINUX_BUILD.md` opens with "For Windows see [QUICK_START.md](QUICK_START.md)" and vice-versa.

---

## 9. Migration Path

Order matters — do these in sequence to avoid an intermediate broken state:

| # | Action | Repo(s) | Risk |
|---|---|---|---|
| 1 | Add `.gitattributes` to PianoidCore, PianoidBasic, PianoidTunner | three sub-repos | None (additive) |
| 2 | `git add --renormalize .` + commit in each repo where dirty CRLF noise remains | three sub-repos | Low (one commit per repo, easy to revert) |
| 3 | Switch venv relocation from on-disk symlink to `PIANOID_VENV_DIR` env var | PianoidInstall (setup-pianoid.sh, setup-pianoid.bat) + PianoidCore (build_pianoid_*.{bat,sh}) | Medium (both build scripts must honor the var consistently) |
| 4 | Fix `start-pianoid.bat` `backendserver.py` → `backendServer.py` | PianoidInstall | None |
| 5 | Document cross-platform shell wrapper invariant in BUILD_SYSTEM.md | PianoidInstall | None |

Do NOT bundle these into one commit — each is independently reviewable and revertible.

---

## 10. Open Questions

- **Q1:** Does the `start-pianoid.bat` (which currently has filename-casing inconsistency I3) work on the user's machine today? Yes (NTFS case-insensitive). Should the fix happen now or wait? Recommend now.
- **Q2:** Is there appetite for a `pianoid-smoketest.{bat,sh}` for Step 7 (CI)? Out of scope for this proposal — flag for future work.
- **Q3:** Should we keep both `.bat`/`.sh` build scripts in PianoidCore, or move all build logic to a single `build_pianoid_cuda.py` invoked by thin shell wrappers? Defer — the current sibling-pair model works and the duplication is minimal (~200 lines each).

---

## 11. Acceptance

This proposal is a recommendation, not a plan of record. Awaiting user decisions on:
- F1 (replicate `.gitattributes`): proceed?
- F2 (move venv relocation runtime): proceed? Option A/B/C?
- F3 (fix `start-pianoid.bat` casing): proceed?
- F4 (document invariant): proceed?

If accepted, will be tracked under `docs/development/WORK_IN_PROGRESS.md` and broken into per-fix dev sessions.
