# Supervisor ↔ Orchestrator I/O Boundary — Diagnosis + Hybrid Redesign

**Date:** 2026-06-18
**Status:** IMPLEMENTED (M12 supervisor; merged to master 5b0c501 at the 2026-06-19 production cut-over —
LOCAL, origin push pending the user). D1-D4 + F1/F3 built, tsc clean, node:test green. Produced in-context
by the hosted orchestrator (no subagents) to avoid the live channel flood under investigation;
**persisted + corrected + implemented by dev-m12p3a** (the original on-disk copy lived only in a since-deleted worktree).
**Scope:** the I/O boundary between the supervisor and the hosted orchestrator — how channel messages flow
in/out, why the orchestrator can't self-diagnose the channel, and the redesign that closes that gap.

---

## 0. Corrections vs the original (F7 — driver identity)

The hosted orchestrator wrote this proposal while reading the **older `d1ab619` worktree code** (the PTY
driver era), but the **live build it was running was the newer `cli-stream` driver** (`claude -p
--output-format stream-json`). So the original described PTY/TUI-grid mechanics that **are not what runs**.
This corrected version re-targets those mechanics to the cli-stream reality; the **diagnosis (F1–F6) and
the hybrid redesign (§4) are unchanged** — only the driver identity and the mechanism details are fixed:

| | Original (PTY-era, INCORRECT) | Corrected (cli-stream reality) |
|---|---|---|
| Live driver | `PtySessionDriver` (interactive `claude` TUI in node-pty) | `CliStreamDriver` (`claude -p --output-format stream-json --input-format stream-json`) |
| Launcher | `--driver pty` | NO `--driver` — the orchestrator profile DEFAULTS to `cli-stream` (the only backend with agent-teams) |
| Inbound | typed as **keystrokes** into the TUI input box | fed as a **stream-json user envelope over stdin** (`{type:'user',message:{role,content}}`) |
| Outbound | parse the **settled TUI grid** into events | consume a **structured stream-json event stream** — NO TUI-grid parsing |
| Destructive timeouts | emit-empty / drop-turn anti-hang (c30ad11) — inherent to TUI render-parse | **GONE** — there is no render to mis-read; turn-complete = the `result` object, deterministic |
| Permission conduit | render-detect a prompt + inject `1\r`/Esc (fragile) | **`--permission-prompt-tool stdio`** — `control_request{can_use_tool, …, agent_id}` ↔ `control_response` over stdio |
| Containment seal | `--strict-mcp-config` + curated `--mcp-config` + disable telegram plugin | `--disallowed-tools` deny-list + **`--setting-sources project,local`** (drops `user` → the prod telegram PLUGIN never loads; the token-hijack fix) |

The most consequential correction is the permission conduit: the cli-stream control protocol carries
**`agent_id`**, so it natively routes BOTH the orchestrator's AND its **sub-agents'** permission prompts to
the channel — **this closes finding F3** (the silent sub-agent-permission hang the original flagged as the
open structural gap). The driver swap also makes the §2 flood mechanism concrete and current (it is the
`forwardToolActivity` per-tool forward, not a stale-`dist` TUI artifact — see §2).

---

## 1. Empirical topology (what is actually running)

