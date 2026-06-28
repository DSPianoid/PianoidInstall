# Module Review — Model-Agnostic Agent System (the dormant island)

- **Scope:** the model-agnostic agent-execution + routing ISLAND in `tools/supervisor/src/` built by the
  `model-agnostic-agents-2026-06-19` Campaign (P0–P5): `backend-kinds.ts`, `role-router.ts`,
  `backend-registry.ts`, `backend-seal.ts`, `cost-safety.ts` (the backend-aware append),
  `api-adapter-driver.ts`, `result-relay.ts`, `agent-worktree.ts`, `agent-concurrency.ts`, and the
  `session-driver.ts` capability-descriptor extension.
- **Branch:** `feature/model-agnostic-agents` · **Reviewed at:** HEAD c7dba49 (P0–P5 landed) → this review + the
  two activation-gate fixes (H-1, M-1) committed on top.
- **Reviewer:** dev-2870 (module-level review, post-P5).
- **Authoritative spec:** `docs/proposals/model-agnostic-agents-2026-06-19.md`.

> **★ Status update (this batch).** The two activation-gate findings below — **H-1 (real per-agent
> git-worktree isolation)** and **M-1 (real per-agent token/cost metering)** — are **RESOLVED** by this
> batch's commits on `feature/model-agnostic-agents` (the H-1 worktree-create/teardown commit + the M-1
> token/cost-metering commit + this review doc). They are no longer open. **L-1** (confirm the real Codex
> model id) remains an **activation-time** (P6) confirmation, by design.

---

## Verdict

**No Critical findings. Nothing blocks the DORMANT landing.** The island is additive, unreferenced by the
live path, and default-OFF; with `SUPERVISOR_ROLE_ROUTING` unset the supervisor behaves byte-for-byte as
today. The two activation-gates that would have mattered *when routing is switched on* (worktree isolation;
real cost metering) are now implemented (H-1, M-1). The remaining item (L-1) is a one-line confirmation at
activation, not a code defect.

The Campaign may land dormant as-is.

---

## The 7 review dimensions — all PASS

