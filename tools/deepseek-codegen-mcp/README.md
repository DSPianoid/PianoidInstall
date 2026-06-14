# deepseek-codegen MCP server

A tiny local **stdio MCP server** that exposes ONE tool, `delegate_codegen`, wrapping DeepSeek's
OpenAI-compatible API. It lets the **`/fn`** skill offload the *codegen step only* — drafting a single,
well-defined function body in **Python or JS/TS/React** (any language with a fast isolated test gate;
**C++/CUDA excluded**) — to the cheap `deepseek-v4-flash` model, while Claude keeps ownership of
everything that determines correctness (test authoring, review, build, test run, debug, commit, docs).

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
| **Thinking mode** | **DISABLED** for codegen — the request body carries `{"thinking": {"type": "disabled"}}` (`DEEPSEEK_THINKING_DISABLED`). `deepseek-v4-flash` is a dual-mode model; with thinking *enabled* it spends thousands of internal reasoning tokens before the answer, which is slower, costs more, and was the **root cause** of the truncation / empty-implementation failures (reasoning ate the output budget). For a single well-specified function gated by the Claude-written test, step-by-step reasoning buys nothing. See "Why non-thinking". |
| **Output cap** | `max_tokens` defaults to **32768** (`DEFAULT_MAX_TOKENS`, overridable via `DEEPSEEK_MAX_TOKENS`). Kept large as **defense-in-depth** — with thinking disabled the model no longer burns the budget on reasoning, but a generous cap means even a verbose body (or a future config that re-enables thinking) completes instead of truncating mid-statement. |
| **Secret** | The API key is read **only** from the `DEEPSEEK_API_KEY` environment variable. It is never hardcoded, never committed, never logged, never returned. |

### Why non-thinking (+ a 32768 cap)

**The root cause of the original failures was the model's *thinking* phase, not just the cap.**
`deepseek-v4-flash` is dual-mode; with thinking **enabled** it emits `reasoning_tokens` (a separate
`reasoning_content` field) **before** the visible code, and those count against `max_tokens`. Measured
with thinking ON, on two complex specs (an arithmetic evaluator and an RFC4180 CSV parser):

| thinking ON | reasoning_tokens | @ 4096 cap | @ 32768 cap |
|---|---|---|---|
| `evaluate` | ~1.1k–6.3k | `length` (truncated, no closing fence) | `stop` (complete) |
| `parse_record` | ~3.8k–**11.8k** | `length` (truncated / empty) | `stop` (complete) |

At 4096 the CSV parser's reasoning alone (up to ~11.8k) exceeded the whole budget → the reply was cut
off mid-statement (opening ```` ```python ````, no closing fence) or had **no visible content** →
`extract_code` returned `""` → `"DeepSeek returned an empty implementation"`. Intermittent because
reasoning length varies run-to-run.

**Disabling thinking removes the cause entirely** — no reasoning phase, so the model goes straight to
the code. It is also **faster and cheaper** (no thousands of reasoning tokens to generate/bill). For a
single well-specified function whose correctness is gated by the Claude-written test, step-by-step
reasoning adds nothing. The **32768 cap is kept as defense-in-depth**: it costs nothing when the reply
is short, but guarantees even a verbose body (or a future re-enable of thinking) still completes instead
of truncating. (The model supports up to 384K output tokens.) Measured non-thinking vs thinking on all
three round-2 specs — reliability, latency, and tokens/call — is recorded in the dev-dsfix session log.

### Extraction robustness

`extract_code` resolves the reply in three tiers so a degenerate response still yields usable code
(the Claude-written test remains the correctness gate either way):

1. **Closed fence(s)** → return the largest fenced block (any language tag). The normal path.
2. **Unterminated fence** (a long reply truncated before the closing ```` ``` ````) → return the body
   after the opening ```` ```lang ```` line, dropping any dangling partial fence. Recovers a
   partial-but-usable body and never returns the literal ```` ```lang ```` marker as code.
