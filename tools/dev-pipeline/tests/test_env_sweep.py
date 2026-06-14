"""Unit tests for env_sweep.py — port-scoped clearance.

The critical property under test is the SAFETY INVARIANT: only PIDs discovered as listeners on the
four Pianoid ports are ever killed, and the kill is always PID-targeted (never by image name). We
monkeypatch the listener-discovery + kill primitives so no real process is touched.
"""
from __future__ import annotations

import pytest

import common
import env_sweep


def test_default_ports_are_canonical():
    assert env_sweep.DEFAULT_PORTS == (3000, 3001, 5000, 5001)


def test_parse_pids_filters_zero_and_blanks():
    assert env_sweep._parse_pids("123\n0\n\n456\n") == [123, 456]
    assert env_sweep._parse_pids("not-a-pid\n789") == [789]


def test_sweep_kills_only_discovered_listeners(monkeypatch):
    # Simulate: port 5000 has PIDs [111, 222]; others empty. After kill, all free.
    state = {5000: [111, 222], 3000: [], 3001: [], 5001: []}
    killed = []

    def fake_listeners(port):
        # After a PID is killed it disappears from the listener set.
        return [p for p in state.get(port, []) if p not in killed]

    def fake_kill(pid):
        killed.append(pid)
        return True

    monkeypatch.setattr(env_sweep, "listeners", fake_listeners)
    monkeypatch.setattr(env_sweep, "kill_pid", fake_kill)

    report = env_sweep.sweep(env_sweep.DEFAULT_PORTS, do_kill=True)
    # Exactly the discovered listeners were killed — nothing else.
    assert sorted(killed) == [111, 222]
    assert report["ports"][5000]["killed"] == [111, 222]
    assert report["ports"][5000]["free"] is True
    assert report["still_in_use"] == []


def test_sweep_no_kill_reports_but_does_not_kill(monkeypatch):
    state = {5000: [111], 3000: [], 3001: [], 5001: []}
    killed = []
    monkeypatch.setattr(env_sweep, "listeners", lambda port: state.get(port, []))
    monkeypatch.setattr(env_sweep, "kill_pid", lambda pid: killed.append(pid) or True)

    report = env_sweep.sweep(env_sweep.DEFAULT_PORTS, do_kill=False)
    assert killed == []  # nothing killed in inspect mode
    assert report["ports"][5000]["before"] == [111]
    assert report["ports"][5000]["free"] is False
    assert 5000 in report["still_in_use"]


def test_sweep_reports_still_in_use_when_kill_fails(monkeypatch):
    monkeypatch.setattr(env_sweep, "listeners", lambda port: [999] if port == 3001 else [])
    monkeypatch.setattr(env_sweep, "kill_pid", lambda pid: False)  # kill always fails
    report = env_sweep.sweep(env_sweep.DEFAULT_PORTS, do_kill=True)
    assert report["ports"][3001]["free"] is False
    assert 3001 in report["still_in_use"]


def test_main_exit_code_clear(monkeypatch, fake_repo, capsys):
    monkeypatch.setattr(env_sweep, "listeners", lambda port: [])
    monkeypatch.setattr(common, "run_git", lambda args, cwd, check=True: type(
        "P", (), {"returncode": 0, "stdout": "", "stderr": ""})())
    rc = env_sweep.main(["--no-kill"])
    assert rc == 0
    assert "All swept ports clear" in capsys.readouterr().out


def test_main_exit_code_2_when_in_use(monkeypatch, fake_repo, capsys):
    monkeypatch.setattr(env_sweep, "listeners", lambda port: [777] if port == 5000 else [])
    monkeypatch.setattr(env_sweep, "kill_pid", lambda pid: False)
    monkeypatch.setattr(common, "run_git", lambda args, cwd, check=True: type(
        "P", (), {"returncode": 0, "stdout": "", "stderr": ""})())
    rc = env_sweep.main([])
    assert rc == 2


def test_git_status_reports_dirty(monkeypatch, fake_repo):
    # PianoidInstall present (has .git); make status return dirty lines.
    (fake_repo / ".git").mkdir()

    def fake_run_git(args, cwd, check=True):
        out = " M docs/foo.md\n?? bar.py\n" if args[:1] == ["status"] else ""
        return type("P", (), {"returncode": 0, "stdout": out, "stderr": ""})()

    monkeypatch.setattr(common, "run_git", fake_run_git)
    status = env_sweep.git_status(fake_repo)
    assert status["PianoidInstall"]["present"] is True
    assert status["PianoidInstall"]["dirty"] is True
    assert len(status["PianoidInstall"]["lines"]) == 2
    # A repo without .git is reported as not present, not dirty.
    assert status["PianoidCore"]["present"] is False


def test_render_contains_ports_and_repos(monkeypatch):
    report = {
        "ports": {3000: {"before": [], "killed": [], "free": True, "after": []},
                  5000: {"before": [111], "killed": [111], "free": True, "after": []}},
        "killed": [111], "still_in_use": [],
    }
    status = {"PianoidInstall": {"present": True, "dirty": False, "lines": []}}
    text = env_sweep.render(report, status)
    assert "port 3000" in text and "port 5000" in text
    assert "PianoidInstall: clean" in text
    assert "All swept ports clear" in text
