#!/usr/bin/env python
"""env_sweep.py — port-scoped Pianoid environment clearance (minimize-opus Q3 rows 3 + 10).

This script exists for ONE reason: to make the *safe* kill sweep the only available path. Every
prior blanket-kill incident (`taskkill //IM python.exe` / `Stop-Process -Name python` killing MCP
servers, Chrome DevTools, even Claude Code itself — see .claude/CLAUDE.md
"feedback_no_blanket_taskkill") came from hand-typing an over-broad kill. By encoding ONLY the
PID-targeted, port-scoped form here, an agent that calls this script CANNOT regress into a blanket
kill.

INVARIANT (enforced structurally): the only processes ever terminated are those discovered as
LISTENERS on the four Pianoid ports 3000/3001/5000/5001. Never by image name. Never a fixed PID.
The discovery + kill are coupled per port so there is no path to kill anything else.

It does three deterministic things and prints a clear report:
  1. for each Pianoid port, find the listening PID(s) and Stop them (port-scoped, force),
  2. re-check the ports and report whether they are now free,
  3. print `git status --short` per Pianoid repo (Install / Core / Basic / Tunner) so the agent
     sees dirty-tree state in one turn.

What STAYS with Opus: deciding WHETHER to sweep (e.g. "a concurrent agent is using the stack —
shut down only what you started" is a judgment the orchestrator owns). This script, when called,
performs the full 4-port sweep; scope that down by NOT calling it, not by editing the port list.

Usage:
    python env_sweep.py [--no-kill] [--ports 3000 3001 5000 5001] [--json]
        --no-kill : report listeners + git status only, kill nothing (a dry inspection).
        --json    : emit machine-readable JSON instead of the human report.

Exit codes: 0 if (after any kill) all swept ports are free; 2 if one or more ports are still in
use; 1 on an internal error. Cross-platform (Windows PowerShell / Linux lsof|ss).
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

# The canonical Pianoid ports (backend=5000, modal adapter=5001, frontend=3000/3001).
DEFAULT_PORTS = (3000, 3001, 5000, 5001)

# Repos to report git status for (each may or may not exist on a given checkout).
REPOS = ("", "PianoidCore", "PianoidBasic", "PianoidTunner")


# --------------------------------------------------------------------------------------------------
# Port -> listening PID discovery (platform-specific, read-only)
# --------------------------------------------------------------------------------------------------
def _listeners_windows(port: int) -> list[int]:
    """PIDs LISTENING on `port` via PowerShell Get-NetTCPConnection (the orchestrator clearance form)."""
    ps = (
        f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | "
        f"Select-Object -Expand OwningProcess -Unique"
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True,
    )
    return _parse_pids(proc.stdout)


def _listeners_posix(port: int) -> list[int]:
    """PIDs LISTENING on `port` via lsof (preferred) or `ss` fallback."""
    if shutil.which("lsof"):
        proc = subprocess.run(
            ["lsof", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True,
        )
        return _parse_pids(proc.stdout)
    if shutil.which("ss"):
        # ss -ltnp 'sport = :PORT' prints lines containing pid=NNN
        proc = subprocess.run(
            ["ss", "-ltnp", f"sport = :{port}"],
            capture_output=True, text=True,
        )
        pids = []
        for tok in proc.stdout.replace(",", " ").split():
            if tok.startswith("pid="):
                try:
                    pids.append(int(tok[4:]))
                except ValueError:
                    pass
        return sorted(set(pids))
    raise RuntimeError("neither lsof nor ss is available to enumerate port listeners")


def _parse_pids(text: str) -> list[int]:
    pids = []
    for line in text.splitlines():
        line = line.strip()
        if line.isdigit() and line != "0":
            pids.append(int(line))
    return sorted(set(pids))


def listeners(port: int) -> list[int]:
    if platform.system() == "Windows":
        return _listeners_windows(port)
    return _listeners_posix(port)


# --------------------------------------------------------------------------------------------------
# Port-scoped kill (NEVER by image name) — only PIDs passed in, which come only from listeners()
# --------------------------------------------------------------------------------------------------
def kill_pid(pid: int) -> bool:
    """Force-kill a single PID. Returns True on success. Targets exactly this PID, nothing else."""
    if platform.system() == "Windows":
        proc = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True, text=True,
        )
        return proc.returncode == 0
    proc = subprocess.run(["kill", "-9", str(pid)], capture_output=True, text=True)
    return proc.returncode == 0


def sweep(ports, do_kill: bool) -> dict:
    """Run the sweep. Returns a structured report dict.

    For each port: record the listeners found, kill them (if do_kill), then re-check and record
    whether the port is now free.
    """
    report = {"ports": {}, "killed": [], "still_in_use": []}
    for port in ports:
        found = listeners(port)
        report["ports"][port] = {"before": found, "killed": [], "free": None}
        if do_kill:
            for pid in found:
                if kill_pid(pid):
                    report["ports"][port]["killed"].append(pid)
                    report["killed"].append(pid)
        # Re-check (whether or not we killed — gives accurate "free" state).
        remaining = listeners(port)
        free = len(remaining) == 0
        report["ports"][port]["free"] = free
        report["ports"][port]["after"] = remaining
        if not free:
            report["still_in_use"].append(port)
    return report


# --------------------------------------------------------------------------------------------------
# Per-repo git status
# --------------------------------------------------------------------------------------------------
def git_status(root: Path) -> dict:
    """Map repo-name -> {'dirty': bool, 'lines': [...]} via `git status --short` per repo dir."""
    out = {}
    for repo in REPOS:
        repo_dir = root / repo if repo else root
        name = repo or "PianoidInstall"
        if not (repo_dir / ".git").exists():
            out[name] = {"present": False, "dirty": False, "lines": []}
            continue
        proc = common.run_git(["status", "--short"], cwd=repo_dir, check=False)
        lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
        out[name] = {"present": True, "dirty": bool(lines), "lines": lines}
    return out


def render(report: dict, status: dict) -> str:
    parts = ["=== Pianoid env sweep ==="]
    for port, info in report["ports"].items():
        before = ",".join(map(str, info["before"])) or "-"
        killed = ",".join(map(str, info["killed"])) or "-"
        state = "FREE" if info["free"] else "IN USE"
        parts.append(f"  port {port}: listeners[{before}] killed[{killed}] -> {state}")
    parts.append("--- git status (per repo) ---")
    for name, st in status.items():
        if not st["present"]:
            parts.append(f"  {name}: (no .git)")
        elif not st["dirty"]:
            parts.append(f"  {name}: clean")
        else:
            parts.append(f"  {name}: DIRTY ({len(st['lines'])} entr{'y' if len(st['lines'])==1 else 'ies'})")
            for ln in st["lines"]:
                parts.append(f"      {ln}")
    if report["still_in_use"]:
        parts.append(f"  WARNING: ports still in use: {report['still_in_use']}")
    else:
        parts.append("  All swept ports clear.")
    return "\n".join(parts)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Port-scoped Pianoid env clearance + git status.")
    ap.add_argument("--no-kill", action="store_true", help="inspect only, kill nothing")
    ap.add_argument("--ports", type=int, nargs="+", default=list(DEFAULT_PORTS),
                    help="ports to sweep (default: 3000 3001 5000 5001)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of the human report")
    args = ap.parse_args(argv)

    try:
        root = common.repo_root()
        report = sweep(args.ports, do_kill=not args.no_kill)
        status = git_status(root)
    except Exception as exc:  # noqa: BLE001
        print(f"[env_sweep] ERROR: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({"sweep": report, "git_status": status}, indent=2))
    else:
        print(render(report, status))

    return 2 if report["still_in_use"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