The live orchestrator is hosted by the **cli-stream driver** (`claude -p`), not the interactive TUI / PTY:
`launch-pty-orch.mjs` spawns `dist/index.js --live --session --profile orchestrator --panel 8790` (no
`--driver` — the orchestrator profile's `defaultDriver` is `cli-stream`), in a **hard-isolation git
worktree** (`SUPERVISOR_SESSION_CWD`, detached HEAD).

**Component chain:**
`TelegramAdapter` → `Supervisor` (`IoBus` + `CaptureStore` + adapter registry) → `SessionHost` →
`LifecycleManager` → `CliStreamDriver` → a headless `claude -p` child speaking **stream-json over stdio**.
Plus the **Panel** (loopback HTTP `:8790`) and the **PermissionRouter** as the existing control plane.

### Inbound — and why the `<channel>` envelope is gone
`SessionHost.handleInbound` takes the inbound, binds the operator, then `lifecycle.sendUserTurn →
driver.send()`. The cli-stream driver writes the turn text as a **stream-json user envelope to the child's
stdin** (`{type:'user',message:{role:'user',content:<turn text>}}` — `makeCliUserTurn`). The orchestrator
therefore receives only the **turn text** — the `chat_id` / sender / `<channel source=… chat_id=…>`
envelope is consumed by the adapter+host and **never reaches the session**. That is the mechanical reason
the orchestrator sees plain turns with no channel metadata.

### Outbound — the forwarding brain
The driver consumes the child's **structured stream-json event stream** and maps each message to a
normalized event (`system_init` / `assistant` text+toolUses / `tool_result` / one `result` per turn —
`mapCliMessage`). There is **no TUI grid to parse**: turn-complete is the `result` object, the answer is
`result.result`, tool calls/results are discrete `tool_use`/`tool_result`. `LifecycleManager.handleEvent`
decides what reaches the channel:
- `assistant` final text → forwarded per the de-dup rule (`onResult`, gated by `replyToolName`);
- `tool_use` / `tool_result` → **forwarded by the new `forwardToolActivity` path** (tool CALLS incl.
  Agent/Task/SendMessage + tool ERRORS) when the orchestrator profile enables it — **this is the flood
  source, see §2**;
- `result` → forwarded once per turn.
`SessionHost.sendToOperator → supervisor.sendOutbound → adapter` is the single send path.

### No delivery read-back to the orchestrator (key gap — F1)
`sendOutbound` returns `OutboundResult{ok, sentIds, error}` and publishes it to the bus + logs it — but
that result is **never fed back into the session**. The orchestrator has **no way to see whether its own
message was delivered, dropped, or errored.** It is structurally blind to its own outbound.

### Turn boundaries are deterministic (the PTY destructive-timeout risk is GONE)
Under cli-stream there is **no render to mis-read**, so the c30ad11 anti-hang fallback (emit-empty) and the
queue drop-turn no-deadlock **do not exist on this path** — they were PTY-render artifacts. Turn-complete
is the `result` object; a long think simply means the `result` arrives later. The whole class of
"empty/dropped turn under a static-but-working screen" is structurally absent. (The #8 heartbeat still
emits a throttled "still working…" ping during a long turn so the user can tell working-from-hung.)

### Containment seal
The cli-stream child is a real `claude` that would otherwise load the user's enabled plugins. The seal is
two-layer: (1) `--disallowed-tools` denies the telegram/whatsapp/outward-send tools (deny wins); (2)
`--setting-sources project,local` **drops `user`** so the prod telegram PLUGIN (`enabledPlugins`,
user-scope) never loads — closing the token-hijack where the hosted child's own telegram plugin server
seized the user's getUpdates token. Consequence: the **in-process `supervisor_channel` reply tool is
UNREACHABLE under cli-stream** (a `createSdkMcpServer` instance can't be passed to a child process) — so
the orchestrator must reply via **plain assistant text**, which the preamble explicitly instructs. The
machine-global `~/.claude/CLAUDE.md` methodology is folded into the system-prompt append to compensate for
dropping `user`.

### The control plane that ALREADY exists (the keystone)
- **`IoBus` + `CaptureStore`** record **every** inbound/outbound/internal event. Raw envelopes and delivery
  results are already captured.
- **Panel** (loopback `:8790`, panel.ts) exposes `GET /api/health`, `GET /api/capture` (the raw event
  stream), `GET /api/session`, `POST /api/approve`, `POST /api/clear`.
- **PermissionRouter** routes gated tools over the channel and blocks on reply — and under cli-stream it is
  fed by the `--permission-prompt-tool stdio` control protocol, which carries `agent_id` → it governs the
  orchestrator AND its sub-agents (F3 closed).

> **The whole self-cure surface is already built — it just faces the human operator (the web panel), not
> the hosted orchestrator.** That is the entire gap, in one sentence.

---

## 2. The flood — measured, not guessed

- **Static (current source):** the orchestrator profile enables `forwardToolActivity` (index.ts) →
  `SessionHost.forwardToolActivity` mirrors **every tool CALL** (incl. each Agent/Task/SendMessage =
  sub-agent/teammate activity) **and every tool ERROR** to the channel, in addition to the per-turn final
  answer. Non-error tool *results* are off by default. So a single busy turn (the orchestrator spawning +
  coordinating sub-agents) emits **one channel message per tool call** — that IS the per-tool flood, and it
  is the CURRENT behavior, not a stale-build artifact.
- **Empirical (the prior session logs, `supervisor-orch.err.log`):** before `forwardToolActivity` existed,
  the cadence was one `outbound delivered` per turn + a 40 s throttled progress ping + one `session result`
  per turn — the healthy one-per-turn cadence. The flood appeared exactly when per-tool forwarding was
  added to surface sub-agent activity.
- **Live confirmation gap (the self-cure gap, live):** the orchestrator **cannot** read the *current*
  session's outbound cadence from inside — only the on-disk log. The live forwarding stream is not
  reachable from the hosted session. It can describe the mechanism but cannot watch which messages are
  firing right now. **That is exactly the self-cure gap §4 closes.**

**Root cause of the flood (corrected):** the granularity choice. `forwardToolActivity` was built to give
the user visibility into sub-agent coordination (the whole point of the supervisor), but per-tool is too
fine for a phone channel — it should be a **per-turn SUMMARY** by default (intermediate tool events →
capture/log only), with the detail available on demand via the panel. (This is fix (a) below.)

**Immediate disambiguation:** read `GET http://127.0.0.1:8790/api/capture` for the live outbound cadence.
Resolving this from *inside* the orchestrator is exactly what §4 enables.

---

## 3. The core finding

Everything needed to self-diagnose the channel **already exists** in the supervisor (capture store, panel,
delivery results) but is **not reachable by the hosted orchestrator**. From inside, the orchestrator is
blind to: raw inbound envelopes, outbound delivery status, the capture stream, and which process is sending
on the channel. The supervisor was built to *enable* self-troubleshooting; the opaque-mediation boundary
*prevents* it. The fix is to **point the existing observability+control surface at the orchestrator**, on
demand.

**Findings (severity-ranked):**
- **F1 (Major) — no outbound delivery read-back.** ★IMPLEMENTED: on a delivery FAILURE the supervisor now
  injects a `[SUPERVISOR delivery-status]` note (with the error) back into the session, so the orchestrator
  knows its reply did NOT land and can /channel-check + resend (`SessionHost.feedDeliveryFailureToSession`).
- **F2 (Major) — the inbound `<channel>` envelope is stripped** before the session. The orchestrator can't
  see sender/chat metadata. → optionally surface a minimal envelope when needed.
- **F3 (Major) — sub-agent permission prompts.** ★CLOSED on cli-stream: `--permission-prompt-tool stdio`
  carries `agent_id`, so a sub-agent's gated tool routes to the user via the same PermissionRouter (no
  silent hang). The original flagged this as the open structural gap under PTY; the driver swap closes it.
- **F4 (Major) — the orchestrator cannot observe/repair the channel from inside** (the keystone gap §4
  closes via the panel surface).
- **F5 (Medium) — the flood granularity** (per-tool, §2) → per-turn summary default.
- **F6 (Medium) — double-send / single-sender governance** (§4.3).

---

## 4. Hybrid redesign — DECIDED (D1–D4, user 2026-06-18) + IMPLEMENTED (dev-m12p3a; held/uncommitted)

> The four open questions (§5) were decided by the user and BUILT (tsc clean, node:test green). The
> decided parameters are folded into the subsections below.

### 4.1 Default path + the flood fix — D3: ORCHESTRATOR'S OWN MESSAGES ONLY
**DECIDED (D3):** the DEFAULT channel forwarding = the orchestrator's OWN turn messages ONLY (its `result`
→ `sendToOperator`). Passive tool activity — tool calls / sub-agent spawns / raw tool-errors — is **NOT**
pushed to the channel by default (that per-tool push was the flood). **NO per-turn summary.** Everything is
still **CAPTURED** to the bus + `CaptureStore` (unchanged), and surfaced **ON REQUEST** via `/channel-check`
(which reads `/api/capture`). The PermissionRouter still routes permission **prompts** to the user + blocks
on reply (a separate path — D3 is only about passive activity-forwarding).
**IMPLEMENTED:** `forwardToolActivity` now defaults OFF (index.ts) — opt back in only via
`SUPERVISOR_FORWARD_TOOL_ACTIVITY=1` (diagnostics). The orchestrator's `onResult` → `sendToOperator` path is
unchanged, so its own replies still reach the user.

