#!/usr/bin/env python
"""verify_phase1.py — orchestrator post-agent Phase-1 verification (minimize-opus Q3 row 9).

After a /dev agent reports it finished Step-10a Phase 1 (commit landed, NOT yet archived — STOP
point awaiting user approval), the orchestrator verifies the agent actually left the correct
Phase-1 state before relaying "ready to test". These are four pure boolean assertions — ideal to
script. This runs in the LONG-LIVED orchestrator context, so each saved reasoning turn is expensive
there too.

The four checks (exactly the brief's list):
  1. COMMIT PREFIX — the HEAD commit subject in the work repo starts with `[<agent-id>]`
     (the dev.md commit convention; the Tier-1 violation the controller currently catches by hand).
  2. LOCKS RELEASED — `<agent-id>` holds NO active row in MODULE_LOCKS.md (released at Phase 1).
  3. LOG IN logs/ — the agent's session log is still in docs/development/logs/ (NOT archived;
     archiving is Phase 2, which must not have happened yet).
  4. WIP ROW PRESENT — the agent still has its `## Active Dev Sessions` row (removed only in Phase 2).

A correct Phase-1 stop is: committed (1 ✓) + locks released (2 ✓) + log still in logs/ (3 ✓, NOT
archived) + WIP row present (4 ✓, NOT cleaned). All four PASS == a clean Phase-1 handoff.

This is pure verification — it changes NOTHING. It only reads + prints PASS/FAIL per check and
exits non-zero if any check fails, so the orchestrator can branch on the exit code.

Usage:
    python verify_phase1.py <agent-id> [--repo PianoidCore] [--scan-repos] [--json]
        --repo      : which repo's HEAD to check for the commit prefix (default PianoidCore).
        --scan-repos: check the prefix against the HEAD of ALL Pianoid repos; PASS if ANY matches
                      (useful when you don't know which repo the agent committed to).

Exit codes: 0 if all four checks PASS; 2 if any check FAILS; 1 on internal error.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

WORK_REPOS = ("PianoidCore", "PianoidBasic", "PianoidTunner", "")


def head_subject(root: Path, repo: str) -> str | None:
    """HEAD commit subject for <root>/<repo>, or None if not a git repo / no commits."""
    repo_dir = root / repo if repo else root
    if not (repo_dir / ".git").exists():
        return None
    proc = common.run_git(["log", "-1", "--pretty=%s"], cwd=repo_dir, check=False)
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def check_commit_prefix(root: Path, agent_id: str, repo: str, scan: bool) -> dict:
    """Check 1: HEAD subject begins with `[<agent-id>]`."""
    prefix = f"[{agent_id}]"
    repos = WORK_REPOS if scan else (repo,)
    checked = {}
    matched_repo = None
    for r in repos:
        subj = head_subject(root, r)
        if subj is None:
            continue
        checked[r or "PianoidInstall"] = subj
        if subj.startswith(prefix):
            matched_repo = r or "PianoidInstall"
            if not scan:
                break
    passed = matched_repo is not None
    detail = (f"HEAD subject in {matched_repo} starts with '{prefix}'" if passed
              else f"no checked repo's HEAD subject starts with '{prefix}'")
    return {"name": "commit_prefix", "pass": passed, "detail": detail, "subjects": checked}


def check_locks_released(root: Path, agent_id: str) -> dict:
    """Check 2: agent holds no active lock row."""
    content = common.locks_path(root).read_text(encoding="utf-8")
    held = common.locks_held_by(content, agent_id)
    return {
        "name": "locks_released",
        "pass": not held,
        "detail": (f"{agent_id} still holds an active lock row" if held
                   else f"{agent_id} holds no active lock row"),
    }


def check_log_in_logs(root: Path, agent_id: str) -> dict:
    """Check 3: session log present in logs/ AND not in logs/archive/."""
    logs_dir = root / common.LOGS_REL
    archive_dir = root / common.LOGS_ARCHIVE_REL
    in_logs = [p.name for p in logs_dir.glob(f"{agent_id}-*.md") if p.is_file()]
    in_archive = [p.name for p in archive_dir.glob(f"{agent_id}-*.md")
                  if p.is_file()] if archive_dir.exists() else []
    passed = bool(in_logs) and not in_archive
    if not in_logs and in_archive:
        detail = f"log already ARCHIVED ({in_archive}) — that is Phase 2, not Phase 1"
    elif not in_logs:
        detail = f"no session log found for {agent_id} in logs/"
    elif in_archive:
        detail = f"log present in logs/ but ALSO in archive/ ({in_archive}) — inconsistent"
    else:
        detail = f"session log in logs/: {in_logs}"
    return {"name": "log_in_logs", "pass": passed, "detail": detail}


def check_wip_row_present(root: Path, agent_id: str) -> dict:
    """Check 4: Active-Dev-Sessions row still present."""
    content = common.wip_path(root).read_text(encoding="utf-8")
    present = common.wip_has_agent_row(content, agent_id)
    return {
        "name": "wip_row_present",
        "pass": present,
        "detail": (f"{agent_id} has an Active-Dev-Sessions row" if present
                   else f"{agent_id} has NO Active-Dev-Sessions row (cleaned already? Phase 2?)"),
    }


def run_checks(root: Path, agent_id: str, repo: str, scan: bool) -> list[dict]:
    return [
        check_commit_prefix(root, agent_id, repo, scan),
        check_locks_released(root, agent_id),
        check_log_in_logs(root, agent_id),
        check_wip_row_present(root, agent_id),
    ]


def render(agent_id: str, checks: list[dict]) -> str:
    lines = [f"=== Phase-1 verification for {agent_id} ==="]
    for c in checks:
        tag = "PASS" if c["pass"] else "FAIL"
        lines.append(f"  [{tag}] {c['name']}: {c['detail']}")
    overall = all(c["pass"] for c in checks)
    lines.append(f"  OVERALL: {'PASS' if overall else 'FAIL'}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Verify a /dev agent's Step-10a Phase-1 state.")
    ap.add_argument("agent_id", help="the agent whose Phase-1 state is being verified")
    ap.add_argument("--repo", default="PianoidCore",
                    help="repo whose HEAD to check for the commit prefix (default PianoidCore)")
    ap.add_argument("--scan-repos", action="store_true",
                    help="check the prefix against ALL repos' HEAD (PASS if any matches)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of the human report")
    args = ap.parse_args(argv)

    try:
        common.validate_agent_id(args.agent_id)
        root = common.repo_root()
        checks = run_checks(root, args.agent_id, args.repo, args.scan_repos)
    except Exception as exc:  # noqa: BLE001
        print(f"[verify_phase1] ERROR: {exc}", file=sys.stderr)
        return 1

    overall = all(c["pass"] for c in checks)
    if args.json:
        print(json.dumps({"agent_id": args.agent_id, "checks": checks, "pass": overall}, indent=2))
    else:
        print(render(args.agent_id, checks))

    return 0 if overall else 2


if __name__ == "__main__":
    raise SystemExit(main())
