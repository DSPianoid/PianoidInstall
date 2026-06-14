# DeepSeek Batch Codegen Pipeline — Production Design

**Date:** 2026-06-06
**Author:** dev-dsfix (feature/deepseek-codegen-mcp)
**Status:** DESIGN — awaiting user sign-off BEFORE build. No code written yet.
**Companions (read for the "why"):**
[`deepseek-delegation-overhead-2026-06-06.md`](deepseek-delegation-overhead-2026-06-06.md) (the cost analysis that motivates this shape) ·
[`deepseek-dev-pipeline-integration-2026-06-06.md`](deepseek-dev-pipeline-integration-2026-06-06.md) (Architecture A: the single-fn MCP tool, now committed + fixed at `b49fc51`).

---

## 0. BLUF — what to build, and the one decision that matters

Productionise the **pure-Python batch pipeline** prototyped at `D:\tmp\ab-pipeline\pipeline.py` into a
committed, reusable tool: **`tools/deepseek-codegen-mcp/batch_pipeline.py`** (a standalone CLI), plus a
manifest convention and a small config. It takes **N `(spec, test)` pairs**, delegates each function
body to the **fixed non-thinking DeepSeek core** in **parallel** (capped), runs **the caller's test as
the gate**, **re-delegates on failure** (≤K), and **escalates any still-failing function to Claude/Opus**
— never silently shipping a missing/failing body. It emits **N graded bodies + a cost/result report**.

**The proven win (measured, PoC):** 3 functions, all green first try, **DeepSeek cost $0.001088 total**,
wall-clock = the **slowest** chain (17.2 s) not the sum (~28 s), **zero Opus tokens in the loop.** This is
the L3 architecture taken to its limit: the orchestrator is *Python*, so the per-round-trip context the
overhead analysis identified as the entire cost driver is **~0** — the crossover that kills single-fn
delegation (`F > N_extra·ctx·0.02`) simply collapses.

**The one load-bearing decision (needs your call):** non-thinking DeepSeek is **correctness-lossy**
(benchmark: **155/160** — it cuts edge-case corners; my own re-test saw csv 44–52/53 and a spec-violating
`csv`-module shortcut). The pipeline ships exactly what the **test gate** passes. So the quality of the
output is **the quality of the caller's tests**. The design below proposes a **default** for closing that
gap (§5); please confirm or adjust it.

---

## 1. Where it lives + how it's invoked

**Recommendation: a standalone CLI tool, NOT a skill, co-located with the existing MCP server.**

