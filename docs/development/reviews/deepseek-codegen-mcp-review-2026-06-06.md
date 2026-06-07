# Local Code Review — deepseek-codegen MCP server (2026-06-06)

**Scope:** `tools/deepseek-codegen-mcp/` (branch `feature/deepseek-codegen-mcp`, uncommitted).
**Level:** Local (read-only). Reviewed against `docs/development/CODE_QUALITY.md`.
**Reviewer focus (security/safety-critical tooling that generates code applied into the repo):** secret
safety, HC-1 CUDA refusal gate, never-writes-files, `to_tool_result` never-raises, model pin/temp,
general quality.

**Verdict:** Strong, well-structured, well-tested. **One Medium finding** (a real but narrow bypass gap
in the HC-1 gate for plain `.h` references). Everything else is clean and verified by measurement. The
two highest-stakes contracts — secret never leaks, and `to_tool_result` never raises — both hold under
adversarial probing.

---

### Top 5 Files in Scope by LOC
| # | File | LOC | Flag |
|---|------|-----|------|
| 1 | core.py | 245 | — |
| 2 | test_core.py | 233 | — |
| 3 | README.md | 129 | — (doc) |
| 4 | test_integration.py | 104 | — |
| 5 | server.py | 90 | — |

All well under the 500 YELLOW threshold. No god-object risk. Clean concern split: `core.py` =
dependency-free logic, `server.py` = thin MCP protocol surface, tests separated into no-network unit vs
live integration.

### Architectural Consistency
Layer audit: **PASS** — this is standalone tooling under `tools/`, not one of the 4 runtime layers. It
calls out to the DeepSeek HTTP API via stdlib `urllib` only; no import of any Pianoid layer; no reach into
middleware/engine/frontend. C6 directory placement correct (`tools/`).
Server audit: **N/A** — not part of the 5000/5001 backend split.

### Authority Violations (P1)
None. The tool is pure compute-in / text-out; it owns no persistent state. The API key has exactly one
source (env `DEEPSEEK_API_KEY`), read in one place (`_require_key`). Model/temp pinned in one spot
(`core.py` constants). No second source of truth introduced.

### Concern Violations (P2)
None. `core.py` has one concern (turn a function spec + test into DeepSeek-generated code text, with
gates). `server.py` has one concern (expose it as one MCP tool). Functions are small and single-purpose.

### Patch / Workaround Findings
TODO/FIXME/HACK count in scope: **1** — `backend="local"` (Ollama) is a *documented, owned* TODO that is
actively refused at runtime with a clear message (`NotImplementedError` → `status:"refused"`) and tracked
in the proposal §3B/§5 and README. This is the correct form of a deferred path (S5-compliant: it fails
fast and explicitly, it is not a silent dead branch). **Not a finding.**

No silent exception handlers that mask real errors. The two broad catches are both justified:
- `core.py:148-151` `try: detail = e.read()...; except Exception: pass` — best-effort enrichment of an
  error message that is *already* being raised; swallowing the read-failure is correct (we still raise
  `DeepSeekError` with the HTTP code). OK.
- `core.py:244` `except Exception` in `to_tool_result` — **intentional and required** by the contract
  ("never raises to the model"). It maps to `status:"error"`. OK.

No sleeps, no legacy shims, no compatibility-for-removed-feature code.

---

## Findings

| # | Principle | Severity | Confidence | File:Line | Description |
|---|-----------|----------|-----------|-----------|-------------|
| 1 | S5b / HC-1 | **Medium** | 95 | core.py:40,63 | HC-1 gate misses plain `.h` references not followed by a space or end-of-string. |
| 2 | S1 | Low | 80 | test_core.py:113 | Dead/confused assertion `out["status"] if "status" in out else True` — always truthy; asserts nothing. |
| 3 | Doc/N | Low | 70 | README.md:40 | README says "26 unit tests"; that matches today, but the count is brittle if tests are added. Minor. |

### Finding 1 (Medium) — HC-1 `.h` boundary gap

`_CPP_CUDA_EXT` includes `".h "` (with a trailing space) deliberately, to avoid false-positiving on
words like "the" / "graph". The matcher pads the blob with a single trailing space
(`padded = blob + " "`) so `".h "` matches when `.h` is the **last token** or is **followed by a space**.

**Gap:** a `.h` reference followed by any *other* delimiter is NOT caught. Verified by direct probe of
`_looks_like_cpp_cuda`:

