#!/usr/bin/env python
"""build_pianoid.py — the BUILD_SYSTEM.md build discipline as ONE scripted call (minimize-opus row 6).

`docs/architecture/BUILD_SYSTEM.md` "Canonical Install / Rebuild" is the single source of truth for
the Pianoid CUDA rebuild. Hand-typing that procedure has burned multiple sessions (a destructive
`cmd //c` gate-stall mid-uninstall; a `pip install` that silently reinstalled a STALE `.pyd`; a
`--release`-not-`--both` that left the debug `.pyd` stale). This wrapper encodes the documented
procedure once so the agent runs it in a single call instead of several fragile turns:

  STEP 1  PRE-CHECK + STOP the locked-binary holder
            • find Python processes holding pianoidCuda.<pyd|so>  → emit [BUILD-PRECHECK] holders=...
            • STOP them FIRST (a running backend → `[WinError 5]` on the uninstall → bricked venv):
                - PREFERRED: launcher REST  POST http://127.0.0.1:3001/api/stop-backend
                - ELSE: PID-targeted kill (taskkill //F //PID <pid> / kill -9)  — NEVER //IM python.exe
  STEP 2  BUILD (detached): Start-Process -WindowStyle Hidden cmd /c
            set VIRTUAL_ENV=<CORE>\\.venv && cd /d <CORE> && <CORE>\\build_pianoid_cuda.bat <variant> > <log>
            (absolute bat path after the cd; Linux = build_pianoid_cuda.sh, no Start-Process needed)
  STEP 2b POLL the build log until it shows "[SUCCESS] Build completed." (ok) or the process exits.
  STEP 3  VERIFY: grep the freshly-installed `.pyd`/`.so` for a caller-supplied marker string
            (BUILD_SYSTEM.md "Post-build verification": match count must be > 0, else a stale pyd).

It NEVER falls back to `pip install ... pianoid_cuda/` — that is the documented stale-`.pyd` trap.

What STAYS with Opus (proposal §2.3 "Build-failure diagnosis STAYS Opus"): if the build does not
succeed, this script DETECTS the failure (exit code, tail of the log, e.g. `3221225794` = 0xC0000142)
and emits `[BUILD FAIL]` with the evidence — it does NOT pick the recovery. Opus reads the tail and
applies the right documented recovery (0xC0000142 → clear pip-build-env; linker → detect_paths; …).

Usage:
    python build_pianoid.py [--heavy|--light] [--both|--release|--debug]
        [--core <PianoidCore abs path>]   # default: <repo-root>/PianoidCore
        [--log  <build log path>]         # default: <tmp>/build.log  (D:\\tmp on Win if present)
        [--marker "<string from your edit>"]   # grep the built binary for this (verify step)
        [--no-stop]      # skip STEP 1 stop-holder (use when you KNOW nothing holds the pyd)
        [--timeout <s>]  # max seconds to poll for [SUCCESS] (default 1200)
        [--poll <s>]     # poll interval (default 3)
        [--dry-run]      # print the exact launch command + plan, run nothing

Default variant = `--heavy --both` (release + debug), exactly as BUILD_SYSTEM.md mandates; `--release`
leaves the debug `.pyd` stale and is only for an explicit release-only request.

Exit codes: 0 = build reached "[SUCCESS] Build completed." AND (if --marker given) the marker is in
the binary; 2 = build failed / timed out / marker absent (Opus diagnoses); 1 = internal/usage error.
"""
from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

IS_WINDOWS = platform.system() == "Windows"

# The string the build script prints on success (build_pianoid_cuda.{bat,sh} both echo this).
SUCCESS_MARKER = "[SUCCESS] Build completed."
# The launcher's graceful-stop endpoint (BUILD_SYSTEM.md STEP 1 "PREFERRED").
STOP_BACKEND_URL = "http://127.0.0.1:3001/api/stop-backend"
# Windows 0xC0000142 STATUS_DLL_INIT_FAILED — a recovery class Opus must read, NOT a pip fallback.
EXIT_DLL_INIT_FAILED = 3221225794


