# Composition seed — model-agnostic-agents-2026-06-19

Side seed for `docs/proposals/model-agnostic-agents-2026-06-19.md`. Preserves the design-evolution log,
per-decision reasoning, and procedure observations made while composing the proposal, so the durable
proposal reads as a clean spec while none of the compositional history is lost. Also the input to a future
refinement pass of that proposal.

**Build mode:** Mode A (draft-first) — chosen over Mode B (dialog-from-scratch) DESPITE the work being
complex/high-stakes (where the skill prefers B) because the invoking context was a **DESIGN-ONLY sub-agent
pass** with an explicit instruction to "produce a concrete phased spec for user review" + "report open
questions needing a user decision". There is no live user turn-taking in this context, so the
one-question-at-a-time dialog is replaced by an explicit **open-decisions table (OD-1..OD-5)** for the user
to resolve at review — the same governance/traceability/element-kind discipline applied during drafting
rather than during co-construction. If the user wants the structure itself co-designed, re-run as Mode B.

---

## Grounding pass (what the design sits on — measured, not assumed)

Read READ-ONLY before drafting:
- `docs/proposals/standalone-process-agents-2026-06-19.md` (the foundation — extended, not duplicated).
- The vision memory `project_model_agnostic_agents_2026-06-19.md` + `MEMORY.md` index entries.
- The supervisor seam, in full: `session-driver.ts`, `cli-stream-driver.ts`, `sdk-session-driver.ts`(by ref),
  `session-host.ts`, `lifecycle.ts`, `permission-router.ts`, `profiles.ts`, `driver-policy.ts`,
  `cost-safety.ts`, `channel-tool.ts`, `config.ts`, `contract.ts`, `index.ts`, `launch-prod-orch.mjs`.
- The DeepSeek precedent: `tools/deepseek-codegen-mcp/core.py` + `README.md`.
- The orchestrator skill Mode B/B1/B2 section in `.claude/commands/orchestrator.md`.

Key measured facts that SHAPED the design (not invented):
1. **`SessionDriver` is already a normalized, vendor-decoupled seam** (start→AsyncIterable<SessionEvent>,
   send/interrupt/stop/health). It was built precisely to decouple the supervisor from one uncertain backend.
   → It IS the uniform agent contract; inventing a new contract would violate CP6 (reuse). This is the single
   biggest leverage point and it makes the whole Campaign small.
2. **Two drivers already satisfy it** (`CliStreamDriver`, `SdkSessionDriver`), constructed at ONE site
   (`index.ts`) via a pure `driver-policy.ts` resolver. → The role-router + backend-registry MIRROR that exact
   pattern (a pure resolver + a factory at the construction site). Precedent, not new architecture.
3. **The cost-safety guard is the central tension.** `assertCostSafe` THROWS on ANY `ANTHROPIC_API_KEY`/
   `ANTHROPIC_AUTH_TOKEN` (it is the "stay on the subscription" invariant). A DeepSeek/Codex backend REQUIRES
   a key. → CP4 (key-free) and CP2 (best-model-per-role) collide. Resolution = make the guard BACKEND-AWARE
   (per-backend scoped secret + foreign-key assertion). This is OD-1 — surfaced to the user, NOT decided
   silently, because it relaxes a safety-relevant invariant for non-Claude backends.
4. **The deepseek-codegen-mcp already proves the DeepSeek-via-API key/error/pin/no-side-effects pattern**
   (`DEEPSEEK_API_KEY` env-only, never logged; model pinned; thinking disabled; pure compute-in/text-out).
   → M5 (api-adapter driver) reuses it. But note the DISTINCTION (re-homed, not folded): that MCP is a Claude
   agent CALLING a DeepSeek tool; this Campaign's coding=DeepSeek is the AGENT ITSELF being DeepSeek.
5. **The result-relay already exists** (`onResult`/`sendToOperator`; the `channel-tool` reply pattern; an
   in-process sub-agent's final report returns as the orchestrator's tool_result). → M6 reuses the shape;
   agents stay channel-mute (AP6) — only the orchestrator speaks to the user.
