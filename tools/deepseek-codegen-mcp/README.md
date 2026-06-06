# deepseek-codegen MCP server

A tiny local **stdio MCP server** that exposes ONE tool, `delegate_codegen`, wrapping DeepSeek's
OpenAI-compatible API. It lets the **`/fn`** skill offload the *codegen step only* — drafting a single,
well-defined, **Python-only** function body — to the cheap `deepseek-v4-flash` model, while Claude keeps
ownership of everything that determines correctness (test authoring, review, build, test run, debug,
commit, docs).

This is **Architecture A** of
[`docs/proposals/deepseek-dev-pipeline-integration-2026-06-06.md`](../../docs/proposals/deepseek-dev-pipeline-integration-2026-06-06.md).
Phase-0 quality spike result that gated this build: **90 % first-try / 100 % with one retry** on 10
representative `/fn`-style tasks.

## What it does (and does NOT do)

- `delegate_codegen(function_spec, test_or_signature, …)` → returns the function implementation as
  **TEXT** plus metadata. It **never writes files, never commits, never branches.** The `/fn` caller
  applies the returned code via `Edit`/`Write`, then builds and runs the **Claude-written** test.
- The verification gate is unchanged: a bad DeepSeek body simply fails the test Claude wrote and Claude
  runs → fall back to Claude codegen. Token savings are best-effort; correctness is guaranteed downstream.

## Hard gates

| Gate | Behaviour |
|---|---|
| **HC-1 — C++/CUDA stays on Claude `/dev`** | If the spec/constraints/context indicate `.cu/.cpp/.cuh/.h/setup.py` or CUDA kernel work (or `language` is C/C++/CUDA), the tool **REFUSES** (`status: "refused"`). This is a defense-in-depth backstop — the **primary** gate is the `/fn` skill's eligibility check. |
| **HC-2 — test required** | `delegate_codegen` refuses if `test_or_signature` is empty — never delegate without the test in hand. |
| **HC-3 — no side effects** | Pure compute-in / text-out. No filesystem, git, or doc access. |
| **HC-4 — no permission stall** | Plain MCP tool; allow-list `mcp__deepseek-codegen__*` (one-time, in `.claude/settings.local.json`). |
| **Model pin** | `deepseek-v4-flash` (the cheap coding tier), temperature `0.0`. The deprecating `deepseek-chat`/`deepseek-reasoner` aliases are **not** used (they retire 2026-07-24). Pinned in one spot: `core.py`. |
| **Secret** | The API key is read **only** from the `DEEPSEEK_API_KEY` environment variable. It is never hardcoded, never committed, never logged, never returned. |

## Files

| File | Purpose |
|---|---|
| `core.py` | Dependency-free logic (gate, prompt build, DeepSeek call via stdlib `urllib`, code extraction, status mapping). Unit-tested with **no** `mcp` install and **no** network. |
| `server.py` | Thin MCP stdio wrapper (`FastMCP`) exposing the single `delegate_codegen` tool. Imports `mcp` lazily. |
| `requirements.txt` | `mcp` (runtime) + `pytest` (tests). **No `openai`** — the API call uses only the standard library. |
| `test_core.py` | Unit tests (no network): model-pin, prompt construction, code extraction, the C++/CUDA refusal (incl. `.h` at non-space boundaries), missing-key/empty-input guards, the `local`-backend TODO, the `to_tool_result` status mapping. |
| `test_integration.py` | Integration tests; the live one makes ONE real DeepSeek call and verifies the returned code passes a provided test. **Auto-skips** without a key or network. |

## The tool

```
delegate_codegen(
    function_spec: str,        # signature + behaviour
    test_or_signature: str,    # the Claude-written pytest (REQUIRED) — or at least the exact signature
    constraints: str = "",     # optional acceptance criteria
    context_snippets: str = "",# optional caller-curated surrounding patterns (NOT the whole repo)
    language: str = "python",  # python only; non-python is refused
    backend: str = "cloud",    # "cloud" = DeepSeek API (default). "local" (Ollama) = documented TODO.
) -> dict
```

