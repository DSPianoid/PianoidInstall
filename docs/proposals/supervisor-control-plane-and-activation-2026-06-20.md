# Supervisor Control Plane + Dispatch Activation + Spend Cap — Design Proposal

**Date:** 2026-06-20 · **Author:** `/analyse` (architecture design, max-rigor) + `/dev` (Phase-1 + A2 implementation `feature/supervisor-control-plane`) · **Status:** ACTIVE — Phase 1 SHIPPED (the `/control` menu + `ctl:*` router + `status`/`ping`/`help` + the change-model scaffold: P-A1 ✅, dev-ctl1) + **P-A2 SHIPPED** (channel↔panel parity: `reconnect` / `flush` [confirm sub-menu] / `log` / `approvals` [allow/deny via the perm path]: ✅, dev-ctl2). Remaining phases (P-A3…P-A6, P-B1, P-C1) PENDING (`clear` moved into P-A3). **Interface DECISION (§2.5): a single `/control` command + a native inline-keyboard MENU** (user-directed; supersedes the original `!`-prefix design). Proposal lifecycle: Draft → Review/Approval → Active → Archive + Implementation Report.
**Scope:** ONE combined supervisor unit for the Pianoid M12 supervisor (`tools/supervisor/`, TS/Node) with three parts: **(A)** an OUT-OF-BAND **operator control-command plane** the supervisor intercepts BEFORE orchestrator delivery (so it works precisely when the orchestrator child is dead/stuck — the user's primary ask); **(B)** making the dormant `SessionHost.dispatchRole()` an **invokable dispatch surface** for the cli-stream `claude -p` orchestrator; **(C)** an **enforced spend cap** (per-dispatch + cumulative) over the model-agnostic dispatch path.

**Relationship to prior docs (one-doc-per-topic — extend, do not duplicate):**
- **EXTENDS** [`docs/proposals/model-agnostic-agents-2026-06-19.md`](model-agnostic-agents-2026-06-19.md) for Parts B + C. That Campaign landed the agent **EXECUTION + ROUTING** layer (P0–P6) dormant behind `SUPERVISOR_ROLE_ROUTING`; §Q.6.1 explicitly defers "expose `dispatchRole` as a callable tool/control" and M-1 explicitly defers spend ENFORCEMENT to "a separate later batch." THIS doc is that batch for B + C. The model-agnostic doc is the foundation; it is **referenced, not re-specified** (its CP/AP/FD/M/OD IDs are cited, not copied).
- **BUILDS ON the proven interception seam** in `tools/supervisor/src/session-host.ts` `handleInbound` (`/channel-check`, `/mode`, `/setkey`, `/setrole`, `/roles` are already intercepted-ACKed-not-forwarded) and the loopback **control panel** (`panel.ts` + `supervisor.ts` channel methods). Part A **extends this exact pattern**; it invents no new transport.
- **Sits beside** the M12 host/lifecycle docs (`m12-host-supervisor-app-2026-06-14.md`, the io-boundary + hosted-agent-lifecycle-restart archive docs). Those govern the single hosted orchestrator + its restart/liveness machinery; Part A **reuses** that machinery (the D4 liveness ping, `lastStall`, `requestRestart`, `clearContext`, `restartFresh`, `/api/lifecycle/restart-request`) as the substrate for `status`/`restart`/`resume`/`interrupt`.

> **How to read.** PART 0 (foundations) governs the body. §1 is the load-bearing **out-of-band guarantee** (where interception happens so each command survives a dead child). §2 is the **command inventory table** (the deliverable). §3 = Part B (dispatch surface). §4 = Part C (spend cap). §5 = stuck-detection thresholds. §6 = **phasing into discrete `/dev` units**. §7 = the SACRED-INVARIANT discipline. §D = **decisions needing USER sign-off**, each with a recommended default. Every code claim carries a `file:line`; anything not in the tree today is marked **NEW**. Durable spec is lean; this doc is decision-focused, not a design dump.

---

# PART 0 — FOUNDATIONS

## 0.1 Purpose

Give the operator a **single `/control` command the SUPERVISOR intercepts out-of-band**, rendering a **native inline-keyboard MENU of control actions** (§2.5) — so that `status` / `restart` / `resume` / `interrupt` / `agents` / `log` / `clear` / `pause` / `approvals` / `change-model` and a **proactive stuck/dead alert** all work **precisely when the orchestrator child is dead or wedged** (the failure that left the user "unable to restore from inside the channel"). Each action travels as a `ctl:*` callback routed in the supervisor process. Plus: turn the already-shipped-dormant `dispatchRole()` into a **callable surface** for the cli-stream orchestrator, and put a **real enforced ceiling** on routed-agent spend. All additive, dormant/gated, byte-for-byte-OFF, with the live host NOT rebuilt/restarted by the implementing agent.

## 0.2 Core principles (`CP`)

| ID | Principle (one line) |
|---|---|
| **CP1 — Out-of-band survivability** | A control command MUST be handled in the SUPERVISOR process, on the inbound path, BEFORE any hand-off to the orchestrator child — so it works when the child is dead/stuck. The control plane's liveness is the supervisor's liveness, never the orchestrator's. |
| **CP2 — Reuse the proven seam** | Control commands extend the existing `handleInbound` interception (`/mode` et al.) + the loopback panel endpoints. New code wires existing capabilities to reserved commands; it does not invent transports or duplicate lifecycle machinery. |
| **CP3 — Honest capability mapping** | Each command maps to a REAL mechanism that exists (or a precisely-scoped NEW one). Commands the supervisor cannot truthfully serve today (introspecting the orchestrator's OWN sub-agents) are flagged HARD and deferred, not faked. |
| **CP4 — Host safety / non-regression (carried from the Campaign CP5)** | Additive behind default-OFF switches; the running cli-stream orchestrator is untouched; nothing activates until a user-triggered rebuild/restart. Switch-OFF = byte-for-byte today. |
| **CP5 — Cost bounded AND enforced (carried from the Campaign CP4, strengthened)** | The Campaign METERS routed spend; this doc ENFORCES a ceiling (per-dispatch + rolling cumulative) at the dispatch choke-point. The enforcement is fail-closed (refuse the dispatch) and fully OFF by default (ceiling 0 = unlimited = today). |
| **CP6 — Discoverability under stress** | The control set is self-describing (`help`) and reached by ONE memorable command (`/control`) that renders a native inline-keyboard MENU of the actions, because the user reaches for it in a panic when the orchestrator is down — a menu needs no command names recalled. |
| **CP7 — Least authority, audited** | Control commands run with the supervisor's authority (it already owns the channel + the lifecycle). Destructive ones (`restart`/`kill`/`clear`) are logged + bus-published (`publishLifecycle`) and, where they reset context, confirmed — reusing the existing confirm path. |

## 0.3 Decision hierarchy (conflict resolution)

**CP4 (host safety) > CP1 (out-of-band survivability) > CP5 (spend enforcement) > CP3 (honest mapping) > CP2 (reuse) > CP6 (discoverability) > CP7 (least authority).**

Read: never regress the live host to add a control (CP4 first — every part ships dormant). The whole point of Part A is survivability, so it outranks the niceties (CP1 > CP6). A spend ceiling that could wedge a dispatch must itself be fail-safe and OFF by default, so host-safety still dominates it (CP4 > CP5). Honest mapping beats reuse-pressure: if reusing a seam would force faking a capability, defer the command (CP3 > CP2).

## 0.4 Architectural principles (`AP`)

| ID | Architectural principle | traces-to |
|---|---|---|
| **AP1 — Interception lives in `SessionHost.handleInbound`, ahead of the orchestrator hand-off** | Reserved control commands are matched + handled in `handleInbound` (`session-host.ts:608-656`) at the SAME point as `/mode`/`/setkey`, RETURNING before `lifecycle.sendUserTurn`. The SessionHost object lives in the supervisor process and keeps running when the orchestrator child is dead → the handler executes regardless of child state. | CP1, CP2 |
| **AP2 — Child-independent vs child-dependent commands are split by construction** | A command is CHILD-INDEPENDENT if it touches only supervisor-owned state (lifecycle health, channel, panel, stores, restart machinery) — these are the survivability core. A command is CHILD-DEPENDENT only if it must inject a turn (e.g. a graceful drain). The dead-child case is served entirely by the child-independent set + the kill/hard-restart path (which does NOT need the child alive). | CP1, CP3 |
| **AP3 — The loopback panel is the second control surface (parity with the channel)** | Every control command is ALSO reachable as a panel endpoint (the panel already exposes `/api/session`, `/api/clear`, `/api/lifecycle/restart-request`, `/api/channel/*`). New commands add a thin panel route alongside the channel interception — one handler, two front-doors. The panel works even if the channel adapter is wedged (it is a separate loopback HTTP server). | CP1, CP2 |
| **AP4 — Dispatch surface = a reserved channel command + a panel route, both calling the existing `SessionHost.dispatchRole`** | The cli-stream orchestrator cannot receive an in-process MCP tool (the binding constraint, model-agnostic §Q.6.1). The minimal callable surface is therefore the SAME interception seam: a reserved `dispatch`-style command (and a `/api/dispatch` panel route) the supervisor handles by calling the already-shipped `dispatchRole(role, task)` and relaying the structured result back as an orchestrator turn. | CP2, CP3 |
| **AP5 — Spend enforcement at the dispatch choke-point, fail-closed + default-OFF** | The ceiling check inserts at the EXISTING admission/settlement hooks (`AgentConcurrencyGate.tryAcquire` pre, `AgentLease.release` post — `agent-concurrency.ts:135-145,173-190`) + a rolling ledger; the cap is read from config, defaults to 0 (=unlimited=today), and a breach REFUSES the dispatch with a clean surfaced result (never a crash). | CP5, CP4 |
| **AP6 — Additive, dormant, switch-gated; switch-OFF is byte-for-byte** | Every new field is an optional ctor option / conditional-spread (the proven P6 pattern, `index.ts:347-350`); every new command is gated on a wired capability or a config flag; with the gates off the SessionHost ctor receives none of the new keys and behaves exactly as today. | CP4 |

## 0.5 Architecture + flows

**Layers / actors (where things live):**

```
 user ── channel (telegram) ──┐
 operator ── panel HTTP :8790 ─┤
                               ▼
            SUPERVISOR  (always-alive Node process — owns the channel + the panel + the lifecycle)
                               │
        ┌──────────────────────┴───────────────────────────────────────────────┐
        │  SessionHost.handleInbound  ── reserved-command INTERCEPT (AP1)        │
        │     • CHILD-INDEPENDENT cmds → answered from supervisor state ─────────┼──► reply (works even if child dead)
        │         (status / restart-kill / agents / log / pause / approvals /    │
        │          reconnect / flush / ping / help / clear / interrupt)          │
        │     • CHILD-DEPENDENT cmds → inject a turn (graceful drain only) ──────┼──► orchestrator child
        │     • dispatch <role> <task> → SessionHost.dispatchRole (AP4) ─────────┼──► routed backend agent
        │  (un-matched inbound) → lifecycle.sendUserTurn ───────────────────────┼──► ORCHESTRATOR (claude -p child)
        └──────────────────────┬───────────────────────────────────────────────┘
                               │
   LifecycleManager (owns the child; restart/resume; D4 liveness ping; isIdle; lastStall)
   PermissionRouter (pendingPermissions; operatorDecide)   AgentConcurrencyGate + spend ledger (Part C)
   ProactiveWatch (NEW): liveness → push "stuck/dead — restarting" alert to the channel (Part A push)
```

**Flow set:**

| ID | Flow | Sequence (summary) |
|---|---|---|
| **CF1 — Out-of-band control** | inbound (channel OR panel) → `handleInbound` matches a reserved control command → handled from supervisor-owned state → reply, WITHOUT injecting an orchestrator turn (survives a dead child). |
| **CF2 — Graceful vs hard restart** | `restart` → drain (await `isIdle`) → snapshot/handoff note → `restartFresh()` + re-inject handoff (reuses `requestRestart`/`runRestartConfirm` path); `kill` → `restartFresh()` immediately (no drain, child may be wedged). |
| **CF3 — Resume / handoff** | `handoff <note>` (or auto-snapshot on restart) → persist the note → on the fresh session's first turn, inject `roleTurnPrefix + handoff` (the EXISTING `runRestartConfirm` handoff-injection, `session-host.ts:1311-1319`). |
| **CF4 — Interrupt (ESC)** | `interrupt` → `lifecycle.interruptTurn()` (NEW thin wrapper) → `driver.interrupt()` (`session-driver.ts:189`) — stops the in-flight turn WITHOUT killing the process. |
| **CF5 — Proactive push** | the D4 liveness ping fires (`pingLiveness`) → on timeout `onUnresponsive` already runs → ADD a channel push ("orchestrator unresponsive Nm — restarting with handoff") BEFORE the restart, so the user isn't polling. |
| **CF6 — Dispatch surface** | `dispatch <role> <task>` (or `/api/dispatch`) → `SessionHost.dispatchRole(role, task)` → injected closure → `dispatchRoleAgentWithFallback` → structured result relayed back to the orchestrator as a turn (AP6 of the Campaign — agent is channel-mute). |
| **CF7 — Spend enforcement** | dispatch admission → `tryAcquire(estTokens, estCostUsd)` checks the rolling ledger + the per-dispatch cap → refuse (clean result) on breach; on settle → `release(tokensUsed, costUsd)` charges the ledger; `resetWindow()` rolls it. |

---

# §1 — THE OUT-OF-BAND GUARANTEE (load-bearing; show exactly where each command survives a dead/stuck child)

This is the user's primary requirement, so it is specified first and precisely.

## 1.1 Why `handleInbound` interception is out-of-band

The supervisor is ONE always-alive Node process. The orchestrator is a **child** `claude -p` process owned by `LifecycleManager` (model-agnostic doc A.1; `launch-prod-orch.mjs:99-104`). `SessionHost.handleInbound` (`session-host.ts:547`) is a method on a supervisor-process object — it runs on every inbound the channel adapter delivers, and it **keeps running when the child is dead or wedged** (a dead child only means `lifecycle.sendUserTurn` would throw — which the control commands never call).

The interception point is already proven: `/channel-check`, `/mode`, `/setkey`, `/setrole`, `/roles` are matched + handled + RETURN at `session-host.ts:608-656`, BEFORE the `lifecycle.sendUserTurn` at line 671. **Part A adds reserved commands at this exact point.** Because they answer from supervisor-owned state (`lifecycle.health()`, `pendingPermissions()`, the channel/panel, the restart machinery), they do not depend on the child being alive.

**One nuance to fix in the implementation (flagged honestly):** today the interception sits AFTER operator-binding (`session-host.ts:555-575`) and after the permission-reply parse. For a control command to work when **no operator is bound yet** (a cold dead-child case), the reserved-control match should run as early as possible after the operator-binding block (binding is cheap and child-independent). The permission-reply interception can stay ahead (it is also child-independent). **No change is needed to the dead-child guarantee** for the common case (an operator is already bound from earlier in the session); this is a robustness refinement for the cold case, captured as a P-A1 sub-task.

## 1.2 The two-front-door design (channel + panel)

Each control command is implemented ONCE on the `SessionHost` (or `Supervisor`) and exposed via TWO front doors (AP3):
- **Channel:** the `/control` command intercepted in `handleInbound`, rendering the inline-keyboard menu; its actions return as `ctl:*` callbacks routed in the same supervisor process.
- **Panel:** a loopback HTTP route in `panel.ts` (the panel is a SEPARATE HTTP server, `panel.ts:62-73`, bound to 127.0.0.1:8790) — so it works even if the **telegram adapter** is wedged (a distinct failure from a dead orchestrator child). Many routes already exist (`/api/session`, `/api/clear`, `/api/lifecycle/restart-request`, `/api/channel/{state,reconnect,flush}`); Part A adds the few missing ones.

This means the survivability story is layered: a control command survives a dead **orchestrator child** (via `handleInbound` interception) AND a wedged **channel adapter** (via the panel). The only thing that takes down both is the supervisor process itself dying — which is the launcher/OS concern (`8790` single-instance guard, `launch-prod-orch.mjs:46-57`), out of scope here.

---

# §2 — ACTION INVENTORY (the deliverable: action → mechanism → reuse/new → effort → v1/deferred)

**Interface note:** every row below is a MENU ACTION reached by tapping a button in the `/control` menu (§2.5) — its `callback_data` is `ctl:<action>`. The handler designs are interface-agnostic (they were written for the `!`-typed-command surface and carry over unchanged); only the surface is now a button + a `ctl:*` callback instead of a typed `!`-command. "v1" = ships in the menu now; deferred = a later phase adds the registry row + handler.

Effort: **trivial** = wire an existing endpoint/method to a menu action; **moderate** = a small new method over existing machinery; **hard** = needs a capability the supervisor does not have today (flagged).

| Action (menu button → `ctl:*`) | Mechanism (where it runs) | Reuse vs NEW | Effort | v1? |
|---|---|---|---|---|
| **`help`** | static text listing the action set; rendered into the menu reply / a result edit | NEW (text only) | trivial | **v1** |
| **`change-model`** (sub-menu) | a SUB-MENU of the Tier-1 orchestrator-model choices (`claude-opus-4-8[1m]` / `claude-sonnet-4-6` / `claude-haiku-4-5`); a pick sets the next-restart `SUPERVISOR_ORCHESTRATOR_MODEL` (`config.orchestratorModel`) and triggers the graceful-restart path. **Phase-1 = the menu entry + the model sub-menu SCAFFOLD only** (a pick reports "wired in a later phase"); the restart-on-model wiring lands with P-A3 (restart). | REUSE (config field + the restart path) | moderate | **v1 (scaffold; restart wiring → A3)** |
| **`status`** | `lifecycle.health()` (running/sessionId/restarts) + `isIdle()` + `pendingPermissions().length` + panel `sessionView()` (totalCostUsd, lastStall, controllerSignals) + `channelState()` + uptime (NEW: record `startedAt`) + **model** (NEW: surface `config.orchestratorModel ?? profile.model`) | REUSE (+2 small fields) | moderate | **v1** |
| **`restart` (graceful)** | drain: await `isIdle()` (poll, bounded) → snapshot handoff → `requestRestart(reason, handoffNote)` (`session-host.ts:1243`) → existing confirm + `restartFresh` + handoff-inject | REUSE | moderate | **v1** |
| **`kill` / hard restart** | `restartFresh()` immediately via a new `forceRestart()` that skips the drain + (optionally) skips confirm for a wedged child; bus-published | REUSE (+ a no-drain entry) | moderate | **v1** |
| **`resume` / `handoff [note]`** | snapshot current state into a handoff note + re-inject on restart — the EXISTING `runRestartConfirm` handoff-injection (`session-host.ts:1311-1319`); add a `handoff` command that sets the note used by the next restart | REUSE | moderate | **v1** |
| **`interrupt` / `cancel`** | NEW `lifecycle.interruptTurn()` → `driver.interrupt()` (`session-driver.ts:189`; today only called by the latent watchdog, `lifecycle.ts:413`). Stops the in-flight turn, keeps the process | REUSE plumbing, NEW public method | moderate | **v1** |
| **`tail [N]` / `log`** | panel already has `/api/capture` (`panel.ts:88`); add a control command that returns the last N capture records (filtered to substantive lines) | REUSE | trivial | **v1** |
| **`approvals`** | `pendingPermissions()` (`session-host.ts:1116`) → list `{code, toolName}` | REUSE | trivial | **v1** |
| **`allow <code>` / `deny <code>`** | `operatorDecide(verdict, code)` (`session-host.ts:1125`) — already the panel's mechanism | REUSE | trivial | **v1** |
| **`reconnect`** | `supervisor.reconnectChannel('telegram')` (`supervisor.ts:292`) — exposed today only via `/api/channel/reconnect` | REUSE | trivial | **v1** |
| **`flush`** | `supervisor.flushChannel('telegram')` (`supervisor.ts:311`) | REUSE | trivial | **v1** |
| **`ping`** | `pingLiveness()` (`session-host.ts:1159`) → reply alive/idle/in-flight | REUSE | trivial | **v1** |
| **`clear` / `new`** | `clearContext()` (`session-host.ts:1096`) — already `/api/clear`; preserves the channel | REUSE | trivial | **v1 (→ P-A3: a fresh-context child-restart variant, grouped with restart/kill/resume rather than panel-parity)** |
| **PROACTIVE push (stuck/dead alert)** | extend the existing D4 unresponsive path (`onUnresponsive`, `session-host.ts:330,1173`) to PUSH a channel message ("unresponsive Nm — restarting with handoff") before acting | REUSE (+ one push) | moderate | **v1** |
| **`pause` / `resume-intake`** | NEW one-bit `intakePaused` flag on `SessionHost`; when set, un-matched inbound is acknowledged + NOT injected (control commands still work). Does not kill anything | NEW (small) | moderate | **defer→v1.1** |
| **`agents` / `ps`** | list the orchestrator's OWN spawned sub-agents + states. **The supervisor does NOT see these** — sub-agents run in-process inside the one cli-stream child (model-agnostic A.1); the only signal is tool-activity forwarding (`forwardToolActivity`, `session-host.ts:485`). Options: (i) parse `Agent`/`Task`/`SendMessage` tool-activity into a best-effort live roster; (ii) have the orchestrator self-report via a panel POST. **HARD** | NEW (hard — partial at best) | hard | **defer** |
| **`kill <agent>`** | kill ONE orchestrator sub-agent without restarting the orchestrator. The supervisor has **no handle** to an in-process sub-agent (no OS process, no API). Only the orchestrator itself can stop its teammate. **HARD** | NEW (hard — not reachable today) | hard | **defer** |
| **`dispatch <role> <task>`** | Part B — `SessionHost.dispatchRole` (`session-host.ts:1003`, shipped dormant) via a reserved command + `/api/dispatch` | REUSE (expose) | moderate | **v1 (Part B)** |
| **spend cap (enforced)** | Part C — ceiling at `tryAcquire`/`release` + a rolling ledger | NEW (small) | moderate | **v1 (Part C)** |

**Verdict:** **15 v1 actions** (all REUSE-or-thin-NEW over existing machinery) + the `change-model` action (scaffold; restart wiring → A3) + the proactive push + the Part-B dispatch surface + the Part-C spend cap, ALL reached as buttons in the `/control` menu (§2.5). **`pause` deferred to v1.1** (trivial but needs a small intake-gate decision). **2 genuinely HARD, deferred:** `agents`/`ps` and `kill <agent>` — because the supervisor cannot introspect or address the orchestrator's OWN in-process sub-agents (they share the single child's process + stdout; A.1). `interrupt` is the one MODERATE-but-subtle v1 item: the plumbing exists (`driver.interrupt()`) but no public method calls it outside the disabled watchdog.

> **Phase 1 (shipped, `feature/supervisor-control-plane`):** the `/control` interception + the inline-keyboard MENU renderer + the extensible `ctl:*` callback ROUTER (the `CONTROL_ACTIONS` registry later phases plug into) + the three read-only actions **`status`** (active/stuck/dead + orchestrator model + uptime + context % [n/a today] + pending approvals + restarts), **`ping`** (liveness round-trip), **`help`** (lists the actions) + the **`change-model`** menu entry & model sub-menu **scaffold** (restart-on-model wiring deferred to A3). All additive + gated to `/control` + `ctl:*` (non-control inbound byte-for-byte).
>
> **Phase A2 (shipped, dev-ctl2):** the channel↔panel-parity actions **`reconnect`** (re-establish the channel transport, ACK new sender/poller state), **`flush`** (DESTRUCTIVE → a confirm sub-menu `ctl:flush`→`ctl:flush-confirm`/`ctl:menu`; only the confirm drops un-acked inbound), **`log`** (recent inbound/outbound/delivery events from the capture buffer), **`approvals`** (lists pending permission asks with per-ask **Allow/Deny** buttons `ctl:appr-allow:<code>`/`ctl:appr-deny:<code>` that resolve via the SAME `operatorDecide` permission path the `perm:*` buttons use). Each is a `CONTROL_ACTIONS` row + a `ctl:*` handler; the supervisor-side surfaces are 3 optional injected opts (`reconnectChannel`/`flushChannel`/`captureRecent`, dormant/no-op when unwired → index.ts wires them at activation). Additive + gated to the new `ctl:*` actions (non-control inbound byte-for-byte). **`clear` moved to A3** (a fresh-context child-restart variant, grouped with restart/kill/resume). The remaining actions (`restart`/`kill`/`resume`/`interrupt`/`clear` + Part-B `dispatch` + Part-C `spend-cap`) are the next phases — each a `CONTROL_ACTIONS` row + a handler.

---

# §2.5 — INTERFACE DECISION: a single `/control` command + a native inline-keyboard MENU (SUPERSEDES the `!`-prefix design)

**CHOSEN (USER-DIRECTED, overrides the earlier `!`-prefix recommendation below):** ONE user-facing command — **`/control`** — that the supervisor intercepts (same seam, NOT forwarded to the orchestrator) and answers with a **Telegram native inline-keyboard MENU**. Each menu button is a control action; a tap returns a `ctl:<action>` `callback_data` the supervisor routes supervisor-side → runs the action → ACKs (`answerCallbackQuery`) + edits the message with the result. The command and every callback are handled OUT-OF-BAND (in the supervisor process), so the whole plane works when the orchestrator child is dead/stuck — the same CP1 guarantee, now reached by ONE memorable command instead of N typed ones.

**Why a menu beats a typed-command set (the reasons the `!`-prefix tried to solve, solved better):**
- **Discoverability under stress (CP6)** — the operator types ONE thing (`/control`) and SEES every available action as a button; no need to remember `!status` vs `!approvals` vs `!reconnect` in a panic. The menu is self-describing by construction; `help` is one button among the rest.
- **No namespace collision** — `/control` is a single reserved token (verified unused in the supervisor inbound path; it sits beside the existing `/mode`/`/setkey`/`/setrole`/`/roles`/`/channel-check` intercepts). The ACTIONS never appear as `/`-prefixed tokens the orchestrator's skill parser could see — they travel as `callback_data`, not text.
- **Reuses the proven callback infra (CP2)** — the permission-button path already built (`InlineButton`, `callback_query` inbound, `answerCallback`, `editMessage`, the `perm:<verdict>:<code>` scheme) is REUSED verbatim: the menu render is an outbound with `options.buttons`; the `ctl:*` scheme is parsed alongside `perm:*` (the control router is checked FIRST, a `perm:*` callback falls through untouched).
- **Extensible by an action registry** — a single in-code list (`CONTROL_ACTIONS`) drives BOTH the menu render and the callback router; a later phase ADDS a row + a handler branch and the button appears with no other menu change. This is the §6 phasing seam (each `restart`/`resume`/`interrupt`/`reconnect`/`flush`/`log`/`clear`/`approvals`/`change-model`/`dispatch`/`spend-cap` lands as a registry entry + a handler).

**The `ctl:*` callback scheme:** `ctl:<action>` (or `ctl:<action>:<arg>`, e.g. `ctl:model-set:claude-sonnet-4-6`), `<action>=[a-z0-9-]+`, kept well under Telegram's 64-byte `callback_data` cap. The supervisor matches the `ctl:` prefix BEFORE the permission path so the two routers never collide; a non-`ctl:` callback (a `perm:*` decision) is handled by the existing permission callback path unchanged.

**Coexistence with the existing `/`-commands:** `/mode`/`/setkey`/`/setrole`/`/roles`/`/channel-check` STAY as they are (already shipped + documented). `/control`'s `help` action points to them.

---

**(SUPERSEDED — original `!`-prefix recommendation, kept for the record):** the first draft proposed a `!` (bang) reserved prefix with N typed commands (`!status`, `!restart`, … `!help`). Rationale was that `!` is unused, one keystroke, and visually distinct from `/`-skills. This was **superseded by the `/control`-menu interface above** (user-directed): a single command + an inline-keyboard menu is more discoverable under stress (no command names to recall), collides with no namespace, and reuses the permission-button callback infrastructure directly. The per-action handler designs in §2 are interface-agnostic and carry over unchanged — only the *surface* (a menu button + a `ctl:*` callback) replaces the *surface* (an `!`-typed command).

---

# §3 — PART B: THE DISPATCH SURFACE (make `dispatchRole` invokable for cli-stream)

The machinery is built + dormant (model-agnostic P6): `SessionHost.dispatchRole(role, task)` (`session-host.ts:1003-1034`) calls an injected `dispatchRoleAgent` closure (`index.ts:294-327`) → `dispatchRoleAgentWithFallback` (`result-relay.ts:330-398`) → sealed backend → result. §Q.6.1 explicitly left "expose it as a callable tool/control" to the next batch. This is that surface.

**Constraint (re-stated, model-agnostic §Q.6.1):** the cli-stream `claude -p` orchestrator cannot receive an in-process MCP tool (only the SDK driver can; `index.ts` wires the channel reply tool ONLY for the SDK path). So the invokable surface must be the SAME proven seam Part A uses.

**Design (AP4):**
- **Channel:** a `dispatch` MENU ACTION (`ctl:dispatch`, with the `<role> <task>` supplied via a follow-up prompt or a sub-menu — the precise UX is a later-phase detail), gated on `dispatchRoleAgent` being wired (= `SUPERVISOR_ROLE_ROUTING` ON). The supervisor calls `await this.dispatchRole(role, task)` and relays the structured `RoleDispatchResult` (`{ok, role, backend, text, costUsd, fellBack}`) back **as an orchestrator turn** (so the orchestrator sees the agent's report and continues — matching the Campaign AP6: the routed agent is channel-mute; only the report returns). Concretely: on completion, inject a `[SUPERVISOR dispatch-result] role=… backend=… ok=… cost=$…\n<text>` turn via `lifecycle.sendUserTurn` (the same shape `runRestartConfirm` uses to feed the orchestrator).
- **Panel route:** `POST /api/dispatch {role, task}` → `sessionHost.dispatchRole` → JSON result. This gives a child-independent invocation path for tests + the operator panel.
- **Dormant contract preserved:** when `dispatchRoleAgent` is not wired (the default), `dispatchRole` already returns `{ok:false, enabled:false}` (`session-host.ts:1007`); the `dispatch` action is gated on the same wired capability, so with routing OFF it is not offered / falls through byte-for-byte (exactly the `/setrole` dormant pattern).

**Why a turn-relay rather than a synchronous reply:** the orchestrator is the decision-maker (it asked for the role's work); the result must land in ITS context so it can act on the code/review. Replying only to the channel would strand the result away from the agent that needs it. The turn-relay reuses the existing "supervisor injects an out-of-band turn" mechanism (`runRestartConfirm`, the delivery-failure feedback) — no new plumbing.

**Note on the future SDK path:** if/when the orchestrator runs on the SDK driver, `dispatchRole` ALSO becomes an in-process MCP tool (like the channel reply tool) — but that is additive and out of scope; the cli-stream surface above is the binding requirement today.

---

# §4 — PART C: ENFORCED SPEND CAP (per-dispatch + cumulative)

Today spend is **metered, never enforced** (confirmed: `cost-safety.ts` only guards CREDENTIAL scoping — no spend ceiling; `agent-concurrency.ts` has an ADVISORY token budget that defaults to 0=untracked and only ever ACCOUNTS on `release`, never refuses post-hoc; model-agnostic M-1 + OD-3 defer enforcement). This part adds a real ceiling.

**Where it hooks (AP5) — the two existing seams, no new choke-point:**
1. **Pre-dispatch admission — `AgentConcurrencyGate.tryAcquire(estTokens, estCostUsd?)` (`agent-concurrency.ts:135-145`).** Add a per-dispatch + rolling-cumulative CHECK alongside the existing concurrency + token-budget checks. On breach → return `{ok:false, reason:'spend-cap-exceeded'}`; `dispatchRoleAgentWithFallback`/the closure surfaces this as a clean `{ok:false, text:'refused: spend cap …'}` result (never a crash, never a wedge — CP4/CP5).
2. **Post-dispatch settlement — `AgentLease.release(tokensUsed, costUsd?)` (`agent-concurrency.ts:173-190`).** Charge the ACTUAL `costUsd` from the `AgentReport` (`result-relay.ts` already computes/forwards `costUsd` + `tokens`) into a **rolling spend ledger** (a new field beside `gate.spent`). `result-relay.ts:251` already calls `release(reportTokensUsed(report))` — extend it to pass `costUsd` too.

**The ledger (NEW, small):** a per-window cumulative `spentUsd` (cents-precision) with a `resetWindow()` hook (the gate already has `resetWindow()` for the 5-hour boundary, `agent-concurrency.ts:213`). Two ceilings, both from config, both default 0 (= unlimited = today):
- **per-dispatch cap** `SUPERVISOR_DISPATCH_COST_CAP_USD` — refuse a single dispatch whose ESTIMATE exceeds it (estimate from the role's model + a configurable token estimate; conservative default if unknown).
- **rolling cumulative cap** `SUPERVISOR_DISPATCH_COST_WINDOW_USD` over a `SUPERVISOR_DISPATCH_COST_WINDOW_MS` window (default = the 5-hour budget boundary) — refuse admission once `spentUsd + estCostUsd` would exceed it.

**Default policy (recommended): both caps 0 (unlimited) — i.e. METER-ONLY, exactly today** — until the user sets real numbers (OD-3 of the Campaign). This keeps Part C byte-for-byte-OFF by default (CP4). When the user sets a cap, enforcement is **fail-closed** (refuse) with a surfaced reason + a proactive channel notice ("dispatch refused — rolling spend cap $X reached; resets in Nm"). Estimation imperfection is acceptable because the cap is a SAFETY ceiling, not a billing meter; the post-hoc `release` charge keeps the ledger truthful for the next admission.

**Attribution:** the ledger can key by backend/provider (the `AgentReport.backend` + the resolved provider) so per-backend caps are a later refinement; v1 is a single global rolling ledger (simplest, matches "don't let routed agents run away").

**Rollback:** unset the cap env vars (or set 0) → meter-only → today. No data migration (the ledger is in-memory, resets on restart).

---

# §5 — STUCK-DETECTION: active / stuck / dead (precise definitions + thresholds)

Reuse the EXISTING D4 idle-aware liveness ping + `lastStall`:
- the periodic scheduler fires `pingLiveness()` only when **idle** (`isIdle()`, `session-host.ts:1163`) — a busy/in-flight turn is provably working and never pinged (no false restart);
- a missed ping deadline already fires `onUnresponsive` → tier-b restart (`session-host.ts:1170-1174`).

**Definitions (for `!status` + the proactive push):**
- **ACTIVE** — the child is running (`lifecycle.health().running === true`) AND either a turn is in flight (`!isIdle()`) OR it answered the last liveness ping within the deadline. Last-progress time = the last `onProgress`/`onResult`/pong timestamp (NEW: record it).
- **STUCK** — running, but IDLE and failed to answer a liveness ping within `pingResponseTimeoutMs` (recommended **45 s**), OR a turn has been in flight longer than a turn-watchdog deadline (recommended **180 s** — the latent `turnTimeoutMs`, currently 0/disabled, `lifecycle.ts:358`). Stuck is the trigger for the proactive push + an offered/auto restart.
- **DEAD** — `lifecycle.health().running === false` (the child process exited / never came up). Served entirely by the child-independent control set; `!status` reports DEAD + offers `!restart`/`!kill`.

**Recommended thresholds (config, all overridable):** ping interval **20 s** (`pingIntervalMs`), ping response timeout **45 s** (`pingResponseTimeoutMs`), idle→stuck after **one** missed ping (≈45–65 s wall), in-flight turn watchdog **180 s** (enable the latent watchdog with `surface` action by default — alert, do not auto-kill — so a long legitimate `/dev` build is not murdered). Proactive push fires on the STUCK or DEAD transition.

---

# §6 — PHASING (discrete `/dev` units; each scoped + testable + additive + default-OFF; NO live rebuild/restart by the implementing agent)

Order = cheap reuse-existing first, then the moderate new methods, then Part B, then Part C, then the hard/deferred. Each unit is independently shippable dormant.

| Unit | Scope (one line) | Key files | Default-OFF gate | Tests (fakes) |
|---|---|---|---|---|
| **P-A1 — `/control` menu + `ctl:*` router + `help`/`ping`/`status` (read-only core) + `change-model` scaffold** ✅ SHIPPED (Phase 1) | The `/control` interceptor in `handleInbound` + the inline-keyboard MENU renderer + the extensible `ctl:*` callback ROUTER (the `CONTROL_ACTIONS` registry) + the three read-only actions; record `startedAt` (uptime) + latch `lastStall` (via the lifecycle `onStall`, dormant today) + surface the orchestrator model (`opts.model`) in status; the `change-model` menu entry + model sub-menu scaffold (restart wiring → P-A3) | `control-command.ts` (NEW — pure: matcher/`ctl:*` parse/registry/menu/`classifyLiveness`+`formatStatus`), `session-host.ts` (intercept + `ctl:*` route + handlers + `startedAt`/`lastStall`) | the `/control` matcher + the `ctl:` callback prefix only; a non-control message / a `perm:*` callback falls through unchanged | unit: matcher; `ctl:*` parse rejects `perm:*`; menu/sub-menu buttons; `classifyLiveness`/`formatStatus` active/stuck/dead from faked snapshots; `/control` intercepted + ACKed + NOT forwarded; each `ctl:*` routes; status DEAD on `running=false`; model-set does NOT restart; non-control turn forwarded; `perm:*` still resolves |
| **P-A2 — channel↔panel parity menu actions (`reconnect` / `flush` / `log` / `approvals` incl. allow/deny)** ✅ SHIPPED (dev-ctl2) | Each = a `CONTROL_ACTIONS` row + a `ctl:*` handler reusing the Phase-1 framework, calling the SAME out-of-band supervisor logic the loopback panel exposes: `reconnect` → `reconnectChannel` (re-establish transport, ACK new state); `flush` → a DESTRUCTIVE **confirm sub-menu** (`ctl:flush` → `ctl:flush-confirm`/`ctl:menu`; only the confirm drops un-acked inbound via `flushChannel`); `log` → `formatControlLog` over the capture tail (recent inbound/outbound/delivery); `approvals` → an **Allow/Deny sub-menu** per pending ask (`ctl:appr-allow:<code>`/`ctl:appr-deny:<code>`) resolving via `operatorDecide` — the SAME permission path the `perm:*` buttons + panel `/api/approve` use. The supervisor-side surfaces are injected as 3 optional opts (`reconnectChannel`/`flushChannel`/`captureRecent`, dormant/no-op when unwired, mirroring the deleteMessage/dispatchRoleAgent P6 pattern; index.ts wires them at activation). `clear` MOVED to P-A3 (a child-restart/lifecycle variant, not panel parity). | `control-command.ts` (pure: +rows + flush-confirm/approvals builders + `formatControlLog`), `session-host.ts` (handlers + 3 injected deps) | gated to the new `ctl:*` actions only; a non-control message / a `perm:*` callback / an unwired action falls through unchanged | unit (SHIPPED, +13): registry rows; flush-confirm + approvals builders; `formatControlLog`; `reconnect` wired/unwired; `flush` renders confirm + a bare flush does NOT drop; `flush-confirm` drops; `log` formats; `approvals` none-pending; `approvals` lists + `appr-allow`/`appr-deny` resolve via the perm path; stale code → no match; non-control unchanged |
| **P-A3 — restart/kill/resume/handoff (graceful + hard) + `clear`/`new`** | `!restart` (drain→handoff→`requestRestart`), `!kill` (no-drain `forceRestart`), `!resume`/`!handoff <note>` (set the next-restart handoff note), `clear`/`new` (`clearContext()` — a fresh orchestrator context, the child-restart family) | `session-host.ts` (drain loop + `forceRestart` + handoff-note field), `panel.ts` | reuses `requestRestart`/`restartFresh`/`clearContext`/handoff-inject | unit: drain waits for idle then restarts; kill restarts immediately; handoff note injected on the fresh first turn (fake lifecycle); clear resets context |
| **P-A4 — `!interrupt` (ESC)** | NEW `lifecycle.interruptTurn()` → `driver.interrupt()`; `!interrupt` command + panel route | `lifecycle.ts` (public `interruptTurn`), `session-host.ts`, `panel.ts` | additive method; no behavior change unless called | unit: interruptTurn calls driver.interrupt (fake driver records it); a turn-in-flight is cancelled, process stays running |
| **P-A5 — proactive stuck/dead push + watchdog enablement** | Extend `onUnresponsive` to push a channel alert before acting; enable the latent turn-watchdog with `surface` action + the recommended thresholds (config-driven, default conservative) | `session-host.ts`, `lifecycle.ts` (wire turnTimeoutMs), `config.ts` (thresholds) | thresholds default to today's (ping disabled unless `pingIntervalMs`>0); watchdog `surface`-only | unit: a simulated missed ping pushes the alert then restarts; watchdog fires `surface` not kill |
| **P-B1 — dispatch surface** | a `dispatch` MENU ACTION (`ctl:dispatch`) + `POST /api/dispatch` → existing `dispatchRole`; relay result as an orchestrator turn | `session-host.ts` (router + relay), `panel.ts` | gated on `dispatchRoleAgent` wired (= `SUPERVISOR_ROLE_ROUTING` ON); else not offered / falls through unchanged | unit: with a fake dispatch closure, the `dispatch` action relays a result turn; dormant (no closure) → falls through; panel route returns the result JSON |
| **P-C1 — spend ledger + enforced caps** | Add `estCostUsd`/`spentUsd` to the gate's `tryAcquire`/`release` + a rolling ledger + `resetWindow`; read the two caps from config; refuse-on-breach with a clean result | `agent-concurrency.ts` (ledger + checks), `result-relay.ts` (pass `costUsd` to release + estimate to acquire), `config.ts` (cap envs) | caps default 0 = unlimited = today | unit: cap 0 never refuses; per-dispatch cap refuses an over-estimate; rolling cap refuses once window spent ≥ cap; release charges actual cost; resetWindow clears |
| **P-A6 — `!pause`/`!resume-intake`** (deferred to v1.1) | one-bit intake gate; paused → ack + don't inject un-matched inbound (control still works) | `session-host.ts` | flag defaults false (intake on) | unit: paused drops a normal turn but still serves `!status` |
| **P-D1 — `agents`/`ps` + `kill <agent>` (deferred, HARD)** | best-effort sub-agent roster from tool-activity OR an orchestrator self-report panel POST; `kill <agent>` only if a self-report handle exists | `session-host.ts` (tool-activity roster), `panel.ts` (self-report route) | additive; off until wired | unit: tool-activity Agent/Task spawns build a roster; kill is a no-op without a handle (surfaced honestly) |

**Activation (separate, user-gated):** the P6 pattern stands — the implementing agent NEVER rebuilds `dist/` or restarts the live supervisor. Going live = the user rebuilds + restarts; Part A's `!`-control plane is live as soon as the matcher ships (it is not gated on `SUPERVISOR_ROLE_ROUTING` — it is general supervisor control), Part B activates with `SUPERVISOR_ROLE_ROUTING=on`, Part C activates when the user sets non-zero caps.

---

# §7 — SACRED-INVARIANT DISCIPLINE (carried over)

- **Additive + dormant/gated where it touches the live path.** Every new field is an optional ctor option / conditional-spread (the proven `index.ts:347-350` pattern). The `/control` matcher only acts on the reserved `/control` command + `ctl:*` callbacks (everything else is byte-for-byte today). Part B is gated on the existing `dispatchRoleAgent` wiring; Part C on non-zero caps.
- **Switch-OFF / cap-zero = byte-for-byte.** With no caps set, P-C1 is meter-only (today). With `SUPERVISOR_ROLE_ROUTING` off, the `dispatch` menu action falls through (its closure is unwired). The `/control` plane is the one always-on addition — but it only fires on the reserved `/control` command + `ctl:*` callbacks, which no current flow uses, so non-control inbound is unchanged.
- **Unit-tested with fakes; no network, no real spend, no live API.** Fake lifecycle/driver/dispatch-closure/registry (the suite already has `fake-session-driver.ts`, `fake` registries in the Campaign tests). Temp `.state/` + fake keys for any store touch.
- **The live host is NOT rebuilt/restarted during implementation.** Build only to a throwaway dir for `tsc`; prod `dist/` untouched; activation = the user-triggered rebuild/restart (the same discipline that landed P6).
- **Sole-writer + single-poller invariants preserved.** Control commands run in the supervisor (the single channel owner); no command spawns a second poller or a second supervisor (the `8790` guard stands). Destructive commands bus-publish via `publishLifecycle` for audit.

---

# §D — DECISIONS NEEDING USER SIGN-OFF (each with a RECOMMENDED DEFAULT)

| # | Decision | RECOMMENDED DEFAULT |
|---|---|---|
| **(a) Control interface** | How does the operator reach the control plane (must not collide with `/`-skills)? | **RESOLVED (user-directed): a single `/control` command + a Telegram native inline-keyboard MENU** (§2.5). `/control` is supervisor-intercepted (NOT forwarded); each action is a menu button whose `ctl:<action>` `callback_data` the supervisor routes out-of-band (reusing the permission-button infra). SUPERSEDES the earlier `!`-prefix typed-command design. The existing `/mode`/`/setkey`/`/setrole`/`/roles` stay as-is; the `help` action points to them. |
| **(b) v1 action set + change-model** | Which actions ship in v1 vs deferred? | **v1 menu actions:** `help status ping` (SHIPPED Phase 1, read-only) + `change-model` (SHIPPED Phase 1 as a SCAFFOLD — menu entry + model sub-menu; restart-on-model wiring → P-A3) + `reconnect flush(confirm) log approvals(allow/deny)` (SHIPPED P-A2, channel↔panel parity) + (next phases) `restart kill resume/handoff interrupt clear` + the proactive stuck/dead push + `dispatch` (Part B) + the enforced cap (Part C). **Defer:** `pause` (→v1.1), and `agents`/`kill <agent>` (HARD — supervisor can't introspect/address the orchestrator's in-process sub-agents). The **change-model** models offered: `claude-opus-4-8[1m]` (current default), `claude-sonnet-4-6`, `claude-haiku-4-5`. |
| **(c) active/stuck/dead thresholds** | Liveness + stuck thresholds. | **ping interval 20 s; ping response timeout 45 s; idle→STUCK after one missed ping (~45–65 s); in-flight turn watchdog 180 s with `surface` action (alert, not auto-kill); DEAD = child not running.** Proactive push on STUCK/DEAD transition. |
| **(d) spend-cap policy + values** | Per-dispatch + rolling caps, default, fail mode. | **Default both caps 0 (= unlimited = meter-only = today).** When set: fail-CLOSED (refuse the dispatch with a clean surfaced reason + a channel notice); rolling window = the 5-hour budget boundary. Suggested first real values once approved: per-dispatch **$0.50**, rolling **$5/5 h** (conservative; tune later). Single global ledger in v1 (per-backend caps later). |
| **(e) carry-over Campaign OD-1 + OD-3** | OD-1: relax the no-key rule for non-Claude agents (per-backend key scoping). OD-3: real per-token spend on DeepSeek/OpenAI approved + monthly ceiling. | **OD-1: YES — per-backend key scoping** (a Claude agent stays Anthropic-key-free; a DeepSeek/OpenAI agent carries ONLY its own key; foreign keys rejected — already built in `backend-seal`/`cost-safety`, this just confirms the posture). **OD-3: approve real spend, DeepSeek-first**, gated by the Part-C caps in (d) — i.e. enforcement is the safety net that makes approving real spend safe. |

---

# Appendix — Evidence index (file:line)

- **Interception seam (Part A foundation):** `tools/supervisor/src/session-host.ts:547` (`handleInbound`), `:608-656` (the `/channel-check`/`/mode`/`/setkey`/`/setrole`/`/roles` intercept-ACK-return block), `:671` (`lifecycle.sendUserTurn` — the orchestrator hand-off the control commands precede), `:741-769` (`handleModeCommand`/`ackToOperator` — the ACK pattern to mirror).
- **Out-of-band liveness substrate:** `LifecycleManager` `health()/isIdle()/restartFresh()/clearContext()/sendUserTurn()` (`tools/supervisor/src/lifecycle.ts`), D4 ping (`session-host.ts:1159-1215`), `onUnresponsive` (`:330,:1170-1174`), `requestRestart`/`runRestartConfirm` + handoff-inject (`:1243-1329`), `clearContext` (`:1096`), `restartUnresponsive` (`:1108`).
- **Interrupt-without-kill:** `SessionDriver.interrupt()` (`tools/supervisor/src/session-driver.ts:189`); the only caller today is the latent watchdog (`tools/supervisor/src/lifecycle.ts:413`, gated by `turnTimeoutMs`=0, `:358`). NO public `SessionHost`/`Lifecycle` interrupt method yet (= P-A4 is NEW).
- **Approvals + operator decide:** `pendingPermissions()` (`session-host.ts:1116`), `operatorDecide()` (`:1125`); panel `/api/approve` (`tools/supervisor/src/panel.ts:94,160-178`).
- **Panel + channel control endpoints (reuse):** `tools/supervisor/src/panel.ts` — `/api/session` `sessionView()` (`:92,131-158`: pendingApprovals, totalCostUsd, lastStall, controllerSignals), `/api/clear` (`:96,226`), `/api/lifecycle/restart-request` (`:110,185-198`), `/api/channel/{state,reconnect,flush,kill-stale-sender}` (`:98-109`). `Supervisor` methods: `health()` (`supervisor.ts:237`), `channelState()` (`:260`), `reconnectChannel()` (`:292`), `flushChannel()` (`:311`), `deleteMessage()` (`:226`).
- **Loopback transport (panel/channel parity + tests):** `tools/supervisor/src/adapters/loopback-transport.ts` (`inject()`/`injectCallback()`/`sent`/`answered`/`edited`) — an inbound `inject()` reaches `handleInbound` via the SAME path as live telegram.
- **Dispatch surface (Part B):** `SessionHost.dispatchRole` (`session-host.ts:1003-1034`, shipped dormant, `{ok:false,enabled:false}` when unwired); the injected closure `index.ts:294-327` (scoped-key env `:296`, `mergeRoleRoutingOverrides` `:297-298`, `resolveRoleBackend` + own-secret `:305-309`, `dispatchRoleAgentWithFallback` `:310-317`); conditional-spread into `SessionHost` `index.ts:347-350`; `result-relay.ts:330-398` (`dispatchRoleAgentWithFallback`, FD1+FD6); the cli-stream-can't-receive-MCP-tool constraint = model-agnostic §Q.6.1.
- **Spend cap (Part C):** metering-only confirmed — `tools/supervisor/src/cost-safety.ts:85-89,256-264` (CREDENTIAL guard only, no spend ceiling); `tools/supervisor/src/agent-concurrency.ts:26,34` (`DEFAULT_MAX_CONCURRENT_AGENTS=24`, `DEFAULT_TOKEN_BUDGET=0`), `:124-127` (`budgetExhausted` — advisory, 0=untracked), `:135-145` (`tryAcquire` — the PRE hook), `:173-190` (`makeLease`/`release` — the POST hook, accounting-only), `:213` (`resetWindow`); `result-relay.ts:64-70` (`reportTokensUsed`), `:251` (the sole `release(tokensUsed)` call to extend with `costUsd`). Campaign M-1 + OD-3 = enforcement deferred.
- **Config switches + activation pattern:** `tools/supervisor/src/config.ts` (`roleRoutingEnabled`←`SUPERVISOR_ROLE_ROUTING`, `orchestratorModel`←`SUPERVISOR_ORCHESTRATOR_MODEL`, `panelPort`, `outputModeDefault`, `pingResponseTimeoutMs`/`pingIntervalMs`); `isRoleRoutingEnabled`/`resolveOrchestratorModel`; `index.ts:271` (`if (config.roleRoutingEnabled)` P6 gate). Launch invariants: `tools/supervisor/launch-prod-orch.mjs:46-57` (8790 guard), `:77` (delete `TELEGRAM_BOT_TOKEN`), `:93-94` (key-free), `:102` (`--panel 8790`, cli-stream default).
- **Sub-agent invisibility (why `agents`/`kill <agent>` are HARD):** sub-agents run in-process in the ONE cli-stream child sharing its stdout (model-agnostic A.1; `tools/supervisor/src/adapters/cli-stream-driver.ts:108-120`); the only supervisor-side signal is tool-activity forwarding (`session-host.ts:485-508`). No OS process / API handle to a teammate exists supervisor-side.
- **House-style / lifecycle:** `docs/proposals/standalone-process-agents-2026-06-19.md` (PART A–E + OD-# format), `docs/proposals/model-agnostic-agents-2026-06-19.md` (Campaign foundations + §Q.6 + traceability), `docs/proposals/.process/model-agnostic-agents-composition-2026-06-19.md` (side-seed format). Proposal lifecycle: Draft → Review/Approval → Active → Archive + Implementation Report.
