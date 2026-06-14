# Proposal: setup-packages should detect + (if needed) reinstall the NVIDIA DISPLAY DRIVER

- **Author:** dev-drvinstall
- **Date:** 2026-06-10
- **Status:** ✅ IMPLEMENTED + SHIPPED + ARCHIVED 2026-06-10. setup-packages.bat option 7 (driver detect + chocolatey-primary reinstall + pnputil uninstall-old-first + guided Safe-Mode-DDU fallback) + check-driver-health.ps1 + install-nvidia-driver.ps1 + setup-dev.ps1 warn shipped to PianoidInstall master `ccf1b0c → 04a3080 → 60fcbeb`. User-approved mechanism 🅰 (chocolatey) + "uninstall old drivers before installing fresh one". Feature branch deleted (code on origin/master). Archived to `docs/proposals/archive/`.
- **Scope:** Windows `.ps1` / `.bat` only. NO CUDA/C++ build. References (read-only) `diagnose-cuda.ps1` (dev-nvmldiag) + `check-cuda.ps1` (dev-cudaguard) — does not edit them.

> **USER DECISION (2026-06-10, authoritative):** *"setup-packages runs elevated anyway. Add reinstall-driver as a SEPARATE OPTION (not in the main pipeline), prompt the user on risks when run, but run automatically, without any other user involvement."* — then, on the mechanism A/B, the user picked **🅰 AUTOMATED via chocolatey**.
> The propose-first gate is LIFTED. **What shipped** (a SEPARATE opt-in, prompt-once-then-automatic, chocolatey-primary):
> - `check-driver-health.ps1` — the "if needed" detector (exit 0/10/20). [SHIPPED, verified, 19/19 tests]
> - `install-nvidia-driver.ps1` — **clean reinstall: uninstall-old-first, then chocolatey-primary, with a guided fail-safe**:
>   - **STEP 0 — UNINSTALL the stale display driver first** (the confirmed Dmitri root-cause fix: a plain install-over leaves the old package, e.g. `nv_dispig.inf`, which can block the `nvlddmkm` service → NVML "Not Found"). Mechanism = native **`pnputil`**: `pnputil /enum-drivers` → parse → for each NVIDIA **Display-adapter-class** (`{4d36e968-e325-11ce-bfc1-08002be10318}`) package, `pnputil /delete-driver oemNN.inf /uninstall /force`. Scoped to the Display class ONLY (does NOT touch NVIDIA audio/USB-C/PhysX). Best-effort (never aborts). *Why pnputil, not `-clean`/DDU:* the choco package exposes **no** clean/`-clean` package param (silentArgs hardcoded `-s -noreboot`), and DDU's full clean wants Safe Mode (not cleanly automatable) — pnputil is the native, dependency-free, precisely-scoped removal.
>   - **Tier 1** = ensure chocolatey (bootstrap if missing) → `choco install nvidia-display-driver -y --no-progress` (silent; package silentArgs `-s -noreboot`; success exit codes `{0,1605,1614,1641,3010}`, 3010 = reboot-required).
>   - **Tier 2** = guided fail-safe (open the NVIDIA App / driver page + print the fix, incl. **Safe-Mode DDU** for a deep clean). NOTE: because STEP 0 uninstalls first, a failed install can leave the box on the Windows basic display driver until a manual install + reboot — the risk prompt + Tier-2 guidance both call this out.
>   - Single risk-ack prompt (skippable by a caller via `-Acknowledged`; now warns about the uninstall-first / NO-driver-if-install-fails risk), `-NoReboot`/`-Force`/`-DryRun`, reuses `check-driver-health.ps1`, post-verify via `diagnose-cuda.ps1`. The earlier NVIDIA-AjaxDriverService API tier was **dropped** (choco is the chosen mechanism). LOGIC-VERIFIED only on the dev box (the `-DryRun` plan prints the exact `pnputil /delete-driver …` + `choco install …` flow and executes nothing — NO real uninstall/install/reboot here); AST clean; 24/24 logic tests incl. enum-parse/Display-class-filter + safety-invariant greps (DryRun guards both the delete and the install; uninstall precedes install; reboot gated by `-not $DryRun`). The REAL clean-install is validated by the user on the broken box.
> - `setup-packages.bat` — NEW **separate option 7** "Reinstall NVIDIA DISPLAY DRIVER" (NOT in the 1–5 toolkit pipeline).
> - `install-gpu-driver.bat` — standalone menu updated to the new param surface.
> - `setup-dev.ps1` — NEW **non-blocking post-toolkit driver-health WARN** (mirrors the Linux `setup-packages.sh` `check_nvidia_driver`): after the CUDA toolkit installs, it runs `check-driver-health.ps1 -Quiet` and, on exit 10/20, prints the toolkit-vs-driver message + points at option 7. Best-effort (try/catch, never aborts setup); pure-ASCII (no-BOM caveat). This is the only `setup-dev.ps1` change — the reinstall itself stays the separate option, NOT the pipeline.
>
> §3 below is the option analysis that led to the decision: Option A (winget) NOT feasible; **Option B's choco sub-path is what shipped as Tier 1** (a separate opt-in); Options C/D survive as the Tier-2 guided fail-safe.

