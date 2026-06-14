"""Unit tests for dev_init.py — Step-0 scaffold."""
from __future__ import annotations

import datetime

import pytest

import common
import dev_init


def test_log_header_is_byte_faithful_to_devmd():
    """The header must match dev.md Step-0 exactly, with [STEP-0-COMPLETE] under ## Actions."""
    hdr = dev_init.build_log_header(
        "dev-a3f1", "Fix the thing", "2026-05-05T12:30:22Z", None)
    assert hdr.startswith("# Dev Session Log\n")
    assert "- **Agent:** dev-a3f1\n" in hdr
    assert "- **Task:** Fix the thing\n" in hdr
    assert "- **Started:** 2026-05-05T12:30:22Z\n" in hdr
    assert "- **Plan file:** None\n" in hdr
    assert "- **Status:** In Progress\n" in hdr
    # ## Actions then the STEP-0-COMPLETE marker as the first line under it.
    actions_idx = hdr.index("## Actions")
    marker_idx = hdr.index("[STEP-0-COMPLETE] 2026-05-05T12:30:22Z")
    assert marker_idx > actions_idx


def test_log_header_with_plan():
    hdr = dev_init.build_log_header("dev-a3f1", "t", "2026-05-05T12:30:22Z", "docs/proposals/x.md")
    assert "- **Plan file:** docs/proposals/x.md\n" in hdr


def test_scaffold_creates_log_and_wip_row(fake_repo):
    started = "2026-06-06T09:00:00Z"
    res = dev_init.scaffold(
        root=fake_repo, task="My new task", agent_id="dev-1234",
        started_iso=started, log_stamp="2026-06-06-090000", plan=None, write_wip=True)
    log_path = res["log_path"]
    assert log_path.exists()
    assert log_path.name == "dev-1234-2026-06-06-090000.md"
    body = log_path.read_text(encoding="utf-8")
    assert "- **Agent:** dev-1234" in body
    assert f"[STEP-0-COMPLETE] {started}" in body
    # WIP row added.
    wip = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert common.wip_has_agent_row(wip, "dev-1234")
    assert "[log](logs/dev-1234-2026-06-06-090000.md)" in wip


def test_scaffold_no_wip(fake_repo):
    res = dev_init.scaffold(
        root=fake_repo, task="t", agent_id="dev-5678",
        started_iso="2026-06-06T09:00:00Z", log_stamp="2026-06-06-090000", plan=None,
        write_wip=False)
    assert res["log_path"].exists()
    wip = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert not common.wip_has_agent_row(wip, "dev-5678")


def test_scaffold_refuses_duplicate_log(fake_repo):
    kw = dict(root=fake_repo, task="t", agent_id="dev-dup0",
              started_iso="2026-06-06T09:00:00Z", log_stamp="2026-06-06-090000", plan=None,
              write_wip=False)
    dev_init.scaffold(**kw)
    with pytest.raises(FileExistsError):
        dev_init.scaffold(**kw)


def test_scaffold_malformed_wip_leaves_no_orphan_log(fake_repo):
    # Corrupt the WIP table so insert_wip_row raises; the log must NOT be written (validation first).
    common.wip_path(fake_repo).write_text("# no table\n", encoding="utf-8")
    with pytest.raises(ValueError):
        dev_init.scaffold(
            root=fake_repo, task="t", agent_id="dev-orph",
            started_iso="2026-06-06T09:00:00Z", log_stamp="2026-06-06-090000", plan=None,
            write_wip=True)
    assert not (fake_repo / common.LOGS_REL / "dev-orph-2026-06-06-090000.md").exists()


def test_main_generates_id_and_prints_markers(fake_repo, capsys):
    rc = dev_init.main(["Implement a widget"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "AGENT_ID=dev-" in out
    assert "LOG_FILE=docs/development/logs/dev-" in out
    assert "[STEP-0-COMPLETE]" in out


def test_main_reuses_agent_id(fake_repo, capsys):
    rc = dev_init.main(["Resume task", "--agent-id", "dev-keep"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "AGENT_ID=dev-keep" in out


def test_main_branch_requires_repo(fake_repo, capsys):
    with pytest.raises(SystemExit):
        dev_init.main(["t", "--branch", "feature/x"])  # argparse error → SystemExit(2)


def test_create_branch_runs_git_sequence(fake_repo, fake_git):
    (fake_repo / "PianoidCore" / ".git").mkdir(parents=True)
    dev_init.create_branch(fake_repo, "PianoidCore", "feature/foo")
    seqs = [c["args"] for c in fake_git["calls"]]
    assert ["checkout", "dev"] in seqs
    assert ["pull", "origin", "dev"] in seqs
    assert ["checkout", "-b", "feature/foo"] in seqs
