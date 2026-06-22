# Supervisor Control Panel — Redesign Spec (2026-06-20)

**Status:** Agreed with the operator in a live `/control` review session (2026-06-20). Pending implementation by the control-plane dev session. This is a focused UX/behavior spec that **amends** [`supervisor-control-plane-and-activation-2026-06-20.md`](supervisor-control-plane-and-activation-2026-06-20.md) (the control-plane architecture/activation proposal) — fold it in there and archive this on implementation.

## Summary

Operator review of the original 14-button `/control` menu, one entry at a time. Outcome:

- **10 top-level buttons** (2 per row), plus an **Advanced** submenu (3 actions) and a **Mode** submenu (3 actions).
- **4 original buttons removed** — folded into other buttons or replaced by automatic behavior.
- **1 new button** added (Mode) + **1 new grouping** (Advanced) + **1 new action** (Parent restart).
- **4 behaviors made automatic** (recovery, snapshots, restart escalation, the status probe).

## Final layout

### Main panel — 10 buttons, 2 per row
1. Status
2. Approvals
3. Log
4. New session
5. Resume
6. Interrupt
7. Change model
8. Mode
9. Advanced
10. Help

### Advanced submenu — 3 actions, each confirm-gated
- Restart
- Parent restart
- Flush

### Mode submenu — 3 options, no confirm
- Voice
- Text
- Dual

## Per-button spec + help text

(Help text is written plain/spoken — no symbols — because output may be read aloud via voice mode.)

**Status** — Out-of-band health snapshot; works even if the agent is hung. Now also fires a live responsiveness probe and reports latency + last-turn time (absorbs the old **Ping**). Shows: connected bot, inbound queue depth, session id + restart count, pending approvals, total cost, and whether the agent answered + how fast.
> Help: Status — health at a glance plus a live responsiveness check: connected bot, queue depth, session and restart count, pending approvals, cost, and whether the agent answered and how fast.

**Approvals** — Review and resolve permission requests the agent is blocked on; Allow/Deny each, plus **Deny all** to clear a stuck queue. Out-of-band fallback if an inline prompt didn't land.
> Help: Approvals — resolve permission requests the agent is waiting on, like restart, force-push, or outward sends. Allow or deny each, or deny all to clear a stuck queue.

**Log** — Tail of recent channel activity (inbound, outbound, delivery results), newest last.
> Help: Log — recent channel activity: messages in, replies out, and delivery results.

**New session** — Restart the agent with a fresh context and no handoff (clean slate). Confirm-gated. (Renamed from "Clear / New".)
> Help: New session — restart the agent with a clean slate, dropping the current context. Use it when the conversation is bloated or tangled.

**Resume** — Re-inject the last automatic snapshot. Mainly an **undo** to recover context after a New session you regret.
> Help: Resume — restore the last saved context snapshot. Handy as an undo after a New session.

**Interrupt** — Stop the agent's current turn without killing it (a fast ESC). No confirm.
> Help: Interrupt — stop whatever the agent is doing right now, without restarting it or losing context.

**Change model** — Switch the model the agent runs on; restarts on the new model carrying context. Confirm-gated.
> Help: Change model — switch the model the agent runs on. It restarts on the new model and keeps your context.

**Mode** — Switch output mode (submenu): Voice, Text, or Dual. No confirm. Surfaces the existing `/mode` command as a panel control.
> Help: Mode — choose how replies arrive: voice, text, or both.

**Advanced** — Opens the advanced submenu (heavier, rarer actions).
> Help: Advanced — less common, heavier actions: Restart, Parent restart, and Flush.

**Help** — Explains every button (this text).
> Help: Help — what each button does.

### Advanced submenu

**Restart** — Graceful restart: drain the current turn, take a snapshot, relaunch preserving the channel and context. **Auto-escalates to a hard kill if the drain stalls** (absorbs the old **Kill**). Confirm-gated.
> Help: Restart — cleanly restart the agent, keeping your context. If it is too wedged to drain, it escalates to a hard kill on its own.

**Parent restart** — Restart the **supervisor process itself** to load a new build. Confirm-gated. Performed by the supervisor (operator-tapped), **not** by the agent firing a shell command — so it is unaffected by the agent-side restart block (see Resolved decisions).
> Help: Parent restart — restart the supervisor itself to load a new build. Use this after a code update.

**Flush** — Drop all unacknowledged inbound messages. Destructive (discards pending messages). The escape hatch for a poison message that re-wedges the agent on every reconnect/restart. Confirm-gated.
> Help: Flush — discard stuck pending messages. A last resort for a message that keeps crashing the agent on every restart.

## Automatic behaviors (no button)

- **Recovery ladder** — when the agent stops responding, the supervisor **auto-reconnects** the channel first, and only **resets** (restarts) if that does not bring it back. (Replaces the manual **Reconnect** button.) Note: reconnect fixes a dropped channel; a truly wedged agent needs the reset — the ladder covers both.
- **Auto-snapshot** — context is snapshotted **periodically and before every restart**, so any restart — including an unexpected watchdog restart — recovers context. (Replaces the manual **Handoff** button; fixes the cold-watchdog-restart finding below.)
- **Restart escalation** — a graceful Restart escalates to a hard kill if the drain stalls. (Absorbs the manual **Kill** button.)
- **Status live-probe** — Status includes a live ping + latency. (Absorbs the manual **Ping** button.)

## Removed buttons → where they went
| Removed | Replacement |
|---|---|
| Ping | Folded into **Status** (live probe + latency) |
| Reconnect | **Automatic** recovery ladder (reconnect → reset) |
| Handoff | **Automatic** snapshots (periodic + pre-restart) |
| Kill | Folded into **Restart** (auto-escalation); **Interrupt** covers the runaway-turn case |

## Resolved design decisions

- **The restart-permission fix stays a PURE HARD BLOCK.** The driver-level guard blocks any *agent-issued* relaunch command regardless of permission mode (including bypass/background sub-agents). The agent never needs to restart the host itself — the legitimate path is the **Parent restart** panel button, which the supervisor performs when the operator taps it, and which the agent-side guard does not touch. So **no "approve-to-restart" path for the agent is needed**; the human restarts the host from the panel, the agent cannot.

## Background findings that drove this (from the 2026-06-20 forensic session)

- The original "restart gate" was effectively dead on the live path: an allow-listed shell command raises no permission control-request, and a bypass/background sub-agent suppresses it entirely → a relaunch ran ungated. Fixed by a **driver-level interceptor** (mode-independent) that hard-blocks the relaunch family and notifies the operator (dev-0efd, commit `71a2640`, source-only, 577/577 tests, not yet activated).
- A background sub-agent firing a relaunch **wedged the shared stdio pipe**, and because the parent then looked idle, the liveness watchdog fired a **cold** restart (no context). The auto-snapshot behavior above closes the cold-restart gap on the watchdog path.

## Implementation notes / status

- Implement under `feature/supervisor-control-plane`; fold this spec into the main control-plane proposal, then archive this file.
- The restart-permission hard-block is already committed (dev-0efd) and folds into the same control-plane → master merge; it needs a `dist/` rebuild at the next activation restart to go live.
- Confirm-gated actions keep their individual confirm sub-menus even inside Advanced.