---

## 1. Problem (the real incident)

On a user's box the CUDA / NVML error **persisted after "driver reinstallation via setup-packages."**
Root cause of the *persistence*: `setup-packages` does **not** reinstall the NVIDIA **display driver**.
It installs the CUDA **Toolkit** (+ Python / VS Build Tools / SDL / Node), and `nvml.dll` /
`nvcuda.dll` are **display-driver** components (they live in `C:\Windows\System32`, version-locked to
the installed driver). A toolkit reinstall can never fix them.

This is already documented inside `diagnose-cuda.ps1` §8, verbatim:

> *"Re-running setup-packages (the CUDA TOOLKIT) does NOT reinstall the display driver and will NOT
> fix nvml.dll / nvcuda.dll — those are DISPLAY-DRIVER files, not toolkit files. That is why 'driver
> reinstallation via setup-packages' did not help: it never touched them."*

So the user's mental model ("setup-packages reinstalls the driver") is reasonable but wrong, and the
tool does nothing to correct it at install time. **The ask:** make `setup-packages` *detect* a
missing/broken/mismatched display driver and *(re)install it "if needed."*

### What `setup-packages` actually installs today (confirmed by reading the code)

`setup-packages.bat` (menu 1–6) → `setup-dev.ps1 [-ForcePython|-ForceCUDA|-ForceNode|-ForceReinstall]`.
`setup-dev.ps1` installs, in order: Python → VS 2022 Build Tools → SDL2 → SDL3 → Node.js →
**CUDA Toolkit** (`Ensure-CUDA` → winget `Nvidia.CUDA` / direct installer). **There is no display-driver
step anywhere.** (`setup-packages.sh`, the Linux companion, is the same — toolkit, not driver — but it
already *warns*; see §2.3.)

---

## 2. What already exists (reuse-first)

This task is **mostly wiring**, not greenfield. Three relevant assets already live in the repo root.

### 2.1 Detection — already comprehensive (`diagnose-cuda.ps1`, dev-nvmldiag)

`diagnose-cuda.ps1` is a mature, **READ-ONLY** (`exit 0` always), graceful-degradation diagnostic.
It already detects everything "if needed" requires:

| Section | Detects |
|---|---|
| §1 | NVIDIA GPU present (WMI `Win32_VideoController`) + driver version |
| §2 | NVIDIA kernel driver service `nvlddmkm` present/started (driver installed at OS level) |
| §3 | `nvml.dll` MISSING from System32 / present in DriverStore only / **version-mismatched** vs driver |
| §3d | `nvcuda.dll` MISSING / version-mismatched vs driver |
| §4 | `nvidia-smi` located + run; exact NVML error captured |
| §4b | shadowing / multi-version `nvml`/`nvcuda` copies on PATH |
| §7 | cupy device query (the engine-level runtime check) |
| §8 | **a synthesised VERDICT** + recommended fix, with precedence (driver-library-problem outranks cupy-blame) |

