# DeepSeek Codegen Delegation — Claude-Side Overhead Analysis

**Date:** 2026-06-06
**Status:** Analysis (no code change). Companion to `deepseek-dev-pipeline-integration-2026-06-06.md`.
**Question:** In a controlled A/B benchmark, implementing 3 small self-contained Python functions by
**delegating codegen to DeepSeek** cost ~2× as much and ran ~2× slower than writing them with **pure
Claude** — even though the DeepSeek API call itself was nearly free ($0.0009) and fast (16 s). Why is
the Claude-side overhead so large, how can it be reduced, and is there *any* structure where
delegation beats pure Claude?

**Bottom line up front.** The overhead is **not** the DeepSeek call. It is the **extra Claude agentic
round-trips** the delegation pattern adds, each of which re-reads the entire (and growing) agent
context as cache-read. Cost in this harness is `Σ over API calls (accumulated context × cache-read
price + output × output price + small write)`. The number that matters is **API-call count**: pure
Claude = **7 calls**, DeepSeek-delegate = **18 calls**. Delegation is structurally **≥1 extra
high-context round-trip per function** (prompt-the-model → review-and-apply, on top of test), so for
*small* functions it **cannot** beat pure Claude regardless of how cheap or fast the delegate is. It
can win only when (a) the offloaded work is large enough and (b) the loop runs in a **thin,
minimal-context worker** so each round-trip re-reads ~4k tokens instead of ~50k.

---

## 0. Critical measurement correction (read this first)

The headline token figures supplied with the task — and any number produced by per-record summation
(`sum_usage.py`) — **overcount cache-read and cache-write by the per-call block multiplicity.**

The transcript writes **one assistant record per content block** (one for the thinking/text block,
one per `tool_use` block), but every record of a single API call **shares one `requestId` and carries
an identical copy of that call's `cache_read` / `cache_write` / `input` usage** (only `output_tokens`
accumulates to the last block). Summing usage per *record* therefore multiplies the per-call prefix
cost by the number of blocks in that call.

| | Pure Claude | DeepSeek-delegate |
|---|---:|---:|
| Assistant **records** (per-record sum basis) | 18 | 41 |
| Unique **`requestId`s = real API calls** | **7** | **18** |
| cache-read, per-record sum (reported) | 695,591 | 1,975,260 |
| cache-read, **true per-`requestId`** | **276,078** | **906,725** |
| **Cost, per-record sum (reported)** | **$1.227** | **$2.306** |
| **Cost, true per-`requestId`** | **$0.608** | **$1.155** |

Both the per-record sum and the true cost reproduce **the same ~1.9× ratio** (the two arms have
similar block-multiplicity: 18/7 ≈ 2.6 vs 41/18 ≈ 2.3), so the *relative* conclusion ("delegation ≈
2× the cost") is robust. But the *absolute* dollars are ~2× lower than reported, and — more
importantly — the correct **unit of cost is the API call (`requestId`), not the assistant record.**
Per-record summation also creates a phantom "REPORTING" bucket of ~40% (the thinking-block split of
every tool call); on the true basis that phantom disappears. **All tables below use the true
per-`requestId` basis.** (Token totals on the per-record basis were verified to match the supplied
headline figures exactly, confirming the parser is faithful; the correction is purely the
record→call collapse.)

> Practical note for the benchmark harness: `D:\tmp\ab-measure\sum_usage.py` is fine for an
> *upper-bound* cost and for arm-vs-arm *ratios*, but to attribute cost to steps you must collapse
> records by `requestId` first (script: `D:\tmp\ab-overhead\analyze2.py`).

---

## 1. Measured decomposition (true per-`requestId` basis)

### 1.1 Cost components per arm

| Component | Pure Claude | % | DeepSeek-delegate | % |
|---|---:|---:|---:|---:|
| **cache-read** | $0.138 | 23% | **$0.453** | 39% |
| **cache-write** | $0.250 | 41% | $0.385 | 33% |
| **output** | $0.187 | 31% | $0.284 | 25% |
| input (uncached) | $0.033 | 5% | $0.033 | 3% |
| **TOTAL** | **$0.608** | | **$1.155** | |
| API calls | **7** | | **18** | |
| avg cache-read / call | 39,440 | | 50,374 | |
| DeepSeek API cost | — | | $0.0009 | |

**Cache-read + cache-write together are 64–72% of cost in both arms, and they are pure functions of
(a) how many API calls there are and (b) how big the context is at each call.** Output is a minority
(25–31%). Input (genuinely uncached tokens) is negligible (3–5%) — the agent context is almost
entirely cached. The DeepSeek API itself is **0.08%** of the delegate arm's total ($0.0009 /
$1.155). It is, for cost purposes, free. **The delegate is not what you pay for; the Claude orchestration around it is.**

