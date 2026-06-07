"""Unit tests for verify_phase1.py — the orchestrator's 4-check Phase-1 verification."""
from __future__ import annotations

import pytest

import common
import verify_phase1


def _make_log(root, agent_id, archived=False, stamp="2026-06-06-090000"):
    sub = common.LOGS_ARCHIVE_REL if archived else common.LOGS_REL
    d = root / sub
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{agent_id}-{stamp}.md"
    p.write_text("# Dev Session Log\n", encoding="utf-8")
    return p


def _patch_head(monkeypatch, subject):
    monkeypatch.setattr(verify_phase1, "head_subject", lambda root, repo: subject)


# --------------------------------------------------------------------------------------------------
# Individual checks
# --------------------------------------------------------------------------------------------------
def test_check_commit_prefix_pass(fake_repo, monkeypatch):
    monkeypatch.setattr(verify_phase1, "head_subject",
                        lambda root, repo: "[dev-aaaa] feat: did the thing"
                        if repo == "PianoidCore" else None)
    res = verify_phase1.check_commit_prefix(fake_repo, "dev-aaaa", "PianoidCore", scan=False)
    assert res["pass"] is True


def test_check_commit_prefix_fail(fake_repo, monkeypatch):
    _patch_head(monkeypatch, "[dev-other] feat: not us")
    res = verify_phase1.check_commit_prefix(fake_repo, "dev-aaaa", "PianoidCore", scan=False)
    assert res["pass"] is False


def test_check_commit_prefix_scan_any_repo(fake_repo, monkeypatch):
    def head(root, repo):
        return "[dev-aaaa] fix: in tunner" if repo == "PianoidTunner" else "[dev-x] other"
    monkeypatch.setattr(verify_phase1, "head_subject", head)
    res = verify_phase1.check_commit_prefix(fake_repo, "dev-aaaa", "PianoidCore", scan=True)
    assert res["pass"] is True  # matched in PianoidTunner


def test_check_locks_released_pass(fake_repo):
    # dev-aaaa holds no lock in the template (dev-cccc does).
    res = verify_phase1.check_locks_released(fake_repo, "dev-aaaa")
    assert res["pass"] is True


def test_check_locks_released_fail_when_held(fake_repo):
    res = verify_phase1.check_locks_released(fake_repo, "dev-cccc")
    assert res["pass"] is False


def test_check_log_in_logs_pass(fake_repo):
    _make_log(fake_repo, "dev-aaaa")
    res = verify_phase1.check_log_in_logs(fake_repo, "dev-aaaa")
    assert res["pass"] is True


def test_check_log_in_logs_fail_when_archived(fake_repo):
    _make_log(fake_repo, "dev-aaaa", archived=True)
    res = verify_phase1.check_log_in_logs(fake_repo, "dev-aaaa")
    assert res["pass"] is False
    assert "ARCHIVED" in res["detail"]


def test_check_log_in_logs_fail_when_missing(fake_repo):
    res = verify_phase1.check_log_in_logs(fake_repo, "dev-aaaa")
    assert res["pass"] is False


def test_check_wip_row_present_pass(fake_repo):
    res = verify_phase1.check_wip_row_present(fake_repo, "dev-aaaa")
    assert res["pass"] is True


def test_check_wip_row_present_fail(fake_repo):
    res = verify_phase1.check_wip_row_present(fake_repo, "dev-zzzz")
    assert res["pass"] is False


# --------------------------------------------------------------------------------------------------
# main() — overall PASS/FAIL + exit codes
# --------------------------------------------------------------------------------------------------
def test_main_all_pass(fake_repo, monkeypatch, capsys):
    # Clean Phase-1 state for dev-aaaa: committed + locks released + log in logs/ + WIP row present.
    _make_log(fake_repo, "dev-aaaa")
    _patch_head(monkeypatch, "[dev-aaaa] feat: done")
    rc = verify_phase1.main(["dev-aaaa"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "OVERALL: PASS" in out
    assert out.count("[PASS]") == 4


def test_main_fail_when_one_check_fails(fake_repo, monkeypatch, capsys):
    # Log archived → log_in_logs FAILS; everything else passes.
    _make_log(fake_repo, "dev-aaaa", archived=True)
    _patch_head(monkeypatch, "[dev-aaaa] feat: done")
    rc = verify_phase1.main(["dev-aaaa"])
    out = capsys.readouterr().out
    assert rc == 2
    assert "OVERALL: FAIL" in out


def test_main_fail_when_locks_still_held(fake_repo, monkeypatch, capsys):
    _make_log(fake_repo, "dev-cccc")
    _patch_head(monkeypatch, "[dev-cccc] feat: done")
    # dev-cccc still holds a lock in the template → locks_released FAILS.
    rc = verify_phase1.main(["dev-cccc"])
    assert rc == 2
    assert "OVERALL: FAIL" in capsys.readouterr().out


def test_main_json_output(fake_repo, monkeypatch, capsys):
    _make_log(fake_repo, "dev-aaaa")
    _patch_head(monkeypatch, "[dev-aaaa] feat: done")
    rc = verify_phase1.main(["dev-aaaa", "--json"])
    out = capsys.readouterr().out
    assert rc == 0
    import json
    parsed = json.loads(out)
    assert parsed["pass"] is True
    assert len(parsed["checks"]) == 4