Its §8 verdict categories map cleanly onto "does the driver need attention?":
`no GPU` / `no driver (nvlddmkm)` / `DRIVER LIBRARY PROBLEM (mismatch/shadow)` /
`NVML broken (missing)` / `cupy runtime fail` / `low-SM` / `healthy`.

**Gap:** `diagnose-cuda.ps1` emits its verdict as **human-readable console text** + a `SUMMARY: OK=.. WARN=..`
count line. It exposes **no machine-readable verdict** and **no caller-branchable exit code** (it is a
report by design). So `setup-packages` cannot today call it and branch on "driver needs reinstall."

### 2.2 A runnable gate — `check-cuda.ps1` (dev-cudaguard)

`check-cuda.ps1` is the pre-launch gate `start-pianoid.bat` calls. It returns exit codes (`0` proceed /
`30` user-cancelled) but only answers **device-present?** + **SM-count<60?** via cupy→nvidia-smi. It does
**not** check the driver-library health (missing/mismatched `nvml`/`nvcuda`). So it is the right *pattern*
(best-effort, exit-code contract, `-Auto` timed pop-up) but not the right *check* for this task.

### 2.3 A driver INSTALLER — already written but unwired and buggy (`install-nvidia-driver.ps1`)

`install-nvidia-driver.ps1` (+ `install-gpu-driver.bat` menu wrapper) already exists. It:

1. `Assert-Admin`
2. `Get-GPUInfo` (WMI; throws if no NVIDIA GPU)
3. `Install-DriverViaWinget` → `winget install --id NVIDIA.GeForceExperience …`
4. on failure → `Install-DriverManual` (opens `https://www.nvidia.com/drivers`, `Read-Host` "press Enter")
5. `Test-Installation` (nvidia-smi / WMI)
6. optional `Restart-Computer`

**Three defects make it unsuitable as-is:**

- **(BUG) `winget install NVIDIA.GeForceExperience` does not install a driver.** GeForce Experience is a
  *companion app*, not the driver — and it is **discontinued** (replaced by the NVIDIA App). On this
  machine `winget search` confirms **no** `NVIDIA.GeForceExperience`, no "NVIDIA App", **no GeForce
  display-driver package at all** on the `winget` source (only `Nvidia.CUDA` [toolkit], `GeForceNow`,
  `PhysX`, `FrameView`, firmware updaters). So step 3 silently fails on every machine and always falls
  to manual. **winget is not a viable silent display-driver mechanism.**
- **No detection gate.** It *always* tries to install — it is not "if needed." Wiring it into
  `setup-packages` unconditionally would reinstall the driver on every run (risky + slow + needless reboots).
- **Interactive `Read-Host` / `Restart-Computer` prompts** are fine for a human at a console but unsafe to
  call non-interactively (e.g. from an `-Auto` shortcut) — they hang.

### 2.4 ★ The Linux side already does the safe thing — and it is the model

`setup-packages.sh` → `install_cuda()` → **`check_nvidia_driver()`**: after the toolkit installs, it
checks `/proc/driver/nvidia/version` (or `nvidia-smi`), and if the driver is absent it prints the
**toolkit-vs-driver distinction** (verbatim: *"The CUDA toolkit installs nvcc/libcudart but does NOT
install the kernel driver"*) plus the distro-specific install command (`ubuntu-drivers autoinstall`,
`apt install nvidia-driver-560`, …) + "Reboot after install."

**The Windows `setup-dev.ps1` has no equivalent. That asymmetry is the bug.** The lowest-risk fix is to
give Windows the *same* detect-and-guide behaviour Linux already ships.