# --------------------------------------------------------------------------------------------------
# Binary names + paths (per BUILD_SYSTEM.md; .pyd on Windows, .so on Linux)
# --------------------------------------------------------------------------------------------------
def pyd_filename() -> str:
    """The release CUDA extension filename for this OS (the one the build installs + a backend holds)."""
    return "pianoidCuda.cp312-win_amd64.pyd" if IS_WINDOWS else "pianoidCuda.cpython-312-x86_64-linux-gnu.so"


def installed_binary(core: Path) -> Path | None:
    """Locate the installed release extension under the venv site-packages, or None if absent.

    BUILD_SYSTEM.md "Venv Location": always <CORE>/.venv (Scripts/ on Win, bin/ on Linux). We glob
    so a differing ABI tag still matches; returns the first hit (there is one release variant).
    """
    if IS_WINDOWS:
        site = core / ".venv" / "Lib" / "site-packages"
        pattern = "pianoidCuda*.pyd"
    else:
        # Linux libdir is python3.X under lib/ (per CLAUDE.md venv interpreter note).
        site = core / ".venv" / "lib"
        pattern = "**/pianoidCuda*.so"
    if not site.exists():
        return None
    hits = sorted(site.glob(pattern))
    return hits[0] if hits else None


# --------------------------------------------------------------------------------------------------
# STEP 1 — holder discovery + stop (each primitive is small + monkeypatchable; tests mock these)
# --------------------------------------------------------------------------------------------------
def find_holders(core: Path) -> list[int]:
    """PIDs of processes holding the CUDA extension open.

    Windows: `tasklist /M <pyd>` lists the image+PID of every process with the module loaded.
    Linux:   `lsof <.../pianoidCuda*.so>` lists holders. Read-only discovery; never kills here.
    Returns a sorted unique PID list (empty if nothing holds it / the tool is unavailable).
    """
    if IS_WINDOWS:
        proc = subprocess.run(
            ["tasklist", "/M", pyd_filename(), "/FO", "CSV", "/NH"],
            capture_output=True, text=True,
        )
        pids: set[int] = set()
        for line in proc.stdout.splitlines():
            # CSV row: "image","PID","modules"  — the PID is the 2nd quoted field.
            parts = [p.strip().strip('"') for p in line.split('","')]
            if len(parts) >= 2 and parts[1].isdigit():
                pids.add(int(parts[1]))
        return sorted(pids)
    # Linux
    binary = installed_binary(core)
    if binary is None or not shutil.which("lsof"):
        return []
    proc = subprocess.run(["lsof", "-t", str(binary)], capture_output=True, text=True)
    pids = set()
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.add(int(line))
    return sorted(pids)


def stop_backend_via_launcher(timeout: float = 8.0) -> bool:
    """POST the launcher's graceful stop-backend endpoint. True if it answered 2xx, else False.

    This is the PREFERRED stop (no PID hunt). A non-running launcher / connection refused → False,
    and the caller falls back to PID-targeted kills.
    """
    try:
        req = urllib.request.Request(STOP_BACKEND_URL, method="POST", data=b"")
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — fixed localhost URL
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def kill_pid(pid: int) -> bool:
    """Force-kill exactly this PID (never by image name). True on success.

    BUILD_SYSTEM.md STEP 1: `taskkill //F //PID <pid>` — only the specific PID, NEVER //IM python.exe
    (a blanket image kill takes out MCP servers / Claude Code itself).
    """
    if IS_WINDOWS:
        proc = subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, text=True)
        return proc.returncode == 0
    proc = subprocess.run(["kill", "-9", str(pid)], capture_output=True, text=True)
    return proc.returncode == 0


