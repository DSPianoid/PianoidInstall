#!/usr/bin/env python
"""env_sweep.py — port-scoped Pianoid environment clearance (minimize-opus Q3 rows 3 + 10).

This script exists for ONE reason: to make the *safe* kill sweep the only available path. Every
prior blanket-kill incident (`taskkill //IM python.exe` / `Stop-Process -Name python` killing MCP
servers, Chrome DevTools, even Claude Code itself — see .claude/CLAUDE.md
"feedback_no_blanket_taskkill") came from hand-typing an over-broad kill. By encoding ONLY the
PID-targeted, port-scoped form here, an agent that calls this script CANNOT regress into a blanket
kill.

INVARIANT (enforced structurally): the only processes ever terminated are those discovered as
LISTENERS on the four Pianoid ports 3000/3001/5000/5001 -- or, on the agent SPARE ports
(3002-3020 worktree CRA dev servers, 5002-5020 worktree/isolated backends), listeners whose command
line ALSO carries a Pianoid marker (a foreign app on a spare port is reported, never killed). Never
by image name. Never a fixed PID. The discovery + kill are coupled per port so there is no path to
kill anything else.

It does three deterministic things and prints a clear report:
  1. for each Pianoid port, find the listening PID(s) and Stop them (port-scoped, force),
  2. re-check the ports and report whether they are now free,
  3. print `git status --short` per Pianoid repo (Install / Core / Basic / Tunner) so the agent
     sees dirty-tree state in one turn.

What STAYS with Opus: deciding WHETHER to sweep (e.g. "a concurrent agent is using the stack —
shut down only what you started" is a judgment the orchestrator owns). This script, when called,
performs the full 4-port sweep; scope that down by NOT calling it, not by editing the port list.

Usage:
    python env_sweep.py [--no-kill] [--no-spare] [--ports 3000 3001 5000 5001] [--json]
        --no-kill : report listeners + git status only, kill nothing (a dry inspection).
        --no-spare: skip the marker-gated agent spare-port sweep (3002-3020 / 5002-5020).
        --json    : emit machine-readable JSON instead of the human report.

Exit codes: 0 if (after any kill) all swept ports are free; 2 if one or more ports are still in
use; 1 on an internal error. Cross-platform (Windows PowerShell / Linux lsof|ss).
"""
from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

# The canonical Pianoid ports (backend=5000, modal adapter=5001, frontend=3000/3001).
DEFAULT_PORTS = (3000, 3001, 5000, 5001)

# Agent SPARE ports: worktree CRA dev servers (PORT=30xx) and worktree / isolated backends (50xx).
# A listener here is killed ONLY if its command line carries a Pianoid marker (see is_pianoid_cmd).
SPARE_PORTS = tuple(range(3002, 3021)) + tuple(range(5002, 5021))

# Command-line markers that positively tie a process to Pianoid (case-insensitive). Includes the
# worktree layouts agents use: D:/repos/wt-<name>[-core|-tunner] and .claude/worktrees/agent-*.
_PIANOID_CMD_RE = re.compile(
    r"backendserver\.py|modal_adapter_server\.py|server[\\/]launcher\.js|pianoidtunner|pianoidcore"
    r"|pianoid_middleware|pianoidinstall|[\\/]wt-[^\\/\s\"']+[\\/]",
    re.IGNORECASE,
)

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


def is_pianoid_cmd(cmdline: str | None) -> bool:
    """True if a command line positively identifies a Pianoid process (incl. agent worktrees)."""
    return bool(cmdline) and bool(_PIANOID_CMD_RE.search(cmdline))


def _spare_listeners_windows(ports) -> list[dict]:
    plist = ",".join(str(p) for p in ports)
    ps = (
        f"$ports=@({plist}); "
        "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
        "Where-Object { $ports -contains $_.LocalPort -and $_.OwningProcess -gt 0 } | "
        "ForEach-Object { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\"; "
        "[pscustomobject]@{port=[int]$_.LocalPort; pid=[int]$_.OwningProcess; "
        "name=[string]$p.Name; cmd=[string]$p.CommandLine} } | ConvertTo-Json -Compress"
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True,
    )
    text = proc.stdout.strip()
    if not text:
        return []
    data = json.loads(text)
    return data if isinstance(data, list) else [data]


def _spare_listeners_posix(ports) -> list[dict]:
    out = []
    for port in ports:
        for pid in _listeners_posix(port):
            cmd = ""
            try:
                cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(bytes([0]), b" ").decode(errors="replace").strip()
            except OSError:
                proc = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True)
                cmd = proc.stdout.strip()
            out.append({"port": port, "pid": pid, "name": cmd.split(" ")[0] if cmd else "", "cmd": cmd})
    return out


def spare_listeners(ports) -> list[dict]:
    """[{port, pid, name, cmd}] for every listener on the given spare ports (read-only)."""
    if platform.system() == "Windows":
        return _spare_listeners_windows(ports)
    return _spare_listeners_posix(ports)


def sweep_spare(ports, do_kill: bool) -> dict:
    """Marker-gated sweep of the agent spare ports.

    Pianoid-marked listeners are killed (PID-targeted); any other listener is reported as
    'foreign' and left alone. Returns {"pianoid": [...], "foreign": [...], "still_in_use": [ports]}.
    """
    found = spare_listeners(ports)
    rep = {"pianoid": [], "foreign": [], "still_in_use": []}
    for entry in found:
        if is_pianoid_cmd(entry.get("cmd")):
            entry = dict(entry, killed=bool(do_kill and kill_pid(int(entry["pid"]))))
            rep["pianoid"].append(entry)
        else:
            rep["foreign"].append(entry)
    if rep["pianoid"]:
        pianoid_ports = sorted({int(e["port"]) for e in rep["pianoid"]})
        still = spare_listeners(pianoid_ports)
        rep["still_in_use"] = sorted({int(e["port"]) for e in still if is_pianoid_cmd(e.get("cmd"))})
    return rep


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
    spare = report.get("spare")
    if spare is not None:
        parts.append(f"--- agent spare ports {SPARE_PORTS[0]}-3020 / 5002-{SPARE_PORTS[-1]} (marker-gated) ---")
        if not spare["pianoid"] and not spare["foreign"]:
            parts.append("  no listeners")
        for e in spare["pianoid"]:
            state = "killed" if e.get("killed") else "NOT killed"
            parts.append(f"  port {e['port']}: PIANOID pid {e['pid']} {e.get('name','')} -> {state}")
            parts.append(f"      cmd: {(e.get('cmd') or '')[:160]}")
        for e in spare["foreign"]:
            parts.append(f"  port {e['port']}: foreign pid {e['pid']} {e.get('name','')} (left alone)")
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
    ap.add_argument("--no-spare", action="store_true",
                    help="skip the marker-gated agent spare-port sweep (3002-3020 / 5002-5020)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of the human report")
    args = ap.parse_args(argv)

    try:
        root = common.repo_root()
        report = sweep(args.ports, do_kill=not args.no_kill)
        if not args.no_spare:
            spare = sweep_spare(SPARE_PORTS, do_kill=not args.no_kill)
            report["spare"] = spare
            report["still_in_use"].extend(spare["still_in_use"])
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