| Option | Verdict |
|---|---|
| **(A) Standalone CLI `tools/deepseek-codegen-mcp/batch_pipeline.py`** ✅ **RECOMMENDED** | Pure-Python, zero-LLM orchestration — the whole point. Importable + runnable. Reuses the committed `core.py` directly (no subprocess hop, unlike the PoC's `delegate_cli.py`). A `/dev` or `/fn` agent invokes it with **one** Bash call and reads back one JSON report — that single round-trip is the *entire* Claude-side cost. |
| (B) Thin skill wrapper (`/batchfn`) | Possible later as sugar, but a skill expands into the agent's context and tempts per-function agentic turns — re-introducing the overhead we're eliminating. Defer; the CLI is the primitive. |
| (C) New MCP tool (`delegate_codegen_batch`) | The MCP server is request/response per call; a long multi-minute batch with retries fits a CLI/process far better than a single MCP tool call (timeouts, progress). Keep MCP = the single-fn primitive (Architecture A); batch = CLI. |

**Invocation (the contract a caller sees):**
```
<venv-python> tools/deepseek-codegen-mcp/batch_pipeline.py --manifest <dir-or-json> [--out <dir>] \
              [--concurrency N] [--max-delegations K] [--review off|haiku|sonnet] [--report <path>]
# exit 0 iff every function shipped a test-passing body (no escalations); non-zero if any escalated.
```
The agent runs that once, then reads `--report` (one JSON) + the per-function bodies in `--out`. One
Bash round-trip in, one read out. (Internally the tool imports `core.py`; it does **not** shell out to
`delegate_cli.py` — that PoC hop was a benchmark artifact and is itself ~16% of the measured overhead.)

**It does NOT** write into the repo, commit, branch, or update docs. It writes bodies to `--out` (a
caller-chosen dir, default a temp/scratch dir) and a report. The **caller** (Claude `/dev`/`/fn`) applies
the bodies via `Edit`/`Write`, builds, and owns the commit — same ownership boundary as the single-fn tool.

---

## 2. Batch interface — how N (spec, test) pairs go in, N graded bodies + a report come out

**Manifest = a directory convention (primary) with a JSON index (explicit form).** A caller hands the
tool a directory; the tool discovers functions by file-stem triples, OR reads an explicit `manifest.json`.

**Directory convention (zero-ceremony):** for each function `<name>`, the manifest dir contains:
```
<manifest>/<name>.spec.md         # function signature + behaviour (required)
<manifest>/<name>.test.py          # the caller's test — pytest (or .test.js for Jest) (required)
<manifest>/<name>.constraints.md   # acceptance criteria / "stdlib only" etc. (optional)
<manifest>/<name>.meta.json        # optional: {target_module, language, max_delegations override}
```
**Explicit `manifest.json` (when paths don't follow the convention):**
```json
{ "functions": [
  { "name": "parse_record", "language": "python",
    "spec": "specs/csv.md", "test": "tests/public_csv.py",
    "constraints": "specs/csv_constraints.md", "target_module": "impl_csv.py" }
] }
```
`language` per function (defaults `python`) → drives the core's prompt + the test runner (pytest vs Jest).
The **test is required per function** (HC-2, inherited from `core.py`): a function with no test is a
**hard config error**, not a silent skip — we never delegate without a gate.

**Output:** `--out/<target_module>` per function (the chosen body) + a single `--report` JSON:
```json
{ "summary": {"n": 3, "shipped": 3, "escalated": 0,
              "deepseek_cost_usd": 0.001088, "wall_clock_ms": 17236,
              "deepseek_total_tokens": 5331},
  "functions": { "parse_record": {
      "status": "shipped|escalated",
      "n_delegations": 1, "test_passed": true,
      "tokens": {"prompt": 922, "completion": 402, "total": 1324},
      "cost_usd": 0.000252, "attempts": [ {"attempt":1,"test_passed":true,"latency_ms":4813}, ... ],
      "escalation": null   // or {reason, last_pytest_tail, body_path} when escalated
  } } }
```
This is the same record shape the PoC already produces (`results.json`), promoted to a stable contract.

---

## 3. Parallel delegation + concurrency cap

**Keep the PoC's model: each function's FULL chain (delegate→test→re-delegate) runs in its own worker;
fan out with a `ThreadPoolExecutor` capped at `--concurrency` (default 4).** Threads are correct here
because every unit of work is a **subprocess or a blocking HTTP call** (the DeepSeek request via
`urllib`, and pytest/Jest as a subprocess) — both release the GIL, so N chains genuinely overlap.
Wall-clock = the **slowest** chain, not the sum (measured: 17.2 s vs ~28 s for N=3).

- **Default cap 4**, `--concurrency` overridable. Rationale: politeness to the DeepSeek API (avoid
  rate-limit bursts) and bounded local pytest processes. For N≤cap it's full parallel; for N>cap it's a
  rolling pool.
- **Determinism:** temperature 0.0 + non-thinking already make each delegation near-deterministic;
  parallelism does not affect per-function results (isolated temp dirs per test run, as in the PoC).
- **Isolation:** each test runs in its own `tempfile.mkdtemp` with `PYTHONPATH` cleared (PoC pattern) so
  functions can't import each other or leak state.

---

## 4. Test gate per function + escalation path (production MUST NOT ship a failing body)

**Per-function loop (the spine, from the PoC):**
1. Delegate body via `core.delegate_codegen(...)` (non-thinking).
2. Write to an isolated temp dir, run the caller's test (pytest/Jest) → pass/fail + a trimmed failure tail.
3. **On pass:** ship it. **On fail:** re-delegate, feeding the **failure tail** into the constraints
   ("the previous impl failed this test; fix it; do not modify the test"). Repeat to **`--max-delegations K`** (default **3** = initial + 2 retries; matches the PoC + the `/fn` Step-4b ≤3 loop).
4. A delegation that *errors/refuses* (no code) also counts toward K, with the error fed back.

**Escalation (the production guarantee):** if a function is **still red after K delegations**, the
pipeline **does NOT ship DeepSeek's last body as final**. It marks that function `status:"escalated"` in
the report, writes the best failing body to `--out/<module>.escalated` (for reference, never as the
shipped file), and records the last pytest tail.

**How escalation is surfaced + handled (recommendation):**
- The CLI **exits non-zero** when `escalated > 0` (machine-detectable by the caller in one Bash round-trip).
- The report's `escalation` block names each escalated function + its failure tail.
- **The caller (Claude `/dev`/`/fn`) owns the escalation:** on a non-zero exit, the agent reads the
  escalated functions and **writes those bodies itself** (normal Claude codegen) — i.e. escalation =
  "fall back to Opus for THESE functions," exactly the single-fn `/fn` fallback, but scoped to the few
  that DeepSeek couldn't pass. This keeps Opus **out** of the loop for the (usually majority) functions
  that pass, and **on** only the hard tail. The pipeline never calls Opus itself (it has no LLM-orchestration
  context); it just refuses to lie about success.
- **Never-silent invariant (encode as a test):** the shipped file for a function exists **iff** that
  function's `status=="shipped"` and `test_passed==true`. An escalated function leaves **no** shipped
  file (only the `.escalated` reference) so a downstream "apply all shipped bodies" step can't pick up a
  failing one. This is the load-bearing safety property and gets an explicit unit test.

---

## 5. Correctness discipline — the 155/160 risk (load-bearing; needs your decision)

**The problem, restated honestly.** Non-thinking DeepSeek trades a little correctness for big speed/cost
(measured: 155/160 across the suite; my dir-2 re-test saw csv 44–52/53 and one run that used Python's
`csv` module which the spec forbade). **Test-gate-only ships those corner-cuts whenever the caller's test
is shallow.** A green *public* test is not proof of a correct body.

**Three mitigations, not mutually exclusive:**

| Option | What it does | Cost | Catches the 155/160 gap? |
|---|---|---|---|
| **(a) Thorough-test discipline** | The caller (Claude) writes/refreshes a *strong* test per function BEFORE batching — edge cases, error paths, the explicit "don't use X" constraints as assertions. The pipeline can **warn** when a test looks thin (e.g. < a configurable assertion/branch threshold). | Claude's normal test-authoring (already in `/fn`/`/dev`) | Mostly — a strong gate is the real fix. The whole architecture already rests on this. |
| **(b) Optional cheap-model review+repair** | Before the test gate, an optional **Haiku/Sonnet** pass reviews each body against the spec+constraints ("does this honour every requirement; fix violations") and returns a repaired body. | +1 cheap LLM call per body (Haiku ≈ 0.2× Opus; still cheap) | Partly — catches *spec violations the test misses* (e.g. the `csv`-module shortcut) that a reviewer can see but a thin test can't. |
| **(c) Both (a default-on)** | Strong tests + an optional review toggle, default chosen below. | — | Best coverage. |

**RECOMMENDED DEFAULT:** **(a) always + (b) OFF by default, available via `--review haiku|sonnet`.**
Reasoning:
- The test gate is the contract and the cheapest, most reliable signal; making **(a)** the standing
  expectation (and adding a **thin-test warning** in the report) is the highest-leverage, lowest-cost move.
- **(b)** is genuinely useful for *spec-violation* classes a test can't express, but it adds an LLM back
  into the per-body loop (re-introducing a smaller version of the cost the design exists to avoid) and a
  second model's own corner-cuts. Make it **opt-in** for runs where correctness > cost (and document that
  `--review` raises cost/latency). Default OFF keeps the pipeline's "nearly free + fast" property intact.
- Escalation (§4) is the backstop for whatever the gate *does* catch; review **(b)** widens what gets
  caught *before* escalation, at a price.

**Decision requested:** confirm "(a) always + thin-test warning, (b) opt-in, default OFF", OR ask for
review default-ON (Haiku) if you want correctness prioritized over the cost win.

---

## 6. Config, logging, cost reporting, error/timeout handling

**Config (CLI flags + a small optional `batch_config.json`; all have defaults so zero-config works):**

| Knob | Default | Notes |
|---|---|---|
| model pin | `deepseek-v4-flash` (from `core.py`) | NOT overridable here — single source of truth stays in `core.py`. |
| thinking | disabled (from `core.py`) | the committed default; the pipeline does not re-enable it. |
| `--max-delegations K` | 3 | per-function retry cap (initial + 2). |
| `--concurrency` | 4 | parallel chain cap. |
| `--review` | `off` | `off｜haiku｜sonnet` (§5b). |
| `--timeout-s` | 90 (delegate, from core) / 300 (per test) | DeepSeek call timeout is core's; pytest/Jest subprocess timeout per the PoC. |
| `--out`, `--report` | scratch temp / `<out>/report.json` | never the repo. |

**Logging:** structured, to stderr (human progress) + the JSON report (machine). Per function: each
attempt's status, tokens, latency, test pass/fail, and on escalation the failure tail. **The API key is
never logged** (it stays inside `core.py`, read from env). No body content in logs beyond what the report
carries.

**Cost reporting:** compute from the real `usage` tokens × v4-flash pricing (`$0.14`/`$0.28` per 1M
prompt/completion — the PoC constants), reported per function and in the summary. If `--review` is on,
report the reviewer model's tokens/cost as a **separate** line so the cost of correctness is visible.
(Pricing constants live in one spot; flag them as "verify against the `claude-api`/DeepSeek catalog" so
they don't silently drift.)

**Error/timeout handling (fail-loud, never silent-pass):**
- DeepSeek error/refuse/timeout on an attempt → recorded, counts toward K, fed back; if K exhausted →
  **escalate** (not "ship empty").
- pytest/Jest timeout → treat as a failed attempt with a "timeout" tail.
- A function whose test file is missing/empty → **hard config error** (exit non-zero before any API call).
- The pipeline itself never raises to the caller unhandled; every failure mode maps to an escalation or a
  config error in the report + a non-zero exit.

---

## 7. Relationship to the existing `/fn` Step 2a (interactive single-fn delegation)

**Recommendation: REPLACE the `/fn` Step-2a guidance for the single-function case with "don't delegate;
just write it" — and point multi-function work at the batch pipeline.**

The overhead analysis is unambiguous: for **one small function in a normal agent context**, interactive
delegation (Step 2a: Opus prompts the tool, then reviews+applies in its own ~50k context) is **≥1 extra
high-context round-trip with nothing to amortize it → net-negative** (the benchmark lost ~2×). Step 2a as
written is the losing pattern.

Concretely (this is a `/fn.md` + `/dev.md` skill edit — **orchestrator-applied**, flagged here, not done
in this design):
- **`/fn` single function:** change Step 2a from "you MAY delegate" to **"write it yourself; do NOT
  delegate a single function — interactive delegation is net-negative (see overhead analysis)."** Keep the
  MCP tool installed (it's the primitive the batch pipeline's core shares) but stop recommending it for 1 fn.
- **Several functions in a run (a `/dev` task that needs a suite/module of helpers/adapters):** point at
  the **batch pipeline** — Claude writes the N tests, runs the pipeline once (one Bash round-trip),
  applies the shipped bodies, and writes only the escalated few itself. This is where delegation finally
  pays (batch amortization + zero-LLM loop).

So: the batch pipeline **supersedes** Step-2a's purpose (delegation-for-cost) and **relocates** it to the
only regime where it wins (N≥3, pure-Python loop). The single-fn interactive path is retired as guidance.

*(These skill edits are listed for the orchestrator; this proposal does not modify skills.)*

---

## 8. Proposed build plan (after sign-off) — for scoping only, not this phase

1. `tools/deepseek-codegen-mcp/batch_pipeline.py` — the CLI: manifest load, parallel pool, per-fn
   delegate/test/re-delegate loop (imports `core.py` directly), escalation, JSON report. (~250–350 LOC;
   well under C4 500.)
2. `tools/deepseek-codegen-mcp/test_batch_pipeline.py` — unit tests with a **stubbed** `core.delegate_codegen`
   (no network): manifest parsing; the escalation invariant (no shipped file iff escalated — §4);
   concurrency cap; cost math; missing-test config error; the thin-test warning.
3. README section: batch interface, manifest convention, escalation contract, the `--review` toggle, the
   correctness caveat (155/160), and the "single fn → don't delegate" guidance.
4. A live end-to-end run on the ab-test2 suite (3 fns) reproducing the PoC numbers, recorded in the log
   (scratch out-dir under `D:\tmp\`, not the repo).
5. **No CUDA, no engine/middleware.** Pure-Python. Orchestrator applies the `/fn.md`+`/dev.md` edits.

---

## 9. Open decisions for sign-off

1. **§5 correctness default:** confirm "(a) strong tests always + thin-test warning; (b) `--review`
   opt-in, default OFF", or request review default-ON (Haiku).
2. **§1 shape:** confirm standalone CLI under `tools/deepseek-codegen-mcp/` (vs a `/batchfn` skill wrapper).
3. **§7 `/fn` change:** confirm retiring the single-fn Step-2a delegation guidance + pointing multi-fn at
   the batch pipeline (orchestrator applies the skill edits).
4. **§6 defaults:** confirm K=3, concurrency=4 (or set preferred values).
5. Anything to add to the **report** contract (§2) for downstream consumers.

---

### Investigation history
- Cost analysis + levers: `deepseek-delegation-overhead-2026-06-06.md` (the L3/L2/L5 rationale, the
  crossover, the 155/160 finding).
- The single-fn MCP tool it builds on: `deepseek-dev-pipeline-integration-2026-06-06.md` (Architecture A),
  with the reliability + non-thinking fix committed at `b49fc51` (session log
  `docs/development/logs/dev-dsfix-2026-06-06-170108.md`).
- Working prototype this productionises: `D:\tmp\ab-pipeline\pipeline.py` + `results.json` (scratch).
