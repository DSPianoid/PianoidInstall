"""Core logic for the deepseek-codegen MCP server.

This module is **dependency-free** (standard library only) and contains NO MCP-protocol code, so the
unit tests can import and exercise it without installing `mcp` and without a network call. The thin MCP
stdio wrapper lives in `server.py` and calls `delegate_codegen()` here.

Design contract (from docs/proposals/deepseek-dev-pipeline-integration-2026-06-06.md, Architecture A):

- ONE capability: given a function spec + the Claude-written test (and optional constraints/context),
  ask DeepSeek to write the function BODY and return it as TEXT ONLY. This module never touches the
  filesystem, never commits — the `/fn` caller applies + builds + tests the returned code (HC-2/HC-3).
- Model is PINNED to `deepseek-v4-flash` (the cheap coding tier; the `deepseek-chat`/`deepseek-reasoner`
  aliases deprecate 2026-07-24), temperature 0.0 (DeepSeek's official coding-task recommendation).
- Defense-in-depth gate (HC-1): if the spec/constraints indicate C++/CUDA, REFUSE — those stay on
  Claude `/dev`. The PRIMARY gate is the `/fn` skill; this is a backstop.
- The API key is read ONLY from the environment (`DEEPSEEK_API_KEY`). It is never logged or returned.
- Robust: network/timeouts/API errors raise `DeepSeekError` with a clean message so the `/fn` caller
  can fall back to Claude codegen.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request

# --- Pinned configuration (one spot, per proposal §8 risk row) -------------------------------------
DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = "deepseek-v4-flash"  # PINNED — do not use the deprecating chat/reasoner aliases
DEEPSEEK_TEMPERATURE = 0.0            # DeepSeek's official coding temperature
DEFAULT_TIMEOUT_S = 90
DEFAULT_MAX_TOKENS = 4096

# Language → (human label for the prompt, markdown code-fence tag). Drives the prompt so a non-Python
# `language` actually targets that language (TS/JS/React via Jest, etc.). Unknown languages fall back to
# the raw `language` string + no fence tag. C/C++/CUDA are NOT here — they are refused (HC-1).
_LANG_LABELS = {
    "python": "Python", "py": "Python",
    "javascript": "JavaScript", "js": "JavaScript",
    "typescript": "TypeScript", "ts": "TypeScript",
    "jsx": "JavaScript (React/JSX)", "tsx": "TypeScript (React/TSX)",
    "react": "React",
}
_LANG_FENCE = {
    "python": "python", "py": "python",
    "javascript": "javascript", "js": "javascript",
    "typescript": "typescript", "ts": "typescript",
    "jsx": "jsx", "tsx": "tsx", "react": "tsx",
}

# Markers that flag a request as C++/CUDA → REFUSE (HC-1 backstop). Case-insensitive.
# Two ingredients: the source EXTENSIONS (each matched at a trailing word boundary so ".h" is caught
# before newline/period/comma/paren/EOS but "headers" — where "h" is followed by the word char "e" —
# is NOT) plus the unambiguous CUDA vocabulary. Kept deliberately tight to avoid false positives on
# ordinary Python that merely mentions, say, an HTTP "headers" dict.
#
# Per extension `ext`, the pattern is `\.ext\b`. `\b` after the last letter ensures the extension ENDS
# there, so `\.cu\b` does NOT swallow `.cuh` (which has its own term) and `\.h\b` does NOT swallow
# `.hpp` (its own term). "setup.py" is matched as a whole word.
_CPP_CUDA_EXTS = ("cu", "cuh", "cpp", "cc", "cxx", "hpp", "h")
_CPP_CUDA_WORDS = ("cuda", "__global__", "__device__", "nvcc", "cudamemcpy", "threadidx",
                   "blockidx", "kernel launch", "cuda kernel", "ptx")

_CPP_CUDA_RE = re.compile(
    "|".join([r"\." + ext + r"\b" for ext in _CPP_CUDA_EXTS]
             + [r"\bsetup\.py\b"]
             + [re.escape(w) for w in _CPP_CUDA_WORDS]),
    re.IGNORECASE,
)


class DeepSeekError(RuntimeError):
    """Raised on any failure to obtain a completion (missing key, network, timeout, non-200, bad body).

    The message is safe to surface to the caller; it never contains the API key."""


class CppCudaRefused(ValueError):
    """Raised when a delegation request looks like C++/CUDA work — must stay on Claude /dev (HC-1)."""


def _looks_like_cpp_cuda(language: str, *texts: str) -> bool:
    """True if the language or any of the spec/constraint texts indicate C++/CUDA work.

    Uses a single word-boundary regex (`_CPP_CUDA_RE`) so a source extension is caught regardless of
    the character that follows it (newline, period, comma, paren, end-of-string), while ordinary words
    like "headers" do not trip the `.h` term."""
    lang = (language or "").strip().lower()
    if lang in ("c", "c++", "cpp", "cuda", "cu", "c/c++"):
        return True
    blob = "\n".join(t for t in texts if t)
    return bool(_CPP_CUDA_RE.search(blob))


def _require_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise DeepSeekError(
            "DEEPSEEK_API_KEY is not set in the environment. The deepseek-codegen MCP server reads the "
            "key from the DEEPSEEK_API_KEY env var (set it in the ~/.claude.json server `env` block). "
            "No key was found — falling back to Claude codegen is appropriate."
        )
    return key


def build_messages(function_spec: str, test_or_signature: str, constraints: str = "",
                   context_snippets: str = "", language: str = "python") -> list[dict]:
    """Assemble the chat messages sent to DeepSeek. Pure — no network.

    Mirrors the Phase-0 spike prompt that scored 90% first-try: a strict system message ("return ONLY a
    single code block, no prose") + a user message carrying the spec, requirements/constraints, the
    Claude-written test, and any caller-curated context (NOT the whole repo)."""
    lang_label = _LANG_LABELS.get((language or "").strip().lower(), language or "the requested language")
    fence = _LANG_FENCE.get((language or "").strip().lower(), "")
    system = (
        f"You are an expert {lang_label} engineer. Implement EXACTLY the requested function. "
        f"Return ONLY a single {lang_label} code block containing complete, importable code "
        "(necessary imports + the function/export). No prose, no explanation, no example usage. "
        "Match the given signature and satisfy every requirement and the provided test."
    )
    parts = [f"Implement this function in {lang_label}.", "", "SIGNATURE / SPEC:", function_spec.strip()]
    if constraints and constraints.strip():
        parts += ["", "REQUIREMENTS / CONSTRAINTS:", constraints.strip()]
    if context_snippets and context_snippets.strip():
        parts += ["", "CONTEXT (surrounding patterns — do NOT re-implement these, use them):",
                  context_snippets.strip()]
    parts += [
        "",
        "It must satisfy this test (write the implementation so the test passes — do NOT modify the test "
        "and do NOT include the test in your output):",
        "```" + fence,
        test_or_signature.strip(),
        "```",
        "",
        f"Return only the implementation as one {lang_label} code block.",
    ]
    user = "\n".join(parts)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# Match a fenced block with ANY language tag (```python / ```typescript / ```tsx / ```jsx / ```js / …)
# or a bare ``` fence — `[^\n]*` swallows the optional language token on the opening line.
_CODE_FENCE = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)


def extract_code(text: str) -> str:
    """Pull the implementation out of the model reply. Prefer the largest fenced code block (any language
    tag); if there is no fence, return the stripped text (the model occasionally returns bare code)."""
    matches = _CODE_FENCE.findall(text or "")
    if matches:
        return max(matches, key=len).strip()
    return (text or "").strip()


def _post_chat_completion(messages: list[dict], timeout_s: int, max_tokens: int) -> dict:
    """POST to DeepSeek's OpenAI-compatible /chat/completions. Returns the parsed JSON. Stdlib only.

    Raises DeepSeekError on missing key, network failure, timeout, or non-200."""
    key = _require_key()
    body = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": DEEPSEEK_TEMPERATURE,
        "max_tokens": max_tokens,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(DEEPSEEK_BASE_URL.rstrip("/") + "/chat/completions",
                                 data=data, method="POST")
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read().decode("utf-8")
        return json.loads(raw)
    except urllib.error.HTTPError as e:  # non-2xx
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:500]
        except Exception:
            pass
        raise DeepSeekError(f"DeepSeek API returned HTTP {e.code}. {detail}".strip()) from None
    except urllib.error.URLError as e:
        raise DeepSeekError(f"DeepSeek API network error: {e.reason}") from None
    except (TimeoutError, OSError) as e:
        raise DeepSeekError(f"DeepSeek API call failed: {type(e).__name__}: {e}") from None
    except json.JSONDecodeError as e:
        raise DeepSeekError(f"DeepSeek API returned non-JSON body: {e}") from None


def delegate_codegen(function_spec: str, test_or_signature: str, constraints: str = "",
                     context_snippets: str = "", language: str = "python",
                     backend: str = "cloud", timeout_s: int = DEFAULT_TIMEOUT_S,
                     max_tokens: int = DEFAULT_MAX_TOKENS) -> dict:
    """Ask DeepSeek to implement a single function and return the code as TEXT.

    Returns a dict: {"code": str, "model": str, "backend": str, "tokens": {...}, "latency_ms": int}.
    The tool NEVER writes files — the /fn caller applies, builds, and tests the returned code.

    Raises:
      CppCudaRefused — the request looks like C++/CUDA work (HC-1 backstop; keep on Claude /dev).
      DeepSeekError  — missing key / network / timeout / non-200 / unusable body (so /fn falls back).
      NotImplementedError — backend="local" (Ollama) is a documented TODO, not built yet.
    """
    if not function_spec or not function_spec.strip():
        raise DeepSeekError("function_spec is empty — nothing to implement.")
    if not test_or_signature or not test_or_signature.strip():
        # HC-2: never delegate without the test in hand.
        raise DeepSeekError(
            "test_or_signature is empty. delegate_codegen requires the Claude-written test (or at least "
            "the exact signature) so the model codes to the spec — refusing to delegate without it."
        )

    if backend == "local":
        raise NotImplementedError(
            "backend='local' (Ollama) is a documented TODO and is not built yet. Use backend='cloud' "
            "(the default), or have Claude implement the function directly."
        )
    if backend != "cloud":
        raise DeepSeekError(f"Unknown backend {backend!r}. Supported: 'cloud' (default); 'local' is a TODO.")

    # HC-1 defense-in-depth gate. (Python + JS/TS/React are eligible; C++/CUDA is the hard exclusion.)
    if _looks_like_cpp_cuda(language, function_spec, constraints, context_snippets):
        raise CppCudaRefused(
            "This request appears to involve C++/CUDA (.cu/.cpp/.cuh/.h/setup.py or CUDA kernel work). "
            "delegate_codegen excludes C++/CUDA by policy (HC-1) — keep those on Claude /dev, which "
            "handles the CUDA build and the data-model reasoning. (Python and JS/TS/React ARE eligible.)"
        )

    messages = build_messages(function_spec, test_or_signature, constraints, context_snippets, language)
    t0 = time.time()
    payload = _post_chat_completion(messages, timeout_s=timeout_s, max_tokens=max_tokens)
    latency_ms = int((time.time() - t0) * 1000)

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise DeepSeekError(f"DeepSeek response missing choices/message/content: {e}") from None

    code = extract_code(content)
    if not code:
        raise DeepSeekError("DeepSeek returned an empty implementation.")

    usage = payload.get("usage") or {}
    return {
        "code": code,
        "model": payload.get("model", DEEPSEEK_MODEL),
        "backend": backend,
        "tokens": {
            "prompt": usage.get("prompt_tokens"),
            "completion": usage.get("completion_tokens"),
            "total": usage.get("total_tokens"),
        },
        "latency_ms": latency_ms,
    }


def to_tool_result(**kwargs) -> dict:
    """Run delegate_codegen and map outcomes to a status dict for the MCP tool layer.

    Never raises to the model: a policy refusal → status "refused", any failure → status "error", so the
    /fn caller can transparently fall back to Claude codegen. Kept here (dependency-free) so the
    error→status mapping is unit-testable without importing `mcp`. `server.py` is a thin pass-through."""
    try:
        result = delegate_codegen(**kwargs)
        result["status"] = "ok"
        return result
    except CppCudaRefused as e:
        return {"status": "refused", "reason": str(e)}
    except NotImplementedError as e:
        return {"status": "refused", "reason": str(e)}
    except DeepSeekError as e:
        return {"status": "error", "reason": str(e)}
    except Exception as e:  # defensive: never crash on an unexpected input
        return {"status": "error", "reason": f"Unexpected {type(e).__name__}: {e}"}
