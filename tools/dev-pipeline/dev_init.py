#!/usr/bin/env python
"""dev_init.py — Step-0 scaffold for a /dev session (minimize-opus Q3 row 1 + row 7).

Collapses dev.md Step 0's templated bookkeeping into one scripted call:
  1. generate the agent ID (`dev-<4hex>`, reused via --agent-id on restart),
  2. write the session-log header in docs/development/logs/ with `[STEP-0-COMPLETE] <ts>` as the
     first line under `## Actions`,
  3. add the agent's row to the `## Active Dev Sessions` table in WORK_IN_PROGRESS.md,
  4. optionally create the feature branch (`--branch feature/<x>` in a `--repo`),
  5. print the agent ID, the log path, and a `[STEP-0-COMPLETE] <ts>` line for the controller.

What STAYS with Opus (NOT done here, per proposal §2.3): the decision to branch vs work-on-dev,
lock acquisition, and the Data Model Card. This script only does the deterministic plumbing once
that decision is made.

Usage:
    python dev_init.py "<task description>" [--agent-id dev-xxxx] [--branch feature/x --repo PianoidCore]
                        [--plan <path>] [--no-wip] [--no-color]

Exit codes: 0 success; non-zero (with a clear stderr message) on any inconsistency — e.g. the WIP
table is malformed, or --branch was given without --repo. Loud-and-local failure by design.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402


LOG_HEADER_TEMPLATE = """\
# Dev Session Log

- **Agent:** {agent_id}
- **Task:** {task}
- **Started:** {started}
- **Plan file:** {plan}
- **Status:** In Progress

## Actions

[STEP-0-COMPLETE] {started}
"""


def build_log_header(agent_id: str, task: str, started_iso: str, plan: str | None) -> str:
    """Render the dev.md Step-0 log header verbatim, with `[STEP-0-COMPLETE]` already in place."""
    return LOG_HEADER_TEMPLATE.format(
        agent_id=agent_id,
        task=task.strip(),
        started=started_iso,
        plan=plan.strip() if plan else "None",
    )


def scaffold(root: Path, task: str, agent_id: str, started_iso: str, log_stamp: str,
             plan: str | None, write_wip: bool) -> dict:
    """Perform the filesystem side-effects. Returns a dict describing what was written.

    Ordering: write the log first (so the file exists), then the WIP row. Both are idempotent-safe
    to inspect afterwards; on a malformed WIP table this raises BEFORE leaving a half-state by
    reading + validating the table bounds prior to writing.
    """
    common.validate_agent_id(agent_id)

    log_name = f"{agent_id}-{log_stamp}.md"
    log_path = root / common.LOGS_REL / log_name
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists():
        raise FileExistsError(f"session log already exists: {log_path}")

    wip_file = common.wip_path(root)
    new_wip = None
    if write_wip:
        if not wip_file.exists():
            raise FileNotFoundError(f"WIP file not found: {wip_file}")
        wip_content = wip_file.read_text(encoding="utf-8")
        row = common.build_wip_row(
            agent_id=agent_id,
            task=task,
            log_rel_to_dev=f"logs/{log_name}",
            started=common.date_stamp(),
        )
        # Validate + compute the new content BEFORE writing the log, so a malformed table fails
        # loudly without leaving an orphan log file.
        new_wip = common.insert_wip_row(wip_content, row)

    # Side-effects (after all validation passed).
    log_path.write_text(build_log_header(agent_id, task, started_iso, plan), encoding="utf-8")
    if write_wip and new_wip is not None:
        wip_file.write_text(new_wip, encoding="utf-8")

    return {"agent_id": agent_id, "log_path": log_path, "wip_updated": write_wip}


def create_branch(root: Path, repo: str, branch: str) -> str:
    """`git checkout dev && git pull origin dev && git checkout -b <branch>` in <root>/<repo>.

    Mirrors dev.md Step 3 for non-trivial changes. The branch *name* is the caller's (trivial)
    judgment; the git plumbing is the script's. Returns the branch name on success; raises on any
    git failure (loud).
    """
    repo_dir = root / repo
    if not (repo_dir / ".git").exists() and not repo_dir.is_dir():
        raise FileNotFoundError(f"repo dir not found: {repo_dir}")
    common.run_git(["checkout", "dev"], cwd=repo_dir)
    # pull is best-effort: a missing remote/offline shouldn't block local branch creation, but we
    # surface its failure as a warning rather than aborting the scaffold.
    pull = common.run_git(["pull", "origin", "dev"], cwd=repo_dir, check=False)
    if pull.returncode != 0:
        print(f"[dev_init] warning: 'git pull origin dev' failed in {repo}: "
              f"{pull.stderr.strip()}", file=sys.stderr)
    common.run_git(["checkout", "-b", branch], cwd=repo_dir)
    return branch


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Scaffold a /dev session (Step 0).")
    ap.add_argument("task", help="task description (free text)")
    ap.add_argument("--agent-id", default=None,
                    help="reuse an existing agent ID (restart/recovery); default generates dev-<4hex>")
    ap.add_argument("--branch", default=None, help="feature branch to create, e.g. feature/foo")
    ap.add_argument("--repo", default=None,
                    help="repo dir for --branch (PianoidCore|PianoidBasic|PianoidTunner)")
    ap.add_argument("--plan", default=None, help="path to a plan file this session follows")
    ap.add_argument("--no-wip", action="store_true", help="skip the WORK_IN_PROGRESS.md row")
    args = ap.parse_args(argv)

    if args.branch and not args.repo:
        ap.error("--branch requires --repo")

    try:
        root = common.repo_root()
        agent_id = common.validate_agent_id(args.agent_id) if args.agent_id \
            else common.generate_agent_id()
        started = common.iso_utc()
        result = scaffold(
            root=root,
            task=args.task,
            agent_id=agent_id,
            started_iso=started,
            log_stamp=common.log_stamp(),
            plan=args.plan,
            write_wip=not args.no_wip,
        )
        if args.branch:
            create_branch(root, args.repo, args.branch)
    except Exception as exc:  # noqa: BLE001 — top-level CLI guard: report cleanly, exit non-zero.
        print(f"[dev_init] ERROR: {exc}", file=sys.stderr)
        return 1

    log_rel = result["log_path"].relative_to(root).as_posix()
    print(f"AGENT_ID={result['agent_id']}")
    print(f"LOG_FILE={log_rel}")
    if args.branch:
        print(f"BRANCH={args.branch} (in {args.repo})")
    print(f"[STEP-0-COMPLETE] {started}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