---

## 3. The install MECHANISM — options, feasibility, risk, recommendation

Auto-installing a GPU driver is the genuinely risky part: it needs **admin elevation**, the **correct
driver for the exact GPU**, a **silent-install** path, usually a **reboot**, and a **fail-safe** so a bad
install never leaves the display worse. Below are the realistic mechanisms, each rated.

### Option A — winget silent install ❌ NOT FEASIBLE (for the *driver*)

`winget install <driver>` `-s`. **Verdict: not possible.** Empirically (this machine, 2026-06-10) the
`winget` source has **no GeForce display-driver package** — `Nvidia.CUDA` is the *toolkit* (and currently
resolves to 13.3, which Pianoid rejects). The `NVIDIA.GeForceExperience` ID the current script uses
**doesn't exist** in the catalog. Microsoft Store's "NVIDIA Control Panel" is the control-panel app, not
the driver. So winget cannot reinstall the display driver. (It *can* reinstall the CUDA *toolkit* — but
that is what `setup-packages` already does and is exactly what does NOT fix `nvml`/`nvcuda`.)

*Risk if forced anyway:* installs the wrong thing (a companion app / toolkit) and reports false success.

### Option B — NVIDIA silent installer (download the right driver + run `-s`) ⚠️ FEASIBLE BUT HARD/RISKY

Download the GPU-specific driver `.exe` and run it silently (`setup.exe -s -noreboot`, optionally
`-clean`). **The hard, fragile part is picking the correct driver URL for the exact GPU.** NVIDIA exposes
**no clean public API** mapping GPU → driver-download-URL; the official path is a web form
(`nvidia.com/Download/index.aspx`) whose back-end (`gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php`)
takes opaque numeric `psid`/`pfid` product IDs that themselves must be scraped from another endpoint.
This is brittle (NVIDIA changes it without notice), can resolve the **wrong** driver (laptop vs desktop,
Studio vs Game-Ready, wrong series), and a wrong/interrupted silent install **can break the display
driver** (black screen until Safe-Mode recovery). It also still needs elevation + a reboot.

*Feasible* (third-party tools like TinyNvidiaUpdateChecker do exactly this), but it carries the **highest
blast radius** and the most maintenance. If pursued, it MUST be: admin-gated, GPU-confirmed, version-shown-
and-confirmed before download, `-noreboot` (we control the reboot prompt), and verified-after via the §2.1
diagnostic with a documented Safe-Mode/DDU rollback if the post-check fails.

### Option C — detect + GUIDE (semi-automated) ✅ SAFE, ROBUST — **RECOMMENDED (build now)**

Detect the driver state; when it needs attention, **tell the user precisely what is wrong and exactly what
to do**, and **open the right page / launch the existing assisted installer on confirmation**. This is what
the Linux side already does and what `diagnose-cuda.ps1` §8 already prints. Concretely:

- After the toolkit step (and/or as a menu option), run the **driver-health detection** (§4).
- If `OK` → say so, do nothing.
- If `needs attention` → print the toolkit-vs-driver explanation + the verdict + the fix, and **offer**:
  *"Open the NVIDIA driver download page now? (y/N)"* → `Start-Process https://www.nvidia.com/Download/index.aspx`
  (and, where we can, the NVIDIA App page, the modern GUI installer). No silent install, no reboot we
  trigger, **never leaves the system worse** (it only opens a browser / launches the official GUI installer
  the user drives).