### 4.2 User-initiated check/repair — D1 (`/channel-check`) + D2 (full access)
- **DECIDED (D1):** the reserved command is **`/channel-check`**, intercepted in `SessionHost.handleInbound`
  **before** enqueuing (the same seam as the permission-reply interception), so it is *handled* — NOT typed
  to the AI. **IMPLEMENTED:** `CHANNEL_CHECK_RE` + `injectChannelCheckTurn()` craft a supervisor diagnostic
  turn that hands the orchestrator the endpoint list and asks it to inspect + report + repair.
- **DECIDED (D2):** the orchestrator gets **FULL channel-control access** (NOT view-only) and acts at its
  own discretion + coordinates with the user. **IMPLEMENTED** on the loopback Panel HTTP (the orchestrator
  has `Bash`/`PowerShell` to curl it; the base URL is injected into the preamble):
  - READ: `GET /api/channel/state` (adapters, recent delivery results, sender PID), `GET /api/capture`,
    `GET /api/health`, `GET /api/session`.
  - REPAIR: `POST /api/channel/reconnect` (re-establish the transport / re-acquire the poller),
    `POST /api/channel/flush` (drop the pending-outbound backlog), `POST /api/channel/kill-stale-sender`
    (reconnect to re-acquire the single poller + report the current sender PID so the orchestrator can kill
    any DIFFERENT stale sender via Bash — the supervisor does not kill external PIDs from inside).