### 1.2 Per-call buckets

**Pure Claude — 7 calls, $0.608**

| Bucket | calls | cache-read | output | $ | % |
|---|---:|---:|---:|---:|---:|
| HOUSEKEEPING (Step-0 timestamps) | 2 | 60,125 | 107 | $0.212 | 35% |
| FINAL-REPORT | 1 | 50,146 | 3,573 | $0.115 | 19% |
| WRITE-IMPL (all 3 bodies, 1 call) | 1 | 45,702 | 3,564 | $0.114 | 19% |
| SETUP (read SUITE.md + 3 public tests) | 1 | 34,059 | 2 | $0.058 | 10% |
| TEST-SETUP (copy public tests) | 1 | 40,020 | 1 | $0.056 | 9% |
| TEST (pytest, all at once) | 1 | 46,026 | 245 | $0.053 | 9% |

**DeepSeek-delegate — 18 calls, $1.155**

| Bucket | calls | cache-read | output | $ | % |
|---|---:|---:|---:|---:|---:|
| HOUSEKEEPING (Step-0 timestamps) | 2 | 61,072 | 110 | $0.283 | 24% |
| TEST (pytest, **4× incremental**) | 4 | 230,117 | 1,880 | $0.193 | 17% |
| HELPER-INVOKE (run `delegate_cli.py`, ×4) | 4 | 207,853 | 1,485 | $0.188 | 16% |
| FINAL-REPORT | 1 | 61,419 | 3,844 | $0.128 | 11% |
| HELPER-WRITE-SPEC (write temp spec/constraint files) | 1 | 46,766 | 3,352 | $0.123 | 11% |
| HELPER-PARSE (parse helper JSON, ×3) | 3 | 168,794 | 381 | $0.102 | 9% |
| SETUP (read SUITE.md + 3 public tests) | 1 | 34,868 | 301 | $0.066 | 6% |
| TEST-SETUP (copy public tests) | 1 | 49,343 | 5 | $0.049 | 4% |
| INSPECT (read the helper script itself) | 1 | 46,493 | 7 | $0.025 | 2% |

### 1.3 Cache mechanics (why call-count is the driver)

Each call writes a *small* increment to cache (the prior tool result + the new assistant message),
then **reads back the entire accumulated prefix.** cache-read grows monotonically with the
conversation:

- Pure Claude: 10k → 34k → 40k → 46k → 46k → 50k → 50k
- DeepSeek: 0 → 35k → 41k → 46k → 47k → 49k → 53k → 54k → 54k → 56k → 57k → 57k → 58k → 59k → 59k → 60k → 61k → 61k

Average context growth ≈ **3.6k tokens/call**. cache-write is **front-loaded**: call 0 writes the
whole system prefix (Claude 23.7k tok = $0.148; DeepSeek 34.9k tok = $0.218) — a **fixed startup
cost present in both arms**; subsequent writes are small deltas (a few hundred to a few thousand
tokens). So the **marginal cost of one added high-context round-trip** at steady state (~50k context)
is:

```
  ≈ 50,000 × $0.50/1M   (re-read prefix)      = $0.0250
  + ~400  × $25/1M      (a little new output) = $0.0100
  + ~600  × $6.25/1M    (write the delta)     = $0.0038
  ────────────────────────────────────────────────────
  ≈ $0.039 per extra call  (and rising as context grows)
```

DeepSeek's **11 extra calls × ~$0.05 average ≈ $0.55 = the entire measured delta.** This is the whole
story in one line.

---

## 2. Delta attribution: where the extra $0.547 went

