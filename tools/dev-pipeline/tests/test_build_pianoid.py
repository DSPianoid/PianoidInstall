"""Unit tests for build_pianoid.py — the BUILD_SYSTEM.md build wrapper.

CRITICAL: no real CUDA build is ever launched, no real process is killed, and the launcher is never
contacted. Every external primitive (find_holders, stop_backend_via_launcher, kill_pid, launch_build,
and the Popen poll) is monkeypatched. We assert the *discipline*: stop-holder-first, abort if a holder
survives, the exact detached launch command, success only on the [SUCCESS] marker, and the failure
evidence (incl. the 0xC0000142 special case) — without running anything.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import build_pianoid as bp


@pytest.fixture
def core(fake_repo):
    """A PianoidCore dir with the build script present (so the script's existence check passes)."""
    c = fake_repo / "PianoidCore"
    c.mkdir(parents=True, exist_ok=True)
    bat = "build_pianoid_cuda.bat" if bp.IS_WINDOWS else "build_pianoid_cuda.sh"
    (c / bat).write_text("@echo off\n", encoding="utf-8")
    return c


class FakePopen:
    """Minimal Popen stand-in: poll() returns the queued exit code (None until 'exited')."""
    def __init__(self, exit_codes):
        # exit_codes: a list polled in order; None means 'still running'.
        self._codes = list(exit_codes)
        self._final = self._codes[-1] if self._codes else 0

    def poll(self):
        return self._codes.pop(0) if self._codes else self._final

    def wait(self, timeout=None):
        return self._final


# --------------------------------------------------------------------------------------------------
# build_command — the EXACT detached form
# --------------------------------------------------------------------------------------------------
def test_build_command_windows_shape(core, monkeypatch):
    monkeypatch.setattr(bp, "IS_WINDOWS", True)
    log = Path("D:/tmp/build.log")
    cmd = bp.build_command(core, heavy=True, variant="--both", log=log)
    assert cmd[0] == "powershell.exe"
    joined = " ".join(cmd)
    # Detached + hidden, cmd /c, explicit VIRTUAL_ENV, cd /d, absolute bat, redirect, both variant.
    assert "Start-Process -WindowStyle Hidden" in joined
    assert "cmd.exe" in joined
    assert 'set "VIRTUAL_ENV=' in joined
    assert "cd /d" in joined
    assert "build_pianoid_cuda.bat" in joined
    assert "--heavy --both" in joined
    assert "2>&1" in joined
    # The bat is referenced by ABSOLUTE path (the core dir is in the command).
    assert str(core) in joined


def test_build_command_light_flag(core, monkeypatch):
    monkeypatch.setattr(bp, "IS_WINDOWS", True)
    cmd = bp.build_command(core, heavy=False, variant="--both", log=Path("D:/tmp/b.log"))
    assert "--light --both" in " ".join(cmd)


def test_build_command_linux_shape(core, monkeypatch):
    monkeypatch.setattr(bp, "IS_WINDOWS", False)
    cmd = bp.build_command(core, heavy=True, variant="--both", log=Path("/tmp/build.log"))
    assert cmd[0] == "bash"
    assert "build_pianoid_cuda.sh" in " ".join(cmd)
    assert "--heavy --both" in " ".join(cmd)


# --------------------------------------------------------------------------------------------------
# stop_holders — launcher FIRST, then PID kill, abort if a holder survives
# --------------------------------------------------------------------------------------------------
def test_stop_holders_noop_when_nothing_holds(core, monkeypatch):
    monkeypatch.setattr(bp, "find_holders", lambda c: [])
    called = {"launcher": False}
    monkeypatch.setattr(bp, "stop_backend_via_launcher",
                        lambda *a, **k: called.__setitem__("launcher", True) or True)
    res = bp.stop_holders(core)
    assert res["initial"] == []
    assert called["launcher"] is False  # never bothered the launcher when nothing held the pyd


def test_stop_holders_uses_launcher_then_clears(core, monkeypatch):
    # Initially [111]; launcher stop succeeds; subsequent find_holders show it gone.
    # stop_holders calls find_holders 3×: initial, the kill-loop re-check, then `remaining`.
    seq = iter([[111], [], []])
    monkeypatch.setattr(bp, "find_holders", lambda c: next(seq))
    launcher = {"hit": False}
    monkeypatch.setattr(bp, "stop_backend_via_launcher",
                        lambda *a, **k: launcher.__setitem__("hit", True) or True)
    monkeypatch.setattr(bp, "kill_pid", lambda pid: pytest.fail("should not kill — launcher cleared it"))
    monkeypatch.setattr(bp.time, "sleep", lambda *_: None)
    res = bp.stop_holders(core)
    assert launcher["hit"] is True
    assert res["launcher_stopped"] is True
    assert res["remaining"] == []


def test_stop_holders_falls_back_to_pid_kill(core, monkeypatch):
    # Launcher fails; PID kill clears it. find_holders: initial [222], after-launcher [222], final [].
    calls = iter([[222], [222], []])
    monkeypatch.setattr(bp, "find_holders", lambda c: next(calls))
    monkeypatch.setattr(bp, "stop_backend_via_launcher", lambda *a, **k: False)
    killed = []
    monkeypatch.setattr(bp, "kill_pid", lambda pid: killed.append(pid) or True)
    monkeypatch.setattr(bp.time, "sleep", lambda *_: None)
    res = bp.stop_holders(core)
    assert killed == [222]
    assert res["remaining"] == []


def test_stop_holders_reports_survivor(core, monkeypatch):
    # Nothing clears it → remaining non-empty (caller will abort).
    monkeypatch.setattr(bp, "find_holders", lambda c: [333])
    monkeypatch.setattr(bp, "stop_backend_via_launcher", lambda *a, **k: False)
    monkeypatch.setattr(bp, "kill_pid", lambda pid: False)  # kill fails
    monkeypatch.setattr(bp.time, "sleep", lambda *_: None)
    res = bp.stop_holders(core)
    assert res["remaining"] == [333]


# --------------------------------------------------------------------------------------------------
# poll_until_done — success only on the marker; fail on exit-without-marker; timeout
# --------------------------------------------------------------------------------------------------
def test_poll_success_on_marker(core, tmp_path, monkeypatch):
    log = tmp_path / "build.log"
    log.write_text(f"...\n{bp.SUCCESS_MARKER}\n", encoding="utf-8")
    proc = FakePopen([0])
    res = bp.poll_until_done(proc, log, timeout=5, interval=0)
    assert res["success"] is True
    assert res["log_had_success"] is True


def test_poll_fail_on_exit_without_marker(core, tmp_path):
    log = tmp_path / "build.log"
    log.write_text("compiling...\nerror LNK1181\n", encoding="utf-8")
    proc = FakePopen([1])  # exited non-zero, no marker
    res = bp.poll_until_done(proc, log, timeout=5, interval=0)
    assert res["success"] is False
    assert res["timed_out"] is False
    assert res["exit_code"] == 1


def test_poll_timeout(core, tmp_path, monkeypatch):
    log = tmp_path / "build.log"
    log.write_text("still going...\n", encoding="utf-8")
    proc = FakePopen([None, None, None, None])  # never exits
    # Make the deadline elapse immediately on the second loop.
    res = bp.poll_until_done(proc, log, timeout=0, interval=0)
    assert res["timed_out"] is True
    assert res["success"] is False


# --------------------------------------------------------------------------------------------------
# verify_marker
# --------------------------------------------------------------------------------------------------
def test_verify_marker_found(core, monkeypatch):
    binary = core / "fake.pyd"
    binary.write_bytes(b"....runSynthesisKernel....")
    monkeypatch.setattr(bp, "installed_binary", lambda c: binary)
    res = bp.verify_marker(core, "runSynthesisKernel")
    assert res["found"] is True


def test_verify_marker_absent(core, monkeypatch):
    binary = core / "fake.pyd"
    binary.write_bytes(b"....nope....")
    monkeypatch.setattr(bp, "installed_binary", lambda c: binary)
    res = bp.verify_marker(core, "runSynthesisKernel")
    assert res["found"] is False


def test_verify_marker_no_binary(core, monkeypatch):
    monkeypatch.setattr(bp, "installed_binary", lambda c: None)
    res = bp.verify_marker(core, "x")
    assert res["found"] is False
    assert res["binary"] is None


# --------------------------------------------------------------------------------------------------
# run() — the full flow, all primitives mocked, asserting markers + exit codes
# --------------------------------------------------------------------------------------------------
def _mock_clean_launch(monkeypatch, log_text):
    """Mock launch_build to write a log and return a FakePopen that 'completed'."""
    def fake_launch(cmd, log):
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(log_text, encoding="utf-8")
        return FakePopen([0])
    monkeypatch.setattr(bp, "launch_build", fake_launch)


def test_run_happy_path_no_marker(core, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    _mock_clean_launch(monkeypatch, f"building...\n{bp.SUCCESS_MARKER}\n")
    log = tmp_path / "build.log"
    rc = bp.run(core, heavy=True, variant="--both", log=log, marker=None,
                do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 0
    assert "[BUILD-PRECHECK]" in out
    assert "[BUILD STARTED]" in out
    assert "[BUILD OK]" in out


def test_run_happy_path_with_marker_verified(core, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    _mock_clean_launch(monkeypatch, f"{bp.SUCCESS_MARKER}\n")
    binary = core / "fake.pyd"
    binary.write_bytes(b"...myMarkerString...")
    monkeypatch.setattr(bp, "installed_binary", lambda c: binary)
    rc = bp.run(core, heavy=True, variant="--both", log=tmp_path / "build.log",
                marker="myMarkerString", do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 0
    assert "verified=yes" in out


def test_run_aborts_when_holder_survives(core, tmp_path, monkeypatch, capsys):
    # A surviving holder must abort BEFORE launching (the destructive-uninstall guard).
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [99], "launcher_stopped": False,
                                                       "killed": [], "remaining": [99]})
    monkeypatch.setattr(bp, "launch_build",
                        lambda *a, **k: pytest.fail("must NOT launch when a holder survives"))
    rc = bp.run(core, heavy=True, variant="--both", log=tmp_path / "build.log", marker=None,
                do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 2
    assert "[BUILD FAIL]" in out
    assert "holder_not_released" in out


def test_run_build_failure_tails_log(core, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    def fake_launch(cmd, log):
        log.write_text("compiling x.cu\nfatal error LNK1181: SDL3.lib\n", encoding="utf-8")
        return FakePopen([1])
    monkeypatch.setattr(bp, "launch_build", fake_launch)
    rc = bp.run(core, heavy=True, variant="--both", log=tmp_path / "build.log", marker=None,
                do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 2
    assert "[BUILD FAIL]" in out
    assert "LNK1181" in out  # the log tail (evidence Opus reads) is printed


def test_run_dll_init_failed_special_message(core, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    def fake_launch(cmd, log):
        log.write_text("pip build-isolation failed\n", encoding="utf-8")
        return FakePopen([bp.EXIT_DLL_INIT_FAILED])
    monkeypatch.setattr(bp, "launch_build", fake_launch)
    rc = bp.run(core, heavy=True, variant="--both", log=tmp_path / "build.log", marker=None,
                do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 2
    assert "0xC0000142" in out
    assert "do NOT pip-install" in out


def test_run_marker_absent_after_success_fails(core, tmp_path, monkeypatch, capsys):
    # Build reports success but the marker isn't in the binary → stale-pyd guard fails the build.
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    _mock_clean_launch(monkeypatch, f"{bp.SUCCESS_MARKER}\n")
    binary = core / "fake.pyd"
    binary.write_bytes(b"...stale build without the marker...")
    monkeypatch.setattr(bp, "installed_binary", lambda c: binary)
    rc = bp.run(core, heavy=True, variant="--both", log=tmp_path / "build.log",
                marker="theNewString", do_stop=True, timeout=5, interval=0)
    out = capsys.readouterr().out
    assert rc == 2
    assert "marker_absent" in out


# --------------------------------------------------------------------------------------------------
# main() — usage guards + dry-run (no execution)
# --------------------------------------------------------------------------------------------------
def test_main_dry_run_prints_command(core, fake_repo, capsys, monkeypatch):
    monkeypatch.setattr(bp, "launch_build",
                        lambda *a, **k: pytest.fail("dry-run must not launch"))
    rc = bp.main(["--dry-run", "--core", str(core)])
    out = capsys.readouterr().out
    assert rc == 0
    assert "DRY-RUN" in out
    assert "command:" in out


def test_main_missing_build_script_errors(fake_repo, tmp_path, capsys):
    empty_core = tmp_path / "EmptyCore"
    empty_core.mkdir()
    rc = bp.main(["--core", str(empty_core), "--dry-run"])
    assert rc == 1
    assert "build script not found" in capsys.readouterr().err


def test_main_never_pip_installs(core, fake_repo, monkeypatch):
    """Guard: the wrapper must never shell out to `pip install ... pianoid_cuda/`.

    We mock launch_build and assert the command it would run is the bat/sh, not pip.
    """
    captured = {}
    def fake_launch(cmd, log):
        captured["cmd"] = cmd
        log.write_text(f"{bp.SUCCESS_MARKER}\n", encoding="utf-8")
        return FakePopen([0])
    monkeypatch.setattr(bp, "launch_build", fake_launch)
    monkeypatch.setattr(bp, "stop_holders", lambda c: {"initial": [], "launcher_stopped": False,
                                                       "killed": [], "remaining": []})
    bp.run(core, heavy=True, variant="--both", log=core / "b.log", marker=None,
           do_stop=True, timeout=5, interval=0)
    joined = " ".join(captured["cmd"])
    assert "pip install" not in joined
    assert "build_pianoid_cuda" in joined
