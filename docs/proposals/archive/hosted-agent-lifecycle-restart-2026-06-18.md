# Hosted-Agent Lifecycle Restart Control

**Date:** 2026-06-18
**Status:** IMPLEMENTED (merged to master 5b0c501 at the 2026-06-19 M12 production cut-over — LOCAL, origin
push pending the user). Drafted in-context by the hosted orchestrator during the M12 re-test (user-directed);
persisted + implemented by **dev-m12p3a**. The hosted draft was text-only (it runs in the isolated worktree and
couldn't write to the live repo). Implemented 2026-06-18: tsc clean, the §9 acceptance test is the three
`★★ FIX B` node:test cases (later +M-1/M-2 hardening → suite 200/200), and the
`POST /api/lifecycle/restart-request` loopback was smoke-tested over real HTTP. The §8 flagged defaults
(env-teardown scope = minimal; rate-limit = 3/30min) still await the user's confirm.
**Scope:** a NEW `lifecycle/*` loopback control surface complementing the existing `channel/*` surface — the
hosted agent can REQUEST its own full restart; the supervisor CONFIRMS with the user and EXECUTES.

---

## 1. Goal & authority split

The hosted agent can *request* its own full restart (to recover from a bloated/corrupt context); the supervisor
*confirms with the user and executes*. Authority stays split — the agent can request but cannot execute, and the
supervisor holds the confirm dialog (the agent is being torn down, so it can't hold it).

| Actor | Role |
|---|---|
| **Agent** | May REQUEST restart (reason + optional handoff note). Cannot execute. |
| **Supervisor** | Owns execution AND holds the confirm dialog with the user. |
| **User** | Approves / denies. |

## 2. Flow

1. Agent emits a restart-request → supervisor (returns `queued` immediately; the agent must NOT assume a
   synchronous restart — it may be mid-turn).
2. Supervisor opens a **direct** confirm dialog with the user: *"The hosted agent requests a full restart
   (context reset). Reason: …. Approve? (allow/deny)"*
3. **Approve** → graceful drain → tear down the cli-stream driver → bring up a FRESH session (new `sessionId`,
   `restarts++`, **no `--resume`** = true context reset) → optional handoff-note injection.
4. **Deny / timeout** → supervisor tells the agent it was denied; the agent continues unchanged.

## 3. Signal mechanism

A new loopback endpoint **`POST /api/lifecycle/restart-request { reason, handoffNote? }`** — mirrors the
`channel/*` control surface; `lifecycle/*` is the current gap. Returns `{ queued: true }` immediately; the
confirm + teardown happen **out-of-band**. The orchestrator (which has `Bash`/`PowerShell` + the panel URL)
curls it, exactly like the `/api/channel/*` repair endpoints.

## 4. Confirmation (supervisor-owned)

Reuse the existing destructive-op approval routing (the PermissionRouter channel round-trip) with a synthetic
action type **`lifecycle.restart`**. The prompt attributes the requester + reason and flags it as
**context-resetting**. Confirm timeout → **default DENY** (safe), and the agent is notified.

## 5. Teardown / bring-up scope (made deterministic)

| Concern | Behavior |
|---|---|
| **Driver** | Graceful drain of any in-flight turn, then kill the `cli-stream` driver child. |
| **Session** | New `sessionId`, **no `--resume`**, `restarts++` (a true context reset). |
| **★ Channel** | **PRESERVED** — the Telegram adapter + the bound operator are NOT torn down. Only the AGENT context resets; the fresh session re-attaches to the live channel, so the conversation does not break. |
| **Environment** (★ DECIDED default — see §8) | The hosted session runs in the launcher's hard-isolation worktree with NO Pianoid subrepos, so there is **no project stack / no ports to sweep**. "Fresh" = a new cli-stream child in the **same** clean worktree (no FS re-init), re-attached to the same channel. No temp/state-dir wipe (nothing accumulates there). The agent context reset is what matters, not the filesystem. |

This is exactly `SessionHost.clearContext()` (end → fresh start, re-bootstrap the role) — already built for #self-context-clean — gated behind the user confirm + the handoff-note injection.

## 6. Handoff (optional)

The request may carry `handoffNote`; on bring-up the supervisor prepends it to the fresh session's FIRST turn
(*"You restarted at your own request. Prior context: <note>"*), enabling self-recovery without losing the
thread. No note → clean boot.

## 7. Guardrails

- **Rate-limit** (★ DECIDED default — see §8): refuse a request that exceeds the limit + surface it to the user
  ("the hosted agent is requesting restarts too frequently — possible loop"). Kills restart-loops.
- **No unattended agent-initiated restart** — the user confirm is ALWAYS required (only the supervisor's own
  D4 liveness-timeout restart is unattended).
- **Audit**: emit `lifecycle_restart_{requested,approved,denied,completed}` onto the bus alongside the existing
  `session_init`/`session_result` signals (captured + surfaced via the controller bridge).

## 8. ★ Flagged decisions (sensible defaults chosen; user confirms)

1. **Environment teardown scope** → DEFAULT: minimal/deterministic — NO port sweep (no project stack in the
   isolated worktree), NO worktree re-init (the same clean worktree is reused; re-init risks the launcher's
   worktree management), NO temp-dir wipe. Only the agent CONTEXT + the cli-stream child reset; the channel +
   worktree persist. (If the user wants a heavier "fresh" — e.g. a brand-new worktree per restart — that's a
   launcher change, flagged as a follow-up.)
2. **Rate-limit N/window** → DEFAULT: **max 3 agent-initiated restarts per 30 minutes**. Enough for legitimate
   self-recovery; tight enough to kill a loop. (The supervisor's own liveness restart is separate + not counted.)

## 9. Acceptance test

1. Agent POSTs the endpoint with a reason → 2. the user sees a **supervisor-driven** confirm prompt (not a
   normal agent message) → 3. approve → `GET /api/session` shows `restarts:1`, a **new** sessionId, no resumed
   context, **channel still up** → 4. deny → the agent continues, `restarts` unchanged → 5. rapid repeats get
   throttled (refused + user-surfaced).

**Implemented as three `★★ FIX B` cases in `src/test/session-host.test.ts` (suite 196/196, tsc clean):**
- *approve* → `restarts:1`, new sessionId (`s2`), `startOpts.resume===undefined` (true context reset), the
  channel adapter is preserved, the handoff first-turn carries the role prefix + the note; `lifecycle_restart_{requested,approved,completed}` published + the user gets the "✅ restarted" notice.
- *deny* → `starts===1`, sessionId unchanged (`s1`), `restarts:0`, the agent is told "DENIED … Continue as
  normal", `lifecycle_restart_denied` published, NO `lifecycle_restart_completed`.
- *rapid* → after 3 in-window request→deny cycles the 4th returns `{status:'rate_limited',retryAfterMs}`, is NOT
  executed (`starts===1`), and the user is warned about the loop.
Plus a real-HTTP loopback smoke: `POST /api/lifecycle/restart-request {reason,handoffNote}` → `200 {"status":"queued"}` with `requestRestart` invoked carrying the right reason+note.

## 10. Fit with existing M12

Builds on the lifecycle controller (the `restarts` counter + `clearContext` restart already exist), the
destructive-op approval routing (the PermissionRouter channel round-trip), and the loopback panel. It is the
missing `lifecycle/*` surface complementing `channel/*`. Squarely dev-m12p3a scope.

---

## Provenance
Drafted by the hosted orchestrator (session b4576605, worktree-11056, during the 2026-06-18 re-test; text-only —
recovered from the capture store). Persisted + implemented by dev-m12p3a, 2026-06-18, with the §8 defaults
chosen for the user to confirm. Held/uncommitted; awaits the user's confirm of the flagged defaults + the live
re-test.