6. **Worktree isolation already exists** (`SUPERVISOR_SESSION_CWD` + `SUPERVISOR_WORKTREE_CLEANUP` teardown,
   `launch-pty-orch.mjs`). → X3 reuses it (a cross-cutting rule, NOT a new module).
7. **De-risking (today):** ≥64 concurrent sealed `claude -p` ran clean (no seat cap → rate/token-gated);
   `--setting-sources project,local` seals the plugin hijack. → CP3/CP4 framing (cap is generous but present;
   seal is universal); confidence on "no licensing cost" is now HIGH-measured, not inferred.

---

## Design-evolution log (decisions + the reasoning behind each)

**E1 — Adopt `SessionDriver` AS the contract (M1), do not invent one.** First instinct on "uniform agent
contract" is to design a fresh interface. Rejected: the seam already exists, is tested, and already abstracts
a backend. The ONLY honest gap for non-Claude backends is *capabilities* (a bare api model has no
tool-permission surface, no resume, no teams) — so the single extension is a **capability descriptor**, which
lets FD4 (permission routing) treat a tool-less backend correctly instead of mis-wiring the router. Minimal
surface area = maximal reuse (CP6) and keeps CP1 honest.

**E2 — Routing is DATA, resolved by a PURE function (M2/AP2), mirroring `driver-policy.ts`.** The user's whole
point is "swap the model per role." If routing were code constants, every change is a rebuild. So `role →
{backend, model, fallback}` is config; the resolver is pure (unit-testable, no I/O), with explicit precedence
(per-dispatch override > config > fail-safe default = claude-cli). Fail-safe default to the PROVEN backend
(never a hard error on an unmapped role) follows the existing `resolveDriverSelection` "fall back to the
recommended, never to a retired/unknown" discipline.

