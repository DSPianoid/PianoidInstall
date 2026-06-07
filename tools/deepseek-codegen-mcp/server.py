"""deepseek-codegen MCP server — exposes ONE tool, `delegate_codegen`.

Architecture A of docs/proposals/deepseek-dev-pipeline-integration-2026-06-06.md: a tiny local stdio MCP
server that wraps DeepSeek's OpenAI-compatible API so the `/fn` skill can offload the *codegen step only*
for well-defined single functions in Python or JS/TS/React (any language with a fast isolated test gate;
C++/CUDA excluded). DeepSeek writes the function body; Claude (the `/fn` caller) reviews it, applies it,
builds, and runs the Claude-written test (the verification gate is unchanged — HC-2/HC-3).

Run (stdio):  python tools/deepseek-codegen-mcp/server.py
Registered in ~/.claude.json under mcpServers."deepseek-codegen" (see README.md). The API key is read
from the DEEPSEEK_API_KEY environment variable — NEVER hardcoded, NEVER committed.

All real logic lives in `core.py` (dependency-free, unit-tested without `mcp` or a network call). This
file is only the MCP protocol surface.
"""
from __future__ import annotations

import os
import sys

# Make `core` importable whether launched as a script (cwd anywhere) or as a module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import core  # noqa: E402  (after sys.path tweak)

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:  # pragma: no cover - exercised only when the server is actually launched
    sys.stderr.write(
        "deepseek-codegen: the `mcp` package is not installed. Install it into the interpreter that runs "
        "this server, e.g.:\n"
        "    <python> -m pip install mcp\n"
        "(see tools/deepseek-codegen-mcp/requirements.txt and README.md).\n"
    )
    raise

mcp = FastMCP("deepseek-codegen")


@mcp.tool()
def delegate_codegen(
    function_spec: str,
    test_or_signature: str,
    constraints: str = "",
    context_snippets: str = "",
    language: str = "python",
    backend: str = "cloud",
) -> dict:
    """Delegate a SINGLE function's implementation to DeepSeek and return the code as TEXT.

    Use this from the /fn skill's "edit code" step ONLY for a simple, pure, well-specified single function
    in Python or JS/TS/React (any language with a fast isolated test gate), AFTER the Claude-written test
    exists. DeepSeek writes the function body; YOU (Claude) must review the returned code, apply it via
    Edit/Write, then build and run the test. This tool never writes files, never commits. If the returned
    code is unusable or fails the test, fall back to writing the function yourself.

    HARD EXCLUSION (HC-1): never use this for C++/CUDA (.cu/.cpp/.cuh/.h/setup.py or CUDA kernel work) —
    those stay on Claude /dev. The tool refuses such requests as a backstop, regardless of `language`.

    Args:
        function_spec: The function signature + a description of its behaviour.
        test_or_signature: The Claude-written test (pytest / Jest / etc. — or at minimum the exact
            signature) the implementation must satisfy. REQUIRED — the tool refuses to delegate without it.
        constraints: Optional acceptance criteria / requirements text.
        context_snippets: Optional caller-curated surrounding code/patterns (NOT the whole repo).
        language: Target language — "python" (default), "javascript"/"js", "typescript"/"ts",
            "jsx"/"tsx"/"react", etc. Drives the prompt + output language. C/C++/CUDA are refused.
        backend: "cloud" (default — DeepSeek API). "local" (Ollama) is a documented TODO, not built.

    Returns:
        On success: {"status": "ok", "code": <implementation text>, "model": ..., "backend": ...,
                     "tokens": {...}, "latency_ms": ...}.
        On a policy refusal or any failure: {"status": "refused"|"error", "reason": <message>} — so the
        caller can transparently fall back to Claude codegen. (The tool does not raise to the model.)
    """
    return core.to_tool_result(
        function_spec=function_spec,
        test_or_signature=test_or_signature,
        constraints=constraints,
        context_snippets=context_snippets,
        language=language,
        backend=backend,
    )


def main() -> None:
    mcp.run()  # stdio transport (default)


if __name__ == "__main__":
    main()