True delta = **$1.155 − $0.608 = $0.547** over **+11 API calls**.

| Slice of the delta | $ | share | Reducible by |
|---|---:|---:|---|
| **HELPER-MECHANICS** (invoke `delegate_cli.py` ×4 + parse JSON ×3 + write temp spec files ×1 + read the helper ×1 = 9 calls) | **$0.413** | **75%** | **L1 (live MCP tool), L2 (batch)** — these calls exist *only* because of the CLI-helper plumbing |
| **Extra TEST** (DeepSeek ran pytest **4× incrementally**, $0.241, vs Claude's **1×** all-at-once, $0.108) | **$0.133** | **24%** | **L4 (batch apply+test; test once at the end)** |
| FINAL-REPORT + HOUSEKEEPING + SETUP + TEST-SETUP | ≈ $0.00 net | ~1% | (roughly equal in both arms — not part of the delta) |

**The delta is overwhelmingly HELPER-MECHANICS (75%) — the round-trips spent operating the CLI helper,
not the delegate-loop logic itself.** The "inherent" delegate cost (a genuine review-and-apply of
returned code that pure Claude doesn't pay) is *small here* — the agent mostly applied DeepSeek's
output directly and leaned on the test gate. The dominant waste is the **mechanical plumbing** of the
out-of-band CLI helper:

- one call to **write** five temp `spec_*.txt` / `constraints_*.txt` files,
- one call per function to **invoke** the helper via PowerShell,
- one call per function to **parse** the returned JSON (a separate `python`/`ConvertFrom-Json` step),
- one call to **read the helper script** itself to learn its interface.

A single structured MCP `tool_use` per delegation collapses **write-spec + invoke + parse** into **one
call** and eliminates the INSPECT entirely. That is lever L1, and it removes most of the 75%.

> Why the CLI helper existed: the live MCP tool (`mcp__deepseek-codegen__delegate_codegen`, one
> structured `tool_use` per delegation) was stale-until-reload during the benchmark, so the agent
> drove DeepSeek through `D:\tmp\ab-rebench\delegate_cli.py` over PowerShell instead. That detour is
> the single biggest, most reducible cost.

---

## 3. The structural floor (why small functions can't win)

**Per small function, count the high-context Claude round-trips each strategy must make.** "High-context"
means a call that re-reads the full agent prefix (~50k tokens) at $0.50/1M — i.e. essentially every
agentic call.

| Step | Pure Claude | Delegate (best case, live MCP) |
|---|---|---|
| Produce the body | **write impl** (1 call: Claude emits code as output) | **prompt the delegate** (1 call: the `tool_use`) |
| Get it back into the file | (same call — the write *is* the body) | **review + apply** (1 call: read returned code, write impl) |
| Verify | test | test |

Pure Claude folds "produce" and "apply" into **one** call — the body *is* the assistant's output, and
the same `tool_use` writes it to disk. Delegation **cannot** fold them: the body comes back in a
*separate* delegate response, so a *subsequent* Claude call must ingest and apply it. That is an
**irreducible ≥1 extra high-context round-trip per function** (more in practice — the CLI helper made
it 3–4). The delegate being free and fast does not remove this call; the cost is the Claude prefix
re-read, which is identical whether the body came from DeepSeek or from Opus's own head.

### 3.1 Crossover condition (exact)

Let:
- `F` = Opus **output tokens** the delegate offloads (the body Claude would otherwise have written),
- `N_extra` = extra high-context Claude calls delegation adds vs pure Claude (≥1 per function),
- `ctx` = accumulated context size at those calls (tokens).

Delegation wins only when **offloaded value > added round-trip cost**:

```
   F × $25/1M   >   N_extra × ctx × $0.50/1M
   ⇔   F  >  N_extra × ctx × 0.02            (tokens)
   ⇔   ctx  <  F / (N_extra × 0.02)          (the break-even context)
```

(Output dominates the "value" side because Opus output is $25/1M; the delegate's own ~$0.0009 is
negligible and omitted. The "cost" side is dominated by cache-read of the prefix.)

**Plugging in this benchmark** (`N_extra = 1` in the ideal MCP case, `ctx ≈ 50k`):

| Function size `F` (Opus output tokens) | Break-even context (must be below) | Verdict at 50k context |
|---:|---:|---|
| 300 | 15,000 | ❌ loses (need <15k ctx) |
| **1,200** (≈ each function here) | **60,000** | ⚠️ break-even — **no margin** |
| 5,000 | 250,000 | ✅ wins |
| 20,000 | 1,000,000 | ✅ wins easily |

The three benchmark functions were ~1,200 output tokens **each** (Claude wrote all three in one call =
3,564 output tokens). At 50k context that is **exactly break-even with one extra call** — and the
CLI-helper flow made `N_extra ≈ 3–4`, pushing it **deeply underwater**. **Conclusion: for
small-to-medium functions at a normal ~50k agent context, delegation cannot beat pure Claude on cost,
no matter how cheap the delegate is.** The break-even is governed by `ctx`, not by the delegate price.

---

## 4. Reduction levers (ranked, quantified against the measured data)

Estimates are anchored to the measured per-call costs (§1.3): a high-context call ≈ $0.039–0.05 at
~50k context; cache-read scales linearly with `ctx`.

### Ranking

| Rank | Lever | Mechanism | Est. effect on the **$1.155** delegate arm | Removes the structural floor? |
|---|---|---|---:|---|
| **1** | **L3 — minimal-context worker** | run delegate+review+apply in a thin sub-agent whose prefix is (spec+test) ≈ 4k, not ~50k | cache-read of the loop drops ~12.5× → loop ≈ **$0.10** total | **Yes** — lowers `ctx` in the crossover |
| **2** | **L1 — live MCP tool** | one structured `tool_use` replaces write-spec+invoke+parse+inspect | removes ~6 calls, **saves ≈ $0.30** → arm ≈ **$0.85** | No (still ≥1 extra call) |
| **3** | **L6 — cheap model drives the loop** | Sonnet/Haiku, not Opus, runs delegate+review+apply | whole arm ×0.6 (Sonnet) → **$0.69**; ×0.2 (Haiku) → **$0.23** | No, but cheapens every call |
| **4** | **L2 — batch N specs in one call** | 1 delegate carrying 3 specs → 3 bodies; 1 apply | 18 → ~5 calls, arm ≈ **$0.42** | Partly (amortizes the extra call over N) |
| **5** | **L4 — fold steps, test once** | inline spec; apply+nothing-else; pytest once at end; skip review on first-pass green | removes the 4×→1× test waste, **saves ≈ $0.13** | No |
| **6** | **L5 — parallel fan-out** | delegate N functions concurrently | **$0 cost change**; cuts wall-clock only | No |

### Detail

**L3 — minimal-context delegation workers (the key insight; rank 1).**
The cost is cache-read of the **big** `/fn`-agent prefix on every loop turn. If each delegation runs in
a **thin sub-agent** seeded with only `(function spec + public test)` — say 3–5k tokens — instead of
the full accumulated `/fn` history (~50k, and up to ~480k in a deep `/dev` session), then cache-read
**collapses by the same factor**. The 9 helper+review calls cost ≈ $0.44 in cache-read at ~50k; at
~4k they cost ≈ **$0.035**, plus the worker's own one-time startup write (~$0.02). A worker doing the
full delegate+review+apply lands around **$0.10**. Critically, **L3 is the only lever that changes the
crossover** — it shrinks `ctx`, dropping break-even from F≈1,000 tokens (at 50k) to **F≈80 tokens (at
4k)**, at which point almost any function clears the bar. In a `/dev` context at 480k, the parent's
cache-read per call is ~$0.24 — there L3 is not an optimization, it is **mandatory** (a single extra
full-context round-trip costs $0.24, dwarfing any function body).

**L1 — live MCP tool instead of the CLI helper (rank 2).**
HELPER-MECHANICS+INSPECT = **9 calls, $0.413** (75% of the delta). A live `tool_use` per delegation
folds write-spec + invoke + parse into **one** call and removes the read-the-helper call. ~9 → ~3
calls; at ~$0.045 each that's ~$0.135. **Saves ≈ $0.30**, dropping the arm from $1.155 to ≈ **$0.85**.
This is the highest-value *plumbing* fix and should be the default the moment the MCP server is
reliably loaded — but it does **not** make delegation cheaper than pure Claude; it only removes the
self-inflicted CLI overhead.

**L6 — drive the delegate loop with Sonnet/Haiku, not Opus (rank 3).**
The delegate+review+apply loop is mechanical (format a prompt, paste back code, run a test) — it does
not need Opus intelligence. Re-pricing the **whole** delegate arm:

| Model | cache-read $0.453 | output $0.284 | cache-write $0.385 | **Arm total** |
|---|---:|---:|---:|---:|
| Opus 4.8 (measured) | $0.453 | $0.284 | $0.385 | **$1.155** |
| Sonnet 4.6 (×0.6) | $0.272 | $0.171 | $0.231 | **$0.69** |
| Haiku 4.5 (×0.2) | $0.091 | $0.057 | $0.077 | **$0.23** |

On **Haiku**, the entire delegate arm ($0.23) finally drops **below pure-Opus-Claude ($0.608)** — but
that is comparing a *Haiku-driven delegate* against an *Opus* baseline, which is not apples-to-apples
(a Haiku pure-Claude baseline would also be ~$0.12). The honest reading: **the cheap-model lever is
real and large, but it cheapens the baseline too.** It matters most **combined with L3** (a Haiku
worker at 4k context is the cheapest possible delegate executor) and as a way to keep the *expensive
Opus parent* off the mechanical loop.

**L2 — batch delegation (rank 4).**
One `tool_use` carrying all 3 specs → 3 bodies in one response; one apply call writing all 3 impls;
one pytest. Calls collapse from 18 to roughly **setup(1)+batch-delegate(1)+write-3-impls(1)+test(1)+
report(1) = ~5**, arm ≈ **$0.42**. Batching **amortizes the one irreducible extra round-trip over N
functions** — the `N_extra` in the crossover becomes `1/N` per function instead of `1`. With N=3 the
per-function break-even `F` drops 3× (to ~330 tokens at 50k). The non-thinking DeepSeek's correctness
cost (155/160 — it cut edge-case corners) means batched bodies **must** go through the existing public
test gate; batching does not relax that.

**L4 — cut per-function Claude steps (rank 5).**
Inline the spec in the tool call (no temp files — already subsumed by L1); combine apply with nothing
else; run pytest **once at the end** rather than after each function (removes the measured 4×→1× test
waste, $0.241 → $0.108, **saves $0.13**); and **skip the review step for any body that passes the test
on the first run** (review only on red). These are cheap, compounding, and safe given a hard test gate.

**L5 — parallel fan-out (rank 6).**
Delegating N functions concurrently saves **wall-clock/latency only** — it does **not** reduce
per-function Claude round-trip cost (the same calls happen, just overlapped). It is the answer to "why
was it 2× *slower*" (the 18 serial round-trips, each a full Opus prefill + a synchronous DeepSeek HTTP
call, dominate the 183 s wall — the DeepSeek call itself was 16 s of it). Fan-out only helps the
**cost** equation when **combined with L2/L3** (parallel thin workers). Alone, it is a latency lever,
not a cost lever.

---

## 5. Synthesis & recommendation

### Is there an architecture where delegation beats pure Claude end-to-end?

**Yes, but narrowly, and only with L3 at its core.** Stack the levers:

> **Recommended design — "thin batched delegate worker on a cheap model."**
> 1. **One batched MCP call (L1+L2):** the `/fn` (or `/dev`) agent sends *all* function specs +
>    their public tests to `mcp__deepseek-codegen__delegate_codegen` in a **single** structured
>    `tool_use` — no temp files, no PowerShell, no JSON-parse round-trips.
> 2. **Minimal-context executor (L3):** the review-and-apply-and-test loop runs in a **thin
>    sub-agent** whose context is just `(returned bodies + tests)` ≈ a few k tokens — never the
>    parent's 50k–480k history. This is what actually moves the crossover.
> 3. **Cheap driver (L6):** that worker runs on **Haiku/Sonnet**, not Opus. The loop is mechanical;
>    reserve Opus for the parent's judgment.
> 4. **Test-gated, review-on-red-only (L4):** apply each body, run the public test **once**; only
>    spend a review turn on bodies that fail. The non-thinking DeepSeek (155/160) leans on this gate
>    by design.

**Where it pays off (the conditions, precisely):**

- **Function size `F` (offloaded Opus output) must clear `F > N_extra × ctx × 0.02` tokens.** With
  the recommended design `N_extra/N → small` (batching) and `ctx → ~4k` (thin worker), break-even
  drops to **F ≈ 80 tokens** — essentially **any** real function clears it.
- **Batch size `N` ≥ 3** — amortizes the irreducible extra round-trip and the worker's startup write.
- **Count** — the design only earns its complexity when you are generating **several** functions in a
  run (a suite, a module of helpers, a batch of adapters), not one.
- **Parent context is large** — the bigger the parent (`/dev` at 480k >> `/fn` at 50k), the more L3
  saves, because the avoided cost is *the parent's* per-call cache-read.

**Where it does NOT pay off (be honest):**

- **One small function in a fresh `/fn` session.** Pure Claude is **7 calls / $0.61**; even the ideal
  single-MCP-call delegate is ≥1 extra high-context round-trip with no batch to amortize it →
  break-even at best, usually a loss. Just let Claude write it. The measured benchmark **is** this
  case, which is why delegation lost ~2×.
- **As a cost play in isolation.** Without L3, no amount of L1/L2/L6 gets delegation below pure
  Claude at parity — the extra round-trip's prefix re-read is the floor.
- **When correctness matters more than a green public test.** Non-thinking DeepSeek scored **155/160**
  — it cuts edge-case corners. The whole design rests on the test gate catching that; if the tests
  are thin, delegation ships subtly wrong bodies that pure Opus would have gotten right.

### The honest conclusion

For the **measured workload** (3 small functions, fresh session, Opus driving a CLI helper),
**delegation is not worth it** — it is structurally ≥2× the round-trips and therefore ~2× the cost,
and the DeepSeek call's near-zero price is irrelevant because the cost lives entirely in Claude's
re-read of its own growing context. Delegation becomes worthwhile **only** when you (1) **batch** many
functions, (2) run the loop in a **minimal-context worker** so each round-trip re-reads ~4k not ~50k,
and (3) drive that worker with a **cheap model** — at which point you are essentially building a small
specialized codegen pipeline, not "asking Opus to call DeepSeek mid-conversation." The single most
important number is the **API-call count**, and the single most important lever is **L3 (shrink the
per-call context)**, because it is the only one that moves the crossover rather than just trimming
the constant.

---

## Appendix — method & reproducibility

- **Transcripts:**
  `…/4b61e00e-…/subagents/agent-a88fd191529f5f27a.jsonl` (pure Claude, `fn-claude2`),
  `…/agent-a0e332e82c7cf2423.jsonl` (DeepSeek, `fn-deepseek3`).
- **Pricing (Opus 4.8, verified against the `claude-api` skill catalog):** input $5, output $25,
  cache-read $0.50 (0.1× input), cache-write-5m $6.25 (1.25×), cache-write-1h $10 (2×), all per 1M
  tokens. The supplied `sum_usage.py` uses these exact rates.
- **Scripts (scratch, not in repo):** `D:\tmp\ab-overhead\analyze.py` (per-record, reproduces the
  reported headline figures — token totals matched the supplied numbers to the digit) and
  `D:\tmp\ab-overhead\analyze2.py` (the corrected per-`requestId` collapse that all §1–§4 numbers use).
- **Correction validated by `requestId`:** 18 records collapse to 7 calls (Claude), 41 to 18
  (DeepSeek); within each `requestId`, `cache_read`/`cache_write`/`input` are byte-identical across
  the split records and only `output_tokens` accumulates — confirming the records are display-splits
  of one billed response, not separate billed events.
- **Estimates** in §4 are first-order: a high-context call ≈ (ctx × $0.50/1M + output × $25/1M + write
  × $6.25/1M); model-swap factors are the ratio of cache-read/output/write prices (Sonnet 0.6×/0.6×/
  0.6×, Haiku 0.2×/0.2×/0.2× of Opus). They are bounds for ranking, not penny-exact forecasts.