*Risk: minimal.* Worst case it opens a browser tab. It directly fixes the incident (the user now KNOWS the
toolkit reinstall won't help and is handed the real fix).

### Option D — hybrid: detect + confirm + **assisted** install ✅ RECOMMENDED as the opt-in upgrade of C

Option C, plus: on explicit user confirmation, **launch the (fixed) `install-nvidia-driver.ps1`** — but
with its winget-GFE bug removed and the manual path as the primary route (download GUI installer / open
NVIDIA App), admin-elevation handled, and the reboot **prompted, not forced**. This reuses the existing
script rather than re-implementing, keeps the human in the loop for every irreversible step, and verifies
after via the §2.1 diagnostic.

### Recommendation

**Ship Option C now (detect + guide), structured so Option D is a thin opt-in on top** (re-use the fixed
`install-nvidia-driver.ps1` as the "assisted install" the guide can launch on `y`). **Do NOT ship Option B
(fully-automated silent download+install) unless the user explicitly asks** — its GPU→URL fragility and
display-breaking blast radius are not worth it when the official NVIDIA App GUI installer is one click away
and the detection already pinpoints the problem. Option A is off the table (no winget driver package).

---

## 4. Detection design ("if needed") — how `setup-packages` decides

We need a **caller-branchable** driver-health check (the existing diagnostic prints text; the existing gate
checks only device/SM). Two ways to get it, both reuse the existing logic rather than re-deriving it:

- **(Preferred) A small shared helper `check-driver-health.ps1`** (NEW, ~80 LOC) that runs the *same*
  driver-side probes `diagnose-cuda.ps1` already encodes — GPU present (WMI), `nvlddmkm` service, System32
  `nvml.dll`/`nvcuda.dll` present + version vs the WMI driver version (the exact `Get-NvDriverShort`
  last-5-digit normalisation), and an `nvidia-smi` NVML-error check — and **returns a machine-readable
  verdict** via exit code:
  - `0` driver healthy → no action
  - `10` driver needs attention (missing `nvlddmkm` / missing-or-mismatched `nvml`/`nvcuda` / nvidia-smi
    NVML error) → `setup-packages` surfaces guidance (Option C)
  - `20` no NVIDIA GPU at all → distinct message ("install a card / check Device Manager")
  - `0` (best-effort) on any probe failure → never block install
  This is best-effort + `exit`-coded, exactly like `check-cuda.ps1`/`check-running-servers.ps1`. It does
  **not** duplicate the cupy/SM logic (that is `check-cuda.ps1`'s job) — only the **driver-library** health
  the other two don't cover.

- **(Alternative, no new file) ask dev-nvmldiag to add a `-Quiet`/`-VerdictOnly` switch to
  `diagnose-cuda.ps1`** that prints one machine-readable verdict token (e.g. `VERDICT=driver-library-problem`)
  and/or sets a verdict exit code, then `setup-packages` parses/branches on that. This avoids a second copy
  of the detection but **requires editing another agent's locked file** — so it is a coordination item, not
  something dev-drvinstall does directly.

**dev-drvinstall recommends the shared helper** (`check-driver-health.ps1`): it is self-contained, needs no
cross-agent edit, mirrors the established sibling-helper pattern, and keeps the rich `diagnose-cuda.ps1`
report intact as the deep-dive the helper can point the user to ("run `diagnose-cuda.ps1` for full detail").
The small duplication of the normalise-and-compare logic is the lesser evil vs. coupling two agents' files;
a future refactor can dot-source a single shared function once both land.

---

## 5. Wiring into `setup-packages`

- **`setup-dev.ps1`** — after `Ensure-CUDA` returns (the toolkit is in), call the driver-health check and,
  if it reports "needs attention," print the **toolkit-vs-driver guidance** (mirroring `setup-packages.sh`
  `check_nvidia_driver()`), with the Option-C "open the download page?" offer. This is the **primary fix**:
  the moment a user reinstalls the toolkit, they are told the driver is the real problem.
  - *Authority (P1):* `setup-dev.ps1` already owns the install flow; adding a post-CUDA check is within its
    existing concern (it already calls `Ensure-*`). It does **not** take over the driver — it detects + guides.
  - Must stay **pure-ASCII** (the file is UTF-8 no-BOM; see BUILD_SYSTEM.md encoding caveat).
- **`setup-packages.bat`** — add a menu entry, e.g. **"7. Check / reinstall NVIDIA display driver"**, that
  runs the driver-health check and, on "needs attention," offers to launch the (fixed) assisted installer
  (Option D). Gives the user a *direct* "fix my driver" affordance distinct from the toolkit options.
- **`install-nvidia-driver.ps1`** — fix the winget-GFE bug + add a leading detection gate + make the
  prompts safe under a `-Auto`/`-NoPrompt` switch (no `Read-Host`/forced reboot when non-interactive). This
  is the "assisted install" Options C/D launch.

---

## 6. Scope — build-now-safe vs needs-user-approval

| Item | Risk | Status |
|---|---|---|
| `check-driver-health.ps1` (NEW detection helper, exit-coded, READ-ONLY) | none (read-only) | **BUILD NOW** |
| `setup-dev.ps1` post-CUDA detect + **guidance** (Option C; mirror Linux) | none (prints + offers browser) | **BUILD NOW** |
| `setup-packages.bat` menu entry → detect + guide | none | **BUILD NOW** |
| Fix `install-nvidia-driver.ps1` winget-GFE bug → manual/NVIDIA-App primary + detection gate + `-Auto`-safe prompts | low (guides; opens GUI installer) | **BUILD NOW** (no silent install) |
| Pester/PS unit tests for the detection helper (mock WMI/file/nvidia-smi) | none | **BUILD NOW** |
| **Fully-automated silent download + `-s` install (Option B)** | **HIGH** (wrong-driver / display-break / GPU→URL fragility / forced reboot) | **HELD — needs explicit user approval of the mechanism** |

**dev-drvinstall builds the BUILD-NOW rows and STOPS before Option B**, per the propose-first directive.

---

## 7. Fail-safe principles (apply to any install path)

1. **Admin-gate** every install action (`Assert-Admin`); never half-elevate.
2. **Confirm the GPU** (WMI NVIDIA present) before any driver action; abort cleanly if none.
3. **Never trigger a reboot silently** — always prompt; under `-Auto`, skip the reboot and print "reboot
   required."
4. **Idempotent:** if the driver is already healthy (detection = `0`), do nothing.
5. **Verify after** via the §2.1 diagnostic; if the post-check still fails, surface the DDU-in-Safe-Mode
   recovery (already written in `diagnose-cuda.ps1` §8) — never leave the user worse than before.
6. **Best-effort detection never blocks** the rest of `setup-packages` (any probe failure → proceed).

---

## 8. Open questions for the user (the decision gate)

1. **Mechanism:** approve **Option C (detect + guide) + Option D (assisted, opt-in)** as the shipped
   behaviour? Or do you want the **fully-automated Option B** silent download+install too (accepting the
   wrong-driver / display-break / forced-reboot blast radius)?
2. **Detection plumbing:** OK with the **new `check-driver-health.ps1` helper** (no cross-agent edit), or
   would you rather **coordinate a `-VerdictOnly` switch into `diagnose-cuda.ps1`** (dev-nvmldiag's file)?
3. **Where to surface it:** post-CUDA in `setup-dev.ps1` (automatic, every toolkit install) **and** a
   dedicated `setup-packages.bat` menu entry — both? (recommended) Or only the menu entry?
4. **NVIDIA App vs nvidia.com:** the modern GUI installer is the **NVIDIA App**. For the guided path, open
   the NVIDIA App download page (preferred GUI installer) and/or the classic `nvidia.com/Download` form —
   which do you want the "open the page" action to point at?

---

## Investigation history

- Live-machine feasibility probes + code reads recorded in
  `docs/development/logs/dev-drvinstall-2026-06-10-112335.md`.
- Detection logic referenced (read-only) from `diagnose-cuda.ps1` (dev-nvmldiag) and `check-cuda.ps1`
  (dev-cudaguard); the Linux detect+guide precedent is `setup-packages.sh` `check_nvidia_driver()`.
