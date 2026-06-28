# Multi-Tenant Supervisor Platform — Proposal

**Date:** 2026-06-20
**Status:** PROPOSED — **PARKED** (design captured; not scheduled)
**Builds on:** the M12 single-tenant supervisor (`tools/supervisor/`)
**Origin:** design session (CLI orchestrator + user)

---

## Motivation

The M12 supervisor today hosts **one** orchestrator for **one** user over a single Telegram
bot. The goal is to evolve it into a **multi-tenant platform**: one bot serving **several**
users, each with a **dedicated agent** in its **own isolated environment** — effectively
"Claude-Code-orchestrator-as-a-service over Telegram."

## Decisions taken (this session)

- **Users:** EXTERNAL (untrusted), **dozens** for an initial test cohort, with potential
  scaling up.
- **Billing:** **per-user API keys** (each user supplies their own `ANTHROPIC_API_KEY`).

These two are load-bearing — they force the architecture below.

### Consequences

1. **Hard isolation is mandatory.** External = untrusted, and a hosted orchestrator runs
   arbitrary code (Bash, builds, sub-agents). Per-user worktrees/dirs are NOT sufficient
   (shared kernel + reachable host secrets) → **containers minimum; microVMs for truly
   untrusted**.
2. **Billing inverts — and the worst constraint disappears.** Per-user keys remove the shared
   single-subscription concurrency ceiling (each user's usage bills their own key). This
   **flips the M12 cost-guard**: the host/control-plane stays key-free, but each tenant's
   sandbox is GIVEN that user's `ANTHROPIC_API_KEY`. Concurrency is now bounded by host
   resources, not one subscription.

---

## Architecture: control plane + data plane

### Control plane (the host — one process, one bot)
- **Telegram router:** one `getUpdates` poller; demux inbound by `from.id` → tenant.
- **Tenant registry:** `Map<userId → { sandbox, apiKeyRef, workspace, state }>`.
- **Onboarding / auth:** external user starts the bot → registers + supplies their API key →
  stored **encrypted at rest**, injected only into their sandbox.
- **Scheduler / lifecycle:** lazy-spawn a sandbox on a user's first message; idle-timeout
  teardown (reclaim resources — the M12 lifecycle-restart + handoff lets the agent resume that
  user's context on the next message); max-concurrent cap + queue; per-tenant resource caps.
- **Secrets:** holds the one globally-sensitive secret — the **bot token** — which NEVER
  enters any sandbox.

### Data plane (per user — a sandbox)
- Runs the claude agent (the cli-stream driver, but spawning `claude` **inside** the sandbox),
  with: the user's key as `ANTHROPIC_API_KEY` (sandbox-scoped), an isolated workspace volume,
  cpu/mem caps, egress-restricted network, non-root.
- The control plane bridges Telegram ↔ sandbox I/O.

### Mapping onto M12 seams (an EVOLUTION, not a rewrite)
- `SessionDriver` → a **container/sandbox driver** (spawn claude in tenant X's sandbox + stream).
- Telegram adapter → the **multi-tenant router** (one bot, demux by userId).
- Per-tenant **permission routing** → already exists (each user approves their own agent's
  destructive ops in their own chat).
- **Cost-guard** → inverts (host key-free; tenant sandbox gets the user's key).
- **Lifecycle / handoff / liveness** → per-tenant.

---

## The hard parts (clear-eyed)

1. **Untrusted code execution = the dominant problem.** Vanilla Docker is NOT enough for truly
   untrusted code (shared kernel, real escape risk). Real answers: **gVisor** (sandboxed
   runtime) or **Firecracker microVMs** (what Fly/Modal/E2B use). For the "dozens, test" phase
   with semi-trusted beta users, hardened Docker (non-root, seccomp, no docker socket,
   read-only host mounts, network policy) is a reasonable START — but plan the microVM move
   before going truly public.
2. **Key onboarding UX.** API keys pasted into a Telegram chat are exposed (Telegram servers +
   history). Better: a tiny **web onboarding** (HTTPS page linked to the Telegram id) OR accept
   via DM → delete the message immediately → encrypt at rest. Never leave keys in chat history.
3. **Abuse / safety.** External users + an autonomous code agent = abuse vectors (mining,
   attacks-as-proxy, content gen). Need egress limits, quotas, usage monitoring, a ToS, and a
   ban switch.

---

## Build-vs-buy (the biggest effort fork)

The untrusted-sandbox piece is most of the work:
- **Self-host:** Docker → gVisor → Firecracker, operated by you. Full control, most effort +
  security responsibility.
- **Sandbox-as-a-service:** **E2B** (agent sandboxes), **Modal**, or **Fly Machines** provide
  per-tenant microVMs via API; the control plane just orchestrates their sandboxes — they solve
  the hardest/most-dangerous part.
- **Recommendation:** for dozens-scaling-up, **buy the sandbox initially** (E2B/Modal/Fly), keep
  the control plane + Telegram bridge thin; revisit self-hosting only if economics demand it.

## Scaling path
- **Dozens on one host:** containers/sandboxes; lazy-spawn + idle-teardown keep the ACTIVE set
  small (dozens registered ≠ dozens running). One beefy box.
- **Scaling up:** control plane stays central (one bot); data plane → k8s / Nomad / a cloud
  container service (agents = pods across nodes), OR a microVM provider.

---

## Phase plan
- **Phase 1 (test cohort) — vertical slice:** router + tenant registry + per-user-key
  registration + sandbox driver (hardened Docker OR a provider) + lazy-spawn/idle-teardown +
  per-tenant caps = a working multi-tenant beta.
- **Phase 2 — harden:** gVisor/microVM isolation + abuse tooling (egress/quotas/monitoring/ban)
  before opening wider.
- **Phase 3 — scale:** orchestration (k8s / provider) for horizontal scale.

## Open decisions (resolve before Phase 1)
1. **Self-host the sandbox vs use a provider** (E2B / Modal / Fly Machines)? — the biggest fork.
2. **Workspace model** — blank workspace, clone-their-own-repo, or templates?
3. (Later) abuse policy + ToS + per-user quota model.

---

## Status
**PARKED 2026-06-20** — design captured, not scheduled. Resume by resolving the two open
decisions, then scoping Phase 1. Prerequisite robustness items from the live single-tenant
supervisor still apply and should land first (agent-death detection + auto-recovery; agent
process-group isolation; the in-channel supervisor command set) — see
`project_m12_supervisor_driver` memory / the supervisor command-set task.
