"""Unit tests for marker_hook.py — the PROTOTYPE PostToolUse marker hook (opt-in, unregistered).

These cover the pure summarize/key logic + the non-fatal contract. The hook is NOT wired into any
settings.json; see the Phase-1 feasibility note. The point of testing it is that the offered
"session-level variant" option is a real, working artifact.
"""
from __future__ import annotations

import io
import json

import marker_hook


def test_summarize_bash_collapses_newlines_and_truncates():
    line = marker_hook._summarize("Bash", {"command": "echo hi\nrm -rf /tmp/x"})
    assert line.startswith("[BASH-CALL] ")
    assert "\n" not in line
    assert "echo hi rm -rf /tmp/x" in line


def test_summarize_read():
    line = marker_hook._summarize("Read", {"file_path": "docs/index.md"})
    assert line.startswith("[READ] ")
    assert "path=docs/index.md" in line


def test_summarize_grep_and_glob():
    g = marker_hook._summarize("Grep", {"pattern": "foo", "path": "src"})
    assert g.startswith("[GREP] ") and "pattern=foo" in g and "path=src" in g
    # Glob maps to the same GREP marker.
    gl = marker_hook._summarize("Glob", {"pattern": "**/*.py", "path": "."})
    assert gl.startswith("[GREP] ")


def test_summarize_mcp_parses_server_and_tool():
    line = marker_hook._summarize("mcp__deepseek-codegen__delegate_codegen", {})
    assert line.startswith("[MCP-CALL] ")
    assert "server=deepseek-codegen" in line
    assert "tool=delegate_codegen" in line


def test_summarize_unknown_tool_is_empty():
    assert marker_hook._summarize("Edit", {"file_path": "x"}) == ""
    assert marker_hook._summarize("Write", {"file_path": "x"}) == ""


def test_safe_key_sanitizes():
    assert marker_hook._safe_key("a/b\\c:d") == "a_b_c_d"
    assert marker_hook._safe_key("") == "unknown"
    assert len(marker_hook._safe_key("x" * 200)) <= 80


def _run_with_stdin(monkeypatch, payload):
    monkeypatch.setattr("sys.stdin", io.StringIO(payload))
    return marker_hook.main()


def test_main_writes_keyed_file(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    rc = _run_with_stdin(monkeypatch, json.dumps({
        "tool_name": "Bash", "agent_id": "aaaa", "agent_type": "dev",
        "tool_input": {"command": "ls"}}))
    assert rc == 0
    f = tmp_path / "docs" / "development" / "logs" / "hook-markers" / "aaaa.md"
    assert f.exists()
    body = f.read_text(encoding="utf-8")
    assert "# Hook markers for aaaa (dev)" in body
    assert "[BASH-CALL]" in body


def test_main_keys_by_session_when_no_agent(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    _run_with_stdin(monkeypatch, json.dumps({
        "tool_name": "Read", "session_id": "sess-1", "tool_input": {"file_path": "x"}}))
    assert (tmp_path / "docs/development/logs/hook-markers/sess-1.md").exists()


def test_main_separate_files_per_agent(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    for aid in ("aaaa", "bbbb"):
        _run_with_stdin(monkeypatch, json.dumps({
            "tool_name": "Bash", "agent_id": aid, "tool_input": {"command": "ls"}}))
    d = tmp_path / "docs/development/logs/hook-markers"
    assert (d / "aaaa.md").exists() and (d / "bbbb.md").exists()


def test_main_non_fatal_on_bad_json(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    assert _run_with_stdin(monkeypatch, "not json {") == 0  # never raises


def test_main_non_fatal_on_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    assert _run_with_stdin(monkeypatch, "") == 0


def test_main_unhandled_tool_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    _run_with_stdin(monkeypatch, json.dumps({
        "tool_name": "Edit", "agent_id": "aaaa", "tool_input": {"file_path": "x"}}))
    d = tmp_path / "docs/development/logs/hook-markers"
    # Either the dir wasn't created or the file is absent — nothing recorded.
    assert not (d / "aaaa.md").exists()