- **Tier (b) — orchestrator unresponsive:** see §4.5 (D4 ping/pong).

### 4.3b Liveness — D4: IDLE-AWARE supervisor→orchestrator PING/PONG → tier-a/tier-b
**DECIDED (D4):** liveness is a reserved supervisor→orchestrator **PING**, fired by a periodic scheduler.
The orchestrator must answer (any turn result) within a sensible timeout (**default 60 s**). Answer in time
→ **alive (tier-a)**. No answer → **hung → tier-b**: the supervisor restarts it (`LifecycleManager`
restart+resume via `clearContext`) + sends the user an "orchestrator stopped responding, restarting"
message.
**★ IDLE-AWARE (the false-restart safeguard):** the scheduler fires the ping ONLY when the orchestrator is
**IDLE** (`lifecycle.isIdle()` = `outstandingTurns === 0`). A long turn OR a turn blocked waiting on a
sub-agent has a turn in flight → the ping is **SKIPPED** (no deadline armed) → a busy-but-progressing
orchestrator is **NEVER false-restarted**. Belt: mid-turn **progress** (`onProgress`) also clears any armed
deadline. The "wedged mid-turn" case (a turn that never completes) is covered by the passive turn-timeout
watchdog backstop, NOT the ping. So: genuinely hung (idle + no answer) → restart; busy/long-turn/sub-agent-
wait → never.
**IMPLEMENTED:** `SessionHost.startLivenessScheduler()` (cadence `pingIntervalMs`, 120 s for the
orchestrator) → idle-gated `pingLiveness()` (`pingResponseTimeoutMs` 60 s deadline); ANY turn `result` or
mid-turn progress clears it; the deadline firing → `onUnresponsive` → index.ts `handleUnresponsive` (notify
user + restart). Tests: idle→answered→alive; idle→unresponsive→tier-b; **★ in-flight turn→ping skipped→NO
restart**; **★ mid-turn progress→deadline cleared**.

### 4.3 Double-send containment
The channel is owned by **exactly one sender at a time, liveness-governed**: tier-a = the orchestrator's
turn outbound; tier-b = the supervisor's own messages, **only when the orchestrator is down**. The adapter
is already the single outbound path and the seal already blocks the production plugin; the only new rule is
*the supervisor self-sends on the channel only in tier-b*. The existing double-supervisor guard (panel 8790
ownership, launch-pty-orch.mjs) already prevents two senders at the process level. (Note: the resolved
token-hijack — the hosted child's own telegram plugin seizing the token — is now structurally prevented by
the `--setting-sources project,local` seal; it is no longer a double-send vector.)

### 4.4 Control surface / protocol
Reuse the Panel HTTP (loopback, already operator-grade). **Add:**
- `GET /api/channel/state` → adapters, recent delivery results, sender PID.
- `POST /api/channel/reconnect` (re-establish transport / re-acquire poller; replays un-acked inbound).
- `POST /api/channel/flush` — ⚠️ drops un-acked **INBOUND** inbox-queue items (NOT an outbound backlog —
  there is none; outbound sends directly). Use only to clear a wedged inbound replay (review M1 corrected
  the original "outbound backlog" wording — it would have led the orchestrator to drop real inbound).
