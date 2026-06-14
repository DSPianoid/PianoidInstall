"""Shared fixtures for the dev-pipeline unit tests.

These tests NEVER touch the real repo. They build a throwaway tree under pytest's tmp_path with
just the registry files the scripts read/write, and point the scripts at it via the
PIANOID_REPO_ROOT env var (honored by common.repo_root). Git is monkeypatched per-test where a
script shells out — see the `fake_git` fixture.

Run from the repo root:
    PianoidCore/.venv/Scripts/python -m pytest tools/dev-pipeline/tests -q
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make the script modules importable (the package dir name has a hyphen → not a real package).
_PKG_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PKG_DIR))


# A minimal but realistic WORK_IN_PROGRESS.md with a populated Active-Dev-Sessions table.
WIP_TEMPLATE = """\
# Work in Progress

> Some banner note about a resolved bug.

## Active Dev Sessions

| Agent | Task | Log | Started | Status |
|-------|------|-----|---------|--------|
| dev-aaaa | Existing task one | [log](logs/dev-aaaa-2026-06-01-101010.md) | 2026-06-01 | In Progress |
| dev-bbbb | Existing task two | [log](logs/dev-bbbb-2026-06-02-101010.md) | 2026-06-02 | **Paused** |

<!-- some completed-session history comment -->

## Some Other Section

Body text that must be left untouched.
"""

# A minimal MODULE_LOCKS.md: header, an active lock row, plus released-history comments + a
# placeholder row that must NOT be read as an active lock.
LOCKS_TEMPLATE = """\
# Module Locks

Active file locks held by dev agents.

<!-- dev-old1 locks RELEASED 2026-05-01 at Step 10a. Held: foo.py. -->
| Agent | Files | Locked At | Task |
|-------|-------|-----------|------|
| dev-cccc | `PianoidCore/foo.py`, `PianoidCore/bar.py` | 2026-06-03T10:00:00Z | Active task |
<!-- dev-dddd locks RELEASED 2026-06-04 at Step 10a Phase 1. Held: baz.py. -->
| <!-- (none) --> | | | |
"""


@pytest.fixture
def fake_repo(tmp_path: Path, monkeypatch) -> Path:
    """Build a throwaway repo tree and point common.repo_root at it via PIANOID_REPO_ROOT."""
    root = tmp_path / "PianoidInstall"
    (root / "docs" / "development" / "logs").mkdir(parents=True)
    (root / ".claude").mkdir()
    (root / "docs" / "proposals").mkdir(parents=True)

    (root / "docs" / "development" / "WORK_IN_PROGRESS.md").write_text(
        WIP_TEMPLATE, encoding="utf-8")
    (root / "docs" / "development" / "MODULE_LOCKS.md").write_text(
        LOCKS_TEMPLATE, encoding="utf-8")

    monkeypatch.setenv("PIANOID_REPO_ROOT", str(root))
    return root


@pytest.fixture
def fake_git(monkeypatch):
    """Replace common.run_git with a recorder that simulates git mv/add/log without a real repo.

    Returns a list of recorded (args, cwd) calls. `git mv` actually moves the file on disk (so the
    archive-target-exists guard is exercised); `git log -1 --pretty=%s` returns a settable subject;
    other commands succeed no-op.
    """
    import common

    calls: list[dict] = []
    state = {"head_subject": "[dev-zzzz] feat: default subject"}

    def fake_run_git(args, cwd, check=True):
        calls.append({"args": list(args), "cwd": Path(cwd)})

        class _P:
            returncode = 0
            stdout = ""
            stderr = ""

        p = _P()
        if args[:1] == ["mv"]:
            src = Path(cwd) / args[1]
            dst = Path(cwd) / args[2]
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.replace(dst)
        elif args[:2] == ["log", "-1"]:
            p.stdout = state["head_subject"] + "\n"
        elif args[:1] == ["status"]:
            p.stdout = ""
        return p

    monkeypatch.setattr(common, "run_git", fake_run_git)
    # git_mv calls run_git internally, so it picks up the patch automatically.
    return {"calls": calls, "state": state}


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """Ensure no stray PIANOID_REPO_ROOT leaks between tests that don't use fake_repo."""
    monkeypatch.delenv("PIANOID_REPO_ROOT", raising=False)
    yield