| # | Dimension | Verdict | Evidence |
|---|---|---|---|
| 1 | **Seal / containment** | PASS | `backend-seal.ts` forces `settingSources ['project','local']` (never `'user'` → no telegram-plugin hijack), merges the `UNIVERSAL_CHANNEL_DENY` into the deny-list for EVERY backend, and refuses an unknown backend kind (fail-fast). api-adapter agents are channel-mute (no FS/git tool surface, OD-5). `result-relay.ts` has NO channel/`send` reference at all — a routed agent reaches the user only via the orchestrator relay (AP6). |
| 2 | **Cost-guard safety** | PASS | The LIVE `assertCostSafe` (the strict "no Anthropic key, ever" subscription guard) is **byte-for-byte unchanged** — the backend-aware guard (`assertBackendCostSafe`, per-backend key scoping OD-1) is a PURE ADDITIVE append consumed only by the dormant seal. The cli-stream orchestrator path still calls the original. |
| 3 | **Dormancy** | PASS | `index.ts` is UNTOUCHED (verified: not in the diff). The island is an unreferenced set of modules — nothing in the live composition root imports the router/registry/relay. `SUPERVISOR_ROLE_ROUTING` defaults OFF (`isRoleRoutingEnabled` returns false unless explicitly `1/true/on`); the harness gates dispatch on it. P6 (the index.ts wiring + user-triggered rebuild/restart) is the only activation path and is separately approved. |
| 4 | **Contract** | PASS | A dispatch yields **exactly one terminal `result`** (relay breaks on the first `result`; the api-adapter driver's stream ALWAYS terminates with one `result`, success or a surfaced error — its catch is total). Errors are SURFACED (`ok:false` reports / `AgentDispatchError` on a crash), not thrown into the orchestrator. The driver is always `stop()`-ed in a `finally` → no leaked child (CliStreamDriver tree-kill). |
| 5 | **Fallback** | PASS | `dispatchRoleAgentWithFallback` re-dispatches **at most ONCE** (the fallback dispatch is a plain `dispatchRoleAgent` that never itself falls back — no chains, no loops → a failure can't wedge the host, CP5). On fallback to the key-free claude-cli, the env is SCRUBBED of every known api-adapter secret (`scrubBackendSecrets`) so no foreign metered key leaks into a Claude agent (CP3). |
| 6 | **Tests strong** | PASS | 126 island cases pre-batch (now 155 with the H-1/M-1 additions); full supervisor `node:test` green. **6 security properties asserted**: (a) seal forces project,local — never user; (b) channel-deny always present; (c) claude env key-free or it throws; (d) a foreign key in an api-adapter env is REFUSED; (e) the api-adapter key VALUE never appears in any emitted event (secret hygiene); (f) fallback env is scrubbed of foreign secrets. All drivers are injectable (fake spawn / fake HTTP client) → NO real spawn, NO network, NO paid call in any test. |
| 7 | **Quality** | PASS (high) | One concern per module (P2); every module carries a `traces-to:` header back to the proposal's CP/AP/FD ids; pure resolvers (`role-router`, `agent-concurrency`, `cost-safety`) are side-effect-free + unit-tested; the registry/seal/relay are cleanly separated (construct vs seal vs run). |

---

## Activation-gates (the items that matter WHEN routing is switched ON)

| ID | Gate | Severity | Status |
|---|---|---|---|
| **H-1** | **Real per-agent git-worktree isolation for FS-writing claude agents.** Pre-batch `agent-worktree.ts` only PLANNED (`planAgentWorktree` returned `{needsWorktree, sessionCwd}` and created no worktree) — so two concurrent FS-writing routed agents would have shared ONE working tree (the `feedback_concurrent_dev_worktree` corruption). | High (only at activation) | **RESOLVED (this batch).** Added an injectable `GitWorktreeRunner` + `createAgentWorktree`/`ensureAgentWorktree`/teardown that REUSE the exact launcher/index.ts git pattern (`worktree add --detach <path> HEAD` / `remove --force` / `prune`), wired at the result-relay choke-point (opt-in `manageWorktree`, default OFF): an FS-writing claude agent without an existing isolation cwd gets its OWN worktree created before launch + torn down in the finally (even on crash); a compute api-adapter agent gets none; an already-isolated agent reuses the launcher's. Tests MOCK git — no real worktree is created in this repo. |
| **M-1** | **Real per-agent token/cost metering for the api-adapter backends.** Pre-batch the streamed request did not request a usage block, so `AgentReport.costUsd`/tokens were undefined for api-adapter agents and the X2 budget gate could only be charged an estimate (CP4/FD5 not realized). | High (only at activation) | **RESOLVED (this batch).** Added `stream_options:{include_usage:true}` to the request; `parseStreamPayload` now extracts the full `usage` block (prompt/completion/total); the driver attaches `result.tokens` and COMPUTES `result.costUsd` from a CONFIGURABLE per-model rate table (`DEFAULT_MODEL_RATES`, overridable per `ApiAdapterConfig.rate`) when the backend reports no `total_cost_usd` (the OpenAI/Codex case); the relay forwards tokens into `AgentReport` AND releases the X2 gate lease with the REAL token count. A missing usage block degrades gracefully (tokens/cost undefined, no crash). Tests inject a fake client (zero spend). |
| **L-1** | **Confirm the real Codex model id at activation.** `gpt-5-codex` is a CONFIGURABLE PLACEHOLDER pin (`CODEX_REVIEWING_CONFIG` / `DEFAULT_API_ADAPTER_CONFIGS` / `DEFAULT_ROLE_ROUTING_CONFIG`); the registry keys on the model id so changing it in one place re-points the whole route. | Low | **OPEN by design** — an activation-time (P6) confirmation (OD-4), not a code defect. The default rate in `DEFAULT_MODEL_RATES['gpt-5-codex']` is likewise a placeholder confirmed before real spend (OD-3). |

---

## Minor findings (non-blocking)

| ID | Finding | Disposition |
|---|---|---|
| **M-2** | `api-adapter-driver.ts` is **YELLOW** — 540 LOC pre-batch, now **646 LOC** after the M-1 metering additions (token usage parse + rate table + cost compute). Still under the 1000-LOC RED split-trigger but worth a split when it next grows. | Recorded. Natural split lines: extract the SSE/usage parsing (`parseStreamPayload`/`iterateSsePayloads`/`TokenUsage`) into a `api-adapter-sse.ts`, OR the config/rate tables (`*_CONFIG`/`DEFAULT_MODEL_RATES`/`resolveRate`/`computeCostUsd`) into a `api-adapter-config.ts`. Not done now (the batch scope is H-1/M-1; a split would churn the file mid-fix). |
| **M-3** | The seal's `assertCostSafe`/`assertBackendCostSafe` runs **2–3× per dispatch** (once in `planRoleDispatch`, again inside `dispatchRoleAgent` via the same `planRoleDispatch`, and once more in the fallback path's pre-resolve). | Acceptable — it is a PURE, deterministic, cheap env inspection (no I/O); re-running it is safe and fail-fast-consistent. Recorded, not changed. |
| **M-4** | A stale docstring in `backend-kinds.ts` referenced `DEFAULT_ROLE_BACKENDS` (a name that never shipped — the real const is `DEFAULT_ROLE_ROUTING_CONFIG` in `role-router.ts`). | **FIXED (this batch)** — trivial docstring correction. |

---

## Notes

- This review covers the DORMANT island only. The live cli-stream orchestrator (the hosted supervisor that
  dispatched this work) is out of scope and was not modified.
- The proposal stays at `docs/proposals/` (top-level) — the Campaign is NOT fully shipped (P6 activation is
  still pending), so it is correctly not archived.
- Verification of this batch: full supervisor `node:test` 404/404 green; `tsc --noEmit` clean against the real
  tsconfig; NO real git worktree created in this repo; NO real paid API call; production `dist/` NOT
  regenerated; the live supervisor NOT restarted; `index.ts` untouched.