3. **No fence** (bare code) → return the stripped text with stray lone ```` ``` ```` lines removed.

It returns `""` only when there is genuinely no content, which the caller maps to a clean `error` so
`/fn` falls back to Claude.

## Files

| File | Purpose |
|---|---|
| `core.py` | Dependency-free logic (gate, prompt build, DeepSeek call via stdlib `urllib`, code extraction, status mapping). Unit-tested with **no** `mcp` install and **no** network. |
| `server.py` | Thin MCP stdio wrapper (`FastMCP`) exposing the single `delegate_codegen` tool. Imports `mcp` lazily. |
| `requirements.txt` | `mcp` (runtime) + `pytest` (tests). **No `openai`** — the API call uses only the standard library. |
| `test_core.py` | Unit tests (no network): model-pin, prompt construction, code extraction, the C++/CUDA refusal (incl. `.h` at non-space boundaries), missing-key/empty-input guards, the `local`-backend TODO, the `to_tool_result` status mapping. |
| `test_integration.py` | Integration tests; the live one makes ONE real DeepSeek call and verifies the returned code passes a provided test. **Auto-skips** without a key or network. |
| `batch_pipeline.py` | **Batch** codegen pipeline (pure-Python, zero-LLM-in-the-loop): N `(spec, test)` pairs → delegate (+ optional DeepSeek self-review) → caller's test gate → re-delegate ≤K → escalate. Parallel, test-gated, never ships a failing body. CLI; imports `core.py` directly. See "Batch pipeline" below. |
| `test_batch_pipeline.py` | Unit tests for the batch pipeline (stubbed `core` — no network): manifest forms, the **escalation invariant** (shipped file iff test passed), escalation + retry-to-cap, cost math, thin-test warning, self-review wiring. |

## The tool

```
delegate_codegen(
    function_spec: str,        # signature + behaviour
    test_or_signature: str,    # the Claude-written test (REQUIRED, pytest/Jest/…) — or at least the signature
    constraints: str = "",     # optional acceptance criteria
    context_snippets: str = "",# optional caller-curated surrounding patterns (NOT the whole repo)
    language: str = "python",  # python | javascript/js | typescript/ts | jsx/tsx/react | …; C/C++/CUDA refused
    backend: str = "cloud",    # "cloud" = DeepSeek API (default). "local" (Ollama) = documented TODO.
) -> dict
```

Returns one of:
- `{"status": "ok", "code": <impl text>, "model": "deepseek-v4-flash", "backend": "cloud", "tokens": {...}, "latency_ms": N}`
- `{"status": "refused", "reason": <why>}` — C++/CUDA, non-python, or `backend="local"` (TODO)
- `{"status": "error", "reason": <why>}` — missing key / network / timeout / non-200 / empty body
  (the `/fn` caller falls back to Claude codegen)

The tool **never raises to the model** — failures come back as a `status` so `/fn` can fall back cleanly.

## Runtime venv

The server itself only needs the **`mcp`** package (plus stdlib) — `core.py` and the unit tests need
nothing installed. The committed code is **interpreter-agnostic**: it runs from whatever Python
`~/.claude.json` `command` points at. Two options:

- **Dedicated venv (recommended)** — create a small venv just for this server
  (`python -m venv tools/deepseek-codegen-mcp/.venv` → `…/.venv/Scripts/python -m pip install mcp`) and
  point the `~/.claude.json` `command` at it. This keeps the MCP server's dependency tree (pydantic,
  starlette, uvicorn, …) out of the engine's `PianoidCore/.venv`.
- **Project venv** — install `mcp` into `PianoidCore/.venv` (matches the proposal's Phase-1 step) and
  point `command` there. Simplest, but adds the MCP dep tree to the engine venv (and bumps
  `typing_extensions`); the engine still imports/runs fine, but it crosses the project's venv-isolation
  preference.

The `command` path in the `~/.claude.json` entry below is the only thing that changes between the two.

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
well-specified single function in **Python or JS/TS/React** — any language with a fast isolated test gate
(never `.cu/.cpp/.cuh/.h/setup.py`):

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

## Batch pipeline (`batch_pipeline.py`)

For generating **several** functions in one run (a suite, a module of helpers/adapters), the batch
pipeline is the path where delegation actually pays off — it is **pure-Python orchestration with NO LLM
in the loop except DeepSeek**, so the Claude-side per-round-trip cost that makes single-function
delegation net-negative (see
[`deepseek-delegation-overhead-2026-06-06.md`](../../docs/proposals/deepseek-delegation-overhead-2026-06-06.md))
is ~0. Design + sign-off:
[`deepseek-batch-pipeline-production-2026-06-06.md`](../../docs/proposals/deepseek-batch-pipeline-production-2026-06-06.md).

```
<venv-python> tools/deepseek-codegen-mcp/batch_pipeline.py --manifest <dir-or-json> [--out <dir>] \
    [--report <path>] [--concurrency 4] [--max-delegations 3] [--review-ds on|off] \
    [--expose bodies|signatures] [--venv-python <py>]
