# Supervisor Hosted-Session Crash Trap — Forensic Report (VERIFIED) 2026-06-21

**Status:** Investigation COMPLETE. Root cause confirmed from three independent primary sources
(the supervisor's own error log, the crashed sessions' transcripts, and the live guard source).
**Read-only throughout — NO fix applied. Awaiting user decision on next steps.**

## Provenance — how this report was produced (and why it kept not getting delivered)

This finding was reached, lost, and re-reached across a *chain* of hosted sessions today, because
the act of investigating/fixing it kept killing the investigator:

1. `2202de3f` (forensic session) found the root cause from the supervisor error log, delivered its
   diagnosis, then **died at 11:03:02Z to the 180 s liveness timeout** before writing the synthesis.
2. `be9b1bf0` (recovery session) recovered the diagnosis, **wrote the first version of this file**,
   proposed a fix plan, got the user's "Go ahead." — and was then **killed by the relaunch guard at
   11:54:26Z** the instant it began executing the approved fix, before it could report back.
3. `d0144864` (this session) re-pulled the primary transcripts + the supervisor error log + the live
   guard source, **verified every claim against ground truth**, and finalized this report. No agent
   was dispatched and no relaunch keyword was placed in any tool call, so this session did not trip
   the guard.

That three-session relay *is itself the symptom*: a hosted orchestrator that tries to rebuild/restart
its host — or even to delegate or fix that capability — dies before it can finish.

---

## TL;DR (the cause, in three sentences)

Every hosted orchestrator session that tried to rebuild-and-restart the supervisor died at the same
upstream step — **delegating the work to a sub-agent** — because the supervisor's **relaunch guard
hard-kills the whole session the moment a supervisor-relaunch command string appears in a tool call,
*including the prompt text of an `Agent`/`Task` dispatch***. The guard cannot tell "*run* the
restart" from "*describe/delegate/investigate* it," so a perfectly safe `/dev` brief that merely
*mentions* the restart script is fatal — and it fires before the session ever reaches the genuinely
safe restart path (the gated `/control → Parent restart` button, which runs supervisor-side and
evades the guard). The guard then auto-restarts a fresh, amnesiac session, which re-investigates and
dies the same way → the loop. (A second, independent mechanism — the 180 s liveness timeout — killed
the one careful read-only forensic session.)

---

## Symptom

Across many hosted orchestrator sessions today (06-21), every session that attempted to **rebuild the
supervisor and restart it** "died / became unresponsive" mid-process. A fresh session auto-spawned,
re-investigated from scratch with no memory of the prior attempts, and died the same way — a loop the
operator observed directly.

---

## Evidence — the supervisor's own death ledger (`D:\tmp\supervisor-prod.err.log`, verbatim)

```
[2026-06-21T09:00:59.578Z] ERROR supervisor: RELAUNCH GUARD: blocked a supervisor-relaunch tool call
                           (child killed to protect the live host) {"tool":"Bash","fromSubAgent":true}
[2026-06-21T10:09:06.573Z] ERROR supervisor: RELAUNCH GUARD: blocked a supervisor-relaunch tool call
                           (child killed to protect the live host) {"tool":"Agent","fromSubAgent":false}
[2026-06-21T10:31:18.654Z] ERROR supervisor: RELAUNCH GUARD: blocked a supervisor-relaunch tool call
                           (child killed to protect the live host) {"tool":"Agent","fromSubAgent":false}
[2026-06-21T11:03:02.848Z] ERROR session-host: liveness ping TIMED OUT — orchestrator unresponsive (tier-b) {"timeoutMs":180000}
[2026-06-21T11:03:02.848Z] ERROR supervisor: TIER-B: orchestrator unresponsive
                           {"reason":"no turn result within 180000ms of the liveness ping (orchestrator idle but unresponsive)","recoveryLadder":false}
[2026-06-21T11:03:02.973Z] INFO  lifecycle: agent-requested restart: ending session + starting fresh {"priorSessionId":"2202de3f-…","restarts":1}
[2026-06-21T11:54:26.548Z] ERROR supervisor: RELAUNCH GUARD: blocked a supervisor-relaunch tool call
                           (child killed to protect the live host) {"tool":"Agent","fromSubAgent":false}
```

Four guard-kills + one liveness-timeout, all on 06-21. Note: the **only** successful restarts in the
log (`06:31:08Z`, `09:08:41Z`, both `parent-restart: dispatched detached supervisor relaunch`) ran
**supervisor-side** via the gated control path — never guard-blocked. And the running host's boot line
`liveness scheduler started {"intervalMs":120000,"responseTimeoutMs":180000}` confirms the 180 s
watchdog fix is live (the old 60 s timeouts in the log are all from 06-20).