Returns one of:
- `{"status": "ok", "code": <impl text>, "model": "deepseek-v4-flash", "backend": "cloud", "tokens": {...}, "latency_ms": N}`
- `{"status": "refused", "reason": <why>}` — C++/CUDA, non-python, or `backend="local"` (TODO)
- `{"status": "error", "reason": <why>}` — missing key / network / timeout / non-200 / empty body
  (the `/fn` caller falls back to Claude codegen)

The tool **never raises to the model** — failures come back as a `status` so `/fn` can fall back cleanly.

## Setup

1. **Provide the key** as a user environment variable (never in the repo):
   - Windows (persist): `setx DEEPSEEK_API_KEY "<DEEPSEEK_API_KEY>"` then restart the shell, **or**
   - put it in the `env` block of the `~/.claude.json` server entry (below).
2. **Install the dependency** into the interpreter that will run the server:
   ```bash
   # Windows (project venv — matches the proposal Phase-1)
   PianoidCore/.venv/Scripts/python -m pip install mcp
   ```
   (`core.py` and its unit tests need nothing installed; only `server.py` needs `mcp`.)
3. **Register the server** in `~/.claude.json` under `mcpServers` (exact entry below).
4. **Allow-list the tool** (one-time) in the project `.claude/settings.local.json` `permissions.allow`:
   `"mcp__deepseek-codegen__*"`.
5. **Reload VS Code** so Claude Code picks up the new MCP server, then confirm the `delegate_codegen`
   tool appears and a trivial call returns.

### `~/.claude.json` `mcpServers` entry

> Prefer inheriting `DEEPSEEK_API_KEY` from the shell over hardcoding it here. If you do put it in the
> `env` block, this file is in your home dir (not the repo), but treat it as a secret.

```json
"deepseek-codegen": {
  "command": "D:\\repos\\PianoidInstall\\PianoidCore\\.venv\\Scripts\\python.exe",
  "args": ["D:\\repos\\PianoidInstall\\tools\\deepseek-codegen-mcp\\server.py"],
  "env": { "DEEPSEEK_API_KEY": "<DEEPSEEK_API_KEY>" }
}
```

## How `/fn` uses it

In `/fn` Step 2 ("Edit Code"), **after the Claude-written test exists** and only for a simple, pure,
well-specified **Python-only** single function (never `.cu/.cpp/.cuh/.h/setup.py`):

1. Claude assembles a tight prompt: `function_spec` + `constraints` + the test source + minimal
   `context_snippets`, and calls `mcp__deepseek-codegen__delegate_codegen(...)`.
2. On `status: "ok"`, Claude **reviews** the returned `code` (style, no speculative features, sane
   imports), applies it via `Edit`/`Write`, then proceeds to the normal build + `test_command` run.
3. On `status: "refused"` / `"error"`, or if the applied code **fails the test** (after ≤3 Claude debug
   iterations), Claude **writes the function itself** — the pipeline degrades to today's pure-Claude
   behaviour.

See the proposal §4 for the full control flow. The exact `/fn.md` edit is drafted in
`docs/proposals/` companion notes / handed to the orchestrator (the `/fn` skill is applied at the
orchestrator level, not by sub-agents).

## Tests

```bash
PianoidCore/.venv/Scripts/python -m pytest tools/deepseek-codegen-mcp -q
```

- Unit tests run anywhere (no `mcp`, no network).
- The live integration test makes one real DeepSeek call **only** when a key + network are available
  (else it skips); it sources the key from `DEEPSEEK_API_KEY` or the scratch `.env` outside the repo.

## Kill-switch

Remove `deepseek-codegen` from `~/.claude.json` (or have `/fn` stop calling the tool) → the pipeline
reverts to pure Claude with no other change.

## TODO

- `backend="local"` (Ollama, `http://localhost:11434/v1`) — same code path, different base URL + model.
  Currently refused with a clear message. See proposal §3B/§5 (GPU contention) before enabling.
