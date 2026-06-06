# Design Proposal: Plug DeepSeek into the /dev + /fn development pipeline

- **Status:** **DESIGN ONLY — awaiting user approval.** No code, no installs, no spend, no skill/source
  edits. Read-only research proposal. This document is the single deliverable.
- **Author:** research/design agent, 2026-06-06.
- **Scope:** offload **LIMITED, WELL-DEFINED, Python-only, single-function** coding tasks (the `/fn`
  contract) to DeepSeek, to save Claude codegen tokens and improve throughput — **without** weakening the
  verification story or the project's hard build constraints.
- **Verified against official sources (June 2026):** Claude Code sub-agent docs
  ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)), the open feature
  request for non-Anthropic sub-agent models
  ([anthropics/claude-code#34821](https://github.com/anthropics/claude-code/issues/34821)), DeepSeek
  pricing ([api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)),
  DeepSeek OpenAI-compatible API ([api-docs.deepseek.com](https://api-docs.deepseek.com/)),
  claude-code-router ([github.com/musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)),
  LiteLLM ([docs.litellm.ai](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)), and
  Ollama model VRAM data ([ollama.com/library/deepseek-coder-v2](https://ollama.com/library/deepseek-coder-v2:16b)).

---

## 0. TL;DR

- **Claude Code does NOT support non-Anthropic models in the Agent/Task `model` parameter** — that param
  is a hardcoded enum (`sonnet` / `opus` / `haiku` / `inherit`). Confirmed: feature request
  [#34821](https://github.com/anthropics/claude-code/issues/34821) is still open (March 2026). So you
  cannot just write `Agent({ model: "deepseek-..." })`. DeepSeek must enter through a different seam.
- Four seams exist (detail in §3): **(A) a small MCP server exposing a `delegate_codegen` tool**;
  **(B) a local model via Ollama** exposed the same way; **(C) base-URL/proxy routing of Claude Code
  itself** (claude-code-router / LiteLLM / `ANTHROPIC_BASE_URL`); **(D) a standalone CLI invoked via
  Bash** by an `/fn` sub-agent.
- **RECOMMENDATION: Architecture A — a tiny local MCP server (`deepseek-codegen`) exposing one tool,
  `delegate_codegen`, that wraps the DeepSeek OpenAI-compatible API, with a config switch so the same
  tool can target either the DeepSeek cloud API or a local Ollama model.** It is the only seam that is
  **selective by construction** (DeepSeek is touched ONLY when `/fn` explicitly calls the tool — never the
  orchestrator, never `/dev`'s own reasoning, never `.cu/.cpp` work), it keeps the `/fn` test-gate
  100 % intact, and it adds **zero risk to the orchestrator session** (no global `ANTHROPIC_BASE_URL`
  that would re-route every agent). See §3 / §7 for why C is explicitly rejected for this use case.
- **The single biggest decision the user must make: DeepSeek cloud API vs local Ollama** — i.e. cheap +
  fast + best-quality codegen **but proprietary Pianoid code leaves the machine** (API), vs **zero cost,
  zero data-egress, fully offline** but lower quality / slower on the 12 GB RTX 4070 SUPER (local). The
  recommended MCP server is designed to support **both behind one `backend` config flag**, so this choice
  is a default-setting, not an architecture lock-in — but it must be made before Phase 1.

---

## 1. Problem statement

The Pianoid dev pipeline runs entirely on Claude (Opus/Sonnet) via `/dev` and its `/fn` delegation
(Step 4b). Every line of generated code — including the most mechanical, fully-specified single-function
implementations — consumes Claude output tokens. The user (Leonid) wants DeepSeek "plugged into the dev
pipeline for limited and well-defined coding tasks" to:

1. **Save Claude tokens** on the pure codegen step for well-specified functions.
2. **Improve speed** where a cheaper/faster (or local, parallelizable) model suffices.

The natural and ONLY safe insertion point is the existing **`/fn` skill** — single-function development
with **clear requirements + Claude-written test criteria** — and the **`/dev` Step-4b `/fn` delegation**.
This is precisely the "limited and well-defined" envelope the user described: a function with a known
signature, known behaviour, and a pre-written test.

### 1.1 Hard constraints (non-negotiable — from the project)

| # | Constraint | Source |
|---|---|---|
| HC-1 | **C++/CUDA changes (`.cu/.cpp/.cuh/.h/setup.py`) stay on Claude `/dev`.** They require CUDA builds + deep data-model reasoning; they are NOT "limited/well-defined". DeepSeek offload is **Python-only** (`pianoid_middleware/*.py`, `PianoidBasic/*.py`, `tests/**`) at most. | `.claude/CLAUDE.md` Auto-Trigger Rules; `/dev` Step 4 build matrix |
| HC-2 | **Verification is Claude + tests, always.** DeepSeek-generated code MUST pass the Pianoid test harness with tests **written by the Claude `/dev`/`/fn` agent FIRST** (the `/fn` contract). Token savings come from the *codegen step only*; correctness is gated downstream by Claude. | `/dev` Step 4b "Prepare tests FIRST"; `/fn` Input Contract |
| HC-3 | **DeepSeek never commits, never updates docs, never branches.** Those stay at `/dev` (or user) level, exactly as `/fn` already mandates. | `/fn` Step 5 "Do NOT: Commit / Update documentation"; `.claude/CLAUDE.md` |
| HC-4 | **No weakening of the orchestrator's permission / stall model.** Any new tool must not introduce a CLI-permission stall path invisible to the Telegram user. | `.claude/CLAUDE.md` Orchestrator Sub-Agent Permission Rule |

### 1.2 Where exactly the offload lands (grounded in the real workflow)

The `/fn` skill is a clean **codegen-with-a-fixed-contract** unit. Its Input Contract
(`/fn` skill, "Input Contract" table) is:

| Field | Meaning |
|---|---|
| `target_file` | absolute path to edit |
| `function_spec` | name, signature, behavior |
| `requirements` | acceptance criteria |
| `test_command` | exact command that verifies the change |
| `context_files` | files to read for understanding |

`/dev` Step 4b spells out the division of labour that makes offload safe (quoted verbatim):

> **"Prepare tests FIRST (dev agent responsibility) … Before spawning a sub-agent, the dev agent must
> ensure a test exists for the function. This is the dev agent's job, not the sub-agent's."**
> **"The test file persists in the project — it is not disposable scaffolding."**
> **"Write the test, commit-stage it, then reference it in the sub-agent spawn."**

And `/fn` Step 4 is literally *"Run the `test_command` provided by the caller"*, Step 4b is a bounded
3-iteration debug loop, and Step 5 forbids commits/doc-edits. **This is the seam:** the
`function_spec → implementation` mapping inside `/fn` Step 2 ("Edit Code") is the *only* part we offload
to DeepSeek. Everything around it — context selection, **test authoring (Claude, FIRST)**, the build,
the test run, the debug decision, the commit, the docs — stays on Claude exactly as today.

```
  /dev  ──Step 4b──>  writes test FIRST (Claude)  ──spawn──>  /fn (Claude sub-agent)
                                                                  │  Step 1 read context (Claude)
                                                                  │  Step 2 EDIT CODE  ◄── OFFLOAD HERE
                                                                  │         (DeepSeek writes the body;
                                                                  │          Claude reviews + applies)
                                                                  │  Step 3 build (Claude, if needed)
                                                                  │  Step 4 run test_command (Claude)
                                                                  │  Step 4b debug ≤3 iters (Claude)
                                                                  └─ Step 5 report (no commit/docs)
```

---

## 2. Does Claude Code natively support non-Anthropic sub-agent models? (Research finding #1)

**No.** Verified facts:

- The **Agent/Task tool `model` parameter is a fixed enum** — `opus` / `sonnet` / `haiku` (plus
  `inherit`). There is **no way to register a non-Anthropic alias** that Claude can pick when spawning a
  sub-agent. Sub-agent front-matter `model:` accepts the same Claude tiers or `inherit`
  ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)).
- This is a **documented, still-open feature request**:
  [anthropics/claude-code#34821](https://github.com/anthropics/claude-code/issues/34821) (March 2026) —
  "Support custom model aliases for subagent spawning". Community workarounds patch `cli.js`; not
  supportable for this project.

**Therefore the supported integration seams are:**

1. **MCP tools** — a first-class, in-session extension point. Claude calls a tool; the tool can do
   anything, including call DeepSeek. **Selective by construction.**
2. **Claude Agent SDK** — same model-routing limitation as the CLI; not relevant unless we rebuild the
   pipeline outside Claude Code (we are not).
3. **`ANTHROPIC_BASE_URL` / LiteLLM-style proxy** (incl. claude-code-router) — redirects Claude Code's
   *own* model calls to another provider. Coarse (whole-session) by default; sub-agent-level only via a
   prompt-injected `<CCR-SUBAGENT-MODEL>` marker. **Whole-session routing is dangerous for an
   orchestrator** (see §3C, §7).

---

## 3. Candidate architectures

### (A) DeepSeek via a small local MCP server — `delegate_codegen` tool  ★ RECOMMENDED

A ~150-line Python MCP server (stdio) registered in `~/.claude.json`, exposing **one** tool:

```
delegate_codegen(
    function_spec: str,      # signature + behavior (from /fn)
    requirements: str,       # acceptance criteria (from /fn)
    test_source: str,        # the Claude-written test (so DeepSeek codes to the spec)
    context_snippets: str,   # caller-curated surrounding code / patterns (NOT the whole repo)
    language: str = "python",
    backend: str = "deepseek-api"   # OR "ollama-local"  ← the one switch (§5, §6)
) -> { "code": str, "model": str, "tokens": {...}, "latency_ms": int }
```

`/fn` Step 2 calls this tool, gets back a function body, **Claude reviews it, applies it via `Edit`/
`Write`** (DeepSeek never touches the filesystem), then `/fn` continues to build + test as today.

**How-to sketch:** Python `openai` SDK pointed at `base_url="https://api.deepseek.com"`,
`model="deepseek-v4-flash"` (the cheap coding-capable tier). Wrapped in the official `mcp` Python SDK as
an stdio server. Add to `~/.claude.json` `mcpServers`. Key from env var `DEEPSEEK_API_KEY` (never
in-repo). The `backend="ollama-local"` branch instead points `base_url` at `http://localhost:11434/v1`
(Ollama's OpenAI-compatible endpoint) — same code path, different URL + model.

| Pros | Cons |
|---|---|
| **Selective by construction** — DeepSeek runs ONLY when `/fn` calls the tool. Orchestrator, `/dev` reasoning, `.cu` work, every other agent are completely untouched. | Adds one MCP server to maintain (stdio-pipe fragility on long sessions — same class as chrome-devtools, mitigated by pinning, §8). |
| **Verification untouched** — Claude still writes the test, applies the code, runs the harness, owns the debug loop and commit. HC-2/HC-3 satisfied automatically. | Claude pays a small "review the returned code" token cost (still far less than generating it; net savings preserved — §6). |
| **No global env-var risk** — no `ANTHROPIC_BASE_URL`, so zero chance of accidentally routing the orchestrator or a `/dev` agent to DeepSeek. HC-4 satisfied. | Requires the `/fn` skill to learn the tool exists (a doc/skill edit in Phase 2 — out of scope for this proposal). |
| **API-or-local behind one flag** — the `backend` switch lets the user defer/flip the cloud-vs-local decision without re-architecting. | First-call latency for the tool definition; negligible. |
| Easy kill-switch: remove the server from `~/.claude.json` (or `/fn` stops calling the tool) and the pipeline reverts to pure Claude. | |

### (B) Local model via Ollama (deepseek-coder-v2:16b-lite / qwen2.5-coder) on the RTX 4070 SUPER

Same MCP-tool front (or a direct OpenAI-compatible call) but the model runs **locally** via Ollama's
`http://localhost:11434/v1` endpoint. This is **not a competing architecture** — it is the
`backend="ollama-local"` mode of (A). Listed separately because the **model-fit + quality** question is
distinct.

**What actually fits in 12 GB VRAM (Q4_K_M), from Ollama/community data (June 2026):**

| Model | Q4_K_M size | VRAM (incl. KV cache) | Fit on 12 GB 4070 SUPER | Notes |
|---|---|---|---|---|
| `qwen2.5-coder:7b` | ~4.7 GB | ~6–7 GB | **Comfortable** | Fast; strong for small, well-specified functions. Good default local model. |
| `qwen2.5-coder:14b` | ~8.5–9.0 GB | ~10–11 GB | **Fits (tight)** | RTX 4070 12 GB is the "comfortable minimum" per community data; best local quality; reduce context if KV cache pressures VRAM. |
| `deepseek-coder-v2:16b-lite` | ~8.9 GB | ~9–10 GB (MoE, ~2.4 B active) | **Fits** | MoE → low active params → runs well on 8–16 GB; the canonical "12–16 GB GPU" local coder. |

Sources: [ollama.com/library/deepseek-coder-v2](https://ollama.com/library/deepseek-coder-v2:16b),
[localllm.in Ollama VRAM guide](https://localllm.in/blog/ollama-vram-requirements-for-local-llms),
[morphllm best Ollama models](https://www.morphllm.com/best-ollama-models).

**Expected quality/latency:** for *single, fully-specified functions with a pre-written test*, 7B/14B
coder models are adequate-to-good — and crucially, **the test is the safety net**: a weak generation just
fails the test and falls back to Claude (§4). Latency on a 4070 SUPER: a few seconds to low tens of
seconds per function at these sizes (interactive). Throughput is single-stream (one model loaded), so
local does **not** help parallel `/fn` fan-out the way the cloud API would.

| Pros | Cons |
|---|---|
| **Zero API cost. Zero data-egress** — proprietary Pianoid code never leaves the machine (directly answers the §7 egress risk). | Lower codegen quality than DeepSeek-V4 cloud or Claude → more test-fail → more Claude fallback (erodes savings). |
| Fully offline; no key management, no third-party ToS. | Single-stream throughput; competes with the engine/CUDA for the same 12 GB GPU if the Pianoid stack is running (VRAM contention — must not run a `/test-ui` GPU render and a 14B model simultaneously). |
| Same MCP front as (A) — one `backend` flag. | Model management overhead (pull, version, warm-up). |

### (C) Proxy / base-URL routing of Claude Code itself (claude-code-router / LiteLLM / `ANTHROPIC_BASE_URL`)  ✗ NOT for this use case

claude-code-router sets `ANTHROPIC_BASE_URL` to a local proxy (default `http://127.0.0.1:3456`) and
routes Claude Code's model calls to any provider, with scenario keys (`default`, `background`, `think`,
`longContext`, `webSearch`, `image`), a mid-session `/model provider,model` override, and
**sub-agent-level routing via a `<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>` marker at the
start of a sub-agent prompt**
([github.com/musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)). LiteLLM
offers a similar Anthropic-compatible gateway
([docs.litellm.ai](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)).

**Is SELECTIVE per-subtask routing possible?** *Technically yes* — via the `<CCR-SUBAGENT-MODEL>` marker
the `/dev` agent could prepend to an `/fn` spawn, or a `CUSTOM_ROUTER_PATH` script. **But it is
whole-session at the env-var level**: `ANTHROPIC_BASE_URL` is process-wide. To use it the **orchestrator
itself must be launched behind the router**, putting *every* Claude call (orchestrator reasoning, every
`/dev`, every Telegram interaction) through a third-party proxy.

| Pros | Cons |
|---|---|
| Could route `/fn` sub-agents to DeepSeek with no MCP tool, reusing Claude Code's native sub-agent mechanics. | **Whole-session blast radius.** `ANTHROPIC_BASE_URL` re-points the entire process. A router/proxy bug, a mis-scoped default, or a dropped marker silently sends orchestrator/`/dev`/`.cu`-reasoning traffic to DeepSeek — directly violating HC-1 and HC-4. |
| Task-aware scenario routing is mature. | **DeepSeek can't run Pianoid's `/dev` workflow** — it lacks the tool-use fidelity, the data-model reasoning, and the build discipline; any leak of non-`/fn` work to it is a correctness hazard. |
| | **Egress is worse** — proxy routing tends to ship full session context (whole-repo reasoning), not just a curated function spec, to the third party. The MCP tool sends only the curated `function_spec`+`test`+`snippets`. |
| | New single point of failure in front of the whole orchestrator; pinning/uptime burden. |

**Verdict: rejected for selective offload.** The proxy is the right tool for "I want to run *all* of
Claude Code cheaply"; it is the **wrong** tool for "offload a narrow, well-defined subtask while keeping
everything else on Claude." It maximizes blast radius for a use case that demands minimal blast radius.

### (D) Standalone codegen CLI invoked via Bash by an `/fn` sub-agent

A small `deepseek_gen.py` (or an off-the-shelf CLI) the `/fn` agent calls via `Bash`:
`python tools/deepseek_gen.py --spec ... --test ... > out.py`, then Claude reads `out.py` and applies it.

| Pros | Cons |
|---|---|
| Simplest to prototype; no MCP server, no proxy. | **Permission-gate friction** — every Bash invocation variant risks the CLI-permission stalls the project fights (`.claude/CLAUDE.md` "Known gaps"); arg-passing (multiline spec/test) through Bash is brittle. |
| Trivial kill-switch (delete the script). | No structured return (tokens/latency/model) without parsing stdout; weaker observability. |
| Reuses existing `Bash(*)` allow-list. | Spec/test must be marshalled to temp files (the `/fn` skill already discourages ad-hoc temp artefacts); messier than a typed MCP tool call. |
| | Egress identical to (A) when it hits the API; no advantage over (A) on that axis. |

**Verdict: viable fallback / fast prototype**, but (A) dominates it on observability, robustness, and
permission-safety. Could be a **Phase-0 spike** to validate DeepSeek output quality on real Pianoid `/fn`
tasks *before* investing in the MCP server (§9).

### 3.x Architecture comparison

| Axis | A: MCP `delegate_codegen` | B: Ollama (mode of A) | C: proxy/base-URL | D: Bash CLI |
|---|---|---|---|---|
| Selective (only `/fn`, never orchestrator/`.cu`) | **Yes — by construction** | Yes (via A) | No (whole-session env var) | Yes |
| Verification gate intact (HC-2) | **Yes** | Yes | Yes (if marker never drops) | Yes |
| Never commits/docs (HC-3) | **Yes** | Yes | Yes | Yes |
| Orchestrator blast-radius (HC-4) | **None** | None | **High** | Low |
| Data egress | curated spec+test only | **None (local)** | full session context | curated (temp files) |
| Permission-stall risk | Low (MCP allow-listed) | Low | Low | **Medium (Bash variants)** |
| Observability (tokens/latency) | **Structured** | Structured | proxy logs | weak (stdout) |
| Parallel `/fn` fan-out | **Yes (cloud)** | No (single GPU stream) | yes | yes |
| Setup cost | medium (one MCP server) | medium + model pulls | medium (proxy + risk) | **low** |
| Kill-switch | remove from `~/.claude.json` | switch flag | unset env var (restart) | delete script |

---

## 4. The /fn-integration design (recommended path)

**Principle: DeepSeek writes the function body; Claude owns everything that determines correctness.**

### 4.1 Control flow inside `/fn` Step 2 ("Edit Code")

Today `/fn` Step 2 says *"Implement the function according to `function_spec` and `requirements`."* The
integration inserts an **optional, opt-in** codegen-delegation in front of the Claude edit:

```
/fn Step 1: read context (Claude)            ── unchanged
/fn Step 2: EDIT CODE
   if (delegation enabled for this fn) AND (target is Python-only) AND (no .cu/.cpp/.cuh/.h/setup.py):
       1. Claude assembles a tight prompt: function_spec + requirements + the Claude-written
          test_source + minimal context_snippets (the adjacent patterns Step 1 identified — NOT the repo).
       2. Claude calls  mcp__deepseek-codegen__delegate_codegen(...)
       3. DeepSeek returns a candidate body.
       4. Claude REVIEWS the candidate (style match, P1/P2, no speculative features, imports sane).
          - reject → fall back to Claude writing it directly (normal Step 2). [FALLBACK-1]
          - accept → Claude applies it via Edit/Write (DeepSeek never writes files).
   else:
       Claude writes the function directly (today's behavior).
/fn Step 3: build if needed (Claude)         ── unchanged (HC-1: .cu work never reaches here)
/fn Step 4: run test_command (Claude)        ── unchanged — THE GATE
/fn Step 4b: debug ≤3 iters (Claude)         ── unchanged
   - if tests still fail after the candidate + ≤3 Claude debug iters → Claude rewrites from scratch. [FALLBACK-2]
/fn Step 5: report, NO commit, NO docs        ── unchanged (HC-3)
```

### 4.2 Gating — when delegation is allowed

Delegation is **off by default** and only eligible when ALL hold (enforced by `/fn`, audited by the
controller via a new marker, §4.4):

- `target_file` extension ∈ {`.py`} under `pianoid_middleware/`, `PianoidBasic/`, or `tests/` — and is
  **NOT** `.cu/.cpp/.cuh/.h/setup.py` (HC-1, hard).
- A `test_command` + concrete `test_source` exist (HC-2 — never delegate without the test in hand).
- The function is genuinely single-responsibility and fully specified (the `/fn` envelope). Cross-cutting
  refactors are out (matches `/dev` Step 4b "When NOT to delegate").

### 4.3 Two-level fallback to Claude (the safety net)

- **FALLBACK-1 (review reject):** Claude judges the candidate unusable → writes it itself. Cost: the
  wasted DeepSeek call (cents or zero) + normal Claude codegen. No correctness impact.
- **FALLBACK-2 (test fail):** candidate (or its ≤3 Claude-debug iterations) can't pass the test → Claude
  discards and rewrites. The test is authoritative; **a bad DeepSeek output can never ship** because it
  literally cannot pass a test Claude wrote and Claude runs.

This is the whole verification story: **token savings are best-effort; correctness is guaranteed by the
pre-existing, unchanged Claude+test gate.**

### 4.4 Observability / controller alignment

`/fn` (and `/dev`) already emit MCP markers (`/fn` "Marker Discipline": `[MCP-CALL]` / `[MCP-RETURN]`).
The `delegate_codegen` call rides those automatically. Add two `/fn`-local markers (Phase 2 skill edit,
not in this proposal's scope to implement):

- `[CODEGEN-DELEGATED] backend=<deepseek-api|ollama-local> model=<...> tokens_in=<N> tokens_out=<N>`
- `[CODEGEN-OUTCOME] result=<applied|review-reject|test-fail-fallback>`

so the orchestrator can audit *what fraction of delegations actually paid off* and prove HC-1
(no `.cu` ever delegated).

---

## 5. Verification & safety model

| Concern | Mitigation |
|---|---|
| **Correctness (HC-2)** | Claude writes the test FIRST (`/dev` Step 4b, unchanged); Claude runs it (`/fn` Step 4, unchanged); failing DeepSeek output triggers FALLBACK-2. DeepSeek output is *never* trusted, only *tested*. |
| **No auto-commit / no docs (HC-3)** | DeepSeek returns a string; it has no filesystem, git, or doc access. Claude applies code; `/fn` Step 5 forbids commits/docs as today. The MCP tool is pure compute-in / text-out. |
| **C++/CUDA stays on Claude (HC-1)** | Hard extension-gate in §4.2 + the `[CODEGEN-DELEGATED]` marker the controller can audit. The tool *can* be called for non-Python, but `/fn`'s gate forbids it; defense-in-depth: the MCP server can also refuse `language != "python"` by config. |
| **Secrets — API key** | `DEEPSEEK_API_KEY` lives in an **environment variable** read by the MCP server process (via the `env` block of the `~/.claude.json` server entry, or the user's shell profile). **Never** in the repo, **never** in `settings.local.json`, **never** in a committed file. `.gitignore` already covers `.env`. For local-only (Ollama) there is no key at all. |
| **Data egress (the big third-party risk)** | **API mode ships proprietary Pianoid code to DeepSeek's servers** (function spec + test + curated snippets — NOT the whole repo, but still real code). This is a genuine IP/confidentiality exposure and is the core reason the **local Ollama mode exists** (`backend="ollama-local"` → nothing leaves the machine). The user must consciously accept API egress OR default to local. The MCP design minimizes egress even in API mode by sending only the curated `function_spec`/`requirements`/`test_source`/`context_snippets`, never the repository. (Note: DeepSeek's consumer ToS/data-retention should be reviewed before enabling API mode on proprietary code; an enterprise/no-retention tier or local mode avoids this.) |
| **Permission-stall safety (HC-4)** | The MCP tool is added to `permissions.allow` as `mcp__deepseek-codegen__*` (one-time, §9). MCP calls don't hit the long-running-process or TTY gates. No new Bash variants (the (D) risk) are introduced. |
| **Failure / fallback** | Two-level fallback (§4.3). If the MCP server is down (stdio pipe drop), the tool call errors → `/fn` falls back to Claude codegen transparently. The pipeline **degrades to today's behavior**, never breaks. |
| **GPU contention (local mode only)** | If `backend="ollama-local"`, do **not** delegate during a live `/test-ui` GPU render — a 14B model + the CUDA engine both want the 12 GB. The orchestrator/`/fn` should prefer API mode (or skip delegation) while the stack is rendering. Documented constraint, not a code gate. |

---

## 6. Cost / speed comparison

### 6.1 DeepSeek API pricing (verified, [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing), June 2026)

| Model | Context | Input (cache miss) | Input (cache hit) | Output | Per-1M |
|---|---|---|---|---|---|
| **deepseek-v4-flash** (recommended; = legacy `deepseek-chat`) | 1M | **$0.14** | $0.0028 | **$0.28** | cheap tier |
| deepseek-v4-pro (= legacy `deepseek-reasoner`) | 1M | $0.435 | $0.003625 | $0.87 | reasoning tier |

Base URL `https://api.deepseek.com` (OpenAI format) or `https://api.deepseek.com/anthropic`
(Anthropic format). Legacy names `deepseek-chat`/`deepseek-reasoner` work as aliases until
**2026-07-24** — use the V4 names. **Local Ollama = $0** (electricity only).

### 6.2 Where the savings actually land

The offload removes **only the Claude *output* tokens for the function body** (typically tens to a few
hundred lines per `/fn`). Claude still spends tokens on: reading docs/context (Step 1), **writing the
test** (Step 4b — often *more* tokens than the function), **reviewing** the DeepSeek candidate, running
the build/test, the debug loop, the commit, and docs. So:

- **Savings are real but bounded** — they apply to the codegen slice of a sub-set of `/fn` tasks (the
  cleanly-specified Python ones), not to `/dev` as a whole.
- A representative single function might be ~150–400 Claude output tokens to generate. At Opus output
  rates that's a small per-call saving; the value compounds across **many** `/fn` calls and, more
  importantly, on **parallel fan-out** (API mode lets several `/fn` bodies generate concurrently off the
  Claude critical path).
- **DeepSeek API cost per delegated function is negligible** — a function spec + test + snippets in,
  a function out, is typically a few thousand tokens total → fractions of a cent at $0.14/$0.28 per 1M.
- **Net effect:** modest token savings + a latency/throughput win on parallel delegation, at near-zero
  API cost — *provided* the DeepSeek output quality keeps FALLBACK-2 (full Claude rewrite) rare. If
  fallbacks are frequent, you pay the DeepSeek call **and** the Claude rewrite, and lose money/time. This
  is why **a Phase-0 quality spike (§9) is essential before committing**: the savings hinge on the
  fallback rate, which must be measured on real Pianoid `/fn` tasks, not assumed.

### 6.3 Speed

- **API (flash):** sub-second to a few seconds per function; supports concurrent calls → parallel `/fn`.
- **Local (7B/14B on 4070 SUPER):** a few seconds to low tens of seconds; single-stream; no parallelism;
  no network round-trip. Good when offline/egress-sensitive; weaker for fan-out.

---

## 7. Recommendation

**Adopt Architecture A: a small local MCP server `deepseek-codegen` exposing one `delegate_codegen`
tool, with a `backend` flag selecting DeepSeek cloud API or local Ollama.** Wire it into `/fn` Step 2 as
an opt-in, extension-gated, fully-fallback-able codegen delegation.

**Rationale (against the constraints):**

1. **Only A is selective by construction** — DeepSeek is reachable *only* through one named tool that
   *only* `/fn` calls. The orchestrator, `/dev`'s reasoning, and all `.cu/.cpp` work are physically
   unable to touch it (HC-1, HC-4). The proxy (C) cannot make this guarantee — it re-points the whole
   process.
2. **The `/fn` contract already provides the verification gate** — Claude writes the test first, runs it,
   owns the debug loop and commit. Slotting DeepSeek into Step 2 changes *who drafts the body*, nothing
   about *how correctness is decided* (HC-2, HC-3).
3. **The `backend` flag defers the cloud-vs-local decision** without re-architecting — the user can start
   local (zero egress) and flip to API for speed/quality, or vice-versa, by config.
4. **It degrades gracefully** — if DeepSeek is unavailable or its output is weak, the pipeline silently
   reverts to today's pure-Claude behavior. Adopting it cannot make the pipeline worse than the status
   quo; at worst the savings don't materialize.

**Explicitly rejected:** (C) proxy/base-URL routing — wrong blast radius for selective offload; risks the
orchestrator. (D) Bash CLI — viable as a Phase-0 spike but dominated by (A) on robustness/observability/
permission-safety for the durable solution.

---

## 8. Risks & open items

| Risk | Severity | Handling |
|---|---|---|
| **DeepSeek output quality too low → frequent FALLBACK-2 → negative ROI** | High (kills the value prop) | **Phase-0 spike measures the fallback rate on real `/fn` tasks before any commitment** (§9). Go/no-go gate. |
| **Data egress of proprietary code (API mode)** | High (IP) | Default to local Ollama for sensitive work; if API, send only curated spec/test/snippets, review DeepSeek data-retention ToS, consider a no-retention tier. User must consciously choose (§5, the headline decision). |
| **API key leakage** | Medium | Env-var only; never in repo/settings; `.gitignore` covers `.env`. |
| **MCP stdio pipe drop on long sessions** (chrome-devtools class) | Medium | Pin the server (local script, fixed deps — no `npx @latest`); tool errors fall back to Claude; document a reload recovery. |
| **GPU/VRAM contention in local mode** | Medium | Don't delegate locally during live GPU renders; prefer API or skip (§5). |
| **Scope creep — someone delegates a `.cu` or a cross-cutting refactor** | High (HC-1) | Hard extension-gate in `/fn` + `[CODEGEN-DELEGATED]` controller audit + optional server-side `language` refusal. |
| **DeepSeek model-name churn** (V4 rename 2026-07-24) | Low | Pin `deepseek-v4-flash`; the MCP server centralizes the model name in one config spot. |

---

## 9. Phased implementation plan (for the recommended path — NOT executed here)

> All steps below are **future work**, contingent on user approval and the §5 headline decision. Nothing
> in this proposal installs, spends, or edits code/skills.

### Phase 0 — Quality spike (decision gate; no MCP server yet)  ▸ ~1 short session

Validate that DeepSeek can actually produce passing Pianoid `/fn` bodies *before* building infrastructure.

1. Pick 3–5 historical `/fn`-style Python functions from the project (with their existing tests).
2. Hand-call DeepSeek (or local Ollama) with the spec+test+snippets; measure: did the output pass the
   test as-is / after ≤3 fixes / not at all? Record the **fallback rate** and rough token usage.
3. **Go/no-go:** proceed only if the as-is + light-fix pass rate is high enough that savings beat the
   fallback cost. (This is also the moment to compare API-flash vs local-14B quality.)

### Phase 1 — Build the MCP server (the recommended core)

Exact steps (Windows, project venv `PianoidCore/.venv`):

1. **Get a key** (API mode): create a DeepSeek account, generate an API key, set it as a **user env var**
   `DEEPSEEK_API_KEY` (never in repo). For local mode: `winget install Ollama.Ollama` (or the installer),
   then `ollama pull qwen2.5-coder:14b` (or `deepseek-coder-v2:16b-lite`).
2. **Install deps into the project venv** (no global pollution):
   `PianoidCore/.venv/Scripts/python -m pip install "mcp" "openai"`.
3. **Write the server** (~150 LOC) at e.g. `tools/deepseek_codegen_mcp/server.py`: stdio MCP server,
   one tool `delegate_codegen` (§3A signature), `openai` client with
   `base_url` = `https://api.deepseek.com` (API) or `http://localhost:11434/v1` (Ollama) selected by the
   `backend` arg/config; `model` = `deepseek-v4-flash` / the pulled Ollama model; returns
   `{code, model, tokens, latency_ms}`. Key from `os.environ["DEEPSEEK_API_KEY"]`.
4. **Register it** in `~/.claude.json` `mcpServers`:
   ```json
   "deepseek-codegen": {
     "command": "D:\\repos\\PianoidInstall\\PianoidCore\\.venv\\Scripts\\python.exe",
     "args": ["D:\\repos\\PianoidInstall\\tools\\deepseek_codegen_mcp\\server.py"],
     "env": { "DEEPSEEK_API_KEY": "<from-secure-source-or-inherited-shell-env>" }
   }
   ```
   (Prefer inheriting `DEEPSEEK_API_KEY` from the shell over hardcoding it in `~/.claude.json`.)
5. **Allow-list the tool** (one-time, in project `settings.local.json`): add `"mcp__deepseek-codegen__*"`
   to `permissions.allow` (the file already blanket-allows both shells; this just covers the new MCP
   server so team sub-agents don't stall — per `.claude/CLAUDE.md` "Known gaps").
6. **Reload VS Code** to pick up the new MCP server; verify the tool appears and a trivial call returns.

### Phase 2 — Wire it into `/fn` (skill edit — separate, reviewed change)

1. Edit `.claude/commands/fn.md` Step 2 to add the **opt-in, extension-gated, fallback-able** delegation
   (§4.1–4.3), plus the gating rules (§4.2) and the two new markers (§4.4). Update `/dev` Step 4b to note
   that delegated `/fn` agents may use `delegate_codegen` for Python-only functions.
2. Keep delegation **opt-in** (off by default) until Phase 0/early Phase 2 usage proves the ROI.

### Phase 3 — Measure & tune

1. Run real `/fn` tasks with delegation on; collect `[CODEGEN-DELEGATED]`/`[CODEGEN-OUTCOME]` markers.
2. Track fallback rate, token savings, latency. Tune the `backend` default (API vs local) and the
   eligibility gate accordingly. If ROI is negative, flip delegation off — zero-cost revert.

### Kill-switch (any time)

Remove `deepseek-codegen` from `~/.claude.json` (or set `/fn` delegation off) → pipeline reverts to pure
Claude with no other change.

---

## 10. Summary

- **Claude Code can't take a non-Anthropic model in the Agent `model` param** (open req #34821) → DeepSeek
  enters via a **tool**, not a model slot.
- **Recommended: a tiny local MCP server `deepseek-codegen` (`delegate_codegen` tool), with a `backend`
  flag for DeepSeek-API vs local-Ollama**, wired into `/fn` Step 2 as opt-in, extension-gated,
  fully-fallback-able codegen. It's the only seam that's selective by construction, keeps the Claude+test
  verification gate intact, and adds zero orchestrator blast-radius.
- **Rejected:** whole-session proxy routing (C) — wrong blast radius, egress, and orchestrator risk.
- **Cost:** DeepSeek API is negligible per call ($0.14 in / $0.28 out per 1M, flash); local is free.
  **Savings are bounded** to the codegen slice of clean Python `/fn` tasks and **hinge on a low fallback
  rate** — hence the Phase-0 quality gate.
- **The user's headline decision: cloud API (cheap/fast/parallel, but proprietary code egress) vs local
  Ollama (free/offline/no egress, but lower quality + single-stream).** The design supports both behind
  one flag, but a default must be chosen before Phase 1.
- **Status:** DESIGN only — no installs, no spend, no code/skill edits. This document is the deliverable.

---

### Sources

- [Claude Code — Create custom subagents](https://code.claude.com/docs/en/sub-agents)
- [anthropics/claude-code #34821 — custom subagent model aliases (open)](https://github.com/anthropics/claude-code/issues/34821)
- [DeepSeek API — Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek API — Your First API Call / OpenAI-compatible](https://api-docs.deepseek.com/)
- [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)
- [LiteLLM — Use Claude Code with non-Anthropic models](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models)
- [Ollama — deepseek-coder-v2](https://ollama.com/library/deepseek-coder-v2:16b)
- [Ollama VRAM requirements guide (localllm.in)](https://localllm.in/blog/ollama-vram-requirements-for-local-llms)
- [Best Ollama models — Morph](https://www.morphllm.com/best-ollama-models)
