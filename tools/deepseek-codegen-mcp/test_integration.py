"""Live integration test for delegate_codegen — makes ONE real DeepSeek call.

Auto-SKIPS unless a key is available AND outbound HTTPS works, so the suite stays green offline / in CI.

Key sourcing (in order): the DEEPSEEK_API_KEY env var, else the scratch file
D:\\tmp\\deepseek-phase0\\.env (outside every git repo — the key is NEVER stored in-repo). The key string
is never printed.

What it proves: delegate_codegen returns implementation TEXT for a simple, well-specified Python function,
and that text — written to a temp module and run against a test WE provide — passes. (This is the /fn
contract in miniature: DeepSeek writes the body; the caller applies + tests.)

Run:  <python> -m pytest tools/deepseek-codegen-mcp/test_integration.py -q
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

_SCRATCH_ENV = r"D:\tmp\deepseek-phase0\.env"


def _load_key():
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    if os.path.exists(_SCRATCH_ENV):
        with open(_SCRATCH_ENV, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DEEPSEEK_API_KEY="):
                    return line.split("=", 1)[1].strip()
    return ""


def _network_ok():
    import urllib.request
    try:
        urllib.request.urlopen(core.DEEPSEEK_BASE_URL, timeout=5)
        return True
    except Exception as e:
        # any HTTP response (even 4xx) means the host is reachable; only DNS/conn failures should skip
        return "HTTPError" in type(e).__name__


_KEY = _load_key()
pytestmark = pytest.mark.skipif(
    not _KEY, reason="no DEEPSEEK_API_KEY in env or scratch .env — skipping live integration test"
)


@pytest.fixture(autouse=True)
def _ensure_key_env(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", _KEY)


def test_live_delegate_codegen_produces_passing_code(tmp_path):
    if not _network_ok():
        pytest.skip("outbound HTTPS to api.deepseek.com is blocked — skipping live integration test")

    spec = (
        "def celsius_to_fahrenheit(c: float) -> float:\n"
        "    '''Convert a temperature in Celsius to Fahrenheit.'''"
    )
    test_src = (
        "def test_c2f():\n"
        "    assert celsius_to_fahrenheit(0) == 32.0\n"
        "    assert celsius_to_fahrenheit(100) == 212.0\n"
        "    assert abs(celsius_to_fahrenheit(37) - 98.6) < 1e-9\n"
    )

    result = core.delegate_codegen(
        function_spec=spec,
        test_or_signature=test_src,
        constraints="Pure function. Standard library only. Return a float.",
    )

    assert result["model"] == "deepseek-v4-flash"
    assert result["backend"] == "cloud"
    assert "celsius_to_fahrenheit" in result["code"]

    # Apply the returned code + the test to a temp module and run pytest against it (the /fn gate).
    mod = tmp_path / "candidate_c2f.py"
    mod.write_text(result["code"] + "\n\n" + test_src, encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", str(mod), "-q", "-p", "no:cacheprovider"],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, f"DeepSeek code failed the provided test:\n{proc.stdout}\n{proc.stderr}"


def test_live_cuda_request_is_refused_without_network():
    # The HC-1 backstop must fire BEFORE any network call — so this holds even with a real key present.
    with pytest.raises(core.CppCudaRefused):
        core.delegate_codegen(
            function_spec="implement the FDTD update as a CUDA __global__ kernel in Pianoid_synthesis.cu",
            test_or_signature="def test_k(): pass",
        )