---

## Root cause #1 — the RELAUNCH GUARD hard-kills on *delegation* (the dominant mechanism)

### What the guard does (verified from live source)

`detectRelaunchToolUse(raw)` — `tools/supervisor/src/adapters/cli-stream-driver.ts:138` — inspects
**every assistant `tool_use`** the hosted orchestrator emits:

```ts
if (name === 'Bash' || name === 'PowerShell') {
  const cmd = String((input['command'] ?? input['cmd'] ?? '') as string);
  if (cmd && isSupervisorRelaunchCommand(cmd.toLowerCase())) { return { toolName: name, command: cmd, fromSubAgent }; }
} else if (name === 'Agent' || name === 'Task') {
  // The sub-agent dispatch itself — its prompt may carry the relaunch instruction.
  const prompt = String((input['prompt'] ?? '') as string);
  if (prompt && isSupervisorRelaunchCommand(prompt.toLowerCase())) { return { toolName: name, command: prompt, fromSubAgent }; }
}
```

So it scans the `command` of a **Bash/PowerShell** call **and the `prompt` text of an `Agent`/`Task`
dispatch**. On a match, the stream loop (`cli-stream-driver.ts:628`) does:

```ts
const blocked = detectRelaunchToolUse(parsed);
if (blocked && !self.relaunchBlocked) {
  self.relaunchBlocked = true;
  self.blockRelaunch(blocked);   // tears down the orchestrator's whole child tree to protect the live host
  return;                        // stop yielding — the child is being torn down; the turn is void
}
```

— it **instantly kills the orchestrator's child tree and voids the turn, returning no error to the
agent.** The operator sees only the guard's own notice (`⛔ Blocked a supervisor host-restart that the
orchestrator tried to run directly (Agent)…`), which is easily mistaken for an ordinary permission
block.

The matcher `isSupervisorRelaunchCommand(c)` — `tools/supervisor/src/profiles.ts:151` — fires on the
**execution** of any of:
- the canonical relaunch script (`restart-supervisor.ps1`, in a `powershell`/`pwsh`/`-File`/`&`/`.` context),
- either supervisor launcher (`node …launch-(prod|pty)-orch.mjs`),
- a direct host launch (`node …dist/index.js …--session`).

It deliberately exempts a *leading* read verb (`cat|type|more|less|head|tail|grep|rg|findstr|ls|dir|
get-content|gc`), and it tests both the raw and a separator-stripped copy of the string. So **reading,
grepping, or `curl`-ing the restart endpoint is safe**; the danger is the relaunch command appearing
in an executable position — or anywhere inside an `Agent`/`Task` prompt.

### The design-vs-effect gap (the actual bug)

The matcher was written to **route a restart command to the user for confirmation** (like the
in-channel `ctl:restart`). Its own source comment says false positives are tolerable:

> *"False-positives here are only mildly annoying (an extra confirm) while a false-negative would
> silently sever the live host…"* — `profiles.ts:148`

But on the hosted `cli-stream` path, `detectRelaunchToolUse` does **not** route-to-confirm — it
**hard-kills the child tree**. So a false positive is not "an extra confirm"; it is **instant session
death with no error**. That mismatch between the matcher's intended cost (a confirm) and its actual
cost on this path (a kill) *is* the defect.

### Why this is a trap, not an edge case

The orchestrator's natural, correct way to rebuild + restart is to hand it to a `/dev` agent — and any
such brief inevitably *mentions* the restart command (to instruct, scope, or forbid it). The guard
sees the relaunch string in the dispatch prompt and kills the session **mid-delegation**, *before* it
ever reaches the genuinely-safe trigger. It cannot distinguish:

- "instruct a sub-agent to **run** the relaunch" (what it wants to stop), from
- "**describe / delegate / forbid / investigate** a restart" (legitimate, and unavoidable in a brief).

Two observed flavors, both in the ledger:
- **Orchestrator delegating** (`tool:"Agent"`, `fromSubAgent:false`): the `/dev` brief's prompt text
  mentions the relaunch command → killed **before the agent even starts** (`180198a2`, `cf715bd5`,
  `be9b1bf0`).
- **Sub-agent executing the build** (`tool:"Bash"`, `fromSubAgent:true`): a build agent's rebuild /
  smoke-test step actually invokes the launcher or host → killed **mid-build** (`5fde29d2`).

Then the guard auto-restarts a fresh session with no memory of why it died → re-investigation → same
death = **the loop**.

---

## Root cause #2 — the 180 s liveness timeout (killed the read-only forensic session)

Independently of the guard, the watchdog killed the one careful, read-only forensic session:

```
[2026-06-21T11:03:02.848Z] liveness ping TIMED OUT (180000ms) → TIER-B: orchestrator unresponsive
                           {"reason":"no turn result within 180000ms of the liveness ping (orchestrator idle but unresponsive)"}
                           → ending session + starting fresh {"priorSessionId":"2202de3f-…","restarts":1}
