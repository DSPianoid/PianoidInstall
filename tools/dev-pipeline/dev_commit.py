#!/usr/bin/env python
"""dev_commit.py — commit plumbing with an ENFORCED `[agent-id]` prefix (minimize-opus Q3 row 5).

Collapses the `git add <files>` + `git commit -m "[agent-id] <type>: <msg>"` mechanics of dev.md
Step 4 (intermediate commits) / Step 10a (final commit) into one scripted call. Its ONE job beyond
the git plumbing is to GUARANTEE the `[<agent-id>] <type>: <subject>` convention every time, so the
Tier-1 "missing/incorrect commit prefix" violation the controller currently catches by hand can no
longer occur.

What STAYS with Opus (proposal §2.3 "Commit message wording … Opus writes the words"):
  • the *subject text* (`<msg>`) — natural-language synthesis,
  • WHICH files belong in the commit (the agent passes them),
  • WHETHER to commit at all / split into multiple commits.
The script only assembles `[<agent-id>] <type>: <msg>`, stages exactly the given files, and commits.
It never `git add -A`, never auto-generates the message, never picks the type, never amends.

Usage:
    python dev_commit.py <agent-id> <type> "<subject>" <file> [<file> ...]
        [--repo PianoidCore]      # repo dir the commit lands in (default: the Install repo root)
        [--body "<body text>"]    # optional commit body (second -m); wording stays the agent's
        [--allow-empty]           # permit a commit with no staged changes (rare; off by default)
        [--dry-run]               # assemble + print the message and the add/commit plan; run NO git

`<type>` is a conventional-commit type (feat|fix|docs|refactor|test|chore|perf|build|ci|style|revert)
— validated against that set so a typo can't ship as the type. The final subject is
`[<agent-id>] <type>: <subject>` (dev.md commit convention).

Exit codes: 0 on a successful commit (or a clean --dry-run); non-zero (clear stderr) if no files
were given, the agent-id/type is invalid, a named file does not exist, or git fails. Loud-and-local
failure by design — it never commits a half-staged or mis-prefixed change silently.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

# Conventional-commit types the dev workflow uses. Kept as a closed set so a typo in --type fails
# loudly rather than shipping `[dev-xxxx] fxi: ...` as a "valid" commit.
VALID_TYPES = (
    "feat", "fix", "docs", "refactor", "test", "chore",
    "perf", "build", "ci", "style", "revert",
)


def validate_type(commit_type: str) -> str:
    """Reject anything that isn't one of the known conventional-commit types."""
    if commit_type not in VALID_TYPES:
        raise ValueError(
            f"invalid commit type {commit_type!r}; expected one of {', '.join(VALID_TYPES)}"
        )
    return commit_type


def build_subject(agent_id: str, commit_type: str, message: str) -> str:
    """Assemble the dev.md commit subject: `[<agent-id>] <type>: <subject>`.

    The agent supplies the human `message`; this only wraps it with the enforced prefix + type. A
    blank message is rejected (a commit needs a subject — that is the agent's, but it must exist).
    """
    common.validate_agent_id(agent_id)
    validate_type(commit_type)
    subject = " ".join(message.split())  # collapse whitespace/newlines into a single subject line
    if not subject:
        raise ValueError("commit message (subject) is empty")
    return f"[{agent_id}] {commit_type}: {subject}"


def resolve_files(repo_dir: Path, files: list[str]) -> list[str]:
    """Validate that each path exists under (or relative to) the repo dir; return them as given.

    `git add` is run with `cwd=repo_dir`, so the paths are interpreted relative to that dir. We
    confirm each resolves to a real file/dir so a typo'd path fails BEFORE we touch git (rather than
    silently staging nothing). Absolute paths are accepted and checked as-is.
    """
    if not files:
        raise ValueError("no files given — refusing to commit (this script never does `git add -A`)")
    resolved: list[str] = []
    for f in files:
        p = Path(f)
        abs_p = p if p.is_absolute() else (repo_dir / f)
        if not abs_p.exists():
            raise FileNotFoundError(f"file not found (relative to {repo_dir}): {f}")
        resolved.append(f)
    return resolved


def do_commit(repo_dir: Path, subject: str, files: list[str], body: str | None,
              allow_empty: bool) -> str:
    """`git add <files>` then `git commit -m <subject> [-m <body>]`. Returns the new HEAD short sha.

    Raises (loud) on any git failure. Staging is exactly the given files — never `-A`.
    """
    common.run_git(["add", "--", *files], cwd=repo_dir)
    commit_args = ["commit", "-m", subject]
    if body and body.strip():
        commit_args += ["-m", body.strip()]
    if allow_empty:
        commit_args.append("--allow-empty")
    common.run_git(commit_args, cwd=repo_dir)
    head = common.run_git(["rev-parse", "--short", "HEAD"], cwd=repo_dir)
    return head.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Commit staged work with an enforced [agent-id] prefix.")
    ap.add_argument("agent_id", help="the committing agent (e.g. dev-a3f1) — becomes the [prefix]")
    ap.add_argument("type", help=f"conventional-commit type ({'|'.join(VALID_TYPES)})")
    ap.add_argument("message", help="commit subject text (the agent's wording; prefix is added)")
    ap.add_argument("files", nargs="*", help="files to stage + commit (at least one; never -A)")
    ap.add_argument("--repo", default=None,
                    help="repo dir the commit lands in (PianoidCore|PianoidBasic|PianoidTunner); "
                         "default = the Install repo root")
    ap.add_argument("--body", default=None, help="optional commit body (a second -m)")
    ap.add_argument("--allow-empty", action="store_true",
                    help="permit a commit with no staged diff (off by default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="assemble + print the message and plan; run NO git")
    args = ap.parse_args(argv)

    try:
        # Build the subject first so a bad agent-id/type/message fails before any git or fs work.
        subject = build_subject(args.agent_id, args.type, args.message)
        root = common.repo_root()
        repo_dir = (root / args.repo) if args.repo else root
        if not (repo_dir / ".git").exists():
            raise FileNotFoundError(f"not a git repo (no .git): {repo_dir}")
        files = resolve_files(repo_dir, args.files)

        if args.dry_run:
            print(f"[dev_commit] DRY-RUN (no git executed)")
            print(f"  repo:    {repo_dir}")
            print(f"  subject: {subject}")
            if args.body:
                print(f"  body:    {args.body.strip()}")
            print(f"  stage:   {', '.join(files)}")
            return 0

        sha = do_commit(repo_dir, subject, files, args.body, args.allow_empty)
    except Exception as exc:  # noqa: BLE001 — top-level CLI guard: report cleanly, exit non-zero.
        print(f"[dev_commit] ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"[dev_commit] committed {sha}: {subject}")
    print(f"[COMMIT] {common.iso_utc()} sha={sha} agent={args.agent_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
