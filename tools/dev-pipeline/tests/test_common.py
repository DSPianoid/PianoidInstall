"""Unit tests for common.py — the registry-edit + formatting core used by all dev-pipeline scripts."""
from __future__ import annotations

import datetime
import re

import pytest

import common


# --------------------------------------------------------------------------------------------------
# Identifiers + timestamps
# --------------------------------------------------------------------------------------------------
def test_generate_agent_id_shape():
    aid = common.generate_agent_id()
    assert re.fullmatch(r"dev-[0-9a-f]{4}", aid), aid


def test_validate_agent_id_accepts_and_rejects():
    assert common.validate_agent_id("dev-a3f1") == "dev-a3f1"
    assert common.validate_agent_id("deepseek-phase0") == "deepseek-phase0"
    for bad in ("", "has space", "pipe|in", "semi;colon", "../etc", "a/b"):
        with pytest.raises(ValueError):
            common.validate_agent_id(bad)


def test_timestamp_formats():
    dt = datetime.datetime(2026, 5, 5, 12, 30, 22, tzinfo=datetime.timezone.utc)
    assert common.iso_utc(dt) == "2026-05-05T12:30:22Z"
    assert common.log_stamp(dt) == "2026-05-05-123022"
    assert common.date_stamp(dt) == "2026-05-05"


def test_timestamp_converts_to_utc():
    # A non-UTC tz must be normalized to UTC, not printed in local time.
    tz = datetime.timezone(datetime.timedelta(hours=3))
    dt = datetime.datetime(2026, 5, 5, 15, 30, 22, tzinfo=tz)  # 12:30:22 UTC
    assert common.iso_utc(dt) == "2026-05-05T12:30:22Z"


# --------------------------------------------------------------------------------------------------
# Repo-root discovery
# --------------------------------------------------------------------------------------------------
def test_repo_root_via_env(fake_repo, monkeypatch):
    assert common.repo_root() == fake_repo


def test_repo_root_env_missing_dir(monkeypatch):
    monkeypatch.setenv("PIANOID_REPO_ROOT", "/no/such/dir/xyz")
    with pytest.raises(FileNotFoundError):
        common.repo_root()


def test_repo_root_walks_to_markers(tmp_path, monkeypatch):
    monkeypatch.delenv("PIANOID_REPO_ROOT", raising=False)
    root = tmp_path / "repo"
    (root / "docs").mkdir(parents=True)
    (root / ".claude").mkdir()
    deep = root / "tools" / "dev-pipeline"
    deep.mkdir(parents=True)
    assert common.repo_root(start=deep / "common.py") == root


# --------------------------------------------------------------------------------------------------
# WIP row build + insert + remove
# --------------------------------------------------------------------------------------------------
def test_build_wip_row_escapes_pipes_and_newlines():
    row = common.build_wip_row(
        "dev-a3f1", "task with | pipe\nand newline", "logs/dev-a3f1-x.md", "2026-06-06")
    assert row.startswith("| dev-a3f1 |")
    assert row.endswith("| In Progress |")
    assert "[log](logs/dev-a3f1-x.md)" in row
    # The inner pipe is escaped (\|) so it can't split the cell; column DELIMITERS stay at 6
    # (5 logical columns). Total '|' = 6 delimiters + 1 escaped = 7.
    assert "\\|" in row
    assert row.count("|") - row.count("\\|") == 6  # unescaped delimiters only
    assert "\n" not in row.strip("\n")