| Input | Result | Expected |
|---|---|---|
| `"edit foo.h please"` (space after) | REFUSE | refuse ✓ |
| `"edit the file kernels.h"` (end of string) | REFUSE | refuse ✓ |
| `"edit kernels.h\nmore"` (newline) | **PASS** | refuse ✗ |
| `"see kernels.h."` (period) | **PASS** | refuse ✗ |
| `"edit kernels.h, then"` (comma) | **PASS** | refuse ✗ |
| `"edit (kernels.h)"` (paren) | **PASS** | refuse ✗ |

This is precisely a `.h` header-file reference — the exact thing the gate is meant to refuse. The other
extensions (`.cu`, `.cuh`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `setup.py`) are bare-substring matches and ARE
robust to trailing punctuation/newlines (verified: `a.cu,y`, `a.cuh\nx`, `a.cpp)` all REFUSE). Only plain
`.h` has the fragility, because it is the only token that needed boundary protection.

**Severity rationale — Medium, not High:** HC-1 here is explicitly a *defense-in-depth backstop*; the
proposal/README state the **primary** gate is the `/fn` skill's eligibility check, and `language` plus the
CUDA-vocab list (`cuda`, `__global__`, etc.) catch the overwhelming majority of real C/C++/CUDA requests.
A bare `.h` mention with no other CUDA signal AND a `language` that isn't C/C++ is a narrow miss. But the
file-extension list is the gate's most concrete promise (it literally enumerates `.cu/.cpp/.cuh/.h/
setup.py`), and a header-only refactor request ("port the declarations in `foo.h`") could slip through —
so it is a real correctness gap, not cosmetic.

**Suggested fix (for the eventual `/dev` pass, not applied here):** treat `.h` like the others with a
proper boundary check rather than space-padding — e.g. a small regex
`re.search(r"\.h\b", blob)` (word-boundary, case-insensitive) for the `.h` case, or a regex alternation
over all extensions `\.(cu|cuh|cpp|cc|cxx|hpp|h)\b`. A regex over `\b` catches newline/period/comma/paren
while still not matching "the"/"graph". Add the four missed delimiter cases to
`test_cpp_cuda_requests_are_refused`.

### Finding 2 (Low) — dead assertion in unit test

`test_core.py:113`:
```python
assert out["status"] if "status" in out else True  # core returns no status; server adds it
```
`core.delegate_codegen` returns no `status` key (it is `to_tool_result`/the server that adds it), so the
ternary always evaluates to `True` → the assertion can never fail and tests nothing. The line's own
comment acknowledges this. It is harmless but is dead per S1. The meaningful assertion on the next line
(`"def f()" in out["code"]`) already covers the case. Suggest deleting line 113.

### Finding 3 (Low) — README test-count will drift

README.md:40 and the file table cite "26 unit tests". True today (verified: `26 passed`), but a hardcoded
count goes stale on the next test added. Cosmetic; optional to soften to "unit tests (no network)".

---

## Verified-clean checklist (the reviewer's special-attention items)

1. **SECRET SAFETY — PASS (high confidence, adversarially probed).**
   - Key is read only from env in `_require_key` (core.py:70-78); never hardcoded.
   - No `print` / `logging` / `sys.stderr.write` / `repr` of the key anywhere in `core.py` (grep-verified).
   - The key appears in exactly one outbound spot: `req.add_header("Authorization", f"Bearer {key}")`
     (core.py:140). It is never placed in `body`, the returned dict, or any exception message.
   - **Error paths cannot leak it.** Probed with a canary key + forced HTTPError/URLError: the HTTPError
     branch surfaces only `e.code` + `e.read()` (the response body, not the request), the URLError branch
     surfaces only `e.reason`. Canary string absent from every `status:"error"` reason. The missing-key
     message contains no key by construction (and a unit test asserts `"sk-" not in message`).
   - All network raises use `from None`, suppressing the exception chain so the `req` object (which holds
     the `Authorization` header) cannot resurface in a `__cause__` traceback. Good hygiene.
   - `to_tool_result` returns only `code`/`model`/`backend`/`tokens`/`latency_ms`/`status`/`reason` —
     none derived from the key.

2. **HC-1 REFUSAL GATE — PASS with one Medium gap (Finding 1).**
   - Case-insensitive: `language` lowercased; blob lowercased. `.CU`, `setup.PY`, `Cuda`, `__GLOBAL__`
     all REFUSE (probed).
   - Path variations: backslash paths (`PianoidCore\pianoid_cuda\Pianoid.cu`) REFUSE.
   - `language` enum covers `c/c++/cpp/cuda/cu/c/c++`.
   - The CUDA-vocab list catches `__global__`, `__device__`, `nvcc`, `cudamemcpy`, `threadidx`, etc.
   - The deliberate non-false-positive on HTTP "headers" / "header" works (probed: both PASS).
   - **Gap:** plain `.h` + non-space delimiter (Finding 1). All other extensions robust.
   - The backstop fires **before** any network call (delegate_codegen checks the gate at line 193, before
     `_post_chat_completion`); `test_integration.py:98` asserts this with a real-key-present path.

3. **NEVER-WRITES-FILES — PASS.**
   - `core.py` imports `json, os, re, time, urllib`. `os` is used only for `os.environ.get`. No `open`,
     no `pathlib`, no `shutil`, no `subprocess`, no write of any kind (grep-verified).
   - `server.py` imports `os, sys, core, mcp`. `os`/`sys` used only for `sys.path` setup + the import
     guard. The single tool delegates to `core.to_tool_result` and returns its dict. No filesystem write.
   - The contract ("the /fn caller applies + builds + tests") is documented in both files and the README,
     and the code matches it: the tool returns code as text only.
   - (Note: `test_integration.py` does write a temp module + run pytest — that is the *test harness*
     simulating the /fn apply step, not the server. Correct and isolated to `tmp_path`.)

4. **`to_tool_result` NEVER RAISES + clean network handling — PASS (adversarially probed).**
   - Probed with `None` spec, `int` spec, `None` language, missing required kwargs, and a bad
     `timeout_s` type — every case returned a clean `status:"error"` dict, never raised.
   - The `except Exception` catch-all (core.py:244) is the safety net; the specific `CppCudaRefused`/
     `NotImplementedError`/`DeepSeekError` branches map to `refused`/`error` first.
   - urllib call has `timeout=timeout_s` wired through (core.py:143; default 90s, DEFAULT_TIMEOUT_S=33→
     actually 90). Network failure (`URLError`), timeout (`TimeoutError`/`OSError`), non-200
     (`HTTPError`), and malformed body (`JSONDecodeError`, plus the `KeyError/IndexError/TypeError` guard
     on `choices[0].message.content` at core.py:207, plus the empty-code guard at 211) are all handled and
     converted to `DeepSeekError` → `status:"error"`.

5. **MODEL PIN + TEMP — PASS.**
   - `DEEPSEEK_MODEL = "deepseek-v4-flash"` (core.py:31), `DEEPSEEK_TEMPERATURE = 0.0` (core.py:32),
     both in one spot. Sent in the request body (core.py:132-135). Unit tests assert both
     (`test_model_is_pinned_to_v4_flash`, `test_temperature_is_zero_for_coding`). README/proposal note the
     deprecating `deepseek-chat`/`deepseek-reasoner` aliases are intentionally avoided.
   - `DEEPSEEK_BASE_URL` is env-overridable (defaults to the official host) — reasonable for the
     future Ollama/local backend; not a pin violation since model+temp are the correctness-relevant pins.

6. **GENERAL QUALITY — PASS.**
   - Clear module/function docstrings; the design contract is restated at the top of each file.
   - No dead code except Finding 2. No duplication. Sane structure (gate → build prompt → POST → extract
     → shape result). Naming follows N1 (snake_case, UPPER_SNAKE constants, PascalCase exceptions).
   - Tests genuinely cover the gates: model pin, temp, prompt shape, code extraction (fence/largest-fence/
     bare fallback), HC-1 refusal (6 parametrized C++/CUDA cases + the headers non-false-positive),
     missing-key (incl. "no secret in message"), empty spec, empty test (HC-2), local-backend TODO,
     unknown backend, success-dict shape, empty-completion, and the full `to_tool_result` status mapping.
     26/26 pass in 0.05s with no network.

---

### Summary
**Pass with one Medium finding.** 3 findings total (0 Critical, 0 High, 1 Medium, 2 Low). The
security/safety-critical contracts (secret never leaks; never writes files; `to_tool_result` never raises;
model/temp pinned; HC-1 fires before network) all hold under direct adversarial probing. The single
substantive issue is the HC-1 `.h`-boundary gap (Finding 1) — a narrow backstop miss, mitigated by the
primary `/fn` gate and the language/CUDA-vocab checks, but worth tightening with a `\b`-boundary regex
before this lands. Recommend addressing Finding 1 and Finding 2 in the `/dev` pass that commits this; the
Lows are optional.