```

`2202de3f` had just delivered its diagnosis and was idle waiting on its two background corroboration
agents; it did not produce a turn-result within the 180 s deadline and was declared unresponsive and
restarted. The 60 s→180 s watchdog fix *is* live (it stopped the 06-20 false restarts), but a session
that legitimately idles or runs an over-long turn past 180 s still gets cut. **So there are two
distinct death mechanisms: the guard (any session attempting/delegating rebuild+restart) and the
180 s timeout (a session that wedges or idles too long).**

---

## Why the "safe design" didn't save anyone

The intended-safe restart trigger — the gated `/control → Advanced → Parent restart` button, or
`POST /api/lifecycle/restart-request` — runs **supervisor-side** and is guard-immune. But **no session
ever reached it**, because death happens *upstream*, at the delegation/build step. The safe path was
never the failure point.

This is corroborated by the one restart that **succeeded** today: the ~09:15–09:20 local
rebuild→merge→restart was done by a **LOCAL CLI session** (`dec51261`), not a hosted one. The guard
only wraps the **hosted** session's process stream, so a local terminal session can freely
kill-and-relaunch the host (it tree-killed PIDs `64920→79728→87180` and booted new host PID `68908`).

### Structural insight

> **A hosted orchestrator is structurally forbidden from rebuilding + restarting its own host.**
> The only activation work still outstanding (compile in the dispatch feature, then reload) requires
> exactly that. With no local session doing it, every hosted session that tries — even just by
> *delegating* it — trips the guard and dies.

The clearest proof: `be9b1bf0` *fully understood the guard*, explicitly planned to "keep every restart
keyword out of every tool call," got the user's "Go ahead." — and **was still killed by the guard**
(11:54:26Z) the moment it began delegating the fix.

---

## The full 06-21 session death map (each claim evidence-backed)

| Session | Type | Window (local, UTC+3) | How it ended | Evidence |
|---|---|---|---|---|
| `dec51261` | **LOCAL CLI** | 08:02–09:30 | **SUCCESS** — merged campaign→master (`066b6f5`), built `dist/`, restarted host (new PID 68908), then user `/exit` | digest of `dec51261`; err-log `parent-restart` 06:19–06:20Z; not guard-wrapped (local) |
| `5fde29d2` | hosted | 09:30–11:58 | Staged activation; its background **build agent's Bash** relaunch tripped the guard | err-log `09:00:59Z {"tool":"Bash","fromSubAgent":true}`; transcript ends 08:58:53Z mid-staging |
| `180198a2` | hosted | …–13:06 | Guard-killed on an **Agent** dispatch | err-log `10:09:06Z {"tool":"Agent","fromSubAgent":false}` |
| `cf715bd5` | hosted | …–13:27 | Guard-killed on an **Agent** dispatch | err-log `10:31:18Z {"tool":"Agent","fromSubAgent":false}` |
| `2202de3f` | hosted **(forensic)** | …–14:00 | **Found the cause**, then died to the **180 s liveness timeout** before final synthesis | err-log `11:03:02Z tier-b`; transcript blocks #14–#16 = the diagnosis |
| `be9b1bf0` | hosted **(recovery)** | 14:03–14:50 | Recovered + **wrote this report** + proposed fix + got "Go ahead." → **guard-killed** executing it | transcript ends on user "Go ahead."; err-log `11:54:26Z {"tool":"Agent","fromSubAgent":false}` |
| `d0144864` | hosted **(this report)** | 14:54– | Re-verified everything read-only; finalized this report; dispatched nothing | this document |

`2202de3f`'s own verbatim conclusion (transcript block #15), preserved here as the primary finding:

> "They are being **hard-killed by the relaunch guard** — and specifically, it's firing on the
> **`Agent`/`/dev` dispatch**, not on a direct restart command… The relaunch guard
> (`detectRelaunchToolUse`) scans **every** tool call the model emits, including the **prompt text of
> an `Agent`/`Task` dispatch**, for a relaunch command… On a match it **instantly kills the
> orchestrator's whole child tree** — no error returned to the agent… every session dies at the
> **same upstream step** — the moment it tries to hand the build/restart to a sub-agent — *before* it
> ever reaches the genuinely-safe trigger… Then the guard **auto-restarts a fresh session** that has
> no memory of why it died, so it re-investigates and dies the same way. That's the loop you saw."

---

## Current activation state (verified, this session)

- **Dispatch / spend-cap is NOT live.** Prod `tools/supervisor/dist/` contains **none** of the
  activation symbols (`formatDispatchResultTurn` / `spendCapBreach` / `deepseekKeyBridge` /
  `dispatchCostCapUsd` → 0 matches; the only `tryAcquire` hits are the unrelated `agent-concurrency`
  limiter). The running host is the **pre-activation 09:15 master-merge build** (`066b6f5`).
- **`dev-e9d9`'s go-live staging is half-done:** the `dist.bak.pre-dispatch-activation/` backup exists,
  the `launch-prod-orch.mjs` env edit is uncommitted, and the prod-dist rebuild never completed
  (`dev-e9d9` / `5fde29d2` died mid-staging). The feature work itself (`B1` dispatch surface + `C1`
  enforced spend cap + DeepSeek key bridge) **is** committed on `feature/supervisor-dispatch-activation`
  (`a5a5820 → a8aac25 → 74ccaa3 → 82e3431 → 724808c`, 670/670 green) but **dormant, unmerged,
  unpushed, default-OFF**.
- **Net: role-routing is OFF (its safe default); the supervisor is stable right now.**

---

## Options (for user decision — NONE applied)

1. **Stabilize only.** No hosted session attempts rebuild/restart; the loop stops; dispatch stays
   dormant (safe). Activation deferred. *(Zero risk, zero progress.)*
2. **Finish activation from a LOCAL session** — the proven, guard-free route (it's how the morning
   merge+restart succeeded): build the prod `dist/`, commit the launcher env edit, restart via the
   gated lifecycle path. **Cleanest path to actually going live.**
3. **Fix the guard (via `/dev`, run from a local session).** Make it distinguish *invoking* a restart
   from *describing/delegating/investigating* one — i.e. scope the kill to an actual Bash/PowerShell
   **execution** of the relaunch command, and **stop scanning `Agent`/`Task` prompt text** (or, if
   prompt-scanning is kept, **route-to-confirm instead of hard-kill** on that path, matching the
   matcher's own stated "extra confirm" intent). Stops the spurious mid-delegation deaths. Deploying
   the fix itself still needs one local restart.

(Options 2 and 3 are complementary: 3 removes the trap permanently; 2 is how you'd ship either one
today. Both must be driven from a **local** session — a hosted session cannot safely do it.)

---

## Safety protocol for any future HOSTED session

- **Never** place `restart-supervisor.ps1`, `node launch-(prod|pty)-orch.mjs`, or
  `node dist/index.js --session` (in an executable position) inside **any** Bash/PowerShell `command`
  **or any `Agent`/`Task` prompt** — the guard hard-kills the session on sight, with no error.
- Reading / grepping those files, and `curl`-ing `POST /api/lifecycle/restart-request`, are **safe**.
- Do **not** try to rebuild-and-restart the host from a hosted session at all — hand it to a local
  session (option 2/3). A hosted session is structurally forbidden from it.
- Keep turns bounded and answer `[SUPERVISOR ping]` liveness checks promptly to avoid the 180 s
  tier-b timeout.

---

## Source artifacts

- Supervisor error log (ground truth): `D:\tmp\supervisor-prod.err.log`
- Forensic session transcript: `…\projects\D--repos-PianoidInstall\2202de3f-6db6-4394-8ace-cb4ee50a8518.jsonl`
  (its diagnosis = assistant blocks #14–#16)
- Forensic corroboration digests (read-only analysis agents): under the `2202de3f…\subagents\` dir —
  `agent-a46df94474c40a37d.jsonl` (analysis of `5fde29d2`) and `agent-acaf29aa8a102d407.jsonl`
  (analysis of the local `dec51261`)
- Recovery session transcript (wrote v1 of this file, then guard-died): `…\be9b1bf0-82e2-4f7a-95c1-f7159237892e.jsonl`
- Live guard source: `tools/supervisor/src/adapters/cli-stream-driver.ts` (`detectRelaunchToolUse`,
  ~L138 + the kill at ~L628) and `tools/supervisor/src/profiles.ts` (`isSupervisorRelaunchCommand` /
  `matchesRelaunch`, ~L151–187)
- Half-done go-live staging log: `docs/development/logs/dev-e9d9-2026-06-21-103931.md`