def test_insert_wip_row_goes_below_separator(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    row = common.build_wip_row("dev-new1", "Brand new", "logs/dev-new1-x.md", "2026-06-06")
    new = common.insert_wip_row(content, row)
    lines = new.splitlines()
    sep_idx = next(i for i, ln in enumerate(lines) if ln.strip().startswith("|--"))
    # New row is immediately after the separator (top of the data block).
    assert lines[sep_idx + 1] == row
    # Existing rows preserved.
    assert any("dev-aaaa" in ln for ln in lines)
    assert any("dev-bbbb" in ln for ln in lines)
    # Other sections untouched.
    assert "## Some Other Section" in new


def test_remove_wip_row_plain(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    new, removed = common.remove_wip_row(content, "dev-aaaa")
    assert removed == 1
    assert "dev-aaaa" not in new
    assert "dev-bbbb" in new  # only the target row removed


def test_remove_wip_row_tolerates_strikethrough_bold(fake_repo):
    # dev-bbbb's row is **Paused**; the agent cell itself is plain, but verify emphasis-tolerance
    # by constructing a strikethrough agent cell.
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    content = content.replace("| dev-bbbb |", "| ~~dev-bbbb~~ |")
    new, removed = common.remove_wip_row(content, "dev-bbbb")
    assert removed == 1
    assert "dev-bbbb" not in new


def test_remove_wip_row_absent_returns_zero(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    new, removed = common.remove_wip_row(content, "dev-nope")
    assert removed == 0
    assert new == content


def test_remove_wip_row_does_not_touch_other_tables():
    # An agent id that appears in prose / another section must not be removed from there.
    content = (
        "## Active Dev Sessions\n"
        "| Agent | Task | Log | Started | Status |\n"
        "|-------|------|-----|---------|--------|\n"
        "| dev-aaaa | t | [log](x) | 2026-06-06 | In Progress |\n"
        "\n"
        "## Notes\n"
        "dev-aaaa did something noteworthy in this paragraph.\n"
    )
    new, removed = common.remove_wip_row(content, "dev-aaaa")
    assert removed == 1
    assert "dev-aaaa did something noteworthy" in new  # prose untouched


def test_wip_has_agent_row(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert common.wip_has_agent_row(content, "dev-aaaa") is True
    assert common.wip_has_agent_row(content, "dev-bbbb") is True
    assert common.wip_has_agent_row(content, "dev-zzzz") is False


def test_insert_then_has_then_remove_roundtrip(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    row = common.build_wip_row("dev-rt01", "Roundtrip", "logs/dev-rt01-x.md", "2026-06-06")
    after_insert = common.insert_wip_row(content, row)
    assert common.wip_has_agent_row(after_insert, "dev-rt01")
    after_remove, n = common.remove_wip_row(after_insert, "dev-rt01")
    assert n == 1
    assert not common.wip_has_agent_row(after_remove, "dev-rt01")


def test_malformed_wip_raises():
    with pytest.raises(ValueError):
        common.insert_wip_row("# No table here\n\njust text\n", "| x |")


def test_rejoin_preserves_trailing_newline(fake_repo):
    content = common.wip_path(fake_repo).read_text(encoding="utf-8")
    assert content.endswith("\n")
    new, _ = common.remove_wip_row(content, "dev-aaaa")
    assert new.endswith("\n")


# --------------------------------------------------------------------------------------------------
# MODULE_LOCKS inspection (active vs released/comment/placeholder)
# --------------------------------------------------------------------------------------------------
def test_locks_held_by_active_row(fake_repo):
    content = common.locks_path(fake_repo).read_text(encoding="utf-8")
    assert common.locks_held_by(content, "dev-cccc") is True


def test_locks_released_in_comment_not_held(fake_repo):
    content = common.locks_path(fake_repo).read_text(encoding="utf-8")
    # dev-old1 and dev-dddd appear ONLY inside <!-- ... --> release comments → not held.
    assert common.locks_held_by(content, "dev-old1") is False
    assert common.locks_held_by(content, "dev-dddd") is False


def test_locks_placeholder_none_not_held(fake_repo):
    content = common.locks_path(fake_repo).read_text(encoding="utf-8")
    assert common.locks_held_by(content, "none") is False


def test_locks_held_by_unknown_agent(fake_repo):
    content = common.locks_path(fake_repo).read_text(encoding="utf-8")
    assert common.locks_held_by(content, "dev-zzzz") is False


def test_locks_multiline_comment_stripped():
    content = (
        "| Agent | Files | Locked At | Task |\n"
        "|-------|-------|-----------|------|\n"
        "<!-- dev-multi locks RELEASED\n"
        "     spanning two lines\n"
        "     | dev-multi | foo.py | ts | task |  (this row is INSIDE the comment)\n"
        "-->\n"
        "| dev-real | bar.py | ts | task |\n"
    )
    assert common.locks_held_by(content, "dev-multi") is False  # inside multi-line comment
    assert common.locks_held_by(content, "dev-real") is True


def test_locks_word_boundary_no_false_substring():
    content = (
        "| Agent | Files | Locked At | Task |\n"
        "|-------|-------|-----------|------|\n"
        "| dev-cccc | foo.py | ts | task |\n"
    )
    # dev-cc must NOT match dev-cccc (word-boundary, not substring).
    assert common.locks_held_by(content, "dev-cc") is False
    assert common.locks_held_by(content, "dev-cccc") is True