**E3 — The seal must be UNIVERSAL + per-backend, at ONE choke-point (M4/AP4/CP3).** The standalone-process doc
already made this the single biggest engineering risk ("N processes = N chances to breach"). Generalizing to
N BACKENDS makes it sharper: each backend has a DIFFERENT seal (claude-cli seals via setting-sources +
deny-list; an api-adapter isn't Claude Code at all, so its seal is channel-mute + scoped key + no FS/tools).
The cost guard becomes the SECRET guard: not just "no Anthropic key" but "exactly this backend's key, no
foreign billing key." Making the unsealed/cross-credential spawn UNREPRESENTABLE (one launcher) is the
invariant. This is where the CP4/CP2 tension lives → OD-1.

**E4 — Phase 1 proves the contract with CLAUDE before any vendor (CP7 + the decision hierarchy).** The
temptation is to jump to DeepSeek (the visible payoff). Rejected: the RISK is the contract/routing/relay
plumbing, not DeepSeek (DeepSeek-via-API is already proven by the MCP). So Phase 1 routes ONE role
(`planning`) to a sealed standalone CLAUDE agent — reusing `CliStreamDriver` — and proves dispatch→seal→run→
relay end-to-end with ZERO new vendor risk. Only then (P3) add the api-adapter. This is the skill's "smallest
end-to-end slice that proves the contract" applied literally + the user's stated Phase-1 instruction.

**E5 — Additive + dormant-until-activated (CP5/AP5/X5), because it hosts the live session.** The hard
constraint (and the decision hierarchy's top: CP5 > all) is that the orchestrator we are running inside is
the live host. So everything is behind a default-OFF switch; with routing OFF the orchestrator profile
resolves byte-for-byte as today (cli-stream, in-process teams). Activation is a SEPARATE approved phase (P6)
with a coordinated rebuild/restart the USER triggers. The design pass itself touches no git/build/restart.

**E6 — Routed standalone agents are channel-mute (AP6); in-process teammates stay (E-boundary).** Two
mechanisms coexist (the standalone-process doc's hybrid): (a) the orchestrator's cheap in-process Agent/Task
teammates (chatty roles like /fn) — UNCHANGED, out of routing scope; (b) routed standalone agents (the
heavy/role-specific work) — the subject of THIS Campaign. Surfaced in §C framework-validation as a boundary,
not a misfit, so the taxonomy doesn't over-claim.

**E7 — OD-2 (process vs in-runtime API client) deliberately left OPEN, recommendation = in-runtime for v1.**
The standalone-process doc's crash-isolation argument is strongest for FS-writing/long agents. A pure
DeepSeek/Codex codegen turn is low-blast-radius (no FS, no tools — OD-5). So v1 can run it as an in-runtime
client (no cold-start, simpler) with the SAME contract, movable to a separate process later if needed. Left
open because it's a real cost/isolation trade the user should weigh.

---

## Procedure observations (structural notes surfaced during composition)

- **PO-1 (element-kind discipline paid off):** three candidates that LOOK like modules are actually
  cross-cutting rules or structures — concurrency cap (X2, spans all agents → rule), worktree isolation (X3,
  reuse of an existing mechanism → rule), and "DeepSeek codegen" (already an MCP tool → a REFERENCE, and the
  new concern is the AGENT being DeepSeek, M5). Re-homed with one-line pointers (the §M re-homing notes) so
  nothing is lost and no false module is created. Classify-the-kind-first prevented a name-driven module.
- **PO-2 (concern- vs name-driven):** "cost-safety" is named for the Claude subscription guard, but its
  CONCERN is "the right billing credential, no foreign key." Generalizing it to backend-aware is the concern
  expanding, not a new module — so M4 OWNS it rather than spawning a parallel "secret-manager."
- **PO-3 (the one real principle conflict was surfaced, not silently picked):** CP4 (key-free) vs CP2
  (key-bearing non-Claude backend). The decision hierarchy puts CP4 > CP2, which WOULD forbid non-Claude
  backends — but that defeats the Purpose. So the resolution (per-backend scoping) is a deliberate, named
  relaxation presented to the user (OD-1), not a quiet override of the hierarchy. This is exactly the
  "surface conflicting principles to the user to prioritize" rule.
- **PO-4 (completeness walk found CP6 has no runtime flow):** walking principles→flows, CP6 (reuse) implies no
  recurring runtime PROCESS — it's realized structurally (adopting the seam in the modules). Recorded as
  "structural — reuse" in §0.5 + §T rather than inventing a spurious flow. An unrealised-principle check that
  came back clean-with-a-note, not a gap.
- **PO-5 (spawner demotion):** the standalone-process doc is demoted to a REFERENCE for this Campaign (the
  "when a Campaign is spawned, the spawner becomes a reference" rule) — THIS proposal is now the governing doc
  for the agent-execution layer; the standalone-process doc remains the decision-support for the process model
  it sits on.

---

## Superseded / considered-and-dropped framings

- **(dropped) A brand-new `AgentContract` interface parallel to `SessionDriver`.** Dropped per E1 — pure
  duplication; the seam already is the contract.
- **(dropped) Per-vendor orchestration code paths (if claude … else if deepseek …).** Dropped — violates CP1
  (no vendor special-casing in runtime/orchestration); the registry + capability descriptor absorb the
  variance behind the contract.
- **(dropped) Making routing always-ON in the orchestrator profile from P1.** Dropped per E5/CP5 — must be
  default-OFF + dormant until a coordinated activation; never change the live default mid-build.
- **(considered) Standalone process for EVERY non-Claude agent from v1.** Deferred to OD-2 — kept as the
  contract-compatible upgrade path, but v1 recommends in-runtime client for the low-blast-radius pure-API turn.

---

## Open-decision tracking (mirror of §D OD-1..OD-5 — the user resolves these at review)

| OD | Crux | Why it must precede the build |
|---|---|---|
| OD-1 | per-backend key scoping (relaxes the key-free guard for non-Claude only) | changes a safety invariant — needs explicit user sign-off (P2 bakes the decision in) |
| OD-2 | api-adapter as separate process vs in-runtime client | sets M5's execution shape (and whether X1/X3 apply to it) |
| OD-3 | real paid spend on DeepSeek + OpenAI/Codex + caps | money leaves the subscription — user budget decision |
| OD-4 | "Codex" = OpenAI-API coding models (OpenAI-compatible)? | confirms M5 serves both via config + the `OPENAI_API_KEY` name |
| OD-5 | do non-Claude agents get tool/FS access, or pure compute-in/text-out for v1? | decides whether they need the permission router + a tool seal (capability descriptor) |
