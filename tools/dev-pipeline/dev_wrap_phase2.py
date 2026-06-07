#!/usr/bin/env python
"""dev_wrap_phase2.py — Step-10a Phase-2 bookkeeping for a /dev session (minimize-opus Q3 row 2).

This fires LATE in a session (maximum accumulated context), so each Opus turn it removes is the
most expensive of the run (proposal §2.2). It performs the deterministic Phase-2 moves once the
USER has approved the wrap (the approval itself is judgment and stays upstream — this script must
only be invoked after that approval, exactly as a /dev agent would only reach Phase 2 after the
orchestrator relays approval):

  1. `git mv` the session log  docs/development/logs/<id>-*.md  ->  logs/archive/
  2. remove the agent's row from the `## Active Dev Sessions` table in WORK_IN_PROGRESS.md
  3. (optional) `git mv` a shipped proposal  docs/proposals/<name>.md -> docs/proposals/archive/
     and prepend a `**Status:** IMPLEMENTED ... — Archived <date>.` line (dev.md Step 10a #9).

What STAYS with Opus (proposal §2.3): WHICH proposal shipped (the --proposal arg is the agent's
decision; the script only moves it), and whether the proposal is fully vs partially implemented
(the script refuses to archive unless told, and the agent supplies the status evidence text).

Usage:
    python dev_wrap_phase2.py <agent-id>
        [--proposal docs/proposals/<name>.md --status "IMPLEMENTED <evidence>"]
        [--no-git]   # edit/move files in place without git (for a non-git tree / dry test)

Exit codes: 0 on success. Non-zero (clear stderr) if the log can't be found, the WIP row is
absent (nothing to remove — a real inconsistency for a wrap), or a named proposal doesn't exist.
The script does each step and reports what it did; a failure aborts BEFORE partial registry edits
where feasible (WIP content is validated before writing).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


def find_session_log(root: Path, agent_id: str) -> Path:
    """Return the single active session log for `agent_id` under logs/ (NOT archive).

    dev.md names logs `<agent-id>-YYYY-MM-DD-HHMMSS.md`. Raises if zero or >1 match (ambiguous →
    loud failure, never guess which to archive).
    """
    logs_dir = root / common.LOGS_REL
    matches = sorted(p for p in logs_dir.glob(f"{agent_id}-*.md") if p.is_file())
    if not matches:
        raise FileNotFoundError(
            f"no active session log for {agent_id} in {logs_dir} (already archived?)"
        )
    if len(matches) > 1:
        names = ", ".join(p.name for p in matches)
        raise RuntimeError(f"ambiguous: multiple logs for {agent_id}: {names}")
    return matches[0]


def archive_log(root: Path, log_path: Path, use_git: bool) -> str:
    """Move the log into logs/archive/. Returns the archived path (repo-relative posix)."""
    src_rel = log_path.relative_to(root).as_posix()
    dst_rel = f"{common.LOGS_ARCHIVE_REL}/{log_path.name}"
    dst_abs = root / dst_rel
    if dst_abs.exists():
        raise FileExistsError(f"archive target already exists: {dst_rel}")
    if use_git:
        common.git_mv(root, src_rel, dst_rel)
    else:
        dst_abs.parent.mkdir(parents=True, exist_ok=True)
        log_path.replace(dst_abs)
    return dst_rel


def clean_wip(root: Path, agent_id: str) -> int:
    """Remove the agent's Active-Dev-Sessions row(s). Returns the count removed (must be >= 1)."""
    wip_file = common.wip_path(root)
    if not wip_file.exists():
        raise FileNotFoundError(f"WIP file not found: {wip_file}")
    content = wip_file.read_text(encoding="utf-8")
    new_content, removed = common.remove_wip_row(content, agent_id)
    if removed == 0:
        raise RuntimeError(
            f"no Active-Dev-Sessions row found for {agent_id} (already cleaned? wrong id?)"
        )
    wip_file.write_text(new_content, encoding="utf-8")
    return removed


def archive_proposal(root: Path, proposal_rel: str, status_text: str, use_git: bool) -> str:
    """Move a shipped proposal to docs/proposals/archive/ + prepend a Status line.

    dev.md Step 10a #9: do the status edit AFTER the git mv, then stage the moved file. We move
    first, then write the prepended `**Status:**` line to the archived file. Returns archived path.
    """
    src_abs = root / proposal_rel
    if not src_abs.is_file():
        raise FileNotFoundError(f"proposal not found: {proposal_rel}")
    name = Path(proposal_rel).name
    dst_rel = f"{common.PROPOSALS_ARCHIVE_REL}/{name}"
    dst_abs = root / dst_rel
    if dst_abs.exists():
        raise FileExistsError(f"archive target already exists: {dst_rel}")

    if use_git:
        common.git_mv(root, proposal_rel, dst_rel)
    else:
        dst_abs.parent.mkdir(parents=True, exist_ok=True)
        src_abs.replace(dst_abs)

    body = dst_abs.read_text(encoding="utf-8")
    status_line = f"**Status:** {status_text.strip()} — Archived {common.date_stamp()}.\n\n"
    dst_abs.write_text(status_line + body, encoding="utf-8")
    if use_git:
        common.run_git(["add", dst_rel], cwd=root)
    return dst_rel


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Step-10a Phase-2 wrap (archive log, clean WIP).")
    ap.add_argument("agent_id", help="the agent whose session is being wrapped")
    ap.add_argument("--proposal", default=None,
                    help="repo-relative path of a shipped proposal to archive")
    ap.add_argument("--status", default=None,
                    help="status evidence text for the archived proposal "
                         "(e.g. 'IMPLEMENTED dev-xxxx <sha>')")
    ap.add_argument("--no-git", action="store_true",
                    help="move/edit files directly without git (non-git tree / dry test)")
    args = ap.parse_args(argv)

    if args.proposal and not args.status:
        ap.error("--proposal requires --status (the IMPLEMENTED/SUPERSEDED evidence line)")

    use_git = not args.no_git
    did: list[str] = []
    try:
        common.validate_agent_id(args.agent_id)
        root = common.repo_root()

        log_path = find_session_log(root, args.agent_id)
        archived_log = archive_log(root, log_path, use_git)
        did.append(f"archived log -> {archived_log}")

        removed = clean_wip(root, args.agent_id)
        did.append(f"removed {removed} WIP row(s) for {args.agent_id}")

        if args.proposal:
            archived_prop = archive_proposal(root, args.proposal, args.status, use_git)
            did.append(f"archived proposal -> {archived_prop}")
    except Exception as exc:  # noqa: BLE001
        for step in did:
            print(f"[dev_wrap_phase2] done: {step}", file=sys.stderr)
        print(f"[dev_wrap_phase2] ERROR: {exc}", file=sys.stderr)
        return 1

    for step in did:
        print(f"[dev_wrap_phase2] {step}")
    print(f"[STEP-10A-PHASE-2] {common.iso_utc()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
