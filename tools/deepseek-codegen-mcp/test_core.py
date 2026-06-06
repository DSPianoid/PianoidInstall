"""Unit tests for the deepseek-codegen MCP server core (no network, no `mcp` package required).

Run from this directory:
    <python> -m pytest tools/deepseek-codegen-mcp/test_core.py -q

Network is exercised only by test_integration.py (separate file, auto-skips without a key/network).
These unit tests monkeypatch the HTTP layer so they NEVER make a real call.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


# --------------------------------------------------------------------------------------------------
# Model-pin + temperature (the one config spot)
# --------------------------------------------------------------------------------------------------
def test_model_is_pinned_to_v4_flash():
    assert core.DEEPSEEK_MODEL == "deepseek-v4-flash"  # NOT the deprecating chat/reasoner aliases


def test_temperature_is_zero_for_coding():
    assert core.DEEPSEEK_TEMPERATURE == 0.0


# --------------------------------------------------------------------------------------------------
# Prompt construction
# --------------------------------------------------------------------------------------------------
def test_build_messages_shape_and_content():
    msgs = core.build_messages(
        function_spec="def add(a, b): ...",
        test_or_signature="def test_add():\n    assert add(1, 2) == 3",
        constraints="must handle ints",
        context_snippets="# nearby helper",
        language="python",
    )
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert "ONLY a single Python code block" in msgs[0]["content"]
    user = msgs[1]["content"]
    assert "def add(a, b): ..." in user
    assert "must handle ints" in user
    assert "# nearby helper" in user
    assert "def test_add()" in user
    # the model is told not to emit the test
    assert "do NOT include the test in your output" in user


def test_build_messages_omits_empty_optional_sections():
    msgs = core.build_messages("def f(): ...", "def test_f(): assert f() is None")
    user = msgs[1]["content"]
    assert "REQUIREMENTS / CONSTRAINTS" not in user
    assert "CONTEXT" not in user


def test_build_messages_typescript_targets_ts_not_python():
    msgs = core.build_messages(
        function_spec="export function add(a: number, b: number): number",
        test_or_signature="test('add', () => { expect(add(1,2)).toBe(3); });",
        language="typescript",
    )
    system = msgs[0]["content"]
    user = msgs[1]["content"]
    # the prompt must target TypeScript, NOT Python
    assert "TypeScript" in system
    assert "Python" not in system
    assert "Implement this function in TypeScript." in user
    assert "```typescript" in user        # test fenced as typescript, not python
    assert "Return only the implementation as one TypeScript code block." in user


def test_build_messages_javascript_and_react_labels():
    js = core.build_messages("function f(){}", "test('f',()=>{})", language="js")
    assert "JavaScript" in js[0]["content"]
    assert "```javascript" in js[1]["content"]
    tsx = core.build_messages("export const C = () => <div/>", "render(<C/>)", language="tsx")
    assert "TSX" in tsx[0]["content"] or "React" in tsx[0]["content"]
    assert "```tsx" in tsx[1]["content"]


def test_extract_code_typescript_fence():
    text = "Here:\n```typescript\nexport function add(a:number,b:number){return a+b;}\n```\n"
    assert core.extract_code(text) == "export function add(a:number,b:number){return a+b;}"


def test_extract_code_jsx_fence():
    text = "```jsx\nexport const X = () => <div>hi</div>;\n```"
    assert "export const X" in core.extract_code(text)


# --------------------------------------------------------------------------------------------------
# Code extraction
# --------------------------------------------------------------------------------------------------
def test_extract_code_from_fence():
    text = "Here you go:\n```python\ndef f():\n    return 1\n```\nDone."
    assert core.extract_code(text) == "def f():\n    return 1"


def test_extract_code_picks_largest_fence():
    text = "```python\nimport os\n```\nthen\n```python\ndef big():\n    return os.getpid()\n```"
    assert "def big()" in core.extract_code(text)


def test_extract_code_bare_fallback():
    assert core.extract_code("def f():\n    return 2") == "def f():\n    return 2"


# --------------------------------------------------------------------------------------------------
# HC-1 C++/CUDA refusal backstop
# --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("kwargs", [
    {"language": "cpp"},
    {"language": "cuda"},
    {"function_spec": "implement a CUDA kernel for the FDTD update"},
    {"constraints": "edit Pianoid_synthesis.cu to add a __global__ launch"},
    {"function_spec": "patch setup.py build flags"},
    {"context_snippets": "// from Kernels.cuh\n__device__ float step(...)"},
    # .h at non-space boundaries (newline / period / comma / paren) — the MEDIUM review finding
    {"constraints": "see kernels.h\nmore"},
    {"constraints": "edit kernels.h."},
    {"constraints": "touch kernels.h, then build"},
    {"context_snippets": "(kernels.h)"},
    {"function_spec": "modify constants.h"},          # .h at end-of-string
    {"constraints": "update Pianoid.cuh"},            # .cuh must still refuse
    {"constraints": "edit AddArraysWithCUDA.cpp"},    # .cpp at end-of-string
])
def test_cpp_cuda_requests_are_refused(monkeypatch, kwargs):
    # ensure a key is present so the refusal is what trips, not the missing-key guard
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    base = dict(function_spec="def f(): ...", test_or_signature="def test_f(): assert f() is None")
    base.update(kwargs)
    with pytest.raises(core.CppCudaRefused):
        core.delegate_codegen(**base)


def test_ordinary_python_mentioning_headers_is_not_refused(monkeypatch):
    # "headers" (HTTP dict) must NOT trip the C++ .h gate; we stop before the network via a stub
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    called = {}

    def fake_post(messages, timeout_s, max_tokens):
        called["yes"] = True
        return {"choices": [{"message": {"content": "```python\ndef f():\n    return {}\n```"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                "model": "deepseek-v4-flash"}

    monkeypatch.setattr(core, "_post_chat_completion", fake_post)
    out = core.delegate_codegen(
        function_spec="def build_headers(token): return a dict of HTTP headers",
        test_or_signature="def test_h(): assert isinstance(build_headers('x'), dict)",
    )
    assert called.get("yes") is True
    assert "def f()" in out["code"]
    assert "status" not in out  # core.delegate_codegen returns no status key; the server layer adds it


# --------------------------------------------------------------------------------------------------
# Missing key / empty inputs / backend guards
# --------------------------------------------------------------------------------------------------
def test_missing_key_raises_deepseek_error(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(core.DeepSeekError) as ei:
        core.delegate_codegen(function_spec="def f(): ...",
                              test_or_signature="def test_f(): assert f() is None")
    assert "DEEPSEEK_API_KEY" in str(ei.value)


def test_missing_key_message_has_no_secret(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(core.DeepSeekError) as ei:
        core.delegate_codegen(function_spec="def f(): ...", test_or_signature="def t(): pass")
    assert "sk-" not in str(ei.value)


def test_empty_spec_refused(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    with pytest.raises(core.DeepSeekError):
        core.delegate_codegen(function_spec="   ", test_or_signature="def t(): pass")


def test_empty_test_refused(monkeypatch):
    # HC-2: never delegate without the test in hand
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    with pytest.raises(core.DeepSeekError) as ei:
        core.delegate_codegen(function_spec="def f(): ...", test_or_signature="")
    assert "test" in str(ei.value).lower()


def test_local_backend_is_todo(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    with pytest.raises(NotImplementedError):
        core.delegate_codegen(function_spec="def f(): ...",
                              test_or_signature="def t(): pass", backend="local")


def test_unknown_backend_errors(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    with pytest.raises(core.DeepSeekError):
        core.delegate_codegen(function_spec="def f(): ...",
                              test_or_signature="def t(): pass", backend="banana")


# --------------------------------------------------------------------------------------------------
# Happy path with a stubbed HTTP layer (no network) — verifies the success-dict shape
# --------------------------------------------------------------------------------------------------
def test_success_returns_code_and_metadata(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")

    def fake_post(messages, timeout_s, max_tokens):
        # also assert the pinned model + temp made it into the body indirectly by checking call args type
        assert isinstance(messages, list) and messages[0]["role"] == "system"
        return {
            "choices": [{"message": {"content": "```python\ndef add(a, b):\n    return a + b\n```"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "model": "deepseek-v4-flash",
        }

    monkeypatch.setattr(core, "_post_chat_completion", fake_post)
    out = core.delegate_codegen(function_spec="def add(a, b): ...",
                                test_or_signature="def test_add(): assert add(1,2)==3")
    assert out["code"] == "def add(a, b):\n    return a + b"
    assert out["model"] == "deepseek-v4-flash"
    assert out["backend"] == "cloud"
    assert out["tokens"] == {"prompt": 10, "completion": 5, "total": 15}
    assert isinstance(out["latency_ms"], int)


def test_empty_completion_raises(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    monkeypatch.setattr(core, "_post_chat_completion",
                        lambda messages, timeout_s, max_tokens:
                        {"choices": [{"message": {"content": "   "}}], "usage": {}})
    with pytest.raises(core.DeepSeekError):
        core.delegate_codegen(function_spec="def f(): ...", test_or_signature="def t(): pass")


# --------------------------------------------------------------------------------------------------
# to_tool_result — the status-mapping the MCP tool layer uses (dependency-free; never raises)
# --------------------------------------------------------------------------------------------------
def test_tool_result_refused_for_cuda(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    out = core.to_tool_result(function_spec="write a CUDA kernel", test_or_signature="def t(): pass")
    assert out["status"] == "refused"
    assert "C++/CUDA" in out["reason"]


def test_cuda_refused_regardless_of_language(monkeypatch):
    # The HC-1 gate must fire even when language is a permitted one (e.g. typescript) but the spec is C/CUDA.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    for lang in ("typescript", "javascript", "tsx", "python"):
        with pytest.raises(core.CppCudaRefused):
            core.delegate_codegen(
                function_spec="edit Pianoid_synthesis.cu to add a __global__ kernel",
                test_or_signature="def t(): pass", language=lang,
            )
    # and a .h spec under a JS language still refuses
    with pytest.raises(core.CppCudaRefused):
        core.delegate_codegen(function_spec="patch constants.h", test_or_signature="x", language="js")


def test_tool_result_error_for_missing_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    out = core.to_tool_result(function_spec="def f(): ...", test_or_signature="def t(): pass")
    assert out["status"] == "error"
    assert "DEEPSEEK_API_KEY" in out["reason"]
    assert "sk-" not in out["reason"]


def test_tool_result_refused_for_local_backend(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    out = core.to_tool_result(function_spec="def f(): ...", test_or_signature="def t(): pass",
                              backend="local")
    assert out["status"] == "refused"
    assert "local" in out["reason"].lower() or "ollama" in out["reason"].lower()


def test_tool_result_ok_on_success(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-not-real-unit-test")
    monkeypatch.setattr(core, "_post_chat_completion",
                        lambda messages, timeout_s, max_tokens:
                        {"choices": [{"message": {"content": "```python\ndef f():\n    return 7\n```"}}],
                         "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
                         "model": "deepseek-v4-flash"})
    out = core.to_tool_result(function_spec="def f(): ...", test_or_signature="def t(): assert f()==7")
    assert out["status"] == "ok"
    assert "def f()" in out["code"]
    assert out["model"] == "deepseek-v4-flash"