- `POST /api/channel/kill-stale-sender` (reconnect + report this supervisor's PID; the orch kills any
  DIFFERENT stale sender via Bash).
Expose the panel base URL to the orchestrator via the preamble/env so it can `curl` it during a check.
(Heartbeat already exists in `/api/session`; formalize a supervisor→user "orchestrator down" message.)

> **Review fixes folded in (2026-06-18):** H1 (HIGH) — the cli-stream `buildCliArgs` was silently dropping
> the entire system prompt (preamble + folded ~/.claude/CLAUDE.md methodology + panel context) because it
> emitted no system-prompt flag; FIXED by emitting `--append-system-prompt` INLINE (the `-file` variant is
> broken/ignored in claude v2.1.181) and spawning the real `claude.exe` directly (no shell) so the ~12KB
> append survives cmd.exe's 8191-char cap — end-to-end verified the append reaches a live child. M1
> (flush=inbound, above). M2 — `pingLiveness` now try/catches the send so a clearContext-window throw clears
> the deadline instead of false-firing tier-b. M3 — a 60 s outage cooldown so a sustained delivery outage
> yields ONE notice, not one per turn.

### 4.5 Migration / impact — DONE (built, held/uncommitted)
1. **Flood (D3):** `forwardToolActivity` defaults OFF (orchestrator's own messages only); opt-in via
   `SUPERVISOR_FORWARD_TOOL_ACTIVITY=1`. Intermediate events stay in capture/log. (index.ts)
2. **Delivery read-back (F1):** `feedDeliveryFailureToSession` injects a note on a failed send. (session-host)
3. **`/channel-check` interceptor (D1)** in `handleInbound` (mirrors the permission-reply interception).
4. **Panel repair endpoints (D2):** `GET /api/channel/state` + `POST /api/channel/{reconnect,flush,
   kill-stale-sender}` (additive; loopback-only). Backed by `Supervisor.channelState/reconnectChannel/
   flushChannel` + `ChannelAdapter.reconnect?/flush?` + `DeliveryQueue.clear`.
5. **Ping/pong liveness (D4):** `SessionHost.pingLiveness` + `pingResponseTimeoutMs` + `onUnresponsive` →
   index.ts tier-b restart+notify.
6. **Preamble (D2):** the orchestrator is told the panel URL + that it owns channel check/repair.
All additive + backward-compatible; the default channel-forwarding shape is unchanged (D3 only removes the
passive tool-activity push). KEPT INTACT: the telegram-hijack fix (`--setting-sources project,local`), cost
guard, containment (disallow telegram/whatsapp/send tools), worktree isolation, Opus 4.8[1m] pin, role-load.

---

## 5. Open questions — RESOLVED (user, 2026-06-18)

1. **Reserved command = `/channel-check`** (intercepted before enqueuing; handled, not typed). ✓ (D1)
2. **Full channel access** (read + repair: reconnect/flush/kill-stale-sender), orchestrator acts at its own
   discretion + coordinates with the user. ✓ (D2)
3. **Default = the orchestrator's OWN messages only** — NO per-turn summary, NO passive tool/error push.
   Everything still captured + surfaced on request via `/channel-check`. ✓ (D3)
4. **Liveness = a supervisor→orchestrator PING/PONG** with a response-timeout (60 s default) as the
   tier-a/tier-b decision; the passive turn-timeout watchdog is a backstop. ✓ (D4)

---

## 6. Provenance

Original authored in-context by the hosted orchestrator (session
`2025f28c-16c4-4e1f-8634-b8995b6356d0`, worktree `D:\tmp\supervisor-worktree-77412`, since deleted —
recovered from the transcript). Corrected (F7: driver identity PTY→cli-stream throughout; F3 closed by the
cli-stream control protocol; §2 flood re-rooted to `forwardToolActivity`) + persisted by dev-m12p3a,
2026-06-18. The §4 redesign (D1–D4 + F1) was then DECIDED by the user and IMPLEMENTED by dev-m12p3a
(2026-06-18; tsc clean, node:test green). Held/uncommitted like the rest of the M12 work; awaits the user's
live re-test (team-lead coordinates the relaunch).