def stop_holders(core: Path) -> dict:
    """STEP 1: stop whatever holds the .pyd. Launcher graceful-stop FIRST, then PID-kill stragglers.

    Returns {'initial': [...], 'launcher_stopped': bool, 'killed': [...], 'remaining': [...]}.
    A non-empty 'remaining' means the uninstall will likely fail [WinError 5] — the caller treats
    that as a hard stop (do NOT start a destructive --heavy build against a held binary).
    """
    initial = find_holders(core)
    result = {"initial": initial, "launcher_stopped": False, "killed": [], "remaining": []}
    if not initial:
        return result

    # PREFERRED path: ask the launcher to stop the backend gracefully.
    if stop_backend_via_launcher():
        result["launcher_stopped"] = True
        # Give the process a moment to release the module, then re-check.
        time.sleep(2)

    # Kill any PID still holding the binary (PID-targeted only).
    for pid in find_holders(core):
        if kill_pid(pid):
            result["killed"].append(pid)
    result["remaining"] = find_holders(core)
    return result


# --------------------------------------------------------------------------------------------------
# STEP 2 — assemble + launch the DETACHED build (exactly the BUILD_SYSTEM.md form)
# --------------------------------------------------------------------------------------------------
def build_script(core: Path) -> Path:
    """Absolute path to build_pianoid_cuda.{bat,sh} under <CORE> (invoked by absolute path, L-2)."""
    return core / ("build_pianoid_cuda.bat" if IS_WINDOWS else "build_pianoid_cuda.sh")


def build_command(core: Path, heavy: bool, variant: str, log: Path) -> list[str]:
    """Build the EXACT detached launch argv documented in BUILD_SYSTEM.md STEP 2.

    Windows (agent context — detached, required):
        Start-Process -WindowStyle Hidden -FilePath cmd.exe -ArgumentList
          '/c','set "VIRTUAL_ENV=<CORE>\\.venv" && cd /d <CORE> && <CORE>\\build_pianoid_cuda.bat <flags> > <log> 2>&1'
      We invoke that via powershell.exe so the whole thing is one detached process. The bat is
      ABSOLUTE (a bare name after `cd /d` = "not recognized", L-2); VIRTUAL_ENV is set EXPLICITLY to
      <CORE>\\.venv (NOT empty — empty-but-defined sends the install to the system python).
    Linux (any context): the .sh runs directly with output redirected; no Start-Process needed.
    """
    heavy_flag = "--heavy" if heavy else "--light"
    bat = build_script(core)
    if IS_WINDOWS:
        venv = core / ".venv"
        inner = (
            f'set "VIRTUAL_ENV={venv}" && cd /d {core} && '
            f'"{bat}" {heavy_flag} {variant} > "{log}" 2>&1'
        )
        ps = (
            f"Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' "
            f"-ArgumentList '/c',{_ps_single_quote(inner)} -PassThru -Wait | "
            f"ForEach-Object {{ $_.ExitCode }}"
        )
        return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps]
    # Linux: run the .sh, redirecting combined output to the log via the shell.
    return ["bash", "-lc", f'"{bat}" {heavy_flag} {variant} > "{log}" 2>&1']


def _ps_single_quote(s: str) -> str:
    """Single-quote a string for PowerShell (double any embedded single quotes)."""
    return "'" + s.replace("'", "''") + "'"


def launch_build(cmd: list[str], log: Path) -> subprocess.Popen:
    """Start the build command. Returns the Popen handle (the wrapper waits on it via poll).

    Output is redirected by the command itself (`> <log> 2>&1` / Start-Process redirection inside the
    cmd /c), so we don't capture here; we poll the log file. The log's parent is created first.
    """
    log.parent.mkdir(parents=True, exist_ok=True)
    # Truncate any prior log so the poller can't read a stale [SUCCESS] from a previous build.
    log.write_text("", encoding="utf-8")
    return subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# --------------------------------------------------------------------------------------------------
# STEP 2b — poll the log for success / the process for exit
# --------------------------------------------------------------------------------------------------
def read_log_tail(log: Path, n: int = 40) -> str:
    """Last `n` lines of the build log (for the [BUILD FAIL] evidence Opus reads). Safe if absent."""
    if not log.exists():
        return ""
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-n:])


