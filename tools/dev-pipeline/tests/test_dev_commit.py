"""Unit tests for dev_commit.py — commit with an enforced [agent-id] prefix.

Every git call is monkeypatched (via the shared `fake_git` fixture, which patches common.run_git) —
no real repo is committed to. The tests verify the enforced subject format, the staging-exactly-the-
given-files invariant, and loud failure on bad input.
"""
from __future__ import annotations

import pytest

import common
import dev_commit


# --------------------------------------------------------------------------------------------------
# Subject assembly + validation
# --------------------------------------------------------------------------------------------------
def test_build_subject_enforces_prefix_and_type():
    subj = dev_commit.build_subject("dev-a3f1", "feat", "add the widget")
    assert subj == "[dev-a3f1] feat: add the widget"


def test_build_subject_collapses_whitespace_and_newlines():
    subj = dev_commit.build_subject("dev-a3f1", "fix", "line one\n  line two   with spaces")
    assert subj == "[dev-a3f1] fix: line one line two with spaces"


def test_build_subject_rejects_empty_message():
    with pytest.raises(ValueError):
        dev_commit.build_subject("dev-a3f1", "feat", "   \n  ")


def test_build_subject_rejects_bad_type():
    for bad in ("fxi", "feature", "FEAT", "", "wip"):
        with pytest.raises(ValueError):
            dev_commit.build_subject("dev-a3f1", bad, "msg")


def test_build_subject_rejects_bad_agent_id():
    for bad in ("has space", "pipe|x", "../etc", ""):
        with pytest.raises(ValueError):
            dev_commit.build_subject(bad, "feat", "msg")


def test_validate_type_accepts_all_known():
    for t in dev_commit.VALID_TYPES:
        assert dev_commit.validate_type(t) == t


# --------------------------------------------------------------------------------------------------
# File resolution (must exist; never -A)
# --------------------------------------------------------------------------------------------------
def test_resolve_files_requires_at_least_one(fake_repo):
    with pytest.raises(ValueError):
        dev_commit.resolve_files(fake_repo, [])


def test_resolve_files_rejects_missing(fake_repo):
    (fake_repo / "exists.py").write_text("x", encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        dev_commit.resolve_files(fake_repo, ["exists.py", "missing.py"])


def test_resolve_files_accepts_existing_relative(fake_repo):
    (fake_repo / "a.py").write_text("x", encoding="utf-8")
    (fake_repo / "sub").mkdir()
    (fake_repo / "sub" / "b.py").write_text("y", encoding="utf-8")
    out = dev_commit.resolve_files(fake_repo, ["a.py", "sub/b.py"])
    assert out == ["a.py", "sub/b.py"]


# --------------------------------------------------------------------------------------------------
# do_commit — stages exactly the given files, commits with the subject
# --------------------------------------------------------------------------------------------------
def test_do_commit_stages_exact_files_and_commits(fake_repo, fake_git, monkeypatch):
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    # rev-parse HEAD returns a short sha via the fake.
    monkeypatch.setitem(fake_git["state"], "head_subject", "[dev-a3f1] feat: x")

    sha = dev_commit.do_commit(
        fake_repo, "[dev-a3f1] feat: x", ["foo.py"], body=None, allow_empty=False)
    args_seqs = [c["args"] for c in fake_git["calls"]]
    # `git add -- foo.py` then `git commit -m <subject>`.
    assert ["add", "--", "foo.py"] in args_seqs
    assert any(a[:3] == ["commit", "-m", "[dev-a3f1] feat: x"] for a in args_seqs)
    # NEVER `git add -A`/`git add .`.
    assert not any(a[:2] == ["add", "-A"] or a[:2] == ["add", "."] for a in args_seqs)
    assert isinstance(sha, str)


def test_do_commit_includes_body_as_second_m(fake_repo, fake_git):
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    dev_commit.do_commit(fake_repo, "[dev-a3f1] feat: x", ["foo.py"],
                         body="Longer explanation.", allow_empty=False)
    commit = next(c["args"] for c in fake_git["calls"] if c["args"][:1] == ["commit"])
    assert "-m" in commit
    assert "Longer explanation." in commit


def test_do_commit_allow_empty_flag(fake_repo, fake_git):
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    dev_commit.do_commit(fake_repo, "[dev-a3f1] chore: x", ["foo.py"],
                         body=None, allow_empty=True)
    commit = next(c["args"] for c in fake_git["calls"] if c["args"][:1] == ["commit"])
    assert "--allow-empty" in commit


# --------------------------------------------------------------------------------------------------
# main() — end to end with the fake git + dry-run
# --------------------------------------------------------------------------------------------------
def test_main_dry_run_prints_subject_runs_no_git(fake_repo, fake_git, capsys):
    (fake_repo / ".git").mkdir()
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    rc = dev_commit.main(["dev-a3f1", "feat", "add a thing", "foo.py", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "[dev-a3f1] feat: add a thing" in out
    assert "DRY-RUN" in out
    # No git was executed in dry-run.
    assert fake_git["calls"] == []


def test_main_happy_path(fake_repo, fake_git, capsys):
    (fake_repo / ".git").mkdir()
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    rc = dev_commit.main(["dev-a3f1", "fix", "patch it", "foo.py"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "[dev-a3f1] fix: patch it" in out
    assert "[COMMIT]" in out
    args_seqs = [c["args"] for c in fake_git["calls"]]
    assert ["add", "--", "foo.py"] in args_seqs


def test_main_no_files_errors(fake_repo, fake_git, capsys):
    (fake_repo / ".git").mkdir()
    rc = dev_commit.main(["dev-a3f1", "feat", "x"])  # no files
    assert rc == 1
    assert "no files" in capsys.readouterr().err.lower()


def test_main_bad_type_errors(fake_repo, capsys):
    (fake_repo / ".git").mkdir()
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    rc = dev_commit.main(["dev-a3f1", "nope", "x", "foo.py"])
    assert rc == 1
    assert "invalid commit type" in capsys.readouterr().err


def test_main_not_a_git_repo_errors(fake_repo, capsys):
    # No .git in the fake root → loud failure before any git call.
    (fake_repo / "foo.py").write_text("x", encoding="utf-8")
    rc = dev_commit.main(["dev-a3f1", "feat", "x", "foo.py"])
    assert rc == 1
    assert "not a git repo" in capsys.readouterr().err.lower()


def test_main_repo_subdir(fake_repo, fake_git, capsys):
    # --repo PianoidCore commits in <root>/PianoidCore.
    core = fake_repo / "PianoidCore"
    (core / ".git").mkdir(parents=True)
    (core / "x.cu").write_text("// code", encoding="utf-8")
    rc = dev_commit.main(["dev-a3f1", "feat", "kernel tweak", "x.cu", "--repo", "PianoidCore"])
    assert rc == 0
    # The add ran with cwd = the PianoidCore dir.
    add_call = next(c for c in fake_git["calls"] if c["args"][:1] == ["add"])
    assert add_call["cwd"] == core