# exit 0 iff every function shipped a test-passing body; non-zero if any escalated (or a config error).
```

- **Manifest** — a **directory** with per-function files `<name>.spec.md`, `<name>.test.<ext>`
  (REQUIRED — no test ⇒ hard config error, never a silent skip), optional `<name>.constraints.md` +
  `<name>.meta.json` (`{target_module, language, xp_agnostic, deps}`); OR an explicit `manifest.json`
  (`{"functions":[{name, language?, spec, test, constraints?, target_module?, xp_agnostic?, deps?}]}`
  with paths). `deps` defaults to `[]` (a leaf); `xp_agnostic` defaults to a spec/test `xp`-token heuristic.
- **Per function:** delegate → optional **DeepSeek self-review** (a 2nd, sharper DeepSeek call that
  critiques+repairs against an error-contract / forbidden-construct checklist — **default ON**, cheap,
  validated to catch the known corner-cuts; `--review-ds off` to skip) → run the caller's test → on
  failure, re-delegate feeding the failure tail back, up to `--max-delegations` (default 3).
- **Test-harness conventions (both supported):** (a) **bare import** — the test does
  `import impl_<name>` (the pipeline writes the body as `impl_<name>.py` and writes the test under a
  pytest-collectable name); (b) **conftest/`_candidate`** — if the manifest dir has a `conftest.py`
  and/or `pytest.ini`, the pipeline copies them into the gate's temp dir and sets `SYNTHDS_CANDIDATE`
  to the written body, so a test that does `from _candidate import <name>` resolves. The body is the
  candidate either way.
- **Parallel** — each function's full chain runs in its own thread, capped at `--concurrency`
  (default 4); wall-clock = the slowest chain, not the sum.
- **Escalation (never ships a failing/missing body):** a function still red after K delegations is
  marked `escalated` — the CLI **exits non-zero**, writes **no** shipped file for it (only a
  `<module>.escalated` reference + the failure tail), and the caller (Claude) writes that function
  itself. **Invariant:** a shipped `<module>` file exists **iff** that function's test passed.
- **Harness error vs code failure:** a pytest **collection/import** error (the test setup is broken,
  not the body) is classified `status:"harness_error"` — **not** counted as a code failure and it does
  **not** consume the re-delegation budget (re-delegating can't fix a broken gate). Exits non-zero with
  a `<module>.escalated` note saying the setup needs fixing.
- **Dual-backend signal (Gap A — array-module-agnostic targets):** for functions flagged `xp_agnostic`
  (e.g. numpy-in-test / cupy-in-prod, the array module passed as the last `xp` param), the pipeline
  parses the gate's pytest output for which backends actually ran (`[numpy]` / `[cupy]` parametrisation
  ids) and reports `xp_backends_tested`. If an xp-agnostic function's gate never ran `cupy`, it sets
  **`xp_untested`** (WARN-ONLY, like `thin_test_warning` — a numpy-only/no-GPU box is a legitimate run;
  the flag says "this body's cupy path was not validated here"). Surfaced as `" XP-UNTESTED!"` in the
  console. (The manifest's `conftest.py` parametrises `xp` over `{numpy, cupy-if-importable}`; cupy
  absence is a clean skip.)
- **Sibling-dependency awareness (Gap B — declare → schedule → expose):** each function's
  `meta.json` `deps` names the sibling functions it may CALL. The pipeline validates them (a dangling
  name or a cycle is a `ConfigError`), schedules in **topological layers** (leaf helpers first,
  parallelising within each layer, blocking per layer so a dependent never starts until its deps have
  shipped), and **exposes** each already-shipped dependency to the dependent's prompt — `--expose
  bodies` (default for Python; passes the canonical body so the delegate calls it, not re-derives it) or
  `--expose signatures` (default for jsx/tsx/react; the public contract only). The exposure also reaches
  the self-review (so it doesn't repair a correct sibling-call into an inline copy), and the gate
  **prepends shipped dep bodies into the candidate module** so the dependent's calls resolve. A dep that
  failed to ship is recorded in `deps_unsatisfied`.
- **Report** (`--report`, default `<out>/report.json`): `summary{n, shipped, escalated, harness_errors,
  xp_untested_count, xp_backends_available, total_cost_usd, wall_ms, model, deps_graph, layers}` +
  per-function `{status, public_test_passed, harness_error, n_delegations, attempts, deepseek_tokens,
  cost_usd, thin_test_warning, xp_agnostic, xp_backends_tested, xp_untested, deps, deps_unsatisfied,
  review{fired,changed}, escalation_reason}`.
- **Correctness:** non-thinking DeepSeek cuts edge-case corners; the **caller's test is the gate**, the
  self-review widens what's caught before the gate, and escalation is the backstop. A **thin-test
  warning** flags functions whose test looks shallow (`< 3` asserts or no exception-raising case).
- **It never writes into the repo, commits, or branches** — bodies go to `--out`; the caller applies them.
- **Residuals (honest):** (1) `xp_untested` is WARN-only — on a no-GPU box the cupy path is genuinely
  unvalidated; run on a CUDA box (or accept the risk). (2) `deps` is a **human planning act** — the
  pipeline validates + schedules + exposes declared edges, but does not auto-infer them from spec prose;
  an undeclared sibling call won't be exposed (and a dependent re-implements it). (3) the dual-backend
  contract assumes **array inputs arrive as `xp` arrays** (the test/caller moves them onto `xp`) and the
  body lifts only **host-drawn intermediates** (e.g. a numpy RNG result) with `xp.asarray` — this is the
  exact host→device boundary the gate guards.

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