def poll_until_done(proc: subprocess.Popen, log: Path, timeout: float, interval: float) -> dict:
    """Poll the log + process until [SUCCESS], process exit, or timeout.

    Returns {'success': bool, 'exit_code': int|None, 'timed_out': bool, 'log_had_success': bool}.
    'success' is True ONLY when the log shows the SUCCESS_MARKER (a clean exit code without the
    marker is NOT trusted — the build script prints the marker as its last word on success).
    """
    deadline = time.monotonic() + timeout
    while True:
        log_text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
        had_success = SUCCESS_MARKER in log_text
        exit_code = proc.poll()

        if had_success:
            # Let the process wind down, but don't hang forever on it.
            try:
                exit_code = proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                exit_code = proc.poll()
            return {"success": True, "exit_code": exit_code, "timed_out": False,
                    "log_had_success": True}

        if exit_code is not None:
            # Process exited without printing the success marker → a real failure.
            return {"success": False, "exit_code": exit_code, "timed_out": False,
                    "log_had_success": False}

        if time.monotonic() >= deadline:
            return {"success": False, "exit_code": None, "timed_out": True,
                    "log_had_success": had_success}

        time.sleep(interval)


# --------------------------------------------------------------------------------------------------
# STEP 3 — grep-verify the freshly-built binary for the caller's marker
# --------------------------------------------------------------------------------------------------
def verify_marker(core: Path, marker: str) -> dict:
    """BUILD_SYSTEM.md "Post-build verification": the installed binary must contain `marker`.

    Reads the binary bytes and searches for the marker (latin-1 encoded) — the equivalent of
    `grep -a "<string>" <pyd>`; match count must be > 0, else a stale cached pyd was installed.
    Returns {'binary': str|None, 'found': bool}.
    """
    binary = installed_binary(core)
    if binary is None:
        return {"binary": None, "found": False}
    data = binary.read_bytes()
    needle = marker.encode("latin-1", errors="ignore")
    return {"binary": str(binary), "found": needle in data}


# --------------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------------
def default_log_path() -> Path:
    """BUILD_SYSTEM.md uses D:\\tmp\\build.log on Windows when present; else the system temp dir."""
    if IS_WINDOWS and Path("D:/tmp").exists():
        return Path("D:/tmp/build.log")
    import tempfile
    return Path(tempfile.gettempdir()) / "build.log"


