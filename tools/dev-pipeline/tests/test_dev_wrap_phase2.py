"""Unit tests for dev_wrap_phase2.py — Step-10a Phase-2 wrap."""
from __future__ import annotations

import pytest

import common
import dev_wrap_phase2


def _make_log(root, agent_id, stamp="2026-06-06-090000"):
    p = root / common.LOGS_REL / f"{agent_id}-{stamp}.md"
    p.write_text("# Dev Session Log\n", encoding="utf-8")
    return p


def test_find_session_log_single(fake_repo):
    _make_log(fake_repo, "dev-aaaa")
    p = dev_wrap_phase2.find_session_log(fake_repo, "dev-aaaa")
    assert p.name == "dev-aaaa-2026-06-06-090000.md"


def test_find_session_log_missing(fake_repo):
    with pytest.raises(FileNotFoundError):
        dev_wrap_phase2.find_session_log(fake_repo, "dev-aaaa")


def test_find_session_log_ambiguous(fake_repo):
    _make_log(fake_repo, "dev-aaaa", "2026-06-06-090000")
    _make_log(fake_repo, "dev-aaaa", "2026-06-07-101010")
    with pytest.raises(RuntimeError):
        dev_wrap_phase2.find_session_log(fake_repo, "dev-aaaa")


def test_archive_log_no_git(fake_repo):
    log = _make_log(fake_repo, "dev-aaaa")
    dst = dev_wrap_phase2.archive_log(fake_repo, log, use_git=False)
    assert dst == "docs/development/logs/archive/dev-aaaa-2026-06-06-090000.md"
    assert (fake_repo / dst).exists()
    assert not log.exists()


def test_archive_log_via_git(fake_repo, fake_git):
    log = _make_log(fake_repo, "dev-aaaa")
    dst = dev_wrap_phase2.archive_log(fake_repo, log, use_git=True)
    assert (fake_repo / dst).exists()
    # git mv was the mechanism.
    assert any(c["args"][:1] == ["mv"] for c in fake_git["calls"])


def test_clean_wip_removes_row(fake_repo):
    n = dev_wrap_phase2.clean_wip(fake_repo, "dev-aaaa")
    assert n == 1
    wip = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert not common.wip_has_agent_row(wip, "dev-aaaa")


def test_clean_wip_absent_raises(fake_repo):
    with pytest.raises(RuntimeError):
        dev_wrap_phase2.clean_wip(fake_repo, "dev-nope")


def test_archive_proposal_prepends_status(fake_repo, fake_git):
    prop = fake_repo / "docs" / "proposals" / "my-proposal-2026-06-06.md"
    prop.write_text("# My Proposal\n\nbody.\n", encoding="utf-8")
    dst = dev_wrap_phase2.archive_proposal(
        fake_repo, "docs/proposals/my-proposal-2026-06-06.md",
        "IMPLEMENTED dev-aaaa abc123", use_git=True)
    assert dst == "docs/proposals/archive/my-proposal-2026-06-06.md"
    body = (fake_repo / dst).read_text(encoding="utf-8")
    assert body.startswith("**Status:** IMPLEMENTED dev-aaaa abc123 — Archived ")
    assert "# My Proposal" in body
    # git add of the moved file was issued.
    assert any(c["args"][:1] == ["add"] for c in fake_git["calls"])


def test_archive_proposal_missing_raises(fake_repo):
    with pytest.raises(FileNotFoundError):
        dev_wrap_phase2.archive_proposal(
            fake_repo, "docs/proposals/nope.md", "IMPLEMENTED x", use_git=False)


def test_main_happy_path_no_git(fake_repo, capsys):
    _make_log(fake_repo, "dev-aaaa")
    rc = dev_wrap_phase2.main(["dev-aaaa", "--no-git"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "archived log" in out
    assert "removed 1 WIP row" in out
    assert "[STEP-10A-PHASE-2]" in out
    # Effects landed.
    assert (fake_repo / common.LOGS_ARCHIVE_REL / "dev-aaaa-2026-06-06-090000.md").exists()
    wip = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert not common.wip_has_agent_row(wip, "dev-aaaa")


def test_main_with_proposal_requires_status(fake_repo):
    _make_log(fake_repo, "dev-aaaa")
    with pytest.raises(SystemExit):
        dev_wrap_phase2.main(["dev-aaaa", "--no-git", "--proposal", "docs/proposals/x.md"])


def test_main_missing_log_returns_error(fake_repo, capsys):
    rc = dev_wrap_phase2.main(["dev-aaaa", "--no-git"])  # no log created
    assert rc == 1
    err = capsys.readouterr().err
    assert "ERROR" in err