def run(core: Path, heavy: bool, variant: str, log: Path, marker: str | None,
        do_stop: bool, timeout: float, interval: float,
        printer=print) -> int:
    """Execute the full STEP 1→3 flow. Returns the process exit code (0 ok / 2 fail)."""
    printer(f"[BUILD-PRECHECK] {common.iso_utc()} core={core} variant={('--heavy' if heavy else '--light')} {variant}")

    # STEP 1 — stop the holder FIRST (skippable only when the caller asserts nothing holds it).
    if do_stop:
        stop = stop_holders(core)
        printer(f"[BUILD-PRECHECK] holders={stop['initial']} "
                f"launcher_stopped={stop['launcher_stopped']} killed={stop['killed']} "
                f"remaining={stop['remaining']}")
        if stop["remaining"]:
            printer(f"[BUILD FAIL] {common.iso_utc()} reason=holder_not_released "
                    f"pids={stop['remaining']} "
                    f"(a held .pyd → uninstall [WinError 5] would brick the venv — NOT starting build)")
            return 2
    else:
        printer("[BUILD-PRECHECK] holders=skipped (--no-stop)")

    # STEP 2 — launch detached.
    cmd = build_command(core, heavy, variant, log)
    printer(f"[BUILD STARTED] {common.iso_utc()} log={log}")
    proc = launch_build(cmd, log)

    # STEP 2b — poll for [SUCCESS] / exit / timeout.
    res = poll_until_done(proc, log, timeout=timeout, interval=interval)
    if not res["success"]:
        tail = read_log_tail(log)
        if res["timed_out"]:
            reason = f"timeout after {timeout:.0f}s (no '[SUCCESS] Build completed.')"
        elif res["exit_code"] == EXIT_DLL_INIT_FAILED:
            reason = (f"exit {EXIT_DLL_INIT_FAILED} (0xC0000142 STATUS_DLL_INIT_FAILED) — "
                      f"see BUILD_SYSTEM.md 0xC0000142 Recovery; do NOT pip-install")
        else:
            reason = f"exit {res['exit_code']} without success marker"
        printer(f"[BUILD FAIL] {common.iso_utc()} reason={reason}")
        printer("---- build log tail ----")
        printer(tail if tail else "(empty log)")
        printer("---- end log tail ----")
        return 2

    # STEP 3 — verify the marker is in the freshly-built binary (if a marker was given).
    verified = "n/a"
    if marker:
        v = verify_marker(core, marker)
        if not v["found"]:
            printer(f"[BUILD FAIL] {common.iso_utc()} reason=marker_absent "
                    f"marker={marker!r} binary={v['binary']} "
                    f"(BUILD_SYSTEM.md: a stale cached pyd was installed — rebuild --heavy)")
            return 2
        verified = "yes"

    dur = "n/a"  # duration is in the log; we report the verify result, not a stopwatch.
    printer(f"[BUILD OK] {common.iso_utc()} duration={dur} marker={marker or '(none)'} verified={verified}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the canonical Pianoid CUDA build (BUILD_SYSTEM.md).")
    heavy_grp = ap.add_mutually_exclusive_group()
    heavy_grp.add_argument("--heavy", dest="heavy", action="store_true", default=True,
                           help="full clean rebuild (default)")
    heavy_grp.add_argument("--light", dest="heavy", action="store_false",
                           help="incremental build (middleware-only changes)")
    var_grp = ap.add_mutually_exclusive_group()
    var_grp.add_argument("--both", dest="variant", action="store_const", const="--both",
                         default="--both", help="release + debug (default; required by BUILD_SYSTEM.md)")
    var_grp.add_argument("--release", dest="variant", action="store_const", const="--release",
                         help="release only (leaves debug pyd stale — explicit request only)")
    var_grp.add_argument("--debug", dest="variant", action="store_const", const="--debug",
                         help="debug only")
    ap.add_argument("--core", default=None, help="PianoidCore absolute path (default <root>/PianoidCore)")
    ap.add_argument("--log", default=None, help="build log path (default <tmp>/build.log)")
    ap.add_argument("--marker", default=None,
                    help="grep the built binary for this string (post-build verify)")
    ap.add_argument("--no-stop", action="store_true",
                    help="skip the STEP-1 stop-holder (only when you KNOW nothing holds the pyd)")
    ap.add_argument("--timeout", type=float, default=1200.0, help="max poll seconds (default 1200)")
    ap.add_argument("--poll", type=float, default=3.0, help="poll interval seconds (default 3)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the launch command + plan; run nothing")
    args = ap.parse_args(argv)

    try:
        root = common.repo_root()
        core = Path(args.core).resolve() if args.core else (root / "PianoidCore")
        if not core.is_dir():
            raise FileNotFoundError(f"PianoidCore dir not found: {core}")
        bat = build_script(core)
        if not bat.exists():
            raise FileNotFoundError(f"build script not found: {bat}")
        log = Path(args.log).resolve() if args.log else default_log_path()

        if args.dry_run:
            cmd = build_command(core, args.heavy, args.variant, log)
            print("[build_pianoid] DRY-RUN (nothing executed)")
            print(f"  core:    {core}")
            print(f"  variant: {'--heavy' if args.heavy else '--light'} {args.variant}")
            print(f"  log:     {log}")
            print(f"  stop:    {'skipped (--no-stop)' if args.no_stop else 'launcher-then-PID'}")
            print(f"  marker:  {args.marker or '(none)'}")
            print(f"  command: {cmd}")
            return 0

        return run(core, args.heavy, args.variant, log, args.marker,
                   do_stop=not args.no_stop, timeout=args.timeout, interval=args.poll)
    except Exception as exc:  # noqa: BLE001
        print(f"[build_pianoid] ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
